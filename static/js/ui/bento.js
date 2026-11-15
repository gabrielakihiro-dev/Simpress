(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else {
    root.SimpressBento = factory(root);
    root.SimpressBento.iniciarBrilho();
  }
})(typeof window !== "undefined" ? window : globalThis, function createBento(env) {
  "use strict";

  // Valores do contrato bento (docs/ui-motion/contrato-bento.md): contagem 900 ms, anel 1200 ms, curva 1-(1-t)^3.
  const duracao = Object.freeze({ contagem: 900, anel: 1200 });
  const ARCO = 326.73; // 2πr do anel (r = 52)
  const CARTOES = ".ck-cartao, .ck-kpi, .ck-bento-cartao";
  const emAndamento = new Map();
  const contando = new Map(); // região viva -> contadores ainda contando; aria-busy sai só quando todos terminam
  const curva = t => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
  const formatoPadrao = valor => Math.round(valor).toLocaleString("pt-BR");
  const movimentoReduzido = () => Boolean(env.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  const agora = () => (env.performance?.now ? env.performance.now() : Date.now());

  function cancelar(el) {
    const id = emAndamento.get(el);
    if (id !== undefined) env.cancelAnimationFrame?.(id);
    emAndamento.delete(el);
  }

  // Anima de 0 até `alvo` chamando `pintar(k)` com k de 0 a 1; termina sempre em k = 1.
  function animar(el, ms, pintar) {
    cancelar(el);
    if (movimentoReduzido() || typeof env.requestAnimationFrame !== "function") {
      pintar(1);
      return;
    }
    let inicio = agora();
    const passo = instante => {
      // Carimbo do quadro abaixo do início (relógio trocou de base, ex.: page.clock do Playwright): conta a partir daqui, senão o laço nunca termina.
      if (instante < inicio) inicio = instante;
      const k = curva((instante - inicio) / ms);
      pintar(k);
      if (k < 1) emAndamento.set(el, env.requestAnimationFrame(passo));
      else emAndamento.delete(el);
    };
    pintar(0);
    emAndamento.set(el, env.requestAnimationFrame(passo));
  }

  // Termina com el.textContent === formatar(alvo). Região viva fica aria-busy durante a contagem.
  function contarAte(el, alvo, formatar = formatoPadrao, ms = duracao.contagem) {
    if (!el) return;
    const total = Number(alvo) || 0;
    const viva = el.closest?.("[role=status], [aria-live]");
    if (viva) {
      viva.setAttribute("aria-busy", "true");
      if (!contando.has(viva)) contando.set(viva, new Set());
      contando.get(viva).add(el);
    }
    animar(el, ms, k => {
      el.textContent = formatar(k >= 1 ? total : total * k);
      if (k < 1 || !viva) return;
      const pendentes = contando.get(viva);
      pendentes?.delete(el);
      if (!pendentes?.size) {
        contando.delete(viva);
        viva.removeAttribute("aria-busy");
      }
    });
  }

  function animarAnel(circulo, fracao, ms = duracao.anel) {
    if (!circulo) return;
    const f = Math.min(1, Math.max(0, Number(fracao) || 0));
    animar(circulo, ms, k => circulo.style.setProperty("stroke-dashoffset", (ARCO * (1 - f * k)).toFixed(2)));
  }

  // Larguras vêm de data-bento-largura (CSP: nada de style= no HTML); números e anéis partem do zero.
  function animarDentro(raiz) {
    if (!raiz?.querySelectorAll) return;
    raiz.querySelectorAll("[data-bento-largura]").forEach(el => {
      el.style.setProperty("width", `${el.dataset.bentoLargura}%`);
      // Barras: 700 ms, 200 ms depois, só transform; repetem a cada chamada (clique de sub-aba).
      if (!movimentoReduzido()) el.animate?.([{ transform: "scaleX(0)" }, { transform: "none" }], { duration: 700, delay: 200, easing: "cubic-bezier(.33, 1, .68, 1)", fill: "backwards" });
    });
    raiz.querySelectorAll("[data-bento-contar]").forEach(el => {
      const sufixo = el.dataset.bentoSufixo || "";
      contarAte(el, Number(el.dataset.bentoContar), v => `${formatoPadrao(v)}${sufixo}`,
        sufixo ? duracao.anel : duracao.contagem);
    });
    raiz.querySelectorAll("[data-bento-anel]").forEach(el => animarAnel(el, Number(el.dataset.bentoAnel)));
  }

  // Um ouvinte delegado: --mx/--my só no cartão sob o ponteiro, uma vez por quadro. O Assistente fica fora.
  let ligado = false;
  function iniciarBrilho() {
    const doc = env.document;
    if (ligado || !doc?.addEventListener) return;
    ligado = true;
    let pendente = null;
    let quadro = 0;
    const aplicar = () => {
      quadro = 0;
      const { alvo, x, y } = pendente;
      const r = alvo.getBoundingClientRect();
      alvo.style.setProperty("--mx", `${x - r.left}px`);
      alvo.style.setProperty("--my", `${y - r.top}px`);
    };
    const mover = evento => {
      const alvo = evento.target?.closest?.(CARTOES);
      if (!alvo || alvo.closest("#assistente-widget") || alvo.closest("tr")) return;
      pendente = { alvo, x: evento.clientX, y: evento.clientY };
      if (!quadro) quadro = env.requestAnimationFrame ? env.requestAnimationFrame(aplicar) : (aplicar(), 0);
    };
    doc.addEventListener("pointermove", mover, { passive: true });
    doc.addEventListener("pointerdown", mover, { passive: true });
  }

  return Object.freeze({ duracao, curva, contarAte, animarAnel, animarDentro, iniciarBrilho, cancelar });
});
