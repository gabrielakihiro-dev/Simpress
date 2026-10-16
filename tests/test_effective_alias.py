import logging
import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException

from domains import effective_alias


def endpoint_index(records):
    return effective_alias.build_endpoint_alias_index(records)


def equipment(serial, simpress_alias="SIMPRESS-ALIAS", manual_alias=None):
    item = {"serial": serial, "_apelido_base": simpress_alias}
    if manual_alias is not None:
        item["_apelido_local"] = manual_alias
        item["_apelido_manual_override"] = True
    return item


class EffectiveAliasPrecedenceTests(unittest.TestCase):
    def apply(self, item, index, **kwargs):
        effective_alias.apply_effective_alias(item, index, **kwargs)
        return item

    def test_manual_override_wins_over_unique_endpoint_hostname(self):
        index = endpoint_index([{"SERIAL": "s-1", "NOMEDOCOMPUTADOR": "PRNOTE-ENDPOINT"}])
        item = self.apply(equipment("S1", manual_alias="MANUAL"), index)
        self.assertEqual(item["apelido"], "MANUAL")
        self.assertEqual(item["invall_alias_status"], "aplicado")
        self.assertEqual(item["invall_alias_detail"], "Série associada ao Endpoint; o apelido manual prevalece.")

    def test_unique_endpoint_hostname_wins_over_simpress_alias(self):
        index = endpoint_index([{"SERIAL": " s1 ", "NOMEDOCOMPUTADOR": "PRNOTE-ENDPOINT", "USUARIOSLOGADOS": "ana"}])
        item = self.apply(equipment("S1"), index)
        self.assertEqual(item["apelido"], "PRNOTE-ENDPOINT")
        self.assertEqual(item["usuarios_logados"], "ana")
        self.assertEqual(item["invall_alias_status"], "aplicado")

    def test_simpress_alias_is_kept_without_a_unique_endpoint_hostname(self):
        index = endpoint_index([
            {"SERIAL": "DUP", "NOMEDOCOMPUTADOR": "HOST-A"},
            {"SERIAL": "DUP", "NOMEDOCOMPUTADOR": "HOST-B"},
            {"SERIAL": "BLANK", "NOMEDOCOMPUTADOR": ""},
        ])
        cases = {
            "DUP": "serie_invall_duplicada",
            "BLANK": "hostname_vazio",
            "MISSING": "serie_nao_encontrada",
        }
        for serial, status in cases.items():
            with self.subTest(serial=serial):
                item = self.apply(equipment(serial), index)
                self.assertEqual(item["apelido"], "SIMPRESS-ALIAS")
                self.assertEqual(item["invall_alias_status"], status)

    def test_duplicate_simpress_serial_and_unavailable_endpoint_keep_current_alias(self):
        index = endpoint_index([{"SERIAL": "S1", "NOMEDOCOMPUTADOR": "PRNOTE-ENDPOINT"}])
        item = self.apply(equipment("S1"), index, details_duplicate=True)
        self.assertEqual(item["apelido"], "SIMPRESS-ALIAS")
        self.assertEqual(item["invall_alias_status"], "serie_detalhes_duplicada")

        item = self.apply(equipment("S1"), effective_alias.unavailable_endpoint_alias_index())
        self.assertEqual(item["apelido"], "SIMPRESS-ALIAS")
        self.assertEqual(item["invall_alias_status"], "indisponivel")

    def test_export_aliases_prefer_unambiguous_manual_overrides(self):
        aliases = effective_alias.merge_export_aliases(
            {"S1": "HOST-1", "S2": "HOST-2", "S3": "HOST-3"},
            {"s1": "MANUAL-1", "S-3": "MANUAL-A", "s3": "MANUAL-B"},
        )
        self.assertEqual(aliases, {"S1": "MANUAL-1", "S2": "HOST-2", "S3": "HOST-3"})

    def test_manual_alias_for_serial_requires_a_single_normalized_match(self):
        overrides = {"s-1": "ONE", "S2": "A", "s2": "B"}
        self.assertEqual(effective_alias.manual_alias_for_serial(overrides, "S1", "fallback"), "ONE")
        self.assertEqual(effective_alias.manual_alias_for_serial(overrides, "S2", "fallback"), "fallback")
        self.assertEqual(effective_alias.manual_alias_for_serial(overrides, "", "fallback"), "fallback")

    def test_colliding_override_keys_with_the_same_alias_are_kept(self):
        overrides = {"ab-1": "MANUAL", "AB1": "MANUAL", "C2": "X", "c-2": "Y"}
        effective_alias._last_alias_conflicts = 0
        with self.assertLogs("domains.effective_alias", level="WARNING") as logs:
            aliases = effective_alias.manual_aliases_by_serial(overrides)
        self.assertEqual(aliases, {"AB1": "MANUAL"})
        self.assertIn("1 série(s)", logs.output[0])
        self.assertNotIn("C2", logs.output[0])
        with self.assertNoLogs("domains.effective_alias", level="WARNING"):
            effective_alias.manual_aliases_by_serial(overrides)


class EndpointAliasIndexTests(unittest.TestCase):
    def test_index_separates_unique_duplicate_and_blank_rows(self):
        index = endpoint_index([
            {"SERIAL": "S1", "NOMEDOCOMPUTADOR": "HOST-1", "USUARIOSLOGADOS": "N/A"},
            {"SERIAL": "DUP", "NOMEDOCOMPUTADOR": "HOST-A"},
            {"SERIAL": "DUP", "NOMEDOCOMPUTADOR": "HOST-B"},
            {"SERIAL": "", "NOMEDOCOMPUTADOR": "ORPHAN"},
            {"SERIAL": "BLANK", "NOMEDOCOMPUTADOR": ""},
        ])
        self.assertTrue(index["available"])
        self.assertEqual(index["unique"], {"S1": "HOST-1"})
        self.assertEqual(set(index["duplicates"]), {"DUP"})
        self.assertEqual(index["blank_serials"], [{"serie": "", "hostname": "ORPHAN"}])
        self.assertEqual(set(index["blank_hostnames"]), {"BLANK"})
        self.assertEqual(index["users"], {})

    def test_review_items_keep_source_labels(self):
        index = endpoint_index([{"SERIAL": "S1", "NOMEDOCOMPUTADOR": "HOST-1"}])
        reasons = {item["serie"]: item["motivo"] for item in effective_alias.endpoint_alias_review_items(index, {"S2"})}
        self.assertEqual(reasons, {
            "S2": "Série não encontrada no endpoint; apelido atual preservado.",
            "S1": "Série não encontrada na Simpress; nenhum dado foi alterado.",
        })

    def test_unreadable_endpoint_returns_unavailable_index(self):
        with tempfile.TemporaryDirectory() as directory:
            endpoint_file = Path(directory) / "InvAll.xlsx"
            endpoint_file.write_bytes(b"fixture")

            def reject(*_args):
                raise HTTPException(400, "invalid")

            services = effective_alias.EffectiveAliasServices(
                endpoint_upload_file=lambda: endpoint_file,
                validate_uploaded_workbook=reject,
                logger=logging.getLogger("tests.effective_alias"),
            )
            with self.assertLogs("tests.effective_alias", level="WARNING"):
                index = effective_alias.read_endpoint_alias_index(services)
            self.assertEqual(index, effective_alias.unavailable_endpoint_alias_index())

            missing = effective_alias.EffectiveAliasServices(
                endpoint_upload_file=lambda: Path(directory) / "missing.xlsx",
                validate_uploaded_workbook=reject,
                logger=logging.getLogger("tests.effective_alias"),
            )
            self.assertFalse(effective_alias.read_endpoint_alias_index(missing)["available"])


if __name__ == "__main__":
    unittest.main()
