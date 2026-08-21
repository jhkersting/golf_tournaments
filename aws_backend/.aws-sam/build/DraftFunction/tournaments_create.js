import { json, parseBody, requireAdmin, uid, code4, makeEditCode, hashEditCode, normalizeTournamentScoring, updateStateWithRetry, writePublicObjectsFromState } from "./utils.js";
import { normalizeCourseRecord, validateCourse } from "./course_data.js";
import { normalizeRoundMaxHoleScore } from "./round_rules.js";
import {
  COMPETITION_TYPE,
  normalizeMatchPlayConfiguration,
  normalizeMatchPlayRounds
} from "./match_play.js";

function defaultCourse(){
  return {
    pars: Array(18).fill(4),
    strokeIndex: Array.from({ length: 18 }, (_, i) => i + 1)
  };
}

function normalizeRoundCourseIndex(value, courseCount){
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n >= courseCount) return 0;
  return n;
}

function normalizeCoursesFromBody(body){
  const rawCourses = Array.isArray(body?.courses) ? body.courses : [];
  if (rawCourses.length > 0){
    const out = [];
    for (let idx = 0; idx < rawCourses.length; idx++){
      const err = validateCourse(rawCourses[idx]);
      if (err) {
        const e = new Error(`courses[${idx}]: ${err}`);
        e.statusCode = 400;
        throw e;
      }
      out.push(normalizeCourseRecord(rawCourses[idx]));
    }
    return out;
  }

  const singleCourse = body?.course || defaultCourse();
  const err = validateCourse(singleCourse);
  if (err) {
    const e = new Error(err);
    e.statusCode = 400;
    throw e;
  }
  return [normalizeCourseRecord(singleCourse)];
}

function normalizeAgg(agg){
  let topX = Number(agg?.topX ?? 4);
  if (!Number.isFinite(topX) || topX <= 0) topX = 4;
  topX = Math.round(topX);
  return { mode: "avg", topX };
}

function normalizeRoundFormat(format){
  const raw = String(format || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (raw === "scramble") return "scramble";
  if (raw === "team_best_ball" || raw === "team_bestball") return "team_best_ball";
  if (raw === "shamble") return "shamble";
  if (raw === "two_man_shamble" || raw === "2man_shamble" || raw === "2_man_shamble") return "two_man_shamble";
  if (raw === "two_man_best_ball" || raw === "two_man_bestball" || raw === "best_ball" || raw === "2man_best_ball" || raw === "2_man_best_ball"){
    return "two_man_best_ball";
  }
  if (raw === "two_man_scramble" || raw === "two_man" || raw === "2_man" || raw === "2man" || raw === "2man_scramble" || raw === "2_man_scramble"){
    return "two_man_scramble";
  }
  return "singles";
}

function normalizeRoundWeight(weight){
  if (weight === null || weight === undefined) return null;
  if (typeof weight === "string" && weight.trim() === "") return null;
  const n = Number(weight);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export async function handler(event){
  try{
    requireAdmin(event);
    const body = await parseBody(event);
    const name = String(body.name || "").trim() || "Tournament";
    const dates = String(body.dates || "").trim() || "";
    const scoring = normalizeTournamentScoring(body?.tournament?.scoring ?? body?.scoring);
    const rounds = Array.isArray(body.rounds) ? body.rounds : [];
    const courses = normalizeCoursesFromBody(body);
    const competitionType = String(body?.tournament?.competitionType ?? body?.competitionType ?? "")
      .trim().toLowerCase() || "stroke_play";

    if (competitionType !== "stroke_play" && competitionType !== COMPETITION_TYPE) {
      const err = new Error(`Unsupported competitionType "${competitionType}".`);
      err.statusCode = 400;
      throw err;
    }

    // Normalize rounds. If no weights are provided, default all rounds to equal weight.
    const baseRounds = competitionType === COMPETITION_TYPE
      ? normalizeMatchPlayRounds(
        rounds,
        [],
        Number(body?.matchPlay?.pointsPerMatch ?? body?.matchPlay?.matchPoints) > 0
          ? Number(body.matchPlay.pointsPerMatch ?? body.matchPlay.matchPoints)
          : 1
      )
      : rounds.map(r => ({
        name: String(r?.name || "Round").trim(),
        format: normalizeRoundFormat(r?.format),
        weight: normalizeRoundWeight(r?.weight),
        useHandicap: !!r?.useHandicap,
        maxHoleScore: normalizeRoundMaxHoleScore(r?.maxHoleScore),
        courseIndex: normalizeRoundCourseIndex(r?.courseIndex, courses.length),
        teamAggregation: normalizeAgg(r?.teamAggregation)
      }));
    const allMissingWeight = baseRounds.length > 0 && baseRounds.every(r => r.weight == null);
    const normRounds = baseRounds.map(r => ({
      ...r,
      weight: allMissingWeight ? 1 : (r.weight == null ? 1 : r.weight)
    }));

    const tid = uid("t");
    const editCode = makeEditCode(8);

    const initialTeams = {};
    for (const item of Array.isArray(body?.teams) ? body.teams : []) {
      const teamId = String(item?.teamId ?? item?.id ?? "").trim();
      if (!teamId) continue;
      initialTeams[teamId] = {
        teamId,
        teamName: String(item?.teamName ?? item?.name ?? teamId).trim() || teamId,
        ...(item?.color ? { color: String(item.color).trim() } : {})
      };
    }
    let matchPlaySeed = competitionType === COMPETITION_TYPE
      ? normalizeMatchPlayConfiguration(body?.matchPlay, baseRounds, { teams: {} })
      : null;
    for (const teamId of matchPlaySeed?.teamIds || []) {
      if (!initialTeams[teamId]) initialTeams[teamId] = { teamId, teamName: teamId };
    }

    const initialPlayers = {};
    const initialCodeIndex = {};
    for (const item of Array.isArray(body?.players) ? body.players : []) {
      const name = String(item?.name || "").trim();
      const teamId = String(item?.teamId || "").trim();
      if (!name || !teamId) continue;
      const playerId = String(item?.playerId || uid("p")).trim();
      let code = String(item?.code || "").trim().toUpperCase().replace(/\s+/g, "");
      if (!code) code = code4();
      if (initialCodeIndex[code]) {
        const err = new Error(`Duplicate code "${code}"`);
        err.statusCode = 400;
        throw err;
      }
      initialCodeIndex[code] = playerId;
      initialPlayers[playerId] = {
        playerId,
        name,
        teamId,
        handicap: Number.isFinite(Number(item?.handicap)) ? Number(item.handicap) : 0,
        code,
        groups: [],
        group: null,
        teeTimes: [],
        teeTime: null
      };
      if (!initialTeams[teamId]) initialTeams[teamId] = { teamId, teamName: teamId };
    }
    if (competitionType === COMPETITION_TYPE) {
      matchPlaySeed = normalizeMatchPlayConfiguration(matchPlaySeed, baseRounds, {
        teams: initialTeams,
        players: initialPlayers
      });
    }

    const state = {
      tournament: {
        tournamentId: tid,
        name,
        dates,
        scoring,
        competitionType,
        ...(matchPlaySeed ? {
          matchPlay: {
            teamIds: matchPlaySeed.teamIds,
            pointsPerMatch: matchPlaySeed.pointsPerMatch,
            winTarget: matchPlaySeed.winTarget
          }
        } : {}),
        createdAt: Date.now(),
        editCodeHash: hashEditCode(editCode)
      },
      rounds: normRounds,
      course: courses[0],
      courses,
      teams: initialTeams,
      players: initialPlayers,
      codeIndex: initialCodeIndex,
      scores: { rounds: competitionType === COMPETITION_TYPE
        ? normRounds.map((round) => ({
          teams: {}, players: {}, groups: {}, matches: Object.fromEntries((round.matches || []).map((match) => [match.matchId, {
            sides: {
              [match.teamA.teamId]: { holes: Array(18).fill(null), meta: Array(18).fill(null) },
              [match.teamB.teamId]: { holes: Array(18).fill(null), meta: Array(18).fill(null) }
            }
          }]))
        }))
        : normRounds.map(()=>({ teams:{}, players:{}, groups:{} })) },
      updatedAt: Date.now(),
      version: 1
    };

    // Write initial state (no concurrency needed since new)
    await updateStateWithRetry(tid, () => state, { maxTries: 2 });
    await writePublicObjectsFromState(state);

    return json(200, { tournamentId: tid, editCode });
  } catch(e){
    return json(e.statusCode || 500, { error: e.message || "Server error" });
  }
}
