"""Manual logged-in user: fill the gap when the Endpoint has no user for a serial.

The manual user is kept per serial in a local JSON file and only applies while the
Endpoint reports no user. When it was informed goes to a sibling file
(``usuarios_manuais_datas.json``), so the users file keeps its ``serial -> text`` shape;
users saved before that file existed simply have no date. Every change is recorded in
the alias history (``tipo`` ``usuario``) so it can be undone, and warnings raised when
a new Endpoint file drops a user or hostname are stored there as ``aviso_endpoint`` events.
"""

import json
import uuid
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Type

from core.errors import DomainConflictError, DomainError
from core.integrity import FileBusyError, FileTransactionError, WorkbookSafetyError
from domains import inventory_state
from domains.alias_changes import AliasChangeServices
from domains.effective_alias import (
    endpoint_user_candidates,
    endpoint_user_for_serial,
    mac_endpoint_serial_key,
    with_details_serials,
)
from domains.inventory_comparison import normalize_reference_value
from domains.inventory_state import STATE_LOCK

MAX_USER_LENGTH = 160
MANUAL_USER_DATES_FILENAME = "usuarios_manuais_datas.json"
USER_EVENT_TYPE = "usuario"
WARNING_EVENT_TYPE = "aviso_endpoint"


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def manual_users_by_serial(stored: Dict[str, Any]) -> Dict[str, str]:
    """Normalize stored ``serial -> user`` keys; blank values and ambiguous keys are dropped."""
    by_serial: Dict[str, set] = {}
    for serial, user in stored.items():
        serial_key = normalize_reference_value(serial)
        text = str(user or "").strip()
        if serial_key and text:
            by_serial.setdefault(serial_key, set()).add(text)
    return {key: next(iter(values)) for key, values in by_serial.items() if len(values) == 1}


def manual_user_dates_file(users_file: Path) -> Path:
    return users_file.with_name(MANUAL_USER_DATES_FILENAME)


def read_manual_user_dates(users_file: Path) -> Dict[str, Any]:
    """Stored ``serial -> {usuario, informado_em}``; a missing or unreadable file only hides the dates."""
    path = manual_user_dates_file(users_file)
    try:
        value = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except (OSError, UnicodeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def manual_user_dates_by_serial(users: Dict[str, str], stored_dates: Dict[str, Any]) -> Dict[str, str]:
    """When each current manual user was informed.

    ``users`` comes from ``manual_users_by_serial``. A date counts only while it was recorded
    for that same user, so a user edited outside the app never shows someone else's date.
    """
    dates: Dict[str, str] = {}
    for serial, entry in stored_dates.items():
        serial_key = normalize_reference_value(serial)
        if not isinstance(entry, dict) or serial_key not in users:
            continue
        informed_at = str(entry.get("informado_em") or "").strip()
        if informed_at and str(entry.get("usuario") or "").strip() == users[serial_key]:
            dates[serial_key] = max(informed_at, dates.get(serial_key, ""))
    return dates


def build_user_change_entry(
    serial: str,
    equipment_label: str,
    previous_user: str,
    new_user: str,
    action: str = "alteracao",
    reference_id: Optional[str] = None,
) -> Dict[str, Any]:
    return {
        "id": uuid.uuid4().hex,
        "tipo": USER_EVENT_TYPE,
        "serial": serial,
        "equipamento": equipment_label,
        "usuario_anterior": previous_user,
        "usuario_novo": new_user,
        "horario": _now(),
        "acao": action,
        "referencia_id": reference_id,
    }


def build_endpoint_warning_entries(
    warnings: List[Dict[str, str]],
    equipment_by_serial_key: Dict[str, Dict[str, Any]],
    existing_history: List[Dict[str, Any]],
    source_label: str,
) -> List[Dict[str, Any]]:
    """Turn ``endpoint_loss_warnings`` rows into history events, skipping repeats of the same file."""
    seen = {
        (item.get("origem"), normalize_reference_value(item.get("serial")), item.get("motivo"))
        for item in existing_history
        if item.get("tipo") == WARNING_EVENT_TYPE
    }
    entries = []
    for warning in warnings:
        serial_key = warning["serial_key"]
        key = (source_label, serial_key, warning["motivo"])
        if key in seen:
            continue
        equipment = equipment_by_serial_key.get(serial_key, {})
        entries.append({
            "id": uuid.uuid4().hex,
            "tipo": WARNING_EVENT_TYPE,
            "serial": str(equipment.get("serial") or serial_key),
            "equipamento": equipment.get("modelo") or equipment.get("tipo") or "Equipamento",
            "motivo": warning["motivo"],
            "valor_anterior": warning["valor_anterior"],
            "origem": source_label,
            "horario": _now(),
            "acao": "aviso",
        })
    return entries


def _locate_equipment(serial: str) -> Dict[str, Any]:
    with STATE_LOCK:
        equipment = inventory_state.equipamentos_cache.get(serial)
        equipment = dict(equipment) if equipment is not None else None
    if equipment is None:
        raise DomainError(f"Equipamento com serial '{serial}' não encontrado na base de dados.", status_code=404)
    return equipment


def _require_user_services(services: AliasChangeServices) -> None:
    if services.manual_users_file is None or services.load_manual_users is None:
        raise DomainError("O cadastro manual de usuários não está configurado.", status_code=503)


def _users_file(services: AliasChangeServices) -> Path:
    if services.manual_users_file is None:
        raise DomainError("O cadastro manual de usuários não está configurado.", status_code=503)
    return services.manual_users_file()


def _load_users(services: AliasChangeServices) -> Dict[str, str]:
    if services.load_manual_users is None:
        raise DomainError("O cadastro manual de usuários não está configurado.", status_code=503)
    return services.load_manual_users()


def apply_user_change(
    services: AliasChangeServices,
    serial: str,
    new_user: str,
    action: str = "alteracao",
    reference_id: Optional[str] = None,
    expected_latest_event_id: Optional[str] = None,
    expected_current: Optional[str] = None,
    remove_history_event_id: Optional[str] = None,
    record_history: bool = True,
) -> Dict[str, Any]:
    """Save (or clear, with an empty value) the manual user of one serial."""
    _require_user_services(services)
    target_serial = serial.strip().upper()
    new_user = str(new_user or "").strip()
    if len(new_user) > MAX_USER_LENGTH:
        raise DomainError(f"O usuário pode ter no máximo {MAX_USER_LENGTH} caracteres.", status_code=422)
    _locate_equipment(target_serial)
    passthrough: Tuple[Type[BaseException], ...] = (DomainError, *services.external_errors)
    serial_key = normalize_reference_value(target_serial)

    try:
        users_file = _users_file(services)
        dates_file = manual_user_dates_file(users_file)
        with services.atomic_file_transaction(
            services.transaction_root(), [users_file, dates_file, services.alias_history_file()]
        ) as transaction:
            with STATE_LOCK:
                next_equipment_cache = deepcopy(inventory_state.equipamentos_cache)
                next_unit_cache = deepcopy(inventory_state.unidades_cache)
                next_stats_cache = deepcopy(inventory_state.stats_cache)
            equipment = next_equipment_cache.get(target_serial)
            if equipment is None:
                raise DomainError(f"Equipamento com serial '{target_serial}' não encontrado na base de dados.", status_code=404)

            endpoint_index = with_details_serials(services.read_endpoint_alias_index(), next_equipment_cache)
            if new_user and endpoint_user_for_serial(endpoint_index, serial_key):
                raise DomainConflictError("O Endpoint já informa o usuário deste equipamento; o cadastro manual não é necessário.")

            stored = dict(services.validate_json_object(_load_users(services), "usuários manuais"))
            previous_user = manual_users_by_serial(stored).get(serial_key, "")
            # Saving the same user again keeps the date it was first informed.
            informed_at = (
                manual_user_dates_by_serial(
                    {serial_key: previous_user}, read_manual_user_dates(users_file),
                ).get(serial_key, "")
                if previous_user and previous_user == new_user
                else ""
            ) or _now()
            if expected_current is not None and previous_user != expected_current:
                raise DomainConflictError("O usuário salvo mudou depois deste registro; nenhuma alteração foi aplicada.")

            def update_users(data: Any) -> Dict[str, Any]:
                users = dict(services.validate_json_object(data, "usuários manuais"))
                for key in [k for k in users if normalize_reference_value(k) == serial_key]:
                    users.pop(key, None)
                if new_user:
                    users[target_serial] = new_user
                return users

            transaction.update_json(users_file, update_users, {})

            def update_dates(data: Any) -> Dict[str, Any]:
                dates = dict(data) if isinstance(data, dict) else {}
                for key in [k for k in dates if normalize_reference_value(k) == serial_key]:
                    dates.pop(key, None)
                if new_user:
                    dates[target_serial] = {"usuario": new_user, "informado_em": informed_at}
                return dates

            transaction.update_json(dates_file, update_dates, {})

            history_changes = (previous_user != new_user and record_history) or bool(remove_history_event_id)
            if history_changes:
                label = equipment.get("modelo") or equipment.get("tipo") or "Equipamento"

                def update_history(history: Any) -> List[Dict[str, Any]]:
                    history = list(services.validate_json_history(history, "histórico"))
                    if expected_latest_event_id:
                        latest = next((
                            item for item in reversed(history)
                            if str(item.get("serial") or "").strip().upper() == target_serial
                            and item.get("tipo") == USER_EVENT_TYPE
                        ), None)
                        if not latest or latest.get("id") != expected_latest_event_id:
                            raise DomainConflictError("Só é possível desfazer a alteração de usuário mais recente deste equipamento.")
                    if remove_history_event_id:
                        kept = [item for item in history if item.get("id") != remove_history_event_id]
                        if len(kept) == len(history):
                            raise DomainConflictError("O registro foi alterado por outra ação; atualize o histórico e tente novamente.")
                        history = kept
                    if previous_user != new_user and record_history:
                        history.append(build_user_change_entry(
                            target_serial, label, previous_user, new_user, action, reference_id,
                        ))
                    return history

                transaction.update_json(services.alias_history_file(), update_history, [])

            manual_now = {serial_key: new_user} if new_user else {}
            index_for_equipment = dict(endpoint_index)
            index_for_equipment["manual_users"] = manual_now
            index_for_equipment["manual_user_dates"] = {serial_key: informed_at} if new_user else {}
            updated = dict(equipment)
            services.apply_effective_alias(
                updated,
                index_for_equipment,
                details_duplicate=updated.get("invall_alias_status") == "serie_detalhes_duplicada",
            )
            next_equipment_cache[target_serial] = updated
            prepared = services.prepare_database_state(next_equipment_cache, next_unit_cache, next_stats_cache)
            transaction.commit()
            services.publish_database_state(prepared)
    except passthrough:
        raise
    except FileBusyError as error:
        raise DomainConflictError(str(error)) from error
    except WorkbookSafetyError as error:
        raise DomainConflictError(f"Gravação cancelada: {error}") from error
    except FileTransactionError as error:
        raise DomainError(f"Não foi possível salvar o usuário: {error}") from error

    return {
        "sucesso": True,
        "equipamento": services.public_equipment(updated),
        "usuario_anterior": previous_user,
        "usuario_novo": new_user,
        "mensagem": "Usuário salvo." if new_user else "Usuário manual removido.",
    }


def update_manual_user(services: AliasChangeServices, serial: str, usuario: str) -> Dict[str, Any]:
    return apply_user_change(services, serial, usuario)


def logged_users_for_series(services: AliasChangeServices, series: List[str]) -> Dict[str, Any]:
    """Logged user of each serial with the Home rule: the Endpoint user wins, the manual one fills the gap.

    ``serial_cadastro`` is set only for serials in the current EquipamentosDetalhes base, the
    only ones that accept a manual user. A MacBook listed by its Endpoint serial (``CXC9F072K1``)
    is matched to its Simpress serial with the leading ``S`` (``SCXC9F072K1``). Serials outside
    the base fall back to the Endpoint user.
    """
    wanted = {str(serie or "").strip(): normalize_reference_value(serie) for serie in series}
    wanted = {serie: key for serie, key in wanted.items() if serie and key}
    wanted_keys = set(wanted.values()) | {f"S{key}" for key in wanted.values()}
    by_key: Dict[str, List[Dict[str, Any]]] = {}
    with STATE_LOCK:
        details_serials = list(inventory_state.equipamentos_cache)
        for serial, equipment in inventory_state.equipamentos_cache.items():
            key = normalize_reference_value(serial)
            if key in wanted_keys:
                by_key.setdefault(key, []).append({
                    "serial": str(equipment.get("serial") or serial),
                    "usuario": str(equipment.get("usuarios_logados") or "").strip(),
                    "origem": str(equipment.get("usuarios_logados_origem") or ""),
                    "informado_em": str(equipment.get("usuarios_logados_informado_em") or ""),
                    "candidatos": list(equipment.get("usuarios_logados_candidatos") or []),
                })
    endpoint_index = with_details_serials(services.read_endpoint_alias_index(), details_serials)
    result: Dict[str, Any] = {}
    for serie, key in wanted.items():
        matches = by_key.get(key, [])
        if not matches and mac_endpoint_serial_key(endpoint_index, f"S{key}") == key:
            matches = by_key.get(f"S{key}", [])
        if len(matches) == 1:
            match = matches[0]
            origem = match["origem"] if match["usuario"] else ""
            result[serie] = {
                "usuario": match["usuario"],
                "origem": origem,
                "serial_cadastro": match["serial"],
                "informado_em": match["informado_em"] if origem == "manual" else "",
                "candidatos": match["candidatos"],
            }
            continue
        usuario = endpoint_user_for_serial(endpoint_index, key).strip()
        result[serie] = {
            "usuario": usuario,
            "origem": "endpoint" if usuario else "",
            "serial_cadastro": None,
            "informado_em": "",
            "candidatos": endpoint_user_candidates(endpoint_index, key),
        }
    return {"usuarios": result}


def _find_user_event(services: AliasChangeServices, evento_id: str) -> Dict[str, Any]:
    history = services.load_alias_history()
    event = next((item for item in history if item.get("id") == evento_id), None)
    if event is None or event.get("tipo") != USER_EVENT_TYPE:
        raise DomainError("A alteração selecionada não existe no histórico.", status_code=404)
    return event


def undo_user_change(services: AliasChangeServices, evento_id: str) -> Dict[str, Any]:
    event = _find_user_event(services, evento_id)
    result = apply_user_change(
        services,
        event["serial"],
        str(event.get("usuario_anterior") or ""),
        action="desfazer",
        reference_id=evento_id,
        expected_latest_event_id=evento_id,
        expected_current=str(event.get("usuario_novo") or ""),
    )
    result["mensagem"] = "Usuário restaurado; a reversão foi registrada no histórico."
    return result


def restore_user_history_event(services: AliasChangeServices, evento_id: str) -> Dict[str, Any]:
    event = _find_user_event(services, evento_id)
    result = apply_user_change(
        services,
        event["serial"],
        str(event.get("usuario_anterior") or ""),
        expected_latest_event_id=evento_id,
        expected_current=str(event.get("usuario_novo") or ""),
        remove_history_event_id=evento_id,
        record_history=False,
    )
    result.update({
        "evento_id": evento_id,
        "tipo": USER_EVENT_TYPE,
        "mensagem": "Valor anterior restaurado; registro removido do histórico.",
    })
    return result


def dismiss_warning_event(services: AliasChangeServices, evento_id: str) -> Dict[str, Any]:
    """Remove one Endpoint warning from the history (it never changes equipment data)."""
    _require_user_services(services)
    removed = {"done": False}
    with services.atomic_file_transaction(services.transaction_root(), [services.alias_history_file()]) as transaction:
        def drop(history: Any) -> List[Dict[str, Any]]:
            history = list(services.validate_json_history(history, "histórico"))
            kept = [item for item in history if not (item.get("id") == evento_id and item.get("tipo") == WARNING_EVENT_TYPE)]
            removed["done"] = len(kept) != len(history)
            return kept
        transaction.update_json(services.alias_history_file(), drop, [])
        if not removed["done"]:
            raise DomainError("O aviso selecionado não existe mais no histórico.", status_code=404)
        transaction.commit()
    return {"sucesso": True, "evento_id": evento_id, "tipo": WARNING_EVENT_TYPE, "mensagem": "Aviso removido do histórico."}
