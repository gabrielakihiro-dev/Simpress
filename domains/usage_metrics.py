"""Local usage counters: daily totals of the tasks the application performs.

Only dates, integer counts and the manual minutes the user configures are stored.
Serials, hostnames, search terms and file names never reach the file.
"""

from collections import OrderedDict
from dataclasses import dataclass
from datetime import date, timedelta
import json
import logging
from pathlib import Path
import threading
import time
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple
from urllib.parse import parse_qs

from anyio import to_thread

from core.integrity import AtomicFileTransaction, FileBusyError, FileTransactionError

logger = logging.getLogger(__name__)

METRICS = ("transferencias", "comparacoes", "exportacoes", "os_conciliadas", "buscas")
SUMMARY_DAYS = 30
RETENTION_DAYS = 730
MAX_MANUAL_MINUTES = 480
SEARCH_SESSION_SECONDS = 30.0
_SEEN_COMPARISONS_LIMIT = 256

# (method, path, metric) counted by the middleware when the response is 2xx.
HTTP_METRIC_ROUTES: Tuple[Tuple[str, str, str], ...] = (
    ("POST", "/api/gerar-planilha", "transferencias"),
    ("GET", "/api/exportar-equipamentos", "exportacoes"),
    ("GET", "/api/historico-comparacoes/exportar/excel", "exportacoes"),
    ("GET", "/api/operacoes/chamados/exportar", "exportacoes"),
    ("GET", "/api/relatorio-mensal", "exportacoes"),
    ("GET", "/api/buscar", "buscas"),
    ("GET", "/api/buscar-expandida", "buscas"),
)


class UsageMetricsCorruptionError(ValueError):
    """The metrics file exists but is not trusted, so it is never overwritten."""


class InvalidManualMinutesError(ValueError):
    """The configured minutes are outside the accepted range."""


def _empty_store() -> Dict[str, Any]:
    return {"versao": 1, "dias": {}, "tempos_minutos": {metric: None for metric in METRICS}}


def _count(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0


def _minutes(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if 0 <= value <= MAX_MANUAL_MINUTES else None


def _validated_store(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict) or not isinstance(value.get("dias", {}), dict):
        raise UsageMetricsCorruptionError("O arquivo de métricas de uso está inválido; ele foi preservado.")
    days: Dict[str, Dict[str, int]] = {}
    for key, counts in value.get("dias", {}).items():
        try:
            date.fromisoformat(key)
        except (TypeError, ValueError):
            continue
        if isinstance(counts, dict):
            days[key] = {metric: _count(counts.get(metric)) for metric in METRICS if _count(counts.get(metric))}
    raw_minutes = value.get("tempos_minutos")
    minutes = raw_minutes if isinstance(raw_minutes, dict) else {}
    return {
        "versao": 1,
        "dias": days,
        "tempos_minutos": {metric: _minutes(minutes.get(metric)) for metric in METRICS},
    }


def validate_manual_minutes(value: Any) -> Dict[str, Optional[float]]:
    """Accept null or a number from 0 to 480 per metric; unknown keys are rejected."""
    if not isinstance(value, Mapping):
        raise InvalidManualMinutesError("Informe os tempos por tarefa.")
    unknown = sorted(set(value) - set(METRICS))
    if unknown:
        raise InvalidManualMinutesError(f"Tarefa desconhecida: {', '.join(unknown)}.")
    result: Dict[str, Optional[float]] = {}
    for metric in METRICS:
        raw = value.get(metric)
        if raw is None:
            result[metric] = None
            continue
        minutes = _minutes(raw)
        if minutes is None:
            raise InvalidManualMinutesError(f"O tempo de '{metric}' deve ficar entre 0 e {MAX_MANUAL_MINUTES} minutos.")
        result[metric] = round(minutes, 1)
    return result


def summarize(store: Mapping[str, Any], today: date, days: int = SUMMARY_DAYS) -> Dict[str, Any]:
    """Aggregate the window of `days` days that ends today (inclusive)."""
    validated = _validated_store(store)
    start = today - timedelta(days=days - 1)
    per_day: List[Dict[str, Any]] = []
    totals = {metric: 0 for metric in METRICS}
    for offset in range(days):
        current = start + timedelta(days=offset)
        counts = validated["dias"].get(current.isoformat(), {})
        row: Dict[str, Any] = {"data": current.isoformat()}
        for metric in METRICS:
            row[metric] = counts.get(metric, 0)
            totals[metric] += row[metric]
        per_day.append(row)
    minutes = validated["tempos_minutos"]
    configured = {metric: value for metric, value in minutes.items() if value is not None}
    saved_minutes = sum(totals[metric] * value for metric, value in configured.items())
    recorded = sorted(validated["dias"])
    return {
        "periodo": {"inicio": start.isoformat(), "fim": today.isoformat(), "dias": days},
        "totais": totals,
        "por_dia": per_day,
        "registro_desde": recorded[0] if recorded else None,
        "tempos_minutos": minutes,
        "tempos_configurados": bool(configured),
        "minutos_economizados": round(saved_minutes, 1),
        "horas_economizadas": round(saved_minutes / 60, 1),
        "disponivel": True,
    }


def _normalized_term(value: Any) -> str:
    return " ".join(str(value or "").split()).casefold()


class SearchSessionTracker:
    """Folds autocomplete keystrokes and filter changes of one search into a single count (memory only)."""

    def __init__(self, window_seconds: float = SEARCH_SESSION_SECONDS, clock: Callable[[], float] = time.monotonic):
        self._window = window_seconds
        self._clock = clock
        self._last_term = ""
        self._last_at = float("-inf")
        self._lock = threading.Lock()

    def is_new_search(self, term: Any) -> bool:
        normalized = _normalized_term(term)
        if not normalized:
            return False
        now = self._clock()
        with self._lock:
            continuing = (
                now - self._last_at <= self._window
                and (normalized.startswith(self._last_term) or self._last_term.startswith(normalized))
            )
            self._last_term = normalized
            self._last_at = now
        return not continuing


class UsageMetricsStore:
    def __init__(
        self,
        path: Callable[[], Path],
        transaction_root: Callable[[], Path],
        today: Callable[[], date] = date.today,
    ):
        self._path = path
        self._transaction_root = transaction_root
        self._today = today
        self._lock = threading.Lock()
        self._seen_comparisons: "OrderedDict[str, None]" = OrderedDict()
        self.searches = SearchSessionTracker()

    def _update(self, updater: Callable[[Dict[str, Any]], Dict[str, Any]]) -> Dict[str, Any]:
        path = self._path()
        with self._lock:
            with AtomicFileTransaction(self._transaction_root(), [path]) as transaction:
                updated = transaction.update_json(path, lambda current: updater(_validated_store(current)), _empty_store())
                transaction.commit()
        return updated

    def increment(self, metric: str, amount: int = 1) -> None:
        """Add to today's counter; raises on storage errors (see `record`)."""
        if metric not in METRICS:
            raise ValueError(f"Métrica desconhecida: {metric}")
        if amount <= 0:
            return
        day = self._today()
        cutoff = (day - timedelta(days=RETENTION_DAYS - 1)).isoformat()

        def add(store: Dict[str, Any]) -> Dict[str, Any]:
            days = {key: counts for key, counts in store["dias"].items() if key >= cutoff}
            counts = dict(days.get(day.isoformat(), {}))
            counts[metric] = counts.get(metric, 0) + int(amount)
            days[day.isoformat()] = counts
            return {**store, "dias": dict(sorted(days.items()))}

        self._update(add)

    def record(self, metric: str, amount: int = 1) -> bool:
        """Best effort: a metric failure is logged and never breaks the user's operation."""
        try:
            self.increment(metric, amount)
            return True
        except (FileBusyError, FileTransactionError, UsageMetricsCorruptionError, OSError) as error:
            logger.warning("Métrica de uso não registrada (métrica=%s, erro=%s).", metric, type(error).__name__)
        except Exception:
            logger.exception("Falha inesperada ao registrar a métrica de uso %s.", metric)
        return False

    def record_comparison(self, result: Any) -> bool:
        """Count a confirmed inventory update once per comparison event, even when replayed."""
        comparison = result.get("comparacao") if isinstance(result, dict) else None
        event_id = str(comparison.get("evento_id") or "") if isinstance(comparison, dict) else ""
        if event_id:
            with self._lock:
                if event_id in self._seen_comparisons:
                    return False
                self._seen_comparisons[event_id] = None
                while len(self._seen_comparisons) > _SEEN_COMPARISONS_LIMIT:
                    self._seen_comparisons.popitem(last=False)
        return self.record("comparacoes")

    def record_ticket_reconciliation(self, report: Any) -> bool:
        summary = report.get("resumo") if isinstance(report, dict) else None
        total = _count(summary.get("series_total")) if isinstance(summary, dict) else 0
        return self.record("os_conciliadas", total) if total else False

    def read(self) -> Dict[str, Any]:
        path = self._path()
        if not path.exists():
            return _empty_store()
        return _validated_store(json.loads(path.read_text(encoding="utf-8")))

    def summary(self, days: int = SUMMARY_DAYS) -> Dict[str, Any]:
        try:
            store = self.read()
        except (OSError, ValueError) as error:
            logger.warning("Métricas de uso ilegíveis (erro=%s).", type(error).__name__)
            unavailable = summarize(_empty_store(), self._today(), days)
            unavailable["disponivel"] = False
            return unavailable
        return summarize(store, self._today(), days)

    def set_manual_minutes(self, value: Any) -> Dict[str, Any]:
        minutes = validate_manual_minutes(value)
        self._update(lambda store: {**store, "tempos_minutos": minutes})
        return self.summary()


@dataclass(frozen=True)
class _MatchedRequest:
    metric: str
    term: Optional[str]


def _match_request(scope: Mapping[str, Any]) -> Optional[_MatchedRequest]:
    method = scope.get("method")
    path = scope.get("path")
    metric = next((name for verb, route, name in HTTP_METRIC_ROUTES if verb == method and route == path), None)
    if metric is None:
        return None
    if metric != "buscas":
        return _MatchedRequest(metric, None)
    query = parse_qs(scope.get("query_string", b"").decode("latin-1"))
    if query.get("offset", ["0"])[0] not in ("", "0"):
        return None  # "Carregar mais" continues a search already counted.
    return _MatchedRequest(metric, query.get("q", [""])[0])


class UsageMetricsMiddleware:
    """Count successful HTTP tasks after the response was sent, without touching the response."""

    def __init__(self, app: Any, store: UsageMetricsStore):
        self.app = app
        self.store = store

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        matched = _match_request(scope) if scope.get("type") == "http" else None
        if matched is None:
            await self.app(scope, receive, send)
            return
        status = {"code": 0}

        async def capture(message: Any) -> None:
            if message.get("type") == "http.response.start":
                status["code"] = int(message.get("status") or 0)
            await send(message)

        await self.app(scope, receive, capture)
        if not 200 <= status["code"] < 300:
            return
        if matched.term is not None and not self.store.searches.is_new_search(matched.term):
            return
        await to_thread.run_sync(self.store.record, matched.metric)
