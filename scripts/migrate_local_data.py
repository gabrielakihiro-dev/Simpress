"""Move pre-data-directory local files into the current Simpress layout."""

from __future__ import annotations

import hashlib
import os
import shutil
import sys
from pathlib import Path
from typing import Dict, List, Tuple

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from core import integrity


class MigrationConflictError(RuntimeError):
    """A migration would overwrite data or run during an unfinished operation."""


_LEGACY_TRANSFER_TEMPLATE = Path("planilhas_entrada") / "(MODELO) - TRANSFERENCIA SIMPRESS.xlsx"


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _template_conflict_archive(root: Path, source: Path, digest: str) -> Path | None:
    """Keep a differing legacy transfer template outside the active input folder."""
    try:
        relative_source = source.relative_to(root)
    except ValueError:
        return None
    if relative_source != _LEGACY_TRANSFER_TEMPLATE:
        return None

    archive_directory = root / "data" / "migration_conflicts" / "planilhas_entrada"
    archive_name = f"{source.stem}__sha256-{digest}{source.suffix}"
    return archive_directory / archive_name


def _legacy_mappings(project_root: Path) -> Tuple[List[Tuple[Path, Path]], List[Tuple[Path, Path]]]:
    directory_mappings = [
        (project_root / "planilhas_entrada", project_root / "data" / "planilhas_entrada"),
        (project_root / "apelidos_modificados", project_root / "data" / "state" / "apelidos_modificados"),
        (project_root / "historico_comparacoes", project_root / "data" / "state" / "historico_comparacoes"),
    ]
    file_mappings = [
        (project_root / "apelidos_modificados.json", project_root / "data" / "state" / "apelidos_modificados" / "apelidos_modificados.json"),
        (project_root / "unidades_custom.json", project_root / "data" / "state" / "unidades_custom.json"),
        (project_root / "historico_alteracoes.json", project_root / "data" / "state" / "historico_alteracoes.json"),
        (project_root / "historico_apelidos.json", project_root / "data" / "state" / "historico_apelidos.json"),
        (project_root / "historico_comparacoes.json", project_root / "data" / "state" / "historico_comparacoes" / "historico_comparacoes.json"),
    ]
    return directory_mappings, file_mappings


def migrate_local_data(project_root: Path) -> Dict[str, int]:
    """Migrate legacy locations without overwriting differing destination files."""
    root = Path(project_root).resolve()
    old_inputs = root / "planilhas_entrada"
    if old_inputs.is_dir() and any(
        path.is_dir() and path.name.startswith(".upload-staging-")
        for path in old_inputs.iterdir()
    ):
        raise MigrationConflictError(
            "Há um upload temporário em andamento em planilhas_entrada. Encerre o servidor e repita a migração depois."
        )

    try:
        integrity.recover_pending_transactions(root)
    except Exception as error:
        raise MigrationConflictError(
            "Não foi possível concluir a recuperação em .transactions. Os dados antigos foram preservados; resolva a recuperação e execute a migração novamente."
        ) from error
    transaction_dir = root / ".transactions"
    if transaction_dir.is_dir() and any(transaction_dir.iterdir()):
        raise MigrationConflictError(
            "A recuperação deixou arquivos pendentes em .transactions. Os dados antigos foram preservados; resolva a recuperação e execute a migração novamente."
        )

    directory_mappings, file_mappings = _legacy_mappings(root)
    mappings: List[Tuple[Path, Path]] = []
    legacy_roots: List[Path] = []
    for source_root, destination_root in directory_mappings:
        if not source_root.exists():
            continue
        if source_root.is_symlink() or not source_root.is_dir():
            raise MigrationConflictError(f"O local legado não é uma pasta segura: {source_root.name}")
        legacy_roots.append(source_root)
        for source in sorted(source_root.rglob("*")):
            if source.is_symlink():
                raise MigrationConflictError(f"A pasta legada contém um link que precisa de revisão: {source.name}")
            if source.is_file():
                mappings.append((source, destination_root / source.relative_to(source_root)))

    for source, destination in file_mappings:
        if source.exists():
            if source.is_symlink() or not source.is_file():
                raise MigrationConflictError(f"O arquivo legado não é regular: {source.name}")
            mappings.append((source, destination))

    pending: List[Tuple[Path, Path]] = []
    pending_archives: List[Tuple[Path, Path]] = []
    duplicates: List[Tuple[Path, Path]] = []
    planned_destinations: Dict[Path, Path] = {}
    preserved_template_conflicts = 0
    for source, destination in mappings:
        if destination.exists() and (not destination.is_file() or _digest(source) != _digest(destination)):
            archive = _template_conflict_archive(root, source, _digest(source))
            if archive is not None:
                preserved_template_conflicts += 1
                if archive.exists():
                    if not archive.is_file() or _digest(source) != _digest(archive):
                        raise MigrationConflictError(
                            f"O arquivo de preservação já existe com conteúdo diferente: {archive.relative_to(root)}"
                        )
                else:
                    previous_source = planned_destinations.get(archive)
                    if previous_source is not None and _digest(previous_source) != _digest(source):
                        raise MigrationConflictError(
                            f"Duas fontes locais diferentes apontam para o mesmo arquivo de preservação: {archive.relative_to(root)}"
                        )
                    planned_destinations[archive] = source
                    pending_archives.append((source, archive))
                continue

        previous_source = planned_destinations.get(destination)
        if previous_source is not None:
            if _digest(previous_source) != _digest(source):
                raise MigrationConflictError(
                    f"Duas fontes locais diferentes apontam para o mesmo destino: {destination.relative_to(root)}"
                )
            duplicates.append((source, destination))
            continue
        planned_destinations[destination] = source
        if destination.exists():
            if not destination.is_file() or _digest(source) != _digest(destination):
                raise MigrationConflictError(
                    f"O destino já existe com conteúdo diferente: {destination.relative_to(root)}"
                )
            duplicates.append((source, destination))
        else:
            pending.append((source, destination))

    moved: List[Tuple[Path, Path]] = []
    archived: List[Path] = []
    created_directories: List[Path] = []
    try:
        for source, destination in pending_archives:
            missing_parents = []
            parent = destination.parent
            while not parent.exists():
                missing_parents.append(parent)
                parent = parent.parent
            destination.parent.mkdir(parents=True, exist_ok=True)
            created_directories.extend(reversed(missing_parents))
            with source.open("rb") as source_stream, destination.open("xb") as destination_stream:
                archived.append(destination)
                shutil.copyfileobj(source_stream, destination_stream, 1024 * 1024)
                destination_stream.flush()
                os.fsync(destination_stream.fileno())
            shutil.copystat(source, destination)

        for source, destination in pending:
            missing_parents = []
            parent = destination.parent
            while not parent.exists():
                missing_parents.append(parent)
                parent = parent.parent
            destination.parent.mkdir(parents=True, exist_ok=True)
            created_directories.extend(reversed(missing_parents))
            source.replace(destination)
            moved.append((source, destination))
    except OSError:
        for source, destination in reversed(moved):
            if destination.exists() and not source.exists():
                source.parent.mkdir(parents=True, exist_ok=True)
                destination.replace(source)
        for destination in reversed(archived):
            try:
                destination.unlink()
            except OSError:
                pass
        for directory in reversed(created_directories):
            try:
                directory.rmdir()
            except OSError:
                pass
        raise

    removed_duplicates = 0
    for source, destination in duplicates:
        if source.exists() and destination.exists() and _digest(source) == _digest(destination):
            source.unlink()
            removed_duplicates += 1

    for legacy_root in legacy_roots:
        for directory in sorted(legacy_root.rglob("*"), key=lambda item: len(item.parts), reverse=True):
            if directory.is_dir():
                try:
                    if not any(directory.iterdir()):
                        directory.rmdir()
                except OSError:
                    # Empty legacy folders are optional cleanup; preserve them if Windows denies removal.
                    continue
        try:
            if legacy_root.is_dir() and not any(legacy_root.iterdir()):
                legacy_root.rmdir()
        except OSError:
            # Do not fail startup when only removing an empty legacy folder is blocked.
            pass

    return {
        "movidos": len(moved),
        "duplicatas_iguais_removidas": removed_duplicates,
        "conflitos_preservados": preserved_template_conflicts,
    }


if __name__ == "__main__":
    project_root = Path(__file__).resolve().parents[1]
    try:
        result = migrate_local_data(project_root)
    except MigrationConflictError as error:
        raise SystemExit(f"Migração interrompida sem sobrescrever dados: {error}") from error
    except OSError as error:
        raise SystemExit(f"Falha ao migrar dados locais: {type(error).__name__}") from error
    print(
        "Dados locais organizados: "
        f"{result['movidos']} arquivo(s) movido(s), "
        f"{result['duplicatas_iguais_removidas']} cópia(s) idêntica(s) removida(s), "
        f"{result['conflitos_preservados']} versão(ões) do modelo preservada(s) em data\\migration_conflicts."
    )
