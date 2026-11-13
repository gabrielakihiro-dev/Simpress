// Modelo Chamados × OS (sem DOM): quais chamados em aberto do F5 entram e como a OS do F6 é achada.
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

test("tipoVinculo: manual vence finalizacao, finalizacao vence dashboard; só vale o par chamado + série + OS", () => {
  const chamado = { numero: "UTIC-2026-30", serie: "SINT-030", os: "7030" };
  const base = { serie: "SINT-030", os: "7030", chamado: "UTIC-2026-30" };
  const tipo = itens => m.montarParesChamadoOs({
    sebrae: { novos: { formulario: [{ numero: chamado.numero, linha: { E: chamado.os, K: chamado.serie } }] } }, relatorio: null, vinculos: itens,
  })[0].vinculo;
  assert.equal(tipo([{ ...base, fonte: "oracle", origem: "finalizacao" }]), "finalizacao");
  assert.equal(tipo([{ ...base, fonte: "oracle", origem: "dashboard" }, { ...base, fonte: "simpress", origem: "finalizacao" }]), "finalizacao", "finalizacao vence dashboard");
  assert.equal(tipo([{ ...base, fonte: "oracle", origem: "finalizacao" }, { ...base, fonte: "simpress" }]), "manual", "manual vence finalizacao");
  assert.equal(tipo([{ ...base, fonte: "oracle", origem: "dashboard" }]), "dashboard");
  assert.equal(tipo([{ ...base, os: "9999", fonte: "oracle", origem: "finalizacao" }]), "", "outra OS não liga");
  assert.equal(tipo([]), "");
});

test("formatarData: só o recorte do ISO, sem mudar o dia pelo fuso; texto fora do padrão segue como veio", () => {
  assert.equal(m.formatarData("2026-11-08T10:30:00-03:00"), "08/11/2026");
  assert.equal(m.formatarData("2026-11-08T23:59:00-03:00"), "08/11/2026", "não vira o dia seguinte em UTC");
  assert.equal(m.formatarData("2026-01-02"), "02/01/2026");
  assert.equal(m.formatarData("sem data"), "sem data");
  assert.equal(m.formatarData(undefined), "");
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

test("Fallback pela OS: série vazia liga quando a OS está numa única série; OS em duas séries ou série achada sem a OS não ligam", () => {
  const chamado = (numero, serie, os) => ({ numero, linha: { E: os, K: serie, G: "Antigo" } });
  const registro = (serie, os, relacao) => ({ serie, relacao, oracle: [{ ordem_servico: os, status: "Aberto" }], simpress: { ordens_servico: [os], status: ["Em atendimento"] } });
  const entrada = {
    sebrae: { novos: { formulario: [chamado("27655", "", "7231981"), chamado("27656", "", "7300000"), chamado("27657", "SINT-050", "7231981")] } },
    relatorio: { chamados: [
      registro("SINT-040", "7231981", "conferida"), registro("sint040", "7231981", "repetida"),
      registro("SINT-041", "7300000", "a"), registro("SINT-042", "73 00000", "b"),
      registro("SINT-050", "1111", "outra_os"),
    ] },
    vinculos: [],
  };
  const [unica, ambigua, divergente] = m.montarParesChamadoOs(entrada);
  // linhas repetidas com a mesma série contam como uma só e o primeiro registro vence
  assert.deepEqual([unica.encontrada, unica.serie, unica.serieRelatorio, unica.osRelatorio, unica.relacao, unica.registro],
    [true, "", "SINT-040", "7231981", "conferida", entrada.relatorio.chamados[0]]);
  assert.deepEqual([ambigua.encontrada, ambigua.registro, ambigua.serieRelatorio], [false, null, ""]);
  assert.deepEqual([divergente.encontrada, divergente.registro, divergente.serieRelatorio], [false, null, ""]);
});

// ----- marca de OS finalizada -----
test("Marca: a chave normaliza série e OS como osObsKey e marcasPorOs agrupa por chave, uma marca por chamado", () => {
  assert.equal(m.chaveMarca("sn-conf", " os 9001 "), m.chaveMarca("SN CONF", "OS9001"));
  assert.notEqual(m.chaveMarca("SN-CONF", "9001"), m.chaveMarca("SN-CONF", "9002"));
  const mapa = m.marcasPorOs([
    { serie: "SN-CONF", os: "9001", chamado: "UTIC-1" }, { serie: "sn conf", os: "9001", chamado: "UTIC-2" },
    { serie: "SN-OUTRA", os: "9001", chamado: "UTIC-3" }, null, "texto",
  ]);
  assert.deepEqual(mapa.get(m.chaveMarca("SN-CONF", "9001")).map(marca => marca.chamado), ["UTIC-1", "UTIC-2"]);
  assert.equal(mapa.size, 2);
  assert.equal(m.marcasPorOs(undefined).size, 0);
});

test("Marca: selo, dica, motivo e botões seguem a origem, o estado ativo e a conferência", () => {
  const base = { serie: "S", os: "1", chamado: "UTIC-1", ativa: true, conferido_em: "", motivo: "", historico: [] };
  const site = m.descreverMarca({ ...base, origem: "site" });
  assert.deepEqual([site.selo, site.dica, site.motivo, site.podeDesfazer, site.podeRefazer, site.podeConferir],
    ["Chamado finalizado", "", "", true, false, false]);

  const outro = m.descreverMarca({ ...base, origem: "outro_tecnico", motivo: "saiu_do_dashboard" });
  assert.deepEqual([outro.selo, outro.dica, outro.motivo, outro.podeConferir],
    ["Finalizado por outro técnico", "Conferir no SoftExpert", "Saiu da lista de abertos do Dashboard sem finalização pelo site.", true]);
  assert.equal(m.descreverMarca({ ...base, origem: "outro_tecnico", motivo: "nao_encontrado_softexpert" }).motivo,
    "Não encontrado no SoftExpert na última leitura.");

  const conferida = m.descreverMarca({ ...base, origem: "outro_tecnico", motivo: "saiu_do_dashboard", conferido_em: "2026-11-08T11:00:00-03:00" });
  assert.deepEqual([conferida.selo, conferida.dica, conferida.podeConferir, conferida.podeDesfazer], ["Finalizado por outro técnico", "", false, true]);

  const desfeita = m.descreverMarca({ ...base, origem: "outro_tecnico", motivo: "saiu_do_dashboard", ativa: false });
  assert.deepEqual([desfeita.ativa, desfeita.selo, desfeita.dica, desfeita.motivo, desfeita.podeDesfazer, desfeita.podeRefazer, desfeita.podeConferir],
    [false, "", "", "", false, true, false]);
  assert.equal(m.descreverMarca({ ...base, origem: "outro_tecnico", motivo: "inventado" }).motivo, "", "motivo desconhecido não vira texto");
  assert.deepEqual(m.descreverMarca(null).historico, []);
});

test("Marca: histórico em texto com data e hora, evento e origem; data fora do padrão segue como veio", () => {
  const info = m.descreverMarca({ ativa: true, historico: [
    { acao: "marcada", origem: "auto", em: "2026-11-08T10:30:00-03:00" },
    { acao: "desfeita", origem: "manual", em: "2026-11-08T12:00:00" },
    { acao: "refeita", origem: "manual", em: "sem data" },
    { acao: "conferida", origem: "manual", em: "2026-11-09T08:05:00Z" },
    { acao: "outra", origem: "x", em: "" },
  ] });
  assert.deepEqual(info.historico, [
    "08/11/2026 às 10:30 · Marcada (automática)", "08/11/2026 às 12:00 · Desfeita (manual)", "sem data · Refeita (manual)",
    "09/11/2026 às 08:05 · Conferida (manual)", " · outra (x)",
  ]);
  assert.equal(m.formatarDataHora("2026-01-02T03:04:05+00:00"), "02/01/2026 às 03:04");
  assert.equal(m.formatarDataHora(undefined), "");
});

// ----- referências em texto livre (Lembretes) -----
const refs = texto => m.referenciasNoTexto(texto).filter(parte => parte.tipo).map(parte => [parte.tipo, parte.numero]);

test("Referências: UTIC e OS de 7 dígitos viram links, na ordem, e o texto original é preservado", () => {
  const texto = "Ver utic-2026-0833 e a OS 1234567; depois UTIC-2026-12 / OS 7654321.";
  const partes = m.referenciasNoTexto(texto);
  assert.equal(partes.map(parte => parte.texto).join(""), texto);
  assert.deepEqual(refs(texto), [["chamado", "UTIC-2026-0833"], ["os", "1234567"], ["chamado", "UTIC-2026-12"], ["os", "7654321"]]);
  assert.deepEqual(partes[0], { texto: "Ver " });
  assert.deepEqual(partes[1], { tipo: "chamado", numero: "UTIC-2026-0833", texto: "utic-2026-0833" }, "numero em maiúsculas, texto como digitado");
});

test("Referências: casamento exato, sem zero inventado nem pedaço de outro número", () => {
  assert.deepEqual(refs("UTIC-2026-083"), [["chamado", "UTIC-2026-083"]], "numero fica como digitado");
  assert.deepEqual(refs("xUTIC-2026-1 UTIC-2026-1x UTIC-2026-1-2 UTIC-26-1 UTIC-2026-"), []);
  assert.deepEqual(refs(`UTIC-2026-${"9".repeat(25)}`), [], "mais de 24 dígitos não é chamado");
  assert.deepEqual(refs("12345678 123456 12345678901234 a1234567 1234567b 1234567-1 UTIC-2026-1234567"), [["chamado", "UTIC-2026-1234567"]],
    "7 dígitos só isolados; os 7 dígitos dentro do UTIC não viram OS");
});

test("Referências: OS dentro de data, telefone e valor não vira link; pontuação de frase não cola", () => {
  assert.deepEqual(refs("12/11/2026 (41) 3456-7890 R$ 1.234.567,89 1234567,89 1,1234567 0.1234567"), []);
  assert.deepEqual(refs("1234567/1 2/1234567"), [], "barra cola");
  assert.deepEqual(refs("OS 1234567. Outra: 7654321, (2345678) \"3456789\""),
    [["os", "1234567"], ["os", "7654321"], ["os", "2345678"], ["os", "3456789"]]);
  assert.deepEqual(m.referenciasNoTexto(""), []);
  assert.deepEqual(m.referenciasNoTexto(undefined), []);
  assert.deepEqual(m.referenciasNoTexto("sem número"), [{ texto: "sem número" }]);
});

test("Referências: rejeitada não parte o texto em trechos separados", () => {
  assert.deepEqual(m.referenciasNoTexto("a 12345678 b"), [{ texto: "a 12345678 b" }]);
});

const vinc = (os, chamado, extra = {}) => ({ fonte: "simpress", serie: "SN-1", os, chamado, ...extra });

test("chamadoDaOs: exato, vínculo vence o F5, e prioridade manual > finalizacao > dashboard", () => {
  assert.equal(m.chamadoDaOs("1234567", { vinculos: [vinc("12345678", "UTIC-2026-1")] }), null, "OS exata, não por prefixo");
  assert.equal(m.chamadoDaOs("", { vinculos: [vinc("1", "UTIC-2026-1")] }), null);
  assert.equal(m.chamadoDaOs("1234567"), null);
  assert.deepEqual(m.chamadoDaOs("1234567", { vinculos: { vinculos: [vinc("1234567", "utic-2026-0833", { origem: "dashboard" })] } }),
    { chamado: "UTIC-2026-0833", serie: "SN-1" }, "aceita { vinculos: [...] } e põe o chamado em maiúsculas");
  const todos = [vinc("1234567", "UTIC-2026-3", { origem: "dashboard" }), vinc("1234567", "UTIC-2026-2", { origem: "finalizacao" })];
  assert.equal(m.chamadoDaOs("1234567", { vinculos: todos }).chamado, "UTIC-2026-2", "finalizacao vence dashboard");
  assert.equal(m.chamadoDaOs("1234567", { vinculos: [...todos, vinc("1234567", "UTIC-2026-1")] }).chamado, "UTIC-2026-1", "manual (sem origem) vence tudo");
  assert.equal(m.chamadoDaOs("1234567", { vinculos: [...todos, vinc("1234567", "UTIC-2026-4", { origem: "planilha" })] }).chamado, "UTIC-2026-4",
    "origem desconhecida conta como manual, igual à F6");
  const semChamado = vinc("1234567", "", { numero: "55", ano: "2026" });
  assert.equal(m.chamadoDaOs("1234567", { vinculos: [semChamado] }).chamado, "UTIC-2026-55", "deriva do ano e número quando falta o chamado");
});

test("chamadoDaOs: mesmo chamado repetido não é ambíguo; dois chamados na mesma prioridade são", () => {
  const dois = [vinc("1234567", "UTIC-2026-1"), { ...vinc("1234567", "UTIC-2026-1"), fonte: "oracle" }];
  assert.deepEqual(m.chamadoDaOs("1234567", { vinculos: dois }), { chamado: "UTIC-2026-1", serie: "SN-1" });
  const outraSerie = [vinc("1234567", "UTIC-2026-1"), { ...vinc("1234567", "UTIC-2026-1"), serie: "SN-2" }];
  assert.deepEqual(m.chamadoDaOs("1234567", { vinculos: outraSerie }), { chamado: "UTIC-2026-1", serie: "" }, "séries diferentes: não escolhe uma");
  assert.deepEqual(m.chamadoDaOs("1234567", { vinculos: [vinc("1234567", "UTIC-2026-9"), vinc("1234567", "UTIC-2026-2")] }),
    { ambiguo: ["UTIC-2026-2", "UTIC-2026-9"] });
  assert.deepEqual(m.chamadoDaOs("1234567", { vinculos: [vinc("1234567", "UTIC-2026-9"), vinc("1234567", "UTIC-2026-2", { origem: "dashboard" })] }),
    { chamado: "UTIC-2026-9", serie: "SN-1" }, "o de prioridade menor não entra na conta");
});

test("chamadoDaOs: sem vínculo usa o F5 em aberto (sem finalizados) e acusa ambiguidade", () => {
  assert.deepEqual(m.chamadoDaOs("7001", { vinculos: [], sebrae }), { chamado: "UTIC-2026-20", serie: "SINT-001" }, "novos: linha.E e K");
  assert.deepEqual(m.chamadoDaOs("7004", { sebrae }), { chamado: "UTIC-2026-12", serie: "SINT-004" }, "linha:N usa o chamado do item e a série sugerida");
  assert.equal(m.chamadoDaOs("7003", { sebrae }), null, "chamado finalizado fica fora");
  assert.equal(m.chamadoDaOs("7009", { sebrae }), null, "novo que consta em finalizados fica fora");
  const repetida = { novos: { formulario: [{ numero: "UTIC-2026-31", linha: { E: "5555555" } }, { numero: "UTIC-2026-30", linha: { E: "5555555" } }] } };
  assert.deepEqual(m.chamadoDaOs("5555555", { sebrae: repetida }), { ambiguo: ["UTIC-2026-30", "UTIC-2026-31"] });
  assert.deepEqual(m.chamadoDaOs("5555555", { vinculos: [vinc("5555555", "UTIC-2026-99")], sebrae: repetida }).chamado, "UTIC-2026-99",
    "o vínculo vale antes do F5");
});

test("osDoChamado: exato, prioridade dos vínculos e ambiguidade", () => {
  assert.equal(m.osDoChamado("UTIC-2026-083", { vinculos: [vinc("1234567", "UTIC-2026-0833")] }), null, "exato: 083 não casa 0833");
  assert.equal(m.osDoChamado("", { vinculos: [vinc("1234567", "UTIC-2026-1")] }), null);
  assert.equal(m.osDoChamado("UTIC-2026-1"), null);
  assert.equal(m.osDoChamado("UTIC-2026-1", { vinculos: [vinc("", "UTIC-2026-1")] }), null, "vínculo sem OS não conta");
  assert.deepEqual(m.osDoChamado("utic-2026-0833", { vinculos: [vinc("1234567", "UTIC-2026-0833")] }), { os: "1234567", serie: "SN-1" });
  const mistos = [vinc("1111111", "UTIC-2026-1", { origem: "dashboard" }), vinc("2222222", "UTIC-2026-1", { origem: "finalizacao" })];
  assert.equal(m.osDoChamado("UTIC-2026-1", { vinculos: mistos }).os, "2222222", "finalizacao vence dashboard");
  assert.equal(m.osDoChamado("UTIC-2026-1", { vinculos: [...mistos, vinc("3333333", "UTIC-2026-1")] }).os, "3333333", "manual vence");
  assert.deepEqual(m.osDoChamado("UTIC-2026-1", { vinculos: [vinc("2222222", "UTIC-2026-1"), vinc("1111111", "UTIC-2026-1")] }),
    { ambiguo: ["1111111", "2222222"] });
  assert.deepEqual(m.osDoChamado("UTIC-2026-1", { vinculos: [vinc("2222222", "UTIC-2026-1"), { ...vinc("2222222", "UTIC-2026-1"), fonte: "oracle" }] }),
    { os: "2222222", serie: "SN-1" }, "mesma OS repetida não é ambígua");
});
