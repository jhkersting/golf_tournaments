const COMPETITION_TYPE = "team_match_play";
const FORMATS = new Set(["singles", "best_ball", "alternate_shot", "scramble"]);

function fail(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

function text(value) {
  return String(value ?? "").trim();
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveNumber(value, fallback) {
  const number = numberOr(value, fallback);
  return number > 0 ? Number(number.toFixed(3)) : fallback;
}

function normalizeFormat(value) {
  const raw = text(value).toLowerCase().replace(/[\s-]+/g, "_");
  if (raw === "bestball" || raw === "best_ball") return "best_ball";
  if (raw === "alternate_shot" || raw === "alternateshot" || raw === "foursomes") return "alternate_shot";
  if (raw === "singles") return "singles";
  if (raw === "scramble") return "scramble";
  return raw;
}

function normalizePlayerIds(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  const out = values.map(text).filter(Boolean);
  if (new Set(out).size !== out.length) fail("Match playerIds must be unique within a side.");
  return out;
}

function sideInput(match, side) {
  const direct = match?.[side];
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;
  const aliases = side === "teamA"
    ? ["sideA", "team1", "a"]
    : ["sideB", "team2", "b"];
  for (const key of aliases) {
    const value = match?.[key];
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  }
  return {
    teamId: match?.[side === "teamA" ? "teamAId" : "teamBId"] ??
      match?.[side === "teamA" ? "team1Id" : "team2Id"],
    playerIds: match?.[side === "teamA" ? "playersA" : "playersB"]
  };
}

function normalizeSide(match, side) {
  const input = sideInput(match, side);
  const teamId = text(input?.teamId ?? input?.id ?? input?.team);
  if (!teamId) fail(`${side}.teamId is required.`);
  const playerIds = normalizePlayerIds(input?.playerIds ?? input?.players ?? input?.playerId);
  return { teamId, playerIds };
}

function normalizeMatch(match, roundIndex, matchIndex, defaultPoints, existingMatchId = null) {
  if (!match || typeof match !== "object") fail(`rounds[${roundIndex}].matches[${matchIndex}] must be an object.`);
  const matchId = text(match.matchId ?? match.id) || text(existingMatchId) || `r${roundIndex + 1}m${matchIndex + 1}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(matchId)) {
    fail(`Invalid matchId "${matchId}".`);
  }
  return {
    matchId,
    points: positiveNumber(match.points ?? match.pointValue, defaultPoints),
    teamA: normalizeSide(match, "teamA"),
    teamB: normalizeSide(match, "teamB")
  };
}

function roundInput(round, existing) {
  return round && typeof round === "object" ? round : existing || {};
}

export function normalizeMatchPlayRounds(roundsIn, existingRounds = [], defaultPoints = 1) {
  const raw = Array.isArray(roundsIn) ? roundsIn : [];
  if (!raw.length) fail("At least one match-play round is required.");
  return raw.map((roundValue, roundIndex) => {
    const round = roundInput(roundValue, existingRounds?.[roundIndex]);
    const holes = Number(round.holes ?? round.holeCount ?? 18);
    if (holes !== 9 && holes !== 18) fail(`rounds[${roundIndex}].holes must be 9 or 18.`);
    const format = normalizeFormat(round.format);
    if (!FORMATS.has(format)) fail(`Unsupported match-play format "${round.format}".`);
    const matchesIn = Array.isArray(round.matches) ? round.matches : [];
    if (!matchesIn.length) fail(`rounds[${roundIndex}].matches must contain at least one match.`);
    const points = positiveNumber(round.pointsPerMatch ?? round.matchPoints, defaultPoints);
    const existingMatches = Array.isArray(existingRounds?.[roundIndex]?.matches)
      ? existingRounds[roundIndex].matches
      : [];
    const matches = matchesIn.map((match, matchIndex) => normalizeMatch(
      match,
      roundIndex,
      matchIndex,
      points,
      existingMatches[matchIndex]?.matchId
    ));
    const matchIds = new Set();
    const playersInRound = new Set();
    for (const match of matches) {
      if (match.teamA.teamId === match.teamB.teamId) fail(`Match ${match.matchId} must have two different teams.`);
      if (matchIds.has(match.matchId)) fail(`Duplicate matchId "${match.matchId}".`);
      matchIds.add(match.matchId);
      const playerCountRule = format === "singles"
        ? { min: 1, max: 1, label: "exactly 1 player" }
        : format === "best_ball"
          ? { min: 2, max: 4, label: "2 to 4 players" }
          : { min: 2, max: 2, label: "exactly 2 players" };
      for (const [sideName, side] of [["teamA", match.teamA], ["teamB", match.teamB]]) {
        if (side.playerIds.length < playerCountRule.min || side.playerIds.length > playerCountRule.max) {
          fail(`${sideName}.playerIds for ${format} match ${match.matchId} must contain ${playerCountRule.label}.`);
        }
        for (const playerId of side.playerIds) {
          if (playersInRound.has(playerId)) fail(`Player ${playerId} is assigned to more than one match in round ${roundIndex}.`);
          playersInRound.add(playerId);
        }
      }
    }
    if (round.useHandicap && !["singles", "best_ball"].includes(format)) {
      fail(`Handicaps are not supported for ${format} match-play rounds.`);
    }
    return {
      name: text(round.name) || `Round ${roundIndex + 1}`,
      holes,
      format,
      useHandicap: !!round.useHandicap,
      courseIndex: Number.isInteger(Number(round.courseIndex)) && Number(round.courseIndex) >= 0
        ? Number(round.courseIndex)
        : 0,
      matches
    };
  });
}

function configuredTeamIds(raw, rounds) {
  const value = raw?.teamIds ?? raw?.teams;
  const ids = Array.isArray(value)
    ? value.map((item) => text(item?.teamId ?? item?.id ?? item)).filter(Boolean)
    : [];
  if (!ids.length) {
    for (const round of rounds) {
      for (const match of round.matches) {
        ids.push(match.teamA.teamId, match.teamB.teamId);
      }
    }
  }
  const unique = [...new Set(ids)];
  if (unique.length !== 2) fail("team_match_play requires exactly two teamIds.");
  return unique;
}

export function normalizeMatchPlayConfiguration(raw, roundsIn, { teams = {}, players = {} } = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const pointsPerMatch = positiveNumber(source.pointsPerMatch ?? source.matchPoints, 1);
  const rounds = normalizeMatchPlayRounds(roundsIn, source.rounds, pointsPerMatch);
  const teamIds = configuredTeamIds(source, rounds);
  const matches = rounds.flatMap((round) => round.matches);
  if (Object.keys(players).length) {
    for (const [playerId, player] of Object.entries(players)) {
      if (player?.teamId && !teamIds.includes(text(player.teamId))) {
        fail(`Player ${playerId} belongs to a team outside matchPlay.teamIds.`);
      }
    }
  }
  for (const round of rounds) {
    for (const match of round.matches) {
      for (const side of [match.teamA, match.teamB]) {
        if (!teamIds.includes(side.teamId)) fail(`Match ${match.matchId} uses a team outside matchPlay.teamIds.`);
        if (Object.keys(teams).length && !teams[side.teamId]) fail(`Match ${match.matchId} references unknown team ${side.teamId}.`);
        for (const playerId of side.playerIds) {
          const player = players[playerId];
          if (Object.keys(players).length && !player) fail(`Match ${match.matchId} references unknown player ${playerId}.`);
          if (player && text(player.teamId) !== side.teamId) {
            fail(`Player ${playerId} must belong to ${side.teamId} in match ${match.matchId}.`);
          }
        }
      }
    }
  }
  const scheduledPoints = matches.reduce((sum, match) => sum + Number(match.points || pointsPerMatch), 0);
  const explicitTarget = source.winTarget ?? source.targetPoints ?? source.winningPoints;
  const winTarget = explicitTarget == null || explicitTarget === ""
    ? Number((scheduledPoints / 2 + 0.5).toFixed(3))
    : positiveNumber(explicitTarget, 0);
  if (!(winTarget > 0)) fail("matchPlay.winTarget must be greater than zero.");
  return {
    teamIds,
    pointsPerMatch,
    winTarget,
    rounds,
    scheduledPoints: Number(scheduledPoints.toFixed(3))
  };
}

export function isTeamMatchPlay(stateOrTournament) {
  const tournament = stateOrTournament?.tournament || stateOrTournament || {};
  return text(tournament.competitionType).toLowerCase() === COMPETITION_TYPE;
}

export function emptyMatchPlayScores(rounds = []) {
  return rounds.map((round) => ({
    teams: {},
    players: {},
    groups: {},
    matches: Object.fromEntries((round.matches || []).map((match) => [match.matchId, {
      sides: {
        [match.teamA.teamId]: { holes: Array(18).fill(null), meta: Array(18).fill(null) },
        [match.teamB.teamId]: { holes: Array(18).fill(null), meta: Array(18).fill(null) }
      }
    }]))
  }));
}

function holesFor(value, holes) {
  const source = Array.isArray(value) ? value : value?.holes;
  return Array.from({ length: 18 }, (_, index) => {
    if (index >= holes || !Array.isArray(source)) return null;
    const number = Number(source[index]);
    return Number.isFinite(number) && number >= 1 && number <= 20 ? number : null;
  });
}

function handicapShots(handicap, strokeIndex) {
  const value = Math.max(0, Math.floor(Number(handicap) || 0));
  const base = Math.floor(value / 18);
  const remainder = value % 18;
  return Array.from({ length: 18 }, (_, index) => base + (Number(strokeIndex?.[index] ?? index + 1) <= remainder ? 1 : 0));
}

function sideScores(match, format, side, roundScores, players, course, holes, useHandicap) {
  if (format === "alternate_shot" || format === "scramble") {
    return holesFor(roundScores?.matches?.[match.matchId]?.sides?.[side.teamId], holes);
  }
  const values = side.playerIds.map((playerId) => {
    const player = players[playerId] || {};
    const gross = holesFor(roundScores?.players?.[playerId], holes);
    const shots = useHandicap ? handicapShots(player.handicap, course?.strokeIndex) : Array(18).fill(0);
    return { gross, net: gross.map((value, index) => value == null ? null : value - shots[index]) };
  });
  return Array.from({ length: 18 }, (_, index) => {
    const candidates = values.map((value) => useHandicap ? value.net[index] : value.gross[index])
      .filter((value) => value != null);
    return candidates.length ? Math.min(...candidates) : null;
  });
}

function resultText(result, holes) {
  if (result.status === "not_started") return "Not started";
  if (result.status === "live") return result.lead === 0 ? `AS thru ${result.thru}` : `${Math.abs(result.lead)} UP thru ${result.thru}`;
  if (result.result === "halved") return "Halved";
  if (result.status === "closed") return `${Math.abs(result.lead)}&${result.holesRemaining}`;
  return result.lead === 0 ? "Halved" : `${Math.abs(result.lead)} UP`;
}

function materializeMatch(match, round, roundScores, players, course) {
  const sideA = sideScores(match, round.format, match.teamA, roundScores, players, course, round.holes, round.useHandicap);
  const sideB = sideScores(match, round.format, match.teamB, roundScores, players, course, round.holes, round.useHandicap);
  const holeResults = Array(18).fill(null);
  let aWins = 0;
  let bWins = 0;
  const played = [];
  for (let index = 0; index < round.holes; index++) {
    if (sideA[index] == null || sideB[index] == null) continue;
    played.push(index);
    if (sideA[index] < sideB[index]) { aWins += 1; holeResults[index] = match.teamA.teamId; }
    else if (sideB[index] < sideA[index]) { bWins += 1; holeResults[index] = match.teamB.teamId; }
    else holeResults[index] = "halved";
  }
  const lead = aWins - bWins;
  const holesRemaining = Math.max(0, round.holes - played.length);
  const earlyClosed = played.length > 0 && Math.abs(lead) > holesRemaining;
  const allPlayed = played.length === round.holes;
  const status = !played.length ? "not_started" : earlyClosed ? "closed" : allPlayed ? "final" : "live";
  const winnerTeamId = lead > 0 ? match.teamA.teamId : lead < 0 ? match.teamB.teamId : null;
  const result = earlyClosed || allPlayed ? (winnerTeamId || "halved") : null;
  const points = status === "not_started" || status === "live"
    ? { [match.teamA.teamId]: 0, [match.teamB.teamId]: 0 }
    : result === "halved"
      ? { [match.teamA.teamId]: match.points / 2, [match.teamB.teamId]: match.points / 2 }
      : {
        [match.teamA.teamId]: result === match.teamA.teamId ? match.points : 0,
        [match.teamB.teamId]: result === match.teamB.teamId ? match.points : 0
      };
  const thru = played.length ? Math.max(...played) + 1 : 0;
  const output = {
    matchId: match.matchId,
    pointsAvailable: match.points,
    teamA: { ...match.teamA },
    teamB: { ...match.teamB },
    sideScores: { [match.teamA.teamId]: sideA, [match.teamB.teamId]: sideB },
    holeResults,
    holes: round.holes,
    thru,
    holesRemaining,
    lead,
    leadTeamId: winnerTeamId,
    winnerTeamId: result === "halved" ? null : result,
    result,
    status,
    completion: earlyClosed ? "closed_early" : allPlayed ? "all_holes" : null,
    points,
    lastHoleResult: played.length ? holeResults[played[played.length - 1]] : null
  };
  output.display = resultText(output, round.holes);
  return output;
}

export function materializeMatchPlay({ tournament, rounds, teams, players, scores, courses }) {
  const config = normalizeMatchPlayConfiguration(tournament?.matchPlay, rounds, { teams, players });
  const byRound = config.rounds.map((round, roundIndex) => {
    const course = (courses || [])[Number(round.courseIndex)] || (courses || [])[0] || {};
    const roundScores = scores?.rounds?.[roundIndex] || {};
    const matches = round.matches.map((match) => materializeMatch(match, round, roundScores, players || {}, course));
    return { roundIndex, name: round.name, holes: round.holes, format: round.format, useHandicap: round.useHandicap, matches };
  });
  const standings = config.teamIds.map((teamId) => ({
    teamId,
    teamName: teams?.[teamId]?.teamName || teamId,
    points: 0,
    matchesWon: 0,
    matchesHalved: 0,
    matchesLost: 0,
    matchesCompleted: 0,
    matchesScheduled: 0
  }));
  const standingById = Object.fromEntries(standings.map((row) => [row.teamId, row]));
  for (const round of byRound) {
    for (const match of round.matches) {
      for (const teamId of [match.teamA.teamId, match.teamB.teamId]) {
        standingById[teamId].matchesScheduled += 1;
        standingById[teamId].points += Number(match.points?.[teamId] || 0);
      }
      if (match.status === "not_started" || match.status === "live") continue;
      for (const teamId of [match.teamA.teamId, match.teamB.teamId]) standingById[teamId].matchesCompleted += 1;
      if (match.result === "halved") {
        standingById[match.teamA.teamId].matchesHalved += 1;
        standingById[match.teamB.teamId].matchesHalved += 1;
      } else {
        const loser = match.result === match.teamA.teamId ? match.teamB.teamId : match.teamA.teamId;
        standingById[match.result].matchesWon += 1;
        standingById[loser].matchesLost += 1;
      }
    }
  }
  for (const row of standings) row.points = Number(row.points.toFixed(3));
  const winner = standings.find((row) => row.points >= config.winTarget) || null;
  const allComplete = byRound.every((round) => round.matches.every((match) => match.status === "final" || match.status === "closed"));
  const matchPlay = {
    teamIds: config.teamIds,
    pointsPerMatch: config.pointsPerMatch,
    scheduledPoints: config.scheduledPoints,
    winTarget: config.winTarget,
    status: winner ? "complete" : allComplete ? "complete" : standings.every((row) => row.matchesCompleted === 0) ? "not_started" : "in_progress",
    winnerTeamId: winner?.teamId || null,
    standings,
    rounds: byRound
  };
  return matchPlay;
}

export { COMPETITION_TYPE };
