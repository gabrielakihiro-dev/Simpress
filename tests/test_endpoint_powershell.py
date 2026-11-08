"""PowerShell do Endpoint: o comando só é inserido; nunca há Enter. Tudo com páginas falsas, sem Chrome."""
import re
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from domains import endpoint_lookup
from routers.endpoint_lookup import create_endpoint_lookup_router
from scripts import automacao_rotinas_chrome as automation
from scripts import verificar_usuarios_endpoint as grid

PRONTO = "Executar como\nAtualmente conectado como SYSTEM"
CAIU = "O agente foi desconectado. Feche a janela e reinicie"


class Teclado:
    def __init__(self):
        self.chamadas = []

    def press(self, *args, **kwargs):
        self.chamadas.append(("press", args))

    def type(self, *args, **kwargs):
        self.chamadas.append(("type", args))

    def insert_text(self, *args, **kwargs):
        self.chamadas.append(("insert_text", args))


class LocAba:
    """Locator da aba do terminal: grava ações; qualquer tecla/envio fica em tab.enviados."""

    def __init__(self, aba, seletor, indice=0):
        self.aba, self.seletor, self.indice = aba, seletor, indice

    first = property(lambda self: self)

    def nth(self, i):
        return LocAba(self.aba, self.seletor, i)

    def count(self):
        return len(self.aba.usuarios)

    def inner_text(self, **kw):
        return self.aba.usuarios[self.indice]

    def wait_for(self, **kw):
        pass

    def click(self, **kw):
        self.aba.cliques.append((self.seletor, self.indice))
        if self.seletor == ".popover-list li:not([id])" and self.aba.troca:
            self.aba.texto = f"Atualmente conectado como {self.aba.usuarios[self.indice]}"

    def fill(self, valor, **kw):
        self.aba.preenchidos.append(valor)
        self.aba.valor = self.aba.valor_forcado if self.aba.valor_forcado is not None else valor

    def input_value(self):
        return self.aba.valor

    def press(self, *args, **kw):
        self.aba.enviados.append(("press", args))

    def press_sequentially(self, *args, **kw):
        self.aba.enviados.append(("press_sequentially", args))

    def type(self, *args, **kw):
        self.aba.enviados.append(("type", args))


class AbaTerminal:
    def __init__(self, texto=PRONTO, apos_reload=PRONTO, usuarios=(), valor_forcado=None, troca=True):
        self.texto, self.apos_reload, self.usuarios, self.valor_forcado = texto, apos_reload, list(usuarios), valor_forcado
        self.troca = troca
        self.reloads = 0
        self.fechada = False
        self.cliques, self.preenchidos, self.enviados = [], [], []
        self.valor = ""
        self.keyboard = Teclado()

    def evaluate(self, js):
        return self.texto

    def wait_for_timeout(self, ms):
        pass

    def reload(self, **kw):
        self.reloads += 1
        self.texto = self.apos_reload

    def close(self):
        self.fechada = True

    def locator(self, seletor):
        return LocAba(self, seletor)

    def sem_enter(self):
        return not self.keyboard.chamadas and not self.enviados and all("\n" not in t and "\r" not in t for t in self.preenchidos)


class LinhaGrade:
    def __init__(self, pagina, nome, alt):
        self.pagina, self.nome, self.alt = pagina, nome, alt
        self.href = f"#/uems/inventory/computers/{nome}"

    first = property(lambda self: self)

    def locator(self, seletor):
        self.seletor = seletor
        return self

    def inner_text(self, **kw):
        return f" {self.nome} "

    def get_attribute(self, nome, **kw):
        return self.href if nome == "href" else self.alt

    def click(self, **kw):
        self.pagina.cliques.append(("linha", self.nome))


class LinhaPreguicosa:
    """Como o locator do Playwright: a linha é resolvida na hora de cada ação, não quando o locator é criado."""

    def __init__(self, resolver):
        self.resolver = resolver

    first = property(lambda self: self)

    def locator(self, seletor):
        return self

    def __getattr__(self, nome):
        return getattr(self.resolver(), nome)


class LinhasDaGrade:
    def __init__(self, pagina, href=None):
        self.pagina, self.href = pagina, href

    def _atuais(self):
        return [l for l in self.pagina.linhas if self.href is None or l.href == self.href]

    def _na_posicao(self, i):
        atuais = self._atuais()
        if i >= len(atuais):
            raise TimeoutError("a linha não está na grade")
        return atuais[i]

    def count(self):
        return len(self._atuais())

    def nth(self, i):
        return LinhaPreguicosa(lambda: self._na_posicao(i))

    first = property(lambda self: LinhaPreguicosa(lambda: self._na_posicao(0)))


class LocGrade:
    def __init__(self, pagina, seletor):
        self.pagina, self.seletor = pagina, seletor

    first = property(lambda self: self)

    def hover(self, **kw):
        self.pagina.cliques.append(("hover", self.seletor))

    def click(self, **kw):
        self.pagina.cliques.append(("click", self.seletor))


class PaginaGrade:
    def __init__(self, hosts, aba):
        self.todas = [LinhaGrade(self, nome, alt) for nome, alt in hosts]
        self.linhas = self.todas
        self.aba, self.cliques, self.keyboard = aba, [], Teclado()
        self.falhas_expect, self.sobra = 0, None  # quantas vezes a aba nova "não chega" a tempo, e a aba que aparece tarde
        pagina = self

        class Contexto:
            @contextmanager
            def expect_page(self, **kw):
                yield MagicMock(value=pagina.aba)
                if pagina.falhas_expect:
                    pagina.falhas_expect -= 1
                    self.pages.append(pagina.sobra)  # a aba aparece, mas depois do prazo
                    raise TimeoutError("nenhuma aba nova no prazo")
                self.pages.append(pagina.aba)

        self.context = Contexto()
        self.context.pages = [self]

    def locator(self, seletor):
        if seletor == endpoint_lookup._LINHA:
            return LinhasDaGrade(self)
        href = re.search(r'href="([^"]+)"', seletor)
        if seletor.startswith(endpoint_lookup._LINHA) and href:
            return LinhasDaGrade(self, href.group(1))
        return LocGrade(self, seletor)

    def filtrar(self, page, auto, coluna, valor):
        self.filtros.append(valor)
        self.linhas = [l for l in self.todas if valor.lower() in l.nome.lower()]
        return {}

    filtros: list  # preenchido em abrir()


def abrir(hosts, aba, hostname=None, modo="sistema", comando="Get-Date", usuario=None, preparar=None, depois_da_escolha=None):
    pagina = PaginaGrade(hosts, aba)
    pagina.filtros = []
    if preparar:
        preparar(pagina)
    escolher = endpoint_lookup._escolher_host

    def escolher_e_interferir(*a, **k):
        escolha = escolher(*a, **k)
        if depois_da_escolha:
            depois_da_escolha(pagina)
        return escolha

    with patch.object(grid, "aplicar_filtro", side_effect=pagina.filtrar), patch.object(grid, "limpar_filtro"), \
            patch.object(endpoint_lookup, "_escolher_host", side_effect=escolher_e_interferir), \
            patch.object(automation, "_pagina_ativa_recuperacao", pagina), patch.object(automation.time, "sleep"):
        resultado = endpoint_lookup._abrir_powershell_na_grade(
            pagina, hostname or endpoint_lookup.HOSTNAME_PADRAO_POWERSHELL, bool(hostname), modo, comando, usuario)
    return resultado, pagina


class HostTests(unittest.TestCase):
    def test_default_online_is_used_and_menu_path_is_followed(self):
        aba = AbaTerminal()
        res, pagina = abrir([("PRNOTEUMU005", "Ao vivo")], aba, comando="Get-Date")
        self.assertEqual(res, {"status": "inserido", "hostname": "PRNOTEUMU005", "modo": "sistema", "usuario": "SYSTEM", "inserido": True, "enter_enviado": False})
        self.assertEqual(pagina.cliques, [
            ("linha", "PRNOTEUMU005"),
            ("hover", 'li.zmenu__item[data-label="Gerente do Sistema"]:visible'),
            ("click", 'li.zmenu__item[data-label="PowerShell"]:visible'),
        ])
        self.assertEqual(aba.preenchidos, ["Get-Date"])
        self.assertFalse(aba.fechada)

    def test_filter_partial_matches_pick_exact_hostname(self):
        res, _ = abrir([("PRNOTEUMU0051", "Ao vivo"), ("prnoteumu005", "Ao vivo")], AbaTerminal())
        self.assertEqual(res["hostname"], "prnoteumu005")

    def test_explicit_host_is_tried_even_with_red_icon(self):
        aba = AbaTerminal()
        res, pagina = abrir([("PRNOTETI027", "Para baixo"), ("PRNOTEB", "Ao vivo")], aba, hostname="PRNOTETI027")
        self.assertEqual((res["status"], res["hostname"]), ("inserido", "PRNOTETI027"))
        self.assertNotIn("hostname_padrao_offline", res)
        self.assertEqual(pagina.filtros, ["PRNOTETI027"])

    def test_explicit_host_failing_reports_error_without_switching(self):
        aba = AbaTerminal(texto=CAIU, apos_reload=CAIU)
        res, pagina = abrir([("PRNOTETI027", "Para baixo"), ("PRNOTEB", "Ao vivo")], aba, hostname="PRNOTETI027")
        self.assertEqual((res["status"], res["hostname"]), ("erro_terminal", "PRNOTETI027"))
        self.assertEqual(pagina.filtros, ["PRNOTETI027"])
        self.assertEqual(aba.preenchidos, [])

    def test_default_offline_falls_back_to_first_online_prnote(self):
        aba = AbaTerminal()
        hosts = [("PRNOTEUMU005", "Para baixo"), ("PRNOTEA", "Para baixo"), ("PRNOTEB", "Ao vivo"), ("PRNOTEC", "Ao vivo")]
        res, pagina = abrir(hosts, aba)
        self.assertEqual((res["status"], res["hostname"], res["hostname_padrao_offline"]), ("inserido", "PRNOTEB", True))
        self.assertEqual(pagina.filtros, ["PRNOTEUMU005", "prnote"])
        self.assertIn(("linha", "PRNOTEB"), pagina.cliques)

    def test_default_offline_without_any_online_or_missing_does_nothing(self):
        aba = AbaTerminal()
        res, pagina = abrir([("PRNOTEUMU005", "Para baixo"), ("PRNOTEA", "Para baixo")], aba)
        self.assertEqual((res["status"], res["hostname_padrao_offline"]), ("sem_host_online", True))
        res, pagina = abrir([("OUTRO", "Ao vivo")], aba, hostname="PRNOTEX")
        self.assertEqual(res, {"status": "not_found", "hostname": "PRNOTEX"})
        self.assertEqual(pagina.cliques, [])
        self.assertEqual(aba.preenchidos, [])


class InterferenciaTests(unittest.TestCase):
    GERENTE_E_POWERSHELL = [("hover", endpoint_lookup._ITEM_GERENTE), ("click", endpoint_lookup._ITEM_POWERSHELL)]

    def test_row_shifted_after_choice_still_opens_the_chosen_computer(self):
        def intruso_no_topo(pagina):
            pagina.linhas.insert(0, LinhaGrade(pagina, "PRNOTEINTRUSO", "Ao vivo"))

        aba = AbaTerminal()
        res, pagina = abrir([("PRNOTEUMU005", "Ao vivo")], aba, depois_da_escolha=intruso_no_topo)
        self.assertEqual((res["status"], res["hostname"]), ("inserido", "PRNOTEUMU005"))
        self.assertEqual(pagina.cliques, [("linha", "PRNOTEUMU005"), *self.GERENTE_E_POWERSHELL])

    def test_late_tab_is_closed_and_path_is_redone_with_fill_and_no_enter(self):
        sobra = AbaTerminal()

        def aba_atrasada(pagina):
            pagina.falhas_expect, pagina.sobra = 1, sobra

        aba = AbaTerminal()
        res, pagina = abrir([("PRNOTEUMU005", "Ao vivo")], aba, preparar=aba_atrasada)
        self.assertEqual((res["status"], res["hostname"], res["enter_enviado"]), ("inserido", "PRNOTEUMU005", False))
        self.assertEqual(pagina.cliques, [("linha", "PRNOTEUMU005"), *self.GERENTE_E_POWERSHELL] * 2)
        self.assertTrue(sobra.fechada)
        self.assertFalse(aba.fechada)
        self.assertEqual((aba.preenchidos, sobra.preenchidos), (["Get-Date"], []))
        self.assertTrue(aba.sem_enter() and sobra.sem_enter())
        self.assertNotIn("Enter", str(pagina.keyboard.chamadas))  # só o Escape da recuperação, na grade


class TerminalTests(unittest.TestCase):
    def test_slow_terminal_reloads_once_then_works(self):
        aba = AbaTerminal(texto="Carregando...", apos_reload=PRONTO)
        res, _ = abrir([("PRNOTEUMU005", "Ao vivo")], aba)
        self.assertEqual((res["status"], aba.reloads), ("inserido", 1))

    def test_disconnected_after_reload_cancels_closes_tab_and_types_nothing(self):
        for texto in (CAIU, ""):
            with self.subTest(texto=texto):
                aba = AbaTerminal(texto=texto, apos_reload=texto)
                res, _ = abrir([("PRNOTEUMU005", "Ao vivo")], aba)
                self.assertEqual((res["status"], aba.reloads, aba.fechada), ("erro_terminal", 1, True))
                self.assertIn("Recarreguei a página uma vez", res["mensagem"])
                self.assertIn("PRNOTEUMU005", res["mensagem"])
                self.assertEqual(aba.preenchidos, [])

    def test_connect_button_label_alone_is_not_ready(self):
        aba = AbaTerminal(texto="Executar como", apos_reload="Executar como")
        res, _ = abrir([("PRNOTEUMU005", "Ao vivo")], aba)
        self.assertEqual((res["status"], aba.fechada, aba.preenchidos), ("erro_terminal", True, []))

    def test_disconnected_wins_over_ready_text(self):
        aba = AbaTerminal(texto="Atualmente conectado como SYSTEM\nO agente foi desconectado", apos_reload="O agente foi desconectado")
        res, _ = abrir([("PRNOTEUMU005", "Ao vivo")], aba)
        self.assertEqual((res["status"], aba.fechada, aba.preenchidos), ("erro_terminal", True, []))

    def test_reload_exception_still_closes_tab_and_types_nothing(self):
        aba = AbaTerminal(texto="Carregando...")
        def estoura(**kw):
            raise TimeoutError("rede caiu")
        aba.reload = estoura
        res, _ = abrir([("PRNOTEUMU005", "Ao vivo")], aba)
        self.assertEqual((res["status"], aba.fechada, aba.preenchidos), ("erro_terminal", True, []))

    def test_unicode_line_breaks_and_bidi_rejected(self):
        for ruim in ("a\u2028b", "a\u2029b", "a\u0085b", "a\u202eb", "a\u200bb", "a\x7fb"):
            with self.assertRaises(ValueError, msg=repr(ruim)):
                endpoint_lookup.validar_comando(ruim)
        self.assertEqual(endpoint_lookup.validar_comando("Get-Date\t| Out-String"), "Get-Date\t| Out-String")

    def test_field_mismatch_cancels(self):
        aba = AbaTerminal(valor_forcado="outro")
        res, _ = abrir([("PRNOTEUMU005", "Ao vivo")], aba)
        self.assertEqual((res["status"], aba.fechada), ("erro_terminal", True))

    def test_never_sends_enter_anywhere(self):
        for modo, usuarios in (("sistema", []), ("usuario", ["GAkihiro"])):
            aba = AbaTerminal(usuarios=usuarios)
            res, pagina = abrir([("PRNOTEUMU005", "Ao vivo")], aba, modo=modo, comando="Get-Process | Select -First 3")
            self.assertEqual((res["status"], res["enter_enviado"]), ("inserido", False))
            self.assertEqual(aba.preenchidos, ["Get-Process | Select -First 3"])
            self.assertTrue(aba.sem_enter())
            self.assertEqual(pagina.keyboard.chamadas, [])


class UserModeTests(unittest.TestCase):
    def run_user(self, usuarios, usuario=None):
        aba = AbaTerminal(usuarios=usuarios)
        res, _ = abrir([("PRNOTEUMU005", "Ao vivo")], aba, modo="usuario", usuario=usuario)
        return res, aba

    def test_single_user_is_used_after_refresh(self):
        res, aba = self.run_user(["GAkihiro"])
        self.assertEqual((res["status"], res["usuario"], res["modo"]), ("inserido", "GAkihiro", "usuario"))
        self.assertIn(("button#runAsUserTargetBind", 0), aba.cliques)
        self.assertIn((".popover-list li#availableUsersHeader button", 0), aba.cliques)
        self.assertEqual(aba.preenchidos, ["Get-Date"])

    def test_chosen_user_matches_case_insensitive(self):
        res, aba = self.run_user(["A", "GAkihiro"], usuario="gakihiro")
        self.assertEqual((res["status"], res["usuario"]), ("inserido", "GAkihiro"))
        self.assertIn((".popover-list li:not([id])", 1), aba.cliques)

    def test_no_user_ambiguous_or_unknown_choice_never_injects(self):
        casos = [([], None, "sem_usuario"), (["A", "B"], None, "usuario_ambiguo"), (["A", "B"], "C", "sem_usuario")]
        for usuarios, usuario, esperado in casos:
            with self.subTest(esperado=esperado, usuario=usuario):
                res, aba = self.run_user(usuarios, usuario)
                self.assertEqual((res["status"], res["usuarios"]), (esperado, usuarios))
                self.assertEqual(aba.preenchidos, [])
                self.assertTrue(aba.fechada)

    def test_user_switch_that_never_connects_reloads_once_and_cancels(self):
        aba = AbaTerminal(usuarios=["GAkihiro"], troca=False)  # o clique não troca o usuário
        res, _ = abrir([("PRNOTEUMU005", "Ao vivo")], aba, modo="usuario")
        self.assertEqual((res["status"], aba.reloads, aba.fechada), ("erro_terminal", 1, True))
        self.assertEqual(aba.preenchidos, [])


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.ps = MagicMock(return_value={"status": "inserido", "hostname": "PRNOTEUMU005", "modo": "sistema", "usuario": "SYSTEM", "inserido": True, "enter_enviado": False})
        app = FastAPI()
        app.include_router(create_endpoint_lookup_router(get_snapshot=MagicMock(), powershell=self.ps))
        self.client = TestClient(app)

    def post(self, **corpo):
        return self.client.post("/api/endpoint/powershell", json={"modo": "sistema", "comando": "Get-Date", **corpo})

    def test_valid_request_passes_clean_arguments(self):
        r = self.post(hostname=" prnoteti027 ", usuario=" ")
        self.assertEqual((r.status_code, r.json()["enter_enviado"]), (200, False))
        self.assertEqual(self.ps.call_args.args, ("PRNOTETI027", "sistema", "Get-Date", None))
        self.post()
        self.assertEqual(self.ps.call_args.args[0], None)

    def test_rejects_empty_multiline_oversized_and_bad_fields(self):
        ruins = [
            {"comando": ""}, {"comando": "   "}, {"comando": "a\nb"}, {"comando": "a\r\nb"}, {"comando": "a\rb"},
            {"comando": "Get-Date\n"}, {"comando": "x" * 2001}, {"modo": "admin"}, {"hostname": "PC 1;rm"},
        ]
        for corpo in ruins:
            with self.subTest(corpo={k: str(v)[:20] for k, v in corpo.items()}):
                self.assertEqual(self.post(**corpo).status_code, 422)
        self.assertEqual(self.client.post("/api/endpoint/powershell", json={"modo": "sistema"}).status_code, 422)
        self.ps.assert_not_called()
        self.assertEqual(self.post(comando="x" * 2000).status_code, 200)

    def test_busy_and_failure_map_to_409_and_503_without_leaking(self):
        for erro, esperado in [(automation.TravaOcupada("busy"), 409), (RuntimeError("segredo"), 503)]:
            self.ps.side_effect = erro
            r = self.post()
            self.assertEqual(r.status_code, esperado)
            self.assertNotIn("segredo", r.text)


class EntradaTests(unittest.TestCase):
    def test_domain_rejects_enter_before_touching_the_browser(self):
        with patch.object(automation, "trava_execucao") as trava:
            for comando in ("", "a\nb", "a\rb", "x" * 2001):
                with self.assertRaises(ValueError):
                    endpoint_lookup.abrir_powershell(None, "sistema", comando)
            with self.assertRaises(ValueError):
                endpoint_lookup.abrir_powershell(None, "root", "Get-Date")
        trava.assert_not_called()

    def test_log_has_size_and_mode_but_never_the_command(self):
        segredo = "Get-Secret -Name SENHA-XYZ"
        aba = AbaTerminal()
        pagina = PaginaGrade([("PRNOTEUMU005", "Ao vivo")], aba)
        pagina.filtros = []
        with tempfile.TemporaryDirectory() as tmp, patch.object(automation, "TRAVA_PATH", Path(tmp) / "lock"), \
                patch("playwright.sync_api.sync_playwright"), patch.object(endpoint_lookup, "_preparar_aba", return_value=pagina), \
                patch.object(grid, "aplicar_filtro", side_effect=pagina.filtrar), patch.object(grid, "limpar_filtro"), \
                patch.object(automation, "log") as log:
            res = endpoint_lookup.abrir_powershell(None, "sistema", segredo)
        self.assertEqual(res["status"], "inserido")
        self.assertEqual(aba.preenchidos, [segredo])
        textos = " ".join(str(c) for c in log.call_args_list)
        self.assertNotIn("SENHA-XYZ", textos)
        self.assertIn(f"tamanho {len(segredo)}", textos)
        self.assertIn("modo sistema", textos)


if __name__ == "__main__":
    unittest.main()
