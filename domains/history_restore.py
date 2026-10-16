"""Restore workflow for inventory backups recorded in the comparison history."""

import filecmp
import hashlib
import hmac
import json
import logging
import os
import shutil
import uuid
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Protocol

from fastapi import HTTPException
from core.integrity import TransactionConflictError, WorkbookSafetyError


logger = logging.getLogger(__name__)


class HistoryRestoreError(Exception):
    """A restore request that cannot proceed; carries the user-facing status and message."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class HistoryRestoreServices(Protocol):
    """Application services the restore workflow reads from the history router's services.

    Members are read-only so the router's frozen services dataclass satisfies the protocol.
    """

    @property
    def comparison_history_path(self) -> Callable[[], Path]: ...
    @property
    def details_upload_path(self) -> Callable[[], Path]: ...
    @property
    def endpoint_upload_path(self) -> Callable[[], Path]: ...
    @property
    def input_directory(self) -> Callable[[], Path]: ...
    @property
    def inventory_state_transaction(self) -> Callable[..., Any]: ...
    @property
    def load_comparison_history(self) -> Callable[[], List[Dict[str, Any]]]: ...
    @property
    def load_database(self) -> Callable[..., Any]: ...
    @property
    def load_modified_apelidos(self) -> Callable[[], Dict[str, str]]: ...
    @property
    def manual_aliases_by_serial(self) -> Callable[[Dict[str, str]], Dict[str, str]]: ...
    @property
    def max_upload_bytes(self) -> int: ...
    @property
    def modified_aliases_path(self) -> Callable[[], Path]: ...
    @property
    def normalize_reference_value(self) -> Callable[[Any], str]: ...
    @property
    def publish_database_state(self) -> Callable[[Dict[str, Any]], None]: ...
    @property
    def upload_backups_directory(self) -> Callable[[], Path]: ...
    @property
    def validate_uploaded_workbook(self) -> Callable[[bytes, str], Dict[str, Any]]: ...


def comparison_event_type(evento: Dict[str, Any]) -> str:
    comparison = evento.get("comparacao")
    if (
        evento.get("tipo") == "restauracao"
        or isinstance(comparison, dict) and comparison.get("tipo_operacao") == "restauracao"
    ):
        return "restauracao"
    return "atualizacao"


def _target_files(services: HistoryRestoreServices) -> Dict[str, Path]:
    return {
        "endpoint": services.endpoint_upload_path(),
        "detalhes": services.details_upload_path(),
    }


def restore_backup_paths(services: HistoryRestoreServices, evento: Dict[str, Any]) -> Dict[str, Path]:
    comparison = evento.get("comparacao")
    if not isinstance(comparison, dict):
        raise HistoryRestoreError(409, "Esta atualização não possui um backup disponível para restauração.")
    relative_value = comparison.get("backup_diretorio")
    if not isinstance(relative_value, str) or not relative_value.strip():
        raise HistoryRestoreError(409, "Esta atualização não possui um backup disponível para restauração.")

    relative_path = Path(relative_value)
    if relative_path.is_absolute() or not relative_path.parts or any(part in {".", ".."} for part in relative_path.parts):
        raise HistoryRestoreError(409, "O caminho do backup desta atualização não é válido.")

    try:
        backup_root = services.upload_backups_directory().resolve(strict=False)
        backup_directory = (services.input_directory() / relative_path).resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        raise HistoryRestoreError(409, "O backup desta atualização não está disponível.") from None
    if backup_directory.parent != backup_root or not backup_directory.is_dir():
        raise HistoryRestoreError(409, "O backup desta atualização não está disponível.")

    missing_roles = comparison.get("backup_arquivos_ausentes")
    invalid_roles = comparison.get("backup_arquivos_invalidos")
    paths: Dict[str, Path] = {}
    for role, target_path in _target_files(services).items():
        if (
            isinstance(missing_roles, dict) and missing_roles.get(role) is True
            or isinstance(invalid_roles, dict) and invalid_roles.get(role) is True
        ):
            raise HistoryRestoreError(409, "O backup desta atualização não contém dois inventários válidos.")
        try:
            role_directory = (backup_directory / role).resolve(strict=True)
            if role_directory.parent != backup_directory or not role_directory.is_dir():
                raise ValueError("invalid backup role directory")
            backup_path = (role_directory / target_path.name).resolve(strict=True)
            if backup_path.parent != role_directory or not backup_path.is_file():
                raise ValueError("invalid backup file")
        except (OSError, RuntimeError, ValueError):
            raise HistoryRestoreError(409, "O backup desta atualização não contém os dois inventários.") from None
        paths[role] = backup_path
    return paths


def event_has_restorable_backup(services: HistoryRestoreServices, evento: Dict[str, Any]) -> bool:
    try:
        restore_backup_paths(services, evento)
        return True
    except HistoryRestoreError:
        return False


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validated_backup_files(
    services: HistoryRestoreServices,
    paths: Dict[str, Path],
) -> Dict[str, Dict[str, Any]]:
    labels = {"endpoint": "no endpoint", "detalhes": "na Simpress"}
    files: Dict[str, Dict[str, Any]] = {}
    for role, backup_path in paths.items():
        label = labels[role]
        try:
            size = backup_path.stat().st_size
            if size <= 0 or size > services.max_upload_bytes:
                raise HistoryRestoreError(409, "O arquivo excede o limite de tamanho ou está vazio.")
            file_bytes = backup_path.read_bytes()
            table = services.validate_uploaded_workbook(file_bytes, role)
        except (HistoryRestoreError, HTTPException) as error:
            raise HistoryRestoreError(
                409,
                f"O backup de {label} não passou na validação: {error.detail}",
            ) from error
        except WorkbookSafetyError as error:
            raise HistoryRestoreError(
                409,
                f"O backup de {label} não passou na validação: {error}",
            ) from error
        except OSError:
            raise HistoryRestoreError(409, f"Não foi possível ler o backup de {label}.") from None
        files[role] = {
            "path": backup_path,
            "name": backup_path.name,
            "bytes": file_bytes,
            "sha256": hashlib.sha256(file_bytes).hexdigest(),
            "records": len(table.get("records", [])),
            "size": size,
            "modified": datetime.fromtimestamp(backup_path.stat().st_mtime).astimezone().isoformat(timespec="seconds"),
        }
    return files


def current_inventory_snapshot(
    services: HistoryRestoreServices,
) -> tuple[Dict[str, Dict[str, Any]], Dict[str, Optional[str]]]:
    metadata: Dict[str, Dict[str, Any]] = {}
    hashes: Dict[str, Optional[str]] = {}
    for role, target_path in _target_files(services).items():
        if target_path.is_symlink():
            raise HistoryRestoreError(409, "Um arquivo ativo foi substituído por um atalho; a restauração foi cancelada.")
        if target_path.exists() and not target_path.is_file():
            raise HistoryRestoreError(409, f"O caminho ativo {target_path.name} não é um arquivo regular.")
        if not target_path.is_file():
            metadata[role] = {"nome": target_path.name, "presente": False}
            hashes[role] = None
            continue
        try:
            stat = target_path.stat()
            if stat.st_size > services.max_upload_bytes:
                raise HistoryRestoreError(409, f"O arquivo ativo {target_path.name} excede o limite permitido para backup.")
            file_hash = sha256_file(target_path)
        except HistoryRestoreError:
            raise
        except OSError:
            raise HistoryRestoreError(409, f"Não foi possível conferir o arquivo ativo {target_path.name}.") from None
        metadata[role] = {
            "nome": target_path.name,
            "presente": True,
            "tamanho_bytes": stat.st_size,
            "modificado_em": datetime.fromtimestamp(stat.st_mtime).astimezone().isoformat(timespec="seconds"),
        }
        hashes[role] = file_hash
    return metadata, hashes


def build_restore_context(services: HistoryRestoreServices, evento_id: str) -> Dict[str, Any]:
    evento = next(
        (item for item in services.load_comparison_history() if isinstance(item, dict) and item.get("id") == evento_id),
        None,
    )
    if evento is None:
        raise HistoryRestoreError(404, "A atualização selecionada não existe no histórico de planilhas.")

    backup_paths = restore_backup_paths(services, evento)
    backup_files = validated_backup_files(services, backup_paths)
    current_files, current_hashes = current_inventory_snapshot(services)
    token_material = {
        "evento_id": evento_id,
        "horario": evento.get("horario"),
        "backup_diretorio": evento.get("comparacao", {}).get("backup_diretorio"),
        "backup_hashes": {role: backup_files[role]["sha256"] for role in sorted(backup_files)},
        "ativos_hashes": current_hashes,
    }
    preview_token = hashlib.sha256(
        json.dumps(token_material, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return {
        "evento": evento,
        "backup_files": backup_files,
        "current_files": current_files,
        "current_hashes": current_hashes,
        "preview_token": preview_token,
    }


def restore_preview(services: HistoryRestoreServices, evento_id: str) -> Dict[str, Any]:
    context = build_restore_context(services, evento_id)
    return {
        "evento_id": evento_id,
        "evento_horario": context["evento"].get("horario"),
        "tipo_evento": comparison_event_type(context["evento"]),
        "arquivos_backup": {
            role: {
                "nome": item["name"],
                "registros": item["records"],
                "tamanho_bytes": item["size"],
                "modificado_em": item["modified"],
            }
            for role, item in context["backup_files"].items()
        },
        "arquivos_atuais": context["current_files"],
        "preview_token": context["preview_token"],
    }


def _back_up_current_inventories(
    services: HistoryRestoreServices,
    evento_id: str,
    target_files: Dict[str, Path],
    current_hashes: Dict[str, Optional[str]],
    persistent_backup_dir: Path,
) -> tuple[Dict[str, bool], Dict[str, bool]]:
    """Copy the active inventories aside so the restore itself can be undone later."""
    persistent_backup_dir.mkdir(parents=True, exist_ok=False)
    missing_current_files: Dict[str, bool] = {}
    invalid_current_files: Dict[str, bool] = {}
    for role, target_path in target_files.items():
        role_backup_dir = persistent_backup_dir / role
        role_backup_dir.mkdir(parents=True, exist_ok=True)
        expected_current_hash = current_hashes[role]
        if not target_path.is_file():
            if expected_current_hash is not None:
                raise TransactionConflictError(f"'{target_path.name}' mudou durante a restauração.")
            missing_current_files[role] = True
            invalid_current_files[role] = False
            continue
        if expected_current_hash is None:
            raise TransactionConflictError(f"'{target_path.name}' mudou durante a restauração.")
        backup_path = role_backup_dir / target_path.name
        shutil.copy2(target_path, backup_path)
        with backup_path.open("r+b") as backup_file:
            backup_file.flush()
            os.fsync(backup_file.fileno())
        if (
            not filecmp.cmp(target_path, backup_path, shallow=False)
            or sha256_file(backup_path) != expected_current_hash
        ):
            raise TransactionConflictError(f"A cópia de segurança de '{target_path.name}' não passou na validação.")
        missing_current_files[role] = False
        try:
            services.validate_uploaded_workbook(backup_path.read_bytes(), role)
            invalid_current_files[role] = False
        except (HTTPException, WorkbookSafetyError):
            invalid_current_files[role] = True
        except Exception:
            logger.exception(
                "Falha inesperada ao validar backup durante restauração (evento=%s, fonte=%s).",
                evento_id,
                role,
            )
            invalid_current_files[role] = True
    return missing_current_files, invalid_current_files


def restore_comparison(services: HistoryRestoreServices, evento_id: str, preview_token: str) -> Dict[str, Any]:
    """Restore both inventories from an event's backup and record the restore in the history.

    Raises HistoryRestoreError for conditions the user must resolve; transaction and
    workbook errors propagate unchanged for the caller to report.
    """
    context = build_restore_context(services, evento_id)
    if not hmac.compare_digest(preview_token, context["preview_token"]):
        raise HistoryRestoreError(
            409,
            "Os arquivos ativos ou o backup mudaram desde a prévia. Atualize a prévia antes de restaurar.",
        )
    if all(
        context["backup_files"][role]["sha256"] == context["current_hashes"][role]
        for role in context["backup_files"]
    ):
        raise HistoryRestoreError(409, "Os dois inventários ativos já correspondem ao backup selecionado.")

    restoration_time = datetime.now().astimezone().isoformat(timespec="seconds")
    restoration_id = uuid.uuid4().hex
    persistent_backup_dir = services.upload_backups_directory() / f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
    target_files = _target_files(services)
    source_event = context["evento"]
    source_comparison = source_event.get("comparacao") or {}
    source_backup_relative = source_comparison.get("backup_diretorio")
    transaction_targets = [
        *target_files.values(),
        services.comparison_history_path(),
        services.modified_aliases_path(),
    ]

    with services.inventory_state_transaction(transaction_targets) as transaction:
        _, locked_current_hashes = current_inventory_snapshot(services)
        if locked_current_hashes != context["current_hashes"]:
            raise HistoryRestoreError(
                409,
                "Os inventários ativos mudaram desde a prévia. Atualize a prévia antes de restaurar.",
            )
        missing_current_files, invalid_current_files = _back_up_current_inventories(
            services, evento_id, target_files, context["current_hashes"], persistent_backup_dir,
        )

        _, backed_up_current_hashes = current_inventory_snapshot(services)
        if backed_up_current_hashes != context["current_hashes"]:
            raise TransactionConflictError("Um inventário ativo mudou durante a cópia de segurança.")

        for role, target_path in target_files.items():
            backup_bytes = context["backup_files"][role]["bytes"]

            def validate_staged_backup(path: Path, current_role=role, expected_bytes=backup_bytes):
                candidate_bytes = path.read_bytes()
                if candidate_bytes != expected_bytes:
                    raise WorkbookSafetyError("O arquivo preparado difere do backup validado.")
                services.validate_uploaded_workbook(candidate_bytes, current_role)

            transaction.stage_bytes(target_path, backup_bytes, validate_staged_backup)

        transaction.apply()
        prepared_state = services.load_database(
            transaction_locked=True,
            publish=False,
        )
        if not isinstance(prepared_state, dict):
            raise RuntimeError("O conjunto restaurado não pôde ser carregado pelo site.")

        restored_files = {role: path.name for role, path in target_files.items()}
        # Overrides are kept on purpose (restoring again brings them back); the count
        # tells the user how many no longer match a serial of the restored inventory.
        restored_serials = {
            services.normalize_reference_value(equipment.get("serial") or key)
            for key, equipment in (prepared_state.get("equipamentos_cache") or {}).items()
            if isinstance(equipment, dict)
        }
        orphan_manual_aliases = len(
            set(services.manual_aliases_by_serial(services.load_modified_apelidos())) - restored_serials
        )
        restoration_comparison = {
            "evento_id": restoration_id,
            "tipo_operacao": "restauracao",
            "horario_comparacao": restoration_time,
            "restauracao_de": {
                "evento_id": evento_id,
                "horario": source_event.get("horario"),
                "tipo": comparison_event_type(source_event),
            },
            "arquivos_restaurados": restored_files,
            "total_endpoint_restaurado": context["backup_files"]["endpoint"]["records"],
            "total_detalhes_restaurado": context["backup_files"]["detalhes"]["records"],
            "total_equipamentos_carregados": prepared_state["stats_cache"].get("total_equipamentos", 0),
            "apelidos_manuais_sem_equipamento": orphan_manual_aliases,
            "backup_diretorio": str(persistent_backup_dir.relative_to(services.input_directory())),
            "backup_arquivos_ausentes": missing_current_files,
            "backup_arquivos_invalidos": invalid_current_files,
            "historico_salvo": True,
        }
        restoration_event = {
            "id": restoration_id,
            "tipo": "restauracao",
            "horario": restoration_time,
            "arquivos_restaurados": restored_files,
            "restauracao_de": restoration_comparison["restauracao_de"],
            "resumo": {
                "restauracao": True,
                "total_endpoint_restaurado": restoration_comparison["total_endpoint_restaurado"],
                "total_detalhes_restaurado": restoration_comparison["total_detalhes_restaurado"],
            },
            "comparacao": restoration_comparison,
        }

        def append_restoration(history):
            if not isinstance(history, list):
                raise RuntimeError("O histórico de planilhas não contém uma lista válida.")
            current_source_event = next(
                (item for item in history if isinstance(item, dict) and item.get("id") == evento_id),
                None,
            )
            current_source_comparison = (
                current_source_event.get("comparacao")
                if isinstance(current_source_event, dict) else None
            )
            if (
                not isinstance(current_source_event, dict)
                or not isinstance(current_source_comparison, dict)
                or current_source_comparison.get("backup_diretorio") != source_backup_relative
                or current_source_event.get("horario") != source_event.get("horario")
            ):
                raise HistoryRestoreError(
                    409,
                    "A atualização selecionada mudou ou foi removida do histórico. A restauração foi cancelada.",
                )
            updated = deepcopy(history)
            updated.append(restoration_event)
            return updated

        transaction.update_json(services.comparison_history_path(), append_restoration, [])
        transaction.commit()
        services.publish_database_state(prepared_state)

    return {
        "sucesso": True,
        "evento": {
            "id": restoration_id,
            "tipo": "restauracao",
            "horario": restoration_time,
            "restauracao_de": restoration_comparison["restauracao_de"],
            "arquivos_restaurados": restored_files,
            "desfazer_disponivel": not any(missing_current_files.values()) and not any(invalid_current_files.values()),
            "total_endpoint_restaurado": restoration_comparison["total_endpoint_restaurado"],
            "total_detalhes_restaurado": restoration_comparison["total_detalhes_restaurado"],
            "total_equipamentos_carregados": restoration_comparison["total_equipamentos_carregados"],
            "apelidos_manuais_sem_equipamento": orphan_manual_aliases,
        },
    }
