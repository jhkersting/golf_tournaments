import { api, qs, strokesPerHole, dotsForStrokes } from "./app.js";

const code = qs("code");
const who = document.getElementById("who");
const forms = document.getElementById("round_forms");

function toParStrFromDiff(diff){
  const d = Math.round(diff);
  if (d === 0) return "E";
  return d > 0 ? `+${d}` : `${d}`;
}
function sumPlayed(arr){
  return arr.reduce((a,v)=>a + (v == null ? 0 : Number(v)), 0);
}
function thruFromHoles(arr){
  let last = -1;
  for (let i=0;i<arr.length;i++){
    const v = arr[i];
    if (v != null && Number(v) > 0) last = i;
  }
  return last + 1;
}

function makeScoreTable({ pars, strokeIndex, handicap, useHandicap, defaultScore=4 }){
  const wrap = document.createElement("div");
  wrap.className = "scoregrid";

  const tbl = document.createElement("table");
  tbl.className = "table";

  // Header row: dots above hole numbers (handicap shots) when useHandicap
  const thead = document.createElement("thead");

  const trDots = document.createElement("tr");
  trDots.innerHTML = `<th class="left"></th>` + Array.from({length:18}, (_,i)=>{
    const shots = useHandicap ? strokesPerHole(handicap, strokeIndex)[i] : 0;
    return `<th class="mono dots">${dotsForStrokes(shots)}</th>`;
  }).join("") + `<th></th><th></th><th></th>`;
  thead.appendChild(trDots);

  const trH = document.createElement("tr");
  trH.innerHTML = `<th class="left">Row</th>` +
    Array.from({length:18},(_,i)=>`<th>${i+1}</th>`).join("") +
    `<th>Total</th><th>±Par</th><th>Thru</th>`;
  thead.appendChild(trH);

  tbl.appendChild(thead);

  const tbody = document.createElement("tbody");

  // Gross row
  const trGross = document.createElement("tr");
  trGross.innerHTML =
    `<td class="left"><b>Gross</b></td>` +
    Array.from({length:18}, (_,i)=>`<td><input data-hole="${i}" type="number" min="1" max="20" placeholder="${defaultScore}" class="hole-input"></td>`).join("") +
    `<td data-total="gross"><b>0</b></td>` +
    `<td data-topar="gross" class="mono"><b>E</b></td>` +
    `<td data-thru="gross" class="mono"><b>0</b></td>`;
  tbody.appendChild(trGross);

  // Net row (optional)
  let trNet = null;
  if (useHandicap){
    trNet = document.createElement("tr");
    trNet.innerHTML =
      `<td class="left"><b>Net</b></td>` +
      Array.from({length:18}, ()=>`<td class="mono net-cell"></td>`).join("") +
      `<td data-total="net"><b>0</b></td>` +
      `<td data-topar="net" class="mono"><b>E</b></td>` +
      `<td data-thru="net" class="mono"><b>0</b></td>`;
    tbody.appendChild(trNet);
  }

  tbl.appendChild(tbody);
  wrap.appendChild(tbl);

  const shotsArr = useHandicap ? strokesPerHole(handicap, strokeIndex) : Array(18).fill(0);

  function getGrossHoles(){
    const inputs = [...trGross.querySelectorAll("input[data-hole]")];
    return inputs.map(inp => {
      const v = inp.value;
      if (v === "" || v == null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? Math.round(n) : null;
    });
  }

  function update(){
    const gross = getGrossHoles();
    const grossTotal = sumPlayed(gross);
    const parPlayed = gross.reduce((acc, v, i)=> acc + (v == null ? 0 : Number(pars[i] || 0)), 0);
    const grossDiff = grossTotal - parPlayed;
    const thru = thruFromHoles(gross);

    trGross.querySelector('[data-total="gross"] b').textContent = String(grossTotal);
    trGross.querySelector('[data-topar="gross"] b').textContent = toParStrFromDiff(grossDiff);
    trGross.querySelector('[data-thru="gross"] b').textContent = String(thru);

    if (useHandicap && trNet){
      const net = gross.map((v,i)=> v == null ? null : (Number(v) - Number(shotsArr[i] || 0)));
      // render net cells
      const tds = [...trNet.querySelectorAll("td")].slice(1, 19);
      tds.forEach((td, i) => {
        td.textContent = net[i] == null ? "" : String(net[i]);
      });

      const shotsPlayed = gross.reduce((acc, v, i)=> acc + (v == null ? 0 : Number(shotsArr[i] || 0)), 0);
      const netTotal = grossTotal - shotsPlayed;
      const netDiff = netTotal - parPlayed;

      trNet.querySelector('[data-total="net"] b').textContent = String(netTotal);
      trNet.querySelector('[data-topar="net"] b').textContent = toParStrFromDiff(netDiff);
      trNet.querySelector('[data-thru="net"] b').textContent = String(thru);
    }
  }

  // bind inputs
  trGross.querySelectorAll("input[data-hole]").forEach(inp => {
    inp.addEventListener("input", update);
    inp.addEventListener("change", update);
  });

  // initial
  update();

  return {
    el: wrap,
    getHoles: getGrossHoles,
    refresh: update
  };
}

function roundCard(data, round, idx){
  const card = document.createElement("div");
  card.className = "card";

  const isScramble = round.format === "scramble";
  const title = document.createElement("h3");
  title.textContent = `${round.name || `Round ${idx+1}`} — ${round.format.toUpperCase()}${round.useHandicap ? " (NET)" : ""}`;
  card.appendChild(title);

  const meta = document.createElement("p");
  meta.className = "muted";
  meta.textContent = isScramble
    ? "Enter ONE team score (hole-by-hole). Leave holes blank until played."
    : "Enter your score (hole-by-hole). Leave holes blank until played.";
  card.appendChild(meta);

  const table = makeScoreTable({
    pars: data.course.pars,
    strokeIndex: data.course.strokeIndex,
    handicap: data.player.handicap,
    useHandicap: !!round.useHandicap,
    defaultScore: 4
  });
  card.appendChild(table.el);

  const btn = document.createElement("button");
  btn.className = "btn";
  btn.textContent = "Save Scores";
  btn.onclick = async () => {
    try{
      btn.disabled = true;
      const holes = table.getHoles();

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
    who.textContent = "Missing code.";
    return;
  }

  const data = await api(`/enter/${encodeURIComponent(code)}`);

  who.innerHTML = `
    <h2>${data.tournament.name}</h2>
    <p class="muted">${data.tournament.dates}</p>
    <p><b>${data.player.name}</b> • HCP ${data.player.handicap} • ${data.team.teamName}</p>
    <p class="muted">Tip: leave holes blank until you play them — totals start at E.</p>
  `;

  forms.innerHTML = "";
  (data.rounds || []).forEach((r, idx) => {
    forms.appendChild(roundCard(data, r, idx));
  });
})();
