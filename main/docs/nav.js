const TOURNAMENT_KEY = "golf:lastTournamentId";
const PLAYER_CODE_KEY = "golf:lastPlayerCode";

function getTournamentId() {
  try {
    return String(localStorage.getItem(TOURNAMENT_KEY) || "").trim();
  } catch (_) {
    return "";
  }
}

function normalizePlayerCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function getPlayerCode() {
  try {
    return normalizePlayerCode(localStorage.getItem(PLAYER_CODE_KEY) || "");
  } catch (_) {
    return "";
  }
}

function scoreboardHref(tournamentId) {
  return tournamentId ? `./scoreboard.html?t=${encodeURIComponent(tournamentId)}` : "./scoreboard.html";
}

function editHref(tournamentId) {
  return tournamentId ? `./edit.html?t=${encodeURIComponent(tournamentId)}` : "./edit.html";
}

function enterHref(playerCode) {
  return playerCode ? `./hole-map.html?code=${encodeURIComponent(playerCode)}` : "./hole-map.html";
}

function applyScoreboardLinks() {
  const params = new URLSearchParams(location.search);
  const urlTid = String(params.get("t") || "").trim();
  const urlCode = normalizePlayerCode(params.get("code") || params.get("c"));
  if (urlTid) {
    try {
      localStorage.setItem(TOURNAMENT_KEY, urlTid);
    } catch (_) {}
  }
  if (urlCode) {
    try {
      localStorage.setItem(PLAYER_CODE_KEY, urlCode);
    } catch (_) {}
  }

  const tid = urlTid || getTournamentId();
  const playerCode = urlCode || getPlayerCode();
  const href = scoreboardHref(tid);
  const edit = editHref(tid);
  const enter = enterHref(playerCode);

  document.querySelectorAll("a[data-scoreboard-link]").forEach((link) => {
    link.setAttribute("href", href);
  });
  document.querySelectorAll("a[data-edit-link]").forEach((link) => {
    link.setAttribute("href", edit);
  });
  document.querySelectorAll("a[data-enter-link]").forEach((link) => {
    link.setAttribute("href", enter);
  });
}

function applyMobileMenu() {
  const nav = document.querySelector(".nav");
  const toggle = document.querySelector("[data-menu-toggle]");
  const actions = nav?.querySelector(".actions");
  if (!nav || !toggle || !actions) return;

  function setOpen(isOpen) {
    nav.classList.toggle("menu-open", isOpen);
    toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    toggle.textContent = isOpen ? "✕" : "☰";
  }

  setOpen(false);

  toggle.addEventListener("click", () => {
    setOpen(!nav.classList.contains("menu-open"));
  });

  actions.querySelectorAll("a, button").forEach((node) => {
    node.addEventListener("click", () => {
      if (window.matchMedia("(max-width: 560px)").matches) {
        setOpen(false);
      }
    });
  });

  window.addEventListener("resize", () => {
    if (!window.matchMedia("(max-width: 560px)").matches) {
      setOpen(false);
    }
  });
}

function initNav() {
  applyScoreboardLinks();
  applyMobileMenu();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initNav);
} else {
  initNav();
}
