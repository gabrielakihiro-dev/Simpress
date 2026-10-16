"""Publish a recent Downloads pair atomically to the local inventory inbox."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import shutil
import sys
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from core.config import AUTOMATIC_INVENTORY_INBOX_DIR, MAX_UPLOAD_BYTES


def recent_workbook(downloads: Path, prefix: str, since: datetime):
    candidates = [
        path for path in downloads.iterdir()
        if not path.is_symlink() and path.is_file()
        and path.name.casefold().startswith(prefix.casefold())
        and path.suffix.lower() in (".xlsx", ".zip")
        and path.stat().st_mtime >= since.timestamp()
    ]
    if not candidates:
        raise ValueError(f"Nenhum download recente de {prefix} encontrado; o par não foi publicado.")
    source = max(candidates, key=lambda path: (path.stat().st_mtime_ns, path.name))
    before = source.stat()
    if before.st_size > MAX_UPLOAD_BYTES:
        raise ValueError(f"Download excede 60 MB: {source.name}")
    payload = source.read_bytes()
    after = source.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError(f"Download ainda está mudando: {source.name}")
    name = source.name
    member = None
    if source.suffix.lower() == ".zip":
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            entries = [entry for entry in archive.infolist() if not entry.is_dir()
                       and entry.filename.lower().endswith(".xlsx")
                       and not Path(entry.filename.replace("\\", "/")).name.startswith("~$")]
            if len(entries) != 1:
                raise ValueError(f"O ZIP deve conter exatamente um XLSX: {source.name}")
            entry = entries[0]
            if entry.file_size > MAX_UPLOAD_BYTES:
                raise ValueError("A planilha extraída excede 60 MB.")
            member = entry.filename
            name = Path(member.replace("\\", "/")).name
            payload = archive.read(entry)
    if not payload or len(payload) > MAX_UPLOAD_BYTES:
        raise ValueError(f"Tamanho inválido: {name}")
    with zipfile.ZipFile(io.BytesIO(payload)) as workbook:
        if not {"[Content_Types].xml", "xl/workbook.xml"}.issubset(workbook.namelist()):
            raise ValueError(f"Arquivo não é um XLSX válido: {name}")
    return name, payload, {
        "download": str(source), "modificado_em": datetime.fromtimestamp(after.st_mtime).astimezone().isoformat(),
        "membro_zip": member, "arquivo": name, "sha256": hashlib.sha256(payload).hexdigest(),
    }


def prepare(downloads: Path, since: datetime, inbox: Path) -> dict:
    if since.tzinfo is None:
        raise ValueError("Informe --since com fuso horário, por exemplo 2026-10-10T23:03:59-03:00.")
    pair = {
        "endpoint": recent_workbook(downloads, "InvAllComputersSummary", since),
        "simpress": recent_workbook(downloads, "EquipamentosDetalhes", since),
    }
    fingerprint = hashlib.sha256((since.isoformat() + "|" + "|".join(
        value[2]["sha256"] for value in pair.values())).encode()).hexdigest()[:16]
    batch_id = f"downloads_{since.strftime('%Y%m%d_%H%M%S')}_{fingerprint}"
    for status in ("pendentes", "processando", "processadas", "falhas"):
        existing = inbox / status / batch_id
        if existing.exists():
            return {"lote_id": batch_id, "pasta": str(existing), "estado": status, "reutilizado": True}
    inbox.mkdir(parents=True, exist_ok=True)
    pending = inbox / "pendentes"
    pending.mkdir(exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".preparando-", dir=inbox))
    try:
        for role, (name, payload, _) in pair.items():
            (staging / role).mkdir()
            (staging / role / name).write_bytes(payload)
        (staging / "_origem.json").write_text(json.dumps({
            "lote_id": batch_id, "inicio_execucao": since.isoformat(),
            "fontes": {role: value[2] for role, value in pair.items()},
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        staging.rename(pending / batch_id)
    finally:
        if staging.exists():
            if staging.resolve().parent != inbox.resolve() or not staging.name.startswith(".preparando-"):
                raise ValueError("A pasta temporária saiu da raiz de entrada; limpeza cancelada.")
            shutil.rmtree(staging)
    return {"lote_id": batch_id, "pasta": str(pending / batch_id), "estado": "pendentes", "reutilizado": False}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--since", required=True, help="Início da execução em ISO 8601, com fuso horário.")
    parser.add_argument("--downloads-dir", type=Path, default=Path.home() / "Downloads")
    args = parser.parse_args()
    try:
        result = prepare(args.downloads_dir, datetime.fromisoformat(args.since), AUTOMATIC_INVENTORY_INBOX_DIR)
    except (ValueError, OSError, zipfile.BadZipFile, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
