// Painel Chamados × OS (sem DOM): quais chamados em aberto do F5 entram e como a OS do F6 é achada.
const assert = require("node:assert/strict");
const test = require("node:test");

const m = require("../../static/js/shared/chamados-os-model.js");

const sebrae = {
  importado: {
    abertos: [
      { numero: "UTIC-2026-10", chamado: "UTIC-2026-10", titulo: "Teclado falhando", automaticos: { K: "SINT-002" }, automaticos_sugeridos: { E: "OS 7002" },
        leitura_softexpert: { habilitada_em: "01/10/2026 08:00" } },
      { numero: "UTIC-2026-11", chamado: "UTIC-2026-11", titulo: "Antigo finalizado", automaticos: { K: "SINT-003", E: "7003" } },
      { numero: "linha:40", chamado: "UTIC-2026-12", titulo: "", automaticos: { E: "7004" }, automaticos_sugeridos: { K: "SINT-004" },
        leitura_softexpert: { titulo: "Título lido" } },
      { numero: "UTIC-2026-13", chamado: "UTIC-2026-13", titulo: "Antigo sem OS", automaticos: { K: "SINT-005", E: "—" } },
    ],
    finalizados: [{ numero: "UTIC-2026-11" }, { numero: "UTIC-2026-22" }],
  },
  novos: {
    formulario: [
      { numero: "UTIC-2026-20", linha: { E: "7001", K: "SINT-001", G: "Tela quebrada", P: "05/11/2026 09:30" } },
      { numero: "UTIC-2026-21", linha: { E: "", K: "SINT-006", G: "Novo sem OS" } },
      { numero: "UTIC-2026-22", linha: { E: "7009", K: "SINT-009", G: "Novo finalizado" } },
    ],
  },
};

const relatorio = {
  chamados: [
    { serie: "sint001", relacao: "conferida",
      oracle: [{ ordem_servico: "7001", status: "Aberto", sub_status: "Em análise" }, { ordem_servico: "7001", status: "Agendado" }, { ordem_servico: "8888", status: "Outra OS" }],
      simpress: { ordens_servico: ["7001"], status: ["Em atendimento"] } },
    { serie: "SINT-002", relacao: "so_simpress", oracle: [], simpress: { ordens_servico: ["OS7002"], status: ["Aguardando peça"] } },
    { serie: "SINT-004", relacao: "so_oracle", oracle: [{ ordem_servico: "9999", status: "Fechado" }], simpress: { ordens_servico: [], status: ["Não deveria aparecer"] } },
  ],
};

const vinculos = [
  { fonte: "oracle", serie: "SINT-001", os: "7001", chamado: "UTIC-2026-20", origem: "dashboard" },
  { fonte: "simpress", serie: "SINT-001", os: "7001", chamado: "UTIC-2026-20" },
  { fonte: "simpress", serie: "SINT-002", os: "OS 7002", chamado: "UTIC-2026-10", origem: "dashboard" },
];

const pares = m.montarParesChamadoOs({ sebrae, relatorio, vinculos });
const porNumero = numero => pares.find(par => par.numero === numero);

test("só entram chamados em aberto com OS, novos primeiro e na ordem da API", () => {
  assert.deepEqual(pares.map(par => [par.chave, par.situacao]), [
    ["UTIC-2026-20", "novo"], ["UTIC-2026-10", "antigo"], ["linha:40", "antigo"],
  ]);
});

test("novo com linha.E entra mesmo sem item em vinculos", () => {
  const [par] = m.montarParesChamadoOs({ sebrae, relatorio, vinculos: [] });
  assert.equal(par.chave, "UTIC-2026-20");
  assert.equal(par.vinculo, "");
  assert.deepEqual({ numero: par.numero, titulo: par.titulo, abertura: par.abertura, serie: par.serie, os: par.os },
    { numero: "UTIC-2026-20", titulo: "Tela quebrada", abertura: "05/11/2026 09:30", serie: "SINT-001", os: "7001" });
});

test("antigo com só automaticos_sugeridos.E entra e acha a OS com a normalização do F6", () => {
  const par = porNumero("UTIC-2026-10");
  assert.equal(par.os, "OS 7002");
  assert.equal(par.abertura, "01/10/2026 08:00");
  assert.equal(par.encontrada, true);
  assert.deepEqual(par.fontes, ["simpress"]);
  assert.equal(par.statusSimpress, "Aguardando peça");
  assert.equal(par.statusOracle, "");
  assert.equal(par.relacao, "so_simpress");
  assert.equal(par.registro, relatorio.chamados[1]);
});

test("finalizados (novo ou antigo) e chamados sem OS ficam fora", () => {
  for (const numero of ["UTIC-2026-11", "UTIC-2026-22", "UTIC-2026-13", "UTIC-2026-21"]) assert.equal(porNumero(numero), undefined, numero);
});

test("antigo sem UTIC na chave usa a chave linha:N e o UTIC da coluna C", () => {
  const par = pares.find(item => item.chave === "linha:40");
  assert.equal(par.numero, "UTIC-2026-12");
  assert.equal(par.titulo, "Título lido");
  assert.equal(par.serie, "SINT-004");
});

test("OS ausente no relatório: encontrada false, registro null e sem status de outra OS", () => {
  const par = pares.find(item => item.chave === "linha:40");
  assert.deepEqual([par.encontrada, par.registro, par.fontes, par.statusOracle, par.statusSimpress, par.relacao], [false, null, [], "", "", ""]);
});

test("OS em Oracle e Simpress: as duas fontes e os dois status, só os da mesma OS", () => {
  const par = porNumero("UTIC-2026-20");
  assert.deepEqual(par.fontes, ["oracle", "simpress"]);
  assert.equal(par.statusOracle, "Aberto · Em análise / Agendado");
  assert.equal(par.statusSimpress, "Em atendimento");
  assert.equal(par.relacao, "conferida");
});

test("vínculo manual vence o automático; só automático vira dashboard", () => {
  assert.equal(porNumero("UTIC-2026-20").vinculo, "manual");
  assert.equal(porNumero("UTIC-2026-10").vinculo, "dashboard");
  assert.equal(pares.find(item => item.chave === "linha:40").vinculo, "");
  // resposta do endpoint ({vinculos: [...]}) também é aceita
  assert.equal(m.montarParesChamadoOs({ sebrae, relatorio, vinculos: { vinculos } })[0].vinculo, "manual");
});

test("filtro por UTIC, série e OS sem acento e sem maiúscula", () => {
  const chaves = termo => m.filtrarParesChamadoOs(pares, termo).map(par => par.chave);
  assert.deepEqual(chaves("utic-2026-20"), ["UTIC-2026-20"]);
  assert.deepEqual(chaves("sínt-002"), ["UTIC-2026-10"]);
  assert.deepEqual(chaves("os 7002"), ["UTIC-2026-10"]);
  assert.deepEqual(chaves("7004"), ["linha:40"]);
  assert.deepEqual(chaves("  "), ["UTIC-2026-20", "UTIC-2026-10", "linha:40"]);
  assert.deepEqual(chaves("tela"), [], "título não entra na busca");
});

test("entradas nulas ou vazias devolvem lista vazia sem lançar", () => {
  assert.deepEqual(m.montarParesChamadoOs(), []);
  assert.deepEqual(m.montarParesChamadoOs(null), []);
  assert.deepEqual(m.montarParesChamadoOs({ sebrae: null, relatorio: null, vinculos: null }), []);
  assert.deepEqual(m.montarParesChamadoOs({ sebrae: { importado: null, novos: null } }), []);
  const semRelatorio = m.montarParesChamadoOs({ sebrae, relatorio: {}, vinculos: undefined });
  assert.equal(semRelatorio.length, 3);
  assert.ok(semRelatorio.every(par => par.encontrada === false && par.registro === null && par.vinculo === ""));
  assert.deepEqual(m.filtrarParesChamadoOs(null, "x"), []);
});

test("MacBook: série exata vence; sem ela, acha a outra grafia (com/sem S inicial)", () => {
  const chamado = (numero, serie) => ({ numero, linha: { E: "5001", K: serie, G: "MacBook" } });
  const registro = (serie, relacao) => ({ serie, relacao, oracle: [{ ordem_servico: "5001", status: "Aberto" }], simpress: { ordens_servico: [], status: [] } });
  const entrada = {
    sebrae: { novos: { formulario: [chamado("UTIC-2026-30", "CMVXKV7YCM"), chamado("UTIC-2026-31", "SC02XYZ"), chamado("UTIC-2026-32", "SC03ABC")] } },
    relatorio: { chamados: [registro("SCMVXKV7YCM", "com_s"), registro("C02XYZ", "sem_s"), registro("SC03ABC", "exata"), registro("C03ABC", "outra")] },
    vinculos: [],
  };
  const relacoes = m.montarParesChamadoOs(entrada).map(par => [par.numero, par.encontrada, par.relacao]);
  assert.deepEqual(relacoes, [["UTIC-2026-30", true, "com_s"], ["UTIC-2026-31", true, "sem_s"], ["UTIC-2026-32", true, "exata"]]);
});

test("Link da OS usa a grafia do relatório (como na linha da F6), mesmo com K/E escritos de outro jeito", () => {
  const entrada = {
    sebrae: { novos: { formulario: [
      { numero: "UTIC-2026-40", linha: { E: "7285 070", K: "DEMOSN001", G: "Espaço na OS" } },
      { numero: "UTIC-2026-41", linha: { E: "5001", K: "C02XYZ", G: "MacBook sem S" } },
      { numero: "UTIC-2026-42", linha: { E: "9999", K: "NAOEXISTE", G: "Fora do relatório" } },
    ] } },
    relatorio: { chamados: [
      { serie: " DEMO-SN-001 ", oracle: [], simpress: { ordens_servico: [" 7285070 "], status: [] } },
      { serie: "SC02XYZ", oracle: [{ ordem_servico: "50 01" }], simpress: { ordens_servico: [], status: [] } },
    ] },
  };
  const links = m.montarParesChamadoOs(entrada).map(par => [par.numero, par.serieRelatorio, par.osRelatorio]);
  assert.deepEqual(links, [["UTIC-2026-40", "DEMO-SN-001", "7285070"], ["UTIC-2026-41", "SC02XYZ", "50 01"], ["UTIC-2026-42", "", ""]]);
});
