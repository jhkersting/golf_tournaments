import { getJson, json, writeLiveOddsObjectFromState } from "./utils.js";

function decodeS3Key(rawKey){
  return decodeURIComponent(String(rawKey || "").replace(/\+/g, " "));
}

function tidFromStateKey(key){
  const normalized = String(key || "").trim();
  const match = normalized.match(/^state\/(.+)\.json$/);
  return match ? String(match[1] || "").trim() : "";
}

async function loadState(tid){
  const bucket = process.env.STATE_BUCKET;
  const key = `state/${tid}.json`;
  const { json: state } = await getJson(bucket, key);
  return state;
}

async function refreshTid(tid){
  if (!tid) return { tid, refreshed: false, reason: "missing_tid" };
  const state = await loadState(tid);
  if (!state) return { tid, refreshed: false, reason: "state_not_found" };
  await writeLiveOddsObjectFromState(state);
  return { tid, refreshed: true };
}

function tidsFromS3Event(event){
  const tids = new Set();
  for (const record of event?.Records || []) {
    const eventSource = String(record?.eventSource || "");
    if (eventSource !== "aws:s3") continue;
    const key = decodeS3Key(record?.s3?.object?.key || "");
    const tid = tidFromStateKey(key);
    if (tid) tids.add(tid);
  }
  return Array.from(tids);
}

export async function handler(event){
  try{
    const directTid =
      String(event?.tid || "").trim() ||
      String(event?.pathParameters?.tid || "").trim() ||
      "";
    const tids = directTid ? [directTid] : tidsFromS3Event(event);
    if (!tids.length) return json(200, { ok: true, refreshed: 0, items: [] });

    const items = [];
    for (const tid of tids) {
      items.push(await refreshTid(tid));
    }
    return json(200, {
      ok: true,
      refreshed: items.filter((item) => item.refreshed).length,
      items
    });
  } catch (error){
    return json(error?.statusCode || 500, { error: error?.message || String(error) });
  }
}
