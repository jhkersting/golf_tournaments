import webpush from "web-push";
import { json, parseBody, getJson, materializePublicFromState, updateStateWithRetry } from "./utils.js";

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

function normalizeTwoManFormat(format) {
  const fmt = String(format || "").trim().toLowerCase();
  if (fmt === "two_man") return "two_man_scramble";
  if (fmt === "two_man_scramble" || fmt === "two_man_shamble" || fmt === "two_man_best_ball") return fmt;
  return "";
}

function scoreResultLabel(diffToPar) {
  if (diffToPar <= -3) return "Albatross";
  if (diffToPar === -2) return "Eagle";
  if (diffToPar === -1) return "Birdie";
  if (diffToPar === 0) return "Par";
  if (diffToPar === 1) return "Bogey";
  if (diffToPar === 2) return "Double Bogey";
  if (diffToPar === 3) return "Triple Bogey";
  return `${diffToPar} Over`;
}

function scoreNotifierRoundLabel(roundIndex) {
  const idx = Number(roundIndex);
  return Number.isInteger(idx) && idx >= 0 ? `Round ${idx + 1}` : "Round";
}

function scoreNotifierThruText(thru) {
  const n = Number(thru);
  if (!Number.isFinite(n) || n <= 0) return "";
  return String(Math.floor(n));
}

function scoreNotifierToParText(row, useHandicap) {
  if (!row) return "";
  const scores = row?.scores || {};
  if (useHandicap) {
    const gross = scores?.grossToParTotal ?? row?.grossToParTotal ?? row?.grossToPar ?? null;
    const net = scores?.netToParTotal ?? row?.netToParTotal ?? row?.netToPar ?? null;
    if (gross != null && net != null) return `${gross} [${net}]`;
  }
  const single = row?.toPar ?? scores?.toPar ?? scores?.netToParTotal ?? scores?.grossToParTotal;
  return single != null ? String(single) : "";
}

function scoreNotificationItems(state, tournamentJson, details) {
  const roundIndex = Number(details?.roundIndex);
  const holeIndex = Number.isInteger(Number(details?.holeIndex)) ? Number(details.holeIndex) : null;
  if (!Number.isInteger(roundIndex) || roundIndex < 0 || holeIndex == null) return [];

  const roundCfg = state?.rounds?.[roundIndex] || {};
  const useHandicap = !!roundCfg?.useHandicap;
  const pars = scoreNotifierCoursePars(tournamentJson, roundIndex);
  const entries = Array.isArray(details?.entries) ? details.entries : [];
  const seen = new Set();
  const items = [];

  for (const entry of entries) {
    const targetId = String(entry?.targetId || "").trim();
    if (!targetId || seen.has(targetId)) continue;
    seen.add(targetId);

    const row = rowForNotification(state, tournamentJson, roundIndex, details, targetId);
    const name = targetLabelForNotification(state, tournamentJson, roundIndex, details, targetId) || targetId;
    const strokes = Number(entry?.strokes);
    const par = Number(pars?.[holeIndex] || 0);
    const diffToPar = Number.isFinite(strokes) && par > 0 ? strokes - par : 0;
    const result = scoreResultLabel(diffToPar);
    const toPar = scoreNotifierToParText(row, useHandicap) || "E";
    const thru = scoreNotifierThruText(row?.thru ?? row?.scores?.thru);

    items.push(`${name} | ${result} (${toPar})${thru ? ` Thru ${thru}` : ""}`);
  }

  return items;
}

function scoreNotifierCoursePars(tournamentJson, roundIndex) {
  const rounds = Array.isArray(tournamentJson?.tournament?.rounds) ? tournamentJson.tournament.rounds : [];
  const courses = Array.isArray(tournamentJson?.courses) && tournamentJson.courses.length
    ? tournamentJson.courses
    : [tournamentJson?.course || {}];
  const round = rounds?.[roundIndex] || {};
  const idxRaw = Number(round?.courseIndex);
  const idx = Number.isInteger(idxRaw) && idxRaw >= 0 && idxRaw < courses.length ? idxRaw : 0;
  const pars = courses?.[idx]?.pars;
  return Array.from({ length: 18 }, (_, holeIndex) => Number(pars?.[holeIndex]) || 4);
}

function playerGroupLabel(state, roundIndex, playerId) {
  const player = state?.players?.[playerId];
  if (!player) return "";
  const teamId = String(player?.teamId || "").trim();
  if (!teamId) return String(player?.name || playerId || "").trim();

  const groupValue = Array.isArray(player?.groups)
    ? player.groups?.[roundIndex]
    : roundIndex === 0
      ? player?.group
      : null;
  const groupKey = String(groupValue || "").trim();
  if (!groupKey) return String(player?.name || playerId || "").trim();

  const names = Object.values(state?.players || {})
    .filter((candidate) => String(candidate?.teamId || "").trim() === teamId)
    .filter((candidate) => {
      const candidateGroup = Array.isArray(candidate?.groups)
        ? candidate.groups?.[roundIndex]
        : roundIndex === 0
          ? candidate?.group
          : null;
      return String(candidateGroup || "").trim() === groupKey;
    })
    .map((candidate) => String(candidate?.name || "").trim())
    .filter(Boolean);

  const unique = Array.from(new Set(names));
  return unique.length ? unique.join("/") : String(player?.name || playerId || "").trim();
}

function targetLabelForNotification(state, tournamentJson, roundIndex, details, targetId) {
  const roundCfg = state?.rounds?.[roundIndex] || {};
  const format = String(roundCfg?.format || "").toLowerCase();
  const normalizedTwoMan = normalizeTwoManFormat(format);
  const rawTargetId = String(targetId || "").trim();
  const player = state?.players?.[rawTargetId] || null;

  if (format === "scramble" || format === "team_best_ball") {
    const teamId = format === "team_best_ball" ? String(player?.teamId || "").trim() || rawTargetId : rawTargetId;
    return String(state?.teams?.[teamId]?.teamName || "").trim() || teamId || "Team";
  }

  if (normalizedTwoMan) {
    if (rawTargetId.includes("::")) {
      const [teamIdRaw, groupKeyRaw] = rawTargetId.split("::");
      const teamId = String(teamIdRaw || "").trim();
      const groupKey = String(groupKeyRaw || "").trim();
      const teamName = String(state?.teams?.[teamId]?.teamName || "").trim() || teamId || "Team";
      const groupName = playerGroupLabel(state, roundIndex, Object.values(state?.players || {}).find((p) => {
        const pid = String(p?.playerId || "").trim();
        if (!pid) return false;
        if (String(p?.teamId || "").trim() !== teamId) return false;
        const groupValue = Array.isArray(p?.groups) ? p.groups?.[roundIndex] : roundIndex === 0 ? p?.group : null;
        return String(groupValue || "").trim() === groupKey;
      })?.playerId);
      return groupName ? `${groupName}` : `${teamName} • Group ${groupKey || "?"}`;
    }
    return playerGroupLabel(state, roundIndex, rawTargetId) || String(state?.players?.[rawTargetId]?.name || "").trim() || rawTargetId || "Group";
  }

  return String(state?.players?.[rawTargetId]?.name || "").trim() || rawTargetId || "Player";
}

function rowForNotification(state, tournamentJson, roundIndex, details, targetId) {
  const roundCfg = state?.rounds?.[roundIndex] || {};
  const format = String(roundCfg?.format || "").toLowerCase();
  const normalizedTwoMan = normalizeTwoManFormat(format);
  const rawTargetId = String(targetId || "").trim();
  const player = state?.players?.[rawTargetId] || null;
  const roundData = tournamentJson?.score_data?.rounds?.[roundIndex] || {};

  if (format === "scramble" || format === "team_best_ball") {
    const teamId = format === "team_best_ball" ? String(player?.teamId || "").trim() || rawTargetId : rawTargetId;
    return roundData?.leaderboard?.teams?.find((row) => String(row?.teamId || "").trim() === teamId)
      || roundData?.team?.[teamId]
      || null;
  }

  if (normalizedTwoMan) {
    if (rawTargetId.includes("::")) {
      const [teamIdRaw, groupKeyRaw] = rawTargetId.split("::");
      const teamId = String(teamIdRaw || "").trim();
      const groupKey = String(groupKeyRaw || "").trim();
      return roundData?.team?.[teamId]?.groups?.[groupKey]
        || roundData?.team?.[teamId]
        || null;
    }
    const player = state?.players?.[rawTargetId];
    const teamId = String(player?.teamId || "").trim();
    const groupValue = Array.isArray(player?.groups)
      ? player.groups?.[roundIndex]
      : roundIndex === 0
        ? player?.group
        : null;
    const groupKey = String(groupValue || "").trim();
    if (teamId && groupKey) {
      return roundData?.team?.[teamId]?.groups?.[groupKey]
        || roundData?.team?.[teamId]
        || roundData?.leaderboard?.players?.find((row) => String(row?.playerId || "").trim() === rawTargetId)
        || null;
    }
    return roundData?.leaderboard?.players?.find((row) => String(row?.playerId || "").trim() === rawTargetId)
      || null;
  }

  return roundData?.leaderboard?.players?.find((row) => String(row?.playerId || "").trim() === rawTargetId)
    || roundData?.player?.[rawTargetId]
    || null;
}

function scoreUpdateSummary(state, details) {
  const roundIndex = Number(details?.roundIndex);
  const actorName = String(state?.players?.[details?.actorPlayerId]?.name || "A player").trim() || "A player";
  if (!Number.isInteger(roundIndex) || roundIndex < 0) {
    return {
      title: String(state?.tournament?.name || "Golf Tournament").trim() || "Golf Tournament",
      body: `Scores updated by ${actorName}`,
      url: `./scoreboard.html?t=${encodeURIComponent(String(state?.tournament?.tournamentId || "").trim())}`,
      tag: `golf-score-${String(state?.tournament?.tournamentId || "").trim()}-x-bulk`
    };
  }

  const tournamentJson = materializePublicFromState(state);
  const items = scoreNotificationItems(state, tournamentJson, details);
  const holeIndex = Number.isInteger(Number(details?.holeIndex)) ? Number(details.holeIndex) : null;
  const body = items.length
    ? `Round ${roundIndex + 1} | ${items.join(" • ")}`
    : `${scoreNotifierRoundLabel(roundIndex)} scores updated by ${actorName}`;
  return {
    title: String(state?.tournament?.name || "Golf Tournament").trim() || "Golf Tournament",
    body,
    url: `./scoreboard.html?t=${encodeURIComponent(String(state?.tournament?.tournamentId || "").trim())}`,
    tag: `golf-score-${String(state?.tournament?.tournamentId || "").trim()}-${roundIndex}-${String(details?.mode || "bulk").trim().toLowerCase()}-${holeIndex != null ? holeIndex : "bulk"}`
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
