import { json, parseBody, requireAdmin, uid, updateStateWithRetry, writePublicObjectsFromState } from "./utils.js";

function validateCourse(course){
  const pars = course?.pars;
  const strokeIndex = course?.strokeIndex;
  if (!Array.isArray(pars) || pars.length !== 18) return "course.pars must be an array of length 18";
  if (!Array.isArray(strokeIndex) || strokeIndex.length !== 18) return "course.strokeIndex must be an array of length 18";
  for (const p of pars){
    if (!Number.isFinite(Number(p))) return "All pars must be numbers";
  }
  const si = strokeIndex.map(Number);
  const set = new Set(si);
  if (set.size !== 18) return "Stroke Index must contain 18 unique values";
  for (const v of si){
    if (!Number.isInteger(v) || v < 1 || v > 18) return "Stroke Index values must be integers 1..18";
  }
  return null;
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
  if (
    raw === "two_man_best_ball" ||
    raw === "two_man" ||
    raw === "2_man" ||
    raw === "2man" ||
    raw === "best_ball" ||
    raw === "2man_best_ball" ||
    raw === "2_man_best_ball"
  ){
    return "two_man_best_ball";
  }
  return "singles";
}

export async function handler(event){
  try{
    requireAdmin(event);
    const body = await parseBody(event);
    const name = String(body.name || "").trim() || "Tournament";
    const dates = String(body.dates || "").trim() || "";
    const rounds = Array.isArray(body.rounds) ? body.rounds : [];
    const course = body.course || { pars: Array(18).fill(4), strokeIndex: Array.from({length:18},(_,i)=>i+1) };

    const courseErr = validateCourse(course);
    if (courseErr) return json(400, { error: courseErr });

    // Normalize rounds
    const normRounds = rounds.map(r => ({
      name: String(r?.name || "Round").trim(),
      format: normalizeRoundFormat(r?.format),
      weight: Number(r?.weight ?? 1),
      useHandicap: !!r?.useHandicap,
      teamAggregation: normalizeAgg(r?.teamAggregation)
    }));

    const tid = uid("t");

    const state = {
      tournament: { tournamentId: tid, name, dates, createdAt: Date.now() },
      rounds: normRounds,
      course: { pars: course.pars.map(Number), strokeIndex: course.strokeIndex.map(Number) },
      teams: {},
      players: {},
      codeIndex: {},
      scores: { rounds: normRounds.map(()=>({ teams:{}, players:{} })) },
      updatedAt: Date.now(),
      version: 1
    };

    // Write initial state (no concurrency needed since new)
    await updateStateWithRetry(tid, () => state, { maxTries: 2 });
    await writePublicObjectsFromState(state);

    return json(200, { tournamentId: tid });
  } catch(e){
    return json(e.statusCode || 500, { error: e.message || "Server error" });
  }
}
