import { performance } from "node:perf_hooks";

import { computeLiveOdds } from "./live_odds.js";

const PARS = Array(18).fill(4);
const STROKE_INDEX = Array.from({ length: 18 }, (_, idx) => idx + 1);

function strokesPerHole(handicap, strokeIndex18) {
  const H = Math.max(0, Math.floor(Number(handicap) || 0));
  const base = Math.floor(H / 18);
  const rem = H % 18;
  return strokeIndex18.map((si) => base + (Number(si) <= rem ? 1 : 0));
}

function makeMaterializedBenchmarkTournament({
  teams = 24,
  playersPerTeam = 4,
  rounds = 3
} = {}) {
  const tournamentRounds = Array.from({ length: rounds }, (_, roundIndex) => ({
    name: `Round ${roundIndex + 1}`,
    format: roundIndex === 1 ? "team_best_ball" : roundIndex === 2 ? "two_man_best_ball" : "singles",
    useHandicap: true,
    weight: 1,
    courseIndex: 0,
    teamAggregation: { topX: 2 }
  }));

  const teamRows = [];
  const playerRows = [];
  const scoreRounds = tournamentRounds.map((round, roundIndex) => ({
    roundIndex,
    format: round.format,
    useHandicap: !!round.useHandicap,
    player: {},
    team: {},
    leaderboard: { teams: [], players: [] }
  }));

  for (let teamIndex = 0; teamIndex < teams; teamIndex++) {
    const teamId = `T${teamIndex + 1}`;
    teamRows.push({
      teamId,
      teamName: `Team ${teamIndex + 1}`,
      groupsByRound: {
        "2": {
          A: [`${teamId}P1`, `${teamId}P2`],
          B: [`${teamId}P3`, `${teamId}P4`]
        }
      }
    });

    for (let playerIndex = 0; playerIndex < playersPerTeam; playerIndex++) {
      const playerId = `${teamId}P${playerIndex + 1}`;
      const group = playerIndex < 2 ? "A" : "B";
      const handicap = 6 + ((teamIndex + playerIndex) % 12);
      playerRows.push({
        playerId,
        name: `Player ${playerId}`,
        teamId,
        handicap,
        groups: ["A", "A", group],
        group: "A"
      });

      for (let roundIndex = 0; roundIndex < rounds; roundIndex++) {
        const handicapShots = strokesPerHole(handicap, STROKE_INDEX);
        const gross = Array.from({ length: 18 }, (_, holeIndex) => {
          if (holeIndex >= 9) return null;
          return 4 + ((teamIndex + playerIndex + holeIndex + roundIndex) % 3 === 0 ? 1 : 0);
        });
        const net = gross.map((value, holeIndex) => value == null ? null : Number(value) - Number(handicapShots[holeIndex] || 0));
        scoreRounds[roundIndex].player[playerId] = {
          gross,
          net,
          handicapShots,
          grossTotal: gross.reduce((total, value) => total + (value == null ? 0 : Number(value)), 0),
          netTotal: net.reduce((total, value) => total + (value == null ? 0 : Number(value)), 0),
          grossToParTotal: gross.reduce((total, value, holeIndex) => total + (value == null ? 0 : Number(value) - Number(PARS[holeIndex])), 0),
          netToParTotal: net.reduce((total, value, holeIndex) => total + (value == null ? 0 : Number(value) - Number(PARS[holeIndex])), 0),
          thru: 9
        };
      }
    }
  }

  return {
    tournament: {
      tournamentId: "bench-live-odds",
      name: "Benchmark Tournament",
      dates: "2026-03-15",
      rounds: tournamentRounds
    },
    course: { name: "Bench Course", pars: PARS.slice(), strokeIndex: STROKE_INDEX.slice() },
    courses: [{ name: "Bench Course", pars: PARS.slice(), strokeIndex: STROKE_INDEX.slice() }],
    teams: teamRows,
    players: playerRows,
    updatedAt: Date.now(),
    version: 42,
    score_data: {
      rounds: scoreRounds,
      leaderboard_all: {
        teams: [],
        players: []
      }
    }
  };
}

const tournamentJson = makeMaterializedBenchmarkTournament();
const start = performance.now();
const odds = computeLiveOdds(tournamentJson, {
  generatedAt: "2026-03-15T12:00:00.000Z"
});
const durationMs = performance.now() - start;

console.log(JSON.stringify({
  simCount: odds.simCount,
  latencyMode: odds.latencyMode,
  durationMs: Math.round(durationMs * 100) / 100,
  rounds: odds.rounds?.length || 0,
  teams: odds.all_rounds?.teams?.length || 0,
  players: odds.all_rounds?.players?.length || 0
}, null, 2));
