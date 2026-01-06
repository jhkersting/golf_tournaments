import { api, qs, sum, strokesPerHole, toPar, dotsForStrokes } from "./app.js";

const statusEl = document.getElementById("status");
const rawEl = document.getElementById("raw");
const updatedEl = document.getElementById("updated");
const roundFilter = document.getElementById("round_filter");

const btnTeam = document.getElementById("btn_team");
const btnPlayer = document.getElementById("btn_player");
const toggleNote = document.getElementById("toggle_note");

const lbTitle = document.getElementById("lb_title");
const lbHead = document.getElementById("lb_head");
const lbBody = document.querySelector("#lb_tbl tbody");

const scCard = document.getElementById("scorecard_card");
const scTitle = document.getElementById("sc_title");
const scSub = document.getElementById("sc_sub");
const scGrid = document.getElementById("sc_grid");

let cachedMeta = null;
let mode = "team"; // team | player

function setOptions(options, selected){
  roundFilter.innerHTML = "";
  options.forEach(opt => {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    if (opt.value === selected) o.selected = true;
    roundFilter.appendChild(o);
  });
}

function setToggle(newMode){
  mode = newMode;
  btnTeam.classList.toggle("active", mode === "team");
  btnPlayer.classList.toggle("active", mode === "player");
}

function isScrambleRound(roundIdx){
  if (!cachedMeta) return false;
  if (roundIdx === "all") return false;
  const i = Number(roundIdx);
  const r = cachedMeta?.tournament?.rounds?.[i];
  return r?.format === "scramble";
}

function applyToggleRules(){
  const rsel = roundFilter.value || "all";
  const scramble = isScrambleRound(rsel);
  if (scramble){
    // hide/disable individual toggle for scramble round
    btnPlayer.disabled = true;
    btnPlayer.style.display = "none";
    btnTeam.style.display = "inline-block";
    toggleNote.textContent = "Scramble round: team leaderboard only.";
    setToggle("team");
  } else {
    btnPlayer.disabled = false;
    btnPlayer.style.display = "inline-block";
    toggleNote.textContent = "";
  }
}

function setHeader(){
  lbHead.innerHTML = "";
  if (mode === "team"){
    lbTitle.textContent = "Teams";
    lbHead.innerHTML = "<th>#</th><th class='left'>Team</th><th>±Par</th><th>Strokes</th>";
  } else {
    lbTitle.textContent = "Individuals";
    lbHead.innerHTML = "<th>#</th><th class='left'>Player</th><th class='left'>Team</th><th>±Par</th><th>Strokes</th>";
  }
}

function clearScorecard(){
  scCard.style.display = "none";
  scGrid.innerHTML = "";
}

function mkScorecardTable({ pars, strokeIndex, label, grossHoles, handicap=0, useHandicap=false }){
  const parTotal = sum(pars);
  const grossTotal = sum(grossHoles);

  const tbl = document.createElement("table");
  tbl.className = "table";

  // Header with dot row + hole numbers
  const thead = document.createElement("thead");

  const trDots = document.createElement("tr");
  trDots.className = "dotrow";
  trDots.innerHTML = "<th class='left'> </th>" + Array.from({length:18},(_,i)=>"<th><span></span></th>").join("") + "<th></th><th></th>";
  thead.appendChild(trDots);

  const trH = document.createElement("tr");
  trH.innerHTML = "<th class='left'>Hole</th>" + Array.from({length:18},(_,i)=>`<th>${i+1}</th>`).join("") + "<th>Total</th><th>±Par</th>";
  thead.appendChild(trH);

  tbl.appendChild(thead);

  const tbody = document.createElement("tbody");

  const trPar = document.createElement("tr");
  trPar.innerHTML = `<td class='left'><b>Par</b></td>` + pars.map(p=>`<td>${p}</td>`).join("") + `<td><b>${parTotal}</b></td><td class='mono'>—</td>`;
  tbody.appendChild(trPar);

  const trSi = document.createElement("tr");
  trSi.innerHTML = `<td class='left'><b>SI</b></td>` + strokeIndex.map(v=>`<td>${v}</td>`).join("") + `<td class='mono'>—</td><td class='mono'>—</td>`;
  tbody.appendChild(trSi);

  const trGross = document.createElement("tr");
  trGross.innerHTML = `<td class='left'><b>Gross</b></td>` + grossHoles.map(v=>`<td>${v}</td>`).join("") + `<td>${grossTotal}</td><td class='mono'>${toPar(grossTotal, parTotal)}</td>`;
  tbody.appendChild(trGross);

  let strokes = Array(18).fill(0);
  if (useHandicap){
    strokes = strokesPerHole(handicap, strokeIndex);
    // dots row above hole numbers
    const ths = trDots.querySelectorAll("th");
    for (let i=0;i<18;i++){
      ths[i+1].querySelector("span").textContent = dotsForStrokes(strokes[i]);
    }

    const trSt = document.createElement("tr");
    trSt.innerHTML = `<td class='left'><b>Strokes</b></td>` + strokes.map(v=>`<td class='mono'>${v}</td>`).join("") + `<td class='mono'>${sum(strokes)}</td><td class='mono'>—</td>`;
    tbody.appendChild(trSt);

    const netHoles = grossHoles.map((g,i)=> Number(g) - strokes[i]);
    const netTotal = sum(netHoles);
    const trNet = document.createElement("tr");
    trNet.innerHTML = `<td class='left'><b>Net</b></td>` + netHoles.map(v=>`<td class='mono'>${v}</td>`).join("") + `<td><b>${netTotal}</b></td><td class='mono'><b>${toPar(netTotal, parTotal)}</b></td>`;
    tbody.appendChild(trNet);
  }

  tbl.appendChild(tbody);
  return tbl;
}

async function loadScorecard({ tid, round, mode, id }){
  clearScorecard();
  if (round === "all"){
    scCard.style.display = "block";
    scTitle.textContent = "Scorecard";
    scSub.textContent = "Select a specific round to view hole-by-hole scorecards.";
    scGrid.innerHTML = "";
    return;
  }

  // For team scorecards, only meaningful for scramble rounds
  const rIdx = Number(round);
  const rMeta = cachedMeta?.tournament?.rounds?.[rIdx];
  if (mode === "team" && rMeta?.format !== "scramble"){
    scCard.style.display = "block";
    scTitle.textContent = "Scorecard";
    scSub.textContent = "Team scorecard is only shown for scramble rounds. Switch to Individuals to view player scorecards.";
    scGrid.innerHTML = "";
    return;
  }

  const detail = await api(`/tournaments/${encodeURIComponent(tid)}/scorecard?round=${encodeURIComponent(round)}&mode=${encodeURIComponent(mode)}&id=${encodeURIComponent(id)}`);

  scCard.style.display = "block";
  scTitle.textContent = detail.title || "Scorecard";
  scSub.textContent = detail.subtitle || "";

  const pars = detail.course?.pars || Array(18).fill(4);
  const si = detail.course?.strokeIndex || Array.from({length:18},(_,i)=>i+1);

  const table = mkScorecardTable({
    pars,
    strokeIndex: si,
    label: detail.title,
    grossHoles: detail.grossHoles || Array(18).fill(4),
    handicap: detail.handicap || 0,
    useHandicap: !!detail.useHandicap
  });

  scGrid.innerHTML = "";
  scGrid.appendChild(table);
}

function renderLeaderboard(data){
  setHeader();
  lbBody.innerHTML = "";

  const rows = (mode === "team") ? (data.teams || []) : (data.players || []);

  rows.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    if (mode === "team"){
      tr.innerHTML = `<td>${i+1}</td><td class='left'>${r.teamName}</td><td class='mono'>${r.toPar}</td><td class='mono'>${r.strokes}</td>`;
      tr.onclick = () => loadScorecard({ tid: data.tournament.tournamentId, round: roundFilter.value || "all", mode: "team", id: r.teamId });
    } else {
      tr.innerHTML = `<td>${i+1}</td><td class='left'>${r.name}</td><td class='left'>${r.teamName}</td><td class='mono'>${r.toPar}</td><td class='mono'>${r.strokes}</td>`;
      tr.onclick = () => loadScorecard({ tid: data.tournament.tournamentId, round: roundFilter.value || "all", mode: "player", id: r.playerId });
    }
    lbBody.appendChild(tr);
  });
}

async function refresh() {
  const tid = qs("t");
  if (!tid) { statusEl.textContent = "Missing ?t=TOURNAMENT_ID"; return; }

  const round = roundFilter.value || "all";

  try{
    statusEl.textContent = "Loading…";
    const data = await api(`/tournaments/${encodeURIComponent(tid)}/scoreboard?round=${encodeURIComponent(round)}`);
    cachedMeta = data;
    rawEl.textContent = JSON.stringify(data, null, 2);
    updatedEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;

    // init round filter options first time
    if (roundFilter.options.length === 0){
      const opts = [{ value:"all", label:"Full Tournament" }];
      (data.tournament?.rounds || []).forEach((r, idx) => opts.push({ value:String(idx), label:`Round ${idx+1}: ${r.name}` }));
      setOptions(opts, "all");
    }

    applyToggleRules();
    renderLeaderboard(data);
    statusEl.textContent = "";
  } catch(e){
    console.error(e);
    statusEl.textContent = `Error: ${e.message || String(e)}`;
  }
}

btnTeam.onclick = () => { setToggle("team"); renderLeaderboard(cachedMeta || {teams:[],players:[],tournament:{}}); clearScorecard(); };
btnPlayer.onclick = () => { if (btnPlayer.disabled) return; setToggle("player"); renderLeaderboard(cachedMeta || {teams:[],players:[],tournament:{}}); clearScorecard(); };
roundFilter.addEventListener("change", () => { applyToggleRules(); refresh(); clearScorecard(); });

setInterval(refresh, 8000);
refresh();
