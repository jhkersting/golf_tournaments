const LATENCY_MODE_CODES = {
  latency_first: 0
};

const DEFAULT_HISTORY_LIMIT = 512;

function roundPercentInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function roundTenthsInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10);
}

function compactDistribution(distribution = []) {
  return (distribution || [])
    .map((item) => {
      const score = roundTenthsInt(item?.score);
      const probability = roundPercentInt(item?.probability);
      if (score == null || probability <= 0) return null;
      return [score, probability];
    })
    .filter(Boolean);
}

function compactHoleDetails(row) {
  return (row?.remainingHoleExpectations || [])
    .map((item) => {
      const holeIndex = Number(item?.holeIndex);
      if (!Number.isInteger(holeIndex) || holeIndex < 0) return null;
      return [
        holeIndex,
        roundTenthsInt(item?.projectedGross),
        roundTenthsInt(item?.projectedNet),
        compactDistribution(item?.grossDistribution),
        compactDistribution(item?.netDistribution)
      ];
    })
    .filter(Boolean);
}

function projectedScoreToPar(row) {
  const gross = Number(row?.projectedGross);
  const grossToPar = Number(row?.projectedGrossToPar);
  if (Number.isFinite(gross) && Number.isFinite(grossToPar)) {
    const parBase = gross - grossToPar;
    const score = Number(row?.projectedScore);
    if (Number.isFinite(score)) return score - parBase;
  }

  const net = Number(row?.projectedNet);
  const netToPar = Number(row?.projectedNetToPar);
  if (Number.isFinite(net) && Number.isFinite(netToPar)) {
    const parBase = net - netToPar;
    const score = Number(row?.projectedScore);
    if (Number.isFinite(score)) return score - parBase;
  }

  return null;
}

function compactMetrics(row) {
  return [
    roundPercentInt(row?.leaderProbability),
    roundPercentInt(row?.lowestGrossProbability),
    roundPercentInt(row?.lowestNetProbability),
    roundTenthsInt(projectedScoreToPar(row)),
    roundTenthsInt(row?.projectedGrossToPar),
    roundTenthsInt(row?.projectedNetToPar),
    Math.max(0, Math.round(Number(row?.holesRemaining) || 0))
  ];
}

function compactTeamRow(row, { includeHoleDetails = false } = {}) {
  return [
    String(row?.teamId || ""),
    ...compactMetrics(row),
    ...(includeHoleDetails ? [compactHoleDetails(row)] : [])
  ];
}

function compactMemberRow(row, idKey, { includeHoleDetails = false } = {}) {
  return [
    String(row?.[idKey] || ""),
    String(row?.teamId || ""),
    ...compactMetrics(row),
    ...(includeHoleDetails ? [compactHoleDetails(row)] : [])
  ];
}

function compactScopeRows(scope = {}, { includeHoleDetails = false } = {}) {
  return [
    (scope?.teams || []).map((row) => compactTeamRow(row, { includeHoleDetails })),
    (scope?.players || []).map((row) => compactMemberRow(row, "playerId", { includeHoleDetails })),
    (scope?.groups || []).map((row) => compactMemberRow(row, "groupId", { includeHoleDetails }))
  ];
}

function compactMatchPlay(matchPlay) {
  if (!matchPlay || !Array.isArray(matchPlay?.teamIds) || matchPlay.teamIds.length !== 2) return null;
  const teamIds = matchPlay.teamIds.map((teamId) => String(teamId || ""));
  const eventTeams = new Map((matchPlay?.event?.teams || []).map((row) => [String(row?.teamId || ""), row]));
  const compactProjectedScores = (scores) => (scores || [])
    .map((item) => {
      const holeIndex = Number(item?.holeIndex);
      const projectedScore = roundTenthsInt(item?.projectedScore);
      if (!Number.isInteger(holeIndex) || holeIndex < 0 || projectedScore == null) return null;
      return [holeIndex, projectedScore];
    })
    .filter(Boolean);
  return [
    teamIds,
    [
      roundPercentInt(eventTeams.get(teamIds[0])?.winProbability),
      roundPercentInt(matchPlay?.event?.tieProbability),
      roundPercentInt(eventTeams.get(teamIds[1])?.winProbability)
    ],
    (matchPlay?.rounds || []).map((round) => (round?.matches || []).map((match) => ([
      String(match?.matchId || ""),
      String(match?.teamAId || ""),
      String(match?.teamBId || ""),
      roundPercentInt(match?.teamAWinProbability),
      roundPercentInt(match?.halveProbability),
      roundPercentInt(match?.teamBWinProbability),
      [
        compactProjectedScores(match?.teamAProjectedScores),
        compactProjectedScores(match?.teamBProjectedScores)
      ],
      Math.max(0, Math.round(Number(match?.thru) || 0)),
      Math.max(1, Math.round(Number(match?.holes) || 18))
    ])))
  ];
}

function cloneHistoryShape(history, roundCount) {
  const base = history && typeof history === "object" ? history : {};
  const scopes = Array.isArray(base?.a) ? base.a : [{}, {}, {}];
  const rounds = Array.isArray(base?.r) ? base.r : [];
  return {
    t0: Number(base?.t0) || 0,
    s: Array.isArray(base?.s) ? base.s.map((item) => Array.isArray(item) ? item.slice(0, 2) : null).filter(Boolean) : [],
    a: [
      { ...(scopes?.[0] || {}) },
      { ...(scopes?.[1] || {}) },
      { ...(scopes?.[2] || {}) }
    ],
    r: Array.from({ length: Math.max(roundCount, rounds.length) }, (_, roundIndex) => {
      const source = Array.isArray(rounds?.[roundIndex]) ? rounds[roundIndex] : [{}, {}, {}];
      return [
        { ...(source?.[0] || {}) },
        { ...(source?.[1] || {}) },
        { ...(source?.[2] || {}) }
      ];
    }),
    m: {
      e: Array.isArray(base?.m?.e) ? base.m.e.map((point) => point.slice()) : [],
      r: Array.from({ length: Math.max(roundCount, base?.m?.r?.length || 0) }, (_, roundIndex) => {
        const source = base?.m?.r?.[roundIndex];
        return Object.fromEntries(Object.entries(source && typeof source === "object" ? source : {}).map(
          ([matchId, points]) => [matchId, Array.isArray(points) ? points.map((point) => point.slice()) : []]
        ));
      })
    }
  };
}

function rowMetrics(row, isTeam) {
  return isTeam ? row.slice(1, 8) : row.slice(2, 9);
}

function rowId(row) {
  return String(row?.[0] || "").trim();
}

function appendRowSeries(targetMap, rows, isTeam, snapshotIndex) {
  for (const row of rows || []) {
    const id = rowId(row);
    if (!id) continue;
    const point = [snapshotIndex, ...rowMetrics(row, isTeam)];
    const prior = Array.isArray(targetMap[id]) ? targetMap[id].map((item) => item.slice()) : [];
    const last = prior[prior.length - 1];
    if (last && JSON.stringify(last.slice(1)) === JSON.stringify(point.slice(1))) continue;
    prior.push(point);
    targetMap[id] = prior;
  }
}

function trimHistoryMaps(entityMap, dropCount) {
  const next = {};
  for (const [entityId, points] of Object.entries(entityMap || {})) {
    const shifted = (points || [])
      .filter((point) => Array.isArray(point) && Number(point[0]) >= dropCount)
      .map((point) => [Number(point[0]) - dropCount, ...point.slice(1)]);
    if (shifted.length) next[entityId] = shifted;
  }
  return next;
}

function trimHistory(history, maxSnapshots) {
  const limit = Math.max(1, Math.floor(Number(maxSnapshots) || DEFAULT_HISTORY_LIMIT));
  if ((history?.s || []).length <= limit) return history;

  const dropCount = history.s.length - limit;
  const firstRetained = history.s[dropCount];
  const retainedOffsetSec = Number(firstRetained?.[0]) || 0;
  const next = {
    t0: Number(history.t0 || 0) + (retainedOffsetSec * 1000),
    s: history.s.slice(dropCount).map((item) => [Math.max(0, Number(item?.[0]) - retainedOffsetSec), Number(item?.[1]) || 0]),
    a: [
      trimHistoryMaps(history.a?.[0], dropCount),
      trimHistoryMaps(history.a?.[1], dropCount),
      trimHistoryMaps(history.a?.[2], dropCount)
    ],
    r: (history.r || []).map((roundScopes) => ([
      trimHistoryMaps(roundScopes?.[0], dropCount),
      trimHistoryMaps(roundScopes?.[1], dropCount),
      trimHistoryMaps(roundScopes?.[2], dropCount)
    ])),
    m: {
      e: (history?.m?.e || []).filter((point) => Number(point?.[0]) >= dropCount)
        .map((point) => [Number(point[0]) - dropCount, ...point.slice(1)]),
      r: (history?.m?.r || []).map((matches) => trimHistoryMaps(matches, dropCount))
    }
  };
  return next;
}

function appendScopeHistory(targetScopes, compactScope, snapshotIndex) {
  appendRowSeries(targetScopes[0], compactScope?.[0], true, snapshotIndex);
  appendRowSeries(targetScopes[1], compactScope?.[1], false, snapshotIndex);
  appendRowSeries(targetScopes[2], compactScope?.[2], false, snapshotIndex);
}

function appendMatchPlayHistory(history, compactMatchPlay, snapshotIndex) {
  if (!Array.isArray(compactMatchPlay?.[0]) || compactMatchPlay[0].length !== 2) return;
  const eventOdds = Array.isArray(compactMatchPlay?.[1]) ? compactMatchPlay[1] : [0, 0, 0];
  const rounds = Array.isArray(compactMatchPlay?.[2]) ? compactMatchPlay[2] : [];
  const roundProgress = rounds.map((matches) => {
    const rows = Array.isArray(matches) ? matches : [];
    if (!rows.length) return 0;
    return rows.reduce((sum, match) => sum + Math.min(1, Math.max(0, Number(match?.[7]) || 0) / Math.max(1, Number(match?.[8]) || 1)), 0) / rows.length;
  });
  const eventProgress = roundProgress.length
    ? roundProgress.reduce((sum, value) => sum + value, 0) / roundProgress.length
    : 0;
  const eventPoint = [snapshotIndex, eventProgress, ...eventOdds.slice(0, 3)];
  const priorEvent = history.m.e[history.m.e.length - 1];
  if (!priorEvent || JSON.stringify(priorEvent.slice(1)) !== JSON.stringify(eventPoint.slice(1))) history.m.e.push(eventPoint);

  rounds.forEach((matches, roundIndex) => {
    if (!history.m.r[roundIndex]) history.m.r[roundIndex] = {};
    for (const match of matches || []) {
      const matchId = String(match?.[0] || "");
      if (!matchId) continue;
      const progress = Math.min(1, Math.max(0, Number(match?.[7]) || 0) / Math.max(1, Number(match?.[8]) || 1));
      const point = [snapshotIndex, progress, Number(match?.[3]) || 0, Number(match?.[4]) || 0, Number(match?.[5]) || 0];
      const prior = Array.isArray(history.m.r[roundIndex][matchId]) ? history.m.r[roundIndex][matchId] : [];
      const last = prior[prior.length - 1];
      if (!last || JSON.stringify(last.slice(1)) !== JSON.stringify(point.slice(1))) prior.push(point);
      history.m.r[roundIndex][matchId] = prior;
    }
  });
}

export function compactLiveOddsPayload(liveOdds = {}) {
  const matchPlay = compactMatchPlay(liveOdds?.match_play);
  return {
    s: Math.max(0, Math.round(Number(liveOdds?.simCount) || 0)),
    l: LATENCY_MODE_CODES[String(liveOdds?.latencyMode || "").trim()] ?? 0,
    r: (liveOdds?.rounds || []).map((roundScope) => compactScopeRows(roundScope, { includeHoleDetails: true })),
    a: compactScopeRows(liveOdds?.all_rounds || {}, { includeHoleDetails: false }),
    ...(matchPlay ? { m: matchPlay } : {})
  };
}

export function appendCompactLiveOddsHistory(previousHistory, previousCompactOdds, nextCompactOdds, {
  snapshotTimeMs = Date.now(),
  version = 0,
  maxSnapshots = DEFAULT_HISTORY_LIMIT
} = {}) {
  if (previousCompactOdds && JSON.stringify(previousCompactOdds) === JSON.stringify(nextCompactOdds)) {
    return cloneHistoryShape(previousHistory, nextCompactOdds?.r?.length || 0);
  }

  const history = cloneHistoryShape(previousHistory, nextCompactOdds?.r?.length || 0);
  const snapshotMs = Math.max(0, Math.round(Number(snapshotTimeMs) || Date.now()));
  if (!history.t0) history.t0 = snapshotMs;
  const offsetSec = Math.max(0, Math.round((snapshotMs - history.t0) / 1000));
  const snapshotIndex = history.s.length;
  history.s.push([offsetSec, Math.max(0, Math.round(Number(version) || 0))]);

  appendScopeHistory(history.a, nextCompactOdds?.a || [[], [], []], snapshotIndex);
  const roundScopes = Array.isArray(nextCompactOdds?.r) ? nextCompactOdds.r : [];
  for (let roundIndex = 0; roundIndex < roundScopes.length; roundIndex++) {
    if (!Array.isArray(history.r[roundIndex])) history.r[roundIndex] = [{}, {}, {}];
    appendScopeHistory(history.r[roundIndex], roundScopes[roundIndex] || [[], [], []], snapshotIndex);
  }
  appendMatchPlayHistory(history, nextCompactOdds?.m, snapshotIndex);

  return trimHistory(history, maxSnapshots);
}

export const LIVE_ODDS_HISTORY_LIMIT = DEFAULT_HISTORY_LIMIT;
