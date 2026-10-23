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

from core.errors import DomainBusyError, DomainConflictError, DomainError
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
# A manual user hidden by an Endpoint user is moved out of the manual file into the alias
# history with this action, so it never comes back on its own when the Endpoint empties.
ARCHIVED_BY_ENDPOINT_ACTION = "arquivado_endpoint"
USER_CHANGE_ORDER = (
    "substituicao_pendente", "ausente_pendente",
    "novo_endpoint", "alterado_endpoint", "removido_endpoint", "manual_voltou",
)


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


def read_manual_users(users_file: Path) -> Optional[Dict[str, str]]:
    """Read the manual-user decision file; only a genuinely missing file is absent."""
    try:
        raw = users_file.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except (OSError, UnicodeError) as error:
        raise DomainBusyError(
            "O cadastro manual de usuários está indisponível; nenhuma decisão foi aplicada."
        ) from error
    try:
        value = json.loads(raw)
    except (json.JSONDecodeError, UnicodeError) as error:
        raise DomainBusyError(
            "O cadastro manual de usuários está ilegível; nenhuma decisão foi aplicada."
        ) from error
    if not isinstance(value, dict) or any(
        not isinstance(serial, str) or not isinstance(user, str)
        for serial, user in value.items()
    ):
        raise DomainBusyError(
            "O cadastro manual de usuários tem formato inválido; nenhuma decisão foi aplicada."
        )
    return value


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


def _equipment_label(equipment: Dict[str, Any]) -> str:
    return equipment.get("modelo") or equipment.get("tipo") or "Equipamento"


def _equipment_by_serial_key(cache: Dict[str, Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """One equipment per normalized serial; serials repeated in the Simpress base are left out."""
    grouped: Dict[str, List[Dict[str, Any]]] = {}
    for serial, equipment in cache.items():
        key = normalize_reference_value(equipment.get("serial") or serial)
        if key and equipment.get("invall_alias_status") != "serie_detalhes_duplicada":
            grouped.setdefault(key, []).append(equipment)
    return {key: items[0] for key, items in grouped.items() if len(items) == 1}


def manual_users_overridden_by_endpoint(
    equipment_cache: Dict[str, Dict[str, Any]],
    manual_users: Dict[str, str],
) -> Dict[str, Dict[str, str]]:
    """Manual users hidden because the Endpoint now reports a user, keyed by normalized serial."""
    overridden: Dict[str, Dict[str, str]] = {}
    for key, equipment in _equipment_by_serial_key(equipment_cache).items():
        manual = manual_users.get(key, "")
        if manual and equipment.get("usuarios_logados_origem") == "endpoint":
            overridden[key] = {
                "serial": str(equipment.get("serial") or key).strip(),
                "equipamento": _equipment_label(equipment),
                "usuario_manual": manual,
                "usuario_endpoint": str(equipment.get("usuarios_logados") or "").strip(),
            }
    return overridden


def build_archived_manual_user_entries(overridden: Dict[str, Dict[str, str]]) -> List[Dict[str, Any]]:
    """History events that keep each archived manual user; undoing one restores it."""
    entries = []
    for key in sorted(overridden):
        item = overridden[key]
        entry = build_user_change_entry(
            item["serial"], item["equipamento"], item["usuario_manual"], "", ARCHIVED_BY_ENDPOINT_ACTION,
        )
        entry["usuario_endpoint"] = item["usuario_endpoint"]
        entries.append(entry)
    return entries


def without_manual_users(stored: Any, serial_keys: set) -> Dict[str, Any]:
    """Manual users file without the given serials (every key spelling is removed)."""
    if not isinstance(stored, dict):
        raise RuntimeError("O cadastro de usuários manuais não contém um objeto válido.")
    return {serial: user for serial, user in stored.items() if normalize_reference_value(serial) not in serial_keys}


def archived_manual_users(history: List[Any]) -> Dict[str, str]:
    """Manual user archived by the Endpoint, per serial, while no later user change replaced it."""
    latest: Dict[str, Dict[str, Any]] = {}
    for item in history:
        if isinstance(item, dict) and item.get("tipo") == USER_EVENT_TYPE:
            key = normalize_reference_value(item.get("serial"))
            if key:
                latest[key] = item
    return {
        key: str(event.get("usuario_anterior") or "")
        for key, event in latest.items()
        if event.get("acao") == ARCHIVED_BY_ENDPOINT_ACTION and str(event.get("usuario_anterior") or "").strip()
    }


def logged_user_changes(
    previous_cache: Dict[str, Dict[str, Any]],
    current_cache: Dict[str, Dict[str, Any]],
    endpoint_index: Dict[str, Any],
    overridden: Dict[str, Dict[str, str]],
    archived: Dict[str, str],
) -> List[Dict[str, str]]:
    """Logged-user changes between the base before and after an update, for its result.

    Only serials present in both loads are compared, so equipment that just entered or left
    the Simpress base is not listed. ``overridden`` holds the manual users archived by this
    update and ``archived`` the ones archived earlier, shown when the Endpoint user goes away.
    """
    before = _equipment_by_serial_key(previous_cache)
    duplicates = endpoint_index.get("duplicates", {})
    rows: List[Dict[str, str]] = []
    for key, equipment in _equipment_by_serial_key(current_cache).items():
        previous = before.get(key)
        if previous is None:
            continue
        old_user = str(previous.get("usuarios_logados") or "").strip()
        old_origin = str(previous.get("usuarios_logados_origem") or "") if old_user else ""
        new_user = str(equipment.get("usuarios_logados") or "").strip()
        new_origin = str(equipment.get("usuarios_logados_origem") or "") if new_user else ""
        manual_archived = ""
        if new_origin == "endpoint":
            if old_origin != "endpoint":
                change = "novo_endpoint"
                manual_archived = overridden.get(key, {}).get("usuario_manual", "")
                reason = "Usuário novo vindo do Endpoint." + (
                    f" O usuário manual {manual_archived} foi arquivado." if manual_archived else ""
                )
            elif old_user != new_user:
                change, reason = "alterado_endpoint", "Usuário alterado no Endpoint."
            else:
                continue
        elif old_origin == "endpoint":
            if new_origin == "manual":
                change = "manual_voltou"
                reason = "Usuário removido do Endpoint; o usuário manual voltou a valer. Confirme ou altere o usuário manual."
            else:
                change, reason = "removido_endpoint", "Usuário removido do Endpoint."
                if key in duplicates:
                    reason += " A série está duplicada no Endpoint; nenhum usuário foi escolhido."
                manual_archived = archived.get(key, "")
                if manual_archived:
                    reason += f" Usuário manual arquivado: {manual_archived}; salve-o novamente para restaurar."
        else:
            continue
        row = {
            "serie": str(equipment.get("serial") or key).strip(),
            "computador": str(equipment.get("apelido") or "").strip(),
            "tipo": change,
            "usuario_anterior": old_user,
            "origem_anterior": old_origin,
            "usuario_novo": new_user,
            "origem_nova": new_origin,
            "motivo": reason,
        }
        if manual_archived:
            row["usuario_manual_arquivado"] = manual_archived
        rows.append(row)
    rows.sort(key=lambda row: (USER_CHANGE_ORDER.index(row["tipo"]), row["serie"]))
    return rows


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
            held = str(equipment.get("usuarios_logados_origem") or "") == "manual" and bool(
                endpoint_user_for_serial(endpoint_index, serial_key)
            )
            if new_user and endpoint_user_for_serial(endpoint_index, serial_key) and not held:
                raise DomainConflictError("O Endpoint já informa o usuário deste equipamento; o cadastro manual não é necessário.")

            stored = dict(services.validate_json_object(_load_users(services), "usuários manuais"))
            previous_user = manual_users_by_serial(stored).get(serial_key, "")
            if endpoint_index.get("manual_users_file_missing"):
                previous_user = str(endpoint_index.get("manual_users", {}).get(serial_key, previous_user) or "")
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
                if endpoint_index.get("manual_users_file_missing"):
                    for held_key, held_user in endpoint_index.get("manual_users", {}).items():
                        held = endpoint_index.get("user_holds", {}).get(held_key)
                        if held_key != serial_key and held and held.get("tipo") == "substituicao_manual":
                            users.setdefault(str(held.get("serial") or held_key), held_user)
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
            index_for_equipment["manual_users_file_missing"] = False
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
                    "nome_pessoa": str(equipment.get("nome_pessoa") or "").strip(),
                    "nome_pessoa_origem": str(equipment.get("nome_pessoa_origem") or ""),
                    "nome_pessoa_editavel": bool(equipment.get("nome_pessoa_editavel")),
                    "origem": str(equipment.get("usuarios_logados_origem") or ""),
                    "informado_em": str(equipment.get("usuarios_logados_informado_em") or ""),
                    "candidatos": list(equipment.get("usuarios_logados_candidatos") or []),
                    "pendencia": str(equipment.get("usuarios_logados_pendencia") or ""),
                })
    endpoint_index = with_details_serials(services.read_endpoint_alias_index(), details_serials)
    result: Dict[str, Any] = {}
    for serie, key in wanted.items():
        matches = by_key.get(key, [])
        if not matches and mac_endpoint_serial_key(endpoint_index, f"S{key}") == key:
            matches = by_key.get(f"S{key}", [])
        hostname_key = key
        ambiguous_mac_key = ""
        if (
            hostname_key not in endpoint_index.get("unique", {})
            and hostname_key not in endpoint_index.get("duplicates", {})
            and (mac_key := mac_endpoint_serial_key(endpoint_index, hostname_key))
        ):
            hostname_key = mac_key
        elif (
            hostname_key.startswith("S")
            and hostname_key[1:] in endpoint_index.get("duplicates", {})
            and any(
                normalize_reference_value(item.get("hostname", "")).startswith("PRMAC")
                for item in endpoint_index["duplicates"][hostname_key[1:]]
            )
        ):
            # The Mac serial equivalence is safe only for one Endpoint match. Keep
            # duplicate candidates visible without selecting a hostname or user.
            hostname_key = hostname_key[1:]
            ambiguous_mac_key = hostname_key
        hostname_rows = endpoint_index.get("duplicates", {}).get(hostname_key, [])
        hostname_candidates = list(dict.fromkeys(
            str(item.get("hostname") or "").strip() for item in hostname_rows
            if str(item.get("hostname") or "").strip()
        ))
        hostname_ambiguous = len(hostname_rows) > 1 or len(matches) > 1
        hostname = "" if hostname_ambiguous else str(endpoint_index.get("unique", {}).get(hostname_key) or "").strip()
        if len(matches) == 1:
            match = matches[0]
            origem = match["origem"] if match["usuario"] else ""
            user_candidates = match["candidatos"]
            if ambiguous_mac_key and not user_candidates:
                user_candidates = endpoint_user_candidates(endpoint_index, ambiguous_mac_key)
            result[serie] = {
                "usuario": match["usuario"],
                "nome_pessoa": match["nome_pessoa"],
                "nome_pessoa_origem": match["nome_pessoa_origem"],
                "nome_pessoa_editavel": match["nome_pessoa_editavel"],
                "origem": origem,
                "serial_cadastro": match["serial"],
                "informado_em": match["informado_em"] if origem == "manual" else "",
                "candidatos": user_candidates,
                "hostname": hostname,
                "hostname_ambiguo": hostname_ambiguous,
                "hostname_candidatos": hostname_candidates,
            }
            if match["pendencia"]:
                result[serie]["pendencia"] = match["pendencia"]
            continue
        usuario = endpoint_user_for_serial(endpoint_index, key).strip()
        from domains.entra_users import resolve_name
        nome_pessoa, nome_pessoa_origem = resolve_name(
            usuario, key, endpoint_index.get("entra_directory", {}), {},
        )
        result[serie] = {
            "usuario": usuario,
            "nome_pessoa": nome_pessoa,
            "nome_pessoa_origem": nome_pessoa_origem,
            "nome_pessoa_editavel": False,
            "origem": "endpoint" if usuario else "",
            "serial_cadastro": None,
            "informado_em": "",
            "candidatos": endpoint_user_candidates(endpoint_index, ambiguous_mac_key or key),
            "hostname": hostname,
            "hostname_ambiguo": hostname_ambiguous,
            "hostname_candidatos": hostname_candidates,
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
