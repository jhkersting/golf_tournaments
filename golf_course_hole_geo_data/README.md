# Golf Course Hole Geodata

This folder stores scripts and output data for golf course and hole geodata that can later be consumed by the main site.

## What this script does

`fetch_golf_course_holes.py`:
- fetches the course boundary (`leisure=golf_course`) by exact OSM name
- fetches hole-related features (default tags: `hole fairway green tee bunker`)
- falls back to a course bounding-box query if area-based lookup returns no results
- writes normalized GeoJSON + metadata files per course

## Usage

From repo root:

```bash
python3 golf_course_hole_geo_data/fetch_golf_course_holes.py \
  --course "Tenison Park Golf Course"
```

Example with stricter hole-only fetch:

```bash
python3 golf_course_hole_geo_data/fetch_golf_course_holes.py \
  --course "Tenison Park Golf Course" \
  --golf-tags hole
```

Example with fallback Overpass endpoints:

```bash
python3 golf_course_hole_geo_data/fetch_golf_course_holes.py \
  --course "Tenison Park Golf Course" \
  --fallback-endpoint "https://lz4.overpass-api.de/api/interpreter" \
  --fallback-endpoint "https://overpass.kumi.systems/api/interpreter"
```

## Output

Each run writes to:

`golf_course_hole_geo_data/data/<course-slug>/`

Files:
- `course.geojson` (course boundary features)
- `hole_features.geojson` (hole-related features from area or bbox fallback)
- `course_with_holes.geojson` (combined course + hole features)
- `hole_index.json` (hole-number index when detectable from tags)
- `metadata.json` (source + counts + fetch metadata)
