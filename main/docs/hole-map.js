const DATA_BASE_CANDIDATES = [
  "../../golf_course_hole_geo_data/data/sherrill-park-golf-course-1",
  "/golf_tournaments/golf_course_hole_geo_data/data/sherrill-park-golf-course-1",
  "/golf_course_hole_geo_data/data/sherrill-park-golf-course-1",
];
const SVG_NS = "http://www.w3.org/2000/svg";
const LOCATION_REFRESH_MS = 2000;
const GEO_GRANTED_KEY = "hole-map:geo-granted";
const MAP_FOCUS_MAX_USER_DISTANCE_YARDS = 700;

const state = {
  courseFeatures: [],
  holeFeatures: [],
  holes: [],
  holeMap: new Map(),
  currentHole: null,
  userLocation: null,
  locationAccuracyM: null,
  locationError: "",
  locationIntervalMs: LOCATION_REFRESH_MS,
  locationTimerId: null,
  locationPending: false,
  locationPermissionGranted: false,
  dataBase: null,
};

const els = {
  holeSelect: document.getElementById("hole_select"),
  holePrev: document.getElementById("hole_prev"),
  holeNext: document.getElementById("hole_next"),
  locBtn: document.getElementById("loc_btn"),
  locClear: document.getElementById("loc_clear"),
  locStatus: document.getElementById("loc_status"),
  metricHole: document.getElementById("metric_hole"),
  metricPar: document.getElementById("metric_par"),
  metricFront: document.getElementById("metric_front"),
  metricCenter: document.getElementById("metric_center"),
  metricBack: document.getElementById("metric_back"),
  metricSource: document.getElementById("metric_source"),
  yardageDetail: document.getElementById("yardage_detail"),
  holeSvg: document.getElementById("hole_svg"),
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

function createAlignedProjector(features, extraPoints, alignmentStart, alignmentEnd, width, height, padding) {
  const allPoints = [];
  for (const feature of features) collectPositions(feature?.geometry, allPoints);
  for (const point of extraPoints || []) {
    if (Array.isArray(point) && point.length === 2) allPoints.push(point);
  }
  if (!allPoints.length) return null;

  let sumLon = 0;
  let sumLat = 0;
  for (const [lon, lat] of allPoints) {
    sumLon += lon;
    sumLat += lat;
  }
  const centerLon = sumLon / allPoints.length;
  const centerLat = sumLat / allPoints.length;
  const lonScale = Math.max(1e-8, Math.cos(toRad(centerLat)));

  const toLocal = ([lon, lat]) => [(lon - centerLon) * lonScale, lat - centerLat];

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
  const scale = Math.min(innerW / w, innerH / h);
  const drawW = w * scale;
  const drawH = h * scale;
  const offsetX = (width - drawW) / 2;
  const offsetY = (height - drawH) / 2;

  const project = (point) => {
    const [rx, ry] = rotate(toLocal(point));
    const x = offsetX + (rx - minX) * scale;
    const y = height - (offsetY + (ry - minY) * scale);
    return [x, y];
  };

  return { project };
}

function pathFromLineString(coords, project) {
  if (!Array.isArray(coords) || !coords.length) return "";
  let d = "";
  for (let i = 0; i < coords.length; i += 1) {
    const [x, y] = project(coords[i]);
    d += `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)} `;
  }
  return d.trim();
}

function pathFromPolygon(coords, project) {
  if (!Array.isArray(coords) || !coords.length) return "";
  let d = "";
  for (const ring of coords) {
    if (!Array.isArray(ring) || !ring.length) continue;
    for (let i = 0; i < ring.length; i += 1) {
      const [x, y] = project(ring[i]);
      d += `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)} `;
    }
    d += "Z ";
  }
  return d.trim();
}

function pathFromGeometry(geometry, project) {
  if (!geometry) return "";
  if (geometry.type === "LineString") return pathFromLineString(geometry.coordinates, project);
  if (geometry.type === "MultiLineString") {
    return (geometry.coordinates || [])
      .map((line) => pathFromLineString(line, project))
      .filter(Boolean)
      .join(" ");
  }
  if (geometry.type === "Polygon") return pathFromPolygon(geometry.coordinates, project);
  if (geometry.type === "MultiPolygon") {
    return (geometry.coordinates || [])
      .map((poly) => pathFromPolygon(poly, project))
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function appendSvg(type, attrs) {
  const node = document.createElementNS(SVG_NS, type);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }
  els.holeSvg.appendChild(node);
  return node;
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
  els.locStatus.textContent = text;
}

function secureContextMessage() {
  if (window.isSecureContext) return "";
  return "Location requires HTTPS or localhost. Open this page via https:// (not file:// or plain http://).";
}

function formatYards(value) {
  return Number.isFinite(value) ? String(Math.round(value)) : "—";
}

function clampIntervalMs(value) {
  if (!Number.isFinite(value)) return 2000;
  if (value <= 1000) return 1000;
  if (value >= 3000) return 3000;
  if (value < 1500) return 1000;
  if (value < 2500) return 2000;
  return 3000;
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
    state.locationPermissionGranted || Array.isArray(state.userLocation) || Boolean(state.locationTimerId);

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

function stopLocationTracking(clearLocation, statusText) {
  if (state.locationTimerId) {
    clearInterval(state.locationTimerId);
    state.locationTimerId = null;
  }
  state.locationPending = false;

  if (clearLocation) {
    state.userLocation = null;
    state.locationAccuracyM = null;
    state.locationError = "";
    state.locationPermissionGranted = false;
    persistGeolocationGrant(false);
  }

  if (statusText) updateLocationStatus(statusText);
  updateTrackingButton();
}

function pullLocationOnce() {
  const secureMsg = secureContextMessage();
  if (secureMsg) {
    state.locationError = secureMsg;
    stopLocationTracking(false, secureMsg);
    renderCurrentHole();
    return;
  }

  if (!("geolocation" in navigator)) {
    state.locationError = "This browser does not support geolocation.";
    stopLocationTracking(false, state.locationError);
    renderCurrentHole();
    return;
  }

  if (state.locationPending) return;

  state.locationPending = true;
  updateTrackingButton();

  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.locationPending = false;
      state.userLocation = [position.coords.longitude, position.coords.latitude];
      state.locationAccuracyM = position.coords.accuracy;
      state.locationError = "";
      state.locationPermissionGranted = true;
      persistGeolocationGrant(true);
      updateLocationStatus(`Tracking location every ${state.locationIntervalMs / 1000}s.`);
      updateTrackingButton();
      renderCurrentHole();
    },
    (error) => {
      state.locationPending = false;
      const codeMap = {
        1: "Location permission was denied.",
        2: "Location is unavailable.",
        3: "Location request timed out.",
      };
      const base = codeMap[error.code] || "Could not get current location.";
      const detail = error?.message ? ` ${error.message}` : "";
      state.locationError = `${base}${detail}`.trim();

      if (error.code === 1) {
        state.locationPermissionGranted = false;
        persistGeolocationGrant(false);
        stopLocationTracking(false, state.locationError);
      } else {
        updateLocationStatus(state.locationError);
        updateTrackingButton();
      }

      renderCurrentHole();
    },
    {
      enableHighAccuracy: true,
      timeout: 9000,
      maximumAge: 500,
    }
  );
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

  const selectedMs = clampIntervalMs(LOCATION_REFRESH_MS);
  state.locationIntervalMs = selectedMs;

  if (state.locationTimerId) {
    clearInterval(state.locationTimerId);
    state.locationTimerId = null;
  }

  state.locationError = "";
  updateLocationStatus(`Tracking location every ${selectedMs / 1000}s.`);
  pullLocationOnce();
  state.locationTimerId = setInterval(pullLocationOnce, selectedMs);
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

function renderCurrentHole() {
  const hole = state.currentHole;
  const features = state.holeMap.get(hole) || [];
  const par = holePar(features);
  const green = greenForHole(features);
  const holeLine = holeLineForHole(features);
  const greenCenter = featureCentroid(green);
  const backTee = backTeeForHole(features, greenCenter, holeLine);
  const greenTargets = greenFrontBackPoints(green, backTee, holeLine);

  let sourceLabel = "Not Set";
  let playingPoint = null;

  if (Array.isArray(state.userLocation)) {
    sourceLabel = "My Location";
    playingPoint = state.userLocation;
  } else if (Array.isArray(backTee)) {
    sourceLabel = "Back Tee Default";
    playingPoint = backTee;
  }

  const yardsFront =
    Array.isArray(playingPoint) && Array.isArray(greenTargets.front)
      ? distanceYards(playingPoint, greenTargets.front)
      : null;
  const yardsCenter =
    Array.isArray(playingPoint) && Array.isArray(greenTargets.center)
      ? distanceYards(playingPoint, greenTargets.center)
      : null;
  const yardsBack =
    Array.isArray(playingPoint) && Array.isArray(greenTargets.back)
      ? distanceYards(playingPoint, greenTargets.back)
      : null;

  const userToGreenCenterYards =
    sourceLabel === "My Location" && Array.isArray(state.userLocation) && Array.isArray(greenTargets.center)
      ? distanceYards(state.userLocation, greenTargets.center)
      : null;
  const mapShouldFocusHole =
    Number.isFinite(userToGreenCenterYards) && userToGreenCenterYards > MAP_FOCUS_MAX_USER_DISTANCE_YARDS;
  const mapPlayerPoint = mapShouldFocusHole ? null : playingPoint;

  els.metricHole.textContent = hole == null ? "—" : String(hole);
  els.metricPar.textContent = par == null ? "—" : String(par);
  els.metricFront.textContent = formatYards(yardsFront);
  els.metricCenter.textContent = formatYards(yardsCenter);
  els.metricBack.textContent = formatYards(yardsBack);
  els.metricSource.textContent = sourceLabel;

  if (state.locationError) {
    els.yardageDetail.textContent = state.locationError;
  } else if (sourceLabel === "My Location") {
    const acc = Number.isFinite(state.locationAccuracyM)
      ? ` GPS accuracy ~${Math.round(state.locationAccuracyM)}m.`
      : "";
    const zoomHint = mapShouldFocusHole
      ? ` You are ${Math.round(userToGreenCenterYards)} yards from center green, so the map stays focused on the hole.`
      : "";
    els.yardageDetail.textContent = `Live yardages from your location updating every ${state.locationIntervalMs / 1000}s.${acc}${zoomHint}`;
  } else if (sourceLabel === "Back Tee Default") {
    els.yardageDetail.textContent = "Location not set yet. Showing back-tee yardages by default.";
  } else {
    els.yardageDetail.textContent = "No location or tee reference available for this hole.";
  }

  while (els.holeSvg.firstChild) els.holeSvg.removeChild(els.holeSvg.firstChild);

  if (!features.length) {
    els.holeEmpty.style.display = "";
    return;
  }
  els.holeEmpty.style.display = "none";

  const alignmentStart = backTee || firstLinePoint(holeLine) || featureCentroid(green) || null;
  const alignmentEnd = greenTargets.center || lastLinePoint(holeLine) || featureCentroid(green) || null;

  const extraPoints = [
    backTee,
    greenTargets.front,
    greenTargets.center,
    greenTargets.back,
    mapPlayerPoint,
  ];

  const { width, height, margin } = getCanvasConfig();
  els.holeSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const projection = createAlignedProjector(
    features,
    extraPoints,
    alignmentStart,
    alignmentEnd,
    width,
    height,
    margin
  );

  if (!projection) {
    els.holeEmpty.style.display = "";
    return;
  }

  const { project } = projection;

  appendSvg("rect", {
    x: 0,
    y: 0,
    width,
    height,
    class: "hole-stage-bg",
    rx: 18,
    ry: 18,
  });

  const drawRank = { fairway: 1, green: 2, bunker: 3, tee: 4, hole: 5 };
  const sorted = [...features].sort((a, b) => {
    const ga = String(a?.properties?.golf || "");
    const gb = String(b?.properties?.golf || "");
    return (drawRank[ga] || 99) - (drawRank[gb] || 99);
  });

  for (const feature of sorted) {
    const golf = String(feature?.properties?.golf || "other");
    const d = pathFromGeometry(feature.geometry, project);
    if (!d) continue;

    const klass =
      golf === "fairway" || golf === "green" || golf === "bunker" || golf === "tee"
        ? `hole-shape golf-${golf}`
        : golf === "hole"
          ? "hole-path"
          : "hole-other";

    const node = appendSvg("path", { d, class: klass });
    const holeRef = parseHoleRef(feature?.properties?.hole_ref ?? feature?.properties?.ref);
    const title = document.createElementNS(SVG_NS, "title");
    title.textContent = `${golf}${holeRef ? ` • Hole ${holeRef}` : ""}`;
    node.appendChild(title);
  }

  if (Array.isArray(greenTargets.front)) {
    const [x, y] = project(greenTargets.front);
    appendSvg("circle", { cx: x, cy: y, r: 6, class: "marker marker-front" });
  }
  if (Array.isArray(greenTargets.center)) {
    const [x, y] = project(greenTargets.center);
    appendSvg("circle", { cx: x, cy: y, r: 8, class: "marker marker-green" });
  }
  if (Array.isArray(greenTargets.back)) {
    const [x, y] = project(greenTargets.back);
    appendSvg("circle", { cx: x, cy: y, r: 6, class: "marker marker-back" });
  }

  if (Array.isArray(backTee)) {
    const [tx, ty] = project(backTee);
    appendSvg("circle", { cx: tx, cy: ty, r: 7, class: "marker marker-tee" });
  }

  if (Array.isArray(mapPlayerPoint)) {
    const [px, py] = project(mapPlayerPoint);
    appendSvg("circle", { cx: px, cy: py, r: 8, class: "marker marker-player" });
  }

  appendSvg("text", {
    x: 24,
    y: 42,
    class: "hole-label",
  }).textContent = `Hole ${hole}`;
}

function setHole(holeNumber) {
  if (!state.holes.includes(holeNumber)) return;
  state.currentHole = holeNumber;
  els.holeSelect.value = String(holeNumber);
  renderCurrentHole();
}

function nextHole(delta) {
  if (!state.holes.length || state.currentHole == null) return;
  const idx = state.holes.indexOf(state.currentHole);
  if (idx === -1) return;
  const next = (idx + delta + state.holes.length) % state.holes.length;
  setHole(state.holes[next]);
}

function bindEvents() {
  els.holeSelect.addEventListener("change", () => {
    const value = Number(els.holeSelect.value);
    if (Number.isFinite(value)) setHole(value);
  });

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

  window.addEventListener("keydown", (event) => {
    if (event.target && ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
    if (event.key === "ArrowLeft") nextHole(-1);
    if (event.key === "ArrowRight") nextHole(1);
  });

  window.addEventListener("beforeunload", () => {
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
    const probe = `${candidate}/hole_index.json`;
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

  els.holeSelect.innerHTML = "";
  for (const hole of state.holes) {
    const option = document.createElement("option");
    option.value = String(hole);
    option.textContent = `Hole ${hole}`;
    els.holeSelect.appendChild(option);
  }

  if (state.holes.length) {
    state.currentHole = state.holes[0];
    els.holeSelect.value = String(state.currentHole);
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
    els.yardageDetail.textContent = state.locationError;
  }
}

init();
