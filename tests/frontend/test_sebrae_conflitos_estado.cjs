// Conflitos de edição do Dashboard (F5): estado do painel React com a API falsa. O estado.ts importa o apiFetch em
// tempo de execução e guarda window ao carregar, então o teste redireciona "../../api" para uma API falsa
// (module.registerHooks) e cria window antes do require. O estado do módulo é compartilhado entre os testes do
// arquivo: cada um começa com uma lista vazia (reiniciar) e usa ids próprios.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

Module.registerHooks({
  resolve(especificador, contexto, proximo) {
    if (especificador === "../../api" && /sebrae-conflitos[\\/]estado\.ts$/.test(contexto.parentURL || "")) {
      return { url: "simpress-teste:api", format: "module", shortCircuit: true };
    }
    return proximo(especificador, contexto);
  },
  load(url, contexto, proximo) {
    if (url === "simpress-teste:api") {
      return { format: "module", shortCircuit: true, source: "export const apiFetch = (...argumentos) => globalThis.__apiFetchFalso(...argumentos);" };
    }
    return proximo(url, contexto);
  },
});

const app = { showToast() {}, atualizarEstadoAutomacao() {}, carregarNovosSebrae() {} };
global.window = app; // o módulo guarda esta referência: troque as ações no objeto, não o objeto
const estado = require(path.resolve(__dirname, "../../frontend/src/paineis/sebrae-conflitos/estado.ts"));

const AVISO_PAROU = "O envio parou de novo e ainda há conflitos. Confira a lista e escolha outra vez.";
const TOAST_OK = "Conflitos resolvidos e Dashboard enviado ao SharePoint.";
const celula = (id, extra = {}) => ({ id, tipo: "celula", chamado: "UTIC-2026-1", coluna: "G", sharepoint: "A", site: "B", ...extra });
const vazia = { conflitos: [], escolhas: {}, versao_importacao: "v0" };

// Respostas por rota; cada uma é função (opcoes) => valor | Promise.
let rota = {};
globalThis.__apiFetchFalso = async (url, opcoes = {}) => {
  if (url === "/api/automacao/estado") return rota.automacao(opcoes);
  return opcoes.method === "POST" ? rota.post(opcoes) : rota.get(opcoes);
};

const drenar = async () => { for (let i = 0; i < 20; i += 1) await new Promise(resolver => setImmediate(resolver)); };

async function reiniciar() {
  rota = { get: () => vazia };
  app.showToast = () => {};
  app.atualizarEstadoAutomacao = () => {};
  app.carregarNovosSebrae = () => {};
  await estado.carregarConflitosSebrae();
}

// Como o clique em "Salvar escolhas e reenviar": POST iniciado e a rotina enviar termina na primeira consulta (3 s).
async function enviarEAcabar(t, { ultima, aposPost } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  rota.post = () => ({ enviar: { iniciado: true, motivo: "" } });
  rota.automacao = () => ({ estado: "livre", rotina: "enviar", ultima: ultima ?? { status: "erro" } });
  await estado.salvarEReenviar();
  assert.equal(estado.ler().status, "Escolhas salvas. Reenviando ao SharePoint…");
  aposPost?.();
  t.mock.timers.tick(3000);
  await drenar();
}

test("escolhasParaEnviar: só ids da lista atual com valor válido; site nunca sai onde não é aceito", () => {
  const conflitos = [celula("a"), celula("b", { aceita_site: true }), celula("c", { aceita_site: false }), celula("d")];
  const corpo = estado.escolhasParaEnviar(conflitos, {
    a: "site", // aceita_site ausente: aceita os dois
    b: "site",
    c: "site", // linha incerta: o servidor recusa, não pode sair
    d: "talvez", // valor inválido
    fora: "sharepoint", // id que não está mais na lista
  });
  assert.deepEqual(corpo, { a: "site", b: "site" });
  assert.deepEqual(estado.escolhasParaEnviar([celula("c", { aceita_site: false })], { c: "sharepoint" }), { c: "sharepoint" });
  assert.deepEqual(estado.escolhasParaEnviar([celula("e")], {}), {});
  assert.deepEqual(estado.escolhasParaEnviar([celula("e")], { e: undefined }), {});
});

test("layout C: legenda curta, valor de cada opção e consequência da escolha no resumo", () => {
  const apagada = { id: "z", tipo: "linha_apagada", chamado: "UTIC-2026-2", coluna: "D,R", sharepoint: "", site: "D: FINALIZADO; R: 01/11/2026" };
  assert.equal(estado.textoDoConflito(celula("a", { coluna: "D" })), "UTIC-2026-1 · coluna D");
  assert.equal(estado.textoDoConflito(apagada), "UTIC-2026-2 · linha apagada no SharePoint, editada no site");
  assert.equal(estado.rotuloCurto(celula("a")), "UTIC-2026-1 · G");
  assert.equal(estado.rotuloCurto(apagada), "UTIC-2026-2");
  assert.equal(estado.valorDaOpcao(celula("a"), "sharepoint"), "A");
  assert.equal(estado.valorDaOpcao(celula("a", { site: " " }), "site"), "(vazio)");
  assert.equal(estado.valorDaOpcao(celula("a", { site: "x".repeat(400) }), "site"), `${"x".repeat(300)}…`);
  assert.equal(estado.valorDaOpcao(apagada, "site"), "", "linha apagada não mostra o valor junto da opção");
  assert.equal(estado.consequencia(celula("a"), "sharepoint"), 'fica "A"');
  assert.equal(estado.consequencia(celula("a"), "site"), 'vira "B"');
  assert.equal(estado.consequencia(celula("a", { site: "" }), "site"), "vira (vazio)");
  assert.equal(estado.consequencia(apagada, "sharepoint"), "a linha continua apagada");
  assert.equal(estado.consequencia(apagada, "site"), "a linha volta com os dados do site");
  assert.equal(estado.consequencia(celula("a"), undefined), "falta escolher");
  // a tela passa a escolha válida: site gravado onde não é aceito não conta
  const restrito = celula("c", { aceita_site: false });
  assert.equal(estado.consequencia(restrito, estado.escolhasParaEnviar([restrito], { c: "site" }).c), "falta escolher");
});

test("fim do envio com conflitos: 'O envio parou de novo…' sobrevive à releitura da lista e sai na próxima escolha", async t => {
  await reiniciar();
  const lista = { conflitos: [celula("t8")], escolhas: { t8: "site" }, versao_importacao: "v1" };
  rota.get = () => lista;
  await estado.carregarConflitosSebrae();
  // O Dashboard antigo relê os conflitos ao carregar os novos chamados (sebrae-dashboard/estado.ts).
  app.carregarNovosSebrae = () => { void estado.carregarConflitosSebrae(); };
  await enviarEAcabar(t);
  assert.equal(estado.ler().status, AVISO_PAROU);
  assert.equal(estado.ler().ocupado, false);
  estado.escolher("t8", "sharepoint"); // nova escolha: volta a contagem normal
  assert.equal(estado.ler().status, "");
});

test("fim do envio: decide pela lista que a própria consulta leu, mesmo se outra consulta tomou a vez", async t => {
  await reiniciar();
  const toasts = [];
  rota.get = () => ({ conflitos: [celula("t9")], escolhas: { t9: "site" }, versao_importacao: "v1" });
  await estado.carregarConflitosSebrae();
  app.showToast = (mensagem, tipo) => toasts.push([mensagem, tipo]);
  const retidos = [];
  await enviarEAcabar(t, {
    ultima: { status: "concluido" },
    aposPost: () => { rota.get = () => new Promise(resolver => retidos.push(resolver)); }, // GETs ficam retidos
  });
  assert.equal(retidos.length, 1, "o GET do fim do envio está pendente");
  const outra = estado.carregarConflitosSebrae(); // ex.: o polling da Automação chama carregarNovosSebrae
  await drenar();
  assert.equal(retidos.length, 2);
  retidos[0]({ conflitos: [], escolhas: {}, versao_importacao: "v2" }); // a do fim volta vazia, já descartada para a tela
  await drenar();
  assert.deepEqual(toasts, [[TOAST_OK, "success"]]);
  assert.notEqual(estado.ler().status, AVISO_PAROU);
  assert.equal(estado.ler().ocupado, false);
  retidos[1]({ conflitos: [], escolhas: {}, versao_importacao: "v2" });
  await outra;
  assert.deepEqual(estado.ler().conflitos, []);
});

test("GET de conflitos sem resposta tem prazo de 15 s e o painel deixa de ficar ocupado", async t => {
  await reiniciar();
  rota.get = () => ({ conflitos: [celula("t10")], escolhas: { t10: "site" }, versao_importacao: "v1" });
  await estado.carregarConflitosSebrae();
  await enviarEAcabar(t, {
    aposPost: () => {
      // O servidor trava: só o sinal de prazo encerra o GET (sem sinal, ele fica pendurado para sempre).
      rota.get = ({ signal }) => new Promise((_, rejeitar) => {
        signal?.addEventListener("abort", () => {
          // AbortError: o apiFetch não trata como servidor offline (TimeoutError faria a Home mostrar "Offline").
          assert.equal(signal.reason.name, "AbortError");
          rejeitar(signal.reason);
        });
      });
    },
  });
  assert.equal(estado.ler().ocupado, true, "esperando a lista nova");
  t.mock.timers.tick(14999);
  await drenar();
  assert.equal(estado.ler().ocupado, true, "ainda dentro do prazo");
  t.mock.timers.tick(1);
  await drenar();
  assert.equal(estado.ler().ocupado, false);
  assert.equal(estado.ler().status, AVISO_PAROU, "sem lista nova, vale a da tela (como antes)");
  assert.equal(estado.ler().conflitos.length, 1);
});
