/** Equipment records: edit or register equipment and edit the alias of the selected equipment. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).equipmentEditor = factory;
})(typeof window !== "undefined" ? window : globalThis, function createEquipmentEditor(context) {
  "use strict";
  const { app, appState } = context;

  function abrirModalEditarEquipamento() {
    if (!appState.currentEquipamento) {
      app.showToast("Localize um equipamento antes de editar.", "warning");
      return;
    }

    document.getElementById("modal-edit-titulo").textContent = "Atualizar Cadastro do Equipamento";
    document.getElementById("modal-edit-serial-badge").textContent = appState.currentEquipamento.serial;

    document.getElementById("edit-serial").value = appState.currentEquipamento.serial || "";
    document.getElementById("edit-serial").readOnly = true;
    document.getElementById("edit-modelo").value = appState.currentEquipamento.modelo || "";
    document.getElementById("edit-tipo").value = appState.currentEquipamento.tipo || "Notebook";
    document.getElementById("edit-apelido").value = appState.currentEquipamento.apelido || "";
    document.getElementById("edit-apelido-field").classList.add("hidden");
    document.getElementById("edit-id-cliente").value = appState.currentEquipamento.idCliente || "";

    app.abrirModalAcessivel("modal-editar-equipamento", "#edit-modelo", "fecharModalEditarEquipamento");
  }

  function cadastrarNovoSerialPesquisado() {
    cadastrarNovoSerial(document.getElementById("input-serial")?.value || "");
  }

  function cadastrarNovoSerial(serial) {
    app.fecharAutocomplete();
    document.getElementById("modal-edit-titulo").textContent = "Cadastrar Novo Equipamento";
    document.getElementById("modal-edit-serial-badge").textContent = serial ? serial.toUpperCase() : "NOVO";

    document.getElementById("edit-serial").value = (serial || "").toUpperCase();
    document.getElementById("edit-serial").readOnly = false;
    document.getElementById("edit-modelo").value = "";
    document.getElementById("edit-tipo").value = "Notebook";
    document.getElementById("edit-apelido").value = "";
    document.getElementById("edit-apelido-field").classList.remove("hidden");
    document.getElementById("edit-id-cliente").value = "";
    app.abrirModalAcessivel("modal-editar-equipamento", "#edit-modelo", "fecharModalEditarEquipamento");
  }

  function fecharModalEditarEquipamento() {
    app.fecharModalAcessivel("modal-editar-equipamento");
  }

  function abrirModalEditarApelido() {
    if (!appState.currentEquipamento) {
      app.showToast("Localize um equipamento antes de editar o apelido.", "warning");
      return;
    }

    document.getElementById("edit-apelido-isolado").value = appState.currentEquipamento.apelido || "";
    document.getElementById("apelido-serial-contexto").textContent = `Série: ${appState.currentEquipamento.serial}`;
    app.abrirModalAcessivel("modal-editar-apelido", "#edit-apelido-isolado", "fecharModalEditarApelido");
    document.getElementById("edit-apelido-isolado").select();
  }

  function fecharModalEditarApelido() {
    app.fecharModalAcessivel("modal-editar-apelido");
  }

  async function salvarApelido() {
    if (!appState.currentEquipamento) {
      app.showToast("Localize um equipamento antes de editar o apelido.", "warning");
      app.fecharModalEditarApelido();
      return;
    }

    const serial = appState.currentEquipamento.serial;
    const selectionRevisionAtSave = appState.equipamentoSelectionRevision;
    const apelido = document.getElementById("edit-apelido-isolado").value.trim();
    const btn = document.getElementById("btn-salvar-apelido");
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.textContent = "Salvando...";

    try {
      const data = await app.apiFetch("/api/equipamento/atualizar-apelido", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serial, apelido }),
        errorMessage: "Falha ao salvar o apelido.",
      });

      const stillSelected = appState.equipamentoSelectionRevision === selectionRevisionAtSave
        && String(appState.currentEquipamento?.serial || "").toUpperCase() === String(serial).toUpperCase();
      if (stillSelected) {
        app.definirEquipamentoAtual(data.equipamento);
        document.getElementById("badge-apelido").textContent = appState.currentEquipamento.apelido || "Sem Apelido";
        app.atualizarIndicadoresPosSalvamento();
        app.fecharModalEditarApelido();
      }
      app.showToast("Apelido salvo para pesquisas e exportações do Excel.", "success");
    } catch (err) {
      console.error("Erro ao salvar apelido:", err);
      app.showToast(err.message || "Falha ao salvar o apelido.", "error");
    } finally {
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
      btn.textContent = originalText;
    }
  }

  // Usuário logado: vem do Endpoint; quando ele não informa, permite digitar o usuário manualmente.
  function atualizarUsuarioLogadoCard(eq) {
    const texto = document.getElementById("card-usuarios-logados");
    const acoes = document.getElementById("card-usuario-manual-acoes");
    const formulario = document.getElementById("form-usuario-manual");
    const usuario = String(eq?.usuarios_logados || "").trim();
    const manual = eq?.usuarios_logados_origem === "manual";
    texto.textContent = usuario ? `Usuários logados: ${usuario}${manual ? " (M)" : ""}` : "";
    texto.classList.toggle("hidden", !usuario);
    acoes.classList.toggle("hidden", !manual);
    // Sem usuário no Endpoint nem manual: mostra o campo para digitar.
    formulario.classList.toggle("hidden", Boolean(usuario) || !eq?.serial);
    if (!usuario) document.getElementById("input-usuario-manual").value = "";
  }

  function editarUsuarioLogado() {
    const atual = appState.currentEquipamento;
    if (!atual) return;
    const formulario = document.getElementById("form-usuario-manual");
    const campo = document.getElementById("input-usuario-manual");
    formulario.classList.remove("hidden");
    campo.value = atual.usuarios_logados || "";
    campo.focus();
    campo.select();
  }

  async function enviarUsuarioLogado(usuario, mensagemSucesso) {
    if (!appState.currentEquipamento) {
      app.showToast("Localize um equipamento antes de informar o usuário.", "warning");
      return;
    }
    const serial = appState.currentEquipamento.serial;
    const selectionRevisionAtSave = appState.equipamentoSelectionRevision;
    const botao = document.getElementById("btn-salvar-usuario-manual");
    botao.disabled = true;
    botao.setAttribute("aria-busy", "true");
    try {
      const data = await app.apiFetch("/api/equipamento/atualizar-usuario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serial, usuario }),
        errorMessage: "Falha ao salvar o usuário.",
      });
      const stillSelected = appState.equipamentoSelectionRevision === selectionRevisionAtSave
        && String(appState.currentEquipamento?.serial || "").toUpperCase() === String(serial).toUpperCase();
      if (stillSelected) {
        app.definirEquipamentoAtual(data.equipamento);
        atualizarUsuarioLogadoCard(appState.currentEquipamento);
      }
      app.showToast(mensagemSucesso, "success");
    } catch (err) {
      console.error("Erro ao salvar usuário logado:", err);
      app.showToast(err.message || "Falha ao salvar o usuário.", "error");
    } finally {
      botao.disabled = false;
      botao.removeAttribute("aria-busy");
    }
  }

  function salvarUsuarioLogado() {
    const usuario = document.getElementById("input-usuario-manual").value.trim();
    if (!usuario) {
      app.showToast("Digite o usuário antes de salvar.", "warning");
      return Promise.resolve();
    }
    return enviarUsuarioLogado(usuario, "Usuário salvo e registrado no histórico de alterações.");
  }

  function limparUsuarioLogado() {
    return enviarUsuarioLogado("", "Usuário manual removido e registrado no histórico de alterações.");
  }

  const CAMPOS_ENTREGA_PRESERVADOS_AO_EDITAR_EQUIPAMENTO = [
    "select-unidade-destino",
    "entrega-cnpj",
    "entrega-endereco",
    "entrega-representante",
    "entrega-contato",
    "entrega-email",
    "entrega-telefone",
    "entrega-horario",
    "entrega-almoco",
    "entrega-pausa-duracao",
    "entrega-obs"
  ];

  function capturarDadosEntrega() {
    return CAMPOS_ENTREGA_PRESERVADOS_AO_EDITAR_EQUIPAMENTO.reduce((valores, id) => {
      const campo = document.getElementById(id);
      if (campo) valores[id] = campo.value;
      return valores;
    }, {});
  }

  function restaurarDadosEntrega(valores) {
    Object.entries(valores).forEach(([id, valor]) => {
      const campo = document.getElementById(id);
      if (campo) campo.value = valor;
    });
    app.atualizarObrigatoriedadeDuracaoPausaEntrega();
  }

  async function salvarDadosEquipamento() {
    const serial = document.getElementById("edit-serial").value.trim().toUpperCase();
    if (!serial) {
      app.showToast("O número de série é obrigatório.", "warning");
      document.getElementById("edit-serial").focus();
      return;
    }

    const payload = {
      serial: serial,
      novo: !document.getElementById("edit-serial").readOnly,
      modelo: document.getElementById("edit-modelo").value.trim(),
      tipo: document.getElementById("edit-tipo").value,
      apelido: appState.currentEquipamento && appState.currentEquipamento.serial === serial
        ? (appState.currentEquipamento.apelido || "")
        : document.getElementById("edit-apelido").value.trim(),
      idCliente: document.getElementById("edit-id-cliente").value.trim(),
    };
    const selectionRevisionAtSave = appState.equipamentoSelectionRevision;

    const btn = document.getElementById("btn-salvar-equipamento");
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i><span>Salvando no Excel...</span>`;
    lucide.createIcons({ root: btn });

    try {
      const data = await app.apiFetch("/api/equipamento/salvar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        errorMessage: "Falha ao salvar equipamento.",
      });
      const stillSelected = appState.equipamentoSelectionRevision === selectionRevisionAtSave;
      if (stillSelected) {
        const dadosEntrega = capturarDadosEntrega();
        app.definirEquipamentoAtual(data.equipamento);
        app.exibirEquipamento(data.equipamento);
        restaurarDadosEntrega(dadosEntrega);
        document.getElementById("input-serial").value = data.equipamento.serial;
        document.getElementById("btn-clear-serial").classList.remove("hidden");

        app.atualizarIndicadoresPosSalvamento();
        app.fecharModalEditarEquipamento();
      }
      app.showToast(data.mensagem || `Equipamento ${serial} salvo com sucesso!`, "success");

    } catch (err) {
      console.error("Erro ao salvar:", err);
      app.showToast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
      btn.innerHTML = originalText;
      lucide.createIcons({ root: btn });
    }
  }

  return {
    abrirModalEditarEquipamento, cadastrarNovoSerialPesquisado, fecharModalEditarEquipamento, abrirModalEditarApelido,
    fecharModalEditarApelido, salvarApelido, salvarDadosEquipamento,
    atualizarUsuarioLogadoCard, editarUsuarioLogado, salvarUsuarioLogado, limparUsuarioLogado,
  };
});
