"""Readiness report: which local files are usable and which features they enable.

The report reads files without the global ``.atomic-transactions`` lock. Writers
replace files with ``os.replace``, so a reader sees either the previous or the
new version. ``ReadinessReportCache`` keeps a report for a short time and only
while the stat signature of the files it depends on and the loaded state stay
the same, so repeated polls do not reopen every workbook.
"""

import json
import logging
import threading
import time
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Hashable, Iterable, List, Optional, Tuple, Type

from core.config import format_size_limit
from core.errors import DomainError
from core.integrity import FileBusyError, WorkbookSafetyError
from core.xlsx_safety import WORKBOOK_READ_ERRORS, XlsxLimitExceeded, XlsxPackageError, validate_xlsx


READINESS_REPORT_CACHE_SECONDS = 2.0
READY_WORKBOOK_CACHE_LIMIT = 64

FILE_LABELS = {
    "template_transferencia": "Modelo de transferência",
    "inventario_equipamentos": "Inventário ativo EquipamentosDetalhes",
    "inventario_detalhes_atualizacao": "EquipamentosDetalhes para atualização",
    "inventario_endpoint": "Inventário InvAllComputersSummary",
    "modelo_exportacao": "Modelo de exportação",
    "catalogos_locais": "Catálogos e históricos locais",
    "historico_chamados": "Histórico do acompanhamento de chamados",
    "nomes_entra": "Nomes do Microsoft Entra",
}

FUNCTION_LABELS = {
    "consulta_equipamentos": "Consulta de equipamentos",
    "geracao_transferencia": "Geração de planilha de transferência",
    "comparacao_atualizacao_inventarios": "Comparação e atualização de inventários",
    "exportacao_equipamentos": "Exportação de equipamentos",
    "acompanhamento_chamados": "Acompanhamento de chamados",
}

FUNCTION_REQUIREMENTS = {
    "consulta_equipamentos": ["inventario_equipamentos", "catalogos_locais"],
    "geracao_transferencia": ["inventario_equipamentos", "catalogos_locais", "template_transferencia"],
    "comparacao_atualizacao_inventarios": [
        "inventario_equipamentos",
        "inventario_detalhes_atualizacao",
        "inventario_endpoint",
    ],
    "exportacao_equipamentos": ["inventario_equipamentos", "modelo_exportacao"],
    "acompanhamento_chamados": ["historico_chamados"],
}


@dataclass(frozen=True)
class ReadyWorkbookServices:
    validate_local_model: Callable[[Path, str], Any]
    validate_uploaded_workbook: Callable[[bytes, str], Any]
    max_upload_bytes: Callable[[], int]
    logger: logging.Logger


@dataclass(frozen=True)
class ReadinessServices:
    ticket_report_file: Callable[[], Optional[Path]]
    details_upload_file: Callable[[], Path]
    endpoint_upload_file: Callable[[], Path]
    export_model_file: Callable[[], Path]
    get_details_files: Callable[[], List[Path]]
    get_primary_equipment_file: Callable[[], Optional[Path]]
    get_local_transfer_template: Callable[[], Path]
    check_startup_xlsx: Callable[[Optional[Path]], Dict[str, Any]]
    check_ready_workbook: Callable[[Path, str], Dict[str, Any]]
    check_startup_ticket_report: Callable[[Optional[Path]], Dict[str, Any]]
    loaded_state: Callable[[], Tuple[bool, bool]]
    validate_local_state: Callable[[], None]
    local_state_errors: Tuple[Type[Exception], ...]
    refresh_export_status: Callable[[], Dict[str, Any]]
    get_transaction_recovery_block: Callable[[], Optional[str]]
    logger: logging.Logger
    # Optional: the Entra names enrich the display but no function depends on them.
    entra_names_file: Optional[Callable[[], Path]] = None


def check_startup_xlsx(path: Optional[Path], validate: Callable[[Any], Any] = validate_xlsx) -> Dict[str, Any]:
    """Check the local XLSX container without loading or logging workbook data."""
    if path is None:
        return {"available": False, "file": None, "reason": "ausente"}
    if not path.is_file():
        return {"available": False, "file": path.name, "reason": "ausente"}

    try:
        validate(path)
    except XlsxLimitExceeded:
        return {"available": False, "file": path.name, "reason": "planilha excede os limites de processamento"}
    except XlsxPackageError:
        return {"available": False, "file": path.name, "reason": "arquivo inacessível ou XLSX inválido"}
    except (OSError, ValueError):
        return {"available": False, "file": path.name, "reason": "arquivo inacessível ou XLSX inválido"}

    return {"available": True, "file": path.name, "reason": "OK"}


class ReadyWorkbookCache:
    """Validation results keyed by path, size, timestamps and role."""

    def __init__(self, limit: int = READY_WORKBOOK_CACHE_LIMIT):
        self.entries: Dict[Tuple[str, int, int, int, str], Dict[str, Any]] = {}
        self.lock = threading.Lock()
        self.limit = limit

    def get(self, key: Tuple[str, int, int, int, str]) -> Optional[Dict[str, Any]]:
        with self.lock:
            cached = self.entries.get(key)
        return dict(cached) if cached is not None else None

    def put(self, key: Tuple[str, int, int, int, str], status: Dict[str, Any]) -> None:
        with self.lock:
            if len(self.entries) >= self.limit:
                self.entries.clear()
            self.entries[key] = dict(status)


def check_ready_workbook(
    path: Path,
    role: str,
    services: ReadyWorkbookServices,
    cache: ReadyWorkbookCache,
) -> Dict[str, Any]:
    status = {"available": False, "file": path.name, "reason": "ausente", "state": "awaiting_import"}
    if not path.exists():
        return status
    try:
        stat = path.stat()
        key = (str(path.resolve()), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, role)
        cached = cache.get(key)
        if cached is not None:
            return cached
        if role in {"transferencia", "exportacao"}:
            services.validate_local_model(path, role)
        else:
            max_upload_bytes = services.max_upload_bytes()
            if stat.st_size > max_upload_bytes:
                raise ValueError(f"A planilha excede o limite de {format_size_limit(max_upload_bytes)}.")
            services.validate_uploaded_workbook(path.read_bytes(), role)
        status.update(available=True, reason="OK", state="ready")
        cache.put(key, status)
    except (FileBusyError, OSError) as error:
        services.logger.warning(
            "Falha temporária ao verificar prontidão da planilha (arquivo=%s, papel=%s, erro=%s).",
            path.name, role, type(error).__name__,
        )
        status.update(reason=str(getattr(error, "detail", error)) or "arquivo temporariamente indisponível", state="unavailable")
    except (DomainError, WorkbookSafetyError, *WORKBOOK_READ_ERRORS) as error:
        services.logger.warning(
            "Falha ao verificar prontidão da planilha (arquivo=%s, papel=%s, erro=%s).",
            path.name, role, type(error).__name__,
        )
        status.update(reason=str(getattr(error, "detail", error)) or "planilha inválida", state="invalid")
    return status


def check_startup_ticket_report(path: Optional[Path]) -> Dict[str, Any]:
    """Check ticket history storage while allowing a fresh, not-yet-imported setup."""
    if path is None:
        return {"available": False, "file": None, "reason": "arquivo de histórico não configurado"}
    if not path.exists():
        return {
            "available": False,
            "file": path.name,
            "reason": "aguardando a primeira importação",
            "state": "awaiting_import",
        }
    if not path.is_file():
        return {"available": False, "file": path.name, "reason": "caminho do histórico inválido"}

    try:
        report = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {"available": False, "file": path.name, "reason": "histórico inacessível ou JSON inválido"}
    if not isinstance(report, dict) or not isinstance(report.get("chamados"), list):
        return {"available": False, "file": path.name, "reason": "estrutura do histórico inválida"}
    return {"available": True, "file": path.name, "reason": "OK"}


def check_startup_entra_names(path: Path) -> Dict[str, Any]:
    """Check the imported Entra directory without exposing names or logins."""
    if not path.exists():
        return {"available": False, "file": path.name, "reason": "aguardando a primeira importação",
                "state": "awaiting_import"}
    try:
        directory = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {"available": False, "file": path.name, "reason": "cadastro inacessível ou JSON inválido",
                "state": "invalid"}
    if not isinstance(directory, dict) or not isinstance(directory.get("users"), dict):
        return {"available": False, "file": path.name, "reason": "estrutura do cadastro inválida", "state": "invalid"}
    return {"available": True, "file": path.name, "reason": "OK", "state": "ready"}


def build_readiness_report(services: ReadinessServices) -> Dict[str, Any]:
    """Map essential local files to the application functions that need them."""
    logger = services.logger
    ticket_report_status = services.check_startup_ticket_report(services.ticket_report_file())
    try:
        services.get_details_files()
        details_directory_readable = True
    except OSError as error:
        logger.warning("Falha ao listar inventários (papel=detalhes, erro=%s).", type(error).__name__)
        details_directory_readable = False
    try:
        active_details = services.get_primary_equipment_file()
    except (OSError, FileBusyError) as error:
        logger.warning("Falha ao selecionar inventário ativo (papel=detalhes, erro=%s).", type(error).__name__)
        active_details = None

    units_loaded = False
    if active_details is not None:
        details_status = services.check_startup_xlsx(active_details)
        base_loaded, units_loaded = services.loaded_state()
        if details_status["available"] and not base_loaded:
            details_status.update(available=False, reason="inventário não carregado; importe o par Simpress e Endpoint")
    elif not details_directory_readable:
        details_status = {
            "available": False,
            "file": services.details_upload_file().name,
            "reason": "não foi possível ler a pasta de inventários",
        }
    elif not services.details_upload_file().exists():
        details_status = {
            "available": False,
            "file": services.details_upload_file().name,
            "reason": "ausente",
            "state": "awaiting_import",
        }
    elif not services.details_upload_file().is_file():
        details_status = {
            "available": False,
            "file": services.details_upload_file().name,
            "reason": "caminho do inventário oficial inválido",
            "state": "invalid",
        }
    else:
        details_status = {
            "available": False,
            "file": services.details_upload_file().name,
            "reason": "inventário oficial inválido ou sem cabeçalhos de equipamentos",
            "state": "invalid",
        }

    try:
        services.validate_local_state()
        local_state_status = {"available": True, "file": "catálogos e históricos JSON", "reason": "OK"}
    except services.local_state_errors as error:
        local_state_status = {
            "available": False,
            "file": "catálogos e históricos JSON",
            "reason": str(getattr(error, "detail", error)),
        }

    files = {
        "template_transferencia": services.check_ready_workbook(services.get_local_transfer_template(), "transferencia"),
        "inventario_equipamentos": details_status,
        "inventario_detalhes_atualizacao": services.check_ready_workbook(services.details_upload_file(), "detalhes"),
        "inventario_endpoint": services.check_ready_workbook(services.endpoint_upload_file(), "endpoint"),
        "modelo_exportacao": services.check_ready_workbook(services.export_model_file(), "exportacao"),
        "catalogos_locais": local_state_status,
        "historico_chamados": ticket_report_status,
    }
    if services.entra_names_file is not None:
        files["nomes_entra"] = check_startup_entra_names(services.entra_names_file())
    if files["modelo_exportacao"]["available"] and details_status["available"]:
        export_status = services.refresh_export_status()
        if not export_status["available"]:
            files["modelo_exportacao"].update(
                available=False,
                state=export_status.get("state", "invalid"),
                reason=export_status["reason"],
            )
    for status in files.values():
        status.setdefault("state", "ready" if status["available"] else
                          "awaiting_import" if status["reason"] == "ausente" else "invalid")
    functions = {
        name: {
            "available": all(files[key]["available"] for key in required_files),
            "missing_files": list(dict.fromkeys(
                files[key]["file"] or key
                for key in required_files
                if not files[key]["available"]
            )),
            "state": "ready" if all(files[key]["available"] for key in required_files)
                else "invalid" if any(files[key]["state"] == "invalid" for key in required_files)
                else "unavailable" if any(files[key]["state"] == "unavailable" for key in required_files)
                else "awaiting_import",
        }
        for name, required_files in FUNCTION_REQUIREMENTS.items()
    }
    if functions["geracao_transferencia"]["available"] and not units_loaded:
        functions["geracao_transferencia"].update(available=False, state="invalid", missing_files=["localidades do inventário"])
    report: Dict[str, Any] = {"backend": "files", "files": files, "functions": functions}
    # Additive key, present only in read-only mode, so existing consumers keep their shape.
    if (recovery_block := services.get_transaction_recovery_block()) is not None:
        report["gravacao_bloqueada"] = {"available": False, "state": "invalid", "reason": recovery_block}
    return report


def file_signature(paths: Iterable[Optional[Path]]) -> Tuple[Hashable, ...]:
    """Stat-based identity of the files a report depends on; missing files count too."""
    signature: List[Hashable] = []
    for path in paths:
        if path is None:
            signature.append(None)
            continue
        try:
            stat = path.stat()
            signature.append((str(path), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns))
        except OSError as error:
            signature.append((str(path), type(error).__name__))
    return tuple(signature)


class ReadinessReportCache:
    """Short-lived report cache invalidated by any change in its signature.

    The report is computed outside the cache lock, so this lock stays a leaf.
    The signature is taken before computing: a report built from newer files
    is stored under the older signature and is never served for newer files.
    """

    def __init__(self, ttl_seconds: float = READINESS_REPORT_CACHE_SECONDS, clock: Callable[[], float] = time.monotonic):
        self.ttl_seconds = ttl_seconds
        self.clock = clock
        self.lock = threading.Lock()
        self._entry: Optional[Tuple[Hashable, float, Dict[str, Any]]] = None

    def get_or_compute(self, signature: Hashable, compute: Callable[[], Dict[str, Any]]) -> Dict[str, Any]:
        now = self.clock()
        with self.lock:
            entry = self._entry
        if entry is not None and entry[0] == signature and now - entry[1] < self.ttl_seconds:
            return deepcopy(entry[2])
        report = compute()
        with self.lock:
            self._entry = (signature, now, deepcopy(report))
        return report

    def clear(self) -> None:
        with self.lock:
            self._entry = None


def readiness_log_lines(report: Dict[str, Any]) -> List[str]:
    """Feature impact summary for the startup log, without workbook contents."""
    lines = ["[PRONTIDÃO] Verificação dos arquivos locais:"]
    for key, status in report["files"].items():
        if not status["available"]:
            state = f"INDISPONÍVEL ({status['reason']})"
        elif key == "historico_chamados":
            state = "JSON válido" if status["reason"] == "OK" else status["reason"]
        elif key == "catalogos_locais":
            state = "catálogos e históricos disponíveis"
        elif key == "nomes_entra":
            state = "JSON válido"
        else:
            state = "PACOTE XLSX válido"
        filename = status["file"] or "arquivo não localizado"
        lines.append(f"[PRONTIDÃO] {FILE_LABELS[key]} — {filename}: {state}")

    for key, status in report["functions"].items():
        if status["available"]:
            detail = (
                "armazenamento do histórico disponível"
                if key == "acompanhamento_chamados"
                else "arquivos necessários presentes (checagem estrutural)"
            )
            lines.append(f"[PRONTIDÃO] {FUNCTION_LABELS[key]}: {detail}.")
        else:
            missing = ", ".join(status["missing_files"])
            lines.append(f"[PRONTIDÃO] {FUNCTION_LABELS[key]}: INDISPONÍVEL; dependência ausente ou inválida: {missing}.")
    return lines
