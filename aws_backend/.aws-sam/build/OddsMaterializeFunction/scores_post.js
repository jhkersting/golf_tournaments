import { json, parseBody, normalizeHoles, getJson, updateStateWithRetry, appendEvent, writePublicObjectsFromState, materializePublicFromState } from "./utils.js";
import { notifyScoreSubscribers } from "./push_notifications.js";
import { createMatchPlayResultLock, isTeamMatchPlay, matchPlayHoleIndices } from "./match_play.js";

function asInt(v){
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function normalizeTeeValue(v){
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function teeValueForRound(player, roundIndex){
  if (!player || roundIndex < 0) return "";
  if (Array.isArray(player.teeTimes)){
    const v = normalizeTeeValue(player.teeTimes[roundIndex]);
    if (v) return v;
  }
  if (roundIndex === 0){
    const fallback = normalizeTeeValue(player.teeTime);
    if (fallback) return fallback;
  }
  return "";
}

function normalizeGroupLabel(v){
  return String(v || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 16);
}

function playerGroupForRound(player, roundIndex){
  if (Array.isArray(player?.groups)){
    const v = normalizeGroupLabel(player.groups[roundIndex]);
    if (v) return v;
  }
  if (roundIndex === 0){
    const fallback = normalizeGroupLabel(player?.group);
    if (fallback) return fallback;
  }
  return "";
}

function groupId(teamId, groupLabel){
  const team = String(teamId || "").trim();
  const label = normalizeGroupLabel(groupLabel);
  if (!team || !label) return "";
  return `${team}::${label}`;
}

function normalizeTwoManFormat(format){
  const fmt = String(format || "").trim().toLowerCase();
  if (fmt === "two_man") return "two_man_scramble";
  if (fmt === "two_man_scramble" || fmt === "two_man_shamble" || fmt === "two_man_best_ball") return fmt;
  return "";
}

function matchWriteHoles(raw, activeHoleIndices) {
  if (!Array.isArray(raw) || raw.length !== 18) {
    const error = new Error("holes must be an array of length 18");
    error.statusCode = 400;
    throw error;
  }
  const active = new Set(activeHoleIndices);
  return raw.map((value, index) => {
    if (!active.has(index) || value == null || (typeof value === "string" && value.trim() === "")) return null;
    const number = Number(value);
    if (!Number.isFinite(number) || Math.round(number) < 1 || Math.round(number) > 20) {
      const error = new Error("hole scores must be numbers between 1 and 20 or blank");
      error.statusCode = 400;
      throw error;
    }
    return Math.round(number);
  });
}

export function resolveMatchPlayScoreTarget(match, actorPlayerId, requestedTargetId, playerFormat) {
  const sides = [match?.teamA, match?.teamB].filter(Boolean);
  const actorSide = sides.find((side) => side.playerIds?.includes(actorPlayerId));
  if (!actorSide) {
    const error = new Error("You are not assigned to this match");
    error.statusCode = 403;
    throw error;
  }

  const requested = String(requestedTargetId || "").trim();
  if (playerFormat) {
    const targetId = requested || actorPlayerId;
    if (!sides.some((side) => side.playerIds?.includes(targetId))) {
      const error = new Error("Score target is not assigned to this match");
      error.statusCode = 403;
      throw error;
    }
    return { targetType: "player", targetId };
  }

  const targetId = requested || actorSide.teamId;
  if (!sides.some((side) => side.teamId === targetId)) {
    const error = new Error("Score target is not assigned to this match");
    error.statusCode = 403;
    throw error;
  }
  return { targetType: "match_side", targetId };
}

export function ensureMatchPlayResultLock(state, roundIndex, matchId, endedAt = Date.now()) {
  const publicMatch = materializePublicFromState(state)?.matchPlay?.rounds?.[roundIndex]?.matches
    ?.find((match) => String(match?.matchId || "") === String(matchId || ""));
  const lock = createMatchPlayResultLock(publicMatch, endedAt);
  if (!lock) return { created: false, lock: null, match: publicMatch || null };

  state.scores = state.scores || { rounds: [] };
  state.scores.rounds = state.scores.rounds || [];
  state.scores.rounds[roundIndex] = state.scores.rounds[roundIndex] || { teams: {}, players: {}, groups: {}, matches: {} };
  const roundScores = state.scores.rounds[roundIndex];
  roundScores.matches = roundScores.matches || {};
  const matchScores = roundScores.matches[matchId] = roundScores.matches[matchId] || { sides: {} };
  if (matchScores.resultLock) {
    return { created: false, lock: matchScores.resultLock, match: publicMatch };
  }
  matchScores.resultLock = lock;
  return { created: true, lock, match: publicMatch };
}

async function handleMatchPlayScore(event, body, tid) {
  const code = String(body.code || "").trim();
  const roundIndex = Number(body.roundIndex);
  const matchId = String(body.matchId ?? body.matchPlayMatchId ?? "").trim();
  const override = !!body.override;
  const mode = body.mode || ((body.holeIndex !== undefined && body.holeIndex !== null) ? "hole" : "bulk");
  const holeIndex = body.holeIndex !== undefined && body.holeIndex !== null ? Number(body.holeIndex) : null;
  if (!code) return json(400, { error: "missing code" });
  if (!matchId) return json(400, { error: "missing matchId" });
  if (!Number.isInteger(roundIndex) || roundIndex < 0) return json(400, { error: "invalid roundIndex" });
  if (mode === "hole" && (!Number.isInteger(holeIndex) || holeIndex < 0 || holeIndex > 17)) {
    return json(400, { error: "invalid holeIndex" });
  }
  if (!Array.isArray(body.entries) || !body.entries.length) return json(400, { error: "missing entries" });

  const now = Date.now();
  let actorPlayerId = null;
  let changedScores = [];
  let matchEnded = null;
  const nextState = await updateStateWithRetry(tid, (current) => {
    matchEnded = null;
    if (!current || !isTeamMatchPlay(current)) {
      const error = new Error("match-play tournament not found");
      error.statusCode = 404;
      throw error;
    }
    const round = current.rounds?.[roundIndex];
    if (!round) {
      const error = new Error("roundIndex out of range");
      error.statusCode = 400;
      throw error;
    }
    const match = round.matches?.find((item) => item.matchId === matchId);
    if (!match) {
      const error = new Error("invalid matchId");
      error.statusCode = 404;
      throw error;
    }
    const activeHoleIndices = matchPlayHoleIndices(round);
    const activeHoleSet = new Set(activeHoleIndices);
    if (mode === "hole" && !activeHoleSet.has(holeIndex)) {
      const error = new Error("holeIndex is not active for this match-play round");
      error.statusCode = 400;
      throw error;
    }
    actorPlayerId = current.codeIndex?.[code];
    const actor = current.players?.[actorPlayerId];
    if (!actor) {
      const error = new Error("invalid code");
      error.statusCode = 404;
      throw error;
    }
    const playerFormat = ["singles", "best_ball"].includes(round.format);
    // Resolve once before mutating score buckets so an otherwise valid player code
    // cannot write a match they are not scheduled to play.
    resolveMatchPlayScoreTarget(match, actorPlayerId, "", playerFormat);
    const previousCompletion = ensureMatchPlayResultLock(current, roundIndex, matchId, now);
    const wasComplete = !!previousCompletion.lock;
    current.scores = current.scores || { rounds: [] };
    current.scores.rounds = current.scores.rounds || [];
    current.scores.rounds[roundIndex] = current.scores.rounds[roundIndex] || { teams: {}, players: {}, groups: {}, matches: {} };
    const bucket = current.scores.rounds[roundIndex];
    bucket.matches = bucket.matches || {};
    bucket.players = bucket.players || {};
    const matchScores = bucket.matches[matchId] = bucket.matches[matchId] || { sides: {} };
    matchScores.sides = matchScores.sides || {};
    for (const side of [match.teamA, match.teamB]) {
      matchScores.sides[side.teamId] = matchScores.sides[side.teamId] || { holes: Array(18).fill(null), meta: Array(18).fill(null) };
    }
    const conflicts = [];
    const changed = new Map();
    const getEntry = (targetType, targetId) => {
      if (targetType === "player") {
        const entry = bucket.players[targetId] || {};
        return { holes: (entry.holes || Array(18).fill(null)).slice(0, 18).concat(Array(18).fill(null)).slice(0, 18), meta: (entry.meta || Array(18).fill(null)).slice(0, 18).concat(Array(18).fill(null)).slice(0, 18) };
      }
      const entry = matchScores.sides[targetId] || {};
      return { holes: (entry.holes || Array(18).fill(null)).slice(0, 18).concat(Array(18).fill(null)).slice(0, 18), meta: (entry.meta || Array(18).fill(null)).slice(0, 18).concat(Array(18).fill(null)).slice(0, 18) };
    };
    const putEntry = (targetType, targetId, entry) => {
      if (targetType === "player") bucket.players[targetId] = entry;
      else matchScores.sides[targetId] = entry;
    };
    const apply = (targetType, targetId, index, value) => {
      if (!activeHoleSet.has(index) || value === undefined) return;
      const entry = getEntry(targetType, targetId);
      const existing = entry.holes[index];
      const metadata = entry.meta[index];
      if (value === null) {
        if (existing != null && !override) {
          conflicts.push({ targetType, targetId, holeIndex: index, existing, attempted: null, lastBy: metadata?.by || null, lastTs: metadata?.ts || null });
          return;
        }
        entry.holes[index] = null;
      } else {
        const number = Number(value);
        if (!Number.isFinite(number) || number < 1 || number > 20) {
          const error = new Error("invalid strokes");
          error.statusCode = 400;
          throw error;
        }
        if (existing != null && number !== Number(existing) && !override) {
          conflicts.push({ targetType, targetId, holeIndex: index, existing, attempted: number, lastBy: metadata?.by || null, lastTs: metadata?.ts || null });
          return;
        }
        if (existing === number) return;
        entry.holes[index] = Math.round(number);
      }
      entry.meta[index] = { by: actorPlayerId, ts: now };
      putEntry(targetType, targetId, entry);
      const key = `${targetType}::${targetId}::${index}`;
      if (value === null) changed.delete(key);
      else changed.set(key, { targetType, targetId, holeIndex: index });
    };
    for (const entry of body.entries) {
      const requested = String(entry?.targetId || "").trim();
      const { targetType, targetId } = resolveMatchPlayScoreTarget(
        match,
        actorPlayerId,
        requested,
        playerFormat
      );
      if (mode === "hole") {
        const value = entry?.strokes === "" ? undefined : entry?.strokes === null ? null : Number(entry?.strokes);
        apply(targetType, targetId, holeIndex, value);
      } else {
        const holes = matchWriteHoles(entry?.holes, activeHoleIndices);
        for (const index of activeHoleIndices) apply(targetType, targetId, index, holes[index]);
        for (const clearIndex of Array.isArray(entry?.clearHoles) ? entry.clearHoles : []) {
          const index = Number(clearIndex);
          if (Number.isInteger(index) && activeHoleSet.has(index)) apply(targetType, targetId, index, null);
        }
      }
    }
    if (conflicts.length) {
      const error = new Error("conflict");
      error.statusCode = 409;
      error.conflicts = conflicts;
      throw error;
    }
    const nextCompletion = ensureMatchPlayResultLock(current, roundIndex, matchId, now);
    if (!wasComplete && nextCompletion.created) {
      matchEnded = nextCompletion.lock;
    }
    changedScores = [...changed.values()];
    current.updatedAt = now;
    current.version = Number(current.version || 0) + 1;
    return current;
  });
  await appendEvent(tid, { type: "scores", tid, actorPlayerId, code, roundIndex, matchId, mode, holeIndex, override, entries: body.entries, matchEnded, ts: now });
  await writePublicObjectsFromState(nextState);
  try {
    await notifyScoreSubscribers(tid, nextState, { actorPlayerId, code, roundIndex, matchId, mode, holeIndex, changedScores, matchEnded });
  } catch (error) {
    console.warn("Push notification dispatch failed:", error?.message || error);
  }
  return json(200, { ok: true, version: nextState.version, updatedAt: nextState.updatedAt });
}

export async function handler(event){
  try{
    const tid = event.pathParameters?.tid;
    if (!tid) return json(400, { error: "missing tid" });

    const body = await parseBody(event);
    const { json: stateProbe } = await getJson(process.env.STATE_BUCKET, `state/${tid}.json`);
    if (isTeamMatchPlay(stateProbe)) return handleMatchPlayScore(event, body, tid);
    const code = String(body.code || "").trim();
    const roundIndex = Number(body.roundIndex);
    const override = !!body.override;

    if (!code) return json(400, { error: "missing code" });
    if (!Number.isInteger(roundIndex) || roundIndex < 0) return json(400, { error: "invalid roundIndex" });

    // Determine mode
    const mode = body.mode || ((body.holeIndex !== undefined && body.holeIndex !== null) ? "hole" : "bulk");

    const holeIndex = body.holeIndex !== undefined && body.holeIndex !== null ? Number(body.holeIndex) : null;
    if (mode === "hole"){
      if (!Number.isInteger(holeIndex) || holeIndex < 0 || holeIndex > 17){
        return json(400, { error: "invalid holeIndex" });
      }
      if (!Array.isArray(body.entries) || body.entries.length === 0){
        return json(400, { error: "missing entries" });
      }
    } else {
      if (!Array.isArray(body.entries) || body.entries.length === 0){
        return json(400, { error: "missing entries" });
      }
    }

    const now = Date.now();

    // Update state with optimistic concurrency + merge
    const { nextState, conflicts, actorPlayerId, changedScores } = await (async () => {
      let actorPidOut = null;
      let conflictsOut = [];
      let changedScoresOut = [];
      const next = await updateStateWithRetry(tid, (current) => {
        conflictsOut = [];
        const changedScoreMap = new Map();
        current = current || {};
        const rounds = current.rounds || [];
        if (roundIndex >= rounds.length){
          const err = new Error("roundIndex out of range");
          err.statusCode = 400;
          throw err;
        }

        current.codeIndex = current.codeIndex || {};
        const actorPlayerId = current.codeIndex[code];
        actorPidOut = actorPlayerId;
        if (!actorPlayerId){
          const err = new Error("invalid code");
          err.statusCode = 404;
          throw err;
        }
        const actorPlayer = current.players?.[actorPlayerId];
        if (!actorPlayer){
          const err = new Error("invalid code");
          err.statusCode = 404;
          throw err;
        }

        const round = rounds[roundIndex] || {};
        const format = String(round.format || "").toLowerCase();
        const isScramble = format === "scramble";
        const twoManFormat = normalizeTwoManFormat(format);
        const targetType = isScramble ? "team" : twoManFormat === "two_man_scramble" ? "group" : "player";
        const players = current.players || {};
        const actorTee = teeValueForRound(actorPlayer, roundIndex);
        const allowedPlayerIds = new Set([actorPlayerId]);
        if (!isScramble && actorTee){
          for (const pid of Object.keys(players)){
            const p = players[pid];
            if (teeValueForRound(p, roundIndex) === actorTee) allowedPlayerIds.add(pid);
          }
        }
        const allowedGroupIds = new Set();
        if (targetType === "group"){
          for (const pid of allowedPlayerIds){
            const p = players[pid];
            const gid = groupId(p?.teamId, playerGroupForRound(p, roundIndex));
            if (gid) allowedGroupIds.add(gid);
          }
        }

        function assertPlayerTargetAllowed(pid){
          if (isScramble) return;
          if (targetType === "group") return;
          if (allowedPlayerIds.has(pid)) return;
          const err = new Error("You can only enter scores for players on your tee time in this round");
          err.statusCode = 403;
          throw err;
        }

        function assertGroupTargetAllowed(gid){
          if (targetType !== "group") return;
          if (allowedGroupIds.has(gid)) return;
          const err = new Error("You can only enter scores for groups on your tee time in this round");
          err.statusCode = 403;
          throw err;
        }

        current.scores = current.scores || { rounds: rounds.map(()=>({teams:{},players:{},groups:{}})) };
        current.scores.rounds = current.scores.rounds || rounds.map(()=>({teams:{},players:{},groups:{}}));
        current.scores.rounds[roundIndex] = current.scores.rounds[roundIndex] || { teams:{}, players:{}, groups:{} };
        const bucket = current.scores.rounds[roundIndex];

        function getEntryObj(tType, id){
          if (tType === "team"){
            bucket.teams = bucket.teams || {};
            const e = bucket.teams[id] || {};
            const holes = (e.holes || Array(18).fill(null)).map(v => (v===0?null:v));
            const meta = Array.isArray(e.meta) ? e.meta.slice() : Array(18).fill(null);
            return { holes, meta };
          } else if (tType === "player") {
            bucket.players = bucket.players || {};
            const e = bucket.players[id] || {};
            const holes = (e.holes || Array(18).fill(null)).map(v => (v===0?null:v));
            const meta = Array.isArray(e.meta) ? e.meta.slice() : Array(18).fill(null);
            return { holes, meta };
          } else {
            bucket.groups = bucket.groups || {};
            const e = bucket.groups[id] || {};
            const holes = (e.holes || Array(18).fill(null)).map(v => (v===0?null:v));
            const meta = Array.isArray(e.meta) ? e.meta.slice() : Array(18).fill(null);
            return { holes, meta };
          }
        }

        function setEntryObj(tType, id, obj){
          if (tType === "team"){
            bucket.teams[id] = { holes: obj.holes, meta: obj.meta };
          } else if (tType === "player") {
            bucket.players[id] = { holes: obj.holes, meta: obj.meta };
          } else {
            bucket.groups[id] = { holes: obj.holes, meta: obj.meta };
          }
        }

        function conflict(tType, id, i, existing, attempted, meta){
          conflictsOut.push({
            targetType: tType,
            targetId: id,
            holeIndex: i,
            existing,
            attempted,
            lastBy: meta?.by || null,
            lastTs: meta?.ts || null
          });
        }

        function changedScoreKey(tType, id, holeIdx){
          return `${String(tType || "").trim()}::${String(id || "").trim()}::${Number(holeIdx)}`;
        }

        function recordChangedScore(tType, id, holeIdx){
          changedScoreMap.set(changedScoreKey(tType, id, holeIdx), {
            targetType: tType,
            targetId: id,
            holeIndex: holeIdx
          });
        }

        function clearChangedScore(tType, id, holeIdx){
          changedScoreMap.delete(changedScoreKey(tType, id, holeIdx));
        }

        // Helper to apply a single hole score with overwrite rules
        function applyHole(tType, id, i, strokes){
          const entry = getEntryObj(tType, id);
          const existing = entry.holes[i];
          const existingMeta = entry.meta[i];

          // ignore undefined (no change)
          if (strokes === undefined) return;

          // allow null only if override (clearing)
          if (strokes === null){
            if (existing != null && !override){
              conflict(tType, id, i, existing, null, existingMeta);
              return;
            }
            entry.holes[i] = null;
            entry.meta[i] = { by: actorPlayerId, ts: now };
            setEntryObj(tType, id, entry);
            clearChangedScore(tType, id, i);
            return;
          }

          const attempted = Number(strokes);
          if (!Number.isFinite(attempted) || attempted < 1 || attempted > 20){
            const err = new Error("invalid strokes");
            err.statusCode = 400;
            throw err;
          }

          if (existing != null && attempted !== Number(existing) && !override){
            conflict(tType, id, i, existing, attempted, existingMeta);
            return;
          }

          // no-op if same
          if (existing != null && attempted === Number(existing)){
            return;
          }

          entry.holes[i] = attempted;
          entry.meta[i] = { by: actorPlayerId, ts: now };
          setEntryObj(tType, id, entry);
          recordChangedScore(tType, id, i);
        }

        if (mode === "hole"){
          // Build entries; for scramble and two-man, force target by actor unless explicit target is provided.
          if (targetType === "team"){
            const teamId = actorPlayer.teamId;
            const strokes = asInt(body.entries?.[0]?.strokes);
            applyHole("team", teamId, holeIndex, strokes);
          } else if (targetType === "group"){
            for (const ent of body.entries){
              const requested = String(ent?.targetId || "").trim();
              const actorGroupId = groupId(actorPlayer.teamId, playerGroupForRound(actorPlayer, roundIndex));
              const gid = requested || actorGroupId;
              if (!gid){
                const err = new Error("No group assigned for this round");
                err.statusCode = 400;
                throw err;
              }
              assertGroupTargetAllowed(gid);
              const strokes = ent?.strokes === "" ? undefined : (ent?.strokes === null ? null : asInt(ent?.strokes));
              applyHole("group", gid, holeIndex, strokes);
            }
          } else {
            for (const ent of body.entries){
              const pid = String(ent.targetId || "").trim();
              if (!pid) continue;
              assertPlayerTargetAllowed(pid);
              const strokes = ent.strokes === "" ? undefined : (ent.strokes === null ? null : asInt(ent.strokes));
              applyHole("player", pid, holeIndex, strokes);
            }
          }
        } else {
          // bulk mode
          for (const ent of body.entries){
            const id = String(ent.targetId || "").trim();
            if (!id) continue;
            if (targetType === "player") assertPlayerTargetAllowed(id);
            if (targetType === "group") assertGroupTargetAllowed(id);
            const holesIn = normalizeHoles(ent.holes);
            const clearHoles = Array.isArray(ent.clearHoles) ? ent.clearHoles.map(Number).filter(n=>Number.isInteger(n)&&n>=0&&n<18) : [];
            for (let i=0;i<18;i++){
              if (holesIn[i] != null) applyHole(targetType, id, i, holesIn[i]);
            }
            for (const i of clearHoles) applyHole(targetType, id, i, null);
          }
        }

        if (conflictsOut.length){
          const err = new Error("conflict");
          err.statusCode = 409;
          err.conflicts = conflictsOut;
          throw err;
        }

        current.updatedAt = now;
        current.version = Number(current.version || 0) + 1;
        changedScoresOut = Array.from(changedScoreMap.values());
        return current;
      });

      return {
        nextState: next,
        conflicts: conflictsOut,
        actorPlayerId: actorPidOut,
        changedScores: changedScoresOut
      };
    })();

    // Append event log
    await appendEvent(tid, {
      type: "scores",
      tid,
      actorPlayerId,
      code,
      roundIndex,
      mode,
      holeIndex,
      override,
      entries: body.entries || [],
      ts: now
    });

    // Write public (static) json objects
    await writePublicObjectsFromState(nextState);
    try {
      await notifyScoreSubscribers(tid, nextState, {
        actorPlayerId,
        code,
        roundIndex,
        mode,
        holeIndex,
        changedScores
      });
    } catch (pushError) {
      console.warn("Push notification dispatch failed:", pushError?.message || pushError);
    }

    return json(200, { ok:true, version: nextState.version, updatedAt: nextState.updatedAt });

  } catch(e){
    const code = e?.statusCode || 500;
    if (code === 409){
      return json(409, { error:"conflict", message:"Score(s) already posted. Override required.", conflicts: e.conflicts || [] });
    }
    return json(code, { error: e?.message || String(e) });
  }
}
