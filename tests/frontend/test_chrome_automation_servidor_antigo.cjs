// Servidor antigo (404 em /api/automacao/*): desde o Dia 3 (G7) a lógica vive em frontend/src/paineis/chrome-automation/
// (regras-puro.ts decide o que é servidor antigo; consulta.ts transforma o erro e avisa uma vez). O comportamento de
// ponta a ponta (um único aviso em dois cliques; outros erros com a mensagem original) roda no navegador, no bloco
// "Automação em React: casos do módulo antigo" de tests/e2e/react-g7.spec.cjs, com rotas simuladas.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const pasta = path.resolve(__dirname, "../../frontend/src/paineis/chrome-automation");
const { AVISO_SERVIDOR_ANTIGO, eServidorDesatualizado } = require(path.join(pasta, "regras-puro.ts"));
const consulta = fs.readFileSync(path.join(pasta, "consulta.ts"), "utf8");
const acoes = fs.readFileSync(path.join(pasta, "acoes.ts"), "utf8");

test("404 com o corpo padrão do FastAPI vira o aviso de servidor desatualizado; outros erros não", () => {
  assert.match(AVISO_SERVIDOR_ANTIGO, /^Servidor desatualizado: reinicie o Simpress/);
  assert.equal(AVISO_SERVIDOR_ANTIGO, "Servidor desatualizado: reinicie o Simpress (feche a janela do servidor e abra iniciar_servidor.bat).");
  assert.notEqual(AVISO_SERVIDOR_ANTIGO, "Not Found");
  assert.equal(eServidorDesatualizado({ status: 404, detail: "Not Found" }), true);
  assert.equal(eServidorDesatualizado({ status: 404 }), true);
  assert.equal(eServidorDesatualizado({ status: 404, detail: "Execução não encontrada." }), false);
  assert.equal(eServidorDesatualizado({ status: 409, detail: "Rotina ocupada." }), false);
  assert.equal(eServidorDesatualizado(undefined), false);
});

test("consultarAutomacao troca o 404 pelo aviso e repassa qualquer outro erro sem mexer", () => {
  assert.match(consulta, /return await apiFetch<T>\(url, opcoes\);/);
  assert.match(consulta, /if \(eServidorDesatualizado\(erro as ApiFetchError \| undefined\)\) \{\s*const aviso: ErroAutomacao = new Error\(AVISO_SERVIDOR_ANTIGO\);/);
  assert.match(consulta, /aviso\.status = 404;\s*aviso\.servidorDesatualizado = true;\s*throw aviso;/);
  assert.match(consulta, /\}\s*throw erro;\s*\}\s*\}/, "o erro que não é de servidor antigo sobe como veio");
});

test("o aviso aparece uma só vez e as outras falhas mostram a mensagem original como erro", () => {
  assert.match(consulta, /if \(falha\?\.servidorDesatualizado\) \{\s*if \(interno\.avisouServidorAntigo\) return;\s*interno\.avisouServidorAntigo = true;\s*\}/);
  assert.match(consulta, /appAntigo\(\)\.showToast\?\.\(falha\?\.message \?\? String\(falha\), "error"\);/);
  assert.equal((consulta.match(/showToast/g) || []).length, 2, "um único ponto de aviso na consulta (o tipo e a chamada)");
});

test("iniciar a rotina falha pelo mesmo caminho: consultarAutomacao e avisarErro, sem fetch próprio", () => {
  const iniciar = acoes.slice(acoes.indexOf("export async function iniciarRotinaAutomacao"), acoes.indexOf("export async function cancelarRotinaAutomacao"));
  assert.match(iniciar, /await consultarAutomacao</);
  assert.match(iniciar, /catch \(erro\) \{\s*console\.error\("Erro ao iniciar a automação:", erro\);\s*avisarErro\(erro\);\s*\}/);
  assert.match(iniciar, /finally \{\s*mudar\(\{ ocupado: false, iniciando: "" \}\);[\s\S]*void atualizarEstadoAutomacao\(\);\s*\}/);
  assert.doesNotMatch(iniciar, /(?<![A-Za-z.])fetch\(/);
});
