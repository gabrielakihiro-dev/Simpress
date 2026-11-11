const assert = require("node:assert/strict");
const test = require("node:test");
const createDomUtils = require("../../static/js/shared/dom-utils.js");
const historyFormat = require("../../static/js/shared/history-format.js");
const createComparisonResultRenderer = require("../../static/js/ui/comparison-result-renderer.js");
const createLoggedUserMarkers = require("../../static/js/ui/logged-user-markers.js");

const dom = createDomUtils({ createElement: () => ({ setAttribute() {} }) });
const renderer = createComparisonResultRenderer({
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
      "Divergências de local", "Duplicidades e ambiguidades", "Séries sem mapeamento",
    ],
  },
  apelidos: {
    aria: "Contadores de Apelidos",
    rotulos: ["Apelidos para conferência", "Divergências manuais pendentes", "Apelidos/hostnames atualizados"],
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

test("Visão geral no longer renders counters nor the 'Equipamentos carregados' footer", () => {
  const html = renderizar(
    { ...COMPARACAO_COMPLETA, total_equipamentos_carregados: 4321, backup_diretorio: "_backups_x", anotacoes_herdadas_enfileiradas: 2 },
    { estado: "ok", items: [{ serial: "SN-1", apelido: "PRNOTE-A" }] },
  );
  const visao = painel(html, "visao");
  assert.doesNotMatch(visao, /data-metric-tone/);
  assert.doesNotMatch(visao, /resumo-cartoes/);
  assert.doesNotMatch(visao, /comparison-metric-link/);
  // The inherited-notes notice is the only content left there.
  assert.match(visao, /2 anotações herdadas foram gravadas junto com o resultado/);
  for (const texto of [/Equipamentos carregados na Simpress/, /Backup das versões anteriores/, /4\.321/, /_backups_x/]) {
    assert.doesNotMatch(html, texto);
  }
});

test("strips stay with static cards at zero and the Usuários tab has no wrapper without cards", () => {
  const html = renderizar({ total_endpoint: 0 });
  assert.equal(cartoes(painel(html, "divergencias")).length, 6);
  assert.equal(cartoes(painel(html, "apelidos")).length, 3);
  assert.doesNotMatch(painel(html, "usuarios"), /resumo-cartoes/);
  assert.doesNotMatch(painel(html, "visao"), /data-metric-tone/);
});
