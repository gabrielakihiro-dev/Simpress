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

    def test_exact_result_is_usable_when_endpoint_omits_pagination_count(self):
        data = grade([("ABC", "logged-user", "last-user")])
        data["total"] = None
        with patch.object(grid, "aplicar_filtro", return_value=data):
            self.assertEqual(
                endpoint_lookup.consultar_grade(MagicMock(), automation, "ABC", False),
                {"status": "found", "serial": "ABC", "ultimo_logon": "last-user"},
            )

    def test_found_keeps_row_link_internally_and_consultar_never_returns_it(self):
        data = grade([("ABC", "logged", "last")])
        data["linhas"][0][3]["href"] = H1
        with patch.object(grid, "aplicar_filtro", return_value=data):
            achado = endpoint_lookup.consultar_grade(MagicMock(), automation, "ABC", False)
        self.assertEqual((achado["_href"], achado["_hostname"]), (H1, "PRMAC-TEST"))
        with tempfile.TemporaryDirectory() as tmp, patch.object(automation, "TRAVA_PATH", Path(tmp) / "lock"), \
                patch("playwright.sync_api.sync_playwright"), patch.object(endpoint_lookup, "_preparar_aba"), \
                patch.object(endpoint_lookup, "consultar_grade", return_value=dict(achado)):
            self.assertEqual(endpoint_lookup.consultar("ABC", False), {"status": "found", "serial": "ABC", "ultimo_logon": "last"})

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

    def test_tab_stays_open_and_lock_released_on_success_or_failure(self):
        for failure in (False, True):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as tmp:
                lock = Path(tmp) / "automacao_chrome.lock"
                pw = MagicMock()
                browser = pw.chromium.connect_over_cdp.return_value
                context = browser.contexts = [MagicMock()]
                page = context[0].new_page.return_value
                with patch.object(automation, "TRAVA_PATH", lock), patch.object(automation, "acionar_quando_pronto"), \
                     patch.object(automation, "aguardar_login"), patch.object(automation, "selecionar_todos_computadores"), patch.object(automation, "confirmar_modo_todos"), \
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
                    page.close.assert_not_called()
                    browser.close.assert_not_called()
                    pw.chromium.connect_over_cdp.assert_called_once_with("http://127.0.0.1:9333", timeout=10000)

    def test_busy_lock_prevents_browser_connection(self):
        with patch.object(automation, "adquirir_trava", side_effect=automation.TravaOcupada("busy")), \
             patch("playwright.sync_api.sync_playwright") as factory, self.assertRaises(automation.TravaOcupada):
            endpoint_lookup.consultar("ABC", False)
        factory.assert_not_called()

    def test_waits_for_endpoint_login_before_reading_the_grid(self):
        pw = MagicMock()
        pw.chromium.connect_over_cdp.return_value.contexts = [MagicMock()]
        page = pw.chromium.connect_over_cdp.return_value.contexts[0].new_page.return_value
        page.url = "https://centralendpoint.pr.sebrae.com.br/webclient#/login"
        ordem = []
        with tempfile.TemporaryDirectory() as tmp, patch.object(automation, "TRAVA_PATH", Path(tmp) / "lock"), \
             patch("playwright.sync_api.sync_playwright") as factory, \
             patch.object(automation, "aguardar_login", side_effect=lambda *a, **k: ordem.append("login")) as login, \
             patch.object(automation, "endpoint_logado", return_value=True), \
             patch.object(automation, "selecionar_todos_computadores", side_effect=lambda *_: ordem.append("grade")), \
             patch.object(automation, "confirmar_modo_todos"), patch.object(automation, "acionar_quando_pronto"), \
             patch.object(endpoint_lookup, "consultar_grade", return_value={}):
            factory.return_value.__enter__.return_value = pw
            endpoint_lookup.consultar("ABC", False)
        self.assertEqual(ordem, ["login", "grade"])
        self.assertEqual(login.call_args.args[1], "Endpoint Central")
        self.assertIs(login.call_args.kwargs["entrar"], automation.endpoint_entrar)

    def test_waits_again_when_session_drops_after_second_goto(self):
        pw = MagicMock()
        pw.chromium.connect_over_cdp.return_value.contexts = [MagicMock()]
        page = pw.chromium.connect_over_cdp.return_value.contexts[0].new_page.return_value
        page.url = "https://centralendpoint.pr.sebrae.com.br/webclient#/login"
        ordem = []
        page.goto.side_effect = lambda *a, **k: ordem.append("goto")
        with tempfile.TemporaryDirectory() as tmp, patch.object(automation, "TRAVA_PATH", Path(tmp) / "lock"), \
             patch("playwright.sync_api.sync_playwright") as factory, \
             patch.object(automation, "aguardar_login", side_effect=lambda *a, **k: ordem.append("login")) as login, \
             patch.object(automation, "endpoint_logado", return_value=False) as logado, \
             patch.object(automation, "selecionar_todos_computadores", side_effect=lambda *_: ordem.append("grade")), \
             patch.object(automation, "confirmar_modo_todos"), patch.object(automation, "acionar_quando_pronto"), \
             patch.object(endpoint_lookup, "consultar_grade", return_value={}):
            factory.return_value.__enter__.return_value = pw
            endpoint_lookup.consultar("ABC", False)
        self.assertEqual(ordem, ["goto", "login", "goto", "login", "grade"])
        logado.assert_called_once_with(page)
        self.assertEqual(login.call_args_list[0], login.call_args_list[1])

    def test_private_tab_preparation_does_not_require_logged_users_column(self):
        data = grade([("ABC", "logged", "last")])
        data["cabecalhos"].pop(1)
        pw = MagicMock()
        pw.chromium.connect_over_cdp.return_value.contexts = [MagicMock()]
        with tempfile.TemporaryDirectory() as tmp, patch.object(automation, "TRAVA_PATH", Path(tmp) / "lock"), \
             patch("playwright.sync_api.sync_playwright") as factory, \
             patch.object(automation, "aguardar_login"), patch.object(automation, "selecionar_todos_computadores"), patch.object(automation, "confirmar_modo_todos"), \
             patch.object(automation, "acionar_quando_pronto") as ready, \
             patch.object(grid, "ler_grade", return_value=data), patch.object(endpoint_lookup, "consultar_grade", return_value={}):
            factory.return_value.__enter__.return_value = pw
            endpoint_lookup.consultar("ABC", False)
            self.assertTrue(ready.call_args.kwargs["confirmar"]())


ACHADO_PC1 = {"status": "found", "serial": "ABC", "_href": "#/uems/inventory/computers/1", "_hostname": "PC1"}


class RemoteControlTests(unittest.TestCase):
    def run_remote(self, found, menus=(True,), **kwargs):
        pw = MagicMock()
        pw.chromium.connect_over_cdp.return_value.contexts = [MagicMock()]
        page = pw.chromium.connect_over_cdp.return_value.contexts[0].new_page.return_value
        page.locator.return_value.first.locator.return_value.first.inner_text.return_value = " PC1 "
        page.url = ""
        with tempfile.TemporaryDirectory() as tmp, patch.object(automation, "TRAVA_PATH", Path(tmp) / "lock"),              patch("playwright.sync_api.sync_playwright") as factory,              patch.object(automation, "aguardar_login"), patch.object(automation, "selecionar_todos_computadores"), patch.object(automation, "confirmar_modo_todos"),              patch.object(automation, "acionar_quando_pronto"),              patch.object(endpoint_lookup, "consultar_grade", return_value=found),              patch.object(endpoint_lookup, "_menu_com_controle_remoto", side_effect=list(menus)), \
             patch.object(automation, "aguardar_estabilidade_pre_clique"):
            factory.return_value.__enter__.return_value = pw
            result = endpoint_lookup.controle_remoto("ABC", False, **kwargs)
        return result, page

    def test_connects_with_reason_acesso_and_closes_nothing(self):
        result, page = self.run_remote(ACHADO_PC1)
        self.assertEqual(result, {"status": "connected", "serial": "ABC", "hostname": "PC1"})
        page.locator.assert_any_call('textarea[name="reasonMessage"]:visible')
        page.locator.return_value.fill.assert_called_once_with("acesso", timeout=15000)
        page.close.assert_not_called()

    def test_red_monitor_falls_back_to_actions_menu_then_connects(self):
        result, page = self.run_remote(ACHADO_PC1, menus=(False, True))
        self.assertEqual(result["status"], "connected")
        page.locator.assert_any_call(".resource-action--tab .resource-action--button")

    def test_offline_when_no_menu_shows_remote_control(self):
        result, page = self.run_remote(ACHADO_PC1, menus=(False, False))
        self.assertEqual(result, {"status": "offline", "serial": "ABC", "hostname": "PC1"})
        page.locator.return_value.fill.assert_not_called()

    def test_waits_for_endpoint_login_before_grid_and_before_clicking_connect(self):
        pw = MagicMock()
        pw.chromium.connect_over_cdp.return_value.contexts = [MagicMock()]
        page = pw.chromium.connect_over_cdp.return_value.contexts[0].new_page.return_value
        page.locator.return_value.first.locator.return_value.first.inner_text.return_value = " PC1 "
        page.url = ""
        ordem = []
        page.locator.return_value.click.side_effect = lambda **_: ordem.append("conectar")
        with tempfile.TemporaryDirectory() as tmp, patch.object(automation, "TRAVA_PATH", Path(tmp) / "lock"), \
             patch("playwright.sync_api.sync_playwright") as factory, \
             patch.object(automation, "aguardar_login", side_effect=lambda *a, **k: ordem.append("login")) as login, \
             patch.object(automation, "endpoint_logado", return_value=True), \
             patch.object(automation, "selecionar_todos_computadores", side_effect=lambda *_: ordem.append("grade")), \
             patch.object(automation, "confirmar_modo_todos"), patch.object(automation, "acionar_quando_pronto"), \
             patch.object(endpoint_lookup, "consultar_grade", return_value=dict(ACHADO_PC1)), \
             patch.object(endpoint_lookup, "_menu_com_controle_remoto", return_value=True), \
             patch.object(automation, "aguardar_estabilidade_pre_clique", side_effect=lambda *a, **k: ordem.append("guarda")):
            factory.return_value.__enter__.return_value = pw
            result = endpoint_lookup.controle_remoto("ABC", False)
        self.assertEqual(result["status"], "connected")
        self.assertEqual(ordem, ["login", "grade", "guarda", "conectar"])
        self.assertEqual(login.call_args.args[1], "Endpoint Central")
        self.assertIs(login.call_args.kwargs["entrar"], automation.endpoint_entrar)

    def test_not_found_and_ambiguous_never_click(self):
        for status in ("not_found", "ambiguous"):
            result, page = self.run_remote({"status": status, "serial": "ABC"})
            self.assertEqual(result["status"], status)
            page.locator.return_value.fill.assert_not_called()

    def test_mac_fallback_needs_unchanged_snapshot(self):
        found = {"status": "found", "serial": "ABC", "_fallback_mac": True}
        result, page = self.run_remote(found, antes_de_conectar=lambda fallback: not fallback)
        self.assertEqual(result, {"status": "ambiguous", "serial": "ABC", "origem": "base_local"})
        page.locator.return_value.fill.assert_not_called()

    def test_cancelled_request_never_clicks_connect(self):
        # A checagem roda sempre, não só no fallback de MacBook.
        result, page = self.run_remote({"status": "found", "serial": "ABC"}, antes_de_conectar=lambda fallback: False)
        self.assertEqual(result, {"status": "ambiguous", "serial": "ABC", "origem": "pedido_cancelado"})
        page.locator.return_value.fill.assert_not_called()

    def test_cancel_during_the_guard_closes_the_dialog_without_connecting(self):
        # Cancelado depois de abrir o diálogo (durante a guarda): a 2ª checagem, logo antes do Conectar, recusa.
        antes = MagicMock(side_effect=[True, False])
        result, page = self.run_remote(dict(ACHADO_PC1), antes_de_conectar=antes)
        self.assertEqual(result, {"status": "ambiguous", "serial": "ABC", "origem": "pedido_cancelado"})
        page.locator.return_value.fill.assert_called_once_with("acesso", timeout=15000)
        page.locator.return_value.click.assert_not_called()  # o Conectar
        page.keyboard.press.assert_called_once_with("Escape")
        self.assertEqual(antes.call_count, 2)


H1, H2 = "#/uems/inventory/computers/111", "#/uems/inventory/computers/222"
ACHADO_PC2 = {"status": "found", "serial": "ABC", "ultimo_logon": "ana", "_href": H2, "_hostname": "PC2"}


class TelaControle:
    """Endpoint falso do Controle remoto; os locators se resolvem na hora da ação, como no Playwright.

    ``linhas`` = [(hostname, href)] da grade; ``vermelhos`` = hosts cujo menu da grade não tem Controle remoto;
    ``ao_escape`` = interferência do usuário logo depois de um Escape."""

    def __init__(self, linhas, vermelhos=(), ao_escape=None):
        self.linhas, self.vermelhos, self.ao_escape = list(linhas), set(vermelhos), ao_escape
        self.url, self.ordem = automation.ENDPOINT_URL, []
        self.menu, self.dialogo, self.motivo, self.falhas_fill = None, None, "", 0
        tela = self

        class Teclado:
            def press(self, tecla):
                tela.ordem.append(("tecla", tecla))
                tela.menu, tela.dialogo, tela.motivo = None, None, ""
                if tela.ao_escape:
                    tela.ao_escape(tela)
                    tela.ao_escape = None

        self.keyboard = Teclado()

    def locator(self, seletor, has_text=None):
        return LocTela(self, seletor)

    def goto(self, url, **kw):
        self.ordem.append(("goto", "#" + url.split("#", 1)[1]))
        self.url = url

    def wait_for_timeout(self, ms):
        pass


class LocTela:
    def __init__(self, tela, seletor, linha=None):
        self.t, self.seletor, self.linha = tela, seletor, linha  # linha: seletor da linha que contém este

    first = property(lambda self: self)

    def _linhas(self):
        if self.t.url != automation.ENDPOINT_URL:
            return []  # dentro de um detalhe não há grade
        alvo = self.linha or self.seletor
        return [l for l in self.t.linhas if alvo == endpoint_lookup._LINHA or f'href="{l[1]}"' in alvo]

    def locator(self, seletor):
        return LocTela(self.t, seletor, self.seletor)

    def count(self):
        if self.seletor == endpoint_lookup._ITEM_CONTROLE_REMOTO:
            return int(bool(self.t.menu and self.t.menu[1]))
        if "reasonMessage" in self.seletor or "button-primary-form" in self.seletor:
            return int(self.t.dialogo is not None)
        return len(self._linhas())

    def inner_text(self, **kw):
        return f" {self._linhas()[0][0]} "

    def click(self, **kw):
        t = self.t
        if self.seletor == ".resource-action--tab .resource-action--button":
            nome = next(n for n, h in t.linhas if t.url.endswith(h))
            t.menu, registro = (nome, True), ("acoes", nome)  # o menu Ações da página do computador tem o Controle remoto
        elif self.seletor == ".resource-action--button":
            nome = self._linhas()[0][0]
            t.menu, registro = (nome, nome not in t.vermelhos), ("menu", nome)
        elif self.seletor.startswith("a.anchor-text"):
            nome, href = self._linhas()[0]
            t.url, registro = automation.ENDPOINT_URL.split("#")[0] + href, ("link", nome)
        elif self.seletor == endpoint_lookup._ITEM_CONTROLE_REMOTO:
            assert t.menu and t.menu[1], "o item Controle remoto não está visível"
            t.dialogo, t.menu, registro = t.menu[0], None, ("item", t.menu[0])
        elif "button-primary-form" in self.seletor:
            registro = ("conectar", t.dialogo)
        else:
            raise AssertionError(self.seletor)
        t.ordem.append(registro)

    def fill(self, valor, **kw):
        if self.t.falhas_fill:
            self.t.falhas_fill -= 1
            raise TimeoutError("o diálogo do motivo demorou")
        self.t.motivo = valor

    def input_value(self, **kw):
        return self.t.motivo


def controlar(tela, achado, interferir=None):
    """Roda controle_remoto na tela falsa; a guarda falsa registra "guarda" e confere ``verificar`` uma vez."""
    def guarda(verificar, descricao, **kw):
        tela.ordem.append("guarda")
        if interferir:
            interferir(tela)
        if not verificar():
            raise automation.RotinaErro(f"{descricao}: o estado mudou antes do clique")

    with tempfile.TemporaryDirectory() as tmp, patch.object(automation, "TRAVA_PATH", Path(tmp) / "lock"), \
            patch("playwright.sync_api.sync_playwright"), patch.object(endpoint_lookup, "_preparar_aba", return_value=tela), \
            patch.object(endpoint_lookup, "consultar_grade", return_value=dict(achado)), \
            patch.object(endpoint_lookup, "_menu_com_controle_remoto", side_effect=lambda page, *a, **k: bool(page.menu and page.menu[1])), \
            patch.object(automation, "aguardar_estabilidade_pre_clique", side_effect=guarda), \
            patch.object(automation, "_pagina_ativa_recuperacao", tela), patch.object(automation.time, "sleep"):
        return endpoint_lookup.controle_remoto("ABC", False)


class RemoteControlIdentityTests(unittest.TestCase):
    """O Conectar é irreversível: só no computador do link achado pela série, uma única vez e depois da guarda."""

    def test_shifted_row_uses_the_href_row_and_connects_once_after_guard(self):
        tela = TelaControle([("PC1", H1), ("PC2", H2)])  # outra linha ficou em primeiro na grade
        self.assertEqual(controlar(tela, ACHADO_PC2), {"status": "connected", "serial": "ABC", "hostname": "PC2"})
        self.assertEqual(tela.ordem, [("menu", "PC2"), ("item", "PC2"), "guarda", ("conectar", "PC2")])

    def test_different_hostname_or_missing_link_never_connects(self):
        sem_link = {k: v for k, v in ACHADO_PC2.items() if k != "_href"}
        for achado in (dict(ACHADO_PC2, _hostname="PC9"), sem_link):
            with self.subTest(achado=achado):
                tela = TelaControle([("PC1", H1), ("PC2", H2)])
                with self.assertRaises(automation.RotinaErro):
                    controlar(tela, achado)
                self.assertEqual(tela.ordem, [])

    def test_interference_before_connect_blocks_the_click(self):
        casos = {
            "outro detalhe aberto": lambda t: setattr(t, "url", automation.ENDPOINT_URL.split("#")[0] + H1),
            "motivo apagado": lambda t: setattr(t, "motivo", ""),
            "diálogo fechado": lambda t: setattr(t, "dialogo", None),
            "linha sumiu da grade": lambda t: t.linhas.pop(),
        }
        for nome, interferir in casos.items():
            with self.subTest(nome):
                tela = TelaControle([("PC1", H1), ("PC2", H2)])
                with self.assertRaises(automation.RotinaErro):
                    controlar(tela, ACHADO_PC2, interferir)
                self.assertNotIn("conectar", [o[0] for o in tela.ordem if isinstance(o, tuple)])

    def test_unstable_reason_dialog_is_redone_but_connect_is_clicked_once(self):
        tela = TelaControle([("PC1", H1), ("PC2", H2)])
        tela.falhas_fill = 1  # a recuperação (Escape) fecha o diálogo; a etapa reabre menu e item
        self.assertEqual(controlar(tela, ACHADO_PC2)["status"], "connected")
        self.assertEqual(tela.ordem, [("menu", "PC2"), ("item", "PC2"), ("tecla", "Escape"),
                                      ("menu", "PC2"), ("item", "PC2"), "guarda", ("conectar", "PC2")])

    def test_redo_never_reuses_a_menu_or_dialog_of_another_row(self):
        # Durante a repetição o usuário abriu o menu (ou o diálogo) do PC1: fecha e reabre pela linha do PC2.
        abertos = {"menu do PC1": lambda t: setattr(t, "menu", ("PC1", True)),
                   "diálogo do PC1": lambda t: setattr(t, "dialogo", "PC1")}
        for nome, abrir in abertos.items():
            with self.subTest(nome):
                tela = TelaControle([("PC1", H1), ("PC2", H2)], ao_escape=abrir)
                tela.falhas_fill = 1
                self.assertEqual(controlar(tela, ACHADO_PC2)["status"], "connected")
                self.assertEqual(tela.ordem, [("menu", "PC2"), ("item", "PC2"), ("tecla", "Escape"), ("tecla", "Escape"),
                                              ("menu", "PC2"), ("item", "PC2"), "guarda", ("conectar", "PC2")])

    def test_red_monitor_with_another_detail_open_returns_to_the_href_detail(self):
        abrir_pc1 = lambda t: setattr(t, "url", automation.ENDPOINT_URL.split("#")[0] + H1)  # usuário abriu o PC1
        tela = TelaControle([("PC1", H1), ("PC2", H2)], vermelhos={"PC2"}, ao_escape=abrir_pc1)
        self.assertEqual(controlar(tela, ACHADO_PC2)["status"], "connected")
        self.assertEqual(tela.ordem, [("menu", "PC2"), ("tecla", "Escape"), ("goto", H2), ("acoes", "PC2"),
                                      ("item", "PC2"), "guarda", ("conectar", "PC2")])


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

    def test_remote_control_route_uses_same_rules_and_errors(self):
        remote = MagicMock(return_value={"status": "connected", "serial": "ABC", "hostname": "PC1"})
        app = FastAPI()
        app.include_router(create_endpoint_lookup_router(get_snapshot=self.snapshot, lookup=self.lookup, remote_control=remote))
        client = TestClient(app)
        response = client.post("/api/endpoint/controle-remoto", json={"serial": " abc "})
        self.assertEqual(response.json(), {"status": "connected", "serial": "ABC", "hostname": "PC1"})
        self.assertEqual(remote.call_args.args, ("ABC", False, ("ABC",)))
        self.assertTrue(remote.call_args.kwargs["antes_de_conectar"](True))
        self.snapshot.side_effect = lambda serial: dict(self.equipment, details_serials=("ABC", "X"))
        self.assertFalse(remote.call_args.kwargs["antes_de_conectar"](True))
        self.assertTrue(remote.call_args.kwargs["antes_de_conectar"](False))
        for exception, expected in [(automation.TravaOcupada("busy"), 409), (RuntimeError("secret"), 503)]:
            remote.side_effect = exception
            response = client.post("/api/endpoint/controle-remoto", json={"serial": "ABC"})
            self.assertEqual(response.status_code, expected)
            self.assertNotIn("secret", response.text)
        self.assertEqual(client.post("/api/endpoint/controle-remoto", json={"serial": ""}).status_code, 422)

    def test_remote_control_request_cancelled_or_replaced_does_not_connect(self):
        remote = MagicMock(return_value={"status": "connected", "serial": "ABC"})
        app = FastAPI()
        app.include_router(create_endpoint_lookup_router(get_snapshot=self.snapshot, lookup=self.lookup, remote_control=remote))
        client = TestClient(app)
        client.post("/api/endpoint/controle-remoto", json={"serial": "ABC", "pedido": "p1"})
        antes_p1 = remote.call_args.kwargs["antes_de_conectar"]
        self.assertTrue(antes_p1(False))
        client.post("/api/endpoint/controle-remoto", json={"serial": "ABC", "pedido": "p2"})  # substitui p1
        self.assertFalse(antes_p1(False))
        antes_p2 = remote.call_args.kwargs["antes_de_conectar"]
        self.assertTrue(antes_p2(False))
        self.assertEqual(client.post("/api/endpoint/controle-remoto/cancelar", json={"pedido": "p2"}).json(), {"status": "cancelled"})
        self.assertFalse(antes_p2(False))
        self.assertEqual(client.post("/api/endpoint/controle-remoto/cancelar", json={"pedido": ""}).status_code, 422)
        self.assertEqual(client.post("/api/endpoint/controle-remoto", json={"serial": "ABC", "pedido": "a b"}).status_code, 422)
