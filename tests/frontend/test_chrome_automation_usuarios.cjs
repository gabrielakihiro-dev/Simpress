// Verificar usuários e atalho "Ver backups no Resumo": desde o Dia 3 (G7) os cartões e o atalho são desenhados pelo
// React (frontend/src/paineis/chrome-automation/). Aqui: o HTML do botão e do filtro pelo TSX, a rotina na lista, e a
// regra do atalho (regras-puro.ts, carregado direto pelo Node). O envio de {rotina: "usuarios"} e o aviso
// "Verificar usuários iniciada" rodam no navegador, no bloco "Automação em React: casos do módulo antigo" de
// tests/e2e/react-g7.spec.cjs; o atalho visível na tela, no mesmo bloco.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { assembledHtml } = require("./support/assembled-html.cjs");

const pasta = path.resolve(__dirname, "../../frontend/src/paineis/chrome-automation");
const { ROTINAS, ROTINAS_DOS_CARTOES, verBackupsDepois } = require(path.join(pasta, "regras-puro.ts"));
const componentes = fs.readFileSync(path.join(pasta, "componentes.tsx"), "utf8");
const acoes = fs.readFileSync(path.join(pasta, "acoes.ts"), "utf8");
const indexHtml = assembledHtml();

test("o cartão de verificar usuários é desenhado pelo React com os atributos do HTML antigo", () => {
  const cartao = componentes.match(/\{ id: "usuarios"[^\n]*\}/)?.[0];
  assert.ok(cartao, "cartão usuarios na lista de cartões");
  assert.match(cartao, /icone: "i-users"/, "deve usar o ícone users");
  assert.match(cartao, /nome: "Verificar usuários"/, "deve exibir o rótulo Verificar usuários");
  assert.match(cartao, /idTitulo: "ck-verificacao-titulo"/);
  assert.match(cartao, /idDica: "tip-verificar-usuarios"/);
  // O botão sai do mesmo molde das outras rotinas: id, data-automacao-rotina, data-on-click e data-args.
  assert.match(componentes, /id=\{`btn-automacao-\$\{cartao\.id\}`\} data-automacao-rotina=\{cartao\.id\}/);
  assert.match(componentes, /data-on-click="iniciarRotinaAutomacao" data-args=\{args\(cartao\.id\)\}/);
  // O HTML montado só traz o ponto de montagem: nada do cartão fica duplicado no HTML estático.
  assert.doesNotMatch(indexHtml, /id="btn-automacao-usuarios"/);
  assert.doesNotMatch(indexHtml, /ck-verificacao-titulo/);
});

test("a lista de rotinas e o filtro do histórico incluem Verificar usuários", () => {
  assert.equal(ROTINAS.usuarios, "Verificar usuários");
  assert.ok(ROTINAS_DOS_CARTOES.includes("usuarios"));
  assert.match(componentes, /const ROTINAS_DO_FILTRO = \[[^\]]*"usuarios"[^\]]*\] as const;/);
  assert.match(componentes, /ROTINAS_DO_FILTRO\.map\(rotina => <option key=\{rotina\} value=\{rotina\}>\{ROTINAS\[rotina\]\}<\/option>\)/);
});

test("iniciar usuarios envia só { rotina } por POST e avisa 'Verificar usuários iniciada'", () => {
  const iniciar = acoes.slice(acoes.indexOf("export async function iniciarRotinaAutomacao"), acoes.indexOf("export async function cancelarRotinaAutomacao"));
  assert.match(iniciar, /"\/api\/automacao\/executar"/);
  assert.match(iniciar, /method: "POST"/);
  assert.match(iniciar, /body: JSON\.stringify\(\{ rotina \}\)/);
  assert.match(iniciar, /showToast\?\.\(`\$\{ROTINAS\[rotina\]\} iniciada\.`, "success"\)/);
});

test("atalho 'Ver backups no Resumo': aparece ao concluir inventários ou rotina completa e some ao iniciar outra rotina", () => {
  assert.match(componentes, /id="automacao-ver-backups" className="ck-btn ck-btn--secundario ck-btn--sm" data-on-click="abrirPainelCockpit" data-args=\{args\("comparacao", "backups"\)\} hidden=\{!e\.verBackups\}>Ver backups no Resumo<\/button>/);
  assert.doesNotMatch(indexHtml, /id="automacao-ver-backups"/);
  assert.match(acoes, /const verBackups = verBackupsDepois\(\{ emAndamento, estavaAtivo, rotinaAnterior, statusUltima: dados\.ultima\?\.status \}\);\s*if \(verBackups !== null\) mudar\(\{ verBackups \}\);/);

  let visivel = false; // o botão nasce escondido (verBackups: false em estado.ts)
  let ativa = false;
  let rotina = "";
  const passo = (emAndamento, rotinaDoPasso, status) => {
    const novo = verBackupsDepois({ emAndamento, estavaAtivo: ativa, rotinaAnterior: rotina, statusUltima: status });
    if (novo !== null) visivel = novo;
    ativa = emAndamento;
    rotina = emAndamento ? rotinaDoPasso : rotina;
  };
  const andamento = nome => passo(true, nome, undefined);
  const fim = (nome, status) => passo(false, nome, status);

  fim("os", "concluido");
  assert.equal(visivel, false, "sem execução observada, continua escondido");
  andamento("os");
  fim("os", "concluido");
  assert.equal(visivel, false, "rotina de OS não mostra o atalho");
  andamento("inventarios");
  assert.equal(visivel, false, "em andamento não mostra");
  fim("inventarios", "falha");
  assert.equal(visivel, false, "inventários com falha não mostra");
  andamento("inventarios");
  fim("inventarios", "concluido");
  assert.equal(visivel, true, "inventários concluídos mostram o atalho");
  andamento("os");
  assert.equal(visivel, false, "nova rotina esconde o atalho");
  andamento("ambas");
  fim("ambas", "concluido");
  assert.equal(visivel, true, "rotina completa concluída mostra o atalho");
  andamento("usuarios");
  assert.equal(visivel, false, "verificar usuários em andamento esconde o atalho");
});
