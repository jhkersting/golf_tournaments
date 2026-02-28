const TOURNAMENT_KEY = "golf:lastTournamentId";

function getTournamentId() {
  try {
    return String(localStorage.getItem(TOURNAMENT_KEY) || "").trim();
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

function applyScoreboardLinks() {
  const params = new URLSearchParams(location.search);
  const urlTid = String(params.get("t") || "").trim();
  if (urlTid) {
    try {
      localStorage.setItem(TOURNAMENT_KEY, urlTid);
    } catch (_) {}
  }

  const tid = urlTid || getTournamentId();
  const href = scoreboardHref(tid);
  const edit = editHref(tid);

  document.querySelectorAll("a[data-scoreboard-link]").forEach((link) => {
    link.setAttribute("href", href);
  });
  document.querySelectorAll("a[data-edit-link]").forEach((link) => {
    link.setAttribute("href", edit);
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
