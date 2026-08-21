import fs from "node:fs/promises";
import zlib from "node:zlib";

import { computeLiveOdds } from "./live_odds.js";

const PUBLIC_TOURNAMENT_BASE = "https://golf-public.s3.us-east-1.amazonaws.com/tournaments";
const HOLE_COUNT = 18;
const EPSILON = 1e-6;

function sumPlayed(arr) {
  return (arr || []).reduce((total, value) => {
    if (value == null) return total;
    const n = Number(value);
    return Number.isFinite(n) ? total + n : total;
  }, 0);
}

function thruFromHoles(arr) {
  let last = -1;
  for (let idx = 0; idx < HOLE_COUNT; idx++) {
    const value = Number(arr?.[idx]);
    if (Number.isFinite(value) && value > 0) last = idx;
  }
  return last + 1;
}

function normalizeHoleArray(arr, visibleHoles) {
  return Array.from({ length: HOLE_COUNT }, (_, holeIndex) => {
    if (holeIndex >= visibleHoles) return null;
    const value = arr?.[holeIndex];
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  });
}

function normalizeNumberArray(arr) {
  return Array.from({ length: HOLE_COUNT }, (_, holeIndex) => {
    const value = Number(arr?.[holeIndex]);
    return Number.isFinite(value) ? value : 0;
  });
}

function normalizeDiffArray(arr, visibleHoles) {
  return Array.from({ length: HOLE_COUNT }, (_, holeIndex) => {
    if (holeIndex >= visibleHoles) return null;
    const value = arr?.[holeIndex];
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  });
}

function truncateScoreEntry(entry, visibleHoles) {
  if (!entry || typeof entry !== "object") return entry;
  const gross = normalizeHoleArray(entry.gross, visibleHoles);
  const net = normalizeHoleArray(entry.net, visibleHoles);
  const grossToPar = normalizeDiffArray(entry.grossToPar, visibleHoles);
  const netToPar = normalizeDiffArray(entry.netToPar, visibleHoles);
  const handicapShots = normalizeNumberArray(entry.handicapShots);
  const out = {
    ...entry,
    gross,
    net,
    grossToPar,
    netToPar,
    handicapShots,
    grossTotal: sumPlayed(gross),
    netTotal: sumPlayed(net),
    grossToParTotal: sumPlayed(grossToPar),
    netToParTotal: sumPlayed(netToPar),
    thru: Math.max(thruFromHoles(gross), thruFromHoles(net))
  };

  if (entry.groups && typeof entry.groups === "object") {
    out.groups = Object.fromEntries(
      Object.entries(entry.groups).map(([groupKey, groupEntry]) => [
        groupKey,
        truncateScoreEntry(groupEntry, visibleHoles)
      ])
    );
  }

  return out;
}

function truncateTournamentByStage(tournamentJson, stageIndex) {
  const clone = JSON.parse(JSON.stringify(tournamentJson));
  const rounds = clone?.tournament?.rounds || [];
  const scoreRounds = clone?.score_data?.rounds || [];

  for (let roundIndex = 0; roundIndex < rounds.length; roundIndex++) {
    const visibleHoles = Math.max(0, Math.min(HOLE_COUNT, stageIndex - (roundIndex * HOLE_COUNT)));
    const roundData = scoreRounds[roundIndex];
    if (!roundData) continue;

    if (roundData.player && typeof roundData.player === "object") {
      roundData.player = Object.fromEntries(
        Object.entries(roundData.player).map(([playerId, entry]) => [
          playerId,
          truncateScoreEntry(entry, visibleHoles)
        ])
      );
    }

    if (roundData.team && typeof roundData.team === "object") {
      roundData.team = Object.fromEntries(
        Object.entries(roundData.team).map(([teamId, entry]) => [
          teamId,
          truncateScoreEntry(entry, visibleHoles)
        ])
      );
    }
  }

  return clone;
}

function probabilityRowsById(rows, idKey) {
  const out = new Map();
  for (const row of rows || []) {
    const entityId = String(row?.[idKey] || "").trim();
    if (!entityId) continue;
    out.set(entityId, Math.max(0, Math.min(1, Number(row?.leaderProbability || 0) / 100)));
  }
  return out;
}

function shareRowsById(rows, idKey) {
  const out = new Map();
  for (const row of rows || []) {
    const entityId = String(row?.[idKey] || "").trim();
    if (!entityId) continue;
    const share = Math.max(0, Math.min(1, Number(row?.leaderProbability || 0) / 100));
    if (share <= 0) continue;
    out.set(entityId, share);
  }
  return out;
}

function mapToSortedEntries(probabilityById) {
  return Array.from(probabilityById.entries())
    .map(([entityId, probability]) => ({ entityId, probability }))
    .sort((a, b) => b.probability - a.probability || a.entityId.localeCompare(b.entityId));
}

function multiclassBrier(predictedById, actualById) {
  const ids = new Set([...predictedById.keys(), ...actualById.keys()]);
  let total = 0;
  for (const id of ids) {
    total += (Number(predictedById.get(id) || 0) - Number(actualById.get(id) || 0)) ** 2;
  }
  return total;
}

function multiclassLogLoss(predictedById, actualById) {
  let total = 0;
  for (const [id, actualShare] of actualById.entries()) {
    total -= Number(actualShare) * Math.log(Math.max(EPSILON, Number(predictedById.get(id) || 0)));
  }
  return total;
}

function calibrationBucketFor(probability) {
  const pct = Math.max(0, Math.min(100, probability * 100));
  if (pct < 5) return "0-5%";
  if (pct < 10) return "5-10%";
  if (pct < 20) return "10-20%";
  if (pct < 35) return "20-35%";
  if (pct < 50) return "35-50%";
  if (pct < 65) return "50-65%";
  if (pct < 80) return "65-80%";
  return "80-100%";
}

function evaluateTeamBacktest(finishedTournamentJson) {
  const finalOdds = computeLiveOdds(finishedTournamentJson, {
    generatedAt: finishedTournamentJson?.updatedAt ? new Date(finishedTournamentJson.updatedAt).toISOString() : new Date().toISOString()
  });
  const finalTeamRows = finalOdds?.all_rounds?.teams || [];
  const actualWinnerShareById = shareRowsById(finalTeamRows, "teamId");
  const stageCount = (finishedTournamentJson?.tournament?.rounds?.length || 0) * HOLE_COUNT;
  const calibrationBuckets = new Map();
  const stages = [];
  let brierSum = 0;
  let logLossSum = 0;

  for (let stageIndex = 0; stageIndex <= stageCount; stageIndex++) {
    const snapshotJson = truncateTournamentByStage(finishedTournamentJson, stageIndex);
    const odds = computeLiveOdds(snapshotJson, {
      generatedAt: snapshotJson?.updatedAt ? new Date(snapshotJson.updatedAt).toISOString() : new Date().toISOString()
    });
    const teamRows = odds?.all_rounds?.teams || [];
    const predictedById = probabilityRowsById(teamRows, "teamId");
    const ranking = mapToSortedEntries(predictedById);
    const winnerMass = Array.from(actualWinnerShareById.keys()).reduce(
      (sum, teamId) => sum + Number(predictedById.get(teamId) || 0),
      0
    );
    const winnerRanks = Array.from(actualWinnerShareById.keys()).map((teamId) => {
      const rank = ranking.findIndex((row) => row.entityId === teamId);
      return rank >= 0 ? rank + 1 : null;
    }).filter((value) => value != null);

    for (const [teamId, probability] of predictedById.entries()) {
      const bucketKey = calibrationBucketFor(probability);
      if (!calibrationBuckets.has(bucketKey)) {
        calibrationBuckets.set(bucketKey, {
          bucket: bucketKey,
          count: 0,
          predictedSum: 0,
          actualSum: 0
        });
      }
      const bucket = calibrationBuckets.get(bucketKey);
      bucket.count += 1;
      bucket.predictedSum += probability;
      bucket.actualSum += Number(actualWinnerShareById.get(teamId) || 0);
    }

    const brier = multiclassBrier(predictedById, actualWinnerShareById);
    const logLoss = multiclassLogLoss(predictedById, actualWinnerShareById);
    brierSum += brier;
    logLossSum += logLoss;
    stages.push({
      stageIndex,
      round: Math.floor(stageIndex / HOLE_COUNT) + 1,
      hole: ((stageIndex - 1 + HOLE_COUNT) % HOLE_COUNT) + 1,
      holesRevealed: stageIndex,
      winnerMass,
      winnerRanks,
      leader: ranking[0] || null,
      brier,
      logLoss
    });
  }

  return {
    actualWinnerShareById: Object.fromEntries(actualWinnerShareById),
    stageCount,
    meanBrier: brierSum / Math.max(1, stages.length),
    meanLogLoss: logLossSum / Math.max(1, stages.length),
    stages,
    calibrationBuckets: Array.from(calibrationBuckets.values())
      .map((bucket) => ({
        bucket: bucket.bucket,
        count: bucket.count,
        avgPredicted: bucket.predictedSum / Math.max(1, bucket.count),
        avgActual: bucket.actualSum / Math.max(1, bucket.count)
      }))
      .sort((a, b) => a.avgPredicted - b.avgPredicted)
  };
}

async function maybeGunzip(buffer) {
  try {
    return zlib.gunzipSync(buffer);
  } catch (_error) {
    return buffer;
  }
}

async function loadTournamentJson(source) {
  const raw = String(source || "").trim();
  if (!raw) throw new Error("missing tournament source");

  if (raw.startsWith("t_")) {
    const response = await fetch(`${PUBLIC_TOURNAMENT_BASE}/${encodeURIComponent(raw)}.json`);
    if (!response.ok) {
      throw new Error(`failed to fetch ${raw}: ${response.status} ${response.statusText}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const bytes = await maybeGunzip(buffer);
    return { source: raw, json: JSON.parse(bytes.toString("utf8")) };
  }

  const fileBuffer = await fs.readFile(raw);
  const bytes = await maybeGunzip(fileBuffer);
  return { source: raw, json: JSON.parse(bytes.toString("utf8")) };
}

function tournamentCompletionSummary(tournamentJson) {
  const odds = computeLiveOdds(tournamentJson, {
    generatedAt: tournamentJson?.updatedAt ? new Date(tournamentJson.updatedAt).toISOString() : new Date().toISOString()
  });
  const teams = odds?.all_rounds?.teams || [];
  const holesRemaining = teams.reduce((max, row) => Math.max(max, Number(row?.holesRemaining || 0)), 0);
  return {
    teamCount: teams.length,
    finished: holesRemaining === 0,
    holesRemaining
  };
}

function summarizeBacktest(source, tournamentJson, backtest) {
  const tournamentName = tournamentJson?.tournament?.name || source;
  const rounds = tournamentJson?.tournament?.rounds || [];
  const earlyStage = backtest.stages[Math.min(3, backtest.stages.length - 1)] || null;
  const middleStage = backtest.stages[Math.floor((backtest.stages.length - 1) / 2)] || null;
  const lateStage = backtest.stages[Math.max(0, backtest.stages.length - 4)] || null;

  return {
    source,
    tournamentId: tournamentJson?.tournament?.tournamentId || source,
    tournamentName,
    roundCount: rounds.length,
    formats: rounds.map((round) => round?.format || ""),
    actualWinnerShareById: backtest.actualWinnerShareById,
    meanBrier: Number(backtest.meanBrier.toFixed(4)),
    meanLogLoss: Number(backtest.meanLogLoss.toFixed(4)),
    calibrationBuckets: backtest.calibrationBuckets.map((bucket) => ({
      bucket: bucket.bucket,
      count: bucket.count,
      avgPredicted: Number(bucket.avgPredicted.toFixed(3)),
      avgActual: Number(bucket.avgActual.toFixed(3))
    })),
    winnerProbabilityPath: [earlyStage, middleStage, lateStage]
      .filter(Boolean)
      .map((stage) => ({
        holesRevealed: stage.holesRevealed,
        winnerMass: Number(stage.winnerMass.toFixed(3)),
        winnerRanks: stage.winnerRanks,
        leader: stage.leader
          ? {
              teamId: stage.leader.entityId,
              probability: Number(stage.leader.probability.toFixed(3))
            }
          : null
      }))
  };
}

async function main() {
  const sources = process.argv.slice(2);
  if (!sources.length) {
    throw new Error("usage: node aws_backend/src/live_odds_backtest.js <tournament-id-or-json-path> [...]");
  }

  const summaries = [];
  for (const source of sources) {
    const { json: tournamentJson } = await loadTournamentJson(source);
    const completion = tournamentCompletionSummary(tournamentJson);
    if (!completion.finished) {
      summaries.push({
        source,
        tournamentId: tournamentJson?.tournament?.tournamentId || source,
        tournamentName: tournamentJson?.tournament?.name || source,
        skipped: true,
        reason: `tournament incomplete (${completion.holesRemaining} team holes remaining in all-round odds)`
      });
      continue;
    }

    const backtest = evaluateTeamBacktest(tournamentJson);
    summaries.push(summarizeBacktest(source, tournamentJson, backtest));
  }

  console.log(JSON.stringify({ tournaments: summaries }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
