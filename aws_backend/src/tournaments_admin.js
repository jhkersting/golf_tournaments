import {
  json,
  parseBody,
  requireAdmin,
  uid,
  code4,
  normalizeHoles,
  getJson,
  putJson,
  requireTournamentEditCode,
  updateStateWithRetry,
  appendEvent,
  writePublicObjectsFromState
} from "./utils.js";

function normalizeRoundFormat(format) {
  const raw = String(format || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (raw === "scramble") return "scramble";
  if (raw === "team_best_ball" || raw === "team_bestball") return "team_best_ball";
  if (raw === "shamble") return "shamble";
  if (raw === "singles") return "singles";
  if (
    raw === "two_man_best_ball" ||
    raw === "two_man_scramble" ||
    raw === "two_man" ||
    raw === "2_man" ||
    raw === "2man" ||
    raw === "best_ball" ||
    raw === "2man_best_ball" ||
    raw === "2_man_best_ball"
  ) {
    return "two_man";
  }
  return "singles";
}

function normalizeRoundWeight(weight) {
  if (weight === null || weight === undefined) return null;
  if (typeof weight === "string" && weight.trim() === "") return null;
  const n = Number(weight);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function normalizeAgg(agg) {
  let topX = Number(agg?.topX ?? 4);
  if (!Number.isFinite(topX) || topX <= 0) topX = 4;
  topX = Math.round(topX);
  return { mode: "avg", topX };
}

function validateCourse(course) {
  const pars = course?.pars;
  const strokeIndex = course?.strokeIndex;
  if (!Array.isArray(pars) || pars.length !== 18) {
    return "course.pars must be an array of length 18";
  }
  if (!Array.isArray(strokeIndex) || strokeIndex.length !== 18) {
    return "course.strokeIndex must be an array of length 18";
  }
  for (const p of pars) {
    if (!Number.isFinite(Number(p))) return "All pars must be numbers";
  }
  const si = strokeIndex.map(Number);
  const set = new Set(si);
  if (set.size !== 18) return "Stroke Index must contain 18 unique values";
  for (const v of si) {
    if (!Number.isInteger(v) || v < 1 || v > 18) {
      return "Stroke Index values must be integers 1..18";
    }
  }
  return null;
}

function normalizeCourseForState(course) {
  const out = {
    pars: course.pars.map(Number),
    strokeIndex: course.strokeIndex.map(Number)
  };
  const name = String(course?.name || "").trim();
  if (name) out.name = name.slice(0, 120);
  return out;
}

function defaultCourse() {
  return {
    pars: Array(18).fill(4),
    strokeIndex: Array.from({ length: 18 }, (_, i) => i + 1)
  };
}

function normalizeRoundCourseIndex(value, courseCount) {
  const n = Number(value);
  const count = Math.max(1, Number(courseCount) || 1);
  if (!Number.isInteger(n) || n < 0 || n >= count) return 0;
  return n;
}

function normalizeCoursesForState(state) {
  const fromArray = Array.isArray(state?.courses) ? state.courses : [];
  const validFromArray = [];
  for (const course of fromArray) {
    if (validateCourse(course)) continue;
    validFromArray.push(normalizeCourseForState(course));
  }
  if (validFromArray.length) return validFromArray;

  const legacyErr = validateCourse(state?.course);
  if (!legacyErr) return [normalizeCourseForState(state.course)];

  return [defaultCourse()];
}

function normalizeGroup(group) {
  const g = String(group || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return g ? g.slice(0, 16) : null;
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

function normalizeTeeTime(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  return s.slice(0, 48);
}

function normalizeTeeTimes(value, roundCount, fallbackValue = null) {
  const count = Math.max(0, Math.floor(Number(roundCount) || 0));
  const out = Array(count).fill(null);

  if (Array.isArray(value)) {
    for (let i = 0; i < count; i++) {
      out[i] = normalizeTeeTime(value[i]);
    }
    return out;
  }

  if (value && typeof value === "object") {
    for (let i = 0; i < count; i++) {
      out[i] = normalizeTeeTime(value[i] ?? value[String(i)]);
    }
    return out;
  }

  if (fallbackValue != null && count > 0) {
    out[0] = normalizeTeeTime(fallbackValue);
  }
  return out;
}

function normalizeHandicap(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const bounded = Math.max(-30, Math.min(72, n));
  return Number(bounded.toFixed(1));
}

function normalizeCode(raw) {
  const code = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  if (!code) return "";
  if (!/^[A-Z0-9]{4,8}$/.test(code)) {
    const err = new Error(`Invalid code "${raw}". Use 4-8 letters/numbers.`);
    err.statusCode = 400;
    throw err;
  }
  return code;
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

function isTwoManTournament(rounds) {
  return Array.isArray(rounds) && rounds.some((r) => {
    const fmt = String(r?.format || "").toLowerCase();
    return fmt === "two_man" || fmt === "two_man_best_ball";
  });
}

function normalizeGroups(value, roundCount, fallbackGroup = null) {
  const count = Math.max(0, Math.floor(Number(roundCount) || 0));
  const out = Array(count).fill(null);
  if (Array.isArray(value)) {
    for (let i = 0; i < count; i++) out[i] = normalizeGroup(value[i]);
    return out;
  }
  if (value && typeof value === "object") {
    for (let i = 0; i < count; i++) out[i] = normalizeGroup(value[i] ?? value[String(i)]);
    return out;
  }
  if (count > 0) out[0] = normalizeGroup(fallbackGroup);
  return out;
}

function roundFormat(round) {
  return normalizeRoundFormat(round?.format);
}

function scoreTargetTypeForRound(round) {
  const fmt = roundFormat(round);
  if (fmt === "scramble") return "team";
  if (fmt === "two_man") return "group";
  return "player";
}

function groupId(teamId, groupLabel) {
  const team = String(teamId || "").trim();
  const group = normalizeGroup(groupLabel);
  if (!team || !group) return "";
  return `${team}::${group}`;
}

function groupForPlayerRound(player, roundIndex) {
  const idx = Math.max(0, Math.floor(Number(roundIndex) || 0));
  if (Array.isArray(player?.groups)) {
    const g = normalizeGroup(player.groups[idx]);
    if (g) return g;
  }
  if (idx === 0) return normalizeGroup(player?.group);
  return null;
}

function buildValidGroupIdsByRound(playersById, rounds) {
  const roundCount = Math.max(0, Number(rounds?.length || 0));
  const sets = Array.from({ length: roundCount }, () => new Set());
  for (let r = 0; r < roundCount; r++) {
    if (scoreTargetTypeForRound(rounds[r]) !== "group") continue;
    for (const player of Object.values(playersById || {})) {
      const gid = groupId(player?.teamId, groupForPlayerRound(player, r));
      if (gid) sets[r].add(gid);
    }
  }
  return sets;
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

function normalizeScoreEntryHoles(entry) {
  const holesRaw = Array.isArray(entry) ? entry : entry?.holes;
  if (!Array.isArray(holesRaw)) {
    const err = new Error("scores entries must include holes arrays of length 18");
    err.statusCode = 400;
    throw err;
  }
  return normalizeHoles(holesRaw);
}

function normalizeScoresForState(scoresIn, roundCount, validTeamIds, validPlayerIds, validGroupIdsByRound) {
  if (!scoresIn || typeof scoresIn !== "object") {
    const err = new Error("scores must be an object");
    err.statusCode = 400;
    throw err;
  }
  const inRounds = Array.isArray(scoresIn.rounds) ? scoresIn.rounds : [];
  const out = { rounds: [] };

  for (let r = 0; r < roundCount; r++) {
    const srcRound = inRounds[r] || {};
    const outRound = { teams: {}, players: {}, groups: {} };

    for (const [teamId, entry] of Object.entries(srcRound?.teams || {})) {
      if (!validTeamIds.has(teamId)) continue;
      outRound.teams[teamId] = { holes: normalizeScoreEntryHoles(entry), meta: Array(18).fill(null) };
    }
    for (const [playerId, entry] of Object.entries(srcRound?.players || {})) {
      if (!validPlayerIds.has(playerId)) continue;
      outRound.players[playerId] = { holes: normalizeScoreEntryHoles(entry), meta: Array(18).fill(null) };
    }
    const allowedGroupIds = validGroupIdsByRound?.[r] || new Set();
    for (const [gid, entry] of Object.entries(srcRound?.groups || {})) {
      if (!allowedGroupIds.has(gid)) continue;
      outRound.groups[gid] = { holes: normalizeScoreEntryHoles(entry), meta: Array(18).fill(null) };
    }

    out.rounds.push(outRound);
  }

  return out;
}

function projectScoresForAdmin(scores, roundCount) {
  const sourceRounds = Array.isArray(scores?.rounds) ? scores.rounds : [];
  const out = { rounds: [] };
  for (let r = 0; r < roundCount; r++) {
    const sourceRound = sourceRounds[r] || {};
    const outRound = { teams: {}, players: {}, groups: {} };
    for (const [teamId, entry] of Object.entries(sourceRound?.teams || {})) {
      outRound.teams[teamId] = { holes: safeHoleArray(entry?.holes || entry) };
    }
    for (const [playerId, entry] of Object.entries(sourceRound?.players || {})) {
      outRound.players[playerId] = { holes: safeHoleArray(entry?.holes || entry) };
    }
    for (const [gid, entry] of Object.entries(sourceRound?.groups || {})) {
      outRound.groups[gid] = { holes: safeHoleArray(entry?.holes || entry) };
    }
    out.rounds.push(outRound);
  }
  return out;
}

function applyAutoTwoManGroups(playersById, roundCount) {
  const byTeam = new Map();
  for (const playerId of Object.keys(playersById || {})) {
    const player = playersById[playerId];
    if (!player?.teamId) continue;
    if (!byTeam.has(player.teamId)) byTeam.set(player.teamId, []);
    byTeam.get(player.teamId).push(playerId);
  }

  for (const teamIds of byTeam.values()) {
    teamIds.sort((a, b) => {
      const pa = playersById[a];
      const pb = playersById[b];
      return String(pa?.name || "").localeCompare(String(pb?.name || ""));
    });
    for (let i = 0; i < teamIds.length; i++) {
      const pid = teamIds[i];
      const label = groupLabelFromIndex(Math.floor(i / 2));
      const groups = normalizeGroups(playersById[pid]?.groups, roundCount, playersById[pid]?.group);
      for (let r = 0; r < groups.length; r++) groups[r] = label;
      playersById[pid].groups = groups;
      playersById[pid].group = groups[0] || null;
    }
  }
}

function normalizeRoundsOrThrow(roundsIn, existingRounds, courseCount = 1) {
  const raw = Array.isArray(roundsIn) ? roundsIn : existingRounds || [];
  if (!Array.isArray(raw) || raw.length === 0) {
    const err = new Error("At least one round is required.");
    err.statusCode = 400;
    throw err;
  }

  const base = raw.map((round, idx) => {
    const existing = existingRounds?.[idx] || {};
    return {
      name: String(round?.name || existing?.name || "Round").trim() || "Round",
      format: normalizeRoundFormat(round?.format || existing?.format),
      useHandicap:
        round?.useHandicap !== undefined ? !!round.useHandicap : !!existing?.useHandicap,
      weight: normalizeRoundWeight(round?.weight ?? existing?.weight),
      courseIndex: normalizeRoundCourseIndex(round?.courseIndex ?? existing?.courseIndex, courseCount),
      teamAggregation: normalizeAgg(round?.teamAggregation || existing?.teamAggregation)
    };
  });

  const allMissingWeight = base.length > 0 && base.every((round) => round.weight == null);
  return base.map((round) => ({
    ...round,
    weight: allMissingWeight ? 1 : round.weight == null ? 1 : round.weight
  }));
}

function ensureUniqueCodes(playersById, { regenerateAll = false } = {}) {
  const usedCodes = new Set();
  const codeIndex = {};

  for (const playerId of Object.keys(playersById || {})) {
    const player = playersById[playerId];
    let code = regenerateAll ? "" : normalizeCode(player?.code);
    if (!code) {
      let next = code4();
      let guard = 0;
      while (usedCodes.has(next) && guard++ < 80) next = code4();
      code = next;
    }
    if (usedCodes.has(code)) {
      const err = new Error(`Duplicate code "${code}"`);
      err.statusCode = 400;
      throw err;
    }
    usedCodes.add(code);
    player.code = code;
    codeIndex[code] = playerId;
  }

  return codeIndex;
}

function createTeamResolver(nextTeams) {
  const names = new Map();
  for (const teamId of Object.keys(nextTeams || {})) {
    const key = String(nextTeams[teamId]?.teamName || "")
      .trim()
      .toLowerCase();
    if (key && !names.has(key)) names.set(key, teamId);
  }

  function upsertTeam(teamIdMaybe, teamNameMaybe) {
    const teamIdRaw = String(teamIdMaybe || "").trim();
    const teamNameRaw = String(teamNameMaybe || "").trim();
    const name = teamNameRaw || "Team";
    const nameKey = name.toLowerCase();

    if (teamIdRaw && nextTeams[teamIdRaw]) {
      nextTeams[teamIdRaw].teamName = name;
      names.set(nameKey, teamIdRaw);
      return teamIdRaw;
    }

    if (nameKey && names.has(nameKey)) {
      const existingId = names.get(nameKey);
      if (nextTeams[existingId]) {
        nextTeams[existingId].teamName = name;
      }
      return existingId;
    }

    const newTeamId = teamIdRaw || uid("tm");
    nextTeams[newTeamId] = { teamId: newTeamId, teamName: name };
    names.set(nameKey, newTeamId);
    return newTeamId;
  }

  return { upsertTeam };
}

function normalizePlayerPayload(payload, existingPlayer, roundCount) {
  const name = String(payload?.name ?? existingPlayer?.name ?? "")
    .trim()
    .slice(0, 80);
  if (!name) return null;

  const baseTeeTimes = normalizeTeeTimes(
    existingPlayer?.teeTimes,
    roundCount,
    existingPlayer?.teeTime ?? null
  );
  let teeTimes = baseTeeTimes.slice();
  if (payload?.teeTimes !== undefined) {
    teeTimes = normalizeTeeTimes(payload?.teeTimes, roundCount, null);
  } else if (payload?.teeTime !== undefined) {
    teeTimes = normalizeTeeTimes(null, roundCount, payload?.teeTime ?? null);
  }

  const baseGroups = normalizeGroups(
    existingPlayer?.groups,
    roundCount,
    existingPlayer?.group ?? null
  );
  let groups = baseGroups.slice();
  if (payload?.groups !== undefined) {
    groups = normalizeGroups(payload?.groups, roundCount, null);
  } else if (payload?.group !== undefined) {
    groups = normalizeGroups(null, roundCount, payload?.group ?? null);
  }

  return {
    name,
    handicap: normalizeHandicap(payload?.handicap ?? existingPlayer?.handicap ?? 0),
    group: groups[0] || null,
    groups,
    teeTimes,
    code: normalizeCode(payload?.code ?? existingPlayer?.code ?? "")
  };
}

function cleanupScores(scores, validTeamIds, validPlayerIds, roundCount, validGroupIdsByRound) {
  const clean = scores || { rounds: [] };
  clean.rounds = Array.isArray(clean.rounds) ? clean.rounds : [];

  while (clean.rounds.length < roundCount) clean.rounds.push({ teams: {}, players: {}, groups: {} });
  if (clean.rounds.length > roundCount) clean.rounds = clean.rounds.slice(0, roundCount);

  for (let r = 0; r < clean.rounds.length; r++) {
    const round = clean.rounds[r];
    round.teams = round.teams || {};
    round.players = round.players || {};
    round.groups = round.groups || {};
    const allowedGroupIds = validGroupIdsByRound?.[r] || new Set();
    for (const teamId of Object.keys(round.teams)) {
      if (!validTeamIds.has(teamId)) delete round.teams[teamId];
    }
    for (const playerId of Object.keys(round.players)) {
      if (!validPlayerIds.has(playerId)) delete round.players[playerId];
    }
    for (const gid of Object.keys(round.groups)) {
      if (!allowedGroupIds.has(gid)) delete round.groups[gid];
    }
  }
  return clean;
}

function toAdminPayload(state) {
  const teams = state?.teams || {};
  const players = state?.players || {};
  const roundCount = (state?.rounds || []).length;
  const courses = normalizeCoursesForState(state);

  const teamRows = Object.keys(teams)
    .map((teamId) => ({
      teamId,
      teamName: teams[teamId]?.teamName || teamId
    }))
    .sort((a, b) => a.teamName.localeCompare(b.teamName));

  const playerRows = Object.keys(players)
    .map((playerId) => {
      const player = players[playerId] || {};
      const team = teams[player.teamId] || {};
      return {
        playerId,
        name: player.name || "",
        teamId: player.teamId || "",
        teamName: team.teamName || "",
        handicap: Number(player.handicap || 0),
        teeTimes: normalizeTeeTimes(player.teeTimes, roundCount, player.teeTime || null),
        groups: normalizeGroups(player.groups, roundCount, player.group || null),
        group: player.group || null,
        code: player.code || ""
      };
    })
    .sort((a, b) => {
      const tc = String(a.teamName || "").localeCompare(String(b.teamName || ""));
      if (tc !== 0) return tc;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });

  return {
    tournament: {
      tournamentId: state?.tournament?.tournamentId,
      name: state?.tournament?.name || "",
      dates: state?.tournament?.dates || "",
      rounds: state?.rounds || []
    },
    rounds: state?.rounds || [],
    course: courses[0] || null,
    courses,
    scores: projectScoresForAdmin(state?.scores, roundCount),
    teams: teamRows,
    players: playerRows,
    hasTwoManBestBall: isTwoManTournament(state?.rounds || []),
    requiresEditCode: !!state?.tournament?.editCodeHash,
    updatedAt: state?.updatedAt || 0,
    version: state?.version || 0
  };
}

export async function handler(event) {
  try {
    const method = String(event?.requestContext?.http?.method || event?.httpMethod || "")
      .toUpperCase();
    const tid = String(event?.pathParameters?.tid || "").trim();
    if (!tid) return json(400, { error: "missing tid" });

    if (method === "GET") {
      requireAdmin(event);
      const bucket = process.env.STATE_BUCKET;
      const { json: current } = await getJson(bucket, `state/${tid}.json`);
      if (!current) return json(404, { error: "tournament not found" });
      requireTournamentEditCode(current, readEditCode(event));
      return json(200, toAdminPayload(current));
    }

    if (method !== "POST") {
      return json(405, { error: "Method not allowed" }, { Allow: "GET,POST,OPTIONS" });
    }

    requireAdmin(event);
    const body = await parseBody(event);
    const providedEditCode = readEditCode(event, body);
    const options = body?.options || {};
    const now = Date.now();
    let retiredCodes = [];

    const updated = await updateStateWithRetry(tid, (current) => {
      if (!current) {
        const err = new Error("tournament not found");
        err.statusCode = 404;
        throw err;
      }

      current.tournament = current.tournament || {};
      current.rounds = current.rounds || [];
      current.teams = current.teams || {};
      current.players = current.players || {};
      requireTournamentEditCode(current, providedEditCode);

      current.courses = normalizeCoursesForState(current);
      current.course = current.courses[0];
      if (body?.courses !== undefined) {
        if (!Array.isArray(body.courses) || body.courses.length === 0) {
          const err = new Error("At least one course is required.");
          err.statusCode = 400;
          throw err;
        }
        const normalized = [];
        for (let idx = 0; idx < body.courses.length; idx++) {
          const nextCourseErr = validateCourse(body.courses[idx]);
          if (nextCourseErr) {
            const err = new Error(`courses[${idx}]: ${nextCourseErr}`);
            err.statusCode = 400;
            throw err;
          }
          normalized.push(normalizeCourseForState(body.courses[idx]));
        }
        current.courses = normalized;
      } else if (body?.course !== undefined) {
        const nextCourseErr = validateCourse(body.course);
        if (nextCourseErr) {
          const err = new Error(nextCourseErr);
          err.statusCode = 400;
          throw err;
        }
        const normalizedFirst = normalizeCourseForState(body.course);
        const rest = current.courses.slice(1);
        current.courses = [normalizedFirst, ...rest];
      }
      current.course = current.courses[0];

      const previousCodes = new Set(
        Object.keys(current.codeIndex || {}).concat(
          Object.values(current.players || {}).map((p) => String(p?.code || "").trim()).filter(Boolean)
        )
      );

      const name = String(body?.tournament?.name ?? body?.name ?? current.tournament.name ?? "")
        .trim();
      const dates = String(body?.tournament?.dates ?? body?.dates ?? current.tournament.dates ?? "")
        .trim();
      current.tournament.name = name || current.tournament.name || "Tournament";
      current.tournament.dates = dates;

      current.rounds = normalizeRoundsOrThrow(body?.rounds, current.rounds, current.courses.length);

      const nextTeams = {};
      for (const teamId of Object.keys(current.teams || {})) {
        const team = current.teams[teamId] || {};
        nextTeams[teamId] = {
          teamId,
          teamName: String(team.teamName || teamId).trim() || teamId
        };
      }

      const resolver = createTeamResolver(nextTeams);

      if (Array.isArray(body?.teams)) {
        for (const patch of body.teams) {
          if (!patch || patch.remove) continue;
          resolver.upsertTeam(patch.teamId, patch.teamName);
        }
      }

      const nextPlayers = {};
      const roundCount = current.rounds.length;
      const incomingPlayers = Array.isArray(body?.players) ? body.players : null;
      if (incomingPlayers) {
        for (const row of incomingPlayers) {
          if (!row || row.remove) continue;

          const rowPlayerId = String(row.playerId || "").trim();
          const existingPlayer = rowPlayerId ? current.players[rowPlayerId] : null;
          const normalizedPlayer = normalizePlayerPayload(row, existingPlayer, roundCount);
          if (!normalizedPlayer) continue;

          const teamId = resolver.upsertTeam(
            row.teamId || existingPlayer?.teamId,
            row.teamName || row.team || nextTeams[row.teamId]?.teamName || ""
          );

          const playerId = existingPlayer ? rowPlayerId : uid("p");
          nextPlayers[playerId] = {
            playerId,
            name: normalizedPlayer.name,
            teamId,
            handicap: normalizedPlayer.handicap,
            code: normalizedPlayer.code,
            group: normalizedPlayer.group,
            groups: normalizedPlayer.groups,
            teeTimes: normalizedPlayer.teeTimes,
            teeTime: normalizedPlayer.teeTimes.find((v) => !!v) || null
          };
        }
      } else {
        for (const playerId of Object.keys(current.players || {})) {
          const existing = current.players[playerId];
          const teamId = resolver.upsertTeam(existing?.teamId, nextTeams[existing?.teamId]?.teamName || "");
          const normalized = normalizePlayerPayload(existing, existing, roundCount);
          if (!normalized) continue;
          nextPlayers[playerId] = {
            playerId,
            name: normalized.name,
            teamId,
            handicap: normalized.handicap,
            code: normalized.code,
            group: normalized.group,
            groups: normalized.groups,
            teeTimes: normalized.teeTimes,
            teeTime: normalized.teeTimes.find((v) => !!v) || null
          };
        }
      }

      const autoGroups =
        options?.autoAssignTwoManGroups === true || body?.autoAssignTwoManGroups === true;
      if (autoGroups) applyAutoTwoManGroups(nextPlayers, current.rounds.length);

      const validTeamIds = new Set();
      for (const playerId of Object.keys(nextPlayers)) {
        const teamId = nextPlayers[playerId]?.teamId;
        if (teamId) validTeamIds.add(teamId);
      }

      for (const teamId of Object.keys(nextTeams)) {
        if (!validTeamIds.has(teamId)) delete nextTeams[teamId];
      }

      const validPlayerIds = new Set(Object.keys(nextPlayers));
      const validGroupIdsByRound = buildValidGroupIdsByRound(nextPlayers, current.rounds);
      current.scores = cleanupScores(
        current.scores,
        validTeamIds,
        validPlayerIds,
        current.rounds.length,
        validGroupIdsByRound
      );
      if (body?.scores !== undefined) {
        current.scores = normalizeScoresForState(
          body.scores,
          current.rounds.length,
          validTeamIds,
          validPlayerIds,
          validGroupIdsByRound
        );
      }

      current.players = nextPlayers;
      current.teams = nextTeams;
      current.codeIndex = ensureUniqueCodes(nextPlayers, {
        regenerateAll: options?.regenerateCodes === true
      });
      const nextCodes = new Set(Object.keys(current.codeIndex || {}));
      retiredCodes = [...previousCodes].filter((code) => !nextCodes.has(code));
      current.updatedAt = now;
      current.version = Number(current.version || 0) + 1;
      return current;
    });

    await appendEvent(tid, {
      type: "admin_edit",
      tid,
      ts: now,
      playerCount: Object.keys(updated.players || {}).length,
      teamCount: Object.keys(updated.teams || {}).length
    });
    await writePublicObjectsFromState(updated);
    const publicBucket = process.env.PUBLIC_BUCKET;
    for (const code of retiredCodes) {
      if (!code) continue;
      await putJson(
        publicBucket,
        `enter/${code}.json`,
        { error: "invalid code", code, retiredAt: now },
        { gzip: true, cacheControl: "max-age=5, must-revalidate" }
      );
    }

    return json(200, {
      ok: true,
      updatedAt: updated.updatedAt,
      version: updated.version,
      players: Object.keys(updated.players || {}).length,
      teams: Object.keys(updated.teams || {}).length
    });
  } catch (e) {
    return json(e.statusCode || 500, { error: e.message || "Server error" });
  }
}
