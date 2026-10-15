/** Regional SEBRAE/PR representatives: fills pickup and delivery contacts by city, and formats phone fields. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).regionalContacts = factory;
})(typeof window !== "undefined" ? window : globalThis, function createRegionalContacts(context) {
  "use strict";
  const { app, transferUtils } = context;

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

    const obrigatorio = !app.entregaAlmocoNaoFecha();
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
        ? app.formatarTelefoneBrasileiro(representante.telefone)
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
    if (tipo === "entrega") app.atualizarObrigatoriedadeDuracaoPausaEntrega();
    return representante;
  }

  function handleRepresentanteRegionalChange(tipo, cidade) {
    const representante = obterRepresentanteRegional(cidade);
    app.preencherRepresentanteRegional(tipo, representante?.cidade || "", Boolean(representante));
  }

  function aplicarMascaraTelefone(input) {
    const cursor = input.selectionStart ?? input.value.length;
    const digitosAntesDoCursor = (input.value.slice(0, cursor).match(/\d/g) || []).length;
    const valorFormatado = app.formatarTelefoneBrasileiro(input.value);
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
      input.value = app.formatarTelefoneBrasileiro(input.value);
      input.addEventListener("input", () => aplicarMascaraTelefone(input));
      input.addEventListener("change", () => aplicarMascaraTelefone(input));
      input.addEventListener("blur", () => aplicarMascaraTelefone(input));
    });
  }

  return {
    formatarTelefoneBrasileiro, carregarConfiguracaoTransferencia, entregaAlmocoNaoFecha,
    atualizarObrigatoriedadeDuracaoPausaEntrega, popularSeletoresRepresentantesRegionais,
    preencherRepresentanteRegional, handleRepresentanteRegionalChange, inicializarMascarasTelefone,
  };
});
