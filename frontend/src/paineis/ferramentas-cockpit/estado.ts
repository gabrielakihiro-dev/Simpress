import { chamadoDaOs, osDoChamado } from "../paineis-dados/chamados-os.ts";
import { paineisDados } from "../paineis-dados/paineis.ts";
import { blocoCarregarMais, cabecalhoBloco, campoHistorico, gradeCampos, seloContagem } from "../historico-apelidos/elementos-historico.ts";
import { chaveFiltroHistorico, fatiaHistorico, TAMANHO_PAGINA_HISTORICO } from "../historico-apelidos/paginacao-historico.ts";
import { montarMovimento } from "../relatorio-mensal/grafico-semanal.ts";
import { anunciarComparacoes, rotuloOpcaoComparacao, rotuloStatusComparacao } from "../resultado-comparacao/rotulos-comparacao.ts";
import { capitalizar, mesPorExtenso, nomeDoMes } from "../relatorio-mensal/mes-extenso.ts";
import type { ContextoFerramentasCockpit, ElementoCockpit, Funcao, Qualquer, Registro } from "./tipos";

// Ferramentas do Cockpit (OS, Resumo, Histórico de apelidos, Relatório mensal, Planilhas e janela Chamado × OS):
// porta fiel de frontend/src/aplicacao/cockpit-tool-panels.ts (BF4). Os dados do servidor são lidos por nome, como no
// código antigo, e ficam como Registro. Só sintaxe apagável (sem enum/namespace): os testes carregam este .ts direto
// no Node. O estado (painel ativo, filtros, pedidos em andamento) vive só dentro da fábrica.
export function criarFerramentasCockpit(context: ContextoFerramentasCockpit) {
  const { app, apiFetch } = context;
  const toolKeys: Record<string, string> = { "sebrae-chamados": "F5", chamados: "F6", comparacao: "F3", apelidos: "F7", relatorio: "F8", cobertura: "F10" };
  const toolInfo: Record<string, string[]> = {
    chamados: ["OS", "Acompanhamento local de ordens relacionadas por série."],
    comparacao: ["Resumo", "Ativos por regional (com filtro por categoria) e resultados salvos da comparação entre as bases locais."],
    apelidos: ["Histórico de apelidos", "Alterações registradas para equipamentos e usuários."],
    relatorio: ["Relatório mensal", "Consolidação do mês usando os dados locais disponíveis."],
    cobertura: ["Cobertura", "Necessidades de equipamento, reservas, transporte e devoluções por cidade."],
    lembretes: ["Lembretes", "Anote o que precisa fazer; os termos de entrega e devolução ficam nas outras abas."],
    planilhas: ["Atualizar planilhas", "Última atualização das bases locais de equipamentos."],
    unidades: ["Catálogo de unidades", "Unidades Sebrae cadastradas para entrega e retirada."],
    // Sem loader em openPanel: recarregar a lista zeraria as edições dos chamados antigos (sebrae-dashboard.js).
    "sebrae-chamados": ["Chamados", "Preencha os chamados novos e antigos, exporte as linhas e atualize o Dashboard."],
  };
  const relationLabels: Record<string, string> = {
    conferida: "Conferida", divergente: "Divergente", somente_simpress: "Só Simpress",
    somente_oracle: "Só Oracle",
  };
  const relationTones: Record<string, string> = { conferida: "success", divergente: "error", somente_simpress: "warning", somente_oracle: "warning" };
  let eventsBound = false;
  let activeTool = "";
  let previousTool = "";
  let goingBack = false;
  let sheetsRequest = 0;
  let sheetsRows: Registro[] = [];
  let selectedSheetKey = "";
  let returnTarget: ElementoCockpit | null = null;
  let ticketData: Registro | null = null;
  let ticketTriage = "";
  // Sub-abas da F6 (OS por situação): a tabela é uma só; a sub-aba é só mais um filtro (tabela-os.ts, filtrarTabelaOs({ situacao })).
  const OS_ABAS = ["abertas", "finalizadas"];
  const OS_ABA_ROTULOS: Record<string, string> = { abertas: "Abertas", finalizadas: "Finalizadas" };
  let ticketSituacao = "abertas";
  let ticketAbasN: Record<string, number> = { abertas: 0, finalizadas: 0 };
  // KPIs e triagem contam só a sub-aba Abertas e não mudam ao trocar de sub-aba: tabela-os.ts avisa (aoContarSituacao) as OS abertas
  // e, dos chamados do relatório, só as séries com pelo menos uma OS aberta.
  let ticketAbertas: { os: number; chamados: Registro[] } = { os: 0, chamados: [] };
  let comparisonEvents: Registro[] = [];
  let selectedComparisonId = "";
  let selectedComparison: Registro | null = null;
  let aliasEvents: Registro[] = [];
  let selectedAliasId = "";
  let selectedAliasPeriod: string | undefined = "todos";
  let aliasLatest = new Map<string, Registro>();
  const aliasEquipmentCache = new Map<string, Qualquer>();
  let aliasEquipmentRequest = 0;
  let aliasPaginas = 1;
  let aliasChaveFiltro = "";
  let monthlyRequest = 0;
  let comparisonRequest = 0;
  let comparisonDetailRequest = 0;
  let aliasRequest = 0;
  let skipLinkHref: string | null = null;
  let pendingComparisonTarget: Registro | null = null;
  let pendingFreshComparison: Registro | null = null;
  // Carregar uma vez: os painéis só ficam ocultos ao trocar de aba, então voltar ao Resumo (F3) ou ao Relatório (F8)
  // reaproveita o que já está na tela; recarrega só se algo mudou (inventário, histórico, OS) desde a última carga.
  let resumoCarregado = false;
  let resumoDesatualizado = false;
  let relatorioMesCarregado = "";
  let relatorioDesatualizado = false;
  let painelChave: string | null = null;
  const HIGHLIGHT_MS = 1500;

  function normalize(value: Qualquer) {
    return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").trim();
  }

  function filterTicketRecords(records: Qualquer, query: Qualquer, relationFilter = "todos") {
    const terms = normalize(query).split(/\s+/).filter(Boolean);
    return (Array.isArray(records) ? records : []).filter(record => {
      if (relationFilter !== "todos" && record?.relacao !== relationFilter) return false;
      const searchable = normalize(JSON.stringify(record || {}));
      return terms.every(term => searchable.includes(term));
    });
  }

  function countValue(value: Qualquer) { return Number.isFinite(value) ? value : null; }

  function comparisonMetrics(event: Qualquer) {
    const comparison = event?.comparacao || {};
    const userChanges = comparison.divergencias_usuario;
    return {
      simpress: countValue(comparison.total_detalhes),
      endpoint: countValue(comparison.total_endpoint),
      iguais: countValue(comparison.equipamentos_sincronizados),
      divergenciaLocal: Array.isArray(comparison.divergencias_local) ? uniqueComparisonCount(comparison.divergencias_local) : null,
      divergenciaUsuario: Array.isArray(userChanges) ? uniqueComparisonCount(userChanges) : countValue(userChanges),
      soSimpress: Array.isArray(comparison.ausentes_no_endpoint) ? uniqueComparisonCount(comparison.ausentes_no_endpoint) : null,
      soEndpoint: Array.isArray(comparison.ausentes_em_detalhes) ? uniqueComparisonCount(comparison.ausentes_em_detalhes) : null,
    };
  }

  function uniqueComparisonCount(rows: Qualquer) {
    const records = new Set();
    (Array.isArray(rows) ? rows : []).forEach(row => {
      const serial = normalize(row?.serie);
      records.add(serial || JSON.stringify(row));
    });
    return records.size;
  }

  function aliasMetrics(events: Qualquer, now = new Date()) {
    const month = now.getMonth();
    const year = now.getFullYear();
    const current = (Array.isArray(events) ? events : []).filter(event => {
      const timestamp = Date.parse(event?.horario || "");
      if (!Number.isFinite(timestamp)) return false;
      const date = new Date(timestamp);
      return date.getFullYear() === year && date.getMonth() === month;
    });
    return {
      changesThisMonth: current.length,
      equipmentAffected: new Set(current.map(event => String(event.serial || "").trim()).filter(Boolean)).size,
    };
  }

  function displayCount(value: Qualquer) { return Number.isFinite(value) ? new Intl.NumberFormat("pt-BR").format(value) : "—"; }

  // Prévia copiável (Copiar resumo): mesmos números da tela e da XLSX; sem linhas "indisponível" (decisão de 07/11/2026).
  // `sebrae`: resposta de GET /api/sebrae/novos (situação atual); null quando não carregou. A contagem do mês vem de report.sebrae.
  function monthlyPreviewText(report: Qualquer, sebrae: Qualquer = null) {
    const month = report?.mes?.label || report?.mes?.key || "mês selecionado";
    const inventory = report?.inventario || {};
    const comparison = report?.comparacao || {};
    const tickets = report?.os || {};
    const oracle = tickets.oracle || {};
    const simpress = tickets.simpress || {};
    const counts = comparison.contagens || {};
    const insufficient = Array.isArray(tickets.dados_insuficientes) ? tickets.dados_insuficientes.length : 0;
    const topUnits = Array.isArray(inventory.por_unidade) ? inventory.por_unidade.slice(0, 3) : [];
    const period = typeof report?.mes?.parcial === "boolean" ? ` · ${monthlyPeriodLabel(report)}` : "";
    const lines = [
      `Relatório mensal Simpress · ${month}${period}`,
      "",
      `OS Oracle abertas no mês: ${displayCount(oracle.abertas)}`,
      `OS Oracle concluídas no mês: ${displayCount(oracle.concluidas)}`,
      `OS Oracle pendentes no fim do período: ${displayCount(oracle.pendentes)}`,
      `Pedidos Simpress abertos no mês: ${displayCount(simpress.abertas)}`,
      `Pedidos Simpress entregues no mês: ${displayCount(simpress.concluidas)}`,
      `Pedidos Simpress em andamento no fim do período: ${displayCount(simpress.pendentes)}`,
      ...(insufficient ? [`Fora das contagens: ${insufficient} ${plural(insufficient, "registro", "registros")} com dados insuficientes`] : []),
      "",
      comparisonUsedText(comparison),
      `Sem correspondência — no endpoint: ${displayCount(counts["Sem correspondência — no endpoint"])}`,
      `Sem correspondência — na Simpress: ${displayCount(counts["Sem correspondência — na Simpress"])}`,
      `Localidade divergente: ${displayCount(counts["Localidade divergente"])}`,
    ];
    const ticketLines = [];
    if (sebrae && (sebrae.importado || sebrae.novos)) {
      const lists = sebraeOpenLists(sebrae);
      const novos = lists.novos.length;
      const antigos = lists.antigos.length;
      ticketLines.push(`Chamados (F5), situação atual: ${displayCount(novos)} ${plural(novos, "novo", "novos")} · ${displayCount(antigos)} ${plural(antigos, "antigo", "antigos")} em aberto`);
    }
    // Contagem do mês (report.sebrae); some com erro ou sem Dashboard importado.
    const monthTickets = sebraeMonthCounts(report);
    if (monthTickets) ticketLines.push(`Chamados (F5), com data em ${month}: Abertos no mês ${displayCount(monthTickets.abertos)} · Finalizados no mês ${displayCount(monthTickets.finalizados)} · Sem data de abertura ou de encerramento: ${displayCount(monthTickets.sem_data)} (fora da contagem)`);
    if (ticketLines.length) lines.push("", ...ticketLines);
    lines.push(
      "",
      `Base atual (não muda com o mês): ${displayCount(inventory.total)} equipamentos em ${displayCount(inventory.unidades)} unidades`,
      "Unidades com mais equipamentos (base atual):",
      ...(topUnits.length ? topUnits.map(([city, address, total]: Qualquer) => `- ${[city, address].filter(Boolean).join(" · ")}: ${displayCount(total)}`) : ["- Sem dados de unidade."]),
    );
    return lines.join("\n");
  }

  function byId(id: string) { return document.getElementById(id) as ElementoCockpit; }

  // Ícone do sprite (ck-ico--sm), decorativo; criado por DOM porque este módulo não monta HTML.
  function svgIcon(href: Qualquer) {
    const svgNs = "http://www.w3.org/2000/svg";
    const icon = document.createElementNS(svgNs, "svg");
    icon.setAttribute("class", "ck-ico ck-ico--sm");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("focusable", "false");
    icon.appendChild(document.createElementNS(svgNs, "use")).setAttribute("href", href);
    return icon;
  }

  function element(tag: string, className = "", text: Qualquer = "") {
    const node = document.createElement(tag) as ElementoCockpit;
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  const badgeStatus: Record<string, string> = { success: "ok", warning: "alerta", error: "erro" };

  function badge(text: Qualquer, tone = "neutral") {
    const node = element("span", "ck-badge", text);
    if (badgeStatus[tone]) node.dataset.status = badgeStatus[tone];
    return node;
  }

  function renderEmpty(target: Qualquer, message: Qualquer) {
    const node = element("p", "ck-lista__vazio", message);
    if (target.getAttribute("role") === "list") node.setAttribute("role", "listitem");
    target.replaceChildren(node);
  }

  function renderKpis(target: Qualquer, entries: Qualquer) {
    target.replaceChildren(...entries.map(([label, value, note]: Qualquer) => {
      const card = element("div", "ck-kpi");
      const shown = typeof value === "string" ? value : displayCount(value);
      card.append(element("span", "ck-kpi__rotulo", label), element("strong", "ck-kpi__valor", shown));
      if (note) card.append(element("small", "ck-kpi__sub", note));
      return card;
    }));
  }

  function renderDetails(target: Qualquer, entries: Qualquer) {
    const list = element("dl", "ck-det-campos");
    entries.filter(([, value]: Qualquer) => value !== null && value !== undefined && value !== "")
      .forEach(([label, value]: Qualquer) => list.append(element("dt", "", label), element("dd", "", value)));
    target.replaceChildren(list);
  }

  function renderError(target: Qualquer, error: Qualquer, fallback: Qualquer) {
    const message = error?.message || fallback;
    const node = element("p", "ck-nota ck-nota--erro", message);
    if (target.getAttribute("role") === "list") node.setAttribute("role", "listitem");
    target.replaceChildren(node);
  }

  // Object.hasOwn: uma relação como "constructor" não pode herdar entradas do protótipo.
  const ownEntry = (table: Qualquer, key: Qualquer) => (Object.hasOwn(table, key) ? table[key] : undefined);
  function relationText(record: Qualquer) { return ownEntry(relationLabels, record?.relacao) || String(record?.relacao || "Relação indisponível"); }

  function ticketOrders(record: Qualquer) {
    const oracle = (Array.isArray(record?.oracle) ? record.oracle : [])
      .map((item: Qualquer) => item?.ordem_servico || item?.solicitacao).filter(Boolean).map(String);
    const simpress = (Array.isArray(record?.simpress?.ordens_servico) ? record.simpress.ordens_servico : []).map(String);
    return { oracle, simpress };
  }

  // Campos do Andamento da série: fila, fase, endereço, atendimento, etapa e previsão do pedido.
  // Os helpers vêm de SimpressTicketRules (publicados em app); sem eles o campo simplesmente não aparece.
  function ticketExtraFields(record: Qualquer) {
    const rules = (name: Qualquer) => (typeof app?.[name] === "function" ? app[name] : null);
    const list = (values: Qualquer) => (Array.isArray(values) ? values : []).filter(Boolean).join(", ");
    const compare = rules("compararOrdensServicoDecrescente");
    const oracle = [...(Array.isArray(record.oracle) ? record.oracle : [])];
    if (compare) oracle.sort((left, right) => compare(left.ordem_servico, right.ordem_servico));
    const current = oracle[0] || {};
    const simpress = record.simpress || {};
    const address = [current.logradouro, current.numero_endereco, current.bairro, current.cidade]
      .map(value => String(value || "").trim()).filter(Boolean).join(", ");
    const providers = (rules("atendimentosDoChamado")?.(record) || []).filter((name: Qualquer) => name !== "Não informado");
    const stages = rules("etapasProcessoPedido")?.(simpress) || [];
    const formatDate = rules("formatarDataEtapa") || ((value: Qualquer) => value);
    const forecast = stages.find((stage: Qualquer) => stage.chave === "previsao_entrega" && stage.data);
    const lastStage = [...stages].reverse().find(stage => stage.chave !== "previsao_entrega" && stage.data);
    const format = context.historyFormat?.formatarHorarioHistorico;
    const age = oracle.length ? rules("idadeAtualizacaoChamado")?.(current)?.rotulo : "";
    const updated = current.ultima_atualizacao ? (format ? format(current.ultima_atualizacao) : current.ultima_atualizacao) : "";
    return [
      ["Solicitações Oracle", list(oracle.map(item => item.solicitacao))],
      ["Fila", current.fila], ["Fase", current.fase_atendimento],
      ["Atendimento", providers.join(", ")],
      ["Cidade", list(rules("cidadesDoChamado")?.(record))],
      ["Endereço Oracle", address],
      ["Pedido Simpress", list(simpress.pedidos)],
      ["Endereço de entrega", simpress.pedido_em_andamento ? list(simpress.enderecos_entrega) : ""],
      ["Etapa atual", lastStage ? `${lastStage.rotulo} · ${formatDate(lastStage.data)}` : ""],
      ["Previsão de entrega", forecast ? formatDate(forecast.data) : ""],
      ["Última atualização Oracle", [updated, age].filter(Boolean).join(" · ")],
      ["Chamado do cliente", list(rules("chamadosClienteInformados")?.(simpress.chamados_cliente))],
      ["Descrição do chamado", current.descricao ? (rules("resumirDescricaoChamado")?.(current.descricao) || String(current.descricao)) : ""],
    ];
  }

  // Conteúdo da linha "Andamento" de uma série (callback aoExpandirSerie da tabela de OS).
  // opcoes (janela Chamado × OS): { snapshotId, somenteLeitura } = relatório próprio e anotações só leitura.
  function renderTicketDetail(record: Qualquer, target: Qualquer, opcoes: Registro = {}) {
    if (!record) return renderEmpty(target, "Série não encontrada na importação atual.");
    const { oracle, simpress } = ticketOrders(record);
    const oracleRecords = Array.isArray(record.oracle) ? record.oracle : [];
    const simpressRecord = record.simpress || {};
    const attention = app.classificarAtencaoChamado?.(record);
    const relation = element("p", "ck-nota", "Relação: ");
    relation.append(badge(relationText(record), ownEntry(relationTones, record.relacao)));
    if (attention?.em_atencao) relation.append(" ", badge(attention.motivo || "Atenção", "warning"));
    const fields = element("div", "");
    renderDetails(fields, [
      ["Ordens no Oracle", oracle.length ? oracle.join(", ") : "Nenhuma ordem informada"],
      ["Ordens na Simpress", simpress.length ? simpress.join(", ") : "Nenhuma ordem informada"],
      ["Status Oracle", oracleRecords.map((item: Qualquer) => [item.status, item.sub_status].filter(Boolean).join(" · ")).filter(Boolean).join(" / ")],
      ["Status Simpress", (Array.isArray(simpressRecord.status) ? simpressRecord.status : []).filter(Boolean).join(" / ")],
      ...ticketExtraFields(record),
    ]);
    const note = element("p", "ck-nota", "Os dados vêm da importação mais recente. A próxima ação de cada versão pode ser registrada na linha do tempo.");
    const timeline = element("section", "ck-det-bloco");
    timeline.append(element("h3", "", "Andamento registrado"));
    const events = element("div", "");
    timeline.append(events);
    const dados = element("div", "ck-os-andamento__dados");
    dados.append(relation, fields, note);
    const tempo = element("div", "ck-os-andamento__tempo");
    tempo.append(timeline);
    const painel = element("div", "ck-os-andamento");
    painel.append(dados, tempo);
    target.replaceChildren(painel);
    loadTicketTimeline(record, events, opcoes);
  }

  function expandTicketSeries(serie: Qualquer, target: Qualquer) {
    const records = Array.isArray(ticketData?.chamados) ? ticketData.chamados : [];
    renderTicketDetail(records.find(record => String(record.serie || "") === serie), target);
  }

  function timelineValue(value: Qualquer) {
    return Array.isArray(value) ? value.filter(Boolean).join(", ") : String(value ?? "");
  }

  // PUT do autosave pelo apiFetch (evento simpress:servidor-offline). O autosave espera uma resposta com ok/status/json:
  // o erro HTTP volta nesse formato (409 não repete, 5xx repete) e a falha de rede passa intacta, sem status.
  async function enviarAnotacaoChamado({ eventId, itemId, annotation, revisionId, baseRevisions, resolveConflict }: Qualquer) {
    try {
      return await apiFetch<Response>(
        `/api/operacoes/chamados/linha-do-tempo/${encodeURIComponent(eventId)}/${encodeURIComponent(itemId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ anotacao: annotation, revisao_id: revisionId, base_revisoes: baseRevisions, resolver_conflito: resolveConflict }),
          responseType: "response",
        },
      );
    } catch (erro: Qualquer) {
      if (typeof erro?.status !== "number") throw erro;
      return { ok: false, status: erro.status, json: async () => erro.data };
    }
  }

  function renderTicketTimeline(target: Qualquer, events: Qualquer, somenteLeitura = false) {
    if (!events.length) return renderEmpty(target, "Não há versões anteriores para esta série.");
    const list = element("ol", "ck-tempo");
    events.forEach((event: Qualquer) => {
      const item = element("li", "ck-tempo__item");
      const body = element("div", "ck-tempo__corpo");
      item.append(element("span", "ck-tempo__marca"), body);
      body.append(element("strong", "ck-tempo__titulo", event.tipo || "Atualização"));
      body.append(element("time", "ck-tempo__meta", event.atualizado_em || "Data indisponível"));
      const changes = Array.isArray(event.mudancas) ? event.mudancas : [];
      if (changes.length) body.append(element("p", "ck-tempo__meta", changes.map((change: Qualquer) =>
        `${change.campo || "Campo"}: ${timelineValue(change.anterior) || "(vazio)"} → ${timelineValue(change.atual) || "(vazio)"}`,
      ).join(" · ")));
      body.append(ticketAnnotationField(event, somenteLeitura));
      list.append(item);
    });
    target.replaceChildren(list);
  }

  // Anotação por versão da linha do tempo (próxima ação ou o que já foi feito), salva sozinha com o limite de 2.000 caracteres.
  function ticketAnnotationField(event: Qualquer, somenteLeitura = false) {
    const field = element("label", "ck-chamados-anotacao");
    field.append(element("span", "ck-chamados-anotacao__rotulo", "Próxima ação ou o que já foi feito"));
    const textarea = element("textarea", "annotation-field");
    textarea.rows = 2;
    textarea.maxLength = 2000;
    textarea.value = event.anotacao || "";
    textarea.placeholder = "Ex.: cobrar atualização do parceiro, OS concluída...";
    textarea.dataset.annotationVersion = JSON.stringify({
      anotacao_revisoes: event.anotacao_revisoes || [],
      anotacao_conflito: Boolean(event.anotacao_conflito),
      anotacao_conflitos: event.anotacao_conflitos || [],
      anotacao_bases_ausentes: event.anotacao_bases_ausentes || [],
      anotacao_integridade_invalida: Boolean(event.anotacao_integridade_invalida),
    });
    const status = element("span", `annotation-status${event.anotacao ? " is-saved" : ""}`, event.anotacao ? "Anotação salva" : "");
    status.setAttribute("aria-live", "polite");
    const retry = element("button", "annotation-retry", "Tentar sincronizar novamente");
    retry.type = "button";
    retry.hidden = true;
    retry.setAttribute("aria-label", "Tentar novamente a sincronização desta anotação");
    field.append(textarea, status, retry);
    const autosave = globalThis.HistoryAnnotationAutosave;
    if (!somenteLeitura && autosave && event.snapshot_id && event.item_id) {
      autosave.attachAnnotationAutosave({
        textarea, status, retryButton: retry, eventId: event.snapshot_id, itemId: event.item_id,
        send: enviarAnotacaoChamado,
      });
    } else {
      textarea.readOnly = true;
    }
    return field;
  }

  async function loadTicketTimeline(record: Qualquer, target: Qualquer, opcoes: Registro = {}) {
    const serial = String(record.serie || "");
    const proprio = "snapshotId" in opcoes;
    const snapshotId = String((proprio ? opcoes.snapshotId : ticketData?.snapshot_id) || "");
    renderEmpty(target, "Carregando histórico da série…");
    if (!serial || !snapshotId) return renderEmpty(target, "O histórico desta série não está disponível nesta importação.");
    // Cada linha aberta tem o próprio destino; recolher/recriar a tabela o desconecta e descarta a resposta.
    const stale = () => !target.isConnected || (!proprio && activeTool !== "chamados");
    try {
      const params = new URLSearchParams({ snapshot_id: snapshotId });
      const data = await apiFetch(`/api/operacoes/chamados/linha-do-tempo/${encodeURIComponent(serial)}?${params}`, {
        errorMessage: "Não foi possível carregar o histórico desta série.",
      });
      if (!stale()) renderTicketTimeline(target, Array.isArray(data.eventos) ? data.eventos : [], opcoes.somenteLeitura);
    } catch (error: Qualquer) {
      if (!stale()) renderError(target, error, "Não foi possível carregar o histórico desta série.");
    }
  }

  // KPIs só da sub-aba Abertas: "OS abertas" e, das séries com pelo menos uma OS aberta, quantas estão em cada relação do relatório.
  function renderTicketKpis() {
    const { os, chamados } = ticketAbertas;
    const porRelacao = (relacao: Qualquer) => chamados.filter(record => record?.relacao === relacao).length;
    renderKpis(byId("cockpit-tickets-kpis"), [
      ["OS abertas", os], ["Séries", chamados.length], ["Conferidas", porRelacao("conferida")], ["Divergentes", porRelacao("divergente")],
      ["Só Simpress", porRelacao("somente_simpress")], ["Só Oracle", porRelacao("somente_oracle")],
    ]);
  }

  const ticketTriageGroups = [["ativos", "Ativos", ""], ["atrasados", "3+ dias", "alerta"], ["sem_data", "Sem data", "alerta"], ["em_dia", "Atualizados <3 dias", "ok"]];

  // ⓘ (.info-tip) com id fixo, porque o e2e e os docs o citam. `fim`: o balão abre para a esquerda (contêiner com overflow:hidden cortava o da direita).
  function infoTip(rotulo: Qualquer, texto: Qualquer, id: Qualquer, { fim = false } = {}) {
    const tip = element("span", fim ? "info-tip info-tip--end" : "info-tip");
    const trigger = element("button", "info-tip-trigger");
    trigger.type = "button";
    trigger.setAttribute("aria-label", `Sobre ${rotulo}`);
    trigger.setAttribute("aria-describedby", id);
    trigger.append(svgIcon("#i-info"));
    const text = element("span", "info-tip-text", texto);
    text.id = id;
    text.setAttribute("role", "tooltip");
    tip.append(trigger, text);
    return tip;
  }

  // Triagem pelo grupo da série (regra em ticket-rules): os números contam só as séries com OS na sub-aba Abertas, não o filtro atual nem a sub-aba visível.
  function renderTicketTriage() {
    const host = byId("cockpit-tickets-triage");
    if (!host) return;
    const records = ticketAbertas.chamados;
    const groupOf = app.grupoTriagemChamado;
    if (typeof groupOf !== "function" || !records.length) { host.hidden = true; return; }
    const counts: Record<string, number> = { ativos: 0, atrasados: 0, sem_data: 0, em_dia: 0 };
    records.forEach(record => {
      const group = groupOf(record);
      if (!group) return;
      counts.ativos += 1;
      counts[group] += 1;
    });
    const head = element("div", "ckp-triagem__cab");
    const title = element("h3", "ckp-triagem__titulo", "Triagem por atualização no Oracle");
    title.id = "cockpit-tickets-triage-title";
    const resumo = element("span", "ck-chamados-triagem__resumo",
      `${counts.ativos} de ${records.length} séries com chamado aberto no Oracle · ${records.length - counts.ativos} sem chamado aberto `);
    resumo.append(infoTip("a contagem", "KPIs e triagem contam só as OS da sub-aba Abertas.", "cockpit-tickets-kpis-nota", { fim: true }));
    head.append(title, resumo);
    const buttons = element("div", "ckp-triagem__nums");
    ticketTriageGroups.forEach(([key, label, status]) => {
      const button = element("button", "ckp-triagem__num ck-chamados-triagem__botao");
      button.type = "button";
      button.dataset.triagem = key;
      if (status) button.dataset.status = status;
      button.setAttribute("aria-pressed", String(ticketTriage === key));
      button.append(element("span", "ck-chamados-triagem__rotulo", label), element("span", "ck-chamados-triagem__valor", counts[key]));
      buttons.append(button);
    });
    host.replaceChildren(head, buttons);
    host.hidden = false;
  }

  // Busca, Relação, Atenção e Triagem só filtram as linhas já montadas pela tabela de OS (tabela-os.ts).
  function filterTicketTable() {
    const relation = byId("cockpit-tickets-relation").value;
    dataPanels()?.filtrarTabelaOs({
      busca: byId("cockpit-tickets-search").value, relacao: relation === "todos" ? "" : relation,
      triagem: ticketTriage, atencao: Boolean(byId("cockpit-tickets-attention")?.checked), situacao: ticketSituacao,
    });
  }

  // ARIA das sub-abas: selecionada, tabindex rolante e o painel único (#cockpit-tickets-os) rotulado pela aba ativa. Não mexe na tabela.
  function marcarAbaOs(situacao: Qualquer) {
    ticketSituacao = situacao;
    OS_ABAS.forEach(nome => {
      const aba = byId(`os-aba-${nome}`);
      if (!aba) return;
      aba.setAttribute("aria-selected", String(nome === situacao));
      aba.tabIndex = nome === situacao ? 0 : -1;
    });
    byId("cockpit-tickets-os")?.setAttribute("aria-labelledby", `os-aba-${situacao}`);
  }

  // Números das abas: linhas que passam nos filtros em cada sub-aba, sem o limite da página (aviso de tabela-os.ts).
  function renderAbasOs() {
    OS_ABAS.forEach(nome => {
      const n = ticketAbasN[nome];
      const aba = byId(`os-aba-${nome}`);
      const contagem = byId(`os-${nome}-contagem`);
      if (contagem) contagem.textContent = String(n);
      if (!aba) return;
      aba.setAttribute("aria-label", `${OS_ABA_ROTULOS[nome]}: ${n} OS`);
      if (n) aba.removeAttribute("data-zero");
      else aba.setAttribute("data-zero", "");
    });
  }

  /** Seleciona a sub-aba (clique, setas, Home, End); `focar` leva o foco ao botão da aba. */
  function selecionarAbaOs(situacao: Qualquer, { focar = false } = {}) {
    if (!OS_ABAS.includes(situacao)) return;
    marcarAbaOs(situacao);
    filterTicketTable();
    if (focar) byId(`os-aba-${situacao}`)?.focus();
  }

  function selectTicketTriage(event: Qualquer) {
    const button = event.target.closest?.("[data-triagem]");
    if (!button) return;
    ticketTriage = ticketTriage === button.dataset.triagem ? "" : button.dataset.triagem;
    renderTicketTriage();
    filterTicketTable();
    (byId("cockpit-tickets-triage").querySelector(`[data-triagem="${ticketTriage}"]`) as ElementoCockpit | null)?.focus();
  }

  // Busca: espera 150 ms sem digitar antes de filtrar (a contagem com aria-live não é anunciada a cada letra).
  let ticketSearchTimer: ReturnType<typeof setTimeout> | undefined;
  function filterTicketTableSoon() {
    clearTimeout(ticketSearchTimer);
    ticketSearchTimer = setTimeout(filterTicketTable, 150);
  }

  function clearTicketFilters() {
    clearTimeout(ticketSearchTimer);
    byId("cockpit-tickets-search").value = "";
    byId("cockpit-tickets-relation").value = "todos";
    byId("cockpit-tickets-attention").checked = false;
    ticketTriage = "";
    renderTicketTriage();
    filterTicketTable();
  }

  // O contexto só injeta painéis de dados nos testes; no app vale a instância de paineis-dados/paineis.ts.
  const dataPanels = () => context.dataPanels ?? paineisDados;

  // A tabela já busca /api/operacoes/chamados: reaproveita a resposta (KPIs e snapshot_id) em vez de pedir de novo.
  async function loadTickets() {
    const host = byId("cockpit-tickets-os");
    const panels = dataPanels();
    const mounted = host.querySelector(".ck-os");
    const section = mounted || panels?.montarTabelaOs(host, {
      titulo: "Ordens de serviço por série", semBusca: true,
      // Lista de identificação à esquerda (como o F5), a partir de 1200 px.
      lateral: true,
      aoExpandirSerie: expandTicketSeries,
      grupoSerie: app.grupoTriagemChamado,
      // O contador "N OS · N séries" da tabela fica na barra das sub-abas, à direita.
      statusEm: byId("cockpit-tickets-contagem"),
      aoCarregar: (report: Qualquer) => {
        ticketData = report;
        app.sincronizarGestaoChamadosCockpit?.(report);
      },
      // KPIs e triagem só da sub-aba Abertas: recontam a cada carga (inclui o recarregamento depois de Desfazer/Conferido).
      aoContarSituacao: (abertas: Qualquer) => {
        ticketAbertas = abertas;
        renderTicketKpis();
        renderTicketTriage();
      },
      aoContarAbas: (abas: Qualquer) => {
        ticketAbasN = abas;
        renderAbasOs();
      },
      aoMudarSituacao: marcarAbaOs,
      // Desfazer/Refazer/Conferido muda a OS de sub-aba e a linha some da vista: o foco volta para a aba ativa.
      aoFocarAba: () => byId(`os-aba-${ticketSituacao}`)?.focus(),
    });
    if (!section) return renderError(host, null, "A tabela de ordens de serviço não está disponível.");
    filterTicketTable();
    // Recém-montada já está carregando; só recarrega à força se já existia.
    if (mounted) await panels.atualizarTabelaOs(true);
  }

  function destacarLinhaCockpit(element: Qualquer) {
    if (!element?.isConnected) return;
    element.scrollIntoView({ block: "center", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    element.classList.add("ck-linha-destaque");
    setTimeout(() => element.classList.remove("ck-linha-destaque"), HIGHLIGHT_MS);
  }

  // Serial (+ optional category) target: navegarParaLinhaComparacao finds the row in the rendered result (S-prefix rule included).
  // The category (sem_acesso_7_dias, divergencias_local, sem_usuario...) picks the right section when the serial is in several.
  async function abrirComparacaoDaSerie(serial: Qualquer, categoria = "") {
    const value = String(serial || "").trim();
    const category = String(categoria || "").trim();
    pendingComparisonTarget = value ? (category ? { serial: value, category } : { serial: value }) : null;
    selectedComparisonId = "";
    // Sai de Backups: o resultado pedido aparece mesmo com o painel já aberto. Primeira abertura: openPanel volta à Visão Geral
    // (padrão desde 23/11/2026) e navegarParaLinhaComparacao abre a aba da linha depois do render.
    app.selecionarAbaResumo?.("divergencias");
    await openPanel("comparacao");
    pendingComparisonTarget = null;
  }

  // Shows a result in the Resumo panel (internal tool key "comparacao"). With evento_id that event is selected; a fresh result (no evento_id)
  // is rendered at once and then replaced by the newest saved event, since annotations need evento_id.
  async function mostrarResultadoNaAbaComparacao(comparison: Qualquer, navigationTarget = null) {
    const eventId = String(comparison?.evento_id || "");
    pendingComparisonTarget = navigationTarget;
    pendingFreshComparison = eventId ? null : comparison;
    selectedComparisonId = eventId;
    // Sai de Backups: o resultado pedido aparece mesmo com o painel já aberto. Resultado novo abre na Visão Geral (padrão, 23/11/2026);
    // com alvo de linha, a aba certa é escolhida por navegarParaLinhaComparacao.
    app.selecionarAbaResumo?.(navigationTarget ? "divergencias" : "visao-geral");
    await openPanel("comparacao");
    pendingComparisonTarget = null;
    pendingFreshComparison = null;
  }

  async function openSerialInHome(serial: Qualquer) {
    const input = byId("input-serial");
    if (!serial || !input) return;
    input.value = serial;
    closePanel(false);
    app.ativarAbaTransferencia("home");
    await app.buscarSerial();
  }

  function renderDetailsInto(target: Qualquer, entries: Qualquer) {
    const list = element("dl", "ck-det-campos");
    entries.filter(([, value]: Qualquer) => value !== null && value !== undefined && value !== "")
      .forEach(([label, value]: Qualquer) => list.append(element("dt", "", label), element("dd", "", value)));
    target.append(list);
  }

  function renderComparisonSelect() {
    const select = byId("cockpit-comparison-event");
    select.replaceChildren(...comparisonEvents.map(event => {
      const option = element("option", "", rotuloOpcaoComparacao(event));
      option.value = String(event.id || "");
      return option;
    }));
    select.value = selectedComparisonId;
    select.disabled = comparisonEvents.length === 0;
    anunciarComparacoes(comparisonEvents, selectedComparisonId);
  }

  function updateComparisonStatus() {
    const status = byId("cockpit-comparison-status");
    if (!selectedComparison) {
      status.textContent = `${comparisonEvents.length} ${comparisonEvents.length === 1 ? "registro" : "registros"} no histórico local`;
      return;
    }
    status.textContent = rotuloStatusComparacao(selectedComparison);
    anunciarComparacoes(comparisonEvents, selectedComparisonId);
  }

  function openNewComparison() {
    app.abrirModalAtualizarPlanilhas();
  }

  function comparisonFromEvent(event: Qualquer) {
    return {
      ...(event.comparacao || {}),
      evento_id: event.id,
      horario_comparacao: event.horario || event.comparacao?.horario_comparacao,
      historico_salvo: true,
      contexto_historico: true,
    };
  }

  // Aba que openPanel acabou de pedir (alerta, sino, série), repassada a limparAbasResumo enquanto o histórico carrega: sem piscar a Visão Geral.
  let abaPedidaAoAbrir = "";

  // Empties the result area while a result loads or is unavailable.
  function clearComparisonResult(message: Qualquer, estado = "vazio") {
    byId("comparacao-planilhas-fontes").textContent = "";
    app.limparAbasResumo?.(abaPedidaAoAbrir);
    // O contêiner do Resumo não é região viva (lia a tabela inteira): só a mensagem de carregando/vazio é anunciada.
    const aviso = element("p", "ck-lista__vazio", message);
    aviso.setAttribute("role", "status");
    byId("comparacao-planilhas-conteudo").replaceChildren(aviso);
    byId("comparacao-planilhas-conteudo").dataset.estado = estado;
  }

  // keepContent: a freshly generated result is already on screen; this load only swaps in the saved event (it has evento_id).
  async function loadComparisonDetail(eventId: Qualquer, { keepContent = false } = {}) {
    const request = ++comparisonDetailRequest;
    selectedComparison = null;
    if (!eventId) {
      updateComparisonStatus();
      if (keepContent) { resumoCarregado = true; return; }
      clearComparisonResult("Não há comparação de inventários disponível neste histórico.");
      // Without a saved comparison the "Sem usuário" section (current inventory) still shows below the empty message.
      const target = pendingComparisonTarget;
      pendingComparisonTarget = null;
      const semUsuario = await app.carregarSemUsuarioResumo?.();
      if (request !== comparisonDetailRequest || activeTool !== "comparacao") return;
      if (semUsuario) app.renderizarSemUsuarioSemComparacao(semUsuario, target);
      resumoCarregado = true;
      return;
    }
    if (!keepContent) clearComparisonResult("Carregando comparação…", "carregando");
    try {
      // "Sem usuário" comes from the current inventory (not from the saved event), read in parallel with the event.
      const semUsuarioLoad = app.carregarSemUsuarioResumo?.();
      const data = await apiFetch(`/api/historico-comparacoes/${encodeURIComponent(eventId)}`, { errorMessage: "Não foi possível abrir esta comparação." });
      const semUsuario = await semUsuarioLoad;
      if (request !== comparisonDetailRequest || activeTool !== "comparacao") return;
      selectedComparison = data.evento || null;
      if (!selectedComparison) return clearComparisonResult("Comparação não encontrada.");
      const target = pendingComparisonTarget;
      pendingComparisonTarget = null;
      app.renderizarResultadoComparacao(comparisonFromEvent(selectedComparison), target, semUsuario);
      updateComparisonStatus();
      resumoCarregado = true;
    } catch (error: Qualquer) {
      if (request !== comparisonDetailRequest || activeTool !== "comparacao") return;
      if (!keepContent) {
        app.limparAbasResumo?.(abaPedidaAoAbrir);
        renderError(byId("comparacao-planilhas-conteudo"), error, "Não foi possível abrir a comparação.");
        byId("comparacao-planilhas-conteudo").dataset.estado = "erro";
      }
      byId("cockpit-comparison-status").textContent = error.message || "Não foi possível abrir a comparação.";
    }
  }

  async function loadComparisons() {
    const request = ++comparisonRequest;
    const status = byId("cockpit-comparison-status");
    const fresh = pendingFreshComparison;
    pendingFreshComparison = null;
    resumoCarregado = false;
    resumoDesatualizado = false;
    status.textContent = "Carregando histórico local…";
    comparisonDetailRequest += 1;
    selectedComparison = null;
    byId("cockpit-comparison-event").disabled = true;
    if (fresh) app.renderizarResultadoComparacao(fresh, pendingComparisonTarget);
    else clearComparisonResult("Carregando histórico local…", "carregando");
    try {
      const data = await apiFetch("/api/historico-comparacoes", { errorMessage: "Não foi possível carregar o histórico de comparações." });
      if (request !== comparisonRequest || activeTool !== "comparacao") return;
      comparisonEvents = (Array.isArray(data.eventos) ? data.eventos : [])
        .filter((event: Qualquer) => event.id && event.tipo !== "restauracao" && !event.somente_anotacoes_sincronizadas);
      selectedComparisonId = comparisonEvents.some(event => String(event.id) === selectedComparisonId)
        ? selectedComparisonId : String(comparisonEvents[0]?.id || "");
      status.textContent = `${comparisonEvents.length} ${comparisonEvents.length === 1 ? "registro" : "registros"}`;
      renderComparisonSelect();
      await loadComparisonDetail(selectedComparisonId, { keepContent: Boolean(fresh) });
    } catch (error: Qualquer) {
      if (request !== comparisonRequest || activeTool !== "comparacao") return;
      status.textContent = error.message || "Não foi possível carregar o histórico.";
      if (!fresh) {
        app.limparAbasResumo?.(abaPedidaAoAbrir);
        renderError(byId("comparacao-planilhas-conteudo"), error, "Falha ao carregar o histórico.");
        byId("comparacao-planilhas-conteudo").dataset.estado = "erro";
      }
    }
  }

  function aliasValue(event: Qualquer, old = false) {
    if (event.tipo === "usuario") {
      const login = old ? event.usuario_anterior : event.usuario_novo;
      const name = old ? event.nome_pessoa_anterior : event.nome_pessoa_novo;
      return [login, name].filter(Boolean).join(" — ");
    }
    if (event.tipo === "endereco") {
      const address = old ? event.endereco_anterior : event.endereco_novo;
      if (!address || typeof address !== "object") return "";
      return [address.endereco, address.cidade, address.uf, address.cep, address.cnpj].filter(Boolean).join(" · ");
    }
    return String(old ? event.apelido_anterior || event.valor_anterior || "" : event.apelido_novo || event.valor_novo || "");
  }

  function aliasTypeLabel(type: Qualquer) {
    return ({ apelido: "Apelido", usuario: "Usuário", endereco: "Endereço", aviso_endpoint: "Aviso do Endpoint" } as Record<string, string>)[type]
      || (type ? "Alteração" : "Apelido");
  }

  function aliasActions(event: Qualquer) {
    return app.acoesEventoHistorico(event, aliasEvents, aliasLatest);
  }

  const ALIAS_WARNING_REASONS: Record<string, string> = {
    usuario_removido: "Usuário logado removido no Endpoint",
    hostname_removido: "Hostname removido no Endpoint",
  };

  // Séries de máquinas virtuais do próprio Sebrae (VMware, Google Cloud): fora do F7, só na exibição.
  const ALIAS_HIDDEN_SERIAL = /^(VMWARE|GOOGLECLOUD)/i;

  const aliasDate = (value: Qualquer) => (value ? displayDate(value) : "Data indisponível");

  const ALIAS_WEEKDAY = new Intl.DateTimeFormat("pt-BR", { weekday: "long" });
  const pad2 = (number: Qualquer) => String(number).padStart(2, "0");

  // Título do grupo por dia local: "Hoje · quarta, 11/11", "Ontem · terça, 10/11", "Segunda, 09/11".
  function aliasDayLabel(value: Qualquer, now = new Date()) {
    const stamp = Date.parse(value || "");
    if (!Number.isFinite(stamp)) return "Data indisponível";
    const date = new Date(stamp);
    const sameDay = (other: Qualquer) => date.getFullYear() === other.getFullYear() && date.getMonth() === other.getMonth() && date.getDate() === other.getDate();
    const weekday = ALIAS_WEEKDAY.format(date).replace(/-feira$/, "");
    const shortDate = `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}`;
    if (sameDay(now)) return `Hoje · ${weekday}, ${shortDate}`;
    if (sameDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return `Ontem · ${weekday}, ${shortDate}`;
    return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}, ${shortDate}`;
  }

  function aliasTime(value: Qualquer) {
    const stamp = Date.parse(value || "");
    if (!Number.isFinite(stamp)) return "";
    const date = new Date(stamp);
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }

  function aliasChip(event: Qualquer) {
    const chip = element("span", "ck-alias-chip", aliasTypeLabel(event.tipo));
    chip.dataset.aliasTipo = event.tipo || "apelido";
    return chip;
  }

  const aliasWarningReason = (event: Qualquer) => aliasReason(event) || event.motivo || "Aviso do Endpoint";
  const aliasWarningValue = (event: Qualquer) => event.valor_anterior || event.apelido_anterior || "valor não informado";

  // "antes → depois"; no aviso do Endpoint, "motivo · valor".
  function aliasChange(event: Qualquer, className: Qualquer) {
    const change = element("span", className);
    if (event.tipo === "aviso_endpoint") {
      change.textContent = `${aliasWarningReason(event)} · ${aliasWarningValue(event)}`;
      return change;
    }
    const arrow = element("span", "ck-alias-seta", "→");
    arrow.setAttribute("aria-hidden", "true");
    change.append(element("span", "ck-alteracao__antes", aliasValue(event, true) || "(vazio)"), arrow, element("strong", "", aliasValue(event) || "(vazio)"));
    return change;
  }

  // Só os preenchidos: "Origem: X", "Autor: Y".
  const aliasOriginAuthor = (event: Qualquer) => [event.origem && `Origem: ${event.origem}`, event.autor && `Autor: ${event.autor}`].filter(Boolean);

  function aliasReason(event: Qualquer) {
    return event.tipo === "aviso_endpoint" ? ALIAS_WARNING_REASONS[event.motivo] || "" : "";
  }

  function aliasTimeline(event: Qualquer) {
    const serial = String(event?.serial || "").trim().toUpperCase();
    return aliasEvents.filter(item => String(item.serial || "").trim().toUpperCase() === serial)
      .slice().sort((left, right) => (Date.parse(left.horario || "") || 0) - (Date.parse(right.horario || "") || 0));
  }

  function renderAliasCurrent(section: Qualquer, equipment: Qualquer, error = "") {
    const head = element("div", "ck-alias-det__cab");
    head.append(element("h3", "", "Cadastro atual"));
    section.replaceChildren(head);
    if (equipment === undefined) {
      section.append(element("p", "ck-nota", "Carregando os dados atuais do cadastro local…"));
      return;
    }
    if (error) {
      section.append(element("p", "ck-nota", `Dados atuais indisponíveis: ${error}`));
      return;
    }
    if (!equipment) {
      section.append(element("p", "ck-nota", "Esta série não foi encontrada na base atual."));
      return;
    }
    // Novo layout: o botão pequeno de copiar fica na linha do rótulo "Apelido atual"; Modelo e Local ficam lado a lado.
    let copy: Qualquer = null;
    if (equipment.apelido) {
      copy = element("button", "ck-btn ck-btn--secundario ck-btn--sm", "Copiar apelido atual");
      copy.type = "button";
      copy.addEventListener("click", async () => {
        copy.disabled = true;
        try {
          await app.copiarTextoParaAreaTransferencia(equipment.apelido);
          app.showToast("Apelido copiado.", "success");
        } catch (error: Qualquer) {
          app.showToast(error.message || "Não foi possível copiar o apelido.", "error");
        } finally { copy.disabled = false; }
      });
    }
    section.append(gradeCampos([
      campoHistorico("Apelido atual", equipment.apelido || "Sem apelido", { mono: Boolean(equipment.apelido), acao: copy, inteiro: true }),
      campoHistorico("Modelo", equipment.modelo || equipment.tipo || "Não informado"),
      campoHistorico("Local", equipment.retirada_cidade || "Não informado"),
    ]));
  }

  async function loadAliasCurrentEquipment(event: Qualquer, section: Qualquer, request: Qualquer) {
    const serial = String(event?.serial || "").trim();
    const key = normalize(serial);
    if (!key) return renderAliasCurrent(section, null);
    if (aliasEquipmentCache.has(key)) return renderAliasCurrent(section, aliasEquipmentCache.get(key));
    try {
      const data = await apiFetch(`/api/buscar-expandida?q=${encodeURIComponent(serial)}&limit=20`, {
        errorMessage: "Não foi possível consultar o cadastro atual.",
      });
      const equipment = (Array.isArray(data.items) ? data.items : []).find((item: Qualquer) => normalize(item.serial) === key) || null;
      aliasEquipmentCache.set(key, equipment);
      if (request === aliasEquipmentRequest && activeTool === "apelidos" && selectedAliasId === String(event.id || "")) {
        renderAliasCurrent(section, equipment);
      }
    } catch (error: Qualquer) {
      if (request === aliasEquipmentRequest && activeTool === "apelidos" && selectedAliasId === String(event.id || "")) {
        renderAliasCurrent(section, null, error.message || "Não foi possível consultar o cadastro.");
      }
    }
  }

  // `selo`: contagem ao lado do título (fora do texto do h3).
  function aliasBlock(title?: Qualquer, selo?: Qualquer) {
    const section = element("section", "ck-det-bloco ck-alias-det__bloco");
    if (title) section.append(selo ? cabecalhoBloco(title, selo) : element("h3", "", title));
    return section;
  }

  function aliasCompareBox(label: Qualquer, value: Qualquer, tone: Qualquer) {
    const box = element("div", `ck-alias-caixa ck-alias-caixa--${tone}`);
    box.append(element("span", "ck-alias-caixa__rotulo", label), element("strong", "ck-alias-caixa__valor", value));
    return box;
  }

  function aliasTimelineItem(item: Qualquer, selected: Qualquer) {
    const entry = element("li", "ck-tempo__item");
    const mark = element("span", "ck-tempo__marca");
    mark.dataset.aliasTipo = item.tipo || "apelido";
    if (item === selected) mark.dataset.selecionado = "true";
    const body = element("div", "ck-tempo__corpo");
    // Novo layout: horário em mono e selo do tipo na mesma linha, depois "antes (riscado) → depois".
    const title = element("span", "ck-alias-tempo__titulo");
    title.append(Object.assign(element("time", "ck-tempo__meta", aliasDate(item.horario)), { dateTime: item.horario || "" }), aliasChip(item));
    if (item === selected) title.append(element("span", "ck-alias-selo ck-alias-selo--atual", "Selecionado"));
    body.append(title, aliasChange(item, "ck-alteracao"));
    const origin = aliasOriginAuthor(item);
    if (origin.length) body.append(element("span", "ck-tempo__meta", origin.join(" · ")));
    entry.append(mark, body);
    return entry;
  }

  function renderAliasDetail(event: Qualquer) {
    const target = byId("cockpit-alias-detail");
    const request = ++aliasEquipmentRequest;
    if (!event) return renderEmpty(target, "Selecione uma alteração.");
    target.replaceChildren();

    // 1. Cabeçalho: tipo, data, série e ações.
    const head = aliasBlock();
    head.classList.add("ck-alias-det__topo");
    const meta = element("div", "ck-alias-det__meta");
    meta.append(aliasChip(event), element("span", "ck-alias-det__data", aliasDate(event.horario)));
    const actions = element("div", "ck-alias-det__acoes");
    if (event.serial) {
      const openHome = element("button", "ck-btn ck-btn--secundario", "Abrir na Home");
      openHome.type = "button";
      openHome.addEventListener("click", () => { void openSerialInHome(event.serial); });
      actions.append(openHome);
    }
    const allowed = aliasActions(event);
    const runAction = (button: Qualquer, action: Qualquer) => async () => {
      actions.querySelectorAll("button").forEach(item => { item.disabled = true; });
      const done = await action(event, button);
      if (done && activeTool === "apelidos") await loadAliases();
      else actions.querySelectorAll("button").forEach(item => { item.disabled = false; });
    };
    // Novo layout: "Restaurar anterior" e "Restaurar e excluir" dividem uma linha de duas colunas.
    const pair = element("div", "ck-alias-det__par");
    if (allowed.desfazer) {
      const undo = element("button", "ck-btn ck-btn--primario", "Restaurar anterior");
      undo.type = "button";
      undo.addEventListener("click", runAction(undo, app.desfazerEventoHistoricoApelidos));
      pair.append(undo);
    }
    if (allowed.excluir) {
      const remove = element("button", "ck-btn ck-btn--perigo", allowed.rotuloExcluir);
      remove.type = "button";
      remove.addEventListener("click", runAction(remove, app.excluirRegistroHistorico));
      pair.append(remove);
    }
    if (pair.children.length) actions.append(pair);
    if (!allowed.desfazer && !allowed.excluir) {
      const reason = event.tipo === "endereco"
        ? "Endereços são atualizados pela planilha Simpress e não podem ser restaurados manualmente."
        : "Há uma alteração mais recente para este campo, ou nenhuma ação está disponível para este registro.";
      actions.append(element("p", "ck-nota", reason));
    }
    head.append(meta, element("h3", "ck-alias-det__serie", event.serial || "Série indisponível"), actions);

    // 2. O que mudou.
    const changed = aliasBlock("O que mudou");
    if (event.tipo === "aviso_endpoint") {
      const box = element("div", "ck-alias-caixa ck-alias-caixa--aviso");
      box.append(element("strong", "ck-alias-caixa__valor", aliasWarningReason(event)), element("span", "ck-alias-caixa__sub", `Valor removido: ${aliasWarningValue(event)}`));
      changed.append(box);
    } else {
      const pair = element("div", "ck-alias-compara");
      pair.append(aliasCompareBox("Antes", aliasValue(event, true) || "(vazio)", "antes"), aliasCompareBox("Depois", aliasValue(event) || "(vazio)", "depois"));
      changed.append(pair);
    }

    // 3. Cadastro atual (carregado ao final).
    const current = aliasBlock();
    renderAliasCurrent(current, undefined);

    // 4. Detalhes do registro: só campos preenchidos.
    const fields = [
      ["Campo", event.acao], ["Origem", event.origem], ["Autor", event.autor],
      ["Usuário relacionado", event.usuario_endpoint], ["Motivo", aliasReason(event) || event.motivo],
    ];
    const filled = fields.filter(([, value]) => value);
    const details = filled.length ? aliasBlock("Detalhes do registro") : null;
    if (details) details.append(gradeCampos(filled.map(([label, value]) => campoHistorico(label, String(value)))));

    // 5. Histórico deste equipamento, do mais recente ao mais antigo; a contagem fica num selo ao lado do título.
    const events = aliasTimeline(event).slice().reverse();
    const timeline = aliasBlock("Histórico deste equipamento", seloContagem(events.length, plural(events.length, "registro", "registros")));
    if (!events.length) timeline.append(element("p", "ck-lista__vazio", "Não há outros eventos para esta série."));
    else {
      const list = element("ol", "ck-tempo");
      events.forEach(item => list.append(aliasTimelineItem(item, event)));
      timeline.append(list);
    }

    target.append(head, changed, current, ...(details ? [details] : []), timeline);
    void loadAliasCurrentEquipment(event, current, request);
  }

  const ALIAS_TYPES = ["todos", "apelido", "usuario", "endereco", "aviso_endpoint"];

  // typeOverride: tipo a usar no lugar do select (contagem de cada aba); o export continua usando o select.
  function filteredAliases(typeOverride?: Qualquer) {
    const terms = normalize(byId("cockpit-alias-search").value).split(/\s+/).filter(Boolean);
    const type = typeOverride ?? byId("cockpit-alias-type").value;
    const actionsOnly = byId("cockpit-alias-actions-only").checked;
    const cutoff = selectedAliasPeriod === "7dias" ? Date.now() - (7 * 24 * 60 * 60 * 1000) : null;
    return aliasEvents.filter(event => {
      if (type !== "todos" && (event.tipo || "apelido") !== type) return false;
      if (actionsOnly) {
        const actions = aliasActions(event);
        if (!actions.desfazer && !actions.excluir) return false;
      }
      if (cutoff !== null) {
        const timestamp = Date.parse(event.horario || "");
        if (!Number.isFinite(timestamp) || timestamp < cutoff) return false;
      }
      const searchable = normalize([event.serial, event.equipamento, event.tipo, event.acao, event.usuario_endpoint, event.horario, aliasDate(event.horario),
        event.motivo, aliasReason(event), event.origem, aliasValue(event, true), aliasValue(event)].join(" "));
      return terms.every(term => searchable.includes(term));
    });
  }

  // Aba ativa = valor do select (fonte de verdade); contagem = mesmos filtros de busca, ação e período, por tipo. Os botões nunca são recriados.
  function syncAliasTabs() {
    const current = byId("cockpit-alias-type").value;
    const counts = new Map();
    const all = filteredAliases("todos");
    all.forEach(event => counts.set(event.tipo || "apelido", (counts.get(event.tipo || "apelido") || 0) + 1));
    byId("cockpit-alias-tabs").querySelectorAll("[data-alias-type]").forEach((tab: Qualquer) => {
      const type = tab.dataset.aliasType;
      const active = type === current;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      const total = type === "todos" ? all.length : counts.get(type) || 0;
      const contador = tab.querySelector("[data-alias-tab-count]");
      globalThis.SimpressBento?.cancelar?.(contador); // busca no meio da contagem: o valor novo não pode ser sobrescrito pelo quadro seguinte
      contador.textContent = displayCount(total);
      contador.dataset.bentoContar = String(total); // alvo da contagem que animarFiltrosAlias() repete
    });
  }

  // Mais recente primeiro; datas inválidas no fim (a ordenação é estável).
  function sortAliasesByDate(events: Qualquer) {
    const stamp = (event: Qualquer) => { const value = Date.parse(event.horario || ""); return Number.isFinite(value) ? value : null; };
    return events.slice().sort((left: Qualquer, right: Qualquer) => {
      const a = stamp(left);
      const b = stamp(right);
      if (a === null || b === null) return Number(a === null) - Number(b === null);
      return b - a;
    });
  }

  function aliasRow(event: Qualquer, selected: Qualquer) {
    const button = element("button", "ck-alias-linha");
    button.type = "button";
    button.setAttribute("aria-pressed", String(event === selected));
    const top = element("span", "ck-alias-linha__topo");
    const serial = event.serial || "Série indisponível";
    top.append(aliasChip(event), Object.assign(element("strong", "ck-alias-linha__serie", serial), { title: serial }), element("span", "ck-alias-linha__hora", aliasTime(event.horario)));
    button.append(top, aliasChange(event, "ck-alias-linha__mudanca"));
    // Novo layout: origem e autor saem da linha (continuam no detalhe e na linha do tempo); o selo entra direto na grade da linha.
    const allowed = aliasActions(event);
    if (allowed.desfazer || allowed.excluir) button.append(element("span", "ck-alias-selo", "Ação disponível"));
    button.addEventListener("click", () => { selectedAliasId = String(event.id || ""); renderAliases(); });
    const item = element("li", "ck-ferr-item");
    item.append(button);
    return item;
  }

  // `total`: alterações do dia no filtro atual, mesmo quando "Carregar mais" ainda não mostrou todas.
  function aliasGroup(label: Qualquer, events: Qualquer, selected: Qualquer, total = events.length) {
    const group = element("section", "ck-alias-grupo");
    const heading = element("h3", "ck-alias-grupo__cab");
    heading.append(element("span", "", label), seloContagem(total, plural(total, "alteração", "alterações")));
    const list = element("ul", "ck-alias-grupo__lista");
    list.append(...events.map((event: Qualquer) => aliasRow(event, selected)));
    group.append(heading, list);
    return group;
  }

  function renderAliases() {
    const metrics = aliasMetrics(aliasEvents);
    renderKpis(byId("cockpit-alias-kpis"), [
      ["Alterações neste mês", metrics.changesThisMonth], ["Equipamentos afetados", metrics.equipmentAffected],
    ]);
    globalThis.SimpressBento?.cancelar?.(byId("cockpit-alias-count-all"));
    globalThis.SimpressBento?.cancelar?.(byId("cockpit-alias-count-7days"));
    byId("cockpit-alias-count-all").textContent = displayCount(aliasEvents.length);
    byId("cockpit-alias-count-all").dataset.bentoContar = String(aliasEvents.length);
    const sevenDayCount = aliasEvents.filter(event => {
      const timestamp = Date.parse(event.horario || "");
      return Number.isFinite(timestamp) && timestamp >= Date.now() - (7 * 24 * 60 * 60 * 1000);
    }).length;
    byId("cockpit-alias-count-7days").textContent = displayCount(sevenDayCount);
    byId("cockpit-alias-count-7days").dataset.bentoContar = String(sevenDayCount);
    byId("cockpit-alias-filters").querySelectorAll("[data-alias-period]").forEach((button: Qualquer) => {
      button.setAttribute("aria-pressed", String(button.dataset.aliasPeriod === selectedAliasPeriod));
    });
    syncAliasTabs();
    const filtered = sortAliasesByDate(filteredAliases());
    const target = byId("cockpit-alias-list");
    if (!filtered.length) {
      renderEmpty(target, aliasEvents.length ? "Nenhuma alteração corresponde aos filtros." : "O histórico não contém alterações.");
      renderAliasDetail(null);
      return;
    }
    const selected = filtered.find((event: Qualquer) => String(event.id || "") === selectedAliasId) || filtered[0];
    selectedAliasId = String(selected?.id || "");
    // Paginação local (50 por vez): mudou busca, tipo, período, filtro de ação ou total, volta à primeira página;
    // o registro selecionado nunca fica fora da fatia exibida.
    const filterKey = chaveFiltroHistorico([byId("cockpit-alias-search").value, byId("cockpit-alias-type").value, byId("cockpit-alias-actions-only").checked, selectedAliasPeriod, aliasEvents.length]);
    if (filterKey !== aliasChaveFiltro) { aliasChaveFiltro = filterKey; aliasPaginas = 1; }
    const { visiveis, restantes } = fatiaHistorico(filtered, aliasPaginas, filtered.indexOf(selected));
    const groups = new Map();
    filtered.forEach((event: Qualquer, index: number) => {
      const stamp = Date.parse(event.horario || "");
      const key = Number.isFinite(stamp) ? new Date(stamp).toDateString() : "";
      if (!groups.has(key)) groups.set(key, { label: aliasDayLabel(event.horario), events: [], total: 0 });
      const group = groups.get(key);
      group.total += 1;
      if (index < visiveis.length) group.events.push(event);
    });
    target.replaceChildren(
      ...[...groups.values()].filter(group => group.events.length).map(group => aliasGroup(group.label, group.events, selected, group.total)),
      ...(restantes ? [blocoCarregarMais(loadMoreAliases)] : []),
    );
    renderAliasDetail(selected);
  }

  // "Carregar mais": mostra a próxima página e leva o foco à primeira linha nova.
  function loadMoreAliases() {
    const list = byId("cockpit-alias-list");
    const shown = list.querySelectorAll(".ck-alias-linha").length;
    aliasPaginas = Math.floor(shown / TAMANHO_PAGINA_HISTORICO) + 1; // a fatia pode ter crescido até o selecionado
    renderAliases();
    list.querySelectorAll<HTMLElement>(".ck-alias-linha")[shown]?.focus();
  }

  // Troca de aba ou de filtro repete a contagem dos números (contrato bento); a busca por texto não repete.
  function animarFiltrosAlias() {
    globalThis.SimpressBento?.animarDentro?.(byId("cockpit-alias-tabs"));
    globalThis.SimpressBento?.animarDentro?.(byId("cockpit-alias-filters"));
  }

  // Abas: o select oculto é a fonte de verdade do filtro de tipo; setar .value não dispara "change", por isso renderAliases() direto.
  function selectAliasType(type: Qualquer) {
    byId("cockpit-alias-type").value = type;
    renderAliases();
    animarFiltrosAlias();
    (byId("cockpit-alias-tabs").querySelector(`[data-alias-type="${type}"]`) as ElementoCockpit | null)?.focus();
  }

  function bindAliasTabs() {
    const tabs = byId("cockpit-alias-tabs");
    tabs.addEventListener("click", event => {
      const tab = (event.target as ElementoCockpit).closest<ElementoCockpit>("[data-alias-type]");
      if (tab) selectAliasType(tab.dataset.aliasType);
    });
    tabs.addEventListener("keydown", event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const current = ALIAS_TYPES.indexOf((event.target as ElementoCockpit).closest<ElementoCockpit>("[data-alias-type]")?.dataset.aliasType as string);
      if (current < 0) return;
      const next = { ArrowRight: (current + 1) % ALIAS_TYPES.length, ArrowLeft: (current + ALIAS_TYPES.length - 1) % ALIAS_TYPES.length, Home: 0, End: ALIAS_TYPES.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      selectAliasType(ALIAS_TYPES[next]);
    });
  }

  async function loadAliases() {
    const request = ++aliasRequest;
    const target = byId("cockpit-alias-list");
    target.setAttribute("aria-busy", "true");
    renderEmpty(target, "Carregando histórico local…");
    try {
      const data = await apiFetch("/api/historico-alteracoes", { errorMessage: "Não foi possível carregar o histórico de alterações." });
      if (request !== aliasRequest || activeTool !== "apelidos") return;
      aliasEvents = (Array.isArray(data.eventos) ? data.eventos : []).filter((event: Qualquer) => !ALIAS_HIDDEN_SERIAL.test(String(event.serial || "").trim()));
      aliasLatest = app.ultimoRegistroPorCampo(aliasEvents);
      aliasEquipmentCache.clear();
      if (!aliasEvents.some(event => String(event.id || "") === selectedAliasId)) selectedAliasId = "";
      renderAliases();
    } catch (error: Qualquer) {
      if (request === aliasRequest && activeTool === "apelidos") renderError(target, error, "Falha ao carregar o histórico.");
    }
    finally { target.removeAttribute("aria-busy"); }
  }

  function csvCell(value: Qualquer) {
    let text = String(value ?? "");
    if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  }

  function exportAliasesCsv() {
    const rows = [["Data", "Série", "Equipamento", "Tipo", "Ação", "Origem", "Usuário relacionado", "Valor anterior", "Valor novo", "Motivo"], ...filteredAliases().map(event => [
      event.horario, event.serial, event.equipamento, aliasTypeLabel(event.tipo), event.acao,
      event.origem, event.usuario_endpoint, aliasValue(event, true), aliasValue(event), aliasReason(event) || event.motivo,
    ])];
    const blob = new Blob([`\uFEFF${rows.map(row => row.map(csvCell).join(";")).join("\r\n")}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = element("a");
    link.href = url;
    link.download = "historico-de-apelidos.csv";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function currentMonth() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }

  function recentMonthKeys(count = 3) {
    const now = new Date();
    return Array.from({ length: count }, (_unused, index) => {
      const month = new Date(now.getFullYear(), now.getMonth() - index, 1);
      return `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`;
    });
  }

  function monthLabel(key: Qualquer) {
    const [year, month] = key.split("-").map(Number);
    return new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(new Date(year, month - 1, 1));
  }

  function renderMonthlyPeriods(selectedMonth: Qualquer) {
    const target = byId("cockpit-monthly-periods");
    const current = currentMonth();
    target.replaceChildren(...recentMonthKeys().map(key => {
      const button = element("button", "ck-pilula");
      button.type = "button";
      button.setAttribute("aria-pressed", String(key === selectedMonth));
      const status = key === current
        ? `Parcial até ${new Intl.DateTimeFormat("pt-BR").format(new Date())}`
        : "Mês encerrado";
      // Visível só o mês (Novembro); o ano e a situação vão no nome acessível e na dica.
      button.textContent = capitalizar(nomeDoMes(key) || monthLabel(key));
      button.setAttribute("aria-label", `${monthLabel(key)} · ${status}`);
      button.title = `${monthLabel(key)} · ${status}`;
      button.addEventListener("click", () => {
        const input = byId("cockpit-monthly-month");
        input.value = key;
        renderMonthlyPeriods(key);
        void loadMonthlyReport(key);
      });
      return button;
    }));
  }

  // ---- Relatório mensal (F8): Novo layout (18/11/2026), em quatro sub-abas ----
  // Visão geral (Precisa de atenção: OS pendentes e Chamados (F5) → Movimento do mês → Prévia), OS e pedidos do mês,
  // Chamados (F5: situação atual e contagem do mês, report.sebrae) e Base atual. A comparação de inventário saiu da tela. Cada número aparece uma vez; os links só navegam
  // (Home, OS, Resumo, Chamados), nada é gravado. A estrutura das abas e dos painéis é estática no partial; o JS só preenche e alterna.
  const MONTHLY_PAGE = 20;
  const MONTHLY_TOP_UNITS = 8;
  const REL_ABAS = ["visao", "os", "sebrae", "base"];
  // `aba` só nasce aqui: o reset de loadMonthlyReport não a toca, então a aba escolhida sobrevive à troca de mês e à recarga quieta.
  const monthlyView: Registro = { aba: "visao", report: null, sebrae: null, sebraeErro: "", filtro: "todas", limiteOs: MONTHLY_PAGE, limiteSebrae: MONTHLY_PAGE, unidadesTodas: false, foraAberto: false, fonteGrafico: "ambas" };
  const monthlySituationTone: Record<string, string> = { "Aberta no mês": "info", "Concluída no mês": "success", "Pendente no fim do mês": "warning" };
  const monthlyFilters = [["todas", "Todas", ""], ["abertas", "Abertas", "Aberta no mês"], ["concluidas", "Concluídas", "Concluída no mês"], ["pendentes", "Pendentes", "Pendente no fim do mês"]];
  const monthlyBadgeStatus: Record<string, string> = { ...badgeStatus, info: "info" };

  function monthlyBadge(text: Qualquer, tone?: Qualquer) {
    const node = element("span", "ck-badge", text);
    if (monthlyBadgeStatus[tone]) node.dataset.status = monthlyBadgeStatus[tone];
    return node;
  }

  // Datas da API ("2026-11-05T14:12:00" ou "2026-11-05") viram texto pt-BR sem conversão de fuso: mostra o horário salvo.
  function monthlyDate(value: Qualquer) {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(value || ""));
    if (!match) return "";
    const [, year, month, day, hour, minute] = match;
    return hour ? `${day}/${month}/${year} às ${hour}:${minute}` : `${day}/${month}/${year}`;
  }

  function plural(count: Qualquer, singular: Qualquer, pluralText: Qualquer) { return Number(count) === 1 ? singular : pluralText; }

  function monthlyPeriodLabel(report: Qualquer) {
    const cutoff = monthlyDate(report?.mes?.data_corte);
    return report?.mes?.parcial ? `Parcial até ${cutoff || "data indisponível"}` : "Mês encerrado";
  }

  function comparisonUsedText(comparison: Qualquer) {
    const updates = Number(comparison?.atualizacoes_no_mes) || 0;
    const when = monthlyDate(comparison?.horario) || "nenhuma até o fim do período";
    return `Comparação usada: ${when} · ${displayCount(updates)} ${plural(updates, "atualização", "atualizações")} de inventário no mês`;
  }

  // Uma série só (pedidos Simpress podem reunir várias, separadas por vírgula): sem série única não há link.
  function singleSerial(value: Qualquer) {
    const text = String(value || "").trim();
    return text && !text.includes(",") ? text : "";
  }

  function monthlyButton(text: Qualquer, onClick: Qualquer, { className = "ck-btn ck-btn--secundario ck-btn--sm", label = "", arrow = false } = {}) {
    const button = element("button", className, text);
    button.type = "button";
    if (arrow) button.append(element("span", "ck-rel__seta", " →"));
    if (arrow) (button.lastChild as ElementoCockpit).setAttribute("aria-hidden", "true");
    if (label) button.setAttribute("aria-label", label);
    button.addEventListener("click", onClick);
    return button;
  }

  function monthlyLink(text: Qualquer, label: Qualquer, onClick: Qualquer) { return monthlyButton(text, onClick, { className: "ck-rel__link ck-mono", label }); }

  // Cartão bento (seção 6 do ck-bento.css): o próprio elemento vira o cartão e o conteúdo vai para a face; id, ARIA e data-* ficam no elemento externo.
  function monthlyCartao(card: Qualquer, tom = "", atraso = 0) {
    const face = element("div", "ck-bento-face");
    face.append(...[...card.children]);
    card.append(face);
    card.classList.add("ck-bento-cartao", `ck-bento-d${atraso}`);
    if (tom) card.dataset.tom = tom;
    return card;
  }

  // Alvo da contagem animada (SimpressBento.animarDentro); sem número válido, o "—" fica como está.
  function monthlyContavel(node: Qualquer, value: Qualquer) {
    if (Number.isFinite(value)) node.dataset.bentoContar = String(value);
    return node;
  }

  // Contagem e barras do painel aberto recomeçam a cada troca de sub-aba (contrato bento).
  function animarPainelRelatorio() {
    globalThis.SimpressBento?.animarDentro?.(byId(`rel-painel-${monthlyView.aba}`));
  }

  // Sub-abas do F8 (Resumo F3 e OS F6 seguem o mesmo molde): estado em monthlyView.aba, ARIA e painel visível numa só passagem.
  function aplicarAbaRelatorio() {
    REL_ABAS.forEach(nome => {
      const selecionada = nome === monthlyView.aba;
      const aba = byId(`rel-aba-${nome}`);
      if (aba) {
        aba.setAttribute("aria-selected", String(selecionada));
        aba.tabIndex = selecionada ? 0 : -1;
      }
      const painel = byId(`rel-painel-${nome}`);
      if (painel) painel.hidden = !selecionada;
    });
  }

  /** Seleciona a sub-aba (clique, setas, Home, End, "Ver lista"); `focar` leva o foco ao botão da aba. */
  function selecionarAbaRelatorio(nome: Qualquer, { focar = false } = {}) {
    if (!REL_ABAS.includes(nome)) return;
    monthlyView.aba = nome;
    aplicarAbaRelatorio();
    animarPainelRelatorio();
    if (focar) byId(`rel-aba-${nome}`)?.focus();
  }

  // `aba`: troca antes de focar, porque foco em painel hidden não pega.
  function monthlyJump(headingId: Qualquer, aba = "") {
    if (aba) selecionarAbaRelatorio(aba);
    const heading = byId(headingId);
    if (!heading) return;
    heading.scrollIntoView?.({ block: "start", behavior: globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? "auto" : "smooth" });
    heading.focus({ preventScroll: true });
  }

  // Abre a aba OS (F6) filtrada pela série (a busca da F6 procura série, OS, usuário, hostname, modelo e UTIC).
  async function openSerialInTickets(serial: Qualquer) {
    const search = byId("cockpit-tickets-search");
    if (search) search.value = String(serial || "").trim().toUpperCase();
    await openPanel("chamados");
    search?.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // Abre a aba Chamados (F5) numa sub-aba (Novos, Antigos…) sem filtro de chamado.
  async function openSebraeTab(tab: Qualquer) {
    await openPanel("sebrae-chamados");
    byId(`sebrae-aba-${tab}`)?.click();
  }

  function monthlyNumbers(entries: Qualquer) {
    const grid = element("dl", "ck-rel__numeros");
    entries.forEach(([label, value, tone]: Qualquer) => {
      const cell = element("div", "ck-rel__numero");
      if (tone) cell.dataset.status = tone;
      cell.append(element("dt", "ck-rel__rotulo", label), monthlyContavel(element("dd", "ck-rel__valor", displayCount(value)), value));
      grid.append(cell);
    });
    return grid;
  }

  // Título do cartão; `tip` (ⓘ com a explicação) fica ao lado dele, na mesma linha.
  function monthlyCardTitle(title: Qualquer, tip: Qualquer) {
    const heading = element("h4", "ck-rel__cartao-titulo", title);
    if (!tip) return heading;
    const head = element("div", "ck-rel__cartao-cab");
    head.append(heading, tip);
    return head;
  }

  function monthlyCard(title: Qualquer, tone?: Qualquer, tip?: Qualquer) {
    const card = element("article", "ck-rel__cartao ck-rel__atencao");
    if (tone) card.dataset.status = tone;
    card.append(monthlyCardTitle(title, tip));
    return card;
  }

  function monthlyOutsideCard(rows: Qualquer) {
    const card = monthlyCard("Fora das contagens", "alerta", infoTip("fora das contagens", "Datas ou vínculo insuficientes: não entram nos números do mês.", "cockpit-monthly-fora-nota"));
    const total = element("p", "ck-rel__total");
    total.append(monthlyContavel(element("strong", "ck-rel__valor", displayCount(rows.length)), rows.length), document.createTextNode(` ${plural(rows.length, "registro", "registros")}`));
    const list = element("ul", "ck-rel__fora");
    list.id = "cockpit-monthly-fora";
    list.hidden = !monthlyView.foraAberto;
    rows.forEach((row: Qualquer) => list.append(element("li", "", `${row.fonte || "Fonte indisponível"} · ${(row.identificadores || []).filter(Boolean).join(", ") || "Identificador indisponível"} · ${row.serie || "Série indisponível"} — ${row.motivo || "Motivo indisponível"}`)));
    const toggle = monthlyButton(monthlyView.foraAberto ? "Ocultar registros" : "Mostrar registros", () => {
      monthlyView.foraAberto = !monthlyView.foraAberto;
      list.hidden = !monthlyView.foraAberto;
      toggle.textContent = monthlyView.foraAberto ? "Ocultar registros" : "Mostrar registros";
      toggle.setAttribute("aria-expanded", String(monthlyView.foraAberto));
    });
    toggle.setAttribute("aria-expanded", String(monthlyView.foraAberto));
    toggle.setAttribute("aria-controls", list.id);
    card.append(total, toggle, list);
    return card;
  }

  // Os cartões de "Precisa de atenção": OS pendentes (antes), o cartão estático Chamados (F5), que nunca é recriado, e, só com
  // registros sem data ou vínculo, "Fora das contagens" (depois).
  function renderMonthlyAttention(report: Qualquer) {
    const tickets = report.os || {};
    const insufficient = Array.isArray(tickets.dados_insuficientes) ? tickets.dados_insuficientes : [];
    const pending = monthlyCard("OS pendentes no fim do período", "", infoTip("as OS pendentes", "Criados até o corte e ainda sem conclusão ou entrega.", "cockpit-monthly-pendentes-nota"));
    pending.append(
      monthlyNumbers([["OS Oracle", tickets.oracle?.pendentes], ["Pedidos Simpress", tickets.simpress?.pendentes]]),
      monthlyButton("Ver lista", () => {
        monthlyView.filtro = "pendentes";
        monthlyView.limiteOs = MONTHLY_PAGE;
        refreshMonthlySection("os");
        monthlyJump("cockpit-monthly-os-title", "os");
      }, { className: "ck-rel__link", label: "Ver lista de OS e pedidos pendentes", arrow: true }),
    );
    monthlyCartao(pending, "ciano", 0);
    // O cartão "Chamados (F5)" é estático no partial e fica entre os cartões de OS: a grade é refeita em volta dele.
    byId("cockpit-monthly-kpis").replaceChildren(pending, byId("cockpit-monthly-chamados"), ...(insufficient.length ? [monthlyCartao(monthlyOutsideCard(insufficient), "ambar", 2)] : []));
  }

  function monthlySection(key: Qualquer, title: Qualquer, actions: Qualquer[] = []) {
    const section = element("section", "ck-det-bloco ck-rel__secao");
    section.dataset.relSecao = key;
    const head = element("div", "ck-rel__secao-cab");
    const heading = element("h3", "ck-det__titulo", title);
    heading.id = `cockpit-monthly-${key}-title`;
    heading.tabIndex = -1;
    section.setAttribute("aria-labelledby", heading.id);
    head.append(heading, ...actions);
    section.append(head);
    return section;
  }

  // Tabela que vira cartões no celular (ck-tabela--cards). Célula: texto ou nó pronto; `numeric`: colunas à direita.
  function monthlyTable(columns: Qualquer, rows: Qualquer, numeric: number[] = []) {
    const wrap = element("div", "ck-rel__tabela");
    const table = element("table", "ck-tabela ck-tabela--cards");
    const head = element("tr");
    columns.forEach((label: Qualquer, index: Qualquer) => {
      const th = element("th", numeric.includes(index) ? "ck-th--dir" : "", label);
      th.scope = "col";
      head.append(th);
    });
    const thead = element("thead");
    thead.append(head);
    const body = element("tbody");
    rows.forEach((cells: Qualquer) => {
      const line = element("tr");
      cells.forEach((cell: Qualquer, index: Qualquer) => {
        const td = element("td", numeric.includes(index) ? "ck-td--dir" : "");
        td.dataset.label = columns[index];
        if (cell && typeof cell === "object") td.append(cell);
        else td.textContent = String(cell ?? "") || "—";
        line.append(td);
      });
      body.append(line);
    });
    table.append(thead, body);
    wrap.append(table);
    return wrap;
  }

  // Rodapé só quando há mais a carregar ou já se carregou além da primeira página ("Mostrando 1 de 1" seria ruído).
  function monthlyMore(shown: Qualquer, total: Qualquer, onMore: Qualquer) {
    if (shown >= total && total <= MONTHLY_PAGE) return document.createDocumentFragment();
    const foot = element("div", "ck-rel__rodape");
    foot.append(element("span", "ck-rel__nota", `Mostrando ${displayCount(shown)} de ${displayCount(total)}`));
    if (shown < total) {
      const more = monthlyButton("Carregar mais", onMore);
      more.dataset.relMais = "";
      foot.append(more);
    }
    return foot;
  }

  // Selo da fonte na tabela de movimento: Oracle ciano, Simpress índigo (data-tom do Novo layout).
  function monthlySourceBadge(text: Qualquer, tone: Qualquer) {
    const node = element("span", "nf8-selo", text);
    node.dataset.nlTom = tone;
    return node;
  }

  // Gráfico por semana (seletor de fonte no cabeçalho) e a tabela Fonte x Abertas, Concluídas, Encerradas; os totais vêm do servidor.
  function monthlyMovementSection(report: Qualquer) {
    const tickets = report.os || {};
    const { seletor, grafico } = montarMovimento(tickets, report.mes || {}, monthlyView.fonteGrafico, (fonte: Qualquer) => { monthlyView.fonteGrafico = fonte; });
    const section = monthlySection("movimento", "Movimento do mês", [seletor]);
    const rows = [[monthlySourceBadge("Oracle", "ciano"), tickets.oracle || {}], [monthlySourceBadge("Simpress", "indigo"), tickets.simpress || {}]]
      .map(([label, counts]) => [label, displayCount(counts.abertas), displayCount(counts.concluidas), displayCount(counts.encerradas_sem_data)]);
    const table = monthlyTable(["Fonte", "Abertas", "Concluídas", "Encerradas"], rows, [1, 2, 3]);
    table.querySelectorAll("th")[3].title = "Encerradas sem data de conclusão";
    section.append(grafico, table);
    return section;
  }

  // Linhas de uma fonte do relatório; a seção e o contador da aba leem pela mesma regra, então o número da aba é o da lista.
  function monthlyRows(source: Qualquer) {
    return Array.isArray(source?.linhas) ? source.linhas : [];
  }

  function monthlyOsSection(tickets: Qualquer) {
    const all = monthlyRows(tickets);
    const filter = monthlyFilters.find(([key]) => key === monthlyView.filtro) || monthlyFilters[0];
    const rows = filter[2] ? all.filter((row: Qualquer) => (row.situacao || []).includes(filter[2])) : all;
    const group = element("div", "ck-rel__filtros");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "Filtrar por situação");
    const rotuloFiltro = element("span", "nf8-rotulo", "Filtrar por situação");
    rotuloFiltro.setAttribute("aria-hidden", "true");
    monthlyFilters.forEach(([key, label]) => {
      const button = monthlyButton(label, () => {
        monthlyView.filtro = key;
        monthlyView.limiteOs = MONTHLY_PAGE;
        refreshMonthlySection("os", `[data-rel-filtro="${key}"]`);
      });
      button.dataset.relFiltro = key;
      button.setAttribute("aria-pressed", String(key === filter[0]));
      group.append(button);
    });
    const filtro = element("div", "nf8-filtro");
    filtro.append(rotuloFiltro, group);
    const section = monthlySection("os", "OS e pedidos do mês", [filtro, monthlyButton("Ver na aba OS (F6)", () => openPanel("chamados"), { className: "ck-rel__link", arrow: true })]);
    if (!rows.length) {
      section.append(element("p", "ck-lista__vazio", "Sem registros neste período."));
      return section;
    }
    const shown = rows.slice(0, monthlyView.limiteOs);
    const columns = ["Fonte", "OS/Pedido", "Série", "Status", "Criação", "Conclusão", "Situação no mês"];
    section.append(monthlyTable(columns, shown.map((row: Qualquer) => {
      const serial = singleSerial(row.serie);
      const id = String(row.identificador || "") || "—";
      const situations = element("span", "ck-rel__selos");
      (row.situacao || []).forEach((text: Qualquer) => situations.append(monthlyBadge(text, monthlySituationTone[text])));
      return [
        row.fonte || "—",
        serial ? monthlyLink(id, `Ver ${id} na aba OS (F6), pela série ${serial}`, () => openSerialInTickets(serial)) : element("span", "ck-mono", id),
        serial ? monthlyLink(serial, `Abrir ${serial} na Home`, () => openSerialInHome(serial)) : element("span", "ck-mono", row.serie || "—"),
        row.status || "—",
        monthlyDate(row.criacao) || "—",
        monthlyDate(row.conclusao) || "—",
        situations,
      ];
    })), monthlyMore(shown.length, rows.length, () => {
      monthlyView.limiteOs += MONTHLY_PAGE;
      refreshMonthlySection("os", "[data-rel-mais]");
    }));
    return section;
  }

  // Chamados da aba Chamados (F5), lidos de GET /api/sebrae/novos (só leitura). Mesma regra do F5 (sebrae-dashboard.js):
  // um chamado que o site finalizou sai de Novos e de Antigos na hora, mesmo antes de reimportar o Dashboard.
  function sebraeOpenLists(data: Qualquer) {
    const finalizados = data?.importado?.finalizados || [];
    const done = new Set(finalizados.map((item: Qualquer) => item.numero));
    const open = (item: Qualquer) => !done.has(item.numero);
    return { novos: (data?.novos?.formulario || []).filter(open), antigos: (data?.importado?.abertos || []).filter(open), finalizados };
  }

  // Liga uma linha da contagem do mês (report.sebrae, chave do F8) aos dados do F5 já carregados.
  // A chave do F8 nem sempre é a do F5: número antigo (5 dígitos) ou `linha:N` do F8 casam com o antigo `linha:N` do F5
  // pelo texto da coluna C (`item.chamado`), só quando o resultado é único. `chaveF5` vazia = sem link.
  function sebraeMonthMatch(row: Qualquer, data: Qualquer) {
    const chave = String(row?.chave || "");
    const chamado = String(row?.chamado || "").trim();
    const novos = data?.novos?.formulario || [];
    const abertos = data?.importado?.abertos || [];
    const finalizados = data?.importado?.finalizados || [];
    const serie = String(row?.serie || "").trim() || String(novos.find((item: Qualquer) => item.numero === chave)?.linha?.K || "").trim();
    let chaveF5 = "";
    if (chave && !chave.startsWith("linha:") && [...novos, ...abertos, ...finalizados].some(item => item.numero === chave)) chaveF5 = chave;
    else if (chamado) {
      const old = /^\d{5}$/.test(chave);
      const same = (item: Qualquer) => old ? /(?<!\d)\d{5}(?!\d)/.exec(String(item.chamado || ""))?.[0] === chave : String(item.chamado || "").trim() === chamado;
      const found = abertos.filter((item: Qualquer) => String(item.numero || "").startsWith("linha:") && same(item));
      if (found.length === 1) chaveF5 = found[0].numero;
    }
    return { chaveF5, serie };
  }

  // Números da contagem do mês (report.sebrae); null quando não há Dashboard importado ou a leitura falhou.
  function sebraeMonthCounts(report: Qualquer) {
    const data = report?.sebrae;
    return data && !data.erro && Number.isFinite(data.abertos) ? data : null;
  }

  // "Situação atual" (GET /api/sebrae/novos): dois cartões, Chamados novos (âmbar) e Antigos em aberto (fúcsia), cada um com o link
  // que abre a sub-aba do F5.
  function monthlySebraeCurrent(section: Qualquer) {
    if (monthlyView.sebraeErro) {
      section.append(element("p", "ck-nota ck-nota--erro", monthlyView.sebraeErro));
      return true;
    }
    const data = monthlyView.sebrae;
    if (!data?.importado && !data?.novos) return false;
    const lists = sebraeOpenLists(data);
    const grade = element("div", "nf8-cham-grade");
    [["Chamados novos", lists.novos.length, "Ver novos", "novos", "ambar"], ["Antigos em aberto", lists.antigos.length, "Ver antigos", "antigos", "fucsia"]]
      .forEach(([title, total, link, tab, tone]: Qualquer, index) => {
        const card = element("article", "nf8-cham-cartao");
        card.append(
          element("h4", "ck-rel__cartao-titulo", title),
          monthlyContavel(element("strong", "ck-rel__valor nf8-cham-num", displayCount(total)), total),
          monthlyButton(link, () => openSebraeTab(tab), { className: "ck-rel__link", arrow: true }),
        );
        grade.append(monthlyCartao(card, tone, index));
      });
    section.append(grade);
    return true;
  }

  // Contagem do mês (report.sebrae): números Abertos e Finalizados, chip "N sem data" no cabeçalho e a tabela de chamados.
  function monthlySebraeMonth(card: Qualquer, cab: Qualquer, report: Qualquer, empty: Qualquer) {
    const month = report?.sebrae;
    if (!month) {
      card.append(element("p", "ck-lista__vazio", empty));
      return;
    }
    const counts = sebraeMonthCounts(report);
    if (!counts) {
      card.append(element("p", "ck-nota ck-nota--erro", month.erro || "Não foi possível contar os chamados do mês."));
      return;
    }
    if (Number.isFinite(counts.sem_data)) {
      const chip = element("span", "nf8-chip", `${displayCount(counts.sem_data)} sem data`);
      chip.title = "Sem data de abertura ou de encerramento: fora da contagem do mês";
      cab.append(chip);
    }
    card.append(monthlyNumbers([["Abertos", counts.abertos], ["Finalizados", counts.finalizados]]));
    const rows = monthlyRows(counts);
    if (!rows.length) {
      card.append(element("p", "ck-lista__vazio", "Sem registros neste período."));
      return;
    }
    const shown = rows.slice(0, monthlyView.limiteSebrae);
    card.append(monthlyTable(["Chamado", "Título", "Série", "Abertura", "Finalização", "Situação no mês"], shown.map((row: Qualquer) => {
      const { chaveF5, serie } = sebraeMonthMatch(row, monthlyView.sebrae);
      const serial = singleSerial(serie);
      const number = String(row.chamado || "").trim() || "Sem UTIC";
      const situations = element("span", "ck-rel__selos");
      (row.situacoes || []).forEach((text: Qualquer) => situations.append(monthlyBadge(text, text === "Finalizado no mês" ? "success" : "info")));
      return [
        chaveF5 ? monthlyLink(number, `Abrir ${number} na aba Chamados (F5)`, () => app.abrirChamadoSebraeNoF5?.(chaveF5)) : element("span", "ck-mono", number),
        row.titulo || "—",
        serial ? monthlyLink(serial, `Abrir ${serial} na Home`, () => openSerialInHome(serial)) : element("span", "ck-mono", serie || "—"),
        monthlyDate(row.abertura) || "—",
        monthlyDate(row.finalizacao) || "—",
        situations,
      ];
    })), monthlyMore(shown.length, rows.length, () => {
      monthlyView.limiteSebrae += MONTHLY_PAGE;
      refreshMonthlySection("sebrae", "[data-rel-mais]");
    }));
  }

  // Título e selo "Situação atual" ficam fora dos cartões; embaixo, o cartão "Com data em <mês por extenso>" (nunca AAAA-MM).
  function monthlySebraeSection(report: Qualquer) {
    const section = monthlySection("sebrae", "Chamados (F5)", [monthlyBadge("Situação atual")]);
    section.classList.add("ck-rel__atual");
    const empty = "Nenhum Dashboard importado. A importação e a busca ficam na aba Automação (F4).";
    const hasCurrent = monthlySebraeCurrent(section);
    if (!hasCurrent) section.append(element("p", "ck-lista__vazio", empty));
    if (!hasCurrent && !report?.sebrae) return section;
    const card = element("article", "nf8-cham-info");
    const cab = element("div", "ck-rel__cartao-cab nf8-cham-info__cab");
    cab.append(element("h4", "ck-rel__cartao-titulo", `Com data em ${mesPorExtenso(report?.mes?.key, report?.mes?.label)}`),
      infoTip("a contagem do mês", "Contagem pelo Dashboard importado (abertura em P, encerramento em R), pelos chamados novos da busca e pelos finalizados pelo site.", "cockpit-monthly-sebrae-nota"));
    card.append(cab);
    monthlySebraeMonth(card, cab, report, empty);
    section.append(monthlyCartao(card, "", 2));
    return section;
  }

  function monthlyTypesCard(rows: Qualquer) {
    const card = element("section", "ck-rel__cartao");
    card.append(element("h4", "ck-rel__cartao-titulo", "Inventário por tipo"));
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      card.append(element("p", "ck-lista__vazio", "Sem registros neste período."));
      return card;
    }
    const items = element("ul", "ck-rel__tipos");
    list.forEach(([name, count]) => {
      const item = element("li", "ck-rel__tipo");
      const line = element("span", "ck-rel__tipo-linha");
      line.append(element("span", "", name || "Sem tipo"), monthlyContavel(element("strong", "ck-num", displayCount(count)), count));
      item.append(line);
      items.append(item);
    });
    card.append(items);
    return card;
  }

  function monthlyUnitsCard(rows: Qualquer) {
    const card = element("section", "ck-rel__cartao");
    card.append(element("h4", "ck-rel__cartao-titulo", "Unidades com mais equipamentos"));
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      card.append(element("p", "ck-lista__vazio", "Sem registros neste período."));
      return card;
    }
    const items = element("ol", "ck-rel__unidades");
    (monthlyView.unidadesTodas ? list : list.slice(0, MONTHLY_TOP_UNITS)).forEach(([city, address, total]) => {
      const item = element("li", "ck-rel__unidade");
      const name = element("span", "ck-rel__unidade-nome");
      name.append(element("strong", "", city || "Sem cidade"));
      if (address) name.append(element("span", "ck-mudo", ` · ${address}`));
      item.append(name, monthlyContavel(element("strong", "ck-num", displayCount(total)), total));
      items.append(item);
    });
    card.append(items);
    if (list.length > MONTHLY_TOP_UNITS) {
      const toggle = monthlyButton(monthlyView.unidadesTodas ? "Ver menos" : `Ver todas as ${displayCount(list.length)} unidades`, () => {
        monthlyView.unidadesTodas = !monthlyView.unidadesTodas;
        refreshMonthlySection("base", "[data-rel-unidades]");
      }, { className: "ck-rel__link", arrow: !monthlyView.unidadesTodas });
      toggle.dataset.relUnidades = "";
      toggle.setAttribute("aria-expanded", String(monthlyView.unidadesTodas));
      card.append(toggle);
    }
    return card;
  }

  function monthlyBaseSection(inventory: Qualquer) {
    const section = monthlySection("base", "Base atual", [monthlyBadge("Não muda com o mês")]);
    section.classList.add("ck-rel__atual");
    const duplicates = Array.isArray(inventory.series_duplicadas) ? inventory.series_duplicadas.length : undefined;
    const numbers = element("section", "ck-rel__cartao");
    numbers.append(monthlyNumbers([
      ["Equipamentos", inventory.total], ["Unidades", inventory.unidades],
      ["Linhas sem série", inventory.linhas_sem_serie, inventory.linhas_sem_serie > 0 ? "alerta" : ""],
      ["Séries duplicadas", duplicates, duplicates > 0 ? "alerta" : ""],
    ]));
    numbers.setAttribute("aria-label", "Totais da base atual");
    const grid = element("div", "ck-rel__base-grade");
    grid.append(monthlyCartao(numbers, "", 0), monthlyCartao(monthlyTypesCard(inventory.por_tipo), "", 4), monthlyCartao(monthlyUnitsCard(inventory.por_unidade), "ciano", 5));
    section.append(grid);
    return section;
  }

  const monthlySectionBuilders: Record<string, Funcao> = {
    os: (report: Qualquer) => monthlyCartao(monthlyOsSection(report.os || {}), "ciano"),
    sebrae: (report: Qualquer) => monthlySebraeSection(report),
    base: (report: Qualquer) => monthlyBaseSection(report.inventario || {}),
  };

  // Refaz uma seção (filtro, "Carregar mais", "Ver todas") e devolve o foco ao controle equivalente ou ao título.
  function refreshMonthlySection(key: Qualquer, focusSelector = "") {
    const report = monthlyView.report;
    const current = byId("cockpit-monthly-details")?.querySelector(`[data-rel-secao="${key}"]`);
    if (!report || !current) return;
    const next = monthlySectionBuilders[key](report);
    // filtro e "Carregar mais" não refazem a entrada dos cartões (o da seção e os de dentro dela)
    if (next.dataset) next.dataset.semEntrada = "";
    next.querySelectorAll(".ck-bento-cartao").forEach((cartao: ElementoCockpit) => { cartao.dataset.semEntrada = ""; });
    current.replaceWith(next);
    const target = (focusSelector && next.querySelector(focusSelector)) || (focusSelector ? next.querySelector("h3") : null);
    target?.focus();
  }

  // Total de cada aba com contador, igual ao da lista dela; null (contador oculto) quando a fonte não veio.
  function monthlyTabTotal(report: Qualquer, nome: Qualquer) {
    const source = nome === "os" ? report?.os : sebraeMonthCounts(report);
    return Array.isArray(source?.linhas) ? source.linhas.length : null;
  }

  // OS pede atenção quando há linhas (tom de alerta); Chamados só informa (neutro).
  function renderMonthlyTabCounts(report: Qualquer) {
    ["os", "sebrae"].forEach(nome => {
      const node = byId(`rel-${nome}-contagem`);
      if (!node) return;
      const total = monthlyTabTotal(report, nome);
      node.hidden = total === null;
      node.textContent = total === null ? "" : displayCount(total);
      if (nome !== "sebrae" && total > 0) node.dataset.status = monthlyBadgeStatus.warning;
      else delete node.dataset.status;
    });
  }

  // Cartão "Chamados (F5)" da Visão geral (estático no partial, dentro de #cockpit-monthly-kpis): só os números que existem (sem
  // Dashboard ou com erro, nada de zeros inventados). Abertos no mês e Finalizados; chips "N novos" (âmbar) e "N antigos" (fúcsia).
  function renderMonthlyChamados(report: Qualquer) {
    const month = sebraeMonthCounts(report);
    const data = monthlyView.sebrae;
    const nodes: ElementoCockpit[] = [];
    if (month) nodes.push(monthlyNumbers([["Abertos no mês", month.abertos], ["Finalizados", month.finalizados]]));
    if (!monthlyView.sebraeErro && (data?.importado || data?.novos)) {
      const lists = sebraeOpenLists(data);
      const chips = element("div", "nf8-chamados__chips");
      [["novos", lists.novos.length, "ambar"], ["antigos", lists.antigos.length, "fucsia"]].forEach(([label, value, tone]: Qualquer) => {
        const chip = element("span", "nf8-chip", "");
        chip.dataset.nlTom = tone;
        chip.append(monthlyContavel(element("b", "ck-num", displayCount(value)), value), document.createTextNode(` ${label}`));
        chips.append(chip);
      });
      nodes.push(chips);
    }
    byId("cockpit-monthly-chamados-dados").replaceChildren(...(nodes.length
      ? nodes
      : [element("span", "ck-mudo", monthlyView.sebraeErro || "Nenhum Dashboard importado.")]));
    byId("cockpit-monthly-chamados").hidden = false;
  }

  // Esvazia os painéis (carregando ou troca de mês) sem tocar no invólucro #cockpit-monthly-details nem nos painéis em si.
  function clearMonthlyPanels() {
    byId("cockpit-monthly-movimento").replaceChildren();
    byId("cockpit-monthly-chamados-dados").replaceChildren();
    byId("cockpit-monthly-chamados").hidden = true;
    Object.keys(monthlySectionBuilders).forEach(key => byId(`rel-painel-${key}`).replaceChildren());
    renderMonthlyTabCounts(null);
  }

  function renderMonthly(report: Qualquer) {
    monthlyView.report = report;
    renderMonthlyAttention(report);
    byId("cockpit-monthly-attention").hidden = false;
    byId("cockpit-monthly-estado").replaceChildren();
    byId("cockpit-monthly-movimento").replaceChildren(monthlyCartao(monthlyMovementSection(report), "", 3));
    renderMonthlyChamados(report);
    Object.entries(monthlySectionBuilders).forEach(([key, build]) => byId(`rel-painel-${key}`).replaceChildren(build(report)));
    renderMonthlyTabCounts(report);
    aplicarAbaRelatorio();
    animarPainelRelatorio();
    byId("cockpit-monthly-preview").textContent = monthlyPreviewText(report, monthlyView.sebraeErro ? null : monthlyView.sebrae);
    const period = monthlyPeriodLabel(report);
    const badgeNode = byId("cockpit-monthly-period");
    badgeNode.textContent = period;
    badgeNode.dataset.status = report.mes?.parcial ? "info" : "";
    badgeNode.hidden = false;
    byId("cockpit-monthly-status").textContent = `Relatório de ${report.mes?.label || report.mes?.key || "mês selecionado"} · ${period} · gerado em ${monthlyDate(report.gerado_em) || "data indisponível"}`;
  }

  // `quiet`: recarga depois de importar OS ou de nova comparação; mantém filtros e páginas e não pisca "Carregando".
  async function loadMonthlyReport(month: Qualquer, { quiet = false } = {}) {
    const current = ++monthlyRequest;
    // Carregando e erro vão para #cockpit-monthly-estado: o invólucro dos painéis nunca é esvaziado.
    const target = byId("cockpit-monthly-estado");
    relatorioDesatualizado = false;
    if (!quiet) {
      relatorioMesCarregado = "";
      Object.assign(monthlyView, { report: null, sebrae: null, sebraeErro: "", filtro: "todas", limiteOs: MONTHLY_PAGE, limiteSebrae: MONTHLY_PAGE, unidadesTodas: false, foraAberto: false });
      byId("cockpit-monthly-preview").textContent = "";
      byId("cockpit-monthly-kpis").replaceChildren(byId("cockpit-monthly-chamados"));
      clearMonthlyPanels();
      byId("cockpit-monthly-attention").hidden = true;
      byId("cockpit-monthly-period").hidden = true;
      byId("cockpit-monthly-copy").disabled = true;
      renderMonthlyPeriods(month);
      byId("cockpit-monthly-status").textContent = "Carregando dados do relatório…";
      renderEmpty(target, "Carregando relatório mensal local…");
    }
    // Os chamados do Sebrae são opcionais: falha neles não impede o relatório.
    const sebrae = apiFetch("/api/sebrae/novos", { errorMessage: "Não foi possível consultar os chamados do Sebrae." })
      .then(data => ({ data, error: "" }), error => ({ data: null, error: error?.message || "Não foi possível consultar os chamados do Sebrae." }));
    try {
      const report = await apiFetch(`/api/relatorio-mensal/dados?mes=${encodeURIComponent(month)}`, { errorMessage: "Não foi possível carregar o relatório mensal." });
      const sebraeResult = await sebrae;
      if (current !== monthlyRequest || activeTool !== "relatorio") { relatorioDesatualizado = true; return; }
      const focused = document.activeElement as ElementoCockpit | null;
      const focusedSection = quiet ? focused?.closest?.<ElementoCockpit>("[data-rel-secao]")?.dataset.relSecao : "";
      const focusedAttention = quiet && byId("cockpit-monthly-attention")?.contains(focused);
      monthlyView.sebrae = sebraeResult.data;
      monthlyView.sebraeErro = sebraeResult.error;
      renderMonthly(report);
      relatorioMesCarregado = month;
      byId("cockpit-monthly-copy").disabled = false;
      if (focusedSection) byId(`cockpit-monthly-${focusedSection}-title`)?.focus();
      else if (focusedAttention) byId("cockpit-monthly-attention-title")?.focus();
    } catch (error: Qualquer) {
      relatorioDesatualizado = true;
      if (current !== monthlyRequest || activeTool !== "relatorio") return;
      byId("cockpit-monthly-status").textContent = error.message || "Falha ao carregar o relatório.";
      app.showToast(error.message || "Falha ao carregar o relatório.", "error");
      if (quiet && monthlyView.report) return;
      renderError(target, error, "Falha ao carregar o relatório.");
      byId("cockpit-monthly-preview").textContent = "";
    }
  }

  // Importar OS (F6) ou nova comparação com o F8 aberto: recarrega o mês exibido sem perder filtros.
  function refreshMonthlyAfterChange() {
    if (activeTool !== "relatorio") { relatorioDesatualizado = true; return; }
    const month = byId("cockpit-monthly-month")?.value;
    if (month) void loadMonthlyReport(month, { quiet: true });
  }

  async function copyMonthlyPreview() {
    const text = byId("cockpit-monthly-preview").textContent;
    if (!text) return;
    try {
      await app.copiarTextoParaAreaTransferencia(text);
      byId("cockpit-monthly-status").textContent = "Prévia mensal copiada para a área de transferência.";
      app.showToast("Resumo mensal copiado.", "success");
    } catch (error: Qualquer) {
      byId("cockpit-monthly-status").textContent = error.message || "Não foi possível copiar o resumo.";
      app.showToast(error.message || "Não foi possível copiar o resumo.", "error");
    }
  }

  async function exportMonthlyWorkbook() {
    const month = byId("cockpit-monthly-month").value;
    const input = byId("relatorio-mensal-mes");
    if (!input || !month) return;
    input.value = month;
    const button = byId("cockpit-monthly-export");
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      await app.exportarRelatorioMensal();
      const legacyStatus = byId("status-relatorio-mensal")?.textContent?.trim();
      byId("cockpit-monthly-status").textContent = legacyStatus || "Planilha Exportada com Sucesso!";
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }

  // ---- Telas v2: Atualizar planilhas e Unidades ----
  const historyFormat = context.historyFormat || globalThis.SimpressHistoryFormat || {};

  function displayDate(value: Qualquer) {
    return typeof historyFormat.formatarHorarioHistorico === "function" ? historyFormat.formatarHorarioHistorico(value) : String(value || "—");
  }

  function displaySource(value: Qualquer) {
    const text = String(value || "");
    return text && typeof historyFormat.formatarNomeFonteHistorico === "function" ? historyFormat.formatarNomeFonteHistorico(text) : text;
  }

  function renderPares(target: Qualquer, entries: Qualquer) {
    target.replaceChildren(...entries.map(([label, value]: Qualquer) => {
      const pair = element("div", "ck-par");
      const description = element("dd");
      if (value instanceof Node) description.append(value); // o nó do CNPJ leva o lápis de edição
      else description.textContent = value === null || value === undefined || value === "" ? "—" : String(value);
      pair.append(element("dt", "", label), description);
      return pair;
    }));
  }

  // Linha de tabela; com onSelect vira selecionável por clique, Enter ou Espaço.
  function tableRow(cells: Qualquer, { selected = false, onSelect = null }: { selected?: boolean; onSelect?: Funcao | null } = {}) {
    const row = element("tr");
    if (onSelect) {
      row.tabIndex = 0;
      row.setAttribute("aria-selected", String(selected));
      row.addEventListener("click", onSelect);
      row.addEventListener("keydown", event => {
        // Botões dentro da linha (ex.: lápis do CNPJ) tratam Enter e Espaço sozinhos.
        if (event.target !== row || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        onSelect();
      });
    }
    cells.forEach(([label, content, className]: Qualquer) => {
      const cell = element("td", className || "");
      cell.dataset.label = label;
      cell.append(content instanceof Node ? content : document.createTextNode(String(content ?? "—")));
      row.append(cell);
    });
    return row;
  }

  function tableEmpty(body: Qualquer, columns: Qualquer, message: Qualquer) {
    const cell = element("td", "ck-lista__vazio", message);
    cell.colSpan = columns;
    const row = element("tr");
    row.append(cell);
    body.replaceChildren(row);
  }

  async function fetchUpdateEvents() {
    const data = await apiFetch("/api/historico-comparacoes", { errorMessage: "Não foi possível carregar o histórico de planilhas." });
    return (Array.isArray(data.eventos) ? data.eventos : []).filter((event: Qualquer) => event.id && !event.somente_anotacoes_sincronizadas);
  }

  function inventoryUpdates(events: Qualquer) { return events.filter((event: Qualquer) => event.tipo !== "restauracao"); }

  function eventFiles(event: Qualquer) {
    const files = event?.arquivos_enviados || event?.comparacao?.arquivos_enviados || {};
    return { endpoint: displaySource(files.endpoint), detalhes: displaySource(files.detalhes) };
  }

  // Planilhas
  function renderSheetDetail() {
    const row = sheetsRows.find(item => item.key === selectedSheetKey);
    byId("cockpit-sheets-detail-title").textContent = row ? row.label : "—";
    byId("cockpit-sheets-detail-sub").textContent = row ? (row.file || "Arquivo não informado") : "Selecione uma planilha.";
    byId("cockpit-sheets-detail-badge").replaceChildren(...(row ? [badge(row.situation, row.file ? "success" : "warning")] : []));
  }

  function renderSheetRows() {
    const body = byId("cockpit-sheets-list-body");
    if (!sheetsRows.length) return tableEmpty(body, 5, "Nenhuma atualização no histórico local.");
    body.replaceChildren(...sheetsRows.map(row => tableRow([
      ["Planilha", row.label], ["Arquivo atual", row.file || "—"], ["Linhas", displayCount(row.total), "ck-td--dir"],
      ["Atualizado", displayDate(row.updatedAt)], ["Situação", badge(row.situation, row.file ? "success" : "warning")],
    ], { selected: row.key === selectedSheetKey, onSelect: () => { selectedSheetKey = row.key; renderSheetRows(); renderSheetDetail(); } })));
  }

  async function loadSheets() {
    const request = ++sheetsRequest;
    const status = byId("cockpit-sheets-status");
    status.textContent = "Carregando…";
    renderKpis(byId("cockpit-sheets-kpis"), []);
    tableEmpty(byId("cockpit-sheets-list-body"), 5, "Carregando…");
    try {
      const events = inventoryUpdates(await fetchUpdateEvents());
      if (request !== sheetsRequest || activeTool !== "planilhas") return;
      if (!events.length) {
        sheetsRows = [];
        status.textContent = "Nenhuma atualização no histórico local.";
        renderSheetRows();
        renderSheetDetail();
        return;
      }
      const data = await apiFetch(`/api/historico-comparacoes/${encodeURIComponent(events[0].id)}`, { errorMessage: "Não foi possível abrir a última atualização." });
      if (request !== sheetsRequest || activeTool !== "planilhas") return;
      const latest = data.evento || events[0];
      const metrics = comparisonMetrics(latest);
      const files = eventFiles(latest);
      sheetsRows = [
        { key: "endpoint", label: "No Endpoint", file: files.endpoint, total: metrics.endpoint },
        { key: "detalhes", label: "na Simpress", file: files.detalhes, total: metrics.simpress },
      ].map(row => ({ ...row, updatedAt: latest.horario, situation: row.file ? "Atualizada" : "Sem arquivo" }));
      if (!sheetsRows.some(row => row.key === selectedSheetKey)) selectedSheetKey = sheetsRows[0].key;
      renderKpis(byId("cockpit-sheets-kpis"), [
        ["Última atualização", displayDate(latest.horario)], ["Equipamentos na Simpress", metrics.simpress],
        ["Equipamentos no Endpoint", metrics.endpoint], ["Atualizações no histórico", events.length],
      ]);
      status.textContent = `Última atualização em ${displayDate(latest.horario)}`;
      renderSheetRows();
      renderSheetDetail();
    } catch (error: Qualquer) {
      if (request !== sheetsRequest || activeTool !== "planilhas") return;
      status.textContent = error.message || "Não foi possível carregar as planilhas.";
      tableEmpty(byId("cockpit-sheets-list-body"), 5, status.textContent);
    }
  }

  function ensureEvents() {
    if (eventsBound || typeof document === "undefined") return;
    const root = byId("cockpit-tool-panels");
    if (!root) return;
    byId("cockpit-tickets-search").addEventListener("input", filterTicketTableSoon);
    byId("cockpit-tickets-relation").addEventListener("change", filterTicketTable);
    byId("cockpit-tickets-attention").addEventListener("change", filterTicketTable);
    byId("cockpit-tickets-clear").addEventListener("click", clearTicketFilters);
    byId("cockpit-tickets-triage").addEventListener("click", selectTicketTriage);
    OS_ABAS.forEach((nome, indice) => {
      const aba = byId(`os-aba-${nome}`);
      aba?.addEventListener("click", () => selecionarAbaOs(nome));
      aba?.addEventListener("keydown", evento => {
        const destino = { ArrowRight: indice + 1, ArrowLeft: indice - 1, Home: 0, End: OS_ABAS.length - 1 }[evento.key];
        if (destino === undefined) return;
        evento.preventDefault();
        selecionarAbaOs(OS_ABAS[(destino + OS_ABAS.length) % OS_ABAS.length], { focar: true });
      });
    });
    byId("cockpit-comparison-new").addEventListener("click", openNewComparison);
    byId("cockpit-comparison-event").addEventListener("change", event => {
      selectedComparisonId = String((event.currentTarget as Qualquer).value || "");
      void loadComparisonDetail(selectedComparisonId);
    });
    byId("cockpit-comparison-legacy").addEventListener("click", app.abrirModalHistoricoComparacoes);
    byId("cockpit-alias-search").addEventListener("input", renderAliases);
    byId("cockpit-alias-type").addEventListener("change", renderAliases);
    bindAliasTabs();
    byId("cockpit-alias-filters").addEventListener("click", event => {
      const button = (event.target as ElementoCockpit).closest<ElementoCockpit>("[data-alias-period]");
      if (!button || button.disabled) return;
      selectedAliasPeriod = button.dataset.aliasPeriod;
      renderAliases();
      animarFiltrosAlias();
    });
    byId("cockpit-alias-export").addEventListener("click", exportAliasesCsv);
    byId("cockpit-alias-actions-only").addEventListener("change", () => {
      renderAliases();
      animarFiltrosAlias();
    });
    byId("cockpit-alias-clear").addEventListener("click", () => {
      byId("cockpit-alias-search").value = "";
      byId("cockpit-alias-type").value = "todos";
      byId("cockpit-alias-actions-only").checked = false;
      selectedAliasPeriod = "todos";
      renderAliases();
      animarFiltrosAlias();
    });
    // Sub-abas do F8: setas, Home e End seguem o molde da F6 (circular, ativa ao focar).
    REL_ABAS.forEach((nome, indice) => {
      const aba = byId(`rel-aba-${nome}`);
      aba?.addEventListener("click", () => selecionarAbaRelatorio(nome));
      aba?.addEventListener("keydown", evento => {
        const destino = { ArrowRight: indice + 1, ArrowLeft: indice - 1, Home: 0, End: REL_ABAS.length - 1 }[evento.key];
        if (destino === undefined) return;
        evento.preventDefault();
        selecionarAbaRelatorio(REL_ABAS[(destino + REL_ABAS.length) % REL_ABAS.length], { focar: true });
      });
    });
    byId("cockpit-monthly-chamados-ver")?.addEventListener("click", () => monthlyJump("cockpit-monthly-sebrae-title", "sebrae"));
    byId("cockpit-monthly-month").addEventListener("change", event => loadMonthlyReport((event.currentTarget as Qualquer).value));
    byId("cockpit-monthly-copy").addEventListener("click", copyMonthlyPreview);
    byId("cockpit-monthly-export").addEventListener("click", exportMonthlyWorkbook);
    document.addEventListener("simpress:chamados-atualizados", refreshMonthlyAfterChange);
    document.addEventListener("simpress:painel-atualizado", (event: Qualquer) => {
      // O painel volta a cada 5 min igual: só marca F3/F8 como desatualizados quando a comparação ou o inventário mudou.
      const painel = event.detail || {};
      const chave = [painel.ultima_comparacao?.id, painel.ultima_atualizacao, painel.arquivo_origem].join("|");
      const mudou = chave !== painelChave; // a primeira chave vista conta como mudança: não se sabe com qual o F3/F8 carregou
      painelChave = chave;
      if (mudou) resumoDesatualizado = true;
      if (mudou || activeTool === "relatorio") refreshMonthlyAfterChange();
    });
    // Usuário do equipamento editado (muda o "Sem usuário") ou OS importada: o F3 recarrega na próxima abertura.
    for (const nome of ["simpress:resumo-desatualizado", "simpress:usuarios-equipamento-atualizados", "simpress:chamados-atualizados"]) {
      document.addEventListener(nome, () => { resumoDesatualizado = true; });
    }
    byId("cockpit-sheets-refresh").addEventListener("click", loadSheets);
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape" || event.defaultPrevented || root.hidden) return;
      const modal = document.querySelector('[data-accessible-modal="true"]:not(.hidden)');
      if (!modal) { event.preventDefault(); closePanel(); }
    });
    // O destaque dos botões da barra (Resumo, Chamados e OS) segue o painel, qualquer que seja o caminho que o esconda.
    if (typeof MutationObserver !== "undefined") new MutationObserver(() => {
      if (root.hidden) syncPanelButtons("");
    }).observe(root, { attributes: true, attributeFilter: ["hidden"] });
    eventsBound = true;
  }

  // Botões da barra principal (.ck-aba--painel) ficam pressionados enquanto o painel deles está aberto.
  // O Resumo é uma aba (role="tab") da barra: fica selecionada e a aba que estava ativa fica desmarcada até o painel fechar.
  let suspendedTab: ElementoCockpit | null = null;
  function restoreSuspendedTab() {
    if (!suspendedTab) return;
    suspendedTab.setAttribute("aria-selected", "true");
    suspendedTab.tabIndex = 0;
    suspendedTab.classList.add("is-active");
    suspendedTab = null;
  }
  function syncPanelButtons(tool: Qualquer) {
    document.querySelectorAll(".ck-aba--painel[data-cockpit-tool]").forEach((button: Qualquer) => {
      button.setAttribute("aria-pressed", String(button.dataset.cockpitTool === tool));
    });
    const toolTabs = [...document.querySelectorAll<ElementoCockpit>('[role="tab"][data-cockpit-tool]')];
    const opened = toolTabs.find(tab => tab.dataset.cockpitTool === tool);
    if (!opened) restoreSuspendedTab();
    else if (!suspendedTab) {
      suspendedTab = document.querySelector('#ck-abas [role="tab"][aria-selected="true"]:not([data-cockpit-tool])');
      if (suspendedTab) {
        suspendedTab.setAttribute("aria-selected", "false");
        suspendedTab.tabIndex = -1;
        suspendedTab.classList.remove("is-active");
      }
    }
    toolTabs.forEach(tab => {
      const selected = tab === opened;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      tab.classList.toggle("is-active", selected);
    });
  }

  function closePanel(restoreFocus = true) {
    const root = byId("cockpit-tool-panels");
    syncPanelButtons("");
    if (!root || root.hidden) return;
    root.hidden = true;
    byId("main-content").hidden = false;
    byId("cockpit-tools-dropdown").open = false;
    activeTool = "";
    previousTool = "";
    delete byId("cockpit-tools-dropdown").dataset.activeTool;
    if (restoreFocus && returnTarget?.isConnected) returnTarget.focus();
    else if (restoreFocus) byId("main-content").focus();
    returnTarget = null;
    const skipLink = document.querySelector(".skip-link");
    if (skipLink && skipLinkHref !== null) skipLink.setAttribute("href", skipLinkHref);
    skipLinkHref = null;
  }

  async function openPanel(tool: Qualquer, aba = "") {
    if (!Object.hasOwn(toolInfo, tool)) return;
    ensureEvents();
    const root = byId("cockpit-tool-panels");
    if (!root) return;
    const activeElement = document.activeElement;
    const jaAberto = activeTool === tool;
    if (!activeTool) returnTarget = activeElement?.closest?.(".ck-aba--painel, [data-cockpit-tool]") || byId("cockpit-tools-trigger") || activeElement;
    if (activeTool && activeTool !== tool && !goingBack) previousTool = activeTool;
    activeTool = tool;
    byId("cockpit-tools-dropdown").dataset.activeTool = tool;
    syncPanelButtons(tool);
    byId("main-content").hidden = true;
    const skipLink = document.querySelector(".skip-link");
    if (skipLink) {
      if (skipLinkHref === null) skipLinkHref = skipLink.getAttribute("href") || "#main-content";
      skipLink.setAttribute("href", "#cockpit-tool-title");
    }
    root.hidden = false;
    root.scrollTop = 0; // o cabeçalho rola junto com o painel; cada painel abre no topo
    byId("cockpit-tools-dropdown").open = false;
    byId("cockpit-tool-title").textContent = toolInfo[tool][0];
    byId("cockpit-tool-kbd").textContent = toolKeys[tool] || "";
    byId("cockpit-tool-kbd").hidden = !toolKeys[tool];
    byId("cockpit-tool-subtitle").textContent = toolInfo[tool][1];
    document.querySelectorAll("[data-cockpit-tool-panel]").forEach((panel: Qualquer) => { panel.hidden = panel.dataset.cockpitToolPanel !== tool; });
    byId("cockpit-tool-title").focus();
    if (tool === "chamados") await loadTickets();
    if (tool === "comparacao") {
      // Voltar ao Resumo sem mudança nem pedido de outra aba (resultado novo, série, evento): mantém a tela, sem rede.
      const reaproveitar = resumoCarregado && !resumoDesatualizado && !pendingFreshComparison && !pendingComparisonTarget
        && selectedComparisonId === String(selectedComparison?.id || "");
      // Backups não depende da comparação: abre já (sem esperar a rede) e de novo depois, caso o render a tenha mexido.
      // A primeira abertura do painel volta à Visão Geral (padrão desde 23/11/2026) e um pedido de aba abre a aba pedida direto;
      // `abaPedidaAoAbrir` leva a mesma aba a limparAbasResumo, que roda ao recarregar o histórico, para a Visão Geral não piscar antes dela.
      // Reabrir o painel já aberto sem aba mantém a aba atual. Quem precisa de uma lista (alerta de divergências, sino) passa a aba em `aba`.
      if (aba === "backups") app.selecionarAbaResumo?.("backups");
      else if (aba || !jaAberto) app.selecionarAbaResumo?.(aba || "visao-geral");
      if (reaproveitar) {
        if (aba && aba !== "backups" && document.querySelector("#comparacao-planilhas-conteudo [data-resumo-painel]")) app.selecionarAbaResumo?.(aba);
        return;
      }
      app.invalidarSemUsuarioResumo?.();
      const ativos = app.carregarResumoAtivos?.();
      const pedido = comparisonRequest + 1; // loadComparisons incrementa para este valor
      abaPedidaAoAbrir = aba || (pendingComparisonTarget ? "divergencias" : "");
      try { await loadComparisons(); } finally { abaPedidaAoAbrir = ""; }
      await ativos;
      // O render acima volta à Visão Geral (limparAbasResumo) se a aba pedida não vale sem comparação; a aba pedida (ex.: sino) vale depois dele,
      // só se nenhuma abertura mais nova começou e se há painéis (sem comparação, fica onde estava).
      if (aba === "backups") {
        if (pedido === comparisonRequest && activeTool === "comparacao") app.selecionarAbaResumo?.("backups");
      } else if (aba && pedido === comparisonRequest && activeTool === "comparacao"
        && document.querySelector("#comparacao-planilhas-conteudo [data-resumo-painel]")) app.selecionarAbaResumo?.(aba);
    }
    if (tool === "apelidos") await loadAliases();
    if (tool === "relatorio") {
      const input = byId("cockpit-monthly-month");
      if (!input.value) input.value = currentMonth();
      input.max = currentMonth();
      // Mesmo mês já na tela: sem mudança, nada a buscar; com mudança, recarga discreta (mantém filtros, sem "Carregando").
      if (relatorioMesCarregado !== input.value) {
        renderMonthlyPeriods(input.value);
        await loadMonthlyReport(input.value);
      } else if (relatorioDesatualizado) await loadMonthlyReport(input.value, { quiet: true });
    }
    if (tool === "planilhas") await loadSheets();
    if (tool === "cobertura") await app.carregarCobertura?.();
    if (tool === "lembretes") {
      app.termosSelecionarAba?.(aba || "lembretes");
      await app.carregarLembretes?.();
    }
    if (tool === "unidades") {
      app.toggleFormNovaUnidade?.(false);
      // Painel em React (frontend/src/paineis/unidades/).
      await app.recarregarUnidadesCockpit();
    }
  }

  // "OS deste equipamento" (Transporte): abre Chamados já filtrado pela série; a busca filtra a tabela de OS.
  function abrirChamadosDoEquipamento() {
    return openSerialInTickets(byId("transfer-serial")?.textContent);
  }

  // Botão da OS (tabela de Chamados): garante o painel aberto, mostra a linha da OS, abre o Andamento da série e destaca.
  async function abrirChamadoDaOs(_fontes: Qualquer, serie: Qualquer, os: Qualquer) {
    if (activeTool !== "chamados") await openPanel("chamados");
    const host = byId("cockpit-tickets-os");
    const chave = (valor: Qualquer) => String(valor || "").replace(/\s+/g, "").toUpperCase();
    const findRow = () => [...host.querySelectorAll<ElementoCockpit>("tbody tr[data-serial]")]
      .find(row => (!serie || chave(row.dataset.serial) === chave(serie)) && (!os || row.dataset.os === String(os)));
    let row = findRow();
    // Aberta agora pela Home, a tabela ainda está carregando: espera a linha aparecer (até ~3 s).
    for (let tentativa = 0; !row && tentativa < 30; tentativa += 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
      row = findRow();
    }
    // Escondida só pela página ("Carregar mais"): amplia a página; escondida pelo filtro: limpa os filtros e amplia.
    if (row?.hidden && !dataPanels()?.revelarLinhaOs?.(row)) {
      clearTicketFilters();
      row = findRow();
      if (row?.hidden) dataPanels()?.revelarLinhaOs?.(row);
    }
    if (!row) return;
    const toggle = [...host.querySelectorAll<ElementoCockpit>(".ck-os__andamento-btn")].find(button => button.dataset.serie === row.dataset.serial);
    if (toggle?.getAttribute("aria-expanded") !== "true") toggle?.click();
    destacarLinhaCockpit(row);
  }

  // Janela "Chamado × OS" (botão da OS no cartão do F5): chamado à esquerda, OS à direita, tudo só leitura.
  // Aceita só o número do chamado (série e OS vêm do cartão) ou série + OS. Dois ganchos opcionais, usados pelos links
  // dos lembretes: `resolver` (antes do cartão) completa chamado/série/OS ou traz `avisoChamado`; `reservaOs`
  // (depois do cartão, só se faltou OS) devolve `{ os, serie }` ou `{ aviso }`. Lado sem conteúdo fica vazio (o CSS o esconde).
  let janelaChamadoOs: { pedido: number; gatilho: ElementoCockpit | null; chamado: string } = { pedido: 0, gatilho: null, chamado: "" };
  async function abrirJanelaChamadoOs(
    { chamado = "", serie = "", os = "", resolver = null, reservaOs = null }: { chamado?: Qualquer; serie?: Qualquer; os?: Qualquer; resolver?: Funcao | null; reservaOs?: Funcao | null } = {},
    gatilho: ElementoCockpit | null = null,
  ) {
    const pedido = janelaChamadoOs.pedido + 1;
    janelaChamadoOs = { pedido, gatilho, chamado: String(chamado || "") };
    const hostChamado = byId("chamado-os-janela-chamado");
    const hostOs = byId("chamado-os-janela-os");
    const linkF6 = byId("chamado-os-janela-f6");
    hostChamado.replaceChildren(element("p", "ck-lista__vazio", "Carregando…"));
    hostOs.replaceChildren(element("p", "ck-lista__vazio", "Carregando…"));
    linkF6.hidden = true;
    app.abrirModalAcessivel("modal-chamado-os", "#chamado-os-janela-fechar", "fecharJanelaChamadoOs");
    // Um gancho que falha não derruba a janela: segue só com o que foi pedido.
    const chamarGancho = async (gancho: Qualquer, ...args: Qualquer[]) => { try { return (await gancho(...args)) || {}; } catch (_) { return {}; } };
    let dados = { chamado: String(chamado || ""), serie: String(serie || ""), os: String(os || ""), avisoChamado: "" };
    if (resolver) {
      const achado = await chamarGancho(resolver);
      if (pedido !== janelaChamadoOs.pedido) return;
      dados = { ...dados, ...Object.fromEntries(["chamado", "serie", "os", "avisoChamado"].filter(chave => achado[chave]).map(chave => [chave, String(achado[chave])])) };
    }
    const cartao = dados.chamado ? await app.cartaoChamadoSebraeLeitura?.(dados.chamado) : null;
    if (pedido !== janelaChamadoOs.pedido) return;
    if (cartao) hostChamado.replaceChildren(cartao);
    else if (dados.chamado) renderEmpty(hostChamado, "Chamado não encontrado na aba Chamados (F5).");
    else if (dados.avisoChamado) renderEmpty(hostChamado, dados.avisoChamado);
    else hostChamado.replaceChildren();
    // "—" no cartão do F5 é "sem OS"; a série do cartão só acompanha a OS do próprio cartão.
    const osCartao = String(cartao?.dataset.os || "").replace(/^—$/, "");
    const alvo = dados.os ? { serie: dados.serie, os: dados.os }
      : { serie: dados.serie || (osCartao ? String(cartao?.dataset.serie || "") : ""), os: osCartao };
    if (!alvo.os && reservaOs && dados.chamado) {
      // A OS do cartão do F5 vence; só sem ela vale o vínculo salvo.
      const reserva = await chamarGancho(reservaOs, dados.chamado);
      if (pedido !== janelaChamadoOs.pedido) return;
      if (reserva.os) { alvo.os = String(reserva.os); alvo.serie = String(reserva.serie || dados.serie || ""); }
      else if (reserva.aviso) return renderEmpty(hostOs, String(reserva.aviso));
    }
    if (!alvo.os) {
      // Chamado que nem existe na F5 e sem OS: só o aviso à esquerda; com o cartão, a frase de sempre.
      if (cartao || !dados.chamado) renderEmpty(hostOs, "Nenhuma OS vinculada por série na importação atual.");
      else hostOs.replaceChildren();
      return;
    }
    let relatorio: Qualquer = null;
    hostOs.replaceChildren(); // montarTabelaOs acrescenta a tabela: tira o "Carregando…" antes
    const section = dataPanels()?.montarTabelaOs?.(hostOs, {
      semBusca: true, soOs: { ...alvo, chamado: dados.chamado, ...(resolver || reservaOs ? { lembrete: true } : {}) }, somenteLeitura: true,
      aoCarregar: (report: Qualquer) => { relatorio = report; },
      aoExpandirSerie: (serieLinha: Qualquer, cell: Qualquer) => renderTicketDetail(
        (Array.isArray(relatorio?.chamados) ? relatorio.chamados : []).find((record: Qualquer) => String(record.serie || "") === serieLinha),
        cell, { snapshotId: relatorio?.snapshot_id || "", somenteLeitura: true }),
    });
    linkF6.hidden = false;
    // Vai para a aba OS com a grafia da linha (série/OS como no relatório), senão com a pedida.
    linkF6.onclick = () => {
      const row = section?.querySelector("tbody tr[data-serial]");
      fecharJanelaChamadoOs();
      return abrirChamadoDaOs([], row?.dataset.serial || alvo.serie, row?.dataset.os || alvo.os);
    };
  }

  function fecharJanelaChamadoOs() {
    const { gatilho, chamado } = janelaChamadoOs;
    janelaChamadoOs = { pedido: janelaChamadoOs.pedido + 1, gatilho: null, chamado: "" };
    app.fecharModalAcessivel("modal-chamado-os");
    byId("chamado-os-janela-chamado").replaceChildren();
    byId("chamado-os-janela-os").replaceChildren();
    // A F5, a F6 ou a lista de Lembretes pode ter se redesenhado com a janela aberta: o foco volta ao botão equivalente.
    const seletorGatilho = [".ticket-os-link-goto", ".lembretes__ref"].find(seletor => gatilho?.matches?.(seletor));
    if (gatilho && !gatilho.isConnected && seletorGatilho) {
      const args = gatilho.getAttribute("data-args");
      [...document.querySelectorAll<ElementoCockpit>(`button${seletorGatilho}`)].find(botao => botao.getAttribute("data-args") === args)?.focus();
    } else if (gatilho && !gatilho.isConnected && chamado) {
      const artigo = [...document.querySelectorAll<ElementoCockpit>("article.sebrae-chamado[data-numero]")].find(item => item.dataset.numero === chamado);
      const destino = artigo?.querySelector<ElementoCockpit>(".sebrae-chamado__os");
      if (destino && !destino.closest("details:not([open])")) destino.focus();
      else artigo?.closest("details")?.querySelector<ElementoCockpit>("summary")?.focus();
    }
  }

  // Link de um lembrete (Ferramentas > Lembretes): abre a janela Chamado × OS sem trocar de aba. Só GETs que já existem
  // (vínculos de OS e /api/sebrae/novos); falha de leitura segue só com o que foi pedido, sem quebrar a janela.
  const lerSemFalhar = (url: Qualquer, mensagem: Qualquer) => apiFetch(url, { errorMessage: mensagem }).catch(() => null);
  const lerVinculosOs = () => lerSemFalhar("/api/operacoes/chamados/vinculos-os", "Não foi possível consultar os vínculos de OS.").then(dados => dados?.vinculos || []);
  function abrirReferenciaLembrete({ tipo, numero }: Registro = {}, gatilho: ElementoCockpit | null = null) {
    const alvo = String(numero || "");
    if (!alvo) return undefined;
    if (tipo === "chamado") {
      // A OS do cartão do F5 vence (a janela a usa); sem ela, o vínculo salvo pelo chamado exato.
      const reservaOs = async (chamado: Qualquer) => {
        const achado = osDoChamado(chamado, { vinculos: await lerVinculosOs() });
        if (achado?.ambiguo) return { aviso: `Mais de uma OS ligada a este chamado (${achado.ambiguo.join(", ")}). Abra pela aba OS (F6).` };
        return achado ? { os: achado.os, serie: achado.serie } : null;
      };
      return abrirJanelaChamadoOs({ chamado: alvo, reservaOs }, gatilho);
    }
    if (tipo !== "os") return undefined;
    const resolver = async () => {
      const [vinculos, sebrae] = await Promise.all([lerVinculosOs(), lerSemFalhar("/api/sebrae/novos", "Não foi possível consultar os chamados do Sebrae.")]);
      const achado = chamadoDaOs(alvo, { vinculos, sebrae });
      if (achado?.ambiguo) return { avisoChamado: `OS ligada a mais de um chamado (${achado.ambiguo.join(", ")}).` };
      return achado ? { chamado: achado.chamado, serie: achado.serie } : null;
    };
    return abrirJanelaChamadoOs({ os: alvo, resolver }, gatilho);
  }

  // Voltar: retorna ao painel aberto antes; sem anterior (ou com restoreFocus=false) fecha para a tela principal.
  function goBack(restoreFocus = true) {
    const target = previousTool;
    if (target && restoreFocus !== false) {
      previousTool = "";
      goingBack = true;
      const opened = openPanel(target);
      goingBack = false;
      return opened;
    }
    return closePanel(restoreFocus);
  }

  return {
    abrirPainelCockpit: openPanel,
    abrirComparacaoDaSerie,
    abrirChamadosDoEquipamento,
    abrirChamadoDaOs,
    abrirJanelaChamadoOs,
    abrirReferenciaLembrete,
    fecharJanelaChamadoOs,
    destacarLinhaCockpit,
    fecharPainelCockpit: goBack,
    filterTicketRecords,
    mostrarResultadoNaAbaComparacao,
    comparisonMetrics,
    aliasMetrics,
    aliasDayLabel,
    monthlyPreviewText,
    sebraeOpenLists,
    sebraeMonthMatch,
  };
}
