import assert from "node:assert/strict";
import { buildDraftEventTournament, computeDraftEventOdds, emptyLineups, lineupPickIndex, snakeTeamAt } from "./draft_event.js";

let nodeTest = null;
try {
  ({ default: nodeTest } = await import("node:test"));
} catch (_) {
  nodeTest = null;
}
const fallbackTests = [];
function test(name, fn) {
  if (nodeTest) return nodeTest(name, fn);
  fallbackTests.push({ name, fn });
}

const completeState = {
  picks: ["d-davidson", "j-royse", "w-parten", "b-holley", "j-collins", "p-addington", "j-jones", "n-burlbaw", "f-kersting", "h-coop"],
  lineups: emptyLineups(),
  version: 12,
  updatedAt: 100
};

test("event schedule contains 15 points across four nine-hole rounds", () => {
  const tournament = buildDraftEventTournament(completeState);
  assert.equal(tournament.tournament.rounds.length, 4);
  assert.deepEqual(tournament.tournament.rounds.map((round) => round.matches.length), [3, 3, 3, 6]);
  assert.deepEqual(tournament.tournament.rounds.map((round) => round.nineHoleSide), ["front", "back", "front", "back"]);
  assert.equal(tournament.tournament.matchPlay.winTarget, 8);
  assert.deepEqual(
    tournament.tournament.rounds[0].matches.map((match) => match.teamA.playerIds),
    tournament.tournament.rounds[1].matches.map((match) => match.teamA.playerIds)
  );
});

test("draft event odds use the match-play simulation model", () => {
  const odds = computeDraftEventOdds(completeState);
  assert.ok(Number(odds.simCount) >= 10000);
  assert.equal(odds.event.jakeWinProbability + odds.event.tieProbability + odds.event.jackWinProbability, 100);
  assert.equal(odds.rounds.flatMap((round) => round.matches).length, 15);
  for (const match of odds.rounds.flatMap((round) => round.matches)) {
    assert.equal(match.jakeWinProbability + match.tieProbability + match.jackWinProbability, 100);
    assert.ok(match.jakePlayers.length);
    assert.ok(match.jackPlayers.length);
  }
});

test("the matchup snake does not restart at stage boundaries", () => {
  const lineups = emptyLineups();
  lineups.sherrillPairs = Array.from({ length: 6 }, (_, index) => ({
    teamId: snakeTeamAt(index),
    playerIds: [`player-${index}-a`, `player-${index}-b`]
  }));
  assert.equal(lineupPickIndex(lineups), 6);
  assert.equal(snakeTeamAt(lineupPickIndex(lineups)), "jack");
});

test("unpicked matches expose handicap-weighted projected slots", () => {
  const partial = computeDraftEventOdds({ picks: ["d-davidson"], lineups: emptyLineups(), version: 1 });
  assert.equal(partial.projectionMethod, "handicap-weighted remaining players");
  assert.ok(partial.rounds.flatMap((round) => round.matches).some((match) => match.provisional));
  const projected = partial.rounds.flatMap((round) => round.matches)
    .flatMap((match) => [...match.jakePlayers, ...match.jackPlayers])
    .filter((player) => player.projected);
  assert.ok(projected.length);
  assert.ok(projected.every((player) => Number.isFinite(player.handicap)));
});

if (!nodeTest) {
  let failed = 0;
  for (const entry of fallbackTests) {
    try {
      await entry.fn();
      console.log(`ok - ${entry.name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok - ${entry.name}`);
      console.error(error);
    }
  }
  if (failed) process.exitCode = 1;
}
