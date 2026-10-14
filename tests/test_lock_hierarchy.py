"""Concurrency regression for the global → file → Python-leaf lock hierarchy."""

import io
import json
import tempfile
import threading
import unittest
from contextlib import ExitStack, contextmanager, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from core import integrity

with patch("openpyxl.load_workbook", side_effect=RuntimeError("testes não acessam planilhas locais")):
    with redirect_stdout(io.StringIO()):
        import main


GLOBAL_LOCK_NAME = ".atomic-transactions"
# Only the operation under test waits this long for the global lock. Under the
# hierarchy it waits just for a JSON read; with the old inversion it always
# times out, so the outcome does not depend on scheduling.
SHORT_GLOBAL_LOCK_TIMEOUT = 2.0
THREAD_TIMEOUT = 10.0
OLD_TIMESTAMP = "2000-01-01T12:00:00+00:00"


class LockHierarchyTests(unittest.TestCase):
    def setUp(self):
        self.temp_context = tempfile.TemporaryDirectory(prefix=".lock-hierarchy-")
        self.root = Path(self.temp_context.name)
        self.alias_history = self.root / "historico_alteracoes.json"
        self.comparison_history = self.root / "historico_comparacoes.json"
        self.unrelated = self.root / "outra_configuracao.json"
        input_dir = self.root / "planilhas_entrada"
        input_dir.mkdir()
        shared_annotations = self.root / "anotacoes"
        shared_annotations.mkdir()
        pending_annotations = self.root / "anotacoes_pendentes"
        pending_annotations.mkdir()
        self.stack = ExitStack()
        for name, value in {
            "TRANSACTION_ROOT": self.root,
            "INPUT_DIR": input_dir,
            "UPLOAD_BACKUPS_DIR": input_dir / "_backups",
            "ALIAS_HISTORY_FILE": self.alias_history,
            "COMPARISON_HISTORY_FILE": self.comparison_history,
            "HISTORY_ANNOTATIONS_DIR": shared_annotations,
            "LOCAL_HISTORY_ANNOTATION_OUTBOX_DIR": pending_annotations,
            "HISTORY_ANNOTATIONS_SYNC_ENABLED": False,
        }.items():
            self.stack.enter_context(patch.object(main, name, value))
        self.alias_history.write_text(json.dumps([
            {"id": "apelido-antigo", "horario": OLD_TIMESTAMP},
        ]), encoding="utf-8")
        self.comparison_history.write_text(json.dumps([
            {"id": "comparacao-antiga", "horario": OLD_TIMESTAMP, "comparacao": {}},
        ]), encoding="utf-8")

    def tearDown(self):
        self.stack.close()
        self.temp_context.cleanup()

    def _run_while_transaction_reads(self, operation, reader):
        """Run `operation` while another thread holds the global lock and then reads through a leaf lock."""
        original_lock_paths = integrity.lock_paths
        operation_requested_global = threading.Event()
        holder_has_global = threading.Event()
        outcome = {}

        @contextmanager
        def observed_lock_paths(paths, timeout=15.0):
            paths = list(paths)
            if (
                threading.current_thread() is operation_thread
                and any(Path(path).name == GLOBAL_LOCK_NAME for path in paths)
            ):
                operation_requested_global.set()
                timeout = SHORT_GLOBAL_LOCK_TIMEOUT
            with original_lock_paths(paths, timeout=timeout):
                yield

        def hold_transaction_and_read():
            try:
                with main.AtomicFileTransaction(main.TRANSACTION_ROOT, [self.unrelated]):
                    holder_has_global.set()
                    if not operation_requested_global.wait(THREAD_TIMEOUT):
                        raise AssertionError("A operação concorrente não pediu o lock global.")
                    outcome["leitura"] = reader()
            except BaseException as error:
                outcome["erro_leitura"] = error

        def run_operation():
            try:
                outcome["operacao"] = operation()
            except BaseException as error:
                outcome["erro_operacao"] = error

        holder_thread = threading.Thread(target=hold_transaction_and_read, daemon=True)
        operation_thread = threading.Thread(target=run_operation, daemon=True)
        with patch.object(integrity, "lock_paths", observed_lock_paths):
            holder_thread.start()
            self.assertTrue(holder_has_global.wait(THREAD_TIMEOUT), "A transação de apoio não abriu.")
            operation_thread.start()
            operation_thread.join(THREAD_TIMEOUT)
            holder_thread.join(THREAD_TIMEOUT)
        self.assertFalse(operation_thread.is_alive() or holder_thread.is_alive(), "As threads ficaram presas.")
        self.assertNotIn("erro_leitura", outcome, repr(outcome.get("erro_leitura")))
        self.assertNotIn(
            "erro_operacao",
            outcome,
            "A operação segurou um lock Python enquanto esperava o lock global: "
            f"{outcome.get('erro_operacao')!r}",
        )
        return outcome

    def _assert_retention_runs_beside(self, reader):
        outcome = self._run_while_transaction_reads(main.prune_expired_histories, reader)

        self.assertEqual(len(outcome["leitura"]), 1)
        self.assertEqual(outcome["operacao"]["apelidos_removidos"], 1)
        self.assertEqual(outcome["operacao"]["comparacoes_removidas"], 1)
        self.assertEqual(json.loads(self.alias_history.read_text(encoding="utf-8")), [])
        self.assertEqual(json.loads(self.comparison_history.read_text(encoding="utf-8")), [])

    def test_retention_does_not_block_alias_history_read_inside_transaction(self):
        # Mirrors aplicar_alteracao_apelido, which reads the alias history under the global lock.
        self._assert_retention_runs_beside(main.load_alias_history)

    def test_retention_does_not_block_comparison_history_read_inside_transaction(self):
        self._assert_retention_runs_beside(main.load_comparison_history)

    def test_history_event_removal_never_holds_history_lock_while_waiting_for_transaction(self):
        outcome = self._run_while_transaction_reads(
            lambda: main.excluir_comparacao_historica("comparacao-antiga"),
            main.load_comparison_history,
        )

        self.assertEqual(outcome["leitura"][0]["id"], "comparacao-antiga")
        self.assertEqual(outcome["operacao"]["total"], 0)
        self.assertEqual(json.loads(self.comparison_history.read_text(encoding="utf-8")), [])


if __name__ == "__main__":
    unittest.main()
