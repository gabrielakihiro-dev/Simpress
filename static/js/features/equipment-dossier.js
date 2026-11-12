/** Home "Dossiê do equipamento": read-only dialog with the OS and tickets of the selected series (GET /api/equipamento/{série}/dossie). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).equipmentDossier = factory;
})(typeof window !== "undefined" ? window : globalThis, function createEquipmentDossier(context) {
  "use strict";
  const { app, appState } = context;
  const MODAL = "modal-dossie-equipamento";
  const VAZIO = "—";
  // Approved texts (docs/cockpit-prompts/03-home-split-view.md, "Dossiê do equipamento").
  const TEXTO = {
    carregando: "Carregando dossiê…",
    erro: "Não foi possível carregar o dossiê. Tente de novo.",
    importacoes: "Importações disponíveis: ",
    semMudancas: "Sem mudanças registradas.",
    verOs: "Ver OS",
  };
  // Fallback only: the server sends these same texts in `os.mensagem`.
  const MENSAGEM_ESTADO = {
    sem_base: "Sem base importada",
    sem_registros: "Sem registros para esta série",
    indisponivel: "Fonte indisponível",
  };
  const FONTES = { simpress: "Simpress", oracle: "Oracle" };
  const COLUNAS = ["OS", "Fonte", "Status", "Fila", "Dias aberta", "UTIC"];

  const byId = id => document.getElementById(id);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const texto = valor => String(valor ?? "").trim();
  const ouVazio = valor => texto(valor) || VAZIO;
  const formatarData = valor => (context.historyFormat?.formatarHorarioHistorico
    ? context.historyFormat.formatarHorarioHistorico(valor) : texto(valor));
  // Same format as the OS tab timeline (cockpit-tool-panels.js, timelineValue): lists join with ", ", empty is "(vazio)".
  const valorMudanca = valor => (Array.isArray(valor) ? valor.filter(Boolean).join(", ") : String(valor ?? "")) || "(vazio)";

  let aberto = false;
  let geracao = 0; // bumps on every open, close and series change: late answers from an older session are dropped
  let controle = null; // AbortController of the request in flight
  let serieAberta = "";
  let revisaoAberta = 0;

  // ---------------------------------------------------------------- rendering (textContent only)

  function mostrarStatus(mensagem) {
    const alvo = byId("dossie-status");
    alvo.textContent = mensagem;
    alvo.hidden = !mensagem;
  }

  function limparCorpo() {
    byId("dossie-os").hidden = true;
    for (const id of ["dossie-os-mensagem", "dossie-os-importacoes", "dossie-os-observada"]) {
      const alvo = byId(id);
      alvo.textContent = "";
      alvo.hidden = true;
    }
    byId("dossie-os-ordens").hidden = true;
    byId("dossie-os-linhas").replaceChildren();
    byId("dossie-historico").hidden = true;
    byId("dossie-historico-lista").replaceChildren();
  }

  function celula(rotulo, ...filhos) {
    const td = el("td");
    td.dataset.label = rotulo;
    td.append(...filhos);
    return td;
  }

  function linhaDaOrdem(ordem) {
    // The OS tab finds the row by the series as the import wrote it, which can differ from the registry one.
    const serie = texto(ordem.serie) || serieAberta;
    const numero = texto(ordem.os);
    const utic = ordem.utic && texto(ordem.utic.chamado)
      ? [el("span", "", texto(ordem.utic.chamado)), document.createTextNode(" "), el("span", "ck-tag ck-tag--neutra", texto(ordem.utic.origem))]
      : [document.createTextNode(VAZIO)];
    const botao = el("button", "ck-btn ck-btn--secundario ck-btn--sm", TEXTO.verOs);
    botao.type = "button";
    botao.setAttribute("aria-label", `${TEXTO.verOs} ${numero}`);
    botao.addEventListener("click", () => {
      fecharDossieEquipamento();
      void app.abrirChamadoDaOs?.([], serie, numero);
    });
    const dias = Number.isInteger(ordem.dias_aberta) ? String(ordem.dias_aberta) : VAZIO;
    const acao = celula("", botao);
    acao.className = "ck-td--sem-rotulo";
    const linha = el("tr");
    linha.append(
      celula(COLUNAS[0], document.createTextNode(ouVazio(numero))),
      celula(COLUNAS[1], document.createTextNode(FONTES[ordem.fonte] || ouVazio(ordem.fonte))),
      celula(COLUNAS[2], document.createTextNode(ouVazio(ordem.status))),
      celula(COLUNAS[3], document.createTextNode(ouVazio(ordem.fila))),
      celula(COLUNAS[4], document.createTextNode(dias)),
      celula(COLUNAS[5], ...utic),
      acao,
    );
    return linha;
  }

  function itemDoEvento(evento) {
    const item = el("li", "dossie-equip__evento");
    const cabeca = el("p", "dossie-equip__evento-cab");
    const hora = el("time", "", formatarData(evento.atualizado_em));
    if (texto(evento.atualizado_em)) hora.dateTime = texto(evento.atualizado_em);
    cabeca.append(hora, document.createTextNode(" · "), el("strong", "", ouVazio(evento.tipo)));
    item.append(cabeca);
    const mudancas = Array.isArray(evento.mudancas) ? evento.mudancas : [];
    if (mudancas.length) {
      const lista = el("ul", "dossie-equip__mudancas");
      for (const mudanca of mudancas) {
        lista.append(el("li", "", `${texto(mudanca.campo) || "Campo"}: ${valorMudanca(mudanca.anterior)} → ${valorMudanca(mudanca.atual)}`));
      }
      item.append(lista);
    }
    return item;
  }

  function mostrarTexto(id, valor) {
    const alvo = byId(id);
    alvo.textContent = valor;
    alvo.hidden = !valor;
  }

  function renderizar(dados) {
    const os = dados?.os;
    if (!os || typeof os !== "object") throw new Error(TEXTO.erro);
    if (texto(dados.serie)) byId("dossie-serie").textContent = texto(dados.serie);
    if (texto(dados.modelo)) byId("dossie-modelo").textContent = texto(dados.modelo);
    mostrarStatus("");
    limparCorpo();
    byId("dossie-os").hidden = false;
    if (os.estado !== "ok") {
      mostrarTexto("dossie-os-mensagem", texto(os.mensagem) || MENSAGEM_ESTADO[os.estado] || TEXTO.erro);
      return;
    }
    mostrarTexto("dossie-os-importacoes", `${TEXTO.importacoes}${Number(os.total_importacoes) || 0}`);
    if (texto(os.ultima_vez_observada_em)) {
      mostrarTexto("dossie-os-observada", `Última vez observada em ${formatarData(os.ultima_vez_observada_em)}.`);
    }
    const ordens = Array.isArray(os.ordens) ? os.ordens : [];
    byId("dossie-os-linhas").replaceChildren(...ordens.map(linhaDaOrdem));
    byId("dossie-os-ordens").hidden = !ordens.length;
    const historico = os.historico && typeof os.historico === "object" ? os.historico : {};
    const eventos = Array.isArray(historico.eventos) ? historico.eventos : [];
    byId("dossie-historico-titulo").textContent = texto(historico.titulo);
    byId("dossie-historico-lista").replaceChildren(...eventos.map(itemDoEvento));
    byId("dossie-historico-vazio").hidden = eventos.length > 0;
    byId("dossie-historico").hidden = false;
  }

  // ---------------------------------------------------------------- actions

  // Called by definirEquipamentoAtual: enables the button and drops the dialog when the series changes under it.
  function atualizarDossieEquipamento(equipamento) {
    const serie = texto(equipamento?.serial);
    const botao = byId("btn-ver-dossie");
    if (botao) botao.disabled = !serie;
    if (!aberto) return;
    if (serie === serieAberta) revisaoAberta = appState.equipamentoSelectionRevision; // same series re-applied
    else fecharDossieEquipamento();
  }

  async function abrirDossieEquipamento() {
    const equipamento = appState.currentEquipamento;
    const serie = texto(equipamento?.serial);
    if (!serie || aberto) return;
    aberto = true;
    const minha = ++geracao;
    serieAberta = serie;
    revisaoAberta = appState.equipamentoSelectionRevision;
    controle?.abort();
    const meu = controle = new AbortController();
    byId("dossie-serie").textContent = serie;
    byId("dossie-modelo").textContent = texto(equipamento.modelo);
    limparCorpo();
    mostrarStatus(TEXTO.carregando);
    app.abrirModalAcessivel(MODAL, "#dossie-fechar", "fecharDossieEquipamento");
    // Same series and same selection revision as when the dialog opened.
    const vigente = () => aberto && geracao === minha
      && texto(appState.currentEquipamento?.serial) === serie && appState.equipamentoSelectionRevision === revisaoAberta;
    // True when the answer (or the error) is no longer for this screen; a selection that moved without notice also closes the dialog.
    const obsoleta = () => {
      if (vigente()) return false;
      if (aberto && geracao === minha) fecharDossieEquipamento();
      return true;
    };
    try {
      const dados = await app.apiFetch(`/api/equipamento/${encodeURIComponent(serie)}/dossie`, {
        signal: meu.signal, errorMessage: TEXTO.erro,
      });
      if (obsoleta()) return;
      renderizar(dados);
    } catch (erro) {
      if (erro?.name === "AbortError") return;
      if (obsoleta()) return;
      limparCorpo();
      mostrarStatus(TEXTO.erro);
    }
  }

  // Fechar and Esc. The request in flight is cancelled; focus goes back to "Ver dossiê" (accessible dialog).
  function fecharDossieEquipamento() {
    if (!aberto) return;
    aberto = false;
    geracao += 1;
    controle?.abort();
    controle = null;
    app.fecharModalAcessivel(MODAL);
  }

  return { abrirDossieEquipamento, fecharDossieEquipamento, atualizarDossieEquipamento };
});
