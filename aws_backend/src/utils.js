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
  return arr.reduce((a,v)=>a+(v==null?0:Number(v)),0);
}

export function thruFromHoles(arr){
  let last = -1;
  for (let i=0;i<arr.length;i++){
    const v = arr[i];
    if (v != null && Number(v) > 0) last = i;
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

function scrambleTeamHandicap(teamPlayers){
  const vals = (teamPlayers || [])
    .map(p => Number(p?.handicap ?? 0))
    .filter(Number.isFinite)
    .map(v => Math.max(0, v));
  if (!vals.length) return 0;
  const avg = vals.reduce((a,b)=>a+b,0) / vals.length;
  return Math.round(avg);
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

function splitTwoManGroups(teamPlayers){
  const groupA = [];
  const groupB = [];
  const ungrouped = [];

  for (const player of teamPlayers || []){
    const g = String(player?.group || "").trim().toUpperCase();
    if (g === "A") groupA.push(player);
    else if (g === "B") groupB.push(player);
    else ungrouped.push(player);
  }

  while (groupA.length < 2 && ungrouped.length) groupA.push(ungrouped.shift());
  while (groupB.length < 2 && ungrouped.length) groupB.push(ungrouped.shift());

  return { A: groupA, B: groupB };
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
  const rounds = state.rounds || [];
  const course = state.course || { pars: Array(18).fill(4), strokeIndex: Array.from({length:18},(_,i)=>i+1) };
  const teams = state.teams || {};
  const players = state.players || {};
  const scores = state.scores || { rounds: [] };

  const score_data = {
    rounds: [],
    leaderboard_all: { teams: [], players: [] }
  };

  // Precompute per-round derived
  for (let r=0;r<rounds.length;r++){
    const round = rounds[r] || {};
    const isScramble = round.format === "scramble";
    const isTwoManBestBall = round.format === "two_man_best_ball";
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
    if (!isScramble){
      for (const pid of Object.keys(players)){
        const gross = (roundScores.players?.[pid]?.holes || Array(18).fill(null)).map(v => (v === 0 ? null : v));
        const hcp = Number(players[pid]?.handicap || 0);
        const shots = useHandicap ? strokesPerHole(hcp, course.strokeIndex) : Array(18).fill(0);
        const net = gross.map((v,i)=> v==null ? null : (Number(v) - Number(shots[i]||0)));
        const grossToPar = gross.map((v,i)=> v==null ? null : (Number(v) - Number(course.pars[i]||0)));
        const netToPar = net.map((v,i)=> v==null ? null : (Number(v) - Number(course.pars[i]||0)));
        const parPlayed = gross.reduce((acc,v,i)=>acc+(v==null?0:Number(course.pars[i]||0)),0);
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
        const shots = useHandicap ? strokesPerHole(teamHcp, course.strokeIndex) : Array(18).fill(0);
        const net = gross.map((v,i)=> v==null ? null : (Number(v) - Number(shots[i]||0)));
        const grossToPar = gross.map((v,i)=> v==null?null:(Number(v)-Number(course.pars[i]||0)));
        const netToPar = net.map((v,i)=> v==null ? null : (Number(v) - Number(course.pars[i]||0)));
        const parPlayed = gross.reduce((acc,v,i)=>acc+(v==null?0:Number(course.pars[i]||0)),0);
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
    } else if (isTwoManBestBall){
      const playersByTeam = getPlayersByTeamMap(players);

      for (const teamId of Object.keys(teams)){
        const teamPlayers = playersByTeam.get(teamId) || [];
        const groups = splitTwoManGroups(teamPlayers);

        const groupGross = { A: Array(18).fill(null), B: Array(18).fill(null) };
        const groupNet = { A: Array(18).fill(null), B: Array(18).fill(null) };

        for (let i=0;i<18;i++){
          const groupAGrossVals = groups.A
            .map(p => outRound.player[p.playerId]?.gross?.[i])
            .filter(v => Number.isFinite(v));
          const groupBGrossVals = groups.B
            .map(p => outRound.player[p.playerId]?.gross?.[i])
            .filter(v => Number.isFinite(v));
          const groupANetVals = groups.A
            .map(p => outRound.player[p.playerId]?.net?.[i])
            .filter(v => Number.isFinite(v));
          const groupBNetVals = groups.B
            .map(p => outRound.player[p.playerId]?.net?.[i])
            .filter(v => Number.isFinite(v));

          groupGross.A[i] = groupAGrossVals.length ? Math.min(...groupAGrossVals) : null;
          groupGross.B[i] = groupBGrossVals.length ? Math.min(...groupBGrossVals) : null;
          groupNet.A[i] = groupANetVals.length ? Math.min(...groupANetVals) : null;
          groupNet.B[i] = groupBNetVals.length ? Math.min(...groupBNetVals) : null;
        }

        const gross = Array(18).fill(null);
        const net = Array(18).fill(null);
        for (let i=0;i<18;i++){
          const aGross = groupGross.A[i];
          const bGross = groupGross.B[i];
          const aNet = groupNet.A[i];
          const bNet = groupNet.B[i];
          if (aGross != null && bGross != null) gross[i] = Number(aGross) + Number(bGross);
          if (aNet != null && bNet != null) net[i] = Number(aNet) + Number(bNet);
        }

        const grossToPar = gross.map((v,i)=> v==null ? null : (Number(v) - Number(course.pars[i] || 0)));
        const netToPar = net.map((v,i)=> v==null ? null : (Number(v) - Number(course.pars[i] || 0)));
        const parPlayed = gross.reduce((acc,v,i)=>acc+(v==null?0:Number(course.pars[i] || 0)),0);
        const grossTotal = sumPlayed(gross);
        const netTotal = sumPlayed(net);
        const thru = thruFromHoles(gross);
        const grossToParTotal = grossTotal - parPlayed;
        const netToParTotal = netTotal - parPlayed;

        outRound.team[teamId] = {
          gross, net, grossToPar, netToPar,
          handicapShots: Array(18).fill(0),
          grossTotal, netTotal,
          grossToParTotal, netToParTotal,
          thru,
          groups: {
            A: { label: "Group A", playerIds: groups.A.map(p => p.playerId), gross: groupGross.A, net: groupNet.A },
            B: { label: "Group B", playerIds: groups.B.map(p => p.playerId), gross: groupGross.B, net: groupNet.B }
          }
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
    const weight = normalizedWeights[r] ?? 1;
    const isScramble = round.format === "scramble";
    const isTwoManBestBall = round.format === "two_man_best_ball";
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

    if (isTwoManBestBall){
      for (const teamId of Object.keys(teams)){
        const sc = derived.team[teamId];
        if (!sc) continue;
        const parPlayed = sc.grossTotal - sc.grossToParTotal;
        const strokes = useHandicap ? sc.netTotal : sc.grossTotal;
        const cur = teamTotals.get(teamId);
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

  const hasTwoManBestBall = rounds.some(round => round?.format === "two_man_best_ball");
  const playersByTeam = getPlayersByTeamMap(players);
  const publicTeams = Object.keys(teams).map(teamId => {
    const row = { teamId, teamName: teams[teamId].teamName };
    if (!hasTwoManBestBall) return row;
    const groups = splitTwoManGroups(playersByTeam.get(teamId) || []);
    return {
      ...row,
      groups: {
        A: groups.A.map(p => p.playerId),
        B: groups.B.map(p => p.playerId)
      }
    };
  });

  return {
    tournament: { tournamentId: t.tournamentId, name: t.name, dates: t.dates, rounds },
    course,
    teams: publicTeams,
    players: Object.keys(players).map(id => ({
      playerId:id,
      name: players[id].name,
      teamId: players[id].teamId,
      handicap: players[id].handicap,
      group: players[id].group || null
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
  const rounds = state.rounds || [];
  const course = state.course || { pars: Array(18).fill(4), strokeIndex: Array.from({length:18},(_,i)=>i+1) };
  const scores = state.scores || { rounds: [] };

  for (const pid of Object.keys(state.players || {})){
    const p = state.players[pid];
    if (!p?.code) continue;
    const team = teamsMap[p.teamId] || { teamId: p.teamId, teamName: "" };

    const saved = rounds.map((round, rIdx) => {
      const isScramble = round.format === "scramble";
      const target = isScramble ? "team" : "player";
      const gross = isScramble
        ? (scores.rounds?.[rIdx]?.teams?.[p.teamId]?.holes || Array(18).fill(null))
        : (scores.rounds?.[rIdx]?.players?.[pid]?.holes || Array(18).fill(null));
      return { roundIndex:rIdx, target, gross: gross.map(v => (v===0?null:v)) };
    });
    const enterObj = {
      code: p.code,
      tournamentId: tid,
      tournament: { name: state.tournament.name, dates: state.tournament.dates },
      rounds,
      course,
      player: { playerId: pid, name: p.name, handicap: p.handicap, group: p.group || null },
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
