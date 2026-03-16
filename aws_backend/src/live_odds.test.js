import assert from "node:assert/strict";

import { computeLiveOdds } from "./live_odds.js";
import { appendCompactLiveOddsHistory, compactLiveOddsPayload } from "./live_odds_compact.js";

let nodeTest = null;
try {
  ({ default: nodeTest } = await import("node:test"));
} catch (_error) {
  nodeTest = null;
}

const fallbackTests = [];

function registerTest(name, fn) {
  if (nodeTest) {
    nodeTest(name, fn);
    return;
  }
  fallbackTests.push({ name, fn });
}

const FIXED_NOW = "2026-03-15T12:00:00.000Z";
const PARS = Array(18).fill(4);
const STROKE_INDEX = Array.from({ length: 18 }, (_, idx) => idx + 1);
const deepClone = (value) => JSON.parse(JSON.stringify(value));

function strokesPerHole(handicap, strokeIndex18) {
  const H = Math.max(0, Math.floor(Number(handicap) || 0));
  const base = Math.floor(H / 18);
  const rem = H % 18;
  return strokeIndex18.map((si) => base + (Number(si) <= rem ? 1 : 0));
}

function grossArray(score = null) {
  return Array.from({ length: 18 }, () => score);
}

function sumPlayed(arr) {
  return (arr || []).reduce((total, value) => total + (value == null ? 0 : Number(value) || 0), 0);
}

function toParTotal(arr, par) {
  return (arr || []).reduce((total, value, idx) => total + (value == null ? 0 : Number(value) - Number(par[idx] || 0)), 0);
}

function playerEntry(grossScore, handicap = 0) {
  const gross = grossArray(grossScore);
  const handicapShots = strokesPerHole(handicap, STROKE_INDEX);
  const net = gross.map((value, idx) => value == null ? null : Number(value) - Number(handicapShots[idx] || 0));
  return {
    gross,
    net,
    handicapShots,
    grossTotal: sumPlayed(gross),
    netTotal: sumPlayed(net),
    grossToParTotal: toParTotal(gross, PARS),
    netToParTotal: toParTotal(net, PARS),
    thru: grossScore == null ? 0 : 18
  };
}

function teamEntry(grossScore, handicap = 0) {
  return playerEntry(grossScore, handicap);
}

function materializedFixture(format, { useHandicap = false, includeFutureRound = false } = {}) {
  const rounds = [
    {
      name: "Round 1",
      format,
      useHandicap,
      weight: 1,
      courseIndex: 0,
      teamAggregation: { topX: 2 }
    }
  ];
  if (includeFutureRound) {
    rounds.push({
      name: "Round 2",
      format: "singles",
      useHandicap,
      weight: 1,
      courseIndex: 0,
      teamAggregation: { topX: 2 }
    });
  }

  const players = [
    { playerId: "A1", name: "Alice", teamId: "A", handicap: useHandicap ? 6 : 0, groups: ["A"], group: "A" },
    { playerId: "A2", name: "Avery", teamId: "A", handicap: useHandicap ? 8 : 0, groups: ["A"], group: "A" },
    { playerId: "B1", name: "Blair", teamId: "B", handicap: useHandicap ? 12 : 0, groups: ["A"], group: "A" },
    { playerId: "B2", name: "Bailey", teamId: "B", handicap: useHandicap ? 14 : 0, groups: ["A"], group: "A" }
  ];

  const scoreDataRounds = rounds.map((round, roundIndex) => ({
    roundIndex,
    format: round.format,
    useHandicap: !!round.useHandicap,
    player: {},
    team: {},
    leaderboard: { teams: [], players: [] }
  }));

  if (format === "scramble") {
    scoreDataRounds[0].team.A = teamEntry(4, useHandicap ? 7 : 0);
    scoreDataRounds[0].team.B = teamEntry(5, useHandicap ? 13 : 0);
  } else if (format === "two_man_scramble") {
    scoreDataRounds[0].team.A = {
      ...teamEntry(4, useHandicap ? 5 : 0),
      groups: {
        A: {
          label: "Group A",
          groupId: "A::A",
          playerIds: ["A1", "A2"],
          ...playerEntry(4, useHandicap ? 5 : 0)
        }
      }
    };
    scoreDataRounds[0].team.B = {
      ...teamEntry(5, useHandicap ? 11 : 0),
      groups: {
        A: {
          label: "Group A",
          groupId: "B::A",
          playerIds: ["B1", "B2"],
          ...playerEntry(5, useHandicap ? 11 : 0)
        }
      }
    };
  } else {
    scoreDataRounds[0].player.A1 = playerEntry(4, players[0].handicap);
    scoreDataRounds[0].player.A2 = playerEntry(4, players[1].handicap);
    scoreDataRounds[0].player.B1 = playerEntry(5, players[2].handicap);
    scoreDataRounds[0].player.B2 = playerEntry(5, players[3].handicap);
  }

  if (includeFutureRound) {
    for (const player of players) {
      const handicapShots = strokesPerHole(player.handicap, STROKE_INDEX);
      scoreDataRounds[1].player[player.playerId] = {
        gross: grossArray(null),
        net: grossArray(null),
        handicapShots,
        grossTotal: 0,
        netTotal: 0,
        grossToParTotal: 0,
        netToParTotal: 0,
        thru: 0
      };
    }
  }

  return {
    tournament: {
      tournamentId: `fixture-${format}`,
      name: `Fixture ${format}`,
      dates: "2026-03-15",
      rounds
    },
    course: {
      name: "Fixture Course",
      pars: PARS.slice(),
      strokeIndex: STROKE_INDEX.slice()
    },
    courses: [{
      name: "Fixture Course",
      pars: PARS.slice(),
      strokeIndex: STROKE_INDEX.slice()
    }],
    teams: [
      { teamId: "A", teamName: "Alpha", groupsByRound: { "0": { A: ["A1", "A2"] } } },
      { teamId: "B", teamName: "Beta", groupsByRound: { "0": { A: ["B1", "B2"] } } }
    ],
    players,
    updatedAt: Date.parse(FIXED_NOW),
    version: 5,
    score_data: {
      rounds: scoreDataRounds,
      leaderboard_all: {
        teams: [],
        players: []
      }
    }
  };
}

registerTest("computeLiveOdds is deterministic for a fixed materialized tournament payload", () => {
  const tournamentJson = materializedFixture("singles");
  const first = computeLiveOdds(tournamentJson, { generatedAt: FIXED_NOW });
  const second = computeLiveOdds(tournamentJson, { generatedAt: FIXED_NOW });
  assert.deepEqual(first, second);
});

for (const format of [
  "singles",
  "shamble",
  "team_best_ball",
  "scramble",
  "two_man_scramble",
  "two_man_shamble",
  "two_man_best_ball"
]) {
  registerTest(`completed ${format} rounds settle to the expected leaders`, () => {
    const tournamentJson = materializedFixture(format);
    const odds = computeLiveOdds(tournamentJson, { generatedAt: FIXED_NOW });
    const teamOdds = new Map((odds.rounds?.[0]?.teams || []).map((row) => [row.teamId, row]));
    assert.equal(teamOdds.get("A")?.leaderProbability, 100);
    assert.equal(teamOdds.get("B")?.leaderProbability, 0);
    assert.ok(Number(teamOdds.get("A")?.projectedScore || 0) < Number(teamOdds.get("B")?.projectedScore || 0));

    const entityRows = format.startsWith("two_man")
      ? odds.rounds?.[0]?.groups || []
      : odds.rounds?.[0]?.players || [];
    const probabilitySum = entityRows.reduce((total, row) => total + Number(row?.leaderProbability || 0), 0);
    assert.ok(Math.abs(probabilitySum - 100) < 0.02);
  });
}

registerTest("handicap rounds publish net-aware projections", () => {
  const tournamentJson = materializedFixture("singles", { useHandicap: true });
  const odds = computeLiveOdds(tournamentJson, { generatedAt: FIXED_NOW });
  const teamOdds = new Map((odds.rounds?.[0]?.teams || []).map((row) => [row.teamId, row]));
  assert.equal(teamOdds.get("A")?.leaderProbability, 100);
  assert.equal(teamOdds.get("A")?.lowestNetProbability, 100);
  assert.ok(Number.isFinite(teamOdds.get("A")?.projectedNet));
  assert.ok(Number(teamOdds.get("A")?.projectedNet || 0) < Number(teamOdds.get("A")?.projectedGross || 0));
});

registerTest("all-round odds include future unstarted holes", () => {
  const tournamentJson = materializedFixture("singles", { includeFutureRound: true });
  const odds = computeLiveOdds(tournamentJson, { generatedAt: FIXED_NOW });
  const roundTeamOdds = new Map((odds.rounds?.[0]?.teams || []).map((row) => [row.teamId, row]));
  const allRoundTeamOdds = new Map((odds.all_rounds?.teams || []).map((row) => [row.teamId, row]));
  assert.equal(roundTeamOdds.get("A")?.holesRemaining, 0);
  assert.ok(Number(allRoundTeamOdds.get("A")?.holesRemaining || 0) > 0);
  assert.ok(Number(allRoundTeamOdds.get("A")?.projectedScore || 0) > Number(roundTeamOdds.get("A")?.projectedScore || 0));
});

registerTest("compact live odds payload strips names and quantizes output", () => {
  const tournamentJson = materializedFixture("singles", { includeFutureRound: true });
  const odds = computeLiveOdds(tournamentJson, { generatedAt: FIXED_NOW });
  const compact = compactLiveOddsPayload(odds);

  assert.equal(typeof compact?.s, "number");
  assert.equal(Array.isArray(compact?.r), true);
  assert.equal(Array.isArray(compact?.a), true);

  const teamRow = compact?.r?.[0]?.[0]?.[0];
  assert.equal(Array.isArray(teamRow), true);
  assert.equal(teamRow.length, 8);
  assert.equal(teamRow[0], "A");
  assert.equal(Number.isInteger(teamRow[1]), true);
  assert.equal(teamRow[4] == null || Number.isInteger(teamRow[4]), true);

  const playerRow = compact?.r?.[0]?.[1]?.[0];
  assert.equal(Array.isArray(playerRow), true);
  assert.equal(playerRow.length, 9);
  assert.equal(playerRow[0], "A1");
  assert.equal(playerRow[1], "A");
});

registerTest("compact live odds history appends sparse snapshots and skips unchanged odds", () => {
  const tournamentJson = materializedFixture("singles", { includeFutureRound: true });
  const odds = computeLiveOdds(tournamentJson, { generatedAt: FIXED_NOW });
  const compact = compactLiveOddsPayload(odds);
  const snapshotTimeMs = Date.parse(FIXED_NOW);

  const first = appendCompactLiveOddsHistory(null, null, compact, {
    snapshotTimeMs,
    version: 5,
    maxSnapshots: 8
  });
  assert.equal(first?.s?.length, 1);
  assert.equal(Array.isArray(first?.a?.[0]?.A), true);
  assert.equal(first.a[0].A[0][0], 0);

  const unchanged = appendCompactLiveOddsHistory(first, compact, compact, {
    snapshotTimeMs: snapshotTimeMs + 60_000,
    version: 6,
    maxSnapshots: 8
  });
  assert.equal(unchanged?.s?.length, 1);

  const changedCompact = deepClone(compact);
  changedCompact.a[0][0][1] = 99;
  const changed = appendCompactLiveOddsHistory(first, compact, changedCompact, {
    snapshotTimeMs: snapshotTimeMs + 60_000,
    version: 6,
    maxSnapshots: 8
  });
  assert.equal(changed?.s?.length, 2);
  assert.equal(changed?.a?.[0]?.A?.length, 2);
  assert.equal(changed.a[0].A[1][0], 1);
  assert.equal(changed.a[0].A[1][1], 99);
});

if (!nodeTest) {
  let failed = 0;
  for (const { name, fn } of fallbackTests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok - ${name}`);
      console.error(error);
    }
  }
  if (failed > 0) process.exit(1);
}
