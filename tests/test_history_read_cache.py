import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import main
from core import integrity
from core.integrity import AtomicFileTransaction
from main import LocalJsonCorruptionError


def history(*serials):
    return [{"id": f"e{index}", "serial": serial, "dados": {"n": index}} for index, serial in enumerate(serials)]


class HistoryReadCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix=".history-cache-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / "historico.json"
        self.write(history("A1"))
        main.clear_history_read_cache()
        self.addCleanup(main.clear_history_read_cache)

    def write(self, value):
        self.path.write_text(json.dumps(value), encoding="utf-8")

    def read(self):
        return main._read_json_history(self.path, "teste")

    def test_unchanged_file_is_parsed_once(self):
        self.read()
        with patch.object(main.json, "loads", side_effect=AssertionError("reparsed")):
            self.assertEqual(self.read(), history("A1"))

    def test_direct_write_returns_new_data(self):
        self.read()
        self.write(history("A1", "B2"))
        self.assertEqual([item["serial"] for item in self.read()], ["A1", "B2"])

    def test_transaction_write_returns_new_data(self):
        self.read()
        with AtomicFileTransaction(self.root, [self.path]) as transaction:
            transaction.update_json(self.path, lambda current: current + history("Z9"), [])
            transaction.commit()
        self.assertEqual([item["serial"] for item in self.read()], ["A1", "Z9"])

    def test_rollback_restoring_older_file_returns_older_data(self):
        self.assertEqual(self.read(), history("A1"))
        with self.assertRaises(RuntimeError):
            with AtomicFileTransaction(self.root, [self.path]) as transaction:
                transaction.update_json(self.path, lambda current: history("A1", "B2", "C3"), [])
                transaction.apply()
                self.assertEqual(len(self.read()), 3)
                raise RuntimeError("falha simulada depois de aplicar")
        restored = self.read()
        self.assertEqual(restored, history("A1"))
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")), history("A1"))

    def test_write_clears_cache_even_if_file_identity_is_unchanged(self):
        # Prova a invalidacao por escrita, independente do stat: identidade congelada.
        self.read()
        with patch.object(main, "_history_file_identity", return_value=(1, 1, 1, 1)):
            main.clear_history_read_cache()
            self.read()
            integrity.atomic_write_json(self.path, history("A1", "B2"))
            self.assertEqual([item["serial"] for item in self.read()], ["A1", "B2"])

    def test_deleted_file_by_transaction_is_not_served_from_cache(self):
        self.read()
        with AtomicFileTransaction(self.root, [self.path]) as transaction:
            transaction.stage_delete(self.path)
            transaction.commit()
        with self.assertRaises(LocalJsonCorruptionError):
            self.read()

    def test_corrupted_file_raises_and_is_not_cached(self):
        self.read()
        self.path.write_text("{ nao e json", encoding="utf-8")
        stat = self.path.stat()
        os.utime(self.path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
        with self.assertRaises(LocalJsonCorruptionError) as first:
            self.read()
        self.assertEqual(str(first.exception), "O histórico local de teste está ilegível; os dados foram preservados.")
        with self.assertRaises(LocalJsonCorruptionError):
            self.read()
        self.write(history("A1", "OK"))
        self.assertEqual([item["serial"] for item in self.read()], ["A1", "OK"])

    def test_wrong_shape_raises_and_is_not_cached(self):
        self.write({"nao": "lista"})
        with self.assertRaises(LocalJsonCorruptionError) as error:
            self.read()
        self.assertEqual(str(error.exception), "O histórico local de teste precisa conter uma lista de registros.")
        with self.assertRaises(LocalJsonCorruptionError):
            self.read()

    def test_top_level_edits_of_returned_records_do_not_reach_next_read(self):
        # So o nivel superior e isolado; valores aninhados sao compartilhados de proposito (ver main.py).
        first = self.read()
        first[0]["serial"] = "ALTERADO"
        first.append({"id": "extra"})
        self.assertEqual(self.read(), history("A1"))


if __name__ == "__main__":
    unittest.main()
