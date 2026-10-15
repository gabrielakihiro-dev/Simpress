"""Process stable ticket workbook batches directly from the project inbox."""

from __future__ import annotations

import io
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main() -> int:
    import main as application
    from domains.ticket_inbox import AutomaticTicketInbox
    from starlette.datastructures import UploadFile


    endpoint = next((
        route.endpoint
        for route in application.operations_router.routes
        if getattr(route, "path", None) == "/api/operacoes/chamados/importar"
        and "POST" in getattr(route, "methods", set())
    ), None)
    if endpoint is None:
        print("A função de importação de chamados não está registrada.")
        return 2

    def import_batch(batch_id: str, simpress_name: str, simpress_bytes: bytes, oracle_name: str, oracle_bytes: bytes):
        print(f"Importando lote {batch_id} pelo processamento local...", flush=True)
        simpress_upload = UploadFile(filename=simpress_name, file=io.BytesIO(simpress_bytes))
        oracle_upload = UploadFile(filename=oracle_name, file=io.BytesIO(oracle_bytes))
        result = endpoint(
            simpress_file=simpress_upload,
            oracle_file=oracle_upload,
            automatic_import_id=batch_id,
        )
        print(f"Importação salva: {result.get('resumo', {}).get('series_total', 0)} séries.", flush=True)
        return result

    inbox = AutomaticTicketInbox(
        root=application.AUTOMATIC_TICKET_INBOX_DIR,
        report_path=application.TICKET_REPORT_FILE,
        max_upload_bytes=application.MAX_TICKET_WORKBOOK_BYTES,
        import_batch=import_batch,
    )
    print(f"Verificando lotes em {inbox.pending_dir}...", flush=True)
    completed = inbox.process_pending_once_sync()
    if completed == 0:
        time.sleep(0.2)
        completed = inbox.process_pending_once_sync()
    print(f"Lotes de chamados processados ou arquivados: {completed}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
