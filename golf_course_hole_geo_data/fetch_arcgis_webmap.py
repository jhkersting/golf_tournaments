#!/usr/bin/env python3
"""Download all feature-layer records from an ArcGIS Web Map item."""

from __future__ import annotations

import argparse
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import requests

from course_map_index import update_course_map_index

DEFAULT_PORTAL = "https://www-tlstest.arcgis.com"
DEFAULT_OUT_DIR = "golf_course_hole_geo_data/data"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch all ArcGIS FeatureLayer data from a Web Map item."
    )
    parser.add_argument(
        "--webmap-url",
        help="Full ArcGIS web map URL containing ?webmap=<itemId>.",
    )
    parser.add_argument(
        "--webmap-id",
        help="ArcGIS web map item ID (32 hex chars).",
    )
    parser.add_argument(
        "--portal",
        default=DEFAULT_PORTAL,
        help=f"ArcGIS portal base URL (default: {DEFAULT_PORTAL}).",
    )
    parser.add_argument(
        "--out-dir",
        default=DEFAULT_OUT_DIR,
        help=f"Output base directory (default: {DEFAULT_OUT_DIR}).",
    )
    parser.add_argument(
        "--slug",
        help="Optional output folder name. If omitted, one is generated.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=1000,
        help="ObjectID batch size per query (default: 1000).",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=60,
        help="HTTP timeout in seconds (default: 60).",
    )
    return parser.parse_args()


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return slug or "arcgis-webmap"


def extract_webmap_id(value: str) -> str | None:
    value = value.strip()
    if re.fullmatch(r"[0-9a-fA-F]{32}", value):
        return value.lower()
    parsed = urlparse(value)
    params = parse_qs(parsed.query)
    if "webmap" in params and params["webmap"]:
        candidate = params["webmap"][0].strip()
        if re.fullmatch(r"[0-9a-fA-F]{32}", candidate):
            return candidate.lower()
    return None


def get_json(url: str, timeout: int, params: dict[str, Any] | None = None) -> dict[str, Any]:
    params = dict(params or {})
    params.setdefault("f", "json")
    response = requests.get(url, params=params, timeout=timeout)
    response.raise_for_status()
    payload = response.json()
    if isinstance(payload, dict) and "error" in payload:
        message = payload["error"].get("message", "ArcGIS request failed")
        details = payload["error"].get("details") or []
        if details:
            message = f"{message}: {'; '.join(map(str, details))}"
        raise RuntimeError(message)
    return payload


def split_batches(values: list[int], batch_size: int) -> list[list[int]]:
    if batch_size <= 0:
        raise ValueError("--batch-size must be greater than zero.")
    return [values[i : i + batch_size] for i in range(0, len(values), batch_size)]


def get_layer_object_ids(layer_url: str, timeout: int) -> list[int]:
    payload = get_json(
        f"{layer_url}/query",
        timeout=timeout,
        params={"where": "1=1", "returnIdsOnly": "true"},
    )
    object_ids = payload.get("objectIds") or []
    return sorted(int(x) for x in object_ids)


def get_layer_geojson_batch(layer_url: str, object_ids: list[int], timeout: int) -> dict[str, Any]:
    params = {
        "objectIds": ",".join(str(x) for x in object_ids),
        "outFields": "*",
        "returnGeometry": "true",
        "outSR": "4326",
        "f": "geojson",
    }
    response = requests.get(f"{layer_url}/query", params=params, timeout=timeout)
    response.raise_for_status()
    payload = response.json()
    if isinstance(payload, dict) and "error" in payload:
        message = payload["error"].get("message", "Layer query failed")
        details = payload["error"].get("details") or []
        if details:
            message = f"{message}: {'; '.join(map(str, details))}"
        raise RuntimeError(message)
    return payload


def fetch_layer_features(
    layer_url: str,
    timeout: int,
    batch_size: int,
) -> dict[str, Any]:
    object_ids = get_layer_object_ids(layer_url, timeout)
    if not object_ids:
        return {"type": "FeatureCollection", "features": []}

    all_features: list[dict[str, Any]] = []
    for id_batch in split_batches(object_ids, batch_size):
        payload = get_layer_geojson_batch(layer_url, id_batch, timeout)
        features = payload.get("features") or []
        if not isinstance(features, list):
            raise RuntimeError(f"Invalid feature payload from {layer_url}")
        all_features.extend(features)
    return {"type": "FeatureCollection", "features": all_features}


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


def main() -> int:
    args = parse_args()
    candidate = args.webmap_id or args.webmap_url
    if not candidate:
        raise SystemExit("Provide --webmap-id or --webmap-url.")

    webmap_id = extract_webmap_id(candidate)
    if not webmap_id:
        raise SystemExit("Could not parse a valid webmap ID from input.")

    portal = args.portal.rstrip("/")
    item_url = f"{portal}/sharing/rest/content/items/{webmap_id}"
    item = get_json(item_url, timeout=args.timeout)
    webmap_data = get_json(f"{item_url}/data", timeout=args.timeout)

    title = str(item.get("title") or f"webmap-{webmap_id}")
    out_slug = args.slug or slugify(f"{title}-arcgis")
    out_root = Path(args.out_dir).expanduser().resolve() / out_slug
    out_root.mkdir(parents=True, exist_ok=True)

    write_json(out_root / "webmap_item.json", item)
    write_json(out_root / "webmap_data.json", webmap_data)

    operational_layers = webmap_data.get("operationalLayers") or []
    layer_summaries: list[dict[str, Any]] = []
    combined_features: list[dict[str, Any]] = []

    for idx, layer in enumerate(operational_layers):
        layer_url = layer.get("url")
        layer_type = str(layer.get("layerType", ""))
        layer_title = str(layer.get("title") or f"layer-{idx}")
        layer_id = str(layer.get("id") or idx)

        if not layer_url:
            layer_summaries.append(
                {
                    "index": idx,
                    "title": layer_title,
                    "id": layer_id,
                    "layer_type": layer_type,
                    "url": layer_url,
                    "status": "skipped_missing_layer_url",
                }
            )
            continue

        try:
            layer_info = get_json(layer_url, timeout=args.timeout)
            layer_geojson = fetch_layer_features(
                layer_url=layer_url,
                timeout=args.timeout,
                batch_size=args.batch_size,
            )
        except Exception as exc:
            layer_summaries.append(
                {
                    "index": idx,
                    "title": layer_title,
                    "id": layer_id,
                    "layer_type": layer_type,
                    "url": layer_url,
                    "status": "skipped_non_queryable_layer",
                    "error": str(exc),
                }
            )
            continue

        for feature in layer_geojson.get("features", []):
            props = feature.get("properties")
            if not isinstance(props, dict):
                props = {}
                feature["properties"] = props
            props["_layer_title"] = layer_title
            props["_layer_id"] = layer_id
            props["_layer_url"] = layer_url
            combined_features.append(feature)

        layer_file_name = f"layer_{idx:02d}_{slugify(layer_title)}.geojson"
        write_json(out_root / layer_file_name, layer_geojson)
        write_json(out_root / f"layer_{idx:02d}_{slugify(layer_title)}_meta.json", layer_info)

        geometry_type_counts: dict[str, int] = {}
        for feature in layer_geojson.get("features", []):
            geom_type = str((feature.get("geometry") or {}).get("type") or "None")
            geometry_type_counts[geom_type] = geometry_type_counts.get(geom_type, 0) + 1

        layer_summaries.append(
            {
                "index": idx,
                "title": layer_title,
                "id": layer_id,
                "layer_type": layer_type,
                "url": layer_url,
                "feature_count": len(layer_geojson.get("features", [])),
                "geometry_type_counts": geometry_type_counts,
                "max_record_count": layer_info.get("maxRecordCount"),
                "status": "fetched",
                "output_file": layer_file_name,
            }
        )

    combined_geojson = {"type": "FeatureCollection", "features": combined_features}
    write_json(out_root / "all_layers.geojson", combined_geojson)

    fetched_layers = [x for x in layer_summaries if x.get("status") == "fetched"]
    summary = {
        "fetched_at_utc": datetime.now(timezone.utc).isoformat(),
        "portal": portal,
        "webmap_id": webmap_id,
        "title": title,
        "total_operational_layers": len(operational_layers),
        "fetched_feature_layers": len(fetched_layers),
        "total_features": len(combined_features),
        "layer_summaries": layer_summaries,
        "estimated_batches": sum(
            math.ceil((x.get("feature_count", 0) or 0) / args.batch_size)
            for x in fetched_layers
        ),
    }
    write_json(out_root / "summary.json", summary)
    index_path = update_course_map_index(Path(args.out_dir))

    print(f"Web map: {title}")
    print(f"Output directory: {out_root}")
    print(f"Course map index: {index_path}")
    print(f"Feature layers fetched: {len(fetched_layers)}")
    print(f"Total features fetched: {len(combined_features)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
