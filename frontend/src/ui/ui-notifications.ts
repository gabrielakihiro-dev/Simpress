/* eslint-disable @typescript-eslint/no-explicit-any */
type Qualquer = any;

export function createNotifications(options: Qualquer) {
  const { document, window, lucide, motion, createIcon } = options;

  const statuses: Readonly<Record<string, string>> = Object.freeze({ success: "ok", error: "erro", warning: "alerta", info: "info" });
  const icons: Readonly<Record<string, string>> = Object.freeze({ success: "check-circle", error: "alert-circle", warning: "alert-triangle", info: "info" });

  // Lets progressive enhancements (e.g. "Copiado!" on the clicked button) react to the outcome.
  function announce(message: unknown, type: string): void {
    try {
      if (typeof document.dispatchEvent !== "function" || typeof window.CustomEvent !== "function") return;
      document.dispatchEvent(new window.CustomEvent("simpress:notify", {
        detail: { message: String(message ?? ""), type },
      }));
    } catch (error) {
      // Feedback hooks are optional; the toast itself was already shown.
    }
  }

  function show(message: unknown, type: string = "success"): void {
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

    // Pausa com o mouse em cima ou o foco dentro; ao sair, conta de novo os 4 s (17-termos.md conta com os 4 s).
    let sumindo = false;
    const sumir = () => {
      sumindo = true;
      if (motion) motion.dismiss(toast, () => toast.remove());
      else toast.remove();
    };
    let timer = window.setTimeout(sumir, 4000);
    let mouse = false;
    let foco = false;
    const pausar = () => window.clearTimeout(timer);
    const retomar = () => { if (!sumindo && !mouse && !foco) { pausar(); timer = window.setTimeout(sumir, 4000); } };
    // Só com mouse de verdade: no toque, o toque deixa um "mouse em cima" que nunca sai e o toast ficaria preso sobre os botões.
    if (window.matchMedia?.("(hover: hover)").matches) {
      toast.addEventListener("mouseenter", () => { mouse = true; pausar(); });
      toast.addEventListener("mouseleave", () => { mouse = false; retomar(); });
    }
    toast.addEventListener("focusin", () => { foco = true; pausar(); });
    toast.addEventListener("focusout", (evento: Qualquer) => { if (toast.contains(evento.relatedTarget)) return; foco = false; retomar(); });
  }

  return Object.freeze({ show });
}

// Publicação em window, lida por frontend/src/aplicacao/app-shell.ts.
if (typeof window !== "undefined") window.SimpressNotifications = createNotifications;
