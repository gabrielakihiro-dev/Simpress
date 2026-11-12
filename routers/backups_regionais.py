"""Backups regionais (Resumo F3): confirmar e desfazer manualmente um backup por série e cidade.

Cálculo em ``domains/backups_regionais.py``; gravação em ``domains/backups_regionais_store.py``
(``AtomicFileTransaction``, sem lock Python). Nada aqui grava em ``EquipamentosDetalhes`` nem em sistemas externos.

Confirmar só aceita a série que o cálculo atual mostra naquela cidade como candidata ou já contada (por marca ou por
confirmação, para renovar o clique). Erros: ``HTTPException`` com ``detail = {"codigo", "mensagem"}``. Arquivo
ocupado → 409 ``arquivo_ocupado``; estado ilegível → 503 ``estado_ilegível`` (o arquivo é preservado); série fora do
cálculo → 422 ``serie_nao_elegivel``; falha de gravação → 500 ``falha_gravacao``.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Mapping, NoReturn, Optional, Tuple

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from core.integrity import FileBusyError, FileTransactionError
from domains import backups_regionais_store as store_mod
from domains.backups_regionais import build_backups_regionais
from domains.backups_regionais_store import BackupsRegionaisStore, EstadoIlegivel, eh_ilegivel
from domains.coverage import Manutencao
from domains.regras_negocio import normalize_reference_value

logger = logging.getLogger(__name__)

MENSAGEM_ILEGIVEL = "As confirmações de backup estão ilegíveis; os dados foram preservados e nada foi gravado."


@dataclass(frozen=True)
class BackupsRegionaisServices:
    state_file: Callable[[], Path]
    transaction_root: Callable[[], Path]
    # Entradas do cálculo, todas só leitura (ver o contrato em domains/backups_regionais.py).
    equipamentos: Callable[[], Optional[Iterable[Mapping[str, Any]]]]
    endpoint: Callable[[], Optional[Mapping[str, Any]]]
    estado_cobertura: Callable[[], Optional[Mapping[str, Any]]]
    manutencao: Callable[[], Manutencao]
    agora: Callable[[], datetime] = lambda: datetime.now().astimezone()


class ConfirmacaoPayload(BaseModel):
    model_config = {"extra": "forbid"}

    serie: str = Field(min_length=1, max_length=60)
    cidade: str = Field(min_length=1, max_length=80)


def _falhar(error: BaseException) -> NoReturn:
    if isinstance(error, FileBusyError):
        raise HTTPException(status_code=409, detail={
            "codigo": "arquivo_ocupado", "mensagem": "O arquivo de backups está ocupado. Tente de novo.",
        }) from error
    if eh_ilegivel(error):
        raise HTTPException(status_code=503, detail={"codigo": "estado_ilegível", "mensagem": MENSAGEM_ILEGIVEL}) from error
    # O texto da exceção pode ter caminho local: fica só no log do servidor.
    logger.error("Falha ao gravar as confirmações de backup.", exc_info=error)
    raise HTTPException(status_code=500, detail={
        "codigo": "falha_gravacao", "mensagem": "Não foi possível salvar a confirmação. Tente de novo; se o erro continuar, avise o suporte.",
    }) from error


def series_elegiveis(calculo: Mapping[str, Any], cidade: str) -> Dict[str, Tuple[str, str]]:
    """``{serie_normalizada: (serie, cidade)}`` que o cálculo mostra na cidade como candidata ou já contada."""
    chave_cidade = normalize_reference_value(cidade)
    grupos = [
        (g["cidade"], [*g["candidatos"], *g["backups"]]) for g in calculo.get("prioritarias", [])
    ] + [
        (g["cidade"], g["candidatos"]) for g in calculo.get("outras_candidatos", [])
    ] + [
        (g["cidade"], [{"serie": s} for s in g["series"]]) for g in calculo.get("sobras", []) if not g.get("prioritaria")
    ]
    return {
        normalize_reference_value(item["serie"]): (item["serie"], nome)
        for nome, itens in grupos if normalize_reference_value(nome) == chave_cidade
        for item in itens
    }


def create_backups_regionais_router(services: BackupsRegionaisServices) -> APIRouter:
    router = APIRouter()

    def store() -> BackupsRegionaisStore:
        return BackupsRegionaisStore(services.state_file(), services.transaction_root())

    def gravar(operacao: Callable[[store_mod.Estado], Tuple[store_mod.Estado, Any]]) -> Any:
        try:
            return store().escrever(operacao)
        except (FileBusyError, EstadoIlegivel, FileTransactionError) as error:
            _falhar(error)

    @router.post("/api/backups-regionais/confirmar")
    def confirmar(payload: ConfirmacaoPayload) -> Dict[str, Any]:
        """Confirma por 7 dias; repetir mantém o ``expira_em`` vigente."""
        agora = services.agora()
        try:
            atual = store().ler()
        except EstadoIlegivel as error:
            _falhar(error)
        # Endpoint e cadastro são lidos antes, fora de qualquer transação; a gravação só toca o arquivo de backups.
        calculo = build_backups_regionais(
            services.equipamentos(), services.endpoint(), atual["confirmacoes"],
            services.estado_cobertura(), services.manutencao(), agora,
        )
        achada = series_elegiveis(calculo, payload.cidade).get(normalize_reference_value(payload.serie))
        if achada is None:
            raise HTTPException(status_code=422, detail={
                "codigo": "serie_nao_elegivel",
                "mensagem": "Esta série não aparece como candidata a backup nesta cidade.",
            })
        serie, cidade = achada
        registro, repetido = gravar(lambda estado: _confirmar(estado, serie, cidade, agora))
        return {"confirmacao": registro, "repetido": repetido}

    @router.post("/api/backups-regionais/desfazer")
    def desfazer(payload: ConfirmacaoPayload) -> Dict[str, Any]:
        """Remove a confirmação da série naquela cidade; sem registro, ``removido: false``."""
        removido = gravar(lambda estado: store_mod.desfazer(estado, payload.serie, payload.cidade))
        return {"serie": payload.serie, "cidade": payload.cidade, "removido": removido}

    return router


def _confirmar(estado: store_mod.Estado, serie: str, cidade: str, agora: datetime) -> Tuple[store_mod.Estado, Tuple[Any, bool]]:
    novo, registro, repetido = store_mod.confirmar(estado, serie, cidade, agora)
    return novo, (registro, repetido)
