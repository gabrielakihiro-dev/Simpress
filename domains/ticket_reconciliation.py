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
    "ordem_venda": ("ordemvenda", "ordemdevenda", "ov"),
    "ordem_servico": ("ordemservico", "os"),
    "chamado_cliente": ("numerochamadocliente",),
    "status": ("statusatual",),
    "previsao_entrega": ("previsaoentrega", "previsaodeentrega"),
    "data_pedido": ("datapedido",),
    "modelo": ("modelodoequipamento",),
    "descricao_produto": ("descricaoproduto",),
    "cidade_entrega": ("cidadeentrega",),
    "endereco_entrega": ("enderecoentrega",),
    "numero_entrega": ("numeroentrega",),
    "complemento_entrega": ("complementoentrega",),
    "bairro_entrega": ("bairroentrega",),
    "estado_entrega": ("estadoentrega",),
    "cep_entrega": ("cepentrega",),
}

ORACLE_FIELDS = {
    "serie": ("numerodeserie", "numeroserie", "serial", "servicetag"),
    "solicitacao": ("solicitacao", "numerosolicitacao"),
    "ordem_servico": ("idoscorporate", "ordemservico", "os"),
    "logradouro": ("logradouro",),
    "numero_endereco": ("numero", "numeroendereco"),
    "bairro": ("bairro",),
    "cidade": ("cidade",),
    "atendido_pela_inibicao": ("atendidopelainibicao", "atendidopelainhibicao"),
    "nome_filial": ("nomedafilial", "filial"),
    "status": ("status",),
    "sub_status": ("substatus",),
    "fila": ("fila",),
    "fase_atendimento": ("fasedeatendimento",),
    "status_entregas": ("statusdasentregas",),
    "status_atividades": ("statusdasatividades",),
    "assunto": ("assunto",),
    "descricao": ("descricao", "descricaodochamado", "descricaosolicitacao", "descricaodasolicitacoes"),
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


def _simpress_date_text(value: Any) -> str:
    text = _text(value)
    parsed = _parse_order_date(text)
    return parsed.strftime("%d/%m/%Y") if parsed else text


def _serial_key(value: Any) -> str:
    normalized = unicodedata.normalize("NFKD", _text(value)).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^A-Z0-9]+", "", normalized.upper())


def _identifier_key(value: str) -> str:
    return re.sub(r"\s+", "", value).upper()


def _parse_order_date(value: str) -> Optional[datetime]:
    if not value:
        return None
    text = value.strip()
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        pass
    for date_format in (
        "%d/%m/%Y %H:%M:%S",
        "%d/%m/%Y %H:%M",
        "%d/%m/%Y %I:%M:%S %p",
        "%d/%m/%Y",
        "%Y-%m-%d",
    ):
        try:
            return datetime.strptime(text, date_format)
        except ValueError:
            continue
    return None


def _numeric_order_service(value: str) -> Optional[int]:
    normalized = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    if re.search(r"[A-Za-z]", normalized):
        return None
    digits = re.sub(r"\D", "", normalized)
    return int(digits) if digits else None


def _order_service_descending_key(value: Any) -> Tuple[bool, int, str]:
    text = _text(value)
    number = _numeric_order_service(text)
    return number is not None, number if number is not None else -1, _identifier_key(text)


def _latest_order_service(candidates: Sequence[Tuple[str, str]]) -> str:
    """Return the newest OS by source date, falling back to its numeric ID."""
    valid = [(order.strip(), created_at.strip()) for order, created_at in candidates if order.strip()]
    if not valid:
        return ""

    dated = [(order, created_at, _parse_order_date(created_at)) for order, created_at in valid]
    if all(created_at is not None for _, _, created_at in dated):
        return max(
            dated,
            key=lambda item: (item[2], _numeric_order_service(item[0]) or -1),
        )[0]

    numeric = [(order, _numeric_order_service(order)) for order, _ in valid]
    if all(order_number is not None for _, order_number in numeric):
        numeric_candidates: List[Tuple[str, int]] = [
            (order, order_number)
            for order, order_number in numeric
            if order_number is not None
        ]
        return max(numeric_candidates, key=lambda item: item[1])[0]

    # Exports commonly list current requests after older ones when IDs are not numeric.
    return valid[-1][0]


def _latest_simpress_identifier(candidates: Sequence[str]) -> str:
    """Simpress order and OS numbers increase over time; use the greatest numeric ID."""
    valid = [identifier.strip() for identifier in candidates if identifier.strip()]
    if not valid:
        return ""
    numeric = [(identifier, _numeric_order_service(identifier)) for identifier in valid]
    if all(identifier_number is not None for _, identifier_number in numeric):
        numeric_candidates: List[Tuple[str, int]] = [
            (identifier, identifier_number)
            for identifier, identifier_number in numeric
            if identifier_number is not None
        ]
        return max(numeric_candidates, key=lambda item: item[1])[0]
    return valid[-1]


def _split_order_services(value: str) -> List[str]:
    return [item.strip() for item in re.split(r"[,;\n|]+", value) if item.strip()]


def _simpress_order_in_progress(status: str) -> bool:
    normalized = normalize_header(status)
    if not normalized:
        return False
    if any(token in normalized for token in ("entregue", "cancelad", "conclu", "encerrad", "finalizad")):
        return False
    return any(token in normalized for token in (
        "verificacao", "liberacao", "process", "separ", "notafiscal",
        "aguard", "andamento", "transit", "transporte",
    ))


def _delivery_address(record: Dict[str, Any]) -> str:
    street = record.get("endereco_entrega", "").strip()
    number = record.get("numero_entrega", "").strip()
    address = f"{street}, {number}" if street and number else street or number
    parts = [address] if address else []
    parts.extend(
        value for value in (
            record.get("complemento_entrega", "").strip(),
            record.get("bairro_entrega", "").strip(),
        ) if value
    )
    city = record.get("cidade_entrega", "").strip()
    state = record.get("estado_entrega", "").strip()
    city_state = " - ".join(value for value in (city, state) if value)
    if city_state:
        parts.append(city_state)
    postal_code = record.get("cep_entrega", "").strip()
    if postal_code:
        parts.append(f"CEP {postal_code}")
    return ", ".join(parts)


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
                raw_value = values[index] if index < len(values) else None
                record[field] = _simpress_date_text(raw_value) if field == "previsao_entrega" else _text(raw_value)
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


def _group_simpress(records: Iterable[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    source_rows: Dict[str, Dict[str, Any]] = OrderedDict()
    for record in records:
        serial = record["serie_chave"]
        source_group = source_rows.setdefault(serial, {
            "serie": record["serie"],
            "records": [],
        })
        source_group["records"].append(record)

    grouped: Dict[str, Dict[str, Any]] = OrderedDict()
    for serial, source_group in source_rows.items():
        source_records = source_group["records"]
        os_candidates = [
            order
            for record in source_records
            for order in _split_order_services(record.get("ordem_servico", ""))
        ]
        latest_os = _latest_simpress_identifier(os_candidates)
        latest_key = _identifier_key(latest_os) if latest_os else ""
        current_records = []
        for record in source_records:
            row_os = _split_order_services(record.get("ordem_servico", ""))
            if latest_key and not any(_identifier_key(order) == latest_key for order in row_os):
                continue
            current_records.append(record)
        pedido_candidates = [
            pedido
            for record in current_records
            for pedido in _split_order_services(record.get("pedido", ""))
        ]
        latest_pedido = _latest_simpress_identifier(pedido_candidates)
        latest_pedido_key = _identifier_key(latest_pedido) if latest_pedido else ""
        ticket_group: Dict[str, Any] = {
            "serie": source_group["serie"], "pedidos": [], "ordens_venda": [], "ordens_servico": [], "chamados_cliente": [],
            "status": [], "datas_pedido": [], "modelos": [], "descricoes_produto": [],
            "previsoes_entrega": [], "cidades_entrega": [], "enderecos_entrega": [], "pedido_em_andamento": False,
        }
        for record in current_records:
            row_os = _split_order_services(record.get("ordem_servico", ""))
            if latest_key and not any(_identifier_key(order) == latest_key for order in row_os):
                continue
            row_pedidos = _split_order_services(record.get("pedido", ""))
            if latest_pedido_key and not any(_identifier_key(pedido) == latest_pedido_key for pedido in row_pedidos):
                continue
            for source_field, target_field in (
                ("chamado_cliente", "chamados_cliente"),
                ("status", "status"),
                ("data_pedido", "datas_pedido"),
                ("modelo", "modelos"),
                ("descricao_produto", "descricoes_produto"),
                ("previsao_entrega", "previsoes_entrega"),
                ("cidade_entrega", "cidades_entrega"),
            ):
                _add_unique(ticket_group[target_field], record.get(source_field, ""))
            if _simpress_order_in_progress(record.get("status", "")):
                ticket_group["pedido_em_andamento"] = True
                _add_unique(ticket_group["enderecos_entrega"], _delivery_address(record))
            for pedido in row_pedidos:
                if not latest_pedido_key or _identifier_key(pedido) == latest_pedido_key:
                    _add_unique(ticket_group["pedidos"], pedido)
            for order_of_sale in _split_order_services(record.get("ordem_venda", "")):
                _add_unique(ticket_group["ordens_venda"], order_of_sale)
            for order in row_os:
                if not latest_key or _identifier_key(order) == latest_key:
                    _add_unique(ticket_group["ordens_servico"], order)
        grouped[serial] = ticket_group
    return grouped


def _group_oracle(records: Iterable[Dict[str, Any]]) -> Dict[str, List[Dict[str, str]]]:
    grouped: Dict[str, List[Dict[str, str]]] = OrderedDict()
    seen: Dict[str, set[Tuple[str, ...]]] = {}
    exposed_fields = (
        "solicitacao", "ordem_servico", "logradouro", "numero_endereco", "bairro", "cidade",
        "atendido_pela_inibicao", "nome_filial", "status", "sub_status", "fila",
        "fase_atendimento", "status_entregas", "status_atividades", "assunto", "descricao",
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


def _keep_latest_oracle_order(tickets: List[Dict[str, str]]) -> List[Dict[str, str]]:
    candidates = [
        (ticket.get("ordem_servico", ""), ticket.get("data_criacao", ""))
        for ticket in tickets
        if ticket.get("ordem_servico", "")
    ]
    latest = _latest_order_service(candidates)
    if not latest:
        return tickets
    latest_key = _identifier_key(latest)
    return sorted(
        (
            ticket for ticket in tickets
            if ticket.get("ordem_servico", "") and _identifier_key(ticket["ordem_servico"]) == latest_key
        ),
        key=lambda ticket: _order_service_descending_key(ticket.get("ordem_servico", "")),
        reverse=True,
    )


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
        oracle_data = _keep_latest_oracle_order(oracle.get(serial, []))
        simpress_os = set(simpress_data["ordens_servico"]) if simpress_data else set()
        oracle_os = {ticket["ordem_servico"] for ticket in oracle_data if ticket["ordem_servico"]}
        normalized_oracle_os = {_identifier_key(item) for item in oracle_os}
        matching_os = sorted(
            (value for value in simpress_os if _identifier_key(value) in normalized_oracle_os),
            key=_order_service_descending_key,
            reverse=True,
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
                "pedidos": [], "ordens_venda": [], "ordens_servico": [], "chamados_cliente": [],
                "status": [], "datas_pedido": [], "modelos": [], "descricoes_produto": [],
                "previsoes_entrega": [], "cidades_entrega": [], "enderecos_entrega": [], "pedido_em_andamento": False,
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
