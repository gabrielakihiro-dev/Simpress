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

  function updateToggle(theme) {
    const button = document.getElementById("theme-toggle");
    if (!button) return;

    const targetTheme = theme === "dark" ? "light" : "dark";
    const label = targetTheme === "light" ? "Ativar modo claro" : "Ativar modo escuro";
    const iconName = targetTheme === "light" ? "sun" : "moon";
    const sunIcon = '<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="m4.93 4.93 1.42 1.42"></path><path d="m17.65 17.65 1.42 1.42"></path><path d="M2 12h2"></path><path d="M20 12h2"></path><path d="m6.34 17.66-1.42 1.42"></path><path d="m19.07 4.93-1.42 1.42"></path>';
    const moonIcon = '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.003.803.401z"></path>';
    const iconPaths = iconName === "sun" ? sunIcon : moonIcon;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-${iconName}" aria-hidden="true" focusable="false">${iconPaths}</svg>`;
  }

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
    const button = document.getElementById("theme-toggle");
    updateToggle(document.documentElement.dataset.theme);
    if (!button) return;

    button.addEventListener("click", function () {
      const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      applyTheme(nextTheme, true);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeToggle, { once: true });
  } else {
    initializeToggle();
  }
})();
