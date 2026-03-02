#!/usr/bin/env python3
"""Build and refresh a consolidated course map availability index."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

INDEX_FILENAME = "courses_map_index.json"


def _read_json(path: Path) -> dict[str, Any] | list[Any] | None:
    if not path.exists() or not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _repo_root_for_data_root(data_root: Path) -> Path:
    # Standard layout: <repo>/golf_course_hole_geo_data/data
    if data_root.name == "data" and data_root.parent.name == "golf_course_hole_geo_data":
        return data_root.parent.parent
    return data_root.parent


def _rel_path(path: Path, base: Path) -> str:
    try:
        return str(path.relative_to(base))
    except ValueError:
        return str(path)


def _as_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def _course_name_for_dir(course_dir: Path) -> str:
    metadata = _read_json(course_dir / "metadata.json")
    if isinstance(metadata, dict):
        for key in ("course_name", "name", "title"):
            name = str(metadata.get(key) or "").strip()
            if name:
                return name

    bluegolf = _read_json(course_dir / "bluegolf_course_data.json")
    if isinstance(bluegolf, dict):
        name = str(bluegolf.get("name") or "").strip()
        if name:
            return name

    summary = _read_json(course_dir / "summary.json")
    if isinstance(summary, dict):
        title = str(summary.get("title") or "").strip()
        if title:
            return title

    return course_dir.name


def build_course_map_index(data_root: Path) -> dict[str, Any]:
    root = data_root.expanduser().resolve()
    repo_root = _repo_root_for_data_root(root)
    courses: list[dict[str, Any]] = []

    if root.exists() and root.is_dir():
        for course_dir in sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith(".")):
            has_full_map = all(
                (course_dir / name).exists()
                for name in ("course.geojson", "hole_features.geojson", "hole_index.json")
            )
            has_simplified_map = all(
                (course_dir / name).exists()
                for name in ("bluegolf_tee_green_coordinates.json", "bluegolf_course_data.json")
            )

            full_holes: int | None = None
            hole_index = _read_json(course_dir / "hole_index.json")
            if isinstance(hole_index, dict):
                full_holes = _as_int(hole_index.get("hole_count"))
                if full_holes is None:
                    holes = hole_index.get("holes")
                    if isinstance(holes, dict):
                        full_holes = len(holes)

            simplified_holes: int | None = None
            simplified_rows = _read_json(course_dir / "bluegolf_tee_green_coordinates.json")
            if isinstance(simplified_rows, list):
                simplified_holes = len(simplified_rows)

            map_level = "full" if has_full_map else ("simplified" if has_simplified_map else "none")

            courses.append(
                {
                    "slug": course_dir.name,
                    "name": _course_name_for_dir(course_dir),
                    "path": _rel_path(course_dir, repo_root),
                    "map_level": map_level,
                    "has_full_map": has_full_map,
                    "has_simplified_map": has_simplified_map,
                    "holes": {
                        "full_map_holes": full_holes,
                        "simplified_map_holes": simplified_holes,
                    },
                    "files": {
                        "course_geojson": (course_dir / "course.geojson").exists(),
                        "hole_features_geojson": (course_dir / "hole_features.geojson").exists(),
                        "hole_index_json": (course_dir / "hole_index.json").exists(),
                        "bluegolf_coordinates_json": (
                            course_dir / "bluegolf_tee_green_coordinates.json"
                        ).exists(),
                        "bluegolf_course_data_json": (
                            course_dir / "bluegolf_course_data.json"
                        ).exists(),
                    },
                }
            )

    counts = {"full": 0, "simplified": 0, "none": 0}
    for course in courses:
        level = str(course.get("map_level") or "none")
        if level in counts:
            counts[level] += 1

    courses_by_slug = {
        str(course.get("slug") or ""): {
            "name": course.get("name"),
            "map_level": course.get("map_level"),
            "has_full_map": course.get("has_full_map"),
            "has_simplified_map": course.get("has_simplified_map"),
        }
        for course in courses
        if str(course.get("slug") or "").strip()
    }

    return {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "data_root": _rel_path(root, repo_root),
        "course_count": len(courses),
        "counts_by_map_level": counts,
        "courses_by_slug": courses_by_slug,
        "courses": courses,
    }


def _write_text_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(content, encoding="utf-8")
    tmp_path.replace(path)


def update_course_map_index(data_root: Path) -> Path:
    root = data_root.expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    payload = build_course_map_index(root)
    out_path = root / INDEX_FILENAME
    content = json.dumps(payload, indent=2) + "\n"
    _write_text_atomic(out_path, content)
    return out_path
