/** Alias change history: lists manual alias changes and legacy address records, with undo and restore-and-delete. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).aliasHistory = factory;
})(typeof window !== "undefined" ? window : globalThis, function createAliasHistory(context) {
  "use strict";
  const { app, appState, motion } = context;
  const { formatarHorarioHistorico } = context.historyFormat;

  function formatarValorHistorico(evento, anterior) {
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
      const res = await fetch("/api/historico-alteracoes");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "Não foi possível carregar o histórico.");

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
      const tipoCampo = evento.tipo === "endereco" ? "endereco" : "apelido";
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
    tabela.setAttribute("aria-label", "Histórico de alterações manuais de apelidos e registros antigos de endereço");
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
    const ehEndereco = evento.tipo === "endereco";
    const chaveCampo = `${serial}:${ehEndereco ? "endereco" : "apelido"}`;
    const ehUltimoCampo = ultimaPorCampo.get(chaveCampo) === evento.id;
    const ehUltima = !ehEndereco && ehUltimoCampo;
    const linha = document.createElement("tr");
    linha.className = "hover:bg-slate-800/40";

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
    campo.textContent = ehEndereco ? "Endereço de instalação" : "Apelido / hostname";
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
    acao.textContent = evento.acao === "desfazer" ? "Reversão de apelido" : "Alteração";
    linha.appendChild(acao);

    linha.appendChild(criarCelulaDesfazer(evento, ehEndereco, ehUltima));
    linha.appendChild(criarCelulaExcluir(evento, ehEndereco, ehUltimoCampo));
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
      botao.title = ehUltima ? "Restaurar o apelido anterior" : "Só a alteração mais recente deste equipamento pode ser desfeita";
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

  function criarCelulaExcluir(evento, ehEndereco, ehUltimoCampo) {
    const celulaExcluir = document.createElement("td");
    celulaExcluir.className = "px-3 py-3";
    if (ehEndereco) {
      celulaExcluir.textContent = "—";
      celulaExcluir.className += " text-slate-600";
    } else {
      const botaoExcluir = document.createElement("button");
      botaoExcluir.type = "button";
      botaoExcluir.textContent = ehUltimoCampo ? "Restaurar e excluir" : "Anterior";
      botaoExcluir.disabled = !ehUltimoCampo;
      botaoExcluir.title = ehUltimoCampo
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
    const apelidoAnterior = evento.apelido_anterior || "(vazio)";
    if (!(await app.confirmarAcao({
      titulo: "Desfazer alteração?",
      mensagem: `Desfazer a alteração da série ${evento.serial} e restaurar o apelido ${apelidoAnterior}?`,
      confirmar: "Desfazer",
      destrutiva: false,
    }))) return;

    const textoOriginal = botao.textContent;
    botao.disabled = true;
    botao.textContent = "Desfazendo...";
    try {
      const res = await fetch("/api/equipamento/apelido/desfazer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evento_id: evento.id })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "Não foi possível desfazer a alteração.");

      if (appState.currentEquipamento && appState.currentEquipamento.serial === data.equipamento.serial) {
        app.definirEquipamentoAtual(data.equipamento);
        document.getElementById("badge-apelido").textContent = appState.currentEquipamento.apelido || "Sem Apelido";
      }
      await app.carregarEstatisticas();
      await carregarHistoricoApelidos();
      app.showToast("Apelido restaurado. A reversão foi registrada no histórico.", "success");
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
      const res = await fetch(`/api/historico-alteracoes/${encodeURIComponent(evento.id)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "Não foi possível excluir o registro.");
      if (appState.currentEquipamento && appState.currentEquipamento.serial === data.equipamento.serial) {
        app.definirEquipamentoAtual(data.equipamento);
        document.getElementById("badge-apelido").textContent = appState.currentEquipamento.apelido || "Sem Apelido";
        document.getElementById("card-localizacao").textContent = app.formatarLocalAtual(appState.currentEquipamento);
        document.getElementById("card-cnpj-atual").textContent = `CNPJ: ${appState.currentEquipamento.retirada_cnpj || "Não especificado"}`;
      }
      await carregarHistoricoApelidos();
      app.showToast(data.tipo === "endereco"
        ? "Endereço anterior restaurado e salvo; registro removido do histórico."
        : "Apelido anterior restaurado e salvo; registro removido do histórico.", "success");
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
