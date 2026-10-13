"""Process the local inventory inbox without an HTTP server."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


async def process() -> int:
    print("Carregando o importador local...", flush=True)
    import main as application
    from domains.inventory_inbox import AutomaticInventoryInbox

    if application.PERSISTENCE_SETTINGS.backend == "postgres":
        print("A entrada por pastas está disponível somente no modo local de arquivos.")
        return 2
    print("Recuperando transações e carregando a base atual...", flush=True)
    application.recover_pending_transactions(application.TRANSACTION_ROOT)
    application.load_database()
    inbox = AutomaticInventoryInbox(
        root=application.AUTOMATIC_INVENTORY_INBOX_DIR,
        max_upload_bytes=application.MAX_UPLOAD_BYTES,
        load_history=application.load_comparison_history,
        import_batch=application._import_automatic_inventory_batch,
    )
    failures_before = set(inbox.failed_dir.glob("*/_resultado.json"))
    print(f"Processando a fila {inbox.pending_dir}...", flush=True)
    await inbox.process_pending_once()
    await asyncio.sleep(0.2)
    completed = await inbox.process_pending_once()
    new_failures = set(inbox.failed_dir.glob("*/_resultado.json")) - failures_before
    print(json.dumps({"lotes_processados_ou_arquivados": completed,
                      "novas_falhas": [str(path) for path in sorted(new_failures)],
                      "fila": str(inbox.root)}, ensure_ascii=False), flush=True)
    # A conclusão de cada lote é comprovada por processadas/<lote>/_resultado.json.
    return 2 if new_failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(process()))
