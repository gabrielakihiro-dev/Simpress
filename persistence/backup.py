"""Coherent domain + Storage archive, written atomically to Backup_Banco.

This does not contain PostgreSQL roles/passwords or Supabase Auth identities.
Stage 8 must rehearse service recovery before any official cutover.
"""

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import tempfile
import uuid
import zipfile

from persistence.config import PersistenceError
from persistence.files import digest, ready
from persistence.postgres import canonical

TABLES = ("configuracao", "estado_aplicacao", "operacoes", "objetos_arquivo", "arquivos_origem",
    "lotes_inventario", "fontes_lote", "linhas_fonte", "equipamentos_lote", "unidades_catalogo",
    "unidades_customizadas", "apelidos_manuais", "historico_apelidos", "eventos_comparacao",
    "linhas_comparacao", "anotacoes", "pendencias_sincronizacao", "backups_logicos",
    "referencias_backup", "conflitos_importacao")


def verify(path):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or "manifest.json" not in names:
            raise PersistenceError(409,"Manifesto de backup ausente ou duplicado.")
        manifest = json.loads(archive.read("manifest.json"))
        if manifest.get("format") != "simpress-domain-backup-v1" or set(names) != {*manifest["files"],"manifest.json"}:
            raise PersistenceError(409,"Formato ou conteúdo do backup inválido.")
        migrations = manifest.get("migrations",[])
        if (not migrations or len(migrations) != len(set(migrations))
                or set(migrations) != {name for name in names if name.startswith("migrations/") and name.endswith(".sql")}):
            raise PersistenceError(409,"Migrations ausentes ou inconsistentes no backup.")
        for name,entry in manifest["files"].items():
            if name.startswith(("/","\\")) or ".." in Path(name).parts:
                raise PersistenceError(409,"Caminho inválido no backup.")
            content = archive.read(name)
            if len(content) != entry["size"] or digest(content) != entry["sha256"]:
                raise PersistenceError(409,"Um arquivo do backup não confere com o manifesto.")
        snapshot = json.loads(archive.read("domain.json"))
        if set(snapshot) != set(TABLES):
            raise PersistenceError(409,"O backup não contém as 20 tabelas do domínio.")
        if snapshot["estado_aplicacao"][0]["revisao_global"] != manifest["revision"]:
            raise PersistenceError(409,"Revisão do domínio difere do manifesto do backup.")
        for obj in snapshot["objetos_arquivo"]:
            if obj["estado"] == "verificado":
                entry = manifest["files"].get("objects/"+obj["id"])
                if not entry or entry["sha256"] != obj["sha256"] or entry["size"] != obj["tamanho_bytes"]:
                    raise PersistenceError(409,"Referência de Storage ausente no backup.")
        return manifest


def create(files, project_root):
    storage = files.require_storage()
    root = Path(project_root).resolve()
    destination = root/"Backup_Banco"
    if destination.is_symlink() or destination.resolve() != root/"Backup_Banco":
        raise PersistenceError(409,"Destino de backup inválido.")
    destination.mkdir(exist_ok=True)
    migrations = sorted((root/"supabase/migrations").glob("*.sql"))
    if not migrations:
        raise PersistenceError(409,"As migrations do projeto devem acompanhar o backup.")
    with files.backend.transaction() as conn:
        snapshot = {name:ready(conn.execute("select * from simpress."+name).fetchall()) for name in TABLES}
    if any(op["estado"] not in {"confirmada","cancelada"} for op in snapshot["operacoes"]) or any(o["estado"] not in {"verificado","removido"} for o in snapshot["objetos_arquivo"]):
        raise PersistenceError(409,"Conclua ou cancele as operações pendentes antes do backup completo.")
    if any(c["admin_user_id"] for c in snapshot["configuracao"]) and not files.backend.authenticated:
        raise PersistenceError(409,"Este backup do piloto ainda não inclui identidades Auth.")
    revision = snapshot["estado_aplicacao"][0]["revisao_global"]
    target = destination/(datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")+"-r"+str(revision)+"-"+uuid.uuid4().hex+".zip")
    manifest = {"format":"simpress-domain-backup-v1","revision":revision,"files":{},"auth_included":False,
                "auth_reprovision_required":any(c["admin_user_id"] for c in snapshot["configuracao"]),
                "sessions_included":False,
                "migrations":["migrations/"+path.name for path in migrations]}
    handle, temporary = tempfile.mkstemp(prefix=".pending-",suffix=".zip",dir=destination)
    os.close(handle)
    try:
        with zipfile.ZipFile(temporary,"w",compression=zipfile.ZIP_DEFLATED) as archive:
            def add(name,content):
                archive.writestr(name,content)
                manifest["files"][name] = {"sha256":digest(content),"size":len(content)}
            add("domain.json",canonical(snapshot).encode())
            for path in migrations:
                add("migrations/"+path.name,path.read_bytes())
            for obj in snapshot["objetos_arquivo"]:
                if obj["estado"] == "verificado":
                    add("objects/"+obj["id"],storage.get(obj))
            archive.writestr("manifest.json",canonical(manifest).encode())
        verify(temporary)
        with open(temporary,"r+b") as stream:
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary,target)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return target
