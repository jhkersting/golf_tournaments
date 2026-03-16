import { api, downloadText, baseUrlForGithubPages, rememberTournamentId, rememberTournamentEditCode, sum } from "./app.js";
$('body').show();
const roundsEl = document.getElementById("rounds");
const addRoundBtn = document.getElementById("add_round");
const createBtn = document.getElementById("create_tournament");
const createStatus = document.getElementById("create_status");
const scoringEl = document.getElementById("t_scoring");

const createdBox = document.getElementById("created_box");
const tidEl = document.getElementById("tid");
const editCodeEl = document.getElementById("edit_code");
const scoreboardLinkEl = document.getElementById("scoreboard_link");

const importBtn = document.getElementById("import_players");
const importStatus = document.getElementById("import_status");
const csvEl = document.getElementById("csv");
const starterCsvEl = document.getElementById("starter_csv");
const teeStartEl = document.getElementById("tee_start");
const teeIntervalEl = document.getElementById("tee_interval");
let latestEditCode = "";

const parRow = document.getElementById("par_row");
const siRow = document.getElementById("si_row");
const courseSelect = document.getElementById("course_select");
const courseRefreshBtn = document.getElementById("course_refresh");
const bluegolfUrlEl = document.getElementById("bluegolf_url");
const courseImportBtn = document.getElementById("course_import_bluegolf");
const courseImportStatus = document.getElementById("course_import_status");
const courseNameEl = document.getElementById("course_name");
const primaryTeeSelect = document.getElementById("primary_tee_select");
const courseSaveBtn = document.getElementById("course_save");
const courseStatus = document.getElementById("course_status");
document.getElementById("par4").onclick = () => { for (let h=1;h<=18;h++) parRow.querySelector(`input[data-hole='${h}']`).value="4"; updateParTotal(); };
document.getElementById("siReset").onclick = () => { for (let h=1;h<=18;h++) siRow.querySelector(`input[data-hole='${h}']`).value=String(h); };

let savedCourses = [];
let selectedCourseId = "";
let selectedPrimaryTeeKey = "";
const PRIMARY_COURSE_REF = "primary";
const MAX_HOLE_SCORE_OPTIONS = [
  { value: "none", label: "No max" },
  { value: "to_par:2", label: "Double bogey max (par + 2)" },
  { value: "to_par:3", label: "Triple bogey max (par + 3)" },
  { value: "to_par:4", label: "Quad bogey max (par + 4)" },
  { value: "score:6", label: "Max score 6" },
  { value: "score:7", label: "Max score 7" },
  { value: "score:8", label: "Max score 8" },
  { value: "score:9", label: "Max score 9" },
  { value: "score:10", label: "Max score 10" }
];

function roundMaxHoleScoreOptionsHtml(selectedValue = "none") {
  const selected = String(selectedValue || "none").trim() || "none";
  return MAX_HOLE_SCORE_OPTIONS
    .map((option) => `<option value="${option.value}" ${option.value === selected ? "selected" : ""}>${option.label}</option>`)
    .join("");
}

function parseRoundMaxHoleScoreValue(raw) {
  const value = String(raw || "none").trim().toLowerCase();
  if (!value || value === "none") return null;
  const match = value.match(/^(to_par|score):(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const parsedValue = Number(match[2]);
  if (!Number.isFinite(parsedValue)) return null;
  return {
    type: match[1],
    value: Math.round(parsedValue)
  };
}

function isValidCourseShape(course){
  return Array.isArray(course?.pars)
    && course.pars.length === 18
    && Array.isArray(course?.strokeIndex)
    && course.strokeIndex.length === 18;
}

function normalizeCourseForTournament(course){
  const c = normalizeCourse(course);
  if (!c || !isValidCourseShape(c)) return null;
  return {
    ...(c.name ? { name: c.name } : {}),
    ...(c.sourceCourseId ? { sourceCourseId: c.sourceCourseId } : {}),
    ...(c.dataSlug ? { dataSlug: c.dataSlug } : {}),
    ...(c.mapSlug ? { mapSlug: c.mapSlug } : {}),
    ...(c.selectedTeeKey ? { selectedTeeKey: c.selectedTeeKey } : {}),
    ...(c.teeName ? { teeName: c.teeName } : {}),
    ...(c.teeLabel ? { teeLabel: c.teeLabel } : {}),
    ...(Number.isFinite(c.totalYards) ? { totalYards: c.totalYards } : {}),
    ...(Array.isArray(c.holeYardages) && c.holeYardages.length === 18 ? { holeYardages: c.holeYardages.slice() } : {}),
    ...(Array.isArray(c.ratings) && c.ratings.length ? { ratings: c.ratings.map((entry) => serializeRatingEntry(entry)).filter(Boolean) } : {}),
    ...(Array.isArray(c.tees) && c.tees.length ? { tees: c.tees.map((tee) => serializeTeeForSave(tee)).filter(Boolean) } : {}),
    pars: c.pars.map((v) => Number(v) || 0),
    strokeIndex: c.strokeIndex.map((v) => Number(v) || 0)
  };
}

function roundCourseOptionsHtml(selectedRef = PRIMARY_COURSE_REF){
  const selected = String(selectedRef || PRIMARY_COURSE_REF);
  const options = [
    `<option value="${PRIMARY_COURSE_REF}" ${selected === PRIMARY_COURSE_REF ? "selected" : ""}>Primary course setup</option>`
  ];
  for (const c of savedCourses) {
    const id = String(c.courseId || "").trim();
    if (!id) continue;
    const ref = `saved:${id}`;
    const label = c.teeLabel ? `${c.name || id} (${c.teeLabel})` : (c.name || id);
    options.push(`<option value="${ref}" ${selected === ref ? "selected" : ""}>Saved: ${label}</option>`);
  }
  return options.join("");
}

function resolveCourseRef(ref) {
  const value = String(ref || PRIMARY_COURSE_REF).trim() || PRIMARY_COURSE_REF;
  if (value === PRIMARY_COURSE_REF) {
    try {
      return normalizeCourse(collectPrimaryCourseForTournament());
    } catch {
      return normalizeCourse({
        name: String(courseNameEl?.value || "").trim(),
        pars: getPars(),
        strokeIndex: Array.from({ length: 18 }, (_, idx) => idx + 1)
      });
    }
  }
  const id = value.startsWith("saved:") ? value.slice("saved:".length).trim() : "";
  if (!id) return normalizeCourse(collectPrimaryCourseForTournament());
  return savedCourses.find((course) => String(course?.courseId || "").trim() === id) || null;
}

function syncRoundTeeSelect(card) {
  const courseSelectEl = card?.querySelector("[data-course-ref]");
  const teeSelectEl = card?.querySelector("[data-tee-ref]");
  if (!courseSelectEl || !teeSelectEl) return;

  const course = normalizeCourse(resolveCourseRef(courseSelectEl.value));
  const tees = Array.isArray(course?.tees) ? course.tees : [];
  const previous = String(teeSelectEl.value || card?.dataset?.teeRef || "").trim();

  if (!tees.length) {
    teeSelectEl.innerHTML = `<option value="">—</option>`;
    teeSelectEl.value = "";
    teeSelectEl.disabled = true;
    card.dataset.teeRef = "";
    return;
  }

  teeSelectEl.disabled = false;
  teeSelectEl.innerHTML = tees
    .map((tee) => `<option value="${tee.key}">${tee.label || tee.teeName || tee.key}</option>`)
    .join("");

  let next = previous;
  if (!tees.some((tee) => tee.key === next)) next = String(course?.selectedTeeKey || "").trim();
  if (!tees.some((tee) => tee.key === next)) next = tees[0].key;
  teeSelectEl.value = next;
  card.dataset.teeRef = next;
}

function selectedSavedCourse() {
  return normalizeCourse(
    savedCourses.find((course) => String(course?.courseId || "").trim() === selectedCourseId) || null
  );
}

function syncPrimaryTeeSelect({ preserve = true } = {}) {
  if (!primaryTeeSelect) return;
  const baseCourse = selectedSavedCourse();
  const tees = Array.isArray(baseCourse?.tees) ? baseCourse.tees : [];
  const previous = preserve ? String(primaryTeeSelect.value || selectedPrimaryTeeKey || "").trim() : "";

  if (!tees.length) {
    primaryTeeSelect.innerHTML = `<option value="">No tee data</option>`;
    primaryTeeSelect.value = "";
    primaryTeeSelect.disabled = true;
    selectedPrimaryTeeKey = "";
    return;
  }

  primaryTeeSelect.disabled = false;
  primaryTeeSelect.innerHTML = tees
    .map((tee) => `<option value="${tee.key}">${tee.label || tee.teeName || tee.key}</option>`)
    .join("");

  let next = previous;
  if (!tees.some((tee) => tee.key === next)) next = String(baseCourse?.selectedTeeKey || "").trim();
  if (!tees.some((tee) => tee.key === next)) next = tees[0].key;
  primaryTeeSelect.value = next;
  selectedPrimaryTeeKey = next;
}

function refreshRoundCourseSelects(){
  const selects = roundsEl.querySelectorAll("select[data-course-ref]");
  selects.forEach((select) => {
    const prev = String(select.value || PRIMARY_COURSE_REF);
    select.innerHTML = roundCourseOptionsHtml(prev);
    const exists = [...select.options].some((opt) => opt.value === prev);
    select.value = exists ? prev : PRIMARY_COURSE_REF;
  });
  roundsEl.querySelectorAll(".card").forEach((card) => syncRoundTeeSelect(card));
}

async function ensureSavedCourseDetails(courseId){
  const id = String(courseId || "").trim();
  if (!id) return null;
  const fromList = savedCourses.find((c) => String(c?.courseId || "").trim() === id);
  const normalizedFromList = normalizeCourse(fromList);
  if (isValidCourseShape(normalizedFromList) && Array.isArray(normalizedFromList?.tees) && normalizedFromList.tees.length) {
    return normalizeCourseForTournament(normalizedFromList);
  }

  const payload = await api(`/courses/${encodeURIComponent(id)}`);
  const loaded = normalizeCourse(payload?.course || payload);
  if (!isValidCourseShape(loaded)) {
    throw new Error(`Saved course ${id} is missing pars/strokeIndex.`);
  }
  const idx = savedCourses.findIndex((c) => String(c?.courseId || "").trim() === id);
  if (idx >= 0) savedCourses[idx] = loaded;
  else savedCourses.push(loaded);
  return normalizeCourseForTournament(loaded);
}

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

function normalizeRatingEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const gender = String(raw.gender || "").trim().toUpperCase();
  const rating = Number(raw.rating);
  const slope = Number(raw.slope);
  if (!gender && !Number.isFinite(rating) && !Number.isFinite(slope)) return null;
  return {
    ...(gender ? { gender } : {}),
    ...(Number.isFinite(rating) ? { rating } : {}),
    ...(Number.isFinite(slope) ? { slope: Math.round(slope) } : {})
  };
}

function ratingSummary(ratings) {
  if (!Array.isArray(ratings) || !ratings.length) return "";
  return ratings
    .map((entry) => {
      const parts = [];
      if (entry?.gender) parts.push(String(entry.gender));
      if (Number.isFinite(entry?.rating)) {
        const slopeText = Number.isFinite(entry?.slope) ? `/${Math.round(entry.slope)}` : "";
        parts.push(`${Number(entry.rating).toFixed(1)}${slopeText}`);
      } else if (Number.isFinite(entry?.slope)) {
        parts.push(String(Math.round(entry.slope)));
      }
      return parts.join(" ");
    })
    .filter(Boolean)
    .join(" • ");
}

function teeKeyForMeta(teeName, totalYards, holeYardages) {
  const nameKey = String(teeName || "tee")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "tee";
  const yardsKey = Number.isFinite(Number(totalYards)) ? String(Math.round(Number(totalYards))) : "0";
  return `${nameKey}-${yardsKey}`;
}

function normalizeTeeForUi(raw) {
  if (!raw || typeof raw !== "object") return null;
  const teeName = String(raw.teeName || raw.name || "").trim();
  const totalYardsRaw = Number(raw.totalYards);
  const totalYards = Number.isFinite(totalYardsRaw) ? Math.round(totalYardsRaw) : null;
  const parTotalRaw = Number(raw.parTotal);
  const parTotal = Number.isFinite(parTotalRaw) ? Math.round(parTotalRaw) : null;
  const holeYardages = Array.isArray(raw.holeYardages) && raw.holeYardages.length === 18
    ? raw.holeYardages.map((value) => Number(value) || 0)
    : [];
  const ratings = Array.isArray(raw.ratings) && raw.ratings.length
    ? raw.ratings.map((entry) => normalizeRatingEntry(entry)).filter(Boolean)
    : [normalizeRatingEntry(raw)].filter(Boolean);
  if (!teeName && !Number.isFinite(totalYards) && !holeYardages.length && !ratings.length) return null;
  const key = String(raw.teeKey || raw.selectedTeeKey || "").trim()
    || teeKeyForMeta(teeName, totalYards, holeYardages);
  const ratingsText = ratingSummary(ratings);
  return {
    key,
    teeName: teeName || "Tee",
    ...(Number.isFinite(totalYards) ? { totalYards } : {}),
    ...(Number.isFinite(parTotal) ? { parTotal } : {}),
    ...(holeYardages.length === 18 ? { holeYardages } : {}),
    ratings,
    ratingsText,
    label: [
      teeName || "Tee",
      Number.isFinite(totalYards) ? `${totalYards} yds` : "",
      ratingsText
    ].filter(Boolean).join(" • ")
  };
}

function teeListFromCourse(course) {
  const grouped = new Map();
  const rawList = Array.isArray(course?.longestTees) && course.longestTees.length
    ? course.longestTees
    : Array.isArray(course?.tees) ? course.tees : [];

  rawList.forEach((entry) => {
    const tee = normalizeTeeForUi(entry);
    if (!tee) return;
    const existing = grouped.get(tee.key);
    if (!existing) {
      grouped.set(tee.key, tee);
      return;
    }
    const mergedRatings = [...(existing.ratings || [])];
    for (const rating of tee.ratings || []) {
      const alreadyPresent = mergedRatings.some((candidate) =>
        candidate?.gender === rating?.gender
          && candidate?.rating === rating?.rating
          && candidate?.slope === rating?.slope
      );
      if (!alreadyPresent) mergedRatings.push(rating);
    }
    grouped.set(tee.key, {
      ...existing,
      ratings: mergedRatings,
      ratingsText: ratingSummary(mergedRatings),
      label: [
        existing.teeName,
        Number.isFinite(existing.totalYards) ? `${existing.totalYards} yds` : "",
        ratingSummary(mergedRatings)
      ].filter(Boolean).join(" • ")
    });
  });

  if (!grouped.size) {
    const single = normalizeTeeForUi({
      teeKey: course?.selectedTeeKey,
      teeName: course?.teeName,
      totalYards: course?.totalYards,
      parTotal: course?.parTotal,
      holeYardages: course?.holeYardages,
      ratings: course?.ratings
    });
    if (single) grouped.set(single.key, single);
  }

  return [...grouped.values()].sort((a, b) => {
    const yardsDiff = (Number(b?.totalYards) || 0) - (Number(a?.totalYards) || 0);
    if (yardsDiff !== 0) return yardsDiff;
    return String(a?.teeName || "").localeCompare(String(b?.teeName || ""));
  });
}

function serializeRatingEntry(entry) {
  return normalizeRatingEntry(entry);
}

function serializeTeeForSave(tee) {
  const normalized = normalizeTeeForUi(tee);
  if (!normalized) return null;
  return {
    teeKey: normalized.key,
    teeName: normalized.teeName,
    ...(Number.isFinite(normalized.parTotal) ? { parTotal: normalized.parTotal } : {}),
    ...(Number.isFinite(normalized.totalYards) ? { totalYards: normalized.totalYards } : {}),
    ...(Array.isArray(normalized.holeYardages) && normalized.holeYardages.length === 18
      ? { holeYardages: normalized.holeYardages.slice() }
      : {}),
    ...(Array.isArray(normalized.ratings) && normalized.ratings.length
      ? { ratings: normalized.ratings.map((entry) => serializeRatingEntry(entry)).filter(Boolean) }
      : {})
  };
}

function normalizeCourse(course){
  if (!course || typeof course !== "object") return null;
  const courseId = String(course.courseId || course.id || "").trim();
  const sourceCourseId = String(course.sourceCourseId || "").trim();
  const dataSlug = String(course.dataSlug || "").trim();
  const mapSlug = String(course.mapSlug || "").trim();
  const name = String(course.name || "").trim();
  const pars = Array.isArray(course.pars) ? course.pars.map((v) => Number(v) || 0) : null;
  const strokeIndex = Array.isArray(course.strokeIndex)
    ? course.strokeIndex.map((v) => Number(v) || 0)
    : null;
  const tees = teeListFromCourse(course);
  let selectedTeeKey = String(course.selectedTeeKey || course.teeKey || "").trim();
  if (!selectedTeeKey && tees.length === 1) selectedTeeKey = tees[0].key;
  const selectedTee = tees.find((tee) => tee.key === selectedTeeKey) || null;
  return {
    courseId,
    ...(sourceCourseId ? { sourceCourseId } : {}),
    ...(dataSlug ? { dataSlug } : {}),
    ...(mapSlug ? { mapSlug } : {}),
    name,
    pars,
    strokeIndex,
    tees,
    ...(selectedTeeKey ? { selectedTeeKey } : {}),
    ...(selectedTee?.teeName ? { teeName: selectedTee.teeName } : String(course.teeName || "").trim() ? { teeName: String(course.teeName || "").trim() } : {}),
    ...(selectedTee?.label ? { teeLabel: selectedTee.label } : String(course.teeLabel || "").trim() ? { teeLabel: String(course.teeLabel || "").trim() } : {}),
    ...(Number.isFinite(selectedTee?.totalYards) ? { totalYards: selectedTee.totalYards } : Number.isFinite(Number(course.totalYards)) ? { totalYards: Math.round(Number(course.totalYards)) } : {}),
    ...(Array.isArray(selectedTee?.holeYardages) && selectedTee.holeYardages.length === 18
      ? { holeYardages: selectedTee.holeYardages.slice() }
      : Array.isArray(course.holeYardages) && course.holeYardages.length === 18
        ? { holeYardages: course.holeYardages.map((value) => Number(value) || 0) }
        : {}),
    ...(Array.isArray(selectedTee?.ratings) && selectedTee.ratings.length
      ? { ratings: selectedTee.ratings.map((entry) => serializeRatingEntry(entry)).filter(Boolean) }
      : Array.isArray(course.ratings) && course.ratings.length
        ? { ratings: course.ratings.map((entry) => serializeRatingEntry(entry)).filter(Boolean) }
        : {})
  };
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
    syncPrimaryTeeSelect();
    refreshRoundCourseSelects();
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
    const existingIdx = savedCourses.findIndex((course) => String(course?.courseId || "").trim() === id);
    if (existingIdx >= 0) savedCourses[existingIdx] = c;
    else savedCourses.push(c);
    fillCourseRows(c.pars, c.strokeIndex);
    courseNameEl.value = c.name || "";
    selectedCourseId = id;
    if (!String(selectedPrimaryTeeKey || "").trim() || !Array.isArray(c.tees) || !c.tees.some((tee) => tee.key === selectedPrimaryTeeKey)) {
      selectedPrimaryTeeKey = String(c.selectedTeeKey || c.tees?.[0]?.key || "").trim();
    }
    syncPrimaryTeeSelect();
    refreshRoundCourseSelects();
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

  const existing = selectedCourseId
    ? savedCourses.find((course) => String(course?.courseId || "").trim() === selectedCourseId)
    : null;
  const effectiveSelectedTeeKey = String(selectedPrimaryTeeKey || existing?.selectedTeeKey || "").trim();
  const selectedCourseView = normalizeCourse({
    ...(existing || {}),
    ...(effectiveSelectedTeeKey ? { selectedTeeKey: effectiveSelectedTeeKey } : {})
  });
  const course = {
    name,
    pars,
    strokeIndex: si,
    ...(effectiveSelectedTeeKey ? { selectedTeeKey: effectiveSelectedTeeKey } : {}),
    ...(existing?.sourceCourseId ? { sourceCourseId: existing.sourceCourseId } : {}),
    ...(selectedCourseView?.teeName ? { teeName: selectedCourseView.teeName } : {}),
    ...(selectedCourseView?.teeLabel ? { teeLabel: selectedCourseView.teeLabel } : {}),
    ...(Number.isFinite(selectedCourseView?.totalYards) ? { totalYards: selectedCourseView.totalYards } : {}),
    ...(Array.isArray(selectedCourseView?.holeYardages) && selectedCourseView.holeYardages.length === 18
      ? { holeYardages: selectedCourseView.holeYardages.slice() }
      : {}),
    ...(Array.isArray(selectedCourseView?.ratings) && selectedCourseView.ratings.length
      ? { ratings: selectedCourseView.ratings.map((entry) => serializeRatingEntry(entry)).filter(Boolean) }
      : {}),
    ...(Array.isArray(existing?.tees) && existing.tees.length
      ? { tees: existing.tees.map((tee) => serializeTeeForSave(tee)).filter(Boolean) }
      : {})
  };
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

async function importBlueGolfCourse(){
  if (!courseImportStatus) return;
  const bluegolfUrl = String(bluegolfUrlEl?.value || "").trim();
  if (!bluegolfUrl) {
    courseImportStatus.textContent = "Paste a BlueGolf link first.";
    return;
  }

  courseImportStatus.textContent = "Importing BlueGolf course…";
  try {
    const payload = await api("/courses", {
      method: "POST",
      body: { bluegolfUrl }
    });
    const importedCourse = normalizeCourse(payload?.course || payload);
    const importedId = String(importedCourse?.courseId || "").trim();
    await loadCourses();
    if (importedId && courseSelect) {
      selectedCourseId = importedId;
      courseSelect.value = importedId;
      await loadCourseById(importedId);
    }
    courseImportStatus.textContent = importedCourse?.name
      ? `Imported ${importedCourse.name}.`
      : "BlueGolf course imported.";
  } catch (e) {
    console.error(e);
    courseImportStatus.textContent = e.message || String(e);
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
          <option value="team_best_ball">team best ball</option>
          <option value="two_man_scramble">two man scramble</option>
          <option value="two_man_shamble">two man shamble</option>
          <option value="two_man_best_ball">two man best ball</option>
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
      <div class="col">
        <label>Course for round</label>
        <select data-course-ref>
          ${roundCourseOptionsHtml(PRIMARY_COURSE_REF)}
        </select>
      </div>
      <div class="col">
        <label>Tee</label>
        <select data-tee-ref></select>
      </div>
      <div class="col">
        <label>Hole max</label>
        <select data-max-hole-score>
          ${roundMaxHoleScoreOptionsHtml("none")}
        </select>
      </div>
    </div>

    <div class="row" style="margin-top:8px;" data-aggrow>
      <div class="col">
        <label>Top X scores taken</label>
        <input data-topx type="number" min="1" max="4" step="1" value="4" />
        <div class="small">Round team score uses the sum of best X players (Team Best Ball applies this per hole; all-round weighted team totals use average).</div>
      </div>
    </div>
  `;

  const fmt = div.querySelector("[data-format]");
  const aggRow = div.querySelector("[data-aggrow]");
  function syncAggVisibility(){
    // Scramble and two-man formats use fixed team scoring; aggregation inputs are not used.
    const format = String(fmt.value || "").toLowerCase();
    const hideAggregation =
      format === "scramble" ||
      format === "two_man_scramble" ||
      format === "two_man_shamble" ||
      format === "two_man_best_ball";
    aggRow.style.display = hideAggregation ? "none" : "";
  }
  fmt.addEventListener("change", syncAggVisibility);
  syncAggVisibility();

  const courseSelectEl = div.querySelector("[data-course-ref]");
  if (courseSelectEl) {
    courseSelectEl.addEventListener("change", () => syncRoundTeeSelect(div));
  }
  const teeSelectEl = div.querySelector("[data-tee-ref]");
  if (teeSelectEl) {
    teeSelectEl.addEventListener("change", () => {
      div.dataset.teeRef = String(teeSelectEl.value || "").trim();
    });
  }
  syncRoundTeeSelect(div);
  div.querySelector("[data-remove]").onclick = () => div.remove();
  return div;
}

function addRound(){ roundsEl.appendChild(roundCard()); }
addRoundBtn.onclick = addRound;

// Defaults: 2 rounds
addRound(); addRound();
rebuildCourseRows();
if (courseRefreshBtn) courseRefreshBtn.onclick = () => loadCourses();
if (courseImportBtn) courseImportBtn.onclick = () => importBlueGolfCourse();
if (courseSaveBtn) courseSaveBtn.onclick = () => saveCourse();
if (primaryTeeSelect) {
  primaryTeeSelect.onchange = () => {
    const previous = String(selectedPrimaryTeeKey || "").trim();
    selectedPrimaryTeeKey = String(primaryTeeSelect.value || "").trim();
    roundsEl.querySelectorAll(".card").forEach((card) => {
      const courseRef = String(card.querySelector("[data-course-ref]")?.value || PRIMARY_COURSE_REF).trim();
      if (courseRef !== PRIMARY_COURSE_REF) return;
      const currentTee = String(card.querySelector("[data-tee-ref]")?.value || "").trim();
      if (!currentTee || currentTee === previous) {
        card.dataset.teeRef = selectedPrimaryTeeKey;
      }
      syncRoundTeeSelect(card);
    });
  };
}
if (courseSelect) {
  courseSelect.onchange = async () => {
    const id = String(courseSelect.value || "").trim();
    if (!id) {
      selectedCourseId = "";
      selectedPrimaryTeeKey = "";
      syncPrimaryTeeSelect({ preserve: false });
      refreshRoundCourseSelects();
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
  const rounds = cards.map(c => {
    const format = c.querySelector("[data-format]")?.value;
    const useHandicap = c.querySelector("[data-handicap]")?.value === "true";
    const rawWeight = String(c.querySelector("[data-weight]")?.value || "").trim();
    const parsedWeight = rawWeight === "" ? null : Number(rawWeight);
    const weight = Number.isFinite(parsedWeight) && parsedWeight > 0 ? parsedWeight : null;
    const topX = Number(c.querySelector("[data-topx]")?.value || 4);
    const courseRef = String(c.querySelector("[data-course-ref]")?.value || PRIMARY_COURSE_REF).trim();
    const teeRef = String(c.querySelector("[data-tee-ref]")?.value || "").trim();
    const maxHoleScore = parseRoundMaxHoleScoreValue(c.querySelector("[data-max-hole-score]")?.value);

    return {
      name: c.querySelector("[data-name]")?.value.trim() || "Round",
      format,
      useHandicap,
      weight,
      courseRef: courseRef || PRIMARY_COURSE_REF,
      teeRef,
      maxHoleScore,
      teamAggregation: {
        mode: "avg",
        topX: Math.max(1, Math.min(4, Math.floor(topX || 4)))
      }
    };
  });

  const anyExplicitWeight = rounds.some((r) => Number.isFinite(r.weight) && r.weight > 0);
  return rounds.map((r) => ({
    ...r,
    weight: anyExplicitWeight ? (Number.isFinite(r.weight) && r.weight > 0 ? r.weight : 1) : 1
  }));
}

function collectPrimaryCourseForTournament(){
  const base = normalizeCourse({
    ...(savedCourses.find((course) => String(course?.courseId || "").trim() === selectedCourseId) || {}),
    ...(selectedPrimaryTeeKey ? { selectedTeeKey: selectedPrimaryTeeKey } : {})
  });
  const courseName = document.getElementById("course_name").value.trim();
  const pars = getPars();
  const strokeIndex = getStrokeIndex();
  const siErr = validateStrokeIndex(strokeIndex);
  if (siErr) throw new Error(siErr);
  return {
    ...((base?.sourceCourseId || base?.courseId) ? { sourceCourseId: base?.sourceCourseId || base?.courseId } : {}),
    ...(base?.dataSlug ? { dataSlug: base.dataSlug } : {}),
    ...(base?.mapSlug ? { mapSlug: base.mapSlug } : {}),
    ...(base?.selectedTeeKey ? { selectedTeeKey: base.selectedTeeKey } : {}),
    ...(base?.teeName ? { teeName: base.teeName } : {}),
    ...(base?.teeLabel ? { teeLabel: base.teeLabel } : {}),
    ...(Number.isFinite(base?.totalYards) ? { totalYards: base.totalYards } : {}),
    ...(Array.isArray(base?.holeYardages) && base.holeYardages.length === 18 ? { holeYardages: base.holeYardages.slice() } : {}),
    ...(Array.isArray(base?.ratings) && base.ratings.length ? { ratings: base.ratings.map((entry) => serializeRatingEntry(entry)).filter(Boolean) } : {}),
    ...(Array.isArray(base?.tees) && base.tees.length ? { tees: base.tees.map((tee) => serializeTeeForSave(tee)).filter(Boolean) } : {}),
    ...(courseName ? { name: courseName } : {}),
    pars,
    strokeIndex
  };
}

async function resolveCoursesAndRounds(rounds, primaryCourse){
  function serializeCourseForSave(course) {
    const normalized = normalizeCourse(course);
    return {
      ...(normalized?.name ? { name: normalized.name } : {}),
      ...(normalized?.sourceCourseId ? { sourceCourseId: normalized.sourceCourseId } : {}),
      ...(normalized?.dataSlug ? { dataSlug: normalized.dataSlug } : {}),
      ...(normalized?.mapSlug ? { mapSlug: normalized.mapSlug } : {}),
      ...(normalized?.selectedTeeKey ? { selectedTeeKey: normalized.selectedTeeKey } : {}),
      ...(normalized?.teeName ? { teeName: normalized.teeName } : {}),
      ...(normalized?.teeLabel ? { teeLabel: normalized.teeLabel } : {}),
      ...(Number.isFinite(normalized?.totalYards) ? { totalYards: normalized.totalYards } : {}),
      ...(Array.isArray(normalized?.holeYardages) && normalized.holeYardages.length === 18
        ? { holeYardages: normalized.holeYardages.slice() }
        : {}),
      ...(Array.isArray(normalized?.ratings) && normalized.ratings.length
        ? { ratings: normalized.ratings.map((entry) => serializeRatingEntry(entry)).filter(Boolean) }
        : {}),
      ...(Array.isArray(normalized?.tees) && normalized.tees.length
        ? { tees: normalized.tees.map((tee) => serializeTeeForSave(tee)).filter(Boolean) }
        : {}),
      pars: Array.isArray(normalized?.pars) ? normalized.pars.slice() : Array(18).fill(4),
      strokeIndex: Array.isArray(normalized?.strokeIndex)
        ? normalized.strokeIndex.slice()
        : Array.from({ length: 18 }, (_, i) => i + 1)
    };
  }

  function materializeCourseForRound(course, teeRef = "") {
    const normalized = normalizeCourse(course);
    const selectedTee = normalized?.tees?.find((tee) => tee.key === teeRef)
      || normalized?.tees?.find((tee) => tee.key === normalized?.selectedTeeKey)
      || null;
    const out = serializeCourseForSave({
      ...normalized,
      selectedTeeKey: selectedTee?.key || normalized?.selectedTeeKey || ""
    });
    delete out.tees;
    if (!selectedTee) return out;
    return {
      ...out,
      selectedTeeKey: selectedTee.key,
      teeName: selectedTee.teeName,
      teeLabel: selectedTee.label,
      ...(Number.isFinite(selectedTee.totalYards) ? { totalYards: selectedTee.totalYards } : {}),
      ...(Number.isFinite(selectedTee.parTotal) ? { parTotal: selectedTee.parTotal } : {}),
      ...(Array.isArray(selectedTee.holeYardages) && selectedTee.holeYardages.length === 18
        ? { holeYardages: selectedTee.holeYardages.slice() }
        : {}),
      ...(Array.isArray(selectedTee.ratings) && selectedTee.ratings.length
        ? { ratings: selectedTee.ratings.map((entry) => serializeRatingEntry(entry)).filter(Boolean) }
        : {})
    };
  }

  const courses = [serializeCourseForSave(primaryCourse)];
  const refToIndex = new Map([[PRIMARY_COURSE_REF, 0]]);
  const roundOut = [];

  for (const round of rounds) {
    const ref = String(round?.courseRef || PRIMARY_COURSE_REF).trim() || PRIMARY_COURSE_REF;
    const teeRef = String(round?.teeRef || "").trim();
    let courseIndex = 0;
    if (ref !== PRIMARY_COURSE_REF) {
      const id = ref.startsWith("saved:") ? ref.slice("saved:".length).trim() : "";
      if (!id) throw new Error(`Unknown course selection "${ref}".`);
      const detail = await ensureSavedCourseDetails(id);
      if (!detail) throw new Error(`Saved course "${id}" was not found.`);
      const effectiveTeeRef = teeRef || detail.selectedTeeKey || detail.tees?.[0]?.key || "";
      const key = `saved:${id}|${effectiveTeeRef}`;
      if (!refToIndex.has(key)) {
        refToIndex.set(key, courses.length);
        courses.push(materializeCourseForRound(
          {
            ...detail,
            sourceCourseId: detail.courseId || detail.sourceCourseId || id
          },
          effectiveTeeRef
        ));
      }
      courseIndex = refToIndex.get(key);
    }
    roundOut.push({
      ...round,
      courseIndex
    });
  }

  return {
    courses,
    rounds: roundOut
  };
}

function importOptions(){
  const teeStart = String(teeStartEl?.value || "").trim();
  const teeIntervalRaw = Number(teeIntervalEl?.value || 10);
  const teeIntervalMin = Number.isFinite(teeIntervalRaw)
    ? Math.max(1, Math.min(60, Math.floor(teeIntervalRaw)))
    : 10;
  return { teeStart, teeIntervalMin };
}

async function importPlayersCsv(tid, rawText, editCode){
  const csvText = normalizeDelimitedText(String(rawText || "").trim());
  if (!csvText) throw new Error("CSV text is empty.");
  const baseUrl = baseUrlForGithubPages();
  const opts = importOptions();
  return api(`/tournaments/${encodeURIComponent(tid)}/players/import`, {
    method: "POST",
    body: {
      csvText,
      baseUrl,
      editCode,
      teeStart: opts.teeStart,
      teeIntervalMin: opts.teeIntervalMin
    }
  });
}

createBtn.onclick = async () => {
  createStatus.textContent = "";
  try{
    const name = document.getElementById("t_name").value.trim();
    const dates = document.getElementById("t_dates").value.trim();
    const scoring = String(scoringEl?.value || "stroke").trim() || "stroke";
    const roundDraft = getRounds();
    if (!name) throw new Error("Tournament name is required.");
    if (!roundDraft.length) throw new Error("Add at least one round.");
    const primaryCourse = collectPrimaryCourseForTournament();
    const { courses, rounds } = await resolveCoursesAndRounds(roundDraft, primaryCourse);

    createStatus.textContent = "Creating…";
    const out = await api("/tournaments", {
      method:"POST",
      body:{
        name,
        dates,
        scoring,
        tournament: { scoring },
        rounds,
        courses,
        course: courses[0]
      }
    });
    const tid = out.tournamentId;
    const editCode = String(out.editCode || "").trim();
    rememberTournamentId(tid);
    if (editCode) rememberTournamentEditCode(tid, editCode);
    latestEditCode = editCode;
    tidEl.textContent = tid;
    if (editCodeEl) editCodeEl.textContent = editCode || "—";

    const base = baseUrlForGithubPages();
    scoreboardLinkEl.textContent = `${base}/scoreboard.html?t=${encodeURIComponent(tid)}`;
    createdBox.style.display = "block";
    const starterRaw = String(starterCsvEl?.value || "").trim();

    if (starterRaw) {
      createStatus.textContent = "Created. Generating tee times/codes…";
      importStatus.textContent = "Importing starter players…";
      try {
        const outImport = await importPlayersCsv(tid, starterRaw, editCode);
        if (outImport?.downloadCsv) {
          downloadText(`players_with_codes_${tid}.csv`, outImport.downloadCsv);
          csvEl.value = outImport.downloadCsv;
        }
        importStatus.textContent = `Starter import complete (${outImport?.count || 0} players).`;
        createStatus.textContent = "Created and starter CSV generated. Opening editor…";
      } catch (e) {
        console.error(e);
        csvEl.value = starterRaw;
        importStatus.textContent = e.message || String(e);
        createStatus.textContent =
          "Tournament created, but starter import failed. Opening editor so you can upload CSV there.";
      }
    } else {
      createStatus.textContent = editCode
        ? "Created. Add starter players or continue in editor."
        : "Created (no edit code returned).";
    }

    setTimeout(() => {
      location.href = `./edit.html?t=${encodeURIComponent(tid)}`;
    }, 450);
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

    importStatus.textContent = "Importing…";
    const out = await importPlayersCsv(tid, rawText, latestEditCode);

    downloadText(`players_with_codes_${tid}.csv`, out.downloadCsv);
    importStatus.textContent = `Done. Imported ${out.count || "?"} players.`;
  } catch (e) {
    console.error(e);
    importStatus.textContent = e.message || String(e);
  }
};
