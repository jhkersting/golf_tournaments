import { API_BASE } from "./app.js";
import { initDraftPresence } from "./draft-presence.js";

const DRAFT_SESSION_KEY = "golf:draftCode";
const POLL_INTERVAL_MS = 2000;
const DRAFT_API_BASE = ["localhost", "127.0.0.1"].includes(location.hostname) ? location.origin : API_BASE;
const TEAM_COLORS = { jake: "#bf5700", jack: "#9e1b32" };
const PLAYERS = [
  { id: "j-christensen", name: "J. Christensen", handicap: 0, captain: true },
  { id: "j-kersting", name: "J. Kersting", handicap: 0, captain: true },
  { id: "d-davidson", name: "D. Davidson", handicap: 0 },
  { id: "j-royse", name: "J. Royse", handicap: 16 },
  { id: "w-parten", name: "W. Parten", handicap: 19 },
  { id: "b-holley", name: "B. Holley", handicap: 15 },
  { id: "j-collins", name: "J. Collins", handicap: 19 },
  { id: "p-addington", name: "P. Addington", handicap: 19 },
  { id: "j-jones", name: "J. Jones", handicap: 20 },
  { id: "n-burlbaw", name: "N. Burlbaw", handicap: 23 },
  { id: "f-kersting", name: "F. Kersting", handicap: 10 },
  { id: "h-coop", name: "H. Coop", handicap: 15 }
];
const PLAYER_BY_ID = new Map(PLAYERS.map((player) => [player.id, player]));
const presence = initDraftPresence({ apiBase: DRAFT_API_BASE, players: PLAYERS });
const STAGES = [
  {
    stageId: "sherrillPairs",
    title: "Sherrill pairs",
    venue: "Sherrill Park · Course 2",
    detail: "Choose three 2-player groups per team. The same groups play the front-nine scramble and back-nine alternate shot.",
    groupSize: 2,
    selections: 6
  },
  {
    stageId: "anchoredPairs",
    title: "Anchored scramble pairs",
    venue: "Anchored National · First nine",
    detail: "Choose three new 2-player groups per team for the scramble.",
    groupSize: 2,
    selections: 6
  },
  {
    stageId: "anchoredSingles",
    title: "Anchored singles order",
    venue: "Anchored National · Final nine",
    detail: "Choose all six players per team in matchup order for the 1v1 singles.",
    groupSize: 1,
    selections: 12
  }
];

let code = "";
let role = "";
let picks = [];
let lineups = emptyLineups();
let odds = null;
let selectedIds = new Set();
let selectionContext = "";
let requestPending = false;
let pollTimer = 0;

function emptyLineups() {
  return Object.fromEntries(STAGES.map((stage) => [stage.stageId, []]));
}

function normalizePicks(raw) {
  const seen = new Set();
  return (Array.isArray(raw) ? raw : []).filter((id) => {
    if (!PLAYER_BY_ID.has(id) || PLAYER_BY_ID.get(id).captain || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).slice(0, 10);
}

function normalizeLineups(raw) {
  const normalized = emptyLineups();
  for (const stage of STAGES) {
    normalized[stage.stageId] = (Array.isArray(raw?.[stage.stageId]) ? raw[stage.stageId] : [])
      .filter((selection) => ["jake", "jack"].includes(selection?.teamId) && Array.isArray(selection?.playerIds))
      .map((selection) => ({ teamId: selection.teamId, playerIds: selection.playerIds.slice(0, stage.groupSize) }))
      .filter((selection) => selection.playerIds.length === stage.groupSize)
      .slice(0, stage.selections);
  }
  return normalized;
}

async function draftRequest({ method = "GET", body = null } = {}) {
  const response = await fetch(`${DRAFT_API_BASE}/draft`, {
    method,
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : null
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || `Match request failed (${response.status})`);
  return payload;
}

function snakeTeamAt(index) {
  return ["jake", "jack", "jack", "jake"][Math.max(0, Number(index) || 0) % 4];
}

function draftTeamAt(index) {
  return ["jake", "jack"][Math.max(0, Number(index) || 0) % 2];
}

function lineupPickIndex() {
  return STAGES.reduce((total, stage) => total + lineups[stage.stageId].length, 0);
}

function currentStage() {
  return STAGES.find((stage) => lineups[stage.stageId].length < stage.selections) || null;
}

function currentTeam() {
  return snakeTeamAt(lineupPickIndex());
}

function teamRosters() {
  const rosters = {
    jake: [PLAYER_BY_ID.get("j-christensen")],
    jack: [PLAYER_BY_ID.get("j-kersting")]
  };
  picks.forEach((playerId, index) => rosters[draftTeamAt(index)].push(PLAYER_BY_ID.get(playerId)));
  return rosters;
}

function applyState(state) {
  picks = normalizePicks(state?.picks);
  lineups = normalizeLineups(state?.lineups);
  odds = state?.odds || null;
  presence.applyViewers(state?.viewers);
}

function setSync(message, isError = false) {
  const node = document.getElementById("matches_sync");
  node.textContent = message;
  node.classList.toggle("is-error", isError);
}

function formatProbability(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? `${number}%` : `${number.toFixed(1)}%`;
}

function renderEventOdds() {
  const event = odds?.event;
  const root = document.getElementById("matches_event_odds");
  const meta = document.getElementById("matches_odds_meta");
  const track = document.getElementById("matches_event_track");
  if (!event) {
    root.innerHTML = '<span class="small">Calculating event odds…</span>';
    meta.textContent = "Match-play simulation";
    track.style.background = "var(--border)";
    return;
  }
  root.innerHTML = `
    <div class="matches-event-team jake"><span>Jake wins</span><strong>${formatProbability(event.jakeWinProbability)}</strong></div>
    <div class="matches-event-team"><span>Event tie</span><strong>${formatProbability(event.tieProbability)}</strong></div>
    <div class="matches-event-team jack"><span>Jack wins</span><strong>${formatProbability(event.jackWinProbability)}</strong></div>`;
  const jake = Number(event.jakeWinProbability || 0);
  const tie = Number(event.tieProbability || 0);
  track.style.background = `linear-gradient(to right, ${TEAM_COLORS.jake} 0 ${jake}%, var(--border) ${jake}% ${jake + tie}%, ${TEAM_COLORS.jack} ${jake + tie}% 100%)`;
  meta.textContent = `${Number(odds.simCount || 0).toLocaleString()} simulations`;
}

function canPick(teamId) {
  return role === "jack" || role === teamId;
}

function renderTurn() {
  const turn = document.getElementById("matches_turn");
  const stage = currentStage();
  if (!stage) {
    turn.className = "matches-turn";
    turn.innerHTML = "<span>Complete</span><strong>All 15 matches are locked</strong><em>Ready to play</em>";
    return;
  }
  const teamId = currentTeam();
  const captain = teamId === "jake" ? "Jake" : "Jack";
  const instruction = canPick(teamId) ? `Select ${stage.groupSize === 2 ? "two players" : "one player"}` : role ? `Waiting for ${captain}` : "Public live view";
  turn.className = `matches-turn matches-turn-${teamId}`;
  turn.innerHTML = `<span>Selection ${lineupPickIndex() + 1} of 24</span><strong>${captain} is on the clock</strong><em>${instruction}</em>`;
}

function renderPicker() {
  const picker = document.getElementById("matches_picker");
  const stage = currentStage();
  if (!stage) {
    picker.hidden = true;
    return;
  }
  picker.hidden = false;
  const teamId = currentTeam();
  picker.style.setProperty("--turn-accent", TEAM_COLORS[teamId]);
  document.getElementById("matches_stage_venue").textContent = stage.venue;
  document.getElementById("matches_stage_title").textContent = stage.title;
  document.getElementById("matches_stage_detail").textContent = stage.detail;
  document.getElementById("matches_stage_progress").textContent = `${lineups[stage.stageId].length}/${stage.selections}`;

  const nextContext = `${stage.stageId}:${lineups[stage.stageId].length}:${teamId}`;
  if (nextContext !== selectionContext) {
    selectedIds = new Set();
    selectionContext = nextContext;
  }
  const used = new Set(lineups[stage.stageId]
    .filter((selection) => selection.teamId === teamId)
    .flatMap((selection) => selection.playerIds));
  const available = teamRosters()[teamId].filter((player) => player && !used.has(player.id));
  selectedIds = new Set([...selectedIds].filter((playerId) => available.some((player) => player.id === playerId)));
  const enabled = canPick(teamId) && !requestPending;
  const root = document.getElementById("matches_players");
  root.replaceChildren();
  for (const player of available) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `matches-player-choice${selectedIds.has(player.id) ? " is-selected" : ""}`;
    button.dataset.playerId = player.id;
    button.disabled = !enabled;
    button.setAttribute("aria-pressed", selectedIds.has(player.id) ? "true" : "false");
    button.innerHTML = `<strong>${player.name}</strong><span>HCP ${player.handicap}</span>`;
    root.append(button);
  }
  const lock = document.getElementById("matches_lock");
  lock.disabled = !enabled || selectedIds.size !== stage.groupSize;
  lock.textContent = stage.groupSize === 2 ? "Lock this pair" : "Lock this player";
  const help = document.getElementById("matches_picker_help");
  help.textContent = !role
    ? "Sign in as a captain to make selections. Everyone can view without a code."
    : !canPick(teamId)
      ? `Waiting for ${teamId === "jake" ? "Jake" : "Jack"}.`
      : `Select ${stage.groupSize - selectedIds.size} more player${stage.groupSize - selectedIds.size === 1 ? "" : "s"}.`;
}

function playerMarkup(players) {
  return (Array.isArray(players) ? players : []).map((player) => {
    const projected = player?.projected;
    const name = projected ? "Weighted slot" : player?.name || "TBD";
    const handicap = Number(player?.handicap);
    const hcp = Number.isFinite(handicap) ? `${projected ? "Projected" : "HCP"} ${handicap.toFixed(projected ? 1 : 0)}` : "";
    return `<div><div class="matches-player-name">${name}</div><div class="matches-player-hcp">${hcp}</div></div>`;
  }).join("");
}

function roundSubtitle(round) {
  const labels = {
    scramble: "2v2 scramble",
    alternate_shot: "2v2 alternate shot",
    singles: "1v1 singles"
  };
  return labels[round?.format] || String(round?.format || "").replaceAll("_", " ");
}

function renderSchedule() {
  const root = document.getElementById("matches_rounds");
  root.replaceChildren();
  for (const round of odds?.rounds || []) {
    const section = document.createElement("section");
    section.className = "matches-round";
    const head = document.createElement("div");
    head.className = "matches-round-head";
    head.innerHTML = `<div><h3>${round.name}</h3><p>${roundSubtitle(round)} · ${round.matches.length} matches</p></div><span class="matches-round-status">${round.provisional ? "Projected" : "Locked"}</span>`;
    const list = document.createElement("div");
    list.className = "matches-round-list";
    round.matches.forEach((match, index) => {
      const card = document.createElement("article");
      card.className = "matches-match-card";
      card.style.setProperty("--jake-pct", `${Number(match.jakeWinProbability || 0)}%`);
      card.style.setProperty("--tie-pct", `${Number(match.tieProbability || 0)}%`);
      card.innerHTML = `
        <div class="matches-side matches-side-jake">${playerMarkup(match.jakePlayers)}</div>
        <div class="matches-versus"><strong>${index + 1}</strong><span>${match.provisional ? "PROJ" : "VS"}</span></div>
        <div class="matches-side matches-side-jack">${playerMarkup(match.jackPlayers)}</div>
        <div class="matches-match-odds">
          <span>Jake ${formatProbability(match.jakeWinProbability)}</span>
          <span>Tie ${formatProbability(match.tieProbability)}</span>
          <span>Jack ${formatProbability(match.jackWinProbability)}</span>
        </div>`;
      list.append(card);
    });
    section.append(head, list);
    root.append(section);
  }
}

function render() {
  const draftComplete = picks.length === 10;
  document.getElementById("matches_locked").hidden = draftComplete;
  document.getElementById("matches_board").hidden = !draftComplete;
  document.getElementById("matches_role").textContent = role === "jack"
    ? "Signed in as Jack · Admin."
    : role === "jake"
      ? "Signed in as Jake."
      : "Public live view.";
  document.getElementById("matches_login_toggle").hidden = !!role;
  document.getElementById("matches_logout").hidden = !role;
  document.getElementById("matches_undo").hidden = role !== "jack";
  document.getElementById("matches_reset").hidden = role !== "jack";
  document.getElementById("matches_undo").disabled = !lineupPickIndex() || requestPending;
  document.getElementById("matches_reset").disabled = !lineupPickIndex() || requestPending;
  if (!draftComplete) return;
  renderEventOdds();
  renderTurn();
  renderPicker();
  renderSchedule();
}

async function refresh({ quiet = false } = {}) {
  try {
    applyState(await draftRequest());
    render();
    if (!quiet) setSync("Live match draft connected");
  } catch (error) {
    setSync(error.message, true);
  }
}

async function submitAction(action, extra = {}) {
  if (requestPending || !code) return;
  requestPending = true;
  render();
  setSync("Updating matchups…");
  try {
    const state = await draftRequest({ method: "POST", body: { code, action, ...extra } });
    applyState(state);
    selectedIds = new Set();
    selectionContext = "";
    setSync("Matchups and odds updated");
  } catch (error) {
    setSync(error.message, true);
    await refresh({ quiet: true });
  } finally {
    requestPending = false;
    render();
  }
}

async function authenticate(candidateCode) {
  const normalized = String(candidateCode || "").trim().toUpperCase().replace(/[\s-]+/g, "");
  if (!normalized) return;
  const status = document.getElementById("matches_login_status");
  status.textContent = "Checking code…";
  try {
    const state = await draftRequest({ method: "POST", body: { code: normalized, action: "authenticate" } });
    code = normalized;
    role = state.role;
    applyState(state);
    sessionStorage.setItem(DRAFT_SESSION_KEY, code);
    document.getElementById("matches_login_form").hidden = true;
    setSync("Live match draft connected");
    render();
  } catch (error) {
    status.textContent = error.message;
  }
}

document.getElementById("matches_login_form").addEventListener("submit", (event) => {
  event.preventDefault();
  authenticate(new FormData(event.currentTarget).get("code"));
});
document.getElementById("matches_login_toggle").addEventListener("click", () => {
  const form = document.getElementById("matches_login_form");
  form.hidden = !form.hidden;
  if (!form.hidden) document.getElementById("matches_code").focus();
});
document.getElementById("matches_players").addEventListener("click", (event) => {
  const button = event.target.closest("[data-player-id]");
  const stage = currentStage();
  if (!button || button.disabled || !stage) return;
  const playerId = button.dataset.playerId;
  if (selectedIds.has(playerId)) selectedIds.delete(playerId);
  else if (selectedIds.size < stage.groupSize) selectedIds.add(playerId);
  renderPicker();
});
document.getElementById("matches_lock").addEventListener("click", () => {
  const stage = currentStage();
  if (stage && selectedIds.size === stage.groupSize) {
    submitAction("lineup-pick", { stageId: stage.stageId, playerIds: [...selectedIds] });
  }
});
document.getElementById("matches_undo").addEventListener("click", () => submitAction("lineup-undo"));
document.getElementById("matches_reset").addEventListener("click", () => {
  if (window.confirm("Reset every match selection? The team draft will stay intact.")) submitAction("lineup-reset");
});
document.getElementById("matches_logout").addEventListener("click", () => {
  sessionStorage.removeItem(DRAFT_SESSION_KEY);
  code = "";
  role = "";
  document.getElementById("matches_code").value = "";
  render();
  setSync("Public live view");
});

render();
refresh();
clearInterval(pollTimer);
pollTimer = window.setInterval(() => refresh({ quiet: true }), POLL_INTERVAL_MS);
const savedCode = sessionStorage.getItem(DRAFT_SESSION_KEY);
if (savedCode) authenticate(savedCode);
