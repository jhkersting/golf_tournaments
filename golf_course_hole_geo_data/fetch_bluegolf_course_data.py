#!/usr/bin/env python3
"""Fetch BlueGolf hole coordinates + scorecard data and optionally save a backend course."""

from __future__ import annotations

import argparse
import csv
import html
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

DEFAULT_API_BASE = "https://1rmb4h6ty8.execute-api.us-east-1.amazonaws.com/prod"
DEFAULT_OUT_DIR = "golf_course_hole_geo_data/data"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Fetch BlueGolf course overview + detailed scorecard data, write local files, "
            "and optionally save the course into the AWS backend /courses catalog."
        )
    )
    parser.add_argument(
        "--course-slug",
        required=True,
        help="BlueGolf course slug (example: sherrillpark1).",
    )
    parser.add_argument(
        "--out-dir",
        default=DEFAULT_OUT_DIR,
        help=f"Base output folder (default: {DEFAULT_OUT_DIR}).",
    )
    parser.add_argument(
        "--data-slug",
        default=None,
        help="Output subfolder name under --out-dir. Defaults to --course-slug.",
    )
    parser.add_argument(
        "--course-id",
        default=None,
        help="Saved-course id for backend POST /courses. Defaults to bluegolf-<course-slug>.",
    )
    parser.add_argument(
        "--save-course",
        action="store_true",
        help="POST the parsed course into the backend /courses endpoint.",
    )
    parser.add_argument(
        "--api-base",
        default=os.environ.get("API_BASE", DEFAULT_API_BASE),
        help=f"Backend API base URL for saving courses (default: {DEFAULT_API_BASE}).",
    )
    parser.add_argument(
        "--admin-key",
        default=os.environ.get("ADMIN_KEY", "ADMIN_RTR"),
        help=(
            "Admin key header value for backend save. "
            "Defaults to ADMIN_KEY env var, then ADMIN_RTR."
        ),
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=45,
        help="HTTP timeout in seconds (default: 45).",
    )
    parser.add_argument(
        "--overview-json-file",
        default=None,
        help="Optional local path to overview.json. If set, network fetch is skipped.",
    )
    parser.add_argument(
        "--scorecard-html-file",
        default=None,
        help="Optional local path to detailedscorecard HTML. If set, network fetch is skipped.",
    )
    return parser.parse_args()


def get_json(url: str, timeout: int) -> dict[str, Any]:
    try:
        response = requests.get(url, timeout=timeout)
        response.raise_for_status()
        return response.json()
    except requests.RequestException:
        return json.loads(fetch_with_curl(url, timeout))


def get_text(url: str, timeout: int) -> str:
    try:
        response = requests.get(url, timeout=timeout)
        response.raise_for_status()
        return response.text
    except requests.RequestException:
        return fetch_with_curl(url, timeout)


def fetch_with_curl(url: str, timeout: int) -> str:
    cmd = [
        "curl",
        "-LfsS",
        "--max-time",
        str(max(5, int(timeout))),
        url,
    ]
    proc = subprocess.run(cmd, check=False, capture_output=True, text=True)
    if proc.returncode != 0:
        message = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(f"curl fetch failed for {url}: {message}")
    return proc.stdout


def clean_html_text(raw: str) -> str:
    text = re.sub(r"<[^>]+>", "", raw or "")
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def to_int(raw: str) -> int | None:
    match = re.search(r"-?\d+", str(raw or ""))
    if not match:
        return None
    try:
        return int(match.group(0))
    except ValueError:
        return None


def collapse_hole_cells(cells: list[str]) -> list[str]:
    # BlueGolf rows are usually 21 values: 1..9, Out, 10..18, In, Tot.
    if len(cells) >= 21:
        front = cells[0:9]
        back = cells[10:19]
        return front + back
    return cells[:18]


def parse_row_values(table_html: str, row_labels: str | list[str]) -> list[int] | None:
    labels_to_match = (
        [row_labels]
        if isinstance(row_labels, str)
        else [str(label) for label in row_labels]
    )
    labels_to_match = [label.lower() for label in labels_to_match]

    row_pattern = re.compile(r"<tr[^>]*>(.*?)</tr>", flags=re.IGNORECASE | re.DOTALL)
    cell_pattern = re.compile(r"<t[dh][^>]*>(.*?)</t[dh]>", flags=re.IGNORECASE | re.DOTALL)

    for row_html in row_pattern.findall(table_html):
        cells_html = cell_pattern.findall(row_html)
        if not cells_html:
            continue
        labels = [clean_html_text(cell) for cell in cells_html]
        if not labels:
            continue
        if labels[0].lower() not in labels_to_match:
            continue

        collapsed = collapse_hole_cells(labels[1:])
        parsed = [to_int(value) for value in collapsed]
        if len(parsed) == 18 and all(value is not None for value in parsed):
            return [int(value) for value in parsed if value is not None]
    return None


def parse_scorecard_summary_items(summary_html: str) -> dict[str, str]:
    items: dict[str, str] = {}
    item_pattern = re.compile(
        r"<li[^>]*>\s*<span>(.*?)</span>\s*<p>(.*?)</p>\s*</li>",
        flags=re.IGNORECASE | re.DOTALL,
    )
    for value_html, label_html in item_pattern.findall(summary_html or ""):
        label = clean_html_text(label_html).lower()
        value = clean_html_text(value_html)
        if label:
            items[label] = value
    return items


def parse_tee_menu_entries(scorecard_html: str) -> list[dict[str, Any]]:
    menu_match = re.search(
        r'<ul class="dropdown-menu">(.*?)</ul>',
        scorecard_html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not menu_match:
        return []

    entries: list[dict[str, Any]] = []
    entry_pattern = re.compile(
        r'<a[^>]+href="#(?P<tab_id>dropdown-tee-[^"]+)".*?>'
        r'.*?<span class="ddm-first ddm-mid ddm-center">(.*?)</span>'
        r'.*?<span class="stat[^"]*">\((.*?)\)</span>',
        flags=re.IGNORECASE | re.DOTALL,
    )
    for tab_id, tee_name_html, stat_html in entry_pattern.findall(menu_match.group(1)):
        tee_name = clean_html_text(tee_name_html)
        if tee_name.lower() == "show all":
            continue

        stat_text = clean_html_text(stat_html)
        gender = None
        rating = None
        slope = None
        stat_match = re.match(r"([A-Za-z])\s*-\s*([0-9]+(?:\.[0-9]+)?)\s*/\s*([0-9]+)", stat_text)
        if stat_match:
            gender = stat_match.group(1).upper()
            rating = float(stat_match.group(2))
            slope = int(stat_match.group(3))

        entries.append(
            {
                "tabId": tab_id,
                "teeName": tee_name,
                "gender": gender,
                "rating": rating,
                "slope": slope,
            }
        )
    return entries


def parse_scorecard_tees(scorecard_html: str) -> list[dict[str, Any]]:
    tee_menu_entries = parse_tee_menu_entries(scorecard_html)
    tee_menu_by_tab = {entry["tabId"]: entry for entry in tee_menu_entries}

    tee_tab_pattern = re.compile(
        r'<div class="text-uppercase tab-pane\s+tee-tab(?: active in)?" id="(?P<tab_id>dropdown-tee-[^"]+)">'
        r'(?P<body>.*?<ul class="scorecard d-table-cell w-100">.*?</ul>.*?<table[^>]*>.*?</table>)',
        flags=re.IGNORECASE | re.DOTALL,
    )

    tees: list[dict[str, Any]] = []
    for match in tee_tab_pattern.finditer(scorecard_html):
        tab_id = match.group("tab_id")
        body_html = match.group("body")

        scorecard_match = re.search(
            r'<ul class="scorecard d-table-cell w-100">(.*?)</ul>',
            body_html,
            flags=re.IGNORECASE | re.DOTALL,
        )
        table_match = re.search(
            r"(<table[^>]*>.*?</table>)",
            body_html,
            flags=re.IGNORECASE | re.DOTALL,
        )
        if not scorecard_match or not table_match:
            continue

        summary_items = parse_scorecard_summary_items(scorecard_match.group(1))
        table_html = table_match.group(1)
        hole_yardages = parse_row_values(table_html, ["yds", "yards", "yardage"])
        if not hole_yardages:
            continue

        total_yards = to_int(summary_items.get("yards")) or sum(hole_yardages)
        rating_text = summary_items.get("rating")
        slope_text = summary_items.get("slope")

        menu_entry = tee_menu_by_tab.get(tab_id, {})
        tee_name = menu_entry.get("teeName")
        if not tee_name:
            tee_name_match = re.search(
                r'<span class="ddm-cell ddm-word text-uppercase">(.*?)</span>',
                body_html,
                flags=re.IGNORECASE | re.DOTALL,
            )
            tee_name = clean_html_text(tee_name_match.group(1)) if tee_name_match else tab_id

        tee_data = {
            "tabId": tab_id,
            "teeName": tee_name,
            "gender": menu_entry.get("gender"),
            "parTotal": to_int(summary_items.get("par")),
            "totalYards": total_yards,
            "rating": float(rating_text) if rating_text and re.search(r"\d", rating_text) else None,
            "slope": to_int(slope_text),
            "holeYardages": hole_yardages,
        }

        # Keep dropdown metadata when the summary strip omits a value.
        if tee_data["rating"] is None:
            tee_data["rating"] = menu_entry.get("rating")
        if tee_data["slope"] is None:
            tee_data["slope"] = menu_entry.get("slope")

        tees.append(tee_data)

    unique_tees: list[dict[str, Any]] = []
    seen_tab_ids: set[str] = set()
    for tee in tees:
        tab_id = str(tee.get("tabId") or "")
        if tab_id in seen_tab_ids:
            continue
        seen_tab_ids.add(tab_id)
        unique_tees.append(tee)

    unique_tees.sort(
        key=lambda tee: (
            -int(tee.get("totalYards") or 0),
            str(tee.get("teeName") or ""),
            str(tee.get("gender") or ""),
        )
    )
    return unique_tees


def select_longest_tee_sets(tees: list[dict[str, Any]], limit: int = 3) -> list[dict[str, Any]]:
    grouped: dict[tuple[Any, ...], dict[str, Any]] = {}
    for tee in tees:
        key = (
            tee.get("teeName"),
            int(tee.get("totalYards") or 0),
            tuple(int(value) for value in tee.get("holeYardages") or []),
        )
        rating_entry = {
            "gender": tee.get("gender"),
            "rating": tee.get("rating"),
            "slope": tee.get("slope"),
        }
        group = grouped.get(key)
        if group is None:
            grouped[key] = {
                "teeName": tee.get("teeName"),
                "parTotal": tee.get("parTotal"),
                "totalYards": tee.get("totalYards"),
                "holeYardages": list(tee.get("holeYardages") or []),
                "ratings": [rating_entry],
            }
            continue

        existing_ratings = group["ratings"]
        if rating_entry not in existing_ratings:
            existing_ratings.append(rating_entry)

    tee_sets = list(grouped.values())
    tee_sets.sort(
        key=lambda tee: (
            -int(tee.get("totalYards") or 0),
            str(tee.get("teeName") or ""),
        )
    )
    return tee_sets[:limit]


def parse_scorecard_course_info(scorecard_html: str) -> dict[str, Any]:
    title_match = re.search(
        r"<title>(.*?)</title>", scorecard_html, flags=re.IGNORECASE | re.DOTALL
    )
    raw_title = clean_html_text(title_match.group(1)) if title_match else ""
    course_name = re.sub(
        r"\s*-\s*Detailed Scorecard(?:\s*\|\s*Course Database)?\s*$",
        "",
        raw_title,
        flags=re.IGNORECASE,
    ).strip()
    course_name = re.sub(
        r"\s*\|\s*Course Database\s*$",
        "",
        course_name,
        flags=re.IGNORECASE,
    ).strip()
    if not course_name:
        h3_match = re.search(
            r"<h3[^>]*>\s*<span[^>]*>(.*?)</span>",
            scorecard_html,
            flags=re.IGNORECASE | re.DOTALL,
        )
        course_name = clean_html_text(h3_match.group(1)) if h3_match else "BlueGolf Course"

    location_match = re.search(
        r'<li class="nav-item pl-0 ml-0">(.*?)</li>',
        scorecard_html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    location = clean_html_text(location_match.group(1)) if location_match else ""

    tables = re.findall(
        r"<table[^>]*>(.*?)</table>", scorecard_html, flags=re.IGNORECASE | re.DOTALL
    )
    pars = None
    stroke_index = None
    for table_html in tables:
        parsed_pars = parse_row_values(table_html, "Par")
        parsed_hcp = parse_row_values(table_html, ["Hcp", "Hdcp", "Handicap"])
        if parsed_pars and parsed_hcp:
            pars = parsed_pars
            stroke_index = parsed_hcp
            break

    if not pars or not stroke_index:
        raise RuntimeError(
            "Could not parse 18-hole Par/Hcp rows from detailed scorecard HTML."
        )

    if len(set(stroke_index)) != 18 or any(v < 1 or v > 18 for v in stroke_index):
        raise RuntimeError(
            "Parsed stroke index from scorecard is invalid (must be unique 1..18)."
        )

    tees = parse_scorecard_tees(scorecard_html)

    return {
        "name": course_name,
        "location": location,
        "pars": pars,
        "strokeIndex": stroke_index,
        "tees": tees,
        "longestTees": select_longest_tee_sets(tees, limit=3),
    }


def projected_point_to_lon_lat(hole: dict[str, Any], point: dict[str, Any]) -> tuple[float, float]:
    x = float(point["x"])
    y = -float(point["y"])
    lon = float(hole["lon"]) + (x / float(hole["lon2x"]))
    lat = float(hole["lat"]) - (y / float(hole["lat2y"]))
    return lat, lon


def build_tee_green_rows(overview_payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    holes = overview_payload.get("holes") or []
    for idx, hole in enumerate(holes, start=1):
        points_by_name = {point.get("name"): point for point in (hole.get("points") or [])}

        tee_lat = tee_lon = None
        tee_point = points_by_name.get("tee")
        if tee_point:
            tee_lat, tee_lon = projected_point_to_lon_lat(hole, tee_point)

        feature_green = None
        for feature in hole.get("features") or []:
            if str(feature.get("type") or "").lower() == "green":
                feature_green = feature
                break

        gf_lat = gf_lon = gc_lat = gc_lon = gb_lat = gb_lon = None
        if feature_green:
            gf_lat = feature_green.get("frontlat")
            gf_lon = feature_green.get("frontlon")
            gc_lat = feature_green.get("centerlat")
            gc_lon = feature_green.get("centerlon")
            gb_lat = feature_green.get("backlat")
            gb_lon = feature_green.get("backlon")

        if gf_lat is None and points_by_name.get("green_front"):
            gf_lat, gf_lon = projected_point_to_lon_lat(hole, points_by_name["green_front"])
        if gc_lat is None and points_by_name.get("green_center"):
            gc_lat, gc_lon = projected_point_to_lon_lat(hole, points_by_name["green_center"])
        if gb_lat is None and points_by_name.get("green_back"):
            gb_lat, gb_lon = projected_point_to_lon_lat(hole, points_by_name["green_back"])

        # Keep downstream consumers stable when BlueGolf omits front/back targets.
        if gc_lat is None and gf_lat is not None:
            gc_lat, gc_lon = gf_lat, gf_lon
        if gc_lat is None and gb_lat is not None:
            gc_lat, gc_lon = gb_lat, gb_lon
        if gf_lat is None and gc_lat is not None:
            gf_lat, gf_lon = gc_lat, gc_lon
        if gb_lat is None and gc_lat is not None:
            gb_lat, gb_lon = gc_lat, gc_lon

        rows.append(
            {
                "hole": idx,
                "tee_lat": tee_lat,
                "tee_lon": tee_lon,
                "green_front_lat": gf_lat,
                "green_front_lon": gf_lon,
                "green_center_lat": gc_lat,
                "green_center_lon": gc_lon,
                "green_back_lat": gb_lat,
                "green_back_lon": gb_lon,
            }
        )
    return rows


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def write_coordinates_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "hole",
        "tee_lat",
        "tee_lon",
        "green_front_lat",
        "green_front_lon",
        "green_center_lat",
        "green_center_lon",
        "green_back_lat",
        "green_back_lon",
    ]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def write_coordinates_geojson(path: Path, rows: list[dict[str, Any]]) -> None:
    features: list[dict[str, Any]] = []
    for row in rows:
        hole = int(row["hole"])
        for point_type in ("tee", "green_front", "green_center", "green_back"):
            lat = row.get(f"{point_type}_lat")
            lon = row.get(f"{point_type}_lon")
            if lat is None or lon is None:
                continue
            features.append(
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [float(lon), float(lat)]},
                    "properties": {
                        "hole": hole,
                        "point_type": point_type,
                        "source": "bluegolf_overview_json",
                    },
                }
            )
    write_json(path, {"type": "FeatureCollection", "features": features})


def save_course_to_backend(
    api_base: str,
    admin_key: str,
    payload: dict[str, Any],
    timeout: int,
) -> dict[str, Any]:
    url = api_base.rstrip("/") + "/courses"
    headers = {"Content-Type": "application/json"}
    if admin_key:
        headers["x-admin-key"] = admin_key
    response = requests.post(url, headers=headers, json={"course": payload}, timeout=timeout)
    response.raise_for_status()
    return response.json()


def main() -> int:
    args = parse_args()
    course_slug = args.course_slug.strip().lower()
    data_slug = (args.data_slug or course_slug).strip()
    output_root = Path(args.out_dir).expanduser().resolve() / data_slug
    output_root.mkdir(parents=True, exist_ok=True)

    overview_url = f"https://app.bluegolf.com/bluegolf/app/course/{course_slug}/overview.json"
    scorecard_url = (
        f"https://course.bluegolf.com/bluegolf/course/course/{course_slug}/detailedscorecard.htm"
    )

    try:
        if args.overview_json_file:
            overview_payload = json.loads(
                Path(args.overview_json_file).expanduser().read_text(encoding="utf-8")
            )
        else:
            overview_payload = get_json(overview_url, timeout=args.timeout)

        if args.scorecard_html_file:
            scorecard_html = Path(args.scorecard_html_file).expanduser().read_text(
                encoding="utf-8"
            )
        else:
            scorecard_html = get_text(scorecard_url, timeout=args.timeout)

        scorecard_info = parse_scorecard_course_info(scorecard_html)
    except (requests.RequestException, OSError, json.JSONDecodeError, RuntimeError) as exc:
        print(f"Error: failed to load source data: {exc}", file=sys.stderr)
        return 1

    coordinate_rows = build_tee_green_rows(overview_payload)
    if len(coordinate_rows) != 18:
        print(
            f"Error: expected 18 holes in overview.json, found {len(coordinate_rows)}",
            file=sys.stderr,
        )
        return 1

    course_id = args.course_id or f"bluegolf-{course_slug}"
    course_payload = {
        "courseId": course_id,
        "name": scorecard_info["name"],
        "pars": scorecard_info["pars"],
        "strokeIndex": scorecard_info["strokeIndex"],
        "tees": scorecard_info["longestTees"],
        "longestTees": scorecard_info["longestTees"],
    }

    course_data = {
        "courseSlug": course_slug,
        "courseId": course_id,
        "name": scorecard_info["name"],
        "location": scorecard_info["location"],
        "sourceUrls": {
            "overviewJson": overview_url,
            "detailedScorecard": scorecard_url,
        },
        "pars": scorecard_info["pars"],
        "strokeIndex": scorecard_info["strokeIndex"],
        "tees": scorecard_info["tees"],
        "longestTees": scorecard_info["longestTees"],
        "fetchedAtUtc": datetime.now(timezone.utc).isoformat(),
    }

    write_coordinates_csv(output_root / "bluegolf_tee_green_coordinates.csv", coordinate_rows)
    write_json(output_root / "bluegolf_tee_green_coordinates.json", coordinate_rows)
    write_coordinates_geojson(output_root / "bluegolf_tee_green_points.geojson", coordinate_rows)
    write_json(output_root / "bluegolf_course_data.json", course_data)
    write_json(output_root / "bluegolf_saved_course_payload.json", course_payload)

    print(f"Course slug: {course_slug}")
    print(f"Output directory: {output_root}")
    print("Wrote:")
    print(" - bluegolf_tee_green_coordinates.csv")
    print(" - bluegolf_tee_green_coordinates.json")
    print(" - bluegolf_tee_green_points.geojson")
    print(" - bluegolf_course_data.json")
    print(" - bluegolf_saved_course_payload.json")

    if args.save_course:
        try:
            backend_response = save_course_to_backend(
                api_base=args.api_base,
                admin_key=args.admin_key,
                payload=course_payload,
                timeout=args.timeout,
            )
        except requests.RequestException as exc:
            print(f"Error: backend save failed: {exc}", file=sys.stderr)
            return 1

        write_json(output_root / "bluegolf_backend_save_response.json", backend_response)
        print("Saved to backend /courses and wrote bluegolf_backend_save_response.json")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
