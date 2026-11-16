// Pesquisa completa (Home F1): o filtro por usuário é enviado ao servidor só quando escolhido e some ao limpar.
// Desde a migração React (Dia 2, G10) essa regra vive em frontend/src/paineis/pesquisa-completa/pesquisa-completa-puro.ts
// (carregado direto pelo require do Node); o diálogo inteiro é testado no navegador (tests/e2e/react-g10.spec.cjs).
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  decidirFiltros, filtrosAtivos, montarParametros, usuarioAoLimpar,
} = require(path.join(__dirname, "../../frontend/src/paineis/pesquisa-completa/pesquisa-completa-puro.ts"));

const parametros = (busca, offset = 0) => new URLSearchParams(montarParametros(busca, offset));
const vazia = { query: "BRJ", categoria: "", cidade: "", usuario: "" };

test("a search with a term sends the chosen user filter and can clear it", () => {
  assert.equal(parametros(vazia).get("usuario"), null);

  const escolha = { categoria: "", cidade: "", usuario: "sem" };
  assert.equal(decidirFiltros(vazia, escolha), "aplicar");
  const filtrada = { ...vazia, usuario: escolha.usuario };
  const enviados = parametros(filtrada);
  assert.equal(enviados.get("q"), "BRJ");
  assert.equal(enviados.get("usuario"), "sem");
  assert.equal(filtrosAtivos(filtrada), true, "o botão Limpar filtros aparece");

  const aoLimpar = { ...filtrada, usuario: usuarioAoLimpar(filtrada.query) };
  assert.equal(parametros(aoLimpar).get("usuario"), null);
  assert.equal(filtrosAtivos(aoLimpar), false, "o botão Limpar filtros some");
});

test("sem termo, só Sem usuário vale: é a própria listagem e Limpar volta para ele", () => {
  const listagem = { query: "", categoria: "", cidade: "", usuario: "sem" };
  assert.equal(parametros(listagem).get("usuario"), "sem");
  assert.equal(filtrosAtivos(listagem), false, "Sem usuário sozinho não é filtro a limpar");
  assert.equal(usuarioAoLimpar(""), "sem");
  assert.equal(decidirFiltros(listagem, { categoria: "", cidade: "", usuario: "com" }), "reverter", "Com usuário sem termo volta atrás");
  assert.equal(decidirFiltros(listagem, { categoria: "notebook", cidade: "", usuario: "sem" }), "aplicar");
  assert.equal(decidirFiltros(listagem, { categoria: "", cidade: "", usuario: "sem" }), "ignorar");
});
