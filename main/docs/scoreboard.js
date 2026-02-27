import {
  api,
  staticJson,
  qs,
  dotsForStrokes,
  createTeamColorRegistry,
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
const AUTO_REFRESH_MS = 30000;
let refreshTimerId = null;
let refreshInFlight = false;
let scoreNotifierTimerId = 0;
let scoreNotifierQueue = [];
let scoreNotifierActive = false;
const SCORE_NOTIFIER_SHOW_MS = 2300;
const SCORE_NOTIFIER_GAP_MS = 200;
const teamColors = createTeamColorRegistry();

function syncModeButtons() {
  btnTeam.classList.toggle("active", mode === "team");
  btnPlayer.classList.toggle("active", mode === "player");
}

function rebuildTeamColors(data) {
  const entries = [];
  const seenIds = new Set();
  const seenNames = new Set();

  function pushEntry(teamId, teamName) {
    const id = teamId == null ? "" : String(teamId).trim();
    const name = String(teamName || "").trim();
    const nKey = name.toLowerCase();
    if (id) {
      if (seenIds.has(id)) return;
      seenIds.add(id);
    } else if (nKey) {
      if (seenNames.has(nKey)) return;
      seenNames.add(nKey);
    } else {
      return;
    }
    entries.push({ teamId: id, teamName: name });
  }

  (TOURN?.teams || []).forEach((t) => pushEntry(t?.teamId ?? t?.id, t?.teamName ?? t?.name));
  (data?.teams || []).forEach((t) => pushEntry(t?.teamId, t?.teamName));
  (data?.players || []).forEach((p) => pushEntry(p?.teamId, p?.teamName));

  teamColors.reset(entries.length);
  entries.forEach((e) => teamColors.add(e.teamId, e.teamName));
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

function applyModeConstraints(viewRound) {
  const scrambleRound = isScrambleRound(viewRound);
  if (scrambleRound && mode !== "team") mode = "team";
  btnPlayer.disabled = scrambleRound;
  syncModeButtons();
}

function getCoursePars() {
  const pars = TOURN?.course?.pars;
  if (Array.isArray(pars) && pars.length === 18 && pars.some((v) => Number(v) > 0)) {
    return pars.map((v) => Number(v) || 0);
  }
  return Array(18).fill(4);
}

function leaderboardColCount(data) {
  return 5;
}

function scoreValue(v) {
  return v == null || Number.isNaN(Number(v)) ? "—" : String(v);
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

function scoreSourceForRound(roundData) {
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
  const coursePars = nextTournament?.course?.pars || Array(18).fill(4);

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
    const nextSource = scoreSourceForRound(nextRound);
    if (!nextSource.entries.length) continue;

    const prevSource = scoreSourceForRound(prevRound);
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
          toPar: leaderboardToParValue(row),
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
  line.textContent = `${event.name} ${event.result} (${event.toPar}) ${event.hole}`;
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
  summary.textContent = useHandicap
    ? `Gross ${grossTotal} (${toParStrFromDiff(grossToParTotal)}) • Net ${netTotal} (${toParStrFromDiff(netToParTotal)}) • Thru ${thru}`
    : `Gross ${grossTotal} (${toParStrFromDiff(grossToParTotal)}) • Thru ${thru}`;
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
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="left"><b>${label}</b></td>` +
      Array.from({ length: end - start + 1 }, (_, k) => {
        const i = start + k;
        return holeScoreCell(arr[i], par[i]);
      }).join("") +
      `<td class="mono"><b>${totalCell}</b></td>` +
      `<td class="mono"><b>${toParCell}</b></td>`;
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

  const par = getCoursePars();
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
  if (row?.scores) return row.scores;

  const rIdx = Number(data.view.round);
  const modeQ = mode === "team" ? "team" : "player";
  const idQ = mode === "team" ? row.teamId : row.playerId;
  const sc = await api(
    `/tournaments/${encodeURIComponent(tid)}/scorecard?round=${rIdx}&mode=${modeQ}&id=${encodeURIComponent(idQ)}`
  );

  return {
    gross: sc.grossHoles || Array(18).fill(null),
    net: sc.netHoles || Array(18).fill(null),
    handicapShots: sc.handicapShots || Array(18).fill(0),
    par: sc.course?.pars || getCoursePars(),
    grossTotal: sc.grossTotal,
    netTotal: sc.netTotal,
    grossToParTotal: sc.toParGrossTotal,
    netToParTotal: sc.toParNetTotal,
    thru: sc.thru
  };
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
  const showGrossNet = isHandicapRound(data.view?.round);
  lbTitle.textContent = isTeam ? "Teams" : "Individuals";
  rebuildTeamColors(data);

  const head = document.getElementById("lb_head");
  const prevSortKey = sortState?.key || "score";
  const defaultSortKey = showGrossNet ? "net" : "toPar";
  const allowedSortKeys = showGrossNet
    ? new Set(["name", "thru", "gross", "net", "score"])
    : new Set(["name", "toPar", "thru", "strokes", "score"]);
  if (!allowedSortKeys.has(prevSortKey)) sortState = { key: defaultSortKey, dir: "asc" };
  if (sortState.key === "score") sortState = { key: defaultSortKey, dir: "asc" };

  function sortArrow(key) {
    return sortState.key === key ? (sortState.dir === "asc" ? "▲" : "▼") : "";
  }

  function headBtn(label, key, left = false) {
    return `<button type="button" class="sort-head-btn ${left ? "left" : ""}" data-sort-key="${key}">${label}<span class="sort-arrow">${sortArrow(key)}</span></button>`;
  }

  if (showGrossNet) {
    head.innerHTML = `
      <th class="rank-col"></th>
      <th class="left">${headBtn(isTeam ? "Team" : "Player", "name", true)}</th>
      <th>${headBtn("Thru", "thru")}</th>
      <th>${headBtn("Gross ±", "gross")}</th>
      <th>${headBtn("Net ±", "net")}</th>
    `;
  } else {
    head.innerHTML = `
      <th class="rank-col"></th>
      <th class="left">${headBtn(isTeam ? "Team" : "Player", "name", true)}</th>
      <th>${headBtn("±", "toPar")}</th>
      <th>${headBtn("Thru", "thru")}</th>
      <th>${headBtn("Strokes", "strokes")}</th>
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
    })
    .map((x) => x.row);

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
  sortedRows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.className = "clickable";
    tr.dataset.id = isTeam ? r.teamId : r.playerId;
    const rid = rowStableId(r, isTeam);
    const standingRank = standingRanks.get(rid);
    const rankCellValue =
      standingRank == null || displayedRanks.has(standingRank) ? "" : `${standingRank}`;
    if (standingRank != null) displayedRanks.add(standingRank);
    const teamColor = colorForTeam(r.teamId, r.teamName);

    const nameCell = `
      <td class="left">
        <div class="${isTeam ? "team-accent" : ""}" style="--team-accent:${teamColor};"><b>${isTeam ? r.teamName : r.name}</b></div>
        ${!isTeam && r.teamName ? `<div class="small muted team-accent team-accent-sub" style="--team-accent:${teamColor};">${r.teamName}</div>` : ""}
      </td>
    `;

    if (showGrossNet) {
      tr.innerHTML = `
        <td class="mono rank-col">${rankCellValue}</td>
        ${nameCell}
        <td class="mono">${r.thru == null ? "—" : String(r.thru)}</td>
        <td class="mono"><b>${grossToParForRow(r, data)}</b></td>
        <td class="mono"><b>${netToParForRow(r, data)}</b></td>
      `;
    } else {
      tr.innerHTML = `
        <td class="mono rank-col">${rankCellValue}</td>
        ${nameCell}
        <td class="mono"><b>${r.toPar ?? "E"}</b></td>
        <td class="mono">${r.thru == null ? "—" : String(r.thru)}</td>
        <td class="mono">${r.strokes == null ? "—" : String(r.strokes)}</td>
      `;
    }

    tr.onclick = async () => {
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
        if (mode === "team") {
          const teamTable = buildTeamMembersScorecard(rIdx, r, showGrossNet);
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

    rowByKey.set(rowIdentityKey(data, r), tr);
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

function statRowsFromRound(roundData, isTeamMode) {
  if (!roundData) return [];
  const primary = isTeamMode ? (roundData.team || {}) : (roundData.player || {});
  const fallback = !isTeamMode && !Object.keys(primary).length ? (roundData.team || {}) : null;
  const source = fallback || primary;
  const rows = [];

  for (const [id, entry] of Object.entries(source)) {
    rows.push({
      id,
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
  const par = Array.isArray(data?.course?.pars) ? data.course.pars : getCoursePars();
  const statRows =
    roundView === "all"
      ? rounds.flatMap((rd) => statRowsFromRound(rd, isTeamMode))
      : statRowsFromRound(rounds[Number(roundView)], isTeamMode);

  const holeTotals = Array(18).fill(0);
  const holeCounts = Array(18).fill(0);
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
    for (let i = 0; i < 18; i++) {
      const v = row.gross?.[i];
      if (!isPlayedScore(v)) continue;
      const score = Number(v);
      const p = Number(par[i] || 0);
      const diff = score - p;

      holeTotals[i] += score;
      holeCounts[i] += 1;
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
    ${valueRow("±", 0, 8, (i) => (holeCounts[i] ? toParStrFromDecimal(holeTotals[i] / holeCounts[i] - Number(par[i] || 0)) : "—"))}
    ${valueRow("N", 0, 8, (i) => String(holeCounts[i]))}
  `;
  const back = `
    ${headerRow("Back 9", 9, 17)}
    ${valueRow("Avg", 9, 17, (i) => (holeCounts[i] ? formatDecimal(holeTotals[i] / holeCounts[i]) : "—"))}
    ${valueRow("±", 9, 17, (i) => (holeCounts[i] ? toParStrFromDecimal(holeTotals[i] / holeCounts[i] - Number(par[i] || 0)) : "—"))}
    ${valueRow("N", 9, 17, (i) => String(holeCounts[i]))}
  `;

  statsHoleTbl.innerHTML = `<tbody>${front}<tr class="scorecard-spacer-row"><td colspan="10"></td></tr>${back}</tbody>`;
}

function buildScoreboardResponse(tournamentJson, viewRound) {
  const course = tournamentJson.course || {
    pars: Array(18).fill(4),
    strokeIndex: Array.from({ length: 18 }, (_, i) => i + 1)
  };

  if (viewRound === "all") {
    return {
      tournament: tournamentJson.tournament,
      view: { round: "all" },
      course: {
        parTotal: course.pars.reduce((a, b) => a + Number(b || 0), 0),
        pars: course.pars,
        strokeIndex: course.strokeIndex
      },
      teams: tournamentJson.score_data?.leaderboard_all?.teams || [],
      players: tournamentJson.score_data?.leaderboard_all?.players || []
    };
  }

  const rIdx = Number(viewRound);
  const derived = tournamentJson.score_data?.rounds?.[rIdx];
  return {
    tournament: tournamentJson.tournament,
    view: { round: rIdx },
    course: {
      parTotal: course.pars.reduce((a, b) => a + Number(b || 0), 0),
      pars: course.pars,
      strokeIndex: course.strokeIndex
    },
    teams: derived?.leaderboard?.teams || [],
    players: derived?.leaderboard?.players || []
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
  applyModeConstraints(currentRound);
  const data = buildScoreboardResponse(TOURN, currentRound);

  const rLabel = viewRoundLabel(data.view.round);
  const handicapInfo = isHandicapRound(data.view.round)
    ? " • leaderboard shows gross + net, scorecards show both"
    : "";
  const scrambleInfo = isScrambleRound(data.view.round)
    ? " • scramble rounds are team-only"
    : "";
  toggleNote.textContent = `${rLabel}${handicapInfo}${scrambleInfo}`;

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
  currentRound = v === "all" ? "all" : Number(v);
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
