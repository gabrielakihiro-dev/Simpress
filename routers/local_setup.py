"""Local model imports with validation, recoverable replacement and backups."""

import asyncio
import io
import re
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile

from core.async_workers import await_worker_completion
from domains.local_setup import validate_local_model
from core.integrity import AtomicFileTransaction, FileBusyError, FileTransactionError


def create_local_setup_router(*, enabled, model_path, transaction_root, backups_directory,
                              max_upload_bytes, parser_admission, export_dependency_paths, validate_export):
    router = APIRouter()

    def commit_model(kind, data):
        try:
            validate_local_model(io.BytesIO(data), kind)
        except Exception as error:
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
            if not enabled():
                raise HTTPException(404, "Importação local disponível somente no modo de arquivos.")
            if tipo not in {"transferencia", "exportacao"}:
                raise HTTPException(404, "Tipo de modelo não encontrado.")
            name = re.split(r"[/\\]", str(file.filename or ""))[-1]
            if Path(name).suffix.lower() != ".xlsx":
                raise HTTPException(400, "Selecione um modelo .xlsx.")
            data = await file.read(max_upload_bytes() + 1)
            if not data:
                raise HTTPException(400, "O modelo está vazio.")
            if len(data) > max_upload_bytes():
                raise HTTPException(413, "O modelo excede o limite de 30 MB.")
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
