// Regras de tela da Cobertura de Equipamentos, sem DOM nem rede: selos, contagens das abas, alertas e quais ações
// cada registro oferece. A decisão de verdade é sempre do servidor (rev e transições); aqui só se evita mostrar
// botões que o servidor recusaria.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SimpressCoverageModel = api;
})(typeof window !== "undefined" ? window : globalThis, function createCoverageModel() {
  "use strict";

  const SITUACAO = Object.freeze({
    atendivel: { texto: "Atendível", status: "ok" },
    condicionada: { texto: "Condicionada", status: "alerta" },
    sem_cobertura: { texto: "Sem cobertura", status: "erro" },
    entregue: { texto: "Entregue", status: "ok" },
  });

  const SELO_STATUS = Object.freeze({
    "Transferência": "info",
    "Prazo perdido": "erro",
    "Kit pronto": "ok",
    "Reserva vencida": "alerta",
    "Em movimento": "info",
    "Recebida com divergência": "erro",
  });

  const ESTADO_MOVIMENTACAO = Object.freeze({
    preparada: "Preparada",
    gerada: "Planilha gerada",
    coletada: "Coletada",
    em_transito: "Em trânsito",
    recebida: "Recebida",
    recebida_com_divergencia: "Recebida com divergência",
    encerrada: "Encerrada",
    cancelada: "Cancelada",
  });

  const ESTADO_RESERVA = Object.freeze({ ativa: "Ativa", em_espera: "Em espera", consumida: "Consumida", cancelada: "Cancelada" });
  const SITUACAO_DEVOLUCAO = Object.freeze({ prevista: "Prevista", atrasada: "Atrasada", recebida: "Recebida", cancelada: "Cancelada" });
  const DISPONIBILIDADE = Object.freeze({
    disponivel: "Disponível",
    em_manutencao: "Em manutenção",
    indisponivel: "Indisponível",
    a_confirmar: "A confirmar",
    entregue: "Entregue",
  });
  const TIPOS_DIVERGENCIA = Object.freeze([
    ["serie_diferente", "Série diferente"],
    ["item_faltando", "Item faltando"],
    ["avaria", "Avaria"],
  ]);
  const ITENS_KIT = Object.freeze({ notebook: "Notebook", carregador: "Carregador", monitor: "Monitor", preparacao: "Preparação" });
  const BLOQUEIO = Object.freeze({
    reserva_ativa: "Reservada",
    reserva_vencida_em_revisao: "Reserva vencida em revisão",
    reserva_em_espera: "Reserva em espera",
    movimentacao_aberta: "Em movimento",
    devolucao_pendente: "Devolução pendente",
    manutencao: "Em manutenção",
    sem_disponibilidade: "Sem disponibilidade confirmada",
  });

  const MOV_ABERTAS = new Set(["preparada", "gerada", "coletada", "em_transito", "recebida_com_divergencia"]);
  const RESERVAS_ABERTAS = new Set(["ativa", "em_espera"]);

  const lista = valor => (Array.isArray(valor) ? valor : []);
  const valores = valor => (valor && typeof valor === "object" ? Object.values(valor) : []);
  const casos = dados => (dados && typeof dados.casos === "object" && dados.casos) || {};

  // Mesma dobra de cidade do servidor (sem acento, sem caixa, espaços únicos).
  function dobrar(valor) {
    return String(valor || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  }

  // Mesma chave de série do servidor (chave_serie): só letras e números, maiúsculas.
  function chaveSerie(valor) {
    return String(valor || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  function formatarData(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
    return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
  }

  function selosDaVaga(vaga) {
    const situacao = SITUACAO[vaga?.situacao];
    const selos = situacao ? [{ texto: situacao.texto, status: situacao.status }] : [];
    for (const selo of lista(vaga?.selos)) selos.push({ texto: String(selo), status: SELO_STATUS[selo] || "info" });
    return selos;
  }

  function reservasAbertas(dados) {
    return valores(casos(dados).reservas).filter(r => RESERVAS_ABERTAS.has(r?.estado));
  }

  function movimentacoesAbertas(dados) {
    return valores(casos(dados).movimentacoes).filter(m => MOV_ABERTAS.has(m?.estado));
  }

  function devolucoesAbertas(dados) {
    return valores(casos(dados).devolucoes).filter(d => d?.estado === "prevista");
  }

  function contagensAbas(dados) {
    return {
      necessidades: lista(dados?.vagas).length,
      disponiveis: valores(casos(dados).disponibilidade).length,
      reservas: reservasAbertas(dados).length,
      movimento: movimentacoesAbertas(dados).length,
      devolucoes: devolucoesAbertas(dados).length,
    };
  }

  // pendencias: itens de SimpressCoberturaVinculo.pendenciaSemVinculo().
  function alertas(dados, pendencias) {
    const saida = [];
    const semCobertura = Number(dados?.contagens?.sem_cobertura) || 0;
    if (semCobertura > 0) saida.push({ tipo: "sem_cobertura", texto: `Vagas sem cobertura: ${semCobertura}`, gravidade: "urgente" });
    if (lista(dados?.reservas_vencidas).length) saida.push({ tipo: "reservas_vencidas", texto: "Reservas vencidas — revisar", gravidade: "atencao" });
    if (dados?.manutencao && dados.manutencao.verificada === false) {
      saida.push({ tipo: "manutencao", texto: "Manutenção não verificada", detalhe: String(dados.manutencao.aviso || ""), gravidade: "atencao" });
    }
    for (const item of lista(pendencias)) {
      const id = item?.movimentacao?.id;
      if (id) saida.push({ tipo: "sem_vinculo", texto: "Planilha baixada sem vínculo", movimentacaoId: String(id), serie: String(item.movimentacao.serie || ""), gravidade: "atencao" });
    }
    return saida;
  }

  function acaoDaVaga(vaga) {
    if (!vaga || vaga.reserva_id) return null;
    if (vaga.situacao === "atendivel" && vaga.serie) return { tipo: "reservar", rotulo: "Reservar", corpo: { demanda_id: vaga.demanda_id, serie: vaga.serie } };
    if (vaga.situacao === "condicionada" && vaga.devolucao_id) {
      return { tipo: "reservar_espera", rotulo: "Reservar em espera", corpo: { demanda_id: vaga.demanda_id, devolucao_id: vaga.devolucao_id } };
    }
    return null;
  }

  // Ações de uma reserva aberta. "local" só quando a máquina já está na cidade da necessidade.
  function acoesDaReserva(reserva, demanda, disponibilidade) {
    if (!reserva) return [];
    if (reserva.estado === "em_espera") return ["cancelar"];
    if (reserva.estado !== "ativa") return [];
    const acoes = ["renovar", "cancelar"];
    if (reserva.kit_pronto && !reserva.vencida) {
      acoes.push("preparar");
      if (dobrar(demanda?.cidade) && dobrar(disponibilidade?.cidade) === dobrar(demanda?.cidade)) acoes.push("local");
    }
    return acoes;
  }

  function itensKit(reserva) {
    const kit = reserva?.kit && typeof reserva.kit === "object" ? reserva.kit : {};
    return Object.keys(kit).map(item => ({ item, rotulo: ITENS_KIT[item] || item, marcado: Boolean(kit[item]) }));
  }

  function acoesDaMovimentacao(mov) {
    if (!mov) return [];
    const estado = mov.estado;
    // "cancelar" em preparada, gerada e coletada (transporte): o servidor devolve a reserva com a validade original.
    // Em trânsito não: a máquina pode estar na estrada; a saída é receber com divergência e cancelar e reabrir a vaga.
    if (estado === "preparada" && mov.tipo === "transporte") return mov.historico_id ? ["cancelar"] : ["vincular", "cancelar"];
    if (estado === "preparada" && mov.tipo === "local") return ["receber", "cancelar"];
    if (estado === "gerada") return ["coletada", "cancelar"];
    if (estado === "coletada") return ["em_transito", "cancelar"];
    if (estado === "em_transito") return ["receber"];
    if (estado === "recebida_com_divergencia") return ["resolver"];
    return [];
  }

  function textoBloqueio(motivo) {
    return BLOQUEIO[motivo] || String(motivo || "");
  }

  // Erros do servidor chegam como {detail: {codigo, mensagem}}; 422 do Pydantic chega como lista.
  function mensagemErro(corpo, status) {
    const detail = corpo?.detail;
    if (detail && typeof detail.mensagem === "string" && detail.mensagem) return detail.mensagem;
    if (typeof detail === "string" && detail) return detail;
    if (Array.isArray(detail) && detail.length) return "Dados inválidos: confira os campos e tente de novo.";
    if (status === 0) return "Sem resposta do servidor local. Tente de novo.";
    return "Não foi possível concluir a ação da cobertura.";
  }

  function exigeConferenciaManutencao(dados) {
    return Boolean(dados?.manutencao) && dados.manutencao.verificada === false;
  }

  return Object.freeze({
    SITUACAO, SELO_STATUS, ESTADO_MOVIMENTACAO, ESTADO_RESERVA, SITUACAO_DEVOLUCAO, DISPONIBILIDADE, TIPOS_DIVERGENCIA,
    dobrar, chaveSerie, formatarData, selosDaVaga, reservasAbertas, movimentacoesAbertas, devolucoesAbertas, contagensAbas, alertas,
    acaoDaVaga, acoesDaReserva, itensKit, acoesDaMovimentacao, textoBloqueio, mensagemErro, exigeConferenciaManutencao,
  });
});
