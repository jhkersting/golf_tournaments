import {
  api,
  staticJson,
  qs,
  STATIC_BASE,
  createTeamColorRegistry,
  setHeaderTournamentName,
  STORAGE_KEYS,
  getRememberedPlayerCode,
  rememberPlayerCode,
  rememberTournamentId,
} from "./app.js";
import {
  applyPendingScoreSubmissionsToTournament,
  clearPendingScoreSubmissionsMatching,
  enqueuePendingScoreSubmission,
  flushPendingScoreSubmissions,
  getPendingScoreSummary,
  isNetworkFailure,
} from "./offline.js";

const DATA_ROOT_CANDIDATES = [
  "./data",
  `${STATIC_BASE}/course-data`,
  "../../golf_course_hole_geo_data/data",
  "/golf_tournaments/golf_course_hole_geo_data/data",
  "/golf_course_hole_geo_data/data",
];
const MAP_INDEX_CANDIDATES = DATA_ROOT_CANDIDATES.map((root) => `${root}/courses_map_index.json`);
const FORCED_DATA_SLUG = String(new URLSearchParams(window.location.search).get("dataSlug") || "").trim();
const STREET_TILE_LIGHT_URL_TEMPLATE = "https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png";
const STREET_TILE_DARK_URL_TEMPLATE = "https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png";
const STREET_TILE_SUBDOMAINS = ["a", "b", "c", "d"];
const SATELLITE_TILE_URL_TEMPLATE =
  "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const MAP_MODE_FULL = "full";
const MAP_MODE_SIMPLIFIED = "simplified";
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
const MAP_MODE_PREFS_KEY = "hole-map:map-mode-preferences";
const AUTO_ZOOM_PREFS_KEY = "hole-map:auto-zoom-enabled";
const MAP_FOCUS_MAX_USER_DISTANCE_YARDS = 700;
const MAP_PROXIMITY_ZOOM_MAX_BOOST = 0.45;
const MAP_PLAYER_REAR_PADDING_YARDS = 20; // Keep 20 yards behind the current player position in auto-zoom framing.
const MAP_GREEN_BACK_PADDING_YARDS = 20; // Keep 20 yards past the back of the green in auto-zoom framing.
const USER_ZOOM_MIN = 1;
const USER_ZOOM_MAX = 3;
const TAP_PREVIEW_DURATION_MS = 7000;
const TAP_DOT_MOBILE_RADIUS_MULTIPLIER = 1.75;
const PLAYER_DOT_MOBILE_RADIUS_MULTIPLIER = 1.65;
const SCORE_AUTO_REFRESH_MS = 30_000;
const MISSING_BACK_EXTENSION_YARDS = 30;
const SCORE_WHEEL_MIN = 1;
const SCORE_WHEEL_MAX = 20;
const SCORE_WHEEL_VALUES = ["", ...Array.from({ length: SCORE_WHEEL_MAX }, (_, index) => String(index + SCORE_WHEEL_MIN))];

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
  dataSlug: "",
  mapMode: MAP_MODE_SIMPLIFIED,
  mapLabel: "",
  renderNonce: 0,
  tileImageCache: new Map(),
  userZoomMultiplier: 1,
  autoZoomEnabled: true,
  userPanX: 0,
  userPanY: 0,
  lastProjectionInput: null,
};

const entryState = {
  code: "",
  tid: "",
  enter: null,
  tournament: null,
  mapIndex: null,
  mapIndexPromise: null,
  rounds: [],
  players: [],
  playersById: Object.create(null),
  teamsById: Object.create(null),
  selectedRoundIndex: 0,
  currentHoleIndex: 0,
  currentInputs: [],
  activeScoreWheel: null,
  scorePanelMode: "scores",
  scorePanelExpanded: false,
  currentMapMeta: null,
  mapModePreferenceBySlug: Object.create(null),
  submitting: false,
  refreshTimer: 0,
};
const teamColors = createTeamColorRegistry();
const brandDot = document.querySelector(".brand .dot");
const scoreNotifier = document.getElementById("score_notifier");
const ticker = document.getElementById("enter_ticker");
const tickerTitle = document.getElementById("enter_ticker_title");
const tickerTrack = document.getElementById("enter_ticker_track");
const tickerHome = document.getElementById("map_ticker_home");
const tickerShell = document.getElementById("map_ticker_shell");
const pageBody = document.body;
let pageBodyShown = false;
let scoreNotifierTimerId = 0;
let scoreNotifierQueue = [];
let scoreNotifierActive = false;
let tickerSectionIndex = 0;
let tickerRafId = 0;
let tickerHoldTimerId = 0;
let tickerRunToken = 0;
let tickerLoopRunning = false;
let tickerSections = [];
let tickerRunEl = null;
let tickerCurrentX = 0;
let tickerEndX = 0;
let tickerPrevTs = 0;
let tickerPhase = "hold";
let tickerPhaseStartedAt = 0;
let holeControlsStickyActive = false;
let holeControlsStickyPlaceholder = null;
let pinchZoomActive = false;
let pinchZoomStartDistance = 0;
let pinchZoomStartValue = 1;
let pinchZoomLastEndedAtMs = 0;
let pinchZoomStartPanX = 0;
let pinchZoomStartPanY = 0;
let pinchZoomStartCenter = null;
let pinchZoomAnchorMapPoint = null;
let panTouchActive = false;
let panTouchLastPoint = null;
let mapGestureLastMovedAtMs = 0;
let pendingSyncPromise = null;
const SCORE_NOTIFIER_SHOW_MS = 2300;
const SCORE_NOTIFIER_GAP_MS = 200;
const TICKER_SPEED_PX_PER_SEC = 52;
const TICKER_START_DELAY_MS = 3000;
const TICKER_NEXT_DELAY_MS = 3000;

function showPageBody() {
  if (pageBodyShown || !pageBody) return;
  pageBodyShown = true;
  pageBody.style.display = "block";
  pageBody.style.visibility = "visible";
}

function el(tag, attrs = {}, html = null) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "style") node.setAttribute("style", value);
    else node.setAttribute(key, value);
  }
  if (html != null) node.innerHTML = html;
  return node;
}

const els = {
  container: document.querySelector(".container"),
  controlsCard: document.querySelector(".hole-map-controls"),
  holeSelect: document.getElementById("hole_select"),
  holePrev: document.getElementById("hole_prev"),
  holeNext: document.getElementById("hole_next"),
  locBtn: document.getElementById("loc_btn"),
  locClear: document.getElementById("loc_clear"),
  zoomAutoToggle: document.getElementById("zoom_auto_toggle"),
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
  holeFooter: document.querySelector(".hole-map-footer"),
  scoreCard: null,
  scoreBody: null,
  scoreTitle: null,
  scoreActions: null,
  scoreTickerHost: null,
  roundTabs: null,
  scoreRows: null,
  scoreStatus: null,
  scoreSyncStatus: null,
  mapInfo: null,
  mapModeToggle: document.getElementById("map_mode_toggle"),
  scoreOverrideInput: null,
  scoreSubmitDock: null,
  scoreHoleMeta: null,
  scoreSubmitButton: null,
  scoreSubmitInline: null,
  scoreCloseButton: null,
  scoreChangeCodeButton: null,
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

function projectBeyondPoint(startPoint, endPoint, yards) {
  if (!Array.isArray(startPoint) || !Array.isArray(endPoint)) return null;
  const [sx, sy] = lonLatToMercator(startPoint);
  const [ex, ey] = lonLatToMercator(endPoint);
  const dx = ex - sx;
  const dy = ey - sy;
  const len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len < 1e-6) return null;
  const meters = Number(yards) / 1.0936133;
  if (!Number.isFinite(meters) || meters <= 0) return null;
  const nx = dx / len;
  const ny = dy / len;
  return mercatorToLonLat([ex + nx * meters, ey + ny * meters]);
}

function readLonLatFromRow(row, prefix) {
  const rawLat = row?.[`${prefix}_lat`];
  const rawLon = row?.[`${prefix}_lon`];
  if (rawLat == null || rawLon == null) return null;
  if (String(rawLat).trim() === "" || String(rawLon).trim() === "") return null;
  const lat = Number(rawLat);
  const lon = Number(rawLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
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
  zoomMultiplier = 1,
  panOffsetX = 0,
  panOffsetY = 0
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
    const x = offsetX + (rx - minX) * scale + panOffsetX;
    const y = height - (offsetY + (ry - minY) * scale) + panOffsetY;
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

    const rx = (x - panOffsetX - offsetX) / scale + minX;
    const ry = (height - (y - panOffsetY) - offsetY) / scale + minY;
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
  const template = state.mapMode === MAP_MODE_SIMPLIFIED
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

function isLonLatPoint(point) {
  return (
    Array.isArray(point) &&
    point.length >= 2 &&
    Number.isFinite(Number(point[0])) &&
    Number.isFinite(Number(point[1]))
  );
}

function sanitizeLonLatPoint(point) {
  if (!isLonLatPoint(point)) return null;
  return [Number(point[0]), Number(point[1])];
}

function polylineLengthYards(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    total += distanceYards(points[i], points[i + 1]);
  }
  return total;
}

function holeLinePathPoints(holeLine) {
  const geom = holeLine?.geometry;
  if (!geom) return [];
  if (geom.type === "LineString") {
    return (Array.isArray(geom.coordinates) ? geom.coordinates : [])
      .map(sanitizeLonLatPoint)
      .filter(Boolean);
  }
  if (geom.type === "MultiLineString") {
    const lines = (Array.isArray(geom.coordinates) ? geom.coordinates : [])
      .map((line) => (Array.isArray(line) ? line.map(sanitizeLonLatPoint).filter(Boolean) : []))
      .filter((line) => line.length >= 2);
    if (!lines.length) return [];
    lines.sort((a, b) => polylineLengthYards(b) - polylineLengthYards(a));
    return lines[0];
  }
  return [];
}

function orientPathTowardsGreen(pathPoints, teeRef, greenRef) {
  if (!Array.isArray(pathPoints) || pathPoints.length < 2) return [];
  const forward = [...pathPoints];
  const reverse = [...pathPoints].reverse();
  const score = (points) => {
    const start = points[0];
    const end = points[points.length - 1];
    let total = 0;
    if (isLonLatPoint(teeRef)) total += distanceYards(start, teeRef);
    if (isLonLatPoint(greenRef)) total += distanceYards(end, greenRef);
    return total;
  };
  return score(forward) <= score(reverse) ? forward : reverse;
}

function markerPointsAlongPath(pathPoints, yardsToGreenValues) {
  if (!Array.isArray(pathPoints) || pathPoints.length < 2) return [];
  const segmentLengths = [];
  let totalLength = 0;
  for (let i = 0; i < pathPoints.length - 1; i += 1) {
    const len = distanceYards(pathPoints[i], pathPoints[i + 1]);
    segmentLengths.push(len);
    totalLength += len;
  }
  if (!Number.isFinite(totalLength) || totalLength <= 0) return [];

  const markerPoints = [];
  for (const rawValue of yardsToGreenValues || []) {
    const yardsToGreen = Number(rawValue);
    if (!Number.isFinite(yardsToGreen) || yardsToGreen <= 0) continue;
    const targetFromStart = totalLength - yardsToGreen;
    if (!Number.isFinite(targetFromStart) || targetFromStart <= 0 || targetFromStart >= totalLength) continue;

    let traversed = 0;
    for (let i = 0; i < segmentLengths.length; i += 1) {
      const segLen = segmentLengths[i];
      const next = traversed + segLen;
      if (targetFromStart > next) {
        traversed = next;
        continue;
      }
      const ratio = segLen > 1e-9 ? (targetFromStart - traversed) / segLen : 0;
      const a = pathPoints[i];
      const b = pathPoints[i + 1];
      markerPoints.push({
        yardsToGreen,
        point: [
          a[0] + (b[0] - a[0]) * ratio,
          a[1] + (b[1] - a[1]) * ratio,
        ],
      });
      break;
    }
  }
  return markerPoints;
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

function clampUserZoom(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(USER_ZOOM_MIN, Math.min(USER_ZOOM_MAX, parsed));
}

function projectionForGesture(userZoom, panX, panY) {
  const input = state.lastProjectionInput;
  if (!input) return null;
  const finalZoom = Number(input.autoZoomMultiplier || 1) * clampUserZoom(userZoom);
  return createAlignedProjector(
    input.features,
    input.extraPoints,
    input.alignmentStart,
    input.alignmentEnd,
    input.width,
    input.height,
    input.margin,
    finalZoom,
    panX,
    panY
  );
}

function setUserZoom(value, { rerender = true } = {}) {
  const next = clampUserZoom(value);
  if (Math.abs(next - state.userZoomMultiplier) < 1e-6) return;
  state.userZoomMultiplier = next;
  if (next <= USER_ZOOM_MIN + 1e-6) {
    state.userPanX = 0;
    state.userPanY = 0;
  }
  if (rerender) renderCurrentHole();
}

function formatYards(value) {
  return Number.isFinite(value) ? String(Math.round(value)) : "-";
}

function parForHoleNumber(holeNumber) {
  const hole = Number(holeNumber);
  if (!Number.isFinite(hole)) return null;
  if (state.mapMode === MAP_MODE_FULL) {
    return holePar(state.holeMap.get(hole) || []);
  }
  const parsedPar = Number(state.bluegolfCourse?.pars?.[hole - 1]);
  return Number.isFinite(parsedPar) ? parsedPar : null;
}

function holeYardagesForRound(tjson, roundIndex) {
  const raw = courseForRoundRaw(tjson, roundIndex)?.holeYardages;
  if (!Array.isArray(raw) || raw.length !== 18) return null;
  const values = raw.map((value) => Number(value));
  return values.every((value) => Number.isFinite(value)) ? values : null;
}

function fallbackHoleYardages() {
  const candidates = [
    state.bluegolfCourse?.holeYardages,
    state.bluegolfCourse?.longestTees?.[0]?.holeYardages,
    state.bluegolfCourse?.tees?.[0]?.holeYardages,
  ];
  for (const raw of candidates) {
    if (!Array.isArray(raw) || raw.length !== 18) continue;
    const values = raw.map((value) => Number(value));
    if (values.every((value) => Number.isFinite(value))) return values;
  }
  return null;
}

function totalYardageForHoleNumber(holeNumber) {
  const hole = Number(holeNumber);
  if (!Number.isFinite(hole) || hole < 1) return null;
  const holeIndex = hole - 1;
  const roundYardages = holeYardagesForRound(entryState.tournament, entryState.selectedRoundIndex);
  if (Array.isArray(roundYardages) && Number.isFinite(roundYardages[holeIndex])) {
    return roundYardages[holeIndex];
  }
  const fallbackYardages = fallbackHoleYardages();
  if (Array.isArray(fallbackYardages) && Number.isFinite(fallbackYardages[holeIndex])) {
    return fallbackYardages[holeIndex];
  }
  return null;
}

function formatHoleSummaryText(holeNumber, parValue, holeYardage) {
  const holeText = Number.isFinite(Number(holeNumber)) ? String(Math.round(Number(holeNumber))) : "—";
  const parText = Number.isFinite(parValue) ? String(Math.round(parValue)) : "—";
  const yardageText = Number.isFinite(holeYardage) ? `${Math.round(holeYardage)}y` : "—";
  return `Hole ${holeText} | Par ${parText} | ${yardageText}`;
}

function holeSummaryTextForOption(holeNumber) {
  return formatHoleSummaryText(
    holeNumber,
    parForHoleNumber(holeNumber),
    totalYardageForHoleNumber(holeNumber)
  );
}

function syncHoleSelectOptionLabel(holeNumber, labelText) {
  if (!els.holeSelect) return;
  const value = String(holeNumber);
  const option = Array.from(els.holeSelect.options).find((candidate) => candidate.value === value);
  if (option) option.textContent = labelText;
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

function syncScoreNotifierOffset() {
  if (!scoreNotifier) return;
  const footer = els.holeFooter;
  const dock = els.scoreSubmitDock;
  const dockHeight = dock && !dock.hidden
    ? Math.max(0, Math.round(dock.getBoundingClientRect().height || dock.offsetHeight || 0))
    : 0;
  if (!footer) {
    scoreNotifier.style.bottom = `${Math.max(14, dockHeight + 14)}px`;
    return;
  }
  const footerHeight = Math.max(
    0,
    Math.round(footer.getBoundingClientRect().height || footer.offsetHeight || 0)
  );
  scoreNotifier.style.bottom = `${Math.max(14, Math.max(footerHeight, dockHeight) + 14)}px`;
}

function syncHoleControlsStickyOffset() {
  if (!els.controlsCard || !els.container) return;
  const header = document.querySelector("header");
  const headerBottom = Math.max(0, Math.round(header?.getBoundingClientRect().bottom || 0));
  els.controlsCard.style.setProperty("--hole-controls-stick-top", `${headerBottom}px`);
  const STICKY_HYSTERESIS_PX = 6;

  if (!holeControlsStickyPlaceholder || !holeControlsStickyPlaceholder.isConnected) {
    const placeholder = document.createElement("div");
    placeholder.className = "hole-map-controls-placeholder";
    placeholder.style.display = "none";
    placeholder.style.height = "0px";
    els.controlsCard.insertAdjacentElement("afterend", placeholder);
    holeControlsStickyPlaceholder = placeholder;
  }

  const anchorRect =
    holeControlsStickyActive && holeControlsStickyPlaceholder
      ? holeControlsStickyPlaceholder.getBoundingClientRect()
      : els.controlsCard.getBoundingClientRect();
  const controlsStyle = window.getComputedStyle(els.controlsCard);
  const marginTop = Number.parseFloat(controlsStyle.marginTop) || 0;
  const marginBottom = Number.parseFloat(controlsStyle.marginBottom) || 0;
  const flowHeight = Math.max(
    0,
    Math.round(
      (els.controlsCard.getBoundingClientRect().height || els.controlsCard.offsetHeight || 0) + marginTop + marginBottom
    )
  );
  const shouldStick = holeControlsStickyActive
    ? anchorRect.top <= headerBottom + STICKY_HYSTERESIS_PX
    : anchorRect.top <= headerBottom;

  if (shouldStick && !holeControlsStickyActive) {
    if (holeControlsStickyPlaceholder) {
      holeControlsStickyPlaceholder.style.display = "block";
      holeControlsStickyPlaceholder.style.height = `${flowHeight}px`;
    }
    holeControlsStickyActive = true;
    els.controlsCard.classList.add("is-stuck");
  } else if (!shouldStick && holeControlsStickyActive) {
    holeControlsStickyActive = false;
    els.controlsCard.classList.remove("is-stuck");
    els.controlsCard.style.removeProperty("--hole-controls-fixed-top");
    els.controlsCard.style.removeProperty("--hole-controls-fixed-left");
    els.controlsCard.style.removeProperty("--hole-controls-fixed-width");
    if (holeControlsStickyPlaceholder) {
      holeControlsStickyPlaceholder.style.display = "none";
      holeControlsStickyPlaceholder.style.height = "0px";
    }
    return;
  }

  if (!holeControlsStickyActive) return;

  if (holeControlsStickyPlaceholder) {
    holeControlsStickyPlaceholder.style.display = "block";
    holeControlsStickyPlaceholder.style.height = `${flowHeight}px`;
  }

  const pinnedRect =
    holeControlsStickyPlaceholder && holeControlsStickyPlaceholder.style.display !== "none"
      ? holeControlsStickyPlaceholder.getBoundingClientRect()
      : els.controlsCard.getBoundingClientRect();
  els.controlsCard.style.setProperty("--hole-controls-fixed-top", `${headerBottom}px`);
  els.controlsCard.style.setProperty("--hole-controls-fixed-left", `${Math.round(pinnedRect.left)}px`);
  els.controlsCard.style.setProperty("--hole-controls-fixed-width", `${Math.round(pinnedRect.width)}px`);
}

function syncFooterViewportLock() {
  const footer = els.holeFooter;
  if (!footer) {
    syncScoreNotifierOffset();
    return;
  }
  const position = window.getComputedStyle(footer).position;
  if (position !== "fixed") {
    footer.style.left = "";
    footer.style.top = "";
    footer.style.bottom = "";
    footer.style.width = "";
    footer.style.transform = "";
    syncScoreNotifierOffset();
    return;
  }

  const vv = window.visualViewport;
  if (!vv) {
    footer.style.left = "";
    footer.style.top = "";
    footer.style.bottom = "";
    footer.style.width = "";
    footer.style.transform = "";
    syncScoreNotifierOffset();
    return;
  }

  const scale = Math.max(1, Number(vv.scale) || 1);
  const invScale = 1 / scale;
  const lockedWidth = vv.width * scale;
  const scaledFooterHeight = footer.offsetHeight * invScale;
  const top = vv.offsetTop + vv.height - scaledFooterHeight;

  footer.style.left = `${vv.offsetLeft}px`;
  footer.style.top = `${Math.max(0, top)+1}px`;
  footer.style.bottom = "auto";
  footer.style.width = `${lockedWidth}px`;
  footer.style.transformOrigin = "left top";
  footer.style.transform = `scale(${invScale})`;
  syncScoreNotifierOffset();
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

function normalizeMapModeValue(value) {
  const mode = String(value || "").toLowerCase();
  return mode === MAP_MODE_FULL || mode === MAP_MODE_SIMPLIFIED ? mode : "";
}

function readMapModePreferences() {
  try {
    const raw = localStorage.getItem(MAP_MODE_PREFS_KEY);
    if (!raw) return Object.create(null);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Object.create(null);
    }
    const prefs = Object.create(null);
    for (const [slug, mode] of Object.entries(parsed)) {
      const cleanSlug = String(slug || "").trim();
      const cleanMode = normalizeMapModeValue(mode);
      if (!cleanSlug || !cleanMode) continue;
      prefs[cleanSlug] = cleanMode;
    }
    return prefs;
  } catch (_) {
    return Object.create(null);
  }
}

function persistMapModePreferences() {
  try {
    localStorage.setItem(MAP_MODE_PREFS_KEY, JSON.stringify(entryState.mapModePreferenceBySlug));
  } catch (_) {
    // ignore
  }
}

function hydrateMapModePreferences() {
  entryState.mapModePreferenceBySlug = readMapModePreferences();
}

function readAutoZoomPreference() {
  try {
    const raw = localStorage.getItem(AUTO_ZOOM_PREFS_KEY);
    if (raw === "0" || raw === "false") return false;
  } catch (_) {
    // ignore
  }
  return true;
}

function persistAutoZoomPreference(enabled) {
  try {
    localStorage.setItem(AUTO_ZOOM_PREFS_KEY, enabled ? "1" : "0");
  } catch (_) {
    // ignore
  }
}

function updateAutoZoomButton() {
  if (!els.zoomAutoToggle) return;
  els.zoomAutoToggle.textContent = state.autoZoomEnabled ? "Auto Zoom: On" : "Auto Zoom: Off";
  els.zoomAutoToggle.setAttribute("aria-pressed", state.autoZoomEnabled ? "true" : "false");
}

function hydrateAutoZoomPreference() {
  state.autoZoomEnabled = readAutoZoomPreference();
  updateAutoZoomButton();
}

function rememberMapModePreference(slug, mode) {
  const cleanSlug = String(slug || "").trim();
  const cleanMode = normalizeMapModeValue(mode);
  if (!cleanSlug || !cleanMode) return;
  if (entryState.mapModePreferenceBySlug[cleanSlug] === cleanMode) return;
  entryState.mapModePreferenceBySlug[cleanSlug] = cleanMode;
  persistMapModePreferences();
}

function updateTrackingButton() {
  const locationInUse =
    Array.isArray(state.userLocation) || state.locationWatchId != null || state.locationPending;

  if (els.locBtn) {
    els.locBtn.style.display = locationInUse ? "none" : "";
    els.locBtn.disabled = Boolean(state.locationPending);
    els.locBtn.textContent = state.locationPending ? "Locating..." : "Use My Location";
  }

  if (els.locClear) {
    els.locClear.style.display = locationInUse ? "" : "none";
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
  const point = event?.changedTouches?.[0] || event?.touches?.[0] || event;
  return canvasPointFromClient(point?.clientX, point?.clientY);
}

function canvasPointFromClient(rawClientX, rawClientY) {
  if (!els.holeCanvas) return null;
  const rect = els.holeCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const clientX = Number(rawClientX);
  const clientY = Number(rawClientY);
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;

  const logicalWidth = Number(state.lastCanvasLogicalSize?.width) || els.holeCanvas.width;
  const logicalHeight = Number(state.lastCanvasLogicalSize?.height) || els.holeCanvas.height;
  const x = ((clientX - rect.left) / rect.width) * logicalWidth;
  const y = ((clientY - rect.top) / rect.height) * logicalHeight;
  return [x, y];
}

function touchDistance(touchA, touchB) {
  const ax = Number(touchA?.clientX);
  const ay = Number(touchA?.clientY);
  const bx = Number(touchB?.clientX);
  const by = Number(touchB?.clientY);
  if (![ax, ay, bx, by].every(Number.isFinite)) return 0;
  return Math.hypot(ax - bx, ay - by);
}

function beginPinchZoom(touchA, touchB) {
  const distance = touchDistance(touchA, touchB);
  if (!Number.isFinite(distance) || distance < 8) return false;
  const center = canvasPointFromClient(
    (Number(touchA?.clientX) + Number(touchB?.clientX)) / 2,
    (Number(touchA?.clientY) + Number(touchB?.clientY)) / 2
  );
  pinchZoomActive = true;
  pinchZoomStartDistance = distance;
  pinchZoomStartValue = clampUserZoom(state.userZoomMultiplier);
  pinchZoomStartPanX = Number(state.userPanX) || 0;
  pinchZoomStartPanY = Number(state.userPanY) || 0;
  pinchZoomStartCenter = center;
  pinchZoomAnchorMapPoint =
    Array.isArray(center) && state.lastProjection?.unproject
      ? state.lastProjection.unproject(center)
      : null;
  panTouchActive = false;
  panTouchLastPoint = null;
  return true;
}

function handleCanvasTouchStart(event) {
  const touches = event?.touches || [];
  if (touches.length >= 2) {
    if (beginPinchZoom(touches[0], touches[1])) {
      event.preventDefault();
    }
    return;
  }
  if (touches.length === 1 && clampUserZoom(state.userZoomMultiplier) > USER_ZOOM_MIN + 1e-6) {
    panTouchActive = true;
    panTouchLastPoint = canvasPointFromClient(touches[0]?.clientX, touches[0]?.clientY);
  } else {
    panTouchActive = false;
    panTouchLastPoint = null;
  }
}

function handlePanTouchMove(event) {
  const touches = event?.touches || [];
  if (!panTouchActive || touches.length !== 1) return false;
  const current = canvasPointFromClient(touches[0]?.clientX, touches[0]?.clientY);
  if (!Array.isArray(current) || !Array.isArray(panTouchLastPoint)) return false;
  const dx = current[0] - panTouchLastPoint[0];
  const dy = current[1] - panTouchLastPoint[1];
  panTouchLastPoint = current;
  if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) return true;
  state.userPanX = (Number(state.userPanX) || 0) + dx;
  state.userPanY = (Number(state.userPanY) || 0) + dy;
  mapGestureLastMovedAtMs = Date.now();
  renderCurrentHole();
  return true;
}

function handleCanvasTouchMove(event) {
  const touches = event?.touches || [];
  if (touches.length >= 2) {
    if (!pinchZoomActive && !beginPinchZoom(touches[0], touches[1])) return;
    const distance = touchDistance(touches[0], touches[1]);
    if (!Number.isFinite(distance) || distance <= 0 || pinchZoomStartDistance <= 0) return;
    const center = canvasPointFromClient(
      (Number(touches[0]?.clientX) + Number(touches[1]?.clientX)) / 2,
      (Number(touches[0]?.clientY) + Number(touches[1]?.clientY)) / 2
    );
    const ratio = distance / pinchZoomStartDistance;
    const nextZoom = clampUserZoom(pinchZoomStartValue * ratio);
    let panX = pinchZoomStartPanX;
    let panY = pinchZoomStartPanY;
    if (Array.isArray(center) && Array.isArray(pinchZoomStartCenter)) {
      panX += center[0] - pinchZoomStartCenter[0];
      panY += center[1] - pinchZoomStartCenter[1];
    }

    if (Array.isArray(center) && Array.isArray(pinchZoomAnchorMapPoint)) {
      const candidate = projectionForGesture(nextZoom, panX, panY);
      if (candidate?.project) {
        const projected = candidate.project(pinchZoomAnchorMapPoint);
        if (Array.isArray(projected)) {
          panX += center[0] - projected[0];
          panY += center[1] - projected[1];
        }
      }
    }

    state.userZoomMultiplier = nextZoom;
    state.userPanX = panX;
    state.userPanY = panY;
    mapGestureLastMovedAtMs = Date.now();
    event.preventDefault();
    renderCurrentHole();
    return;
  }

  if (handlePanTouchMove(event)) {
    event.preventDefault();
    return;
  }
}

function finishPinchZoom() {
  if (!pinchZoomActive) return;
  pinchZoomActive = false;
  pinchZoomStartDistance = 0;
  pinchZoomStartValue = clampUserZoom(state.userZoomMultiplier);
  pinchZoomStartPanX = Number(state.userPanX) || 0;
  pinchZoomStartPanY = Number(state.userPanY) || 0;
  pinchZoomStartCenter = null;
  pinchZoomAnchorMapPoint = null;
  pinchZoomLastEndedAtMs = Date.now();
}

function handleCanvasTouchEnd(event) {
  const touches = event?.touches || [];
  if (touches.length >= 2) {
    beginPinchZoom(touches[0], touches[1]);
    panTouchActive = false;
    panTouchLastPoint = null;
    return;
  }
  if (touches.length === 1 && clampUserZoom(state.userZoomMultiplier) > USER_ZOOM_MIN + 1e-6) {
    panTouchActive = true;
    panTouchLastPoint = canvasPointFromClient(touches[0]?.clientX, touches[0]?.clientY);
    return;
  }
  panTouchActive = false;
  panTouchLastPoint = null;
  finishPinchZoom();
}

function handleCanvasTouchCancel() {
  panTouchActive = false;
  panTouchLastPoint = null;
  finishPinchZoom();
}

function handleHoleTap(event) {
  if (pinchZoomActive) return;
  if (panTouchActive) return;
  if (Date.now() - mapGestureLastMovedAtMs < 250) return;
  if (Date.now() - pinchZoomLastEndedAtMs < 300) return;
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
  const usingFullMode = state.mapMode === MAP_MODE_FULL;
  const features = usingFullMode ? (state.holeMap.get(hole) || []) : [];
  const holeData = usingFullMode ? null : (state.bluegolfHoleMap.get(hole) || null);
  let holeLine = null;
  const targetAvailable = { front: false, center: false, back: false };
  let par = null;
  let backTee = null;
  let alignmentStart = null;
  let alignmentEnd = null;
  const greenTargets = {
    front: null,
    center: null,
    back: null,
  };

  if (usingFullMode) {
    par = holePar(features);
    const green = greenForHole(features);
    holeLine = holeLineForHole(features);
    const greenCenter = featureCentroid(green);
    backTee = backTeeForHole(features, greenCenter, holeLine);
    const computedTargets = greenFrontBackPoints(green, backTee, holeLine);
    greenTargets.front = computedTargets.front;
    greenTargets.center = computedTargets.center;
    greenTargets.back = computedTargets.back;
    targetAvailable.front = Array.isArray(greenTargets.front);
    targetAvailable.center = Array.isArray(greenTargets.center);
    targetAvailable.back = Array.isArray(greenTargets.back);
    alignmentStart = backTee || firstLinePoint(holeLine) || featureCentroid(green) || null;
    alignmentEnd = greenTargets.center || lastLinePoint(holeLine) || featureCentroid(green) || null;
  } else {
    const parsedPar = Number(state.bluegolfCourse?.pars?.[Number(hole) - 1]);
    par = Number.isFinite(parsedPar) ? parsedPar : null;
    backTee = readLonLatFromRow(holeData, "tee");
    const rawFront = readLonLatFromRow(holeData, "green_front");
    const rawCenter = readLonLatFromRow(holeData, "green_center");
    const rawBack = readLonLatFromRow(holeData, "green_back");
    targetAvailable.front = Array.isArray(rawFront);
    targetAvailable.center = Array.isArray(rawCenter);
    targetAvailable.back = Array.isArray(rawBack);
    greenTargets.front = rawFront;
    greenTargets.center = rawCenter;
    greenTargets.back = rawBack;
    alignmentStart = backTee || greenTargets.front || greenTargets.center || null;
    alignmentEnd = greenTargets.center || greenTargets.back || greenTargets.front || null;
  }

  // Harden against incomplete course rows: permit missing front/back/center and derive fallbacks.
  if (!Array.isArray(greenTargets.center)) {
    greenTargets.center = Array.isArray(greenTargets.front)
      ? greenTargets.front
      : (Array.isArray(greenTargets.back) ? greenTargets.back : null);
  }
  if (!Array.isArray(greenTargets.front)) greenTargets.front = greenTargets.center || greenTargets.back;
  if (!Array.isArray(greenTargets.back)) greenTargets.back = greenTargets.center || greenTargets.front;

  if (!Array.isArray(alignmentStart)) {
    alignmentStart = backTee || greenTargets.front || greenTargets.center || greenTargets.back || null;
  }
  if (!Array.isArray(alignmentEnd)) {
    alignmentEnd = greenTargets.center || greenTargets.back || greenTargets.front || alignmentStart || null;
  }

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
  const playerRearPaddingPoint =
    Array.isArray(mapPlayerPoint) && Array.isArray(greenTargets.center)
      ? projectBeyondPoint(greenTargets.center, mapPlayerPoint, MAP_PLAYER_REAR_PADDING_YARDS)
      : null;
  const greenBackPaddingPoint =
    Array.isArray(greenTargets.center) && Array.isArray(greenTargets.back)
      ? projectBeyondPoint(greenTargets.center, greenTargets.back, MAP_GREEN_BACK_PADDING_YARDS)
      : null;
  const proximityZoomMultiplier = (() => {
    if (!state.autoZoomEnabled) return 1;
    if (!Number.isFinite(userToGreenCenterYards) || mapShouldFocusHole) return 1;
    const nearFactor = Math.max(
      0,
      Math.min(1, (MAP_FOCUS_MAX_USER_DISTANCE_YARDS - userToGreenCenterYards) / MAP_FOCUS_MAX_USER_DISTANCE_YARDS)
    );
    return 1 + nearFactor * MAP_PROXIMITY_ZOOM_MAX_BOOST;
  })();
  const finalZoomMultiplier = proximityZoomMultiplier * clampUserZoom(state.userZoomMultiplier);
  const tapToGreenCenterYards =
    Array.isArray(state.tapPoint) && Array.isArray(greenTargets.center)
      ? distanceYards(state.tapPoint, greenTargets.center)
      : null;
  const userToTapYards =
    Array.isArray(state.tapPoint) && Array.isArray(state.userLocation)
      ? distanceYards(state.userLocation, state.tapPoint)
      : null;
  const showToPoint = usingTapPoint && Number.isFinite(userToTapYards);
  const holeYardage = hole == null ? null : totalYardageForHoleNumber(hole);

  if (els.metricSummary) {
    const summaryText = formatHoleSummaryText(hole, par, holeYardage);
    els.metricSummary.textContent = summaryText;
    syncHoleSelectOptionLabel(hole, summaryText);
  }
  syncScoreHoleMeta(hole);
  if (els.metricToPointHead) els.metricToPointHead.style.display = showToPoint ? "" : "none";
  if (els.metricToPointRow) els.metricToPointRow.style.display = showToPoint ? "" : "none";
  if (els.metricToPoint) {
    els.metricToPoint.textContent = showToPoint ? formatYards(userToTapYards) : "—";
  }
  setMetricValue(
    els.metricFront,
    targetAvailable.front ? yardsFront : null,
    usingTapPoint && targetAvailable.front ? userYardsFront : null
  );
  setMetricValue(
    els.metricCenter,
    targetAvailable.center ? yardsCenter : null,
    usingTapPoint && targetAvailable.center ? userYardsCenter : null
  );
  setMetricValue(
    els.metricBack,
    targetAvailable.back ? yardsBack : null,
    usingTapPoint && targetAvailable.back ? userYardsBack : null
  );

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

  const hasHoleFeatures = usingFullMode ? features.length > 0 : !!holeData;
  if (!hasHoleFeatures || !greenTargets.center) {
    state.lastProjection = null;
    state.lastProjectionInput = null;
    els.holeEmpty.style.display = "";
    return;
  }
  els.holeEmpty.style.display = "none";

  let syntheticBackProjectionPoint = null;
  if (!targetAvailable.back && Array.isArray(greenTargets.center)) {
    const backDirectionStart =
      (targetAvailable.front && Array.isArray(greenTargets.front))
        ? greenTargets.front
        : (Array.isArray(backTee) ? backTee : alignmentStart);
    syntheticBackProjectionPoint = projectBeyondPoint(
      backDirectionStart,
      greenTargets.center,
      MISSING_BACK_EXTENSION_YARDS
    );
  }

  const extraPoints = [
    backTee,
    greenTargets.front,
    greenTargets.center,
    greenTargets.back,
    syntheticBackProjectionPoint,
    mapPlayerPoint,
    playerRearPaddingPoint,
    greenBackPaddingPoint,
  ];

  const teeRefForMarkers = Array.isArray(backTee) ? backTee : alignmentStart;
  const greenRefForMarkers = Array.isArray(greenTargets.center) ? greenTargets.center : alignmentEnd;
  const markerPathPoints = (() => {
    if (usingFullMode && holeLine) {
      const basePath = holeLinePathPoints(holeLine);
      if (basePath.length >= 2) {
        let oriented = orientPathTowardsGreen(basePath, teeRefForMarkers, greenRefForMarkers);
        if (isLonLatPoint(teeRefForMarkers)) {
          const start = oriented[0];
          if (!start || distanceYards(start, teeRefForMarkers) > 3) {
            oriented = [teeRefForMarkers, ...oriented];
          }
        }
        if (isLonLatPoint(greenRefForMarkers)) {
          const end = oriented[oriented.length - 1];
          if (!end || distanceYards(end, greenRefForMarkers) > 3) {
            oriented = [...oriented, greenRefForMarkers];
          }
        }
        return oriented;
      }
    }
    if (
      isLonLatPoint(teeRefForMarkers) &&
      isLonLatPoint(greenRefForMarkers) &&
      distanceYards(teeRefForMarkers, greenRefForMarkers) > 1
    ) {
      return [teeRefForMarkers, greenRefForMarkers];
    }
    return [];
  })();
  const pathDistanceMarkers = markerPointsAlongPath(markerPathPoints, []);

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
  state.lastProjectionInput = {
    features: usingFullMode ? features : [],
    extraPoints,
    alignmentStart,
    alignmentEnd,
    width,
    height,
    margin,
    autoZoomMultiplier: proximityZoomMultiplier,
  };

  const projection = createAlignedProjector(
    state.lastProjectionInput.features,
    extraPoints,
    alignmentStart,
    alignmentEnd,
    width,
    height,
    margin,
    finalZoomMultiplier,
    state.userPanX,
    state.userPanY
  );

  if (!projection) {
    state.lastProjection = null;
    state.lastProjectionInput = null;
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
  const isMobileDot = window.matchMedia("(max-width: 560px)").matches;
  if (usingFullMode) {
    const drawRank = { fairway: 1, green: 2, bunker: 3, tee: 4, hole: 5 };
    const strokeOther = darkTheme ? "rgba(235,240,248,0.76)" : "rgba(18,34,54,0.72)";
    const featureFillByType = {
      fairway: darkTheme ? "rgba(92, 148, 77, 0.34)" : "rgba(104, 168, 90, 0.34)",
      green: darkTheme ? "rgba(112, 184, 96, 0.42)" : "rgba(108, 191, 88, 0.43)",
      bunker: darkTheme ? "rgba(177, 155, 112, 0.42)" : "rgba(203, 178, 119, 0.56)",
      tee: darkTheme ? "rgba(106, 167, 89, 0.4)" : "rgba(112, 178, 94, 0.46)",
    };

    const sorted = [...features].sort((a, b) => {
      const ga = String(a?.properties?.golf || "");
      const gb = String(b?.properties?.golf || "");
      return (drawRank[ga] || 99) - (drawRank[gb] || 99);
    });

    for (const feature of sorted) {
      const golf = String(feature?.properties?.golf || "other");
      if (golf === "hole") continue;
      const geomType = String(feature?.geometry?.type || "");
      const isArea = geomType === "Polygon" || geomType === "MultiPolygon";
      const fillStyle = isArea ? featureFillByType[golf] : null;
      ctx.beginPath();
      const drew = drawGeometryPath(ctx, feature.geometry, project);
      if (!drew) continue;
      if (fillStyle) {
        ctx.fillStyle = fillStyle;
        ctx.fill();
      }
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
      if (fillStyle) {
        continue;
      }
      ctx.strokeStyle = strokeOther;
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }
  }

  if (Array.isArray(backTee)) {
    const [tx, ty] = project(backTee);
    const teeDotRadius = isMobileDot ? 11 : 9;
    ctx.beginPath();
    ctx.arc(tx, ty, teeDotRadius, 0, Math.PI * 2);
    ctx.fillStyle = "#000";
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  for (const marker of pathDistanceMarkers) {
    const point = sanitizeLonLatPoint(marker?.point);
    if (!point) continue;
    const [mx, my] = project(point);
    const markerRadius = isMobileDot ? 11 : 9;
    ctx.beginPath();
    ctx.arc(mx, my, markerRadius, 0, Math.PI * 2);
    ctx.fillStyle = darkTheme ? "rgba(12, 16, 20, 0.84)" : "rgba(255, 255, 255, 0.87)";
    ctx.fill();
    ctx.strokeStyle = darkTheme ? "rgba(255,255,255,0.86)" : "rgba(24,38,56,0.85)";
    ctx.lineWidth = 1.6;
    ctx.stroke();

    const text = String(Math.round(Number(marker.yardsToGreen)));
    ctx.fillStyle = darkTheme ? "#f4f7fb" : "#16283f";
    ctx.font = `700 ${isMobileDot ? 10 : 11}px "JetBrains Mono", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, mx, my + 0.25);
  }

  if (Array.isArray(mapPlayerPoint)) {
    const [px, py] = project(mapPlayerPoint);
    const playerDotRadius = isMobileDot
      ? 8 * PLAYER_DOT_MOBILE_RADIUS_MULTIPLIER
      : 8;
    ctx.beginPath();
    ctx.arc(px, py, playerDotRadius, 0, Math.PI * 2);
    ctx.fillStyle = "#2c7ef6";
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  if (Array.isArray(state.tapPoint)) {
    const [tx, ty] = project(state.tapPoint);
    const tapDotRadius = isMobileDot
      ? 7 * TAP_DOT_MOBILE_RADIUS_MULTIPLIER
      : 7;
    ctx.beginPath();
    ctx.arc(tx, ty, tapDotRadius, 0, Math.PI * 2);
    ctx.fillStyle = darkTheme ? "#2a2d31" : "#e9ecf0";
    ctx.fill();
    ctx.strokeStyle = strokeDefault;
    ctx.lineWidth = 2.4;
    ctx.stroke();
  }

  syncFooterViewportLock();
}

let onPrevHoleRequested = null;
let onNextHoleRequested = null;

function holeIndexFromNumber(holeNumber) {
  const parsed = Number(holeNumber);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(17, Math.round(parsed) - 1));
}

function holeNumberFromIndex(holeIndex) {
  const idx = Math.max(0, Math.min(17, Number(holeIndex) || 0));
  return idx + 1;
}

function setHole(holeNumber, { syncEntry = true } = {}) {
  if (!state.holes.includes(holeNumber)) return;
  clearTapPreviewTimer();
  state.currentHole = holeNumber;
  state.tapPoint = null;
  state.userPanX = 0;
  state.userPanY = 0;
  if (syncEntry) {
    entryState.currentHoleIndex = holeIndexFromNumber(holeNumber);
    renderScoreRows();
  }
  if (els.holeSelect) {
    els.holeSelect.value = String(holeNumber);
  }
  renderCurrentHole();
}

function setHoleByIndex(holeIndex, { syncEntry = true } = {}) {
  const desired = holeNumberFromIndex(holeIndex);
  if (state.holes.includes(desired)) {
    setHole(desired, { syncEntry });
    return;
  }
  const nearest = [...state.holes].sort(
    (a, b) => Math.abs(a - desired) - Math.abs(b - desired)
  )[0];
  if (nearest != null) {
    setHole(nearest, { syncEntry });
  }
}

function nextHole(delta, { syncEntry = true } = {}) {
  if (!state.holes.length || state.currentHole == null) return;
  const idx = state.holes.indexOf(state.currentHole);
  if (idx === -1) return;
  const next = (idx + delta + state.holes.length) % state.holes.length;
  setHole(state.holes[next], { syncEntry });
}

function updateHoleNavControls() {
  const holes = state.holes || [];
  const hole = state.currentHole;
  if (!holes.length || hole == null) {
    if (els.holePrev) els.holePrev.textContent = "—";
    if (els.holeNext) els.holeNext.textContent = "—";
    return;
  }
  const idx = holes.indexOf(hole);
  if (idx === -1) return;
  const prevHole = holes[(idx - 1 + holes.length) % holes.length];
  const nextHoleNumber = holes[(idx + 1) % holes.length];
  if (els.holePrev) els.holePrev.textContent = String(prevHole);
  if (els.holeNext) els.holeNext.textContent = String(nextHoleNumber);
  if (els.holeSelect) els.holeSelect.value = String(hole);
}

function bindEvents() {
  if (els.holeSelect) {
    els.holeSelect.addEventListener("change", () => {
      const value = Number(els.holeSelect.value);
      if (Number.isFinite(value)) setHole(value);
    });
  }

  if (els.holePrev) {
    els.holePrev.addEventListener("click", async () => {
      if (typeof onPrevHoleRequested === "function") {
        const handled = await onPrevHoleRequested();
        if (handled) return;
      }
      nextHole(-1);
    });
  }
  if (els.holeNext) {
    els.holeNext.addEventListener("click", async () => {
      if (typeof onNextHoleRequested === "function") {
        const handled = await onNextHoleRequested();
        if (handled) return;
      }
      nextHole(1);
    });
  }

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

  if (els.zoomAutoToggle) {
    els.zoomAutoToggle.addEventListener("click", () => {
      state.autoZoomEnabled = !state.autoZoomEnabled;
      persistAutoZoomPreference(state.autoZoomEnabled);
      updateAutoZoomButton();
      renderCurrentHole();
    });
  }

  if (els.holeCanvas) {
    els.holeCanvas.addEventListener("click", handleHoleTap);
  }

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && entryState.scorePanelExpanded && entryState.scorePanelMode !== "code") {
      event.preventDefault();
      if (!entryState.submitting) setScoreCardExpanded(false);
      return;
    }
    if (event.target && ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
    if (typeof event.target?.closest === "function" && event.target.closest("[data-score-wheel='true']")) return;
    if (entryState.scorePanelExpanded) return;
    if (event.key === "ArrowLeft") {
      if (typeof onPrevHoleRequested === "function") {
        void Promise.resolve(onPrevHoleRequested()).then((handled) => {
          if (!handled) nextHole(-1);
        });
        return;
      }
      nextHole(-1);
    }
    if (event.key === "ArrowRight") {
      if (typeof onNextHoleRequested === "function") {
        void Promise.resolve(onNextHoleRequested()).then((handled) => {
          if (!handled) nextHole(1);
        });
        return;
      }
      nextHole(1);
    }
  });

  window.addEventListener("beforeunload", () => {
    clearTapPreviewTimer();
    stopLocationTracking(false, "");
    if (entryState.refreshTimer) clearInterval(entryState.refreshTimer);
    if (scoreNotifierTimerId) clearTimeout(scoreNotifierTimerId);
    stopTickerRotation();
  });

  window.addEventListener("resize", () => {
    renderCurrentHole();
    syncFooterViewportLock();
    updateMapTickerStickyState();
  });

  window.addEventListener("scroll", updateMapTickerStickyState, { passive: true });

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncFooterViewportLock);
    window.visualViewport.addEventListener("scroll", syncFooterViewportLock);
  }
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to load ${path}: ${response.status}`);
  return response.json();
}

function normalizePlayerCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function normalizeTeamId(teamId) {
  return teamId == null ? "" : String(teamId).trim();
}

function setBrandDotColor(color) {
  if (!brandDot) return;
  if (!color) {
    brandDot.style.removeProperty("background");
    brandDot.style.removeProperty("box-shadow");
    return;
  }
  brandDot.style.background = color;
  brandDot.style.boxShadow = `0 0 0 6px color-mix(in srgb, ${color} 24%, transparent)`;
}

function updateBrandDotFromTournament(tournament) {
  const teamRows = tournament?.score_data?.leaderboard_all?.teams || [];
  const leadingRow = teamRows.find((row) => rowHasAnyData(row)) || null;
  const teamId = normalizeTeamId(leadingRow?.teamId || leadingRow?.id);
  setBrandDotColor(teamId ? colorForTeam(teamId) : null);
}

function seedTeamColors(tjson) {
  const ordered = [];
  const seen = new Set();
  const add = (teamId, teamName, teamColor) => {
    const id = normalizeTeamId(teamId);
    if (!id || seen.has(id)) return;
    seen.add(id);
    ordered.push({
      teamId: id,
      teamName: String(teamName || "").trim(),
      color: String(teamColor || "").trim()
    });
  };
  (tjson?.teams || []).forEach((team) => add(team?.teamId || team?.id, team?.teamName || team?.name, team?.color));
  (tjson?.players || []).forEach((player) => add(player?.teamId, player?.teamName));
  teamColors.reset(ordered.length);
  ordered.forEach((team) => teamColors.add(team.teamId, team.teamName, team.color));
}

function colorForTeam(teamId) {
  const id = normalizeTeamId(teamId);
  return teamColors.get(id);
}

function normalizeGroup(groupValue) {
  return String(groupValue || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 16);
}

function groupForPlayerRound(player, roundIndex) {
  if (Array.isArray(player?.groups)) {
    const v = normalizeGroup(player.groups[roundIndex]);
    if (v) return v;
  }
  if (roundIndex === 0) return normalizeGroup(player?.group);
  return "";
}

function twoManGroupId(teamId, label) {
  const team = String(teamId || "").trim();
  const g = normalizeGroup(label);
  if (!team || !g) return "";
  return `${team}::${g}`;
}

function uniqueDisplayNames(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const name = String(value || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function twoManPairLabel(groupPlayerIds, playersById, fallbackGroup) {
  const names = uniqueDisplayNames((groupPlayerIds || []).map((id) => playersById?.[id]?.name));
  if (names.length) return names.join("/");
  const group = normalizeGroup(fallbackGroup);
  return group ? `Group ${group}` : "Pair";
}

function normalizeTwoManFormat(format) {
  const fmt = String(format || "").trim().toLowerCase();
  if (fmt === "two_man") return "two_man_scramble";
  if (fmt === "two_man_scramble" || fmt === "two_man_shamble" || fmt === "two_man_best_ball") return fmt;
  return "";
}

function normalizeTeeValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function teeTimeForPlayerRound(player, roundIndex) {
  if (!player || roundIndex < 0) return "";
  if (Array.isArray(player.teeTimes)) {
    const v = normalizeTeeValue(player.teeTimes[roundIndex]);
    if (v) return v;
  }
  if (roundIndex === 0) {
    const fallback = normalizeTeeValue(player.teeTime);
    if (fallback) return fallback;
  }
  return "";
}

function teeTimeDisplayForPlayerRound(player, roundIndex) {
  if (!player || roundIndex < 0) return "";
  if (Array.isArray(player.teeTimes)) {
    const v = String(player.teeTimes[roundIndex] || "").trim();
    if (v) return v;
  }
  if (roundIndex === 0) {
    const fallback = String(player.teeTime || "").trim();
    if (fallback) return fallback;
  }
  return "";
}

function teeTimeDisplayValue(v) {
  return String(v || "").trim();
}

function teeTimeDisplayForPlayerIds(playerIds, playersById, roundIndex) {
  for (const pid of playerIds || []) {
    const player = playersById?.[pid];
    const v = teeTimeDisplayForPlayerRound(player, roundIndex);
    if (v) return v;
  }
  return "";
}

function teeTimeDisplayForTeamRound(teamId, playersById, roundIndex) {
  const tid = normalizeTeamId(teamId);
  if (!tid) return "";
  for (const player of Object.values(playersById || {})) {
    if (normalizeTeamId(player?.teamId) !== tid) continue;
    const v = teeTimeDisplayForPlayerRound(player, roundIndex);
    if (v) return v;
  }
  return "";
}

function hasAnyScore(arr) {
  if (!Array.isArray(arr)) return false;
  for (const v of arr) {
    if (v != null && Number(v) > 0) return true;
  }
  return false;
}

function rowHasAnyData(row) {
  if (!row) return false;
  if (Number(row.strokes || 0) > 0) return true;
  if (Number(row.gross || 0) > 0) return true;
  if (Number(row.net || 0) > 0) return true;
  if (hasAnyScore(row?.scores?.gross)) return true;
  if (hasAnyScore(row?.scores?.net)) return true;
  return false;
}

function toParText(v) {
  if (v == null || v === "") return "E";
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return "E";
    const up = s.toUpperCase();
    if (up === "E" || up === "EVEN" || s === "0" || s === "+0" || s === "-0") return "E";
    const n = Number(s);
    if (!Number.isNaN(n)) return n > 0 ? `+${Math.round(n)}` : `${Math.round(n)}`;
    return s;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || Math.round(n) === 0) return "E";
  const d = Math.round(n);
  return d > 0 ? `+${d}` : `${d}`;
}

function holeDeltaText(scoreValue, parValue) {
  const par = Number(parValue);
  if (!Number.isFinite(par) || par <= 0) return "";
  const score = Number(String(scoreValue ?? "").trim());
  if (!Number.isFinite(score) || score <= 0) return "";
  const diff = Math.round(score - par);
  return diff >= 0 ? `+${diff}` : `${diff}`;
}

function syncHoleDeltaLabel(labelEl, scoreValue, parValue) {
  if (!labelEl) return;
  const text = holeDeltaText(scoreValue, parValue);
  labelEl.textContent = text;
  labelEl.style.visibility = text ? "visible" : "hidden";
}

function toParFromKeys(row, keys) {
  for (const key of keys) {
    if (row?.[key] != null) return toParText(row[key]);
  }
  return null;
}

function sumHoles(arr) {
  return (arr || []).reduce((a, v) => a + (v == null ? 0 : Number(v) || 0), 0);
}

function grossForRow(row) {
  if (row?.gross != null) return row.gross;
  if (row?.grossTotal != null) return row.grossTotal;
  if (row?.scores?.grossTotal != null) return row.scores.grossTotal;
  if (Array.isArray(row?.scores?.gross)) return sumHoles(row.scores.gross);
  return null;
}

function netForRow(row) {
  if (row?.net != null) return row.net;
  if (row?.netTotal != null) return row.netTotal;
  if (row?.strokes != null) return row.strokes;
  if (row?.scores?.netTotal != null) return row.scores.netTotal;
  if (Array.isArray(row?.scores?.net)) return sumHoles(row.scores.net);
  return null;
}

function parDiffFromHoles(holes, pars) {
  if (!Array.isArray(holes) || !Array.isArray(pars)) return null;
  let diff = 0;
  let played = 0;
  for (let i = 0; i < 18; i += 1) {
    const score = holes[i];
    if (score == null || Number(score) <= 0) continue;
    played += 1;
    diff += Number(score) - Number(pars[i] || 0);
  }
  return played ? toParText(diff) : null;
}

function grossToParText(row, pars) {
  const explicit = toParFromKeys(row, [
    "toParGross",
    "grossToPar",
    "toParGrossTotal",
    "grossToParTotal",
  ]);
  if (explicit != null) return explicit;
  const fromScores = parDiffFromHoles(row?.scores?.gross, pars);
  if (fromScores != null) return fromScores;
  const gross = grossForRow(row);
  const parTotal = sumHoles(pars);
  if (gross != null && parTotal > 0 && Number(row?.thru || 0) >= 18) {
    return toParText(Number(gross) - parTotal);
  }
  return toParText(row?.toPar);
}

function netToParText(row, pars) {
  const explicit = toParFromKeys(row, [
    "toParNet",
    "netToPar",
    "toParNetTotal",
    "netToParTotal",
  ]);
  if (explicit != null) return explicit;
  const fromScores = parDiffFromHoles(row?.scores?.net, pars);
  if (fromScores != null) return fromScores;
  const net = netForRow(row);
  const parTotal = sumHoles(pars);
  if (net != null && parTotal > 0 && Number(row?.thru || 0) >= 18) {
    return toParText(Number(net) - parTotal);
  }
  return toParText(row?.toPar);
}

function leaderboardToParValue(row, pars, showGrossAndNet = false) {
  if (showGrossAndNet) {
    const gross = grossToParText(row, pars);
    const net = netToParText(row, pars);
    return `${gross} [${net}]`;
  }
  const keys = ["toPar", "netToPar", "toParNet", "toParTotal", "toParNetTotal", "toParGross", "grossToPar"];
  for (const key of keys) {
    if (row?.[key] != null) return toParText(row[key]);
  }
  return "E";
}

function normalizePostedScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function scoreResultLabel(diffToPar) {
  if (diffToPar <= -3) return "Albatross";
  if (diffToPar === -2) return "Eagle";
  if (diffToPar === -1) return "Birdie";
  if (diffToPar === 0) return "Par";
  if (diffToPar === 1) return "Bogey";
  if (diffToPar === 2) return "Double Bogey";
  if (diffToPar === 3) return "Triple Bogey";
  return `${diffToPar} Over`;
}

function holeDisplayFromThru(row) {
  const thru = Number(row?.thru || 0);
  if (!Number.isFinite(thru) || thru <= 0) return "(-)";
  return `(${Math.floor(thru)})`;
}

function holeOrTeeDisplay(row, teeTimeText) {
  const tee = teeTimeDisplayValue(teeTimeText);
  if (!rowHasAnyData(row) && tee) return `(${tee})`;
  return holeDisplayFromThru(row);
}

function toParNumber(v) {
  const s = String(v == null ? "" : v).trim().toUpperCase();
  if (!s || s === "E" || s === "EVEN") return 0;
  const n = Number(s);
  if (!Number.isNaN(n)) return n;
  return Number.POSITIVE_INFINITY;
}

function roundHasAnyData(roundData) {
  if (!roundData) return false;
  for (const row of roundData?.leaderboard?.teams || []) {
    if (rowHasAnyData(row)) return true;
  }
  for (const row of roundData?.leaderboard?.players || []) {
    if (rowHasAnyData(row)) return true;
  }
  for (const team of Object.values(roundData?.team || {})) {
    if (hasAnyScore(team?.gross) || hasAnyScore(team?.net)) return true;
  }
  for (const player of Object.values(roundData?.player || {})) {
    if (hasAnyScore(player?.gross) || hasAnyScore(player?.net)) return true;
  }
  return false;
}

function isEmptyScore(v) {
  return v == null || Number(v) === 0;
}

function normalizeScoreArray(arr) {
  return (Array.isArray(arr) ? arr : Array(18).fill(null)).map((v) => (isEmptyScore(v) ? null : Number(v)));
}

function isCompleteScoreArray(arr) {
  return normalizeScoreArray(arr).every((v) => !isEmptyScore(v));
}

function nextHoleIndexForGroup(savedByTarget, targetIds) {
  for (let i = 0; i < 18; i += 1) {
    for (const id of targetIds || []) {
      const arr = savedByTarget[id] || Array(18).fill(null);
      if (isEmptyScore(arr[i])) return i;
    }
  }
  return 17;
}

function courseListFromTournamentRaw(tjson) {
  if (Array.isArray(tjson?.courses) && tjson.courses.length) return tjson.courses;
  if (tjson?.course && typeof tjson.course === "object") return [tjson.course];
  return [];
}

function courseForRoundRaw(tjson, roundIndex) {
  const courses = courseListFromTournamentRaw(tjson);
  if (!courses.length) return null;
  const rounds = tjson?.tournament?.rounds || [];
  const idxRaw = Number(rounds?.[roundIndex]?.courseIndex);
  const idx = Number.isInteger(idxRaw) && idxRaw >= 0 && idxRaw < courses.length ? idxRaw : 0;
  return courses[idx] || courses[0] || null;
}

function courseParsForRound(tjson, roundIndex) {
  const rawPars = courseForRoundRaw(tjson, roundIndex)?.pars;
  return Array.from({ length: 18 }, (_, idx) => Number(rawPars?.[idx]) || 4);
}

function holeYardageForRound(tjson, roundIndex, holeIndex) {
  const roundYardages = holeYardagesForRound(tjson, roundIndex) || fallbackHoleYardages();
  const value = Number(roundYardages?.[holeIndex]);
  return Number.isFinite(value) ? value : null;
}

function scoreSourceForRound(roundData, roundCfg) {
  const format = String(roundCfg?.format || "").toLowerCase();
  if (format === "scramble") {
    const teamEntries = Object.entries(roundData?.team || {});
    return { type: "team", entries: teamEntries };
  }

  const playerEntries = Object.entries(roundData?.player || {});
  if (playerEntries.length) return { type: "player", entries: playerEntries };
  const teamEntries = Object.entries(roundData?.team || {});
  return { type: "team", entries: teamEntries };
}

function collectNewScoreEvents(prevTournament, nextTournament) {
  if (!prevTournament || !nextTournament) return [];

  const events = [];
  const prevRounds = prevTournament?.score_data?.rounds || [];
  const nextRounds = nextTournament?.score_data?.rounds || [];
  const prevRoundCfgs = prevTournament?.tournament?.rounds || [];
  const nextRoundCfgs = nextTournament?.tournament?.rounds || [];

  const playerNames = new Map();
  (nextTournament?.players || []).forEach((player) => {
    const id = String(player?.playerId || "").trim();
    if (id) playerNames.set(id, player?.name || id);
  });

  const teamNames = new Map();
  (nextTournament?.teams || []).forEach((team) => {
    const id = String(team?.teamId ?? team?.id ?? "").trim();
    if (id) teamNames.set(id, team?.teamName ?? team?.name ?? id);
  });

  for (let roundIndex = 0; roundIndex < nextRounds.length; roundIndex += 1) {
    const nextRound = nextRounds[roundIndex] || {};
    const prevRound = prevRounds[roundIndex] || {};
    const nextRoundCfg = nextRoundCfgs[roundIndex] || {};
    const prevRoundCfg = prevRoundCfgs[roundIndex] || nextRoundCfg;
    const coursePars = courseParsForRound(nextTournament, roundIndex);
    const nextSource = scoreSourceForRound(nextRound, nextRoundCfg);
    if (!nextSource.entries.length) continue;

    const prevSource = scoreSourceForRound(prevRound, prevRoundCfg);
    const prevById = new Map(
      prevSource.entries.map(([id, entry]) => [String(id || "").trim(), entry || {}])
    );

    const playerRows = new Map();
    (nextRound?.leaderboard?.players || []).forEach((row) => {
      const id = String(row?.playerId || "").trim();
      if (id) playerRows.set(id, row);
    });

    const teamRows = new Map();
    (nextRound?.leaderboard?.teams || []).forEach((row) => {
      const id = String(row?.teamId || "").trim();
      if (id) teamRows.set(id, row);
    });

    for (const [idRaw, nextEntry] of nextSource.entries) {
      const id = String(idRaw || "").trim();
      if (!id) continue;

      const prevEntry = prevSource.type === nextSource.type ? prevById.get(id) : null;
      const row = nextSource.type === "player" ? playerRows.get(id) : teamRows.get(id);
      const name =
        nextSource.type === "player"
          ? row?.name || playerNames.get(id) || id
          : row?.teamName || teamNames.get(id) || id;

      const showGrossAndNet = !!nextRoundCfg.useHandicap;
      const grossToPar = showGrossAndNet ? grossToParText(row, coursePars) : null;
      const netToPar = showGrossAndNet ? netToParText(row, coursePars) : null;
      const toPar = showGrossAndNet
        ? `${grossToPar} [${netToPar}]`
        : leaderboardToParValue(row, coursePars, false);

      for (let holeIndex = 0; holeIndex < 18; holeIndex += 1) {
        const nextGross = normalizePostedScore(nextEntry?.gross?.[holeIndex]);
        if (nextGross == null) continue;

        const prevGross = normalizePostedScore(prevEntry?.gross?.[holeIndex]);
        if (prevGross != null) continue;

        const par = Number(coursePars?.[holeIndex] || 0);
        const diffToPar = par > 0 ? nextGross - par : 0;
        events.push({
          name,
          result: scoreResultLabel(diffToPar),
          toPar,
          grossToPar,
          netToPar,
          hole: holeIndex + 1,
          diffToPar,
        });
      }
    }
  }

  return events;
}

function renderScoreNotifierEvent(event) {
  if (!scoreNotifier || !event) return;
  scoreNotifier.innerHTML = "";
  scoreNotifier.classList.remove("score-under", "score-over", "score-even", "score-light", "score-dark");

  const diffToPar = Number(event.diffToPar);
  let toneClass = "score-even";
  if (diffToPar < 0) toneClass = "score-under";
  if (diffToPar > 0) toneClass = "score-over";
  const shadeClass = Math.abs(diffToPar) >= 2 ? "score-dark" : "score-light";
  scoreNotifier.classList.add(toneClass);
  if (toneClass !== "score-even") scoreNotifier.classList.add(shadeClass);

  const line = document.createElement("div");
  line.className = "score-notifier-line";
  line.appendChild(document.createTextNode(`${event.name} ${event.result} (`));
  if (event.grossToPar != null && event.netToPar != null) {
    const grossEl = document.createElement("span");
    grossEl.className = "score-emph-gross";
    grossEl.textContent = String(event.grossToPar);
    line.appendChild(grossEl);
    line.appendChild(document.createTextNode(" ["));
    const netEl = document.createElement("span");
    netEl.className = "score-emph-net";
    netEl.textContent = String(event.netToPar);
    line.appendChild(netEl);
    line.appendChild(document.createTextNode("]"));
  } else {
    line.appendChild(document.createTextNode(String(event.toPar ?? "E")));
  }
  line.appendChild(document.createTextNode(`) ${event.hole}`));
  scoreNotifier.appendChild(line);
}

function pumpScoreNotifierQueue() {
  if (!scoreNotifier || scoreNotifierActive || !scoreNotifierQueue.length) return;
  scoreNotifierActive = true;

  const next = scoreNotifierQueue.shift();
  renderScoreNotifierEvent(next);
  scoreNotifier.classList.add("show");
  if (scoreNotifierTimerId) clearTimeout(scoreNotifierTimerId);

  scoreNotifierTimerId = window.setTimeout(() => {
    scoreNotifier.classList.remove("show");
    scoreNotifierTimerId = window.setTimeout(() => {
      scoreNotifierActive = false;
      if (scoreNotifierQueue.length) {
        pumpScoreNotifierQueue();
        return;
      }
      scoreNotifier.innerHTML = "";
      scoreNotifier.classList.remove("score-under", "score-over", "score-even", "score-light", "score-dark");
    }, SCORE_NOTIFIER_GAP_MS);
  }, SCORE_NOTIFIER_SHOW_MS);
}

function showScoreNotifier(events) {
  if (!scoreNotifier || !events.length) return;
  scoreNotifierQueue.push(...events);
  pumpScoreNotifierQueue();
}

function sortTickerEntries(entries) {
  entries.sort((a, b) => {
    if (a.hasData !== b.hasData) return a.hasData ? -1 : 1;
    if (a.parNum !== b.parNum) return a.parNum - b.parNum;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

function stopTickerRotation() {
  tickerRunToken += 1;
  tickerLoopRunning = false;
  if (tickerRafId) {
    cancelAnimationFrame(tickerRafId);
    tickerRafId = 0;
  }
  if (tickerHoldTimerId) {
    clearTimeout(tickerHoldTimerId);
    tickerHoldTimerId = 0;
  }
  tickerRunEl = null;
  tickerSections = [];
}

function buildTickerRun(section) {
  const run = el("div", { class: "enter-ticker-run" });
  if (section.items.length) {
    section.items.forEach((item) => run.appendChild(item));
  } else {
    run.appendChild(el("span", { class: "small" }, "No scores yet"));
  }
  return run;
}

function setTickerSection(section, preservePosition = false) {
  if (!ticker || !tickerTrack || !tickerTitle) return;
  tickerTitle.textContent = section.label;

  const run = buildTickerRun(section);

  tickerTrack.innerHTML = "";
  tickerTrack.appendChild(run);
  tickerRunEl = run;

  const viewport = tickerTrack.parentElement;
  tickerEndX = viewport ? -run.offsetWidth : 0;
  if (!preservePosition) tickerCurrentX = 0;
  if (tickerCurrentX < tickerEndX) tickerCurrentX = tickerEndX;

  run.style.transform = `translateX(${Math.round(tickerCurrentX)}px)`;
  run.style.willChange = "transform";
  if (!preservePosition) {
    tickerPhase = "hold";
    tickerPhaseStartedAt = performance.now();
    tickerPrevTs = 0;
  }
}

function runTickerFrame(ts) {
  if (!tickerLoopRunning || !tickerSections.length) return;
  if (!tickerRunEl) {
    tickerRafId = requestAnimationFrame(runTickerFrame);
    return;
  }

  if (!tickerPrevTs) tickerPrevTs = ts;
  const dt = (ts - tickerPrevTs) / 1000;
  tickerPrevTs = ts;

  if (tickerPhase === "hold") {
    if (ts - tickerPhaseStartedAt >= TICKER_START_DELAY_MS) {
      tickerPhase = "scroll";
    }
  } else if (tickerPhase === "scroll") {
    tickerCurrentX -= TICKER_SPEED_PX_PER_SEC * dt;
    tickerRunEl.style.transform = `translateX(${Math.round(tickerCurrentX)}px)`;
    if (tickerCurrentX <= tickerEndX) {
      tickerCurrentX = tickerEndX;
      tickerRunEl.style.transform = `translateX(${Math.round(tickerCurrentX)}px)`;
      tickerPhase = "next_hold";
      tickerPhaseStartedAt = ts;
    }
  } else if (tickerPhase === "next_hold") {
    if (ts - tickerPhaseStartedAt >= TICKER_NEXT_DELAY_MS) {
      tickerSectionIndex = (tickerSectionIndex + 1) % tickerSections.length;
      setTickerSection(tickerSections[tickerSectionIndex], false);
      updateMapTickerStickyState();
    }
  }

  tickerRafId = requestAnimationFrame(runTickerFrame);
}

function updateMapTickerStickyState() {
  syncHoleControlsStickyOffset();
  if (ticker) ticker.classList.remove("is-stuck");
  if (tickerShell) tickerShell.style.height = "";
}

function renderTicker(tjson, playersById, teamsById, roundIndex) {
  if (!ticker || !tickerTrack || !tickerTitle) return;

  const rounds = tjson?.tournament?.rounds || [];
  if (!rounds.length) {
    stopTickerRotation();
    ticker.style.display = "";
    tickerTitle.textContent = "Scores";
    const run = el("div", { class: "enter-ticker-run" });
    run.appendChild(el("span", { class: "small" }, "No rounds yet"));
    tickerTrack.innerHTML = "";
    tickerTrack.appendChild(run);
    updateMapTickerStickyState();
    return;
  }
  const currentRound = Number(roundIndex);
  const safeRound = Number.isInteger(currentRound) && currentRound >= 0 && currentRound < rounds.length ? currentRound : 0;
  const roundData = tjson?.score_data?.rounds?.[safeRound] || {};
  const roundCfg = rounds[safeRound] || {};
  const isSingleRoundTournament = rounds.length === 1;
  const roundFormat = String(roundCfg.format || "").toLowerCase();
  const isScrambleRound = roundFormat === "scramble";
  const isTwoManRound = !!normalizeTwoManFormat(roundFormat);
  const showIndividualGross = !isScrambleRound;
  const showIndividualNet = !!roundCfg.useHandicap && !isScrambleRound;
  const pars = courseParsForRound(tjson, safeRound);

  const playerLeaderboardRows = roundData?.leaderboard?.players || [];
  const playerRowById = Object.create(null);
  for (const row of playerLeaderboardRows) {
    const id = String(row?.playerId || "").trim();
    if (!id) continue;
    playerRowById[id] = row;
  }
  const teamLeaderboardAll = tjson?.score_data?.leaderboard_all?.teams || [];
  const teamLeaderboardRound = roundData?.leaderboard?.teams || [];
  const teamDefs = tjson?.teams || [];

  const allTeamIds = [];
  const seenTeamIds = new Set();
  function addTeamId(teamId) {
    const id = normalizeTeamId(teamId);
    if (!id || seenTeamIds.has(id)) return;
    seenTeamIds.add(id);
    allTeamIds.push(id);
  }
  teamDefs.forEach((team) => addTeamId(team?.teamId || team?.id));
  teamLeaderboardAll.forEach((row) => addTeamId(row?.teamId));
  teamLeaderboardRound.forEach((row) => addTeamId(row?.teamId));

  const teamAllById = Object.create(null);
  for (const row of teamLeaderboardAll) {
    const id = normalizeTeamId(row?.teamId);
    if (!id) continue;
    teamAllById[id] = row;
  }
  const teamRoundById = Object.create(null);
  for (const row of teamLeaderboardRound) {
    const id = normalizeTeamId(row?.teamId);
    if (!id) continue;
    teamRoundById[id] = row;
  }

  const roundLabel = `Round ${safeRound + 1}`;

  const allPlayerIds = [];
  const seenPlayerIds = new Set();
  function addPlayerId(playerId) {
    const id = String(playerId || "").trim();
    if (!id || seenPlayerIds.has(id)) return;
    seenPlayerIds.add(id);
    allPlayerIds.push(id);
  }
  Object.keys(playersById || {}).forEach(addPlayerId);
  playerLeaderboardRows.forEach((row) => addPlayerId(row?.playerId));

  const allPlayers = Object.values(playersById || {});
  const individualTickerRows = [];
  if (isTwoManRound) {
    function findTwoManGroupEntry(teamId, groupLabel) {
      const groups = roundData?.team?.[teamId]?.groups || {};
      const wanted = normalizeGroup(groupLabel);
      for (const [rawLabel, entry] of Object.entries(groups)) {
        if (normalizeGroup(rawLabel) === wanted) return entry || null;
      }
      return null;
    }

    function fallbackRowFromGroupEntry(groupEntry) {
      const gross = (Array.isArray(groupEntry?.gross) ? groupEntry.gross : Array(18).fill(null))
        .map((v) => (v == null || Number(v) <= 0 ? null : Number(v)));
      const net = (Array.isArray(groupEntry?.net) ? groupEntry.net : gross)
        .map((v) => (v == null || Number(v) <= 0 ? null : Number(v)));
      const thru = gross.reduce((acc, v) => acc + (v != null ? 1 : 0), 0);
      return {
        thru,
        scores: {
          gross,
          net,
          grossTotal: sumHoles(gross),
          netTotal: sumHoles(net),
          thru,
        },
      };
    }

    const seenGroups = new Set();
    function addGroup(teamIdRaw, groupLabelRaw) {
      const teamId = normalizeTeamId(teamIdRaw);
      const group = normalizeGroup(groupLabelRaw);
      const gid = twoManGroupId(teamId, group);
      if (!gid || seenGroups.has(gid)) return;
      seenGroups.add(gid);

      const groupPlayerIds = allPlayers
        .filter((player) => normalizeTeamId(player?.teamId) === teamId && groupForPlayerRound(player, safeRound) === group)
        .map((player) => player?.playerId)
        .filter(Boolean);

      let row = groupPlayerIds.map((pid) => playerRowById[pid]).find(Boolean) || null;
      if (!row) {
        const groupEntry = findTwoManGroupEntry(teamId, group);
        if (groupEntry) row = fallbackRowFromGroupEntry(groupEntry);
      }

      const teamName = teamsById[teamId]?.teamName || teamId || "Team";
      const pairLabel = twoManPairLabel(groupPlayerIds, playersById, group);
      individualTickerRows.push({
        name: `${pairLabel} | ${teamName}`,
        teamId,
        teeTime:
          teeTimeDisplayForPlayerIds(groupPlayerIds, playersById, safeRound) ||
          teeTimeDisplayForTeamRound(teamId, playersById, safeRound),
        row,
      });
    }

    allPlayers.forEach((player) => addGroup(player?.teamId, groupForPlayerRound(player, safeRound)));
    Object.entries(roundData?.team || {}).forEach(([teamId, teamEntry]) => {
      Object.keys(teamEntry?.groups || {}).forEach((groupLabel) => addGroup(teamId, groupLabel));
    });
  } else {
    allPlayerIds.forEach((playerId) => {
      const row = playerRowById[playerId] || null;
      const player = playersById[playerId] || {};
      individualTickerRows.push({
        name: row?.name || player?.name || playerId || "Player",
        teamId: row?.teamId || player?.teamId,
        teeTime: teeTimeDisplayForPlayerRound(player, safeRound),
        row,
      });
    });
  }

  const playerGrossEntries = individualTickerRows.map((entry) => {
    const row = entry?.row || null;
    const color = colorForTeam(entry?.teamId);
    const hasData = rowHasAnyData(row);
    const holeText = holeOrTeeDisplay(row, entry?.teeTime);
    const parText = grossToParText(row, pars);
    return {
      name: entry?.name || "Player",
      hasData,
      parNum: hasData ? toParNumber(parText) : Number.POSITIVE_INFINITY,
      node: el(
        "span",
        { class: "enter-ticker-item team-accent", style: `--team-accent:${color};` },
        `${entry?.name || "Player"} ${parText} ${holeText}`
      ),
    };
  });
  sortTickerEntries(playerGrossEntries);
  const playerGrossItems = playerGrossEntries.map((x) => x.node);

  const playerNetEntries = individualTickerRows.map((entry) => {
    const row = entry?.row || null;
    const color = colorForTeam(entry?.teamId);
    const hasData = rowHasAnyData(row);
    const holeText = holeOrTeeDisplay(row, entry?.teeTime);
    const parText = netToParText(row, pars);
    return {
      name: entry?.name || "Player",
      hasData,
      parNum: hasData ? toParNumber(parText) : Number.POSITIVE_INFINITY,
      node: el(
        "span",
        { class: "enter-ticker-item team-accent", style: `--team-accent:${color};` },
        `${entry?.name || "Player"} ${parText} ${holeText}`
      ),
    };
  });
  sortTickerEntries(playerNetEntries);
  const playerNetItems = playerNetEntries.map((x) => x.node);

  const teamTournamentEntries = allTeamIds.map((teamId) => {
    const row = teamAllById[teamId] || null;
    const color = colorForTeam(teamId);
    const hasData = rowHasAnyData(row);
    const teamName = row?.teamName || teamsById[teamId]?.teamName || teamId || "Team";
    const parText = netToParText(row, pars);
    return {
      name: teamName,
      color,
      hasData,
      parNum: hasData ? toParNumber(parText) : Number.POSITIVE_INFINITY,
      node: el(
        "span",
        { class: "enter-ticker-item team-accent", style: `--team-accent:${color};` },
        `${teamName} ${parText}`
      ),
    };
  });
  sortTickerEntries(teamTournamentEntries);
  const teamTournamentItems = teamTournamentEntries.map((x) => x.node);

  const teamRoundEntries = allTeamIds.map((teamId) => {
    const row = teamRoundById[teamId] || null;
    const color = colorForTeam(teamId);
    const hasData = rowHasAnyData(row);
    const holeText = holeOrTeeDisplay(row, teeTimeDisplayForTeamRound(teamId, playersById, safeRound));
    const teamName = row?.teamName || teamsById[teamId]?.teamName || teamId || "Team";
    const parText = netToParText(row, pars);
    return {
      name: teamName,
      color,
      hasData,
      parNum: hasData ? toParNumber(parText) : Number.POSITIVE_INFINITY,
      node: el(
        "span",
        { class: "enter-ticker-item team-accent", style: `--team-accent:${color};` },
        `${teamName} ${parText} ${holeText}`
      ),
    };
  });
  sortTickerEntries(teamRoundEntries);
  const teamRoundItems = teamRoundEntries.map((x) => x.node);

  const teamRoundGrossEntries = allTeamIds.map((teamId) => {
    const row = teamRoundById[teamId] || null;
    const color = colorForTeam(teamId);
    const hasData = rowHasAnyData(row);
    const holeText = holeOrTeeDisplay(row, teeTimeDisplayForTeamRound(teamId, playersById, safeRound));
    const teamName = row?.teamName || teamsById[teamId]?.teamName || teamId || "Team";
    const parText = grossToParText(row, pars);
    return {
      name: teamName,
      color,
      hasData,
      parNum: hasData ? toParNumber(parText) : Number.POSITIVE_INFINITY,
      node: el(
        "span",
        { class: "enter-ticker-item team-accent", style: `--team-accent:${color};` },
        `${teamName} ${parText} ${holeText}`
      ),
    };
  });
  sortTickerEntries(teamRoundGrossEntries);
  const teamRoundGrossItems = teamRoundGrossEntries.map((x) => x.node);

  const leadingTournamentTeam = teamTournamentEntries.find((x) => x.hasData);
  setBrandDotColor((leadingTournamentTeam || null)?.color || null);

  const individualGrossLabel = isTwoManRound ? "Groups Gross" : "Gross";
  const individualNetLabel = isTwoManRound ? "Groups Net" : "Net";
  const sections = [];
  if (isSingleRoundTournament) {
    if (isScrambleRound) {
      sections.push({ label: `${roundLabel} (Net)`, items: teamRoundItems });
      sections.push({ label: `${roundLabel} (Gross)`, items: teamRoundGrossItems });
    } else {
      sections.push({ label: `${roundLabel} (${individualGrossLabel})`, items: playerGrossItems });
      sections.push({ label: `${roundLabel} (${individualNetLabel})`, items: playerNetItems });
    }
  } else {
    if (showIndividualGross) {
      sections.push({ label: `${roundLabel} (${individualGrossLabel})`, items: playerGrossItems });
    }
    if (showIndividualNet) {
      sections.push({ label: `${roundLabel} (${individualNetLabel})`, items: playerNetItems });
    }
    if (isScrambleRound) {
      sections.push({ label: `${roundLabel} (Net)`, items: teamRoundItems });
      sections.push({ label: "Tournament (Net)", items: teamTournamentItems });
    } else {
      sections.push({ label: "Tournament (Team Net)", items: teamTournamentItems });
      sections.push({ label: `${roundLabel} (Team Net)`, items: teamRoundItems });
    }
  }

  if (!sections.length) {
    stopTickerRotation();
    ticker.style.display = "";
    tickerTitle.textContent = "Scores";
    const run = el("div", { class: "enter-ticker-run" });
    run.appendChild(el("span", { class: "small" }, "No scores yet"));
    tickerTrack.innerHTML = "";
    tickerTrack.appendChild(run);
    updateMapTickerStickyState();
    return;
  }

  ticker.style.display = "";
  tickerSections = sections;
  if (!tickerLoopRunning) {
    tickerLoopRunning = true;
    tickerSectionIndex = 0;
    tickerCurrentX = 0;
    setTickerSection(tickerSections[tickerSectionIndex], false);
    tickerRafId = requestAnimationFrame(runTickerFrame);
    updateMapTickerStickyState();
    return;
  }

  if (tickerSectionIndex >= tickerSections.length) tickerSectionIndex = 0;
  setTickerSection(tickerSections[tickerSectionIndex], true);
  updateMapTickerStickyState();
}

function mapModeLabel(mode) {
  return mode === MAP_MODE_FULL ? "Advanced map" : "Satellite map";
}

function availableMapModesFromMeta(meta) {
  const available = [];
  if (meta?.has_full_map) available.push(MAP_MODE_FULL);
  if (meta?.has_simplified_map) available.push(MAP_MODE_SIMPLIFIED);
  const level = String(meta?.map_level || "").toLowerCase();
  if ((level === MAP_MODE_FULL || level === MAP_MODE_SIMPLIFIED) && !available.includes(level)) {
    available.push(level);
  }
  return available;
}

function orderedMapModes(availableModes, preferredMode) {
  const unique = Array.from(new Set(Array.isArray(availableModes) ? availableModes : []));
  if (!unique.length) return [];
  if (!preferredMode || !unique.includes(preferredMode)) return unique;
  return [preferredMode, ...unique.filter((mode) => mode !== preferredMode)];
}

function updateMapInfoText(mapMeta, mode) {
  if (!els.mapInfo) return;
  const name = mapMeta?.name || mapMeta?.slug || "Course";
  els.mapInfo.textContent = `${name} • ${mapModeLabel(mode)}`;
}

function updateMapModeToggleUi(mapMeta, availableModes, activeMode) {
  void mapMeta;
  void availableModes;
  void activeMode;
  if (!els.mapModeToggle) return;
  els.mapModeToggle.style.display = "none";
}

function setScoreStatus(message, isError = false) {
  if (!els.scoreStatus) return;
  els.scoreStatus.textContent = message || "";
  els.scoreStatus.style.color = isError ? "var(--bad)" : "";
}

function syncScoreHoleMeta(holeNumber = state.currentHole) {
  if (!els.scoreHoleMeta) return;
  const hole = Number(holeNumber);
  if (!Number.isFinite(hole) || hole < 1) {
    els.scoreHoleMeta.textContent = "";
    els.scoreHoleMeta.hidden = true;
    return;
  }
  els.scoreHoleMeta.hidden = entryState.scorePanelMode === "code";
  els.scoreHoleMeta.textContent = formatHoleSummaryText(
    hole,
    parForHoleNumber(hole),
    totalYardageForHoleNumber(hole)
  );
}

function syncTickerMount() {
  if (!tickerShell) return;
  const wantsScorePanelTicker =
    entryState.scorePanelExpanded &&
    entryState.scorePanelMode === "scores" &&
    els.scoreTickerHost;
  const target = wantsScorePanelTicker ? els.scoreTickerHost : tickerHome;
  if (!target || tickerShell.parentElement === target) return;
  target.appendChild(tickerShell);
  updateMapTickerStickyState();
}

function setScoreCardMode(mode = "scores") {
  entryState.scorePanelMode = mode === "code" ? "code" : "scores";
  const isCodeMode = entryState.scorePanelMode === "code";
  if (els.scoreTitle) els.scoreTitle.textContent = isCodeMode ? "Enter Code" : "Enter Scores";
  if (els.scoreHoleMeta) els.scoreHoleMeta.hidden = isCodeMode || !String(els.scoreHoleMeta.textContent || "").trim();
  if (els.roundTabs) els.roundTabs.hidden = isCodeMode;
  if (els.scoreActions) els.scoreActions.hidden = isCodeMode;
  if (els.scoreCloseButton) els.scoreCloseButton.hidden = isCodeMode;
  if (els.scoreChangeCodeButton) els.scoreChangeCodeButton.hidden = isCodeMode;
  syncTickerMount();
}

function updateScoreSubmitButton({ hidden = false, disabled = false, label = "Enter" } = {}) {
  const collapsed = !entryState.scorePanelExpanded;
  const codeMode = entryState.scorePanelMode === "code";
  if (els.scoreSubmitDock) els.scoreSubmitDock.hidden = hidden || !collapsed || codeMode;
  if (els.scoreSubmitButton) {
    els.scoreSubmitButton.disabled = disabled;
    els.scoreSubmitButton.textContent = label;
  }
  if (els.scoreSubmitInline) {
    els.scoreSubmitInline.hidden = hidden || collapsed || codeMode;
    els.scoreSubmitInline.disabled = disabled;
    els.scoreSubmitInline.textContent = label;
  }
  syncScoreNotifierOffset();
}

function setScoreCardExpanded(expanded, { focus = false } = {}) {
  entryState.scorePanelExpanded = Boolean(expanded);
  if (!entryState.scorePanelExpanded && entryState.activeScoreWheel?.close) {
    entryState.activeScoreWheel.close({ restoreFocus: false });
  }
  if (els.scoreCard) {
    els.scoreCard.hidden = !entryState.scorePanelExpanded;
    els.scoreCard.setAttribute("aria-hidden", entryState.scorePanelExpanded ? "false" : "true");
    if (entryState.scorePanelExpanded) els.scoreCard.scrollTop = 0;
  }
  document.body.classList.toggle("hole-map-score-open", entryState.scorePanelExpanded);
  syncTickerMount();
  updateScoreSubmitButton({
    hidden: !(entryState.currentInputs?.length > 0),
    disabled: entryState.submitting,
    label: entryState.submitting ? "Entering…" : "Enter",
  });
  if (focus && entryState.scorePanelExpanded) {
    window.requestAnimationFrame(() => focusPrimaryScoreInput());
  }
}

function focusPrimaryScoreInput() {
  const firstInput = entryState.currentInputs?.[0];
  const target = firstInput?.focusTarget || firstInput?.input;
  if (!target) return;
  try {
    target.focus({ preventScroll: true });
  } catch (_) {
    target.focus();
  }
  if (typeof target.select === "function") target.select();
}

function normalizeScoreWheelValue(value) {
  if (value == null) return "";
  const raw = String(value).trim();
  if (!raw) return "";
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return "";
  return String(Math.max(SCORE_WHEEL_MIN, Math.min(SCORE_WHEEL_MAX, Math.round(parsed))));
}

function createScoreWheel(initialValue, { onChange } = {}) {
  const hiddenInput = document.createElement("input");
  hiddenInput.type = "hidden";
  hiddenInput.value = normalizeScoreWheelValue(initialValue);

  const shell = document.createElement("div");
  shell.className = "score-wheel-shell";

  const displayButton = document.createElement("button");
  displayButton.type = "button";
  displayButton.className = "score-wheel-display";
  displayButton.setAttribute("aria-haspopup", "listbox");
  shell.appendChild(displayButton);

  const viewport = document.createElement("div");
  viewport.className = "score-wheel";
  viewport.tabIndex = 0;
  viewport.setAttribute("data-score-wheel", "true");
  viewport.setAttribute("role", "listbox");
  viewport.setAttribute("aria-label", "Hole score");
  viewport.hidden = true;

  const track = document.createElement("div");
  track.className = "score-wheel-track";
  viewport.appendChild(track);
  shell.appendChild(viewport);
  shell.appendChild(hiddenInput);

  const optionByValue = new Map();
  let selectedValue = hiddenInput.value;
  let scrollSettleTimerId = 0;
  let isOpen = false;
  let removeOutsidePointerListener = null;

  function currentOption() {
    return optionByValue.get(selectedValue) || optionByValue.get("") || null;
  }

  function updateDisplayUi() {
    const text = selectedValue || "—";
    displayButton.textContent = text;
    displayButton.classList.toggle("is-empty", !selectedValue);
    displayButton.setAttribute("aria-label", selectedValue ? `Hole score ${selectedValue}` : "Set hole score");
    displayButton.setAttribute("aria-expanded", isOpen ? "true" : "false");
  }

  function updateSelectionUi() {
    for (const [value, option] of optionByValue.entries()) {
      const isActive = value === selectedValue;
      option.classList.toggle("is-active", isActive);
      option.setAttribute("aria-selected", isActive ? "true" : "false");
    }
    const activeOption = currentOption();
    if (activeOption?.id) viewport.setAttribute("aria-activedescendant", activeOption.id);
  }

  function centerOption(option, behavior = "smooth") {
    if (!option) return;
    const left = option.offsetLeft - (viewport.clientWidth - option.offsetWidth) / 2;
    viewport.scrollTo({
      left: Math.max(0, left),
      behavior,
    });
  }

  function setValue(nextValue, { align = true, behavior = "smooth", emit = true } = {}) {
    const normalized = normalizeScoreWheelValue(nextValue);
    const changed = normalized !== selectedValue;
    selectedValue = normalized;
    hiddenInput.value = normalized;
    updateSelectionUi();
    updateDisplayUi();
    if (align) centerOption(currentOption(), behavior);
    if (changed && typeof onChange === "function") onChange(normalized);
  }

  function open({ focusViewport = false } = {}) {
    if (isOpen) return;
    if (entryState.activeScoreWheel && entryState.activeScoreWheel !== controls) {
      entryState.activeScoreWheel.close({ restoreFocus: false });
    }
    isOpen = true;
    shell.classList.add("is-active");
    viewport.hidden = false;
    updateDisplayUi();
    centerOption(currentOption(), "auto");
    entryState.activeScoreWheel = controls;
    if (!removeOutsidePointerListener) {
      const onPointerDownOutside = (event) => {
        if (shell.contains(event.target)) return;
        close({ restoreFocus: false });
      };
      document.addEventListener("pointerdown", onPointerDownOutside, true);
      removeOutsidePointerListener = () => {
        document.removeEventListener("pointerdown", onPointerDownOutside, true);
        removeOutsidePointerListener = null;
      };
    }
    if (focusViewport) {
      window.requestAnimationFrame(() => {
        try {
          viewport.focus({ preventScroll: true });
        } catch (_) {
          viewport.focus();
        }
      });
    }
  }

  function close({ restoreFocus = false } = {}) {
    if (!isOpen) return;
    isOpen = false;
    shell.classList.remove("is-active");
    viewport.hidden = true;
    if (removeOutsidePointerListener) removeOutsidePointerListener();
    updateDisplayUi();
    if (entryState.activeScoreWheel === controls) entryState.activeScoreWheel = null;
    if (restoreFocus) {
      try {
        displayButton.focus({ preventScroll: true });
      } catch (_) {
        displayButton.focus();
      }
    }
  }

  function nearestOptionValue() {
    const viewportCenter = viewport.scrollLeft + viewport.clientWidth / 2;
    let nearestValue = selectedValue;
    let nearestDistance = Infinity;
    for (const [value, option] of optionByValue.entries()) {
      const optionCenter = option.offsetLeft + option.offsetWidth / 2;
      const distance = Math.abs(optionCenter - viewportCenter);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestValue = value;
      }
    }
    return nearestValue;
  }

  SCORE_WHEEL_VALUES.forEach((value, index) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "score-wheel-option";
    option.id = `score_wheel_${index}_${Math.random().toString(36).slice(2, 8)}`;
    option.dataset.value = value;
    option.textContent = value || "—";
    option.tabIndex = -1;
    option.addEventListener("click", (event) => {
      event.preventDefault();
      setValue(value, { align: true, behavior: "smooth", emit: true });
      close({ restoreFocus: true });
    });
    track.appendChild(option);
    optionByValue.set(value, option);
  });

  displayButton.addEventListener("click", (event) => {
    event.preventDefault();
    if (isOpen) {
      close({ restoreFocus: false });
      return;
    }
    open();
  });

  viewport.addEventListener("scroll", () => {
    setValue(nearestOptionValue(), { align: false, emit: true });
    if (scrollSettleTimerId) clearTimeout(scrollSettleTimerId);
    scrollSettleTimerId = window.setTimeout(() => {
      scrollSettleTimerId = 0;
      setValue(nearestOptionValue(), { align: true, behavior: "smooth", emit: true });
    }, 90);
  });

  viewport.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close({ restoreFocus: true });
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    const currentIndex = Math.max(0, SCORE_WHEEL_VALUES.indexOf(selectedValue));
    const nextIndex = Math.max(
      0,
      Math.min(SCORE_WHEEL_VALUES.length - 1, currentIndex + (event.key === "ArrowRight" ? 1 : -1))
    );
    setValue(SCORE_WHEEL_VALUES[nextIndex], { align: true, behavior: "smooth", emit: true });
  });

  updateDisplayUi();
  updateSelectionUi();

  const controls = {
    root: shell,
    input: hiddenInput,
    focusTarget: displayButton,
    open,
    close,
    sync() {
      setValue(selectedValue, { align: isOpen, behavior: "auto", emit: false });
    },
  };
  return controls;
}

function replaceTournamentJson(nextJson) {
  if (!nextJson || nextJson === entryState.tournament) return;
  entryState.tournament = nextJson;
  entryState.rounds = nextJson?.tournament?.rounds || [];
  entryState.teamsById = Object.create(null);
  for (const team of nextJson?.teams || []) {
    const teamId = team?.teamId || team?.id;
    if (!teamId) continue;
    entryState.teamsById[teamId] = team;
  }
}

async function applyPendingScoresToCurrentTournament() {
  const nextJson = await applyPendingScoreSubmissionsToTournament(entryState.tournament, {
    tid: entryState.tid,
    code: entryState.code,
  });
  replaceTournamentJson(nextJson);
  return entryState.tournament;
}

async function renderScoreSyncStatus(customMessage = "") {
  if (!els.scoreSyncStatus) return;
  const summary = await getPendingScoreSummary({ tid: entryState.tid, code: entryState.code });
  let text = String(customMessage || "").trim();
  let color = "";

  if (!text) {
    if (summary.conflictCount > 0) {
      text = `${summary.conflictCount} queued score update${summary.conflictCount === 1 ? "" : "s"} need review before syncing.`;
      color = "var(--bad)";
    } else if (summary.pendingCount > 0) {
      text = navigator.onLine
        ? `${summary.pendingCount} queued score update${summary.pendingCount === 1 ? "" : "s"} waiting to sync.`
        : `Offline: ${summary.pendingCount} score update${summary.pendingCount === 1 ? "" : "s"} queued on this device.`;
    } else if (!navigator.onLine && entryState.tid) {
      text = "Offline: using cached tournament data until the connection returns.";
    }
  }

  els.scoreSyncStatus.textContent = text;
  els.scoreSyncStatus.style.color = color;
}

async function syncPendingScores({ quiet = false } = {}) {
  if (pendingSyncPromise) return pendingSyncPromise;
  pendingSyncPromise = (async () => {
    const summary = await getPendingScoreSummary({ tid: entryState.tid, code: entryState.code });
    if (!summary.pendingCount || !navigator.onLine || !entryState.tid) {
      await renderScoreSyncStatus();
      return summary;
    }
    if (!quiet) {
      await renderScoreSyncStatus(`Syncing ${summary.pendingCount} queued score update${summary.pendingCount === 1 ? "" : "s"}…`);
    }
    const result = await flushPendingScoreSubmissions({
      tid: entryState.tid,
      code: entryState.code,
      sendScore: (payload) =>
        api(`/tournaments/${encodeURIComponent(entryState.tid)}/scores`, {
          method: "POST",
          body: payload,
        }),
    });
    await refreshTournamentJson({ quietSync: true });
    await renderScoreSyncStatus();
    return result;
  })();
  try {
    return await pendingSyncPromise;
  } finally {
    pendingSyncPromise = null;
  }
}

function clearCodeAndReload() {
  try {
    localStorage.removeItem(STORAGE_KEYS.playerCode);
  } catch (_) {
    // ignore
  }
  const url = new URL(window.location.href);
  url.searchParams.delete("code");
  url.searchParams.delete("c");
  window.location.href = url.toString();
}

function ensureScoreCard() {
  if (!els.container || !els.controlsCard) return;
  if (!els.scoreCard) {
    const card = document.createElement("div");
    card.className = "hole-map-score-overlay";
    card.id = "map_score_card";
    card.hidden = true;
    card.setAttribute("aria-hidden", "true");
    card.innerHTML = `
      <div class="card enter-who-card hole-map-score-panel" role="dialog" aria-modal="true" aria-labelledby="map_score_title">
        <div class="enter-who-head">
          <div class="enter-who-main">
            <h2 id="map_score_title" style="margin:0;">Enter Scores</h2>
            <div class="hole-map-score-hole-meta" id="map_score_hole_meta" hidden></div>
          </div>
          <div class="hole-map-score-head-actions">
            <button id="map_change_code_btn" class="secondary" type="button">Change code</button>
          </div>
        </div>
        <div id="map_score_body">
          <div id="map_score_ticker_host" class="hole-map-score-ticker-host"></div>
          <div class="enter-tabs" id="map_round_tabs" style="margin-top:12px;"></div>
          <div id="map_score_rows" style="display:flex; flex-wrap:wrap; gap:8px; overflow:auto; padding:2px 1px; margin-top:10px;"></div>
          <div class="actions hole-actions" id="map_score_actions" style="margin-top:10px; display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
            <label class="small" style="display:inline-flex; align-items:center; gap:6px; margin-right:auto;">
              <input id="map_score_override" type="checkbox" />
              Override existing
            </label>
            <div class="hole-map-score-action-buttons">
              <button id="map_submit_hole_inline_btn" type="button">Enter</button>
              <button id="map_close_scores_btn" class="secondary" type="button">Close</button>
            </div>
          </div>
          <div class="small" id="map_score_status" style="margin-top:8px;"></div>
        </div>
      </div>
    `;
    document.body.appendChild(card);
    els.scoreCard = card;
    els.scoreBody = card.querySelector("#map_score_body");
    els.scoreTitle = card.querySelector("#map_score_title");
    els.scoreHoleMeta = card.querySelector("#map_score_hole_meta");
    els.scoreActions = card.querySelector("#map_score_actions");
    els.scoreTickerHost = card.querySelector("#map_score_ticker_host");
    els.roundTabs = card.querySelector("#map_round_tabs");
    els.scoreRows = card.querySelector("#map_score_rows");
    els.scoreStatus = card.querySelector("#map_score_status");
    els.scoreSyncStatus = card.querySelector("#map_score_sync_status");
    els.mapInfo = card.querySelector("#map_course_info");
    els.scoreOverrideInput = card.querySelector("#map_score_override");
    els.scoreSubmitInline = card.querySelector("#map_submit_hole_inline_btn");
    els.scoreChangeCodeButton = card.querySelector("#map_change_code_btn");
    els.scoreCloseButton = card.querySelector("#map_close_scores_btn");

    const dock = document.createElement("div");
    dock.className = "hole-map-enter-dock";
    dock.id = "map_enter_dock";
    dock.hidden = true;
    dock.innerHTML = `<button id="map_enter_hole_btn" type="button">Enter</button>`;
    document.body.appendChild(dock);
    els.scoreSubmitDock = dock;
    els.scoreSubmitButton = dock.querySelector("#map_enter_hole_btn");
    syncScoreHoleMeta();
    syncTickerMount();

    const submitFromPanel = async () => {
      const submitted = await submitCurrentHole({ allowEmpty: false, advanceToSuggested: false });
      if (submitted?.ok && submitted?.submitted) {
        setScoreCardExpanded(false);
        nextHole(1);
      }
    };

    els.scoreSubmitButton?.addEventListener("click", async () => {
      if (!entryState.scorePanelExpanded) {
        setScoreCardMode("scores");
        setScoreCardExpanded(true, { focus: true });
        return;
      }
      await submitFromPanel();
    });
    els.scoreSubmitInline?.addEventListener("click", submitFromPanel);
    els.scoreChangeCodeButton?.addEventListener("click", clearCodeAndReload);
    els.scoreCloseButton?.addEventListener("click", () => {
      if (entryState.submitting) return;
      setScoreCardExpanded(false);
    });
    card.addEventListener("click", (event) => {
      if (event.target !== card || entryState.scorePanelMode === "code" || entryState.submitting) return;
      setScoreCardExpanded(false);
    });
    setScoreCardMode("scores");
    setScoreCardExpanded(false);
    updateScoreSubmitButton({ hidden: true });
  }
}

function showCodePrompt() {
  ensureScoreCard();
  if (!els.scoreRows || !els.roundTabs) return;
  entryState.currentMapMeta = null;
  setScoreCardMode("code");
  setScoreCardExpanded(true);
  if (els.scoreSyncStatus) {
    els.scoreSyncStatus.textContent = "";
    els.scoreSyncStatus.style.color = "";
  }
  updateMapModeToggleUi(null, [], "");
  els.roundTabs.innerHTML = "";
  els.scoreRows.innerHTML = `
    <div style="min-width:280px;">
      <label for="map_player_code_input">Player code</label>
      <input id="map_player_code_input" placeholder="XXXX" autocomplete="one-time-code" />
      <div class="actions" style="margin-top:10px;">
        <button id="map_player_code_go" type="button">Continue</button>
      </div>
    </div>
  `;
  setScoreStatus("");
  updateScoreSubmitButton({ hidden: true });
  const input = document.getElementById("map_player_code_input");
  const go = document.getElementById("map_player_code_go");
  input?.addEventListener("input", () => {
    input.value = normalizePlayerCode(input.value);
  });
  const onContinue = () => {
    const nextCode = normalizePlayerCode(input?.value);
    if (!nextCode) return;
    rememberPlayerCode(nextCode);
    const url = new URL(window.location.href);
    url.searchParams.set("code", nextCode);
    window.location.href = url.toString();
  };
  input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") onContinue();
  });
  go?.addEventListener("click", onContinue);
  window.requestAnimationFrame(() => input?.focus());
}

async function fetchCourseMapIndex() {
  const attempts = [];
  for (const candidate of MAP_INDEX_CANDIDATES) {
    attempts.push(candidate);
    try {
      const json = await fetchJson(candidate);
      if (json && typeof json === "object") return json;
    } catch (_) {
      // try next path
    }
  }
  return {
    generated_at_utc: "",
    data_root: "",
    course_count: 0,
    counts_by_map_level: { full: 0, simplified: 0, none: 0 },
    courses_by_slug: {},
    courses: []
  };
}

function startCourseMapIndexFetch() {
  if (!entryState.mapIndexPromise) {
    entryState.mapIndexPromise = fetchCourseMapIndex();
    entryState.mapIndexPromise.catch(() => {});
  }
  return entryState.mapIndexPromise;
}

async function ensureCourseMapIndex() {
  if (entryState.mapIndex) return entryState.mapIndex;
  startCourseMapIndexFetch();
  entryState.mapIndex = await entryState.mapIndexPromise;
  return entryState.mapIndex;
}

function resolveCourseMapMeta(course, mapIndex) {
  if (!course || !mapIndex) return null;
  const bySlug = mapIndex?.courses_by_slug || {};
  const courses = Array.isArray(mapIndex?.courses) ? mapIndex.courses : [];

  const slugCandidates = [
    course?.mapSlug,
    course?.dataSlug,
    course?.sourceCourseId,
    course?.courseId,
    course?.bluegolfCourseSlug,
    course?.slug,
    course?.courseSlug,
    course?.course_slug,
    course?.id,
  ]
    .map((v) => String(v || "").trim())
    .filter(Boolean);
  for (const slug of slugCandidates) {
    if (bySlug[slug]) return { slug, ...bySlug[slug] };
  }

  const targetNameKey = normalizeKey(course?.name || course?.courseName || course?.title);
  if (targetNameKey) {
    const exact = courses.find((item) => normalizeKey(item?.name) === targetNameKey);
    if (exact?.slug) return { slug: exact.slug, ...exact };
  }

  if (slugCandidates.length) {
    return {
      slug: slugCandidates[0],
      name: course?.name || course?.courseName || course?.title || slugCandidates[0],
      has_simplified_map: true,
      map_level: "simplified"
    };
  }

  return null;
}

function mapModeFromMeta(meta) {
  return availableMapModesFromMeta(meta)[0] || "";
}

function dataCandidatesForSlug(slug) {
  return DATA_ROOT_CANDIDATES.map((root) => `${root}/${slug}`);
}

async function resolveDataBase(slug, mode) {
  if (!slug) throw new Error("Missing course data slug");
  const attempts = [];
  const probeFile = mode === MAP_MODE_FULL ? "hole_index.json" : "bluegolf_tee_green_coordinates.json";
  for (const candidate of dataCandidatesForSlug(slug)) {
    const probe = `${candidate}/${probeFile}`;
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
  throw new Error(`Could not locate hole map data. Tried: ${attempts.join(" | ")}`);
}

function resetMapData() {
  state.courseFeatures = [];
  state.holeFeatures = [];
  state.holeMap = new Map();
  state.bluegolfHoleMap = new Map();
  state.bluegolfCourse = null;
  state.holes = [];
  state.currentHole = null;
  if (els.holeSelect) els.holeSelect.innerHTML = "";
}

function populateHoleSelect() {
  if (!els.holeSelect) return;
  els.holeSelect.innerHTML = "";
  for (const hole of state.holes) {
    const option = document.createElement("option");
    option.value = String(hole);
    option.textContent = holeSummaryTextForOption(hole);
    els.holeSelect.appendChild(option);
  }
}

async function loadMapDataForCourse(slug, mode) {
  const dataBase = await resolveDataBase(slug, mode);
  resetMapData();
  state.mapMode = mode;
  state.dataSlug = slug;

  if (mode === MAP_MODE_FULL) {
    const [courseGeo, holeGeo, holeIndex] = await Promise.all([
      fetchJson(`${dataBase}/course.geojson`),
      fetchJson(`${dataBase}/hole_features.geojson`),
      fetchJson(`${dataBase}/hole_index.json`),
    ]);

    state.courseFeatures = Array.isArray(courseGeo?.features) ? courseGeo.features : [];
    state.holeFeatures = Array.isArray(holeGeo?.features) ? holeGeo.features : [];

    const map = new Map();
    for (const feature of state.holeFeatures) {
      const props = feature?.properties || {};
      const holeRef = parseHoleRef(props.hole_ref ?? props.ref);
      if (holeRef == null) continue;
      if (!map.has(holeRef)) map.set(holeRef, []);
      map.get(holeRef).push(feature);
    }
    state.holeMap = map;
    const fromIndex = Object.keys(holeIndex?.holes || {})
      .map((h) => Number(h))
      .filter((h) => Number.isFinite(h));
    const fallback = Array.from(map.keys());
    state.holes = (fromIndex.length ? fromIndex : fallback).sort((a, b) => a - b);
  } else {
    const [bluegolfRows, bluegolfCourse] = await Promise.all([
      fetchJson(`${dataBase}/bluegolf_tee_green_coordinates.json`),
      fetchJson(`${dataBase}/bluegolf_course_data.json`).catch(() => null),
    ]);
    state.bluegolfCourse = bluegolfCourse && typeof bluegolfCourse === "object" ? bluegolfCourse : null;

    const map = new Map();
    for (const row of Array.isArray(bluegolfRows) ? bluegolfRows : []) {
      const hole = Number(row?.hole);
      if (!Number.isFinite(hole)) continue;
      map.set(hole, row);
    }
    state.bluegolfHoleMap = map;
    state.holes = Array.from(map.keys()).sort((a, b) => a - b);
  }

  populateHoleSelect();
}

function roundModeForIndex(roundIndex) {
  const roundCfg = entryState.rounds?.[roundIndex] || {};
  const fmt = String(roundCfg?.format || "singles").toLowerCase();
  if (fmt === "scramble") return "team";
  if (normalizeTwoManFormat(fmt) === "two_man_scramble") return "group";
  return "player";
}

function allowedPlayerIdsForRound(roundIndex) {
  const actorId = entryState.enter?.player?.playerId;
  const actor = entryState.playersById?.[actorId] || entryState.enter?.player || {};
  const actorTee = teeTimeForPlayerRound(actor, roundIndex);
  const ids = [];
  for (const p of entryState.players || []) {
    const pid = p?.playerId;
    if (!pid) continue;
    if (!actorTee) {
      if (pid === actorId) ids.push(pid);
      continue;
    }
    if (teeTimeForPlayerRound(p, roundIndex) === actorTee) ids.push(pid);
  }
  if (actorId && !ids.includes(actorId)) ids.unshift(actorId);
  return Array.from(new Set(ids));
}

function roundTargets(roundIndex) {
  const mode = roundModeForIndex(roundIndex);
  const scoreRound = entryState.tournament?.score_data?.rounds?.[roundIndex] || {};
  if (mode === "team") {
    const teamId = normalizeTeamId(entryState.enter?.team?.teamId);
    if (!teamId) return { mode, targets: [] };
    const teamName = entryState.enter?.team?.teamName || teamId;
    return {
      mode,
      targets: [{ id: teamId, label: teamName, teamId }],
      savedByTarget: {
        [teamId]: normalizeScoreArray(scoreRound?.team?.[teamId]?.gross),
      },
      progressTargetIds: [teamId].filter(Boolean),
    };
  }

  if (mode === "group") {
    const actor = entryState.playersById?.[entryState.enter?.player?.playerId] || entryState.enter?.player || {};
    const actorTeamId = normalizeTeamId(actor?.teamId || entryState.enter?.team?.teamId);
    const actorGroup = groupForPlayerRound(actor, roundIndex);
    const actorGroupId = twoManGroupId(actorTeamId, actorGroup);
    const savedByTarget = {};
    for (const [sdTeamId, teamEntry] of Object.entries(scoreRound?.team || {})) {
      for (const [label, groupEntry] of Object.entries(teamEntry?.groups || {})) {
        const gid = String(groupEntry?.groupId || twoManGroupId(sdTeamId, label)).trim();
        if (!gid) continue;
        savedByTarget[gid] = normalizeScoreArray(groupEntry?.gross);
      }
    }

    // Match enter.js behavior for two-man scramble: include all pair groups on the actor's tee time.
    const allowedIds = allowedPlayerIdsForRound(roundIndex);
    const groupMetaById = new Map();
    for (const pid of allowedIds) {
      const player = entryState.playersById?.[pid];
      if (!player) continue;
      const teamId = normalizeTeamId(player?.teamId);
      const group = groupForPlayerRound(player, roundIndex);
      const groupId = twoManGroupId(teamId, group);
      if (!groupId) continue;
      if (!groupMetaById.has(groupId)) {
        const teamName = entryState.teamsById?.[teamId]?.teamName || teamId || "Team";
        groupMetaById.set(groupId, { groupId, teamId, group, teamName, names: new Set() });
      }
    }

    for (const player of entryState.players || []) {
      const teamId = normalizeTeamId(player?.teamId);
      const group = groupForPlayerRound(player, roundIndex);
      const groupId = twoManGroupId(teamId, group);
      if (!groupMetaById.has(groupId)) continue;
      if (player?.name) groupMetaById.get(groupId).names.add(player.name);
    }

    if (!groupMetaById.size && actorGroupId) {
      const teamName = entryState.teamsById?.[actorTeamId]?.teamName || actorTeamId || "Team";
      groupMetaById.set(actorGroupId, {
        groupId: actorGroupId,
        teamId: actorTeamId,
        group: actorGroup,
        teamName,
        names: new Set(),
      });
    }

    const targets = Array.from(groupMetaById.values())
      .sort((a, b) => {
        const nameCompare = String(a.teamName).localeCompare(String(b.teamName));
        if (nameCompare !== 0) return nameCompare;
        return String(a.group).localeCompare(String(b.group));
      })
      .map((meta) => ({
        id: meta.groupId,
        label: meta.names.size ? Array.from(meta.names).join(", ") : meta.teamName,
        teamId: meta.teamId,
      }));

    return {
      mode,
      targets,
      savedByTarget,
      progressTargetIds: [actorGroupId].filter(Boolean),
    };
  }

  const actorId = entryState.enter?.player?.playerId;
  const ids = allowedPlayerIdsForRound(roundIndex);
  const savedByTarget = {};
  for (const pid of Object.keys(scoreRound?.player || {})) {
    savedByTarget[pid] = normalizeScoreArray(scoreRound?.player?.[pid]?.gross);
  }
  return {
    mode,
    targets: ids
      .map((id) => {
        const player = entryState.playersById?.[id];
        if (!player) return { id, label: id, teamId: "" };
        return {
          id,
          label: player?.name || id,
          teamId: normalizeTeamId(player?.teamId),
        };
      })
      .filter((target) => !!target.id),
    savedByTarget,
    progressTargetIds: [actorId].filter((id) => Boolean(id) && ids.includes(id)),
  };
}

function activeRoundIndexFromTournament() {
  const rounds = entryState.rounds || [];
  for (let i = 0; i < rounds.length; i += 1) {
    const { targets, savedByTarget, progressTargetIds } = roundTargets(i);
    const progressIds = progressTargetIds?.length ? progressTargetIds : targets.map((target) => target.id);
    if (!progressIds.length) return i;
    if (!progressIds.every((id) => isCompleteScoreArray(savedByTarget[id]))) return i;
  }
  const scoreRounds = entryState.tournament?.score_data?.rounds || [];
  for (let i = rounds.length - 1; i >= 0; i -= 1) {
    if (roundHasAnyData(scoreRounds[i])) return i;
  }
  return rounds.length ? rounds.length - 1 : 0;
}

const draftByRound = Object.create(null);

function ensureRoundDraft(roundIndex) {
  if (!draftByRound[roundIndex]) {
    draftByRound[roundIndex] = { hole: Object.create(null) };
  }
  return draftByRound[roundIndex];
}

function getHoleDraft(roundIndex, holeIndex, targetId) {
  return draftByRound[roundIndex]?.hole?.[holeIndex]?.[targetId];
}

function setHoleDraft(roundIndex, holeIndex, targetId, value) {
  const rd = ensureRoundDraft(roundIndex);
  if (!rd.hole[holeIndex]) rd.hole[holeIndex] = Object.create(null);
  rd.hole[holeIndex][targetId] = value;
}

function clearHoleDraftTargets(roundIndex, holeIndex, targetIds) {
  const holeDraft = draftByRound[roundIndex]?.hole?.[holeIndex];
  if (!holeDraft) return;
  for (const targetId of targetIds) delete holeDraft[targetId];
  if (Object.keys(holeDraft).length === 0) delete draftByRound[roundIndex].hole[holeIndex];
}

function renderRoundTabs() {
  if (!els.roundTabs) return;
  els.roundTabs.innerHTML = "";
  const rounds = entryState.rounds || [];
  rounds.forEach((round, idx) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    if (idx === entryState.selectedRoundIndex) button.classList.add("active");
    button.textContent = `Round ${idx + 1}`;
    button.addEventListener("click", async () => {
      if (idx === entryState.selectedRoundIndex) return;
      els.roundTabs.querySelectorAll("button").forEach(b => b.classList.remove("active"));
      button.classList.add("active");
      try {
        await selectRound(idx, { jumpToSuggestedHole: true });
      } catch (error) {
        setScoreStatus(`Error loading round ${idx + 1}: ${error?.message || String(error)}`, true);
      }
    });
    els.roundTabs.appendChild(button);
  });
}

function renderScoreRows() {
  if (!els.scoreRows) return;
  setScoreCardMode("scores");
  if (entryState.activeScoreWheel?.close) entryState.activeScoreWheel.close({ restoreFocus: false });
  entryState.activeScoreWheel = null;
  els.scoreRows.innerHTML = "";
  entryState.currentInputs = [];
  const roundIndex = entryState.selectedRoundIndex;
  const holeIndex = entryState.currentHoleIndex;
  const holeNumber = holeNumberFromIndex(holeIndex) ?? state.currentHole;
  const roundHolePar = courseParsForRound(entryState.tournament, roundIndex)?.[holeIndex];
  const holePar = Number.isFinite(roundHolePar) ? roundHolePar : parForHoleNumber(holeNumber);
  const { targets, savedByTarget } = roundTargets(roundIndex);
  if (!targets.length) {
    els.scoreRows.innerHTML = `<div class="small">No score targets for this round.</div>`;
    updateScoreSubmitButton({ hidden: true });
    return;
  }

  for (const target of targets) {
    const existing = (savedByTarget[target.id] || Array(18).fill(null))[holeIndex];
    const draft = getHoleDraft(roundIndex, holeIndex, target.id);
    const parDefault = Number.isFinite(holePar) && holePar > 0 ? String(Math.round(holePar)) : "";
    const initial = draft !== undefined ? draft : existing == null ? parDefault : String(existing);
    const row = document.createElement("div");
    row.className = "hole-row hole-score-row team-accent";
    const accent = colorForTeam(target.teamId);
    if (accent) row.style.setProperty("--team-accent", accent);
    row.style.flex = "1 1 260px";
    row.style.maxWidth = "100%";

    const title = document.createElement("div");
    title.className = "hole-score-row-title";
    title.textContent = target.label;
    row.appendChild(title);

    const scoreWheel = createScoreWheel(initial, {
      onChange(nextValue) {
        setHoleDraft(roundIndex, holeIndex, target.id, nextValue);
        syncHoleDeltaLabel(delta, nextValue, holePar);
      },
    });

    const inputWrap = document.createElement("div");
    inputWrap.className = "score-wheel-row";
    const delta = document.createElement("span");
    delta.className = "small score-wheel-delta";
    syncHoleDeltaLabel(delta, scoreWheel.input.value, holePar);
    inputWrap.appendChild(scoreWheel.root);
    inputWrap.appendChild(delta);
    row.appendChild(inputWrap);
    els.scoreRows.appendChild(row);
    window.requestAnimationFrame(() => scoreWheel.sync());
    entryState.currentInputs.push({
      targetId: target.id,
      input: scoreWheel.input,
      focusTarget: scoreWheel.focusTarget,
    });
  }
  setScoreCardExpanded(entryState.scorePanelExpanded);
  updateScoreSubmitButton({
    hidden: false,
    disabled: entryState.submitting,
    label: entryState.submitting ? "Entering…" : "Enter",
  });
}

async function refreshTournamentJson({ quietSync = false } = {}) {
  const previousTournament = entryState.tournament;
  const fresh = await staticJson(
    `/tournaments/${encodeURIComponent(entryState.tid)}.json?v=${Date.now()}`,
    { cacheKey: `t:${entryState.tid}` }
  );
  const nextJson = await applyPendingScoreSubmissionsToTournament(fresh, {
    tid: entryState.tid,
    code: entryState.code,
  });
  const newEvents = collectNewScoreEvents(previousTournament, nextJson);
  replaceTournamentJson(nextJson);
  seedTeamColors(nextJson);
  updateBrandDotFromTournament(nextJson);
  renderTicker(nextJson, entryState.playersById, entryState.teamsById, entryState.selectedRoundIndex);
  if (newEvents.length) showScoreNotifier(newEvents);
  if (!quietSync) {
    await renderScoreSyncStatus();
  }
  return nextJson;
}

async function submitCurrentHole({ allowEmpty = false, advanceToSuggested = false, override = null } = {}) {
  if (entryState.submitting) return { ok: false };
  const roundIndex = entryState.selectedRoundIndex;
  const holeIndex = entryState.currentHoleIndex;
  const withOverride = override == null ? Boolean(els.scoreOverrideInput?.checked) : Boolean(override);
  const entries = [];
  for (const { targetId, input } of entryState.currentInputs || []) {
    const raw = String(input?.value ?? "").trim();
    if (!raw) continue;
    const strokes = Number(raw);
    if (!Number.isFinite(strokes) || strokes <= 0) continue;
    entries.push({ targetId, strokes });
  }

  if (!entries.length) {
    if (allowEmpty) return { ok: true, submitted: false };
    setScoreStatus("Enter at least one score for this hole.", true);
    return { ok: false };
  }

  entryState.submitting = true;
  updateScoreSubmitButton({ hidden: false, disabled: true, label: "Entering…" });
  setScoreStatus("Submitting…");
  const payload = {
    code: entryState.code,
    roundIndex,
    mode: "hole",
    holeIndex,
    entries,
    override: withOverride,
  };
  try {
    await api(`/tournaments/${encodeURIComponent(entryState.tid)}/scores`, {
      method: "POST",
      body: payload,
    });
    await clearPendingScoreSubmissionsMatching({
      tid: entryState.tid,
      code: entryState.code,
      payload,
    });
    clearHoleDraftTargets(
      roundIndex,
      holeIndex,
      entries.map((entry) => entry.targetId)
    );
    await refreshTournamentJson();
    if (advanceToSuggested) {
      const { targets, savedByTarget, progressTargetIds } = roundTargets(roundIndex);
      const progressIds = progressTargetIds?.length ? progressTargetIds : targets.map((target) => target.id);
      entryState.currentHoleIndex = nextHoleIndexForGroup(
        savedByTarget,
        progressIds
      );
      setHoleByIndex(entryState.currentHoleIndex, { syncEntry: false });
    }
    setScoreStatus("Saved.");
    renderScoreRows();
    await renderScoreSyncStatus();
    return { ok: true, submitted: true };
  } catch (error) {
    if (isNetworkFailure(error)) {
      await enqueuePendingScoreSubmission({
        tid: entryState.tid,
        code: entryState.code,
        payload,
      });
      await applyPendingScoresToCurrentTournament();
      clearHoleDraftTargets(
        roundIndex,
        holeIndex,
        entries.map((entry) => entry.targetId)
      );
      if (advanceToSuggested) {
        const { targets, savedByTarget, progressTargetIds } = roundTargets(roundIndex);
        const progressIds = progressTargetIds?.length ? progressTargetIds : targets.map((target) => target.id);
        entryState.currentHoleIndex = nextHoleIndexForGroup(
          savedByTarget,
          progressIds
        );
        setHoleByIndex(entryState.currentHoleIndex, { syncEntry: false });
      }
      setScoreStatus(
        navigator.onLine
          ? "Saved locally. Sync will retry automatically."
          : "Offline: saved locally and queued for sync."
      );
      renderScoreRows();
      renderTicker(entryState.tournament, entryState.playersById, entryState.teamsById, entryState.selectedRoundIndex);
      await renderScoreSyncStatus();
      return { ok: true, submitted: true, queued: true };
    }
    if (error?.status === 409) {
      if (withOverride) {
        setScoreStatus("Conflict: existing scores could not be overridden for this player code.", true);
      } else {
        setScoreStatus('Conflict: scores already posted. Check "Override existing" and submit again.', true);
      }
      return { ok: false, conflict: true };
    }
    setScoreStatus(`Error: ${error?.message || String(error)}`, true);
    return { ok: false };
  } finally {
    entryState.submitting = false;
    updateScoreSubmitButton({
      hidden: !(entryState.currentInputs?.length > 0),
      disabled: false,
      label: "Enter",
    });
  }
}

async function loadMapForSelectedRound({ forcedMode = "" } = {}) {
  const roundIndex = entryState.selectedRoundIndex;
  const course = courseForRoundRaw(entryState.tournament, roundIndex);
  const mapIndex = await ensureCourseMapIndex();
  let mapMeta = resolveCourseMapMeta(course, mapIndex);
  if (!mapMeta && FORCED_DATA_SLUG) {
    const bySlug = mapIndex?.courses_by_slug || {};
    if (bySlug[FORCED_DATA_SLUG]) {
      mapMeta = { slug: FORCED_DATA_SLUG, ...bySlug[FORCED_DATA_SLUG] };
    } else {
      mapMeta = { slug: FORCED_DATA_SLUG, name: FORCED_DATA_SLUG, has_simplified_map: true };
    }
  }
  entryState.currentMapMeta = mapMeta || null;
  if (!mapMeta) {
    resetMapData();
    state.mapLabel = "No map";
    updateMapModeToggleUi(null, [], "");
    if (els.mapInfo) {
      els.mapInfo.textContent = `No map found for ${course?.name || "selected course"}.`;
    }
    if (els.holeEmpty) {
      els.holeEmpty.style.display = "";
      els.holeEmpty.textContent = "No hole map is available for this course.";
    }
    return { ok: false, reason: "missing" };
  }

  const availableModes = availableMapModesFromMeta(mapMeta);
  const satelliteAvailable = availableModes.includes(MAP_MODE_SIMPLIFIED);
  if (!satelliteAvailable) {
    resetMapData();
    state.mapLabel = "No map";
    updateMapModeToggleUi(mapMeta, [], "");
    if (els.mapInfo) {
      els.mapInfo.textContent = `${mapMeta?.name || mapMeta?.slug || "Course"} has no satellite map files.`;
    }
    if (els.holeEmpty) {
      els.holeEmpty.style.display = "";
      els.holeEmpty.textContent = "No satellite hole map is available for this course.";
    }
    return { ok: false, reason: "missing" };
  }

  const modeCandidates = [MAP_MODE_SIMPLIFIED];
  let loadedMode = "";
  let lastLoadError = null;
  for (const candidateMode of modeCandidates) {
    try {
      await loadMapDataForCourse(mapMeta.slug, candidateMode);
      loadedMode = candidateMode;
      break;
    } catch (error) {
      lastLoadError = error;
    }
  }

  if (!loadedMode) {
    resetMapData();
    state.mapLabel = "No map";
    updateMapModeToggleUi(mapMeta, [MAP_MODE_SIMPLIFIED], "");
    if (els.mapInfo) {
      els.mapInfo.textContent = `${mapMeta?.name || mapMeta?.slug || "Course"} satellite map could not be loaded.`;
    }
    if (els.holeEmpty) {
      els.holeEmpty.style.display = "";
      els.holeEmpty.textContent = "No satellite hole map is available for this course.";
    }
    const message = `Could not load satellite map: ${lastLoadError?.message || "Unknown error."}`;
    return { ok: false, reason: "load_failed", message };
  }

  rememberMapModePreference(mapMeta.slug, loadedMode);
  state.mapLabel = mapModeLabel(loadedMode);
  updateMapInfoText(mapMeta, loadedMode);
  updateMapModeToggleUi(mapMeta, availableModes, loadedMode);
  setHoleByIndex(entryState.currentHoleIndex, { syncEntry: false });
  renderCurrentHole();
  return { ok: true, mode: loadedMode };
}

async function selectRound(roundIndex, { jumpToSuggestedHole = false } = {}) {
  const rounds = entryState.rounds || [];
  if (!rounds.length) return;
  const safeRound = Math.max(0, Math.min(rounds.length - 1, Number(roundIndex) || 0));
  entryState.selectedRoundIndex = safeRound;
  if (jumpToSuggestedHole) {
    const { targets, savedByTarget, progressTargetIds } = roundTargets(safeRound);
    const progressIds = progressTargetIds?.length ? progressTargetIds : targets.map((target) => target.id);
    entryState.currentHoleIndex = nextHoleIndexForGroup(
      savedByTarget,
      progressIds
    );
  }
  renderRoundTabs();
  renderScoreRows();
  renderTicker(entryState.tournament, entryState.playersById, entryState.teamsById, entryState.selectedRoundIndex);
  await loadMapForSelectedRound();
}

async function initializeEntryContext() {
  const codeFromQuery = normalizePlayerCode(qs("code") || qs("c"));
  if (codeFromQuery) rememberPlayerCode(codeFromQuery);
  entryState.code = codeFromQuery || normalizePlayerCode(getRememberedPlayerCode()) || "";
  if (!entryState.code) {
    showCodePrompt();
    throw new Error("Player code required");
  }

  const enter = await staticJson(`/enter/${encodeURIComponent(entryState.code)}.json`, {
    cacheKey: `enter:${entryState.code}`,
  });
  const tid = String(enter?.tournamentId || "").trim();
  if (!tid) {
    showCodePrompt();
    throw new Error("Invalid player code");
  }

  entryState.enter = enter;
  entryState.tid = tid;
  rememberPlayerCode(entryState.code);
  rememberTournamentId(tid);

  document.querySelectorAll("a[data-scoreboard-link]").forEach((link) => {
    link.setAttribute("href", `./scoreboard.html?t=${encodeURIComponent(tid)}`);
  });

  entryState.mapIndex = null;
  entryState.mapIndexPromise = null;
  startCourseMapIndexFetch();

  let tournament = await staticJson(`/tournaments/${encodeURIComponent(tid)}.json`, {
    cacheKey: `t:${tid}`,
  });
  tournament = await applyPendingScoreSubmissionsToTournament(tournament, {
    tid,
    code: entryState.code,
  });
  entryState.tournament = tournament;
  entryState.rounds = tournament?.tournament?.rounds || [];
  entryState.players = tournament?.players || [];
  entryState.playersById = Object.create(null);
  for (const player of entryState.players) {
    if (player?.playerId) entryState.playersById[player.playerId] = player;
  }
  entryState.teamsById = Object.create(null);
  for (const team of tournament?.teams || []) {
    const teamId = team?.teamId || team?.id;
    if (!teamId) continue;
    entryState.teamsById[teamId] = team;
  }

  setHeaderTournamentName(tournament?.tournament?.name);
  seedTeamColors(tournament);
  updateBrandDotFromTournament(tournament);
  renderTicker(tournament, entryState.playersById, entryState.teamsById, entryState.selectedRoundIndex);
}

function startAutoRefresh() {
  if (entryState.refreshTimer) clearInterval(entryState.refreshTimer);
  entryState.refreshTimer = window.setInterval(async () => {
    try {
      await syncPendingScores({ quiet: true });
      await refreshTournamentJson();
      renderScoreRows();
    } catch (_) {
      // keep stale data if refresh fails
    }
  }, SCORE_AUTO_REFRESH_MS);
}

async function init() {
  ensureScoreCard();
  hydrateMapModePreferences();
  hydrateAutoZoomPreference();
  bindEvents();
  state.locationPermissionGranted = readGeolocationGrant();
  updateTrackingButton();
  updateLocationStatus(
    state.locationPermissionGranted
      ? "Reusing saved location permission..."
      : "Location not shared yet."
  );

  onNextHoleRequested = async () => {
    if (entryState.scorePanelExpanded) return true;
    nextHole(1);
    return true;
  };

  try {
    await initializeEntryContext();
    await renderScoreSyncStatus();
    const rounds = entryState.rounds || [];
    if (!rounds.length) {
      throw new Error("Tournament has no rounds.");
    }
    entryState.selectedRoundIndex = activeRoundIndexFromTournament();
    const { targets, savedByTarget, progressTargetIds } = roundTargets(entryState.selectedRoundIndex);
    const progressIds = progressTargetIds?.length ? progressTargetIds : targets.map((target) => target.id);
    entryState.currentHoleIndex = nextHoleIndexForGroup(
      savedByTarget,
      progressIds
    );
    const initialRoundLoad = selectRound(entryState.selectedRoundIndex, { jumpToSuggestedHole: false });
    syncFooterViewportLock();
    showPageBody();
    updateMapTickerStickyState();
    await initialRoundLoad;
    await maybeAutoStartTracking();
    startAutoRefresh();
    window.addEventListener("online", () => {
      void (async () => {
        await renderScoreSyncStatus();
        await syncPendingScores({ quiet: true });
        renderScoreRows();
      })();
    });
    window.addEventListener("offline", () => {
      void renderScoreSyncStatus();
    });
    void syncPendingScores({ quiet: true });
  } catch (error) {
    console.error(error);
    showPageBody();
    syncFooterViewportLock();
    updateMapTickerStickyState();
    if (String(error?.message || "") !== "Player code required" && String(error?.message || "") !== "Invalid player code") {
      state.locationError = `Could not load map view: ${error.message}`;
      updateLocationStatus(state.locationError);
      setScoreStatus(state.locationError, true);
      if (els.holeEmpty) {
        els.holeEmpty.style.display = "";
      }
    }
  }
}

init();
