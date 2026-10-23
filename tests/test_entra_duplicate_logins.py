import tempfile
import unittest
from pathlib import Path

from domains import entra_users

HEADER = "id,displayName,userPrincipalName,userType,onPremisesSyncEnabled,identities,companyName,creationType;"


def csv_bytes(*rows):
    return ("﻿" + "\r\n".join([HEADER, *rows]) + "\r\n").encode("utf-8")


def row(name, upn):
    return f'1,"{name}",{upn},Member,No,View,Sebrae PR,;'


class DuplicateLoginTests(unittest.TestCase):
    def test_conflict_stays_out_even_if_names_repeat_later(self):
        parsed = entra_users.parse_csv(csv_bytes(
            row("Ana", "ana@pr.sebrae.com.br"),
            row("Outra", "ana@pr.sebrae.com.br"),
            row("Ana", "ana@pr.sebrae.com.br"),
            row("Bia", "bia@pr.sebrae.com.br"),
            row("Bia", "BIA@pr.sebrae.com.br"),
        ))
        self.assertEqual(parsed["users"], {"bia": "Bia"})
        self.assertEqual(parsed["logins_ignorados"], 1)
        self.assertEqual(parsed["filtered_rows"], 5)

    def test_no_conflict_reports_zero(self):
        parsed = entra_users.parse_csv(csv_bytes(row("Ana", "ana@pr.sebrae.com.br"), row("Ana", "ana@pr.sebrae.com.br")))
        self.assertEqual(parsed["users"], {"ana": "Ana"})
        self.assertEqual(parsed["logins_ignorados"], 0)

    def test_import_summary_and_persisted_state_carry_count(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "entra.json"
            summary = entra_users.import_csv(csv_bytes(
                row("Ana", "ana@pr.sebrae.com.br"), row("Outra", "ana@pr.sebrae.com.br"), row("Bia", "bia@pr.sebrae.com.br"),
            ), path)
            self.assertEqual(summary["logins_ignorados"], 1)
            self.assertEqual(summary["users"], 1)
            directory = entra_users.read_directory(path)
            self.assertEqual(directory["logins_ignorados"], 1)
            self.assertNotIn("ana", directory["users"])

    def test_invalid_rows_are_skipped_and_counted(self):
        for bad in (
            row("O'Brien", "o'brien@pr.sebrae.com.br"),
            row("", "vazio@pr.sebrae.com.br"),
            row("N" * 301, "longo@pr.sebrae.com.br"),
        ):
            with self.subTest(bad=bad[:20]):
                parsed = entra_users.parse_csv(csv_bytes(row("Ana", "ana@pr.sebrae.com.br"), bad, row("Bia", "bia@pr.sebrae.com.br")))
                self.assertEqual(parsed["users"], {"ana": "Ana", "bia": "Bia"})
                self.assertEqual(parsed["logins_ignorados"], 1)
                self.assertEqual(parsed["filtered_rows"], 3)

    def test_invalid_and_conflicting_rows_add_up(self):
        parsed = entra_users.parse_csv(csv_bytes(
            row("Ana", "ana@pr.sebrae.com.br"), row("Outra", "ana@pr.sebrae.com.br"),
            row("O'Brien", "o'brien@pr.sebrae.com.br"), row("Bia", "bia@pr.sebrae.com.br"),
        ))
        self.assertEqual(parsed["users"], {"bia": "Bia"})
        self.assertEqual(parsed["logins_ignorados"], 2)

    def test_csv_with_only_invalid_accounts_is_rejected(self):
        with self.assertRaises(entra_users.EntraImportError):
            entra_users.parse_csv(csv_bytes(row("O'Brien", "o'brien@pr.sebrae.com.br"), row("", "vazio@pr.sebrae.com.br")))

    def test_all_logins_conflicting_keeps_previous_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "entra.json"
            entra_users.import_csv(csv_bytes(row("Bia", "bia@pr.sebrae.com.br")), path)
            with self.assertRaises(entra_users.EntraImportError):
                entra_users.import_csv(csv_bytes(row("Ana", "ana@pr.sebrae.com.br"), row("Outra", "ana@pr.sebrae.com.br")), path)
            self.assertEqual(entra_users.read_directory(path)["users"], {"bia": "Bia"})


if __name__ == "__main__":
    unittest.main()
