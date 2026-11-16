const assert = require("node:assert/strict");
const test = require("node:test");

const { criarAcoesCartaoEquipamento } = require("../../frontend/src/paineis/cartao-equipamento/estado.ts");

test("atualizarUsuarioLogadoCard usa os elementos reais da página sem recursão", () => {
  const elementos = new Map();
  const classeList = { toggle() {} };
  const criarElemento = () => ({
    textContent: "", title: "", value: "", classList: classeList,
    setAttribute() {}, removeAttribute() {},
  });
  const documentoAnterior = global.document;
  global.document = {
    getElementById(id) {
      if (!elementos.has(id)) elementos.set(id, criarElemento());
      return elementos.get(id);
    },
  };

  try {
    const app = {
      apiFetch: async () => ({}), showToast() {}, definirEquipamentoAtual() {}, exibirEquipamento() {},
      atualizarIndicadoresPosSalvamento() {}, atualizarObrigatoriedadeDuracaoPausaEntrega() {},
      fecharModalEditarEquipamento() {}, fecharModalEditarApelido() {},
    };
    const acoes = criarAcoesCartaoEquipamento({
      app, appState: { currentEquipamento: null }, ponteReact: () => ({}),
    });

    acoes.atualizarUsuarioLogadoCard({ serial: "SINT-001", usuarios_logados: "operador-sintetico" });

    assert.equal(elementos.get("card-usuarios-logados").textContent, "operador-sintetico");
  } finally {
    global.document = documentoAnterior;
  }
});
