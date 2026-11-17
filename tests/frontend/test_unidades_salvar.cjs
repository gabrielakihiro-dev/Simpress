// Catálogo de unidades (F-Catálogo), salvarUnidadeForm do painel React com a API falsa e dados sintéticos:
// duplo clique ou Enter repetido não envia a gravação duas vezes, e a trava solta depois de sucesso e de falha.
// acoes.ts importa o apiFetch em tempo de execução e imports relativos sem extensão: o teste redireciona
// "../../api" para uma API falsa e completa ".ts" (module.registerHooks), e cria window/document antes do require.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const dentroDeUnidades = (parentURL) => /paineis[\/]unidades[\/]/.test(parentURL || "");
Module.registerHooks({
  resolve(especificador, contexto, proximo) {
    if (especificador === "../../api" && dentroDeUnidades(contexto.parentURL)) {
      return { url: "simpress-teste:api", format: "module", shortCircuit: true };
    }
    if (/^\.{1,2}\/(?:\.\.\/)*[^./]+$/.test(especificador) && dentroDeUnidades(contexto.parentURL)) {
      return proximo(`${especificador}.ts`, contexto); // import relativo sem extensão: o Node não completa ".ts"
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

const toasts = [];
const campos = {
  "form-unidade-cidade": { value: "Cidade Sintética" },
  "form-unidade-endereco": { value: "Rua Exemplo, 100" },
  "form-unidade-cep": { value: "00000-000" },
  "form-unidade-cnpj": { value: "00.000.000/0001-00" },
  "form-unidade-id": { value: "" },
};
global.document = { getElementById: (id) => campos[id] || null, activeElement: null };
global.window = {
  showToast: (texto, tipo) => toasts.push({ texto, tipo }),
  SimpressApp: { state: { unidadesList: [] } },
};
const chamadas = [];
let liberar = null; // se definido, o POST de salvar espera esta promessa
let falhar = null; // se definido, o POST de salvar lança este erro
globalThis.__apiFetchFalso = async (url, opcoes = {}) => {
  chamadas.push({ url, metodo: opcoes.method || "GET" });
  if (url === "/api/unidade/salvar") {
    if (liberar) await liberar;
    if (falhar) throw falhar;
    return { mensagem: "Unidade salva com sucesso!" };
  }
  return []; // GET /api/unidades e o recarregamento do Cockpit
};
const { salvarUnidadeForm } = require(path.resolve(__dirname, "../../frontend/src/paineis/unidades/acoes.ts"));

const posts = () => chamadas.filter(c => c.url === "/api/unidade/salvar").length;
function reiniciar() {
  chamadas.length = 0;
  toasts.length = 0;
  liberar = null;
  falhar = null;
}

test("duplo clique ou Enter repetido na unidade envia uma gravação só", async () => {
  reiniciar();
  let soltar;
  liberar = new Promise(resolver => { soltar = resolver; });
  const primeiro = salvarUnidadeForm();
  const segundo = salvarUnidadeForm(); // segundo clique enquanto o primeiro espera a API
  const terceiro = salvarUnidadeForm(); // Enter repetido
  await new Promise(resolver => setImmediate(resolver));
  assert.equal(posts(), 1, "só o primeiro disparo chegou à API");
  soltar();
  await Promise.all([primeiro, segundo, terceiro]);
  assert.equal(posts(), 1);
  assert.ok(toasts.some(t => t.tipo === "success"));
});

test("depois do sucesso a trava solta e uma nova gravação é enviada", async () => {
  reiniciar();
  await salvarUnidadeForm();
  assert.equal(posts(), 1);
  await salvarUnidadeForm();
  assert.equal(posts(), 2);
});

test("depois de uma falha da API a trava solta, o erro é avisado e a nova tentativa envia", async () => {
  reiniciar();
  falhar = new Error("Erro ao salvar unidade.");
  const silenciar = console.error;
  console.error = () => {};
  try {
    await salvarUnidadeForm();
  } finally {
    console.error = silenciar;
  }
  assert.deepEqual(toasts, [{ texto: "Erro ao salvar unidade.", tipo: "error" }]);
  falhar = null;
  await salvarUnidadeForm();
  assert.equal(posts(), 2);
});

test("campos obrigatórios vazios avisam e não travam nem enviam", async () => {
  reiniciar();
  campos["form-unidade-cidade"].value = "";
  await salvarUnidadeForm();
  assert.equal(posts(), 0);
  assert.deepEqual(toasts, [{ texto: "Cidade, endereço e CNPJ são campos obrigatórios.", tipo: "warning" }]);
  campos["form-unidade-cidade"].value = "Cidade Sintética";
  await salvarUnidadeForm();
  assert.equal(posts(), 1, "a validação não deixou a trava presa");
});
