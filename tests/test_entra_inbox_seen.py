import shutil
import tempfile
import unittest
from pathlib import Path

from domains.entra_inbox import EntraInbox


class InboxSeenTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.calls = []
        self.inbox = EntraInbox(self.root, lambda data: self.calls.append(data) or {"users": 1})

    def tearDown(self):
        self.temporary.cleanup()

    def batch(self, name="lote1"):
        folder = self.root / "pendentes" / name
        folder.mkdir(parents=True)
        (folder / "usuarios.csv").write_bytes(b"conteudo")
        return folder

    def test_deleted_batch_is_forgotten(self):
        folder = self.batch()
        self.inbox.process_once()
        self.assertIn("lote1", self.inbox._seen)
        shutil.rmtree(folder)
        self.inbox.process_once()
        self.assertEqual(self.inbox._seen, {})

    def test_stable_batch_is_still_imported_on_second_pass(self):
        self.batch()
        self.inbox.process_once()
        self.assertEqual(self.calls, [])
        self.inbox.process_once()
        self.assertEqual(self.calls, [b"conteudo"])
        self.assertEqual(self.inbox._seen, {})

    def test_result_symlink_is_replaced_not_followed(self):
        folder = self.batch()
        victim = self.root / "alheio.txt"
        victim.write_text("intacto", encoding="utf-8")
        try:
            (folder / "_resultado.json").symlink_to(victim)
        except OSError:
            self.skipTest("symlinks need privileges on this machine")
        self.inbox.process_once()
        self.inbox.process_once()
        self.assertEqual(victim.read_text(encoding="utf-8"), "intacto")
        self.assertEqual(self.calls, [])

    def test_failed_batch_result_is_written_atomically(self):
        folder = self.batch()
        (folder / "extra.csv").write_bytes(b"x")
        self.inbox.process_once()
        self.inbox.process_once()
        result = self.root / "falhas" / folder.name / "_resultado.json"
        self.assertIn('"falha"', result.read_text(encoding="utf-8"))
        self.assertFalse(list((self.root / "falhas" / folder.name).glob(".*.tmp")))


if __name__ == "__main__":
    unittest.main()
