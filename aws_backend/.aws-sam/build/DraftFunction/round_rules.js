function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseRuleString(raw) {
  const text = String(raw || "").trim().toLowerCase();
  if (!text || text === "none") return null;
  const match = text.match(/^(to_par|score)\s*[:=]\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  return {
    type: match[1],
    value: Number(match[2])
  };
}

export function normalizeRoundMaxHoleScore(input) {
  const parsed = typeof input === "string"
    ? parseRuleString(input)
    : input;

  if (!parsed || typeof parsed !== "object") return null;
  const type = String(parsed.type || "").trim().toLowerCase();
  const rawValue = Number(parsed.value);
  if (!Number.isFinite(rawValue)) return null;

  if (type === "to_par") {
    return {
      type: "to_par",
      value: clamp(Math.round(rawValue), 1, 10)
    };
  }

  if (type === "score") {
    return {
      type: "score",
      value: clamp(Math.round(rawValue), 1, 20)
    };
  }

  return null;
}

export function maxGrossForHole(roundMaxHoleScore, par) {
  const rule = normalizeRoundMaxHoleScore(roundMaxHoleScore);
  if (!rule) return null;
  const safePar = Math.max(1, Math.round(Number(par) || 4));
  if (rule.type === "to_par") return Math.max(1, safePar + Number(rule.value || 0));
  return Math.max(1, Math.round(Number(rule.value) || 0));
}

export function maxGrossByHoleForRound(roundMaxHoleScore, pars) {
  const safePars = Array.isArray(pars) ? pars : Array(18).fill(4);
  return Array.from({ length: 18 }, (_, holeIndex) =>
    maxGrossForHole(roundMaxHoleScore, safePars[holeIndex])
  );
}
