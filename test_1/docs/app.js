// --------- CONFIG ---------
export const API_BASE = "https://7pe1ewlr9g.execute-api.us-east-1.amazonaws.com/prod";
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
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json();
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
