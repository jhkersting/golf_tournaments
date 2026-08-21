import { getJson, putJson } from "./utils.js";

function projectedPointToLonLat(hole, point) {
  const x = Number(point?.x);
  const y = -Number(point?.y);
  const holeLon = Number(hole?.lon);
  const holeLat = Number(hole?.lat);
  const lon2x = Number(hole?.lon2x);
  const lat2y = Number(hole?.lat2y);
  if (![x, y, holeLon, holeLat, lon2x, lat2y].every(Number.isFinite) || !lon2x || !lat2y) {
    return { lat: null, lon: null };
  }
  return {
    lon: holeLon + (x / lon2x),
    lat: holeLat - (y / lat2y)
  };
}

function buildBlueGolfCoordinateRows(overviewPayload) {
  const rows = [];
  const holes = Array.isArray(overviewPayload?.holes) ? overviewPayload.holes : [];
  holes.forEach((hole, idx) => {
    const pointsByName = new Map((hole?.points || []).map((point) => [String(point?.name || ""), point]));
    const teePoint = pointsByName.get("tee");
    const teeCoords = teePoint ? projectedPointToLonLat(hole, teePoint) : { lat: null, lon: null };

    let greenFeature = null;
    for (const feature of hole?.features || []) {
      if (String(feature?.type || "").toLowerCase() === "green") {
        greenFeature = feature;
        break;
      }
    }

    const front = {
      lat: Number.isFinite(Number(greenFeature?.frontlat)) ? Number(greenFeature.frontlat) : null,
      lon: Number.isFinite(Number(greenFeature?.frontlon)) ? Number(greenFeature.frontlon) : null
    };
    const center = {
      lat: Number.isFinite(Number(greenFeature?.centerlat)) ? Number(greenFeature.centerlat) : null,
      lon: Number.isFinite(Number(greenFeature?.centerlon)) ? Number(greenFeature.centerlon) : null
    };
    const back = {
      lat: Number.isFinite(Number(greenFeature?.backlat)) ? Number(greenFeature.backlat) : null,
      lon: Number.isFinite(Number(greenFeature?.backlon)) ? Number(greenFeature.backlon) : null
    };

    if (front.lat == null && pointsByName.get("green_front")) Object.assign(front, projectedPointToLonLat(hole, pointsByName.get("green_front")));
    if (center.lat == null && pointsByName.get("green_center")) Object.assign(center, projectedPointToLonLat(hole, pointsByName.get("green_center")));
    if (back.lat == null && pointsByName.get("green_back")) Object.assign(back, projectedPointToLonLat(hole, pointsByName.get("green_back")));

    if (center.lat == null && front.lat != null) Object.assign(center, front);
    if (center.lat == null && back.lat != null) Object.assign(center, back);
    if (front.lat == null && center.lat != null) Object.assign(front, center);
    if (back.lat == null && center.lat != null) Object.assign(back, center);

    rows.push({
      hole: idx + 1,
      tee_lat: teeCoords.lat,
      tee_lon: teeCoords.lon,
      green_front_lat: front.lat,
      green_front_lon: front.lon,
      green_center_lat: center.lat,
      green_center_lon: center.lon,
      green_back_lat: back.lat,
      green_back_lon: back.lon
    });
  });
  return rows;
}

async function updateCourseMapIndex(publicBucket, entry) {
  const key = "course-data/courses_map_index.json";
  let current = null;
  try {
    const loaded = await getJson(publicBucket, key);
    current = loaded?.json || null;
  } catch (_) {
    current = null;
  }

  const next = current && typeof current === "object"
    ? current
    : {
        generated_at_utc: new Date().toISOString(),
        data_root: "course-data",
        course_count: 0,
        counts_by_map_level: { full: 0, simplified: 0, none: 0 },
        courses_by_slug: {},
        courses: []
      };

  const slug = String(entry?.slug || "").trim();
  if (!slug) return;

  next.courses_by_slug = next.courses_by_slug || {};
  next.courses = Array.isArray(next.courses) ? next.courses : [];

  next.courses_by_slug[slug] = {
    name: entry.name,
    map_level: "simplified",
    has_full_map: false,
    has_simplified_map: true
  };

  const filtered = next.courses.filter((course) => String(course?.slug || "").trim() !== slug);
  filtered.push({
    slug,
    name: entry.name,
    path: `course-data/${slug}`,
    map_level: "simplified",
    has_full_map: false,
    has_simplified_map: true,
    holes: {
      full_map_holes: null,
      simplified_map_holes: entry.holeCount || null
    },
    files: {
      course_geojson: false,
      hole_features_geojson: false,
      hole_index_json: false,
      bluegolf_coordinates_json: true,
      bluegolf_course_data_json: true
    }
  });
  filtered.sort((a, b) => String(a?.name || "").localeCompare(String(b?.name || "")));
  next.courses = filtered;
  next.course_count = filtered.length;
  next.counts_by_map_level = {
    full: filtered.filter((course) => course?.map_level === "full").length,
    simplified: filtered.filter((course) => course?.map_level === "simplified").length,
    none: filtered.filter((course) => course?.map_level === "none").length
  };
  next.generated_at_utc = new Date().toISOString();

  await putJson(publicBucket, key, next, {
    gzip: false,
    cacheControl: "public,max-age=300"
  });
}

export async function publishBlueGolfCourseMap(publicBucket, { courseId, courseData, overviewPayload }) {
  const slug = String(courseId || "").trim();
  if (!publicBucket || !slug || !courseData || !overviewPayload) return null;

  const coordinateRows = buildBlueGolfCoordinateRows(overviewPayload);
  const prefix = `course-data/${slug}`;
  await Promise.all([
    putJson(publicBucket, `${prefix}/bluegolf_tee_green_coordinates.json`, coordinateRows, {
      gzip: false,
      cacheControl: "public,max-age=300"
    }),
    putJson(publicBucket, `${prefix}/bluegolf_course_data.json`, courseData, {
      gzip: false,
      cacheControl: "public,max-age=300"
    })
  ]);

  await updateCourseMapIndex(publicBucket, {
    slug,
    name: String(courseData?.name || slug).trim() || slug,
    holeCount: coordinateRows.length
  });

  return {
    slug,
    holeCount: coordinateRows.length
  };
}
