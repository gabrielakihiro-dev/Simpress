"""Saúde local: space used, state JSON health, temporary-file cleanup and the diagnostic package.

Contract: docs/arquitetura/CONTRATOS_API_BACKEND.md ("Saúde local"). The GETs never write; the
cleanup never recovers a transaction; no answer carries a path outside the cleanup items.
"""

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Literal, Optional, Sequence, Union

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from core.limpeza_temporarios import CleanupBlockedError
from domains import saude_local
from domains.saude_local import ChaveArea, CodigoRecusa, ErroJson, EstadoProntidao, NomeJson, SituacaoJson

_ISO_UTC = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$"
_CHAVE_PRONTIDAO = r"^[a-z][a-z0-9_]{0,63}$"
MSG_SEM_CONFIRMACAO = "Confirme a limpeza antes de aplicar."
MSG_LEITURA = "Não foi possível ler a saúde local."
MSG_LIMPEZA = "Não foi possível concluir a limpeza com segurança."
MSG_DIAGNOSTICO = "Não foi possível gerar o pacote de diagnóstico."


class _Fechado(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Disco(_Fechado):
    livre_bytes: int
    total_bytes: int


class Area(_Fechado):
    chave: ChaveArea
    arquivos: int
    bytes: int
    existe: bool


class ArquivoJson(_Fechado):
    nome: NomeJson
    bytes: int
    situacao: SituacaoJson
    erro: Optional[ErroJson] = None


class EstadoJson(_Fechado):
    arquivos: List[ArquivoJson]
    outros: int
    copias_corrompidas: int


class Transacoes(_Fechado):
    situacao: Literal["limpo", "pendente"]
    quantidade: int


class SaudeLocal(_Fechado):
    gerado_em: str = Field(pattern=_ISO_UTC)
    disco: Optional[Disco]
    areas: List[Area]
    estado_json: EstadoJson
    transacoes: Transacoes


class ItemLimpeza(_Fechado):
    acao: Literal["remover", "quarentena"]
    area: Literal["planilhas_entrada", "state", "modelos"]
    caminho: str
    bytes: int


class TotaisLimpeza(_Fechado):
    remover_arquivos: int
    remover_bytes: int
    quarentena_arquivos: int
    quarentena_bytes: int
    preservados: int


class Limpeza(_Fechado):
    aplicada: bool
    itens: List[ItemLimpeza]
    totais: TotaisLimpeza


class RecusaDetalhe(_Fechado):
    codigo: CodigoRecusa
    mensagem: str


class LimpezaPayload(_Fechado):
    confirmado: bool = Field(False, strict=True)


class App(_Fechado):
    versao: str = Field(pattern=r"^[0-9A-Za-z.+-]{1,32}$")
    python: str = Field(pattern=r"^[0-9A-Za-z.+-]{1,32}$")
    sistema: str = Field(pattern=r"^[0-9A-Za-z._+ -]{0,64}$")
    versao_sistema: str = Field(pattern=r"^[0-9A-Za-z._+ -]{0,64}$")


class FuncaoProntidao(_Fechado):
    available: bool
    state: EstadoProntidao


class Prontidao(_Fechado):
    arquivos: Dict[str, EstadoProntidao]
    funcoes: Dict[str, FuncaoProntidao]


class Diagnostico(_Fechado):
    formato: Literal[1]
    gerado_em: str = Field(pattern=_ISO_UTC)
    app: App
    prontidao: Prontidao
    areas: List[Area]
    disco: Optional[Disco]
    estado_json: EstadoJson
    transacoes: Transacoes


@dataclass(frozen=True)
class SaudeLocalRouteServices:
    base_dir: Callable[[], Path]
    # Inventory, ticket and Entra inboxes (their processando/processadas/falhas subfolders).
    entradas: Callable[[], Sequence[Path]]
    chrome_ocupado: Callable[[], bool]
    prontidao: Callable[[], Dict[str, Any]]
    versao_app: Callable[[], str]


_RECUSA_409: Dict[Union[int, str], Dict[str, Any]] = {
    409: {"model": RecusaDetalhe, "description": "Limpeza recusada ({codigo, mensagem})."},
}


def create_saude_local_router(services: SaudeLocalRouteServices) -> APIRouter:
    router = APIRouter()

    def _limpar(aplicar: bool) -> Dict[str, Any]:
        try:
            return saude_local.executar_limpeza(
                services.base_dir(), services.entradas(), services.chrome_ocupado, aplicar=aplicar,
            )
        except saude_local.RecusaLimpeza as recusa:
            raise HTTPException(409, detail={"codigo": recusa.codigo, "mensagem": recusa.mensagem}) from None
        except (OSError, CleanupBlockedError):
            raise HTTPException(503, detail=MSG_LIMPEZA) from None

    @router.get("/api/saude-local", response_model=SaudeLocal)
    def get_saude_local() -> Dict[str, Any]:
        """Space per area, disk, state JSON health and pending transactions; writes nothing."""
        try:
            return saude_local.saude_local(services.base_dir(), services.entradas())
        except OSError:
            raise HTTPException(503, detail=MSG_LEITURA) from None

    @router.post("/api/saude-local/limpeza/previa", response_model=Limpeza, responses=_RECUSA_409)
    def previa_limpeza() -> Dict[str, Any]:
        """Dry-run: lists what the cleanup would remove or quarantine; may create empty .lock files."""
        return _limpar(False)

    @router.post("/api/saude-local/limpeza", response_model=Limpeza, responses=_RECUSA_409)
    def aplicar_limpeza(payload: LimpezaPayload = Body(...)) -> Dict[str, Any]:
        """Applies the cleanup; only with {"confirmado": true}."""
        if payload.confirmado is not True:
            raise HTTPException(422, detail=MSG_SEM_CONFIRMACAO)
        return _limpar(True)

    @router.get("/api/saude-local/diagnostico", response_model=Diagnostico)
    def baixar_diagnostico() -> Response:
        """JSON download built in memory from an allowlist; nothing is written."""
        try:
            dados = saude_local.pacote_diagnostico(
                services.base_dir(), services.entradas(), services.prontidao(), services.versao_app(),
            )
        except OSError:
            raise HTTPException(503, detail=MSG_DIAGNOSTICO) from None
        corpo = Diagnostico.model_validate(dados).model_dump_json(indent=2)
        nome = f"diagnostico-simpress-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}.json"
        return Response(
            content=corpo,
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{nome}"'},
        )

    return router
