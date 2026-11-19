// Chamados: regras puras do painel React (frontend/src/paineis/cockpit-chamados/cockpit-chamados-puro.ts, carregado
// direto pelo require do Node, sem build). As três regras de chamado (regras-chamados/regras.ts) entram por parâmetro: aqui vão as reais.
// O que aparece na tela (cliques, portais, requisições, corrida de respostas) é testado no navegador:
// tests/e2e/react-g8.spec.cjs.
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { criarRegrasChamados } = require("../../frontend/src/paineis/regras-chamados/regras.ts");

const puro = require(path.resolve(__dirname, "../../frontend/src/paineis/cockpit-chamados/cockpit-chamados-puro.ts"));

const dom = { escapeHtml: value => String(value), pluralize: (count, one, many) => (count === 1 ? one : many) };
const regras = criarRegrasChamados(dom);
const formatar = valor => `fmt(${valor})`;

const historico = [
  { id: "s3", atualizado_em: "2026-10-31", fontes: { simpress: "a.xlsx", oracle: { arquivo: "b.xlsx" } } },
  { id: "s2", atualizado_em: "2026-10-30" },
  { id: "s1", atualizado_em: "2026-10-29" },
];

test("rótulo da importação: horário e os nomes dos dois arquivos, texto ou objeto", () => {
  assert.equal(puro.rotuloImportacao(historico[0], formatar), "fmt(2026-10-31) · a.xlsx + b.xlsx");
  assert.equal(puro.rotuloImportacao(historico[1], formatar), "fmt(2026-10-30)");
  assert.equal(puro.rotuloImportacao({ atualizado_em: "x", fontes: { oracle: "so-oracle.xlsx" } }, formatar), "fmt(x) · so-oracle.xlsx");
});

test("versão em uso: mantém a escolhida se existe; senão a da tabela, senão a mais recente, senão vazio", () => {
  assert.equal(puro.versaoAposCarga(historico, "s2", "s3"), "s2");
  assert.equal(puro.versaoAposCarga(historico, "sumiu", "s1"), "s1");
  assert.equal(puro.versaoAposCarga(historico, "sumiu", undefined), "s3");
  assert.equal(puro.versaoAposCarga([], "", undefined), "");
});

test("rótulos de importações antigas no singular e no plural", () => {
  assert.equal(puro.rotuloImportacoesAntigas(1), "1 importação antiga");
  assert.equal(puro.rotuloImportacoesAntigas(3), "3 importações antigas");
  assert.equal(puro.rotuloImportacoesRemovidas(1), "1 importação antiga removida");
  assert.equal(puro.rotuloImportacoesRemovidas(2), "2 importações antigas removidas");
});

test("exportar: com a lista de séries da tela vai por POST; sem lista, o GET antigo", () => {
  const post = puro.pedidoExportacao("s2", "Maria", true, "conferida", ["SN-1", "SN-2"]);
  assert.equal(post.endpoint, "/api/operacoes/chamados/exportar");
  assert.equal(post.metodo, "POST");
  assert.deepEqual(JSON.parse(post.corpo), { snapshot_id: "s2", series: ["SN-1", "SN-2"], search: "Maria", relation: "conferida", attention_only: true });
  assert.equal(JSON.parse(puro.pedidoExportacao("s2", "", false, "todos", []).corpo).relation, "", "relação todos vira vazio");
  assert.deepEqual(JSON.parse(puro.pedidoExportacao("s2", "", false, "todos", []).corpo).series, [], "lista vazia segue vazia");
  const get = puro.pedidoExportacao("s1", "Maria", true, "todos", null);
  assert.equal(get.metodo, "GET");
  assert.equal(get.corpo, undefined);
  assert.equal(get.endpoint, "/api/operacoes/chamados/exportar?snapshot_id=s1&stale_days=3&search=Maria&attention_only=true");
  assert.equal(puro.pedidoExportacao("s1", "", false, "todos", undefined).endpoint, "/api/operacoes/chamados/exportar?snapshot_id=s1&stale_days=3");
});

test("exportar: nome do arquivo vem do cabeçalho e cai no padrão quando falta", () => {
  assert.equal(puro.nomeArquivoExportado('attachment; filename="Chamados_2026.xlsx"'), "Chamados_2026.xlsx");
  assert.equal(puro.nomeArquivoExportado("attachment; filename=Outro.xlsx"), "Outro.xlsx");
  assert.equal(puro.nomeArquivoExportado(""), "Acompanhamento_de_Chamados.xlsx");
});

test("Home: só chamados Oracle abertos da série, OS maior primeiro, encerrados e outras séries fora", () => {
  const relatorio = {
    chamados: [
      { serie: "OUTRA", oracle: [{ solicitacao: "SR-OUTRA", ordem_servico: "9", status: "Em atendimento" }] },
      { serie: "5cg6051bvn", oracle: [
        { solicitacao: "SR-1", ordem_servico: "100", status: "Em atendimento", fila: "Deslocamento", cidade: "Curitiba" },
        { solicitacao: "SR-2", ordem_servico: "200", status: "Aguardando", sub_status: "Laudo pendente" },
        { solicitacao: "SR-3", ordem_servico: "300", status: "Concluído" },
      ] },
    ],
  };
  const { abertos, serie } = puro.chamadosAbertosDaSerie(relatorio, "5CG6051BVN", regras);
  assert.deepEqual(abertos.map(ticket => ticket.ordem_servico), ["200", "100"]);
  assert.equal(serie, "5cg6051bvn", "mostra a série como está no registro");
  assert.equal(puro.statusDoChamado(abertos[0]), "Aguardando · Laudo pendente");
  assert.equal(puro.statusDoChamado(abertos[1]), "Em atendimento");
  assert.equal(puro.statusDoChamado({}), "Status não informado");
  const vazio = puro.chamadosAbertosDaSerie({ chamados: [] }, "SEM-CHAMADO", regras);
  assert.deepEqual(vazio, { abertos: [], serie: "SEM-CHAMADO" });
  assert.deepEqual(puro.chamadosAbertosDaSerie({}, "S1", regras).abertos, [], "relatório sem lista de chamados");
});

test("Home: chamados do F5 não finalizados da série, com o texto de cada linha", () => {
  const dados = {
    importado: {
      finalizados: [{ numero: "UTIC-2026-3" }],
      abertos: [
        { numero: "UTIC-2026-1", titulo: "Notebook lento", automaticos: { K: "5cg6051bvn" } },
        { numero: "UTIC-2026-3", titulo: "Já finalizado", automaticos: { K: "5CG6051BVN" } },
        { numero: "linha:7", chamado: "", titulo: "Sem número", automaticos_sugeridos: { K: "5CG6051BVN" } },
        { numero: "linha:8", chamado: "UTIC-2026-8", titulo: "Com número", automaticos_sugeridos: { K: "5CG6051BVN" } },
        { numero: "UTIC-2026-9", titulo: "Outra série", automaticos: { K: "OUTRA" } },
      ],
    },
    novos: { formulario: [{ numero: "UTIC-2026-2", linha: { G: "Novo chamado", K: "5CG6051BVN" } }] },
  };
  const achados = puro.chamadosSebraeDaSerie(dados, "5CG6051BVN", regras);
  assert.deepEqual(achados.map(puro.textoChamadoSebrae), [
    "UTIC-2026-1 · Notebook lento", "Sem UTIC · Sem número", "UTIC-2026-8 · Com número", "UTIC-2026-2 · Novo chamado",
  ]);
  assert.ok(!achados.some(item => /Já finalizado|Outra série/.test(item.titulo)));
  assert.equal(achados.find(item => item.titulo === "Sem número").chave, "linha:7", "a chave continua a do F5 para abrir a linha");
  assert.deepEqual(puro.chamadosSebraeDaSerie(null, "S1", regras), []);
  assert.deepEqual(puro.chamadosSebraeDaSerie({}, "S1", regras), []);
});

test("Home: contagens e rótulos, com e sem falha na consulta do F5", () => {
  assert.equal(puro.rotuloContagemHome(0, false), "");
  assert.equal(puro.rotuloContagemHome(1, false), "1 aberto");
  assert.equal(puro.rotuloContagemHome(2, false), "2 abertos");
  assert.equal(puro.rotuloContagemHome(3, false), "3 abertos");
  assert.equal(puro.rotuloContagemHome(1, true), "1 aberto · consulta parcial");
  assert.equal(puro.rotuloContagemHome(0, true), "Consulta parcial");
  assert.equal(puro.rotuloChamadosSebrae(1), "1 chamado na aba Chamados (F5)");
  assert.equal(puro.rotuloChamadosSebrae(3), "3 chamados na aba Chamados (F5)");
});
