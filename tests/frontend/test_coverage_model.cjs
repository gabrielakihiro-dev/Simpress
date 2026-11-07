// Regras de tela da Cobertura (sem DOM): rótulos aprovados, contagens, alertas e ações oferecidas.
const assert = require("node:assert/strict");
const test = require("node:test");

const m = require("../../static/js/shared/coverage-model.js");

const dados = {
  hoje: "2026-11-06",
  vagas: [
    { id: "dem:1", demanda_id: "d1", indice: 1, situacao: "atendivel", serie: "SINT-001", selos: [] },
    { id: "dem:2", demanda_id: "d1", indice: 2, situacao: "condicionada", devolucao_id: "v1", selos: ["Transferência"] },
    { id: "dem:3", demanda_id: "d1", indice: 3, situacao: "sem_cobertura", selos: ["Prazo perdido"] },
    { id: "dem:4", demanda_id: "d1", indice: 4, situacao: "atendivel", serie: "SINT-002", reserva_id: "r1", selos: ["Kit pronto"] },
  ],
  contagens: { sem_cobertura: 1 },
  reservas_vencidas: ["r9"],
  manutencao: { verificada: false, aviso: "Planilha de manutenção ilegível." },
  casos: {
    disponibilidade: { SINT001: { serie: "SINT-001" }, SINT002: { serie: "SINT-002" } },
    reservas: { r1: { estado: "ativa" }, r2: { estado: "em_espera" }, r3: { estado: "consumida" } },
    movimentacoes: { m1: { estado: "gerada" }, m2: { estado: "encerrada" }, m3: { estado: "recebida_com_divergencia" } },
    devolucoes: { v1: { estado: "prevista" }, v2: { estado: "recebida" } },
  },
};

test("selos usam os rótulos aprovados, situação primeiro", () => {
  assert.deepEqual(m.selosDaVaga(dados.vagas[0]).map(s => s.texto), ["Atendível"]);
  assert.deepEqual(m.selosDaVaga(dados.vagas[1]).map(s => s.texto), ["Condicionada", "Transferência"]);
  assert.deepEqual(m.selosDaVaga(dados.vagas[2]), [{ texto: "Sem cobertura", status: "erro" }, { texto: "Prazo perdido", status: "erro" }]);
  assert.equal(m.selosDaVaga(dados.vagas[3])[1].texto, "Kit pronto");
});

test("contagens das abas contam só registros abertos", () => {
  assert.deepEqual(m.contagensAbas(dados), { necessidades: 4, disponiveis: 2, reservas: 2, movimento: 2, devolucoes: 1 });
  assert.deepEqual(m.contagensAbas(null), { necessidades: 0, disponiveis: 0, reservas: 0, movimento: 0, devolucoes: 0 });
});

test("alertas trazem os textos aprovados e a pendência sem vínculo", () => {
  const saida = m.alertas(dados, [{ movimentacao: { id: "mov-7", serie: "SINT-007" } }, { movimentacao: {} }]);
  assert.deepEqual(saida.map(a => a.texto), [
    "Vagas sem cobertura: 1", "Reservas vencidas — revisar", "Manutenção não verificada", "Planilha baixada sem vínculo",
  ]);
  assert.equal(saida[3].movimentacaoId, "mov-7");
  assert.deepEqual(m.alertas({ contagens: { sem_cobertura: 0 }, manutencao: { verificada: true } }, []), []);
  assert.equal(m.exigeConferenciaManutencao(dados), true);
  assert.equal(m.exigeConferenciaManutencao({ manutencao: { verificada: true } }), false);
});

test("ação da vaga: Reservar, Reservar em espera ou nada", () => {
  assert.deepEqual(m.acaoDaVaga(dados.vagas[0]), { tipo: "reservar", rotulo: "Reservar", corpo: { demanda_id: "d1", serie: "SINT-001" } });
  assert.deepEqual(m.acaoDaVaga(dados.vagas[1]).corpo, { demanda_id: "d1", devolucao_id: "v1" });
  assert.equal(m.acaoDaVaga(dados.vagas[1]).rotulo, "Reservar em espera");
  assert.equal(m.acaoDaVaga(dados.vagas[2]), null);
  assert.equal(m.acaoDaVaga(dados.vagas[3]), null);
});

test("ações da reserva respeitam kit, vencimento e cidade dobrada", () => {
  const ativa = { estado: "ativa", kit_pronto: true, vencida: false };
  assert.deepEqual(m.acoesDaReserva(ativa, { cidade: "São Paulo" }, { cidade: "sao  paulo" }), ["renovar", "cancelar", "preparar", "local"]);
  assert.deepEqual(m.acoesDaReserva(ativa, { cidade: "Cidade A" }, { cidade: "Cidade B" }), ["renovar", "cancelar", "preparar"]);
  assert.deepEqual(m.acoesDaReserva({ ...ativa, kit_pronto: false }, {}, {}), ["renovar", "cancelar"]);
  assert.deepEqual(m.acoesDaReserva({ ...ativa, vencida: true }, {}, {}), ["renovar", "cancelar"]);
  assert.deepEqual(m.acoesDaReserva({ estado: "em_espera" }), ["cancelar"]);
  assert.deepEqual(m.acoesDaReserva({ estado: "consumida" }), []);
});

test("ações da movimentação seguem as transições do servidor", () => {
  assert.deepEqual(m.acoesDaMovimentacao({ estado: "preparada", tipo: "transporte" }), ["vincular"]);
  assert.deepEqual(m.acoesDaMovimentacao({ estado: "preparada", tipo: "transporte", historico_id: "h1" }), []);
  assert.deepEqual(m.acoesDaMovimentacao({ estado: "preparada", tipo: "local" }), ["receber"]);
  assert.deepEqual(m.acoesDaMovimentacao({ estado: "gerada" }), ["coletada"]);
  assert.deepEqual(m.acoesDaMovimentacao({ estado: "coletada" }), ["em_transito"]);
  assert.deepEqual(m.acoesDaMovimentacao({ estado: "em_transito" }), ["receber"]);
  assert.deepEqual(m.acoesDaMovimentacao({ estado: "recebida_com_divergencia" }), ["resolver"]);
  assert.deepEqual(m.acoesDaMovimentacao({ estado: "encerrada" }), []);
  assert.deepEqual(m.TIPOS_DIVERGENCIA.map(([v]) => v), ["serie_diferente", "item_faltando", "avaria"]);
});

test("kit, datas, série e mensagens de erro", () => {
  assert.deepEqual(m.itensKit({ kit: { notebook: true, carregador: false } }), [
    { item: "notebook", rotulo: "Notebook", marcado: true }, { item: "carregador", rotulo: "Carregador", marcado: false },
  ]);
  assert.equal(m.formatarData("2026-11-20"), "20/11/2026");
  assert.equal(m.formatarData(""), "");
  assert.equal(m.chaveSerie(" sint-001 "), "SINT001");
  assert.equal(m.mensagemErro({ detail: { codigo: "registro_alterado", mensagem: "Registro alterado por outra pessoa." } }, 409), "Registro alterado por outra pessoa.");
  assert.match(m.mensagemErro({ detail: [{ loc: ["body"] }] }, 422), /Dados inválidos/);
  assert.match(m.mensagemErro(null, 0), /Sem resposta/);
});
