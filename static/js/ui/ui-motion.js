(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else root.SimpressMotion = factory(root);
})(typeof window !== "undefined" ? window : globalThis, function createMotion(env) {
  "use strict";

  const duration = Object.freeze({ fast: 160, normal: 220, exit: 180 });
  const easing = "cubic-bezier(0.22, 1, 0.36, 1)";
  const preference = env.matchMedia?.("(prefers-reduced-motion: reduce)");
  const running = new Map();
  const loaders = new WeakMap();
  const frames = {
    content: [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "translateY(0)" }],
    page: [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "translateY(0)" }],
    modal: [{ transform: "translateY(10px) scale(0.985)" }, { transform: "translateY(0) scale(1)" }],
    drawer: [{ transform: "translateX(24px)" }, { transform: "translateX(0)" }],
    fade: [{ opacity: 0 }, { opacity: 1 }],
  };

  function cancel(element) {
    const entry = running.get(element);
    if (!entry) return;
    running.delete(element);
    entry.animation.cancel();
  }

  // No geometry reads, forced reflow, per-frame JS, or permanent compositor hints.
  function animate(element, keyframes, time = duration.normal, complete = () => {}) {
    if (!element) { complete(); return; }
    cancel(element);
    if (preference?.matches || typeof element.animate !== "function") { complete(); return; }
    const animation = element.animate(keyframes, { duration: time, easing, fill: "both" });
    const entry = { animation, finish };
    running.set(element, entry);
    function finish() {
      if (running.get(element) !== entry) return;
      running.delete(element);
      animation.cancel();
      complete();
    }
    animation.finished.then(finish, () => {
      if (running.get(element) === entry) {
        running.delete(element);
        complete();
      }
    });
  }

  // A changed OS preference also finishes pending closes and releases their DOM.
  preference?.addEventListener?.("change", () => {
    if (preference.matches) [...running.values()].forEach(entry => entry.finish());
  });

  function reveal(element, preset = "content") {
    animate(element, frames[preset] || frames.content);
  }

  function openOverlay(overlay) {
    cancel(overlay);
    cancel(overlay.firstElementChild);
    delete overlay.dataset.motionClosing;
    overlay.inert = false;
    overlay.removeAttribute("aria-hidden");
    overlay.classList.remove("hidden");
    reveal(overlay, "fade");
    reveal(overlay.firstElementChild, overlay.dataset.motion === "drawer" ? "drawer" : "modal");
  }

  function closeOverlay(overlay, complete) {
    if (overlay.dataset.motionClosing === "true") return;
    overlay.dataset.motionClosing = "true";
    overlay.inert = true;
    overlay.setAttribute("aria-hidden", "true");
    const preset = overlay.dataset.motion === "drawer" ? "drawer" : "modal";
    animate(overlay.firstElementChild, [...frames[preset]].reverse(), duration.exit);
    animate(overlay, [...frames.fade].reverse(), duration.exit, () => {
      complete();
      delete overlay.dataset.motionClosing;
      overlay.inert = false;
      overlay.removeAttribute("aria-hidden");
    });
  }

  function dismiss(element, complete) {
    animate(element, [...frames.content].reverse(), duration.exit, complete);
  }

  // One cancellable loader per container. Fast responses never flash a skeleton.
  // Removing only our own node preserves results and appended pagination rows.
  function startLoading(container, label = "Carregando dados…", { rows = 3, delay = 150 } = {}) {
    if (!container) return () => {};
    loaders.get(container)?.();
    const previousBusy = container.getAttribute("aria-busy");
    container.setAttribute("aria-busy", "true");
    let skeleton;
    const timer = env.setTimeout(() => {
      skeleton = env.document.createElement("div");
      skeleton.className = "ui-skeleton-list";
      const status = env.document.createElement("span");
      status.className = "ui-sr-only";
      status.setAttribute("role", "status");
      status.textContent = label;
      skeleton.appendChild(status);
      for (let index = 0; index < Math.min(5, Math.max(1, rows)); index += 1) {
        const row = env.document.createElement("div");
        row.className = "ui-skeleton-row";
        row.setAttribute("aria-hidden", "true");
        for (const size of ["title", "text", "short"]) {
          const bar = env.document.createElement("span");
          bar.className = `ui-skeleton ui-skeleton--${size}`;
          row.appendChild(bar);
        }
        skeleton.appendChild(row);
      }
      container.appendChild(skeleton);
    }, delay);
    function stop() {
      env.clearTimeout(timer);
      skeleton?.remove();
      if (loaders.get(container) !== stop) return;
      loaders.delete(container);
      if (previousBusy === null) container.removeAttribute("aria-busy");
      else container.setAttribute("aria-busy", previousBusy);
    }
    loaders.set(container, stop);
    return stop;
  }

  // Delegation covers dynamically created fields without observers or per-field handlers.
  function installFeedback(document = env.document) {
    document.addEventListener("invalid", event => {
      const field = event.target;
      if (!field.matches?.("input, select, textarea")) return;
      field.setAttribute("aria-invalid", "true");
      animate(field, [{ opacity: 0.65 }, { opacity: 1 }], duration.fast);
    }, true);
    document.addEventListener("input", event => {
      const field = event.target;
      if (field.getAttribute?.("aria-invalid") === "true" && field.validity?.valid) {
        field.removeAttribute("aria-invalid");
      }
    });
  }

  return Object.freeze({ duration, reveal, openOverlay, closeOverlay, dismiss, startLoading, installFeedback });
});
