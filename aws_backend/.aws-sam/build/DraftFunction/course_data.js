function trimString(value, maxLength = 0) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (maxLength > 0) return text.slice(0, maxLength);
  return text;
}

function numbers18(values) {
  if (!Array.isArray(values) || values.length !== 18) return null;
  const out = values.map((value) => Number(value));
  if (!out.every(Number.isFinite)) return null;
  return out;
}

function integers18(values) {
  const out = numbers18(values);
  if (!out) return null;
  if (!out.every((value) => Number.isInteger(value) && value >= 1 && value <= 18)) return null;
  if (new Set(out).size !== 18) return null;
  return out;
}

export function validateCourse(course) {
  const pars = numbers18(course?.pars);
  const strokeIndex = integers18(course?.strokeIndex);
  if (!pars) return "course.pars must be an array of length 18";
  if (!strokeIndex) return "course.strokeIndex must be an array of length 18 with unique integers 1..18";
  return null;
}

export function teeKeyForMeta(teeName, totalYards, holeYardages) {
  const nameKey = trimString(teeName, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "tee";
  const yardValue = Number(totalYards);
  const yardsKey = Number.isFinite(yardValue) ? String(Math.round(yardValue)) : "0";
  const holes = Array.isArray(holeYardages) && holeYardages.length === 18
    ? holeYardages.map((value) => Number(value) || 0).join("-")
    : "";
  return holes ? `${nameKey}-${yardsKey}-${holes}` : `${nameKey}-${yardsKey}`;
}

export function normalizeRatingEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const gender = trimString(raw.gender, 8).toUpperCase();
  const rating = Number(raw.rating);
  const slope = Number(raw.slope);
  if (!gender && !Number.isFinite(rating) && !Number.isFinite(slope)) return null;
  return {
    ...(gender ? { gender } : {}),
    ...(Number.isFinite(rating) ? { rating: Number(rating.toFixed(1)) } : {}),
    ...(Number.isFinite(slope) ? { slope: Math.round(slope) } : {})
  };
}

function normalizeHoleYardages(values) {
  if (!Array.isArray(values) || values.length !== 18) return null;
  const out = values.map((value) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  });
  return out.length === 18 ? out : null;
}

export function normalizeTee(raw) {
  if (!raw || typeof raw !== "object") return null;
  const teeName = trimString(raw.teeName || raw.name, 80);
  const totalYardsRaw = Number(raw.totalYards);
  const parTotalRaw = Number(raw.parTotal);
  const totalYards = Number.isFinite(totalYardsRaw) ? Math.max(0, Math.round(totalYardsRaw)) : null;
  const parTotal = Number.isFinite(parTotalRaw) ? Math.max(0, Math.round(parTotalRaw)) : null;
  const holeYardages = normalizeHoleYardages(raw.holeYardages);
  const ratings = Array.isArray(raw.ratings) && raw.ratings.length
    ? raw.ratings.map((entry) => normalizeRatingEntry(entry)).filter(Boolean)
    : [normalizeRatingEntry(raw)].filter(Boolean);
  const teeKey = trimString(raw.teeKey || raw.selectedTeeKey, 140)
    || teeKeyForMeta(teeName, totalYards, holeYardages);
  if (!teeName && !Number.isFinite(totalYards) && !holeYardages && !ratings.length) return null;
  return {
    teeKey,
    ...(teeName ? { teeName } : {}),
    ...(Number.isFinite(parTotal) ? { parTotal } : {}),
    ...(Number.isFinite(totalYards) ? { totalYards } : {}),
    ...(holeYardages ? { holeYardages } : {}),
    ...(ratings.length ? { ratings } : {})
  };
}

function copySelectedTeeFields(out, tee) {
  if (!tee) return;
  if (tee.teeName) out.teeName = tee.teeName;
  if (Number.isFinite(tee.parTotal)) out.parTotal = tee.parTotal;
  if (Number.isFinite(tee.totalYards)) out.totalYards = tee.totalYards;
  if (Array.isArray(tee.holeYardages) && tee.holeYardages.length === 18) out.holeYardages = tee.holeYardages.slice();
  if (Array.isArray(tee.ratings) && tee.ratings.length) out.ratings = tee.ratings.map((entry) => ({ ...entry }));
}

export function normalizeCourseRecord(course) {
  if (!course || typeof course !== "object") return null;
  const pars = numbers18(course.pars);
  const strokeIndex = integers18(course.strokeIndex);
  if (!pars || !strokeIndex) return null;

  const out = {
    pars,
    strokeIndex
  };

  const courseId = trimString(course.courseId, 120);
  if (courseId) out.courseId = courseId;

  const name = trimString(course.name, 120);
  if (name) out.name = name;

  const sourceCourseId = trimString(course.sourceCourseId, 120);
  if (sourceCourseId) out.sourceCourseId = sourceCourseId;

  const bluegolfCourseSlug = trimString(course.bluegolfCourseSlug, 120);
  if (bluegolfCourseSlug) out.bluegolfCourseSlug = bluegolfCourseSlug;

  const bluegolfUrl = trimString(course.bluegolfUrl, 500);
  if (bluegolfUrl) out.bluegolfUrl = bluegolfUrl;

  const dataSlug = trimString(course.dataSlug, 140);
  if (dataSlug) out.dataSlug = dataSlug;

  const mapSlug = trimString(course.mapSlug, 140);
  if (mapSlug) out.mapSlug = mapSlug;

  const tees = Array.isArray(course.tees)
    ? course.tees.map((entry) => normalizeTee(entry)).filter(Boolean)
    : [];
  if (tees.length) out.tees = tees;

  const longestTees = Array.isArray(course.longestTees)
    ? course.longestTees.map((entry) => normalizeTee(entry)).filter(Boolean)
    : [];
  if (longestTees.length) out.longestTees = longestTees;

  let selectedTeeKey = trimString(course.selectedTeeKey || course.teeKey, 140);
  if (!selectedTeeKey && tees.length === 1) selectedTeeKey = tees[0].teeKey;
  if (selectedTeeKey) out.selectedTeeKey = selectedTeeKey;

  const topLevelTee = normalizeTee({
    teeKey: selectedTeeKey,
    teeName: course.teeName,
    totalYards: course.totalYards,
    parTotal: course.parTotal,
    holeYardages: course.holeYardages,
    ratings: course.ratings
  });

  const selectedTee = tees.find((tee) => tee.teeKey === selectedTeeKey)
    || longestTees.find((tee) => tee.teeKey === selectedTeeKey)
    || topLevelTee
    || null;
  copySelectedTeeFields(out, selectedTee);

  const teeLabel = trimString(course.teeLabel, 200);
  if (teeLabel) out.teeLabel = teeLabel;

  return out;
}
