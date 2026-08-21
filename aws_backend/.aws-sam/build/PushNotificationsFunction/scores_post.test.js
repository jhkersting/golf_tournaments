import assert from "node:assert/strict";

import { resolveMatchPlayScoreTarget } from "./scores_post.js";
import { materializeMatchPlaySavedRound } from "./utils.js";

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

const match = {
  teamA: { teamId: "A", playerIds: ["A1", "A2"] },
  teamB: { teamId: "B", playerIds: ["B1", "B2"] }
};

for (const format of ["singles", "best_ball"]) {
  test(`${format} lets a scheduled player target either player in their match`, () => {
    assert.deepEqual(
      resolveMatchPlayScoreTarget(match, "A1", "B1", true),
      { targetType: "player", targetId: "B1" }
    );
    assert.deepEqual(
      resolveMatchPlayScoreTarget(match, "A1", "A2", true),
      { targetType: "player", targetId: "A2" }
    );
    assert.deepEqual(
      resolveMatchPlayScoreTarget(match, "A1", "", true),
      { targetType: "player", targetId: "A1" }
    );
  });
}

for (const format of ["alternate_shot", "scramble"]) {
  test(`${format} lets a scheduled player target either team side in their match`, () => {
    assert.deepEqual(
      resolveMatchPlayScoreTarget(match, "A1", "B", false),
      { targetType: "match_side", targetId: "B" }
    );
    assert.deepEqual(
      resolveMatchPlayScoreTarget(match, "A1", "", false),
      { targetType: "match_side", targetId: "A" }
    );
  });
}

test("targets outside the scheduled match remain forbidden", () => {
  for (const [targetId, playerFormat] of [["C1", true], ["C", false]]) {
    assert.throws(
      () => resolveMatchPlayScoreTarget(match, "A1", targetId, playerFormat),
      (error) => error.statusCode === 403 && /not assigned to this match/.test(error.message)
    );
  }
});

test("a player not scheduled in the requested match cannot write either side", () => {
  assert.throws(
    () => resolveMatchPlayScoreTarget(match, "C1", "A1", true),
    (error) => error.statusCode === 403 && /You are not assigned to this match/.test(error.message)
  );
});

test("entry data exposes both sides of only the actor's player-scored match", () => {
  const round = {
    format: "best_ball",
    matches: [
      { matchId: "ab", ...match },
      {
        matchId: "cd",
        teamA: { teamId: "C", playerIds: ["C1", "C2"] },
        teamB: { teamId: "D", playerIds: ["D1", "D2"] }
      }
    ]
  };
  const holes = (score) => [score, ...Array(17).fill(null)];
  const saved = materializeMatchPlaySavedRound(round, 0, "A1", {
    rounds: [{
      players: {
        A1: { holes: holes(4) }, A2: { holes: holes(5) },
        B1: { holes: holes(6) }, B2: { holes: holes(7) },
        C1: { holes: holes(3) }
      }
    }]
  });

  assert.equal(saved.matchId, "ab");
  assert.equal(saved.teamId, "A");
  assert.equal(saved.gross[0], 4);
  assert.deepEqual(saved.matchEntries.map(({ targetId, targetType, teamId, gross }) =>
    [targetId, targetType, teamId, gross[0]]
  ), [
    ["A1", "player", "A", 4],
    ["A2", "player", "A", 5],
    ["B1", "player", "B", 6],
    ["B2", "player", "B", 7]
  ]);
  assert.equal(saved.matchEntries.some((entry) => entry.targetId === "C1"), false);
});

test("entry data exposes both team-side targets for alternate shot", () => {
  const round = { format: "alternate_shot", matches: [{ matchId: "ab", ...match }] };
  const saved = materializeMatchPlaySavedRound(round, 0, "B1", {
    rounds: [{
      matches: {
        ab: { sides: { A: { holes: [4] }, B: { holes: [5] } } }
      }
    }]
  });

  assert.equal(saved.target, "match_side");
  assert.equal(saved.teamId, "B");
  assert.equal(saved.gross[0], 5);
  assert.deepEqual(saved.matchEntries.map(({ targetId, targetType, teamId, gross }) =>
    [targetId, targetType, teamId, gross[0]]
  ), [
    ["A", "match_side", "A", 4],
    ["B", "match_side", "B", 5]
  ]);
});

if (!nodeTest) {
  let failed = 0;
  for (const entry of fallbackTests) {
    try { await entry.fn(); console.log(`ok - ${entry.name}`); }
    catch (error) { failed += 1; console.error(`not ok - ${entry.name}`); console.error(error); }
  }
  if (failed) process.exitCode = 1;
}
