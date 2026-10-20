"""Endpoint hostname index and effective alias precedence.

The effective alias of an equipment follows a fixed precedence:
manual override > unique Endpoint hostname > Simpress alias. Hostnames are
applied only when the serial appears exactly once in both sources.
"""

import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, FrozenSet, Iterable, List, Optional, Set, Tuple

from core.errors import DomainError

from domains.inventory_comparison import _record_value, normalize_reference_value

logger = logging.getLogger(__name__)
_last_alias_conflicts = 0

MANUAL_ALIAS_MARKER = "(M)"
_MANUAL_ALIAS_MARKER_PATTERN = re.compile(r"\s*\(M\)\s*$", re.IGNORECASE)


def strip_manual_alias_marker(alias: Any) -> str:
    """Return the alias without the trailing ``(M)`` manual marker."""
    return _MANUAL_ALIAS_MARKER_PATTERN.sub("", str(alias or "")).strip()


def with_manual_alias_marker(alias: Any) -> str:
    """Return the alias ending in exactly one `` (M)``; empty aliases stay empty."""
    base = strip_manual_alias_marker(alias)
    return f"{base} {MANUAL_ALIAS_MARKER}" if base else ""


@dataclass(frozen=True)
class EffectiveAliasServices:
    endpoint_upload_file: Callable[[], Path]
    validate_uploaded_workbook: Callable[[bytes, str], Dict[str, Any]]
    logger: logging.Logger


def unavailable_endpoint_alias_index() -> Dict[str, Any]:
    return {
        "available": False, "unique": {}, "duplicates": {}, "blank_serials": [], "blank_hostnames": {},
        "users": {}, "ambiguous_users": {},
    }


def build_endpoint_alias_index(
    records: Iterable[Dict[str, Any]],
    removed: FrozenSet[Tuple[str, str]] = frozenset(),
) -> Dict[str, Any]:
    """Split Endpoint rows into unique associations and rows to review.

    ``removed`` holds normalized (serial, hostname) pairs the user discarded from
    the duplicates; those rows are skipped, so the remaining hostname becomes unique.
    """
    rows_by_serial: Dict[str, List[Dict[str, str]]] = {}
    users_by_serial: Dict[str, List[str]] = {}
    blank_serials: List[Dict[str, str]] = []
    for record in records:
        serial = _record_value(
            record,
            "ROTULODESERVICONUMERODESERIE",
            "NUMEROSERIE",
            "NUMERODESERIE",
            "SERIAL",
            "SERVICETAG",
        )
        serial_key = normalize_reference_value(serial)
        hostname = str(
            _record_value(record, "NOMEDOCOMPUTADOR", "COMPUTERNAME", "HOSTNAME", "APELIDO") or ""
        ).strip()
        logged_users = str(_record_value(record, "USUARIOSLOGADOS", "USUARIOLOGADO") or "").strip()
        if normalize_reference_value(logged_users) == "NA":
            logged_users = ""
        if serial_key and hostname and (serial_key, normalize_reference_value(hostname)) in removed:
            continue
        row = {"serie": str(serial or "").strip(), "hostname": hostname}
        if serial_key:
            rows_by_serial.setdefault(serial_key, []).append(row)
            users_by_serial.setdefault(serial_key, []).append(logged_users)
        elif hostname:
            blank_serials.append(row)

    unique: Dict[str, str] = {}
    duplicates: Dict[str, List[Dict[str, str]]] = {}
    blank_hostnames: Dict[str, Dict[str, str]] = {}
    for serial_key, rows in rows_by_serial.items():
        if len(rows) > 1:
            duplicates[serial_key] = rows
        elif rows[0]["hostname"]:
            unique[serial_key] = rows[0]["hostname"]
        else:
            blank_hostnames[serial_key] = rows[0]

    users = {
        serial_key: values[0]
        for serial_key, values in users_by_serial.items()
        if len(values) == 1 and values[0]
    }
    # A serial repeated in the Endpoint gets no user; its distinct users are kept only to be shown.
    ambiguous_users: Dict[str, List[str]] = {}
    for serial_key, values in users_by_serial.items():
        if len(values) < 2:
            continue
        candidates: Dict[str, str] = {}
        for value in values:
            if value:
                candidates.setdefault(value.casefold(), value)
        if candidates:
            ambiguous_users[serial_key] = list(candidates.values())

    return {
        "available": True,
        "users": users,
        "ambiguous_users": ambiguous_users,
        "unique": unique,
        "duplicates": duplicates,
        "blank_serials": blank_serials,
        "blank_hostnames": blank_hostnames,
    }


def read_endpoint_alias_index(
    services: EffectiveAliasServices,
    removed: FrozenSet[Tuple[str, str]] = frozenset(),
) -> Dict[str, Any]:
    """Retorna associações unívocas e linhas que precisam de conferência."""
    endpoint_file = services.endpoint_upload_file()
    if not endpoint_file.is_file():
        return unavailable_endpoint_alias_index()

    try:
        table = services.validate_uploaded_workbook(endpoint_file.read_bytes(), "endpoint")
    except (OSError, DomainError) as error:
        services.logger.warning(
            "Falha ao ler hostnames (arquivo=%s, papel=endpoint, erro=%s).",
            endpoint_file.name, type(error).__name__,
        )
        return unavailable_endpoint_alias_index()

    return build_endpoint_alias_index(table.get("records", []), removed)


def endpoint_loss_warnings(
    previous: Dict[str, Any],
    current: Dict[str, Any],
) -> List[Dict[str, str]]:
    """List series whose Endpoint user or hostname disappeared between two InvAll files.

    Nothing is reported when either index is unavailable, and ambiguous series
    (duplicated in the new file) are skipped because they already have their own status.
    """
    if not previous.get("available") or not current.get("available"):
        return []
    warnings: List[Dict[str, str]] = []
    duplicates = set(current.get("duplicates", {}))
    previous_serials = set(previous.get("users", {})) | set(previous.get("unique", {}))
    for serial_key in sorted(previous_serials):
        if serial_key in duplicates or serial_key in previous.get("duplicates", {}):
            continue
        previous_user = previous.get("users", {}).get(serial_key, "")
        if previous_user and not current.get("users", {}).get(serial_key):
            warnings.append({"serial_key": serial_key, "motivo": "usuario_removido", "valor_anterior": previous_user})
        previous_host = previous.get("unique", {}).get(serial_key, "")
        if previous_host and serial_key not in current.get("unique", {}):
            warnings.append({"serial_key": serial_key, "motivo": "hostname_removido", "valor_anterior": previous_host})
    return warnings


def endpoint_alias_review_items(
    index: Dict[str, Any],
    details_serials: Optional[Set[str]] = None,
    details_duplicate_serials: Optional[Set[str]] = None,
) -> List[Dict[str, str]]:
    """Describe InvAll rows that were deliberately not applied."""
    items: List[Dict[str, str]] = []
    for serial_key, rows in sorted(index.get("duplicates", {}).items()):
        items.append({
            "serie": rows[0].get("serie") or serial_key,
            "computador": ", ".join(row.get("hostname", "") for row in rows if row.get("hostname")),
            "motivo": "Série duplicada no endpoint; nenhum hostname foi escolhido.",
        })
    for row in index.get("blank_serials", []):
        items.append({
            "serie": "",
            "computador": row.get("hostname", ""),
            "motivo": "Número de série vazio no endpoint; hostname mantido sem associação.",
        })
    for serial_key, row in sorted(index.get("blank_hostnames", {}).items()):
        items.append({
            "serie": row.get("serie") or serial_key,
            "computador": "",
            "motivo": "Hostname vazio no endpoint; apelido atual preservado.",
        })
    if details_serials is not None:
        raw_details_duplicates = {
            normalize_reference_value(serial)
            for serial in (details_duplicate_serials or set())
        }
        mac_endpoint_serials = {
            normalize_reference_value(serial_key)
            for serial_key, hostname in index.get("unique", {}).items()
            if normalize_reference_value(hostname).startswith("PRMAC")
        }
        normalized_details_serials = set()
        normalized_details_duplicates = set()
        canonical_sources: Dict[str, Set[str]] = {}
        for serial_value in details_serials:
            serial_key = normalize_reference_value(serial_value)
            if not serial_key:
                continue
            comparison_key = (
                serial_key[1:]
                if serial_key.startswith("S") and serial_key[1:] in mac_endpoint_serials
                else serial_key
            )
            normalized_details_serials.add(comparison_key)
            canonical_sources.setdefault(comparison_key, set()).add(serial_key)
            if serial_key in raw_details_duplicates:
                normalized_details_duplicates.add(comparison_key)
        for comparison_key, source_keys in canonical_sources.items():
            if len(source_keys) > 1:
                normalized_details_duplicates.add(comparison_key)
        details_serials = normalized_details_serials
        details_duplicates = normalized_details_duplicates
        for serial_key in sorted(details_duplicates):
            items.append({
                "serie": serial_key,
                "computador": index.get("unique", {}).get(serial_key, ""),
                "motivo": "Série duplicada na Simpress; nenhum registro foi escolhido.",
            })
        known_invall_serials = (
            set(index.get("unique", {}))
            | set(index.get("duplicates", {}))
            | set(index.get("blank_hostnames", {}))
        )
        for serial_key in sorted(details_serials - known_invall_serials - details_duplicates):
            items.append({
                "serie": serial_key,
                "computador": "",
                "motivo": (
                    "Endpoint indisponível; apelido atual preservado para conferência."
                    if not index.get("available")
                    else "Série não encontrada no endpoint; apelido atual preservado."
                ),
            })
        for serial_key, hostname in sorted(index.get("unique", {}).items()):
            if serial_key not in details_serials:
                items.append({
                    "serie": serial_key,
                    "computador": hostname,
                    "motivo": "Série não encontrada na Simpress; nenhum dado foi alterado.",
                })
    return items


def manual_alias_for_serial(overrides: Dict[str, str], serial: Any, fallback: str) -> str:
    serial_key = normalize_reference_value(serial)
    if not serial_key:
        return fallback
    return manual_aliases_by_serial(overrides).get(serial_key, fallback)


def manual_aliases_by_serial(overrides: Dict[str, str]) -> Dict[str, str]:
    """Keep only manual overrides whose normalized serial is unambiguous.

    Keys that differ only by case or punctuation collapse to one serial. They are
    kept when they agree on the alias; conflicting ones are ignored (the sheet alias
    wins) and logged without serials, since nothing tells which edit is the right one.
    Editing that alias again replaces every colliding key and resolves the conflict.
    """
    aliases_by_serial: Dict[str, Set[str]] = {}
    for serial, alias in overrides.items():
        serial_key = normalize_reference_value(serial)
        if serial_key:
            aliases_by_serial.setdefault(serial_key, set()).add(str(alias or "").strip())
    global _last_alias_conflicts
    conflicts = sum(1 for aliases in aliases_by_serial.values() if len(aliases) > 1)
    # Logged only when the count changes: the stats poll calls this every few seconds.
    if conflicts and conflicts != _last_alias_conflicts:
        logger.warning(
            "%d série(s) com apelidos manuais conflitantes foram ignoradas; edite o apelido para resolver.",
            conflicts,
        )
    _last_alias_conflicts = conflicts
    return {
        serial_key: next(iter(aliases))
        for serial_key, aliases in aliases_by_serial.items()
        if len(aliases) == 1
    }


def mac_endpoint_serial_key(index: Dict[str, Any], serial_key: str) -> str:
    """Endpoint serial of a Simpress MacBook serial written with a leading ``S``.

    ``SCXC9F072K1`` in EquipamentosDetalhes is ``CXC9F072K1`` in the Endpoint when that
    serial has a unique ``PRMAC`` hostname there. When the Simpress base also lists the
    serial without ``S`` (``index["details_serials"]``), the match is ambiguous and none is made.
    """
    if len(serial_key) < 2 or not serial_key.startswith("S"):
        return ""
    base = serial_key[1:]
    if not normalize_reference_value(index.get("unique", {}).get(base, "")).startswith("PRMAC"):
        return ""
    if base in (index.get("details_serials") or ()):
        return ""
    return base


def with_details_serials(index: Dict[str, Any], details_serials: Iterable[Any]) -> Dict[str, Any]:
    """Copy of ``index`` that knows the Simpress base serials, for the MacBook ``S`` equivalence."""
    enriched = dict(index)
    enriched["details_serials"] = {key for serial in details_serials if (key := normalize_reference_value(serial))}
    return enriched


def endpoint_user_for_serial(index: Dict[str, Any], serial_key: str) -> str:
    """Endpoint user of one normalized serial, with the MacBook ``S`` equivalence as a fallback."""
    users = index.get("users", {})
    if users.get(serial_key):
        return str(users[serial_key])
    known = (
        serial_key in index.get("unique", {})
        or serial_key in index.get("duplicates", {})
        or serial_key in index.get("blank_hostnames", {})
    )
    base = "" if known else mac_endpoint_serial_key(index, serial_key)
    return str(users.get(base, "") or "") if base else ""


def endpoint_user_candidates(index: Dict[str, Any], serial_key: str) -> List[str]:
    """Users of a serial repeated in the Endpoint; none of them is chosen automatically."""
    if endpoint_user_for_serial(index, serial_key):
        return []
    return [str(user) for user in index.get("ambiguous_users", {}).get(serial_key, [])]


def apply_effective_alias(
    equipment: Dict[str, Any],
    endpoint_index: Dict[str, Any],
    *,
    details_duplicate: bool = False,
) -> None:
    """Set ``apelido`` and the Endpoint status fields on one equipment record."""
    serial_key = normalize_reference_value(equipment.get("serial"))
    local_alias = str(equipment.get("_apelido_local", equipment.get("_apelido_base", "")) or "").strip()
    manual_override = bool(equipment.get("_apelido_manual_override"))
    equipment["apelido"] = local_alias
    endpoint_user = endpoint_user_for_serial(endpoint_index, serial_key)
    manual_user = str(endpoint_index.get("manual_users", {}).get(serial_key, "") or "").strip()
    # O usuário do Endpoint sempre prevalece; o manual só preenche a lacuna.
    equipment["usuarios_logados"] = endpoint_user or manual_user
    equipment["usuarios_logados_origem"] = (
        "endpoint" if endpoint_user else "manual" if manual_user else ""
    )
    equipment["usuarios_logados_informado_em"] = (
        str(endpoint_index.get("manual_user_dates", {}).get(serial_key, "") or "")
        if manual_user and not endpoint_user
        else ""
    )
    equipment["usuarios_logados_candidatos"] = endpoint_user_candidates(endpoint_index, serial_key)

    if not endpoint_index.get("available"):
        equipment["invall_alias_status"] = "indisponivel"
        equipment["invall_alias_detail"] = "O Endpoint ativo não pôde ser lido; o apelido atual foi mantido."
    elif details_duplicate:
        equipment["invall_alias_status"] = "serie_detalhes_duplicada"
        equipment["invall_alias_detail"] = "A série aparece mais de uma vez na Simpress; confira antes de aplicar um hostname."
    elif serial_key in endpoint_index.get("duplicates", {}):
        equipment["invall_alias_status"] = "serie_invall_duplicada"
        equipment["invall_alias_detail"] = "A série aparece mais de uma vez no endpoint; o apelido atual foi mantido."
    elif serial_key in endpoint_index.get("unique", {}):
        if not manual_override:
            equipment["apelido"] = endpoint_index["unique"][serial_key]
        equipment["invall_alias_status"] = "aplicado"
        equipment["invall_alias_detail"] = (
            "Série associada ao Endpoint; o apelido manual prevalece."
            if manual_override
            else "Hostname do Endpoint associado pela série normalizada."
        )
    elif serial_key in endpoint_index.get("blank_hostnames", {}):
        equipment["invall_alias_status"] = "hostname_vazio"
        equipment["invall_alias_detail"] = "O Endpoint tem a série, mas o hostname está vazio; o apelido atual foi mantido."
    else:
        equipment["invall_alias_status"] = "serie_nao_encontrada"
        equipment["invall_alias_detail"] = "Série não encontrada no endpoint; o apelido atual foi mantido."


def merge_export_aliases(endpoint_aliases: Dict[str, str], overrides: Dict[str, str]) -> Dict[str, str]:
    """Combine unique Endpoint hostnames with manual overrides, which win."""
    aliases = dict(endpoint_aliases)
    aliases.update(manual_aliases_by_serial(overrides))
    return aliases

