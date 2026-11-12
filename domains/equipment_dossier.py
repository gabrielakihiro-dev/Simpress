"""Equipment dossier (Home F1): the OS section, read only, from the imported ticket report.

Pure functions. The history kept by the importer is per series, not per OS. Only whitelisted fields leave here:
never the OS description, user, name, e-mail or phone, and never the timeline annotations (free text).
Doc: ``docs/cockpit-prompts/03-home-split-view.md``, section "Dossiê do equipamento".
"""

from __future__ import annotations

import re
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence

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
