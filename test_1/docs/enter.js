import { api, qs, sum, strokesPerHole, toPar } from "./app.js";

const code = qs("code");
const who = document.getElementById("who");
const forms = document.getElementById("round_forms");

function makeScoreTable({ pars, strokeIndex, defaultScore=4 }){
  const wrap = document.createElement("div");
  wrap.className = "scoregrid";

  const tbl = document.createElement("table");
  tbl.className = "table";

  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  trh.innerHTML = `<th class="left">Row</th>` + Array.from({length:18},(_,i)=>`<th>${i+1}</th>`).join("") + `<th>Total</th><th>±Par</th>`;
  thead.appendChild(trh);
  tbl.appendChild(thead);

  const tbody = document.createElement("tbody");

  const trPar = document.createElement("tr");
  trPar.innerHTML = `<td class="left"><b>Par</b></td>` + pars.map(p=>`<td>${p}</td>`).join("") + `<td><b>${sum(pars)}</b></td><td class="mono">—</td>`;
  tbody.appendChild(trPar);

  const trSi = document.createElement("tr");
  trSi.innerHTML = `<td class="left"><b>SI</b></td>` + strokeIndex.map(v=>`<td>${v}</td>`).join("") + `<td class="mono">—</td><td class="mono">—</td>`;
  tbody.appendChild(trSi);

  const trGross = document.createElement("tr");
  trGross.className = "holes-row";
  trGross.innerHTML = `<td class="left"><b>Gross</b></td>` +
    Array.from({length:18},(_,i)=>`<td><input data-hole="${i+1}" value="${defaultScore}" /></td>`).join("") +
    `<td data-total="gross">72</td><td data-topar="gross" class="mono">E</td>`;
  tbody.appendChild(trGross);

  const trStrokes = document.createElement("tr");
  trStrokes.innerHTML = `<td class="left"><b>Strokes</b></td>` +
    Array.from({length:18},()=>`<td class="mono">0</td>`).join("") +
    `<td data-total="strokes" class="mono">0</td><td class="mono">—</td>`;
  tbody.appendChild(trStrokes);

  const trNet = document.createElement("tr");
  trNet.innerHTML = `<td class="left"><b>Net</b></td>` +
    Array.from({length:18},()=>`<td class="mono">4</td>`).join("") +
    `<td data-total="net"><b>72</b></td><td data-topar="net" class="mono"><b>E</b></td>`;
  tbody.appendChild(trNet);

  tbl.appendChild(tbody);
  wrap.appendChild(tbl);

  function getGrossHoles(){
    return [...trGross.querySelectorAll("input[data-hole]")].map(inp => Number(inp.value));
  }

  function setRowCells(tr, arr){
    const tds = tr.querySelectorAll("td");
    for (let i=0;i<18;i++) tds[i+1].textContent = String(arr[i]);
  }

  function recalc({ handicap=0, useHandicap=false }){
    const gross = getGrossHoles();
    const parTotal = sum(pars);
    const grossTotal = sum(gross);

    trGross.querySelector("[data-total='gross']").textContent = String(grossTotal);
    trGross.querySelector("[data-topar='gross']").textContent = toPar(grossTotal, parTotal);

    if (!useHandicap){
      trStrokes.style.display = "none";
      trNet.style.display = "none";
      return;
    }

    trStrokes.style.display = "";
    trNet.style.display = "";

    const strokes = strokesPerHole(handicap, strokeIndex);
    setRowCells(trStrokes, strokes);
    trStrokes.querySelector("[data-total='strokes']").textContent = String(sum(strokes));

    const netHoles = gross.map((g,i)=> Number(g) - strokes[i]);
    setRowCells(trNet, netHoles);

    const netTotal = sum(netHoles);
    trNet.querySelector("[data-total='net']").textContent = String(netTotal);
    trNet.querySelector("[data-topar='net']").textContent = toPar(netTotal, parTotal);
  }

  return { wrap, recalc, getGrossHoles };
}

function makeRoundCard(data, round, idx){
  const card = document.createElement("div");
  card.className = "card";
  const isScramble = round.format === "scramble";
  const useHcp = !!round.useHandicap;

  card.innerHTML = `
    <div class="actions" style="justify-content:space-between;">
      <div>
        <div><b>Round ${idx+1}: ${round.name}</b></div>
        <div class="small">
          <span class="pill">${round.format}</span>
          <span class="pill">weight ${round.weight}</span>
          ${useHcp ? "<span class='pill'>handicap net</span>" : ""}
        </div>
      </div>
      <div class="small">${isScramble ? "Team entry" : "Player entry"}</div>
    </div>
  `;

  const pars = data.course?.pars || Array(18).fill(4);
  const strokeIndex = data.course?.strokeIndex || Array.from({length:18},(_,i)=>i+1);
  const table = makeScoreTable({ pars, strokeIndex, defaultScore: 4 });

  card.appendChild(document.createElement("hr"));
  card.appendChild(table.wrap);

  const handicap = Number(data.player?.handicap || 0);
  table.recalc({ handicap, useHandicap: useHcp && !isScramble });

  table.wrap.addEventListener("input", () => {
    table.recalc({ handicap, useHandicap: useHcp && !isScramble });
  });

  const btn = document.createElement("button");
  btn.textContent = "Submit hole-by-hole scores";
  btn.style.marginTop = "12px";
  btn.onclick = async () => {
    try{
      btn.disabled = true;
      const holes = table.getGrossHoles().map(Number);
      if (holes.length !== 18 || holes.some(v => !Number.isFinite(v))) throw new Error("Invalid hole scores.");

      await api(`/tournaments/${encodeURIComponent(data.tournamentId)}/scores`, {
        method: "POST",
        body: {
          code: data.code,
          roundIndex: idx,
          target: isScramble ? "team" : "player",
          holes
        }
      });

      alert("Saved!");
    } catch(e){
      console.error(e);
      alert(e.message || String(e));
    } finally {
      btn.disabled = false;
    }
  };

  card.appendChild(btn);
  return card;
}

(async function init(){
  if (!code){
    forms.innerHTML = `<div class="card"><p>Missing <code>?code=</code> in the URL.</p></div>`;
    return;
  }
  try{
    const data = await api(`/enter/${encodeURIComponent(code)}`);
    who.style.display = "block";
    who.innerHTML = `
      <h2 style="margin:0 0 6px 0;">${data.player.name}</h2>
      <div class="small">Team: <b>${data.team.teamName}</b> • Handicap: <b>${data.player.handicap}</b></div>
      <div class="small">Tournament: <b>${data.tournament?.name || data.tournamentId}</b> • ${data.tournament?.dates || ""}</div>
    `;

    data.rounds.forEach((r, idx) => forms.appendChild(makeRoundCard(data, r, idx)));
  } catch(e){
    console.error(e);
    forms.innerHTML = `<div class="card"><p><b>Error:</b> ${e.message || String(e)}</p></div>`;
  }
})();
