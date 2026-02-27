import { api, downloadText, baseUrlForGithubPages, rememberTournamentId, sum } from "./app.js";
$('body').show();
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
const courseSelect = document.getElementById("course_select");
const courseRefreshBtn = document.getElementById("course_refresh");
const courseNameEl = document.getElementById("course_name");
const courseSaveBtn = document.getElementById("course_save");
const courseStatus = document.getElementById("course_status");
document.getElementById("par4").onclick = () => { for (let h=1;h<=18;h++) parRow.querySelector(`input[data-hole='${h}']`).value="4"; updateParTotal(); };
document.getElementById("siReset").onclick = () => { for (let h=1;h<=18;h++) siRow.querySelector(`input[data-hole='${h}']`).value=String(h); };

let savedCourses = [];
let selectedCourseId = "";

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

function normalizeCourse(course){
  if (!course || typeof course !== "object") return null;
  const courseId = String(course.courseId || course.id || "").trim();
  const name = String(course.name || "").trim();
  const pars = Array.isArray(course.pars) ? course.pars.map((v) => Number(v) || 0) : null;
  const strokeIndex = Array.isArray(course.strokeIndex)
    ? course.strokeIndex.map((v) => Number(v) || 0)
    : null;
  return { courseId, name, pars, strokeIndex };
}

function extractCourseList(payload){
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.courses)) return payload.courses;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function fillCourseRows(pars, strokeIndex){
  if (!Array.isArray(pars) || pars.length !== 18) return;
  if (!Array.isArray(strokeIndex) || strokeIndex.length !== 18) return;
  for (let h = 1; h <= 18; h++) {
    const parInput = parRow.querySelector(`input[data-hole='${h}']`);
    const siInput = siRow.querySelector(`input[data-hole='${h}']`);
    if (parInput) parInput.value = String(Number(pars[h - 1]) || 4);
    if (siInput) siInput.value = String(Number(strokeIndex[h - 1]) || h);
  }
  updateParTotal();
}

function renderCourseOptions(){
  if (!courseSelect) return;
  const previous = selectedCourseId || courseSelect.value || "";
  courseSelect.innerHTML = `<option value="">Custom / current values</option>`;
  for (const c of savedCourses){
    const id = String(c.courseId || "").trim();
    if (!id) continue;
    const label = c.name || id;
    courseSelect.innerHTML += `<option value="${id}">${label}</option>`;
  }
  const canKeep = previous && savedCourses.some((c) => String(c.courseId || "").trim() === previous);
  courseSelect.value = canKeep ? previous : "";
  selectedCourseId = courseSelect.value || "";
}

async function loadCourses(){
  if (!courseStatus) return;
  courseStatus.textContent = "Loading courses…";
  try {
    const payload = await api("/courses");
    savedCourses = extractCourseList(payload)
      .map(normalizeCourse)
      .filter((c) => c && c.courseId);
    renderCourseOptions();
    courseStatus.textContent = `Loaded ${savedCourses.length} course${savedCourses.length === 1 ? "" : "s"}.`;
  } catch (e) {
    console.error(e);
    courseStatus.textContent = e.message || String(e);
  }
}

async function loadCourseById(courseId){
  const id = String(courseId || "").trim();
  if (!id) return;

  courseStatus.textContent = "Loading course…";
  try {
    const payload = await api(`/courses/${encodeURIComponent(id)}`);
    const c = normalizeCourse(payload?.course || payload);
    if (!c || !Array.isArray(c.pars) || c.pars.length !== 18 || !Array.isArray(c.strokeIndex) || c.strokeIndex.length !== 18) {
      throw new Error("Course response is missing pars/strokeIndex.");
    }
    fillCourseRows(c.pars, c.strokeIndex);
    courseNameEl.value = c.name || "";
    selectedCourseId = id;
    courseStatus.textContent = `Loaded course: ${c.name || id}`;
  } catch (e) {
    console.error(e);
    courseStatus.textContent = e.message || String(e);
  }
}

async function saveCourse(){
  const name = String(courseNameEl?.value || "").trim();
  if (!name) {
    courseStatus.textContent = "Course name is required.";
    return;
  }
  const pars = getPars();
  const si = getStrokeIndex();
  const siErr = validateStrokeIndex(si);
  if (siErr) {
    courseStatus.textContent = siErr;
    return;
  }

  const course = { name, pars, strokeIndex: si };
  if (selectedCourseId) course.courseId = selectedCourseId;

  courseStatus.textContent = selectedCourseId ? "Updating course…" : "Saving course…";
  try {
    const payload = await api("/courses", {
      method: "POST",
      body: { course }
    });

    const outCourse = normalizeCourse(payload?.course || payload);
    const returnedId = String(outCourse?.courseId || selectedCourseId || "").trim();
    if (returnedId) selectedCourseId = returnedId;

    await loadCourses();
    if (selectedCourseId && courseSelect) {
      courseSelect.value = selectedCourseId;
      await loadCourseById(selectedCourseId);
    } else {
      courseStatus.textContent = `Saved course: ${name}`;
    }
  } catch (e) {
    console.error(e);
    courseStatus.textContent = e.message || String(e);
  }
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
if (courseRefreshBtn) courseRefreshBtn.onclick = () => loadCourses();
if (courseSaveBtn) courseSaveBtn.onclick = () => saveCourse();
if (courseSelect) {
  courseSelect.onchange = async () => {
    const id = String(courseSelect.value || "").trim();
    if (!id) {
      selectedCourseId = "";
      courseStatus.textContent = "Using custom/current course values.";
      return;
    }
    selectedCourseId = id;
    await loadCourseById(id);
  };
}
loadCourses();

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

    const courseName = document.getElementById("course_name").value.trim();
    const pars = getPars();
    const si = getStrokeIndex();
    const siErr = validateStrokeIndex(si);
    if (siErr) throw new Error(siErr);

    createStatus.textContent = "Creating…";
    const out = await api("/tournaments", {
      method:"POST",
      body:{
        name,
        dates,
        rounds,
        course:{
          ...(courseName ? { name: courseName } : {}),
          pars,
          strokeIndex: si
        }
      }
    });
    const tid = out.tournamentId;
    rememberTournamentId(tid);
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
function tsvToCsv(text) {
  const lines = text.split(/\r?\n/);

  return lines.map(line => {
    return line
      .split('\t')
      .map(cell => {
        // escape quotes
        const escaped = cell.replace(/"/g, '""');
        // wrap in quotes if needed
        return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped;
      })
      .join(',');
  }).join('\n');
}

function normalizeDelimitedText(text) {
  // Heuristic: if it has tabs and no commas, treat as TSV
  const hasTabs = text.includes('\t');
  const hasCommas = text.includes(',');

  if (hasTabs && !hasCommas) {
    return tsvToCsv(text);
  }

  return text; // already CSV
}

importBtn.onclick = async () => {
  importStatus.textContent = "";
  const tid = tidEl.textContent.trim();
  if (!tid) {
    importStatus.textContent = "Create a tournament first.";
    return;
  }

  try {
    let rawText = csvEl.value.trim();
    if (!rawText) throw new Error("Paste CSV or TSV into the box first.");

    const csvText = normalizeDelimitedText(rawText);
    const base = baseUrlForGithubPages();

    importStatus.textContent = "Importing…";

    const out = await api(
      `/tournaments/${encodeURIComponent(tid)}/players/import`,
      {
        method: "POST",
        body: { csvText, baseUrl: base }
      }
    );

    downloadText(`players_with_codes_${tid}.csv`, out.downloadCsv);
    importStatus.textContent = `Done. Imported ${out.count || "?"} players.`;
  } catch (e) {
    console.error(e);
    importStatus.textContent = e.message || String(e);
  }
};
