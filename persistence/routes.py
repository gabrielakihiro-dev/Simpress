"""Additional operations for the explicitly enabled local pilot."""

import asyncio
import json
import re
from uuid import UUID

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response

from core.async_workers import await_worker_completion
from persistence.boundary import idempotency_key


async def worker(function, *args):
    task = asyncio.create_task(asyncio.to_thread(function,*args))
    return await await_worker_completion(task)


async def update(files, endpoint, details, read):
    try:
        staged = {"endpoint":await read(endpoint,"endpoint"),"detalhes":await read(details,"detalhes")}
        return await worker(files.update,staged,idempotency_key.get())
    finally:
        await endpoint.close()
        await details.close()


def create_files_router(provider, max_bytes):
    router = APIRouter()
    def files():
        backend = provider()
        if backend is None:
            raise HTTPException(404,"Piloto PostgreSQL não está ativo.")
        return backend.files

    async def uploaded(upload):
        try:
            data = await upload.read(max_bytes+1)
            if not data or len(data)>max_bytes:
                raise HTTPException(413,"Arquivo vazio ou acima do limite de 30 MiB.")
            name = re.split(r"[/\\]",str(upload.filename or ""))[-1]
            if not name:
                raise HTTPException(422,"Nome de arquivo inválido.")
            return name,data
        finally:
            await upload.close()

    @router.post("/api/piloto/modelos/{kind}")
    async def template(kind: str, upload: UploadFile = File(...)):
        service = files()
        name,data = await uploaded(upload)
        return await worker(service.template,kind,name,data,idempotency_key.get())

    @router.post("/api/piloto/anotacoes/importar")
    async def annotations(upload: UploadFile = File(...)):
        service = files()
        name,data = await uploaded(upload)
        return await worker(service.annotations,name,data,idempotency_key.get())

    @router.get("/api/piloto/operacoes/{operation}")
    def status(operation: UUID):
        return files().status(operation)

    @router.get("/api/piloto/operacoes")
    def operations():
        service = files()
        with service.backend.transaction() as conn:
            rows = conn.execute("""select id,estado,chave_idempotencia,tentativas,erro_codigo from simpress.operacoes
                where plano<>'{}'::jsonb order by criado_em desc limit 50""").fetchall()
        return {"operacoes":[{**row,"id":str(row["id"])} for row in rows]}

    @router.post("/api/piloto/retencao")
    def retention():
        return files().prune()

    @router.post("/api/piloto/operacoes/{operation}/recuperar")
    def recover(operation: UUID):
        return files().recover(operation)

    @router.post("/api/piloto/operacoes/{operation}/cancelar")
    def cancel(operation: UUID):
        return files().cancel(operation)

    @router.get("/api/arquivos/{oid}")
    def download(oid: UUID):
        content,obj = files().object(oid)
        return Response(content,media_type=obj["mime_type"],headers={"Content-Disposition":'attachment; filename="'+str(oid)+'"',"Cache-Control":"no-store"})

    return router
