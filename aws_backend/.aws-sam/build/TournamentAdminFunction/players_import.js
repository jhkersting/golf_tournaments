import {
  json,
  parseBody,
  requireAdmin,
  requireTournamentEditCode,
  uid,
  code4,
  updateStateWithRetry,
  writePublicObjectsFromState
} from "./utils.js";

function parseDelimited(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return [];

  const delim = lines[0].includes("\t") ? "\t" : ",";
  const rows = lines.map((line) => line.split(delim).map((cell) => cell.trim()));
  const header = rows[0].map((v) => v.toLowerCase().replace(/[\s_-]+/g, ""));
  const hasHeader = header.includes("name") && header.includes("team");
  const start = hasHeader ? 1 : 0;

  function readByHeader(cols, keys, fallbackIdx) {
    for (const key of keys) {
      const idx = header.indexOf(key);
      if (idx >= 0) return cols[idx] ?? "";
    }
    return cols[fallbackIdx] ?? "";
  }

  function readByPrefix(cols, prefixes) {
    for (let idx = 0; idx < header.length; idx++) {
      const h = header[idx];
      for (const prefix of prefixes) {
        if (h.startsWith(prefix)) return cols[idx] ?? "";
      }
    }
    return "";
  }

  const teeTimeColumns = [];
  const groupColumns = [];
  if (hasHeader) {
    for (let idx = 0; idx < header.length; idx++) {
      const h = header[idx];
      if (!h.startsWith("teetime") && !h.startsWith("tee")) continue;
      const m = h.match(/(\d+)$/);
      const round = m ? Math.max(1, Number(m[1])) : 1;
      teeTimeColumns.push({ idx, roundIndex: round - 1 });
    }
    teeTimeColumns.sort((a, b) => a.roundIndex - b.roundIndex || a.idx - b.idx);
    for (let idx = 0; idx < header.length; idx++) {
      const h = header[idx];
      if (!h.startsWith("group")) continue;
      const m = h.match(/(\d+)$/);
      const round = m ? Math.max(1, Number(m[1])) : 1;
      groupColumns.push({ idx, roundIndex: round - 1 });
    }
    groupColumns.sort((a, b) => a.roundIndex - b.roundIndex || a.idx - b.idx);
  }

  return rows
    .slice(start)
    .map((cols) => {
      const teeTimes = [];
      for (const col of teeTimeColumns) {
        const raw = cols[col.idx] ?? "";
        if (raw !== "") teeTimes[col.roundIndex] = raw;
      }
      const fallbackTee =
        readByHeader(cols, ["teetime", "tee"], 5) || readByPrefix(cols, ["teetime", "tee"]);
      if (fallbackTee && !teeTimes[0]) teeTimes[0] = fallbackTee;
      const groups = [];
      for (const col of groupColumns) {
        const raw = cols[col.idx] ?? "";
        if (raw !== "") groups[col.roundIndex] = raw;
      }
      const fallbackGroup = readByHeader(cols, ["group"], 3) || readByPrefix(cols, ["group"]);
      if (fallbackGroup && !groups[0]) groups[0] = fallbackGroup;

      return {
        name: readByHeader(cols, ["name", "player", "golfer"], 0),
        team: readByHeader(cols, ["team"], 1),
        handicap: readByHeader(cols, ["handicap", "hcp"], 2) || "0",
        group: readByHeader(cols, ["group"], 3),
        groups,
        code: readByHeader(cols, ["code"], 4),
        teeTimes
      };
    })
    .filter((row) => row.name && row.team);
}

function normalizeGroup(groupValue) {
  const out = String(groupValue || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return out ? out.slice(0, 16) : null;
}

function normalizeCode(code) {
  const out = String(code || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  if (!out) return "";
  if (!/^[A-Z0-9]{4,8}$/.test(out)) return "";
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

function parseTimeToMinutes(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*([AP]M)?$/i);
  if (!m) return null;

  let hour = Number(m[1]);
  const mins = Number(m[2] || 0);
  if (!Number.isInteger(hour) || !Number.isInteger(mins) || mins < 0 || mins > 59) return null;

  const ampm = String(m[3] || "").toUpperCase();
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (hour === 12) hour = 0;
    if (ampm === "PM") hour += 12;
  }
  if (hour < 0 || hour > 23) return null;
  return hour * 60 + mins;
}

function formatTimeFromMinutes(total) {
  const minsInDay = 24 * 60;
  const norm = ((Math.floor(Number(total) || 0) % minsInDay) + minsInDay) % minsInDay;
  const h24 = Math.floor(norm / 60);
  const mm = norm % 60;
  const ampm = h24 >= 12 ? "PM" : "AM";
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${ampm}`;
}

function normalizedTeeTimes(raw, roundCount) {
  const out = Array.from({ length: roundCount }, () => null);
  const vals = Array.isArray(raw) ? raw : [];
  for (let i = 0; i < roundCount; i++) {
    const s = String(vals[i] || "").trim();
    out[i] = s || null;
  }
  return out;
}

function normalizedGroups(raw, roundCount, fallback = null) {
  const out = Array.from({ length: roundCount }, () => null);
  const vals = Array.isArray(raw) ? raw : [];
  for (let i = 0; i < roundCount; i++) {
    out[i] = normalizeGroup(vals[i]);
  }
  if (!out[0] && fallback != null) out[0] = normalizeGroup(fallback);
  return out;
}

function isTwoManTournament(rounds) {
  return Array.isArray(rounds) && rounds.some((r) => {
    const fmt = String(r?.format || "").toLowerCase();
    return fmt === "two_man" || fmt === "two_man_best_ball";
  });
}

function readEditCode(event, body = null) {
  const q = event?.queryStringParameters || {};
  const h = event?.headers || {};
  return String(
    body?.editCode ??
      body?.accessCode ??
      q?.code ??
      q?.editCode ??
      h?.["x-edit-code"] ??
      h?.["X-Edit-Code"] ??
      ""
  ).trim();
}

function csvCell(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function assignMissingTwoManGroups(playersById, teamIds, roundCount) {
  const count = Math.max(1, Math.floor(Number(roundCount) || 1));
  for (const teamId of teamIds) {
    const pids = Object.keys(playersById).filter((pid) => playersById[pid]?.teamId === teamId);
    const ordered = pids.slice().sort((a, b) =>
      String(playersById[a]?.name || "").localeCompare(String(playersById[b]?.name || ""))
    );
    for (let r = 0; r < count; r++) {
      const used = new Set(
        ordered
          .map((pid) => normalizeGroup(playersById[pid]?.groups?.[r]))
          .filter(Boolean)
      );
      let nextIdx = 0;
      function nextLabel() {
        while (used.has(groupLabelFromIndex(nextIdx))) nextIdx++;
        const label = groupLabelFromIndex(nextIdx);
        used.add(label);
        nextIdx++;
        return label;
      }
      const missing = ordered.filter((pid) => !normalizeGroup(playersById[pid]?.groups?.[r]));
      for (let i = 0; i < missing.length; i += 2) {
        const label = nextLabel();
        playersById[missing[i]].groups[r] = label;
        if (missing[i + 1]) playersById[missing[i + 1]].groups[r] = label;
      }
    }
  }
}

export async function handler(event) {
  try {
    requireAdmin(event);
    const tid = event.pathParameters?.tid;
    if (!tid) return json(400, { error: "missing tid" });

    const body = await parseBody(event);
    const csvText = body.csvText || "";
    const baseUrl = String(body.baseUrl || "").replace(/\/+$/, "");
    const providedEditCode = readEditCode(event, body);

    const rows = parseDelimited(csvText);
    if (!rows.length) {
      return json(400, { error: "No rows found. Expect columns: name, team, handicap" });
    }

    let downloadCsv = "";
    let importedCount = 0;
    const updated = await updateStateWithRetry(tid, (current) => {
      if (!current) {
        const err = new Error("tournament not found");
        err.statusCode = 404;
        throw err;
      }

      current.teams = current.teams || {};
      current.players = current.players || {};
      current.codeIndex = current.codeIndex || {};
      current.scores = current.scores || {
        rounds: (current.rounds || []).map(() => ({ teams: {}, players: {} }))
      };

      requireTournamentEditCode(current, providedEditCode);

      const needsTwoManGroups = isTwoManTournament(current.rounds);
      const roundCount = Math.max(1, (current.rounds || []).length);
      const teeHeaders = Array.from({ length: roundCount }, (_, i) => `teeTimeR${i + 1}`);
      const groupHeaders = Array.from({ length: roundCount }, (_, i) => `groupR${i + 1}`);
      const outLines = [
        ["name", "team", "handicap", ...teeHeaders, ...groupHeaders, "group", "code", "enterUrl"].join(",")
      ];

      const teamIdByName = new Map();
      for (const teamId of Object.keys(current.teams || {})) {
        const key = String(current.teams[teamId]?.teamName || "")
          .trim()
          .toLowerCase();
        if (key && !teamIdByName.has(key)) teamIdByName.set(key, teamId);
      }

      const existingCodes = new Set(Object.keys(current.codeIndex || {}));
      const createdRows = [];

      for (const row of rows) {
        const teamName = String(row.team || "").trim();
        const playerName = String(row.name || "").trim();
        const handicap = Number(row.handicap || 0);
        const teeTimes = normalizedTeeTimes(row.teeTimes, roundCount);
        const groups = normalizedGroups(row.groups, roundCount, row.group);
        const requestedCode = normalizeCode(row.code);

        if (!teamName || !playerName) continue;

        const teamKey = teamName.toLowerCase();
        let teamId = teamIdByName.get(teamKey);
        if (!teamId) {
          teamId = uid("tm");
          current.teams[teamId] = { teamId, teamName };
          teamIdByName.set(teamKey, teamId);
        }

        const playerId = uid("p");
        let code = requestedCode || code4();
        let guard = 0;
        while (existingCodes.has(code) && guard++ < 80) code = code4();
        existingCodes.add(code);

        current.players[playerId] = {
          playerId,
          name: playerName,
          teamId,
          handicap: Number.isFinite(handicap) ? handicap : 0,
          code,
          teeTimes: teeTimes.slice(),
          teeTime: teeTimes.find((v) => !!v) || null,
          groups,
          group: groups[0] || null
        };
        current.codeIndex[code] = playerId;

        const enterUrl = baseUrl ? `${baseUrl}/enter.html?code=${encodeURIComponent(code)}` : "";
        createdRows.push({ playerId, playerName, teamName, handicap, code, enterUrl });
      }

      const startMinutes = parseTimeToMinutes(body?.teeStart) ?? 8 * 60;
      const teeInterval = Math.max(1, Math.min(60, Math.floor(Number(body?.teeIntervalMin) || 10)));
      const teamIdsByName = Object.keys(current.teams || {}).sort((a, b) =>
        String(current.teams[a]?.teamName || a).localeCompare(String(current.teams[b]?.teamName || b))
      );
      const teamTeeById = new Map(
        teamIdsByName.map((teamId, idx) => [teamId, formatTimeFromMinutes(startMinutes + idx * teeInterval)])
      );

      for (const playerId of Object.keys(current.players || {})) {
        const player = current.players[playerId];
        const teamDefault = teamTeeById.get(player?.teamId) || null;
        const vals = normalizedTeeTimes(player?.teeTimes, roundCount);
        const firstKnown = vals.find((v) => !!v) || teamDefault || null;
        for (let i = 0; i < vals.length; i++) {
          if (!vals[i] && firstKnown) vals[i] = firstKnown;
        }
        player.teeTimes = vals;
        player.teeTime = vals.find((v) => !!v) || null;
        const gvals = normalizedGroups(player?.groups, roundCount, player?.group);
        player.groups = gvals;
        player.group = gvals[0] || null;
      }

      if (needsTwoManGroups) {
        assignMissingTwoManGroups(current.players, Object.keys(current.teams || {}), roundCount);
        for (const pid of Object.keys(current.players || {})) {
          current.players[pid].group = current.players[pid]?.groups?.[0] || null;
        }
      }

      for (const row of createdRows) {
        const player = current.players[row.playerId] || {};
        const groupVals = normalizedGroups(player.groups, roundCount, player.group);
        const group = String(groupVals[0] || "");
        const teeVals = normalizedTeeTimes(player.teeTimes, roundCount);
        outLines.push(
          [
            row.playerName,
            row.teamName,
            row.handicap,
            ...teeVals.map((v) => v || ""),
            ...groupVals.map((v) => v || ""),
            group,
            row.code,
            row.enterUrl
          ]
            .map((v) => csvCell(v))
            .join(",")
        );
      }

      importedCount = createdRows.length;
      downloadCsv = outLines.join("\n");
      current.updatedAt = Date.now();
      current.version = Number(current.version || 0) + 1;
      return current;
    });

    await writePublicObjectsFromState(updated);
    return json(200, { count: importedCount, downloadCsv });
  } catch (e) {
    return json(e.statusCode || 500, { error: e.message || "Server error" });
  }
}
