import assert from "node:assert/strict";

import {
  matchPlayHoleIndices,
  materializeMatchPlay,
  normalizeMatchPlayConfiguration,
  normalizeMatchPlayRounds
} from "./match_play.js";
import { materializePublicFromState } from "./utils.js";

let nodeTest = null;
try {
  ({ default: nodeTest } = await import("node:test"));
} catch (_error) {
  nodeTest = null;
}

const fallbackTests = [];
function test(name, fn) {
  if (nodeTest) nodeTest(name, fn);
  else fallbackTests.push({ name, fn });
}

const empty18 = () => Array(18).fill(null);
const course = {
  pars: Array(18).fill(4),
  strokeIndex: Array.from({ length: 18 }, (_, index) => index + 1)
};

function fixture({ format = "singles", holes = 18, nineHoleSide = null, useHandicap = false, scores = {} } = {}) {
  const players = {
    A1: { playerId: "A1", name: "Alice", teamId: "A", handicap: useHandicap ? 18 : 0 },
    A2: { playerId: "A2", name: "Avery", teamId: "A", handicap: 0 },
    B1: { playerId: "B1", name: "Blair", teamId: "B", handicap: 0 },
    B2: { playerId: "B2", name: "Bailey", teamId: "B", handicap: 0 }
  };
  const playerIds = format === "singles" ? ["A1"] : ["A1", "A2"];
  const otherIds = format === "singles" ? ["B1"] : ["B1", "B2"];
  const rounds = [{
    name: "Round 1",
    holes,
    ...(holes === 9 && nineHoleSide ? { nineHoleSide } : {}),
    format,
    useHandicap,
    matches: [{
      matchId: "r1m1",
      teamA: { teamId: "A", playerIds },
      teamB: { teamId: "B", playerIds: otherIds }
    }]
  }];
  return {
    tournament: {
      tournamentId: "t_match",
      name: "Match Fixture",
      dates: "2026-08-11",
      competitionType: "team_match_play",
      matchPlay: { teamIds: ["A", "B"] }
    },
    rounds,
    courses: [course],
    teams: { A: { teamId: "A", teamName: "Alpha" }, B: { teamId: "B", teamName: "Beta" } },
    players,
    scores: { rounds: [{ players: scores, matches: {}, teams: {}, groups: {} }] },
    updatedAt: 1,
    version: 1
  };
}

test("normalizes the two-team match-play contract and defaults the event target", () => {
  const rounds = normalizeMatchPlayRounds([{
    holes: 9,
    format: "alternate-shot",
    matches: [{ id: "opening", teamA: { teamId: "A", playerIds: ["A1", "A2"] }, teamB: { teamId: "B", playerIds: ["B1", "B2"] } }]
  }]);
  const config = normalizeMatchPlayConfiguration({ teamIds: ["A", "B"] }, rounds, {
    teams: { A: {}, B: {} },
    players: { A1: { teamId: "A" }, A2: { teamId: "A" }, B1: { teamId: "B" }, B2: { teamId: "B" } }
  });
  assert.equal(config.rounds[0].format, "alternate_shot");
  assert.equal(config.rounds[0].nineHoleSide, "front");
  assert.equal(config.rounds[0].matches[0].matchId, "opening");
  assert.equal(config.scheduledPoints, 1);
  assert.equal(config.winTarget, 1);
  const weighted = normalizeMatchPlayConfiguration({ teamIds: ["A", "B"], pointsPerMatch: 2 }, [{
    holes: 9,
    format: "alternate_shot",
    matches: [{ teamA: { teamId: "A", playerIds: ["A1", "A2"] }, teamB: { teamId: "B", playerIds: ["B1", "B2"] } }]
  }], {
    teams: { A: {}, B: {} },
    players: { A1: { teamId: "A" }, A2: { teamId: "A" }, B1: { teamId: "B" }, B2: { teamId: "B" } }
  });
  assert.equal(weighted.scheduledPoints, 2);
  assert.equal(weighted.winTarget, 1.5);
});

test("normalizes front and back nine selections and rejects an invalid nine-hole side", () => {
  const base = {
    holes: 9,
    format: "singles",
    matches: [{ teamA: { teamId: "A", playerIds: ["A1"] }, teamB: { teamId: "B", playerIds: ["B1"] } }]
  };
  const [back] = normalizeMatchPlayRounds([{ ...base, nineHoleSide: "back-nine" }]);
  assert.equal(back.nineHoleSide, "back");
  assert.deepEqual(matchPlayHoleIndices(back), [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual(matchPlayHoleIndices({ holes: 9 }), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.throws(
    () => normalizeMatchPlayRounds([{ ...base, nineHoleSide: "middle" }]),
    /nineHoleSide must be "front" or "back"/
  );
});

test("accepts four-player best ball sides and derives the best available player score", () => {
  const state = fixture({ format: "best_ball", holes: 9 });
  state.players.A3 = { playerId: "A3", name: "Ari", teamId: "A", handicap: 0 };
  state.players.A4 = { playerId: "A4", name: "Alex", teamId: "A", handicap: 0 };
  state.players.B3 = { playerId: "B3", name: "Bea", teamId: "B", handicap: 0 };
  state.players.B4 = { playerId: "B4", name: "Bo", teamId: "B", handicap: 0 };
  state.rounds[0].matches[0].teamA.playerIds = ["A1", "A2", "A3", "A4"];
  state.rounds[0].matches[0].teamB.playerIds = ["B1", "B2", "B3", "B4"];
  state.scores.rounds[0].players = Object.fromEntries([
    ["A1", 5], ["A2", 5], ["A3", 3], ["A4", 6],
    ["B1", 4], ["B2", 4], ["B3", 4], ["B4", 4]
  ].map(([playerId, score]) => [playerId, { holes: Array(9).fill(score) }]));

  const output = materializeMatchPlay({ ...state, scores: state.scores });
  const match = output.rounds[0].matches[0];
  assert.equal(match.status, "closed");
  assert.equal(match.result, "A");
  assert.equal(match.sideScores.A[0], 3);
  assert.equal(match.sideScores.B[0], 4);
});

test("rejects handicap on alternate shot and cross-team player assignments", () => {
  assert.throws(
    () => normalizeMatchPlayRounds([{
      holes: 18,
      format: "alternate_shot",
      useHandicap: true,
      matches: [{ teamA: { teamId: "A", playerIds: ["A1", "A2"] }, teamB: { teamId: "B", playerIds: ["B1", "B2"] } }]
    }]),
    /Handicaps are not supported/
  );
  assert.throws(
    () => normalizeMatchPlayConfiguration({ teamIds: ["A", "B"] }, [{
      holes: 18,
      format: "singles",
      matches: [{ teamA: { teamId: "A", playerIds: ["B1"] }, teamB: { teamId: "B", playerIds: ["B2"] } }]
    }], { teams: { A: {}, B: {} }, players: { B1: { teamId: "B" }, B2: { teamId: "B" } } }),
    /must belong to/
  );
  assert.throws(
    () => normalizeMatchPlayRounds([{
      format: "best_ball",
      matches: [{ teamA: { teamId: "A", playerIds: ["A1"] }, teamB: { teamId: "B", playerIds: ["B1", "B2"] } }]
    }]),
    /2 to 4 players/
  );
  assert.throws(
    () => normalizeMatchPlayRounds([{
      format: "alternate_shot",
      matches: [{ teamA: { teamId: "A", playerIds: ["A1", "A2", "A3"] }, teamB: { teamId: "B", playerIds: ["B1", "B2"] } }]
    }]),
    /exactly 2 players/
  );
});

test("uses one match-side score for alternate shot and ignores holes after a nine-hole round", () => {
  const state = fixture({ format: "alternate_shot", holes: 9 });
  state.scores.rounds[0].matches = {
    r1m1: {
      sides: {
        A: { holes: [4, 4, 4, 4, 4, 4, 4, 4, 4, 2, 2, 2] },
        B: { holes: [5, 5, 5, 5, 5, 5, 5, 5, 5, 1, 1, 1] }
      }
    }
  };
  const output = materializeMatchPlay({ ...state, scores: state.scores });
  const match = output.rounds[0].matches[0];
  assert.equal(match.status, "closed");
  assert.equal(match.thru, 9);
  assert.equal(match.holesRemaining, 0);
  assert.deepEqual(match.sideScores.A.slice(9), empty18().slice(9));
  assert.equal(output.standings.find((row) => row.teamId === "A").points, 1);
});

test("uses holes 10 through 18 for a back-nine match and reports thru within the selected nine", () => {
  const state = fixture({ format: "alternate_shot", holes: 9, nineHoleSide: "back" });
  state.scores.rounds[0].matches = {
    r1m1: {
      sides: {
        A: { holes: [2, 2, 2, 2, 2, 2, 2, 2, 2, 4, 4, 4] },
        B: { holes: [1, 1, 1, 1, 1, 1, 1, 1, 1, 5, 4, 5] }
      }
    }
  };
  const output = materializeMatchPlay({ ...state, scores: state.scores });
  const match = output.rounds[0].matches[0];
  assert.equal(output.rounds[0].nineHoleSide, "back");
  assert.deepEqual(match.sideScores.A.slice(0, 9), empty18().slice(0, 9));
  assert.deepEqual(match.sideScores.B.slice(0, 9), empty18().slice(0, 9));
  assert.deepEqual(match.sideScores.A.slice(9, 12), [4, 4, 4]);
  assert.equal(match.status, "live");
  assert.equal(match.thru, 3);
  assert.equal(match.holesRemaining, 6);
  assert.equal(match.lead, 2);
});

test("applies handicap strokes using the selected back-nine course holes", () => {
  const state = fixture({ format: "singles", holes: 9, nineHoleSide: "back", useHandicap: true });
  state.players.A1.handicap = 1;
  state.courses[0].strokeIndex = [10, 11, 12, 13, 14, 15, 16, 17, 18, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  state.scores.rounds[0].players = {
    A1: { holes: [...Array(9).fill(2), 5] },
    B1: { holes: [...Array(9).fill(1), 4] }
  };
  const match = materializeMatchPlay({ ...state, scores: state.scores }).rounds[0].matches[0];
  assert.equal(match.sideScores.A[0], null);
  assert.equal(match.sideScores.A[9], 4);
  assert.equal(match.sideScores.B[9], 4);
  assert.equal(match.thru, 1);
  assert.equal(match.lead, 0);
});

test("awards a completed match point to the winning second side", () => {
  const state = fixture({ format: "singles", holes: 9 });
  state.scores.rounds[0].players = {
    A1: { holes: Array(9).fill(5) },
    B1: { holes: Array(9).fill(4) }
  };
  const output = materializeMatchPlay({ ...state, scores: state.scores });
  const match = output.rounds[0].matches[0];
  assert.equal(match.result, "B");
  assert.equal(match.points.A, 0);
  assert.equal(match.points.B, 1);
  assert.equal(output.standings.find((row) => row.teamId === "A").points, 0);
  assert.equal(output.standings.find((row) => row.teamId === "B").points, 1);
  assert.equal(output.winnerTeamId, "B");
});

test("splits a completed tied match and publishes derived match-play standings", () => {
  const state = fixture({ format: "singles", holes: 9 });
  state.scores.rounds[0].players = {
    A1: { holes: [4, 4, 4, 4, 4, 4, 4, 4, 4] },
    B1: { holes: [4, 4, 4, 4, 4, 4, 4, 4, 4] }
  };
  const publicPayload = materializePublicFromState(state);
  const match = publicPayload.matchPlay.rounds[0].matches[0];
  assert.equal(match.status, "final");
  assert.equal(match.result, "halved");
  assert.equal(publicPayload.matchPlay.standings[0].points, 0.5);
  assert.equal(publicPayload.tournament.competitionType, "team_match_play");
  assert.equal(publicPayload.score_data.rounds[0].matches.r1m1.result, "halved");
});

if (!nodeTest) {
  let failed = 0;
  for (const entry of fallbackTests) {
    try { await entry.fn(); console.log(`ok - ${entry.name}`); }
    catch (error) { failed += 1; console.error(`not ok - ${entry.name}`); console.error(error); }
  }
  if (failed) process.exitCode = 1;
}
