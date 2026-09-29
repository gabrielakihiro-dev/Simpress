import io
from contextlib import redirect_stdout
from unittest.mock import patch
import unittest


with patch("openpyxl.load_workbook", side_effect=RuntimeError("testes não acessam planilhas locais")):
    with redirect_stdout(io.StringIO()):
        import main


class AliasHistoryTests(unittest.TestCase):
    def test_snapshot_uses_serial_and_skips_missing_or_duplicate_serials(self):
        equipment = {
            "first": {"serial": " BRJ549256W ", "apelido": "Backup Maringá"},
            "duplicate": {"serial": "BRJ-549256W", "apelido": "outro apelido"},
            "missing": {"serial": "", "apelido": "sem série"},
            "unique": {"serial": "BRM551RN1Y", "apelido": "Nome anterior"},
        }

        snapshot = main.snapshot_equipment_aliases(equipment)

        self.assertNotIn("BRJ549256W", snapshot)
        self.assertNotIn("", snapshot)
        self.assertEqual(snapshot["BRM551RN1Y"]["apelido"], "Nome anterior")

    def test_comparison_lists_changed_aliases_by_serial(self):
        previous = {
            "BRJ549256W": {"serie": "BRJ549256W", "apelido": "Backup Maringá"},
            "BRM551RN1Y": {"serie": "BRM551RN1Y", "apelido": "PRNOTETI027"},
        }
        current = {
            "BRJ549256W": {"serie": "BRJ549256W", "apelido": "PRNOTEMAR035"},
            "BRM551RN1Y": {"serie": "BRM551RN1Y", "apelido": "PRNOTETI027"},
            "BRM99999999": {"serie": "BRM99999999", "apelido": "NOVO"},
        }

        changes = main.compare_equipment_aliases(previous, current)

        self.assertEqual(changes, [{
            "serie": "BRJ549256W",
            "apelido_anterior": "Backup Maringá",
            "apelido_novo": "PRNOTEMAR035",
        }])

    def test_history_summary_counts_recorded_alias_changes(self):
        event = {
            "resumo": {},
            "comparacao": {
                "apelidos_atualizados": [
                    {"serie": "S-1", "apelido_anterior": "Antigo", "apelido_novo": "Novo"},
                    {"serie": "S-2", "apelido_anterior": "Antigo 2", "apelido_novo": "Novo 2"},
                ],
            },
        }

        displayed = main.comparison_history_for_display(event)

        self.assertEqual(displayed["resumo"]["apelidos_atualizados"], 2)
        self.assertEqual(len(displayed["comparacao"]["apelidos_atualizados"]), 2)


if __name__ == "__main__":
    unittest.main()
