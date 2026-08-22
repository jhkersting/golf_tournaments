import { api, qs, getRememberedPlayerCode, getRememberedTournamentId } from "./app.js";

const state = {
  installPromptEvent: null,
  registrationPromise: null,
  readyRegistration: null,
  vapidPublicKey: "",
  vapidPublicKeyPromise: null,
  resolvedAlertsTarget: null,
  registeredTargetKeys: new Set(),
  targetSyncPromises: new Map(),
  panel: null,
  statusEl: null,
  installButton: null,
  alertsButton: null,
  panelHint: null,
  showBannerStatus: false,
};

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function isPlayerFlowPage() {
  return (
    document.body.classList.contains("enter-page") ||
    document.body.classList.contains("scoreboard-page")
  );
}

function isHomePage() {
  return location.pathname.endsWith("/index.html") || location.pathname.endsWith("/") || location.pathname === "/";
}

function normalizedPlayerCode(value) {
  return String(value || "").trim().toUpperCase();
}

function getAlertsTarget() {
  if (state.resolvedAlertsTarget) return state.resolvedAlertsTarget;

  const queryTournamentId = String(qs("t") || "").trim();
  const queryPlayerCode = normalizedPlayerCode(qs("code") || qs("c"));

  // Enter links only contain the player code. Do not pair that code with a
  // possibly stale remembered tournament while enter.js resolves the code.
  if (document.body?.classList.contains("enter-page") && queryPlayerCode && !queryTournamentId) {
    return {
      tournamentId: "",
      playerCode: queryPlayerCode
    };
  }

  return {
    tournamentId: queryTournamentId || String(getRememberedTournamentId() || "").trim(),
    playerCode: queryPlayerCode || normalizedPlayerCode(getRememberedPlayerCode())
  };
}

function getTournamentId() {
  return getAlertsTarget().tournamentId;
}

function getPlayerCode() {
  return getAlertsTarget().playerCode;
}

function hasAlertsTarget() {
  return Boolean(getTournamentId() && getPlayerCode());
}

function alertsTargetKey(target = getAlertsTarget()) {
  const tournamentId = String(target?.tournamentId || "").trim();
  const playerCode = normalizedPlayerCode(target?.playerCode);
  return tournamentId && playerCode ? `${tournamentId}:${playerCode}` : "";
}

function alertsDisabledStorageKey(target = getAlertsTarget()) {
  const key = alertsTargetKey(target);
  return key ? `golf:scoreAlertsDisabled:${key}` : "";
}

function isAlertsAutoSyncDisabled(target = getAlertsTarget()) {
  const key = alertsDisabledStorageKey(target);
  if (!key) return false;
  try {
    return localStorage.getItem(key) === "1";
  } catch (_) {
    return false;
  }
}

function setAlertsAutoSyncDisabled(target, disabled) {
  const key = alertsDisabledStorageKey(target);
  if (!key) return;
  try {
    if (disabled) {
      localStorage.setItem(key, "1");
    } else {
      localStorage.removeItem(key);
    }
  } catch (_) {
    // The alert still works for this session when storage is unavailable.
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function setStatus(message) {
  if (!state.statusEl) return;
  state.statusEl.textContent = message || "";
  state.statusEl.hidden = !message;
  state.panel?.classList.toggle("has-status", Boolean(message) && state.showBannerStatus);
  if (state.panel) state.panel.title = message || "";
}

function setInstallButtonVisible(visible) {
  if (!state.installButton) return;
  state.installButton.hidden = !visible;
}

function setAlertsButtonVisible(visible) {
  if (!state.alertsButton) return;
  state.alertsButton.hidden = !visible;
}

function setAlertsButtonText(text) {
  if (!state.alertsButton) return;
  state.alertsButton.textContent = text;
}

function setAlertsButtonMode(enabled) {
  if (!state.alertsButton) return;
  state.alertsButton.dataset.alertsAction = enabled ? "disable" : "enable";
  setAlertsButtonText(enabled ? "Disable score alerts" : "Enable score alerts");
}

function setAlertsButtonReady(ready) {
  if (!state.alertsButton) return;
  state.alertsButton.disabled = !ready;
}

function showAlertsToast(title, body) {
  window.dispatchEvent(new CustomEvent("golf-pwa-toast", {
    detail: {
      title: String(title || "Score alerts").trim() || "Score alerts",
      body: String(body || "").trim()
    }
  }));
}

function subscriptionErrorMessage(error) {
  const name = String(error?.name || "").trim();
  const message = String(error?.message || "").trim();
  const detail = [name, message].filter(Boolean).join(": ");
  return detail || "The phone could not create a push subscription.";
}

function setPanelVisible(visible) {
  if (!state.panel) return;
  state.panel.hidden = !visible;
}

function handleServiceWorkerMessage(event) {
  const data = event?.data || {};
  if (data.type !== "chat-notification") return;
  if (document.hidden) return;

  window.dispatchEvent(
    new CustomEvent("golf-chat-toast", {
      detail: data.notification || data
    })
  );
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  if (!state.registrationPromise) {
    state.registrationPromise = navigator.serviceWorker
      .register(new URL("./sw.js", import.meta.url), { scope: "./" })
      .then(async (registration) => {
        const readyRegistration = await navigator.serviceWorker.ready;
        state.readyRegistration = readyRegistration || registration;
        return state.readyRegistration;
      })
      .catch((error) => {
        state.registrationPromise = null;
        state.readyRegistration = null;
        throw error;
      });
  }
  return state.registrationPromise;
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", handleServiceWorkerMessage);
}

async function getSubscription() {
  const registration = await registerServiceWorker();
  if (!registration?.pushManager) return null;
  return registration.pushManager.getSubscription();
}

async function getVapidPublicKey() {
  if (state.vapidPublicKey) return state.vapidPublicKey;
  if (!state.vapidPublicKeyPromise) {
    state.vapidPublicKeyPromise = api("/push/vapid-public-key")
      .then((response) => {
        const publicKey = String(response?.publicKey || "").trim();
        if (!publicKey) {
          throw new Error("Push notifications are not configured for this deployment yet.");
        }
        state.vapidPublicKey = publicKey;
        return publicKey;
      })
      .catch((error) => {
        state.vapidPublicKeyPromise = null;
        throw error;
      });
  }
  return state.vapidPublicKeyPromise;
}

function createSubscription(registration, publicKey = state.vapidPublicKey) {
  if (!registration?.pushManager) {
    throw new Error("This browser does not support push subscriptions.");
  }
  if (!publicKey) {
    throw new Error("Score alerts are still preparing. Tap Enable score alerts again.");
  }
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey)
  });
}

async function registerSubscriptionForTarget(subscription, target = getAlertsTarget()) {
  const targetKey = alertsTargetKey(target);
  if (!subscription || !targetKey) return false;

  const inFlight = state.targetSyncPromises.get(targetKey);
  if (inFlight) return inFlight;

  const promise = (async () => {
    await api(`/tournaments/${encodeURIComponent(target.tournamentId)}/push/subscribe`, {
      method: "POST",
      body: {
        code: target.playerCode,
        subscription: subscription.toJSON()
      }
    });
    state.registeredTargetKeys.add(targetKey);
    return true;
  })().finally(() => {
    state.targetSyncPromises.delete(targetKey);
  });

  state.targetSyncPromises.set(targetKey, promise);
  return promise;
}

function shouldRenderPanel() {
  return isHomePage() || isPlayerFlowPage();
}

function ensurePanel() {
  if (state.panel || !shouldRenderPanel()) return state.panel;
  const bannerActions = document.querySelector("header .nav .actions");
  if (!bannerActions) return null;

  const panel = document.createElement("div");
  panel.className = "pwa-banner-actions";
  panel.dataset.pwaPanel = "true";
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", "App options");
  panel.innerHTML = `
    <button type="button" class="pwa-banner-button" data-pwa-install aria-describedby="pwa_banner_hint pwa_banner_status">Install app</button>
    <button type="button" class="pwa-banner-button" data-pwa-alerts aria-describedby="pwa_banner_hint pwa_banner_status" disabled>Enable score alerts</button>
    <span class="pwa-banner-hint" id="pwa_banner_hint" data-pwa-state>Loading…</span>
    <span class="pwa-banner-status" id="pwa_banner_status" data-pwa-status role="status" aria-live="polite"></span>
  `;

  bannerActions.appendChild(panel);
  state.panel = panel;
  state.statusEl = panel.querySelector("[data-pwa-status]");
  state.installButton = panel.querySelector("[data-pwa-install]");
  state.alertsButton = panel.querySelector("[data-pwa-alerts]");
  state.panelHint = panel.querySelector("[data-pwa-state]");

  state.installButton.addEventListener("click", async () => {
    state.showBannerStatus = true;
    if (!state.installPromptEvent) {
      setStatus("Use your browser's Add to Home Screen action to install this app.");
      return;
    }
    state.installPromptEvent.prompt();
    const choice = await state.installPromptEvent.userChoice.catch(() => ({ outcome: "dismissed" }));
    state.installPromptEvent = null;
    setInstallButtonVisible(false);
    if (choice?.outcome === "accepted") {
      setStatus("App installed. You can now enable score alerts on a player page.");
    } else {
      setStatus("Install prompt dismissed.");
    }
  });

  state.alertsButton.addEventListener("click", () => {
    state.showBannerStatus = true;
    if (state.alertsButton?.dataset.alertsAction === "disable") {
      void disableScoreAlerts();
    } else {
      // Keep this call directly connected to the tap. iOS requires the push
      // subscription request to retain transient user activation.
      void enableScoreAlerts();
    }
  });

  return panel;
}

async function refreshSubscriptionState({ syncExisting = true } = {}) {
  const target = getAlertsTarget();
  const targetKey = alertsTargetKey(target);
  let subscription = await getSubscription().catch(() => null);
  const alertsTarget = hasAlertsTarget();
  const promptVisible = Boolean(state.installPromptEvent) && !isStandalone();
  const hasPermission = typeof Notification !== "undefined" ? Notification.permission : "default";
  let syncError = null;
  let isRegisteredForTarget = Boolean(subscription && targetKey && state.registeredTargetKeys.has(targetKey));

  const shouldSync =
    syncExisting &&
    isPlayerFlowPage() &&
    alertsTarget &&
    hasPermission === "granted" &&
    !isAlertsAutoSyncDisabled(target);

  if (shouldSync && !isRegisteredForTarget) {
    try {
      // Existing subscriptions can be paired with the current player in the
      // background. Creating a new one must remain directly tied to a tap on
      // browsers such as iOS Safari.
      if (subscription) {
        isRegisteredForTarget = await registerSubscriptionForTarget(subscription, target);
      }
    } catch (error) {
      state.registeredTargetKeys.delete(targetKey);
      syncError = error;
    }
  }

  const hidePanel = isRegisteredForTarget;

  if (state.panelHint) {
    if (isRegisteredForTarget) {
      state.panelHint.textContent = "Score alerts enabled on this device";
    } else if (!alertsTarget) {
      state.panelHint.textContent = isHomePage()
        ? "Open a player page to connect score alerts."
        : "Open the Enter Scores page with your player code to enable alerts.";
    } else if (subscription) {
      state.panelHint.textContent = "Connect score alerts to this player";
    } else if (promptVisible) {
      state.panelHint.textContent = "Install the app and turn on alerts to get push notifications.";
    } else {
      state.panelHint.textContent = "Notifications are ready for this device.";
    }
  }

  setInstallButtonVisible(!isStandalone());
  setAlertsButtonVisible(alertsTarget || Boolean(subscription));

  if (isRegisteredForTarget) {
    setAlertsButtonMode(true);
    setStatus("Alerts are active for this device.");
  } else if (alertsTarget) {
    setAlertsButtonMode(false);
    setStatus(
      syncError instanceof Error
        ? syncError.message
        : hasPermission === "denied"
        ? "Notifications are blocked in this browser. Re-enable them in browser settings, then try again."
        : "Tap to subscribe this device to new score updates."
    );
  } else {
    setAlertsButtonMode(false);
    setStatus(
      isHomePage()
        ? "Open a player page to connect a tournament and player code."
        : "Open Enter Scores with your player code to subscribe this device."
    );
  }

  setPanelVisible(!hidePanel);

  return isRegisteredForTarget;
}

async function enableScoreAlerts() {
  const tid = getTournamentId();
  const code = getPlayerCode();
  if (!tid || !code) {
    setStatus("Open a player page with your code before enabling alerts.");
    return;
  }

  if (!("Notification" in window)) {
    const message = "This browser does not support notifications.";
    setStatus(message);
    showAlertsToast("Score alerts not enabled", message);
    return;
  }

  const target = { tournamentId: tid, playerCode: code };
  const registration = state.readyRegistration;
  const publicKey = state.vapidPublicKey;
  if (!registration?.pushManager || !publicKey) {
    const message = "Score alerts are still preparing. Tap Enable score alerts again.";
    setStatus(message);
    showAlertsToast("Score alerts not enabled", message);
    void Promise.allSettled([registerServiceWorker(), getVapidPublicKey()]).then(() => {
      setAlertsButtonReady(Boolean(state.readyRegistration?.pushManager && state.vapidPublicKey));
    });
    return;
  }

  if (Notification.permission === "default") {
    const permission = await Notification.requestPermission().catch(() => "denied");
    if (permission !== "granted") {
      const message = "Notification permission was not granted.";
      setStatus(message);
      showAlertsToast("Score alerts not enabled", message);
      return;
    }
  } else if (Notification.permission !== "granted") {
    const message = "Notifications are blocked in this browser. Re-enable them in browser settings first.";
    setStatus(message);
    showAlertsToast("Score alerts not enabled", message);
    return;
  }

  try {
    // Do not await a state check before this call. Starting subscribe here
    // preserves the user activation required by iOS web push.
    const subscription = await createSubscription(registration, publicKey);

    await registerSubscriptionForTarget(subscription, target);
    setAlertsAutoSyncDisabled(target, false);

    setStatus("Score alerts enabled for this device.");
    showAlertsToast("Score alerts enabled", "This phone will receive team match play score updates.");
    await refreshSubscriptionState({ syncExisting: false });
  } catch (error) {
    const message = subscriptionErrorMessage(error);
    setStatus(message);
    showAlertsToast("Score alerts not enabled", message);
  }
}

async function disableScoreAlerts() {
  const tid = getTournamentId();
  const code = getPlayerCode();
  if (!tid) {
    setStatus("Open a tournament page before disabling alerts.");
    return;
  }

  try {
    const target = { tournamentId: tid, playerCode: code };
    const registration = await registerServiceWorker();
    const subscription = await registration?.pushManager?.getSubscription?.();
    if (!subscription) {
      state.registeredTargetKeys.delete(alertsTargetKey(target));
      setAlertsAutoSyncDisabled(target, true);
      setStatus("This device does not have an active score alert subscription.");
      await refreshSubscriptionState({ syncExisting: false });
      return;
    }

    await api(`/tournaments/${encodeURIComponent(tid)}/push/unsubscribe`, {
      method: "POST",
      body: {
        code: code || "",
        endpoint: subscription.endpoint
      }
    });
    await subscription.unsubscribe();
    state.registeredTargetKeys.clear();
    setAlertsAutoSyncDisabled(target, true);
    setStatus("Score alerts disabled for this device.");
    await refreshSubscriptionState({ syncExisting: false });
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not disable score alerts.");
  }
}

async function initPushUi() {
  ensurePanel();
  if (!state.panel) {
    void registerServiceWorker().catch(() => null);
    return;
  }

  const [registrationResult, keyResult] = await Promise.allSettled([
    registerServiceWorker(),
    getVapidPublicKey()
  ]);
  if (registrationResult.status === "rejected") {
    setStatus(registrationResult.reason instanceof Error ? registrationResult.reason.message : "Service worker registration failed.");
    setAlertsButtonVisible(false);
  }
  if (keyResult.status === "rejected") {
    setStatus(keyResult.reason instanceof Error ? keyResult.reason.message : "Score alert configuration failed to load.");
  }

  if (!("Notification" in window)) {
    setAlertsButtonVisible(false);
    setStatus("This browser does not support notifications.");
  }

  setAlertsButtonReady(Boolean(state.readyRegistration?.pushManager && state.vapidPublicKey));

  await refreshSubscriptionState();
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.installPromptEvent = event;
  setInstallButtonVisible(!isStandalone());
  if (state.panel) void refreshSubscriptionState();
});

window.addEventListener("appinstalled", () => {
  state.installPromptEvent = null;
  setInstallButtonVisible(false);
  setStatus("App installed.");
});

window.addEventListener("golf-player-context-ready", (event) => {
  const tournamentId = String(event?.detail?.tournamentId || event?.detail?.tid || "").trim();
  const playerCode = normalizedPlayerCode(event?.detail?.playerCode || event?.detail?.code);
  if (!tournamentId || !playerCode) return;

  state.resolvedAlertsTarget = { tournamentId, playerCode };
  void refreshSubscriptionState({ syncExisting: true });
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void initPushUi();
  });
} else {
  void initPushUi();
}
