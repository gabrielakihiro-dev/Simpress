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
from core.local_paths import is_link_or_junction


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


def _origin_record(since: datetime, pair: dict) -> dict:
    return {
        "inicio_execucao": since.isoformat(),
        "fontes": {role: value[2] for role, value in pair.items()},
    }


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _matches_origin(batch_dir: Path, batch_tag: str, origin_record: dict, pair: dict) -> bool:
    if is_link_or_junction(batch_dir) or not batch_dir.is_dir():
        return False
    try:
        origin = json.loads((batch_dir / "_origem.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        return False
    if not (
        isinstance(origin, dict)
        and origin.get("lote_id") == batch_tag
        and origin.get("inicio_execucao") == origin_record["inicio_execucao"]
        and origin.get("fontes") == origin_record["fontes"]
    ):
        return False
    for role, (name, _payload, source) in pair.items():
        role_dir = batch_dir / role
        path = role_dir / name
        if is_link_or_junction(role_dir) or not role_dir.is_dir():
            return False
        if is_link_or_junction(path) or not path.is_file():
            return False
        try:
            if _file_sha256(path) != source.get("sha256"):
                return False
        except OSError:
            return False
    return True


def _find_batch(inbox: Path, base_tag: str, origin_record: dict, pair: dict) -> tuple[str, Path | None, str | None]:
    statuses = ("pendentes", "processando", "processadas", "falhas")
    existing: dict[str, list[tuple[str, Path]]] = {}
    for status in statuses:
        status_dir = inbox / status
        if not status_dir.is_dir():
            continue
        for batch_dir in status_dir.iterdir():
            tag = batch_dir.name
            suffix = tag.removeprefix(f"{base_tag}_")
            if tag == base_tag or (tag.startswith(f"{base_tag}_") and suffix.isascii() and suffix.isdigit()):
                existing.setdefault(tag, []).append((status, batch_dir))

    # A previously occupied ID can disappear while a suffixed batch still exists.
    # Look for matching provenance in every batch before allocating the first gap.
    for batch_tag in sorted(existing):
        for status, batch_dir in existing[batch_tag]:
            if _matches_origin(batch_dir, batch_tag, origin_record, pair):
                return batch_tag, batch_dir, status

    sequence = 1
    while True:
        batch_tag = base_tag if sequence == 1 else f"{base_tag}_{sequence:02d}"
        if batch_tag not in existing:
            return batch_tag, None, None
        sequence += 1


def prepare(downloads: Path, since: datetime, inbox: Path) -> dict:
    if since.tzinfo is None:
        raise ValueError("Informe --since com fuso horário, por exemplo 2026-10-20T12:00:00-03:00.")

    oracle_prefixes = ["Gestão de Solicitações", "Gestao de Solicitacoes", "Gestão de Solicitacoes"]
    ux_prefixes = ["Acompanhamento_de_pedidos", "Acompanhamento de pedidos"]

    pair = {
        "oracle": recent_workbook(downloads, oracle_prefixes, since),
        "simpress": recent_workbook(downloads, ux_prefixes, since),
    }

    base_tag = f"OS_{since.strftime('%Y%m%d_%H%M')}"
    origin_record = _origin_record(since, pair)
    batch_tag, existing, status = _find_batch(inbox, base_tag, origin_record, pair)
    if existing is not None:
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

        while True:
            (staging / "_origem.json").write_text(json.dumps({
                "lote_id": batch_tag,
                **origin_record,
            }, ensure_ascii=False, indent=2), encoding="utf-8")
            try:
                publish_staging(staging, pending / batch_tag)
                break
            except FileExistsError:
                # Another preparation may have claimed the candidate after our scan.
                batch_tag, existing, status = _find_batch(inbox, base_tag, origin_record, pair)
                if existing is not None:
                    return {"lote_id": batch_tag, "pasta": str(existing), "estado": status, "reutilizado": True}
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
