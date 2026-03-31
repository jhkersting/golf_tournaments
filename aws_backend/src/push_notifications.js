import webpush from "web-push";
import {
  json,
  parseBody,
  getJson,
  materializePublicFromState,
  updateStateWithRetry,
  appendEvent,
  writePublicObjectsFromState,
  normalizeChatMessageText,
  trimChatMessages
} from "./utils.js";

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
  if (diffToPar === 2) return "Dbl. Bogey";
  if (diffToPar === 3) return "Tpl. Bogey";
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

function scoreNotifierSignedToPar(value) {
  if (value == null || value === "") return "";
  const n = Number(value);
  if (Number.isFinite(n)) {
    if (n === 0) return "E";
    return n > 0 ? `+${n}` : String(n);
  }
  const text = String(value).trim();
  if (!text) return "";
  if (text === "0") return "E";
  return text;
}

function scoreNotifierToParText(row, useHandicap) {
  if (!row) return "";
  const scores = row?.scores || {};
  if (useHandicap) {
    const gross = scores?.grossToParTotal ?? row?.grossToParTotal ?? row?.grossToPar ?? null;
    const net = scores?.netToParTotal ?? row?.netToParTotal ?? row?.netToPar ?? null;
    if (gross != null && net != null) {
      return `${scoreNotifierSignedToPar(gross)} [${scoreNotifierSignedToPar(net)}]`;
    }
  }
  const single =
    row?.toPar
    ?? scores?.toPar
    ?? row?.netToParTotal
    ?? row?.grossToParTotal
    ?? scores?.netToParTotal
    ?? scores?.grossToParTotal;
  return scoreNotifierSignedToPar(single);
}

function normalizedScoreNotificationBody(roundIndex, name, result, toPar, thru) {
  const roundLabel = scoreNotifierRoundLabel(roundIndex);
  const safeName = String(name || "").trim() || "Player";
  const safeResult = String(result || "Par").trim() || "Par";
  const safeToPar = String(toPar || "E").trim() || "E";
  const safeThru = String(thru || "0").trim() || "0";
  return `${roundLabel} • ${safeName} • ${safeResult} (${safeToPar}) Thru ${safeThru}`;
}

function notificationTargetKey(state, roundIndex, targetId) {
  const roundCfg = state?.rounds?.[roundIndex] || {};
  const format = String(roundCfg?.format || "").toLowerCase();
  const normalizedTwoMan = normalizeTwoManFormat(format);
  const rawTargetId = String(targetId || "").trim();
  const player = state?.players?.[rawTargetId] || null;

  if (format === "scramble") return rawTargetId;

  if (normalizedTwoMan) {
    if (rawTargetId.includes("::")) return rawTargetId;
    const teamId = String(player?.teamId || "").trim();
    const groupValue = Array.isArray(player?.groups)
      ? player.groups?.[roundIndex]
      : roundIndex === 0
        ? player?.group
        : null;
    const groupKey = String(groupValue || "").trim();
    if (teamId && groupKey) return `${teamId}::${groupKey}`;
  }

  return rawTargetId;
}

function normalizeGroupKey(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function playerGroupForRound(player, roundIndex) {
  if (!player) return "";
  if (Array.isArray(player?.groups)) {
    const value = normalizeGroupKey(player.groups?.[roundIndex]);
    if (value) return value;
  }
  if (roundIndex === 0) {
    const fallback = normalizeGroupKey(player?.group);
    if (fallback) return fallback;
  }
  return "";
}

function uniqueDisplayNames(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const name = String(value || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function teamNameForId(state, tournamentJson, teamId) {
  const targetId = String(teamId || "").trim();
  if (!targetId) return "";
  const fromState = String(state?.teams?.[targetId]?.teamName || "").trim();
  if (fromState) return fromState;
  const fromTournament = (tournamentJson?.teams || []).find((team) => String(team?.teamId ?? team?.id ?? "").trim() === targetId);
  return String(fromTournament?.teamName ?? fromTournament?.name ?? "").trim() || targetId;
}

function playerNameForId(state, tournamentJson, playerId) {
  const targetId = String(playerId || "").trim();
  if (!targetId) return "";
  const fromState = String(state?.players?.[targetId]?.name || "").trim();
  if (fromState) return fromState;
  const fromTournament = (tournamentJson?.players || []).find((player) => String(player?.playerId || "").trim() === targetId);
  return String(fromTournament?.name || "").trim() || targetId;
}

function playerIdsForTwoManGroup(state, tournamentJson, teamId, roundIndex, groupKey) {
  const safeTeamId = String(teamId || "").trim();
  const safeGroupKey = normalizeGroupKey(groupKey);
  if (!safeTeamId || !safeGroupKey) return [];

  const teamDef = (tournamentJson?.teams || []).find((team) => String(team?.teamId ?? team?.id ?? "").trim() === safeTeamId);
  const fromTeamDef = teamDef?.groupsByRound?.[String(roundIndex)]?.[safeGroupKey] || teamDef?.groups?.[safeGroupKey];
  if (Array.isArray(fromTeamDef) && fromTeamDef.length) {
    return Array.from(new Set(fromTeamDef.map((id) => String(id || "").trim()).filter(Boolean)));
  }

  const fromTournamentPlayers = (tournamentJson?.players || [])
    .filter((player) => String(player?.teamId || "").trim() === safeTeamId)
    .filter((player) => playerGroupForRound(player, roundIndex) === safeGroupKey)
    .map((player) => String(player?.playerId || "").trim())
    .filter(Boolean);
  if (fromTournamentPlayers.length) return Array.from(new Set(fromTournamentPlayers));

  return Array.from(new Set(
    Object.entries(state?.players || {})
      .filter(([, player]) => String(player?.teamId || "").trim() === safeTeamId)
      .filter(([, player]) => playerGroupForRound(player, roundIndex) === safeGroupKey)
      .map(([playerId]) => String(playerId || "").trim())
      .filter(Boolean)
  ));
}

function twoManPairLabel(state, tournamentJson, teamId, roundIndex, groupKey) {
  const playerIds = playerIdsForTwoManGroup(state, tournamentJson, teamId, roundIndex, groupKey);
  const names = uniqueDisplayNames(playerIds.map((playerId) => playerNameForId(state, tournamentJson, playerId)));
  if (names.length) return names.join("/");
  const safeGroupKey = normalizeGroupKey(groupKey);
  return safeGroupKey ? `Group ${safeGroupKey}` : "Pair";
}

function findTwoManGroupEntry(roundData, teamId, groupKey) {
  const groups = roundData?.team?.[String(teamId || "").trim()]?.groups || {};
  const wanted = normalizeGroupKey(groupKey);
  for (const [rawKey, entry] of Object.entries(groups)) {
    if (normalizeGroupKey(rawKey) === wanted) return entry || null;
  }
  return null;
}

function grossScoreForHole(row, holeIndex) {
  const idx = Number(holeIndex);
  if (!Number.isInteger(idx) || idx < 0) return null;
  const value = row?.scores?.gross?.[idx] ?? row?.gross?.[idx] ?? null;
  const gross = Number(value);
  return Number.isFinite(gross) && gross > 0 ? gross : null;
}

function parForHole(row, pars, holeIndex) {
  const idx = Number(holeIndex);
  if (!Number.isInteger(idx) || idx < 0) return Number(pars?.[idx] || 0);
  const value = row?.scores?.par?.[idx] ?? row?.par?.[idx] ?? pars?.[idx] ?? 0;
  const par = Number(value);
  return Number.isFinite(par) && par > 0 ? par : 0;
}

function thruForRow(row) {
  return scoreNotifierThruText(row?.thru ?? row?.scores?.thru);
}

function notificationTargetMeta(state, tournamentJson, roundIndex, targetId) {
  const roundCfg = state?.rounds?.[roundIndex] || {};
  const roundData = tournamentJson?.score_data?.rounds?.[roundIndex] || {};
  const format = String(roundCfg?.format || "").toLowerCase();
  const normalizedTwoMan = normalizeTwoManFormat(format);
  const rawTargetId = String(targetId || "").trim();
  if (!rawTargetId) return null;

  if (format === "scramble") {
    const teamId = rawTargetId;
    return {
      targetId: teamId,
      row: roundData?.leaderboard?.teams?.find((row) => String(row?.teamId || "").trim() === teamId)
        || roundData?.team?.[teamId]
        || null,
      name: teamNameForId(state, tournamentJson, teamId) || teamId || "Team"
    };
  }

  if (normalizedTwoMan) {
    let teamId = "";
    let groupKey = "";
    if (rawTargetId.includes("::")) {
      const [teamIdRaw, groupKeyRaw] = rawTargetId.split("::");
      teamId = String(teamIdRaw || "").trim();
      groupKey = normalizeGroupKey(groupKeyRaw);
    } else {
      const player = state?.players?.[rawTargetId] || null;
      teamId = String(player?.teamId || "").trim();
      groupKey = playerGroupForRound(player, roundIndex);
    }
    if (teamId && groupKey) {
      return {
        targetId: `${teamId}::${groupKey}`,
        row: findTwoManGroupEntry(roundData, teamId, groupKey),
        name: twoManPairLabel(state, tournamentJson, teamId, roundIndex, groupKey)
      };
    }
  }

  return {
    targetId: rawTargetId,
    row: roundData?.leaderboard?.players?.find((row) => String(row?.playerId || "").trim() === rawTargetId)
      || roundData?.player?.[rawTargetId]
      || null,
    name: playerNameForId(state, tournamentJson, rawTargetId) || rawTargetId || "Player"
  };
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

const CHAT_MESSAGE_LIMIT = 240;
const CHAT_HISTORY_LIMIT = 100;
const DEFAULT_CHAT_PROFANITY_WORDS = [
  "asshole",
  "bastard",
  "bitch",
  "bullshit",
  "cock",
  "cunt",
  "douchebag",
  "fuck",
  "motherfucker",
  "shit",
];

function normalizeChatText(raw) {
  return normalizeChatMessageText(raw, { maxLength: CHAT_MESSAGE_LIMIT });
}

function normalizeChatFilterText(raw) {
  return String(raw || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[0-9@!$*]+/g, (match) => {
      const map = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "!": "i", "$": "s", "*": "" };
      return match.split("").map((char) => map[char] ?? char).join("");
    })
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function chatProfanityWords() {
  const configured = String(process.env.CHAT_PROFANITY_WORDS || "").trim();
  const rawWords = configured
    ? configured.split(/[,;\n]+/)
    : DEFAULT_CHAT_PROFANITY_WORDS;
  return rawWords
    .map((word) => normalizeChatFilterText(word))
    .filter(Boolean);
}

function containsChatProfanity(text) {
  const normalized = normalizeChatFilterText(text);
  if (!normalized) return "";
  const collapsed = normalized.replace(/\s+/g, "");
  const tokens = new Set(normalized.split(/\s+/).filter(Boolean));
  for (const word of chatProfanityWords()) {
    if (tokens.has(word) || collapsed.includes(word)) {
      return word;
    }
  }
  return "";
}

export function validateChatMessageText(raw) {
  const text = normalizeChatText(raw);
  const profanity = containsChatProfanity(text);
  if (profanity) {
    const err = new Error("Message contains language not allowed.");
    err.statusCode = 400;
    err.code = "PROFANITY";
    throw err;
  }
  return text;
}

function chatMessageLabel(playerName, teamName) {
  const safeName = String(playerName || "").trim() || "Player";
  const safeTeam = String(teamName || "").trim();
  return safeTeam ? `${safeName} • ${safeTeam}` : safeName;
}

function chatNotificationBody(entry) {
  const sender = chatMessageLabel(entry?.playerName, entry?.teamName);
  const message = String(entry?.message || "").trim() || "New message";
  const body = `${sender}: ${message}`;
  return body.length > 180 ? `${body.slice(0, 177).trimEnd()}…` : body;
}

export function chatNotificationSummaries(state, details) {
  const tid = String(state?.tournament?.tournamentId || "").trim();
  if (!tid) return [];
  const messageId = String(details?.messageId || "").trim();
  const entry = details?.entry || details;
  const body = chatNotificationBody(entry);
  const title = String(state?.tournament?.name || "Golf Tournament").trim() || "Golf Tournament";
  return [{
    title,
    body,
    url: `./enter.html?t=${encodeURIComponent(tid)}`,
    tag: `golf-chat-${tid}-${messageId || String(entry?.createdAt || Date.now())}`
  }];
}

async function notifyChatSubscribers(tid, state, details = {}) {
  if (!ensureWebPushConfigured()) {
    return { skipped: true, reason: "push notifications are not configured" };
  }

  const subscriptions = dedupeSubscriptions(Object.values(state?.pushSubscriptions || {}));
  if (!subscriptions.length) {
    return { skipped: true, reason: "no subscriptions" };
  }

  const summaries = dedupeNotificationSummaries(chatNotificationSummaries(state, details));
  if (!summaries.length) {
    return { skipped: true, reason: "no notifications" };
  }

  const payload = JSON.stringify({
    ...summaries[0],
    tid: String(tid || "").trim(),
    mode: "chat",
    messageId: String(details?.messageId || "").trim(),
    createdAt: Number(details?.createdAt || Date.now())
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
          console.warn("Chat push notification failed:", error?.statusCode || error?.message || error);
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

export function scoreNotificationEntries(state, tournamentJson, details) {
  const roundIndex = Number(details?.roundIndex);
  if (!Number.isInteger(roundIndex) || roundIndex < 0) return [];

  const roundCfg = state?.rounds?.[roundIndex] || {};
  const useHandicap = !!roundCfg?.useHandicap;
  const pars = scoreNotifierCoursePars(tournamentJson, roundIndex);
  const changedScores = Array.isArray(details?.changedScores) ? details.changedScores : [];
  const seen = new Set();
  const notifications = [];

  for (const change of changedScores) {
    const holeIndex = Number(change?.holeIndex);
    if (!Number.isInteger(holeIndex) || holeIndex < 0 || holeIndex > 17) continue;

    const rawTargetId = String(change?.targetId || "").trim();
    const normalizedTargetId = notificationTargetKey(state, roundIndex, rawTargetId);
    const dedupeKey = `${normalizedTargetId}::${holeIndex}`;
    if (!normalizedTargetId || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const meta = notificationTargetMeta(state, tournamentJson, roundIndex, normalizedTargetId);
    if (!meta?.targetId || !meta?.row) continue;

    const grossScore = grossScoreForHole(meta.row, holeIndex);
    if (grossScore == null) continue;

    const par = parForHole(meta.row, pars, holeIndex);
    const diffToPar = par > 0 ? grossScore - par : 0;
    const result = scoreResultLabel(diffToPar);
    const toPar = scoreNotifierToParText(meta.row, useHandicap) || "E";
    const thru = thruForRow(meta.row) || "0";

    notifications.push({
      targetId: meta.targetId,
      holeIndex,
      body: normalizedScoreNotificationBody(roundIndex, meta.name, result, toPar, thru)
    });
  }

  return notifications;
}

export function scoreUpdateSummaries(state, details) {
  const roundIndex = Number(details?.roundIndex);
  const tournamentId = String(state?.tournament?.tournamentId || "").trim();
  const title = String(state?.tournament?.name || "Golf Tournament").trim() || "Golf Tournament";
  const url = `./scoreboard.html?t=${encodeURIComponent(tournamentId)}`;
  const mode = String(details?.mode || "bulk").trim().toLowerCase();

  if (!Number.isInteger(roundIndex) || roundIndex < 0) return [];

  const tournamentJson = materializePublicFromState(state);
  const notifications = scoreNotificationEntries(state, tournamentJson, details);
  if (!notifications.length) return [];

  return notifications.map(({ targetId, holeIndex, body }, index) => ({
    title,
    body,
    url,
    tag: `golf-score-${tournamentId}-${roundIndex}-${mode}-${holeIndex}-${String(targetId || index).replace(/[^a-z0-9_-]+/gi, "-")}`
  }));
}

function isGoneError(error) {
  const status = Number(error?.statusCode || error?.status || error?.$metadata?.httpStatusCode || 0);
  return status === 404 || status === 410;
}

function dedupeSubscriptions(subscriptions) {
  const byPlayerId = new Map();
  const anonymous = [];

  for (const subscription of subscriptions || []) {
    if (!subscription?.endpoint) continue;
    const playerId = String(subscription?.playerId || "").trim();
    if (!playerId) {
      anonymous.push(subscription);
      continue;
    }
    const existing = byPlayerId.get(playerId);
    const existingUpdatedAt = Number(existing?.updatedAt || existing?.subscribedAt || 0);
    const nextUpdatedAt = Number(subscription?.updatedAt || subscription?.subscribedAt || 0);
    if (!existing || nextUpdatedAt >= existingUpdatedAt) {
      byPlayerId.set(playerId, subscription);
    }
  }

  return [...byPlayerId.values(), ...anonymous];
}

function dedupeNotificationSummaries(summaries) {
  const seen = new Set();
  const out = [];

  for (const summary of summaries || []) {
    const key = String(summary?.tag || "").trim();
    if (!key.trim() || seen.has(key)) continue;
    seen.add(key);
    out.push(summary);
  }

  return out;
}

function makeChatMessageId(now = Date.now()) {
  const rand = Math.random().toString(36).slice(2, 10);
  return `chat_${now}_${rand}`;
}

function normalizeChatMessages(messages) {
  return trimChatMessages(Array.isArray(messages) ? messages : [], CHAT_HISTORY_LIMIT);
}

function chatResponsePayload(state) {
  return {
    ok: true,
    messages: normalizeChatMessages(state?.chatMessages || [])
  };
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
    for (const [endpoint, existing] of Object.entries(state.pushSubscriptions)) {
      if (endpoint === safeSubscription.endpoint) continue;
      const existingPlayerId = String(existing?.playerId || "").trim();
      if (existingPlayerId && existingPlayerId === actor.playerId) {
        delete state.pushSubscriptions[endpoint];
      }
    }
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

async function getChatMessages(tid, code) {
  const bucket = process.env.STATE_BUCKET;
  const { json: current } = await getJson(bucket, `state/${tid}.json`);
  if (!current) {
    const err = new Error("tournament not found");
    err.statusCode = 404;
    throw err;
  }
  resolvePlayerMeta(current, code);
  return json(200, chatResponsePayload(current));
}

async function postChatMessage(tid, code, message) {
  const text = validateChatMessageText(message);
  const bucket = process.env.STATE_BUCKET;
  const { json: current } = await getJson(bucket, `state/${tid}.json`);
  if (!current) {
    const err = new Error("tournament not found");
    err.statusCode = 404;
    throw err;
  }
  const actor = resolvePlayerMeta(current, code);
  const now = Date.now();
  const entry = {
    messageId: makeChatMessageId(now),
    playerId: actor.playerId,
    playerName: actor.playerName,
    teamId: actor.teamId,
    teamName: teamNameForId(current, null, actor.teamId),
    message: text,
    createdAt: now
  };

  const nextState = await updateStateWithRetry(tid, (state) => {
    state.chatMessages = normalizeChatMessages([...(Array.isArray(state.chatMessages) ? state.chatMessages : []), entry]);
    state.updatedAt = now;
    state.version = Number(state.version || 0) + 1;
    return state;
  });

  await writePublicObjectsFromState(nextState);
  try {
    await appendEvent(tid, {
      type: "chat_message",
      tid,
      ts: now,
      ...entry
    });
  } catch (error) {
    console.warn("Chat event logging failed:", error?.statusCode || error?.message || error);
  }
  await notifyChatSubscribers(tid, nextState, { entry });

  return json(200, {
    ok: true,
    message: entry,
    messages: normalizeChatMessages(nextState?.chatMessages || [])
  });
}

export async function notifyScoreSubscribers(tid, state, details = {}) {
  if (!ensureWebPushConfigured()) {
    return { skipped: true, reason: "push notifications are not configured" };
  }

  const subscriptions = dedupeSubscriptions(Object.values(state?.pushSubscriptions || {}));
  if (!subscriptions.length) {
    return { skipped: true, reason: "no subscriptions" };
  }

  const summaries = dedupeNotificationSummaries(scoreUpdateSummaries(state, details));
  if (!summaries.length) {
    return { skipped: true, reason: "no notifications" };
  }
  const payloads = summaries.map((summary) => JSON.stringify({
    ...summary,
    tid: String(tid || "").trim(),
    roundIndex: Number(details?.roundIndex),
    mode: String(details?.mode || "bulk").trim().toLowerCase(),
    holeIndex: Number.isInteger(Number(details?.holeIndex)) ? Number(details.holeIndex) : null
  }));

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
        for (const payload of payloads) {
          await webpush.sendNotification(cleanSubscription, payload, { TTL: 3600 });
          delivered += 1;
        }
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

    if (path.endsWith("/chat")) {
      if (method === "GET") {
        const code = String(event?.queryStringParameters?.code || body?.code || "").trim();
        return await getChatMessages(tid, code);
      }
      if (method === "POST") {
        return await postChatMessage(tid, body.code, body.message ?? body.text);
      }
    }

    return json(404, { error: "unknown push route" });
  } catch (error) {
    return json(error?.statusCode || 500, { error: error?.message || "Server error" });
  }
}
