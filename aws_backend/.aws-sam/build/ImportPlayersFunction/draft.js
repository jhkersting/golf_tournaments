import crypto from "crypto";
import { json, parseBody, getJson, putJson } from "./utils.js";
import {
  CAPTAINS,
  DRAFT_PLAYERS,
  DRAFT_PLAYER_IDS,
  DRAFT_ODDS_PROJECTION_VERSION,
  LINEUP_STAGES,
  activeLineupStage,
  computeDraftEventOdds,
  draftTeamAt,
  emptyLineups,
  lineupPickIndex,
  normalizeLineups,
  snakeTeamAt,
  stageDefinition,
  teamRosters
} from "./draft_event.js";

const DRAFT_KEY = "drafts/kersting-2026.json";
const DRAFT_PRESENCE_KEY = "drafts/kersting-2026-presence.json";
export const DRAFT_VIEWER_TTL_MS = 30_000;
const MAX_ACTIVE_VIEWER_SESSIONS = 100;
const DRAFT_VIEWER_DIRECTORY = [CAPTAINS.jack, CAPTAINS.jake, ...DRAFT_PLAYERS]
  .map((player) => ({ playerId: player.playerId, name: player.name }));
const DRAFT_VIEWER_BY_ID = new Map(DRAFT_VIEWER_DIRECTORY.map((player) => [player.playerId, player]));
const JACK_CODE_HASH = "8e8dbda7c435a2e3199f9861d771f05f927b9a43f539dd0e2318ab8d64891a0d";
const JAKE_CODE_HASH = "5d209db94c5817141153bb271b56dfd690491f068ed5e5b8253e480bcbf095d3";

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[\s-]+/g, "");
}

function hashCode(value) {
  return crypto.createHash("sha256").update(normalizeCode(value), "utf8").digest("hex");
}

function hashMatches(actual, expected) {
  const actualBuffer = Buffer.from(actual, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function validViewerSessionId(value) {
  const sessionId = String(value || "").trim();
  return /^[A-Za-z0-9_-]{12,80}$/.test(sessionId) ? sessionId : "";
}

export function normalizeDraftPresence(raw, now = Date.now()) {
  const cutoff = now - DRAFT_VIEWER_TTL_MS;
  const sessions = Object.entries(raw?.sessions && typeof raw.sessions === "object" ? raw.sessions : {})
    .map(([sessionId, entry]) => ({
      sessionId: validViewerSessionId(sessionId),
      playerId: String(entry?.playerId || "").trim(),
      lastSeen: Math.floor(Number(entry?.lastSeen) || 0)
    }))
    .filter((entry) => (
      entry.sessionId
      && DRAFT_VIEWER_BY_ID.has(entry.playerId)
      && entry.lastSeen >= cutoff
      && entry.lastSeen <= now + DRAFT_VIEWER_TTL_MS
    ))
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, MAX_ACTIVE_VIEWER_SESSIONS);
  return {
    sessions: Object.fromEntries(sessions.map(({ sessionId, playerId, lastSeen }) => [sessionId, { playerId, lastSeen }])),
    updatedAt: Math.max(0, Math.floor(Number(raw?.updatedAt) || 0))
  };
}

export function draftViewerList(raw, now = Date.now()) {
  const presence = normalizeDraftPresence(raw, now);
  const activeIds = new Set(Object.values(presence.sessions).map((entry) => entry.playerId));
  return DRAFT_VIEWER_DIRECTORY.filter((player) => activeIds.has(player.playerId));
}

export function roleForCode(code) {
  const actual = hashCode(code);
  if (hashMatches(actual, JACK_CODE_HASH)) return "jack";
  if (hashMatches(actual, JAKE_CODE_HASH)) return "jake";
  return "";
}

export function normalizeDraftState(raw) {
  const seen = new Set();
  const picks = (Array.isArray(raw?.picks) ? raw.picks : []).filter((id) => {
    const normalized = String(id || "").trim();
    if (!DRAFT_PLAYER_IDS.has(normalized) || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
  return {
    picks,
    lineups: normalizeLineups(raw?.lineups),
    odds: raw?.odds && typeof raw.odds === "object" ? raw.odds : null,
    version: Math.max(0, Math.floor(Number(raw?.version) || 0)),
    updatedAt: Math.max(0, Math.floor(Number(raw?.updatedAt) || 0))
  };
}

function requireRoleForTeam(role, teamId) {
  if (role === "jack" || role === teamId) return;
  const error = new Error(`wait for ${teamId === "jake" ? "Jake" : "Jack"}'s turn`);
  error.statusCode = 403;
  throw error;
}

function applyLineupPick(state, body, role) {
  if (state.picks.length !== DRAFT_PLAYER_IDS.size) {
    const error = new Error("finish the team draft before setting matches");
    error.statusCode = 409;
    throw error;
  }
  const activeStage = activeLineupStage(state.lineups);
  const requestedStage = stageDefinition(body?.stageId);
  if (!activeStage || !requestedStage || activeStage.stageId !== requestedStage.stageId) {
    const error = new Error(activeStage ? `finish ${activeStage.label} first` : "all match lineups are complete");
    error.statusCode = 409;
    throw error;
  }
  const selections = state.lineups[activeStage.stageId];
  const teamId = snakeTeamAt(lineupPickIndex(state.lineups));
  requireRoleForTeam(role, teamId);
  const playerIds = (Array.isArray(body?.playerIds) ? body.playerIds : [body?.playerId])
    .map((playerId) => String(playerId || "").trim())
    .filter(Boolean);
  if (playerIds.length !== activeStage.groupSize || new Set(playerIds).size !== playerIds.length) {
    const error = new Error(`select exactly ${activeStage.groupSize} player${activeStage.groupSize === 1 ? "" : "s"}`);
    error.statusCode = 400;
    throw error;
  }
  const rosterIds = new Set(teamRosters(state.picks)[teamId].map((player) => player.playerId));
  const usedIds = new Set(selections.filter((selection) => selection.teamId === teamId).flatMap((selection) => selection.playerIds));
  if (playerIds.some((playerId) => !rosterIds.has(playerId))) {
    const error = new Error("selected player is not on the team on the clock");
    error.statusCode = 400;
    throw error;
  }
  if (playerIds.some((playerId) => usedIds.has(playerId))) {
    const error = new Error("selected player is already used in this lineup stage");
    error.statusCode = 409;
    throw error;
  }
  selections.push({ teamId, playerIds });
}

export function applyDraftAction(stateInput, body, role, now = Date.now()) {
  const state = normalizeDraftState(stateInput);
  const action = String(body?.action || "").trim().toLowerCase();
  const currentTeam = draftTeamAt(state.picks.length);

  if (action === "authenticate") return { ...state, role };
  if (!role) {
    const error = new Error("invalid draft code");
    error.statusCode = 403;
    throw error;
  }
  if (action === "pick") {
    requireRoleForTeam(role, currentTeam);
    const playerId = String(body?.playerId || "").trim();
    if (!DRAFT_PLAYER_IDS.has(playerId)) {
      const error = new Error("invalid player");
      error.statusCode = 400;
      throw error;
    }
    if (state.picks.includes(playerId)) {
      const error = new Error("player has already been drafted");
      error.statusCode = 409;
      throw error;
    }
    if (state.picks.length >= DRAFT_PLAYER_IDS.size) {
      const error = new Error("draft is complete");
      error.statusCode = 409;
      throw error;
    }
    state.picks.push(playerId);
    state.lineups = emptyLineups();
  } else if (action === "undo") {
    if (role !== "jack") {
      const error = new Error("admin code required");
      error.statusCode = 403;
      throw error;
    }
    state.picks.pop();
    state.lineups = emptyLineups();
  } else if (action === "reset") {
    if (role !== "jack") {
      const error = new Error("admin code required");
      error.statusCode = 403;
      throw error;
    }
    state.picks = [];
    state.lineups = emptyLineups();
  } else if (action === "lineup-pick") {
    applyLineupPick(state, body, role);
  } else if (action === "lineup-undo") {
    if (role !== "jack") {
      const error = new Error("admin code required");
      error.statusCode = 403;
      throw error;
    }
    const lastStage = [...LINEUP_STAGES].reverse().find((stage) => state.lineups[stage.stageId].length);
    if (lastStage) state.lineups[lastStage.stageId].pop();
  } else if (action === "lineup-reset") {
    if (role !== "jack") {
      const error = new Error("admin code required");
      error.statusCode = 403;
      throw error;
    }
    state.lineups = emptyLineups();
  } else {
    const error = new Error("invalid draft action");
    error.statusCode = 400;
    throw error;
  }

  state.version += 1;
  state.updatedAt = now;
  return state;
}

async function updateDraftWithRetry(body, role, courseCatalog, { maxTries = 5 } = {}) {
  const bucket = process.env.STATE_BUCKET;
  for (let attempt = 1; attempt <= maxTries; attempt += 1) {
    const { json: current, etag } = await getJson(bucket, DRAFT_KEY);
    const next = applyDraftAction(current, body, role);
    next.odds = computeDraftEventOdds(next, courseCatalog);
    try {
      await putJson(bucket, DRAFT_KEY, next, { ifMatch: etag, cacheControl: "no-store" });
      return next;
    } catch (error) {
      const status = error?.$metadata?.httpStatusCode;
      if (status === 412 || error?.name === "PreconditionFailed") {
        if (attempt < maxTries) continue;
        const conflict = new Error("draft changed; please try again");
        conflict.statusCode = 409;
        throw conflict;
      }
      throw error;
    }
  }
}

async function readDraftWithOdds(courseCatalog) {
  const bucket = process.env.STATE_BUCKET;
  const { json: current, etag } = await getJson(bucket, DRAFT_KEY);
  const state = normalizeDraftState(current);
  if (
    Number(state?.odds?.version) === state.version
    && state?.odds?.projectionVersion === DRAFT_ODDS_PROJECTION_VERSION
  ) return state;
  state.odds = computeDraftEventOdds(state, courseCatalog);
  try {
    await putJson(bucket, DRAFT_KEY, state, { ifMatch: etag, cacheControl: "no-store" });
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    if (status !== 412 && error?.name !== "PreconditionFailed") throw error;
  }
  return state;
}

async function readDraftViewers(now = Date.now()) {
  const { json: current } = await getJson(process.env.STATE_BUCKET, DRAFT_PRESENCE_KEY);
  return draftViewerList(current, now);
}

async function updateDraftViewer(body, now = Date.now(), { maxTries = 5 } = {}) {
  const playerId = String(body?.viewerId || "").trim();
  const sessionId = validViewerSessionId(body?.viewerSessionId);
  if (!DRAFT_VIEWER_BY_ID.has(playerId) || !sessionId) {
    const error = new Error("select a valid viewer name");
    error.statusCode = 400;
    throw error;
  }
  const bucket = process.env.STATE_BUCKET;
  for (let attempt = 1; attempt <= maxTries; attempt += 1) {
    const { json: current, etag } = await getJson(bucket, DRAFT_PRESENCE_KEY);
    const next = normalizeDraftPresence(current, now);
    next.sessions[sessionId] = { playerId, lastSeen: now };
    next.updatedAt = now;
    try {
      await putJson(bucket, DRAFT_PRESENCE_KEY, next, { ifMatch: etag, cacheControl: "no-store" });
      return draftViewerList(next, now);
    } catch (error) {
      const status = error?.$metadata?.httpStatusCode;
      if ((status === 412 || error?.name === "PreconditionFailed") && attempt < maxTries) continue;
      if (status === 412 || error?.name === "PreconditionFailed") {
        const conflict = new Error("viewer list changed; please try again");
        conflict.statusCode = 409;
        throw conflict;
      }
      throw error;
    }
  }
}

export async function handler(event) {
  try {
    const method = String(event?.requestContext?.http?.method || event?.httpMethod || "").toUpperCase();
    if (method === "GET") {
      const { json: courseCatalog } = await getJson(process.env.STATE_BUCKET, "courses/catalog.json");
      const [state, viewers] = await Promise.all([readDraftWithOdds(courseCatalog), readDraftViewers()]);
      return json(200, { ...state, viewers }, { "Cache-Control": "no-store" });
    }
    if (method !== "POST") return json(405, { error: "method not allowed" });

    const body = await parseBody(event);
    if (String(body?.action || "").trim().toLowerCase() === "watch") {
      return json(200, { viewers: await updateDraftViewer(body) }, { "Cache-Control": "no-store" });
    }
    const { json: courseCatalog } = await getJson(process.env.STATE_BUCKET, "courses/catalog.json");
    const role = roleForCode(body?.code);
    if (!role) return json(403, { error: "invalid draft code" });
    if (String(body?.action || "").toLowerCase() === "authenticate") {
      return json(200, { ...(await readDraftWithOdds(courseCatalog)), role });
    }
    const state = await updateDraftWithRetry(body, role, courseCatalog);
    return json(200, { ...state, role });
  } catch (error) {
    console.error(error);
    return json(error?.statusCode || 500, { error: error?.message || "draft update failed" });
  }
}
