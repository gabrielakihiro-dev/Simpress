"""Equipment dossier (Home F1): the OS section, read only, from the imported ticket report.

Pure functions, plus the timeline ("linha_do_tempo"): one function per source, each gets the data already read.
The history kept by the importer is per series, not per OS. Only whitelisted fields leave here:
never the OS description, user, name, e-mail or phone, and never the timeline annotations (free text).
Doc: ``docs/cockpit-prompts/03-home-split-view.md``, section "Dossiê do equipamento".
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, time
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from domains.ticket_reporting import _stable_serial, annotate_ticket_os_signals, build_ticket_timeline_index

HISTORY_TITLE = "Mudanças da série nas importações de OS"
HISTORY_LIMIT = 30
STATE_MESSAGES = {
    "ok": "",
    "sem_base": "Sem base importada",
    "sem_registros": "Sem registros para esta série",
    "indisponivel": "Fonte indisponível",
}


def empty_os_section(state: str, **values: Any) -> Dict[str, Any]:
    """The OS section in its full shape, with no orders and no history; ``values`` override fields."""
    section: Dict[str, Any] = {
        "estado": state,
        "mensagem": STATE_MESSAGES[state],
        "total_importacoes": 0,
        "ultima_importacao_em": "",
        "presente_na_ultima": False,
        "ultima_vez_observada_em": None,
        "ordens": [],
        "historico": {"titulo": HISTORY_TITLE, "eventos": [], "total": 0},
    }
    section.update(values)
    return section


def _texts(value: Any) -> List[str]:
    """Distinct non-blank strings of a list or scalar, in order."""
    items = value if isinstance(value, (list, tuple, set)) else [value]
    return list(dict.fromkeys(text for text in (str(item or "").strip() for item in items) if text))


def _os_key(value: str) -> str:
    return re.sub(r"\s+", "", value).upper()


def _days(value: Any) -> Optional[int]:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _utic(links_by_key: Mapping[str, Any], link_key: Callable[[str, str, str], str],
          source: str, row_serial: str, order: str) -> Optional[Dict[str, str]]:
    link = links_by_key.get(link_key(source, row_serial, order))
    if not isinstance(link, Mapping) or not str(link.get("chamado") or "").strip():
        return None
    return {"chamado": str(link["chamado"]), "origem": "Dashboard" if link.get("origem") == "dashboard" else "Manual"}


def _current_orders(rows: Sequence[Dict[str, Any]], links_by_key: Mapping[str, Any],
                    link_key: Callable[[str, str, str], str]) -> List[Dict[str, Any]]:
    """Orders of every row of the series in the latest import; one entry per (source, OS without spaces, upper)."""
    simpress: Dict[str, Dict[str, Any]] = {}
    oracle: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        # `serie` is the report row's own spelling: the OS tab matches rows and links by it, not by the registry one.
        row_serial = str(row.get("serie") or "").strip()
        raw_simpress = row.get("simpress")
        sp: Dict[str, Any] = raw_simpress if isinstance(raw_simpress, dict) else {}
        # The Simpress status belongs to the series, not to each OS.
        status = " · ".join(_texts(sp.get("status")))
        for order in _texts(sp.get("ordens_servico")):
            simpress.setdefault(_os_key(order), {
                "fonte": "simpress", "serie": row_serial, "os": order, "status": status, "fila": "", "dias_aberta": None,
                "utic": _utic(links_by_key, link_key, "simpress", row_serial, order),
            })
        raw_oracle = row.get("oracle")
        for item in raw_oracle if isinstance(raw_oracle, list) else []:
            order = str(item.get("ordem_servico") or "").strip() if isinstance(item, dict) else ""
            if not order:
                continue
            entry = oracle.setdefault(_os_key(order), {
                "fonte": "oracle", "serie": row_serial, "os": order, "status": [], "fila": [], "dias_aberta": None,
                "utic": _utic(links_by_key, link_key, "oracle", row_serial, order),
            })
            entry["status"] += _texts(" · ".join(_texts([item.get("status"), item.get("sub_status")])))
            entry["fila"] += _texts(item.get("fila"))
            days = [d for d in (entry["dias_aberta"], _days(item.get("dias_aberta"))) if d is not None]
            entry["dias_aberta"] = max(days) if days else None
    for entry in oracle.values():
        # shortcut: items of one OS with different status or queue are shown joined; upgrade if the screen needs one per item.
        entry["status"] = " / ".join(dict.fromkeys(entry["status"]))
        entry["fila"] = " / ".join(dict.fromkeys(entry["fila"]))
    return [*simpress.values(), *oracle.values()]


def build_os_section(snapshots: Sequence[Dict[str, Any]], serial: str, links_by_key: Mapping[str, Any],
                     link_key: Callable[[str, str, str], str]) -> Dict[str, Any]:
    """The "OS e chamados" section for one series.

    ``snapshots`` are the displayed (normalized) imports, oldest first; ``links_by_key`` maps ``link_key(source,
    series, OS)`` to a link (manual wins over the derived one before this call).
    """
    if not snapshots:
        return empty_os_section("sem_base")
    totals = {
        "total_importacoes": len(snapshots),
        "ultima_importacao_em": str(snapshots[-1].get("atualizado_em") or ""),
    }
    # Annotated copy of the latest import (adds `dias_aberta`), indexed as the very same object it is looked up in.
    latest = annotate_ticket_os_signals(snapshots[-1])
    index = build_ticket_timeline_index([*snapshots[:-1], latest])
    key = _stable_serial(serial)
    events = index.events_by_serial.get(key, ()) if key else ()
    if not events:
        return empty_os_section("sem_registros", **totals)

    rows = index.rows_by_snapshot_serial.get((id(latest), key), ())
    changed = [event for event in reversed(events) if event.get("tipo") != "Sem mudanças"]
    return empty_os_section(
        "ok",
        **totals,
        presente_na_ultima=bool(rows),
        # Never "encerrada": the series may only have left the report.
        ultima_vez_observada_em=None if rows else str(events[-1].get("atualizado_em") or ""),
        ordens=_current_orders(rows, links_by_key, link_key),
        historico={
            "titulo": HISTORY_TITLE,
            "eventos": [
                {
                    "atualizado_em": event.get("atualizado_em", ""),
                    "tipo": event.get("tipo", ""),
                    "mudancas": [
                        {"campo": change.get("campo"), "anterior": change.get("anterior"), "atual": change.get("atual")}
                        for change in event.get("mudancas", [])
                    ],
                }
                for event in changed[:HISTORY_LIMIT]
            ],
            "total": len(changed),
        },
    )


# ---------------------------------------------------------------------------- linha do tempo

TIMELINE_LIMIT = 200
TIMELINE_KINDS = ("apelido_usuario", "transferencia", "os", "sebrae", "cobertura")
_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")


@dataclass(frozen=True)
class DossierSources:
    """Readers of the timeline sources; ``None`` = source not wired (no events, not "indisponível").

    ``cobertura()`` gives ``(state, archived)``; ``sebrae_encerrados()`` the archive of closed Sebrae tickets."""

    apelidos: Optional[Callable[[], List[Dict[str, Any]]]] = None
    transferencias: Optional[Callable[[], List[Dict[str, Any]]]] = None
    cobertura: Optional[Callable[[], Tuple[Mapping[str, Any], Mapping[str, Any]]]] = None
    sebrae_encerrados: Optional[Callable[[], Mapping[str, Any]]] = None


Event = Tuple[Any, Dict[str, Any]]  # (raw date, event without "quando"/"so_data")


def _event(when: Any, kind: str, title: str, *details: str) -> Event:
    return when, {"tipo": kind, "titulo": title, "detalhes": [d for d in details if d]}


def _value(value: Any) -> str:
    text = ", ".join(_texts(value)) if isinstance(value, (list, tuple, set)) else str(value if value is not None else "").strip()
    return text or "(vazio)"


def _change(before: Any, after: Any) -> str:
    return f"{_value(before)} → {_value(after)}"


def _city(value: Any) -> str:
    return str(value or "").strip() or "—"


def _records(items: Any, serial_field: str, key: str) -> Iterable[Mapping[str, Any]]:
    return (i for i in items if isinstance(i, Mapping) and _stable_serial(i.get(serial_field)) == key)


def alias_user_events(history: Sequence[Any], key: str) -> List[Event]:
    events: List[Event] = []
    for item in _records(history, "serial", key):
        kind = item.get("tipo") or "apelido"
        if kind == "apelido":
            events.append(_event(item.get("horario"), "apelido_usuario", "Apelido alterado",
                                 _change(item.get("apelido_anterior"), item.get("apelido_novo"))))
        elif kind == "usuario":
            events.append(_event(item.get("horario"), "apelido_usuario", "Usuário alterado",
                                 _change(item.get("usuario_anterior"), item.get("usuario_novo"))))
    return events


def transfer_events(records: Sequence[Any], key: str) -> List[Event]:
    return [
        _event(item.get("criado_em"), "transferencia", "Transferência registrada",
               f"{_city(item.get('retirada_cidade'))} → {_city(item.get('entrega_cidade'))}")
        for item in _records(records, "serial", key)
    ]


def os_events(section: Mapping[str, Any]) -> List[Event]:
    """The change events ``build_os_section`` already keeps (``historico.eventos``)."""
    return [
        _event(event.get("atualizado_em"), "os", str(event.get("tipo") or ""),
               *(f"{c.get('campo')}: {_change(c.get('anterior'), c.get('atual'))}" for c in event.get("mudancas", [])))
        for event in section.get("historico", {}).get("eventos", [])
    ]


def sebrae_events(links: Sequence[Mapping[str, Any]], archive: Optional[Mapping[str, Any]], key: str) -> List[Event]:
    """``links``: every link (manual, finalização, Dashboard); only manual with ``salvo_em`` and finalização with
    ``finalizado_em`` have a date. ``archive`` (``sebrae_arquivo.ler``) gives the cycles of the series' tickets."""
    events: List[Event] = []
    numbers: Dict[str, str] = {}
    for link in _records(links, "serie", key):
        number, order = str(link.get("chamado") or "").strip(), str(link.get("os") or "").strip()
        if not number:
            continue
        numbers[number.upper()] = number
        origin = link.get("origem")
        if not origin and link.get("salvo_em"):
            events.append(_event(link["salvo_em"], "sebrae", "Chamado vinculado à OS", f"{number} · OS {order}"))
        elif origin == "finalizacao" and link.get("finalizado_em"):
            events.append(_event(link["finalizado_em"], "sebrae", "OS finalizada", f"{number} · OS {order}"))
    items = (archive or {}).get("itens")
    for item in (items.values() if isinstance(items, Mapping) else ()):
        number = numbers.get(str(item.get("numero") or "").strip().upper()) if isinstance(item, Mapping) else None
        for cycle in (item.get("ciclos") or []) if number else ():
            if not isinstance(cycle, Mapping):
                continue
            if cycle.get("motivo") == "finalizado":
                status = str(cycle.get("status") or "").strip()
                events.append(_event(cycle.get("saida_em"), "sebrae", "Chamado encerrado no Dashboard",
                                     f"{number} · {status}" if status else number))
            elif cycle.get("motivo") == "saiu_do_dashboard":
                events.append(_event(cycle.get("saida_em"), "sebrae", "Chamado saiu do Dashboard", number))
    # A finalização link exists once per source (Simpress/Oracle) for the same OS.
    return list({(repr(w), e["titulo"], tuple(e["detalhes"])): (w, e) for w, e in events}.values())


def coverage_events(state: Mapping[str, Any], archived: Mapping[str, Any], key: str) -> List[Event]:
    events: List[Event] = []
    demands = {**(archived.get("demandas") or {}), **(state.get("demandas") or {})}
    for source in (state, archived):
        for item in _records((source.get("reservas") or {}).values(), "serie", key):
            city = str((demands.get(item.get("demanda_id")) or {}).get("cidade") or "").strip()
            events.append(_event(item.get("criada_em"), "cobertura", "Reservada na Cobertura",
                                 f"Necessidade em {city}" if city else ""))
        for item in _records((source.get("movimentacoes") or {}).values(), "serie", key):
            route = f"{_city(item.get('origem_cidade'))} → {_city(item.get('destino_cidade'))}"
            events.append(_event(item.get("criada_em"), "cobertura", "Movimentação preparada", route))
            received = item.get("recebimento")
            if isinstance(received, Mapping) and received.get("data"):
                events.append(_event(received["data"], "cobertura", "Movimentação recebida", _city(item.get("destino_cidade"))))
            if item.get("estado") == "cancelada" and item.get("fechado_em"):
                events.append(_event(item["fechado_em"], "cobertura", "Movimentação cancelada", route))
    return events


def _when(value: Any) -> Optional[Tuple[datetime, bool]]:
    """Aware local datetime and "date only" flag; unreadable or blank gives ``None``."""
    text = str(value or "").strip()
    try:
        if _DAY.fullmatch(text):
            return datetime.combine(date.fromisoformat(text), time(23, 59, 59)).astimezone(), True
        return datetime.fromisoformat(text).astimezone(), False
    except ValueError:
        return None


def build_timeline(sources: Mapping[str, Optional[List[Event]]], limit: int = TIMELINE_LIMIT) -> Dict[str, Any]:
    """``sources`` maps each kind to its events, or ``None`` when that source failed (goes to ``indisponiveis``)."""
    dated: List[Tuple[datetime, bool, Dict[str, Any]]] = []
    for kind in TIMELINE_KINDS:
        for raw, event in sources.get(kind) or ():
            parsed = _when(raw)
            if parsed:
                dated.append((parsed[0], parsed[1], event))
    dated.sort(key=lambda item: item[0], reverse=True)  # reverse keeps the order of ties
    return {
        "eventos": [{"quando": when.isoformat(), "so_data": only_day, **event} for when, only_day, event in dated[:limit]],
        "total": len(dated),
        "limite": limit,
        "indisponiveis": [kind for kind in TIMELINE_KINDS if sources.get(kind, ()) is None],
    }
