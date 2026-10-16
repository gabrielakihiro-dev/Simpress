"""Local model imports with validation, recoverable replacement and backups."""

import asyncio
import io
import logging
import re
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile

from core.async_workers import await_worker_completion
from core.config import format_size_limit
from domains.local_setup import validate_local_model
from core.integrity import AtomicFileTransaction, FileBusyError, FileTransactionError, WorkbookSafetyError
from core.xlsx_safety import WORKBOOK_READ_ERRORS


logger = logging.getLogger(__name__)


def create_local_setup_router(*, model_path, transaction_root, backups_directory,
                              max_upload_bytes, parser_admission, export_dependency_paths, validate_export):
    router = APIRouter()

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
