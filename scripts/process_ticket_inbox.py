"""Process stable ticket workbook batches directly from the project inbox."""

from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main() -> int:
    import main as application
    from domains.ticket_inbox import AutomaticTicketInbox

    def import_batch(batch_id: str, simpress_name: str, simpress_bytes: bytes, oracle_name: str, oracle_bytes: bytes):
        print(f"Importando lote {batch_id} pelo processamento local...", flush=True)
        result = application._import_automatic_ticket_batch(
            batch_id, simpress_name, simpress_bytes, oracle_name, oracle_bytes,
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
