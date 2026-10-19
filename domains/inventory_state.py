"""In-memory inventory state built from the active EquipamentosDetalhes.

The published caches (equipment by serial, units and stats), the search index
derived from them and the signature of the files they were read from live here
as module attributes; read them as ``inventory_state.<name>`` so a publication
is always seen. Writers replace them only through ``publish_database_state`` or
``restore_state``, holding ``STATE_LOCK``. ``main.py`` wires the file readers in
``InventoryStateServices`` with late-bound callables, so tests that patch
``main`` keep affecting the load.

Lock hierarchy (docs/arquitetura/auditoria_backend/hierarquia_de_locks.md):
``STATE_LOCK`` is a leaf lock; never open a transaction or lock files while
holding it.
"""

import hashlib
import logging
import re
import threading
import unicodedata
from collections import Counter
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Set, Tuple

from core.config import SUPPORTED_CONTRACT, SUPPORTED_CONTRACT_LEGAL_NAME
from core.integrity import FileBusyError
from core.xlsx_safety import WORKBOOK_READ_ERRORS
from domains.effective_alias import manual_aliases_by_serial
from domains.equipment_search import EquipmentSearchIndexEntry
from domains.inventory_comparison import is_missing_cell_value, normalize_reference_value
from domains.uploaded_workbooks import (
    DETAILS_ALIAS_HEADER_ALIASES,
    DETAILS_INSTALLATION_CNPJ_HEADER_ALIASES,
    DETAILS_SERIAL_HEADER_ALIASES,
    DETAILS_TYPE_HEADER_ALIASES,
    normalize_workbook_header,
)


STATE_LOCK = threading.RLock()

# Published state; publications replace these objects instead of mutating them.
equipamentos_cache: Dict[str, Dict[str, Any]] = {}
unidades_cache: List[Dict[str, Any]] = []
stats_cache: Dict[str, Any] = {}
equipment_search_index: Tuple[EquipmentSearchIndexEntry, ...] = ()
equipment_search_index_source: Optional[Dict[str, Dict[str, Any]]] = None
# Files behind the published cache; None until the first publication.
loaded_files_signature: Optional[tuple] = None


@dataclass(frozen=True)
class InventoryStateServices:
    get_parque_file: Callable[[], Optional[Path]]
    input_dir: Callable[[], Path]
    find_details_sheet: Callable[[Path], Optional[str]]
    read_details_sheet_records: Callable[[Path, str], Tuple[Any, Any]]
    load_custom_units: Callable[[], List[Dict[str, Any]]]
    load_modified_apelidos: Callable[[], Dict[str, str]]
    read_endpoint_alias_index: Callable[[], Dict[str, Any]]
    equipment_revision: Callable[[Any, Any, Any, Any, Any], str]
    apply_effective_alias: Callable[..., None]
    count_export_changes: Callable[..., Dict[str, int]]
    get_export_status: Callable[[], Dict[str, Any]]
    prepare_database_state: Callable[[Dict[str, Dict[str, Any]], List[Dict[str, Any]], Dict[str, Any]], Dict[str, Any]]
    publish_database_state: Callable[[Dict[str, Any]], None]
    build_search_index: Callable[..., Tuple[EquipmentSearchIndexEntry, ...]]
    normalize_search_term: Callable[[Any], str]
    inventory_files: Callable[[], Iterable[Path]]
    logger: logging.Logger


def format_cep(val: Any) -> str:
    if val is None:
        return ""
    if is_missing_cell_value(val):
        return ""
    original = str(val).strip()
    if not original:
        return ""
    digits = re.sub(r"\D", "", original)
    if len(digits) != 8:
        return original
    return f"{digits[:5]}-{digits[5:]}"

def get_suggested_description(tipo: Optional[str], modelo: Optional[str]) -> str:
    t = (tipo or "").strip().lower()
    m = (modelo or "").strip()
    if "notebook" in t:
        return "Notebook + kit na mochila"
    elif "micro" in t or "computador" in t:
        return f"{m} + cabos e periféricos"
    elif "headset" in t:
        return f"Headset {m}"
    return f"{tipo} {m}".strip() if tipo else m

def sanitize_value(val: Any, default: str = "") -> str:
    if is_missing_cell_value(val):
        return default
    return str(val).strip()


def normalize_contract_value(value: Any) -> str:
    """Normalize Excel integer cells without accepting a different contract."""
    normalized = sanitize_value(value).strip()
    if re.fullmatch(r"\d+\.0+", normalized):
        normalized = normalized.split(".", 1)[0]
    return normalized


def _coerce_unit_id(value: Any) -> Optional[int]:
    if isinstance(value, bool) or value is None:
        return None
    try:
        unit_id = int(value)
    except (TypeError, ValueError):
        return None
    return unit_id if unit_id > 0 else None


def _unit_identity_key(unit: Dict[str, Any]) -> str:
    return "\x1f".join(
        unicodedata.normalize("NFKC", str(unit.get(field) or "")).strip().casefold()
        for field in ("cidade", "endereco", "cnpj", "uf")
    )


def _stable_unit_source_key(unit: Dict[str, Any]) -> str:
    """Keep inventory identity stable while editable location fields change."""
    return hashlib.sha256(_unit_identity_key(unit).encode("utf-8")).hexdigest()


def _stable_unit_id(unit: Dict[str, Any], reserved_ids: Set[int]) -> int:
    """Return a deterministic numeric ID for inventory-derived units."""
    identity = _unit_identity_key(unit)
    collision_index = 0
    while True:
        seed = identity if collision_index == 0 else f"{identity}\x1f{collision_index}"
        candidate = int.from_bytes(hashlib.sha256(seed.encode("utf-8")).digest()[:6], "big") or 1
        if candidate not in reserved_ids:
            return candidate
        collision_index += 1


def prepare_database_state(
    equipment_cache: Dict[str, Dict[str, Any]],
    unit_cache: List[Dict[str, Any]],
    stats: Dict[str, Any],
    services: InventoryStateServices,
) -> Dict[str, Any]:
    """Build every derived cache before a disk transaction is committed."""
    return {
        "equipamentos_cache": equipment_cache,
        "unidades_cache": unit_cache,
        "stats_cache": stats,
        "equipment_search_index": services.build_search_index(
            equipment_cache,
            services.normalize_search_term,
        ),
    }


def inventory_files_signature(services: InventoryStateServices) -> tuple:
    signature: List[Any] = []
    for path in services.inventory_files():
        try:
            stat = path.stat()
            signature.append((str(path), stat.st_size, stat.st_mtime_ns))
        except OSError:
            signature.append((str(path), None))
    return tuple(signature)


def publish_database_state(state: Dict[str, Any], services: InventoryStateServices) -> None:
    global equipamentos_cache, unidades_cache, stats_cache
    global equipment_search_index, equipment_search_index_source, loaded_files_signature
    # Callers publish while holding the file locks of the state they read or committed.
    try:
        files_signature: Optional[tuple] = inventory_files_signature(services)
    except OSError:
        files_signature = None
    with STATE_LOCK:
        loaded_files_signature = files_signature
        equipamentos_cache = state["equipamentos_cache"]
        unidades_cache = state["unidades_cache"]
        stats_cache = state["stats_cache"]
        equipment_search_index = state["equipment_search_index"]
        equipment_search_index_source = equipamentos_cache


InventorySnapshot = Tuple[Dict[str, Dict[str, Any]], List[Dict[str, Any]], Dict[str, Any]]


def snapshot_state() -> InventorySnapshot:
    """Return a private copy of the caches for ``restore_state``. Hold STATE_LOCK."""
    return deepcopy(equipamentos_cache), deepcopy(unidades_cache), deepcopy(stats_cache)


def restore_state(snapshot: InventorySnapshot) -> None:
    """Put back a ``snapshot_state`` result. Hold STATE_LOCK."""
    global equipamentos_cache, unidades_cache, stats_cache
    equipamentos_cache, unidades_cache, stats_cache = snapshot


def refresh_search_index_locked(services: InventoryStateServices) -> None:
    """Precompute normalized searchable values once per published cache generation."""
    global equipment_search_index, equipment_search_index_source
    equipment_search_index = services.build_search_index(equipamentos_cache, services.normalize_search_term)
    equipment_search_index_source = equipamentos_cache


def current_search_index(services: InventoryStateServices) -> Tuple[EquipmentSearchIndexEntry, ...]:
    """Return the index of the published cache, rebuilding it after a direct replacement."""
    with STATE_LOCK:
        if equipment_search_index_source is not equipamentos_cache:
            refresh_search_index_locked(services)
        return equipment_search_index


def load_database_unlocked(services: InventoryStateServices, publish: bool = True) -> Any:
    """Read the active EquipamentosDetalhes and build (and optionally publish) the caches.

    Every derived value is built before publishing, so a read or validation
    failure keeps the previously published state.
    """
    logger = services.logger
    try:
        active_details_file = services.get_parque_file()
    except FileBusyError as error:
        logger.warning("%s A base carregada foi mantida.", error)
        return False
    if active_details_file is None or not active_details_file.exists():
        logger.warning("Nenhuma planilha EquipamentosDetalhes válida encontrada em %s.", services.input_dir())
        return False

    logger.info("Carregando equipamentos de %s...", active_details_file.name)
    
    # Usa a aba com os campos necessários, sem depender do nome da aba.
    try:
        sheet_target = services.find_details_sheet(active_details_file)
        if sheet_target is None:
            logger.error("%s não contém cabeçalhos EquipamentosDetalhes válidos.", active_details_file.name)
            return False
        headers, records = services.read_details_sheet_records(active_details_file, sheet_target)
    except (FileBusyError, *WORKBOOK_READ_ERRORS) as error:
        logger.warning(
            "Falha ao ler base de equipamentos (arquivo=%s, papel=detalhes, erro=%s).",
            active_details_file.name, type(error).__name__,
        )
        return False

    # Strip column names e criar mapa normalizado de colunas
    norm_cols = {normalize_workbook_header(column): column for column in headers}
    new_equipamentos_cache: Dict[str, Dict[str, Any]] = {}
    details_serial_counts: Dict[str, int] = {}
    tipo_header_aliases = DETAILS_TYPE_HEADER_ALIASES

    def get_row_val(row: Dict[str, Any], *aliases: str, default: str = "") -> str:
        for a in aliases:
            key = normalize_workbook_header(a)
            if key in norm_cols:
                val = row.get(norm_cols[key])
                if not is_missing_cell_value(val):
                    return sanitize_value(val, default)
        return default

    def get_installation_cnpj(row: Dict[str, Any]) -> str:
        value = get_row_val(row, *DETAILS_INSTALLATION_CNPJ_HEADER_ALIASES)
        if value:
            return value
        for normalized_header, source_header in norm_cols.items():
            if (
                "CNPJ" in normalized_header
                and ("INSTALACAO" in normalized_header or "FILIAL" in normalized_header)
                and "FATURAMENTO" not in normalized_header
            ):
                raw_value = row.get(source_header)
                if not is_missing_cell_value(raw_value):
                    return sanitize_value(raw_value)
        return ""

    unidades_dict: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
    sede_cnpjs = set()

    rows_without_serial = 0
    for row in records:
        raw_serial = get_row_val(row, *DETAILS_SERIAL_HEADER_ALIASES)
        if not raw_serial:
            rows_without_serial += any(not is_missing_cell_value(value) for value in row.values())
            continue
        
        serial_key = raw_serial.upper()
        normalized_serial = normalize_reference_value(raw_serial)
        details_serial_counts[normalized_serial] = details_serial_counts.get(normalized_serial, 0) + 1
        modelo = get_row_val(row, "Modelo")
        tipo = get_row_val(row, *tipo_header_aliases)
        apelido = get_row_val(row, *DETAILS_ALIAS_HEADER_ALIASES)
        id_cliente = get_row_val(row, "IdCliente", "Id Cliente")
        endereco = get_row_val(row, "Endereco", "Endereço")
        cidade = get_row_val(row, "Cidade")
        uf = get_row_val(row, "UF", default="PR")
        raw_cep = get_row_val(row, "CEP")
        cep_formatado = format_cep(raw_cep)
        
        cnpj_instalacao = get_installation_cnpj(row)

        contrato_value = get_row_val(
            row, "CodigoContrato", "Codigo Contrato", default=str(SUPPORTED_CONTRACT)
        )
        contrato = normalize_contract_value(contrato_value) or str(SUPPORTED_CONTRACT)
        if contrato != str(SUPPORTED_CONTRACT):
            logger.error(
                "A base contém contrato %s; somente o contrato %s é suportado. O cache anterior foi mantido.",
                contrato,
                SUPPORTED_CONTRACT,
            )
            return False
        razao_social = get_row_val(
            row, "RazaoSocial", "Razao Social", default=SUPPORTED_CONTRACT_LEGAL_NAME
        ) or SUPPORTED_CONTRACT_LEGAL_NAME

        # Check if Sede Curitiba
        is_sede = ("caeté" in endereco.lower() or "caete" in endereco.lower() or "sede" in endereco.lower() or "sede" in cidade.lower()) and ("curitiba" in cidade.lower() or "sede" in cidade.lower())
        if is_sede:
            if cnpj_instalacao:
                sede_cnpjs.add(cnpj_instalacao)
            endereco = "R Caeté, 150 - SEDE - Prado Velho"
            cidade = "Curitiba"
            uf = "PR"
            cep_formatado = "80220-300"
            retirada_endereco = "R Caeté, 150 - SEDE - Prado Velho - Curitiba/PR - CEP 80220-300"
        else:
            retirada_endereco = f"{endereco} - {cidade}/{uf} - CEP {cep_formatado}" if endereco else f"{cidade}/{uf}"

        # Suggested description
        desc_sugerida = get_suggested_description(tipo, modelo)

        new_equipamentos_cache[serial_key] = {
            "serial": raw_serial,
            "_source_file": str(active_details_file.resolve()),
            "_source_sheet": sheet_target,
            "modelo": modelo,
            "tipo": tipo,
            "apelido": apelido,
            "_apelido_base": apelido,
            "_apelido_local": apelido,
            "idCliente": id_cliente,
            "descricao_sugerida": desc_sugerida,
            "endereco_instalacao": endereco,
            "retirada_cnpj": cnpj_instalacao,
            "retirada_endereco": retirada_endereco,
            "retirada_cidade": cidade,
            "retirada_uf": uf,
            "retirada_cep": cep_formatado,
            "contrato": contrato,
            "razao_social": razao_social
        }

        # Candidate unit
        if cidade or endereco:
            u_key = (cidade.strip(), endereco.strip(), cnpj_instalacao.strip())
            if u_key not in unidades_dict:
                unidades_dict[u_key] = {
                    "cidade": cidade.strip(),
                    "endereco": endereco.strip(),
                    "uf": uf.strip(),
                    "cep": cep_formatado.strip(),
                    "cnpj": cnpj_instalacao.strip(),
                    "retirada_endereco": retirada_endereco
                }

    if not new_equipamentos_cache:
        logger.error("%s não contém equipamentos com número de série; os dados atuais foram mantidos.", active_details_file.name)
        return False

    # Filter units according to user specifications:
    filtered_units: List[Dict[str, Any]] = []
    for u in unidades_dict.values():
        cid_lower = u["cidade"].lower()
        end_lower = u["endereco"].lower()

        # 1. Curitiba: remover todas as outras (oficial Curitiba SEDE será inserido exclusivamente)
        if "curitiba" in cid_lower:
            continue

        # 2. Cascavel: somente ao lado da Plantar
        if "cascavel" in cid_lower:
            if "plantar" not in end_lower:
                continue

        # 3. Foz do Iguaçu: só deixe uma (duplicada)
        if "foz do igua" in cid_lower:
            if any("foz do igua" in x["cidade"].lower() for x in filtered_units):
                continue

        # 4. Maringá: deixe só o Terreo
        if "maring" in cid_lower:
            if "terreo" not in end_lower and "térreo" not in end_lower:
                continue

        # 5. Telêmaco Borba: deixe só o da Sala 1
        if "tel" in cid_lower and "borba" in cid_lower:
            if "sala 1" not in end_lower:
                continue

        # 6. Toledo: deixe só com os caracteres minúsculos (ignorar a versão em CAIXA ALTA)
        if "toledo" in cid_lower:
            if u["endereco"].isupper():
                continue

        filtered_units.append(u)

    # Inserir o Curitiba oficial com o padrão exato solicitado
    sede_cnpj = next(iter(sede_cnpjs)) if len(sede_cnpjs) == 1 else ""
    if len(sede_cnpjs) > 1:
        logger.warning("A base contém mais de um CNPJ de instalação para a Sede Curitiba; o CNPJ da unidade ficou vazio.")
    curitiba_label = "Curitiba - R Caeté, 150 - SEDE - Prado Velho"
    if sede_cnpj:
        curitiba_label += f" ({sede_cnpj})"
    curitiba_oficial = {
        "cidade": "Curitiba",
        "endereco": "R Caeté, 150 - SEDE - Prado Velho",
        "uf": "PR",
        "cep": "80220-300",
        "cnpj": sede_cnpj,
        "is_sede": True,
        "endereco_completo": "R Caeté, 150 - SEDE - Prado Velho - Curitiba/PR - CEP 80220-300",
        "label": curitiba_label,
    }
    curitiba_oficial["_source_key"] = _stable_unit_source_key(curitiba_oficial)

    final_units = [curitiba_oficial]
    for u in filtered_units:
        final_units.append({
            "cidade": u["cidade"],
            "endereco": u["endereco"],
            "uf": u["uf"],
            "cep": u["cep"],
            "cnpj": u["cnpj"],
            "is_sede": False,
            "endereco_completo": u["retirada_endereco"],
            "label": f"{u['cidade']} - {u['endereco']}" + (f" ({u['cnpj']})" if u["cnpj"] else ""),
            "_source_key": _stable_unit_source_key(u),
        })

    # Mesclar unidades customizadas/editadas pelo usuário
    custom_units = services.load_custom_units()
    for cu in custom_units:
        source_key = cu.get("_source_key")
        if source_key:
            match = next((x for x in final_units if x.get("_source_key") == source_key), None)
        else:
            match = next((
                x for x in final_units
                if str(x.get("cidade") or "").lower() == str(cu.get("cidade") or "").lower()
                and x.get("cnpj") == cu.get("cnpj")
            ), None)
        if match:
            match.update(cu)
        else:
            final_units.append(cu)

    # Sort for display, but retain persisted IDs and give inventory-derived
    # units a deterministic ID that does not depend on their position.
    new_unidades_cache = sorted(final_units, key=lambda u: (not u.get("is_sede", False), u.get("cidade", ""), u.get("endereco", "")))
    reserved_unit_ids = {
        unit_id
        for unit in custom_units
        if (unit_id := _coerce_unit_id(unit.get("id"))) is not None
    }
    reserved_unit_ids.update(
        unit_id
        for unit in new_unidades_cache
        if (unit_id := _coerce_unit_id(unit.get("id"))) is not None
    )
    for unit in new_unidades_cache:
        if _coerce_unit_id(unit.get("id")) is not None:
            continue
        generated_id = _stable_unit_id(unit, reserved_unit_ids)
        unit["id"] = generated_id
        reserved_unit_ids.add(generated_id)

    # Apelidos manuais persistem por série e prevalecem sobre o hostname da InvAll.
    mod_apelidos = services.load_modified_apelidos()
    manual_aliases = manual_aliases_by_serial(mod_apelidos)
    endpoint_index = services.read_endpoint_alias_index()
    for serial_key, equipment in new_equipamentos_cache.items():
        equipment["_revisao"] = services.equipment_revision(
            equipment.get("serial"),
            equipment.get("modelo"),
            equipment.get("tipo"),
            equipment.get("_apelido_base"),
            equipment.get("idCliente"),
        )
        normalized_serial = normalize_reference_value(equipment.get("serial"))
        equipment["_apelido_manual_override"] = normalized_serial in manual_aliases
        equipment["_apelido_local"] = manual_aliases.get(
            normalized_serial, equipment.get("_apelido_base", "")
        )
        services.apply_effective_alias(
            equipment,
            endpoint_index,
            details_duplicate=details_serial_counts.get(normalized_serial, 0) > 1,
        )

    # Calculate stats
    tipo_col_real = next(
        (
            norm_cols[normalized_header]
            for alias in tipo_header_aliases
            if (normalized_header := normalize_workbook_header(alias)) in norm_cols
        ),
        None,
    )
    type_counts = (
        dict(Counter(row.get(tipo_col_real, "") for row in records).most_common())
        if tipo_col_real is not None
        else {}
    )
    export_counts = services.count_export_changes(
        locked=True,
        endpoint_index=endpoint_index,
    )
    export_status = services.get_export_status()
    new_stats_cache = {
        "total_equipamentos": len(new_equipamentos_cache),
        "total_unidades": len(new_unidades_cache),
        "total_apelidos_modificados": export_counts["apelidos"],
        "total_id_clientes_modificados": export_counts["id_clientes"],
        "total_alteracoes_exportaveis": export_counts["total"],
        "exportacao_disponivel": export_status["available"],
        "exportacao_motivo": export_status["reason"],
        "tipos": type_counts,
        # Flagged in the monthly report; they never change the total of unique serials.
        "linhas_sem_serie": rows_without_serial,
        "series_duplicadas": {serial: count for serial, count in details_serial_counts.items() if count > 1},
        "arquivo_origem": active_details_file.name,
        "ultima_atualizacao": datetime.now().strftime("%d/%m/%Y %H:%M")
    }

    # Só publica os novos caches depois de ler, converter e validar toda a planilha.
    state = services.prepare_database_state(
        new_equipamentos_cache,
        new_unidades_cache,
        new_stats_cache,
    )
    if publish:
        services.publish_database_state(state)

    logger.info(
        "Base carregada: %d equipamentos (%d com apelido modificado) e %d unidades catalogadas.",
        len(new_equipamentos_cache),
        len(mod_apelidos),
        len(new_unidades_cache),
    )
    if not publish:
        return state
    return True
