"""Cobertura de Equipamentos (Entrega 1A): rotas de leitura e de escrita do estado operacional local.

Regras em ``domains/coverage.py``; gravação em ``domains/coverage_store.py`` (``AtomicFileTransaction``, sem lock
Python). Nada aqui grava em ``EquipamentosDetalhes`` nem em sistemas externos. O histórico de transferências só
recebe o registro da planilha que o operador baixou (``registrar-transferencia``) ou a marca de vínculo
(``vincular-historico``), na mesma transação da cobertura; o Simpress nunca gera planilha nem envia o Transporte.

Erros: ``HTTPException`` com ``detail = {"codigo", "mensagem", ...}``. Arquivo ocupado → 409 ``arquivo_ocupado``;
estado ilegível → 503 ``estado_ilegível`` (o arquivo é preservado); falha de gravação → 500 ``falha_gravacao``.

Idempotência de ``registrar-transferencia`` pela ``chave`` da movimentação: primeiro a própria movimentação
(``historico_id`` já preenchido com a mesma chave) e só depois o histórico de transferências, que guarda apenas os
500 registros mais recentes e pode já ter descartado o registro.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Literal, Mapping, NoReturn, Optional, Tuple

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt

from core.integrity import FileBusyError, FileTransactionError
from domains import coverage
from domains.coverage import CoberturaErro, Contexto, Manutencao
from domains.coverage_store import CoberturaStore, EstadoIlegivel, HistoricoIlegivel, eh_ilegivel
from routers.transfer_history import (
    MAX_HISTORY_RECORDS,
    TransferHistoryCorruptionError,
    _validate_history,
    build_record,
)
from routers.transfers import TransferenciaPayload

logger = logging.getLogger(__name__)

MENSAGEM_ILEGIVEL = "O estado da cobertura está ilegível; os dados foram preservados e nada foi gravado."


@dataclass(frozen=True)
class CoverageServices:
    state_file: Callable[[], Path]
    archive_file: Callable[[], Path]
    transaction_root: Callable[[], Path]
    hoje: Callable[[], date]
    # Fonte de manutenção (chamados) e cadastro atual (serial, tipo, modelo, retirada_cidade, apelido), só leitura.
    manutencao: Callable[[], Manutencao]
    cadastro: Callable[[], Iterable[Mapping[str, Any]]]
    agora: Callable[[], str] = lambda: datetime.now().astimezone().isoformat(timespec="seconds")
    # historico_transferencias.json; sem ele, registrar/vincular recusam e não há candidatos.
    history_file: Optional[Callable[[], Path]] = None


@dataclass(frozen=True)
class CoverageRouteExports:
    """Rotas expostas ao ``main`` para chamadas diretas em testes e helpers."""

    ler_cobertura: Callable[..., Any]
    ler_caso: Callable[..., Any]


class _Corpo(BaseModel):
    model_config = {"extra": "forbid"}


class DemandaPayload(_Corpo):
    data: str = Field(max_length=10)
    cidade: str = Field(max_length=80)
    quantidade: StrictInt
    perfil: str = Field("", max_length=80)
    monitor: StrictBool = False
    observacao: str = Field("", max_length=500)


class RevPayload(_Corpo):
    rev: StrictInt


class DisponibilidadePayload(_Corpo):
    serie: str = Field(max_length=60)
    estado: Literal["disponivel", "em_manutencao", "indisponivel"]
    cidade: Optional[str] = Field(None, max_length=80)
    rev: Optional[StrictInt] = None


class DevolucaoPayload(_Corpo):
    serie: str = Field(max_length=60)
    data_prevista: str = Field(max_length=10)
    cidade: Optional[str] = Field(None, max_length=80)
    observacao: str = Field("", max_length=500)


class ReprogramarPayload(_Corpo):
    rev: StrictInt
    data_prevista: str = Field(max_length=10)


class ReservaPayload(_Corpo):
    demanda_id: str = Field(max_length=64)
    serie: Optional[str] = Field(None, max_length=60)
    devolucao_id: Optional[str] = Field(None, max_length=64)
    manutencao_conferida: StrictBool = False


class KitPayload(_Corpo):
    item: Literal["notebook", "carregador", "monitor", "preparacao"]
    marcado: StrictBool
    rev: StrictInt


class MovimentacaoPayload(_Corpo):
    reserva_id: str = Field(max_length=64)
    rev: StrictInt
    tipo: Literal["transporte", "local"] = "transporte"


class RegistrarTransferenciaPayload(_Corpo):
    payload: TransferenciaPayload
    chave: str = Field(min_length=1, max_length=64)
    rev: StrictInt


class VincularHistoricoPayload(_Corpo):
    historico_id: str = Field(min_length=1, max_length=64)
    rev: StrictInt


class DivergenciaPayload(_Corpo):
    tipo: Literal["serie_diferente", "item_faltando", "avaria"]
    descricao: str = Field("", max_length=500)
    serie_recebida: Optional[str] = Field(None, max_length=60)


class EstadoMovimentacaoPayload(_Corpo):
    estado: Literal["coletada", "em_transito", "recebida", "recebida_com_divergencia", "cancelada"]
    rev: StrictInt
    recebido_por: Optional[str] = Field(None, max_length=120)
    data: Optional[str] = Field(None, max_length=10)
    comprovante: Optional[str] = Field(None, max_length=500)
    divergencia: Optional[DivergenciaPayload] = None


class ResolverDivergenciaPayload(_Corpo):
    resolucao: Literal["aceitar", "corrigir", "cancelar"]
    serie_recebida: Optional[str] = Field(None, max_length=60)
    rev: StrictInt


# Formato das respostas (response_model, sempre com response_model_exclude_unset). O arquivo pode ser editado à mão:
# o que vem dele é Any e campo desconhecido passa como está (extra="allow"); só o que o domínio calcula ou o
# store valida (rev inteiro) tem tipo. Campo ausente continua ausente, nunca vira null.
class _Saida(BaseModel):
    model_config = ConfigDict(extra="allow")


class RegistroCobertura(_Saida):
    """Registro como está no arquivo (demanda, devolução, reserva, movimentação...)."""

    rev: int


class DisponibilidadeCaso(RegistroCobertura):
    estado_efetivo: str


class DevolucaoCaso(RegistroCobertura):
    situacao: str


class ReservaCaso(RegistroCobertura):
    vencida: bool
    kit_pronto: bool


class CasosCobertura(_Saida):
    disponibilidade: Dict[str, DisponibilidadeCaso] = {}
    demandas: Dict[str, RegistroCobertura] = {}
    devolucoes: Dict[str, DevolucaoCaso] = {}
    reservas: Dict[str, ReservaCaso] = {}
    # A movimentação preparada sem vínculo traz também candidatos_historico (lista de planilhas baixadas).
    movimentacoes: Dict[str, RegistroCobertura] = {}
    vinculos: Dict[str, RegistroCobertura] = {}
    rejeicoes: Dict[str, RegistroCobertura] = {}


class VagaCobertura(_Saida):
    id: str
    demanda_id: Any
    indice: int
    data: Any
    cidade: Any
    perfil: Any
    monitor: bool
    situacao: str
    serie: Any
    reserva_id: Any
    devolucao_id: Any
    movimentacao_id: Any = None
    selos: List[str]
    motivo: Optional[str]


class DisponivelCobertura(_Saida):
    serie: Any
    cidade: Any
    confirmada_em: Any
    valida_ate: Any
    sinal: Optional[str]


class EquipamentoCobertura(BaseModel):
    modelo: str
    tipo: str


class BloqueioCobertura(_Saida):
    serie: Any
    motivo: str
    id: str


class ContagensCobertura(BaseModel):
    atendivel: int
    condicionada: int
    sem_cobertura: int
    entregue: int


class ManutencaoCobertura(BaseModel):
    verificada: bool
    aviso: str


class Cobertura(BaseModel):
    """GET /api/cobertura: tudo calculado pelo domínio (sem extra: campo novo do domínio precisa entrar aqui)."""

    hoje: str
    vagas: List[VagaCobertura]
    contagens: ContagensCobertura
    disponiveis: List[DisponivelCobertura]
    bloqueios: List[BloqueioCobertura]
    reservas_vencidas: List[str]
    manutencao: ManutencaoCobertura
    sinais: List[Dict[str, Any]]
    casos: CasosCobertura
    # Série -> modelo e tipo do cadastro oficial (EquipamentosDetalhes); série fora do cadastro não aparece.
    equipamentos: Dict[str, EquipamentoCobertura] = {}


class CasoCobertura(BaseModel):
    secao: str
    arquivado: bool
    registro: RegistroCobertura


class MovimentacaoPreparada(BaseModel):
    id: Any
    serie: Any
    destino_cidade: Any
    chave: Any
    rev: int


class TransferenciaRegistrada(BaseModel):
    movimentacao: RegistroCobertura
    historico_id: Any
    transferencia: Any
    repetido: bool


Transicao = Callable[[coverage.Estado, Contexto], Tuple[coverage.Estado, coverage.Registro]]


def _falhar(error: BaseException) -> NoReturn:
    if isinstance(error, CoberturaErro):
        raise HTTPException(status_code=error.status, detail=error.detalhe()) from error
    if isinstance(error, FileBusyError):
        raise HTTPException(status_code=409, detail={
            "codigo": "arquivo_ocupado", "mensagem": "O arquivo da cobertura está ocupado. Tente de novo.",
        }) from error
    if isinstance(error, HistoricoIlegivel):
        raise HTTPException(status_code=503, detail={
            "codigo": "estado_ilegível",
            "mensagem": f"O histórico de transferências ({error.arquivo}) está ilegível; os dados foram preservados e nada foi gravado.",
        }) from error
    if eh_ilegivel(error):
        raise HTTPException(status_code=503, detail={"codigo": "estado_ilegível", "mensagem": MENSAGEM_ILEGIVEL}) from error
    # O texto da exceção pode ter caminho local: fica só no log do servidor.
    logger.error("Falha ao gravar a cobertura.", exc_info=error)
    raise HTTPException(status_code=500, detail={
        "codigo": "falha_gravacao", "mensagem": "Não foi possível salvar na Cobertura. Tente de novo; se o erro continuar, avise o suporte.",
    }) from error


def create_coverage_router(services: CoverageServices) -> Tuple[APIRouter, CoverageRouteExports]:
    router = APIRouter()

    def store() -> CoberturaStore:
        return CoberturaStore(services.state_file(), services.archive_file(), services.transaction_root())

    def contexto() -> Contexto:
        return Contexto(
            hoje=services.hoje(), agora=services.agora(), manutencao=services.manutencao(),
            cadastro=coverage.indexar_cadastro(services.cadastro()),
        )

    def historico_path() -> Path:
        if services.history_file is None:
            raise CoberturaErro("indisponivel", 503, "O histórico de transferências não está configurado.")
        return services.history_file()

    def historico_valido(bruto: Any) -> coverage.Historico:
        try:
            return _validate_history(bruto)
        except TransferHistoryCorruptionError as error:
            raise HistoricoIlegivel(historico_path().name) from error

    def candidatos_por_movimentacao(estado: coverage.Estado) -> Dict[str, List[coverage.Registro]]:
        """Só leitura; histórico ausente ou ilegível vira lista vazia (o GET da cobertura não falha por ele)."""
        preparadas = [m for m in estado["movimentacoes"].values() if m.get("estado") == "preparada" and not m.get("historico_id")]
        historico: coverage.Historico = []
        if preparadas and services.history_file is not None:
            try:
                caminho = services.history_file()
                historico = historico_valido(json.loads(caminho.read_text(encoding="utf-8"))) if caminho.exists() else []
            except (OSError, UnicodeError, ValueError):
                historico = []
        return {str(m.get("id")): coverage.candidatos_historico(m, historico) for m in preparadas}

    def executar_com_historico(operacao: Callable[[coverage.Estado, coverage.Historico, Contexto], Any]) -> coverage.Registro:
        ctx = contexto()
        try:
            return store().escrever_com_historico(
                historico_path(), lambda estado, bruto: operacao(estado, historico_valido(bruto), ctx), ctx.hoje,
            )
        except (CoberturaErro, FileBusyError, EstadoIlegivel, FileTransactionError) as error:
            _falhar(error)

    def executar(transicao: Transicao) -> coverage.Registro:
        ctx = contexto()
        try:
            # O estado é relido dentro da transação; a elegibilidade é recalculada sobre ele.
            return store().escrever(lambda estado: transicao(estado, ctx), ctx.hoje)
        except (CoberturaErro, FileBusyError, EstadoIlegivel, FileTransactionError) as error:
            _falhar(error)

    @router.get("/api/cobertura", response_model=Cobertura, response_model_exclude_unset=True)
    def ler_cobertura() -> Dict[str, Any]:
        """Vagas calculadas, disponíveis, bloqueios com motivo e os casos (somente leitura)."""
        try:
            estado = store().ler()
        except EstadoIlegivel as error:
            _falhar(error)
        hoje = services.hoje()
        casos = coverage.anotar_casos(estado, hoje)
        for mov_id, candidatos in candidatos_por_movimentacao(estado).items():
            casos["movimentacoes"][mov_id]["candidatos_historico"] = candidatos
        equipamentos = coverage.equipamentos_das_series(estado, coverage.indexar_cadastro(services.cadastro()))
        return {**coverage.build_coverage(estado, hoje, services.manutencao()), "casos": casos, "equipamentos": equipamentos}

    @router.get("/api/cobertura/casos/{caso_id}", response_model=CasoCobertura, response_model_exclude_unset=True)
    def ler_caso(caso_id: str) -> Dict[str, Any]:
        """Um caso pelo id, no arquivo principal ou nos arquivados (links antigos continuam abrindo)."""
        atual = store()
        try:
            # Os arquivados só são lidos se o caso não estiver no principal.
            for arquivado, ler in ((False, atual.ler), (True, atual.ler_arquivados)):
                estado = ler()
                achado = coverage.buscar_caso(estado, caso_id)
                if achado is not None:
                    secao, _ = achado
                    registro = coverage.anotar_casos(estado, services.hoje())[secao][caso_id]
                    return {"secao": secao, "arquivado": arquivado, "registro": registro}
        except EstadoIlegivel as error:
            _falhar(error)
        raise HTTPException(status_code=404, detail={"codigo": "nao_encontrado", "mensagem": "Caso não encontrado.", "id": caso_id})

    @router.post("/api/cobertura/demandas", response_model=RegistroCobertura, response_model_exclude_unset=True)
    def registrar_demanda(payload: DemandaPayload) -> coverage.Registro:
        return executar(lambda estado, ctx: coverage.registrar_demanda(estado, ctx, **payload.model_dump()))

    @router.post("/api/cobertura/demandas/{demanda_id}/cancelar", response_model=RegistroCobertura, response_model_exclude_unset=True)
    def cancelar_demanda(demanda_id: str, payload: RevPayload) -> coverage.Registro:
        return executar(lambda estado, ctx: coverage.cancelar_demanda(estado, ctx, demanda_id, payload.rev))

    @router.post("/api/cobertura/disponibilidade", response_model=RegistroCobertura, response_model_exclude_unset=True)
    def registrar_disponibilidade(payload: DisponibilidadePayload) -> coverage.Registro:
        return executar(lambda estado, ctx: coverage.registrar_disponibilidade(
            estado, ctx, serie=payload.serie, situacao=payload.estado, cidade=payload.cidade, rev=payload.rev,
        ))

    @router.post("/api/cobertura/devolucoes", response_model=RegistroCobertura, response_model_exclude_unset=True)
    def registrar_devolucao(payload: DevolucaoPayload) -> coverage.Registro:
        return executar(lambda estado, ctx: coverage.registrar_devolucao(estado, ctx, **payload.model_dump()))

    @router.post("/api/cobertura/devolucoes/{devolucao_id}/reprogramar", response_model=RegistroCobertura, response_model_exclude_unset=True)
    def reprogramar_devolucao(devolucao_id: str, payload: ReprogramarPayload) -> coverage.Registro:
        return executar(lambda estado, ctx: coverage.reprogramar_devolucao(
            estado, ctx, devolucao_id, payload.rev, payload.data_prevista,
        ))

    @router.post("/api/cobertura/devolucoes/{devolucao_id}/receber", response_model=RegistroCobertura, response_model_exclude_unset=True)
    def receber_devolucao(devolucao_id: str, payload: RevPayload) -> coverage.Registro:
        return executar(lambda estado, ctx: coverage.receber_devolucao(estado, ctx, devolucao_id, payload.rev))

    @router.post("/api/cobertura/devolucoes/{devolucao_id}/cancelar", response_model=RegistroCobertura, response_model_exclude_unset=True)
    def cancelar_devolucao(devolucao_id: str, payload: RevPayload) -> coverage.Registro:
        return executar(lambda estado, ctx: coverage.cancelar_devolucao(estado, ctx, devolucao_id, payload.rev))

    @router.post("/api/cobertura/reservas", response_model=RegistroCobertura, response_model_exclude_unset=True)
    def reservar(payload: ReservaPayload) -> coverage.Registro:
        return executar(lambda estado, ctx: coverage.reservar(estado, ctx, **payload.model_dump()))

    @router.post("/api/cobertura/reservas/{reserva_id}/renovar", response_model=RegistroCobertura, response_model_exclude_unset=True)
    def renovar_reserva(reserva_id: str, payload: RevPayload) -> coverage.Registro:
        return executar(lambda estado, ctx: coverage.renovar_reserva(estado, ctx, reserva_id, payload.rev))

    @router.post("/api/cobertura/reservas/{reserva_id}/cancelar", response_model=RegistroCobertura, response_model_exclude_unset=True)
    def cancelar_reserva(reserva_id: str, payload: RevPayload) -> coverage.Registro:
        return executar(lambda estado, ctx: coverage.cancelar_reserva(estado, ctx, reserva_id, payload.rev))

    @router.post("/api/cobertura/reservas/{reserva_id}/kit", response_model=RegistroCobertura, response_model_exclude_unset=True)
    def marcar_kit(reserva_id: str, payload: KitPayload) -> coverage.Registro:
        return executar(lambda estado, ctx: coverage.marcar_kit(
            estado, ctx, reserva_id, payload.rev, payload.item, payload.marcado,
        ))

    @router.post("/api/cobertura/movimentacoes", response_model=MovimentacaoPreparada, response_model_exclude_unset=True)
    def preparar_movimentacao(payload: MovimentacaoPayload) -> Dict[str, Any]:
        mov = executar(lambda estado, ctx: coverage.preparar_movimentacao(
            estado, ctx, payload.reserva_id, payload.rev, payload.tipo,
        ))
        return {key: mov.get(key) for key in ("id", "serie", "destino_cidade", "chave", "rev")}

    @router.post("/api/cobertura/movimentacoes/{movimentacao_id}/estado", response_model=RegistroCobertura, response_model_exclude_unset=True)
    def mudar_estado_movimentacao(movimentacao_id: str, payload: EstadoMovimentacaoPayload) -> coverage.Registro:
        divergencia = payload.divergencia.model_dump() if payload.divergencia is not None else None
        return executar(lambda estado, ctx: coverage.mudar_estado_movimentacao(
            estado, ctx, movimentacao_id, payload.rev, payload.estado, recebido_por=payload.recebido_por, data=payload.data,
            comprovante=payload.comprovante, divergencia=divergencia,
        ))

    @router.post("/api/cobertura/movimentacoes/{movimentacao_id}/resolver-divergencia", response_model=RegistroCobertura, response_model_exclude_unset=True)
    def resolver_divergencia(movimentacao_id: str, payload: ResolverDivergenciaPayload) -> coverage.Registro:
        return executar(lambda estado, ctx: coverage.resolver_divergencia(
            estado, ctx, movimentacao_id, payload.rev, payload.resolucao, payload.serie_recebida,
        ))

    @router.post("/api/cobertura/movimentacoes/{movimentacao_id}/registrar-transferencia", response_model=TransferenciaRegistrada, response_model_exclude_unset=True)
    def registrar_transferencia(movimentacao_id: str, payload: RegistrarTransferenciaPayload) -> coverage.Registro:
        """Registra no histórico a planilha que o operador baixou e passa a movimentação a ``gerada`` (idempotente)."""
        registro = build_record(payload.payload)
        return executar_com_historico(lambda estado, historico, ctx: coverage.registrar_transferencia(
            estado, historico, ctx, movimentacao_id, payload.rev, payload.chave, registro, MAX_HISTORY_RECORDS,
        ))

    @router.post("/api/cobertura/movimentacoes/{movimentacao_id}/vincular-historico", response_model=TransferenciaRegistrada, response_model_exclude_unset=True)
    def vincular_historico(movimentacao_id: str, payload: VincularHistoricoPayload) -> coverage.Registro:
        """Liga à movimentação preparada uma planilha já baixada sem vínculo (de ``candidatos_historico``)."""
        return executar_com_historico(lambda estado, historico, ctx: coverage.vincular_historico(
            estado, historico, ctx, movimentacao_id, payload.rev, payload.historico_id,
        ))

    return router, CoverageRouteExports(ler_cobertura=ler_cobertura, ler_caso=ler_caso)
