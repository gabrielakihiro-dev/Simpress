"""Local import/export of PR Entra display names and manual equipment names."""

from __future__ import annotations

import asyncio
import io
from dataclasses import dataclass
from typing import Any, Callable

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from domains import entra_users


class ManualPersonNamePayload(BaseModel):
    serial: str = Field(..., min_length=1, max_length=128)
    login_atual: str = Field("", max_length=160)
    nome: str = Field("", max_length=entra_users.MAX_NAME_LENGTH)


@dataclass(frozen=True)
class EntraUserServices:
    import_csv: Callable[[bytes], dict[str, Any]]
    status: Callable[[], dict[str, Any]]
    export_xlsx: Callable[[], bytes]
    save_manual_name: Callable[[str, str, str], dict[str, Any]]


def create_entra_users_router(services: EntraUserServices) -> APIRouter:
    router = APIRouter()

    @router.get("/api/usuarios-entra/estado")
    def status():
        return services.status()

    @router.post("/api/usuarios-entra/importar")
    async def import_file(file: UploadFile = File(...)):
        if not file.filename or not file.filename.lower().endswith(".csv"):
            raise HTTPException(status_code=422, detail="Selecione um arquivo CSV do Entra.")
        content = await file.read(entra_users.MAX_CSV_BYTES + 1)
        try:
            return await asyncio.to_thread(services.import_csv, content)
        except (ValueError, UnicodeError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @router.get("/api/usuarios-entra/exportar")
    def export_file():
        try:
            output = services.export_xlsx()
        except ValueError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        return StreamingResponse(
            io.BytesIO(output),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": 'attachment; filename="Nomes_Entra_PR.xlsx"'},
        )

    @router.post("/api/equipamento/nome-pessoa")
    def update_manual_name(payload: ManualPersonNamePayload):
        return services.save_manual_name(payload.serial, payload.login_atual, payload.nome)

    return router
