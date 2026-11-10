import logging
import unittest
from pathlib import Path

from domains import inventory_update


class _FakeTransaction:
    def update_json(self, path, updater, default):
        self.path = path  # The write itself is covered by the update tests; here only the log matters.


class HistoryWriteLogTests(unittest.TestCase):
    def test_history_write_logs_only_the_duration(self):
        entry = {
            "id": "evento-teste",
            "comparacao": {
                "ausentes_no_endpoint": [{"serie": "SERIETESTE01", "apelido": "PRNOTETESTE01"}],
                "ausentes_em_detalhes": [],
            },
        }
        with self.assertLogs(inventory_update.logger, level=logging.INFO) as captured:
            inventory_update._journal_comparison_history(
                _FakeTransaction(), None, Path("historico.json"), entry, []
            )
        messages = [record.getMessage() for record in captured.records]
        self.assertTrue(any(m.startswith("Histórico de comparações gravado em ") and m.endswith(" ms.") for m in messages))
        for message in messages:
            for dado in ("SERIETESTE01", "PRNOTETESTE01", "evento-teste", "historico.json"):
                self.assertNotIn(dado, message)


if __name__ == "__main__":
    unittest.main()
