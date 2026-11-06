import os
import unittest
from types import SimpleNamespace
from unittest import mock

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

    def close(self):
        self.fechada = True

    def goto(self, url, **_kwargs):
        self.url = url

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

    def get_by_role(self, role, *, name, exact):
        assert exact
        if role == "button":
            if self.etapa == 1 and name == "Buscar":
                return ControleFalso(acao=lambda: None)
            if self.etapa == 1 and name == "Próximo":
                return ControleFalso(acao=self.avancar)
            if self.etapa == 2 and name == "Enviar solicitação":
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


class PortalUXChromeTests(unittest.TestCase):
    def setUp(self):
        # Hermetic: the real-send kill switch of the developer's shell must not change these tests.
        sem_trava = mock.patch.dict(os.environ)
        sem_trava.start()
        self.addCleanup(sem_trava.stop)
        os.environ.pop("SIMPRESS_UX_SEM_ENVIO", None)
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

    def test_changed_route_or_duplicate_option_never_writes_the_description(self):
        rota = self.pagina.url
        self.pagina.url = rota[:-1] + "2"
        with self.assertRaises(ErroUX):
            self.preencher()
        self.pagina.url = rota
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

