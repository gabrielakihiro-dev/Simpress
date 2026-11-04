"""Read-only Endpoint lookup, independent of operational files and Chrome login."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from domains import endpoint_lookup
from routers.endpoint_lookup import create_endpoint_lookup_router
from scripts import automacao_rotinas_chrome as automation
from scripts import verificar_usuarios_endpoint as grid


def grade(rows, total=None):
    names = ["Número de série", "Usuários logados", "Usuário do último logon", "Nome do computador"]
    return {
        "cabecalhos": [{"texto": name, "x0": i * 100, "x1": (i + 1) * 100} for i, name in enumerate(names)],
        "linhas": [[{"texto": value, "x0": i * 100, "x1": (i + 1) * 100} for i, value in enumerate((*row, "PRMAC-TEST"))] for row in rows],
        "carregando": False, "vazia": not rows, "total": len(rows) if total is None else total,
    }


class LookupTests(unittest.TestCase):
    def lookup(self, rows, serial="ABC", mac=False, total=None):
        with patch.object(grid, "aplicar_filtro", return_value=grade(rows, total)):
            return endpoint_lookup.consultar_grade(MagicMock(), automation, serial, mac)

    def test_exact_match_reads_last_logon_not_logged_users(self):
        self.assertEqual(self.lookup([("ABC", "wrong-user", "right-user"), ("ABCD", "other", "other")]),
                         {"status": "found", "serial": "ABC", "ultimo_logon": "right-user"})

    def test_missing_ambiguous_and_blank_user_are_distinct(self):
        self.assertEqual(self.lookup([])["status"], "not_found")
        self.assertEqual(self.lookup([("ABC", "a", "b"), ("ABC", "c", "d")])["status"], "ambiguous")
        self.assertEqual(self.lookup([("ABC", "logged-user", "")])["ultimo_logon"], "")

    def test_incomplete_grid_and_missing_last_logon_column_raise(self):
        with self.assertRaises(RuntimeError):
            self.lookup([("ABC", "a", "b")], total=2)
        data = grade([("ABC", "a", "b")])
        data["cabecalhos"].pop(2)
        with patch.object(grid, "aplicar_filtro", return_value=data), self.assertRaises(RuntimeError):
            endpoint_lookup.consultar_grade(MagicMock(), automation, "ABC", False)

    def test_mac_retry_only_when_authorized_and_exact_missing(self):
        for mac, count, status in [(False, 1, "not_found"), (True, 2, "found")]:
            with self.subTest(mac=mac), patch.object(grid, "limpar_filtro"), patch.object(grid, "aplicar_filtro", side_effect=[grade([]), grade([("ABC", "wrong", "user")])]) as search:
                self.assertEqual(endpoint_lookup.consultar_grade(MagicMock(), automation, "SABC", mac, details_serials=("SABC",))["status"], status)
                self.assertEqual(search.call_count, count)
                self.assertTrue(all(call.args[2] == grid.COLUNA_SERIE for call in search.call_args_list))

    def test_mac_fallback_does_not_associate_another_local_equipment(self):
        for details in [("SABC", "ABC"), ("SABC", "S-ABC"), ()]:
            with self.subTest(details=details), patch.object(grid, "aplicar_filtro", side_effect=[grade([]), grade([("ABC", "wrong", "other-machine")])]) as search:
                result = endpoint_lookup.consultar_grade(MagicMock(), automation, "SABC", True, details_serials=details)
                self.assertEqual(result, {"status": "ambiguous", "serial": "SABC", "origem": "base_local"})
                self.assertEqual(search.call_count, 1)

    def test_mac_fallback_confirms_reset_before_searching_without_s(self):
        cleared = False
        def clear(*args):
            nonlocal cleared
            cleared = True
        def search(page, auto, column, serial):
            if serial == "SABC":
                return grade([])
            # Without an intermediate confirmed reset, this is still the previous empty DOM.
            return grade([("ABC", "wrong", "right")]) if cleared else grade([])
        with patch.object(grid, "aplicar_filtro", side_effect=search), patch.object(grid, "limpar_filtro", side_effect=clear) as reset:
            result = endpoint_lookup.consultar_grade(MagicMock(), automation, "SABC", True, details_serials=("SABC",))
            self.assertEqual(result["status"], "found")
            self.assertEqual(result["ultimo_logon"], "right")
            reset.assert_called_once()

    def test_mac_fallback_requires_unique_prmac_hostname_from_live_row(self):
        data = grade([("ABC", "wrong", "another-user")])
        data["linhas"][0][3]["texto"] = "PRNOTE-OTHER"
        with patch.object(grid, "limpar_filtro"), patch.object(grid, "aplicar_filtro", side_effect=[grade([]), data]):
            result = endpoint_lookup.consultar_grade(MagicMock(), automation, "SABC", True, details_serials=("SABC",))
        self.assertEqual(result, {"status": "ambiguous", "serial": "SABC", "origem": "correspondencia_mac"})

    def test_private_tab_only_and_lock_released_on_success_or_failure(self):
        for failure in (False, True):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as tmp:
                lock = Path(tmp) / "automacao_chrome.lock"
                pw = MagicMock()
                browser = pw.chromium.connect_over_cdp.return_value
                context = browser.contexts = [MagicMock()]
                page = context[0].new_page.return_value
                with patch.object(automation, "TRAVA_PATH", lock), patch.object(automation, "acionar_quando_pronto"), \
                     patch.object(automation, "selecionar_todos_computadores"), patch.object(automation, "confirmar_modo_todos"), \
                     patch.object(endpoint_lookup, "consultar_grade", side_effect=RuntimeError("failure") if failure else None,
                                  return_value={"status": "found"}), \
                     patch("playwright.sync_api.sync_playwright") as factory:
                    factory.return_value.__enter__.return_value = pw
                    if failure:
                        with self.assertRaises(RuntimeError):
                            endpoint_lookup.consultar("ABC", False)
                    else:
                        endpoint_lookup.consultar("ABC", False)
                    self.assertFalse(lock.exists())
                    page.close.assert_called_once()
                    browser.close.assert_not_called()
                    pw.chromium.connect_over_cdp.assert_called_once_with("http://127.0.0.1:9333", timeout=10000)

    def test_busy_lock_prevents_browser_connection(self):
        with patch.object(automation, "adquirir_trava", side_effect=automation.TravaOcupada("busy")), \
             patch("playwright.sync_api.sync_playwright") as factory, self.assertRaises(automation.TravaOcupada):
            endpoint_lookup.consultar("ABC", False)
        factory.assert_not_called()

    def test_private_tab_preparation_does_not_require_logged_users_column(self):
        data = grade([("ABC", "logged", "last")])
        data["cabecalhos"].pop(1)
        pw = MagicMock()
        pw.chromium.connect_over_cdp.return_value.contexts = [MagicMock()]
        with tempfile.TemporaryDirectory() as tmp, patch.object(automation, "TRAVA_PATH", Path(tmp) / "lock"), \
             patch("playwright.sync_api.sync_playwright") as factory, \
             patch.object(automation, "selecionar_todos_computadores"), patch.object(automation, "confirmar_modo_todos"), \
             patch.object(automation, "acionar_quando_pronto") as ready, \
             patch.object(grid, "ler_grade", return_value=data), patch.object(endpoint_lookup, "consultar_grade", return_value={}):
            factory.return_value.__enter__.return_value = pw
            endpoint_lookup.consultar("ABC", False)
            self.assertTrue(ready.call_args.kwargs["confirmar"]())


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.lookup = MagicMock(return_value={"status": "found", "serial": "ABC", "ultimo_logon": "user"})
        self.equipment = {"serial": "ABC", "categoria": "notebook"}
        self.details = ("ABC",)
        app = FastAPI()
        self.snapshot = MagicMock(side_effect=lambda serial: dict(self.equipment, details_serials=self.details))
        app.include_router(create_endpoint_lookup_router(get_snapshot=self.snapshot, lookup=self.lookup))
        self.client = TestClient(app)

    def test_read_only_post_and_server_owned_mac_classification(self):
        response = self.client.post("/api/endpoint/consultar", json={"serial": " abc "})
        self.assertEqual(response.status_code, 200)
        self.lookup.assert_called_once_with("ABC", False, ("ABC",))
        self.equipment["categoria"] = "macbook"
        self.client.post("/api/endpoint/consultar", json={"serial": "ABC"})
        self.assertEqual(self.lookup.call_args.args, ("ABC", True, ("ABC",)))
        self.equipment = {"serial": "ABC", "tipo": "MACBOOK", "modelo": "AIR 13"}
        self.client.post("/api/endpoint/consultar", json={"serial": "ABC"})
        self.assertEqual(self.lookup.call_args.args, ("ABC", True, ("ABC",)))

    def test_local_duplicate_status_reaches_mac_guard(self):
        self.equipment = {"serial": "SABC", "categoria": "macbook", "serie_detalhes_duplicada": True, "invall_alias_status": "indisponivel"}
        self.details = ("SABC",)
        self.client.post("/api/endpoint/consultar", json={"serial": "SABC"})
        self.assertEqual(self.lookup.call_args.args, ("SABC", True, ("SABC", "SABC")))

    def test_busy_and_cdp_failures_are_not_misses(self):
        for exception, expected in [(automation.TravaOcupada("busy"), 409), (RuntimeError("secret URL"), 503)]:
            self.lookup.side_effect = exception
            response = self.client.post("/api/endpoint/consultar", json={"serial": "ABC"})
            self.assertEqual(response.status_code, expected)
            self.assertNotIn("secret URL", response.text)

    def test_invalid_input_never_opens_browser(self):
        for serial in ("", "   ", "A" * 129, "ABC\nDEF"):
            self.assertEqual(self.client.post("/api/endpoint/consultar", json={"serial": serial}).status_code, 422)
        self.lookup.assert_not_called()

    def test_exact_result_uses_one_atomic_snapshot(self):
        self.client.post("/api/endpoint/consultar", json={"serial": "ABC"})
        self.snapshot.assert_called_once_with("ABC")

    def test_fallback_user_is_discarded_if_relevant_snapshot_changes(self):
        self.lookup.return_value = {"status": "found", "serial": "SABC", "ultimo_logon": "must-not-escape", "_fallback_mac": True}
        before = {"serial": "SABC", "tipo": "MacBook", "modelo": "Air", "details_serials": ("SABC",), "serie_detalhes_duplicada": False}
        for changed in ({"serie_detalhes_duplicada": True}, {"details_serials": ("ABC", "SABC")}, {"tipo": "Notebook", "modelo": "ProBook"}):
            with self.subTest(changed=changed):
                self.snapshot.side_effect = [before, dict(before, **changed)]
                self.lookup.return_value = {"status": "found", "serial": "SABC", "ultimo_logon": "must-not-escape", "_fallback_mac": True}
                response = self.client.post("/api/endpoint/consultar", json={"serial": "SABC"})
                self.assertEqual(response.json(), {"status": "ambiguous", "serial": "SABC", "origem": "base_local"})

    def test_stable_fallback_result_is_returned_without_internal_marker(self):
        self.lookup.return_value = {"status": "found", "serial": "ABC", "ultimo_logon": "user", "_fallback_mac": True}
        response = self.client.post("/api/endpoint/consultar", json={"serial": "ABC"})
        self.assertEqual(response.json(), {"status": "found", "serial": "ABC", "ultimo_logon": "user"})
        self.assertEqual(self.snapshot.call_count, 2)
