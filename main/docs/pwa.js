import { api, qs, getRememberedPlayerCode, getRememberedTournamentId } from "./app.js";

const state = {
  installPromptEvent: null,
  registrationPromise: null,
  panel: null,
  statusEl: null,
  installButton: null,
  alertsButton: null,
  panelHint: null
};

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function isPlayerFlowPage() {
  return (
    document.body.classList.contains("enter-page") ||
    document.body.classList.contains("scoreboard-page") ||
    document.body.classList.contains("hole-map-page")
  );
}

function isHomePage() {
  return location.pathname.endsWith("/index.html") || location.pathname.endsWith("/") || location.pathname === "/";
}

function getTournamentId() {
  return String(qs("t") || getRememberedTournamentId() || "").trim();
}

function getPlayerCode() {
  return String(qs("code") || qs("c") || getRememberedPlayerCode() || "").trim().toUpperCase();
}

function hasAlertsTarget() {
  return Boolean(getTournamentId() && getPlayerCode());
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

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  if (!state.registrationPromise) {
    state.registrationPromise = navigator.serviceWorker
      .register(new URL("./sw.js", import.meta.url), { scope: "./" })
      .catch((error) => {
        state.registrationPromise = null;
        throw error;
      });
  }
  return state.registrationPromise;
}

async function getSubscription() {
  const registration = await registerServiceWorker();
  if (!registration?.pushManager) return null;
  return registration.pushManager.getSubscription();
}

async function getVapidPublicKey() {
  const response = await api("/push/vapid-public-key");
  const publicKey = String(response?.publicKey || "").trim();
  if (!publicKey) {
    throw new Error("Push notifications are not configured for this deployment yet.");
  }
  return publicKey;
}

function panelCopy() {
  if (isHomePage()) {
    return {
      title: "Install and alerts",
      body: "Add the app to your home screen for full-screen access. If you have a player code, turn on score alerts to get push notifications when new scores are posted."
    };
  }

  return {
    title: "Score alerts",
    body: "Install this app on your home screen, then enable notifications so this device gets pushed when scores are posted."
  };
}

function shouldRenderPanel() {
  return isHomePage() || isPlayerFlowPage();
}

function ensurePanel() {
  if (state.panel || !shouldRenderPanel()) return state.panel;
  const container = document.querySelector(".container");
  if (!container) return null;

  const panel = document.createElement("div");
  panel.className = "card pwa-card";
  panel.dataset.pwaPanel = "true";
  const copy = panelCopy();
  panel.innerHTML = `
    <div class="pwa-head">
      <div>
        <h2 style="margin:0;">${copy.title}</h2>
        <div class="small">${copy.body}</div>
      </div>
      <div class="pill" data-pwa-state>Loading…</div>
    </div>
    <div class="pwa-actions">
      <button type="button" data-pwa-install>Install app</button>
      <button type="button" class="secondary" data-pwa-alerts>Enable score alerts</button>
    </div>
    <div class="small pwa-status" data-pwa-status></div>
  `;

  container.insertBefore(panel, container.firstElementChild);
  state.panel = panel;
  state.statusEl = panel.querySelector("[data-pwa-status]");
  state.installButton = panel.querySelector("[data-pwa-install]");
  state.alertsButton = panel.querySelector("[data-pwa-alerts]");
  state.panelHint = panel.querySelector("[data-pwa-state]");

  state.installButton.addEventListener("click", async () => {
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

  state.alertsButton.addEventListener("click", async () => {
    const hasSubscription = await refreshSubscriptionState();
    if (hasSubscription) {
      await disableScoreAlerts();
    } else {
      await enableScoreAlerts();
    }
  });

  return panel;
}

async function refreshSubscriptionState() {
  const subscription = await getSubscription().catch(() => null);
  const alertsTarget = hasAlertsTarget();
  const promptVisible = Boolean(state.installPromptEvent) && !isStandalone();
  const hasPermission = typeof Notification !== "undefined" ? Notification.permission : "default";

  if (state.panelHint) {
    if (subscription) {
      state.panelHint.textContent = "Score alerts enabled on this device";
    } else if (!alertsTarget) {
      state.panelHint.textContent = isHomePage()
        ? "Open a player page to connect score alerts."
        : "Open the Enter Scores page with your player code to enable alerts.";
    } else if (promptVisible) {
      state.panelHint.textContent = "Install the app and turn on alerts to get push notifications.";
    } else {
      state.panelHint.textContent = "Notifications are ready for this device.";
    }
  }

  setInstallButtonVisible(!isStandalone());
  setAlertsButtonVisible(alertsTarget || Boolean(subscription));

  if (subscription) {
    setAlertsButtonText("Disable score alerts");
    setStatus("Alerts are active for this device.");
  } else if (alertsTarget) {
    setAlertsButtonText("Enable score alerts");
    setStatus(
      hasPermission === "denied"
        ? "Notifications are blocked in this browser. Re-enable them in browser settings, then try again."
        : "Tap to subscribe this device to new score updates."
    );
  } else {
    setAlertsButtonText("Enable score alerts");
    setStatus(
      isHomePage()
        ? "Open a player page to connect a tournament and player code."
        : "Open Enter Scores with your player code to subscribe this device."
    );
  }

  return Boolean(subscription);
}

async function enableScoreAlerts() {
  const tid = getTournamentId();
  const code = getPlayerCode();
  if (!tid || !code) {
    setStatus("Open a player page with your code before enabling alerts.");
    return;
  }

  if (!("Notification" in window)) {
    setStatus("This browser does not support notifications.");
    return;
  }

  if (Notification.permission === "default") {
    const permission = await Notification.requestPermission().catch(() => "denied");
    if (permission !== "granted") {
      setStatus("Notification permission was not granted.");
      return;
    }
  } else if (Notification.permission !== "granted") {
    setStatus("Notifications are blocked in this browser. Re-enable them in browser settings first.");
    return;
  }

  try {
    const registration = await registerServiceWorker();
    if (!registration?.pushManager) {
      setStatus("This browser does not support push subscriptions.");
      return;
    }

    const publicKey = await getVapidPublicKey();
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ||
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      }));

    await api(`/tournaments/${encodeURIComponent(tid)}/push/subscribe`, {
      method: "POST",
      body: {
        code,
        subscription: subscription.toJSON()
      }
    });

    setStatus("Score alerts enabled for this device.");
    await refreshSubscriptionState();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not enable score alerts.");
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
    const registration = await registerServiceWorker();
    const subscription = await registration?.pushManager?.getSubscription?.();
    if (!subscription) {
      setStatus("This device does not have an active score alert subscription.");
      await refreshSubscriptionState();
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
    setStatus("Score alerts disabled for this device.");
    await refreshSubscriptionState();
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

  try {
    await registerServiceWorker();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Service worker registration failed.");
    setAlertsButtonVisible(false);
  }

  if (!("Notification" in window)) {
    setAlertsButtonVisible(false);
    setStatus("This browser does not support notifications.");
  }

  await refreshSubscriptionState();
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.installPromptEvent = event;
  setInstallButtonVisible(!isStandalone());
  if (state.panel) {
    const copy = panelCopy();
    const titleEl = state.panel.querySelector("h2");
    const bodyEl = state.panel.querySelector(".small");
    if (titleEl) titleEl.textContent = copy.title;
    if (bodyEl) bodyEl.textContent = copy.body;
    void refreshSubscriptionState();
  }
});

window.addEventListener("appinstalled", () => {
  state.installPromptEvent = null;
  setInstallButtonVisible(false);
  setStatus("App installed.");
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void initPushUi();
  });
} else {
  void initPushUi();
}
