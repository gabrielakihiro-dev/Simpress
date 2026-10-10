"""Project-relative paths and limits used by the local application."""

import os
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
STATE_DIR = DATA_DIR / "state"
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
TEMPLATE_FILE = INPUT_DIR / "(MODELO) - TRANSFERENCIA SIMPRESS.xlsx"
DETAILS_UPLOAD_FILE = INPUT_DIR / "EquipamentosDetalhes_atual.xlsx"
ENDPOINT_UPLOAD_FILE = INPUT_DIR / "InvAllComputersSummary_atual.xlsx"
EXPORT_MODEL_FILE = BASE_DIR / "modelos" / "EquipamentosDetalhes-exportacao.xlsx"
UPLOAD_BACKUPS_DIR = INPUT_DIR / "_backups"

MAX_UPLOAD_BYTES = 30 * 1024 * 1024
MAX_UPLOAD_REQUEST_BYTES = 2 * MAX_UPLOAD_BYTES + 1024 * 1024
MAX_API_REQUEST_BYTES = 1024 * 1024
MAX_CONCURRENT_UPLOAD_REQUESTS = 1
MAX_CONCURRENT_WORKBOOK_PARSERS = 1
HISTORY_RETENTION_DAYS = 60
MAX_XLSX_ARCHIVE_ENTRIES = 10000
MAX_XLSX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
# Technical safeguards for the read-only inventory parser, not business row limits.
MAX_XLSX_WORKSHEETS = 128
MAX_XLSX_WORKSHEET_ROWS = 250_000
MAX_XLSX_WORKSHEET_COLUMNS = 16_384
MAX_XLSX_TOTAL_CELLS = 5_000_000
MAX_XLSX_TOTAL_MERGED_CELLS = MAX_XLSX_TOTAL_CELLS
MAX_XLSX_CONTROL_XML_BYTES = 8 * 1024 * 1024

CUSTOM_UNIDADES_FILE = STATE_DIR / "unidades_custom.json"
MODIFIED_APELIDOS_FILE = STATE_DIR / "apelidos_modificados" / "apelidos_modificados.json"
ALIAS_HISTORY_FILE = STATE_DIR / "historico_alteracoes.json"
COMPARISON_HISTORY_FILE = STATE_DIR / "historico_comparacoes" / "historico_comparacoes.json"
TICKET_REPORT_FILE = STATE_DIR / "historico_chamados.json"
TRANSACTION_ROOT = BASE_DIR

SUPPORTED_CONTRACT = 16467
SUPPORTED_CONTRACT_LEGAL_NAME = "SERV DE APOIO AS MICRO E PEQ EMP DO PARANA SEBRAE PR"

# Update these process environment values when the operation's origin contact changes.
TRANSFER_ORIGIN_CONTACT = os.environ.get(
    "SIMPRESS_TRANSFER_ORIGIN_CONTACT", "Gabriel Akihiro Noda Souza (Simpress)"
)
TRANSFER_ORIGIN_EMAIL = os.environ.get("SIMPRESS_TRANSFER_ORIGIN_EMAIL", "gansouza@simpress.com.br")
TRANSFER_ORIGIN_PHONE = os.environ.get("SIMPRESS_TRANSFER_ORIGIN_PHONE", "(41) 98751-2389")


def resolve_history_annotations_dir(base_dir: Path, environment=None):
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
