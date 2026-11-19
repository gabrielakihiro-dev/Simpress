// Backups (Resumo F3): montar() não pede o /api/painel; repetirPainel recebe da ponte o último evento
// `simpress:painel-atualizado` (ou `painel-indisponivel`) que passou antes de o bundle React carregar. O montar.tsx tem JSX, que o Node não lê:
// o hook troca só o `<PainelBackups dados={dados} />` por uma chamada comum e redireciona react-dom, a API e o painel
// para dublês. O estado do módulo (`dados`) é compartilhado entre os testes do arquivo, que rodam nesta ordem.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");

const arquivo = path.resolve(__dirname, "../../frontend/src/paineis/backups-regionais/montar.tsx");
const dubles = {
  "react-dom": "export const flushSync = funcao => funcao();",
  "react-dom/client": "export const createRoot = () => ({ render() {} });",
  "../../api": "export const apiFetch = async () => ({});",
  "../resultado-comparacao/bento-resumo": "export const pintarPainelNoBento = () => {}; export const marcarPainelIndisponivel = () => {};",
  "./painel": "export const PainelBackups = ({ dados }) => { globalThis.__desenhosBackups.push(dados); return null; };",
};

Module.registerHooks({
  resolve(especificador, contexto, proximo) {
    if (/montar\.tsx$/.test(contexto.parentURL || "") && especificador in dubles) {
      return { url: `simpress-teste:${especificador}`, format: "module", shortCircuit: true };
    }
    return proximo(especificador, contexto);
  },
  load(url, contexto, proximo) {
    if (url.startsWith("simpress-teste:")) return { format: "module", shortCircuit: true, source: dubles[url.slice("simpress-teste:".length)] };
    if (!/backups-regionais\/montar\.tsx$/.test(url)) return proximo(url, contexto);
    const fonte = fs.readFileSync(arquivo, "utf8");
    const semJsx = fonte.replace(/<PainelBackups dados=\{dados\} \/>/, "PainelBackups({ dados })");
    if (semJsx === fonte) throw new Error("montar.tsx mudou o JSX do painel: ajuste o hook deste teste");
    return { format: "module-typescript", shortCircuit: true, source: semJsx };
  },
});

const pedidos = [];
const ouvintes = [];
const documento = {
  body: {},
  activeElement: null,
  addEventListener: (tipo, funcao) => ouvintes.push([tipo, funcao]),
  dispatchEvent: evento => { pedidos.push(evento.type); },
  getElementById: () => null,
};
global.document = documento;
global.window = { clearTimeout() {}, setTimeout() {} };
const desenhos = [];
global.__desenhosBackups = desenhos;
const { montar } = require(arquivo);

const container = () => ({
  childElementCount: 0,
  closest: () => null,
  querySelectorAll: () => [],
  contains: () => false,
  addEventListener() {},
});

test("montar não pede o painel; registra os ouvintes de atualizado e indisponível", () => {
  pedidos.length = 0;
  ouvintes.length = 0;
  montar(container());
  assert.deepEqual(pedidos, []);
  assert.deepEqual(ouvintes.map(([tipo]) => tipo), ["simpress:painel-atualizado", "simpress:painel-indisponivel"]);
});

test("repetirPainel: indisponível só vale sem painel; o painel guardado pela ponte é desenhado", () => {
  const acoes = montar(container());
  desenhos.length = 0;
  acoes.repetirPainel({});
  acoes.repetirPainel({ indisponivel: true });
  acoes.repetirPainel({ painel: { backups_regionais: { pendencias: { sem_backup: [], conferir: [] } } }, indisponivel: true });
  assert.deepEqual(pedidos, []);
  assert.deepEqual(desenhos.map(dados => Object.keys(dados).sort().join(",")), ["indisponivel,limitacoes", "pendencias"]);
});
