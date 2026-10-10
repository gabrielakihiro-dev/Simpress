    // State
    let currentEquipamento = null;
    let inventoryUploadAttempt = null;
    const inventoryRestoreAttempts = new Map();
    const inventoryOperationKey = () => globalThis.crypto?.randomUUID?.()
      || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    let equipamentoSelectionRevision = 0;
    const CNPJ_FATURAMENTO_PADRAO = "75.110.585/0001-00";
    let retiradaCidadeSelecionada = "";
    let unidadesList = [];
    let acompanhamentoChamadosAtual = null;
    let historicoAcompanhamentoChamados = [];
    let debounceTimer = null;
    const transferUtils = window.SimpressTransferUtils;
    const catalogSearch = window.SimpressCatalogSearch;
    const transferDraftTracker = window.SimpressFormDraftGuard.createDraftTracker();
    const autocompleteRequestGate = transferUtils.createRequestGate();
    const equipmentLookupRequestGate = transferUtils.createRequestGate();
    const searchButtonInitialHtml = document.getElementById("btn-buscar-serial")?.innerHTML || "";
    let comparisonAnnotationSyncObservers = [];
    const motion = window.SimpressMotion;
    let finishEquipmentLoading = () => {};
    const accessibleDialogs = window.SimpressAccessibleDialogs({
      document, window, motion, HTMLElement,
      requestAnimationFrame: callback => requestAnimationFrame(callback),
      lucide,
    });
    const notifications = window.SimpressNotifications({ document, window, lucide, motion, createIcon });
    motion?.installFeedback();
    window.HistoryAnnotationAutosave.installPendingNavigationGuard(window);

    function atualizarResumoSerieTransferencia(equipment) {
      const banner = document.getElementById("transfer-equipment-banner");
      const serialInput = document.getElementById("transfer-serial");
      const description = document.getElementById("transfer-equipment-description");
      const status = document.getElementById("transfer-serial-status");
      const serial = String(equipment?.serial || "").trim().toUpperCase();
      const selected = Boolean(serial);

      if (serialInput) serialInput.value = serial;
      if (banner) banner.dataset.state = selected ? "selected" : "empty";
      if (description) {
        description.textContent = selected
          ? [equipment.modelo, equipment.tipo].filter(Boolean).join(" · ") || "Equipamento pesquisado e selecionado."
          : "Pesquise e selecione um equipamento na aba Home para preencher a série.";
      }
      if (status) status.textContent = selected ? "Copiar" : "Aguardando";
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

    function definirEquipamentoAtual(equipment) {
      currentEquipamento = equipment;
      equipamentoSelectionRevision += 1;
      atualizarResumoSerieTransferencia(equipment);
      const copySerialButton = document.getElementById("btn-copiar-serie");
      const hasSerial = Boolean(String(equipment?.serial || "").trim());
      if (copySerialButton) {
        copySerialButton.disabled = !hasSerial;
        copySerialButton.setAttribute("aria-disabled", String(!hasSerial));
      }
    }

    function limparSelecaoEquipamento() {
      definirEquipamentoAtual(null);
      retiradaCidadeSelecionada = "";
      document.getElementById("card-equipamento")?.classList.add("hidden");
      document.getElementById("retirada-cnpj").value = "";
      document.getElementById("retirada-endereco").value = "";
      document.getElementById("retirada-obs").value = "";
      ["textarea-resumo-preview", "textarea-texto-transporte"].forEach(id => {
        const field = document.getElementById(id);
        if (field) field.value = "";
      });
      preencherRepresentanteRegional("retirada", "");
      const indicator = document.getElementById("status-indicator");
      if (indicator) indicator.className = "w-2.5 h-2.5 rounded-full bg-brand-400";
      const summary = document.getElementById("status-summary");
      if (summary) summary.replaceChildren(
        createTextElement("span", "text-slate-300 font-medium", "Pronto para emissão."),
        createTextElement("span", "text-slate-500", " Verifique os dados antes de gerar a planilha oficial Simpress.")
      );
    }

    function invalidarBuscasEquipamento() {
      finishEquipmentLoading();
      clearTimeout(debounceTimer);
      autocompleteRequestGate.invalidate();
      equipmentLookupRequestGate.invalidate();
      const autocomplete = document.getElementById("autocomplete-box");
      autocomplete?.setAttribute("aria-busy", "false");
      document.getElementById("input-serial")?.removeAttribute("aria-busy");
      const button = document.getElementById("btn-buscar-serial");
      if (button) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        button.innerHTML = searchButtonInitialHtml;
        lucide.createIcons({ root: button });
      }
    }

    function invalidarDadosEquipamentoAposRestauracao() {
      const serialInput = document.getElementById("input-serial");
      if (serialInput) serialInput.value = "";
      document.getElementById("btn-clear-serial")?.classList.add("hidden");
      invalidarBuscasEquipamento();
      limparSelecaoEquipamento();
      fecharAutocomplete();
    }

    async function atualizarSelecaoAposSubstituirInventarios(serialSelecionada) {
      fecharAutocomplete();
      return transferUtils.refreshSelectionAfterInventoryReplacement({
        requestGate: equipmentLookupRequestGate,
        serial: serialSelecionada,
        invalidateSearches: invalidarBuscasEquipamento,
        clearSelection: clearSerial => {
          limparSelecaoEquipamento();
          if (!serialSelecionada || clearSerial) {
            const serialInput = document.getElementById("input-serial");
            if (serialInput) serialInput.value = "";
            document.getElementById("btn-clear-serial")?.classList.add("hidden");
          }
        },
        fetchEquipment: (serial, options) => fetch(
          `/api/equipamento/${encodeURIComponent(serial)}`,
          options,
        ),
        applyEquipment: equipment => {
          definirEquipamentoAtual(equipment);
          exibirEquipamento(equipment);
        },
      });
    }

    const inputSerialInicial = document.getElementById("input-serial");
    if (inputSerialInicial && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      inputSerialInicial.focus({ preventScroll: true });
    }

    function abrirModalAcessivel(modalId, initialFocusSelector, closeFunction) {
      accessibleDialogs.open(modalId, initialFocusSelector, closeFunction);
    }

    function fecharModalAcessivel(modalId) {
      accessibleDialogs.close(modalId);
    }

    function associarRotulosAcessiveis() {
      accessibleDialogs.associateLabels();
    }

    // Phone field formatting
    function formatarTelefoneBrasileiro(valor) {
      return transferUtils.formatBrazilPhone(valor);
    }

    const REPRESENTANTES_REGIONAIS_PR = [
      { cidade: "Cascavel", nome: "Fernanda Colla Borretto", email: "fcolla@pr.sebrae.com.br", telefone: "", horario: "08:00:00 às 18:00:00", almoco: "Escritório não fecha", pausaDuracao: "" },
      { cidade: "Londrina", nome: "Renata Custodio de Oliveira Varasquim", email: "rvarasquim@pr.sebrae.com.br", telefone: "(43) 99643-8754", horario: "08:00:00 às 18:00:00", almoco: "Escritório não fecha", pausaDuracao: "" },
      { cidade: "Maringá", nome: "Tatiane Matsuguma Sanches", email: "tmatsuguma@pr.sebrae.com.br", telefone: "(44) 99810-1371", horario: "08:00:00 às 18:00:00", almoco: "Escritório não fecha", pausaDuracao: "" },
      { cidade: "Pato Branco", nome: "Kelen Simone Moreira", email: "kmoreira@pr.sebrae.com.br", telefone: "(46) 99102-7523", horario: "08:00:00 às 17:00:00", almoco: "12:00:00", pausaDuracao: "1h30" },
      { cidade: "Ponta Grossa", nome: "Gislaine Pratka dos Santos", email: "gpratka@pr.sebrae.com.br", telefone: "", horario: "08:00:00 às 18:00:00", almoco: "Escritório não fecha", pausaDuracao: "" },
      { cidade: "Foz do Iguaçu", nome: "Marinez Martins", email: "moliveira@pr.sebrae.com.br", telefone: "", horario: "08:00:00 às 17:00:00", almoco: "12:00:00", pausaDuracao: "1h30" },
      { cidade: "Paranaguá", nome: "Carolina Nunes Pereira Voi", email: "cnunes@pr.sebrae.com.br", telefone: "", horario: "08:30:00 às 17:30:00", almoco: "12:00:00", pausaDuracao: "1h" },
      { cidade: "Toledo", nome: "Fernanda da Costa Goldacker", email: "fgoldacker@pr.sebrae.com.br", telefone: "", horario: "08:00:00 às 18:00:00", almoco: "12:00:00", pausaDuracao: "1h30" },
      { cidade: "Guarapuava", nome: "Chrislaine Caroline de Souza", email: "chsouza@pr.sebrae.com.br", telefone: "", horario: "08:00:00 às 18:00:00", almoco: "12:00:00", pausaDuracao: "2h" },
      { cidade: "Porecatu", nome: "Sandra de Souza Alves", email: "ssalves@pr.sebrae.com.br", telefone: "(43) 99818-0708", horario: "08:00:00 às 17:00:00", almoco: "12:00:00", pausaDuracao: "2h" },
      { cidade: "Irati", nome: "Melany Evelyn Fernandes Ovando", email: "movando@pr.sebrae.com.br", telefone: "", horario: "08:00:00 às 18:00:00", almoco: "12:00:00", pausaDuracao: "2h" },
      { cidade: "Cornélio Procópio", nome: "Eloah Bueno Rocha", email: "erocha@pr.sebrae.com.br", telefone: "", horario: "08:00:00 às 17:30:00", almoco: "12:00:00", pausaDuracao: "1h30" },
      { cidade: "Apucarana", nome: "Tiago Correia da Cunha", email: "tcorreia@pr.sebrae.com.br", telefone: "", horario: "08:00:00 às 18:00:00", almoco: "12:00:00", pausaDuracao: "2h" },
      { cidade: "Arapongas", nome: "", nomeOpcao: "Não definido ainda", email: "", telefone: "", horario: "08:00:00 às 18:00:00", almoco: "12:00:00", pausaDuracao: "2h" },
      { cidade: "Cerro Azul", nome: "Ivan Silva Evangelista", email: "ievangelista@pr.sebrae.com.br", telefone: "", horario: "08:00:00 às 17:00:00", almoco: "12:00:00", pausaDuracao: "1h" },
      { cidade: "Cianorte", nome: "Valtemar Sartorelli", email: "vSartorelli@pr.sebrae.com.br", telefone: "", horario: "08:00:00 às 17:00:00", almoco: "12:00:00", pausaDuracao: "2h" },
      { cidade: "Francisco Beltrão", nome: "Claudineia Cabral", email: "cprzysiesny@pr.sebrae.com.br", telefone: "", horario: "08:00:00 às 18:00:00", almoco: "12:00:00", pausaDuracao: "1h30" },
      { cidade: "Ivaiporã", nome: "Joelma Barbosa", email: "jbarbosa@pr.sebrae.com.br", telefone: "", horario: "08:00:00 às 18:00:00", almoco: "12:00:00", pausaDuracao: "2h" },
      { cidade: "Jacarezinho", nome: "Erika Cristina de Faria Possette", email: "epossette@pr.sebrae.com.br", telefone: "", horario: "08:00:00 às 18:00:00", almoco: "12:00:00", pausaDuracao: "2h" },
      { cidade: "Laranjeiras do Sul", nome: "Thaís Cristina da Costa", email: "tcosta@pr.sebrae.com.br", telefone: "", horario: "08:00:00 às 18:00:00", almoco: "12:00:00", pausaDuracao: "2h" },
      { cidade: "Paranavaí", nome: "Claudia Roberta Molocny Ferro", email: "cmolocny@pr.sebrae.com.br", telefone: "", horario: "08:00:00 às 18:00:00", almoco: "12:00:00", pausaDuracao: "2h" },
      { cidade: "Campo Mourão", nome: "Sandro Nasser Santi", email: "ssanti@pr.sebrae.com.br", telefone: "", horario: "08:00:00 às 18:00:00", almoco: "12:00:00", pausaDuracao: "2h" }
    ];

    const CAMPOS_CONTATO_REGIONAL = {
      retirada: {
        selectId: "retirada-representante",
        contatoId: "retirada-contato",
        emailId: "retirada-email",
        telefoneId: "retirada-telefone",
        horarioId: "retirada-horario",
        almocoId: "retirada-almoco",
        pausaDuracaoId: "retirada-pausa-duracao",
        contatoPadrao: "",
        emailPadrao: "",
        telefonePadrao: "",
        horarioPadrao: "09:00:00 às 18:00:00",
        almocoPadrao: "12:00:00",
        pausaDuracaoPadrao: "1h12"
      },
      entrega: {
        selectId: "entrega-representante",
        contatoId: "entrega-contato",
        emailId: "entrega-email",
        telefoneId: "entrega-telefone",
        horarioId: "entrega-horario",
        almocoId: "entrega-almoco",
        pausaDuracaoId: "entrega-pausa-duracao",
        contatoPadrao: "",
        emailPadrao: "",
        telefonePadrao: "",
        horarioPadrao: "09:00:00 às 18:00:00",
        almocoPadrao: "12:00:00",
        pausaDuracaoPadrao: "1h"
      }
    };

    async function carregarConfiguracaoTransferencia() {
      try {
        const response = await fetch("/api/config/transferencia", { cache: "no-store" });
        if (!response.ok) throw new Error("Falha ao carregar os contatos padrão da instalação.");
        const config = await response.json();
        const origin = CAMPOS_CONTATO_REGIONAL.retirada;
        const fields = [
          ["contatoPadrao", "contatoId", config.retirada_contato],
          ["emailPadrao", "emailId", config.retirada_email],
          ["telefonePadrao", "telefoneId", config.retirada_telefone],
        ];
        fields.forEach(([defaultKey, inputKey, value]) => {
          const normalized = typeof value === "string" ? value.trim() : "";
          origin[defaultKey] = normalized;
          const input = document.getElementById(origin[inputKey]);
          if (input && !input.value.trim()) input.value = normalized;
        });
      } catch (error) {
        console.warn("Não foi possível carregar os contatos de retirada configurados:", error);
      }
    }

    function normalizarCidadeRegional(cidade) {
      return String(cidade || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .toLocaleLowerCase("pt-BR")
        .replace(/\s+/g, " ");
    }

    function entregaAlmocoNaoFecha() {
      const almoco = document.getElementById("entrega-almoco");
      return normalizarCidadeRegional(almoco?.value) === normalizarCidadeRegional("Escritório não fecha");
    }

    function atualizarObrigatoriedadeDuracaoPausaEntrega() {
      const pausaDuracao = document.getElementById("entrega-pausa-duracao");
      if (!pausaDuracao) return;

      const obrigatorio = !entregaAlmocoNaoFecha();
      pausaDuracao.required = obrigatorio;
      pausaDuracao.setAttribute("aria-required", String(obrigatorio));
      document.getElementById("entrega-pausa-obrigatorio")?.classList.toggle("hidden", !obrigatorio);
    }

    function obterRepresentanteRegional(cidade) {
      const cidadeNormalizada = normalizarCidadeRegional(cidade);
      if (!cidadeNormalizada) return null;

      return REPRESENTANTES_REGIONAIS_PR.find((representante) => {
        const nomeCidade = normalizarCidadeRegional(representante.cidade);
        return cidadeNormalizada === nomeCidade
          || cidadeNormalizada.startsWith(`${nomeCidade} `)
          || cidadeNormalizada.startsWith(`${nomeCidade}/`)
          || cidadeNormalizada.startsWith(`${nomeCidade}-`);
      }) || null;
    }

    function popularSeletoresRepresentantesRegionais() {
      Object.values(CAMPOS_CONTATO_REGIONAL).forEach(({ selectId }) => {
        const select = document.getElementById(selectId);
        if (!select) return;

        const opcaoVazia = document.createElement("option");
        opcaoVazia.value = "";
        opcaoVazia.textContent = "-- Sem representante correspondente --";
        select.replaceChildren(opcaoVazia);

        REPRESENTANTES_REGIONAIS_PR.forEach((representante) => {
          const opcao = document.createElement("option");
          opcao.value = representante.cidade;
          const nomeExibicao = representante.nome || representante.nomeOpcao || "Representante não informado";
          opcao.textContent = `${nomeExibicao} — ${representante.cidade}`;
          select.appendChild(opcao);
        });
      });
    }

    function atualizarCampoContatoRegional(campo, valorNovo, valorPadrao, forcar, limparQuandoVazio = false) {
      const valorAtual = campo.value.trim();
      const valorAutoAnterior = campo.dataset.representanteAutoValue || "";
      const podeAtualizar = forcar
        || !valorAtual
        || valorAtual === valorAutoAnterior
        || (valorPadrao && valorAtual === valorPadrao);

      if (!podeAtualizar) return;
      campo.value = valorNovo || (limparQuandoVazio ? "" : valorPadrao);
      campo.dataset.representanteAutoValue = valorNovo || "";
    }

    function preencherRepresentanteRegional(tipo, cidade, forcar = false) {
      const campos = CAMPOS_CONTATO_REGIONAL[tipo];
      if (!campos) return null;

      const representante = obterRepresentanteRegional(cidade);
      const seletor = document.getElementById(campos.selectId);
      const contato = document.getElementById(campos.contatoId);
      const email = document.getElementById(campos.emailId);
      const telefone = document.getElementById(campos.telefoneId);
      const horario = document.getElementById(campos.horarioId);
      const almoco = document.getElementById(campos.almocoId);
      const pausaDuracao = document.getElementById(campos.pausaDuracaoId);
      if (seletor) seletor.value = representante?.cidade || "";
      if (contato) {
        atualizarCampoContatoRegional(
          contato,
          representante?.nome || "",
          campos.contatoPadrao,
          forcar && Boolean(representante)
        );
      }
      if (email) {
        const limparEmail = Boolean(representante?.nome)
          && Object.prototype.hasOwnProperty.call(representante, "email")
          && !representante.email;
        atualizarCampoContatoRegional(
          email,
          representante?.email || "",
          campos.emailPadrao,
          forcar && Boolean(representante),
          limparEmail
        );
      }
      if (telefone) {
        const telefoneRepresentante = representante?.telefone
          ? formatarTelefoneBrasileiro(representante.telefone)
          : "";
        const limparTelefone = Boolean(representante?.nome)
          && Object.prototype.hasOwnProperty.call(representante, "telefone")
          && !telefoneRepresentante;
        atualizarCampoContatoRegional(
          telefone,
          telefoneRepresentante,
          campos.telefonePadrao,
          forcar && Boolean(representante),
          limparTelefone
        );
      }
      if (horario) {
        const horarioRepresentante = representante?.horario || "";
        const limparHorario = Boolean(representante)
          && Object.prototype.hasOwnProperty.call(representante, "horario")
          && !horarioRepresentante;
        atualizarCampoContatoRegional(
          horario,
          horarioRepresentante,
          campos.horarioPadrao,
          forcar && Boolean(horarioRepresentante),
          limparHorario
        );
      }
      if (almoco) {
        const almocoRepresentante = representante?.almoco || "";
        const limparAlmoco = Boolean(representante)
          && Object.prototype.hasOwnProperty.call(representante, "almoco")
          && !almocoRepresentante;
        atualizarCampoContatoRegional(
          almoco,
          almocoRepresentante,
          campos.almocoPadrao,
          forcar && Boolean(almocoRepresentante),
          limparAlmoco
        );
      }
      if (pausaDuracao) {
        const pausaRepresentante = representante?.pausaDuracao || "";
        const limparPausa = Boolean(representante)
          && Object.prototype.hasOwnProperty.call(representante, "pausaDuracao")
          && !pausaRepresentante;
        atualizarCampoContatoRegional(
          pausaDuracao,
          pausaRepresentante,
          campos.pausaDuracaoPadrao,
          forcar && Boolean(pausaRepresentante),
          limparPausa
        );
      }
      if (tipo === "entrega") atualizarObrigatoriedadeDuracaoPausaEntrega();
      return representante;
    }

    function handleRepresentanteRegionalChange(tipo, cidade) {
      const representante = obterRepresentanteRegional(cidade);
      preencherRepresentanteRegional(tipo, representante?.cidade || "", Boolean(representante));
    }

    function aplicarMascaraTelefone(input) {
      const cursor = input.selectionStart ?? input.value.length;
      const digitosAntesDoCursor = (input.value.slice(0, cursor).match(/\d/g) || []).length;
      const valorFormatado = formatarTelefoneBrasileiro(input.value);
      if (valorFormatado === input.value) return;
      input.value = valorFormatado;

      let novaPosicao = 0;
      let digitosPercorridos = 0;
      while (novaPosicao < input.value.length && digitosPercorridos < digitosAntesDoCursor) {
        if (/\d/.test(input.value[novaPosicao])) digitosPercorridos += 1;
        novaPosicao += 1;
      }
      input.setSelectionRange(novaPosicao, novaPosicao);
    }

    function inicializarMascarasTelefone() {
      ["retirada-telefone", "entrega-telefone"].forEach((id) => {
        const input = document.getElementById(id);
        if (!input) return;
        input.value = formatarTelefoneBrasileiro(input.value);
        input.addEventListener("input", () => aplicarMascaraTelefone(input));
        input.addEventListener("change", () => aplicarMascaraTelefone(input));
        input.addEventListener("blur", () => aplicarMascaraTelefone(input));
      });
    }

    function inicializarExportacaoAutomaticaHistorico() {
      const input = document.getElementById("auto-export-history-after-update");
      if (!input) return;

      try {
        input.checked = window.localStorage.getItem("simpress:auto-export-history-after-update") === "true";
      } catch (error) {
        console.warn("Não foi possível ler a preferência de exportação automática do histórico.", error);
      }

      input.addEventListener("change", () => {
        try {
          window.localStorage.setItem(
            "simpress:auto-export-history-after-update",
            input.checked ? "true" : "false",
          );
        } catch (error) {
          console.warn("Não foi possível salvar a preferência de exportação automática do histórico.", error);
        }
      });
    }

    // Initialize page behaviors
    function inicializarAplicacao() {
      document.getElementById("input-serial")?.addEventListener("input", () => {
        equipamentoSelectionRevision += 1;
      });
      lucide.createIcons();
      carregarConfiguracaoTransferencia();
      popularSeletoresRepresentantesRegionais();
      associarRotulosAcessiveis();
      inicializarMascarasTelefone();
      inicializarExportacaoAutomaticaHistorico();
      const almocoEntrega = document.getElementById("entrega-almoco");
      almocoEntrega?.addEventListener("input", atualizarObrigatoriedadeDuracaoPausaEntrega);
      almocoEntrega?.addEventListener("change", atualizarObrigatoriedadeDuracaoPausaEntrega);
      atualizarObrigatoriedadeDuracaoPausaEntrega();
      document.getElementById("readiness-refresh")?.addEventListener("click", carregarProntidao);
      carregarProntidao();
      carregarEstatisticas();
      carregarUnidades();
      carregarContagemHistoricoApelidos();
      carregarContagemHistoricoComparacoes();

      [
        ["upload-endpoint-file", "upload-endpoint-name"],
        ["upload-details-file", "upload-details-name"]
      ].forEach(([inputId, nameId]) => {
        const input = document.getElementById(inputId);
        input?.addEventListener("change", () => {
          document.getElementById(nameId).textContent = input.files?.[0]?.name || "Nenhum arquivo selecionado";
        });
      });

    }

    if (document.readyState === "interactive" || document.readyState === "complete") {
      inicializarAplicacao();
    } else {
      document.addEventListener("DOMContentLoaded", inicializarAplicacao, { once: true });
    }

    // Toast system
    function showToast(message, type = "success") {
      notifications.show(message, type);
    }

    function formatarContagemEstatistica(value) {
      const count = typeof value === "number" ? value : Number(value);
      if (!Number.isSafeInteger(count) || count < 0) return "Indisponível";
      return count.toLocaleString("pt-BR");
    }

    function definirEstatistica(elementId, value) {
      const element = document.getElementById(elementId);
      if (element) element.textContent = formatarContagemEstatistica(value);
    }

    // Load statistics from API
    async function carregarEstatisticas() {
      try {
        const res = await fetch("/api/stats");
        if (!res.ok) throw new Error("Falha ao consultar as estatísticas locais.");
        const stats = await res.json();
        definirEstatistica("stat-equipamentos", stats.total_equipamentos);
        definirEstatistica("stat-unidades", stats.total_unidades);
        const exportButton = document.getElementById("btn-exportar-equipamentos");
        if (exportButton) {
          const exportAvailable = stats.exportacao_disponivel === true;
          const exportCount = Number(stats.total_alteracoes_exportaveis);
          exportButton.classList.toggle(
            "hidden",
            exportAvailable && Number.isSafeInteger(exportCount) && exportCount === 0
          );
          exportButton.title = exportAvailable
            ? "Baixar a planilha com apelidos e IdCliente atualizados"
            : `Contagem indisponível: ${stats.exportacao_motivo || "clique para verificar a exportação"}`;
        }
      } catch (err) {
        console.warn("Não foi possível carregar estatísticas:", err);
        definirEstatistica("stat-equipamentos", null);
        definirEstatistica("stat-unidades", null);
      }
    }

    async function carregarProntidao() {
      const panel = document.getElementById("readiness-panel");
      const summary = document.getElementById("readiness-summary");
      const details = document.getElementById("readiness-details-content");
      const refreshButton = document.getElementById("readiness-refresh");
      if (!panel || !summary || !details || !refreshButton) return;

      panel.setAttribute("aria-busy", "true");
      refreshButton.disabled = true;
      try {
        const response = await fetch("/api/prontidao", { cache: "no-store" });
        if (!response.ok) throw new Error("Falha ao consultar a disponibilidade local.");
        const report = await response.json();
        if (!report?.functions || !report?.files) throw new Error("Resposta de disponibilidade inválida.");

        const functions = Object.entries(report.functions);
        const availableCount = functions.filter(([, status]) => status.available === true).length;
        const totalCount = functions.length;
        const allAvailable = totalCount > 0 && availableCount === totalCount;
        panel.dataset.state = allAvailable ? "ready" : "warning";
        summary.textContent = allAvailable
          ? `Todas as ${totalCount} funções estão disponíveis.`
          : `${availableCount} de ${totalCount} funções disponíveis. Confira os detalhes.`;

        const functionLabels = {
          consulta_equipamentos: "Consulta de equipamentos",
          geracao_transferencia: "Geração de transferência",
          comparacao_atualizacao_inventarios: "Comparação e atualização de inventários",
          exportacao_equipamentos: "Exportação de equipamentos",
        };
        const fileLabels = {
          template_transferencia: "Modelo de transferência",
          inventario_equipamentos: "Inventário ativo de equipamentos",
          inventario_detalhes_atualizacao: "Inventário EquipamentosDetalhes para atualização",
          inventario_endpoint: "Inventário Endpoint",
          modelo_exportacao: "Modelo de exportação",
        };

        const content = document.createDocumentFragment();
        adicionarGrupoProntidao(content, "Funções", functions, functionLabels, "function");
        adicionarGrupoProntidao(content, "Arquivos locais", Object.entries(report.files), fileLabels, "file");
        details.replaceChildren(content);
      } catch (error) {
        panel.dataset.state = "error";
        summary.textContent = "Não foi possível consultar a disponibilidade das funções.";
        details.textContent = "Confira se o servidor está em execução e tente atualizar o status.";
      } finally {
        panel.setAttribute("aria-busy", "false");
        refreshButton.disabled = false;
      }
    }

    function adicionarGrupoProntidao(parent, title, entries, labels, type) {
      const group = document.createElement("section");
      group.className = "readiness-group";
      const heading = document.createElement("h3");
      heading.className = "readiness-group-title";
      heading.textContent = title;
      const list = document.createElement("ul");
      list.className = "readiness-list";

      entries.forEach(([key, status]) => {
        const available = status?.available === true;
        const item = document.createElement("li");
        item.className = "readiness-item";
        item.dataset.available = String(available);
        const label = document.createElement("span");
        label.className = "readiness-item-label";
        label.textContent = labels[key] || key;
        const state = document.createElement("span");
        state.className = "readiness-item-state";
        state.textContent = available
          ? (type === "file" && status.file ? `Disponível — ${status.file}` : "Disponível")
          : type === "file"
            ? [status.file, status.reason].filter(Boolean).join(" — ") || "Indisponível"
            : `Indisponível — ${(status.missing_files || []).join(", ") || "dependência ausente"}`;
        item.append(label, state);
        list.appendChild(item);
      });

      group.append(heading, list);
      parent.appendChild(group);
    }

    function atualizarIndicadoresPosSalvamento() {
      // Atualiza os indicadores sem atrasar o fechamento do formulário após salvar.
      void Promise.allSettled([
        carregarEstatisticas(),
        carregarContagemHistoricoApelidos()
      ]);
    }

    // Load SEBRAE units catalog from API
    async function carregarUnidades() {
      try {
        const res = await fetch("/api/unidades");
        if (res.ok) {
          unidadesList = await res.json();
          const select = document.getElementById("select-unidade-destino");
          const selectedUnitId = select.value;
          select.innerHTML = '<option value="">-- Escolha a Cidade ou Regional de Destino --</option>';

          unidadesList.forEach(u => {
            const opt = document.createElement("option");
            opt.value = u.id;
            opt.textContent = u.label || `${u.cidade} - ${u.endereco} (${u.cnpj})`;
            select.appendChild(opt);
          });

          const selectedUnit = unidadesList.find(unit => String(unit.id) === String(selectedUnitId));
          if (selectedUnit) {
            select.value = selectedUnit.id;
            handleUnidadeDestinoChange(selectedUnit.id, false);
          } else if (selectedUnitId) {
            select.value = "";
            document.getElementById("entrega-cnpj").value = "";
            document.getElementById("entrega-endereco").value = "";
            preencherRepresentanteRegional("entrega", "");
          }
          atualizarEstadoCopiaCnpjEntrega();

          const countEl = document.getElementById("filiais-count");
          if (countEl) countEl.textContent = `${unidadesList.length} filiais catalogadas`;
        }
      } catch (err) {
        console.error("Falha ao carregar unidades:", err);
        showToast("Erro ao carregar catálogo de unidades SEBRAE", "error");
      }
    }

    // Autocomplete & Debounce for Serial Input
    let autocompleteItemsList = [];
    let highlightedAutocompleteIndex = -1;
    const PESQUISA_COMPLETA_PAGINA = 50;
    let pesquisaCompletaState = { query: "", categoria: "", cidade: "", offset: 0, total: 0, loading: false, requestId: 0 };

    function handleSerialInput(val) {
      invalidarBuscasEquipamento();
      limparSelecaoEquipamento();
      fecharAutocomplete();
      const clearBtn = document.getElementById("btn-clear-serial");
      if (val && val.length > 0) {
        clearBtn.classList.remove("hidden");
      } else {
        clearBtn.classList.add("hidden");
      }

      clearTimeout(debounceTimer);
      const term = val.trim();
      if (term.length < 2) {
        fecharAutocomplete();
        return;
      }

      document.getElementById("autocomplete-box").setAttribute("aria-busy", "true");
      debounceTimer = setTimeout(async () => {
        const request = autocompleteRequestGate.begin();
        try {
          const res = await fetch(`/api/buscar-expandida?q=${encodeURIComponent(term)}&limit=15`, { signal: request.signal });
          if (!autocompleteRequestGate.isCurrent(request.id)) return;
          if (res.ok) {
            const results = await res.json();
            if (transferUtils.isCurrentQuery(
              autocompleteRequestGate, request.id, document.getElementById("input-serial").value, term
            )) {
              renderAutocomplete(results.items, results.total, results.has_more);
            }
          } else if (autocompleteRequestGate.isCurrent(request.id)) {
            showToast("Não foi possível consultar os equipamentos. Tente novamente.", "error");
          }
        } catch (err) {
          if (err.name !== "AbortError" && autocompleteRequestGate.isCurrent(request.id)) {
            console.warn("Erro no autocomplete:", err);
            showToast("Falha de conexão ao consultar os equipamentos.", "error");
          }
        } finally {
          if (transferUtils.isCurrentQuery(
            autocompleteRequestGate, request.id, document.getElementById("input-serial").value, term
          )) {
            document.getElementById("autocomplete-box").setAttribute("aria-busy", "false");
          }
        }
      }, 200);
    }

    function handleSerialKeydown(e) {
      const box = document.getElementById("autocomplete-box");
      const isBoxOpen = box && !box.classList.contains("hidden") && autocompleteItemsList.length > 0;

      if (e.key === "ArrowDown") {
        if (isBoxOpen) {
          e.preventDefault();
          highlightedAutocompleteIndex = (highlightedAutocompleteIndex + 1) % autocompleteItemsList.length;
          updateAutocompleteHighlight();
        }
      } else if (e.key === "ArrowUp") {
        if (isBoxOpen) {
          e.preventDefault();
          highlightedAutocompleteIndex = (highlightedAutocompleteIndex - 1 + autocompleteItemsList.length) % autocompleteItemsList.length;
          updateAutocompleteHighlight();
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (isBoxOpen && highlightedAutocompleteIndex >= 0 && autocompleteItemsList[highlightedAutocompleteIndex]) {
          selecionarItemAutocomplete(autocompleteItemsList[highlightedAutocompleteIndex]);
        } else if (isBoxOpen && autocompleteItemsList.length === 1) {
          selecionarItemAutocomplete(autocompleteItemsList[0]);
        } else if (isBoxOpen) {
          abrirPesquisaCompleta();
        } else {
          buscarSerial();
        }
      } else if (e.key === "Escape") {
        fecharAutocomplete();
      }
    }

    function escapeHtml(str) {
      if (str === null || str === undefined) return "";
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function createTextElement(tagName, className, value) {
      const element = document.createElement(tagName);
      if (className) element.className = className;
      element.textContent = String(value ?? "");
      return element;
    }

    function createIcon(name, className) {
      const icon = document.createElement("i");
      icon.setAttribute("data-lucide", name);
      icon.className = className;
      return icon;
    }

    function highlightMatch(text, query) {
      if (!text) return "";
      if (!query) return escapeHtml(text);
      const q = query.trim();
      if (!q) return escapeHtml(text);
      const safeText = escapeHtml(text);
      const safeQuery = escapeHtml(q);
      const regex = new RegExp(`(${safeQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, "gi");
      return safeText.replace(regex, `<span class="serial-match">$1</span>`);
    }

    function updateAutocompleteHighlight() {
      const list = document.getElementById("autocomplete-list");
      if (!list) return;
      const rows = list.querySelectorAll(".autocomplete-row");
      rows.forEach((row, idx) => {
        const selected = idx === highlightedAutocompleteIndex;
        row.setAttribute("aria-selected", String(selected));
        if (selected) {
          row.classList.add("active");
          document.getElementById("input-serial").setAttribute("aria-activedescendant", row.id);
          row.scrollIntoView({ block: "nearest", behavior: "auto" });
        } else {
          row.classList.remove("active");
        }
      });
      if (highlightedAutocompleteIndex < 0) document.getElementById("input-serial").removeAttribute("aria-activedescendant");
    }

    function selecionarItemAutocomplete(item) {
      invalidarBuscasEquipamento();
      limparSelecaoEquipamento();
      document.getElementById("input-serial").value = item.serial;
      document.getElementById("btn-clear-serial").classList.remove("hidden");
      fecharAutocomplete();
      return buscarSerial(item);
    }

    function conteudoLinhaResultado(item, currentQuery) {
      let tipoIcon = "laptop";
      let tipoBadgeClass = "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30";

      if (item.tipo === "Micro Computador") {
        tipoIcon = "monitor";
        tipoBadgeClass = "bg-blue-500/15 text-blue-300 border border-blue-500/30";
      } else if (item.tipo === "Monitor") {
        tipoIcon = "tv";
        tipoBadgeClass = "bg-indigo-500/15 text-indigo-300 border border-indigo-500/30";
      } else if (item.tipo !== "Notebook") {
        tipoIcon = "box";
        tipoBadgeClass = "bg-purple-500/15 text-purple-300 border border-purple-500/30";
      }

      return `
        <div class="flex items-center gap-3 min-w-0 flex-1">
          <div class="serial-badge flex items-center gap-2 px-3 py-1.5 rounded-lg shrink-0">
            <i data-lucide="hash" class="w-4 h-4 text-cyan-400 shrink-0" aria-hidden="true"></i>
            <span class="font-mono font-bold text-white text-sm sm:text-base tracking-widest">${highlightMatch(item.serial, currentQuery)}</span>
          </div>
          <span class="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${tipoBadgeClass} shrink-0">
            <i data-lucide="${tipoIcon}" class="w-3.5 h-3.5 shrink-0" aria-hidden="true"></i>
            <span>${escapeHtml(item.tipo || "Equipamento")}</span>
          </span>
          <div class="min-w-0 flex items-center gap-2 flex-1">
            <span class="text-xs sm:text-sm font-medium text-slate-200 truncate" title="${escapeHtml(item.modelo || "")}">
              ${escapeHtml(item.modelo || "Sem modelo especificado")}
            </span>
            ${item.apelido ? `
              <span class="autocomplete-alias inline-flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded-md bg-slate-900/90 text-cyan-300 border border-cyan-500/30 shrink-0" title="Apelido / Hostname">
                <i data-lucide="terminal" class="w-2.5 h-2.5 text-cyan-400" aria-hidden="true"></i>
                <span>${escapeHtml(item.apelido)}</span>
              </span>
            ` : ""}
            ${item.invall_alias_status && item.invall_alias_status !== "aplicado" ? `
              <span class="text-[10px] text-amber-200 shrink-0" title="${escapeHtml(item.invall_alias_detail || "Conferir associação com a InvAll")}">Conferir InvAll</span>
            ` : ""}
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0 ml-2">
          <div class="flex items-center gap-1 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/25 px-2.5 py-1 rounded-lg font-medium" title="Cidade / Unidade Atual">
            <i data-lucide="map-pin" class="w-3.5 h-3.5 text-amber-400 shrink-0" aria-hidden="true"></i>
            <span>${escapeHtml(item.retirada_cidade || "PR")}</span>
          </div>
          <div class="hidden sm:flex items-center text-xs text-slate-400 group-hover:text-cyan-300 transition-colors ml-1 font-mono">
            <span class="text-[11px] mr-1 hidden lg:inline opacity-70">Selecionar</span>
            <kbd class="px-1.5 py-0.5 text-[10px] bg-slate-900 border border-slate-700 rounded text-slate-300 shadow-sm">↵</kbd>
          </div>
        </div>
      `;
    }

    function criarLinhaAutocomplete(item, index, currentQuery) {
      const row = document.createElement("div");
      row.id = `autocomplete-option-${index}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", "false");
      row.className = "autocomplete-row group px-4 py-2.5 cursor-pointer flex items-center justify-between gap-3";
      row.onclick = () => selecionarItemAutocomplete(item);
      row.onmouseenter = () => {
        highlightedAutocompleteIndex = index;
        updateAutocompleteHighlight();
      };
      row.innerHTML = conteudoLinhaResultado(item, currentQuery);
      return row;
    }

    function criarLinhaPesquisaCompleta(item, index, currentQuery) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "autocomplete-row group w-full text-left px-4 py-2.5 cursor-pointer flex items-center justify-between gap-3 rounded-lg";
      row.setAttribute("aria-label", [
        "Selecionar equipamento",
        item.serial,
        item.tipo,
        item.modelo,
        item.apelido,
        item.retirada_cidade,
      ].filter(Boolean).join(", "));
      row.dataset.resultIndex = String(index);
      row.innerHTML = conteudoLinhaResultado(item, currentQuery);
      row.addEventListener("click", () => {
        fecharModalPesquisaCompleta();
        selecionarItemAutocomplete(item);
      });
      return row;
    }

    function renderAutocomplete(items, total = items?.length || 0, hasMore = false) {
      const box = document.getElementById("autocomplete-box");
      const list = document.getElementById("autocomplete-list");
      const emptyState = document.getElementById("autocomplete-empty-state");
      const countEl = document.getElementById("autocomplete-count");
      const moreResults = document.getElementById("autocomplete-more-results");
      const currentQuery = (document.getElementById("input-serial").value || "").trim();

      if (!items || items.length === 0) {
        list.replaceChildren();
        list.classList.add("hidden");
        emptyState.classList.remove("hidden");
        moreResults.classList.add("hidden");
        emptyState.innerHTML = `
          <div class="px-6 py-8 text-center flex flex-col items-center justify-center space-y-2 select-none">
            <div class="w-10 h-10 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-500 mb-1">
              <i data-lucide="search-x" class="w-5 h-5" aria-hidden="true"></i>
            </div>
            <p class="text-sm font-semibold text-slate-200" role="status" aria-live="polite">Nenhum equipamento localizado</p>
            <p class="text-xs text-slate-500 max-w-sm">Nenhum registro com o termo <span class="font-mono text-cyan-400 font-bold">"${escapeHtml(currentQuery)}"</span> foi encontrado no inventário do SEBRAE/PR.</p>
            <button type="button" onclick="cadastrarNovoSerial(document.getElementById('input-serial').value)" class="mt-2 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition shadow-lg">
              <i data-lucide="plus-circle" class="w-3.5 h-3.5" aria-hidden="true"></i>
              <span>Cadastrar "${escapeHtml(currentQuery)}" como Novo Equipamento</span>
            </button>
          </div>
        `;
        countEl.textContent = "0 encontrados";
        autocompleteItemsList = [];
        highlightedAutocompleteIndex = -1;
        document.getElementById("input-serial").setAttribute("aria-expanded", "true");
        document.getElementById("input-serial").removeAttribute("aria-activedescendant");
        box.classList.remove("hidden");
        lucide.createIcons({ root: box });
        return;
      }

      autocompleteItemsList = items;
      highlightedAutocompleteIndex = -1;
      list.innerHTML = "";
      list.classList.remove("hidden");
      emptyState.classList.add("hidden");
      countEl.textContent = hasMore
        ? `${items.length} de ${total}`
        : `${total} ${total === 1 ? "item" : "itens"}`;
      moreResults.classList.toggle("hidden", !hasMore);
      document.getElementById("input-serial").setAttribute("aria-expanded", "true");
      document.getElementById("input-serial").removeAttribute("aria-activedescendant");

      items.forEach((item, index) => list.appendChild(criarLinhaAutocomplete(item, index, currentQuery)));

      box.classList.remove("hidden");
      lucide.createIcons({ root: box });
    }

    function abrirPesquisaCompleta() {
      const query = (document.getElementById("input-serial").value || "").trim();
      if (query.length < 2) {
        showToast("Digite ao menos 2 caracteres para pesquisar", "warning");
        return;
      }

      const requestId = pesquisaCompletaState.requestId + 1;
      pesquisaCompletaState = { query, categoria: "", cidade: "", offset: 0, total: 0, loading: false, requestId };
      document.getElementById("pesquisa-completa-termo").textContent = query;
      document.getElementById("pesquisa-completa-contagem").textContent = "Buscando...";
      document.getElementById("pesquisa-completa-status").textContent = "Carregando resultados...";
      const resultList = document.getElementById("pesquisa-completa-lista");
      resultList.replaceChildren();
      resultList.scrollTop = 0;
      document.getElementById("btn-carregar-mais-pesquisa").classList.add("hidden");
      document.getElementById("filtro-pesquisa-categoria").value = "";
      document.getElementById("filtro-pesquisa-cidade").value = "";
      document.getElementById("btn-limpar-filtros-pesquisa").classList.add("hidden");

      abrirModalAcessivel("modal-pesquisa-completa", "#btn-fechar-pesquisa-completa", "fecharModalPesquisaCompleta");
      fecharAutocomplete();
      carregarResultadosPesquisaCompleta(false, requestId);
    }

    function preencherOpcoesFiltroPesquisa(selectId, values, defaultLabel, selectedValue) {
      const select = document.getElementById(selectId);
      select.replaceChildren(new Option(defaultLabel, ""));
      values.forEach(value => select.add(new Option(value, value)));
      select.value = values.includes(selectedValue) ? selectedValue : "";
      return select.value;
    }

    function atualizarOpcoesFiltrosPesquisa(filters = {}) {
      const categorySelect = document.getElementById("filtro-pesquisa-categoria");
      const selectedCategory = pesquisaCompletaState.categoria;
      const categories = filters.categories || [
        { value: "notebook", label: "Notebooks" },
        { value: "macbook", label: "MacBooks" },
        { value: "monitor", label: "Monitores" },
        { value: "fone", label: "Fones" },
      ];
      categorySelect.replaceChildren(new Option("Todas as categorias", ""));
      categories.forEach(({ value, label, count }) => {
        const suffix = Number.isFinite(count) ? ` (${count})` : "";
        categorySelect.add(new Option(`${label}${suffix}`, value));
      });
      categorySelect.value = categories.some(({ value }) => value === selectedCategory) ? selectedCategory : "";
      pesquisaCompletaState.categoria = categorySelect.value;
      pesquisaCompletaState.cidade = preencherOpcoesFiltroPesquisa(
        "filtro-pesquisa-cidade",
        filters.cities || [],
        "Todas as cidades",
        pesquisaCompletaState.cidade,
      );
      document.getElementById("btn-limpar-filtros-pesquisa").classList.toggle(
        "hidden",
        !pesquisaCompletaState.categoria && !pesquisaCompletaState.cidade,
      );
    }

    function alterarFiltrosPesquisaCompleta() {
      if (pesquisaCompletaState.loading) return;
      const categoria = document.getElementById("filtro-pesquisa-categoria").value;
      const cidade = document.getElementById("filtro-pesquisa-cidade").value;
      if (categoria === pesquisaCompletaState.categoria && cidade === pesquisaCompletaState.cidade) return;

      pesquisaCompletaState.categoria = categoria;
      pesquisaCompletaState.cidade = cidade;
      pesquisaCompletaState.offset = 0;
      pesquisaCompletaState.total = 0;
      pesquisaCompletaState.requestId += 1;
      const resultList = document.getElementById("pesquisa-completa-lista");
      resultList.replaceChildren();
      resultList.scrollTop = 0;
      document.getElementById("pesquisa-completa-contagem").textContent = "Buscando...";
      document.getElementById("btn-carregar-mais-pesquisa").classList.add("hidden");
      document.getElementById("btn-limpar-filtros-pesquisa").classList.toggle("hidden", !categoria && !cidade);
      carregarResultadosPesquisaCompleta(false, pesquisaCompletaState.requestId);
    }

    function limparFiltrosPesquisaCompleta() {
      document.getElementById("filtro-pesquisa-categoria").value = "";
      document.getElementById("filtro-pesquisa-cidade").value = "";
      alterarFiltrosPesquisaCompleta();
    }

    async function carregarResultadosPesquisaCompleta(carregarMais = false, requestId = pesquisaCompletaState.requestId) {
      if (pesquisaCompletaState.loading || requestId !== pesquisaCompletaState.requestId) return;

      const modal = document.getElementById("modal-pesquisa-completa");
      const list = document.getElementById("pesquisa-completa-lista");
      const status = document.getElementById("pesquisa-completa-status");
      const count = document.getElementById("pesquisa-completa-contagem");
      const moreButton = document.getElementById("btn-carregar-mais-pesquisa");
      const categoryFilter = document.getElementById("filtro-pesquisa-categoria");
      const cityFilter = document.getElementById("filtro-pesquisa-cidade");
      const offset = carregarMais ? pesquisaCompletaState.offset : 0;

      pesquisaCompletaState.loading = true;
      moreButton.disabled = true;
      moreButton.setAttribute("aria-busy", "true");
      categoryFilter.disabled = true;
      cityFilter.disabled = true;
      status.textContent = carregarMais ? "Carregando mais resultados..." : "Carregando resultados...";
      if (!carregarMais) list.replaceChildren();
      const stopLoading = motion?.startLoading(list, "Carregando resultados da pesquisa…") || (() => {});

      try {
        const params = new URLSearchParams({
          q: pesquisaCompletaState.query,
          offset: String(offset),
          limit: String(PESQUISA_COMPLETA_PAGINA),
          include_filters: "true",
        });
        if (pesquisaCompletaState.categoria) params.set("categoria", pesquisaCompletaState.categoria);
        if (pesquisaCompletaState.cidade) params.set("cidade", pesquisaCompletaState.cidade);
        const response = await fetch(`/api/buscar-expandida?${params.toString()}`);
        if (!response.ok) throw new Error("Não foi possível carregar os resultados da pesquisa.");

        const page = await response.json();
        if (requestId !== pesquisaCompletaState.requestId) return;
        stopLoading();

        atualizarOpcoesFiltrosPesquisa(page.filters);
        page.items.forEach((item, index) => {
          list.appendChild(criarLinhaPesquisaCompleta(item, offset + index, pesquisaCompletaState.query));
        });
        pesquisaCompletaState.offset = offset + page.items.length;
        pesquisaCompletaState.total = page.total;
        count.textContent = page.total === 1 ? "1 resultado" : `${page.total} resultados`;

        if (page.total === 0) {
          status.textContent = "Nenhum equipamento encontrado para esse termo.";
        } else if (page.has_more) {
          status.textContent = `Exibindo ${pesquisaCompletaState.offset} de ${page.total} resultados.`;
        } else {
          status.textContent = `Todos os ${page.total} resultados foram exibidos.`;
        }
        moreButton.classList.toggle("hidden", !page.has_more);
        lucide.createIcons({ root: list });
      } catch (error) {
        if (requestId === pesquisaCompletaState.requestId) {
          status.textContent = "Não foi possível carregar a pesquisa. Feche a janela e tente novamente.";
          showToast(error.message || "Falha ao carregar resultados", "error");
        }
      } finally {
        stopLoading();
        if (requestId === pesquisaCompletaState.requestId) {
          pesquisaCompletaState.loading = false;
          moreButton.disabled = false;
          moreButton.removeAttribute("aria-busy");
          categoryFilter.disabled = false;
          cityFilter.disabled = false;
        }
      }
    }

    function carregarMaisResultadosPesquisa() {
      carregarResultadosPesquisaCompleta(true);
    }

    function fecharModalPesquisaCompleta() {
      fecharModalAcessivel("modal-pesquisa-completa");
    }

    function fecharAutocomplete() {
      const box = document.getElementById("autocomplete-box");
      if (box) box.classList.add("hidden");
      if (box) box.setAttribute("aria-busy", "false");
      const input = document.getElementById("input-serial");
      if (input) {
        input.setAttribute("aria-expanded", "false");
        input.removeAttribute("aria-activedescendant");
      }
      autocompleteItemsList = [];
      highlightedAutocompleteIndex = -1;
    }

    // Close autocomplete on click outside
    document.addEventListener("click", (e) => {
      const box = document.getElementById("autocomplete-box");
      const input = document.getElementById("input-serial");
      if (box && !box.contains(e.target) && e.target !== input) {
        fecharAutocomplete();
      }
    });

    function fecharMenuSecundarioAoClicarFora(event) {
      const menu = document.querySelector(".header-secondary-actions");
      if (menu?.open && !menu.contains(event.target)) {
        menu.open = false;
      }
    }

    document.addEventListener("click", fecharMenuSecundarioAoClicarFora);

    function limparSerial() {
      const input = document.getElementById("input-serial");
      input.value = "";
      invalidarBuscasEquipamento();
      limparSelecaoEquipamento();
      document.getElementById("btn-clear-serial").classList.add("hidden");
      fecharAutocomplete();
      input.focus();
    }

    function ativarAbaTransferencia(aba) {
      const homeAtiva = aba === "home";
      const tabHome = document.getElementById("tab-home");
      const tabTransferencia = document.getElementById("tab-retirada-entrega");
      const painelHome = document.getElementById("tab-panel-home");
      const painelTransferencia = document.getElementById("tab-panel-retirada-entrega");

      if (!tabHome || !tabTransferencia || !painelHome || !painelTransferencia) return;

      const mudou = painelHome.hidden === homeAtiva;
      painelHome.hidden = !homeAtiva;
      painelTransferencia.hidden = homeAtiva;
      tabHome.setAttribute("aria-selected", String(homeAtiva));
      tabTransferencia.setAttribute("aria-selected", String(!homeAtiva));
      tabHome.tabIndex = homeAtiva ? 0 : -1;
      tabTransferencia.tabIndex = homeAtiva ? -1 : 0;
      tabHome.classList.toggle("is-active", homeAtiva);
      tabTransferencia.classList.toggle("is-active", !homeAtiva);
      document.body.classList.toggle("has-quick-actions", !homeAtiva);
      if (!homeAtiva) atualizarResumoSerieTransferencia(currentEquipamento);
      if (mudou) motion?.reveal(homeAtiva ? painelHome : painelTransferencia, "page");
    }

    function abrirAbaTransporteDoEquipamento() {
      const painelTransporte = document.getElementById("tab-panel-retirada-entrega");
      if (!painelTransporte) return;

      ativarAbaTransferencia("transferencia");
      painelTransporte.focus();
    }

    function abrirHomeParaPesquisarEquipamento(event) {
      const acionadoPorTeclado = event?.type === "keydown";
      if (acionadoPorTeclado && event.key !== "Enter" && event.key !== " ") return;
      if (String(currentEquipamento?.serial || "").trim()) return;

      if (acionadoPorTeclado) event.preventDefault();
      ativarAbaTransferencia("home");
      document.getElementById("input-serial")?.focus();
    }

    function controlarAbasTransferencia(event) {
      const tabs = Array.from(event.currentTarget.querySelectorAll('[role="tab"]'));
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

    // Search Equipment by Serial
    async function buscarSerial(equipmentHint = null) {
      const serialInput = document.getElementById("input-serial");
      const serial = serialInput.value.trim().toUpperCase();

      if (!serial) {
        invalidarBuscasEquipamento();
        limparSelecaoEquipamento();
        showToast("Digite uma série, apelido, modelo ou cidade", "warning");
        serialInput.focus();
        return;
      }

      clearTimeout(debounceTimer);
      autocompleteRequestGate.invalidate();
      document.getElementById("autocomplete-box").setAttribute("aria-busy", "false");
      fecharAutocomplete();
      limparSelecaoEquipamento();
      const request = equipmentLookupRequestGate.begin();

      const btn = document.getElementById("btn-buscar-serial");
      const originalText = btn.innerHTML;
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
      serialInput.setAttribute("aria-busy", "true");
      btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i><span>Localizando...</span>`;
      lucide.createIcons({ root: btn });
      const stopLoading = motion?.startLoading(document.getElementById("equipment-loading"), "Localizando equipamento…", { rows: 1 }) || (() => {});
      finishEquipmentLoading = stopLoading;

      try {
        const res = await fetch(`/api/equipamento/${encodeURIComponent(serial)}`, { signal: request.signal });
        if (!equipmentLookupRequestGate.isCurrent(request.id)) return;
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          if (!equipmentLookupRequestGate.isCurrent(request.id)) return;
          if (res.status === 404 && serial.length >= 2) {
            const searchRes = await fetch(`/api/buscar-expandida?q=${encodeURIComponent(serial)}&limit=15`, { signal: request.signal });
            if (!equipmentLookupRequestGate.isCurrent(request.id)) return;
            if (searchRes.ok) {
              const searchResults = await searchRes.json();
              if (equipmentLookupRequestGate.isCurrent(request.id) && searchResults.total > 0) {
                renderAutocomplete(searchResults.items, searchResults.total, searchResults.has_more);
                return;
              }
            }
            if (!equipmentLookupRequestGate.isCurrent(request.id)) return;
          }
          throw new Error(errData.detail || "Equipamento não encontrado na base de dados.");
        }

        const data = await res.json();
        if (!transferUtils.isCurrentQuery(equipmentLookupRequestGate, request.id, serialInput.value, serial)) return;
        if (transferUtils.serialForTransfer(data, serial) !== serial) {
          throw new Error("A busca não retornou uma correspondência exata. Escolha um equipamento na lista.");
        }
        const hintedSerial = String(equipmentHint?.serial || "").trim().toUpperCase();
        const hintedCnpj = String(equipmentHint?.retirada_cnpj || "").trim();
        if (
          hintedSerial === serial
          && hintedCnpj
          && !String(data.retirada_cnpj || "").trim()
        ) {
          data.retirada_cnpj = hintedCnpj;
        }
        definirEquipamentoAtual(data);
        exibirEquipamento(data);
        showToast(`Equipamento ${data.serial} localizado com sucesso!`, "success");

      } catch (err) {
        if (err.name !== "AbortError" && equipmentLookupRequestGate.isCurrent(request.id)) {
          console.error(err);
          limparSelecaoEquipamento();
          showToast(err.message, "error");
        }
      } finally {
        stopLoading();
        if (equipmentLookupRequestGate.isCurrent(request.id)) {
          btn.disabled = false;
          btn.removeAttribute("aria-busy");
          serialInput.removeAttribute("aria-busy");
          btn.innerHTML = originalText;
          lucide.createIcons({ root: btn });
        }
      }
    }

    // Render Equipment Card & Populate Retirada Section
    function exibirEquipamento(eq) {
      retiradaCidadeSelecionada = String(eq.retirada_cidade || "").trim();
      const card = document.getElementById("card-equipamento");
      card.classList.remove("hidden");
      motion?.reveal(card);

      document.getElementById("card-serial").textContent = eq.serial;
      document.getElementById("ticket-templates-serial").textContent = eq.serial || "—";
      recolherVisualizacoesModelosChamado();
      document.getElementById("card-modelo").textContent = eq.modelo || "Equipamento";
      document.getElementById("badge-tipo").textContent = eq.tipo || "Geral";
      document.getElementById("badge-apelido").textContent = eq.apelido || "Sem Apelido";
      const aliasStatus = document.getElementById("badge-apelido-status");
      aliasStatus.textContent = eq.invall_alias_status && eq.invall_alias_status !== "aplicado"
        ? (eq.invall_alias_detail || "Conferir associação com a InvAll.")
        : "";
      aliasStatus.classList.toggle("hidden", !aliasStatus.textContent);
      document.getElementById("card-id-cliente").textContent = eq.idCliente ? `Id Cliente: ${eq.idCliente}` : "";
      document.getElementById("card-localizacao").textContent = `${eq.retirada_cidade || ''} - ${eq.retirada_endereco ? eq.retirada_endereco.split('-')[0].trim() : ''}`;
      document.getElementById("card-cnpj-atual").textContent = `CNPJ: ${eq.retirada_cnpj || 'Não especificado'}`;

      // Icon & Badge styling by Type
      const iconBox = document.getElementById("equip-icon-box");
      const icon = document.getElementById("equip-icon");
      const badgeTipo = document.getElementById("badge-tipo");

      if (eq.tipo === "Notebook") {
        icon.setAttribute("data-lucide", "laptop");
        iconBox.className = "w-14 h-14 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center shrink-0 text-emerald-400";
        badgeTipo.className = "px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30";
      } else if (eq.tipo === "Micro Computador") {
        icon.setAttribute("data-lucide", "monitor");
        iconBox.className = "w-14 h-14 rounded-xl bg-blue-500/10 border border-blue-500/30 flex items-center justify-center shrink-0 text-blue-400";
        badgeTipo.className = "px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-500/20 text-blue-300 border border-blue-500/30";
      } else {
        icon.setAttribute("data-lucide", "headphones");
        iconBox.className = "w-14 h-14 rounded-xl bg-purple-500/10 border border-purple-500/30 flex items-center justify-center shrink-0 text-purple-400";
        badgeTipo.className = "px-2.5 py-0.5 rounded-full text-xs font-semibold bg-purple-500/20 text-purple-300 border border-purple-500/30";
      }
      lucide.createIcons({ root: iconBox });

      // Automatically fill RETIRADA (Origem) section!
      document.getElementById("retirada-cnpj").value = eq.retirada_cnpj || "";
      document.getElementById("retirada-endereco").value = eq.retirada_endereco || "";
      document.getElementById("retirada-obs").value = eq.descricao_sugerida || "";
      preencherRepresentanteRegional("retirada", eq.retirada_cidade || "");

      // Update status footer
      document.getElementById("status-indicator").className = "w-2.5 h-2.5 rounded-full bg-emerald-400";
      const statusSummary = document.getElementById("status-summary");
      statusSummary.replaceChildren(
        createTextElement("span", "text-emerald-300 font-medium", "Equipamento " + String(eq.serial ?? "") + " (" + String(eq.modelo ?? "") + ") carregado."),
        createTextElement("span", "text-slate-400", " Selecione a Unidade de Destino e preencha o destinatário.")
      );
    }

    // "Forçar SEDE Prado Velho" button action
    function forcarSedePradoVelho() {
      const sede = unidadesList.find(unit => unit.is_sede);
      retiradaCidadeSelecionada = "Curitiba";
      document.getElementById("retirada-cnpj").value = sede?.cnpj || "";
      document.getElementById("retirada-endereco").value = "R Caeté, 150 - SEDE - Prado Velho - Curitiba/PR - CEP 80220-300";
      preencherRepresentanteRegional("retirada", "Curitiba");
      showToast("Origem alterada para SEDE Prado Velho (Curitiba)!", "info");
    }

    // Handle Unidade de Destino Selection
    function atualizarEstadoCopiaCnpjEntrega() {
      const unidadeId = document.getElementById("select-unidade-destino")?.value;
      const unidadeDestino = unidadesList.find(unit => String(unit.id) === String(unidadeId));
      const botao = document.getElementById("btn-copiar-cnpj-instalacao-entrega");
      if (botao) botao.disabled = !String(unidadeDestino?.cnpj || "").trim();
    }

    function handleUnidadeDestinoChange(unitId, notificar = true) {
      atualizarEstadoCopiaCnpjEntrega();
      if (!unitId) {
        preencherRepresentanteRegional("entrega", "");
        return;
      }
      const unit = unidadesList.find(u => String(u.id) === String(unitId));
      if (unit) {
        document.getElementById("entrega-cnpj").value = unit.cnpj || "";
        document.getElementById("entrega-endereco").value = unit.endereco_completo || "";
        preencherRepresentanteRegional("entrega", unit.cidade || "");
        if (notificar) showToast(`Destino definido: ${unit.cidade}`, "info");
      }
    }

    function selecionarUnidadePorCidade(cidadeNome) {
      const unit = unidadesList.find(u => u.cidade.toLowerCase().includes(cidadeNome.toLowerCase()));
      if (unit) {
        document.getElementById("select-unidade-destino").value = unit.id;
        handleUnidadeDestinoChange(unit.id);
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
        showToast("O texto do modelo está vazio.", "warning");
        return;
      }

      try {
        await copiarTextoParaAreaTransferencia(texto);
        showToast("Texto copiado. Você pode colá-lo no chamado manualmente.", "success");
      } catch (err) {
        showToast("Não foi possível copiar o texto. Selecione e copie o conteúdo manualmente.", "error");
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

    function alternarChamadosManuais() {
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
      const serialVal = transferUtils.serialForTransfer(currentEquipamento, serialInput.value);
      if (!serialVal) {
        showToast("Busque e selecione o equipamento correto antes de gerar a transferência.", "warning");
        serialInput.focus();
        return null;
      }

      const entregaContato = document.getElementById("entrega-contato").value.trim();
      if (!entregaContato) {
        showToast("Por favor, informe o Nome do Destinatário no SEBRAE.", "warning");
        document.getElementById("entrega-contato").focus();
        return null;
      }

      const entregaCnpj = document.getElementById("entrega-cnpj").value.trim();
      const entregaEndereco = document.getElementById("entrega-endereco").value.trim();
      const unidadeDestino = unidadesList.find(
        unit => String(unit.id) === String(document.getElementById("select-unidade-destino").value)
      );
      if (!entregaCnpj || !entregaEndereco) {
        showToast("Selecione uma unidade de destino para preencher automaticamente o CNPJ e o endereço de entrega.", "warning");
        document.getElementById("select-unidade-destino").focus();
        return null;
      }

      const retiradaTelefone = document.getElementById("retirada-telefone");
      const entregaTelefone = document.getElementById("entrega-telefone");
      retiradaTelefone.value = formatarTelefoneBrasileiro(retiradaTelefone.value);
      entregaTelefone.value = formatarTelefoneBrasileiro(entregaTelefone.value);

      return {
        serial: serialVal,
        descricao_equipamento: "",
        razao_social: "SERVICO DE APOIO AS MICRO E PEQUENAS EMPRESAS DO PARANA - SEBRAE/PR",
        contrato: 16467,
        retirada_cidade: retiradaCidadeSelecionada,
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
      const modelo = currentEquipamento ? currentEquipamento.modelo : "Equipamento";
      const tipo = currentEquipamento ? currentEquipamento.tipo : "Geral";
      const apelido = currentEquipamento ? currentEquipamento.apelido : "-";
      const idCliente = currentEquipamento ? currentEquipamento.idCliente : "-";

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

    // Modal Preview Handlers
    function abrirModalPreview() {
      const payload = construirPayload();
      if (!payload) return;

      const texto = gerarTextoResumo(payload);
      document.getElementById("textarea-resumo-preview").value = texto;
      abrirModalAcessivel("modal-preview", "#textarea-resumo-preview", "fecharModalPreview");
    }

    function fecharModalPreview() {
      fecharModalAcessivel("modal-preview");
    }

    function copiarTextoDoModal() {
      const texto = document.getElementById("textarea-resumo-preview").value;
      navigator.clipboard.writeText(texto).then(() => {
        showToast("Resumo copiado para a área de transferência!", "success");
      }).catch(err => {
        showToast("Erro ao copiar texto: " + err, "error");
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
      const unidadeDestino = unidadesList.find(
        unit => String(unit.id) === String(document.getElementById("select-unidade-destino").value)
      );
      const retiradaCidade = cidadeComUf(retiradaCidadeSelecionada);
      const entregaCidade = cidadeComUf(unidadeDestino?.cidade);

      if (!retiradaEndereco || !entregaEndereco) {
        showToast("Selecione o equipamento de origem e a unidade de destino para carregar os endereços.", "warning");
        return;
      }
      if (!retiradaCidade || !entregaCidade) {
        showToast("Não foi possível identificar as cidades de origem e destino.", "warning");
        return;
      }

      const texto = `Prezados,\n\nSolicito o transporte do equipamento da unidade do Sebrae de ${retiradaCidade} para a unidade do Sebrae de ${entregaCidade}\n\nO transporte dos equipamentos é previsto em edital e de responsabilidade da Simpress.\n\nEndereço para Retirada: ${retiradaEndereco}\nEndereço para Entrega: ${entregaEndereco}`;
      document.getElementById("textarea-texto-transporte").value = texto;
      abrirModalAcessivel("modal-texto-transporte", "#textarea-texto-transporte", "fecharModalTextoTransporte");
    }

    function fecharModalTextoTransporte() {
      fecharModalAcessivel("modal-texto-transporte");
    }

    async function copiarSerieAtual() {
      const serial = String(currentEquipamento?.serial || "").trim();
      if (!serial) {
        showToast("Pesquise um equipamento antes de copiar a série.", "warning");
        return;
      }

      try {
        await copiarTextoParaAreaTransferencia(serial);
        showToast(`Série ${serial} copiada para a área de transferência.`, "success");
      } catch (err) {
        showToast("Não foi possível copiar a série. Tente novamente pelo navegador.", "error");
      }
    }

    function obterCepRetiradaSelecionada() {
      const endereco = document.getElementById("retirada-endereco")?.value || "";
      const cepNoEndereco = endereco.match(/\bCEP\b\s*:?\s*(\d{5}-?\d{3})/i);
      return cepNoEndereco?.[1] || currentEquipamento?.retirada_cep || "";
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
        showToast(`Pesquise um equipamento com ${dado.nome.toLowerCase()} informado antes de copiar.`, "warning");
        return;
      }

      try {
        await copiarTextoParaAreaTransferencia(valor);
        showToast(`${dado.nome} copiado para a área de transferência.`, "success");
      } catch (err) {
        showToast(`Não foi possível copiar o ${dado.nome.toLowerCase()}.`, "error");
      }
    }

    async function copiarDadoEntrega(tipo) {
      const unidadeId = document.getElementById("select-unidade-destino")?.value;
      const unidadeDestino = unidadesList.find(unit => String(unit.id) === String(unidadeId));
      const dados = {
        faturamento: { valor: CNPJ_FATURAMENTO_PADRAO, nome: "CNPJ de faturamento" },
        instalacao: { valor: unidadeDestino?.cnpj || "", nome: "CNPJ de instalação" }
      };
      const dado = dados[tipo];
      if (!dado) return;

      const valor = String(dado.valor || "").trim();
      if (!valor) {
        showToast("Selecione uma unidade de destino antes de copiar o CNPJ de instalação.", "warning");
        return;
      }

      try {
        await copiarTextoParaAreaTransferencia(valor);
        const unidade = tipo === "instalacao"
          ? ` de ${unidadeDestino.cidade || "unidade selecionada"}`
          : " da entrega";
        showToast(`${dado.nome}${unidade} copiado para a área de transferência.`, "success");
      } catch (err) {
        showToast(`Não foi possível copiar o ${dado.nome.toLowerCase()} da entrega.`, "error");
      }
    }

    async function copiarTextoSolicitacaoTransporte() {
      const texto = document.getElementById("textarea-texto-transporte").value;
      if (!texto.trim()) {
        showToast("Gere o texto da solicitação antes de copiar.", "warning");
        return;
      }

      try {
        await copiarTextoParaAreaTransferencia(texto);
        showToast("Texto da solicitação copiado para a área de transferência.", "success");
      } catch (err) {
        showToast("Não foi possível copiar o texto. Tente novamente pelo navegador.", "error");
      }
    }

    function validarCamposObrigatoriosPlanilha() {
      atualizarObrigatoriedadeDuracaoPausaEntrega();
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
      if (!entregaAlmocoNaoFecha()) {
        campos.push({ id: "entrega-pausa-duracao", nome: "Duração da pausa da unidade de entrega" });
      }

      const campoVazio = campos.find(({ id }) => !document.getElementById(id).value.trim());
      if (campoVazio) {
        const input = document.getElementById(campoVazio.id);
        showToast(`Preencha o campo obrigatório “${campoVazio.nome}” para gerar a planilha oficial.`, "warning");
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
        showToast("Corrija o formato do endereço de e-mail antes de gerar a planilha.", "warning");
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
      if (!validarCamposObrigatoriosPlanilha()) return;

      const btn = document.getElementById("btn-gerar-planilha");
      const originalText = btn.innerHTML;
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
      btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i><span>Gerando Planilha...</span>`;
      lucide.createIcons({ root: btn });

      try {
        const res = await fetch("/api/gerar-planilha", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload)
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(window.HistoryAnnotationAutosave.getErrorMessage(
            errData.detail,
            "Falha ao gerar o arquivo Excel no servidor."
          ));
        }

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

        showToast("Planilha Exportada com Sucesso!", "success");

      } catch (err) {
        console.error("Erro ao gerar planilha:", err);
        showToast(err.message, "error");
      } finally {
        btn.disabled = false;
        btn.removeAttribute("aria-busy");
        btn.innerHTML = originalText;
        lucide.createIcons({ root: btn });
      }
    }

    // Reset Form for New Transfer
    function resetarFormulario() {
      const query = document.getElementById("input-serial").value.trim();
      if ((transferDraftTracker.isDirty() || currentEquipamento || query)
          && !window.confirm("Há dados preenchidos nesta transferência. Deseja descartar o rascunho e começar outra?")) {
        return;
      }
      transferDraftTracker.reset();
      invalidarBuscasEquipamento();
      limparSelecaoEquipamento();
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
      atualizarEstadoCopiaCnpjEntrega();
      preencherRepresentanteRegional("entrega", "");
      preencherRepresentanteRegional("retirada", "");

      // Reset status indicator
      document.getElementById("status-indicator").className = "w-2.5 h-2.5 rounded-full bg-brand-400";
      document.getElementById("status-summary").innerHTML = `
        <span class="text-slate-300 font-medium">Pronto para emissão.</span>
        <span class="hidden md:inline text-slate-500">Verifique os dados antes de gerar a planilha oficial Simpress.</span>
      `;

      showToast("Formulário limpo. Pronto para uma nova busca.", "info");
      ativarAbaTransferencia("home");
      document.getElementById("input-serial").focus();
    }

    // ==========================================
    // RECARREGAR / SINCRONIZAR PLANILHA BASE
    // ==========================================
    function abrirModalAtualizarPlanilhas() {
      const status = document.getElementById("upload-planilhas-status");
      status.classList.add("hidden");
      abrirModalAcessivel("modal-atualizar-planilhas", "#upload-endpoint-file", "fecharModalAtualizarPlanilhas");
    }

    function fecharModalAtualizarPlanilhas() {
      fecharModalAcessivel("modal-atualizar-planilhas");
    }

    function mostrarStatusUpload(mensagem, erro = false) {
      const status = document.getElementById("upload-planilhas-status");
      status.textContent = mensagem;
      status.setAttribute("role", erro ? "alert" : "status");
      status.setAttribute("aria-live", erro ? "assertive" : "polite");
      status.setAttribute("aria-atomic", "true");
      status.className = erro
        ? "text-xs rounded-lg px-3 py-2 bg-rose-500/10 border border-rose-500/25 text-rose-300"
        : "text-xs rounded-lg px-3 py-2 bg-sky-500/10 border border-sky-500/25 text-sky-300";
    }

    async function enviarPlanilhas() {
      const endpointFile = document.getElementById("upload-endpoint-file").files?.[0];
      const detailsFile = document.getElementById("upload-details-file").files?.[0];
      const exportarHistoricoAutomaticamente = document.getElementById("auto-export-history-after-update")?.checked === true;
      if (!endpointFile || !detailsFile) {
        mostrarStatusUpload("Selecione Endpoint e EquipamentosDetalhes antes de atualizar.", true);
        return;
      }

      const button = document.getElementById("btn-confirmar-planilhas");
      const originalHtml = button.innerHTML;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      const autoExportInput = document.getElementById("auto-export-history-after-update");
      if (autoExportInput) autoExportInput.disabled = true;
      document.getElementById("modal-atualizar-planilhas").setAttribute("aria-busy", "true");
      button.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i><span>Validando e atualizando...</span>';
      lucide.createIcons({ root: button });

      const formData = new FormData();
      formData.append("endpoint_file", endpointFile);
      formData.append("details_file", detailsFile);
      if (!inventoryUploadAttempt || inventoryUploadAttempt.endpoint !== endpointFile || inventoryUploadAttempt.details !== detailsFile) {
        inventoryUploadAttempt = { endpoint: endpointFile, details: detailsFile, key: inventoryOperationKey() };
      }

      try {
        const response = await fetch("/api/planilhas/atualizar", {
          method: "POST", body: formData, headers: { "Idempotency-Key": inventoryUploadAttempt.key },
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (response.status === 404) {
            throw new Error("A API ativa está desatualizada. Feche a instância anterior e reinicie com iniciar_servidor.bat desta pasta.");
          }
          const detail = result.detail;
          throw new Error(Array.isArray(detail) ? detail.map(item => item.msg || item).join("; ") : (detail || "Falha ao atualizar as planilhas."));
        }

        inventoryUploadAttempt = null;
        const selectedSerial = currentEquipamento?.serial || "";
        const selectionRefresh = atualizarSelecaoAposSubstituirInventarios(selectedSerial);
        fecharModalAtualizarPlanilhas();
        [
          ["upload-endpoint-file", "upload-endpoint-name"],
          ["upload-details-file", "upload-details-name"]
        ].forEach(([inputId, nameId]) => {
          document.getElementById(inputId).value = "";
          document.getElementById(nameId).textContent = "Nenhum arquivo selecionado";
        });
        await Promise.all([
          carregarEstatisticas(),
          carregarUnidades(),
          carregarContagemHistoricoComparacoes()
        ]);
        const selectionRefreshStatus = await selectionRefresh;
        if (selectionRefreshStatus === "missing") {
          showToast("A série selecionada não está no inventário atualizado. Selecione outro equipamento.", "warning");
        } else if (selectionRefreshStatus === "unavailable") {
          showToast("Não foi possível confirmar a série no inventário atualizado. Faça uma nova busca.", "warning");
        }
        const comparison = result.comparacao || {};
        if (exportarHistoricoAutomaticamente) {
          const historyDate = String(comparison.horario_comparacao || "").slice(0, 10);
          try {
            await baixarHistoricoComparacoesExcel(historyDate);
            showToast("Histórico do dia exportado automaticamente.", "success");
          } catch (error) {
            console.warn("A atualização foi concluída, mas a exportação automática falhou:", error);
            showToast(
              `Atualização concluída, mas não foi possível exportar o histórico: ${error.message || "tente novamente pelo Histórico de Planilhas."}`,
              "warning",
            );
          }
        }
        abrirModalComparacaoPlanilhas(comparison);
      } catch (error) {
        console.error("Erro ao atualizar planilhas:", error);
        mostrarStatusUpload(error.message || "Não foi possível atualizar as planilhas.", true);
      } finally {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        if (autoExportInput) autoExportInput.disabled = false;
        document.getElementById("modal-atualizar-planilhas").removeAttribute("aria-busy");
        button.innerHTML = originalHtml;
        lucide.createIcons({ root: button });
      }
    }

    function renderizarTabelaComparacao(headers, rows, emptyMessage) {
      if (!rows.length) {
        return `<p class="text-sm text-slate-400 text-center py-5" role="status" aria-live="polite">${escapeHtml(emptyMessage)}</p>`;
      }
      const tableLabel = `Tabela de ${headers.join(", ")}`;
      const mobileCards = rows.map((row, index) => {
        const template = document.createElement("template");
        template.innerHTML = row.trim();
        const sourceRow = template.content.querySelector("tr");
        const cells = Array.from(sourceRow?.cells || []);
        if (!cells.length) return "";

        const titleLabel = headers[0] || "Registro";
        const titleText = cells[0].textContent.trim() || `Registro ${index + 1}`;
        const titleContent = cells[0].innerHTML || escapeHtml(titleText);
        const manualAliasRow = sourceRow.hasAttribute("data-manual-alias-row")
          ? ` data-manual-alias-row="${escapeHtml(sourceRow.dataset.manualAliasRow)}"`
          : "";
        const comparisonTargetAttributes = [
          "data-comparison-category",
          "data-comparison-item-id",
          "data-comparison-serial",
          "data-comparison-hostname",
        ].map(attribute => {
          const value = sourceRow.getAttribute(attribute);
          return value === null ? "" : ` ${attribute}="${escapeHtml(value)}"`;
        }).join("");
        const fields = cells.slice(1).map((cell, cellIndex) => {
          const label = headers[cellIndex + 1] || `Campo ${cellIndex + 2}`;
          const annotationClass = cell.querySelector("[data-comparison-annotation]")
            ? " comparison-mobile-card-field--annotation"
            : "";
          const manualAliasStatus = cell.hasAttribute("data-manual-alias-status")
            ? " data-manual-alias-status"
            : "";
          return `
            <div class="comparison-mobile-card-field${annotationClass}">
              <dt>${escapeHtml(label)}</dt>
              <dd${manualAliasStatus}>${cell.innerHTML}</dd>
            </div>`;
        }).join("");

        return `
          <article class="comparison-mobile-card" role="listitem"${manualAliasRow}${comparisonTargetAttributes}>
            <h5 class="comparison-mobile-card-title"><span class="sr-only">${escapeHtml(titleLabel)}: </span>${titleContent}</h5>
            ${fields ? `<dl class="comparison-mobile-card-fields">${fields}</dl>` : ""}
          </article>`;
      }).join("");
      return `
        <div class="accessible-table-wrap comparison-desktop-table rounded-lg border border-slate-800" role="region" aria-label="${escapeHtml(tableLabel)}" tabindex="0">
          <p class="comparison-table-scroll-hint px-3 pt-2">Role a tabela horizontalmente para consultar todas as colunas.</p>
          <table class="min-w-full text-left text-sm" aria-label="${escapeHtml(tableLabel)}">
            <thead class="bg-slate-950 text-slate-300"><tr>${headers.map(header => `<th scope="col" class="px-3 py-2.5 font-semibold whitespace-nowrap">${escapeHtml(header)}</th>`).join("")}</tr></thead>
            <tbody class="divide-y divide-slate-800">${rows.join("")}</tbody>
          </table>
        </div>
        <div class="comparison-mobile-list" role="list" aria-label="${escapeHtml(`${tableLabel} em cartões`)}">${mobileCards}</div>`;
    }

    function abrirModalComparacaoPlanilhas(comparison, navigationTarget = null) {
      const seriesSebrae = new Set([
        "BRJ135P5XS",
        "BRJ142QKBQ",
        "BRJ9435VMR",
        "BRJ9435VMF",
        "BRJ149SCJG",
      ]);
      const filtrarSeriesSebrae = items => (items || []).filter(item => {
        const serie = String(item.serie || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
        return !seriesSebrae.has(serie);
      });
      const filtrosAtualizacaoAplicados = comparison.filtros_atualizacao_aplicados === true;
      const ausentesEndpoint = filtrosAtualizacaoAplicados
        ? (comparison.ausentes_no_endpoint || [])
        : filtrarSeriesSebrae(comparison.ausentes_no_endpoint);
      const ausentesDetalhes = filtrosAtualizacaoAplicados
        ? (comparison.ausentes_em_detalhes || [])
        : filtrarSeriesSebrae(comparison.ausentes_em_detalhes);
      const divergenciasLocal = comparison.divergencias_local || [];
      const seriesSemMapa = comparison.series_sem_mapeamento || [];
      const semAcesso14Dias = comparison.sem_acesso_14_dias || [];
      const diasSemVerificacao = item => {
        const dias = Number(item?.dias_sem_verificacao);
        return Number.isFinite(dias) ? dias : 0;
      };
      const semAcesso14DiasOrdenados = [...semAcesso14Dias].sort((a, b) =>
        diasSemVerificacao(b) - diasSemVerificacao(a)
        || String(a.computador || "").localeCompare(String(b.computador || ""), "pt-BR")
      );
      const ambiguidades = comparison.correspondencias_ambiguas || [];
      const registrosAmbiguos = comparison.registros_ambiguos || [];
      const arquivo = comparison.arquivos_enviados || {};
      const apelidosAtualizados = comparison.apelidos_atualizados || [];
      const apelidosSemAtualizacao = comparison.apelidos_sem_atualizacao || [];
      const divergenciasApelidosManuais = comparison.divergencias_apelidos_manuais || [];
      const permitirAnotacoes = Boolean(comparison.evento_id)
        && (comparison.contexto_historico === true || comparison.historico_salvo === true);
      const renderizarCampoAnotacao = (item, contexto) => {
        if (!permitirAnotacoes) return "";
        const anotacoes = [
          item,
          ...(Array.isArray(item.anotacoes_associadas)
            ? item.anotacoes_associadas.filter(anotacao => typeof anotacao?.anotacao === "string" && anotacao.anotacao)
            : []),
        ];
        return `
        <td class="px-3 py-2 min-w-[240px] align-top">
          ${anotacoes.map((anotacao, index) => `
            <div class="${index ? "mt-2 border-t border-slate-700 pt-2" : ""}">
              ${index ? '<p class="mb-1 text-[10px] text-slate-400">Anotação anterior</p>' : ""}
              <textarea data-comparison-annotation data-annotation-id="${escapeHtml(anotacao.anotacao_id || "")}" rows="2" maxlength="2000" class="w-full min-w-[220px] rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-2 text-xs text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400" aria-label="${index ? "Anotação anterior para" : "Anotações para"} ${escapeHtml(contexto)}, neste resultado" placeholder="Escreva uma anotação...">${escapeHtml(anotacao.anotacao || "")}</textarea>
              <div class="mt-1">
                <p class="text-[10px] ${anotacao.anotacao ? "text-emerald-300" : "text-slate-500"}" data-annotation-status aria-live="polite">${anotacao.anotacao ? "Salvo automaticamente" : ""}</p>
                <button type="button" class="mt-1 rounded-md border border-rose-400/40 px-2 py-1 text-[10px] text-rose-200 hover:bg-rose-500/10" data-annotation-retry hidden aria-label="Tentar novamente a sincronização desta anotação">Tentar sincronizar novamente</button>
              </div>
            </div>`).join("")}
        </td>`;
      };
      const formatarMotivoRevisao = motivo => formatarNomeFonteHistorico(motivo || "Conferir associação.")
        .replace(/\bno endpoint\b/gi, "no Endpoint");
      const formatarFonteAusencia = fonte => formatarNomeFonteHistorico(fonte)
        .replace(/\bno endpoint\b/gi, "Endpoint")
        .replace(/\bna Simpress\b/gi, "Simpress");
      const formatarFonteAmbigua = fonte => formatarNomeFonteHistorico(fonte)
        .replace(/\bno endpoint\b/gi, "Endpoint");
      const atributosLinhaComparacao = (categoria, item) => `data-comparison-category="${escapeHtml(categoria)}" data-comparison-item-id="${escapeHtml(item?.anotacao_id || "")}" data-comparison-serial="${escapeHtml(item?.serie || "")}" data-comparison-hostname="${escapeHtml(item?.computador || item?.hostname || item?.apelido || "")}"`;
      const aliasReviewHeaders = ["Série", "Hostname no Endpoint", "Motivo", ...(permitirAnotacoes ? ["Anotações"] : [])];
      const annotationHeaders = permitirAnotacoes ? ["Anotações"] : [];

      document.getElementById("comparacao-planilhas-fontes").textContent =
        `no endpoint: ${formatarNomeFonteHistorico(arquivo.endpoint || "—")} · na Simpress: ${formatarNomeFonteHistorico(arquivo.detalhes || "—")}${comparison.horario_comparacao ? ` · ${formatarHorarioHistorico(comparison.horario_comparacao)}` : ""}`;

      const renderizarAusentes = (items, categoria) => items.map(item => `
        <tr class="text-slate-300" ${atributosLinhaComparacao(categoria, item)}>
          <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.computador)}</td>
          <td class="px-3 py-2 font-mono whitespace-nowrap">${escapeHtml(item.serie || "—")}</td>
          <td class="px-3 py-2">${escapeHtml(item.local_previsto || "—")}</td>
          <td class="px-3 py-2 text-amber-300">${escapeHtml((Array.isArray(item.ausente_em) ? item.ausente_em : [item.ausente_em || item.fonte_ausente]).filter(Boolean).map(formatarFonteAusencia).join(", "))}</td>
          ${renderizarCampoAnotacao(item, (item.computador ? `o hostname ${item.computador}, série ` : "a série ") + (item.serie || "vazia"))}
        </tr>`);

      const locationRows = divergenciasLocal.map(item => `
        <tr class="text-slate-300" ${atributosLinhaComparacao("divergencias_local", item)}>
          <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.computador)}</td>
          <td class="px-3 py-2 font-mono whitespace-nowrap">${escapeHtml(item.serie || "—")}</td>
          <td class="px-3 py-2">${escapeHtml(item.local_previsto)}</td>
          <td class="px-3 py-2">${escapeHtml(item.local_detalhes || "—")}</td>
          ${renderizarCampoAnotacao(item, `o computador ${item.computador || "sem hostname"}, série ${item.serie || "vazia"}`)}
        </tr>`);

      const semAcessoRows = semAcesso14DiasOrdenados.map(item => `
        <tr class="text-slate-300" ${atributosLinhaComparacao("sem_acesso_14_dias", item)}>
          <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.computador || "—")}</td>
          <td class="px-3 py-2 font-mono whitespace-nowrap">${escapeHtml(item.serie || "—")}</td>
          <td class="px-3 py-2 whitespace-nowrap">${escapeHtml(item.ultima_verificacao ? formatarHorarioHistorico(item.ultima_verificacao) : "—")}</td>
          <td class="px-3 py-2">${Number(item.dias_sem_verificacao || 0).toLocaleString("pt-BR")}</td>
          <td class="px-3 py-2">${escapeHtml(String(item.linha_endpoint || "—"))}</td>
          ${renderizarCampoAnotacao(item, `o hostname ${item.computador || "sem hostname"}, série ${item.serie || "vazia"}`)}
        </tr>`);

      const aliasUpdateRows = apelidosAtualizados.map(item => `
        <tr class="text-slate-300">
          <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.serie || "—")}</td>
          <td class="px-3 py-2 font-mono">${escapeHtml(item.apelido_anterior || "(vazio)")}</td>
          <td class="px-3 py-2 font-mono text-emerald-200">${escapeHtml(item.apelido_novo || "(vazio)")}</td>
          <td class="px-3 py-2 whitespace-nowrap">${escapeHtml(item.horario ? formatarHorarioHistorico(item.horario) : "—")}</td>
          <td class="px-3 py-2 text-[10px]">${escapeHtml(formatarNomeFonteHistorico(Object.values(item.arquivos_origem || {}).join(" · ") || "—"))}</td>
        </tr>`);

      const aliasReviewRows = apelidosSemAtualizacao.map(item => `
        <tr class="text-slate-300" ${atributosLinhaComparacao("apelidos_sem_atualizacao", item)}>
          <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.serie || "(vazia)")}</td>
          <td class="px-3 py-2 font-mono">${escapeHtml(item.computador || "—")}</td>
          <td class="px-3 py-2 text-amber-200">${escapeHtml(formatarMotivoRevisao(item.motivo))}</td>
          ${renderizarCampoAnotacao(item, (item.computador ? `o hostname ${item.computador}, série ` : "a série ") + (item.serie || "vazia"))}
        </tr>`);

      const manualAliasRows = divergenciasApelidosManuais.map((item, index) => {
        const resolvida = item.resolucao && item.resolucao !== "pendente";
        const status = item.resolucao === "manter"
          ? "Alteração manual mantida"
          : item.resolucao === "excluir"
            ? "Alteração manual removida"
            : item.resolucao === "substituida"
              ? "Atualizada por nova planilha"
              : "Pendente";
        const actions = !resolvida && comparison.evento_id
          ? `<div class="flex flex-wrap gap-1.5" data-manual-alias-actions>
              <button type="button" data-manual-alias-action="manter" data-manual-alias-index="${index}" class="px-2 py-1 rounded-md bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/25 text-emerald-200 text-[10px] font-semibold">Manter manual</button>
              <button type="button" data-manual-alias-action="excluir" data-manual-alias-index="${index}" class="px-2 py-1 rounded-md bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/25 text-rose-200 text-[10px] font-semibold">Excluir manual</button>
            </div>`
          : `<span class="text-[10px] text-slate-500">${resolvida ? "Concluído" : "Histórico indisponível"}</span>`;
        return `
          <tr class="text-slate-300" data-manual-alias-row="${index}">
            <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.serie || "—")}</td>
            <td class="px-3 py-2 font-mono text-cyan-200">${escapeHtml(item.apelido_manual || "(vazio)")}</td>
            <td class="px-3 py-2 font-mono">${escapeHtml(item.apelido_equipamentos_detalhes || (item.detalhes_encontrado ? "(vazio)" : "Série ausente"))}</td>
            <td class="px-3 py-2 font-mono">${escapeHtml(item.apelido_invall || (item.invall_encontrado ? "(vazio)" : "Série ausente"))}</td>
            <td class="px-3 py-2 text-[10px]" data-manual-alias-status>${escapeHtml(status)}</td>
            <td class="px-3 py-2">${actions}</td>
          </tr>`;
      });

      const unmappedRows = seriesSemMapa.map(item => `
        <tr class="text-slate-300" ${atributosLinhaComparacao("series_sem_mapeamento", item)}>
          <td class="px-3 py-2 font-mono text-white">${escapeHtml(item.serie)}</td>
          <td class="px-3 py-2">${Number(item.quantidade || 0)}</td>
          <td class="px-3 py-2 font-mono">${escapeHtml((item.exemplos || []).join(", "))}</td>
          ${renderizarCampoAnotacao(item, `a série ${item.serie || "vazia"}`)}
        </tr>`);

      const ambiguityRows = [
        ...ambiguidades.map(item => ({
          ...item,
          __categoriaPendencia: "correspondencias_ambiguas",
          tipo: item.tipo,
          chave: item.chave,
          fontes: (item.fontes || []).map(source =>
            `${formatarFonteAmbigua(source.fonte)}${source.quantidade ? ` (${source.quantidade} registros)` : source.serie ? ` — série ${source.serie}` : ""}`
          ).join(" · "),
          mensagem: formatarFonteAmbigua(item.mensagem || ""),
        })),
        ...registrosAmbiguos.map(item => ({
          ...item,
          __categoriaPendencia: "registros_ambiguos",
          tipo: "Presença ambígua",
          chave: `${item.computador || "Sem hostname"} · ${item.serie || "Sem série"}`,
          fontes: Object.entries(item.fontes || {}).filter(([, status]) => status === "ambíguo").map(([source]) => formatarFonteAmbigua(source)).join(" · "),
          mensagem: formatarFonteAmbigua(item.motivo || ""),
        })),
      ].map(item => `
        <tr class="text-slate-300" ${atributosLinhaComparacao(item.__categoriaPendencia, item)}>
          <td class="px-3 py-2 text-amber-200">${escapeHtml(item.tipo || "Ambiguidade")}</td>
          <td class="px-3 py-2 font-mono">${escapeHtml(item.chave || "—")}</td>
          <td class="px-3 py-2">${escapeHtml(item.fontes || "—")}</td>
          <td class="px-3 py-2">${escapeHtml(item.mensagem || "")}</td>
          ${renderizarCampoAnotacao(item, `${item.tipo || "ambiguidade"}: ${item.chave || "sem identificador"}`)}
        </tr>`);

      const categoriasAnotacoesSincronizadas = {
        sem_acesso_14_dias: "Sem acesso há 14 dias ou mais",
        ausentes_no_endpoint: "Sem correspondência — Endpoint",
        ausentes_em_detalhes: "Sem correspondência — Simpress",
        divergencias_local: "Localidade divergente",
        correspondencias_ambiguas: "Duplicidades e correspondências ambíguas",
        registros_ambiguos: "Duplicidades e correspondências ambíguas",
        series_sem_mapeamento: "Séries sem local definido",
        apelidos_sem_atualizacao: "Linhas mantidas para conferência",
      };
      const anotacoesSincronizadasRows = (comparison.anotacoes_sincronizadas || []).map(item => {
        const motivo = item.motivo ? formatarNomeFonteHistorico(item.motivo) : "";
        const identificador = [item.computador, item.serie && `série ${item.serie}`, motivo]
          .filter(Boolean)
          .join(" · ") || "Linha sem identificador";
        return `
          <tr class="text-slate-300">
            <td class="px-3 py-2 text-amber-200">${escapeHtml(categoriasAnotacoesSincronizadas[item.categoria] || "Histórico de planilhas")}</td>
            <td class="px-3 py-2">${escapeHtml(identificador)}</td>
            ${renderizarCampoAnotacao(item, `${categoriasAnotacoesSincronizadas[item.categoria] || "a linha"}, ${identificador}`)}
          </tr>`;
      });

      comparisonAnnotationSyncObservers.forEach(observer => observer.disconnect());
      comparisonAnnotationSyncObservers = [];
      document.getElementById("comparacao-planilhas-conteudo").innerHTML = comparison.somente_anotacoes_sincronizadas
        ? `
          <p class="text-xs text-cyan-200 bg-cyan-500/10 border border-cyan-500/25 rounded-lg px-3 py-2">Este clone contém as anotações sincronizadas. O resultado original e os arquivos da comparação não estão armazenados neste dispositivo.</p>
          <section class="space-y-2">
            <div><h4 class="text-sm font-bold text-amber-300">Anotações sincronizadas</h4><p class="text-[11px] text-slate-500">As anotações continuam vinculadas às linhas da atualização original.</p></div>
            ${renderizarTabelaComparacao(["Seção", "Linha", "Anotações"], anotacoesSincronizadasRows, "Nenhuma anotação sincronizada neste resultado.")}
          </section>`
        : `
        ${comparison.historico_salvo === false
          ? `<p class="text-xs text-amber-200 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2">${escapeHtml(comparison.aviso_historico || "Não foi possível salvar este resultado no histórico de comparações.")}</p>`
          : comparison.historico_salvo === true
            ? '<p class="text-xs text-cyan-200 bg-cyan-500/10 border border-cyan-500/25 rounded-lg px-3 py-2">Resultado registrado no Histórico de planilhas.</p>'
            : ""}
        <div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
          <div class="rounded-xl bg-slate-950 border border-slate-800 p-3"><p class="text-[10px] uppercase tracking-wide text-slate-500">Notebooks comparados</p><p class="text-xl font-bold text-white mt-1">${Number(comparison.total_endpoint || 0).toLocaleString("pt-BR")}</p></div>
          <div class="rounded-xl bg-rose-500/5 border border-rose-500/20 p-3"><p class="text-[10px] uppercase tracking-wide text-rose-300">Sem correspondência — no endpoint</p><p class="text-xl font-bold text-rose-200 mt-1">${ausentesEndpoint.length}</p></div>
          <div class="rounded-xl bg-amber-500/5 border border-amber-500/20 p-3"><p class="text-[10px] uppercase tracking-wide text-amber-300">Sem correspondência — na Simpress</p><p class="text-xl font-bold text-amber-200 mt-1">${ausentesDetalhes.length}</p></div>
          <div class="rounded-xl bg-amber-500/5 border border-amber-500/20 p-3"><p class="text-[10px] uppercase tracking-wide text-amber-300">Divergências de local</p><p class="text-xl font-bold text-amber-200 mt-1">${divergenciasLocal.length}</p></div>
          <div class="rounded-xl bg-yellow-500/5 border border-yellow-500/20 p-3"><p class="text-[10px] uppercase tracking-wide text-yellow-300">Duplicidades e ambiguidades</p><p class="text-xl font-bold text-yellow-200 mt-1">${ambiguityRows.length}</p></div>
          <div class="rounded-xl bg-sky-500/5 border border-sky-500/20 p-3"><p class="text-[10px] uppercase tracking-wide text-sky-300">Séries sem mapeamento</p><p class="text-xl font-bold text-sky-200 mt-1">${seriesSemMapa.length}</p></div>
          <div class="rounded-xl bg-emerald-500/5 border border-emerald-500/20 p-3"><p class="text-[10px] uppercase tracking-wide text-emerald-300">Apelidos/hostnames atualizados</p><p class="text-xl font-bold text-emerald-200 mt-1">${apelidosAtualizados.length}</p></div>
          <div class="rounded-xl bg-amber-500/5 border border-amber-500/20 p-3"><p class="text-[10px] uppercase tracking-wide text-amber-300">Apelidos para conferência</p><p class="text-xl font-bold text-amber-200 mt-1">${apelidosSemAtualizacao.length}</p></div>
          <div class="rounded-xl bg-violet-500/5 border border-violet-500/20 p-3"><p class="text-[10px] uppercase tracking-wide text-violet-300">Divergências manuais pendentes</p><p id="comparacao-divergencias-manuais-pendentes" class="text-xl font-bold text-violet-200 mt-1">${divergenciasApelidosManuais.filter(item => !item.resolucao || item.resolucao === "pendente").length}</p></div>
        </div>
        <section class="space-y-2">
          <div><h4 class="text-sm font-bold text-emerald-300">Apelidos/hostnames atualizados — no endpoint</h4><p class="text-[11px] text-slate-500">A lista compara os valores antes e depois pelo número de série.</p></div>
          ${renderizarTabelaComparacao(["Série", "Apelido anterior", "Novo apelido / hostname", "Horário", "Arquivos de origem"], aliasUpdateRows, "Nenhum apelido ou hostname mudou nesta atualização.")}
        </section>
        <section class="space-y-2">
          <div><h4 class="text-sm font-bold text-amber-300">Linhas mantidas para conferência</h4><p class="text-[11px] text-slate-500">Série vazia, ausente ou duplicada não é escolhida automaticamente; o apelido atual fica preservado.${permitirAnotacoes ? ` As anotações continuam vinculadas a esta linha e atualização. Em novas atualizações, são reaplicadas somente quando os dados correspondem exatamente na mesma seção e a anotação mais recente não está vazia ou em conflito. São salvas automaticamente${comparison.anotacoes_sync_ativa ? " e sincronizadas pela pasta OneDrive." : " neste dispositivo."}` : ""}</p></div>
          ${renderizarTabelaComparacao(aliasReviewHeaders, aliasReviewRows, "Nenhuma linha de apelido precisa de conferência.")}
        </section>
        <section class="space-y-2">
          <div><h4 class="text-sm font-bold text-violet-300">Divergências com apelidos alterados manualmente</h4><p class="text-[11px] text-slate-500">O apelido manual prevalece nas pesquisas e exportações. “Manter manual” registra a decisão; “Excluir manual” remove apenas o override desta série e volta a usar o valor das planilhas.</p></div>
          ${renderizarTabelaComparacao(["Série", "Apelido manual", "na Simpress", "no endpoint", "Situação", "Ação"], manualAliasRows, "Nenhuma divergência entre apelidos manuais e as planilhas enviadas.")}
        </section>
        <section class="space-y-2">
          <div><h4 class="text-sm font-bold text-rose-300">Sem acesso há 14 dias ou mais</h4><p class="text-[11px] text-slate-500">Notebook com última verificação com êxito igual ou anterior a 14 dias na data e hora desta atualização.</p><p class="text-[11px] text-slate-400">Atualização usada como referência: ${comparison.horario_comparacao ? `<time datetime="${escapeHtml(comparison.horario_comparacao)}">${escapeHtml(formatarHorarioHistorico(comparison.horario_comparacao))}</time>` : "data e hora indisponíveis"}.</p></div>
          ${renderizarTabelaComparacao(["Hostname/Apelido", "Série", "Última verificação com êxito", "Dias sem verificação", "Linha no endpoint", ...annotationHeaders], semAcessoRows, "Nenhum notebook está há 14 dias ou mais sem verificação com êxito.")}
        </section>
        <section class="space-y-2">
          <div><h4 class="text-sm font-bold text-rose-300">Equipamentos sem correspondência por fonte</h4><p class="text-[11px] text-slate-500">Cada lista mostra equipamentos que não têm correspondência segura naquela fonte. Divergências de local aparecem em seção própria.</p></div>
          <h5 class="text-xs font-semibold text-slate-300">Sem correspondência — Endpoint (${ausentesEndpoint.length})</h5>
          ${renderizarTabelaComparacao(["Hostname/Apelido", "Série", "Local previsto", "Sem correspondência em", ...annotationHeaders], renderizarAusentes(ausentesEndpoint, "ausentes_no_endpoint"), "Todos os equipamentos têm correspondência segura com Endpoint.")}
          <h5 class="text-xs font-semibold text-slate-300">Sem correspondência — Simpress (${ausentesDetalhes.length})</h5>
          ${renderizarTabelaComparacao(["Hostname/Apelido", "Série", "Local previsto", "Sem correspondência em", ...annotationHeaders], renderizarAusentes(ausentesDetalhes, "ausentes_em_detalhes"), "Todos os equipamentos têm correspondência segura com Simpress.")}
        </section>
        <section class="space-y-2">
          <div><h4 class="text-sm font-bold text-amber-300">Localidade divergente</h4><p class="text-[11px] text-slate-500">A localidade na Simpress é comparada com a classificação do hostname.</p></div>
          ${renderizarTabelaComparacao(["Computador", "Série", "Local previsto", "Local na Simpress", ...annotationHeaders], locationRows, "Nenhuma divergência de localidade encontrada.")}
        </section>
        <section class="space-y-2">
          <div><h4 class="text-sm font-bold text-yellow-300">Duplicidades e correspondências ambíguas</h4><p class="text-[11px] text-slate-500">Nenhuma linha é escolhida automaticamente quando a série se repete ou o hostname/Apelido não identifica uma correspondência única.</p></div>
          ${renderizarTabelaComparacao(["Ocorrência", "Série ou hostname/Apelido", "Fontes", "Tratamento", ...annotationHeaders], ambiguityRows, "Nenhuma duplicidade ou correspondência ambígua encontrada.")}
        </section>
        <section class="space-y-2">
          <div><h4 class="text-sm font-bold text-sky-300">Séries sem local definido</h4><p class="text-[11px] text-slate-500">Não há regra de localidade cadastrada para estes prefixos.</p></div>
          ${renderizarTabelaComparacao(["Série", "Quantidade", "Exemplos", ...annotationHeaders], unmappedRows, "Todas as séries têm mapeamento de localidade.")}
        </section>
        <p class="text-[11px] text-emerald-300">Equipamentos carregados na Simpress: ${Number(comparison.total_equipamentos_carregados || 0).toLocaleString("pt-BR")}. Backup das versões anteriores: <span class="font-mono">planilhas_entrada/${escapeHtml(comparison.backup_diretorio || "_backups")}</span>.</p>
      `;
      document.querySelectorAll("[data-manual-alias-action]").forEach(button => {
        button.addEventListener("click", () => {
          const item = divergenciasApelidosManuais[Number(button.dataset.manualAliasIndex)];
          if (item) resolverDivergenciaApelidoManual(comparison, item, button.dataset.manualAliasAction, button);
        });
      });
      const annotationsById = new Map();
      document.querySelectorAll("[data-comparison-annotation]").forEach(textarea => {
        const itemId = textarea.dataset.annotationId;
        const status = textarea.parentElement.querySelector("[data-annotation-status]");
        const retryButton = textarea.parentElement.querySelector("[data-annotation-retry]");
        window.HistoryAnnotationAutosave.attachAnnotationAutosave({
          textarea,
          status,
          retryButton,
          eventId: comparison.evento_id,
          itemId,
          send: ({ eventId, itemId: reviewItemId, annotation }) => fetch(
            "/api/historico-comparacoes/"
              + encodeURIComponent(eventId)
              + "/anotacoes/"
              + encodeURIComponent(reviewItemId),
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ anotacao: annotation }),
            }
          ),
        });
        if (itemId) {
          if (!annotationsById.has(itemId)) annotationsById.set(itemId, []);
          annotationsById.get(itemId).push(textarea);
        }
      });
      annotationsById.forEach(textareas => {
        const syncState = (source, target) => {
          if (target.value !== source.value) target.value = source.value;
          const sourceStatus = source.parentElement.querySelector("[data-annotation-status]");
          const targetStatus = target.parentElement.querySelector("[data-annotation-status]");
          if (sourceStatus && targetStatus) {
            if (targetStatus.textContent !== sourceStatus.textContent) targetStatus.textContent = sourceStatus.textContent;
            if (targetStatus.className !== sourceStatus.className) targetStatus.className = sourceStatus.className;
          }
          const sourceRetry = source.parentElement.querySelector("[data-annotation-retry]");
          const targetRetry = target.parentElement.querySelector("[data-annotation-retry]");
          if (sourceRetry && targetRetry) {
            targetRetry.hidden = sourceRetry.hidden;
            targetRetry.disabled = sourceRetry.disabled;
          }
        };

        textareas.forEach(source => {
          source.addEventListener("input", () => {
            textareas.forEach(target => {
              if (target !== source) syncState(source, target);
            });
          });
          const status = source.parentElement.querySelector("[data-annotation-status]");
          if (status && textareas.length > 1) {
            const observer = new MutationObserver(() => {
              textareas.forEach(target => {
                if (target !== source) syncState(source, target);
              });
            });
            observer.observe(status, { attributes: true, childList: true, characterData: true, subtree: true });
            comparisonAnnotationSyncObservers.push(observer);
          }
        });
      });
      abrirModalAcessivel("modal-comparacao-planilhas", '[aria-label="Fechar resultado"]', "fecharModalComparacaoPlanilhas");
      if (navigationTarget) requestAnimationFrame(() => navegarParaLinhaComparacao(navigationTarget));
    }

    function normalizarIdentificadorLinhaComparacao(value) {
      return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
    }

    function navegarParaLinhaComparacao(target) {
      const content = document.getElementById("comparacao-planilhas-conteudo");
      if (!content || !target?.category) return;
      const visibleRows = [...content.querySelectorAll("tr[data-comparison-category], .comparison-mobile-card[data-comparison-category]")]
        .filter(row => row.getClientRects().length > 0 && row.dataset.comparisonCategory === target.category);
      let row = target.itemId
        ? visibleRows.find(candidate => candidate.dataset.comparisonItemId === target.itemId)
        : null;
      if (!row) {
        const serial = normalizarIdentificadorLinhaComparacao(target.serial);
        const hostname = normalizarIdentificadorLinhaComparacao(target.hostname);
        row = visibleRows.find(candidate => {
          const sameSerial = serial && normalizarIdentificadorLinhaComparacao(candidate.dataset.comparisonSerial) === serial;
          const sameHostname = hostname && normalizarIdentificadorLinhaComparacao(candidate.dataset.comparisonHostname) === hostname;
          return sameSerial ? (!hostname || sameHostname) : (!serial && sameHostname);
        });
      }
      if (!row) return;
      const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      row.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
      motion?.reveal(row);
    }

    async function resolverDivergenciaApelidoManual(comparison, item, acao, botao) {
      if (!comparison.evento_id || !item.serie) {
        showToast("Este registro não permite resolver a divergência.", "error");
        return;
      }
      if (acao === "excluir" && !window.confirm(
        `Remover a alteração manual da série ${item.serie}? O apelido voltará ao hostname da fonte no endpoint, se preenchido, ou ao valor cadastrado na Simpress.`
      )) return;

      const row = botao.closest("[data-manual-alias-row]");
      const rowIndex = row?.dataset.manualAliasRow;
      const matchingRows = rowIndex === undefined
        ? [row].filter(Boolean)
        : [...document.querySelectorAll("#comparacao-planilhas-conteudo [data-manual-alias-row]")]
          .filter(candidate => candidate.dataset.manualAliasRow === rowIndex);
      const actionAreas = matchingRows
        .map(candidate => candidate.querySelector("[data-manual-alias-actions]"))
        .filter(Boolean);
      const buttons = actionAreas.length
        ? actionAreas.flatMap(actionArea => [...actionArea.querySelectorAll("button")])
        : [botao];
      buttons.forEach(button => {
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
      });
      try {
        const response = await fetch(
          `/api/historico-comparacoes/${encodeURIComponent(comparison.evento_id)}/apelido-manual/${encodeURIComponent(item.serie)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ acao }),
          }
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || "Não foi possível resolver a divergência.");

        item.resolucao = data.resolucao;
        const pendingCounter = document.getElementById("comparacao-divergencias-manuais-pendentes");
        if (pendingCounter) {
          pendingCounter.textContent = (comparison.divergencias_apelidos_manuais || []).filter(
            divergence => !divergence.resolucao || divergence.resolucao === "pendente"
          ).length;
        }
        matchingRows.forEach(candidate => {
          const status = candidate.querySelector("[data-manual-alias-status]");
          if (status) status.textContent = acao === "manter" ? "Alteração manual mantida" : "Alteração manual removida";
        });
        actionAreas.forEach(actionArea => {
          const concluido = document.createElement("span");
          concluido.className = "text-[10px] text-slate-500";
          concluido.textContent = "Concluído";
          actionArea.replaceWith(concluido);
        });

        const equipment = data.equipamento;
        const currentSerial = String(currentEquipamento?.serial || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
        const changedSerial = String(equipment?.serial || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
        if (equipment && currentSerial && currentSerial === changedSerial) {
          definirEquipamentoAtual(equipment);
          exibirEquipamento(equipment);
        }
        atualizarIndicadoresPosSalvamento();
        showToast(data.mensagem || "Divergência registrada no histórico.", "success");
      } catch (error) {
        console.error("Erro ao resolver divergência de apelido manual:", error);
        showToast(error.message || "Não foi possível resolver a divergência.", "error");
        buttons.forEach(button => {
          button.disabled = false;
          button.removeAttribute("aria-busy");
        });
      }
    }

    function irParaSecaoComparacao(sectionId) {
      document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function fecharModalComparacaoPlanilhas() {
      comparisonAnnotationSyncObservers.forEach(observer => observer.disconnect());
      comparisonAnnotationSyncObservers = [];
      fecharModalAcessivel("modal-comparacao-planilhas");
    }

    function definirTotalHistoricoComparacoes(total) {
      const valor = Number(total || 0);
      document.getElementById("badge-total-historico-comparacoes").textContent = valor;
      document.getElementById("total-historico-comparacoes").textContent = `${valor} ${valor === 1 ? "registro" : "registros"}`;
    }

    function definirEstadoDatasExportacaoHistorico(mensagem) {
      const select = document.getElementById("data-exportar-historico-comparacoes");
      const button = document.getElementById("btn-exportar-historico-comparacoes");
      if (select) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = mensagem;
        select.replaceChildren(option);
        select.value = "";
        select.disabled = true;
        select.removeAttribute("aria-busy");
      }
      if (button) button.disabled = true;
    }

    function atualizarDatasExportacaoHistorico(eventos) {
      const select = document.getElementById("data-exportar-historico-comparacoes");
      const button = document.getElementById("btn-exportar-historico-comparacoes");
      if (!select) return;

      const datas = [...new Set((Array.isArray(eventos) ? eventos : [])
        .filter(evento => evento && !evento.somente_anotacoes_sincronizadas)
        .map(evento => String(evento.horario || "").slice(0, 10))
        .filter(data => /^\d{4}-\d{2}-\d{2}$/.test(data)))];
      const dataSelecionada = select.value;
      select.replaceChildren();

      if (datas.length === 0) {
        definirEstadoDatasExportacaoHistorico("Sem datas disponíveis");
        return;
      }

      datas.forEach(data => {
        const [ano, mes, dia] = data.split("-");
        const option = document.createElement("option");
        option.value = data;
        option.textContent = `${dia}/${mes}/${ano}`;
        select.appendChild(option);
      });

      select.value = datas.includes(dataSelecionada) ? dataSelecionada : datas[0];
      select.disabled = false;
      select.removeAttribute("aria-busy");
      if (button) button.disabled = false;
    }

    async function carregarContagemHistoricoComparacoes() {
      try {
        const res = await fetch("/api/historico-comparacoes");
        if (!res.ok) throw new Error("Não foi possível carregar as datas do histórico.");
        const data = await res.json();
        definirTotalHistoricoComparacoes(data.total);
        atualizarDatasExportacaoHistorico(data.eventos);
      } catch (err) {
        console.warn("Não foi possível carregar a contagem do histórico de planilhas:", err);
        const select = document.getElementById("data-exportar-historico-comparacoes");
        if (!select?.value) definirEstadoDatasExportacaoHistorico("Datas indisponíveis");
      }
    }

    let operationalPendingState = { evento: null, rows: [] };

    function renderizarAnotacaoOperacional(item, contexto) {
      const itemId = String(item?.anotacao_id || "");
      if (!itemId) return "";
      return `<label class="block min-w-[220px] text-[10px] text-slate-400">Anotação sobre ${escapeHtml(contexto)}
        <textarea data-operational-annotation data-annotation-id="${escapeHtml(itemId)}" rows="2" maxlength="2000" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-2 text-xs text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none" placeholder="Escreva uma anotação...">${escapeHtml(item.anotacao || "")}</textarea>
        <span class="mt-1 block text-[10px] ${item.anotacao ? "text-emerald-300" : "text-slate-500"}" data-annotation-status aria-live="polite">${item.anotacao ? "Salvo automaticamente" : ""}</span>
        <button type="button" class="mt-1 rounded-md border border-rose-400/40 px-2 py-1 text-[10px] text-rose-200 hover:bg-rose-500/10" data-annotation-retry hidden aria-label="Tentar novamente a sincronização desta anotação">Tentar sincronizar novamente</button>
      </label>`;
    }

    function conectarAnotacoesOperacionais(root, fallbackEventId) {
      root.querySelectorAll("[data-operational-annotation]").forEach(textarea => {
        const eventId = textarea.dataset.eventId || fallbackEventId;
        const itemId = textarea.dataset.annotationId;
        const status = textarea.parentElement.querySelector("[data-annotation-status]");
        const retryButton = textarea.parentElement.querySelector("[data-annotation-retry]");
        window.HistoryAnnotationAutosave.attachAnnotationAutosave({
          textarea,
          status,
          retryButton,
          eventId,
          itemId,
          send: ({ eventId: targetEventId, itemId: targetItemId, annotation }) => fetch(
            `/api/historico-comparacoes/${encodeURIComponent(targetEventId)}/anotacoes/${encodeURIComponent(targetItemId)}`,
            { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ anotacao: annotation }) }
          ),
        });
      });
    }

    function fecharCentralPendencias() { fecharModalAcessivel("modal-central-pendencias"); }

    function renderizarCentralPendencias() {
      const lista = document.getElementById("lista-central-pendencias");
      const query = String(document.getElementById("filtro-operacional-pendencias").value || "").trim().toLocaleLowerCase("pt-BR");
      const selectedCategory = document.getElementById("categoria-operacional-pendencias").value;
      const categories = new Map();
      operationalPendingState.rows.forEach(row => categories.set(row.categoria, row.secao));
      const select = document.getElementById("categoria-operacional-pendencias");
      const currentOptions = [...select.options].map(option => option.value).join("|");
      const desiredOptions = ["", ...categories.keys()].join("|");
      if (currentOptions !== desiredOptions) {
        select.replaceChildren();
        const allOption = document.createElement("option");
        allOption.value = ""; allOption.textContent = "Todas as categorias"; select.appendChild(allOption);
        categories.forEach((label, key) => {
          const option = document.createElement("option"); option.value = key; option.textContent = label; select.appendChild(option);
        });
        select.value = selectedCategory;
      }
      const rows = operationalPendingState.rows.filter(row => {
        if (selectedCategory && row.categoria !== selectedCategory) return false;
        const searchable = JSON.stringify(row.item || {}).toLocaleLowerCase("pt-BR");
        return !query || searchable.includes(query) || String(row.secao || "").toLocaleLowerCase("pt-BR").includes(query);
      });
      lista.replaceChildren();
      if (!rows.length) {
        const empty = document.createElement("p"); empty.className = "py-8 text-center text-sm text-slate-400";
        empty.textContent = operationalPendingState.rows.length ? "Nenhuma pendência corresponde aos filtros." : "A atualização mais recente não tem pendências registradas.";
        lista.appendChild(empty); return;
      }
      lista.innerHTML = rows.map(row => {
        const item = row.item || {};
        const title = item.computador || item.hostname || item.apelido || item.chave || item.serie || "Linha para revisão";
        const serial = item.serie || item.serial || "";
        const location = item.local_simpress || item.local || item.local_previsto || item.cidade || "";
        const details = [
          item.motivo,
          item.ultima_verificacao && `Última verificação: ${item.ultima_verificacao}`,
          Number.isFinite(Number(item.dias_sem_verificacao)) && `Sem verificação há ${Number(item.dias_sem_verificacao)} dias`,
          item.local_simpress && item.local_previsto && `Local esperado: ${item.local_previsto} · na Simpress: ${item.local_simpress}`,
          item.ausente_em && `Sem correspondência: ${(Array.isArray(item.ausente_em) ? item.ausente_em : [item.ausente_em]).map(source => formatarNomeFonteHistorico(source).replace(/\bno endpoint\b/gi, "Endpoint").replace(/\bna Simpress\b/gi, "Simpress")).join(", ")}`,
          item.quantidade && `Ocorrências: ${item.quantidade}`,
        ].filter(Boolean).join(" · ");
        const context = `${title}${serial ? `, série ${serial}` : ""}`;
        return `<article class="rounded-xl border border-slate-800 bg-slate-950/70 p-4" data-pending-row>
          <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between"><div class="min-w-0">
            <p class="text-[10px] uppercase tracking-wide text-amber-300">${escapeHtml(row.secao)}</p>
            <h4 class="mt-1 break-words text-sm font-semibold text-white">${escapeHtml(title)}</h4>
            <p class="mt-1 text-xs text-slate-400">${serial ? `Série ${escapeHtml(serial)}` : "Série não informada"}${location ? ` · ${escapeHtml(location)}` : ""}</p>
            ${details ? `<p class="mt-2 text-xs text-slate-300">${escapeHtml(details)}</p>` : ""}
          </div><button type="button" data-pending-event="${escapeHtml(operationalPendingState.evento?.id || "")}" data-pending-category="${escapeHtml(row.categoria || "")}" data-pending-item-id="${escapeHtml(item.anotacao_id || "")}" data-pending-serial="${escapeHtml(serial)}" data-pending-hostname="${escapeHtml(item.computador || item.hostname || item.apelido || "")}" class="shrink-0 rounded-lg border border-cyan-400/25 bg-cyan-500/10 px-3 py-2 text-xs font-semibold text-cyan-200">Abrir atualização</button></div>
          <div class="mt-3">${renderizarAnotacaoOperacional(item, context)}</div>
        </article>`;
      }).join("");
      conectarAnotacoesOperacionais(lista, operationalPendingState.evento?.id);
      lista.querySelectorAll("[data-pending-event]").forEach(button => button.addEventListener("click", async () => {
        const eventId = button.dataset.pendingEvent;
        const target = {
          category: button.dataset.pendingCategory,
          itemId: button.dataset.pendingItemId,
          serial: button.dataset.pendingSerial,
          hostname: button.dataset.pendingHostname,
        };
        fecharCentralPendencias();
        if (eventId) await consultarHistoricoComparacao(eventId, button, target);
      }));
    }

    async function abrirCentralPendencias() {
      abrirModalAcessivel("modal-central-pendencias", '[aria-label="Fechar central de pendências"]', "fecharCentralPendencias");
      const list = document.getElementById("lista-central-pendencias");
      list.textContent = "Carregando pendências…";
      try {
        const response = await fetch("/api/operacoes/pendencias");
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || "Não foi possível carregar as pendências.");
        operationalPendingState = { evento: data.evento || null, rows: Array.isArray(data.pendencias) ? data.pendencias : [] };
        document.getElementById("central-pendencias-referencia").textContent = data.evento?.horario
          ? `Atualização usada como referência: ${formatarHorarioHistorico(data.evento.horario)} · ${operationalPendingState.rows.length} linhas para revisão`
          : "Nenhuma atualização de inventário está disponível no histórico.";
        renderizarCentralPendencias();
      } catch (error) {
        list.textContent = error.message || "Não foi possível carregar as pendências.";
      }
      const query = document.getElementById("filtro-operacional-pendencias");
      const category = document.getElementById("categoria-operacional-pendencias");
      if (!query.dataset.bound) { query.addEventListener("input", renderizarCentralPendencias); query.dataset.bound = "true"; }
      if (!category.dataset.bound) { category.addEventListener("change", renderizarCentralPendencias); category.dataset.bound = "true"; }
    }

    function fecharEvolucaoAtualizacoes() { fecharModalAcessivel("modal-evolucao-atualizacoes"); }

    function renderizarEvolucaoAtualizacoes(data) {
      const target = document.getElementById("resultado-evolucao-atualizacoes");
      const labels = { novos: "Novos", continuam: "Continuam", resolvidos: "Deixaram de aparecer" };
      const colors = {
        novos: "border-rose-500/20 bg-rose-500/5 text-rose-300",
        continuam: "border-amber-500/20 bg-amber-500/5 text-amber-300",
        resolvidos: "border-emerald-500/20 bg-emerald-500/5 text-emerald-300",
      };
      const rows = data.mudancas || {};
      target.innerHTML = `<p class="text-xs text-slate-400">De ${escapeHtml(formatarHorarioHistorico(data.anterior?.horario))} para ${escapeHtml(formatarHorarioHistorico(data.atual?.horario))}</p>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">${Object.keys(labels).map(key => `<div class="rounded-lg border ${colors[key]} p-3"><p class="text-xs">${labels[key]}</p><p class="mt-1 text-xl font-bold text-white">${Number(data.contagens?.[key] || 0)}</p></div>`).join("")}</div>
        ${Object.keys(labels).map(key => `<section><h4 class="mb-2 text-sm font-semibold text-slate-200">${labels[key]}</h4>${(rows[key] || []).length ? `<ul class="space-y-1">${rows[key].map(row => {
          const item = row.item || {}; const identity = item.computador || item.hostname || item.serie || item.chave || "Linha sem identificador";
          const serial = item.serie ? ` · ${item.serie}` : "";
          return `<li class="rounded-lg border border-slate-800 bg-slate-950/70 p-3 text-xs text-slate-200"><span class="font-medium">${escapeHtml(row.secao)}</span> · ${escapeHtml(identity + serial)}${row.evento_id ? ` <button type="button" data-evolution-event="${escapeHtml(row.evento_id)}" class="ml-2 text-cyan-300 underline">Abrir resultado</button>` : ""}${renderizarAnotacaoOperacional(item, `${identity}${serial}`)}</li>`;
        }).join("")}</ul>` : `<p class="rounded-lg border border-slate-800 bg-slate-950/50 p-3 text-xs text-slate-500">Nenhum caso nesta categoria.</p>`}</section>`).join("")}`;
      const rowsWithEvents = [...target.querySelectorAll("[data-evolution-event]")];
      rowsWithEvents.forEach(button => button.addEventListener("click", async () => {
        const eventId = button.dataset.evolutionEvent;
        fecharEvolucaoAtualizacoes();
        await consultarHistoricoComparacao(eventId, button);
      }));
      target.querySelectorAll("[data-operational-annotation]").forEach(textarea => {
        const parent = textarea.closest("li");
        const eventId = parent?.querySelector("[data-evolution-event]")?.dataset.evolutionEvent;
        if (eventId) textarea.dataset.eventId = eventId;
      });
      conectarAnotacoesOperacionais(target, "");
    }

    async function compararEvolucaoSelecionada() {
      const previous = document.getElementById("evolucao-anterior").value;
      const current = document.getElementById("evolucao-atual").value;
      const target = document.getElementById("resultado-evolucao-atualizacoes");
      target.textContent = "Comparando atualizações…";
      try {
        const query = new URLSearchParams({ anterior: previous, atual: current });
        const response = await fetch(`/api/operacoes/evolucao?${query.toString()}`);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || "Não foi possível comparar as atualizações.");
        renderizarEvolucaoAtualizacoes(data);
      } catch (error) { target.textContent = error.message || "Não foi possível comparar as atualizações."; }
    }

    async function abrirEvolucaoAtualizacoes() {
      abrirModalAcessivel("modal-evolucao-atualizacoes", '[aria-label="Fechar evolução das atualizações"]', "fecharEvolucaoAtualizacoes");
      const target = document.getElementById("resultado-evolucao-atualizacoes");
      target.textContent = "Carregando atualizações…";
      try {
        const response = await fetch("/api/historico-comparacoes");
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || "Não foi possível carregar o histórico.");
        const events = (data.eventos || []).filter(event => event.tipo !== "restauracao" && !event.somente_anotacoes_sincronizadas);
        const previous = document.getElementById("evolucao-anterior");
        const current = document.getElementById("evolucao-atual");
        [previous, current].forEach(select => {
          select.replaceChildren();
          events.forEach(event => { const option = document.createElement("option"); option.value = event.id; option.textContent = formatarHorarioHistorico(event.horario); select.appendChild(option); });
        });
        if (events.length < 2) { target.textContent = "São necessárias pelo menos duas atualizações completas para comparar a evolução."; return; }
        current.value = events[0].id; previous.value = events[1].id;
        if (!previous.dataset.bound) {
          document.getElementById("form-evolucao-atualizacoes").addEventListener("submit", event => { event.preventDefault(); compararEvolucaoSelecionada(); });
          previous.dataset.bound = "true";
        }
        await compararEvolucaoSelecionada();
      } catch (error) { target.textContent = error.message || "Não foi possível carregar as atualizações."; }
    }

    function fecharAcompanhamentoChamados() { fecharModalAcessivel("modal-acompanhamento-chamados"); }

    function formatarListaChamados(values) {
      const items = Array.isArray(values) ? values.filter(Boolean) : [];
      return items.length ? items.map(escapeHtml).join(", ") : "Não informado";
    }

    function compararOrdensServicoDecrescente(left, right) {
      const leftText = String(left || "").trim();
      const rightText = String(right || "").trim();
      const numericValue = value => {
        const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
        if (/[A-Za-z]/.test(normalized)) return null;
        const digits = normalized.replace(/\D/g, "");
        return digits ? BigInt(digits) : null;
      };
      const leftNumber = numericValue(leftText);
      const rightNumber = numericValue(rightText);
      if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) {
        return leftNumber > rightNumber ? -1 : 1;
      }
      if (leftNumber !== null && rightNumber === null) return -1;
      if (leftNumber === null && rightNumber !== null) return 1;
      return rightText.localeCompare(leftText, "pt-BR", { numeric: true, sensitivity: "base" });
    }

    function obterOrdemServicoPrincipalChamado(record) {
      const simpress = record?.simpress || {};
      const oracle = Array.isArray(record?.oracle) ? record.oracle : [];
      const values = [
        ...(Array.isArray(simpress.ordens_servico) ? simpress.ordens_servico : []),
        ...(Array.isArray(record?.ordens_servico_conferidas) ? record.ordens_servico_conferidas : []),
        ...oracle.map(ticket => ticket?.ordem_servico),
      ];
      const missingLabels = new Set(["nao informado", "nao informada", "sem os", "n/a", "na"]);
      const orders = values
        .map(value => String(value || "").trim())
        .filter(value => value && !missingLabels.has(normalizarFiltroChamados(value)));
      return orders.reduce((highest, value) => (
        !highest || compararOrdensServicoDecrescente(value, highest) < 0 ? value : highest
      ), "");
    }

    function compararChamadosPorOrdemServicoDecrescente(left, right) {
      const leftOrder = obterOrdemServicoPrincipalChamado(left);
      const rightOrder = obterOrdemServicoPrincipalChamado(right);
      if (!leftOrder && rightOrder) return 1;
      if (leftOrder && !rightOrder) return -1;
      return compararOrdensServicoDecrescente(leftOrder, rightOrder)
        || String(left?.serie || "").localeCompare(String(right?.serie || ""), "pt-BR");
    }

    function formatarOrdensServico(values) {
      const items = Array.isArray(values) ? values.filter(Boolean) : [];
      return formatarListaChamados(items.sort(compararOrdensServicoDecrescente));
    }

    function formatarPrevisoesEntrega(values) {
      const items = Array.isArray(values) ? values.filter(Boolean) : [];
      if (!items.length) return "Não informado";
      return items.map(value => {
        const parsed = dataAtualizacaoChamado(value);
        return escapeHtml(parsed ? parsed.toLocaleDateString("pt-BR") : value);
      }).join(", ");
    }

    function resumirDescricaoChamado(value, limit = 150) {
      const description = String(value || "").replace(/\s+/g, " ").trim();
      return description.length > limit ? `${description.slice(0, limit).trimEnd()}…` : description;
    }

    function normalizarFiltroChamados(value) {
      return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toLocaleLowerCase("pt-BR");
    }

    function chamadosClienteInformados(values) {
      return (Array.isArray(values) ? values : []).filter(value => {
        const normalized = normalizarFiltroChamados(value);
        return normalized && normalized !== "nao informado";
      });
    }

    function valoresChamado(record) {
      if (Array.isArray(record)) return record.flatMap(valoresChamado);
      if (record && typeof record === "object") return Object.values(record).flatMap(valoresChamado);
      return record == null ? [] : [String(record)];
    }

    function dataAtualizacaoChamado(value) {
      const text = String(value || "").trim();
      if (!text) return null;
      const isoDate = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
      if (isoDate) return new Date(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3]));
      const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(text);
      if (match) return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]), Number(match[4] || 0), Number(match[5] || 0));
      const direct = new Date(text);
      if (!Number.isNaN(direct.getTime())) return direct;
      return null;
    }

    function classificarAtencaoChamado(record) {
      const oracle = Array.isArray(record.oracle) ? record.oracle : [];
      const encerrados = ["conclu", "encerr", "finaliz", "cancel", "resolvid", "fechad", "closed", "complete"];
      const ativos = oracle.filter(ticket => !encerrados.some(token => normalizarFiltroChamados(`${ticket.status || ""} ${ticket.sub_status || ""}`).includes(token)));
      const datas = ativos.map(ticket => dataAtualizacaoChamado(ticket.ultima_atualizacao)).filter(Boolean);
      const ultima = datas.length ? new Date(Math.max(...datas.map(value => value.getTime()))) : null;
      const hoje = new Date();
      const hojeUtc = Date.UTC(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
      const ultimaUtc = ultima ? Date.UTC(ultima.getFullYear(), ultima.getMonth(), ultima.getDate()) : 0;
      const idade = ultima ? Math.max(0, Math.floor((hojeUtc - ultimaUtc) / 86400000)) : null;
      const desatualizado = ativos.length > 0 && (idade === null || idade >= 3);
      const prioridade = desatualizado ? 0 : 1;
      const motivos = desatualizado
        ? [idade === null ? "Sem data de atualização" : `Sem atualização há ${idade} dias`]
        : [];
      return {
        prioridade,
        em_atencao: desatualizado,
        desatualizado,
        dias_sem_atualizacao: idade,
        ultima_atualizacao: ultima ? ultima.toISOString().slice(0, 10) : "",
        motivo: motivos.join(" · ") || "Em acompanhamento",
      };
    }

    function obterFiltrosChamados() {
      return {
        relation: document.getElementById("relacao-acompanhamento-chamados").value || "",
        status: document.getElementById("status-acompanhamento-chamados").value || "",
        queue: document.getElementById("fila-acompanhamento-chamados").value || "",
        city: document.getElementById("cidade-acompanhamento-chamados").value || "",
        provider: document.getElementById("atendimento-acompanhamento-chamados").value || "",
        search: document.getElementById("filtro-acompanhamento-chamados").value.trim(),
        stale_days: 3,
        age_filter: document.getElementById("idade-acompanhamento-chamados").value || "",
        attention_only: Boolean(document.getElementById("somente-atencao-chamados").checked),
      };
    }

    function cidadesDoChamado(record) {
      const deliveryCities = record?.simpress?.cidades_entrega;
      const values = [
        ...(Array.isArray(deliveryCities) ? deliveryCities : deliveryCities ? [deliveryCities] : []),
        ...(Array.isArray(record?.oracle) ? record.oracle.map(ticket => ticket?.cidade) : []),
      ].map(value => String(value || "").trim()).filter(Boolean);
      return [...new Map(values.map(value => [normalizarFiltroChamados(value), value])).values()];
    }

    function atendimentosDoChamado(record) {
      const providers = new Set();
      (Array.isArray(record?.oracle) ? record.oracle : []).forEach(ticket => {
        const branch = normalizarFiltroChamados(ticket?.nome_filial || "");
        if (branch.includes("parceiro")) providers.add("Parceiro");
        else if (branch.includes("simpress")) providers.add("Simpress");
        else providers.add(branch ? "Outro" : "Não informado");
      });
      return [...providers].sort((left, right) => left.localeCompare(right, "pt-BR"));
    }

    function idadeAtualizacaoChamado(ticket) {
      const encerrar = ["conclu", "encerr", "finaliz", "cancel", "resolvid", "fechad", "closed", "complete"];
      if (encerrar.some(token => normalizarFiltroChamados(`${ticket?.status || ""} ${ticket?.sub_status || ""}`).includes(token))) {
        return { encerrado: true, dias: null, rotulo: "Chamado encerrado" };
      }
      const ultima = dataAtualizacaoChamado(ticket?.ultima_atualizacao);
      if (!ultima) return { encerrado: false, dias: null, rotulo: "Sem data de atualização" };
      const hoje = new Date();
      const hojeUtc = Date.UTC(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
      const ultimaUtc = Date.UTC(ultima.getFullYear(), ultima.getMonth(), ultima.getDate());
      const dias = Math.max(0, Math.floor((hojeUtc - ultimaUtc) / 86400000));
      return { encerrado: false, dias, rotulo: dias === 1 ? "Sem atualização há 1 dia" : `Sem atualização há ${dias} dias` };
    }

    function atualizarOpcoesFiltroChamados(id, values, placeholder) {
      const select = document.getElementById(id);
      const previous = select.value;
      const unique = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = placeholder;
      const options = unique.map(value => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        return option;
      });
      select.replaceChildren(empty, ...options);
      select.value = unique.includes(previous) ? previous : "";
    }

    function renderizarHistoricoAcompanhamentoChamados(data) {
      const selector = document.getElementById("versao-acompanhamento-chamados");
      const events = Array.isArray(data.historico) ? data.historico : [];
      historicoAcompanhamentoChamados = events;
      const selectedId = data.snapshot_id || "";
      const options = events.map(event => {
        const option = document.createElement("option");
        option.value = event.id || "";
        const sources = event.fontes || {};
        const simpressName = typeof sources.simpress === "string" ? sources.simpress : sources.simpress?.arquivo;
        const oracleName = typeof sources.oracle === "string" ? sources.oracle : sources.oracle?.arquivo;
        const files = [simpressName, oracleName].filter(Boolean).join(" + ");
        option.textContent = `${formatarHorarioHistorico(event.atualizado_em)}${files ? ` · ${files}` : ""}`;
        return option;
      });
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "Nenhuma importação";
      selector.replaceChildren(empty, ...options);
      selector.value = selectedId;
      selector.disabled = events.length === 0;
      document.getElementById("btn-excluir-importacoes-antigas-chamados").disabled = events.length <= 1;
      if (!selectedId && events.length) selector.value = events[0].id;
    }

    function renderizarEvolucaoChamados(data) {
      const target = document.getElementById("evolucao-acompanhamento-chamados");
      const counts = data.contagens || {};
      const changes = data.mudancas || {};
      const changed = Array.isArray(changes.alterados) ? changes.alterados : [];
      const newRows = Array.isArray(changes.novos) ? changes.novos : [];
      const absent = Array.isArray(changes.ausentes_arquivo) ? changes.ausentes_arquivo : [];
      const details = [
        ...newRows.slice(0, 5).map(serial => `<li><strong>Nova série:</strong> ${escapeHtml(serial)}</li>`),
        ...changed.slice(0, 8).map(row => `<li><strong>${escapeHtml(row.serie)}:</strong> ${row.campos.map(field => escapeHtml(field.campo)).join(", ")}</li>`),
        ...absent.slice(0, 5).map(serial => `<li><strong>Não consta na planilha atual:</strong> ${escapeHtml(serial)}</li>`),
      ];
      target.innerHTML = `<p class="font-semibold text-white">Comparação com a versão anterior · ${Number(counts.novos) || 0} novas · ${Number(counts.alterados) || 0} alteradas · ${Number(counts.iguais) || 0} sem mudança · ${Number(counts.ausentes_arquivo) || 0} ausentes</p><p class="mt-1 text-[10px] text-amber-200">${escapeHtml(data.aviso_ausentes || "Ausência na planilha não confirma resolução.")}</p>${details.length ? `<ul class="mt-2 list-disc space-y-1 pl-5 text-[10px] text-slate-300">${details.join("")}</ul>` : ""}`;
    }

    async function carregarEvolucaoChamados(snapshotId) {
      const target = document.getElementById("evolucao-acompanhamento-chamados");
      const index = historicoAcompanhamentoChamados.findIndex(event => event.id === snapshotId);
      const older = index >= 0 ? historicoAcompanhamentoChamados[index + 1] : null;
      if (!older) {
        target.textContent = historicoAcompanhamentoChamados.length > 1
          ? "Esta é a importação mais antiga disponível. Selecione uma versão mais recente para comparar."
          : "A primeira importação ficará registrada aqui para comparação com as próximas planilhas.";
        return;
      }
      target.textContent = "Comparando esta versão com a anterior…";
      try {
        const query = new URLSearchParams({ anterior: older.id, atual: snapshotId });
        const response = await fetch(`/api/operacoes/chamados/evolucao?${query.toString()}`);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || "Não foi possível comparar as versões dos chamados.");
        renderizarEvolucaoChamados(data);
      } catch (error) { target.textContent = error.message || "Não foi possível comparar as versões dos chamados."; }
    }

    function renderizarLinhaDoTempoChamado(events) {
      const fields = [
        ["pedidos_simpress", "Pedido Simpress"],
        ["solicitacoes_oracle", "Solicitação Oracle"],
        ["ordens_venda_simpress", "OV Simpress"],
        ["ordens_servico_simpress", "OS Simpress"],
        ["ordens_servico_oracle", "OS Oracle"],
        ["status_simpress", "Status Simpress"],
        ["status_oracle", "Status Oracle"],
        ["filas_oracle", "Fila Oracle"],
        ["atualizacoes_oracle", "Última atualização Oracle"],
      ];
      const formatValue = value => Array.isArray(value) ? value.filter(Boolean).join(", ") : String(value || "");
      if (!Array.isArray(events) || !events.length) return '<p class="py-3 text-xs text-slate-400">Não há versões anteriores para esta série.</p>';
      return `<div class="space-y-2 py-2">${events.map(event => {
        const state = event.estado || {};
        const values = fields.map(([key, label]) => [label, formatValue(state[key])]).filter(([, value]) => value);
        const changes = Array.isArray(event.mudancas) ? event.mudancas : [];
        return `<article class="rounded-lg border border-slate-800 bg-slate-950/70 p-3" data-ticket-timeline-event="${escapeHtml(event.item_id || "")}">
          <div class="flex flex-wrap items-center justify-between gap-2"><strong class="text-xs text-white">${escapeHtml(event.tipo || "Atualização")}</strong><time class="text-[10px] text-slate-400">${escapeHtml(formatarHorarioHistorico(event.atualizado_em))}</time></div>
          <dl class="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">${values.map(([label, value]) => `<div class="min-w-0 text-[10px]"><dt class="inline font-semibold text-slate-400">${label}: </dt><dd class="inline break-words text-slate-200">${escapeHtml(value)}</dd></div>`).join("")}</dl>
          <div class="mt-2 text-[10px] text-slate-300"><span class="font-semibold text-cyan-200">Mudanças:</span> ${changes.length ? changes.map(change => `${escapeHtml(change.campo)}${change.anterior?.length ? ` (${escapeHtml(formatValue(change.anterior))} → ` : " ("}${escapeHtml(formatValue(change.atual))})`).join(" · ") : "sem alterações nos campos acompanhados"}</div>
          <label class="mt-3 block text-[10px] text-slate-400">Próxima ação ou o que já foi feito<textarea data-ticket-timeline-annotation data-event-id="${escapeHtml(event.snapshot_id || "")}" data-annotation-id="${escapeHtml(event.item_id || "")}" rows="2" maxlength="2000" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-2 text-xs text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none" placeholder="Ex.: cobrar atualização do parceiro, OS concluída...">${escapeHtml(event.anotacao || "")}</textarea><span class="mt-1 block text-[10px] text-slate-500" data-annotation-status aria-live="polite">${event.anotacao ? "Anotação salva" : ""}</span><button type="button" class="mt-1 rounded-md border border-rose-400/40 px-2 py-1 text-[10px] text-rose-200 hover:bg-rose-500/10" data-annotation-retry hidden aria-label="Tentar novamente a sincronização desta anotação">Tentar sincronizar novamente</button></label>
        </article>`;
      }).join("")}</div>`;
    }

    function conectarAnotacoesLinhaDoTempo(root) {
      root.querySelectorAll("[data-ticket-timeline-annotation]").forEach(textarea => {
        const eventId = textarea.dataset.eventId;
        const itemId = textarea.dataset.annotationId;
        const status = textarea.parentElement.querySelector("[data-annotation-status]");
        const retryButton = textarea.parentElement.querySelector("[data-annotation-retry]");
        window.HistoryAnnotationAutosave.attachAnnotationAutosave({
          textarea,
          status,
          retryButton,
          eventId,
          itemId,
          send: ({ eventId: targetEventId, itemId: targetItemId, annotation }) => fetch(
            `/api/operacoes/chamados/linha-do-tempo/${encodeURIComponent(targetEventId)}/${encodeURIComponent(targetItemId)}`,
            { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ anotacao: annotation }) }
          ),
        });
      });
    }

    async function carregarLinhaDoTempoChamado(details) {
      if (!details?.open || details.dataset.ticketTimelineLoaded === "true") return;
      const serial = details.dataset.timelineSerial || "";
      const snapshotId = details.dataset.snapshotId || acompanhamentoChamadosAtual?.snapshot_id || "";
      const body = details.querySelector("[data-ticket-timeline-body]");
      if (!body) return;
      body.innerHTML = '<p class="py-3 text-xs text-slate-400" role="status">Carregando histórico da série…</p>';
      try {
        const params = new URLSearchParams({ snapshot_id: snapshotId });
        const response = await fetch(`/api/operacoes/chamados/linha-do-tempo/${encodeURIComponent(serial)}?${params.toString()}`);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || "Não foi possível carregar a linha do tempo.");
        body.innerHTML = renderizarLinhaDoTempoChamado(data.eventos);
        conectarAnotacoesLinhaDoTempo(body);
        details.dataset.ticketTimelineLoaded = "true";
      } catch (error) {
        body.innerHTML = `<p class="py-3 text-xs text-rose-300" role="alert">${escapeHtml(error.message || "Não foi possível carregar a linha do tempo.")}</p>`;
      }
    }

    function renderizarAcompanhamentoChamados() {
      const data = acompanhamentoChamadosAtual || {};
      const summary = data.resumo || {};
      const sources = data.fontes || {};
      const list = document.getElementById("lista-acompanhamento-chamados");
      const summaryTarget = document.getElementById("resumo-acompanhamento-chamados");
      const summaryCards = [
        ["Séries", summary.series_total],
        ["OS conferidas", summary.conferidas],
        ["OS divergentes", summary.divergentes],
        ["Só na Simpress", summary.somente_simpress],
        ["Só no Oracle", summary.somente_oracle],
        ["Sem OS", summary.sem_os],
      ];
      summaryTarget.innerHTML = `<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">${summaryCards.map(([label, count]) => `<div class="rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2"><p class="text-[10px] text-slate-400">${label}</p><p class="mt-1 text-base font-semibold text-white">${Number(count) || 0}</p></div>`).join("")}</div>
        <p class="mt-2 text-[10px] text-slate-500">Simpress: ${escapeHtml(sources.simpress?.arquivo || "aguardando importação")} · Oracle: ${escapeHtml(sources.oracle?.arquivo || "aguardando importação")}${data.atualizado_em ? ` · atualizado em ${escapeHtml(formatarHorarioHistorico(data.atualizado_em))}` : ""}</p>`;

      const filters = obterFiltrosChamados();
      const query = normalizarFiltroChamados(filters.search);
      const statuses = [];
      const queues = [];
      const cities = [];
      const providers = [];
      (Array.isArray(data.chamados) ? data.chamados : []).forEach(record => (record.oracle || []).forEach(ticket => {
        if (ticket.status) statuses.push(ticket.status);
        if (ticket.fila) queues.push(ticket.fila);
      }));
      (Array.isArray(data.chamados) ? data.chamados : []).forEach(record => {
        cities.push(...cidadesDoChamado(record));
        providers.push(...atendimentosDoChamado(record));
      });
      atualizarOpcoesFiltroChamados("status-acompanhamento-chamados", statuses, "Todos");
      atualizarOpcoesFiltroChamados("fila-acompanhamento-chamados", queues, "Todas");
      atualizarOpcoesFiltroChamados("cidade-acompanhamento-chamados", cities, "Todas");
      atualizarOpcoesFiltroChamados("atendimento-acompanhamento-chamados", providers, "Todos");
      const records = (Array.isArray(data.chamados) ? data.chamados : []).filter(record => {
        const oracle = Array.isArray(record.oracle) ? record.oracle : [];
        const attention = classificarAtencaoChamado(record);
        if (filters.relation && record.relacao !== filters.relation) return false;
        if (filters.city && !cidadesDoChamado(record).some(city => normalizarFiltroChamados(city) === normalizarFiltroChamados(filters.city))) return false;
        if (filters.provider && !atendimentosDoChamado(record).some(provider => normalizarFiltroChamados(provider) === normalizarFiltroChamados(filters.provider))) return false;
        if ((filters.status || filters.queue) && !oracle.some(ticket =>
          (!filters.status || normalizarFiltroChamados(ticket.status) === normalizarFiltroChamados(filters.status))
          && (!filters.queue || normalizarFiltroChamados(ticket.fila) === normalizarFiltroChamados(filters.queue)))) return false;
        if (filters.attention_only && !attention.em_atencao) return false;
        if (filters.age_filter === "sem_data" && (!attention.desatualizado || attention.dias_sem_atualizacao !== null)) return false;
        if (/^\d+$/.test(filters.age_filter) && (attention.dias_sem_atualizacao === null || attention.dias_sem_atualizacao < Number(filters.age_filter))) return false;
        const searchable = normalizarFiltroChamados(valoresChamado(record).join(" "));
        return !query || searchable.includes(query);
      });
      records.sort(compararChamadosPorOrdemServicoDecrescente);
      document.getElementById("contagem-acompanhamento-chamados").textContent = `Exibindo ${records.length} de ${Array.isArray(data.chamados) ? data.chamados.length : 0} séries · OS da maior para a menor, sem OS no final`;
      const triageTarget = document.getElementById("triagem-diaria-acompanhamento-chamados");
      const activeRecords = records.filter(record => (Array.isArray(record.oracle) ? record.oracle : []).some(ticket => !idadeAtualizacaoChamado(ticket).encerrado));
      const attentionRecords = activeRecords.filter(record => classificarAtencaoChamado(record).em_atencao);
      const missingDateRecords = activeRecords.filter(record => classificarAtencaoChamado(record).dias_sem_atualizacao === null);
      const freshRecords = activeRecords.length - attentionRecords.length;
      const triageCards = [
        ["Chamados ativos", activeRecords.length, "text-white"],
        ["Sem atualização há 3+ dias", attentionRecords.length - missingDateRecords.length, "text-amber-200"],
        ["Sem data de atualização", missingDateRecords.length, "text-rose-200"],
        ["Atualizados há menos de 3 dias", freshRecords, "text-emerald-200"],
      ];
      triageTarget.innerHTML = `<div class="rounded-lg border border-slate-800 bg-slate-950/40 p-2"><div class="mb-2 flex flex-wrap items-baseline justify-between gap-2"><h4 class="text-[11px] font-semibold text-slate-200">Triagem diária</h4><p class="text-[10px] text-slate-500">Fila de atenção: chamados ativos sem data ou com 3 dias ou mais sem atualização.</p></div><div class="grid grid-cols-2 gap-2 sm:grid-cols-4">${triageCards.map(([label, count, color]) => `<div class="rounded-md border border-slate-800 bg-slate-900/70 px-2.5 py-1.5"><p class="text-[9px] text-slate-400">${label}</p><p class="mt-0.5 text-sm font-semibold ${color}">${count}</p></div>`).join("")}</div></div>`;
      const exportButton = document.getElementById("btn-exportar-acompanhamento-chamados");
      exportButton.disabled = !Array.isArray(data.chamados) || data.chamados.length === 0;
      if (!Array.isArray(data.chamados) || data.chamados.length === 0) {
        list.innerHTML = '<p class="py-8 text-center text-sm text-slate-400" role="status">Importe as duas planilhas para relacionar as séries com as OS.</p>';
        return;
      }
      if (records.length === 0) {
        list.innerHTML = '<p class="py-8 text-center text-sm text-slate-400" role="status">Nenhum chamado corresponde à busca.</p>';
        return;
      }

      const relations = {
        conferida: ["OS conferida", "border-emerald-400/30 bg-emerald-500/10 text-emerald-200"],
        divergente: ["OS divergente", "border-amber-400/30 bg-amber-500/10 text-amber-100"],
        sem_os: ["OS ausente", "border-slate-600 bg-slate-800 text-slate-200"],
        somente_simpress: ["Sem registro no Oracle", "border-sky-400/30 bg-sky-500/10 text-sky-100"],
        somente_oracle: ["Sem pedido Simpress", "border-violet-400/30 bg-violet-500/10 text-violet-100"],
      };
      list.innerHTML = records.map(record => {
        const [relationLabel, relationClass] = relations[record.relacao] || relations.sem_os;
        const attention = classificarAtencaoChamado(record);
        const simpress = record.simpress || {};
        const ordensVenda = Array.isArray(simpress.ordens_venda) ? simpress.ordens_venda : [];
        const ordensSimpress = Array.isArray(simpress.ordens_servico) ? simpress.ordens_servico : [];
        const chamadosCliente = chamadosClienteInformados(simpress.chamados_cliente);
        const enderecosEntrega = Array.isArray(simpress.enderecos_entrega) ? simpress.enderecos_entrega : [];
        const mostrarEnderecoEntrega = simpress.pedido_em_andamento && enderecosEntrega.some(Boolean);
        const previsoesEntrega = Array.isArray(simpress.previsoes_entrega) ? simpress.previsoes_entrega : [];
        const oracle = Array.isArray(record.oracle) ? record.oracle : [];
        const provenance = record.fontes_relacao || {};
        const seriesSources = provenance.serie || { simpress: Boolean(simpress.serie || simpress.pedidos?.length || ordensSimpress.length), oracle: oracle.length > 0 };
        const seriesSourceLabels = [seriesSources.simpress ? "Simpress" : "", seriesSources.oracle ? "Oracle" : ""].filter(Boolean);
        const relationAlerts = Array.isArray(record.alertas_relacao) ? record.alertas_relacao : [];
        const oracleRows = oracle.length ? [...oracle].sort((left, right) => compararOrdensServicoDecrescente(left.ordem_servico, right.ordem_servico)).map(ticket => {
          const updateAge = idadeAtualizacaoChamado(ticket);
          const ageClass = updateAge.encerrado ? "text-slate-500" : updateAge.dias === null || updateAge.dias >= 3 ? "text-amber-200" : "text-emerald-200";
          const oracleAddress = [ticket.logradouro, ticket.numero_endereco, ticket.bairro, ticket.cidade]
            .map(value => String(value || "").trim())
            .filter(Boolean)
            .join(", ");
          return `<div class="rounded-lg border border-slate-800 bg-slate-900/80 p-3">
          <div class="flex flex-wrap items-center justify-between gap-2"><p class="text-xs font-semibold text-white">Solicitação Oracle ${escapeHtml(ticket.solicitacao || "Não informada")}</p><span class="inline-flex items-center gap-2 rounded-md border border-violet-400/30 bg-violet-500/10 px-2.5 py-1.5"><span class="text-[10px] font-semibold uppercase tracking-wide text-violet-200">OS Oracle</span><span class="font-mono text-lg font-bold leading-none text-violet-100">${escapeHtml(ticket.ordem_servico || "Não informada")}</span></span></div>
          <p class="mt-1 text-xs text-slate-300">${escapeHtml(ticket.status || "Status não informado")}${ticket.sub_status ? ` · ${escapeHtml(ticket.sub_status)}` : ""}</p>
          <p class="mt-1 text-[10px] text-slate-400">Fila: ${escapeHtml(ticket.fila || "Não informada")} · Fase: ${escapeHtml(ticket.fase_atendimento || "Não informada")}</p>
          <p class="mt-1 break-words text-[10px] text-slate-400">Endereço: ${escapeHtml(oracleAddress || "Não informado")}</p>
          <p class="mt-1 text-[10px] text-slate-400">Atendido pela inibição: ${escapeHtml(ticket.atendido_pela_inibicao || "Não informado")}</p>
          <p class="mt-1 text-[10px] text-slate-400">Atendimento por: ${escapeHtml(ticket.nome_filial || "Não informado")}</p>
          <p class="mt-1 text-[10px] text-slate-500">Entregas: ${escapeHtml(ticket.status_entregas || "Não informado")} · Atividades: ${escapeHtml(ticket.status_atividades || "Não informado")}${ticket.ultima_atualizacao ? ` · Atualizado ${escapeHtml(formatarHorarioHistorico(ticket.ultima_atualizacao))}` : ""}</p>
          <p class="mt-1 text-[10px] font-medium ${ageClass}">${escapeHtml(updateAge.rotulo)}</p>
          ${String(ticket.descricao || "").trim() ? `<details class="ticket-oracle-description"><summary><span class="shrink-0 font-semibold text-violet-200">Descrição do chamado</span><span class="ticket-oracle-description-preview">${escapeHtml(resumirDescricaoChamado(ticket.descricao))}</span><span class="ticket-oracle-description-toggle ticket-oracle-description-expand">⌄ Expandir</span><span class="ticket-oracle-description-toggle ticket-oracle-description-collapse">⌃ Recolher</span></summary><div class="ticket-oracle-description-content">${escapeHtml(String(ticket.descricao).trim())}</div></details>` : ""}
        </div>`;
        }).join("") : '<p class="text-xs text-slate-500">Sem registro correspondente no Oracle.</p>';
        const attentionClass = attention.em_atencao ? "border-amber-400/20 bg-amber-500/5 text-amber-200" : "border-slate-700 bg-slate-900 text-slate-400";
        const reviewMarkup = relationAlerts.length ? `<div class="mt-3 rounded-lg border border-amber-400/30 bg-amber-500/5 px-3 py-2" role="note"><p class="text-[10px] font-semibold text-amber-200">Conferir relação entre as planilhas</p><ul class="mt-1 list-disc space-y-0.5 pl-4 text-[10px] text-amber-100">${relationAlerts.map(alert => `<li>${escapeHtml(alert.mensagem || "Relação incerta")}</li>`).join("")}</ul></div>` : "";
        return `<article class="rounded-xl border border-slate-800 bg-slate-950/70 p-4" data-ticket-serial="${escapeHtml(record.serie)}">
          <div class="flex flex-wrap items-center justify-between gap-2"><div class="min-w-0"><h4 class="font-mono text-sm font-semibold text-white">${escapeHtml(record.serie)}</h4><p class="mt-1 text-[10px] text-slate-400">Série encontrada em: ${escapeHtml(seriesSourceLabels.join(" e ") || "nenhuma fonte")}</p></div><div class="flex flex-wrap items-center gap-2"><span class="rounded-full border px-2.5 py-1 text-[10px] font-semibold ${relationClass}">${relationLabel}</span><span class="rounded-full border px-2.5 py-1 text-[10px] ${attentionClass}">${escapeHtml(attention.motivo)}</span></div></div>
          <div class="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
            <section class="rounded-lg border border-slate-800 bg-slate-900/50 p-3">
              <h5 class="text-[10px] font-semibold uppercase tracking-wide text-cyan-200">Simpress · Acompanhamento de Pedidos</h5>
              <div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-300">
                <span>Pedido Simpress: ${formatarListaChamados(simpress.pedidos)}</span>
                ${ordensVenda.some(Boolean) ? `<span aria-label="Ordem de venda Simpress" class="inline-flex items-center rounded-md border border-cyan-400/30 bg-cyan-500/10 px-2 py-1 font-mono font-semibold text-cyan-100">${formatarListaChamados(ordensVenda)}</span>` : ""}
              </div>
              <div class="mt-2 flex flex-wrap items-center gap-2"><span class="text-[10px] font-semibold uppercase tracking-wide text-cyan-200">OS Simpress</span><span class="rounded-md border border-cyan-400/30 bg-cyan-500/10 px-2.5 py-1.5 font-mono text-lg font-bold leading-none text-cyan-100">${formatarOrdensServico(ordensSimpress)}</span></div>
              ${chamadosCliente.some(Boolean) ? `<p class="mt-2 text-xs text-slate-300">Chamado do cliente: ${formatarListaChamados(chamadosCliente)}</p>` : ""}
              <p class="mt-1 text-xs text-slate-300">Descrição do produto: ${formatarListaChamados(simpress.descricoes_produto)}</p>
              <p class="mt-1 text-xs text-slate-300">Cidade de entrega: ${formatarListaChamados(simpress.cidades_entrega)}</p>
              ${previsoesEntrega.some(Boolean) ? `<p class="mt-1 text-xs text-slate-300">Previsão de entrega: ${formatarPrevisoesEntrega(previsoesEntrega)}</p>` : ""}
              ${mostrarEnderecoEntrega ? `<p class="mt-1 break-words text-xs text-slate-300">Endereço de entrega: ${formatarListaChamados(enderecosEntrega)}</p>` : ""}
              <p class="mt-1 text-xs text-slate-400">Status: ${formatarListaChamados(simpress.status)}</p>
            </section>
            <section class="space-y-2"><h5 class="px-1 text-[10px] font-semibold uppercase tracking-wide text-violet-200">Oracle · Gestão de Solicitações</h5>${oracleRows}</section>
          </div>
          ${reviewMarkup}
          ${record.ordens_servico_conferidas?.length ? `<p class="mt-3 text-[10px] text-emerald-200">OS encontrada nas duas fontes: ${formatarOrdensServico(record.ordens_servico_conferidas)}</p>` : ""}
          <details class="mt-3 rounded-lg border border-cyan-400/20 bg-slate-900/50 px-3 py-2" data-ticket-timeline data-timeline-serial="${escapeHtml(record.serie)}" data-snapshot-id="${escapeHtml(data.snapshot_id || "")}" ontoggle="carregarLinhaDoTempoChamado(this)"><summary class="cursor-pointer text-xs font-semibold text-cyan-100">Linha do tempo e anotações</summary><div data-ticket-timeline-body><p class="py-2 text-[10px] text-slate-500">Abra para ver as mudanças desta série em cada importação e registrar a próxima ação.</p></div></details>
        </article>`;
      }).join("");
    }

    function limparFiltrosAcompanhamentoChamados() {
      ["filtro-acompanhamento-chamados", "relacao-acompanhamento-chamados", "status-acompanhamento-chamados", "fila-acompanhamento-chamados", "cidade-acompanhamento-chamados", "atendimento-acompanhamento-chamados", "idade-acompanhamento-chamados"].forEach(id => {
        document.getElementById(id).value = "";
      });
      document.getElementById("somente-atencao-chamados").checked = false;
      renderizarAcompanhamentoChamados();
    }

    async function selecionarVersaoChamados() {
      const snapshotId = document.getElementById("versao-acompanhamento-chamados").value;
      if (!snapshotId) return;
      const target = document.getElementById("lista-acompanhamento-chamados");
      target.innerHTML = '<p class="py-8 text-center text-sm text-slate-400" role="status">Carregando versão selecionada…</p>';
      try {
        const response = await fetch(`/api/operacoes/chamados/snapshot/${encodeURIComponent(snapshotId)}`);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || "Não foi possível abrir esta versão.");
        data.snapshot_id = snapshotId;
        acompanhamentoChamadosAtual = data;
        renderizarAcompanhamentoChamados();
        await carregarEvolucaoChamados(snapshotId);
      } catch (error) { target.innerHTML = `<p class="py-8 text-center text-sm text-rose-300" role="alert">${escapeHtml(error.message || "Não foi possível abrir esta versão.")}</p>`; }
    }

    async function excluirImportacoesAntigasChamados() {
      const button = document.getElementById("btn-excluir-importacoes-antigas-chamados");
      const olderCount = Math.max(0, historicoAcompanhamentoChamados.length - 1);
      const olderLabel = olderCount === 1 ? "1 importação antiga" : `${olderCount} importações antigas`;
      if (!olderCount || !window.confirm(`Excluir ${olderLabel} e manter somente a mais recente? Esta ação não poderá ser desfeita.`)) return;

      button.disabled = true;
      button.textContent = "Excluindo…";
      try {
        const response = await fetch("/api/operacoes/chamados/historico/antigas", { method: "DELETE" });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || "Não foi possível excluir as importações antigas.");
        await carregarAcompanhamentoChamados();
        const removedCount = Number(data.removidas) || 0;
        const removedLabel = removedCount === 1 ? "1 importação antiga removida" : `${removedCount} importações antigas removidas`;
        showToast(`${removedLabel}. A importação mais recente foi mantida.`, "success");
      } catch (error) {
        showToast(error.message || "Não foi possível excluir as importações antigas.", "error");
      } finally {
        button.textContent = "Excluir importações antigas";
        button.disabled = historicoAcompanhamentoChamados.length <= 1;
      }
    }

    async function exportarAcompanhamentoChamados() {
      const button = document.getElementById("btn-exportar-acompanhamento-chamados");
      const originalText = button.textContent;
      const params = new URLSearchParams({ snapshot_id: acompanhamentoChamadosAtual?.snapshot_id || "" });
      Object.entries(obterFiltrosChamados()).forEach(([key, value]) => {
        if (value !== "" && value !== false) params.set(key, String(value));
      });
      button.disabled = true;
      button.textContent = "Preparando Excel…";
      try {
        const response = await fetch(`/api/operacoes/chamados/exportar?${params.toString()}`);
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.detail || "Não foi possível exportar os chamados filtrados.");
        }
        const disposition = response.headers?.get("Content-Disposition") || "";
        const match = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(disposition);
        const filename = match?.[1]?.replace(/["']/g, "") || "Acompanhamento_de_Chamados.xlsx";
        const url = window.URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
        showToast("Excel dos chamados filtrados exportado.", "success");
      } catch (error) {
        showToast(error.message || "Não foi possível exportar os chamados filtrados.", "error");
      } finally {
        button.textContent = originalText;
        renderizarAcompanhamentoChamados();
      }
    }

    async function carregarAcompanhamentoChamados() {
      const list = document.getElementById("lista-acompanhamento-chamados");
      list.innerHTML = '<p class="py-8 text-center text-sm text-slate-400" role="status">Carregando acompanhamento…</p>';
      try {
        const response = await fetch("/api/operacoes/chamados");
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || "Não foi possível carregar o acompanhamento de chamados.");
        acompanhamentoChamadosAtual = data;
        renderizarHistoricoAcompanhamentoChamados(data);
        renderizarAcompanhamentoChamados();
        await carregarEvolucaoChamados(data.snapshot_id || "");
      } catch (error) {
        list.innerHTML = `<p class="py-8 text-center text-sm text-rose-300" role="alert">${escapeHtml(error.message || "Não foi possível carregar o acompanhamento de chamados.")}</p>`;
      }
    }

    async function importarPlanilhasChamados(event) {
      event.preventDefault();
      const form = document.getElementById("form-importar-acompanhamento-chamados");
      const simpressInput = document.getElementById("arquivo-chamados-simpress");
      const oracleInput = document.getElementById("arquivo-chamados-oracle");
      const button = document.getElementById("btn-importar-acompanhamento-chamados");
      const status = document.getElementById("status-importacao-chamados");
      if (!simpressInput.files?.[0] || !oracleInput.files?.[0]) {
        status.textContent = "Selecione as duas planilhas para importar.";
        return;
      }
      const originalText = button.textContent;
      button.disabled = true;
      button.textContent = "Importando…";
      form.setAttribute("aria-busy", "true");
      status.textContent = "Lendo as planilhas e relacionando as séries…";
      try {
        const payload = new FormData();
        payload.append("simpress_file", simpressInput.files[0]);
        payload.append("oracle_file", oracleInput.files[0]);
        const response = await fetch("/api/operacoes/chamados/importar", { method: "POST", body: payload });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || "Não foi possível importar as planilhas.");
        acompanhamentoChamadosAtual = data;
        renderizarHistoricoAcompanhamentoChamados(data);
        simpressInput.value = "";
        oracleInput.value = "";
        status.textContent = "Planilhas importadas. As OS foram relacionadas pela série.";
        renderizarAcompanhamentoChamados();
        await carregarEvolucaoChamados(data.snapshot_id || "");
        showToast("Acompanhamento de chamados atualizado.", "success");
      } catch (error) {
        status.textContent = error.message || "Não foi possível importar as planilhas.";
      } finally {
        button.disabled = false;
        button.textContent = originalText;
        form.removeAttribute("aria-busy");
      }
    }

    function abrirAcompanhamentoChamados() {
      abrirModalAcessivel("modal-acompanhamento-chamados", '[aria-label="Fechar acompanhamento de chamados"]', "fecharAcompanhamentoChamados");
      const form = document.getElementById("form-importar-acompanhamento-chamados");
      if (!form.dataset.bound) {
        form.addEventListener("submit", importarPlanilhasChamados);
        ["filtro-acompanhamento-chamados", "relacao-acompanhamento-chamados", "status-acompanhamento-chamados", "fila-acompanhamento-chamados", "cidade-acompanhamento-chamados", "atendimento-acompanhamento-chamados", "idade-acompanhamento-chamados", "somente-atencao-chamados"].forEach(id => {
          const control = document.getElementById(id);
          control.addEventListener(id === "filtro-acompanhamento-chamados" ? "input" : "change", renderizarAcompanhamentoChamados);
        });
        form.dataset.bound = "true";
      }
      carregarAcompanhamentoChamados();
    }

    async function abrirModalHistoricoComparacoes() {
      abrirModalAcessivel("modal-historico-comparacoes", '[aria-label="Fechar histórico de planilhas"]', "fecharModalHistoricoComparacoes");
      await carregarHistoricoComparacoes();
    }

    function fecharModalHistoricoComparacoes() {
      fecharModalAcessivel("modal-historico-comparacoes");
    }

    async function carregarHistoricoComparacoes() {
      const lista = document.getElementById("lista-historico-comparacoes");
      lista.setAttribute("aria-busy", "true");
      lista.innerHTML = '<p class="text-sm text-slate-400 text-center py-8" role="status" aria-live="polite">Carregando histórico...</p>';
      const stopLoading = motion?.startLoading(lista, "Carregando histórico…") || (() => {});

      try {
        const res = await fetch("/api/historico-comparacoes");
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || "Não foi possível carregar o histórico de planilhas.");

        const eventos = Array.isArray(data.eventos) ? data.eventos : [];
        definirTotalHistoricoComparacoes(data.total ?? eventos.length);
        atualizarDatasExportacaoHistorico(eventos);
        lista.replaceChildren();
        if (eventos.length === 0) {
          const vazio = document.createElement("p");
          vazio.className = "text-sm text-slate-400 text-center py-8";
          vazio.setAttribute("role", "status");
          vazio.setAttribute("aria-live", "polite");
          vazio.textContent = "Nenhuma atualização de planilhas registrada no histórico.";
          lista.appendChild(vazio);
          return;
        }

        eventos.forEach(evento => {
          const resumo = evento.resumo || {};
          const restauracao = evento.tipo === "restauracao";
          const arquivos = restauracao ? (evento.arquivos_restaurados || {}) : (evento.arquivos_enviados || {});
          const card = document.createElement("article");
          card.className = "flex flex-col md:flex-row md:items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/70 p-4";

          const info = document.createElement("div");
          info.className = "min-w-0 space-y-1";
          const dataHora = document.createElement("p");
          dataHora.className = "text-sm font-semibold text-white";
          dataHora.textContent = formatarHorarioHistorico(evento.horario);
          info.appendChild(dataHora);

          const fontes = document.createElement("p");
          fontes.className = "text-xs text-slate-400 break-words";
          fontes.textContent = restauracao
            ? `Inventários restaurados — no endpoint: ${formatarNomeFonteHistorico(arquivos.endpoint || "—")} · na Simpress: ${formatarNomeFonteHistorico(arquivos.detalhes || "—")}`
            : `no endpoint: ${formatarNomeFonteHistorico(arquivos.endpoint || "—")} · na Simpress: ${formatarNomeFonteHistorico(arquivos.detalhes || "—")}`;
          info.appendChild(fontes);

          const contagens = document.createElement("p");
          contagens.className = "text-[11px] text-slate-500";
          if (evento.somente_anotacoes_sincronizadas) {
            contagens.textContent = "As anotações podem ser consultadas e editadas neste notebook.";
          } else if (restauracao) {
            const restauracaoDe = evento.restauracao_de || {};
            contagens.textContent = `Restauração do conjunto anterior a ${formatarHorarioHistorico(restauracaoDe.horario)} · registros restaurados: no endpoint ${Number(resumo.total_endpoint_restaurado || 0).toLocaleString("pt-BR")}, na Simpress ${Number(resumo.total_detalhes_restaurado || 0).toLocaleString("pt-BR")}`;
          } else {
            contagens.textContent = `Apelidos/hostnames atualizados: ${Number(resumo.apelidos_atualizados || 0)} · sem acesso há 14+ dias: ${Number(resumo.sem_acesso_14_dias || 0)} · divergências manuais pendentes: ${Number(resumo.divergencias_apelidos_manuais || 0)} · equipamentos sem correspondência — no endpoint: ${Number(resumo.ausentes_no_endpoint || 0)} · na Simpress: ${Number(resumo.ausentes_em_detalhes || 0)} · divergências de local: ${Number(resumo.divergencias_local || 0)} · ambiguidades: ${Number(resumo.correspondencias_ambiguas || 0)}`;
          }
          info.appendChild(contagens);
          card.appendChild(info);

          const acoes = document.createElement("div");
          acoes.className = "flex flex-wrap items-center gap-2";

          if (!restauracao) {
            const consultar = document.createElement("button");
            consultar.type = "button";
            consultar.className = "shrink-0 px-3 py-2 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-200 border border-cyan-500/25 text-xs font-semibold transition";
            consultar.textContent = evento.somente_anotacoes_sincronizadas ? "Consultar anotações" : "Consultar resultado";
            consultar.addEventListener("click", () => consultarHistoricoComparacao(evento.id, consultar));
            acoes.appendChild(consultar);
          }

          if (evento.restauravel) {
            const restaurar = document.createElement("button");
            restaurar.type = "button";
            restaurar.className = "shrink-0 px-3 py-2 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-200 border border-amber-500/25 text-xs font-semibold transition";
            restaurar.textContent = restauracao ? "Desfazer restauração" : "Restaurar versão anterior";
            restaurar.setAttribute("aria-label", `${restauracao ? "Desfazer restauração de" : "Restaurar versões anteriores à atualização de"} ${formatarHorarioHistorico(evento.horario)}`);
            restaurar.addEventListener("click", () => restaurarHistoricoComparacao(evento, restaurar));
            acoes.appendChild(restaurar);
          }

          if (!evento.somente_anotacoes_sincronizadas) {
            const excluir = document.createElement("button");
            excluir.type = "button";
            excluir.className = "shrink-0 px-3 py-2 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-200 border border-rose-500/25 text-xs font-semibold transition";
            excluir.textContent = "Excluir";
            excluir.setAttribute("aria-label", `Excluir atualização de ${formatarHorarioHistorico(evento.horario)}`);
            excluir.addEventListener("click", () => excluirHistoricoComparacao(evento, excluir));
            acoes.appendChild(excluir);
          }

          card.appendChild(acoes);
          lista.appendChild(card);
        });
      } catch (err) {
        console.error("Erro ao carregar histórico de planilhas:", err);
        const select = document.getElementById("data-exportar-historico-comparacoes");
        if (!select?.value) definirEstadoDatasExportacaoHistorico("Datas indisponíveis");
        lista.replaceChildren();
        const erro = document.createElement("p");
        erro.className = "text-sm text-rose-300 text-center py-8";
        erro.setAttribute("role", "alert");
        erro.setAttribute("aria-live", "assertive");
        erro.textContent = err.message || "Não foi possível carregar o histórico de planilhas.";
        lista.appendChild(erro);
      } finally {
        stopLoading();
        lista.removeAttribute("aria-busy");
      }
    }

    async function baixarHistoricoComparacoesExcel(data) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data || ""))) {
        throw new Error("A data do histórico da atualização não está disponível.");
      }

      const res = await fetch(`/api/historico-comparacoes/exportar/excel?data=${encodeURIComponent(data)}`);
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.detail || "Não foi possível exportar o histórico selecionado.");
      }

      const disposition = res.headers.get("Content-Disposition") || "";
      const match = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(disposition);
      const filename = match && match[1]
        ? match[1].replace(/['"]/g, "")
        : `Historico_Planilhas_${data.replace(/-/g, "")}.xlsx`;
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
      return filename;
    }

    async function exportarHistoricoComparacoesExcel() {
      const select = document.getElementById("data-exportar-historico-comparacoes");
      const button = document.getElementById("btn-exportar-historico-comparacoes");
      const data = select?.value || "";
      if (!data) {
        showToast("Não há uma data do histórico disponível para exportar.", "warning");
        return;
      }

      const htmlOriginal = button?.innerHTML || "";
      if (button) {
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        button.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin" aria-hidden="true"></i><span class="hidden sm:inline">Exportando...</span>';
        lucide.createIcons({ root: button });
      }

      try {
        await baixarHistoricoComparacoesExcel(data);
        showToast("Histórico exportado com sucesso!", "success");
      } catch (err) {
        console.error("Erro ao exportar histórico de planilhas:", err);
        showToast(err.message || "Não foi possível exportar o histórico selecionado.", "error");
      } finally {
        if (button) {
          button.disabled = !select || !select.value;
          button.removeAttribute("aria-busy");
          button.innerHTML = htmlOriginal;
          lucide.createIcons({ root: button });
        }
      }
    }

    async function restaurarHistoricoComparacao(evento, botao) {
      const textoOriginal = botao.textContent;
      botao.disabled = true;
      botao.setAttribute("aria-busy", "true");
      botao.textContent = "Preparando...";

      try {
        const previewResponse = await fetch(`/api/historico-comparacoes/${encodeURIComponent(evento.id)}/restauracao`);
        const preview = await previewResponse.json().catch(() => ({}));
        if (!previewResponse.ok) throw new Error(preview.detail || "Não foi possível validar o backup selecionado.");

        const backup = preview.arquivos_backup || {};
        const endpointBackup = backup.endpoint || {};
        const simpressBackup = backup.detalhes || {};
        const arquivosAtuais = preview.arquivos_atuais || {};
        const describeBackup = (label, item) => {
          const modified = item.modificado_em ? `; arquivo datado ${formatarHorarioHistorico(item.modificado_em)}` : "";
          return `${label}: ${formatarNomeFonteHistorico(item.nome || "—")} (${Number(item.registros || 0).toLocaleString("pt-BR")} registros${modified})`;
        };
        const describeCurrent = (label, item) => {
          if (!item?.presente) return `${label}: arquivo ausente`;
          const modified = item.modificado_em ? ` · modificado ${formatarHorarioHistorico(item.modificado_em)}` : "";
          return `${label}: ${formatarNomeFonteHistorico(item.nome || "—")}${modified}`;
        };
        const restauracao = preview.tipo_evento === "restauracao";
        const acao = restauracao ? "Desfazer a restauração" : "Reverter a atualização";
        const confirmation = [
          `${acao} registrada em ${formatarHorarioHistorico(preview.evento_horario || evento.horario)}?`,
          "",
          "Conjunto que será restaurado:",
          describeBackup("no endpoint", endpointBackup),
          describeBackup("na Simpress", simpressBackup),
          "",
          "Conjunto ativo, que será guardado como backup:",
          describeCurrent("no endpoint", arquivosAtuais.endpoint),
          describeCurrent("na Simpress", arquivosAtuais.detalhes),
          "",
          "Os dois inventários serão substituídos juntos e a ação ficará registrada no histórico. Continuar?",
        ].join("\n");
        if (!window.confirm(confirmation)) return;

        botao.textContent = "Restaurando...";
        if (!inventoryRestoreAttempts.has(evento.id)) {
          inventoryRestoreAttempts.set(evento.id, { token: preview.preview_token, key: inventoryOperationKey() });
        }
        const restoreAttempt = inventoryRestoreAttempts.get(evento.id);
        const response = await fetch(`/api/historico-comparacoes/${encodeURIComponent(evento.id)}/restaurar`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": restoreAttempt.key },
          body: JSON.stringify({ preview_token: restoreAttempt.token }),
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok || (response.status === 409 && /prévia|estado mudou/i.test(String(data.detail || "")))) {
          inventoryRestoreAttempts.delete(evento.id);
        }
        if (!response.ok) throw new Error(data.detail || "Não foi possível restaurar o conjunto selecionado.");

        invalidarDadosEquipamentoAposRestauracao();
        await Promise.allSettled([
          carregarEstatisticas(),
          carregarUnidades(),
          carregarHistoricoComparacoes(),
          carregarContagemHistoricoComparacoes(),
        ]);
        document.querySelector('#modal-historico-comparacoes [aria-label="Fechar histórico de planilhas"]')
          ?.focus({ preventScroll: true });
        const total = Number(data.evento?.total_equipamentos_carregados || 0).toLocaleString("pt-BR");
        const reversao = data.evento?.desfazer_disponivel
          ? "A restauração pode ser desfeita pelo histórico."
          : "O backup do conjunto substituído está incompleto ou inválido; não é possível desfazer pelo histórico.";
        showToast(`Inventários restaurados. ${total} equipamentos carregados. ${reversao}`, "success");
      } catch (err) {
        console.error("Erro ao restaurar o conjunto de planilhas:", err);
        showToast(err.message || "Não foi possível restaurar o conjunto selecionado.", "error");
      } finally {
        if (botao.isConnected) {
          botao.disabled = false;
          botao.removeAttribute("aria-busy");
          botao.textContent = textoOriginal;
        }
      }
    }

    async function consultarHistoricoComparacao(eventoId, botao, navigationTarget = null) {
      const textoOriginal = botao.textContent;
      botao.disabled = true;
      botao.setAttribute("aria-busy", "true");
      botao.textContent = "Carregando...";
      try {
        const res = await fetch(`/api/historico-comparacoes/${encodeURIComponent(eventoId)}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || "Não foi possível abrir este resultado.");

        const evento = data.evento || {};
        fecharModalHistoricoComparacoes();
        abrirModalComparacaoPlanilhas({
          ...(evento.comparacao || {}),
          evento_id: evento.id,
          horario_comparacao: evento.horario || evento.comparacao?.horario_comparacao,
          historico_salvo: true,
          contexto_historico: true,
        }, navigationTarget);
      } catch (err) {
        console.error("Erro ao abrir comparação salva:", err);
        showToast(err.message || "Não foi possível abrir este resultado.", "error");
        botao.disabled = false;
        botao.removeAttribute("aria-busy");
        botao.textContent = textoOriginal;
      }
    }

    async function excluirHistoricoComparacao(evento, botao) {
      const dataHora = formatarHorarioHistorico(evento.horario);
      if (!window.confirm(`Tem certeza de que deseja excluir esta atualização de ${dataHora}? Essa ação não poderá ser desfeita.`)) return;

      const textoOriginal = botao.textContent;
      botao.disabled = true;
      botao.setAttribute("aria-busy", "true");
      botao.textContent = "Excluindo...";
      try {
        const res = await fetch(`/api/historico-comparacoes/${encodeURIComponent(evento.id)}`, {
          method: "DELETE",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || "Não foi possível excluir esta atualização.");

        await carregarHistoricoComparacoes();
        showToast("Atualização excluída do histórico.", "success");
      } catch (err) {
        console.error("Erro ao excluir atualização do histórico:", err);
        showToast(err.message || "Não foi possível excluir esta atualização.", "error");
        botao.disabled = false;
        botao.removeAttribute("aria-busy");
        botao.textContent = textoOriginal;
      }
    }

    async function exportarEquipamentosAtualizados() {
      const btn = document.getElementById("btn-exportar-equipamentos");
      const originalText = btn.innerHTML;
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
      btn.innerHTML = `<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i><span class="hidden sm:inline">Gerando Excel...</span>`;
      lucide.createIcons({ root: btn });

      try {
        const res = await fetch("/api/exportar-equipamentos");
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.detail || "Falha ao exportar a planilha de equipamentos.");
        }

        const disposition = res.headers.get("Content-Disposition") || "";
        const match = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(disposition);
        const filename = match && match[1]
          ? match[1].replace(/['"]/g, "")
          : "EquipamentosDetalhes-atualizados.xlsx";
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);

        showToast("Planilha Exportada com Sucesso!", "success");
      } catch (err) {
        console.error("Erro ao exportar planilha de equipamentos:", err);
        showToast(err.message, "error");
      } finally {
        btn.disabled = false;
        btn.removeAttribute("aria-busy");
        btn.innerHTML = originalText;
        lucide.createIcons({ root: btn });
      }
    }

    // ==========================================
    // MODAL DE EDIÇÃO / CADASTRO DE EQUIPAMENTO
    // ==========================================
    function abrirModalEditarEquipamento() {
      if (!currentEquipamento) {
        showToast("Localize um equipamento antes de editar.", "warning");
        return;
      }

      document.getElementById("modal-edit-titulo").textContent = "Atualizar Cadastro do Equipamento";
      document.getElementById("modal-edit-serial-badge").textContent = currentEquipamento.serial;

      document.getElementById("edit-serial").value = currentEquipamento.serial || "";
      document.getElementById("edit-serial").readOnly = true;
      document.getElementById("edit-modelo").value = currentEquipamento.modelo || "";
      document.getElementById("edit-tipo").value = currentEquipamento.tipo || "Notebook";
      document.getElementById("edit-apelido").value = currentEquipamento.apelido || "";
      document.getElementById("edit-apelido-field").classList.add("hidden");
      document.getElementById("edit-id-cliente").value = currentEquipamento.idCliente || "";

      abrirModalAcessivel("modal-editar-equipamento", "#edit-modelo", "fecharModalEditarEquipamento");
    }

    function cadastrarNovoSerial(serial) {
      fecharAutocomplete();
      document.getElementById("modal-edit-titulo").textContent = "Cadastrar Novo Equipamento";
      document.getElementById("modal-edit-serial-badge").textContent = serial ? serial.toUpperCase() : "NOVO";

      document.getElementById("edit-serial").value = (serial || "").toUpperCase();
      document.getElementById("edit-serial").readOnly = false;
      document.getElementById("edit-modelo").value = "";
      document.getElementById("edit-tipo").value = "Notebook";
      document.getElementById("edit-apelido").value = "";
      document.getElementById("edit-apelido-field").classList.remove("hidden");
      document.getElementById("edit-id-cliente").value = "";
      abrirModalAcessivel("modal-editar-equipamento", "#edit-modelo", "fecharModalEditarEquipamento");
    }

    function fecharModalEditarEquipamento() {
      fecharModalAcessivel("modal-editar-equipamento");
    }

    function abrirModalEditarApelido() {
      if (!currentEquipamento) {
        showToast("Localize um equipamento antes de editar o apelido.", "warning");
        return;
      }

      document.getElementById("edit-apelido-isolado").value = currentEquipamento.apelido || "";
      document.getElementById("apelido-serial-contexto").textContent = `Série: ${currentEquipamento.serial}`;
      abrirModalAcessivel("modal-editar-apelido", "#edit-apelido-isolado", "fecharModalEditarApelido");
      document.getElementById("edit-apelido-isolado").select();
    }

    function fecharModalEditarApelido() {
      fecharModalAcessivel("modal-editar-apelido");
    }

    async function salvarApelido() {
      if (!currentEquipamento) {
        showToast("Localize um equipamento antes de editar o apelido.", "warning");
        fecharModalEditarApelido();
        return;
      }

      const serial = currentEquipamento.serial;
      const selectionRevisionAtSave = equipamentoSelectionRevision;
      const apelido = document.getElementById("edit-apelido-isolado").value.trim();
      const btn = document.getElementById("btn-salvar-apelido");
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
      btn.textContent = "Salvando...";

      try {
        const res = await fetch("/api/equipamento/atualizar-apelido", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serial, apelido })
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || "Falha ao salvar o apelido.");

        const stillSelected = equipamentoSelectionRevision === selectionRevisionAtSave
          && String(currentEquipamento?.serial || "").toUpperCase() === String(serial).toUpperCase();
        if (stillSelected) {
          definirEquipamentoAtual(data.equipamento);
          document.getElementById("badge-apelido").textContent = currentEquipamento.apelido || "Sem Apelido";
          atualizarIndicadoresPosSalvamento();
          fecharModalEditarApelido();
        }
        showToast("Apelido salvo para pesquisas e exportações do Excel.", "success");
      } catch (err) {
        console.error("Erro ao salvar apelido:", err);
        showToast(err.message || "Falha ao salvar o apelido.", "error");
      } finally {
        btn.disabled = false;
        btn.removeAttribute("aria-busy");
        btn.textContent = originalText;
      }
    }

    function formatarNomeFonteHistorico(valor) {
      return String(valor || "")
        .replace(/\b(?:na|no|da|do|à|ao|pela|pelo|a|o)\s*InvAll/gi, "no endpoint")
        .replace(/InvAll/gi, "no endpoint")
        .replace(/\b(?:em|de|da|do|na|no|a|à|pela|pelo)\s*EquipamentosDetalhes/gi, "na Simpress")
        .replace(/EquipamentosDetalhes/gi, "na Simpress")
        .replace(/(?<![\w.-])(?:no\s+)?Endpoint(?![\w.-])/gi, "no endpoint")
        .replace(/\b(?:na\s+)?Simpress\b/gi, "na Simpress");
    }

    function formatarHorarioHistorico(horario) {
      const text = String(horario || "").trim();
      let data = null;
      const brazilianDate = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(text);
      if (brazilianDate) {
        const [, day, month, year, hour = "0", minute = "0", second = "0", millisecond = "0"] = brazilianDate;
        const parts = {
          year: Number(year), month: Number(month), day: Number(day),
          hour: Number(hour), minute: Number(minute), second: Number(second),
          millisecond: Number(millisecond.padEnd(3, "0")),
        };
        const parsed = new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond);
        if (parsed.getFullYear() === parts.year && parsed.getMonth() === parts.month - 1 && parsed.getDate() === parts.day
          && parsed.getHours() === parts.hour && parsed.getMinutes() === parts.minute && parsed.getSeconds() === parts.second) {
          data = parsed;
        }
      }
      const isoDateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
      if (!data && isoDateOnly) {
        const [, year, month, day] = isoDateOnly;
        const parsed = new Date(Number(year), Number(month) - 1, Number(day));
        if (parsed.getFullYear() === Number(year) && parsed.getMonth() === Number(month) - 1 && parsed.getDate() === Number(day)) data = parsed;
      }
      if (!data) data = horario instanceof Date ? horario : new Date(horario);
      if (Number.isNaN(data.getTime())) return horario || "Horário indisponível";
      return new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "short",
        timeStyle: "medium"
      }).format(data);
    }

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
      abrirModalAcessivel("modal-historico-apelidos", '[aria-label="Fechar histórico"]', "fecharModalHistoricoApelidos");
      await carregarHistoricoApelidos();
    }

    function fecharModalHistoricoApelidos() {
      fecharModalAcessivel("modal-historico-apelidos");
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

        const ultimaPorCampo = new Map();
        eventos.forEach(evento => {
          const serial = String(evento.serial || "").toUpperCase();
          const tipoCampo = evento.tipo === "endereco" ? "endereco" : "apelido";
          const chaveCampo = `${serial}:${tipoCampo}`;
          if (serial && !ultimaPorCampo.has(chaveCampo)) {
            ultimaPorCampo.set(chaveCampo, evento.id);
          }
        });

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
        const corpo = tabela.querySelector("tbody");

        eventos.forEach(evento => {
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
          linha.appendChild(celulaDesfazer);

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
          linha.appendChild(celulaExcluir);
          corpo.appendChild(linha);
        });

        scroller.appendChild(tabela);
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

    async function desfazerAlteracaoApelido(evento, botao) {
      const apelidoAnterior = evento.apelido_anterior || "(vazio)";
      if (!window.confirm(`Desfazer a alteração da série ${evento.serial} e restaurar o apelido ${apelidoAnterior}?`)) return;

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

        if (currentEquipamento && currentEquipamento.serial === data.equipamento.serial) {
          definirEquipamentoAtual(data.equipamento);
          document.getElementById("badge-apelido").textContent = currentEquipamento.apelido || "Sem Apelido";
        }
        await carregarEstatisticas();
        await carregarHistoricoApelidos();
        showToast("Apelido restaurado. A reversão foi registrada no histórico.", "success");
      } catch (err) {
        console.error("Erro ao desfazer alteração de apelido:", err);
        showToast(err.message || "Não foi possível desfazer a alteração.", "error");
        botao.disabled = false;
        botao.textContent = textoOriginal;
      }
    }

    async function excluirRegistroHistorico(evento, botao) {
      if (!window.confirm("Tem certeza de que deseja excluir esse registro? Essa ação não poderá ser desfeita")) return;

      const textoOriginal = botao.textContent;
      botao.disabled = true;
      botao.textContent = "Excluindo...";
      try {
        const res = await fetch(`/api/historico-alteracoes/${encodeURIComponent(evento.id)}`, { method: "DELETE" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || "Não foi possível excluir o registro.");
        if (currentEquipamento && currentEquipamento.serial === data.equipamento.serial) {
          definirEquipamentoAtual(data.equipamento);
          document.getElementById("badge-apelido").textContent = currentEquipamento.apelido || "Sem Apelido";
          document.getElementById("card-localizacao").textContent = `${currentEquipamento.retirada_cidade || ""} - ${currentEquipamento.retirada_endereco ? currentEquipamento.retirada_endereco.split("-")[0].trim() : ""}`;
          document.getElementById("card-cnpj-atual").textContent = `CNPJ: ${currentEquipamento.retirada_cnpj || "Não especificado"}`;
        }
        await carregarHistoricoApelidos();
        showToast(data.tipo === "endereco"
          ? "Endereço anterior restaurado e salvo; registro removido do histórico."
          : "Apelido anterior restaurado e salvo; registro removido do histórico.", "success");
      } catch (err) {
        console.error("Erro ao excluir registro do histórico:", err);
        showToast(err.message || "Não foi possível excluir o registro.", "error");
        botao.disabled = false;
        botao.textContent = textoOriginal;
      }
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
      atualizarObrigatoriedadeDuracaoPausaEntrega();
    }

    async function salvarDadosEquipamento() {
      const serial = document.getElementById("edit-serial").value.trim().toUpperCase();
      if (!serial) {
        showToast("O número de série é obrigatório.", "warning");
        document.getElementById("edit-serial").focus();
        return;
      }

      const payload = {
        serial: serial,
        novo: !document.getElementById("edit-serial").readOnly,
        modelo: document.getElementById("edit-modelo").value.trim(),
        tipo: document.getElementById("edit-tipo").value,
        apelido: currentEquipamento && currentEquipamento.serial === serial
          ? (currentEquipamento.apelido || "")
          : document.getElementById("edit-apelido").value.trim(),
        idCliente: document.getElementById("edit-id-cliente").value.trim(),
      };
      const selectionRevisionAtSave = equipamentoSelectionRevision;

      const btn = document.getElementById("btn-salvar-equipamento");
      const originalText = btn.innerHTML;
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
      btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i><span>Salvando no Excel...</span>`;
      lucide.createIcons({ root: btn });

      try {
        const res = await fetch("/api/equipamento/salvar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.detail || "Falha ao salvar equipamento.");
        }

        const data = await res.json();
        const stillSelected = equipamentoSelectionRevision === selectionRevisionAtSave;
        if (stillSelected) {
          const dadosEntrega = capturarDadosEntrega();
          definirEquipamentoAtual(data.equipamento);
          exibirEquipamento(data.equipamento);
          restaurarDadosEntrega(dadosEntrega);
          document.getElementById("input-serial").value = data.equipamento.serial;
          document.getElementById("btn-clear-serial").classList.remove("hidden");

          atualizarIndicadoresPosSalvamento();
          fecharModalEditarEquipamento();
        }
        showToast(data.mensagem || `Equipamento ${serial} salvo com sucesso!`, "success");

      } catch (err) {
        console.error("Erro ao salvar:", err);
        showToast(err.message, "error");
      } finally {
        btn.disabled = false;
        btn.removeAttribute("aria-busy");
        btn.innerHTML = originalText;
        lucide.createIcons({ root: btn });
      }
    }

    // ==========================================
    // MODAL DE GERENCIAMENTO DE REGIONAIS
    // ==========================================
    function abrirModalGerenciarUnidades() {
      document.getElementById("input-filtro-unidades").value = "";
      toggleFormNovaUnidade(false);
      renderListaUnidades(unidadesList);
      document.getElementById("badge-total-unidades-modal").textContent = `${unidadesList.length} unidades`;
      abrirModalAcessivel("modal-gerenciar-unidades", "#input-filtro-unidades", "fecharModalGerenciarUnidades");
    }

    function fecharModalGerenciarUnidades() {
      fecharModalAcessivel("modal-gerenciar-unidades");
    }

    async function copiarTextoParaAreaTransferencia(texto) {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        try {
          await navigator.clipboard.writeText(texto);
          return;
        } catch (err) {
          // Tenta o fallback legado quando a permissão da API moderna é negada.
        }
      }

      const campoTemporario = document.createElement("textarea");
      campoTemporario.value = texto;
      campoTemporario.setAttribute("readonly", "");
      campoTemporario.setAttribute("aria-hidden", "true");
      campoTemporario.style.position = "fixed";
      campoTemporario.style.opacity = "0";
      campoTemporario.style.pointerEvents = "none";
      document.body.appendChild(campoTemporario);
      campoTemporario.select();

      let copiado = false;
      try {
        copiado = typeof document.execCommand === "function" && document.execCommand("copy");
      } finally {
        campoTemporario.remove();
      }

      if (!copiado) {
        throw new Error("A cópia não foi permitida pelo navegador.");
      }
    }

    async function copiarDadoUnidade(valor, campo) {
      const texto = String(valor || "").trim();
      if (!texto) {
        showToast(`${campo} não informado para esta unidade.`, "warning");
        return;
      }

      try {
        await copiarTextoParaAreaTransferencia(texto);
        showToast(campo === "CNPJ" ? "CNPJ copiado" : "CEP Copiado", "success");
      } catch (err) {
        showToast(`Não foi possível copiar o ${campo}.`, "error");
      }
    }

    function renderListaUnidades(lista) {
      const container = document.getElementById("lista-unidades-container");
      container.innerHTML = "";

      if (!lista || lista.length === 0) {
        container.innerHTML = `
          <div class="text-center py-8 text-slate-500 text-xs">
            Nenhuma unidade encontrada com o termo filtrado.
          </div>
        `;
        return;
      }

      lista.forEach(u => {
        const item = document.createElement("div");
        item.className = "flex items-center justify-between p-3 rounded-xl bg-slate-950/60 border border-slate-800/80 hover:border-amber-500/30 transition text-xs";
        item.innerHTML = `
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="font-bold text-white text-sm">${escapeHtml(u.cidade)}</span>
              ${u.is_sede ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">SEDE</span>' : ''}
              <span class="text-slate-400 font-mono text-[11px]">${escapeHtml(u.cnpj)}</span>
              <button type="button" data-copy-field="CNPJ" class="p-1 rounded-md text-slate-400 hover:text-amber-200 hover:bg-slate-800 transition" title="Copiar CNPJ" aria-label="Copiar CNPJ">
                <i data-lucide="copy" class="w-3.5 h-3.5" aria-hidden="true"></i>
              </button>
            </div>
            <p class="text-slate-300 mt-0.5 truncate">${escapeHtml(u.endereco)}</p>
            <div class="text-slate-500 font-mono text-[11px]">
              <div class="flex items-center gap-1.5">
                <span>CEP: ${escapeHtml(u.cep)}</span>
                <button type="button" data-copy-field="CEP" class="p-1 rounded-md text-slate-400 hover:text-amber-200 hover:bg-slate-800 transition" title="Copiar CEP" aria-label="Copiar CEP">
                  <i data-lucide="copy" class="w-3.5 h-3.5" aria-hidden="true"></i>
                </button>
              </div>
              <div>UF: ${escapeHtml(u.uf || 'PR')}</div>
            </div>
          </div>
          <div class="flex items-center gap-2 ml-3 shrink-0">
            <button
              data-action="edit"
              class="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-500/30 text-xs font-medium flex items-center gap-1 transition"
              title="Editar dados desta unidade"
            >
              <i data-lucide="edit-2" class="w-3.5 h-3.5"></i>
              <span>Editar</span>
            </button>
          </div>
        `;
        item.querySelector('[data-copy-field="CNPJ"]').addEventListener("click", () => copiarDadoUnidade(u.cnpj, "CNPJ"));
        item.querySelector('[data-copy-field="CEP"]').addEventListener("click", () => copiarDadoUnidade(u.cep, "CEP"));
        item.querySelector('[data-action="edit"]').addEventListener("click", () => editarUnidade(Number(u.id)));
        container.appendChild(item);
      });
      lucide.createIcons({ root: container });
    }

    function filtrarUnidadesModal(query) {
      const filtradas = unidadesList.filter(unit => catalogSearch.matchesCatalogSearch(unit, query));
      renderListaUnidades(filtradas);
    }

    function toggleFormNovaUnidade(show = null) {
      const form = document.getElementById("form-nova-unidade");
      const isHidden = form.classList.contains("hidden");
      const shouldShow = show !== null ? show : isHidden;

      if (shouldShow) {
        document.getElementById("form-unidade-id").value = "";
        document.getElementById("form-unidade-cidade").value = "";
        document.getElementById("form-unidade-endereco").value = "";
        document.getElementById("form-unidade-cep").value = "";
        document.getElementById("form-unidade-cnpj").value = "";
        document.getElementById("form-unidade-titulo").textContent = "Cadastrar Nova Unidade / Filial";
        form.classList.remove("hidden");
        document.getElementById("form-unidade-cidade").focus();
      } else {
        form.classList.add("hidden");
      }
    }

    function editarUnidade(id) {
      const unit = unidadesList.find(u => u.id === id);
      if (!unit) return;

      document.getElementById("form-unidade-id").value = unit.id;
      document.getElementById("form-unidade-cidade").value = unit.cidade || "";
      document.getElementById("form-unidade-endereco").value = unit.endereco || "";
      document.getElementById("form-unidade-cep").value = unit.cep || "";
      document.getElementById("form-unidade-cnpj").value = unit.cnpj || "";
      document.getElementById("form-unidade-titulo").textContent = `Editar Unidade: ${unit.cidade}`;

      document.getElementById("form-nova-unidade").classList.remove("hidden");
      document.getElementById("form-unidade-endereco").focus();
    }

    async function salvarUnidadeForm() {
      const cidade = document.getElementById("form-unidade-cidade").value.trim();
      const endereco = document.getElementById("form-unidade-endereco").value.trim();
      const cep = document.getElementById("form-unidade-cep").value.trim();
      const cnpj = document.getElementById("form-unidade-cnpj").value.trim();
      const idVal = document.getElementById("form-unidade-id").value;

      if (!cidade || !endereco || !cnpj) {
        showToast("Cidade, endereço e CNPJ são campos obrigatórios.", "warning");
        return;
      }

      const payload = {
        id: idVal ? parseInt(idVal) : null,
        cidade: cidade,
        endereco: endereco,
        uf: "PR",
        cep: cep,
        cnpj: cnpj
      };

      try {
        const res = await fetch("/api/unidade/salvar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.detail || "Erro ao salvar unidade.");
        }

        const data = await res.json();
        await carregarUnidades();
        renderListaUnidades(unidadesList);
        toggleFormNovaUnidade(false);
        showToast(data.mensagem || "Unidade salva com sucesso!", "success");

      } catch (err) {
        console.error("Erro ao salvar unidade:", err);
        showToast(err.message, "error");
      }
    }
