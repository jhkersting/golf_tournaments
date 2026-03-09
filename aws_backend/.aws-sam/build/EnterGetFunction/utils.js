import crypto from "crypto";
import zlib from "zlib";
import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

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

function scrambleTeamHandicap(teamPlayers){
  const vals = (teamPlayers || [])
    .map(p => Number(p?.handicap ?? 0))
    .filter(Number.isFinite)
    .map(v => Math.max(0, v));
  if (!vals.length) return 0;
  const avg = vals.reduce((a,b)=>a+b,0) / vals.length;
  return Math.round(avg);
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
  return Math.max(0, Math.round((lower * 0.35) + (upper * 0.15)));
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
  const pars = Array.isArray(course?.pars) ? course.pars.map(Number) : [];
  const strokeIndex = Array.isArray(course?.strokeIndex) ? course.strokeIndex.map(Number) : [];
  if (pars.length !== 18 || strokeIndex.length !== 18) return null;
  if (!pars.every((v) => Number.isFinite(v))) return null;
  const uniqSi = new Set(strokeIndex);
  if (uniqSi.size !== 18) return null;
  if (!strokeIndex.every((v) => Number.isInteger(v) && v >= 1 && v <= 18)) return null;
  const out = { pars, strokeIndex };
  const name = String(course?.name || "").trim();
  if (name) out.name = name.slice(0, 120);
  return out;
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
    const txt = await r.Body.transformToString();
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
        const grossToPar = gross.map((v,i)=> v==null ? null : (Number(v) - Number(roundCourse.pars[i]||0)));
        const netToPar = net.map((v,i)=> v==null ? null : (Number(v) - Number(roundCourse.pars[i]||0)));
        const parPlayed = gross.reduce((acc,v,i)=>acc+(v==null?0:Number(roundCourse.pars[i]||0)),0);
        const grossTotal = sumPlayed(gross);
        const netTotal = sumPlayed(net);
        const thru = thruFromHoles(gross);
        const grossToParTotal = grossTotal - parPlayed;
        const netToParTotal = netTotal - parPlayed;

        outRound.player[pid] = {
          gross, net, grossToPar, netToPar,
          handicapShots: shots,
          grossTotal, netTotal,
          grossToParTotal, netToParTotal,
          thru
        };
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
        const grossToPar = gross.map((v,i)=> v==null?null:(Number(v)-Number(roundCourse.pars[i]||0)));
        const netToPar = net.map((v,i)=> v==null ? null : (Number(v) - Number(roundCourse.pars[i]||0)));
        const parPlayed = gross.reduce((acc,v,i)=>acc+(v==null?0:Number(roundCourse.pars[i]||0)),0);
        const grossTotal = sumPlayed(gross);
        const netTotal = sumPlayed(net);
        const thru = thruFromHoles(gross);
        const grossToParTotal = grossTotal - parPlayed;
        const netToParTotal = netTotal - parPlayed;

        outRound.team[tid2] = {
          gross, net, grossToPar, netToPar,
          handicapShots: shots,
          grossTotal, netTotal,
          grossToParTotal, netToParTotal,
          thru
        };
      }
      // For scramble rounds, player rows inherit the team score so player leaderboards remain valid.
      for (const pid of Object.keys(players)){
        const player = players[pid];
        const teamSc = outRound.team[player?.teamId];
        if (!teamSc){
          outRound.player[pid] = {
            gross: Array(18).fill(null),
            net: Array(18).fill(null),
            grossToPar: Array(18).fill(null),
            netToPar: Array(18).fill(null),
            handicapShots: Array(18).fill(0),
            grossTotal: 0, netTotal: 0,
            grossToParTotal: 0, netToParTotal: 0,
            thru: 0
          };
          continue;
        }
        outRound.player[pid] = {
          gross: teamSc.gross.slice(),
          net: teamSc.net.slice(),
          grossToPar: teamSc.grossToPar.slice(),
          netToPar: teamSc.netToPar.slice(),
          handicapShots: teamSc.handicapShots.slice(),
          grossTotal: teamSc.grossTotal,
          netTotal: teamSc.netTotal,
          grossToParTotal: teamSc.grossToParTotal,
          netToParTotal: teamSc.netToParTotal,
          thru: teamSc.thru
        };
      }
    } else if (isTwoMan){
      const playersByTeam = getPlayersByTeamMap(players);

      for (const teamId of Object.keys(teams)){
        const teamPlayers = playersByTeam.get(teamId) || [];
        const groups = splitTwoManGroups(teamPlayers, r);
        const groupKeys = Object.keys(groups);
        const groupGross = Object.fromEntries(groupKeys.map(key => [key, Array(18).fill(null)]));
        const groupNet = Object.fromEntries(groupKeys.map(key => [key, Array(18).fill(null)]));
        const groupShots = Object.fromEntries(groupKeys.map(key => [key, Array(18).fill(0)]));

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
                  const grossVal = Number.isFinite(Number(playerSc?.gross?.[i])) ? Number(playerSc.gross[i]) : null;
                  const netVal = Number.isFinite(Number(playerSc?.net?.[i])) ? Number(playerSc.net[i]) : null;
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
                const grossVal = Number.isFinite(Number(playerSc?.gross?.[i])) ? Number(playerSc.gross[i]) : null;
                const netVal = Number.isFinite(Number(playerSc?.net?.[i])) ? Number(playerSc.net[i]) : null;
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

          groupGross[key] = grossRaw;
          groupNet[key] = netRaw;
          groupShots[key] = shots;

          const parPlayedGroup = grossRaw.reduce((acc, v, i) => acc + (v == null ? 0 : Number(roundCourse.pars[i] || 0)), 0);
          const grossTotalGroup = sumPlayed(grossRaw);
          const netTotalGroup = sumPlayed(netRaw);
          const grossToParTotalGroup = grossTotalGroup - parPlayedGroup;
          const netToParTotalGroup = netTotalGroup - parPlayedGroup;
          const thruGroup = thruFromHoles(grossRaw);

          if (isTwoManScramble){
            for (const p of gPlayers){
              outRound.player[p.playerId] = {
                gross: grossRaw.slice(),
                net: netRaw.slice(),
                grossToPar: grossRaw.map((v, i) => (v == null ? null : Number(v) - Number(roundCourse.pars[i] || 0))),
                netToPar: netRaw.map((v, i) => (v == null ? null : Number(v) - Number(roundCourse.pars[i] || 0))),
                handicapShots: shots.slice(),
                grossTotal: grossTotalGroup,
                netTotal: netTotalGroup,
                grossToParTotal: grossToParTotalGroup,
                netToParTotal: netToParTotalGroup,
                thru: thruGroup
              };
            }
          }
        }

        const gross = Array(18).fill(null);
        const net = Array(18).fill(null);
        const grossToPar = Array(18).fill(null);
        const netToPar = Array(18).fill(null);
        for (let i=0;i<18;i++){
          let grossSum = 0;
          let netSum = 0;
          let allGross = groupKeys.length > 0;
          let allNet = groupKeys.length > 0;
          for (const key of groupKeys){
            const gGross = Number.isFinite(groupGross[key]?.[i]) ? Number(groupGross[key][i]) : null;
            const gNet = Number.isFinite(groupNet[key]?.[i]) ? Number(groupNet[key][i]) : null;
            if (gGross == null) allGross = false;
            else grossSum += gGross;
            if (gNet == null) allNet = false;
            else netSum += gNet;
          }
          if (allGross) gross[i] = grossSum;
          if (allNet) net[i] = netSum;
          const parBase = Number(roundCourse.pars[i] || 0) * groupKeys.length;
          if (allGross) grossToPar[i] = grossSum - parBase;
          if (allNet) netToPar[i] = netSum - parBase;
        }

        const parPlayed = gross.reduce((acc,v,i)=>acc+(v==null?0:(Number(roundCourse.pars[i] || 0) * groupKeys.length)),0);
        const grossTotal = sumPlayed(gross);
        const netTotal = sumPlayed(net);
        const thru = thruFromHoles(gross);
        const grossToParTotal = sumPlayed(grossToPar);
        const netToParTotal = sumPlayed(netToPar);

        outRound.team[teamId] = {
          gross, net, grossToPar, netToPar,
          handicapShots: Array(18).fill(0),
          grossTotal, netTotal,
          grossToParTotal, netToParTotal,
          thru,
          groups: Object.fromEntries(
            groupKeys.map((key) => [
              key,
              {
                label: `Group ${key}`,
                groupId: twoManGroupId(teamId, key),
                playerIds: (groups[key] || []).map(p => p.playerId),
                gross: groupGross[key],
                net: groupNet[key],
                handicapShots: groupShots[key]
              }
            ])
          )
        };
      }
    } else if (isTeamBestBall){
      // Round leaderboard: Team Best Ball is sum of best X scores per hole.
      const { topX } = normalizeTeamAggregation(round.teamAggregation);
      const playersByTeam = getPlayersByTeamMap(players);

      for (const teamId of Object.keys(teams)){
        const teamPlayers = playersByTeam.get(teamId) || [];
        const gross = Array(18).fill(null);
        const net = Array(18).fill(null);
        const grossToPar = Array(18).fill(null);
        const netToPar = Array(18).fill(null);

        for (let i = 0; i < 18; i++){
          const candidates = [];
          for (const player of teamPlayers){
            const playerSc = outRound.player[player.playerId];
            if (!playerSc) continue;
            const grossRaw = playerSc?.gross?.[i];
            const netRaw = playerSc?.net?.[i];
            const grossVal = grossRaw == null ? null : (Number.isFinite(Number(grossRaw)) ? Number(grossRaw) : null);
            const netVal = netRaw == null ? grossVal : (Number.isFinite(Number(netRaw)) ? Number(netRaw) : grossVal);
            const metricVal = useHandicap ? netVal : grossVal;
            if (metricVal == null) continue;
            candidates.push({ gross: grossVal, net: netVal, metric: metricVal });
          }
          if (!candidates.length) continue;

          candidates.sort((a, b) => a.metric - b.metric);
          const take = candidates.slice(0, Math.min(topX, candidates.length));
          const grossVals = take.map((x) => x.gross);
          const netVals = take.map((x) => x.net);
          const grossAgg = aggregateValuesByMode(grossVals, "sum");
          const netAgg = aggregateValuesByMode(netVals, "sum");
          if (grossAgg != null) gross[i] = grossAgg;
          if (netAgg != null) net[i] = netAgg;

          const parBase = Number(roundCourse.pars[i] || 0) * take.length;
          if (grossAgg != null) grossToPar[i] = grossAgg - parBase;
          if (netAgg != null) netToPar[i] = netAgg - parBase;
        }

        const grossTotal = sumPlayed(gross);
        const netTotal = sumPlayed(net);
        const thru = thruFromHoles(gross);
        const grossToParTotal = sumPlayed(grossToPar);
        const netToParTotal = sumPlayed(netToPar);

        outRound.team[teamId] = {
          gross, net, grossToPar, netToPar,
          handicapShots: Array(18).fill(0),
          grossTotal, netTotal,
          grossToParTotal, netToParTotal,
          thru
        };
      }
    } else {
      // team totals derived from players for that round (aggregation)
      const agg = round.teamAggregation || { mode:"avg", topX:4 };
      for (const teamId of Object.keys(teams)){
        const pids = Object.keys(players).filter(pid => players[pid].teamId === teamId);
        const grossPairs = pids.map(pid => {
          const p = outRound.player[pid];
          if (!p || !Number.isFinite(p.thru) || p.thru <= 0) return null;
          const parPlayed = p.grossTotal - p.grossToParTotal;
          return { strokes: p.grossTotal, par: parPlayed };
        }).filter(Boolean);

        const netPairs = pids.map(pid => {
          const p = outRound.player[pid];
          if (!p || !Number.isFinite(p.thru) || p.thru <= 0) return null;
          const parPlayed = p.grossTotal - p.grossToParTotal;
          return { strokes: p.netTotal, par: parPlayed };
        }).filter(Boolean);

        const grossAgg = bestXAggregateWithParSum(grossPairs, agg);
        const netAgg = bestXAggregateWithParSum(netPairs, agg);

        const playedThrus = pids
          .map(pid => outRound.player[pid]?.thru)
          .filter(v => Number.isFinite(v) && v > 0);
        const teamThru = playedThrus.length ? Math.min(...playedThrus) : null;

        if (!grossAgg && !netAgg){
          outRound.team[teamId] = {
            gross: Array(18).fill(null),
            net: Array(18).fill(null),
            grossToPar: Array(18).fill(null),
            netToPar: Array(18).fill(null),
            handicapShots: Array(18).fill(0),
            grossTotal: 0, netTotal: 0,
            grossToParTotal: 0, netToParTotal: 0,
            thru: teamThru
          };
          continue;
        }
        const grossStrokes = grossAgg?.strokes ?? 0;
        const grossParPlayed = grossAgg?.par ?? 0;
        const netStrokes = netAgg?.strokes ?? grossStrokes;
        const netParPlayed = netAgg?.par ?? grossParPlayed;
        outRound.team[teamId] = {
          gross: Array(18).fill(null),
          net: Array(18).fill(null),
          grossToPar: Array(18).fill(null),
          netToPar: Array(18).fill(null),
          handicapShots: Array(18).fill(0),
          grossTotal: grossStrokes,
          netTotal: netStrokes,
          grossToParTotal: grossStrokes - grossParPlayed,
          netToParTotal: netStrokes - netParPlayed,
          thru: teamThru
        };
      }
    }

    // Leaderboards for the round
    // Teams
    const teamRows = Object.keys(teams).map(teamId => {
      const tname = teams[teamId]?.teamName || "";
      const sc = outRound.team[teamId];
      if (!sc) return null;
      const strokes = sc.grossTotal;
      const grossToPar = toParStrFromDiff(sc.grossToParTotal);
      const netToPar = toParStrFromDiff(sc.netToParTotal);
      const thru = Number.isFinite(sc.thru) && sc.thru > 0 ? sc.thru : null;
      return {
        teamId, teamName: tname,
        strokes: Number.isFinite(strokes) ? Number(strokes.toFixed(2)) : 0,
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
          thru
        }
      };
    }).filter(Boolean).sort((a,b)=>a.strokes - b.strokes);

    // Players
    const playerRows = Object.keys(players).map(pid => {
      const p = players[pid];
      const sc = outRound.player[pid];
      if (!sc) return null;
      const strokes = useHandicap ? sc.netTotal : sc.grossTotal;
      const toParTotal = useHandicap ? sc.netToParTotal : sc.grossToParTotal;
      const teamName = teams[p.teamId]?.teamName || "";
      return {
        playerId: pid,
        name: p.name,
        teamName,
        strokes: Number.isFinite(strokes) ? Number(strokes.toFixed(2)) : 0,
        toPar: toParStrFromDiff(toParTotal),
        thru: sc.thru,
        scores: sc
      };
    }).filter(Boolean).sort((a,b)=>a.strokes - b.strokes);

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

  const teamTotals = new Map(Object.keys(teams).map(id => [id, { strokes:0, par:0 }]));
  const playerTotals = new Map(Object.keys(players).map(id => [id, { strokes:0, par:0 }]));

  for (let r=0;r<rounds.length;r++){
    const round = rounds[r] || {};
    const roundCourse = courseForRound(rounds, courses, r);
    const weight = normalizedWeights[r] ?? 1;
    const isScramble = round.format === "scramble";
    const isTwoMan = isTwoManFormat(round.format);
    const useHandicap = !!round.useHandicap;

    const derived = score_data.rounds[r];

    if (isScramble){
      for (const teamId of Object.keys(teams)){
        const sc = derived.team[teamId];
        if (!sc) continue;
        // par played is grossTotal - grossToParTotal
        const parPlayed = sc.grossTotal - sc.grossToParTotal;
        const strokes = useHandicap ? sc.netTotal : sc.grossTotal;
        const cur = teamTotals.get(teamId);
        cur.strokes += Number(strokes || 0) * weight;
        cur.par += Number(parPlayed || 0) * weight;
      }
      for (const pid of Object.keys(players)){
        const p = players[pid];
        const sc = derived.team[p?.teamId];
        if (!sc) continue;
        const parPlayed = sc.grossTotal - sc.grossToParTotal;
        const strokes = useHandicap ? sc.netTotal : sc.grossTotal;
        const cur = playerTotals.get(pid);
        cur.strokes += Number(strokes || 0) * weight;
        cur.par += Number(parPlayed || 0) * weight;
      }
      continue;
    }

    // player-based rounds: player totals
    const roundPlayer = new Map(); // pid -> {strokes, par}
    for (const pid of Object.keys(players)){
      const sc = derived.player[pid];
      if (!sc || !Number.isFinite(sc.thru) || sc.thru <= 0) continue;
      const strokes = useHandicap ? sc.netTotal : sc.grossTotal;
      const parPlayed = sc.grossTotal - sc.grossToParTotal;
      roundPlayer.set(pid, { strokes, par: parPlayed });

      const cur = playerTotals.get(pid);
      cur.strokes += Number(strokes || 0) * weight;
      cur.par += Number(parPlayed || 0) * weight;
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

          const parPlayed = gross.reduce((acc, v, i) => {
            return acc + (v == null ? 0 : Number(roundCourse.pars[i] || 0));
          }, 0);
          const strokes = useHandicap ? sumPlayed(net) : sumPlayed(gross);
          return { strokes, par: parPlayed };
        }).filter(Boolean);

        const cur = teamTotals.get(teamId);
        if (groupPairs.length){
          const groupCount = groupPairs.length;
          const avgStrokes = groupPairs.reduce((a, p) => a + Number(p.strokes || 0), 0) / groupCount;
          const avgPar = groupPairs.reduce((a, p) => a + Number(p.par || 0), 0) / groupCount;
          cur.strokes += avgStrokes * weight;
          cur.par += avgPar * weight;
          continue;
        }

        // Legacy fallback when group detail is unavailable.
        const parPlayed = sc.grossTotal - sc.grossToParTotal;
        const strokes = useHandicap ? sc.netTotal : sc.grossTotal;
        cur.strokes += Number(strokes || 0) * weight;
        cur.par += Number(parPlayed || 0) * weight;
      }
      continue;
    }

    const agg = round.teamAggregation || { mode:"avg", topX:4 };
    for (const teamId of Object.keys(teams)){
      const pids = Object.keys(players).filter(pid => players[pid].teamId === teamId);
      const pairs = pids.map(pid => roundPlayer.get(pid)).filter(Boolean);
      const aggOut = bestXAggregateWithPar(pairs, agg);
      if (!aggOut) continue;
      const cur = teamTotals.get(teamId);
      cur.strokes += Number(aggOut.strokes || 0) * weight;
      cur.par += Number(aggOut.par || 0) * weight;
    }
  }

  const teamLb = Object.keys(teams).map(teamId => {
    const tname = teams[teamId]?.teamName || "";
    const v = teamTotals.get(teamId) || { strokes:0, par:0 };
    const strokes = Number(v.strokes.toFixed(2));
    const toPar = (v.par === 0 && strokes === 0) ? "E" : toParStrFromDiff(strokes - v.par);
    return { teamId, teamName: tname, strokes, toPar, thru: null };
  }).sort((a,b)=>a.strokes - b.strokes);

  const playerLb = Object.keys(players).map(pid => {
    const p = players[pid];
    const v = playerTotals.get(pid) || { strokes:0, par:0 };
    const strokes = Number(v.strokes.toFixed(2));
    const toPar = (v.par === 0 && strokes === 0) ? "E" : toParStrFromDiff(strokes - v.par);
    const teamName = teams[p.teamId]?.teamName || "";
    return { playerId: pid, name: p.name, teamName, strokes, toPar, thru: null };
  }).sort((a,b)=>a.strokes - b.strokes);

  score_data.leaderboard_all.teams = teamLb;
  score_data.leaderboard_all.players = playerLb;

  const hasTwoManFormat = rounds.some(round => isTwoManFormat(round?.format));
  const playersByTeam = getPlayersByTeamMap(players);
  const publicTeams = Object.keys(teams).map(teamId => {
    const row = { teamId, teamName: teams[teamId].teamName };
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
    tournament: { tournamentId: t.tournamentId, name: t.name, dates: t.dates, rounds },
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
      tournament: { name: state.tournament.name, dates: state.tournament.dates },
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
