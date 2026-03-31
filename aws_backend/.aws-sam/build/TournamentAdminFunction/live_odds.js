import { maxGrossByHoleForRound } from "./round_rules.js";

const MODEL_VERSION = "live-odds-latency-v10";
const LATENCY_MODE = "latency_first";
const HOLE_COUNT = 18;
const PAR_SIGMA = { 3: 0.55, 4: 0.75, 5: 0.95 };
const HOLE_SIGMA_MULTIPLIER = 1.35;
const STROKE_Z_MEAN = 9.5;
const STROKE_Z_STD = 5.188127472091127;
const BASELINE_REFERENCE_HANDICAP = 10;
const BASELINE_HANDICAP_ANCHORS = [0, 5, 10, 15, 20];
const LIVE_HOLE_SHRINKAGE = 8;
const LIVE_HOLE_EFFECT_MULTIPLIER = 0.5;
const FORM_SHRINKAGE = 6;
const FORM_EFFECT_MULTIPLIER = 0.5;
const FORM_EFFECT_CAP = 0.2;
const HARDY_PARAM_EPSILON = 0.002;
const MAX_HARDY_PARAM_SUM = 0.97;
const LIVE_SHIFT_SCALES = { p: 0.7, q: 0.6 };
const FORM_SHIFT_SCALES = { p: 0.6, q: 0.5 };
const ROUND_SHOCK_SHIFT_SCALES = { p: 0.45, q: 0.35 };
const YARDAGE_MEAN_SHIFT_PER_Z = 0.06;
const YARDAGE_SIGMA_SHIFT_PER_Z = 0.04;
const SLOPE_SIGMA_SHIFT_FACTOR = 0.08;
const BASELINE_OVER_PAR_BY_STROKE_INDEX = [
  [0.35, 0.69, 0.98, 1.28, 1.58],
  [0.30, 0.64, 0.93, 1.22, 1.50],
  [0.28, 0.60, 0.89, 1.18, 1.46],
  [0.27, 0.58, 0.85, 1.14, 1.42],
  [0.25, 0.56, 0.83, 1.11, 1.40],
  [0.21, 0.54, 0.81, 1.09, 1.35],
  [0.22, 0.52, 0.79, 1.06, 1.33],
  [0.20, 0.50, 0.76, 1.03, 1.29],
  [0.20, 0.50, 0.76, 1.02, 1.27],
  [0.18, 0.48, 0.73, 0.99, 1.25],
  [0.17, 0.46, 0.72, 0.98, 1.23],
  [0.14, 0.44, 0.69, 0.95, 1.18],
  [0.17, 0.44, 0.68, 0.92, 1.17],
  [0.14, 0.43, 0.66, 0.91, 1.14],
  [0.17, 0.44, 0.65, 0.88, 1.10],
  [0.15, 0.42, 0.64, 0.86, 1.07],
  [0.14, 0.39, 0.60, 0.80, 1.01],
  [0.13, 0.37, 0.57, 0.78, 0.98]
];
const HARDY_CANDIDATE_CACHE = new Map();
const HARDY_TARGET_CACHE = new Map();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function round1(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
}

function normalizeTournamentScoring(scoring) {
  const raw = String(scoring || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  return raw === "stableford" ? "stableford" : "stroke";
}

function playedHoleScore(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function stablefordPointsForHole(score, par) {
  const scoreNum = playedHoleScore(score);
  if (scoreNum == null) return null;
  const parNum = Number(par);
  if (!Number.isFinite(parNum) || parNum <= 0) return null;
  return Math.max(0, 2 + parNum - scoreNum);
}

function stablefordPointsArray(scores, pars) {
  return Array.from({ length: HOLE_COUNT }, (_, idx) => stablefordPointsForHole(scores?.[idx], pars?.[idx]));
}

function quantize(value, step) {
  const safeStep = Math.max(Number(step) || 0, 0.0001);
  return Math.round((Number(value) || 0) / safeStep) * safeStep;
}

function logitProb(value) {
  const safe = clamp(Number(value) || 0, HARDY_PARAM_EPSILON, 1 - HARDY_PARAM_EPSILON);
  return Math.log(safe / (1 - safe));
}

function logistic(value) {
  const safe = Number(value) || 0;
  if (safe >= 0) {
    const expNeg = Math.exp(-safe);
    return 1 / (1 + expNeg);
  }
  const expPos = Math.exp(safe);
  return expPos / (1 + expPos);
}

function normalizeHardyParams(p, q) {
  let safeP = clamp(Number(p) || 0, HARDY_PARAM_EPSILON, 0.4);
  let safeQ = clamp(Number(q) || 0, HARDY_PARAM_EPSILON, 0.7);
  const total = safeP + safeQ;
  if (total > MAX_HARDY_PARAM_SUM) {
    const scale = MAX_HARDY_PARAM_SUM / total;
    safeP *= scale;
    safeQ *= scale;
  }
  return { p: safeP, q: safeQ };
}

function shiftHardyParams(baseParams, shifts = {}) {
  const normalizedBase = normalizeHardyParams(baseParams?.p, baseParams?.q);
  const nextP = logistic(logitProb(normalizedBase.p) + Number(shifts?.pShift || 0));
  const nextQ = logistic(logitProb(normalizedBase.q) + Number(shifts?.qShift || 0));
  return normalizeHardyParams(nextP, nextQ);
}

function mergeHardyShifts(...shifts) {
  return shifts.reduce((out, shift) => ({
    pShift: out.pShift + Number(shift?.pShift || 0),
    qShift: out.qShift + Number(shift?.qShift || 0)
  }), { pShift: 0, qShift: 0 });
}

function hardyShiftFromStrokeDelta(delta, scales) {
  const safeDelta = clamp(Number(delta) || 0, -1.75, 1.75);
  return {
    pShift: clamp(-safeDelta * Number(scales?.p || 0), -1.8, 1.8),
    qShift: clamp(safeDelta * Number(scales?.q || 0), -1.8, 1.8)
  };
}

function sampleDiscrete(values, weights, rng) {
  let threshold = rng.next();
  for (let i = 0; i < values.length; i++) {
    threshold -= Number(weights[i] || 0);
    if (threshold <= 0 || i === values.length - 1) return Number(values[i]);
  }
  return Number(values[values.length - 1] || 0);
}

function averageFinite(values) {
  const clean = (values || []).map((value) => Number(value)).filter(Number.isFinite);
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function distributionBucketValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return round1(n);
}

function addDistributionValue(targetMap, value) {
  if (!(targetMap instanceof Map)) return;
  const bucket = distributionBucketValue(value);
  if (bucket == null) return;
  const key = bucket.toFixed(1);
  targetMap.set(key, Number(targetMap.get(key) || 0) + 1);
}

function distributionRowsFromMap(distributionMap, simulationCount) {
  if (!(distributionMap instanceof Map) || simulationCount <= 0) return [];
  return Array.from(distributionMap.entries())
    .map(([scoreText, count]) => ({
      score: round1(Number(scoreText)),
      probability: round2((Number(count || 0) / simulationCount) * 100)
    }))
    .filter((row) => Number(row?.probability || 0) > 0)
    .sort((a, b) => Number(a.score || 0) - Number(b.score || 0));
}

function hardyScoreDistribution(par, p, q, maxScore = holeUpperBound(par)) {
  const safePar = clamp(Math.round(Number(par) || 4), 3, 5);
  const safeP = clamp(Number(p) || 0, 0, 0.4);
  const safeQ = clamp(Number(q) || 0, 0, 0.7);
  const ordinary = Math.max(0, 1 - safeP - safeQ);
  const cap = Math.max(safePar + 2, Math.round(Number(maxScore) || holeUpperBound(safePar)));
  const key = `${safePar}|${safeP.toFixed(3)}|${safeQ.toFixed(3)}|${cap}`;
  const cached = HARDY_CANDIDATE_CACHE.get(key);
  if (cached) return cached;

  const finish = Array(cap + 1).fill(0);
  let states = Array(safePar).fill(0);
  states[0] = 1;

  const transitions = [
    { advance: 2, prob: safeP },
    { advance: 1, prob: ordinary },
    { advance: 0, prob: safeQ }
  ].filter((item) => item.prob > 0);

  for (let stroke = 1; stroke <= cap; stroke++) {
    const nextStates = Array(safePar).fill(0);
    for (let progress = 0; progress < safePar; progress++) {
      const stateProb = Number(states[progress] || 0);
      if (stateProb <= 0) continue;
      for (const transition of transitions) {
        const nextProgress = progress + transition.advance;
        const nextProb = stateProb * transition.prob;
        if (nextProgress >= safePar) finish[stroke] += nextProb;
        else nextStates[nextProgress] += nextProb;
      }
    }

    if (stroke === cap) {
      finish[stroke] += nextStates.reduce((sum, value) => sum + Number(value || 0), 0);
    } else {
      states = nextStates;
    }
  }

  const values = Array.from({ length: cap }, (_, idx) => idx + 1);
  const weights = finish.slice(1);
  const mean = values.reduce((sum, value, idx) => sum + (value * Number(weights[idx] || 0)), 0);
  const variance = values.reduce((sum, value, idx) => {
    const prob = Number(weights[idx] || 0);
    return sum + (((value - mean) ** 2) * prob);
  }, 0);
  const distribution = {
    values,
    weights,
    mean,
    stdDev: Math.sqrt(Math.max(variance, 0.0001))
  };
  HARDY_CANDIDATE_CACHE.set(key, distribution);
  return distribution;
}

function buildHardyCandidatesForPar(par) {
  const safePar = clamp(Math.round(Number(par) || 4), 3, 5);
  const candidates = [];
  const cap = holeUpperBound(safePar);
  for (let pBasis = 0; pBasis <= 22; pBasis++) {
    const p = pBasis / 100;
    for (let qBasis = 0; qBasis <= 55; qBasis++) {
      const q = qBasis / 100;
      if ((p + q) >= 0.98) continue;
      const distribution = hardyScoreDistribution(safePar, p, q, cap);
      candidates.push({
        p,
        q,
        values: distribution.values,
        weights: distribution.weights,
        mean: distribution.mean,
        stdDev: distribution.stdDev
      });
    }
  }
  return candidates;
}

const HARDY_CANDIDATES_BY_PAR = {
  3: buildHardyCandidatesForPar(3),
  4: buildHardyCandidatesForPar(4),
  5: buildHardyCandidatesForPar(5)
};

function hardyCandidateForTarget(par, targetMean, targetSigma) {
  const safePar = Number(par) === 3 || Number(par) === 5 ? Number(par) : 4;
  const meanKey = quantize(targetMean, 0.05).toFixed(2);
  const sigmaKey = quantize(targetSigma, 0.05).toFixed(2);
  const key = `${safePar}|${meanKey}|${sigmaKey}`;
  const cached = HARDY_TARGET_CACHE.get(key);
  if (cached) return cached;

  const candidates = HARDY_CANDIDATES_BY_PAR[safePar] || HARDY_CANDIDATES_BY_PAR[4];
  const goalMean = Math.max(1, Number(targetMean) || safePar);
  const goalSigma = Math.max(0.2, Number(targetSigma) || 0.8);
  let best = candidates[0];
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const meanError = (candidate.mean - goalMean) / 0.08;
    const sigmaError = (candidate.stdDev - goalSigma) / 0.14;
    const score = (meanError * meanError * 5) + (sigmaError * sigmaError);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  HARDY_TARGET_CACHE.set(key, best);
  return best;
}

function hardyDistributionFromParams(par, params) {
  const safePar = Number(par) || 4;
  const normalized = normalizeHardyParams(params?.p, params?.q);
  const distribution = hardyScoreDistribution(safePar, normalized.p, normalized.q, holeUpperBound(safePar));
  return {
    ...distribution,
    p: normalized.p,
    q: normalized.q
  };
}

function discreteDistributionStats(values, weights) {
  const cleanValues = [];
  const cleanWeights = [];
  let totalWeight = 0;

  for (let idx = 0; idx < (values || []).length; idx++) {
    const value = Number(values[idx]);
    const weight = Number(weights?.[idx] || 0);
    if (!Number.isFinite(value) || !Number.isFinite(weight) || weight <= 0) continue;
    cleanValues.push(value);
    cleanWeights.push(weight);
    totalWeight += weight;
  }

  if (!cleanValues.length || totalWeight <= 0) return null;
  const normalizedWeights = cleanWeights.map((weight) => weight / totalWeight);
  const mean = cleanValues.reduce((sum, value, idx) => sum + (value * normalizedWeights[idx]), 0);
  const variance = cleanValues.reduce(
    (sum, value, idx) => sum + (((value - mean) ** 2) * normalizedWeights[idx]),
    0
  );

  return {
    values: cleanValues,
    weights: normalizedWeights,
    mean,
    stdDev: Math.sqrt(Math.max(variance, 0.0001))
  };
}

function minScoreDistribution(distributions) {
  const clean = (distributions || []).filter(
    (distribution) => Array.isArray(distribution?.values) && Array.isArray(distribution?.weights) && distribution.values.length
  );
  if (!clean.length) return null;
  if (clean.length === 1) return clean[0];

  const supportMax = clean.reduce(
    (maxValue, distribution) => Math.max(maxValue, ...distribution.values.map((value) => Math.round(Number(value) || 0))),
    0
  );
  const supportMin = clean.reduce(
    (minValue, distribution) => Math.min(minValue, ...distribution.values.map((value) => Math.round(Number(value) || 0))),
    Number.POSITIVE_INFINITY
  );
  if (!Number.isFinite(supportMin) || !Number.isFinite(supportMax) || supportMin > supportMax) return clean[0];

  const survivalByDistribution = clean.map((distribution) => {
    const pmf = Array(supportMax + 2).fill(0);
    distribution.values.forEach((value, idx) => {
      const score = clamp(Math.round(Number(value) || 0), 0, supportMax + 1);
      pmf[score] += Number(distribution.weights[idx] || 0);
    });
    for (let score = supportMax; score >= 0; score--) {
      pmf[score] += Number(pmf[score + 1] || 0);
    }
    return pmf;
  });

  const values = [];
  const weights = [];
  for (let score = supportMin; score <= supportMax; score++) {
    const survivalHere = survivalByDistribution.reduce((product, survival) => product * Number(survival[score] || 0), 1);
    const survivalNext = survivalByDistribution.reduce((product, survival) => product * Number(survival[score + 1] || 0), 1);
    const probability = Math.max(0, survivalHere - survivalNext);
    if (probability <= 0) continue;
    values.push(score);
    weights.push(probability);
  }

  return discreteDistributionStats(values, weights) || clean[0];
}

function sampleHoleFromDistribution(distribution, rng, maxScore = null) {
  const sampled = sampleDiscrete(distribution?.values || [], distribution?.weights || [], rng);
  return clamp(
    sampled,
    1,
    Math.max(1, Math.round(Number(maxScore) || Math.max(...(distribution?.values || [1]))))
  );
}

function sampleGolfHoleGross(par, params, rng, maxScore = holeUpperBound(par)) {
  const distribution = hardyDistributionFromParams(par, params);
  return clamp(
    sampleDiscrete(distribution.values, distribution.weights, rng),
    1,
    Math.max(1, Math.round(Number(maxScore) || holeUpperBound(par)))
  );
}

function sumPlayed(arr) {
  return (arr || []).reduce((total, value) => {
    if (value == null) return total;
    const n = Number(value);
    return Number.isFinite(n) ? total + n : total;
  }, 0);
}

function hasPlayedScore(value) {
  return value != null && Number.isFinite(Number(value)) && Number(value) > 0;
}

function normalizeGrossArray(arr) {
  return Array.from({ length: HOLE_COUNT }, (_, idx) => {
    const n = Number(arr?.[idx]);
    return Number.isFinite(n) && n > 0 ? n : null;
  });
}

function normalizeNumberArray(arr, fallback = 0) {
  return Array.from({ length: HOLE_COUNT }, (_, idx) => {
    const n = Number(arr?.[idx]);
    return Number.isFinite(n) ? n : fallback;
  });
}

function normalizeNetArray(arr, gross, handicapShots) {
  return Array.from({ length: HOLE_COUNT }, (_, idx) => {
    const explicit = Number(arr?.[idx]);
    if (Number.isFinite(explicit)) return explicit;
    const grossValue = gross[idx];
    if (!Number.isFinite(Number(grossValue))) return null;
    return Number(grossValue) - Number(handicapShots?.[idx] || 0);
  });
}

function normalizeTwoManFormat(format) {
  const fmt = String(format || "").trim().toLowerCase();
  if (fmt === "two_man") return "two_man_scramble";
  if (fmt === "two_man_scramble" || fmt === "two_man_shamble" || fmt === "two_man_best_ball") return fmt;
  return "";
}

function isTwoManScrambleFormat(format) {
  return normalizeTwoManFormat(format) === "two_man_scramble";
}

function isTwoManPlayerFormat(format) {
  const normalized = normalizeTwoManFormat(format);
  return normalized === "two_man_shamble" || normalized === "two_man_best_ball";
}

function isTeamBestBallFormat(format) {
  const fmt = String(format || "").trim().toLowerCase();
  return fmt === "team_best_ball" || fmt === "team_bestball";
}

function normalizeTeamAggregation(agg) {
  let topX = Number(agg?.topX ?? 4);
  if (!Number.isFinite(topX) || topX <= 0) topX = 4;
  return { topX: Math.round(topX) };
}

function defaultCourseObject() {
  return {
    pars: Array(HOLE_COUNT).fill(4),
    strokeIndex: Array.from({ length: HOLE_COUNT }, (_, idx) => idx + 1)
  };
}

function normalizeCourse(course) {
  const pars = Array.isArray(course?.pars) && course.pars.length === HOLE_COUNT
    ? course.pars.map((value) => Number(value) || 4)
    : null;
  const strokeIndex = Array.isArray(course?.strokeIndex) && course.strokeIndex.length === HOLE_COUNT
    ? course.strokeIndex.map((value) => Number(value) || 0)
    : null;
  if (!pars || !strokeIndex) return null;
  const holeYardages = Array.isArray(course?.holeYardages) && course.holeYardages.length === HOLE_COUNT
    ? course.holeYardages.map((value) => {
        const n = Number(value);
        return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
      })
    : null;
  const ratings = Array.isArray(course?.ratings)
    ? course.ratings
        .map((entry) => {
          const rating = Number(entry?.rating);
          const slope = Number(entry?.slope);
          const gender = String(entry?.gender || "").trim().toUpperCase();
          if (!gender && !Number.isFinite(rating) && !Number.isFinite(slope)) return null;
          return {
            ...(gender ? { gender } : {}),
            ...(Number.isFinite(rating) ? { rating: Number(rating.toFixed(1)) } : {}),
            ...(Number.isFinite(slope) ? { slope: Math.round(slope) } : {})
          };
        })
        .filter(Boolean)
    : [];
  return {
    ...(course?.name ? { name: String(course.name) } : {}),
    ...(course?.teeName ? { teeName: String(course.teeName) } : {}),
    ...(Number.isFinite(Number(course?.totalYards)) ? { totalYards: Math.max(0, Math.round(Number(course.totalYards))) } : {}),
    ...(holeYardages ? { holeYardages } : {}),
    ...(ratings.length ? { ratings } : {}),
    pars,
    strokeIndex
  };
}

function courseListFromTournament(tournamentJson) {
  const courses = Array.isArray(tournamentJson?.courses)
    ? tournamentJson.courses.map((course) => normalizeCourse(course)).filter(Boolean)
    : [];
  if (courses.length) return courses;
  const legacy = normalizeCourse(tournamentJson?.course);
  if (legacy) return [legacy];
  return [defaultCourseObject()];
}

function courseForRoundIndex(tournamentJson, roundIndex) {
  const courses = courseListFromTournament(tournamentJson);
  const defaultCourse = courses[0] || defaultCourseObject();
  const rounds = tournamentJson?.tournament?.rounds || [];
  const rawIndex = Number(rounds?.[roundIndex]?.courseIndex);
  const courseIndex = Number.isInteger(rawIndex) && rawIndex >= 0 && rawIndex < courses.length ? rawIndex : 0;
  return courses[courseIndex] || defaultCourse;
}

function normalizeGroupKey(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 16);
}

function groupValueForRound(player, roundIndex) {
  const idx = Math.max(0, Math.floor(Number(roundIndex) || 0));
  if (Array.isArray(player?.groups)) {
    const value = normalizeGroupKey(player.groups[idx]);
    if (value) return value;
  }
  if (idx === 0) return normalizeGroupKey(player?.group);
  return "";
}

function twoManGroupId(teamId, groupKey) {
  const team = String(teamId || "").trim();
  const group = normalizeGroupKey(groupKey);
  if (!team || !group) return "";
  return `${team}::${group}`;
}

function playerNameMap(tournamentJson) {
  const out = new Map();
  (tournamentJson?.players || []).forEach((player) => {
    const playerId = String(player?.playerId || "").trim();
    if (!playerId) return;
    out.set(playerId, player?.name || playerId);
  });
  return out;
}

function playerMetaMap(tournamentJson) {
  const out = new Map();
  (tournamentJson?.players || []).forEach((player) => {
    const playerId = String(player?.playerId || "").trim();
    if (!playerId) return;
    out.set(playerId, player || {});
  });
  return out;
}

function playersByTeamMap(tournamentJson) {
  const out = new Map();
  (tournamentJson?.players || []).forEach((player) => {
    const teamId = String(player?.teamId || "").trim();
    const playerId = String(player?.playerId || "").trim();
    if (!teamId || !playerId) return;
    if (!out.has(teamId)) out.set(teamId, []);
    out.get(teamId).push(playerId);
  });
  return out;
}

function groupKeysForTeamRound(tournamentJson, roundIndex, teamId, teamEntry = {}) {
  const out = new Set();
  Object.keys(teamEntry?.groups || {}).forEach((raw) => {
    const key = normalizeGroupKey(raw);
    if (key) out.add(key);
  });

  const teamDef = (tournamentJson?.teams || []).find((team) => String(team?.teamId ?? team?.id ?? "").trim() === String(teamId || "").trim());
  const fromTeamDef = teamDef?.groupsByRound?.[String(roundIndex)] || teamDef?.groups || {};
  Object.keys(fromTeamDef || {}).forEach((raw) => {
    const key = normalizeGroupKey(raw);
    if (key) out.add(key);
  });

  (tournamentJson?.players || []).forEach((player) => {
    if (String(player?.teamId || "").trim() !== String(teamId || "").trim()) return;
    const key = groupValueForRound(player, roundIndex);
    if (key) out.add(key);
  });

  return Array.from(out).sort((a, b) => a.localeCompare(b));
}

function playerIdsForGroup(tournamentJson, roundIndex, teamId, groupKey, fallback = []) {
  const seeded = Array.isArray(fallback)
    ? fallback.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  if (seeded.length) return Array.from(new Set(seeded));

  const teamDef = (tournamentJson?.teams || []).find((team) => String(team?.teamId ?? team?.id ?? "").trim() === String(teamId || "").trim());
  const fromTeam = teamDef?.groupsByRound?.[String(roundIndex)]?.[groupKey] || teamDef?.groups?.[groupKey];
  if (Array.isArray(fromTeam) && fromTeam.length) {
    return Array.from(new Set(fromTeam.map((value) => String(value || "").trim()).filter(Boolean)));
  }

  return Array.from(
    new Set(
      (tournamentJson?.players || [])
        .filter(
          (player) =>
            String(player?.teamId || "").trim() === String(teamId || "").trim() &&
            groupValueForRound(player, roundIndex) === groupKey
        )
        .map((player) => String(player?.playerId || "").trim())
        .filter(Boolean)
    )
  );
}

function groupDisplayName(playerIds, nameById, groupKey) {
  const names = [];
  const seen = new Set();
  (playerIds || []).forEach((playerId) => {
    const name = String(nameById.get(String(playerId || "").trim()) || "").trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  });
  if (names.length) return names.join("/");
  return groupKey ? `Group ${groupKey}` : "Group";
}

function strokesFromHandicapShots(handicapShots) {
  return normalizeNumberArray(handicapShots, 0).reduce((total, value) => total + Number(value || 0), 0);
}

function effectiveHandicapValue(value, multiplier = 1) {
  return Math.max(0, Math.round((Number(value) || 0) * Number(multiplier || 0)));
}

function handicapShotsForHandicap(handicap, strokeIndex18) {
  const normalizedStrokeIndex = normalizeNumberArray(strokeIndex18, 0);
  const totalHandicap = Math.max(0, Math.floor(Number(handicap) || 0));
  const base = Math.floor(totalHandicap / HOLE_COUNT);
  const remainder = totalHandicap % HOLE_COUNT;
  return normalizedStrokeIndex.map((strokeIndex) => base + (Number(strokeIndex || 0) <= remainder ? 1 : 0));
}

function difficultyZ(strokeIndex) {
  const difficultyRank = 19 - Number(strokeIndex || 0);
  return (difficultyRank - STROKE_Z_MEAN) / STROKE_Z_STD;
}

function courseParTotal(course) {
  return (course?.pars || []).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

function courseRatingSummary(course) {
  const ratings = Array.isArray(course?.ratings) ? course.ratings : [];
  return {
    rating: averageFinite(ratings.map((entry) => entry?.rating)),
    slope: averageFinite(ratings.map((entry) => entry?.slope))
  };
}

function holeYardageDifficultyByPar(course) {
  const pars = Array.isArray(course?.pars) ? course.pars : Array(HOLE_COUNT).fill(4);
  const yardages = Array.isArray(course?.holeYardages) && course.holeYardages.length === HOLE_COUNT
    ? course.holeYardages.map((value) => {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? n : null;
      })
    : Array(HOLE_COUNT).fill(null);

  return Array.from({ length: HOLE_COUNT }, (_, holeIndex) => {
    const par = Number(pars[holeIndex] || 4);
    const yardage = yardages[holeIndex];
    if (!Number.isFinite(yardage)) return 0;

    const sameParYardages = yardages.filter((value, idx) => Number(pars[idx] || 4) === par && Number.isFinite(value));
    if (sameParYardages.length >= 2) {
      const mean = sameParYardages.reduce((sum, value) => sum + value, 0) / sameParYardages.length;
      const variance = sameParYardages.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / sameParYardages.length;
      const stdDev = Math.sqrt(Math.max(variance, 1));
      return clamp((yardage - mean) / stdDev, -2.5, 2.5);
    }

    const fallbackMean = { 3: 170, 4: 390, 5: 520 }[par] || 390;
    const fallbackStd = { 3: 25, 4: 45, 5: 60 }[par] || 45;
    return clamp((yardage - fallbackMean) / fallbackStd, -2.5, 2.5);
  });
}

function buildCourseDifficultyModel(course) {
  const pars = Array.isArray(course?.pars) ? course.pars : Array(HOLE_COUNT).fill(4);
  const strokeIndex = Array.isArray(course?.strokeIndex) ? course.strokeIndex : Array.from({ length: HOLE_COUNT }, (_, idx) => idx + 1);
  const parTotal = courseParTotal(course);
  const { rating, slope } = courseRatingSummary(course);
  const yardageDifficulty = holeYardageDifficultyByPar(course);
  const scratchDeltaTotal = Number.isFinite(rating) ? clamp(rating - parTotal, -6, 10) : 0;
  const slopeFactor = clamp((Number.isFinite(slope) ? slope : 113) / 113, 0.85, 1.35);
  const weightBase = Array.from({ length: HOLE_COUNT }, (_, holeIndex) => {
    const difficulty = Math.max(0, difficultyZ(strokeIndex[holeIndex]));
    const yardage = Number(yardageDifficulty[holeIndex] || 0);
    return Math.max(0.2, 1 + (0.3 * difficulty) + (0.25 * Math.max(yardage, 0)) + (0.1 * Math.abs(yardage)));
  });
  const weightTotal = weightBase.reduce((sum, value) => sum + value, 0) || HOLE_COUNT;
  const scratchShiftByHole = Array.from({ length: HOLE_COUNT }, (_, holeIndex) =>
    scratchDeltaTotal * (weightBase[holeIndex] / weightTotal)
  );

  return {
    rating,
    slope: Number.isFinite(slope) ? slope : 113,
    slopeFactor,
    yardageDifficulty,
    yardageMeanShift: yardageDifficulty.map((value) => Number(value || 0) * YARDAGE_MEAN_SHIFT_PER_Z),
    scratchShiftByHole
  };
}

function holeSigmaTarget(par, effectiveHandicap, strokeIndex, courseDifficulty, holeIndex) {
  const z = difficultyZ(strokeIndex);
  const slopeFactor = Number(courseDifficulty?.slopeFactor || 1);
  const yardageDifficulty = Math.abs(Number(courseDifficulty?.yardageDifficulty?.[holeIndex] || 0));
  return (
    (
      Number(PAR_SIGMA[par] || 0.8)
      + (0.02 * Number(effectiveHandicap || 0) * slopeFactor)
      + (0.05 * Math.abs(z))
      + (YARDAGE_SIGMA_SHIFT_PER_Z * yardageDifficulty)
      + (SLOPE_SIGMA_SHIFT_FACTOR * Math.max(0, slopeFactor - 1))
    ) *
    HOLE_SIGMA_MULTIPLIER
  );
}

function baselineOverParFromLookup(handicapIndex, strokeIndex) {
  const normalizedHandicap = Math.max(0, Number(handicapIndex) || 0);
  const rowIndex = clamp(Math.round(Number(strokeIndex) || 1), 1, HOLE_COUNT) - 1;
  const row = BASELINE_OVER_PAR_BY_STROKE_INDEX[rowIndex] || BASELINE_OVER_PAR_BY_STROKE_INDEX[HOLE_COUNT - 1];

  if (normalizedHandicap <= BASELINE_HANDICAP_ANCHORS[0]) return Number(row[0] || 0);
  const lastAnchorIndex = BASELINE_HANDICAP_ANCHORS.length - 1;
  if (normalizedHandicap >= BASELINE_HANDICAP_ANCHORS[lastAnchorIndex]) {
    const loAnchor = BASELINE_HANDICAP_ANCHORS[lastAnchorIndex - 1];
    const hiAnchor = BASELINE_HANDICAP_ANCHORS[lastAnchorIndex];
    const loValue = Number(row[lastAnchorIndex - 1] || 0);
    const hiValue = Number(row[lastAnchorIndex] || 0);
    const slope = (hiValue - loValue) / Math.max(hiAnchor - loAnchor, 1);
    return hiValue + ((normalizedHandicap - hiAnchor) * slope);
  }

  for (let idx = 1; idx < BASELINE_HANDICAP_ANCHORS.length; idx++) {
    const loAnchor = BASELINE_HANDICAP_ANCHORS[idx - 1];
    const hiAnchor = BASELINE_HANDICAP_ANCHORS[idx];
    if (normalizedHandicap > hiAnchor) continue;
    const loValue = Number(row[idx - 1] || 0);
    const hiValue = Number(row[idx] || 0);
    const ratio = (normalizedHandicap - loAnchor) / Math.max(hiAnchor - loAnchor, 1);
    return loValue + ((hiValue - loValue) * ratio);
  }

  return Number(row[lastAnchorIndex] || 0);
}

function buildHoleBaselines(course, courseDifficulty) {
  return Array.from({ length: HOLE_COUNT }, (_, holeIndex) => {
    const par = Number(course?.pars?.[holeIndex] || 4);
    const strokeIndex = Number(course?.strokeIndex?.[holeIndex] || holeIndex + 1);
    const targetMean =
      par
      + baselineOverParFromLookup(BASELINE_REFERENCE_HANDICAP, strokeIndex)
      + Number(courseDifficulty?.scratchShiftByHole?.[holeIndex] || 0)
      + Number(courseDifficulty?.yardageMeanShift?.[holeIndex] || 0);
    const targetSigma = holeSigmaTarget(par, BASELINE_REFERENCE_HANDICAP, strokeIndex, courseDifficulty, holeIndex);
    const candidate = hardyCandidateForTarget(par, targetMean, targetSigma);
    return {
      holeIndex,
      par,
      strokeIndex,
      referenceMean: candidate.mean,
      referenceSigma: candidate.stdDev,
      params: { p: candidate.p, q: candidate.q }
    };
  });
}

function skillShiftByPar(course, holeBaselines, courseDifficulty, effectiveHandicap) {
  const shifts = new Map();
  for (const par of [3, 4, 5]) {
    const parHoles = holeBaselines.filter((hole) => hole.par === par);
    if (!parHoles.length) {
      shifts.set(par, { pShift: 0, qShift: 0 });
      continue;
    }

    const targetMean = parHoles.reduce(
      (sum, hole) => {
        const referenceOverPar = baselineOverParFromLookup(BASELINE_REFERENCE_HANDICAP, hole.strokeIndex);
        const handicapOverPar = baselineOverParFromLookup(effectiveHandicap, hole.strokeIndex);
        const slopeAdjustedOverPar = referenceOverPar + ((handicapOverPar - referenceOverPar) * Number(courseDifficulty?.slopeFactor || 1));
        return sum
          + par
          + slopeAdjustedOverPar
          + Number(courseDifficulty?.scratchShiftByHole?.[hole.holeIndex] || 0)
          + Number(courseDifficulty?.yardageMeanShift?.[hole.holeIndex] || 0);
      },
      0
    ) / parHoles.length;
    const targetSigma = parHoles.reduce(
      (sum, hole) => sum + holeSigmaTarget(par, effectiveHandicap, hole.strokeIndex, courseDifficulty, hole.holeIndex),
      0
    ) / parHoles.length;
    const referenceMean = parHoles.reduce((sum, hole) => sum + hole.referenceMean, 0) / parHoles.length;
    const referenceSigma = parHoles.reduce((sum, hole) => sum + hole.referenceSigma, 0) / parHoles.length;

    const referenceCandidate = hardyCandidateForTarget(par, referenceMean, referenceSigma);
    const handicapCandidate = hardyCandidateForTarget(par, targetMean, targetSigma);
    shifts.set(par, {
      pShift: logitProb(handicapCandidate.p) - logitProb(referenceCandidate.p),
      qShift: logitProb(handicapCandidate.q) - logitProb(referenceCandidate.q)
    });
  }
  return shifts;
}

function buildHoleDistribution(holeBaseline, parSkillShift, extraShift) {
  const combinedShift = mergeHardyShifts(parSkillShift, extraShift);
  const params = shiftHardyParams(holeBaseline.params, combinedShift);
  return hardyDistributionFromParams(holeBaseline.par, params);
}

function holeUpperBound(par) {
  const safePar = Number(par) || 4;
  return Math.max(safePar + 5, 8);
}

function xmur3(value) {
  let hash = 1779033703 ^ String(value || "").length;
  for (let i = 0; i < String(value || "").length; i++) {
    hash = Math.imul(hash ^ String(value || "").charCodeAt(i), 3432918353);
    hash = (hash << 13) | (hash >>> 19);
  }
  return function next() {
    hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
    hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
    return (hash ^= hash >>> 16) >>> 0;
  };
}

function sfc32(a, b, c, d) {
  return function next() {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const out = (t + d) | 0;
    c = (c + out) | 0;
    return (out >>> 0) / 4294967296;
  };
}

function createSeededRng(seedText) {
  const seedFactory = xmur3(seedText);
  const nextUniform = sfc32(seedFactory(), seedFactory(), seedFactory(), seedFactory());
  let spareNormal = null;
  return {
    next() {
      return nextUniform();
    },
    normal() {
      if (spareNormal != null) {
        const value = spareNormal;
        spareNormal = null;
        return value;
      }
      let u = 0;
      let v = 0;
      while (u === 0) u = nextUniform();
      while (v === 0) v = nextUniform();
      const mag = Math.sqrt(-2.0 * Math.log(u));
      spareNormal = mag * Math.sin(2.0 * Math.PI * v);
      return mag * Math.cos(2.0 * Math.PI * v);
    }
  };
}

function buildUnitPriors(units, course) {
  const courseDifficulty = buildCourseDifficultyModel(course);
  const holeBaselines = buildHoleBaselines(course, courseDifficulty);
  const liveHoleActualTotals = Array(HOLE_COUNT).fill(0);
  const liveHoleExpectedTotals = Array(HOLE_COUNT).fill(0);
  const liveHoleCounts = Array(HOLE_COUNT).fill(0);

  for (const unit of units) {
    const playerHandicaps = Array.isArray(unit.playerHandicaps)
      ? unit.playerHandicaps.map((value) => Math.max(0, Number(value) || 0)).filter(Number.isFinite)
      : [];
    const useScrambleModel = unit.modelType === "scramble" && playerHandicaps.length > 0;
    const effectiveHandicap = strokesFromHandicapShots(unit.handicapShots);
    const parSkillShift = useScrambleModel
      ? null
      : skillShiftByPar(course, holeBaselines, courseDifficulty, effectiveHandicap);
    const scramblePlayerSkillShifts = useScrambleModel
      ? playerHandicaps.map((handicap) => skillShiftByPar(course, holeBaselines, courseDifficulty, handicap))
      : [];
    const baselineMeans = Array(HOLE_COUNT).fill(0);

    for (let holeIndex = 0; holeIndex < HOLE_COUNT; holeIndex++) {
      const holeBaseline = holeBaselines[holeIndex];
      const distribution = useScrambleModel
        ? minScoreDistribution(
            scramblePlayerSkillShifts.map((shiftMap) =>
              buildHoleDistribution(holeBaseline, shiftMap.get(holeBaseline.par), null)
            )
          )
        : buildHoleDistribution(
            holeBaseline,
            parSkillShift.get(holeBaseline.par),
            null
          );
      baselineMeans[holeIndex] = distribution.mean;

      const gross = unit.gross[holeIndex];
      if (!hasPlayedScore(gross)) continue;
      liveHoleActualTotals[holeIndex] += Number(gross);
      liveHoleExpectedTotals[holeIndex] += distribution.mean;
      liveHoleCounts[holeIndex] += 1;
    }

    unit.effectiveHandicap = effectiveHandicap;
    unit.parSkillShift = parSkillShift;
    unit.scramblePlayerSkillShifts = scramblePlayerSkillShifts;
    unit.baselineMeans = baselineMeans;
  }

  const liveHoleShift = Array.from({ length: HOLE_COUNT }, (_, holeIndex) => {
    const count = liveHoleCounts[holeIndex];
    if (!count) return { pShift: 0, qShift: 0 };
    const residual = (liveHoleActualTotals[holeIndex] - liveHoleExpectedTotals[holeIndex]) / count;
    const shrinkResidual = residual * (count / (count + LIVE_HOLE_SHRINKAGE)) * LIVE_HOLE_EFFECT_MULTIPLIER;
    return hardyShiftFromStrokeDelta(shrinkResidual, LIVE_SHIFT_SCALES);
  });

  for (const unit of units) {
    const priorGrossMeans = Array(HOLE_COUNT).fill(0);
    const priorGrossSigmas = Array(HOLE_COUNT).fill(0);
    const priorHoleDistributions = Array(HOLE_COUNT).fill(null);
    const priorHoleParams = Array(HOLE_COUNT).fill(null);
    const priorPlayerHoleParams = Array(HOLE_COUNT).fill(null);
    const preFormMeans = Array(HOLE_COUNT).fill(0);
    const useScrambleModel = unit.modelType === "scramble" && Array.isArray(unit.scramblePlayerSkillShifts) && unit.scramblePlayerSkillShifts.length > 0;

    for (let holeIndex = 0; holeIndex < HOLE_COUNT; holeIndex++) {
      const holeBaseline = holeBaselines[holeIndex];
      const distribution = useScrambleModel
        ? minScoreDistribution(
            unit.scramblePlayerSkillShifts.map((shiftMap) =>
              buildHoleDistribution(
                holeBaseline,
                shiftMap.get(holeBaseline.par),
                liveHoleShift[holeIndex]
              )
            )
          )
        : buildHoleDistribution(
            holeBaseline,
            unit.parSkillShift.get(holeBaseline.par),
            liveHoleShift[holeIndex]
          );
      preFormMeans[holeIndex] = distribution.mean;
    }

    let playedHoles = 0;
    let actualToPar = 0;
    let priorToPar = 0;
    for (let holeIndex = 0; holeIndex < HOLE_COUNT; holeIndex++) {
      const gross = unit.gross[holeIndex];
      if (!hasPlayedScore(gross)) continue;
      const par = Number(course?.pars?.[holeIndex] || 4);
      actualToPar += Number(gross) - par;
      priorToPar += preFormMeans[holeIndex] - par;
      playedHoles += 1;
    }

    const rawFormDelta = playedHoles > 0
      ? (actualToPar - priorToPar) / playedHoles
      : 0;
    const shrunkenFormDelta =
      rawFormDelta
      * (playedHoles / (playedHoles + FORM_SHRINKAGE))
      * FORM_EFFECT_MULTIPLIER;
    const cappedFormDelta = clamp(shrunkenFormDelta, -FORM_EFFECT_CAP, FORM_EFFECT_CAP);
    const formShift = hardyShiftFromStrokeDelta(cappedFormDelta, FORM_SHIFT_SCALES);

    for (let holeIndex = 0; holeIndex < HOLE_COUNT; holeIndex++) {
      const holeBaseline = holeBaselines[holeIndex];
      const playerDistributions = useScrambleModel
        ? unit.scramblePlayerSkillShifts.map((shiftMap) =>
            buildHoleDistribution(
              holeBaseline,
              shiftMap.get(holeBaseline.par),
              mergeHardyShifts(liveHoleShift[holeIndex], formShift)
            )
          )
        : null;
      const distribution = useScrambleModel
        ? minScoreDistribution(playerDistributions)
        : buildHoleDistribution(
            holeBaseline,
            unit.parSkillShift.get(holeBaseline.par),
            mergeHardyShifts(liveHoleShift[holeIndex], formShift)
          );
      priorHoleParams[holeIndex] = distribution?.p != null && distribution?.q != null
        ? { p: distribution.p, q: distribution.q }
        : null;
      priorPlayerHoleParams[holeIndex] = playerDistributions
        ? playerDistributions.map((playerDistribution) => ({ p: playerDistribution.p, q: playerDistribution.q }))
        : null;
      priorHoleDistributions[holeIndex] = distribution;
      priorGrossMeans[holeIndex] = distribution.mean;
      priorGrossSigmas[holeIndex] = distribution.stdDev;
    }

    unit.priorPlayerHoleParams = priorPlayerHoleParams;
    unit.priorHoleDistributions = priorHoleDistributions;
    unit.priorHoleParams = priorHoleParams;
    unit.priorGrossMeans = priorGrossMeans;
    unit.priorGrossSigmas = priorGrossSigmas;
    unit.formAdjustment = cappedFormDelta;
  }
}

function cloneUnitState(unit) {
  return {
    id: unit.id,
    name: unit.name,
    entityType: unit.entityType,
    teamId: unit.teamId,
    teamName: unit.teamName,
    playerIds: Array.isArray(unit.playerIds) ? unit.playerIds.slice() : [],
    playerId: unit.playerId || null,
    groupId: unit.groupId || null,
    groupKey: unit.groupKey || null,
    gross: unit.gross.slice(),
    net: unit.net.slice(),
    handicapShots: unit.handicapShots.slice()
  };
}

function sampleUnplayedHoles(context, rng) {
  const simulatedUnits = [];
  for (const unit of context.units) {
    const nextUnit = cloneUnitState(unit);
    const roundShock = rng.normal() * 0.18;
    const roundShockShift = hardyShiftFromStrokeDelta(roundShock, ROUND_SHOCK_SHIFT_SCALES);
    for (let holeIndex = 0; holeIndex < HOLE_COUNT; holeIndex++) {
      if (hasPlayedScore(nextUnit.gross[holeIndex])) continue;
      const par = Number(context.course?.pars?.[holeIndex] || 4);
      const maxGrossRaw = context.maxGrossByHole?.[holeIndex];
      const maxGross = maxGrossRaw == null ? null : Number(maxGrossRaw);
      const scramblePlayerParams = unit.priorPlayerHoleParams?.[holeIndex];
      const baseDistribution = Array.isArray(scramblePlayerParams) && scramblePlayerParams.length
        ? minScoreDistribution(
            scramblePlayerParams.map((params) =>
              hardyDistributionFromParams(par, shiftHardyParams(params, roundShockShift))
            )
          )
        : unit.priorHoleDistributions?.[holeIndex];
      const sampledGross = baseDistribution?.values?.length
        ? sampleHoleFromDistribution(baseDistribution, rng, maxGross)
        : sampleGolfHoleGross(par, shiftHardyParams(unit.priorHoleParams?.[holeIndex], roundShockShift), rng, maxGross);
      nextUnit.gross[holeIndex] = sampledGross;
      nextUnit.net[holeIndex] = sampledGross - Number(nextUnit.handicapShots?.[holeIndex] || 0);
    }
    simulatedUnits.push(nextUnit);
  }
  return simulatedUnits;
}

function entityTotalsFromHoles(gross, net, par, stablefordOverrides = null) {
  let grossToParTotal = 0;
  let netToParTotal = 0;
  let thru = 0;
  for (let holeIndex = 0; holeIndex < HOLE_COUNT; holeIndex++) {
    const grossValue = playedHoleScore(gross[holeIndex]);
    const netValue = playedHoleScore(net[holeIndex]);
    const holePar = Number(par?.[holeIndex] || 0);
    if (grossValue != null || netValue != null) thru += 1;
    if (grossValue != null) grossToParTotal += Number(grossValue) - holePar;
    if (netValue != null) netToParTotal += Number(netValue) - holePar;
  }
  const grossStableford = Array.isArray(stablefordOverrides?.gross)
    ? stablefordOverrides.gross.slice()
    : stablefordPointsArray(gross, par);
  const netStableford = Array.isArray(stablefordOverrides?.net)
    ? stablefordOverrides.net.slice()
    : stablefordPointsArray(net, par);
  return {
    grossTotal: sumPlayed(gross),
    netTotal: sumPlayed(net),
    grossToParTotal,
    netToParTotal,
    grossStableford,
    netStableford,
    grossStablefordTotal: sumPlayed(grossStableford),
    netStablefordTotal: sumPlayed(netStableford),
    thru
  };
}

function groupById(entries, key) {
  const out = new Map();
  for (const entry of entries || []) {
    const value = String(entry?.[key] || "").trim();
    if (!value) continue;
    if (!out.has(value)) out.set(value, []);
    out.get(value).push(entry);
  }
  return out;
}

function bestXByMetric(entries, topX, metricKey, direction = "low") {
  const sorted = (entries || [])
    .filter((entry) => Number.isFinite(Number(entry?.[metricKey])))
    .slice()
    .sort((a, b) => {
      const delta = Number(a[metricKey]) - Number(b[metricKey]);
      return direction === "high" ? -delta : delta;
    });
  return sorted.slice(0, Math.min(topX, sorted.length));
}

function emptyHoleArray() {
  return Array(HOLE_COUNT).fill(null);
}

function sumHoleArrays(holeArrays) {
  const out = emptyHoleArray();
  for (let holeIndex = 0; holeIndex < HOLE_COUNT; holeIndex++) {
    let total = 0;
    let count = 0;
    for (const arr of holeArrays || []) {
      const value = arr?.[holeIndex];
      if (value == null) continue;
      total += Number(value);
      count += 1;
    }
    out[holeIndex] = count > 0 ? total : null;
  }
  return out;
}

function bestBallGroupHoles(players, metricKey) {
  const out = emptyHoleArray();
  for (let holeIndex = 0; holeIndex < HOLE_COUNT; holeIndex++) {
    let best = null;
    for (const player of players || []) {
      const value = playedHoleScore(player?.[metricKey]?.[holeIndex]);
      if (value == null) continue;
      if (best == null || Number(value) < best) best = Number(value);
    }
    out[holeIndex] = best;
  }
  return out;
}

function holeHasRecordedScore(entry, holeIndex) {
  return (
    playedHoleScore(entry?.gross?.[holeIndex]) != null ||
    playedHoleScore(entry?.net?.[holeIndex]) != null
  );
}

function everyEntryReadyByHole(entries, readySelector = null) {
  return Array.from({ length: HOLE_COUNT }, (_, holeIndex) => {
    if (!Array.isArray(entries) || !entries.length) return false;
    return entries.every((entry) => (
      typeof readySelector === "function"
        ? readySelector(entry, holeIndex)
        : holeHasRecordedScore(entry, holeIndex)
    ));
  });
}

function evaluateRoundContext(context, unitStates) {
  const coursePar = Array.isArray(context.course?.pars) ? context.course.pars : Array(HOLE_COUNT).fill(4);
  const useHandicap = !!context.useHandicap;
  const scoring = normalizeTournamentScoring(context.scoring);
  const players = new Map();
  const groups = new Map();
  const teams = new Map();
  const unitById = new Map(unitStates.map((unit) => [unit.id, unit]));

  const playerStateEntries = unitStates
    .filter((unit) => unit.entityType === "player")
    .map((unit) => {
      const totals = entityTotalsFromHoles(unit.gross, unit.net, coursePar);
      const entry = {
        entityId: unit.id,
        playerId: unit.playerId || unit.id,
        name: unit.name,
        teamId: unit.teamId,
        teamName: unit.teamName,
        gross: unit.gross,
        net: unit.net,
        handicapShots: unit.handicapShots,
        ...totals
      };
      players.set(entry.playerId, entry);
      return entry;
    });

  if (context.format === "scramble") {
    for (const unit of unitStates) {
      const totals = entityTotalsFromHoles(unit.gross, unit.net, coursePar);
      const teamEntry = {
        entityId: unit.teamId,
        teamId: unit.teamId,
        teamName: unit.teamName,
        gross: unit.gross,
        net: unit.net,
        handicapShots: unit.handicapShots,
        ...totals
      };
      teams.set(unit.teamId, teamEntry);
    }

    for (const player of context.players) {
      const teamEntry = teams.get(player.teamId);
      if (!teamEntry) continue;
      players.set(player.playerId, {
        entityId: player.playerId,
        playerId: player.playerId,
        name: player.name,
        teamId: player.teamId,
        teamName: teamEntry.teamName,
        gross: teamEntry.gross,
        net: teamEntry.net,
        handicapShots: teamEntry.handicapShots,
        grossTotal: teamEntry.grossTotal,
        netTotal: teamEntry.netTotal,
        grossToParTotal: teamEntry.grossToParTotal,
        netToParTotal: teamEntry.netToParTotal,
        grossStableford: teamEntry.grossStableford,
        netStableford: teamEntry.netStableford,
        grossStablefordTotal: teamEntry.grossStablefordTotal,
        netStablefordTotal: teamEntry.netStablefordTotal,
        thru: teamEntry.thru
      });
    }

    return { teams, players, groups };
  }

  if (isTwoManScrambleFormat(context.format)) {
    for (const unit of unitStates) {
      const totals = entityTotalsFromHoles(unit.gross, unit.net, coursePar);
      const groupEntry = {
        entityId: unit.id,
        groupId: unit.groupId || unit.id,
        groupKey: unit.groupKey,
        name: unit.name,
        teamId: unit.teamId,
        teamName: unit.teamName,
        playerIds: unit.playerIds.slice(),
        gross: unit.gross,
        net: unit.net,
        handicapShots: unit.handicapShots,
        ...totals
      };
      groups.set(groupEntry.groupId, groupEntry);
    }

    const groupsByTeam = groupById(Array.from(groups.values()), "teamId");
    for (const team of context.teams) {
      const teamGroups = groupsByTeam.get(team.teamId) || [];
      const gross = sumHoleArrays(teamGroups.map((entry) => entry.gross));
      const net = sumHoleArrays(teamGroups.map((entry) => entry.net));
      const grossStableford = sumHoleArrays(teamGroups.map((entry) => entry.grossStableford));
      const netStableford = sumHoleArrays(teamGroups.map((entry) => entry.netStableford));
      const par = Array.from({ length: HOLE_COUNT }, (_, holeIndex) => {
        let total = 0;
        let count = 0;
        for (const entry of teamGroups) {
          if (entry.gross[holeIndex] == null && entry.net[holeIndex] == null) continue;
          total += Number(entry?.par?.[holeIndex] || coursePar[holeIndex] || 0);
          count += 1;
        }
        return count > 0 ? total : 0;
      });
      const totals = entityTotalsFromHoles(gross, net, par, {
        gross: grossStableford,
        net: netStableford
      });
      const actualReady = everyEntryReadyByHole(teamGroups, (entry, holeIndex) =>
        holeHasRecordedScore(entry, holeIndex)
      );
      teams.set(team.teamId, {
        entityId: team.teamId,
        teamId: team.teamId,
        teamName: team.teamName,
        gross,
        net,
        handicapShots: Array(HOLE_COUNT).fill(0),
        actualReady,
        ...totals
      });
    }

    for (const groupEntry of groups.values()) {
      for (const playerId of groupEntry.playerIds || []) {
        const playerMeta = context.playerById.get(playerId) || {};
        players.set(playerId, {
          entityId: playerId,
          playerId,
          name: playerMeta.name || playerId,
          teamId: groupEntry.teamId,
          teamName: groupEntry.teamName,
          gross: groupEntry.gross,
          net: groupEntry.net,
          handicapShots: groupEntry.handicapShots,
          grossTotal: groupEntry.grossTotal,
          netTotal: groupEntry.netTotal,
          grossToParTotal: groupEntry.grossToParTotal,
          netToParTotal: groupEntry.netToParTotal,
          grossStableford: groupEntry.grossStableford,
          netStableford: groupEntry.netStableford,
          grossStablefordTotal: groupEntry.grossStablefordTotal,
          netStablefordTotal: groupEntry.netStablefordTotal,
          thru: groupEntry.thru
        });
      }
    }

    return { teams, players, groups };
  }

  if (isTwoManPlayerFormat(context.format)) {
    for (const groupDef of context.groupDefs) {
      const groupPlayers = groupDef.playerIds
        .map((playerId) => players.get(playerId))
        .filter(Boolean);

      let gross;
      let net;
      let parMultiplier = 1;
      let stablefordOverrides = null;
      if (normalizeTwoManFormat(context.format) === "two_man_shamble") {
        gross = emptyHoleArray();
        net = emptyHoleArray();
        parMultiplier = Math.max(1, groupPlayers.length);
        const grossStableford = emptyHoleArray();
        const netStableford = emptyHoleArray();
        for (let holeIndex = 0; holeIndex < HOLE_COUNT; holeIndex++) {
          let grossSum = 0;
          let netSum = 0;
          let grossPointSum = 0;
          let netPointSum = 0;
          let allPresent = groupPlayers.length > 0;
          for (const player of groupPlayers) {
            const grossValue = player.gross[holeIndex];
            const netValue = player.net[holeIndex];
            const grossPoints = player.grossStableford?.[holeIndex];
            const netPoints = player.netStableford?.[holeIndex];
            if (grossValue == null || netValue == null || grossPoints == null || netPoints == null) {
              allPresent = false;
              break;
            }
            grossSum += Number(grossValue);
            netSum += Number(netValue);
            grossPointSum += Number(grossPoints);
            netPointSum += Number(netPoints);
          }
          if (allPresent) {
            gross[holeIndex] = grossSum;
            net[holeIndex] = netSum;
            grossStableford[holeIndex] = grossPointSum;
            netStableford[holeIndex] = netPointSum;
          }
        }
        stablefordOverrides = { gross: grossStableford, net: netStableford };
      } else {
        gross = bestBallGroupHoles(groupPlayers, "gross");
        net = bestBallGroupHoles(groupPlayers, "net");
      }

      const par = coursePar.map((value) => Number(value || 0) * parMultiplier);
      const totals = entityTotalsFromHoles(gross, net, par, stablefordOverrides);
      const actualReady = everyEntryReadyByHole(groupPlayers);
      groups.set(groupDef.groupId, {
        entityId: groupDef.groupId,
        groupId: groupDef.groupId,
        groupKey: groupDef.groupKey,
        name: groupDef.name,
        teamId: groupDef.teamId,
        teamName: groupDef.teamName,
        playerIds: groupDef.playerIds.slice(),
        gross,
        net,
        handicapShots: Array(HOLE_COUNT).fill(0),
        actualReady,
        par,
        ...totals
      });
    }

    const groupsByTeam = groupById(Array.from(groups.values()), "teamId");
    for (const team of context.teams) {
      const teamGroups = groupsByTeam.get(team.teamId) || [];
      const gross = sumHoleArrays(teamGroups.map((entry) => entry.gross));
      const net = sumHoleArrays(teamGroups.map((entry) => entry.net));
      const grossStableford = sumHoleArrays(teamGroups.map((entry) => entry.grossStableford));
      const netStableford = sumHoleArrays(teamGroups.map((entry) => entry.netStableford));
      const par = Array.from({ length: HOLE_COUNT }, (_, holeIndex) => {
        let total = 0;
        let count = 0;
        for (const entry of teamGroups) {
          if (entry.gross[holeIndex] == null && entry.net[holeIndex] == null) continue;
          total += Number(entry?.par?.[holeIndex] || 0);
          count += 1;
        }
        return count > 0 ? total : 0;
      });
      const totals = entityTotalsFromHoles(gross, net, par, {
        gross: grossStableford,
        net: netStableford
      });
      const actualReady = everyEntryReadyByHole(teamGroups, (entry, holeIndex) =>
        Array.isArray(entry?.actualReady) ? !!entry.actualReady[holeIndex] : holeHasRecordedScore(entry, holeIndex)
      );
      teams.set(team.teamId, {
        entityId: team.teamId,
        teamId: team.teamId,
        teamName: team.teamName,
        gross,
        net,
        handicapShots: Array(HOLE_COUNT).fill(0),
        actualReady,
        ...totals
      });
    }

    return { teams, players, groups };
  }

  if (isTeamBestBallFormat(context.format)) {
    const { topX } = normalizeTeamAggregation(context.teamAggregation);
    const playersByTeam = groupById(playerStateEntries, "teamId");
    for (const team of context.teams) {
      const teamPlayers = playersByTeam.get(team.teamId) || [];
      const gross = emptyHoleArray();
      const net = emptyHoleArray();
      const grossStableford = emptyHoleArray();
      const netStableford = emptyHoleArray();
      for (let holeIndex = 0; holeIndex < HOLE_COUNT; holeIndex++) {
        const sorted = teamPlayers
          .map((entry) => ({
            gross: entry.gross[holeIndex],
            net: entry.net[holeIndex],
            grossPoints: entry.grossStableford?.[holeIndex],
            netPoints: entry.netStableford?.[holeIndex],
            metric: scoring === "stableford"
              ? (useHandicap ? entry.netStableford?.[holeIndex] : entry.grossStableford?.[holeIndex])
              : (useHandicap ? entry.net[holeIndex] : entry.gross[holeIndex])
          }))
          .filter((entry) => entry.metric != null)
          .sort((a, b) => scoring === "stableford" ? Number(b.metric) - Number(a.metric) : Number(a.metric) - Number(b.metric));
        const take = sorted.slice(0, Math.min(topX, sorted.length));
        if (take.length) {
          gross[holeIndex] = take.reduce((total, entry) => total + Number(entry.gross || 0), 0);
          net[holeIndex] = take.reduce((total, entry) => total + Number(entry.net || 0), 0);
          grossStableford[holeIndex] = take.reduce((total, entry) => total + Number(entry.grossPoints || 0), 0);
          netStableford[holeIndex] = take.reduce((total, entry) => total + Number(entry.netPoints || 0), 0);
        }
      }
      const par = Array.from({ length: HOLE_COUNT }, (_, holeIndex) => {
        const metricCount = (teamPlayers || []).filter((entry) => {
          const metric = scoring === "stableford"
            ? (useHandicap ? entry.netStableford?.[holeIndex] : entry.grossStableford?.[holeIndex])
            : (useHandicap ? entry.net[holeIndex] : entry.gross[holeIndex]);
          return metric != null;
        }).length;
        return Number(coursePar[holeIndex] || 0) * Math.min(topX, metricCount);
      });
      const totals = entityTotalsFromHoles(gross, net, par, {
        gross: grossStableford,
        net: netStableford
      });
      const actualReady = everyEntryReadyByHole(teamPlayers);
      teams.set(team.teamId, {
        entityId: team.teamId,
        teamId: team.teamId,
        teamName: team.teamName,
        gross,
        net,
        handicapShots: Array(HOLE_COUNT).fill(0),
        actualReady,
        ...totals
      });
    }

    return { teams, players, groups };
  }

  const { topX } = normalizeTeamAggregation(context.teamAggregation);
  const playersByTeam = groupById(playerStateEntries, "teamId");
  for (const team of context.teams) {
    const teamPlayers = playersByTeam.get(team.teamId) || [];
    const metricKey = scoring === "stableford"
      ? (useHandicap ? "netStablefordTotal" : "grossStablefordTotal")
      : (useHandicap ? "netTotal" : "grossTotal");
    const selected = bestXByMetric(
      teamPlayers,
      topX,
      metricKey,
      scoring === "stableford" ? "high" : "low"
    );
    const gross = sumHoleArrays(selected.map((entry) => entry.gross));
    const net = sumHoleArrays(selected.map((entry) => entry.net));
    const grossStableford = sumHoleArrays(selected.map((entry) => entry.grossStableford));
    const netStableford = sumHoleArrays(selected.map((entry) => entry.netStableford));
    const par = Array.from({ length: HOLE_COUNT }, (_, holeIndex) => {
      let total = 0;
      let count = 0;
      for (const entry of selected) {
        if (entry.gross[holeIndex] == null && entry.net[holeIndex] == null) continue;
        total += Number(coursePar[holeIndex] || 0);
        count += 1;
      }
      return count > 0 ? total : 0;
    });
    const totals = entityTotalsFromHoles(gross, net, par, {
      gross: grossStableford,
      net: netStableford
    });
    const actualReady = everyEntryReadyByHole(teamPlayers);
    teams.set(team.teamId, {
      entityId: team.teamId,
      teamId: team.teamId,
      teamName: team.teamName,
      gross,
      net,
      handicapShots: Array(HOLE_COUNT).fill(0),
      actualReady,
      ...totals
    });
  }

  return { teams, players, groups };
}

function chooseSimulationCount(remainingCells) {
  if (!remainingCells || remainingCells <= 0) return 1;
  if (remainingCells <= 60) return 12000;
  if (remainingCells <= 120) return 8000;
  if (remainingCells <= 220) return 5000;
  if (remainingCells <= 360) return 3000;
  if (remainingCells <= 520) return 1800;
  if (remainingCells <= 800) return 1000;
  if (remainingCells <= 1200) return 650;
  if (remainingCells <= 1800) return 400;
  return 250;
}

function buildRoundContext(tournamentJson, roundIndex) {
  const rounds = tournamentJson?.tournament?.rounds || [];
  const round = rounds[roundIndex] || {};
  const scoring = normalizeTournamentScoring(tournamentJson?.tournament?.scoring);
  const course = courseForRoundIndex(tournamentJson, roundIndex);
  const maxGrossByHole = maxGrossByHoleForRound(round?.maxHoleScore, course?.pars);
  const roundData = tournamentJson?.score_data?.rounds?.[roundIndex] || {};
  const teams = (tournamentJson?.teams || []).map((team) => ({
    teamId: String(team?.teamId ?? team?.id ?? "").trim(),
    teamName: team?.teamName ?? team?.name ?? ""
  })).filter((team) => team.teamId);
  const players = (tournamentJson?.players || []).map((player) => ({
    playerId: String(player?.playerId || "").trim(),
    name: player?.name || "",
    teamId: String(player?.teamId || "").trim(),
    handicap: Number(player?.handicap || 0),
    groups: Array.isArray(player?.groups) ? player.groups.slice() : [],
    group: player?.group || null
  })).filter((player) => player.playerId && player.teamId);

  const playerById = new Map(players.map((player) => [player.playerId, player]));
  const nameById = playerNameMap(tournamentJson);
  const units = [];
  const format = String(round?.format || "").trim().toLowerCase();
  const twoManFormat = normalizeTwoManFormat(format);

  if (format === "scramble") {
    for (const team of teams) {
      const entry = roundData?.team?.[team.teamId] || {};
      const gross = normalizeGrossArray(entry?.gross);
      const handicapShots = normalizeNumberArray(entry?.handicapShots, 0);
      const playerIds = players.filter((player) => player.teamId === team.teamId).map((player) => player.playerId);
      units.push({
        id: team.teamId,
        modelType: "scramble",
        entityType: "team",
        teamId: team.teamId,
        teamName: team.teamName,
        name: team.teamName,
        gross,
        handicapShots,
        net: normalizeNetArray(entry?.net, gross, handicapShots),
        playerIds,
        playerHandicaps: playerIds.map((playerId) => Number(playerById.get(playerId)?.handicap || 0))
      });
    }
  } else if (isTwoManScrambleFormat(format)) {
    for (const team of teams) {
      const teamEntry = roundData?.team?.[team.teamId] || {};
      const groupKeys = groupKeysForTeamRound(tournamentJson, roundIndex, team.teamId, teamEntry);
      for (const groupKey of groupKeys) {
        const rawGroup = Object.entries(teamEntry?.groups || {}).find(([key]) => normalizeGroupKey(key) === groupKey)?.[1] || {};
        const gross = normalizeGrossArray(rawGroup?.gross);
        const handicapShots = normalizeNumberArray(rawGroup?.handicapShots, 0);
        const playerIds = playerIdsForGroup(tournamentJson, roundIndex, team.teamId, groupKey, rawGroup?.playerIds);
        units.push({
          id: twoManGroupId(team.teamId, groupKey),
          modelType: "scramble",
          entityType: "group",
          groupId: twoManGroupId(team.teamId, groupKey),
          groupKey,
          teamId: team.teamId,
          teamName: team.teamName,
          name: groupDisplayName(playerIds, nameById, groupKey),
          gross,
          handicapShots,
          net: normalizeNetArray(rawGroup?.net, gross, handicapShots),
          playerIds,
          playerHandicaps: playerIds.map((playerId) => Number(playerById.get(playerId)?.handicap || 0))
        });
      }
    }
  } else {
    for (const player of players) {
      const entry = roundData?.player?.[player.playerId] || {};
      const gross = normalizeGrossArray(entry?.gross);
      const storedHandicapShots = normalizeNumberArray(entry?.handicapShots, 0);
      const handicapShots = strokesFromHandicapShots(storedHandicapShots) > 0
        ? storedHandicapShots
        : handicapShotsForHandicap(
            effectiveHandicapValue(player?.handicap, twoManFormat === "two_man_shamble" ? 0.8 : 1),
            course?.strokeIndex
          );
      units.push({
        id: player.playerId,
        entityType: "player",
        playerId: player.playerId,
        teamId: player.teamId,
        teamName: teams.find((team) => team.teamId === player.teamId)?.teamName || player.teamId,
        name: player.name || player.playerId,
        gross,
        handicapShots,
        net: normalizeNetArray(entry?.net, gross, handicapShots),
        playerIds: [player.playerId]
      });
    }
  }

  const groupDefs = [];
  if (isTwoManPlayerFormat(format)) {
    for (const team of teams) {
      const teamEntry = roundData?.team?.[team.teamId] || {};
      const groupKeys = groupKeysForTeamRound(tournamentJson, roundIndex, team.teamId, teamEntry);
      for (const groupKey of groupKeys) {
        const fallbackIds = Object.entries(teamEntry?.groups || {})
          .find(([key]) => normalizeGroupKey(key) === groupKey)?.[1]?.playerIds;
        const playerIds = playerIdsForGroup(tournamentJson, roundIndex, team.teamId, groupKey, fallbackIds);
        groupDefs.push({
          groupId: twoManGroupId(team.teamId, groupKey),
          groupKey,
          teamId: team.teamId,
          teamName: team.teamName,
          playerIds,
          name: groupDisplayName(playerIds, nameById, groupKey)
        });
      }
    }
  }

  buildUnitPriors(units, course);
  return {
    roundIndex,
    round,
    scoring,
    format,
    useHandicap: !!round?.useHandicap,
    teamAggregation: round?.teamAggregation || { topX: 4 },
    course,
    maxGrossByHole,
    units,
    teams,
    players,
    playerById,
    groupDefs,
    remainingUnitHoles: units.reduce(
      (total, unit) => total + unit.gross.filter((value) => value == null).length,
      0
    )
  };
}

function normalizeRoundWeights(rounds) {
  const rawWeights = (rounds || []).map((round) => {
    const value = Number(round?.weight);
    return Number.isFinite(value) && value > 0 ? value : 1;
  });
  const roundCount = rawWeights.length || 1;
  const weightSum = rawWeights.reduce((total, value) => total + value, 0);
  const scale = weightSum > 0 ? (roundCount / weightSum) : 1;
  return rawWeights.map((weight) => weight * scale);
}

function createEntityAccumulator(entries, remainingHoleKeysById) {
  const byId = new Map();
  for (const entry of entries || []) {
    const entityId = String(entry?.entityId || "").trim();
    if (!entityId) continue;
    byId.set(entityId, {
      entry,
      scoreSum: 0,
      grossSum: 0,
      netSum: 0,
      grossToParSum: 0,
      netToParSum: 0,
      grossPointsSum: 0,
      netPointsSum: 0,
      leaderShare: 0,
      lowGrossShare: 0,
      lowNetShare: 0,
      top2Share: 0,
      top3Share: 0,
      holeSums: new Map(
        (remainingHoleKeysById.get(entityId) || []).map((key) => [key, {
          gross: 0,
          net: 0,
          grossDistribution: new Map(),
          netDistribution: new Map()
        }])
      )
    });
  }
  return byId;
}

function addWeightedHoleArrays(mapGross, mapNet, roundIndex, gross, net, weight) {
  for (let holeIndex = 0; holeIndex < HOLE_COUNT; holeIndex++) {
    const grossValue = gross?.[holeIndex];
    const netValue = net?.[holeIndex];
    if (grossValue != null) {
      const key = `${roundIndex}:${holeIndex}`;
      mapGross.set(key, Number(mapGross.get(key) || 0) + (Number(grossValue) * weight));
    }
    if (netValue != null) {
      const key = `${roundIndex}:${holeIndex}`;
      mapNet.set(key, Number(mapNet.get(key) || 0) + (Number(netValue) * weight));
    }
  }
}

function averageHoleArrays(entries, prop) {
  const out = emptyHoleArray();
  if (!Array.isArray(entries) || !entries.length) return out;
  for (let holeIndex = 0; holeIndex < HOLE_COUNT; holeIndex++) {
    let total = 0;
    let count = 0;
    for (const entry of entries) {
      const value = entry?.[prop]?.[holeIndex];
      if (value == null) continue;
      total += Number(value);
      count += 1;
    }
    out[holeIndex] = count > 0 ? (total / count) : null;
  }
  return out;
}

function placementShares(sortedEntries, scoreSelector, accumulatorById, fieldName, direction = "low") {
  const ranked = (sortedEntries || [])
    .map((entry) => ({
      entityId: String(entry?.entityId || "").trim(),
      score: Number(scoreSelector(entry))
    }))
    .filter((entry) => entry.entityId && Number.isFinite(entry.score))
    .sort((a, b) => {
      const delta = a.score - b.score;
      return (direction === "high" ? -delta : delta) || a.entityId.localeCompare(b.entityId);
    });

  let cursor = 0;
  let startRank = 1;
  while (cursor < ranked.length) {
    let end = cursor + 1;
    while (end < ranked.length && ranked[end].score === ranked[cursor].score) end += 1;
    const group = ranked.slice(cursor, end);
    const groupSize = group.length;
    const slotsTop2 = Math.max(0, Math.min(2, startRank + groupSize - 1) - startRank + 1);
    const slotsTop3 = Math.max(0, Math.min(3, startRank + groupSize - 1) - startRank + 1);
    for (const row of group) {
      const acc = accumulatorById.get(row.entityId);
      if (!acc) continue;
      if (fieldName === "leader" && startRank === 1) acc.leaderShare += 1 / groupSize;
      if (fieldName === "gross" && startRank === 1) acc.lowGrossShare += 1 / groupSize;
      if (fieldName === "net" && startRank === 1) acc.lowNetShare += 1 / groupSize;
      if (fieldName === "leader") {
        if (slotsTop2 > 0) acc.top2Share += slotsTop2 / groupSize;
        if (slotsTop3 > 0) acc.top3Share += slotsTop3 / groupSize;
      }
    }
    startRank += groupSize;
    cursor = end;
  }
}

function accumulateEntitySet(accumulatorById, entries, scoreSelector, scoreDirection = "low") {
  const rows = Array.from(entries.values());
  for (const entry of rows) {
    const entityId = String(entry?.entityId || "").trim();
    const acc = accumulatorById.get(entityId);
    if (!acc) continue;
    acc.scoreSum += Number(scoreSelector(entry) || 0);
    acc.grossSum += Number(entry.grossTotal || 0);
    acc.netSum += Number(entry.netTotal || 0);
    acc.grossToParSum += Number(entry.grossToParTotal || 0);
    acc.netToParSum += Number(entry.netToParTotal || 0);
    acc.grossPointsSum += Number(entry.grossStablefordTotal || 0);
    acc.netPointsSum += Number(entry.netStablefordTotal || 0);
    const holeGrossByKey = entry.holeGrossByKey instanceof Map ? entry.holeGrossByKey : null;
    const holeNetByKey = entry.holeNetByKey instanceof Map ? entry.holeNetByKey : null;
    for (const [key, sums] of acc.holeSums.entries()) {
      if (holeGrossByKey || holeNetByKey) {
        const grossValue = holeGrossByKey?.get(key);
        const netValue = holeNetByKey?.get(key);
        sums.gross += Number(grossValue || 0);
        sums.net += Number(netValue || 0);
        addDistributionValue(sums.grossDistribution, grossValue);
        addDistributionValue(sums.netDistribution, netValue);
        continue;
      }
      const [, holeIndexText] = key.split(":");
      const holeIndex = Number(holeIndexText);
      const grossValue = entry.gross?.[holeIndex];
      const netValue = entry.net?.[holeIndex];
      sums.gross += Number(grossValue || 0);
      sums.net += Number(netValue || 0);
      addDistributionValue(sums.grossDistribution, grossValue);
      addDistributionValue(sums.netDistribution, netValue);
    }
  }

  placementShares(rows, scoreSelector, accumulatorById, "leader", scoreDirection);
  placementShares(rows, (entry) => entry.grossTotal, accumulatorById, "gross");
  placementShares(rows, (entry) => entry.netTotal, accumulatorById, "net");
}

function finalizeEntitySet(accumulatorById, simulationCount, entityType, scoreDirection = "low") {
  return Array.from(accumulatorById.values())
    .map((acc) => {
      const entry = acc.entry;
      const remainingHoleExpectations = Array.from(acc.holeSums.entries())
        .map(([key, sums]) => {
          const [roundIndexText, holeIndexText] = key.split(":");
          return {
            roundIndex: Number(roundIndexText),
            holeIndex: Number(holeIndexText),
            projectedGross: round2(sums.gross / simulationCount),
            projectedNet: round2(sums.net / simulationCount),
            grossDistribution: distributionRowsFromMap(sums.grossDistribution, simulationCount),
            netDistribution: distributionRowsFromMap(sums.netDistribution, simulationCount)
          };
        })
        .sort((a, b) => a.roundIndex - b.roundIndex || a.holeIndex - b.holeIndex);

      return {
        entityId: entry.entityId,
        ...(entityType === "team" ? { teamId: entry.teamId, teamName: entry.teamName } : {}),
        ...(entityType === "player" ? { playerId: entry.playerId, name: entry.name, teamId: entry.teamId, teamName: entry.teamName } : {}),
        ...(entityType === "group" ? { groupId: entry.groupId, groupKey: entry.groupKey, name: entry.name, teamId: entry.teamId, teamName: entry.teamName } : {}),
        projectedScore: round2(acc.scoreSum / simulationCount),
        projectedGross: round2(acc.grossSum / simulationCount),
        projectedNet: round2(acc.netSum / simulationCount),
        projectedGrossToPar: round2(acc.grossToParSum / simulationCount),
        projectedNetToPar: round2(acc.netToParSum / simulationCount),
        projectedGrossPoints: round2(acc.grossPointsSum / simulationCount),
        projectedNetPoints: round2(acc.netPointsSum / simulationCount),
        leaderProbability: round2((acc.leaderShare / simulationCount) * 100),
        lowestGrossProbability: round2((acc.lowGrossShare / simulationCount) * 100),
        lowestNetProbability: round2((acc.lowNetShare / simulationCount) * 100),
        finishTop2Probability: round2((acc.top2Share / simulationCount) * 100),
        finishTop3Probability: round2((acc.top3Share / simulationCount) * 100),
        holesRemaining: remainingHoleExpectations.length,
        remainingHoleExpectations
      };
    })
    .sort((a, b) => {
      const leadDiff = Number(b.leaderProbability || 0) - Number(a.leaderProbability || 0);
      if (leadDiff !== 0) return leadDiff;
      return scoreDirection === "high"
        ? Number(b.projectedScore || 0) - Number(a.projectedScore || 0)
        : Number(a.projectedScore || 0) - Number(b.projectedScore || 0);
    });
}

function remainingKeysForEntityMap(entityMap, roundIndex) {
  const out = new Map();
  for (const entry of entityMap.values()) {
    const entityId = String(entry?.entityId || "").trim();
    if (!entityId) continue;
    const keys = [];
    for (let holeIndex = 0; holeIndex < HOLE_COUNT; holeIndex++) {
      const holeReady = Array.isArray(entry?.actualReady)
        ? !!entry.actualReady[holeIndex]
        : holeHasRecordedScore(entry, holeIndex);
      if (holeReady) continue;
      keys.push(`${roundIndex}:${holeIndex}`);
    }
    out.set(entityId, keys);
  }
  return out;
}

function mergeRemainingKeys(target, source) {
  for (const [entityId, keys] of source.entries()) {
    if (!target.has(entityId)) target.set(entityId, []);
    const merged = new Set([...(target.get(entityId) || []), ...(keys || [])]);
    target.set(entityId, Array.from(merged));
  }
}

function combineAllRoundSimulation(tournamentJson, roundContexts, roundEvaluations, roundWeights) {
  const teamEntries = new Map();
  const playerEntries = new Map();

  (tournamentJson?.teams || []).forEach((team) => {
    const teamId = String(team?.teamId ?? team?.id ?? "").trim();
    if (!teamId) return;
    teamEntries.set(teamId, {
      entityId: teamId,
      teamId,
      teamName: team?.teamName ?? team?.name ?? teamId,
      leaderboardTotal: 0,
      grossTotal: 0,
      netTotal: 0,
      grossToParTotal: 0,
      netToParTotal: 0,
      grossStablefordTotal: 0,
      netStablefordTotal: 0,
      holeGrossByKey: new Map(),
      holeNetByKey: new Map()
    });
  });

  (tournamentJson?.players || []).forEach((player) => {
    const playerId = String(player?.playerId || "").trim();
    if (!playerId) return;
    playerEntries.set(playerId, {
      entityId: playerId,
      playerId,
      name: player?.name || playerId,
      teamId: String(player?.teamId || "").trim(),
      teamName: "",
      leaderboardTotal: 0,
      grossTotal: 0,
      netTotal: 0,
      grossToParTotal: 0,
      netToParTotal: 0,
      grossStablefordTotal: 0,
      netStablefordTotal: 0,
      holeGrossByKey: new Map(),
      holeNetByKey: new Map()
    });
  });

  for (let roundIndex = 0; roundIndex < roundContexts.length; roundIndex++) {
    const context = roundContexts[roundIndex];
    const evaluation = roundEvaluations[roundIndex];
    const weight = roundWeights[roundIndex] ?? 1;
    const useHandicap = !!context.useHandicap;
    const scoring = normalizeTournamentScoring(context.scoring);
    const metricValue = (entry) => scoring === "stableford"
      ? (useHandicap ? entry.netStablefordTotal : entry.grossStablefordTotal)
      : (useHandicap ? entry.netTotal : entry.grossTotal);

    if (context.format === "scramble") {
      for (const teamEntry of evaluation.teams.values()) {
        const target = teamEntries.get(teamEntry.teamId);
        if (!target) continue;
        target.leaderboardTotal += Number(metricValue(teamEntry) || 0) * weight;
        target.grossTotal += Number(teamEntry.grossTotal || 0) * weight;
        target.netTotal += Number(teamEntry.netTotal || 0) * weight;
        target.grossToParTotal += Number(teamEntry.grossToParTotal || 0) * weight;
        target.netToParTotal += Number(teamEntry.netToParTotal || 0) * weight;
        target.grossStablefordTotal += Number(teamEntry.grossStablefordTotal || 0) * weight;
        target.netStablefordTotal += Number(teamEntry.netStablefordTotal || 0) * weight;
        addWeightedHoleArrays(target.holeGrossByKey, target.holeNetByKey, roundIndex, teamEntry.gross, teamEntry.net, weight);
      }
      for (const player of context.players) {
        const teamEntry = evaluation.teams.get(player.teamId);
        const target = playerEntries.get(player.playerId);
        if (!target || !teamEntry) continue;
        target.teamName = teamEntry.teamName;
        target.leaderboardTotal += Number(metricValue(teamEntry) || 0) * weight;
        target.grossTotal += Number(teamEntry.grossTotal || 0) * weight;
        target.netTotal += Number(teamEntry.netTotal || 0) * weight;
        target.grossToParTotal += Number(teamEntry.grossToParTotal || 0) * weight;
        target.netToParTotal += Number(teamEntry.netToParTotal || 0) * weight;
        target.grossStablefordTotal += Number(teamEntry.grossStablefordTotal || 0) * weight;
        target.netStablefordTotal += Number(teamEntry.netStablefordTotal || 0) * weight;
        addWeightedHoleArrays(target.holeGrossByKey, target.holeNetByKey, roundIndex, teamEntry.gross, teamEntry.net, weight);
      }
      continue;
    }

    for (const playerEntry of evaluation.players.values()) {
      const target = playerEntries.get(playerEntry.playerId);
      if (!target) continue;
      target.teamName = playerEntry.teamName;
      target.leaderboardTotal += Number(metricValue(playerEntry) || 0) * weight;
      target.grossTotal += Number(playerEntry.grossTotal || 0) * weight;
      target.netTotal += Number(playerEntry.netTotal || 0) * weight;
      target.grossToParTotal += Number(playerEntry.grossToParTotal || 0) * weight;
      target.netToParTotal += Number(playerEntry.netToParTotal || 0) * weight;
      target.grossStablefordTotal += Number(playerEntry.grossStablefordTotal || 0) * weight;
      target.netStablefordTotal += Number(playerEntry.netStablefordTotal || 0) * weight;
      addWeightedHoleArrays(target.holeGrossByKey, target.holeNetByKey, roundIndex, playerEntry.gross, playerEntry.net, weight);
    }

    if (isTwoManScrambleFormat(context.format) || isTwoManPlayerFormat(context.format)) {
      const groupsByTeam = groupById(Array.from(evaluation.groups.values()), "teamId");
      for (const team of context.teams) {
        const target = teamEntries.get(team.teamId);
        if (!target) continue;
        const teamGroups = groupsByTeam.get(team.teamId) || [];
        if (teamGroups.length) {
          const grossSum = teamGroups.reduce((total, entry) => total + Number(entry.grossTotal || 0), 0);
          const netSum = teamGroups.reduce((total, entry) => total + Number(entry.netTotal || 0), 0);
          const grossToParSum = teamGroups.reduce((total, entry) => total + Number(entry.grossToParTotal || 0), 0);
          const netToParSum = teamGroups.reduce((total, entry) => total + Number(entry.netToParTotal || 0), 0);
          const grossPointsSum = teamGroups.reduce((total, entry) => total + Number(entry.grossStablefordTotal || 0), 0);
          const netPointsSum = teamGroups.reduce((total, entry) => total + Number(entry.netStablefordTotal || 0), 0);
          const gross = sumHoleArrays(teamGroups.map((entry) => entry.gross));
          const net = sumHoleArrays(teamGroups.map((entry) => entry.net));
          const groupCount = teamGroups.length || 1;
          const pointDivisor = scoring === "stableford" ? 1 : groupCount;
          target.leaderboardTotal += Number(scoring === "stableford" ? (useHandicap ? netPointsSum : grossPointsSum) : (useHandicap ? netSum : grossSum)) / pointDivisor * weight;
          target.grossTotal += (grossSum / groupCount) * weight;
          target.netTotal += (netSum / groupCount) * weight;
          target.grossToParTotal += (grossToParSum / groupCount) * weight;
          target.netToParTotal += (netToParSum / groupCount) * weight;
          target.grossStablefordTotal += (grossPointsSum / pointDivisor) * weight;
          target.netStablefordTotal += (netPointsSum / pointDivisor) * weight;
          addWeightedHoleArrays(target.holeGrossByKey, target.holeNetByKey, roundIndex, gross, net, weight);
          continue;
        }

        const fallback = evaluation.teams.get(team.teamId);
        if (!fallback) continue;
        target.leaderboardTotal += Number(metricValue(fallback) || 0) * weight;
        target.grossTotal += Number(fallback.grossTotal || 0) * weight;
        target.netTotal += Number(fallback.netTotal || 0) * weight;
        target.grossToParTotal += Number(fallback.grossToParTotal || 0) * weight;
        target.netToParTotal += Number(fallback.netToParTotal || 0) * weight;
        target.grossStablefordTotal += Number(fallback.grossStablefordTotal || 0) * weight;
        target.netStablefordTotal += Number(fallback.netStablefordTotal || 0) * weight;
        addWeightedHoleArrays(target.holeGrossByKey, target.holeNetByKey, roundIndex, fallback.gross, fallback.net, weight);
      }
      continue;
    }

    for (const team of context.teams) {
      const target = teamEntries.get(team.teamId);
      if (!target) continue;
      const teamPlayers = Array.from(evaluation.players.values()).filter((entry) => entry.teamId === team.teamId);
      const { topX } = normalizeTeamAggregation(context.teamAggregation);
      const selected = bestXByMetric(
        teamPlayers,
        topX,
        scoring === "stableford" ? (useHandicap ? "netStablefordTotal" : "grossStablefordTotal") : (useHandicap ? "netTotal" : "grossTotal"),
        scoring === "stableford" ? "high" : "low"
      );
      const grossSum = selected.length
        ? selected.reduce((total, entry) => total + Number(entry.grossTotal || 0), 0)
        : 0;
      const netSum = selected.length
        ? selected.reduce((total, entry) => total + Number(entry.netTotal || 0), 0)
        : 0;
      const grossToParSum = selected.length
        ? selected.reduce((total, entry) => total + Number(entry.grossToParTotal || 0), 0)
        : 0;
      const netToParSum = selected.length
        ? selected.reduce((total, entry) => total + Number(entry.netToParTotal || 0), 0)
        : 0;
      const grossPointsSum = selected.length
        ? selected.reduce((total, entry) => total + Number(entry.grossStablefordTotal || 0), 0)
        : 0;
      const netPointsSum = selected.length
        ? selected.reduce((total, entry) => total + Number(entry.netStablefordTotal || 0), 0)
        : 0;
      const gross = sumHoleArrays(selected.map((entry) => entry.gross));
      const net = sumHoleArrays(selected.map((entry) => entry.net));
      target.leaderboardTotal += Number(scoring === "stableford" ? (useHandicap ? netPointsSum : grossPointsSum) : (useHandicap ? netSum : grossSum)) * weight;
      target.grossTotal += grossSum * weight;
      target.netTotal += netSum * weight;
      target.grossToParTotal += grossToParSum * weight;
      target.netToParTotal += netToParSum * weight;
      target.grossStablefordTotal += grossPointsSum * weight;
      target.netStablefordTotal += netPointsSum * weight;
      addWeightedHoleArrays(target.holeGrossByKey, target.holeNetByKey, roundIndex, gross, net, weight);
    }
  }

  return { teams: teamEntries, players: playerEntries };
}

function scoreSelectorForRound(context) {
  const scoring = normalizeTournamentScoring(context.scoring);
  return (entry) => scoring === "stableford"
    ? (context.useHandicap ? entry.netStablefordTotal : entry.grossStablefordTotal)
    : (context.useHandicap ? entry.netTotal : entry.grossTotal);
}

function scoreSelectorForAllRounds() {
  return (entry) => entry.leaderboardTotal;
}

function scoreDirectionForContext(context) {
  return normalizeTournamentScoring(context?.scoring) === "stableford" ? "high" : "low";
}

function scoreDirectionForTournament(tournamentJson) {
  return normalizeTournamentScoring(tournamentJson?.tournament?.scoring) === "stableford" ? "high" : "low";
}

export function computeLiveOdds(tournamentJson, {
  generatedAt = new Date().toISOString(),
  modelVersion = MODEL_VERSION
} = {}) {
  const rounds = tournamentJson?.tournament?.rounds || [];
  const roundContexts = rounds.map((_, roundIndex) => buildRoundContext(tournamentJson, roundIndex));
  const roundWeights = normalizeRoundWeights(rounds);
  const totalRemainingCells = roundContexts.reduce((total, context) => total + Number(context.remainingUnitHoles || 0), 0);
  const simulationCount = chooseSimulationCount(totalRemainingCells);
  const rng = createSeededRng(
    `${tournamentJson?.tournament?.tournamentId || ""}|${tournamentJson?.version || 0}|${tournamentJson?.updatedAt || ""}|${modelVersion}`
  );

  const actualRoundEvaluations = roundContexts.map((context) => evaluateRoundContext(context, context.units.map((unit) => cloneUnitState(unit))));
  const allRoundRemainingKeys = {
    teams: new Map(),
    players: new Map()
  };
  const roundAccumulators = actualRoundEvaluations.map((evaluation, roundIndex) => ({
    teams: createEntityAccumulator(Array.from(evaluation.teams.values()), remainingKeysForEntityMap(evaluation.teams, roundIndex)),
    players: createEntityAccumulator(Array.from(evaluation.players.values()), remainingKeysForEntityMap(evaluation.players, roundIndex)),
    groups: createEntityAccumulator(Array.from(evaluation.groups.values()), remainingKeysForEntityMap(evaluation.groups, roundIndex))
  }));

  for (let roundIndex = 0; roundIndex < actualRoundEvaluations.length; roundIndex++) {
    mergeRemainingKeys(allRoundRemainingKeys.teams, remainingKeysForEntityMap(actualRoundEvaluations[roundIndex].teams, roundIndex));
    mergeRemainingKeys(allRoundRemainingKeys.players, remainingKeysForEntityMap(actualRoundEvaluations[roundIndex].players, roundIndex));
  }

  const actualAllRounds = combineAllRoundSimulation(tournamentJson, roundContexts, actualRoundEvaluations, roundWeights);
  const allRoundAccumulators = {
    teams: createEntityAccumulator(Array.from(actualAllRounds.teams.values()), allRoundRemainingKeys.teams),
    players: createEntityAccumulator(Array.from(actualAllRounds.players.values()), allRoundRemainingKeys.players)
  };

  for (let simIndex = 0; simIndex < simulationCount; simIndex++) {
    const roundEvaluations = roundContexts.map((context) => evaluateRoundContext(context, sampleUnplayedHoles(context, rng)));

    for (let roundIndex = 0; roundIndex < roundContexts.length; roundIndex++) {
      const context = roundContexts[roundIndex];
      const evaluation = roundEvaluations[roundIndex];
      const scoreDirection = scoreDirectionForContext(context);
      accumulateEntitySet(roundAccumulators[roundIndex].teams, evaluation.teams, scoreSelectorForRound(context), scoreDirection);
      accumulateEntitySet(roundAccumulators[roundIndex].players, evaluation.players, scoreSelectorForRound(context), scoreDirection);
      accumulateEntitySet(roundAccumulators[roundIndex].groups, evaluation.groups, scoreSelectorForRound(context), scoreDirection);
    }

    const allRoundsEvaluation = combineAllRoundSimulation(tournamentJson, roundContexts, roundEvaluations, roundWeights);
    const tournamentScoreDirection = scoreDirectionForTournament(tournamentJson);
    accumulateEntitySet(allRoundAccumulators.teams, allRoundsEvaluation.teams, scoreSelectorForAllRounds(), tournamentScoreDirection);
    accumulateEntitySet(allRoundAccumulators.players, allRoundsEvaluation.players, scoreSelectorForAllRounds(), tournamentScoreDirection);
  }

  return {
    generatedAt,
    modelVersion,
    simCount: simulationCount,
    latencyMode: LATENCY_MODE,
    rounds: roundAccumulators.map((acc, roundIndex) => ({
      roundIndex,
      teams: finalizeEntitySet(acc.teams, simulationCount, "team", scoreDirectionForContext(roundContexts[roundIndex])),
      players: finalizeEntitySet(acc.players, simulationCount, "player", scoreDirectionForContext(roundContexts[roundIndex])),
      groups: finalizeEntitySet(acc.groups, simulationCount, "group", scoreDirectionForContext(roundContexts[roundIndex]))
    })),
    all_rounds: {
      teams: finalizeEntitySet(allRoundAccumulators.teams, simulationCount, "team", scoreDirectionForTournament(tournamentJson)),
      players: finalizeEntitySet(allRoundAccumulators.players, simulationCount, "player", scoreDirectionForTournament(tournamentJson)),
      groups: []
    }
  };
}

export const LIVE_ODDS_MODEL_VERSION = MODEL_VERSION;
