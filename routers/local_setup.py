"""Local model imports with validation, recoverable replacement and backups."""

import asyncio
import io
import logging
import re
import unicodedata
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel, Field, field_validator

from core.async_workers import await_worker_completion
from core.config import format_size_limit
from domains.local_setup import (
    REGIONAL_REPRESENTATIVE_CITIES, effective_regional_representative_defaults, load_origin_contact, load_regional_representatives,
    regional_representative_defaults, remove_regional_representative, save_origin_contact, save_regional_representative, validate_local_model,
)
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


def _valid_time(value: str) -> bool:
    """True for a real HH:MM:SS (the regex alone accepts 99:99:99)."""
    try:
        datetime.strptime(value, "%H:%M:%S")
    except ValueError:
        return False
    return True


class RepresentanteRegionalPayload(BaseModel):
    """Edited regional representative of one city; the JSON keys match the front-end list."""
    nome: str = Field("", max_length=160)
    email: str = Field("", max_length=254)
    telefone: str = Field("", max_length=64)
    horario: str = ""
    almoco: str = ""
    pausaDuracao: str = ""

    @field_validator("nome", "horario", "almoco", "pausaDuracao")
    @classmethod
    def strip_text(cls, value: str) -> str:
        return value.strip()

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        return TransferenciaPayload.validate_email(value)

    @field_validator("telefone")
    @classmethod
    def validate_phone(cls, value: str) -> str:
        return TransferenciaPayload.validate_phone(value)

    @field_validator("horario")
    @classmethod
    def validate_schedule(cls, value: str) -> str:
        if not (re.fullmatch(r"\d{2}:\d{2}:\d{2} às \d{2}:\d{2}:\d{2}", value) and all(map(_valid_time, value.split(" às ")))):
            raise ValueError("Informe o expediente no formato 08:00:00 às 18:00:00.")
        inicio, fim = value.split(" às ")
        if inicio >= fim:  # zero-padded HH:MM:SS, already validated: text order is time order
            raise ValueError("O expediente precisa começar antes de terminar: o início deve ser anterior ao fim, como 08:00:00 às 18:00:00.")
        return value

    @field_validator("almoco")
    @classmethod
    def validate_lunch(cls, value: str) -> str:
        if value != "Escritório não fecha" and not (re.fullmatch(r"\d{2}:\d{2}:\d{2}", value) and _valid_time(value)):
            raise ValueError('Informe o almoço como 12:00:00 ou "Escritório não fecha".')
        return value

    @field_validator("pausaDuracao")
    @classmethod
    def validate_break(cls, value: str) -> str:
        if value and not (re.fullmatch(r"\d{1,2}h(\d{2})?", value) and int(value.partition("h")[2] or 0) < 60):
            raise ValueError("Informe a pausa como 1h, 1h30 ou 2h, ou deixe em branco.")
        return value


def create_local_setup_router(*, model_path: Any, transaction_root: Any, backups_directory: Any,
                              max_upload_bytes: Any, parser_admission: Any, export_dependency_paths: Any,
                              validate_export: Any, origin_contact_file: Any = None,
                              regional_representatives_file: Any = None,
                              regional_representative_defaults_file: Any = None) -> Any:
    router = APIRouter()

    @router.put("/api/config/transferencia/contato-origem")
    def save_transfer_origin_contact(payload: ContatoOrigemPayload) -> Any:
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

    def regional_representatives_path() -> Any:
        if regional_representatives_file is None:
            raise HTTPException(404, "Configuração dos representantes regionais indisponível.")
        return regional_representatives_file()

    def defaults_path() -> Any:
        # None means "no local defaults file": the code defaults alone (name, e-mail and phone blank).
        return None if regional_representative_defaults_file is None else regional_representative_defaults_file()

    def known_city(city: str) -> str:
        city = unicodedata.normalize("NFC", city)
        if city not in REGIONAL_REPRESENTATIVE_CITIES:
            raise HTTPException(404, "Cidade não encontrada.")
        return city

    def regional_representatives_state(path: Any) -> dict[str, Any]:
        changes, invalid_file = load_regional_representatives(path)
        return {"alteracoes": changes, "arquivo_invalido": invalid_file}

    @router.get("/api/config/representantes-regionais")
    def get_regional_representatives() -> dict[str, Any]:
        # `padroes` (the single source of the defaults: code plus the local defaults file) comes only on GET; PUT/DELETE answer with the changes alone.
        defaults, defaults_invalid = effective_regional_representative_defaults(defaults_path())
        return {
            **regional_representatives_state(regional_representatives_path()),
            "padroes": regional_representative_defaults(defaults), "padroes_arquivo_invalido": defaults_invalid,
        }

    @router.put("/api/config/representantes-regionais/{cidade}")
    def save_regional_representative_route(cidade: str, payload: RepresentanteRegionalPayload) -> dict[str, Any]:
        path, cidade = regional_representatives_path(), known_city(cidade)
        # With a broken defaults file every field would differ from the blank code defaults and be saved as an edit.
        if effective_regional_representative_defaults(defaults_path())[1]:
            raise HTTPException(409, "O arquivo local de padrões dos representantes está inválido. Corrija-o antes de salvar.")
        try:
            save_regional_representative(path, cidade, payload.model_dump(), defaults_path())
        except (OSError, FileTransactionError, FileBusyError) as error:
            logger.warning("Falha ao gravar representante regional (erro=%s).", type(error).__name__)
            raise HTTPException(500, "Não foi possível gravar o representante regional.") from error
        return regional_representatives_state(path)

    @router.delete("/api/config/representantes-regionais/{cidade}")
    def restore_regional_representative(cidade: str) -> dict[str, Any]:
        path, cidade = regional_representatives_path(), known_city(cidade)
        try:
            removed = remove_regional_representative(path, cidade)
        except (OSError, FileTransactionError, FileBusyError) as error:
            logger.warning("Falha ao restaurar representante regional (erro=%s).", type(error).__name__)
            raise HTTPException(500, "Não foi possível restaurar o representante regional.") from error
        if not removed:
            raise HTTPException(404, "Esta cidade não tem alteração salva.")
        return regional_representatives_state(path)

    def commit_model(kind: str, data: bytes) -> dict[str, Any]:
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
    async def import_model(tipo: str, file: UploadFile = File(...)) -> Any:
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
