// Pesquisa completa (Home F1): regras puras de frontend/src/paineis/pesquisa-completa/pesquisa-completa-puro.ts,
// carregado direto pelo require do Node. O diálogo (tela, pedidos, resposta tardia) é testado no navegador:
// tests/e2e/react-g10.spec.cjs. Dados sintéticos.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const arquivo = path.join(__dirname, "../../frontend/src/paineis/pesquisa-completa/pesquisa-completa-puro.ts");
const puro = require(arquivo);

test("o arquivo puro não importa nada e não usa any (o Node o carrega sem build)", () => {
  const fonte = fs.readFileSync(arquivo, "utf8");
  assert.doesNotMatch(fonte, /^\s*import\s/m);
  assert.doesNotMatch(fonte, /:\s*any\b|\bas any\b|<any>/);
});

test("lerTermo tira as pontas e só dois caracteres abrem a pesquisa", () => {
  assert.equal(puro.lerTermo("  BRJ  "), "BRJ");
  assert.equal(puro.lerTermo(undefined), "");
  assert.equal(puro.termoValido(puro.lerTermo(" a ")), false);
  assert.equal(puro.termoValido(puro.lerTermo(" ab ")), true);
  assert.equal(puro.termoExibido(""), "Todos os equipamentos");
  assert.equal(puro.termoExibido("BRJ"), "BRJ");
});

test("montarParametros mantém a ordem q, offset, limit, include_filters e só leva filtros preenchidos", () => {
  const sem = puro.montarParametros({ query: "BRJ", categoria: "", cidade: "", usuario: "" }, 0);
  assert.equal(sem, "q=BRJ&offset=0&limit=50&include_filters=true");
  const com = puro.montarParametros({ query: "a b", categoria: "notebook", cidade: "Maringá", usuario: "com" }, 50);
  assert.deepEqual([...new URLSearchParams(com).keys()], ["q", "offset", "limit", "include_filters", "categoria", "cidade", "usuario"]);
  assert.equal(new URLSearchParams(com).get("q"), "a b");
  assert.equal(new URLSearchParams(com).get("offset"), "50");
  assert.equal(new URLSearchParams(com).get("cidade"), "Maringá");
});

test("textos de contagem e de status seguem os aprovados", () => {
  assert.equal(puro.textoContagem(1), "1 resultado");
  assert.equal(puro.textoContagem(0), "0 resultados");
  assert.equal(puro.textoContagem(12), "12 resultados");
  assert.equal(puro.textoStatus(0, 0, false, "BRJ"), "Nenhum equipamento encontrado para esse termo.");
  assert.equal(puro.textoStatus(0, 0, false, ""), "Nenhum equipamento a listar.");
  assert.equal(puro.textoStatus(120, 50, true, "BRJ"), "Exibindo 50 de 120 resultados.");
  assert.equal(puro.textoStatus(1, 1, false, "BRJ"), "O único resultado foi exibido.");
  assert.equal(puro.textoStatus(7, 7, false, "BRJ"), "Todos os 7 resultados foram exibidos.");
  assert.equal(puro.pluralizar(1, "resultado"), "resultado");
  assert.equal(puro.pluralizar(2, "resultado"), "resultados");
});

test("textos aprovados da falha de pesquisa não mudam", () => {
  assert.equal(puro.TEXTO.buscando, "Buscando...");
  assert.equal(puro.TEXTO.erroStatus, "Não foi possível carregar a pesquisa. Feche a janela e tente novamente.");
  assert.equal(puro.TEXTO.digiteMinimo, "Digite ao menos 2 caracteres para pesquisar.");
});

test("opcoesCategoria usa as categorias do servidor com contagem e cai nas padrão sem lista", () => {
  const servidor = puro.opcoesCategoria([{ value: "notebook", label: "Notebooks", count: 4 }, { value: "monitor", label: "Monitores" }], "monitor");
  assert.deepEqual(servidor.opcoes, [{ valor: "notebook", rotulo: "Notebooks (4)" }, { valor: "monitor", rotulo: "Monitores" }]);
  assert.equal(servidor.valor, "monitor");
  assert.equal(puro.opcoesCategoria([{ value: "notebook", label: "Notebooks" }], "fone").valor, "", "categoria que sumiu da lista volta para Todas");
  const padrao = puro.opcoesCategoria(undefined, "macbook");
  assert.deepEqual(padrao.opcoes.map(opcao => opcao.valor), ["notebook", "macbook", "monitor", "fone"]);
  assert.equal(padrao.valor, "macbook");
});

test("opcoesCidade e opcoesUsuario", () => {
  assert.deepEqual(puro.opcoesCidade(["Curitiba", "Maringá"], "Maringá"), {
    opcoes: [{ valor: "Curitiba", rotulo: "Curitiba" }, { valor: "Maringá", rotulo: "Maringá" }], valor: "Maringá",
  });
  assert.equal(puro.opcoesCidade(["Curitiba"], "Londrina").valor, "");
  assert.deepEqual(puro.opcoesCidade(undefined, "x"), { opcoes: [], valor: "" });
  assert.deepEqual(puro.opcoesUsuario({ sem: 2, com: 5 }), [{ valor: "sem", rotulo: "Sem usuário (2)" }, { valor: "com", rotulo: "Com usuário (5)" }]);
  assert.deepEqual(puro.opcoesUsuario(null), [{ valor: "sem", rotulo: "Sem usuário" }, { valor: "com", rotulo: "Com usuário" }]);
});

test("lerPagina exige a lista de itens e normaliza o resto", () => {
  assert.throws(() => puro.lerPagina({ total: 3 }), /Resposta inválida da pesquisa\./);
  assert.throws(() => puro.lerPagina(null), /Resposta inválida da pesquisa\./);
  const pagina = puro.lerPagina({ items: [{ serial: "A" }], total: "7", has_more: 1, filters: { cities: ["Curitiba"] } });
  assert.deepEqual(pagina, { itens: [{ serial: "A" }], total: 7, temMais: true, filtros: { cities: ["Curitiba"] } });
  assert.deepEqual(puro.lerPagina({ items: [] }), { itens: [], total: 0, temMais: false, filtros: {} });
});
