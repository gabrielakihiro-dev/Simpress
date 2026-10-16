"""Restore and export helpers of the comparison history work without the HTTP layer."""

from datetime import date
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
import zipfile

from domains.history_export import build_history_export_workbook
from domains.history_restore import (
    HistoryRestoreError,
    build_restore_context,
    comparison_event_type,
    event_has_restorable_backup,
    restore_backup_paths,
    sha256_file,
)


class HistoryRestoreDomainTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.backups = self.root / "backups"
        self.backups.mkdir()
        self.services = SimpleNamespace(
            input_directory=lambda: self.root,
            upload_backups_directory=lambda: self.backups,
            endpoint_upload_path=lambda: self.root / "InvAll.xlsx",
            details_upload_path=lambda: self.root / "EquipamentosDetalhes.xlsx",
            load_comparison_history=lambda: [],
        )

    def test_event_type_recognizes_restorations_by_type_or_operation(self):
        self.assertEqual(comparison_event_type({"tipo": "restauracao"}), "restauracao")
        self.assertEqual(comparison_event_type({"comparacao": {"tipo_operacao": "restauracao"}}), "restauracao")
        self.assertEqual(comparison_event_type({"comparacao": {}}), "atualizacao")

    def test_backup_outside_the_backup_directory_is_refused_with_409(self):
        for relative in (None, "", "../fora", str(self.root / "absoluto")):
            with self.subTest(relative=relative):
                with self.assertRaises(HistoryRestoreError) as raised:
                    restore_backup_paths(self.services, {"comparacao": {"backup_diretorio": relative}})
                self.assertEqual(raised.exception.status_code, 409)

    def test_backup_paths_resolve_one_file_per_source(self):
        backup = self.backups / "20261015-120000-abcdef12"
        for role, name in (("endpoint", "InvAll.xlsx"), ("detalhes", "EquipamentosDetalhes.xlsx")):
            (backup / role).mkdir(parents=True)
            (backup / role / name).write_bytes(b"x")
        event = {"comparacao": {"backup_diretorio": str(backup.relative_to(self.root))}}
        paths = restore_backup_paths(self.services, event)
        self.assertEqual(set(paths), {"endpoint", "detalhes"})
        self.assertTrue(event_has_restorable_backup(self.services, event))
        event["comparacao"]["backup_arquivos_invalidos"] = {"detalhes": True}
        self.assertFalse(event_has_restorable_backup(self.services, event))

    def test_unknown_event_is_reported_as_404(self):
        with self.assertRaises(HistoryRestoreError) as raised:
            build_restore_context(self.services, "inexistente")
        self.assertEqual(raised.exception.status_code, 404)
        self.assertEqual(raised.exception.detail, "A atualização selecionada não existe no histórico de planilhas.")

    def test_sha256_file_matches_known_digest(self):
        path = self.root / "arquivo.bin"
        path.write_bytes(b"abc")
        self.assertEqual(sha256_file(path), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")


class HistoryExportWorkbookTests(unittest.TestCase):
    def test_workbook_has_every_sheet_and_dated_filename(self):
        events = [{
            "id": "evento",
            "horario": "2026-10-15T10:00:00-03:00",
            "arquivos_enviados": {"endpoint": "InvAll.xlsx", "detalhes": "EquipamentosDetalhes.xlsx"},
            "comparacao": {"sem_acesso_7_dias": [{"serie": "S1", "computador": "HOST", "anotacao": "ok"}]},
        }]
        output, filename = build_history_export_workbook(events, date(2026, 10, 15))
        self.assertRegex(filename, r"^Historico_Planilhas_20261015_\d{6}\.xlsx$")
        self.assertEqual(output.tell(), 0)
        with zipfile.ZipFile(output) as archive:
            workbook_xml = archive.read("xl/workbook.xml").decode("utf-8")
            shared = archive.read("xl/sharedStrings.xml").decode("utf-8") if "xl/sharedStrings.xml" in archive.namelist() else ""
            sheets_xml = "".join(
                archive.read(name).decode("utf-8")
                for name in archive.namelist() if name.startswith("xl/worksheets/sheet")
            )
        for sheet in ("Resumo", "Histórico", "Apelidos", "Ausências", "Sem acesso", "Localidades", "Ambiguidades"):
            self.assertIn(f'name="{sheet}"', workbook_xml)
        content = shared + sheets_xml
        # Source names in the history are shown with the standardized labels.
        self.assertIn("no endpoint", content)
        self.assertIn("na Simpress", content)
        self.assertNotIn("InvAll", content)
        self.assertNotIn("EquipamentosDetalhes", content)


if __name__ == "__main__":
    unittest.main()
