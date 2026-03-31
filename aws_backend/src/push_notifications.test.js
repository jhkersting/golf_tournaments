import assert from "node:assert/strict";

import { chatNotificationSummaries, scoreUpdateSummaries } from "./push_notifications.js";

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

const PARS = Array(18).fill(4);
const STROKE_INDEX = Array.from({ length: 18 }, (_, index) => index + 1);

function emptyHoles() {
  return Array(18).fill(null);
}

function scoreEntry(holes = []) {
  const out = emptyHoles();
  for (let index = 0; index < Math.min(18, holes.length); index += 1) {
    const value = holes[index];
    out[index] = value == null ? null : Number(value);
  }
  return {
    holes: out,
    meta: Array(18).fill(null)
  };
}

function changedScore(targetType, targetId, holeIndex) {
  return { targetType, targetId, holeIndex };
}

function buildState(format, {
  useHandicap = false,
  playerScores = {},
  teamScores = {},
  groupScores = {}
} = {}) {
  const state = {
    tournament: {
      tournamentId: `fixture-${format}`,
      name: `Fixture ${format}`,
      dates: "2026-03-15",
      scoring: "stroke"
    },
    rounds: [{
      name: "Round 1",
      format,
      useHandicap,
      weight: 1,
      courseIndex: 0,
      teamAggregation: { topX: 2 }
    }],
    course: {
      name: "Fixture Course",
      pars: PARS.slice(),
      strokeIndex: STROKE_INDEX.slice()
    },
    teams: {
      A: { teamId: "A", teamName: "Alpha" },
      B: { teamId: "B", teamName: "Beta" }
    },
    players: {
      P1: { playerId: "P1", name: "John", teamId: "A", handicap: useHandicap ? 18 : 0, groups: ["A"], group: "A" },
      P2: { playerId: "P2", name: "Jane", teamId: "A", handicap: useHandicap ? 18 : 0, groups: ["A"], group: "A" },
      P3: { playerId: "P3", name: "Mike", teamId: "B", handicap: 0, groups: ["A"], group: "A" },
      P4: { playerId: "P4", name: "Sara", teamId: "B", handicap: 0, groups: ["A"], group: "A" }
    },
    scores: {
      rounds: [{
        teams: {},
        players: {},
        groups: {}
      }]
    }
  };

  const round = state.scores.rounds[0];
  for (const [playerId, holes] of Object.entries(playerScores)) {
    round.players[playerId] = scoreEntry(holes);
  }
  for (const [teamId, holes] of Object.entries(teamScores)) {
    round.teams[teamId] = scoreEntry(holes);
  }
  for (const [groupId, holes] of Object.entries(groupScores)) {
    round.groups[groupId] = scoreEntry(holes);
  }

  return state;
}

function summaryBodies(summaries) {
  return summaries.map((summary) => summary.body);
}

registerTest("singles new score sends one player notification", () => {
  const state = buildState("singles", {
    playerScores: {
      P1: [5]
    }
  });

  const summaries = scoreUpdateSummaries(state, {
    roundIndex: 0,
    mode: "hole",
    changedScores: [changedScore("player", "P1", 0)]
  });

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].body, "Round 1 • John • Bogey (+1) Thru 1");
});

registerTest("same score resubmission sends no notification", () => {
  const state = buildState("singles", {
    playerScores: {
      P1: [5]
    }
  });

  const summaries = scoreUpdateSummaries(state, {
    roundIndex: 0,
    mode: "hole",
    changedScores: []
  });

  assert.deepEqual(summaries, []);
});

registerTest("singles overwrite with a new score sends one notification", () => {
  const state = buildState("singles", {
    playerScores: {
      P1: [4]
    }
  });

  const summaries = scoreUpdateSummaries(state, {
    roundIndex: 0,
    mode: "hole",
    changedScores: [changedScore("player", "P1", 0)]
  });

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].body, "Round 1 • John • Par (E) Thru 1");
});

registerTest("scramble sends one team notification with team name", () => {
  const state = buildState("scramble", {
    teamScores: {
      A: [3]
    }
  });

  const summaries = scoreUpdateSummaries(state, {
    roundIndex: 0,
    mode: "hole",
    changedScores: [changedScore("team", "A", 0)]
  });

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].body, "Round 1 • Alpha • Birdie (-1) Thru 1");
});

registerTest("two-man scramble sends one group notification with joined names", () => {
  const state = buildState("two_man_scramble", {
    groupScores: {
      "A::A": [4]
    }
  });

  const summaries = scoreUpdateSummaries(state, {
    roundIndex: 0,
    mode: "hole",
    changedScores: [changedScore("group", "A::A", 0)]
  });

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].body, "Round 1 • Jane/John • Par (E) Thru 1");
});

registerTest("two-man shamble dedupes two player writes into one pair notification", () => {
  const state = buildState("two_man_shamble", {
    playerScores: {
      P1: [4],
      P2: [5]
    }
  });

  const summaries = scoreUpdateSummaries(state, {
    roundIndex: 0,
    mode: "hole",
    changedScores: [
      changedScore("player", "P1", 0),
      changedScore("player", "P2", 0)
    ]
  });

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].body, "Round 1 • Jane/John • Bogey (+1) Thru 1");
});

registerTest("two-man best ball dedupes two player writes into one pair notification", () => {
  const state = buildState("two_man_best_ball", {
    playerScores: {
      P1: [4],
      P2: [5]
    }
  });

  const summaries = scoreUpdateSummaries(state, {
    roundIndex: 0,
    mode: "hole",
    changedScores: [
      changedScore("player", "P1", 0),
      changedScore("player", "P2", 0)
    ]
  });

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].body, "Round 1 • Jane/John • Par (E) Thru 1");
});

registerTest("team_best_ball stays per-player", () => {
  const state = buildState("team_best_ball", {
    playerScores: {
      P1: [4],
      P2: [5]
    }
  });

  const summaries = scoreUpdateSummaries(state, {
    roundIndex: 0,
    mode: "hole",
    changedScores: [
      changedScore("player", "P1", 0),
      changedScore("player", "P2", 0)
    ]
  });

  assert.equal(summaries.length, 2);
  assert.deepEqual(summaryBodies(summaries), [
    "Round 1 • John • Par (E) Thru 1",
    "Round 1 • Jane • Bogey (+1) Thru 1"
  ]);
});

registerTest("handicap formats include gross and net to-par in the message", () => {
  const state = buildState("singles", {
    useHandicap: true,
    playerScores: {
      P1: [5, 5]
    }
  });

  const summaries = scoreUpdateSummaries(state, {
    roundIndex: 0,
    mode: "hole",
    changedScores: [changedScore("player", "P1", 1)]
  });

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].body, "Round 1 • John • Bogey (+2 [E]) Thru 2");
});

registerTest("bulk submit sends one notification per changed hole with unique tags", () => {
  const state = buildState("singles", {
    playerScores: {
      P1: [5, 4]
    }
  });

  const summaries = scoreUpdateSummaries(state, {
    roundIndex: 0,
    mode: "bulk",
    changedScores: [
      changedScore("player", "P1", 0),
      changedScore("player", "P1", 1)
    ]
  });

  assert.equal(summaries.length, 2);
  assert.deepEqual(summaryBodies(summaries), [
    "Round 1 • John • Bogey (+1) Thru 2",
    "Round 1 • John • Par (+1) Thru 2"
  ]);
  assert.notEqual(summaries[0].tag, summaries[1].tag);
});

registerTest("clear operations do not send notifications", () => {
  const state = buildState("singles", {
    playerScores: {
      P1: [5]
    }
  });

  const summaries = scoreUpdateSummaries(state, {
    roundIndex: 0,
    mode: "bulk",
    changedScores: []
  });

  assert.deepEqual(summaries, []);
});

registerTest("chat notifications route players back into the enter page", () => {
  const state = buildState("singles");

  const summaries = chatNotificationSummaries(state, {
    entry: {
      playerName: "John",
      teamName: "Alpha",
      message: "Dinner is at 7"
    },
    messageId: "chat_123"
  });

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].title, "Fixture singles");
  assert.equal(summaries[0].body, "John • Alpha: Dinner is at 7");
  assert.equal(summaries[0].url, "./enter.html?t=fixture-singles");
  assert.equal(summaries[0].tag, "golf-chat-fixture-singles-chat_123");
});

if (!nodeTest) {
  let failures = 0;
  for (const { name, fn } of fallbackTests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`not ok - ${name}`);
      console.error(error);
    }
  }
  if (failures) {
    process.exitCode = 1;
  }
}
