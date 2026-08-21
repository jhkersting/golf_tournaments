import assert from "node:assert/strict";
import { applyDraftAction, normalizeDraftState, roleForCode } from "./draft.js";

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
  assert.throws(() => applyDraftAction(first, { action: "pick", playerId: "j-royse" }, "jake", 200), /wait for Jake's turn/);
});

test("Jack admin can pick for either team, undo, and reset", () => {
  const first = applyDraftAction({}, { action: "pick", playerId: "d-davidson" }, "jack", 100);
  const second = applyDraftAction(first, { action: "pick", playerId: "j-royse" }, "jack", 200);
  assert.deepEqual(second.picks, ["d-davidson", "j-royse"]);
  assert.deepEqual(applyDraftAction(second, { action: "undo" }, "jack", 300).picks, ["d-davidson"]);
  assert.deepEqual(applyDraftAction(second, { action: "reset" }, "jack", 400).picks, []);
});

test("Jake cannot use admin actions", () => {
  assert.throws(() => applyDraftAction({}, { action: "reset" }, "jake"), /admin code required/);
  assert.throws(() => applyDraftAction({}, { action: "undo" }, "jake"), /admin code required/);
});

test("normalization removes invalid and duplicate picks", () => {
  assert.deepEqual(normalizeDraftState({ picks: ["d-davidson", "bad", "d-davidson", "j-royse"], version: 2 }), {
    picks: ["d-davidson", "j-royse"], version: 2, updatedAt: 0
  });
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
