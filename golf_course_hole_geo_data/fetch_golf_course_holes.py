#!/usr/bin/env python3
"""Fetch golf course and hole-related geodata from OpenStreetMap Overpass."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from course_map_index import update_course_map_index

DEFAULT_ENDPOINT = "https://overpass-api.de/api/interpreter"
DEFAULT_USER_AGENT = "golf-tournaments-overpass-client/1.0"
DEFAULT_GOLF_TAGS = [
    "hole",
    "fairway",
    "green",
    "tee",
    "bunker",
    "water_hazard",
    "lateral_water_hazard",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Download OSM geodata for a golf course and hole-related features, then "
            "save normalized GeoJSON files for website use."
        )
    )
    parser.add_argument("--course", required=True, help='Exact course name in OSM.')
    parser.add_argument(
        "--out-dir",
        default="golf_course_hole_geo_data/data",
        help="Base output folder (default: golf_course_hole_geo_data/data).",
    )
    parser.add_argument(
        "--endpoint",
        default=DEFAULT_ENDPOINT,
        help=f"Overpass endpoint (default: {DEFAULT_ENDPOINT}).",
    )
    parser.add_argument(
        "--fallback-endpoint",
        action="append",
        dest="fallback_endpoints",
        default=[],
        help=(
            "Additional Overpass endpoint to try if the previous one fails. "
            "Repeat this flag to provide multiple fallback endpoints."
        ),
    )
    parser.add_argument(
        "--query-timeout",
        type=int,
        default=120,
        help="Overpass query timeout in seconds (default: 120).",
    )
    parser.add_argument(
        "--http-timeout",
        type=int,
        default=60,
        help="HTTP timeout in seconds (default: 60).",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=4,
        help="HTTP retry attempts for transient failures (default: 4).",
    )
    parser.add_argument(
        "--backoff",
        type=float,
        default=1.0,
        help="Retry backoff factor (default: 1.0).",
    )
    parser.add_argument(
        "--bbox-margin",
        type=float,
        default=0.0015,
        help="Fallback bbox expansion in degrees (default: 0.0015).",
    )
    parser.add_argument(
        "--golf-tags",
        nargs="+",
        default=DEFAULT_GOLF_TAGS,
        help=(
            "OSM golf tags to fetch within the course area. "
            f"Default: {' '.join(DEFAULT_GOLF_TAGS)}"
        ),
    )
    parser.add_argument(
        "--include-water",
        action=argparse.BooleanOptionalAction,
        default=True,
        help=(
            "Include non-golf-tagged water features inside the course area/bbox "
            "(natural=water, waterway=*, landuse=reservoir). Default: enabled."
        ),
    )
    parser.add_argument(
        "--user-agent",
        default=DEFAULT_USER_AGENT,
        help=f"User-Agent header sent to Overpass (default: {DEFAULT_USER_AGENT}).",
    )
    return parser.parse_args()


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return slug or "course"


def escape_overpass(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def build_course_query(course_name: str, query_timeout: int) -> str:
    escaped = escape_overpass(course_name)
    return f"""
[out:json][timeout:{query_timeout}];
(
  way["leisure"="golf_course"]["name"="{escaped}"];
  relation["leisure"="golf_course"]["name"="{escaped}"];
);
out body geom;
"""


def build_tag_regex(golf_tags: list[str]) -> str:
    cleaned = [re.escape(tag.strip()) for tag in golf_tags if tag.strip()]
    if not cleaned:
        raise ValueError("At least one golf tag is required.")
    return "^(" + "|".join(cleaned) + ")$"


def build_feature_query_for_area(
    course_name: str,
    golf_tag_regex: str,
    query_timeout: int,
    include_water: bool,
) -> str:
    escaped = escape_overpass(course_name)
    water_clause = ""
    if include_water:
        water_clause = """
  node["natural"="water"](area.courseArea);
  way["natural"="water"](area.courseArea);
  relation["natural"="water"](area.courseArea);
  way["waterway"](area.courseArea);
  relation["waterway"](area.courseArea);
  way["landuse"="reservoir"](area.courseArea);
  relation["landuse"="reservoir"](area.courseArea);
"""
    return f"""
[out:json][timeout:{query_timeout}];
area["leisure"="golf_course"]["name"="{escaped}"]->.courseArea;
(
  node["golf"~"{golf_tag_regex}"](area.courseArea);
  way["golf"~"{golf_tag_regex}"](area.courseArea);
  relation["golf"~"{golf_tag_regex}"](area.courseArea);
{water_clause}
);
out body geom;
"""


def build_feature_query_for_bbox(
    bbox: tuple[float, float, float, float],
    golf_tag_regex: str,
    query_timeout: int,
    include_water: bool,
) -> str:
    south, west, north, east = bbox
    water_clause = ""
    if include_water:
        water_clause = f"""
  node["natural"="water"]({south},{west},{north},{east});
  way["natural"="water"]({south},{west},{north},{east});
  relation["natural"="water"]({south},{west},{north},{east});
  way["waterway"]({south},{west},{north},{east});
  relation["waterway"]({south},{west},{north},{east});
  way["landuse"="reservoir"]({south},{west},{north},{east});
  relation["landuse"="reservoir"]({south},{west},{north},{east});
"""
    return f"""
[out:json][timeout:{query_timeout}];
(
  node["golf"~"{golf_tag_regex}"]({south},{west},{north},{east});
  way["golf"~"{golf_tag_regex}"]({south},{west},{north},{east});
  relation["golf"~"{golf_tag_regex}"]({south},{west},{north},{east});
{water_clause}
);
out body geom;
"""


@dataclass
class OverpassClient:
    endpoint: str
    timeout: int
    retries: int
    backoff: float
    user_agent: str
    session: requests.Session = field(init=False)

    def __post_init__(self) -> None:
        retry_config = Retry(
            total=max(0, self.retries),
            connect=max(0, self.retries),
            read=max(0, self.retries),
            status=max(0, self.retries),
            backoff_factor=max(0.0, self.backoff),
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=frozenset(["GET", "POST"]),
            raise_on_status=False,
        )
        adapter = HTTPAdapter(max_retries=retry_config)
        session = requests.Session()
        session.mount("https://", adapter)
        session.mount("http://", adapter)
        session.headers.update({"User-Agent": self.user_agent})
        self.session = session

    def query(self, query_text: str) -> dict[str, Any]:
        try:
            response = self.session.post(
                self.endpoint,
                data={"data": query_text},
                timeout=self.timeout,
            )
            response.raise_for_status()
        except requests.RequestException as exc:
            raise RuntimeError(f"Overpass request failed: {exc}") from exc

        try:
            payload = response.json()
        except ValueError as exc:
            raise RuntimeError("Overpass returned a non-JSON response.") from exc

        if "elements" not in payload:
            remark = payload.get("remark")
            if remark:
                raise RuntimeError(f"Overpass error: {remark}")
            raise RuntimeError("Overpass response did not contain 'elements'.")

        return payload


def query_with_fallback(
    clients: list[OverpassClient],
    query_text: str,
) -> tuple[dict[str, Any], str]:
    errors: list[str] = []
    for client in clients:
        try:
            return client.query(query_text), client.endpoint
        except RuntimeError as exc:
            errors.append(f"{client.endpoint}: {exc}")
    raise RuntimeError("All Overpass endpoints failed:\n- " + "\n- ".join(errors))


def parse_hole_ref(tags: dict[str, Any]) -> int | None:
    for key in ("ref", "hole", "hole_number"):
        raw = tags.get(key)
        if raw is None:
            continue
        match = re.search(r"\d{1,2}", str(raw))
        if match:
            return int(match.group(0))

    name = str(tags.get("name", ""))
    match = re.search(r"\bhole\s*(\d{1,2})\b", name, flags=re.IGNORECASE)
    if match:
        return int(match.group(1))
    return None


def normalize_golf_tag(tags: dict[str, Any]) -> str | None:
    raw_golf = str(tags.get("golf") or "").strip().lower()
    if raw_golf in {"water_hazard", "lateral_water_hazard", "water"}:
        return "water"
    if raw_golf:
        return raw_golf

    natural = str(tags.get("natural") or "").strip().lower()
    if natural == "water":
        return "water"

    waterway = str(tags.get("waterway") or "").strip().lower()
    if waterway:
        return "water"

    landuse = str(tags.get("landuse") or "").strip().lower()
    if landuse == "reservoir":
        return "water"

    return None


def geometry_from_element(element: dict[str, Any]) -> dict[str, Any] | None:
    element_type = element.get("type")
    if element_type == "node":
        lat = element.get("lat")
        lon = element.get("lon")
        if lat is None or lon is None:
            return None
        return {"type": "Point", "coordinates": [lon, lat]}

    geometry = element.get("geometry") or []
    coords = [
        [point["lon"], point["lat"]]
        for point in geometry
        if "lon" in point and "lat" in point
    ]
    if not coords:
        return None

    is_polygon = len(coords) >= 4 and coords[0] == coords[-1]
    if is_polygon:
        return {"type": "Polygon", "coordinates": [coords]}
    return {"type": "LineString", "coordinates": coords}


def feature_from_element(element: dict[str, Any], source_layer: str) -> dict[str, Any] | None:
    geometry = geometry_from_element(element)
    if geometry is None:
        return None

    tags = dict(element.get("tags") or {})
    properties: dict[str, Any] = {
        "osm_type": element.get("type"),
        "osm_id": element.get("id"),
        "source_layer": source_layer,
        **tags,
    }
    normalized_golf = normalize_golf_tag(tags)
    if normalized_golf is not None:
        properties["golf"] = normalized_golf

    hole_ref = parse_hole_ref(tags)
    if hole_ref is not None:
        properties["hole_ref"] = hole_ref

    return {"type": "Feature", "properties": properties, "geometry": geometry}


def features_from_elements(
    elements: list[dict[str, Any]],
    source_layer: str,
) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    seen: set[tuple[str, int]] = set()

    for element in elements:
        osm_type = str(element.get("type", ""))
        osm_id = element.get("id")
        if not osm_type or not isinstance(osm_id, int):
            continue
        key = (osm_type, osm_id)
        if key in seen:
            continue
        seen.add(key)

        feature = feature_from_element(element, source_layer)
        if feature is not None:
            output.append(feature)

    output.sort(
        key=lambda feature: (
            feature["properties"].get("hole_ref", 10_000),
            str(feature["properties"].get("golf", "")),
            str(feature["properties"].get("osm_type", "")),
            int(feature["properties"].get("osm_id", 0)),
        )
    )
    return output


def iter_positions(geometry: dict[str, Any]) -> Iterable[list[float]]:
    geom_type = geometry.get("type")
    coords = geometry.get("coordinates")

    if geom_type == "Point" and isinstance(coords, list) and len(coords) == 2:
        yield coords
        return

    if geom_type == "LineString" and isinstance(coords, list):
        for point in coords:
            if isinstance(point, list) and len(point) == 2:
                yield point
        return

    if geom_type == "Polygon" and isinstance(coords, list):
        for ring in coords:
            if not isinstance(ring, list):
                continue
            for point in ring:
                if isinstance(point, list) and len(point) == 2:
                    yield point


def calculate_bbox(features: list[dict[str, Any]]) -> tuple[float, float, float, float]:
    lons: list[float] = []
    lats: list[float] = []
    for feature in features:
        geometry = feature.get("geometry") or {}
        for lon, lat in iter_positions(geometry):
            lons.append(float(lon))
            lats.append(float(lat))

    if not lons or not lats:
        raise RuntimeError("Cannot calculate bbox because no coordinates were found.")
    return min(lats), min(lons), max(lats), max(lons)


def expand_bbox(
    bbox: tuple[float, float, float, float],
    margin: float,
) -> tuple[float, float, float, float]:
    south, west, north, east = bbox
    return (
        max(-90.0, south - margin),
        max(-180.0, west - margin),
        min(90.0, north + margin),
        min(180.0, east + margin),
    )


def feature_collection(features: list[dict[str, Any]]) -> dict[str, Any]:
    return {"type": "FeatureCollection", "features": features}


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


def build_hole_index(features: list[dict[str, Any]]) -> dict[str, Any]:
    hole_index: dict[str, list[dict[str, Any]]] = {}
    for feature in features:
        props = feature.get("properties", {})
        hole_ref = props.get("hole_ref")
        if hole_ref is None:
            continue
        hole_key = str(hole_ref)
        hole_index.setdefault(hole_key, []).append(
            {
                "osm_type": props.get("osm_type"),
                "osm_id": props.get("osm_id"),
                "golf": props.get("golf"),
                "geometry_type": feature.get("geometry", {}).get("type"),
            }
        )
    return {
        "hole_count": len(hole_index),
        "holes": {key: hole_index[key] for key in sorted(hole_index, key=lambda x: int(x))},
    }


def build_metadata(
    course_name: str,
    endpoints: list[str],
    course_query_endpoint: str,
    feature_query_endpoint: str,
    golf_tags: list[str],
    include_water: bool,
    course_features: list[dict[str, Any]],
    area_features: list[dict[str, Any]],
    area_source: str,
    bbox_used: tuple[float, float, float, float] | None,
) -> dict[str, Any]:
    tag_counts = Counter(
        str(feature.get("properties", {}).get("golf", "unknown")) for feature in area_features
    )
    hole_refs = sorted(
        {
            int(feature.get("properties", {}).get("hole_ref"))
            for feature in area_features
            if feature.get("properties", {}).get("hole_ref") is not None
        }
    )
    return {
        "course_name": course_name,
        "fetched_at_utc": datetime.now(timezone.utc).isoformat(),
        "overpass_endpoints_considered": endpoints,
        "course_query_endpoint_used": course_query_endpoint,
        "feature_query_endpoint_used": feature_query_endpoint,
        "golf_tags_requested": golf_tags,
        "include_water": include_water,
        "course_feature_count": len(course_features),
        "area_feature_count": len(area_features),
        "area_query_source": area_source,
        "bbox_fallback_used": bbox_used is not None,
        "bbox_fallback": list(bbox_used) if bbox_used else None,
        "area_feature_counts_by_golf_tag": dict(sorted(tag_counts.items())),
        "hole_refs_detected": hole_refs,
    }


def main() -> int:
    try:
        args = parse_args()
        golf_tag_regex = build_tag_regex(args.golf_tags)

        endpoints: list[str] = []
        for endpoint in [args.endpoint, *args.fallback_endpoints]:
            if endpoint and endpoint not in endpoints:
                endpoints.append(endpoint)
        if not endpoints:
            raise RuntimeError("At least one Overpass endpoint is required.")

        clients = [
            OverpassClient(
                endpoint=endpoint,
                timeout=args.http_timeout,
                retries=args.retries,
                backoff=args.backoff,
                user_agent=args.user_agent,
            )
            for endpoint in endpoints
        ]

        course_query = build_course_query(args.course, args.query_timeout)
        course_payload, course_query_endpoint = query_with_fallback(clients, course_query)
        course_features = features_from_elements(course_payload["elements"], "course_boundary")
        if not course_features:
            raise RuntimeError(
                f'No golf course geometry found for "{args.course}". '
                "Check the exact OSM name and try again."
            )

        area_query = build_feature_query_for_area(
            course_name=args.course,
            golf_tag_regex=golf_tag_regex,
            query_timeout=args.query_timeout,
            include_water=args.include_water,
        )
        area_payload, feature_query_endpoint = query_with_fallback(clients, area_query)
        area_features = features_from_elements(area_payload["elements"], "course_area")

        area_source = "course_area"
        bbox_fallback: tuple[float, float, float, float] | None = None

        if not area_features:
            course_bbox = calculate_bbox(course_features)
            bbox_fallback = expand_bbox(course_bbox, args.bbox_margin)
            bbox_query = build_feature_query_for_bbox(
                bbox=bbox_fallback,
                golf_tag_regex=golf_tag_regex,
                query_timeout=args.query_timeout,
                include_water=args.include_water,
            )
            bbox_payload, feature_query_endpoint = query_with_fallback(clients, bbox_query)
            area_features = features_from_elements(
                bbox_payload["elements"],
                "course_bbox_fallback",
            )
            area_source = "course_bbox_fallback"

        output_root = Path(args.out_dir).expanduser().resolve() / slugify(args.course)
        output_root.mkdir(parents=True, exist_ok=True)

        course_geojson = feature_collection(course_features)
        area_geojson = feature_collection(area_features)
        combined_geojson = feature_collection(course_features + area_features)
        hole_index = build_hole_index(area_features)
        metadata = build_metadata(
            course_name=args.course,
            endpoints=endpoints,
            course_query_endpoint=course_query_endpoint,
            feature_query_endpoint=feature_query_endpoint,
            golf_tags=args.golf_tags,
            include_water=args.include_water,
            course_features=course_features,
            area_features=area_features,
            area_source=area_source,
            bbox_used=bbox_fallback,
        )

        write_json(output_root / "course.geojson", course_geojson)
        write_json(output_root / "hole_features.geojson", area_geojson)
        write_json(output_root / "course_with_holes.geojson", combined_geojson)
        write_json(output_root / "hole_index.json", hole_index)
        write_json(output_root / "metadata.json", metadata)
        index_path = update_course_map_index(Path(args.out_dir))

        print(f"Course: {args.course}")
        print(f"Output directory: {output_root}")
        print(f"Course map index: {index_path}")
        print(f"Course boundary features: {len(course_features)}")
        print(f"Hole-related features: {len(area_features)}")
        print(f"Area source: {area_source}")
        print(f"Course endpoint used: {course_query_endpoint}")
        print(f"Feature endpoint used: {feature_query_endpoint}")
        if bbox_fallback:
            print(f"BBox fallback used: {bbox_fallback}")
        return 0
    except (RuntimeError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
