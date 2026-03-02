# Golf Course Hole Geodata

This folder stores scripts and output data for golf course and hole geodata that can later be consumed by the main site.

All scrapers now refresh a shared index file at:

`golf_course_hole_geo_data/data/courses_map_index.json`

This index lists every course folder and marks map availability as:
- `full`
- `simplified`
- `none`

## What this script does

`fetch_golf_course_holes.py`:
- fetches the course boundary (`leisure=golf_course`) by exact OSM name
- fetches hole-related features (default tags: `hole fairway green tee bunker water_hazard lateral_water_hazard`)
- also fetches water features inside the course area/bbox by default (`natural=water`, `waterway=*`, `landuse=reservoir`)
- falls back to a course bounding-box query if area-based lookup returns no results
- writes normalized GeoJSON + metadata files per course

`fetch_arcgis_webmap.py`:
- fetches all queryable operational layers from an ArcGIS Web Map item
- preserves full feature properties and geometry, including water layers when present

`fetch_bluegolf_course_data.py`:
- fetches BlueGolf `overview.json` to derive tee + green coordinates per hole
- fetches BlueGolf `detailedscorecard.htm` and parses `Par` + `Hcp` rows
- writes coordinate CSV/JSON/GeoJSON plus a backend-ready saved-course payload
- optionally POSTs that payload to `POST /courses` so the course is saved in AWS backend catalog

## Usage

From repo root:

```bash
python3 golf_course_hole_geo_data/fetch_golf_course_holes.py \
  --course "Tenison Park Golf Course"
```

BlueGolf import + backend save:

```bash
python3 golf_course_hole_geo_data/fetch_bluegolf_course_data.py \
  --course-slug sherrillpark1 \
  --data-slug sherrill-park-golf-course-1 \
  --save-course
```

Example with stricter hole-only fetch:

```bash
python3 golf_course_hole_geo_data/fetch_golf_course_holes.py \
  --course "Tenison Park Golf Course" \
  --golf-tags hole
```

Example disabling non-golf water fetch:

```bash
python3 golf_course_hole_geo_data/fetch_golf_course_holes.py \
  --course "Tenison Park Golf Course" \
  --no-include-water
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
- `bluegolf_tee_green_coordinates.csv` (tee/green points by hole from BlueGolf overview)
- `bluegolf_tee_green_coordinates.json` (same as CSV in JSON form)
- `bluegolf_tee_green_points.geojson` (tee/green points as GeoJSON Features)
- `bluegolf_course_data.json` (course info + pars/stroke index parsed from detailed scorecard)
- `bluegolf_saved_course_payload.json` (payload for backend `POST /courses`)
- `bluegolf_backend_save_response.json` (present when `--save-course` succeeds)
- `courses_map_index.json` (all course folders + map availability status)


python3 golf_course_hole_geo_data/fetch_bluegolf_course_data.py   --course-slug keetonparkgc   --data-slug keeton-park-gc   --save-course
