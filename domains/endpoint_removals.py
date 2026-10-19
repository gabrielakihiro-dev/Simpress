"""Hostnames do Endpoint que o usuário descartou nas duplicidades.

Quando a mesma série aparece em mais de uma linha do Endpoint, nenhum hostname é
escolhido. Descartar a linha mais antiga (pela última verificação com êxito) deixa
a outra como única: ela passa a valer na base e em toda exportação seguinte. A
planilha de origem não é alterada; só a lista local de pares série/hostname
descartados (``hostnames_removidos.json``) é gravada, e pode ser desfeita.
"""

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, FrozenSet, Iterable, List, Tuple, Type

from core.errors import DomainConflictError, DomainError
from core.integrity import FileBusyError, FileTransactionError, WorkbookSafetyError
from domains.inventory_comparison import normalize_reference_value

MAX_SERIAL_LENGTH = 128
MAX_HOSTNAME_LENGTH = 160

RemovalKeys = FrozenSet[Tuple[str, str]]


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def removal_key(serial: Any, hostname: Any) -> Tuple[str, str]:
    return normalize_reference_value(serial), normalize_reference_value(hostname)


def removal_keys(entries: Iterable[Any]) -> RemovalKeys:
    """Normalize stored entries; malformed or blank entries never match a row."""
    keys = set()
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        key = removal_key(entry.get("serie"), entry.get("hostname"))
        if key[0] and key[1]:
            keys.add(key)
    return frozenset(keys)


@dataclass(frozen=True)
class EndpointRemovalServices:
    removals_file: Callable[[], Path]
    load_removals: Callable[[], List[Dict[str, Any]]]
    validate_json_history: Callable[[Any, str], List[Dict[str, Any]]]
    transaction_root: Callable[[], Path]
    atomic_file_transaction: Callable[[Path, List[Path]], Any]
    read_endpoint_alias_index: Callable[[], Dict[str, Any]]
    reload_database: Callable[[], Any]
    external_errors: Tuple[Type[BaseException], ...] = ()


def list_removals(services: EndpointRemovalServices) -> Dict[str, Any]:
    entries = [
        {
            "serie": str(entry.get("serie") or ""),
            "hostname": str(entry.get("hostname") or ""),
            "removido_em": str(entry.get("removido_em") or ""),
        }
        for entry in services.load_removals()
        if isinstance(entry, dict)
    ]
    return {"removidos": entries}


def _clean(value: str, label: str, limit: int) -> str:
    text = str(value or "").strip()
    if not text:
        raise DomainError(f"Informe {label}.", status_code=422)
    if len(text) > limit:
        raise DomainError(f"{label[0].upper()}{label[1:]} excede {limit} caracteres.", status_code=422)
    return text


def _write(services: EndpointRemovalServices, update: Callable[[List[Dict[str, Any]]], List[Dict[str, Any]]]) -> None:
    passthrough: Tuple[Type[BaseException], ...] = (DomainError, *services.external_errors)
    try:
        with services.atomic_file_transaction(
            services.transaction_root(), [services.removals_file()]
        ) as transaction:
            transaction.update_json(
                services.removals_file(),
                lambda data: update(list(services.validate_json_history(data, "hostnames removidos"))),
                [],
            )
            transaction.commit()
    except passthrough:
        raise
    except FileBusyError as error:
        raise DomainConflictError(str(error)) from error
    except WorkbookSafetyError as error:
        raise DomainConflictError(f"Gravação cancelada: {error}") from error
    except FileTransactionError as error:
        raise DomainError(f"Não foi possível salvar a remoção: {error}") from error


def remove_endpoint_hostname(services: EndpointRemovalServices, serie: str, hostname: str) -> Dict[str, Any]:
    """Descarta uma linha duplicada do Endpoint; ao menos uma linha da série permanece."""
    serie = _clean(serie, "a série", MAX_SERIAL_LENGTH)
    hostname = _clean(hostname, "o hostname", MAX_HOSTNAME_LENGTH)
    key = removal_key(serie, hostname)

    index = services.read_endpoint_alias_index()
    rows = index.get("duplicates", {}).get(key[0], [])
    if not any(normalize_reference_value(row.get("hostname")) == key[1] for row in rows):
        raise DomainConflictError(
            "Esse hostname não está mais duplicado no Endpoint ativo; atualize o histórico e confira."
        )
    remaining = [row for row in rows if normalize_reference_value(row.get("hostname")) != key[1]]
    if not remaining:
        raise DomainConflictError("Ao menos um hostname da série precisa permanecer.")

    def add(entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        if key in removal_keys(entries):
            return entries
        return [*entries, {"serie": serie, "hostname": hostname, "removido_em": _now()}]

    _write(services, add)
    services.reload_database()
    return {
        "sucesso": True,
        "serie": serie,
        "hostname": hostname,
        "mantidos": sorted({row.get("hostname", "") for row in remaining if row.get("hostname")}),
        "mensagem": "Hostname removido. Os que permaneceram valem na base e nas próximas exportações.",
    }


def restore_endpoint_hostname(services: EndpointRemovalServices, serie: str, hostname: str) -> Dict[str, Any]:
    serie = _clean(serie, "a série", MAX_SERIAL_LENGTH)
    hostname = _clean(hostname, "o hostname", MAX_HOSTNAME_LENGTH)
    key = removal_key(serie, hostname)

    def drop(entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return [
            entry for entry in entries
            if not (isinstance(entry, dict) and removal_key(entry.get("serie"), entry.get("hostname")) == key)
        ]

    _write(services, drop)
    services.reload_database()
    return {
        "sucesso": True,
        "serie": serie,
        "hostname": hostname,
        "mensagem": "Hostname restaurado; a série volta a aparecer como duplicada.",
    }
