const assert = require("node:assert/strict");
const test = require("node:test");
const createDomUtils = require("../../static/js/shared/dom-utils.js");
const historyFormat = require("../../static/js/shared/history-format.js");
const createComparisonResultRenderer = require("../../static/js/ui/comparison-result-renderer.js");
const createLoggedUserMarkers = require("../../static/js/ui/logged-user-markers.js");

const dom = createDomUtils({ createElement: () => ({ setAttribute() {} }) });

function renderizar(comparison) {
  const renderer = createComparisonResultRenderer({
    app: { atributosVersaoAnotacao: () => "" },
    dom,
    historyFormat,
    loggedUserMarkers: createLoggedUserMarkers({ dom }),
  });
  // The table renderer derives mobile cards through <template>; this check only needs the desktop rows.
  globalThis.document = { createElement: () => ({ content: { querySelector: () => null } }) };
  try {
    return renderer.conteudoResultadoComparacao(
      comparison,
      renderer.listasComparacao(comparison),
      renderer.criarColunasAnotacao(comparison),
    );
  } finally {
    delete globalThis.document;
  }
}

const MUDANCAS = [
  { tipo: "novo_endpoint", serie: "SN-1", computador: "HOST-1", usuario_anterior: "joao", origem_anterior: "manual", usuario_novo: "carla", origem_nova: "endpoint", motivo: "Usuário novo vindo do Endpoint. O usuário manual joao foi arquivado.", usuario_manual_arquivado: "joao", anotacao_id: "a1" },
  { tipo: "alterado_endpoint", serie: "SN-2", usuario_anterior: "ana", origem_anterior: "endpoint", usuario_novo: "bia", origem_nova: "endpoint", motivo: "Usuário alterado no endpoint.", anotacao_id: "a2" },
  { tipo: "removido_endpoint", serie: "SN-3", usuario_anterior: "cris", origem_anterior: "endpoint", usuario_novo: "", origem_nova: "", motivo: "Usuário removido do Endpoint.", usuario_manual_arquivado: "velho", anotacao_id: "a3" },
  { tipo: "manual_voltou", serie: "SCXC9F072K1", usuario_anterior: "DDrodrigues", origem_anterior: "endpoint", usuario_novo: "mac", origem_nova: "manual", motivo: "Usuário removido do Endpoint; o usuário manual voltou a valer.", anotacao_id: "a4" },
];

test("the update result summarizes logged-user changes with counts, labels, (M) and per-row annotations", () => {
  const html = renderizar({ evento_id: "evt", historico_salvo: true, mudancas_usuarios: MUDANCAS });
  assert.match(html, /id="comparacao-secao-mudancas-usuarios"[^>]*>.*Mudanças de usuário logado/);
  assert.match(html, /Novos no Endpoint: 1 · Alterados: 1 · Removidos do Endpoint: 1 · Manuais que voltaram a valer: 1/);
  assert.match(html, /data-comparison-section-target="comparacao-secao-mudancas-usuarios"/);
  for (const rotulo of ["Usuário novo no Endpoint", "Usuário alterado no Endpoint", "Usuário removido do Endpoint", "Manual voltou a valer"]) {
    assert.ok(html.includes(rotulo), rotulo);
  }
  // The history display lowercases "no Endpoint"; the summary shows the approved label again.
  assert.match(html, />Usuário alterado no Endpoint\.<\/td>/);
  assert.match(html, />Usuário removido do Endpoint; o usuário manual voltou a valer\.<\/td>/);
  assert.match(html, /joao \(M\)/);
  assert.match(html, /mac \(M\)/);
  assert.doesNotMatch(html, /carla \(M\)/);
  assert.equal((html.match(/data-comparison-category="mudancas_usuarios"/g) || []).length, 4);
  assert.equal((html.match(/data-comparison-annotation /g) || []).length, 4);
  // The archived manual user is only offered on the row, never applied.
  assert.match(html, /data-logged-user-serie="SN-3" data-logged-user-sugestao="velho"/);
});

test("results saved before the summary existed show no user-change section or card", () => {
  const html = renderizar({ evento_id: "evt", historico_salvo: true });
  assert.doesNotMatch(html, /Mudanças de usuário/);
  const vazio = renderizar({ evento_id: "evt", historico_salvo: true, mudancas_usuarios: [] });
  assert.match(vazio, /Nenhum usuário logado mudou nesta atualização\./);
});

test("an archived manual user pre-fills the field with a restore button and is not saved by itself", async () => {
  const chamadas = [];
  const item = { dataset: { loggedUserSerie: "SN-3", loggedUserSugestao: "velho" }, innerHTML: "", querySelector: () => null };
  const markers = createLoggedUserMarkers({
    dom,
    appState: {},
    app: {
      apiFetch: async (url, options) => {
        chamadas.push(url);
        return { usuarios: { "SN-3": { usuario: "", origem: "", serial_cadastro: "SN-3" } } };
      },
    },
  });
  assert.equal(markers.marcador("SN-3", { sugestao: "  velho " }), '<span class="logged-user" data-logged-user data-logged-user-serie="SN-3" data-logged-user-sugestao="velho"></span>');
  markers.conectar({ querySelectorAll: () => [item] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(chamadas, ["/api/equipamentos/usuarios-logados"]);
  assert.match(item.innerHTML, /Manual arquivado: velho\. Confirme para restaurar\./);
  assert.match(item.innerHTML, /value="velho"/);
  assert.match(item.innerHTML, />Restaurar manual</);
});

test("pending logged-user holds list their decision buttons and never apply anything themselves", () => {
  const html = renderizar({
    evento_id: "evt",
    historico_salvo: true,
    mudancas_usuarios: [
      { tipo: "substituicao_pendente", serie: "SN-1", usuario_anterior: "joao", origem_anterior: "manual", usuario_novo: "carla", origem_nova: "endpoint", motivo: "O Endpoint passou a informar carla.", pendencia_id: "h1", pendencia_tipo: "substituicao_manual", anotacao_id: "p1" },
      { tipo: "ausente_pendente", serie: "SN-2", usuario_anterior: "ana", origem_anterior: "endpoint", usuario_novo: "", origem_nova: "", motivo: "O Endpoint deixou de informar ana.", pendencia_id: "h2", pendencia_tipo: "usuario_ausente", anotacao_id: "p2" },
    ],
  });
  assert.match(html, /Substituição do usuário manual — aguardando decisão/);
  assert.match(html, /Usuário sumiu do Endpoint — aguardando confirmação/);
  assert.match(html, /data-user-hold="h1"[\s\S]*data-user-hold-action="permitir"[\s\S]*data-user-hold-action="recusar"/);
  assert.match(html, /data-user-hold="h2"[\s\S]*data-user-hold-action="remover"[\s\S]*data-user-hold-action="manter"/);
  assert.equal((html.match(/data-user-hold-status role="status"/g) || []).length, 2);
});
