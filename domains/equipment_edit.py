"""Equipment edits in the active EquipamentosDetalhes workbook.

Used only by ``POST /api/equipamento/salvar`` (``routers/equipment.py``). The
edit is staged in one atomic transaction with the local alias overrides, and
the derived caches are prepared before the commit, so a failure leaves the
workbook and the published cache unchanged. ``EquipamentosDetalhes`` stays the
official source; InvAll is never written here.

``main.py`` wires file locations and readers in ``EquipmentEditServices`` with
late-bound callables, so tests that patch ``main`` keep affecting these
operations. Errors are domain errors with the same status and detail the
routes answered before; ``payload`` is the route's ``EquipamentoUpdatePayload``.
"""

import hmac
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, ContextManager, Dict, List, Optional, Set, Tuple

from core.config import SUPPORTED_CONTRACT, SUPPORTED_CONTRACT_LEGAL_NAME
from core.errors import DomainConflictError, DomainError
from core.integrity import (
    AtomicFileTransaction,
    FileBusyError,
    FileTransactionError,
    WorkbookSafetyError,
    stage_workbook_update,
)
from core.xlsx_safety import set_cell_value_as_text
from domains import inventory_state
from domains.effective_alias import manual_aliases_by_serial
from domains.inventory_comparison import normalize_reference_value
from domains.inventory_state import STATE_LOCK, format_cep, get_suggested_description, normalize_contract_value
from domains.uploaded_workbooks import (
    DETAILS_ALIAS_HEADER_ALIASES,
    DETAILS_SERIAL_HEADER_ALIASES,
    normalize_workbook_header,
)


@dataclass(frozen=True)
class EquipmentEditServices:
    transaction_root: Callable[[], Path]
    atomic_file_transaction: Callable[[Path, List[Path]], ContextManager[Any]]
    get_details_files: Callable[[], List[Path]]
    get_primary_equipment_file: Callable[[], Optional[Path]]
    find_details_sheet: Callable[[Path], Optional[str]]
    endpoint_upload_file: Callable[[], Path]
    modified_aliases_file: Callable[[], Path]
    alias_history_file: Callable[[], Path]
    load_modified_apelidos: Callable[[], Dict[str, str]]
    read_endpoint_alias_index: Callable[[], Dict[str, Any]]
    apply_effective_alias: Callable[..., Any]
    equipment_revision: Callable[..., str]
    prepare_database_state: Callable[..., Dict[str, Any]]
    publish_database_state: Callable[[Dict[str, Any]], None]


def edit_equipment_workbook(
    services: EquipmentEditServices,
    wb: Any,
    payload: Any,
    target_sheet_name: Optional[str] = None,
    record_must_exist: Optional[bool] = None,
    fields_to_update: Optional[Set[str]] = None,
    expected_revision: Optional[str] = None,
) -> Any:
    if target_sheet_name is None:
        target_sheet_name = next(
            (name for name in wb.sheetnames if "equipamento" in name.lower() or "parque" in name.lower()),
            wb.sheetnames[0] if wb.sheetnames else None,
        )
    elif target_sheet_name not in wb.sheetnames:
        return None
    if target_sheet_name is None:
        return None
    ws = wb[target_sheet_name]
    header_row = [cell.value for cell in next(ws.iter_rows(max_row=1), ())]
    col_map = {
        normalize_workbook_header(value): index + 1
        for index, value in enumerate(header_row)
        if value is not None
    }
    serial_col = next(
        (col_map.get(alias) for alias in DETAILS_SERIAL_HEADER_ALIASES if col_map.get(alias)),
        None,
    )
    if not serial_col:
        return None

    target_serial = normalize_reference_value(payload.serial)
    matching_rows = [
        row for row in range(2, ws.max_row + 1)
        if normalize_reference_value(ws.cell(row=row, column=serial_col).value) == target_serial
        and target_serial
    ]
    if len(matching_rows) > 1:
        raise DomainConflictError(
            f"A série {payload.serial.strip()} aparece mais de uma vez na aba '{ws.title}'; nenhum registro foi alterado."
        )
    if matching_rows:
        contract_col = col_map.get("CODIGOCONTRATO") or col_map.get("CODIGODOCONTRATO")
        if contract_col:
            raw_contract = ws.cell(row=matching_rows[0], column=contract_col).value
            normalized_contract = normalize_contract_value(raw_contract)
            if normalized_contract and normalized_contract != str(SUPPORTED_CONTRACT):
                raise DomainConflictError(
                    f"O equipamento pertence ao contrato {normalized_contract}; "
                    f"este sistema só edita o contrato {SUPPORTED_CONTRACT}."
                )
    if matching_rows and expected_revision:
        target_row_for_revision = matching_rows[0]

        def row_value(*aliases: str) -> Any:
            column = next(
                (col_map.get(normalize_workbook_header(alias)) for alias in aliases
                 if col_map.get(normalize_workbook_header(alias))),
                None,
            )
            return ws.cell(row=target_row_for_revision, column=column).value if column else ""

        current_revision = services.equipment_revision(
            ws.cell(row=target_row_for_revision, column=serial_col).value,
            row_value("MODELO"),
            row_value("TIPO", "CLASSEEQUIPAMENTO"),
            row_value(*DETAILS_ALIAS_HEADER_ALIASES),
            row_value("IDCLIENTE", "ID CLIENTE"),
        )
        if not hmac.compare_digest(expected_revision, current_revision):
            raise DomainConflictError(
                "O equipamento foi alterado desde a leitura; recarregue os dados antes de salvar."
            )
    if record_must_exist is True and not matching_rows:
        raise DomainConflictError(
            f"A série {payload.serial.strip()} não está mais na planilha ativa; recarregue o inventário antes de editar."
        )
    if record_must_exist is False and matching_rows:
        raise DomainConflictError(
            f"A série {payload.serial.strip()} já existe na planilha ativa; recarregue o inventário antes de cadastrar."
        )
    target_row = matching_rows[0] if matching_rows else ws.max_row + 1
    expected: Dict[tuple, Any] = {}
    requested_fields = set(fields_to_update if fields_to_update is not None else payload.model_fields_set)

    def set_value(column: Optional[int], value: Any) -> None:
        if column is None:
            return
        cell = ws.cell(row=target_row, column=column)
        persisted_value = "" if value is None else value
        set_cell_value_as_text(cell, persisted_value)
        expected[(ws.title, cell.coordinate)] = persisted_value

    if not matching_rows:
        set_value(serial_col, payload.serial.strip().upper())
        set_value(col_map.get("CODIGOCONTRATO"), SUPPORTED_CONTRACT)
        set_value(col_map.get("ITEMDECONTRATO"), target_row - 1)
        set_value(col_map.get("RAZAOSOCIAL"), SUPPORTED_CONTRACT_LEGAL_NAME)

    fields = (
        ("apelido", col_map.get("APELIDO")),
        ("modelo", col_map.get("MODELO")),
        ("tipo", col_map.get("TIPO") or col_map.get("CLASSEEQUIPAMENTO")),
        ("idCliente", col_map.get("IDCLIENTE")),
    )
    for field_name, column in fields:
        if matching_rows and field_name not in requested_fields:
            continue
        value = getattr(payload, field_name)
        set_value(column, value.strip() if value is not None else "")

    if not matching_rows:
        from openpyxl.utils.cell import get_column_letter, range_boundaries

        for table in ws.tables.values():
            min_col, min_row, max_col, max_row = range_boundaries(table.ref)
            if min_row == 1 and max_row == target_row - 1 and min_col <= serial_col <= max_col:
                expanded_ref = (
                    f"{get_column_letter(min_col)}{min_row}:"
                    f"{get_column_letter(max_col)}{target_row}"
                )
                table.ref = expanded_ref
                if table.autoFilter is not None:
                    table.autoFilter.ref = expanded_ref

        if ws.auto_filter.ref:
            min_col, min_row, max_col, max_row = range_boundaries(ws.auto_filter.ref)
            if min_row == 1 and max_row == target_row - 1 and min_col <= serial_col <= max_col:
                ws.auto_filter.ref = (
                    f"{get_column_letter(min_col)}{min_row}:"
                    f"{get_column_letter(max_col)}{target_row}"
                )
    return expected


def update_equipment_in_workbook_file(
    services: EquipmentEditServices,
    file_path: Path,
    payload: Any,
    transaction: Optional[AtomicFileTransaction] = None,
    target_sheet_name: Optional[str] = None,
    record_must_exist: Optional[bool] = None,
    fields_to_update: Optional[Set[str]] = None,
    expected_revision: Optional[str] = None,
) -> bool:
    """Prepare and validate a workbook update before its atomic replacement."""
    file_path = Path(file_path)
    if not file_path.exists():
        return False
    try:
        if transaction is not None:
            return stage_workbook_update(
                transaction,
                file_path,
                lambda wb: edit_equipment_workbook(
                    services,
                    wb, payload, target_sheet_name, record_must_exist, fields_to_update, expected_revision
                ),
                allow_dimension_growth=True,
                allow_table_growth=True,
            )
        with services.atomic_file_transaction(services.transaction_root(), [file_path]) as own_transaction:
            saved = stage_workbook_update(
                own_transaction,
                file_path,
                lambda wb: edit_equipment_workbook(
                    services,
                    wb, payload, target_sheet_name, record_must_exist, fields_to_update, expected_revision
                ),
                allow_dimension_growth=True,
                allow_table_growth=True,
            )
            if saved:
                own_transaction.commit()
            return saved
    except FileBusyError as error:
        raise DomainConflictError(str(error)) from error
    except WorkbookSafetyError as error:
        raise DomainConflictError(f"Gravação cancelada: {error}") from error
    except FileTransactionError as error:
        raise DomainError(f"Não foi possível salvar '{file_path.name}': {error}") from error


def normalizar_endereco_instalacao(payload: Any) -> Dict[str, str]:
    endereco = payload.endereco.strip() if payload.endereco else ""
    cidade = payload.cidade.strip() if payload.cidade else ""
    uf = (payload.uf.strip() if payload.uf else "PR").upper()
    cep = format_cep(payload.cep)
    cnpj = payload.cnpj_instalacao.strip() if payload.cnpj_instalacao else ""

    is_sede = (
        ("caeté" in endereco.lower() or "caete" in endereco.lower() or "sede" in endereco.lower() or "sede" in cidade.lower())
        and ("curitiba" in cidade.lower() or "sede" in cidade.lower())
    )
    if is_sede:
        endereco = "R Caeté, 150 - SEDE - Prado Velho"
        cidade = "Curitiba"
        uf = "PR"
        cep = "80220-300"

    return {
        "endereco": endereco,
        "cidade": cidade,
        "uf": uf,
        "cep": cep,
        "cnpj": cnpj,
    }


def snapshot_endereco_instalacao(equipamento: Dict[str, Any]) -> Dict[str, str]:
    return {
        "endereco": str(equipamento.get("endereco_instalacao") or "").strip(),
        "cidade": str(equipamento.get("retirada_cidade") or "").strip(),
        "uf": str(equipamento.get("retirada_uf") or "").strip(),
        "cep": str(equipamento.get("retirada_cep") or "").strip(),
        "cnpj": str(equipamento.get("retirada_cnpj") or "").strip(),
    }


def save_equipment_to_excel(
    services: EquipmentEditServices,
    payload: Any,
    json_mutations: Optional[Dict[Path, Any]] = None,
    fields_to_update: Optional[Set[str]] = None,
) -> Tuple[Dict[str, Any], int]:
    """Salva um equipamento somente na fonte e na aba associadas ao cache atual."""
    target_serial_upper = payload.serial.strip().upper()
    detail_files = [path for path in services.get_details_files() if path.is_file()]
    if not detail_files:
        raise DomainError("Nenhuma planilha da Simpress encontrada no servidor.", status_code=404)

    requested_fields = set(fields_to_update if fields_to_update is not None else payload.model_fields_set)
    json_mutations = dict(json_mutations or {})
    modified_aliases_file = services.modified_aliases_file()
    alias_history_file = services.alias_history_file()
    try:
        # Lock every candidate while resolving the current primary source. Only
        # that source is staged below; legacy copies remain untouched.
        transaction_targets = list(dict.fromkeys([
            *detail_files,
            services.endpoint_upload_file(),
            modified_aliases_file,
            *json_mutations.keys(),
        ]))
        with services.atomic_file_transaction(services.transaction_root(), transaction_targets) as transaction:
            with STATE_LOCK:
                next_equipment_cache = deepcopy(inventory_state.equipamentos_cache)
                next_unit_cache = deepcopy(inventory_state.unidades_cache)
                next_stats_cache = deepcopy(inventory_state.stats_cache)
            cached_equipment = deepcopy(next_equipment_cache.get(target_serial_upper))
            if cached_equipment is None and not payload.novo:
                raise DomainConflictError(
                    "Este equipamento não está mais na base carregada; recarregue o inventário antes de editar."
                )
            expected_revision = payload.revisao
            if cached_equipment is not None:
                current_revision = str(cached_equipment.get("_revisao") or "")
                if not expected_revision:
                    raise DomainConflictError(
                        "A revisão deste equipamento não foi informada; recarregue-o antes de salvar."
                    )
                if not hmac.compare_digest(expected_revision, current_revision):
                    raise DomainConflictError(
                        "O equipamento foi alterado desde a leitura; recarregue os dados antes de salvar."
                    )
            if cached_equipment is not None and payload.novo:
                raise DomainConflictError(
                    "A série já pertence a um equipamento carregado; atualize o inventário antes de cadastrar outra vez."
                )
            if cached_equipment is not None:
                if cached_equipment.get("invall_alias_status") == "serie_detalhes_duplicada":
                    raise DomainConflictError(
                        f"A série {target_serial_upper} está duplicada na base ativa; nenhum registro foi alterado."
                    )
                # Preserve the latest local alias when this save waited behind
                # a concurrent alias edit, and discard a now-stale new-record override.
                payload.apelido = cached_equipment.get(
                    "_apelido_local", cached_equipment.get("_apelido_base", "")
                )
                json_mutations.pop(modified_aliases_file, None)

            active_file = services.get_primary_equipment_file()
            if active_file is None or not active_file.is_file():
                raise DomainError("Nenhuma planilha válida da Simpress está ativa.", status_code=404)

            target_file = active_file.resolve()
            locked_files = {path.resolve() for path in detail_files}
            if target_file not in locked_files:
                raise DomainConflictError(
                    "A lista de inventários mudou durante a edição; recarregue a base e tente novamente."
                )

            cached_source = cached_equipment.get("_source_file") if cached_equipment else None
            if cached_source:
                if Path(cached_source).resolve() != target_file:
                    raise DomainConflictError(
                        "A base ativa mudou depois que este equipamento foi carregado; recarregue-o antes de editar."
                    )

            current_sheet = services.find_details_sheet(target_file)
            if current_sheet is None:
                raise DomainConflictError("A base ativa não contém uma aba de equipamentos válida.")
            cached_sheet = cached_equipment.get("_source_sheet") if cached_equipment else None
            if cached_sheet and cached_sheet != current_sheet:
                raise DomainConflictError(
                    "A aba de origem mudou depois que este equipamento foi carregado; recarregue-o antes de editar."
                )
            target_sheet = cached_sheet or current_sheet

            saved = update_equipment_in_workbook_file(
                services,
                target_file,
                payload,
                transaction,
                target_sheet_name=target_sheet,
                record_must_exist=not payload.novo,
                fields_to_update=requested_fields,
                expected_revision=expected_revision,
            )
            if not saved:
                raise DomainError("Não foi possível atualizar o equipamento na planilha.")
            staged_json: Dict[Path, Any] = {}
            for path, updater in json_mutations.items():
                staged_json[path] = transaction.update_json(
                    path,
                    updater,
                    [] if path == alias_history_file else {},
                )

            endereco_info = (
                snapshot_endereco_instalacao(cached_equipment)
                if cached_equipment
                else normalizar_endereco_instalacao(
                    SimpleNamespace(endereco="", cidade="", uf="PR", cep="", cnpj_instalacao="")
                )
            )
            endereco = endereco_info["endereco"]
            cidade = endereco_info["cidade"]
            uf = endereco_info["uf"]
            cep_formatado = endereco_info["cep"]
            cnpj_instalacao = endereco_info["cnpj"]
            retirada_endereco = f"{endereco} - {cidade}/{uf} - CEP {cep_formatado}" if endereco else f"{cidade}/{uf}"

            def updated_value(field_name: str, cache_key: str) -> str:
                if cached_equipment is not None and field_name not in requested_fields:
                    return str(cached_equipment.get(cache_key) or "").strip()
                value = getattr(payload, field_name)
                return value.strip() if value is not None else ""

            base_alias = updated_value("apelido", "_apelido_base")
            modelo = updated_value("modelo", "modelo")
            tipo = updated_value("tipo", "tipo")
            id_cliente = updated_value("idCliente", "idCliente")
            desc_sugerida = get_suggested_description(tipo, modelo)

            modified_aliases = staged_json.get(modified_aliases_file)
            if not isinstance(modified_aliases, dict):
                modified_aliases = services.load_modified_apelidos()
            manual_aliases = manual_aliases_by_serial(modified_aliases)
            normalized_serial = normalize_reference_value(target_serial_upper)
            local_alias = manual_aliases.get(normalized_serial, base_alias)
            updated_equipment = {
                "serial": target_serial_upper,
                "_source_file": str(target_file),
                "_source_sheet": target_sheet,
                "modelo": modelo,
                "tipo": tipo,
                "apelido": local_alias,
                "_apelido_base": base_alias,
                "_apelido_local": local_alias,
                "_apelido_manual_override": normalized_serial in manual_aliases,
                "_revisao": services.equipment_revision(
                    target_serial_upper, modelo, tipo, base_alias, id_cliente
                ),
                "idCliente": id_cliente,
                "descricao_sugerida": desc_sugerida,
                "endereco_instalacao": endereco,
                "retirada_cnpj": cnpj_instalacao,
                "retirada_endereco": retirada_endereco,
                "retirada_cidade": cidade,
                "retirada_uf": uf,
                "retirada_cep": cep_formatado,
                "contrato": (
                    cached_equipment.get("contrato", str(SUPPORTED_CONTRACT))
                    if cached_equipment else str(SUPPORTED_CONTRACT)
                ),
                "razao_social": (
                    cached_equipment.get("razao_social", SUPPORTED_CONTRACT_LEGAL_NAME)
                    if cached_equipment else SUPPORTED_CONTRACT_LEGAL_NAME
                ),
            }

            endpoint_index = services.read_endpoint_alias_index()
            services.apply_effective_alias(
                updated_equipment,
                endpoint_index,
                details_duplicate=bool(
                    cached_equipment
                    and cached_equipment.get("invall_alias_status") == "serie_detalhes_duplicada"
                ),
            )
            next_equipment_cache[target_serial_upper] = updated_equipment
            next_stats_cache["total_equipamentos"] = len(next_equipment_cache)
            next_stats_cache["ultima_atualizacao"] = datetime.now().strftime("%d/%m/%Y %H:%M")
            prepared_state = services.prepare_database_state(
                next_equipment_cache,
                next_unit_cache,
                next_stats_cache,
            )

            # All reads and derived data are prepared before the durable commit.
            # Publishing afterward only swaps already-built references.
            transaction.commit()
            services.publish_database_state(prepared_state)
            return updated_equipment, len(modified_aliases)
    except FileBusyError as error:
        raise DomainConflictError(str(error)) from error
    except WorkbookSafetyError as error:
        raise DomainConflictError(f"Gravação cancelada: {error}") from error
    except FileTransactionError as error:
        raise DomainError(f"Não foi possível concluir a gravação: {error}") from error
