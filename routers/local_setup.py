"""Local model imports with validation, recoverable replacement and backups."""

import asyncio
import io
import logging
import re
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel, Field, field_validator

from core.async_workers import await_worker_completion
from core.config import format_size_limit
from domains.local_setup import load_origin_contact, save_origin_contact, validate_local_model
from core.integrity import AtomicFileTransaction, FileBusyError, FileTransactionError, WorkbookSafetyError
from core.xlsx_safety import WORKBOOK_READ_ERRORS
from routers.transfers import TransferenciaPayload


logger = logging.getLogger(__name__)


class ContatoOrigemPayload(BaseModel):
    """Origin contact typed on the transfer screen; validated like the transfer form."""
    contato: str = Field("", max_length=160)
    email: str = Field("", max_length=254)
    telefone: str = Field("", max_length=64)

    @field_validator("contato")
    @classmethod
    def strip_contact(cls, value: str) -> str:
        return value.strip()

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        return TransferenciaPayload.validate_email(value)

    @field_validator("telefone")
    @classmethod
    def validate_phone(cls, value: str) -> str:
        return TransferenciaPayload.validate_phone(value)


def create_local_setup_router(*, model_path, transaction_root, backups_directory,
                              max_upload_bytes, parser_admission, export_dependency_paths, validate_export,
                              origin_contact_file=None):
    router = APIRouter()

    @router.put("/api/config/transferencia/contato-origem")
    def save_transfer_origin_contact(payload: ContatoOrigemPayload):
        if origin_contact_file is None:
            raise HTTPException(404, "Configuração do contato de origem indisponível.")
        path = origin_contact_file()
        # Environment variables win over the file, so their fields may stay blank here.
        environment_fields = {
            field for field, source in load_origin_contact(path)["contato_origem_fontes"].items()
            if source == "ambiente"
        }
        labels = (("retirada_contato", "contato", "Nome"), ("retirada_email", "email", "E-mail"),
                  ("retirada_telefone", "telefone", "Celular"))
        missing = next((label for field, key, label in labels
                        if field not in environment_fields and not getattr(payload, key)), None)
        if missing:
            raise HTTPException(422, f'Preencha o campo "{missing}" do contato de origem.')
        try:
            save_origin_contact(path, payload.contato, payload.email, payload.telefone)
        except (OSError, FileTransactionError, FileBusyError) as error:
            logger.warning("Falha ao gravar o contato de origem (erro=%s).", type(error).__name__)
            raise HTTPException(500, "Não foi possível gravar o contato de origem.") from error
        return load_origin_contact(path)

    def commit_model(kind, data):
        try:
            validate_local_model(io.BytesIO(data), kind)
        except (WorkbookSafetyError, *WORKBOOK_READ_ERRORS) as error:
            logger.warning("Falha ao validar modelo importado (papel=%s, erro=%s).", kind, type(error).__name__)
            raise HTTPException(400, f"Modelo inválido: {error}") from error
        target = model_path(kind)
        backup = backups_directory() / "modelos" / (
            datetime.now().strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex
        ) / target.name
        # Include the base and aliases in the same lock set as export validation.
        dependencies = export_dependency_paths() if kind == "exportacao" else []
        with AtomicFileTransaction(transaction_root(), [target, backup, *dependencies]) as transaction:
            if target.is_file():
                transaction.stage_bytes(backup, target.read_bytes())
            transaction.stage_bytes(target, data)
            transaction.apply()
            if kind == "exportacao":
                reason = validate_export()
                if reason:
                    raise HTTPException(400, reason)
            transaction.commit()
        return {"sucesso": True, "mensagem": "Modelo validado e importado.", "arquivo": target.name}

    @router.post("/api/modelos/{tipo}/importar")
    async def import_model(tipo: str, file: UploadFile = File(...)):
        admission = None
        try:
            if tipo not in {"transferencia", "exportacao"}:
                raise HTTPException(404, "Tipo de modelo não encontrado.")
            name = re.split(r"[/\\]", str(file.filename or ""))[-1]
            if Path(name).suffix.lower() != ".xlsx":
                raise HTTPException(400, "Selecione um modelo .xlsx.")
            data = await file.read(max_upload_bytes() + 1)
            if not data:
                raise HTTPException(400, "O modelo está vazio.")
            model_limit = max_upload_bytes()
            if len(data) > model_limit:
                raise HTTPException(413, f"O modelo excede o limite de {format_size_limit(model_limit)}.")
            admission = parser_admission()
            if not admission.acquire(blocking=False):
                admission = None
                raise HTTPException(503, "A análise de planilhas está ocupada. Tente novamente em instantes.")
            worker = asyncio.create_task(asyncio.to_thread(commit_model, tipo, data))
            return await await_worker_completion(worker)
        except FileBusyError as error:
            raise HTTPException(409, str(error)) from error
        except FileTransactionError as error:
            raise HTTPException(500, "Não foi possível gravar o modelo; a transação foi revertida.") from error
        finally:
            if admission is not None:
                admission.release()
            await file.close()

    return router, import_model
