import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch


with patch("openpyxl.load_workbook", side_effect=RuntimeError("testes não acessam planilhas locais")):
    with redirect_stdout(io.StringIO()):
        import main


class EntraHistoryDisplayTests(unittest.TestCase):
    def test_corrupted_entra_file_keeps_history_without_names(self):
        event = {
            "resumo": {},
            "comparacao": {
                "mudancas_usuarios": [
                    {"serie": "S-1", "usuario_anterior": "ana", "usuario_novo": "bia"},
                ],
            },
        }
        with tempfile.TemporaryDirectory() as folder:
            corrupted = Path(folder) / "usuarios_entra_pr.json"
            corrupted.write_text("{not json", encoding="utf-8")
            with patch.object(main, "ENTRA_USERS_FILE", corrupted), self.assertLogs(main.logger, "WARNING"):
                displayed = main.comparison_history_for_display(event)
                no_user_changes = main.comparison_history_for_display({"resumo": {}, "comparacao": {}})

        rows = displayed["comparacao"]["mudancas_usuarios"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["usuario_novo"], "bia")
        self.assertFalse(rows[0]["nome_pessoa_novo"])
        self.assertIn("comparacao", no_user_changes)

    def test_event_without_user_changes_does_not_read_entra_file(self):
        with patch.object(main.entra_users, "read_directory", side_effect=AssertionError("não deve ler")):
            displayed = main.comparison_history_for_display({"resumo": {}, "comparacao": {}})
        self.assertIn("comparacao", displayed)


if __name__ == "__main__":
    unittest.main()
