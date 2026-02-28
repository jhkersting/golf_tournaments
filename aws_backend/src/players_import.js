import { json, parseBody, requireAdmin, uid, code4, updateStateWithRetry, writePublicObjectsFromState } from "./utils.js";

function parseDelimited(text){
  const lines = String(text||"").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const delim = lines[0].includes("\t") ? "\t" : ",";
  const rows = lines.map(l => l.split(delim).map(x => x.trim()));
  const header = rows[0].map(x => x.toLowerCase());
  const hasHeader = header.includes("name") && header.includes("team");
  const start = hasHeader ? 1 : 0;
  return rows.slice(start).map(cols => ({
    name: cols[0] || "",
    team: cols[1] || "",
    handicap: cols[2] ?? "0"
  })).filter(r => r.name && r.team);
}

function isTwoManBestBallTournament(rounds){
  return Array.isArray(rounds) && rounds.some(r => r?.format === "two_man_best_ball");
}

export async function handler(event){
  try{
    requireAdmin(event);
    const tid = event.pathParameters?.tid;
    if (!tid) return json(400, { error: "missing tid" });

    const body = await parseBody(event);
    const csvText = body.csvText || "";
    const baseUrl = String(body.baseUrl || "").replace(/\/+$/,"");

    const rows = parseDelimited(csvText);
    if (!rows.length) return json(400, { error: "No rows found. Expect columns: name, team, handicap" });

    const outLines = ["name,team,handicap,group,code,enterUrl"];

    const updated = await updateStateWithRetry(tid, (current) => {
      if (!current) {
        const err = new Error("tournament not found");
        err.statusCode = 404;
        throw err;
      }

      current.teams = current.teams || {};
      current.players = current.players || {};
      current.codeIndex = current.codeIndex || {};
      current.scores = current.scores || { rounds: (current.rounds||[]).map(()=>({teams:{},players:{}})) };
      const needsTwoManGroups = isTwoManBestBallTournament(current.rounds);

      const existingCodes = new Set(Object.keys(current.codeIndex || {}));
      const createdRows = [];

      for (const r of rows){
        const teamName = String(r.team).trim();
        const playerName = String(r.name).trim();
        const handicap = Number(r.handicap || 0);

        // Find or create team
        let teamId = Object.keys(current.teams).find(id => current.teams[id].teamName === teamName);
        if (!teamId){
          teamId = uid("tm");
          current.teams[teamId] = { teamId, teamName };
        }

        // Create player
        const playerId = uid("p");
        let code = code4();
        let guard = 0;
        while (existingCodes.has(code) && guard++ < 50) code = code4();
        existingCodes.add(code);

        current.players[playerId] = { playerId, name: playerName, teamId, handicap, code };
        current.codeIndex[code] = playerId;

        const enterUrl = baseUrl ? `${baseUrl}/enter.html?code=${encodeURIComponent(code)}` : "";
        createdRows.push({ playerId, playerName, teamName, handicap, code, enterUrl });
      }

      if (needsTwoManGroups){
        const playersByTeam = new Map(Object.keys(current.teams).map(teamId => [teamId, []]));
        for (const pid of Object.keys(current.players)){
          const p = current.players[pid];
          if (!p?.teamId) continue;
          if (!playersByTeam.has(p.teamId)) playersByTeam.set(p.teamId, []);
          playersByTeam.get(p.teamId).push(pid);
        }

        for (const [teamId, pids] of playersByTeam.entries()){
          const teamName = current.teams[teamId]?.teamName || teamId;
          if (pids.length !== 4){
            const err = new Error(`Team "${teamName}" must have exactly 4 players for two-man best ball`);
            err.statusCode = 400;
            throw err;
          }
          for (let i=0;i<pids.length;i++){
            const pid = pids[i];
            current.players[pid].group = i < 2 ? "A" : "B";
          }
        }
      }

      for (const row of createdRows){
        const group = String(current.players[row.playerId]?.group || "");
        outLines.push(`${row.playerName},${row.teamName},${row.handicap},${group},${row.code},${row.enterUrl}`);
      }

      current.updatedAt = Date.now();
      current.version = Number(current.version || 0) + 1;
      return current;
    });

    await writePublicObjectsFromState(updated);

    return json(200, { count: rows.length, downloadCsv: outLines.join("\n") });
  } catch(e){
    return json(e.statusCode || 500, { error: e.message || "Server error" });
  }
}
