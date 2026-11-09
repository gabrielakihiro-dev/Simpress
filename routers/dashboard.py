"""Read-only summary used by the Home dashboard panel."""

import logging
import threading
from collections import Counter
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from fastapi import APIRouter

from domains.history_insights import PENDING_CATEGORIES, PINNED_BASELINE_ID, compare_updates
from domains.inventory_comparison import (
    filter_curitiba_hostname_location_mismatches,
    filter_sebrae_owned_unmatched_items,
)
from domains.ticket_reporting import normalize_ticket_snapshot, ticket_attention

logger = logging.getLogger(__name__)

ATTENTION_FIELDS = (
    ("divergencias_local", "Divergências com a base local"),
    ("sem_acesso_7_dias", "Sem acesso há 7 dias"),
    ("ausentes_no_endpoint", "Ausentes no endpoint (somente Notebooks e MacBooks)"),
    ("ausentes_em_detalhes", "Ausentes nos detalhes"),
    ("divergencias_apelidos_manuais", "Apelidos manuais divergentes"),
    ("correspondencias_ambiguas", "Correspondências ambíguas"),
    ("series_sem_mapeamento", "Séries sem mapeamento"),
)
TOP_CITIES = None  # lista todas as cidades; o painel limita a altura com rolagem
ENDPOINT_ABSENCE_CATEGORIES = frozenset({"notebook", "macbook"})
DEFAULT_STALE_BASE_DAYS = 7
DEFAULT_STALE_TICKET_DAYS = 7
DEFAULT_LONG_UNUSED_WARNING_DAYS = 55
DEFAULT_LONG_UNUSED_DAYS = 60
# A base file modified this long after the newest history event was replaced outside the import flow.
OUT_OF_FLOW_TOLERANCE = timedelta(minutes=10)


def _local_now() -> datetime:
    return datetime.now().astimezone()


@dataclass(frozen=True)
class DashboardServices:
    get_equipment: Callable[[], Sequence[Dict[str, Any]]]
    get_stats: Callable[[], Dict[str, Any]]
    get_comparison_events: Callable[[], Sequence[Dict[str, Any]]]
    categories: Sequence[Dict[str, str]]
    categorize: Callable[[Any, Any], str]
    # Stale base alert (docs/operacao/alerta-base-desatualizada.md); optional so the summary can still load.
    get_comparison_history: Optional[Callable[[], Sequence[Dict[str, Any]]]] = None
    get_details_file: Optional[Callable[[], Optional[Path]]] = None
    stale_base_days: int = DEFAULT_STALE_BASE_DAYS
    # Stale tickets and new divergences alerts (docs/operacao/alertas-os-divergencias.md).
    get_ticket_report: Optional[Callable[[], Optional[Dict[str, Any]]]] = None
    stale_ticket_days: int = DEFAULT_STALE_TICKET_DAYS
    display_comparison: Optional[Callable[[Dict[str, Any]], Dict[str, Any]]] = None
    # Notebooks/MacBooks near (warning) or past (limit) the days without Endpoint access that make the Endpoint drop them.
    long_unused_warning_days: int = DEFAULT_LONG_UNUSED_WARNING_DAYS
    long_unused_days: int = DEFAULT_LONG_UNUSED_DAYS
    now: Callable[[], datetime] = field(default=_local_now)
    # Stat identity of the history file; when given, the new divergences alert is reused while it matches.
    get_comparison_history_signature: Optional[Callable[[], Optional[tuple]]] = None
    # Tickets marked as finalized by another technician and not yet checked (marks of OS finalizada, aba OS).
    get_other_technician_marks: Optional[Callable[[], Sequence[Dict[str, Any]]]] = None


# Reapplying the display rules to the two newest events dominated the panel time; the result
# depends only on the history content, so it is kept per history file signature.
_NEW_DIVERGENCES_CACHE: Optional[Tuple[tuple, Dict[str, Any]]] = None
_NEW_DIVERGENCES_CACHE_LOCK = threading.Lock()


def _count(value: Any) -> int:
    try:
        return max(int(value), 0)
    except (TypeError, ValueError):
        return 0


def _endpoint_absences_in_scope(items: Sequence[Any], category_by_serial: Dict[str, str]) -> int:
    """Count endpoint absences whose serial belongs to notebooks or MacBooks in the base."""
    total = 0
    for item in items:
        if not isinstance(item, dict):
            continue
        serials = str(item.get("serie") or "").split(" / ")
        if any(category_by_serial.get(serial.strip().upper()) in ENDPOINT_ABSENCE_CATEGORIES for serial in serials):
            total += 1
    return total


def build_dashboard(services: DashboardServices) -> Dict[str, Any]:
    equipment = list(services.get_equipment())
    by_category: Counter = Counter()
    by_city: Counter = Counter()
    by_city_category: Dict[str, Counter] = {}
    category_by_serial: Dict[str, str] = {}
    without_city = 0
    for item in equipment:
        if not isinstance(item, dict):
            continue
        category = services.categorize(item.get("tipo"), item.get("modelo"))
        by_category[category] += 1
        serial = str(item.get("serial") or "").strip().upper()
        if serial:
            category_by_serial[serial] = category
        city = str(item.get("retirada_cidade") or "").strip()
        if city:
            by_city[city] += 1
            if category:
                by_city_category.setdefault(category, Counter())[city] += 1
        else:
            without_city += 1
    categories: List[Dict[str, Any]] = [
        {"value": entry["value"], "label": entry["label"], "total": by_category.get(entry["value"], 0)}
        for entry in services.categories
    ]
    def top_cities(counter: Counter) -> List[Dict[str, Any]]:
        ranked_cities = sorted(counter.items(), key=lambda pair: (-pair[1], pair[0].casefold()))
        return [{"cidade": city, "total": total} for city, total in ranked_cities[:TOP_CITIES]]

    cities_by_category = {
        entry["value"]: top_cities(by_city_category.get(entry["value"], Counter()))
        for entry in services.categories
    }
    stats = services.get_stats() or {}

    latest = None
    try:
        events = list(services.get_comparison_events())
    except Exception:
        logger.exception("Falha ao ler os eventos de comparação do painel; exibindo sem a última comparação.")
        events = []
    if events and isinstance(events[0], dict):
        event = events[0]
        summary_value: Any = event.get("resumo")
        summary: Dict[str, Any] = summary_value if isinstance(summary_value, dict) else {}
        details_value: Any = event.get("comparacao")
        details: Dict[str, Any] = details_value if isinstance(details_value, dict) else {}
        absences_value: Any = details.get("ausentes_no_endpoint")
        totals = {field: _count(summary.get(field)) for field, _ in ATTENTION_FIELDS}
        # Without the detailed list the notebook/MacBook scope cannot be applied, so the row is omitted.
        totals["ausentes_no_endpoint"] = (
            _endpoint_absences_in_scope(absences_value, category_by_serial) if isinstance(absences_value, list) else 0
        )
        latest = {
            "id": event.get("id"),
            "horario": event.get("horario"),
            "tipo": event.get("tipo"),
            "atencao": [
                {"campo": field, "rotulo": label, "total": totals[field]}
                for field, label in ATTENTION_FIELDS
                if totals[field] > 0
            ],
        }

    history_signature = _history_signature(services)
    history = _comparison_history(services)
    return {
        "base_importada": len(equipment) > 0,
        "total_equipamentos": len(equipment),
        "total_unidades": _count(stats.get("total_unidades")),
        "por_categoria": categories,
        "sem_categoria": by_category.get("", 0),
        "cidades_principais": top_cities(by_city),
        "cidades_por_categoria": cities_by_category,
        "total_cidades": len(by_city),
        "sem_cidade": without_city,
        "ultima_atualizacao": stats.get("ultima_atualizacao") or "",
        "arquivo_origem": stats.get("arquivo_origem") or "",
        "ultima_comparacao": latest,
        "base_desatualizada": _stale_base_summary(services, history),
        "os_paradas": _stale_tickets_summary(services),
        "chamados_outro_tecnico": _other_technician_summary(services),
        "divergencias_novas": _new_divergences_summary(services, history, history_signature),
        "sem_acesso_60_dias": _long_unused_summary(services, history),
    }


def _parse_event_time(value: Any) -> Optional[datetime]:
    try:
        parsed = datetime.fromisoformat(str(value or "").strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    # History times carry an offset; a naive value is read as local time.
    return parsed if parsed.tzinfo is not None else parsed.astimezone()


def _is_restoration(event: Dict[str, Any]) -> bool:
    comparison = event.get("comparacao")
    return event.get("tipo") == "restauracao" or (
        isinstance(comparison, dict) and comparison.get("tipo_operacao") == "restauracao"
    )


def _restored_event_id(event: Dict[str, Any]) -> str:
    comparison = event.get("comparacao")
    source = event.get("restauracao_de")
    if not isinstance(source, dict) and isinstance(comparison, dict):
        source = comparison.get("restauracao_de")
    return str(source.get("evento_id") or "") if isinstance(source, dict) else ""


def base_date_from_history(history: Sequence[Any]) -> Tuple[Optional[datetime], Optional[datetime]]:
    """Return (date of the active base content, time of the newest event) from the comparison history.

    An update makes the base as new as the event. A restoration brings back the files that were
    active before the restored event (its backup), so the base takes the date it had at that point;
    when that predates the available history, the restored event time is the newest possible bound.
    """
    events: List[Tuple[datetime, Dict[str, Any]]] = []
    for event in history:
        if isinstance(event, dict) and (moment := _parse_event_time(event.get("horario"))) is not None:
            events.append((moment, event))
    events.sort(key=lambda pair: pair[0])
    event_times = {str(event.get("id") or ""): moment for moment, event in events}
    content_date: Optional[datetime] = None
    content_before: Dict[str, Optional[datetime]] = {}
    for moment, event in events:
        event_id = str(event.get("id") or "")
        if event_id:
            content_before[event_id] = content_date
        if _is_restoration(event):
            source_id = _restored_event_id(event)
            content_date = content_before.get(source_id) or event_times.get(source_id) or moment
        else:
            content_date = moment
    return content_date, (events[-1][0] if events else None)


def stale_base_status(
    history: Sequence[Any],
    details_file: Optional[Path],
    now: datetime,
    limit_days: int = DEFAULT_STALE_BASE_DAYS,
) -> Dict[str, Any]:
    """Decide whether the official EquipamentosDetalhes base is older than ``limit_days``."""
    result: Dict[str, Any] = {
        "estado": "sem_base",
        "limite_dias": limit_days,
        "dias_sem_atualizacao": None,
        "ultima_atualizacao": "",
        "origem_data": "",
    }
    if details_file is None or not details_file.is_file():
        return result
    file_time = datetime.fromtimestamp(details_file.stat().st_mtime).astimezone()
    base_date, newest_event = base_date_from_history(history)
    source = "historico"
    # The file date is the last resort: no usable history, or the file was replaced outside the flow.
    if base_date is None or newest_event is None or file_time > newest_event + OUT_OF_FLOW_TOLERANCE:
        base_date, source = file_time, "arquivo"
    age = now - base_date
    result.update({
        "estado": "desatualizada" if age > timedelta(days=limit_days) else "atualizada",
        "dias_sem_atualizacao": max(age.days, 0),
        "ultima_atualizacao": base_date.isoformat(timespec="seconds"),
        "origem_data": source,
    })
    return result


def _comparison_history(services: DashboardServices) -> Optional[Sequence[Any]]:
    """Read the comparison history once per panel; ``None`` when it is missing or unreadable."""
    if services.get_comparison_history is None:
        return None
    try:
        return services.get_comparison_history()
    except Exception:
        logger.exception("Falha ao ler o histórico de comparações do painel.")
        return None


def _stale_base_summary(services: DashboardServices, history: Optional[Sequence[Any]]) -> Optional[Dict[str, Any]]:
    if services.get_details_file is None:
        return None
    try:
        # An unreadable history falls back to the file date.
        return stale_base_status(history or [], services.get_details_file(), services.now(), services.stale_base_days)
    except Exception:
        # The alert is optional; the inventory summary must still load.
        logger.exception("Falha ao calcular o alerta de base desatualizada.")
        return {
            "estado": "indisponivel",
            "limite_dias": services.stale_base_days,
            "dias_sem_atualizacao": None,
            "ultima_atualizacao": "",
            "origem_data": "",
        }


def stale_tickets_status(
    report: Optional[Dict[str, Any]],
    today: date,
    limit_days: int = DEFAULT_STALE_TICKET_DAYS,
) -> Dict[str, Any]:
    """Count open tickets of the current OS import whose newest Oracle update is ``limit_days`` or older."""
    result: Dict[str, Any] = {
        "estado": "sem_dados",
        "limite_dias": limit_days,
        "total": 0,
        "maior_dias_sem_atualizacao": None,
        "importado_em": "",
    }
    tickets_value: Any = report.get("chamados") if isinstance(report, dict) else None
    if not isinstance(report, dict) or not isinstance(tickets_value, list) or not tickets_value:
        return result
    tickets = normalize_ticket_snapshot({"chamados": tickets_value})["chamados"]
    ages: List[int] = []
    for ticket in tickets:
        if not isinstance(ticket, dict):
            continue
        # Same open/closed and date rules as the ticket tracking screen; undated tickets are not counted.
        age = ticket_attention(ticket, stale_days=limit_days, today=today)["dias_sem_atualizacao"]
        if isinstance(age, int) and age >= limit_days:
            ages.append(age)
    result.update({
        "estado": "paradas" if ages else "em_dia",
        "total": len(ages),
        "maior_dias_sem_atualizacao": max(ages) if ages else None,
        "importado_em": str(report.get("atualizado_em") or ""),
    })
    return result


def _stale_tickets_summary(services: DashboardServices) -> Optional[Dict[str, Any]]:
    if services.get_ticket_report is None:
        return None
    try:
        return stale_tickets_status(services.get_ticket_report(), services.now().date(), services.stale_ticket_days)
    except Exception:
        # The alert is optional; the inventory summary must still load.
        logger.exception("Falha ao calcular o alerta de OS paradas.")
        return {
            "estado": "indisponivel",
            "limite_dias": services.stale_ticket_days,
            "total": 0,
            "maior_dias_sem_atualizacao": None,
            "importado_em": "",
        }


def _other_technician_summary(services: DashboardServices) -> Dict[str, Any]:
    if services.get_other_technician_marks is None:
        return {"total": 0, "itens": []}
    try:
        itens = [
            {
                "chamado": str(item.get("chamado") or ""),
                "serie": str(item.get("serie") or ""),
                "os": str(item.get("os") or ""),
                "motivo": str(item.get("motivo") or ""),
            }
            for item in services.get_other_technician_marks()
        ]
        return {"total": len(itens), "itens": itens}
    except Exception as error:
        # The alert is optional; the inventory summary must still load. Only the class is logged (no ticket data).
        logger.warning("Falha ao calcular o aviso de chamados finalizados por outro técnico: %s.", type(error).__name__)
        return {"total": 0, "itens": [], "indisponivel": True}


def _without_owner_exceptions(event: Dict[str, Any]) -> Dict[str, Any]:
    """Reapply the Sebrae and Curitiba PRNOTE rules on top of the display view, as the monthly report does."""
    comparison = event.get("comparacao")
    if not isinstance(comparison, dict):
        return event
    filtered = dict(comparison)
    for key in ("ausentes_no_endpoint", "ausentes_em_detalhes"):
        if isinstance(comparison.get(key), list):
            filtered[key] = filter_sebrae_owned_unmatched_items(comparison[key])
    if isinstance(comparison.get("divergencias_local"), list):
        filtered["divergencias_local"] = filter_curitiba_hostname_location_mismatches(comparison["divergencias_local"])
    return {**event, "comparacao": filtered}


def new_divergences_status(
    history: Sequence[Any],
    display: Callable[[Dict[str, Any]], Dict[str, Any]],
) -> Dict[str, Any]:
    """Divergence rows of the newest inventory update that were not in the previous one."""
    result: Dict[str, Any] = {"estado": "sem_comparacao", "total": 0, "por_secao": [], "anterior": None, "atual": None}
    updates: List[Tuple[datetime, Dict[str, Any]]] = []
    for event in history:
        if not isinstance(event, dict) or _is_restoration(event) or event.get("id") == PINNED_BASELINE_ID:
            continue
        moment = _parse_event_time(event.get("horario"))
        if moment is not None:
            updates.append((moment, event))
    if len(updates) < 2:
        return result
    updates.sort(key=lambda pair: pair[0])
    previous, current = (_without_owner_exceptions(display(event)) for _, event in updates[-2:])
    new_rows = compare_updates(previous, current)["mudancas"]["novos"]
    by_section: Counter = Counter(str(row.get("secao") or "") for row in new_rows)
    # Sections follow the history order; two categories share the ambiguity section.
    sections = list(dict.fromkeys(PENDING_CATEGORIES.values()))
    result.update({
        "estado": "novas" if new_rows else "sem_novas",
        "total": len(new_rows),
        "por_secao": [{"secao": section, "total": by_section[section]} for section in sections if by_section[section]],
        "anterior": {"id": previous.get("id"), "horario": previous.get("horario")},
        "atual": {"id": current.get("id"), "horario": current.get("horario")},
    })
    return result


def _history_signature(services: DashboardServices) -> Optional[tuple]:
    if services.get_comparison_history_signature is None:
        return None
    try:
        return services.get_comparison_history_signature()
    except Exception:
        return None


def _new_divergences_summary(
    services: DashboardServices,
    history: Optional[Sequence[Any]],
    signature: Optional[tuple] = None,
) -> Optional[Dict[str, Any]]:
    global _NEW_DIVERGENCES_CACHE
    if services.get_comparison_history is None or services.display_comparison is None:
        return None
    unavailable: Dict[str, Any] = {"estado": "indisponivel", "total": 0, "por_secao": [], "anterior": None, "atual": None}
    if history is None:
        return unavailable
    with _NEW_DIVERGENCES_CACHE_LOCK:
        cached = _NEW_DIVERGENCES_CACHE
    if signature is not None and cached is not None and cached[0] == signature:
        return deepcopy(cached[1])
    try:
        result = new_divergences_status(history, services.display_comparison)
    except Exception:
        # The alert is optional; the inventory summary must still load.
        logger.exception("Falha ao calcular o alerta de divergências novas.")
        return unavailable
    # The history read between the two stats may be a half-written file; cache only a stable one.
    if signature is not None and signature == _history_signature(services):
        with _NEW_DIVERGENCES_CACHE_LOCK:
            _NEW_DIVERGENCES_CACHE = (signature, deepcopy(result))
    return result


def _serial_keys(value: Any) -> set:
    # A MacBook serial is the Endpoint one with a leading S in EquipamentosDetalhes; compare without it.
    keys = set()
    for part in str(value or "").split(" / "):
        key = part.strip().upper()
        if key:
            keys.add(key[1:] if len(key) > 1 and key.startswith("S") else key)
    return keys


def _dict_rows(comparison: Any, field_name: str) -> List[Dict[str, Any]]:
    rows = comparison.get(field_name) if isinstance(comparison, dict) else None
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def _absent_serial_keys(comparison: Any) -> set:
    rows = comparison.get("ausentes_no_endpoint") if isinstance(comparison, dict) else None
    return set().union(*(
        _serial_keys(row.get("serie"))
        for row in filter_sebrae_owned_unmatched_items(rows)
        if isinstance(row, dict)
    ))


def long_unused_status(
    history: Sequence[Any],
    warning_days: int = DEFAULT_LONG_UNUSED_WARNING_DAYS,
    limit_days: int = DEFAULT_LONG_UNUSED_DAYS,
    event_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Notebooks/MacBooks of the newest update that are near or past ``limit_days`` without Endpoint access.

    Past the limit the Endpoint drops the row, so the notebook leaves "Sem acesso há 7 dias ou mais" and
    reappears under "Ausentes no endpoint". Such a move counts as past the limit when the days of its last
    7+ row plus the days since that update reach the limit, as long as it stayed absent in every update since.
    With ``event_id`` the update with that id plays the newest one (later updates are ignored).
    """
    result: Dict[str, Any] = {
        "estado": "sem_dados",
        "limite_aviso_dias": warning_days,
        "limite_dias": limit_days,
        "total_limite": 0,
        "total_passou": 0,
        "total_saiu_endpoint": 0,
        "maior_dias": None,
        "horario": "",
        "equipamentos": [],
    }
    updates: List[Tuple[datetime, Dict[str, Any]]] = []
    for event in history:
        if not isinstance(event, dict) or _is_restoration(event) or event.get("id") == PINNED_BASELINE_ID:
            continue
        moment = _parse_event_time(event.get("horario"))
        if moment is not None:
            updates.append((moment, event))
    if event_id is not None:
        selected = next((moment for moment, event in updates if event.get("id") == event_id), None)
        updates = [] if selected is None else [
            pair for pair in updates if pair[0] < selected or pair[1].get("id") == event_id
        ]
    if not updates:
        return result
    # Stable sort with the selected event last among equal moments.
    updates.sort(key=lambda pair: (pair[0], pair[1].get("id") == event_id))
    current_moment, current = updates[-1]
    comparison = current.get("comparacao")
    if not isinstance(comparison, dict):
        return result
    stale = _dict_rows(comparison, "sem_acesso_7_dias")
    equipment: List[Dict[str, Any]] = []
    for row in stale:
        age = _count(row.get("dias_sem_verificacao"))
        if age > warning_days:
            equipment.append({
                "serie": str(row.get("serie") or ""),
                "computador": str(row.get("computador") or ""),
                "dias": age,
                "situacao": "passou" if age >= limit_days else "limite",
            })
    left_endpoint = 0
    still_stale = set().union(*(_serial_keys(row.get("serie")) for row in stale))
    # Absent now and not stale now: candidates that may have left the 7+ list in an older update.
    candidates = _absent_serial_keys(comparison) - still_stale
    for previous_moment, previous in reversed(updates[:-1]):
        if not candidates:
            break
        previous_comparison = previous.get("comparacao")
        elapsed = max((current_moment - previous_moment).days, 0)
        for row in _dict_rows(previous_comparison, "sem_acesso_7_dias"):
            keys = _serial_keys(row.get("serie"))
            if not keys & candidates:
                continue
            # The newest 7+ row of a notebook wins; older rows of the same notebook are ignored.
            candidates -= keys
            days = _count(row.get("dias_sem_verificacao")) + elapsed
            if days >= limit_days:
                left_endpoint += 1
                # "dias" here is an estimate: days at that update plus the days since it.
                equipment.append({
                    "serie": str(row.get("serie") or ""),
                    "computador": str(row.get("computador") or ""),
                    "dias": days,
                    "situacao": "saiu_endpoint",
                })
        # Looking further back only counts notebooks that stayed absent in every update since.
        candidates &= _absent_serial_keys(previous_comparison)
    equipment.sort(key=lambda item: -item["dias"])
    total_limite = sum(item["situacao"] == "limite" for item in equipment)
    total_passou = sum(item["situacao"] in ("passou", "saiu_endpoint") for item in equipment)
    # "saiu_endpoint" days are an estimate, so they do not count towards the largest age.
    flagged = [item["dias"] for item in equipment if item["situacao"] != "saiu_endpoint"]
    result.update({
        "estado": "passou_60" if total_passou else "limite_55" if total_limite else "em_dia",
        "total_limite": total_limite,
        "total_passou": total_passou,
        "total_saiu_endpoint": left_endpoint,
        "maior_dias": max(flagged) if flagged else None,
        "horario": str(current.get("horario") or ""),
        "equipamentos": equipment,
    })
    return result


def _long_unused_summary(services: DashboardServices, history: Optional[Sequence[Any]]) -> Optional[Dict[str, Any]]:
    if services.get_comparison_history is None:
        return None
    unavailable = {
        **long_unused_status([], services.long_unused_warning_days, services.long_unused_days),
        "estado": "indisponivel",
    }
    if history is None:
        return unavailable
    try:
        return long_unused_status(history, services.long_unused_warning_days, services.long_unused_days)
    except Exception:
        # The alert is optional; the inventory summary must still load.
        logger.exception("Falha ao calcular o alerta de notebooks sem acesso há 60 dias.")
        return unavailable


@dataclass(frozen=True)
class DashboardRouteExports:
    """Routes exposed to ``main`` for direct calls in tests and helpers."""

    obter_painel: Callable[..., Any]


def create_dashboard_router(services: DashboardServices) -> Tuple[APIRouter, DashboardRouteExports]:
    router = APIRouter()

    @router.get("/api/painel")
    def obter_painel():
        """Resumo somente leitura da base para a página inicial."""
        return build_dashboard(services)

    return router, DashboardRouteExports(
        obter_painel=obter_painel,
    )
