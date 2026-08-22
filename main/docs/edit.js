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
const resetTidInput = document.getElementById("reset_tid_input");
const resetKeyInput = document.getElementById("reset_key_input");
const resetEditCodeBtn = document.getElementById("reset_edit_code_btn");
const resetCodeStatus = document.getElementById("reset_code_status");
const resetCodeResult = document.getElementById("reset_code_result");
const resetCodeOutput = document.getElementById("reset_code_output");

const tidValue = document.getElementById("tid_value");
const scoreboardLink = document.getElementById("scoreboard_link");
const updatedMeta = document.getElementById("updated_meta");
const saveStatus = document.getElementById("save_status");
const importStatus = document.getElementById("import_status");
const scoresStatus = document.getElementById("scores_status");

const nameEl = document.getElementById("e_name");
const datesEl = document.getElementById("e_dates");
const scoringEl = document.getElementById("e_scoring");
const competitionTypeEl = document.getElementById("e_competition_type");
const matchPlaySettingsEl = document.getElementById("e_match_play_settings");
const matchPointsEl = document.getElementById("e_match_points");
const matchWinTargetEl = document.getElementById("e_match_win_target");
const roundRows = document.getElementById("round_rows");
const strokeRoundsWrap = document.getElementById("stroke_rounds_wrap");
const strokeRoundsHelp = document.getElementById("stroke_rounds_help");
const matchPlayRoundsEl = document.getElementById("match_play_rounds");
const scoresCard = document.getElementById("scores_card");
const teamRows = document.getElementById("team_rows");
const playersHead = document.getElementById("players_head");
const playerRows = document.getElementById("player_rows");
const csvImport = document.getElementById("csv_import");
const csvFileInput = document.getElementById("csv_file");
const loadCsvFileBtn = document.getElementById("load_csv_file_btn");
const scoresCsvFileInput = document.getElementById("scores_csv_file");
const loadScoresCsvFileBtn = document.getElementById("load_scores_csv_file_btn");
const uploadScoresCsvBtn = document.getElementById("upload_scores_csv_btn");
const downloadScoresCsvBtn = document.getElementById("download_scores_csv_btn");
const undoScoresBtn = document.getElementById("undo_scores_btn");
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
let scoreGridRowsByRound = new Map();
let tournamentCourses = [];
let savedCourses = [];

function isMatchPlayEditor(){
  return String(competitionTypeEl?.value || currentData?.tournament?.competitionType || "stroke_play").trim().toLowerCase() === "team_match_play";
}

const ROUND_FORMATS = [
  { value: "scramble", label: "scramble" },
  { value: "team_best_ball", label: "team best ball" },
  { value: "two_man_scramble", label: "two man scramble" },
  { value: "two_man_shamble", label: "two man shamble" },
  { value: "two_man_best_ball", label: "two man best ball" },
  { value: "shamble", label: "shamble" },
  { value: "singles", label: "singles" }
];
const MATCH_PLAY_FORMATS = [
  { value: "singles", label: "Singles (1 vs 1)", minPlayers: 1, maxPlayers: 1 },
  { value: "best_ball", label: "Best ball (2–4 vs 2–4)", minPlayers: 2, maxPlayers: 4 },
  { value: "alternate_shot", label: "Alternate shot (2 vs 2)", minPlayers: 2, maxPlayers: 2 },
  { value: "scramble", label: "Scramble (2 vs 2)", minPlayers: 2, maxPlayers: 2 }
];
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
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function matchPlayFormatRule(format) {
  return MATCH_PLAY_FORMATS.find((entry) => entry.value === String(format || "")) || MATCH_PLAY_FORMATS[0];
}

function matchPlayFormatLabel(format) {
  return matchPlayFormatRule(format).label;
}

function roundMaxHoleScoreValue(rule) {
  if (!rule || typeof rule !== "object") return "none";
  const type = String(rule.type || "").trim().toLowerCase();
  const value = Number(rule.value);
  if ((type !== "to_par" && type !== "score") || !Number.isFinite(value)) return "none";
  return `${type}:${Math.round(value)}`;
}

function roundMaxHoleScoreOptionsHtml(selectedValue = "none") {
  const selected = typeof selectedValue === "string"
    ? (String(selectedValue || "").trim().toLowerCase() || "none")
    : roundMaxHoleScoreValue(selectedValue);
  return MAX_HOLE_SCORE_OPTIONS
    .map((option) => `<option value="${option.value}" ${option.value === selected ? "selected" : ""}>${escapeHtml(option.label)}</option>`)
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

function normalizeTeamColor(v) {
  const raw = String(v || "").trim();
  if (!raw) return "";
  const match = raw.match(/^#?([0-9a-fA-F]{6})$/);
  return match ? `#${match[1].toUpperCase()}` : "";
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
    raw === "singles" ||
    raw === "best_ball" ||
    raw === "alternate_shot"
  ) {
    return raw;
  }
  return "singles";
}

function scoreHoleIndicesForRound(round) {
  if (Number(round?.holes) !== 9) return Array.from({ length: 18 }, (_, index) => index);
  const side = String(round?.nineHoleSide || "").trim().toLowerCase() === "back" ? "back" : "front";
  const start = side === "back" ? 9 : 0;
  return Array.from({ length: 9 }, (_, index) => start + index);
}

function scoreRoundHoleMeta(round) {
  if (Number(round?.holes) !== 9) return "18 holes";
  return String(round?.nineHoleSide || "").trim().toLowerCase() === "back"
    ? "9 holes · Back nine"
    : "9 holes · Front nine";
}

function scoreTargetTypeForRound(round) {
  if (isMatchPlayEditor()) return "match_side";
  const fmt = scoreRoundFormat(round);
  if (fmt === "scramble") return "team";
  if (fmt === "two_man_scramble") return "group";
  return "player";
}

function scoreBucketKey(targetType) {
  if (targetType === "team") return "teams";
  if (targetType === "group") return "groups";
  if (targetType === "match_side") return "matches";
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
  if (v === "matchside" || v === "matchsides") return "match_side";
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
      const outRound = { teams: {}, players: {}, groups: {}, matches: {} };
      for (const [teamId, entry] of Object.entries(src?.teams || {})) {
        outRound.teams[teamId] = { holes: safeHoleArray(entry?.holes || entry) };
      }
      for (const [playerId, entry] of Object.entries(src?.players || {})) {
        outRound.players[playerId] = { holes: safeHoleArray(entry?.holes || entry) };
      }
      for (const [groupId, entry] of Object.entries(src?.groups || {})) {
        outRound.groups[groupId] = { holes: safeHoleArray(entry?.holes || entry) };
      }
      for (const [matchId, match] of Object.entries(src?.matches || {})) {
        outRound.matches[matchId] = { sides: {} };
        for (const [teamId, entry] of Object.entries(match?.sides || {})) {
          outRound.matches[matchId].sides[teamId] = { holes: safeHoleArray(entry?.holes || entry) };
        }
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

function parseScorePasteGrid(text) {
  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n+$/, "");
  if (!normalized) return [];
  if (normalized.includes("\t")) {
    return normalized.split("\n").map((line) => line.split("\t"));
  }
  return parseCsv(normalized);
}

function applyScorePasteGrid(anchorInput, clipboardText) {
  const grid = parseScorePasteGrid(clipboardText);
  const isMultiCell = grid.length > 1 || grid.some((row) => row.length > 1);
  if (!isMultiCell) return { handled: false, applied: 0, skipped: 0 };

  const roundIndex = Number(anchorInput?.dataset?.scoreRound);
  const rowIndex = Number(anchorInput?.dataset?.scoreRow);
  const holeIndex = Number(anchorInput?.dataset?.scoreHole);
  const roundRows = scoreGridRowsByRound.get(roundIndex);
  if (
    !Number.isInteger(roundIndex) ||
    !Number.isInteger(rowIndex) ||
    !Number.isInteger(holeIndex) ||
    !Array.isArray(roundRows)
  ) {
    return { handled: false, applied: 0, skipped: 0 };
  }

  const assignments = [];
  let skipped = 0;
  for (let r = 0; r < grid.length; r++) {
    const targetRow = roundRows[rowIndex + r];
    if (!targetRow) {
      skipped += grid[r].length;
      continue;
    }
    for (let c = 0; c < grid[r].length; c++) {
      const targetInput = targetRow[holeIndex + c];
      if (!targetInput) {
        skipped += 1;
        continue;
      }
      const rawValue = String(grid[r][c] ?? "").trim();
      const parsedValue = rawValue ? scoreCellToNumber(rawValue, `Pasted cell row ${r + 1}, column ${c + 1}`) : null;
      assignments.push({ input: targetInput, value: parsedValue == null ? "" : String(parsedValue) });
    }
  }

  assignments.forEach(({ input, value }) => {
    input.value = value;
  });

  return { handled: true, applied: assignments.length, skipped };
}

function handleScoresEditorPaste(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !target.dataset.scoreRow) return;

  const text = String(event.clipboardData?.getData("text/plain") || "");
  if (!text) return;

  try {
    const result = applyScorePasteGrid(target, text);
    if (!result.handled) return;
    event.preventDefault();
    if (scoresStatus) {
      scoresStatus.textContent =
        `Pasted ${result.applied} cell${result.applied === 1 ? "" : "s"} from Excel.` +
        `${result.skipped ? ` ${result.skipped} skipped outside the table.` : ""} Save changes to persist.`;
    }
  } catch (e) {
    event.preventDefault();
    console.error(e);
    if (scoresStatus) scoresStatus.textContent = e.message || String(e);
  }
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

  if (targetType === "match_side") {
    const targets = [];
    (round?.matches || []).forEach((match, matchIndex) => {
      const matchId = String(match?.matchId || `r${roundIndex + 1}m${matchIndex + 1}`).trim();
      for (const side of [match?.teamA, match?.teamB]) {
        const teamId = String(side?.teamId || "").trim();
        if (!matchId || !teamId) continue;
        const playerNames = (side?.playerIds || [])
          .map((playerId) => players.find((player) => String(player?.playerId || "") === String(playerId))?.name || playerId)
          .filter(Boolean)
          .join(" + ");
        const targetId = `${matchId}::${teamId}`;
        targets.push({
          targetType,
          id: targetId,
          matchId,
          teamId,
          label: teamNameById[teamId] || teamId,
          detail: `${matchId}${playerNames ? ` · ${playerNames}` : ""}`,
          holes: safeHoleArray(scoresRound?.matches?.[matchId]?.sides?.[teamId]?.holes)
        });
      }
    });
    return { targetType, targets };
  }

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
  scoreGridRowsByRound = new Map();

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
    const scoreRound = scores.rounds[roundIndex] || { teams: {}, players: {}, groups: {}, matches: {} };
    const { targetType, targets } = buildScoreTargetsForRound(roundIndex, round, scoreRound, players, teams);
    const activeHoleIndices = scoreHoleIndicesForRound(round);
    const roundGridRows = [];

    const section = document.createElement("div");
    section.className = "card";
    section.style.margin = "0 0 10px 0";
    section.style.boxShadow = "none";
    section.innerHTML = `
      <div style="margin-bottom:8px;">
        <b>Round ${roundIndex + 1}: ${escapeHtml(round?.name || `Round ${roundIndex + 1}`)}</b>
        <span class="small">(${escapeHtml(scoreRoundFormat(round))} • ${escapeHtml(scoreRoundHoleMeta(round))} • ${escapeHtml(targetType)})</span>
      </div>
    `;

    const tableWrap = document.createElement("div");
    tableWrap.className = "bulk-table-wrap";
    const table = document.createElement("table");
    table.className = "table bulk-table";

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    headerRow.innerHTML =
      `<th class="left">${targetType === "team" ? "Team" : targetType === "group" ? "Group" : targetType === "match_side" ? "Match side" : "Player"}</th>` +
      activeHoleIndices.map((holeIndex) => `<th>${holeIndex + 1}</th>`).join("");
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    targets.forEach((target, targetRowIndex) => {
      const tr = document.createElement("tr");
      const nameCell = document.createElement("td");
      nameCell.className = "left";
      nameCell.innerHTML = `<b>${escapeHtml(target.label || target.id)}</b>${target.detail ? `<div class="small">${escapeHtml(target.detail)}</div>` : ""}`;
      tr.appendChild(nameCell);

      const key = scoreKey(roundIndex, targetType, target.id);
      const rowInputs = Array(18).fill(null);
      for (const h of activeHoleIndices) {
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
        inp.dataset.scoreRow = String(targetRowIndex);
        inp.dataset.scoreType = targetType;
        inp.dataset.scoreTarget = target.id;
        inp.dataset.scoreHole = String(h);
        td.appendChild(inp);
        tr.appendChild(td);
        rowInputs[h] = inp;
      }

      scoreInputIndex.set(key, rowInputs);
      roundGridRows.push(rowInputs);
      scoreRowMetaByKey.set(key, {
        roundIndex,
        roundName: round?.name || `Round ${roundIndex + 1}`,
        format: scoreRoundFormat(round),
        targetType,
        targetId: target.id,
        matchId: target.matchId || "",
        teamId: target.teamId || "",
        targetName: target.label || target.id
      });
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    tableWrap.appendChild(table);
    section.appendChild(tableWrap);
    scoresEditorWrap.appendChild(section);
    scoreGridRowsByRound.set(roundIndex, roundGridRows);
  });
}

function collectScoresForSave() {
  const roundDraft = collectRoundsSafe();
  const rounds = roundDraft.length ? roundDraft : (Array.isArray(currentData?.rounds) ? currentData.rounds : []);
  const out = {
    rounds: Array.from({ length: rounds.length }, () => ({ teams: {}, players: {}, groups: {}, matches: {} }))
  };

  for (const [key, inputs] of scoreInputIndex.entries()) {
    const meta = scoreRowMetaByKey.get(key);
    if (!meta) continue;
    const holes = inputs.map((inp, idx) =>
      scoreCellToNumber(inp?.value, `Round ${meta.roundIndex + 1} ${meta.targetType} ${meta.targetName} hole ${idx + 1}`)
    );
    if (!holes.some((v) => v != null)) continue;
    if (meta.targetType === "match_side") {
      const matchId = String(meta.matchId || "").trim();
      const teamId = String(meta.teamId || "").trim();
      if (!matchId || !teamId) continue;
      out.rounds[meta.roundIndex].matches[matchId] ||= { sides: {} };
      out.rounds[meta.roundIndex].matches[matchId].sides[teamId] = { holes };
      continue;
    }
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
      const targetInput = inputs[h];
      if (!targetInput) {
        if (String(row[hCol] ?? "").trim()) skipped += 1;
        continue;
      }
      const val = String(row[hCol] ?? "").trim();
      if (!val) {
        targetInput.value = "";
        continue;
      }
      const n = scoreCellToNumber(val, `CSV row ${r + 1} h${h + 1}`);
      targetInput.value = n == null ? "" : String(n);
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
  const baseLabelParts = [];
  if (teeName) baseLabelParts.push(teeName);
  if (Number.isFinite(totalYards)) baseLabelParts.push(`${totalYards} yds`);
  const ratingsText = ratingSummary(ratings);
  return {
    key,
    teeName: teeName || "Tee",
    ...(Number.isFinite(totalYards) ? { totalYards } : {}),
    ...(Number.isFinite(parTotal) ? { parTotal } : {}),
    ...(holeYardages.length === 18 ? { holeYardages } : {}),
    ratings,
    ratingsText,
    label: [...baseLabelParts, ratingsText].filter(Boolean).join(" • ")
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

function normalizeCourseForUi(course) {
  const defaultPars = Array(18).fill(4);
  const defaultSi = Array.from({ length: 18 }, (_, i) => i + 1);
  const courseId = String(course?.courseId || course?.id || "").trim();
  const sourceCourseId = String(course?.sourceCourseId || "").trim();
  const dataSlug = String(course?.dataSlug || "").trim();
  const mapSlug = String(course?.mapSlug || "").trim();
  const pars = Array.isArray(course?.pars) && course.pars.length === 18
    ? course.pars.map((v) => Number(v) || 4)
    : defaultPars;
  const strokeIndex = Array.isArray(course?.strokeIndex) && course.strokeIndex.length === 18
    ? course.strokeIndex.map((v) => Number(v) || 0)
    : defaultSi;
  const siErr = validateStrokeIndex(strokeIndex);
  const tees = teeListFromCourse(course);
  let selectedTeeKey = String(course?.selectedTeeKey || course?.teeKey || "").trim();
  if (!selectedTeeKey && tees.length === 1) selectedTeeKey = tees[0].key;
  const selectedTee = tees.find((tee) => tee.key === selectedTeeKey) || null;
  return {
    courseId,
    ...(sourceCourseId ? { sourceCourseId } : {}),
    ...(dataSlug ? { dataSlug } : {}),
    ...(mapSlug ? { mapSlug } : {}),
    name: String(course?.name || "").trim(),
    pars,
    strokeIndex: siErr ? defaultSi : strokeIndex,
    tees,
    ...(selectedTeeKey ? { selectedTeeKey } : {}),
    ...(selectedTee?.teeName ? { teeName: selectedTee.teeName } : String(course?.teeName || "").trim() ? { teeName: String(course?.teeName || "").trim() } : {}),
    ...(selectedTee?.label ? { teeLabel: selectedTee.label } : String(course?.teeLabel || "").trim() ? { teeLabel: String(course?.teeLabel || "").trim() } : {}),
    ...(Number.isFinite(selectedTee?.totalYards) ? { totalYards: selectedTee.totalYards } : Number.isFinite(Number(course?.totalYards)) ? { totalYards: Math.round(Number(course.totalYards)) } : {}),
    ...(Array.isArray(selectedTee?.holeYardages) && selectedTee.holeYardages.length === 18
      ? { holeYardages: selectedTee.holeYardages.slice() }
      : Array.isArray(course?.holeYardages) && course.holeYardages.length === 18
        ? { holeYardages: course.holeYardages.map((value) => Number(value) || 0) }
        : {}),
    ...(Array.isArray(selectedTee?.ratings) && selectedTee.ratings.length
      ? { ratings: selectedTee.ratings.map((entry) => serializeRatingEntry(entry)).filter(Boolean) }
      : Array.isArray(course?.ratings) && course.ratings.length
        ? { ratings: course.ratings.map((entry) => serializeRatingEntry(entry)).filter(Boolean) }
        : {})
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

function courseOptionLabel(course, fallbackLabel) {
  const base = String(course?.name || "").trim() || fallbackLabel;
  const teeSuffix = String(course?.teeLabel || "").trim();
  return teeSuffix ? `${base} (${teeSuffix})` : base;
}

function roundCourseOptionsHtml(selectedRef = "tournament:0") {
  const selected = String(selectedRef || "tournament:0");
  const out = [];
  const sourceCourses = tournamentCourses.length
    ? tournamentCourses
    : [normalizeCourseForUi(null)];
  sourceCourses.forEach((course, idx) => {
    const ref = `tournament:${idx}`;
    const label = courseOptionLabel(course, `Course ${idx + 1}`);
    out.push(`<option value="${ref}" ${selected === ref ? "selected" : ""}>Tournament: ${escapeHtml(label)}</option>`);
  });
  savedCourses.forEach((course) => {
    const id = String(course?.courseId || "").trim();
    if (!id) return;
    const ref = `saved:${id}`;
    const label = courseOptionLabel(course, id);
    out.push(`<option value="${ref}" ${selected === ref ? "selected" : ""}>Saved: ${escapeHtml(label)}</option>`);
  });
  return out.join("");
}

function resolveRoundCourseRef(ref) {
  const value = String(ref || "tournament:0").trim() || "tournament:0";
  if (value.startsWith("saved:")) {
    const id = value.slice("saved:".length).trim();
    return savedCourses.find((course) => String(course?.courseId || "").trim() === id) || null;
  }
  const idx = Number(value.slice("tournament:".length));
  if (Number.isInteger(idx) && idx >= 0 && idx < tournamentCourses.length) {
    return tournamentCourses[idx] || null;
  }
  return tournamentCourses[0] || normalizeCourseForUi(null);
}

function syncRoundTeeSelect(row) {
  const courseSelect = row?.querySelector("[data-field='course']");
  const teeSelect = row?.querySelector("[data-field='tee']");
  if (!courseSelect || !teeSelect) return;

  const course = normalizeCourseForUi(resolveRoundCourseRef(courseSelect.value));
  const tees = Array.isArray(course?.tees) ? course.tees : [];
  const previous = String(teeSelect.value || row?.dataset?.teeRef || "").trim();

  if (!tees.length) {
    teeSelect.innerHTML = `<option value="">—</option>`;
    teeSelect.value = "";
    teeSelect.disabled = true;
    row.dataset.teeRef = "";
    return;
  }

  teeSelect.disabled = false;
  teeSelect.innerHTML = tees
    .map((tee) => `<option value="${escapeHtml(tee.key)}">${escapeHtml(tee.label || tee.teeName || tee.key)}</option>`)
    .join("");

  let next = previous;
  if (!tees.some((tee) => tee.key === next)) next = String(course?.selectedTeeKey || "").trim();
  if (!tees.some((tee) => tee.key === next)) next = tees[0].key;
  teeSelect.value = next;
  row.dataset.teeRef = next;
}

function refreshRoundCourseSelects() {
  roundRows.querySelectorAll("select[data-field='course']").forEach((select) => {
    const prev = String(select.value || "tournament:0");
    select.innerHTML = roundCourseOptionsHtml(prev);
    const hasPrev = [...select.options].some((opt) => opt.value === prev);
    select.value = hasPrev ? prev : "tournament:0";
  });
  roundRows.querySelectorAll("tr").forEach((row) => syncRoundTeeSelect(row));
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
  const normalizedFromList = normalizeCourseForUi(fromList);
  if (isValidCourseShape(normalizedFromList) && Array.isArray(normalizedFromList?.tees) && normalizedFromList.tees.length) {
    return normalizedFromList;
  }

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
  const base = normalizeCourseForUi(tournamentCourses[0] || null);
  const strokeIndex = getStrokeIndex();
  const siErr = validateStrokeIndex(strokeIndex);
  if (siErr) throw new Error(siErr);
  const out = {
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
    pars: getPars(),
    strokeIndex
  };
  const name = String(courseNameEl?.value || "").trim();
  if (name) out.name = name;
  return out;
}

function matchPlayTeamIds(){
  const configured = currentData?.tournament?.matchPlay?.teamIds || currentData?.matchPlay?.teamIds;
  const ids = Array.isArray(configured)
    ? configured.map((value) => String(value?.teamId || value?.id || value || "").trim()).filter(Boolean)
    : [];
  if (ids.length === 2) return ids;
  const teams = Array.isArray(currentData?.teams) ? currentData.teams : Object.values(currentData?.teams || {});
  return teams.map((team) => String(team?.teamId || "").trim()).filter(Boolean).slice(0, 2);
}

function selectedValues(select){
  return [...(select?.selectedOptions || [])].map((option) => option.value).filter(Boolean);
}

function matchPlayerOptions(teamId, selectedIds = [], assignedElsewhere = new Set()){
  const selected = new Set(selectedIds || []);
  const draftPlayers = collectPlayersSafe();
  const players = draftPlayers.length || !Array.isArray(currentData?.players)
    ? draftPlayers
    : currentData.players;
  const options = players
    .filter((player) => !player.remove && player.playerId && String(player.teamId || "") === String(teamId || ""))
    .map((player) => {
      const playerId = String(player.playerId);
      const disabled = assignedElsewhere.has(playerId) && !selected.has(playerId);
      return `<option value="${escapeHtml(playerId)}" ${selected.has(playerId) ? "selected" : ""}${disabled ? " disabled" : ""}>${escapeHtml(player.name || playerId || "Player")}</option>`;
    })
    .join("");
  return options || `<option value="" disabled>No imported players on this team</option>`;
}

function syncMatchPlayAssignments(roundCard) {
  if (!roundCard) return;
  const format = String(roundCard.querySelector("[data-field='matchFormat']")?.value || "singles");
  const rule = matchPlayFormatRule(format);
  const matchRows = [...roundCard.querySelectorAll("[data-match-editor]")];
  const assignments = matchRows.map((row) => new Set([
    ...selectedValues(row.querySelector("[data-side='a']")),
    ...selectedValues(row.querySelector("[data-side='b']"))
  ]));
  const duplicateIds = new Set();
  const seen = new Set();
  assignments.forEach((ids) => ids.forEach((id) => {
    if (seen.has(id)) duplicateIds.add(id);
    seen.add(id);
  }));
  matchRows.forEach((row, index) => {
    const assignedElsewhere = new Set();
    assignments.forEach((ids, otherIndex) => {
      if (otherIndex !== index) ids.forEach((id) => assignedElsewhere.add(id));
    });
    for (const side of ["a", "b"]) {
      const select = row.querySelector(`[data-side='${side}']`);
      if (!select) continue;
      [...select.options].forEach((option) => {
        if (!option.value) {
          option.disabled = true;
          return;
        }
        option.disabled = assignedElsewhere.has(option.value) && !option.selected;
      });
    }
    const counts = [
      selectedValues(row.querySelector("[data-side='a']")).length,
      selectedValues(row.querySelector("[data-side='b']")).length
    ];
    const message = row.querySelector("[data-match-validation]");
    if (message) {
      const countText = rule.minPlayers === rule.maxPlayers
        ? `exactly ${rule.minPlayers}`
        : `${rule.minPlayers}–${rule.maxPlayers}`;
      message.textContent = counts.every((count) => count >= rule.minPlayers && count <= rule.maxPlayers)
        ? `${matchPlayFormatLabel(format)} • ${counts.join(" vs ")} players`
        : `${matchPlayFormatLabel(format)} • choose ${countText} players per side`;
      if (duplicateIds.size) message.textContent += " • duplicate player assignment in this round";
    }
  });
}

function appendMatchEditor(roundCard, match, roundIndex, matchIndex, teamIds){
  const matchesHost = roundCard.querySelector("[data-matches]");
  if (!matchesHost || teamIds.length !== 2) return;
  const points = Number(match?.points || matchPointsEl?.value || 1);
  const matchId = String(match?.matchId || `r${roundIndex + 1}m${matchIndex + 1}`);
  const teamAId = String(match?.teamA?.teamId || teamIds[0]);
  const teamBId = String(match?.teamB?.teamId || teamIds[1]);
  const teamName = (teamId) => {
    const sourceTeams = Array.isArray(currentData?.teams) ? currentData.teams : Object.values(currentData?.teams || {});
    return sourceTeams.find((team) => String(team?.teamId || "") === teamId)?.teamName
      || collectTeamsSafe().find((team) => String(team?.teamId || "") === teamId)?.teamName
      || teamId;
  };
  const row = document.createElement("div");
  row.className = "card";
  row.dataset.matchEditor = "true";
  row.dataset.matchId = matchId;
  row.style.margin = "10px 0 0";
  row.innerHTML = `
    <div class="actions" style="justify-content:space-between; align-items:center;">
      <b>${escapeHtml(matchId)}</b>
      <button type="button" class="secondary" data-remove-match>Remove match</button>
    </div>
    <div class="row" style="margin-top:8px;">
      <div class="col">
        <label>${escapeHtml(teamName(teamAId))}</label>
        <select data-side="a" data-team-id="${escapeHtml(teamAId)}" multiple size="4">${matchPlayerOptions(teamAId, match?.teamA?.playerIds)}</select>
      </div>
      <div class="col">
        <label>${escapeHtml(teamName(teamBId))}</label>
        <select data-side="b" data-team-id="${escapeHtml(teamBId)}" multiple size="4">${matchPlayerOptions(teamBId, match?.teamB?.playerIds)}</select>
      </div>
      <div class="col">
        <label>Points</label>
        <input data-match-points type="number" min="0.5" step="0.5" value="${Number.isFinite(points) && points > 0 ? points : 1}" />
      </div>
    </div>
    <div class="small" data-match-validation style="margin-top:8px;"></div>
  `;
  row.querySelector("[data-remove-match]")?.addEventListener("click", () => {
    row.remove();
    syncMatchPlayAssignments(roundCard);
    renderScoresEditor();
  });
  row.querySelectorAll("select[data-side]").forEach((select) => {
    select.addEventListener("change", () => {
      syncMatchPlayAssignments(roundCard);
      renderScoresEditor();
    });
  });
  matchesHost.appendChild(row);
  syncMatchPlayAssignments(roundCard);
}

function renderMatchPlayRounds(rounds){
  if (!matchPlayRoundsEl) return;
  const rows = Array.isArray(rounds) ? rounds : [];
  const teamIds = matchPlayTeamIds();
  matchPlayRoundsEl.innerHTML = "";
  if (teamIds.length !== 2) {
    matchPlayRoundsEl.innerHTML = `<div class="small" style="margin-top:10px; color:var(--bad);">Team match play requires exactly two teams with saved player IDs.</div>`;
    return;
  }
  rows.forEach((round, roundIndex) => {
    const format = ["singles", "best_ball", "alternate_shot", "scramble"].includes(round?.format) ? round.format : "singles";
    const rawNineHoleSide = String(round?.nineHoleSide || "").toLowerCase();
    const nineHoleSide = rawNineHoleSide === "back"
      ? "back"
      : rawNineHoleSide === "front" || Number(round?.holes) === 9
        ? "front"
        : "";
    const fallbackCourseIdx = Number.isInteger(Number(round?.courseIndex)) ? Number(round.courseIndex) : 0;
    const courseRef = String(round?.courseRef || `tournament:${Math.max(0, fallbackCourseIdx)}`);
    const fallbackCourse = tournamentCourses[fallbackCourseIdx] || null;
    const teeRef = String(round?.teeRef || fallbackCourse?.selectedTeeKey || "");
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.roundIndex = String(roundIndex);
    card.dataset.teeRef = teeRef;
    card.dataset.modelHandicapMultiplier = String(round?.modelHandicapMultiplier ?? 1);
    card.style.margin = "12px 0 0";
    card.innerHTML = `
      <div class="actions" style="justify-content:space-between; align-items:center;">
        <b>Round ${roundIndex + 1}</b>
        <label style="display:flex; gap:6px; align-items:center; margin:0;"><input data-remove-round type="checkbox" /> Remove</label>
      </div>
      <div class="row" style="margin-top:8px;">
        <div class="col"><label>Name</label><input data-field="name" value="${escapeHtml(round?.name || `Round ${roundIndex + 1}`)}" /></div>
        <div class="col"><label>Format</label><select data-field="matchFormat">
          <option value="singles" ${format === "singles" ? "selected" : ""}>singles</option>
          <option value="best_ball" ${format === "best_ball" ? "selected" : ""}>best ball</option>
          <option value="alternate_shot" ${format === "alternate_shot" ? "selected" : ""}>alternate shot</option>
          <option value="scramble" ${format === "scramble" ? "selected" : ""}>scramble</option>
        </select></div>
        <div class="col"><label>Holes</label><select data-field="holes"><option value="18" ${Number(round?.holes) === 9 ? "" : "selected"}>18</option><option value="9" ${Number(round?.holes) === 9 ? "selected" : ""}>9</option></select></div>
        <div class="col" data-nine-hole-side-wrap ${Number(round?.holes) === 9 ? "" : "hidden"}><label>Nine-hole side</label><select data-field="nineHoleSide" ${Number(round?.holes) === 9 ? "" : "disabled"}><option value="" ${nineHoleSide ? "" : "selected"}>Choose front or back nine</option><option value="front" ${nineHoleSide === "front" ? "selected" : ""}>Front Nine (1–9)</option><option value="back" ${nineHoleSide === "back" ? "selected" : ""}>Back Nine (10–18)</option></select></div>
        <div class="col"><label>Handicap</label><select data-field="handicap"><option value="false" ${round?.useHandicap ? "" : "selected"}>No</option><option value="true" ${round?.useHandicap ? "selected" : ""}>Yes</option></select></div>
        <div class="col"><label>Course</label><select data-field="course">${roundCourseOptionsHtml(courseRef)}</select></div>
        <div class="col"><label>Tee</label><select data-field="tee"></select></div>
      </div>
      <div class="actions" style="margin-top:10px; justify-content:space-between;">
        <div class="small" data-format-help></div>
        <button type="button" class="secondary" data-add-match>+ Add match</button>
      </div>
      <div data-matches></div>
    `;
    matchPlayRoundsEl.appendChild(card);
    syncRoundTeeSelect(card);
    const formatEl = card.querySelector("[data-field='matchFormat']");
    const holesEl = card.querySelector("[data-field='holes']");
    const nineHoleSideEl = card.querySelector("[data-field='nineHoleSide']");
    const nineHoleSideWrap = card.querySelector("[data-nine-hole-side-wrap]");
    const handicapEl = card.querySelector("[data-field='handicap']");
    const helpEl = card.querySelector("[data-format-help]");
    const syncFormat = () => {
      const value = String(formatEl?.value || "singles");
      const allowed = value === "singles" || value === "best_ball";
      if (handicapEl) {
        handicapEl.disabled = !allowed;
        if (!allowed) handicapEl.value = "false";
      }
      if (helpEl) helpEl.textContent = value === "singles" ? "Select 1 player per side." : value === "best_ball" ? "Select 2–4 players per side." : "Select exactly 2 players per side.";
      syncMatchPlayAssignments(card);
    };
    const syncNineHoleSide = () => {
      const show = Number(holesEl?.value || 18) === 9;
      if (nineHoleSideWrap) nineHoleSideWrap.hidden = !show;
      if (nineHoleSideEl) nineHoleSideEl.disabled = !show;
    };
    formatEl?.addEventListener("change", () => {
      syncFormat();
      renderScoresEditor();
    });
    holesEl?.addEventListener("change", () => {
      syncNineHoleSide();
      renderScoresEditor();
    });
    nineHoleSideEl?.addEventListener("change", () => renderScoresEditor());
    syncFormat();
    syncNineHoleSide();
    (round?.matches || []).forEach((match, matchIndex) => appendMatchEditor(card, match, roundIndex, matchIndex, teamIds));
    syncMatchPlayAssignments(card);
    card.querySelector("[data-add-match]")?.addEventListener("click", () => {
      const usedIds = new Set([...card.querySelectorAll("[data-match-id]")].map((row) => String(row.dataset.matchId || "")));
      let nextIndex = 1;
      while (usedIds.has(`r${roundIndex + 1}m${nextIndex}`)) nextIndex += 1;
      nextIndex -= 1;
      appendMatchEditor(card, null, roundIndex, nextIndex, teamIds);
      renderScoresEditor();
    });
  });
}

function syncCompetitionEditorUi(){
  const matchMode = isMatchPlayEditor();
  if (matchPlaySettingsEl) matchPlaySettingsEl.hidden = !matchMode;
  if (strokeRoundsWrap) strokeRoundsWrap.hidden = matchMode;
  if (strokeRoundsHelp) strokeRoundsHelp.hidden = matchMode;
  if (matchPlayRoundsEl) matchPlayRoundsEl.hidden = !matchMode;
  if (scoresCard) scoresCard.hidden = false;
  if (scoringEl) {
    scoringEl.disabled = matchMode;
    if (matchMode) scoringEl.value = "stroke";
  }
}

function renderRounds(rounds) {
  const rows = Array.isArray(rounds) ? rounds : [];
  syncCompetitionEditorUi();
  if (isMatchPlayEditor()) {
    roundRows.innerHTML = "";
    renderMatchPlayRounds(rows);
    return;
  }
  roundRows.innerHTML = "";
  rows.forEach((round) => {
    const currentFmtRaw = String(round?.format || "").toLowerCase();
    const currentFmt = currentFmtRaw === "two_man" ? "two_man_scramble" : currentFmtRaw;
    const fallbackCourseIdx = Number.isInteger(Number(round?.courseIndex)) ? Number(round.courseIndex) : 0;
    const currentCourseRef = String(round?.courseRef || `tournament:${Math.max(0, fallbackCourseIdx)}`);
    const fallbackCourse = tournamentCourses[fallbackCourseIdx] || null;
    const currentTeeRef = String(round?.teeRef || fallbackCourse?.selectedTeeKey || "");
    const tr = document.createElement("tr");
    tr.dataset.teeRef = currentTeeRef;
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
      <td>
        <select data-field="maxHoleScore">
          ${roundMaxHoleScoreOptionsHtml(round?.maxHoleScore)}
        </select>
      </td>
      <td><input data-field="weight" type="number" step="0.01" min="0.01" value="${Number(round?.weight || 1)}" /></td>
      <td><input data-field="topX" type="number" step="1" min="1" max="4" value="${Number(round?.teamAggregation?.topX || 4)}" /></td>
      <td>
        <select data-field="course">
          ${roundCourseOptionsHtml(currentCourseRef)}
        </select>
      </td>
      <td>
        <select data-field="tee"></select>
      </td>
      <td><input data-field="remove" type="checkbox" /></td>
    `;
    roundRows.appendChild(tr);
    syncRoundTeeSelect(tr);
  });

  roundRows.querySelectorAll("tr").forEach((tr) => {
    const courseSelect = tr.querySelector("[data-field='course']");
    const teeSelect = tr.querySelector("[data-field='tee']");
    if (courseSelect) {
      courseSelect.addEventListener("change", () => {
        syncRoundTeeSelect(tr);
        const nextCount = Math.max(1, collectRoundsSafe().length || 1);
        renderPlayers(collectPlayersSafe(), nextCount);
        renderScoresEditor();
      });
    }
    if (teeSelect) {
      teeSelect.addEventListener("change", () => {
        tr.dataset.teeRef = String(teeSelect.value || "").trim();
      });
    }
  });

  roundRows.querySelectorAll("input,select").forEach((node) => {
    if (node.dataset.field === "course") return;
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

function collectTeamsSafe() {
  try {
    return collectTeams();
  } catch {
    return Array.isArray(currentData?.teams) ? currentData.teams.slice() : [];
  }
}

function deriveTeamsForEditor(players = [], teamDraft = []) {
  const explicitById = new Map();
  const explicitByName = new Map();
  (Array.isArray(teamDraft) ? teamDraft : []).forEach((team) => {
    const teamId = String(team?.teamId || "").trim();
    const teamName = String(team?.teamName || "").trim();
    const color = normalizeTeamColor(team?.color);
    if (teamId) explicitById.set(teamId, { teamId, teamName, color });
    if (teamName) explicitByName.set(teamName.toLowerCase(), { teamId, teamName, color });
  });

  const out = [];
  const seen = new Set();
  (Array.isArray(players) ? players : []).forEach((player) => {
    const teamName = String(player?.teamName || "").trim();
    if (!teamName) return;
    const teamId = String(player?.teamId || "").trim();
    const key = teamId || `name:${teamName.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    const explicit = (teamId && explicitById.get(teamId)) || explicitByName.get(teamName.toLowerCase()) || null;
    out.push({
      teamId,
      teamName,
      color: explicit?.color || ""
    });
  });
  return out.sort((a, b) => a.teamName.localeCompare(b.teamName));
}

function renderTeams(players, teams) {
  if (!teamRows) return;
  const rows = deriveTeamsForEditor(players, teams);
  teamRows.innerHTML = "";
  rows.forEach((team) => {
    const tr = document.createElement("tr");
    tr.dataset.teamId = String(team?.teamId || "");
    tr.dataset.teamName = String(team?.teamName || "");
    const color = normalizeTeamColor(team?.color);
    const previewColor = color || "#5A9FD0";
    tr.innerHTML = `
      <td class="left">${escapeHtml(team?.teamName || "")}</td>
      <td><input data-field="teamColor" placeholder="#1F6FEB" value="${escapeHtml(color)}" /></td>
      <td><span class="pill" style="display:inline-flex; align-items:center; gap:8px;"><span style="width:12px; height:12px; border-radius:999px; display:inline-block; background:${escapeHtml(previewColor)};"></span>${escapeHtml(color || "Auto/fallback")}</span></td>
    `;
    const colorInput = tr.querySelector("[data-field='teamColor']");
    if (colorInput) {
      colorInput.addEventListener("input", () => {
        const normalized = normalizeTeamColor(colorInput.value);
        const next = normalized || "#5A9FD0";
        const preview = tr.querySelector("[data-team-preview]");
        if (preview) preview.style.background = next;
        const label = tr.querySelector("[data-team-color-label]");
        if (label) label.textContent = normalized || "Auto/fallback";
      });
    }
    const previewCell = tr.children[2];
    if (previewCell) {
      previewCell.innerHTML = `<span class="pill" style="display:inline-flex; align-items:center; gap:8px;"><span data-team-preview style="width:12px; height:12px; border-radius:999px; display:inline-block; background:${escapeHtml(previewColor)};"></span><span data-team-color-label>${escapeHtml(color || "Auto/fallback")}</span></span>`;
    }
    teamRows.appendChild(tr);
  });
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
      renderTeams(collectPlayersSafe(), collectTeamsSafe());
      renderScoresEditor();
    });
  });
}

function collectMatchPlayRounds(){
  const teamIds = matchPlayTeamIds();
  if (teamIds.length !== 2) throw new Error("Team match play requires exactly two teams.");
  const players = collectPlayers().filter((player) => !player.remove);
  const playerById = new Map(players.map((player) => [player.playerId, player]));
  const rounds = [...matchPlayRoundsEl.querySelectorAll(":scope > .card")]
    .filter((card) => !card.querySelector("[data-remove-round]")?.checked)
    .map((card, roundIndex) => {
      const name = String(card.querySelector("[data-field='name']")?.value || "").trim() || `Round ${roundIndex + 1}`;
      const format = String(card.querySelector("[data-field='matchFormat']")?.value || "singles");
      const holes = Number(card.querySelector("[data-field='holes']")?.value || 18) === 9 ? 9 : 18;
      const nineHoleSide = String(card.querySelector("[data-field='nineHoleSide']")?.value || "");
      if (holes === 9 && !["front", "back"].includes(nineHoleSide)) {
        throw new Error(`${name}: choose Front Nine or Back Nine.`);
      }
      const useHandicap = card.querySelector("[data-field='handicap']")?.value === "true";
      if (useHandicap && format !== "singles" && format !== "best_ball") throw new Error(`${name}: handicaps are allowed only for singles and best ball.`);
      const courseRef = String(card.querySelector("[data-field='course']")?.value || "tournament:0");
      const teeRef = String(card.querySelector("[data-field='tee']")?.value || "");
      const usedPlayers = new Set();
      const usedMatchIds = new Set();
      const matches = [...card.querySelectorAll("[data-match-id]")].map((row, matchIndex) => {
        const matchId = String(row.dataset.matchId || `r${roundIndex + 1}m${matchIndex + 1}`);
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(matchId)) throw new Error(`${name}, match ${matchIndex + 1}: invalid stable match ID.`);
        if (usedMatchIds.has(matchId)) throw new Error(`${name}: duplicate match ID "${matchId}".`);
        usedMatchIds.add(matchId);
        const selectA = row.querySelector("[data-side='a']");
        const selectB = row.querySelector("[data-side='b']");
        const teamAId = String(selectA?.dataset.teamId || teamIds[0]);
        const teamBId = String(selectB?.dataset.teamId || teamIds[1]);
        if (!teamIds.includes(teamAId) || !teamIds.includes(teamBId) || teamAId === teamBId) {
          throw new Error(`${name}, ${matchId}: match sides must use the two configured teams.`);
        }
        const playerIdsA = selectedValues(selectA);
        const playerIdsB = selectedValues(selectB);
        const validateSide = (ids, teamId, label) => {
          const validCount = format === "singles" ? ids.length === 1 : format === "best_ball" ? ids.length >= 2 && ids.length <= 4 : ids.length === 2;
          if (!validCount) throw new Error(`${name}, ${matchId}: ${label} must select ${format === "singles" ? "1 player" : format === "best_ball" ? "2–4 players" : "2 players"}.`);
          for (const playerId of ids) {
            if (usedPlayers.has(playerId)) throw new Error(`${name}: a player cannot appear in more than one match.`);
            const player = playerById.get(playerId);
            if (!player || String(player.teamId || "") !== teamId) throw new Error(`${name}, ${matchId}: a selected player is not on the assigned team.`);
            usedPlayers.add(playerId);
          }
        };
        validateSide(playerIdsA, teamAId, "first side");
        validateSide(playerIdsB, teamBId, "second side");
        const points = Number(row.querySelector("[data-match-points]")?.value || matchPointsEl?.value || 1);
        if (!Number.isFinite(points) || points <= 0) throw new Error(`${name}, ${matchId}: points must be greater than zero.`);
        return {
          matchId,
          points,
          teamA: { teamId: teamAId, playerIds: playerIdsA },
          teamB: { teamId: teamBId, playerIds: playerIdsB }
        };
      });
      if (!matches.length) throw new Error(`${name} needs at least one match.`);
      return {
        name,
        format,
        holes,
        ...(holes === 9 ? { nineHoleSide } : {}),
        useHandicap,
        modelHandicapMultiplier: Number(card.dataset.modelHandicapMultiplier || 1),
        courseRef,
        teeRef,
        matches
      };
    });
  if (!rounds.length) throw new Error("At least one match-play round is required.");
  return rounds;
}

function collectRounds() {
  if (isMatchPlayEditor()) return collectMatchPlayRounds();
  const rows = [...roundRows.querySelectorAll("tr")];
  const rounds = rows
    .map((tr) => {
      const remove = tr.querySelector("[data-field='remove']")?.checked;
      if (remove) return null;
      const name = String(tr.querySelector("[data-field='name']")?.value || "").trim() || "Round";
      const format = String(tr.querySelector("[data-field='format']")?.value || "singles").trim();
      const useHandicap = tr.querySelector("[data-field='handicap']")?.value === "true";
      const maxHoleScore = parseRoundMaxHoleScoreValue(tr.querySelector("[data-field='maxHoleScore']")?.value);
      const weight = Number(tr.querySelector("[data-field='weight']")?.value || 1);
      const topX = Number(tr.querySelector("[data-field='topX']")?.value || 4);
      const courseRef = String(tr.querySelector("[data-field='course']")?.value || "tournament:0").trim();
      const teeRef = String(tr.querySelector("[data-field='tee']")?.value || "").trim();
      return {
        name,
        format,
        useHandicap,
        maxHoleScore,
        courseRef: courseRef || "tournament:0",
        teeRef,
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

function collectTeams() {
  const teams = [];
  const rows = [...teamRows.querySelectorAll("tr")];
  rows.forEach((tr) => {
    const teamName = String(tr.dataset.teamName || "").trim();
    if (!teamName) return;
    teams.push({
      ...(String(tr.dataset.teamId || "").trim() ? { teamId: String(tr.dataset.teamId || "").trim() } : {}),
      teamName,
      color: normalizeTeamColor(tr.querySelector("[data-field='teamColor']")?.value)
    });
  });
  return teams;
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
  if (isMatchPlayEditor()) {
    rounds.push({
      name: `Round ${rounds.length + 1}`,
      format: "singles",
      holes: 18,
      useHandicap: false,
      courseRef: "tournament:0",
      teeRef: "",
      matches: []
    });
    renderMatchPlayRounds(rounds);
    renderScoresEditor();
    return;
  }
  rounds.push({
    name: `Round ${rounds.length + 1}`,
    format: "singles",
    useHandicap: false,
    maxHoleScore: null,
    courseRef: "tournament:0",
    teeRef: "",
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
  renderTeams(players, collectTeamsSafe());
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
  if (scoringEl) scoringEl.value = String(data?.tournament?.scoring || "stroke").trim() || "stroke";
  if (competitionTypeEl) competitionTypeEl.value = String(data?.tournament?.competitionType || "stroke_play");
  const matchPlay = data?.matchPlay || data?.tournament?.matchPlay || {};
  if (matchPointsEl) matchPointsEl.value = String(matchPlay?.pointsPerMatch || 1);
  if (matchWinTargetEl) matchWinTargetEl.value = matchPlay?.winTarget == null ? "" : String(matchPlay.winTarget);
  syncCompetitionEditorUi();
  const course = tournamentCourses[0] || normalizeCourseForUi(data?.course || null);
  if (courseNameEl) courseNameEl.value = course.name;
  fillCourseRows(course.pars, course.strokeIndex);
  const rounds = data?.rounds || [];
  renderRounds(rounds);
  renderTeams(data?.players || [], data?.teams || []);
  renderPlayers(data?.players || [], rounds.length || 1);
  renderScoresEditor();
  if (scoresStatus) scoresStatus.textContent = "";
  loadedScoresCsvText = "";

  tidValue.textContent = currentTid;
  scoreboardLink.textContent = scoreboardUrlForTid(currentTid);
  updatedMeta.textContent = `v${data?.version || 0} • ${localDateTime(data?.updatedAt)}`;
  tidInput.value = currentTid;
  if (resetTidInput) resetTidInput.value = currentTid;
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

async function resetTournamentEditCode() {
  const tid = String(resetTidInput?.value || tidInput?.value || "").trim();
  const resetKey = String(resetKeyInput?.value || "");
  if (!tid) {
    if (resetCodeStatus) resetCodeStatus.textContent = "Tournament ID required.";
    return;
  }
  if (!resetKey) {
    if (resetCodeStatus) resetCodeStatus.textContent = "Secure reset token required.";
    return;
  }
  if (resetEditCodeBtn) resetEditCodeBtn.disabled = true;
  if (resetCodeResult) resetCodeResult.hidden = true;
  if (resetCodeStatus) resetCodeStatus.textContent = "Generating…";
  try {
    const out = await api(`/tournaments/${encodeURIComponent(tid)}/admin/reset-code`, {
      method: "POST",
      headers: { "x-edit-code-reset-key": resetKey },
      body: {}
    });
    const nextCode = normalizeCode(out?.editCode);
    if (!nextCode) throw new Error("Reset completed without a new edit code.");
    if (resetCodeOutput) resetCodeOutput.textContent = nextCode;
    if (resetCodeResult) resetCodeResult.hidden = false;
    rememberTournamentId(tid);
    rememberTournamentEditCode(tid, nextCode);
    tidInput.value = tid;
    editCodeInput.value = nextCode;
    if (resetKeyInput) resetKeyInput.value = "";
    if (resetCodeStatus) resetCodeStatus.textContent = "New code generated.";
    await loadTournament(tid, nextCode);
  } catch (e) {
    console.error(e);
    if (resetCodeStatus) resetCodeStatus.textContent = e.message || String(e);
  } finally {
    if (resetEditCodeBtn) resetEditCodeBtn.disabled = false;
  }
}

async function resolveCoursesAndRoundsForSave(roundsDraft, primaryCourse) {
  const baseCourses = tournamentCourses.length
    ? tournamentCourses.map((course) => normalizeCourseForUi(course))
    : [normalizeCourseForUi(primaryCourse)];
  baseCourses[0] = normalizeCourseForUi(primaryCourse);

  function serializeCourseForSave(course) {
    const normalized = normalizeCourseForUi(course);
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
    const normalized = normalizeCourseForUi(course);
    const selectedTee = normalized.tees.find((tee) => tee.key === teeRef)
      || normalized.tees.find((tee) => tee.key === normalized.selectedTeeKey)
      || null;
    const out = serializeCourseForSave({
      ...normalized,
      selectedTeeKey: selectedTee?.key || normalized.selectedTeeKey || ""
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

  const courses = baseCourses.map((course) => serializeCourseForSave(course));

  const refToIndex = new Map();
  courses.forEach((_, idx) => refToIndex.set(`tournament:${idx}`, idx));

  const rounds = [];
  for (const round of roundsDraft) {
    const ref = String(round?.courseRef || "tournament:0").trim() || "tournament:0";
    const teeRef = String(round?.teeRef || "").trim();
    let courseIndex = 0;

    if (ref.startsWith("saved:")) {
      const id = ref.slice("saved:".length).trim();
      if (!id) throw new Error(`Unknown course selection "${ref}".`);
      const detail = await ensureSavedCourseDetails(id);
      if (!detail || !isValidCourseShape(detail)) {
        throw new Error(`Saved course "${id}" was not found.`);
      }
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
    } else if (ref.startsWith("tournament:")) {
      const idx = Number(ref.slice("tournament:".length));
      const safeIdx = Number.isInteger(idx) && idx >= 0 && idx < baseCourses.length ? idx : 0;
      const sourceCourse = baseCourses[safeIdx] || baseCourses[0];
      if (!teeRef || !Array.isArray(sourceCourse?.tees) || !sourceCourse.tees.length || teeRef === sourceCourse.selectedTeeKey) {
        courseIndex = Number.isInteger(idx) && idx >= 0 && idx < courses.length ? idx : 0;
      } else {
        const key = `${ref}|${teeRef}`;
        if (!refToIndex.has(key)) {
          refToIndex.set(key, courses.length);
          courses.push(materializeCourseForRound(sourceCourse, teeRef));
        }
        courseIndex = refToIndex.get(key);
      }
    }

    const selectedCourse = courses[courseIndex] || courses[0] || {};
    const modelHandicapMultiplier = /\banchored\s+national\b/i.test(String(selectedCourse?.name || ""))
      ? 0.5
      : Number.isFinite(Number(round?.modelHandicapMultiplier))
        ? Number(round.modelHandicapMultiplier)
        : 1;
    rounds.push({
      ...round,
      modelHandicapMultiplier,
      courseIndex
    });
  }

  return {
    courses,
    rounds
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
    const matchMode = isMatchPlayEditor();
    const teams = collectTeams();
    const pointsPerMatch = Number(matchPointsEl?.value || 1);
    const winTargetRaw = String(matchWinTargetEl?.value || "").trim();
    const winTarget = winTargetRaw ? Number(winTargetRaw) : null;
    if (matchMode && teams.length !== 2) throw new Error("Team match play requires exactly two teams.");
    if (matchMode && (!Number.isFinite(pointsPerMatch) || pointsPerMatch <= 0)) throw new Error("Default points per match must be greater than zero.");
    if (matchMode && winTargetRaw && (!Number.isFinite(winTarget) || winTarget <= 0)) throw new Error("Points to win must be greater than zero.");
    const payload = {
      editCode: currentEditCode,
      competitionType: matchMode ? "team_match_play" : "stroke_play",
      tournament: {
        name: String(nameEl.value || "").trim(),
        dates: String(datesEl.value || "").trim(),
        scoring: matchMode ? "stroke" : (String(scoringEl?.value || "stroke").trim() || "stroke"),
        competitionType: matchMode ? "team_match_play" : "stroke_play"
      },
      ...(matchMode ? {
        matchPlay: {
          teamIds: teams.map((team) => team.teamId),
          pointsPerMatch,
          ...(winTarget != null ? { winTarget } : {})
        }
      } : {}),
      course: courses[0],
      courses,
      rounds,
      teams,
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

function undoScoresInTable() {
  if (!scoresEditorWrap) return;
  const inputs = [...scoresEditorWrap.querySelectorAll("input[data-score-hole]")];
  inputs.forEach((input) => { input.value = ""; });
  if (scoresStatus) {
    scoresStatus.textContent = inputs.length
      ? "Scores cleared from the table. Click Save changes to apply the undo."
      : "No score cells are available to clear.";
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
resetEditCodeBtn?.addEventListener("click", resetTournamentEditCode);
tidInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadTournament(tidInput.value, editCodeInput.value);
});
editCodeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadTournament(tidInput.value, editCodeInput.value);
});
addRoundBtn.addEventListener("click", addRoundRow);
competitionTypeEl?.addEventListener("change", () => {
  syncCompetitionEditorUi();
  renderRounds(Array.isArray(currentData?.rounds) ? currentData.rounds : []);
  renderScoresEditor();
});
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
if (undoScoresBtn) undoScoresBtn.addEventListener("click", undoScoresInTable);
if (scoresEditorWrap) scoresEditorWrap.addEventListener("paste", handleScoresEditorPaste);

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
