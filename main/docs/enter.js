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
  rememberTournamentId
} from "./app.js";
import {
  applyPendingScoreSubmissionsToTournament,
  clearPendingScoreSubmissionsMatching,
  enqueuePendingScoreSubmission,
  flushPendingScoreSubmissions,
  getPendingScoreSummary,
  isNetworkFailure,
} from "./offline.js";

function normalizePlayerCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function normalizeChatMessageInput(value) {
  return String(value || "")
    .replace(/\r\n?/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatChatTimestamp(value) {
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return "";
  return new Intl.DateTimeFormat([], {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ts));
}

const codeFromQuery = qs("code");
const normalizedCodeFromQuery = normalizePlayerCode(codeFromQuery || qs("c"));
if (normalizedCodeFromQuery) rememberPlayerCode(normalizedCodeFromQuery);
let code = normalizedCodeFromQuery || normalizePlayerCode(getRememberedPlayerCode()) || "";
const forms = document.getElementById("round_forms");
const pageBottomActions = document.getElementById("enter_page_bottom_actions");
const pageChangeCodeButton = document.getElementById("enter_change_code_page_btn");
const ticker = document.getElementById("enter_ticker");
const tickerTitle = document.getElementById("enter_ticker_title");
const tickerTrack = document.getElementById("enter_ticker_track");
const brandDot = document.querySelector(".brand .dot");
const scoreNotifier = document.getElementById("score_notifier");
const chatMount = document.getElementById("enter_chat_mount");
const CHAT_MESSAGE_MAX_LENGTH = 240;
const CHAT_REFRESH_MS = 30000;

const teamColors = createTeamColorRegistry();
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
let scoreNotifierTimerId = 0;
let scoreNotifierQueue = [];
let scoreNotifierActive = false;
const SCORE_NOTIFIER_SHOW_MS = 2300;
const SCORE_NOTIFIER_GAP_MS = 200;
const TICKER_SPEED_PX_PER_SEC = 52;
const TICKER_START_DELAY_MS = 3000;
const TICKER_NEXT_DELAY_MS = 3000;
const SCORE_WHEEL_MIN = 1;
const SCORE_WHEEL_MAX = 20;
const SCORE_WHEEL_VALUES = ["", ...Array.from({ length: SCORE_WHEEL_MAX }, (_, index) => String(index + SCORE_WHEEL_MIN))];
const GEO_GRANTED_KEY = "hole-map:geo-granted";
const ENTER_LOCATION_TIMEOUT_MS = 15000;
const IS_LOCALHOST = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0)$/i.test(window.location.hostname);
const DATA_ROOT_CANDIDATES = [
  ...(IS_LOCALHOST
    ? [
      "../../golf_course_hole_geo_data/data",
      "./data",
      "/golf_tournaments/golf_course_hole_geo_data/data",
      "/golf_course_hole_geo_data/data",
      `${STATIC_BASE}/course-data`,
    ]
    : [
      `${STATIC_BASE}/course-data`,
      "./data",
      "../../golf_course_hole_geo_data/data",
      "/golf_tournaments/golf_course_hole_geo_data/data",
      "/golf_course_hole_geo_data/data",
    ]),
];
const MAP_INDEX_CANDIDATES = DATA_ROOT_CANDIDATES.map((root) => `${root}/courses_map_index.json`);
let activeScoreWheel = null;
let courseMapIndexPromise = null;
let courseMapIndex = null;
const roundHoleYardageFallbacks = new Map();
const roundHoleYardageFallbackPromises = new Map();
const roundHoleCoordinateRowMaps = new Map();
const roundHoleCoordinateRowMapPromises = new Map();
const bluegolfCourseDataBases = new Map();
const bluegolfCourseDataBasePromises = new Map();
const enterLocationState = {
  granted: false,
  pending: false,
  error: "",
  autoPrompted: false,
  userLocation: null,
  locationAccuracyM: null,
  watchId: null,
  onMetricsChange: null,
};
const enterLocationPromptRefs = new Set();

function secureContextMessage() {
  if (window.isSecureContext) return "";
  return "Location requires HTTPS or localhost. Open this page via https:// (not file:// or plain http://).";
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

function enterLocationErrorText(error) {
  const codeMap = {
    1: "Location permission was denied.",
    2: "Location is unavailable.",
    3: "Location request timed out.",
  };
  const base = codeMap[error?.code] || "Could not get current location.";
  const detail = error?.message ? ` ${error.message}` : "";
  return `${base}${detail}`.trim();
}

function syncEnterLocationPromptUi() {
  for (const ref of Array.from(enterLocationPromptRefs)) {
    if (!ref?.root?.isConnected) enterLocationPromptRefs.delete(ref);
  }
  const secureMsg = secureContextMessage();
  const statusText = secureMsg || enterLocationState.error || "";
  const hasLiveLocation = Array.isArray(enterLocationState.userLocation);
  const trackingActive = hasLiveLocation || enterLocationState.watchId != null;
  for (const ref of enterLocationPromptRefs) {
    if (!ref?.root || !ref?.button || !ref?.status) continue;
    ref.root.hidden = false;
    ref.button.disabled = enterLocationState.pending && !trackingActive;
    ref.button.textContent = enterLocationState.pending && !trackingActive
      ? "Locating..."
      : trackingActive
        ? "Clear Location"
        : "Use My Location";
    ref.status.textContent = statusText;
    ref.status.hidden = !statusText;
  }
}

function notifyEnterLocationMetricsChanged() {
  if (typeof enterLocationState.onMetricsChange === "function") {
    try {
      enterLocationState.onMetricsChange();
    } catch (_) {
      // ignore UI update failures from stale callbacks
    }
  }
}

function stopEnterLocationTracking({ clearLocation = false } = {}) {
  if (enterLocationState.watchId != null && "geolocation" in navigator) {
    navigator.geolocation.clearWatch(enterLocationState.watchId);
    enterLocationState.watchId = null;
  }
  enterLocationState.pending = false;
  if (clearLocation) {
    enterLocationState.userLocation = null;
    enterLocationState.locationAccuracyM = null;
    enterLocationState.granted = false;
    enterLocationState.error = "";
    persistGeolocationGrant(false);
  }
  syncEnterLocationPromptUi();
  notifyEnterLocationMetricsChanged();
}

function parseEnterLocationFix(position) {
  const lon = Number(position?.coords?.longitude);
  const lat = Number(position?.coords?.latitude);
  const accuracyM = Number(position?.coords?.accuracy);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    coords: [lon, lat],
    accuracyM: Number.isFinite(accuracyM) ? accuracyM : null,
  };
}

function applyEnterLocationFix(position) {
  const fix = parseEnterLocationFix(position);
  if (!fix) {
    enterLocationState.error = "Location received, but coordinates were invalid.";
    syncEnterLocationPromptUi();
    notifyEnterLocationMetricsChanged();
    return false;
  }
  enterLocationState.userLocation = fix.coords;
  enterLocationState.locationAccuracyM = fix.accuracyM;
  enterLocationState.granted = true;
  enterLocationState.pending = false;
  enterLocationState.error = "";
  persistGeolocationGrant(true);
  syncEnterLocationPromptUi();
  notifyEnterLocationMetricsChanged();
  return true;
}

function handleEnterLocationFailure(error) {
  enterLocationState.pending = false;
  enterLocationState.error = enterLocationErrorText(error);
  if (error?.code === 1) {
    enterLocationState.granted = false;
    persistGeolocationGrant(false);
    stopEnterLocationTracking({ clearLocation: true });
    enterLocationState.error = enterLocationErrorText(error);
  }
  syncEnterLocationPromptUi();
  notifyEnterLocationMetricsChanged();
}

async function requestEnterLocation() {
  const secureMsg = secureContextMessage();
  if (secureMsg) {
    enterLocationState.error = secureMsg;
    syncEnterLocationPromptUi();
    return false;
  }
  if (!("geolocation" in navigator)) {
    enterLocationState.error = "This browser does not support geolocation.";
    syncEnterLocationPromptUi();
    return false;
  }
  if (enterLocationState.pending) return false;
  if (enterLocationState.watchId != null && Array.isArray(enterLocationState.userLocation)) {
    enterLocationState.granted = true;
    enterLocationState.error = "";
    syncEnterLocationPromptUi();
    notifyEnterLocationMetricsChanged();
    return true;
  }
  if (enterLocationState.watchId != null) {
    navigator.geolocation.clearWatch(enterLocationState.watchId);
    enterLocationState.watchId = null;
  }
  enterLocationState.pending = true;
  enterLocationState.error = "";
  syncEnterLocationPromptUi();
  const granted = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      enterLocationState.watchId = navigator.geolocation.watchPosition(
        (position) => {
          const ok = applyEnterLocationFix(position);
          finish(ok);
        },
        (error) => {
          handleEnterLocationFailure(error);
          finish(error || false);
        },
        {
          enableHighAccuracy: true,
          timeout: ENTER_LOCATION_TIMEOUT_MS,
          maximumAge: 0,
        }
      );
    } catch (error) {
      finish(error || false);
    }
  });
  if (granted === true) {
    return true;
  }
  if (!enterLocationState.error) {
    enterLocationState.pending = false;
    enterLocationState.granted = false;
    enterLocationState.error = enterLocationErrorText(granted);
    if (granted?.code === 1) persistGeolocationGrant(false);
    syncEnterLocationPromptUi();
    notifyEnterLocationMetricsChanged();
  }
  return false;
}

async function maybePromptForEnterLocation() {
  if (enterLocationState.autoPrompted) return;
  enterLocationState.autoPrompted = true;
  const secureMsg = secureContextMessage();
  if (secureMsg) {
    enterLocationState.error = secureMsg;
    syncEnterLocationPromptUi();
    return;
  }
  if (!("geolocation" in navigator)) {
    enterLocationState.error = "This browser does not support geolocation.";
    syncEnterLocationPromptUi();
    return;
  }

  const savedGranted = readGeolocationGrant();
  if (navigator.permissions?.query) {
    try {
      const perm = await navigator.permissions.query({ name: "geolocation" });
      if (perm.state === "granted") {
        enterLocationState.granted = true;
        enterLocationState.error = "";
        persistGeolocationGrant(true);
        syncEnterLocationPromptUi();
        void requestEnterLocation();
        return;
      }
      if (perm.state === "denied") {
        enterLocationState.granted = false;
        enterLocationState.error = "Location permission was denied.";
        persistGeolocationGrant(false);
        syncEnterLocationPromptUi();
        return;
      }
    } catch (_) {
      // ignore
    }
  }

  if (!savedGranted) {
    void requestEnterLocation();
    return;
  }
  enterLocationState.granted = true;
  syncEnterLocationPromptUi();
  void requestEnterLocation();
}

function createEnterLocationPrompt() {
  const root = el("div", { class: "enter-location-request" });
  const button = el("button", { class: "secondary", type: "button" }, "Use My Location");
  const status = el("div", { class: "small enter-location-request-status" }, "");
  status.hidden = true;
  bindImmediateButtonAction(button, () => {
    if (Array.isArray(enterLocationState.userLocation) || enterLocationState.watchId != null) {
      stopEnterLocationTracking({ clearLocation: true });
      return;
    }
    void requestEnterLocation();
  });
  root.appendChild(button);
  root.appendChild(status);
  enterLocationPromptRefs.add({ root, button, status });
  syncEnterLocationPromptUi();
  return root;
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to load ${path}: ${response.status}`);
  return response.json();
}

function normalizeTeamId(teamId) {
  return teamId == null ? "" : String(teamId).trim();
}

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function normalizeCourseLookupKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token
      .replace(/^bluegolf/, "")
      .replace(/countryclub/g, "")
      .replace(/golf/g, "")
      .replace(/course/g, "")
      .replace(/club/g, "")
      .replace(/gc$/g, ""))
    .filter(Boolean)
    .join("");
}

function toRad(value) {
  return (Number(value) * Math.PI) / 180;
}

function distanceYards(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length < 2 || b.length < 2) return null;
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  if (![lon1, lat1, lon2, lat2].every((value) => Number.isFinite(Number(value)))) return null;
  const earthRadiusMeters = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const lat1Rad = toRad(lat1);
  const lat2Rad = toRad(lat2);
  const haversine =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.sin(dLon / 2) ** 2;
  const meters = 2 * earthRadiusMeters * Math.asin(Math.sqrt(haversine));
  return meters * 1.0936133;
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

function seedTeamColors(tjson, playersById) {
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
  (tjson?.teams || []).forEach((t) => add(t?.teamId || t?.id, t?.teamName || t?.name, t?.color));
  Object.values(playersById || {}).forEach((p) => add(p?.teamId, p?.teamName));

  teamColors.reset(ordered.length);
  ordered.forEach((team) => {
    teamColors.add(team.teamId, team.teamName, team.color);
  });
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

function groupLabelForPlayer(player) {
  const g = normalizeGroup(player?.group);
  return g ? `Group ${g}` : "";
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

function formatLabel(format) {
  const normalized = normalizeTwoManFormat(format) || String(format || "").trim().toLowerCase();
  if (normalized === "two_man_scramble") return "two man scramble";
  if (normalized === "two_man_shamble") return "two man shamble";
  if (normalized === "two_man_best_ball") return "two man best ball";
  return normalized || "singles";
}

function parseTwoManGroupId(groupId) {
  const s = String(groupId || "").trim();
  const idx = s.indexOf("::");
  if (idx < 0) return { teamId: "", group: "" };
  return { teamId: s.slice(0, idx), group: s.slice(idx + 2) };
}

function normalizeTeeValue(v) {
  return String(v || "")
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

function teeTimeDisplayValue(v) {
  return String(v || "").trim();
}

function teeTimeDisplayForPlayerRound(player, roundIndex) {
  if (!player || roundIndex < 0) return "";
  if (Array.isArray(player?.teeTimes)) {
    const v = teeTimeDisplayValue(player.teeTimes[roundIndex]);
    if (v) return v;
  }
  if (roundIndex === 0) {
    const fallback = teeTimeDisplayValue(player?.teeTime);
    if (fallback) return fallback;
  }
  return "";
}

function teeTimeDisplayForPlayerIds(playerIds, playersById, roundIndex) {
  for (const pid of playerIds || []) {
    const p = playersById?.[pid];
    const v = teeTimeDisplayForPlayerRound(p, roundIndex);
    if (v) return v;
  }
  return "";
}

function teeTimeDisplayForTeamRound(teamId, playersById, roundIndex) {
  const tid = normalizeTeamId(teamId);
  if (!tid) return "";
  for (const p of Object.values(playersById || {})) {
    if (normalizeTeamId(p?.teamId) !== tid) continue;
    const v = teeTimeDisplayForPlayerRound(p, roundIndex);
    if (v) return v;
  }
  return "";
}

function defaultCourse() {
  return {
    pars: Array(18).fill(4),
    strokeIndex: Array.from({ length: 18 }, (_, i) => i + 1)
  };
}

function normalizeCourseShape(course) {
  const pars = Array.isArray(course?.pars) && course.pars.length === 18
    ? course.pars.map((v) => Number(v) || 4)
    : null;
  const strokeIndex = Array.isArray(course?.strokeIndex) && course.strokeIndex.length === 18
    ? course.strokeIndex.map((v) => Number(v) || 0)
    : null;
  if (!pars || !strokeIndex) return null;
  const totalYardsRaw = Number(course?.totalYards);
  const totalYards = Number.isFinite(totalYardsRaw) ? Math.round(totalYardsRaw) : null;
  const holeYardages = Array.isArray(course?.holeYardages) && course.holeYardages.length === 18
    ? course.holeYardages.map((v) => Number(v) || 0)
    : null;
  const ratings = Array.isArray(course?.ratings)
    ? course.ratings
        .map((entry) => {
          const gender = String(entry?.gender || "").trim().toUpperCase();
          const rating = Number(entry?.rating);
          const slope = Number(entry?.slope);
          if (!gender && !Number.isFinite(rating) && !Number.isFinite(slope)) return null;
          return {
            ...(gender ? { gender } : {}),
            ...(Number.isFinite(rating) ? { rating } : {}),
            ...(Number.isFinite(slope) ? { slope: Math.round(slope) } : {})
          };
        })
        .filter(Boolean)
    : [];
  return {
    ...(course?.name ? { name: String(course.name) } : {}),
    ...(course?.sourceCourseId ? { sourceCourseId: String(course.sourceCourseId) } : {}),
    ...(course?.selectedTeeKey ? { selectedTeeKey: String(course.selectedTeeKey) } : {}),
    ...(course?.teeName ? { teeName: String(course.teeName) } : {}),
    ...(course?.teeLabel ? { teeLabel: String(course.teeLabel) } : {}),
    ...(Number.isFinite(totalYards) ? { totalYards } : {}),
    ...(holeYardages ? { holeYardages } : {}),
    ...(ratings.length ? { ratings } : {}),
    pars,
    strokeIndex
  };
}

function courseListFromTournament(tjson) {
  const fromList = Array.isArray(tjson?.courses)
    ? tjson.courses.map((course) => normalizeCourseShape(course)).filter(Boolean)
    : [];
  if (fromList.length) return fromList;
  const legacy = normalizeCourseShape(tjson?.course);
  if (legacy) return [legacy];
  return [defaultCourse()];
}

function courseForRound(tjson, roundIndex) {
  const courses = courseListFromTournament(tjson);
  const rounds = tjson?.tournament?.rounds || [];
  const idxRaw = Number(rounds?.[roundIndex]?.courseIndex);
  const idx = Number.isInteger(idxRaw) && idxRaw >= 0 && idxRaw < courses.length ? idxRaw : 0;
  return courses[idx] || courses[0] || defaultCourse();
}

function courseListFromTournamentRaw(tjson) {
  const fromList = Array.isArray(tjson?.courses)
    ? tjson.courses.filter((course) => course && typeof course === "object")
    : [];
  if (fromList.length) return fromList;
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

function holeYardagesForRound(tjson, roundIndex) {
  const raw = courseForRoundRaw(tjson, roundIndex)?.holeYardages;
  if (!Array.isArray(raw) || raw.length !== 18) return null;
  const values = raw.map((value) => Number(value));
  return values.every((value) => Number.isFinite(value)) ? values : null;
}

function fallbackHoleYardagesForRound(roundIndex) {
  return roundHoleYardageFallbacks.get(roundIndex) || null;
}

async function fetchCourseMapIndex() {
  for (const candidate of MAP_INDEX_CANDIDATES) {
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
    courses: [],
  };
}

async function ensureCourseMapIndex() {
  if (courseMapIndex) return courseMapIndex;
  if (!courseMapIndexPromise) {
    courseMapIndexPromise = fetchCourseMapIndex().catch(() => ({
      generated_at_utc: "",
      data_root: "",
      course_count: 0,
      counts_by_map_level: { full: 0, simplified: 0, none: 0 },
      courses_by_slug: {},
      courses: [],
    }));
  }
  courseMapIndex = await courseMapIndexPromise;
  return courseMapIndex;
}

function resolveCourseMapMeta(course, mapIndex) {
  if (!course || !mapIndex) return null;
  const bySlug = mapIndex?.courses_by_slug || {};
  const courses = Array.isArray(mapIndex?.courses) ? mapIndex.courses : [];
  const courseName = course?.name || course?.courseName || course?.title;

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
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  for (const slug of slugCandidates) {
    if (bySlug[slug]) return { slug, ...bySlug[slug] };
  }

  const targetNameKey = normalizeKey(course?.name || course?.courseName || course?.title);
  if (targetNameKey) {
    const exact = courses.find((item) => normalizeKey(item?.name) === targetNameKey);
    if (exact?.slug) return { slug: exact.slug, ...exact };
  }

  const lookupKeys = new Set([
    normalizeCourseLookupKey(courseName),
    ...slugCandidates.map((value) => normalizeCourseLookupKey(value)),
  ].filter(Boolean));
  if (lookupKeys.size) {
    const relaxed = courses.find((item) => [
      item?.slug,
      item?.name,
      item?.path,
    ].some((value) => lookupKeys.has(normalizeCourseLookupKey(value))));
    if (relaxed?.slug) return { slug: relaxed.slug, ...relaxed };
  }

  if (slugCandidates.length) {
    return {
      slug: slugCandidates[0],
      name: courseName || slugCandidates[0],
    };
  }
  return null;
}

function dataCandidatesForSlug(slug) {
  return DATA_ROOT_CANDIDATES.map((root) => `${root}/${slug}`);
}

async function resolveBluegolfCourseDataBase(slug) {
  const normalizedSlug = String(slug || "").trim();
  if (!normalizedSlug) return "";
  if (bluegolfCourseDataBases.has(normalizedSlug)) return bluegolfCourseDataBases.get(normalizedSlug) || "";
  if (bluegolfCourseDataBasePromises.has(normalizedSlug)) return bluegolfCourseDataBasePromises.get(normalizedSlug);

  const promise = (async () => {
    for (const candidate of dataCandidatesForSlug(normalizedSlug)) {
      const probe = `${candidate}/bluegolf_course_data.json`;
      try {
        const response = await fetch(probe, { cache: "no-store" });
        if (response.ok) {
          bluegolfCourseDataBases.set(normalizedSlug, candidate);
          return candidate;
        }
      } catch (_) {
        // continue
      }
    }
    bluegolfCourseDataBases.set(normalizedSlug, "");
    return "";
  })().finally(() => {
    bluegolfCourseDataBasePromises.delete(normalizedSlug);
  });

  bluegolfCourseDataBasePromises.set(normalizedSlug, promise);
  return promise;
}

function extractFallbackHoleYardages(courseData) {
  const candidates = [
    courseData?.holeYardages,
    courseData?.longestTees?.[0]?.holeYardages,
    courseData?.tees?.[0]?.holeYardages,
  ];
  for (const raw of candidates) {
    if (!Array.isArray(raw) || raw.length !== 18) continue;
    const values = raw.map((value) => Number(value));
    if (values.every((value) => Number.isFinite(value))) return values;
  }
  return null;
}

async function ensureHoleYardageFallbackForRound(tjson, roundIndex) {
  const roundYardages = holeYardagesForRound(tjson, roundIndex);
  if (Array.isArray(roundYardages)) return roundYardages;
  if (roundHoleYardageFallbacks.has(roundIndex)) return roundHoleYardageFallbacks.get(roundIndex);
  if (roundHoleYardageFallbackPromises.has(roundIndex)) {
    return roundHoleYardageFallbackPromises.get(roundIndex);
  }

  const promise = (async () => {
    let yardages = null;
    const course = courseForRoundRaw(tjson, roundIndex);
    if (course) {
      const mapIndex = await ensureCourseMapIndex();
      const meta = resolveCourseMapMeta(course, mapIndex);
      const slug = String(meta?.slug || "").trim();
      if (slug) {
        const dataBase = await resolveBluegolfCourseDataBase(slug);
        if (dataBase) {
          const courseData = await fetchJson(`${dataBase}/bluegolf_course_data.json`);
          yardages = extractFallbackHoleYardages(courseData);
        }
      }
    }
    roundHoleYardageFallbacks.set(roundIndex, yardages);
    return yardages;
  })()
    .catch(() => {
      roundHoleYardageFallbacks.set(roundIndex, null);
      return null;
    })
    .finally(() => {
      roundHoleYardageFallbackPromises.delete(roundIndex);
    });

  roundHoleYardageFallbackPromises.set(roundIndex, promise);
  return promise;
}

async function ensureHoleCoordinateRowsForRound(tjson, roundIndex) {
  if (roundHoleCoordinateRowMaps.has(roundIndex)) return roundHoleCoordinateRowMaps.get(roundIndex);
  if (roundHoleCoordinateRowMapPromises.has(roundIndex)) {
    return roundHoleCoordinateRowMapPromises.get(roundIndex);
  }

  const promise = (async () => {
    let rowMap = null;
    const course = courseForRoundRaw(tjson, roundIndex);
    if (course) {
      const mapIndex = await ensureCourseMapIndex();
      const meta = resolveCourseMapMeta(course, mapIndex);
      const slug = String(meta?.slug || "").trim();
      if (slug) {
        const dataBase = await resolveBluegolfCourseDataBase(slug);
        if (dataBase) {
          const [rows, courseData] = await Promise.all([
            fetchJson(`${dataBase}/bluegolf_tee_green_coordinates.json`).catch(() => []),
            fetchJson(`${dataBase}/bluegolf_course_data.json`).catch(() => null),
          ]);
          if (!roundHoleYardageFallbacks.has(roundIndex)) {
            roundHoleYardageFallbacks.set(roundIndex, extractFallbackHoleYardages(courseData));
          }
          rowMap = new Map();
          for (const row of Array.isArray(rows) ? rows : []) {
            const hole = Number(row?.hole);
            if (!Number.isFinite(hole)) continue;
            rowMap.set(hole, row);
          }
        }
      }
    }
    roundHoleCoordinateRowMaps.set(roundIndex, rowMap);
    return rowMap;
  })()
    .catch(() => {
      roundHoleCoordinateRowMaps.set(roundIndex, null);
      return null;
    })
    .finally(() => {
      roundHoleCoordinateRowMapPromises.delete(roundIndex);
    });

  roundHoleCoordinateRowMapPromises.set(roundIndex, promise);
  return promise;
}

function formatMetricYards(value) {
  return Number.isFinite(value) ? String(Math.round(value)) : "—";
}

function hasBluegolfYardageDataForRound(roundIndex) {
  const rowMap = roundHoleCoordinateRowMaps.get(roundIndex);
  if (rowMap instanceof Map && rowMap.size > 0) return true;
  const fallbackYardages = fallbackHoleYardagesForRound(roundIndex);
  return Array.isArray(fallbackYardages) && fallbackYardages.some((value) => Number.isFinite(Number(value)));
}

function holeMetricValues(course, holeIndex, roundIndex) {
  const holeNumber = Number(holeIndex) + 1;
  const row = roundHoleCoordinateRowMaps.get(roundIndex)?.get(holeNumber) || null;
  const tee = readLonLatFromRow(row, "tee");
  const yardageSource = Array.isArray(enterLocationState.userLocation) ? enterLocationState.userLocation : tee;
  let front = Array.isArray(yardageSource) ? distanceYards(yardageSource, readLonLatFromRow(row, "green_front")) : null;
  let center = Array.isArray(yardageSource) ? distanceYards(yardageSource, readLonLatFromRow(row, "green_center")) : null;
  let back = Array.isArray(yardageSource) ? distanceYards(yardageSource, readLonLatFromRow(row, "green_back")) : null;

  if (!Number.isFinite(center)) center = Number.isFinite(front) ? front : back;
  if (!Number.isFinite(front)) front = Number.isFinite(center) ? center : back;
  if (!Number.isFinite(back)) back = Number.isFinite(center) ? center : front;

  const totalYardage = Number(course?.holeYardages?.[holeIndex]);
  const fallbackTotal = Number(fallbackHoleYardagesForRound(roundIndex)?.[holeIndex]);
  const defaultTotal = Number.isFinite(totalYardage) ? totalYardage : fallbackTotal;
  if (Number.isFinite(defaultTotal)) {
    if (!Number.isFinite(front)) front = defaultTotal;
    if (!Number.isFinite(center)) center = defaultTotal;
    if (!Number.isFinite(back)) back = defaultTotal;
  }

  return { front, center, back };
}

/**
 * Draft (unsent) edits so auto-refresh + rerenders never clobber typing.
 * Structure:
 * draftByRound[r] = {
 *   hole: { [holeIndex]: { [targetId]: string /* input.value  } },
 * bulk: { [targetId]: Array(18).fill(string | undefined) }
 * }
 */
const draftByRound = Object.create(null);

function ensureRoundDraft(r) {
  if (!draftByRound[r]) draftByRound[r] = { hole: Object.create(null), bulk: Object.create(null) };
  return draftByRound[r];
}

function getHoleDraft(r, holeIndex, targetId) {
  return draftByRound[r]?.hole?.[holeIndex]?.[targetId];
}
function setHoleDraft(r, holeIndex, targetId, valueStr) {
  const rd = ensureRoundDraft(r);
  if (!rd.hole[holeIndex]) rd.hole[holeIndex] = Object.create(null);
  rd.hole[holeIndex][targetId] = valueStr; // keep even "" so it stays pristine on rerender
}
function clearHoleDraftTargets(r, holeIndex, targetIds) {
  const h = draftByRound[r]?.hole?.[holeIndex];
  if (!h) return;
  for (const id of targetIds) delete h[id];
  if (Object.keys(h).length === 0) delete draftByRound[r].hole[holeIndex];
}

function getBulkDraft(r, targetId, holeIndex) {
  return draftByRound[r]?.bulk?.[targetId]?.[holeIndex];
}
function setBulkDraft(r, targetId, holeIndex, valueStr) {
  const rd = ensureRoundDraft(r);
  if (!rd.bulk[targetId]) rd.bulk[targetId] = Array(18).fill(undefined);
  rd.bulk[targetId][holeIndex] = valueStr; // keep "" too
}
function clearRoundDraft(r) {
  delete draftByRound[r];
}

function el(tag, attrs = {}, html = null) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "style") n.setAttribute("style", v);
    else n.setAttribute(k, v);
  }
  if (html != null) n.innerHTML = html;
  return n;
}

function isEmptyScore(v) {
  // Treat null/undefined/""/0 as "not played yet" for UI purposes
  return v == null || Number(v) === 0;
}

function isCompleteScoreArray(arr) {
  const scores = Array.isArray(arr) ? arr : Array(18).fill(null);
  return scores.length >= 18 && scores.slice(0, 18).every((v) => !isEmptyScore(v));
}

function nextHoleIndexForGroup(savedByTarget, targetIds) {
  // choose the lowest hole where at least one target doesn't have a score yet
  for (let i = 0; i < 18; i++) {
    for (const id of targetIds) {
      const arr = savedByTarget[id] || Array(18).fill(null);
      const v = arr[i];
      if (isEmptyScore(v)) return i;
    }
  }
  return 17;
}

function holeLabel(i) {
  return `Hole ${i + 1}`;
}

function holeYardageText(course, holeIndex, roundIndex = null) {
  const yards = Number(course?.holeYardages?.[holeIndex]);
  if (Number.isFinite(yards) && yards > 0) return `${Math.round(yards)}y`;
  if (roundIndex == null) return "—";
  const fallbackYards = Number(fallbackHoleYardagesForRound(roundIndex)?.[holeIndex]);
  if (Number.isFinite(fallbackYards) && fallbackYards > 0) return `${Math.round(fallbackYards)}y`;
  return "—";
}

function holeSummaryLabel(course, holeIndex, roundIndex = null) {
  const par = Number(course?.pars?.[holeIndex]);
  const parText = Number.isFinite(par) && par > 0 ? String(Math.round(par)) : "—";
  return `${holeLabel(holeIndex)} | Par ${parText} | ${holeYardageText(course, holeIndex, roundIndex)}`;
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
  if (Number(row.grossTotal || 0) > 0) return true;
  if (Number(row.netTotal || 0) > 0) return true;
  if (hasAnyScore(row.scores?.gross)) return true;
  if (hasAnyScore(row.scores?.net)) return true;
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

function normalizeScoreWheelValue(value) {
  if (value == null) return "";
  const raw = String(value).trim();
  if (!raw) return "";
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return "";
  return String(Math.max(SCORE_WHEEL_MIN, Math.min(SCORE_WHEEL_MAX, Math.round(parsed))));
}

function createScoreWheel(initialValue, { onChange, parValue } = {}) {
  const hiddenInput = document.createElement("input");
  hiddenInput.type = "hidden";
  hiddenInput.value = normalizeScoreWheelValue(initialValue);
  const normalizedParValue = normalizeScoreWheelValue(parValue);

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
  let suppressScrollSelection = false;

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

  function defaultOpenOption() {
    if (selectedValue) return currentOption();
    if (normalizedParValue) return optionByValue.get(normalizedParValue) || currentOption();
    return currentOption();
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
    if (activeScoreWheel && activeScoreWheel !== controls) {
      activeScoreWheel.close({ restoreFocus: false });
    }
    isOpen = true;
    shell.classList.add("is-active");
    viewport.hidden = false;
    updateDisplayUi();
    const openOption = defaultOpenOption();
    suppressScrollSelection = !selectedValue && Boolean(openOption);
    centerOption(openOption, "auto");
    activeScoreWheel = controls;
    if (!removeOutsidePointerListener) {
      const onPointerDownOutside = (event) => {
        if (shell.contains(event.target)) return;
        if (
          event.target instanceof Element &&
          event.target.closest('button, a, input, select, textarea, label, [role="button"]')
        ) {
          return;
        }
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
    if (suppressScrollSelection) {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          suppressScrollSelection = false;
        });
      });
    }
  }

  function close({ restoreFocus = false } = {}) {
    if (!isOpen) return;
    isOpen = false;
    shell.classList.remove("is-active");
    viewport.hidden = true;
    if (scrollSettleTimerId) {
      clearTimeout(scrollSettleTimerId);
      scrollSettleTimerId = 0;
    }
    if (removeOutsidePointerListener) removeOutsidePointerListener();
    updateDisplayUi();
    if (activeScoreWheel === controls) activeScoreWheel = null;
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
    if (value && value === normalizedParValue) {
      option.classList.add("is-par");
      option.setAttribute("aria-label", `Par ${value}`);
      option.title = `Par ${value}`;
    }
    option.id = `enter_score_wheel_${index}_${Math.random().toString(36).slice(2, 8)}`;
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
    if (suppressScrollSelection) return;
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
    viewport,
    open,
    close,
    sync() {
      setValue(selectedValue, { align: isOpen, behavior: "auto", emit: false });
    },
  };
  return controls;
}

function closeActiveScoreWheel() {
  if (activeScoreWheel?.close) activeScoreWheel.close({ restoreFocus: false });
  activeScoreWheel = null;
}

function bindImmediateButtonAction(button, action) {
  if (!(button instanceof HTMLElement) || typeof action !== "function") return;
  let suppressPointerClick = false;
  button.addEventListener("pointerdown", (event) => {
    if (button instanceof HTMLButtonElement && button.disabled) return;
    if (typeof event.button === "number" && event.button !== 0) return;
    suppressPointerClick = true;
    event.preventDefault();
    void action(event);
    window.setTimeout(() => {
      suppressPointerClick = false;
    }, 0);
  });
  button.addEventListener("click", (event) => {
    if (button instanceof HTMLButtonElement && button.disabled) return;
    if (suppressPointerClick && event.detail !== 0) {
      event.preventDefault();
      return;
    }
    void action(event);
  });
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
  for (let i = 0; i < 18; i++) {
    const score = holes[i];
    if (score == null || Number(score) <= 0) continue;
    played++;
    diff += Number(score) - Number(pars[i] || 0);
  }
  return played ? toParText(diff) : null;
}

function rowParArray(row, fallbackPars) {
  return Array.isArray(row?.scores?.par) && row.scores.par.length === 18
    ? row.scores.par
    : fallbackPars;
}

function grossToParText(row, pars) {
  const explicit = toParFromKeys(row, [
    "toParGross",
    "grossToPar",
    "toParGrossTotal",
    "grossToParTotal"
  ]);
  if (explicit != null) return explicit;
  const parArray = rowParArray(row, pars);
  const fromScores = parDiffFromHoles(row?.scores?.gross, parArray);
  if (fromScores != null) return fromScores;
  const gross = grossForRow(row);
  const parTotal = sumHoles(parArray);
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
    "netToParTotal"
  ]);
  if (explicit != null) return explicit;
  const parArray = rowParArray(row, pars);
  const fromScores = parDiffFromHoles(row?.scores?.net, parArray);
  if (fromScores != null) return fromScores;
  const net = netForRow(row);
  const parTotal = sumHoles(parArray);
  if (net != null && parTotal > 0 && Number(row?.thru || 0) >= 18) {
    return toParText(Number(net) - parTotal);
  }
  return toParText(row?.toPar);
}

function scoreEntryTitleParText(row, pars) {
  if (!rowHasAnyData(row)) return "";
  return `${grossToParText(row, pars)} [${netToParText(row, pars)}]`;
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

function normalizePostedScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function scoreValue(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return String(Math.round(n));
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

function scoreSourceForRound(roundData, roundCfg) {
  const format = String(roundCfg?.format || "").toLowerCase();
  if (format === "scramble" || format === "team_best_ball") {
    const teamEntries = Object.entries(roundData?.team || {});
    return { type: "team", entries: teamEntries };
  }

  const playerEntries = Object.entries(roundData?.player || {});
  if (playerEntries.length) return { type: "player", entries: playerEntries };
  const teamEntries = Object.entries(roundData?.team || {});
  return { type: "team", entries: teamEntries };
}

function findTwoManNotificationGroupEntry(roundData, teamId, groupKey) {
  const teamEntry = roundData?.team?.[teamId] || {};
  const wanted = normalizeGroup(groupKey);
  for (const [rawKey, entry] of Object.entries(teamEntry?.groups || {})) {
    if (normalizeGroup(rawKey) === wanted) return entry || {};
  }
  return {};
}

function notificationRowFromGroupEntry(groupEntry) {
  const gross = (Array.isArray(groupEntry?.gross) ? groupEntry.gross : Array(18).fill(null))
    .map((value) => (isEmptyScore(value) ? null : Number(value)));
  const net = (Array.isArray(groupEntry?.net) ? groupEntry.net : gross)
    .map((value) => (isEmptyScore(value) ? null : Number(value)));
  const grossTotal = groupEntry?.grossTotal ?? sumHoles(gross);
  const netTotal = groupEntry?.netTotal ?? sumHoles(net);
  const thru = gross.reduce((count, value) => count + (isEmptyScore(value) ? 0 : 1), 0);
  return {
    gross: grossTotal,
    net: netTotal,
    toPar: groupEntry?.toPar ?? groupEntry?.netToParTotal ?? groupEntry?.grossToParTotal ?? 0,
    thru,
    scores: {
      gross,
      net,
      grossTotal,
      netTotal,
      grossToParTotal: groupEntry?.grossToParTotal,
      netToParTotal: groupEntry?.netToParTotal,
      thru
    }
  };
}

function scoreNotificationTargetMeta(tournament, roundData, roundIndex, roundCfg, rawId, playerRows, teamRows, playerNames, teamNames, playersById) {
  const id = String(rawId || "").trim();
  const format = String(roundCfg?.format || "").toLowerCase();
  const twoManFormat = normalizeTwoManFormat(format);
  if (!id) return null;

  if (format === "scramble" || format === "team_best_ball") {
    const teamId = normalizeTeamId(id);
    const entry = roundData?.team?.[teamId] || {};
    const row = teamRows.get(teamId) || entry || null;
    return {
      targetId: teamId,
      entry,
      row,
      name: row?.teamName || teamNames.get(teamId) || teamId || "Team"
    };
  }

  if (twoManFormat) {
    let teamId = "";
    let groupKey = "";
    if (id.includes("::")) {
      const parsed = parseTwoManGroupId(id);
      teamId = normalizeTeamId(parsed.teamId);
      groupKey = normalizeGroup(parsed.group);
    } else {
      const player = playersById[id] || null;
      teamId = normalizeTeamId(player?.teamId);
      groupKey = groupForPlayerRound(player, roundIndex);
    }
    if (teamId && groupKey) {
      const targetId = twoManGroupId(teamId, groupKey);
      const entry = findTwoManNotificationGroupEntry(roundData, teamId, groupKey);
      const playerIds = (tournament?.players || [])
        .filter((player) => normalizeTeamId(player?.teamId) === teamId && groupForPlayerRound(player, roundIndex) === groupKey)
        .map((player) => String(player?.playerId || "").trim())
        .filter(Boolean);
      const row =
        playerIds.map((playerId) => playerRows.get(playerId)).find(Boolean) ||
        (Object.keys(entry || {}).length ? notificationRowFromGroupEntry(entry) : null);
      return {
        targetId,
        entry,
        row,
        name: twoManPairLabel(playerIds, playersById, groupKey)
      };
    }
  }

  const row = playerRows.get(id) || roundData?.player?.[id] || null;
  return {
    targetId: id,
    entry: roundData?.player?.[id] || {},
    row,
    name: row?.name || playerNames.get(id) || id
  };
}

function collectNewScoreEvents(prevTournament, nextTournament) {
  if (!prevTournament || !nextTournament) return [];

  const events = [];
  const prevRounds = prevTournament?.score_data?.rounds || [];
  const nextRounds = nextTournament?.score_data?.rounds || [];
  const prevRoundCfgs = prevTournament?.tournament?.rounds || [];
  const nextRoundCfgs = nextTournament?.tournament?.rounds || [];

  const playerNames = new Map();
  (nextTournament?.players || []).forEach((p) => {
    const id = String(p?.playerId || "").trim();
    if (id) playerNames.set(id, p?.name || id);
  });

  const teamNames = new Map();
  (nextTournament?.teams || []).forEach((t) => {
    const id = String(t?.teamId ?? t?.id ?? "").trim();
    if (id) teamNames.set(id, t?.teamName ?? t?.name ?? id);
  });

  const playersById = Object.create(null);
  (nextTournament?.players || []).forEach((player) => {
    const id = String(player?.playerId || "").trim();
    if (id) playersById[id] = player;
  });

  for (let roundIndex = 0; roundIndex < nextRounds.length; roundIndex++) {
    const nextRound = nextRounds[roundIndex] || {};
    const prevRound = prevRounds[roundIndex] || {};
    const nextRoundCfg = nextRoundCfgs[roundIndex] || {};
    const prevRoundCfg = prevRoundCfgs[roundIndex] || nextRoundCfg;
    const coursePars = courseForRound(nextTournament, roundIndex).pars || Array(18).fill(4);
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

    const prevPlayerRows = new Map();
    (prevRound?.leaderboard?.players || []).forEach((row) => {
      const id = String(row?.playerId || "").trim();
      if (id) prevPlayerRows.set(id, row);
    });

    const prevTeamRows = new Map();
    (prevRound?.leaderboard?.teams || []).forEach((row) => {
      const id = String(row?.teamId || "").trim();
      if (id) prevTeamRows.set(id, row);
    });

    const seenTargets = new Set();

    for (const [idRaw, nextEntry] of nextSource.entries) {
      const meta = scoreNotificationTargetMeta(
        nextTournament,
        nextRound,
        roundIndex,
        nextRoundCfg,
        idRaw,
        playerRows,
        teamRows,
        playerNames,
        teamNames,
        playersById
      );
      if (!meta?.targetId || seenTargets.has(meta.targetId)) continue;
      seenTargets.add(meta.targetId);

      const prevMeta = scoreNotificationTargetMeta(
        nextTournament,
        prevRound,
        roundIndex,
        prevRoundCfg,
        idRaw,
        prevPlayerRows,
        prevTeamRows,
        playerNames,
        teamNames,
        playersById
      );
      const prevEntry = prevMeta?.entry || prevById.get(String(idRaw || "").trim()) || null;
      const row = meta.row;
      const name = meta.name;
      const nextTargetEntry = meta.entry || nextEntry;

      const showGrossAndNet = !!nextRoundCfg.useHandicap;
      const grossToPar = showGrossAndNet ? grossToParText(row, coursePars) : null;
      const netToPar = showGrossAndNet ? netToParText(row, coursePars) : null;
      const toPar = showGrossAndNet
        ? `${grossToPar} [${netToPar}]`
        : leaderboardToParValue(row, coursePars, false);
      for (let holeIndex = 0; holeIndex < 18; holeIndex++) {
        const nextGross = normalizePostedScore(nextTargetEntry?.gross?.[holeIndex]);
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
          diffToPar
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

  const grossToPar = event.grossToPar != null ? toParText(event.grossToPar) : null;
  const netToPar = event.netToPar != null ? toParText(event.netToPar) : null;
  const toPar = toParText(event.toPar);

  const line = document.createElement("div");
  line.className = "score-notifier-line";
  line.appendChild(document.createTextNode(`${event.name} ${event.result} (`));
  if (grossToPar != null && netToPar != null) {
    const grossEl = document.createElement("span");
    grossEl.className = "score-emph-gross";
    grossEl.textContent = grossToPar;
    line.appendChild(grossEl);
    line.appendChild(document.createTextNode(" ["));
    const netEl = document.createElement("span");
    netEl.className = "score-emph-net";
    netEl.textContent = netToPar;
    line.appendChild(netEl);
    line.appendChild(document.createTextNode("]"));
  } else {
    line.appendChild(document.createTextNode(toPar));
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
    }
  }

  tickerRafId = requestAnimationFrame(runTickerFrame);
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
  const showIndividualNet =
    !!roundCfg.useHandicap && !isScrambleRound;
  const pars = courseForRound(tjson, safeRound).pars || Array(18).fill(4);

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
  teamDefs.forEach((t) => addTeamId(t?.teamId || t?.id));
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
          thru
        }
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
        .filter((p) => normalizeTeamId(p?.teamId) === teamId && groupForPlayerRound(p, safeRound) === group)
        .map((p) => p?.playerId)
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
        row
      });
    }

    allPlayers.forEach((p) => addGroup(p?.teamId, groupForPlayerRound(p, safeRound)));
    Object.entries(roundData?.team || {}).forEach(([teamId, teamEntry]) => {
      Object.keys(teamEntry?.groups || {}).forEach((groupLabel) => addGroup(teamId, groupLabel));
    });
  } else {
    allPlayerIds.forEach((playerId) => {
      const row = playerRowById[playerId] || null;
      const p = playersById[playerId] || {};
      individualTickerRows.push({
        name: row?.name || p?.name || playerId || "Player",
        teamId: row?.teamId || p?.teamId,
        teeTime: teeTimeDisplayForPlayerRound(p, safeRound),
        row
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
      )
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
      )
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
      )
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
      )
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
      )
    };
  });
  sortTickerEntries(teamRoundGrossEntries);
  const teamRoundGrossItems = teamRoundGrossEntries.map((x) => x.node);

  // Update brand dot to weighted total leader color (all-rounds team standings).
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
    return;
  }

  if (tickerSectionIndex >= tickerSections.length) tickerSectionIndex = 0;
  setTickerSection(tickerSections[tickerSectionIndex], true);
}

function leaderboardHasAnyData(leaderboard) {
  const teams = leaderboard?.teams || [];
  for (const row of teams) {
    if (rowHasAnyData(row)) return true;
  }
  const players = leaderboard?.players || [];
  for (const row of players) {
    if (rowHasAnyData(row)) return true;
  }
  return false;
}

function roundHasAnyData(roundData) {
  if (!roundData) return false;
  if (leaderboardHasAnyData(roundData.leaderboard)) return true;

  const teamEntries = Object.values(roundData.team || {});
  for (const t of teamEntries) {
    if (hasAnyScore(t?.gross) || hasAnyScore(t?.net)) return true;
  }

  const playerEntries = Object.values(roundData.player || {});
  for (const p of playerEntries) {
    if (hasAnyScore(p?.gross) || hasAnyScore(p?.net)) return true;
  }
  return false;
}

async function main() {
  function clearCodeAndReload() {
    try {
      localStorage.removeItem(STORAGE_KEYS.playerCode);
    } catch { }
    const u = new URL(location.href);
    u.search = "";
    location.href = u.toString();
  }

  if (!code) {
    // No code provided: show page immediately so the code entry prompt is visible.
    $('body').show();
    forms.innerHTML = `
      <div class="card">
        <h3 style="margin:0 0 8px 0;">Enter your player code</h3>
        <div class="small" style="margin-bottom:10px;">Use your code from the player import file.</div>
        <label for="player_code_input">Player code</label>
        <input id="player_code_input" placeholder="XXXX" autocomplete="one-time-code" />
        <div class="actions" style="margin-top:10px;">
          <button id="player_code_go">Continue</button>
        </div>
      </div>
    `;
    const input = document.getElementById("player_code_input");
    const go = document.getElementById("player_code_go");
    input?.addEventListener("input", () => {
      input.value = normalizePlayerCode(input.value);
    });
    const onContinue = () => {
      const nextCode = normalizePlayerCode(input?.value);
      if (!nextCode) return;
      rememberPlayerCode(nextCode);
      location.search = `?code=${encodeURIComponent(nextCode)}`;
    };
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") onContinue();
    });
    go?.addEventListener("click", onContinue);
    return;
  }

  const enter = await staticJson(`/enter/${encodeURIComponent(code)}.json`, { cacheKey: `enter:${code}` });
  const tid = enter?.tournamentId;
  if (!tid) {
    // Code was provided but invalid; reveal page to show the error.
    $('body').show();
    forms.innerHTML = `
      <div class="card">
        <b>Invalid code.</b>
        <div class="actions" style="margin-top:10px;">
          <button id="change_code_btn_invalid" class="secondary" type="button">Use different code</button>
        </div>
      </div>
    `;
    document.getElementById("change_code_btn_invalid")?.addEventListener("click", clearCodeAndReload);
    return;
  }
  rememberPlayerCode(code);
  rememberTournamentId(tid);
  if (pageBottomActions) pageBottomActions.hidden = false;
  pageChangeCodeButton?.addEventListener("click", clearCodeAndReload);
  document.querySelectorAll("a[data-scoreboard-link]").forEach((link) => {
    link.setAttribute("href", `./scoreboard.html?t=${encodeURIComponent(tid)}`);
  });

  // Tournament public JSON (single file)
  let tjson = await staticJson(`/tournaments/${encodeURIComponent(tid)}.json`, { cacheKey: `t:${tid}` });
  tjson = await applyPendingScoreSubmissionsToTournament(tjson, { tid, code });
  setHeaderTournamentName(tjson?.tournament?.name);
  const hasTwoManTournament = (tjson?.tournament?.rounds || []).some(
    (round) => {
      return !!normalizeTwoManFormat(round?.format);
    }
  );
  const teeRoundCount = (tjson?.tournament?.rounds || []).length;
  const myTeeTimes = Array.from({ length: teeRoundCount }, (_, idx) => {
    const v = Array.isArray(enter?.player?.teeTimes) ? enter.player.teeTimes[idx] : null;
    return String(v || "").trim();
  });
  if (!myTeeTimes.some((v) => !!v) && enter?.player?.teeTime && myTeeTimes.length > 0) {
    myTeeTimes[0] = String(enter.player.teeTime).trim();
  }

  // Code path: reveal only after required data has loaded.
  $('body').show();

  const rounds = tjson.tournament?.rounds || [];

  const playersArr = tjson.players || [];
  const playersById = {};
  for (const p of playersArr) playersById[p.playerId] = p;
  const teamsById = {};
  for (const t of tjson.teams || []) {
    const teamId = t?.teamId || t?.id;
    if (!teamId) continue;
    teamsById[teamId] = t;
  }
  seedTeamColors(tjson, playersById);

  // Default group: self + same team players
  const myId = enter.player?.playerId;
  const myTeamId = (playersById[myId] || {}).teamId || enter.team?.teamId;
  function allowedPlayerIdsForRound(roundIndex) {
    const actor = playersById[myId] || enter.player || {};
    const actorTee = teeTimeForPlayerRound(actor, roundIndex);
    const ids = [];
    for (const p of playersArr) {
      const pid = p?.playerId;
      if (!pid) continue;
      if (!actorTee) {
        if (pid === myId) ids.push(pid);
        continue;
      }
      if (teeTimeForPlayerRound(p, roundIndex) === actorTee) ids.push(pid);
    }
    if (myId && !ids.includes(myId)) ids.unshift(myId);
    return Array.from(new Set(ids));
  }

  forms.innerHTML = "";

  function progressTargetIdsForRound(roundIndex) {
    const round = rounds[roundIndex] || {};
    const fmt = String(round.format || "singles").toLowerCase();
    if (fmt === "scramble") return [enter.team?.teamId].filter(Boolean);
    if (normalizeTwoManFormat(fmt) === "two_man_scramble") {
      const actorGroupId = twoManGroupId(myTeamId, groupForPlayerRound(playersById[myId], roundIndex));
      return [actorGroupId].filter(Boolean);
    }
    return [myId].filter(Boolean);
  }

  function savedScoresByTargetForRound(roundIndex) {
    const roundData = tjson.score_data?.rounds?.[roundIndex] || {};
    const round = rounds[roundIndex] || {};
    const fmt = String(round.format || "singles").toLowerCase();
    const savedByTarget = Object.create(null);
    if (fmt === "scramble") {
      for (const [teamId, teamEntry] of Object.entries(roundData.team || {})) {
        savedByTarget[teamId] = Array.isArray(teamEntry?.gross) ? teamEntry.gross : Array(18).fill(null);
      }
      return savedByTarget;
    }
    if (normalizeTwoManFormat(fmt) === "two_man_scramble") {
      for (const [teamId, teamEntry] of Object.entries(roundData.team || {})) {
        for (const [label, groupEntry] of Object.entries(teamEntry?.groups || {})) {
          const groupId = String(groupEntry?.groupId || twoManGroupId(teamId, label)).trim();
          if (!groupId) continue;
          savedByTarget[groupId] = Array.isArray(groupEntry?.gross) ? groupEntry.gross : Array(18).fill(null);
        }
      }
      return savedByTarget;
    }
    for (const [playerId, playerEntry] of Object.entries(roundData.player || {})) {
      savedByTarget[playerId] = Array.isArray(playerEntry?.gross) ? playerEntry.gross : Array(18).fill(null);
    }
    return savedByTarget;
  }

  function roundIsFullyCompletedForActor(roundIndex) {
    const progressIds = progressTargetIdsForRound(roundIndex);
    if (!progressIds.length) return false;
    const savedByTarget = savedScoresByTargetForRound(roundIndex);
    return progressIds.every((id) => isCompleteScoreArray(savedByTarget[id]));
  }

  // Open the earliest round whose actor progress target is not fully completed.
  function activeRoundIndex() {
    if (!rounds.length) return 0;
    for (let i = 0; i < rounds.length; i++) {
      if (!roundIsFullyCompletedForActor(i)) return i;
    }
    const scoreRounds = tjson.score_data?.rounds || [];
    for (let i = rounds.length - 1; i >= 0; i--) {
      if (roundHasAnyData(scoreRounds[i])) return i;
    }
    return rounds.length - 1;
  }
  const defaultOpenRound = activeRoundIndex();
  let tickerRoundIndex = defaultOpenRound;
  let activeRoundPaneIndex = defaultOpenRound;
  let refreshTournamentPromise = null;
  let pendingSyncPromise = null;
  const syncStatusEl = document.getElementById("entry_sync_status");
  const roundTabs = el("div", { class: "enter-tabs enter-round-tabs" });
  const roundPanesHost = el("div", { class: "enter-round-panes enter-score-page-shell" });
  const roundTabButtons = [];
  const roundPanes = [];
  const roundHoleRenderers = [];

  if (rounds.length) {
    forms.appendChild(roundPanesHost);
  }

  function setActiveRoundPane(nextRoundIndex) {
    if (!roundPanes.length) return;
    const safeRound = Number.isInteger(nextRoundIndex) && nextRoundIndex >= 0 && nextRoundIndex < roundPanes.length
      ? nextRoundIndex
      : 0;
    if (safeRound !== activeRoundPaneIndex) closeActiveScoreWheel();
    activeRoundPaneIndex = safeRound;
    roundTabButtons.forEach((button, index) => {
      button.classList.toggle("active", index === safeRound);
    });
    roundPanes.forEach((pane, index) => {
      pane.style.display = index === safeRound ? "" : "none";
    });
    tickerRoundIndex = safeRound;
    renderTeamCurrentScore();
    renderTicker(tjson, playersById, teamsById, tickerRoundIndex);
    const rerender = roundHoleRenderers[safeRound];
    if (typeof rerender === "function") rerender();
  }

  function replaceTournamentJson(nextJson) {
    if (!nextJson || nextJson === tjson) return;
    for (const key of Object.keys(tjson)) delete tjson[key];
    Object.assign(tjson, nextJson);
  }

  async function applyPendingScoresToCurrentTournament() {
    const nextJson = await applyPendingScoreSubmissionsToTournament(tjson, { tid, code });
    replaceTournamentJson(nextJson);
    return tjson;
  }

  async function renderSyncStatus(customMessage = "") {
    if (!syncStatusEl) return;
    const summary = await getPendingScoreSummary({ tid, code });
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
      } else if (!navigator.onLine) {
        text = "Offline: using cached tournament data until the connection returns.";
      }
    }

    syncStatusEl.textContent = text;
    syncStatusEl.style.color = color;
  }

  async function syncPendingScores({ quiet = false } = {}) {
    if (pendingSyncPromise) return pendingSyncPromise;
    pendingSyncPromise = (async () => {
      const summary = await getPendingScoreSummary({ tid, code });
      if (!summary.pendingCount || !navigator.onLine) {
        await renderSyncStatus();
        return summary;
      }
      if (!quiet) {
        await renderSyncStatus(`Syncing ${summary.pendingCount} queued score update${summary.pendingCount === 1 ? "" : "s"}…`);
      }
      const result = await flushPendingScoreSubmissions({
        tid,
        code,
        sendScore: (payload) =>
          api(`/tournaments/${encodeURIComponent(tid)}/scores`, {
            method: "POST",
            body: payload,
          }),
      });
      await refreshTournamentJson({ quietSync: true });
      await renderSyncStatus();
      return result;
    })();
    try {
      return await pendingSyncPromise;
    } finally {
      pendingSyncPromise = null;
    }
  }

  function renderTeamCurrentScore() {
    const target = document.getElementById("team_current_score");
    if (!target) return;

    const teamId = String(myTeamId || enter.team?.teamId || "").trim();
    if (!teamId) {
      target.textContent = "Current score: —";
      return;
    }

    const roundCount = rounds.length;
    if (!roundCount) {
      target.textContent = "Current score: —";
      return;
    }

    if (!Number.isInteger(tickerRoundIndex) || tickerRoundIndex < 0) tickerRoundIndex = 0;
    if (tickerRoundIndex >= roundCount) tickerRoundIndex = roundCount - 1;

    const roundCfg = rounds[tickerRoundIndex] || {};
    const isScrambleRound = String(roundCfg.format || "").toLowerCase() === "scramble";
    const isStableford = String(tjson?.tournament?.scoring || "").trim().toLowerCase() === "stableford";
    const useNet = !!roundCfg.useHandicap || isScrambleRound;
    const roundLabel = `R${tickerRoundIndex + 1}`;
    const pars = courseForRound(tjson, tickerRoundIndex).pars || Array(18).fill(4);
    const teamTeeFallback = isScrambleRound
      ? teeTimeDisplayForTeamRound(teamId, playersById, tickerRoundIndex)
      : "";

    const teamRows = tjson?.score_data?.rounds?.[tickerRoundIndex]?.leaderboard?.teams || [];
    const teamRow = teamRows.find((row) => String(row?.teamId || "").trim() === teamId);
    if (!teamRow || !rowHasAnyData(teamRow)) {
      target.textContent = teamTeeFallback
        ? `Current score (${roundLabel}): — (${teamTeeFallback})`
        : `Current score (${roundLabel}): —`;
      return;
    }

    const thru = holeDisplayFromThru(teamRow);
    if (isStableford) {
      const grossPoints = scoreValue(teamRow?.grossPoints);
      const netPoints = scoreValue(teamRow?.netPoints ?? teamRow?.points);
      if (!!roundCfg.useHandicap) {
        target.innerHTML = "";
        target.appendChild(document.createTextNode(`Current score (${roundLabel}): `));
        const grossEl = document.createElement("span");
        grossEl.className = "score-emph-gross";
        grossEl.textContent = grossPoints;
        target.appendChild(grossEl);
        target.appendChild(document.createTextNode(" ["));
        const netEl = document.createElement("span");
        netEl.className = "score-emph-net";
        netEl.textContent = netPoints;
        target.appendChild(netEl);
        target.appendChild(document.createTextNode(`] pts ${thru}`));
        return;
      }
      const points = useNet ? netPoints : grossPoints;
      target.textContent = `Current score (${roundLabel}): ${points} pts ${thru}`;
      return;
    }

    const grossToPar = grossToParText(teamRow, pars);
    const netToPar = netToParText(teamRow, pars);
    if (!!roundCfg.useHandicap) {
      target.innerHTML = "";
      target.appendChild(document.createTextNode(`Current score (${roundLabel}): `));
      const grossEl = document.createElement("span");
      grossEl.className = "score-emph-gross";
      grossEl.textContent = grossToPar;
      target.appendChild(grossEl);
      target.appendChild(document.createTextNode(" ["));
      const netEl = document.createElement("span");
      netEl.className = "score-emph-net";
      netEl.textContent = netToPar;
      target.appendChild(netEl);
      target.appendChild(document.createTextNode(`] ${thru}`));
      return;
    }
    const toPar = useNet ? netToPar : grossToPar;
    target.textContent = `Current score (${roundLabel}): ${toPar} ${thru}`;
  }

  // helper: refresh server tjson without clobbering drafts (drafts are in-memory)
  async function refreshTournamentJson({ quietSync = false } = {}) {
    if (refreshTournamentPromise) return refreshTournamentPromise;
    refreshTournamentPromise = (async () => {
      const previousTournament = {
        score_data: tjson?.score_data || { rounds: [] },
        players: tjson?.players || [],
        teams: tjson?.teams || [],
        course: courseListFromTournament(tjson)[0] || defaultCourse(),
        courses: courseListFromTournament(tjson)
      };
      const fresh = await staticJson(`/tournaments/${encodeURIComponent(tid)}.json?v=${Date.now()}`, { cacheKey: `t:${tid}` });
      const nextJson = await applyPendingScoreSubmissionsToTournament(fresh, { tid, code });
      const newEvents = collectNewScoreEvents(previousTournament, nextJson);
      replaceTournamentJson(nextJson);
      if (tickerRoundIndex >= rounds.length) tickerRoundIndex = Math.max(0, rounds.length - 1);
      renderTeamCurrentScore();
      if (newEvents.length) showScoreNotifier(newEvents);
      if (!quietSync) {
        await renderSyncStatus();
      }
      return nextJson;
    })();
    try {
      return await refreshTournamentPromise;
    } finally {
      refreshTournamentPromise = null;
    }
  }

  for (let r = 0; r < rounds.length; r++) {
    const round = rounds[r] || {};
    const fmt = String(round.format || "singles").toLowerCase();
    const twoManFormat = normalizeTwoManFormat(fmt);
    const fmtLabel = formatLabel(fmt);
    const isScramble = fmt === "scramble";
    const isTwoManGroupRound = twoManFormat === "two_man_scramble";
    const canGroup = !isScramble;
    const allowedRoundPlayerIds = canGroup ? allowedPlayerIdsForRound(r) : [];
    const allowedRoundPlayerSet = new Set(allowedRoundPlayerIds);
    const allowedRoundGroups = [];
    const allowedRoundGroupById = {};
    if (isTwoManGroupRound) {
      const seen = new Set();
      for (const pid of allowedRoundPlayerIds) {
        const p = playersById[pid];
        const g = groupForPlayerRound(p, r);
        const gid = twoManGroupId(p?.teamId, g);
        if (!gid || seen.has(gid)) continue;
        seen.add(gid);
        const groupPlayerIds = playersArr
          .filter((x) => x?.teamId === p?.teamId && groupForPlayerRound(x, r) === g)
          .map((x) => x.playerId)
          .filter(Boolean);
        const groupPlayers = groupPlayerIds.map((id) => playersById[id]).filter(Boolean);
        const teamName = teamsById[p?.teamId]?.teamName || p?.teamId || "Team";
        const displayName = `${teamName} • Group ${g}`;
        const meta = {
          groupId: gid,
          group: g,
          teamId: p?.teamId || "",
          teamName,
          playerIds: groupPlayerIds,
          names: groupPlayers.map((gp) => gp.name).filter(Boolean),
          displayName
        };
        allowedRoundGroups.push(meta);
        allowedRoundGroupById[gid] = meta;
      }
      allowedRoundGroups.sort((a, b) => a.displayName.localeCompare(b.displayName));
    }

    function scoreTitleStatsByTarget() {
      const roundData = tjson?.score_data?.rounds?.[r] || {};
      const pars = courseForRound(tjson, r).pars || Array(18).fill(4);

      if (isScramble) {
        const statsByTarget = Object.create(null);
        for (const row of roundData?.leaderboard?.teams || []) {
          const teamId = normalizeTeamId(row?.teamId);
          if (!teamId) continue;
          const summary = scoreEntryTitleParText(row, pars);
          if (summary) statsByTarget[teamId] = summary;
        }
        return statsByTarget;
      }

      if (isTwoManGroupRound) {
        const playerRowById = Object.create(null);
        for (const row of roundData?.leaderboard?.players || []) {
          const playerId = String(row?.playerId || "").trim();
          if (!playerId) continue;
          playerRowById[playerId] = row;
        }

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
            .map((value) => (value == null || Number(value) <= 0 ? null : Number(value)));
          const net = (Array.isArray(groupEntry?.net) ? groupEntry.net : gross)
            .map((value) => (value == null || Number(value) <= 0 ? null : Number(value)));
          const thru = gross.reduce((acc, value) => acc + (value != null ? 1 : 0), 0);
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

        const statsByTarget = Object.create(null);
        const seenGroups = new Set();
        function addGroup(teamIdRaw, groupLabelRaw) {
          const teamId = normalizeTeamId(teamIdRaw);
          const group = normalizeGroup(groupLabelRaw);
          const groupId = twoManGroupId(teamId, group);
          if (!groupId || seenGroups.has(groupId)) return;
          seenGroups.add(groupId);

          const groupPlayerIds = playersArr
            .filter((player) => normalizeTeamId(player?.teamId) === teamId && groupForPlayerRound(player, r) === group)
            .map((player) => player?.playerId)
            .filter(Boolean);

          let row = groupPlayerIds.map((playerId) => playerRowById[playerId]).find(Boolean) || null;
          if (!row) {
            const groupEntry = findTwoManGroupEntry(teamId, group);
            if (groupEntry) row = fallbackRowFromGroupEntry(groupEntry);
          }

          const summary = scoreEntryTitleParText(row, pars);
          if (summary) statsByTarget[groupId] = summary;
        }

        allowedRoundGroups.forEach((group) => addGroup(group.teamId, group.group));
        Object.entries(roundData?.team || {}).forEach(([teamId, teamEntry]) => {
          Object.keys(teamEntry?.groups || {}).forEach((groupLabel) => addGroup(teamId, groupLabel));
        });
        return statsByTarget;
      }

      const statsByTarget = Object.create(null);
      for (const row of roundData?.leaderboard?.players || []) {
        const playerId = String(row?.playerId || "").trim();
        if (!playerId) continue;
        const summary = scoreEntryTitleParText(row, pars);
        if (summary) statsByTarget[playerId] = summary;
      }
      return statsByTarget;
    }

    const roundTab = el("button", { class: "secondary", type: "button" }, `Round ${r + 1}`);
    roundTab.onclick = () => {
      setActiveRoundPane(r);
    };
    roundTabs.appendChild(roundTab);
    roundTabButtons.push(roundTab);

    const roundBody = el("div", { class: "enter-round-pane" });
    roundBody.style.display = r === defaultOpenRound ? "" : "none";
    roundPanesHost.appendChild(roundBody);
    roundPanes.push(roundBody);

    const groupIds = canGroup
      ? (
        isTwoManGroupRound
          ? allowedRoundGroups.map((g) => g.groupId)
          : allowedRoundPlayerIds.length
            ? allowedRoundPlayerIds.slice()
            : [myId].filter(Boolean)
      )
      : [];
    const holePane = roundBody;
    const bulkPane = document.createElement("div");
    bulkPane.className = "enter-bulk-input-pane";
    bulkPane.style.display = "none";

    // Current saved holes from tournament json
    function getSavedForRound() {
      const sd = tjson.score_data?.rounds?.[r] || {};
      if (isScramble) {
        const teamId = enter.team?.teamId;
        const teamEntry = sd.team?.[teamId];
        const gross = (teamEntry?.gross || Array(18).fill(null)).map((v) => (isEmptyScore(v) ? null : v));
        return {
          type: "team",
          savedByTarget: { [teamId]: gross },
          targetIds: [teamId],
          progressTargetIds: [teamId].filter(Boolean),
        };
      } else if (isTwoManGroupRound) {
        const savedByTarget = {};
        for (const [teamId, teamEntry] of Object.entries(sd.team || {})) {
          const groups = teamEntry?.groups || {};
          for (const [label, groupEntry] of Object.entries(groups)) {
            const gid = String(groupEntry?.groupId || twoManGroupId(teamId, label)).trim();
            if (!gid) continue;
            const gross = (groupEntry?.gross || Array(18).fill(null)).map((v) => (isEmptyScore(v) ? null : v));
            savedByTarget[gid] = gross;
          }
        }
        const allowedSet = new Set(allowedRoundGroups.map((g) => g.groupId));
        const fallbackGroup = twoManGroupId(myTeamId, groupForPlayerRound(playersById[myId], r));
        const ids = (groupIds.length ? groupIds : [fallbackGroup].filter(Boolean)).filter((id) =>
          allowedSet.has(id)
        );
        const progressTargetIds = [fallbackGroup].filter((id) => Boolean(id) && allowedSet.has(id));
        return { type: "group", savedByTarget, targetIds: ids, progressTargetIds };
      } else {
        const savedByTarget = {};
        for (const pid of Object.keys(sd.player || {})) {
          const gross = (sd.player[pid]?.gross || Array(18).fill(null)).map((v) => (isEmptyScore(v) ? null : v));
          savedByTarget[pid] = gross;
        }
        const ids = (groupIds.length ? groupIds : [myId].filter(Boolean)).filter((id) =>
          allowedRoundPlayerSet.has(id)
        );
        const progressTargetIds = [myId].filter((id) => Boolean(id) && allowedRoundPlayerSet.has(id));
        return { type: "player", savedByTarget, targetIds: ids, progressTargetIds };
      }
    }

    let currentHole = null;      // not chosen yet
    let holeManuallySet = false; // only true after user clicks prev/next or selects a hole

    const status = el("div", { class: "small enter-inline-score-status" }, "");

    function captureActiveInputState() {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return null;
      if (!holePane.contains(active) && !bulkPane.contains(active)) return null;
      const scope = active.getAttribute("data-enter-scope");
      const targetId = active.getAttribute("data-target-id");
      const holeIndex = active.getAttribute("data-hole-index");
      if (!scope || !targetId || holeIndex == null) return null;
      const state = {
        scope,
        targetId,
        holeIndex,
      };
      if (active instanceof HTMLInputElement) {
        state.selectionStart = active.selectionStart;
        state.selectionEnd = active.selectionEnd;
        state.selectionDirection = active.selectionDirection;
      }
      return state;
    }

    function restoreActiveInputState(state) {
      if (!state) return;
      const root = state.scope === "bulk" ? bulkPane : holePane;
      const candidates = root.querySelectorAll(
        `[data-enter-scope="${state.scope}"][data-hole-index="${state.holeIndex}"]`
      );
      const target = Array.from(candidates).find((node) => node.getAttribute("data-target-id") === state.targetId);
      if (!(target instanceof HTMLElement)) return;
      target.focus({ preventScroll: true });
      if (
        target instanceof HTMLInputElement &&
        typeof state.selectionStart === "number" &&
        typeof state.selectionEnd === "number"
      ) {
        try {
          target.setSelectionRange(state.selectionStart, state.selectionEnd, state.selectionDirection || undefined);
        } catch { }
      }
    }

    function renderHoleForm() {
      closeActiveScoreWheel();
      holePane.innerHTML = "";

      const { type, savedByTarget, targetIds, progressTargetIds } = getSavedForRound();
      const titleStatsByTarget = scoreTitleStatsByTarget();
      const primaryTargetIds = new Set(progressTargetIds || []);
      // set currentHole to next unplayed, but keep user-selected if they already moved it manually
      const progressIds = progressTargetIds?.length ? progressTargetIds : targetIds;
      const suggested = nextHoleIndexForGroup(savedByTarget, progressIds);

      // On first load (or if user hasn't manually set a hole), jump to next unplayed
      if (!holeManuallySet || currentHole == null || Number.isNaN(currentHole) || currentHole < 0 || currentHole > 17) {
        currentHole = suggested;
      }
      status.textContent = "";
      const holeCourse = courseForRound(tjson, r);

      const controlsCard = el("div", { class: "card hole-map-controls enter-page-hole-controls" });
      const nav = el("div", { class: "hole-map-nav" });
      const btnHolePrev = el("button", { class: "secondary", type: "button", "aria-label": "Previous hole" }, "—");
      const holeSel = el("select", { "aria-label": "Current hole" });
      const btnHoleNext = el("button", { class: "secondary", type: "button", "aria-label": "Next hole" }, "—");
      for (let i = 0; i < 18; i++) {
        const opt = el("option", { value: String(i) }, holeSummaryLabel(holeCourse, i, r));
        if (i === currentHole) opt.selected = true;
        holeSel.appendChild(opt);
      }
      holeSel.onchange = () => {
        currentHole = Number(holeSel.value);
        holeManuallySet = true;
        renderHoleForm();
      };
      nav.appendChild(btnHolePrev);
      nav.appendChild(holeSel);
      nav.appendChild(btnHoleNext);
      controlsCard.appendChild(nav);

      const yardageSummary = el("div", { class: "hole-map-summary" });
      const yardageHead = el(
        "div",
        { class: "hole-map-footer-head" },
        "<span>front</span><span>center</span><span>back</span>"
      );
      const yardageValues = el("div", { class: "hole-map-footer-values" });
      const metricFront = el("span", {}, "—");
      const metricCenter = el("span", {}, "—");
      const metricBack = el("span", {}, "—");
      yardageSummary.hidden = true;
      yardageValues.appendChild(metricFront);
      yardageValues.appendChild(metricCenter);
      yardageValues.appendChild(metricBack);
      yardageSummary.appendChild(yardageHead);
      yardageSummary.appendChild(yardageValues);
      controlsCard.appendChild(yardageSummary);
      holePane.appendChild(controlsCard);

      const panel = el("div", { class: "card enter-who-card hole-map-score-panel enter-inline-score-panel" });
      const panelHead = el("div", { class: "enter-who-head" });
      const panelMain = el("div", { class: "enter-who-main" });
      const panelTitle = el("h2", { style: "margin:0;" }, "Enter Scores");
      panelMain.appendChild(panelTitle);
      panelHead.appendChild(panelMain);
      panel.appendChild(panelHead);

      const panelBody = el("div", { class: "enter-inline-score-body" });
      panel.appendChild(panelBody);

      const tickerHost = el("div", { class: "hole-map-score-ticker-host" });
      if (activeRoundPaneIndex === r && ticker) tickerHost.appendChild(ticker);
      panelBody.appendChild(tickerHost);

      const roundTabsHost = el("div", { class: "enter-page-round-tabs-host" });
      if (activeRoundPaneIndex === r) roundTabsHost.appendChild(roundTabs);
      panelBody.appendChild(roundTabsHost);

      const syncHoleSummaryUi = () => {
        Array.from(holeSel.options).forEach((option, holeIndex) => {
          option.textContent = holeSummaryLabel(holeCourse, holeIndex, r);
        });
        const showYardages = hasBluegolfYardageDataForRound(r);
        yardageSummary.hidden = !showYardages;
        if (showYardages) {
          const metricValues = holeMetricValues(holeCourse, currentHole, r);
          metricFront.textContent = formatMetricYards(metricValues.front);
          metricCenter.textContent = formatMetricYards(metricValues.center);
          metricBack.textContent = formatMetricYards(metricValues.back);
        }
        holeSel.value = String(currentHole);
        btnHolePrev.textContent = currentHole > 0 ? String(currentHole) : "—";
        btnHolePrev.disabled = currentHole <= 0;
        btnHoleNext.textContent = currentHole < 17 ? String(currentHole + 2) : "—";
        btnHoleNext.disabled = currentHole >= 17;
      };
      if (r === activeRoundPaneIndex) {
        enterLocationState.onMetricsChange = syncHoleSummaryUi;
      }
      syncHoleSummaryUi();
      void Promise.all([
        ensureHoleYardageFallbackForRound(tjson, r),
        ensureHoleCoordinateRowsForRound(tjson, r),
      ]).then(() => {
        if (!panel.isConnected) return;
        syncHoleSummaryUi();
      });

      const grid = el("div", { class: "enter-inline-score-rows" });

      const inputs = [];
      const holePar = Number(holeCourse?.pars?.[currentHole]);

      function makeScoreInput(initialStr, { targetId, onValueChange } = {}) {
        const wrap = el("div", { class: "score-wheel-row" });
        const scoreWheel = createScoreWheel(initialStr, {
          parValue: holePar,
          onChange(nextValue) {
            if (typeof onValueChange === "function") onValueChange(nextValue);
          },
        });
        const attrs = {
          "data-enter-scope": "hole",
          "data-target-id": String(targetId || ""),
          "data-hole-index": String(currentHole),
        };
        for (const [key, value] of Object.entries(attrs)) {
          scoreWheel.input.setAttribute(key, value);
          scoreWheel.focusTarget.setAttribute(key, value);
          scoreWheel.viewport.setAttribute(key, value);
        }
        wrap.appendChild(scoreWheel.root);
        window.requestAnimationFrame(() => scoreWheel.sync());
        return { wrap, input: scoreWheel.input, focusTarget: scoreWheel.focusTarget };
      }

      function addScoreRow({ titleText, teamColor, targetId, initialValue, onValueChange }) {
        const row = el("div", {
          class: "hole-row hole-score-row team-accent",
          style: `--team-accent:${teamColor}; max-width:100%;`,
        });
        if (primaryTargetIds.has(targetId)) row.classList.add("is-primary-target");
        row.style.flex = "1 1 260px";
        row.style.maxWidth = "100%";
        const title = el("div", { class: "hole-score-row-title" });
        title.appendChild(document.createTextNode(titleText));
        const statText = String(titleStatsByTarget[targetId] || "").trim();
        if (statText) {
          title.appendChild(el("span", { class: "hole-score-row-stats" }, statText));
        }
        row.appendChild(title);
        const { wrap, input, focusTarget } = makeScoreInput(initialValue, { targetId, onValueChange });
        row.appendChild(wrap);
        grid.appendChild(row);
        inputs.push({ targetId, input, focusTarget });
      }

      if (type === "team") {
        const teamId = targetIds[0];
        const teamColor = colorForTeam(teamId);
        const existingRaw = (savedByTarget[teamId] || Array(18).fill(null))[currentHole];
        const existing = isEmptyScore(existingRaw) ? null : existingRaw;

        const draft = getHoleDraft(r, currentHole, teamId);
        const initial = draft !== undefined ? draft : existing == null ? "" : String(existing);
        addScoreRow({
          titleText: enter.team?.teamName || "Team",
          teamColor,
          targetId: teamId,
          initialValue: initial,
          onValueChange(nextValue) {
            setHoleDraft(r, currentHole, teamId, nextValue);
          },
        });
      } else if (type === "group") {
        const ids = targetIds.length
          ? targetIds
          : (() => {
            const g = twoManGroupId(myTeamId, groupForPlayerRound(playersById[myId], r));
            return g ? [g] : [];
          })();
        const orderedIds = [
          ...ids.filter((id) => primaryTargetIds.has(id)),
          ...ids.filter((id) => !primaryTargetIds.has(id)),
        ];
        for (const gid of orderedIds) {
          const meta = allowedRoundGroupById[gid] || { displayName: gid, names: [], teamId: parseTwoManGroupId(gid).teamId };
          const teamColor = colorForTeam(meta.teamId);
          const existingRaw = (savedByTarget[gid] || Array(18).fill(null))[currentHole];
          const existing = isEmptyScore(existingRaw) ? null : existingRaw;
          const draft = getHoleDraft(r, currentHole, gid);
          const initial = draft !== undefined ? draft : existing == null ? "" : String(existing);
          const names = uniqueDisplayNames(meta.names || []);
          addScoreRow({
            titleText: names.length ? names.join(", ") : meta.teamName || meta.displayName || gid,
            teamColor,
            targetId: gid,
            initialValue: initial,
            onValueChange(nextValue) {
              setHoleDraft(r, currentHole, gid, nextValue);
            },
          });
        }
      } else {
        const ids = targetIds.length
          ? targetIds
          : [myId].filter((id) => Boolean(id) && allowedRoundPlayerSet.has(id));
        const orderedIds = [
          ...ids.filter((id) => primaryTargetIds.has(id)),
          ...ids.filter((id) => !primaryTargetIds.has(id)),
        ];
        for (const pid of orderedIds) {
          const p = playersById[pid];
          if (!p) continue;
          const teamColor = colorForTeam(p.teamId);

          const existingRaw = (savedByTarget[pid] || Array(18).fill(null))[currentHole];
          const existing = isEmptyScore(existingRaw) ? null : existingRaw;

          const draft = getHoleDraft(r, currentHole, pid);
          const initial = draft !== undefined ? draft : existing == null ? "" : String(existing);
          addScoreRow({
            titleText: p.name || pid,
            teamColor,
            targetId: pid,
            initialValue: initial,
            onValueChange(nextValue) {
              setHoleDraft(r, currentHole, pid, nextValue);
            },
          });
        }
      }

      panelBody.appendChild(grid);

      const actions = el("div", { class: "actions enter-inline-score-actions" });
      const actionButtons = el("div", { class: "hole-map-score-action-buttons" });
      const btnNext = el("button", { type: "button", "aria-label": "Submit scores and go to next hole" }, "Next Hole →");
      actionButtons.appendChild(btnNext);
      actions.appendChild(actionButtons);
      panelBody.appendChild(actions);
      panelBody.appendChild(status);
      holePane.appendChild(panel);
      holePane.appendChild(createEnterLocationPrompt());
      holePane.appendChild(bulkPane);

      btnHolePrev.onclick = () => {
        closeActiveScoreWheel();
        currentHole = Math.max(0, currentHole - 1);
        holeManuallySet = true;
        renderHoleForm();
      };

      btnHoleNext.onclick = () => {
        closeActiveScoreWheel();
        currentHole = Math.min(17, currentHole + 1);
        holeManuallySet = true;
        renderHoleForm();
      };

      async function doSubmit({ quietIfEmpty = false, advanceMode = "next-unplayed" } = {}) {
        status.textContent = "Submitting…";
        const submittedHoleIndex = currentHole;

        const entries = [];
        for (const { targetId, input } of inputs) {
          const v = (input.value ?? "").trim();
          if (v === "") continue; // skip blanks
          entries.push({ targetId, strokes: Number(v) });
        }
        if (!entries.length) {
          if (!quietIfEmpty) {
            status.textContent = "Enter at least one score for this hole.";
          } else {
            status.textContent = "";
          }
          return { skipped: true };
        }

        const payload = {
          code,
          roundIndex: r,
          mode: "hole",
          holeIndex: submittedHoleIndex,
          entries,
          override: true,
        };

        try {
          await api(`/tournaments/${encodeURIComponent(tid)}/scores`, {
            method: "POST",
            body: payload,
          });

          await clearPendingScoreSubmissionsMatching({ tid, code, payload });
          status.textContent = "Saved.";

          // clear drafts ONLY for the targets you actually submitted (for this hole)
          clearHoleDraftTargets(
            r,
            submittedHoleIndex,
            entries.map((e) => e.targetId)
          );

          // refresh tournament json quickly (cache-bust)
          await refreshTournamentJson();
          renderTicker(tjson, playersById, teamsById, tickerRoundIndex);

          if (advanceMode === "sequential") {
            currentHole = Math.min(17, submittedHoleIndex + 1);
            holeManuallySet = true;
          } else {
            // advance to next unplayed hole for this code's progress target(s)
            const nowSaved = getSavedForRound();
            const progressIds = nowSaved.progressTargetIds?.length ? nowSaved.progressTargetIds : nowSaved.targetIds;
            currentHole = nextHoleIndexForGroup(nowSaved.savedByTarget, progressIds);
          }

          renderHoleForm();
          renderBulkTable();
          await renderSyncStatus();
          return { ok: true };
        } catch (err) {
          if (isNetworkFailure(err)) {
            await enqueuePendingScoreSubmission({ tid, code, payload });
            await applyPendingScoresToCurrentTournament();
            clearHoleDraftTargets(
              r,
              submittedHoleIndex,
              entries.map((e) => e.targetId)
            );
            status.textContent = navigator.onLine
              ? "Saved locally. Sync will retry automatically."
              : "Offline: saved locally and queued for sync.";
            await renderSyncStatus();

            if (advanceMode === "sequential") {
              currentHole = Math.min(17, submittedHoleIndex + 1);
              holeManuallySet = true;
            } else {
              const nowSaved = getSavedForRound();
              const progressIds = nowSaved.progressTargetIds?.length ? nowSaved.progressTargetIds : nowSaved.targetIds;
              currentHole = nextHoleIndexForGroup(nowSaved.savedByTarget, progressIds);
            }

            renderTeamCurrentScore();
            renderTicker(tjson, playersById, teamsById, tickerRoundIndex);
            renderHoleForm();
            renderBulkTable();
            return { ok: true, queued: true };
          }
          if (err?.status === 409) {
            status.textContent = "Conflict: existing scores could not be overridden for this player code.";
            return { conflict: true };
          }
          status.textContent = `Error: ${err?.message || String(err)}`;
          return { error: true };
        }
      }
      bindImmediateButtonAction(btnNext, () => {
        closeActiveScoreWheel();
        return doSubmit({ advanceMode: "sequential" });
      });
    }
    roundHoleRenderers[r] = renderHoleForm;

    function renderBulkTable() {
      bulkPane.innerHTML = "";

      const roundData = tjson?.score_data?.rounds?.[r] || {};
      const bulkPlayerId = [myId].filter((id) => Boolean(id) && allowedRoundPlayerSet.has(id))[0] || "";
      if (!bulkPlayerId) {
        bulkPane.style.display = "none";
        return;
      }
      bulkPane.style.display = "";

      const savedByTarget = Object.create(null);
      for (const pid of Object.keys(roundData.player || {})) {
        const gross = (roundData.player[pid]?.gross || Array(18).fill(null)).map((v) => (isEmptyScore(v) ? null : v));
        savedByTarget[pid] = gross;
      }

      const ids = [bulkPlayerId];
      const bulkCard = el("div", { class: "card enter-bulk-input-card" });
      bulkCard.appendChild(el("h3", { style: "margin:0 0 8px 0;" }, "Bulk Input"));
      const bulkPlayerName = playersById[bulkPlayerId]?.name || bulkPlayerId;
      const bulkPlayerTeamId = playersById[bulkPlayerId]?.teamId;
      const bulkPlayerColor = colorForTeam(bulkPlayerTeamId);
      bulkCard.appendChild(
        el(
          "div",
          {
            class: "bulk-table-player-title team-accent",
            style: `--team-accent:${bulkPlayerColor};`,
          },
          `<b>${bulkPlayerName}</b>`
        )
      );

      bulkPane.appendChild(bulkCard);

      const tableWrap = el("div", { class: "bulk-table-wrap" });
      const tbl = el("table", { class: "table bulk-table" });
      const thead = el("thead");
      const trH = el("tr");
      trH.innerHTML =
        `<th>Side</th>` +
        Array.from({ length: 9 }, (_, i) => `<th>${i + 1}</th>`).join("");
      thead.appendChild(trH);
      tbl.appendChild(thead);

      const tbody = el("tbody");
      const rowInputs = {};

      for (const id of ids) {
        const holes = (savedByTarget[id] || Array(18).fill(null)).map((v) => (isEmptyScore(v) ? null : v));

        rowInputs[id] = Array(18).fill(null);

        const frontRow = el("tr");
        frontRow.appendChild(el("td", { class: "bulk-side" }, "Front 9"));

        for (let i = 0; i < 9; i++) {
          const td = el("td");
          const inputWrap = el("div", { style: "display:inline-flex; align-items:center; gap:4px;" });
          const inp = el("input", {
            type: "number",
            min: "1",
            max: "20",
            step: "1",
            class: "hole-input bulk-hole-input",
          });
          const dv = getBulkDraft(r, id, i);
          const initial = dv !== undefined ? dv : holes[i] == null ? "" : String(holes[i]);
          inp.value = initial ?? "";
          inp.setAttribute("data-enter-scope", "bulk");
          inp.setAttribute("data-target-id", id);
          inp.setAttribute("data-hole-index", String(i));
          inp.addEventListener("input", () => {
            setBulkDraft(r, id, i, inp.value);
          });
          rowInputs[id][i] = inp;
          inputWrap.appendChild(inp);
          td.appendChild(inputWrap);
          frontRow.appendChild(td);
        }

        const backRow = el("tr");
        backRow.appendChild(el("td", { class: "bulk-side" }, "Back 9"));
        for (let i = 9; i < 18; i++) {
          const td = el("td");
          const inputWrap = el("div", { style: "display:inline-flex; align-items:center; gap:4px;" });
          const inp = el("input", {
            type: "number",
            min: "1",
            max: "20",
            step: "1",
            class: "hole-input bulk-hole-input",
          });
          const dv = getBulkDraft(r, id, i);
          const initial = dv !== undefined ? dv : holes[i] == null ? "" : String(holes[i]);
          inp.value = initial ?? "";
          inp.setAttribute("data-enter-scope", "bulk");
          inp.setAttribute("data-target-id", id);
          inp.setAttribute("data-hole-index", String(i));
          inp.addEventListener("input", () => {
            setBulkDraft(r, id, i, inp.value);
          });
          rowInputs[id][i] = inp;
          inputWrap.appendChild(inp);
          td.appendChild(inputWrap);
          backRow.appendChild(td);
        }

        tbody.appendChild(frontRow);
        tbody.appendChild(backRow);
      }

      tbl.appendChild(tbody);
      tableWrap.appendChild(tbl);
      bulkCard.appendChild(tableWrap);

      const bulkStatus = el("div", { class: "small", style: "margin-top:10px;" }, "");
      const btnRow = el("div", { style: "display:flex; gap:10px; flex-wrap:wrap; margin-top:10px;" });
      const btnSubmit = el("button", { class: "", type: "button" }, "Submit Player Bulk");
      btnRow.appendChild(btnSubmit);
      bulkCard.appendChild(btnRow);
      bulkCard.appendChild(bulkStatus);

      async function submitBulk() {
        bulkStatus.textContent = "Submitting…";

        const entries = [];
        for (const id of ids) {
          const holes = rowInputs[id].map((inp) => {
            const v = (inp.value ?? "").trim();
            // keep null for blanks; treat "0" as blank (unplayed) too
            if (v === "" || Number(v) === 0) return null;
            return Number(v);
          });
          entries.push({ targetId: id, holes });
        }

        const payload = {
          code,
          roundIndex: r,
          mode: "bulk",
          entries,
          override: true,
        };

        try {
          await api(`/tournaments/${encodeURIComponent(tid)}/scores`, {
            method: "POST",
            body: payload,
          });

          await clearPendingScoreSubmissionsMatching({ tid, code, payload });
          bulkStatus.textContent = "Saved.";

          // bulk submit = clear all drafts for this round (hole + bulk)
          clearRoundDraft(r);

          await refreshTournamentJson();
          renderTicker(tjson, playersById, teamsById, tickerRoundIndex);

          renderHoleForm();
          renderBulkTable();
          await renderSyncStatus();
        } catch (e) {
          if (isNetworkFailure(e)) {
            await enqueuePendingScoreSubmission({ tid, code, payload });
            await applyPendingScoresToCurrentTournament();
            clearRoundDraft(r);
            bulkStatus.textContent = navigator.onLine
              ? "Saved locally. Sync will retry automatically."
              : "Offline: bulk scores saved locally and queued for sync.";
            renderTeamCurrentScore();
            renderTicker(tjson, playersById, teamsById, tickerRoundIndex);
            renderHoleForm();
            renderBulkTable();
            await renderSyncStatus();
            return;
          }
          bulkStatus.textContent = `Error: ${e?.message || String(e)}`;
        }
      }

      btnSubmit.onclick = () => submitBulk();
    }

    // initial render
    renderHoleForm();
    renderBulkTable();

    // Auto-refresh to pick up others' scores quickly (every 10s) without clobbering drafts
    const refreshTimer = setInterval(async () => {
      try {
        await syncPendingScores({ quiet: true });
        await refreshTournamentJson();
        renderTicker(tjson, playersById, teamsById, tickerRoundIndex);
        const activeInputState = captureActiveInputState();
        renderHoleForm();
        renderBulkTable();
        restoreActiveInputState(activeInputState);
      } catch { }
    }, 30_000);

    // keep the timer from being GC'd (optional)
    roundBody._refreshTimer = refreshTimer;
  }

  enterLocationState.granted = readGeolocationGrant();
  syncEnterLocationPromptUi();
  setActiveRoundPane(activeRoundPaneIndex);
  await renderSyncStatus();
  void maybePromptForEnterLocation();

  const chatState = {
    messages: Array.isArray(enter?.chat) ? enter.chat.slice(-100) : [],
    refreshPromise: null,
    panel: null,
    list: null,
    count: null,
    input: null,
    form: null,
    sendButton: null,
    status: null,
  };

  function setChatStatus(message = "", isError = false) {
    if (!chatState.status) return;
    chatState.status.textContent = String(message || "").trim();
    chatState.status.style.color = isError ? "var(--bad)" : "";
    chatState.status.hidden = !chatState.status.textContent;
  }

  function ensureChatPanel() {
    if (!chatMount || chatState.panel) return chatState.panel;

    const panel = el("div", { class: "card enter-chat-card" });
    const head = el("div", { class: "enter-chat-head" });
    const heading = el("div", { class: "enter-chat-heading" });
    heading.appendChild(el("div", { class: "small enter-chat-kicker" }, "Tournament chat"));
    heading.appendChild(el("h3", { style: "margin:0;" }, "Send updates to every player"));
    const count = el("div", { class: "pill enter-chat-count" }, "");
    head.appendChild(heading);
    head.appendChild(count);
    panel.appendChild(head);
    panel.appendChild(
      el(
        "div",
        { class: "small enter-chat-summary" },
        "Messages post to the shared feed and trigger PWA notifications for subscribed players."
      )
    );

    const list = el("div", {
      class: "enter-chat-list",
      "aria-live": "polite",
      "aria-relevant": "additions text",
    });
    panel.appendChild(list);

    const form = el("form", { class: "enter-chat-form" });
    const input = el("input", {
      id: "enter_chat_input",
      class: "enter-chat-input",
      type: "text",
      maxlength: String(CHAT_MESSAGE_MAX_LENGTH),
      autocomplete: "off",
      autocapitalize: "sentences",
      inputmode: "text",
      enterkeyhint: "send",
      placeholder: "Write a message for the field",
    });
    const sendButton = el("button", { type: "submit" }, "Send");
    form.appendChild(input);
    form.appendChild(sendButton);

    const status = el("div", { class: "small enter-chat-status" }, "");
    status.hidden = true;

    panel.appendChild(form);
    panel.appendChild(status);
    chatMount.innerHTML = "";
    chatMount.appendChild(panel);

    chatState.panel = panel;
    chatState.list = list;
    chatState.count = count;
    chatState.input = input;
    chatState.form = form;
    chatState.sendButton = sendButton;
    chatState.status = status;

    input.addEventListener("input", () => {
      input.value = normalizeChatMessageInput(input.value);
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitChatMessage();
    });

    return panel;
  }

  function renderChatMessages(nextMessages, { forceScroll = false } = {}) {
    if (!chatState.list) return;
    const list = chatState.list;
    const shouldStickToBottom =
      forceScroll || list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    const messages = Array.isArray(nextMessages) ? nextMessages.slice(-100) : [];
    chatState.messages = messages;
    list.innerHTML = "";

    if (!messages.length) {
      list.appendChild(
        el("div", { class: "enter-chat-empty" }, "No messages yet. Send the first update.")
      );
    } else {
      for (const message of messages) {
        const item = el("article", {
          class: "enter-chat-item",
          style: `--team-accent:${colorForTeam(message?.teamId) || "var(--brand)"}`,
        });
        if (message?.playerId && message.playerId === myId) {
          item.classList.add("is-me");
        }

        const topRow = el("div", { class: "enter-chat-item-top" });
        const sender = String(message?.playerName || "Player").trim() || "Player";
        const teamName = String(message?.teamName || "").trim();
        const senderLabel = teamName ? `${sender} • ${teamName}` : sender;
        topRow.appendChild(el("div", { class: "enter-chat-sender" }, senderLabel));

        const timeValue = Number(message?.createdAt);
        const timeText = formatChatTimestamp(timeValue);
        const timeEl = el("time", { class: "enter-chat-time" }, timeText || "");
        if (Number.isFinite(timeValue) && timeValue > 0) {
          timeEl.setAttribute("datetime", new Date(timeValue).toISOString());
        }
        topRow.appendChild(timeEl);

        const body = el("div", { class: "enter-chat-message" });
        body.textContent = String(message?.message || "");

        item.appendChild(topRow);
        item.appendChild(body);
        list.appendChild(item);
      }
    }

    if (chatState.count) {
      const total = messages.length;
      chatState.count.textContent = `${total} message${total === 1 ? "" : "s"}`;
    }

    if (shouldStickToBottom) {
      list.scrollTop = list.scrollHeight;
    }
  }

  async function loadChatMessages({ quiet = false } = {}) {
    ensureChatPanel();
    if (!tid || !code) return chatState.messages;
    if (chatState.refreshPromise) return chatState.refreshPromise;

    chatState.refreshPromise = (async () => {
      try {
        const payload = await api(
          `/tournaments/${encodeURIComponent(tid)}/chat?code=${encodeURIComponent(code)}`
        );
        const messages = Array.isArray(payload?.messages) ? payload.messages : [];
        renderChatMessages(messages);
        if (!quiet) {
          setChatStatus("");
        }
        return messages;
      } catch (error) {
        if (!quiet) {
          setChatStatus(error instanceof Error ? error.message : "Could not load chat.", true);
        }
        return chatState.messages;
      } finally {
        chatState.refreshPromise = null;
      }
    })();

    return chatState.refreshPromise;
  }

  async function submitChatMessage() {
    ensureChatPanel();
    if (!chatState.input || !chatState.sendButton) return false;

    const message = normalizeChatMessageInput(chatState.input.value);
    if (!message) {
      setChatStatus("Write a message before sending.", true);
      chatState.input.focus({ preventScroll: true });
      return false;
    }

    chatState.sendButton.disabled = true;
    setChatStatus("Sending…");

    try {
      const payload = await api(`/tournaments/${encodeURIComponent(tid)}/chat`, {
        method: "POST",
        body: {
          code,
          message,
        },
      });
      const messages = Array.isArray(payload?.messages) ? payload.messages : [];
      chatState.input.value = "";
      renderChatMessages(messages, { forceScroll: true });
      setChatStatus("Sent.");
      return true;
    } catch (error) {
      setChatStatus(error instanceof Error ? error.message : "Could not send message.", true);
      return false;
    } finally {
      chatState.sendButton.disabled = false;
      chatState.input.focus({ preventScroll: true });
    }
  }

  ensureChatPanel();
  renderChatMessages(chatState.messages, { forceScroll: true });
  void loadChatMessages({ quiet: true });

  const chatRefreshTimer = setInterval(() => {
    void loadChatMessages({ quiet: true });
  }, CHAT_REFRESH_MS);

  window.addEventListener("online", () => {
    void (async () => {
      await renderSyncStatus();
      await syncPendingScores({ quiet: true });
      await loadChatMessages({ quiet: true });
    })();
  });
  window.addEventListener("offline", () => {
    void renderSyncStatus();
  });
  window.addEventListener("pagehide", () => {
    stopEnterLocationTracking({ clearLocation: false });
    clearInterval(chatRefreshTimer);
  });
  void syncPendingScores({ quiet: true });
}

main().catch((e) => {
  forms.innerHTML = `<div class="card"><b>Error:</b> ${e?.message || String(e)}</div>`;
});
