"""Read and reconcile Simpress orders with Oracle service requests by serial."""

from __future__ import annotations

from collections import Counter, OrderedDict
from datetime import date, datetime
import io
import re
import unicodedata
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

import openpyxl

from xlsx_safety import validate_xlsx


class TicketWorkbookError(ValueError):
    """A workbook is readable but does not contain the expected source table."""


SIMPresS_FIELDS = {
    "serie": ("numeroserie", "numerodeserie", "serial", "servicetag"),
    "pedido": ("numeropedido",),
    "ordem_servico": ("ordemservico", "os"),
    "chamado_cliente": ("numerochamadocliente",),
    "status": ("statusatual",),
    "data_pedido": ("datapedido",),
    "modelo": ("modelodoequipamento",),
}

ORACLE_FIELDS = {
    "serie": ("numerodeserie", "numeroserie", "serial", "servicetag"),
    "solicitacao": ("solicitacao", "numerosolicitacao"),
    "ordem_servico": ("idoscorporate", "ordemservico", "os"),
    "status": ("status",),
    "sub_status": ("substatus",),
    "fila": ("fila",),
    "fase_atendimento": ("fasedeatendimento",),
    "status_entregas": ("statusdasentregas",),
    "status_atividades": ("statusdasatividades",),
    "assunto": ("assunto",),
    "data_criacao": ("datadecriacao",),
    "ultima_atualizacao": ("datadaultimaatualizacao", "dataultimaatualizacao"),
    "data_conclusao": ("datadeconclusao",),
}


def normalize_header(value: Any) -> str:
    normalized = unicodedata.normalize("NFKD", str(value or ""))
    ascii_value = normalized.encode("ascii", "ignore").decode("ascii").casefold()
    return re.sub(r"[^a-z0-9]+", "", ascii_value)


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.isoformat(timespec="seconds")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    result = str(value).strip()
    if result.casefold() in {"nenhum valor", "n/a", "na", "null", "none"}:
        return ""
    return result


def _serial_key(value: Any) -> str:
    normalized = unicodedata.normalize("NFKD", _text(value)).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^A-Z0-9]+", "", normalized.upper())


def _identifier_key(value: str) -> str:
    return re.sub(r"\s+", "", value).upper()


def _source_table(
    workbook_bytes: bytes,
    source_label: str,
    field_aliases: Mapping[str, Sequence[str]],
    required_fields: Sequence[str],
) -> Tuple[List[Dict[str, Any]], int]:
    validate_xlsx(workbook_bytes)
    workbook = None
    try:
        workbook = openpyxl.load_workbook(
            io.BytesIO(workbook_bytes), read_only=True, data_only=True, keep_links=False
        )
        candidates: List[Tuple[Any, int, Dict[str, int]]] = []
        for worksheet in workbook.worksheets:
            last_header_row = min(worksheet.max_row, 30)
            for row_number, values in enumerate(
                worksheet.iter_rows(min_row=1, max_row=last_header_row, values_only=True),
                start=1,
            ):
                normalized_headers: Dict[str, List[int]] = {}
                for index, value in enumerate(values):
                    header = normalize_header(value)
                    if header:
                        normalized_headers.setdefault(header, []).append(index)
                columns: Dict[str, int] = {}
                for field, aliases in field_aliases.items():
                    matched = [
                        (alias, index)
                        for alias in aliases
                        for index in normalized_headers.get(alias, [])
                    ]
                    if matched:
                        columns[field] = matched[0][1]
                if all(field in columns for field in required_fields):
                    candidates.append((worksheet, row_number, columns))

        if len(candidates) != 1:
            if not candidates:
                raise TicketWorkbookError(
                    f"A planilha {source_label} não contém uma tabela com os campos obrigatórios."
                )
            raise TicketWorkbookError(
                f"A planilha {source_label} tem mais de uma tabela compatível; mantenha apenas uma aba de origem."
            )

        worksheet, header_row, columns = candidates[0]
        records: List[Dict[str, Any]] = []
        rows_without_serial = 0
        for values in worksheet.iter_rows(min_row=header_row + 1, values_only=True):
            if not any(value is not None and str(value).strip() for value in values):
                continue
            raw_serial = _text(values[columns["serie"]] if columns["serie"] < len(values) else None)
            serial_key = _serial_key(raw_serial)
            if not serial_key:
                rows_without_serial += 1
                continue
            record: Dict[str, Any] = {"serie": raw_serial, "serie_chave": serial_key}
            for field, index in columns.items():
                if field == "serie":
                    continue
                record[field] = _text(values[index] if index < len(values) else None)
            records.append(record)
        return records, rows_without_serial
    except TicketWorkbookError:
        raise
    except Exception as error:
        raise TicketWorkbookError(
            f"Não foi possível ler a planilha {source_label}. Confira se o arquivo está íntegro."
        ) from error
    finally:
        if workbook is not None:
            workbook.close()


def _add_unique(target: List[str], value: str) -> None:
    if value and value not in target:
        target.append(value)


def _group_simpress(records: Iterable[Dict[str, Any]]) -> Dict[str, Dict[str, List[str]]]:
    grouped: Dict[str, Dict[str, List[str]]] = OrderedDict()
    for record in records:
        serial = record["serie_chave"]
        group = grouped.setdefault(serial, {
            "serie": record["serie"], "pedidos": [], "ordens_servico": [], "chamados_cliente": [],
            "status": [], "datas_pedido": [], "modelos": [],
        })
        for source_field, target_field in (
            ("pedido", "pedidos"),
            ("ordem_servico", "ordens_servico"),
            ("chamado_cliente", "chamados_cliente"),
            ("status", "status"),
            ("data_pedido", "datas_pedido"),
            ("modelo", "modelos"),
        ):
            _add_unique(group[target_field], record.get(source_field, ""))
    return grouped


def _group_oracle(records: Iterable[Dict[str, Any]]) -> Dict[str, List[Dict[str, str]]]:
    grouped: Dict[str, List[Dict[str, str]]] = OrderedDict()
    seen: Dict[str, set[Tuple[str, ...]]] = {}
    exposed_fields = (
        "solicitacao", "ordem_servico", "status", "sub_status", "fila",
        "fase_atendimento", "status_entregas", "status_atividades", "assunto",
        "data_criacao", "ultima_atualizacao", "data_conclusao",
    )
    for record in records:
        serial = record["serie_chave"]
        ticket = {field: record.get(field, "") for field in exposed_fields}
        signature = tuple(ticket[field] for field in exposed_fields)
        if signature in seen.setdefault(serial, set()):
            continue
        seen[serial].add(signature)
        ticket["serie"] = record["serie"]
        grouped.setdefault(serial, []).append(ticket)
    return grouped


def _safe_filename(filename: str) -> str:
    return filename.replace("\\", "/").rsplit("/", 1)[-1].strip()[:200]


def reconcile_ticket_workbooks(
    simpress_bytes: bytes,
    oracle_bytes: bytes,
    *,
    simpress_filename: str,
    oracle_filename: str,
) -> Dict[str, Any]:
    """Join the two exported sources by normalized serial and expose OS conflicts."""
    simpress_records, simpress_without_serial = _source_table(
        simpress_bytes, "Simpress", SIMPresS_FIELDS, ("serie", "pedido", "ordem_servico")
    )
    oracle_records, oracle_without_serial = _source_table(
        oracle_bytes, "Oracle", ORACLE_FIELDS, ("serie", "solicitacao", "ordem_servico")
    )
    simpress = _group_simpress(simpress_records)
    oracle = _group_oracle(oracle_records)

    tickets: List[Dict[str, Any]] = []
    for serial in sorted(set(simpress) | set(oracle)):
        simpress_data = simpress.get(serial)
        oracle_data = oracle.get(serial, [])
        simpress_os = set(simpress_data["ordens_servico"]) if simpress_data else set()
        oracle_os = {ticket["ordem_servico"] for ticket in oracle_data if ticket["ordem_servico"]}
        normalized_oracle_os = {_identifier_key(item) for item in oracle_os}
        matching_os = sorted(
            value for value in simpress_os
            if _identifier_key(value) in normalized_oracle_os
        )
        if simpress_data and oracle_data:
            if matching_os:
                relation = "conferida"
            elif simpress_os and oracle_os:
                relation = "divergente"
            else:
                relation = "sem_os"
        elif simpress_data:
            relation = "somente_simpress"
        else:
            relation = "somente_oracle"
        tickets.append({
            "serie": simpress_data["serie"] if simpress_data else oracle_data[0]["serie"],
            "relacao": relation,
            "ordens_servico_conferidas": matching_os,
            "simpress": simpress_data or {
                "pedidos": [], "ordens_servico": [], "chamados_cliente": [],
                "status": [], "datas_pedido": [], "modelos": [],
            },
            "oracle": oracle_data,
        })

    counts = Counter(ticket["relacao"] for ticket in tickets)
    return {
        "fontes": {
            "simpress": {
                "arquivo": _safe_filename(simpress_filename),
                "linhas": len(simpress_records),
                "series": len(simpress),
                "linhas_sem_serie": simpress_without_serial,
            },
            "oracle": {
                "arquivo": _safe_filename(oracle_filename),
                "linhas": len(oracle_records),
                "series": len(oracle),
                "linhas_sem_serie": oracle_without_serial,
            },
        },
        "resumo": {
            "series_total": len(tickets),
            "conferidas": counts["conferida"],
            "divergentes": counts["divergente"],
            "sem_os": counts["sem_os"],
            "somente_simpress": counts["somente_simpress"],
            "somente_oracle": counts["somente_oracle"],
        },
        "chamados": tickets,
    }
