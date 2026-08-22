const VIEWER_ID_KEY = "golf:draftViewerId";
const VIEWER_SESSION_KEY = "golf:draftViewerSession";
const HEARTBEAT_INTERVAL_MS = 10_000;

function storedValue(key) {
  try {
    return sessionStorage.getItem(key) || "";
  } catch (_) {
    return "";
  }
}

function storeValue(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch (_) {
    // Presence still works for this page even if storage is unavailable.
  }
}

function viewerSessionId() {
  const stored = storedValue(VIEWER_SESSION_KEY);
  if (/^[A-Za-z0-9_-]{12,80}$/.test(stored)) return stored;
  const generated = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID().replaceAll("-", "")
    : `${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
  storeValue(VIEWER_SESSION_KEY, generated);
  return generated;
}

export function initDraftPresence({ apiBase, players }) {
  const directory = (Array.isArray(players) ? players : [])
    .map((player) => ({ id: String(player?.id || ""), name: String(player?.name || "") }))
    .filter((player) => player.id && player.name);
  const byId = new Map(directory.map((player) => [player.id, player]));
  const list = document.getElementById("live_viewers");
  const changeButton = document.getElementById("viewer_change");
  const dialog = document.getElementById("viewer_picker");
  const form = document.getElementById("viewer_form");
  const select = document.getElementById("viewer_select");
  const status = document.getElementById("viewer_picker_status");
  let viewerId = byId.has(storedValue(VIEWER_ID_KEY)) ? storedValue(VIEWER_ID_KEY) : "";
  let viewers = [];
  let heartbeatPending = false;

  for (const player of directory) {
    const option = document.createElement("option");
    option.value = player.id;
    option.textContent = player.name;
    select.append(option);
  }

  function renderViewers() {
    list.replaceChildren();
    if (!viewers.length) {
      const empty = document.createElement("span");
      empty.className = "live-viewers-empty";
      empty.textContent = viewerId ? "Joining live view…" : "Choose your name to join";
      list.append(empty);
    } else {
      for (const viewer of viewers) {
        const chip = document.createElement("span");
        chip.className = `live-viewer-chip${viewer.playerId === viewerId ? " is-you" : ""}`;
        chip.textContent = `${viewer.name}${viewer.playerId === viewerId ? " · you" : ""}`;
        list.append(chip);
      }
    }
    changeButton.textContent = viewerId ? "Change name" : "Choose name";
  }

  function applyViewers(raw) {
    if (!Array.isArray(raw)) return;
    viewers = raw
      .map((viewer) => ({ playerId: String(viewer?.playerId || ""), name: String(viewer?.name || "") }))
      .filter((viewer) => byId.has(viewer.playerId) && viewer.name);
    renderViewers();
  }

  function openPicker() {
    select.value = viewerId;
    status.textContent = "";
    if (!dialog.open) dialog.showModal();
    window.setTimeout(() => select.focus(), 0);
  }

  async function heartbeat({ selecting = false } = {}) {
    if (!viewerId || heartbeatPending || document.visibilityState === "hidden") return;
    heartbeatPending = true;
    try {
      const response = await fetch(`${apiBase}/draft`, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "watch", viewerId, viewerSessionId: viewerSessionId() })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || `Live viewer request failed (${response.status})`);
      applyViewers(payload.viewers);
      status.textContent = "";
      if (selecting && dialog.open) dialog.close();
    } catch (error) {
      if (selecting) status.textContent = error.message;
    } finally {
      heartbeatPending = false;
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const selected = String(new FormData(form).get("viewerId") || "");
    if (!byId.has(selected)) {
      status.textContent = "Select your name.";
      return;
    }
    viewerId = selected;
    storeValue(VIEWER_ID_KEY, viewerId);
    renderViewers();
    status.textContent = "Joining live view…";
    await heartbeat({ selecting: true });
  });
  dialog.addEventListener("cancel", (event) => {
    if (!viewerId) event.preventDefault();
  });
  changeButton.addEventListener("click", openPicker);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") heartbeat();
  });

  renderViewers();
  if (viewerId) heartbeat();
  else openPicker();
  window.setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);

  return { applyViewers, heartbeat };
}
