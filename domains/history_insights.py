"""Read-only views that turn saved comparisons into actionable history."""

import json
import re
import unicodedata
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional


PENDING_CATEGORIES = {
    "apelidos_sem_atualizacao": "Linhas mantidas para conferência",
    "sem_acesso_14_dias": "Sem acesso há 14 dias ou mais",
    "ausentes_no_endpoint": "Equipamentos sem correspondência por fonte — Endpoint",
    "ausentes_em_detalhes": "Equipamentos sem correspondência por fonte — Simpress",
    "divergencias_local": "Localidade divergente",
    "correspondencias_ambiguas": "Duplicidades e correspondências ambíguas",
    "registros_ambiguos": "Duplicidades e correspondências ambíguas",
    "series_sem_mapeamento": "Séries sem local definido",
}
PINNED_BASELINE_ID = "e1f66787b2aa49a0bdbc848521ca1fc4"

def normalize_identifier(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or "").strip().upper())
    text = "".join(character for character in text if not unicodedata.combining(character))
    return re.sub(r"[^A-Z0-9]", "", text)


def is_restoration(event: Dict[str, Any]) -> bool:
    comparison = event.get("comparacao")
    return event.get("tipo") == "restauracao" or (
        isinstance(comparison, dict) and comparison.get("tipo_operacao") == "restauracao"
    )


def latest_update(history: Iterable[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    candidates = [
        event for event in history
        if isinstance(event, dict)
        and not is_restoration(event)
        and event.get("id") != PINNED_BASELINE_ID
    ]
    def event_timestamp(event: Dict[str, Any]) -> float:
        try:
            value = datetime.fromisoformat(str(event.get("horario") or "").replace("Z", "+00:00"))
            if value.tzinfo is None:
                value = value.replace(tzinfo=timezone.utc)
            return value.timestamp()
        except (TypeError, ValueError, OverflowError):
            return float("-inf")
    return max(candidates, key=event_timestamp, default=None)


def pending_rows(event: Dict[str, Any]) -> List[Dict[str, Any]]:
    comparison = event.get("comparacao")
    if not isinstance(comparison, dict):
        return []
    rows = []
    for category, label in PENDING_CATEGORIES.items():
        items = comparison.get(category)
        if not isinstance(items, list):
            continue
        for item in items:
            if isinstance(item, dict):
                rows.append({"categoria": category, "secao": label, "item": dict(item)})
    return rows


def _stable_row_key(item: Dict[str, Any], occurrence: int) -> str:
    serial = next((normalize_identifier(item.get(key)) for key in ("serie", "serial", "numero_serie", "service_tag")
                   if normalize_identifier(item.get(key))), "")
    hostname = next((normalize_identifier(item.get(key)) for key in ("computador", "hostname", "apelido", "nome_computador")
                     if normalize_identifier(item.get(key))), "")
    if serial or hostname:
        return f"{serial or hostname}:{occurrence}"
    clean_item = {key: value for key, value in item.items() if key not in {"anotacao", "anotacao_id"}}
    return json.dumps(clean_item, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + f":{occurrence}"


def compare_updates(previous: Dict[str, Any], current: Dict[str, Any]) -> Dict[str, Any]:
    previous_comparison = previous.get("comparacao")
    current_comparison = current.get("comparacao")
    before = previous_comparison if isinstance(previous_comparison, dict) else {}
    after = current_comparison if isinstance(current_comparison, dict) else {}
    changes: Dict[str, List[Dict[str, Any]]] = {"novos": [], "continuam": [], "resolvidos": []}

    for category, label in PENDING_CATEGORIES.items():
        old_value = before.get(category)
        new_value = after.get(category)
        old_items = old_value if isinstance(old_value, list) else []
        new_items = new_value if isinstance(new_value, list) else []

        def indexed(items: List[Any]) -> Dict[str, Dict[str, Any]]:
            counts: Dict[str, int] = {}
            result: Dict[str, Dict[str, Any]] = {}
            for item in items:
                if not isinstance(item, dict):
                    continue
                identity = _stable_row_key(item, 0).rsplit(":", 1)[0]
                occurrence = counts.get(identity, 0)
                counts[identity] = occurrence + 1
                result[_stable_row_key(item, occurrence)] = item
            return result

        old_by_key = indexed(old_items)
        new_by_key = indexed(new_items)
        for key, item in new_by_key.items():
            changes["continuam" if key in old_by_key else "novos"].append({
                "categoria": category, "secao": label, "evento_id": current.get("id"), "item": dict(item),
            })
        for key, item in old_by_key.items():
            if key not in new_by_key:
                changes["resolvidos"].append({
                    "categoria": category, "secao": label, "evento_id": previous.get("id"), "item": dict(item),
                })

    return {
        "anterior": {"id": previous.get("id"), "horario": previous.get("horario")},
        "atual": {"id": current.get("id"), "horario": current.get("horario")},
        "mudancas": changes,
        "contagens": {name: len(items) for name, items in changes.items()},
    }
