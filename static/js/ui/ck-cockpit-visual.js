// @ts-check
// Comportamento puramente visual do Cockpit v2 (derivado de 4-comportamento.js do pacote de design).
// Sem regras de negócio: tema, troca de tela, atalhos e busca continuam nos módulos existentes.
(function () {
  "use strict";
  var doc = document;
  var $ = function (s, r) { return (r || doc).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || doc).querySelectorAll(s)); };

  /* ---- Popovers (data-abre / data-fechar) ---- */
  var abertos = [];
  function abrirPop(id, opener) {
    var pop = doc.getElementById(id); if (!pop || !pop.hidden) return;
    fecharTodos(); pop.hidden = false;
    if (opener) opener.setAttribute("aria-expanded", "true");
    abertos.push({ pop: pop, opener: opener });
    var primeiro = pop.querySelector('[role=menuitem], button, [href], input, select, [tabindex="0"]');
    if (primeiro && pop.getAttribute("role") === "menu") primeiro.focus();
  }
  function fecharPop(pop, devolverFoco) {
    var i = abertos.findIndex(function (a) { return a.pop === pop; }); if (i < 0) return;
    var item = abertos.splice(i, 1)[0];
    item.pop.hidden = true;
    if (item.opener) { item.opener.setAttribute("aria-expanded", "false"); if (devolverFoco) item.opener.focus(); }
  }
  function fecharTodos() { abertos.slice().forEach(function (a) { fecharPop(a.pop, false); }); }

  /* ---- Diálogo (data-dialogo / .ck-veu) ---- */
  var dialogo = null;
  function abrirDialogo(id, opener) {
    var veu = doc.getElementById(id); if (!veu) return;
    fecharTodos(); veu.hidden = false; dialogo = { veu: veu, opener: opener };
    var f = veu.querySelector("[data-fechar]"); if (f) f.focus();
  }
  function fecharDialogo() { if (!dialogo) return; dialogo.veu.hidden = true; if (dialogo.opener) dialogo.opener.focus(); dialogo = null; }

  /* ---- Edição em linha (campo + Salvar na mesma linha) ---- */
  function abrirEdicao(cel, botao) {
    if (!cel) return;
    cel.classList.add("ck-dado--editando");
    $('[data-modo="ver"]', cel).hidden = true; $('[data-modo="editar"]', cel).hidden = false;
    botao.hidden = true; botao.setAttribute("aria-expanded", "true");
    var input = $("input", cel); if (input) { input.focus(); input.select(); }
  }
  function fecharEdicao(cel, focar) {
    if (!cel || !cel.classList.contains("ck-dado--editando")) return;
    cel.classList.remove("ck-dado--editando");
    $('[data-modo="ver"]', cel).hidden = false; $('[data-modo="editar"]', cel).hidden = true;
    var b = $("[data-editar]", cel); b.hidden = false; b.setAttribute("aria-expanded", "false"); if (focar) b.focus();
  }

  doc.addEventListener("click", function (e) {
    var t = e.target; if (!(t instanceof Element)) return;
    var abre = t.closest("[data-abre]");
    if (abre) { var p = doc.getElementById(abre.getAttribute("data-abre")); if (p && !p.hidden) fecharPop(p, false); else abrirPop(abre.getAttribute("data-abre"), abre); return; }
    var fechar = t.closest("[data-fechar]");
    if (fechar) { var alvo = doc.getElementById(fechar.getAttribute("data-fechar")); if (alvo && alvo.classList.contains("ck-veu")) fecharDialogo(); else if (alvo) fecharPop(alvo, true); return; }
    abertos.slice().forEach(function (a) { if (!a.pop.contains(t) && !(a.opener && a.opener.contains(t))) fecharPop(a.pop, false); });

    /* grupos de seleção única (filtros, unidades, KPIs, segmentado) */
    var op = t.closest("[data-grupo] > button, [data-grupo] > li > button");
    if (op && !op.disabled) { var g = op.closest("[data-grupo]"); $$("button[aria-pressed]", g).forEach(function (b) { b.setAttribute("aria-pressed", String(b === op)); }); }

    var ed = t.closest("[data-editar]");
    if (ed) abrirEdicao(doc.getElementById(ed.getAttribute("data-editar")), ed);
    var canc = t.closest("[data-cancelar]");
    if (canc) fecharEdicao(canc.closest(".ck-dado"), true);
    var exp = t.closest("[data-expandir]");
    if (exp) {
      var bloco = doc.getElementById(exp.getAttribute("data-expandir")); if (!bloco) return;
      var aberto = bloco.getAttribute("data-expandido") === "true";
      bloco.setAttribute("data-expandido", String(!aberto)); exp.setAttribute("aria-expanded", String(!aberto)); exp.textContent = aberto ? "Ver mais" : "Ver menos";
    }
    var dlg = t.closest("[data-dialogo]");
    if (dlg) abrirDialogo(dlg.getAttribute("data-dialogo"), dlg);
    if (t.classList.contains("ck-veu")) fecharDialogo();
  });

  /* ---- Abas por teclado (setas, Home, End) ---- */
  doc.addEventListener("keydown", function (e) {
    var aba = e.target instanceof Element ? e.target.closest("[role=tab]") : null; if (!aba) return;
    if (e.defaultPrevented || aba.closest("[role=tablist]").hasAttribute("data-on-keydown")) return;
    if (["ArrowLeft", "ArrowRight", "Home", "End"].indexOf(e.key) < 0) return;
    var lista = $$("[role=tab]", aba.closest("[role=tablist]")), i = lista.indexOf(aba);
    var n = e.key === "Home" ? 0 : e.key === "End" ? lista.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + lista.length) % lista.length;
    e.preventDefault(); lista[n].focus(); lista[n].click();
  });

  /* ---- Navegação no menu por setas ---- */
  doc.addEventListener("keydown", function (e) {
    var menu = e.target instanceof Element ? e.target.closest("[role=menu]") : null; if (!menu) return;
    var itens = $$("[role=menuitem]", menu), i = itens.indexOf(/** @type {Element} */ (e.target));
    if (e.key === "ArrowDown") { e.preventDefault(); itens[(i + 1) % itens.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); itens[(i - 1 + itens.length) % itens.length].focus(); }
    else if (e.key === "Home") { e.preventDefault(); itens[0].focus(); }
    else if (e.key === "End") { e.preventDefault(); itens[itens.length - 1].focus(); }
    else if (e.key === "Tab") fecharTodos();
  });

  /* ---- Esc: diálogo, popover, edição em linha ---- */
  doc.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (dialogo) { fecharDialogo(); return; }
    if (abertos.length) { fecharPop(abertos[abertos.length - 1].pop, true); return; }
    var ed = $(".ck-dado--editando"); if (ed) fecharEdicao(ed, true);
  });
})();
