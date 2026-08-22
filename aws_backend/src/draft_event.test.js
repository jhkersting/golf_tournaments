import assert from "node:assert/strict";
import {
  ANCHORED_MODEL_HANDICAP_MULTIPLIER,
  DRAFT_ODDS_PROJECTION_VERSION,
  buildDraftEventTournament,
  computeDraftEventOdds,
  emptyLineups,
  lineupPickIndex,
  projectDraftPickHandicaps,
  snakeTeamAt
} from "./draft_event.js";

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
  assert.equal(partial.projectionVersion, DRAFT_ODDS_PROJECTION_VERSION);
  assert.match(partial.projectionMethod, /next-best handicap 75%/);
  assert.ok(partial.rounds.flatMap((round) => round.matches).some((match) => match.provisional));
  const projected = partial.rounds.flatMap((round) => round.matches)
    .flatMap((match) => [...match.jakePlayers, ...match.jackPlayers])
    .filter((player) => player.projected);
  assert.ok(projected.length);
  assert.ok(projected.every((player) => Number.isFinite(player.handicap)));
});

test("future team-draft picks use 75 percent best and 25 percent second-best handicap", () => {
  assert.deepEqual(projectDraftPickHandicaps([
    { playerId: "best", handicap: 0 },
    { playerId: "second", handicap: 10 },
    { playerId: "third", handicap: 20 }
  ]), [2.5, 10.63, 16.88]);

  const tournament = buildDraftEventTournament({ picks: ["f-kersting"], lineups: emptyLineups() });
  const nextPick = tournament.players.find((player) => player.playerId === "projected-draft-1");
  assert.equal(nextPick.teamId, "jack");
  assert.equal(nextPick.handicap, 3.75);
});

test("Anchored alone uses model handicaps cut in half", () => {
  const tournament = buildDraftEventTournament(completeState);
  const sherrillPlayerId = tournament.tournament.rounds[0].matches[0].teamA.playerIds[0];
  const anchoredPlayerId = tournament.tournament.rounds[2].matches[0].teamA.playerIds[0];
  const sherrillPlayer = tournament.players.find((player) => player.playerId === sherrillPlayerId);
  const anchoredPlayer = tournament.players.find((player) => player.playerId === anchoredPlayerId);

  assert.ok(!sherrillPlayerId.startsWith("anchored-model-"));
  assert.ok(anchoredPlayerId.startsWith("anchored-model-"));
  assert.equal(anchoredPlayer.handicap, Math.round(anchoredPlayer.displayHandicap * ANCHORED_MODEL_HANDICAP_MULTIPLIER * 100) / 100);
  assert.equal(sherrillPlayer.handicap, sherrillPlayer.displayHandicap ?? sherrillPlayer.handicap);

  const odds = computeDraftEventOdds(completeState);
  const displayedAnchored = odds.rounds[2].matches[0].jakePlayers[0];
  assert.equal(displayedAnchored.handicap, anchoredPlayer.displayHandicap);
  assert.equal(odds.courseAdjustments.anchoredNationalHandicapMultiplier, ANCHORED_MODEL_HANDICAP_MULTIPLIER);
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
