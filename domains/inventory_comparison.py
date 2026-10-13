"""Inventory comparison and source normalization rules."""

import hashlib
import math
import re
import unicodedata
from datetime import date, datetime, time, timedelta
from typing import Any, Dict, List, Optional

PINNED_COMPARISON_EVENT_ID = "e1f66787b2aa49a0bdbc848521ca1fc4"

PINNED_COMPARISON_EVENT_TIME = "2026-09-28T14:47:46-03:00"

def normalize_reference_value(value: Any) -> str:
    """Normaliza valores de série, apelido e cidade para comparações consistentes."""
    if is_missing_cell_value(value):
        return ""
    decomposed = unicodedata.normalize("NFKD", str(value).strip().upper())
    without_accents = "".join(char for char in decomposed if not unicodedata.combining(char))
    return re.sub(r"[^A-Z0-9]", "", without_accents)


def is_missing_cell_value(value: Any) -> bool:
    """Return whether an Excel scalar represents an empty or not-a-number cell."""
    if value is None:
        return True
    return isinstance(value, float) and math.isnan(value)

def _record_value(record: Dict[str, Any], *keys: str) -> Any:
    for key in keys:
        normalized = normalize_reference_value(key)
        value = record.get(normalized)
        if value is not None and str(value).strip():
            return value
    return ""

def _upload_serial_value(record: Dict[str, Any], role: str) -> Any:
    if role == "endpoint":
        return _record_value(
            record,
            "ROTULODESERVICONUMERODESERIE",
            "NUMEROSERIE",
            "NUMERODESERIE",
            "SERIAL",
            "SERVICETAG",
        )
    return _record_value(record, "NUMEROSERIE", "NUMERODESERIE", "SERIAL")

def _upload_alias_value(record: Dict[str, Any], role: str) -> str:
    if role == "endpoint":
        value = _record_value(record, "NOMEDOCOMPUTADOR", "COMPUTERNAME", "HOSTNAME", "APELIDO")
    else:
        value = _record_value(record, "APELIDO", "HOSTNAME", "NOMEDOCOMPUTADOR", "COMPUTERNAME")
    return str(value or "").strip()

def _upload_verification_value(record: Dict[str, Any]) -> Any:
    return _record_value(
        record,
        "ULTIMAVERIFICACAOCOMEXITO",
        "LASTSUCCESSFULVERIFICATION",
        "LASTSUCCESSFULVERIFICATIONDATE",
        "LASTSUCCESSFULCHECKIN",
        "LASTSUCCESSFULCHECKINDATE",
    )

def _parse_verification_datetime(value: Any, reference_timezone: Any) -> Optional[datetime]:
    parsed: Optional[datetime]
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, date):
        parsed = datetime.combine(value, time.min)
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            month_names = {
                "jan": "Jan", "fev": "Feb", "feb": "Feb", "mar": "Mar",
                "abr": "Apr", "apr": "Apr", "mai": "May", "jun": "Jun",
                "jul": "Jul", "ago": "Aug", "aug": "Aug", "set": "Sep",
                "sep": "Sep", "out": "Oct", "oct": "Oct", "nov": "Nov",
                "dez": "Dec", "dec": "Dec",
            }
            normalized_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
            normalized_text = re.sub(
                r"\b(" + "|".join(month_names) + r")\b",
                lambda match: month_names[match[0].lower()],
                normalized_text,
                flags=re.IGNORECASE,
            )
            parsed = None
            for pattern in (
                "%b %d, %Y %I:%M %p", "%B %d, %Y %I:%M %p",
                "%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M",
                "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M",
                "%d/%m/%Y", "%Y-%m-%d",
            ):
                try:
                    parsed = datetime.strptime(normalized_text, pattern)
                    break
                except ValueError:
                    continue
            if parsed is None:
                return None
    else:
        return None

    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=reference_timezone)
    return parsed.astimezone(reference_timezone)

def _unique_upload_records(table: Dict[str, Any], role: str) -> Dict[str, Dict[str, Any]]:
    grouped: Dict[str, List[Dict[str, Any]]] = {}
    for record in table.get("records", []):
        serial_key = normalize_reference_value(_upload_serial_value(record, role))
        if serial_key:
            grouped.setdefault(serial_key, []).append(record)
    return {
        serial_key: rows[0]
        for serial_key, rows in grouped.items()
        if len(rows) == 1
    }

def _uploaded_aliases_by_serial(
    endpoint_table: Dict[str, Any],
    details_table: Dict[str, Any],
    manual_aliases: Optional[Dict[str, str]] = None,
) -> Dict[str, str]:
    aliases = {
        serial_key: alias
        for serial_key, record in _unique_upload_records(details_table, "detalhes").items()
        if (alias := _upload_alias_value(record, "detalhes"))
    }
    for serial_key, record in _unique_upload_records(endpoint_table, "endpoint").items():
        alias = _upload_alias_value(record, "endpoint")
        if alias:
            aliases[serial_key] = alias
    aliases.update(manual_aliases or {})
    return aliases

COMPARISON_SOURCE_LABELS = {
    "endpoint": "no endpoint",
    "detalhes": "EquipamentosDetalhes",
}

COMPARISON_AMBIGUITY_SOURCE_LABELS = {
    "endpoint": "Endpoint",
    "detalhes": "EquipamentosDetalhes",
}

def _comparison_source_text_for_display(value: str) -> str:
    """Atualiza apenas textos de apresentação, preservando arquivos e dados de origem."""
    value = re.sub(
        r"\b(?:na|no|da|do|à|ao|pela|pelo|a|o)\s*InvAll",
        "no endpoint",
        value,
        flags=re.IGNORECASE,
    )
    value = re.sub(r"InvAll", "no endpoint", value, flags=re.IGNORECASE)
    value = re.sub(
        r"(?<![\w.-])(?:no\s+)?Endpoint(?![\w.-])",
        "no endpoint",
        value,
        flags=re.IGNORECASE,
    )
    value = re.sub(
        r"\b(?:em|de|da|do|na|no|a|à|pela|pelo)\s*EquipamentosDetalhes",
        "na Simpress",
        value,
        flags=re.IGNORECASE,
    )
    value = re.sub(r"EquipamentosDetalhes", "na Simpress", value, flags=re.IGNORECASE)
    return re.sub(r"\b(?:na\s+)?Simpress\b", "na Simpress", value, flags=re.IGNORECASE)

def _comparison_source_records(table: Dict[str, Any], role: str) -> List[Dict[str, Any]]:
    """Converts source-specific columns to a shared, comparison-only record shape."""
    serial_headers = (
        "ROTULODESERVICONUMERODESERIE", "NUMEROSERIE", "NUMERODESERIE", "SERIAL", "SERVICETAG"
    )
    endpoint_name_headers = ("NOMEDOCOMPUTADOR", "COMPUTERNAME", "HOSTNAME")
    equipment_alias_headers = ("APELIDO", "HOSTNAME", "NOMEDOCOMPUTADOR", "COMPUTERNAME")
    location_headers = ("CIDADE", "LOCAL", "LOCALIDADE", "LOCATION")
    user_headers = ("USUARIOSLOGADOS", "LOGGEDINUSERS", "USUARIO")

    records = []
    for fallback_row_number, row in enumerate(table.get("records", []), start=2):
        source_row_number = row.get("__excel_row_number__")
        row_number = (
            source_row_number
            if isinstance(source_row_number, int) and not isinstance(source_row_number, bool)
            else fallback_row_number
        )
        serial_value = _record_value(row, *serial_headers)
        if role == "endpoint":
            computer_name = str(_record_value(row, *endpoint_name_headers) or "").strip()
            if not computer_name.upper().startswith(("PRNOTE", "PRMAC")):
                continue
            alias_value = computer_name
        else:
            alias_value = str(_record_value(row, *equipment_alias_headers) or "").strip()
            computer_name = alias_value

        serial_display = str(serial_value or "").strip()
        if not serial_display and not computer_name:
            continue
        location_value = str(_record_value(row, *location_headers) or "").strip()
        records.append({
            "source": role,
            "row_number": row_number,
            "serie": serial_display,
            "serial_key": normalize_reference_value(serial_value),
            "computador": computer_name,
            "alias_key": normalize_reference_value(alias_value),
            "local": location_value,
            "usuario": str(_record_value(row, *user_headers) or "").strip(),
            "ultima_verificacao": _upload_verification_value(row) if role == "endpoint" else None,
            "row": row,
        })
    return records

SERIE_LOCAL_MAP = {
    "APU": "Apucarana", "ARA": "Arapongas", "ARC": "Araucária",
    "CMO": "Campo Mourão", "CAS": "Cascavel", "CIA": "Cianorte",
    "COL": "Colombo", "COP": "Cornélio Procópio", "AAI": "Curitiba",
    "DIREX": "Curitiba", "RCWB": "Curitiba", "RL": "Curitiba",
    "UAI": "Curitiba", "UAJ": "Curitiba", "UANE": "Curitiba",
    "UAR": "Curitiba", "UCF": "Curitiba", "UCS": "Curitiba",
    "UGE": "Curitiba", "UGIP": "Curitiba", "UGP": "Curitiba",
    "UIC": "Curitiba", "UMC": "Curitiba", "TI": "Curitiba UTIC",
    "MTZ": "Curitiba", "BTA": "Curitiba", "CIC": "Curitiba",
    "SFE": "Curitiba", "FOZ": "Foz do Iguaçu", "FBO": "Francisco Beltrão",
    "GPV": "Guarapuava", "IRA": "Irati", "IVA": "Ivaiporã",
    "JAC": "Jacarezinho", "LAJ": "Laranjeiras do Sul", "LON": "Londrina",
    "MAR": "Maringá", "PN": "Paranaguá", "PV": "Paranavaí",
    "PAB": "Pato Branco", "PG": "Ponta Grossa", "PTU": "Porecatu",
    "RIO": "Rio Negro", "SJP": "São José dos Pinhais", "TBO": "Telêmaco Borba",
    "TOL": "Toledo", "UMU": "Umuarama", "UDV": "União da Vitória",
    "BAR": "Barracão",
}

CURITIBA_HOSTNAME_PREFIXES = ("SJP", "RL", "ARC")

SEBRAE_OWNED_NOTEBOOK_SERIALS = frozenset({
    "BRJ135P5XS",
    "BRJ142QKBQ",
    "BRJ9435VMR",
    "BRJ9435VMF",
    "BRJ149SCJG",
})

def is_sebrae_owned_notebook_serial(serial: Any) -> bool:
    return normalize_reference_value(serial) in SEBRAE_OWNED_NOTEBOOK_SERIALS

def is_curitiba_hostname_exception(computer_name: str) -> bool:
    name = str(computer_name or "").strip().upper()
    if not name.startswith("PRNOTE"):
        return False
    suffix = normalize_reference_value(name[len("PRNOTE"):])
    return suffix.startswith(CURITIBA_HOSTNAME_PREFIXES)

def is_prnoteti_curitiba_location_match(
    computer_name: Any,
    expected_location: Any,
    details_location: Any,
) -> bool:
    name = str(computer_name or "").strip().upper()
    return (
        name.startswith("PRNOTETI")
        and normalize_reference_value(expected_location) == normalize_reference_value("Curitiba UTIC")
        and normalize_reference_value(details_location) == normalize_reference_value("Curitiba")
    )

def filter_sebrae_owned_unmatched_items(items: Any) -> List[Dict[str, Any]]:
    if not isinstance(items, list):
        return []
    return [
        item for item in items
        if not isinstance(item, dict) or not is_sebrae_owned_notebook_serial(item.get("serie"))
    ]

def filter_update_review_items(
    items: Any,
    *,
    endpoint_unmatched_serials: Optional[set] = None,
    ambiguous_serials: Optional[set] = None,
) -> List[Dict[str, Any]]:
    """Keep review rows except Endpoint series shown in other result sections."""
    if not isinstance(items, list):
        return []

    endpoint_unmatched_serials = endpoint_unmatched_serials or set()
    ambiguous_serials = ambiguous_serials or set()
    filtered = []
    for item in items:
        if not isinstance(item, dict):
            continue
        serial = normalize_reference_value(item.get("serie"))
        reason = normalize_reference_value(
            _comparison_source_text_for_display(str(item.get("motivo") or ""))
        )
        hostname = normalize_reference_value(item.get("computador"))
        if "SERIEDUPLICADANOENDPOINT" in reason and serial in ambiguous_serials:
            continue
        if "SERIENAOENCONTRADANOENDPOINT" in reason and serial in endpoint_unmatched_serials:
            continue
        if "SERIEDUPLICADA" in reason or not serial:
            filtered.append(item)
        elif "SERIENAOENCONTRADANOENDPOINT" in reason and serial.startswith(("BRJ", "BRM")):
            filtered.append(item)
        elif "SERIENAOENCONTRADANASIMPRESS" in reason and hostname.startswith("PRMAC"):
            filtered.append(item)
    return filtered


def comparison_review_item_id(event_id: Any, index: int, item: Dict[str, Any]) -> str:
    """Return a stable ID for a review row, including legacy rows without one."""
    stored_id = item.get("anotacao_id")
    if isinstance(stored_id, str) and stored_id.strip():
        return stored_id.strip()
    identity = "\0".join((
        str(event_id or ""),
        str(index),
        str(item.get("serie") or ""),
        str(item.get("computador") or ""),
        str(item.get("motivo") or ""),
    ))
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def comparison_annotation_item_id(
    event_id: Any,
    category: str,
    index: int,
    item: Dict[str, Any],
) -> str:
    """Return a stable, event-scoped ID for an annotatable comparison row."""
    if category == "apelidos_sem_atualizacao":
        # Preserve IDs used by existing shared annotations and older history rows.
        return comparison_review_item_id(event_id, index, item)
    stored_id = item.get("anotacao_id")
    if isinstance(stored_id, str) and stored_id.strip():
        return stored_id.strip()
    identity = "\0".join((
        str(event_id or ""),
        str(category or ""),
        str(index),
        str(item.get("serie") or ""),
        str(item.get("computador") or ""),
        str(item.get("chave") or ""),
        str(item.get("tipo") or ""),
        str(item.get("motivo") or ""),
        str(item.get("mensagem") or ""),
    ))
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()

def filter_update_unmatched_series(items: Any) -> List[Dict[str, Any]]:
    if not isinstance(items, list):
        return []
    return [
        item for item in items
        if isinstance(item, dict) and normalize_reference_value(item.get("serie")).startswith(("BRJ", "BRM"))
    ]

def filter_update_unmatched_details(items: Any) -> List[Dict[str, Any]]:
    if not isinstance(items, list):
        return []
    return [
        item for item in items
        if isinstance(item, dict) and normalize_reference_value(item.get("computador")).startswith("PRMAC")
    ]

def filter_curitiba_hostname_location_mismatches(items: Any) -> List[Dict[str, Any]]:
    if not isinstance(items, list):
        return []
    return [
        item for item in items
        if not isinstance(item, dict)
        or (
            not is_curitiba_hostname_exception(str(item.get("computador") or ""))
            and not is_prnoteti_curitiba_location_match(
                item.get("computador"),
                item.get("local_previsto"),
                item.get("local_detalhes"),
            )
        )
    ]

def comparison_history_for_display(evento: Dict[str, Any]) -> Dict[str, Any]:
    """Aplica a classificação atual às visualizações sem reescrever o histórico salvo."""
    event_view = dict(evento)
    comparison = evento.get("comparacao")
    if not isinstance(comparison, dict):
        return event_view

    comparison_view = dict(comparison)
    is_pinned_baseline = (
        evento.get("id") == PINNED_COMPARISON_EVENT_ID
        and evento.get("horario") == PINNED_COMPARISON_EVENT_TIME
    )
    for obsolete_key in ("total_base_principal", "ausentes_na_base_principal", "divergencias_endereco"):
        comparison_view.pop(obsolete_key, None)

    endpoint_unmatched_items = comparison.get("ausentes_no_endpoint")
    if not is_pinned_baseline:
        endpoint_unmatched_items = filter_update_unmatched_series(endpoint_unmatched_items)
    endpoint_unmatched_serials = {
        normalize_reference_value(item.get("serie"))
        for item in filter_sebrae_owned_unmatched_items(endpoint_unmatched_items)
        if isinstance(item, dict) and normalize_reference_value(item.get("serie"))
    }
    duplicate_serial_type = normalize_reference_value("Número de série duplicado")
    ambiguous_serials = set()
    ambiguity_items_for_filter = comparison.get("correspondencias_ambiguas")
    if isinstance(ambiguity_items_for_filter, list):
        for issue in ambiguity_items_for_filter:
            if (
                isinstance(issue, dict)
                and normalize_reference_value(issue.get("tipo")) == duplicate_serial_type
            ):
                duplicate_serial = normalize_reference_value(issue.get("chave"))
                if duplicate_serial:
                    ambiguous_serials.add(duplicate_serial)
    ambiguous_records_for_filter = comparison.get("registros_ambiguos")
    if isinstance(ambiguous_records_for_filter, list):
        for record in ambiguous_records_for_filter:
            if isinstance(record, dict):
                ambiguous_serials.update(
                    serial
                    for serial in (
                        normalize_reference_value(value)
                        for value in re.split(r"\s*/\s*", str(record.get("serie") or ""))
                    )
                    if serial
                )

    def without_legacy_source(item: Any) -> Any:
        if not isinstance(item, dict):
            return item
        cleaned = dict(item)
        for key in ("local_base_principal", "ip_endpoint", "ip_detalhes", "ip_base_principal"):
            cleaned.pop(key, None)
        absent_in = cleaned.get("ausente_em")
        if isinstance(absent_in, list):
            cleaned["ausente_em"] = [source for source in absent_in if source != "Base principal"]
        if cleaned.get("fonte_ausente") == "Base principal":
            cleaned.pop("fonte_ausente", None)
        sources = cleaned.get("fontes")
        if isinstance(sources, dict):
            cleaned["fontes"] = {key: value for key, value in sources.items() if key != "Base principal"}
        elif isinstance(sources, list):
            cleaned["fontes"] = [
                source for source in sources
                if not isinstance(source, dict) or source.get("fonte") != "Base principal"
            ]
        return cleaned

    def display_source_values(value: Any) -> Any:
        if isinstance(value, str):
            return _comparison_source_text_for_display(value)
        if isinstance(value, list):
            return [display_source_values(item) for item in value]
        if isinstance(value, dict):
            return {
                _comparison_source_text_for_display(str(key)): display_source_values(item)
                for key, item in value.items()
            }
        return value

    def display_history_item(item: Any) -> Any:
        cleaned = without_legacy_source(item)
        if not isinstance(cleaned, dict):
            return cleaned
        for key in ("motivo", "mensagem", "fonte", "fonte_ausente", "ausente_em", "fontes", "arquivos_origem"):
            if key in cleaned:
                cleaned[key] = display_source_values(cleaned[key])
        return cleaned

    def display_annotatable_items(
        category: str,
        items: Any,
        *,
        legacy_category: Optional[str] = None,
        legacy_index_offset: int = 0,
    ) -> List[Dict[str, Any]]:
        if not isinstance(items, list):
            return []
        legacy_annotations = comparison.get("anotacoes")
        displayed = []
        for index, item in enumerate(items):
            if not isinstance(item, dict):
                continue
            item_view = dict(item)
            item_view["anotacao_id"] = comparison_annotation_item_id(
                evento.get("id"), category, index, item
            )
            if not isinstance(item_view.get("anotacao"), str) and isinstance(legacy_annotations, dict):
                legacy_key = legacy_category or category
                legacy_note = legacy_annotations.get(f"{legacy_key}:{index + legacy_index_offset}")
                if isinstance(legacy_note, str):
                    item_view["anotacao"] = legacy_note
            displayed.append(display_history_item(item_view))
        return displayed

    def display_history_files(files: Any) -> Any:
        if not isinstance(files, dict):
            return files
        return {
            key: display_source_values(value)
            for key, value in files.items()
        }

    review_items = comparison.get("apelidos_sem_atualizacao")
    if isinstance(review_items, list):
        review_items_with_ids = display_annotatable_items(
            "apelidos_sem_atualizacao", review_items
        )
        selected_review_items = (
            review_items_with_ids
            if is_pinned_baseline
            else filter_update_review_items(
                review_items_with_ids,
                endpoint_unmatched_serials=endpoint_unmatched_serials,
                ambiguous_serials=ambiguous_serials,
            )
        )
        comparison_view["apelidos_sem_atualizacao"] = selected_review_items

    no_recent_verification = comparison.get("sem_acesso_7_dias")
    if isinstance(no_recent_verification, list):
        comparison_view["sem_acesso_7_dias"] = display_annotatable_items(
            "sem_acesso_7_dias", no_recent_verification
        )

    if is_pinned_baseline:
        missing_lists = {
            "ausentes_no_endpoint": display_annotatable_items(
                "ausentes_no_endpoint", comparison.get("ausentes_no_endpoint")
            ),
            "ausentes_em_detalhes": display_annotatable_items(
                "ausentes_em_detalhes", comparison.get("ausentes_em_detalhes")
            ),
        }
    else:
        missing_lists = {
            "ausentes_no_endpoint": filter_update_unmatched_series(
                display_annotatable_items(
                    "ausentes_no_endpoint", comparison.get("ausentes_no_endpoint")
                )
            ),
            "ausentes_em_detalhes": filter_update_unmatched_details(
                display_annotatable_items(
                    "ausentes_em_detalhes", comparison.get("ausentes_em_detalhes")
                )
            ),
        }
        comparison_view["filtros_atualizacao_aplicados"] = True
    missing_lists = {
        key: filter_sebrae_owned_unmatched_items(items)
        for key, items in missing_lists.items()
    }
    comparison_view.update(missing_lists)
    location_mismatches = filter_curitiba_hostname_location_mismatches(
        display_annotatable_items("divergencias_local", comparison.get("divergencias_local"))
    )
    comparison_view["divergencias_local"] = location_mismatches
    ambiguity_items = comparison.get("correspondencias_ambiguas")
    ambiguous_records = comparison.get("registros_ambiguos")
    if isinstance(ambiguity_items, list):
        displayed_ambiguities = display_annotatable_items(
            "correspondencias_ambiguas",
            ambiguity_items,
            legacy_category="ambiguidades",
        )
    else:
        displayed_ambiguities = []
    if isinstance(ambiguous_records, list):
        displayed_ambiguous_records = display_annotatable_items(
            "registros_ambiguos",
            ambiguous_records,
            legacy_category="ambiguidades",
            legacy_index_offset=len(ambiguity_items) if isinstance(ambiguity_items, list) else 0,
        )
    else:
        displayed_ambiguous_records = []

    retained_ambiguities = []
    duplicate_serial_type = normalize_reference_value("Número de série duplicado")
    for issue in displayed_ambiguities:
        if normalize_reference_value(issue.get("tipo")) != duplicate_serial_type:
            retained_ambiguities.append(issue)
            continue

        duplicate_serial = normalize_reference_value(issue.get("chave"))
        matching_record = next((
            record for record in displayed_ambiguous_records
            if duplicate_serial
            and duplicate_serial in {
                normalize_reference_value(serial)
                for serial in re.split(r"\s*/\s*", str(record.get("serie") or ""))
            }
        ), None)
        if matching_record is None:
            ambiguous_sources = {
                str(source.get("fonte")): "ambíguo"
                for source in (issue.get("fontes") or [])
                if isinstance(source, dict) and str(source.get("fonte") or "").strip()
            }
            displayed_ambiguous_records.append({
                "computador": "Sem hostname/Apelido",
                "serie": str(issue.get("chave") or ""),
                "fontes": ambiguous_sources,
                "motivo": issue.get("mensagem") or "A série aparece em mais de uma linha na mesma fonte.",
                "anotacao_id": issue["anotacao_id"],
                "anotacao": issue.get("anotacao", ""),
            })
            continue

        associated_annotations = matching_record.get("anotacoes_associadas")
        if not isinstance(associated_annotations, list):
            associated_annotations = []
            matching_record["anotacoes_associadas"] = associated_annotations
        associated_annotations.append({
            "anotacao_id": issue["anotacao_id"],
            "anotacao": issue.get("anotacao", ""),
        })

    if isinstance(ambiguity_items, list):
        comparison_view["correspondencias_ambiguas"] = retained_ambiguities
    if isinstance(ambiguous_records, list) or isinstance(ambiguity_items, list):
        comparison_view["registros_ambiguos"] = displayed_ambiguous_records
    unmapped_series = comparison.get("series_sem_mapeamento")
    if isinstance(unmapped_series, list):
        comparison_view["series_sem_mapeamento"] = display_annotatable_items(
            "series_sem_mapeamento", unmapped_series
        )
    for field in ("apelidos_atualizados", "divergencias_apelidos_manuais"):
        items = comparison.get(field)
        if isinstance(items, list):
            comparison_view[field] = [display_history_item(item) for item in items]
    comparison_files = comparison.get("arquivos_enviados")
    if isinstance(comparison_files, dict):
        comparison_view["arquivos_enviados"] = display_history_files({
            key: comparison_files[key]
            for key in ("endpoint", "detalhes")
            if key in comparison_files
        })
    restored_files = comparison.get("arquivos_restaurados")
    if isinstance(restored_files, dict):
        comparison_view["arquivos_restaurados"] = display_history_files(restored_files)
    event_view["comparacao"] = comparison_view

    summary = dict(evento.get("resumo") or {})
    for obsolete_key in ("total_base_principal", "ausentes_na_base_principal", "divergencias_endereco"):
        summary.pop(obsolete_key, None)
    for key, items in missing_lists.items():
        if key in summary or key in comparison:
            summary[key] = len(items)
    if "correspondencias_ambiguas" in summary or isinstance(ambiguity_items, list):
        summary["correspondencias_ambiguas"] = (
            len(retained_ambiguities) + len(displayed_ambiguous_records)
        )
    summary["divergencias_local"] = len(location_mismatches)
    alias_changes = comparison.get("apelidos_atualizados")
    if isinstance(alias_changes, list):
        summary["apelidos_atualizados"] = len(alias_changes)
    alias_review = comparison_view.get("apelidos_sem_atualizacao")
    if isinstance(alias_review, list):
        summary["apelidos_sem_atualizacao"] = len(alias_review)
    no_recent_verification = comparison_view.get("sem_acesso_7_dias")
    if isinstance(no_recent_verification, list):
        summary["sem_acesso_7_dias"] = len(no_recent_verification)
    manual_alias_divergences = comparison_view.get("divergencias_apelidos_manuais")
    if isinstance(manual_alias_divergences, list):
        summary["divergencias_apelidos_manuais"] = sum(
            1 for item in manual_alias_divergences
            if isinstance(item, dict) and item.get("resolucao", "pendente") == "pendente"
        )
    event_view["resumo"] = summary
    uploaded_files = evento.get("arquivos_enviados")
    if isinstance(uploaded_files, dict):
        event_view["arquivos_enviados"] = display_history_files({
            key: uploaded_files[key]
            for key in ("endpoint", "detalhes")
            if key in uploaded_files
        })
    restored_files = evento.get("arquivos_restaurados")
    if isinstance(restored_files, dict):
        event_view["arquivos_restaurados"] = display_history_files(restored_files)
    return event_view

def location_for_computer_name(computer_name: str) -> Optional[str]:
    name = str(computer_name or "").strip().upper()
    if not name.startswith("PRNOTE"):
        return None
    suffix = normalize_reference_value(name[len("PRNOTE"):])
    if suffix.startswith("BACKUP"):
        backup_target = suffix[len("BACKUP"):]
        if not backup_target or not re.search(r"[A-Z]", backup_target):
            return "Curitiba"
        for prefix in sorted(SERIE_LOCAL_MAP, key=len, reverse=True):
            if backup_target.startswith(prefix):
                return SERIE_LOCAL_MAP[prefix]
        city_names = sorted(
            ((normalize_reference_value(city), city) for city in set(SERIE_LOCAL_MAP.values())),
            key=lambda item: len(item[0]),
            reverse=True,
        )
        for normalized_city, city in city_names:
            if backup_target.startswith(normalized_city):
                return city
        return None
    if suffix.startswith(CURITIBA_HOSTNAME_PREFIXES):
        return "Curitiba"
    prefix_source = suffix[3:] if suffix.startswith("BKP") else suffix
    for prefix in sorted(SERIE_LOCAL_MAP, key=len, reverse=True):
        if prefix_source.startswith(prefix):
            return SERIE_LOCAL_MAP[prefix]
    return None

def compare_uploaded_workbooks(
    endpoint_table: Dict[str, Any],
    details_table: Dict[str, Any],
    uploaded_names: Dict[str, str],
    as_of: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Compares Endpoint and EquipamentosDetalhes without silently selecting duplicate matches."""
    source_tables = {
        "endpoint": endpoint_table,
        "detalhes": details_table,
    }
    source_records = {
        role: _comparison_source_records(table, role)
        for role, table in source_tables.items()
    }
    as_of = as_of or datetime.now().astimezone()
    if as_of.tzinfo is None:
        as_of = as_of.astimezone()
    stale_threshold = as_of - timedelta(days=7)

    endpoint_mac_serials = {
        record["serial_key"]
        for record in source_records["endpoint"]
        if record["serial_key"]
        and normalize_reference_value(record["computador"]).startswith("PRMAC")
    }
    for record in source_records["detalhes"]:
        serial_key = record["serial_key"]
        if serial_key.startswith("S") and serial_key[1:] in endpoint_mac_serials:
            record["serial_key"] = serial_key[1:]

    nodes: Dict[tuple, Dict[str, Any]] = {}
    parent: Dict[tuple, tuple] = {}
    rank: Dict[tuple, int] = {}
    component_serials: Dict[tuple, set] = {}
    for role in COMPARISON_SOURCE_LABELS:
        for index, record in enumerate(source_records[role]):
            node = (role, index)
            record["node"] = node
            nodes[node] = record
            parent[node] = node
            rank[node] = 0
            component_serials[node] = {record["serial_key"]} if record["serial_key"] else set()

    def find(node: tuple) -> tuple:
        if parent[node] != node:
            parent[node] = find(parent[node])
        return parent[node]

    def union(left: tuple, right: tuple, allow_conflicting_serials: bool = False) -> bool:
        root_left = find(left)
        root_right = find(right)
        if root_left == root_right:
            return True
        serials_left = component_serials[root_left]
        serials_right = component_serials[root_right]
        if (
            not allow_conflicting_serials
            and serials_left
            and serials_right
            and serials_left != serials_right
        ):
            return False
        if rank[root_left] < rank[root_right]:
            root_left, root_right = root_right, root_left
        parent[root_right] = root_left
        component_serials[root_left] = serials_left | serials_right
        component_serials.pop(root_right, None)
        if rank[root_left] == rank[root_right]:
            rank[root_left] += 1
        return True

    issues: List[Dict[str, Any]] = []
    issue_keys = set()

    def add_issue(issue: Dict[str, Any]) -> None:
        key = (
            issue.get("tipo"),
            normalize_reference_value(issue.get("chave")),
            tuple(
                (source.get("fonte"), source.get("quantidade"), source.get("serie"))
                for source in issue.get("fontes", [])
            ),
        )
        if key not in issue_keys:
            issue_keys.add(key)
            issues.append(issue)

    serial_buckets: Dict[str, List[tuple]] = {}
    alias_buckets: Dict[str, List[tuple]] = {}
    for node, record in nodes.items():
        if record["serial_key"]:
            serial_buckets.setdefault(record["serial_key"], []).append(node)
        if record["alias_key"]:
            alias_buckets.setdefault(record["alias_key"], []).append(node)

    for serial_key, bucket in serial_buckets.items():
        by_source: Dict[str, List[tuple]] = {}
        for node in bucket:
            by_source.setdefault(node[0], []).append(node)
        duplicate_sources = [
            {"fonte": COMPARISON_AMBIGUITY_SOURCE_LABELS[role], "quantidade": len(source_nodes)}
            for role, source_nodes in by_source.items()
            if len(source_nodes) > 1
        ]
        if duplicate_sources:
            add_issue({
                "tipo": "Número de série duplicado",
                "chave": nodes[bucket[0]]["serie"] or serial_key,
                "fontes": duplicate_sources,
                "mensagem": "A série aparece em mais de uma linha na mesma fonte; esses registros foram agrupados como ambíguos.",
            })
        for node in bucket[1:]:
            union(bucket[0], node)

    ambiguous_roles_by_node: Dict[tuple, set] = {node: set() for node in nodes}
    for alias_key, bucket in alias_buckets.items():
        by_source = {}
        for node in bucket:
            by_source.setdefault(node[0], []).append(node)
        duplicate_sources = [
            {"fonte": COMPARISON_AMBIGUITY_SOURCE_LABELS[role], "quantidade": len(source_nodes)}
            for role, source_nodes in by_source.items()
            if len(source_nodes) > 1
        ]
        if duplicate_sources:
            add_issue({
                "tipo": "Hostname/Apelido duplicado",
                "chave": nodes[bucket[0]]["computador"] or alias_key,
                "fontes": duplicate_sources,
                "mensagem": "O hostname/Apelido não é único nesta fonte e não foi usado para escolher uma linha.",
            })

        roles = list(by_source)
        for role_index, left_role in enumerate(roles):
            for right_role in roles[role_index + 1:]:
                left_nodes = by_source[left_role]
                right_nodes = by_source[right_role]
                if len(left_nodes) != 1 or len(right_nodes) != 1:
                    serial_counts_by_role: Dict[str, Dict[str, int]] = {}
                    serial_examples_by_role: Dict[str, Dict[str, str]] = {}
                    blank_counts_by_role: Dict[str, int] = {}
                    for role, role_nodes in ((left_role, left_nodes), (right_role, right_nodes)):
                        serial_counts: Dict[str, int] = {}
                        serial_examples: Dict[str, str] = {}
                        blank_count = 0
                        for node in role_nodes:
                            record = nodes[node]
                            serial_key = record["serial_key"]
                            if not serial_key:
                                blank_count += 1
                                continue
                            serial_counts[serial_key] = serial_counts.get(serial_key, 0) + 1
                            serial_display = str(record["serie"] or "").strip()
                            previous_example = serial_examples.get(serial_key)
                            if previous_example is None or (serial_display.casefold(), serial_display) < (
                                previous_example.casefold(), previous_example
                            ):
                                serial_examples[serial_key] = serial_display
                        serial_counts_by_role[role] = serial_counts
                        serial_examples_by_role[role] = serial_examples
                        blank_counts_by_role[role] = blank_count

                    left_serial_counts = serial_counts_by_role[left_role]
                    right_serial_counts = serial_counts_by_role[right_role]
                    divergent_pair_count = (
                        sum(left_serial_counts.values()) * sum(right_serial_counts.values())
                        - sum(
                            left_count * right_serial_counts.get(serial_key, 0)
                            for serial_key, left_count in left_serial_counts.items()
                        )
                    )
                    if divergent_pair_count:
                        sources = []
                        example_labels = []
                        for role in (left_role, right_role):
                            examples = [
                                serial_examples_by_role[role][serial_key]
                                for serial_key in sorted(serial_examples_by_role[role])[:3]
                            ]
                            sources.append({
                                "fonte": COMPARISON_AMBIGUITY_SOURCE_LABELS[role],
                                "quantidade": len(by_source[role]),
                            })
                            if examples:
                                example_labels.append(
                                    f"{COMPARISON_AMBIGUITY_SOURCE_LABELS[role]} [{', '.join(examples)}]"
                                )
                        examples_text = "; exemplos: " + "; ".join(example_labels) if example_labels else ""
                        add_issue({
                            "tipo": "Série divergente para o mesmo hostname/Apelido",
                            "chave": nodes[left_nodes[0]]["computador"] or alias_key,
                            "fontes": sources,
                            "mensagem": (
                                "As séries prevalecem sobre o hostname/Apelido; "
                                f"{divergent_pair_count} combinações têm séries divergentes. "
                                f"Nenhum registro foi unido{examples_text}."
                            ),
                        })

                    if blank_counts_by_role[left_role]:
                        for left_node in left_nodes:
                            if not nodes[left_node]["serial_key"]:
                                ambiguous_roles_by_node[left_node].add(right_role)
                        for right_node in right_nodes:
                            ambiguous_roles_by_node[right_node].add(left_role)
                    if blank_counts_by_role[right_role]:
                        for right_node in right_nodes:
                            if not nodes[right_node]["serial_key"]:
                                ambiguous_roles_by_node[right_node].add(left_role)
                        for left_node in left_nodes:
                            ambiguous_roles_by_node[left_node].add(right_role)
                    continue

                left_node = left_nodes[0]
                right_node = right_nodes[0]
                left_serial = nodes[left_node]["serial_key"]
                right_serial = nodes[right_node]["serial_key"]
                if alias_key.startswith("PRMAC"):
                    union(left_node, right_node, allow_conflicting_serials=True)
                    continue
                if left_serial and right_serial and left_serial != right_serial:
                    add_issue({
                        "tipo": "Série divergente para o mesmo hostname/Apelido",
                        "chave": nodes[left_node]["computador"] or alias_key,
                        "fontes": [
                            {"fonte": COMPARISON_AMBIGUITY_SOURCE_LABELS[left_role], "serie": nodes[left_node]["serie"]},
                            {"fonte": COMPARISON_AMBIGUITY_SOURCE_LABELS[right_role], "serie": nodes[right_node]["serie"]},
                        ],
                        "mensagem": "As séries prevalecem sobre o hostname/Apelido; os registros não foram unidos.",
                    })
                    continue
                if not union(left_node, right_node):
                    add_issue({
                        "tipo": "Correspondência ambígua por hostname/Apelido",
                        "chave": nodes[left_node]["computador"] or alias_key,
                        "fontes": [
                            {"fonte": COMPARISON_AMBIGUITY_SOURCE_LABELS[left_role], "serie": nodes[left_node]["serie"]},
                            {"fonte": COMPARISON_AMBIGUITY_SOURCE_LABELS[right_role], "serie": nodes[right_node]["serie"]},
                        ],
                        "mensagem": "O hostname/Apelido levaria a séries incompatíveis; nenhum registro foi escolhido.",
                    })
                    if not left_serial:
                        ambiguous_roles_by_node[left_node].add(right_role)
                    if not right_serial:
                        ambiguous_roles_by_node[right_node].add(left_role)

    components: Dict[tuple, List[tuple]] = {}
    for node in nodes:
        components.setdefault(find(node), []).append(node)

    def distinct_values(records: List[Dict[str, Any]], field: str) -> List[str]:
        values = []
        for record in records:
            value = str(record.get(field) or "").strip()
            if value and value not in values:
                values.append(value)
        return values

    entities = []
    missing_by_source: Dict[str, List[Dict[str, Any]]] = {
        role: [] for role in COMPARISON_SOURCE_LABELS
    }
    ambiguous_records = []
    for component_nodes in components.values():
        records_by_source: Dict[str, List[Dict[str, Any]]] = {
            role: [] for role in COMPARISON_SOURCE_LABELS
        }
        for node in component_nodes:
            records_by_source[node[0]].append(nodes[node])

        ambiguous_source_roles = set()
        for node in component_nodes:
            ambiguous_source_roles.update(ambiguous_roles_by_node[node])

        source_status = {}
        for role in COMPARISON_SOURCE_LABELS:
            count = len(records_by_source[role])
            if count > 1:
                source_status[role] = "ambíguo"
            elif count == 1:
                source_status[role] = "presente"
            elif role in ambiguous_source_roles:
                source_status[role] = "ambíguo"
            else:
                source_status[role] = "ausente"

        all_records = [record for role in COMPARISON_SOURCE_LABELS for record in records_by_source[role]]
        names = distinct_values(all_records, "computador")
        serials = distinct_values(all_records, "serie")
        endpoint_records = records_by_source["endpoint"]
        expected_locations = list(dict.fromkeys(
            location_for_computer_name(record["computador"])
            for record in endpoint_records
            if location_for_computer_name(record["computador"])
        ))
        expected_location = expected_locations[0] if len(expected_locations) == 1 else None
        entity = {
            "computador": " / ".join(names) if names else "Sem hostname/Apelido",
            "serie": " / ".join(serials),
            "usuario": " / ".join(distinct_values(endpoint_records, "usuario")),
            "local_previsto": expected_location or "Sem mapeamento de local",
            "fontes": {
                COMPARISON_SOURCE_LABELS[role]: source_status[role]
                for role in COMPARISON_SOURCE_LABELS
            },
            "ausente_em": [
                COMPARISON_SOURCE_LABELS[role]
                for role, status in source_status.items()
                if status == "ausente"
            ],
        }
        entities.append((entity, records_by_source, source_status, expected_location))

        for role, status in source_status.items():
            if status != "ausente" or is_sebrae_owned_notebook_serial(entity["serie"]):
                continue
            item = dict(entity)
            item["fonte_ausente"] = COMPARISON_SOURCE_LABELS[role]
            missing_by_source[role].append(item)

        if "ambíguo" in source_status.values():
            ambiguous_records.append({
                **entity,
                "motivo": "Há registros duplicados ou uma alternativa de hostname/Apelido que não é única.",
            })

    location_mismatches = []
    for entity, records_by_source, source_status, expected_location in entities:
        endpoint_records = records_by_source["endpoint"]
        if len(endpoint_records) != 1:
            continue
        endpoint_record = endpoint_records[0]
        computer_name = endpoint_record["computador"]
        if expected_location:
            location_values = {}
            any_location_mismatch = False
            details_records = records_by_source["detalhes"]
            details_location = details_records[0]["local"] if len(details_records) == 1 else ""
            location_values["local_detalhes"] = details_location
            if (
                details_location
                and normalize_reference_value(details_location) != normalize_reference_value(expected_location)
                and not is_curitiba_hostname_exception(computer_name)
                and not is_prnoteti_curitiba_location_match(
                    computer_name,
                    expected_location,
                    details_location,
                )
            ):
                any_location_mismatch = True
            if any_location_mismatch:
                location_mismatches.append({
                    "computador": computer_name,
                    "serie": endpoint_record["serie"],
                    "local_previsto": expected_location,
                    **location_values,
                })

    unmapped_series: Dict[str, List[str]] = {}
    no_recent_verification = []
    for record in source_records["endpoint"]:
        computer_name = record["computador"]
        verified_at = _parse_verification_datetime(record.get("ultima_verificacao"), as_of.tzinfo)
        if verified_at is not None and verified_at <= stale_threshold:
            no_recent_verification.append({
                "computador": computer_name,
                "serie": record["serie"],
                "ultima_verificacao": verified_at.isoformat(timespec="minutes"),
                "dias_sem_verificacao": max(7, (as_of - verified_at).days),
                "linha_endpoint": record["row_number"],
            })
        if not computer_name.upper().startswith("PRNOTE") or location_for_computer_name(computer_name):
            continue
        suffix = computer_name.upper()[len("PRNOTE"):]
        if suffix.startswith("BACKUP"):
            suffix = suffix[len("BACKUP"):]
        elif suffix.startswith("BKP"):
            suffix = suffix[3:]
        series_code = next(
            (prefix for prefix in sorted(SERIE_LOCAL_MAP, key=len, reverse=True) if suffix.startswith(prefix)),
            suffix.rstrip("0123456789-_") or suffix,
        )
        unmapped_series.setdefault(series_code, []).append(computer_name)

    return {
        "total_endpoint": len(source_records["endpoint"]),
        "total_detalhes": len(details_table["records"]),
        "ausentes_no_endpoint": missing_by_source["endpoint"],
        "ausentes_em_detalhes": missing_by_source["detalhes"],
        "sem_acesso_7_dias": no_recent_verification,
        "correspondencias_ambiguas": issues,
        "registros_ambiguos": ambiguous_records,
        "divergencias_local": location_mismatches,
        "series_sem_mapeamento": [
            {"serie": code, "exemplos": names[:10], "quantidade": len(names)}
            for code, names in sorted(unmapped_series.items())
        ],
        "arquivos_enviados": uploaded_names,
    }
