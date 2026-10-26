/** Equipment records: edit or register equipment and edit the alias of the selected equipment. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).equipmentEditor = factory;
})(typeof window !== "undefined" ? window : globalThis, function createEquipmentEditor(context) {
  "use strict";
  const { app, appState } = context;

  function abrirModalEditarEquipamento() {
    if (!appState.currentEquipamento) {
      app.showToast("Pesquise um equipamento antes de editar.", "warning");
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
      app.showToast("Pesquise um equipamento antes de editar o apelido.", "warning");
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
      app.showToast("Pesquise um equipamento antes de editar o apelido.", "warning");
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
    // Série repetida no Endpoint: mostra os candidatos sem escolher um; o manual continua possível.
    const marcadores = context.loggedUserMarkers;
    const ambiguo = marcadores?.textoAmbiguo?.(eq?.usuarios_logados_candidatos) || "";
    const titulo = [manual ? marcadores?.tituloManual?.(eq?.usuarios_logados_informado_em) : "", ambiguo ? marcadores?.TITULO_AMBIGUO : ""]
      .filter(Boolean).join(". ");
    texto.textContent = [usuario ? `Usuários logados: ${usuario}${manual ? " (M)" : ""}` : "", ambiguo].filter(Boolean).join(" · ");
    if (titulo) texto.title = titulo;
    else texto.removeAttribute("title");
    texto.classList.toggle("equipment-user-ambiguous", Boolean(ambiguo) && !usuario);
    texto.classList.toggle("hidden", !usuario && !ambiguo);
    acoes.classList.toggle("hidden", !manual);
    // Sem usuário no Endpoint nem manual: mostra o campo para digitar.
    formulario.classList.toggle("hidden", Boolean(usuario) || !eq?.serial);
    if (!usuario) document.getElementById("input-usuario-manual").value = "";
    const nome = String(eq?.nome_pessoa || "").trim();
    const nomeTexto = document.getElementById("card-nome-pessoa");
    const nomeForm = document.getElementById("form-nome-pessoa");
    const nomeEditarButton = document.getElementById("btn-editar-nome-pessoa");
    nomeTexto.textContent = nome ? `Nome da pessoa: ${nome}${eq?.nome_pessoa_origem === "manual" ? " (manual)" : ""}` : "";
    nomeTexto.classList.toggle("hidden", !nome);
    nomeForm.classList.toggle("hidden", !eq?.nome_pessoa_editavel || Boolean(nome));
    nomeEditarButton?.classList.toggle("hidden", !eq?.nome_pessoa_editavel || !nome);
    if (nomeEditarButton) {
      nomeEditarButton.textContent = "Editar nome";
      nomeEditarButton.setAttribute("aria-expanded", "false");
    }
    document.getElementById("input-nome-pessoa").value = eq?.nome_pessoa_origem === "manual" ? nome : "";
  }

  function editarNomePessoa() {
    const formulario = document.getElementById("form-nome-pessoa");
    const campo = document.getElementById("input-nome-pessoa");
    const button = document.getElementById("btn-editar-nome-pessoa");
    const abrir = formulario.classList.contains("hidden");
    formulario.classList.toggle("hidden", !abrir);
    button.textContent = abrir ? "Cancelar edição" : "Editar nome";
    button.setAttribute("aria-expanded", String(abrir));
    if (abrir) campo.focus();
    else {
      const equipment = appState.currentEquipamento;
      campo.value = equipment?.nome_pessoa_origem === "manual" ? String(equipment.nome_pessoa || "").trim() : "";
    }
  }

  async function salvarNomePessoa() {
    const equipment = appState.currentEquipamento;
    if (!equipment?.serial) return;
    const button = document.getElementById("btn-salvar-nome-pessoa");
    const nome = document.getElementById("input-nome-pessoa").value.trim();
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      const result = await app.apiFetch("/api/equipamento/nome-pessoa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serial: equipment.serial, login_atual: equipment.usuarios_logados || "", nome }),
        errorMessage: "Não foi possível salvar o nome da pessoa.",
      });
      if (appState.currentEquipamento?.serial === equipment.serial) {
        app.definirEquipamentoAtual(result.equipamento);
        atualizarUsuarioLogadoCard(result.equipamento);
      }
      if (result.base_atualizada === false) app.showToast("Nome salvo; a base será atualizada na próxima carga.", "warning");
      else app.showToast(nome ? "Nome da pessoa salvo." : "Nome manual removido.", "success");
      document.dispatchEvent(new CustomEvent("simpress:usuarios-equipamento-atualizados"));
    } catch (error) {
      app.showToast(error.message, "error");
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
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
      app.showToast("Pesquise um equipamento antes de informar o usuário.", "warning");
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

  // Edição cadastral em linha do Home (Cockpit v2): só Apelido, Usuário e Login; Local, CEP e CNPJs ficam somente leitura.
  const CAMPOS_CADASTRAIS = {
    apelido: { maxlength: 160, valor: eq => String(eq.apelido || "").trim(), editavel: () => true },
    usuario: {
      maxlength: 160,
      valor: eq => String(eq.usuarios_logados || "").trim(),
      editavel: eq => !String(eq.usuarios_logados || "").trim() || eq.usuarios_logados_origem === "manual",
    },
    login: { maxlength: 300, valor: eq => String(eq.nome_pessoa || "").trim(), editavel: eq => Boolean(eq.nome_pessoa_editavel) },
  };
  const edicaoCadastral = { serial: "", campos: new Map(), salvando: false };

  const formEdicaoCadastral = () => document.getElementById("form-editar-equipamento");
  const gridCadastral = () => document.getElementById("ck-dados-equipamento");

  function contarAlteracoesCadastrais() {
    return [...edicaoCadastral.campos.values()].filter(c => c.input.value.trim() !== c.original).length;
  }

  function atualizarContadorCadastral() {
    let total = 0;
    edicaoCadastral.campos.forEach(({ input, original, dado }) => {
      const alterado = input.value.trim() !== original;
      dado.classList.toggle("ck-dado--alterado", alterado);
      if (alterado) total += 1;
    });
    const texto = total === 0 ? "nenhuma alteração" : `${total} ${total === 1 ? "alteração" : "alterações"}`;
    document.getElementById("ck-dados-edicao-texto").textContent = `Editando dados cadastrais · ${texto}`;
  }

  function restaurarExibicaoCadastral() {
    edicaoCadastral.campos.forEach(({ input, dd, textoOriginal, ocultos }) => {
      input.remove();
      ocultos.forEach(el => el.removeAttribute("hidden"));
      if (textoOriginal !== null) dd.textContent = textoOriginal;
    });
    edicaoCadastral.campos.forEach(({ dado }) => dado.classList.remove("ck-dado--alterado"));
    edicaoCadastral.campos.clear();
    edicaoCadastral.serial = "";
    gridCadastral().classList.remove("ck-dados--editando");
    formEdicaoCadastral().hidden = true;
    const botao = document.getElementById("btn-editar-equipamento");
    botao.setAttribute("aria-pressed", "false");
  }

  function cancelarDadosCadastrais() {
    if (!gridCadastral().classList.contains("ck-dados--editando")) return;
    restaurarExibicaoCadastral();
    document.getElementById("btn-editar-equipamento").focus();
  }

  function editarDadosCadastrais() {
    if (gridCadastral().classList.contains("ck-dados--editando")) {
      cancelarDadosCadastrais();
      return;
    }
    const eq = appState.currentEquipamento;
    if (!eq?.serial) {
      app.showToast("Pesquise um equipamento antes de editar.", "warning");
      return;
    }
    edicaoCadastral.serial = eq.serial;
    Object.entries(CAMPOS_CADASTRAIS).forEach(([nome, regra]) => {
      const dd = gridCadastral().querySelector(`dd[data-campo="${nome}"]`);
      if (!dd || !regra.editavel(eq)) return;
      const dado = dd.closest(".ck-dado");
      const original = regra.valor(eq);
      const input = document.createElement("input");
      input.type = "text";
      input.className = "ck-entrada ck-entrada--sm ck-dado__entrada";
      input.maxLength = regra.maxlength;
      input.value = original;
      input.setAttribute("aria-label", dado.querySelector("dt")?.textContent.trim() || nome);
      input.dataset.campoEdicao = nome;
      const ocultos = [...dd.children].filter(el => !el.hasAttribute("hidden"));
      ocultos.forEach(el => el.setAttribute("hidden", ""));
      // dd só com texto (apelido): guarda o texto para restaurar; os demais escondem os filhos.
      const textoOriginal = dd.children.length ? null : dd.textContent;
      if (textoOriginal !== null) dd.textContent = "";
      dd.appendChild(input);
      input.addEventListener("input", atualizarContadorCadastral);
      edicaoCadastral.campos.set(nome, { input, original, dd, dado, textoOriginal, ocultos });
    });
    gridCadastral().classList.add("ck-dados--editando");
    formEdicaoCadastral().hidden = false;
    document.getElementById("btn-editar-equipamento").setAttribute("aria-pressed", "true");
    atualizarContadorCadastral();
    edicaoCadastral.campos.values().next().value?.input.focus();
  }

  async function salvarDadosCadastrais() {
    if (edicaoCadastral.salvando || !gridCadastral().classList.contains("ck-dados--editando")) return;
    const alterados = [...edicaoCadastral.campos].filter(([, c]) => c.input.value.trim() !== c.original);
    if (!alterados.length) {
      app.showToast("Nenhuma alteração para salvar.", "info");
      return;
    }
    const serial = edicaoCadastral.serial;
    // definirEquipamentoAtual incrementa a revisão; por isso ela é renovada após cada aplicação própria.
    let revisao = appState.equipamentoSelectionRevision;
    const botao = document.getElementById("btn-salvar-dados-cadastrais");
    const textoBotao = botao.textContent;
    edicaoCadastral.salvando = true;
    botao.disabled = true;
    botao.setAttribute("aria-busy", "true");
    botao.textContent = "Salvando...";
    const salvos = [];
    let falhas = 0;
    const aindaSelecionado = () => appState.equipamentoSelectionRevision === revisao
      && String(appState.currentEquipamento?.serial || "").toUpperCase() === String(serial).toUpperCase();
    const enviar = (rota, corpo, erro) => app.apiFetch(rota, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo), errorMessage: erro,
    });
    try {
      for (const [nome, campo] of alterados) {
        const valor = campo.input.value.trim();
        try {
          let data;
          if (nome === "apelido") data = await enviar("/api/equipamento/atualizar-apelido", { serial, apelido: valor }, "Falha ao salvar o apelido.");
          else if (nome === "usuario") data = await enviar("/api/equipamento/atualizar-usuario", { serial, usuario: valor }, "Falha ao salvar o usuário.");
          else {
            data = await enviar("/api/equipamento/nome-pessoa",
              { serial, login_atual: appState.currentEquipamento?.usuarios_logados || "", nome: valor }, "Não foi possível salvar o nome da pessoa.");
            if (data.base_atualizada === false) app.showToast("Nome salvo; a base será atualizada na próxima carga.", "warning");
          }
          salvos.push(nome);
          campo.original = valor;
          if (aindaSelecionado()) {
            app.definirEquipamentoAtual(data.equipamento);
            revisao = appState.equipamentoSelectionRevision;
            if (nome === "apelido") document.getElementById("badge-apelido").textContent = appState.currentEquipamento.apelido || "Sem Apelido";
            app.atualizarIndicadoresPosSalvamento();
            atualizarUsuarioLogadoCard(appState.currentEquipamento);
          }
          if (nome !== "apelido") document.dispatchEvent(new CustomEvent("simpress:usuarios-equipamento-atualizados"));
        } catch (err) {
          falhas += 1;
          console.error("Erro ao salvar dado cadastral:", err);
          app.showToast(err.message || "Falha ao salvar.", "error");
        }
        if (!aindaSelecionado()) break;
      }
    } finally {
      edicaoCadastral.salvando = false;
      botao.disabled = false;
      botao.removeAttribute("aria-busy");
      botao.textContent = textoBotao;
    }
    if (salvos.length) {
      app.showToast("Dados cadastrais salvos.", "success");
      document.dispatchEvent(new CustomEvent("ck:dados-salvos", { detail: { campos: salvos } }));
    }
    if (!falhas || !aindaSelecionado()) {
      restaurarExibicaoCadastral();
      const apelido = document.getElementById("grid-apelido");
      if (aindaSelecionado() && apelido) apelido.textContent = appState.currentEquipamento.apelido || "—";
    } else atualizarContadorCadastral();
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
    atualizarUsuarioLogadoCard, editarUsuarioLogado, salvarUsuarioLogado, limparUsuarioLogado, salvarNomePessoa, editarNomePessoa,
    editarDadosCadastrais, salvarDadosCadastrais, cancelarDadosCadastrais,
  };
});
