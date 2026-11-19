// Cursor do Novo layout (canvas "Peças base"; contrato em docs/ui-motion/contrato-bento.md):
// ponto que segue o mouse, anel que vem atrás com inércia, onda de 250 ms no clique,
// anel que abraça botão, aba e link, e cor do cartão bento sob o ponteiro (--tom).
// Só com mouse ((pointer: fine) e (hover: hover)) e sem movimento reduzido; senão, cursor nativo.
// Volta ao cursor nativo em campo de texto, no Assistente, em diálogo modal e fora da janela.

const CAMPO = "input:not([type=button],[type=submit],[type=reset],[type=checkbox],[type=radio],[type=range],[type=color],[type=file],[type=image]),textarea,select,[contenteditable]:not([contenteditable=false])";
// Desabilitado e ocupado também: o cursor nativo mostra not-allowed, wait e progress.
const NATIVO = `${CAMPO},#assistente-widget,:popover-open,iframe,dialog:modal,:disabled,[aria-disabled=true],[aria-busy=true]`;
const CLICAVEL = "a[href],button,[role=button],[role=tab],[role=menuitem],[role=option],summary,label[for],input[type=checkbox],input[type=radio],input[type=button],input[type=submit]";
const CARTAO = ".ck-bento-cartao, .ck-regionais";
const ANEL = 30; // px, diâmetro livre
const ANEL_GRANDE = 48; // px, sobre clicável grande demais para abraçar
const ABRACO_MAX = { largura: 320, altura: 96 };
const FOLGA = 10; // px em volta do botão abraçado
const ATRACAO = 0.12; // quanto o anel abraçado puxa para o ponteiro
const ONDA_MS = 250;

type Caixa = { x: number; y: number; w: number; h: number; r: number };

export function createCursor(win: Window & typeof globalThis) {
  const doc = win.document;
  const midia = win.matchMedia?.("(pointer: fine) and (hover: hover)");
  const reduzido = win.matchMedia?.("(prefers-reduced-motion: reduce)");
  const contraste = win.matchMedia?.("(forced-colors: active)");
  // Alto Contraste do Windows apagaria o ponto e ignoraria o ponteiro escolhido pelo usuário.
  const permitido = (): boolean => Boolean(midia?.matches) && !reduzido?.matches && !contraste?.matches;

  let raiz: HTMLElement | null = null;
  let ponto: HTMLElement | null = null;
  let anel: HTMLElement | null = null;
  let visivel = false;
  let quadro = 0;
  let ultimo = 0;
  let px = 0;
  let py = 0;
  let alvoEl: Element | null = null;
  let abraco: Element | null = null;
  let cartao: Element | null = null;
  const atual: Caixa = { x: 0, y: 0, w: ANEL, h: ANEL, r: ANEL / 2 };
  const destino: Caixa = { ...atual };

  function montar(): void {
    if (raiz?.isConnected) return;
    raiz = doc.createElement("div");
    raiz.className = "ck-cursor";
    raiz.setAttribute("aria-hidden", "true");
    raiz.dataset.testid = "cursor";
    anel = doc.createElement("span");
    anel.className = "ck-cursor__anel";
    ponto = doc.createElement("span");
    ponto.className = "ck-cursor__ponto";
    raiz.append(anel, ponto);
    doc.body.append(raiz);
  }

  function mostrar(sim: boolean): void {
    if (visivel === sim) return;
    visivel = sim;
    raiz?.classList.toggle("ck-cursor--visivel", sim);
    // Sem o cursor próprio na tela, o nativo volta (inclusive se o script falhar antes de chegar aqui).
    doc.documentElement.classList.toggle("ck-cursor-on", sim);
  }

  // Modal aberto fica na camada de cima, acima de qualquer z-index: o cursor próprio sumiria atrás dele.
  // Com modal aberto, todo alvo é o dialog ou um filho (o ::backdrop aponta para o dialog), então closest basta.
  const nativoEm = (el: Element | null): boolean => !el || Boolean(el.closest(NATIVO));

  function medir(): void {
    const el = alvoEl;
    abraco = null;
    const clicavel = el?.closest(CLICAVEL);
    if (clicavel) {
      const r = clicavel.getBoundingClientRect();
      if (r.width <= ABRACO_MAX.largura && r.height <= ABRACO_MAX.altura) {
        abraco = clicavel;
        const raio = Number.parseFloat(win.getComputedStyle(clicavel).borderTopLeftRadius) || 0;
        const w = r.width + FOLGA;
        const h = r.height + FOLGA;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        Object.assign(destino, { x: cx + (px - cx) * ATRACAO, y: cy + (py - cy) * ATRACAO, w, h, r: Math.min(raio + FOLGA / 2, w / 2, h / 2) });
      } else Object.assign(destino, { x: px, y: py, w: ANEL_GRANDE, h: ANEL_GRANDE, r: ANEL_GRANDE / 2 });
    } else Object.assign(destino, { x: px, y: py, w: ANEL, h: ANEL, r: ANEL / 2 });
    raiz?.classList.toggle("ck-cursor--abraco", Boolean(abraco));
  }

  function pintarCor(el: Element | null): void {
    const novo = el?.closest(CARTAO) ?? null;
    if (novo === cartao || !raiz) return;
    cartao = novo;
    const cor = novo ? win.getComputedStyle(novo).getPropertyValue("--tom").trim() : "";
    if (cor) raiz.style.setProperty("--ck-cursor-cor", cor);
    else raiz.style.removeProperty("--ck-cursor-cor"); // fora de cartão: índigo do tema (ck-cursor.css)
  }

  function desenhar(): void {
    if (!ponto || !anel) return;
    ponto.style.setProperty("transform", `translate3d(${px}px, ${py}px, 0)${abraco ? " scale(.75)" : ""}`);
    anel.style.setProperty("transform", `translate3d(${atual.x - atual.w / 2}px, ${atual.y - atual.h / 2}px, 0)`);
    anel.style.setProperty("width", `${atual.w}px`);
    anel.style.setProperty("height", `${atual.h}px`);
    anel.style.setProperty("border-radius", `${atual.r}px`);
  }

  // Inércia independente da taxa de quadros; o laço para quando o anel assenta (relógio falso do Playwright não trava).
  function passo(instante: number): void {
    const dt = ultimo ? Math.min(64, Math.max(0, instante - ultimo)) : 16.7;
    ultimo = instante;
    const k = 1 - Math.pow(0.78, dt / 16.7);
    let resta = 0;
    for (const chave of ["x", "y", "w", "h", "r"] as const) {
      atual[chave] += (destino[chave] - atual[chave]) * k;
      resta = Math.max(resta, Math.abs(destino[chave] - atual[chave]));
    }
    if (resta < 0.1) Object.assign(atual, destino);
    desenhar();
    quadro = resta < 0.1 ? 0 : win.requestAnimationFrame(passo);
  }

  function animar(): void {
    if (quadro) return;
    ultimo = 0;
    quadro = win.requestAnimationFrame(passo);
  }

  function mover(evento: PointerEvent): void {
    if (evento.pointerType !== "mouse" || !permitido()) {
      mostrar(false);
      return;
    }
    px = evento.clientX;
    py = evento.clientY;
    alvoEl = evento.target instanceof Element ? evento.target : null;
    if (nativoEm(alvoEl)) {
      mostrar(false);
      return;
    }
    montar();
    pintarCor(alvoEl);
    medir();
    if (!visivel) {
      // Reaparece já no lugar e no tamanho certos, sem atravessar a tela vindo da última posição.
      Object.assign(atual, destino);
      mostrar(true);
    }
    desenhar();
    animar();
  }

  function clicar(evento: PointerEvent): void {
    mover(evento);
    if (!visivel || evento.button !== 0 || !raiz) return;
    const onda = doc.createElement("span");
    onda.className = "ck-cursor__onda";
    onda.style.setProperty("left", `${px}px`);
    onda.style.setProperty("top", `${py}px`);
    raiz.append(onda);
    const animacao = onda.animate?.([
      { opacity: 0.55, transform: "scale(.3)" },
      { opacity: 0, transform: "scale(1)" },
    ], { duration: ONDA_MS, easing: "cubic-bezier(.2,.7,.2,1)" });
    if (animacao) animacao.onfinish = () => onda.remove();
    else onda.remove();
  }

  function rolar(): void {
    if (!visivel) return;
    alvoEl = doc.elementFromPoint(px, py);
    if (nativoEm(alvoEl)) return mostrar(false);
    pintarCor(alvoEl);
    medir();
    animar();
  }

  function sair(evento: MouseEvent): void {
    if (!evento.relatedTarget) mostrar(false);
  }

  let ligado = false;
  function iniciar(): void {
    if (ligado || !doc?.addEventListener) return;
    ligado = true;
    doc.addEventListener("pointermove", mover, { passive: true });
    doc.addEventListener("pointerdown", clicar, { passive: true });
    doc.addEventListener("mouseout", sair, { passive: true });
    doc.addEventListener("scroll", rolar, { passive: true, capture: true });
    // showModal e o Assistente (F9) mudam o foco com o mouse parado: reavalia o que está sob o ponteiro.
    doc.addEventListener("focusin", rolar);
    win.addEventListener("blur", () => mostrar(false));
    // Trocar a preferência (movimento reduzido, mouse ou toque) desliga na hora, sem recarregar.
    const revisar = (): void => { if (!permitido()) mostrar(false); };
    midia?.addEventListener?.("change", revisar);
    reduzido?.addEventListener?.("change", revisar);
    contraste?.addEventListener?.("change", revisar);
  }

  return Object.freeze({ iniciar });
}

if (typeof window !== "undefined") createCursor(window).iniciar();
