"""Local-only API for the UX "Gerar ticket" from the Transporte tab: prepare, choose address, fill/send, cancel."""
from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator

from domains.ux_chamados import SOLICITANTE_PADRAO
from domains.ux_ticket import CAMPOS_SOLICITANTE, CHAMADO_INTERNO_MAX, DESCRICAO_MAX, TicketsUX
from routers.transfers import TransferenciaPayload, gerar_planilha_transferencia_bytes
from routers.ux_chamados import CancelarPayload, SeriePayload, executar_ux as executar

SESSION_ID = r"^[0-9a-f]{32}$"


def _sem_controle(valor: str) -> str:
    if any(ord(c) < 32 for c in valor):
        raise ValueError("Não use caracteres de controle.")
    return valor


class PrepararTicketPayload(TransferenciaPayload):
    """The same body as /api/gerar-planilha (the attachment is rebuilt from it) plus the delivery CEP."""
    entrega_cep: str = Field(min_length=8, max_length=12)
    conferido: StrictBool = False


class PrepararAlterarEnderecoPayload(SeriePayload):
    """"Alterar Endereço": only the série; no workbook, CNPJ or CEP (the Registro text comes in /enviar)."""
    conferido: StrictBool = False


class EscolherEnderecoPayload(SeriePayload):
    session_id: str = Field(pattern=SESSION_ID)
    endereco: str = Field(min_length=1, max_length=500)


class SolicitanteTicketPayload(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    nome: str = Field(min_length=1, max_length=100)
    email: str = Field(min_length=3, max_length=100, pattern=r"^[^@\s]+@[^@\s]+$")
    telefone: str = Field(min_length=1, max_length=40)

    @field_validator("nome", "email", "telefone")
    @classmethod
    def sem_caractere_de_controle(cls, valor: str) -> str:
        return _sem_controle(valor)


class EnviarTicketPayload(SeriePayload):
    session_id: str = Field(pattern=SESSION_ID)
    descricao: str = Field(max_length=DESCRICAO_MAX)
    solicitante: SolicitanteTicketPayload
    chamado_interno: str = Field("", max_length=CHAMADO_INTERNO_MAX)
    enviar: StrictBool = False
    confirmado: StrictBool = False


def create_ux_ticket_router(servico: TicketsUX, template_provider: Callable[[], Path]) -> APIRouter:
    router = APIRouter(prefix="/api/ux/gerar-ticket")

    @router.get("/solicitante")
    def solicitante() -> dict[str, str]:
        """Default solicitante for the modal; served here so no corporate e-mail ships in the front-end files."""
        return {campo: SOLICITANTE_PADRAO[campo] for campo in CAMPOS_SOLICITANTE}

    @router.post("/preparar", response_model=None)
    def preparar(payload: PrepararTicketPayload) -> dict[str, Any] | JSONResponse:
        def acao() -> dict[str, Any]:
            nome, conteudo = gerar_planilha_transferencia_bytes(payload, template_provider())
            return servico.preparar(
                serial=payload.serial, entrega_endereco=payload.entrega_endereco, entrega_cidade=payload.entrega_cidade,
                entrega_cep=payload.entrega_cep, entrega_cnpj=payload.entrega_cnpj,
                arquivo_nome=nome, arquivo=conteudo, conferido=payload.conferido,
            )
        resultado: dict[str, Any] | JSONResponse = executar(acao)
        return resultado

    @router.post("/preparar-alterar-endereco", response_model=None)
    def preparar_alterar_endereco(payload: PrepararAlterarEnderecoPayload) -> dict[str, Any] | JSONResponse:
        resultado: dict[str, Any] | JSONResponse = executar(lambda: servico.preparar_alterar_endereco(
            serial=payload.serial, conferido=payload.conferido,
        ))
        return resultado

    @router.post("/escolher-endereco", response_model=None)
    def escolher_endereco(payload: EscolherEnderecoPayload) -> dict[str, Any] | JSONResponse:
        resultado: dict[str, Any] | JSONResponse = executar(lambda: servico.escolher_endereco(
            session_id=payload.session_id, serial=payload.serial, endereco=payload.endereco,
        ))
        return resultado

    @router.post("/enviar", response_model=None)
    def enviar(payload: EnviarTicketPayload) -> dict[str, Any] | JSONResponse:
        resultado: dict[str, Any] | JSONResponse = executar(lambda: servico.executar(
            session_id=payload.session_id, serial=payload.serial, descricao=payload.descricao,
            solicitante=payload.solicitante.model_dump(), chamado_interno=payload.chamado_interno,
            enviar=payload.enviar, confirmado=payload.confirmado,
        ))
        return resultado

    @router.post("/cancelar", response_model=None)
    def cancelar(payload: CancelarPayload) -> dict[str, str] | JSONResponse:
        resultado: dict[str, str] | JSONResponse = executar(lambda: servico.cancelar(payload.session_id))
        return resultado

    return router
