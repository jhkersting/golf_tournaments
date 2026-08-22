import { computeLiveOdds } from "./live_odds.js";

export const CAPTAINS = {
  jake: { playerId: "j-christensen", name: "J. Christensen", handicap: 0, teamId: "jake" },
  jack: { playerId: "j-kersting", name: "J. Kersting", handicap: 0, teamId: "jack" }
};

export const DRAFT_PLAYERS = [
  { playerId: "d-davidson", name: "D. Davidson", handicap: 0 },
  { playerId: "j-royse", name: "J. Royse", handicap: 16 },
  { playerId: "w-parten", name: "W. Parten", handicap: 19 },
  { playerId: "b-holley", name: "B. Holley", handicap: 15 },
  { playerId: "j-collins", name: "J. Collins", handicap: 19 },
  { playerId: "p-addington", name: "P. Addington", handicap: 19 },
  { playerId: "j-jones", name: "J. Jones", handicap: 20 },
  { playerId: "n-burlbaw", name: "N. Burlbaw", handicap: 23 },
  { playerId: "f-kersting", name: "F. Kersting", handicap: 10 },
  { playerId: "h-coop", name: "H. Coop", handicap: 15 }
];

export const DRAFT_PLAYER_IDS = new Set(DRAFT_PLAYERS.map((player) => player.playerId));
export const DRAFT_ODDS_PROJECTION_VERSION = "draft-picks-75-25-anchored-half-v3";
export const ANCHORED_MODEL_HANDICAP_MULTIPLIER = 1 / 2;
export const LINEUP_STAGES = [
  { stageId: "sherrillPairs", label: "Sherrill pairs", groupSize: 2, selections: 6 },
  { stageId: "anchoredPairs", label: "Anchored scramble pairs", groupSize: 2, selections: 6 },
  { stageId: "anchoredSingles", label: "Anchored singles order", groupSize: 1, selections: 12 }
];

const DEFAULT_SHERRILL = {
  courseId: "bluegolf-sherrillpark2",
  name: "Sherrill Park Golf Course - Course #2",
  pars: [4, 4, 4, 3, 5, 4, 4, 3, 4, 4, 4, 3, 4, 4, 5, 3, 4, 4],
  strokeIndex: [8, 4, 6, 17, 2, 13, 9, 18, 7, 11, 3, 14, 10, 12, 1, 15, 16, 5]
};
const DEFAULT_ANCHORED = {
  courseId: "c_d976cf23be0223e9",
  name: "Anchored National Golf Club",
  pars: Array(18).fill(3),
  strokeIndex: Array.from({ length: 18 }, (_, index) => index + 1)
};

export function snakeTeamAt(index) {
  return ["jake", "jack", "jack", "jake"][Math.max(0, Number(index) || 0) % 4];
}

export function draftTeamAt(index) {
  return ["jake", "jack"][Math.max(0, Number(index) || 0) % 2];
}

export function emptyLineups() {
  return Object.fromEntries(LINEUP_STAGES.map((stage) => [stage.stageId, []]));
}

export function normalizeLineups(raw) {
  const out = emptyLineups();
  for (const stage of LINEUP_STAGES) {
    const source = Array.isArray(raw?.[stage.stageId]) ? raw[stage.stageId] : [];
    out[stage.stageId] = source.slice(0, stage.selections).map((selection) => ({
      teamId: String(selection?.teamId || "").trim(),
      playerIds: (Array.isArray(selection?.playerIds) ? selection.playerIds : [])
        .map((playerId) => String(playerId || "").trim())
        .filter(Boolean)
        .slice(0, stage.groupSize)
    })).filter((selection) => ["jake", "jack"].includes(selection.teamId) && selection.playerIds.length === stage.groupSize);
  }
  return out;
}

export function stageDefinition(stageId) {
  return LINEUP_STAGES.find((stage) => stage.stageId === stageId) || null;
}

export function activeLineupStage(lineupsInput) {
  const lineups = normalizeLineups(lineupsInput);
  return LINEUP_STAGES.find((stage) => lineups[stage.stageId].length < stage.selections) || null;
}

export function lineupPickIndex(lineupsInput) {
  const lineups = normalizeLineups(lineupsInput);
  return LINEUP_STAGES.reduce((total, stage) => total + lineups[stage.stageId].length, 0);
}

export function teamRosters(picksInput) {
  const rosters = { jake: [{ ...CAPTAINS.jake }], jack: [{ ...CAPTAINS.jack }] };
  const byId = new Map(DRAFT_PLAYERS.map((player) => [player.playerId, player]));
  const seen = new Set();
  (Array.isArray(picksInput) ? picksInput : []).forEach((playerId, index) => {
    if (!byId.has(playerId) || seen.has(playerId)) return;
    seen.add(playerId);
    const teamId = draftTeamAt(index);
    rosters[teamId].push({ ...byId.get(playerId), teamId });
  });
  return rosters;
}

export function projectDraftPickHandicaps(playersInput) {
  const ranked = (Array.isArray(playersInput) ? playersInput : [])
    .map((player, index) => ({
      playerId: String(player?.playerId || `player-${index}`),
      handicap: Number(player?.handicap)
    }))
    .filter((player) => Number.isFinite(player.handicap))
    .sort((a, b) => a.handicap - b.handicap || a.playerId.localeCompare(b.playerId));
  const expected = Array(ranked.length).fill(0);

  function visit(remaining, pickOffset, branchProbability) {
    if (!remaining.length) return;
    const choices = remaining.length === 1
      ? [{ index: 0, probability: 1 }]
      : [{ index: 0, probability: 0.75 }, { index: 1, probability: 0.25 }];
    for (const choice of choices) {
      const probability = branchProbability * choice.probability;
      expected[pickOffset] += probability * remaining[choice.index].handicap;
      visit(remaining.filter((_, index) => index !== choice.index), pickOffset + 1, probability);
    }
  }

  visit(ranked, 0, 1);
  return expected.map((handicap) => Math.round(handicap * 100) / 100);
}

function completedRosters(picksInput) {
  const rosters = teamRosters(picksInput);
  const picked = new Set((Array.isArray(picksInput) ? picksInput : []).filter((id) => DRAFT_PLAYER_IDS.has(id)));
  const remaining = DRAFT_PLAYERS.filter((player) => !picked.has(player.playerId));
  const projectedHandicaps = projectDraftPickHandicaps(remaining);
  for (let pickIndex = picked.size; pickIndex < DRAFT_PLAYERS.length; pickIndex += 1) {
    const teamId = draftTeamAt(pickIndex);
    const handicap = projectedHandicaps[pickIndex - picked.size];
    rosters[teamId].push({
      playerId: `projected-draft-${pickIndex}`,
      name: "Projected player",
      handicap,
      teamId,
      projected: true
    });
  }
  return rosters;
}

function takeWeightedHandicap(players) {
  const available = players.filter((player) => Number(player.availableWeight || 0) > 0.0001);
  if (!available.length) return 12;
  const minHandicap = Math.min(...available.map((player) => Number(player.handicap || 0)));
  const weights = available.map((player) => (
    Number(player.availableWeight || 0) * Math.exp(-(Number(player.handicap || 0) - minHandicap) / 8)
  ));
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const probabilities = weights.map((weight) => weight / weightTotal);
  const expectedHandicap = available.reduce((sum, player, index) => (
    sum + Number(player.handicap || 0) * probabilities[index]
  ), 0);
  available.forEach((player, index) => {
    player.availableWeight = Math.max(0, Number(player.availableWeight || 0) - probabilities[index]);
  });
  return Math.round(expectedHandicap * 100) / 100;
}

function completeStageGroups(state, stageId, groupSize) {
  const rosters = completedRosters(state?.picks);
  const selected = normalizeLineups(state?.lineups)[stageId] || [];
  const byTeam = { jake: [], jack: [] };
  const projectedPlayers = [];
  for (const selection of selected) byTeam[selection.teamId].push(selection.playerIds.slice());
  for (const teamId of ["jake", "jack"]) {
    const used = new Set(byTeam[teamId].flat());
    const remaining = rosters[teamId]
      .filter((player) => !used.has(player.playerId))
      .map((player) => ({ ...player, availableWeight: 1 }));
    while (byTeam[teamId].length < (6 / groupSize)) {
      const groupIndex = byTeam[teamId].length;
      const group = [];
      for (let slotIndex = 0; slotIndex < groupSize; slotIndex += 1) {
        const player = {
          playerId: `projected-${stageId}-${teamId}-${groupIndex}-${slotIndex}`,
          name: "Handicap-weighted slot",
          handicap: takeWeightedHandicap(remaining),
          teamId,
          projected: true
        };
        projectedPlayers.push(player);
        group.push(player.playerId);
      }
      byTeam[teamId].push(group);
    }
  }
  return { groups: byTeam, players: [...rosters.jake, ...rosters.jack, ...projectedPlayers] };
}

function roundMatches(roundIndex, groups, points = 1) {
  return groups.jake.map((jakePlayers, matchIndex) => ({
    matchId: `r${roundIndex + 1}m${matchIndex + 1}`,
    points,
    teamA: { teamId: "jake", playerIds: jakePlayers },
    teamB: { teamId: "jack", playerIds: groups.jack[matchIndex] }
  }));
}

function anchoredModelGroups(groups, playersById) {
  const modelPlayers = new Map();
  const adjusted = { jake: [], jack: [] };
  for (const teamId of ["jake", "jack"]) {
    adjusted[teamId] = groups[teamId].map((group) => group.map((playerId) => {
      const player = playersById.get(playerId);
      if (!player) return playerId;
      const modelPlayerId = `anchored-model-${playerId}`;
      if (!modelPlayers.has(modelPlayerId)) {
        modelPlayers.set(modelPlayerId, {
          ...player,
          playerId: modelPlayerId,
          handicap: Math.round(Number(player.handicap || 0) * ANCHORED_MODEL_HANDICAP_MULTIPLIER * 100) / 100,
          displayPlayerId: player.playerId,
          displayHandicap: Number(player.handicap || 0),
          anchoredModelAdjustment: true
        });
      }
      return modelPlayerId;
    }));
  }
  return { groups: adjusted, players: Array.from(modelPlayers.values()) };
}

function selectCourses(catalogInput) {
  const courses = catalogInput?.courses || catalogInput || {};
  const values = Array.isArray(courses) ? courses : Object.values(courses);
  const sherrill = values.find((course) => course?.courseId === DEFAULT_SHERRILL.courseId) || DEFAULT_SHERRILL;
  const anchored = values.find((course) => course?.courseId === DEFAULT_ANCHORED.courseId) || DEFAULT_ANCHORED;
  return [sherrill, anchored].map((course) => ({
    courseId: course.courseId,
    name: course.name,
    pars: course.pars,
    strokeIndex: course.strokeIndex,
    ...(course.tees ? { tees: course.tees, selectedTeeKey: course.selectedTeeKey } : {})
  }));
}

export function buildDraftEventTournament(state, courseCatalog = {}) {
  const sherrill = completeStageGroups(state, "sherrillPairs", 2);
  const anchoredPairs = completeStageGroups(state, "anchoredPairs", 2);
  const anchoredSingles = completeStageGroups(state, "anchoredSingles", 1);
  const playersById = new Map();
  for (const player of [...sherrill.players, ...anchoredPairs.players, ...anchoredSingles.players]) {
    playersById.set(player.playerId, player);
  }
  const anchoredPairModel = anchoredModelGroups(anchoredPairs.groups, playersById);
  const anchoredSinglesModel = anchoredModelGroups(anchoredSingles.groups, playersById);
  for (const player of [...anchoredPairModel.players, ...anchoredSinglesModel.players]) {
    playersById.set(player.playerId, player);
  }
  const rounds = [
    { name: "Sherrill Front Scramble", holes: 9, nineHoleSide: "front", format: "scramble", useHandicap: false, courseIndex: 0, matches: roundMatches(0, sherrill.groups) },
    { name: "Sherrill Back Alternate Shot", holes: 9, nineHoleSide: "back", format: "alternate_shot", useHandicap: false, courseIndex: 0, matches: roundMatches(1, sherrill.groups) },
    { name: "Anchored Front Scramble", holes: 9, nineHoleSide: "front", format: "scramble", useHandicap: false, courseIndex: 1, matches: roundMatches(2, anchoredPairModel.groups) },
    { name: "Anchored Back Singles", holes: 9, nineHoleSide: "back", format: "singles", useHandicap: false, courseIndex: 1, matches: roundMatches(3, anchoredSinglesModel.groups) }
  ];
  return {
    version: Number(state?.version || 0),
    updatedAt: Number(state?.updatedAt || 0),
    tournament: {
      tournamentId: "kersting-2026-draft-event",
      competitionType: "team_match_play",
      scoring: "stroke",
      rounds,
      matchPlay: { teamIds: ["jake", "jack"], pointsPerMatch: 1, winTarget: 8 }
    },
    players: Array.from(playersById.values()),
    courses: selectCourses(courseCatalog),
    matchPlay: {
      teamIds: ["jake", "jack"],
      winTarget: 8,
      rounds: rounds.map((round, roundIndex) => ({
        roundIndex,
        matches: round.matches.map((match) => ({ ...match, thru: 0, holeResults: Array(18).fill(null) }))
      }))
    }
  };
}

export function computeDraftEventOdds(state, courseCatalog = {}) {
  const tournament = buildDraftEventTournament(state, courseCatalog);
  const result = computeLiveOdds(tournament);
  const playersById = new Map(tournament.players.map((player) => [player.playerId, player]));
  const eventTeams = new Map((result?.match_play?.event?.teams || []).map((team) => [team.teamId, team.winProbability]));
  const lineups = normalizeLineups(state?.lineups);
  const stageForRound = ["sherrillPairs", "sherrillPairs", "anchoredPairs", "anchoredSingles"];
  const publicOddsPlayer = (player) => ({
    playerId: player?.displayPlayerId || player?.playerId,
    name: player?.name,
    handicap: Number(player?.displayHandicap ?? player?.handicap ?? 0),
    projected: !!player?.projected
  });
  return {
    version: Number(state?.version || 0),
    generatedAt: result.generatedAt,
    modelVersion: result.modelVersion,
    simCount: result.simCount,
    projectionVersion: DRAFT_ODDS_PROJECTION_VERSION,
    projectionMethod: "team draft next-best handicap 75%, second-best 25%; handicap-weighted remaining match slots; Anchored model handicaps halved",
    courseAdjustments: { anchoredNationalHandicapMultiplier: ANCHORED_MODEL_HANDICAP_MULTIPLIER },
    event: {
      jakeWinProbability: Number(eventTeams.get("jake") || 0),
      tieProbability: Number(result?.match_play?.event?.tieProbability || 0),
      jackWinProbability: Number(eventTeams.get("jack") || 0)
    },
    rounds: (result?.match_play?.rounds || []).map((round, roundIndex) => ({
      roundIndex,
      name: tournament.tournament.rounds[roundIndex].name,
      format: tournament.tournament.rounds[roundIndex].format,
      provisional: lineups[stageForRound[roundIndex]].length < stageDefinition(stageForRound[roundIndex]).selections,
      matches: (round.matches || []).map((match) => ({
        matchId: match.matchId,
        jakePlayers: tournament.tournament.rounds[roundIndex].matches
          .find((entry) => entry.matchId === match.matchId)?.teamA.playerIds
          .map((playerId) => playersById.get(playerId))
          .filter(Boolean)
          .map(publicOddsPlayer) || [],
        jackPlayers: tournament.tournament.rounds[roundIndex].matches
          .find((entry) => entry.matchId === match.matchId)?.teamB.playerIds
          .map((playerId) => playersById.get(playerId))
          .filter(Boolean)
          .map(publicOddsPlayer) || [],
        provisional: ["teamA", "teamB"].some((side) => (
          tournament.tournament.rounds[roundIndex].matches
            .find((entry) => entry.matchId === match.matchId)?.[side].playerIds
            .some((playerId) => playersById.get(playerId)?.projected)
        )),
        jakeWinProbability: Number(match.teamAWinProbability || 0),
        tieProbability: Number(match.halveProbability || 0),
        jackWinProbability: Number(match.teamBWinProbability || 0)
      }))
    }))
  };
}
