import webpush from "web-push";
import { json, parseBody, getJson, updateStateWithRetry } from "./utils.js";

function normalizePublicKey() {
  return String(process.env.VAPID_PUBLIC_KEY || "").trim();
}

function normalizePrivateKey() {
  return String(process.env.VAPID_PRIVATE_KEY || "").trim();
}

function normalizeSubject() {
  return String(process.env.VAPID_SUBJECT || "mailto:admin@example.com").trim() || "mailto:admin@example.com";
}

function ensureWebPushConfigured() {
  const publicKey = normalizePublicKey();
  const privateKey = normalizePrivateKey();
  if (!publicKey || !privateKey) return false;
  webpush.setVapidDetails(normalizeSubject(), publicKey, privateKey);
  return true;
}

function normalizeSubscription(raw) {
  const endpoint = String(raw?.endpoint || "").trim();
  const p256dh = String(raw?.keys?.p256dh || "").trim();
  const auth = String(raw?.keys?.auth || "").trim();
  if (!endpoint || !p256dh || !auth) {
    const err = new Error("missing subscription endpoint or keys");
    err.statusCode = 400;
    throw err;
  }
  const expirationTime = raw?.expirationTime;
  const normalizedExpirationTime = expirationTime == null || expirationTime === ""
    ? null
    : Number(expirationTime);
  return {
    endpoint,
    expirationTime: Number.isFinite(normalizedExpirationTime) ? normalizedExpirationTime : null,
    keys: { p256dh, auth }
  };
}

function resolvePlayerMeta(state, code) {
  const normalizedCode = String(code || "").trim().toUpperCase();
  const playerId = String(state?.codeIndex?.[normalizedCode] || "").trim();
  const player = playerId ? state?.players?.[playerId] : null;
  if (!playerId || !player) {
    const err = new Error("invalid code");
    err.statusCode = 404;
    throw err;
  }
  return {
    playerId,
    playerName: String(player?.name || "").trim(),
    teamId: String(player?.teamId || "").trim()
  };
}

function roundLabel(state, roundIndex) {
  const idx = Number(roundIndex);
  const round = Number.isInteger(idx) ? state?.rounds?.[idx] : null;
  const base = Number.isInteger(idx) && idx >= 0 ? `Round ${idx + 1}` : "Round";
  const name = String(round?.name || "").trim();
  return name ? `${base} · ${name}` : base;
}

function scoreUpdateSummary(state, details) {
  const roundIndex = Number(details?.roundIndex);
  const hasRound = Number.isInteger(roundIndex) && roundIndex >= 0;
  const actorName = String(state?.players?.[details?.actorPlayerId]?.name || "A player").trim() || "A player";
  const scope = String(details?.mode || "").trim().toLowerCase() === "hole" && Number.isInteger(Number(details?.holeIndex))
    ? `hole ${Number(details.holeIndex) + 1}`
    : "scores";
  const body = `${hasRound ? roundLabel(state, roundIndex) : "Scores"} ${scope} updated by ${actorName}`;
  return {
    title: String(state?.tournament?.name || "Golf Tournament").trim() || "Golf Tournament",
    body,
    url: `./scoreboard.html?t=${encodeURIComponent(String(state?.tournament?.tournamentId || "").trim())}`,
    tag: `golf-score-${String(state?.tournament?.tournamentId || "").trim()}-${hasRound ? roundIndex : "x"}-${String(details?.mode || "bulk").trim().toLowerCase()}-${Number.isInteger(Number(details?.holeIndex)) ? Number(details.holeIndex) : "bulk"}`
  };
}

function isGoneError(error) {
  const status = Number(error?.statusCode || error?.status || error?.$metadata?.httpStatusCode || 0);
  return status === 404 || status === 410;
}

async function upsertSubscription(tid, code, subscription) {
  const safeSubscription = normalizeSubscription(subscription);
  const bucket = process.env.STATE_BUCKET;
  const now = Date.now();
  const { json: current } = await getJson(bucket, `state/${tid}.json`);
  if (!current) {
    const err = new Error("tournament not found");
    err.statusCode = 404;
    throw err;
  }
  const actor = resolvePlayerMeta(current, code);

  await updateStateWithRetry(tid, (state) => {
    state.pushSubscriptions = state.pushSubscriptions || {};
    const existing = state.pushSubscriptions[safeSubscription.endpoint] || {};
    state.pushSubscriptions[safeSubscription.endpoint] = {
      endpoint: safeSubscription.endpoint,
      expirationTime: safeSubscription.expirationTime,
      keys: safeSubscription.keys,
      playerId: actor.playerId,
      playerName: actor.playerName,
      teamId: actor.teamId,
      code: String(code || "").trim().toUpperCase(),
      subscribedAt: Number(existing.subscribedAt || now),
      updatedAt: now
    };
    return state;
  });

  return json(200, {
    ok: true,
    subscribed: true,
    playerId: actor.playerId
  });
}

async function removeSubscription(tid, code, endpoint) {
  const safeEndpoint = String(endpoint || "").trim();
  if (!safeEndpoint) {
    const err = new Error("missing endpoint");
    err.statusCode = 400;
    throw err;
  }

  const bucket = process.env.STATE_BUCKET;
  const { json: current } = await getJson(bucket, `state/${tid}.json`);
  if (!current) {
    const err = new Error("tournament not found");
    err.statusCode = 404;
    throw err;
  }
  if (String(code || "").trim()) {
    resolvePlayerMeta(current, code);
  }

  await updateStateWithRetry(tid, (state) => {
    if (state?.pushSubscriptions?.[safeEndpoint]) {
      delete state.pushSubscriptions[safeEndpoint];
    }
    return state;
  });

  return json(200, {
    ok: true,
    unsubscribed: true
  });
}

export async function notifyScoreSubscribers(tid, state, details = {}) {
  if (!ensureWebPushConfigured()) {
    return { skipped: true, reason: "push notifications are not configured" };
  }

  const subscriptions = Object.values(state?.pushSubscriptions || {});
  if (!subscriptions.length) {
    return { skipped: true, reason: "no subscriptions" };
  }

  const payload = JSON.stringify({
    ...scoreUpdateSummary(state, details),
    tid: String(tid || "").trim(),
    roundIndex: Number(details?.roundIndex),
    mode: String(details?.mode || "bulk").trim().toLowerCase(),
    holeIndex: Number.isInteger(Number(details?.holeIndex)) ? Number(details.holeIndex) : null
  });

  const staleEndpoints = new Set();
  let delivered = 0;

  await Promise.allSettled(
    subscriptions.map(async (subscription) => {
      if (!subscription?.endpoint) return;
      if (details?.actorPlayerId && String(subscription?.playerId || "") === String(details.actorPlayerId)) {
        return;
      }

      const cleanSubscription = {
        endpoint: subscription.endpoint,
        expirationTime: subscription.expirationTime ?? null,
        keys: subscription.keys
      };

      try {
        await webpush.sendNotification(cleanSubscription, payload, { TTL: 3600 });
        delivered += 1;
      } catch (error) {
        if (isGoneError(error)) {
          staleEndpoints.add(subscription.endpoint);
        } else {
          console.warn("Push notification failed:", error?.statusCode || error?.message || error);
        }
      }
    })
  );

  if (staleEndpoints.size) {
    await updateStateWithRetry(tid, (current) => {
      for (const endpoint of staleEndpoints) {
        if (current?.pushSubscriptions?.[endpoint]) {
          delete current.pushSubscriptions[endpoint];
        }
      }
      return current;
    });
  }

  return {
    skipped: false,
    delivered,
    stale: staleEndpoints.size
  };
}

export async function handler(event) {
  try {
    const method = String(event?.requestContext?.http?.method || event?.httpMethod || "").toUpperCase();
    const path = String(event?.rawPath || event?.path || event?.resource || "").toLowerCase();
    const tid = String(event?.pathParameters?.tid || "").trim();

    if (method === "GET") {
      const publicKey = normalizePublicKey();
      if (!publicKey) {
        return json(503, {
          error: "push notifications are not configured"
        });
      }
      return json(200, {
        ok: true,
        publicKey
      });
    }

    if (method !== "POST") {
      return json(405, { error: "Method not allowed" }, { Allow: "GET,POST,OPTIONS" });
    }

    const body = await parseBody(event);
    if (!tid) {
      return json(400, { error: "missing tid" });
    }

    if (path.endsWith("/push/subscribe")) {
      return await upsertSubscription(tid, body.code, body.subscription);
    }

    if (path.endsWith("/push/unsubscribe")) {
      return await removeSubscription(tid, body.code, body.endpoint || body.subscription?.endpoint);
    }

    return json(404, { error: "unknown push route" });
  } catch (error) {
    return json(error?.statusCode || 500, { error: error?.message || "Server error" });
  }
}
