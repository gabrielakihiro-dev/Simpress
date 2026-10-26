// @ts-check
(function () {
  const storageKey = "simpress:theme";
  const allowedThemes = new Set(["dark", "light"]);

  function getSavedTheme() {
    try {
      const savedTheme = window.localStorage.getItem(storageKey);
      return allowedThemes.has(savedTheme) ? savedTheme : "dark";
    } catch (error) {
      return "dark";
    }
  }

  /** @param {string | undefined} theme */
  function updateToggle(theme) {
    const button = document.getElementById("theme-toggle");
    if (!button) return;

    const targetTheme = theme === "dark" ? "light" : "dark";
    const label = targetTheme === "light" ? "Ativar modo claro" : "Ativar modo escuro";
    button.setAttribute("aria-label", label);
    button.title = label;
  }

  /** @param {string | undefined} theme @param {boolean} persist */
  function applyTheme(theme, persist) {
    const nextTheme = allowedThemes.has(theme) ? theme : "dark";
    document.documentElement.dataset.theme = nextTheme;
    updateToggle(nextTheme);

    if (!persist) return;
    try {
      window.localStorage.setItem(storageKey, nextTheme);
    } catch (error) {
      // The current page still follows the selected theme when storage is unavailable.
    }
  }

  document.documentElement.dataset.theme = getSavedTheme();

  function initializeToggle() {
    updateToggle(document.documentElement.dataset.theme);
  }

  document.addEventListener("click", function (event) {
    const button = event.target instanceof Element ? event.target.closest("#theme-toggle") : null;
    if (!button) return;

    const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(nextTheme, true);
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeToggle, { once: true });
  } else {
    initializeToggle();
  }
})();
