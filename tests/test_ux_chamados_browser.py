import itertools
import os
import unittest
from types import SimpleNamespace
from unittest import mock

from domains import ux_chamados_browser as ux_browser
from domains.ux_chamados import ErroUX
from domains.ux_chamados_browser import PortalUXChrome, ler_opcoes_rolaveis


class UXListTests(unittest.TestCase):
    def test_reads_virtualized_rows_without_merging_distinct_identical_options(self):
        inicial = ([(1, "Mouse", 5), (2, "Teclado", 5), (3, "Mouse", 5)], 0, 45, 30)
        meio = ([(2, "Teclado", 5), (3, "Mouse", 5), (4, "Monitor", 5)], 30, 45, 60)
        atraso = (meio[0], 45, 45, 75)
        fim = ([(3, "Mouse", 5), (4, "Monitor", 5), (5, "Bateria", 5)], 45, 45, 75)
        paginas = iter([inicial, inicial, meio, meio, atraso, atraso, fim, fim])
        deslocamentos = []
        resultado = ler_opcoes_rolaveis(lambda: next(paginas), deslocamentos.append)
        self.assertEqual(resultado, [("Mouse", 0), ("Teclado", 0), ("Mouse", 0), ("Monitor", 30), ("Bateria", 45)])
        self.assertEqual(deslocamentos, [30, 45])


    def test_refuses_a_stable_list_that_skips_an_announced_position(self):
        inicial = ([(1, "Mouse", 4), (2, "Teclado", 4)], 0, 20, 20)
        fim_incompleto = ([(2, "Teclado", 4), (4, "Bateria", 4)], 20, 20, 40)
        posicoes = [0]
        def ler():
            return fim_incompleto if posicoes[-1] else inicial

        with self.assertRaisesRegex(ErroUX, "lista completa"):
            ler_opcoes_rolaveis(ler, posicoes.append)

    def test_list_that_never_completes_at_the_end_fails_after_a_few_reads(self):
        inicial = ([(1, "Mouse", 4), (2, "Teclado", 4)], 0, 20, 20)
        fim_incompleto = ([(2, "Teclado", 4), (3, "Monitor", 4)], 20, 20, 40)
        posicoes, leituras, esperas = [0], [], []
        def ler():
            leituras.append(posicoes[-1])
            return fim_incompleto if posicoes[-1] else inicial

        with self.assertRaisesRegex(ErroUX, "lista completa"):
            ler_opcoes_rolaveis(ler, posicoes.append, lambda: esperas.append(1))
        self.assertLessEqual(leituras.count(20), 6)
        self.assertLessEqual(len(leituras), 14)
        self.assertLessEqual(len(esperas), 12)

    def test_refuses_custom_options_without_a_declared_total(self):
        sem_total = ([(1, "Teclado", 0)], 0, 0, 0)
        with self.assertRaisesRegex(ErroUX, "lista completa"):
            ler_opcoes_rolaveis(lambda: sem_total, lambda _: None)


def _hermetico(teste):
    """Sem sinal de cancelamento antigo, cursor parado, sem esperas reais; o log fica em ``teste.logs``."""
    teste.logs = []
    for patch in (
        mock.patch.object(ux_browser.automation, "verificar_cancelamento", lambda *_a: None),
        mock.patch.object(ux_browser.automation, "obter_posicao_cursor", lambda: (0, 0)),
        mock.patch.object(ux_browser.automation, "log", lambda _origem, mensagem: teste.logs.append(mensagem)),
        mock.patch.object(ux_browser.automation.time, "sleep"),
    ):
        patch.start()
        teste.addCleanup(patch.stop)


class ControleFalso:
    def __init__(self, *, texto="", acao=None, opcoes=None, quantidade=1):
        self.texto = texto
        self.acao = acao
        self.opcoes = opcoes
        self.quantidade = quantidade
        self.valor = ""

    def filter(self, **_kwargs):
        return self

    def or_(self, outro):
        if not outro.quantidade or outro is self:
            return self
        if not self.quantidade:
            return outro
        return ControleFalso(quantidade=self.quantidade + outro.quantidade)

    def count(self):
        return self.quantidade

    def wait_for(self, **_kwargs):
        if self.quantidade != 1:
            raise ValueError("controle não é único")

    def inner_text(self, **_kwargs):
        return self.texto

    def fill(self, valor, **_kwargs):
        self.valor = valor

    def input_value(self, **_kwargs):
        return self.valor

    def click(self, **_kwargs):
        self.acao()

    def evaluate(self, script):
        if "ng-value" in script:  # leitura do problema escolhido
            return self.valor
        if "tagName" in script:
            return self.opcoes is not None
        return [(indice, texto, bool(texto)) for indice, texto in enumerate(self.opcoes)]

    def select_option(self, *, index, **_kwargs):
        self.valor = self.opcoes[index]


class PaginaFalsa:
    def __init__(self):
        self.url = ""
        self.nome = ""
        self.etapa = 1
        self.serie = ControleFalso()
        self.descricao = ControleFalso()
        self.problema = ControleFalso(opcoes=["", "Notebook - Teclado", "Impressões escuras"])
        self.solicitante = {rotulo: ControleFalso() for rotulo in (
            "Nome", "E-mail", "Telefone para contato", "Ramal", "Departamento/Cargo",
        )}
        self.anexos = ["fixture.png"]
        self.dias = [True, False, True, True, False]
        self.enviados = 0
        self.fechada = False
        self.rotulo_enviar = "Enviar solicitação"
        self.gotos = []

    def close(self):
        self.fechada = True

    def goto(self, url, **_kwargs):
        # Navegar recarrega o formulário: volta à etapa 1 com os campos vazios.
        self.gotos.append(url)
        self.url = url
        self.etapa = 1
        for controle in (self.descricao, self.problema, *self.solicitante.values()):
            controle.valor = ""

    def bring_to_front(self):
        pass

    def get_by_label(self, nome, *, exact):
        assert exact
        if self.etapa == 1:
            return self.serie if nome == "Número de série" else ControleFalso(quantidade=0)
        return {
            "Selecione o problema": self.problema,
            "Descreva o problema": self.descricao,
            **self.solicitante,
        }.get(nome, ControleFalso(quantidade=0))

    def get_by_placeholder(self, nome, *, exact):
        return ControleFalso(quantidade=0)

    def get_by_text(self, valor, *, exact=False):
        textos = {
            1: ["Etapa 1 de 2"],
            2: ["Etapa 2 de 2", f"Número de série/Modelo: {self.serie.valor} / Modelo de teste", "Solicitante"],
            3: ["#24680"],
        }[self.etapa]
        for texto in textos:
            if valor == texto or (not isinstance(valor, str) and valor.fullmatch(texto)):
                return ControleFalso(texto=texto)
        return ControleFalso(quantidade=0)

    def locator(self, _seletor):
        return ControleFalso(quantidade=0)

    def wait_for_timeout(self, _ms):
        pass

    @staticmethod
    def _nome_confere(name, alvo):
        return name.fullmatch(alvo) is not None if hasattr(name, "fullmatch") else name == alvo

    def get_by_role(self, role, *, name, exact=False):
        if role == "button":
            if self.etapa == 1 and name == "Buscar":
                return ControleFalso(acao=lambda: None)
            if self.etapa == 1 and name == "Próximo":
                return ControleFalso(acao=self.avancar)
            if self.etapa == 2 and self._nome_confere(name, self.rotulo_enviar):
                return ControleFalso(acao=self.enviar)
        return ControleFalso(quantidade=0)

    def evaluate(self, script, nome=None):
        if nome is not None:
            self.nome = nome
        return self.nome

    def avancar(self):
        self.etapa = 2

    def enviar(self):
        self.enviados += 1
        self.etapa = 3
        self.url = "https://ux.simpress.com.br/ng/solicitar-atendimento/confirmacao"


class ListaNg(ControleFalso):
    """The ng-select panel: every option is rendered, none carries aria-posinset/aria-setsize."""

    def __init__(self, pagina, textos):
        super().__init__()
        self.pagina = pagina
        self.textos = textos
        self.aberta = False

    def count(self):
        return 1 if self.aberta else 0

    def wait_for(self, *, state="visible", **_kwargs):
        if (state == "hidden") == self.aberta:
            raise ValueError("estado da lista")

    def get_by_role(self, role, *, name=None, exact=False):
        assert role == "option"
        return OpcaoNg(self, name)

    def evaluate(self, script, *_args):
        if "aria-setsize" in script:
            return False
        if "innerText" in script:
            return [list(self.textos), 1]
        return None


class OpcaoNg(ControleFalso):
    def __init__(self, lista, nome):
        super().__init__(quantidade=1 if nome is None or nome in lista.textos else 0)
        self.lista = lista
        self.nome = nome
        self.first = self

    def click(self, **_kwargs):
        self.lista.pagina.problema_escolhido = self.nome
        self.lista.aberta = False


class SeletorNg(ControleFalso):
    def __init__(self, pagina):
        super().__init__()
        self.pagina = pagina

    def click(self, **_kwargs):
        if self.pagina.backup_aberto:
            raise RuntimeError("o modal Backup de dados intercepta o clique")
        self.pagina.lista.aberta = True

    def evaluate(self, script):
        if "ng-value" in script:  # leitura do problema escolhido
            return self.pagina.problema_escolhido or ""
        return False  # NG-SELECT is not a native <select>


class AvisoBackup(ControleFalso):
    def __init__(self, pagina):
        super().__init__()
        self.pagina = pagina

    def count(self):
        return 1 if self.pagina.backup_aberto else 0

    def click(self, **_kwargs):
        self.pagina.backup_aberto = False

    def wait_for(self, *, state="visible", **_kwargs):
        if (state == "hidden") == self.pagina.backup_aberto:
            raise ValueError("estado do modal")


class PaginaPortalReal(PaginaFalsa):
    """The real portal: no "Etapa 1 de 2", inputs known only by id, ng-select, a blocking backup modal."""

    IDS = {"nome": "Nome", "email": "E-mail", "telefone": "Telefone para contato", "ramal": "Ramal", "cargo": "Departamento/Cargo"}

    def __init__(self):
        super().__init__()
        self.rotulo_enviar = "Enviar Solicitação"
        self.backup_aberto = False
        self.problema_escolhido = None
        self.lista = ListaNg(self, ["Impressões escuras", "Notebook - Mouse", "Notebook - Teclado", "Hardware - Placa"])
        self.ng = SeletorNg(self)
        self.keyboard = SimpleNamespace(press=lambda _tecla: setattr(self.lista, "aberta", False))

    def avancar(self):
        super().avancar()
        self.backup_aberto = True

    def goto(self, url, **kwargs):
        super().goto(url, **kwargs)
        self.problema_escolhido = None
        self.lista.aberta = False
        self.backup_aberto = False

    def get_by_label(self, nome, *, exact):
        return ControleFalso(quantidade=0)  # aria-label is the id ("nome"), never the visible label

    def get_by_text(self, valor, *, exact=False):
        if self.etapa == 1:
            return ControleFalso(quantidade=0)
        return super().get_by_text(valor, exact=exact)

    def get_by_role(self, role, *, name=None, exact=False):
        if role == "listbox":
            return self.lista
        return super().get_by_role(role, name=name, exact=exact)

    def locator(self, seletor):
        if seletor == "input#numeroSerie" and self.etapa == 1:
            return self.serie
        if self.etapa != 2:
            return ControleFalso(quantidade=0)
        if seletor == "ng-select":
            return self.ng
        if seletor == "textarea":
            return self.descricao
        if seletor == "app-modal[titulo='Backup de dados'] .fechar":
            return AvisoBackup(self)
        for id_, rotulo in self.IDS.items():
            if seletor == f"input#{id_}":
                return self.solicitante[rotulo]
        return ControleFalso(quantidade=0)


class PortalRealTests(unittest.TestCase):
    """Regression: the adapter assumed a form the real UX portal does not have (live check, 2026-11-06)."""

    def setUp(self):
        sem_trava = mock.patch.dict(os.environ)
        sem_trava.start()
        self.addCleanup(sem_trava.stop)
        os.environ.pop("SIMPRESS_UX_SEM_ENVIO", None)
        _hermetico(self)
        self.pagina = PaginaPortalReal()
        self.portal = PortalUXChrome(SimpleNamespace(pages=[self.pagina], new_page=lambda: self.pagina))
        self.perfil = {"nome": "Pessoa Fictícia", "email": "teste@example.test", "telefone": "41999990000",
                       "ramal": "", "departamento_cargo": "Teste"}

    def preparar(self):
        return self.portal.preparar("S1", "aba-opaca")

    def test_prepare_closes_the_backup_modal_and_reads_the_ng_select_list(self):
        modelo, opcoes = self.preparar()
        self.assertEqual(modelo, "Modelo de teste")
        self.assertEqual(opcoes, ["Impressões escuras", "Notebook - Mouse", "Notebook - Teclado", "Hardware - Placa"])
        self.assertFalse(self.pagina.backup_aberto)
        self.assertFalse(self.pagina.lista.aberta)

    def test_fill_uses_ids_textarea_and_ng_select_and_sends_with_the_real_button_label(self):
        modelo, _ = self.preparar()
        self.portal.preencher("S1", modelo, "aba-opaca", "Notebook - Teclado", "Teclado com defeito.", self.perfil)
        self.assertEqual(self.pagina.problema_escolhido, "Notebook - Teclado")
        self.assertEqual(self.pagina.descricao.valor, "Teclado com defeito.")
        self.assertEqual(self.pagina.solicitante["Nome"].valor, "Pessoa Fictícia")
        self.assertEqual(self.pagina.solicitante["Telefone para contato"].valor, "41999990000")
        self.assertEqual(self.pagina.enviados, 0)
        self.assertEqual(self.portal.enviar("aba-opaca"), "24680")
        self.assertEqual(self.pagina.enviados, 1)

    def test_kill_switch_still_blocks_the_click_on_the_real_label(self):
        modelo, _ = self.preparar()
        self.portal.preencher("S1", modelo, "aba-opaca", "Notebook - Teclado", "Teclado com defeito.", self.perfil)
        with mock.patch.dict(os.environ, {"SIMPRESS_UX_SEM_ENVIO": "1"}), self.assertRaises(ErroUX):
            self.portal.enviar("aba-opaca")
        self.assertEqual(self.pagina.enviados, 0)

    def test_list_that_keeps_changing_is_refused_instead_of_trusted(self):
        # A lista nunca estabiliza, nem depois de voltar ao mesmo link nas novas tentativas.
        leituras = itertools.cycle([[["A"], 1], [["A", "B"], 1], [["A", "B", "C"], 1]])
        self.pagina.lista.evaluate = lambda script, *_a: False if "aria-setsize" in script else next(leituras)
        with self.assertRaisesRegex(ErroUX, "lista completa"):
            self.preparar()

    def test_ng_select_choice_changed_after_filling_is_chosen_again_before_the_send(self):
        modelo, _ = self.preparar()
        self.portal.preencher("S1", modelo, "aba-opaca", "Notebook - Teclado", "Teclado com defeito.", self.perfil)
        self.pagina.problema_escolhido = "Notebook - Mouse"  # clique acidental na lista do Chrome
        self.portal.validar("S1", modelo, "aba-opaca")
        self.assertEqual(self.pagina.problema_escolhido, "Notebook - Teclado")
        self.assertEqual(self.pagina.enviados, 0)
        self.assertEqual(self.portal.enviar("aba-opaca"), "24680")
        self.assertEqual(self.pagina.enviados, 1)


class ConexaoChromeTests(unittest.TestCase):
    def test_starts_the_automation_chrome_before_connecting(self):
        ordem = []
        browser = SimpleNamespace(contexts=["ctx"])
        pw = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=lambda *a, **k: ordem.append("conectar") or browser))
        playwright = mock.MagicMock()
        playwright.__enter__.return_value = pw
        with mock.patch.object(ux_browser.automation, "garantir_chrome", lambda: ordem.append("garantir")), \
                mock.patch.object(ux_browser.automation, "_inicio_execucao", 0.0), \
                mock.patch("playwright.sync_api.sync_playwright", return_value=playwright), \
                ux_browser.contexto_chrome_ux() as contexto:
            self.assertEqual(contexto, "ctx")
            # Um pedido de cancelamento deixado por outra rotina não pode interromper o chamado.
            self.assertGreater(ux_browser.automation._inicio_execucao, 0.0)
        self.assertEqual(ordem, ["garantir", "conectar"])

    def test_chrome_that_cannot_start_or_connect_explains_it_without_leaking_the_cause(self):
        def recusa(*_a, **_k):
            raise ConnectionRefusedError("connect ECONNREFUSED 127.0.0.1:9333")

        playwright = mock.MagicMock()
        playwright.__enter__.return_value = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=recusa))
        with mock.patch.object(ux_browser.automation, "garantir_chrome", lambda: None), \
                mock.patch("playwright.sync_api.sync_playwright", return_value=playwright):
            with self.assertRaises(ErroUX) as erro, ux_browser.contexto_chrome_ux():
                pass
        self.assertEqual((erro.exception.status, erro.exception.codigo), (503, "chrome_indisponivel"))
        self.assertNotIn("ECONNREFUSED", str(erro.exception))
        with mock.patch.object(ux_browser.automation, "garantir_chrome", side_effect=RuntimeError("perfil bloqueado")):
            with self.assertRaises(ErroUX) as erro, ux_browser.contexto_chrome_ux():
                pass
        self.assertEqual(erro.exception.codigo, "chrome_indisponivel")


class PortalUXChromeTests(unittest.TestCase):
    def setUp(self):
        # Hermetic: the real-send kill switch of the developer's shell must not change these tests.
        sem_trava = mock.patch.dict(os.environ)
        sem_trava.start()
        self.addCleanup(sem_trava.stop)
        os.environ.pop("SIMPRESS_UX_SEM_ENVIO", None)
        _hermetico(self)
        self.pagina = PaginaFalsa()
        self.portal = PortalUXChrome(SimpleNamespace(pages=[self.pagina], new_page=lambda: self.pagina))
        self.modelo, self.opcoes = self.portal.preparar("S1", "aba-opaca")
        self.perfil = {"nome": "Pessoa Fictícia", "email": "teste@example.test", "telefone": "41999990000",
                       "ramal": "", "departamento_cargo": "Teste"}

    def preencher(self):
        self.portal.preencher("S1", self.modelo, "aba-opaca", "Notebook - Teclado", "Teclado com defeito.", self.perfil)

    def test_fills_only_the_ticket_fields_and_reads_one_receipt_after_an_explicit_click(self):
        self.assertEqual(self.opcoes, ["Notebook - Teclado", "Impressões escuras"])
        self.preencher()
        self.assertEqual(self.pagina.descricao.valor, "Teclado com defeito.")
        self.assertEqual(self.pagina.problema.valor, "Notebook - Teclado")
        self.assertEqual(self.pagina.anexos, ["fixture.png"])
        self.assertEqual(self.pagina.dias, [True, False, True, True, False])
        self.assertEqual(self.pagina.enviados, 0)
        self.assertEqual(self.portal.enviar("aba-opaca"), "24680")
        self.assertEqual(self.pagina.enviados, 1)
        with self.assertRaises(ErroUX):
            self.portal.enviar("aba-opaca")
        self.assertEqual(self.pagina.enviados, 1)

    def test_fechar_closes_only_the_session_tab_even_after_the_receipt_route(self):
        with self.assertRaises(ErroUX):
            self.portal.fechar("outra-aba")
        self.assertFalse(self.pagina.fechada)
        self.preencher()
        self.portal.enviar("aba-opaca")  # the page moved to the receipt route
        self.portal.fechar("aba-opaca")
        self.assertTrue(self.pagina.fechada)
        self.assertEqual(self.pagina.enviados, 1)

    def test_kill_switch_stops_the_adapter_before_the_click(self):
        self.preencher()
        with mock.patch.dict(os.environ, {"SIMPRESS_UX_SEM_ENVIO": "1"}), self.assertRaises(ErroUX):
            self.portal.enviar("aba-opaca")
        self.assertEqual(self.pagina.enviados, 0)

    def test_duplicate_option_never_writes_the_description(self):
        self.pagina.problema.opcoes.append("Notebook - Teclado")
        with self.assertRaises(ErroUX):
            self.preencher()
        self.assertEqual(self.pagina.descricao.valor, "")
        self.assertEqual(self.pagina.enviados, 0)

    def test_ambiguous_contact_field_stops_before_filling(self):
        self.pagina.solicitante["Nome"].quantidade = 2
        with self.assertRaises(ValueError):
            self.preencher()
        self.assertEqual(self.pagina.descricao.valor, "")
        self.assertEqual(self.pagina.enviados, 0)

    def test_tab_moved_to_another_ux_link_returns_to_the_same_link_and_fills_again(self):
        self.pagina.url = "https://ux.simpress.com.br/ng/home"  # clique acidental em outro link do UX
        self.portal.validar("S1", self.modelo, "aba-opaca")
        self.preencher()
        self.assertEqual(self.pagina.gotos, [ux_browser.ORIGEM_UX + ux_browser.ROTA_INICIAL] * 2)
        self.assertEqual(self.pagina.problema.valor, "Notebook - Teclado")
        self.assertEqual(self.pagina.descricao.valor, "Teclado com defeito.")
        self.assertEqual(self.portal.enviar("aba-opaca"), "24680")
        self.assertEqual(self.pagina.enviados, 1)

    def test_route_changed_while_filling_returns_to_the_same_link(self):
        rota = self.pagina.url
        self.pagina.url = rota[:-1] + "2"  # a aba saiu da rota gravada no window.name
        self.preencher()
        self.assertEqual(len(self.pagina.gotos), 2)
        self.assertEqual(self.pagina.descricao.valor, "Teclado com defeito.")
        self.assertEqual(self.pagina.enviados, 0)

    def test_problem_changed_by_a_stray_click_is_read_back_and_chosen_again(self):
        escolher = self.pagina.problema.select_option

        def clique_acidental(*, index, **kwargs):
            escolher(index=index, **kwargs)
            if len(self.pagina.gotos) == 1:
                self.pagina.problema.valor = "Impressões escuras"  # o clique acidental troca a escolha

        self.pagina.problema.select_option = clique_acidental
        self.preencher()
        self.assertEqual(self.pagina.problema.valor, "Notebook - Teclado")
        self.assertEqual(len(self.pagina.gotos), 2)  # voltou ao mesmo link e refez

    def test_change_after_filling_is_filled_again_before_the_send(self):
        self.preencher()
        self.pagina.problema.valor = "Impressões escuras"
        self.pagina.descricao.valor = "texto trocado"
        self.portal.validar("S1", self.modelo, "aba-opaca")
        self.assertEqual(self.pagina.problema.valor, "Notebook - Teclado")
        self.assertEqual(self.pagina.descricao.valor, "Teclado com defeito.")
        self.assertEqual(self.pagina.enviados, 0)
        self.assertEqual(self.portal.enviar("aba-opaca"), "24680")
        self.assertEqual(self.pagina.enviados, 1)

    def test_form_changed_during_the_guard_never_clicks_send(self):
        for mudar in (
            lambda: setattr(self.pagina.descricao, "valor", "texto trocado"),
            lambda: setattr(self.pagina.problema, "valor", "Impressões escuras"),
            lambda: setattr(self.pagina.solicitante["Nome"], "valor", "Outra pessoa"),
            lambda: setattr(self.pagina, "url", "https://ux.simpress.com.br/ng/home"),
        ):
            with self.subTest():
                self.preencher()

                def cursor_parado():
                    mudar()  # a mudança acontece com a guarda já em andamento
                    return (0, 0)

                with mock.patch.object(ux_browser.automation, "obter_posicao_cursor", cursor_parado), \
                        self.assertRaises(ux_browser.automation.RotinaErro):
                    self.portal.enviar("aba-opaca")
                self.assertEqual(self.pagina.enviados, 0)
                self.pagina.url = ux_browser.ORIGEM_UX + ux_browser.ROTA_INICIAL

    def test_send_waits_for_the_cursor_to_stop_and_clicks_once(self):
        self.preencher()
        posicoes = iter([(0, 0), (50, 50), (50, 50), (50, 50)])  # o mouse se move e depois para
        with mock.patch.object(ux_browser.automation, "obter_posicao_cursor", lambda: next(posicoes)):
            self.assertEqual(self.portal.enviar("aba-opaca"), "24680")
        self.assertIsNone(next(posicoes, None))
        self.assertEqual(self.pagina.enviados, 1)

    def test_tab_that_already_shows_an_os_is_never_filled_again(self):
        self.preencher()
        self.pagina.enviar()  # clique acidental em "Enviar" direto no Chrome
        with self.assertRaises(ErroUX):
            self.portal.validar("S1", self.modelo, "aba-opaca")
        self.assertEqual(len(self.pagina.gotos), 1)
        self.assertEqual(self.pagina.enviados, 1)

    def test_tab_on_another_atendimento_screen_is_never_filled_again(self):
        self.preencher()
        # Logo após um Enviar acidental a rota já saiu do formulário, mas o número da OS ainda não apareceu.
        self.pagina.url = "https://ux.simpress.com.br/ng/solicitar-atendimento/sucesso"
        with self.assertRaises(ErroUX):
            self.portal.validar("S1", self.modelo, "aba-opaca")
        self.assertEqual(len(self.pagina.gotos), 1)
        self.assertEqual(self.pagina.enviados, 0)

    def test_cancel_request_during_the_guard_never_clicks_and_is_a_plain_failure(self):
        self.preencher()

        def cancelar(*_a):
            raise ux_browser.automation.RotinaCancelada()

        with mock.patch.object(ux_browser.automation, "verificar_cancelamento", cancelar), \
                self.assertRaises(ux_browser.automation.RotinaErro):
            self.portal.enviar("aba-opaca")
        self.assertEqual(self.pagina.enviados, 0)

    def test_cancel_request_between_retries_is_a_plain_failure(self):
        self.pagina.url = "https://ux.simpress.com.br/ng/home"
        self.pagina.problema.opcoes.append("Notebook - Teclado")  # 409 que seria repetido

        def cancelar(*_a):
            raise ux_browser.automation.RotinaCancelada()

        with mock.patch.object(ux_browser.automation, "verificar_cancelamento", cancelar), \
                self.assertRaises(ux_browser.automation.RotinaErro):
            self.preencher()
        self.assertEqual(self.pagina.enviados, 0)

    def test_retry_logs_only_the_failure_class_without_form_data(self):
        preencher = self.pagina.descricao.fill

        def falha_uma_vez(valor, **kwargs):
            if len(self.pagina.gotos) == 1:
                raise RuntimeError(f"fill({valor!r}) interceptado; Pessoa Fictícia")
            preencher(valor, **kwargs)

        self.pagina.descricao.fill = falha_uma_vez
        self.preencher()
        self.assertEqual(self.pagina.descricao.valor, "Teclado com defeito.")
        self.assertTrue(self.logs)
        self.assertFalse([m for m in self.logs if "Teclado com defeito" in m or "Pessoa Fictícia" in m])

    def test_two_stray_clicks_while_opening_the_form_still_return_to_it(self):
        pagina = PaginaFalsa()
        ir = pagina.goto

        def clique_acidental(url, **kwargs):
            ir(url, **kwargs)
            if len(pagina.gotos) <= 2:
                pagina.url = "https://ux.simpress.com.br/ng/home"

        pagina.goto = clique_acidental
        portal = PortalUXChrome(SimpleNamespace(pages=[pagina], new_page=lambda: pagina))
        with mock.patch.object(ux_browser.automation, "ux_logado", lambda _page: True), \
                mock.patch.object(ux_browser, "ESPERA_LOGIN_S", 1):
            modelo, _ = portal.preparar("S1", "aba-opaca")
        self.assertEqual(modelo, "Modelo de teste")
        self.assertEqual(len(pagina.gotos), 3)
