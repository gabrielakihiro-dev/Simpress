const assert = require("node:assert/strict");
const test = require("node:test");
const { createDomUtils } = require("../../frontend/src/comum/dom-utils.ts");
const historyFormat = require("../../frontend/src/comum/history-format.ts");
const { criarRenderizadorResultado } = require("../../frontend/src/paineis/resultado-comparacao/renderizador.ts");
const { createLoggedUserMarkers } = require("../../frontend/src/ui/logged-user-markers.ts");

const dom = createDomUtils({ createElement: () => ({ setAttribute() {} }) });
const renderer = criarRenderizadorResultado({
  app: { atributosVersaoAnotacao: () => "" },
  dom,
  historyFormat,
  loggedUserMarkers: createLoggedUserMarkers({ dom }),
});

// The table renderer derives mobile cards through <template>; this markup check only needs the desktop rows.
globalThis.document = { createElement: () => ({ content: { querySelector: () => null } }) };

function renderizar(comparison, semUsuario = null) {
  return renderer.conteudoResultadoComparacao(
    comparison,
    { ...renderer.listasComparacao(comparison), semUsuario },
    renderer.criarColunasAnotacao(comparison),
  );
}

const cartoes = html => [...html.matchAll(/<(button|div) [^>]*data-metric-tone="[^"]*"[^>]*>\s*<p[^>]*>([^<]+)<\/p>/g)]
  .map(([tag, elemento, rotulo]) => ({ elemento, rotulo, tag, alvo: tag.match(/data-comparison-section-target="([^"]+)"/)?.[1] || "" }));

const COMPARACAO_COMPLETA = {
  total_endpoint: 12,
  ausentes_no_endpoint: [{ computador: "PRNOTE-A", serie: "SER-A" }],
  ausentes_em_detalhes: [{ computador: "PRNOTE-B", serie: "SER-B" }],
  divergencias_local: [{ computador: "PRNOTE-C", serie: "SER-C", local_previsto: "Curitiba", local_detalhes: "Londrina" }],
  correspondencias_ambiguas: [{ tipo: "Série duplicada", chave: "SER-D", fontes: [] }],
  series_sem_mapeamento: [{ serie: "XYZ", quantidade: 1, exemplos: ["XYZ1"] }],
  apelidos_atualizados: [{ serie: "SER-E", apelido_anterior: "A", apelido_novo: "B" }],
  apelidos_sem_atualizacao: [{ serie: "SER-F", hostname_endpoint: "PRNOTE-F", motivo: "Conferir" }],
  divergencias_apelidos_manuais: [{ serie: "SER-G", apelido_manual: "M" }],
  mudancas_usuarios: [{ tipo: "novo_endpoint", serie: "SER-H", usuario_novo: "ana", origem_nova: "endpoint" }],
};

// Card label -> visible title of the section it must reach.
const SECAO_ESPERADA = {
  "Sem correspondência — no endpoint": "Sem correspondência — Endpoint",
  "Sem correspondência — na Simpress": "Sem correspondência — Simpress",
  "Divergências de local": "Localidade divergente",
  "Duplicidades e ambiguidades": "Duplicidades e correspondências ambíguas",
  "Séries sem mapeamento": "Séries sem local definido",
  "Apelidos/hostnames atualizados": "Apelidos/hostnames atualizados — no endpoint",
  "Apelidos para conferência": "Linhas mantidas para conferência",
  "Divergências manuais pendentes": "Divergências com apelidos alterados manualmente",
  "Mudanças de usuário": "Mudanças de usuário logado",
};

test("summary cards with rows jump to the title of their own section", () => {
  const html = renderizar(COMPARACAO_COMPLETA);
  const encontrados = cartoes(html);
  assert.equal(encontrados.length, 10);

  for (const cartao of encontrados) {
    const esperado = SECAO_ESPERADA[cartao.rotulo];
    if (!esperado) {
      // "Notebooks comparados" has no section of its own.
      assert.equal(cartao.rotulo, "Notebooks comparados");
      assert.equal(cartao.elemento, "div");
      continue;
    }
    assert.equal(cartao.elemento, "button", cartao.rotulo);
    assert.match(cartao.tag, /type="button"/);
    assert.match(cartao.tag, /class="comparison-metric-link /);
    const titulo = html.match(new RegExp(`<h[45] id="${cartao.alvo}" tabindex="-1"[^>]*>(?:<span[^>]*></span>)?([^<(]+)`));
    assert.ok(titulo, `${cartao.rotulo} -> #${cartao.alvo} existe`);
    assert.equal(titulo[1].trim(), esperado, cartao.rotulo);
    assert.match(cartao.tag, new RegExp(`aria-label="${cartao.rotulo}: \\d+\\. Ir para ${esperado}"`));
  }
});

test("summary card targets are unique and every mapped section title is rendered once", () => {
  // "Sem usuário" só é desenhada quando o controller entrega a leitura do inventário.
  const html = renderizar(COMPARACAO_COMPLETA, { estado: "ok", items: [] });
  const ids = Object.values(renderer.SECOES_CARTOES_RESUMO).map(secao => secao.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, id);
  }
});

test("summary cards stay static when the count is zero", () => {
  const html = renderizar({ total_endpoint: 0 });
  assert.doesNotMatch(html, /data-comparison-section-target/);
  assert.doesNotMatch(html, /comparison-metric-link/);
  assert.equal(cartoes(html).filter(cartao => cartao.elemento === "div").length, 9);
  // The section titles keep their ids so links from elsewhere still resolve.
  assert.match(html, /<h4 id="comparacao-secao-localidade-divergente" tabindex="-1"/);
});

test("pending manual alias card keeps its counter id inside the link", () => {
  const html = renderizar(COMPARACAO_COMPLETA);
  assert.match(html, /<button [^>]*data-comparison-section-target="comparacao-secao-apelidos-manuais"[^>]*>.*?<p id="comparacao-divergencias-manuais-pendentes"/s);
});

test("Sem usuário em estado limite mantém o título único da seção e não cria cartão com contagem parcial", () => {
  const html = renderizar(COMPARACAO_COMPLETA, { estado: "limite", items: [{ serial: "SN-1", apelido: "PRNOTE-A" }], total: 500 });
  const id = renderer.SECOES_CARTOES_RESUMO.sem_usuario.id;
  assert.equal(html.split(`id="${id}"`).length - 1, 1);
  assert.equal(cartoes(html).filter(cartao => cartao.alvo === id).length, 0);
  assert.match(html, /Mostrando os primeiros 1 de 500 notebooks sem usuário/);
});

// HTML of one Resumo tabpanel: from its opening tag to the next panel (or the end of the result).
function painel(html, chave) {
  const inicio = html.indexOf(`id="resumo-painel-${chave}"`);
  assert.ok(inicio >= 0, `painel ${chave} existe`);
  const proximo = html.indexOf('id="resumo-painel-', inicio + 1);
  return html.slice(inicio, proximo < 0 ? undefined : proximo);
}

// Counters each tab opens with, in display order.
const FAIXAS = {
  divergencias: {
    aria: "Contadores de Divergências",
    rotulos: [
      "Notebooks comparados", "Sem correspondência — no endpoint", "Sem correspondência — na Simpress",
      "Divergências de local", "Séries sem mapeamento",
    ],
  },
  apelidos: {
    aria: "Contadores de Apelidos",
    rotulos: ["Duplicidades e ambiguidades", "Apelidos para conferência", "Divergências manuais pendentes", "Apelidos/hostnames atualizados"],
  },
  usuarios: { aria: "Contadores de Usuários", rotulos: ["Mudanças de usuário", "Sem usuário"] },
};

test("each Resumo tab opens with its own compact counters strip, above the empty-state notice", () => {
  const html = renderizar(COMPARACAO_COMPLETA, { estado: "ok", items: [{ serial: "SN-1", apelido: "PRNOTE-A" }] });
  let total = 0;
  for (const [chave, { aria, rotulos }] of Object.entries(FAIXAS)) {
    const corpo = painel(html, chave);
    // The strip is the first child of the panel, so it precedes the notice and every section.
    const abertura = corpo.match(/^[^>]*>\s*<div class="resumo-cartoes" role="group" aria-label="([^"]+)">/);
    assert.equal(abertura?.[1], aria, `${chave}: faixa é o primeiro filho do painel`);
    assert.ok(corpo.indexOf("resumo-cartoes") < corpo.indexOf("data-resumo-vazio"), `${chave}: faixa antes de data-resumo-vazio`);
    const faixa = corpo.slice(corpo.indexOf("resumo-cartoes"), corpo.indexOf("data-resumo-vazio"));
    const encontrados = cartoes(faixa);
    assert.deepEqual(encontrados.map(cartao => cartao.rotulo), rotulos, `${chave}: rótulos e ordem`);
    total += encontrados.length;
  }
  // Nothing is left outside the three strips.
  assert.equal(cartoes(html).length, total);
});

test("strip cards keep tones and links: counted cards are buttons to their section, 'Notebooks comparados' stays static", () => {
  const html = renderizar(COMPARACAO_COMPLETA, { estado: "ok", items: [{ serial: "SN-1", apelido: "PRNOTE-A" }] });
  const tons = {};
  for (const chave of Object.keys(FAIXAS)) {
    for (const cartao of cartoes(painel(html, chave))) {
      tons[cartao.rotulo] = cartao.tag.match(/data-metric-tone="([^"]*)"/)[1];
      assert.equal(cartao.elemento, cartao.rotulo === "Notebooks comparados" ? "div" : "button", cartao.rotulo);
    }
  }
  assert.deepEqual(tons, {
    "Notebooks comparados": "",
    "Sem correspondência — no endpoint": "amber",
    "Sem correspondência — na Simpress": "amber",
    "Divergências de local": "amber",
    "Duplicidades e ambiguidades": "rose",
    "Séries sem mapeamento": "amber",
    "Apelidos para conferência": "amber",
    "Divergências manuais pendentes": "rose",
    "Apelidos/hostnames atualizados": "emerald",
    "Mudanças de usuário": "emerald",
    "Sem usuário": "amber",
  });
});

test("Resumo (18/11/2026, atualizado 23/11/2026): o resultado não traz o bento nem painel de Visão Geral (ele é estático, fora de #comparacao-planilhas-conteudo); sem anel e sem o rodapé 'Equipamentos carregados'", () => {
  const html = renderizar(
    { ...COMPARACAO_COMPLETA, total_equipamentos_carregados: 4321, backup_diretorio: "_backups_x", anotacoes_herdadas_enfileiradas: 2 },
    { estado: "ok", items: [{ serial: "SN-1", apelido: "PRNOTE-A" }] },
  );
  assert.equal(html.includes('id="resumo-painel-visao"'), false);
  assert.equal(html.includes('id="resumo-painel-visao-geral"'), false);
  assert.deepEqual(renderer.RESUMO_ABAS.map(aba => aba.chave), ["visao-geral", "divergencias", "apelidos", "usuarios", "sem-acesso", "backups"]);
  assert.equal(renderer.RESUMO_ABAS[0].rotulo, "Visão Geral", "texto aprovado, G maiúsculo");
  for (const texto of [/Visão geral/, /Visão Geral/, /Contadores de Visão geral/, /ck-bento-anel/, /ck-bento-legenda/, /com correspondência nas duas bases/, /Equipamentos carregados na Simpress/, /Backup das versões anteriores/, /4\.321/, /_backups_x/]) {
    assert.doesNotMatch(html, texto);
  }
  // O aviso das anotações herdadas vive em #comparacao-planilhas-avisos (avisoHistoricoComparacao), fora do conteúdo das sub-abas, para aparecer na Visão Geral.
  assert.doesNotMatch(html, /anotações herdadas foram gravadas/);
  const avisos = renderer.avisoHistoricoComparacao({ ...COMPARACAO_COMPLETA, anotacoes_herdadas_enfileiradas: 2, historico_salvo: true });
  assert.match(avisos, /2 anotações herdadas foram gravadas junto com o resultado\. A sincronização com a pasta compartilhada será tentada automaticamente\./);
  assert.match(avisos, /Resultado registrado no Histórico de planilhas\./);
});

test("strips stay with static cards at zero and the Usuários tab has no wrapper without cards", () => {
  const html = renderizar({ total_endpoint: 0 });
  assert.equal(cartoes(painel(html, "divergencias")).length, 5);
  assert.equal(cartoes(painel(html, "apelidos")).length, 4);
  assert.doesNotMatch(painel(html, "usuarios"), /resumo-cartoes/);
});

test("Visão Geral (23/11/2026): aba padrão do Resumo, habilitada sem comparação e fora dos selos de contagem", () => {
  const fonte = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../frontend/src/paineis/resultado-comparacao/estado.ts"), "utf8");
  assert.match(fonte, /ESTADO_RESUMO_INICIAL: EstadoResumo = \{ aba: "visao-geral"/);
  assert.match(fonte, /ABAS_SEM_COMPARACAO = \["visao-geral", "divergencias", "backups"\]/);
  assert.match(fonte, /chave !== "backups" && chave !== "visao-geral"/);
  assert.match(fonte, /escondeListas = naVisaoGeral && !semComparacao/);
  // Sem piscar a Visão Geral: limparAbasResumo mantém a aba que a abertura pediu, se ela vale sem comparação.
  assert.match(fonte, /function limparAbasResumo\(abaPedida\?: string\)/);
  assert.match(fonte, /abaPedida && ABAS_SEM_COMPARACAO\.includes\(abaPedida\)/);
  const painel = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../frontend/src/paineis/ferramentas-cockpit/estado.ts"), "utf8");
  assert.equal(painel.split("app.limparAbasResumo?.(abaPedidaAoAbrir)").length - 1, 3);
});

test("Duplicidades e ambiguidades (27/11/2026): ficam no topo de Apelidos, fora de Divergências", () => {
  const html = renderizar(COMPARACAO_COMPLETA);
  const id = renderer.SECOES_CARTOES_RESUMO.correspondencias_ambiguas.id;
  assert.doesNotMatch(painel(html, "divergencias"), new RegExp(`id="${id}"`));
  const apelidos = painel(html, "apelidos");
  assert.ok(apelidos.indexOf(`id="${id}"`) >= 0);
  assert.ok(apelidos.indexOf(`id="${id}"`) < apelidos.indexOf(`id="${renderer.SECOES_CARTOES_RESUMO.apelidos_sem_atualizacao.id}"`));
  assert.equal(renderer.abaDaCategoria("correspondencias_ambiguas"), "apelidos");
  assert.equal(renderer.abaDaCategoria("registros_ambiguos"), "apelidos");
  assert.deepEqual(renderer.CATEGORIAS_POR_ABA.apelidos.slice(0, 2), ["correspondencias_ambiguas", "apelidos_sem_atualizacao"]);
  assert.equal(renderer.TIPOS_DIVERGENCIAS.some(tipo => tipo.categorias.includes("correspondencias_ambiguas")), false);
});

test("duplicidade mostra o selo só no registro que o back-end marcou como aplicado", () => {
  const registros = (a, b, aplicado = true) => [
    { serie: "SER-D", computador: "PRNOTE-NOVO", ultima_verificacao: a, aplicado },
    { serie: "SER-D", computador: "PRNOTE-VELHO", ultima_verificacao: b, aplicado: false },
  ];
  const html = renderizar({ ...COMPARACAO_COMPLETA, registros_ambiguos: [{ serie: "SER-D", computador: "PRNOTE-NOVO / PRNOTE-VELHO", fontes: {}, registros_endpoint: registros("2026-10-17T10:00:00-03:00", "2026-09-02T10:00:00-03:00") }] });
  assert.equal(html.split("Aplicado (verificação mais recente)").length - 1, 1);
  assert.match(html, /data-hostname-nome="PRNOTE-NOVO">.*?data-hostname-aplicado/s);
  const empate = renderizar({ ...COMPARACAO_COMPLETA, registros_ambiguos: [{ serie: "SER-D", fontes: {}, registros_endpoint: registros("2026-10-17T10:00:00-03:00", "2026-10-17T10:00:00-03:00", false) }] });
  assert.doesNotMatch(empate, /Aplicado \(verificação mais recente\)/);
  const antigo = renderizar({ ...COMPARACAO_COMPLETA, registros_ambiguos: [{ serie: "SER-D", fontes: {}, registros_endpoint: [{ computador: "A" }, { computador: "B" }] }] });
  assert.doesNotMatch(antigo, /Aplicado \(verificação mais recente\)/);
});
