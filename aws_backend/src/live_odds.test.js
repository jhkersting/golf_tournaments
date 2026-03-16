import assert from "node:assert/strict";

import { computeLiveOdds } from "./live_odds.js";
import { appendCompactLiveOddsHistory, compactLiveOddsPayload } from "./live_odds_compact.js";
import { materializePublicFromState } from "./utils.js";

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

function materializedFixture(format, { useHandicap = false, includeFutureRound = false, courseOverrides = null, roundOverrides = null } = {}) {
  const rounds = [
    {
      name: "Round 1",
      format,
      useHandicap,
      weight: 1,
      courseIndex: 0,
      teamAggregation: { topX: 2 },
      ...(roundOverrides && typeof roundOverrides === "object" ? roundOverrides : {})
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

  const baseCourse = {
    name: "Fixture Course",
    pars: PARS.slice(),
    strokeIndex: STROKE_INDEX.slice()
  };
  const mergedCourse = {
    ...baseCourse,
    ...(courseOverrides && typeof courseOverrides === "object" ? courseOverrides : {})
  };

  return {
    tournament: {
      tournamentId: `fixture-${format}`,
      name: `Fixture ${format}`,
      dates: "2026-03-15",
      rounds
    },
    course: { ...mergedCourse },
    courses: [{ ...mergedCourse }],
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

registerTest("4-man scramble projections beat a scratch player's singles baseline", () => {
  const teams = [
    { teamId: "A", teamName: "Alpha" },
    { teamId: "B", teamName: "Beta" }
  ];
  const players = [
    { playerId: "A1", name: "Alice", teamId: "A", handicap: 0, groups: ["A"], group: "A" },
    { playerId: "A2", name: "Avery", teamId: "A", handicap: 8, groups: ["A"], group: "A" },
    { playerId: "A3", name: "Alex", teamId: "A", handicap: 14, groups: ["A"], group: "A" },
    { playerId: "A4", name: "Addison", teamId: "A", handicap: 18, groups: ["A"], group: "A" },
    { playerId: "B1", name: "Blair", teamId: "B", handicap: 8, groups: ["A"], group: "A" },
    { playerId: "B2", name: "Bailey", teamId: "B", handicap: 12, groups: ["A"], group: "A" },
    { playerId: "B3", name: "Brett", teamId: "B", handicap: 16, groups: ["A"], group: "A" },
    { playerId: "B4", name: "Brooke", teamId: "B", handicap: 20, groups: ["A"], group: "A" }
  ];
  const course = {
    name: "Fixture Course",
    pars: PARS.slice(),
    strokeIndex: STROKE_INDEX.slice()
  };

  const scrambleTournament = {
    tournament: {
      tournamentId: "fixture-four-man-scramble",
      name: "Fixture four-man scramble",
      dates: "2026-03-15",
      rounds: [{
        name: "Round 1",
        format: "scramble",
        useHandicap: false,
        weight: 1,
        courseIndex: 0,
        teamAggregation: { topX: 4 }
      }]
    },
    course: { ...course },
    courses: [{ ...course }],
    teams,
    players,
    updatedAt: Date.parse(FIXED_NOW),
    version: 5,
    score_data: {
      rounds: [{
        roundIndex: 0,
        format: "scramble",
        useHandicap: false,
        player: {},
        team: {
          A: teamEntry(null, 0),
          B: teamEntry(null, 0)
        },
        leaderboard: { teams: [], players: [] }
      }],
      leaderboard_all: { teams: [], players: [] }
    }
  };

  const singlesTournament = deepClone(scrambleTournament);
  singlesTournament.tournament.tournamentId = "fixture-four-man-singles";
  singlesTournament.tournament.name = "Fixture four-man singles";
  singlesTournament.tournament.rounds[0].format = "singles";
  singlesTournament.score_data.rounds[0].format = "singles";
  singlesTournament.score_data.rounds[0].team = {};
  singlesTournament.score_data.rounds[0].player = Object.fromEntries(
    players.map((player) => [player.playerId, playerEntry(null, player.handicap)])
  );

  const scrambleOdds = computeLiveOdds(scrambleTournament, { generatedAt: FIXED_NOW });
  const singlesOdds = computeLiveOdds(singlesTournament, { generatedAt: FIXED_NOW });
  const scrambleTeamA = (scrambleOdds.rounds?.[0]?.teams || []).find((row) => row.teamId === "A");
  const singlesScratch = (singlesOdds.rounds?.[0]?.players || []).find((row) => row.playerId === "A1");

  assert.ok(scrambleTeamA);
  assert.ok(singlesScratch);
  assert.ok(
    Number(scrambleTeamA?.projectedGross || 0) < (Number(singlesScratch?.projectedGross || 0) - 2),
    `expected four-man scramble to beat scratch singles baseline: ${scrambleTeamA?.projectedGross} vs ${singlesScratch?.projectedGross}`
  );
  assert.ok(
    Number(scrambleTeamA?.projectedGrossToPar || 0) < 4,
    `expected four-man scramble projection to stay well below +4: ${scrambleTeamA?.projectedGrossToPar}`
  );
});

registerTest("materialization leaves empty two-man best ball rounds unplayed", () => {
  const state = {
    tournament: {
      tournamentId: "fixture-two-man-empty",
      name: "Fixture two-man empty",
      scoring: "stableford"
    },
    rounds: [
      {
        name: "Round 1",
        format: "two_man_best_ball",
        useHandicap: true,
        weight: 1,
        courseIndex: 0,
        teamAggregation: { topX: 4 }
      }
    ],
    course: {
      pars: PARS.slice(),
      strokeIndex: STROKE_INDEX.slice()
    },
    courses: [{
      pars: PARS.slice(),
      strokeIndex: STROKE_INDEX.slice()
    }],
    teams: {
      A: { teamId: "A", teamName: "Alpha" },
      B: { teamId: "B", teamName: "Beta" }
    },
    players: {
      A1: { playerId: "A1", name: "Alice", teamId: "A", handicap: 6, groups: ["A"], group: "A" },
      A2: { playerId: "A2", name: "Avery", teamId: "A", handicap: 8, groups: ["A"], group: "A" },
      B1: { playerId: "B1", name: "Blair", teamId: "B", handicap: 12, groups: ["A"], group: "A" },
      B2: { playerId: "B2", name: "Bailey", teamId: "B", handicap: 14, groups: ["A"], group: "A" }
    },
    scores: {
      rounds: [{}]
    },
    updatedAt: Date.parse(FIXED_NOW),
    version: 1
  };

  const materialized = materializePublicFromState(state);
  const round = materialized.score_data.rounds[0];
  const team = round.team.A;
  const leaderboardRow = round.leaderboard.teams.find((row) => row.teamId === "A");

  assert.deepEqual(team.gross, grossArray(null));
  assert.deepEqual(team.net, grossArray(null));
  assert.equal(team.grossStablefordTotal, 0);
  assert.equal(team.netStablefordTotal, 0);
  assert.equal(team.thru, 0);
  assert.equal(leaderboardRow?.points, 0);
  assert.equal(leaderboardRow?.grossPoints, 0);
  assert.equal(leaderboardRow?.netPoints, 0);
  assert.equal(leaderboardRow?.thru, null);
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

registerTest("all-round team_best_ball projections keep summed team to-par totals", () => {
  const tournamentJson = materializedFixture("team_best_ball");
  const odds = computeLiveOdds(tournamentJson, { generatedAt: FIXED_NOW });
  const roundTeamOdds = new Map((odds.rounds?.[0]?.teams || []).map((row) => [row.teamId, row]));
  const allRoundTeamOdds = new Map((odds.all_rounds?.teams || []).map((row) => [row.teamId, row]));

  assert.equal(roundTeamOdds.get("B")?.projectedGrossToPar, 36);
  assert.equal(allRoundTeamOdds.get("B")?.projectedGrossToPar, 36);
  assert.equal(allRoundTeamOdds.get("B")?.projectedGrossToPar, roundTeamOdds.get("B")?.projectedGrossToPar);
});

registerTest("baseline modeling respects stroke index difficulty and handicap lookup", () => {
  const tournamentJson = materializedFixture("singles", { useHandicap: true });
  const playerHandicaps = new Map((tournamentJson.players || []).map((player) => [player.playerId, Number(player.handicap || 0)]));
  for (const playerId of Object.keys(tournamentJson.score_data.rounds[0].player || {})) {
    const handicap = playerHandicaps.get(playerId) || 0;
    tournamentJson.score_data.rounds[0].player[playerId] = {
      gross: grossArray(null),
      net: grossArray(null),
      handicapShots: strokesPerHole(handicap, STROKE_INDEX),
      grossTotal: 0,
      netTotal: 0,
      grossToParTotal: 0,
      netToParTotal: 0,
      thru: 0
    };
  }

  const odds = computeLiveOdds(tournamentJson, { generatedAt: FIXED_NOW });
  const playerOdds = new Map((odds.rounds?.[0]?.players || []).map((row) => [row.playerId, row]));
  const lowHandicap = playerOdds.get("A1");
  const highHandicap = playerOdds.get("B2");
  assert.ok(lowHandicap);
  assert.ok(highHandicap);

  const lowHandicapHole1 = Number(lowHandicap.remainingHoleExpectations?.find((item) => item.holeIndex === 0)?.projectedGross || 0);
  const lowHandicapHole18 = Number(lowHandicap.remainingHoleExpectations?.find((item) => item.holeIndex === 17)?.projectedGross || 0);
  const highHandicapHole1 = Number(highHandicap.remainingHoleExpectations?.find((item) => item.holeIndex === 0)?.projectedGross || 0);

  assert.ok(lowHandicapHole1 > lowHandicapHole18, `expected hardest hole to project higher than easiest hole: ${lowHandicapHole1} vs ${lowHandicapHole18}`);
  assert.ok(highHandicapHole1 > lowHandicapHole1, `expected higher handicap hardest-hole projection to be worse: ${highHandicapHole1} vs ${lowHandicapHole1}`);
});

registerTest("live hole scoring feeds future hole projections for players who have not played that hole", () => {
  const baselineTournament = materializedFixture("singles", { useHandicap: true });
  const liveTournament = deepClone(baselineTournament);

  for (const player of liveTournament.players || []) {
    const handicapShots = strokesPerHole(player.handicap, STROKE_INDEX);
    liveTournament.score_data.rounds[0].player[player.playerId] = {
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

  for (const [playerId, grossScore] of [["A1", 7], ["A2", 8]]) {
    const playerMeta = liveTournament.players.find((player) => player.playerId === playerId);
    const entry = liveTournament.score_data.rounds[0].player[playerId];
    const handicapShots = strokesPerHole(playerMeta.handicap, STROKE_INDEX);
    entry.gross[0] = grossScore;
    entry.net[0] = grossScore - Number(handicapShots[0] || 0);
    entry.grossTotal = grossScore;
    entry.netTotal = entry.net[0];
    entry.grossToParTotal = grossScore - PARS[0];
    entry.netToParTotal = entry.net[0] - PARS[0];
    entry.thru = 1;
  }

  const baselineOdds = computeLiveOdds(baselineTournament, { generatedAt: FIXED_NOW });
  const liveOdds = computeLiveOdds(liveTournament, { generatedAt: FIXED_NOW });
  const baselineB1 = (baselineOdds.rounds?.[0]?.players || []).find((row) => row.playerId === "B1");
  const liveB1 = (liveOdds.rounds?.[0]?.players || []).find((row) => row.playerId === "B1");
  const baselineHole1 = Number(baselineB1?.remainingHoleExpectations?.find((item) => item.holeIndex === 0)?.projectedGross || 0);
  const liveHole1 = Number(liveB1?.remainingHoleExpectations?.find((item) => item.holeIndex === 0)?.projectedGross || 0);

  assert.ok(liveHole1 > baselineHole1, `expected live-scoring hole effect to raise future projection: ${liveHole1} vs ${baselineHole1}`);
});

registerTest("player form impact is halved and capped", () => {
  const baselineTournament = materializedFixture("singles");
  const formTournament = deepClone(baselineTournament);

  for (const tournamentJson of [baselineTournament, formTournament]) {
    for (const playerId of Object.keys(tournamentJson.score_data.rounds[0].player || {})) {
      tournamentJson.score_data.rounds[0].player[playerId] = {
        gross: grossArray(null),
        net: grossArray(null),
        handicapShots: Array(18).fill(0),
        grossTotal: 0,
        netTotal: 0,
        grossToParTotal: 0,
        netToParTotal: 0,
        thru: 0
      };
    }
  }

  for (let holeIndex = 0; holeIndex < 9; holeIndex++) {
    formTournament.score_data.rounds[0].player.A1.gross[holeIndex] = 9;
    formTournament.score_data.rounds[0].player.A1.net[holeIndex] = 9;
  }
  formTournament.score_data.rounds[0].player.A1.grossTotal = 81;
  formTournament.score_data.rounds[0].player.A1.netTotal = 81;
  formTournament.score_data.rounds[0].player.A1.grossToParTotal = 45;
  formTournament.score_data.rounds[0].player.A1.netToParTotal = 45;
  formTournament.score_data.rounds[0].player.A1.thru = 9;

  const baselineOdds = computeLiveOdds(baselineTournament, { generatedAt: FIXED_NOW });
  const formOdds = computeLiveOdds(formTournament, { generatedAt: FIXED_NOW });
  const baselineA1 = (baselineOdds.rounds?.[0]?.players || []).find((row) => row.playerId === "A1");
  const formA1 = (formOdds.rounds?.[0]?.players || []).find((row) => row.playerId === "A1");
  const baselineHole10 = Number(baselineA1?.remainingHoleExpectations?.find((item) => item.holeIndex === 9)?.projectedGross || 0);
  const formHole10 = Number(formA1?.remainingHoleExpectations?.find((item) => item.holeIndex === 9)?.projectedGross || 0);

  const delta = formHole10 - baselineHole10;
  assert.ok(delta > 0.01, `expected form to still affect later holes: ${delta}`);
  assert.ok(delta <= 0.2, `expected capped form effect <= 0.2 strokes per hole: ${delta}`);
});

registerTest("round max hole score caps simulated hole outcomes", () => {
  const tournamentJson = materializedFixture("singles", {
    roundOverrides: {
      maxHoleScore: { type: "to_par", value: 3 }
    }
  });

  for (const playerId of Object.keys(tournamentJson.score_data.rounds[0].player || {})) {
    tournamentJson.score_data.rounds[0].player[playerId] = {
      gross: grossArray(null),
      net: grossArray(null),
      handicapShots: Array(18).fill(0),
      grossTotal: 0,
      netTotal: 0,
      grossToParTotal: 0,
      netToParTotal: 0,
      thru: 0
    };
  }

  const odds = computeLiveOdds(tournamentJson, { generatedAt: FIXED_NOW });
  const row = (odds.rounds?.[0]?.players || []).find((item) => item.playerId === "A1");
  const firstHole = row?.remainingHoleExpectations?.find((item) => item.holeIndex === 0);
  const maxScore = Math.max(...(firstHole?.grossDistribution || []).map((item) => Number(item.score || 0)));

  assert.ok(maxScore <= 7, `expected triple-bogey max cap of 7 on par 4, got ${maxScore}`);
});

registerTest("course rating and slope raise projections and widen handicap spread", () => {
  const neutralTournament = materializedFixture("singles", {
    useHandicap: true,
    courseOverrides: {
      ratings: [{ rating: 72.0, slope: 113 }],
      holeYardages: Array(18).fill(400),
      totalYards: 7200
    }
  });
  const toughTournament = materializedFixture("singles", {
    useHandicap: true,
    courseOverrides: {
      ratings: [{ rating: 76.5, slope: 145 }],
      holeYardages: Array(18).fill(435),
      totalYards: 7830
    }
  });

  for (const tournamentJson of [neutralTournament, toughTournament]) {
    const playerHandicaps = new Map((tournamentJson.players || []).map((player) => [player.playerId, Number(player.handicap || 0)]));
    for (const playerId of Object.keys(tournamentJson.score_data.rounds[0].player || {})) {
      const handicap = playerHandicaps.get(playerId) || 0;
      tournamentJson.score_data.rounds[0].player[playerId] = {
        gross: grossArray(null),
        net: grossArray(null),
        handicapShots: strokesPerHole(handicap, STROKE_INDEX),
        grossTotal: 0,
        netTotal: 0,
        grossToParTotal: 0,
        netToParTotal: 0,
        thru: 0
      };
    }
  }

  const neutralOdds = computeLiveOdds(neutralTournament, { generatedAt: FIXED_NOW });
  const toughOdds = computeLiveOdds(toughTournament, { generatedAt: FIXED_NOW });
  const neutralPlayers = new Map((neutralOdds.rounds?.[0]?.players || []).map((row) => [row.playerId, row]));
  const toughPlayers = new Map((toughOdds.rounds?.[0]?.players || []).map((row) => [row.playerId, row]));

  const neutralLow = Number(neutralPlayers.get("A1")?.projectedGross || 0);
  const neutralHigh = Number(neutralPlayers.get("B2")?.projectedGross || 0);
  const toughLow = Number(toughPlayers.get("A1")?.projectedGross || 0);
  const toughHigh = Number(toughPlayers.get("B2")?.projectedGross || 0);

  assert.ok(toughLow > neutralLow, `expected rated course to project higher gross for low handicap: ${toughLow} vs ${neutralLow}`);
  assert.ok((toughHigh - toughLow) > (neutralHigh - neutralLow), `expected slope to widen handicap spread: ${(toughHigh - toughLow)} vs ${(neutralHigh - neutralLow)}`);
});

registerTest("hole yardages influence hole-level projections beyond stroke index", () => {
  const flatYardageTournament = materializedFixture("singles", {
    useHandicap: true,
    courseOverrides: {
      ratings: [{ rating: 72.0, slope: 113 }],
      holeYardages: Array(18).fill(400)
    }
  });
  const variedYardageTournament = materializedFixture("singles", {
    useHandicap: true,
    courseOverrides: {
      ratings: [{ rating: 72.0, slope: 113 }],
      holeYardages: [400, 400, 400, 400, 400, 400, 400, 400, 320, 520, 400, 400, 400, 400, 400, 400, 400, 400]
    }
  });

  for (const tournamentJson of [flatYardageTournament, variedYardageTournament]) {
    const playerHandicaps = new Map((tournamentJson.players || []).map((player) => [player.playerId, Number(player.handicap || 0)]));
    for (const playerId of Object.keys(tournamentJson.score_data.rounds[0].player || {})) {
      const handicap = playerHandicaps.get(playerId) || 0;
      tournamentJson.score_data.rounds[0].player[playerId] = {
        gross: grossArray(null),
        net: grossArray(null),
        handicapShots: strokesPerHole(handicap, STROKE_INDEX),
        grossTotal: 0,
        netTotal: 0,
        grossToParTotal: 0,
        netToParTotal: 0,
        thru: 0
      };
    }
  }

  const flatOdds = computeLiveOdds(flatYardageTournament, { generatedAt: FIXED_NOW });
  const variedOdds = computeLiveOdds(variedYardageTournament, { generatedAt: FIXED_NOW });
  const flatPlayer = (flatOdds.rounds?.[0]?.players || []).find((row) => row.playerId === "A1");
  const variedPlayer = (variedOdds.rounds?.[0]?.players || []).find((row) => row.playerId === "A1");
  const flatHole9 = Number(flatPlayer?.remainingHoleExpectations?.find((item) => item.holeIndex === 8)?.projectedGross || 0);
  const flatHole10 = Number(flatPlayer?.remainingHoleExpectations?.find((item) => item.holeIndex === 9)?.projectedGross || 0);
  const variedHole9 = Number(variedPlayer?.remainingHoleExpectations?.find((item) => item.holeIndex === 8)?.projectedGross || 0);
  const variedHole10 = Number(variedPlayer?.remainingHoleExpectations?.find((item) => item.holeIndex === 9)?.projectedGross || 0);

  assert.ok((variedHole10 - variedHole9) > (flatHole10 - flatHole9), `expected long hole to pick up more projection weight from yardage: ${(variedHole10 - variedHole9)} vs ${(flatHole10 - flatHole9)}`);
});

registerTest("compact live odds payload strips names and quantizes output", () => {
  const tournamentJson = materializedFixture("singles", { includeFutureRound: true, useHandicap: true });
  for (const player of tournamentJson.players || []) {
    const handicap = Number(player.handicap || 0);
    tournamentJson.score_data.rounds[0].player[player.playerId] = {
      gross: grossArray(null),
      net: grossArray(null),
      handicapShots: strokesPerHole(handicap, STROKE_INDEX),
      grossTotal: 0,
      netTotal: 0,
      grossToParTotal: 0,
      netToParTotal: 0,
      thru: 0
    };
  }
  const odds = computeLiveOdds(tournamentJson, { generatedAt: FIXED_NOW });
  const compact = compactLiveOddsPayload(odds);

  assert.equal(typeof compact?.s, "number");
  assert.equal(Array.isArray(compact?.r), true);
  assert.equal(Array.isArray(compact?.a), true);

  const teamRow = (compact?.r?.[0]?.[0] || []).find((row) => row?.[0] === "A");
  assert.equal(Array.isArray(teamRow), true);
  assert.equal(teamRow.length, 9);
  assert.equal(teamRow[0], "A");
  assert.equal(Number.isInteger(teamRow[1]), true);
  assert.equal(teamRow[4] == null || Number.isInteger(teamRow[4]), true);
  assert.equal(Array.isArray(teamRow[8]), true);

  const playerRow = (compact?.r?.[0]?.[1] || []).find((row) => row?.[0] === "A1");
  assert.equal(Array.isArray(playerRow), true);
  assert.equal(playerRow.length, 10);
  assert.equal(playerRow[0], "A1");
  assert.equal(playerRow[1], "A");
  assert.equal(Array.isArray(playerRow[9]), true);

  const firstHoleDetail = playerRow[9][0];
  assert.equal(Array.isArray(firstHoleDetail), true);
  assert.equal(Number.isInteger(firstHoleDetail[0]), true);
  assert.equal(Array.isArray(firstHoleDetail[3]), true);
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
