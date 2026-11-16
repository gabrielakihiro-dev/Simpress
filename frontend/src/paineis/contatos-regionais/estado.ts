type TipoFormulario = "retirada" | "entrega";
type ApiFetch = <T = unknown>(url: string, options?: RequestInit & { errorMessage?: string }) => Promise<T>;
interface TransferUtils { formatBrazilPhone(valor: unknown): string; }
interface AppRegional {
  abrirModalAcessivel(modalId: string, focoInicial: string, acaoFechar: string): void;
  fecharModalAcessivel(modalId: string): void;
  abrirImportacaoModelo(tipo: string): void;
  confirmarAcao(opcoes: { titulo: string; mensagem: string; confirmar: string; destrutiva?: boolean }): Promise<boolean>;
  showToast(mensagem: string, tipo: string): void;
}
interface CamposContato {
  selectId: string;
  contatoId: string;
  emailId: string;
  telefoneId: string;
  horarioId: string;
  almocoId: string;
  pausaDuracaoId: string;
  contatoPadrao: string;
  emailPadrao: string;
  telefonePadrao: string;
  horarioPadrao: string;
  almocoPadrao: string;
  pausaDuracaoPadrao: string;
}
interface ConfigTransferencia extends Record<string, unknown> {
  contato_origem_fontes?: Record<string, string>;
  cliente_configurado?: boolean;
  modelo_transferencia_disponivel?: boolean;
}
interface ConfigCliente extends Record<string, unknown> {
  contrato?: string;
  cnpj_faturamento?: string;
  cliente_fontes?: Record<string, string>;
  series_sebrae_fora?: unknown;
}
interface RepresentanteRegional {
  cidade: string;
  nome: string;
  nomeOpcao?: string;
  email: string;
  telefone: string;
  horario: string;
  almoco: string;
  pausaDuracao: string;
}
type AlteracaoRepresentante = Partial<Omit<RepresentanteRegional, "cidade">>;
interface ResultadoRepresentantes extends Record<string, unknown> {
  alteracoes?: Record<string, AlteracaoRepresentante>;
  padroes?: RepresentanteRegional[];
  padroes_arquivo_invalido?: boolean;
}
export interface ContextoContatosRegionais {
  app: AppRegional;
  transferUtils: TransferUtils;
  apiFetch: ApiFetch;
}

/** Contatos e configurações usados pela retirada, entrega e representantes regionais. */
export function criarContatosRegionais(context: ContextoContatosRegionais) {
  "use strict";
  const { app, transferUtils } = context;
  const elemento = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
  const mensagemErro = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

  // Phone field formatting
  function formatarTelefoneBrasileiro(valor: unknown) {
    return transferUtils.formatBrazilPhone(valor);
  }

  const CAMPOS_CONTATO_REGIONAL: Record<TipoFormulario, CamposContato> = {
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
  const CAMPOS_CONTATO_ORIGEM: [string, string, string, keyof CamposContato, keyof CamposContato][] = [
    ["retirada_contato", "contato", "contato-origem-nome", "contatoPadrao", "contatoId"],
    ["retirada_email", "email", "contato-origem-email", "emailPadrao", "emailId"],
    ["retirada_telefone", "telefone", "contato-origem-telefone", "telefonePadrao", "telefoneId"],
  ];
  let configuracaoContatoOrigem: ConfigTransferencia | null = null;
  let salvandoContatoOrigem = false;

  // Client data (contract, billing CNPJ) of this installation: blank until config/cliente.json or the environment has it.
  // The server refuses transfers, UX tickets and Chrome routines while it is blank; the modal below fills it.
  let dadosClienteAtuais = { contrato: "", cnpj_faturamento: "" };
  let salvandoCliente = false;
  let abriuClienteAutomaticamente = false;
  const FORMATO_CNPJ_CLIENTE = /^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/;

  function obterDadosCliente(): { contrato: string; cnpj_faturamento: string } {
    return { ...dadosClienteAtuais };
  }

  function aplicarConfiguracaoCliente(config: ConfigCliente) {
    const texto = (valor: unknown) => (typeof valor === "string" ? valor.trim() : "");
    dadosClienteAtuais = { contrato: texto(config.contrato), cnpj_faturamento: texto(config.cnpj_faturamento) };
    const contrato = document.getElementById("stat-contrato");
    if (contrato) contrato.textContent = dadosClienteAtuais.contrato || "—";
    const naoConfigurado = config.cliente_configurado === false;
    document.getElementById("aviso-cliente-config")?.classList.toggle("hidden", !naoConfigurado);
    // First access: open the form once, unless another dialog is already in front of the user.
    if (naoConfigurado && !abriuClienteAutomaticamente) {
      abriuClienteAutomaticamente = true;
      if (!document.querySelector(".modal-overlay:not(.hidden)")) abrirConfiguracaoCliente();
    }
  }

  // Fills the pickup contact from the installation defaults, replacing only values the user did not edit.
  function aplicarConfiguracaoTransferencia(config: ConfigTransferencia) {
    configuracaoContatoOrigem = config;
    const origin = CAMPOS_CONTATO_REGIONAL.retirada;
    CAMPOS_CONTATO_ORIGEM.forEach(([campoApi, , , defaultKey, inputKey]) => {
      const value = config[campoApi];
      const normalized = typeof value === "string" ? value.trim() : "";
      const anterior = origin[defaultKey];
      origin[defaultKey] = normalized;
      const input = document.getElementById(origin[inputKey]) as HTMLInputElement | null;
      if (input && (!input.value.trim() || input.value.trim() === anterior)) input.value = normalized;
    });
    // The answer of the origin contact PUT carries no client fields: leave the client data alone then.
    if ("cliente_configurado" in config) aplicarConfiguracaoCliente(config);
    const aviso = document.getElementById("aviso-contato-origem");
    if (aviso) {
      const texto = document.getElementById("aviso-contato-origem-texto");
      if (texto) texto.textContent = config.contato_origem_arquivo_invalido ? AVISO_ARQUIVO_CONTATO_INVALIDO : AVISO_CONTATO_ORIGEM;
      aviso.classList.toggle("hidden", config.contato_origem_configurado !== false);
    }
  }

  async function carregarConfiguracaoTransferencia() {
    try {
      const config = await context.apiFetch<ConfigTransferencia>("/api/config/transferencia", {
        cache: "no-store", errorMessage: "Falha ao carregar os contatos padrão da instalação.",
      });
      aplicarConfiguracaoTransferencia(config);
    } catch (error) {
      console.warn("Não foi possível carregar os contatos de retirada configurados:", error);
    }
  }

  function abrirConfiguracaoContatoOrigem() {
    if (salvandoContatoOrigem) return;
    const config = configuracaoContatoOrigem || {};
    const fontes: Record<string, string> = config.contato_origem_fontes || {};
    let algumAmbiente = false;
    CAMPOS_CONTATO_ORIGEM.forEach(([campoApi, , inputId]) => {
      const input = document.getElementById(inputId) as HTMLInputElement | null;
      if (!input) return;
      const doAmbiente = fontes[campoApi] === "ambiente";
      algumAmbiente ||= doAmbiente;
      input.value = typeof config[campoApi] === "string" ? config[campoApi] : "";
      input.readOnly = doAmbiente;
      input.required = !doAmbiente;
      input.setAttribute("aria-required", String(!doAmbiente));
    });
    document.getElementById("contato-origem-ambiente")?.classList.toggle("hidden", !algumAmbiente);
    const status = elemento<HTMLDivElement>("status-contato-origem");
    status.setAttribute("role", "status");
    status.textContent = "";
    const primeiroEditavel = CAMPOS_CONTATO_ORIGEM.map(([, , id]) => document.getElementById(id) as HTMLInputElement | null)
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
    const modal = elemento<HTMLDivElement>("modal-contato-origem");
    const status = elemento<HTMLDivElement>("status-contato-origem");
    const button = elemento<HTMLButtonElement>("btn-salvar-contato-origem");
    const fontes = configuracaoContatoOrigem?.contato_origem_fontes || {};
    const payload: Record<string, string> = {};
    for (const [campoApi, chave, inputId] of CAMPOS_CONTATO_ORIGEM) {
      const input = document.getElementById(inputId) as HTMLInputElement | null;
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
      const result = await context.apiFetch<ConfigTransferencia>("/api/config/transferencia/contato-origem", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        errorMessage: "Não foi possível salvar o contato de origem.",
      });
      aplicarConfiguracaoTransferencia(result);
      salvandoContatoOrigem = false;
      app.fecharModalAcessivel("modal-contato-origem");
      app.showToast("Contato de origem salvo.", "success");
    } catch (error) {
      status.setAttribute("role", "alert");
      status.textContent = mensagemErro(error, "Não foi possível salvar o contato de origem.");
    } finally {
      salvandoContatoOrigem = false;
      button.disabled = false;
      modal.removeAttribute("aria-busy");
    }
  }

  async function lerJson<T extends Record<string, unknown>>(url: string): Promise<T> {
    return context.apiFetch<T>(url, { cache: "no-store", errorMessage: `Falha ao carregar ${url}.` });
  }

  async function abrirConfiguracaoCliente() {
    if (salvandoCliente) return;
    const status = elemento<HTMLDivElement>("status-cliente-config");
    status.setAttribute("role", "status");
    status.textContent = "";
    let cliente: ConfigCliente = {};
    let modeloDisponivel = true;
    try {
      const [dadosCliente, transferencia] = await Promise.all([
        lerJson("/api/config/cliente"), lerJson("/api/config/transferencia"),
      ]);
      cliente = dadosCliente;
      modeloDisponivel = transferencia.modelo_transferencia_disponivel !== false;
    } catch (error) {
      console.warn("Não foi possível ler os dados do cliente salvos:", error);
      status.setAttribute("role", "alert");
      status.textContent = "Não foi possível ler os dados atuais. Preencha os campos e salve.";
    }
    const fontes: Record<string, string> = cliente.cliente_fontes || {};
    const campos: [string, "contrato" | "cnpj_faturamento"][] = [["cliente-config-contrato", "contrato"], ["cliente-config-cnpj", "cnpj_faturamento"]];
    campos.forEach(([inputId, chave]) => {
      const input = elemento<HTMLInputElement>(inputId);
      const doAmbiente = fontes[chave] === "ambiente";
      input.value = typeof cliente[chave] === "string" ? cliente[chave] : "";
      input.readOnly = doAmbiente;
      input.required = !doAmbiente;
      input.setAttribute("aria-required", String(!doAmbiente));
    });
    const series = elemento<HTMLTextAreaElement>("cliente-config-series");
    series.value = Array.isArray(cliente.series_sebrae_fora) ? cliente.series_sebrae_fora.join("\n") : "";
    series.readOnly = fontes.series_sebrae_fora === "ambiente";
    const algumAmbiente = Object.values(fontes).includes("ambiente");
    document.getElementById("cliente-config-ambiente")?.classList.toggle("hidden", !algumAmbiente);
    document.getElementById("cliente-config-modelo-ausente")?.classList.toggle("hidden", modeloDisponivel);
    const primeiroEditavel = campos.map(([id]) => elemento<HTMLInputElement>(id)).find((input) => !input.readOnly);
    app.abrirModalAcessivel(
      "modal-cliente-config",
      primeiroEditavel ? `#${primeiroEditavel.id}` : "#btn-salvar-cliente-config",
      "fecharConfiguracaoCliente",
    );
  }

  function fecharConfiguracaoCliente() {
    if (!salvandoCliente) app.fecharModalAcessivel("modal-cliente-config");
  }

  // The model import dialog is a separate modal: close this one first so only one stays in front.
  function abrirImportacaoModeloTransferencia() {
    if (salvandoCliente) return;
    app.fecharModalAcessivel("modal-cliente-config");
    app.abrirImportacaoModelo("transferencia");
  }

  async function salvarConfiguracaoCliente() {
    if (salvandoCliente) return;
    const modal = elemento<HTMLDivElement>("modal-cliente-config");
    const status = elemento<HTMLDivElement>("status-cliente-config");
    const button = elemento<HTMLButtonElement>("btn-salvar-cliente-config");
    const contrato = elemento<HTMLInputElement>("cliente-config-contrato");
    const cnpj = elemento<HTMLInputElement>("cliente-config-cnpj");
    const series = elemento<HTMLTextAreaElement>("cliente-config-series");
    const recusar = (input: HTMLInputElement | HTMLTextAreaElement, mensagem: string) => {
      status.setAttribute("role", "alert");
      status.textContent = mensagem;
      input.focus();
    };
    // Values from the environment stay out of the local file; the server keeps them in front.
    if (!contrato.readOnly && !/^\d{1,12}$/.test(contrato.value.trim())) {
      return recusar(contrato, 'Informe o "Contrato" só com números (até 12 dígitos).');
    }
    if (!cnpj.readOnly && !FORMATO_CNPJ_CLIENTE.test(cnpj.value.trim())) {
      return recusar(cnpj, 'Informe o "CNPJ de faturamento" no formato 00.000.000/0000-00.');
    }
    const payload = {
      contrato: contrato.readOnly ? "" : contrato.value.trim(),
      cnpj_faturamento: cnpj.readOnly ? "" : cnpj.value.trim(),
      // null keeps the stored list (also when the environment provides it).
      series_sebrae_fora: series.readOnly ? null : series.value.split(/[\s,;]+/).filter(Boolean),
    };
    salvandoCliente = true;
    button.disabled = true;
    modal.setAttribute("aria-busy", "true");
    status.setAttribute("role", "status");
    status.textContent = "Salvando os dados do cliente…";
    try {
      const result = await context.apiFetch<ConfigCliente>("/api/config/cliente", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        errorMessage: "Não foi possível salvar os dados do cliente.",
      });
      aplicarConfiguracaoCliente(result);
      salvandoCliente = false;
      app.fecharModalAcessivel("modal-cliente-config");
      app.showToast("Dados do cliente salvos.", "success");
      carregarConfiguracaoTransferencia();
    } catch (error) {
      status.setAttribute("role", "alert");
      status.textContent = mensagemErro(error, "Não foi possível salvar os dados do cliente.");
    } finally {
      salvandoCliente = false;
      button.disabled = false;
      modal.removeAttribute("aria-busy");
    }
  }

  // The 22 defaults come only from the backend (`padroes` of GET /api/config/representantes-regionais); the edits
  // saved on this computer (config/representantes_regionais.json) are merged over them per city.
  // Until the first load succeeds the list is empty: the selectors hold only the empty option and the fills asked
  // for meanwhile (pendentes, by form type) are replayed when the defaults arrive (also after the single retry).
  const CAMPOS_REPRESENTANTE_EDITAVEIS: (keyof AlteracaoRepresentante)[] = ["nome", "email", "telefone", "horario", "almoco", "pausaDuracao"];
  const ALMOCO_NAO_FECHA = "Escritório não fecha";
  const ID_MODAL_REPRESENTANTE = "modal-representante-regional";
  const ATRASO_NOVA_TENTATIVA_REPRESENTANTES_MS = 2000;
  let padroesRepresentantes: RepresentanteRegional[] = [];
  let alteracoesRepresentantes: Record<string, AlteracaoRepresentante> = {};
  const pendentes: Partial<Record<TipoFormulario, { cidade: string; forcar: boolean }>> = {};
  let cidadeEdicaoRepresentante = "";
  let salvandoRepresentante = false;
  let avisouPadroesInvalidos = false;

  function representantesRegionais(): RepresentanteRegional[] {
    return padroesRepresentantes.map((padrao) => {
      const alteracao = alteracoesRepresentantes[padrao.cidade];
      if (!alteracao) return padrao;
      const mesclado = { ...padrao };
      CAMPOS_REPRESENTANTE_EDITAVEIS.forEach((campo) => {
        if (typeof alteracao[campo] === "string") mesclado[campo] = alteracao[campo];
      });
      return mesclado;
    });
  }

  function atualizarBotaoEditarRepresentante(tipo: TipoFormulario) {
    const botao = document.getElementById(`btn-editar-representante-${tipo}`) as HTMLButtonElement | null;
    const seletor = document.getElementById(CAMPOS_CONTATO_REGIONAL[tipo].selectId) as HTMLSelectElement | null;
    if (botao) botao.disabled = !seletor?.value;
  }

  // Rebuilds both selectors keeping each chosen city; re-fills only the forms showing the edited city.
  // Fields the user typed by hand are kept (a warning toast names them); the others follow the representative.
  function aplicarAlteracoesRepresentantes(resultado: ResultadoRepresentantes, cidadeEditada = "") {
    const alteracoes = resultado?.alteracoes;
    alteracoesRepresentantes = alteracoes && typeof alteracoes === "object" ? alteracoes : {};
    const escolhidas = (Object.keys(CAMPOS_CONTATO_REGIONAL) as TipoFormulario[])
      .map((tipo) => ({ tipo, selectId: CAMPOS_CONTATO_REGIONAL[tipo].selectId,
        cidade: (document.getElementById(CAMPOS_CONTATO_REGIONAL[tipo].selectId) as HTMLSelectElement | null)?.value || "" }));
    popularSeletoresRepresentantesRegionais();
    escolhidas.forEach(({ tipo, selectId, cidade }) => {
      const seletor = document.getElementById(selectId) as HTMLSelectElement | null;
      if (seletor) seletor.value = cidade;
      if (cidadeEditada && cidade === cidadeEditada) {
        const mantidos: string[] = [];
        preencherRepresentanteRegional(tipo, cidade, true, mantidos);
        avisarCamposMantidos(cidade, tipo, mantidos);
      } else atualizarBotaoEditarRepresentante(tipo);
    });
  }

  // refazerFormularios: o assistente mudou o arquivo por fora; refaz os campos só das cidades que mudaram.
  // Devolve true se a resposta foi aplicada; falha só avisa no console (o aviso ao usuário fica em carregarRepresentantesRegionais).
  async function buscarRepresentantesRegionais(refazerFormularios: boolean): Promise<boolean> {
    try {
      const resultado = await context.apiFetch<ResultadoRepresentantes>("/api/config/representantes-regionais", {
        cache: "no-store", errorMessage: "Falha ao carregar os representantes regionais.",
      });
      const antes = alteracoesRepresentantes;
      const primeiraCarga = !padroesRepresentantes.length;
      if (Array.isArray(resultado?.padroes) && resultado.padroes.length) {
        padroesRepresentantes = resultado.padroes.map((padrao) => Object.freeze({ ...padrao }));
      } else if (primeiraCarga) throw new Error("A resposta não trouxe os padrões dos representantes regionais.");
      aplicarAlteracoesRepresentantes(resultado);
      if (resultado?.padroes_arquivo_invalido === true && !avisouPadroesInvalidos) {
        avisouPadroesInvalidos = true;
        app.showToast("O arquivo local de padrões dos representantes está inválido: nomes, e-mails e telefones ficaram em branco e não é possível salvar edições até corrigi-lo.", "warning");
      }
      if (primeiraCarga) {
        (Object.keys(pendentes) as TipoFormulario[]).forEach((tipo) => {
          const pendente = pendentes[tipo];
          if (pendente) preencherRepresentanteRegional(tipo, pendente.cidade, pendente.forcar);
        });
      } else if (refazerFormularios === true) {
        Object.keys({ ...antes, ...alteracoesRepresentantes })
          .filter((cidade) => JSON.stringify(antes[cidade]) !== JSON.stringify(alteracoesRepresentantes[cidade]))
          .forEach((cidade) => aplicarAlteracoesRepresentantes(resultado, cidade));
      }
      return true;
    } catch (error) {
      console.warn("Não foi possível carregar os representantes regionais:", error);
      return false;
    }
  }

  // Sem padrões a tela fica sem cidades: se a primeira busca falhar, tenta mais uma vez e só então avisa.
  // Enquanto a lista está vazia e há uma carga em andamento (inclusive esperando a nova tentativa), reaproveita essa carga.
  let cargaRepresentantes: Promise<void> | null = null;
  function carregarRepresentantesRegionais(refazerFormularios = false): Promise<void> {
    if (cargaRepresentantes && !padroesRepresentantes.length) return cargaRepresentantes;
    const carga = (async () => {
      let carregou = await buscarRepresentantesRegionais(refazerFormularios);
      if (!carregou && !padroesRepresentantes.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, ATRASO_NOVA_TENTATIVA_REPRESENTANTES_MS));
        carregou = await buscarRepresentantesRegionais(refazerFormularios);
      }
      if (!carregou && !padroesRepresentantes.length) app.showToast("Não foi possível carregar os representantes regionais. Recarregue a página.", "warning");
    })().finally(() => { if (cargaRepresentantes === carga) cargaRepresentantes = null; });
    cargaRepresentantes = carga;
    return carga;
  }

  // The API reports validation errors as "Value error, <message>"; show only the message.
  function mensagemErroRepresentante(error: unknown, fallback: string) {
    return mensagemErro(error, fallback).replace(/(^|; )Value error, /g, "$1");
  }

  const horaCompleta = (valor: string) => (/^\d{2}:\d{2}$/.test(valor) ? `${valor}:00` : valor);
  const campoRepresentante = <T extends HTMLElement = HTMLInputElement>(sufixo: string): T => elemento<T>(`representante-regional-${sufixo}`);

  function alternarAlmocoRepresentanteRegional() {
    const naoFecha = campoRepresentante<HTMLInputElement>("almoco-nao-fecha").checked;
    const almoco = campoRepresentante("almoco");
    almoco.disabled = naoFecha;
    if (naoFecha) almoco.value = "";
    campoRepresentante("pausa-obrigatorio")?.classList.toggle("hidden", naoFecha);
  }

  function atualizarBotoesRepresentante(ocupado: boolean) {
    elemento<HTMLButtonElement>("btn-salvar-representante-regional").disabled = ocupado;
    elemento<HTMLButtonElement>("btn-cancelar-representante-regional").disabled = ocupado;
    elemento<HTMLButtonElement>("btn-restaurar-representante-regional").disabled = ocupado || !alteracoesRepresentantes[cidadeEdicaoRepresentante];
  }

  function abrirEdicaoRepresentanteRegional(tipo: TipoFormulario) {
    if (salvandoRepresentante) return;
    const representante = obterRepresentanteRegional(elemento<HTMLSelectElement>(CAMPOS_CONTATO_REGIONAL[tipo].selectId).value);
    if (!representante) return;
    cidadeEdicaoRepresentante = representante.cidade;
    const [inicio = "", fim = ""] = (representante.horario || "").split(" às ");
    const naoFecha = representante.almoco === ALMOCO_NAO_FECHA;
    campoRepresentante("cidade").textContent = representante.cidade;
    campoRepresentante("nome").value = representante.nome || "";
    campoRepresentante("email").value = representante.email || "";
    campoRepresentante("telefone").value = formatarTelefoneBrasileiro(representante.telefone || "");
    campoRepresentante("inicio").value = inicio;
    campoRepresentante("fim").value = fim;
    campoRepresentante<HTMLInputElement>("almoco-nao-fecha").checked = naoFecha;
    campoRepresentante("almoco").value = naoFecha ? "" : (representante.almoco || "");
    campoRepresentante("pausa").value = representante.pausaDuracao || "";
    alternarAlmocoRepresentanteRegional();
    const status = elemento<HTMLDivElement>("status-representante-regional");
    status.setAttribute("role", "status");
    status.textContent = "";
    atualizarBotoesRepresentante(false);
    app.abrirModalAcessivel(ID_MODAL_REPRESENTANTE, "#representante-regional-nome", "fecharEdicaoRepresentanteRegional");
  }

  function fecharEdicaoRepresentanteRegional() {
    if (!salvandoRepresentante) app.fecharModalAcessivel(ID_MODAL_REPRESENTANTE);
  }

  async function enviarRepresentanteRegional(metodo: "PUT" | "DELETE", corpo: Record<string, string> | null, textoStatus: string, fallback: string, toast: string) {
    const modal = elemento<HTMLDivElement>(ID_MODAL_REPRESENTANTE);
    const status = elemento<HTMLDivElement>("status-representante-regional");
    salvandoRepresentante = true;
    atualizarBotoesRepresentante(true);
    modal.setAttribute("aria-busy", "true");
    status.setAttribute("role", "status");
    status.textContent = textoStatus;
    try {
      const result = await context.apiFetch<ResultadoRepresentantes>(`/api/config/representantes-regionais/${encodeURIComponent(cidadeEdicaoRepresentante)}`, {
        method: metodo,
        ...(corpo ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) } : {}),
        errorMessage: fallback,
      });
      aplicarAlteracoesRepresentantes(result, cidadeEdicaoRepresentante);
      salvandoRepresentante = false;
      app.fecharModalAcessivel(ID_MODAL_REPRESENTANTE);
      app.showToast(toast, "success");
    } catch (error) {
      status.setAttribute("role", "alert");
      status.textContent = mensagemErroRepresentante(error, fallback);
    } finally {
      salvandoRepresentante = false;
      atualizarBotoesRepresentante(false);
      modal.removeAttribute("aria-busy");
    }
  }

  // Builds the PUT body from the dialog; the expediente is "HH:MM:SS às HH:MM:SS".
  type ResultadoLeituraRepresentante =
    | { erro: [string, string]; corpo?: never }
    | { corpo: Record<string, string>; erro?: never };
  function lerRepresentanteRegional(): ResultadoLeituraRepresentante {
    const valor = (sufixo: string) => campoRepresentante(sufixo).value.trim();
    const naoFecha = campoRepresentante<HTMLInputElement>("almoco-nao-fecha").checked;
    const [inicio, fim] = [horaCompleta(valor("inicio")), horaCompleta(valor("fim"))];
    const erro: [string, string] | null = (!inicio || !fim) ? ["inicio", "Preencha o início e o fim do expediente."]
      : (!naoFecha && !valor("almoco")) ? ["almoco", 'Preencha o horário do almoço ou marque "Escritório não fecha".']
        : (!naoFecha && !valor("pausa")) ? ["pausa", "Preencha a pausa, por exemplo 1h30."] : null;
    if (erro) return { erro };
    return {
      corpo: {
        nome: valor("nome"), email: valor("email"), telefone: valor("telefone"),
        horario: `${inicio} às ${fim}`, almoco: naoFecha ? ALMOCO_NAO_FECHA : horaCompleta(valor("almoco")), pausaDuracao: valor("pausa"),
      },
    };
  }

  async function salvarRepresentanteRegional() {
    if (salvandoRepresentante) return;
    const { corpo, erro } = lerRepresentanteRegional();
    if (erro) {
      const status = elemento<HTMLDivElement>("status-representante-regional");
      status.setAttribute("role", "alert");
      status.textContent = erro[1];
      campoRepresentante(erro[0]).focus();
      return;
    }
    await enviarRepresentanteRegional("PUT", corpo, "Salvando o representante…", "Não foi possível salvar o representante.", "Representante salvo.");
  }

  async function restaurarRepresentanteRegional() {
    if (salvandoRepresentante || !alteracoesRepresentantes[cidadeEdicaoRepresentante]) return;
    const confirmado = await app.confirmarAcao({
      titulo: "Restaurar padrão?",
      mensagem: `Descartar a edição salva de ${cidadeEdicaoRepresentante} e voltar ao representante padrão?`,
      confirmar: "Restaurar padrão",
      destrutiva: false,
    });
    if (confirmado && !salvandoRepresentante) await enviarRepresentanteRegional("DELETE", null, "Restaurando o padrão…", "Não foi possível restaurar o padrão.", "Padrão restaurado.");
  }

  function normalizarCidadeRegional(cidade: unknown) {
    return String(cidade || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLocaleLowerCase("pt-BR")
      .replace(/\s+/g, " ");
  }

  function entregaAlmocoNaoFecha() {
    const almoco = document.getElementById("entrega-almoco") as HTMLInputElement | null;
    return normalizarCidadeRegional(almoco?.value) === normalizarCidadeRegional("Escritório não fecha");
  }

  function atualizarObrigatoriedadeDuracaoPausaEntrega() {
    const pausaDuracao = document.getElementById("entrega-pausa-duracao") as HTMLInputElement | null;
    if (!pausaDuracao) return;

    const obrigatorio = !entregaAlmocoNaoFecha();
    pausaDuracao.required = obrigatorio;
    pausaDuracao.setAttribute("aria-required", String(obrigatorio));
    document.getElementById("entrega-pausa-obrigatorio")?.classList.toggle("hidden", !obrigatorio);
  }

  function obterRepresentanteRegional(cidade: string | null | undefined): RepresentanteRegional | null {
    const cidadeNormalizada = normalizarCidadeRegional(cidade);
    if (!cidadeNormalizada) return null;

    return representantesRegionais().find((representante) => {
      const nomeCidade = normalizarCidadeRegional(representante.cidade);
      return cidadeNormalizada === nomeCidade
        || cidadeNormalizada.startsWith(`${nomeCidade} `)
        || cidadeNormalizada.startsWith(`${nomeCidade}/`)
        || cidadeNormalizada.startsWith(`${nomeCidade}-`);
    }) || null;
  }

  function popularSeletoresRepresentantesRegionais() {
    Object.values(CAMPOS_CONTATO_REGIONAL).forEach(({ selectId }) => {
      const select = document.getElementById(selectId) as HTMLSelectElement | null;
      if (!select) return;

      const opcaoVazia = document.createElement("option");
      opcaoVazia.value = "";
      opcaoVazia.textContent = "-- Sem representante correspondente --";
      select.replaceChildren(opcaoVazia);

      representantesRegionais().forEach((representante) => {
        const opcao = document.createElement("option");
        opcao.value = representante.cidade;
        const nomeExibicao = representante.nome || representante.nomeOpcao || "Representante não informado";
        opcao.textContent = `${nomeExibicao} — ${representante.cidade}`;
        select.appendChild(opcao);
      });
    });
  }

  function avisarCamposMantidos(cidade: string, tipo: TipoFormulario, rotulos: string[]) {
    if (!rotulos.length) return;
    const lista = rotulos.length > 1 ? `${rotulos.slice(0, -1).join(", ")} e ${rotulos.at(-1)}` : rotulos[0];
    const lugar = `${cidade} (${tipo === "retirada" ? "Retirada" : "Entrega"})`;
    app.showToast(rotulos.length > 1
      ? `Os campos ${lista} de ${lugar} foram mantidos porque foram editados à mão.`
      : `O campo ${lista} de ${lugar} foi mantido porque foi editado à mão.`, "warning");
  }

  // Returns true when a hand-edited value was kept although the representative's value for the field changed.
  // "Edited by hand" = non-empty value that is neither what the screen last filled from the representative
  // (dataset.representanteAutoValue) nor the form default. Only checked when preservarEditados is set.
  function atualizarCampoContatoRegional(campo: HTMLInputElement, valorNovo: string, valorPadrao: string, forcar: boolean, limparQuandoVazio = false, preservarEditados = false): boolean {
    const valorAtual = campo.value.trim();
    const valorAutoAnterior = campo.dataset.representanteAutoValue || "";
    if (preservarEditados && valorAtual && valorAtual !== valorAutoAnterior && valorAtual !== valorPadrao) {
      const mudou = (valorNovo || "") !== valorAutoAnterior && (valorNovo || (limparQuandoVazio ? "" : valorPadrao)) !== valorAtual;
      campo.dataset.representanteAutoValue = valorNovo || "";
      return mudou;
    }
    const podeAtualizar = forcar
      || !valorAtual
      || valorAtual === valorAutoAnterior
      || (valorPadrao && valorAtual === valorPadrao);

    if (!podeAtualizar) return false;
    campo.value = valorNovo || (limparQuandoVazio ? "" : valorPadrao);
    campo.dataset.representanteAutoValue = valorNovo || "";
    return false;
  }

  // Fields filled from a representative, in order. Contact fields are forced whenever a representative matches
  // and clear only for a named one; schedule fields are forced only by their own value and clear for any match.
  type ChaveRepresentante = "nome" | "email" | "telefone" | "horario" | "almoco" | "pausaDuracao";
  type CampoContatoPreenchido = "contato" | "email" | "telefone" | "horario" | "almoco" | "pausaDuracao";
  interface RegraCampoPreenchido {
    campo: CampoContatoPreenchido;
    chave: ChaveRepresentante;
    rotulo: string;
    forcarPorValor: boolean;
    limparSe: "nome" | "representante" | null;
  }
  const CAMPOS_PREENCHIDOS_POR_REPRESENTANTE: RegraCampoPreenchido[] = [
    { campo: "contato", chave: "nome", rotulo: "Nome", forcarPorValor: false, limparSe: null },
    { campo: "email", chave: "email", rotulo: "E-mail", forcarPorValor: false, limparSe: "nome" },
    { campo: "telefone", chave: "telefone", rotulo: "Celular", forcarPorValor: false, limparSe: "nome" },
    { campo: "horario", chave: "horario", rotulo: "Expediente", forcarPorValor: true, limparSe: "representante" },
    { campo: "almoco", chave: "almoco", rotulo: "Almoço", forcarPorValor: true, limparSe: "representante" },
    { campo: "pausaDuracao", chave: "pausaDuracao", rotulo: "Pausa", forcarPorValor: true, limparSe: "representante" },
  ];

  function valorDoRepresentante(representante: RepresentanteRegional | null, chave: ChaveRepresentante): string {
    if (chave === "telefone") {
      return representante?.telefone ? formatarTelefoneBrasileiro(representante.telefone) : "";
    }
    return representante?.[chave] || "";
  }

  function deveLimparCampoRegional(representante: RepresentanteRegional | null, regra: RegraCampoPreenchido, valor: string): boolean {
    const elegivel = regra.limparSe === "nome" ? Boolean(representante?.nome)
      : regra.limparSe === "representante" ? Boolean(representante)
        : false;
    return elegivel && Object.prototype.hasOwnProperty.call(representante, regra.chave) && !valor;
  }

  // mantidos (array opcional): preserva o que o usuário digitou à mão e acrescenta ali o rótulo de cada campo mantido.
  function preencherRepresentanteRegional(tipo: TipoFormulario, cidade: string, forcar = false, mantidos: string[] | null = null): RepresentanteRegional | null {
    const campos = CAMPOS_CONTATO_REGIONAL[tipo];
    if (!campos) return null;

    if (!padroesRepresentantes.length) {
      if (cidade) pendentes[tipo] = { cidade, forcar }; else delete pendentes[tipo];
    }
    const representante = obterRepresentanteRegional(cidade);
    const seletor = document.getElementById(campos.selectId) as HTMLSelectElement | null;
    if (seletor) seletor.value = representante?.cidade || "";
    CAMPOS_PREENCHIDOS_POR_REPRESENTANTE.forEach((regra) => {
      const campo = document.getElementById(campos[`${regra.campo}Id`]) as HTMLInputElement | null;
      if (!campo) return;
      const valor = valorDoRepresentante(representante, regra.chave);
      const manteve = atualizarCampoContatoRegional(
        campo,
        valor,
        campos[`${regra.campo}Padrao`],
        forcar && Boolean(regra.forcarPorValor ? valor : representante),
        deveLimparCampoRegional(representante, regra, valor),
        Array.isArray(mantidos)
      );
      if (manteve && mantidos) mantidos.push(regra.rotulo);
    });
    if (tipo === "entrega") atualizarObrigatoriedadeDuracaoPausaEntrega();
    atualizarBotaoEditarRepresentante(tipo);
    return representante;
  }

  function handleRepresentanteRegionalChange(tipo: TipoFormulario, cidade: string) {
    const representante = obterRepresentanteRegional(cidade);
    preencherRepresentanteRegional(tipo, representante?.cidade || "", Boolean(representante));
  }

  function aplicarMascaraTelefone(input: HTMLInputElement) {
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
    ["retirada-telefone", "entrega-telefone", "representante-regional-telefone"].forEach((id) => {
      const input = document.getElementById(id) as HTMLInputElement | null;
      if (!input) return;
      input.value = formatarTelefoneBrasileiro(input.value);
      input.addEventListener("input", () => aplicarMascaraTelefone(input));
      input.addEventListener("change", () => aplicarMascaraTelefone(input));
      input.addEventListener("blur", () => aplicarMascaraTelefone(input));
    });
  }

  return {
    formatarTelefoneBrasileiro, carregarConfiguracaoTransferencia, entregaAlmocoNaoFecha,
    abrirConfiguracaoContatoOrigem, fecharConfiguracaoContatoOrigem, salvarConfiguracaoContatoOrigem,
    obterDadosCliente, abrirConfiguracaoCliente, fecharConfiguracaoCliente, salvarConfiguracaoCliente,
    abrirImportacaoModeloTransferencia,
    atualizarObrigatoriedadeDuracaoPausaEntrega, popularSeletoresRepresentantesRegionais,
    preencherRepresentanteRegional, handleRepresentanteRegionalChange, inicializarMascarasTelefone,
    carregarRepresentantesRegionais, abrirEdicaoRepresentanteRegional, fecharEdicaoRepresentanteRegional,
    salvarRepresentanteRegional, restaurarRepresentanteRegional, alternarAlmocoRepresentanteRegional,
  };
}
