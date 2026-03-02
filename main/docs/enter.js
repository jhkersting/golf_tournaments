import {
  api,
  staticJson,
  qs,
  createTeamColorRegistry,
  setHeaderTournamentName,
  STORAGE_KEYS,
  getRememberedPlayerCode,
  rememberPlayerCode,
  rememberTournamentId
} from "./app.js";

function normalizePlayerCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

const codeFromQuery = qs("code");
const normalizedCodeFromQuery = normalizePlayerCode(codeFromQuery || qs("c"));
if (normalizedCodeFromQuery) rememberPlayerCode(normalizedCodeFromQuery);
let code = normalizedCodeFromQuery || normalizePlayerCode(getRememberedPlayerCode()) || "";
const who = document.getElementById("who");
const forms = document.getElementById("round_forms");
const ticker = document.getElementById("enter_ticker");
const tickerTitle = document.getElementById("enter_ticker_title");
const tickerTrack = document.getElementById("enter_ticker_track");
const brandDot = document.querySelector(".brand .dot");
const scoreNotifier = document.getElementById("score_notifier");

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

function seedTeamColors(tjson, playersById) {
  const seen = new Set();
  let totalTeams = 0;
  const add = (teamId) => {
    const id = normalizeTeamId(teamId);
    if (!id || seen.has(id)) return;
    seen.add(id);
    totalTeams += 1;
  };
  (tjson?.teams || []).forEach((t) => add(t?.teamId || t?.id));
  Object.values(playersById || {}).forEach((p) => add(p?.teamId));

  teamColors.reset(totalTeams);
  seen.forEach((id) => {
    teamColors.add(id);
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
  return {
    ...(course?.name ? { name: String(course.name) } : {}),
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

function keyGroup(tid, roundIndex) {
  return `group:${tid}:${roundIndex}:${code}`;
}

function loadGroup(tid, roundIndex, allPlayers, defaultIds) {
  try {
    const v = JSON.parse(localStorage.getItem(keyGroup(tid, roundIndex)) || "null");
    if (Array.isArray(v) && v.length) return v.filter((id) => allPlayers[id]);
  } catch { }
  return defaultIds.slice();
}

function saveGroup(tid, roundIndex, ids) {
  try {
    localStorage.setItem(keyGroup(tid, roundIndex), JSON.stringify(ids));
  } catch { }
}

function holeLabel(i) {
  return `Hole ${i + 1}`;
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
  if (Number(row.thru || 0) > 0) return true;
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
  for (let i = 0; i < 18; i++) {
    const score = holes[i];
    if (score == null || Number(score) <= 0) continue;
    played++;
    diff += Number(score) - Number(pars[i] || 0);
  }
  return played ? toParText(diff) : null;
}

function grossToParText(row, pars) {
  const explicit = toParFromKeys(row, [
    "toParGross",
    "grossToPar",
    "toParGrossTotal",
    "grossToParTotal"
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
    "netToParTotal"
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
  (nextTournament?.players || []).forEach((p) => {
    const id = String(p?.playerId || "").trim();
    if (id) playerNames.set(id, p?.name || id);
  });

  const teamNames = new Map();
  (nextTournament?.teams || []).forEach((t) => {
    const id = String(t?.teamId ?? t?.id ?? "").trim();
    if (id) teamNames.set(id, t?.teamName ?? t?.name ?? id);
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
      for (let holeIndex = 0; holeIndex < 18; holeIndex++) {
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
  const isTwoManRound = roundFormat === "two_man" || roundFormat === "two_man_best_ball";
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
      individualTickerRows.push({
        name: `Group ${group} | ${teamName}`,
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
  document.querySelectorAll("a[data-scoreboard-link]").forEach((link) => {
    link.setAttribute("href", `./scoreboard.html?t=${encodeURIComponent(tid)}`);
  });

  // Tournament public JSON (single file)
  const tjson = await staticJson(`/tournaments/${encodeURIComponent(tid)}.json`, { cacheKey: `t:${tid}` });
  setHeaderTournamentName(tjson?.tournament?.name);
  const hasTwoManBestBallTournament = (tjson?.tournament?.rounds || []).some(
    (round) => {
      const fmt = String(round?.format || "").toLowerCase();
      return fmt === "two_man" || fmt === "two_man_best_ball";
    }
  );
  const teeRoundCount = (tjson?.tournament?.rounds || []).length;
  const myGroupSummary = Array.from({ length: teeRoundCount }, (_, idx) => {
    const g = groupForPlayerRound(enter?.player, idx);
    return g ? `R${idx + 1}: Group ${g}` : "";
  })
    .filter(Boolean)
    .join(" • ");
  const myTeeTimes = Array.from({ length: teeRoundCount }, (_, idx) => {
    const v = Array.isArray(enter?.player?.teeTimes) ? enter.player.teeTimes[idx] : null;
    return String(v || "").trim();
  });
  if (!myTeeTimes.some((v) => !!v) && enter?.player?.teeTime && myTeeTimes.length > 0) {
    myTeeTimes[0] = String(enter.player.teeTime).trim();
  }
  const myTeeSummary = myTeeTimes
    .map((v, idx) => (v ? `R${idx + 1}: ${v}` : ""))
    .filter(Boolean)
    .join(" • ");

  // Code path: reveal only after required data has loaded.
  $('body').show();
  who.style.display = "";
  who.className = "card enter-who-card";
  who.innerHTML = `
    <div class="enter-who-head">
      <div class="enter-who-main">
        <div><b>${enter.player?.name || ""}</b> <span class="small">(code ${code})</span></div>
        <div><b>${enter.team?.teamName || enter.team?.teamId || ""}</b></div>
        ${myGroupSummary ? `<div class="small">${myGroupSummary}</div>` : ""}
        ${myTeeSummary ? `<div class="small">Tee times: ${myTeeSummary}</div>` : ""}
        <div class="small" id="team_current_score" style="margin-top:4px;">Current score: —</div>
      </div>
      <button id="change_code_btn" class="secondary" type="button">Change code</button>
    </div>
  `;
  document.getElementById("change_code_btn")?.addEventListener("click", clearCodeAndReload);

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

  // Open newest round that already has data; fallback to round 1.
  function activeRoundIndex() {
    if (!rounds.length) return 0;
    const scoreRounds = tjson.score_data?.rounds || [];
    for (let i = rounds.length - 1; i >= 0; i--) {
      if (roundHasAnyData(scoreRounds[i])) return i;
    }
    return 0;
  }
  const defaultOpenRound = activeRoundIndex();
  let tickerRoundIndex = defaultOpenRound;
  const roundSections = [];
  let refreshTournamentPromise = null;

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

    const grossToPar = grossToParText(teamRow, pars);
    const netToPar = netToParText(teamRow, pars);
    const thru = holeDisplayFromThru(teamRow);
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
  async function refreshTournamentJson() {
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
      const newEvents = collectNewScoreEvents(previousTournament, fresh);
      Object.assign(tjson, fresh);
      if (tickerRoundIndex >= rounds.length) tickerRoundIndex = Math.max(0, rounds.length - 1);
      renderTeamCurrentScore();
      if (newEvents.length) showScoreNotifier(newEvents);
      return fresh;
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
    const fmtLabel = (fmt === "two_man" || fmt === "two_man_best_ball") ? "two man" : fmt;
    const isScramble = fmt === "scramble";
    const isTwoManBestBall = fmt === "two_man" || fmt === "two_man_best_ball";
    const canGroup = !isScramble;
    const allowedRoundPlayerIds = canGroup ? allowedPlayerIdsForRound(r) : [];
    const allowedRoundPlayerSet = new Set(allowedRoundPlayerIds);
    const allowedRoundGroups = [];
    const allowedRoundGroupById = {};
    if (isTwoManBestBall) {
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

    const roundCard = el("div", { class: "card" });
    const roundHead = el("div", { class: "actions", style: "justify-content:space-between; margin-bottom:6px;" });
    roundHead.appendChild(el("h2", { style: "margin:0;" }, `${round.name || `Round ${r + 1}`} — ${fmtLabel}`));
    const toggleRoundBtn = el("button", { class: "secondary", type: "button" }, "");
    roundHead.appendChild(toggleRoundBtn);
    roundCard.appendChild(roundHead);

    const roundBody = el("div");
    roundCard.appendChild(roundBody);
    let collapsed = r !== defaultOpenRound;
    function setCollapsed(nextCollapsed) {
      collapsed = !!nextCollapsed;
      roundBody.style.display = collapsed ? "none" : "";
      toggleRoundBtn.textContent = collapsed ? "Show round" : "Hide round";
    }
    setCollapsed(collapsed);
    roundSections.push({ index: r, setCollapsed });
    toggleRoundBtn.onclick = () => {
      if (collapsed) {
        for (const s of roundSections) {
          if (s.index !== r) s.setCollapsed(true);
        }
        setCollapsed(false);
        tickerRoundIndex = r;
        renderTeamCurrentScore();
        renderTicker(tjson, playersById, teamsById, tickerRoundIndex);
        return;
      }
      setCollapsed(true);
    };

    const myRoundTee = String(myTeeTimes[r] || "").trim();
    if (myRoundTee) {
      roundBody.appendChild(
        el("div", { class: "small", style: "margin-bottom:8px;" }, `<b>Your tee time:</b> ${myRoundTee}`)
      );
    }

    // Group picker
    let groupIds = canGroup
      ? loadGroup(
        tid,
        r,
        isTwoManBestBall ? allowedRoundGroupById : playersById,
        isTwoManBestBall
          ? allowedRoundGroups.map((g) => g.groupId)
          : allowedRoundPlayerIds.length
            ? allowedRoundPlayerIds
            : [myId].filter(Boolean)
      )
      : [];
    if (canGroup) {
      if (isTwoManBestBall) {
        const allowedGroupSet = new Set(allowedRoundGroups.map((g) => g.groupId));
        groupIds = groupIds.filter((id) => allowedGroupSet.has(id));
        if (!groupIds.length) {
          const myGroup = twoManGroupId(myTeamId, groupForPlayerRound(playersById[myId], r));
          groupIds = myGroup && allowedGroupSet.has(myGroup)
            ? [myGroup]
            : allowedRoundGroups.map((g) => g.groupId).slice(0, 1);
        }
      } else {
        groupIds = groupIds.filter((id) => allowedRoundPlayerSet.has(id));
        if (!groupIds.length) {
          groupIds = allowedRoundPlayerIds.length ? allowedRoundPlayerIds.slice() : [myId].filter(Boolean);
        }
      }
    }
    const groupPicker = el("div", { class: "small", style: canGroup ? "margin:10px 0;" : "display:none;" });

    // panes/tabs created early so render functions can close over them
    const tabs = el("div", { class: "enter-tabs" });
    const tabHole = el("button", { class: "secondary", type: "button" }, "Hole-by-hole");
    const tabBulk = el("button", { class: "secondary", type: "button" }, "Bulk input");
    tabs.appendChild(tabHole);
    tabs.appendChild(tabBulk);
    roundBody.appendChild(tabs);

    const holePane = el("div");
    const bulkPane = el("div", { style: "display:none;" });
    roundBody.appendChild(holePane);
    roundBody.appendChild(bulkPane);

    tabHole.onclick = () => {
      holePane.style.display = "";
      bulkPane.style.display = "none";
    };
    tabBulk.onclick = () => {
      holePane.style.display = "none";
      bulkPane.style.display = "";
    };

    if (canGroup) {
      const pickerTop = el("div", { style: "display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-bottom:6px;" });
      pickerTop.appendChild(el("b", {}, "Playing with:"));
      if ((isTwoManBestBall ? allowedRoundGroups.length : allowedRoundPlayerIds.length) <= 1) {
        pickerTop.appendChild(
          el(
            "span",
            { class: "small" },
            isTwoManBestBall ? "Only your group is on this tee time." : "Only your code can enter this tee time."
          )
        );
      }
      const list = el("div", {
        style:
          "display:flex; flex-wrap:wrap; gap:10px; max-height:220px; overflow:auto; padding:8px; border:1px solid var(--border); border-radius:10px; background:var(--surface-strong);",
      });

      function syncGroupChecks() {
        const boxes = list.querySelectorAll("input[type='checkbox'][data-target-id]");
        boxes.forEach((cb) => {
          const targetId = cb.getAttribute("data-target-id");
          cb.checked = !!targetId && groupIds.includes(targetId);
        });
      }

      const btnMeTeam = el("button", { class: "secondary", type: "button" }, "My team");
      btnMeTeam.onclick = () => {
        if (isTwoManBestBall) {
          const myGroup = twoManGroupId(myTeamId, groupForPlayerRound(playersById[myId], r));
          groupIds = myGroup ? [myGroup] : [];
        } else {
          groupIds = allowedRoundPlayerIds.length ? allowedRoundPlayerIds.slice() : [myId].filter(Boolean);
        }
        saveGroup(tid, r, groupIds);
        syncGroupChecks();
        renderHoleForm();
        renderBulkTable();
      };

      btnMeTeam.textContent = isTwoManBestBall ? "My group" : "My tee time";

      const btnAll = el("button", { class: "secondary", type: "button" }, "All on tee time");
      btnAll.onclick = () => {
        groupIds = isTwoManBestBall
          ? allowedRoundGroups.map((g) => g.groupId)
          : allowedRoundPlayerIds.slice();
        saveGroup(tid, r, groupIds);
        syncGroupChecks();
        renderHoleForm();
        renderBulkTable();
      };

      pickerTop.appendChild(btnMeTeam);
      pickerTop.appendChild(btnAll);
      groupPicker.appendChild(pickerTop);

      const listItems = isTwoManBestBall
        ? allowedRoundGroups.map((g) => ({ id: g.groupId, text: `${g.displayName} (${g.names.join(", ") || "—"})` }))
        : allowedRoundPlayerIds
          .map((id) => {
            const p = playersById[id];
            if (!p) return null;
            const groupLabel = hasTwoManBestBallTournament ? groupLabelForPlayer({ ...p, group: groupForPlayerRound(p, r) }) : "";
            const groupText = groupLabel ? ` ${groupLabel}` : "";
            return { id, text: `${p.name}${groupText}${p.teamId ? ` (${p.teamId})` : ""}` };
          })
          .filter(Boolean);

      for (const item of listItems) {
        const id = item.id;
        const checked = groupIds.includes(id);
        const lbl = el("label", { style: "display:flex; align-items:center; gap:6px; cursor:pointer;" });
        const cb = el("input", { type: "checkbox" });
        cb.setAttribute("data-target-id", id);
        cb.checked = checked;
        cb.onchange = () => {
          if (cb.checked) {
            if (!groupIds.includes(id)) groupIds.push(id);
          } else {
            groupIds = groupIds.filter((x) => x !== id);
          }
          if (!isTwoManBestBall && !groupIds.includes(myId) && myId && allowedRoundPlayerSet.has(myId)) {
            groupIds.unshift(myId);
          }
          saveGroup(tid, r, groupIds);
          syncGroupChecks();
          renderHoleForm();
          renderBulkTable();
        };
        lbl.appendChild(cb);
        lbl.appendChild(el("span", {}, item.text));
        list.appendChild(lbl);
      }

      groupPicker.appendChild(list);
      roundBody.appendChild(groupPicker);
    }

    // Current saved holes from tournament json
    function getSavedForRound() {
      const sd = tjson.score_data?.rounds?.[r] || {};
      if (isScramble) {
        const teamId = enter.team?.teamId;
        const teamEntry = sd.team?.[teamId];
        const gross = (teamEntry?.gross || Array(18).fill(null)).map((v) => (isEmptyScore(v) ? null : v));
        return { type: "team", savedByTarget: { [teamId]: gross }, targetIds: [teamId] };
      } else if (isTwoManBestBall) {
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
        return { type: "group", savedByTarget, targetIds: ids };
      } else {
        const savedByTarget = {};
        for (const pid of Object.keys(sd.player || {})) {
          const gross = (sd.player[pid]?.gross || Array(18).fill(null)).map((v) => (isEmptyScore(v) ? null : v));
          savedByTarget[pid] = gross;
        }
        const ids = (groupIds.length ? groupIds : [myId].filter(Boolean)).filter((id) =>
          allowedRoundPlayerSet.has(id)
        );
        return { type: "player", savedByTarget, targetIds: ids };
      }
    }

    let currentHole = null;      // not chosen yet
    let holeManuallySet = false; // only true after user clicks prev/next or selects a hole
    let pendingHoleConflict = null;

    const status = el("div", { class: "small", style: "margin-top:10px;" }, "");
    const conflictBox = el("div", { class: "card", style: "display:none; border:2px solid var(--bad); margin-top:10px;" });

    function captureActiveInputState() {
      const active = document.activeElement;
      if (!(active instanceof HTMLInputElement)) return null;
      if (!holePane.contains(active) && !bulkPane.contains(active)) return null;
      const scope = active.getAttribute("data-enter-scope");
      const targetId = active.getAttribute("data-target-id");
      const holeIndex = active.getAttribute("data-hole-index");
      if (!scope || !targetId || holeIndex == null) return null;
      return {
        scope,
        targetId,
        holeIndex,
        selectionStart: active.selectionStart,
        selectionEnd: active.selectionEnd,
        selectionDirection: active.selectionDirection
      };
    }

    function restoreActiveInputState(state) {
      if (!state) return;
      const root = state.scope === "bulk" ? bulkPane : holePane;
      const candidates = root.querySelectorAll(
        `input[data-enter-scope="${state.scope}"][data-hole-index="${state.holeIndex}"]`
      );
      const input = Array.from(candidates).find((n) => n.getAttribute("data-target-id") === state.targetId);
      if (!input) return;
      input.focus({ preventScroll: true });
      if (typeof state.selectionStart === "number" && typeof state.selectionEnd === "number") {
        try {
          input.setSelectionRange(state.selectionStart, state.selectionEnd, state.selectionDirection || undefined);
        } catch { }
      }
    }

    function renderHoleForm() {
      holePane.innerHTML = "";

      const { type, savedByTarget, targetIds } = getSavedForRound();
      // set currentHole to next unplayed, but keep user-selected if they already moved it manually
      const suggested = nextHoleIndexForGroup(savedByTarget, targetIds);

      // On first load (or if user hasn't manually set a hole), jump to next unplayed
      if (!holeManuallySet || currentHole == null || Number.isNaN(currentHole) || currentHole < 0 || currentHole > 17) {
        currentHole = suggested;
      }
      if (pendingHoleConflict && pendingHoleConflict.holeIndex !== currentHole) {
        pendingHoleConflict = null;
      }
      conflictBox.style.display = "none";
      status.textContent = "";
      const holeCourse = courseForRound(tjson, r);

      const header = el("div", { class: "hole-header" });
      header.appendChild(
        el(
          "div",
          {},
          `<b>${holeLabel(currentHole)}</b> <span class="small">Par ${holeCourse.pars[currentHole]} • SI ${holeCourse.strokeIndex[currentHole]}</span>`
        )
      );

      const holeSel = el("select", { style: "padding:6px 10px; border-radius:10px; border:1px solid var(--border);" });
      for (let i = 0; i < 18; i++) {
        const opt = el("option", { value: String(i) }, `${i + 1}`);
        if (i === currentHole) opt.selected = true;
        holeSel.appendChild(opt);
      }
      holeSel.onchange = () => {
        currentHole = Number(holeSel.value);
        holeManuallySet = true;
        renderHoleForm();
      };

      header.appendChild(el("div", {}, `<span class="small">Jump to hole</span><br/>`));
      header.lastChild.appendChild(holeSel);
      holePane.appendChild(header);

      const grid = el("div", { class: "hole-grid" });

      const inputs = [];

      function makeScoreInput(initialStr) {
        const wrap = el("div", { style: "display:flex; align-items:center; gap:6px; margin-top:8px;" });
        const inp = el("input", {
          type: "number",
          min: "1",
          max: "20",
          step: "1",
          style: "width:78px; min-height:38px; padding:6px 8px; border-radius:10px; border:1px solid var(--border); background:var(--field-bg); color:var(--text); font-size:16px; margin-top:0;",
        });
        const delta = el("span", { class: "small", style: "min-width:22px; font-weight:700;" }, "");
        inp.value = initialStr ?? "";
        syncHoleDeltaLabel(delta, inp.value, holeCourse?.pars?.[currentHole]);
        inp.addEventListener("input", () => {
          syncHoleDeltaLabel(delta, inp.value, holeCourse?.pars?.[currentHole]);
        });
        wrap.appendChild(inp);
        wrap.appendChild(delta);
        return { wrap, inp };
      }

      if (type === "team") {
        const teamId = targetIds[0];
        const teamColor = colorForTeam(teamId);
        const existingRaw = (savedByTarget[teamId] || Array(18).fill(null))[currentHole];
        const existing = isEmptyScore(existingRaw) ? null : existingRaw;

        const draft = getHoleDraft(r, currentHole, teamId);
        const initial = draft !== undefined ? draft : existing == null ? "" : String(existing);

        const row = el("div", { class: "hole-row team-accent", style: `--team-accent:${teamColor};` });
        row.appendChild(
          el(
            "div",
            { style: "min-width:0;" },
            `<b>${enter.team?.teamName || "Team"}</b> <span class="small">(team score)</span><br/><span class="small">Existing: ${existing == null ? "—" : existing
            }</span>`
          )
        );

        const { wrap, inp } = makeScoreInput(initial);
        inp.setAttribute("data-enter-scope", "hole");
        inp.setAttribute("data-target-id", teamId);
        inp.setAttribute("data-hole-index", String(currentHole));
        inp.addEventListener("input", () => setHoleDraft(r, currentHole, teamId, inp.value));
        inputs.push({ targetId: teamId, input: inp });

        row.appendChild(wrap);
        grid.appendChild(row);
      } else if (type === "group") {
        const ids = targetIds.length
          ? targetIds
          : (() => {
            const g = twoManGroupId(myTeamId, groupForPlayerRound(playersById[myId], r));
            return g ? [g] : [];
          })();
        for (const gid of ids) {
          const meta = allowedRoundGroupById[gid] || { displayName: gid, names: [], teamId: parseTwoManGroupId(gid).teamId };
          const teamColor = colorForTeam(meta.teamId);
          const existingRaw = (savedByTarget[gid] || Array(18).fill(null))[currentHole];
          const existing = isEmptyScore(existingRaw) ? null : existingRaw;
          const draft = getHoleDraft(r, currentHole, gid);
          const initial = draft !== undefined ? draft : existing == null ? "" : String(existing);

          const row = el("div", { class: "hole-row team-accent", style: `--team-accent:${teamColor};` });
          row.appendChild(
            el(
              "div",
              { style: "min-width:0;" },
              `<b>${meta.displayName || gid}</b> <span class="small">(${(meta.names || []).join(", ") || "pair"})</span><br/><span class="small">Existing: ${existing == null ? "—" : existing}</span>`
            )
          );

          const { wrap, inp } = makeScoreInput(initial);
          inp.setAttribute("data-enter-scope", "hole");
          inp.setAttribute("data-target-id", gid);
          inp.setAttribute("data-hole-index", String(currentHole));
          inp.addEventListener("input", () => setHoleDraft(r, currentHole, gid, inp.value));
          inputs.push({ targetId: gid, input: inp });

          row.appendChild(wrap);
          grid.appendChild(row);
        }
      } else {
        const ids = targetIds.length
          ? targetIds
          : [myId].filter((id) => Boolean(id) && allowedRoundPlayerSet.has(id));
        for (const pid of ids) {
          const p = playersById[pid];
          if (!p) continue;
          const teamColor = colorForTeam(p.teamId);

          const existingRaw = (savedByTarget[pid] || Array(18).fill(null))[currentHole];
          const existing = isEmptyScore(existingRaw) ? null : existingRaw;

          const draft = getHoleDraft(r, currentHole, pid);
          const initial = draft !== undefined ? draft : existing == null ? "" : String(existing);

          const row = el("div", { class: "hole-row team-accent", style: `--team-accent:${teamColor};` });
          row.appendChild(
            el(
              "div",
              { style: "min-width:0;" },
              `<b>${p.name}</b> <span class="small">${hasTwoManBestBallTournament && groupForPlayerRound(p, r) ? `(Group ${groupForPlayerRound(p, r)}) ` : ""}${p.handicap != null ? `(hcp ${p.handicap})` : ""}</span><br/><span class="small">Existing: ${existing == null ? "—" : existing
              }</span>`
            )
          );

          const { wrap, inp } = makeScoreInput(initial);
          inp.setAttribute("data-enter-scope", "hole");
          inp.setAttribute("data-target-id", pid);
          inp.setAttribute("data-hole-index", String(currentHole));
          inp.addEventListener("input", () => setHoleDraft(r, currentHole, pid, inp.value));
          inputs.push({ targetId: pid, input: inp });

          row.appendChild(wrap);
          grid.appendChild(row);
        }
      }

      holePane.appendChild(grid);

      const actions = el("div", { class: "actions hole-actions", style: "margin-top:10px;" });
      const btnSubmit = el("button", { class: "", type: "button" }, "Submit hole");
      const btnNext = el("button", { class: "secondary", type: "button" }, "Next hole →");
      const btnPrev = el("button", { class: "secondary", type: "button" }, "← Prev hole");
      actions.appendChild(btnSubmit);
      actions.appendChild(btnPrev);
      actions.appendChild(btnNext);
      holePane.appendChild(actions);
      holePane.appendChild(status);
      holePane.appendChild(conflictBox);

      btnPrev.onclick = () => {
        currentHole = Math.max(0, currentHole - 1);
        holeManuallySet = true;
        renderHoleForm();
      };
      btnNext.onclick = async () => {
        const result = await doSubmit(false, { quietIfEmpty: true, advanceMode: "sequential" });
        if (result?.skipped) {
          currentHole = Math.min(17, currentHole + 1);
          holeManuallySet = true;
          renderHoleForm();
        }
      };

      async function doSubmit(withOverride = false, { quietIfEmpty = false, advanceMode = "next-unplayed" } = {}) {
        status.textContent = "Submitting…";
        pendingHoleConflict = null;
        conflictBox.style.display = "none";
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

        try {
          await api(`/tournaments/${encodeURIComponent(tid)}/scores`, {
            method: "POST",
            body: {
              code,
              roundIndex: r,
              mode: "hole",
              holeIndex: submittedHoleIndex,
              entries,
              override: withOverride,
            },
          });

          pendingHoleConflict = null;
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
            // advance to next unplayed hole for group
            const nowSaved = getSavedForRound();
            currentHole = nextHoleIndexForGroup(nowSaved.savedByTarget, nowSaved.targetIds);
          }

          renderHoleForm();
          renderBulkTable();
          return { ok: true };
        } catch (err) {
          if (err?.status === 409 && err?.data) {
            showConflict(err.data);
            return { conflict: true };
          }
          status.textContent = `Error: ${err?.message || String(err)}`;
          return { error: true };
        }
      }

      function showConflict(j) {
        pendingHoleConflict = { holeIndex: currentHole, data: j };
        const conflicts = j.conflicts || [];
        const names = conflicts.map((c) => {
          if (type === "group") {
            return allowedRoundGroupById[c.targetId]?.displayName || c.targetId;
          }
          const p = playersById[c.targetId];
          return p ? p.name : c.targetId;
        });
        conflictBox.style.display = "";
        conflictBox.innerHTML = `
          <b>Scores already posted for ${holeLabel(currentHole)}.</b><br/>
          <div class="small" style="margin-top:6px;">
            ${names.length ? `Conflicts: ${names.join(", ")}` : "Conflict."}<br/>
            You must press Override to replace existing scores.
          </div>
        `;
        const btn = el("button", { class: "", type: "button", style: "margin-top:10px;" }, "Override hole and submit");
        btn.onclick = () => doSubmit(true);
        conflictBox.appendChild(btn);
        status.textContent = "Not saved (conflict).";
      }

      btnSubmit.onclick = () => doSubmit(false);
      if (pendingHoleConflict && pendingHoleConflict.holeIndex === currentHole) {
        showConflict(pendingHoleConflict.data);
      }
    }

    function renderBulkTable() {
      bulkPane.innerHTML = "";

      const { type, savedByTarget, targetIds } = getSavedForRound();
      const coursePars = courseForRound(tjson, r).pars || Array(18).fill(4);
      const ids =
        type === "team"
          ? targetIds
          : targetIds.length
            ? targetIds
            : [myId].filter((id) => Boolean(id) && allowedRoundPlayerSet.has(id));
      const typeInfoText = type === "team"
        ? "Scramble round: enter one team score per hole."
        : type === "group"
          ? "Two man round: enter one group score per hole."
          : "Player-based round: enter one score per player per hole.";

      const info = el(
        "div",
        { class: "small", style: "margin-bottom:10px;" },
        `${typeInfoText} Bulk input: paste/update multiple holes, then submit. Bulk submit overrides existing scores.`
      );
      bulkPane.appendChild(info);

      const tableWrap = el("div", { class: "bulk-table-wrap" });
      const tbl = el("table", { class: "table bulk-table" });
      const thead = el("thead");
      const trH = el("tr");
      trH.innerHTML =
        `<th class="left">${type === "team" ? "Team" : type === "group" ? "Group" : "Player"}</th>` +
        `<th>Side</th>` +
        Array.from({ length: 9 }, (_, i) => `<th>${i + 1}</th>`).join("");
      thead.appendChild(trH);
      tbl.appendChild(thead);

      const tbody = el("tbody");
      const rowInputs = {};

      for (const id of ids) {
        const meta = type === "group" ? allowedRoundGroupById[id] : null;
        const name = type === "team"
          ? enter.team?.teamName || id
          : type === "group"
            ? meta?.displayName || id
            : playersById[id]?.name || id;
        const groupLabel = type === "team"
          ? ""
          : type === "group"
            ? ((meta?.names || []).join(", "))
              : hasTwoManBestBallTournament
              ? (groupForPlayerRound(playersById[id], r) ? `Group ${groupForPlayerRound(playersById[id], r)}` : "")
              : "";
        const teamId = type === "team" ? id : type === "group" ? meta?.teamId : playersById[id]?.teamId;
        const teamColor = colorForTeam(teamId);
        const holes = (savedByTarget[id] || Array(18).fill(null)).map((v) => (isEmptyScore(v) ? null : v));

        rowInputs[id] = Array(18).fill(null);

        const frontRow = el("tr");
        const nameCell = el(
          "td",
          { class: "left bulk-player team-accent", rowspan: "2", style: `--team-accent:${teamColor};` },
          `<b>${name}</b>${groupLabel ? ` <span class="small">(${groupLabel})</span>` : ""}`
        );
        frontRow.appendChild(nameCell);
        frontRow.appendChild(el("td", { class: "mono bulk-side" }, "Front 9"));

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
          const delta = el("span", { class: "small", style: "min-width:18px; font-weight:700;" }, "");
          const dv = getBulkDraft(r, id, i);
          const initial = dv !== undefined ? dv : holes[i] == null ? "" : String(holes[i]);
          inp.value = initial ?? "";
          inp.setAttribute("data-enter-scope", "bulk");
          inp.setAttribute("data-target-id", id);
          inp.setAttribute("data-hole-index", String(i));
          syncHoleDeltaLabel(delta, inp.value, coursePars[i]);
          inp.addEventListener("input", () => {
            setBulkDraft(r, id, i, inp.value);
            syncHoleDeltaLabel(delta, inp.value, coursePars[i]);
          });
          rowInputs[id][i] = inp;
          inputWrap.appendChild(inp);
          inputWrap.appendChild(delta);
          td.appendChild(inputWrap);
          frontRow.appendChild(td);
        }

        const backRow = el("tr");
        backRow.appendChild(el("td", { class: "mono bulk-side" }, "Back 9"));
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
          const delta = el("span", { class: "small", style: "min-width:18px; font-weight:700;" }, "");
          const dv = getBulkDraft(r, id, i);
          const initial = dv !== undefined ? dv : holes[i] == null ? "" : String(holes[i]);
          inp.value = initial ?? "";
          inp.setAttribute("data-enter-scope", "bulk");
          inp.setAttribute("data-target-id", id);
          inp.setAttribute("data-hole-index", String(i));
          syncHoleDeltaLabel(delta, inp.value, coursePars[i]);
          inp.addEventListener("input", () => {
            setBulkDraft(r, id, i, inp.value);
            syncHoleDeltaLabel(delta, inp.value, coursePars[i]);
          });
          rowInputs[id][i] = inp;
          inputWrap.appendChild(inp);
          inputWrap.appendChild(delta);
          td.appendChild(inputWrap);
          backRow.appendChild(td);
        }

        tbody.appendChild(frontRow);
        tbody.appendChild(backRow);
      }

      tbl.appendChild(tbody);
      tableWrap.appendChild(tbl);
      bulkPane.appendChild(tableWrap);

      const bulkStatus = el("div", { class: "small", style: "margin-top:10px;" }, "");
      const btnRow = el("div", { style: "display:flex; gap:10px; flex-wrap:wrap; margin-top:10px;" });
      const btnSubmit = el("button", { class: "", type: "button" }, "Override & submit bulk");
      btnRow.appendChild(btnSubmit);
      bulkPane.appendChild(btnRow);
      bulkPane.appendChild(bulkStatus);

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

        try {
          await api(`/tournaments/${encodeURIComponent(tid)}/scores`, {
            method: "POST",
            body: {
              code,
              roundIndex: r,
              mode: "bulk",
              entries,
              override: true,
            },
          });

          bulkStatus.textContent = "Saved.";

          // bulk submit = clear all drafts for this round (hole + bulk)
          clearRoundDraft(r);

          await refreshTournamentJson();
          renderTicker(tjson, playersById, teamsById, tickerRoundIndex);

          renderHoleForm();
          renderBulkTable();
        } catch (e) {
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
        await refreshTournamentJson();
        renderTicker(tjson, playersById, teamsById, tickerRoundIndex);
        const activeInputState = captureActiveInputState();
        renderHoleForm();
        renderBulkTable();
        restoreActiveInputState(activeInputState);
      } catch { }
    }, 30_000);

    // keep the timer from being GC'd (optional)
    roundCard._refreshTimer = refreshTimer;

    forms.appendChild(roundCard);
  }

  renderTeamCurrentScore();
  renderTicker(tjson, playersById, teamsById, tickerRoundIndex);
}

main().catch((e) => {
  forms.innerHTML = `<div class="card"><b>Error:</b> ${e?.message || String(e)}</div>`;
});
