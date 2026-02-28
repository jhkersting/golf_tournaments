import {
  api,
  qs,
  rememberTournamentId,
  rememberTournamentEditCode,
  getRememberedTournamentId,
  getRememberedTournamentEditCode,
  baseUrlForGithubPages,
  setHeaderTournamentName,
  downloadText
} from "./app.js";

$("body").show();

const loadCard = document.getElementById("load_card");
const editorWrap = document.getElementById("editor_wrap");
const tidInput = document.getElementById("tid_input");
const editCodeInput = document.getElementById("edit_code_input");
const loadBtn = document.getElementById("load_tid_btn");
const loadStatus = document.getElementById("load_status");

const tidValue = document.getElementById("tid_value");
const scoreboardLink = document.getElementById("scoreboard_link");
const updatedMeta = document.getElementById("updated_meta");
const saveStatus = document.getElementById("save_status");
const importStatus = document.getElementById("import_status");

const nameEl = document.getElementById("e_name");
const datesEl = document.getElementById("e_dates");
const roundRows = document.getElementById("round_rows");
const playersHead = document.getElementById("players_head");
const playerRows = document.getElementById("player_rows");
const csvImport = document.getElementById("csv_import");
const csvFileInput = document.getElementById("csv_file");
const loadCsvFileBtn = document.getElementById("load_csv_file_btn");
const courseNameEl = document.getElementById("e_course_name");
const parRow = document.getElementById("e_par_row");
const siRow = document.getElementById("e_si_row");
const par4Btn = document.getElementById("e_par4");
const siResetBtn = document.getElementById("e_si_reset");

const addRoundBtn = document.getElementById("add_round_btn");
const addPlayerBtn = document.getElementById("add_player_btn");
const autoGroupsBtn = document.getElementById("auto_groups_btn");
const regenCodesBtn = document.getElementById("regen_codes_btn");
const downloadCodesBtn = document.getElementById("download_codes_btn");
const saveBtn = document.getElementById("save_btn");
const importBtn = document.getElementById("import_btn");

let currentTid = "";
let currentEditCode = "";
let currentData = null;

const ROUND_FORMATS = [
  { value: "scramble", label: "scramble" },
  { value: "team_best_ball", label: "team best ball" },
  { value: "two_man", label: "two man" },
  { value: "shamble", label: "shamble" },
  { value: "singles", label: "singles" }
];
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function escapeHtml(v) {
  return String(v || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function normalizeCode(v) {
  return String(v || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function normalizeGroupLabel(v) {
  const out = String(v || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return out ? out.slice(0, 16) : "";
}

function randomCode() {
  let out = "";
  for (let i = 0; i < 4; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

function groupLabelFromIndex(idx) {
  let n = Math.max(0, Math.floor(Number(idx) || 0));
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

function localDateTime(ts) {
  if (!Number.isFinite(Number(ts)) || Number(ts) <= 0) return "—";
  try {
    return new Date(Number(ts)).toLocaleString();
  } catch {
    return "—";
  }
}

function scoreboardUrlForTid(tid) {
  const base = baseUrlForGithubPages();
  return `${base}/scoreboard.html?t=${encodeURIComponent(tid)}`;
}

function tsvToCsv(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) =>
      line
        .split("\t")
        .map((cell) => {
          const escaped = String(cell).replace(/"/g, '""');
          return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped;
        })
        .join(",")
    )
    .join("\n");
}

function normalizeDelimitedText(text) {
  const v = String(text || "");
  if (v.includes("\t") && !v.includes(",")) return tsvToCsv(v);
  return v;
}

function makeCourseInputCell(hole, value, min, max) {
  const td = document.createElement("td");
  const inp = document.createElement("input");
  inp.type = "number";
  inp.step = "1";
  inp.min = String(min);
  inp.max = String(max);
  inp.value = String(value);
  inp.dataset.hole = String(hole);
  inp.style.width = "56px";
  inp.style.textAlign = "center";
  td.appendChild(inp);
  return td;
}

function rebuildCourseRows() {
  if (!parRow || !siRow) return;
  while (parRow.children.length > 1) parRow.removeChild(parRow.lastChild);
  while (siRow.children.length > 1) siRow.removeChild(siRow.lastChild);

  for (let h = 1; h <= 18; h++) {
    parRow.appendChild(makeCourseInputCell(h, 4, 3, 6));
    siRow.appendChild(makeCourseInputCell(h, h, 1, 18));
  }

  const parTotalCell = document.createElement("td");
  parTotalCell.id = "e_par_total";
  parTotalCell.textContent = "72";
  parRow.appendChild(parTotalCell);

  const siTotalCell = document.createElement("td");
  siTotalCell.className = "small";
  siTotalCell.textContent = "";
  siRow.appendChild(siTotalCell);

  parRow.addEventListener("input", updateParTotal);
  updateParTotal();
}

function updateParTotal() {
  const target = document.getElementById("e_par_total");
  if (!target) return;
  const total = getPars().reduce((acc, v) => acc + Number(v || 0), 0);
  target.textContent = String(total);
}

function getPars() {
  const pars = [];
  for (let h = 1; h <= 18; h++) {
    const v = Number(parRow?.querySelector(`input[data-hole='${h}']`)?.value);
    pars.push(Number.isFinite(v) ? v : 4);
  }
  return pars;
}

function getStrokeIndex() {
  const out = [];
  for (let h = 1; h <= 18; h++) {
    const v = Number(siRow?.querySelector(`input[data-hole='${h}']`)?.value);
    out.push(Number.isFinite(v) ? v : h);
  }
  return out;
}

function validateStrokeIndex(si) {
  const set = new Set(si);
  if (set.size !== 18) return "Stroke Index must contain 18 unique values.";
  for (const v of si) {
    if (!Number.isInteger(v) || v < 1 || v > 18) {
      return "Stroke Index values must be integers 1–18.";
    }
  }
  return null;
}

function fillCourseRows(pars, strokeIndex) {
  if (!Array.isArray(pars) || pars.length !== 18) return;
  if (!Array.isArray(strokeIndex) || strokeIndex.length !== 18) return;
  for (let h = 1; h <= 18; h++) {
    const parInput = parRow?.querySelector(`input[data-hole='${h}']`);
    const siInput = siRow?.querySelector(`input[data-hole='${h}']`);
    if (parInput) parInput.value = String(Number(pars[h - 1]) || 4);
    if (siInput) siInput.value = String(Number(strokeIndex[h - 1]) || h);
  }
  updateParTotal();
}

function normalizeCourseForUi(course) {
  const defaultPars = Array(18).fill(4);
  const defaultSi = Array.from({ length: 18 }, (_, i) => i + 1);
  const pars = Array.isArray(course?.pars) && course.pars.length === 18
    ? course.pars.map((v) => Number(v) || 4)
    : defaultPars;
  const strokeIndex = Array.isArray(course?.strokeIndex) && course.strokeIndex.length === 18
    ? course.strokeIndex.map((v) => Number(v) || 0)
    : defaultSi;
  const siErr = validateStrokeIndex(strokeIndex);
  return {
    name: String(course?.name || "").trim(),
    pars,
    strokeIndex: siErr ? defaultSi : strokeIndex
  };
}

function collectCourse() {
  const strokeIndex = getStrokeIndex();
  const siErr = validateStrokeIndex(strokeIndex);
  if (siErr) throw new Error(siErr);
  const out = {
    pars: getPars(),
    strokeIndex
  };
  const name = String(courseNameEl?.value || "").trim();
  if (name) out.name = name;
  return out;
}

function renderRounds(rounds) {
  const rows = Array.isArray(rounds) ? rounds : [];
  roundRows.innerHTML = "";
  rows.forEach((round) => {
    const currentFmtRaw = String(round?.format || "").toLowerCase();
    const currentFmt = currentFmtRaw === "two_man_best_ball" ? "two_man" : currentFmtRaw;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="left"><input data-field="name" value="${escapeHtml(round?.name || "Round")}" /></td>
      <td>
        <select data-field="format">
          ${ROUND_FORMATS.map((fmt) => `<option value="${fmt.value}" ${currentFmt === fmt.value ? "selected" : ""}>${fmt.label}</option>`).join("")}
        </select>
      </td>
      <td>
        <select data-field="handicap">
          <option value="false" ${round?.useHandicap ? "" : "selected"}>No</option>
          <option value="true" ${round?.useHandicap ? "selected" : ""}>Yes</option>
        </select>
      </td>
      <td><input data-field="weight" type="number" step="0.01" min="0.01" value="${Number(round?.weight || 1)}" /></td>
      <td><input data-field="topX" type="number" step="1" min="1" max="4" value="${Number(round?.teamAggregation?.topX || 4)}" /></td>
      <td><input data-field="remove" type="checkbox" /></td>
    `;
    roundRows.appendChild(tr);
  });

  roundRows.querySelectorAll("input,select").forEach((node) => {
    node.addEventListener("change", () => {
      const nextCount = Math.max(1, collectRoundsSafe().length || 1);
      renderPlayers(collectPlayersSafe(), nextCount);
    });
  });
}

function normalizeTeeTimesForUi(player, roundCount) {
  const count = Math.max(0, Number(roundCount) || 0);
  const out = Array(count).fill("");
  if (Array.isArray(player?.teeTimes)) {
    for (let i = 0; i < count; i++) {
      out[i] = String(player.teeTimes[i] || "").trim();
    }
  }
  if (!out.some((v) => !!v) && player?.teeTime && count > 0) {
    out[0] = String(player.teeTime || "").trim();
  }
  return out;
}

function normalizeGroupsForUi(player, roundCount) {
  const count = Math.max(0, Number(roundCount) || 0);
  const out = Array(count).fill("");
  if (Array.isArray(player?.groups)) {
    for (let i = 0; i < count; i++) {
      out[i] = normalizeGroupLabel(player.groups[i] || "");
    }
  }
  if (!out[0] && player?.group) out[0] = normalizeGroupLabel(player.group);
  return out;
}

function renderPlayers(players, roundCount = 1) {
  const rows = Array.isArray(players) ? players : [];
  const teeCount = Math.max(1, Number(roundCount) || 1);
  const groupCount = teeCount;
  playersHead.innerHTML = `
    <th class="left">Name</th>
    <th class="left">Team</th>
    <th>Handicap</th>
    ${Array.from({ length: teeCount }, (_, idx) => `<th>Tee R${idx + 1}</th>`).join("")}
    ${Array.from({ length: groupCount }, (_, idx) => `<th>Group R${idx + 1}</th>`).join("")}
    <th>Code</th>
    <th>Remove</th>
  `;
  playerRows.dataset.roundCount = String(teeCount);
  playerRows.innerHTML = "";
  rows.forEach((player) => {
    const teeTimes = normalizeTeeTimesForUi(player, teeCount);
    const groups = normalizeGroupsForUi(player, groupCount);
    const tr = document.createElement("tr");
    tr.dataset.playerId = String(player?.playerId || "");
    tr.dataset.teamId = String(player?.teamId || "");
    tr.dataset.teamName = String(player?.teamName || "");
    tr.innerHTML = `
      <td class="left"><input data-field="name" value="${escapeHtml(player?.name || "")}" /></td>
      <td class="left"><input data-field="teamName" value="${escapeHtml(player?.teamName || "")}" /></td>
      <td><input data-field="handicap" type="number" step="0.1" value="${Number(player?.handicap || 0)}" /></td>
      ${teeTimes.map((v, idx) => `<td><input data-field="teeTime-${idx}" placeholder="8:20 AM" value="${escapeHtml(v)}" /></td>`).join("")}
      ${groups.map((v, idx) => `<td><input data-field="group-${idx}" value="${escapeHtml(v)}" placeholder="A, B, C…" /></td>`).join("")}
      <td><input data-field="code" value="${escapeHtml(player?.code || "")}" /></td>
      <td><input data-field="remove" type="checkbox" /></td>
    `;
    playerRows.appendChild(tr);
  });
}

function collectRounds() {
  const rows = [...roundRows.querySelectorAll("tr")];
  const rounds = rows
    .map((tr) => {
      const remove = tr.querySelector("[data-field='remove']")?.checked;
      if (remove) return null;
      const name = String(tr.querySelector("[data-field='name']")?.value || "").trim() || "Round";
      const format = String(tr.querySelector("[data-field='format']")?.value || "singles").trim();
      const useHandicap = tr.querySelector("[data-field='handicap']")?.value === "true";
      const weight = Number(tr.querySelector("[data-field='weight']")?.value || 1);
      const topX = Number(tr.querySelector("[data-field='topX']")?.value || 4);
      return {
        name,
        format,
        useHandicap,
        weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
        teamAggregation: { mode: "avg", topX: Math.max(1, Math.min(4, Math.floor(topX || 4))) }
      };
    })
    .filter(Boolean);
  if (!rounds.length) throw new Error("At least one round is required.");
  return rounds;
}

function collectPlayers() {
  const rows = [...playerRows.querySelectorAll("tr")];
  const teeCount = Math.max(1, Number(playerRows.dataset.roundCount || 1));
  return rows
    .map((tr) => {
      const playerId = String(tr.dataset.playerId || "").trim();
      const teamId = String(tr.dataset.teamId || "").trim();
      const name = String(tr.querySelector("[data-field='name']")?.value || "").trim();
      const teamName = String(tr.querySelector("[data-field='teamName']")?.value || "").trim();
      const handicap = Number(tr.querySelector("[data-field='handicap']")?.value || 0);
      const teeTimes = Array.from({ length: teeCount }, (_, idx) =>
        String(tr.querySelector(`[data-field='teeTime-${idx}']`)?.value || "").trim() || null
      );
      const groups = Array.from({ length: teeCount }, (_, idx) =>
        normalizeGroupLabel(tr.querySelector(`[data-field='group-${idx}']`)?.value)
      );
      const code = normalizeCode(tr.querySelector("[data-field='code']")?.value);
      const remove = !!tr.querySelector("[data-field='remove']")?.checked;

      if (!remove && !name && playerId) throw new Error("Existing players must have a name.");
      if (!remove && !name) return null;
      if (!remove && !teamName) throw new Error(`Missing team for "${name || "player"}".`);
      if (!remove && code && !/^[A-Z0-9]{4,8}$/.test(code)) {
        throw new Error(`Invalid code for "${name || "player"}". Use 4-8 letters/numbers.`);
      }

      const out = {
        ...(playerId ? { playerId } : {}),
        ...(teamId ? { teamId } : {}),
        name,
        teamName,
        handicap: Number.isFinite(handicap) ? handicap : 0,
        teeTimes,
        teeTime: teeTimes.find((v) => !!v) || null,
        groups,
        group: groups[0] || null,
        code: code || "",
        remove
      };
      return out;
    })
    .filter(Boolean);
}

function autoAssignGroups() {
  const rows = [...playerRows.querySelectorAll("tr")].filter(
    (tr) => !tr.querySelector("[data-field='remove']")?.checked
  );
  const byTeam = new Map();
  rows.forEach((tr) => {
    const team = String(tr.querySelector("[data-field='teamName']")?.value || "")
      .trim()
      .toLowerCase();
    if (!team) return;
    if (!byTeam.has(team)) byTeam.set(team, []);
    byTeam.get(team).push(tr);
  });

  byTeam.forEach((teamRowsList) => {
    teamRowsList.sort((a, b) =>
      String(a.querySelector("[data-field='name']")?.value || "").localeCompare(
        String(b.querySelector("[data-field='name']")?.value || "")
      )
    );
    teamRowsList.forEach((tr, idx) => {
      const label = groupLabelFromIndex(Math.floor(idx / 2));
      const roundCount = Math.max(1, Number(playerRows.dataset.roundCount || 1));
      for (let r = 0; r < roundCount; r++) {
        const sel = tr.querySelector(`[data-field='group-${r}']`);
        if (!sel) continue;
        sel.value = label;
      }
    });
  });
}

function regenerateCodes() {
  const rows = [...playerRows.querySelectorAll("tr")].filter(
    (tr) => !tr.querySelector("[data-field='remove']")?.checked
  );
  const used = new Set();
  rows.forEach((tr) => {
    let code = randomCode();
    let guard = 0;
    while (used.has(code) && guard++ < 80) code = randomCode();
    used.add(code);
    const input = tr.querySelector("[data-field='code']");
    if (input) input.value = code;
  });
}

function addRoundRow() {
  const rounds = collectRoundsSafe();
  rounds.push({
    name: `Round ${rounds.length + 1}`,
    format: "singles",
    useHandicap: false,
    weight: 1,
    teamAggregation: { mode: "avg", topX: 4 }
  });
  renderRounds(rounds);
  renderPlayers(collectPlayersSafe(), rounds.length || 1);
}

function addPlayerRow() {
  const teamName = currentData?.teams?.[0]?.teamName || "";
  const players = collectPlayersSafe();
  const teeCount = Math.max(1, collectRoundsSafe().length || 1);
  players.push({
    playerId: "",
    teamId: "",
    name: "",
    teamName,
    handicap: 0,
    teeTimes: Array(teeCount).fill(null),
    teeTime: "",
    groups: Array(teeCount).fill(null),
    group: null,
    code: "",
    remove: false
  });
  renderPlayers(players, teeCount);
}

function collectRoundsSafe() {
  try {
    return collectRounds();
  } catch {
    return [];
  }
}

function collectPlayersSafe() {
  try {
    return collectPlayers();
  } catch {
    return Array.isArray(currentData?.players) ? currentData.players.slice() : [];
  }
}

function updateHeaderLinks(tid) {
  document.querySelectorAll("a[data-scoreboard-link]").forEach((link) => {
    link.setAttribute("href", `./scoreboard.html?t=${encodeURIComponent(tid)}`);
  });
  document.querySelectorAll("a[data-edit-link]").forEach((link) => {
    link.setAttribute("href", `./edit.html?t=${encodeURIComponent(tid)}`);
  });
}

function renderPage(data) {
  currentData = data;
  setHeaderTournamentName(data?.tournament?.name);
  nameEl.value = data?.tournament?.name || "";
  datesEl.value = data?.tournament?.dates || "";
  const course = normalizeCourseForUi(data?.course || null);
  if (courseNameEl) courseNameEl.value = course.name;
  fillCourseRows(course.pars, course.strokeIndex);
  const rounds = data?.rounds || [];
  renderRounds(rounds);
  renderPlayers(data?.players || [], rounds.length || 1);

  tidValue.textContent = currentTid;
  scoreboardLink.textContent = scoreboardUrlForTid(currentTid);
  updatedMeta.textContent = `v${data?.version || 0} • ${localDateTime(data?.updatedAt)}`;
  tidInput.value = currentTid;
  editCodeInput.value = currentEditCode;
  loadStatus.textContent = "";
  loadCard.style.display = "";
  editorWrap.style.display = "";
  updateHeaderLinks(currentTid);
}

async function loadTournament(tid, editCode) {
  const normalizedTid = String(tid || "").trim();
  const rememberedCode = getRememberedTournamentEditCode(normalizedTid);
  const normalizedCode = normalizeCode(editCode || editCodeInput?.value || rememberedCode || "");
  if (!normalizedTid) {
    loadStatus.textContent = "Tournament ID required.";
    return;
  }
  if (!normalizedCode) {
    loadStatus.textContent = "Edit code required.";
    return;
  }

  loadStatus.textContent = "Loading…";
  try {
    const payload = await api(
      `/tournaments/${encodeURIComponent(normalizedTid)}/admin?code=${encodeURIComponent(normalizedCode)}`
    );
    currentTid = normalizedTid;
    currentEditCode = normalizedCode;
    rememberTournamentId(currentTid);
    rememberTournamentEditCode(currentTid, currentEditCode);
    history.replaceState(null, "", `?t=${encodeURIComponent(currentTid)}`);
    renderPage(payload);
    loadStatus.textContent = "";
  } catch (e) {
    console.error(e);
    loadStatus.textContent = e.message || String(e);
  }
}

async function saveTournament() {
  if (!currentTid) return;
  if (!currentEditCode) {
    saveStatus.textContent = "Missing edit code.";
    return;
  }
  saveStatus.textContent = "Saving…";
  try {
    const payload = {
      editCode: currentEditCode,
      tournament: {
        name: String(nameEl.value || "").trim(),
        dates: String(datesEl.value || "").trim()
      },
      course: collectCourse(),
      rounds: collectRounds(),
      players: collectPlayers()
    };
    await api(`/tournaments/${encodeURIComponent(currentTid)}/admin`, {
      method: "POST",
      body: payload
    });
    saveStatus.textContent = "Saved.";
    await loadTournament(currentTid);
  } catch (e) {
    console.error(e);
    saveStatus.textContent = e.message || String(e);
  }
}

function downloadCodesCsv() {
  if (!currentTid) return;
  try {
    const base = baseUrlForGithubPages();
    const rows = collectPlayers().filter((p) => !p.remove);
    const teeCount = Math.max(1, collectRoundsSafe().length || 1);
    const teeHeaders = Array.from({ length: teeCount }, (_, idx) => `teeTimeR${idx + 1}`);
    const groupHeaders = Array.from({ length: teeCount }, (_, idx) => `groupR${idx + 1}`);
    const lines = [["name", "team", "handicap", ...teeHeaders, ...groupHeaders, "group", "code", "enterUrl"].join(",")];
    rows.forEach((p) => {
      const code = normalizeCode(p.code);
      const enterUrl = code ? `${base}/enter.html?code=${encodeURIComponent(code)}` : "";
      const teeTimes = Array.isArray(p.teeTimes) ? p.teeTimes : [];
      const groups = Array.isArray(p.groups) ? p.groups : [];
      lines.push(
        [
          p.name || "",
          p.teamName || "",
          Number.isFinite(Number(p.handicap)) ? Number(p.handicap) : 0,
          ...Array.from({ length: teeCount }, (_, idx) => teeTimes[idx] || ""),
          ...Array.from({ length: teeCount }, (_, idx) => groups[idx] || ""),
          groups[0] || p.group || "",
          code,
          enterUrl
        ]
          .map((v) => {
            const s = String(v ?? "");
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
          })
          .join(",")
      );
    });
    downloadText(`players_with_codes_${currentTid}.csv`, lines.join("\n"));
  } catch (e) {
    console.error(e);
    saveStatus.textContent = e.message || String(e);
  }
}

async function importPlayers() {
  if (!currentTid) return;
  if (!currentEditCode) {
    importStatus.textContent = "Missing edit code.";
    return;
  }
  let csvText = String(csvImport.value || "").trim();
  if (!csvText && csvFileInput?.files?.[0]) {
    try {
      csvText = (await csvFileInput.files[0].text()).trim();
      if (csvText) csvImport.value = csvText;
    } catch (e) {
      console.error(e);
      importStatus.textContent = "Failed to read selected file.";
      return;
    }
  }
  if (!csvText) {
    importStatus.textContent = "Paste CSV/TSV or choose a file first.";
    return;
  }

  importStatus.textContent = "Importing…";
  try {
    const out = await api(`/tournaments/${encodeURIComponent(currentTid)}/players/import`, {
      method: "POST",
      body: {
        csvText: normalizeDelimitedText(csvText),
        baseUrl: baseUrlForGithubPages(),
        editCode: currentEditCode
      }
    });
    if (out?.downloadCsv) downloadText(`players_with_codes_${currentTid}.csv`, out.downloadCsv);
    importStatus.textContent = `Imported ${out?.count || 0} players.`;
    await loadTournament(currentTid);
  } catch (e) {
    console.error(e);
    importStatus.textContent = e.message || String(e);
  }
}

function loadSelectedImportFile() {
  importStatus.textContent = "";
  const file = csvFileInput?.files?.[0];
  if (!file) {
    importStatus.textContent = "Choose a CSV/TSV file first.";
    return;
  }
  file
    .text()
    .then((text) => {
      csvImport.value = String(text || "").trim();
      importStatus.textContent = `Loaded ${file.name}.`;
    })
    .catch((e) => {
      console.error(e);
      importStatus.textContent = "Failed to read file.";
    });
}

rebuildCourseRows();
if (par4Btn) {
  par4Btn.addEventListener("click", () => {
    for (let h = 1; h <= 18; h++) {
      const input = parRow?.querySelector(`input[data-hole='${h}']`);
      if (input) input.value = "4";
    }
    updateParTotal();
  });
}
if (siResetBtn) {
  siResetBtn.addEventListener("click", () => {
    for (let h = 1; h <= 18; h++) {
      const input = siRow?.querySelector(`input[data-hole='${h}']`);
      if (input) input.value = String(h);
    }
  });
}

loadBtn.addEventListener("click", () => loadTournament(tidInput.value, editCodeInput.value));
tidInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadTournament(tidInput.value, editCodeInput.value);
});
editCodeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadTournament(tidInput.value, editCodeInput.value);
});
addRoundBtn.addEventListener("click", addRoundRow);
addPlayerBtn.addEventListener("click", addPlayerRow);
autoGroupsBtn.addEventListener("click", autoAssignGroups);
regenCodesBtn.addEventListener("click", regenerateCodes);
downloadCodesBtn.addEventListener("click", downloadCodesCsv);
saveBtn.addEventListener("click", saveTournament);
importBtn.addEventListener("click", importPlayers);
if (loadCsvFileBtn) loadCsvFileBtn.addEventListener("click", loadSelectedImportFile);

const tidFromQuery = String(qs("t") || "").trim();
const rememberedTid = getRememberedTournamentId();
if (tidFromQuery) {
  tidInput.value = tidFromQuery;
  editCodeInput.value = getRememberedTournamentEditCode(tidFromQuery);
  if (editCodeInput.value) loadTournament(tidFromQuery, editCodeInput.value);
} else if (rememberedTid) {
  tidInput.value = rememberedTid;
  editCodeInput.value = getRememberedTournamentEditCode(rememberedTid);
  if (editCodeInput.value) loadTournament(rememberedTid, editCodeInput.value);
}
