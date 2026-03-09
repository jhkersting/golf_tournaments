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
const scoresStatus = document.getElementById("scores_status");

const nameEl = document.getElementById("e_name");
const datesEl = document.getElementById("e_dates");
const roundRows = document.getElementById("round_rows");
const playersHead = document.getElementById("players_head");
const playerRows = document.getElementById("player_rows");
const csvImport = document.getElementById("csv_import");
const csvFileInput = document.getElementById("csv_file");
const loadCsvFileBtn = document.getElementById("load_csv_file_btn");
const scoresCsvFileInput = document.getElementById("scores_csv_file");
const loadScoresCsvFileBtn = document.getElementById("load_scores_csv_file_btn");
const uploadScoresCsvBtn = document.getElementById("upload_scores_csv_btn");
const downloadScoresCsvBtn = document.getElementById("download_scores_csv_btn");
const scoresEditorWrap = document.getElementById("scores_editor_wrap");
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
let loadedScoresCsvText = "";
let scoreInputIndex = new Map();
let scoreRowMetaByKey = new Map();
let tournamentCourses = [];
let savedCourses = [];

const ROUND_FORMATS = [
  { value: "scramble", label: "scramble" },
  { value: "team_best_ball", label: "team best ball" },
  { value: "two_man_scramble", label: "two man scramble" },
  { value: "two_man_shamble", label: "two man shamble" },
  { value: "two_man_best_ball", label: "two man best ball" },
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

function scoreRoundFormat(round) {
  const raw = String(round?.format || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (raw === "two_man") return "two_man_scramble";
  if (raw === "team_bestball") return "team_best_ball";
  if (
    raw === "scramble" ||
    raw === "team_best_ball" ||
    raw === "two_man_scramble" ||
    raw === "two_man_shamble" ||
    raw === "two_man_best_ball" ||
    raw === "shamble" ||
    raw === "singles"
  ) {
    return raw;
  }
  return "singles";
}

function scoreTargetTypeForRound(round) {
  const fmt = scoreRoundFormat(round);
  if (fmt === "scramble") return "team";
  if (fmt === "two_man_scramble") return "group";
  return "player";
}

function scoreBucketKey(targetType) {
  if (targetType === "team") return "teams";
  if (targetType === "group") return "groups";
  return "players";
}

function scoreKey(roundIndex, targetType, targetId) {
  return `${roundIndex}|${targetType}|${targetId}`;
}

function normalizeScoreTargetType(value) {
  const v = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (v === "team" || v === "teams") return "team";
  if (v === "group" || v === "groups") return "group";
  if (v === "player" || v === "players") return "player";
  return "";
}

function safeHoleArray(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  const out = Array(18).fill(null);
  for (let i = 0; i < 18; i++) {
    const v = arr[i];
    if (v == null || (typeof v === "string" && v.trim() === "")) {
      out[i] = null;
      continue;
    }
    const n = Number(v);
    if (!Number.isFinite(n)) {
      out[i] = null;
      continue;
    }
    const iv = Math.round(n);
    out[i] = iv >= 1 && iv <= 20 ? iv : null;
  }
  return out;
}

function normalizeScoresForUi(scores, roundCount) {
  const sourceRounds = Array.isArray(scores?.rounds) ? scores.rounds : [];
  return {
    rounds: Array.from({ length: roundCount }, (_, r) => {
      const src = sourceRounds[r] || {};
      const outRound = { teams: {}, players: {}, groups: {} };
      for (const [teamId, entry] of Object.entries(src?.teams || {})) {
        outRound.teams[teamId] = { holes: safeHoleArray(entry?.holes || entry) };
      }
      for (const [playerId, entry] of Object.entries(src?.players || {})) {
        outRound.players[playerId] = { holes: safeHoleArray(entry?.holes || entry) };
      }
      for (const [groupId, entry] of Object.entries(src?.groups || {})) {
        outRound.groups[groupId] = { holes: safeHoleArray(entry?.holes || entry) };
      }
      return outRound;
    })
  };
}

function scoreCellToNumber(raw, label) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 20) {
    throw new Error(`${label} must be an integer 1-20.`);
  }
  return n;
}

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseCsv(text) {
  const input = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  rows.push(row);

  if (inQuotes) throw new Error("Invalid CSV format (unclosed quote).");
  return rows.filter((r) => r.some((c) => String(c || "").trim() !== ""));
}

function parseTwoManGroupId(groupId) {
  const raw = String(groupId || "").trim();
  const idx = raw.indexOf("::");
  if (idx < 0) return { teamId: "", group: "" };
  return { teamId: raw.slice(0, idx), group: raw.slice(idx + 2) };
}

function twoManGroupId(teamId, groupLabel) {
  const team = String(teamId || "").trim();
  const label = normalizeGroupLabel(groupLabel);
  if (!team || !label) return "";
  return `${team}::${label}`;
}

function groupForPlayerRound(player, roundIndex) {
  const idx = Math.max(0, Math.floor(Number(roundIndex) || 0));
  if (Array.isArray(player?.groups)) {
    const v = normalizeGroupLabel(player.groups[idx]);
    if (v) return v;
  }
  if (idx === 0) return normalizeGroupLabel(player?.group);
  return "";
}

function buildScoreTargetsForRound(roundIndex, round, scoresRound, players, teams) {
  const targetType = scoreTargetTypeForRound(round);
  const teamNameById = {};
  (teams || []).forEach((t) => {
    if (!t?.teamId) return;
    teamNameById[t.teamId] = t.teamName || t.teamId;
  });

  if (targetType === "team") {
    const targets = (teams || [])
      .map((t) => ({
        targetType,
        id: String(t.teamId || "").trim(),
        label: t.teamName || t.teamId || "",
        detail: "",
        teamId: String(t.teamId || "").trim(),
        holes: safeHoleArray(scoresRound?.teams?.[t.teamId]?.holes)
      }))
      .filter((t) => !!t.id)
      .sort((a, b) => a.label.localeCompare(b.label));
    return { targetType, targets };
  }

  if (targetType === "group") {
    const byGroupId = new Map();
    (players || []).forEach((p) => {
      const teamId = String(p?.teamId || "").trim();
      const group = groupForPlayerRound(p, roundIndex);
      const gid = twoManGroupId(teamId, group);
      if (!gid) return;
      if (!byGroupId.has(gid)) {
        byGroupId.set(gid, {
          targetType,
          id: gid,
          label: `${teamNameById[teamId] || teamId || "Team"} • Group ${group}`,
          detail: "",
          teamId,
          names: [],
          holes: safeHoleArray(scoresRound?.groups?.[gid]?.holes)
        });
      }
      const entry = byGroupId.get(gid);
      if (p?.name) entry.names.push(String(p.name));
    });

    for (const gid of Object.keys(scoresRound?.groups || {})) {
      if (byGroupId.has(gid)) continue;
      const parsed = parseTwoManGroupId(gid);
      byGroupId.set(gid, {
        targetType,
        id: gid,
        label: `${teamNameById[parsed.teamId] || parsed.teamId || "Team"} • Group ${parsed.group || "?"}`,
        detail: "",
        teamId: parsed.teamId,
        names: [],
        holes: safeHoleArray(scoresRound?.groups?.[gid]?.holes)
      });
    }

    const targets = [...byGroupId.values()]
      .map((t) => ({ ...t, detail: t.names.length ? t.names.join(", ") : "" }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return { targetType, targets };
  }

  const targets = (players || [])
    .map((p) => {
      const teamId = String(p?.teamId || "").trim();
      const teamName = teamNameById[teamId] || "";
      const playerId = String(p?.playerId || "").trim();
      return {
        targetType,
        id: playerId,
        label: p?.name || playerId,
        detail: teamName,
        teamId,
        holes: safeHoleArray(scoresRound?.players?.[playerId]?.holes)
      };
    })
    .filter((t) => !!t.id)
    .sort((a, b) => {
      const tc = String(a.detail || "").localeCompare(String(b.detail || ""));
      if (tc !== 0) return tc;
      return String(a.label || "").localeCompare(String(b.label || ""));
    });
  return { targetType, targets };
}

function renderScoresEditor() {
  if (!scoresEditorWrap) return;
  scoresEditorWrap.innerHTML = "";
  scoreInputIndex = new Map();
  scoreRowMetaByKey = new Map();

  const roundDraft = collectRoundsSafe();
  const rounds = roundDraft.length ? roundDraft : (Array.isArray(currentData?.rounds) ? currentData.rounds : []);
  const playerDraft = collectPlayersSafe();
  const players = playerDraft.length ? playerDraft : (Array.isArray(currentData?.players) ? currentData.players : []);
  const teams = Array.isArray(currentData?.teams) ? currentData.teams : [];
  const scores = normalizeScoresForUi(currentData?.scores, rounds.length);

  if (!rounds.length) {
    scoresEditorWrap.innerHTML = `<div class="small">No rounds available.</div>`;
    return;
  }

  rounds.forEach((round, roundIndex) => {
    const scoreRound = scores.rounds[roundIndex] || { teams: {}, players: {}, groups: {} };
    const { targetType, targets } = buildScoreTargetsForRound(roundIndex, round, scoreRound, players, teams);

    const section = document.createElement("div");
    section.className = "card";
    section.style.margin = "0 0 10px 0";
    section.style.boxShadow = "none";
    section.innerHTML = `
      <div style="margin-bottom:8px;">
        <b>Round ${roundIndex + 1}: ${escapeHtml(round?.name || `Round ${roundIndex + 1}`)}</b>
        <span class="small">(${escapeHtml(scoreRoundFormat(round))} • ${escapeHtml(targetType)})</span>
      </div>
    `;

    const tableWrap = document.createElement("div");
    tableWrap.className = "bulk-table-wrap";
    const table = document.createElement("table");
    table.className = "table bulk-table";

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    headerRow.innerHTML =
      `<th class="left">${targetType === "team" ? "Team" : targetType === "group" ? "Group" : "Player"}</th>` +
      Array.from({ length: 18 }, (_, i) => `<th>${i + 1}</th>`).join("");
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    targets.forEach((target) => {
      const tr = document.createElement("tr");
      const nameCell = document.createElement("td");
      nameCell.className = "left";
      nameCell.innerHTML = `<b>${escapeHtml(target.label || target.id)}</b>${target.detail ? `<div class="small">${escapeHtml(target.detail)}</div>` : ""}`;
      tr.appendChild(nameCell);

      const key = scoreKey(roundIndex, targetType, target.id);
      const rowInputs = Array(18).fill(null);
      for (let h = 0; h < 18; h++) {
        const td = document.createElement("td");
        const inp = document.createElement("input");
        inp.type = "number";
        inp.min = "1";
        inp.max = "20";
        inp.step = "1";
        inp.className = "hole-input bulk-hole-input";
        inp.style.width = "44px";
        const v = target.holes?.[h];
        inp.value = v == null ? "" : String(v);
        inp.dataset.scoreRound = String(roundIndex);
        inp.dataset.scoreType = targetType;
        inp.dataset.scoreTarget = target.id;
        inp.dataset.scoreHole = String(h);
        td.appendChild(inp);
        tr.appendChild(td);
        rowInputs[h] = inp;
      }

      scoreInputIndex.set(key, rowInputs);
      scoreRowMetaByKey.set(key, {
        roundIndex,
        roundName: round?.name || `Round ${roundIndex + 1}`,
        format: scoreRoundFormat(round),
        targetType,
        targetId: target.id,
        targetName: target.label || target.id
      });
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    tableWrap.appendChild(table);
    section.appendChild(tableWrap);
    scoresEditorWrap.appendChild(section);
  });
}

function collectScoresForSave() {
  const roundDraft = collectRoundsSafe();
  const rounds = roundDraft.length ? roundDraft : (Array.isArray(currentData?.rounds) ? currentData.rounds : []);
  const out = {
    rounds: Array.from({ length: rounds.length }, () => ({ teams: {}, players: {}, groups: {} }))
  };

  for (const [key, inputs] of scoreInputIndex.entries()) {
    const meta = scoreRowMetaByKey.get(key);
    if (!meta) continue;
    const holes = inputs.map((inp, idx) =>
      scoreCellToNumber(inp?.value, `Round ${meta.roundIndex + 1} ${meta.targetType} ${meta.targetName} hole ${idx + 1}`)
    );
    if (!holes.some((v) => v != null)) continue;
    const bucket = scoreBucketKey(meta.targetType);
    out.rounds[meta.roundIndex][bucket][meta.targetId] = { holes };
  }
  return out;
}

function buildScoresCsv() {
  const rows = [["roundIndex", "roundName", "format", "targetType", "targetId", "targetName", ...Array.from({ length: 18 }, (_, i) => `h${i + 1}`)]];
  const keys = [...scoreRowMetaByKey.keys()].sort((a, b) => {
    const ma = scoreRowMetaByKey.get(a);
    const mb = scoreRowMetaByKey.get(b);
    if (!ma || !mb) return a.localeCompare(b);
    if (ma.roundIndex !== mb.roundIndex) return ma.roundIndex - mb.roundIndex;
    return String(ma.targetName || "").localeCompare(String(mb.targetName || ""));
  });

  for (const key of keys) {
    const meta = scoreRowMetaByKey.get(key);
    const inputs = scoreInputIndex.get(key) || [];
    if (!meta) continue;
    rows.push([
      meta.roundIndex,
      meta.roundName,
      meta.format,
      meta.targetType,
      meta.targetId,
      meta.targetName,
      ...Array.from({ length: 18 }, (_, i) => String(inputs[i]?.value || "").trim())
    ]);
  }

  return rows.map((line) => line.map(csvEscape).join(",")).join("\n");
}

function applyScoresCsvToEditor(csvText) {
  const normalized = normalizeDelimitedText(csvText);
  const rows = parseCsv(normalized);
  if (!rows.length) throw new Error("Scores CSV is empty.");

  const header = rows[0].map((h) => String(h || "").trim().toLowerCase());
  const idx = {};
  header.forEach((h, i) => { idx[h] = i; });

  const roundIdxCol = idx.roundindex ?? idx.round ?? idx.r;
  const targetTypeCol = idx.targettype;
  const targetIdCol = idx.targetid;
  if (roundIdxCol == null || targetTypeCol == null || targetIdCol == null) {
    throw new Error("Scores CSV needs columns: roundIndex,targetType,targetId,h1..h18");
  }

  let matched = 0;
  let skipped = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const roundIndex = Number(String(row[roundIdxCol] || "").trim());
    const targetType = normalizeScoreTargetType(row[targetTypeCol]);
    const targetId = String(row[targetIdCol] || "").trim();
    if (!Number.isInteger(roundIndex) || roundIndex < 0 || !targetType || !targetId) {
      skipped += 1;
      continue;
    }

    const key = scoreKey(roundIndex, targetType, targetId);
    const inputs = scoreInputIndex.get(key);
    if (!inputs) {
      skipped += 1;
      continue;
    }

    for (let h = 0; h < 18; h++) {
      const hCol = idx[`h${h + 1}`] ?? idx[`hole${h + 1}`];
      if (hCol == null) continue;
      const val = String(row[hCol] ?? "").trim();
      if (!val) {
        inputs[h].value = "";
        continue;
      }
      const n = scoreCellToNumber(val, `CSV row ${r + 1} h${h + 1}`);
      inputs[h].value = n == null ? "" : String(n);
    }

    matched += 1;
  }

  return { matched, skipped };
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
  const courseId = String(course?.courseId || course?.id || "").trim();
  const pars = Array.isArray(course?.pars) && course.pars.length === 18
    ? course.pars.map((v) => Number(v) || 4)
    : defaultPars;
  const strokeIndex = Array.isArray(course?.strokeIndex) && course.strokeIndex.length === 18
    ? course.strokeIndex.map((v) => Number(v) || 0)
    : defaultSi;
  const siErr = validateStrokeIndex(strokeIndex);
  return {
    courseId,
    name: String(course?.name || "").trim(),
    pars,
    strokeIndex: siErr ? defaultSi : strokeIndex
  };
}

function extractCourseList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.courses)) return payload.courses;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function isValidCourseShape(course) {
  return Array.isArray(course?.pars)
    && course.pars.length === 18
    && Array.isArray(course?.strokeIndex)
    && course.strokeIndex.length === 18;
}

function normalizeTournamentCourses(data) {
  const fromList = Array.isArray(data?.courses) ? data.courses : [];
  const normalizedList = fromList.map((course) => normalizeCourseForUi(course)).filter(isValidCourseShape);
  if (normalizedList.length) return normalizedList;
  return [normalizeCourseForUi(data?.course || null)];
}

function roundCourseOptionsHtml(selectedRef = "tournament:0") {
  const selected = String(selectedRef || "tournament:0");
  const out = [];
  const sourceCourses = tournamentCourses.length
    ? tournamentCourses
    : [normalizeCourseForUi(null)];
  sourceCourses.forEach((course, idx) => {
    const ref = `tournament:${idx}`;
    const label = course?.name || `Course ${idx + 1}`;
    out.push(`<option value="${ref}" ${selected === ref ? "selected" : ""}>Tournament: ${escapeHtml(label)}</option>`);
  });
  savedCourses.forEach((course) => {
    const id = String(course?.courseId || "").trim();
    if (!id) return;
    const ref = `saved:${id}`;
    const label = course?.name || id;
    out.push(`<option value="${ref}" ${selected === ref ? "selected" : ""}>Saved: ${escapeHtml(label)}</option>`);
  });
  return out.join("");
}

function refreshRoundCourseSelects() {
  roundRows.querySelectorAll("select[data-field='course']").forEach((select) => {
    const prev = String(select.value || "tournament:0");
    select.innerHTML = roundCourseOptionsHtml(prev);
    const hasPrev = [...select.options].some((opt) => opt.value === prev);
    select.value = hasPrev ? prev : "tournament:0";
  });
}

async function loadSavedCourses() {
  try {
    const payload = await api("/courses");
    savedCourses = extractCourseList(payload)
      .map((course) => normalizeCourseForUi(course))
      .filter((course) => !!String(course?.courseId || "").trim());
    refreshRoundCourseSelects();
  } catch (e) {
    console.error("Failed to load saved courses:", e);
  }
}

async function ensureSavedCourseDetails(courseId) {
  const id = String(courseId || "").trim();
  if (!id) return null;
  const fromList = savedCourses.find((course) => String(course?.courseId || "").trim() === id);
  if (isValidCourseShape(fromList)) return normalizeCourseForUi(fromList);

  const payload = await api(`/courses/${encodeURIComponent(id)}`);
  const loaded = normalizeCourseForUi(payload?.course || payload);
  if (!isValidCourseShape(loaded)) {
    throw new Error(`Saved course ${id} is missing pars/strokeIndex.`);
  }
  const existingIdx = savedCourses.findIndex((course) => String(course?.courseId || "").trim() === id);
  if (existingIdx >= 0) savedCourses[existingIdx] = loaded;
  else savedCourses.push(loaded);
  return loaded;
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
    const currentFmt = currentFmtRaw === "two_man" ? "two_man_scramble" : currentFmtRaw;
    const fallbackCourseIdx = Number.isInteger(Number(round?.courseIndex)) ? Number(round.courseIndex) : 0;
    const currentCourseRef = String(round?.courseRef || `tournament:${Math.max(0, fallbackCourseIdx)}`);
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
      <td>
        <select data-field="course">
          ${roundCourseOptionsHtml(currentCourseRef)}
        </select>
      </td>
      <td><input data-field="remove" type="checkbox" /></td>
    `;
    roundRows.appendChild(tr);
  });

  roundRows.querySelectorAll("input,select").forEach((node) => {
    node.addEventListener("change", () => {
      const nextCount = Math.max(1, collectRoundsSafe().length || 1);
      renderPlayers(collectPlayersSafe(), nextCount);
      renderScoresEditor();
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

  playerRows.querySelectorAll("input").forEach((node) => {
    node.addEventListener("change", () => {
      renderScoresEditor();
    });
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
      const courseRef = String(tr.querySelector("[data-field='course']")?.value || "tournament:0").trim();
      return {
        name,
        format,
        useHandicap,
        courseRef: courseRef || "tournament:0",
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
  renderScoresEditor();
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
    courseRef: "tournament:0",
    weight: 1,
    teamAggregation: { mode: "avg", topX: 4 }
  });
  renderRounds(rounds);
  renderPlayers(collectPlayersSafe(), rounds.length || 1);
  renderScoresEditor();
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
  renderScoresEditor();
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
  tournamentCourses = normalizeTournamentCourses(data);
  setHeaderTournamentName(data?.tournament?.name);
  nameEl.value = data?.tournament?.name || "";
  datesEl.value = data?.tournament?.dates || "";
  const course = tournamentCourses[0] || normalizeCourseForUi(data?.course || null);
  if (courseNameEl) courseNameEl.value = course.name;
  fillCourseRows(course.pars, course.strokeIndex);
  const rounds = data?.rounds || [];
  renderRounds(rounds);
  renderPlayers(data?.players || [], rounds.length || 1);
  renderScoresEditor();
  if (scoresStatus) scoresStatus.textContent = "";
  loadedScoresCsvText = "";

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

async function resolveCoursesAndRoundsForSave(roundsDraft, primaryCourse) {
  const baseCourses = tournamentCourses.length
    ? tournamentCourses.map((course) => normalizeCourseForUi(course))
    : [normalizeCourseForUi(primaryCourse)];
  baseCourses[0] = normalizeCourseForUi(primaryCourse);

  const courses = baseCourses.map((course) => ({
    ...(course?.name ? { name: course.name } : {}),
    pars: Array.isArray(course?.pars) ? course.pars.slice() : Array(18).fill(4),
    strokeIndex: Array.isArray(course?.strokeIndex)
      ? course.strokeIndex.slice()
      : Array.from({ length: 18 }, (_, i) => i + 1)
  }));

  const refToIndex = new Map();
  courses.forEach((_, idx) => refToIndex.set(`tournament:${idx}`, idx));

  const rounds = [];
  for (const round of roundsDraft) {
    const ref = String(round?.courseRef || "tournament:0").trim() || "tournament:0";
    let courseIndex = 0;

    if (ref.startsWith("saved:")) {
      const id = ref.slice("saved:".length).trim();
      if (!id) throw new Error(`Unknown course selection "${ref}".`);
      const key = `saved:${id}`;
      if (!refToIndex.has(key)) {
        const detail = await ensureSavedCourseDetails(id);
        if (!detail || !isValidCourseShape(detail)) {
          throw new Error(`Saved course "${id}" was not found.`);
        }
        refToIndex.set(key, courses.length);
        courses.push({
          ...(detail?.name ? { name: detail.name } : {}),
          pars: detail.pars.slice(),
          strokeIndex: detail.strokeIndex.slice()
        });
      }
      courseIndex = refToIndex.get(key);
    } else if (ref.startsWith("tournament:")) {
      const idx = Number(ref.slice("tournament:".length));
      courseIndex = Number.isInteger(idx) && idx >= 0 && idx < courses.length ? idx : 0;
    }

    rounds.push({
      ...round,
      courseIndex
    });
  }

  return {
    courses,
    rounds: rounds.map(({ courseRef, ...rest }) => rest)
  };
}

async function saveTournament() {
  if (!currentTid) return;
  if (!currentEditCode) {
    saveStatus.textContent = "Missing edit code.";
    return;
  }
  saveStatus.textContent = "Saving…";
  try {
    const primaryCourse = collectCourse();
    const roundDraft = collectRounds();
    const { courses, rounds } = await resolveCoursesAndRoundsForSave(roundDraft, primaryCourse);
    const payload = {
      editCode: currentEditCode,
      tournament: {
        name: String(nameEl.value || "").trim(),
        dates: String(datesEl.value || "").trim()
      },
      course: courses[0],
      courses,
      rounds,
      players: collectPlayers(),
      scores: collectScoresForSave()
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

function loadSelectedScoresCsvFile() {
  if (!scoresStatus) return;
  scoresStatus.textContent = "";
  const file = scoresCsvFileInput?.files?.[0];
  if (!file) {
    scoresStatus.textContent = "Choose a scores CSV/TSV file first.";
    return;
  }
  file
    .text()
    .then((text) => {
      loadedScoresCsvText = String(text || "").trim();
      if (!loadedScoresCsvText) {
        scoresStatus.textContent = `${file.name} is empty.`;
        return;
      }
      scoresStatus.textContent = `Loaded ${file.name}.`;
    })
    .catch((e) => {
      console.error(e);
      scoresStatus.textContent = "Failed to read scores file.";
    });
}

function downloadScoresCsv() {
  if (!currentTid) return;
  try {
    const csv = buildScoresCsv();
    downloadText(`scores_${currentTid}.csv`, csv);
    if (scoresStatus) scoresStatus.textContent = "Scores CSV downloaded.";
  } catch (e) {
    console.error(e);
    if (scoresStatus) scoresStatus.textContent = e.message || String(e);
  }
}

async function uploadScoresCsvToTable() {
  if (!currentTid) return;
  if (!scoresStatus) return;
  scoresStatus.textContent = "Uploading…";
  try {
    let text = String(loadedScoresCsvText || "").trim();
    if (!text && scoresCsvFileInput?.files?.[0]) {
      text = String(await scoresCsvFileInput.files[0].text() || "").trim();
      loadedScoresCsvText = text;
    }
    if (!text) {
      scoresStatus.textContent = "Load a scores CSV/TSV file first.";
      return;
    }
    const { matched, skipped } = applyScoresCsvToEditor(text);
    scoresStatus.textContent = `Loaded scores into table (${matched} matched row${matched === 1 ? "" : "s"}, ${skipped} skipped). Save changes to persist.`;
  } catch (e) {
    console.error(e);
    scoresStatus.textContent = e.message || String(e);
  }
}

rebuildCourseRows();
loadSavedCourses();
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
if (loadScoresCsvFileBtn) loadScoresCsvFileBtn.addEventListener("click", loadSelectedScoresCsvFile);
if (uploadScoresCsvBtn) uploadScoresCsvBtn.addEventListener("click", uploadScoresCsvToTable);
if (downloadScoresCsvBtn) downloadScoresCsvBtn.addEventListener("click", downloadScoresCsv);

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
