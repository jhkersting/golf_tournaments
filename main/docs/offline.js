const DB_NAME = "golf-offline";
const DB_VERSION = 1;
const STORE_JSON_CACHE = "json_cache";
const STORE_SCORE_QUEUE = "score_queue";

let dbPromise = null;

function canUseIndexedDb() {
  return typeof indexedDB !== "undefined";
}

function cloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

async function withStore(storeName, mode, worker) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let workerDone = false;
    let workerResult = null;
    let settled = false;

    function finish(handler, value) {
      if (settled) return;
      settled = true;
      handler(value);
    }

    function maybeResolve() {
      if (!workerDone || settled) return;
      if (mode === "readonly") {
        finish(resolve, workerResult);
      }
    }

    tx.oncomplete = () => {
      if (mode === "readwrite") {
        finish(resolve, workerResult);
      } else {
        maybeResolve();
      }
    };
    tx.onerror = () => finish(reject, tx.error || new Error(`IndexedDB transaction failed for ${storeName}`));
    tx.onabort = () => finish(reject, tx.error || new Error(`IndexedDB transaction aborted for ${storeName}`));

    Promise.resolve()
      .then(() => worker(store))
      .then((result) => {
        workerResult = result;
        workerDone = true;
        maybeResolve();
      })
      .catch((error) => {
        try {
          tx.abort();
        } catch (_) {}
        finish(reject, error);
      });
  });
}

async function openDb() {
  if (!canUseIndexedDb()) return null;
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_JSON_CACHE)) {
          db.createObjectStore(STORE_JSON_CACHE, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(STORE_SCORE_QUEUE)) {
          db.createObjectStore(STORE_SCORE_QUEUE, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Failed to open offline database"));
    }).catch((error) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

function nowMs() {
  return Date.now();
}

function safeRandomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `q_${nowMs()}_${Math.random().toString(36).slice(2, 10)}`;
}

function cacheRecordKey(key) {
  const normalized = String(key || "").trim();
  return normalized ? `static:${normalized}` : "";
}

function normalizeRoundFormat(format) {
  const raw = String(format || "").trim().toLowerCase();
  if (raw === "two_man") return "two_man_scramble";
  if (raw === "two_man_scramble" || raw === "two_man_shamble" || raw === "two_man_best_ball") return raw;
  return raw;
}

function targetTypeForRound(round) {
  const fmt = normalizeRoundFormat(round?.format);
  if (fmt === "scramble") return "team";
  if (fmt === "two_man_scramble") return "group";
  return "player";
}

function normalizeScoreArray(arr) {
  const source = Array.isArray(arr) ? arr : [];
  return Array.from({ length: 18 }, (_, idx) => {
    const value = source[idx];
    const numberValue = Number(value);
    return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
  });
}

function ensureRoundScoreEntry(container, key) {
  if (!container[key]) {
    container[key] = {
      gross: Array(18).fill(null),
    };
  }
  if (!Array.isArray(container[key].gross)) {
    container[key].gross = Array(18).fill(null);
  }
  container[key].gross = normalizeScoreArray(container[key].gross);
  return container[key];
}

function splitGroupId(groupId) {
  const raw = String(groupId || "").trim();
  if (!raw) return { teamId: "", label: "" };
  const [teamId, label] = raw.split("::");
  return {
    teamId: String(teamId || "").trim(),
    label: String(label || "").trim(),
  };
}

function applyHoleEntry(gross, holeIndex, strokes) {
  if (!Array.isArray(gross) || holeIndex < 0 || holeIndex > 17) return;
  const value = Number(strokes);
  gross[holeIndex] = Number.isFinite(value) && value > 0 ? value : null;
}

function applyBulkEntry(gross, holes) {
  if (!Array.isArray(gross) || !Array.isArray(holes)) return;
  for (let idx = 0; idx < 18; idx += 1) {
    const value = holes[idx];
    const numberValue = Number(value);
    if (Number.isFinite(numberValue) && numberValue > 0) {
      gross[idx] = numberValue;
    }
  }
}

function applyPayloadToTournament(tournamentJson, payload) {
  if (!tournamentJson || typeof tournamentJson !== "object" || !payload) return tournamentJson;
  const roundIndex = Number(payload.roundIndex);
  if (!Number.isInteger(roundIndex) || roundIndex < 0) return tournamentJson;
  const rounds = tournamentJson?.tournament?.rounds || [];
  const roundConfig = rounds[roundIndex] || {};
  const targetType = targetTypeForRound(roundConfig);
  const scoreData = tournamentJson.score_data || { rounds: [] };
  tournamentJson.score_data = scoreData;
  if (!Array.isArray(scoreData.rounds)) scoreData.rounds = [];
  const roundScore = scoreData.rounds[roundIndex] || { team: {}, player: {}, leaderboard: { teams: [], players: [] } };
  scoreData.rounds[roundIndex] = roundScore;
  roundScore.team = roundScore.team || {};
  roundScore.player = roundScore.player || {};

  const mode = String(payload.mode || "").trim().toLowerCase() || (payload.holeIndex != null ? "hole" : "bulk");
  const entries = Array.isArray(payload.entries) ? payload.entries : [];

  if (targetType === "group") {
    for (const entry of entries) {
      const groupId = String(entry?.targetId || "").trim();
      const { teamId, label } = splitGroupId(groupId);
      if (!teamId || !label) continue;
      const teamEntry = roundScore.team[teamId] || { groups: {} };
      roundScore.team[teamId] = teamEntry;
      teamEntry.groups = teamEntry.groups || {};
      const groupEntry = teamEntry.groups[label] || { groupId, label: `Group ${label}`, gross: Array(18).fill(null) };
      teamEntry.groups[label] = groupEntry;
      groupEntry.groupId = groupId;
      groupEntry.gross = normalizeScoreArray(groupEntry.gross);
      if (mode === "hole") {
        applyHoleEntry(groupEntry.gross, Number(payload.holeIndex), entry?.strokes);
      } else {
        applyBulkEntry(groupEntry.gross, entry?.holes);
      }
    }
    return tournamentJson;
  }

  const container = targetType === "team" ? roundScore.team : roundScore.player;
  for (const entry of entries) {
    const targetId = String(entry?.targetId || "").trim();
    if (!targetId) continue;
    const scoreEntry = ensureRoundScoreEntry(container, targetId);
    if (mode === "hole") {
      applyHoleEntry(scoreEntry.gross, Number(payload.holeIndex), entry?.strokes);
    } else {
      applyBulkEntry(scoreEntry.gross, entry?.holes);
    }
  }
  return tournamentJson;
}

function matchesFilter(record, filter = {}) {
  if (!record) return false;
  if (filter.tid && String(record.tid || "") !== String(filter.tid)) return false;
  if (filter.code && String(record.code || "") !== String(filter.code)) return false;
  if (filter.signature && String(record.signature || "") !== String(filter.signature)) return false;
  if (Array.isArray(filter.statuses) && filter.statuses.length && !filter.statuses.includes(record.status)) return false;
  return true;
}

function submissionSignature({ tid, code, payload }) {
  const roundIndex = Number(payload?.roundIndex);
  const mode = String(payload?.mode || "").trim().toLowerCase() || (payload?.holeIndex != null ? "hole" : "bulk");
  const holeIndex = mode === "hole" ? Number(payload?.holeIndex) : "bulk";
  return [
    String(tid || "").trim(),
    String(code || "").trim().toUpperCase(),
    Number.isInteger(roundIndex) ? roundIndex : "",
    mode,
    holeIndex,
  ].join("|");
}

async function getAllRecords(storeName) {
  return (await withStore(storeName, "readonly", (store) => requestToPromise(store.getAll()))) || [];
}

async function putRecord(storeName, value) {
  return withStore(storeName, "readwrite", (store) => requestToPromise(store.put(value)));
}

async function deleteRecord(storeName, key) {
  return withStore(storeName, "readwrite", (store) => requestToPromise(store.delete(key)));
}

export function isNetworkFailure(error) {
  return !Number.isFinite(Number(error?.status));
}

export async function readCachedJson(cacheKey) {
  const key = cacheRecordKey(cacheKey);
  if (!key) return null;
  const record = await withStore(STORE_JSON_CACHE, "readonly", (store) => requestToPromise(store.get(key)));
  return record?.payload != null ? cloneJson(record.payload) : null;
}

export async function writeCachedJson(cacheKey, payload) {
  const key = cacheRecordKey(cacheKey);
  if (!key || payload == null) return;
  await putRecord(STORE_JSON_CACHE, {
    key,
    payload: cloneJson(payload),
    updatedAt: nowMs(),
  });
}

export async function getPendingScoreSubmissions(filter = {}) {
  const records = await getAllRecords(STORE_SCORE_QUEUE);
  return records
    .filter((record) => matchesFilter(record, filter))
    .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
}

export async function getPendingScoreSummary(filter = {}) {
  const records = await getPendingScoreSubmissions(filter);
  let pendingCount = 0;
  let conflictCount = 0;
  for (const record of records) {
    if (record.status === "pending") pendingCount += 1;
    else if (record.status === "conflict") conflictCount += 1;
  }
  return {
    pendingCount,
    conflictCount,
    totalCount: records.length,
  };
}

export async function clearPendingScoreSubmissionsMatching({ tid, code, payload }) {
  const signature = submissionSignature({ tid, code, payload });
  const records = await getPendingScoreSubmissions({ tid, code });
  await Promise.all(
    records
      .filter((record) => record.signature === signature)
      .map((record) => deleteRecord(STORE_SCORE_QUEUE, record.id))
  );
}

export async function enqueuePendingScoreSubmission({ tid, code, payload }) {
  const normalizedTid = String(tid || "").trim();
  const normalizedCode = String(code || "").trim().toUpperCase();
  if (!normalizedTid || !normalizedCode || !payload) {
    throw new Error("Missing score queue payload");
  }

  const signature = submissionSignature({ tid: normalizedTid, code: normalizedCode, payload });
  const existing = await getPendingScoreSubmissions({ tid: normalizedTid, code: normalizedCode });
  const matching = existing.find((record) => record.signature === signature);
  const record = {
    id: matching?.id || safeRandomId(),
    tid: normalizedTid,
    code: normalizedCode,
    signature,
    status: "pending",
    payload: cloneJson(payload),
    createdAt: matching?.createdAt || nowMs(),
    updatedAt: nowMs(),
    lastError: "",
    lastAttemptAt: matching?.lastAttemptAt || 0,
  };
  await putRecord(STORE_SCORE_QUEUE, record);
  return record;
}

export async function flushPendingScoreSubmissions({ tid, code, sendScore }) {
  if (typeof sendScore !== "function") {
    throw new Error("sendScore is required");
  }
  const items = await getPendingScoreSubmissions({
    tid,
    code,
    statuses: ["pending"],
  });

  let syncedCount = 0;
  let conflictCount = 0;
  let failedCount = 0;

  for (const item of items) {
    try {
      await sendScore(cloneJson(item.payload));
      await deleteRecord(STORE_SCORE_QUEUE, item.id);
      syncedCount += 1;
    } catch (error) {
      const nextRecord = {
        ...item,
        updatedAt: nowMs(),
        lastAttemptAt: nowMs(),
        lastError: String(error?.message || error || ""),
      };
      if (error?.status === 409) {
        nextRecord.status = "conflict";
        await putRecord(STORE_SCORE_QUEUE, nextRecord);
        conflictCount += 1;
        continue;
      }
      await putRecord(STORE_SCORE_QUEUE, nextRecord);
      failedCount += 1;
      if (isNetworkFailure(error)) break;
    }
  }

  return {
    syncedCount,
    conflictCount,
    failedCount,
    ...(await getPendingScoreSummary({ tid, code })),
  };
}

export async function applyPendingScoreSubmissionsToTournament(tournamentJson, { tid, code } = {}) {
  if (!tournamentJson || typeof tournamentJson !== "object") return tournamentJson;
  const tournamentId = String(tid || tournamentJson?.tournament?.tournamentId || "").trim();
  if (!tournamentId) return tournamentJson;
  const pending = await getPendingScoreSubmissions({
    tid: tournamentId,
    code,
    statuses: ["pending"],
  });
  if (!pending.length) return tournamentJson;
  const nextJson = cloneJson(tournamentJson);
  for (const record of pending) {
    applyPayloadToTournament(nextJson, record.payload);
  }
  return nextJson;
}
