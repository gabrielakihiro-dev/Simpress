// frontend/src/aplicacao/app.ts: a ponte assíncrona rejeita também quando o script do bundle dispara "error" (404), sem esperar o "load" da janela.
// iniciar() é uma função grande: o teste recorta só o trecho da espera pelo painel, tira os tipos do TypeScript e roda com window/document falsos.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { stripTypeScriptTypes } = require("node:module");

const fonte = fs.readFileSync(path.join(__dirname, "../../frontend/src/aplicacao/app.ts"), "utf8");
const trecho = fonte.slice(fonte.indexOf("const scriptReact"), fonte.indexOf("context.ponteReact = "));
const trechoPonte = fonte.slice(fonte.indexOf("context.ponteReact = "), fonte.indexOf("// Ações chamadas no mesmo turno"));
const codigo = stripTypeScriptTypes(`${trecho}\n${trechoPonte}`);

function criarEmissor() {
  const ouvintes = {};
  return {
    addEventListener: (tipo, fn) => { (ouvintes[tipo] ||= []).push(fn); },
    emitir: tipo => (ouvintes[tipo] || []).splice(0).forEach(fn => fn()),
  };
}

function montar({ comScript = true } = {}) {
  const script = comScript ? criarEmissor() : null;
  const documento = { ...criarEmissor(), readyState: "interactive", querySelector: seletor => (seletor === 'script[src*="/static/dist/react-entry.js"]' ? script : null) };
  const janela = { ...criarEmissor() };
  const contexto = {};
  new Function("window", "document", "context", codigo)(janela, documento, contexto);
  return { script, janela, documento, ponte: contexto.ponteReact("painel", ["acao"]) };
}

test("script do bundle com erro rejeita a chamada pendente antes do load da janela", async () => {
  const { script, ponte } = montar();
  const espera = ponte.acao();
  script.emitir("error");
  await assert.rejects(espera, /O painel React "painel" não carregou\./);
});

test("chamada feita depois do erro do script rejeita na hora", async () => {
  const { script, ponte } = montar();
  script.emitir("error");
  await assert.rejects(ponte.acao(), /não carregou/);
});

test("com o painel publicado a ponte encaminha a ação; sem script e sem registro ela segue esperando", async () => {
  const pronto = montar();
  pronto.janela.SimpressReact = { painel: { acao: valor => `ok:${valor}` } };
  assert.equal(await pronto.ponte.acao(1), "ok:1");

  const pendente = montar({ comScript: false });
  let terminou = false;
  pendente.ponte.acao().then(() => { terminou = true; }, () => { terminou = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(terminou, false, "sem erro nem load a chamada continua pendente");
});

test("painel sob demanda: chamada antes do bundle espera, download que falha rejeita e a próxima chamada tenta de novo", async () => {
  const { janela, documento, ponte } = montar();
  let tentativas = 0;
  const carregar = async () => {
    tentativas += 1;
    if (tentativas === 1) throw new Error("rede");
    return { acao: valor => `sob-demanda:${valor}` };
  };
  const antesDoBundle = ponte.acao(1);
  janela.SimpressReact = {};
  janela.SimpressReactSobDemanda = { painel: carregar };
  documento.emitir("simpress:react-pronto");
  await assert.rejects(antesDoBundle, /O painel React "painel" não carregou\./);
  assert.equal(await ponte.acao(2), "sob-demanda:2");
  assert.equal(tentativas, 2);
});
