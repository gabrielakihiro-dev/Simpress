"""Routes for manual equipment aliases and their change history."""

from dataclasses import dataclass
from typing import Any, Callable, List, Optional, Tuple

from fastapi import APIRouter
from pydantic import BaseModel, Field, field_validator

from domains import alias_changes, user_changes
from domains.alias_changes import AliasChangeServices, validate_equipment_serial


class ApelidoUpdatePayload(BaseModel):
    serial: str = Field(..., min_length=1, max_length=128, description="Número de Série do Equipamento")
    apelido: str = Field(..., max_length=160, description="Novo Apelido / Hostname do Equipamento")

    @field_validator("serial")
    @classmethod
    def validate_serial(cls, value: str) -> str:
        return validate_equipment_serial(value)


class UsuarioUpdatePayload(BaseModel):
    serial: str = Field(..., min_length=1, max_length=128, description="Número de Série do Equipamento")
    usuario: str = Field("", max_length=user_changes.MAX_USER_LENGTH, description="Usuário logado manual; vazio remove")

    @field_validator("serial")
    @classmethod
    def validate_serial(cls, value: str) -> str:
        return validate_equipment_serial(value)


class UsuariosConsultaPayload(BaseModel):
    series: List[str] = Field(default_factory=list, max_length=5000, description="Séries cujos usuários logados serão consultados")


class ApelidoUndoPayload(BaseModel):
    evento_id: str = Field(..., description="ID do evento de apelido que deve ser desfeito")


@dataclass(frozen=True)
class AliasRouteExports:
    """Routes exposed to ``main`` for direct calls in tests and helpers."""

    get_apelidos_modificados: Callable[..., Any]
    atualizar_apelido: Callable[..., Any]
    get_historico_apelidos: Callable[..., Any]
    excluir_evento_historico_apelido: Callable[..., Any]
    desfazer_alteracao_apelido: Callable[..., Any]
    atualizar_usuario: Callable[..., Any]
    consultar_usuarios_logados: Callable[..., Any]


def create_alias_router(
    services: AliasChangeServices,
    router: Optional[APIRouter] = None,
) -> Tuple[APIRouter, AliasRouteExports]:
    """Register the alias routes on ``router`` (a new one when omitted)."""
    router = APIRouter() if router is None else router

    @router.get("/api/equipamento/apelidos-modificados")
    def get_apelidos_modificados():
        """Retorna o registro de todos os apelidos que foram modificados pelo usuário."""
        return alias_changes.modified_aliases_summary(services)

    @router.post("/api/equipamento/atualizar-apelido")
    def atualizar_apelido(payload: ApelidoUpdatePayload):
        """Atualiza o apelido e registra o valor anterior, o novo e o horário."""
        return alias_changes.update_manual_alias(services, payload.serial, payload.apelido)

    @router.get("/api/historico-alteracoes")
    @router.get("/api/historico-apelidos")
    def get_historico_apelidos():
        return alias_changes.alias_history_listing(services)

    def _event_type(evento_id: str) -> str:
        event = next((item for item in services.load_alias_history() if item.get("id") == evento_id), None)
        return str((event or {}).get("tipo") or "")

    @router.delete("/api/historico-alteracoes/{evento_id}")
    @router.delete("/api/historico-apelidos/{evento_id}")
    def excluir_evento_historico_apelido(evento_id: str):
        event_type = _event_type(evento_id)
        if event_type == user_changes.USER_EVENT_TYPE:
            return user_changes.restore_user_history_event(services, evento_id)
        if event_type == user_changes.WARNING_EVENT_TYPE:
            return user_changes.dismiss_warning_event(services, evento_id)
        return alias_changes.restore_alias_history_event(services, evento_id)

    @router.post("/api/equipamento/apelido/desfazer")
    def desfazer_alteracao_apelido(payload: ApelidoUndoPayload):
        if _event_type(payload.evento_id) == user_changes.USER_EVENT_TYPE:
            return user_changes.undo_user_change(services, payload.evento_id)
        return alias_changes.undo_alias_change(services, payload.evento_id)

    @router.post("/api/equipamento/atualizar-usuario")
    def atualizar_usuario(payload: UsuarioUpdatePayload):
        """Salva (ou limpa) o usuário logado manual de um equipamento sem usuário no Endpoint."""
        return user_changes.update_manual_user(services, payload.serial, payload.usuario)

    @router.post("/api/equipamentos/usuarios-logados")
    def consultar_usuarios_logados(payload: UsuariosConsultaPayload):
        """Usuário logado de cada série, com a mesma regra da pesquisa (Endpoint, senão manual)."""
        return user_changes.logged_users_for_series(services, payload.series)

    return router, AliasRouteExports(
        get_apelidos_modificados=get_apelidos_modificados,
        atualizar_apelido=atualizar_apelido,
        get_historico_apelidos=get_historico_apelidos,
        excluir_evento_historico_apelido=excluir_evento_historico_apelido,
        desfazer_alteracao_apelido=desfazer_alteracao_apelido,
        atualizar_usuario=atualizar_usuario,
        consultar_usuarios_logados=consultar_usuarios_logados,
    )
