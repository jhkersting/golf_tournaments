import {
  api,
  staticJson,
  qs,
  dotsForStrokes,
  getRememberedTournamentId,
  rememberTournamentId
} from "./app.js";

const tidFromQuery = qs("t");
if (tidFromQuery) rememberTournamentId(tidFromQuery);
const tid = tidFromQuery || getRememberedTournamentId();
const roundFilter = document.getElementById("round_filter");
const btnTeam = document.getElementById("btn_team");
const btnPlayer = document.getElementById("btn_player");
const toggleNote = document.getElementById("toggle_note");
const lbTitle = document.getElementById("lb_title");
const lbTbl = document.getElementById("lb_tbl");
const updated = document.getElementById("updated");
const status = document.getElementById("status");
const raw = document.getElementById("raw");

const scorecardCard = document.getElementById("scorecard_card");

let mode = "player"; // "team" | "player"
let currentRound = "all"; // "all" | number
let TOURN = null;

let openInlineKey = null;
let openInlineRow = null;
let inlineReqToken = 0;

function toParStrFromDiff(diff) {
  const d = Math.round(Number(diff) || 0);
  if (d === 0) return "E";
  return d > 0 ? `+${d}` : `${d}`;
}

function sumHoles(arr) {
  return (arr || []).reduce((a, v) => a + (v == null ? 0 : Number(v) || 0), 0);
}

function isPlayedScore(v) {
  return v != null && Number(v) > 0;
}

function hasAnyScore(arr) {
  if (!Array.isArray(arr)) return false;
  for (const v of arr) {
    if (isPlayedScore(v)) return true;
  }
  return false;
}

function rowHasAnyData(row) {
  if (!row) return false;
  if (Number(row.thru || 0) > 0) return true;
  if (Number(row.strokes || 0) > 0) return true;
  if (Number(row.gross || 0) > 0) return true;
  if (Number(row.net || 0) > 0) return true;
  if (Number(row.grossTotal || 0) > 0) return true;
  if (Number(row.netTotal || 0) > 0) return true;
  if (hasAnyScore(row.scores?.gross)) return true;
  if (hasAnyScore(row.scores?.net)) return true;
  return false;
}

function leaderboardHasAnyData(leaderboard) {
  const teams = leaderboard?.teams || [];
  for (const row of teams) {
    if (rowHasAnyData(row)) return true;
  }
  const players = leaderboard?.players || [];
  for (const row of players) {
    if (rowHasAnyData(row)) return true;
  }
  return false;
}

function roundHasAnyData(roundData) {
  if (!roundData) return false;
  if (leaderboardHasAnyData(roundData.leaderboard)) return true;

  const teamEntries = Object.values(roundData.team || {});
  for (const t of teamEntries) {
    if (hasAnyScore(t?.gross) || hasAnyScore(t?.net)) return true;
  }

  const playerEntries = Object.values(roundData.player || {});
  for (const p of playerEntries) {
    if (hasAnyScore(p?.gross) || hasAnyScore(p?.net)) return true;
  }
  return false;
}

function newestRoundWithDataIndex(tournamentJson) {
  const rounds = tournamentJson?.tournament?.rounds || [];
  if (!rounds.length) return -1;
  const scoreRounds = tournamentJson?.score_data?.rounds || [];
  for (let i = rounds.length - 1; i >= 0; i--) {
    if (roundHasAnyData(scoreRounds[i])) return i;
  }
  return 0;
}

function roundAt(viewRound) {
  if (viewRound === "all") return null;
  return (TOURN?.tournament?.rounds || [])[Number(viewRound)] || null;
}

function isHandicapRound(viewRound) {
  const round = roundAt(viewRound);
  if (!round) return false;
  return !!round.useHandicap && round.format !== "scramble";
}

function leaderboardColCount(data) {
  return 5;
}

function scoreValue(v) {
  return v == null || Number.isNaN(Number(v)) ? "—" : String(v);
}

function grossForRow(row) {
  if (row?.gross != null) return row.gross;
  if (row?.grossTotal != null) return row.grossTotal;
  if (row?.scores?.grossTotal != null) return row.scores.grossTotal;
  if (Array.isArray(row?.scores?.gross)) return sumHoles(row.scores.gross);
  return null;
}

function netForRow(row) {
  if (row?.net != null) return row.net;
  if (row?.netTotal != null) return row.netTotal;
  if (row?.strokes != null) return row.strokes;
  if (row?.scores?.netTotal != null) return row.scores.netTotal;
  if (Array.isArray(row?.scores?.net)) return sumHoles(row.scores.net);
  return null;
}

function toParDisplay(v) {
  if (v == null) return "—";
  if (typeof v === "number" && Number.isFinite(v)) return toParStrFromDiff(v);
  const s = String(v).trim();
  if (!s) return "—";
  const up = s.toUpperCase();
  if (up === "E" || up === "EVEN" || s === "0" || s === "+0" || s === "-0") return "E";
  const n = Number(s);
  if (!Number.isNaN(n)) return toParStrFromDiff(n);
  return s;
}

function firstDefined(obj, keys) {
  for (const key of keys) {
    const v = obj?.[key];
    if (v != null) return v;
  }
  return null;
}

function grossToParForRow(row, data) {
  const explicit = firstDefined(row, [
    "toParGross",
    "grossToPar",
    "toParGrossTotal",
    "grossToParTotal"
  ]);
  if (explicit != null) return toParDisplay(explicit);
  if (row?.scores?.grossToParTotal != null) return toParDisplay(row.scores.grossToParTotal);

  if (Array.isArray(row?.scores?.gross) && Array.isArray(data?.course?.pars)) {
    const diff = row.scores.gross.reduce(
      (a, v, i) => a + (!isPlayedScore(v) ? 0 : Number(v) - Number(data.course.pars[i] || 0)),
      0
    );
    return toParDisplay(diff);
  }

  const gross = grossForRow(row);
  const parTotal = Number(data?.course?.parTotal || 0);
  if (gross != null && parTotal > 0 && Number(row?.thru || 0) >= 18) {
    return toParDisplay(Number(gross) - parTotal);
  }
  return toParDisplay(row?.toPar);
}

function netToParForRow(row, data) {
  const explicit = firstDefined(row, [
    "toParNet",
    "netToPar",
    "toParNetTotal",
    "netToParTotal"
  ]);
  if (explicit != null) return toParDisplay(explicit);
  if (row?.scores?.netToParTotal != null) return toParDisplay(row.scores.netToParTotal);

  if (Array.isArray(row?.scores?.net) && Array.isArray(data?.course?.pars)) {
    const diff = row.scores.net.reduce(
      (a, v, i) => a + (!isPlayedScore(v) ? 0 : Number(v) - Number(data.course.pars[i] || 0)),
      0
    );
    return toParDisplay(diff);
  }

  const net = netForRow(row);
  const parTotal = Number(data?.course?.parTotal || 0);
  if (net != null && parTotal > 0 && Number(row?.thru || 0) >= 18) {
    return toParDisplay(Number(net) - parTotal);
  }
  return toParDisplay(row?.toPar);
}

function segmentTotal(arr, start, end) {
  let out = 0;
  for (let i = start; i <= end; i++) out += Number(arr?.[i] || 0);
  return out;
}

function segmentToPar(arr, par, start, end) {
  let out = 0;
  for (let i = start; i <= end; i++) {
    if (!isPlayedScore(arr?.[i])) continue;
    out += Number(arr[i]) - Number(par?.[i] || 0);
  }
  return out;
}

function sectionPlayedCount(arr, start, end) {
  let count = 0;
  for (let i = start; i <= end; i++) {
    if (isPlayedScore(arr?.[i])) count++;
  }
  return count;
}

function buildScorecardTable(scores, useHandicap) {
  const gross = scores.gross || Array(18).fill(null);
  const net = scores.net || Array(18).fill(null);
  const par = scores.par || Array(18).fill(0);
  const dots = scores.handicapShots || Array(18).fill(0);
  const grossTotal = scores.grossTotal != null ? scores.grossTotal : sumHoles(gross);
  const netTotal = scores.netTotal != null ? scores.netTotal : sumHoles(net);
  const grossToParTotal =
    scores.grossToParTotal != null
      ? scores.grossToParTotal
      : segmentToPar(gross, par, 0, 17);
  const netToParTotal =
    scores.netToParTotal != null
      ? scores.netToParTotal
      : segmentToPar(net, par, 0, 17);
  const thru =
    scores.thru != null
      ? scores.thru
      : (() => {
          let last = -1;
          for (let i = 0; i < 18; i++) {
            if (gross[i] != null && Number(gross[i]) > 0) last = i;
          }
          return last + 1;
        })();

  const wrap = document.createElement("div");
  wrap.className = "scorecard-one-wrap";

  const summary = document.createElement("div");
  summary.className = "small scorecard-summary";
  summary.textContent = useHandicap
    ? `Gross ${grossTotal} (${toParStrFromDiff(grossToParTotal)}) • Net ${netTotal} (${toParStrFromDiff(netToParTotal)}) • Thru ${thru}`
    : `Gross ${grossTotal} (${toParStrFromDiff(grossToParTotal)}) • Thru ${thru}`;
  wrap.appendChild(summary);

  const tbl = document.createElement("table");
  tbl.className = "table scorecard-one-table";
  const tbody = document.createElement("tbody");

  function addDotsRow(start, end) {
    if (!useHandicap) return;
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<th class="left"></th>` +
      Array.from({ length: end - start + 1 }, (_, k) => {
        const i = start + k;
        return `<th class="mono dots">${dotsForStrokes(dots[i])}</th>`;
      }).join("") +
      `<th></th><th></th>`;
    tbody.appendChild(tr);
  }

  function addHeaderRow(label, start, end) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<th class="left">${label}</th>` +
      Array.from({ length: end - start + 1 }, (_, k) => `<th>${start + k + 1}</th>`).join("") +
      `<th>Total</th><th>±</th>`;
    tbody.appendChild(tr);
  }

  function addDataRow(label, arr, start, end) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="left"><b>${label}</b></td>` +
      Array.from({ length: end - start + 1 }, (_, k) => {
        const i = start + k;
        const v = arr[i];
        return `<td class="mono">${v == null ? "" : String(v)}</td>`;
      }).join("") +
      `<td class="mono"><b>${segmentTotal(arr, start, end)}</b></td>` +
      `<td class="mono"><b>${toParStrFromDiff(segmentToPar(arr, par, start, end))}</b></td>`;
    tbody.appendChild(tr);
  }

  function addParRow(start, end) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="left"><b>Par</b></td>` +
      Array.from({ length: end - start + 1 }, (_, k) => {
        const i = start + k;
        return `<td class="mono">${String(par[i] || 0)}</td>`;
      }).join("") +
      `<td class="mono"><b>${segmentTotal(par, start, end)}</b></td>` +
      `<td class="mono"><b>E</b></td>`;
    tbody.appendChild(tr);
  }

  function addSectionSpacer() {
    const tr = document.createElement("tr");
    tr.className = "scorecard-spacer-row";
    tr.innerHTML = `<td colspan="12"></td>`;
    tbody.appendChild(tr);
  }

  addDotsRow(0, 8);
  addHeaderRow("Front 9", 0, 8);
  addDataRow("Gross", gross, 0, 8);
  if (useHandicap) addDataRow("Net", net, 0, 8);
  addParRow(0, 8);
  addSectionSpacer();
  addDotsRow(9, 17);
  addHeaderRow("Back 9", 9, 17);
  addDataRow("Gross", gross, 9, 17);
  if (useHandicap) addDataRow("Net", net, 9, 17);
  addParRow(9, 17);

  tbl.appendChild(tbody);
  wrap.appendChild(tbl);
  return wrap;
}

function buildTeamMembersScorecard(roundIndex, teamRow, useHandicap) {
  const teamId = teamRow?.teamId;
  if (!teamId) return null;

  const roundData = TOURN?.score_data?.rounds?.[roundIndex];
  const byPlayer = roundData?.player || null;
  if (!byPlayer) return null;

  const teamPlayers = (TOURN?.players || [])
    .filter((p) => p?.teamId === teamId)
    .map((p) => {
      const entry = byPlayer[p.playerId] || {};
      return {
        name: p.name || p.playerId || "Player",
        gross: Array.isArray(entry.gross) ? entry.gross : Array(18).fill(null),
        net: Array.isArray(entry.net) ? entry.net : Array(18).fill(null)
      };
    });

  if (!teamPlayers.length) return null;
  const anyData = teamPlayers.some((p) => hasAnyScore(p.gross) || hasAnyScore(p.net));
  if (!anyData) return null;

  const par = TOURN?.course?.pars || Array(18).fill(0);
  const wrap = document.createElement("div");
  wrap.className = "scorecard-one-wrap";

  const summary = document.createElement("div");
  summary.className = "small scorecard-summary";
  summary.textContent = useHandicap
    ? "Team members (gross rows shown)"
    : "Team members";
  wrap.appendChild(summary);

  const tbl = document.createElement("table");
  tbl.className = "table scorecard-one-table scorecard-team-table";
  const tbody = document.createElement("tbody");

  function addHeaderRow(label, start, end) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<th class="left">${label}</th>` +
      Array.from({ length: end - start + 1 }, (_, k) => `<th>${start + k + 1}</th>`).join("") +
      `<th>Total</th><th>±</th>`;
    tbody.appendChild(tr);
  }

  function addPlayerRows(start, end) {
    for (const p of teamPlayers) {
      const holes = p.gross;
      const played = holes.slice(start, end + 1).some((v) => v != null && Number(v) > 0);
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td class="left"><b>${p.name}</b></td>` +
        Array.from({ length: end - start + 1 }, (_, k) => {
          const i = start + k;
          const v = holes[i];
          return `<td class="mono">${v == null ? "" : String(v)}</td>`;
        }).join("") +
        `<td class="mono"><b>${played ? segmentTotal(holes, start, end) : ""}</b></td>` +
        `<td class="mono"><b>${played ? toParStrFromDiff(segmentToPar(holes, par, start, end)) : ""}</b></td>`;
      tbody.appendChild(tr);
    }
  }

  function addParRow(start, end) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="left"><b>Par</b></td>` +
      Array.from({ length: end - start + 1 }, (_, k) => {
        const i = start + k;
        return `<td class="mono">${String(par[i] || 0)}</td>`;
      }).join("") +
      `<td class="mono"><b>${segmentTotal(par, start, end)}</b></td>` +
      `<td class="mono"><b>E</b></td>`;
    tbody.appendChild(tr);
  }

  function addSectionSpacer() {
    const tr = document.createElement("tr");
    tr.className = "scorecard-spacer-row";
    tr.innerHTML = `<td colspan="12"></td>`;
    tbody.appendChild(tr);
  }

  addHeaderRow("Front 9", 0, 8);
  addPlayerRows(0, 8);
  addParRow(0, 8);
  addSectionSpacer();
  addHeaderRow("Back 9", 9, 17);
  addPlayerRows(9, 17);
  addParRow(9, 17);

  tbl.appendChild(tbody);
  wrap.appendChild(tbl);
  return wrap;
}

function clearInlineScorecardRow() {
  if (openInlineRow && openInlineRow.parentNode) {
    openInlineRow.parentNode.removeChild(openInlineRow);
  }
  openInlineRow = null;
  openInlineKey = null;
}

function rowIdentityKey(data, row) {
  const id = mode === "team" ? row?.teamId : row?.playerId;
  return `${mode}:${String(data.view?.round)}:${id || ""}`;
}

function makeInlineScorecardHost(anchorRow, colCount) {
  const detailRow = document.createElement("tr");
  detailRow.className = "scorecard-inline-row";

  const td = document.createElement("td");
  td.colSpan = colCount;
  td.style.padding = "0";
  td.style.overflow = "hidden";

  const host = document.createElement("div");
  host.className = "card inline-scorecard-host";
  host.style.margin = "0";
  host.style.boxShadow = "none";
  host.style.padding = "0";
  host.style.overflow = "hidden";
  host.style.maxWidth = "100%";

  td.appendChild(host);
  detailRow.appendChild(td);
  anchorRow.parentNode.insertBefore(detailRow, anchorRow.nextSibling);

  return { detailRow, host };
}

async function getScorecardScores(data, row) {
  if (data.view?.round === "all") return null;
  if (row?.scores) return row.scores;

  const rIdx = Number(data.view.round);
  const modeQ = mode === "team" ? "team" : "player";
  const idQ = mode === "team" ? row.teamId : row.playerId;
  const sc = await api(
    `/tournaments/${encodeURIComponent(tid)}/scorecard?round=${rIdx}&mode=${modeQ}&id=${encodeURIComponent(idQ)}`
  );

  return {
    gross: sc.grossHoles || Array(18).fill(null),
    net: sc.netHoles || Array(18).fill(null),
    handicapShots: sc.handicapShots || Array(18).fill(0),
    par: sc.course?.pars || Array(18).fill(0),
    grossTotal: sc.grossTotal,
    netTotal: sc.netTotal,
    grossToParTotal: sc.toParGrossTotal,
    netToParTotal: sc.toParNetTotal,
    thru: sc.thru
  };
}

function inlineScorecardHeading(host, title, subtitle) {
  host.innerHTML = "";
  const meta = document.createElement("div");
  meta.className = "inline-scorecard-meta";

  const h = document.createElement("h3");
  h.style.margin = "0 0 4px 0";
  h.textContent = title;
  meta.appendChild(h);

  const sub = document.createElement("div");
  sub.className = "small";
  sub.textContent = subtitle;
  meta.appendChild(sub);
  host.appendChild(meta);
}

function renderLeaderboard(data) {
  const isTeam = mode === "team";
  const showGrossNet = isHandicapRound(data.view?.round);
  lbTitle.textContent = isTeam ? "Teams" : "Individuals";

  const head = document.getElementById("lb_head");
  if (showGrossNet) {
    head.innerHTML = `
      <th class="left">#</th>
      <th class="left">${isTeam ? "Team" : "Player"}</th>
      <th>Thru</th>
      <th>Gross ±</th>
      <th>Net ±</th>
    `;
  } else {
    head.innerHTML = `
      <th class="left">#</th>
      <th class="left">${isTeam ? "Team" : "Player"}</th>
      <th>±</th>
      <th>Thru</th>
      <th>Strokes</th>
    `;
  }

  const tbody = lbTbl.querySelector("tbody");
  tbody.innerHTML = "";
  clearInlineScorecardRow();

  const rows = isTeam ? data.teams || [] : data.players || [];
  function hasPostedScores(row) {
    if (Number(row?.thru || 0) > 0) return true;
    if (Number(row?.strokes || 0) > 0) return true;
    if (Number(row?.grossTotal || 0) > 0) return true;
    if (Number(row?.netTotal || 0) > 0) return true;
    if (showGrossNet) {
      if (Number(grossForRow(row) || 0) > 0) return true;
      if (Number(netForRow(row) || 0) > 0) return true;
    }
    return false;
  }

  const sortedRows = rows
    .map((row, idx) => ({ row, idx, hasData: hasPostedScores(row) }))
    .sort((a, b) => {
      if (a.hasData === b.hasData) return a.idx - b.idx;
      return a.hasData ? -1 : 1;
    })
    .map((x) => x.row);

  const colCount = leaderboardColCount(data);

  sortedRows.forEach((r, idx) => {
    const tr = document.createElement("tr");
    tr.className = "clickable";
    tr.dataset.id = isTeam ? r.teamId : r.playerId;

    const nameCell = `
      <td class="left">
        <div><b>${isTeam ? r.teamName : r.name}</b></div>
        ${!isTeam && r.teamName ? `<div class="small muted">${r.teamName}</div>` : ""}
      </td>
    `;

    if (showGrossNet) {
      tr.innerHTML = `
        <td class="mono">${idx + 1}</td>
        ${nameCell}
        <td class="mono">${r.thru == null ? "—" : String(r.thru)}</td>
        <td class="mono"><b>${grossToParForRow(r, data)}</b></td>
        <td class="mono"><b>${netToParForRow(r, data)}</b></td>
      `;
    } else {
      tr.innerHTML = `
        <td class="mono">${idx + 1}</td>
        ${nameCell}
        <td class="mono"><b>${r.toPar ?? "E"}</b></td>
        <td class="mono">${r.thru == null ? "—" : String(r.thru)}</td>
        <td class="mono">${r.strokes == null ? "—" : String(r.strokes)}</td>
      `;
    }

    tr.onclick = async () => {
      const key = rowIdentityKey(data, r);
      if (openInlineKey === key) {
        clearInlineScorecardRow();
        return;
      }

      clearInlineScorecardRow();
      const { detailRow, host } = makeInlineScorecardHost(tr, colCount);
      openInlineKey = key;
      openInlineRow = detailRow;

      if (data.view?.round === "all") {
        inlineScorecardHeading(host, "Scorecard", "Pick a specific round to view hole-by-hole scorecards.");
        return;
      }

      const rIdx = Number(data.view.round);
      const title = isTeam ? (r.teamName || "Team") : (r.name || "Player");
      const subtitle = isTeam
        ? `Round ${rIdx + 1}`
        : `${r.teamName || ""} • Round ${rIdx + 1}`;

      inlineScorecardHeading(host, title, subtitle);
      const loading = document.createElement("div");
      loading.className = "small";
      loading.style.marginTop = "8px";
      loading.textContent = "Loading scorecard…";
      host.appendChild(loading);

      const token = ++inlineReqToken;
      try {
        if (mode === "team") {
          const teamTable = buildTeamMembersScorecard(rIdx, r, showGrossNet);
          if (token !== inlineReqToken || openInlineKey !== key) return;
          if (teamTable) {
            loading.remove();
            const grid = document.createElement("div");
            grid.className = "scoregrid inline-scoregrid";
            grid.style.marginTop = "0";
            grid.appendChild(teamTable);
            host.appendChild(grid);
            return;
          }
        }

        const scores = await getScorecardScores(data, r);
        if (token !== inlineReqToken || openInlineKey !== key) return;

        loading.remove();
        if (!scores) {
          const msg = document.createElement("div");
          msg.className = "small";
          msg.textContent = "No scorecard data available.";
          host.appendChild(msg);
          return;
        }

        const grid = document.createElement("div");
        grid.className = "scoregrid inline-scoregrid";
        grid.style.marginTop = "0";
        grid.appendChild(buildScorecardTable(scores, showGrossNet));
        host.appendChild(grid);
      } catch (e) {
        if (token !== inlineReqToken || openInlineKey !== key) return;
        loading.textContent = e.message || String(e);
      }
    };

    tbody.appendChild(tr);
  });
}

function buildScoreboardResponse(tournamentJson, viewRound) {
  const course = tournamentJson.course || {
    pars: Array(18).fill(4),
    strokeIndex: Array.from({ length: 18 }, (_, i) => i + 1)
  };

  if (viewRound === "all") {
    return {
      tournament: tournamentJson.tournament,
      view: { round: "all" },
      course: {
        parTotal: course.pars.reduce((a, b) => a + Number(b || 0), 0),
        pars: course.pars,
        strokeIndex: course.strokeIndex
      },
      teams: tournamentJson.score_data?.leaderboard_all?.teams || [],
      players: tournamentJson.score_data?.leaderboard_all?.players || []
    };
  }

  const rIdx = Number(viewRound);
  const derived = tournamentJson.score_data?.rounds?.[rIdx];
  return {
    tournament: tournamentJson.tournament,
    view: { round: rIdx },
    course: {
      parTotal: course.pars.reduce((a, b) => a + Number(b || 0), 0),
      pars: course.pars,
      strokeIndex: course.strokeIndex
    },
    teams: derived?.leaderboard?.teams || [],
    players: derived?.leaderboard?.players || []
  };
}

async function loadTournament() {
  try {
    return await staticJson(`/tournaments/${encodeURIComponent(tid)}.json`, {
      cacheKey: `tourn:${tid}`
    });
  } catch (_) {
    const legacy = await api(`/tournaments/${encodeURIComponent(tid)}/scoreboard?round=all`);
    return {
      tournament: legacy.tournament,
      course: legacy.course,
      score_data: {
        leaderboard_all: {
          teams: legacy.teams || [],
          players: legacy.players || []
        },
        rounds: []
      }
    };
  }
}

function render() {
  if (!TOURN) return;
  const data = buildScoreboardResponse(TOURN, currentRound);

  const rLabel =
    data.view.round === "all" ? "All rounds" : `Round ${Number(data.view.round) + 1}`;
  const handicapInfo = isHandicapRound(data.view.round)
    ? " • leaderboard shows gross + net, scorecards show both"
    : "";
  toggleNote.textContent = `${rLabel}${handicapInfo}`;

  renderLeaderboard(data);

  const ts = TOURN.updatedAt ? new Date(TOURN.updatedAt).toLocaleString() : "—";
  updated.textContent = `Updated: ${ts}`;

  raw.textContent = "";
}

btnTeam.onclick = () => {
  mode = "team";
  btnTeam.classList.add("active");
  btnPlayer.classList.remove("active");
  render();
};

btnPlayer.onclick = () => {
  mode = "player";
  btnPlayer.classList.add("active");
  btnTeam.classList.remove("active");
  render();
};

roundFilter.onchange = () => {
  const v = roundFilter.value;
  currentRound = v === "all" ? "all" : Number(v);
  render();
};

(async function init() {
  if (!tid) {
    status.textContent =
      "Missing tournament id. Open with ?t=... or create/open a tournament first.";
    return;
  }

  if (scorecardCard) scorecardCard.style.display = "none";

  status.textContent = "Loading…";
  try {
    TOURN = await loadTournament();
    rememberTournamentId(tid);

    roundFilter.innerHTML = `<option value="all">All rounds (weighted)</option>`;
    (TOURN.tournament.rounds || []).forEach((r, idx) => {
      roundFilter.innerHTML += `<option value="${idx}">Round ${idx + 1}: ${r.name || `Round ${idx + 1}`}</option>`;
    });

    const roundCount = (TOURN.tournament.rounds || []).length;
    if (roundCount > 0) {
      currentRound = newestRoundWithDataIndex(TOURN);
    } else {
      currentRound = "all";
    }
    roundFilter.value = String(currentRound);

    status.textContent = "";
    render();
  } catch (e) {
    console.error(e);
    status.textContent = e.message || String(e);
  }
})();
