"""Endpoint header validation before an automatic inventory batch is published."""

import io
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from openpyxl import Workbook

from scripts import prepare_inventory_downloads


ENDPOINT_HEADERS = [
    "Nome do computador",
    "Rótulo de serviço/Número de série",
    "Usuários logados",
    "Usuário do último logon",
]


def xlsx_bytes(headers: list[str]) -> bytes:
    workbook = Workbook()
    workbook.active.append(headers)
    output = io.BytesIO()
    workbook.save(output)
    workbook.close()
    return output.getvalue()


class PrepareInventoryDownloadsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="prepare-inventory-header-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.downloads = self.root / "Downloads"
        self.downloads.mkdir()
        self.inbox = self.root / "inbox"
        self.since = datetime.now(timezone.utc)
        self._write_download("InvAllComputersSummary.xlsx", xlsx_bytes(ENDPOINT_HEADERS))
        self._write_download("EquipamentosDetalhes.xlsx", xlsx_bytes(["NumeroSerie", "Apelido"]))

    def _write_download(self, name: str, content: bytes) -> Path:
        path = self.downloads / name
        path.write_bytes(content)
        return path

    def test_publishes_when_last_logon_header_is_present(self):
        result = prepare_inventory_downloads.prepare(self.downloads, self.since, self.inbox)

        self.assertEqual(result["estado"], "pendentes")
        self.assertTrue((Path(result["pasta"]) / "_origem.json").is_file())

    def test_does_not_publish_when_last_logon_header_is_missing(self):
        self._write_download(
            "InvAllComputersSummary.xlsx",
            xlsx_bytes(ENDPOINT_HEADERS[:-1]),
        )

        with self.assertRaisesRegex(ValueError, "Usuário do último logon.*lote não foi publicado"):
            prepare_inventory_downloads.prepare(self.downloads, self.since, self.inbox)

        self.assertFalse((self.inbox / "pendentes").exists())


if __name__ == "__main__":
    unittest.main()
