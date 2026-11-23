import type { EstadoApp } from "../../estado-app";
import type { Unidade } from "../unidades/estado";
import type { ApiFetchOptions } from "../../api";
import { criarEtapasTransporte } from "./etapas.ts";

type TipoDadoLocal = "cep" | "faturamento" | "instalacao";
type TipoDadoEntrega = "faturamento" | "instalacao";
interface DadoParaCopiar { valor: unknown; nome: string; vazio?: string }
interface EquipamentoTransporte extends Record<string, unknown> {
  serial?: string;
  apelido?: string;
  modelo?: string;
  tipo?: string;
  usuarios_logados?: string;
  nome_pessoa?: string;
  idCliente?: string;
  retirada_cep?: string;
}
interface UnidadeTransporte extends Unidade {
  endereco_completo?: string;
}
interface Movimentacao {
  id: string;
  rev: number;
  chave: string;
  serie: string;
  destino_cidade: string;
}
interface EstadoTransferencia extends Omit<EstadoApp, "currentEquipamento" | "unidadesList"> {
  currentEquipamento: EquipamentoTransporte | null;
  unidadesList: UnidadeTransporte[];
  movimentacaoPendente?: Movimentacao | null;
}
interface ElementoTransferencia extends HTMLElement {
  value: string;
  disabled: boolean;
  checked: boolean;
  select(): void;
  selectedOptions?: HTMLCollectionOf<HTMLOptionElement>;
  checkValidity(): boolean;
}
interface RastreadorRascunho {
  capture(id: string, valor: string): void;
  update(id: string, valor: string): void;
  isDirty(): boolean;
  reset(): void;
}
interface UtilitariosTransferencia {
  serialForTransfer(equipamento: unknown, campo: string): string;
}
interface DadosFormularioTransferencia {
  serial: string;
  descricao_equipamento: string;
  razao_social: string;
  contrato: string;
  retirada_cidade: string;
  retirada_cnpj: string;
  retirada_endereco: string;
  retirada_horario: string;
  retirada_almoco: string;
  retirada_pausa_duracao: string;
  retirada_tipo_acesso: string;
  retirada_acesso_obs: string;
  retirada_contato: string;
  retirada_email: string;
  retirada_telefone: string;
  retirada_obs: string;
  retirada_voltagem: string;
  entrega_cidade: string;
  entrega_cnpj: string;
  entrega_endereco: string;
  entrega_horario: string;
  entrega_almoco: string;
  entrega_pausa_duracao: string;
  entrega_tipo_acesso: string;
  entrega_acesso_obs: string;
  entrega_contato: string;
  entrega_email: string;
  entrega_telefone: string;
  entrega_obs: string;
  entrega_voltagem: string;
}
interface OpcoesPrepararTransporte {
  serial?: unknown;
  cidade?: unknown;
  obs?: unknown;
  movimentacao?: Movimentacao | null;
}
interface AppTransferencia {
  obterDadosCliente?(): { contrato: string; cnpj_faturamento: string };
  fecharPainelCockpit?(animar?: boolean): void;
  preencherRepresentanteRegional(tipo: "retirada" | "entrega", cidade: string): unknown;
  showToast(mensagem: string, tipo: string): void;
  selecionarItemAutocomplete(item: { serial: string }): Promise<unknown>;
  copiarTextoParaAreaTransferencia(texto: string): Promise<void>;
  formatarTelefoneBrasileiro(valor: unknown): string;
  abrirModalAcessivel(id: string, foco: string, fechar: string): void;
  fecharModalAcessivel(id: string): void;
  atualizarObrigatoriedadeDuracaoPausaEntrega(): void;
  entregaAlmocoNaoFecha(): boolean;
  confirmarAcao(opcoes: { titulo: string; mensagem: string; confirmar: string; cancelar: string }): Promise<boolean>;
  invalidarBuscasEquipamento(): void;
  limparSelecaoEquipamento(): void;
}
export interface ContextoTransferencia {
  app: AppTransferencia;
  appState: EstadoTransferencia;
  motion: { reveal(elemento: HTMLElement, efeito: string): void } | null;
  transferUtils: UtilitariosTransferencia;
  apiFetch(url: string, options: ApiFetchOptions & { responseType: "response" }): Promise<Response>;
  draftTracker: RastreadorRascunho;
}

const elemento = <T extends HTMLElement = ElementoTransferencia>(id: string): T => document.getElementById(id) as T;

/** Comportamento da Home e do formulário estático de Transporte. */
export function criarFormularioTransferencia(context: ContextoTransferencia) {
  "use strict";
  const { app, appState, motion, transferUtils } = context;

  // Contract and billing CNPJ come from the installation (GET /api/config/transferencia, kept by regional-contacts);
  // blank until configured, and the server refuses a blank contract.
  function dadosCliente() {
    return app.obterDadosCliente?.() || { contrato: "", cnpj_faturamento: "" };
  }
  const AVISO_CNPJ_FATURAMENTO_VAZIO = "Configure os dados do cliente antes de copiar o CNPJ de faturamento.";
  const transferDraftTracker = context.draftTracker;
  // Novo layout (etapas, checklist, iniciais): só apresentação, lê os mesmos dados do formulário.
  // Fica aqui em cima porque a pré-visualização roda já na criação do formulário.
  const etapas = criarEtapasTransporte({
    serial: () => String(appState.currentEquipamento?.serial || "").trim().toUpperCase(),
    modelo: () => String(appState.currentEquipamento?.modelo || "").trim(),
    apelido: () => String(appState.currentEquipamento?.apelido || "").trim(),
    cidadeRetirada: () => String(appState.retiradaCidadeSelecionada || "").trim(),
    cidadeEntrega: () => String(elemento("entrega-local-nome")?.textContent || "").trim(),
    // Antes de o painel de contatos montar, a ponte síncrona registra erro no console: até lá o contrato conta como faltando.
    contrato: () => (window.SimpressReact?.["contatos-regionais"] ? String(dadosCliente().contrato || "").trim() : ""),
  });

  function atualizarResumoSerieTransferencia(equipment: EquipamentoTransporte | null | undefined): void {
    const banner = elemento("transfer-equipment-banner");
    const serialValue = elemento("transfer-serial");
    const description = elemento("transfer-equipment-description");
    const serial = String(equipment?.serial || "").trim().toUpperCase();
    const selected = Boolean(serial);

    const apelido = selected ? String(equipment?.apelido || "").trim() : "";
    const alias = elemento("transfer-alias");
    const logged = String(equipment?.usuarios_logados || "").trim();
    const nome = String(equipment?.nome_pessoa || "").trim();

    if (serialValue) serialValue.textContent = serial;
    if (alias) {
      alias.textContent = apelido;
      alias.hidden = !apelido;
    }
    const retiradaSerie = elemento("ck-passo-retirada-serie");
    if (retiradaSerie) retiradaSerie.textContent = serial;
    if (banner) {
      banner.dataset.state = selected ? "selected" : "empty";
      banner.dataset.estado = selected ? "pronto" : "vazio";
    }
    if (description) {
      description.textContent = selected
        ? [equipment?.modelo, equipment?.tipo, logged ? `Usuários logados: ${logged}` : "", nome ? `Nome: ${nome}` : ""].filter(Boolean).join(" · ") || "Equipamento pesquisado e selecionado."
        : "Nenhum equipamento selecionado.";
    }
    emitirEventoInterface("simpress:transporte-equipamento", { serial });
    etapas.aoMudarEquipamento(serial);
  }

  // "Trocar equipamento": volta à Home com o campo de busca em foco, sem descartar a transferência.
  function trocarEquipamentoTransporte() {
    ativarAbaTransferencia("home");
    const input = elemento("input-serial");
    input?.focus();
    input?.select?.();
  }

  function campoRastreavelTransferencia(alvo: EventTarget | null): ElementoTransferencia | null {
    const target = alvo as ElementoTransferencia | null;
    if (!target || target.id === "input-serial" || !target.matches?.("input, select, textarea")) return null;
    const panel = elemento("tab-panel-retirada-entrega");
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

  // Abas de primeiro nível: Home, Transporte e Automação (nessa ordem na barra lateral).
  const ABAS_PRINCIPAIS = Object.freeze({
    home: Object.freeze({ tab: "tab-home", painel: "tab-panel-home", titulo: "Home" }),
    transferencia: Object.freeze({ tab: "tab-retirada-entrega", painel: "tab-panel-retirada-entrega", titulo: "Transporte" }),
    automacao: Object.freeze({ tab: "tab-automacao", painel: "tab-panel-automacao", titulo: "Automação" }),
  });
  type AbaPrincipal = keyof typeof ABAS_PRINCIPAIS;

  function ativarAbaTransferencia(aba: string): void {
    app.fecharPainelCockpit?.(false);
    const alvo: AbaPrincipal = Object.hasOwn(ABAS_PRINCIPAIS, aba) ? aba as AbaPrincipal : "transferencia";
    const abas = (Object.entries(ABAS_PRINCIPAIS) as [AbaPrincipal, typeof ABAS_PRINCIPAIS[AbaPrincipal]][]).map(([nome, ids]) => ({
      nome,
      tab: elemento(ids.tab),
      painel: elemento(ids.painel),
    }));
    const home = abas.find(item => item.nome === "home")!;
    const transferencia = abas.find(item => item.nome === "transferencia")!;
    if (!home.tab || !transferencia.tab || !home.painel || !transferencia.painel) return;

    const destino = abas.find(item => item.nome === alvo)!;
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
    const titulo = elemento("header-page-title");
    if (titulo) titulo.textContent = ABAS_PRINCIPAIS[alvo].titulo;
    document.body.classList.toggle("has-quick-actions", alvo === "transferencia");
    if (alvo === "transferencia") atualizarResumoSerieTransferencia(appState.currentEquipamento);
    if (mudou && destino.painel) motion?.reveal(destino.painel, "page");
  }

  function abrirAbaTransporteDoEquipamento() {
    const painelTransporte = elemento("tab-panel-retirada-entrega");
    if (!painelTransporte) return;

    ativarAbaTransferencia("transferencia");
    painelTransporte.focus();
  }

  function abrirHomeParaPesquisarEquipamento() {
    if (String(appState.currentEquipamento?.serial || "").trim()) return;

    ativarAbaTransferencia("home");
    elemento("input-serial")?.focus();
  }

  function controlarAbasTransferencia(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    const tablist = target.closest('[role="tablist"]') || event.currentTarget as HTMLElement;
    const tabs = Array.from(tablist.querySelectorAll<HTMLElement>('[role="tab"]:not([hidden])'));
    const currentIndex = tabs.indexOf(target.closest('[role="tab"]') as HTMLElement);
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
    // O Resumo abre um painel que leva o foco ao título; as setas continuam percorrendo a barra de abas.
    if (nextTab.dataset.cockpitTool) nextTab.focus();
  }

  // "Forçar SEDE Prado Velho" button action
  function forcarSedePradoVelho() {
    const sede = appState.unidadesList.find(unit => unit.is_sede);
    appState.retiradaCidadeSelecionada = "Curitiba";
    elemento("retirada-cnpj").value = sede?.cnpj || "";
    elemento("retirada-endereco").value = "R Caeté, 150 - SEDE - Prado Velho - Curitiba/PR - CEP 80220-300";
    app.preencherRepresentanteRegional("retirada", "Curitiba");
    app.showToast("Origem alterada para SEDE Prado Velho (Curitiba).", "info");
  }

  // Handle Unidade de Destino Selection
  function atualizarEstadoCopiaCnpjEntrega(): void {
    const unidadeId = elemento("select-unidade-destino")?.value;
    const unidadeDestino = appState.unidadesList.find(unit => String(unit.id) === String(unidadeId));
    const botao = elemento("btn-copiar-cnpj-instalacao-entrega");
    if (botao) botao.disabled = !String(unidadeDestino?.cnpj || "").trim();
  }

  function atualizarChipsUnidade(): void {
    const selecionada = String(elemento("select-unidade-destino")?.value || "");
    document.querySelectorAll<HTMLElement>("#entrega-unidades .ck-unidade").forEach(chip => {
      chip.setAttribute("aria-pressed", String(Boolean(selecionada) && chip.dataset.unidadeId === selecionada));
    });
  }

  function handleUnidadeDestinoChange(unitId: string | number | null | undefined, notificar = true): void {
    atualizarEstadoCopiaCnpjEntrega();
    atualizarChipsUnidade();
    if (!unitId) {
      app.preencherRepresentanteRegional("entrega", "");
      atualizarPreviaTransporteCockpit?.();
      return;
    }
    const unit = appState.unidadesList.find(u => String(u.id) === String(unitId));
    if (unit) {
      elemento("entrega-cnpj").value = unit.cnpj || "";
      elemento("entrega-endereco").value = unit.endereco_completo || "";
      app.preencherRepresentanteRegional("entrega", unit.cidade || "");
      if (notificar) app.showToast(`Destino definido: ${unit.cidade}`, "info");
    }
    atualizarPreviaTransporteCockpit?.();
  }

  function selecionarUnidadePorCidade(cidadeNome: string): void {
    // Cidade inteira, sem acento e sem caixa: "Campo" não escolhe "Campo Grande".
    const alvo = dobrarCidadeTransporte(cidadeNome);
    const unit = alvo ? appState.unidadesList.find(u => dobrarCidadeTransporte(u.cidade) === alvo) : null;
    if (unit) {
      elemento("select-unidade-destino").value = String(unit.id ?? "");
      handleUnidadeDestinoChange(unit.id ?? "");
    }
  }

  function adicionarObsChamado(texto: string): void {
    const textarea = elemento("entrega-obs");
    if (textarea.value.trim().length > 0) {
      textarea.value += " " + texto;
    } else {
      textarea.value = texto;
    }
    // Preenchimento por código não dispara "input": atualiza a prévia e a lista de pendências.
    atualizarPreviaTransporteCockpit();
  }

  // Cobertura: só preenche o Transporte; quem gera a planilha é sempre o operador (nunca clica em Transporte, o antigo Gerar planilha).
  async function prepararTransporte({ serial, cidade, obs, movimentacao }: OpcoesPrepararTransporte = {}): Promise<void> {
    const serie = String(serial || "").trim();
    if (serie && chaveSerieTransporte(appState.currentEquipamento?.serial) !== chaveSerieTransporte(serie)) {
      await app.selecionarItemAutocomplete({ serial: serie });
    }
    abrirAbaTransporteDoEquipamento();
    if (cidade) selecionarUnidadePorCidade(String(cidade));
    if (obs) adicionarObsChamado(String(obs));
    appState.movimentacaoPendente = movimentacao ? {
      id: movimentacao.id,
      rev: movimentacao.rev,
      chave: movimentacao.chave,
      serie: movimentacao.serie,
      destino_cidade: movimentacao.destino_cidade,
    } : null;
  }

  // Mesmas regras de chave_serie e dobrar em domains/coverage.py.
  function chaveSerieTransporte(valor: unknown): string {
    return String(valor || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  function dobrarCidadeTransporte(valor: unknown): string {
    return String(valor || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  }

  // A planilha só fica ligada à movimentação se série e destino ainda forem os preparados pela Cobertura.
  function movimentacaoDaPlanilha(payload: DadosFormularioTransferencia): Movimentacao | null {
    const pendente = appState.movimentacaoPendente;
    appState.movimentacaoPendente = null;
    if (!pendente) return null;
    const bate = chaveSerieTransporte(payload?.serial) === chaveSerieTransporte(pendente.serie)
      && dobrarCidadeTransporte(payload?.entrega_cidade) === dobrarCidadeTransporte(pendente.destino_cidade);
    if (bate) return pendente;
    app.showToast("Os dados mudaram; a planilha não foi ligada à movimentação.", "warning");
    return null;
  }

  async function copiarModeloChamado(textareaId: string): Promise<void> {
    const textarea = elemento(textareaId);
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

  function alternarVisualizacaoModelo(botao: HTMLElement): void {
    const previewId = botao.getAttribute("aria-controls");
    if (!previewId) return;
    const preview = elemento(previewId);
    const label = botao.querySelector("span");
    if (!preview || !label) return;

    const mostrar = preview.hidden;
    preview.hidden = !mostrar;
    botao.setAttribute("aria-expanded", String(mostrar));
    label.textContent = mostrar ? "Ocultar Texto" : "Mostrar Texto";
  }

  function recolherVisualizacoesModelosChamado() {
    const pill = document.querySelector<HTMLElement>('.ck-modelo-aba[aria-selected="true"]');
    let selectedType = "";
    try {
      selectedType = JSON.parse(pill?.dataset?.args || "[]")[0] || "";
    } catch (error) {
      selectedType = "";
    }
    if (pill && selectedType) {
      alternarChamadosManuais(selectedType);
      return;
    }
    const conteudoChamados = elemento("ticket-templates-content");
    const botaoChamados = elemento("btn-toggle-ticket-templates");
    const rotuloBotaoChamados = botaoChamados?.querySelector("span");
    if (conteudoChamados) conteudoChamados.hidden = true;
    if (botaoChamados) botaoChamados.setAttribute("aria-expanded", "false");
    if (rotuloBotaoChamados) rotuloBotaoChamados.textContent = "Mostrar textos para chamados";

    document.querySelectorAll<HTMLElement>(".ticket-template-preview").forEach(preview => {
      preview.hidden = true;
    });
    document.querySelectorAll<HTMLElement>(".ticket-template-toggle").forEach(botao => {
      botao.setAttribute("aria-expanded", "false");
      const label = botao.querySelector("span");
      if (label) label.textContent = "Mostrar Texto";
    });
  }

  function alternarChamadosManuais(tipo: string): void {
    const pills = document.querySelectorAll<HTMLElement>(".ck-modelo-aba");
    if (pills.length) {
      const selected = tipo || "deslocamento";
      const content = elemento("ticket-templates-content");
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
        const dot = pill.querySelector<HTMLElement>(".ck-prontidao");
        const text = elemento(`texto-chamado-${pillType}`)?.value;
        if (dot?.dataset && typeof text === "string") dot.dataset.status = /\[[^\]]*\]|:[ ]*$/m.test(text) ? "alerta" : "ok";
      });
      document.querySelectorAll<HTMLElement>(".ck-chamado__painel").forEach(preview => {
        preview.hidden = preview.id !== `visualizacao-chamado-${selected}`;
      });
      elemento("btn-copiar-chamado-atual").dataset.args = JSON.stringify([`texto-chamado-${selected}`]);
      elemento("btn-toggle-ticket-templates")?.setAttribute("aria-expanded", "true");
      return;
    }
    const conteudo = elemento("ticket-templates-content");
    const botao = elemento("btn-toggle-ticket-templates");
    const rotulo = botao?.querySelector("span");
    if (!conteudo || !botao || !rotulo) return;

    const mostrar = conteudo.hidden;
    conteudo.hidden = !mostrar;
    botao.setAttribute("aria-expanded", String(mostrar));
    rotulo.textContent = mostrar ? "Ocultar textos para chamados" : "Mostrar textos para chamados";
  }

  // Build Payload Object from Form
  function construirPayload() {
    const serialInput = elemento("input-serial");
    const serialVal = transferUtils.serialForTransfer(appState.currentEquipamento, serialInput.value);
    if (!serialVal) {
      app.showToast("Pesquise e selecione o equipamento correto antes de gerar a transferência.", "warning");
      serialInput.focus();
      return null;
    }

    const entregaContato = elemento("entrega-contato").value.trim();
    if (!entregaContato) {
      app.showToast("Preencha o campo obrigatório “Nome do destinatário”.", "warning");
      etapas.abrirDoCampo("entrega-contato");
      elemento("entrega-contato").focus();
      return null;
    }

    const entregaCnpj = elemento("entrega-cnpj").value.trim();
    const entregaEndereco = elemento("entrega-endereco").value.trim();
    const unidadeDestino = appState.unidadesList.find(
      unit => String(unit.id) === String(elemento("select-unidade-destino").value)
    );
    if (!entregaCnpj || !entregaEndereco) {
      app.showToast("Selecione uma unidade de destino para preencher automaticamente o CNPJ e o endereço de entrega.", "warning");
      etapas.abrirDoCampo("select-unidade-destino");
      elemento("select-unidade-destino").focus();
      return null;
    }

    const retiradaTelefone = elemento("retirada-telefone");
    const entregaTelefone = elemento("entrega-telefone");
    retiradaTelefone.value = app.formatarTelefoneBrasileiro(retiradaTelefone.value);
    entregaTelefone.value = app.formatarTelefoneBrasileiro(entregaTelefone.value);

    return {
      serial: serialVal,
      descricao_equipamento: "",
      razao_social: "SERVICO DE APOIO AS MICRO E PEQUENAS EMPRESAS DO PARANA - SEBRAE/PR",
      contrato: dadosCliente().contrato,
      retirada_cidade: appState.retiradaCidadeSelecionada,
      retirada_cnpj: elemento("retirada-cnpj").value.trim(),
      retirada_endereco: elemento("retirada-endereco").value.trim(),
      retirada_horario: elemento("retirada-horario").value.trim(),
      retirada_almoco: elemento("retirada-almoco").value.trim(),
      retirada_pausa_duracao: elemento("retirada-pausa-duracao").value.trim(),
      retirada_tipo_acesso: elemento("retirada-tipo-acesso").value.trim(),
      retirada_acesso_obs: "",
      retirada_contato: elemento("retirada-contato").value.trim(),
      retirada_email: elemento("retirada-email").value.trim(),
      retirada_telefone: retiradaTelefone.value.trim(),
      retirada_obs: elemento("retirada-obs").value.trim(),
      retirada_voltagem: elemento("retirada-voltagem").value.trim(),
      entrega_cidade: unidadeDestino?.cidade || "",
      entrega_cnpj: entregaCnpj,
      entrega_endereco: entregaEndereco,
      entrega_horario: elemento("entrega-horario").value.trim(),
      entrega_almoco: elemento("entrega-almoco").value.trim(),
      entrega_pausa_duracao: elemento("entrega-pausa-duracao").value.trim(),
      entrega_tipo_acesso: "Elevador / Rampa / Térreo",
      entrega_acesso_obs: "",
      entrega_contato: entregaContato,
      entrega_email: elemento("entrega-email").value.trim(),
      entrega_telefone: entregaTelefone.value.trim(),
      entrega_obs: elemento("entrega-obs").value.trim(),
      entrega_voltagem: "Bivolt"
    };
  }

  // Format Structured Text for Helpdesk Ticket
  function gerarTextoResumo(payload: DadosFormularioTransferencia): string {
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
• Contrato: ${payload.contrato || "não configurado"} - Simpress / SEBRAE-PR
• Voltagem: Bivolt
• Tipo de Acesso: Elevador / Rampa / Térreo
======================================================================`;
  }

  function atualizarPreviaTransporteCockpit() {
    atualizarBotaoAlterarEndereco();
    const root = document.querySelector(".ck-transp");
    if (!root) return;
    const value = (id: string) => {
      const element = document.getElementById(id);
      const raw = element && "value" in element ? (element as ElementoTransferencia).value : element?.textContent;
      return String(raw || "").trim() || "—";
    };
    const set = (id: string, text: string) => {
      const target = elemento(id);
      if (target) target.textContent = text;
    };
    // Campo obrigatório vazio aparece como [Rótulo] destacado, em vez de sumir da prévia.
    const setParts = (id: string, parts: [string, string][]) => {
      const target = elemento(id);
      if (!target) return;
      const nodes: (string | HTMLElement)[] = [];
      parts.forEach(([fieldId, label]) => {
        const text = value(fieldId);
        if (nodes.length) nodes.push(" · ");
        if (text !== "—") nodes.push(text);
        else {
          const missing = document.createElement("span");
          missing.className = "ck-previa__falta";
          missing.textContent = `[${label}]`;
          nodes.push(missing);
        }
      });
      target.replaceChildren(...nodes);
    };
    const equipamento = appState.currentEquipamento;
    const unidade = elemento("select-unidade-destino");
    const destino = unidade?.selectedOptions?.[0]?.textContent?.trim();
    const serial = equipamento?.serial || value("transfer-serial");
    const modelo = equipamento ? (equipamento.modelo || value("card-modelo")) : "—";
    const apelido = String(equipamento?.apelido || "").trim() || "—";
    const unidadeSelecionada = unidade?.value
      ? appState.unidadesList.find(unit => String(unit.id) === String(unidade.value))
      : null;
    const retiradaLocal = appState.retiradaCidadeSelecionada || "";
    const entregaLocal = unidadeSelecionada?.cidade || (unidade?.value ? destino : "") || "";
    set("retirada-local-nome", retiradaLocal);
    set("entrega-local-nome", entregaLocal);
    set("cockpit-preview-equipment", [serial, modelo].filter(item => item && item !== "—").join(" · ") || "—");
    set("cockpit-preview-alias", apelido);
    set("cockpit-preview-pickup", [retiradaLocal, value("retirada-endereco")].filter(item => item && item !== "—").join(" — ") || "—");
    set("cockpit-preview-pickup-cnpj", value("retirada-cnpj"));
    setParts("cockpit-preview-contact", [["retirada-contato", "Nome"], ["retirada-telefone", "Celular"]]);
    set("cockpit-preview-hours", [value("retirada-horario"), `almoço ${value("retirada-almoco")}`].filter(item => item !== "—").join(" · ") || "—");
    set("cockpit-preview-access", [value("retirada-tipo-acesso"), value("retirada-voltagem")].filter(item => item !== "—").join(" · ") || "—");
    set("cockpit-preview-delivery", [entregaLocal, value("entrega-endereco")].filter(item => item && item !== "—").join(" — ") || "—");
    set("cockpit-preview-cep", String(unidadeSelecionada?.cep || "").trim() || "—");
    set("cockpit-preview-delivery-cnpj", value("entrega-cnpj"));
    setParts("cockpit-preview-recipient", [["entrega-contato", "Destinatário"], ["entrega-telefone", "Celular"]]);
    setParts("cockpit-preview-delivery-hours", [["entrega-horario", "Expediente"], ["entrega-almoco", "Almoço"], ["entrega-pausa-duracao", "Pausa"]]);
    setParts("cockpit-preview-notes", [["entrega-obs", "Observações"]]);
    const required = typeof root.querySelectorAll === "function"
      ? [...root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input[required], textarea[required], select[required]")]
      : [];
    const filled = required.filter(field => String(field.value || "").trim()).length;
    const count = elemento("ck-previa-contagem");
    const countText = elemento("ck-previa-contagem-texto");
    if (countText) countText.textContent = `${filled}/${required.length} campos`;
    if (count) count.dataset.status = required.length && filled === required.length ? "ok" : "alerta";
    const state = elemento("cockpit-transport-preview-state");
    if (state) {
      state.textContent = equipamento ? (unidade?.value ? "Prévia atualizada" : "Selecione a entrega") : "Aguardando equipamento";
      state.dataset.state = equipamento ? (unidade?.value ? "ready" : "pending") : "empty";
      state.dataset.estado = equipamento && unidade?.value ? "pronto" : "vazio";
      state.dataset.status = equipamento ? (unidade?.value ? "ok" : "alerta") : "neutro";
    }
    etapas.sincronizar({ preenchidos: filled, total: required.length });
  }

  const transportPreviewRoot = document.querySelector<HTMLElement>(".ck-transp");
  if (transportPreviewRoot && !transportPreviewRoot.dataset.previewBound) {
    transportPreviewRoot.dataset.previewBound = "true";
    transportPreviewRoot.addEventListener("input", atualizarPreviaTransporteCockpit);
    transportPreviewRoot.addEventListener("change", atualizarPreviaTransporteCockpit);
    atualizarPreviaTransporteCockpit();
  }
  etapas.iniciar();

  // Modal Preview Handlers
  function abrirModalPreview() {
    const payload = construirPayload();
    if (!payload) return;

    const texto = gerarTextoResumo(payload);
    elemento("textarea-resumo-preview").value = texto;
    app.abrirModalAcessivel("modal-preview", "#textarea-resumo-preview", "fecharModalPreview");
  }

  function fecharModalPreview() {
    app.fecharModalAcessivel("modal-preview");
  }

  function copiarTextoDoModal() {
    const texto = elemento("textarea-resumo-preview").value;
    navigator.clipboard.writeText(texto).then(() => {
      app.showToast("Resumo copiado para a área de transferência.", "success");
    }).catch(err => {
      app.showToast("Erro ao copiar texto: " + err, "error");
    });
  }

  function cidadeComUf(cidade: string | undefined): string {
    const valor = String(cidade || "").trim();
    if (!valor) return "";
    if (/\/\s*PR$/i.test(valor)) return valor.replace(/\s*\/\s*PR$/i, "/PR");
    return `${valor}/PR`;
  }

  // Single source of the transport request text: the F2 button and the Registro of "Gerar ticket no UX" (ux-ticket.js).
  interface TextoGerado { texto?: string; aviso?: string }
  function montarTextoSolicitacaoTransporte(): TextoGerado {
    const retiradaEndereco = elemento("retirada-endereco").value.trim();
    const entregaEndereco = elemento("entrega-endereco").value.trim();
    const unidadeDestino = appState.unidadesList.find(
      unit => String(unit.id) === String(elemento("select-unidade-destino").value)
    );
    const retiradaCidade = cidadeComUf(appState.retiradaCidadeSelecionada);
    const entregaCidade = cidadeComUf(unidadeDestino?.cidade);

    if (!retiradaEndereco || !entregaEndereco) {
      return { aviso: "Selecione o equipamento de origem e a unidade de destino para carregar os endereços." };
    }
    if (!retiradaCidade || !entregaCidade) {
      return { aviso: "Não foi possível identificar as cidades de origem e destino." };
    }

    return { texto: `Prezados,\n\nSolicito o transporte do equipamento da unidade do Sebrae de ${retiradaCidade} para a unidade do Sebrae de ${entregaCidade}\n\nO transporte dos equipamentos é previsto em edital e de responsabilidade da Simpress.\n\nEndereço para Retirada: ${retiradaEndereco}\nEndereço para Entrega: ${entregaEndereco}` };
  }

  // Registro of the "Alterar Endereço" button (workbook + Atualização Cadastral); short form, Retirada city to Entrega city.
  // Also gates the "Transporte" button (#btn-alterar-endereco): série and both addresses, no workbook.
  function montarTextoAlterarEndereco(): TextoGerado {
    const retiradaEndereco = elemento("retirada-endereco").value.trim();
    const entregaEndereco = elemento("entrega-endereco").value.trim();
    if (!retiradaEndereco || !entregaEndereco) {
      return { aviso: "Selecione o equipamento de origem e a unidade de destino para carregar os endereços." };
    }
    const unidadeDestino = appState.unidadesList.find(
      unit => String(unit.id) === String(elemento("select-unidade-destino").value)
    );
    const retiradaCidade = cidadeComUf(appState.retiradaCidadeSelecionada);
    const entregaCidade = cidadeComUf(unidadeDestino?.cidade);
    if (!retiradaCidade || !entregaCidade) {
      return { aviso: "Não foi possível identificar as cidades de origem e destino." };
    }
    return { texto: `Prezados,\n\nSolicito alteração do endereço do equipamento da Unidade de ${retiradaCidade} para ${entregaCidade}.` };
  }

  function serialAlterarEndereco() {
    return transferUtils.serialForTransfer(appState.currentEquipamento, elemento("input-serial")?.value || "");
  }

  function atualizarBotaoAlterarEndereco() {
    const botao = elemento("btn-alterar-endereco");
    if (botao) botao.disabled = !serialAlterarEndereco() || !montarTextoAlterarEndereco().texto;
  }

  function gerarTextoSolicitacaoTransporte() {
    const { texto, aviso } = montarTextoSolicitacaoTransporte();
    if (!texto) {
      app.showToast(aviso || "Não foi possível gerar o texto da solicitação.", "warning");
      return;
    }
    elemento("textarea-texto-transporte").value = texto;
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
    const endereco = elemento("retirada-endereco")?.value || "";
    const cepNoEndereco = endereco.match(/\bCEP\b\s*:?\s*(\d{5}-?\d{3})/i);
    return cepNoEndereco?.[1] || appState.currentEquipamento?.retirada_cep || "";
  }

  async function copiarDadoLocalAtual(tipo: TipoDadoLocal): Promise<void> {
    const dados: Record<TipoDadoLocal, DadoParaCopiar> = {
      cep: { valor: obterCepRetiradaSelecionada(), nome: "CEP" },
      faturamento: { valor: dadosCliente().cnpj_faturamento, nome: "CNPJ de faturamento", vazio: AVISO_CNPJ_FATURAMENTO_VAZIO },
      instalacao: {
        valor: elemento("retirada-cnpj")?.value || "",
        nome: "CNPJ de instalação"
      }
    };
    const dado = dados[tipo];
    if (!dado) return;

    const valor = String(dado.valor || "").trim();
    if (!valor) {
      app.showToast(dado.vazio || `Pesquise um equipamento com ${dado.nome.toLowerCase()} informado antes de copiar.`, "warning");
      return;
    }

    try {
      await app.copiarTextoParaAreaTransferencia(valor);
      app.showToast(`${dado.nome} copiado para a área de transferência.`, "success");
    } catch (err) {
      app.showToast(`Não foi possível copiar o ${dado.nome.toLowerCase()}.`, "error");
    }
  }

  async function copiarDadoEntrega(tipo: TipoDadoEntrega): Promise<void> {
    const unidadeId = elemento("select-unidade-destino")?.value;
    const unidadeDestino = appState.unidadesList.find(unit => String(unit.id) === String(unidadeId));
    const dados: Record<TipoDadoEntrega, DadoParaCopiar> = {
      faturamento: { valor: dadosCliente().cnpj_faturamento, nome: "CNPJ de faturamento", vazio: AVISO_CNPJ_FATURAMENTO_VAZIO },
      instalacao: { valor: unidadeDestino?.cnpj || "", nome: "CNPJ de instalação" }
    };
    const dado = dados[tipo];
    if (!dado) return;

    const valor = String(dado.valor || "").trim();
    if (!valor) {
      app.showToast(dado.vazio || "Selecione uma unidade de destino antes de copiar o CNPJ de instalação.", "warning");
      return;
    }

    try {
      await app.copiarTextoParaAreaTransferencia(valor);
      const unidade = tipo === "instalacao"
        ? ` de ${unidadeDestino?.cidade || "unidade selecionada"}`
        : " da entrega";
      app.showToast(`${dado.nome}${unidade} copiado para a área de transferência.`, "success");
    } catch (err) {
      app.showToast(`Não foi possível copiar o ${dado.nome.toLowerCase()} da entrega.`, "error");
    }
  }

  async function copiarTextoSolicitacaoTransporte() {
    const texto = elemento("textarea-texto-transporte").value;
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

    const campoVazio = campos.find(({ id }) => !elemento(id).value.trim());
    if (campoVazio) {
      const input = elemento(campoVazio.id);
      app.showToast(`Preencha o campo obrigatório “${campoVazio.nome}” para gerar a planilha oficial.`, "warning");
      etapas.abrirDoCampo(campoVazio.id);
      input.focus();
      input.scrollIntoView({ behavior: "smooth", block: "center" });
      return false;
    }

    for (const id of ["retirada-email", "entrega-email"]) {
      const email = elemento(id);
      if (email.checkValidity()) {
        email.removeAttribute("aria-invalid");
        continue;
      }
      email.setAttribute("aria-invalid", "true");
      app.showToast("Corrija o formato do endereço de e-mail antes de gerar a planilha.", "warning");
      etapas.abrirDoCampo(id);
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

    const btn = elemento("btn-gerar-planilha");
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i><span>Gerando Planilha...</span>`;
    lucide.createIcons({ root: btn });

    try {
      const res = await context.apiFetch("/api/gerar-planilha", {
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
      const filenameCity = (value: unknown) => String(value || "CidadeNaoInformada")
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
      const movimentacao = movimentacaoDaPlanilha(payload);
      emitirEventoInterface("simpress:transfer-generated", movimentacao ? { payload, movimentacao } : { payload });
      etapas.marcarGerado();

    } catch (err) {
      console.error("Erro ao gerar planilha:", err);
      app.showToast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
      btn.innerHTML = originalText;
      lucide.createIcons({ root: btn });
    }
  }

  async function resetarFormulario() {
    const query = elemento("input-serial").value.trim();
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
    elemento("input-serial").value = "";
    elemento("btn-clear-serial").classList.add("hidden");
    elemento("card-equipamento").classList.add("hidden");

    // Reset Retirada
    elemento("retirada-cnpj").value = "";
    elemento("retirada-endereco").value = "";
    elemento("retirada-obs").value = "";

    // Reset Entrega
    elemento("select-unidade-destino").value = "";
    elemento("entrega-cnpj").value = "";
    elemento("entrega-endereco").value = "";
    elemento("entrega-representante").value = "";
    elemento("entrega-contato").value = "";
    elemento("entrega-email").value = "";
    elemento("entrega-telefone").value = "";
    elemento("entrega-obs").value = "";
    atualizarEstadoCopiaCnpjEntrega();
    app.preencherRepresentanteRegional("entrega", "");
    app.preencherRepresentanteRegional("retirada", "");
    atualizarChipsUnidade();
    atualizarPreviaTransporteCockpit();

    // Reset status indicator
    elemento("status-indicator").dataset.state = "ready";
    elemento("status-summary").innerHTML = `
        <span class="ck-acoes-pronto" data-ux-ready-status>Pronto para emissão.</span>
      `;

    app.showToast("Formulário limpo. Pronto para uma nova busca.", "info");
    ativarAbaTransferencia("home");
    elemento("input-serial").focus();
    emitirEventoInterface("simpress:form-reset");
    etapas.reiniciar();
  }

  // Optional hook for progressive enhancements; never affects the main flow.
  function emitirEventoInterface(tipo: string, detalhe: Record<string, unknown> = {}): void {
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
    atualizarEstadoCopiaCnpjEntrega, atualizarChipsUnidade, trocarEquipamentoTransporte, handleUnidadeDestinoChange, selecionarUnidadePorCidade, adicionarObsChamado,
    copiarModeloChamado, alternarVisualizacaoModelo, recolherVisualizacoesModelosChamado, alternarChamadosManuais,
    abrirModalPreview, fecharModalPreview, copiarTextoDoModal, montarTextoSolicitacaoTransporte, gerarTextoSolicitacaoTransporte,
    montarTextoAlterarEndereco, serialAlterarEndereco, atualizarBotaoAlterarEndereco,
    atualizarPreviaTransporteCockpit,
    fecharModalTextoTransporte, copiarSerieAtual, copiarDadoLocalAtual, copiarDadoEntrega,
    copiarTextoSolicitacaoTransporte, validarCamposObrigatoriosPlanilha, gerarPlanilhaExcel, resetarFormulario,
    prepararTransporte,
  };
}
