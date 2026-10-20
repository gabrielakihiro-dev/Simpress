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

      lista.replaceChildren();
      if (eventos.length === 0) {
        const vazio = document.createElement("p");
        vazio.className = "text-sm text-slate-400 text-center py-8";
        vazio.setAttribute("role", "status");
        vazio.setAttribute("aria-live", "polite");
        vazio.textContent = "Nenhuma alteração registrada ainda. O histórico começa a partir desta atualização; alterações anteriores não têm horário recuperável.";
        lista.appendChild(vazio);
        return;
      }

      const ultimaPorCampo = ultimoRegistroPorCampo(eventos);
      const { scroller, corpo } = criarTabelaHistoricoApelidos();
      eventos.forEach(evento => corpo.appendChild(criarLinhaHistoricoApelido(evento, ultimaPorCampo)));
      lista.appendChild(scroller);
    } catch (err) {
      console.error("Erro ao carregar histórico de apelidos:", err);
      lista.replaceChildren();
      const erro = document.createElement("p");
      erro.className = "text-sm text-rose-300 text-center py-8";
      erro.setAttribute("role", "alert");
      erro.setAttribute("aria-live", "assertive");
      erro.textContent = err.message || "Não foi possível carregar o histórico.";
      lista.appendChild(erro);
    } finally {
      stopLoading();
      lista.removeAttribute("aria-busy");
    }
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
    tabela.className = "w-full min-w-[1100px] text-left text-xs";
    tabela.setAttribute("aria-label", "Histórico de alterações manuais de apelidos e usuários, avisos do Endpoint e registros antigos de endereço");
    tabela.innerHTML = `
          <thead class="sticky top-0 bg-slate-950 text-slate-400 uppercase tracking-wide">
            <tr>
              <th scope="col" class="px-3 py-2.5 font-semibold">Data e hora</th>
              <th scope="col" class="px-3 py-2.5 font-semibold">Equipamento</th>
              <th scope="col" class="px-3 py-2.5 font-semibold">Campo</th>
              <th scope="col" class="px-3 py-2.5 font-semibold">Valor anterior</th>
              <th scope="col" class="px-3 py-2.5 font-semibold">Valor novo</th>
              <th scope="col" class="px-3 py-2.5 font-semibold">Ação</th>
              <th scope="col" class="px-3 py-2.5 font-semibold">Desfazer</th>
              <th scope="col" class="px-3 py-2.5 font-semibold">Excluir registro</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-800"></tbody>
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
    linha.className = ehAviso ? "hover:bg-slate-800/40 history-warning-row" : "hover:bg-slate-800/40";

    const equipamento = document.createElement("td");
    equipamento.className = "px-3 py-3 text-slate-200";
    equipamento.textContent = `${evento.equipamento || "Equipamento"} · Série ${serial || "não informada"}`;
    linha.appendChild(equipamento);

    const celulaHorario = document.createElement("td");
    celulaHorario.className = "px-3 py-3 text-slate-400 whitespace-nowrap";
    celulaHorario.textContent = formatarHorarioHistorico(evento.horario);
    linha.insertBefore(celulaHorario, equipamento);

    const campo = document.createElement("td");
    campo.className = "px-3 py-3 text-slate-300";
    campo.textContent = ehEndereco ? "Endereço de instalação"
      : ehAviso ? "Aviso do Endpoint"
        : categoria === "usuario" ? "Usuário logado" : "Apelido / hostname";
    linha.appendChild(campo);

    const anterior = document.createElement("td");
    anterior.className = "px-3 py-3 text-slate-300 font-mono whitespace-pre-line";
    anterior.textContent = formatarValorHistorico(evento, true);
    linha.appendChild(anterior);

    const novo = document.createElement("td");
    novo.className = "px-3 py-3 text-cyan-300 font-mono whitespace-pre-line";
    novo.textContent = formatarValorHistorico(evento, false);
    linha.appendChild(novo);

    const acao = document.createElement("td");
    acao.className = "px-3 py-3 text-slate-400";
    if (ehAviso) {
      acao.textContent = `⚠ ${MOTIVOS_AVISO[evento.motivo] || "Dado removido no Endpoint"}`;
      acao.className = "px-3 py-3 text-amber-300";
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
    celulaDesfazer.className = "px-3 py-3";
    if (!ehEndereco) {
      const botao = document.createElement("button");
      botao.type = "button";
      botao.textContent = ehUltima ? "Desfazer" : "Anterior";
      botao.disabled = !ehUltima;
      botao.title = ehUltima ? (evento.tipo === "usuario" ? "Restaurar o usuário anterior" : "Restaurar o apelido anterior") : "Só a alteração mais recente deste equipamento pode ser desfeita";
      botao.className = ehUltima
        ? "px-2.5 py-1 rounded-md bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 transition"
        : "px-2.5 py-1 rounded-md bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed";
      botao.addEventListener("click", () => desfazerAlteracaoApelido(evento, botao));
      celulaDesfazer.appendChild(botao);
    } else {
      celulaDesfazer.textContent = "—";
      celulaDesfazer.className += " text-slate-600";
    }
    return celulaDesfazer;
  }

  function criarCelulaExcluir(evento, ehEndereco, ehUltimoCampo, ehAviso) {
    const celulaExcluir = document.createElement("td");
    celulaExcluir.className = "px-3 py-3";
    if (ehEndereco) {
      celulaExcluir.textContent = "—";
      celulaExcluir.className += " text-slate-600";
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
      botaoExcluir.className = ehUltimoCampo
        ? "px-2.5 py-1 rounded-md bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 transition"
        : "px-2.5 py-1 rounded-md bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed";
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
