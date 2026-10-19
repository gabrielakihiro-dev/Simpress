"""Hostname que some do Endpoint aparece em "Sem acesso há 7 dias ou mais"."""

import unittest
from datetime import datetime, timedelta, timezone

from domains.inventory_comparison import compare_uploaded_workbooks

REFERENCE = datetime(2026, 10, 19, 12, 0, tzinfo=timezone(timedelta(hours=-3)))
STALE = (REFERENCE - timedelta(days=70)).isoformat()


def table(records):
    return {"sheet": "Inventario", "headers": set(), "records": records}


def endpoint_row(serial, hostname, verified=STALE):
    return {"SERIAL": serial, "NOMEDOCOMPUTADOR": hostname, "ULTIMAVERIFICACAOCOMEXITO": verified}


def details_row(serial, alias):
    return {"SERIAL": serial, "APELIDO": alias, "CIDADE": "Curitiba"}


class VanishedHostnameTests(unittest.TestCase):
    def compare(self, endpoint, details, previous=None):
        return compare_uploaded_workbooks(
            table(endpoint), table(details), {}, as_of=REFERENCE, previous_endpoint_hostnames=previous,
        )["sem_acesso_7_dias"]

    def test_uses_previous_endpoint_hostname(self):
        items = self.compare([endpoint_row("SN1", "")], [details_row("SN1", "PRNOTEOLD")], {"SN1": "PRNOTERL01"})

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["computador"], "PRNOTERL01")
        self.assertTrue(items[0]["hostname_sumiu_endpoint"])
        self.assertEqual(items[0]["hostname_origem"], "endpoint_anterior")
        self.assertGreaterEqual(items[0]["dias_sem_verificacao"], 70)

    def test_falls_back_to_simpress_alias_when_previous_file_also_lacks_it(self):
        items = self.compare([endpoint_row("SN1", "")], [details_row("SN1", "PRNOTERL02")])

        self.assertEqual(items[0]["computador"], "PRNOTERL02")
        self.assertEqual(items[0]["hostname_origem"], "simpress")

    def test_ignores_rows_without_recoverable_hostname_or_recent_ones(self):
        self.assertEqual(self.compare([endpoint_row("SN1", "")], []), [])
        recent = (REFERENCE - timedelta(days=1)).isoformat()
        self.assertEqual(self.compare([endpoint_row("SN1", "", recent)], [details_row("SN1", "PRNOTERL02")]), [])

    def test_normal_stale_rows_are_not_flagged(self):
        items = self.compare([endpoint_row("SN1", "PRNOTERL03")], [details_row("SN1", "PRNOTERL03")])

        self.assertEqual(len(items), 1)
        self.assertNotIn("hostname_sumiu_endpoint", items[0])


if __name__ == "__main__":
    unittest.main()
