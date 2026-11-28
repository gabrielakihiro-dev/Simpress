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
    # Pares com remoção "incerto" (ou removidos no Endpoint sem gravação local): bloqueiam novo clique no Endpoint.
    pending_file: Callable[[], Path]
    load_pending: Callable[[], List[Dict[str, Any]]]
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
    pendentes = [
        {
            "serie": str(entry.get("serie") or ""),
            "hostname": str(entry.get("hostname") or ""),
            "resultado": str(entry.get("resultado") or ""),
            "em": str(entry.get("em") or ""),
        }
        for entry in services.load_pending()
        if isinstance(entry, dict)
    ]
    return {"removidos": entries, "pendentes": pendentes}


def _clean(value: str, label: str, limit: int) -> str:
    text = str(value or "").strip()
    if not text:
        raise DomainError(f"Informe {label}.", status_code=422)
    if len(text) > limit:
        raise DomainError(f"{label[0].upper()}{label[1:]} excede {limit} caracteres.", status_code=422)
    return text


Update = Callable[[List[Dict[str, Any]]], List[Dict[str, Any]]]
PENDING_LABEL = "remoções pendentes no Endpoint"
MSG_PENDENTE = (
    "Esta remoção no Endpoint Central ficou pendente: confira no Endpoint. Se o computador sumiu de lá, "
    "use \"Gravar só no cockpit\"; o Endpoint não é acionado de novo."
)


def _write(services: EndpointRemovalServices, changes: List[Tuple[Path, str, Update]]) -> None:
    """Grava os arquivos de ``changes`` (caminho, rótulo, atualização) numa única transação."""
    passthrough: Tuple[Type[BaseException], ...] = (DomainError, *services.external_errors)

    def apply(update: Update, label: str) -> Callable[[Any], List[Dict[str, Any]]]:
        return lambda data: update(list(services.validate_json_history(data, label)))

    try:
        with services.atomic_file_transaction(
            services.transaction_root(), [path for path, _label, _update in changes]
        ) as transaction:
            for path, label, update in changes:
                transaction.update_json(path, apply(update, label), [])
            transaction.commit()
    except passthrough:
        raise
    except FileBusyError as error:
        raise DomainConflictError(str(error)) from error
    except WorkbookSafetyError as error:
        raise DomainConflictError(f"Gravação cancelada: {error}") from error
    except FileTransactionError as error:
        raise DomainError(f"Não foi possível salvar a remoção: {error}") from error


def _remaining_rows(rows: List[Dict[str, Any]], key: Tuple[str, str], stored: RemovalKeys) -> List[Dict[str, Any]]:
    """Linhas da série que continuam após a remoção; recusa deixar a série sem hostname."""
    remaining = [
        row for row in rows
        if normalize_reference_value(row.get("hostname")) != key[1]
        and removal_key(key[0], row.get("hostname")) not in stored
    ]
    if not remaining:
        raise DomainConflictError("Ao menos um hostname da série precisa permanecer.")
    return remaining


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
    remaining = _remaining_rows(rows, key, frozenset())

    def add(entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        # O índice foi lido fora da trava: outra remoção da mesma série pode ter sido
        # gravada depois dele. Refaz a conta com a lista atual, dentro da transação.
        nonlocal remaining
        stored = removal_keys(entries)
        if key in stored:
            return entries
        remaining = _remaining_rows(rows, key, stored)
        return [*entries, {"serie": serie, "hostname": hostname, "removido_em": _now()}]

    changes: List[Tuple[Path, str, Update]] = [(services.removals_file(), "hostnames removidos", add)]
    if key in removal_keys(services.load_pending()):
        # Gravar só no cockpit encerra a pendência do Endpoint na mesma transação.
        changes.append((services.pending_file(), PENDING_LABEL, lambda entries: _without(entries, key)))
    _write(services, changes)
    services.reload_database()
    return {
        "sucesso": True,
        "serie": serie,
        "hostname": hostname,
        "mantidos": sorted({row.get("hostname", "") for row in remaining if row.get("hostname")}),
        "mensagem": "Hostname removido. Os que permaneceram valem na base e nas próximas exportações.",
    }


def remove_in_endpoint(
    services: EndpointRemovalServices, serie: str, hostname: str, confirmado: bool,
    remover: Callable[[str, bool, str], Dict[str, Any]],
) -> Dict[str, Any]:
    """Remove o computador antigo no Endpoint Central e, só depois de ``removido``, grava o par localmente.

    Guardas antes de abrir o Chrome: o par não está pendente; está nas duplicidades do índice atual; a série tem
    um hostname mais recente sem empate e o pedido não é ele (o nome vivo nunca é removido); o nome antigo não
    aparece em outra série. A automação recebe o nome cru da linha do índice e o corte de data do mais recente.
    """
    serie = _clean(serie, "a série", MAX_SERIAL_LENGTH)
    hostname = _clean(hostname, "o hostname", MAX_HOSTNAME_LENGTH)
    key = removal_key(serie, hostname)
    if key in removal_keys(services.load_pending()):
        raise DomainConflictError(MSG_PENDENTE)
    index = services.read_endpoint_alias_index()
    duplicates = index.get("duplicates", {})
    row = next(
        (item for item in duplicates.get(key[0], []) if normalize_reference_value(item.get("hostname")) == key[1]), None
    )
    if row is None:
        raise DomainConflictError(
            "Esse hostname não está mais duplicado no Endpoint ativo; atualize o histórico e confira."
        )
    vivo = index.get("resolved_by_recency", {}).get(key[0])
    if not vivo:
        raise DomainConflictError("As verificações empatam ou faltam datas: não dá para saber qual é o mais antigo.")
    if normalize_reference_value(vivo) == key[1]:
        raise DomainConflictError("Esse é o hostname mais recente; só o mais antigo pode ser removido.")
    em_outra_serie = any(
        other_key != key[0] and normalize_reference_value(other) == key[1]
        for other_key, other in index.get("unique", {}).items()
    ) or any(
        other_key != key[0] and normalize_reference_value(item.get("hostname")) == key[1]
        for other_key, rows in duplicates.items() for item in rows
    )
    if em_outra_serie:
        raise DomainConflictError("Esse hostname também aparece em outra série no Endpoint; confira antes de remover.")
    corte = index.get("verified_by_serial", {}).get(key[0])
    if not corte:
        raise DomainConflictError("Falta a data de verificação do hostname mais recente; confira no Endpoint.")

    resultado = dict(remover(str(row.get("hostname") or hostname), confirmado, str(corte)))
    if resultado.get("resultado") == "incerto":
        if not _mark_pending(services, serie, hostname, "incerto"):
            resultado["mensagem"] = (
                f"{resultado.get('mensagem', '')} Não consegui registrar a pendência: "
                "não tente de novo antes de conferir no Endpoint."
            )
        return {**resultado, "gravado_local": False, "pendente": True}
    if resultado.get("resultado") != "removido":
        return {**resultado, "gravado_local": False}
    try:
        local = remove_endpoint_hostname(services, serie, hostname)
    except Exception as error:
        # O Endpoint já removeu: nunca vira 409/503 nem libera nova remoção; a nova tentativa é só local.
        detalhe = str(getattr(error, "detail", "") or type(error).__name__)
        aviso = "" if _mark_pending(services, serie, hostname, "removido_sem_gravacao_local") else (
            " Não consegui registrar a pendência: não tente remover no Endpoint de novo."
        )
        return {
            **resultado, "gravado_local": False, "pendente": True,
            "mensagem": (
                f"Removido no Endpoint Central, mas a gravação no cockpit falhou ({detalhe}). "
                f"Use \"Gravar só no cockpit\"; o Endpoint não é acionado de novo.{aviso}"
            ),
        }
    return {
        **resultado, "gravado_local": True, "serie": serie, "hostname": hostname, "mantidos": local["mantidos"],
        "mensagem": "Computador removido no Endpoint Central; o outro hostname passa a valer na base e nas próximas exportações.",
    }


def _without(entries: List[Dict[str, Any]], key: Tuple[str, str]) -> List[Dict[str, Any]]:
    return [
        entry for entry in entries
        if not (isinstance(entry, dict) and removal_key(entry.get("serie"), entry.get("hostname")) == key)
    ]


def _mark_pending(services: EndpointRemovalServices, serie: str, hostname: str, resultado: str) -> bool:
    key = removal_key(serie, hostname)

    def add(entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return [*_without(entries, key), {"serie": serie, "hostname": hostname, "resultado": resultado, "em": _now()}]

    try:
        _write(services, [(services.pending_file(), PENDING_LABEL, add)])
        return True
    except Exception:
        return False


def restore_endpoint_hostname(services: EndpointRemovalServices, serie: str, hostname: str) -> Dict[str, Any]:
    serie = _clean(serie, "a série", MAX_SERIAL_LENGTH)
    hostname = _clean(hostname, "o hostname", MAX_HOSTNAME_LENGTH)
    key = removal_key(serie, hostname)

    _write(services, [(services.removals_file(), "hostnames removidos", lambda entries: _without(entries, key))])
    services.reload_database()
    return {
        "sucesso": True,
        "serie": serie,
        "hostname": hostname,
        "mensagem": "Hostname restaurado; a série volta a aparecer como duplicada.",
    }
