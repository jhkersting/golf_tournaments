import { API_BASE } from "./app.js";
import { initDraftPresence } from "./draft-presence.js";

const DRAFT_SESSION_KEY = "golf:draftCode";
const POLL_INTERVAL_MS = 2000;
const DRAFT_API_BASE = ["localhost", "127.0.0.1"].includes(location.hostname) ? location.origin : API_BASE;
const CAPTAINS = {
  jack: { id: "j-kersting", name: "J. Kersting", handicap: 0 },
  jake: { id: "j-christensen", name: "J. Christensen", handicap: 0 }
};
const PLAYERS = [
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
const playerById = new Map(PLAYERS.map((player) => [player.id, player]));
const presence = initDraftPresence({
  apiBase: DRAFT_API_BASE,
  players: [CAPTAINS.jack, CAPTAINS.jake, ...PLAYERS]
});

let code = "";
let role = "";
let picks = [];
let odds = null;
let pollTimer = 0;
let requestPending = false;

function normalizePicks(raw) {
  const seen = new Set();
  return (Array.isArray(raw) ? raw : []).filter((id) => {
    if (!playerById.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function draftRequest({ method = "GET", body = null } = {}) {
  const response = await fetch(`${DRAFT_API_BASE}/draft`, {
    method,
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : null
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || `Draft request failed (${response.status})`);
  return payload;
}

function draftTeamAt(index) {
  return ["jake", "jack"][Math.max(0, Number(index) || 0) % 2];
}

function currentTeam() {
  return draftTeamAt(picks.length);
}

function picksFor(team) {
  return picks
    .filter((_, index) => draftTeamAt(index) === team)
    .map((id) => playerById.get(id))
    .filter(Boolean);
}

function totalHandicap(players, captain) {
  return players.reduce((total, player) => total + player.handicap, captain.handicap);
}

function makePlayerRow(player, pickNumber) {
  const row = document.createElement("li");
  row.className = "draft-picked-player";
  const order = document.createElement("span");
  order.className = "draft-pick-number";
  order.textContent = pickNumber ? `#${pickNumber}` : "C";
  const name = document.createElement("strong");
  name.textContent = player.name;
  const handicap = document.createElement("span");
  handicap.className = "draft-handicap";
  handicap.textContent = String(player.handicap);
  handicap.setAttribute("aria-label", `Handicap ${player.handicap}`);
  row.append(order, name, handicap);
  return row;
}

function renderTeam(team) {
  const captain = CAPTAINS[team];
  const teamPicks = picksFor(team);
  const list = document.getElementById(`${team}_team`);
  list.replaceChildren(makePlayerRow(captain));
  picks.forEach((id, index) => {
    if (draftTeamAt(index) !== team) return;
    const player = playerById.get(id);
    if (player) list.append(makePlayerRow(player, index + 1));
  });
  document.getElementById(`${team}_count`).textContent = `${teamPicks.length + 1} player${teamPicks.length ? "s" : ""}`;
  document.getElementById(`${team}_total`).textContent = String(totalHandicap(teamPicks, captain));
}

function canMakeCurrentPick() {
  return role === "jack" || (role === "jake" && currentTeam() === "jake");
}

function renderPool() {
  const picked = new Set(picks);
  const available = PLAYERS.filter((player) => !picked.has(player.id));
  const pool = document.getElementById("draft_players");
  const team = currentTeam();
  const canPick = canMakeCurrentPick() && !requestPending;
  pool.replaceChildren();
  available.forEach((player) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "draft-player";
    button.dataset.playerId = player.id;
    button.disabled = !canPick;
    button.setAttribute("aria-label", `Draft ${player.name}, handicap ${player.handicap}, to ${team === "jake" ? "Jake" : "Jack"}`);
    const name = document.createElement("strong");
    name.textContent = player.name;
    const handicap = document.createElement("span");
    const label = document.createElement("small");
    label.textContent = "HCP";
    handicap.append(label, String(player.handicap));
    button.append(name, handicap);
    pool.append(button);
  });
  document.getElementById("draft_remaining").textContent = `${available.length} remaining`;
  document.getElementById("draft_complete").hidden = available.length !== 0;
}

function renderTurn() {
  const turn = document.getElementById("draft_turn");
  if (picks.length === PLAYERS.length) {
    turn.className = "draft-turn match-play-target is-complete";
    turn.innerHTML = "<span>Draft complete</span><strong>Teams are set</strong>";
    return;
  }
  const team = currentTeam();
  const captain = team === "jake" ? "Jake" : "Jack";
  turn.className = `draft-turn match-play-target draft-turn-${team}`;
  const instruction = canMakeCurrentPick()
    ? "Select a player"
    : role === "jake"
      ? "Waiting for Jack"
      : "Live view";
  turn.innerHTML = `<span>Pick ${picks.length + 1}</span><strong>${captain} is on the clock</strong><em>${instruction}</em>`;
}

function renderEventOdds() {
  const event = odds?.event;
  const root = document.getElementById("draft_event_odds");
  if (!event) {
    root.innerHTML = '<div class="small">Calculating event odds…</div>';
    document.getElementById("draft_odds_meta").textContent = "Match-play simulation";
    return;
  }
  root.innerHTML = `
    <div class="draft-event-odd draft-event-odd-jake"><span>Jake</span><strong>${event.jakeWinProbability}%</strong></div>
    <div class="draft-event-odd draft-event-odd-tie"><span>Tie</span><strong>${event.tieProbability}%</strong></div>
    <div class="draft-event-odd draft-event-odd-jack"><span>Jack</span><strong>${event.jackWinProbability}%</strong></div>
  `;
  document.getElementById("draft_odds_meta").textContent = `${Number(odds.simCount || 0).toLocaleString()} simulations`;
}

function render() {
  renderTeam("jack");
  renderTeam("jake");
  renderTurn();
  renderEventOdds();
  renderPool();
  document.getElementById("draft_matches_link").hidden = picks.length !== PLAYERS.length;
  const isAdmin = role === "jack";
  document.getElementById("draft_undo").hidden = !isAdmin;
  document.getElementById("draft_reset").hidden = !isAdmin;
  document.getElementById("draft_logout").hidden = !role;
  document.getElementById("draft_login_toggle").hidden = !!role;
  document.getElementById("draft_undo").disabled = !picks.length || requestPending;
  document.getElementById("draft_reset").disabled = requestPending;
}

function setSync(message, isError = false) {
  const node = document.getElementById("draft_sync");
  node.textContent = message;
  node.classList.toggle("is-error", isError);
}

async function refreshDraft({ quiet = false } = {}) {
  try {
    const state = await draftRequest();
    picks = normalizePicks(state.picks);
    odds = state.odds || null;
    presence.applyViewers(state.viewers);
    render();
    if (!quiet) setSync("Live draft connected");
  } catch (error) {
    setSync(error.message, true);
  }
}

async function submitAction(action, playerId = "") {
  if (requestPending) return;
  requestPending = true;
  render();
  setSync("Updating draft…");
  try {
    const state = await draftRequest({ method: "POST", body: { code, action, playerId } });
    picks = normalizePicks(state.picks);
    odds = state.odds || null;
    setSync("Draft updated");
  } catch (error) {
    setSync(error.message, true);
    await refreshDraft({ quiet: true });
  } finally {
    requestPending = false;
    render();
  }
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = window.setInterval(() => refreshDraft({ quiet: true }), POLL_INTERVAL_MS);
}

function showBoard() {
  document.getElementById("draft_login_form").hidden = true;
  document.getElementById("draft_role").textContent = role === "jack"
    ? "Signed in as Jack · Admin."
    : role === "jake"
      ? "Signed in as Jake."
      : "Public live view.";
  render();
}

async function authenticate(candidateCode) {
  const normalized = String(candidateCode || "").trim().toUpperCase().replace(/[\s-]+/g, "");
  if (!normalized) return;
  const status = document.getElementById("draft_login_status");
  status.textContent = "Checking code…";
  try {
    const state = await draftRequest({ method: "POST", body: { code: normalized, action: "authenticate" } });
    code = normalized;
    role = state.role;
    picks = normalizePicks(state.picks);
    odds = state.odds || null;
    sessionStorage.setItem(DRAFT_SESSION_KEY, code);
    showBoard();
    setSync("Live draft connected");
  } catch (error) {
    status.textContent = error.message;
  }
}

document.getElementById("draft_login_form").addEventListener("submit", (event) => {
  event.preventDefault();
  authenticate(new FormData(event.currentTarget).get("code"));
});
document.getElementById("draft_login_toggle").addEventListener("click", () => {
  const form = document.getElementById("draft_login_form");
  form.hidden = !form.hidden;
  if (!form.hidden) document.getElementById("draft_code").focus();
});
document.getElementById("draft_players").addEventListener("click", (event) => {
  const playerButton = event.target.closest("[data-player-id]");
  if (playerButton && !playerButton.disabled) submitAction("pick", playerButton.dataset.playerId);
});
document.getElementById("draft_undo").addEventListener("click", () => submitAction("undo"));
document.getElementById("draft_reset").addEventListener("click", () => {
  if (window.confirm("Reset the entire draft?")) submitAction("reset");
});
document.getElementById("draft_logout").addEventListener("click", () => {
  sessionStorage.removeItem(DRAFT_SESSION_KEY);
  code = "";
  role = "";
  document.getElementById("draft_code").value = "";
  showBoard();
  setSync("Live draft connected");
});

const savedCode = sessionStorage.getItem(DRAFT_SESSION_KEY);
showBoard();
refreshDraft();
startPolling();
if (savedCode) authenticate(savedCode);
