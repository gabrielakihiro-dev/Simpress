const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { assembledHtml } = require("./support/assembled-html.cjs");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const html = assembledHtml();
const feature = fs.readFileSync(path.join(root, "static/js/features/chrome-automation.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "static/styles/ux-refinements.css"), "utf8");
const cockpitCss = fs.readFileSync(path.join(root, "static/styles/ck-cockpit.css"), "utf8");

test("Automação agrupa as quatro rotinas na grade, na ordem, e a verificação de usuários é manual", () => {
  const rotinas = html.match(/<div class="ck-rotinas"[\s\S]*?<\/section>/)?.[0];
  assert.ok(rotinas);
  assert.doesNotMatch(html, /ck-linha-acao/);
  const ids = ["os", "inventarios", "usuarios", "ambas"];
  const posicoes = ids.map(id => {
    assert.match(rotinas, new RegExp(`<article class="ck-cartao ck-rotina" data-rotina="${id}" data-estado="ocioso">`));
    const botao = rotinas.match(new RegExp(`<button[^>]*id="btn-automacao-${id}"[^>]*>`))?.[0];
    assert.ok(botao, `botão de ${id} dentro de .ck-rotinas`);
    assert.ok(botao.includes(`data-args='["${id}"]'`));
    assert.match(botao, /class="[^"]*ck-btn--icone[^"]*"/);
    assert.match(botao, /aria-label="Executar [^"]+"/);
    assert.match(rotinas, new RegExp(`id="btn-automacao-${id}"[^>]*>[\\s\\S]*?<span class="ck-sr">Executar</span>`));
    return rotinas.indexOf(`id="btn-automacao-${id}"`);
  });
  assert.deepEqual(posicoes, [...posicoes].sort((x, y) => x - y));
  assert.match(html, /id="btn-automacao-login"/);
  assert.match(html, /id="btn-automacao-cancelar"/);
});

test("Automação mostra o histórico e o console sem painéis recolhíveis", () => {
  assert.match(html, /id="automacao-andamento-painel"/);
  assert.match(html, /id="automacao-historico"/);
  assert.doesNotMatch(html, /Recolher Últimas execuções|Ampliar Andamento/);
  assert.doesNotMatch(feature, /recolherPainelAutomacao|ampliarPainelAutomacao/);
});

test("Os chamados novos do Sebrae ficam na área de Automação e o cartão antigo de sincronização saiu", () => {
  assert.match(html, /id="sebrae-novos-painel"/);
  assert.doesNotMatch(html, /id="sebrae-painel"/);
  assert.doesNotMatch(feature, /api\/automacao\/sebrae/);
});

test("Cartão Chamados novos é compacto: Chamados no cabeçalho, automático primário e buscar secundário (F4 Bloco 2)", () => {
  const cartao = html.match(/<section[^>]*id="sebrae-novos-painel"[\s\S]*?\n      <\/section>/)?.[0];
  assert.ok(cartao);
  const cab = cartao.match(/<div class="ck-cartao__cab">[\s\S]*?<\/div>/)[0];
  const corpo = cartao.slice(cartao.indexOf(cab) + cab.length);
  const botao = (texto, id) => texto.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0] || "";
  const chamados = botao(cab, "btn-sebrae-abrir-chamados");
  assert.match(chamados, /class="ck-btn ck-btn--fantasma ck-btn--sm"/);
  assert.match(chamados, /data-on-click="abrirPainelCockpit"/);
  assert.match(chamados, /data-args='\["sebrae-chamados"\]'/);
  assert.match(cab, /<span>Chamados<\/span><\/button>/);
  assert.doesNotMatch(corpo, /btn-sebrae-abrir-chamados/);
  assert.match(cab, /data-agendamento="ligado"[\s\S]*<span>Agendamento ligado<\/span>/);
  assert.match(cab, /data-agendamento="desligado"[\s\S]*<span>Agendamento desligado<\/span>/);
  assert.match(botao(corpo, "btn-sebrae-automatico"), /class="ck-btn ck-btn--primario ck-btn--sm"/);
  assert.match(botao(corpo, "btn-sebrae-buscar"), /class="ck-btn ck-btn--secundario ck-btn--sm"/);
  assert.match(botao(corpo, "btn-sebrae-importar"), /class="ck-btn ck-btn--secundario ck-btn--sm"/);
  assert.equal((corpo.match(/ck-btn--primario/g) || []).length, 1, "um só botão primário no cartão");
  for (const id of ["sebrae-dashboard-file", "sebrae-dashboard-name", "btn-sebrae-importar", "btn-sebrae-buscar", "btn-sebrae-automatico", "dashboard-agendamento-ativo", "dashboard-agendamento-intervalo", "dashboard-agendamento-status", "sebrae-dashboard-status", "sebrae-novos-resumo", "sebrae-historico-resumo", "sebrae-novos-avisos"]) {
    assert.equal(cartao.split(`id="${id}"`).length - 1, 1, `${id} no cartão`);
  }
  for (const id of ["dashboard-agendamento-status", "sebrae-dashboard-status", "sebrae-novos-resumo"]) {
    assert.match(corpo, new RegExp(`<p id="${id}"[^>]*role="status" aria-live="polite"`), `${id} segue como região de status`);
  }
  assert.match(corpo, /data-vazio="\.xlsx · aba CHAMADOS"/);
  assert.match(cockpitCss, /#sebrae-novos-painel:has\(#dashboard-agendamento-ativo:checked\)/);
});

test("Automation action layout keeps a responsive support group", () => {
  assert.match(styles, /\.automation-action-layout/);
  assert.match(styles, /\.automation-action-support/);
  assert.match(styles, /\.automation-action-independent/);
  assert.match(styles, /@media \(max-width: 40rem\)[\s\S]*?\.automation-action-support/);
});
