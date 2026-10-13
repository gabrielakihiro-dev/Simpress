(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else root.SimpressNotifications = factory;
})(typeof window !== "undefined" ? window : globalThis, function createNotifications(options) {
  "use strict";

  const { document, window, lucide, motion, createIcon } = options;

  const backgrounds = Object.freeze({
    success: "bg-emerald-950/90 border-emerald-500/50 text-emerald-200",
    error: "bg-rose-950/90 border-rose-500/50 text-rose-200",
    warning: "bg-amber-950/90 border-amber-500/50 text-amber-200",
    info: "bg-brand-950/90 border-brand-500/50 text-brand-200",
  });
  const icons = Object.freeze({ success: "check-circle", error: "alert-circle", warning: "alert-triangle", info: "info" });

  // Lets progressive enhancements (e.g. "Copiado!" on the clicked button) react to the outcome.
  function announce(message, type) {
    try {
      if (typeof document.dispatchEvent !== "function" || typeof window.CustomEvent !== "function") return;
      document.dispatchEvent(new window.CustomEvent("simpress:notify", {
        detail: { message: String(message ?? ""), type },
      }));
    } catch (error) {
      // Feedback hooks are optional; the toast itself was already shown.
    }
  }

  function show(message, type = "success") {
    const container = document.getElementById("toast-container");
    const toast = document.createElement("div");
    toast.setAttribute("role", type === "error" ? "alert" : "status");
    toast.setAttribute("aria-live", type === "error" ? "assertive" : "polite");
    toast.setAttribute("aria-atomic", "true");
    toast.className = `ui-toast flex items-center space-x-3 px-4 py-3 rounded-xl border shadow-xl backdrop-blur-md text-xs font-medium pointer-events-auto ${backgrounds[type] || backgrounds.info}`;

    const icon = createIcon(icons[type] || icons.info, "w-4 h-4 shrink-0");
    const text = document.createElement("span");
    text.textContent = String(message ?? "");
    toast.replaceChildren(icon, text);
    container.appendChild(toast);
    lucide.createIcons({ root: toast });
    motion?.reveal(toast);
    announce(message, type);

    window.setTimeout(() => {
      if (motion) motion.dismiss(toast, () => toast.remove());
      else toast.remove();
    }, 4000);
  }

  return Object.freeze({ show });
});
