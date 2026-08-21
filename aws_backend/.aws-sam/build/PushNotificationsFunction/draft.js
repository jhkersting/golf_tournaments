import crypto from "crypto";
import { json, parseBody, getJson, putJson } from "./utils.js";

const DRAFT_KEY = "drafts/kersting-2026.json";
const JACK_CODE_HASH = "8e8dbda7c435a2e3199f9861d771f05f927b9a43f539dd0e2318ab8d64891a0d";
const JAKE_CODE_HASH = "5d209db94c5817141153bb271b56dfd690491f068ed5e5b8253e480bcbf095d3";
const TEAM_ORDER = ["jake", "jack"];
const PLAYER_IDS = new Set(["d-davidson", "j-royse", "w-parten", "b-holley", "j-collins", "p-addington", "j-jones", "n-burlbaw", "f-kersting", "h-coop"]);

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
    if (!PLAYER_IDS.has(normalized) || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
  return {
    picks,
    version: Math.max(0, Math.floor(Number(raw?.version) || 0)),
    updatedAt: Math.max(0, Math.floor(Number(raw?.updatedAt) || 0))
  };
}

export function applyDraftAction(stateInput, body, role, now = Date.now()) {
  const state = normalizeDraftState(stateInput);
  const action = String(body?.action || "").trim().toLowerCase();
  const currentTeam = TEAM_ORDER[state.picks.length % TEAM_ORDER.length];

  if (action === "authenticate") return { ...state, role };
  if (!role) {
    const error = new Error("invalid draft code");
    error.statusCode = 403;
    throw error;
  }
  if (action === "pick") {
    if (role !== "jack" && role !== currentTeam) {
      const error = new Error("wait for Jake's turn");
      error.statusCode = 403;
      throw error;
    }
    const playerId = String(body?.playerId || "").trim();
    if (!PLAYER_IDS.has(playerId)) {
      const error = new Error("invalid player");
      error.statusCode = 400;
      throw error;
    }
    if (state.picks.includes(playerId)) {
      const error = new Error("player has already been drafted");
      error.statusCode = 409;
      throw error;
    }
    if (state.picks.length >= PLAYER_IDS.size) {
      const error = new Error("draft is complete");
      error.statusCode = 409;
      throw error;
    }
    state.picks.push(playerId);
  } else if (action === "undo") {
    if (role !== "jack") {
      const error = new Error("admin code required");
      error.statusCode = 403;
      throw error;
    }
    state.picks.pop();
  } else if (action === "reset") {
    if (role !== "jack") {
      const error = new Error("admin code required");
      error.statusCode = 403;
      throw error;
    }
    state.picks = [];
  } else {
    const error = new Error("invalid draft action");
    error.statusCode = 400;
    throw error;
  }

  state.version += 1;
  state.updatedAt = now;
  return state;
}

async function updateDraftWithRetry(body, role, { maxTries = 5 } = {}) {
  const bucket = process.env.STATE_BUCKET;
  for (let attempt = 1; attempt <= maxTries; attempt += 1) {
    const { json: current, etag } = await getJson(bucket, DRAFT_KEY);
    const next = applyDraftAction(current, body, role);
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

export async function handler(event) {
  try {
    const method = String(event?.requestContext?.http?.method || event?.httpMethod || "").toUpperCase();
    if (method === "GET") {
      const { json: state } = await getJson(process.env.STATE_BUCKET, DRAFT_KEY);
      return json(200, normalizeDraftState(state), { "Cache-Control": "no-store" });
    }
    if (method !== "POST") return json(405, { error: "method not allowed" });

    const body = await parseBody(event);
    const role = roleForCode(body?.code);
    if (!role) return json(403, { error: "invalid draft code" });
    if (String(body?.action || "").toLowerCase() === "authenticate") {
      const { json: state } = await getJson(process.env.STATE_BUCKET, DRAFT_KEY);
      return json(200, { ...normalizeDraftState(state), role });
    }
    const state = await updateDraftWithRetry(body, role);
    return json(200, { ...state, role });
  } catch (error) {
    console.error(error);
    return json(error?.statusCode || 500, { error: error?.message || "draft update failed" });
  }
}
