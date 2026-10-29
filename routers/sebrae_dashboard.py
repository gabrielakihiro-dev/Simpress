"""Chamados Sebrae na tela Automação: importar o Dashboard, listar os novos e gerar as linhas para colar.

Nada é gravado no Dashboard; no SoftExpert só a confirmação de associar o chamado ao usuário, aceita pela rotina. O Dashboard importado vira só a lista de números já lançados
(``data/state``); a leitura do SoftExpert é a rotina ``sebrae`` (scripts/sebrae_leitura.py).
Ver docs/operacao/sincronizar-chamados-sebrae.md ("Tela no site").
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence

from fastapi import APIRouter, File, Query, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from core.errors import DomainBusyError, DomainValidationError
from core.config import format_size_limit
from domains import sebrae_historico, sebrae_novos
from domains.sebrae_dashboard import DashboardInvalido, ler_coluna_c, ler_status_chamados

MAX_CHAMADOS_POR_EXPORTACAO = 200
logger = logging.getLogger(__name__)


class ChamadoManual(BaseModel):
    model_config = ConfigDict(extra="forbid")

    numero: str = Field(..., min_length=1, max_length=40)
    A: str = Field("", max_length=200)
    B: str = Field("", max_length=200)
    D: str = Field("", max_length=40)
    J: str = Field("", max_length=40)
    R: str = Field("", max_length=40)
    S: str = Field("", max_length=200)


class ExportarPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    chamados: List[ChamadoManual] = Field(..., min_length=1, max_length=MAX_CHAMADOS_POR_EXPORTACAO)


@dataclass(frozen=True)
class SebraeDashboardServices:
    caminhos: Callable[[], sebrae_novos.Caminhos]
    max_upload_bytes: Callable[[], int]
    registros: Callable[[], Sequence[Mapping[str, Any]]]  # equipment records by person name (EquipamentosDetalhes, Endpoint, Entra)
    relatorio_chamados: Callable[[], Optional[Mapping[str, Any]]]  # ticket report, for column E


def create_sebrae_dashboard_router(services: SebraeDashboardServices) -> APIRouter:
    router = APIRouter()

    def _relatorio() -> Optional[Mapping[str, Any]]:
        try:
            return services.relatorio_chamados()
        except (OSError, ValueError):
            return None  # an unreadable ticket report only leaves column E empty

    def _estado() -> Dict[str, Any]:
        caminhos = services.caminhos()
        importado = sebrae_novos.ler_existentes(caminhos.existentes)
        lancados = importado["numeros"] if importado else frozenset()
        novos = sebrae_novos.ler_novos(caminhos.novos, lancados) if importado else None
        return {
            "importado": None if importado is None else {
                "arquivo": importado["arquivo"], "importado_em": importado["importado_em"], "total": len(lancados),
            },
            "novos": None if novos is None else {
                "lidos_em": novos["lidos_em"], "ignorados": novos["ignorados"], "pendentes": novos["pendentes"],
                "erros": novos["erros"],
                "formulario": sebrae_novos.formulario(novos["chamados"], services.registros(), _relatorio()),
            },
        }

    @router.get("/api/sebrae/novos")
    def novos_chamados():
        """Dashboard importado e chamados novos lidos do SoftExpert, com as colunas automáticas já calculadas."""
        return JSONResponse(_estado(), headers={"Cache-Control": "no-store"})

    @router.post("/api/sebrae/dashboard")
    async def importar_dashboard(file: UploadFile = File(...)):
        nome = re.split(r"[/\\]", str(file.filename or ""))[-1]
        if not nome.lower().endswith(".xlsx"):
            raise DomainValidationError("Selecione o Dashboard Operacional_SEBRAE em .xlsx.", status_code=422)
        limite = services.max_upload_bytes()
        conteudo = await file.read(limite + 1)
        if not conteudo:
            raise DomainValidationError("O arquivo do Dashboard está vazio.", status_code=422)
        if len(conteudo) > limite:
            raise DomainValidationError(f"O Dashboard excede o limite de {format_size_limit(limite)}.", status_code=413)
        try:
            numeros = await asyncio.to_thread(ler_coluna_c, conteudo)
        except DashboardInvalido as erro:
            raise DomainValidationError(str(erro), status_code=422) from None
        anteriores = sebrae_novos.ler_existentes(services.caminhos().existentes)
        await asyncio.to_thread(sebrae_novos.salvar_existentes, services.caminhos().existentes, numeros, nome)
        historico_ok = await asyncio.to_thread(_registrar_historico, conteudo, nome, anteriores)
        return JSONResponse({**_estado(), "historico_ok": historico_ok}, headers={"Cache-Control": "no-store"})

    def _registrar_historico(conteudo: bytes, nome: str, anteriores: Optional[Mapping[str, Any]]) -> bool:
        """The history never blocks an import: a failure only turns ``historico_ok`` false."""
        try:
            sebrae_historico.registrar_importacao(
                services.caminhos().historico, arquivo=nome, sha256=hashlib.sha256(conteudo).hexdigest(),
                mapa=ler_status_chamados(conteudo), base_numeros=anteriores["numeros"] if anteriores else None,
            )
            return True
        except Exception as erro:  # noqa: BLE001 - log only the type, never ticket data
            logger.warning("Histórico do Dashboard Sebrae não gravado (%s).", type(erro).__name__)
            return False

    @router.get("/api/sebrae/historico")
    def listar_historico(
        limite: int = Query(50, ge=1, le=200),
        pagina: int = Query(1, ge=1, le=1000),
        tipo: str = Query("", pattern="^(importacao|busca)?$"),
    ):
        """Importações e buscas, da mais recente para a mais antiga; itens leves (só contagens)."""
        try:
            corpo = sebrae_historico.listar(services.caminhos().historico, limite, pagina, tipo)
        except sebrae_historico.HistoricoIlegivel as erro:
            raise DomainBusyError(str(erro)) from None
        return JSONResponse(corpo, headers={"Cache-Control": "no-store"})

    @router.get("/api/sebrae/historico/{entrada_id}")
    def detalhe_historico(entrada_id: str):
        try:
            entrada = sebrae_historico.obter(services.caminhos().historico, entrada_id)
        except sebrae_historico.HistoricoIlegivel as erro:
            raise DomainBusyError(str(erro)) from None
        if entrada is None:
            raise DomainValidationError("Entrada do histórico não encontrada.", status_code=404)
        return JSONResponse(entrada, headers={"Cache-Control": "no-store"})

    @router.post("/api/sebrae/exportar")
    def exportar(payload: ExportarPayload):
        """Blocos A:P e R:S dos chamados enviados; 422 se faltar campo manual ou o chamado já não for novo."""
        caminhos = services.caminhos()
        importado = sebrae_novos.ler_existentes(caminhos.existentes)
        if importado is None:
            raise DomainValidationError("Importe o Dashboard antes de exportar.", status_code=422)
        novos = sebrae_novos.ler_novos(caminhos.novos, importado["numeros"])
        if novos is None:
            raise DomainValidationError("Busque os chamados novos antes de exportar.", status_code=422)
        manuais = {item.numero: item.model_dump(exclude={"numero"}) for item in payload.chamados}
        if len(manuais) != len(payload.chamados):
            raise DomainValidationError("Há chamados repetidos na exportação.", status_code=422)
        escolhidos = [c for c in novos["chamados"] if c.numero in manuais]
        desconhecidos = sorted(set(manuais) - {c.numero for c in escolhidos})
        if desconhecidos:
            raise DomainValidationError(f"{desconhecidos[0]} não está entre os chamados novos.", status_code=422)
        try:
            resultado = sebrae_novos.exportar(escolhidos, manuais, services.registros(), _relatorio())
        except sebrae_novos.ManuaisInvalidos as erro:
            raise DomainValidationError(str(erro), status_code=422) from None
        return JSONResponse(resultado, headers={"Cache-Control": "no-store"})

    return router
