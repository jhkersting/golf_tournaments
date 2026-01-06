import { api, staticJson, qs, dotsForStrokes } from "./app.js";

const tid = qs("t");
const roundFilter = document.getElementById("round_filter");
const btnTeam = document.getElementById("btn_team");
const btnPlayer = document.getElementById("btn_player");
const toggleNote = document.getElementById("toggle_note");
const lbTitle = document.getElementById("lb_title");
const lbTbl = document.getElementById("lb_tbl");
const updated = document.getElementById("updated");
const status = document.getElementById("status");
const raw = document.getElementById("raw");

const scorecardCard = document.getElementById("scorecard_card");
const scTitle = document.getElementById("sc_title");
const scSub = document.getElementById("sc_sub");
const scGrid = document.getElementById("sc_grid");

let mode = "team"; // "team" | "player"
let currentRound = "all"; // "all" | number
let TOURN = null;

function toParStrFromDiff(diff){
  const d = Math.round(diff);
  if (d === 0) return "E";
  return d > 0 ? `+${d}` : `${d}`;
}

function buildScorecardFromScores(title, subtitle, scores, useHandicap){
  scTitle.textContent = title;
  scSub.textContent = subtitle || "";
  scGrid.innerHTML = "";

  const tbl = document.createElement("table");
  tbl.className = "table";

  const thead = document.createElement("thead");
  const trDots = document.createElement("tr");
  trDots.innerHTML = `<th class="left"></th>` + (scores.handicapShots || Array(18).fill(0)).map(n => `<th class="mono dots">${dotsForStrokes(n)}</th>`).join("") + `<th></th><th></th><th></th>`;
  thead.appendChild(trDots);

  const trH = document.createElement("tr");
  trH.innerHTML = `<th class="left">Row</th>` +
    Array.from({length:18},(_,i)=>`<th>${i+1}</th>`).join("") +
    `<th>Total</th><th>±Par</th><th>Thru</th>`;
  thead.appendChild(trH);

  tbl.appendChild(thead);

  const tbody = document.createElement("tbody");

  const gross = scores.gross || Array(18).fill(null);
  const net = scores.net || Array(18).fill(null);
  const par = scores.par || Array(18).fill(0);

  const grossTotal = (scores.grossTotal != null) ? scores.grossTotal : gross.reduce((a,v)=>a+(v==null?0:Number(v)),0);
  const netTotal = (scores.netTotal != null) ? scores.netTotal : net.reduce((a,v)=>a+(v==null?0:Number(v)),0);
  const grossToParTotal = (scores.grossToParTotal != null) ? scores.grossToParTotal : gross.reduce((a,v,i)=>a+(v==null?0:(Number(v)-Number(par[i]||0))),0);
  const netToParTotal = (scores.netToParTotal != null) ? scores.netToParTotal : net.reduce((a,v,i)=>a+(v==null?0:(Number(v)-Number(par[i]||0))),0);
  const thru = (scores.thru != null) ? scores.thru : (() => {
    let last=-1; for(let i=0;i<18;i++){ if(gross[i]!=null && Number(gross[i])>0) last=i; } return last+1;
  })();

  // Gross row
  const trG = document.createElement("tr");
  trG.innerHTML =
    `<td class="left"><b>Gross</b></td>` +
    gross.map(v => `<td class="mono">${v==null?"":String(v)}</td>`).join("") +
    `<td class="mono"><b>${grossTotal}</b></td>` +
    `<td class="mono"><b>${toParStrFromDiff(grossToParTotal)}</b></td>` +
    `<td class="mono"><b>${thru}</b></td>`;
  tbody.appendChild(trG);

  // Net row
  if (useHandicap){
    const trN = document.createElement("tr");
    trN.innerHTML =
      `<td class="left"><b>Net</b></td>` +
      net.map(v => `<td class="mono">${v==null?"":String(v)}</td>`).join("") +
      `<td class="mono"><b>${netTotal}</b></td>` +
      `<td class="mono"><b>${toParStrFromDiff(netToParTotal)}</b></td>` +
      `<td class="mono"><b>${thru}</b></td>`;
    tbody.appendChild(trN);
  }

  // Par row
  const trP = document.createElement("tr");
  trP.innerHTML =
    `<td class="left"><b>Par</b></td>` +
    par.map(v => `<td class="mono">${String(v)}</td>`).join("") +
    `<td class="mono"><b>${par.reduce((a,b)=>a+Number(b||0),0)}</b></td>` +
    `<td class="mono"></td>` +
    `<td class="mono"></td>`;
  tbody.appendChild(trP);

  tbl.appendChild(tbody);
  scGrid.appendChild(tbl);
  scorecardCard.style.display = "block";
}

function renderLeaderboard(data){
  const isTeam = mode === "team";
  lbTitle.textContent = isTeam ? "Teams" : "Individuals";

  const head = document.getElementById("lb_head");
  head.innerHTML = `
    <th class="left">#</th>
    <th class="left">${isTeam ? "Team" : "Player"}</th>
    <th>±</th>
    <th>Thru</th>
    <th>Strokes</th>
  `;

  const tbody = lbTbl.querySelector("tbody");
  tbody.innerHTML = "";

  const rows = isTeam ? (data.teams || []) : (data.players || []);
  rows.forEach((r, idx) => {
    const tr = document.createElement("tr");
    tr.className = "clickable";
    tr.dataset.id = isTeam ? r.teamId : r.playerId;

    tr.innerHTML = `
      <td class="mono">${idx+1}</td>
      <td class="left">
        <div><b>${isTeam ? r.teamName : r.name}</b></div>
        ${(!isTeam && r.teamName) ? `<div class="small muted">${r.teamName}</div>` : ""}
      </td>
      <td class="mono"><b>${r.toPar ?? "E"}</b></td>
      <td class="mono">${(r.thru == null) ? "—" : String(r.thru)}</td>
      <td class="mono">${(r.strokes == null) ? "—" : String(r.strokes)}</td>
    `;

    tr.onclick = () => showScorecardForRow(data, r);
    tbody.appendChild(tr);
  });
}

function showScorecardForRow(data, row){
  if (data.view?.round === "all"){
    scorecardCard.style.display = "block";
    scTitle.textContent = "Scorecard";
    scSub.textContent = "Pick a specific round to view hole-by-hole scorecards.";
    scGrid.innerHTML = "";
    return;
  }

  const rIdx = Number(data.view.round);
  const round = (TOURN?.tournament?.rounds || [])[rIdx] || {};
  const useHandicap = !!round.useHandicap && round.format !== "scramble";

  // Prefer embedded scores (static JSON provides this)
  if (row?.scores){
    const title = (mode === "team") ? row.teamName : row.name;
    const sub = (mode === "team") ? `Round ${rIdx+1}` : `${row.teamName || ""} • Round ${rIdx+1}`;
    buildScorecardFromScores(title, sub, row.scores, useHandicap);
    return;
  }

  // Fallback to API (older backend)
  (async ()=>{
    try{
      const modeQ = (mode === "team") ? "team" : "player";
      const idQ = (mode === "team") ? row.teamId : row.playerId;
      const sc = await api(`/tournaments/${encodeURIComponent(tid)}/scorecard?round=${rIdx}&mode=${modeQ}&id=${encodeURIComponent(idQ)}`);

      const scores = {
        gross: sc.grossHoles || Array(18).fill(null),
        net: sc.netHoles || Array(18).fill(null),
        handicapShots: sc.handicapShots || Array(18).fill(0),
        par: sc.course?.pars || Array(18).fill(0),
        grossTotal: sc.grossTotal,
        netTotal: sc.netTotal,
        grossToParTotal: sc.toParGrossTotal,
        netToParTotal: sc.toParNetTotal,
        thru: sc.thru
      };

      const title = (mode === "team") ? row.teamName : row.name;
      const sub = (mode === "team") ? `Round ${rIdx+1}` : `${row.teamName || ""} • Round ${rIdx+1}`;
      buildScorecardFromScores(title, sub, scores, useHandicap);
    }catch(e){
      console.error(e);
      status.textContent = e.message || String(e);
    }
  })();
}

function buildScoreboardResponse(tournamentJson, viewRound){
  const rounds = tournamentJson.tournament.rounds || [];
  const course = tournamentJson.course || { pars: Array(18).fill(4), strokeIndex: Array.from({length:18},(_,i)=>i+1) };

  if (viewRound === "all"){
    return {
      tournament: tournamentJson.tournament,
      view: { round: "all" },
      course: { parTotal: course.pars.reduce((a,b)=>a+Number(b||0),0), pars: course.pars, strokeIndex: course.strokeIndex },
      teams: tournamentJson.score_data?.leaderboard_all?.teams || [],
      players: tournamentJson.score_data?.leaderboard_all?.players || []
    };
  }

  const rIdx = Number(viewRound);
  const derived = tournamentJson.score_data?.rounds?.[rIdx];
  return {
    tournament: tournamentJson.tournament,
    view: { round: rIdx },
    course: { parTotal: course.pars.reduce((a,b)=>a+Number(b||0),0), pars: course.pars, strokeIndex: course.strokeIndex },
    teams: derived?.leaderboard?.teams || [],
    players: derived?.leaderboard?.players || []
  };
}

async function loadTournament(){
  // Prefer static; fallback to API scoreboard endpoint if not available
  try{
    return await staticJson(`/tournaments/${encodeURIComponent(tid)}.json`, { cacheKey:`tourn:${tid}` });
  }catch(_){
    // If you are still on the DynamoDB backend, this will work:
    const legacy = await api(`/tournaments/${encodeURIComponent(tid)}/scoreboard?round=all`);
    // Convert legacy to a minimal object for UI
    return {
      tournament: legacy.tournament,
      course: legacy.course,
      score_data: { leaderboard_all: { teams: legacy.teams||[], players: legacy.players||[] }, rounds: [] }
    };
  }
}

function render(){
  if (!TOURN) return;
  const data = buildScoreboardResponse(TOURN, currentRound);

  const rLabel = (data.view.round === "all") ? "All rounds" : `Round ${Number(data.view.round)+1}`;
  toggleNote.textContent = `${rLabel}${(data.view.round !== "all" && (TOURN.tournament.rounds?.[Number(data.view.round)]?.useHandicap)) ? " • shows net + gross in scorecards" : ""}`;

  renderLeaderboard(data);

  const ts = TOURN.updatedAt ? new Date(TOURN.updatedAt).toLocaleString() : "—";
  updated.textContent = `Updated: ${ts}`;

  raw.textContent = ""; // keep empty; can enable for debugging
}

btnTeam.onclick = () => { mode = "team"; btnTeam.classList.add("active"); btnPlayer.classList.remove("active"); render(); };
btnPlayer.onclick = () => { mode = "player"; btnPlayer.classList.add("active"); btnTeam.classList.remove("active"); render(); };

roundFilter.onchange = () => {
  const v = roundFilter.value;
  currentRound = (v === "all") ? "all" : Number(v);
  render();
};

(async function init(){
  if (!tid){
    status.textContent = "Missing tournament id (?t=...)";
    return;
  }
  status.textContent = "Loading…";
  try{
    TOURN = await loadTournament();

    // Round selector
    roundFilter.innerHTML = `<option value="all">All rounds (weighted)</option>`;
    (TOURN.tournament.rounds || []).forEach((r, idx) => {
      roundFilter.innerHTML += `<option value="${idx}">Round ${idx+1}: ${r.name || `Round ${idx+1}`}</option>`;
    });

    currentRound = "all";
    roundFilter.value = "all";

    status.textContent = "";
    render();
  }catch(e){
    console.error(e);
    status.textContent = e.message || String(e);
  }
})();