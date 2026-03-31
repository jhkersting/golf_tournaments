import crypto from "crypto";
import zlib from "zlib";
import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { computeLiveOdds } from "./live_odds.js";
import { appendCompactLiveOddsHistory, compactLiveOddsPayload } from "./live_odds_compact.js";
import { normalizeCourseRecord } from "./course_data.js";
import { normalizeRoundMaxHoleScore } from "./round_rules.js";

export const s3 = new S3Client({});

export function json(statusCode, body, extraHeaders={}){
  return {
    statusCode,
    headers: {
      "Content-Type":"application/json",
      "Access-Control-Allow-Origin":"*",
      "Access-Control-Allow-Headers":"Content-Type,x-admin-key",
      "Access-Control-Allow-Methods":"GET,POST,OPTIONS",
      ...extraHeaders
    },
    body: JSON.stringify(body)
  };
}

export async function parseBody(event){
  if (!event?.body) return {};
  try { return JSON.parse(event.body); }
  catch { 
    const err = new Error("Invalid JSON body");
    err.statusCode = 400;
    throw err;
  }
}

export function requireAdmin(event){
  const want = process.env.ADMIN_KEY || "";
  if (!want) return; // allow if unset
  const got = event?.headers?.["x-admin-key"] || event?.headers?.["X-Admin-Key"] || event?.headers?.["X-ADMIN-KEY"];
  if (!got || got !== want){
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
}

export function uid(prefix="t"){
  const rand = crypto.randomBytes(8).toString("hex");
  return `${prefix}_${rand}`;
}

export function code4(){
  // human-friendly 4-6 chars; avoid ambiguous chars
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i=0;i<4;i++) out += alphabet[Math.floor(Math.random()*alphabet.length)];
  return out;
}

export function normalizeEditCode(raw){
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "");
}

export function makeEditCode(length = 8){
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const n = Math.max(6, Math.min(12, Math.floor(Number(length) || 8)));
  let out = "";
  for (let i = 0; i < n; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export function hashEditCode(code){
  const normalized = normalizeEditCode(code);
  return crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function requireTournamentEditCode(state, providedCode){
  const expected = String(state?.tournament?.editCodeHash || "").trim();
  // Legacy tournaments without edit code stay editable with admin key only.
  if (!expected) return;

  const normalized = normalizeEditCode(providedCode);
  if (!normalized){
    const err = new Error("missing edit code");
    err.statusCode = 401;
    throw err;
  }

  const actual = hashEditCode(normalized);
  if (actual.length !== expected.length){
    const err = new Error("invalid edit code");
    err.statusCode = 403;
    throw err;
  }
  const ok = crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  if (!ok){
    const err = new Error("invalid edit code");
    err.statusCode = 403;
    throw err;
  }
}

export function normalizeHoles(arr){
  if (!Array.isArray(arr) || arr.length !== 18) {
    const err = new Error("holes must be an array of length 18");
    err.statusCode = 400;
    throw err;
  }
  return arr.map((v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === "string" && v.trim() === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n)) {
      const err = new Error("hole scores must be numbers or blank");
      err.statusCode = 400;
      throw err;
    }
    const iv = Math.round(n);
    if (iv < 1 || iv > 20) {
      const err = new Error("hole scores must be between 1 and 20");
      err.statusCode = 400;
      throw err;
    }
    return iv;
  });
}

export function sumPlayed(arr){
  return arr.reduce((a,v)=>{
    if (v == null) return a;
    const n = Number(v);
    return Number.isFinite(n) ? a + n : a;
  },0);
}

export function thruFromHoles(arr){
  let last = -1;
  for (let i=0;i<arr.length;i++){
    const v = arr[i];
    if (v == null) continue;
    const n = Number(v);
    if (Number.isFinite(n)) last = i;
  }
  return last + 1;
}

export function toParStrFromDiff(diff){
  const d = Math.round(diff);
  if (d === 0) return "E";
  return d > 0 ? `+${d}` : `${d}`;
}

export function normalizeTournamentScoring(scoring){
  const raw = String(scoring || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (raw === "stableford") return "stableford";
  return "stroke";
}

export const CHAT_MESSAGE_MAX_LENGTH = 240;

export function normalizeChatMessageText(raw, { maxLength = CHAT_MESSAGE_MAX_LENGTH } = {}) {
  const limit = Math.max(1, Math.floor(Number(maxLength) || CHAT_MESSAGE_MAX_LENGTH));
  const text = String(raw ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n+/g, " ")
    .trim();
  if (!text) {
    const err = new Error("message is required");
    err.statusCode = 400;
    throw err;
  }
  return text.length > limit ? text.slice(0, limit).trimEnd() : text;
}

function grossHoleScoreOrNull(value){
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function netHoleScoreOrNull(value){
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

function stablefordPointsForHole(score, par){
  const scoreNum = netHoleScoreOrNull(score);
  if (scoreNum == null) return null;
  const parNum = Number(par);
  if (!Number.isFinite(parNum) || parNum <= 0) return null;
  return Math.max(0, 2 + parNum - scoreNum);
}

function stablefordPointsArray(scores, pars){
  return Array.from({ length: 18 }, (_, i) => stablefordPointsForHole(scores?.[i], pars?.[i]));
}

function sumHoleArrays(arrays){
  const out = Array(18).fill(null);
  for (let i = 0; i < 18; i++){
    let total = 0;
    let count = 0;
    for (const arr of arrays || []){
      const value = arr?.[i];
      if (value == null) continue;
      total += Number(value);
      count += 1;
    }
    out[i] = count > 0 ? total : null;
  }
  return out;
}

function selectEntriesByMetric(entries, metricKey, topX, direction = "low"){
  const clean = (entries || [])
    .filter((entry) => Number.isFinite(Number(entry?.[metricKey])));
  clean.sort((a, b) => {
    const delta = Number(a?.[metricKey]) - Number(b?.[metricKey]);
    if (delta !== 0) return direction === "high" ? -delta : delta;
    return Number(a?.grossTotal || 0) - Number(b?.grossTotal || 0);
  });
  return clean.slice(0, Math.min(Math.max(1, Math.round(Number(topX) || 1)), clean.length));
}

function buildScoreEntry(grossIn, netIn, handicapShotsIn, parIn){
  const gross = Array.from({ length: 18 }, (_, i) => {
    return grossHoleScoreOrNull(grossIn?.[i]);
  });
  const net = Array.from({ length: 18 }, (_, i) => {
    return netHoleScoreOrNull(netIn?.[i]);
  });
  const handicapShots = Array.from({ length: 18 }, (_, i) => {
    const n = Number(handicapShotsIn?.[i]);
    return Number.isFinite(n) ? n : 0;
  });
  const par = Array.from({ length: 18 }, (_, i) => {
    const n = Number(parIn?.[i]);
    return Number.isFinite(n) ? n : 0;
  });
  const grossToPar = gross.map((v, i) => v == null ? null : (Number(v) - Number(par[i] || 0)));
  const netToPar = net.map((v, i) => v == null ? null : (Number(v) - Number(par[i] || 0)));
  const grossStableford = stablefordPointsArray(gross, par);
  const netStableford = stablefordPointsArray(net, par);
  const grossTotal = sumPlayed(gross);
  const netTotal = sumPlayed(net);
  const thru = thruFromHoles(gross);
  return {
    gross,
    net,
    par,
    grossToPar,
    netToPar,
    grossStableford,
    netStableford,
    handicapShots,
    grossTotal,
    netTotal,
    grossToParTotal: sumPlayed(grossToPar),
    netToParTotal: sumPlayed(netToPar),
    grossStablefordTotal: sumPlayed(grossStableford),
    netStablefordTotal: sumPlayed(netStableford),
    thru
  };
}

// Handicap shots allocation (same as frontend)
export function strokesPerHole(handicap, strokeIndex18){
  const H = Math.max(0, Math.floor(Number(handicap) || 0));
  const base = Math.floor(H / 18);
  const rem = H % 18;
  const si = strokeIndex18.map(x => Number(x));
  return si.map(v => base + (v <= rem ? 1 : 0));
}

export function bestXAggregate(values, agg){
  let topX = Number(agg?.topX ?? 4);
  if (!Number.isFinite(topX) || topX <= 0) topX = 4;
  topX = Math.round(topX);
  const vals = values.filter(v => typeof v === "number" && Number.isFinite(v));
  if (!vals.length) return null;
  vals.sort((a,b)=>a-b);
  const take = vals.slice(0, Math.min(topX, vals.length));
  const s = take.reduce((a,b)=>a+b,0);
  return s / take.length;
}

export function bestXAggregateWithPar(pairs, agg){
  // pairs: [{strokes, par}]
  let topX = Number(agg?.topX ?? 4);
  if (!Number.isFinite(topX) || topX <= 0) topX = 4;
  topX = Math.round(topX);

  const clean = pairs
    .filter(p => p && typeof p.strokes === "number" && Number.isFinite(p.strokes) && typeof p.par === "number" && Number.isFinite(p.par))
    .sort((a,b)=>a.strokes - b.strokes);

  if (!clean.length) return null;
  const take = clean.slice(0, Math.min(topX, clean.length));
  const s = take.reduce((a,p)=>a+p.strokes,0);
  const par = take.reduce((a,p)=>a+p.par,0);
  return { strokes: s / take.length, par: par / take.length, n: take.length };
}

function bestXAggregateWithParSum(pairs, agg){
  let topX = Number(agg?.topX ?? 4);
  if (!Number.isFinite(topX) || topX <= 0) topX = 4;
  topX = Math.round(topX);

  const clean = pairs
    .filter(p => p && typeof p.strokes === "number" && Number.isFinite(p.strokes) && typeof p.par === "number" && Number.isFinite(p.par))
    .sort((a,b)=>a.strokes - b.strokes);

  if (!clean.length) return null;
  const take = clean.slice(0, Math.min(topX, clean.length));
  const s = take.reduce((a,p)=>a+p.strokes,0);
  const par = take.reduce((a,p)=>a+p.par,0);
  return { strokes: s, par, n: take.length };
}

function normalizeTeamAggregation(agg){
  let topX = Number(agg?.topX ?? 4);
  if (!Number.isFinite(topX) || topX <= 0) topX = 4;
  topX = Math.round(topX);
  const mode = String(agg?.mode || "avg").toLowerCase() === "sum" ? "sum" : "avg";
  return { mode, topX };
}

function aggregateValuesByMode(values, mode = "avg"){
  const clean = (values || []).filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!clean.length) return null;
  const total = clean.reduce((a, b) => a + b, 0);
  return mode === "sum" ? total : total / clean.length;
}

function cappedGroupHandicap(rawValue, lowestHandicap){
  const rounded = Math.max(0, Math.round(Number(rawValue) || 0));
  const cap = Math.max(0, Math.floor(Number(lowestHandicap) || 0));
  return Math.min(rounded, cap);
}

function scrambleTeamHandicap(teamPlayers){
  const vals = (teamPlayers || [])
    .map(p => Number(p?.handicap ?? 0))
    .filter(Number.isFinite)
    .map(v => Math.max(0, v))
    .sort((a, b) => a - b);
  if (!vals.length) return 0;
  const lowest = vals[0] || 0;
  const avg = vals.reduce((a,b)=>a+b,0) / vals.length;
  return cappedGroupHandicap(avg, lowest);
}

function effectiveHandicap(value, multiplier = 1){
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n * multiplier));
}

function twoManScrambleHandicap(groupPlayers){
  const vals = (groupPlayers || [])
    .map((player) => Number(player?.handicap ?? 0))
    .filter(Number.isFinite)
    .map((value) => Math.max(0, value))
    .sort((a, b) => a - b);
  if (!vals.length) return 0;
  const lower = vals[0] || 0;
  const upper = vals[1] ?? vals[0] ?? 0;
  return cappedGroupHandicap((lower * 0.35) + (upper * 0.15), lower);
}

function getPlayersByTeamMap(players){
  const byTeam = new Map();
  for (const pid of Object.keys(players || {})){
    const p = players[pid];
    if (!p?.teamId) continue;
    if (!byTeam.has(p.teamId)) byTeam.set(p.teamId, []);
    byTeam.get(p.teamId).push({ ...p, playerId: pid });
  }
  return byTeam;
}

function normalizeTwoManFormat(format){
  const fmt = String(format || "").toLowerCase();
  if (fmt === "two_man") return "two_man_scramble";
  if (fmt === "two_man_scramble" || fmt === "two_man_shamble" || fmt === "two_man_best_ball") return fmt;
  return "";
}

function isTwoManFormat(format){
  return !!normalizeTwoManFormat(format);
}

function isTwoManScrambleFormat(format){
  return normalizeTwoManFormat(format) === "two_man_scramble";
}

function isTwoManPlayerFormat(format){
  const fmt = normalizeTwoManFormat(format);
  return fmt === "two_man_shamble" || fmt === "two_man_best_ball";
}

function isTeamBestBallFormat(format){
  const fmt = String(format || "").toLowerCase();
  return fmt === "team_best_ball" || fmt === "team_bestball";
}

function defaultCourseObject(){
  return {
    pars: Array(18).fill(4),
    strokeIndex: Array.from({ length: 18 }, (_, i) => i + 1)
  };
}

function normalizeCourseObject(course){
  return normalizeCourseRecord(course);
}

function normalizeRoundCourseIndex(value, courseCount){
  const n = Number(value);
  const count = Math.max(1, Number(courseCount) || 1);
  if (!Number.isInteger(n) || n < 0 || n >= count) return 0;
  return n;
}

function normalizeCoursesFromState(state){
  const fromList = Array.isArray(state?.courses)
    ? state.courses.map((course) => normalizeCourseObject(course)).filter(Boolean)
    : [];
  if (fromList.length) return fromList;
  const legacy = normalizeCourseObject(state?.course);
  if (legacy) return [legacy];
  return [defaultCourseObject()];
}

function normalizeRoundsWithCourses(roundsIn, courseCount){
  const rounds = Array.isArray(roundsIn) ? roundsIn : [];
  return rounds.map((round) => ({
    ...(round || {}),
    maxHoleScore: normalizeRoundMaxHoleScore(round?.maxHoleScore),
    courseIndex: normalizeRoundCourseIndex(round?.courseIndex, courseCount)
  }));
}

function courseForRound(rounds, courses, roundIndex){
  const defaultCourse = courses[0] || defaultCourseObject();
  const idx = normalizeRoundCourseIndex(rounds?.[roundIndex]?.courseIndex, courses.length);
  return courses[idx] || defaultCourse;
}

function normalizeTwoManGroupLabel(value){
  const raw = String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return raw.slice(0, 16);
}

function groupValueForRound(player, roundIndex){
  const idx = Math.max(0, Math.floor(Number(roundIndex) || 0));
  if (Array.isArray(player?.groups)){
    const v = normalizeTwoManGroupLabel(player.groups[idx]);
    if (v) return v;
  }
  if (idx === 0){
    const fallback = normalizeTwoManGroupLabel(player?.group);
    if (fallback) return fallback;
  }
  return "";
}

function twoManGroupId(teamId, label){
  const team = String(teamId || "").trim();
  const group = normalizeTwoManGroupLabel(label);
  if (!team || !group) return "";
  return `${team}::${group}`;
}

function twoManGroupLabelFromIndex(idx){
  let n = Math.max(0, Math.floor(Number(idx) || 0));
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

function splitTwoManGroups(teamPlayers, roundIndex = 0){
  const sortedPlayers = (teamPlayers || []).slice().sort((a, b) =>
    String(a?.name || "").localeCompare(String(b?.name || ""))
  );
  const grouped = new Map();
  const ungrouped = [];

  for (const player of sortedPlayers){
    const label = groupValueForRound(player, roundIndex);
    if (!label) {
      ungrouped.push(player);
      continue;
    }
    if (!grouped.has(label)) grouped.set(label, []);
    grouped.get(label).push(player);
  }

  const used = new Set(grouped.keys());
  let nextLabelIdx = 0;
  function nextAutoLabel(){
    while (used.has(twoManGroupLabelFromIndex(nextLabelIdx))) nextLabelIdx++;
    const label = twoManGroupLabelFromIndex(nextLabelIdx);
    used.add(label);
    nextLabelIdx++;
    return label;
  }

  const labels = Array.from(grouped.keys()).sort((a, b) => a.localeCompare(b));
  for (const label of labels){
    const arr = grouped.get(label);
    while (arr.length < 2 && ungrouped.length) arr.push(ungrouped.shift());
  }

  while (ungrouped.length){
    const label = nextAutoLabel();
    const pair = [ungrouped.shift()];
    if (ungrouped.length) pair.push(ungrouped.shift());
    grouped.set(label, pair);
  }

  if (!grouped.size && sortedPlayers.length){
    const rest = sortedPlayers.slice();
    while (rest.length){
      const label = nextAutoLabel();
      const pair = [rest.shift()];
      if (rest.length) pair.push(rest.shift());
      grouped.set(label, pair);
    }
  }

  const out = {};
  for (const label of Array.from(grouped.keys()).sort((a, b) => a.localeCompare(b))){
    out[label] = grouped.get(label);
  }
  return out;
}

export async function getJson(bucket, key){
  try{
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const raw = await r.Body.transformToByteArray();
    const bytes = Buffer.from(raw);
    const txt = String(r?.ContentEncoding || "").toLowerCase().includes("gzip")
      ? zlib.gunzipSync(bytes).toString("utf8")
      : bytes.toString("utf8");
    return { json: JSON.parse(txt), etag: r.ETag };
  }catch(e){
    if (e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404) return { json: null, etag: null };
    throw e;
  }
}

export async function head(bucket, key){
  try{
    const r = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { etag: r.ETag || null };
  }catch(e){
    if (e?.$metadata?.httpStatusCode === 404) return { etag: null };
    throw e;
  }
}

export async function putJson(bucket, key, obj, { ifMatch=null, gzip=false, cacheControl=null, contentType="application/json" } = {}){
  const bodyStr = JSON.stringify(obj);
  const body = gzip ? zlib.gzipSync(Buffer.from(bodyStr)) : bodyStr;
  const params = {
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType
  };
  if (gzip) params.ContentEncoding = "gzip";
  if (cacheControl) params.CacheControl = cacheControl;
  if (ifMatch) params.IfMatch = ifMatch;
  return s3.send(new PutObjectCommand(params));
}

export async function updateStateWithRetry(tid, updater, { maxTries=5 } = {}){
  const bucket = process.env.STATE_BUCKET;
  const key = `state/${tid}.json`;

  for (let attempt=1; attempt<=maxTries; attempt++){
    const { json: current, etag } = await getJson(bucket, key);
    const next = updater(current);

    try{
      await putJson(bucket, key, next, { ifMatch: etag, gzip:false, cacheControl:"no-store" });
      return next;
    }catch(e){
      const code = e?.$metadata?.httpStatusCode;
      if (code === 412 || e?.name === "PreconditionFailed"){
        if (attempt === maxTries){
          const err = new Error("Concurrent update conflict, please retry");
          err.statusCode = 409;
          throw err;
        }
        continue;
      }
      // If object didn't exist (etag null), retry with no IfMatch
      if (!etag && (code === 404 || e?.name === "NoSuchKey")){
        await putJson(bucket, key, next, { gzip:false, cacheControl:"no-store" });
        return next;
      }
      throw e;
    }
  }
  const err = new Error("Failed to update state");
  err.statusCode = 500;
  throw err;
}

export async function appendEvent(tid, payload){
  const bucket = process.env.EVENTS_BUCKET;
  const ts = Date.now();
  const rand = crypto.randomBytes(4).toString("hex");
  const key = `events/${tid}/${ts}_${rand}.json`;
  await putJson(bucket, key, payload, { gzip:false, cacheControl:"no-store" });
}

export function materializePublicFromState(state){
  // Build a single tournament JSON with score_data and leaderboards.
  const t = state.tournament;
  const scoring = normalizeTournamentScoring(t?.scoring);
  const courses = normalizeCoursesFromState(state);
  const rounds = normalizeRoundsWithCourses(state.rounds || [], courses.length);
  const course = courses[0] || defaultCourseObject();
  const teams = state.teams || {};
  const players = state.players || {};
  const scores = state.scores || { rounds: [] };
  const publicRoundCount = rounds.length;

  const score_data = {
    rounds: [],
    leaderboard_all: { teams: [], players: [] }
  };

  // Precompute per-round derived
  for (let r=0;r<rounds.length;r++){
    const round = rounds[r] || {};
    const roundCourse = courseForRound(rounds, courses, r);
    const isScramble = round.format === "scramble";
    const twoManFormat = normalizeTwoManFormat(round.format);
    const isTwoMan = !!twoManFormat;
    const isTwoManScramble = isTwoManScrambleFormat(round.format);
    const isTwoManPlayerRound = isTwoManPlayerFormat(round.format);
    const isTeamBestBall = isTeamBestBallFormat(round.format);
    const useHandicap = !!round.useHandicap;

    const roundScores = scores.rounds?.[r] || {};
    const outRound = {
      roundIndex: r,
      format: round.format,
      scoring,
      useHandicap: !!round.useHandicap,
      player: {},
      team: {},
      leaderboard: { teams: [], players: [] }
    };

    // Player entries
    if (!isScramble && !isTwoManScramble){
      for (const pid of Object.keys(players)){
        const gross = (roundScores.players?.[pid]?.holes || Array(18).fill(null)).map(v => (v === 0 ? null : v));
        const handicapMultiplier = twoManFormat === "two_man_shamble" ? 0.8 : 1;
        const hcp = effectiveHandicap(players[pid]?.handicap, handicapMultiplier);
        const shots = useHandicap ? strokesPerHole(hcp, roundCourse.strokeIndex) : Array(18).fill(0);
        const net = gross.map((v,i)=> v==null ? null : (Number(v) - Number(shots[i]||0)));
        outRound.player[pid] = buildScoreEntry(gross, net, shots, roundCourse.pars);
      }
    }

    // Team entries
    if (isScramble){
      const playersByTeam = new Map(Object.keys(teams).map(id => [id, []]));
      for (const pid of Object.keys(players)){
        const p = players[pid];
        if (!p) continue;
        const arr = playersByTeam.get(p.teamId);
        if (arr) arr.push(p);
      }

      for (const tid2 of Object.keys(teams)){
        const gross = (roundScores.teams?.[tid2]?.holes || Array(18).fill(null)).map(v => (v === 0 ? null : v));
        const teamPlayers = playersByTeam.get(tid2) || [];
        const teamHcp = useHandicap ? scrambleTeamHandicap(teamPlayers) : 0;
        const shots = useHandicap ? strokesPerHole(teamHcp, roundCourse.strokeIndex) : Array(18).fill(0);
        const net = gross.map((v,i)=> v==null ? null : (Number(v) - Number(shots[i]||0)));
        outRound.team[tid2] = buildScoreEntry(gross, net, shots, roundCourse.pars);
      }
      // For scramble rounds, player rows inherit the team score so player leaderboards remain valid.
      for (const pid of Object.keys(players)){
        const player = players[pid];
        const teamSc = outRound.team[player?.teamId];
        if (!teamSc){
          outRound.player[pid] = buildScoreEntry(
            Array(18).fill(null),
            Array(18).fill(null),
            Array(18).fill(0),
            roundCourse.pars
          );
          continue;
        }
        outRound.player[pid] = {
          gross: teamSc.gross.slice(),
          net: teamSc.net.slice(),
          par: teamSc.par.slice(),
          grossToPar: teamSc.grossToPar.slice(),
          netToPar: teamSc.netToPar.slice(),
          grossStableford: teamSc.grossStableford.slice(),
          netStableford: teamSc.netStableford.slice(),
          handicapShots: teamSc.handicapShots.slice(),
          grossTotal: teamSc.grossTotal,
          netTotal: teamSc.netTotal,
          grossToParTotal: teamSc.grossToParTotal,
          netToParTotal: teamSc.netToParTotal,
          grossStablefordTotal: teamSc.grossStablefordTotal,
          netStablefordTotal: teamSc.netStablefordTotal,
          thru: teamSc.thru
        };
      }
    } else if (isTwoMan){
      const playersByTeam = getPlayersByTeamMap(players);

      for (const teamId of Object.keys(teams)){
        const teamPlayers = playersByTeam.get(teamId) || [];
        const groups = splitTwoManGroups(teamPlayers, r);
        const groupKeys = Object.keys(groups);
        const groupEntries = {};

        for (const key of groupKeys){
          const groupId = twoManGroupId(teamId, key);
          const gPlayers = groups[key] || [];
          let grossRaw = Array(18).fill(null);
          let netRaw = Array(18).fill(null);
          let shots = Array(18).fill(0);

          if (isTwoManScramble){
            grossRaw = (roundScores.groups?.[groupId]?.holes || Array(18).fill(null)).map(v => (v === 0 ? null : v));
            const groupHcp = useHandicap ? twoManScrambleHandicap(gPlayers) : 0;
            shots = useHandicap ? strokesPerHole(groupHcp, roundCourse.strokeIndex) : Array(18).fill(0);
            netRaw = grossRaw.map((v, i) => (v == null ? null : Number(v) - Number(shots[i] || 0)));
          } else if (isTwoManPlayerRound){
            for (let i = 0; i < 18; i++) {
              if (twoManFormat === "two_man_shamble") {
                let grossSum = 0;
                let netSum = 0;
                let shotSum = 0;
                let allPresent = gPlayers.length > 0;
                for (const player of gPlayers){
                  const playerSc = outRound.player[player.playerId];
                  const grossVal = grossHoleScoreOrNull(playerSc?.gross?.[i]);
                  const netVal = netHoleScoreOrNull(playerSc?.net?.[i]);
                  const shotVal = Number.isFinite(Number(playerSc?.handicapShots?.[i])) ? Number(playerSc.handicapShots[i]) : 0;
                  if (grossVal == null || netVal == null) {
                    allPresent = false;
                    break;
                  }
                  grossSum += grossVal;
                  netSum += netVal;
                  shotSum += shotVal;
                }
                if (allPresent) {
                  grossRaw[i] = grossSum;
                  netRaw[i] = netSum;
                  shots[i] = shotSum;
                }
                continue;
              }

              let grossBest = null;
              let netBest = null;
              let shotBest = 0;
              for (const player of gPlayers){
                const playerSc = outRound.player[player.playerId];
                const grossVal = grossHoleScoreOrNull(playerSc?.gross?.[i]);
                const netVal = netHoleScoreOrNull(playerSc?.net?.[i]);
                const shotVal = Number.isFinite(Number(playerSc?.handicapShots?.[i])) ? Number(playerSc.handicapShots[i]) : 0;
                if (grossVal != null && (grossBest == null || grossVal < grossBest)) grossBest = grossVal;
                if (netVal != null && (netBest == null || netVal < netBest)) {
                  netBest = netVal;
                  shotBest = shotVal;
                }
              }
              if (grossBest != null) grossRaw[i] = grossBest;
              if (netBest != null) netRaw[i] = netBest;
              if (netBest != null) shots[i] = shotBest;
            }
          }

          const groupPar = twoManFormat === "two_man_shamble"
            ? roundCourse.pars.map((value) => Number(value || 0) * Math.max(1, gPlayers.length))
            : roundCourse.pars.slice();
          const groupEntry = buildScoreEntry(grossRaw, netRaw, shots, groupPar);

          if (twoManFormat === "two_man_shamble"){
            groupEntry.grossStableford = sumHoleArrays(gPlayers.map((player) => outRound.player[player.playerId]?.grossStableford));
            groupEntry.netStableford = sumHoleArrays(gPlayers.map((player) => outRound.player[player.playerId]?.netStableford));
            groupEntry.grossStablefordTotal = sumPlayed(groupEntry.grossStableford);
            groupEntry.netStablefordTotal = sumPlayed(groupEntry.netStableford);
          }

          groupEntries[key] = {
            ...groupEntry,
            label: `Group ${key}`,
            groupId,
            playerIds: gPlayers.map((p) => p.playerId)
          };

          if (isTwoManScramble){
            for (const p of gPlayers){
              outRound.player[p.playerId] = {
                gross: groupEntry.gross.slice(),
                net: groupEntry.net.slice(),
                par: groupEntry.par.slice(),
                grossToPar: groupEntry.grossToPar.slice(),
                netToPar: groupEntry.netToPar.slice(),
                grossStableford: groupEntry.grossStableford.slice(),
                netStableford: groupEntry.netStableford.slice(),
                handicapShots: groupEntry.handicapShots.slice(),
                grossTotal: groupEntry.grossTotal,
                netTotal: groupEntry.netTotal,
                grossToParTotal: groupEntry.grossToParTotal,
                netToParTotal: groupEntry.netToParTotal,
                grossStablefordTotal: groupEntry.grossStablefordTotal,
                netStablefordTotal: groupEntry.netStablefordTotal,
                thru: groupEntry.thru
              };
            }
          }
        }

        const gross = sumHoleArrays(groupKeys.map((key) => groupEntries[key]?.gross));
        const net = sumHoleArrays(groupKeys.map((key) => groupEntries[key]?.net));
        const grossStableford = sumHoleArrays(groupKeys.map((key) => groupEntries[key]?.grossStableford));
        const netStableford = sumHoleArrays(groupKeys.map((key) => groupEntries[key]?.netStableford));
        const teamPar = Array.from({ length: 18 }, (_, i) => {
          let total = 0;
          let count = 0;
          for (const key of groupKeys){
            const groupEntry = groupEntries[key];
            if (groupEntry?.gross?.[i] == null && groupEntry?.net?.[i] == null) continue;
            total += Number(groupEntry?.par?.[i] || 0);
            count += 1;
          }
          return count > 0 ? total : 0;
        });
        const teamEntry = buildScoreEntry(gross, net, Array(18).fill(0), teamPar);
        teamEntry.grossStableford = grossStableford;
        teamEntry.netStableford = netStableford;
        teamEntry.grossStablefordTotal = sumPlayed(grossStableford);
        teamEntry.netStablefordTotal = sumPlayed(netStableford);
        teamEntry.groups = Object.fromEntries(groupKeys.map((key) => [key, groupEntries[key]]));
        outRound.team[teamId] = teamEntry;
      }
    } else if (isTeamBestBall){
      // Round leaderboard: Team Best Ball is sum of best X scores per hole.
      const { topX } = normalizeTeamAggregation(round.teamAggregation);
      const playersByTeam = getPlayersByTeamMap(players);

      for (const teamId of Object.keys(teams)){
        const teamPlayers = playersByTeam.get(teamId) || [];
        const gross = Array(18).fill(null);
        const net = Array(18).fill(null);
        const grossStableford = Array(18).fill(null);
        const netStableford = Array(18).fill(null);
        const parByHole = Array(18).fill(0);

        for (let i = 0; i < 18; i++){
          const candidates = [];
          for (const player of teamPlayers){
            const playerSc = outRound.player[player.playerId];
            if (!playerSc) continue;
            const grossRaw = playerSc?.gross?.[i];
            const netRaw = playerSc?.net?.[i];
            const grossStablefordRaw = playerSc?.grossStableford?.[i];
            const netStablefordRaw = playerSc?.netStableford?.[i];
            const grossVal = grossRaw == null ? null : (Number.isFinite(Number(grossRaw)) ? Number(grossRaw) : null);
            const netVal = netRaw == null ? grossVal : (Number.isFinite(Number(netRaw)) ? Number(netRaw) : grossVal);
            const grossPoints = grossStablefordRaw == null ? null : Number(grossStablefordRaw);
            const netPoints = netStablefordRaw == null ? grossPoints : Number(netStablefordRaw);
            const metricVal = scoring === "stableford"
              ? (useHandicap ? netPoints : grossPoints)
              : (useHandicap ? netVal : grossVal);
            if (metricVal == null) continue;
            candidates.push({ gross: grossVal, net: netVal, grossPoints, netPoints, metric: metricVal });
          }
          if (!candidates.length) continue;

          candidates.sort((a, b) => scoring === "stableford" ? Number(b.metric) - Number(a.metric) : Number(a.metric) - Number(b.metric));
          const take = candidates.slice(0, Math.min(topX, candidates.length));
          const grossVals = take.map((x) => x.gross);
          const netVals = take.map((x) => x.net);
          const grossAgg = aggregateValuesByMode(grossVals, "sum");
          const netAgg = aggregateValuesByMode(netVals, "sum");
          if (grossAgg != null) gross[i] = grossAgg;
          if (netAgg != null) net[i] = netAgg;
          const grossPoints = aggregateValuesByMode(take.map((x) => x.grossPoints), "sum");
          const netPoints = aggregateValuesByMode(take.map((x) => x.netPoints), "sum");
          if (grossPoints != null) grossStableford[i] = grossPoints;
          if (netPoints != null) netStableford[i] = netPoints;
          parByHole[i] = take.length ? Number(roundCourse.pars[i] || 0) * take.length : 0;
        }

        const teamEntry = buildScoreEntry(gross, net, Array(18).fill(0), parByHole);
        teamEntry.grossStableford = grossStableford;
        teamEntry.netStableford = netStableford;
        teamEntry.grossStablefordTotal = sumPlayed(grossStableford);
        teamEntry.netStablefordTotal = sumPlayed(netStableford);
        outRound.team[teamId] = teamEntry;
      }
    } else {
      // team totals derived from players for that round (aggregation)
      const agg = round.teamAggregation || { mode:"avg", topX:4 };
      for (const teamId of Object.keys(teams)){
        const teamPlayerEntries = Object.keys(players)
          .filter((pid) => players[pid].teamId === teamId)
          .map((pid) => outRound.player[pid])
          .filter((entry) => entry && Number.isFinite(entry.thru) && entry.thru > 0);
        const metricKey = scoring === "stableford"
          ? (useHandicap ? "netStablefordTotal" : "grossStablefordTotal")
          : (useHandicap ? "netTotal" : "grossTotal");
        const selected = selectEntriesByMetric(
          teamPlayerEntries,
          metricKey,
          agg.topX,
          scoring === "stableford" ? "high" : "low"
        );
        const playedThrus = selected
          .map((entry) => entry?.thru)
          .filter((v) => Number.isFinite(v) && v > 0);
        const teamThru = playedThrus.length ? Math.min(...playedThrus) : null;

        if (!selected.length){
          const emptyEntry = buildScoreEntry(
            Array(18).fill(null),
            Array(18).fill(null),
            Array(18).fill(0),
            Array(18).fill(0)
          );
          emptyEntry.thru = teamThru;
          outRound.team[teamId] = emptyEntry;
          continue;
        }
        const gross = sumHoleArrays(selected.map((entry) => entry.gross));
        const net = sumHoleArrays(selected.map((entry) => entry.net));
        const grossStableford = sumHoleArrays(selected.map((entry) => entry.grossStableford));
        const netStableford = sumHoleArrays(selected.map((entry) => entry.netStableford));
        const parByHole = Array.from({ length: 18 }, (_, i) => {
          let total = 0;
          let count = 0;
          for (const entry of selected){
            if (entry?.gross?.[i] == null && entry?.net?.[i] == null) continue;
            total += Number(roundCourse.pars[i] || 0);
            count += 1;
          }
          return count > 0 ? total : 0;
        });
        const teamEntry = buildScoreEntry(gross, net, Array(18).fill(0), parByHole);
        teamEntry.grossStableford = grossStableford;
        teamEntry.netStableford = netStableford;
        teamEntry.grossStablefordTotal = sumPlayed(grossStableford);
        teamEntry.netStablefordTotal = sumPlayed(netStableford);
        teamEntry.thru = teamThru;
        outRound.team[teamId] = teamEntry;
      }
    }

    // Leaderboards for the round
    // Teams
    const teamRows = Object.keys(teams).map(teamId => {
      const tname = teams[teamId]?.teamName || "";
      const sc = outRound.team[teamId];
      if (!sc) return null;
      const strokes = sc.grossTotal;
      const points = useHandicap ? sc.netStablefordTotal : sc.grossStablefordTotal;
      const grossToPar = toParStrFromDiff(sc.grossToParTotal);
      const netToPar = toParStrFromDiff(sc.netToParTotal);
      const thru = Number.isFinite(sc.thru) && sc.thru > 0 ? sc.thru : null;
      return {
        teamId, teamName: tname,
        strokes: Number.isFinite(strokes) ? Number(strokes.toFixed(2)) : 0,
        points: Number.isFinite(points) ? Number(points.toFixed(2)) : 0,
        grossPoints: Number.isFinite(sc.grossStablefordTotal) ? Number(sc.grossStablefordTotal.toFixed(2)) : 0,
        netPoints: Number.isFinite(sc.netStablefordTotal) ? Number(sc.netStablefordTotal.toFixed(2)) : 0,
        toPar: grossToPar,
        grossToPar,
        netToPar,
        thru,
        scores: {
          gross: Array.isArray(sc.gross) ? sc.gross.slice() : Array(18).fill(null),
          net: Array.isArray(sc.net) ? sc.net.slice() : Array(18).fill(null),
          handicapShots: Array.isArray(sc.handicapShots) ? sc.handicapShots.slice() : Array(18).fill(0),
          grossTotal: Number.isFinite(sc.grossTotal) ? Number(sc.grossTotal.toFixed(2)) : 0,
          netTotal: Number.isFinite(sc.netTotal) ? Number(sc.netTotal.toFixed(2)) : 0,
          grossToParTotal: Number.isFinite(sc.grossToParTotal) ? Number(sc.grossToParTotal.toFixed(2)) : 0,
          netToParTotal: Number.isFinite(sc.netToParTotal) ? Number(sc.netToParTotal.toFixed(2)) : 0,
          grossStableford: Array.isArray(sc.grossStableford) ? sc.grossStableford.slice() : Array(18).fill(null),
          netStableford: Array.isArray(sc.netStableford) ? sc.netStableford.slice() : Array(18).fill(null),
          grossStablefordTotal: Number.isFinite(sc.grossStablefordTotal) ? Number(sc.grossStablefordTotal.toFixed(2)) : 0,
          netStablefordTotal: Number.isFinite(sc.netStablefordTotal) ? Number(sc.netStablefordTotal.toFixed(2)) : 0,
          thru
        }
      };
    }).filter(Boolean).sort((a,b)=> scoring === "stableford" ? b.points - a.points : a.strokes - b.strokes);

    // Players
    const playerRows = Object.keys(players).map(pid => {
      const p = players[pid];
      const sc = outRound.player[pid];
      if (!sc) return null;
      const strokes = useHandicap ? sc.netTotal : sc.grossTotal;
      const points = useHandicap ? sc.netStablefordTotal : sc.grossStablefordTotal;
      const toParTotal = useHandicap ? sc.netToParTotal : sc.grossToParTotal;
      const teamName = teams[p.teamId]?.teamName || "";
      return {
        playerId: pid,
        name: p.name,
        teamName,
        strokes: Number.isFinite(strokes) ? Number(strokes.toFixed(2)) : 0,
        points: Number.isFinite(points) ? Number(points.toFixed(2)) : 0,
        grossPoints: Number.isFinite(sc.grossStablefordTotal) ? Number(sc.grossStablefordTotal.toFixed(2)) : 0,
        netPoints: Number.isFinite(sc.netStablefordTotal) ? Number(sc.netStablefordTotal.toFixed(2)) : 0,
        toPar: toParStrFromDiff(toParTotal),
        thru: sc.thru,
        scores: sc
      };
    }).filter(Boolean).sort((a,b)=> scoring === "stableford" ? b.points - a.points : a.strokes - b.strokes);

    outRound.leaderboard.teams = teamRows;
    outRound.leaderboard.players = playerRows;

    score_data.rounds.push(outRound);
  }

  // All-rounds (weighted) leaderboards with parPlayed handling.
  // Normalize weights so effective total equals number of rounds
  // (e.g., 3 rounds => weight sum 3).
  const rawWeights = rounds.map(round => {
    const w = Number(round?.weight);
    return (Number.isFinite(w) && w > 0) ? w : 1;
  });
  const roundCount = rounds.length || 1;
  const rawWeightSum = rawWeights.reduce((a,b)=>a+b,0);
  const weightScale = rawWeightSum > 0 ? (roundCount / rawWeightSum) : 1;
  const normalizedWeights = rawWeights.map(w => w * weightScale);

  const teamTotals = new Map(Object.keys(teams).map(id => [id, {
    metric: 0,
    strokes: 0,
    par: 0,
    grossPoints: 0,
    netPoints: 0
  }]));
  const playerTotals = new Map(Object.keys(players).map(id => [id, {
    metric: 0,
    strokes: 0,
    par: 0,
    grossPoints: 0,
    netPoints: 0
  }]));

  for (let r=0;r<rounds.length;r++){
    const round = rounds[r] || {};
    const roundCourse = courseForRound(rounds, courses, r);
    const weight = normalizedWeights[r] ?? 1;
    const isScramble = round.format === "scramble";
    const isTwoMan = isTwoManFormat(round.format);
    const useHandicap = !!round.useHandicap;
    const roundMetricKey = scoring === "stableford"
      ? (useHandicap ? "netStablefordTotal" : "grossStablefordTotal")
      : (useHandicap ? "netTotal" : "grossTotal");

    const derived = score_data.rounds[r];

    if (isScramble){
      for (const teamId of Object.keys(teams)){
        const sc = derived.team[teamId];
        if (!sc) continue;
        const parPlayed = sc.grossTotal - sc.grossToParTotal;
        const strokes = useHandicap ? sc.netTotal : sc.grossTotal;
        const points = useHandicap ? sc.netStablefordTotal : sc.grossStablefordTotal;
        const cur = teamTotals.get(teamId);
        cur.metric += Number((sc?.[roundMetricKey]) || 0) * weight;
        cur.strokes += Number(strokes || 0) * weight;
        cur.par += Number(parPlayed || 0) * weight;
        cur.grossPoints += Number(sc?.grossStablefordTotal || 0) * weight;
        cur.netPoints += Number(sc?.netStablefordTotal || 0) * weight;
      }
      for (const pid of Object.keys(players)){
        const p = players[pid];
        const sc = derived.team[p?.teamId];
        if (!sc) continue;
        const parPlayed = sc.grossTotal - sc.grossToParTotal;
        const strokes = useHandicap ? sc.netTotal : sc.grossTotal;
        const cur = playerTotals.get(pid);
        cur.metric += Number((sc?.[roundMetricKey]) || 0) * weight;
        cur.strokes += Number(strokes || 0) * weight;
        cur.par += Number(parPlayed || 0) * weight;
        cur.grossPoints += Number(sc?.grossStablefordTotal || 0) * weight;
        cur.netPoints += Number(sc?.netStablefordTotal || 0) * weight;
      }
      continue;
    }

    const roundPlayer = new Map();
    for (const pid of Object.keys(players)){
      const sc = derived.player[pid];
      if (!sc || !Number.isFinite(sc.thru) || sc.thru <= 0) continue;
      const strokes = useHandicap ? sc.netTotal : sc.grossTotal;
      const parPlayed = sc.grossTotal - sc.grossToParTotal;
      const metric = Number(sc?.[roundMetricKey] || 0);
      roundPlayer.set(pid, {
        strokes,
        par: parPlayed,
        grossPoints: Number(sc?.grossStablefordTotal || 0),
        netPoints: Number(sc?.netStablefordTotal || 0),
        metric
      });

      const cur = playerTotals.get(pid);
      cur.metric += metric * weight;
      cur.strokes += Number(strokes || 0) * weight;
      cur.par += Number(parPlayed || 0) * weight;
      cur.grossPoints += Number(sc?.grossStablefordTotal || 0) * weight;
      cur.netPoints += Number(sc?.netStablefordTotal || 0) * weight;
    }

    if (isTwoMan){
      for (const teamId of Object.keys(teams)){
        const sc = derived.team[teamId];
        if (!sc) continue;

        // Weighted all-round two-man contribution should be the average of
        // two-man groups, while the round leaderboard remains team-summed.
        const groupPairs = Object.values(sc.groups || {}).map((groupSc) => {
          const gross = Array.isArray(groupSc?.gross) ? groupSc.gross : Array(18).fill(null);
          const net = Array.isArray(groupSc?.net) ? groupSc.net : gross;
          const thru = thruFromHoles(gross);
          if (!Number.isFinite(thru) || thru <= 0) return null;

          const parPlayed = Array.isArray(groupSc?.par)
            ? groupSc.par.reduce((acc, v, i) => acc + ((gross[i] == null && net[i] == null) ? 0 : Number(v || 0)), 0)
            : gross.reduce((acc, v, i) => acc + (v == null ? 0 : Number(roundCourse.pars[i] || 0)), 0);
          const strokes = useHandicap ? sumPlayed(net) : sumPlayed(gross);
          const grossPoints = Number(groupSc?.grossStablefordTotal || 0);
          const netPoints = Number(groupSc?.netStablefordTotal || 0);
          return {
            strokes,
            par: parPlayed,
            grossPoints,
            netPoints,
            metric: scoring === "stableford" ? (useHandicap ? netPoints : grossPoints) : strokes
          };
        }).filter(Boolean);

        const cur = teamTotals.get(teamId);
        if (groupPairs.length){
          const groupCount = groupPairs.length;
          const metricDivisor = scoring === "stableford" ? 1 : groupCount;
          const pointDivisor = scoring === "stableford" ? 1 : groupCount;
          const avgMetric = groupPairs.reduce((a, p) => a + Number(p.metric || 0), 0) / metricDivisor;
          const avgStrokes = groupPairs.reduce((a, p) => a + Number(p.strokes || 0), 0) / groupCount;
          const avgPar = groupPairs.reduce((a, p) => a + Number(p.par || 0), 0) / groupCount;
          const avgGrossPoints = groupPairs.reduce((a, p) => a + Number(p.grossPoints || 0), 0) / pointDivisor;
          const avgNetPoints = groupPairs.reduce((a, p) => a + Number(p.netPoints || 0), 0) / pointDivisor;
          cur.metric += avgMetric * weight;
          cur.strokes += avgStrokes * weight;
          cur.par += avgPar * weight;
          cur.grossPoints += avgGrossPoints * weight;
          cur.netPoints += avgNetPoints * weight;
          continue;
        }

        const parPlayed = sc.grossTotal - sc.grossToParTotal;
        const strokes = useHandicap ? sc.netTotal : sc.grossTotal;
        cur.metric += Number((sc?.[roundMetricKey]) || 0) * weight;
        cur.strokes += Number(strokes || 0) * weight;
        cur.par += Number(parPlayed || 0) * weight;
        cur.grossPoints += Number(sc?.grossStablefordTotal || 0) * weight;
        cur.netPoints += Number(sc?.netStablefordTotal || 0) * weight;
      }
      continue;
    }

    const agg = round.teamAggregation || { mode:"avg", topX:4 };
    for (const teamId of Object.keys(teams)){
      const pids = Object.keys(players).filter(pid => players[pid].teamId === teamId);
      const pairs = pids.map(pid => roundPlayer.get(pid)).filter(Boolean);
      const selected = selectEntriesByMetric(
        pairs,
        "metric",
        agg.topX,
        scoring === "stableford" ? "high" : "low"
      );
      if (!selected.length) continue;
      const cur = teamTotals.get(teamId);
      const totalMetric = selected.reduce((sum, entry) => sum + Number(entry.metric || 0), 0);
      const totalStrokes = selected.reduce((sum, entry) => sum + Number(entry.strokes || 0), 0);
      const totalPar = selected.reduce((sum, entry) => sum + Number(entry.par || 0), 0);
      const totalGrossPoints = selected.reduce((sum, entry) => sum + Number(entry.grossPoints || 0), 0);
      const totalNetPoints = selected.reduce((sum, entry) => sum + Number(entry.netPoints || 0), 0);
      const divisor = selected.length || 1;
      const pointDivisor = scoring === "stableford" ? 1 : divisor;
      cur.metric += (totalMetric / pointDivisor) * weight;
      cur.strokes += (totalStrokes / divisor) * weight;
      cur.par += (totalPar / divisor) * weight;
      cur.grossPoints += (totalGrossPoints / pointDivisor) * weight;
      cur.netPoints += (totalNetPoints / pointDivisor) * weight;
    }
  }

  const teamLb = Object.keys(teams).map(teamId => {
    const tname = teams[teamId]?.teamName || "";
    const teamColor = String(teams[teamId]?.color || "").trim();
    const v = teamTotals.get(teamId) || { metric:0, strokes:0, par:0, grossPoints:0, netPoints:0 };
    const strokes = Number(v.strokes.toFixed(2));
    const points = Number(v.metric.toFixed(2));
    const toPar = (v.par === 0 && strokes === 0) ? "E" : toParStrFromDiff(strokes - v.par);
    return {
      teamId,
      teamName: tname,
      ...(teamColor ? { color: teamColor } : {}),
      strokes,
      points,
      grossPoints: Number(v.grossPoints.toFixed(2)),
      netPoints: Number(v.netPoints.toFixed(2)),
      toPar,
      thru: null
    };
  }).sort((a,b)=> scoring === "stableford" ? b.points - a.points : a.strokes - b.strokes);

  const playerLb = Object.keys(players).map(pid => {
    const p = players[pid];
    const v = playerTotals.get(pid) || { metric:0, strokes:0, par:0, grossPoints:0, netPoints:0 };
    const strokes = Number(v.strokes.toFixed(2));
    const toPar = (v.par === 0 && strokes === 0) ? "E" : toParStrFromDiff(strokes - v.par);
    const teamName = teams[p.teamId]?.teamName || "";
    return {
      playerId: pid,
      name: p.name,
      teamName,
      strokes,
      points: Number(v.metric.toFixed(2)),
      grossPoints: Number(v.grossPoints.toFixed(2)),
      netPoints: Number(v.netPoints.toFixed(2)),
      toPar,
      thru: null
    };
  }).sort((a,b)=> scoring === "stableford" ? b.points - a.points : a.strokes - b.strokes);

  score_data.leaderboard_all.teams = teamLb;
  score_data.leaderboard_all.players = playerLb;

  const hasTwoManFormat = rounds.some(round => isTwoManFormat(round?.format));
  const playersByTeam = getPlayersByTeamMap(players);
  const publicTeams = Object.keys(teams).map(teamId => {
    const row = {
      teamId,
      teamName: teams[teamId].teamName,
      ...(teams[teamId]?.color ? { color: teams[teamId].color } : {})
    };
    if (!hasTwoManFormat) return row;
    const groupsByRound = {};
    for (let r = 0; r < rounds.length; r++){
      if (!isTwoManFormat(rounds[r]?.format)) continue;
      const groups = splitTwoManGroups(playersByTeam.get(teamId) || [], r);
      const groupKeys = Object.keys(groups);
      groupsByRound[String(r)] = Object.fromEntries(
        groupKeys.map((key) => [key, (groups[key] || []).map(p => p.playerId)])
      );
    }
    return {
      ...row,
      groupsByRound
    };
  });

  return {
    tournament: { tournamentId: t.tournamentId, name: t.name, dates: t.dates, scoring, rounds },
    course,
    courses,
    teams: publicTeams,
    players: Object.keys(players).map(id => ({
      ...(function(){
        const rawTeeTimes = Array.isArray(players[id]?.teeTimes) ? players[id].teeTimes : [];
        const teeTimes = Array.from({ length: publicRoundCount }, (_, idx) => {
          const v = rawTeeTimes[idx];
          if (v == null || v === "") return null;
          return String(v).trim();
        });
        if (!teeTimes.some((v) => !!v) && players[id]?.teeTime && teeTimes.length > 0) {
          teeTimes[0] = String(players[id].teeTime).trim();
        }
        return { teeTimes };
      })(),
      playerId:id,
      name: players[id].name,
      teamId: players[id].teamId,
      handicap: players[id].handicap,
      groups: Array.from({ length: publicRoundCount }, (_, r) => groupValueForRound(players[id], r) || null),
      group: players[id].group || null,
      teeTime: (Array.isArray(players[id]?.teeTimes) ? players[id].teeTimes.find(v => !!v) : null) || players[id].teeTime || null
    })),
    updatedAt: state.updatedAt,
    version: state.version,
    score_data
  };
}

export async function writePublicObjectsFromState(state){
  const pub = process.env.PUBLIC_BUCKET;
  const tid = state.tournament.tournamentId;
  const tournamentJson = materializePublicFromState(state);

  // Write tournament JSON
  await putJson(pub, `tournaments/${tid}.json`, tournamentJson, {
    gzip:true,
    cacheControl:"max-age=5, must-revalidate"
  });

  // Write enter JSON per player code (contains only this player + team + rounds + course + saved holes)
  const teamsMap = state.teams || {};
  const rounds = tournamentJson?.tournament?.rounds || [];
  const courses = Array.isArray(tournamentJson?.courses) && tournamentJson.courses.length
    ? tournamentJson.courses
    : [tournamentJson?.course || defaultCourseObject()];
  const course = courses[0] || defaultCourseObject();
  const scores = state.scores || { rounds: [] };

  for (const pid of Object.keys(state.players || {})){
    const p = state.players[pid];
    if (!p?.code) continue;
    const team = teamsMap[p.teamId] || { teamId: p.teamId, teamName: "" };
    const teeTimes = Array.from({ length: rounds.length }, (_, idx) => {
      const v = Array.isArray(p?.teeTimes) ? p.teeTimes[idx] : null;
      if (v == null || v === "") return null;
      return String(v).trim();
    });
    if (!teeTimes.some((v) => !!v) && p?.teeTime && teeTimes.length > 0) {
      teeTimes[0] = String(p.teeTime).trim();
    }

    const saved = rounds.map((round, rIdx) => {
      const isScramble = round.format === "scramble";
      const isTwoMan = isTwoManFormat(round?.format);
      const target = isScramble ? "team" : isTwoMan ? "group" : "player";
      const groupLabel = groupValueForRound(p, rIdx) || null;
      const groupId = isTwoMan ? twoManGroupId(p.teamId, groupLabel) : null;
      const gross = isScramble
        ? (scores.rounds?.[rIdx]?.teams?.[p.teamId]?.holes || Array(18).fill(null))
        : isTwoMan
          ? (scores.rounds?.[rIdx]?.groups?.[groupId]?.holes || Array(18).fill(null))
          : (scores.rounds?.[rIdx]?.players?.[pid]?.holes || Array(18).fill(null));
      return {
        roundIndex:rIdx,
        target,
        group: groupLabel,
        groupId,
        gross: gross.map(v => (v===0?null:v))
      };
    });
    const enterObj = {
      code: p.code,
      tournamentId: tid,
      tournament: {
        name: state.tournament.name,
        dates: state.tournament.dates,
        scoring: normalizeTournamentScoring(state?.tournament?.scoring)
      },
      rounds,
      course,
      courses,
      player: {
        playerId: pid,
        name: p.name,
        handicap: p.handicap,
        groups: Array.from({ length: rounds.length }, (_, r) => groupValueForRound(p, r) || null),
        group: p.group || null,
        teeTimes,
        teeTime: teeTimes.find((v) => !!v) || p.teeTime || null
      },
      team: { teamId: team.teamId, teamName: team.teamName, group: p.group || null },
      saved
    };

    await putJson(pub, `enter/${p.code}.json`, enterObj, {
      gzip:true,
      cacheControl:"max-age=5, must-revalidate"
    });
  }

  return tournamentJson;
}

export function materializeLiveOddsPublicFromState(state, previousOddsJson = null){
  const tournamentJson = materializePublicFromState(state);
  const liveOdds = computeLiveOdds(tournamentJson, {
    generatedAt: new Date(Number(state?.updatedAt) || Date.now()).toISOString()
  });
  const compactOdds = compactLiveOddsPayload(liveOdds);
  const previousVersion = Number(previousOddsJson?.v ?? previousOddsJson?.version ?? 0);
  const currentVersion = Number(state?.version ?? 0);
  const previousCompactOdds = previousOddsJson?.o || null;
  const history = currentVersion < previousVersion
    ? previousOddsJson?.h || null
    : appendCompactLiveOddsHistory(previousOddsJson?.h, previousCompactOdds, compactOdds, {
      snapshotTimeMs: Number(state?.updatedAt) || Date.now(),
      version: currentVersion
    });

  return {
    v: state?.version ?? null,
    u: state?.updatedAt ?? null,
    o: compactOdds,
    ...(history ? { h: history } : {})
  };
}

export async function writeLiveOddsObjectFromState(state){
  const pub = process.env.PUBLIC_BUCKET;
  const tid = state?.tournament?.tournamentId;
  if (!pub || !tid) {
    const err = new Error("missing public bucket or tournament id");
    err.statusCode = 500;
    throw err;
  }

  const key = `tournaments/${tid}.live_odds.json`;
  const targetVersion = Number(state?.version ?? 0);

  for (let attempt = 1; attempt <= 5; attempt++) {
    const { json: previousOddsJson, etag } = await getJson(pub, key);
    const previousVersion = Number(previousOddsJson?.v ?? previousOddsJson?.version ?? 0);
    if (previousVersion > targetVersion) return previousOddsJson;

    const oddsJson = materializeLiveOddsPublicFromState(state, previousOddsJson);
    try {
      await putJson(pub, key, oddsJson, {
        ifMatch: etag,
        gzip:true,
        cacheControl:"max-age=5, must-revalidate"
      });
      return oddsJson;
    } catch (error) {
      const code = error?.$metadata?.httpStatusCode;
      if (code === 412 || error?.name === "PreconditionFailed") {
        if (attempt === 5) throw error;
        continue;
      }
      if (!etag && (code === 404 || error?.name === "NoSuchKey")) {
        await putJson(pub, key, oddsJson, {
          gzip:true,
          cacheControl:"max-age=5, must-revalidate"
        });
        return oddsJson;
      }
      throw error;
    }
  }

  const err = new Error("failed to write live odds");
  err.statusCode = 500;
  throw err;
}
