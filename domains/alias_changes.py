"""Manual alias changes: save, restore and undo the alias of one equipment.

A manual alias is kept per serial in the local overrides file and wins over the
Endpoint hostname; every change is recorded in the alias history so it can be
undone. The source workbooks are locked but never edited here.

``main.py`` wires the file locations and readers in ``AliasChangeServices``
with late-bound callables, so tests that patch ``main`` keep affecting these
operations. Errors are domain errors; ``external_errors`` lists the exception
types raised by those callbacks that must pass through unchanged.
"""

import logging
import uuid
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, ContextManager, Dict, List, Optional, Tuple, Type

from core.errors import DomainConflictError, DomainError
from core.integrity import AtomicFileTransaction, FileBusyError, FileTransactionError, WorkbookSafetyError
from domains import inventory_state
from domains.effective_alias import with_manual_alias_marker
from domains.inventory_comparison import normalize_reference_value
from domains.inventory_state import STATE_LOCK


@dataclass(frozen=True)
class AliasChangeServices:
    modified_aliases_file: Callable[[], Path]
    alias_history_file: Callable[[], Path]
    transaction_root: Callable[[], Path]
    atomic_file_transaction: Callable[[Path, List[Path]], ContextManager[AtomicFileTransaction]]
    get_details_files: Callable[[], List[Path]]
    get_primary_equipment_file: Callable[[], Optional[Path]]
    find_details_sheet: Callable[[Path], Optional[str]]
    load_alias_history: Callable[[], List[Dict[str, Any]]]
    load_modified_apelidos: Callable[[], Dict[str, str]]
    validate_json_object: Callable[[Any, str], Dict[str, Any]]
    validate_json_history: Callable[[Any, str], List[Dict[str, Any]]]
    read_endpoint_alias_index: Callable[[], Dict[str, Any]]
    apply_effective_alias: Callable[..., None]
    prepare_database_state: Callable[[Dict[str, Dict[str, Any]], List[Dict[str, Any]], Dict[str, Any]], Dict[str, Any]]
    publish_database_state: Callable[[Dict[str, Any]], None]
    prune_expired_histories: Callable[[], Any]
    public_equipment: Callable[[Dict[str, Any]], Dict[str, Any]]
    logger: logging.Logger
    external_errors: Tuple[Type[BaseException], ...] = ()
    # Manual logged-in user (see domains/user_changes.py); optional so older wiring keeps working.
    manual_users_file: Optional[Callable[[], Path]] = None
    load_manual_users: Optional[Callable[[], Dict[str, str]]] = None


def _is_alias_event(item: Dict[str, Any]) -> bool:
    """Alias events (legacy ones have no ``tipo``) are undone independently of users and warnings."""
    return item.get("tipo") in (None, "apelido")


def validate_equipment_serial(value: str) -> str:
    """Apply the same non-empty serial semantics to every equipment edit route."""
    if not normalize_reference_value(value):
        raise ValueError("O número de série precisa conter letras ou números.")
    return value.strip()


def build_alias_change_entry(
    serial: str,
    previous_alias: str,
    new_alias: str,
    action: str = "alteracao",
    reference_id: Optional[str] = None,
    had_override: Optional[bool] = None,
) -> Dict[str, Any]:
    with STATE_LOCK:
        equipment = dict(inventory_state.equipamentos_cache.get(serial, {}))
    entry = {
        "id": uuid.uuid4().hex,
        "tipo": "apelido",
        "serial": serial,
        "equipamento": equipment.get("modelo") or equipment.get("tipo") or "Equipamento",
        "apelido_anterior": previous_alias,
        "apelido_novo": new_alias,
        "horario": datetime.now().astimezone().isoformat(timespec="seconds"),
        "acao": action,
        "referencia_id": reference_id,
    }
    if had_override is not None:
        # Undo needs to know whether to restore a value or drop the override again.
        entry["tinha_override"] = had_override
    return entry


def snapshot_equipment_aliases(
    equipment_records: Dict[str, Dict[str, Any]],
) -> Dict[str, Dict[str, str]]:
    """Captura apelidos únicos por série para comparar antes e depois da atualização."""
    by_serial: Dict[str, List[Dict[str, str]]] = {}
    for equipment in equipment_records.values():
        if equipment.get("invall_alias_status") == "serie_detalhes_duplicada":
            continue
        serial = str(equipment.get("serial") or "").strip()
        serial_key = normalize_reference_value(serial)
        if not serial_key:
            continue
        by_serial.setdefault(serial_key, []).append({
            "serie": serial,
            "apelido": str(equipment.get("apelido") or "").strip(),
        })

    # Não escolher automaticamente quando a mesma série aparece mais de uma vez.
    return {
        serial: records[0]
        for serial, records in by_serial.items()
        if len(records) == 1
    }


def compare_equipment_aliases(
    previous: Dict[str, Dict[str, str]],
    current: Dict[str, Dict[str, str]],
) -> List[Dict[str, str]]:
    """Lista mudanças de apelido entre duas cargas do cadastro, comparando por série."""
    changes = []
    for serial_key, updated in current.items():
        previous_record = previous.get(serial_key)
        if previous_record is None or previous_record["apelido"] == updated["apelido"]:
            continue
        changes.append({
            "serie": updated["serie"],
            "apelido_anterior": previous_record["apelido"],
            "apelido_novo": updated["apelido"],
        })
    return sorted(changes, key=lambda item: item["serie"])


def modified_aliases_summary(services: AliasChangeServices) -> Dict[str, Any]:
    """Retorna o registro de todos os apelidos que foram modificados pelo usuário."""
    apelidos = services.load_modified_apelidos()
    return {"total": len(apelidos), "apelidos": apelidos}


def apply_alias_change(
    services: AliasChangeServices,
    target_serial: str,
    novo_apelido: str,
    action: str = "alteracao",
    reference_id: Optional[str] = None,
    registrar_historico: bool = True,
    expected_current_local: Optional[str] = None,
    expected_latest_event_id: Optional[str] = None,
    remove_history_event_id: Optional[str] = None,
    drop_override: bool = False,
) -> Dict[str, Any]:
    """Save a manual alias, or with ``drop_override`` remove it so the sources apply again."""
    with STATE_LOCK:
        initial_equipment = inventory_state.equipamentos_cache.get(target_serial)
        initial_equipment = dict(initial_equipment) if initial_equipment is not None else None
    if initial_equipment is None:
        raise DomainError(f"Equipamento com serial '{target_serial}' não encontrado na base de dados.", status_code=404)

    cached_source = initial_equipment.get("_source_file")
    cached_sheet = initial_equipment.get("_source_sheet")
    if not cached_source or not cached_sheet:
        raise DomainConflictError("A origem deste equipamento não está mais disponível no cache; recarregue a base antes de editar.")
    source_file = Path(cached_source).resolve(strict=False)
    detail_files = services.get_details_files()
    locked_detail_files = {Path(path).resolve(strict=False) for path in detail_files}
    if source_file not in locked_detail_files:
        raise DomainConflictError("A planilha de origem mudou depois que este equipamento foi carregado; recarregue a base antes de editar.")

    # Lock source files alongside the alias/history JSON so uploads cannot race
    # with a manual override decision. Manual overrides never edit that source.
    targets = [services.modified_aliases_file(), services.alias_history_file(), *detail_files]
    passthrough_errors: Tuple[Type[BaseException], ...] = (DomainError, *services.external_errors)

    try:
        with services.atomic_file_transaction(services.transaction_root(), targets) as transaction:
            with STATE_LOCK:
                next_equipment_cache = deepcopy(inventory_state.equipamentos_cache)
                next_unit_cache = deepcopy(inventory_state.unidades_cache)
                next_stats_cache = deepcopy(inventory_state.stats_cache)
            equipamento = deepcopy(next_equipment_cache.get(target_serial))
            if equipamento is None:
                raise DomainError(f"Equipamento com serial '{target_serial}' não encontrado na base de dados.", status_code=404)

            current_source = equipamento.get("_source_file")
            current_sheet = equipamento.get("_source_sheet")
            active_file = services.get_primary_equipment_file()
            locked_files = {Path(path).resolve(strict=False) for path in detail_files}
            if (
                not current_source
                or Path(current_source).resolve(strict=False) != source_file
                or active_file is None
                or not active_file.is_file()
                or active_file.resolve(strict=False) != source_file
                or active_file.resolve(strict=False) not in locked_files
            ):
                raise DomainConflictError("A planilha de origem mudou depois que este equipamento foi carregado; recarregue a base antes de editar.")

            active_sheet = services.find_details_sheet(active_file)
            if not current_sheet or current_sheet != cached_sheet or active_sheet != cached_sheet:
                raise DomainConflictError("A aba de origem mudou depois que este equipamento foi carregado; recarregue a base antes de editar.")

            apelido_anterior = str(equipamento.get("_apelido_local", equipamento.get("_apelido_base", "")) or "").strip()
            had_override = bool(equipamento.get("_apelido_manual_override"))
            if drop_override:
                novo_apelido = str(equipamento.get("_apelido_base", "") or "").strip()
            history_will_change = (apelido_anterior != novo_apelido and registrar_historico) or bool(remove_history_event_id)
            if expected_latest_event_id:
                current_history = services.load_alias_history()
                latest = next((
                    item for item in reversed(current_history)
                    if str(item.get("serial") or "").strip().upper() == target_serial
                    and _is_alias_event(item)
                ), None)
                if not latest or latest.get("id") != expected_latest_event_id:
                    raise DomainConflictError("Só é possível desfazer a alteração manual mais recente deste equipamento.")
                local_now = str(equipamento.get("_apelido_local", equipamento.get("_apelido_base", "")) or "").strip()
                if local_now != str(expected_current_local or "").strip():
                    raise DomainConflictError("O apelido salvo mudou depois deste registro; nenhuma alteração foi aplicada.")

            def update_overrides(data):
                aliases = dict(services.validate_json_object(data, "apelidos"))
                matching_keys = [
                    key for key in aliases
                    if normalize_reference_value(key) == normalize_reference_value(target_serial)
                ]
                if expected_current_local is not None and (
                    len(matching_keys) != 1
                    or str(aliases.get(matching_keys[0]) or "").strip()
                    != str(expected_current_local or "").strip()
                ):
                    raise DomainConflictError("O apelido manual salvo mudou depois deste registro; nenhuma alteração foi aplicada.")
                for key in matching_keys:
                    aliases.pop(key, None)
                if not drop_override:
                    aliases[target_serial] = novo_apelido
                return aliases

            transaction.update_json(services.modified_aliases_file(), update_overrides, {})

            if history_will_change:
                def update_history(history):
                    history = services.validate_json_history(history, "apelidos")
                    updated = list(history)
                    if remove_history_event_id:
                        updated = [item for item in updated if item.get("id") != remove_history_event_id]
                        if len(updated) == len(history):
                            raise DomainConflictError("O registro foi alterado por outra ação; atualize o histórico e tente novamente.")
                    if apelido_anterior != novo_apelido and registrar_historico:
                        updated.append(build_alias_change_entry(
                            target_serial, apelido_anterior, novo_apelido, action, reference_id, had_override,
                        ))
                    return updated
                transaction.update_json(services.alias_history_file(), update_history, [])

            updated_equipment = dict(equipamento)
            updated_equipment["_apelido_local"] = novo_apelido
            updated_equipment["_apelido_manual_override"] = not drop_override
            services.apply_effective_alias(
                updated_equipment,
                services.read_endpoint_alias_index(),
                details_duplicate=updated_equipment.get("invall_alias_status") == "serie_detalhes_duplicada",
            )
            next_equipment_cache[target_serial] = updated_equipment
            prepared_state = services.prepare_database_state(
                next_equipment_cache,
                next_unit_cache,
                next_stats_cache,
            )
            transaction.commit()
            services.publish_database_state(prepared_state)
    except passthrough_errors:
        raise
    except FileBusyError as error:
        raise DomainConflictError(str(error)) from error
    except WorkbookSafetyError as error:
        raise DomainConflictError(f"Gravação cancelada: {error}") from error
    except FileTransactionError as error:
        raise DomainError(f"Não foi possível concluir a alteração de apelido: {error}") from error

    try:
        services.prune_expired_histories()
    except Exception as error:
        services.logger.warning("O apelido foi salvo, mas a retenção automática falhou (%s).", type(error).__name__)

    return {
        "equipamento": updated_equipment,
        "apelido_anterior": apelido_anterior,
        "apelido_novo": novo_apelido,
        "salvo_no_disco": True,
    }


def update_manual_alias(services: AliasChangeServices, serial: str, apelido: str) -> Dict[str, Any]:
    """Atualiza o apelido e registra o valor anterior, o novo e o horário."""
    target_serial = serial.strip().upper()
    # Toda edição manual termina em " (M)" para indicar a origem na tela e nas exportações.
    novo_apelido = with_manual_alias_marker(apelido)
    resultado = apply_alias_change(services, target_serial, novo_apelido)

    return {
        "sucesso": True,
        "mensagem": "Apelido salvo para as próximas pesquisas e exportações do Excel.",
        **{**resultado, "equipamento": services.public_equipment(resultado["equipamento"])},
        "total_modificados": len(services.load_modified_apelidos()),
    }


def alias_history_listing(services: AliasChangeServices) -> Dict[str, Any]:
    historico = services.load_alias_history()
    return {"total": len(historico), "eventos": list(reversed(historico))}


def restore_alias_history_event(services: AliasChangeServices, evento_id: str) -> Dict[str, Any]:
    historico = services.load_alias_history()
    evento = next((item for item in historico if item.get("id") == evento_id), None)
    if evento is None:
        raise DomainError("O registro selecionado não existe mais no histórico.", status_code=404)

    target_serial = str(evento.get("serial") or "").strip().upper()
    equipamento = inventory_state.equipamentos_cache.get(target_serial)
    if equipamento is None:
        raise DomainError(f"Equipamento com serial '{target_serial}' não encontrado na base de dados.", status_code=404)

    if evento.get("tipo") == "endereco":
        raise DomainConflictError("Endereços são atualizados pela planilha da Simpress e não podem mais ser restaurados manualmente.")
    tipo_evento = "apelido"
    evento_mais_recente = next(
        (
            item for item in reversed(historico)
            if str(item.get("serial") or "").strip().upper() == target_serial
            and _is_alias_event(item)
        ),
        None,
    )
    if not evento_mais_recente or evento_mais_recente.get("id") != evento_id:
        raise DomainConflictError("Só é possível excluir e restaurar o registro mais recente daquele campo.")

    apelido_atual = str(equipamento.get("_apelido_local", equipamento.get("_apelido_base", "")) or "").strip()
    apelido_novo = str(evento.get("apelido_novo") or "").strip()
    if apelido_atual != apelido_novo:
        raise DomainConflictError("O apelido salvo não corresponde mais a este registro. Recarregue a base antes de restaurar.")

    apelido_anterior = str(evento.get("apelido_anterior") or "").strip()
    resultado = apply_alias_change(
        services,
        target_serial,
        apelido_anterior,
        registrar_historico=False,
        expected_current_local=apelido_novo,
        expected_latest_event_id=evento_id,
        remove_history_event_id=evento_id,
        drop_override=evento.get("tinha_override") is False,
    )
    equipamento_restaurado = resultado["equipamento"]

    return {
        "sucesso": True,
        "evento_id": evento_id,
        "tipo": tipo_evento,
        "equipamento": services.public_equipment(equipamento_restaurado),
        "mensagem": "Valor anterior restaurado para pesquisas e exportações; registro removido do histórico.",
    }


def undo_alias_change(services: AliasChangeServices, evento_id: str) -> Dict[str, Any]:
    historico = services.load_alias_history()
    evento = next((item for item in historico if item.get("id") == evento_id), None)
    if evento is None:
        raise DomainError("A alteração selecionada não existe no histórico.", status_code=404)

    target_serial = str(evento.get("serial") or "").strip().upper()
    equipamento = inventory_state.equipamentos_cache.get(target_serial)
    if equipamento is None:
        raise DomainError(f"Equipamento com serial '{target_serial}' não encontrado na base de dados.", status_code=404)

    evento_mais_recente = next(
        (
            item for item in reversed(historico)
            if str(item.get("serial") or "").strip().upper() == target_serial
            and _is_alias_event(item)
        ),
        None,
    )
    if not evento_mais_recente or evento_mais_recente.get("id") != evento.get("id"):
        raise DomainConflictError("Só é possível desfazer a alteração mais recente deste equipamento.")

    apelido_atual = str(equipamento.get("_apelido_local", equipamento.get("_apelido_base", "")) or "").strip()
    apelido_evento = str(evento.get("apelido_novo") or "").strip()
    if apelido_atual != apelido_evento:
        raise DomainConflictError("O valor salvo foi alterado depois deste registro. Recarregue o histórico antes de desfazer.")

    apelido_restaurado = str(evento.get("apelido_anterior") or "").strip()
    resultado = apply_alias_change(
        services,
        target_serial,
        apelido_restaurado,
        action="desfazer",
        reference_id=evento["id"],
        expected_current_local=apelido_evento,
        expected_latest_event_id=evento["id"],
        drop_override=evento.get("tinha_override") is False,
    )
    return {
        "sucesso": True,
        "mensagem": "Apelido restaurado; a reversão foi registrada no histórico.",
        **{**resultado, "equipamento": services.public_equipment(resultado["equipamento"])},
        "total_modificados": len(services.load_modified_apelidos()),
    }
