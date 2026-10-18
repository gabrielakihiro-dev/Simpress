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

  const AVISO_CONTATO_ORIGEM = "Contato de origem não configurado nesta instalação. Preencha nome, e-mail e celular abaixo para esta transferência ou salve um contato padrão.";
  const AVISO_ARQUIVO_CONTATO_INVALIDO = "O arquivo config/contato_origem.json não pôde ser lido. Preencha o contato abaixo ou salve-o novamente.";
  const CAMPOS_CONTATO_ORIGEM = [
    ["retirada_contato", "contato", "contato-origem-nome", "contatoPadrao", "contatoId"],
    ["retirada_email", "email", "contato-origem-email", "emailPadrao", "emailId"],
    ["retirada_telefone", "telefone", "contato-origem-telefone", "telefonePadrao", "telefoneId"],
  ];
  let configuracaoContatoOrigem = null;
  let salvandoContatoOrigem = false;

  // Fills the pickup contact from the installation defaults, replacing only values the user did not edit.
  function aplicarConfiguracaoTransferencia(config) {
    configuracaoContatoOrigem = config;
    const origin = CAMPOS_CONTATO_REGIONAL.retirada;
    CAMPOS_CONTATO_ORIGEM.forEach(([campoApi, , , defaultKey, inputKey]) => {
      const value = config[campoApi];
      const normalized = typeof value === "string" ? value.trim() : "";
      const anterior = origin[defaultKey];
      origin[defaultKey] = normalized;
      const input = document.getElementById(origin[inputKey]);
      if (input && (!input.value.trim() || input.value.trim() === anterior)) input.value = normalized;
    });
    const aviso = document.getElementById("aviso-contato-origem");
    if (aviso) {
      const texto = document.getElementById("aviso-contato-origem-texto");
      if (texto) texto.textContent = config.contato_origem_arquivo_invalido ? AVISO_ARQUIVO_CONTATO_INVALIDO : AVISO_CONTATO_ORIGEM;
      aviso.classList.toggle("hidden", config.contato_origem_configurado !== false);
    }
  }

  async function carregarConfiguracaoTransferencia() {
    try {
      const response = await fetch("/api/config/transferencia", { cache: "no-store" });
      if (!response.ok) throw new Error("Falha ao carregar os contatos padrão da instalação.");
      aplicarConfiguracaoTransferencia(await response.json());
    } catch (error) {
      console.warn("Não foi possível carregar os contatos de retirada configurados:", error);
    }
  }

  function abrirConfiguracaoContatoOrigem() {
    if (salvandoContatoOrigem) return;
    const config = configuracaoContatoOrigem || {};
    const fontes = config.contato_origem_fontes || {};
    let algumAmbiente = false;
    CAMPOS_CONTATO_ORIGEM.forEach(([campoApi, , inputId]) => {
      const input = document.getElementById(inputId);
      if (!input) return;
      const doAmbiente = fontes[campoApi] === "ambiente";
      algumAmbiente ||= doAmbiente;
      input.value = typeof config[campoApi] === "string" ? config[campoApi] : "";
      input.readOnly = doAmbiente;
      input.required = !doAmbiente;
      input.setAttribute("aria-required", String(!doAmbiente));
    });
    document.getElementById("contato-origem-ambiente")?.classList.toggle("hidden", !algumAmbiente);
    const status = document.getElementById("status-contato-origem");
    status.setAttribute("role", "status");
    status.textContent = "";
    const primeiroEditavel = CAMPOS_CONTATO_ORIGEM.map(([, , id]) => document.getElementById(id))
      .find(input => input && !input.readOnly);
    app.abrirModalAcessivel(
      "modal-contato-origem",
      primeiroEditavel ? `#${primeiroEditavel.id}` : "#btn-salvar-contato-origem",
      "fecharConfiguracaoContatoOrigem",
    );
  }

  function fecharConfiguracaoContatoOrigem() {
    if (!salvandoContatoOrigem) app.fecharModalAcessivel("modal-contato-origem");
  }

  async function salvarConfiguracaoContatoOrigem() {
    if (salvandoContatoOrigem) return;
    const modal = document.getElementById("modal-contato-origem");
    const status = document.getElementById("status-contato-origem");
    const button = document.getElementById("btn-salvar-contato-origem");
    const fontes = configuracaoContatoOrigem?.contato_origem_fontes || {};
    const payload = {};
    for (const [campoApi, chave, inputId] of CAMPOS_CONTATO_ORIGEM) {
      const input = document.getElementById(inputId);
      // Environment values stay out of the local file; the server keeps them in front.
      payload[chave] = fontes[campoApi] === "ambiente" ? "" : (input?.value || "").trim();
      if (fontes[campoApi] !== "ambiente" && !payload[chave]) {
        status.setAttribute("role", "alert");
        status.textContent = `Preencha o campo "${input?.labels?.[0]?.textContent.replace("*", "").replace(":", "").trim() || chave}".`;
        input?.focus();
        return;
      }
    }
    salvandoContatoOrigem = true;
    button.disabled = true;
    modal.setAttribute("aria-busy", "true");
    status.setAttribute("role", "status");
    status.textContent = "Salvando o contato de origem…";
    try {
      const response = await fetch("/api/config/transferencia/contato-origem", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw app.createApiError(result.detail, "Não foi possível salvar o contato de origem.");
      aplicarConfiguracaoTransferencia(result);
      salvandoContatoOrigem = false;
      app.fecharModalAcessivel("modal-contato-origem");
      app.showToast("Contato de origem salvo.", "success");
    } catch (error) {
      status.setAttribute("role", "alert");
      status.textContent = error.message || "Não foi possível salvar o contato de origem.";
    } finally {
      salvandoContatoOrigem = false;
      button.disabled = false;
      modal.removeAttribute("aria-busy");
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

  // Fields filled from a representative, in order. Contact fields are forced whenever a representative matches
  // and clear only for a named one; schedule fields are forced only by their own value and clear for any match.
  const CAMPOS_PREENCHIDOS_POR_REPRESENTANTE = [
    { campo: "contato", chave: "nome", forcarPorValor: false, limparSe: null },
    { campo: "email", chave: "email", forcarPorValor: false, limparSe: "nome" },
    { campo: "telefone", chave: "telefone", forcarPorValor: false, limparSe: "nome" },
    { campo: "horario", chave: "horario", forcarPorValor: true, limparSe: "representante" },
    { campo: "almoco", chave: "almoco", forcarPorValor: true, limparSe: "representante" },
    { campo: "pausaDuracao", chave: "pausaDuracao", forcarPorValor: true, limparSe: "representante" },
  ];

  function valorDoRepresentante(representante, chave) {
    if (chave === "telefone") {
      return representante?.telefone ? app.formatarTelefoneBrasileiro(representante.telefone) : "";
    }
    return representante?.[chave] || "";
  }

  function deveLimparCampoRegional(representante, regra, valor) {
    const elegivel = regra.limparSe === "nome" ? Boolean(representante?.nome)
      : regra.limparSe === "representante" ? Boolean(representante)
        : false;
    return elegivel && Object.prototype.hasOwnProperty.call(representante, regra.chave) && !valor;
  }

  function preencherRepresentanteRegional(tipo, cidade, forcar = false) {
    const campos = CAMPOS_CONTATO_REGIONAL[tipo];
    if (!campos) return null;

    const representante = obterRepresentanteRegional(cidade);
    const seletor = document.getElementById(campos.selectId);
    if (seletor) seletor.value = representante?.cidade || "";
    CAMPOS_PREENCHIDOS_POR_REPRESENTANTE.forEach((regra) => {
      const campo = document.getElementById(campos[`${regra.campo}Id`]);
      if (!campo) return;
      const valor = valorDoRepresentante(representante, regra.chave);
      atualizarCampoContatoRegional(
        campo,
        valor,
        campos[`${regra.campo}Padrao`],
        forcar && Boolean(regra.forcarPorValor ? valor : representante),
        deveLimparCampoRegional(representante, regra, valor)
      );
    });
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
    abrirConfiguracaoContatoOrigem, fecharConfiguracaoContatoOrigem, salvarConfiguracaoContatoOrigem,
    atualizarObrigatoriedadeDuracaoPausaEntrega, popularSeletoresRepresentantesRegionais,
    preencherRepresentanteRegional, handleRepresentanteRegionalChange, inicializarMascarasTelefone,
  };
});
