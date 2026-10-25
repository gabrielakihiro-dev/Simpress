const test = require("node:test");
const {
  assert,
  appScript,
  appHtml,
  appCss,
  createAppHarness,
  apiResponse,
} = require("./support/inventory-harness.cjs");

test("filters comparison history while preserving row-level annotation autosave", () => {
  assert.doesNotMatch(appHtml, /id="modal-central-pendencias"/);
  assert.match(appScript, /data-history-filter-search/);
  assert.match(appScript, /data-history-filter-category/);
  assert.match(appScript, /data-history-filter-annotated/);
  assert.match(appScript, /history-row-annotated/);
  assert.match(appScript, /\/anotacoes\/\$\{encodeURIComponent\(targetItemId\)\}/);
});

test("compares two complete inventory updates and annotates each source row in the evolution view", () => {
  assert.match(appHtml, /id="modal-evolucao-atualizacoes"/);
  assert.match(appHtml, /id="evolucao-anterior"/);
  assert.match(appHtml, /id="evolucao-atual"/);
  assert.match(appScript, /\/api\/operacoes\/evolucao\?/);
  assert.match(appScript, /"Deixaram de aparecer"/);
  assert.match(appScript, /data-evolution-event/);
  assert.match(appScript, /renderizarAnotacaoOperacional\(item/);
});

test("imports Simpress and Oracle files and displays the serial-to-OS reconciliation", async () => {
  const requests = [];
  const report = {
    fontes: { simpress: { arquivo: "pedidos.xlsx" }, oracle: { arquivo: "solicitacoes.xlsx" } },
    resumo: { series_total: 1, conferidas: 1, divergentes: 0, sem_os: 0, somente_simpress: 0, somente_oracle: 0 },
    chamados: [{
      serie: "SERIE-1", relacao: "conferida", ordens_servico_conferidas: ["7285070"],
      simpress: { pedidos: ["PED-1"], ordens_servico: ["7285070"], chamados_cliente: [], status: ["Em atendimento"] },
      oracle: [{ solicitacao: "REQ-1", ordem_servico: "7285070", status: "Em execução", sub_status: "Pendente", fila: "Fila A", fase_atendimento: "Atendimento em campo", status_entregas: "Sem entregas", status_atividades: "Atividades pendentes" }],
    }],
  };
  const harness = createAppHarness(async (url, options) => {
    requests.push({ url, options });
    return apiResponse(report);
  });
  harness.element("arquivo-chamados-simpress").files = [{ name: "pedidos.xlsx" }];
  harness.element("arquivo-chamados-oracle").files = [{ name: "solicitacoes.xlsx" }];
  await harness.run("importarPlanilhasChamados({ preventDefault() {} })");

  assert.equal(requests[0].url, "/api/operacoes/chamados/importar");
  assert.equal(requests[0].options.method, "POST");
  assert.deepEqual(requests[0].options.body.fields.map(([name, file]) => [name, file.name]), [
    ["simpress_file", "pedidos.xlsx"], ["oracle_file", "solicitacoes.xlsx"],
  ]);
  const modal = harness.element("modal-acompanhamento-chamados");
  const ticketCards = harness.element("lista-acompanhamento-chamados").innerHTML;
  assert.ok(appHtml.includes('id="modal-acompanhamento-chamados"'));
  assert.match(appHtml, /href="https:\/\/simpress\.custhelp\.com\/AgentWeb\/" target="_blank" rel="noopener noreferrer"[^>]*aria-label="Abrir portal Oracle AgentWeb"/);
  assert.match(appHtml, /href="https:\/\/ux\.simpress\.com\.br\/equipamentos\/acompanhamento" target="_blank" rel="noopener noreferrer"[^>]*aria-label="Abrir acompanhamento de chamados Simpress"/);
  assert.equal((appHtml.match(/class="ticket-agent-link[^>]*"/g) || []).length, 2);
  assert.match(appHtml, /id="conteudo-acompanhamento-chamados"[^>]*overflow-y-auto/);
  assert.match(appHtml, /Acompanhamento de Chamados/);
  assert.match(ticketCards, /OS conferida/);
  assert.match(ticketCards, /7285070/);
  assert.match(ticketCards, /REQ-1/);
  // The current Oracle OS is highlighted only once, at the top of the card.
  assert.doesNotMatch(ticketCards, /text-lg font-bold leading-none text-violet-100/);
  assert.equal((ticketCards.match(/<strong>7285070<\/strong>/g) || []).length, 2);
  assert.match(ticketCards, /class="ticket-oracle-request"[\s\S]*Solicitação REQ-1[\s\S]*OS <span class="font-mono text-fg-secondary">7285070/);
  assert.doesNotMatch(ticketCards, /<section class="[^"]*rounded-lg border/);
  assert.match(ticketCards, /class="ticket-card-identifier border src-simpress-soft"/);
  assert.match(ticketCards, /class="ticket-card-identifier border src-oracle-soft"/);
  assert.equal(modal.id, "modal-acompanhamento-chamados");
});

test("provides Endpoint and Simpress shortcuts in the spreadsheet update dialog", () => {
  assert.match(appHtml, /id="modal-atualizar-planilhas"/);
  assert.ok(appHtml.includes('href="https://centralendpoint.pr.sebrae.com.br/webclient#/uems/inventory/computers" target="_blank" rel="noopener noreferrer"'));
  assert.ok(appHtml.includes('href="https://ux.simpress.com.br/MeusEquipamentos/Index" target="_blank" rel="noopener noreferrer"'));
  assert.match(appHtml, /spreadsheet-source-link--endpoint[^>]*aria-label="Abrir inventário de computadores do Endpoint Central"/);
  assert.match(appHtml, /spreadsheet-source-link--simpress[^>]*aria-label="Abrir Meus Equipamentos da Simpress"/);
  assert.equal((appHtml.match(/class="spreadsheet-source-link spreadsheet-source-link--/g) || []).length, 2);
  assert.match(appCss, /\.spreadsheet-source-link:focus-visible/);
});

test("opens ticket import controls only when there are no imported calls", () => {
  const harness = createAppHarness(async () => apiResponse({}));
  const managementPanel = harness.element("painel-dados-acompanhamento-chamados");
  managementPanel.open = false;
  harness.context.ticketTestReport = { resumo: {}, chamados: [] };
  harness.run("SimpressApp.state.acompanhamentoChamadosAtual = ticketTestReport; renderizarAcompanhamentoChamados()");

  assert.equal(managementPanel.open, true);
  assert.match(appHtml, /id="filtro-acompanhamento-chamados"/);
  assert.match(appHtml, /id="btn-exportar-acompanhamento-chamados"[^>]*>Exportar Excel/);
  assert.match(appHtml, /class="ticket-filter-toolbar"/);
  assert.doesNotMatch(appHtml, /Filtros avançados|relacao-acompanhamento-chamados|status-acompanhamento-chamados|fila-acompanhamento-chamados|cidade-acompanhamento-chamados|atendimento-acompanhamento-chamados|idade-acompanhamento-chamados/);
  assert.match(appHtml, /id="painel-dados-acompanhamento-chamados" class="ticket-disclosure[^>]*>/);
  assert.match(appCss, /\.ticket-filter-action\s*\{[^}]*width: auto;[^}]*min-height: 2\.25rem;/);
});

test("shows Simpress product and city while gating delivery address by order status", () => {
  const harness = createAppHarness(async () => apiResponse({}));
  harness.context.ticketTestReport = {
    fontes: {},
    resumo: { series_total: 2, conferidas: 0, divergentes: 0, sem_os: 0, somente_simpress: 2, somente_oracle: 0 },
    chamados: [
      {
        serie: "SN-ATIVO", relacao: "conferida", ordens_servico_conferidas: ["7124895", "7134662"], alertas_relacao: [{ mensagem: "Pedido com possíveis duplicidades" }], oracle: [{
          solicitacao: "REQ-77", ordem_servico: "7134662", status: "Em execução", fila: "Fila A",
          logradouro: "R Caeté", numero_endereco: "150", bairro: "Prado Velho", cidade: "Curitiba", atendido_pela_inibicao: "Não", nome_filial: "SIMPRESS - PR",
          ultima_atualizacao: "09/10/2026 14:15",
          descricao: `Solicito suporte para este equipamento. ${"Detalhe técnico importante. ".repeat(8)}<script>alert('x')</script>`,
        }, { solicitacao: "REQ-76", ordem_servico: "7124895", status: "Concluído", fila: "Fila A" }],
        simpress: {
          pedidos: ["48076976"], ordens_venda: ["OV_15799764"], ordens_servico: ["7124895", "7134662"], chamados_cliente: ["Não informado", ""], status: ["Verificação de estoque"],
          descricoes_produto: ["Notebook HP ProBook"], previsoes_entrega: ["2026-09-28"], cidades_entrega: ["Curitiba"],
          enderecos_entrega: ["Rua das Flores, 123, Curitiba - PR"], pedido_em_andamento: true,
        },
      },
      {
        serie: "SN-ENTREGUE", relacao: "somente_simpress", ordens_servico_conferidas: [], oracle: [],
        simpress: {
          pedidos: ["48076977"], ordens_servico: ["7232036"], status: ["Pedido entregue"], chamados_cliente: ["INC-77"],
          previsoes_entrega: ["15/09/2026"],
          descricoes_produto: ["Monitor HP"], cidades_entrega: ["Maringá"],
          enderecos_entrega: [], pedido_em_andamento: false,
        },
      },
    ],
  };
  harness.run("SimpressApp.state.acompanhamentoChamadosAtual = ticketTestReport; renderizarAcompanhamentoChamados()");
  const cards = harness.element("lista-acompanhamento-chamados").innerHTML;
  const activeCard = cards.split('data-ticket-serial="SN-ATIVO"')[1].split("</article>")[0];
  const activeSummary = activeCard.split('<details class="ticket-disclosure mt-3')[0];
  assert.match(activeSummary, /OS Simpress/);
  assert.match(activeSummary, /OS Oracle/);
  assert.match(activeSummary, /7134662/);
  assert.match(activeSummary, /Pedido<\/b> 48076976/);
  assert.match(activeSummary, /OV_15799764/);
  assert.match(activeSummary, /Status Simpress/);
  assert.match(activeSummary, /Fila: Fila A/);
  assert.match(activeSummary, /Cidade: Curitiba/);
  assert.match(activeSummary, /Atendimento: Simpress/);
  assert.doesNotMatch(activeSummary, /Atualização:/);
  assert.match(activeSummary, /title="Sem atualização há[^"]*">Sem atualização há/);
  assert.doesNotMatch(activeSummary, /Descrição do produto|Endereço de entrega|Série em/);
  assert.doesNotMatch(activeSummary, /REQ-77|R Caeté/);
  assert.match(activeCard, /data-ticket-section="details"/);
  assert.match(activeCard, /Descrição do produto: Notebook HP ProBook/);
  assert.match(activeCard, /Cidade de entrega: Curitiba/);
  assert.match(activeSummary, /Previsão de entrega<\/b> 28\/09\/2026/);
  assert.match(activeCard, /ticket-stage is-forecast[^>]*>.*?Previsão de entrega.*?28\/09\/2026/s);
  assert.match(activeCard, /ticket-stage is-pending[^>]*>.*?Liberação do pedido.*?Não informado na planilha/s);
  assert.match(activeCard, /Endereço de entrega: Rua das Flores, 123, Curitiba - PR/);
  assert.doesNotMatch(activeCard, /data-ticket-section="conference"|Conferência das relações|Revisar relação/);
  assert.match(activeSummary, /OS conferida/);
  assert.match(activeCard, /data-ticket-section="timeline"/);
  assert.match(activeCard, /Linha do tempo e anotações/);
  const oracleCards = activeCard.split("Oracle · solicitações e OS")[1];
  assert.ok(oracleCards.indexOf("7134662") < oracleCards.indexOf("7124895"));
  assert.match(oracleCards, /Endereço: R Caeté, 150, Prado Velho, Curitiba/);
  assert.match(oracleCards, /Atendido pela inibição: Não/);
  assert.match(oracleCards, /Atendimento por: SIMPRESS - PR/);
  assert.ok(oracleCards.includes(`Atualizado ${harness.run('formatarHorarioHistorico("09/10/2026 14:15")')}`));
  assert.match(cards, /<details class="ticket-oracle-description"><summary class="text-xs">/);
  // The description summary uses the same 12px scale as the other summaries in the card.
  const descriptionSummaryCss = appCss.match(/\.ticket-oracle-description > summary \{([^}]*)\}/)[1];
  assert.match(descriptionSummaryCss, /font-size: 0\.75rem;/);
  assert.doesNotMatch(descriptionSummaryCss, /min-height/);
  assert.doesNotMatch(cards, /text-\[(9|10)px\]/);
  assert.match(cards, /Descrição do chamado/);
  assert.match(cards, /⌄ Expandir/);
  assert.ok(cards.includes("&lt;script&gt;alert(&#039;x&#039;)&lt;/script&gt;"));
  assert.doesNotMatch(cards, /<script>alert\('x'\)<\/script>/);
  assert.match(appCss, /\.ticket-oracle-description-content[\s\S]*max-height: 12rem; overflow: auto/);
  assert.match(appCss, /\.ticket-disclosure > summary:focus-visible/);
  assert.match(appCss, /\.ticket-card-meta > span:not\(:first-child\)::before,\s*\.ticket-card-triage > span:not\(:first-child\)::before\s*\{\s*content: "•";/);
  assert.match(appHtml, /id="painel-dados-acompanhamento-chamados"/);
  assert.doesNotMatch(appHtml, /Filtros avançados|filtros-avancados-acompanhamento-chamados/);
  assert.doesNotMatch(cards, /Chamado do cliente: Não informado/);
  const deliveredCard = cards.split('data-ticket-serial="SN-ENTREGUE"')[1].split("</article>")[0];
  assert.match(deliveredCard, /Descrição do produto: Monitor HP/);
  assert.match(deliveredCard, /Cidade de entrega: Maringá/);
  assert.match(deliveredCard, /ticket-stage is-forecast[^>]*>.*?Previsão de entrega.*?15\/09\/2026/s);
  assert.match(deliveredCard, /Chamado do cliente: INC-77/);
  assert.doesNotMatch(deliveredCard, /Endereço de entrega:/);
  const deliveredSummary = deliveredCard.split('<details class="ticket-disclosure mt-3')[0];
  assert.match(deliveredSummary, /OS Oracle<\/span><strong class="is-empty">Sem OS<\/strong>/);
  assert.doesNotMatch(deliveredSummary.replace(/<details[\s\S]*?<\/details>/, ""), /Não informad|Fila:|<b>Oracle<\/b>/);
  assert.match(activeCard, /<details class="ticket-disclosure ticket-stages-disclosure[^"]*" data-ticket-section="stages"><summary[^>]*>Etapas do pedido/);
});

test("sorts ticket cards by descending OS and leaves tickets without an OS at the end", () => {
  const harness = createAppHarness(async () => apiResponse({}));
  const ticket = (serie, order, source = "simpress") => ({
    serie,
    relacao: order ? "conferida" : "sem_os",
    ordens_servico_conferidas: order ? [order] : [],
    simpress: { ordens_servico: source === "simpress" && order ? [order] : [] },
    oracle: order && source === "oracle" ? [{ ordem_servico: order, status: "Em execução" }] : [],
  });
  harness.context.ticketTestReport = {
    fontes: {},
    resumo: { series_total: 4, conferidas: 3, divergentes: 0, sem_os: 1, somente_simpress: 0, somente_oracle: 0 },
    chamados: [
      ticket("SN-7265402", "7265402"),
      ticket("SN-SEM-OS", ""),
      ticket("SN-7279280", "7279280", "oracle"),
      ticket("SN-7279287", "7279287"),
    ],
  };

  harness.run("SimpressApp.state.acompanhamentoChamadosAtual = ticketTestReport; renderizarAcompanhamentoChamados()");

  const serials = [...harness.element("lista-acompanhamento-chamados").innerHTML.matchAll(/data-ticket-serial="([^"]+)"/g)]
    .map(match => match[1]);
  assert.deepEqual(serials, ["SN-7279287", "SN-7279280", "SN-7265402", "SN-SEM-OS"]);
  assert.match(harness.element("contagem-acompanhamento-chamados").textContent, /^4 de 4 séries$/);
});

test("keeps the three-day attention rule and removes advanced ticket filters", () => {
  const harness = createAppHarness(async () => apiResponse({}));
  assert.equal(harness.run('dataAtualizacaoChamado("2026-10-09").getDate()'), 9);
  assert.equal(harness.run('dataAtualizacaoChamado("2026-10-09T00:00:00Z").getDate()'), 9);
  assert.equal(harness.run('dataAtualizacaoChamado("09/10/2026").getMonth()'), 9);
  const expectedOracleUpdate = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "medium" })
    .format(new Date(2026, 9, 9, 14, 15));
  assert.equal(harness.run('formatarHorarioHistorico("09/10/2026 14:15")'), expectedOracleUpdate);
  assert.equal(harness.run('formatarHorarioHistorico("2026-10-09")'), new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "medium" }).format(new Date(2026, 9, 9)));
  const localDateOffset = days => {
    const value = new Date();
    value.setHours(12, 0, 0, 0);
    value.setDate(value.getDate() - days);
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  };
  const fresh = localDateOffset(0);
  const exactlyThreeDaysOld = localDateOffset(3);
  assert.equal(harness.run('classificarAtencaoChamado({ oracle: [{ status: "Em execução", ultima_atualizacao: "' + exactlyThreeDaysOld + '" }] }, 30).em_atencao'), true);
  harness.context.ticketTestReport = {
    fontes: {},
    resumo: { series_total: 7, conferidas: 3, divergentes: 1, sem_os: 1, somente_simpress: 1, somente_oracle: 1 },
    chamados: [
      { serie: "SN-FRESCA", relacao: "conferida", simpress: {}, oracle: [{ status: "Em execução", fila: "Fila A", ultima_atualizacao: fresh }] },
      { serie: "SN-ATRASADA", relacao: "conferida", simpress: {}, oracle: [{ status: "Em execução", fila: "Fila B", ultima_atualizacao: "2000-01-01" }] },
      { serie: "SN-DIVERGENTE", relacao: "divergente", simpress: {}, oracle: [{ status: "Em execução", fila: "Fila C", ultima_atualizacao: fresh }] },
      { serie: "SN-LIMITE-3-DIAS", relacao: "conferida", simpress: {}, oracle: [{ status: "Em execução", fila: "Fila E", ultima_atualizacao: exactlyThreeDaysOld }] },
      { serie: "SN-SEM-OS", relacao: "sem_os", simpress: {}, oracle: [{ status: "Em execução", fila: "Fila F", ultima_atualizacao: fresh }] },
      { serie: "SN-SOMENTE-SIMPRESS", relacao: "somente_simpress", simpress: {}, oracle: [] },
      { serie: "SN-FECHADA", relacao: "conferida", simpress: {}, oracle: [{ status: "Concluído", fila: "Fila D", ultima_atualizacao: "2000-01-01" }] },
    ],
  };
  harness.run("SimpressApp.state.acompanhamentoChamadosAtual = ticketTestReport");
  harness.run("renderizarAcompanhamentoChamados()");

  harness.run("SimpressApp.state.acompanhamentoChamadosAtual = { chamados: [] }; renderizarAcompanhamentoChamados()");
  assert.match(harness.element("lista-acompanhamento-chamados").innerHTML, /Nenhum chamado para exibir\./);
  harness.run("SimpressApp.state.acompanhamentoChamadosAtual = ticketTestReport");

  harness.element("somente-atencao-chamados").checked = true;
  harness.run("renderizarAcompanhamentoChamados()");
  const visible = harness.element("lista-acompanhamento-chamados").innerHTML;
  assert.match(visible, /SN-ATRASADA/);
  assert.match(visible, /SN-LIMITE-3-DIAS/);
  assert.doesNotMatch(visible, /SN-DIVERGENTE/);
  assert.doesNotMatch(visible, /SN-SEM-OS/);
  assert.doesNotMatch(visible, /SN-SOMENTE-SIMPRESS/);
  assert.doesNotMatch(visible, /SN-FRESCA/);
  assert.doesNotMatch(visible, /SN-FECHADA/);
  assert.match(appHtml, /id="versao-acompanhamento-chamados"/);
  assert.doesNotMatch(appHtml, /Filtros avançados|relacao-acompanhamento-chamados|status-acompanhamento-chamados|fila-acompanhamento-chamados|cidade-acompanhamento-chamados|atendimento-acompanhamento-chamados|idade-acompanhamento-chamados/);
  assert.match(appHtml, /id="triagem-diaria-acompanhamento-chamados"/);
  assert.doesNotMatch(appHtml, /id="limite-desatualizacao-chamados"/);
  assert.match(appHtml, /id="evolucao-acompanhamento-chamados"/);
  assert.match(appScript, /\/api\/operacoes\/chamados\/evolucao\?/);
});

test("keeps city, queue, and provider visible in ticket cards without advanced filters", () => {
  const harness = createAppHarness(async () => apiResponse({}));
  harness.context.ticketTestReport = {
    fontes: {}, resumo: { series_total: 2 },
    chamados: [
      { serie: "SN-SIMPRESS", relacao: "conferida", simpress: { cidades_entrega: ["Curitiba"] }, oracle: [{ cidade: "Curitiba", nome_filial: "SIMPRESS - PR", fila: "Fila A", status: "Em execução", ultima_atualizacao: "2026-10-10" }] },
      { serie: "SN-PARCEIRO", relacao: "conferida", simpress: { cidades_entrega: ["Curitiba"] }, oracle: [{ cidade: "Maringá", nome_filial: "PARCEIRO", fila: "Fila B", status: "Em execução", ultima_atualizacao: "2026-10-10" }] },
    ],
  };
  harness.run("SimpressApp.state.acompanhamentoChamadosAtual = ticketTestReport; renderizarAcompanhamentoChamados()");

  const cards = harness.element("lista-acompanhamento-chamados").innerHTML;
  assert.match(cards, /SN-SIMPRESS/);
  assert.match(cards, /SN-PARCEIRO/);
  assert.match(cards, /Fila: Fila B/);
  assert.match(cards, /Cidade: [^<]*Maringá/);
  assert.match(cards, /Atendimento: Parceiro/);
  assert.match(harness.element("triagem-diaria-acompanhamento-chamados").innerHTML, /Chamados ativos/);
  assert.match(harness.element("triagem-diaria-acompanhamento-chamados").innerHTML, /3\+ dias/);
  assert.match(appScript, /carregarLinhaDoTempoChamado/);
  assert.match(appScript, /HistoryAnnotationAutosave\.attachAnnotationAutosave/);
});

test("filters tickets by daily triage indicator while counting the whole import", () => {
  const harness = createAppHarness(async () => apiResponse({}));
  const localDate = offset => {
    const date = new Date();
    date.setDate(date.getDate() - offset);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  harness.context.ticketTestReport = {
    fontes: {}, resumo: { series_total: 5 },
    chamados: [
      { serie: "SN-FRESCA", relacao: "conferida", simpress: {}, oracle: [{ status: "Em execução", ultima_atualizacao: localDate(0) }] },
      { serie: "SN-ATRASADA", relacao: "conferida", simpress: {}, oracle: [{ status: "Em execução", ultima_atualizacao: localDate(5) }] },
      { serie: "SN-SEM-DATA", relacao: "conferida", simpress: {}, oracle: [{ status: "Em execução" }] },
      { serie: "SN-FECHADA", relacao: "conferida", simpress: {}, oracle: [{ status: "Concluído", ultima_atualizacao: localDate(9) }] },
      { serie: "SN-SOMENTE-SIMPRESS", relacao: "somente_simpress", simpress: {}, oracle: [] },
    ],
  };
  harness.run("SimpressApp.state.acompanhamentoChamadosAtual = ticketTestReport; renderizarAcompanhamentoChamados()");
  const triage = () => harness.element("triagem-diaria-acompanhamento-chamados").innerHTML;
  const cards = () => harness.element("lista-acompanhamento-chamados").innerHTML;
  const button = key => triage().match(new RegExp(`<button[^>]*data-ticket-triage-filter="${key}"[^>]*>`))[0];

  assert.match(triage(), /3 ativos de 5 séries · 2 sem chamado aberto no Oracle/);
  assert.match(button("ativos"), /aria-label="Chamados ativos: 3"/);
  assert.match(button("atrasados"), /aria-label="Sem atualização há 3\+ dias: 1"/);
  assert.match(button("sem_data"), /aria-label="Sem data de atualização: 1"/);
  assert.match(button("em_dia"), /aria-label="Atualizados há menos de 3 dias: 1"/);
  ["ativos", "atrasados", "sem_data", "em_dia"].forEach(key => {
    assert.match(button(key), /type="button"/);
    assert.match(button(key), /aria-pressed="false"/);
    assert.match(button(key), /data-on-click="filtrarTriagemChamados"/);
  });
  assert.doesNotMatch(triage(), /text-\[(9|10)px\]/);

  harness.run('filtrarTriagemChamados("atrasados")');
  assert.match(button("atrasados"), /aria-pressed="true"/);
  assert.match(button("ativos"), /aria-pressed="false"/);
  assert.match(cards(), /SN-ATRASADA/);
  assert.doesNotMatch(cards(), /SN-FRESCA|SN-SEM-DATA|SN-FECHADA|SN-SOMENTE-SIMPRESS/);
  assert.match(harness.element("contagem-acompanhamento-chamados").textContent, /^1 de 5 séries/);
  assert.match(button("ativos"), /aria-label="Chamados ativos: 3"/, "counts ignore the active filter");

  harness.run('filtrarTriagemChamados("ativos")');
  ["SN-FRESCA", "SN-ATRASADA", "SN-SEM-DATA"].forEach(serial => assert.ok(cards().includes(serial), serial));
  assert.doesNotMatch(cards(), /SN-FECHADA|SN-SOMENTE-SIMPRESS/);
  harness.element("filtro-acompanhamento-chamados").value = "FRESCA";
  harness.run("renderizarAcompanhamentoChamados()");
  assert.match(cards(), /SN-FRESCA/);
  assert.doesNotMatch(cards(), /SN-ATRASADA|SN-SEM-DATA/);
  assert.match(button("ativos"), /aria-label="Chamados ativos: 3"/, "counts ignore the search");

  harness.run('filtrarTriagemChamados("ativos")');
  assert.match(button("ativos"), /aria-pressed="false"/);
  harness.run('filtrarTriagemChamados("sem_data")');
  harness.run("limparFiltrosAcompanhamentoChamados()");
  assert.equal(harness.run("SimpressApp.state.filtroTriagemChamados"), "");
  assert.match(cards(), /SN-FECHADA/);
  assert.match(appCss, /\.ticket-triage-filter\[aria-pressed="true"\]/);
});

test("clears the remaining ticket search and attention filters", () => {
  const harness = createAppHarness(async () => apiResponse({}));
  harness.context.ticketTestReport = {
    fontes: {}, resumo: { series_total: 2 },
    chamados: [
      { serie: "SN-PRIMEIRA", relacao: "conferida", simpress: {}, oracle: [] },
      { serie: "SN-SEGUNDA", relacao: "conferida", simpress: {}, oracle: [] },
    ],
  };
  harness.run("SimpressApp.state.acompanhamentoChamadosAtual = ticketTestReport; renderizarAcompanhamentoChamados()");
  harness.element("filtro-acompanhamento-chamados").value = "PRIMEIRA";
  harness.element("somente-atencao-chamados").checked = true;

  harness.run("limparFiltrosAcompanhamentoChamados()");

  assert.equal(harness.element("filtro-acompanhamento-chamados").value, "");
  assert.equal(harness.element("somente-atencao-chamados").checked, false);
  const cards = harness.element("lista-acompanhamento-chamados").innerHTML;
  assert.match(cards, /SN-PRIMEIRA/);
  assert.match(cards, /SN-SEGUNDA/);
});

test("renders ticket timeline changes and a 2000-character action note", () => {
  const harness = createAppHarness(async () => apiResponse({}));
  const html = harness.run('renderizarLinhaDoTempoChamado([{ snapshot_id: "import-1", item_id: "ticket-row-1", atualizado_em: "2026-10-10T10:00:00", tipo: "Dados alterados", estado: { pedidos_simpress: ["48076976"], solicitacoes_oracle: ["REQ-1"], ordens_servico_simpress: ["7279287"], ordens_servico_oracle: ["7279287"], status_oracle: ["Em execução"], atualizacoes_oracle: ["2026-10-10"] }, mudancas: [{ campo: "OS Simpress", anterior: ["7124895"], atual: ["7279287"] }], anotacao: "Acompanhar parceiro" }])');
  assert.match(html, /Pedido Simpress/);
  assert.match(html, /Solicitação Oracle/);
  assert.match(html, /OS Oracle/);
  assert.match(html, /7124895 → 7279287/);
  assert.match(html, /maxlength="2000"/);
  assert.match(html, /Acompanhar parceiro/);
});

test("exports the selected ticket snapshot with only the visible filters", async () => {
  const requests = [];
  const harness = createAppHarness(async url => {
    requests.push(url);
    return {
      ok: true,
      headers: { get: () => 'attachment; filename="Acompanhamento_de_Chamados.xlsx"' },
      blob: async () => ({}),
    };
  });
  harness.context.ticketTestReport = {
    snapshot_id: "version-1", resumo: {}, fontes: {},
    chamados: [{ serie: "SN-4", simpress: {}, oracle: [] }],
  };
  harness.run("SimpressApp.state.acompanhamentoChamadosAtual = ticketTestReport");
  harness.element("versao-acompanhamento-chamados").value = "version-1";
  harness.element("filtro-acompanhamento-chamados").value = "SN-4";
  harness.element("somente-atencao-chamados").checked = true;

  await harness.run("exportarAcompanhamentoChamados()");

  assert.equal(requests.length, 1);
  assert.match(requests[0], /snapshot_id=version-1/);
  assert.match(requests[0], /search=SN-4/);
  assert.match(requests[0], /attention_only=true/);
  assert.doesNotMatch(requests[0], /relation=|status=|queue=|city=|provider=|age_filter=/);
  assert.equal(harness.effects.toasts[0].message, "Planilha Exportada com Sucesso!");
  assert.equal(harness.effects.toasts[0].type, "success");
});

test("shows imported ticket versions and compares the selected snapshot with the prior import", async () => {
  const newer = { id: "version-2", atualizado_em: "2026-10-10T12:00:00Z", fontes: { simpress: "novo.xlsx", oracle: "novo-oracle.xlsx" }, resumo: {} };
  const older = { id: "version-1", atualizado_em: "2026-10-09T12:00:00Z", fontes: { simpress: "anterior.xlsx", oracle: "anterior-oracle.xlsx" }, resumo: {} };
  const report = {
    fontes: {}, resumo: { series_total: 1, conferidas: 1, divergentes: 0, sem_os: 0, somente_simpress: 0, somente_oracle: 0 },
    chamados: [{ serie: "DEMO-SN-001", relacao: "conferida", simpress: {}, oracle: [] }],
  };
  const current = { ...report, snapshot_id: newer.id, historico: [newer, older] };
  const latestOnly = {
    ...current,
    chamados: [{ serie: "DEMO-SN-RECENTE", relacao: "conferida", simpress: {}, oracle: [] }],
    historico: [newer],
  };
  let oldImportsDeleted = false;
  const requests = [];
  const harness = createAppHarness(async (url, options = {}) => {
    requests.push({ url, method: options.method || "GET" });
    if (url === "/api/operacoes/chamados/historico/antigas" && options.method === "DELETE") {
      oldImportsDeleted = true;
      return apiResponse({ removidas: 1, total: 1 });
    }
    if (url === "/api/operacoes/chamados") return apiResponse(oldImportsDeleted ? latestOnly : current);
    if (url.startsWith("/api/operacoes/chamados/evolucao?")) return apiResponse({
      contagens: { novos: 1, alterados: 2, iguais: 3, ausentes_arquivo: 1 },
      mudancas: { novos: ["SN-NOVO"], alterados: [{ serie: "SN-ALTERADA", campos: [{ campo: "Status Oracle" }] }], ausentes_arquivo: ["SN-ANTIGA"] },
      aviso_ausentes: "Ausência na planilha atual não confirma que o chamado foi resolvido.",
    });
    if (url.endsWith(`/snapshot/${older.id}`)) return apiResponse({ ...report, snapshot_id: older.id });
    return apiResponse({ detail: "endpoint inesperado" }, { status: 404 });
  });

  await harness.run("carregarAcompanhamentoChamados()");

  const versions = harness.element("versao-acompanhamento-chamados");
  assert.equal(versions.children.length, 3);
  assert.equal(versions.value, newer.id);
  assert.equal(harness.element("btn-excluir-importacoes-antigas-chamados").disabled, false);
  assert.match(harness.element("evolucao-acompanhamento-chamados").innerHTML, /2 alteradas/);
  assert.match(harness.element("evolucao-acompanhamento-chamados").innerHTML, /SN-ANTIGA/);
  assert.ok(requests.some(({ url }) => url.includes("anterior=version-1") && url.includes("atual=version-2")));
  assert.match(appHtml, /<button[^>]*id="btn-excluir-importacoes-antigas-chamados"[^>]*>Excluir importações antigas/);

  versions.value = older.id;
  await harness.run("selecionarVersaoChamados()");
  assert.match(harness.element("lista-acompanhamento-chamados").innerHTML, /DEMO-SN-001/);
  assert.match(harness.element("evolucao-acompanhamento-chamados").textContent, /mais antiga/);
  assert.ok(requests.some(({ url }) => url.endsWith(`/snapshot/${older.id}`)));

  await harness.run("excluirImportacoesAntigasChamados()");
  assert.match(harness.effects.confirmations[0], /manter somente a mais recente/);
  assert.ok(requests.some(({ url, method }) => url === "/api/operacoes/chamados/historico/antigas" && method === "DELETE"));
  assert.equal(versions.children.length, 2);
  assert.equal(versions.value, newer.id);
  assert.match(harness.element("lista-acompanhamento-chamados").innerHTML, /DEMO-SN-RECENTE/);
  assert.equal(harness.element("btn-excluir-importacoes-antigas-chamados").disabled, true);
  assert.equal(harness.effects.toasts.at(-1).type, "success");
});

test("keeps old ticket imports when the deletion confirmation is cancelled", async () => {
  const requests = [];
  const harness = createAppHarness(async (url, options = {}) => {
    requests.push({ url, method: options.method || "GET" });
    return apiResponse({});
  }, { confirmResult: false });
  harness.run('renderizarHistoricoAcompanhamentoChamados({ snapshot_id: "new", historico: [{ id: "new" }, { id: "old" }] })');

  await harness.run("excluirImportacoesAntigasChamados()");

  assert.equal(harness.effects.confirmations.length, 1);
  assert.equal(requests.length, 0);
  assert.equal(harness.element("btn-excluir-importacoes-antigas-chamados").disabled, false);
});

test("groups secondary actions under neutral Ações and Consultas headings", () => {
  assert.doesNotMatch(appHtml, /header-action-item--primary|sidebar-related-links/);
  assert.match(appHtml, /data-on-click="abrirAcompanhamentoChamados"[\s\S]*?<details class="header-action-group" data-action-group="analysis">/);
  assert.match(appHtml, /<details class="header-action-group" data-action-group="analysis">/);
  assert.doesNotMatch(appHtml, /data-action-group="equipment"|Equipamentos e cadastros/);

  const analysisGroup = appHtml.match(/<details class="header-action-group" data-action-group="analysis">([\s\S]*?)<\/details>/)?.[1] || "";
  assert.match(analysisGroup, /<span class="sidebar-item-label">Históricos e Análises<\/span>/);
  assert.match(analysisGroup, /<p class="sidebar-subgroup-title" aria-hidden="true">Ações<\/p>\s*<button[^>]*id="btn-atualizar-planilhas"/);
  assert.match(analysisGroup, /<p class="sidebar-subgroup-title" aria-hidden="true">Consultas<\/p>\s*<button[^>]*id="btn-historico-comparacoes"/);
  assert.match(analysisGroup, /id="btn-historico-comparacoes"[^>]*aria-labelledby="label-historico-comparacoes badge-total-historico-comparacoes"[\s\S]*?<span id="badge-total-historico-comparacoes" class="header-action-count"[^>]*>0<\/span>\s*<\/button>/);
  assert.doesNotMatch(analysisGroup.slice(0, analysisGroup.indexOf("</summary>")), /header-action-count/);
  assert.match(analysisGroup, /aria-label="Atualização, exportação, análises, históricos e catálogo de unidades"/);
  assert.doesNotMatch(analysisGroup, /data-on-click="abrirCentralPendencias"/);
  assert.match(analysisGroup, /data-on-click="abrirEvolucaoAtualizacoes"/);
  assert.match(analysisGroup, /data-on-click="abrirModalHistoricoComparacoes"/);
  assert.match(analysisGroup, /data-on-click="abrirModalHistoricoApelidos"/);
  assert.match(analysisGroup, /data-on-click="abrirModalGerenciarUnidades"/);
  assert.ok(analysisGroup.indexOf('id="btn-atualizar-planilhas"') < analysisGroup.indexOf('id="btn-historico-comparacoes"'));
  assert.ok(analysisGroup.indexOf('id="btn-atualizar-planilhas"') < analysisGroup.indexOf('id="btn-exportar-equipamentos"'));
  assert.ok(analysisGroup.indexOf('id="btn-exportar-equipamentos"') < analysisGroup.indexOf('id="btn-historico-comparacoes"'));
  assert.ok(analysisGroup.indexOf('data-on-click="abrirEvolucaoAtualizacoes"') < analysisGroup.indexOf('id="btn-historico-apelidos"'));
  assert.ok(analysisGroup.indexOf('id="btn-historico-apelidos"') < analysisGroup.indexOf('label-catalogo-unidades'));
  assert.match(appHtml, /data-on-click="abrirAcompanhamentoChamados"/);
  assert.doesNotMatch(appHtml, /Acompanhamento de transportes/);
  assert.doesNotMatch(appScript, /\/api\/transferencias/);
});
