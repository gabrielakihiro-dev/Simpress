import os
import unittest
from unittest import mock

from domains import ux_chamados, ux_ticket_browser as browser
from domains.ux_ticket import INCIDENTE, MOTIVO, Formulario

ORIGEM = "https://ux.simpress.com.br"
CABECALHO = (
    "Gerar ticket\nNÚMERO DE SÉRIE\nABC123\nNOME DO CONTRATO\n"
    "16467 - SERV DE APOIO AS MICRO E PEQ EMP DO PARANA SEBRAE PR\nMODELO\nHP 250R G9\n"
)
CEP = "85504-000"
ENDERECO = "AV TUPI, 333 - BORTOT, Pato Branco - PR, 85504000"


def formulario(**alteracoes):
    return Formulario(**{
        "endereco": ENDERECO, "cnpj_instalacao": "75.110.585/0005-25", "cnpj_faturamento": "75.110.585/0001-00",
        "descricao": "Atualizar o endereço.", "nome": "Pessoa Fictícia", "email": "teste@example.test",
        "telefone": "(41) 99999-0000", "chamado_interno": "", "arquivo_nome": "planilha.xlsx", "arquivo": b"xlsx",
        **alteracoes,
    })


class Controle:
    """Minimal Playwright locator: count, text, value, clicks; `filter`/`first`/`nth` return itself."""

    def __init__(self, quantidade=1, *, texto="", valor="", ao_clicar=None):
        self.quantidade, self.texto, self.valor, self.ao_clicar = quantidade, texto, valor, ao_clicar
        self.cliques = 0
        self.arquivos = []

    def filter(self, **_kwargs):
        return self

    @property
    def first(self):
        return self

    def nth(self, _indice):
        return self

    def count(self):
        return self.quantidade

    def wait_for(self, *, state="visible", **_kwargs):
        if state == "visible" and not self.count():
            raise TimeoutError("não apareceu")

    def inner_text(self, **_kwargs):
        return self.texto

    def fill(self, valor, **_kwargs):
        self.valor = valor

    def input_value(self, **_kwargs):
        return self.valor

    def click(self, **_kwargs):
        self.cliques += 1
        if self.ao_clicar:
            self.ao_clicar()

    def set_input_files(self, arquivo, **_kwargs):
        self.arquivos.append(arquivo)


class Lista(Controle):
    """ng-select dropdown without aria-setsize: opened by clicking the input, closed by picking an option."""

    def __init__(self, opcoes):
        super().__init__(0)
        self.opcoes = list(opcoes)
        self.escolhida = None

    def get_by_role(self, _papel, name=None, exact=False):
        def escolher():
            self.escolhida, self.quantidade = name, 0
        return Controle(int(name is None or name in self.opcoes), ao_clicar=escolher)

    def evaluate(self, script):
        return False if "aria-setsize" in script else [list(self.opcoes), 1]

    def locator(self, seletor):
        # "No items found" is a .ng-option without a usable role=option
        return Controle(len(self.opcoes) if "aria-disabled" in seletor else max(1, len(self.opcoes)))


class Teclado:
    def __init__(self):
        self.teclas = []

    def press(self, tecla):
        self.teclas.append(tecla)


class Pagina:
    def __init__(self, *, url=ORIGEM + browser.ROTA_ABRIR, nome="sessao:abrir-ticket", texto=CABECALHO):
        self.url, self.nome = url, nome
        self.keyboard = Teclado()
        self.controles = {"body": Controle(texto=texto), "input#InputNumeroChamado": Controle()}
        self.botoes = {}
        self.textos = {}
        self.lista = Lista([])
        self.idas = []
        self.fechada = False
        self.aberta_por = None
        self.ouvintes = {}

    def is_closed(self):
        return self.fechada

    def on(self, evento, funcao):
        self.ouvintes.setdefault(evento, []).append(funcao)

    def opener(self):
        return self.aberta_por

    def bring_to_front(self):
        pass

    def evaluate(self, script, *args):
        if args:
            self.nome = args[0]
        return self.nome

    def locator(self, seletor, **_kwargs):
        return self.controles.setdefault(seletor, Controle())

    def get_by_role(self, papel, name=None, exact=False):
        if papel == "listbox":
            return self.lista
        return self.botoes.setdefault(name, Controle())

    def get_by_text(self, valor, **_kwargs):
        return self.textos.setdefault(valor, Controle(0))

    def goto(self, url, **_kwargs):
        self.idas.append(url)
        self.url = url

    def wait_for_timeout(self, _ms):
        pass

    def close(self):
        self.fechada = True


class Contexto:
    def __init__(self, *paginas):
        self.pages = list(paginas)

    def new_page(self):
        pagina = Pagina(url="about:blank", nome="")
        self.pages.append(pagina)
        return pagina


def ng_select(pagina, campo, opcoes):
    """Wire input#campo so a click opens a list with `opcoes` and the pick shows in .ng-value-label."""
    lista = Lista(opcoes)
    rotulo = Controle(texto="")
    pagina.lista = lista

    def abrir():
        lista.quantidade = 1

    original = lista.get_by_role

    def opcao(papel, name=None, exact=False):
        controle = original(papel, name=name, exact=exact)
        if name is not None:
            antes = controle.ao_clicar
            controle.ao_clicar = lambda: (antes(), setattr(rotulo, "texto", name))
        return controle

    lista.get_by_role = opcao
    pagina.controles[f"input#{campo}"] = Controle(ao_clicar=abrir)
    pagina.controles[f"ng-select:has(input#{campo}) .ng-value-label"] = rotulo
    return lista, rotulo


class EquipamentoTests(unittest.TestCase):
    def test_header_gives_the_single_model_of_the_contract_and_series(self):
        self.assertEqual(browser.PortalTicketUXChrome._equipamento(Pagina(), "ABC123"), "HP 250R G9")
        self.assertEqual(browser.PortalTicketUXChrome._equipamento(
            Pagina(texto="ABC123\nNOME DO CONTRATO: 16467 - SEBRAE\nMODELO: HP 250R G9"), "ABC123"), "HP 250R G9")

    def test_header_refuses_other_series_contract_or_two_models(self):
        for texto in (
            CABECALHO.replace("ABC123", "ABC1234"),
            CABECALHO.replace("16467 -", "164670 -"),
            CABECALHO + "MODELO\nOutro\n",
        ):
            with self.subTest(texto=texto[-30:]), self.assertRaises(ux_chamados.ErroUX):
                browser.PortalTicketUXChrome._equipamento(Pagina(texto=texto), "ABC123")


class EscolherTests(unittest.TestCase):
    def test_picks_the_single_exact_option_and_checks_the_shown_label(self):
        pagina = Pagina()
        lista, rotulo = ng_select(pagina, "novo-endereco", ["AV TUPI, 3330 - BORTOT", "AV TUPI, 333 - BORTOT"])
        self.assertEqual(browser._escolher(pagina, "novo-endereco", "AV TUPI, 333 - BORTOT"), "AV TUPI, 333 - BORTOT")
        self.assertEqual((lista.escolhida, rotulo.texto), ("AV TUPI, 333 - BORTOT", "AV TUPI, 333 - BORTOT"))

    def test_contract_is_picked_by_prefix_only_when_unique(self):
        pagina = Pagina()
        ng_select(pagina, "selectContrato", ["164670 - OUTRO", "16467 - SERV DE APOIO SEBRAE PR"])
        self.assertEqual(browser._escolher(pagina, "selectContrato", None, busca="16467"), "16467 - SERV DE APOIO SEBRAE PR")
        self.assertEqual(pagina.controles["input#selectContrato"].valor, "16467")

    def test_identical_repeated_labels_are_one_choice(self):
        # The UX lists Irati twice with the same label: picking it must not stop the flow.
        pagina = Pagina()
        lista, rotulo = ng_select(pagina, "novo-endereco", [ENDERECO, ENDERECO])
        self.assertEqual(browser._escolher(pagina, "novo-endereco", ENDERECO), ENDERECO)
        self.assertEqual((lista.escolhida, rotulo.texto), (ENDERECO, ENDERECO))

    def test_zero_or_different_matches_close_the_list_and_refuse(self):
        casos = ((["Outro"], "selectMotivo", "Alvo"), (["16467 - A", "16467 - B"], "selectContrato", None))
        for opcoes, campo, alvo in casos:
            pagina = Pagina()
            lista, _ = ng_select(pagina, campo, opcoes)
            with self.subTest(opcoes=opcoes), self.assertRaises(ux_chamados.ErroUX) as erro:
                browser._escolher(pagina, campo, alvo)
            self.assertEqual(erro.exception.status, 409)
            self.assertEqual(pagina.keyboard.teclas, ["Escape"])
            self.assertIsNone(lista.escolhida)

    def test_an_already_open_list_blocks_the_choice(self):
        pagina = Pagina()
        ng_select(pagina, "selectMotivo", ["Alvo"])[0].quantidade = 1
        with self.assertRaises(ux_chamados.ErroUX):
            browser._escolher(pagina, "selectMotivo", "Alvo")
        self.assertEqual(pagina.controles["input#selectMotivo"].cliques, 0)


class AnexoTests(unittest.TestCase):
    def test_attaches_through_the_single_file_input_and_waits_for_the_name(self):
        pagina = Pagina()
        entrada = pagina.locator('input[type="file"]')
        listado = pagina.get_by_text("planilha.xlsx")
        entrada.set_input_files = lambda arquivo, **_k: (entrada.arquivos.append(arquivo), setattr(listado, "quantidade", 1))
        browser.PortalTicketUXChrome._anexar(pagina, "planilha.xlsx", b"xlsx")
        self.assertEqual(entrada.arquivos, [{"name": "planilha.xlsx", "mimeType": browser.MIME_XLSX, "buffer": b"xlsx"}])
        self.assertEqual(pagina.botoes, {})  # never clicks "Anexar documento"
        browser.PortalTicketUXChrome._anexar(pagina, "planilha.xlsx", b"xlsx")  # already listed: no second upload
        self.assertEqual(len(entrada.arquivos), 1)

    def test_refuses_big_files_missing_confirmation_and_duplicates(self):
        pagina = Pagina()
        with self.assertRaises(ux_chamados.ErroUX) as erro:
            browser.PortalTicketUXChrome._anexar(pagina, "p.xlsx", b"x" * (browser.ANEXO_MAX + 1))
        self.assertEqual(erro.exception.status, 422)
        with self.assertRaises(ux_chamados.ErroUX):
            browser.PortalTicketUXChrome._anexar(pagina, "p.xlsx", b"x")  # the name never appears
        pagina.get_by_text("p.xlsx").quantidade = 2
        with self.assertRaises(ux_chamados.ErroUX):
            browser.PortalTicketUXChrome._anexar(pagina, "p.xlsx", b"x")


class PreencherTests(unittest.TestCase):
    def test_a_value_the_portal_did_not_keep_is_refused(self):
        campo = Controle()
        campo.fill = lambda valor, **_k: setattr(campo, "valor", valor[:-1])
        with self.assertRaises(ux_chamados.ErroUX):
            browser._preencher(campo, "75.110.585/0001-00")
        telefone = Controle()
        browser._preencher(telefone, "(41) 98751-2389", nome="telefone", digitado="41987512389")
        self.assertEqual(telefone.valor, "41987512389")


class EnviarTests(unittest.TestCase):
    def setUp(self):
        ambiente = mock.patch.dict(os.environ)
        ambiente.start()
        self.addCleanup(ambiente.stop)
        os.environ.pop(ux_chamados.VAR_SEM_ENVIO, None)
        self.pagina = Pagina()
        self.pagina.controles["input#InputNumeroChamado"].valor = "4321"
        self.finalizar = self.pagina.get_by_role("button", name="Finalizar")
        self.portal = browser.PortalTicketUXChrome(Contexto(self.pagina))
        self.portal._pronto = ("ABC123", "HP 250R G9", "sessao", CEP, formulario(chamado_interno="4321"))
        self.portal._conferir_tudo = mock.Mock()
        self.antes = mock.Mock(side_effect=lambda: self.assertEqual(self.finalizar.cliques, 0))

    def dialogo(self, texto):
        self.finalizar.ao_clicar = lambda: self.pagina.controles.__setitem__(
            "[role=dialog], .modal, app-modal", Controle(texto=texto),
        )

    def test_reads_the_single_ticket_number_ignoring_contract_and_internal_number(self):
        self.pagina.controles["[role=dialog], .modal, app-modal"] = Controle(0)
        self.dialogo("Ticket 987654 aberto para o contrato 16467. Chamado interno 4321.")
        self.assertEqual(self.portal.enviar("sessao", self.antes), "987654")
        self.assertEqual(self.finalizar.cliques, 1)
        self.antes.assert_called_once_with()  # the service records "incerto" before the click
        self.portal._conferir_tudo.assert_called_once()  # final re-read right before Finalizar

    def test_no_number_is_a_timeout_after_a_single_click_without_any_retry(self):
        self.pagina.controles["[role=dialog], .modal, app-modal"] = Controle(0)
        self.dialogo("Ticket criado com sucesso.")
        with mock.patch.object(browser, "ESPERA_OS_S", 0.05), self.assertRaises(TimeoutError):
            self.portal.enviar("sessao", self.antes)
        self.assertEqual(self.finalizar.cliques, 1)
        self.assertEqual(self.pagina.idas, [])  # no reload, no return to the consulta
        self.portal._conferir_tudo.assert_called_once()

    def test_contingency_e_a_failure_after_finalizar_is_never_retried(self):
        def desviar():
            self.pagina.url = ORIGEM + "/ng/home"  # e.g. the portal redirected after the click
            raise RuntimeError("falha depois do clique")
        self.finalizar.ao_clicar = desviar
        with self.assertRaises(RuntimeError):
            self.portal.enviar("sessao", self.antes)
        self.assertEqual(self.finalizar.cliques, 1)
        self.assertEqual(self.pagina.idas, [])
        self.portal._conferir_tudo.assert_called_once()

    def test_a_divergent_final_check_redoes_the_flow_before_the_click(self):
        self.portal._conferir_tudo.side_effect = [ux_chamados.ErroUX(409, "diferente")]
        self.portal._fluxo = mock.Mock(side_effect=lambda *_a: setattr(self.pagina, "url", ORIGEM + browser.ROTA_ABRIR))
        self.portal._esperar_consulta = mock.Mock()
        self.pagina.controles["[role=dialog], .modal, app-modal"] = Controle(texto="Ticket 987654")
        with self.assertLogs("domains.ux_ticket_browser", "WARNING"):
            self.assertEqual(self.portal.enviar("sessao", self.antes), "987654")
        self.assertEqual(self.pagina.idas, [ORIGEM + browser.ROTA_CONSULTA])
        self.portal._fluxo.assert_called_once()
        self.assertEqual(self.finalizar.cliques, 1)

    def test_barriers_stop_before_the_click(self):
        os.environ[ux_chamados.VAR_SEM_ENVIO] = "1"
        with self.assertRaises(ux_chamados.ErroUX) as erro:
            self.portal.enviar("sessao", self.antes)
        self.assertEqual(erro.exception.status, 422)
        del os.environ[ux_chamados.VAR_SEM_ENVIO]
        self.portal._pronto = ("BRM551RN1Y", "HP 250R G9", "sessao", CEP, formulario())
        with self.assertRaises(ux_chamados.ErroUX) as erro:
            self.portal.enviar("sessao", self.antes)
        self.assertEqual(erro.exception.status, 422)
        with self.assertRaises(ux_chamados.ErroUX) as erro:
            self.portal.enviar("sessao", self.antes)  # not prepared (the flag is consumed)
        self.assertEqual(erro.exception.status, 409)
        self.assertEqual(self.finalizar.cliques, 0)
        self.antes.assert_not_called()
        self.portal._conferir_tudo.assert_not_called()

    def test_failed_final_checks_stop_before_the_callback_and_the_click(self):
        self.portal._conferir_tudo.side_effect = ux_chamados.ErroUX(409, "diferente")
        self.portal._fluxo = mock.Mock(side_effect=ux_chamados.ErroUX(409, "diferente"))
        self.portal._esperar_consulta = mock.Mock()
        with self.assertLogs("domains.ux_ticket_browser", "WARNING"), self.assertRaises(ux_chamados.ErroUX) as erro:
            self.portal.enviar("sessao", self.antes)
        self.assertEqual(erro.exception.codigo, "ux_tentativas_esgotadas")
        self.antes.assert_not_called()
        self.assertEqual(self.finalizar.cliques, 0)


def pagina_preenchida(form):
    """A form tab as left by _preencher_campos; the portal may mask CNPJ, CEP and phone (compared by digits)."""
    pagina = Pagina()
    for campo, valor in (("selectIncidente", INCIDENTE), ("selectMotivo", MOTIVO), ("novo-endereco", form.endereco)):
        pagina.controles[f"ng-select:has(input#{campo}) .ng-value-label"] = Controle(texto=valor)
    for seletor, valor in (
        ("input#cep-novo-endereco", "85504000"), ("input#atualizarCnpjInstalacao", "75110585000525"),
        ("input#atualizarCnpjFaturamento", "75110585000100"), (browser.DESCRICAO, form.descricao),
        ("input#nome", form.nome), ("input#email", form.email), ("input#telefone", "41999990000"),
        ("input#InputNumeroChamado", form.chamado_interno),
    ):
        pagina.controles[seletor] = Controle(valor=valor)
    pagina.textos[form.arquivo_nome] = Controle(1)
    return pagina


class ConferenciaFinalTests(unittest.TestCase):
    def test_rereads_route_header_choices_every_field_and_the_attachment(self):
        form = formulario(chamado_interno="AB-1")
        portal = browser.PortalTicketUXChrome(Contexto())
        portal._conferir_tudo(pagina_preenchida(form), "ABC123", "HP 250R G9", CEP, form)
        divergencias = {
            "rota": lambda p: setattr(p, "url", ORIGEM + "/ng/home"),
            "cabeçalho": lambda p: setattr(p.controles["body"], "texto", CABECALHO.replace("HP 250R G9", "HP 240")),
            "endereço": lambda p: setattr(p.controles["ng-select:has(input#novo-endereco) .ng-value-label"], "texto", "X"),
            "motivo": lambda p: setattr(p.controles["ng-select:has(input#selectMotivo) .ng-value-label"], "texto", ""),
            "cep": lambda p: setattr(p.controles["input#cep-novo-endereco"], "valor", "85504001"),
            "cnpj": lambda p: setattr(p.controles["input#atualizarCnpjFaturamento"], "valor", "75110585000525"),
            "registro": lambda p: setattr(p.controles[browser.DESCRICAO], "valor", "Atualizar o endereço"),
            "nome": lambda p: setattr(p.controles["input#nome"], "valor", "Outra"),
            "email": lambda p: setattr(p.controles["input#email"], "valor", ""),
            "telefone": lambda p: setattr(p.controles["input#telefone"], "valor", "4199999000"),
            "interno": lambda p: setattr(p.controles["input#InputNumeroChamado"], "valor", ""),
            "anexo": lambda p: setattr(p.textos[form.arquivo_nome], "quantidade", 2),
        }
        for nome, alterar in divergencias.items():
            pagina = pagina_preenchida(form)
            alterar(pagina)
            with self.subTest(nome), self.assertRaises(ux_chamados.ErroUX) as erro:
                portal._conferir_tudo(pagina, "ABC123", "HP 250R G9", CEP, form)
            self.assertEqual(erro.exception.status, 409)
            self.assertNotIn("Pessoa", str(erro.exception))


class ContingenciaTests(unittest.TestCase):
    def setUp(self):
        self.contexto = Contexto()
        self.portal = browser.PortalTicketUXChrome(self.contexto)
        self.portal._esperar_consulta = mock.Mock()

    def test_a_a_route_deviation_goes_back_to_the_consulta_and_succeeds_on_the_second_try(self):
        inicios = []

        def ate_enderecos(page, serial, aba, cep):
            inicios.append(page.url)

            def buscar():
                if len(inicios) == 1:
                    page.url = ORIGEM + "/ng/home"  # accidental click on a menu link
            self.portal._passo(page, "Buscar", buscar, rota=browser.ROTA_CONSULTA)
            page.url = ORIGEM + browser.ROTA_ABRIR
            return "HP 250R G9", [ENDERECO]

        self.portal._ate_enderecos = ate_enderecos
        with self.assertLogs(browser.logger, "WARNING") as logs:
            self.assertEqual(self.portal.preparar("ABC123", "sessao", CEP), ("HP 250R G9", [ENDERECO]))
        [pagina] = self.contexto.pages  # same tab: no new page for the retry
        self.assertEqual(pagina.idas, [ORIGEM + browser.ROTA_CONSULTA] * 2)
        self.assertEqual(inicios, [ORIGEM + browser.ROTA_CONSULTA] * 2)
        self.assertEqual(logs.output, ["WARNING:domains.ux_ticket_browser:UX ticket: passo Buscar, tentativa 1/3, ErroUX"])

    def test_b_a_persistent_failure_stops_after_three_tries_and_names_only_the_step(self):
        def ate_enderecos(page, serial, aba, cep):
            page.url = ORIGEM + browser.ROTA_ABRIR

            def motivo():
                raise RuntimeError("selector input#nome value=Pessoa CNPJ 75.110.585/0005-25")
            self.portal._passo(page, "Motivo", motivo)

        self.portal._ate_enderecos = ate_enderecos
        with self.assertLogs(browser.logger, "WARNING") as logs, self.assertRaises(ux_chamados.ErroUX) as erro:
            self.portal.preparar("ABC123", "sessao", CEP)
        self.assertEqual((erro.exception.status, erro.exception.codigo), (409, "ux_tentativas_esgotadas"))
        self.assertIn('passo "Motivo" depois de 3 tentativas', str(erro.exception))
        self.assertEqual(len(self.contexto.pages[0].idas), browser.TENTATIVAS)
        self.assertEqual(logs.output, [
            f"WARNING:domains.ux_ticket_browser:UX ticket: passo Motivo, tentativa {n}/3, RuntimeError" for n in (1, 2, 3)
        ])
        self.assertNotIn("75.110", str(erro.exception) + "".join(logs.output))
        self.assertIsNone(erro.exception.__cause__)

    def test_c_a_divergent_final_check_repeats_the_whole_preparation(self):
        pagina = Pagina()
        self.contexto.pages.append(pagina)
        ng_select(pagina, "novo-endereco", [ENDERECO, "OUTRO"])
        self.portal._conferir_equipamento = mock.Mock()
        self.portal._preencher_campos = mock.Mock()
        conferencias = []

        def conferir(page, serial, modelo, cep, form):
            self.portal._etapa = "Conferência final"
            conferencias.append(page.url)
            if len(conferencias) == 1:
                raise ux_chamados.ErroUX(409, "A conferência final encontrou um campo diferente do esperado.")

        def ate_enderecos(page, serial, aba, cep):
            page.url = ORIGEM + browser.ROTA_ABRIR
            return "HP 250R G9", [ENDERECO, "OUTRO"]

        self.portal._conferir_tudo = conferir
        self.portal._ate_enderecos = ate_enderecos
        with self.assertLogs(browser.logger, "WARNING") as logs:
            self.portal.preencher("ABC123", "HP 250R G9", "sessao", CEP, formulario())
        self.assertEqual(len(conferencias), 2)
        self.assertEqual(self.portal._preencher_campos.call_count, 2)
        self.assertEqual(pagina.idas, [ORIGEM + browser.ROTA_CONSULTA])
        self.assertEqual(self.portal._pronto[2:4], ("sessao", CEP))
        self.assertEqual(logs.output, [
            "WARNING:domains.ux_ticket_browser:UX ticket: passo Conferência final, tentativa 1/3, ErroUX",
        ])

    def test_d_accidental_popups_of_the_session_tab_are_closed_and_other_tabs_are_not(self):
        pagina, alheia = Pagina(), Pagina(nome="outra:abrir-ticket")
        popup, popup_alheio = Pagina(url=ORIGEM + "/ng/home", nome=""), Pagina(url="https://example.test", nome="")
        popup.aberta_por, popup_alheio.aberta_por = pagina, alheia
        self.contexto.pages += [pagina, alheia, popup, popup_alheio]
        self.assertIs(self.portal._aba("sessao"), pagina)
        self.portal._vigiar(pagina)
        self.assertEqual(len(pagina.ouvintes["popup"]), 1)  # registered once per connection
        novo = Pagina(url="https://example.test/x", nome="")
        pagina.ouvintes["popup"][0](novo)  # the live listener closes it as soon as it opens
        self.assertTrue(novo.fechada)

        def clique_acidental():
            raise RuntimeError("outra janela tomou o foco")

        with self.assertLogs(browser.logger, "WARNING"):
            self.assertEqual(self.portal._com_contingencia(pagina, "sessao", lambda: "ok", clique_acidental), "ok")
        self.assertEqual(
            (popup.fechada, popup_alheio.fechada, alheia.fechada, pagina.fechada), (True, False, False, False),
        )

    def test_f_an_ambiguous_or_empty_address_list_spends_no_tries(self):
        pagina = Pagina()
        self.contexto.pages.append(pagina)
        self.portal._conferir_equipamento = mock.Mock()
        self.portal._conferir_escolhas = mock.Mock(side_effect=ux_chamados.ErroUX(409, "mudou"))
        self.portal._ate_enderecos = lambda page, *_a: (
            setattr(page, "url", ORIGEM + browser.ROTA_ABRIR), ("HP 250R G9", [ENDERECO, ENDERECO]),
        )[1]
        with self.assertLogs(browser.logger, "WARNING") as logs, self.assertRaises(ux_chamados.ErroUX) as erro:
            self.portal.escolher_endereco("ABC123", "HP 250R G9", "sessao", ENDERECO, CEP)
        self.assertEqual((erro.exception.status, erro.exception.codigo), (409, "endereco_ambiguo"))
        self.assertEqual(pagina.idas, [ORIGEM + browser.ROTA_CONSULTA])  # one return, then back to the user
        self.assertEqual(len(logs.output), 1)
        # preparar never retries a list: ambiguous or empty, it goes back to the user (the service decides)
        nova = browser.PortalTicketUXChrome(Contexto())
        nova._esperar_consulta = mock.Mock()
        nova._ate_enderecos = lambda page, *_a: ("HP 250R G9", [])
        self.assertEqual(nova.preparar("ABC123", "sessao", CEP), ("HP 250R G9", []))
        self.assertEqual(len(nova._contexto.pages[0].idas), 1)

    def test_empty_address_list_is_read_as_empty(self):
        for opcoes in ([], [ENDERECO, "OUTRO"]):
            pagina = Pagina()
            ng_select(pagina, "novo-endereco", opcoes)
            with self.subTest(opcoes=opcoes):
                self.assertEqual(browser.PortalTicketUXChrome._ler_enderecos(pagina), opcoes)
                self.assertEqual(pagina.keyboard.teclas, ["Escape"])

    def test_identical_addresses_are_read_once(self):
        pagina = Pagina()
        ng_select(pagina, "novo-endereco", [ENDERECO, "OUTRO", ENDERECO])
        self.assertEqual(browser.PortalTicketUXChrome._ler_enderecos(pagina), [ENDERECO, "OUTRO"])

    def test_a_lost_login_waits_without_spending_tries(self):
        pagina = Pagina()
        falhas = iter(["login", "login", "login", "rota", "rota", None])

        def refazer():
            falha = next(falhas)
            if falha == "login":
                pagina.url = "https://login.microsoftonline.com/x"
                raise TimeoutError()
            if falha == "rota":
                pagina.url = ORIGEM + "/ng/home"
                raise ux_chamados.ErroUX(409, "x", codigo="rota_inesperada")
            return "ok"

        with self.assertLogs(browser.logger, "WARNING"):
            self.assertEqual(self.portal._com_contingencia(pagina, "sessao", refazer), "ok")
        self.assertEqual(len(pagina.idas), 6)

    def test_lost_tab_validation_and_login_timeout_are_not_retried(self):
        casos = {
            "aba fechada": (lambda p: setattr(p, "fechada", True), RuntimeError("x"), "aba_perdida"),
            "dados": (lambda p: None, ux_chamados.ErroUX(422, "dados"), ""),
            "login": (lambda p: None, ux_chamados.ErroUX(503, "login"), ""),
        }
        for nome, (preparar, falha, codigo) in casos.items():
            pagina = Pagina()

            def primeira():
                preparar(pagina)
                raise falha

            with self.subTest(nome), self.assertRaises(ux_chamados.ErroUX) as erro:
                self.portal._com_contingencia(pagina, "sessao", lambda: "ok", primeira)
            self.assertEqual(erro.exception.codigo, codigo)
            self.assertEqual(pagina.idas, [])


class LoginTests(unittest.TestCase):
    def test_after_manual_login_goes_back_to_the_search_once(self):
        pagina = Pagina(url=ORIGEM + "/ng/home")
        busca = pagina.locator("input#inputNumeroSerie")
        busca.quantidade = 0
        original = pagina.goto

        def ir(url, **kwargs):
            original(url, **kwargs)
            busca.quantidade = 1

        pagina.goto = ir
        with mock.patch.object(browser, "automation", mock.Mock(ux_logado=lambda _p: True)):
            browser.PortalTicketUXChrome._esperar_consulta(pagina)
        self.assertEqual(pagina.idas, [ORIGEM + browser.ROTA_CONSULTA])

    def test_without_login_it_tries_gansouza_once_then_gives_up_with_503(self):
        pagina = Pagina(url="https://login.microsoftonline.com/x")
        automacao = mock.Mock(ux_logado=lambda _p: False, EMAIL_DASHBOARD="gansouza@simpress.com.br")
        with mock.patch.object(browser, "automation", automacao), mock.patch.object(browser, "ESPERA_LOGIN_S", 0.05),                 self.assertRaises(ux_chamados.ErroUX) as erro:
            browser.PortalTicketUXChrome._esperar_consulta(pagina)
        self.assertEqual(erro.exception.status, 503)
        self.assertEqual(pagina.idas, [])
        automacao.aguardar_login.assert_called_once_with(
            pagina, "UX Simpress", automacao.ux_logado, entrar=automacao.ux_entrar,
            email="gansouza@simpress.com.br", esperar_usuario=False)


class AbaTests(unittest.TestCase):
    def test_close_finds_only_the_session_tab(self):
        propria, outra = Pagina(url=ORIGEM + "/ng/home"), Pagina(nome="outra:abrir-ticket")
        browser.PortalTicketUXChrome(Contexto(propria, outra)).fechar("sessao")
        self.assertEqual((propria.fechada, outra.fechada), (True, False))


if __name__ == "__main__":
    unittest.main()
