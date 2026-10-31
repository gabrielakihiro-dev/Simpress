"""Search indexing and categorization for equipment records."""

import difflib
import re
import unicodedata
from typing import Any, Callable, Dict, Iterable, List, Tuple


EquipmentSearchIndexEntry = Tuple[
    int,
    Tuple[str, str, str, str, str, str, str],
    Dict[str, Any],
]

CATEGORIES = (
    {"value": "notebook", "label": "Notebooks"},
    {"value": "macbook", "label": "MacBooks"},
    {"value": "monitor", "label": "Monitores"},
    {"value": "fone", "label": "Fones"},
)


def normalize_search_term(value: Any) -> str:
    """Normalize accents and casing for equipment search."""
    text = unicodedata.normalize("NFKD", str(value or ""))
    return "".join(character for character in text if not unicodedata.combining(character)).strip().upper()


USER_WORD_SPLIT = re.compile(r"[\s,;/\\]+")
# Below this similarity a typo is not corrected: "joao" must not become "joana" blindly, but "bpinheirp" -> "bpinheiro".
SUGGESTION_CUTOFF = 0.75


def categorize_equipment(kind: Any, model: Any, normalize: Callable[[Any], str] = normalize_search_term) -> str:
    """Map inventory labels to the categories used by the search interface."""
    text = f"{normalize(kind)} {normalize(model)}"
    if "MACBOOK" in text:
        return "macbook"
    if "MONITOR" in text:
        return "monitor"
    if any(term in text for term in ("HEADSET", "HEADPHONE", "FONE", "EARPHONE", "EARBUD")):
        return "fone"
    if "NOTEBOOK" in text or "LAPTOP" in text or "ZBOOK" in text:
        return "notebook"
    return ""


def build_search_index(
    equipment_cache: Dict[str, Dict[str, Any]],
    normalize: Callable[[Any], str] = normalize_search_term,
) -> Tuple[EquipmentSearchIndexEntry, ...]:
    """Precompute normalized values once for each published cache generation."""
    indexed: List[EquipmentSearchIndexEntry] = []
    for index, (serial_key, item) in enumerate(equipment_cache.items()):
        serial = str(item.get("serial") or serial_key)
        model = str(item.get("modelo") or "")
        kind = str(item.get("tipo") or "")
        alias = str(item.get("apelido") or "")
        city = str(item.get("retirada_cidade") or "")
        category = categorize_equipment(kind, model, normalize)
        category_label = next(
            (entry["label"] for entry in CATEGORIES if entry["value"] == category),
            "",
        )
        searchable_values = (
            normalize(serial_key or serial),
            normalize(model),
            normalize(kind),
            normalize(alias),
            normalize(city),
            normalize(category_label),
            # Ambiguous Endpoint candidates are searchable too, although none is the logged user.
            normalize(" ".join([
                str(item.get("usuarios_logados") or ""),
                str(item.get("nome_pessoa") or ""),
                *(str(user) for user in item.get("usuarios_logados_candidatos") or []),
            ])),
        )
        result = {
            "serial": serial,
            "modelo": model,
            "tipo": kind,
            "categoria": category,
            "apelido": alias,
            "retirada_cidade": city,
            "retirada_cnpj": str(item.get("retirada_cnpj") or ""),
            "usuarios_logados": str(item.get("usuarios_logados") or ""),
            "nome_pessoa": str(item.get("nome_pessoa") or ""),
            "nome_pessoa_origem": str(item.get("nome_pessoa_origem") or ""),
            "nome_pessoa_editavel": bool(item.get("nome_pessoa_editavel")),
            "usuarios_logados_origem": str(item.get("usuarios_logados_origem") or ""),
            "usuarios_logados_informado_em": str(item.get("usuarios_logados_informado_em") or ""),
            "usuarios_logados_candidatos": [str(user) for user in item.get("usuarios_logados_candidatos") or []],
            "invall_alias_status": item.get("invall_alias_status"),
            "invall_alias_detail": item.get("invall_alias_detail"),
        }
        if item.get("usuarios_logados_pendencia"):
            result["usuarios_logados_pendencia"] = str(item["usuarios_logados_pendencia"])
        indexed.append((index, searchable_values, result))
    return tuple(indexed)


def search_index(
    indexed: Iterable[EquipmentSearchIndexEntry],
    query: Any,
    normalize: Callable[[Any], str] = normalize_search_term,
) -> List[Dict[str, Any]]:
    """Find matching equipment and retain the established relevance ordering."""
    return search_normalized_index(indexed, normalize(query))


def search_normalized_index(
    indexed: Iterable[EquipmentSearchIndexEntry],
    term: str,
) -> List[Dict[str, Any]]:
    """Search with a term normalized by the caller."""
    if not term:
        return []

    # Nome com palavras separadas ("bruno pinheiro" acha "Bruno Gabriel de Oliveira Pinheiro"):
    # todas as palavras precisam estar no mesmo campo; fica depois dos acertos da frase inteira.
    words = term.split()

    ranked_results: List[Tuple[int, int, Dict[str, Any]]] = []
    for index, searchable_values, result in indexed:
        serial_search, model_search, kind_search, alias_search, city_search, category_search, user_search = searchable_values
        if not any(term in value for value in searchable_values) and not (
            len(words) > 1 and any(all(word in value for word in words) for value in searchable_values)
        ):
            continue

        if term == serial_search:
            rank = 0
        elif serial_search.startswith(term):
            rank = 1
        elif term in serial_search:
            rank = 2
        elif term in model_search:
            rank = 3
        elif term in alias_search:
            rank = 4
        elif term in kind_search:
            rank = 5
        elif term in category_search:
            rank = 6
        elif term in user_search:
            rank = 7
        else:
            rank = 8
        ranked_results.append((rank, index, result))

    ranked_results.sort(key=lambda result: (result[0], result[1]))
    return [result[2] for result in ranked_results]


def suggest_user_term(
    indexed: Iterable[EquipmentSearchIndexEntry],
    term: str,
    normalize: Callable[[Any], str] = normalize_search_term,
) -> str:
    """Closest user login/name words for a term without results ("bpinheirp" -> "bpinheiro").

    Returns "" unless the corrected term finds equipment, so a suggestion is always clickable.
    """
    entries = tuple(indexed)
    vocabulary: Dict[str, str] = {}
    for _, _, result in entries:
        users = [result.get("usuarios_logados"), result.get("nome_pessoa"), *(result.get("usuarios_logados_candidatos") or [])]
        for word in USER_WORD_SPLIT.split(" ".join(str(user or "") for user in users)):
            key = normalize(word)
            if len(key) >= 3:
                vocabulary.setdefault(key, word)

    keys = list(vocabulary)
    corrected: List[str] = []
    for word in term.split():
        match = word if word in vocabulary else next(iter(difflib.get_close_matches(word, keys, n=1, cutoff=SUGGESTION_CUTOFF)), word)
        corrected.append(vocabulary.get(match, word.lower()))
    suggestion = " ".join(corrected)
    normalized = normalize(suggestion)
    if not normalized or normalized == term or not search_normalized_index(entries, normalized):
        return ""
    return suggestion
