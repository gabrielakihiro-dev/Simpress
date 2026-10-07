    // State
    let currentEquipamento = null;
    let equipamentoSelectionRevision = 0;
    const CNPJ_FATURAMENTO_PADRAO = "75.110.585/0001-00";
    let retiradaCidadeSelecionada = "";
    let unidadesList = [];
    let debounceTimer = null;
    const transferUtils = window.SimpressTransferUtils;
    const autocompleteRequestGate = transferUtils.createRequestGate();
    const equipmentLookupRequestGate = transferUtils.createRequestGate();
    const searchButtonInitialHtml = document.getElementById("btn-buscar-serial")?.innerHTML || "";
    const modalReturnFocus = new Map();

    function definirEquipamentoAtual(equipment) {
      currentEquipamento = equipment;
      equipamentoSelectionRevision += 1;
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
      const modal = document.getElementById(modalId);
      if (!modal) return;

      const openModals = [...document.querySelectorAll('[data-accessible-modal="true"]')]
        .filter(item => !item.classList.contains("hidden"));
      const previousModal = openModals[openModals.length - 1];
      if (previousModal && previousModal !== modal) {
        previousModal.inert = true;
        previousModal.setAttribute("aria-hidden", "true");
      }

      if (!modalReturnFocus.has(modal)) modalReturnFocus.set(modal, document.activeElement);
      modal.classList.remove("hidden");
      modal.dataset.accessibleModal = "true";
      modal.dataset.closeFunction = closeFunction;

      const dialog = modal.firstElementChild;
      if (!dialog) return;
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("tabindex", "-1");
      dialog.classList.add("modal-panel");
      const heading = dialog.querySelector("h1, h2, h3");
      if (heading) {
        if (!heading.id) heading.id = `${modalId}-titulo`;
        dialog.setAttribute("aria-labelledby", heading.id);
      }

      document.body.classList.add("dialog-open");
      lucide.createIcons({ root: modal });
      requestAnimationFrame(() => {
        const preferred = initialFocusSelector ? dialog.querySelector(initialFocusSelector) : null;
        const target = preferred && !preferred.disabled ? preferred : dialog;
        target.focus({ preventScroll: true });
      });
    }

    function fecharModalAcessivel(modalId) {
      const modal = document.getElementById(modalId);
      if (!modal || modal.classList.contains("hidden")) return;
      modal.classList.add("hidden");
      const returnFocus = modalReturnFocus.get(modal);
      modalReturnFocus.delete(modal);

      const openModals = [...document.querySelectorAll('[data-accessible-modal="true"]')]
        .filter(item => !item.classList.contains("hidden"));
      const activeModal = openModals[openModals.length - 1];
      if (activeModal) {
        activeModal.inert = false;
        activeModal.removeAttribute("aria-hidden");
        const target = returnFocus && activeModal.contains(returnFocus)
          ? returnFocus
          : activeModal.firstElementChild;
        target?.focus({ preventScroll: true });
        return;
      }

      document.body.classList.remove("dialog-open");
      if (returnFocus instanceof HTMLElement && returnFocus.isConnected && !returnFocus.closest(".hidden") && returnFocus.getClientRects().length) {
        returnFocus.focus({ preventScroll: true });
      } else {
        const fallback = document.querySelector(".header-secondary-actions > summary") || document.getElementById("input-serial");
        fallback?.focus({ preventScroll: true });
      }
    }

    document.addEventListener("keydown", event => {
      const openModals = [...document.querySelectorAll('[data-accessible-modal="true"]')]
        .filter(item => !item.classList.contains("hidden"));
      const modal = openModals[openModals.length - 1];
      if (!modal) {
        if (event.key === "Escape") {
          const disclosure = [...document.querySelectorAll("details[open]")].pop();
          if (disclosure) {
            disclosure.open = false;
            disclosure.querySelector("summary")?.focus();
          }
        }
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        const close = window[modal.dataset.closeFunction];
        if (typeof close === "function") close();
        return;
      }

      if (event.key !== "Tab") return;
      const dialog = modal.firstElementChild;
      const focusable = [...dialog.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )].filter(element => element.getClientRects().length && !element.closest("[inert]"));
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    });

    function associarRotulosAcessiveis() {
      const fallbackLabels = new Map([
        ["input-serial", "Número de série do equipamento"],
        ["textarea-resumo-preview", "Resumo da transferência"],
      ]);
      document.querySelectorAll('input:not([type="hidden"]), select, textarea').forEach(control => {
        if (control.labels?.length || control.hasAttribute("aria-label") || control.hasAttribute("aria-labelledby")) return;
        if (!control.id) control.id = `campo-${Math.random().toString(36).slice(2, 9)}`;

        let label = null;
        let node = control;
        while (node.parentElement && node.parentElement !== document.body && !label) {
          const siblings = [...node.parentElement.children];
          const priorSiblings = siblings.slice(0, siblings.indexOf(node)).reverse();
          for (const sibling of priorSiblings) {
            const candidates = [
              ...(sibling.matches("label") ? [sibling] : []),
              ...sibling.querySelectorAll("label"),
            ];
            label = candidates.find(candidate => !candidate.control && !candidate.htmlFor);
            if (label) break;
          }
          node = node.parentElement;
        }

        if (label) {
          label.htmlFor = control.id;
          return;
        }
        const fallback = fallbackLabels.get(control.id)
          || control.getAttribute("placeholder")
          || control.id.replace(/[-_]+/g, " ");
        control.setAttribute("aria-label", fallback.replace(/\s+/g, " ").trim());
      });
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

    // Initialize page behaviors
    document.addEventListener("DOMContentLoaded", () => {
      document.getElementById("input-serial")?.addEventListener("input", () => {
        equipamentoSelectionRevision += 1;
      });
      lucide.createIcons();
      carregarConfiguracaoTransferencia();
      popularSeletoresRepresentantesRegionais();
      associarRotulosAcessiveis();
      inicializarMascarasTelefone();
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

    });

    // Toast system
    function showToast(message, type = "success") {
      const container = document.getElementById("toast-container");
      const toast = document.createElement("div");
      toast.setAttribute("role", type === "error" ? "alert" : "status");
      toast.setAttribute("aria-live", type === "error" ? "assertive" : "polite");
      toast.setAttribute("aria-atomic", "true");

      const bgColors = {
        success: "bg-emerald-950/90 border-emerald-500/50 text-emerald-200",
        error: "bg-rose-950/90 border-rose-500/50 text-rose-200",
        warning: "bg-amber-950/90 border-amber-500/50 text-amber-200",
        info: "bg-brand-950/90 border-brand-500/50 text-brand-200",
      };

      const iconNames = {
        success: "check-circle",
        error: "alert-circle",
        warning: "alert-triangle",
        info: "info",
      };

      toast.className = `flex items-center space-x-3 px-4 py-3 rounded-xl border shadow-xl backdrop-blur-md text-xs font-medium pointer-events-auto transform transition-all duration-300 opacity-0 translate-y-2 ${bgColors[type] || bgColors.info}`;
      const icon = createIcon(iconNames[type] || "info", "w-4 h-4 shrink-0");
      const messageElement = document.createElement("span");
      messageElement.textContent = String(message ?? "");
      toast.replaceChildren(icon, messageElement);

      container.appendChild(toast);
      lucide.createIcons({ root: toast });

      requestAnimationFrame(() => {
        toast.classList.remove("opacity-0", "translate-y-2");
      });

      setTimeout(() => {
        toast.classList.add("opacity-0", "translate-y-2");
        setTimeout(() => toast.remove(), 300);
      }, 4000);
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

      painelHome.hidden = !homeAtiva;
      painelTransferencia.hidden = homeAtiva;
      tabHome.setAttribute("aria-selected", String(homeAtiva));
      tabTransferencia.setAttribute("aria-selected", String(!homeAtiva));
      tabHome.tabIndex = homeAtiva ? 0 : -1;
      tabTransferencia.tabIndex = homeAtiva ? -1 : 0;
      tabHome.classList.toggle("is-active", homeAtiva);
      tabTransferencia.classList.toggle("is-active", !homeAtiva);
      document.body.classList.toggle("has-quick-actions", !homeAtiva);
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
        { id: "retirada-telefone", nome: "Telefone / Ramal do contato na retirada" },
        { id: "retirada-obs", nome: "Observações Adicionais da Retirada" },
        { id: "entrega-email", nome: "E-mail do Destinatário" },
        { id: "entrega-telefone", nome: "Telefone / Ramal do Destinatário" },
        { id: "entrega-horario", nome: "Expediente da unidade de entrega" },
        { id: "entrega-almoco", nome: "Horário de almoço da unidade de entrega" },
        { id: "entrega-obs", nome: "Observações Adicionais do Chamado" }
      ];
      if (!entregaAlmocoNaoFecha()) {
        campos.push({ id: "entrega-pausa-duracao", nome: "Duração da pausa da unidade de entrega" });
      }

      const campoVazio = campos.find(({ id }) => !document.getElementById(id).value.trim());
      if (!campoVazio) return true;

      const input = document.getElementById(campoVazio.id);
      showToast(`Preencha o campo obrigatório “${campoVazio.nome}” para gerar a planilha oficial.`, "warning");
      input.focus();
      input.scrollIntoView({ behavior: "smooth", block: "center" });
      return false;
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
          throw new Error(errData.detail || "Falha ao gerar o arquivo Excel no servidor.");
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
      if (!endpointFile || !detailsFile) {
        mostrarStatusUpload("Selecione Endpoint e EquipamentosDetalhes antes de atualizar.", true);
        return;
      }

      const button = document.getElementById("btn-confirmar-planilhas");
      const originalHtml = button.innerHTML;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      document.getElementById("modal-atualizar-planilhas").setAttribute("aria-busy", "true");
      button.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i><span>Validando e atualizando...</span>';
      lucide.createIcons({ root: button });

      const formData = new FormData();
      formData.append("endpoint_file", endpointFile);
      formData.append("details_file", detailsFile);

      try {
        const response = await fetch("/api/planilhas/atualizar", { method: "POST", body: formData });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (response.status === 404) {
            throw new Error("A API ativa está desatualizada. Feche a instância anterior e reinicie com iniciar_servidor.bat desta pasta.");
          }
          const detail = result.detail;
          throw new Error(Array.isArray(detail) ? detail.map(item => item.msg || item).join("; ") : (detail || "Falha ao atualizar as planilhas."));
        }

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
        abrirModalComparacaoPlanilhas(result.comparacao || {});
      } catch (error) {
        console.error("Erro ao atualizar planilhas:", error);
        mostrarStatusUpload(error.message || "Não foi possível atualizar as planilhas.", true);
      } finally {
        button.disabled = false;
        button.removeAttribute("aria-busy");
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
      return `
        <div class="accessible-table-wrap rounded-lg border border-slate-800" role="region" aria-label="${escapeHtml(tableLabel)}" tabindex="0">
          <table class="min-w-full text-left text-sm" aria-label="${escapeHtml(tableLabel)}">
            <thead class="bg-slate-950 text-slate-300"><tr>${headers.map(header => `<th scope="col" class="px-3 py-2.5 font-semibold whitespace-nowrap">${escapeHtml(header)}</th>`).join("")}</tr></thead>
            <tbody class="divide-y divide-slate-800">${rows.join("")}</tbody>
          </table>
        </div>`;
    }

    function abrirModalComparacaoPlanilhas(comparison) {
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
      const ambiguidades = comparison.correspondencias_ambiguas || [];
      const registrosAmbiguos = comparison.registros_ambiguos || [];
      const arquivo = comparison.arquivos_enviados || {};
      const apelidosAtualizados = comparison.apelidos_atualizados || [];
      const apelidosSemAtualizacao = comparison.apelidos_sem_atualizacao || [];
      const divergenciasApelidosManuais = comparison.divergencias_apelidos_manuais || [];
      const permitirAnotacoes = comparison.contexto_historico === true && Boolean(comparison.evento_id);
      const formatarMotivoRevisao = motivo => formatarNomeFonteHistorico(motivo || "Conferir associação.");
      const aliasReviewHeaders = ["Série", "Hostname no endpoint", "Motivo", ...(permitirAnotacoes ? ["Anotações"] : [])];

      document.getElementById("comparacao-planilhas-fontes").textContent =
        `no endpoint: ${formatarNomeFonteHistorico(arquivo.endpoint || "—")} · na Simpress: ${formatarNomeFonteHistorico(arquivo.detalhes || "—")}${comparison.horario_comparacao ? ` · ${formatarHorarioHistorico(comparison.horario_comparacao)}` : ""}`;

      const renderizarAusentes = items => items.map(item => `
        <tr class="text-slate-300">
          <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.computador)}</td>
          <td class="px-3 py-2 font-mono whitespace-nowrap">${escapeHtml(item.serie || "—")}</td>
          <td class="px-3 py-2">${escapeHtml(item.local_previsto || "—")}</td>
          <td class="px-3 py-2 text-amber-300">${escapeHtml(formatarNomeFonteHistorico((Array.isArray(item.ausente_em) ? item.ausente_em : [item.ausente_em || item.fonte_ausente]).filter(Boolean).join(", ")))}</td>
        </tr>`);

      const locationRows = divergenciasLocal.map(item => `
        <tr class="text-slate-300">
          <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.computador)}</td>
          <td class="px-3 py-2 font-mono whitespace-nowrap">${escapeHtml(item.serie || "—")}</td>
          <td class="px-3 py-2">${escapeHtml(item.local_previsto)}</td>
          <td class="px-3 py-2">${escapeHtml(item.local_detalhes || "—")}</td>
        </tr>`);

      const semAcessoRows = semAcesso14Dias.map(item => `
        <tr class="text-slate-300">
          <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.computador || "—")}</td>
          <td class="px-3 py-2 font-mono whitespace-nowrap">${escapeHtml(item.serie || "—")}</td>
          <td class="px-3 py-2 whitespace-nowrap">${escapeHtml(item.ultima_verificacao ? formatarHorarioHistorico(item.ultima_verificacao) : "—")}</td>
          <td class="px-3 py-2">${Number(item.dias_sem_verificacao || 0).toLocaleString("pt-BR")}</td>
          <td class="px-3 py-2">${escapeHtml(String(item.linha_endpoint || "—"))}</td>
        </tr>`);

      const aliasUpdateRows = apelidosAtualizados.map(item => `
        <tr class="text-slate-300">
          <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.serie || "—")}</td>
          <td class="px-3 py-2 font-mono">${escapeHtml(item.apelido_anterior || "(vazio)")}</td>
          <td class="px-3 py-2 font-mono text-emerald-200">${escapeHtml(item.apelido_novo || "(vazio)")}</td>
          <td class="px-3 py-2 whitespace-nowrap">${escapeHtml(item.horario ? formatarHorarioHistorico(item.horario) : "—")}</td>
          <td class="px-3 py-2 text-[10px]">${escapeHtml(formatarNomeFonteHistorico(Object.values(item.arquivos_origem || {}).join(" · ") || "—"))}</td>
        </tr>`);

      const aliasReviewRows = apelidosSemAtualizacao.map((item, index) => `
        <tr class="text-slate-300">
          <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.serie || "(vazia)")}</td>
          <td class="px-3 py-2 font-mono">${escapeHtml(item.computador || "—")}</td>
          <td class="px-3 py-2 text-amber-200">${escapeHtml(formatarMotivoRevisao(item.motivo))}</td>
          ${permitirAnotacoes ? `<td class="px-3 py-2 min-w-[240px] align-top">
            <textarea data-comparison-annotation data-annotation-id="${escapeHtml(item.anotacao_id || "")}" rows="2" maxlength="2000" class="w-full min-w-[220px] rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-2 text-xs text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400" aria-label="Anotações para a série ${escapeHtml(item.serie || "vazia")}, neste resultado" placeholder="Escreva uma anotação...">${escapeHtml(item.anotacao || "")}</textarea>
            <p class="mt-1 text-[10px] ${item.anotacao ? "text-emerald-300" : "text-slate-500"}" data-annotation-status aria-live="polite">${item.anotacao ? "Salvo automaticamente" : ""}</p>
          </td>` : ""}
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
        <tr class="text-slate-300">
          <td class="px-3 py-2 font-mono text-white">${escapeHtml(item.serie)}</td>
          <td class="px-3 py-2">${Number(item.quantidade || 0)}</td>
          <td class="px-3 py-2 font-mono">${escapeHtml((item.exemplos || []).join(", "))}</td>
        </tr>`);

      const ambiguityRows = [
        ...ambiguidades.map(item => ({
          tipo: item.tipo,
          chave: item.chave,
          fontes: (item.fontes || []).map(source =>
            `${formatarNomeFonteHistorico(source.fonte)}${source.quantidade ? ` (${source.quantidade} registros)` : source.serie ? ` — série ${source.serie}` : ""}`
          ).join(" · "),
          mensagem: formatarNomeFonteHistorico(item.mensagem || ""),
        })),
        ...registrosAmbiguos.map(item => ({
          tipo: "Presença ambígua",
          chave: `${item.computador || "Sem hostname"} · ${item.serie || "Sem série"}`,
          fontes: Object.entries(item.fontes || {}).filter(([, status]) => status === "ambíguo").map(([source]) => formatarNomeFonteHistorico(source)).join(" · "),
          mensagem: formatarNomeFonteHistorico(item.motivo || ""),
        })),
      ].map(item => `
        <tr class="text-slate-300">
          <td class="px-3 py-2 text-amber-200">${escapeHtml(item.tipo || "Ambiguidade")}</td>
          <td class="px-3 py-2 font-mono">${escapeHtml(item.chave || "—")}</td>
          <td class="px-3 py-2">${escapeHtml(item.fontes || "—")}</td>
          <td class="px-3 py-2">${escapeHtml(item.mensagem || "")}</td>
        </tr>`);

      document.getElementById("comparacao-planilhas-conteudo").innerHTML = comparison.somente_anotacoes_sincronizadas
        ? `
          <p class="text-xs text-cyan-200 bg-cyan-500/10 border border-cyan-500/25 rounded-lg px-3 py-2">Este clone contém as anotações sincronizadas. O resultado original e os arquivos da comparação não estão armazenados neste dispositivo.</p>
          <section class="space-y-2">
            <div><h4 class="text-sm font-bold text-amber-300">Anotações sincronizadas</h4><p class="text-[11px] text-slate-500">As anotações continuam vinculadas às linhas da atualização original.</p></div>
            ${renderizarTabelaComparacao(aliasReviewHeaders, aliasReviewRows, "Nenhuma anotação sincronizada neste resultado.")}
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
          <div><h4 class="text-sm font-bold text-amber-300">Linhas mantidas para conferência</h4><p class="text-[11px] text-slate-500">Série vazia, ausente ou duplicada não é escolhida automaticamente; o apelido atual fica preservado.${permitirAnotacoes ? ` As anotações pertencem a esta linha desta atualização, não são reaproveitadas em novas atualizações e são salvas automaticamente${comparison.anotacoes_sync_ativa ? " e sincronizadas pela pasta OneDrive." : " neste dispositivo."}` : ""}</p></div>
          ${renderizarTabelaComparacao(aliasReviewHeaders, aliasReviewRows, "Nenhuma linha de apelido precisa de conferência.")}
        </section>
        <section class="space-y-2">
          <div><h4 class="text-sm font-bold text-violet-300">Divergências com apelidos alterados manualmente</h4><p class="text-[11px] text-slate-500">O apelido manual prevalece nas pesquisas e exportações. “Manter manual” registra a decisão; “Excluir manual” remove apenas o override desta série e volta a usar o valor das planilhas.</p></div>
          ${renderizarTabelaComparacao(["Série", "Apelido manual", "na Simpress", "no endpoint", "Situação", "Ação"], manualAliasRows, "Nenhuma divergência entre apelidos manuais e as planilhas enviadas.")}
        </section>
        <section class="space-y-2">
          <div><h4 class="text-sm font-bold text-rose-300">Sem acesso há 14 dias ou mais</h4><p class="text-[11px] text-slate-500">Notebook com última verificação com êxito igual ou anterior a 14 dias antes desta atualização.</p></div>
          ${renderizarTabelaComparacao(["Hostname/Apelido", "Série", "Última verificação com êxito", "Dias sem verificação", "Linha no endpoint"], semAcessoRows, "Nenhum notebook está há 14 dias ou mais sem verificação com êxito.")}
        </section>
        <section class="space-y-2">
          <div><h4 class="text-sm font-bold text-rose-300">Equipamentos sem correspondência por fonte</h4><p class="text-[11px] text-slate-500">Cada lista mostra equipamentos que não têm correspondência segura naquela fonte. Divergências de local aparecem em seção própria.</p></div>
          <h5 class="text-xs font-semibold text-slate-300">Sem correspondência — no endpoint (${ausentesEndpoint.length})</h5>
          ${renderizarTabelaComparacao(["Hostname/Apelido", "Série", "Local previsto", "Sem correspondência em"], renderizarAusentes(ausentesEndpoint), "Todos os equipamentos têm correspondência segura com no endpoint.")}
          <h5 class="text-xs font-semibold text-slate-300">Sem correspondência — na Simpress (${ausentesDetalhes.length})</h5>
          ${renderizarTabelaComparacao(["Hostname/Apelido", "Série", "Local previsto", "Sem correspondência em"], renderizarAusentes(ausentesDetalhes), "Todos os equipamentos têm correspondência segura na Simpress.")}
        </section>
        <section class="space-y-2">
          <div><h4 class="text-sm font-bold text-amber-300">Localidade divergente</h4><p class="text-[11px] text-slate-500">A localidade na Simpress é comparada com a classificação do hostname.</p></div>
          ${renderizarTabelaComparacao(["Computador", "Série", "Local previsto", "Local na Simpress"], locationRows, "Nenhuma divergência de localidade encontrada.")}
        </section>
        <section class="space-y-2">
          <div><h4 class="text-sm font-bold text-yellow-300">Duplicidades e correspondências ambíguas</h4><p class="text-[11px] text-slate-500">Nenhuma linha é escolhida automaticamente quando a série se repete ou o hostname/Apelido não identifica uma correspondência única.</p></div>
          ${renderizarTabelaComparacao(["Ocorrência", "Série ou hostname/Apelido", "Fontes", "Tratamento"], ambiguityRows, "Nenhuma duplicidade ou correspondência ambígua encontrada.")}
        </section>
        <section class="space-y-2">
          <div><h4 class="text-sm font-bold text-sky-300">Séries sem local definido</h4><p class="text-[11px] text-slate-500">Não há regra de localidade cadastrada para estes prefixos.</p></div>
          ${renderizarTabelaComparacao(["Série", "Quantidade", "Exemplos"], unmappedRows, "Todas as séries têm mapeamento de localidade.")}
        </section>
        <p class="text-[11px] text-emerald-300">Equipamentos carregados na Simpress: ${Number(comparison.total_equipamentos_carregados || 0).toLocaleString("pt-BR")}. Backup das versões anteriores: <span class="font-mono">planilhas_entrada/${escapeHtml(comparison.backup_diretorio || "_backups")}</span>.</p>
      `;
      document.querySelectorAll("[data-manual-alias-action]").forEach(button => {
        button.addEventListener("click", () => {
          const item = divergenciasApelidosManuais[Number(button.dataset.manualAliasIndex)];
          if (item) resolverDivergenciaApelidoManual(comparison, item, button.dataset.manualAliasAction, button);
        });
      });
      document.querySelectorAll("[data-comparison-annotation]").forEach(textarea => {
        const itemId = textarea.dataset.annotationId;
        const status = textarea.parentElement.querySelector("[data-annotation-status]");
        let savedValue = textarea.value;
        let dirty = false;
        let saving = false;
        let saveTimer = null;

        const setStatus = (message, colorClass) => {
          status.textContent = message;
          status.className = `mt-1 text-[10px] ${colorClass}`;
        };
        const scheduleSave = delay => {
          window.clearTimeout(saveTimer);
          saveTimer = window.setTimeout(() => {
            saveTimer = null;
            void saveAnnotation();
          }, delay);
        };
        const saveAnnotation = async () => {
          if (saving || !dirty) return;
          const anotacao = textarea.value;
          saving = true;
          setStatus("Salvando...", "text-cyan-300");
          try {
            const { response, stale } = await window.HistoryAnnotationAutosave.requestWithRetries(
              () => fetch(
                `/api/historico-comparacoes/${encodeURIComponent(comparison.evento_id)}/anotacoes/${encodeURIComponent(itemId)}`,
                {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ anotacao }),
                }
              ),
              {
                isCurrent: () => textarea.value === anotacao,
                onRetry: attempt => setStatus(
                  `Falha temporária. Tentando salvar novamente (${attempt}/3)...`,
                  "text-amber-300"
                ),
              }
            );
            if (stale) {
              savedValue = anotacao;
              dirty = textarea.value !== anotacao;
              setStatus(dirty ? "Salvando alteração mais recente..." : "Salvo automaticamente", dirty ? "text-cyan-300" : "text-emerald-300");
              return;
            }
            savedValue = anotacao;
            dirty = textarea.value !== anotacao;
            setStatus(dirty ? "Salvando..." : "Salvo automaticamente", dirty ? "text-cyan-300" : "text-emerald-300");
          } catch (error) {
            dirty = true;
            setStatus(
              error.status ? error.message : "Falha de conexão após três tentativas. Tente novamente.",
              "text-rose-300"
            );
          } finally {
            saving = false;
            if (dirty && textarea.value !== anotacao) scheduleSave(0);
          }
        };

        textarea.addEventListener("input", () => {
          dirty = true;
          setStatus("Pendente de salvamento...", "text-slate-400");
          scheduleSave(500);
        });
        textarea.addEventListener("blur", () => scheduleSave(0));
      });
      abrirModalAcessivel("modal-comparacao-planilhas", '[aria-label="Fechar resultado"]', "fecharModalComparacaoPlanilhas");
    }

    async function resolverDivergenciaApelidoManual(comparison, item, acao, botao) {
      if (!comparison.evento_id || !item.serie) {
        showToast("Este registro não permite resolver a divergência.", "error");
        return;
      }
      if (acao === "excluir" && !window.confirm(
        `Remover a alteração manual da série ${item.serie}? O apelido voltará ao hostname da fonte no endpoint, se preenchido, ou ao valor cadastrado na Simpress.`
      )) return;

      const row = botao.closest("tr");
      const actionArea = row?.querySelector("[data-manual-alias-actions]");
      const buttons = actionArea ? [...actionArea.querySelectorAll("button")] : [botao];
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
        const status = row?.querySelector("[data-manual-alias-status]");
        if (status) status.textContent = acao === "manter" ? "Alteração manual mantida" : "Alteração manual removida";
        if (actionArea) {
          const concluido = document.createElement("span");
          concluido.className = "text-[10px] text-slate-500";
          concluido.textContent = "Concluído";
          actionArea.replaceWith(concluido);
        }

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
        lista.removeAttribute("aria-busy");
      }
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
        const response = await fetch(`/api/historico-comparacoes/${encodeURIComponent(evento.id)}/restaurar`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ preview_token: preview.preview_token }),
        });
        const data = await response.json().catch(() => ({}));
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

    async function consultarHistoricoComparacao(eventoId, botao) {
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
        });
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
      const data = new Date(horario);
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
      document.getElementById("badge-total-historico-apelidos").textContent = valor;
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
      const q = (query || "").toLowerCase().trim();
      if (!q) {
        renderListaUnidades(unidadesList);
        return;
      }
      const filtradas = unidadesList.filter(u =>
        (u.cidade && u.cidade.toLowerCase().includes(q)) ||
        (u.endereco && u.endereco.toLowerCase().includes(q)) ||
        (u.cnpj && u.cnpj.toLowerCase().includes(q)) ||
        (u.cep && u.cep.toLowerCase().includes(q))
      );
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
