import { api, staticJson, qs } from "./app.js";

const code = qs("code");
const who = document.getElementById("who");
const forms = document.getElementById("round_forms");

/**
 * Draft (unsent) edits so auto-refresh + rerenders never clobber typing.
 * Structure:
 * draftByRound[r] = {
 *   hole: { [holeIndex]: { [targetId]: string /* input.value  } },
 * bulk: { [targetId]: Array(18).fill(string | undefined) }
 * }
 */
const draftByRound = Object.create(null);

function ensureRoundDraft(r) {
  if (!draftByRound[r]) draftByRound[r] = { hole: Object.create(null), bulk: Object.create(null) };
  return draftByRound[r];
}

function getHoleDraft(r, holeIndex, targetId) {
  return draftByRound[r]?.hole?.[holeIndex]?.[targetId];
}
function setHoleDraft(r, holeIndex, targetId, valueStr) {
  const rd = ensureRoundDraft(r);
  if (!rd.hole[holeIndex]) rd.hole[holeIndex] = Object.create(null);
  rd.hole[holeIndex][targetId] = valueStr; // keep even "" so it stays pristine on rerender
}
function clearHoleDraftTargets(r, holeIndex, targetIds) {
  const h = draftByRound[r]?.hole?.[holeIndex];
  if (!h) return;
  for (const id of targetIds) delete h[id];
  if (Object.keys(h).length === 0) delete draftByRound[r].hole[holeIndex];
}

function getBulkDraft(r, targetId, holeIndex) {
  return draftByRound[r]?.bulk?.[targetId]?.[holeIndex];
}
function setBulkDraft(r, targetId, holeIndex, valueStr) {
  const rd = ensureRoundDraft(r);
  if (!rd.bulk[targetId]) rd.bulk[targetId] = Array(18).fill(undefined);
  rd.bulk[targetId][holeIndex] = valueStr; // keep "" too
}
function clearRoundDraft(r) {
  delete draftByRound[r];
}

function el(tag, attrs = {}, html = null) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "style") n.setAttribute("style", v);
    else n.setAttribute(k, v);
  }
  if (html != null) n.innerHTML = html;
  return n;
}

function isEmptyScore(v) {
  // Treat null/undefined/""/0 as "not played yet" for UI purposes
  return v == null || Number(v) === 0;
}

function nextHoleIndexForGroup(savedByTarget, targetIds) {
  // choose the lowest hole where at least one target doesn't have a score yet
  for (let i = 0; i < 18; i++) {
    for (const id of targetIds) {
      const arr = savedByTarget[id] || Array(18).fill(null);
      const v = arr[i];
      if (isEmptyScore(v)) return i;
    }
  }
  return 17;
}

function keyGroup(tid, roundIndex) {
  return `group:${tid}:${roundIndex}:${code}`;
}

function loadGroup(tid, roundIndex, allPlayers, defaultIds) {
  try {
    const v = JSON.parse(localStorage.getItem(keyGroup(tid, roundIndex)) || "null");
    if (Array.isArray(v) && v.length) return v.filter((id) => allPlayers[id]);
  } catch { }
  return defaultIds.slice();
}

function saveGroup(tid, roundIndex, ids) {
  try {
    localStorage.setItem(keyGroup(tid, roundIndex), JSON.stringify(ids));
  } catch { }
}

function holeLabel(i) {
  return `Hole ${i + 1}`;
}

async function main() {
  if (!code) {
    forms.innerHTML = `<div class="card"><b>Missing code.</b> Open as <code>enter.html?code=XXXX</code></div>`;
    return;
  }

  const enter = await staticJson(`/enter/${encodeURIComponent(code)}.json`, { cacheKey: `enter:${code}` });
  const tid = enter?.tournamentId;
  if (!tid) {
    forms.innerHTML = `<div class="card"><b>Invalid code.</b></div>`;
    return;
  }

  // Tournament public JSON (single file)
  const tjson = await staticJson(`/tournaments/${encodeURIComponent(tid)}.json`, { cacheKey: `t:${tid}` });

  who.style.display = "";
  who.className = "card";
  who.innerHTML = `
    <div style="display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap;">
      <div>
        <div class="small">Tournament</div>
        <div><b>${tjson.tournament?.name || "Tournament"}</b> <span class="small">${tjson.tournament?.dates || ""}</span></div>
      </div>
      <div>
        <div class="small">You are</div>
        <div><b>${enter.player?.name || ""}</b> <span class="small">(code ${code})</span></div>
      </div>
      <div>
        <div class="small">Team</div>
        <div><b>${enter.team?.teamName || enter.team?.teamId || ""}</b></div>
      </div>
    </div>
  `;

  const rounds = tjson.tournament?.rounds || [];
  const course = tjson.course || { pars: Array(18).fill(4), strokeIndex: Array.from({ length: 18 }, (_, i) => i + 1) };

  const playersArr = tjson.players || [];
  const playersById = {};
  for (const p of playersArr) playersById[p.playerId] = p;

  // Default group: self + same team players
  const myId = enter.player?.playerId;
  const myTeamId = (playersById[myId] || {}).teamId || enter.team?.teamId;
  const defaultGroupIds = playersArr
    .filter((p) => p.teamId === myTeamId)
    .map((p) => p.playerId)
    .filter(Boolean);

  forms.innerHTML = "";

  // helper: refresh server tjson without clobbering drafts (drafts are in-memory)
  async function refreshTournamentJson() {
    const fresh = await staticJson(`/tournaments/${encodeURIComponent(tid)}.json?v=${Date.now()}`, { cacheKey: `t:${tid}` });
    Object.assign(tjson, fresh);
  }

  for (let r = 0; r < rounds.length; r++) {
    const round = rounds[r] || {};
    const fmt = round.format || "singles";
    const isScramble = fmt === "scramble";
    const canGroup = !isScramble;

    const roundCard = el("div", { class: "card" });
    roundCard.appendChild(el("h2", { style: "margin:0 0 6px 0;" }, `${round.name || `Round ${r + 1}`} — ${fmt}`));

    const wrap = el("div", { class: "small", style: "margin-bottom:8px;" });
    wrap.textContent = isScramble
      ? "Scramble: enter one team score per hole."
      : "Singles/Shamble: enter player scores. You can choose who you're playing with to enter for them too.";
    roundCard.appendChild(wrap);

    // Group picker
    let groupIds = canGroup
      ? loadGroup(tid, r, playersById, defaultGroupIds.length ? defaultGroupIds : [myId].filter(Boolean))
      : [];
    const groupPicker = el("div", { class: "small", style: canGroup ? "margin:10px 0;" : "display:none;" });

    // panes/tabs created early so render functions can close over them
    const tabs = el("div", { style: "display:flex; gap:8px; margin:10px 0;" });
    const tabHole = el("button", { class: "secondary", type: "button" }, "Hole-by-hole");
    const tabBulk = el("button", { class: "secondary", type: "button" }, "Bulk input");
    tabs.appendChild(tabHole);
    tabs.appendChild(tabBulk);
    roundCard.appendChild(tabs);

    const holePane = el("div");
    const bulkPane = el("div", { style: "display:none;" });
    roundCard.appendChild(holePane);
    roundCard.appendChild(bulkPane);

    tabHole.onclick = () => {
      holePane.style.display = "";
      bulkPane.style.display = "none";
    };
    tabBulk.onclick = () => {
      holePane.style.display = "none";
      bulkPane.style.display = "";
    };

    if (canGroup) {
      const pickerTop = el("div", { style: "display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-bottom:6px;" });
      pickerTop.appendChild(el("b", {}, "Playing with:"));

      const btnMeTeam = el("button", { class: "secondary", type: "button" }, "My team");
      btnMeTeam.onclick = () => {
        groupIds = defaultGroupIds.length ? defaultGroupIds : [myId].filter(Boolean);
        saveGroup(tid, r, groupIds);
        renderHoleForm();
        renderBulkTable();
      };

      const btnAll = el("button", { class: "secondary", type: "button" }, "All players");
      btnAll.onclick = () => {
        groupIds = playersArr.map((p) => p.playerId);
        saveGroup(tid, r, groupIds);
        renderHoleForm();
        renderBulkTable();
      };

      pickerTop.appendChild(btnMeTeam);
      pickerTop.appendChild(btnAll);
      groupPicker.appendChild(pickerTop);

      const list = el("div", {
        style:
          "display:flex; flex-wrap:wrap; gap:10px; max-height:220px; overflow:auto; padding:8px; border:1px solid #ddd; border-radius:10px; background:#fff;",
      });

      for (const p of playersArr) {
        const id = p.playerId;
        const checked = groupIds.includes(id);
        const lbl = el("label", { style: "display:flex; align-items:center; gap:6px; cursor:pointer;" });
        const cb = el("input", { type: "checkbox" });
        cb.checked = checked;
        cb.onchange = () => {
          if (cb.checked) {
            if (!groupIds.includes(id)) groupIds.push(id);
          } else {
            groupIds = groupIds.filter((x) => x !== id);
          }
          if (!groupIds.includes(myId) && myId) groupIds.unshift(myId);
          saveGroup(tid, r, groupIds);
          renderHoleForm();
          renderBulkTable();
        };
        lbl.appendChild(cb);
        lbl.appendChild(el("span", {}, `${p.name}${p.teamId ? ` <span class="small">(${p.teamId})</span>` : ""}`));
        list.appendChild(lbl);
      }

      groupPicker.appendChild(list);
      roundCard.appendChild(groupPicker);
    }

    // Current saved holes from tournament json
    function getSavedForRound() {
      const sd = tjson.score_data?.rounds?.[r] || {};
      if (isScramble) {
        const teamId = enter.team?.teamId;
        const teamEntry = sd.team?.[teamId];
        const gross = (teamEntry?.gross || Array(18).fill(null)).map((v) => (isEmptyScore(v) ? null : v));
        return { type: "team", savedByTarget: { [teamId]: gross }, targetIds: [teamId] };
      } else {
        const savedByTarget = {};
        for (const pid of Object.keys(sd.player || {})) {
          const gross = (sd.player[pid]?.gross || Array(18).fill(null)).map((v) => (isEmptyScore(v) ? null : v));
          savedByTarget[pid] = gross;
        }
        const ids = groupIds.length ? groupIds : [myId].filter(Boolean);
        return { type: "player", savedByTarget, targetIds: ids };
      }
    }

    let currentHole = null;      // not chosen yet
    let holeManuallySet = false; // only true after user clicks prev/next or selects a hole

    const status = el("div", { class: "small", style: "margin-top:10px;" }, "");
    const conflictBox = el("div", { class: "card", style: "display:none; border:2px solid #c41c08; margin-top:10px;" });

    function renderHoleForm() {
      holePane.innerHTML = "";
      conflictBox.style.display = "none";
      status.textContent = "";

      const { type, savedByTarget, targetIds } = getSavedForRound();
      // set currentHole to next unplayed, but keep user-selected if they already moved it manually
      const suggested = nextHoleIndexForGroup(savedByTarget, targetIds);

      // On first load (or if user hasn't manually set a hole), jump to next unplayed
      if (!holeManuallySet || currentHole == null || Number.isNaN(currentHole) || currentHole < 0 || currentHole > 17) {
        currentHole = suggested;
      }

      const header = el("div", {
        style: "display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:flex-end; margin-bottom:8px;",
      });
      header.appendChild(
        el(
          "div",
          {},
          `<b>${holeLabel(currentHole)}</b> <span class="small">Par ${course.pars[currentHole]} • SI ${course.strokeIndex[currentHole]}</span>`
        )
      );

      const holeSel = el("select", { style: "padding:6px 10px; border-radius:10px; border:1px solid #ddd;" });
      for (let i = 0; i < 18; i++) {
        const opt = el("option", { value: String(i) }, `${i + 1}`);
        if (i === currentHole) opt.selected = true;
        holeSel.appendChild(opt);
      }
      holeSel.onchange = () => {
        currentHole = Number(holeSel.value);
        renderHoleForm();
      };

      header.appendChild(el("div", {}, `<span class="small">Jump to hole</span><br/>`));
      header.lastChild.appendChild(holeSel);
      holePane.appendChild(header);

      const grid = el("div", { style: "display:grid; grid-template-columns: 1fr auto; gap:10px; align-items:center;" });

      const inputs = [];

      function makeScoreInput(initialStr) {
        const inp = el("input", {
          type: "number",
          min: "1",
          max: "20",
          step: "1",
          style: "width:100px; padding:8px; border-radius:10px; border:1px solid #ddd; font-size:16px;",
        });
        inp.value = initialStr ?? "";
        return inp;
      }

      if (type === "team") {
        const teamId = targetIds[0];
        const existingRaw = (savedByTarget[teamId] || Array(18).fill(null))[currentHole];
        const existing = isEmptyScore(existingRaw) ? null : existingRaw;

        const draft = getHoleDraft(r, currentHole, teamId);
        const initial = draft !== undefined ? draft : existing == null ? "" : String(existing);

        const row = el("div", {
          style: "display:flex; gap:10px; align-items:center; flex-wrap:wrap; padding:10px; border:1px solid #eee; border-radius:12px; background:#fff;",
        });
        row.appendChild(
          el(
            "div",
            { style: "min-width:180px;" },
            `<b>${enter.team?.teamName || "Team"}</b> <span class="small">(team score)</span><br/><span class="small">Existing: ${existing == null ? "—" : existing
            }</span>`
          )
        );

        const inp = makeScoreInput(initial);
        inp.addEventListener("input", () => setHoleDraft(r, currentHole, teamId, inp.value));
        inputs.push({ targetId: teamId, input: inp });

        row.appendChild(inp);
        grid.appendChild(row);
      } else {
        const ids = targetIds.length ? targetIds : [myId].filter(Boolean);
        for (const pid of ids) {
          const p = playersById[pid];
          if (!p) continue;

          const existingRaw = (savedByTarget[pid] || Array(18).fill(null))[currentHole];
          const existing = isEmptyScore(existingRaw) ? null : existingRaw;

          const draft = getHoleDraft(r, currentHole, pid);
          const initial = draft !== undefined ? draft : existing == null ? "" : String(existing);

          const row = el("div", {
            style: "display:flex; gap:10px; align-items:center; flex-wrap:wrap; padding:10px; border:1px solid #eee; border-radius:12px; background:#fff;",
          });
          row.appendChild(
            el(
              "div",
              { style: "min-width:180px;" },
              `<b>${p.name}</b> <span class="small">${p.handicap != null ? `(hcp ${p.handicap})` : ""}</span><br/><span class="small">Existing: ${existing == null ? "—" : existing
              }</span>`
            )
          );

          const inp = makeScoreInput(initial);
          inp.addEventListener("input", () => setHoleDraft(r, currentHole, pid, inp.value));
          inputs.push({ targetId: pid, input: inp });

          row.appendChild(inp);
          grid.appendChild(row);
        }
      }

      holePane.appendChild(grid);

      const actions = el("div", { style: "display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:10px;" });
      const btnSubmit = el("button", { class: "", type: "button" }, "Submit hole");
      const btnNext = el("button", { class: "secondary", type: "button" }, "Next hole →");
      const btnPrev = el("button", { class: "secondary", type: "button" }, "← Prev hole");
      actions.appendChild(btnSubmit);
      actions.appendChild(btnPrev);
      actions.appendChild(btnNext);
      holePane.appendChild(actions);
      holePane.appendChild(status);
      holePane.appendChild(conflictBox);

      btnPrev.onclick = () => {
        currentHole = Math.max(0, currentHole - 1);
        renderHoleForm();
      };
      btnNext.onclick = () => {
        currentHole = Math.min(17, currentHole + 1);
        renderHoleForm();
      };

      async function doSubmit(withOverride = false) {
        status.textContent = "Submitting…";
        conflictBox.style.display = "none";

        const entries = [];
        for (const { targetId, input } of inputs) {
          const v = (input.value ?? "").trim();
          if (v === "") continue; // skip blanks
          entries.push({ targetId, strokes: Number(v) });
        }
        if (!entries.length) {
          status.textContent = "Enter at least one score for this hole.";
          return;
        }

        try {
          await api(`/tournaments/${encodeURIComponent(tid)}/scores`, {
            method: "POST",
            body: {
              code,
              roundIndex: r,
              mode: "hole",
              holeIndex: currentHole,
              entries,
              override: withOverride,
            },
          });

          status.textContent = "Saved.";

          // clear drafts ONLY for the targets you actually submitted (for this hole)
          clearHoleDraftTargets(
            r,
            currentHole,
            entries.map((e) => e.targetId)
          );

          // refresh tournament json quickly (cache-bust)
          await refreshTournamentJson();

          // advance to next unplayed hole for group
          const nowSaved = getSavedForRound();
          currentHole = nextHoleIndexForGroup(nowSaved.savedByTarget, nowSaved.targetIds);

          renderHoleForm();
          renderBulkTable();
        } catch (err) {
          if (err?.status === 409 && err?.data) {
            showConflict(err.data);
            return;
          }
          status.textContent = `Error: ${err?.message || String(err)}`;
        }
      }

      function showConflict(j) {
        const conflicts = j.conflicts || [];
        const names = conflicts.map((c) => {
          const p = playersById[c.targetId];
          return p ? p.name : c.targetId;
        });
        conflictBox.style.display = "";
        conflictBox.innerHTML = `
          <b>Scores already posted for ${holeLabel(currentHole)}.</b><br/>
          <div class="small" style="margin-top:6px;">
            ${names.length ? `Conflicts: ${names.join(", ")}` : "Conflict."}<br/>
            You must press Override to replace existing scores.
          </div>
        `;
        const btn = el("button", { class: "", type: "button", style: "margin-top:10px;" }, "Override hole and submit");
        btn.onclick = () => doSubmit(true);
        conflictBox.appendChild(btn);
        status.textContent = "Not saved (conflict).";
      }

      btnSubmit.onclick = () => doSubmit(false);
    }

    function renderBulkTable() {
      bulkPane.innerHTML = "";

      const { type, savedByTarget, targetIds } = getSavedForRound();
      const ids = type === "team" ? targetIds : targetIds.length ? targetIds : [myId].filter(Boolean);

      const info = el(
        "div",
        { class: "small", style: "margin-bottom:10px;" },
        "Bulk input: paste/update multiple holes then submit. Existing scores will not be overwritten unless you use Override."
      );
      bulkPane.appendChild(info);

      const tbl = el("table", { class: "table" });
      const thead = el("thead");
      const trH = el("tr");
      trH.innerHTML =
        `<th class="left">${type === "team" ? "Team" : "Player"}</th>` +
        Array.from({ length: 18 }, (_, i) => `<th>${i + 1}</th>`).join("") +
        `<th>Submit</th>`;
      thead.appendChild(trH);
      tbl.appendChild(thead);

      const tbody = el("tbody");
      const rowInputs = {};

      for (const id of ids) {
        const name = type === "team" ? enter.team?.teamName || id : playersById[id]?.name || id;
        const holes = (savedByTarget[id] || Array(18).fill(null)).map((v) => (isEmptyScore(v) ? null : v));

        const tr = el("tr");
        tr.appendChild(el("td", { class: "left" }, `<b>${name}</b>`));

        rowInputs[id] = [];
        for (let i = 0; i < 18; i++) {
          const td = el("td");

          const inp = el("input", { type: "number", min: "1", max: "20", step: "1", class: "hole-input" });
          inp.style.width = "42px";
          inp.style.padding = "4px 6px";
          inp.style.borderRadius = "8px";
          inp.style.border = "1px solid #ddd";

          // choose value: draft (if present) else saved
          const dv = getBulkDraft(r, id, i);
          const initial = dv !== undefined ? dv : holes[i] == null ? "" : String(holes[i]);
          inp.value = initial ?? "";

          inp.addEventListener("input", () => setBulkDraft(r, id, i, inp.value));

          rowInputs[id].push(inp);
          td.appendChild(inp);
          tr.appendChild(td);
        }

        const tdBtn = el("td");
        tdBtn.appendChild(el("span", { class: "small" }, "Use buttons below"));
        tr.appendChild(tdBtn);

        tbody.appendChild(tr);
      }

      tbl.appendChild(tbody);
      bulkPane.appendChild(tbl);

      const bulkStatus = el("div", { class: "small", style: "margin-top:10px;" }, "");
      const btnRow = el("div", { style: "display:flex; gap:10px; flex-wrap:wrap; margin-top:10px;" });
      const btnSubmit = el("button", { class: "", type: "button" }, "Submit bulk");
      const btnOverride = el("button", { class: "secondary", type: "button" }, "Override & submit bulk");
      btnRow.appendChild(btnSubmit);
      btnRow.appendChild(btnOverride);
      bulkPane.appendChild(btnRow);
      bulkPane.appendChild(bulkStatus);

      async function submitBulk(withOverride) {
        bulkStatus.textContent = "Submitting…";

        const entries = [];
        for (const id of ids) {
          const holes = rowInputs[id].map((inp) => {
            const v = (inp.value ?? "").trim();
            // keep null for blanks; treat "0" as blank (unplayed) too
            if (v === "" || Number(v) === 0) return null;
            return Number(v);
          });
          entries.push({ targetId: id, holes });
        }

        try {
          await api(`/tournaments/${encodeURIComponent(tid)}/scores`, {
            method: "POST",
            body: {
              code,
              roundIndex: r,
              mode: "bulk",
              entries,
              override: !!withOverride,
            },
          });

          bulkStatus.textContent = "Saved.";

          // bulk submit = clear all drafts for this round (hole + bulk)
          clearRoundDraft(r);

          await refreshTournamentJson();

          renderHoleForm();
          renderBulkTable();
        } catch (e) {
          bulkStatus.textContent = `Error: ${e?.message || String(e)}`;
        }
      }

      btnSubmit.onclick = () => submitBulk(false);
      btnOverride.onclick = () => submitBulk(true);
    }

    // initial render
    renderHoleForm();
    renderBulkTable();

    // Auto-refresh to pick up others' scores quickly (every 30s) without clobbering drafts
    const refreshTimer = setInterval(async () => {
      try {
        await refreshTournamentJson();
        renderHoleForm();
        renderBulkTable();
      } catch { }
    }, 30_000);

    // keep the timer from being GC'd (optional)
    roundCard._refreshTimer = refreshTimer;

    forms.appendChild(roundCard);
  }
}

main().catch((e) => {
  forms.innerHTML = `<div class="card"><b>Error:</b> ${e?.message || String(e)}</div>`;
});