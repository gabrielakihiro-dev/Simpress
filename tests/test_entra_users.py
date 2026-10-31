import io
import json
import tempfile
import unittest
from pathlib import Path

import openpyxl

from domains import effective_alias, entra_users
from domains.entra_inbox import EntraInbox
from domains.equipment_search import build_search_index, normalize_search_term, search_index, suggest_user_term

HEADER = "id,displayName,userPrincipalName,userType,onPremisesSyncEnabled,identities,companyName,creationType;"


def csv_bytes(*rows, header=HEADER):
    return ("﻿" + "\r\n".join([header, *rows]) + "\r\n").encode("utf-8")


def row(name, upn, extra=""):
    return f'1,"{name}",{upn},Member,No,View,Sebrae PR,{extra};'


class ParseCsvTests(unittest.TestCase):
    def test_keeps_only_exact_pr_domain_and_prefixes(self):
        parsed = entra_users.parse_csv(csv_bytes(
            row("[DES_PR] Ana Lima", "ana.lima@pr.sebrae.com.br"),
            row("Outro Estado", "outro@ba.sebrae.com.br"),
            row("Falso", "x@pr.sebrae.com.br.evil.com"),
            row("Subdominio", "y@sub.pr.sebrae.com.br"),
        ))
        self.assertEqual(parsed["users"], {"ana.lima": "[DES_PR] Ana Lima"})
        self.assertEqual(parsed["source_rows"], 4)
        self.assertEqual(parsed["filtered_rows"], 1)

    def test_whole_line_encapsulated_rows_are_read(self):
        line = '"1,""José Ção"",jose@pr.sebrae.com.br,Member,No,View,PR,;"'
        parsed = entra_users.parse_csv(csv_bytes(line))
        self.assertEqual(parsed["users"], {"jose": "José Ção"})

    def test_malformed_foreign_row_does_not_block_import(self):
        parsed = entra_users.parse_csv(csv_bytes('broken "row,ba.sebrae.com.br', row("Ana", "ana@pr.sebrae.com.br")))
        self.assertEqual(list(parsed["users"]), ["ana"])

    def test_duplicate_login_with_different_names_is_ignored(self):
        parsed = entra_users.parse_csv(csv_bytes(
            row("Ana", "ana@pr.sebrae.com.br"), row("Outra", "ANA@pr.sebrae.com.br"), row("Bia", "bia@pr.sebrae.com.br"),
        ))
        self.assertEqual(parsed["users"], {"bia": "Bia"})
        self.assertEqual(parsed["logins_ignorados"], 1)

    def test_identical_duplicate_is_accepted_and_invalid_inputs_fail(self):
        parsed = entra_users.parse_csv(csv_bytes(row("Ana", "ana@pr.sebrae.com.br"), row("Ana", "ana@pr.sebrae.com.br")))
        self.assertEqual(len(parsed["users"]), 1)
        with self.assertRaises(entra_users.EntraImportError):
            entra_users.parse_csv(b"")
        with self.assertRaises(entra_users.EntraImportError):
            entra_users.parse_csv(csv_bytes(row("X", "x@ba.sebrae.com.br")))
        with self.assertRaises(entra_users.EntraImportError):
            entra_users.parse_csv(csv_bytes(row("X", "x@pr.sebrae.com.br"), header="a,b"))


class StorageAndExportTests(unittest.TestCase):
    def test_import_is_persisted_and_xlsx_is_safe(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "entra.json"
            summary = entra_users.import_csv(csv_bytes(row("=HYPERLINK(1)", "evil@pr.sebrae.com.br"), row("Bia", "bia@pr.sebrae.com.br")), path)
            self.assertEqual(summary["users"], 2)
            directory = entra_users.read_directory(path)
            workbook = openpyxl.load_workbook(io.BytesIO(entra_users.export_xlsx(directory)))
            sheet = workbook.active
            self.assertEqual([cell.value for cell in sheet[1]], ["Login", "Display Name"])
            self.assertEqual(sheet["B3"].value, "=HYPERLINK(1)")
            self.assertEqual(sheet["B3"].data_type, "s")
            self.assertTrue(sheet.auto_filter.ref)
            self.assertEqual(sheet.freeze_panes, "A2")

    def test_login_key_accepts_only_individual_pr_logins(self):
        self.assertEqual(entra_users.login_key("SEBRAE\\Ana.Lima"), "ana.lima")
        self.assertEqual(entra_users.login_key("ana@pr.sebrae.com.br"), "ana")
        self.assertEqual(entra_users.login_key("ana@outro.com"), "")
        self.assertEqual(entra_users.login_key("a\\b\\c"), "")


class ResolveNameTests(unittest.TestCase):
    directory = {"users": {"ana": "Ana Lima"}}

    def test_entra_wins_over_manual(self):
        manual = {"S1": {"login": "ana", "nome": "Manual"}}
        self.assertEqual(entra_users.resolve_name("ana", "s1", self.directory, manual), ("Ana Lima", "entra"))

    def test_manual_is_bound_to_current_login(self):
        manual = {"S1": {"login": "bruno", "nome": "Bruno Souza"}}
        self.assertEqual(entra_users.resolve_name("bruno", "s1", self.directory, manual), ("Bruno Souza", "manual"))
        self.assertEqual(entra_users.resolve_name("carlos", "s1", self.directory, manual), ("", ""))

    def test_manual_name_save_and_clear(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "manual.json"
            entra_users.save_manual_name(path, "s1", "Bruno", "Bruno Souza")
            self.assertEqual(entra_users.read_manual_names(path)["S1"], {"login": "bruno", "nome": "Bruno Souza"})
            entra_users.save_manual_name(path, "s1", "bruno", "")
            self.assertEqual(entra_users.read_manual_names(path), {})
            with self.assertRaises(ValueError):
                entra_users.save_manual_name(path, "s1", "bruno", "x" * 400)

    def test_manual_name_needs_a_valid_login(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "manual.json"
            for login in ("", "   ", "dominio\\a\\b", "bruno@outro.com"):
                with self.assertRaises(ValueError):
                    entra_users.save_manual_name(path, "s1", login, "Bruno Souza")
            self.assertFalse(path.exists())

    def test_empty_login_never_matches_a_stored_manual_name(self):
        manual = {"S1": {"login": "", "nome": "Fantasma"}}
        self.assertEqual(entra_users.resolve_name("", "s1", self.directory, manual), ("", ""))
        self.assertEqual(entra_users.resolve_name("dominio\\a\\b", "s1", self.directory, manual), ("", ""))


class EquipmentAssociationTests(unittest.TestCase):
    def apply(self, records, item, directory=None, manual=None):
        index = effective_alias.build_endpoint_alias_index(records)
        index["entra_directory"] = directory or {"users": {"ana": "Ana Lima"}}
        index["manual_person_names"] = manual or {}
        effective_alias.apply_effective_alias(item, index)
        return item

    def test_unique_login_gets_entra_name_and_is_not_editable(self):
        item = self.apply(
            [{"SERIAL": "S1", "NOMEDOCOMPUTADOR": "PRNOTE1", "USUARIOSLOGADOS": "ana"}],
            {"serial": "S1", "tipo": "NOTEBOOK", "_apelido_base": "X"},
        )
        self.assertEqual((item["nome_pessoa"], item["nome_pessoa_origem"], item["nome_pessoa_editavel"]), ("Ana Lima", "entra", False))

    def test_notebook_without_entra_name_accepts_manual_name_bound_to_login(self):
        records = [{"SERIAL": "S1", "NOMEDOCOMPUTADOR": "PRNOTE1", "USUARIOSLOGADOS": "bruno"}]
        item = self.apply(records, {"serial": "S1", "tipo": "NOTEBOOK", "_apelido_base": "X"})
        self.assertEqual(item["nome_pessoa"], "")
        self.assertTrue(item["nome_pessoa_editavel"])
        manual = {"S1": {"login": "bruno", "nome": "Bruno Souza"}}
        item = self.apply(records, {"serial": "S1", "tipo": "NOTEBOOK", "_apelido_base": "X"}, manual=manual)
        self.assertEqual((item["nome_pessoa"], item["nome_pessoa_origem"]), ("Bruno Souza", "manual"))
        records[0]["USUARIOSLOGADOS"] = "carlos"
        item = self.apply(records, {"serial": "S1", "tipo": "NOTEBOOK", "_apelido_base": "X"}, manual=manual)
        self.assertEqual(item["nome_pessoa"], "")

    def test_notebook_without_valid_login_is_not_editable(self):
        for login in ("", "bruno@outro.com"):
            records = [{"SERIAL": "S1", "NOMEDOCOMPUTADOR": "PRNOTE1", "USUARIOSLOGADOS": login}]
            item = self.apply(records, {"serial": "S1", "tipo": "NOTEBOOK", "_apelido_base": "X"})
            self.assertEqual(item["nome_pessoa"], "")
            self.assertFalse(item["nome_pessoa_editavel"])

    def test_ambiguous_endpoint_users_get_no_name(self):
        item = self.apply(
            [
                {"SERIAL": "S1", "NOMEDOCOMPUTADOR": "A", "USUARIOSLOGADOS": "ana"},
                {"SERIAL": "S1", "NOMEDOCOMPUTADOR": "B", "USUARIOSLOGADOS": "bruno"},
            ],
            {"serial": "S1", "tipo": "NOTEBOOK", "_apelido_base": "X"},
        )
        self.assertEqual(item["nome_pessoa"], "")

    def test_macbook_endpoint_serial_without_s_matches_uniquely(self):
        item = self.apply(
            [{"SERIAL": "CMVXKV7YCM", "NOMEDOCOMPUTADOR": "PRMAC001", "USUARIOSLOGADOS": "ana"}],
            {"serial": "SCMVXKV7YCM", "tipo": "OUTRO", "modelo": "MacBook Air", "_apelido_base": "X"},
        )
        self.assertEqual(item["nome_pessoa"], "Ana Lima")


class SearchByNameTests(unittest.TestCase):
    def test_partial_accent_insensitive_search_for_entra_and_manual_names(self):
        cache = {
            "S1": {"serial": "S1", "nome_pessoa": "José da Conceição", "nome_pessoa_origem": "entra", "usuarios_logados": "jose"},
            "S2": {"serial": "S2", "nome_pessoa": "Márcia Souza", "nome_pessoa_origem": "manual", "usuarios_logados": "msouza"},
        }
        indexed = build_search_index(cache)
        self.assertEqual([r["serial"] for r in search_index(indexed, "conceicao")], ["S1"])
        self.assertEqual([r["serial"] for r in search_index(indexed, "MARCIA s")], ["S2"])
        self.assertEqual(search_index(indexed, "inexistente"), [])

    def test_first_and_last_name_find_full_name_with_middle_names(self):
        cache = {
            "BRJ5512DWS": {"serial": "BRJ5512DWS", "nome_pessoa": "Bruno Gabriel de Oliveira Pinheiro", "usuarios_logados": "bpinheiro"},
            "S2": {"serial": "S2", "nome_pessoa": "Bruno Souza", "usuarios_logados": "bsouza"},
        }
        indexed = build_search_index(cache)
        for query in ("bruno pinheiro", "Bruno Oliveira", "pinheiro bruno", "bruno gabriel pinheiro"):
            self.assertEqual([r["serial"] for r in search_index(indexed, query)], ["BRJ5512DWS"], query)
        self.assertEqual(search_index(indexed, "bruno inexistente"), [])

    def test_typo_suggests_closest_user_name_only_when_it_finds_equipment(self):
        cache = {
            "BRJ5512DWS": {"serial": "BRJ5512DWS", "nome_pessoa": "Bruno Gabriel de Oliveira Pinheiro", "usuarios_logados": "bpinheiro"},
            "S2": {"serial": "S2", "nome_pessoa": "José da Conceição", "usuarios_logados": "jose"},
        }
        indexed = build_search_index(cache)
        suggest = lambda query: suggest_user_term(indexed, normalize_search_term(query))
        self.assertEqual(suggest("bpinheirp"), "bpinheiro")
        self.assertEqual(suggest("bruno pinheirp"), "Bruno Pinheiro")
        self.assertEqual(suggest("conceiçao"), "")  # accent-insensitive search already finds it
        self.assertEqual(suggest("zzzzzz"), "")
        self.assertEqual(suggest("bruno inexistente"), "")


class InboxTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.calls = []
        self.inbox = EntraInbox(self.root, lambda data: self.calls.append(data) or {"users": 1})

    def tearDown(self):
        self.temporary.cleanup()

    def batch(self, name="lote1", files=("usuarios.csv",)):
        folder = self.root / "pendentes" / name
        folder.mkdir(parents=True)
        for file in files:
            (folder / file).write_bytes(b"conteudo")
        return folder

    def test_batch_is_imported_after_it_is_stable(self):
        self.inbox.process_once()
        self.batch()
        self.inbox.process_once()
        self.assertEqual(self.calls, [])
        self.inbox.process_once()
        self.assertEqual(self.calls, [b"conteudo"])
        result = json.loads((self.root / "processadas" / "lote1" / "_resultado.json").read_text(encoding="utf-8"))
        self.assertEqual(result["status"], "concluido")

    def test_batch_still_being_copied_is_not_rejected(self):
        folder = self.batch()
        self.inbox.process_once()
        (folder / "outro.csv").write_bytes(b"x")  # copy still in progress
        self.inbox.process_once()
        self.assertTrue(folder.exists())
        self.assertEqual(self.calls, [])

    def test_batch_with_two_files_fails_once_stable(self):
        self.batch(files=("a.csv", "b.csv"))
        self.inbox.process_once()
        self.inbox.process_once()
        self.assertTrue((self.root / "falhas" / "lote1" / "_resultado.json").exists())

    def test_interrupted_batch_with_result_is_recovered_without_reimport(self):
        folder = self.root / "processando" / "lote1"
        folder.mkdir(parents=True)
        (folder / "usuarios.csv").write_bytes(b"x")
        (folder / "_resultado.json").write_text('{"status": "concluido"}', encoding="utf-8")
        self.inbox.process_once()
        self.assertEqual(self.calls, [])
        self.assertTrue((self.root / "processadas" / "lote1").exists())

    def test_interrupted_batch_without_result_is_retried(self):
        folder = self.root / "processando" / "lote2"
        folder.mkdir(parents=True)
        (folder / "usuarios.csv").write_bytes(b"x")
        self.inbox.process_once()
        self.assertEqual(self.calls, [b"x"])
        self.assertTrue((self.root / "processadas" / "lote2").exists())

    def test_import_error_moves_batch_to_failures(self):
        def boom(_data):
            raise ValueError("ruim")
        inbox = EntraInbox(self.root, boom)
        self.batch()
        inbox.process_once()
        inbox.process_once()
        result = json.loads((self.root / "falhas" / "lote1" / "_resultado.json").read_text(encoding="utf-8"))
        self.assertEqual(result["erro"], "ruim")


class ReadNamesSafeTests(unittest.TestCase):
    def test_corrupt_files_yield_empty_names_but_strict_readers_still_raise(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory_path = Path(tmp) / "usuarios_entra_pr.json"
            manual_path = Path(tmp) / "nomes_pessoas_manuais.json"
            directory_path.write_text('{"users": {"ana": "Ana', encoding="utf-8")
            manual_path.write_bytes(b"\xff\xfe{")
            directory, manual = entra_users.read_names_safe(directory_path, manual_path)
            self.assertEqual((directory, manual), ({}, {}))
            self.assertEqual(entra_users.resolve_name("ana", "S1", directory, manual), ("", ""))
            with self.assertRaises(ValueError):
                entra_users.read_directory(directory_path)
            with self.assertRaises(ValueError):
                entra_users.read_manual_names(manual_path)

    def test_valid_files_are_returned_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory_path = Path(tmp) / "usuarios_entra_pr.json"
            manual_path = Path(tmp) / "nomes_pessoas_manuais.json"
            directory_path.write_text('{"users": {"ana": "Ana Lima"}}', encoding="utf-8")
            manual_path.write_text('{"S1": {"login": "bruno", "nome": "Bruno"}}', encoding="utf-8")
            directory, manual = entra_users.read_names_safe(directory_path, manual_path)
            self.assertEqual(directory["users"], {"ana": "Ana Lima"})
            self.assertEqual(manual["S1"]["nome"], "Bruno")


if __name__ == "__main__":
    unittest.main()
