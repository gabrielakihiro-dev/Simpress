"""Publish a recent ticket Downloads pair atomically to the local ticket inbox."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import shutil
import sys
import tempfile
import time
import zipfile
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from core.config import AUTOMATIC_TICKET_INBOX_DIR, MAX_UPLOAD_BYTES, format_size_limit


def get_default_downloads() -> Path:
    onedrive_downloads = Path(r"C:\Users\gakihiro\OneDrive - SEBRAE\Downloads")
    if onedrive_downloads.is_dir():
        return onedrive_downloads
    return Path.home() / "Downloads"


def recent_workbook(downloads: Path, prefixes: list[str], since: datetime):
    candidates = []
    for path in downloads.iterdir():
        if path.is_symlink() or not path.is_file():
            continue
        name_cf = path.name.casefold()
        if any(name_cf.startswith(p.casefold()) for p in prefixes):
            stat = path.stat()
            # Download vazio (0 bytes) nunca é o arquivo exportado; não deixa ele vencer o válido.
            if path.suffix.lower() in (".xlsx", ".zip") and stat.st_mtime >= since.timestamp() and stat.st_size > 0:
                candidates.append(path)

    if not candidates:
        prefix_str = " / ".join(prefixes)
        raise ValueError(f"Nenhum download recente de [{prefix_str}] encontrado após {since.isoformat()}.")

    source = max(candidates, key=lambda path: (path.stat().st_mtime_ns, path.name))
    before = source.stat()
    if before.st_size > MAX_UPLOAD_BYTES:
        raise ValueError(f"Download excede {format_size_limit(MAX_UPLOAD_BYTES)}: {source.name}")

    payload = source.read_bytes()
    after = source.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError(f"Download ainda está mudando: {source.name}")

    name = source.name
    member = None
    if source.suffix.lower() == ".zip":
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            entries = [
                entry for entry in archive.infolist()
                if not entry.is_dir()
                and entry.filename.lower().endswith(".xlsx")
                and not Path(entry.filename.replace("\\", "/")).name.startswith("~$")
            ]
            if len(entries) != 1:
                raise ValueError(f"O ZIP deve conter exatamente um XLSX: {source.name}")
            entry = entries[0]
            if entry.file_size > MAX_UPLOAD_BYTES:
                raise ValueError(f"A planilha extraída excede {format_size_limit(MAX_UPLOAD_BYTES)}.")
            member = entry.filename
            name = Path(member.replace("\\", "/")).name
            payload = archive.read(entry)

    if not payload or len(payload) > MAX_UPLOAD_BYTES:
        raise ValueError(f"Tamanho inválido: {name}")

    with zipfile.ZipFile(io.BytesIO(payload)) as workbook:
        if not {"[Content_Types].xml", "xl/workbook.xml"}.issubset(workbook.namelist()):
            raise ValueError(f"Arquivo não é um XLSX válido: {name}")

    return name, payload, {
        "download": str(source),
        "modificado_em": datetime.fromtimestamp(after.st_mtime).astimezone().isoformat(),
        "membro_zip": member,
        "arquivo": name,
        "sha256": hashlib.sha256(payload).hexdigest(),
    }


def publish_staging(staging: Path, target: Path, attempts: int = 10, delay_seconds: float = 0.5) -> None:
    """Move the staged batch into place, waiting briefly while OneDrive or antivirus holds the new folder."""
    for attempt in range(attempts):
        try:
            staging.rename(target)
            return
        except PermissionError:
            if attempt == attempts - 1:
                raise
            time.sleep(delay_seconds)


def prepare(downloads: Path, since: datetime, inbox: Path) -> dict:
    if since.tzinfo is None:
        raise ValueError("Informe --since com fuso horário, por exemplo 2026-10-20T12:00:00-03:00.")

    oracle_prefixes = ["Gestão de Solicitações", "Gestao de Solicitacoes", "Gestão de Solicitacoes"]
    ux_prefixes = ["Acompanhamento_de_pedidos", "Acompanhamento de pedidos"]

    pair = {
        "oracle": recent_workbook(downloads, oracle_prefixes, since),
        "simpress": recent_workbook(downloads, ux_prefixes, since),
    }

    batch_tag = f"OS_{since.strftime('%Y%m%d_%H%M')}"
    for status in ("pendentes", "processando", "processadas", "falhas"):
        existing = inbox / status / batch_tag
        if existing.exists():
            return {"lote_id": batch_tag, "pasta": str(existing), "estado": status, "reutilizado": True}

    inbox.mkdir(parents=True, exist_ok=True)
    pending = inbox / "pendentes"
    pending.mkdir(exist_ok=True)

    modelo_dir = inbox / "modelo_lote"
    staging = Path(tempfile.mkdtemp(prefix=".preparando-", dir=inbox))
    try:
        if modelo_dir.is_dir():
            shutil.copytree(modelo_dir, staging, dirs_exist_ok=True)
        else:
            (staging / "oracle").mkdir(exist_ok=True)
            (staging / "simpress").mkdir(exist_ok=True)

        for role, (name, payload, _) in pair.items():
            dest_dir = staging / role
            dest_dir.mkdir(exist_ok=True)
            # Remove existing files like .gitkeep or old files
            for old_f in dest_dir.iterdir():
                if old_f.is_file() and old_f.name != ".gitkeep":
                    old_f.unlink()
            (dest_dir / name).write_bytes(payload)

        (staging / "_origem.json").write_text(json.dumps({
            "lote_id": batch_tag,
            "inicio_execucao": since.isoformat(),
            "fontes": {role: value[2] for role, value in pair.items()},
        }, ensure_ascii=False, indent=2), encoding="utf-8")

        publish_staging(staging, pending / batch_tag)
    finally:
        if staging.exists():
            if staging.resolve().parent != inbox.resolve() or not staging.name.startswith(".preparando-"):
                raise ValueError("A pasta temporária saiu da raiz de entrada; limpeza cancelada.")
            shutil.rmtree(staging)

    return {"lote_id": batch_tag, "pasta": str(pending / batch_tag), "estado": "pendentes", "reutilizado": False}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--since", required=True, help="Início da execução em ISO 8601, com fuso horário.")
    parser.add_argument("--downloads-dir", type=Path, default=get_default_downloads())
    args = parser.parse_args()
    try:
        result = prepare(args.downloads_dir, datetime.fromisoformat(args.since), AUTOMATIC_TICKET_INBOX_DIR)
    except (ValueError, OSError, zipfile.BadZipFile, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
