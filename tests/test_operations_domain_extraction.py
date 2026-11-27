"""Direct tests of the pure/domain pieces extracted from ``routers/operations.py``."""

import json
import tempfile
import unittest
from pathlib import Path

from core.errors import DomainBusyError
from domains.sebrae_vinculos import derived_links, finalization_links_by_key, read_ticket_os_links
from domains.ticket_reporting import displayed_ticket_snapshots


def _item(os_number, tag):
    return {"fonte": "oracle", "serie": "ABC123", "os": os_number, "tag": tag}


class OperationsDomainExtractionTests(unittest.TestCase):
    def test_read_ticket_os_links_missing_file_is_empty_store(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(read_ticket_os_links(Path(tmp) / "x.json"), {"version": 1, "vinculos": {}})

    def test_read_ticket_os_links_invalid_json_is_busy_503(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "x.json"
            path.write_text("{not json", encoding="utf-8")
            with self.assertRaises(DomainBusyError) as ctx:
                read_ticket_os_links(path)
            self.assertEqual(ctx.exception.status_code, 503)

    def test_finalization_links_first_wins_and_manual_excluded(self):
        first, second, other = _item("OS1", "first"), _item("os 1", "second"), _item("OS2", "other")
        key_other = finalization_links_by_key([other], {})
        self.assertEqual(list(key_other.values()), [other])
        found = finalization_links_by_key([first, second, other], {})
        self.assertEqual([item["tag"] for item in found.values()], ["first", "other"])
        manual = {key: {} for key in key_other}
        self.assertEqual([item["tag"] for item in finalization_links_by_key([first, other], manual).values()], ["first"])

    def test_derived_links_last_wins_and_manual_excluded(self):
        first, second, other = _item("OS1", "first"), _item("OS 1", "second"), _item("OS2", "other")
        self.assertEqual([item["tag"] for item in derived_links([first, second, other], {})], ["second", "other"])
        manual = {key: {} for key in finalization_links_by_key([other], {})}
        self.assertEqual([item["tag"] for item in derived_links([first, second, other], manual)], ["second"])

    def test_displayed_snapshots_cached_only_for_the_cached_report(self):
        report = {"chamados": [], "historico": []}
        cache = {}
        displayed_ticket_snapshots(report, cache)
        self.assertNotIn("exibidos", cache)  # not the cached report: nothing kept
        cache["relatorio"] = (("sig",), report)
        first = displayed_ticket_snapshots(report, cache)
        self.assertIs(cache["exibidos"][0], report)
        cache["exibidos"] = (report, [{"id": "sentinel"}])
        self.assertEqual(displayed_ticket_snapshots(report, cache), [{"id": "sentinel"}])
        other = {"chamados": [], "historico": []}
        self.assertNotEqual(displayed_ticket_snapshots(other, cache), [{"id": "sentinel"}])
        self.assertIsInstance(first, list)


if __name__ == "__main__":
    unittest.main()
