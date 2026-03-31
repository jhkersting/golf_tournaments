import { json, parseBody, normalizeHoles, updateStateWithRetry, appendEvent, writePublicObjectsFromState } from "./utils.js";
import { notifyScoreSubscribers } from "./push_notifications.js";

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

export async function handler(event){
  try{
    const tid = event.pathParameters?.tid;
    if (!tid) return json(400, { error: "missing tid" });

    const body = await parseBody(event);
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
