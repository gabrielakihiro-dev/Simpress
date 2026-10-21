"""Pending decisions about the logged-in user when a new Endpoint file disagrees with what is stored.

Two situations never change a user on their own; each is kept as a *hold* in
``usuarios_pendencias.json`` (next to the manual users file) until the person decides:

* ``substituicao_manual``: the Endpoint now reports a user for a serial that has a manual one.
  While the hold is active the manual user keeps applying. *Permitir* archives the manual user
  and lets the Endpoint user win; *Recusar* keeps the manual user and remembers the refused
  Endpoint user, so the same Endpoint user is not asked about again.
* ``usuario_ausente``: the Endpoint used to report a user and no longer does. The previous user
  keeps applying. *Remover* confirms the user is gone; *Manter* keeps the user and stops asking.

A user that changes from one Endpoint user to another, with no manual user involved, needs no
decision and is applied by the update itself.
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
from domains.effective_alias import endpoint_user_for_serial, with_details_serials
from domains.inventory_comparison import normalize_reference_value
from domains.inventory_state import STATE_LOCK
from domains.user_changes import (
    ARCHIVED_BY_ENDPOINT_ACTION,
    _equipment_by_serial_key,
    _equipment_label,
    _load_users,
    _now,
    _users_file,
    build_user_change_entry,
    manual_user_dates_file,
    manual_user_dates_by_serial,
    manual_users_by_serial,
    read_manual_user_dates,
    without_manual_users,
)

HOLDS_FILENAME = "usuarios_pendencias.json"
HOLD_REPLACE_MANUAL = "substituicao_manual"
HOLD_USER_MISSING = "usuario_ausente"
ACTIVE_STATES = {HOLD_REPLACE_MANUAL: ("pendente", "recusada"), HOLD_USER_MISSING: ("pendente", "mantido")}
DECISIONS = {
    HOLD_REPLACE_MANUAL: {"permitir": "permitida", "recusar": "recusada"},
    HOLD_USER_MISSING: {"remover": "removida", "manter": "mantido"},
}
DECISION_MESSAGES = {
    "permitir": "Usuário do Endpoint aplicado; o usuário manual foi arquivado no histórico de alterações.",
    "recusar": "Usuário manual mantido; este usuário do Endpoint não será perguntado de novo.",
    "remover": "Usuário removido.",
    "manter": "Usuário mantido; ele não será perguntado de novo enquanto o Endpoint não informar outro.",
}
# Row types listed under "Mudanças de usuário logado" for holds created by an update.
CHANGE_TYPE_BY_HOLD = {HOLD_REPLACE_MANUAL: "substituicao_pendente", HOLD_USER_MISSING: "ausente_pendente"}


def holds_file(users_file: Path) -> Path:
    return users_file.with_name(HOLDS_FILENAME)


def normalize_holds(stored: Any) -> Dict[str, Dict[str, Any]]:
    """Validate the complete decision file and return active holds keyed by serial."""
    if not isinstance(stored, dict):
        raise DomainBusyError("O arquivo local de decisões de usuário tem formato inválido; a atualização foi interrompida.")
    holds: Dict[str, Dict[str, Any]] = {}
    for serial, entry in stored.items():
        key = normalize_reference_value(serial)
        if not key or not isinstance(entry, dict) or key in holds:
            raise DomainBusyError("O arquivo local de decisões de usuário tem registros inválidos; a atualização foi interrompida.")
        kind, state = entry.get("tipo"), entry.get("estado")
        hold_id = entry.get("id")
        hold_serial = entry.get("serial")
        current_user = entry.get("usuario_atual")
        endpoint_user = entry.get("usuario_endpoint", "")
        if not isinstance(kind, str) or kind not in ACTIVE_STATES:
            raise DomainBusyError("O arquivo local de decisões de usuário tem registros inválidos; a atualização foi interrompida.")
        if not isinstance(state, str) or state not in ACTIVE_STATES[kind]:
            raise DomainBusyError("O arquivo local de decisões de usuário tem registros inválidos; a atualização foi interrompida.")
        if (
            not isinstance(hold_id, str) or not hold_id.strip()
            or not isinstance(hold_serial, str)
            or normalize_reference_value(hold_serial) != key
            or not isinstance(current_user, str) or not current_user.strip()
            or not isinstance(endpoint_user, str)
            or (kind == HOLD_REPLACE_MANUAL and not endpoint_user.strip())
            or (kind == HOLD_USER_MISSING and endpoint_user.strip())
        ):
            raise DomainBusyError("O arquivo local de decisões de usuário tem registros inválidos; a atualização foi interrompida.")
        holds[key] = entry
    return holds


def read_holds(users_file: Path) -> Dict[str, Dict[str, Any]]:
    """Return no holds only when the file is genuinely absent; reject unreadable state."""
    path = holds_file(users_file)
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except (OSError, UnicodeError) as error:
        raise DomainBusyError(
            "O arquivo local de decisões de usuário está indisponível; a atualização foi interrompida."
        ) from error
    try:
        value = json.loads(raw)
    except (json.JSONDecodeError, UnicodeError) as error:
        raise DomainBusyError(
            "O arquivo local de decisões de usuário está ilegível; a atualização foi interrompida."
        ) from error
    return normalize_holds(value)


def manual_users_from_holds(holds: Dict[str, Dict[str, Any]]) -> Dict[str, str]:
    """Recover the current manual user only from an active substitution decision."""
    return {
        serial: str(hold["usuario_atual"]).strip()
        for serial, hold in holds.items()
        if hold.get("tipo") == HOLD_REPLACE_MANUAL
        and hold.get("estado") in ACTIVE_STATES[HOLD_REPLACE_MANUAL]
        and str(hold.get("usuario_atual") or "").strip()
    }


def _same_user(first: Any, second: Any) -> bool:
    return str(first or "").strip().casefold() == str(second or "").strip().casefold()


def plan_holds(
    previous_cache: Dict[str, Dict[str, Any]],
    current_cache: Dict[str, Dict[str, Any]],
    endpoint_index: Dict[str, Any],
    manual_users: Dict[str, str],
    existing: Dict[str, Dict[str, Any]],
) -> Tuple[Dict[str, Dict[str, Any]], List[Dict[str, Any]]]:
    """Holds after an update and the ones this update created (for the result and its export).

    ``previous_cache`` holds the effective users from before the update, ``endpoint_index`` the new
    Endpoint (already seen through ``with_details_serials``) and ``manual_users`` the stored manual
    users. Holds for serials that left the base are dropped.
    """
    if not endpoint_index.get("available"):
        return dict(existing), []
    before = _equipment_by_serial_key(previous_cache)
    holds: Dict[str, Dict[str, Any]] = {}
    created: List[Dict[str, Any]] = []
    for key, equipment in _equipment_by_serial_key(current_cache).items():
        endpoint_user = endpoint_user_for_serial(endpoint_index, key).strip()
        manual_user = manual_users.get(key, "")
        hold = existing.get(key)
        new_hold: Optional[Dict[str, Any]] = None
        if endpoint_user:
            if manual_user and not _same_user(manual_user, endpoint_user):
                if hold and hold.get("tipo") == HOLD_REPLACE_MANUAL and _same_user(hold.get("usuario_endpoint"), endpoint_user):
                    new_hold = {**hold, "usuario_atual": manual_user}
                else:
                    new_hold = _build_hold(
                        HOLD_REPLACE_MANUAL, equipment, key, manual_user, endpoint_user,
                    )
                    created.append(new_hold)
        else:
            previous = before.get(key)
            if hold and hold.get("tipo") == HOLD_USER_MISSING:
                new_hold = hold
            elif (
                hold and hold.get("tipo") == HOLD_REPLACE_MANUAL
                and endpoint_index.get("manual_users_file_missing")
                and hold.get("estado") == "recusada"
            ):
                # The refusal is the only trusted copy when the manual-users file is absent.
                new_hold = hold
            elif previous is not None:
                old_user = str(previous.get("usuarios_logados") or "").strip()
                if old_user and previous.get("usuarios_logados_origem") == "endpoint":
                    new_hold = _build_hold(HOLD_USER_MISSING, equipment, key, old_user, "")
                    created.append(new_hold)
        if new_hold is not None:
            holds[key] = new_hold
    return holds, created


def _build_hold(kind: str, equipment: Dict[str, Any], key: str, current_user: str, endpoint_user: str) -> Dict[str, Any]:
    return {
        "id": uuid.uuid4().hex,
        "tipo": kind,
        "estado": "pendente",
        "serial": str(equipment.get("serial") or key).strip(),
        "equipamento": _equipment_label(equipment),
        "computador": str(equipment.get("apelido") or "").strip(),
        "usuario_atual": current_user,
        "usuario_endpoint": endpoint_user,
        "criado_em": _now(),
    }


def hold_change_rows(created: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    """Rows for "Mudanças de usuário logado": one per hold created by this update."""
    rows = []
    for hold in created:
        if hold["tipo"] == HOLD_REPLACE_MANUAL:
            reason = (
                f"O Endpoint passou a informar {hold['usuario_endpoint']}, mas há um usuário manual "
                f"({hold['usuario_atual']}). O usuário manual continua valendo até você permitir ou recusar a substituição."
            )
            row = {
                "usuario_anterior": hold["usuario_atual"], "origem_anterior": "manual",
                "usuario_novo": hold["usuario_endpoint"], "origem_nova": "endpoint",
            }
        else:
            reason = (
                f"O Endpoint deixou de informar o usuário {hold['usuario_atual']}. O usuário continua valendo "
                "até você confirmar se ele realmente deixou de existir ou se permanece."
            )
            row = {
                "usuario_anterior": hold["usuario_atual"], "origem_anterior": "endpoint",
                "usuario_novo": "", "origem_nova": "",
            }
        rows.append({
            "serie": hold["serial"],
            "computador": hold.get("computador", ""),
            "tipo": CHANGE_TYPE_BY_HOLD[hold["tipo"]],
            "pendencia_id": hold["id"],
            "pendencia_tipo": hold["tipo"],
            "motivo": reason,
            **row,
        })
    return rows


def list_holds(services: AliasChangeServices) -> Dict[str, Any]:
    """Every hold still waiting for (or remembering) a decision."""
    holds = read_holds(_users_file(services))
    return {"pendencias": [
        {
            "id": hold["id"], "serie": hold["serial"], "tipo": hold["tipo"], "estado": hold["estado"],
            "usuario_atual": hold["usuario_atual"], "usuario_endpoint": hold.get("usuario_endpoint", ""),
            "computador": str(hold.get("computador") or "").strip(),
        }
        for hold in holds.values()
    ]}


def resolve_hold(services: AliasChangeServices, hold_id: str, decision: str) -> Dict[str, Any]:
    """Apply one decision to a hold and refresh the equipment it concerns."""
    users_file = _users_file(services)
    hold = next((item for item in read_holds(users_file).values() if item["id"] == hold_id), None)
    if hold is None:
        raise DomainError("Esta pendência não existe mais; atualize o histórico e confira.", status_code=404)
    new_state = DECISIONS[hold["tipo"]].get(decision)
    if new_state is None:
        raise DomainError("Esta decisão não se aplica a essa pendência.", status_code=422)
    if hold["estado"] != "pendente":
        raise DomainConflictError("Esta pendência já foi decidida.")
    serial = str(hold["serial"]).strip().upper()
    serial_key = normalize_reference_value(serial)
    with STATE_LOCK:
        if inventory_state.equipamentos_cache.get(serial) is None:
            raise DomainError(f"Equipamento com serial '{serial}' não encontrado na base de dados.", status_code=404)
    passthrough: Tuple[Type[BaseException], ...] = (DomainError, *services.external_errors)
    dates_file, pending_file = manual_user_dates_file(users_file), holds_file(users_file)
    try:
        with services.atomic_file_transaction(
            services.transaction_root(), [users_file, dates_file, pending_file, services.alias_history_file()]
        ) as transaction:
            # Another request can resolve or replace the decision while this one waits
            # for the file locks. Never apply the pre-lock copy to the newer state.
            if read_holds(users_file).get(serial_key) != hold:
                raise DomainConflictError("Esta pendência mudou; atualize o histórico e confira antes de decidir.")
            with STATE_LOCK:
                next_equipment_cache = deepcopy(inventory_state.equipamentos_cache)
                next_unit_cache = deepcopy(inventory_state.unidades_cache)
                next_stats_cache = deepcopy(inventory_state.stats_cache)
            equipment = next_equipment_cache.get(serial)
            if equipment is None:
                raise DomainError(f"Equipamento com serial '{serial}' não encontrado na base de dados.", status_code=404)
            stored_users = dict(services.validate_json_object(_load_users(services), "usuários manuais"))
            manual_now = manual_users_by_serial(stored_users)
            endpoint_index = with_details_serials(services.read_endpoint_alias_index(), next_equipment_cache)
            if endpoint_index.get("manual_users_file_missing"):
                manual_now.update(endpoint_index.get("manual_users", {}))
            if not endpoint_index.get("available"):
                raise DomainBusyError("O Endpoint está indisponível; nenhuma decisão foi aplicada.")
            endpoint_user = endpoint_user_for_serial(endpoint_index, serial_key)
            if hold["tipo"] == HOLD_REPLACE_MANUAL:
                users_changed = (
                    not _same_user(manual_now.get(serial_key), hold["usuario_atual"])
                    or not _same_user(endpoint_user, hold["usuario_endpoint"])
                )
            else:
                users_changed = bool(endpoint_user.strip())
            if users_changed:
                raise DomainConflictError("Os usuários desta pendência mudaram; atualize o histórico antes de decidir.")
            archive_manual = hold["tipo"] == HOLD_REPLACE_MANUAL and decision == "permitir"
            if archive_manual:
                archived_user = manual_now.get(serial_key, "")
                if not endpoint_index.get("manual_users_file_missing"):
                    transaction.update_json(users_file, lambda data: without_manual_users(data, {serial_key}), {})
                transaction.update_json(
                    dates_file,
                    lambda data: {k: v for k, v in (data if isinstance(data, dict) else {}).items()
                                  if normalize_reference_value(k) != serial_key},
                    {},
                )
                if archived_user:
                    entry = build_user_change_entry(
                        hold["serial"], hold["equipamento"], archived_user, "", ARCHIVED_BY_ENDPOINT_ACTION,
                    )
                    entry["usuario_endpoint"] = hold.get("usuario_endpoint", "")
                    transaction.update_json(
                        services.alias_history_file(),
                        lambda history: [*services.validate_json_history(history, "histórico"), entry],
                        [],
                    )
                manual_now.pop(serial_key, None)

            keep_entry = new_state in ("recusada", "mantido")

            def update_holds(data: Any) -> Dict[str, Any]:
                result = {k: v for k, v in (data if isinstance(data, dict) else {}).items()
                          if normalize_reference_value(k) != serial_key}
                if keep_entry:
                    result[hold["serial"]] = {**hold, "estado": new_state, "resolvido_em": _now()}
                return result

            transaction.update_json(pending_file, update_holds, {})
            holds_after = {serial_key: {**hold, "estado": new_state}} if keep_entry else {}
            index = dict(endpoint_index)
            index["manual_users"] = manual_now
            index["manual_user_dates"] = manual_user_dates_by_serial(manual_now, read_manual_user_dates(users_file))
            index["user_holds"] = holds_after
            index["manual_users_file_missing"] = bool(
                endpoint_index.get("manual_users_file_missing") and manual_now
            )
            updated = dict(equipment)
            services.apply_effective_alias(
                updated, index, details_duplicate=updated.get("invall_alias_status") == "serie_detalhes_duplicada",
            )
            next_equipment_cache[serial] = updated
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
        raise DomainError(f"Não foi possível salvar a decisão: {error}") from error
    return {
        "sucesso": True,
        "pendencia_id": hold_id,
        "decisao": decision,
        "estado": new_state,
        "equipamento": services.public_equipment(updated),
        "mensagem": DECISION_MESSAGES[decision],
    }
