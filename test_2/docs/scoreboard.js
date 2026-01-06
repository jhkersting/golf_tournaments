import { api, qs, dotsForStrokes } from "./app.js";

const tid = qs("t");
const roundFilter = document.getElementById("round_filter");
const btnTeam = document.getElementById("btn_team");
const btnPlayer = document.getElementById("btn_player");
const toggleNote = document.getElementById("toggle_note");
const lbTitle = document.getElementById("lb_title");
const lbHead = document.getElementById("lb_head");
const lbTbl = document.getElementById("lb_tbl");
const updated = document.getElementById("updated");
const status = document.getElementById("status");
const raw = document.getElementById("raw");

const scorecardCard = document.getElementById("scorecard_card");
const scTitle = document.getElementById("sc_title");
const scSub = document.getElementById("sc_sub");
const scGrid = document.getElementById("sc_grid");

let mode = "team"; // team|player
let lastData = null;

function toParStr(diff){
  const d = Math.round(diff);
  if (d === 0) return "E";
  return d > 0 ? `+${d}` : `${d}`;
}

function setLoading(text="Loading…"){
  status.textContent = text;
}

function populateRounds(rounds){
  roundFilter.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "all";
  optAll.textContent = "Full Tournament";
  roundFilter.appendChild(optAll);

  rounds.forEach((r, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    const fmt = (r.format || "").toUpperCase();
    o.textContent = `${i+1}: ${r.name || `Round ${i+1}`} (${fmt}${r.useHandicap ? " NET" : ""})`;
    roundFilter.appendChild(o);
  });
}

function currentRoundIndex(){
  const v = roundFilter.value;
  if (v === "all") return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function headRow(isTeam){
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <th class="left">#</th>
    <th class="left">${isTeam ? "Team" : "Player"}</th>
    <th>±</th>
    <th>Thru</th>
    <th>Strokes</th>
  `;
  lbHead.replaceWith(tr);
  tr.id = "lb_head";
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

function buildScorecardFromScores(title, subtitle, scores, useHandicap){
  scTitle.textContent = title;
  scSub.textContent = subtitle || "";
  scGrid.innerHTML = "";

  const tbl = document.createElement("table");
  tbl.className = "table";

  const thead = document.createElement("thead");
  const trDots = document.createElement("tr");
  trDots.innerHTML = `<th class="left"></th>` + scores.handicapShots.map(s => `<th class="mono dots">${dotsForStrokes(s)}</th>`).join("") + `<th></th><th></th><th></th>`;
  thead.appendChild(trDots);

  const trH = document.createElement("tr");
  trH.innerHTML = `<th class="left">Row</th>` + Array.from({length:18},(_,i)=>`<th>${i+1}</th>`).join("") + `<th>Total</th><th>±Par</th><th>Thru</th>`;
  thead.appendChild(trH);
  tbl.appendChild(thead);

  const tbody = document.createElement("tbody");

  const row = (label, arr, total, diffTotal, thru) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="left"><b>${label}</b></td>` +
      arr.map(v => `<td class="mono">${v == null ? "" : v}</td>`).join("") +
      `<td class="mono"><b>${total}</b></td>` +
      `<td class="mono"><b>${toParStr(diffTotal)}</b></td>` +
      `<td class="mono"><b>${thru}</b></td>`;
    return tr;
  };

  // Par row (only for holes that have scores, otherwise blank to match UX)
  const parRowArr = scores.par.map((p,i)=> (scores.gross[i] == null ? "" : p));
  const parPlayed = scores.par.reduce((acc,p,i)=> acc + (scores.gross[i] == null ? 0 : Number(p||0)), 0);

  const trPar = document.createElement("tr");
  trPar.innerHTML = `<td class="left"><b>Par</b></td>` +
    parRowArr.map(v => `<td class="mono">${v}</td>`).join("") +
    `<td class="mono"><b>${parPlayed}</b></td>` +
    `<td class="mono"><b>—</b></td>` +
    `<td class="mono"><b>${scores.thru}</b></td>`;
  tbody.appendChild(trPar);

  // Gross
  const grossTotal = scores.gross.reduce((acc,v)=> acc + (v==null?0:Number(v)), 0);
  tbody.appendChild(row("Gross", scores.gross, grossTotal, scores.toParGrossTotal, scores.thru));

  // Net
  if (useHandicap){
    const netTotal = scores.net.reduce((acc,v)=> acc + (v==null?0:Number(v)), 0);
    tbody.appendChild(row("Net", scores.net, netTotal, scores.toParNetTotal, scores.thru));
  }

  tbl.appendChild(tbody);
  scGrid.appendChild(tbl);

  scorecardCard.style.display = "block";
}

async function showScorecardForRow(data, row){
  const rIdx = currentRoundIndex();
  if (rIdx == null){
    scorecardCard.style.display = "none";
    return;
  }

  const round = data.tournament.rounds[rIdx];
  const isTeam = (mode === "team");

  // If the row already includes hole-by-hole scores, use them.
  if (row.scores){
    const title = isTeam ? `${row.teamName} — ${round.name || `Round ${rIdx+1}`}` : `${row.name} — ${round.name || `Round ${rIdx+1}`}`;
    const subtitle = isTeam ? `Round ${rIdx+1} • ${round.format.toUpperCase()}` : `${row.teamName || ""} • Round ${rIdx+1} • ${round.format.toUpperCase()}`;
    buildScorecardFromScores(title, subtitle, row.scores, !!round.useHandicap);
    return;
  }

  // Fallback: call scorecard endpoint (still supported)
  try{
    const modeQ = isTeam ? "team" : "player";
    const idQ = isTeam ? row.teamId : row.playerId;
    const sc = await api(`/tournaments/${encodeURIComponent(tid)}/scorecard?round=${rIdx}&mode=${modeQ}&id=${encodeURIComponent(idQ)}`);

    // Normalize to the same shape our renderer expects
    const pars = sc.course.pars;
    const gross = sc.grossHoles || Array(18).fill(null);
    const shots = (sc.useHandicap ? sc.course.strokeIndex.map((_,i)=>0) : Array(18).fill(0)); // not available; renderer just needs zeros
    const scores = {
      gross,
      net: sc.netHoles || gross.slice(),
      par: pars,
      handicapShots: shots,
      toParGrossTotal: 0,
      toParNetTotal: 0,
      thru: sc.thru ?? 0
    };
    buildScorecardFromScores(sc.title, sc.subtitle, scores, !!sc.useHandicap);
  } catch(e){
    console.error(e);
    status.textContent = `Scorecard error: ${e.message || e}`;
  }
}

function applyRoundRules(data){
  const rIdx = currentRoundIndex();
  if (rIdx == null){
    // tournament view: both toggles available
    btnTeam.disabled = false;
    btnPlayer.disabled = false;
    toggleNote.textContent = "Full Tournament totals only.";
    return;
  }
  const round = data.tournament.rounds[rIdx];
  const isScramble = round.format === "scramble";
  if (isScramble){
    mode = "team";
    btnTeam.classList.add("active");
    btnPlayer.classList.remove("active");
    btnPlayer.style.display = "none";
    toggleNote.textContent = "Scramble is team-only.";
  } else {
    btnPlayer.style.display = "";
    toggleNote.textContent = "Toggle Team vs Individual for this round.";
  }
}

async function refresh(){
  if (!tid){
    setLoading("Missing ?t=TOURNAMENT_ID");
    return;
  }

  try{
    const rIdx = currentRoundIndex();
    const q = (rIdx == null) ? "all" : String(rIdx);
    const data = await api(`/tournaments/${encodeURIComponent(tid)}/scoreboard?round=${encodeURIComponent(q)}`);
    lastData = data;

    updated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    raw.textContent = JSON.stringify(data, null, 2);

    // populate rounds once
    if (roundFilter.options.length <= 1){
      populateRounds(data.tournament.rounds || []);
    }

    applyRoundRules(data);
    renderLeaderboard(data);
    setLoading("");
  } catch(e){
    console.error(e);
    setLoading(e.message || String(e));
  }
}

btnTeam.onclick = () => {
  mode = "team";
  btnTeam.classList.add("active");
  btnPlayer.classList.remove("active");
  if (lastData) renderLeaderboard(lastData);
};
btnPlayer.onclick = () => {
  mode = "player";
  btnPlayer.classList.add("active");
  btnTeam.classList.remove("active");
  if (lastData) renderLeaderboard(lastData);
};

roundFilter.onchange = () => {
  scorecardCard.style.display = "none";
  refresh();
};

(async function init(){
  setLoading();
  await refresh();
  // live refresh
  setInterval(refresh, 15000);
})();
