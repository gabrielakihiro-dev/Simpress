"""Project-relative paths and limits used by the local application."""

from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
INPUT_DIR = BASE_DIR / "planilhas_entrada"
TEMPLATE_FILE = INPUT_DIR / "(MODELO) - TRANSFERENCIA SIMPRESS.xlsx"
DETAILS_UPLOAD_FILE = INPUT_DIR / "EquipamentosDetalhes_atual.xlsx"
ENDPOINT_UPLOAD_FILE = INPUT_DIR / "InvAllComputersSummary_atual.xlsx"
DETAILS_EXPORT_BASELINE_FILE = INPUT_DIR / ".EquipamentosDetalhes_atual.export-baseline.xlsx"
EXPORT_MODEL_FILE = BASE_DIR / "modelos" / "EquipamentosDetalhes-exportacao.xlsx"
UPLOAD_BACKUPS_DIR = INPUT_DIR / "_backups"

MAX_UPLOAD_BYTES = 30 * 1024 * 1024
MAX_UPLOAD_REQUEST_BYTES = 2 * MAX_UPLOAD_BYTES + 1024 * 1024
MAX_XLSX_ARCHIVE_ENTRIES = 10000
MAX_XLSX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024

CUSTOM_UNIDADES_FILE = BASE_DIR / "unidades_custom.json"
MODIFIED_APELIDOS_FILE = BASE_DIR / "apelidos_modificados.json"
ALIAS_HISTORY_FILE = BASE_DIR / "historico_alteracoes.json"
COMPARISON_HISTORY_FILE = BASE_DIR / "historico_comparacoes.json"
TRANSACTION_ROOT = BASE_DIR
