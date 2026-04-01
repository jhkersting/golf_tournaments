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
const tid = tidFromQuery || String(window.__SCOREBOARD_TID || "").trim() || getRememberedTournamentId();
const compactMode =
  Boolean(window.__SCOREBOARD_COMPACT) ||
  ["1", "true", "yes"].includes(String(qs("compact") || "").trim().toLowerCase());
if (compactMode) document.body.classList.add("scoreboard-compact");
const SCOREBOARD_PREFS_STORAGE_PREFIX = "golf:scoreboardPrefs:";
const roundFilter = document.getElementById("round_filter");
const btnTeam = document.getElementById("btn_team");
const btnPlayer = document.getElementById("btn_player");
const toggleNote = document.getElementById("toggle_note");
const lbTitle = document.getElementById("lb_title");
const lbTitleHelp = document.getElementById("lb_title_help");
const lbTbl = document.getElementById("lb_tbl");
const updated = document.getElementById("updated");
const status = document.getElementById("status");
const raw = document.getElementById("raw");
const oddsPanel = document.getElementById("odds_panel");
const oddsPanelHead = oddsPanel?.querySelector(".scoreboard-main-head") || null;
const oddsTitle = document.getElementById("odds_title");
const oddsMeta = document.getElementById("odds_meta");
const oddsSections = document.getElementById("odds_sections");
const oddsScorecardsPanel = document.getElementById("odds_scorecards_panel");
const oddsHoleSelect = document.getElementById("odds_hole_select");
const oddsScorecards = document.getElementById("odds_scorecards");
const btnOddsGross = document.getElementById("btn_odds_gross");
const btnOddsNet = document.getElementById("btn_odds_net");
const btnOddsPct = document.getElementById("btn_odds_pct");
const btnOddsAmerican = document.getElementById("btn_odds_american");
const statsMeta = document.getElementById("stats_meta");
const statsKpis = document.getElementById("stats_kpis");
const statsHoleTbl = document.getElementById("stats_hole_tbl");
const scoreNotifier = document.getElementById("score_notifier");
const trendMeta = document.getElementById("trend_meta");
const trendSvg = document.getElementById("trend_svg");
const trendLegend = document.getElementById("trend_legend");
const trendEmpty = document.getElementById("trend_empty");
const trendGraphShell = document.getElementById("trend_graph_shell");
const btnTrendGross = document.getElementById("btn_trend_gross");
const btnTrendNet = document.getElementById("btn_trend_net");

const scorecardCard = document.getElementById("scorecard_card");
const SVG_NS = "http://www.w3.org/2000/svg";

function scoreboardPrefsStorageKey() {
  const suffix = String(tid || "global").trim() || "global";
  return `${SCOREBOARD_PREFS_STORAGE_PREFIX}${suffix}`;
}

function readScoreboardPrefs() {
  try {
    const raw = localStorage.getItem(scoreboardPrefsStorageKey());
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

function normalizeStoredRound(value) {
  if (value === "all") return "all";
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function normalizeStoredMode(value) {
  return value === "team" || value === "player" ? value : null;
}

function normalizeStoredMetric(value) {
  return value === "gross" || value === "net" ? value : null;
}

function normalizeStoredOddsValueMode(value) {
  return value === "percent" || value === "american" ? value : null;
}

function writeScoreboardPrefs() {
  try {
    localStorage.setItem(
      scoreboardPrefsStorageKey(),
      JSON.stringify({
        mode,
        round: currentRound,
        graphMetric,
        oddsMetric,
        oddsValueMode
      })
    );
  } catch (_) {}
}

const storedScoreboardPrefs = readScoreboardPrefs();
const hasStoredModePreference = normalizeStoredMode(storedScoreboardPrefs.mode) != null;
const hasStoredRoundPreference = normalizeStoredRound(storedScoreboardPrefs.round) != null;
const hasStoredGraphMetricPreference = normalizeStoredMetric(storedScoreboardPrefs.graphMetric) != null;
const hasStoredOddsMetricPreference = normalizeStoredMetric(storedScoreboardPrefs.oddsMetric) != null;
const hasStoredOddsValueModePreference = normalizeStoredOddsValueMode(storedScoreboardPrefs.oddsValueMode) != null;

let mode = normalizeStoredMode(storedScoreboardPrefs.mode) || "player"; // "team" | "player"
let currentRound = normalizeStoredRound(storedScoreboardPrefs.round) ?? "all"; // "all" | number
let TOURN = null;
let graphMetric = normalizeStoredMetric(storedScoreboardPrefs.graphMetric) || "gross"; // "gross" | "net"
let oddsMetric = normalizeStoredMetric(storedScoreboardPrefs.oddsMetric) || "gross"; // "gross" | "net"
let oddsValueMode = normalizeStoredOddsValueMode(storedScoreboardPrefs.oddsValueMode) || "percent"; // "percent" | "american"
let oddsSelectedHoleKey = "";

let openInlineKey = null;
let openInlineRow = null;
let inlineReqToken = 0;
let sortState = { key: "score", dir: "asc" };
const AUTO_REFRESH_MS = 30_000;
let refreshTimerId = null;
let refreshInFlight = false;
let oddsHeadSyncRaf = 0;

function oddsHeadTopOffset() {
  return 0;
}

function clearOddsHeadFixedState() {
  if (!oddsPanel || !oddsPanelHead) return;
  oddsPanel.classList.remove("odds-head-fixed");
  oddsPanel.style.removeProperty("--odds-head-space");
  oddsPanelHead.style.removeProperty("--odds-head-left");
  oddsPanelHead.style.removeProperty("--odds-head-width");
  oddsPanelHead.style.removeProperty("--odds-head-top");
}

function syncOddsHeadFixedState() {
  if (!oddsPanel || !oddsPanelHead || oddsPanel.hidden) {
    clearOddsHeadFixedState();
    return;
  }

  const panelRect = oddsPanel.getBoundingClientRect();
  const topOffset = oddsHeadTopOffset();
  const headHeight = Math.ceil(oddsPanelHead.offsetHeight);
  const shouldFix = panelRect.top <= topOffset && panelRect.bottom > topOffset + headHeight;

  if (!shouldFix) {
    clearOddsHeadFixedState();
    return;
  }

  const width = Math.max(0, panelRect.width);
  oddsPanel.classList.add("odds-head-fixed");
  oddsPanel.style.setProperty("--odds-head-space", `${headHeight + 10}px`);
  oddsPanelHead.style.setProperty("--odds-head-left", `${Math.round(panelRect.left)}px`);
  oddsPanelHead.style.setProperty("--odds-head-width", `${Math.round(width)}px`);
  oddsPanelHead.style.setProperty("--odds-head-top", `${topOffset}px`);
}

function scheduleOddsHeadFixedStateSync() {
  if (oddsHeadSyncRaf) return;
  oddsHeadSyncRaf = window.requestAnimationFrame(() => {
    oddsHeadSyncRaf = 0;
    syncOddsHeadFixedState();
  });
}
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

function syncTrendMetricButtons() {
  if (!btnTrendGross || !btnTrendNet) return;
  const allowNetMetric = canUseNetMetric(currentRound);
  if (!allowNetMetric && graphMetric === "net") graphMetric = "gross";
  btnTrendGross.classList.toggle("active", graphMetric === "gross");
  btnTrendNet.classList.toggle("active", graphMetric === "net");
  btnTrendNet.disabled = !allowNetMetric;
  btnTrendNet.setAttribute("aria-disabled", allowNetMetric ? "false" : "true");
  btnTrendNet.title = allowNetMetric ? "" : "Net is only available when handicaps are enabled for this view.";
}

function syncOddsMetricButtons() {
  if (!btnOddsGross || !btnOddsNet) return;
  const lockToNet = oddsMetricLockedToNet(currentRound);
  const allowNetMetric = canUseNetMetric(currentRound);
  if (lockToNet) {
    oddsMetric = "net";
  } else if (!allowNetMetric && oddsMetric === "net") {
    oddsMetric = "gross";
  }
  btnOddsGross.classList.toggle("active", oddsMetric === "gross");
  btnOddsNet.classList.toggle("active", oddsMetric === "net");
  btnOddsGross.disabled = lockToNet;
  btnOddsGross.setAttribute("aria-disabled", lockToNet ? "true" : "false");
  btnOddsGross.title = lockToNet ? "Tournament odds are always shown in net mode." : "";
  btnOddsNet.disabled = lockToNet ? false : !allowNetMetric;
  btnOddsNet.setAttribute("aria-disabled", lockToNet || allowNetMetric ? "false" : "true");
  btnOddsNet.title = lockToNet
    ? "Tournament odds are always shown in net mode."
    : allowNetMetric
      ? ""
      : "Net is only available when handicaps are enabled for this view.";
}

function syncOddsValueButtons() {
  if (!btnOddsPct || !btnOddsAmerican) return;
  btnOddsPct.classList.toggle("active", oddsValueMode === "percent");
  btnOddsAmerican.classList.toggle("active", oddsValueMode === "american");
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
  const add = (teamId, teamName, teamColor) => {
    const id = teamId == null ? "" : String(teamId).trim();
    if (!id || seenTeamIds.has(id)) return;
    seenTeamIds.add(id);
    ordered.push({
      teamId: id,
      teamName: String(teamName || "").trim(),
      color: String(teamColor || "").trim()
    });
  };

  // Match enter.js assignment order: teams first, then players.
  (TOURN?.teams || []).forEach((t) => add(t?.teamId ?? t?.id, t?.teamName ?? t?.name, t?.color));
  (TOURN?.players || []).forEach((p) => add(p?.teamId, p?.teamName));

  // Add any ids that appear only in leaderboard payloads.
  (TOURN?.score_data?.leaderboard_all?.teams || []).forEach((t) => add(t?.teamId, t?.teamName, t?.color));
  const rounds = TOURN?.score_data?.rounds || [];
  rounds.forEach((rd) => {
    (rd?.leaderboard?.teams || []).forEach((t) => add(t?.teamId, t?.teamName, t?.color));
    (rd?.leaderboard?.players || []).forEach((p) => add(p?.teamId, p?.teamName));
  });

  teamColors.reset(ordered.length);
  ordered.forEach((e) => teamColors.add(e.teamId, e.teamName, e.color));
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

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatPercent(value, { exactExtremes = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (exactExtremes && n <= 0) return "0%";
  if (exactExtremes && n >= 100) return "100%";
  if (n < 1) return "<1%";
  if (n > 99) return ">99%";
  return `${Math.round(n)}%`;
}

function formatAmericanOdds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const p = n / 100;
  if (p <= 0) return "+10000";
  if (p >= 1) return "-10000";
  if (Math.abs(p - 0.5) < 0.0000001) return "+100";
  if (p > 0.5) {
    const odds = -Math.round((p / (1 - p)) * 100);
    return String(Math.max(-10000, odds));
  }
  const odds = Math.round(((1 - p) / p) * 100);
  return `+${Math.min(10000, odds)}`;
}

function formatOddsValue(value, options) {
  return oddsValueMode === "american"
    ? formatAmericanOdds(value)
    : formatPercent(value, options);
}

function oddsUnderlineStyle(probability) {
  const n = Number(probability);
  if (!Number.isFinite(n)) return "";
  const pct = clampNumber(n, 0, 100) / 100;
  const thickness = `${(0.75 + (pct * 2)).toFixed(2)}px`;
  const alpha = (0.18 + (pct * 0.64)).toFixed(3);
  return `--odds-underline-thickness:${thickness}; --odds-underline-color:rgba(20, 33, 47, ${alpha});`;
}

function renderOddsMetricValue(value, probability, options) {
  const display = formatOddsValue(value, options);
  const style = oddsUnderlineStyle(probability);
  return `<span class="odds-metric-value"${style ? ` style="${style}"` : ""}>${escapeHtml(display)}</span>`;
}

function toParStrFromTenths(diff) {
  const n = Number(diff);
  if (!Number.isFinite(n) || Math.abs(n) < 0.05) return "E";
  const rounded = Math.round(n * 10) / 10;
  const out = rounded.toFixed(1);
  return rounded > 0 ? `+${out}` : out;
}

function projectedScoreToPar(row) {
  const direct = Number(row?.projectedScoreToPar);
  if (Number.isFinite(direct)) return direct;

  const gross = Number(row?.projectedGross);
  const grossToPar = Number(row?.projectedGrossToPar);
  if (Number.isFinite(gross) && Number.isFinite(grossToPar)) {
    const parBase = gross - grossToPar;
    const score = Number(row?.projectedScore);
    if (Number.isFinite(score)) return score - parBase;
  }

  const net = Number(row?.projectedNet);
  const netToPar = Number(row?.projectedNetToPar);
  if (Number.isFinite(net) && Number.isFinite(netToPar)) {
    const parBase = net - netToPar;
    const score = Number(row?.projectedScore);
    if (Number.isFinite(score)) return score - parBase;
  }

  return null;
}

function fromTenthsInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? (n / 10) : null;
}

function expandCompactDistribution(distribution) {
  return (distribution || [])
    .map((item) => ({
      score: fromTenthsInt(item?.[0]),
      probability: Number(item?.[1] || 0)
    }))
    .filter((item) => item.score != null && Number(item.probability || 0) > 0)
    .sort((a, b) => Number(a.score || 0) - Number(b.score || 0));
}

function expandCompactHoleDetails(details, roundIndex) {
  if (!Array.isArray(details)) return [];
  return details
    .map((item) => {
      const holeIndex = Number(item?.[0]);
      if (!Number.isInteger(holeIndex) || holeIndex < 0) return null;
      return {
        roundIndex: Number.isInteger(Number(roundIndex)) ? Number(roundIndex) : null,
        holeIndex,
        projectedGross: fromTenthsInt(item?.[1]),
        projectedNet: fromTenthsInt(item?.[2]),
        grossDistribution: expandCompactDistribution(item?.[3]),
        netDistribution: expandCompactDistribution(item?.[4])
      };
    })
    .filter(Boolean)
    .sort((a, b) => Number(a.holeIndex || 0) - Number(b.holeIndex || 0));
}

function teamNameLookupFromTournament(tournamentJson) {
  const out = new Map();
  (tournamentJson?.teams || []).forEach((team) => {
    const teamId = String(team?.teamId ?? team?.id ?? "").trim();
    if (!teamId) return;
    out.set(teamId, String(team?.teamName ?? team?.name ?? teamId));
  });
  return out;
}

function playerNameLookupFromTournament(tournamentJson) {
  const out = new Map();
  (tournamentJson?.players || []).forEach((player) => {
    const playerId = String(player?.playerId || "").trim();
    if (!playerId) return;
    out.set(playerId, String(player?.name || playerId));
  });
  return out;
}

function compactOddsGroupPlayerIds(tournamentJson, roundIndex, teamId, groupKey) {
  const normalizedTeamId = String(teamId || "").trim();
  const normalizedGroupKey = normalizeTwoManGroupKey(groupKey);
  if (!normalizedTeamId || !normalizedGroupKey) return [];

  const roundTeamEntry = tournamentJson?.score_data?.rounds?.[roundIndex]?.team?.[normalizedTeamId] || {};
  const roundGroups = roundTeamEntry?.groups || {};
  for (const [rawKey, value] of Object.entries(roundGroups)) {
    if (normalizeTwoManGroupKey(rawKey) !== normalizedGroupKey) continue;
    if (Array.isArray(value?.playerIds) && value.playerIds.length) {
      return Array.from(new Set(value.playerIds.map((id) => String(id || "").trim()).filter(Boolean)));
    }
  }

  const teamDef = (tournamentJson?.teams || []).find((team) => String(team?.teamId ?? team?.id ?? "").trim() === normalizedTeamId);
  const fromTeamDef = teamDef?.groupsByRound?.[String(roundIndex)]?.[normalizedGroupKey] || teamDef?.groups?.[normalizedGroupKey];
  if (Array.isArray(fromTeamDef) && fromTeamDef.length) {
    return Array.from(new Set(fromTeamDef.map((id) => String(id || "").trim()).filter(Boolean)));
  }

  return Array.from(
    new Set(
      (tournamentJson?.players || [])
        .filter((player) =>
          String(player?.teamId || "").trim() === normalizedTeamId &&
          playerGroupForRound(player, roundIndex) === normalizedGroupKey
        )
        .map((player) => String(player?.playerId || "").trim())
        .filter(Boolean)
    )
  );
}

function compactOddsGroupName(tournamentJson, roundIndex, teamId, groupId, playerNames) {
  const normalizedTeamId = String(teamId || "").trim();
  const rawGroupId = String(groupId || "").trim();
  const groupKey = normalizeTwoManGroupKey(rawGroupId.split("::")[1] || "");
  if (!normalizedTeamId || !groupKey) return rawGroupId || "Group";

  const playerIds = compactOddsGroupPlayerIds(tournamentJson, roundIndex, normalizedTeamId, groupKey);
  const directLabel = twoManPairLabelFromIds(playerIds, playerNames, groupKey);
  if (directLabel) return directLabel;
  return rawGroupId || `Group ${groupKey}`;
}

function expandCompactOddsRows(rows, kind, tournamentJson, roundIndex, teamNames, playerNames) {
  return (rows || []).map((row) => {
    if (kind === "team") {
      const teamId = String(row?.[0] || "").trim();
      return {
        teamId,
        teamName: teamNames.get(teamId) || teamId || "Team",
        leaderProbability: Number(row?.[1] || 0),
        lowestGrossProbability: Number(row?.[2] || 0),
        lowestNetProbability: Number(row?.[3] || 0),
        projectedScoreToPar: fromTenthsInt(row?.[4]),
        projectedGrossToPar: fromTenthsInt(row?.[5]),
        projectedNetToPar: fromTenthsInt(row?.[6]),
        holesRemaining: Number(row?.[7] || 0),
        remainingHoleExpectations: expandCompactHoleDetails(row?.[8], roundIndex)
      };
    }

    const entityId = String(row?.[0] || "").trim();
    const teamId = String(row?.[1] || "").trim();
    const base = {
      teamId,
      teamName: teamNames.get(teamId) || teamId || "",
      leaderProbability: Number(row?.[2] || 0),
      lowestGrossProbability: Number(row?.[3] || 0),
      lowestNetProbability: Number(row?.[4] || 0),
      projectedScoreToPar: fromTenthsInt(row?.[5]),
      projectedGrossToPar: fromTenthsInt(row?.[6]),
      projectedNetToPar: fromTenthsInt(row?.[7]),
      holesRemaining: Number(row?.[8] || 0),
      remainingHoleExpectations: expandCompactHoleDetails(row?.[9], roundIndex)
    };

    if (kind === "player") {
      return {
        ...base,
        playerId: entityId,
        name: playerNames.get(entityId) || entityId || "Player"
      };
    }

    return {
      ...base,
      groupId: entityId,
      name: compactOddsGroupName(tournamentJson, roundIndex, teamId, entityId, playerNames)
    };
  });
}

function expandCompactLiveOddsPayload(oddsJson, tournamentJson) {
  const compact = oddsJson?.o;
  if (!compact) return null;

  const teamNames = teamNameLookupFromTournament(tournamentJson);
  const playerNames = playerNameLookupFromTournament(tournamentJson);
  const rounds = Array.isArray(compact?.r) ? compact.r : [];
  const allRounds = Array.isArray(compact?.a) ? compact.a : [[], [], []];

  return {
    generatedAt: oddsJson?.u || null,
    simCount: Number(compact?.s || 0),
    latencyMode: Number(compact?.l) === 0 ? "latency_first" : "",
    rounds: rounds.map((scope, roundIndex) => ({
      roundIndex,
      teams: expandCompactOddsRows(scope?.[0], "team", tournamentJson, roundIndex, teamNames, playerNames),
      players: expandCompactOddsRows(scope?.[1], "player", tournamentJson, roundIndex, teamNames, playerNames),
      groups: expandCompactOddsRows(scope?.[2], "group", tournamentJson, roundIndex, teamNames, playerNames)
    })),
    all_rounds: {
      teams: expandCompactOddsRows(allRounds?.[0], "team", tournamentJson, "all", teamNames, playerNames),
      players: expandCompactOddsRows(allRounds?.[1], "player", tournamentJson, "all", teamNames, playerNames),
      groups: expandCompactOddsRows(allRounds?.[2], "group", tournamentJson, "all", teamNames, playerNames)
    },
    compactTimeline: oddsJson?.h || null
  };
}

function liveOddsForView(viewRound = currentRound) {
  const odds = TOURN?.score_data?.live_odds;
  if (!odds) return null;
  if (viewRound === "all") return odds.all_rounds || null;
  return odds.rounds?.[Number(viewRound)] || null;
}

function oddsRowStableId(row, key) {
  if (key === "teams") return String(row?.teamId || "").trim();
  if (key === "groups") return String(row?.groupId || "").trim();
  return String(row?.playerId || "").trim();
}

function oddsTournamentComplete() {
  const allRoundsOdds = liveOddsForView("all");
  if (!allRoundsOdds) return false;
  const rows = Array.isArray(allRoundsOdds.teams) && allRoundsOdds.teams.length
    ? allRoundsOdds.teams
    : allRoundsOdds.players;
  if (!Array.isArray(rows) || !rows.length) return false;
  return rows.every((row) => Number(row?.holesRemaining || 0) <= 0);
}

function completedOddsRowIds(key, fallbackRows = []) {
  const allRoundsOdds = liveOddsForView("all");
  if (!allRoundsOdds && !(key === "groups" && oddsTournamentComplete())) return new Set();
  const rows = key === "teams"
    ? allRoundsOdds.teams
    : key === "groups"
      ? allRoundsOdds.groups
      : allRoundsOdds.players;
  const sourceRows = Array.isArray(rows) && rows.length
    ? rows
    : (key === "groups" && oddsTournamentComplete() ? fallbackRows : []);
  if (!Array.isArray(sourceRows) || !sourceRows.length) return new Set();
  return new Set(
    sourceRows
      .filter((row) => Number(row?.holesRemaining || 0) <= 0 && Number(row?.leaderProbability || 0) >= 100)
      .map((row) => oddsRowStableId(row, key))
      .filter(Boolean)
  );
}

function liveOddsTimestampLabel() {
  const rawTs = TOURN?.score_data?.live_odds?.generatedAt;
  if (!rawTs) return "";
  const d = new Date(rawTs);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString();
}

function liveOddsTooltip(entry) {
  const items = Array.isArray(entry?.remainingHoleExpectations) ? entry.remainingHoleExpectations : [];
  if (!items.length) return "";
  return items
    .slice(0, 8)
    .map((item) => {
      const roundLabel = Number.isInteger(item?.roundIndex) ? `R${Number(item.roundIndex) + 1}` : "R?";
      const holeLabel = Number.isInteger(item?.holeIndex) ? `H${Number(item.holeIndex) + 1}` : "H?";
      return `${roundLabel} ${holeLabel} G ${formatDecimal(item?.projectedGross)} / N ${formatDecimal(item?.projectedNet)}`;
    })
    .join(" • ");
}

function oddsHoleMetricExpectation(detail) {
  if (!detail || typeof detail !== "object") return null;
  return oddsMetric === "net"
    ? Number(detail?.projectedNet)
    : Number(detail?.projectedGross);
}

function oddsHoleMetricDistribution(detail) {
  const items = oddsMetric === "net"
    ? detail?.netDistribution
    : detail?.grossDistribution;
  return Array.isArray(items) ? items : [];
}

function oddsRoundActualRowMaps(data) {
  return {
    teams: new Map((data?.teams || []).map((row) => [String(row?.teamId || "").trim(), row])),
    players: new Map((data?.players || []).map((row) => [String(row?.playerId || "").trim(), row])),
    groups: new Map(
      (data?.players || [])
        .filter((row) => String(row?.groupId || "").trim())
        .map((row) => [String(row?.groupId || "").trim(), row])
    )
  };
}

function oddsActualRowForKey(data, key, row) {
  const maps = oddsRoundActualRowMaps(data);
  if (key === "teams") return maps.teams.get(String(row?.teamId || "").trim()) || null;
  if (key === "groups") return maps.groups.get(String(row?.groupId || "").trim()) || null;
  return maps.players.get(String(row?.playerId || "").trim()) || null;
}

function oddsHoleOptions(tables, data) {
  const seen = new Set();
  const options = [];
  tables.forEach((table) => {
    (table?.rows || []).forEach((row) => {
      (row?.remainingHoleExpectations || []).forEach((item) => {
        const holeIndex = Number(item?.holeIndex);
        if (!Number.isInteger(holeIndex) || holeIndex < 0 || holeIndex > 17) return;
        const key = String(holeIndex);
        if (seen.has(key)) return;
        seen.add(key);
        options.push({
          key,
          holeIndex,
          label: `Hole ${holeIndex + 1}${Number.isFinite(Number(data?.course?.pars?.[holeIndex])) ? ` • Par ${Number(data.course.pars[holeIndex])}` : ""}`
        });
      });
    });
  });
  return options.sort((a, b) => a.holeIndex - b.holeIndex);
}

function oddsProjectedDetailMap(row) {
  return new Map(
    (row?.remainingHoleExpectations || [])
      .map((item) => [Number(item?.holeIndex), item])
      .filter(([holeIndex]) => Number.isInteger(holeIndex))
  );
}

function oddsActualScoreForHole(scoreBundle, holeIndex) {
  if (!scoreBundle) return null;
  if (Array.isArray(scoreBundle?.actualReady) && !scoreBundle.actualReady[holeIndex]) return null;
  const source = oddsMetric === "net" ? scoreBundle?.net : scoreBundle?.gross;
  return asPlayedNumber(source?.[holeIndex]);
}

function oddsGroupRowKey(row) {
  return normalizeTwoManGroupKey(row?.groupKey || String(row?.groupId || "").split("::")[1] || "");
}

function oddsGroupPlayerCount(roundIndex, row) {
  const groupKey = oddsGroupRowKey(row);
  if (!groupKey) return 1;
  const playerIds = compactOddsGroupPlayerIds(TOURN, roundIndex, row?.teamId, groupKey);
  return Math.max(1, playerIds.length);
}

function oddsTwoManTeamHolePar(data, roundIndex, row, holeIndex, basePar, twoManFormat) {
  const teamId = normalizeTeamId(row?.teamId);
  if (!teamId || !Number.isFinite(basePar) || basePar <= 0) return null;
  const groupRows = (data?.players || []).filter((candidate) =>
    normalizeTeamId(candidate?.teamId) === teamId && String(candidate?.groupId || "").trim()
  );
  if (!groupRows.length) return null;

  const multiplier = groupRows.reduce((total, candidate) => {
    const groupPar = Number(candidate?.scores?.par?.[holeIndex]);
    if (Number.isFinite(groupPar) && groupPar > 0) return total + (groupPar / basePar);
    if (twoManFormat === "two_man_shamble") return total + oddsGroupPlayerCount(roundIndex, candidate);
    return total + 1;
  }, 0);

  return multiplier > 0 ? basePar * multiplier : null;
}

function oddsHoleParForRow(data, key, row, holeIndex, scoreBundle) {
  const basePar = Number(data?.course?.pars?.[holeIndex]);
  if (!Number.isFinite(basePar) || basePar <= 0) return undefined;

  const roundCfg = roundAt(data?.view?.round);
  const format = String(roundCfg?.format || "").toLowerCase();
  const twoManFormat = normalizeTwoManFormat(format);
  const roundIndex = Number(data?.view?.round);

  if (key === "teams" && twoManFormat && Number.isInteger(roundIndex)) {
    const teamPar = oddsTwoManTeamHolePar(data, roundIndex, row, holeIndex, basePar, twoManFormat);
    if (Number.isFinite(teamPar) && teamPar > 0) return teamPar;
  }

  const explicitPar = Number(scoreBundle?.par?.[holeIndex]);
  if (Number.isFinite(explicitPar) && explicitPar > 0) return explicitPar;

  if (key === "groups" && twoManFormat === "two_man_shamble" && Number.isInteger(roundIndex)) {
    return basePar * oddsGroupPlayerCount(roundIndex, row);
  }

  if (key === "teams" && format !== "scramble") {
    const { topX } = roundAggregationConfig(roundCfg);
    const playerCount = (TOURN?.players || []).filter((player) =>
      normalizeTeamId(player?.teamId) === normalizeTeamId(row?.teamId)
    ).length;
    return basePar * Math.max(1, Math.min(topX, playerCount || topX));
  }

  return basePar;
}

function oddsHoleCellText(actualValue, detail, par) {
  if (actualValue != null) {
    if (Number.isFinite(par)) return toParStrFromDiff(actualValue - par);
    return String(actualValue);
  }
  const projected = oddsHoleMetricExpectation(detail);
  if (Number.isFinite(projected)) {
    if (Number.isFinite(par)) return toParStrFromDecimal(projected - par);
    return formatDecimal(projected);
  }
  return "—";
}

function oddsDistributionSummary(actualValue, detail, par) {
  if (actualValue != null) {
    const label = Number.isFinite(par) ? toParStrFromDiff(actualValue - par) : String(actualValue);
    return {
      expected: label,
      played: `Played ${label}`,
      items: [],
      par
    };
  }
  const projected = oddsHoleMetricExpectation(detail);
  const expectedLabel = Number.isFinite(projected)
    ? (Number.isFinite(par) ? toParStrFromDecimal(projected - par) : formatDecimal(projected))
    : "—";
  return {
    expected: expectedLabel,
    played: "",
    items: oddsHoleMetricDistribution(detail),
    par
  };
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

function tournamentScoring() {
  const raw = String(TOURN?.tournament?.scoring || "").trim().toLowerCase();
  return raw === "stableford" ? "stableford" : "stroke";
}

function isStablefordTournament() {
  return tournamentScoring() === "stableford";
}

function isHandicapRound(viewRound) {
  const round = roundAt(viewRound);
  if (!round) return false;
  return !!round.useHandicap || String(round.format || "").toLowerCase() === "scramble";
}

function canUseNetMetric(viewRound = currentRound) {
  if (viewRound === "all") {
    return (TOURN?.tournament?.rounds || []).some((round) => !!round?.useHandicap);
  }
  const round = roundAt(viewRound);
  return !!round?.useHandicap;
}

function isScrambleRound(viewRound) {
  const round = roundAt(viewRound);
  if (!round) return false;
  return String(round.format || "").toLowerCase() === "scramble";
}

function normalizeTwoManFormat(format) {
  const fmt = String(format || "").trim().toLowerCase();
  if (fmt === "two_man") return "two_man_scramble";
  if (fmt === "two_man_scramble" || fmt === "two_man_shamble" || fmt === "two_man_best_ball") return fmt;
  return "";
}

function isTwoManRound(viewRound) {
  const round = roundAt(viewRound);
  if (!round) return false;
  return !!normalizeTwoManFormat(round.format);
}

function tournamentHasAnyScrambleRound() {
  const rounds = TOURN?.tournament?.rounds || [];
  return rounds.some((r) => String(r?.format || "").toLowerCase().includes("scramble"));
}

function oddsMetricLockedToNet(viewRound = currentRound) {
  return viewRound === "all";
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
  if (isStablefordTournament() && showGrossNet) return isAllRounds ? 4 : 5;
  if (isStablefordTournament()) return 4;
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
  if (format === "scramble" || format === "team_best_ball") {
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

  const playersById = new Map();
  (nextTournament?.players || []).forEach((player) => {
    const id = String(player?.playerId || "").trim();
    if (id) playersById.set(id, player);
  });

  function notificationRowFromGroupEntry(groupEntry) {
    const gross = (Array.isArray(groupEntry?.gross) ? groupEntry.gross : Array(18).fill(null))
      .map((value) => (!isPlayedScore(value) ? null : Number(value)));
    const net = (Array.isArray(groupEntry?.net) ? groupEntry.net : gross)
      .map((value) => (!isPlayedScore(value) ? null : Number(value)));
    const grossTotal = groupEntry?.grossTotal ?? sumHoles(gross);
    const netTotal = groupEntry?.netTotal ?? sumHoles(net);
    const thru = gross.reduce((count, value) => count + (!isPlayedScore(value) ? 0 : 1), 0);
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

  function scoreNotificationTargetMeta(tournament, roundData, roundIndex, roundCfg, rawId, playerRows, teamRows) {
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
        name: row?.teamName || teamNames.get(teamId) || teamId || "Team",
        entityType: "team"
      };
    }

    if (twoManFormat) {
      let teamId = "";
      let groupKey = "";
      if (id.includes("::")) {
        teamId = normalizeTeamId(id.split("::")[0] || "");
        groupKey = normalizeTwoManGroupKey(id.split("::")[1] || "");
      } else {
        const player = playersById.get(id) || null;
        teamId = normalizeTeamId(player?.teamId);
        groupKey = playerGroupForRound(player, roundIndex);
      }
      if (teamId && groupKey) {
        const targetId = `${teamId}::${groupKey}`;
        const teamEntry = roundData?.team?.[teamId] || {};
        const entry = twoManGroupEntry(teamEntry, groupKey);
        const playerIds = compactOddsGroupPlayerIds(tournament, roundIndex, teamId, groupKey);
        const row =
          playerIds.map((playerId) => playerRows.get(playerId)).find(Boolean) ||
          (Object.keys(entry || {}).length ? notificationRowFromGroupEntry(entry) : null);
        return {
          targetId,
          entry,
          row,
          name: compactOddsGroupName(tournament, roundIndex, teamId, targetId, playerNames),
          entityType: "group"
        };
      }
    }

    const row = playerRows.get(id) || roundData?.player?.[id] || null;
    return {
      targetId: id,
      entry: roundData?.player?.[id] || {},
      row,
      name: row?.name || playerNames.get(id) || id,
      entityType: "player"
    };
  }

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
      const meta = scoreNotificationTargetMeta(nextTournament, nextRound, roundIndex, nextRoundCfg, idRaw, playerRows, teamRows);
      if (!meta?.targetId || seenTargets.has(meta.targetId)) continue;
      seenTargets.add(meta.targetId);

      const prevMeta = scoreNotificationTargetMeta(nextTournament, prevRound, roundIndex, prevRoundCfg, idRaw, prevPlayerRows, prevTeamRows);
      const prevEntry = prevMeta?.entry || prevById.get(String(idRaw || "").trim()) || null;
      const row = meta.row;
      const name = meta.name;
      const nextTargetEntry = meta.entry || nextEntry;

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
        const nextGross = normalizePostedScore(nextTargetEntry?.gross?.[holeIndex]);
        if (nextGross == null) continue;

        const prevGross = normalizePostedScore(prevEntry?.gross?.[holeIndex]);
        if (prevGross != null) continue;

        const par = Number(coursePars?.[holeIndex] || 0);
        const diffToPar = par > 0 ? nextGross - par : 0;
        events.push({
          entityType: meta.entityType,
          entityId: meta.targetId,
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

  const grossToPar = event.grossToPar != null ? toParDisplay(event.grossToPar) : null;
  const netToPar = event.netToPar != null ? toParDisplay(event.netToPar) : null;
  const toPar = event.toPar != null ? toParDisplay(event.toPar) : "E";

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
    line.appendChild(document.createTextNode(toPar === "—" ? "E" : toPar));
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
  if (isStablefordTournament()) {
    return showGrossNet ? netStablefordForRow(row) : firstDefined(row, ["points", "netPoints", "grossPoints"]);
  }
  if (showGrossNet) return toParNumber(netToParForRow(row, data));
  return toParNumber(firstDefined(row, ["toPar", "netToPar", "toParNet", "toParTotal"]));
}

function defaultSortComparator(a, b, showGrossNet, data) {
  const scoreCmp = compareNullableNumber(
    defaultScoreForSort(a, showGrossNet, data),
    defaultScoreForSort(b, showGrossNet, data),
    isStablefordTournament() ? "desc" : "asc"
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
    if (isStablefordTournament()) {
      const out = compareNullableNumber(grossStablefordForRow(a), grossStablefordForRow(b), sortDir);
      if (out !== 0) return out;
      return defaultSortComparator(a, b, showGrossNet, data);
    }
    const out = compareNullableNumber(
      toParNumber(grossToParForRow(a, data)),
      toParNumber(grossToParForRow(b, data)),
      sortDir
    );
    if (out !== 0) return out;
    return defaultSortComparator(a, b, showGrossNet, data);
  }

  if (sortKey === "net") {
    if (isStablefordTournament()) {
      const out = compareNullableNumber(netStablefordForRow(a), netStablefordForRow(b), sortDir);
      if (out !== 0) return out;
      return defaultSortComparator(a, b, showGrossNet, data);
    }
    const out = compareNullableNumber(
      toParNumber(netToParForRow(a, data)),
      toParNumber(netToParForRow(b, data)),
      sortDir
    );
    if (out !== 0) return out;
    return defaultSortComparator(a, b, showGrossNet, data);
  }

  if (sortKey === "toPar") {
    if (isStablefordTournament()) {
      const out = compareNullableNumber(
        firstDefined(a, ["points", "netPoints", "grossPoints"]),
        firstDefined(b, ["points", "netPoints", "grossPoints"]),
        sortDir
      );
      if (out !== 0) return out;
      return defaultSortComparator(a, b, showGrossNet, data);
    }
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

function hasPostedScoresForLeaderboard(row, showGrossNet) {
  if (Number(row?.strokes || 0) > 0) return true;
  if (Number(row?.grossTotal || 0) > 0) return true;
  if (Number(row?.netTotal || 0) > 0) return true;
  if (showGrossNet) {
    if (Number(grossForRow(row) || 0) > 0) return true;
    if (Number(netForRow(row) || 0) > 0) return true;
  }
  return false;
}

function sortLeaderboardRows(rows, data, isTeam, showGrossNet) {
  return rows
    .map((row) => ({ row, hasData: hasPostedScoresForLeaderboard(row, showGrossNet) }))
    .sort((a, b) => {
      if (a.hasData !== b.hasData) return a.hasData ? -1 : 1;
      return compareRows(a.row, b.row, sortState.key, sortState.dir, showGrossNet, data, isTeam);
    });
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

function grossStablefordForRow(row) {
  if (row?.grossPoints != null) return row.grossPoints;
  if (row?.grossStablefordTotal != null) return row.grossStablefordTotal;
  if (row?.scores?.grossStablefordTotal != null) return row.scores.grossStablefordTotal;
  if (Array.isArray(row?.scores?.grossStableford)) return sumHoles(row.scores.grossStableford);
  return null;
}

function netStablefordForRow(row) {
  if (row?.points != null && !isNaN(Number(row.points))) return row.points;
  if (row?.netPoints != null) return row.netPoints;
  if (row?.netStablefordTotal != null) return row.netStablefordTotal;
  if (row?.scores?.netStablefordTotal != null) return row.scores.netStablefordTotal;
  if (Array.isArray(row?.scores?.netStableford)) return sumHoles(row.scores.netStableford);
  return null;
}

function handicapStrokesForRow(row) {
  if (row?.handicapStrokes != null && Number(row.handicapStrokes) > 0) return Number(row.handicapStrokes);
  if (row?.scores?.handicapStrokes != null && Number(row.scores.handicapStrokes) > 0) {
    return Number(row.scores.handicapStrokes);
  }
  if (Array.isArray(row?.scores?.handicapShots)) {
    const total = sumHoles(row.scores.handicapShots);
    if (total > 0) return total;
  }
  const gross = grossForRow(row);
  const net = netForRow(row);
  if (gross != null && net != null) {
    const total = Number(gross) - Number(net);
    if (total > 0) return total;
  }
  return null;
}

function handicapStrokesLabelForRow(row) {
  const total = handicapStrokesForRow(row);
  return total == null ? "" : ` (${formatDecimal(total)})`;
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
  if (Array.isArray(row?.scores?.grossToPar)) {
    const diff = row.scores.grossToPar.reduce(
      (a, v) => a + (v == null ? 0 : Number(v) || 0),
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

  // Fall back to hole-by-hole computation when an explicit total is unavailable.
  const parByHole = Array.isArray(row?.scores?.par) ? row.scores.par : data?.course?.pars;
  if (Array.isArray(row?.scores?.gross) && Array.isArray(parByHole)) {
    const diff = row.scores.gross.reduce(
      (a, v, i) => a + (!isPlayedScore(v) ? 0 : Number(v) - Number(parByHole[i] || 0)),
      0
    );
    return toParDisplay(diff);
  }

  const gross = grossForRow(row);
  const parTotal = Number(data?.course?.parTotal || 0);
  if (gross != null && parTotal > 0 && Number(row?.thru || 0) >= 18) {
    return toParDisplay(Number(gross) - parTotal);
  }
  return toParDisplay(row?.toPar);
}

function netToParForRow(row, data) {
  if (Array.isArray(row?.scores?.netToPar)) {
    const diff = row.scores.netToPar.reduce(
      (a, v) => a + (v == null ? 0 : Number(v) || 0),
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

  // Fall back to hole-by-hole computation when an explicit total is unavailable.
  const parByHole = Array.isArray(row?.scores?.par) ? row.scores.par : data?.course?.pars;
  if (Array.isArray(row?.scores?.net) && Array.isArray(parByHole)) {
    const diff = row.scores.net.reduce(
      (a, v, i) => a + (!isPlayedScore(v) ? 0 : Number(v) - Number(parByHole[i] || 0)),
      0
    );
    return toParDisplay(diff);
  }

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

function holeScoreCell(value, parValue, marker = "") {
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
  const markerText = String(marker || "").trim();
  const markerHtml = markerText ? `<div class="score-hole-marker">${escapeHtml(markerText)}</div>` : "";

  return `<td class="mono score-hole-cell" title="${title}"><div class="score-hole-wrap">${content}${markerHtml}</div></td>`;
}

function buildScorecardTable(scores, useHandicap) {
  const gross = scores.gross || Array(18).fill(null);
  const net = scores.net || Array(18).fill(null);
  const grossStableford = scores.grossStableford || Array(18).fill(null);
  const netStableford = scores.netStableford || Array(18).fill(null);
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
  const grossStablefordTotal =
    scores.grossStablefordTotal != null
      ? scores.grossStablefordTotal
      : sumHoles(grossStableford);
  const netStablefordTotal =
    scores.netStablefordTotal != null
      ? scores.netStablefordTotal
      : sumHoles(netStableford);
  const showStableford = isStablefordTournament();
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
      `<span class="score-emph-gross">Gross <span class="mono">${grossTotal}</span> (<span class="mono">${toParStrFromDiff(grossToParTotal)}</span>)</span>` +
      ` • ` +
      `<span class="score-emph-net">Net <span class="mono">${netTotal}</span> (<span class="mono">${toParStrFromDiff(netToParTotal)}</span>)</span>` +
      (showStableford
        ? ` • <span class="score-emph-gross">Gross Pts <span class="mono">${grossStablefordTotal}</span></span> • <span class="score-emph-net">Net Pts <span class="mono">${netStablefordTotal}</span></span>`
        : "") +
      ` • Thru <span class="mono">${displayThru(thru)}</span>`;
  } else {
    summary.innerHTML =
      `Gross <span class="mono">${grossTotal}</span> (<span class="mono">${toParStrFromDiff(grossToParTotal)}</span>)` +
      (showStableford ? ` • Points <span class="mono">${grossStablefordTotal}</span>` : "") +
      ` • Thru <span class="mono">${displayThru(thru)}</span>`;
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
      Array.from({ length: end - start + 1 }, (_, k) => `<th class="mono">${start + k + 1}</th>`).join("") +
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

  function addStablefordRow(label, arr, start, end, emphClass = "") {
    if (!showStableford) return;
    const total = sectionPlayedCount(arr, start, end) ? String(segmentTotal(arr, start, end)) : "";
    const emph = emphClass ? ` class="${emphClass}"` : "";
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="left"><b${emph}>${label}</b></td>` +
      Array.from({ length: end - start + 1 }, (_, k) => {
        const i = start + k;
        const value = arr[i];
        return `<td class="mono">${value == null ? "" : String(value)}</td>`;
      }).join("") +
      `<td class="mono"><b${emph}>${total}</b></td>` +
      `<td class="mono"></td>`;
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
  addStablefordRow("Gross Pts", grossStableford, 0, 8, "score-emph-gross");
  if (useHandicap) addStablefordRow("Net Pts", netStableford, 0, 8, "score-emph-net");
  addParRow(0, 8);
  addSectionSpacer();
  addDotsRow(9, 17);
  addHeaderRow("Back 9", 9, 17);
  addDataRow("Gross", gross, 9, 17);
  if (useHandicap) addDataRow("Net", net, 9, 17);
  addStablefordRow("Gross Pts", grossStableford, 9, 17, "score-emph-gross");
  if (useHandicap) addStablefordRow("Net Pts", netStableford, 9, 17, "score-emph-net");
  addParRow(9, 17);

  tbl.appendChild(tbody);
  wrap.appendChild(tbl);
  return wrap;
}

function computeBestBallSelections(memberRows) {
  const net = Array.from({ length: 18 }, () => new Set());

  for (let holeIndex = 0; holeIndex < 18; holeIndex++) {
    let netBest = null;

    memberRows.forEach((row) => {
      const netValue = asPlayedNumber(row?.net?.[holeIndex]);
      if (netValue != null && (netBest == null || netValue < netBest)) netBest = netValue;
    });

    memberRows.forEach((row, playerIndex) => {
      const netValue = asPlayedNumber(row?.net?.[holeIndex]);
      if (netBest != null && netValue === netBest) net[holeIndex].add(playerIndex);
    });
  }

  return { net };
}

function bestBallMarkerForHole(selections, playerIndex, holeIndex, useHandicap) {
  if (!selections) return "";
  const netPicked = !!(useHandicap && selections.net?.[holeIndex]?.has(playerIndex));
  return netPicked ? "*" : "";
}

function buildMemberRowsScorecard(memberRows, par, useHandicap, summaryText, bestBallSelections = null) {
  if (!Array.isArray(memberRows) || !memberRows.length) return null;
  const anyData = memberRows.some((row) => hasAnyScore(row?.gross) || hasAnyScore(row?.net));
  if (!anyData) return null;

  const parTotal18 = segmentTotal(par, 0, 17);
  const wrap = document.createElement("div");
  wrap.className = "scorecard-one-wrap";

  const summary = document.createElement("div");
  summary.className = "small scorecard-summary";
  summary.textContent = summaryText;
  wrap.appendChild(summary);

  const tbl = document.createElement("table");
  tbl.className = "table scorecard-one-table scorecard-team-table";
  const tbody = document.createElement("tbody");

  function addHeaderRow(label, start, end) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<th class="left">${label}</th>` +
      Array.from({ length: end - start + 1 }, (_, k) => `<th class="mono">${start + k + 1}</th>`).join("") +
      `<th>Total</th><th>±</th>`;
    tbody.appendChild(tr);
  }

  function addPlayerRows(start, end) {
    memberRows.forEach((row, playerIndex) => {
      const holes = row.gross;
      const played = holes.slice(start, end + 1).some((v) => v != null && Number(v) > 0);
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td class="left"><b>${row.name}</b></td>` +
        Array.from({ length: end - start + 1 }, (_, k) => {
          const holeIndex = start + k;
          const marker = bestBallMarkerForHole(bestBallSelections, playerIndex, holeIndex, useHandicap);
          return holeScoreCell(holes[holeIndex], par[holeIndex], marker);
        }).join("") +
        `<td class="mono"><b>${played ? segmentTotal(holes, start, end) : ""}</b></td>` +
        `<td class="mono"><b>${played ? toParStrFromDiff(segmentToPar(holes, par, start, end)) : ""}</b></td>`;
      tbody.appendChild(tr);
    });
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

function buildTeamMembersScorecard(roundIndex, teamRow, useHandicap) {
  const teamId = teamRow?.teamId;
  if (!teamId) return null;

  const roundData = TOURN?.score_data?.rounds?.[roundIndex];
  const byPlayer = roundData?.player || null;
  if (!byPlayer) return null;
  const format = String(roundData?.format || "").toLowerCase();
  const isBestBallFormat = format === "team_best_ball";

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
  const par = getCoursePars(roundIndex);
  const selections = isBestBallFormat ? computeBestBallSelections(teamPlayers) : null;
  const summaryText = isBestBallFormat
    ? (useHandicap ? "Team members • * net ball used" : "Team members")
    : (useHandicap ? "Team members (gross rows shown)" : "Team members");
  return buildMemberRowsScorecard(teamPlayers, par, useHandicap, summaryText, selections);
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

function aggregateTwoManGroupHoles(roundData, playerIds, format, metric) {
  if (normalizeTwoManFormat(format) === "two_man_shamble") {
    const out = Array(18).fill(null);
    for (let i = 0; i < 18; i++) {
      let sum = 0;
      let allPresent = (playerIds || []).length > 0;
      for (const playerId of playerIds || []) {
        const value = asPlayedNumber(roundData?.player?.[playerId]?.[metric]?.[i]);
        if (value == null) {
          allPresent = false;
          break;
        }
        sum += value;
      }
      out[i] = allPresent ? sum : null;
    }
    return out;
  }
  return bestBallHolesForPlayers(roundData, playerIds, metric);
}

function handicapShotsFromHoleSets(gross, net) {
  return Array.from({ length: 18 }, (_, i) => {
    const grossValue = asPlayedNumber(gross?.[i]);
    const netValue = asPlayedNumber(net?.[i]);
    if (grossValue == null || netValue == null) return 0;
    return grossValue - netValue;
  });
}

function combineGroupHoleSets(groups) {
  const out = Array(18).fill(null);
  for (let i = 0; i < 18; i++) {
    let sum = 0;
    let count = 0;
    for (const arr of groups || []) {
      const v = asPlayedNumber(arr?.[i]);
      if (v != null) {
        sum += v;
        count += 1;
      }
    }
    out[i] = count > 0 ? sum : null;
  }
  return out;
}

function twoManTeamParFromGroups(par, groups, metric) {
  return Array.from({ length: 18 }, (_, i) => {
    const holePar = Number(par?.[i] || 0);
    let multiplier = 0;
    for (const group of groups || []) {
      const holes = metric === "net" ? group?.net : group?.gross;
      if (asPlayedNumber(holes?.[i]) == null) continue;
      multiplier += Number(group?.parMultiplier || 1);
    }
    return holePar * multiplier;
  });
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

function twoManPairLabelFromIds(playerIds, nameById, fallbackGroupKey) {
  const names = uniqueDisplayNames((playerIds || []).map((id) => nameById.get(String(id || "").trim())));
  if (names.length) return names.join("/");
  const key = normalizeTwoManGroupKey(fallbackGroupKey);
  return key ? `Group ${key}` : "Pair";
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
  const usesCombinedPar = (groups || []).some((g) => Number(g?.parMultiplier || 1) !== 1);
  summary.textContent = labels.length
    ? `Two-man groups${usesCombinedPar ? " • shamble rows use combined par" : ""} • ${labels.join(" • ")}`
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
      Array.from({ length: end - start + 1 }, (_, k) => `<th class="mono">${start + k + 1}</th>`).join("") +
      `<th>Total</th><th>±</th>`;
    tbody.appendChild(tr);
  }

  function addDataRow(label, arr, start, end, parMultiplier = 1) {
    const played = sectionPlayedCount(arr, start, end);
    const rowPar = par.map((value) => Number(value || 0) * parMultiplier);
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
        return holeScoreCell(arr[i], rowPar[i]);
      }).join("") +
      `<td class="mono"><b${emph}>${played ? segmentTotal(arr, start, end) : ""}</b></td>` +
      `<td class="mono"><b${emph}>${played ? toParStrFromDiff(segmentToPar(arr, rowPar, start, end)) : ""}</b></td>`;
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
      addDataRow(`${group.key} Gross`, group.gross, start, end, Number(group?.parMultiplier || 1));
    }
    if (useHandicap) {
      for (const group of groups) {
        addDataRow(`${group.key} Net`, group.net, start, end, Number(group?.parMultiplier || 1));
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

  const teamEntry = roundData?.team?.[teamId] || {};
  const twoManFormat = normalizeTwoManFormat(roundData?.format);
  const groupKeys = twoManGroupKeysForTeam(teamId, roundIndex, teamEntry);
  const nameById = playerNameMap();
  const groups = groupKeys.map((key) => {
    const entry = twoManGroupEntry(teamEntry, key);
    const ids = playerIdsForTwoManGroup(teamId, roundIndex, key, entry?.playerIds);
    const parMultiplier = twoManFormat === "two_man_shamble" ? Math.max(1, ids.length) : 1;
    return {
      key,
      names: ids.map((id) => nameById.get(id) || id),
      parMultiplier,
      gross: Array.isArray(entry?.gross)
        ? entry.gross
        : aggregateTwoManGroupHoles(roundData, ids, twoManFormat, "gross"),
      net: Array.isArray(entry?.net)
        ? entry.net
        : aggregateTwoManGroupHoles(roundData, ids, twoManFormat, "net")
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
  const teamGrossPar = twoManTeamParFromGroups(par, groups, "gross");
  const teamNetPar = twoManTeamParFromGroups(par, groups, "net");
  const teamScores = {
    gross: teamGross,
    net: teamNet,
    handicapShots: Array.isArray(teamEntry?.handicapShots) ? teamEntry.handicapShots : Array(18).fill(0),
    par: useHandicap ? teamNetPar : teamGrossPar,
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

function buildTwoManBestBallGroupScorecard(roundIndex, groupRow, useHandicap) {
  const teamId = String(groupRow?.teamId || "").trim();
  const groupKey = normalizeTwoManGroupKey(groupRow?.groupKey || String(groupRow?.groupId || "").split("::")[1] || "");
  if (!teamId || !groupKey) return null;

  const roundData = TOURN?.score_data?.rounds?.[roundIndex] || {};
  const playerIds = playerIdsForTwoManGroup(teamId, roundIndex, groupKey);
  if (!playerIds.length) return null;

  const memberRows = playerIds.map((playerId) => {
    const playerMeta = (TOURN?.players || []).find((player) => String(player?.playerId || "").trim() === playerId) || {};
    const entry = roundData?.player?.[playerId] || {};
    return {
      name: playerMeta?.name || playerId,
      gross: Array.isArray(entry?.gross) ? entry.gross : Array(18).fill(null),
      net: Array.isArray(entry?.net) ? entry.net : Array(18).fill(null)
    };
  });

  const par = getCoursePars(roundIndex);
  const selections = computeBestBallSelections(memberRows);
  const summaryText = useHandicap ? "Group members • * net ball used" : "Group members";
  const memberTable = buildMemberRowsScorecard(memberRows, par, useHandicap, summaryText, selections);
  if (!memberTable) return null;

  const teamEntry = roundData?.team?.[teamId] || {};
  const groupEntry = twoManGroupEntry(teamEntry, groupKey);
  const twoManFormat = normalizeTwoManFormat(roundData?.format);
  const parMultiplier = twoManFormat === "two_man_shamble" ? Math.max(1, playerIds.length) : 1;
  const groupGross = Array.isArray(groupEntry?.gross)
    ? groupEntry.gross
    : aggregateTwoManGroupHoles(roundData, playerIds, twoManFormat, "gross");
  const groupNet = Array.isArray(groupEntry?.net)
    ? groupEntry.net
    : aggregateTwoManGroupHoles(roundData, playerIds, twoManFormat, "net");
  const groupPar = par.map((value) => Number(value || 0) * parMultiplier);
  const groupScores = {
    gross: groupGross,
    net: groupNet,
    handicapShots: Array.isArray(groupEntry?.handicapShots) ? groupEntry.handicapShots : handicapShotsFromHoleSets(groupGross, groupNet),
    par: groupPar,
    grossTotal: groupEntry?.grossTotal,
    netTotal: groupEntry?.netTotal,
    grossToParTotal: groupEntry?.grossToParTotal,
    netToParTotal: groupEntry?.netToParTotal,
    thru: groupEntry?.thru
  };

  const split = document.createElement("div");
  split.className = "scorecard-split";
  split.appendChild(memberTable);
  split.appendChild(buildScorecardTable(groupScores, useHandicap));
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
    const parByHole =
      Array.isArray(scores?.par) && scores.par.length === 18
        ? scores.par
        : par;
    return {
      gross,
      net,
      handicapShots: Array.isArray(scores?.handicapShots) ? scores.handicapShots : Array(18).fill(0),
      par: parByHole,
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
  const isTwoManGroupView = !isTeam && !isAllRounds && isTwoManRound(data.view?.round);
  const allowInlineScorecard = data.view?.round !== "all";
  const showGrossNet = isHandicapRound(data.view?.round) || isAllRounds;
  const showStableford = isStablefordTournament();
  const showHandicapNameStrokes = isHandicapRound(data.view?.round);
  const showStrokesColumn = isTeam && isAllRounds && !showStableford;
  const defaultSortDir = showStableford ? "desc" : "asc";
  if (lbTitle) {
    lbTitle.textContent = isTeam ? "Teams" : isTwoManGroupView ? "Groups" : "Individuals";
  }
  rebuildTeamColors();

  const head = document.getElementById("lb_head");
  const prevSortKey = sortState?.key || "score";
  const defaultSortKey = showStableford ? "net" : (showGrossNet ? "net" : "toPar");
  const allowedSortKeys = isAllRounds
    ? new Set(showStableford
      ? ["name", ...(showGrossNet ? ["gross", "net"] : ["toPar"]), "score"]
      : (showStrokesColumn ? ["name", "net", "netStrokes", "score"] : ["name", "net", "score"]))
    : showGrossNet
      ? new Set(["name", "thru", "gross", "net", "score"])
      : new Set(["name", "toPar", "thru", "score"]);
  if (!allowedSortKeys.has(prevSortKey)) sortState = { key: defaultSortKey, dir: defaultSortDir };
  if (sortState.key === "score") sortState = { key: defaultSortKey, dir: defaultSortDir };

  function headBtn(label, key, left = false) {
    return `<button type="button" class="sort-head-btn ${left ? "left" : ""}" data-sort-key="${key}">${label}</button>`;
  }
  const nameHeading = isTeam ? "Team" : isTwoManGroupView ? "Group" : "Player";

  if (showStableford && showGrossNet) {
    head.innerHTML = `
      <th class="rank-col"></th>
      <th class="left name-col">${headBtn(nameHeading, "name", true)}</th>
      <th class="metric-col">${headBtn('<span class="score-emph-gross">Gross Pts</span>', "gross")}</th>
      <th class="metric-col">${headBtn('<span class="score-emph-net">Net Pts</span>', "net")}</th>
      ${isAllRounds ? "" : `<th class="thru-col">${headBtn("Thru", "thru")}</th>`}
    `;
  } else if (showGrossNet && isAllRounds) {
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
  } else if (showStableford) {
    head.innerHTML = `
      <th class="rank-col"></th>
      <th class="left name-col">${headBtn(nameHeading, "name", true)}</th>
      <th class="metric-col">${headBtn("Pts", "toPar")}</th>
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
  const sortedRows = sortLeaderboardRows(rows, data, isTeam, showGrossNet);

  const colCount = leaderboardColCount(data);
  const rowByKey = new Map();
  head.querySelectorAll("button[data-sort-key]").forEach((btn) => {
    btn.onclick = () => {
      const key = btn.dataset.sortKey;
      if (!key) return;
      if (sortState.key === key) {
        sortState = { key, dir: sortState.dir === "asc" ? "desc" : "asc" };
      } else {
        const metricSort = key === "gross" || key === "net" || key === "toPar" || key === "score";
        sortState = { key, dir: showStableford && metricSort ? "desc" : "asc" };
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
    const baseName = isTeam ? r.teamName : r.name;
    const displayName = baseName || (isTeam ? "Team" : "Player");
    const handicapSuffix = showHandicapNameStrokes ? handicapStrokesLabelForRow(r) : "";

    const nameCell = `
      <td class="left name-col">
        <div class="${isTeam ? "team-accent" : ""}" style="--team-accent:${teamColor};">
          <b>${displayName}</b>${handicapSuffix ? `<span style="font-size:calc(1em - 2px); font-weight:400;">${handicapSuffix}</span>` : ""}
        </div>
        ${!isTeam && r.teamName ? `<div class="small muted team-accent team-accent-sub" style="--team-accent:${teamColor};">${r.teamName}</div>` : ""}
      </td>
    `;
    const shouldShowTeeTime = !hasData && r?.teeTime && (!isTeam || isScrambleRound(data.view?.round));
    const thruCell = shouldShowTeeTime ? r.teeTime : displayThru(r.thruDisplay ?? r.thru);

    if (showStableford && showGrossNet) {
      tr.innerHTML = `
        <td class="mono rank-col">${rankCellValue}</td>
        ${nameCell}
        <td class="mono metric-col"><b class="score-emph-gross">${scoreValue(grossStablefordForRow(r))}</b></td>
        <td class="mono metric-col"><b class="score-emph-net">${scoreValue(netStablefordForRow(r))}</b></td>
        ${isAllRounds ? "" : `<td class="mono thru-col">${thruCell}</td>`}
      `;
    } else if (showGrossNet && isAllRounds) {
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
    } else if (showStableford) {
      tr.innerHTML = `
        <td class="mono rank-col">${rankCellValue}</td>
        ${nameCell}
        <td class="mono metric-col"><b>${scoreValue(firstDefined(r, ["points", "grossPoints", "netPoints"]))}</b></td>
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
          const teamTable = isTwoManRound(data.view?.round)
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

        if (!isTeam && r?.groupId && normalizeTwoManFormat(roundAt(data.view?.round)?.format) === "two_man_best_ball") {
          const groupTable = buildTwoManBestBallGroupScorecard(rIdx, r, showGrossNet);
          if (token !== inlineReqToken || openInlineKey !== key) return;
          if (groupTable) {
            loading.remove();
            const grid = document.createElement("div");
            grid.className = "scoregrid inline-scoregrid";
            grid.style.marginTop = "0";
            grid.appendChild(groupTable);
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

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function hashString(value) {
  const text = String(value || "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hexToRgb(hex) {
  const raw = String(hex || "").trim();
  const normalized = raw.replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return null;
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16)
  };
}

function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map((v) => clampNumber(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

function rgbToHsl({ r, g, b }) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  switch (max) {
    case rn:
      h = (gn - bn) / d + (gn < bn ? 6 : 0);
      break;
    case gn:
      h = (bn - rn) / d + 2;
      break;
    default:
      h = (rn - gn) / d + 4;
      break;
  }
  return { h: h * 60, s, l };
}

function hslToRgb({ h, s, l }) {
  const hue = ((h % 360) + 360) % 360;
  const sat = clampNumber(s, 0, 1);
  const light = clampNumber(l, 0, 1);
  if (sat === 0) {
    const gray = Math.round(light * 255);
    return { r: gray, g: gray, b: gray };
  }

  const c = (1 - Math.abs((2 * light) - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - (c / 2);
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (hue < 60) {
    r1 = c; g1 = x; b1 = 0;
  } else if (hue < 120) {
    r1 = x; g1 = c; b1 = 0;
  } else if (hue < 180) {
    r1 = 0; g1 = c; b1 = x;
  } else if (hue < 240) {
    r1 = 0; g1 = x; b1 = c;
  } else if (hue < 300) {
    r1 = x; g1 = 0; b1 = c;
  } else {
    r1 = c; g1 = 0; b1 = x;
  }

  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255)
  };
}

const TEAM_LINE_PATTERNS = [
  "",
  "9 6",
  "2 6",
  "10 4 2 4"
];

function graphColorForRow(row, isTeam, index) {
  const base = colorForTeam(row?.teamId, row?.teamName) || "#5a9fd0";
  if (isTeam || row?.teamId) return base;

  const rgb = hexToRgb(base);
  if (!rgb) {
    const hue = hashString(row?.playerId || row?.groupId || row?.name || index) % 360;
    return rgbToHex(hslToRgb({ h: hue, s: 0.58, l: 0.5 }));
  }

  const hsl = rgbToHsl(rgb);
  const hash = hashString(row?.playerId || row?.groupId || row?.name || index);
  const hueShift = (hash % 55) - 27;
  const satShift = (((hash >> 8) % 21) - 10) / 100;
  const lightShift = (((hash >> 16) % 25) - 12) / 100;
  return rgbToHex(hslToRgb({
    h: hsl.h + hueShift,
    s: clampNumber(hsl.s + satShift, 0.38, 0.88),
    l: clampNumber(hsl.l + lightShift, 0.3, 0.68)
  }));
}

function graphPatternForOrdinal(ordinal) {
  const idx = Math.max(0, Number(ordinal) || 0) % TEAM_LINE_PATTERNS.length;
  return TEAM_LINE_PATTERNS[idx];
}

function niceStep(range, targetTickCount = 5) {
  const safeRange = Math.max(Number(range) || 0, 1);
  const rough = safeRange / Math.max(1, targetTickCount);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  let step = 1;
  if (normalized > 1) step = 2;
  if (normalized > 2) step = 5;
  if (normalized > 5) step = 10;
  return step * magnitude;
}

function toParAxisLabel(value) {
  return toParStrFromDiff(Math.round(Number(value) || 0));
}

function graphSeriesFromRow(row, metric, data) {
  const scores = normalizeScoreBundle(row, row?.scores || {}, data?.course?.pars || []);
  const diffs = metric === "net" ? scores.netToPar : scores.grossToPar;
  const series = Array(18).fill(null);
  let running = 0;
  let thru = 0;

  for (let i = 0; i < 18; i++) {
    const diff = diffs?.[i];
    const played =
      diff != null ||
      asPlayedNumber(metric === "net" ? scores.net?.[i] : scores.gross?.[i]) != null;
    if (!played) continue;
    running += diff == null ? 0 : Number(diff) || 0;
    series[i] = Number(running.toFixed(2));
    thru = i + 1;
  }

  return {
    values: series,
    thru,
    current: thru ? series[thru - 1] : null
  };
}

function svgNode(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  Object.entries(attrs).forEach(([key, value]) => {
    if (value == null) return;
    node.setAttribute(key, String(value));
  });
  return node;
}

function buildStepPath(pointPairs) {
  if (!Array.isArray(pointPairs) || !pointPairs.length) return "";
  let path = `M ${pointPairs[0][0]} ${pointPairs[0][1]}`;
  for (let i = 1; i < pointPairs.length; i++) {
    const [prevX, prevY] = pointPairs[i - 1];
    const [x, y] = pointPairs[i];
    path += ` H ${x} V ${y}`;
  }
  return path;
}

function renderTrendGraph(data) {
  if (!trendMeta || !trendSvg || !trendLegend || !trendEmpty || !trendGraphShell) return;

  const isTeam = mode === "team";
  const isAllRounds = data.view?.round === "all";
  const isPhoneWidth = typeof window !== "undefined" && window.innerWidth <= 560;
  const showGrossNet = isHandicapRound(data.view?.round) || isAllRounds;
  const isTwoManGroupView = !isTeam && !isAllRounds && isTwoManRound(data.view?.round);
  const entityLabel = isTeam ? "teams" : isTwoManGroupView ? "groups" : "players";

  syncTrendMetricButtons();
  if (btnTrendGross) btnTrendGross.disabled = isAllRounds;
  if (btnTrendNet) btnTrendNet.disabled = isAllRounds || !canUseNetMetric(data.view?.round);

  trendSvg.replaceChildren();
  trendLegend.replaceChildren();

  if (isAllRounds) {
    trendMeta.textContent = "Pick a specific round to chart score to par hole-by-hole.";
    trendEmpty.hidden = false;
    trendEmpty.textContent = "All-rounds view combines rounds, so there is no single hole-by-hole progression to plot.";
    trendGraphShell.hidden = true;
    return;
  }

  const rows = isTeam ? data.teams || [] : data.players || [];
  const sortedRows = sortLeaderboardRows(rows, data, isTeam, showGrossNet)
    .map(({ row }) => row)
    .filter((row) => rowHasAnyData(row));

  const teamSeriesCounts = new Map();
  const seriesRows = sortedRows.map((row, index) => {
    const teamKey = normalizeTeamId(row?.teamId) || `solo:${rowStableId(row, isTeam)}`;
    const teamOrdinal = teamSeriesCounts.get(teamKey) || 0;
    teamSeriesCounts.set(teamKey, teamOrdinal + 1);
    const trend = graphSeriesFromRow(row, graphMetric, data);
    return {
      row,
      color: graphColorForRow(row, isTeam, index),
      dasharray: isTeam ? "" : graphPatternForOrdinal(teamOrdinal),
      values: trend.values,
      thru: trend.thru,
      current: trend.current
    };
  }).filter((entry) => entry.thru > 0 && entry.current != null);

  const metricLabel = graphMetric === "net" ? "Net" : "Gross";
  const metricHint = graphMetric === "net" && !showGrossNet ? " (same as gross in this round)" : "";

  if (!seriesRows.length) {
    trendMeta.textContent = `${viewRoundLabel(data.view.round)} • ${metricLabel} score to par${metricHint}`;
    trendEmpty.hidden = false;
    trendEmpty.textContent = `No ${entityLabel} have posted hole-by-hole scores yet.`;
    trendGraphShell.hidden = true;
    return;
  }

  trendMeta.textContent =
    `${viewRoundLabel(data.view.round)} • ${seriesRows.length} ${entityLabel} • ${metricLabel} score to par after each completed hole${metricHint}`;
  trendEmpty.hidden = true;
  trendGraphShell.hidden = false;

  const plot = isPhoneWidth
    ? { width: 760, height: 760, left: 82, right: 28, top: 26, bottom: 82 }
    : { width: 760, height: 320, left: 60, right: 14, top: 14, bottom: 28 };
  trendSvg.setAttribute("viewBox", `0 0 ${plot.width} ${plot.height}`);

  const allValues = seriesRows.flatMap((entry) => entry.values.filter((value) => value != null));
  const rawMin = Math.min(0, ...allValues);
  const rawMax = Math.max(0, ...allValues);
  const step = niceStep(rawMax - rawMin, 5);
  let yMin = Math.floor(rawMin);
  let yMax = Math.ceil(rawMax);
  yMin = Math.floor(yMin / step) * step;
  yMax = Math.ceil(yMax / step) * step;
  if (yMin === yMax) {
    yMin -= step;
    yMax += step;
  }

  const plotWidth = plot.width - plot.left - plot.right;
  const plotHeight = plot.height - plot.top - plot.bottom;
  const xForHole = (holeIndex) => plot.left + (plotWidth * (holeIndex / 17));
  const yForValue = (value) => plot.top + ((yMax - value) / (yMax - yMin)) * plotHeight;

  const tickValues = [];
  for (let value = yMin; value <= yMax + (step / 2); value += step) {
    tickValues.push(Math.round(value));
  }

  for (let stroke = Math.ceil(yMin); stroke <= Math.floor(yMax); stroke++) {
    if (tickValues.some((tick) => Math.abs(tick - stroke) < 0.001)) continue;
    trendSvg.appendChild(svgNode("line", {
      x1: plot.left,
      y1: yForValue(stroke),
      x2: plot.width - plot.right,
      y2: yForValue(stroke),
      class: "trend-grid-line-light"
    }));
  }

  tickValues.forEach((tick) => {
    const y = yForValue(tick);
    const line = svgNode("line", {
      x1: plot.left,
      y1: y,
      x2: plot.width - plot.right,
      y2: y,
      class: Math.abs(tick) < 0.001 ? "trend-zero-line" : "trend-grid-line"
    });
    trendSvg.appendChild(line);

    const label = svgNode("text", {
      x: plot.left - 8,
      y: y + 4,
      "text-anchor": "end",
      class: `trend-axis-label${Math.abs(tick) < 0.001 ? " trend-axis-label-even" : ""}`
    });
    label.textContent = toParAxisLabel(tick);
    trendSvg.appendChild(label);
  });

  const labeledHoles = isPhoneWidth
    ? new Set([0, 2, 4, 6, 8, 10, 12, 14, 16, 17])
    : new Set(Array.from({ length: 18 }, (_, holeIndex) => holeIndex));
  Array.from({ length: 18 }, (_, holeIndex) => holeIndex).forEach((holeIndex) => {
    const x = xForHole(holeIndex);
    trendSvg.appendChild(svgNode("line", {
      x1: x,
      y1: plot.top,
      x2: x,
      y2: plot.height - plot.bottom,
      class: "trend-grid-line-light"
    }));
    if (!labeledHoles.has(holeIndex)) return;
    const label = svgNode("text", {
      x,
      y: plot.height - 12,
      "text-anchor": "middle",
      class: "trend-hole-label"
    });
    label.textContent = String(holeIndex + 1);
    trendSvg.appendChild(label);
  });

  seriesRows.slice().reverse().forEach((entry, indexFromBack) => {
    const pointPairs = entry.values
      .map((value, holeIndex) => (value == null ? null : [xForHole(holeIndex), yForValue(value)]))
      .filter(Boolean);
    if (!pointPairs.length) return;

    const path = svgNode("path", {
      d: buildStepPath(pointPairs),
      stroke: entry.color,
      "stroke-dasharray": entry.dasharray || null,
      "stroke-width": isPhoneWidth
        ? (indexFromBack === seriesRows.length - 1 ? 4 : 3)
        : (indexFromBack === seriesRows.length - 1 ? 3 : 2),
      opacity: indexFromBack === seriesRows.length - 1 ? 1 : 0.84,
      class: "trend-series-line"
    });
    trendSvg.appendChild(path);

    const [endX, endY] = pointPairs[pointPairs.length - 1];
    trendSvg.appendChild(svgNode("circle", {
      cx: endX,
      cy: endY,
      r: isPhoneWidth ? 6 : 4,
      fill: entry.color,
      class: "trend-series-dot"
    }));
  });

  const yTitle = svgNode("text", {
    x: 14,
    y: plot.top + (plotHeight / 2) + 10,
    transform: `rotate(-90 14 ${plot.top + (plotHeight / 2)})`,
    "text-anchor": "middle",
    class: "trend-axis-label"
  });
  yTitle.textContent = `${metricLabel} to par`;
  trendSvg.appendChild(yTitle);

  seriesRows.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "trend-legend-item";
    item.style.setProperty("--trend-color", entry.color);

    const top = document.createElement("div");
    top.className = "trend-legend-top";

    const nameWrap = document.createElement("div");
    nameWrap.className = "trend-legend-name";

    const swatch = document.createElement("span");
    swatch.className = "trend-legend-swatch";
    swatch.style.background = "transparent";
    swatch.style.borderTop = `3px ${entry.dasharray ? "dashed" : "solid"} ${entry.color}`;
    if (entry.dasharray === "2 6") {
      swatch.style.borderTopStyle = "dotted";
    } else if (entry.dasharray === "10 4 2 4") {
      swatch.style.background = `repeating-linear-gradient(90deg, ${entry.color} 0 10px, transparent 10px 14px, ${entry.color} 14px 16px, transparent 16px 20px)`;
      swatch.style.borderTop = "0";
      swatch.style.height = "3px";
    }
    nameWrap.appendChild(swatch);

    const label = document.createElement("span");
    label.className = "trend-legend-label";
    label.textContent = isTeam ? (entry.row?.teamName || "Team") : (entry.row?.name || "Player");
    nameWrap.appendChild(label);

    const meta = document.createElement("span");
    meta.className = "trend-legend-meta";
    const teeTime = String(entry.row?.teeTime || "").trim();
    meta.textContent = entry.thru > 0
      ? `(${displayThru(entry.thru)})`
      : (teeTime ? `(${teeTime})` : "");
    if (meta.textContent) {
      nameWrap.appendChild(meta);
    }
    top.appendChild(nameWrap);

    const score = document.createElement("b");
    score.className = `trend-legend-score ${graphMetric === "net" ? "score-emph-net" : "score-emph-gross"}`;
    score.textContent = toParDisplay(entry.current);
    top.appendChild(score);

    const sub = document.createElement("div");
    sub.className = "small";
    sub.textContent = isTeam
      ? `Thru ${displayThru(entry.thru)}`
      : `${entry.row?.teamName || "Team"} • Thru ${displayThru(entry.thru)}`;

    item.appendChild(top);
    item.appendChild(sub);
    trendLegend.appendChild(item);
  });
}

function viewRoundLabel(viewRound) {
  return viewRound === "all" ? "Tournament" : `Round ${Number(viewRound) + 1}`;
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

function normalizePlayedHoleArray(arr) {
  if (!Array.isArray(arr) || arr.length !== 18) return Array(18).fill(null);
  return arr.map((value) => asPlayedNumber(value));
}

function deriveParArrayFromEntry(entry, fallbackPar = []) {
  if (Array.isArray(entry?.par) && entry.par.length === 18) {
    return entry.par.map((value, index) => {
      const n = Number(value);
      return Number.isFinite(n) ? n : Number(fallbackPar?.[index] || 0);
    });
  }

  const gross = normalizePlayedHoleArray(entry?.gross);
  const net = normalizePlayedHoleArray(entry?.net);
  const grossToPar = Array.isArray(entry?.grossToPar) ? entry.grossToPar : Array(18).fill(null);
  const netToPar = Array.isArray(entry?.netToPar) ? entry.netToPar : Array(18).fill(null);

  return Array.from({ length: 18 }, (_, index) => {
    const grossValue = gross[index];
    const grossDiff = toParNumber(grossToPar[index]);
    if (grossValue != null && grossDiff != null) return grossValue - grossDiff;

    const netValue = net[index];
    const netDiff = toParNumber(netToPar[index]);
    if (netValue != null && netDiff != null) return netValue - netDiff;

    return Number(fallbackPar?.[index] || 0);
  });
}

function aggregateNumbers(values) {
  if (!values.length) return null;
  const total = values.reduce((a, v) => a + Number(v || 0), 0);
  return total;
}

function playedHoleCountFromArrays(gross, net) {
  let count = 0;
  for (let i = 0; i < 18; i++) {
    if (asPlayedNumber(gross?.[i]) != null || asPlayedNumber(net?.[i]) != null) count += 1;
  }
  return count;
}

function thruRangeLabel(minThru, maxThru) {
  if (!Number.isFinite(minThru) || minThru <= 0) return null;
  if (!Number.isFinite(maxThru) || maxThru <= 0) return displayThru(minThru);
  if (minThru >= maxThru) return displayThru(minThru);
  return `${displayThru(minThru)}-${displayThru(maxThru)}`;
}

function teamThruDisplayForRound(tournamentJson, roundIndex, roundData, teamId) {
  const normalizedTeamId = normalizeTeamId(teamId);
  if (!normalizedTeamId) return null;

  const values = [];
  const knownPlayerIds = new Set();
  (tournamentJson?.players || []).forEach((player) => {
    if (normalizeTeamId(player?.teamId) !== normalizedTeamId) return;
    const playerId = String(player?.playerId || "").trim();
    if (playerId) knownPlayerIds.add(playerId);
  });

  Object.entries(roundData?.player || {}).forEach(([playerId, entry]) => {
    const entryTeamId = normalizeTeamId(entry?.teamId);
    if (!knownPlayerIds.has(String(playerId || "").trim()) && entryTeamId !== normalizedTeamId) return;
    const thru = playedHoleCountFromArrays(entry?.gross, entry?.net);
    if (thru > 0) values.push(thru);
  });

  if (!values.length) {
    const roundCfg = (tournamentJson?.tournament?.rounds || [])[roundIndex] || {};
    const twoManFormat = normalizeTwoManFormat(String(roundCfg?.format || roundData?.format || "").toLowerCase());
    if (twoManFormat) {
      const teamEntry = roundData?.team?.[normalizedTeamId] || {};
      const groupKeys = twoManGroupKeysForTeam(normalizedTeamId, roundIndex, teamEntry);
      groupKeys.forEach((key) => {
        const entry = twoManGroupEntry(teamEntry, key);
        const thru = playedHoleCountFromArrays(entry?.gross, entry?.net);
        if (thru > 0) values.push(thru);
      });
    }
  }

  if (!values.length) return null;
  return thruRangeLabel(Math.min(...values), Math.max(...values));
}

function attachTeamThruDisplay(rows, tournamentJson, roundIndex, roundData) {
  return (rows || []).map((row) => {
    const teamId = normalizeTeamId(row?.teamId);
    if (!teamId) return row;
    const thruDisplay = teamThruDisplayForRound(tournamentJson, roundIndex, roundData, teamId);
    return thruDisplay ? { ...row, thruDisplay } : row;
  });
}

function toParArrayFromHoles(holes, parByHole) {
  return Array.from({ length: 18 }, (_, i) => {
    const score = asPlayedNumber(holes?.[i]);
    if (score == null) return null;
    return score - Number(parByHole?.[i] || 0);
  });
}

function stablefordArrayFromHoles(holes, parByHole) {
  return Array.from({ length: 18 }, (_, i) => {
    const score = asPlayedNumber(holes?.[i]);
    if (score == null) return null;
    return Math.max(0, 2 + Number(parByHole?.[i] || 0) - score);
  });
}

function normalizeScoreBundle(row = {}, scores = {}, fallbackPar = []) {
  const par = (
    Array.isArray(scores?.par) && scores.par.length === 18
      ? scores.par
      : Array.isArray(row?.scores?.par) && row.scores.par.length === 18
        ? row.scores.par
        : Array.isArray(fallbackPar) && fallbackPar.length === 18
          ? fallbackPar
          : Array(18).fill(4)
  ).map((v) => Number(v) || 0);

  const gross = (
    Array.isArray(scores?.gross) && scores.gross.length === 18
      ? scores.gross
      : Array.isArray(row?.scores?.gross) && row.scores.gross.length === 18
        ? row.scores.gross
        : Array(18).fill(null)
  ).slice();

  const netSource =
    Array.isArray(scores?.net) && scores.net.length === 18
      ? scores.net
      : Array.isArray(row?.scores?.net) && row.scores.net.length === 18
        ? row.scores.net
        : gross;
  const net = netSource.map((value, index) => {
    if (value != null) return value;
    return gross[index] != null ? gross[index] : null;
  });

  const grossToPar = (
    Array.isArray(scores?.grossToPar) && scores.grossToPar.length === 18
      ? scores.grossToPar
      : Array.isArray(row?.scores?.grossToPar) && row.scores.grossToPar.length === 18
        ? row.scores.grossToPar
        : toParArrayFromHoles(gross, par)
  ).slice();

  const netToPar = (
    Array.isArray(scores?.netToPar) && scores.netToPar.length === 18
      ? scores.netToPar
      : Array.isArray(row?.scores?.netToPar) && row.scores.netToPar.length === 18
        ? row.scores.netToPar
        : toParArrayFromHoles(net, par)
  ).slice();

  const handicapShots = (
    Array.isArray(scores?.handicapShots) && scores.handicapShots.length === 18
      ? scores.handicapShots
      : Array.isArray(row?.scores?.handicapShots) && row.scores.handicapShots.length === 18
        ? row.scores.handicapShots
        : Array(18).fill(0)
  ).slice();
  const actualReady = (
    Array.isArray(scores?.actualReady) && scores.actualReady.length === 18
      ? scores.actualReady
      : Array.isArray(row?.scores?.actualReady) && row.scores.actualReady.length === 18
        ? row.scores.actualReady
        : null
  )?.slice() || null;

  const grossTotal = firstDefined(scores, ["grossTotal"]) ?? firstDefined(row, ["gross", "grossTotal"]) ?? sumHoles(gross);
  const netTotal = firstDefined(scores, ["netTotal"]) ?? firstDefined(row, ["net", "netTotal", "strokes"]) ?? sumHoles(net);
  const grossStableford = (
    Array.isArray(scores?.grossStableford) && scores.grossStableford.length === 18
      ? scores.grossStableford
      : Array.isArray(row?.scores?.grossStableford) && row.scores.grossStableford.length === 18
        ? row.scores.grossStableford
        : stablefordArrayFromHoles(gross, par)
  ).slice();
  const netStableford = (
    Array.isArray(scores?.netStableford) && scores.netStableford.length === 18
      ? scores.netStableford
      : Array.isArray(row?.scores?.netStableford) && row.scores.netStableford.length === 18
        ? row.scores.netStableford
        : stablefordArrayFromHoles(net, par)
  ).slice();
  const grossToParTotal =
    toParNumber(firstDefined(scores, ["grossToParTotal"])) ??
    toParNumber(firstDefined(row, ["toParGross", "grossToPar", "grossToParTotal"])) ??
    grossToPar.reduce((acc, value) => acc + (value == null ? 0 : Number(value) || 0), 0);
  const netToParTotal =
    toParNumber(firstDefined(scores, ["netToParTotal"])) ??
    toParNumber(firstDefined(row, ["toParNet", "netToPar", "netToParTotal", "toPar"])) ??
    netToPar.reduce((acc, value) => acc + (value == null ? 0 : Number(value) || 0), 0);
  const grossStablefordTotal =
    firstDefined(scores, ["grossStablefordTotal"]) ??
    firstDefined(row, ["grossPoints", "grossStablefordTotal"]) ??
    grossStableford.reduce((acc, value) => acc + (value == null ? 0 : Number(value) || 0), 0);
  const netStablefordTotal =
    firstDefined(scores, ["netStablefordTotal"]) ??
    firstDefined(row, ["points", "netPoints", "netStablefordTotal"]) ??
    netStableford.reduce((acc, value) => acc + (value == null ? 0 : Number(value) || 0), 0);
  const thru =
    firstDefined(scores, ["thru"]) ??
    firstDefined(row, ["thru"]) ??
    playedHoleCountFromArrays(gross, net);

  return {
    gross,
    net,
    par,
    grossToPar,
    netToPar,
    grossStableford,
    netStableford,
    handicapShots,
    actualReady,
    grossTotal,
    netTotal,
    grossToParTotal,
    netToParTotal,
    grossStablefordTotal,
    netStablefordTotal,
    thru
  };
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
    const gross = normalizePlayedHoleArray(entry?.gross);
    const netInput = Array.isArray(entry?.net) && entry.net.length === 18 ? entry.net : gross;
    const net = netInput.map((value, index) => {
      const normalized = asPlayedNumber(value);
      return normalized != null ? normalized : gross[index];
    });
    const par = deriveParArrayFromEntry(entry, coursePars);
    const scoreBundle = normalizeScoreBundle(
      {},
      {
        gross,
        net,
        par,
        handicapShots: Array.isArray(entry?.handicapShots) ? entry.handicapShots : Array(18).fill(0)
      },
      coursePars
    );
    const actualReady = Array.from({ length: 18 }, (_, holeIndex) => {
      const hasTeamScore =
        asPlayedNumber(gross?.[holeIndex]) != null ||
        asPlayedNumber(net?.[holeIndex]) != null;
      if (!hasTeamScore) return false;

      const groups = Object.values(entry?.groups || {});
      if (!groups.length) return true;

      return groups.every((groupEntry) =>
        asPlayedNumber(groupEntry?.gross?.[holeIndex]) != null ||
        asPlayedNumber(groupEntry?.net?.[holeIndex]) != null
      );
    });
    rows.push({
      teamId,
      teamName: teamNames.get(teamId) || teamId || "Team",
      thru: scoreBundle.thru,
      gross: scoreBundle.grossTotal,
      net: scoreBundle.netTotal,
      points: scoreBundle.netStablefordTotal,
      grossPoints: scoreBundle.grossStablefordTotal,
      netPoints: scoreBundle.netStablefordTotal,
      strokes: useHandicap ? scoreBundle.netTotal : scoreBundle.grossTotal,
      toPar: useHandicap ? scoreBundle.netToParTotal : scoreBundle.grossToParTotal,
      toParGross: scoreBundle.grossToParTotal,
      toParNet: scoreBundle.netToParTotal,
      scores: {
        ...scoreBundle,
        actualReady
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
    const parByHole = Array(18).fill(0);
    const grossToPar = Array(18).fill(null);
    const netToPar = Array(18).fill(null);
    const grossStableford = Array(18).fill(null);
    const netStableford = Array(18).fill(null);
    const selectedCountByHole = Array(18).fill(0);
    const actualReady = Array(18).fill(false);

    for (let i = 0; i < 18; i++) {
      const candidates = [];
      let completeCount = 0;
      for (const p of teamPlayers) {
        const grossScore = asPlayedNumber(p.gross?.[i]);
        const netRaw = asPlayedNumber(p.net?.[i]);
        const netScore = netRaw != null ? netRaw : grossScore;
        if (grossScore != null || netScore != null) completeCount += 1;
        const metricScore = useHandicap ? netScore : grossScore;
        if (metricScore == null) continue;
        candidates.push({ gross: grossScore, net: netScore, metric: metricScore });
      }
      actualReady[i] = teamPlayers.length > 0 && completeCount === teamPlayers.length;
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
      parByHole[i] = parBase;
      const grossV = grossHoles[i];
      const netV = netHoles[i];
      if (grossV != null) {
        grossToPar[i] = Number(grossV) - parBase;
        grossToParTotal += grossToPar[i];
        grossStableford[i] = Math.max(0, 2 + parBase - Number(grossV));
      }
      if (netV != null) {
        netToPar[i] = Number(netV) - parBase;
        netToParTotal += netToPar[i];
        netStableford[i] = Math.max(0, 2 + parBase - Number(netV));
      }
    }

    rows.push({
      teamId,
      teamName: teamNames.get(teamId) || teamId || "Team",
      thru,
      gross: grossTotal,
      net: netTotal,
      points: netStableford.reduce((acc, value) => acc + (value == null ? 0 : Number(value) || 0), 0),
      grossPoints: grossStableford.reduce((acc, value) => acc + (value == null ? 0 : Number(value) || 0), 0),
      netPoints: netStableford.reduce((acc, value) => acc + (value == null ? 0 : Number(value) || 0), 0),
      strokes: useHandicap ? netTotal : grossTotal,
      toPar: useHandicap ? netToParTotal : grossToParTotal,
      toParGross: grossToParTotal,
      toParNet: netToParTotal,
      scores: {
        gross: grossHoles,
        net: netHoles,
        par: parByHole,
        actualReady,
        grossToPar,
        netToPar,
        grossStableford,
        netStableford,
        grossTotal,
        netTotal,
        grossToParTotal,
        netToParTotal,
        grossStablefordTotal: grossStableford.reduce((acc, value) => acc + (value == null ? 0 : Number(value) || 0), 0),
        netStablefordTotal: netStableford.reduce((acc, value) => acc + (value == null ? 0 : Number(value) || 0), 0),
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
  const withThruDisplay = (rows) => attachTeamThruDisplay(rows, tournamentJson, roundIndex, roundData);

  if (format === "scramble" || normalizeTwoManFormat(format)) {
    const fromTeamEntries = buildTeamRowsFromTeamEntries(roundData, coursePars, useHandicap, teamNames, seedTeamIds);
    if (fromTeamEntries.some((row) => rowHasAnyData(row))) return withThruDisplay(fromTeamEntries);
    if (fallbackRows.some((row) => rowHasAnyData(row))) return withThruDisplay(fallbackRows);
    return withThruDisplay(fromTeamEntries);
  }

  const aggregated = buildAggregatedTeamRowsFromPlayers(
    tournamentJson,
    roundIndex,
    roundData,
    coursePars,
    leaderboardRows
  );
  if (aggregated.some((row) => rowHasAnyData(row))) return withThruDisplay(aggregated);
  if (fallbackRows.some((row) => rowHasAnyData(row))) return withThruDisplay(fallbackRows);
  if (fallbackRows.length) return withThruDisplay(fallbackRows);
  return withThruDisplay(aggregated);
}

function buildRoundPlayerRows(tournamentJson, roundIndex, roundData, coursePars) {
  const roundCfg = (tournamentJson?.tournament?.rounds || [])[roundIndex] || {};
  const format = String(roundCfg.format || "").toLowerCase();
  const twoManFormat = normalizeTwoManFormat(format);
  const isTwoManRound = !!twoManFormat;
  const useHandicap = !!roundCfg.useHandicap;
  const teamNames = roundTeamNameLookup(tournamentJson, roundData?.leaderboard?.teams || []);
  const playersById = playerMetaByIdMap();
  const nameById = playerNameMap();

  const attachPlayerMeta = (row) => {
    const playerId = String(row?.playerId || "").trim();
    const meta = playersById.get(playerId) || {};
    const teamId = normalizeTeamId(row?.teamId || meta?.teamId);
    const rawScores = roundData?.player?.[playerId] || row?.scores || {};
    const scoreBundle = normalizeScoreBundle(row, rawScores, coursePars);
    return {
      ...row,
      playerId,
      teamId,
      teamName: row?.teamName || teamNames.get(teamId) || meta?.teamName || teamId || "",
      gross: firstDefined(rawScores, ["grossTotal"]) ?? firstDefined(row, ["gross"]) ?? scoreBundle.grossTotal,
      net: firstDefined(rawScores, ["netTotal"]) ?? firstDefined(row, ["net", "strokes"]) ?? scoreBundle.netTotal,
      points: firstDefined(rawScores, ["netStablefordTotal"]) ?? firstDefined(row, ["points", "netPoints"]) ?? scoreBundle.netStablefordTotal,
      grossPoints: firstDefined(rawScores, ["grossStablefordTotal"]) ?? firstDefined(row, ["grossPoints"]) ?? scoreBundle.grossStablefordTotal,
      netPoints: firstDefined(rawScores, ["netStablefordTotal"]) ?? firstDefined(row, ["points", "netPoints"]) ?? scoreBundle.netStablefordTotal,
      toParGross: firstDefined(row, ["toParGross", "grossToPar", "grossToParTotal"]) ?? scoreBundle.grossToParTotal,
      toParNet: firstDefined(row, ["toParNet", "netToPar", "netToParTotal", "toPar"]) ?? scoreBundle.netToParTotal,
      teeTime: row?.teeTime || teeTimeForPlayerRound(meta, roundIndex),
      scores: scoreBundle
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
      const pairLabel = twoManPairLabelFromIds(playerIds, nameById, key);
      const gross = Array.isArray(entry?.gross)
        ? normalizePlayedHoleArray(entry.gross)
        : aggregateTwoManGroupHoles(roundData, playerIds, twoManFormat, "gross");
      const net = Array.isArray(entry?.net)
        ? normalizePlayedHoleArray(entry.net)
        : aggregateTwoManGroupHoles(roundData, playerIds, twoManFormat, "net");
      const parMultiplier = twoManFormat === "two_man_shamble"
        ? Math.max(1, playerIds.length)
        : 1;
      const parByHole = coursePars.map((value) => Number(value || 0) * parMultiplier);
      const grossToPar = toParArrayFromHoles(gross, parByHole);
      const netToPar = toParArrayFromHoles(net, parByHole);
      const grossStableford = stablefordArrayFromHoles(gross, parByHole);
      const netStableford = stablefordArrayFromHoles(net, parByHole);
      const actualReady = Array.from({ length: 18 }, (_, holeIndex) =>
        playerIds.length > 0 &&
        playerIds.every((playerId) => {
          const playerEntry = roundData?.player?.[playerId] || {};
          return (
            asPlayedNumber(playerEntry?.gross?.[holeIndex]) != null ||
            asPlayedNumber(playerEntry?.net?.[holeIndex]) != null
          );
        })
      );

      let thru = 0;
      let grossToParTotal = 0;
      let netToParTotal = 0;
      for (let i = 0; i < 18; i++) {
        const grossDiff = grossToPar[i];
        const netDiff = netToPar[i];
        if (grossDiff != null || netDiff != null) thru += 1;
        if (grossDiff != null) grossToParTotal += grossDiff;
        if (netDiff != null) netToParTotal += netDiff;
      }

      const grossTotal = sumHoles(gross);
      const netTotal = sumHoles(net);
      rows.push({
        playerId: `group:${teamId}:${key}`,
        groupId: `${teamId}::${key}`,
        groupKey: key,
        name: pairLabel,
        teamId,
        teamName: teamNames.get(teamId) || teamId || "Team",
        thru,
        gross: grossTotal,
        net: netTotal,
        points: netStableford.reduce((acc, value) => acc + (value == null ? 0 : Number(value) || 0), 0),
        grossPoints: grossStableford.reduce((acc, value) => acc + (value == null ? 0 : Number(value) || 0), 0),
        netPoints: netStableford.reduce((acc, value) => acc + (value == null ? 0 : Number(value) || 0), 0),
        strokes: useHandicap ? netTotal : grossTotal,
        toPar: useHandicap ? netToParTotal : grossToParTotal,
        toParGross: grossToParTotal,
        toParNet: netToParTotal,
        teeTime: teeTimeForPlayerIds(playerIds, roundIndex) || teeTimeForTeamRound(teamId, roundIndex),
        scores: {
          gross,
          net,
          par: parByHole,
          actualReady,
          grossToPar,
          netToPar,
          grossStableford,
          netStableford,
          handicapShots: Array.isArray(entry?.handicapShots) ? entry.handicapShots : handicapShotsFromHoleSets(gross, net),
          grossTotal,
          netTotal,
          grossToParTotal,
          netToParTotal,
          grossStablefordTotal: grossStableford.reduce((acc, value) => acc + (value == null ? 0 : Number(value) || 0), 0),
          netStablefordTotal: netStableford.reduce((acc, value) => acc + (value == null ? 0 : Number(value) || 0), 0),
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
    <div class="stats-kpi"><span class="small">Eagle+</span><b class="mono">${eaglePlus}</b></div>
    <div class="stats-kpi"><span class="small">Birdies</span><b class="mono">${birdies}</b></div>
    <div class="stats-kpi"><span class="small">Pars</span><b class="mono">${parsCount}</b></div>
    <div class="stats-kpi"><span class="small">Bogeys</span><b class="mono">${bogeys}</b></div>
    <div class="stats-kpi"><span class="small">Double+</span><b class="mono">${doublePlus}</b></div>
    <div class="stats-kpi"><span class="small">Avg ± / hole</span><b class="mono">${holesPlayed ? toParStrFromDecimal(avgToPar) : "—"}</b></div>
  `;

  if (!holesPlayed) {
    statsHoleTbl.innerHTML = `<tbody><tr><td class="left small">No hole-by-hole scores posted yet for this view.</td></tr></tbody>`;
    return;
  }

  function headerRow(label, start, end) {
    return (
      `<tr>` +
      `<th class="left">${label}</th>` +
      Array.from({ length: end - start + 1 }, (_, k) => `<th class="mono">${start + k + 1}</th>`).join("") +
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

function oddsTablesForView(viewRound = currentRound) {
  const viewOdds = liveOddsForView(viewRound);
  if (!viewOdds) return [];

  const tables = [];
  if (Array.isArray(viewOdds.teams) && viewOdds.teams.length) {
    tables.push({ key: "teams", title: "Teams", rows: viewOdds.teams });
  }

  const showPlayerOdds =
    !isScrambleRound(viewRound) &&
    (viewRound !== "all" || !tournamentHasAnyScrambleRound());
  if (Array.isArray(viewOdds.groups) && viewOdds.groups.length) {
    tables.push({ key: "groups", title: "Groups", rows: viewOdds.groups });
  } else if (showPlayerOdds && Array.isArray(viewOdds.players) && viewOdds.players.length) {
    tables.push({ key: "players", title: viewRound === "all" ? "Players" : "Players", rows: viewOdds.players });
  }

  return tables;
}

function renderOddsTable(title, rows, key) {
  const block = document.createElement("section");
  block.className = "odds-block";
  const completedWinners = completedOddsRowIds(key, rows);
  const hasCompletedWinner = completedWinners.size > 0;

  const head = document.createElement("div");
  head.className = "odds-block-head";
  const heading = document.createElement("h3");
  heading.textContent = title;
  head.appendChild(heading);

  const count = document.createElement("div");
  count.className = "small";
  count.textContent = `${rows.length} ${title.toLowerCase()}`;
  head.appendChild(count);
  block.appendChild(head);

  const wrap = document.createElement("div");
  wrap.className = "odds-table-wrap";
  const leadLabel = oddsValueMode === "american" ? "Lead Odds" : "Lead %";
  const lowOddsLabel = oddsMetric === "net"
    ? (oddsValueMode === "american" ? "Low N Odds" : "Low N%")
    : (oddsValueMode === "american" ? "Low G Odds" : "Low G%");
  const showStableford = isStablefordTournament();

  const table = document.createElement("table");
  table.className = "table odds-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th class="left entity-col">${key === "teams" ? "Team" : key === "groups" ? "Group" : "Player"}</th>
        <th>${leadLabel}</th>
        <th>${lowOddsLabel}</th>
        <th>${showStableford ? "Proj Pts" : "Proj ±"}</th>
        <th class="remaining-col">Rem</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;

  const tbody = table.querySelector("tbody");
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    const name = key === "teams"
      ? row?.teamName || row?.teamId || "Team"
      : row?.name || row?.groupId || row?.playerId || "—";
    const sub = key === "teams"
      ? ""
      : String(row?.teamName || "").trim();
    const remTitle = liveOddsTooltip(row);
    const lowMetricProbability = oddsMetric === "net"
      ? row?.lowestNetProbability
      : row?.lowestGrossProbability;
    const projectedOddsMetricValue = showStableford
      ? (oddsMetric === "net" ? row?.projectedNetPoints : row?.projectedGrossPoints)
      : (oddsMetric === "net" ? row?.projectedNetToPar : row?.projectedGrossToPar);
    const isFinished = Number(row?.holesRemaining || 0) <= 0;
    const isTournamentWinner = completedWinners.has(oddsRowStableId(row, key));
    const leadOddsContent = hasCompletedWinner
      ? (isTournamentWinner ? `<span class="odds-status-badge odds-status-win">WIN</span>` : "")
      : renderOddsMetricValue(row?.leaderProbability, row?.leaderProbability, { exactExtremes: isFinished });
    const lowOddsContent = hasCompletedWinner
      ? ""
      : renderOddsMetricValue(lowMetricProbability, lowMetricProbability, { exactExtremes: isFinished });
    tr.innerHTML = `
      <td class="left entity-col">
        <div class="entity-name">${escapeHtml(name)}</div>
        ${sub ? `<div class="small muted entity-sub">${escapeHtml(sub)}</div>` : ""}
      </td>
      <td class="mono">${leadOddsContent}</td>
      <td class="mono">${lowOddsContent}</td>
      <td class="mono"><b>${escapeHtml(projectedOddsMetricValue == null ? "—" : (showStableford ? formatDecimal(projectedOddsMetricValue) : toParStrFromTenths(projectedOddsMetricValue)))}</b></td>
      <td class="mono remaining-col" title="${escapeHtml(remTitle)}">${escapeHtml(String(Number(row?.holesRemaining || 0)))}</td>
    `;
    tbody.appendChild(tr);
  });

  wrap.appendChild(table);
  block.appendChild(wrap);
  return block;
}

function renderOddsDistributionCell(summary) {
  const td = document.createElement("td");
  td.className = "left";
  if (summary?.played) {
    const text = document.createElement("span");
    text.className = "odds-distribution-played";
    text.textContent = summary.played;
    td.appendChild(text);
    return td;
  }

  const items = Array.isArray(summary?.items) ? summary.items : [];
  if (!items.length) {
    td.textContent = "—";
    return td;
  }

  const par = Number.isFinite(summary?.par) ? summary.par : null;
  const maxProb = Math.max(...items.map(i => Number(i?.probability || 0)));

  const wrap = document.createElement("div");
  wrap.className = "odds-histogram";
  items.forEach((item) => {
    const prob = Number(item?.probability || 0);
    const score = Number(item?.score);
    const label = par != null && Number.isFinite(score)
      ? toParStrFromDiff(score - par)
      : formatDecimal(score);

    const col = document.createElement("div");
    col.className = "odds-histogram-col";

    const pctEl = document.createElement("span");
    pctEl.className = "odds-histogram-pct";
    pctEl.textContent = formatPercent(prob, { exactExtremes: true });

    const barWrap = document.createElement("div");
    barWrap.className = "odds-histogram-bar-wrap";

    const bar = document.createElement("div");
    bar.className = "odds-histogram-bar";
    bar.style.height = `${maxProb > 0 ? (prob / maxProb) * 100 : 0}%`;

    const labelEl = document.createElement("span");
    labelEl.className = "odds-histogram-label";
    labelEl.textContent = label;

    barWrap.appendChild(bar);
    col.appendChild(pctEl);
    col.appendChild(barWrap);
    col.appendChild(labelEl);
    wrap.appendChild(col);
  });
  td.appendChild(wrap);
  return td;
}

function renderOddsScorecardBlock(title, rows, key, data, selectedHoleIndex) {
  const block = document.createElement("section");
  block.className = "odds-scorecard-block";
  const pars = data?.course?.pars || [];

  const head = document.createElement("div");
  head.className = "odds-block-head";
  head.innerHTML = `<h3>${escapeHtml(title)}</h3><div class="small">${rows.length} ${escapeHtml(title.toLowerCase())}</div>`;
  block.appendChild(head);

  const scorecardWrap = document.createElement("div");
  scorecardWrap.className = "odds-scorecard-wrap";
  const scorecardTable = document.createElement("table");
  scorecardTable.className = "table odds-scorecard-table";
  scorecardTable.innerHTML = `
    <thead>
      <tr>
        <th class="left entity-col">${key === "teams" ? "Team" : key === "groups" ? "Group" : "Player"}</th>
        ${Array.from({ length: 18 }, (_, holeIndex) => `<th class="odds-scorecard-hole${holeIndex === selectedHoleIndex ? " selected" : ""}">${holeIndex + 1}</th>`).join("")}
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const scorecardBody = scorecardTable.querySelector("tbody");

  rows.forEach((row) => {
    const actualRow = oddsActualRowForKey(data, key, row);
    const scoreBundle = actualRow
      ? normalizeScoreBundle(actualRow, actualRow?.scores || {}, data?.course?.pars || [])
      : null;
    const detailByHole = oddsProjectedDetailMap(row);
    const tr = document.createElement("tr");
    const name = key === "teams"
      ? row?.teamName || row?.teamId || "Team"
      : row?.name || row?.groupId || row?.playerId || "—";
    const sub = key === "teams" ? "" : String(row?.teamName || "").trim();
    tr.innerHTML = `
      <td class="left entity-col">
        <div class="entity-name">${escapeHtml(name)}</div>
        ${sub ? `<div class="small muted entity-sub">${escapeHtml(sub)}</div>` : ""}
      </td>
      ${Array.from({ length: 18 }, (_, holeIndex) => {
        const actualValue = oddsActualScoreForHole(scoreBundle, holeIndex);
        const detail = detailByHole.get(holeIndex);
        const holePar = oddsHoleParForRow(data, key, row, holeIndex, scoreBundle);
        const stateClass = actualValue != null ? "actual" : detail ? "projected" : "empty";
        const selectedClass = holeIndex === selectedHoleIndex ? " selected" : "";
        return `<td class="odds-scorecard-cell ${stateClass}${selectedClass}">${escapeHtml(oddsHoleCellText(actualValue, detail, holePar))}</td>`;
      }).join("")}
    `;
    scorecardBody.appendChild(tr);
  });

  scorecardWrap.appendChild(scorecardTable);
  block.appendChild(scorecardWrap);

  const distributionWrap = document.createElement("div");
  distributionWrap.className = "odds-distribution-wrap";
  const distributionTable = document.createElement("table");
  distributionTable.className = "table odds-distribution-table";
  distributionTable.innerHTML = `
    <thead>
      <tr>
        <th class="left entity-col">${key === "teams" ? "Team" : key === "groups" ? "Group" : "Player"}</th>
        <th>Exp ±</th>
        <th class="left">Hole ${selectedHoleIndex + 1} Distribution</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const distributionBody = distributionTable.querySelector("tbody");

  rows.forEach((row) => {
    const actualRow = oddsActualRowForKey(data, key, row);
    const scoreBundle = actualRow
      ? normalizeScoreBundle(actualRow, actualRow?.scores || {}, data?.course?.pars || [])
      : null;
    const detail = oddsProjectedDetailMap(row).get(selectedHoleIndex);
    const actualValue = oddsActualScoreForHole(scoreBundle, selectedHoleIndex);
    const holePar = oddsHoleParForRow(data, key, row, selectedHoleIndex, scoreBundle);
    const summary = oddsDistributionSummary(actualValue, detail, holePar);
    const tr = document.createElement("tr");
    const name = key === "teams"
      ? row?.teamName || row?.teamId || "Team"
      : row?.name || row?.groupId || row?.playerId || "—";
    const sub = key === "teams" ? "" : String(row?.teamName || "").trim();
    tr.innerHTML = `
      <td class="left entity-col">
        <div class="entity-name">${escapeHtml(name)}</div>
        ${sub ? `<div class="small muted entity-sub">${escapeHtml(sub)}</div>` : ""}
      </td>
      <td class="mono"><b>${escapeHtml(summary.expected)}</b></td>
    `;
    tr.appendChild(renderOddsDistributionCell(summary));
    distributionBody.appendChild(tr);
  });

  distributionWrap.appendChild(distributionTable);
  block.appendChild(distributionWrap);
  return block;
}

function renderProjectedOddsScorecards(data, tables) {
  if (!oddsScorecardsPanel || !oddsHoleSelect || !oddsScorecards) return;
  if (data?.view?.round === "all" || !Array.isArray(tables) || !tables.length) {
    oddsScorecardsPanel.hidden = true;
    oddsScorecards.innerHTML = "";
    if (oddsHoleSelect) oddsHoleSelect.innerHTML = "";
    return;
  }

  const holeOptions = oddsHoleOptions(tables, data);
  if (!holeOptions.length) {
    oddsScorecardsPanel.hidden = true;
    oddsScorecards.innerHTML = "";
    oddsHoleSelect.innerHTML = "";
    return;
  }

  if (!holeOptions.some((option) => option.key === oddsSelectedHoleKey)) {
    oddsSelectedHoleKey = holeOptions[0].key;
  }

  oddsHoleSelect.innerHTML = holeOptions
    .map((option) => `<option value="${escapeHtml(option.key)}">${escapeHtml(option.label)}</option>`)
    .join("");
  oddsHoleSelect.value = oddsSelectedHoleKey;

  const selectedOption = holeOptions.find((option) => option.key === oddsSelectedHoleKey) || holeOptions[0];
  const selectedHoleIndex = Number(selectedOption?.holeIndex || 0);

  oddsScorecards.innerHTML = "";
  oddsScorecards.className = "odds-scorecards";
  tables.forEach((table) => {
    oddsScorecards.appendChild(renderOddsScorecardBlock(table.title, table.rows, table.key, data, selectedHoleIndex));
  });
  oddsScorecardsPanel.hidden = false;
}

function renderLiveOdds(data) {
  if (!oddsPanel || !oddsTitle || !oddsMeta || !oddsSections) return;
  syncOddsMetricButtons();
  syncOddsValueButtons();

  const tables = oddsTablesForView(currentRound);
  if (!tables.length) {
    oddsPanel.hidden = true;
    oddsMeta.textContent = "—";
    oddsSections.innerHTML = "";
    if (oddsScorecardsPanel) oddsScorecardsPanel.hidden = true;
    return;
  }

  const viewOdds = liveOddsForView(currentRound);
  oddsTitle.textContent = `Odds & Projections - ${viewRoundLabel(currentRound)}`;
  const generatedAt = liveOddsTimestampLabel();
  oddsMeta.textContent = generatedAt ? `Last updated ${generatedAt}` : "—";

  oddsSections.innerHTML = "";
  oddsSections.className = "odds-sections";
  tables.forEach((table) => {
    oddsSections.appendChild(renderOddsTable(table.title, table.rows, table.key));
  });

  if (
    viewOdds &&
    Array.isArray(viewOdds.groups) &&
    viewOdds.groups.length &&
    Array.isArray(viewOdds.players) &&
    viewOdds.players.length
  ) {
    const note = document.createElement("div");
    note.className = "small muted";
    note.textContent = "Two-man rounds show group odds in the section above; player projections still feed team simulations in the backend.";
    oddsSections.appendChild(note);
  }

  renderProjectedOddsScorecards(data, tables);

  oddsPanel.hidden = false;
}

function buildScoreboardResponse(tournamentJson, viewRound) {
  const courses = courseListFromTournament(tournamentJson);
  const allRoundsCourse = courses[0] || defaultCourse();

  if (viewRound === "all") {
    return {
      tournament: tournamentJson.tournament,
      view: { round: "all" },
      course: {
        ...(allRoundsCourse?.name ? { name: allRoundsCourse.name } : {}),
        ...(allRoundsCourse?.teeName ? { teeName: allRoundsCourse.teeName } : {}),
        ...(allRoundsCourse?.teeLabel ? { teeLabel: allRoundsCourse.teeLabel } : {}),
        ...(Number.isFinite(allRoundsCourse?.totalYards) ? { totalYards: allRoundsCourse.totalYards } : {}),
        ...(Array.isArray(allRoundsCourse?.holeYardages) && allRoundsCourse.holeYardages.length === 18
          ? { holeYardages: allRoundsCourse.holeYardages.slice() }
          : {}),
        ...(Array.isArray(allRoundsCourse?.ratings) && allRoundsCourse.ratings.length
          ? { ratings: allRoundsCourse.ratings.slice() }
          : {}),
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
      ...(roundCourse?.name ? { name: roundCourse.name } : {}),
      ...(roundCourse?.teeName ? { teeName: roundCourse.teeName } : {}),
      ...(roundCourse?.teeLabel ? { teeLabel: roundCourse.teeLabel } : {}),
      ...(Number.isFinite(roundCourse?.totalYards) ? { totalYards: roundCourse.totalYards } : {}),
      ...(Array.isArray(roundCourse?.holeYardages) && roundCourse.holeYardages.length === 18
        ? { holeYardages: roundCourse.holeYardages.slice() }
        : {}),
      ...(Array.isArray(roundCourse?.ratings) && roundCourse.ratings.length
        ? { ratings: roundCourse.ratings.slice() }
        : {}),
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
    const [tournamentJson, oddsJson] = await Promise.all([
      staticJson(`/tournaments/${encodeURIComponent(tid)}.json`, {
        cacheKey: `tourn:${tid}`
      }),
      staticJson(`/tournaments/${encodeURIComponent(tid)}.live_odds.json`, {
        cacheKey: `tourn-odds:${tid}`
      }).catch(() => null)
    ]);
    const liveOddsPayload = oddsJson?.live_odds || expandCompactLiveOddsPayload(oddsJson, tournamentJson);
    if (oddsJson && liveOddsPayload) {
      const oddsVersion = Number(oddsJson?.version ?? oddsJson?.v);
      const tournamentVersion = Number(tournamentJson?.version);
      tournamentJson.score_data = tournamentJson.score_data || {};
      tournamentJson.score_data.live_odds = liveOddsPayload;
      tournamentJson.score_data.live_oddsVersionMismatch =
        Number.isFinite(oddsVersion) &&
        Number.isFinite(tournamentVersion) &&
        oddsVersion > 0 &&
        tournamentVersion > 0 &&
        oddsVersion !== tournamentVersion;
    }
    return tournamentJson;
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
  roundFilter.innerHTML = `<option value="all">Tournament</option>`;
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
  writeScoreboardPrefs();
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
  const stablefordInfo = isStablefordTournament()
    ? " • stableford points drive leaderboard positions"
    : "";
  const handicapInfo = isHandicapRound(data.view.round)
    ? " • leaderboard shows gross + net, scorecards show both"
    : "";
  const scrambleInfo = isScrambleRound(data.view.round)
    ? " • scramble rounds are team-only"
    : "";
  const twoManInfo = isTwoManRound(data.view.round)
    ? " • two-man rounds include pair breakdown"
    : "";
  const allRoundsInfo =
    data.view.round === "all" && tournamentHasAnyScrambleRound()
      ? " • all rounds view is team-only (scramble in tournament)"
      : "";
  if (toggleNote) {
    toggleNote.textContent = `${rLabel}${stablefordInfo}${handicapInfo}${scrambleInfo}${twoManInfo}${allRoundsInfo}`;
  }
  if (lbTitleHelp) {
    const oddsInfo = liveOddsForView(currentRound)
      ? " Odds & projections are shown in the dedicated section below."
      : "";
    lbTitleHelp.textContent = `Click on team/group/player to see scores.${oddsInfo}`;
  }

  renderLeaderboard(data);
  renderLiveOdds(data);
  renderTrendGraph(data);
  renderStats(data);

  const ts = TOURN.updatedAt ? new Date(TOURN.updatedAt).toLocaleString() : "—";
  if (updated) updated.textContent = `Updated: ${ts}`;

  if (raw) raw.textContent = "";
  scheduleOddsHeadFixedStateSync();
}

btnTeam.onclick = () => {
  mode = "team";
  writeScoreboardPrefs();
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
  writeScoreboardPrefs();
  syncModeButtons();
  render();
};

if (btnTrendGross) {
  btnTrendGross.onclick = () => {
    graphMetric = "gross";
    writeScoreboardPrefs();
    syncTrendMetricButtons();
    render();
  };
}

if (btnTrendNet) {
  btnTrendNet.onclick = () => {
    if (!canUseNetMetric(currentRound)) return;
    graphMetric = "net";
    writeScoreboardPrefs();
    syncTrendMetricButtons();
    render();
  };
}

if (oddsHoleSelect) {
  oddsHoleSelect.onchange = () => {
    oddsSelectedHoleKey = String(oddsHoleSelect.value || "");
    render();
  };
}

if (btnOddsGross) {
  btnOddsGross.onclick = () => {
    if (oddsMetricLockedToNet(currentRound)) return;
    oddsMetric = "gross";
    writeScoreboardPrefs();
    syncOddsMetricButtons();
    render();
  };
}

if (btnOddsNet) {
  btnOddsNet.onclick = () => {
    if (!canUseNetMetric(currentRound)) return;
    oddsMetric = "net";
    writeScoreboardPrefs();
    syncOddsMetricButtons();
    render();
  };
}

if (btnOddsPct) {
  btnOddsPct.onclick = () => {
    oddsValueMode = "percent";
    writeScoreboardPrefs();
    syncOddsValueButtons();
    render();
  };
}

if (btnOddsAmerican) {
  btnOddsAmerican.onclick = () => {
    oddsValueMode = "american";
    writeScoreboardPrefs();
    syncOddsValueButtons();
    render();
  };
}

roundFilter.onchange = () => {
  const v = roundFilter.value;
  const nextRound = v === "all" ? "all" : Number(v);
  const switchedRounds = String(nextRound) !== String(currentRound);
  currentRound = nextRound;
  if (switchedRounds && isIndividualDefaultRound(currentRound) && !isScrambleRound(currentRound)) {
    mode = "player";
  }
  writeScoreboardPrefs();
  render();
};

window.addEventListener("scroll", scheduleOddsHeadFixedStateSync, { passive: true });
window.addEventListener("resize", scheduleOddsHeadFixedStateSync);

(async function init() {
  if (!tid) {
    if (status) {
      status.hidden = false;
      status.textContent =
        "Missing tournament id. Open with ?t=... or create/open a tournament first.";
    }
    return;
  }

  if (scorecardCard) scorecardCard.style.display = "none";

  if (status) {
    status.hidden = false;
    status.textContent = "Loading…";
  }
  try {
    TOURN = await loadTournament();
    rememberTournamentId(tid);
    teamColorsSeeded = false;
    rebuildTeamColors();
    $('body').show();

    const roundCount = (TOURN.tournament.rounds || []).length;
    if (!hasStoredRoundPreference) {
      currentRound = roundCount > 0 ? newestRoundWithDataIndex(TOURN) : "all";
    }
    syncTrendMetricButtons();
    syncOddsMetricButtons();
    syncOddsValueButtons();
    syncRoundFilterOptions();
    if (!hasStoredGraphMetricPreference) {
      graphMetric = isHandicapRound(currentRound) ? "net" : "gross";
    }
    if (!hasStoredOddsMetricPreference) {
      oddsMetric = isHandicapRound(currentRound) ? "net" : "gross";
    }
    if (!hasStoredModePreference && isIndividualDefaultRound(currentRound) && !isScrambleRound(currentRound)) {
      mode = "player";
    }
    if (!hasStoredOddsValueModePreference) {
      oddsValueMode = "percent";
    }
    writeScoreboardPrefs();
    syncModeButtons();
    syncTrendMetricButtons();
    syncOddsMetricButtons();
    syncOddsValueButtons();

    if (status) {
      status.textContent = "";
      status.hidden = true;
    }
    render();
    startAutoRefresh();
  } catch (e) {
    console.error(e);
    if (status) {
      status.hidden = false;
      status.textContent = e.message || String(e);
    }
  }
})();
