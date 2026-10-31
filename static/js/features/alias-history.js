/** Alias change history actions: undo and restore-and-delete for the cockpit panel "Histórico de apelidos". */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).aliasHistory = factory;
})(typeof window !== "undefined" ? window : globalThis, function createAliasHistory(context) {
  "use strict";
  const { app, appState } = context;

  function categoriaEvento(evento) {
    if (evento.tipo === "endereco" || evento.tipo === "usuario" || evento.tipo === "aviso_endpoint") return evento.tipo;
    return "apelido";
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

  /** Ações permitidas ao evento: `desfazer` (apelido/usuário mais recente) e `excluir` (aviso ou mais recente do campo). */
  function acoesEventoHistorico(evento, eventos, ultimaPorCampo = ultimoRegistroPorCampo(eventos)) {
    const serial = String(evento.serial || "").toUpperCase();
    const categoria = categoriaEvento(evento);
    const ehAviso = categoria === "aviso_endpoint";
    const ehEndereco = categoria === "endereco";
    const chaveCampo = `${serial}:${ehAviso ? `aviso:${evento.id}` : categoria}`;
    const ehUltimoCampo = Boolean(serial) && ultimaPorCampo.get(chaveCampo) === evento.id;
    return {
      desfazer: ehUltimoCampo && !ehEndereco && !ehAviso,
      excluir: ehUltimoCampo && !ehEndereco,
      rotuloExcluir: ehAviso ? "Excluir aviso" : "Restaurar e excluir",
    };
  }

  async function desfazerAlteracaoApelido(evento, botao) {
    const ehUsuario = evento.tipo === "usuario";
    const apelidoAnterior = (ehUsuario ? evento.usuario_anterior : evento.apelido_anterior) || "(vazio)";
    if (!(await app.confirmarAcao({
      titulo: "Desfazer alteração?",
      mensagem: `Desfazer a alteração da série ${evento.serial} e restaurar ${ehUsuario ? "o usuário" : "o apelido"} ${apelidoAnterior}?`,
      confirmar: "Desfazer",
      destrutiva: false,
    }))) return false;

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
      app.showToast(ehUsuario
        ? "Usuário restaurado. A reversão foi registrada no histórico."
        : "Apelido restaurado. A reversão foi registrada no histórico.", "success");
      return true;
    } catch (err) {
      console.error("Erro ao desfazer alteração de apelido:", err);
      app.showToast(err.message || "Não foi possível desfazer a alteração.", "error");
      botao.disabled = false;
      botao.textContent = textoOriginal;
      return false;
    }
  }

  // Reconfere o histórico no servidor: o painel pode estar desatualizado e só o registro mais recente do campo é válido.
  async function desfazerEventoHistoricoApelidos(evento, botao) {
    const tipo = evento?.tipo || "apelido";
    if (!["apelido", "usuario"].includes(tipo)) {
      app.showToast("Este tipo de registro não pode ser restaurado por aqui.", "warning");
      return false;
    }
    const data = await app.apiFetch("/api/historico-alteracoes", { errorMessage: "Não foi possível carregar o histórico." });
    const eventos = Array.isArray(data.eventos) ? data.eventos : [];
    const atual = eventos.find(item => item.id === evento.id);
    if (!atual || !acoesEventoHistorico(atual, eventos).desfazer) {
      app.showToast("Só o registro mais recente desse campo pode ser restaurado. Atualize o histórico.", "warning");
      return false;
    }
    return desfazerAlteracaoApelido(atual, botao);
  }

  async function excluirRegistroHistorico(evento, botao) {
    if (!(await app.confirmarAcao({
      titulo: "Excluir registro?",
      mensagem: "Tem certeza de que deseja excluir esse registro? Essa ação não poderá ser desfeita.",
      confirmar: "Excluir",
    }))) return false;

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
      const mensagens = {
        endereco: "Endereço anterior restaurado e salvo; registro removido do histórico.",
        usuario: "Usuário anterior restaurado e salvo; registro removido do histórico.",
        aviso_endpoint: "Aviso removido do histórico.",
      };
      app.showToast(mensagens[data.tipo] || "Apelido anterior restaurado e salvo; registro removido do histórico.", "success");
      return true;
    } catch (err) {
      console.error("Erro ao excluir registro do histórico:", err);
      app.showToast(err.message || "Não foi possível excluir o registro.", "error");
      botao.disabled = false;
      botao.textContent = textoOriginal;
      return false;
    }
  }

  return {
    acoesEventoHistorico, ultimoRegistroPorCampo, desfazerEventoHistoricoApelidos, excluirRegistroHistorico,
  };
});
