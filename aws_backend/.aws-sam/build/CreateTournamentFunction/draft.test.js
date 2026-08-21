import assert from "node:assert/strict";
import { applyDraftAction, normalizeDraftState, roleForCode } from "./draft.js";
import { draftTeamAt, emptyLineups, snakeTeamAt, teamRosters } from "./draft_event.js";

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

test("recognizes the two draft roles", () => {
  assert.equal(roleForCode("B6F4-0992"), "jack");
  assert.equal(roleForCode("bb972bbf"), "jake");
  assert.equal(roleForCode("wrong"), "");
});

test("Jake picks first and can only act on Jake turns", () => {
  const first = applyDraftAction({}, { action: "pick", playerId: "d-davidson" }, "jake", 100);
  assert.deepEqual(first.picks, ["d-davidson"]);
  assert.throws(() => applyDraftAction(first, { action: "pick", playerId: "j-royse" }, "jake", 200), /wait for Jack's turn/);
});

test("Jack admin can pick for either team, undo, and reset", () => {
  const first = applyDraftAction({}, { action: "pick", playerId: "d-davidson" }, "jack", 100);
  const second = applyDraftAction(first, { action: "pick", playerId: "j-royse" }, "jack", 200);
  assert.deepEqual(second.picks, ["d-davidson", "j-royse"]);
  assert.deepEqual(applyDraftAction(second, { action: "undo" }, "jack", 300).picks, ["d-davidson"]);
  assert.deepEqual(applyDraftAction(second, { action: "reset" }, "jack", 400).picks, []);
});

test("team draft keeps its Jake-first alternating order", () => {
  assert.deepEqual(Array.from({ length: 6 }, (_, index) => draftTeamAt(index)), [
    "jake", "jack", "jake", "jack", "jake", "jack"
  ]);
  const rosters = teamRosters(["d-davidson", "j-royse", "w-parten", "b-holley"]);
  assert.deepEqual(rosters.jake.map((player) => player.playerId), ["j-christensen", "d-davidson", "w-parten"]);
  assert.deepEqual(rosters.jack.map((player) => player.playerId), ["j-kersting", "j-royse", "b-holley"]);
});

test("Jake cannot use admin actions", () => {
  assert.throws(() => applyDraftAction({}, { action: "reset" }, "jake"), /admin code required/);
  assert.throws(() => applyDraftAction({}, { action: "undo" }, "jake"), /admin code required/);
});

test("normalization removes invalid and duplicate picks", () => {
  assert.deepEqual(normalizeDraftState({ picks: ["d-davidson", "bad", "d-davidson", "j-royse"], version: 2 }), {
    picks: ["d-davidson", "j-royse"], lineups: emptyLineups(), odds: null, version: 2, updatedAt: 0
  });
});

test("lineup picks unlock only after the draft and follow one continuous matchup snake", () => {
  const picks = ["d-davidson", "j-royse", "w-parten", "b-holley", "j-collins", "p-addington", "j-jones", "n-burlbaw", "f-kersting", "h-coop"];
  const initial = normalizeDraftState({ picks });
  const first = applyDraftAction(initial, {
    action: "lineup-pick",
    stageId: "sherrillPairs",
    playerIds: ["j-christensen", "d-davidson"]
  }, "jake", 100);
  assert.equal(first.lineups.sherrillPairs[0].teamId, "jake");
  assert.throws(() => applyDraftAction(first, {
    action: "lineup-pick",
    stageId: "sherrillPairs",
    playerIds: ["j-kersting", "j-royse"]
  }, "jake", 200), /wait for Jack's turn/);
  const second = applyDraftAction(first, {
    action: "lineup-pick",
    stageId: "sherrillPairs",
    playerIds: ["j-kersting", "j-royse"]
  }, "jack", 200);
  assert.equal(second.lineups.sherrillPairs[1].teamId, "jack");

  const acrossStages = normalizeDraftState({
    picks,
    lineups: {
      sherrillPairs: [
        { teamId: "jake", playerIds: ["j-christensen", "d-davidson"] },
        { teamId: "jack", playerIds: ["j-kersting", "j-royse"] },
        { teamId: "jack", playerIds: ["b-holley", "p-addington"] },
        { teamId: "jake", playerIds: ["w-parten", "j-collins"] },
        { teamId: "jake", playerIds: ["f-kersting", "j-jones"] },
        { teamId: "jack", playerIds: ["n-burlbaw", "h-coop"] }
      ]
    }
  });
  assert.throws(() => applyDraftAction(acrossStages, {
    action: "lineup-pick",
    stageId: "anchoredPairs",
    playerIds: ["j-christensen", "d-davidson"]
  }, "jake", 300), /wait for Jack's turn/);
  const firstAnchored = applyDraftAction(acrossStages, {
    action: "lineup-pick",
    stageId: "anchoredPairs",
    playerIds: ["j-kersting", "j-royse"]
  }, "jack", 300);
  assert.equal(firstAnchored.lineups.anchoredPairs[0].teamId, "jack");
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
