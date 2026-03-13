// --------- CONFIG ---------
export const API_BASE = "https://1rmb4h6ty8.execute-api.us-east-1.amazonaws.com/prod";
export const STATIC_BASE = "https://golf-public.s3.us-east-1.amazonaws.com";

export const ADMIN_KEY = "ADMIN_RTR"; // optional if backend checks x-admin-key
export const STORAGE_KEYS = {
  tournamentId: "golf:lastTournamentId",
  playerCode: "golf:lastPlayerCode",
  tournamentEditCodePrefix: "golf:tournamentEditCode:",
};

export async function api(path, { method="GET", body=null, headers={} } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(ADMIN_KEY ? {"x-admin-key": ADMIN_KEY} : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : null
  });

  const ct = (res.headers.get("Content-Type") || "").toLowerCase();
  const isJson = ct.includes("application/json");

  // 204 No Content
  if (res.status === 204) return null;

  const payload = isJson ? await res.json().catch(()=>null) : await res.text().catch(()=> "");
  if (!res.ok) {
    const err = new Error(
      isJson && payload?.message ? payload.message :
      isJson && payload?.error ? payload.error :
      `API ${res.status}`
    );
    err.status = res.status;
    err.data = payload;
    throw err;
  }

  return payload;
}


export async function staticJson(path, { cacheKey=null } = {}){
  const url = `${STATIC_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
  void cacheKey;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok){
    const txt = await res.text().catch(()=> "");
    throw new Error(`STATIC ${res.status}: ${txt}`);
  }
  return res.json();
}

export function qs(name){ return new URLSearchParams(location.search).get(name); }
export function sum(arr){ return arr.reduce((a,b)=>a+b,0); }

function safeGetStorage(key){
  try{
    return localStorage.getItem(key);
  }catch(_){
    return null;
  }
}

function safeSetStorage(key, value){
  try{
    localStorage.setItem(key, value);
  }catch(_){}
}

export function rememberTournamentId(tournamentId){
  const tid = String(tournamentId || "").trim();
  if (!tid) return;
  safeSetStorage(STORAGE_KEYS.tournamentId, tid);
}

export function getRememberedTournamentId(){
  return String(safeGetStorage(STORAGE_KEYS.tournamentId) || "").trim();
}

export function rememberPlayerCode(playerCode){
  const code = String(playerCode || "").trim();
  if (!code) return;
  safeSetStorage(STORAGE_KEYS.playerCode, code);
}

export function getRememberedPlayerCode(){
  return String(safeGetStorage(STORAGE_KEYS.playerCode) || "").trim();
}

function tournamentEditCodeKey(tournamentId){
  const tid = String(tournamentId || "").trim();
  if (!tid) return "";
  return `${STORAGE_KEYS.tournamentEditCodePrefix}${tid}`;
}

export function rememberTournamentEditCode(tournamentId, editCode){
  const key = tournamentEditCodeKey(tournamentId);
  const code = String(editCode || "").trim();
  if (!key || !code) return;
  safeSetStorage(key, code);
}

export function getRememberedTournamentEditCode(tournamentId){
  const key = tournamentEditCodeKey(tournamentId);
  if (!key) return "";
  return String(safeGetStorage(key) || "").trim();
}

export function downloadText(filename, text){
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function baseUrlForGithubPages(){
  const url = new URL(location.href);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/[^/]+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function setHeaderTournamentName(name){
  const titleEl = document.querySelector(".brand [data-brand-title]");
  if (!titleEl) return;
  const normalizedName = String(name || "").trim();
  titleEl.textContent = normalizedName || "Golf Tournament";
}

// Handicap strokes allocation by stroke index (1 hardest..18 easiest)
export function strokesPerHole(handicap, strokeIndex18){
  const H = Math.max(0, Math.floor(Number(handicap) || 0));
  const base = Math.floor(H / 18);
  const rem = H % 18;
  return strokeIndex18.map(si => base + (si <= rem ? 1 : 0));
}

export function toPar(total, parTotal){
  const diff = total - parTotal;
  if (diff === 0) return "E";
  return diff > 0 ? `+${diff}` : `${diff}`;
}

export function dotsForStrokes(n){
  if (!n) return "";
  // cap visually; if >2 we show "••+"
  if (n === 1) return "•";
  if (n === 2) return "••";
  return "••+";
}

export const TEAM_COLORS = [
  "#b31b1b",
  "#d05533",
  "#d3894c",
  "#d4cb61",
  "#a9c766",
  "#84b676",
  "#63b47b",
  "#63b4b3",
  "#5a9fd0",
  "#6e83d6",
  "#7a66c3",
  "#a66fd1"
];

function normalizeTeamColorId(teamId){
  return teamId == null ? "" : String(teamId).trim();
}

function normalizeTeamColorName(teamName){
  return String(teamName || "").trim().toLowerCase();
}

export function createTeamColorRegistry(){
  let byId = new Map();
  let byName = new Map();
  let nextIdx = 0;
  let scaleTotal = 0;
  let assignedCount = 0;

  function nextColor(){
    let colorIdx;
    if (scaleTotal > 1) {
      // Spread selections across the full palette when team count is small.
      colorIdx = Math.round((assignedCount * (TEAM_COLORS.length - 1)) / (scaleTotal - 1));
    } else if (scaleTotal === 1) {
      colorIdx = 0;
    } else {
      colorIdx = nextIdx % TEAM_COLORS.length;
      nextIdx += 1;
    }
    assignedCount += 1;
    const color = TEAM_COLORS[colorIdx % TEAM_COLORS.length];
    return color;
  }

  function add(teamId, teamName){
    const id = normalizeTeamColorId(teamId);
    const nKey = normalizeTeamColorName(teamName);

    if (id && byId.has(id)) {
      const color = byId.get(id);
      if (nKey && !byName.has(nKey)) byName.set(nKey, color);
      return color;
    }
    if (!id && nKey && byName.has(nKey)) return byName.get(nKey);

    const color = nextColor();
    if (id) byId.set(id, color);
    if (nKey) byName.set(nKey, color);
    return color;
  }

  function get(teamId, teamName){
    const id = normalizeTeamColorId(teamId);
    const nKey = normalizeTeamColorName(teamName);
    if (id && byId.has(id)) return byId.get(id);
    if (nKey && byName.has(nKey)) return byName.get(nKey);
    return add(id, teamName);
  }

  function reset(total = 0){
    byId = new Map();
    byName = new Map();
    nextIdx = 0;
    scaleTotal = Math.max(0, Number(total) || 0);
    assignedCount = 0;
  }

  return { add, get, reset };
}
