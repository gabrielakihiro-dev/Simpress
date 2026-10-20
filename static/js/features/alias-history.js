/** Alias change history: lists manual alias changes and legacy address records, with undo and restore-and-delete. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).aliasHistory = factory;
})(typeof window !== "undefined" ? window : globalThis, function createAliasHistory(context) {
  "use strict";
  const { app, appState, motion } = context;
  const { formatarHorarioHistorico } = context.historyFormat;

  const MOTIVOS_AVISO = {
    usuario_removido: "Usuário logado removido no Endpoint",
    hostname_removido: "Hostname removido no Endpoint",
  };
  const EVENTOS_POR_PAGINA = 25;
  let eventosHistorico = [];
  let ultimaPorCampoHistorico = new Map();
  let paginaHistorico = 1;
  let filtrosHistoricoConectados = false;

  function categoriaEvento(evento) {
    if (evento.tipo === "endereco" || evento.tipo === "usuario" || evento.tipo === "aviso_endpoint") return evento.tipo;
    return "apelido";
  }

  function formatarValorHistorico(evento, anterior) {
    if (evento.tipo === "aviso_endpoint") {
      return anterior ? (evento.valor_anterior || "(vazio)") : "(vazio)";
    }
    if (evento.tipo === "usuario") {
      const usuario = anterior ? evento.usuario_anterior : evento.usuario_novo;
      return usuario || "(vazio)";
    }
    if (evento.tipo !== "endereco") {
      const apelido = anterior ? evento.apelido_anterior : evento.apelido_novo;
      return apelido || "(vazio)";
    }

    const endereco = anterior ? evento.endereco_anterior : evento.endereco_novo;
    if (!endereco || typeof endereco !== "object") return "(vazio)";
    return [
      endereco.endereco ? `Endereço: ${endereco.endereco}` : "",
      endereco.cidade || endereco.uf ? `Cidade/UF: ${[endereco.cidade, endereco.uf].filter(Boolean).join("/")}` : "",
      endereco.cep ? `CEP: ${endereco.cep}` : "",
      endereco.cnpj ? `CNPJ: ${endereco.cnpj}` : ""
    ].filter(Boolean).join("\n") || "(vazio)";
  }

  async function abrirModalHistoricoApelidos() {
    app.abrirModalAcessivel("modal-historico-apelidos", '[aria-label="Fechar histórico"]', "fecharModalHistoricoApelidos", "btn-historico-apelidos");
    conectarFiltrosHistorico();
    await carregarHistoricoApelidos();
  }

  function fecharModalHistoricoApelidos() {
    app.fecharModalAcessivel("modal-historico-apelidos");
  }

  function definirTotalHistoricoApelidos(total) {
    const valor = Number(total || 0);
    document.getElementById("total-historico-apelidos").textContent = `${valor} ${valor === 1 ? "registro" : "registros"}`;
  }

  async function carregarContagemHistoricoApelidos() {
    try {
      const res = await fetch("/api/historico-alteracoes");
      if (!res.ok) return;
      const data = await res.json();
      definirTotalHistoricoApelidos(data.total);
    } catch (err) {
      console.warn("Não foi possível carregar a contagem do histórico:", err);
    }
  }

  async function carregarHistoricoApelidos() {
    const lista = document.getElementById("lista-historico-apelidos");
    lista.setAttribute("aria-busy", "true");
    lista.innerHTML = '<p class="text-sm text-slate-400 text-center py-8" role="status" aria-live="polite">Carregando histórico...</p>';
    const stopLoading = motion?.startLoading(lista, "Carregando histórico…") || (() => {});

    try {
      const data = await app.apiFetch("/api/historico-alteracoes", { errorMessage: "Não foi possível carregar o histórico." });

      const eventos = Array.isArray(data.eventos) ? data.eventos : [];
      definirTotalHistoricoApelidos(eventos.length);
      eventosHistorico = eventos;
      ultimaPorCampoHistorico = ultimoRegistroPorCampo(eventosHistorico);
      paginaHistorico = 1;
      renderizarHistoricoApelidos();
    } catch (err) {
      console.error("Erro ao carregar histórico de apelidos:", err);
      lista.replaceChildren();
      const erro = document.createElement("p");
      erro.className = "text-sm text-rose-300 text-center py-8";
      erro.setAttribute("role", "alert");
      erro.setAttribute("aria-live", "assertive");
      erro.textContent = err.message || "Não foi possível carregar o histórico.";
      lista.appendChild(erro);
      document.getElementById("resultado-filtros-historico-apelidos").textContent = "Não foi possível carregar os registros.";
      document.getElementById("paginacao-historico-apelidos").hidden = true;
    } finally {
      stopLoading();
      lista.removeAttribute("aria-busy");
    }
  }

  function conectarFiltrosHistorico() {
    if (filtrosHistoricoConectados) return;
    const busca = document.getElementById("busca-historico-apelidos");
    const tipo = document.getElementById("tipo-historico-apelidos");
    const apenasAcoes = document.getElementById("apenas-acoes-historico-apelidos");
    const limpar = document.getElementById("limpar-filtros-historico-apelidos");
    const anterior = document.getElementById("pagina-anterior-historico-apelidos");
    const proxima = document.getElementById("proxima-pagina-historico-apelidos");
    if (!busca || !tipo || !apenasAcoes || !limpar || !anterior || !proxima) return;

    const aplicarFiltros = () => {
      paginaHistorico = 1;
      renderizarHistoricoApelidos();
    };
    busca.addEventListener("input", aplicarFiltros);
    tipo.addEventListener("change", aplicarFiltros);
    apenasAcoes.addEventListener("change", aplicarFiltros);
    limpar.addEventListener("click", () => {
      busca.value = "";
      tipo.value = "todos";
      apenasAcoes.checked = false;
      aplicarFiltros();
      busca.focus();
    });
    anterior.addEventListener("click", () => {
      if (paginaHistorico <= 1) return;
      paginaHistorico -= 1;
      renderizarHistoricoApelidos();
    });
    proxima.addEventListener("click", () => {
      const totalPaginas = Math.ceil(filtrarEventosHistorico().length / EVENTOS_POR_PAGINA);
      if (paginaHistorico >= totalPaginas) return;
      paginaHistorico += 1;
      renderizarHistoricoApelidos();
    });
    filtrosHistoricoConectados = true;
  }

  function normalizarBuscaHistorico(valor) {
    return String(valor || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("pt-BR")
      .trim();
  }

  function rotuloCategoriaHistorico(categoria) {
    return categoria === "endereco" ? "Endereço de instalação"
      : categoria === "aviso_endpoint" ? "Aviso do Endpoint"
        : categoria === "usuario" ? "Usuário logado" : "Apelido / hostname";
  }

  function eventoTemAcaoDisponivel(evento) {
    const serial = String(evento.serial || "").toUpperCase();
    if (!serial) return false;
    const categoria = categoriaEvento(evento);
    if (categoria === "endereco") return false;
    const tipoCampo = categoria === "aviso_endpoint" ? `aviso:${evento.id}` : categoria;
    return ultimaPorCampoHistorico.get(`${serial}:${tipoCampo}`) === evento.id;
  }

  function filtrarEventosHistorico() {
    const busca = normalizarBuscaHistorico(document.getElementById("busca-historico-apelidos")?.value);
    const tipo = document.getElementById("tipo-historico-apelidos")?.value || "todos";
    const apenasAcoes = Boolean(document.getElementById("apenas-acoes-historico-apelidos")?.checked);
    const termos = busca ? busca.split(/\s+/).filter(Boolean) : [];

    return eventosHistorico.filter(evento => {
      const categoria = categoriaEvento(evento);
      if (tipo !== "todos" && categoria !== tipo) return false;
      if (apenasAcoes && !eventoTemAcaoDisponivel(evento)) return false;
      if (!termos.length) return true;

      const textoEvento = normalizarBuscaHistorico([
        evento.serial,
        evento.equipamento,
        evento.acao,
        evento.usuario_endpoint,
        evento.motivo ? MOTIVOS_AVISO[evento.motivo] : "",
        rotuloCategoriaHistorico(categoria),
        formatarHorarioHistorico(evento.horario),
        formatarValorHistorico(evento, true),
        formatarValorHistorico(evento, false),
      ].join(" "));
      return termos.every(termo => textoEvento.includes(termo));
    });
  }

  function renderizarHistoricoApelidos() {
    const lista = document.getElementById("lista-historico-apelidos");
    if (!lista) return;
    const eventos = filtrarEventosHistorico();
    const totalPaginas = Math.max(1, Math.ceil(eventos.length / EVENTOS_POR_PAGINA));
    paginaHistorico = Math.min(Math.max(paginaHistorico, 1), totalPaginas);
    const inicio = (paginaHistorico - 1) * EVENTOS_POR_PAGINA;
    const eventosDaPagina = eventos.slice(inicio, inicio + EVENTOS_POR_PAGINA);
    const resultado = document.getElementById("resultado-filtros-historico-apelidos");
    const paginacao = document.getElementById("paginacao-historico-apelidos");
    const paginaAtual = document.getElementById("pagina-atual-historico-apelidos");
    const botaoAnterior = document.getElementById("pagina-anterior-historico-apelidos");
    const botaoProxima = document.getElementById("proxima-pagina-historico-apelidos");

    if (eventos.length === 0) {
      const vazio = document.createElement("p");
      vazio.className = "alias-history-empty";
      vazio.setAttribute("role", "status");
      vazio.setAttribute("aria-live", "polite");
      vazio.textContent = eventosHistorico.length === 0
        ? "Nenhuma alteração registrada ainda. O histórico começa a partir desta atualização; alterações anteriores não têm horário recuperável."
        : "Nenhum registro combina com os filtros. Ajuste a busca ou limpe os filtros.";
      lista.replaceChildren(vazio);
      resultado.textContent = eventosHistorico.length === 0 ? "0 registros" : "Nenhum registro encontrado";
      paginacao.hidden = true;
      return;
    }

    const { scroller, corpo } = criarTabelaHistoricoApelidos();
    eventosDaPagina.forEach(evento => corpo.appendChild(criarLinhaHistoricoApelido(evento, ultimaPorCampoHistorico)));
    lista.replaceChildren(scroller);
    resultado.textContent = eventos.length === eventosHistorico.length
      ? `Exibindo ${inicio + 1}–${inicio + eventosDaPagina.length} de ${eventosHistorico.length} registros`
      : `${eventos.length} de ${eventosHistorico.length} registros · exibindo ${inicio + 1}–${inicio + eventosDaPagina.length}`;
    paginacao.hidden = eventos.length <= EVENTOS_POR_PAGINA;
    paginaAtual.textContent = `Página ${paginaHistorico} de ${totalPaginas}`;
    botaoAnterior.disabled = paginaHistorico <= 1;
    botaoProxima.disabled = paginaHistorico >= totalPaginas;
  }

  // Only the latest record of each equipment field can be undone or restored.
  function ultimoRegistroPorCampo(eventos) {
    const ultimaPorCampo = new Map();
    eventos.forEach(evento => {
      const serial = String(evento.serial || "").toUpperCase();
      // Avisos não têm desfazer: cada um é o "mais recente" de si mesmo.
      const tipoCampo = categoriaEvento(evento) === "aviso_endpoint" ? `aviso:${evento.id}` : categoriaEvento(evento);
      const chaveCampo = `${serial}:${tipoCampo}`;
      if (serial && !ultimaPorCampo.has(chaveCampo)) {
        ultimaPorCampo.set(chaveCampo, evento.id);
      }
    });
    return ultimaPorCampo;
  }

  function criarTabelaHistoricoApelidos() {
    const scroller = document.createElement("div");
    scroller.className = "accessible-table-wrap";
    scroller.setAttribute("role", "region");
    scroller.setAttribute("aria-label", "Tabela do histórico de alterações");
    scroller.tabIndex = 0;
    const tabela = document.createElement("table");
    tabela.className = "alias-history-table";
    tabela.setAttribute("aria-label", "Histórico de alterações manuais de apelidos e usuários, avisos do Endpoint e registros antigos de endereço");
    tabela.innerHTML = `
          <thead>
            <tr>
              <th scope="col">Data e hora</th>
              <th scope="col">Equipamento</th>
              <th scope="col">Campo</th>
              <th scope="col">Valor anterior</th>
              <th scope="col">Valor novo</th>
              <th scope="col">Ação</th>
              <th scope="col">Desfazer</th>
              <th scope="col">Excluir registro</th>
            </tr>
          </thead>
          <tbody></tbody>
        `;
    scroller.appendChild(tabela);
    return { scroller, corpo: tabela.querySelector("tbody") };
  }

  function criarLinhaHistoricoApelido(evento, ultimaPorCampo) {
    const serial = String(evento.serial || "").toUpperCase();
    const categoria = categoriaEvento(evento);
    const ehEndereco = categoria === "endereco";
    const ehAviso = categoria === "aviso_endpoint";
    const chaveCampo = `${serial}:${ehAviso ? `aviso:${evento.id}` : categoria}`;
    const ehUltimoCampo = ultimaPorCampo.get(chaveCampo) === evento.id;
    const ehUltima = !ehEndereco && !ehAviso && ehUltimoCampo;
    const linha = document.createElement("tr");
    linha.className = ehAviso ? "alias-history-row history-warning-row" : "alias-history-row";

    const equipamento = document.createElement("td");
    equipamento.className = "alias-history-equipment";
    equipamento.dataset.label = "Equipamento";
    const equipamentoTexto = document.createElement("span");
    equipamentoTexto.className = "alias-history-equipment-name";
    equipamentoTexto.textContent = `${evento.equipamento || "Equipamento"} · Série ${serial || "não informada"}`;
    equipamento.appendChild(equipamentoTexto);
    linha.appendChild(equipamento);

    const celulaHorario = document.createElement("td");
    celulaHorario.className = "alias-history-date";
    celulaHorario.dataset.label = "Data e hora";
    celulaHorario.textContent = formatarHorarioHistorico(evento.horario);
    linha.insertBefore(celulaHorario, equipamento);

    const campo = document.createElement("td");
    campo.className = "alias-history-field-cell";
    campo.dataset.label = "Campo";
    const seloCampo = document.createElement("span");
    seloCampo.className = `alias-history-field-badge alias-history-field-badge--${categoria}`;
    seloCampo.textContent = rotuloCategoriaHistorico(categoria);
    campo.appendChild(seloCampo);
    linha.appendChild(campo);

    const anterior = document.createElement("td");
    anterior.className = "alias-history-value alias-history-value--previous";
    anterior.dataset.label = "Valor anterior";
    anterior.textContent = formatarValorHistorico(evento, true);
    linha.appendChild(anterior);

    const novo = document.createElement("td");
    novo.className = "alias-history-value alias-history-value--new";
    novo.dataset.label = "Valor novo";
    novo.textContent = formatarValorHistorico(evento, false);
    linha.appendChild(novo);

    const acao = document.createElement("td");
    acao.className = ehAviso ? "alias-history-action alias-history-action--warning" : "alias-history-action";
    acao.dataset.label = "Ação";
    if (ehAviso) {
      acao.textContent = `⚠ ${MOTIVOS_AVISO[evento.motivo] || "Dado removido no Endpoint"}`;
    } else {
      acao.textContent = evento.acao === "desfazer"
        ? (categoria === "usuario" ? "Reversão de usuário" : "Reversão de apelido")
        : evento.acao === "arquivado_endpoint"
          ? `Manual arquivado: o Endpoint informou ${evento.usuario_endpoint || "outro usuário"}`
          : "Alteração";
    }
    linha.appendChild(acao);

    linha.appendChild(criarCelulaDesfazer(evento, ehEndereco || ehAviso, ehUltima));
    linha.appendChild(criarCelulaExcluir(evento, ehEndereco, ehUltimoCampo, ehAviso));
    return linha;
  }

  function criarCelulaDesfazer(evento, ehEndereco, ehUltima) {
    const celulaDesfazer = document.createElement("td");
    celulaDesfazer.className = "alias-history-controls-cell";
    celulaDesfazer.dataset.label = "Desfazer";
    if (!ehEndereco) {
      const botao = document.createElement("button");
      botao.type = "button";
      botao.textContent = ehUltima ? "Desfazer" : "Anterior";
      botao.disabled = !ehUltima;
      botao.title = ehUltima ? (evento.tipo === "usuario" ? "Restaurar o usuário anterior" : "Restaurar o apelido anterior") : "Só a alteração mais recente deste equipamento pode ser desfeita";
      botao.className = `alias-history-action-button${ehUltima ? "" : " is-disabled"}`;
      botao.setAttribute("aria-label", `${ehUltima ? "Desfazer" : "Alteração anterior indisponível"} · série ${evento.serial || "não informada"}`);
      botao.addEventListener("click", () => desfazerAlteracaoApelido(evento, botao));
      celulaDesfazer.appendChild(botao);
    } else {
      celulaDesfazer.textContent = "—";
      celulaDesfazer.className += " alias-history-unavailable";
    }
    return celulaDesfazer;
  }

  function criarCelulaExcluir(evento, ehEndereco, ehUltimoCampo, ehAviso) {
    const celulaExcluir = document.createElement("td");
    celulaExcluir.className = "alias-history-controls-cell";
    celulaExcluir.dataset.label = "Excluir registro";
    if (ehEndereco) {
      celulaExcluir.textContent = "—";
      celulaExcluir.className += " alias-history-unavailable";
    } else {
      const botaoExcluir = document.createElement("button");
      botaoExcluir.type = "button";
      botaoExcluir.textContent = ehAviso ? "Excluir aviso" : ehUltimoCampo ? "Restaurar e excluir" : "Anterior";
      botaoExcluir.disabled = !ehUltimoCampo;
      botaoExcluir.title = ehAviso
        ? "Remover este aviso do histórico (não altera nenhum dado)"
        : ehUltimoCampo
        ? "Salvar o valor anterior no equipamento e remover este registro"
        : "Só o registro mais recente deste campo pode ser restaurado e excluído";
      botaoExcluir.className = `alias-history-action-button${ehUltimoCampo ? "" : " is-disabled"}`;
      botaoExcluir.setAttribute("aria-label", `${ehAviso ? "Excluir aviso" : ehUltimoCampo ? "Restaurar e excluir" : "Registro anterior indisponível"} · série ${evento.serial || "não informada"}`);
      botaoExcluir.addEventListener("click", () => excluirRegistroHistorico(evento, botaoExcluir));
      celulaExcluir.appendChild(botaoExcluir);
    }
    return celulaExcluir;
  }

  async function desfazerAlteracaoApelido(evento, botao) {
    const ehUsuario = evento.tipo === "usuario";
    const apelidoAnterior = (ehUsuario ? evento.usuario_anterior : evento.apelido_anterior) || "(vazio)";
    if (!(await app.confirmarAcao({
      titulo: "Desfazer alteração?",
      mensagem: `Desfazer a alteração da série ${evento.serial} e restaurar ${ehUsuario ? "o usuário" : "o apelido"} ${apelidoAnterior}?`,
      confirmar: "Desfazer",
      destrutiva: false,
    }))) return;

    const textoOriginal = botao.textContent;
    botao.disabled = true;
    botao.textContent = "Desfazendo...";
    try {
      const data = await app.apiFetch("/api/equipamento/apelido/desfazer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evento_id: evento.id }),
        errorMessage: "Não foi possível desfazer a alteração.",
      });

      if (appState.currentEquipamento && appState.currentEquipamento.serial === data.equipamento.serial) {
        app.definirEquipamentoAtual(data.equipamento);
        document.getElementById("badge-apelido").textContent = appState.currentEquipamento.apelido || "Sem Apelido";
        app.atualizarUsuarioLogadoCard?.(appState.currentEquipamento);
      }
      await app.carregarEstatisticas();
      await carregarHistoricoApelidos();
      app.showToast(ehUsuario
        ? "Usuário restaurado. A reversão foi registrada no histórico."
        : "Apelido restaurado. A reversão foi registrada no histórico.", "success");
    } catch (err) {
      console.error("Erro ao desfazer alteração de apelido:", err);
      app.showToast(err.message || "Não foi possível desfazer a alteração.", "error");
      botao.disabled = false;
      botao.textContent = textoOriginal;
    }
  }

  async function excluirRegistroHistorico(evento, botao) {
    if (!(await app.confirmarAcao({
      titulo: "Excluir registro?",
      mensagem: "Tem certeza de que deseja excluir esse registro? Essa ação não poderá ser desfeita.",
      confirmar: "Excluir",
    }))) return;

    const textoOriginal = botao.textContent;
    botao.disabled = true;
    botao.textContent = "Excluindo...";
    try {
      const data = await app.apiFetch(`/api/historico-alteracoes/${encodeURIComponent(evento.id)}`, { method: "DELETE", errorMessage: "Não foi possível excluir o registro." });
      if (data.equipamento && appState.currentEquipamento && appState.currentEquipamento.serial === data.equipamento.serial) {
        app.definirEquipamentoAtual(data.equipamento);
        document.getElementById("badge-apelido").textContent = appState.currentEquipamento.apelido || "Sem Apelido";
        app.atualizarUsuarioLogadoCard?.(appState.currentEquipamento);
        document.getElementById("card-localizacao").textContent = app.formatarLocalAtual(appState.currentEquipamento);
        document.getElementById("card-cnpj-atual").textContent = `CNPJ: ${appState.currentEquipamento.retirada_cnpj || "Não especificado"}`;
      }
      await carregarHistoricoApelidos();
      const mensagens = {
        endereco: "Endereço anterior restaurado e salvo; registro removido do histórico.",
        usuario: "Usuário anterior restaurado e salvo; registro removido do histórico.",
        aviso_endpoint: "Aviso removido do histórico.",
      };
      app.showToast(mensagens[data.tipo] || "Apelido anterior restaurado e salvo; registro removido do histórico.", "success");
    } catch (err) {
      console.error("Erro ao excluir registro do histórico:", err);
      app.showToast(err.message || "Não foi possível excluir o registro.", "error");
      botao.disabled = false;
      botao.textContent = textoOriginal;
    }
  }

  return {
    abrirModalHistoricoApelidos, fecharModalHistoricoApelidos, carregarContagemHistoricoApelidos,
  };
});
