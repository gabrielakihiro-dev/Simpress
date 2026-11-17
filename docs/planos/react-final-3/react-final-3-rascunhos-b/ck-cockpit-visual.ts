/* eslint-disable @typescript-eslint/no-explicit-any */
// Comportamento puramente visual do Cockpit v2 (derivado de 4-comportamento.js do pacote de design).
// Sem regras de negócio: tema, troca de tela, atalhos e busca continuam nos módulos existentes.
// Módulo de efeito: ao ser importado (frontend/src/arranque/entrada.ts, depois do app) liga os ouvintes no document.
type Qualquer = any;

const doc: Qualquer = document;
const $ = (s: string, r?: Qualquer): Qualquer => (r || doc).querySelector(s);
const $$ = (s: string, r?: Qualquer): Qualquer[] => Array.prototype.slice.call((r || doc).querySelectorAll(s));

/* ---- Popovers (data-abre / data-fechar) ---- */
const abertos: { pop: Qualquer, opener: Qualquer }[] = [];
function abrirPop(id: string, opener: Qualquer): void {
  const pop = doc.getElementById(id); if (!pop || !pop.hidden) return;
  fecharTodos(); pop.hidden = false;
  if (opener) opener.setAttribute("aria-expanded", "true");
  abertos.push({ pop: pop, opener: opener });
  const primeiro = pop.querySelector('[role=menuitem], button, [href], input, select, [tabindex="0"]');
  if (primeiro && pop.getAttribute("role") === "menu") primeiro.focus();
}
function fecharPop(pop: Qualquer, devolverFoco: boolean): void {
  const i = abertos.findIndex(function (a) { return a.pop === pop; }); if (i < 0) return;
  const item = abertos.splice(i, 1)[0];
  item.pop.hidden = true;
  if (item.opener) { item.opener.setAttribute("aria-expanded", "false"); if (devolverFoco) item.opener.focus(); }
}
function fecharTodos(): void { abertos.slice().forEach(function (a) { fecharPop(a.pop, false); }); }

/* ---- Diálogo (data-dialogo / .ck-veu) ---- */
let dialogo: { veu: Qualquer, opener: Qualquer } | null = null;
function abrirDialogo(id: string, opener: Qualquer): void {
  const veu = doc.getElementById(id); if (!veu) return;
  fecharTodos(); veu.hidden = false; dialogo = { veu: veu, opener: opener };
  const f = veu.querySelector("[data-fechar]"); if (f) f.focus();
}
function fecharDialogo(): void { if (!dialogo) return; dialogo.veu.hidden = true; if (dialogo.opener) dialogo.opener.focus(); dialogo = null; }

/* ---- Edição em linha (campo + Salvar na mesma linha) ---- */
function abrirEdicao(cel: Qualquer, botao: Qualquer): void {
  if (!cel) return;
  cel.classList.add("ck-dado--editando");
  $('[data-modo="ver"]', cel).hidden = true; $('[data-modo="editar"]', cel).hidden = false;
  botao.hidden = true; botao.setAttribute("aria-expanded", "true");
  const input = $("input", cel); if (input) { input.focus(); input.select(); }
}
function fecharEdicao(cel: Qualquer, focar: boolean): void {
  if (!cel || !cel.classList.contains("ck-dado--editando")) return;
  cel.classList.remove("ck-dado--editando");
  $('[data-modo="ver"]', cel).hidden = false; $('[data-modo="editar"]', cel).hidden = true;
  const b = $("[data-editar]", cel); b.hidden = false; b.setAttribute("aria-expanded", "false"); if (focar) b.focus();
}

// Edição cadastral do Home: a lógica fica em frontend/src/paineis/cartao-equipamento/estado.ts.
function cancelarDados(): void { if (typeof window.cancelarDadosCadastrais === "function") window.cancelarDadosCadastrais(); }

doc.addEventListener("click", function (e: Qualquer) {
  const t: Qualquer = e.target; if (!(e.target instanceof Element)) return;
  const abre = t.closest("[data-abre]");
  if (abre) { const p = doc.getElementById(abre.getAttribute("data-abre")); if (p && !p.hidden) fecharPop(p, false); else abrirPop(abre.getAttribute("data-abre"), abre); return; }
  const fechar = t.closest("[data-fechar]");
  if (fechar) { const alvo = doc.getElementById(fechar.getAttribute("data-fechar")); if (alvo && alvo.classList.contains("ck-veu")) fecharDialogo(); else if (alvo) fecharPop(alvo, true); return; }
  abertos.slice().forEach(function (a) { if (!a.pop.contains(t) && !(a.opener && a.opener.contains(t))) fecharPop(a.pop, false); });

  /* grupos de seleção única (filtros, unidades, KPIs, segmentado) */
  const op = t.closest("[data-grupo] > button, [data-grupo] > li > button");
  if (op && !op.disabled) { const g = op.closest("[data-grupo]"); $$("button[aria-pressed]", g).forEach(function (b) { b.setAttribute("aria-pressed", String(b === op)); }); }

  const ed = t.closest("[data-editar]");
  if (ed) abrirEdicao(doc.getElementById(ed.getAttribute("data-editar")), ed);
  if (t.closest("[data-cancelar-dados]")) cancelarDados();
  const canc = t.closest("[data-cancelar]");
  if (canc) fecharEdicao(canc.closest(".ck-dado"), true);
  const exp = t.closest("[data-expandir]");
  if (exp) {
    const bloco = doc.getElementById(exp.getAttribute("data-expandir")); if (!bloco) return;
    const aberto = bloco.getAttribute("data-expandido") === "true";
    bloco.setAttribute("data-expandido", String(!aberto)); exp.setAttribute("aria-expanded", String(!aberto)); exp.textContent = aberto ? "Ver mais" : "Ver menos";
  }
  const dlg = t.closest("[data-dialogo]");
  if (dlg) abrirDialogo(dlg.getAttribute("data-dialogo"), dlg);
  if (t.classList.contains("ck-veu")) fecharDialogo();
});

/* ---- Abas por teclado (setas, Home, End) ---- */
doc.addEventListener("keydown", function (e: Qualquer) {
  const aba = e.target instanceof Element ? e.target.closest("[role=tab]") : null; if (!aba) return;
  if (e.defaultPrevented || aba.closest("[role=tablist]")!.hasAttribute("data-on-keydown")) return;
  if (["ArrowLeft", "ArrowRight", "Home", "End"].indexOf(e.key) < 0) return;
  const lista = $$("[role=tab]", aba.closest("[role=tablist]")), i = lista.indexOf(aba);
  const n = e.key === "Home" ? 0 : e.key === "End" ? lista.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + lista.length) % lista.length;
  e.preventDefault(); lista[n].focus(); lista[n].click();
});

/* ---- Navegação no menu por setas ---- */
doc.addEventListener("keydown", function (e: Qualquer) {
  const menu = e.target instanceof Element ? e.target.closest("[role=menu]") : null; if (!menu) return;
  const itens = $$("[role=menuitem]", menu), i = itens.indexOf(e.target);
  if (e.key === "ArrowDown") { e.preventDefault(); itens[(i + 1) % itens.length].focus(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); itens[(i - 1 + itens.length) % itens.length].focus(); }
  else if (e.key === "Home") { e.preventDefault(); itens[0].focus(); }
  else if (e.key === "End") { e.preventDefault(); itens[itens.length - 1].focus(); }
  else if (e.key === "Tab") fecharTodos();
});

/* ---- Esc: diálogo, popover, edição em linha ---- */
doc.addEventListener("keydown", function (e: Qualquer) {
  if (e.key !== "Escape") return;
  if (dialogo) { fecharDialogo(); return; }
  if (abertos.length) { fecharPop(abertos[abertos.length - 1].pop, true); return; }
  if ($(".ck-dados--editando")) { cancelarDados(); return; }
  const ed = $(".ck-dado--editando"); if (ed) fecharEdicao(ed, true);
});
// A barra compacta quebra em linhas; os paineis legados descontam a altura real dela.
const barra = $("#ck-topbar");
if (barra && window.ResizeObserver) {
  new ResizeObserver(function () { doc.documentElement.style.setProperty("--ck-topbar-h", barra.offsetHeight + "px"); }).observe(barra);
}

export {};
