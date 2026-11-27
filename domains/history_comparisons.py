"""Annotation sync, listing and save/resolve/delete workflows of the inventory comparison history."""

import json
import logging
import os
import threading
from datetime import date, datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Protocol

from core.config import LONG_UNUSED_LIMIT_DAYS, LONG_UNUSED_WARNING_DAYS
from core.errors import DomainError
from domains.history_annotations import (
    AnnotationReadError, resolve_history_annotations, annotation_record_values, annotation_view,
    same_annotation_revision, effective_history_annotation, load_effective_history_annotations,
    sync_history_annotation, reuse_annotation_revision,
)
from domains.history_export import history_display_files
from domains import history_restore
from domains.history_restore import HistoryRestoreServices, comparison_event_type


logger = logging.getLogger(__name__)

ANNOTATABLE_COMPARISON_CATEGORIES = (
    "apelidos_sem_atualizacao",
    "sem_acesso_7_dias",
    "ausentes_no_endpoint",
    "ausentes_em_detalhes",
    "divergencias_local",
    "correspondencias_ambiguas",
    "registros_ambiguos",
    "series_sem_mapeamento",
    "mudancas_usuarios",
)
# Rows computed on read (never stored in the history): annotated through the shared revisions only.
DERIVED_ANNOTATABLE_CATEGORIES = ("sem_acesso_60_dias",)
MERGEABLE_COMPARISON_CATEGORIES = ANNOTATABLE_COMPARISON_CATEGORIES + DERIVED_ANNOTATABLE_CATEGORIES


class HistoryComparisonError(DomainError):
    """A history request that cannot proceed; carries the API status and message."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail, status_code=status_code)


class HistoryComparisonServices(HistoryRestoreServices, Protocol):
    """Application services these workflows read from the history router's services (read-only members)."""

    @property
    def atomic_file_transaction(self) -> Callable[..., Any]: ...
    @property
    def build_history_annotation_record(self) -> Callable[..., Dict[str, Any]]: ...
    @property
    def comparison_annotation_item_id(self) -> Callable[..., str]: ...
    @property
    def comparison_history_for_display(self) -> Callable[[Dict[str, Any]], Dict[str, Any]]: ...
    @property
    def get_equipment_snapshot(self) -> Callable[[], Dict[str, Dict[str, Any]]]: ...
    @property
    def get_equipment_template_file(self) -> Callable[[], Optional[Path]]: ...
    @property
    def history_annotation_record_path(self) -> Callable[..., Path]: ...
    @property
    def history_annotation_row_fingerprint(self) -> Callable[[str, Dict[str, Any]], str]: ...
    @property
    def history_annotations_directory(self) -> Callable[[], Path]: ...
    @property
    def history_annotations_sync_enabled(self) -> Callable[[], bool]: ...
    @property
    def load_history_annotations(self) -> Callable[..., List[Dict[str, Any]]]: ...
    @property
    def local_annotation_outbox_directory(self) -> Callable[[], Path]: ...
    @property
    def save_history_annotation(self) -> Callable[..., Dict[str, Any]]: ...
    @property
    def transaction_root(self) -> Callable[[], Path]: ...


def latest_annotation_records(services: HistoryComparisonServices) -> Dict[tuple, Dict[str, Any]]:
    return load_effective_history_annotations(
        services.history_annotations_directory(),
        services.local_annotation_outbox_directory(),
        services.load_history_annotations,
    )


def annotation_folders_signature(services: HistoryComparisonServices) -> Optional[tuple]:
    entries: List[tuple] = []
    for directory in (services.history_annotations_directory(), services.local_annotation_outbox_directory()):
        try:
            with os.scandir(directory) as listing:
                for entry in listing:
                    if entry.name.lower().endswith(".json") and entry.is_file(follow_symlinks=False):
                        status = entry.stat(follow_symlinks=False)
                        # OneDrive downloading a placeholder changes its attributes, not its size or mtime.
                        entries.append((str(directory), entry.name, status.st_size, status.st_mtime_ns,
                                        getattr(status, "st_file_attributes", 0)))
        except FileNotFoundError:
            entries.append((str(directory), None))
        except OSError:
            return None
    return tuple(sorted(entries, key=repr))


def listing_annotation_records(
    services: HistoryComparisonServices, cache: Dict[str, Any], cache_lock: threading.Lock,
) -> Dict[tuple, Dict[str, Any]]:
    """Shared, read-only notes for the history list; callers must not change the result.

    The history list (also read by /api/painel on every home load) spent most of its time reading and
    resolving ~1300 shared notes; the resolved notes are kept in ``cache`` while both folders list the same files.

    shortcut: a note file locked during an unchanged listing stays missing until a note folder
    changes; the OneDrive write that held the lock changes the mtime, so this is short-lived.
    """
    key = annotation_folders_signature(services)
    with cache_lock:
        cached_key, cached_records = cache["key"], cache["records"]
    if key is not None and cached_key == key:
        return cached_records
    records = latest_annotation_records(services)
    # A folder that changed while it was read may be half-synced; cache only a stable listing.
    if key is not None and key == annotation_folders_signature(services):
        with cache_lock:
            cache.update(key=key, records=records)
    return records


def sync_annotation_record(services: HistoryComparisonServices, record: Dict[str, Any]) -> bool:
    try:
        return sync_history_annotation(
            record, directory=services.history_annotations_directory(),
            outbox=services.local_annotation_outbox_directory(),
            transaction_root=services.transaction_root(),
            transaction_factory=services.atomic_file_transaction,
            publisher=services.save_history_annotation,
        )
    except Exception:
        logger.exception(
            "Anotação salva localmente e aguardando sincronização (evento=%s, item=%s).",
            record["evento_id"],
            record["item_id"],
        )
        return False


def flush_pending_history_annotations(services: HistoryComparisonServices) -> Dict[str, int]:
    pending = services.load_history_annotations(services.local_annotation_outbox_directory())
    synchronized = sum(1 for record in pending if sync_annotation_record(services, record))
    return {"pendentes": len(pending) - synchronized, "sincronizadas": synchronized}


def migrate_legacy_history_annotations(services: HistoryComparisonServices) -> Dict[str, int]:
    """Move legacy row notes into the durable outbox outside read requests."""
    history = services.load_comparison_history()
    try:
        # A revision that exists but cannot be read must not look absent here, or
        # the embedded legacy text would be queued as a false concurrent edit.
        shared_records = services.load_history_annotations(services.history_annotations_directory(), strict=True)
        outbox_records = services.load_history_annotations(
            services.local_annotation_outbox_directory(), strict=True,
        )
    except AnnotationReadError:
        logger.warning(
            "Migração de anotações legadas adiada para a próxima execução: há revisões ilegíveis no momento."
        )
        return {"legadas_enfileiradas": 0, "adiada": 1, **flush_pending_history_annotations(services)}
    records = resolve_history_annotations([*shared_records, *outbox_records])
    versioned_keys = {
        (record["evento_id"], record["item_id"])
        for record in (*shared_records, *outbox_records)
        if record.get("versao") == 2
    }
    queued = 0
    for event in history:
        if not isinstance(event, dict):
            continue
        event_id = str(event.get("id") or "")
        comparison = event.get("comparacao")
        if not event_id or not isinstance(comparison, dict):
            continue
        legacy_annotations = comparison.get("anotacoes")
        for category in ANNOTATABLE_COMPARISON_CATEGORIES:
            items = comparison.get(category)
            if not isinstance(items, list):
                continue
            for index, item in enumerate(items):
                if not isinstance(item, dict):
                    continue
                annotation = item.get("anotacao")
                if not isinstance(annotation, str) and isinstance(legacy_annotations, dict):
                    legacy_category = (
                        "ambiguidades"
                        if category in ("correspondencias_ambiguas", "registros_ambiguos")
                        else category
                    )
                    legacy_index = index
                    if category == "registros_ambiguos":
                        ambiguity_items = comparison.get("correspondencias_ambiguas")
                        legacy_index += len(ambiguity_items) if isinstance(ambiguity_items, list) else 0
                    annotation = legacy_annotations.get(f"{legacy_category}:{legacy_index}")
                if not isinstance(annotation, str):
                    continue
                item_id = services.comparison_annotation_item_id(event_id, category, index, item)
                key = (event_id, item_id)
                existing = records.get(key)
                # Embedded history is a legacy fallback, never a new edit over a revision.
                if key in versioned_keys or (existing is not None and existing.get("anotacao") == annotation):
                    continue
                try:
                    legacy = {
                        "versao": 1, "evento_id": event_id, "item_id": item_id,
                        "horario": str(event.get("horario") or ""),
                        "serie": str(item.get("serie") or ""),
                        "computador": str(item.get("computador") or item.get("chave") or ""),
                        "motivo": str(item.get("motivo") or item.get("mensagem") or item.get("tipo") or ""),
                        "anotacao": annotation, "categoria": category,
                        "linha_hash": services.history_annotation_row_fingerprint(category, item),
                        "atualizado_em": str(event.get("horario") or ""),
                    }
                    record = services.save_history_annotation(
                        services.local_annotation_outbox_directory(),
                        **annotation_record_values(legacy),
                    )
                    records[key] = record
                    queued += 1
                except Exception:
                    logger.exception(
                        "Falha ao colocar anotação legada na fila de sincronização (evento=%s, item=%s).",
                        event_id, item_id,
                    )
                    continue
    # Preserve existing v1 files and publish deterministic immutable copies.
    for legacy in shared_records:
        if legacy.get("versao") == 1:
            try:
                values = annotation_record_values(legacy)
                target = services.history_annotation_record_path(
                    services.history_annotations_directory(), legacy["evento_id"], legacy["item_id"],
                    values["revision_id"],
                )
                if not target.exists():
                    services.save_history_annotation(services.local_annotation_outbox_directory(), **values)
                    queued += 1
            except Exception:
                logger.exception("A cópia imutável da anotação legada ficou pendente.")
    flush_result = flush_pending_history_annotations(services)
    return {"legadas_enfileiradas": queued, **flush_result}


def merge_shared_annotations(
    services: HistoryComparisonServices,
    event_view: Dict[str, Any],
    annotations: Dict[tuple, Dict[str, Any]],
) -> Dict[str, Any]:
    comparison = event_view.get("comparacao")
    if not isinstance(comparison, dict):
        return event_view
    comparison["anotacoes_sync_ativa"] = bool(services.history_annotations_sync_enabled())
    event_id = str(event_view.get("id") or "")
    for category in MERGEABLE_COMPARISON_CATEGORIES:
        items = comparison.get(category)
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            item.update(effective_history_annotation(
                annotations, event_id, str(item.get("anotacao_id") or ""),
                item.get("anotacao"),
            ))
            associated_annotations = item.get("anotacoes_associadas")
            if not isinstance(associated_annotations, list):
                continue
            for associated in associated_annotations:
                if not isinstance(associated, dict):
                    continue
                associated.update(effective_history_annotation(
                    annotations, event_id, str(associated.get("anotacao_id") or ""),
                    associated.get("anotacao"),
                ))
    return event_view


def synthetic_annotation_event(
    services: HistoryComparisonServices, event_id: str, records: Dict[tuple, Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    event_records = [
        record for (record_event_id, _), record in records.items()
        if record_event_id == event_id and (record.get("anotacao") or record.get("anotacao_conflito"))
    ]
    if not event_records:
        return None
    event_records.sort(key=lambda record: record["item_id"])
    event_time = next((record.get("horario") for record in event_records if record.get("horario")), "")
    category_items: Dict[str, List[Dict[str, Any]]] = {
        category: [] for category in MERGEABLE_COMPARISON_CATEGORIES
    }
    synchronized_annotations = []
    for record in event_records:
        category = record.get("categoria")
        if category not in category_items:
            category = "apelidos_sem_atualizacao"
        item = {
            "serie": record.get("serie", ""),
            "computador": record.get("computador", ""),
            "motivo": record.get("motivo", ""),
            "anotacao_id": record["item_id"],
            **annotation_view(record),
            "categoria": category,
        }
        category_items[category].append(item)
        synchronized_annotations.append(item)
    return {
        "id": event_id,
        "horario": event_time,
        "somente_anotacoes_sincronizadas": True,
        "arquivos_enviados": {},
        "resumo": {
            category: len(items)
            for category, items in category_items.items()
            if items
        },
        "comparacao": {
            "evento_id": event_id,
            "horario_comparacao": event_time,
            "tipo_operacao": "atualizacao",
            "arquivos_enviados": {},
            **category_items,
            "anotacoes_sincronizadas": synchronized_annotations,
            "apelidos_atualizados": [],
            "divergencias_apelidos_manuais": [],
            "anotacoes_sync_ativa": bool(services.history_annotations_sync_enabled()),
            "somente_anotacoes_sincronizadas": True,
        },
    }


def history_annotation_view(services: HistoryComparisonServices, event: Dict[str, Any]) -> Dict[str, Any]:
    """Supply the observed text and causal bases to consumers that also edit notes."""
    view = services.comparison_history_for_display(event)
    return merge_shared_annotations(services, view, latest_annotation_records(services))


def history_event_summary(event: Dict[str, Any]) -> Dict[str, Any]:
    summary = event.get("resumo")
    if isinstance(summary, dict):
        return dict(summary)
    comparison = event.get("comparacao")
    comparison = comparison if isinstance(comparison, dict) else {}
    categories = (
        "apelidos_atualizados",
        "apelidos_sem_atualizacao",
        "sem_acesso_7_dias",
        "ausentes_no_endpoint",
        "ausentes_em_detalhes",
        "divergencias_local",
        "correspondencias_ambiguas",
        "registros_ambiguos",
        "divergencias_apelidos_manuais",
        "series_sem_mapeamento",
        "mudancas_usuarios",
    )
    result = {"total_endpoint": comparison.get("total_endpoint", 0)}
    for category in categories:
        values = comparison.get(category)
        result[category] = len(values) if isinstance(values, list) else 0
    return result


def history_listing(
    services: HistoryComparisonServices,
    history: List[Dict[str, Any]],
    annotations: Dict[tuple, Dict[str, Any]],
) -> Dict[str, Any]:
    eventos = []
    local_event_ids = set()
    for evento in history:
        if not isinstance(evento, dict):
            continue
        event_id = str(evento.get("id") or "")
        if event_id:
            local_event_ids.add(event_id)
        comparison = evento.get("comparacao")
        comparison = comparison if isinstance(comparison, dict) else {}
        eventos.append({
            "id": evento.get("id"),
            "horario": evento.get("horario"),
            "tipo": comparison_event_type(evento),
            "arquivos_enviados": history_display_files(evento.get("arquivos_enviados")),
            "arquivos_restaurados": history_display_files(comparison.get("arquivos_restaurados")),
            "restauracao_de": comparison.get("restauracao_de", {}),
            "restauravel": history_restore.event_has_restorable_backup(services, evento),
            "resumo": history_event_summary(evento),
        })
    shared_event_ids = {event_id for event_id, _ in annotations}
    for event_id in shared_event_ids - local_event_ids:
        event_records = [
            record for (record_event_id, _), record in annotations.items()
            if record_event_id == event_id and (record.get("anotacao") or record.get("anotacao_conflito"))
        ]
        if not event_records:
            continue
        summary: Dict[str, int] = {}
        for record in event_records:
            category = str(record.get("categoria") or "apelidos_sem_atualizacao")
            summary[category] = summary.get(category, 0) + 1
        event_time = next((record.get("horario") for record in event_records if record.get("horario")), "")
        eventos.append({
            "id": event_id,
            "horario": event_time,
            "tipo": "atualizacao",
            "arquivos_enviados": {},
            "arquivos_restaurados": {},
            "restauracao_de": {},
            "restauravel": False,
            "somente_anotacoes_sincronizadas": True,
            "resumo": summary,
        })

    def event_timestamp(item: Dict[str, Any]) -> float:
        try:
            return datetime.fromisoformat(str(item.get("horario") or "").replace("Z", "+00:00")).timestamp()
        except (TypeError, ValueError, OverflowError):
            return float("-inf")

    eventos.sort(key=event_timestamp, reverse=True)
    return {"total": len(eventos), "eventos": eventos}


def add_long_unused_rows(
    services: HistoryComparisonServices,
    event_view: Dict[str, Any],
    evento_id: str,
    long_unused_status: Callable[..., Any],
) -> None:
    # Notebooks past 60 days as of this update; kept out of the stored history (it depends on older updates).
    comparison = event_view.get("comparacao")
    if not isinstance(comparison, dict):
        return
    try:
        status = long_unused_status(
            services.load_comparison_history(), LONG_UNUSED_WARNING_DAYS, LONG_UNUSED_LIMIT_DAYS, evento_id,
        )
    except Exception:
        # The list is optional; the comparison must still open.
        logger.exception("Falha ao calcular a lista de notebooks sem acesso há 60 dias ou mais.")
        return
    # Only the serial identifies the row (days and situation change between updates); the occurrence
    # index keeps repeated or empty serials apart, and the first one keeps index 0.
    ocorrencias: Dict[str, int] = {}
    linhas = []
    for item in status["equipamentos"]:
        if item["situacao"] not in ("passou", "saiu_endpoint"):
            continue
        serie = str(item["serie"] or "")
        indice = ocorrencias.get(serie, 0)
        ocorrencias[serie] = indice + 1
        anotacao_id = services.comparison_annotation_item_id(evento_id, "sem_acesso_60_dias", indice, {"serie": serie})
        linhas.append({**item, "anotacao_id": anotacao_id})
    comparison["sem_acesso_60_dias"] = linhas


def export_display_events(
    services: HistoryComparisonServices, selected_date: date, long_unused_status: Callable[..., Any],
) -> List[Dict[str, Any]]:
    history = services.load_comparison_history()
    annotations = latest_annotation_records(services)
    display_events = []
    for event in history:
        if isinstance(event, dict) and str(event.get("horario") or "")[:10] == selected_date.isoformat():
            event_view = services.comparison_history_for_display(event)
            add_long_unused_rows(services, event_view, str(event.get("id") or ""), long_unused_status)
            merge_shared_annotations(services, event_view, annotations)
            display_events.append(event_view)
    if not display_events:
        raise HistoryComparisonError(404, "Não há registros de planilhas na data selecionada.")
    return display_events


def comparison_event_view(
    services: HistoryComparisonServices, evento_id: str, long_unused_status: Callable[..., Any],
) -> Dict[str, Any]:
    evento = next(
        (item for item in services.load_comparison_history() if isinstance(item, dict) and item.get("id") == evento_id),
        None,
    )
    annotations = latest_annotation_records(services)
    if evento is None:
        event_view = synthetic_annotation_event(services, evento_id, annotations)
        if event_view is None:
            raise HistoryComparisonError(404, "O resultado selecionado não existe no histórico de planilhas.")
        return {"evento": event_view}
    event_view = services.comparison_history_for_display(evento)
    add_long_unused_rows(services, event_view, evento_id, long_unused_status)
    merge_shared_annotations(services, event_view, annotations)
    return {"evento": event_view}


def save_comparison_annotation(
    services: HistoryComparisonServices,
    evento_id: str,
    item_id: str,
    *,
    anotacao: str,
    revisao_id: Optional[str],
    base_revisoes: List[str],
    resolver_conflito: bool,
    long_unused_status: Callable[..., Any],
) -> Dict[str, Any]:
    event = next(
        (item for item in services.load_comparison_history() if isinstance(item, dict) and item.get("id") == evento_id),
        None,
    )
    annotation_row = None
    annotation_category = "apelidos_sem_atualizacao"
    annotation_line_hash = None
    derived = False
    if event is not None:
        comparison = event.get("comparacao")
        if isinstance(comparison, dict):
            for category in ANNOTATABLE_COMPARISON_CATEGORIES:
                items = comparison.get(category)
                if not isinstance(items, list):
                    continue
                for index, comparison_item in enumerate(items):
                    if not isinstance(comparison_item, dict):
                        continue
                    stable_id = services.comparison_annotation_item_id(
                        evento_id, category, index, comparison_item
                    )
                    if stable_id == item_id:
                        annotation_row = dict(comparison_item)
                        annotation_row["anotacao_id"] = stable_id
                        annotation_category = category
                        break
                if annotation_row is not None:
                    break
        if annotation_row is None:
            # Computed on read, so it is not in the stored history: recompute and match by id.
            derived_view: Dict[str, Any] = {"comparacao": {}}
            add_long_unused_rows(services, derived_view, evento_id, long_unused_status)
            for derived_item in derived_view["comparacao"].get("sem_acesso_60_dias", []):
                if derived_item.get("anotacao_id") == item_id:
                    annotation_row = dict(derived_item)
                    annotation_category = "sem_acesso_60_dias"
                    # Days change every update; the serial alone keeps the row signature stable.
                    annotation_line_hash = services.history_annotation_row_fingerprint(
                        annotation_category, {"serie": annotation_row["serie"]},
                    )
                    derived = True
                    break
    else:
        annotation_row = next(
            (
                record for (record_event_id, record_item_id), record in latest_annotation_records(services).items()
                if record_event_id == evento_id and record_item_id == item_id
            ),
            None,
        )
        if isinstance(annotation_row, dict):
            annotation_category = str(annotation_row.get("categoria") or annotation_category)
            annotation_line_hash = annotation_row.get("linha_hash")
    if annotation_row is None:
        raise HistoryComparisonError(404, "A linha selecionada não existe neste resultado.")

    def update_annotation(history: Any) -> Any:
        if not isinstance(history, list):
            raise HistoryComparisonError(500, "O histórico de planilhas não contém uma lista válida.")
        event = next(
            (item for item in history if isinstance(item, dict) and item.get("id") == evento_id),
            None,
        )
        if event is None:
            raise HistoryComparisonError(404, "A atualização selecionada não existe mais no histórico.")
        comparison = event.get("comparacao")
        if not isinstance(comparison, dict):
            raise HistoryComparisonError(404, "A linha selecionada não existe neste resultado.")
        for category in ANNOTATABLE_COMPARISON_CATEGORIES:
            items = comparison.get(category)
            if not isinstance(items, list):
                continue
            for index, comparison_item in enumerate(items):
                if not isinstance(comparison_item, dict):
                    continue
                stable_id = services.comparison_annotation_item_id(
                    evento_id, category, index, comparison_item
                )
                if stable_id == item_id:
                    comparison_item["anotacao_id"] = stable_id
                    comparison_item["anotacao"] = anotacao
                    return history
        raise HistoryComparisonError(404, "A linha selecionada não existe neste resultado.")

    category = annotation_category
    record_values = {
        "event_id": evento_id,
        "event_time": str(event.get("horario") or "") if event is not None else str(annotation_row.get("horario") or ""),
        "item_id": item_id,
        "serie": str(annotation_row.get("serie") or ""),
        "computador": str(annotation_row.get("computador") or annotation_row.get("chave") or ""),
        "motivo": str(annotation_row.get("motivo") or annotation_row.get("mensagem") or annotation_row.get("tipo") or ""),
        "anotacao": anotacao,
        "categoria": category,
        "linha_hash": annotation_line_hash or services.history_annotation_row_fingerprint(category, annotation_row),
    }
    if len(base_revisoes) > 1 and not resolver_conflito:
        raise HistoryComparisonError(409, "Confirme explicitamente a resolução do conflito.")
    try:
        record = services.build_history_annotation_record(
            **record_values, revision_id=revisao_id,
            base_revisions=base_revisoes,
        )
    except ValueError as error:
        raise HistoryComparisonError(422, str(error)) from None
    pending_path = services.history_annotation_record_path(
        services.local_annotation_outbox_directory(),
        evento_id,
        item_id,
        record["revisao_id"],
    )
    try:
        # The transaction locks the history file; no Python lock is held around it.
        targets = [pending_path]
        if event is not None and not derived:
            targets.append(services.comparison_history_path())
        with services.atomic_file_transaction(services.transaction_root(), targets) as transaction:
            try:
                record = reuse_annotation_revision(services.history_annotations_directory(), record)
            except ValueError as error:
                raise HistoryComparisonError(409, str(error)) from None
            if event is not None and not derived:
                transaction.update_json(
                    services.comparison_history_path(),
                    update_annotation,
                    [],
                )
            if pending_path.exists():
                existing = json.loads(pending_path.read_text(encoding="utf-8"))
                if not same_annotation_revision(existing, record):
                    raise HistoryComparisonError(409, "A revisão já foi usada com outro conteúdo.")
                record = existing
            transaction.stage_bytes(
                pending_path,
                json.dumps(record, ensure_ascii=False, indent=2).encode("utf-8"),
                lambda path: json.loads(path.read_text(encoding="utf-8")),
            )
            transaction.commit()
    except Exception as error:
        # DomainError and a service's HTTPException carry their own status: pass them through, as before.
        if hasattr(error, "status_code") and hasattr(error, "detail"):
            raise
        status = 503 if services.history_annotations_sync_enabled() else 500
        logger.exception(
            "Falha ao salvar anotação local (evento=%s, item=%s).",
            evento_id,
            item_id,
        )
        raise HistoryComparisonError(status, "Não foi possível salvar a anotação localmente.") from None

    synchronized = sync_annotation_record(services, record)
    sync_status = (
        "sincronizada"
        if services.history_annotations_sync_enabled() and synchronized
        else "pendente"
        if services.history_annotations_sync_enabled()
        else "local"
    )
    return {
        "sucesso": True,
        **annotation_view(latest_annotation_records(services)[(evento_id, item_id)]),
        "revisao_salva": record["revisao_id"],
        "sincronizacao": sync_status,
    }


def resolve_manual_alias_divergence(
    services: HistoryComparisonServices, evento_id: str, serial: str, serial_key: str, acao: str,
) -> Dict[str, Any]:
    event = next(
        (item for item in services.load_comparison_history() if isinstance(item, dict) and item.get("id") == evento_id),
        None,
    )
    if event is None:
        raise HistoryComparisonError(404, "A atualização selecionada não existe no histórico.")
    comparison = event.get("comparacao")
    divergences = comparison.get("divergencias_apelidos_manuais") if isinstance(comparison, dict) else None
    divergence = next(
        (
            item for item in divergences or []
            if isinstance(item, dict) and services.normalize_reference_value(item.get("serie")) == serial_key
        ),
        None,
    )
    if divergence is None:
        raise HistoryComparisonError(404, "A divergência de apelido não existe neste registro.")
    if divergence.get("resolucao") != "pendente":
        raise HistoryComparisonError(409, "Esta divergência já foi resolvida no histórico.")

    expected_manual_alias = str(divergence.get("apelido_manual") or "").strip()
    targets = [services.comparison_history_path(), services.modified_aliases_path()]
    if acao == "excluir":
        details_file = services.get_equipment_template_file()
        if details_file is None or not details_file.is_file():
            raise HistoryComparisonError(404, "A planilha atual na Simpress não foi encontrada.")
        targets.append(details_file)

    with services.inventory_state_transaction(targets) as transaction:
        current_aliases = services.manual_aliases_by_serial(services.load_modified_apelidos())
        if serial_key not in current_aliases or current_aliases[serial_key] != expected_manual_alias:
            raise HistoryComparisonError(
                409, "O apelido manual mudou desde esta comparação. Atualize o histórico antes de decidir.",
            )

        if acao == "excluir":
            def remove_manual_override(data: Any) -> Any:
                if not isinstance(data, dict):
                    raise RuntimeError("O arquivo de apelidos manuais não contém um objeto válido.")
                keys = [key for key in data if services.normalize_reference_value(key) == serial_key]
                if len(keys) != 1 or str(data.get(keys[0]) or "").strip() != expected_manual_alias:
                    raise HistoryComparisonError(409, "O override manual mudou desde esta comparação.")
                updated = dict(data)
                for key in keys:
                    updated.pop(key, None)
                return updated

            transaction.update_json(services.modified_aliases_path(), remove_manual_override, {})

        def mark_divergence_resolved(history: Any) -> Any:
            if not isinstance(history, list):
                raise RuntimeError("O histórico de planilhas não contém uma lista válida.")
            updated = list(history)
            stored_event = next((item for item in updated if item.get("id") == evento_id), None)
            if stored_event is None:
                raise HistoryComparisonError(409, "A atualização foi removida do histórico.")
            stored_comparison = stored_event.get("comparacao")
            stored_divergences = stored_comparison.get("divergencias_apelidos_manuais") if isinstance(stored_comparison, dict) else None
            stored_divergence = next(
                (
                    item for item in stored_divergences or []
                    if isinstance(item, dict) and services.normalize_reference_value(item.get("serie")) == serial_key
                ),
                None,
            )
            if stored_divergence is None or stored_divergence.get("resolucao") != "pendente":
                raise HistoryComparisonError(409, "A divergência já foi alterada no histórico.")
            stored_divergence["resolucao"] = acao
            stored_divergence["horario_resolucao"] = datetime.now().astimezone().isoformat(timespec="seconds")
            return updated

        transaction.update_json(services.comparison_history_path(), mark_divergence_resolved, [])
        transaction.apply()
        if acao == "excluir" and not services.load_database(transaction_locked=True):
            raise RuntimeError("A base não pôde ser recarregada após excluir o override manual.")
        transaction.commit()

    equipment = next(
        (
            item for key, item in services.get_equipment_snapshot().items()
            if services.normalize_reference_value(item.get("serial") or key) == serial_key
        ),
        None,
    )
    return {
        "sucesso": True,
        "resolucao": acao,
        "mensagem": (
            "Apelido manual mantido para esta série."
            if acao == "manter"
            else "Alteração manual removida; o apelido voltou a seguir as planilhas de origem."
        ),
        "equipamento": {
            key: value for key, value in equipment.items() if not key.startswith("_")
        } if equipment else None,
        "total_modificados": len(services.load_modified_apelidos()),
    }


def delete_history_event(services: HistoryComparisonServices, evento_id: str) -> Dict[str, Any]:
    history = services.load_comparison_history()
    event = next((item for item in history if isinstance(item, dict) and item.get("id") == evento_id), None)
    if event is None:
        raise HistoryComparisonError(404, "A atualização selecionada não existe mais no histórico.")
    tombstones = []
    for (record_event_id, _), record in latest_annotation_records(services).items():
        if record_event_id != evento_id:
            continue
        tombstones.append(services.build_history_annotation_record(
            event_id=evento_id,
            event_time=str(record.get("horario") or event.get("horario") or ""),
            item_id=record["item_id"],
            serie=str(record.get("serie") or ""),
            computador=str(record.get("computador") or ""),
            motivo=str(record.get("motivo") or ""),
            anotacao="",
            base_revisions=record.get("anotacao_revisoes", []),
            categoria=str(record.get("categoria") or "apelidos_sem_atualizacao"),
            linha_hash=record.get("linha_hash"),
        ))

    pending_paths = [
        services.history_annotation_record_path(
            services.local_annotation_outbox_directory(),
            record["evento_id"],
            record["item_id"],
            record["revisao_id"],
        )
        for record in tombstones
    ]
    try:
        with services.atomic_file_transaction(
            services.transaction_root(),
            [services.comparison_history_path(), *pending_paths],
        ) as transaction:
            result: Dict[str, Any] = {"total": None}

            def remove_event(rows: Any) -> Any:
                if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                    raise HistoryComparisonError(500, "O histórico de planilhas não contém uma lista válida.")
                updated = [row for row in rows if row.get("id") != evento_id]
                if len(updated) == len(rows):
                    raise HistoryComparisonError(404, "A atualização selecionada não existe mais no histórico.")
                result["total"] = len(updated)
                return updated

            transaction.update_json(services.comparison_history_path(), remove_event, [])
            for record, pending_path in zip(tombstones, pending_paths):
                transaction.stage_bytes(
                    pending_path,
                    json.dumps(record, ensure_ascii=False, indent=2).encode("utf-8"),
                    lambda path: json.loads(path.read_text(encoding="utf-8")),
                )
            transaction.commit()
    except Exception as error:
        # DomainError and a service's HTTPException carry their own status: pass them through, as before.
        if hasattr(error, "status_code") and hasattr(error, "detail"):
            raise
        logger.exception("Falha ao remover evento do histórico (evento=%s).", evento_id)
        status = 503 if services.history_annotations_sync_enabled() else 500
        raise HistoryComparisonError(status, "Não foi possível remover o resultado do histórico localmente.") from None

    sync_results = [sync_annotation_record(services, record) for record in tombstones]
    pending_count = sum(not synced for synced in sync_results)
    return {
        "sucesso": True,
        "total": result["total"],
        "sincronizacao": "pendente" if pending_count else (
            "sincronizada" if services.history_annotations_sync_enabled() else "local"
        ),
    }
