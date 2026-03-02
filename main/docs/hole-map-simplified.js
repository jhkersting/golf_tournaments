const DATA_SLUG =
  new URLSearchParams(window.location.search).get("dataSlug") ||
  "sherrill-park-golf-course-1";
const DATA_BASE_CANDIDATES = [
  `../../golf_course_hole_geo_data/data/${DATA_SLUG}`,
  `/golf_tournaments/golf_course_hole_geo_data/data/${DATA_SLUG}`,
  `/golf_course_hole_geo_data/data/${DATA_SLUG}`,
];
const STREET_TILE_LIGHT_URL_TEMPLATE = "https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png";
const STREET_TILE_DARK_URL_TEMPLATE = "https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png";
const STREET_TILE_SUBDOMAINS = ["a", "b", "c", "d"];
const SATELLITE_TILE_URL_TEMPLATE =
  "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const USE_SATELLITE_BASEMAP = true;
const TILE_SIZE = 256;
const WEB_MERCATOR_MAX_LAT = 85.05112878;
const WEB_MERCATOR_RADIUS = 6378137;
const WEB_MERCATOR_WORLD_WIDTH = 2 * Math.PI * WEB_MERCATOR_RADIUS;
const WEB_MERCATOR_ORIGIN_SHIFT = WEB_MERCATOR_WORLD_WIDTH / 2;
const LOCATION_TIMEOUT_MS = 15000;
const LOCATION_FILTER_MAX_ACCURACY_M = 35;
const LOCATION_HARD_REJECT_ACCURACY_M = 70;
const LOCATION_SMOOTH_WINDOW_MS = 12000;
const LOCATION_SMOOTH_MAX_FIXES = 8;
const LOCATION_MIN_MOVEMENT_UPDATE_M = 2.5;
const LOCATION_BASE_JUMP_TOLERANCE_M = 12;
const LOCATION_MAX_REASONABLE_SPEED_MPS = 14;
const GEO_GRANTED_KEY = "hole-map:geo-granted";
const MAP_FOCUS_MAX_USER_DISTANCE_YARDS = 700;
const MAP_PROXIMITY_ZOOM_MAX_BOOST = 0.45;
const TAP_PREVIEW_DURATION_MS = 7000;

const state = {
  courseFeatures: [],
  holeFeatures: [],
  holes: [],
  holeMap: new Map(),
  bluegolfHoleMap: new Map(),
  bluegolfCourse: null,
  currentHole: null,
  userLocation: null,
  locationAccuracyM: null,
  locationError: "",
  locationWatchId: null,
  locationFixes: [],
  lastAcceptedLocationFix: null,
  locationPending: false,
  locationPermissionGranted: false,
  tapPoint: null,
  tapPreviewTimerId: null,
  lastProjection: null,
  lastCanvasLogicalSize: null,
  dataBase: null,
  renderNonce: 0,
  tileImageCache: new Map(),
};

const els = {
  holeSelect: document.getElementById("hole_select"),
  holePrev: document.getElementById("hole_prev"),
  holeNext: document.getElementById("hole_next"),
  locBtn: document.getElementById("loc_btn"),
  locClear: document.getElementById("loc_clear"),
  metricSummary: document.getElementById("metric_summary"),
  metricToPointHead: document.getElementById("metric_to_point_head"),
  metricToPointRow: document.getElementById("metric_to_point_row"),
  metricToPoint: document.getElementById("metric_to_point"),
  metricFront: document.getElementById("metric_front"),
  metricCenter: document.getElementById("metric_center"),
  metricBack: document.getElementById("metric_back"),
  yardageDetail: document.getElementById("yardage_detail"),
  holeCanvas: document.getElementById("hole_canvas"),
  holeEmpty: document.getElementById("hole_empty"),
};

function parseHoleRef(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const match = raw.match(/\d{1,2}/);
  if (!match) return null;
  const hole = Number(match[0]);
  return Number.isFinite(hole) ? hole : null;
}

function toRad(value) {
  return (value * Math.PI) / 180;
}

function toDeg(value) {
  return (value * 180) / Math.PI;
}

function lonLatToMercator([lon, lat]) {
  const safeLat = Math.max(-WEB_MERCATOR_MAX_LAT, Math.min(WEB_MERCATOR_MAX_LAT, Number(lat)));
  const x = WEB_MERCATOR_RADIUS * toRad(Number(lon));
  const y =
    WEB_MERCATOR_RADIUS * Math.log(Math.tan(Math.PI / 4 + toRad(safeLat) / 2));
  return [x, y];
}

function mercatorToLonLat([x, y]) {
  const lon = toDeg(Number(x) / WEB_MERCATOR_RADIUS);
  const lat = toDeg(2 * Math.atan(Math.exp(Number(y) / WEB_MERCATOR_RADIUS)) - Math.PI / 2);
  return [lon, lat];
}

function distanceYards(a, b) {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const r = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const lat1Rad = toRad(lat1);
  const lat2Rad = toRad(lat2);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.sin(dLon / 2) ** 2;
  const meters = 2 * r * Math.asin(Math.sqrt(h));
  return meters * 1.0936133;
}

function distanceMeters(a, b) {
  return distanceYards(a, b) / 1.0936133;
}

function readLonLatFromRow(row, prefix) {
  const lat = Number(row?.[`${prefix}_lat`]);
  const lon = Number(row?.[`${prefix}_lon`]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return [lon, lat];
}

function collectPositions(geometry, out) {
  if (!geometry || !geometry.type) return;
  const type = geometry.type;
  const coords = geometry.coordinates;
  if (!coords) return;

  if (type === "Point") {
    if (Array.isArray(coords) && coords.length === 2) out.push(coords);
    return;
  }

  if (type === "MultiPoint" || type === "LineString") {
    for (const point of coords) {
      if (Array.isArray(point) && point.length === 2) out.push(point);
    }
    return;
  }

  if (type === "MultiLineString" || type === "Polygon") {
    for (const line of coords) {
      if (!Array.isArray(line)) continue;
      for (const point of line) {
        if (Array.isArray(point) && point.length === 2) out.push(point);
      }
    }
    return;
  }

  if (type === "MultiPolygon") {
    for (const poly of coords) {
      if (!Array.isArray(poly)) continue;
      for (const ring of poly) {
        if (!Array.isArray(ring)) continue;
        for (const point of ring) {
          if (Array.isArray(point) && point.length === 2) out.push(point);
        }
      }
    }
  }
}

function centroidFromPoints(points) {
  if (!points.length) return null;
  let sumLon = 0;
  let sumLat = 0;
  for (const [lon, lat] of points) {
    sumLon += Number(lon);
    sumLat += Number(lat);
  }
  return [sumLon / points.length, sumLat / points.length];
}

function featureCentroid(feature) {
  const points = [];
  collectPositions(feature?.geometry, points);
  return centroidFromPoints(points);
}

function ringArea(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area / 2);
}

function featureArea(feature) {
  const geom = feature?.geometry;
  if (!geom) return 0;

  if (geom.type === "Polygon") {
    return Array.isArray(geom.coordinates)
      ? geom.coordinates.reduce((sum, ring) => sum + ringArea(ring), 0)
      : 0;
  }

  if (geom.type === "MultiPolygon") {
    if (!Array.isArray(geom.coordinates)) return 0;
    let total = 0;
    for (const poly of geom.coordinates) {
      if (!Array.isArray(poly)) continue;
      total += poly.reduce((sum, ring) => sum + ringArea(ring), 0);
    }
    return total;
  }

  return 0;
}

function firstLinePoint(feature) {
  const geom = feature?.geometry;
  if (!geom) return null;
  if (geom.type === "LineString") {
    return Array.isArray(geom.coordinates?.[0]) ? geom.coordinates[0] : null;
  }
  if (geom.type === "MultiLineString") {
    const firstLine = geom.coordinates?.[0];
    return Array.isArray(firstLine?.[0]) ? firstLine[0] : null;
  }
  return null;
}

function lastLinePoint(feature) {
  const geom = feature?.geometry;
  if (!geom) return null;
  if (geom.type === "LineString") {
    const coords = geom.coordinates || [];
    const p = coords[coords.length - 1];
    return Array.isArray(p) ? p : null;
  }
  if (geom.type === "MultiLineString") {
    const lines = geom.coordinates || [];
    const line = lines[lines.length - 1] || [];
    const p = line[line.length - 1];
    return Array.isArray(p) ? p : null;
  }
  return null;
}

function createAlignedProjector(
  features,
  extraPoints,
  alignmentStart,
  alignmentEnd,
  width,
  height,
  padding,
  zoomMultiplier = 1
) {
  const allPoints = [];
  for (const feature of features) collectPositions(feature?.geometry, allPoints);
  for (const point of extraPoints || []) {
    if (Array.isArray(point) && point.length === 2) allPoints.push(point);
  }
  if (!allPoints.length) return null;

  const allPointsMercator = allPoints.map((point) => lonLatToMercator(point));

  let sumX = 0;
  let sumY = 0;
  for (const [x, y] of allPointsMercator) {
    sumX += x;
    sumY += y;
  }
  const centerX = sumX / allPointsMercator.length;
  const centerY = sumY / allPointsMercator.length;

  const toLocal = ([lon, lat]) => {
    const [mx, my] = lonLatToMercator([lon, lat]);
    return [mx - centerX, my - centerY];
  };

  let rotationRad = 0;
  if (Array.isArray(alignmentStart) && Array.isArray(alignmentEnd)) {
    const [sx, sy] = toLocal(alignmentStart);
    const [ex, ey] = toLocal(alignmentEnd);
    const dx = ex - sx;
    const dy = ey - sy;
    if (Math.hypot(dx, dy) > 1e-10) {
      rotationRad = Math.PI / 2 - Math.atan2(dy, dx);
    }
  }

  const cosA = Math.cos(rotationRad);
  const sinA = Math.sin(rotationRad);
  const rotate = ([x, y]) => [x * cosA - y * sinA, x * sinA + y * cosA];

  const rotated = allPoints.map((point) => rotate(toLocal(point)));

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of rotated) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const w = Math.max(1e-9, maxX - minX);
  const h = Math.max(1e-9, maxY - minY);
  const innerW = Math.max(1, width - padding * 2);
  const innerH = Math.max(1, height - padding * 2);
  const baseScale = Math.min(innerW / w, innerH / h);
  const safeZoom = Number.isFinite(zoomMultiplier) ? Math.max(1, zoomMultiplier) : 1;
  const scale = baseScale * safeZoom;
  const drawW = w * scale;
  const drawH = h * scale;
  const offsetX = (width - drawW) / 2;
  const offsetY = (height - drawH) / 2;

  const projectMercator = ([mx, my]) => {
    const lx = Number(mx) - centerX;
    const ly = Number(my) - centerY;
    const [rx, ry] = rotate([lx, ly]);
    const x = offsetX + (rx - minX) * scale;
    const y = height - (offsetY + (ry - minY) * scale);
    return [x, y];
  };

  const project = (point) => {
    const [mx, my] = lonLatToMercator(point);
    return projectMercator([mx, my]);
  };

  const unproject = (screenPoint) => {
    if (!Array.isArray(screenPoint) || screenPoint.length < 2) return null;
    const [x, y] = screenPoint;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

    const rx = (x - offsetX) / scale + minX;
    const ry = (height - y - offsetY) / scale + minY;
    const lx = rx * cosA + ry * sinA;
    const ly = -rx * sinA + ry * cosA;
    const mx = lx + centerX;
    const my = ly + centerY;
    const [lon, lat] = mercatorToLonLat([mx, my]);

    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    return [lon, lat];
  };

  const rotationDeg = (rotationRad * 180) / Math.PI;
  return { project, projectMercator, unproject, rotationRad, rotationDeg };
}

function mercatorToWorldPixels([mx, my], zoom) {
  const scale = (TILE_SIZE * (2 ** zoom)) / WEB_MERCATOR_WORLD_WIDTH;
  const x = (mx + WEB_MERCATOR_ORIGIN_SHIFT) * scale;
  const y = (WEB_MERCATOR_ORIGIN_SHIFT - my) * scale;
  return [x, y];
}

function worldPixelsToMercator([x, y], zoom) {
  const invScale = WEB_MERCATOR_WORLD_WIDTH / (TILE_SIZE * (2 ** zoom));
  const mx = Number(x) * invScale - WEB_MERCATOR_ORIGIN_SHIFT;
  const my = WEB_MERCATOR_ORIGIN_SHIFT - Number(y) * invScale;
  return [mx, my];
}

function normalizeTileX(x, zoom) {
  const count = 2 ** zoom;
  return ((x % count) + count) % count;
}

function tileUrl(template, z, x, y) {
  const subdomain = STREET_TILE_SUBDOMAINS[Math.abs(x + y) % STREET_TILE_SUBDOMAINS.length];
  return template
    .replace("{s}", subdomain)
    .replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));
}

function loadTileImage(url) {
  if (state.tileImageCache.has(url)) return state.tileImageCache.get(url);
  const promise = new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Tile failed: ${url}`));
    image.src = url;
  });
  state.tileImageCache.set(url, promise);
  return promise;
}

function buildTileFrame(projection, width, height, overscan) {
  if (!projection?.unproject) return null;
  const corners = [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ]
    .map((pt) => projection.unproject(pt))
    .filter((pt) => Array.isArray(pt) && Number.isFinite(pt[0]) && Number.isFinite(pt[1]));
  if (corners.length < 2) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const lonLat of corners) {
    const [mx, my] = lonLatToMercator(lonLat);
    if (mx < minX) minX = mx;
    if (mx > maxX) maxX = mx;
    if (my < minY) minY = my;
    if (my > maxY) maxY = my;
  }

  const padX = Math.max(2, (maxX - minX) * 0.03);
  const padY = Math.max(2, (maxY - minY) * 0.03);
  minX -= padX;
  maxX += padX;
  minY -= padY;
  maxY += padY;

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const halfX = ((maxX - minX) / 2) * overscan;
  const halfY = ((maxY - minY) / 2) * overscan;

  return {
    minX: centerX - halfX,
    maxX: centerX + halfX,
    minY: centerY - halfY,
    maxY: centerY + halfY,
  };
}

function chooseTileZoom(frame, width, height) {
  const targetW = Math.max(1, width);
  const targetH = Math.max(1, height);
  const mppX = (frame.maxX - frame.minX) / targetW;
  const mppY = (frame.maxY - frame.minY) / targetH;
  const mpp = Math.max(mppX, mppY, 0.01);
  const raw = Math.log2(WEB_MERCATOR_WORLD_WIDTH / (TILE_SIZE * mpp));
  return Math.max(2, Math.min(20, Math.round(raw)));
}

function isDarkThemeActive() {
  const rootTheme = document.documentElement.getAttribute("data-theme") || "";
  const bodyTheme = document.body?.getAttribute("data-theme") || "";
  const lowRoot = rootTheme.toLowerCase();
  const lowBody = bodyTheme.toLowerCase();
  if (lowRoot.includes("dark") || lowBody.includes("dark")) return true;
  if (lowRoot.includes("light") || lowBody.includes("light")) return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? false;
}

function drawGeometryPath(ctx, geometry, project) {
  if (!geometry?.type) return false;
  let drew = false;
  const moveLine = (coords, close) => {
    if (!Array.isArray(coords) || !coords.length) return;
    for (let i = 0; i < coords.length; i += 1) {
      const [x, y] = project(coords[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      drew = true;
    }
    if (close) ctx.closePath();
  };

  if (geometry.type === "LineString") {
    moveLine(geometry.coordinates || [], false);
  } else if (geometry.type === "MultiLineString") {
    for (const line of geometry.coordinates || []) moveLine(line, false);
  } else if (geometry.type === "Polygon") {
    for (const ring of geometry.coordinates || []) moveLine(ring, true);
  } else if (geometry.type === "MultiPolygon") {
    for (const poly of geometry.coordinates || []) {
      for (const ring of poly || []) moveLine(ring, true);
    }
  }
  return drew;
}

async function drawStreetTileBackground(ctx, projection, width, height, nonce, pixelRatio) {
  const overscan = 1.58;
  const frame = buildTileFrame(projection, width, height, overscan);
  if (!frame) return;

  const zoom = chooseTileZoom(frame, width * overscan, height * overscan);
  const template = USE_SATELLITE_BASEMAP
    ? SATELLITE_TILE_URL_TEMPLATE
    : (isDarkThemeActive() ? STREET_TILE_DARK_URL_TEMPLATE : STREET_TILE_LIGHT_URL_TEMPLATE);

  const [leftPx, topPx] = mercatorToWorldPixels([frame.minX, frame.maxY], zoom);
  const [rightPx, bottomPx] = mercatorToWorldPixels([frame.maxX, frame.minY], zoom);

  const minTileX = Math.floor(leftPx / TILE_SIZE);
  const maxTileX = Math.floor((rightPx - 1) / TILE_SIZE);
  const minTileY = Math.floor(topPx / TILE_SIZE);
  const maxTileY = Math.floor((bottomPx - 1) / TILE_SIZE);
  const tileRows = 2 ** zoom;

  const tileJobs = [];
  for (let ty = minTileY; ty <= maxTileY; ty += 1) {
    if (ty < 0 || ty >= tileRows) continue;
    for (let tx = minTileX; tx <= maxTileX; tx += 1) {
      const wrappedX = normalizeTileX(tx, zoom);
      const url = tileUrl(template, zoom, wrappedX, ty);
      tileJobs.push(
        loadTileImage(url)
          .then((image) => ({ image, tx, ty }))
          .catch(() => null)
      );
    }
  }

  const loaded = await Promise.all(tileJobs);
  if (nonce !== state.renderNonce) return;
  if (!projection?.projectMercator) return;

  const anchorWorld = [leftPx, topPx];
  const anchorMerc = worldPixelsToMercator(anchorWorld, zoom);
  const unitXMerc = worldPixelsToMercator([leftPx + 1, topPx], zoom);
  const unitYMerc = worldPixelsToMercator([leftPx, topPx + 1], zoom);

  const origin = projection.projectMercator(anchorMerc);
  const pxX = projection.projectMercator(unitXMerc);
  const pxY = projection.projectMercator(unitYMerc);
  if (!origin || !pxX || !pxY) return;

  const a = pxX[0] - origin[0];
  const b = pxX[1] - origin[1];
  const c = pxY[0] - origin[0];
  const d = pxY[1] - origin[1];
  const e = origin[0];
  const f = origin[1];
  const deviceScale =
    Number.isFinite(pixelRatio) && Number(pixelRatio) > 0
      ? Number(pixelRatio)
      : 1;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();
  ctx.setTransform(
    a * deviceScale,
    b * deviceScale,
    c * deviceScale,
    d * deviceScale,
    e * deviceScale,
    f * deviceScale
  );
  for (const tile of loaded) {
    if (!tile?.image) continue;
    const dx = tile.tx * TILE_SIZE - leftPx;
    const dy = tile.ty * TILE_SIZE - topPx;
    ctx.drawImage(tile.image, dx, dy, TILE_SIZE, TILE_SIZE);
  }
  ctx.restore();
}

function greenForHole(features) {
  const greens = features.filter((f) => String(f?.properties?.golf || "") === "green");
  if (!greens.length) return null;
  greens.sort((a, b) => featureArea(b) - featureArea(a));
  return greens[0];
}

function holeLineForHole(features) {
  return features.find((f) => String(f?.properties?.golf || "") === "hole") || null;
}

function backTeeForHole(features, greenCenter, holeLine) {
  const tees = features
    .filter((f) => String(f?.properties?.golf || "") === "tee")
    .map((feature) => ({ center: featureCentroid(feature) }))
    .filter((item) => Array.isArray(item.center));

  if (tees.length && Array.isArray(greenCenter)) {
    tees.sort((a, b) => distanceYards(b.center, greenCenter) - distanceYards(a.center, greenCenter));
    return tees[0].center;
  }
  if (tees.length) return tees[0].center;

  const fromHole = firstLinePoint(holeLine);
  return Array.isArray(fromHole) ? fromHole : null;
}

function greenFrontBackPoints(greenFeature, backTee, holeLine) {
  const center = featureCentroid(greenFeature);
  if (!greenFeature) return { front: null, center: null, back: null };

  const pts = [];
  collectPositions(greenFeature.geometry, pts);
  if (!pts.length) {
    return { front: center, center, back: center };
  }

  let teeRef = Array.isArray(backTee) ? backTee : firstLinePoint(holeLine);
  if (!Array.isArray(teeRef)) teeRef = center;
  if (!Array.isArray(teeRef)) return { front: center, center, back: center };

  let front = pts[0];
  let back = pts[0];
  let minDist = Infinity;
  let maxDist = -Infinity;
  for (const point of pts) {
    const d = distanceYards(teeRef, point);
    if (d < minDist) {
      minDist = d;
      front = point;
    }
    if (d > maxDist) {
      maxDist = d;
      back = point;
    }
  }

  return {
    front: front || center,
    center,
    back: back || center,
  };
}

function holePar(features) {
  for (const feature of features) {
    if (String(feature?.properties?.golf || "") !== "hole") continue;
    const value = Number(feature?.properties?.par);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function updateLocationStatus(text) {
  void text;
}

function secureContextMessage() {
  if (window.isSecureContext) return "";
  return "Location requires HTTPS or localhost. Open this page via https:// (not file:// or plain http://).";
}

function formatYards(value) {
  return Number.isFinite(value) ? String(Math.round(value)) : "—";
}

function setMetricValue(el, primaryValue, secondaryValue) {
  if (!el) return;
  const primary = formatYards(primaryValue);
  if (!Number.isFinite(secondaryValue)) {
    el.textContent = primary;
    return;
  }
  const secondary = formatYards(secondaryValue);
  el.innerHTML = `${primary} <span class="hole-map-footer-sub">(${secondary})</span>`;
}

function clearTapPreviewTimer() {
  if (state.tapPreviewTimerId == null) return;
  clearTimeout(state.tapPreviewTimerId);
  state.tapPreviewTimerId = null;
}

function getCanvasConfig() {
  if (window.matchMedia("(max-width: 560px)").matches) {
    return { width: 1200, height: 2200, margin: 60 };
  }
  return { width: 1200, height: 760, margin: 52 };
}

function readGeolocationGrant() {
  try {
    return localStorage.getItem(GEO_GRANTED_KEY) === "1";
  } catch (_) {
    return false;
  }
}

function persistGeolocationGrant(granted) {
  try {
    localStorage.setItem(GEO_GRANTED_KEY, granted ? "1" : "0");
  } catch (_) {
    // ignore
  }
}

function updateTrackingButton() {
  const hasSharedLocation =
    state.locationPermissionGranted || Array.isArray(state.userLocation) || state.locationWatchId != null;

  if (els.locBtn) {
    els.locBtn.style.display = hasSharedLocation ? "none" : "";
    els.locBtn.disabled = Boolean(state.locationPending);
    els.locBtn.textContent = state.locationPending ? "Locating..." : "Use My Location";
  }

  if (els.locClear) {
    els.locClear.style.display = hasSharedLocation ? "" : "none";
    els.locClear.disabled = Boolean(state.locationPending);
  }
}

function parseLocationFix(position) {
  const lon = Number(position?.coords?.longitude);
  const lat = Number(position?.coords?.latitude);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;

  const accuracyRaw = Number(position?.coords?.accuracy);
  const speedRaw = Number(position?.coords?.speed);
  const timestampRaw = Number(position?.timestamp);

  return {
    coords: [lon, lat],
    accuracyM: Number.isFinite(accuracyRaw) ? accuracyRaw : Infinity,
    speedMps: Number.isFinite(speedRaw) && speedRaw >= 0 ? speedRaw : null,
    tsMs: Number.isFinite(timestampRaw) ? timestampRaw : Date.now(),
  };
}

function pruneLocationFixes(nowMs) {
  state.locationFixes = state.locationFixes
    .filter((fix) => nowMs - fix.tsMs <= LOCATION_SMOOTH_WINDOW_MS)
    .slice(-LOCATION_SMOOTH_MAX_FIXES);
}

function smoothedLocationFromFixes(nowMs) {
  if (!state.locationFixes.length) return null;

  let sumLon = 0;
  let sumLat = 0;
  let sumWeight = 0;

  for (const fix of state.locationFixes) {
    const ageMs = Math.max(0, nowMs - fix.tsMs);
    const acc = Math.max(3, fix.accuracyM);
    const accWeight = 1 / (acc * acc);
    const recencyWeight = Math.exp(-ageMs / (LOCATION_SMOOTH_WINDOW_MS * 0.6));
    const weight = accWeight * recencyWeight;
    sumLon += fix.coords[0] * weight;
    sumLat += fix.coords[1] * weight;
    sumWeight += weight;
  }

  if (sumWeight <= 0) return state.locationFixes[state.locationFixes.length - 1].coords;
  return [sumLon / sumWeight, sumLat / sumWeight];
}

function isLocationOutlier(candidateFix) {
  const prevFix = state.lastAcceptedLocationFix;
  if (!prevFix) return false;

  const dtSec = Math.max(0.5, (candidateFix.tsMs - prevFix.tsMs) / 1000);
  const distM = distanceMeters(candidateFix.coords, prevFix.coords);
  const speedBudgetMps = Number.isFinite(candidateFix.speedMps)
    ? Math.min(candidateFix.speedMps, LOCATION_MAX_REASONABLE_SPEED_MPS)
    : LOCATION_MAX_REASONABLE_SPEED_MPS;
  const toleranceM =
    LOCATION_BASE_JUMP_TOLERANCE_M +
    speedBudgetMps * dtSec +
    Math.max(candidateFix.accuracyM, prevFix.accuracyM);

  return distM > toleranceM;
}

function canvasPointFromEvent(event) {
  if (!els.holeCanvas) return null;
  const rect = els.holeCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;

  const point = event?.changedTouches?.[0] || event?.touches?.[0] || event;
  const clientX = Number(point?.clientX);
  const clientY = Number(point?.clientY);
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;

  const logicalWidth = Number(state.lastCanvasLogicalSize?.width) || els.holeCanvas.width;
  const logicalHeight = Number(state.lastCanvasLogicalSize?.height) || els.holeCanvas.height;
  const x = ((clientX - rect.left) / rect.width) * logicalWidth;
  const y = ((clientY - rect.top) / rect.height) * logicalHeight;
  return [x, y];
}

function handleHoleTap(event) {
  if (!state.lastProjection?.unproject) return;
  const canvasPoint = canvasPointFromEvent(event);
  if (!canvasPoint) return;
  const mapPoint = state.lastProjection.unproject(canvasPoint);
  if (!Array.isArray(mapPoint)) return;
  clearTapPreviewTimer();
  state.tapPoint = mapPoint;
  state.tapPreviewTimerId = window.setTimeout(() => {
    state.tapPreviewTimerId = null;
    if (!Array.isArray(state.tapPoint)) return;
    state.tapPoint = null;
    renderCurrentHole();
  }, TAP_PREVIEW_DURATION_MS);
  renderCurrentHole();
}

function stopLocationTracking(clearLocation, statusText) {
  if (state.locationWatchId != null && "geolocation" in navigator) {
    navigator.geolocation.clearWatch(state.locationWatchId);
    state.locationWatchId = null;
  }
  state.locationPending = false;

  if (clearLocation) {
    state.userLocation = null;
    state.locationAccuracyM = null;
    state.locationFixes = [];
    state.lastAcceptedLocationFix = null;
    state.locationError = "";
    state.locationPermissionGranted = false;
    persistGeolocationGrant(false);
  }

  if (statusText) updateLocationStatus(statusText);
  updateTrackingButton();
}

function applyLocationFix(position) {
  const fix = parseLocationFix(position);
  if (!fix) {
    state.locationError = "Location received, but coordinates were invalid.";
    updateLocationStatus(state.locationError);
    updateTrackingButton();
    renderCurrentHole();
    return;
  }

  state.locationAccuracyM = Number.isFinite(fix.accuracyM) ? fix.accuracyM : null;
  state.locationError = "";
  state.locationPermissionGranted = true;
  persistGeolocationGrant(true);

  if (!Number.isFinite(fix.accuracyM) || fix.accuracyM > LOCATION_HARD_REJECT_ACCURACY_M) {
    updateLocationStatus(
      `GPS accuracy too low (${Math.round(fix.accuracyM)}m). Waiting for a better fix.`
    );
    updateTrackingButton();
    renderCurrentHole();
    return;
  }

  if (isLocationOutlier(fix)) {
    updateLocationStatus("Ignoring outlier GPS jump. Waiting for stable fix.");
    updateTrackingButton();
    renderCurrentHole();
    return;
  }

  if (fix.accuracyM <= LOCATION_FILTER_MAX_ACCURACY_M) {
    state.lastAcceptedLocationFix = fix;
    state.locationFixes.push(fix);
    pruneLocationFixes(fix.tsMs);
  }

  const smoothed = smoothedLocationFromFixes(fix.tsMs) || fix.coords;
  if (!Array.isArray(state.userLocation)) {
    state.userLocation = smoothed;
  } else {
    const deltaM = distanceMeters(state.userLocation, smoothed);
    if (deltaM >= LOCATION_MIN_MOVEMENT_UPDATE_M) {
      state.userLocation = smoothed;
    }
  }

  updateLocationStatus(
    `Tracking precise location (${Math.round(fix.accuracyM)}m, filtered).`
  );
  updateTrackingButton();
  renderCurrentHole();
}

function handleLocationFailure(error) {
  const codeMap = {
    1: "Location permission was denied.",
    2: "Location is unavailable.",
    3: "Location request timed out.",
  };
  const base = codeMap[error?.code] || "Could not get current location.";
  const detail = error?.message ? ` ${error.message}` : "";
  state.locationError = `${base}${detail}`.trim();

  if (error?.code === 1) {
    state.locationPermissionGranted = false;
    persistGeolocationGrant(false);
    stopLocationTracking(false, state.locationError);
  } else {
    updateLocationStatus(state.locationError);
    updateTrackingButton();
  }

  renderCurrentHole();
}

function startLocationTracking() {
  const secureMsg = secureContextMessage();
  if (secureMsg) {
    state.locationError = secureMsg;
    updateLocationStatus(secureMsg);
    renderCurrentHole();
    return;
  }

  if (!("geolocation" in navigator)) {
    state.locationError = "This browser does not support geolocation.";
    updateLocationStatus(state.locationError);
    renderCurrentHole();
    return;
  }

  if (state.locationWatchId != null) {
    navigator.geolocation.clearWatch(state.locationWatchId);
    state.locationWatchId = null;
  }

  state.locationFixes = [];
  state.lastAcceptedLocationFix = null;
  state.locationPending = true;
  state.locationError = "";
  updateLocationStatus("Acquiring precise GPS...");
  try {
    state.locationWatchId = navigator.geolocation.watchPosition(
      (position) => {
        state.locationPending = false;
        applyLocationFix(position);
      },
      (error) => {
        state.locationPending = false;
        handleLocationFailure(error);
      },
      {
        enableHighAccuracy: true,
        timeout: LOCATION_TIMEOUT_MS,
        maximumAge: 0,
      }
    );
  } catch (error) {
    state.locationPending = false;
    state.locationError = `Could not start location watch. ${error?.message || ""}`.trim();
    updateLocationStatus(state.locationError);
  }
  updateTrackingButton();
}

async function maybeAutoStartTracking() {
  const secureMsg = secureContextMessage();
  if (secureMsg) return;
  if (!("geolocation" in navigator)) return;

  const savedGranted = readGeolocationGrant();

  if (navigator.permissions?.query) {
    try {
      const perm = await navigator.permissions.query({ name: "geolocation" });

      if (perm.state === "granted") {
        state.locationPermissionGranted = true;
        persistGeolocationGrant(true);
        startLocationTracking();
      } else if (savedGranted) {
        // Older browser state may still prompt, but this preserves continuous behavior after prior grant.
        startLocationTracking();
      }

      if (typeof perm.onchange !== "undefined") {
        perm.onchange = () => {
          if (perm.state === "granted") {
            state.locationPermissionGranted = true;
            persistGeolocationGrant(true);
            startLocationTracking();
            return;
          }
          if (perm.state === "denied") {
            state.locationPermissionGranted = false;
            persistGeolocationGrant(false);
            stopLocationTracking(false, "Location permission was denied.");
            renderCurrentHole();
          }
        };
      }

      updateTrackingButton();
      return;
    } catch (_) {
      // Fall through to local hint.
    }
  }

  if (savedGranted) startLocationTracking();
  updateTrackingButton();
}

async function renderCurrentHole() {
  const hole = state.currentHole;
  updateHoleNavControls();
  const holeData = state.bluegolfHoleMap.get(hole) || null;
  const parsedPar = Number(state.bluegolfCourse?.pars?.[Number(hole) - 1]);
  const par = Number.isFinite(parsedPar) ? parsedPar : null;

  const backTee = readLonLatFromRow(holeData, "tee");
  const greenTargets = {
    front: readLonLatFromRow(holeData, "green_front"),
    center: readLonLatFromRow(holeData, "green_center"),
    back: readLonLatFromRow(holeData, "green_back"),
  };
  if (!Array.isArray(greenTargets.front)) greenTargets.front = greenTargets.center || greenTargets.back;
  if (!Array.isArray(greenTargets.back)) greenTargets.back = greenTargets.center || greenTargets.front;

  let baseSourceLabel = "Not Set";
  let basePoint = null;

  if (Array.isArray(state.userLocation)) {
    baseSourceLabel = "My Location";
    basePoint = state.userLocation;
  } else if (Array.isArray(backTee)) {
    baseSourceLabel = "Back Tee Default";
    basePoint = backTee;
  }

  const usingTapPoint = Array.isArray(state.tapPoint);
  const sourceLabel = usingTapPoint ? "Tap Point" : baseSourceLabel;
  const metricPoint = usingTapPoint ? state.tapPoint : basePoint;

  const yardsFront =
    Array.isArray(metricPoint) && Array.isArray(greenTargets.front)
      ? distanceYards(metricPoint, greenTargets.front)
      : null;
  const yardsCenter =
    Array.isArray(metricPoint) && Array.isArray(greenTargets.center)
      ? distanceYards(metricPoint, greenTargets.center)
      : null;
  const yardsBack =
    Array.isArray(metricPoint) && Array.isArray(greenTargets.back)
      ? distanceYards(metricPoint, greenTargets.back)
      : null;
  const userYardsFront =
    Array.isArray(state.userLocation) && Array.isArray(greenTargets.front)
      ? distanceYards(state.userLocation, greenTargets.front)
      : null;
  const userYardsCenter =
    Array.isArray(state.userLocation) && Array.isArray(greenTargets.center)
      ? distanceYards(state.userLocation, greenTargets.center)
      : null;
  const userYardsBack =
    Array.isArray(state.userLocation) && Array.isArray(greenTargets.back)
      ? distanceYards(state.userLocation, greenTargets.back)
      : null;

  const userToGreenCenterYards =
    Array.isArray(state.userLocation) && Array.isArray(greenTargets.center)
      ? distanceYards(state.userLocation, greenTargets.center)
      : null;
  const mapShouldFocusHole =
    Number.isFinite(userToGreenCenterYards) && userToGreenCenterYards > MAP_FOCUS_MAX_USER_DISTANCE_YARDS;
  const mapPlayerPoint = mapShouldFocusHole ? null : basePoint;
  const proximityZoomMultiplier = (() => {
    if (!Number.isFinite(userToGreenCenterYards) || mapShouldFocusHole) return 1;
    const nearFactor = Math.max(
      0,
      Math.min(1, (MAP_FOCUS_MAX_USER_DISTANCE_YARDS - userToGreenCenterYards) / MAP_FOCUS_MAX_USER_DISTANCE_YARDS)
    );
    return 1 + nearFactor * MAP_PROXIMITY_ZOOM_MAX_BOOST;
  })();
  const tapToGreenCenterYards =
    Array.isArray(state.tapPoint) && Array.isArray(greenTargets.center)
      ? distanceYards(state.tapPoint, greenTargets.center)
      : null;
  const userToTapYards =
    Array.isArray(state.tapPoint) && Array.isArray(state.userLocation)
      ? distanceYards(state.userLocation, state.tapPoint)
      : null;
  const showToPoint = usingTapPoint && Number.isFinite(userToTapYards);

  if (els.metricSummary) {
    els.metricSummary.textContent = `Hole ${hole == null ? "—" : String(hole)} | Par ${par == null ? "—" : String(par)}`;
  }
  if (els.metricToPointHead) els.metricToPointHead.style.display = showToPoint ? "" : "none";
  if (els.metricToPointRow) els.metricToPointRow.style.display = showToPoint ? "" : "none";
  if (els.metricToPoint) {
    els.metricToPoint.textContent = showToPoint ? formatYards(userToTapYards) : "—";
  }
  setMetricValue(els.metricFront, yardsFront, usingTapPoint ? userYardsFront : null);
  setMetricValue(els.metricCenter, yardsCenter, usingTapPoint ? userYardsCenter : null);
  setMetricValue(els.metricBack, yardsBack, usingTapPoint ? userYardsBack : null);

  let detailText = "";
  if (state.locationError) {
    detailText = state.locationError;
  } else if (sourceLabel === "My Location") {
    detailText = "Live yardages from your location.";
  } else if (sourceLabel === "Back Tee Default") {
    detailText = "Showing back-tee yardages by default.";
  } else if (sourceLabel === "Tap Point") {
    detailText = "Showing front, center, and back yardages from your tapped spot.";
  } else {
    detailText = "No location or tee reference available for this hole.";
  }

  if (Number.isFinite(tapToGreenCenterYards)) {
    detailText = `Tap: ${Math.round(tapToGreenCenterYards)}y to center green.`;
  } else if (!state.locationError) {
    detailText = `${detailText} Tap map to set a yardage source.`.trim();
  }
  if (els.yardageDetail) {
    els.yardageDetail.textContent = detailText;
  }

  if (!holeData || !greenTargets.center) {
    state.lastProjection = null;
    els.holeEmpty.style.display = "";
    return;
  }
  els.holeEmpty.style.display = "none";

  const alignmentStart = backTee || greenTargets.front || greenTargets.center || null;
  const alignmentEnd = greenTargets.center || greenTargets.back || greenTargets.front || null;

  const extraPoints = [
    backTee,
    greenTargets.front,
    greenTargets.center,
    greenTargets.back,
    mapPlayerPoint,
  ];

  const { width, height, margin } = getCanvasConfig();
  if (!els.holeCanvas) return;
  const pixelRatio = Math.max(1, Math.min(3, Number(window.devicePixelRatio) || 1));
  state.lastCanvasLogicalSize = { width, height };
  els.holeCanvas.width = Math.round(width * pixelRatio);
  els.holeCanvas.height = Math.round(height * pixelRatio);
  const ctx = els.holeCanvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const projection = createAlignedProjector(
    [],
    extraPoints,
    alignmentStart,
    alignmentEnd,
    width,
    height,
    margin,
    proximityZoomMultiplier
  );

  if (!projection) {
    state.lastProjection = null;
    els.holeEmpty.style.display = "";
    return;
  }

  state.lastProjection = projection;
  const { project } = projection;
  const renderNonce = ++state.renderNonce;
  const darkTheme = isDarkThemeActive();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = darkTheme ? "#202225" : "#e9ebef";
  ctx.fillRect(0, 0, width, height);
  await drawStreetTileBackground(ctx, projection, width, height, renderNonce, pixelRatio);
  if (renderNonce !== state.renderNonce) return;

  const strokeDefault = darkTheme ? "rgba(243,248,255,0.95)" : "rgba(18,34,54,0.95)";

  if (Array.isArray(backTee)) {
    const [tx, ty] = project(backTee);
    ctx.beginPath();
    ctx.arc(tx, ty, 7, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.strokeStyle = "#567037";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  if (Array.isArray(mapPlayerPoint)) {
    const [px, py] = project(mapPlayerPoint);
    ctx.beginPath();
    ctx.arc(px, py, 8, 0, Math.PI * 2);
    ctx.fillStyle = "#2c7ef6";
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  if (Array.isArray(state.tapPoint)) {
    const [tx, ty] = project(state.tapPoint);
    ctx.beginPath();
    ctx.arc(tx, ty, 7, 0, Math.PI * 2);
    ctx.fillStyle = darkTheme ? "#2a2d31" : "#e9ecf0";
    ctx.fill();
    ctx.strokeStyle = strokeDefault;
    ctx.lineWidth = 2.4;
    ctx.stroke();
  }
}

function setHole(holeNumber) {
  if (!state.holes.includes(holeNumber)) return;
  clearTapPreviewTimer();
  state.currentHole = holeNumber;
  state.tapPoint = null;
  if (els.holeSelect) {
    els.holeSelect.value = String(holeNumber);
  }
  renderCurrentHole();
}

function nextHole(delta) {
  if (!state.holes.length || state.currentHole == null) return;
  const idx = state.holes.indexOf(state.currentHole);
  if (idx === -1) return;
  const next = (idx + delta + state.holes.length) % state.holes.length;
  setHole(state.holes[next]);
}

function updateHoleNavControls() {
  const holes = state.holes || [];
  const hole = state.currentHole;
  if (!holes.length || hole == null) {
    if (els.holePrev) els.holePrev.textContent = "<-";
    if (els.holeNext) els.holeNext.textContent = "->";
    return;
  }
  const idx = holes.indexOf(hole);
  if (idx === -1) return;
  const prevHole = holes[(idx - 1 + holes.length) % holes.length];
  const nextHoleNumber = holes[(idx + 1) % holes.length];
  if (els.holePrev) els.holePrev.textContent = `<- ${prevHole}`;
  if (els.holeNext) els.holeNext.textContent = `${nextHoleNumber} ->`;
  if (els.holeSelect) els.holeSelect.value = String(hole);
}

function bindEvents() {
  if (els.holeSelect) {
    els.holeSelect.addEventListener("change", () => {
      const value = Number(els.holeSelect.value);
      if (Number.isFinite(value)) setHole(value);
    });
  }

  els.holePrev.addEventListener("click", () => nextHole(-1));
  els.holeNext.addEventListener("click", () => nextHole(1));

  if (els.locBtn) {
    els.locBtn.addEventListener("click", () => {
      startLocationTracking();
    });
  }

  if (els.locClear) {
    els.locClear.addEventListener("click", () => {
      stopLocationTracking(true, "Location cleared.");
      renderCurrentHole();
    });
  }

  if (els.holeCanvas) {
    els.holeCanvas.addEventListener("click", handleHoleTap);
  }

  window.addEventListener("keydown", (event) => {
    if (event.target && ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
    if (event.key === "ArrowLeft") nextHole(-1);
    if (event.key === "ArrowRight") nextHole(1);
  });

  window.addEventListener("beforeunload", () => {
    clearTapPreviewTimer();
    stopLocationTracking(false, "");
  });

  window.addEventListener("resize", () => {
    renderCurrentHole();
  });
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to load ${path}: ${response.status}`);
  return response.json();
}

async function resolveDataBase() {
  if (state.dataBase) return state.dataBase;

  const attempts = [];
  for (const candidate of DATA_BASE_CANDIDATES) {
    const probe = `${candidate}/bluegolf_tee_green_coordinates.json`;
    attempts.push(probe);
    try {
      const response = await fetch(probe, { cache: "no-store" });
      if (response.ok) {
        state.dataBase = candidate;
        return candidate;
      }
    } catch (_) {
      // continue
    }
  }

  throw new Error(`Could not locate hole data. Tried: ${attempts.join(" | ")}`);
}

async function loadData() {
  const dataBase = await resolveDataBase();

  const [bluegolfRows, bluegolfCourse] = await Promise.all([
    fetchJson(`${dataBase}/bluegolf_tee_green_coordinates.json`),
    fetchJson(`${dataBase}/bluegolf_course_data.json`).catch(() => null),
  ]);

  state.bluegolfCourse = bluegolfCourse && typeof bluegolfCourse === "object" ? bluegolfCourse : null;
  state.courseFeatures = [];
  state.holeFeatures = [];
  state.holeMap = new Map();

  const map = new Map();
  for (const row of Array.isArray(bluegolfRows) ? bluegolfRows : []) {
    const hole = Number(row?.hole);
    if (!Number.isFinite(hole)) continue;
    map.set(hole, row);
  }
  state.bluegolfHoleMap = map;
  state.holes = Array.from(map.keys()).sort((a, b) => a - b);

  if (els.holeSelect) {
    els.holeSelect.innerHTML = "";
    for (const hole of state.holes) {
      const option = document.createElement("option");
      option.value = String(hole);
      option.textContent = String(hole);
      els.holeSelect.appendChild(option);
    }
  }

  if (state.holes.length) {
    state.currentHole = state.holes[0];
    if (els.holeSelect) {
      els.holeSelect.value = String(state.currentHole);
    }
  }
}

async function init() {
  bindEvents();
  state.locationPermissionGranted = readGeolocationGrant();
  updateTrackingButton();
  updateLocationStatus(
    state.locationPermissionGranted
      ? "Reusing saved location permission..."
      : "Location not shared yet."
  );

  try {
    await loadData();
    renderCurrentHole();
    await maybeAutoStartTracking();
  } catch (error) {
    console.error(error);
    state.locationError = `Could not load hole data: ${error.message}`;
    updateLocationStatus(state.locationError);
    els.holeEmpty.style.display = "";
    if (els.yardageDetail) {
      els.yardageDetail.textContent = state.locationError;
    }
  }
}

init();
