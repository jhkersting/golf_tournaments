import {
  api,
  staticJson,
  qs,
  createTeamColorRegistry,
  getRememberedPlayerCode,
  rememberPlayerCode,
  rememberTournamentId
} from "./app.js";

const codeFromQuery = qs("code");
const normalizedCodeFromQuery = String(codeFromQuery || qs("c") || "").trim();
if (normalizedCodeFromQuery) rememberPlayerCode(normalizedCodeFromQuery);
let code = normalizedCodeFromQuery || getRememberedPlayerCode() || "";
const who = document.getElementById("who");
const forms = document.getElementById("round_forms");
const ticker = document.getElementById("enter_ticker");
const tickerTitle = document.getElementById("enter_ticker_title");
const tickerTrack = document.getElementById("enter_ticker_track");

const teamColors = createTeamColorRegistry();
let tickerSectionIndex = 0;
let tickerRafId = 0;
let tickerHoldTimerId = 0;
let tickerRunToken = 0;

function normalizeTeamId(teamId) {
  return teamId == null ? "" : String(teamId).trim();
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

function toParNumber(v) {
  const s = String(v == null ? "" : v).trim().toUpperCase();
  if (!s || s === "E" || s === "EVEN") return 0;
  const n = Number(s);
  if (!Number.isNaN(n)) return n;
  return Number.POSITIVE_INFINITY;
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
  if (tickerRafId) {
    cancelAnimationFrame(tickerRafId);
    tickerRafId = 0;
  }
  if (tickerHoldTimerId) {
    clearTimeout(tickerHoldTimerId);
    tickerHoldTimerId = 0;
  }
}

function setTickerSection(section, token, onDone) {
  if (!ticker || !tickerTrack || !tickerTitle) return;
  const startDelayMs = 3000;
  const nextDelayMs = 3000;
  tickerTitle.textContent = section.label;

  const run = el("div", { class: "enter-ticker-run" });
  if (section.items.length) {
    section.items.forEach((item) => run.appendChild(item));
  } else {
    run.appendChild(el("span", { class: "small" }, "No scores yet"));
  }

  tickerTrack.innerHTML = "";
  tickerTrack.appendChild(run);

  const viewport = tickerTrack.parentElement;
  if (!viewport) return;
  if (!section.items.length) {
    tickerHoldTimerId = setTimeout(() => {
      if (token !== tickerRunToken) return;
      onDone();
    }, nextDelayMs);
    return;
  }

  const speedPxPerSec = 52;
  const startX = 0;
  const endX = -run.offsetWidth;
  let x = startX;
  let prevTs = 0;

  run.style.transform = `translateX(${Math.round(x)}px)`;
  run.style.willChange = "transform";

  function frame(ts) {
    if (token !== tickerRunToken) return;
    if (!prevTs) prevTs = ts;
    const dt = (ts - prevTs) / 1000;
    prevTs = ts;
    x -= speedPxPerSec * dt;
    run.style.transform = `translateX(${Math.round(x)}px)`;
    if (x <= endX) {
      run.style.willChange = "auto";
      tickerHoldTimerId = setTimeout(() => {
        if (token !== tickerRunToken) return;
        onDone();
      }, nextDelayMs);
      return;
    }
    tickerRafId = requestAnimationFrame(frame);
  }

  tickerHoldTimerId = setTimeout(() => {
    if (token !== tickerRunToken) return;
    tickerRafId = requestAnimationFrame(frame);
  }, startDelayMs);
}

function renderTicker(tjson, playersById, teamsById, roundIndex) {
  if (!ticker || !tickerTrack || !tickerTitle) return;
  stopTickerRotation();

  const rounds = tjson?.tournament?.rounds || [];
  if (!rounds.length) {
    ticker.style.display = "none";
    tickerTitle.textContent = "";
    tickerTrack.innerHTML = "";
    return;
  }
  const currentRound = Number(roundIndex);
  const safeRound = Number.isInteger(currentRound) && currentRound >= 0 && currentRound < rounds.length ? currentRound : 0;
  const roundData = tjson?.score_data?.rounds?.[safeRound] || {};
  const roundCfg = rounds[safeRound] || {};
  const isSingleRoundTournament = rounds.length === 1;
  const isScrambleRound = String(roundCfg.format || "").toLowerCase() === "scramble";
  const showIndividualGross = !isScrambleRound;
  const showIndividualNet =
    !!roundCfg.useHandicap && !isScrambleRound;
  const pars = tjson?.course?.pars || Array(18).fill(4);

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

  const playerGrossEntries = allPlayerIds.map((playerId) => {
    const row = playerRowById[playerId] || null;
    const p = playersById[playerId] || {};
    const name = row?.name || p?.name || playerId || "Player";
    const teamId = row?.teamId || p?.teamId;
    const color = colorForTeam(teamId);
    const hasData = rowHasAnyData(row);
    const holeText = holeDisplayFromThru(row);
    const parText = grossToParText(row, pars);
    return {
      name,
      hasData,
      parNum: hasData ? toParNumber(parText) : Number.POSITIVE_INFINITY,
      node: el(
        "span",
        { class: "enter-ticker-item team-accent", style: `--team-accent:${color};` },
        `${name} ${parText} ${holeText}`
      )
    };
  });
  sortTickerEntries(playerGrossEntries);
  const playerGrossItems = playerGrossEntries.map((x) => x.node);

  const playerNetEntries = allPlayerIds.map((playerId) => {
    const row = playerRowById[playerId] || null;
    const p = playersById[playerId] || {};
    const name = row?.name || p?.name || playerId || "Player";
    const teamId = row?.teamId || p?.teamId;
    const color = colorForTeam(teamId);
    const hasData = rowHasAnyData(row);
    const holeText = holeDisplayFromThru(row);
    const parText = netToParText(row, pars);
    return {
      name,
      hasData,
      parNum: hasData ? toParNumber(parText) : Number.POSITIVE_INFINITY,
      node: el(
        "span",
        { class: "enter-ticker-item team-accent", style: `--team-accent:${color};` },
        `${name} ${parText} ${holeText}`
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
    const holeText = holeDisplayFromThru(row);
    const teamName = row?.teamName || teamsById[teamId]?.teamName || teamId || "Team";
    const parText = netToParText(row, pars);
    return {
      name: teamName,
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
    const holeText = holeDisplayFromThru(row);
    const teamName = row?.teamName || teamsById[teamId]?.teamName || teamId || "Team";
    const parText = grossToParText(row, pars);
    return {
      name: teamName,
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

  const sections = [];
  if (isSingleRoundTournament) {
    if (isScrambleRound) {
      sections.push({ label: `${roundLabel} (Net)`, items: teamRoundItems });
      sections.push({ label: `${roundLabel} (Gross)`, items: teamRoundGrossItems });
    } else {
      sections.push({ label: `${roundLabel} (Gross)`, items: playerGrossItems });
      sections.push({ label: `${roundLabel} (Net)`, items: playerNetItems });
    }
  } else {
    if (showIndividualGross) {
      sections.push({ label: `${roundLabel} (Gross)`, items: playerGrossItems });
    }
    if (showIndividualNet) {
      sections.push({ label: `${roundLabel} (Net)`, items: playerNetItems });
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
    ticker.style.display = "none";
    tickerTitle.textContent = "";
    tickerTrack.innerHTML = "";
    return;
  }

  ticker.style.display = "";
  const token = tickerRunToken;
  tickerSectionIndex = 0;
  const playNext = () => {
    if (token !== tickerRunToken) return;
    setTickerSection(sections[tickerSectionIndex], token, () => {
      if (token !== tickerRunToken) return;
      tickerSectionIndex = (tickerSectionIndex + 1) % sections.length;
      playNext();
    });
  };
  playNext();
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
  if (!code) {
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
    const onContinue = () => {
      const nextCode = (input?.value || "").trim();
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
    forms.innerHTML = `<div class="card"><b>Invalid code.</b></div>`;
    return;
  }
  rememberPlayerCode(code);
  rememberTournamentId(tid);
  document.querySelectorAll("a[data-scoreboard-link]").forEach((link) => {
    link.setAttribute("href", `./scoreboard.html?t=${encodeURIComponent(tid)}`);
  });

  // Tournament public JSON (single file)
  const tjson = await staticJson(`/tournaments/${encodeURIComponent(tid)}.json`, { cacheKey: `t:${tid}` });

  $('body').show();
  who.style.display = "";
  who.className = "card";
  who.innerHTML = `
    <div style="display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap;">
      <div>
        <div class="small">Tournament</div>
        <div><b>${tjson.tournament?.name || "Tournament"}</b> <span class="small">${tjson.tournament?.dates || ""}</span></div>
      </div>
      <div>
        <div class="small">You are</div>
        <div><b>${enter.player?.name || ""}</b> <span class="small">(code ${code})</span></div>
      </div>
      <div>
        <div class="small">Team</div>
        <div><b>${enter.team?.teamName || enter.team?.teamId || ""}</b></div>
      </div>
    </div>
  `;

  const rounds = tjson.tournament?.rounds || [];
  const course = tjson.course || { pars: Array(18).fill(4), strokeIndex: Array.from({ length: 18 }, (_, i) => i + 1) };

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
  const defaultGroupIds = playersArr
    .filter((p) => p.teamId === myTeamId)
    .map((p) => p.playerId)
    .filter(Boolean);

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

  // helper: refresh server tjson without clobbering drafts (drafts are in-memory)
  async function refreshTournamentJson() {
    const fresh = await staticJson(`/tournaments/${encodeURIComponent(tid)}.json?v=${Date.now()}`, { cacheKey: `t:${tid}` });
    Object.assign(tjson, fresh);
  }

  for (let r = 0; r < rounds.length; r++) {
    const round = rounds[r] || {};
    const fmt = round.format || "singles";
    const isScramble = fmt === "scramble";
    const canGroup = !isScramble;

    const roundCard = el("div", { class: "card" });
    const roundHead = el("div", { class: "actions", style: "justify-content:space-between; margin-bottom:6px;" });
    roundHead.appendChild(el("h2", { style: "margin:0;" }, `${round.name || `Round ${r + 1}`} — ${fmt}`));
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
        renderTicker(tjson, playersById, teamsById, tickerRoundIndex);
        return;
      }
      setCollapsed(true);
    };

    const wrap = el("div", { class: "small", style: "margin-bottom:8px;" });
    wrap.textContent = isScramble
      ? "Scramble: enter one team score per hole."
      : "Singles/Shamble: enter player scores. You can choose who you're playing with to enter for them too.";
    roundBody.appendChild(wrap);

    // Group picker
    let groupIds = canGroup
      ? loadGroup(tid, r, playersById, defaultGroupIds.length ? defaultGroupIds : [myId].filter(Boolean))
      : [];
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
      const list = el("div", {
        style:
          "display:flex; flex-wrap:wrap; gap:10px; max-height:220px; overflow:auto; padding:8px; border:1px solid var(--border); border-radius:10px; background:var(--surface-strong);",
      });

      function syncGroupChecks() {
        const boxes = list.querySelectorAll("input[type='checkbox'][data-player-id]");
        boxes.forEach((cb) => {
          const pid = cb.getAttribute("data-player-id");
          cb.checked = !!pid && groupIds.includes(pid);
        });
      }

      const btnMeTeam = el("button", { class: "secondary", type: "button" }, "My team");
      btnMeTeam.onclick = () => {
        groupIds = defaultGroupIds.length ? defaultGroupIds : [myId].filter(Boolean);
        saveGroup(tid, r, groupIds);
        syncGroupChecks();
        renderHoleForm();
        renderBulkTable();
      };

      const btnAll = el("button", { class: "secondary", type: "button" }, "All players");
      btnAll.onclick = () => {
        groupIds = playersArr.map((p) => p.playerId);
        saveGroup(tid, r, groupIds);
        syncGroupChecks();
        renderHoleForm();
        renderBulkTable();
      };

      pickerTop.appendChild(btnMeTeam);
      pickerTop.appendChild(btnAll);
      groupPicker.appendChild(pickerTop);

      for (const p of playersArr) {
        const id = p.playerId;
        const checked = groupIds.includes(id);
        const lbl = el("label", { style: "display:flex; align-items:center; gap:6px; cursor:pointer;" });
        const cb = el("input", { type: "checkbox" });
        cb.setAttribute("data-player-id", id);
        cb.checked = checked;
        cb.onchange = () => {
          if (cb.checked) {
            if (!groupIds.includes(id)) groupIds.push(id);
          } else {
            groupIds = groupIds.filter((x) => x !== id);
          }
          if (!groupIds.includes(myId) && myId) groupIds.unshift(myId);
          saveGroup(tid, r, groupIds);
          syncGroupChecks();
          renderHoleForm();
          renderBulkTable();
        };
        lbl.appendChild(cb);
        lbl.appendChild(el("span", {}, `${p.name}${p.teamId ? ` <span class="small">(${p.teamId})</span>` : ""}`));
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
      } else {
        const savedByTarget = {};
        for (const pid of Object.keys(sd.player || {})) {
          const gross = (sd.player[pid]?.gross || Array(18).fill(null)).map((v) => (isEmptyScore(v) ? null : v));
          savedByTarget[pid] = gross;
        }
        const ids = groupIds.length ? groupIds : [myId].filter(Boolean);
        return { type: "player", savedByTarget, targetIds: ids };
      }
    }

    let currentHole = null;      // not chosen yet
    let holeManuallySet = false; // only true after user clicks prev/next or selects a hole

    const status = el("div", { class: "small", style: "margin-top:10px;" }, "");
    const conflictBox = el("div", { class: "card", style: "display:none; border:2px solid var(--bad); margin-top:10px;" });

    function renderHoleForm() {
      holePane.innerHTML = "";
      conflictBox.style.display = "none";
      status.textContent = "";

      const { type, savedByTarget, targetIds } = getSavedForRound();
      // set currentHole to next unplayed, but keep user-selected if they already moved it manually
      const suggested = nextHoleIndexForGroup(savedByTarget, targetIds);

      // On first load (or if user hasn't manually set a hole), jump to next unplayed
      if (!holeManuallySet || currentHole == null || Number.isNaN(currentHole) || currentHole < 0 || currentHole > 17) {
        currentHole = suggested;
      }

      const header = el("div", { class: "hole-header" });
      header.appendChild(
        el(
          "div",
          {},
          `<b>${holeLabel(currentHole)}</b> <span class="small">Par ${course.pars[currentHole]} • SI ${course.strokeIndex[currentHole]}</span>`
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
        const inp = el("input", {
          type: "number",
          min: "1",
          max: "20",
          step: "1",
          style: "width:78px; min-height:38px; padding:6px 8px; border-radius:10px; border:1px solid var(--border); background:var(--field-bg); color:var(--text); font-size:16px;",
        });
        inp.value = initialStr ?? "";
        return inp;
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

        const inp = makeScoreInput(initial);
        inp.addEventListener("input", () => setHoleDraft(r, currentHole, teamId, inp.value));
        inputs.push({ targetId: teamId, input: inp });

        row.appendChild(inp);
        grid.appendChild(row);
      } else {
        const ids = targetIds.length ? targetIds : [myId].filter(Boolean);
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
              `<b>${p.name}</b> <span class="small">${p.handicap != null ? `(hcp ${p.handicap})` : ""}</span><br/><span class="small">Existing: ${existing == null ? "—" : existing
              }</span>`
            )
          );

          const inp = makeScoreInput(initial);
          inp.addEventListener("input", () => setHoleDraft(r, currentHole, pid, inp.value));
          inputs.push({ targetId: pid, input: inp });

          row.appendChild(inp);
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
      btnNext.onclick = () => {
        currentHole = Math.min(17, currentHole + 1);
        holeManuallySet = true;
        renderHoleForm();
      };

      async function doSubmit(withOverride = false) {
        status.textContent = "Submitting…";
        conflictBox.style.display = "none";

        const entries = [];
        for (const { targetId, input } of inputs) {
          const v = (input.value ?? "").trim();
          if (v === "") continue; // skip blanks
          entries.push({ targetId, strokes: Number(v) });
        }
        if (!entries.length) {
          status.textContent = "Enter at least one score for this hole.";
          return;
        }

        try {
          await api(`/tournaments/${encodeURIComponent(tid)}/scores`, {
            method: "POST",
            body: {
              code,
              roundIndex: r,
              mode: "hole",
              holeIndex: currentHole,
              entries,
              override: withOverride,
            },
          });

          status.textContent = "Saved.";

          // clear drafts ONLY for the targets you actually submitted (for this hole)
          clearHoleDraftTargets(
            r,
            currentHole,
            entries.map((e) => e.targetId)
          );

          // refresh tournament json quickly (cache-bust)
          await refreshTournamentJson();
          renderTicker(tjson, playersById, teamsById, tickerRoundIndex);

          // advance to next unplayed hole for group
          const nowSaved = getSavedForRound();
          currentHole = nextHoleIndexForGroup(nowSaved.savedByTarget, nowSaved.targetIds);

          renderHoleForm();
          renderBulkTable();
        } catch (err) {
          if (err?.status === 409 && err?.data) {
            showConflict(err.data);
            return;
          }
          status.textContent = `Error: ${err?.message || String(err)}`;
        }
      }

      function showConflict(j) {
        const conflicts = j.conflicts || [];
        const names = conflicts.map((c) => {
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
    }

    function renderBulkTable() {
      bulkPane.innerHTML = "";

      const { type, savedByTarget, targetIds } = getSavedForRound();
      const ids = type === "team" ? targetIds : targetIds.length ? targetIds : [myId].filter(Boolean);

      const info = el(
        "div",
        { class: "small", style: "margin-bottom:10px;" },
        "Bulk input: paste/update multiple holes then submit. Existing scores will not be overwritten unless you use Override."
      );
      bulkPane.appendChild(info);

      const tableWrap = el("div", { class: "bulk-table-wrap" });
      const tbl = el("table", { class: "table bulk-table" });
      const thead = el("thead");
      const trH = el("tr");
      trH.innerHTML =
        `<th class="left">${type === "team" ? "Team" : "Player"}</th>` +
        `<th>Side</th>` +
        Array.from({ length: 9 }, (_, i) => `<th>${i + 1}</th>`).join("");
      thead.appendChild(trH);
      tbl.appendChild(thead);

      const tbody = el("tbody");
      const rowInputs = {};

      for (const id of ids) {
        const name = type === "team" ? enter.team?.teamName || id : playersById[id]?.name || id;
        const teamId = type === "team" ? id : playersById[id]?.teamId;
        const teamColor = colorForTeam(teamId);
        const holes = (savedByTarget[id] || Array(18).fill(null)).map((v) => (isEmptyScore(v) ? null : v));

        rowInputs[id] = Array(18).fill(null);

        const frontRow = el("tr");
        const nameCell = el(
          "td",
          { class: "left bulk-player team-accent", rowspan: "2", style: `--team-accent:${teamColor};` },
          `<b>${name}</b>`
        );
        frontRow.appendChild(nameCell);
        frontRow.appendChild(el("td", { class: "mono bulk-side" }, "Front 9"));

        for (let i = 0; i < 9; i++) {
          const td = el("td");
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
          inp.addEventListener("input", () => setBulkDraft(r, id, i, inp.value));
          rowInputs[id][i] = inp;
          td.appendChild(inp);
          frontRow.appendChild(td);
        }

        const backRow = el("tr");
        backRow.appendChild(el("td", { class: "mono bulk-side" }, "Back 9"));
        for (let i = 9; i < 18; i++) {
          const td = el("td");
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
          inp.addEventListener("input", () => setBulkDraft(r, id, i, inp.value));
          rowInputs[id][i] = inp;
          td.appendChild(inp);
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
      const btnSubmit = el("button", { class: "", type: "button" }, "Submit bulk");
      const btnOverride = el("button", { class: "secondary", type: "button" }, "Override & submit bulk");
      btnRow.appendChild(btnSubmit);
      btnRow.appendChild(btnOverride);
      bulkPane.appendChild(btnRow);
      bulkPane.appendChild(bulkStatus);

      async function submitBulk(withOverride) {
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
              override: !!withOverride,
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

      btnSubmit.onclick = () => submitBulk(false);
      btnOverride.onclick = () => submitBulk(true);
    }

    // initial render
    renderHoleForm();
    renderBulkTable();

    // Auto-refresh to pick up others' scores quickly (every 30s) without clobbering drafts
    const refreshTimer = setInterval(async () => {
      try {
        await refreshTournamentJson();
        renderTicker(tjson, playersById, teamsById, tickerRoundIndex);
        renderHoleForm();
        renderBulkTable();
      } catch { }
    }, 30_000);

    // keep the timer from being GC'd (optional)
    roundCard._refreshTimer = refreshTimer;

    forms.appendChild(roundCard);
  }

  renderTicker(tjson, playersById, teamsById, tickerRoundIndex);
}

main().catch((e) => {
  forms.innerHTML = `<div class="card"><b>Error:</b> ${e?.message || String(e)}</div>`;
});
