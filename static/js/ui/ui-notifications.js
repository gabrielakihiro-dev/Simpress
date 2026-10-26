(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else root.SimpressNotifications = factory;
})(typeof window !== "undefined" ? window : globalThis, function createNotifications(options) {
  "use strict";

  const { document, window, lucide, motion, createIcon } = options;

  const statuses = Object.freeze({ success: "ok", error: "erro", warning: "alerta", info: "info" });
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
    toast.className = "ck-toast";
    toast.dataset.status = statuses[type] || statuses.info;

    const icon = createIcon(icons[type] || icons.info, "ck-ico");
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
