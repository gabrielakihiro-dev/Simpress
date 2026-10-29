"""Project-relative paths and limits used by the local application."""

import os
from collections.abc import Mapping
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BASE_DIR / "data"
STATE_DIR = DATA_DIR / "state"
LOG_DIR = DATA_DIR / "logs"
STATIC_DIR = BASE_DIR / "static"
INPUT_DIR = DATA_DIR / "planilhas_entrada"
_automatic_inventory_inbox_override = str(os.environ.get("SIMPRESS_IMPORT_INBOX_DIR") or "").strip()
AUTOMATIC_INVENTORY_INBOX_DIR = Path(
    _automatic_inventory_inbox_override or STATE_DIR / "entrada_automatica"
).expanduser()
if not AUTOMATIC_INVENTORY_INBOX_DIR.is_absolute():
    AUTOMATIC_INVENTORY_INBOX_DIR = BASE_DIR / AUTOMATIC_INVENTORY_INBOX_DIR
AUTOMATIC_INVENTORY_INBOX_DIR = AUTOMATIC_INVENTORY_INBOX_DIR.resolve(strict=False)
AUTOMATIC_INVENTORY_IMPORT_POLL_SECONDS = 10
_automatic_ticket_inbox_override = str(os.environ.get("SIMPRESS_TICKET_IMPORT_INBOX_DIR") or "").strip()
AUTOMATIC_TICKET_INBOX_DIR = Path(
    _automatic_ticket_inbox_override or STATE_DIR / "entrada_chamados"
).expanduser()
if not AUTOMATIC_TICKET_INBOX_DIR.is_absolute():
    AUTOMATIC_TICKET_INBOX_DIR = BASE_DIR / AUTOMATIC_TICKET_INBOX_DIR
AUTOMATIC_TICKET_INBOX_DIR = AUTOMATIC_TICKET_INBOX_DIR.resolve(strict=False)
AUTOMATIC_TICKET_IMPORT_POLL_SECONDS = 10
# Last month's contract report is saved here once (docs/operacao/relatorio-mensal-automatico.md).
MONTHLY_REPORTS_DIR = DATA_DIR / "relatorios_mensais"
MONTHLY_REPORT_FIRST_CHECK_SECONDS = 30
MONTHLY_REPORT_CHECK_SECONDS = 3600
TEMPLATE_FILE = INPUT_DIR / "(MODELO) - TRANSFERENCIA SIMPRESS.xlsx"
DETAILS_UPLOAD_FILE = INPUT_DIR / "EquipamentosDetalhes_atual.xlsx"
ENDPOINT_UPLOAD_FILE = INPUT_DIR / "InvAllComputersSummary_atual.xlsx"
EXPORT_MODEL_FILE = BASE_DIR / "modelos" / "EquipamentosDetalhes-exportacao.xlsx"
UPLOAD_BACKUPS_DIR = INPUT_DIR / "_backups"

MAX_UPLOAD_BYTES = 60 * 1024 * 1024
MAX_UPLOAD_REQUEST_BYTES = 2 * MAX_UPLOAD_BYTES + 1024 * 1024
MAX_API_REQUEST_BYTES = 1024 * 1024
# Assistant voice message: 16 kHz mono 16-bit WAV, 120 s = about 3.7 MiB.
MAX_ASSISTANT_AUDIO_BYTES = 5 * 1024 * 1024
MAX_CONCURRENT_UPLOAD_REQUESTS = 1
# Max idle gap between request body chunks; frees the single upload slot from stalled clients.
REQUEST_BODY_IDLE_TIMEOUT_SECONDS = 30.0
MAX_CONCURRENT_WORKBOOK_PARSERS = 1
HISTORY_RETENTION_DAYS = 60
# Home alert: the official EquipamentosDetalhes base older than this many days (docs/operacao/alerta-base-desatualizada.md).
STALE_BASE_ALERT_DAYS = 7
# Home alert: open tickets without an Oracle update for this many days (docs/operacao/alertas-os-divergencias.md).
STALE_TICKET_ALERT_DAYS = 7
MAX_XLSX_ARCHIVE_ENTRIES = 10000
MAX_XLSX_UNCOMPRESSED_BYTES = 192 * 1024 * 1024
# Technical safeguards for the read-only inventory parser, not business row limits.
MAX_XLSX_WORKSHEETS = 128
MAX_XLSX_WORKSHEET_ROWS = 70_000
MAX_XLSX_WORKSHEET_COLUMNS = 16_384
MAX_XLSX_TOTAL_CELLS = 3_500_000
MAX_XLSX_TOTAL_MERGED_CELLS = MAX_XLSX_TOTAL_CELLS
MAX_XLSX_CONTROL_XML_BYTES = 8 * 1024 * 1024


def format_size_limit(byte_count: int) -> str:
    """Render a byte limit for user-facing messages, so labels follow the configured values."""
    if byte_count >= 1024 * 1024:
        return f"{byte_count / (1024 * 1024):g} MB"
    if byte_count >= 1024:
        return f"{byte_count / 1024:g} KB"
    return f"{byte_count} bytes"

CUSTOM_UNIDADES_FILE = STATE_DIR / "unidades_custom.json"
MODIFIED_APELIDOS_FILE = STATE_DIR / "apelidos_modificados" / "apelidos_modificados.json"
MANUAL_USERS_FILE = STATE_DIR / "usuarios_manuais" / "usuarios_manuais.json"
ENTRA_USERS_FILE = STATE_DIR / "usuarios_entra_pr.json"
MANUAL_PERSON_NAMES_FILE = STATE_DIR / "nomes_pessoas_manuais.json"
ENTRA_INBOX_DIR = STATE_DIR / "entrada_usuarios_entra"
REMOVED_ENDPOINT_HOSTNAMES_FILE = STATE_DIR / "hostnames_removidos" / "hostnames_removidos.json"
ALIAS_HISTORY_FILE = STATE_DIR / "historico_alteracoes.json"
COMPARISON_HISTORY_FILE = STATE_DIR / "historico_comparacoes" / "historico_comparacoes.json"
TICKET_REPORT_FILE = STATE_DIR / "historico_chamados.json"
TRANSFER_HISTORY_FILE = STATE_DIR / "historico_transferencias.json"
TRANSACTION_ROOT = BASE_DIR

SUPPORTED_CONTRACT = 16467
SUPPORTED_CONTRACT_LEGAL_NAME = "SERV DE APOIO AS MICRO E PEQ EMP DO PARANA SEBRAE PR"

# The transfer origin contact is personal data and is never versioned. It comes from the
# SIMPRESS_TRANSFER_ORIGIN_* environment variables or, field by field, from this git-ignored
# file (see config/contato_origem.exemplo.json); missing values stay empty.
TRANSFER_ORIGIN_CONTACT_FILE = BASE_DIR / "config" / "contato_origem.json"


def resolve_history_annotations_dir(base_dir: Path, environment: Mapping[str, str] | None = None) -> tuple[Path, bool]:
    """Choose a shared annotation folder when OneDrive or an override is available."""
    env = os.environ if environment is None else environment
    override = str(env.get("SIMPRESS_ANNOTATIONS_DIR") or "").strip()
    if override:
        path = Path(override).expanduser()
        if not path.is_absolute():
            path = Path(base_dir) / path
        return path.resolve(strict=False), True

    for variable in ("OneDriveCommercial", "OneDrive"):
        root = str(env.get(variable) or "").strip()
        if root and Path(root).expanduser().is_dir():
            return Path(root).expanduser() / "Aplicativos" / "Simpress" / "AnotacoesHistorico", True

    return Path(base_dir) / "anotacoes_historico", False


HISTORY_ANNOTATIONS_DIR, HISTORY_ANNOTATIONS_SYNC_ENABLED = resolve_history_annotations_dir(BASE_DIR)
LOCAL_HISTORY_ANNOTATION_OUTBOX_DIR = STATE_DIR / "anotacoes_historico_pendentes"
