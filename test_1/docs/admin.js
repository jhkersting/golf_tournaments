import { api, downloadText, baseUrlForGithubPages, sum } from "./app.js";

const roundsEl = document.getElementById("rounds");
const addRoundBtn = document.getElementById("add_round");
const createBtn = document.getElementById("create_tournament");
const createStatus = document.getElementById("create_status");

const createdBox = document.getElementById("created_box");
const tidEl = document.getElementById("tid");
const scoreboardLinkEl = document.getElementById("scoreboard_link");

const importBtn = document.getElementById("import_players");
const importStatus = document.getElementById("import_status");
const csvEl = document.getElementById("csv");

const parRow = document.getElementById("par_row");
const siRow = document.getElementById("si_row");
document.getElementById("par4").onclick = () => { for (let h=1;h<=18;h++) parRow.querySelector(`input[data-hole='${h}']`).value="4"; updateParTotal(); };
document.getElementById("siReset").onclick = () => { for (let h=1;h<=18;h++) siRow.querySelector(`input[data-hole='${h}']`).value=String(h); };

function makeInputCell(kind, hole, value, min, max){
  const td = document.createElement("td");
  const inp = document.createElement("input");
  inp.type = "number";
  inp.step = "1";
  inp.min = String(min);
  inp.max = String(max);
  inp.value = String(value);
  inp.dataset.kind = kind;
  inp.dataset.hole = String(hole);
  inp.style.width = "56px";
  inp.style.textAlign = "center";
  td.appendChild(inp);
  return td;
}

function rebuildCourseRows(){
  while (parRow.children.length > 1) parRow.removeChild(parRow.lastChild);
  while (siRow.children.length > 1) siRow.removeChild(siRow.lastChild);

  for (let h=1; h<=18; h++){
    parRow.appendChild(makeInputCell("par", h, 4, 3, 6));
    siRow.appendChild(makeInputCell("si", h, h, 1, 18));
  }

  const tdParTot = document.createElement("td");
  tdParTot.id = "par_total";
  tdParTot.textContent = "72";
  parRow.appendChild(tdParTot);

  const tdSiTot = document.createElement("td");
  tdSiTot.className = "small";
  tdSiTot.textContent = "";
  siRow.appendChild(tdSiTot);

  parRow.addEventListener("input", updateParTotal);
  updateParTotal();
}

function updateParTotal(){
  const pars = getPars();
  const tot = sum(pars);
  document.getElementById("par_total").textContent = String(tot);
}

function getPars(){
  const pars=[];
  for (let h=1;h<=18;h++){
    const v = Number(parRow.querySelector(`input[data-hole='${h}']`)?.value);
    pars.push(Number.isFinite(v) ? v : 4);
  }
  return pars;
}
function getStrokeIndex(){
  const si=[];
  for (let h=1;h<=18;h++){
    const v = Number(siRow.querySelector(`input[data-hole='${h}']`)?.value);
    si.push(Number.isFinite(v) ? v : h);
  }
  return si;
}
function validateStrokeIndex(si){
  const set = new Set(si);
  if (set.size !== 18) return "Stroke Index must contain 18 unique values.";
  for (const v of si){
    if (!Number.isInteger(v) || v<1 || v>18) return "Stroke Index values must be integers 1–18.";
  }
  return null;
}

function roundCard(){
  const div = document.createElement("div");
  div.className = "card";
  div.style.margin = "12px 0";
  div.innerHTML = `
    <div class="actions" style="justify-content:space-between;">
      <div><b>Round</b></div>
      <button class="secondary" data-remove>Remove</button>
    </div>
    <div class="row" style="margin-top:10px;">
      <div class="col">
        <label>Round name</label>
        <input data-name placeholder="Day 1 Scramble" />
      </div>
      <div class="col">
        <label>Format</label>
        <select data-format>
          <option value="scramble">scramble</option>
          <option value="shamble">shamble</option>
          <option value="singles">singles</option>
        </select>
      </div>
      <div class="col">
        <label>Use handicaps?</label>
        <select data-handicap>
          <option value="false">No</option>
          <option value="true">Yes</option>
        </select>
      </div>
      <div class="col">
        <label>Weight</label>
        <input data-weight type="number" step="0.01" placeholder="0.50" />
      </div>
    </div>

    <div class="row" style="margin-top:8px;" data-aggrow>
      <div class="col">
        <label>Team aggregation</label>
        <select data-aggmode>
          <option value="sum">Sum</option>
          <option value="avg">Average</option>
        </select>
        <div class="small">How team score is computed from players for this round (team leaderboard only).</div>
      </div>
      <div class="col">
        <label>Top X scores taken</label>
        <input data-topx type="number" min="1" max="4" step="1" value="4" />
        <div class="small">Sort players by net (or gross) and take best X (lowest) for team score.</div>
      </div>
    </div>
  `;

  const fmt = div.querySelector("[data-format]");
  const aggRow = div.querySelector("[data-aggrow]");
  function syncAggVisibility(){
    // Scramble is inherently team score already, no need for aggregation inputs
    aggRow.style.display = (fmt.value === "scramble") ? "none" : "";
  }
  fmt.addEventListener("change", syncAggVisibility);
  syncAggVisibility();

  div.querySelector("[data-remove]").onclick = () => div.remove();
  return div;
}

function addRound(){ roundsEl.appendChild(roundCard()); }
addRoundBtn.onclick = addRound;

// Defaults: 2 rounds
addRound(); addRound();
rebuildCourseRows();

function getRounds(){
  const cards = [...roundsEl.querySelectorAll(".card")];
  return cards.map(c => {
    const format = c.querySelector("[data-format]")?.value;
    const useHandicap = c.querySelector("[data-handicap]")?.value === "true";
    const weight = Number(c.querySelector("[data-weight]")?.value || 0);
    const aggMode = c.querySelector("[data-aggmode]")?.value || "sum";
    const topX = Number(c.querySelector("[data-topx]")?.value || 4);

    return {
      name: c.querySelector("[data-name]")?.value.trim() || "Round",
      format,
      useHandicap,
      weight,
      teamAggregation: {
        mode: aggMode,               // sum | avg
        topX: Math.max(1, Math.min(4, Math.floor(topX || 4)))
      }
    };
  }).filter(r => r.weight > 0);
}

createBtn.onclick = async () => {
  createStatus.textContent = "";
  try{
    const name = document.getElementById("t_name").value.trim();
    const dates = document.getElementById("t_dates").value.trim();
    const rounds = getRounds();
    if (!name) throw new Error("Tournament name is required.");
    if (!rounds.length) throw new Error("Add at least one round with positive weight.");

    const pars = getPars();
    const si = getStrokeIndex();
    const siErr = validateStrokeIndex(si);
    if (siErr) throw new Error(siErr);

    createStatus.textContent = "Creating…";
    const out = await api("/tournaments", { method:"POST", body:{ name, dates, rounds, course:{ pars, strokeIndex: si } } });
    const tid = out.tournamentId;
    tidEl.textContent = tid;

    const base = baseUrlForGithubPages();
    scoreboardLinkEl.textContent = `${base}/scoreboard.html?t=${encodeURIComponent(tid)}`;
    createdBox.style.display = "block";
    createStatus.textContent = "Created.";
  } catch(e){
    console.error(e);
    createStatus.textContent = e.message || String(e);
  }
};

importBtn.onclick = async () => {
  importStatus.textContent = "";
  const tid = tidEl.textContent.trim();
  if (!tid) return (importStatus.textContent = "Create a tournament first.");
  try{
    const csvText = csvEl.value.trim();
    if (!csvText) throw new Error("Paste CSV into the box first.");
    const base = baseUrlForGithubPages();

    importStatus.textContent = "Importing…";
    const out = await api(`/tournaments/${encodeURIComponent(tid)}/players/import`, {
      method:"POST",
      body:{ csvText, baseUrl: base }
    });

    downloadText(`players_with_codes_${tid}.csv`, out.downloadCsv);
    importStatus.textContent = `Done. Imported ${out.count || "?"} players.`;
  } catch(e){
    console.error(e);
    importStatus.textContent = e.message || String(e);
  }
};
