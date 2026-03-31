import { json, parseBody, requireAdmin, uid, makeEditCode, hashEditCode, normalizeTournamentScoring, updateStateWithRetry, writePublicObjectsFromState } from "./utils.js";
import { normalizeCourseRecord, validateCourse } from "./course_data.js";
import { normalizeRoundMaxHoleScore } from "./round_rules.js";

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

    // Normalize rounds. If no weights are provided, default all rounds to equal weight.
    const baseRounds = rounds.map(r => ({
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

    const state = {
      tournament: {
        tournamentId: tid,
        name,
        dates,
        scoring,
        createdAt: Date.now(),
        editCodeHash: hashEditCode(editCode)
      },
      rounds: normRounds,
      course: courses[0],
      courses,
      teams: {},
      players: {},
      codeIndex: {},
      chatMessages: [],
      scores: { rounds: normRounds.map(()=>({ teams:{}, players:{}, groups:{} })) },
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
