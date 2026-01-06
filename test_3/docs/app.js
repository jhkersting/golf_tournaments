// --------- CONFIG ---------
export const API_BASE = "https://1rmb4h6ty8.execute-api.us-east-1.amazonaws.com/prod";
export const STATIC_BASE = "https://golf-public.s3.us-east-1.amazonaws.com";

export const ADMIN_KEY = "ADMIN_RTR"; // optional if backend checks x-admin-key

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
  const key = cacheKey || `static:${url}`;
  const metaKey = `${key}:meta`;

  const meta = (() => {
    try{ return JSON.parse(localStorage.getItem(metaKey) || "null"); } catch { return null; }
  })();

  // Render from cache immediately if present; caller can decide
  const headers = {};
  if (meta?.etag) headers["If-None-Match"] = meta.etag;

  const res = await fetch(url, { headers, cache: "no-cache" });
  if (res.status === 304 && meta?.json){
    return meta.json;
  }
  if (!res.ok){
    // fallback to cached if available
    if (meta?.json) return meta.json;
    const txt = await res.text().catch(()=> "");
    throw new Error(`STATIC ${res.status}: ${txt}`);
  }

  const etag = res.headers.get("ETag") || res.headers.get("etag");
  const jsonData = await res.json();
  try{
    localStorage.setItem(metaKey, JSON.stringify({ etag, json: jsonData, ts: Date.now() }));
  }catch(_){}

  return jsonData;
}

export function qs(name){ return new URLSearchParams(location.search).get(name); }
export function sum(arr){ return arr.reduce((a,b)=>a+b,0); }

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
