import {
  api,
  staticJson,
  qs,
  dotsForStrokes,
  createTeamColorRegistry,
  setHeaderTournamentName,
  getRememberedTournamentId,
  rememberTournamentId
} from "./app.js";

const tidFromQuery = String(qs("t") || qs("code") || "").trim();
if (tidFromQuery) rememberTournamentId(tidFromQuery);
const tid = tidFromQuery || getRememberedTournamentId();
const roundFilter = document.getElementById("round_filter");
const btnTeam = document.getElementById("btn_team");
const btnPlayer = document.getElementById("btn_player");
const toggleNote = document.getElementById("toggle_note");
const lbTitle = document.getElementById("lb_title");
const lbTbl = document.getElementById("lb_tbl");
const updated = document.getElementById("updated");
const status = document.getElementById("status");
const raw = document.getElementById("raw");
const statsMeta = document.getElementById("stats_meta");
const statsKpis = document.getElementById("stats_kpis");
const statsHoleTbl = document.getElementById("stats_hole_tbl");
const scoreNotifier = document.getElementById("score_notifier");

const scorecardCard = document.getElementById("scorecard_card");

let mode = "player"; // "team" | "player"
let currentRound = "all"; // "all" | number
let TOURN = null;

let openInlineKey = null;
let openInlineRow = null;
let inlineReqToken = 0;
let sortState = { key: "score", dir: "asc" };
const AUTO_REFRESH_MS = 30_000;
let refreshTimerId = null;
let refreshInFlight = false;
let scoreNotifierTimerId = 0;
let scoreNotifierQueue = [];
let scoreNotifierActive = false;
let recentUpdatedRowKeys = new Set();
let recentUpdatedClearTimerId = 0;
const SCORE_NOTIFIER_SHOW_MS = 2300;
const SCORE_NOTIFIER_GAP_MS = 200;
const ROW_UPDATE_HIGHLIGHT_MS = 12000;
const teamColors = createTeamColorRegistry();
let teamColorsSeeded = false;
const brandDot = document.querySelector(".brand .dot");

function syncModeButtons() {
  btnTeam.classList.toggle("active", mode === "team");
  btnPlayer.classList.toggle("active", mode === "player");
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

function rebuildTeamColors() {
  if (teamColorsSeeded) return;

  const seenTeamIds = new Set();
  const ordered = [];
  const add = (teamId, teamName) => {
    const id = teamId == null ? "" : String(teamId).trim();
    if (!id || seenTeamIds.has(id)) return;
    seenTeamIds.add(id);
    ordered.push({ teamId: id, teamName: String(teamName || "").trim() });
  };

  // Match enter.js assignment order: teams first, then players.
  (TOURN?.teams || []).forEach((t) => add(t?.teamId ?? t?.id, t?.teamName ?? t?.name));
  (TOURN?.players || []).forEach((p) => add(p?.teamId, p?.teamName));

  // Add any ids that appear only in leaderboard payloads.
  (TOURN?.score_data?.leaderboard_all?.teams || []).forEach((t) => add(t?.teamId, t?.teamName));
  const rounds = TOURN?.score_data?.rounds || [];
  rounds.forEach((rd) => {
    (rd?.leaderboard?.teams || []).forEach((t) => add(t?.teamId, t?.teamName));
    (rd?.leaderboard?.players || []).forEach((p) => add(p?.teamId, p?.teamName));
  });

  teamColors.reset(ordered.length);
  ordered.forEach((e) => teamColors.add(e.teamId, e.teamName));
  teamColorsSeeded = true;
}

function colorForTeam(teamId, teamName) {
  return teamColors.get(teamId, teamName);
}

function toParStrFromDiff(diff) {
  const d = Math.round(Number(diff) || 0);
  if (d === 0) return "E";
  return d > 0 ? `+${d}` : `${d}`;
}

function toParStrFromDecimal(diff) {
  const d = Number(diff) || 0;
  if (Math.abs(d) < 0.05) return "E";
  const rounded = Math.round(d * 100) / 100;
  const out = String(rounded.toFixed(2)).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  return rounded > 0 ? `+${out}` : out;
}

function formatDecimal(v) {
  const n = Number(v) || 0;
  return String(n.toFixed(2)).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function sumHoles(arr) {
  return (arr || []).reduce((a, v) => a + (v == null ? 0 : Number(v) || 0), 0);
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

function courseListFromTournament(tournamentJson = TOURN) {
  const fromList = Array.isArray(tournamentJson?.courses)
    ? tournamentJson.courses.map((course) => normalizeCourseShape(course)).filter(Boolean)
    : [];
  if (fromList.length) return fromList;
  const legacy = normalizeCourseShape(tournamentJson?.course);
  if (legacy) return [legacy];
  return [defaultCourse()];
}

function courseForRoundIndex(roundIndex, tournamentJson = TOURN) {
  const courses = courseListFromTournament(tournamentJson);
  const rounds = tournamentJson?.tournament?.rounds || [];
  const idxRaw = Number(rounds?.[roundIndex]?.courseIndex);
  const idx = Number.isInteger(idxRaw) && idxRaw >= 0 && idxRaw < courses.length ? idxRaw : 0;
  return courses[idx] || courses[0] || defaultCourse();
}

function isPlayedScore(v) {
  return v != null && Number(v) > 0;
}

function hasAnyScore(arr) {
  if (!Array.isArray(arr)) return false;
  for (const v of arr) {
    if (isPlayedScore(v)) return true;
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

function weightedTeamLeaderRow() {
  const rows = TOURN?.score_data?.leaderboard_all?.teams || [];
  const rowsWithData = rows.filter((row) => rowHasAnyData(row));
  if (!rowsWithData.length) return null;
  const dataAllRounds = buildScoreboardResponse(TOURN, "all");
  return [...rowsWithData].sort((a, b) => defaultSortComparator(a, b, true, dataAllRounds))[0] || null;
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

function newestRoundWithDataIndex(tournamentJson) {
  const rounds = tournamentJson?.tournament?.rounds || [];
  if (!rounds.length) return -1;
  const scoreRounds = tournamentJson?.score_data?.rounds || [];
  for (let i = rounds.length - 1; i >= 0; i--) {
    if (roundHasAnyData(scoreRounds[i])) return i;
  }
  return 0;
}

function roundAt(viewRound) {
  if (viewRound === "all") return null;
  return (TOURN?.tournament?.rounds || [])[Number(viewRound)] || null;
}

function isHandicapRound(viewRound) {
  const round = roundAt(viewRound);
  if (!round) return false;
  return !!round.useHandicap || String(round.format || "").toLowerCase() === "scramble";
}

function isScrambleRound(viewRound) {
  const round = roundAt(viewRound);
  if (!round) return false;
  return String(round.format || "").toLowerCase() === "scramble";
}

function isTwoManBestBallRound(viewRound) {
  const round = roundAt(viewRound);
  if (!round) return false;
  const fmt = String(round.format || "").toLowerCase();
  return fmt === "two_man" || fmt === "two_man_best_ball";
}

function tournamentHasAnyScrambleRound() {
  const rounds = TOURN?.tournament?.rounds || [];
  return rounds.some((r) => String(r?.format || "").toLowerCase() === "scramble");
}

function isIndividualDefaultRound(viewRound) {
  const round = roundAt(viewRound);
  if (!round) return false;
  const format = String(round.format || "").toLowerCase();
  return format === "singles" || format === "shamble" || format === "shambles";
}

function applyModeConstraints(viewRound) {
  const scrambleRound = isScrambleRound(viewRound);
  const allRoundsTeamOnly = viewRound === "all" && tournamentHasAnyScrambleRound();
  if ((scrambleRound || allRoundsTeamOnly) && mode !== "team") mode = "team";
  btnPlayer.disabled = scrambleRound || allRoundsTeamOnly;
  syncModeButtons();
}

function getCoursePars(roundIndex = currentRound) {
  const course = roundIndex === "all"
    ? (courseListFromTournament(TOURN)[0] || defaultCourse())
    : courseForRoundIndex(Number(roundIndex), TOURN);
  const pars = course?.pars;
  if (Array.isArray(pars) && pars.length === 18 && pars.some((v) => Number(v) > 0)) {
    return pars.map((v) => Number(v) || 0);
  }
  return Array(18).fill(4);
}

function leaderboardColCount(data) {
  const isAllRounds = data.view?.round === "all";
  const showGrossNet = isHandicapRound(data.view?.round) || isAllRounds;
  const showStrokesColumn = mode === "team" && isAllRounds;
  if (showGrossNet && isAllRounds) return showStrokesColumn ? 4 : 3;
  if (showGrossNet) return 5;
  return 4;
}

function scoreValue(v) {
  return v == null || Number.isNaN(Number(v)) ? "—" : String(v);
}

function displayThru(v) {
  if (v == null) return "—";
  const n = Number(v);
  if (Number.isFinite(n) && n === 0) return "-";
  if (Number.isFinite(n) && n >= 18) return "F";
  return String(v);
}

function normalizeTeeTimeLabel(value) {
  if (value == null) return "";
  return String(value).trim();
}

function toParNumber(v) {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v).trim();
  if (!s) return null;
  const up = s.toUpperCase();
  if (up === "E" || up === "EVEN" || s === "0" || s === "+0" || s === "-0") return 0;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
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

function leaderboardToParValue(row) {
  const raw = firstDefined(row, [
    "toPar",
    "netToPar",
    "toParNet",
    "toParTotal",
    "toParNetTotal",
    "toParGross",
    "grossToPar"
  ]);
  const n = toParNumber(raw);
  if (n != null) return n > 0 ? `+${n}` : `${n}`;

  const s = String(raw == null ? "" : raw).trim();
  if (!s) return "E";
  if (s.toUpperCase() === "EVEN") return "E";
  return s;
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
    const coursePars = courseForRoundIndex(roundIndex, nextTournament).pars || Array(18).fill(4);
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
      const roundToParData = { course: { pars: coursePars, parTotal: sumHoles(coursePars) } };
      const grossToParRaw = showGrossAndNet ? grossToParForRow(row, roundToParData) : null;
      const netToParRaw = showGrossAndNet ? netToParForRow(row, roundToParData) : null;
      const hasGrossAndNetToPar =
        showGrossAndNet &&
        grossToParRaw != null &&
        netToParRaw != null &&
        grossToParRaw !== "—" &&
        netToParRaw !== "—";
      const grossToPar = hasGrossAndNetToPar ? grossToParRaw : null;
      const netToPar = hasGrossAndNetToPar ? netToParRaw : null;
      for (let holeIndex = 0; holeIndex < 18; holeIndex++) {
        const nextGross = normalizePostedScore(nextEntry?.gross?.[holeIndex]);
        if (nextGross == null) continue;

        const prevGross = normalizePostedScore(prevEntry?.gross?.[holeIndex]);
        if (prevGross != null) continue;

        const par = Number(coursePars?.[holeIndex] || 0);
        const diffToPar = par > 0 ? nextGross - par : 0;
        events.push({
          entityType: nextSource.type,
          entityId: id,
          roundIndex,
          name,
          result: scoreResultLabel(diffToPar),
          toPar: hasGrossAndNetToPar ? `${grossToPar} [${netToPar}]` : leaderboardToParValue(row),
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

function setRecentUpdatedRowsFromEvents(events) {
  const nextKeys = new Set();
  for (const ev of events || []) {
    const id = String(ev?.entityId || "").trim();
    if (!id) continue;
    const modeKey = ev?.entityType === "team" ? "team" : "player";
    const roundKey = Number.isInteger(ev?.roundIndex) ? String(ev.roundIndex) : "";
    if (roundKey) nextKeys.add(`${modeKey}:${roundKey}:${id}`);
    nextKeys.add(`${modeKey}:all:${id}`);
  }
  recentUpdatedRowKeys = nextKeys;
  if (recentUpdatedClearTimerId) clearTimeout(recentUpdatedClearTimerId);
  if (!recentUpdatedRowKeys.size) return;
  recentUpdatedClearTimerId = setTimeout(() => {
    recentUpdatedRowKeys = new Set();
    render();
  }, ROW_UPDATE_HIGHLIGHT_MS);
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

function holesPlayedForRow(row) {
  const thru = Number(row?.thru);
  if (Number.isFinite(thru) && thru > 0) return thru;
  const gross = row?.scores?.gross;
  if (Array.isArray(gross)) return gross.reduce((a, v) => a + (isPlayedScore(v) ? 1 : 0), 0);
  const net = row?.scores?.net;
  if (Array.isArray(net)) return net.reduce((a, v) => a + (isPlayedScore(v) ? 1 : 0), 0);
  return 0;
}

function textCellValue(v) {
  return String(v || "").toLowerCase();
}

function compareNullableNumber(a, b, dir) {
  const aNull = a == null || Number.isNaN(Number(a));
  const bNull = b == null || Number.isNaN(Number(b));
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  const out = Number(a) - Number(b);
  return dir === "desc" ? -out : out;
}

function defaultScoreForSort(row, showGrossNet, data) {
  if (showGrossNet) return toParNumber(netToParForRow(row, data));
  return toParNumber(firstDefined(row, ["toPar", "netToPar", "toParNet", "toParTotal"]));
}

function defaultSortComparator(a, b, showGrossNet, data) {
  const scoreCmp = compareNullableNumber(
    defaultScoreForSort(a, showGrossNet, data),
    defaultScoreForSort(b, showGrossNet, data),
    "asc"
  );
  if (scoreCmp !== 0) return scoreCmp;
  const holesCmp = compareNullableNumber(holesPlayedForRow(a), holesPlayedForRow(b), "desc");
  if (holesCmp !== 0) return holesCmp;
  return textCellValue(a?.teamName || a?.name).localeCompare(textCellValue(b?.teamName || b?.name));
}

function compareRows(a, b, sortKey, sortDir, showGrossNet, data, isTeam) {
  const nameA = isTeam ? a?.teamName : a?.name;
  const nameB = isTeam ? b?.teamName : b?.name;

  if (sortKey === "name") {
    const out = textCellValue(nameA).localeCompare(textCellValue(nameB));
    if (out !== 0) return sortDir === "desc" ? -out : out;
    return defaultSortComparator(a, b, showGrossNet, data);
  }

  if (sortKey === "thru") {
    const out = compareNullableNumber(holesPlayedForRow(a), holesPlayedForRow(b), sortDir);
    if (out !== 0) return out;
    return defaultSortComparator(a, b, showGrossNet, data);
  }

  if (sortKey === "gross") {
    const out = compareNullableNumber(
      toParNumber(grossToParForRow(a, data)),
      toParNumber(grossToParForRow(b, data)),
      sortDir
    );
    if (out !== 0) return out;
    return defaultSortComparator(a, b, showGrossNet, data);
  }

  if (sortKey === "net") {
    const out = compareNullableNumber(
      toParNumber(netToParForRow(a, data)),
      toParNumber(netToParForRow(b, data)),
      sortDir
    );
    if (out !== 0) return out;
    return defaultSortComparator(a, b, showGrossNet, data);
  }

  if (sortKey === "toPar") {
    const out = compareNullableNumber(
      toParNumber(firstDefined(a, ["toPar", "netToPar", "toParNet", "toParTotal"])),
      toParNumber(firstDefined(b, ["toPar", "netToPar", "toParNet", "toParTotal"])),
      sortDir
    );
    if (out !== 0) return out;
    return defaultSortComparator(a, b, showGrossNet, data);
  }

  if (sortKey === "strokes") {
    const out = compareNullableNumber(
      firstDefined(a, ["strokes", "net", "netTotal"]),
      firstDefined(b, ["strokes", "net", "netTotal"]),
      sortDir
    );
    if (out !== 0) return out;
    return defaultSortComparator(a, b, showGrossNet, data);
  }

  if (sortKey === "grossStrokes") {
    const out = compareNullableNumber(grossForRow(a), grossForRow(b), sortDir);
    if (out !== 0) return out;
    return defaultSortComparator(a, b, showGrossNet, data);
  }

  if (sortKey === "netStrokes") {
    const out = compareNullableNumber(netStrokesForRow(a), netStrokesForRow(b), sortDir);
    if (out !== 0) return out;
    return defaultSortComparator(a, b, showGrossNet, data);
  }

  return defaultSortComparator(a, b, showGrossNet, data);
}

function rowStableId(row, isTeam) {
  return isTeam ? String(row?.teamId || "") : String(row?.playerId || "");
}

function buildStandingRankMap(rows, showGrossNet, data, isTeam) {
  const rankById = new Map();
  const rowsWithData = rows.filter((r) => rowHasAnyData(r));
  const sorted = [...rowsWithData].sort((a, b) => defaultSortComparator(a, b, showGrossNet, data));

  let lastScore = null;
  let rank = 0;
  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i];
    const score = defaultScoreForSort(row, showGrossNet, data);
    if (i === 0 || score !== lastScore) {
      rank = i + 1;
      lastScore = score;
    }
    rankById.set(rowStableId(row, isTeam), rank);
  }
  return rankById;
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

function netStrokesForRow(row) {
  if (row?.netStrokes != null) return row.netStrokes;
  if (row?.strokes != null) return row.strokes;
  if (row?.netTotal != null) return row.netTotal;
  if (row?.scores?.netTotal != null) return row.scores.netTotal;
  if (Array.isArray(row?.scores?.net)) return sumHoles(row.scores.net);
  return null;
}

function toParDisplay(v) {
  if (v == null) return "—";
  if (typeof v === "number" && Number.isFinite(v)) return toParStrFromDiff(v);
  const s = String(v).trim();
  if (!s) return "—";
  const up = s.toUpperCase();
  if (up === "E" || up === "EVEN" || s === "0" || s === "+0" || s === "-0") return "E";
  const n = Number(s);
  if (!Number.isNaN(n)) return toParStrFromDiff(n);
  return s;
}

function firstDefined(obj, keys) {
  for (const key of keys) {
    const v = obj?.[key];
    if (v != null) return v;
  }
  return null;
}

function grossToParForRow(row, data) {
  // Prefer hole-by-hole computation so unplayed holes never count against par.
  if (Array.isArray(row?.scores?.gross) && Array.isArray(data?.course?.pars)) {
    const diff = row.scores.gross.reduce(
      (a, v, i) => a + (!isPlayedScore(v) ? 0 : Number(v) - Number(data.course.pars[i] || 0)),
      0
    );
    return toParDisplay(diff);
  }

  const explicit = firstDefined(row, [
    "toParGross",
    "grossToPar",
    "toParGrossTotal",
    "grossToParTotal"
  ]);
  if (explicit != null) return toParDisplay(explicit);
  if (row?.scores?.grossToParTotal != null) return toParDisplay(row.scores.grossToParTotal);

  const gross = grossForRow(row);
  const parTotal = Number(data?.course?.parTotal || 0);
  if (gross != null && parTotal > 0 && Number(row?.thru || 0) >= 18) {
    return toParDisplay(Number(gross) - parTotal);
  }
  return toParDisplay(row?.toPar);
}

function netToParForRow(row, data) {
  // Prefer hole-by-hole computation so unplayed holes never count against par.
  if (Array.isArray(row?.scores?.net) && Array.isArray(data?.course?.pars)) {
    const diff = row.scores.net.reduce(
      (a, v, i) => a + (!isPlayedScore(v) ? 0 : Number(v) - Number(data.course.pars[i] || 0)),
      0
    );
    return toParDisplay(diff);
  }

  const explicit = firstDefined(row, [
    "toParNet",
    "netToPar",
    "toParNetTotal",
    "netToParTotal"
  ]);
  if (explicit != null) return toParDisplay(explicit);
  if (row?.scores?.netToParTotal != null) return toParDisplay(row.scores.netToParTotal);

  const net = netForRow(row);
  const parTotal = Number(data?.course?.parTotal || 0);
  if (net != null && parTotal > 0 && Number(row?.thru || 0) >= 18) {
    return toParDisplay(Number(net) - parTotal);
  }
  return toParDisplay(row?.toPar);
}

function segmentTotal(arr, start, end) {
  let out = 0;
  for (let i = start; i <= end; i++) out += Number(arr?.[i] || 0);
  return out;
}

function segmentToPar(arr, par, start, end) {
  let out = 0;
  for (let i = start; i <= end; i++) {
    if (!isPlayedScore(arr?.[i])) continue;
    out += Number(arr[i]) - Number(par?.[i] || 0);
  }
  return out;
}

function sectionPlayedCount(arr, start, end) {
  let count = 0;
  for (let i = start; i <= end; i++) {
    if (isPlayedScore(arr?.[i])) count++;
  }
  return count;
}

function holeScoreCell(value, parValue) {
  if (!isPlayedScore(value)) return `<td class="mono"></td>`;

  const score = Number(value);
  const diff = score - Number(parValue || 0);
  const absDiff = Math.min(Math.abs(diff), 4);

  let toneClass = "score-even";
  if (diff < 0) toneClass = "score-under";
  if (diff > 0) toneClass = "score-over";
  const shadeClass = absDiff >= 2 ? " score-dark" : " score-light";

  const title = `${toParStrFromDiff(diff)} to par`;
  let shapeClass = "";
  if (diff < 0) shapeClass = " score-hole-circle";
  if (diff === 1) shapeClass = " score-hole-square";
  const content = `<span class="score-hole-pill ${toneClass}${shadeClass}${shapeClass}">${String(value)}</span>`;

  return `<td class="mono score-hole-cell" title="${title}">${content}</td>`;
}

function buildScorecardTable(scores, useHandicap) {
  const gross = scores.gross || Array(18).fill(null);
  const net = scores.net || Array(18).fill(null);
  const defaultPar = getCoursePars();
  const par =
    Array.isArray(scores.par) && scores.par.length === 18 && scores.par.some((v) => Number(v) > 0)
      ? scores.par
      : defaultPar;
  const dots = scores.handicapShots || Array(18).fill(0);
  const parTotal18 = segmentTotal(par, 0, 17);
  const grossTotal = scores.grossTotal != null ? scores.grossTotal : sumHoles(gross);
  const netTotal = scores.netTotal != null ? scores.netTotal : sumHoles(net);
  const grossToParTotal =
    scores.grossToParTotal != null
      ? scores.grossToParTotal
      : segmentToPar(gross, par, 0, 17);
  const netToParTotal =
    scores.netToParTotal != null
      ? scores.netToParTotal
      : segmentToPar(net, par, 0, 17);
  const thru =
    scores.thru != null
      ? scores.thru
      : (() => {
          let last = -1;
          for (let i = 0; i < 18; i++) {
            if (gross[i] != null && Number(gross[i]) > 0) last = i;
          }
          return last + 1;
        })();

  const wrap = document.createElement("div");
  wrap.className = "scorecard-one-wrap";

  const summary = document.createElement("div");
  summary.className = "small scorecard-summary";
  if (useHandicap) {
    summary.innerHTML =
      `<span class="score-emph-gross">Gross ${grossTotal} (${toParStrFromDiff(grossToParTotal)})</span>` +
      ` • ` +
      `<span class="score-emph-net">Net ${netTotal} (${toParStrFromDiff(netToParTotal)})</span>` +
      ` • Thru ${displayThru(thru)}`;
  } else {
    summary.textContent = `Gross ${grossTotal} (${toParStrFromDiff(grossToParTotal)}) • Thru ${displayThru(thru)}`;
  }
  wrap.appendChild(summary);

  const tbl = document.createElement("table");
  tbl.className = "table scorecard-one-table";
  const tbody = document.createElement("tbody");

  function addDotsRow(start, end) {
    if (!useHandicap) return;
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<th class="left"></th>` +
      Array.from({ length: end - start + 1 }, (_, k) => {
        const i = start + k;
        return `<th class="mono dots">${dotsForStrokes(dots[i])}</th>`;
      }).join("") +
      `<th></th><th></th>`;
    tbody.appendChild(tr);
  }

  function addHeaderRow(label, start, end) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<th class="left">${label}</th>` +
      Array.from({ length: end - start + 1 }, (_, k) => `<th>${start + k + 1}</th>`).join("") +
      `<th>Total</th><th>±</th>`;
    tbody.appendChild(tr);
  }

  function addDataRow(label, arr, start, end) {
    const played = sectionPlayedCount(arr, start, end);
    const totalCell = played ? String(segmentTotal(arr, start, end)) : "";
    const toParCell = played ? toParStrFromDiff(segmentToPar(arr, par, start, end)) : "";
    const scoreWeightClass = useHandicap
      ? (String(label).endsWith(" Net") || String(label) === "Net"
        ? "score-emph-net"
        : (String(label).endsWith(" Gross") || String(label) === "Gross"
          ? "score-emph-gross"
          : ""))
      : "";
    const emph = scoreWeightClass ? ` class="${scoreWeightClass}"` : "";
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="left"><b${emph}>${label}</b></td>` +
      Array.from({ length: end - start + 1 }, (_, k) => {
        const i = start + k;
        return holeScoreCell(arr[i], par[i]);
      }).join("") +
      `<td class="mono"><b${emph}>${totalCell}</b></td>` +
      `<td class="mono"><b${emph}>${toParCell}</b></td>`;
    tbody.appendChild(tr);
  }

  function addParRow(start, end) {
    const sectionPar = segmentTotal(par, start, end);
    const parTotalCell = start === 9 ? `${sectionPar} (${parTotal18})` : String(sectionPar);
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="left"><b>Par</b></td>` +
      Array.from({ length: end - start + 1 }, (_, k) => {
        const i = start + k;
        return `<td class="mono">${String(par[i] || 0)}</td>`;
      }).join("") +
      `<td class="mono"><b>${parTotalCell}</b></td>` +
      `<td class="mono"><b>E</b></td>`;
    tbody.appendChild(tr);
  }

  function addSectionSpacer() {
    const tr = document.createElement("tr");
    tr.className = "scorecard-spacer-row";
    tr.innerHTML = `<td colspan="12"></td>`;
    tbody.appendChild(tr);
  }

  addDotsRow(0, 8);
  addHeaderRow("Front 9", 0, 8);
  addDataRow("Gross", gross, 0, 8);
  if (useHandicap) addDataRow("Net", net, 0, 8);
  addParRow(0, 8);
  addSectionSpacer();
  addDotsRow(9, 17);
  addHeaderRow("Back 9", 9, 17);
  addDataRow("Gross", gross, 9, 17);
  if (useHandicap) addDataRow("Net", net, 9, 17);
  addParRow(9, 17);

  tbl.appendChild(tbody);
  wrap.appendChild(tbl);
  return wrap;
}

function buildTeamMembersScorecard(roundIndex, teamRow, useHandicap) {
  const teamId = teamRow?.teamId;
  if (!teamId) return null;

  const roundData = TOURN?.score_data?.rounds?.[roundIndex];
  const byPlayer = roundData?.player || null;
  if (!byPlayer) return null;

  const teamPlayers = (TOURN?.players || [])
    .filter((p) => p?.teamId === teamId)
    .map((p) => {
      const entry = byPlayer[p.playerId] || {};
      return {
        name: p.name || p.playerId || "Player",
        gross: Array.isArray(entry.gross) ? entry.gross : Array(18).fill(null),
        net: Array.isArray(entry.net) ? entry.net : Array(18).fill(null)
      };
    });

  if (!teamPlayers.length) return null;
  const anyData = teamPlayers.some((p) => hasAnyScore(p.gross) || hasAnyScore(p.net));
  if (!anyData) return null;

  const par = getCoursePars(roundIndex);
  const parTotal18 = segmentTotal(par, 0, 17);
  const wrap = document.createElement("div");
  wrap.className = "scorecard-one-wrap";

  const summary = document.createElement("div");
  summary.className = "small scorecard-summary";
  summary.textContent = useHandicap
    ? "Team members (gross rows shown)"
    : "Team members";
  wrap.appendChild(summary);

  const tbl = document.createElement("table");
  tbl.className = "table scorecard-one-table scorecard-team-table";
  const tbody = document.createElement("tbody");

  function addHeaderRow(label, start, end) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<th class="left">${label}</th>` +
      Array.from({ length: end - start + 1 }, (_, k) => `<th>${start + k + 1}</th>`).join("") +
      `<th>Total</th><th>±</th>`;
    tbody.appendChild(tr);
  }

  function addPlayerRows(start, end) {
    for (const p of teamPlayers) {
      const holes = p.gross;
      const played = holes.slice(start, end + 1).some((v) => v != null && Number(v) > 0);
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td class="left"><b>${p.name}</b></td>` +
        Array.from({ length: end - start + 1 }, (_, k) => {
          const i = start + k;
          return holeScoreCell(holes[i], par[i]);
        }).join("") +
        `<td class="mono"><b>${played ? segmentTotal(holes, start, end) : ""}</b></td>` +
        `<td class="mono"><b>${played ? toParStrFromDiff(segmentToPar(holes, par, start, end)) : ""}</b></td>`;
      tbody.appendChild(tr);
    }
  }

  function addParRow(start, end) {
    const sectionPar = segmentTotal(par, start, end);
    const parTotalCell = start === 9 ? `${sectionPar} (${parTotal18})` : String(sectionPar);
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="left"><b>Par</b></td>` +
      Array.from({ length: end - start + 1 }, (_, k) => {
        const i = start + k;
        return `<td class="mono">${String(par[i] || 0)}</td>`;
      }).join("") +
      `<td class="mono"><b>${parTotalCell}</b></td>` +
      `<td class="mono"><b>E</b></td>`;
    tbody.appendChild(tr);
  }

  function addSectionSpacer() {
    const tr = document.createElement("tr");
    tr.className = "scorecard-spacer-row";
    tr.innerHTML = `<td colspan="12"></td>`;
    tbody.appendChild(tr);
  }

  addHeaderRow("Front 9", 0, 8);
  addPlayerRows(0, 8);
  addParRow(0, 8);
  addSectionSpacer();
  addHeaderRow("Back 9", 9, 17);
  addPlayerRows(9, 17);
  addParRow(9, 17);

  tbl.appendChild(tbody);
  wrap.appendChild(tbl);
  return wrap;
}

function normalizeTwoManGroupKey(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 16);
}

function playerGroupForRound(player, roundIndex) {
  const idx = Math.max(0, Math.floor(Number(roundIndex) || 0));
  if (Array.isArray(player?.groups)) {
    const g = normalizeTwoManGroupKey(player.groups[idx]);
    if (g) return g;
  }
  if (idx === 0) return normalizeTwoManGroupKey(player?.group);
  return "";
}

function teeTimeForPlayerRound(player, roundIndex) {
  const idx = Math.max(0, Math.floor(Number(roundIndex) || 0));
  if (!player || idx < 0) return "";
  if (Array.isArray(player?.teeTimes)) {
    const raw = normalizeTeeTimeLabel(player.teeTimes[idx]);
    if (raw) return raw;
  }
  if (idx === 0) {
    const fallback = normalizeTeeTimeLabel(player?.teeTime);
    if (fallback) return fallback;
  }
  return "";
}

function playerMetaByIdMap() {
  const out = new Map();
  (TOURN?.players || []).forEach((p) => {
    const id = String(p?.playerId || "").trim();
    if (!id) return;
    out.set(id, p || {});
  });
  return out;
}

function teeTimeForPlayerIds(playerIds, roundIndex) {
  const wanted = new Set((playerIds || []).map((id) => String(id || "").trim()).filter(Boolean));
  if (!wanted.size) return "";
  const players = TOURN?.players || [];
  for (const p of players) {
    const id = String(p?.playerId || "").trim();
    if (!wanted.has(id)) continue;
    const tee = teeTimeForPlayerRound(p, roundIndex);
    if (tee) return tee;
  }
  return "";
}

function teeTimeForTeamRound(teamId, roundIndex) {
  const id = normalizeTeamId(teamId);
  if (!id) return "";
  const players = TOURN?.players || [];
  for (const p of players) {
    if (normalizeTeamId(p?.teamId) !== id) continue;
    const tee = teeTimeForPlayerRound(p, roundIndex);
    if (tee) return tee;
  }
  return "";
}

function bestBallHolesForPlayers(roundData, playerIds, metric) {
  const out = Array(18).fill(null);
  for (let i = 0; i < 18; i++) {
    const vals = (playerIds || [])
      .map((playerId) => asPlayedNumber(roundData?.player?.[playerId]?.[metric]?.[i]))
      .filter((v) => v != null);
    out[i] = vals.length ? Math.min(...vals) : null;
  }
  return out;
}

function combineGroupHoleSets(groups) {
  const out = Array(18).fill(null);
  for (let i = 0; i < 18; i++) {
    let sum = 0;
    let allPresent = (groups || []).length > 0;
    for (const arr of groups || []) {
      const v = asPlayedNumber(arr?.[i]);
      if (v == null) {
        allPresent = false;
        break;
      }
      sum += v;
    }
    out[i] = allPresent ? sum : null;
  }
  return out;
}

function playerNameMap() {
  const out = new Map();
  (TOURN?.players || []).forEach((p) => {
    const id = String(p?.playerId || "").trim();
    if (!id) return;
    out.set(id, p?.name || id);
  });
  return out;
}

function twoManGroupKeysForTeam(teamId, roundIndex, teamEntry = {}) {
  const out = new Set();
  const normTeamId = String(teamId || "").trim();

  const addKey = (key) => {
    const norm = normalizeTwoManGroupKey(key);
    if (norm) out.add(norm);
  };

  Object.keys(teamEntry?.groups || {}).forEach(addKey);

  const teamDef = (TOURN?.teams || []).find((t) => String(t?.teamId ?? t?.id ?? "").trim() === normTeamId);
  const fromDef = teamDef?.groupsByRound?.[String(roundIndex)] || teamDef?.groups || {};
  Object.keys(fromDef).forEach(addKey);

  (TOURN?.players || []).forEach((p) => {
    if (String(p?.teamId || "").trim() !== normTeamId) return;
    addKey(playerGroupForRound(p, roundIndex));
  });

  return Array.from(out).sort((a, b) => a.localeCompare(b));
}

function twoManGroupEntry(teamEntry, groupKey) {
  const target = normalizeTwoManGroupKey(groupKey);
  if (!target) return {};
  const groups = teamEntry?.groups || {};
  for (const [rawKey, value] of Object.entries(groups)) {
    if (normalizeTwoManGroupKey(rawKey) === target) return value || {};
  }
  return {};
}

function playerIdsForTwoManGroup(teamId, roundIndex, groupKey, fallback = []) {
  const key = normalizeTwoManGroupKey(groupKey);
  if (!key) return [];
  const seeded = Array.isArray(fallback)
    ? fallback.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  if (seeded.length) return Array.from(new Set(seeded));

  const teamDef = (TOURN?.teams || []).find((t) => String(t?.teamId ?? t?.id ?? "").trim() === teamId);
  const fromTeamDef = teamDef?.groupsByRound?.[String(roundIndex)]?.[key] || teamDef?.groups?.[key];
  if (Array.isArray(fromTeamDef) && fromTeamDef.length) {
    return Array.from(
      new Set(fromTeamDef.map((id) => String(id || "").trim()).filter(Boolean))
    );
  }

  return Array.from(
    new Set(
      (TOURN?.players || [])
        .filter(
          (p) =>
            String(p?.teamId || "").trim() === teamId &&
            playerGroupForRound(p, roundIndex) === key
        )
        .map((p) => String(p?.playerId || "").trim())
        .filter(Boolean)
    )
  );
}

function buildTwoManGroupBreakdownTable(par, groups, useHandicap) {
  const parTotal18 = segmentTotal(par, 0, 17);
  const wrap = document.createElement("div");
  wrap.className = "scorecard-one-wrap";

  const summary = document.createElement("div");
  summary.className = "small scorecard-summary";
  const labels = (groups || []).map((g) => {
    const names = Array.isArray(g?.names) && g.names.length ? g.names.join(", ") : "—";
    return `${g?.key || "?"}: ${names}`;
  });
  summary.textContent = labels.length
    ? `Two-man groups • ${labels.join(" • ")}`
    : "Two-man groups • no groups assigned";
  wrap.appendChild(summary);

  if (!Array.isArray(groups) || !groups.length) return wrap;

  const tbl = document.createElement("table");
  tbl.className = "table scorecard-one-table scorecard-team-table";
  const tbody = document.createElement("tbody");

  function addHeaderRow(label, start, end) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<th class="left">${label}</th>` +
      Array.from({ length: end - start + 1 }, (_, k) => `<th>${start + k + 1}</th>`).join("") +
      `<th>Total</th><th>±</th>`;
    tbody.appendChild(tr);
  }

  function addDataRow(label, arr, start, end) {
    const played = sectionPlayedCount(arr, start, end);
    const scoreWeightClass = useHandicap
      ? (String(label).endsWith(" Net") || String(label) === "Net"
        ? "score-emph-net"
        : (String(label).endsWith(" Gross") || String(label) === "Gross"
          ? "score-emph-gross"
          : ""))
      : "";
    const emph = scoreWeightClass ? ` class="${scoreWeightClass}"` : "";
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="left"><b${emph}>${label}</b></td>` +
      Array.from({ length: end - start + 1 }, (_, k) => {
        const i = start + k;
        return holeScoreCell(arr[i], par[i]);
      }).join("") +
      `<td class="mono"><b${emph}>${played ? segmentTotal(arr, start, end) : ""}</b></td>` +
      `<td class="mono"><b${emph}>${played ? toParStrFromDiff(segmentToPar(arr, par, start, end)) : ""}</b></td>`;
    tbody.appendChild(tr);
  }

  function addParRow(start, end) {
    const sectionPar = segmentTotal(par, start, end);
    const parTotalCell = start === 9 ? `${sectionPar} (${parTotal18})` : String(sectionPar);
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="left"><b>Par</b></td>` +
      Array.from({ length: end - start + 1 }, (_, k) => {
        const i = start + k;
        return `<td class="mono">${String(par[i] || 0)}</td>`;
      }).join("") +
      `<td class="mono"><b>${parTotalCell}</b></td>` +
      `<td class="mono"><b>E</b></td>`;
    tbody.appendChild(tr);
  }

  function addSectionSpacer() {
    const tr = document.createElement("tr");
    tr.className = "scorecard-spacer-row";
    tr.innerHTML = `<td colspan="12"></td>`;
    tbody.appendChild(tr);
  }

  function addSection(start, end, label) {
    addHeaderRow(label, start, end);
    for (const group of groups) {
      addDataRow(`${group.key} Gross`, group.gross, start, end);
    }
    if (useHandicap) {
      for (const group of groups) {
        addDataRow(`${group.key} Net`, group.net, start, end);
      }
    }
    addParRow(start, end);
  }

  addSection(0, 8, "Front 9");
  addSectionSpacer();
  addSection(9, 17, "Back 9");

  tbl.appendChild(tbody);
  wrap.appendChild(tbl);
  return wrap;
}

function buildTwoManBestBallTeamScorecard(roundIndex, teamRow, useHandicap) {
  const teamId = String(teamRow?.teamId || "").trim();
  if (!teamId) return null;

  const roundData = TOURN?.score_data?.rounds?.[roundIndex] || {};
  const teamEntry = roundData?.team?.[teamId] || {};
  const groupKeys = twoManGroupKeysForTeam(teamId, roundIndex, teamEntry);
  const nameById = playerNameMap();
  const groups = groupKeys.map((key) => {
    const entry = twoManGroupEntry(teamEntry, key);
    const ids = playerIdsForTwoManGroup(teamId, roundIndex, key, entry?.playerIds);
    return {
      key,
      names: ids.map((id) => nameById.get(id) || id),
      gross: Array.isArray(entry?.gross)
        ? entry.gross
        : bestBallHolesForPlayers(roundData, ids, "gross"),
      net: Array.isArray(entry?.net)
        ? entry.net
        : bestBallHolesForPlayers(roundData, ids, "net")
    };
  });

  const teamGross = Array.isArray(teamEntry?.gross)
    ? teamEntry.gross
    : combineGroupHoleSets(groups.map((g) => g.gross));
  const teamNet = Array.isArray(teamEntry?.net)
    ? teamEntry.net
    : combineGroupHoleSets(groups.map((g) => g.net));

  const anyData =
    hasAnyScore(teamGross) ||
    hasAnyScore(teamNet) ||
    groups.some((g) => hasAnyScore(g.gross) || hasAnyScore(g.net));
  if (!anyData) return null;

  const par = getCoursePars(roundIndex);
  const teamScores = {
    gross: teamGross,
    net: teamNet,
    handicapShots: Array.isArray(teamEntry?.handicapShots) ? teamEntry.handicapShots : Array(18).fill(0),
    par,
    grossTotal: teamEntry?.grossTotal,
    netTotal: teamEntry?.netTotal,
    grossToParTotal: teamEntry?.grossToParTotal,
    netToParTotal: teamEntry?.netToParTotal,
    thru: teamEntry?.thru
  };

  const split = document.createElement("div");
  split.className = "scorecard-split";
  split.appendChild(buildScorecardTable(teamScores, useHandicap));
  split.appendChild(
    buildTwoManGroupBreakdownTable(par, groups, useHandicap)
  );
  return split;
}

function clearInlineScorecardRow() {
  if (openInlineRow && openInlineRow.parentNode) {
    openInlineRow.parentNode.removeChild(openInlineRow);
  }
  openInlineRow = null;
  openInlineKey = null;
}

function rowIdentityKey(data, row) {
  const id = mode === "team" ? row?.teamId : row?.playerId;
  return `${mode}:${String(data.view?.round)}:${id || ""}`;
}

function makeInlineScorecardHost(anchorRow, colCount) {
  const detailRow = document.createElement("tr");
  detailRow.className = "scorecard-inline-row";

  const td = document.createElement("td");
  td.colSpan = colCount;
  td.style.padding = "0";
  td.style.overflow = "hidden";

  const host = document.createElement("div");
  host.className = "card inline-scorecard-host";
  host.style.margin = "0";
  host.style.boxShadow = "none";
  host.style.padding = "0";
  host.style.overflow = "hidden";
  host.style.maxWidth = "100%";

  td.appendChild(host);
  detailRow.appendChild(td);
  anchorRow.parentNode.insertBefore(detailRow, anchorRow.nextSibling);

  return { detailRow, host };
}

async function getScorecardScores(data, row) {
  if (data.view?.round === "all") return null;

  function hasHoleArrays(scores) {
    return Array.isArray(scores?.gross) || Array.isArray(scores?.net);
  }

  const rIdx = Number(data.view.round);

  function normalizeScorecard(scores, par = getCoursePars(rIdx)) {
    const gross = Array.isArray(scores?.gross) ? scores.gross : Array(18).fill(null);
    const net = Array.isArray(scores?.net) ? scores.net : gross.slice();
    return {
      gross,
      net,
      handicapShots: Array.isArray(scores?.handicapShots) ? scores.handicapShots : Array(18).fill(0),
      par,
      grossTotal: scores?.grossTotal,
      netTotal: scores?.netTotal,
      grossToParTotal: scores?.grossToParTotal,
      netToParTotal: scores?.netToParTotal,
      thru: scores?.thru
    };
  }

  function fromRoundData(roundIdx) {
    const roundData = TOURN?.score_data?.rounds?.[roundIdx];
    if (!roundData) return null;
    const source = mode === "team"
      ? roundData?.team?.[row?.teamId]
      : roundData?.player?.[row?.playerId];
    if (!source) return null;
    if (!hasHoleArrays(source)) return null;
    return normalizeScorecard(source, getCoursePars(roundIdx));
  }

  if (hasHoleArrays(row?.scores)) return normalizeScorecard(row.scores, getCoursePars(rIdx));
  const fromRound = fromRoundData(rIdx);
  if (fromRound) return fromRound;

  const modeQ = mode === "team" ? "team" : "player";
  const idQ = mode === "team" ? row.teamId : row.playerId;
  const sc = await api(
    `/tournaments/${encodeURIComponent(tid)}/scorecard?round=${rIdx}&mode=${modeQ}&id=${encodeURIComponent(idQ)}`
  );

  return normalizeScorecard(
    {
      gross: sc.grossHoles,
      net: sc.netHoles,
      handicapShots: sc.handicapShots,
      grossTotal: sc.grossTotal,
      netTotal: sc.netTotal,
      grossToParTotal: sc.toParGrossTotal,
      netToParTotal: sc.toParNetTotal,
      thru: sc.thru
    },
    sc.course?.pars || getCoursePars(rIdx)
  );
}

function inlineScorecardHeading(host, title, subtitle) {
  host.innerHTML = "";
  const meta = document.createElement("div");
  meta.className = "inline-scorecard-meta";

  const h = document.createElement("h3");
  h.style.margin = "0 0 4px 0";
  h.textContent = title;
  meta.appendChild(h);

  const sub = document.createElement("div");
  sub.className = "small";
  sub.textContent = subtitle;
  meta.appendChild(sub);
  host.appendChild(meta);
}

function renderLeaderboard(data) {
  const isTeam = mode === "team";
  const isAllRounds = data.view?.round === "all";
  const isTwoManGroupView = !isTeam && !isAllRounds && isTwoManBestBallRound(data.view?.round);
  const allowInlineScorecard = data.view?.round !== "all";
  const showGrossNet = isHandicapRound(data.view?.round) || isAllRounds;
  const showStrokesColumn = isTeam && isAllRounds;
  lbTitle.textContent = isTeam ? "Teams" : isTwoManGroupView ? "Groups" : "Individuals";
  rebuildTeamColors();

  const head = document.getElementById("lb_head");
  const prevSortKey = sortState?.key || "score";
  const defaultSortKey = showGrossNet ? "net" : "toPar";
  const allowedSortKeys = isAllRounds
    ? new Set(showStrokesColumn ? ["name", "net", "netStrokes", "score"] : ["name", "net", "score"])
    : showGrossNet
      ? new Set(["name", "thru", "gross", "net", "score"])
      : new Set(["name", "toPar", "thru", "score"]);
  if (!allowedSortKeys.has(prevSortKey)) sortState = { key: defaultSortKey, dir: "asc" };
  if (sortState.key === "score") sortState = { key: defaultSortKey, dir: "asc" };

  function headBtn(label, key, left = false) {
    return `<button type="button" class="sort-head-btn ${left ? "left" : ""}" data-sort-key="${key}">${label}</button>`;
  }
  const nameHeading = isTeam ? "Team" : isTwoManGroupView ? "Group" : "Player";

  if (showGrossNet && isAllRounds) {
    head.innerHTML = `
      <th class="rank-col"></th>
      <th class="left name-col">${headBtn(nameHeading, "name", true)}</th>
      <th class="metric-col">${headBtn("Net", "net")}</th>
      ${showStrokesColumn ? `<th class="metric-col">${headBtn("Net<br/>Strokes", "netStrokes")}</th>` : ""}
    `;
  } else if (showGrossNet) {
    head.innerHTML = `
      <th class="rank-col"></th>
      <th class="left name-col">${headBtn(nameHeading, "name", true)}</th>
      <th class="metric-col">${headBtn('<span class="score-emph-gross">Gross ±</span>', "gross")}</th>
      <th class="metric-col">${headBtn('<span class="score-emph-net">Net ±</span>', "net")}</th>
      <th class="thru-col">${headBtn("Thru", "thru")}</th>
    `;
  } else {
    head.innerHTML = `
      <th class="rank-col"></th>
      <th class="left name-col">${headBtn(nameHeading, "name", true)}</th>
      <th class="metric-col">${headBtn("±", "toPar")}</th>
      <th class="thru-col">${headBtn("Thru", "thru")}</th>
    `;
  }

  const tbody = lbTbl.querySelector("tbody");
  const reopenKey = openInlineKey;
  tbody.innerHTML = "";
  clearInlineScorecardRow();

  const rows = isTeam ? data.teams || [] : data.players || [];
  const standingRanks = buildStandingRankMap(rows, showGrossNet, data, isTeam);
  function hasPostedScores(row) {
    if (Number(row?.thru || 0) > 0) return true;
    if (Number(row?.strokes || 0) > 0) return true;
    if (Number(row?.grossTotal || 0) > 0) return true;
    if (Number(row?.netTotal || 0) > 0) return true;
    if (showGrossNet) {
      if (Number(grossForRow(row) || 0) > 0) return true;
      if (Number(netForRow(row) || 0) > 0) return true;
    }
    return false;
  }

  const sortedRows = rows
    .map((row) => ({ row, hasData: hasPostedScores(row) }))
    .sort((a, b) => {
      if (a.hasData !== b.hasData) return a.hasData ? -1 : 1;
      return compareRows(a.row, b.row, sortState.key, sortState.dir, showGrossNet, data, isTeam);
    });

  const colCount = leaderboardColCount(data);
  const rowByKey = new Map();
  head.querySelectorAll("button[data-sort-key]").forEach((btn) => {
    btn.onclick = () => {
      const key = btn.dataset.sortKey;
      if (!key) return;
      if (sortState.key === key) {
        sortState = { key, dir: sortState.dir === "asc" ? "desc" : "asc" };
      } else {
        sortState = { key, dir: "asc" };
      }
      render();
    };
  });

  const displayedRanks = new Set();
  sortedRows.forEach(({ row: r, hasData }) => {
    const tr = document.createElement("tr");
    tr.className = allowInlineScorecard ? "clickable" : "";
    tr.dataset.id = isTeam ? r.teamId : r.playerId;
    const rowKey = rowIdentityKey(data, r);
    if (recentUpdatedRowKeys.has(rowKey)) tr.classList.add("row-updated");
    const rid = rowStableId(r, isTeam);
    const standingRank = standingRanks.get(rid);
    const rankCellValue =
      standingRank == null || displayedRanks.has(standingRank) ? "" : `${standingRank}`;
    if (standingRank != null) displayedRanks.add(standingRank);
    const teamColor = colorForTeam(r.teamId, r.teamName);

    const nameCell = `
      <td class="left name-col">
        <div class="${isTeam ? "team-accent" : ""}" style="--team-accent:${teamColor};"><b>${isTeam ? r.teamName : r.name}</b></div>
        ${!isTeam && r.teamName ? `<div class="small muted team-accent team-accent-sub" style="--team-accent:${teamColor};">${r.teamName}</div>` : ""}
      </td>
    `;
    const shouldShowTeeTime = !hasData && r?.teeTime && (!isTeam || isScrambleRound(data.view?.round));
    const thruCell = shouldShowTeeTime ? r.teeTime : displayThru(r.thru);

    if (showGrossNet && isAllRounds) {
      tr.innerHTML = `
        <td class="mono rank-col">${rankCellValue}</td>
        ${nameCell}
        <td class="mono metric-col"><b>${netToParForRow(r, data)}</b></td>
        ${showStrokesColumn ? `<td class="mono metric-col">${scoreValue(netStrokesForRow(r))}</td>` : ""}
      `;
    } else if (showGrossNet) {
      tr.innerHTML = `
        <td class="mono rank-col">${rankCellValue}</td>
        ${nameCell}
        <td class="mono metric-col"><b class="score-emph-gross">${grossToParForRow(r, data)}</b></td>
        <td class="mono metric-col"><b class="score-emph-net">${netToParForRow(r, data)}</b></td>
        <td class="mono thru-col">${thruCell}</td>
      `;
    } else {
      tr.innerHTML = `
        <td class="mono rank-col">${rankCellValue}</td>
        ${nameCell}
        <td class="mono metric-col"><b>${r.toPar ?? "E"}</b></td>
        <td class="mono thru-col">${thruCell}</td>
      `;
    }

    if (allowInlineScorecard) tr.onclick = async () => {
      const key = rowIdentityKey(data, r);
      if (openInlineKey === key) {
        clearInlineScorecardRow();
        return;
      }

      clearInlineScorecardRow();
      const { detailRow, host } = makeInlineScorecardHost(tr, colCount);
      openInlineKey = key;
      openInlineRow = detailRow;

      if (data.view?.round === "all") {
        inlineScorecardHeading(host, "Scorecard", "Pick a specific round to view hole-by-hole scorecards.");
        return;
      }

      const rIdx = Number(data.view.round);
      const title = isTeam ? (r.teamName || "Team") : (r.name || "Player");
      const subtitle = isTeam
        ? `Round ${rIdx + 1}`
        : `${r.teamName || ""} • Round ${rIdx + 1}`;

      inlineScorecardHeading(host, title, subtitle);
      const loading = document.createElement("div");
      loading.className = "small";
      loading.style.marginTop = "8px";
      loading.textContent = "Loading scorecard…";
      host.appendChild(loading);

      const token = ++inlineReqToken;
      try {
        if (mode === "team" && !isScrambleRound(data.view?.round)) {
          const teamTable = isTwoManBestBallRound(data.view?.round)
            ? buildTwoManBestBallTeamScorecard(rIdx, r, showGrossNet)
            : buildTeamMembersScorecard(rIdx, r, showGrossNet);
          if (token !== inlineReqToken || openInlineKey !== key) return;
          if (teamTable) {
            loading.remove();
            const grid = document.createElement("div");
            grid.className = "scoregrid inline-scoregrid";
            grid.style.marginTop = "0";
            grid.appendChild(teamTable);
            host.appendChild(grid);
            return;
          }
        }

        const scores = await getScorecardScores(data, r);
        if (token !== inlineReqToken || openInlineKey !== key) return;

        loading.remove();
        if (!scores) {
          const msg = document.createElement("div");
          msg.className = "small";
          msg.textContent = "No scorecard data available.";
          host.appendChild(msg);
          return;
        }

        const grid = document.createElement("div");
        grid.className = "scoregrid inline-scoregrid";
        grid.style.marginTop = "0";
        grid.appendChild(buildScorecardTable(scores, showGrossNet));
        host.appendChild(grid);
      } catch (e) {
        if (token !== inlineReqToken || openInlineKey !== key) return;
        loading.textContent = e.message || String(e);
      }
    };

    rowByKey.set(rowKey, tr);
    tbody.appendChild(tr);
  });

  if (reopenKey && rowByKey.has(reopenKey)) {
    const reopenRow = rowByKey.get(reopenKey);
    if (reopenRow) reopenRow.click();
  }
}

function viewRoundLabel(viewRound) {
  return viewRound === "all" ? "All rounds" : `Round ${Number(viewRound) + 1}`;
}

function normalizeTeamId(teamId) {
  return teamId == null ? "" : String(teamId).trim();
}

function roundAggregationConfig(roundCfg) {
  const agg = roundCfg?.teamAggregation || {};
  const rawTopX = Number(agg.topX);
  const topX = Math.max(1, Math.min(4, Number.isFinite(rawTopX) ? Math.floor(rawTopX) : 4));
  return { topX };
}

function asPlayedNumber(v) {
  if (!isPlayedScore(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function aggregateNumbers(values) {
  if (!values.length) return null;
  const total = values.reduce((a, v) => a + Number(v || 0), 0);
  return total;
}

function roundTeamNameLookup(tournamentJson, leaderboardRows = []) {
  const out = new Map();
  (tournamentJson?.teams || []).forEach((t) => {
    const id = normalizeTeamId(t?.teamId ?? t?.id);
    if (!id) return;
    out.set(id, String(t?.teamName ?? t?.name ?? id));
  });
  (tournamentJson?.players || []).forEach((p) => {
    const id = normalizeTeamId(p?.teamId);
    if (!id || out.has(id)) return;
    out.set(id, String(p?.teamName || id));
  });
  (leaderboardRows || []).forEach((row) => {
    const id = normalizeTeamId(row?.teamId);
    if (!id || out.has(id)) return;
    out.set(id, String(row?.teamName || id));
  });
  return out;
}

function buildTeamRowsFromTeamEntries(roundData, coursePars, useHandicap, teamNames, seedTeamIds = []) {
  const byTeam = roundData?.team || {};
  const teamIds = new Set(seedTeamIds.map((id) => normalizeTeamId(id)).filter(Boolean));
  Object.keys(byTeam).forEach((id) => teamIds.add(normalizeTeamId(id)));

  const rows = [];
  for (const teamId of teamIds) {
    const entry = byTeam[teamId] || {};
    const gross = Array.isArray(entry?.gross) ? entry.gross : Array(18).fill(null);
    const net = Array.isArray(entry?.net) ? entry.net : gross.slice();
    const handicapShots = Array.isArray(entry?.handicapShots) ? entry.handicapShots : Array(18).fill(0);
    let thru = 0;
    let grossToParTotal = 0;
    let netToParTotal = 0;
    for (let i = 0; i < 18; i++) {
      const grossV = asPlayedNumber(gross[i]);
      const netV = asPlayedNumber(net[i]);
      const par = Number(coursePars?.[i] || 0);
      if (grossV != null || netV != null) thru += 1;
      if (grossV != null) grossToParTotal += grossV - par;
      if (netV != null) netToParTotal += netV - par;
    }

    const grossTotal = sumHoles(gross);
    const netTotal = sumHoles(net);
    rows.push({
      teamId,
      teamName: teamNames.get(teamId) || teamId || "Team",
      thru,
      gross: grossTotal,
      net: netTotal,
      strokes: useHandicap ? netTotal : grossTotal,
      toPar: useHandicap ? netToParTotal : grossToParTotal,
      toParGross: grossToParTotal,
      toParNet: netToParTotal,
      scores: {
        gross,
        net,
        handicapShots,
        grossTotal,
        netTotal,
        grossToParTotal,
        netToParTotal,
        thru
      }
    });
  }
  return rows;
}

function buildAggregatedTeamRowsFromPlayers(tournamentJson, roundIndex, roundData, coursePars, leaderboardRows = []) {
  const roundCfg = (tournamentJson?.tournament?.rounds || [])[roundIndex] || {};
  const useHandicap = !!roundCfg.useHandicap;
  const { topX } = roundAggregationConfig(roundCfg);
  const playerById = roundData?.player || {};
  const playerMetaById = new Map();
  (tournamentJson?.players || []).forEach((p) => {
    const byPlayerId = String(p?.playerId || "").trim();
    const byId = String(p?.id || "").trim();
    if (byPlayerId) playerMetaById.set(byPlayerId, p || {});
    if (byId) playerMetaById.set(byId, p || {});
  });
  const teamNames = roundTeamNameLookup(tournamentJson, roundData?.leaderboard?.teams || []);

  const seedTeamIds = new Set();
  (tournamentJson?.teams || []).forEach((t) => seedTeamIds.add(normalizeTeamId(t?.teamId ?? t?.id)));
  (tournamentJson?.players || []).forEach((p) => seedTeamIds.add(normalizeTeamId(p?.teamId)));
  (leaderboardRows || []).forEach((row) => seedTeamIds.add(normalizeTeamId(row?.teamId)));

  const playersByTeam = new Map();
  for (const [playerId, entry] of Object.entries(playerById)) {
    const meta = playerMetaById.get(String(playerId || "")) || {};
    const teamId = normalizeTeamId(meta?.teamId);
    if (!teamId) continue;
    if (!playersByTeam.has(teamId)) playersByTeam.set(teamId, []);
    playersByTeam.get(teamId).push({
      playerId,
      gross: Array.isArray(entry?.gross) ? entry.gross : Array(18).fill(null),
      net: Array.isArray(entry?.net) ? entry.net : null
    });
    seedTeamIds.add(teamId);
  }

  const rows = [];
  for (const teamId of seedTeamIds) {
    if (!teamId) continue;
    const teamPlayers = playersByTeam.get(teamId) || [];
    const grossHoles = Array(18).fill(null);
    const netHoles = Array(18).fill(null);
    const selectedCountByHole = Array(18).fill(0);

    for (let i = 0; i < 18; i++) {
      const candidates = [];
      for (const p of teamPlayers) {
        const grossScore = asPlayedNumber(p.gross?.[i]);
        const netRaw = asPlayedNumber(p.net?.[i]);
        const netScore = netRaw != null ? netRaw : grossScore;
        const metricScore = useHandicap ? netScore : grossScore;
        if (metricScore == null) continue;
        candidates.push({ gross: grossScore, net: netScore, metric: metricScore });
      }
      if (!candidates.length) continue;
      candidates.sort((a, b) => a.metric - b.metric);
      const picked = candidates.slice(0, topX);
      selectedCountByHole[i] = picked.length;

      const grossValues = picked.map((x) => x.gross).filter((v) => v != null);
      const netValues = picked.map((x) => x.net).filter((v) => v != null);
      const grossAgg = aggregateNumbers(grossValues);
      const netAgg = aggregateNumbers(netValues);
      if (grossAgg != null) grossHoles[i] = grossAgg;
      if (netAgg != null) netHoles[i] = netAgg;
    }

    const thru = selectedCountByHole.reduce((a, count) => a + (count > 0 ? 1 : 0), 0);
    const grossTotal = sumHoles(grossHoles);
    const netTotal = sumHoles(netHoles);

    let grossToParTotal = 0;
    let netToParTotal = 0;
    for (let i = 0; i < 18; i++) {
      const count = selectedCountByHole[i];
      if (!count) continue;
      const parBase = Number(coursePars?.[i] || 0) * count;
      const grossV = grossHoles[i];
      const netV = netHoles[i];
      if (grossV != null) grossToParTotal += Number(grossV) - parBase;
      if (netV != null) netToParTotal += Number(netV) - parBase;
    }

    rows.push({
      teamId,
      teamName: teamNames.get(teamId) || teamId || "Team",
      thru,
      gross: grossTotal,
      net: netTotal,
      strokes: useHandicap ? netTotal : grossTotal,
      toPar: useHandicap ? netToParTotal : grossToParTotal,
      toParGross: grossToParTotal,
      toParNet: netToParTotal,
      scores: {
        gross: grossHoles,
        net: netHoles,
        grossTotal,
        netTotal,
        grossToParTotal,
        netToParTotal,
        thru
      }
    });
  }

  return rows;
}

function buildRoundTeamRows(tournamentJson, roundIndex, roundData, coursePars, leaderboardRows = []) {
  const roundCfg = (tournamentJson?.tournament?.rounds || [])[roundIndex] || {};
  const format = String(roundCfg.format || "").toLowerCase();
  const useHandicap = !!roundCfg.useHandicap;
  const teamNames = roundTeamNameLookup(tournamentJson, leaderboardRows);
  const seedTeamIds = (leaderboardRows || []).map((row) => row?.teamId);
  const fallbackRows = leaderboardRows || [];

  if (format === "scramble" || format === "two_man" || format === "two_man_best_ball") {
    const fromTeamEntries = buildTeamRowsFromTeamEntries(roundData, coursePars, useHandicap, teamNames, seedTeamIds);
    if (fromTeamEntries.some((row) => rowHasAnyData(row))) return fromTeamEntries;
    if (fallbackRows.length) return fallbackRows;
    return fromTeamEntries;
  }

  if (fallbackRows.some((row) => rowHasAnyData(row))) return fallbackRows;

  const aggregated = buildAggregatedTeamRowsFromPlayers(
    tournamentJson,
    roundIndex,
    roundData,
    coursePars,
    leaderboardRows
  );
  if (aggregated.some((row) => rowHasAnyData(row))) return aggregated;
  if (fallbackRows.length) return fallbackRows;
  return aggregated;
}

function buildRoundPlayerRows(tournamentJson, roundIndex, roundData, coursePars) {
  const roundCfg = (tournamentJson?.tournament?.rounds || [])[roundIndex] || {};
  const format = String(roundCfg.format || "").toLowerCase();
  const isTwoManRound = format === "two_man" || format === "two_man_best_ball";
  const useHandicap = !!roundCfg.useHandicap;
  const teamNames = roundTeamNameLookup(tournamentJson, roundData?.leaderboard?.teams || []);
  const playersById = playerMetaByIdMap();

  const attachPlayerMeta = (row) => {
    const playerId = String(row?.playerId || "").trim();
    const meta = playersById.get(playerId) || {};
    const teamId = normalizeTeamId(row?.teamId || meta?.teamId);
    return {
      ...row,
      playerId,
      teamId,
      teamName: row?.teamName || teamNames.get(teamId) || meta?.teamName || teamId || "",
      teeTime: row?.teeTime || teeTimeForPlayerRound(meta, roundIndex)
    };
  };

  if (!isTwoManRound) {
    return (roundData?.leaderboard?.players || []).map(attachPlayerMeta);
  }

  const seedTeamIds = new Set();
  (tournamentJson?.teams || []).forEach((t) => seedTeamIds.add(normalizeTeamId(t?.teamId ?? t?.id)));
  (tournamentJson?.players || []).forEach((p) => seedTeamIds.add(normalizeTeamId(p?.teamId)));
  Object.keys(roundData?.team || {}).forEach((id) => seedTeamIds.add(normalizeTeamId(id)));

  const rows = [];
  for (const teamId of Array.from(seedTeamIds).filter(Boolean).sort((a, b) => a.localeCompare(b))) {
    const teamEntry = roundData?.team?.[teamId] || {};
    const groupKeys = twoManGroupKeysForTeam(teamId, roundIndex, teamEntry);
    for (const key of groupKeys) {
      const entry = twoManGroupEntry(teamEntry, key);
      const playerIds = playerIdsForTwoManGroup(teamId, roundIndex, key, entry?.playerIds);
      const gross = Array.isArray(entry?.gross)
        ? entry.gross
        : bestBallHolesForPlayers(roundData, playerIds, "gross");
      const net = Array.isArray(entry?.net)
        ? entry.net
        : bestBallHolesForPlayers(roundData, playerIds, "net");

      let thru = 0;
      let grossToParTotal = 0;
      let netToParTotal = 0;
      for (let i = 0; i < 18; i++) {
        const grossV = asPlayedNumber(gross[i]);
        const netV = asPlayedNumber(net[i]);
        const par = Number(coursePars?.[i] || 0);
        if (grossV != null || netV != null) thru += 1;
        if (grossV != null) grossToParTotal += grossV - par;
        if (netV != null) netToParTotal += netV - par;
      }

      const grossTotal = sumHoles(gross);
      const netTotal = sumHoles(net);
      rows.push({
        playerId: `group:${teamId}:${key}`,
        groupId: `${teamId}::${key}`,
        groupKey: key,
        name: `Group ${key}`,
        teamId,
        teamName: teamNames.get(teamId) || teamId || "Team",
        thru,
        gross: grossTotal,
        net: netTotal,
        strokes: useHandicap ? netTotal : grossTotal,
        toPar: useHandicap ? netToParTotal : grossToParTotal,
        toParGross: grossToParTotal,
        toParNet: netToParTotal,
        teeTime: teeTimeForPlayerIds(playerIds, roundIndex) || teeTimeForTeamRound(teamId, roundIndex),
        scores: {
          gross,
          net,
          handicapShots: Array.isArray(entry?.handicapShots) ? entry.handicapShots : Array(18).fill(0),
          grossTotal,
          netTotal,
          grossToParTotal,
          netToParTotal,
          thru
        }
      });
    }
  }

  if (rows.length) return rows;
  return (roundData?.leaderboard?.players || []).map(attachPlayerMeta);
}

function statRowsFromRound(roundData, isTeamMode, roundIndex) {
  if (!roundData) return [];
  const roundPars = courseForRoundIndex(roundIndex, TOURN).pars || Array(18).fill(4);
  let source;
  if (isTeamMode) {
    const primary = roundData.team || {};
    if (Object.keys(primary).length) {
      source = primary;
    } else {
      const derivedRows = buildRoundTeamRows(
        TOURN,
        roundIndex,
        roundData,
        roundPars,
        roundData?.leaderboard?.teams || []
      );
      source = Object.fromEntries(
        derivedRows.map((row) => [row.teamId, { gross: row?.scores?.gross || Array(18).fill(null) }])
      );
    }
  } else {
    const primary = roundData.player || {};
    const fallback = !Object.keys(primary).length ? (roundData.team || {}) : null;
    source = fallback || primary;
  }
  const rows = [];

  for (const [id, entry] of Object.entries(source)) {
    rows.push({
      id,
      par: roundPars,
      gross: Array.isArray(entry?.gross) ? entry.gross : Array(18).fill(null)
    });
  }
  return rows;
}

function renderStats(data) {
  if (!statsMeta || !statsKpis || !statsHoleTbl) return;

  const isTeamMode = mode === "team";
  const roundView = data?.view?.round;
  const rounds = TOURN?.score_data?.rounds || [];
  const par = Array.isArray(data?.course?.pars) ? data.course.pars : getCoursePars(roundView);
  const statRows =
    roundView === "all"
      ? rounds.flatMap((rd, idx) => statRowsFromRound(rd, isTeamMode, idx))
      : statRowsFromRound(rounds[Number(roundView)], isTeamMode, Number(roundView));

  const holeTotals = Array(18).fill(0);
  const holeCounts = Array(18).fill(0);
  const holeParTotals = Array(18).fill(0);
  const holeParCounts = Array(18).fill(0);
  let holesPlayed = 0;
  let cardsWithScores = 0;
  let totalDiff = 0;
  let eaglePlus = 0;
  let birdies = 0;
  let parsCount = 0;
  let bogeys = 0;
  let doublePlus = 0;

  for (const row of statRows) {
    if (hasAnyScore(row.gross)) cardsWithScores++;
    const rowPar = Array.isArray(row?.par) && row.par.length === 18 ? row.par : par;
    for (let i = 0; i < 18; i++) {
      const v = row.gross?.[i];
      if (!isPlayedScore(v)) continue;
      const score = Number(v);
      const p = Number(rowPar[i] || 0);
      const diff = score - p;

      holeTotals[i] += score;
      holeCounts[i] += 1;
      if (Number.isFinite(p) && p > 0) {
        holeParTotals[i] += p;
        holeParCounts[i] += 1;
      }
      holesPlayed += 1;
      totalDiff += diff;

      if (diff <= -2) eaglePlus++;
      else if (diff === -1) birdies++;
      else if (diff === 0) parsCount++;
      else if (diff === 1) bogeys++;
      else if (diff >= 2) doublePlus++;
    }
  }

  statsMeta.textContent = `${viewRoundLabel(roundView)} • ${isTeamMode ? "Teams" : "Players"} with scores: ${cardsWithScores} • Holes recorded: ${holesPlayed}`;

  const avgToPar = holesPlayed ? totalDiff / holesPlayed : 0;
  statsKpis.innerHTML = `
    <div class="stats-kpi"><span class="small">Eagle+</span><b>${eaglePlus}</b></div>
    <div class="stats-kpi"><span class="small">Birdies</span><b>${birdies}</b></div>
    <div class="stats-kpi"><span class="small">Pars</span><b>${parsCount}</b></div>
    <div class="stats-kpi"><span class="small">Bogeys</span><b>${bogeys}</b></div>
    <div class="stats-kpi"><span class="small">Double+</span><b>${doublePlus}</b></div>
    <div class="stats-kpi"><span class="small">Avg ± / hole</span><b>${holesPlayed ? toParStrFromDecimal(avgToPar) : "—"}</b></div>
  `;

  if (!holesPlayed) {
    statsHoleTbl.innerHTML = `<tbody><tr><td class="left small">No hole-by-hole scores posted yet for this view.</td></tr></tbody>`;
    return;
  }

  function headerRow(label, start, end) {
    return (
      `<tr>` +
      `<th class="left">${label}</th>` +
      Array.from({ length: end - start + 1 }, (_, k) => `<th>${start + k + 1}</th>`).join("") +
      `</tr>`
    );
  }

  function valueRow(label, start, end, getCell) {
    return (
      `<tr>` +
      `<td class="left"><b>${label}</b></td>` +
      Array.from({ length: end - start + 1 }, (_, k) => `<td class="mono">${getCell(start + k)}</td>`).join("") +
      `</tr>`
    );
  }

  const front = `
    ${headerRow("Front 9", 0, 8)}
    ${valueRow("Avg", 0, 8, (i) => (holeCounts[i] ? formatDecimal(holeTotals[i] / holeCounts[i]) : "—"))}
    ${valueRow("±", 0, 8, (i) => (holeCounts[i]
      ? toParStrFromDecimal(
        (holeTotals[i] / holeCounts[i]) -
        (holeParCounts[i] ? (holeParTotals[i] / holeParCounts[i]) : Number(par[i] || 0))
      )
      : "—"))}
    ${valueRow("N", 0, 8, (i) => String(holeCounts[i]))}
  `;
  const back = `
    ${headerRow("Back 9", 9, 17)}
    ${valueRow("Avg", 9, 17, (i) => (holeCounts[i] ? formatDecimal(holeTotals[i] / holeCounts[i]) : "—"))}
    ${valueRow("±", 9, 17, (i) => (holeCounts[i]
      ? toParStrFromDecimal(
        (holeTotals[i] / holeCounts[i]) -
        (holeParCounts[i] ? (holeParTotals[i] / holeParCounts[i]) : Number(par[i] || 0))
      )
      : "—"))}
    ${valueRow("N", 9, 17, (i) => String(holeCounts[i]))}
  `;

  statsHoleTbl.innerHTML = `<tbody>${front}<tr class="scorecard-spacer-row"><td colspan="10"></td></tr>${back}</tbody>`;
}

function buildScoreboardResponse(tournamentJson, viewRound) {
  const courses = courseListFromTournament(tournamentJson);
  const allRoundsCourse = courses[0] || defaultCourse();

  if (viewRound === "all") {
    return {
      tournament: tournamentJson.tournament,
      view: { round: "all" },
      course: {
        parTotal: allRoundsCourse.pars.reduce((a, b) => a + Number(b || 0), 0),
        pars: allRoundsCourse.pars,
        strokeIndex: allRoundsCourse.strokeIndex
      },
      teams: tournamentJson.score_data?.leaderboard_all?.teams || [],
      players: tournamentJson.score_data?.leaderboard_all?.players || []
    };
  }

  const rIdx = Number(viewRound);
  const roundCourse = courseForRoundIndex(rIdx, tournamentJson);
  const derived = tournamentJson.score_data?.rounds?.[rIdx];
  const derivedTeams = buildRoundTeamRows(
    tournamentJson,
    rIdx,
    derived || {},
    roundCourse.pars,
    derived?.leaderboard?.teams || []
  );
  const derivedPlayers = buildRoundPlayerRows(tournamentJson, rIdx, derived || {}, roundCourse.pars);
  return {
    tournament: tournamentJson.tournament,
    view: { round: rIdx },
    course: {
      parTotal: roundCourse.pars.reduce((a, b) => a + Number(b || 0), 0),
      pars: roundCourse.pars,
      strokeIndex: roundCourse.strokeIndex
    },
    teams: derivedTeams.map((row) => ({
      ...row,
      teeTime: row?.teeTime || teeTimeForTeamRound(row?.teamId, rIdx)
    })),
    players: derivedPlayers
  };
}

async function loadTournament() {
  try {
    return await staticJson(`/tournaments/${encodeURIComponent(tid)}.json`, {
      cacheKey: `tourn:${tid}`
    });
  } catch (_) {
    const legacy = await api(`/tournaments/${encodeURIComponent(tid)}/scoreboard?round=all`);
    return {
      tournament: legacy.tournament,
      course: legacy.course,
      score_data: {
        leaderboard_all: {
          teams: legacy.teams || [],
          players: legacy.players || []
        },
        rounds: []
      }
    };
  }
}

function syncRoundFilterOptions() {
  const previous = currentRound;
  roundFilter.innerHTML = `<option value="all">All rounds (weighted)</option>`;
  (TOURN?.tournament?.rounds || []).forEach((r, idx) => {
    roundFilter.innerHTML += `<option value="${idx}">Round ${idx + 1}: ${r.name || `Round ${idx + 1}`}</option>`;
  });

  const roundCount = (TOURN?.tournament?.rounds || []).length;
  if (roundCount <= 0) {
    currentRound = "all";
  } else if (previous === "all") {
    currentRound = "all";
  } else if (Number(previous) >= 0 && Number(previous) < roundCount) {
    currentRound = Number(previous);
  } else {
    currentRound = newestRoundWithDataIndex(TOURN);
  }

  roundFilter.value = String(currentRound);
}

async function refreshTournamentData() {
  if (refreshInFlight || !tid) return;
  refreshInFlight = true;
  try {
    const previousTournament = TOURN;
    const nextTournament = await loadTournament();
    const newEvents = collectNewScoreEvents(previousTournament, nextTournament);
    TOURN = nextTournament;
    teamColorsSeeded = false;
    rebuildTeamColors();
    setRecentUpdatedRowsFromEvents(newEvents);
    syncRoundFilterOptions();
    render();
    if (newEvents.length) showScoreNotifier(newEvents);
  } catch (e) {
    console.error("Scoreboard auto-refresh failed:", e);
  } finally {
    refreshInFlight = false;
  }
}

function startAutoRefresh() {
  if (refreshTimerId) clearInterval(refreshTimerId);
  refreshTimerId = setInterval(() => {
    refreshTournamentData();
  }, AUTO_REFRESH_MS);
}

function render() {
  if (!TOURN) return;
  setHeaderTournamentName(TOURN?.tournament?.name);
  const weightedLeader = weightedTeamLeaderRow();
  if (weightedLeader) {
    setBrandDotColor(colorForTeam(weightedLeader?.teamId, weightedLeader?.teamName));
  } else {
    setBrandDotColor(null);
  }
  applyModeConstraints(currentRound);
  const data = buildScoreboardResponse(TOURN, currentRound);

  const rLabel = viewRoundLabel(data.view.round);
  const handicapInfo = isHandicapRound(data.view.round)
    ? " • leaderboard shows gross + net, scorecards show both"
    : "";
  const scrambleInfo = isScrambleRound(data.view.round)
    ? " • scramble rounds are team-only"
    : "";
  const twoManInfo = isTwoManBestBallRound(data.view.round)
    ? " • two-man scorecard includes group breakdown"
    : "";
  const allRoundsInfo =
    data.view.round === "all" && tournamentHasAnyScrambleRound()
      ? " • all rounds view is team-only (scramble in tournament)"
      : "";
  toggleNote.textContent = `${rLabel}${handicapInfo}${scrambleInfo}${twoManInfo}${allRoundsInfo}`;

  renderLeaderboard(data);
  renderStats(data);

  const ts = TOURN.updatedAt ? new Date(TOURN.updatedAt).toLocaleString() : "—";
  updated.textContent = `Updated: ${ts}`;

  raw.textContent = "";
}

btnTeam.onclick = () => {
  mode = "team";
  syncModeButtons();
  render();
};

btnPlayer.onclick = () => {
  if (isScrambleRound(currentRound)) {
    mode = "team";
    syncModeButtons();
    render();
    return;
  }
  mode = "player";
  syncModeButtons();
  render();
};

roundFilter.onchange = () => {
  const v = roundFilter.value;
  const nextRound = v === "all" ? "all" : Number(v);
  const switchedRounds = String(nextRound) !== String(currentRound);
  currentRound = nextRound;
  if (switchedRounds && isIndividualDefaultRound(currentRound) && !isScrambleRound(currentRound)) {
    mode = "player";
  }
  render();
};

(async function init() {
  if (!tid) {
    status.textContent =
      "Missing tournament id. Open with ?t=... or create/open a tournament first.";
    return;
  }

  if (scorecardCard) scorecardCard.style.display = "none";

  status.textContent = "Loading…";
  try {
    TOURN = await loadTournament();
    rememberTournamentId(tid);
    teamColorsSeeded = false;
    rebuildTeamColors();
    $('body').show();

    const roundCount = (TOURN.tournament.rounds || []).length;
    currentRound = roundCount > 0 ? newestRoundWithDataIndex(TOURN) : "all";
    syncRoundFilterOptions();

    status.textContent = "";
    render();
    startAutoRefresh();
  } catch (e) {
    console.error(e);
    status.textContent = e.message || String(e);
  }
})();
