"""Automação screen: starts and watches scripts/automacao_rotinas_chrome.py (docs/operacao/automacao-chrome.md).

The routes only start, cancel and read the script run. Exported workbooks are still
imported through the local inbox folders, never uploaded through HTTP.
"""

from dataclasses import dataclass
from datetime import date
from typing import Callable, Literal

from fastapi import APIRouter, Query
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict

from core.errors import DomainError
from domains.chrome_automation import ChromeAutomationRunner
from domains.sebrae_agendamento import AgendadorSebrae

RotinaNome = Literal["os", "inventarios", "usuarios", "ambas", "login", "sebrae"]


class AgendamentoPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ativo: bool


class RotinaPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rotina: RotinaNome


@dataclass(frozen=True)
class AutomationRouteServices:
    runner: Callable[[], ChromeAutomationRunner]
    sebrae: Callable[[], AgendadorSebrae]


def create_automation_router(services: AutomationRouteServices) -> APIRouter:
    router = APIRouter()

    @router.post("/api/automacao/executar", status_code=202)
    def executar_automacao(payload: RotinaPayload):
        """Inicia uma rotina; 409 quando já há uma execução (do site ou do .bat)."""
        return services.runner().start(payload.rotina)

    @router.post("/api/automacao/cancelar", status_code=202)
    def cancelar_automacao():
        """Pede o cancelamento pelo --cancelar do script ou encerra só o processo filho."""
        return services.runner().cancel()

    @router.get("/api/automacao/estado")
    def estado_automacao(
        offset: int = Query(0, ge=0),
        arquivo: str = Query("", max_length=200),
    ):
        """Estado atual e as linhas do log a partir de ``offset`` (polling incremental)."""
        return JSONResponse(services.runner().state(offset, arquivo), headers={"Cache-Control": "no-store"})

    @router.get("/api/automacao/historico")
    def historico_automacao(
        limite: int = Query(15, ge=1, le=50), pagina: int = Query(1, ge=1),
        data_inicio: date | None = None, data_fim: date | None = None,
        rotina: RotinaNome | None = None,
        status: Literal["em_andamento", "concluido", "falha", "cancelado", "ocupada", "interrompido"] | None = None,
    ):
        """Últimas execuções com status, lotes e capturas de erro."""
        result = services.runner().history_page(limite, pagina, start=data_inicio, end=data_fim, routine=rotina, status=status)
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    @router.get("/api/automacao/execucoes/{execucao_id}/log")
    def log_execucao_automacao(execucao_id: str, linhas: int = Query(200, ge=1, le=500)):
        result = services.runner().execution_log(execucao_id, linhas)
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    @router.get("/api/automacao/sebrae/resumo")
    def resumo_sebrae():
        """Agendamento, última e próxima execução, contadores e pendências da sincronização Sebrae."""
        return JSONResponse(services.sebrae().resumo(), headers={"Cache-Control": "no-store"})

    @router.put("/api/automacao/sebrae/agendamento")
    def agendamento_sebrae(payload: AgendamentoPayload):
        """Ativa ou pausa o agendamento de segunda a sexta; 409 ao ativar antes de a rotina estar completa."""
        return JSONResponse(services.sebrae().definir_ativo(payload.ativo), headers={"Cache-Control": "no-store"})

    @router.get("/api/automacao/capturas/{nome}")
    def captura_automacao(nome: str):
        """Captura de tela gravada pelo script em data/logs/automacao_chrome."""
        path = services.runner().capture_path(nome)
        if path is None:
            raise DomainError("Captura não encontrada.", status_code=404)
        return FileResponse(path, media_type="image/png", headers={"Cache-Control": "no-store"})

    return router
