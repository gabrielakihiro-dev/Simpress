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


if __name__ == "__main__":
    unittest.main()
