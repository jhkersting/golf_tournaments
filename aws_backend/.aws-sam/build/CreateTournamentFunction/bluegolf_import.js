import { normalizeCourseRecord, teeKeyForMeta } from "./course_data.js";

const OVERVIEW_BASE = "https://app.bluegolf.com/bluegolf/app/course";
const SCORECARD_BASE = "https://course.bluegolf.com/bluegolf/course/course";
const DEFAULT_TIMEOUT_MS = 30000;

function trimText(value) {
  return String(value || "").trim();
}

function normalizeBlueGolfInput(input) {
  const raw = trimText(input);
  if (!raw) {
    const error = new Error("BlueGolf URL is required.");
    error.statusCode = 400;
    throw error;
  }
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[a-z0-9-]+$/i.test(raw)) return `${SCORECARD_BASE}/${raw}/overview.htm`;
  return `https://${raw.replace(/^\/+/, "")}`;
}

export function extractBlueGolfCourseSlug(input) {
  const normalized = normalizeBlueGolfInput(input);
  const pathMatch = normalized.match(/\/course\/course\/([^/?#]+)/i)
    || normalized.match(/\/app\/course\/([^/?#]+)/i);
  if (pathMatch?.[1]) return pathMatch[1];

  try {
    const url = new URL(normalized);
    const parts = url.pathname.split("/").filter(Boolean);
    for (let idx = 0; idx < parts.length - 1; idx++) {
      if (parts[idx] === "course" && parts[idx + 1] && parts[idx + 1] !== "course") {
        return trimText(parts[idx + 1]).replace(/\.json$/i, "");
      }
    }
  } catch {
    const error = new Error("Invalid BlueGolf URL.");
    error.statusCode = 400;
    throw error;
  }

  const error = new Error("Could not determine BlueGolf course slug from URL.");
  error.statusCode = 400;
  throw error;
}

function blueGolfUrls(slug) {
  const cleanSlug = trimText(slug);
  return {
    overviewJsonUrl: `${OVERVIEW_BASE}/${cleanSlug}/overview.json`,
    scorecardHtmlUrl: `${SCORECARD_BASE}/${cleanSlug}/detailedscorecard.htm`,
    canonicalUrl: `${SCORECARD_BASE}/${cleanSlug}/overview.htm`
  };
}

function isChallengePage(text) {
  const lower = String(text || "").toLowerCase();
  return lower.includes("enable cookies")
    || lower.includes("just a moment")
    || lower.includes("attention required")
    || lower.includes("cf-browser-verification")
    || lower.includes("cloudflare");
}

function previewText(text, maxLength = 160) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

async function fetchBlueGolfText(url, { accept = "*/*", referer = SCORECARD_BASE } = {}) {
  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    headers: {
      "accept": accept,
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "no-cache",
      "pragma": "no-cache",
      "referer": referer,
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
    }
  });

  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`BlueGolf request failed (${response.status}) for ${url}`);
    error.statusCode = 502;
    error.preview = previewText(text);
    throw error;
  }
  if (isChallengePage(text)) {
    const error = new Error(`BlueGolf blocked request for ${url}`);
    error.statusCode = 502;
    error.preview = previewText(text);
    throw error;
  }
  return text;
}

function cleanHtmlText(raw) {
  return String(raw || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function toInt(raw) {
  const match = String(raw || "").match(/-?\d+/);
  if (!match) return null;
  const value = Number.parseInt(match[0], 10);
  return Number.isFinite(value) ? value : null;
}

function collapseHoleCells(cells) {
  if (cells.length >= 21) {
    return cells.slice(0, 9).concat(cells.slice(10, 19));
  }
  return cells.slice(0, 18);
}

function parseRowValues(tableHtml, rowLabels) {
  const labels = Array.isArray(rowLabels) ? rowLabels : [rowLabels];
  const wanted = labels.map((value) => String(value || "").trim().toLowerCase());
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellPattern = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;

  for (const rowMatch of tableHtml.matchAll(rowPattern)) {
    const rowHtml = rowMatch[1] || "";
    const cellValues = [...rowHtml.matchAll(cellPattern)].map((match) => cleanHtmlText(match[1] || ""));
    if (!cellValues.length) continue;
    if (!wanted.includes(String(cellValues[0] || "").toLowerCase())) continue;
    const parsed = collapseHoleCells(cellValues.slice(1)).map((value) => toInt(value));
    if (parsed.length === 18 && parsed.every((value) => value !== null)) return parsed;
  }
  return null;
}

function parseScorecardSummaryItems(summaryHtml) {
  const out = {};
  const itemPattern = /<li[^>]*>\s*<span>([\s\S]*?)<\/span>\s*<p>([\s\S]*?)<\/p>\s*<\/li>/gi;
  for (const match of summaryHtml.matchAll(itemPattern)) {
    const value = cleanHtmlText(match[1] || "");
    const label = cleanHtmlText(match[2] || "").toLowerCase();
    if (label) out[label] = value;
  }
  return out;
}

function parseTeeMenuEntries(scorecardHtml) {
  const menuMatch = scorecardHtml.match(/<ul class="dropdown-menu">([\s\S]*?)<\/ul>/i);
  if (!menuMatch) return [];

  const entries = [];
  const entryPattern = /<a[^>]+href="#(dropdown-tee-[^"]+)"[^>]*>[\s\S]*?<span class="ddm-first ddm-mid ddm-center">([\s\S]*?)<\/span>[\s\S]*?<span class="stat[^"]*">\((.*?)\)<\/span>/gi;
  for (const match of menuMatch[1].matchAll(entryPattern)) {
    const tabId = trimText(match[1]);
    const teeName = cleanHtmlText(match[2] || "");
    if (teeName.toLowerCase() === "show all") continue;
    const statText = cleanHtmlText(match[3] || "");
    const statMatch = statText.match(/^([a-z])\s*-\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*([0-9]+)/i);
    entries.push({
      tabId,
      teeName,
      gender: statMatch?.[1] ? statMatch[1].toUpperCase() : "",
      rating: statMatch?.[2] ? Number.parseFloat(statMatch[2]) : null,
      slope: statMatch?.[3] ? Number.parseInt(statMatch[3], 10) : null
    });
  }
  return entries;
}

export function parseScorecardTees(scorecardHtml) {
  const menuEntries = new Map(parseTeeMenuEntries(scorecardHtml).map((entry) => [entry.tabId, entry]));
  const teePattern = /<div class="text-uppercase tab-pane\s+tee-tab(?: active in)?" id="(dropdown-tee-[^"]+)">([\s\S]*?<ul class="scorecard d-table-cell w-100">[\s\S]*?<\/ul>[\s\S]*?<table[^>]*>[\s\S]*?<\/table>)/gi;
  const tees = [];

  for (const match of scorecardHtml.matchAll(teePattern)) {
    const tabId = trimText(match[1]);
    const bodyHtml = match[2] || "";
    const summaryMatch = bodyHtml.match(/<ul class="scorecard d-table-cell w-100">([\s\S]*?)<\/ul>/i);
    const tableMatch = bodyHtml.match(/(<table[^>]*>[\s\S]*?<\/table>)/i);
    if (!summaryMatch || !tableMatch) continue;

    const summaryItems = parseScorecardSummaryItems(summaryMatch[1]);
    const holeYardages = parseRowValues(tableMatch[1], ["yds", "yards", "yardage"]);
    if (!holeYardages) continue;

    const menuEntry = menuEntries.get(tabId) || {};
    let teeName = trimText(menuEntry.teeName);
    if (!teeName) {
      const teeNameMatch = bodyHtml.match(/<span class="ddm-cell ddm-word text-uppercase">([\s\S]*?)<\/span>/i);
      teeName = cleanHtmlText(teeNameMatch?.[1] || tabId);
    }

    const ratingText = summaryItems.rating || "";
    const slopeText = summaryItems.slope || "";
    tees.push({
      tabId,
      teeName,
      gender: trimText(menuEntry.gender).toUpperCase(),
      parTotal: toInt(summaryItems.par),
      totalYards: toInt(summaryItems.yards) ?? holeYardages.reduce((total, value) => total + Number(value || 0), 0),
      rating: /\d/.test(ratingText) ? Number.parseFloat(ratingText) : menuEntry.rating,
      slope: toInt(slopeText) ?? menuEntry.slope ?? null,
      holeYardages
    });
  }

  const seen = new Set();
  return tees
    .filter((tee) => {
      if (seen.has(tee.tabId)) return false;
      seen.add(tee.tabId);
      return true;
    })
    .sort((a, b) => {
      const yardsDiff = Number(b.totalYards || 0) - Number(a.totalYards || 0);
      if (yardsDiff !== 0) return yardsDiff;
      const teeCmp = String(a.teeName || "").localeCompare(String(b.teeName || ""));
      if (teeCmp !== 0) return teeCmp;
      return String(a.gender || "").localeCompare(String(b.gender || ""));
    });
}

function groupLongestTees(tees, limit = 3) {
  const grouped = new Map();
  for (const tee of tees) {
    const key = JSON.stringify([
      trimText(tee.teeName),
      Math.round(Number(tee.totalYards) || 0),
      Array.isArray(tee.holeYardages) ? tee.holeYardages.map((value) => Number(value) || 0) : []
    ]);
    const ratingEntries = Array.isArray(tee.ratings) && tee.ratings.length
      ? tee.ratings.map((entry) => ({
          ...(trimText(entry?.gender) ? { gender: trimText(entry.gender).toUpperCase() } : {}),
          ...(Number.isFinite(Number(entry?.rating)) ? { rating: Number(Number(entry.rating).toFixed(1)) } : {}),
          ...(Number.isFinite(Number(entry?.slope)) ? { slope: Math.round(Number(entry.slope)) } : {})
        })).filter((entry) => Object.keys(entry).length)
      : [
          {
            ...(trimText(tee.gender) ? { gender: trimText(tee.gender).toUpperCase() } : {}),
            ...(Number.isFinite(Number(tee.rating)) ? { rating: Number(Number(tee.rating).toFixed(1)) } : {}),
            ...(Number.isFinite(Number(tee.slope)) ? { slope: Math.round(Number(tee.slope)) } : {})
          }
        ].filter((entry) => Object.keys(entry).length);
    if (!grouped.has(key)) {
      grouped.set(key, {
        teeName: tee.teeName,
        parTotal: tee.parTotal,
        totalYards: Math.round(Number(tee.totalYards) || 0),
        holeYardages: (tee.holeYardages || []).map((value) => Number(value) || 0),
        ratings: ratingEntries.slice()
      });
      continue;
    }
    const current = grouped.get(key);
    for (const ratingEntry of ratingEntries) {
      const exists = current.ratings.some((entry) => entry.gender === ratingEntry.gender && entry.rating === ratingEntry.rating && entry.slope === ratingEntry.slope);
      if (!exists) current.ratings.push(ratingEntry);
    }
  }

  return [...grouped.values()]
    .sort((a, b) => {
      const yardsDiff = Number(b.totalYards || 0) - Number(a.totalYards || 0);
      if (yardsDiff !== 0) return yardsDiff;
      return String(a.teeName || "").localeCompare(String(b.teeName || ""));
    })
    .slice(0, limit)
    .map((tee) => ({
      ...tee,
      teeKey: teeKeyForMeta(tee.teeName, tee.totalYards, tee.holeYardages)
    }));
}

export function parseScorecardCourseInfo(scorecardHtml) {
  const titleMatch = scorecardHtml.match(/<title>([\s\S]*?)<\/title>/i);
  const rawTitle = cleanHtmlText(titleMatch?.[1] || "");
  let name = rawTitle
    .replace(/\s*-\s*Detailed Scorecard(?:\s*\|\s*Course Database)?\s*$/i, "")
    .replace(/\s*\|\s*Course Database\s*$/i, "")
    .trim();
  if (!name) {
    const h3Match = scorecardHtml.match(/<h3[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/i);
    name = cleanHtmlText(h3Match?.[1] || "") || "BlueGolf Course";
  }

  const locationMatch = scorecardHtml.match(/<li class="nav-item pl-0 ml-0">([\s\S]*?)<\/li>/i);
  const location = cleanHtmlText(locationMatch?.[1] || "");
  const tables = [...scorecardHtml.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)].map((match) => match[1] || "");

  let pars = null;
  let strokeIndex = null;
  for (const tableHtml of tables) {
    const parsedPars = parseRowValues(tableHtml, "Par");
    const parsedHcp = parseRowValues(tableHtml, ["Hcp", "Hdcp", "Handicap"]);
    if (parsedPars && parsedHcp) {
      pars = parsedPars;
      strokeIndex = parsedHcp;
      break;
    }
  }

  if (!pars || !strokeIndex) {
    const error = new Error("Could not parse 18-hole Par/Hcp rows from BlueGolf detailed scorecard HTML.");
    error.statusCode = 502;
    throw error;
  }

  const tees = parseScorecardTees(scorecardHtml).map((tee) => ({
    teeKey: teeKeyForMeta(tee.teeName, tee.totalYards, tee.holeYardages),
    teeName: tee.teeName,
    ...(Number.isFinite(Number(tee.parTotal)) ? { parTotal: Math.round(Number(tee.parTotal)) } : {}),
    ...(Number.isFinite(Number(tee.totalYards)) ? { totalYards: Math.round(Number(tee.totalYards)) } : {}),
    ...(Array.isArray(tee.holeYardages) && tee.holeYardages.length === 18 ? { holeYardages: tee.holeYardages.slice() } : {}),
    ratings: [
      {
        ...(trimText(tee.gender) ? { gender: trimText(tee.gender).toUpperCase() } : {}),
        ...(Number.isFinite(Number(tee.rating)) ? { rating: Number(Number(tee.rating).toFixed(1)) } : {}),
        ...(Number.isFinite(Number(tee.slope)) ? { slope: Math.round(Number(tee.slope)) } : {})
      }
    ].filter((entry) => Object.keys(entry).length)
  }));

  return {
    name,
    location,
    pars,
    strokeIndex,
    tees,
    longestTees: groupLongestTees(tees, 3)
  };
}

function parseOverviewPayload(text, url) {
  const trimmed = String(text || "").trim();
  if (!trimmed || trimmed.startsWith("<")) {
    const error = new Error(`BlueGolf overview response was not JSON for ${url}`);
    error.statusCode = 502;
    error.preview = previewText(trimmed);
    throw error;
  }
  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    const error = new Error(`BlueGolf overview JSON could not be parsed for ${url}`);
    error.statusCode = 502;
    error.preview = previewText(trimmed);
    throw error;
  }
  if (!Array.isArray(payload?.holes) || !payload.holes.length) {
    const error = new Error(`BlueGolf overview JSON did not contain holes for ${url}`);
    error.statusCode = 502;
    throw error;
  }
  return payload;
}

export async function importBlueGolfCourse(bluegolfUrl) {
  const slug = extractBlueGolfCourseSlug(bluegolfUrl);
  const urls = blueGolfUrls(slug);

  const [overviewText, scorecardHtml] = await Promise.all([
    fetchBlueGolfText(urls.overviewJsonUrl, {
      accept: "application/json,text/plain,*/*",
      referer: urls.canonicalUrl
    }),
    fetchBlueGolfText(urls.scorecardHtmlUrl, {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      referer: urls.canonicalUrl
    })
  ]);

  const overview = parseOverviewPayload(overviewText, urls.overviewJsonUrl);
  const scorecard = parseScorecardCourseInfo(scorecardHtml);
  const selectedTee = scorecard.longestTees?.[0] || scorecard.tees?.[0] || null;

  const imported = normalizeCourseRecord({
    name: scorecard.name,
    pars: scorecard.pars,
    strokeIndex: scorecard.strokeIndex,
    bluegolfCourseSlug: slug,
    bluegolfUrl: urls.canonicalUrl,
    selectedTeeKey: selectedTee?.teeKey || "",
    teeName: selectedTee?.teeName,
    totalYards: selectedTee?.totalYards,
    parTotal: selectedTee?.parTotal,
    holeYardages: selectedTee?.holeYardages,
    ratings: selectedTee?.ratings,
    tees: scorecard.tees,
    longestTees: scorecard.longestTees
  });

  if (!imported) {
    const error = new Error("Failed to build BlueGolf course payload.");
    error.statusCode = 502;
    throw error;
  }

  return {
    course: imported,
    metadata: {
      bluegolfCourseSlug: slug,
      bluegolfUrl: urls.canonicalUrl,
      holeCount: Array.isArray(overview?.holes) ? overview.holes.length : 0
    }
  };
}
