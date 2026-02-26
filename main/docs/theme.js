const THEME_KEY = "golf-ui-theme";

function getSystemTheme() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (_) {}
}

function updateToggleLabel(btn) {
  const current = document.documentElement.dataset.theme || getSystemTheme();
  const next = current === "dark" ? "light" : "dark";
  btn.textContent = current === "dark" ? "Light mode" : "Dark mode";
  btn.setAttribute("aria-label", `Switch to ${next} mode`);
  btn.setAttribute("title", `Switch to ${next} mode`);
}

function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch (_) {}

  const theme = saved === "dark" || saved === "light" ? saved : getSystemTheme();
  document.documentElement.dataset.theme = theme;
}

initTheme();

window.addEventListener("DOMContentLoaded", () => {
  const toggle = document.querySelector("[data-theme-toggle]");
  if (!toggle) return;

  updateToggleLabel(toggle);
  toggle.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme || getSystemTheme();
    const next = current === "dark" ? "light" : "dark";
    setTheme(next);
    updateToggleLabel(toggle);
  });

  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", () => {
    let saved = null;
    try {
      saved = localStorage.getItem(THEME_KEY);
    } catch (_) {}
    if (!saved) {
      document.documentElement.dataset.theme = getSystemTheme();
      updateToggleLabel(toggle);
    }
  });
});
