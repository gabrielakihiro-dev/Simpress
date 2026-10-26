/** Transfer form: Home/transfer tabs, destination unit, copy helpers, ticket text templates, validation, sheet generation and reset. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).transferForm = factory;
})(typeof window !== "undefined" ? window : globalThis, function createTransferForm(context) {
  "use strict";
  const { app, appState, motion, transferUtils } = context;

  const CNPJ_FATURAMENTO_PADRAO = "75.110.585/0001-00";
  const transferDraftTracker = window.SimpressFormDraftGuard.createDraftTracker();

  function atualizarResumoSerieTransferencia(equipment) {
    const banner = document.getElementById("transfer-equipment-banner");
    const serialValue = document.getElementById("transfer-serial");
    const description = document.getElementById("transfer-equipment-description");
    const serial = String(equipment?.serial || "").trim().toUpperCase();
    const selected = Boolean(serial);

    if (serialValue) serialValue.textContent = serial;
    if (banner) banner.dataset.state = selected ? "selected" : "empty";
    if (description) {
      description.textContent = selected
        ? [equipment.modelo, equipment.tipo].filter(Boolean).join(" · ") || "Equipamento pesquisado e selecionado."
        : "Nenhum equipamento selecionado.";
    }
    const users = document.getElementById("transfer-equipment-users");
    if (users) {
      const logged = String(equipment?.usuarios_logados || "").trim();
      const nome = String(equipment?.nome_pessoa || "").trim();
      users.textContent = selected ? [logged ? `Usuários logados: ${logged}` : "", nome ? `Nome: ${nome}` : ""].filter(Boolean).join(" · ") : "";
      users.classList.toggle("hidden", !users.textContent);
    }
  }

  function campoRastreavelTransferencia(target) {
    if (!target || target.id === "input-serial" || !target.matches?.("input, select, textarea")) return null;
    const panel = document.getElementById("tab-panel-retirada-entrega");
    return panel?.contains(target) ? target : null;
  }

  document.addEventListener("focusin", event => {
    const field = campoRastreavelTransferencia(event.target);
    if (field) transferDraftTracker.capture(field.id, field.value);
  });

  document.addEventListener("beforeinput", event => {
    const field = campoRastreavelTransferencia(event.target);
    if (field) transferDraftTracker.capture(field.id, field.value);
  }, true);

  ["input", "change"].forEach(eventName => {
    document.addEventListener(eventName, event => {
      const field = campoRastreavelTransferencia(event.target);
      if (field) transferDraftTracker.update(field.id, field.value);
    }, true);
  });

  // Abas de primeiro nível: Home, Transporte, Resumo e Automação (nessa ordem na barra lateral).
  const ABAS_PRINCIPAIS = Object.freeze({
    home: Object.freeze({ tab: "tab-home", painel: "tab-panel-home", titulo: "Home" }),
    transferencia: Object.freeze({ tab: "tab-retirada-entrega", painel: "tab-panel-retirada-entrega", titulo: "Transporte" }),
    resumo: Object.freeze({ tab: "tab-resumo", painel: "tab-panel-resumo", titulo: "Resumo" }),
    automacao: Object.freeze({ tab: "tab-automacao", painel: "tab-panel-automacao", titulo: "Automação" }),
  });

  function ativarAbaTransferencia(aba) {
    app.fecharPainelCockpit?.(false);
    const alvo = ABAS_PRINCIPAIS[aba] ? aba : "transferencia";
    const abas = Object.entries(ABAS_PRINCIPAIS).map(([nome, ids]) => ({
      nome,
      tab: document.getElementById(ids.tab),
      painel: document.getElementById(ids.painel),
    }));
    const home = abas.find(item => item.nome === "home");
    const transferencia = abas.find(item => item.nome === "transferencia");
    if (!home.tab || !transferencia.tab || !home.painel || !transferencia.painel) return;

    const destino = abas.find(item => item.nome === alvo);
    const mudou = Boolean(destino.painel?.hidden);
    abas.forEach(({ nome, tab, painel }) => {
      const ativa = nome === alvo;
      if (painel) painel.hidden = !ativa;
      if (tab) {
        tab.setAttribute("aria-selected", String(ativa));
        tab.tabIndex = ativa ? 0 : -1;
        tab.classList.toggle("is-active", ativa);
      }
    });
    const titulo = document.getElementById("header-page-title");
    if (titulo) titulo.textContent = ABAS_PRINCIPAIS[alvo].titulo;
    document.body.classList.toggle("has-quick-actions", alvo === "transferencia");
    if (alvo === "transferencia") app.atualizarResumoSerieTransferencia(appState.currentEquipamento);
    if (alvo === "resumo" && mudou) void app.carregarResumoCockpit?.();
    if (mudou && destino.painel) motion?.reveal(destino.painel, "page");
  }

  function abrirAbaTransporteDoEquipamento() {
    const painelTransporte = document.getElementById("tab-panel-retirada-entrega");
    if (!painelTransporte) return;

    app.ativarAbaTransferencia("transferencia");
    painelTransporte.focus();
  }

  function abrirHomeParaPesquisarEquipamento() {
    if (String(appState.currentEquipamento?.serial || "").trim()) return;

    app.ativarAbaTransferencia("home");
    document.getElementById("input-serial")?.focus();
  }

  function controlarAbasTransferencia(event) {
    const tablist = event.target.closest('[role="tablist"]') || event.currentTarget;
    const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
    const currentIndex = tabs.indexOf(event.target.closest('[role="tab"]'));
    if (currentIndex < 0 || !tabs.length) return;

    let nextIndex = currentIndex;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (currentIndex + 1) % tabs.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    else return;

    event.preventDefault();
    const nextTab = tabs[nextIndex];
    nextTab.focus();
    nextTab.click();
  }

  // "Forçar SEDE Prado Velho" button action
  function forcarSedePradoVelho() {
    const sede = appState.unidadesList.find(unit => unit.is_sede);
    appState.retiradaCidadeSelecionada = "Curitiba";
    document.getElementById("retirada-cnpj").value = sede?.cnpj || "";
    document.getElementById("retirada-endereco").value = "R Caeté, 150 - SEDE - Prado Velho - Curitiba/PR - CEP 80220-300";
    app.preencherRepresentanteRegional("retirada", "Curitiba");
    app.showToast("Origem alterada para SEDE Prado Velho (Curitiba).", "info");
  }

  // Handle Unidade de Destino Selection
  function atualizarEstadoCopiaCnpjEntrega() {
    const unidadeId = document.getElementById("select-unidade-destino")?.value;
    const unidadeDestino = appState.unidadesList.find(unit => String(unit.id) === String(unidadeId));
    const botao = document.getElementById("btn-copiar-cnpj-instalacao-entrega");
    if (botao) botao.disabled = !String(unidadeDestino?.cnpj || "").trim();
  }

  function handleUnidadeDestinoChange(unitId, notificar = true) {
    app.atualizarEstadoCopiaCnpjEntrega();
    if (!unitId) {
      app.preencherRepresentanteRegional("entrega", "");
      return;
    }
    const unit = appState.unidadesList.find(u => String(u.id) === String(unitId));
    if (unit) {
      document.getElementById("entrega-cnpj").value = unit.cnpj || "";
      document.getElementById("entrega-endereco").value = unit.endereco_completo || "";
      app.preencherRepresentanteRegional("entrega", unit.cidade || "");
      if (notificar) app.showToast(`Destino definido: ${unit.cidade}`, "info");
    }
  }

  function selecionarUnidadePorCidade(cidadeNome) {
    const unit = appState.unidadesList.find(u => u.cidade.toLowerCase().includes(cidadeNome.toLowerCase()));
    if (unit) {
      document.getElementById("select-unidade-destino").value = unit.id;
      app.handleUnidadeDestinoChange(unit.id);
    }
  }

  function adicionarObsChamado(texto) {
    const textarea = document.getElementById("entrega-obs");
    if (textarea.value.trim().length > 0) {
      textarea.value += " " + texto;
    } else {
      textarea.value = texto;
    }
  }

  async function copiarModeloChamado(textareaId) {
    const textarea = document.getElementById(textareaId);
    const texto = String(textarea?.value || "").trim();
    if (!texto) {
      app.showToast("O texto do modelo está vazio.", "warning");
      return;
    }

    try {
      await app.copiarTextoParaAreaTransferencia(texto);
      app.showToast("Texto copiado. Você pode colá-lo no chamado manualmente.", "success");
    } catch (err) {
      app.showToast("Não foi possível copiar o texto. Selecione e copie o conteúdo manualmente.", "error");
    }
  }

  function alternarVisualizacaoModelo(botao) {
    const previewId = botao.getAttribute("aria-controls");
    const preview = document.getElementById(previewId);
    const label = botao.querySelector("span");
    if (!preview || !label) return;

    const mostrar = preview.hidden;
    preview.hidden = !mostrar;
    botao.setAttribute("aria-expanded", String(mostrar));
    label.textContent = mostrar ? "Ocultar Texto" : "Mostrar Texto";
  }

  function recolherVisualizacoesModelosChamado() {
    const pill = document.querySelector('.ck-modelo-aba[aria-selected="true"]');
    let selectedType = "";
    try {
      selectedType = JSON.parse(pill?.dataset?.args || "[]")[0] || "";
    } catch (error) {
      selectedType = "";
    }
    if (pill && selectedType) {
      app.alternarChamadosManuais(selectedType);
      return;
    }
    const conteudoChamados = document.getElementById("ticket-templates-content");
    const botaoChamados = document.getElementById("btn-toggle-ticket-templates");
    const rotuloBotaoChamados = botaoChamados?.querySelector("span");
    if (conteudoChamados) conteudoChamados.hidden = true;
    if (botaoChamados) botaoChamados.setAttribute("aria-expanded", "false");
    if (rotuloBotaoChamados) rotuloBotaoChamados.textContent = "Mostrar textos para chamados";

    document.querySelectorAll(".ticket-template-preview").forEach(preview => {
      preview.hidden = true;
    });
    document.querySelectorAll(".ticket-template-toggle").forEach(botao => {
      botao.setAttribute("aria-expanded", "false");
      const label = botao.querySelector("span");
      if (label) label.textContent = "Mostrar Texto";
    });
  }

  function alternarChamadosManuais(tipo) {
    const pills = document.querySelectorAll(".ck-modelo-aba");
    if (pills.length) {
      const selected = tipo || "deslocamento";
      const content = document.getElementById("ticket-templates-content");
      content.hidden = false;
      pills.forEach(pill => {
        let pillType = "";
        try {
          pillType = JSON.parse(pill.dataset.args || "[]")[0] || "";
        } catch (error) {
          pillType = "";
        }
        const active = pillType === selected;
        pill.setAttribute("aria-selected", String(active));
        pill.tabIndex = active ? 0 : -1;
        // Ponto da aba: cheio = texto sem campo em branco; anel = ainda há [campo] ou "Rótulo:" vazio.
        const dot = pill.querySelector?.(".ck-prontidao");
        const text = document.getElementById(`texto-chamado-${pillType}`)?.value;
        if (dot?.dataset && typeof text === "string") dot.dataset.status = /\[[^\]]*\]|:[ ]*$/m.test(text) ? "alerta" : "ok";
      });
      document.querySelectorAll(".ck-chamado__painel").forEach(preview => {
        preview.hidden = preview.id !== `visualizacao-chamado-${selected}`;
      });
      document.getElementById("btn-copiar-chamado-atual").dataset.args = JSON.stringify([`texto-chamado-${selected}`]);
      document.getElementById("btn-toggle-ticket-templates")?.setAttribute("aria-expanded", "true");
      return;
    }
    const conteudo = document.getElementById("ticket-templates-content");
    const botao = document.getElementById("btn-toggle-ticket-templates");
    const rotulo = botao?.querySelector("span");
    if (!conteudo || !botao || !rotulo) return;

    const mostrar = conteudo.hidden;
    conteudo.hidden = !mostrar;
    botao.setAttribute("aria-expanded", String(mostrar));
    rotulo.textContent = mostrar ? "Ocultar textos para chamados" : "Mostrar textos para chamados";
  }

  // Build Payload Object from Form
  function construirPayload() {
    const serialInput = document.getElementById("input-serial");
    const serialVal = transferUtils.serialForTransfer(appState.currentEquipamento, serialInput.value);
    if (!serialVal) {
      app.showToast("Pesquise e selecione o equipamento correto antes de gerar a transferência.", "warning");
      serialInput.focus();
      return null;
    }

    const entregaContato = document.getElementById("entrega-contato").value.trim();
    if (!entregaContato) {
      app.showToast("Preencha o campo obrigatório “Nome do destinatário”.", "warning");
      document.getElementById("entrega-contato").focus();
      return null;
    }

    const entregaCnpj = document.getElementById("entrega-cnpj").value.trim();
    const entregaEndereco = document.getElementById("entrega-endereco").value.trim();
    const unidadeDestino = appState.unidadesList.find(
      unit => String(unit.id) === String(document.getElementById("select-unidade-destino").value)
    );
    if (!entregaCnpj || !entregaEndereco) {
      app.showToast("Selecione uma unidade de destino para preencher automaticamente o CNPJ e o endereço de entrega.", "warning");
      document.getElementById("select-unidade-destino").focus();
      return null;
    }

    const retiradaTelefone = document.getElementById("retirada-telefone");
    const entregaTelefone = document.getElementById("entrega-telefone");
    retiradaTelefone.value = app.formatarTelefoneBrasileiro(retiradaTelefone.value);
    entregaTelefone.value = app.formatarTelefoneBrasileiro(entregaTelefone.value);

    return {
      serial: serialVal,
      descricao_equipamento: "",
      razao_social: "SERVICO DE APOIO AS MICRO E PEQUENAS EMPRESAS DO PARANA - SEBRAE/PR",
      contrato: 16467,
      retirada_cidade: appState.retiradaCidadeSelecionada,
      retirada_cnpj: document.getElementById("retirada-cnpj").value.trim(),
      retirada_endereco: document.getElementById("retirada-endereco").value.trim(),
      retirada_horario: document.getElementById("retirada-horario").value.trim(),
      retirada_almoco: document.getElementById("retirada-almoco").value.trim(),
      retirada_pausa_duracao: document.getElementById("retirada-pausa-duracao").value.trim(),
      retirada_tipo_acesso: document.getElementById("retirada-tipo-acesso").value.trim(),
      retirada_acesso_obs: "",
      retirada_contato: document.getElementById("retirada-contato").value.trim(),
      retirada_email: document.getElementById("retirada-email").value.trim(),
      retirada_telefone: retiradaTelefone.value.trim(),
      retirada_obs: document.getElementById("retirada-obs").value.trim(),
      retirada_voltagem: document.getElementById("retirada-voltagem").value.trim(),
      entrega_cidade: unidadeDestino?.cidade || "",
      entrega_cnpj: entregaCnpj,
      entrega_endereco: entregaEndereco,
      entrega_horario: document.getElementById("entrega-horario").value.trim(),
      entrega_almoco: document.getElementById("entrega-almoco").value.trim(),
      entrega_pausa_duracao: document.getElementById("entrega-pausa-duracao").value.trim(),
      entrega_tipo_acesso: "Elevador / Rampa / Térreo",
      entrega_acesso_obs: "",
      entrega_contato: entregaContato,
      entrega_email: document.getElementById("entrega-email").value.trim(),
      entrega_telefone: entregaTelefone.value.trim(),
      entrega_obs: document.getElementById("entrega-obs").value.trim(),
      entrega_voltagem: "Bivolt"
    };
  }

  // Format Structured Text for Helpdesk Ticket
  function gerarTextoResumo(payload) {
    const modelo = appState.currentEquipamento ? appState.currentEquipamento.modelo : "Equipamento";
    const tipo = appState.currentEquipamento ? appState.currentEquipamento.tipo : "Geral";
    const apelido = appState.currentEquipamento ? appState.currentEquipamento.apelido : "-";
    const idCliente = appState.currentEquipamento ? appState.currentEquipamento.idCliente : "-";

    return `📋 RESUMO DE TRANSFERÊNCIA DE EQUIPAMENTO - SIMPRESS / SEBRAE-PR
======================================================================
• Equipamento: ${modelo} (${tipo})
• Número de Série: ${payload.serial}
• Apelido / Id Cliente: ${apelido} / ${idCliente}
📍 DADOS DE RETIRADA (ORIGEM):
• Endereço: ${payload.retirada_endereco}
• CNPJ: ${payload.retirada_cnpj}
• Contato Suporte: ${payload.retirada_contato}
• E-mail / Telefone: ${payload.retirada_email} | ${payload.retirada_telefone}
• Expediente / Almoço: ${payload.retirada_horario} (Pausa: ${payload.retirada_almoco}, ${payload.retirada_pausa_duracao})
• Observações Retirada: ${payload.retirada_obs || 'Sem observações adicionais'}

🎯 DADOS DE ENTREGA (DESTINO):
• Endereço: ${payload.entrega_endereco}
• CNPJ: ${payload.entrega_cnpj}
• Destinatário: ${payload.entrega_contato}
• E-mail Destinatário: ${payload.entrega_email || 'Não informado'}
• Telefone Destinatário: ${payload.entrega_telefone || 'Não informado'}
• Expediente / Almoço: ${payload.entrega_horario} (Pausa: ${payload.entrega_almoco}, ${payload.entrega_pausa_duracao})
• Observações do Chamado: ${payload.entrega_obs || 'Sem observações adicionais'}

🚚 INFORMAÇÕES LOGÍSTICAS & CONTRATO:
• Contrato: 16467 - Simpress / SEBRAE-PR
• Voltagem: Bivolt
• Tipo de Acesso: Elevador / Rampa / Térreo
======================================================================`;
  }

  function atualizarPreviaTransporteCockpit() {
    const root = document.querySelector(".cockpit-transport-layout");
    if (!root) return;
    const value = id => {
      const element = document.getElementById(id);
      const raw = element && "value" in element ? element.value : element?.textContent;
      return String(raw || "").trim() || "—";
    };
    const set = (id, text) => {
      const target = document.getElementById(id);
      if (target) target.textContent = text;
    };
    const equipamento = appState.currentEquipamento;
    const unidade = document.getElementById("select-unidade-destino");
    const destino = unidade?.selectedOptions?.[0]?.textContent?.trim();
    const serial = equipamento?.serial || value("transfer-serial");
    const modelo = equipamento?.modelo || value("card-modelo");
    const apelido = equipamento?.apelido || "";
    set("cockpit-preview-equipment", [serial, modelo, apelido].filter(item => item && item !== "—").join(" · ") || "—");
    set("cockpit-preview-pickup", appState.retiradaCidadeSelecionada || value("retirada-endereco"));
    set("cockpit-preview-pickup-cnpj", value("retirada-cnpj"));
    set("cockpit-preview-contact", [value("retirada-contato"), value("retirada-telefone")].filter(item => item !== "—").join(" · ") || "—");
    set("cockpit-preview-hours", [value("retirada-horario"), `almoço ${value("retirada-almoco")}`].filter(item => item !== "—").join(" · ") || "—");
    set("cockpit-preview-delivery", value("entrega-endereco") !== "—" ? value("entrega-endereco") : (unidade?.value ? destino : "—"));
    set("cockpit-preview-recipient", [value("entrega-contato"), value("entrega-telefone")].filter(item => item !== "—").join(" · ") || "—");
    set("cockpit-preview-notes", value("entrega-obs"));
    const state = document.getElementById("cockpit-transport-preview-state");
    if (state) {
      state.textContent = equipamento ? (unidade?.value ? "Prévia atualizada" : "Selecione a entrega") : "Aguardando equipamento";
      state.dataset.state = equipamento ? (unidade?.value ? "ready" : "pending") : "empty";
    }
  }

  async function copiarResumoCockpit() {
    const payload = construirPayload();
    if (!payload) return;
    try {
      await app.copiarTextoParaAreaTransferencia(gerarTextoResumo(payload));
      app.showToast("Resumo copiado para a área de transferência.", "success");
    } catch (error) {
      app.showToast("Não foi possível copiar o resumo. Abra o texto para Transporte e tente novamente.", "error");
    }
  }

  const transportPreviewRoot = document.querySelector(".cockpit-transport-layout");
  if (transportPreviewRoot && !transportPreviewRoot.dataset.previewBound) {
    transportPreviewRoot.dataset.previewBound = "true";
    transportPreviewRoot.addEventListener("input", atualizarPreviaTransporteCockpit);
    transportPreviewRoot.addEventListener("change", atualizarPreviaTransporteCockpit);
    atualizarPreviaTransporteCockpit();
  }

  // Modal Preview Handlers
  function abrirModalPreview() {
    const payload = construirPayload();
    if (!payload) return;

    const texto = gerarTextoResumo(payload);
    document.getElementById("textarea-resumo-preview").value = texto;
    app.abrirModalAcessivel("modal-preview", "#textarea-resumo-preview", "fecharModalPreview");
  }

  function fecharModalPreview() {
    app.fecharModalAcessivel("modal-preview");
  }

  function copiarTextoDoModal() {
    const texto = document.getElementById("textarea-resumo-preview").value;
    navigator.clipboard.writeText(texto).then(() => {
      app.showToast("Resumo copiado para a área de transferência.", "success");
    }).catch(err => {
      app.showToast("Erro ao copiar texto: " + err, "error");
    });
  }

  function cidadeComUf(cidade) {
    const valor = String(cidade || "").trim();
    if (!valor) return "";
    if (/\/\s*PR$/i.test(valor)) return valor.replace(/\s*\/\s*PR$/i, "/PR");
    return `${valor}/PR`;
  }

  function gerarTextoSolicitacaoTransporte() {
    const retiradaEndereco = document.getElementById("retirada-endereco").value.trim();
    const entregaEndereco = document.getElementById("entrega-endereco").value.trim();
    const unidadeDestino = appState.unidadesList.find(
      unit => String(unit.id) === String(document.getElementById("select-unidade-destino").value)
    );
    const retiradaCidade = cidadeComUf(appState.retiradaCidadeSelecionada);
    const entregaCidade = cidadeComUf(unidadeDestino?.cidade);

    if (!retiradaEndereco || !entregaEndereco) {
      app.showToast("Selecione o equipamento de origem e a unidade de destino para carregar os endereços.", "warning");
      return;
    }
    if (!retiradaCidade || !entregaCidade) {
      app.showToast("Não foi possível identificar as cidades de origem e destino.", "warning");
      return;
    }

    const texto = `Prezados,\n\nSolicito o transporte do equipamento da unidade do Sebrae de ${retiradaCidade} para a unidade do Sebrae de ${entregaCidade}\n\nO transporte dos equipamentos é previsto em edital e de responsabilidade da Simpress.\n\nEndereço para Retirada: ${retiradaEndereco}\nEndereço para Entrega: ${entregaEndereco}`;
    document.getElementById("textarea-texto-transporte").value = texto;
    app.abrirModalAcessivel("modal-texto-transporte", "#textarea-texto-transporte", "fecharModalTextoTransporte");
  }

  function fecharModalTextoTransporte() {
    app.fecharModalAcessivel("modal-texto-transporte");
  }

  async function copiarSerieAtual() {
    const serial = String(appState.currentEquipamento?.serial || "").trim();
    if (!serial) {
      app.showToast("Pesquise um equipamento antes de copiar a série.", "warning");
      return;
    }

    try {
      await app.copiarTextoParaAreaTransferencia(serial);
      app.showToast(`Série ${serial} copiada para a área de transferência.`, "success");
    } catch (err) {
      app.showToast("Não foi possível copiar a série. Selecione o texto e copie com Ctrl+C.", "error");
    }
  }

  function obterCepRetiradaSelecionada() {
    const endereco = document.getElementById("retirada-endereco")?.value || "";
    const cepNoEndereco = endereco.match(/\bCEP\b\s*:?\s*(\d{5}-?\d{3})/i);
    return cepNoEndereco?.[1] || appState.currentEquipamento?.retirada_cep || "";
  }

  async function copiarDadoLocalAtual(tipo) {
    const dados = {
      cep: { valor: obterCepRetiradaSelecionada(), nome: "CEP" },
      faturamento: { valor: CNPJ_FATURAMENTO_PADRAO, nome: "CNPJ de faturamento" },
      instalacao: {
        valor: document.getElementById("retirada-cnpj")?.value || "",
        nome: "CNPJ de instalação"
      }
    };
    const dado = dados[tipo];
    if (!dado) return;

    const valor = String(dado.valor || "").trim();
    if (!valor) {
      app.showToast(`Pesquise um equipamento com ${dado.nome.toLowerCase()} informado antes de copiar.`, "warning");
      return;
    }

    try {
      await app.copiarTextoParaAreaTransferencia(valor);
      app.showToast(`${dado.nome} copiado para a área de transferência.`, "success");
    } catch (err) {
      app.showToast(`Não foi possível copiar o ${dado.nome.toLowerCase()}.`, "error");
    }
  }

  async function copiarDadoEntrega(tipo) {
    const unidadeId = document.getElementById("select-unidade-destino")?.value;
    const unidadeDestino = appState.unidadesList.find(unit => String(unit.id) === String(unidadeId));
    const dados = {
      faturamento: { valor: CNPJ_FATURAMENTO_PADRAO, nome: "CNPJ de faturamento" },
      instalacao: { valor: unidadeDestino?.cnpj || "", nome: "CNPJ de instalação" }
    };
    const dado = dados[tipo];
    if (!dado) return;

    const valor = String(dado.valor || "").trim();
    if (!valor) {
      app.showToast("Selecione uma unidade de destino antes de copiar o CNPJ de instalação.", "warning");
      return;
    }

    try {
      await app.copiarTextoParaAreaTransferencia(valor);
      const unidade = tipo === "instalacao"
        ? ` de ${unidadeDestino.cidade || "unidade selecionada"}`
        : " da entrega";
      app.showToast(`${dado.nome}${unidade} copiado para a área de transferência.`, "success");
    } catch (err) {
      app.showToast(`Não foi possível copiar o ${dado.nome.toLowerCase()} da entrega.`, "error");
    }
  }

  async function copiarTextoSolicitacaoTransporte() {
    const texto = document.getElementById("textarea-texto-transporte").value;
    if (!texto.trim()) {
      app.showToast("Gere o texto da solicitação antes de copiar.", "warning");
      return;
    }

    try {
      await app.copiarTextoParaAreaTransferencia(texto);
      app.showToast("Texto da solicitação copiado para a área de transferência.", "success");
    } catch (err) {
      app.showToast("Não foi possível copiar o texto. Selecione-o e copie com Ctrl+C.", "error");
    }
  }

  function validarCamposObrigatoriosPlanilha() {
    app.atualizarObrigatoriedadeDuracaoPausaEntrega();
    const campos = [
      { id: "retirada-contato", nome: "Nome do contato na retirada" },
      { id: "retirada-email", nome: "E-mail do contato na retirada" },
      { id: "retirada-telefone", nome: "Celular" },
      { id: "retirada-obs", nome: "Observações" },
      { id: "entrega-email", nome: "E-mail do Destinatário" },
      { id: "entrega-telefone", nome: "Celular" },
      { id: "entrega-horario", nome: "Expediente da unidade de entrega" },
      { id: "entrega-almoco", nome: "Horário de almoço da unidade de entrega" },
      { id: "entrega-obs", nome: "Observações" }
    ];
    if (!app.entregaAlmocoNaoFecha()) {
      campos.push({ id: "entrega-pausa-duracao", nome: "Duração da pausa da unidade de entrega" });
    }

    const campoVazio = campos.find(({ id }) => !document.getElementById(id).value.trim());
    if (campoVazio) {
      const input = document.getElementById(campoVazio.id);
      app.showToast(`Preencha o campo obrigatório “${campoVazio.nome}” para gerar a planilha oficial.`, "warning");
      input.focus();
      input.scrollIntoView({ behavior: "smooth", block: "center" });
      return false;
    }

    for (const id of ["retirada-email", "entrega-email"]) {
      const email = document.getElementById(id);
      if (email.checkValidity()) {
        email.removeAttribute("aria-invalid");
        continue;
      }
      email.setAttribute("aria-invalid", "true");
      app.showToast("Corrija o formato do endereço de e-mail antes de gerar a planilha.", "warning");
      email.focus();
      email.scrollIntoView({ behavior: "smooth", block: "center" });
      return false;
    }
    return true;
  }

  // Generate & Download Official Excel Sheet
  async function gerarPlanilhaExcel() {
    const payload = construirPayload();
    if (!payload) return;
    if (!app.validarCamposObrigatoriosPlanilha()) return;

    const btn = document.getElementById("btn-gerar-planilha");
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i><span>Gerando Planilha...</span>`;
    lucide.createIcons({ root: btn });

    try {
      const res = await app.apiFetch("/api/gerar-planilha", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        responseType: "response",
        errorMessage: "Falha ao gerar o arquivo Excel no servidor.",
      });

      // Get Filename from Header
      const filenameSerial = String(payload.serial || "").replace(/[^\w-]/g, "_");
      const filenameCity = (value) => String(value || "CidadeNaoInformada")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^A-Za-z0-9]/g, "") || "CidadeNaoInformada";
      let filename = `Transferencia_${filenameSerial}_${filenameCity(payload.retirada_cidade)}-${filenameCity(payload.entrega_cidade)}.xlsx`;
      const disposition = res.headers.get("Content-Disposition");
      if (disposition && disposition.indexOf("filename=") !== -1) {
        const matches = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(disposition);
        if (matches != null && matches[1]) {
          filename = matches[1].replace(/['"]/g, '');
        }
      }

      // Download Blob
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.style.display = "none";
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();

      app.showToast("Planilha Exportada com Sucesso!", "success");
      emitirEventoInterface("simpress:transfer-generated", { payload });

    } catch (err) {
      console.error("Erro ao gerar planilha:", err);
      app.showToast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
      btn.innerHTML = originalText;
      lucide.createIcons({ root: btn });
    }
  }

  async function resetarFormulario() {
    const query = document.getElementById("input-serial").value.trim();
    if ((transferDraftTracker.isDirty() || appState.currentEquipamento || query)
        && !(await app.confirmarAcao({
          titulo: "Descartar esta transferência?",
          mensagem: "Há dados preenchidos nesta transferência. Deseja descartar o rascunho e começar outra?",
          confirmar: "Descartar e começar outra",
          cancelar: "Continuar editando",
        }))) {
      return;
    }
    transferDraftTracker.reset();
    app.invalidarBuscasEquipamento();
    app.limparSelecaoEquipamento();
    document.getElementById("input-serial").value = "";
    document.getElementById("btn-clear-serial").classList.add("hidden");
    document.getElementById("card-equipamento").classList.add("hidden");

    // Reset Retirada
    document.getElementById("retirada-cnpj").value = "";
    document.getElementById("retirada-endereco").value = "";
    document.getElementById("retirada-obs").value = "";

    // Reset Entrega
    document.getElementById("select-unidade-destino").value = "";
    document.getElementById("entrega-cnpj").value = "";
    document.getElementById("entrega-endereco").value = "";
    document.getElementById("entrega-representante").value = "";
    document.getElementById("entrega-contato").value = "";
    document.getElementById("entrega-email").value = "";
    document.getElementById("entrega-telefone").value = "";
    document.getElementById("entrega-obs").value = "";
    app.atualizarEstadoCopiaCnpjEntrega();
    app.preencherRepresentanteRegional("entrega", "");
    app.preencherRepresentanteRegional("retirada", "");

    // Reset status indicator
    document.getElementById("status-indicator").className = "w-2.5 h-2.5 rounded-full bg-brand-400";
    document.getElementById("status-summary").innerHTML = `
        <span class="text-fg-tertiary font-medium" data-ux-ready-status>Pronto para emissão.</span>
      `;

    app.showToast("Formulário limpo. Pronto para uma nova busca.", "info");
    app.ativarAbaTransferencia("home");
    document.getElementById("input-serial").focus();
    emitirEventoInterface("simpress:form-reset");
  }

  // Optional hook for progressive enhancements; never affects the main flow.
  function emitirEventoInterface(tipo, detalhe = {}) {
    try {
      if (typeof document.dispatchEvent === "function" && typeof window.CustomEvent === "function") {
        document.dispatchEvent(new window.CustomEvent(tipo, { detail: detalhe }));
      }
    } catch (error) {
      // Enhancements are optional.
    }
  }

  return {
    atualizarResumoSerieTransferencia, ativarAbaTransferencia, abrirAbaTransporteDoEquipamento,
    abrirHomeParaPesquisarEquipamento, controlarAbasTransferencia, forcarSedePradoVelho,
    atualizarEstadoCopiaCnpjEntrega, handleUnidadeDestinoChange, selecionarUnidadePorCidade, adicionarObsChamado,
    copiarModeloChamado, alternarVisualizacaoModelo, recolherVisualizacoesModelosChamado, alternarChamadosManuais,
    abrirModalPreview, fecharModalPreview, copiarTextoDoModal, gerarTextoSolicitacaoTransporte,
    atualizarPreviaTransporteCockpit, copiarResumoCockpit,
    fecharModalTextoTransporte, copiarSerieAtual, copiarDadoLocalAtual, copiarDadoEntrega,
    copiarTextoSolicitacaoTransporte, validarCamposObrigatoriosPlanilha, gerarPlanilhaExcel, resetarFormulario,
  };
});
