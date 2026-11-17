// Cobertura (F10), estado do painel React com apiFetch falso e dados sintéticos:
// resposta 2xx com corpo ilegível relê a lista como o código antigo, e o envio repetido do mesmo formulário é ignorado.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

// estado.ts e vinculo.ts importam o apiFetch em tempo de execução: redireciona "../../api" para o fake publicado em globalThis.
const PAINEIS = /paineis[\/](cobertura|historico-transferencias)[\/][^\/]+\.ts$/;
Module.registerHooks({
  resolve(especificador, contexto, proximo) {
    const daqui = PAINEIS.test(contexto.parentURL || "");
    if (especificador === "../../api" && daqui) {
      return { url: "simpress-teste:api", format: "module", shortCircuit: true };
    }
    // import relativo sem extensão: o Node não completa ".ts" sozinho
    if (daqui && /^\.\.?\/[\w\-\/]+$/.test(especificador)) return proximo(`${especificador}.ts`, contexto);
    return proximo(especificador, contexto);
  },
  load(url, contexto, proximo) {
    if (url === "simpress-teste:api") {
      return { format: "module", shortCircuit: true, source: "export const apiFetch = (...argumentos) => globalThis.__apiFetchFalso(...argumentos);" };
    }
    return proximo(url, contexto);
  },
});

const toasts = [];
const chamadas = [];
let respostas = [];
global.window = {
  showToast: (texto, tipo) => toasts.push({ texto, tipo }),
};
// Fila de respostas: cada item vira uma Response falsa (2xx), um erro de API (status) ou uma queda de rede.
globalThis.__apiFetchFalso = async (url, opcoes = {}) => {
  chamadas.push({ url, metodo: opcoes.method || "GET", responseType: opcoes.responseType });
  const proxima = respostas.shift();
  assert.ok(proxima, `sem resposta preparada para ${opcoes.method || "GET"} ${url}`);
  if (proxima.rede) throw new TypeError("Failed to fetch");
  if (proxima.status >= 400) throw Object.assign(new Error("erro"), { status: proxima.status, data: proxima.corpo ?? null });
  return { ok: true, status: proxima.status ?? 200, text: async () => proxima.texto ?? "" };
};
const estado = require(path.resolve(__dirname, "../../frontend/src/paineis/cobertura/estado.ts"));

const DADOS = JSON.stringify({ hoje: "2026-11-17", vagas: [], contagens: {} });
const LEITURA = { texto: DADOS };

function reiniciar(...fila) {
  toasts.length = 0;
  chamadas.length = 0;
  respostas = fila;
}

test("a primeira leitura carrega os dados que liberam a escrita", async () => {
  reiniciar(LEITURA);
  assert.equal(await estado.carregarCobertura(), true);
  assert.ok(estado.ler().dados);
  assert.equal(estado.ler().bloqueado, false);
});

test("2xx com corpo ilegível conta como sucesso, relê a lista e avisa como no código antigo", async () => {
  for (const texto of ["<html>truncado", "{\"a\":", "", "[]"]) {
    reiniciar({ status: 200, texto }, LEITURA);
    const retorno = await estado.escrever("/api/cobertura/demandas", { cidade: "Sintética" }, "Necessidade registrada.");
    assert.deepEqual(retorno, {}, `corpo ${JSON.stringify(texto)} devolve {} (truthy) como o antigo`);
    assert.deepEqual(chamadas.map(c => c.metodo), ["POST", "GET"], `corpo ${JSON.stringify(texto)} relê a lista`);
    assert.ok(chamadas.every(c => c.responseType === "response"));
    assert.deepEqual(toasts, [{ texto: "Necessidade registrada.", tipo: "success" }]);
  }
});

test("2xx com JSON legível devolve o corpo", async () => {
  reiniciar({ status: 201, texto: JSON.stringify({ id: "d-1", rev: 1 }) }, LEITURA);
  const retorno = await estado.escrever("/api/cobertura/demandas", {}, "Necessidade registrada.");
  assert.deepEqual(retorno, { id: "d-1", rev: 1 });
});

test("queda de rede não relê a lista e mostra o erro de sem resposta", async () => {
  reiniciar({ rede: true });
  assert.equal(await estado.escrever("/api/cobertura/demandas", {}, "ok"), null);
  assert.deepEqual(chamadas.map(c => c.metodo), ["POST"]);
  assert.deepEqual(toasts, [{ texto: "Sem resposta do servidor local. Tente de novo.", tipo: "error" }]);
});

test("409 relê a lista e mostra a mensagem do servidor; 422 não relê", async () => {
  reiniciar({ status: 409, corpo: { detail: "Registro mudou." } }, LEITURA);
  assert.equal(await estado.escrever("/api/cobertura/demandas", {}, "ok"), null);
  assert.deepEqual(chamadas.map(c => c.metodo), ["POST", "GET"]);
  assert.deepEqual(toasts, [{ texto: "Registro mudou.", tipo: "error" }]);

  reiniciar({ status: 422, corpo: { detail: "Cidade obrigatória." } });
  assert.equal(await estado.escrever("/api/cobertura/demandas", {}, "ok"), null);
  assert.deepEqual(chamadas.map(c => c.metodo), ["POST"]);
});

test("envio repetido do mesmo formulário roda uma vez; outro formulário e um novo envio rodam", async () => {
  const formA = {};
  const formB = {};
  let rodou = 0;
  let liberar;
  const trava = new Promise(resolve => { liberar = resolve; });

  const primeiro = estado.semRepetir(formA, async () => { rodou += 1; await trava; });
  const repetido = estado.semRepetir(formA, async () => { rodou += 10; }); // duplo clique ou Enter repetido
  const outro = estado.semRepetir(formB, async () => { rodou += 100; });
  await repetido;
  await outro;
  assert.equal(rodou, 101, "o segundo envio de A foi ignorado; B rodou");
  liberar();
  await primeiro;

  await estado.semRepetir(formA, async () => { rodou += 1000; });
  assert.equal(rodou, 1101, "depois do primeiro terminar, A aceita novo envio");
});

test("a trava solta o formulário quando a gravação lança erro", async () => {
  const form = {};
  await assert.rejects(estado.semRepetir(form, async () => { throw new Error("falhou"); }), /falhou/);
  let rodou = false;
  await estado.semRepetir(form, async () => { rodou = true; });
  assert.equal(rodou, true);
});

test("os três formulários de escrita passam pela trava e os alertas não usam o índice como key", () => {
  const fonte = fs.readFileSync(path.resolve(__dirname, "../../frontend/src/paineis/cobertura/painel.tsx"), "utf8");
  for (const manipulador of ["registrarNecessidade", "registrarDisponibilidade", "registrarDevolucao"]) {
    const corpo = fonte.split(`async function ${manipulador}(`)[1].split("\nasync function ")[0].split("\nfunction ")[0];
    assert.match(corpo, /const form = event\.currentTarget;/, `${manipulador} lê o formulário antes de qualquer await`);
    assert.match(corpo, /await semRepetir\(form, async \(\) => \{/, `${manipulador} usa semRepetir`);
  }
  assert.ok(!/alertas\.map\(\(alerta, n\)/.test(fonte) && !/key=\{n\}/.test(fonte), "alerta com key por índice");
  assert.match(fonte, /key=\{`\$\{alerta\.tipo\}-\$\{alerta\.movimentacaoId \?\? ""\}`\}/);
});
