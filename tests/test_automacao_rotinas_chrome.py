import contextlib
import hashlib
import io
import itertools
import json
import os
import re
import sys
import tempfile
import time
import unittest
import zipfile
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import MagicMock, patch

from scripts import automacao_rotinas_chrome as automacao


class ChromeAutomationHelpersTests(unittest.TestCase):
    def setUp(self):
        self.temp_context = tempfile.TemporaryDirectory(prefix=".automacao-chrome-test-")
        self.root = Path(self.temp_context.name)
        self.sinal = self.root / "automacao_chrome.cancelar"
        patcher = patch.object(automacao, "CANCELAR_ARQUIVO", self.sinal)
        patcher.start()
        self.addCleanup(patcher.stop)
        avisos = patch.object(automacao, "avisar")  # nenhum toast real nos testes
        self.avisar = avisos.start()
        self.addCleanup(avisos.stop)

    def tearDown(self):
        self.temp_context.cleanup()

    def test_nome_livre_follows_chrome_numbering_without_overwriting(self):
        self.assertEqual(automacao.nome_livre(self.root, "Gestão de Solicitações.xlsx").name, "Gestão de Solicitações.xlsx")
        (self.root / "Gestão de Solicitações.xlsx").write_bytes(b"a")
        (self.root / "Gestão de Solicitações (1).xlsx").write_bytes(b"b")
        self.assertEqual(
            automacao.nome_livre(self.root, "Gestão de Solicitações.xlsx").name,
            "Gestão de Solicitações (2).xlsx",
        )

    def test_montar_multipart_carries_the_file_field_and_content(self):
        corpo, tipo = automacao.montar_multipart('Dash"board\r\n.xlsx', b"PK\x03\x04dados")
        limite = tipo.split("boundary=")[1]
        self.assertTrue(corpo.startswith(f"--{limite}\r\n".encode()))
        self.assertTrue(corpo.endswith(f"\r\n--{limite}--\r\n".encode()))
        self.assertIn(b'name="file"; filename="Dash_board__.xlsx"', corpo)
        self.assertIn(b"PK\x03\x04dados", corpo)

    def test_importar_dashboard_no_site_turns_http_errors_into_rotina_erro(self):
        import io as _io
        import urllib.error

        arquivo = self.root / "Dashboard.xlsx"
        arquivo.write_bytes(b"PK")
        erro = urllib.error.HTTPError("u", 422, "x", {}, _io.BytesIO(b'{"detail": "arquivo inv\\u00e1lido"}'))
        self.addCleanup(erro.close)
        opener = patch("urllib.request.OpenerDirector.open", side_effect=erro)
        with opener, self.assertRaisesRegex(automacao.RotinaErro, "HTTP 422.*arquivo inválido"):
            automacao.importar_dashboard_no_site(arquivo)

    def test_arquivo_final_dashboard_uses_the_site_output_and_ignores_downloads(self):
        saida = self.root / "saida"
        downloads = self.root / "downloads"
        downloads.mkdir()
        (downloads / automacao.DASHBOARD_FINAL).write_bytes(b"PK")  # cópia baixada do SharePoint: nunca é o final
        with patch.object(automacao, "DASHBOARD_SAIDA_DIR", saida), patch.object(automacao, "pastas_download_chrome", return_value=[downloads]):
            with self.assertRaisesRegex(automacao.RotinaErro, "Atualizar Dashboard"):
                automacao.arquivo_final_dashboard()
            saida.mkdir()
            (saida / automacao.DASHBOARD_FINAL).write_bytes(b"PK final")
            self.assertEqual(automacao.arquivo_final_dashboard(), saida / automacao.DASHBOARD_FINAL)

    def _resultado(self, estado: str, pasta: str, status: str) -> None:
        destino = self.root / estado / pasta
        destino.mkdir(parents=True)
        (destino / "_resultado.json").write_text(
            json.dumps({"lote_id": "OS_1", "status": status, "detalhe": "ok"}), encoding="utf-8"
        )

    def test_confirmar_lote_reads_processed_and_renamed_batches(self):
        self._resultado("processadas", "OS_1--a1b2c3d4", "concluido")
        self._resultado("processadas", "OS_10", "concluido")
        resultado = automacao.confirmar_lote(self.root, "OS_1", timeout_s=1)
        self.assertEqual(resultado["status"], "concluido")
        self.assertTrue(resultado["pasta"].endswith("OS_1--a1b2c3d4"))

    def test_confirmar_lote_reports_failures_and_times_out(self):
        self._resultado("falhas", "OS_2", "falha")
        self.assertEqual(automacao.confirmar_lote(self.root, "OS_2", timeout_s=1)["status"], "falha")
        with patch.object(automacao.time, "sleep"), self.assertRaises(automacao.RotinaErro):
            automacao.confirmar_lote(self.root, "OS_3", timeout_s=0)

    def _pagina_falsa(self):
        relogio = {"agora": 0.0}

        class PaginaFalsa:
            def wait_for_timeout(self, ms):
                relogio["agora"] += ms / 1000

            def bring_to_front(self):
                pass

        return PaginaFalsa(), relogio

    def test_aguardar_login_tries_sso_once_then_asks_user(self):
        page, relogio = self._pagina_falsa()
        cliques = []
        mensagens = []

        def entrar(_page):
            cliques.append(relogio["agora"])
            return True

        with (
            patch.object(automacao.time, "time", lambda: relogio["agora"]),
            patch.object(automacao, "log", lambda origem, msg: mensagens.append(msg)),
            patch.object(automacao, "LOGIN_TIMEOUT_S", 60),
            self.assertRaises(automacao.RotinaErro),
        ):
            automacao.aguardar_login(page, "UX Simpress", lambda _p: False, entrar=entrar)
        self.assertEqual(len(cliques), 1)
        self.assertTrue(any("conta conectada não concluiu" in m for m in mensagens))
        self.assertTrue(any("AÇÃO NECESSÁRIA" in m for m in mensagens))
        # um aviso ao pedir o login e outro na metade do tempo
        self.assertEqual(self.avisar.call_count, 2)
        for chamada in self.avisar.call_args_list:
            self.assertIn("UX Simpress", chamada.args[0])

    def test_aguardar_login_returns_when_sso_logs_in(self):
        page, relogio = self._pagina_falsa()
        estado = {"logado": False}

        def entrar(_page):
            estado["logado"] = True
            return True

        with (
            patch.object(automacao.time, "time", lambda: relogio["agora"]),
            patch.object(automacao, "log", lambda origem, msg: None),
        ):
            automacao.aguardar_login(page, "UX Simpress", lambda _p: estado["logado"], entrar=entrar)
        self.assertTrue(estado["logado"])

    def test_aguardar_login_stops_when_cancel_signal_appears(self):
        page, relogio = self._pagina_falsa()

        def logado(_page):
            if relogio["agora"] >= 30:  # o usuário pede o cancelamento enquanto a rotina espera o login
                automacao.pedir_cancelamento()
            return False

        with (
            patch.object(automacao.time, "time", lambda: relogio["agora"]),
            patch.object(automacao, "log", lambda origem, msg: None),
            patch.object(automacao, "_inicio_execucao", 0.0),
            self.assertRaises(automacao.RotinaCancelada),
        ):
            automacao.aguardar_login(page, "Oracle", logado)
        self.assertLess(relogio["agora"], 40)

    def test_stale_cancel_signal_does_not_cancel_new_run(self):
        automacao.pedir_cancelamento()
        antigo = time.time() - 3600
        os.utime(self.sinal, (antigo, antigo))
        with patch.object(automacao, "_inicio_execucao", time.time()):
            self.assertFalse(automacao.cancelamento_pedido())
            automacao.verificar_cancelamento()
        with patch.object(automacao, "_inicio_execucao", 0.0):
            automacao.iniciar_controle_cancelamento()
            self.assertFalse(self.sinal.exists())
            self.assertFalse(automacao.cancelamento_pedido())

    def test_main_returns_130_and_clears_signal_when_cancelled(self):
        def executar(_rotina, _sem_finalizar=False, _planilha_ux=None):
            automacao.pedir_cancelamento()
            automacao.verificar_cancelamento()

        saida = io.StringIO()
        with (
            patch.object(automacao, "executar", executar),
            patch.object(sys, "argv", ["automacao", "--rotina", "login"]),
            patch.object(automacao, "_inicio_execucao", 0.0),
            patch.object(automacao, "iniciar_log_execucao"),
            redirect_stdout(saida),
        ):
            self.assertEqual(automacao.main(), 130)
        self.assertIn("Rotina cancelada pelo usuário.", saida.getvalue())
        self.assertFalse(self.sinal.exists())

    def test_main_cancelar_only_creates_signal(self):
        with (
            patch.object(automacao, "executar") as executar,
            patch.object(sys, "argv", ["automacao", "--cancelar"]),
            redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(automacao.main(), 0)
        executar.assert_not_called()
        self.assertTrue(self.sinal.exists())

    def test_confirmar_lote_cancel_reports_batch_already_published(self):
        automacao.pedir_cancelamento()
        with (
            patch.object(automacao, "_inicio_execucao", 0.0),
            patch.object(automacao.time, "sleep"),
            self.assertRaises(automacao.RotinaCancelada) as contexto,
        ):
            automacao.confirmar_lote(self.root, "OS_9", timeout_s=5)
        self.assertIn("pendentes", str(contexto.exception))

    def test_descrever_erro_keeps_only_first_line_of_playwright_errors(self):
        erro = TimeoutError("Locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator")
        self.assertEqual(automacao.descrever_erro(erro), "TimeoutError: Locator.click: Timeout 30000ms exceeded.")
        self.assertEqual(automacao.descrever_erro(automacao.RotinaErro("Login não concluído")), "Login não concluído")

    def test_acionar_quando_pronto_repete_ate_a_tela_sair_do_esqueleto(self):
        class Falso:
            chamadas = 0
            marcado = False

            def check(self):
                Falso.chamadas += 1
                if Falso.chamadas < 3:
                    raise RuntimeError("esqueleto de carregamento")
                Falso.marcado = True

        falso = Falso()
        automacao.acionar_quando_pronto(falso.check, "radio", timeout_ms=5000, confirmar=lambda: Falso.marcado, intervalo_s=0)
        self.assertEqual(Falso.chamadas, 3)

    def test_acionar_quando_pronto_esgota_com_erro_claro(self):
        def falha():
            raise RuntimeError("não clicável")

        with self.assertRaises(automacao.RotinaErro) as contexto:
            automacao.acionar_quando_pronto(falha, "Radio X", timeout_ms=30, intervalo_s=0.01)
        self.assertIn("Radio X", str(contexto.exception))
        self.assertIn("não clicável", str(contexto.exception))

    def test_acionar_quando_pronto_respeita_cancelamento(self):
        self.sinal.write_text("x")
        chamadas = []
        with self.assertRaises(automacao.RotinaCancelada):
            automacao.acionar_quando_pronto(lambda: chamadas.append(1), "radio", timeout_ms=5000, intervalo_s=0)
        self.assertEqual(chamadas, [])


class LoginAbasTests(unittest.TestCase):
    """Rotina "Abrir Chrome para login": Endpoint (pr-sebrae), UX e Oracle com login compartilhado."""

    def setUp(self):
        self.temp_context = tempfile.TemporaryDirectory(prefix=".automacao-chrome-test-")
        self.addCleanup(self.temp_context.cleanup)
        for alvo, valor in (
            ("CANCELAR_ARQUIVO", Path(self.temp_context.name) / "automacao_chrome.cancelar"),
            ("avisar", MagicMock()),
            ("log", MagicMock()),
        ):
            patcher = patch.object(automacao, alvo, valor)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _conta_microsoft(self, textos):
        """Tela "Escolha uma conta" falsa: registra o texto clicado; sem campo de e-mail nem senha."""
        clicados = []
        page = MagicMock()
        page.url = "https://login.microsoftonline.com/x/saml2?sso_reload=true"
        page.is_closed.return_value = False

        def achar(padrao):
            alvos = [t for t in textos if padrao.search(t)]
            filtrado = MagicMock()
            filtrado.filter.return_value.count.return_value = len(alvos)
            filtrado.filter.return_value.first.click.side_effect = lambda: clicados.append(alvos[0])
            return filtrado

        page.get_by_text.side_effect = achar
        page.locator.return_value.filter.return_value.count.return_value = 0
        relogio = {"agora": 0.0}
        page.wait_for_timeout.side_effect = lambda ms: relogio.__setitem__("agora", relogio["agora"] + ms / 1000)
        return page, clicados, relogio

    def test_microsoft_clicks_only_the_requested_account(self):
        page, clicados, relogio = self._conta_microsoft(
            ["Gabriel Akihiro Noda Souza", "gansouza@simpress.com.br", "GAkihiro@pr.sebrae.com.br", "Use outra conta"]
        )
        with (
            patch.object(automacao.time, "time", lambda: relogio["agora"]),
            patch.object(automacao, "visivel", return_value=False),
        ):
            automacao.entrar_microsoft(page, "Oracle", "gansouza@simpress.com.br", espera_s=5)
        self.assertEqual(clicados, ["gansouza@simpress.com.br"])

    def test_microsoft_uses_another_account_when_requested_one_is_not_listed(self):
        page, clicados, relogio = self._conta_microsoft(["GAkihiro@pr.sebrae.com.br", "Use outra conta"])
        with (
            patch.object(automacao.time, "time", lambda: relogio["agora"]),
            patch.object(automacao, "visivel", return_value=False),
        ):
            automacao.entrar_microsoft(page, "Oracle", "gansouza@simpress.com.br", espera_s=5)
        self.assertEqual(set(clicados), {"Use outra conta"})  # nunca a conta do Sebrae

    def test_microsoft_types_the_email_in_a_generic_text_field_and_advances(self):
        page, _clicados, relogio = self._conta_microsoft([])
        campo, avancar = MagicMock(), MagicMock()
        for alvo in (campo, avancar):
            alvo.filter.return_value.count.return_value = 1
        page.locator.side_effect = lambda seletor: campo if seletor == automacao.CAMPO_EMAIL_MICROSOFT else avancar
        self.assertIn("input[type='text']", automacao.CAMPO_EMAIL_MICROSOFT)
        self.assertNotIn("password", automacao.CAMPO_EMAIL_MICROSOFT)
        with (
            patch.object(automacao.time, "time", lambda: relogio["agora"]),
            patch.object(automacao, "visivel", return_value=False),
        ):
            automacao.entrar_microsoft(page, "SoftExpert", "gakihiro@pr.sebrae.com.br", espera_s=3)
        campo.filter.return_value.first.fill.assert_called_with("gakihiro@pr.sebrae.com.br")
        avancar.filter.return_value.first.click.assert_called_once()

    def test_sharepoint_dashboard_signs_in_with_the_simpress_account(self):
        page = MagicMock()
        page.url = "https://login.microsoftonline.com/"
        with patch.object(automacao, "entrar_microsoft") as entrar:
            self.assertTrue(automacao.pasta_dashboard_entrar(page))
        self.assertEqual(entrar.call_args.args[2], automacao.EMAIL_DASHBOARD)

    def _pagina_endpoint(self, usuario="gakihiro"):
        page = MagicMock()
        page.url = "https://centralendpoint.pr.sebrae.com.br/client#/login"
        filtrado = page.locator.return_value.filter.return_value
        filtrado.first.input_value.return_value = usuario
        return page, filtrado.filter.return_value.first.click, filtrado.first.fill

    def _entrar_endpoint(self, page, senha: bool, dominio: bool) -> bool:
        with (
            patch.object(automacao, "visivel", return_value=True),
            patch.object(automacao, "endpoint_senha_preenchida", return_value=senha),
            patch.object(automacao, "endpoint_escolher_dominio", return_value=dominio) as escolher,
        ):
            resultado = automacao.endpoint_entrar(page)
        escolher.assert_called_once()
        return resultado

    def test_endpoint_clicks_login_only_with_domain_confirmed_and_password_from_chrome(self):
        page, clicar, _ = self._pagina_endpoint()
        self.assertTrue(self._entrar_endpoint(page, senha=True, dominio=True))
        clicar.assert_called_once()

    def test_endpoint_does_not_click_login_without_saved_password(self):
        page, clicar, preencher = self._pagina_endpoint(usuario="")
        self.assertTrue(self._entrar_endpoint(page, senha=False, dominio=True))
        clicar.assert_not_called()
        preencher.assert_called_once_with(automacao.ENDPOINT_USUARIO)

    def test_endpoint_does_not_click_login_when_domain_not_confirmed(self):
        page, clicar, _ = self._pagina_endpoint()
        self.assertTrue(self._entrar_endpoint(page, senha=True, dominio=False))
        clicar.assert_not_called()

    def test_exportar_endpoint_uses_the_endpoint_login_fill(self):
        with (
            patch.object(automacao, "nova_aba"),
            patch.object(automacao, "aguardar_login", side_effect=automacao.RotinaErro("parou")) as aguardar,
            self.assertRaises(automacao.RotinaErro),
        ):
            automacao.exportar_endpoint(MagicMock())
        self.assertIs(aguardar.call_args.kwargs["entrar"], automacao.endpoint_entrar)

    def test_exportar_endpoint_watches_the_hotfix_notice(self):
        with (
            patch.object(automacao, "nova_aba") as aba,
            patch.object(automacao, "endpoint_vigiar_avisos") as vigiar,
            patch.object(automacao, "aguardar_login", side_effect=automacao.RotinaErro("parou")),
            self.assertRaises(automacao.RotinaErro),
        ):
            automacao.exportar_endpoint(MagicMock())
        vigiar.assert_called_once_with(aba.return_value)

    def test_endpoint_vigiar_avisos_clicks_do_it_later_through_a_locator_handler(self):
        page = MagicMock()
        automacao.endpoint_vigiar_avisos(page)
        aviso, fechar = page.add_locator_handler.call_args.args
        fechar(aviso)
        aviso.get_by_text.return_value.first.click.assert_called_once()

    def test_endpoint_vigiar_avisos_falls_back_to_the_close_button(self):
        page = MagicMock()
        automacao.endpoint_vigiar_avisos(page)
        aviso, fechar = page.add_locator_handler.call_args.args
        aviso.get_by_text.return_value.first.click.side_effect = RuntimeError("sem botão")
        fechar(aviso)
        aviso.hover.assert_called_once()
        aviso.locator.return_value.filter.return_value.first.click.assert_called_once()

    def test_endpoint_ignores_pages_that_are_not_the_login_screen(self):
        page, clicar, _ = self._pagina_endpoint()
        page.url = "https://centralendpoint.pr.sebrae.com.br/webclient#/uems/inventory/computers"
        self.assertFalse(automacao.endpoint_entrar(page))
        clicar.assert_not_called()

    def test_aguardar_login_without_waiting_for_user_returns_false_after_automatic_attempts(self):
        relogio = {"agora": 0.0}
        page = MagicMock()
        page.wait_for_timeout.side_effect = lambda ms: relogio.__setitem__("agora", relogio["agora"] + ms / 1000)
        with patch.object(automacao.time, "time", lambda: relogio["agora"]):
            self.assertFalse(automacao.aguardar_login(page, "Endpoint Central", lambda _p: False, esperar_usuario=False))
        page.bring_to_front.assert_not_called()
        automacao.avisar.assert_not_called()

    def _abrir(self, abas, logados, aguardar):
        """Roda ``abrir_para_login`` com abas falsas; ``logados`` diz, por site, se a aba já está logada."""
        contexto = MagicMock()
        with (
            patch.object(automacao, "nova_aba", side_effect=lambda _c, _u, origem: abas[origem]),
            patch.object(automacao, "aguardar_login", side_effect=aguardar),
            patch.object(automacao, "endpoint_logado", lambda _p: logados["Endpoint Central"]()),
            patch.object(automacao, "ux_logado", lambda _p: logados["UX Simpress"]()),
            patch.object(automacao, "oracle_logado", lambda _p: logados["Oracle"]()),
            redirect_stdout(io.StringIO()),
        ):
            return automacao.abrir_para_login(contexto)

    @staticmethod
    def _abas():
        abas = {nome: MagicMock() for nome in ("Endpoint Central", "UX Simpress", "Oracle")}
        for aba in abas.values():
            aba.is_closed.return_value = False
        return abas

    def test_oracle_tab_reopens_when_ux_already_logged_in_during_automatic_attempts(self):
        abas = self._abas()
        logados = {"Endpoint Central": lambda: True, "UX Simpress": lambda: True, "Oracle": lambda: abas["Oracle"].goto.called}

        def aguardar(page, nome, logado, **_kw):
            return logado(page)

        self.assertEqual(self._abrir(abas, logados, aguardar), 0)
        abas["Oracle"].goto.assert_called_once()
        abas["UX Simpress"].goto.assert_not_called()
        abas["Endpoint Central"].goto.assert_not_called()

    def test_oracle_tab_reopens_when_user_finishes_ux_login(self):
        abas = self._abas()
        estado = {"ux": False}
        abas["UX Simpress"].wait_for_timeout.side_effect = lambda _ms: estado.update(ux=True)
        logados = {
            "Endpoint Central": lambda: True,
            "UX Simpress": lambda: estado["ux"],
            "Oracle": lambda: abas["Oracle"].goto.called,
        }

        def aguardar(page, nome, logado, **_kw):
            return logado(page)

        self.assertEqual(self._abrir(abas, logados, aguardar), 0)
        abas["Oracle"].goto.assert_called_once()
        abas["UX Simpress"].goto.assert_not_called()
        mensagens = " ".join(chamada.args[1] for chamada in automacao.log.call_args_list)
        self.assertIn("AÇÃO NECESSÁRIA: faça o login na janela do Chrome de automação (UX Simpress, Oracle)", mensagens)

    def test_waiting_for_login_times_out_listing_pending_sites(self):
        abas = self._abas()
        logados = {nome: (lambda: False) for nome in abas}
        with patch.object(automacao, "LOGIN_TIMEOUT_S", 0), self.assertRaises(automacao.RotinaErro) as erro:
            self._abrir(abas, logados, lambda *_a, **_kw: False)
        self.assertIn("Endpoint Central, UX Simpress, Oracle", str(erro.exception))


class ExecucaoUnicaTests(unittest.TestCase):
    def setUp(self):
        self.temp_context = tempfile.TemporaryDirectory(prefix=".automacao-trava-test-")
        self.trava = Path(self.temp_context.name) / "state" / "automacao_chrome.lock"
        patcher = patch.object(automacao, "TRAVA_PATH", self.trava)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self.temp_context.cleanup()

    def _gravar(self, pid: int, rotina: str = "os", inicio: str = "2026-10-20T09:05:00-03:00") -> None:
        self.trava.parent.mkdir(parents=True, exist_ok=True)
        self.trava.write_text(json.dumps({"pid": pid, "rotina": rotina, "inicio": inicio}), encoding="utf-8")

    def test_trava_livre_is_acquired_and_released(self):
        self.assertIsNone(automacao.ler_trava())
        with automacao.trava_execucao("login"):
            estado = automacao.ler_trava()
            self.assertEqual(estado["pid"], automacao.os.getpid())
            self.assertEqual(estado["rotina"], "login")
        self.assertFalse(self.trava.exists())
        self.assertIsNone(automacao.ler_trava())

    def test_trava_ocupada_by_live_pid_blocks_with_clear_message(self):
        self._gravar(4242, rotina="inventarios")
        with patch.object(automacao, "pid_vivo", lambda pid: True):
            self.assertEqual(automacao.ler_trava()["rotina"], "inventarios")
            with self.assertRaises(automacao.TravaOcupada) as ctx:
                automacao.adquirir_trava("os")
        self.assertEqual(
            str(ctx.exception), "Já existe uma rotina em andamento (rotina inventarios, PID 4242, desde 09:05)"
        )
        self.assertEqual(json.loads(self.trava.read_text(encoding="utf-8"))["pid"], 4242)

    def test_trava_orfa_is_taken_over(self):
        self._gravar(4242)
        with patch.object(automacao, "pid_vivo", lambda pid: pid == automacao.os.getpid()):
            self.assertIsNone(automacao.ler_trava())
            automacao.adquirir_trava("ambas")
            self.assertEqual(automacao.ler_trava()["rotina"], "ambas")
        automacao.liberar_trava()
        self.assertFalse(self.trava.exists())

    def test_trava_is_released_on_exception_and_ctrl_c(self):
        for erro in (RuntimeError("falhou"), KeyboardInterrupt()):
            with self.assertRaises(type(erro)), automacao.trava_execucao("os"):
                self.assertTrue(self.trava.exists())
                raise erro
            self.assertFalse(self.trava.exists())

    def test_liberar_trava_keeps_lock_of_other_process(self):
        self._gravar(4242)
        automacao.liberar_trava()
        self.assertTrue(self.trava.exists())

    def test_main_returns_2_when_another_run_is_alive(self):
        self._gravar(4242, rotina="os")
        with (
            patch.object(automacao, "pid_vivo", lambda pid: True),
            patch.object(automacao.sys, "argv", ["automacao", "--rotina", "login"]),
            patch.object(automacao, "iniciar_log_execucao"),
            patch("builtins.print") as impresso,
        ):
            self.assertEqual(automacao.main(), 2)
        self.assertIn("Já existe uma rotina em andamento (rotina os, PID 4242", impresso.call_args[0][0])

    def test_pid_vivo_detects_current_and_missing_processes(self):
        self.assertTrue(automacao.pid_vivo(automacao.os.getpid()))
        self.assertFalse(automacao.pid_vivo(0))
        self.assertFalse(automacao.pid_vivo(2_000_000_000))

class ExecutionLogTests(unittest.TestCase):
    def setUp(self):
        self.temp_context = tempfile.TemporaryDirectory(prefix=".automacao-chrome-log-test-")
        self.pasta = Path(self.temp_context.name) / "automacao_chrome"
        self.patcher = patch.object(automacao, "ERROS_DIR", self.pasta)
        self.patcher.start()

    def tearDown(self):
        automacao.finalizar_log_execucao(1)  # garante sys.stdout restaurado se um teste falhar no meio
        self.patcher.stop()
        self.temp_context.cleanup()

    def _executar(self, codigo: int, corpo=None) -> tuple[str, Path, dict]:
        console = io.StringIO()
        with redirect_stdout(console):
            caminho = automacao.iniciar_log_execucao("os")
            self.assertEqual(automacao.caminho_log_atual(), caminho)
            automacao.log("Oracle", "Pesquisando…")
            if corpo:
                corpo()
            self.assertEqual(automacao.finalizar_log_execucao(codigo), codigo)
        self.assertIsNone(automacao.caminho_log_atual())
        resumo = json.loads(caminho.with_suffix(".json").read_text(encoding="utf-8"))
        return console.getvalue(), caminho, resumo

    def test_log_mirrors_console_in_utf8_and_summarizes_success(self):
        def corpo():
            print("\n=== ROTINA DE OS SIMPRESS ===", flush=True)
            automacao.registrar_lote("OS_20261020")
            automacao.registrar_captura(self.pasta / "x_Oracle.png")
            self.assertEqual(
                json.loads(automacao.caminho_log_atual().with_suffix(".json").read_text(encoding="utf-8"))["status"],
                "em_andamento",
            )

        console, caminho, resumo = self._executar(0, corpo)
        self.assertRegex(caminho.name, r"^\d{8}_\d{6}_os\.log$")
        self.assertEqual(caminho.parent, self.pasta)
        texto = caminho.read_text(encoding="utf-8")
        self.assertTrue(texto.startswith(console))
        self.assertNotIn("Status:", console)
        self.assertIn("[Oracle] Pesquisando…", texto)
        self.assertIn("[Execução] Status: concluído (código 0)", texto)
        self.assertEqual(resumo["rotina"], "os")
        self.assertEqual((resumo["status"], resumo["codigo"]), ("concluido", 0))
        self.assertEqual(resumo["lotes"], ["OS_20261020"])
        self.assertEqual(resumo["capturas"], [str(self.pasta / "x_Oracle.png")])
        self.assertTrue(resumo["inicio"] and resumo["fim"])

    def test_summary_reports_failure_message(self):
        _, caminho, resumo = self._executar(1, lambda: print("\n[FALHA] Login não concluído em 10 minutos.", flush=True))
        self.assertEqual((resumo["status"], resumo["codigo"]), ("falha", 1))
        self.assertEqual(resumo["mensagem"], "Login não concluído em 10 minutos.")
        self.assertIn("Status: falha (código 1): Login não concluído em 10 minutos.", caminho.read_text(encoding="utf-8"))

    def test_summary_reports_cancellation(self):
        _, caminho, resumo = self._executar(130, lambda: print("\n[CANCELADO] Rotina interrompida.", flush=True))
        self.assertEqual((resumo["status"], resumo["codigo"]), ("cancelado", 130))
        self.assertIn("Status: cancelado (código 130)", caminho.read_text(encoding="utf-8"))

    def test_processar_fila_output_reaches_the_log(self):
        class ProcessoFalso:
            returncode = 0
            stdout = ["Lote OS_1 processado\r\n", "Histórico atualizado\n"]

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def corpo():
            with patch.object(automacao.subprocess, "Popen", lambda *a, **k: ProcessoFalso()):
                automacao.processar_fila("process_ticket_inbox.py")

        console, caminho, _ = self._executar(0, corpo)
        self.assertIn("Lote OS_1 processado\nHistórico atualizado\n", console)
        self.assertIn("Lote OS_1 processado\nHistórico atualizado\n", caminho.read_text(encoding="utf-8"))

    def test_retention_keeps_most_recent_logs_and_screenshots(self):
        self.pasta.mkdir(parents=True)
        for indice in range(5):
            base = self.pasta / f"2026010{indice}_120000_os"
            base.with_suffix(".log").write_text("x", encoding="utf-8")
            base.with_suffix(".json").write_text("{}", encoding="utf-8")
            base.with_suffix(".png").write_bytes(b"png")
        automacao.limpar_logs_antigos(self.pasta, manter=3)
        self.assertEqual(
            sorted(p.name for p in self.pasta.glob("*.log")),
            ["20260102_120000_os.log", "20260103_120000_os.log", "20260104_120000_os.log"],
        )
        self.assertEqual(len(list(self.pasta.glob("*.json"))), 3)
        self.assertEqual(len(list(self.pasta.glob("*.png"))), 5)

    def test_retention_leaves_site_logs_alone(self):
        self.pasta.mkdir(parents=True)
        site = self.pasta / "20250101_120000_os.site.log"
        site.write_text("x", encoding="utf-8")
        for indice in range(3):
            (self.pasta / f"2026010{indice}_120000_os.log").write_text("x", encoding="utf-8")
        automacao.limpar_logs_antigos(self.pasta, manter=3)
        self.assertTrue(site.exists())
        self.assertEqual(len(list(self.pasta.glob("*.log"))), 4)

    def test_start_applies_retention_of_100_logs(self):
        self.pasta.mkdir(parents=True)
        for indice in range(105):
            (self.pasta / f"2025{indice:04d}_000000_os.log").write_text("x", encoding="utf-8")
        _, caminho, _ = self._executar(0)
        logs = sorted(p.name for p in self.pasta.glob("*.log"))
        self.assertEqual(len(logs), automacao.LOGS_MANTIDOS)
        self.assertIn(caminho.name, logs)


class PlaywrightAusenteTests(unittest.TestCase):
    def test_mensagem_traz_o_comando_exato_de_instalacao(self):
        mensagem = automacao.mensagem_playwright_ausente()
        self.assertIn("playwright", mensagem)
        self.assertIn(r".venv\Scripts\python.exe -m pip install -r requirements.txt", mensagem)

    def test_main_sai_com_codigo_3_sem_traceback_quando_falta_o_pacote(self):
        saida = io.StringIO()
        with patch.object(sys, "argv", ["automacao_rotinas_chrome.py", "--rotina", "login"]),                 patch.object(automacao, "iniciar_log_execucao"),                 patch.object(automacao, "playwright_instalado", return_value=False),                 patch.object(automacao, "executar") as executar,                 redirect_stdout(saida):
            codigo = automacao.main()
        self.assertEqual(codigo, 3)
        executar.assert_not_called()
        self.assertIn("[ERRO]", saida.getvalue())
        self.assertIn("pip install -r requirements.txt", saida.getvalue())
        self.assertNotIn("Traceback", saida.getvalue())


class DashboardDownloadDaPastaTests(unittest.TestCase):
    def test_row_name_matches_only_the_original_file(self):
        for texto in ("Dashboard Operacional_SEBRAE.xlsx", "Dashboard Operacional_SEBRAE", "dashboard operacional_sebrae.XLSX"):
            self.assertTrue(automacao._NOME_DASHBOARD_NA_LISTA.match(texto), texto)
        for texto in ("Dashboard Operacional_SEBRAE (1).xlsx", "Dashboard Operacional_SEBRAE - Cópia.xlsx", "Dashboard Operacional_SEBRAE (atualizado).xlsx"):
            self.assertFalse(automacao._NOME_DASHBOARD_NA_LISTA.match(texto), texto)

    def test_menu_labels_in_portuguese_and_english(self):
        for texto in ("Mais ações", "Mais Ações", "More actions"):
            self.assertTrue(automacao._MENU_MAIS_ACOES.search(texto), texto)
        for texto in ("Baixar", "  baixar ", "Download"):
            self.assertTrue(automacao._MENU_BAIXAR.match(texto), texto)
        for texto in ("Baixar como PDF", "Imprimir", "Duplicata"):
            self.assertFalse(automacao._MENU_BAIXAR.match(texto), texto)

    def test_downloaded_name_pattern_accepts_chrome_copies_but_not_the_site_or_zip_names(self):
        for nome in ("Dashboard Operacional_SEBRAE.xlsx", "Dashboard Operacional_SEBRAE (2).xlsx"):
            self.assertTrue(automacao._DASHBOARD_BAIXADO.fullmatch(nome), nome)
        for nome in ("Dashboard Operacional_SEBRAE (atualizado).xlsx", "Dashboard Operacional_SEBRAE.zip"):
            self.assertFalse(automacao._DASHBOARD_BAIXADO.fullmatch(nome), nome)

    def test_download_clicks_row_menu_then_download_and_returns_the_file(self):
        page = MagicMock()
        linha = page.get_by_role.return_value.filter.return_value.first
        chamado = {}

        def exportar(pagina, origem, clicar, prefixo):
            chamado["prefixo"] = prefixo
            clicar()
            return Path("Dashboard Operacional_SEBRAE.xlsx")

        with patch.object(automacao, "exportar_com_download", exportar), patch.object(automacao, "esperar_visivel", return_value=True), patch.object(automacao, "log"):
            arquivo = automacao.baixar_dashboard_da_pasta(page)

        self.assertEqual(arquivo, Path("Dashboard Operacional_SEBRAE.xlsx"))
        self.assertIs(chamado["prefixo"], automacao._DASHBOARD_BAIXADO)
        linha.hover.assert_called_once()
        self.assertIs(linha.get_by_role.call_args.kwargs["name"], automacao._MENU_MAIS_ACOES)
        self.assertEqual(linha.get_by_role.call_args.args, ("button",))
        self.assertIs(page.get_by_role.call_args_list[-1].kwargs["name"], automacao._MENU_BAIXAR)
        page.get_by_role.return_value.first.click.assert_called_once()

    def test_download_rejects_a_zip(self):
        with patch.object(automacao, "exportar_com_download", return_value=Path("pasta.zip")), patch.object(automacao, "esperar_visivel", return_value=True):
            with self.assertRaisesRegex(automacao.RotinaErro, "não um .xlsx"):
                automacao.baixar_dashboard_da_pasta(MagicMock())

    def test_download_fails_clearly_when_the_file_is_not_in_the_folder(self):
        with patch.object(automacao, "esperar_visivel", return_value=False):
            with self.assertRaisesRegex(automacao.RotinaErro, "Não achei"):
                automacao.baixar_dashboard_da_pasta(MagicMock())

    def test_export_for_dashboard_routine_retries_a_bad_download_then_succeeds(self):
        # Mesmo padrão da rotina enviar: nada irreversível acontece aqui, então um RotinaErro
        # (ex.: extensão errada por download desincronizado) refaz em vez de abortar de primeira.
        page = MagicMock()
        tentativas = [automacao.RotinaErro("não é um .xlsx"), Path("Dashboard Operacional_SEBRAE.xlsx")]

        def _baixar(pagina):
            efeito = tentativas.pop(0)
            if isinstance(efeito, Exception):
                raise efeito
            return efeito

        with patch.object(automacao, "nova_aba", return_value=page), patch.object(automacao, "aguardar_login"), \
                patch.object(automacao, "definir_pagina_ativa_para_recuperacao"), \
                patch.object(automacao, "baixar_dashboard_da_pasta", side_effect=_baixar), \
                patch.object(automacao, "registrar_erro"), patch.object(automacao.time, "sleep"):
            arquivo = automacao.exportar_dashboard_sebrae(MagicMock())
        self.assertEqual(arquivo, Path("Dashboard Operacional_SEBRAE.xlsx"))
        self.assertEqual(tentativas, [])


class EnviarDashboardTests(unittest.TestCase):
    def _pagina(self, botoes):
        """Página simulada cujo diálogo de nome repetido oferece só os botões de ``botoes``."""
        page = MagicMock()
        locators = {}

        def get_by_role(role, name=None):
            if role == "button" and name in (automacao._BOTAO_SUBSTITUIR, automacao._BOTAO_MANTER_AMBOS):
                chave = "substituir" if name is automacao._BOTAO_SUBSTITUIR else "manter"
                locators.setdefault(chave, MagicMock()).count.return_value = 1 if chave in botoes else 0
                return locators[chave]
            return MagicMock()

        page.get_by_role.side_effect = get_by_role
        page.locators = locators
        return page

    def _enviar(self, page, concluido=True, em_uso=False, conflito=False, botao=None):
        """Roda o envio com os avisos de conclusão, de arquivo em uso e de conflito (Save Conflict) simulados."""
        avisos = {}
        page.get_by_text.side_effect = lambda padrao, *_a, **_k: avisos.setdefault(padrao, MagicMock())
        aviso = page.get_by_text(automacao._AVISO_ENVIO_CONCLUIDO).first
        aviso_conflito = page.get_by_text(automacao._AVISO_CONFLITO).first

        def visivel(loc):
            if loc is aviso:
                return concluido
            return conflito if loc is aviso_conflito else em_uso

        with tempfile.TemporaryDirectory() as pasta:
            arquivo = Path(pasta) / "Dashboard Operacional_SEBRAE.xlsx"
            arquivo.write_bytes(b"x")
            with patch.object(automacao, "esperar_visivel", return_value=True), \
                    patch.object(automacao, "visivel", side_effect=visivel), \
                    patch.object(automacao, "verificar_cancelamento"), patch.object(automacao, "log"), \
                    patch.object(automacao, "_botao_enviar", return_value=botao or MagicMock()), \
                    patch.object(automacao, "obter_posicao_cursor", return_value=(0, 0)), \
                    patch.object(automacao.time, "sleep"):
                automacao.enviar_arquivo_para_pasta(page, arquivo)

    def test_menu_and_dialog_labels_in_portuguese_and_english(self):
        for texto in ("Duplicata", "Duplicate", " duplicata "):
            self.assertTrue(automacao._MENU_DUPLICATA.match(texto), texto)
        for texto in ("Baixar", "Duplicar para outra pasta"):
            self.assertFalse(automacao._MENU_DUPLICATA.match(texto), texto)
        for texto in ("Replace", "Substituir"):
            self.assertTrue(automacao._BOTAO_SUBSTITUIR.match(texto), texto)
        for texto in ("Keep both", "Manter ambos"):
            self.assertTrue(automacao._BOTAO_MANTER_AMBOS.match(texto), texto)
            self.assertFalse(automacao._BOTAO_SUBSTITUIR.match(texto), texto)

    def test_upload_clicks_replace_and_never_keep_both(self):
        page = self._pagina({"substituir", "manter"})
        self._enviar(page)
        page.locators["substituir"].first.click.assert_called_once()
        page.locators["manter"].first.click.assert_not_called()

    def test_upload_menu_retried_once_then_clicks_replace_exactly_once(self):
        page = self._pagina({"substituir"})
        botao = MagicMock()
        botao.click.side_effect = [RuntimeError("DOM desatualizado"), None]
        self._enviar(page, botao=botao)
        self.assertEqual(botao.click.call_count, 2)
        page.locators["substituir"].first.click.assert_called_once()

    def test_upload_refuses_when_only_keep_both_is_offered(self):
        page = self._pagina({"manter"})
        with self.assertRaisesRegex(automacao.RotinaErro, "Keep both"):
            self._enviar(page)
        page.locators["manter"].first.click.assert_not_called()

    def test_upload_fails_clearly_when_the_dashboard_is_in_use(self):
        page = self._pagina({"substituir"})
        with self.assertRaisesRegex(automacao.RotinaErro, "em uso ou bloqueado"):
            self._enviar(page, concluido=False, em_uso=True)

    def test_upload_stops_on_save_conflict_without_retrying(self):
        # 08/11/2026: "Save Conflict" do SharePoint; Replace clicado uma vez e nada repetido ("Retry" nunca).
        page = self._pagina({"substituir"})
        with patch.object(automacao.time, "time", side_effect=[0, 1, 2, 3, 4, 5]):
            with self.assertRaises(automacao.RotinaErro) as erro:
                self._enviar(page, concluido=False, conflito=True)
        self.assertEqual(str(erro.exception), automacao.MSG_CONFLITO_SHAREPOINT)
        page.locators["substituir"].first.click.assert_called_once()
        nomes = [c.kwargs.get("name") for c in page.get_by_role.call_args_list]
        self.assertFalse(any(isinstance(n, str) and "retry" in n.lower() for n in nomes))

    def test_conflict_and_copy_notices_match_sharepoint_texts(self):
        texto = "Save Conflict: Your changes conflict with those made concurrently by another user."
        self.assertTrue(automacao._AVISO_CONFLITO.search(texto))
        self.assertFalse(automacao._AVISO_CONFLITO.search("Dashboard Operacional_SEBRAE.xlsx"))
        for aviso in ("Copied 1 item", "Copied 2 items", "1 item copiado", "Copiado 1 item"):
            self.assertTrue(automacao._AVISO_COPIA_CONCLUIDA.search(aviso), aviso)
            self.assertFalse(automacao._AVISO_COPIANDO.search(aviso), aviso)
        for aviso in ("Copying 1 item", "Copying 2 items", "Copiando 1 item"):
            self.assertTrue(automacao._AVISO_COPIANDO.search(aviso), aviso)
            self.assertFalse(automacao._AVISO_COPIA_CONCLUIDA.search(aviso), aviso)
        self.assertFalse(automacao._AVISO_COPIA_CONCLUIDA.search("Dashboard Operacional_SEBRAE Copiar.xlsx"))

    def test_upload_fails_without_the_completion_notice_even_if_the_row_text_changes(self):
        # O texto da linha ("há 4 minutos" -> "há 5 minutos") muda sozinho; só o aviso de conclusão vale.
        page = self._pagina({"substituir"})
        textos = iter(f"há {n} minutos" for n in range(1000))
        with patch.object(automacao, "_localizar_linha_do_dashboard") as linha, \
                patch.object(automacao.time, "time", side_effect=[0, 1, 2, 3, 500, 500]):
            linha.return_value.inner_text.side_effect = lambda **_: next(textos)
            with self.assertRaisesRegex(automacao.RotinaErro, "Não vi o aviso"):
                self._enviar(page, concluido=False)

    def test_duplicate_clicks_the_menu_and_waits_for_the_copy(self):
        page = MagicMock()
        contagens = iter([1, 1, 2])
        with patch.object(automacao, "_linha_do_dashboard"), patch.object(automacao, "_abrir_mais_acoes") as abrir, \
                patch.object(automacao, "_quantos_dashboards_na_lista", side_effect=lambda _p: next(contagens)), \
                patch.object(automacao, "_copias_na_lista", return_value=0), patch.object(automacao, "visivel", return_value=True), \
                patch.object(automacao, "obter_posicao_cursor", return_value=(0, 0)), patch.object(automacao.time, "sleep"), \
                patch.object(automacao, "verificar_cancelamento"), patch.object(automacao, "log"):
            automacao.duplicar_dashboard_na_pasta(page)
        abrir.assert_called_once()
        self.assertIs(page.get_by_role.call_args.kwargs["name"], automacao._MENU_DUPLICATA)
        page.get_by_role.return_value.first.click.assert_called_once()

    def _duplicar_com_aviso(self, avisos, tempo=None, contagens=None, copiando=()):
        """Duplicata com "Copied 1 item" seguindo ``avisos`` e "Copying 1 item" seguindo ``copiando`` (True/False por leitura)."""
        page = MagicMock()
        contagens = iter(contagens if contagens is not None else [1] + [2] * 1000)
        leituras = {automacao._AVISO_COPIA_CONCLUIDA: iter(avisos), automacao._AVISO_COPIANDO: iter(copiando)}

        def visivel(_loc):
            return next(leituras[page.get_by_text.call_args.args[0]], False)

        relogio = patch.object(automacao.time, "time", side_effect=tempo) if tempo is not None else contextlib.nullcontext()
        with patch.object(automacao, "_linha_do_dashboard"), patch.object(automacao, "_abrir_mais_acoes"), \
                patch.object(automacao, "_quantos_dashboards_na_lista", side_effect=lambda _p: next(contagens)), \
                patch.object(automacao, "_copias_na_lista", return_value=0), \
                patch.object(automacao, "visivel", side_effect=visivel), \
                patch.object(automacao, "obter_posicao_cursor", return_value=(0, 0)), patch.object(automacao.time, "sleep"), \
                patch.object(automacao, "verificar_cancelamento"), patch.object(automacao, "log") as log, relogio:
            automacao.duplicar_dashboard_na_pasta(page)
        return page, "\n".join(str(c.args[1]) for c in log.call_args_list)

    def test_duplicate_waits_for_the_copied_notice_before_returning(self):
        # A linha da cópia aparece antes de o SharePoint terminar de copiar; o Replace só vem depois de "Copied 1 item".
        page, textos = self._duplicar_com_aviso([False, False, True])
        self.assertGreaterEqual(page.wait_for_timeout.call_count, 2)
        page.get_by_role.return_value.first.click.assert_called_once()
        self.assertIn("Cópia de segurança criada", textos)

    def test_duplicate_continues_when_the_copied_notice_never_shows(self):
        page, textos = self._duplicar_com_aviso([], tempo=itertools.count(0, 10))
        page.get_by_role.return_value.first.click.assert_called_once()  # a Duplicata nunca se repete
        self.assertIn("sem o aviso de cópia concluída", textos)

    def test_duplicate_keeps_waiting_while_sharepoint_shows_copying(self):
        # Teste real de 08/11/2026: "Copying 1 item" por mais de 30 s e a linha da cópia só no fim; não é falha.
        n = 60
        page, textos = self._duplicar_com_aviso(
            [False] * n + [True], tempo=itertools.count(0, 1), contagens=[1] * (n + 1) + [2] * 10, copiando=[True] * n,
        )
        page.get_by_role.return_value.first.click.assert_called_once()
        self.assertIn("Cópia de segurança criada", textos)

    def test_duplicate_stops_when_the_copy_is_still_running_at_the_deadline(self):
        with self.assertRaisesRegex(automacao.RotinaErro, "ainda estava em andamento"):
            self._duplicar_com_aviso([], tempo=itertools.count(0, 10), contagens=[1] * 1000, copiando=[True] * 1000)

    def _logs_da_duplicata(self, copias: int) -> str:
        contagens = iter([copias + 1, copias + 2])  # original + cópias, depois a nova
        with patch.object(automacao, "_linha_do_dashboard"), patch.object(automacao, "_abrir_mais_acoes"), \
                patch.object(automacao, "_quantos_dashboards_na_lista", side_effect=lambda _p: next(contagens)), \
                patch.object(automacao, "_copias_na_lista", return_value=copias), patch.object(automacao, "visivel", return_value=True), \
                patch.object(automacao, "obter_posicao_cursor", return_value=(0, 0)), patch.object(automacao.time, "sleep"), \
                patch.object(automacao, "verificar_cancelamento"), patch.object(automacao, "log") as log:
            automacao.duplicar_dashboard_na_pasta(MagicMock())
        return "\n".join(str(c.args[1]) for c in log.call_args_list)

    def test_duplicate_warns_when_there_are_more_than_five_copies(self):
        textos = self._logs_da_duplicata(6)
        self.assertIn("apague as antigas à mão", textos)
        self.assertIn("6 cópias", textos)

    def test_duplicate_does_not_warn_with_few_copies(self):
        textos = self._logs_da_duplicata(2)
        self.assertNotIn("apague", textos)

    def test_copy_pattern_counts_only_copies_of_the_dashboard(self):
        casos = {
            "Dashboard Operacional_SEBRAE Copiar.xlsx": True,
            "Dashboard Operacional_SEBRAE Copiar (1).xlsx": True,
            "Dashboard Operacional_SEBRAE - Cópia.xlsx": True,
            "Dashboard Operacional_SEBRAE (1).xlsx": True,
            "Dashboard Operacional_SEBRAE.xlsx Há alguns segundos 120 KB (1)": False,
            "Dashboard Operacional_SEBRAE.xlsx": False,
            "Dashboard Operacional_SEBRAE_teste.xlsx": False,
            "Dashboard Operacional_SEBRAE (atualizado).xlsx": False,
        }
        for nome, esperado in casos.items():
            self.assertEqual(bool(automacao._COPIA_DO_DASHBOARD.search(nome)), esperado, nome)

    def test_duplicate_stops_without_overwriting_when_the_copy_does_not_appear(self):
        page = MagicMock()
        with patch.object(automacao, "_linha_do_dashboard"), patch.object(automacao, "_abrir_mais_acoes"), \
                patch.object(automacao, "_quantos_dashboards_na_lista", return_value=1), \
                patch.object(automacao, "_copias_na_lista", return_value=0), \
                patch.object(automacao.time, "time", side_effect=[0, 1, 99, 99]), \
                patch.object(automacao, "obter_posicao_cursor", return_value=(0, 0)), patch.object(automacao.time, "sleep"), \
                patch.object(automacao, "verificar_cancelamento"), patch.object(automacao, "log"):
            with self.assertRaisesRegex(automacao.RotinaErro, "não substituí"):
                automacao.duplicar_dashboard_na_pasta(page)

    def _estado(self, pasta: Path, conteudo: bytes, planilha: "bytes | None" = None):
        from domains import sebrae_novos

        caminhos = sebrae_novos.caminhos_padrao(pasta)
        sha = sebrae_novos.salvar_planilha(sebrae_novos.caminho_planilha(caminhos), planilha if planilha is not None else conteudo)
        sebrae_novos.salvar_existentes(caminhos.existentes, ["1"], "Dashboard Operacional_SEBRAE.xlsx", sha256=sha)

    def test_precheck_accepts_the_file_that_was_imported(self):
        with tempfile.TemporaryDirectory() as pasta:
            baixado = Path(pasta) / "baixado.xlsx"
            baixado.write_bytes(b"igual")
            self._estado(Path(pasta), b"igual")
            with patch.object(automacao, "DASHBOARD_SAIDA_DIR", Path(pasta) / "sebrae_dashboard_saida"):
                automacao.conferir_dashboard_do_sharepoint(baixado)

    def _confere(self, baixado_bytes: bytes, importado_bytes: bytes):
        with tempfile.TemporaryDirectory() as pasta:
            baixado = Path(pasta) / "baixado.xlsx"
            baixado.write_bytes(baixado_bytes)
            self._estado(Path(pasta), importado_bytes)
            with patch.object(automacao, "DASHBOARD_SAIDA_DIR", Path(pasta) / "sebrae_dashboard_saida"):
                automacao.conferir_dashboard_do_sharepoint(baixado)

    @staticmethod
    def _dashboard(trocas=(), regravado=False) -> bytes:
        """Dashboard de teste; ``trocas`` são (antes, depois) aplicados na aba; ``regravado`` muda só estilo e ordem do zip."""
        from tests import test_sebrae_dashboard_gravacao as T

        partes = T.partes_de(T.montar())
        folha = partes["xl/worksheets/sheet4.xml"].decode()
        for antes, depois in trocas:
            assert antes in folha
            folha = folha.replace(antes, depois, 1)
        if regravado:
            folha = folha.replace(' s="60"', ' s="61"')
        partes["xl/worksheets/sheet4.xml"] = folha.encode()
        saida = io.BytesIO()
        with zipfile.ZipFile(saida, "w", zipfile.ZIP_STORED) as arquivo:
            for nome in (reversed(list(partes)) if regravado else partes):
                arquivo.writestr(nome, partes[nome])
        return saida.getvalue()

    def test_precheck_accepts_a_resaved_file_with_the_same_tickets(self):
        regravado, original = self._dashboard(regravado=True), self._dashboard()
        self.assertNotEqual(regravado, original)  # hash diferente, conteúdo igual
        self._confere(regravado, original)

    def test_precheck_aborts_when_a_colleague_edited_a_non_status_column(self):
        celula = '<c r="{}2" s="112" t="inlineStr"><is><t>INCIDENTE</t></is></c>'
        trocas = {
            "A": ("<t>SIMPRESS</t>", "<t>OUTRO</t>"),
            "B": ('<c r="P2"', celula.format("B") + '<c r="P2"'),
            "J": ('<c r="P2"', celula.format("J") + '<c r="P2"'),
            "S": ('<c r="V2"', celula.format("S") + '<c r="V2"'),
        }
        for coluna, troca in trocas.items():
            with self.subTest(coluna=coluna), self.assertRaisesRegex(automacao.RotinaErro, "mudou depois da importação; importe de novo"):
                self._confere(self._dashboard([troca]), self._dashboard())

    def test_precheck_aborts_when_the_sharepoint_file_changed(self):
        trocas = {
            "C": ("<t>UTIC-2026-0001</t>", "<t>UTIC-2026-0009</t>"),
            "D": ("<t>EM ABERTO</t>", "<t>FINALIZADO</t>"),
            "R": ('<c r="V2"', '<c r="R2" s="92"><v>46001.5</v></c><c r="V2"'),
        }
        for coluna, troca in trocas.items():
            with self.subTest(coluna=coluna), self.assertRaisesRegex(automacao.RotinaErro, "mudou depois da importação; importe de novo"):
                self._confere(self._dashboard([troca]), self._dashboard())

    def test_precheck_aborts_when_the_stored_copy_is_missing(self):
        with tempfile.TemporaryDirectory() as pasta:
            baixado = Path(pasta) / "baixado.xlsx"
            baixado.write_bytes(b"outro")
            self._estado(Path(pasta), b"original")
            (Path(pasta) / "sebrae_dashboard_importado.xlsx").unlink()
            with patch.object(automacao, "DASHBOARD_SAIDA_DIR", Path(pasta) / "sebrae_dashboard_saida"):
                with self.assertRaisesRegex(automacao.RotinaErro, "importe de novo"):
                    automacao.conferir_dashboard_do_sharepoint(baixado)

    def test_precheck_aborts_when_nothing_was_imported(self):
        with tempfile.TemporaryDirectory() as pasta:
            baixado = Path(pasta) / "baixado.xlsx"
            baixado.write_bytes(b"x")
            with patch.object(automacao, "DASHBOARD_SAIDA_DIR", Path(pasta) / "sebrae_dashboard_saida"):
                with self.assertRaisesRegex(automacao.RotinaErro, "não tem um Dashboard importado"):
                    automacao.conferir_dashboard_do_sharepoint(baixado)

    def test_backup_copies_the_downloaded_file_and_keeps_only_the_newest_twenty(self):
        with tempfile.TemporaryDirectory() as pasta:
            pasta = Path(pasta)
            baixado = pasta / "baixado.xlsx"
            baixado.write_bytes(b"conteudo")
            backups = pasta / "sebrae_backups"
            backups.mkdir()
            for i in range(25):
                (backups / f"Dashboard Operacional_SEBRAE_20200101_0000{i:02d}.xlsx").write_bytes(b"velho")
            (backups / "outro.xlsx").write_bytes(b"nao mexer")
            with patch.object(automacao, "DASHBOARD_BACKUPS_DIR", backups), patch.object(automacao, "log"):
                novo = automacao.guardar_backup_do_dashboard(baixado)
            self.assertEqual(novo.read_bytes(), b"conteudo")
            self.assertEqual(baixado.read_bytes(), b"conteudo")
            guardados = sorted(p.name for p in backups.glob("Dashboard Operacional_SEBRAE_*.xlsx"))
            self.assertEqual(len(guardados), automacao.DASHBOARD_BACKUPS_MAX)
            self.assertIn(novo.name, guardados)
            self.assertNotIn("Dashboard Operacional_SEBRAE_20200101_000000.xlsx", guardados)
            self.assertTrue((backups / "outro.xlsx").exists())

    def test_routine_runs_duplicate_then_download_then_precheck_then_backup_then_upload(self):
        ordem = []
        page = MagicMock()
        context = MagicMock()
        with tempfile.TemporaryDirectory() as pasta:
            arquivo = Path(pasta) / "Dashboard Operacional_SEBRAE.xlsx"
            baixado = Path(pasta) / "baixado.xlsx"
            arquivo.write_bytes(b"x")
            with patch.object(automacao, "arquivo_final_dashboard", return_value=arquivo), patch.object(automacao, "nova_aba", return_value=page), \
                    patch.object(automacao, "DASHBOARD_SAIDA_DIR", Path(pasta) / "sebrae_dashboard_saida"), \
                    patch.object(automacao, "aguardar_login"), patch.object(automacao, "verificar_cancelamento"), \
                    patch.object(automacao, "duplicar_dashboard_na_pasta", side_effect=lambda p: ordem.append("duplicata")), \
                    patch.object(automacao, "baixar_dashboard_da_pasta", side_effect=lambda p: ordem.append("baixar") or baixado), \
                    patch.object(automacao, "conferir_dashboard_do_sharepoint", side_effect=lambda b: ordem.append("conferir")), \
                    patch.object(automacao, "guardar_backup_do_dashboard", side_effect=lambda b: ordem.append("backup")), \
                    patch.object(automacao, "enviar_arquivo_para_pasta", side_effect=lambda p, a: ordem.append("enviar")), \
                    redirect_stdout(io.StringIO()):
                codigo = automacao.rodar_rotina_enviar(context)
        self.assertEqual(codigo, 0)
        self.assertEqual(ordem, ["duplicata", "baixar", "conferir", "backup", "enviar"])

    def test_a_post_click_failure_in_duplicate_is_not_retried_and_never_reclicks(self):
        # Mesmo cenário do incidente real: interferência do mouse desincroniza a página depois do
        # clique em Duplicata. O erro (genérico, não RotinaErro) deve propagar sem nova tentativa:
        # envolver duplicar_dashboard_na_pasta inteira num retry repetiria o clique que cria a cópia.
        with tempfile.TemporaryDirectory() as pasta:
            arquivo = Path(pasta) / "Dashboard Operacional_SEBRAE.xlsx"
            arquivo.write_bytes(b"x")
            with patch.object(automacao, "arquivo_final_dashboard", return_value=arquivo), patch.object(automacao, "nova_aba"), \
                    patch.object(automacao, "DASHBOARD_SAIDA_DIR", Path(pasta) / "sebrae_dashboard_saida"), \
                    patch.object(automacao, "aguardar_login"), patch.object(automacao, "verificar_cancelamento"), \
                    patch.object(automacao, "duplicar_dashboard_na_pasta", side_effect=RuntimeError("DOM desincronizado")) as duplicar, \
                    patch.object(automacao, "baixar_dashboard_da_pasta") as baixar, \
                    patch.object(automacao, "registrar_erro"), redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(RuntimeError, "DOM desincronizado"):
                    automacao.rodar_rotina_enviar(MagicMock())
            duplicar.assert_called_once()
            baixar.assert_not_called()

    def test_routine_does_not_upload_when_the_precheck_fails(self):
        # Mudança real no SharePoint: a conferência reprova em toda tentativa (mesmo mock reaplicado
        # pelo etapa_resiliente), então a mensagem original chega ao usuário do mesmo jeito.
        with tempfile.TemporaryDirectory() as pasta:
            with patch.object(automacao, "arquivo_final_dashboard", return_value=Path(pasta) / "x.xlsx"), patch.object(automacao, "nova_aba"), \
                    patch.object(automacao, "DASHBOARD_SAIDA_DIR", Path(pasta) / "sebrae_dashboard_saida"), \
                    patch.object(automacao, "aguardar_login"), patch.object(automacao, "verificar_cancelamento"), \
                    patch.object(automacao, "duplicar_dashboard_na_pasta"), patch.object(automacao, "baixar_dashboard_da_pasta"), \
                    patch.object(automacao, "conferir_dashboard_do_sharepoint", side_effect=automacao.RotinaErro(automacao.MSG_SHAREPOINT_MUDOU)), \
                    patch.object(automacao, "guardar_backup_do_dashboard") as backup, patch.object(automacao, "enviar_arquivo_para_pasta") as enviar, \
                    patch.object(automacao, "registrar_erro"), patch.object(automacao.time, "sleep"), redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(automacao.RotinaErro, "importe de novo"):
                    automacao.rodar_rotina_enviar(MagicMock())
        backup.assert_not_called()
        enviar.assert_not_called()

    def test_routine_retries_download_and_precheck_together_after_mouse_interference_then_succeeds(self):
        # Cenário do incidente real: a 1a tentativa de baixar+conferir falha (download/leitura
        # desincronizados pelo clique do mouse), a 2a tentativa baixa e confere de novo do zero e
        # tem sucesso — sem repetir Duplicata e sem abortar com a mensagem de "mudou".
        ordem = []
        baixados = [RuntimeError("leitura desincronizada"), None]

        def _baixar(pagina):
            efeito = baixados.pop(0)
            ordem.append("baixar")
            if efeito is not None:
                raise efeito
            return Path("baixado.xlsx")

        with tempfile.TemporaryDirectory() as pasta:
            arquivo = Path(pasta) / "Dashboard Operacional_SEBRAE.xlsx"
            arquivo.write_bytes(b"x")
            with patch.object(automacao, "arquivo_final_dashboard", return_value=arquivo), patch.object(automacao, "nova_aba"), \
                    patch.object(automacao, "DASHBOARD_SAIDA_DIR", Path(pasta) / "sebrae_dashboard_saida"), \
                    patch.object(automacao, "aguardar_login"), patch.object(automacao, "verificar_cancelamento"), \
                    patch.object(automacao, "duplicar_dashboard_na_pasta", side_effect=lambda p: ordem.append("duplicata")) as duplicar, \
                    patch.object(automacao, "baixar_dashboard_da_pasta", side_effect=_baixar), \
                    patch.object(automacao, "conferir_dashboard_do_sharepoint", side_effect=lambda b: ordem.append("conferir")), \
                    patch.object(automacao, "guardar_backup_do_dashboard", side_effect=lambda b: ordem.append("backup")), \
                    patch.object(automacao, "enviar_arquivo_para_pasta", side_effect=lambda p, a: ordem.append("enviar")), \
                    patch.object(automacao.time, "sleep"), redirect_stdout(io.StringIO()):
                codigo = automacao.rodar_rotina_enviar(MagicMock())
        self.assertEqual(codigo, 0)
        duplicar.assert_called_once()
        self.assertEqual(ordem, ["duplicata", "baixar", "baixar", "conferir", "backup", "enviar"])

    def test_precheck_accepts_the_hash_of_the_last_upload_but_not_an_unknown_changed_file(self):
        import hashlib

        from domains import sebrae_finalizacao

        mudado = self._dashboard([("<t>UTIC-2026-0001</t>", "<t>UTIC-2026-0009</t>")])
        with tempfile.TemporaryDirectory() as pasta:
            baixado = Path(pasta) / "baixado.xlsx"
            baixado.write_bytes(mudado)
            self._estado(Path(pasta), self._dashboard())
            with patch.object(automacao, "DASHBOARD_SAIDA_DIR", Path(pasta) / "sebrae_dashboard_saida"):
                with self.assertRaisesRegex(automacao.RotinaErro, "mudou depois da importação"):
                    automacao.conferir_dashboard_do_sharepoint(baixado)
                sebrae_finalizacao.gravar_enviado(Path(pasta), hashlib.sha256(b"outro arquivo").hexdigest())
                with self.assertRaisesRegex(automacao.RotinaErro, "mudou depois da importação"):
                    automacao.conferir_dashboard_do_sharepoint(baixado)
                sebrae_finalizacao.gravar_enviado(Path(pasta), hashlib.sha256(mudado).hexdigest())
                automacao.conferir_dashboard_do_sharepoint(baixado)

    def test_precheck_accepts_the_sharepoint_resave_of_the_last_upload(self):
        from domains import sebrae_finalizacao

        enviado = self._dashboard([("<t>UTIC-2026-0001</t>", "<t>UTIC-2026-0009</t>")])
        resalvo = self._dashboard([("<t>UTIC-2026-0001</t>", "<t>UTIC-2026-0009</t>")], regravado=True)
        self.assertNotEqual(enviado, resalvo)  # o SharePoint reserializa: hash novo, valores iguais ao que subiu
        with tempfile.TemporaryDirectory() as pasta:
            baixado = Path(pasta) / "baixado.xlsx"
            baixado.write_bytes(resalvo)
            self._estado(Path(pasta), self._dashboard())  # importado: antes do envio, valores diferentes
            with patch.object(automacao, "DASHBOARD_SAIDA_DIR", Path(pasta) / "sebrae_dashboard_saida"):
                with self.assertRaisesRegex(automacao.RotinaErro, "mudou depois da importação"):
                    automacao.conferir_dashboard_do_sharepoint(baixado)
                sebrae_finalizacao.gravar_enviado(Path(pasta), "0" * 64, enviado)  # hash e cópia não batem: cópia ignorada
                with self.assertRaisesRegex(automacao.RotinaErro, "mudou depois da importação"):
                    automacao.conferir_dashboard_do_sharepoint(baixado)
                import hashlib

                sebrae_finalizacao.gravar_enviado(Path(pasta), hashlib.sha256(enviado).hexdigest(), enviado)
                automacao.conferir_dashboard_do_sharepoint(baixado)

    # Edição manual no SharePoint entre "Atualizar Dashboard" e "Enviar ao SharePoint": a mensagem diz o que mudou
    # (só números de linha) e a rotina não repete em vão uma divergência que é real.

    @staticmethod
    def _edicao():
        from tests import test_sebrae_dashboard_edicao_manual as edicao

        return edicao

    def _divergencia(self, baixado: bytes, importado: bytes):
        with self.assertRaises(automacao.DashboardDivergente) as contexto:
            self._confere(baixado, importado)
        return contexto.exception

    def test_precheck_passes_when_nothing_changed_even_if_the_sharepoint_resaved_the_file(self):
        base = self._edicao().dashboard()
        regravado = self._edicao().regravar(base, lambda folha: folha.replace(' s="60"', ' s="61"'))
        self.assertNotEqual(regravado, base)
        for nome, baixado in (("mesmo arquivo", base), ("regravado", regravado)):
            with self.subTest(nome):
                self._confere(baixado, base)

    def test_precheck_says_only_the_order_changed(self):
        edicao = self._edicao()
        base = edicao.dashboard()
        baixado = edicao.reordenar(base, [5, 4, 3, 2])
        erro = self._divergencia(baixado, base)
        self.assertIsInstance(erro, automacao.RotinaErro)
        self.assertTrue(str(erro).startswith(automacao.MSG_SHAREPOINT_MUDOU))
        self.assertIn("Só a ordem das linhas mudou", str(erro))
        self.assertIn("Baixar, importar e buscar", str(erro))
        self.assertIn("Nada foi substituído no SharePoint", str(erro))
        self.assertEqual(erro.sha256, hashlib.sha256(baixado).hexdigest())

    def test_precheck_names_only_the_row_number_of_a_row_filled_by_hand_after_sorting(self):
        edicao = self._edicao()
        base = edicao.dashboard()
        mensagem = str(self._divergencia(edicao.linha_preenchida_a_mao(edicao.reordenar(base, [5, 4, 3, 2])), base))
        self.assertIn("Linhas diferentes da importação: 9.", mensagem)
        self.assertEqual(re.findall(r"\d+", mensagem), ["9"])  # nenhum número UTIC nem outro dígito
        for conteudo in (edicao.TICKET_A_MAO, edicao.TITULO_A_MAO, "UTIC", "CLIENTE", "titulo", "EM ABERTO"):
            self.assertNotIn(conteudo, mensagem)

    def test_precheck_names_the_row_edited_in_place(self):
        edicao = self._edicao()
        base = edicao.dashboard()
        mensagem = str(self._divergencia(edicao.preencher(base, 3, {"B": "REDE"}), base))
        self.assertIn("Linhas diferentes da importação: 3.", mensagem)
        self.assertNotIn("REDE", mensagem)

    def test_precheck_lists_five_rows_and_counts_the_rest(self):
        edicao = self._edicao()
        base = edicao.dashboard(ultima=14)
        baixado = base
        for linha in range(6, 13):
            baixado = edicao.preencher(baixado, linha, {"A": "CLIENTE", "C": f"UTIC-2026-08{linha:02d}", "D": "EM ABERTO"})
        mensagem = str(self._divergencia(baixado, base))
        self.assertIn("Linhas diferentes da importação: 6, 7, 8, 9, 10 (+2).", mensagem)
        self.assertEqual(re.findall(r"\d+", mensagem), ["6", "7", "8", "9", "10", "2"])
        self.assertNotIn("UTIC", mensagem)

    def test_precheck_explains_by_the_closest_reference_when_the_sent_copy_is_older_than_the_imported_one(self):
        from domains import sebrae_finalizacao

        edicao = self._edicao()
        importada = edicao.dashboard()
        enviada = importada
        for linha in (2, 3, 4):  # cópia enviada em 06/11: três linhas já diferem da importada em 08/11
            enviada = edicao.preencher(enviada, linha, {"B": "REDE"})
        baixado = edicao.preencher(importada, 5, {"B": "SOFTWARE"})  # importada + uma linha editada à mão
        with tempfile.TemporaryDirectory() as pasta:
            arquivo = Path(pasta) / "baixado.xlsx"
            arquivo.write_bytes(baixado)
            self._estado(Path(pasta), importada)
            sebrae_finalizacao.gravar_enviado(Path(pasta), hashlib.sha256(enviada).hexdigest(), enviada)
            self.assertEqual(sebrae_finalizacao.ler_copia_enviada(Path(pasta)), enviada)  # a cópia enviada entra mesmo na conferência
            with patch.object(automacao, "DASHBOARD_SAIDA_DIR", Path(pasta) / "sebrae_dashboard_saida"):
                with self.assertRaises(automacao.DashboardDivergente) as contexto:
                    automacao.conferir_dashboard_do_sharepoint(arquivo)
        mensagem = str(contexto.exception)
        self.assertIn("Linhas diferentes da importação: 5.", mensagem)  # só a editada; pela enviada seriam 2, 3, 4 e 5
        self.assertEqual(re.findall(r"\d+", mensagem), ["5"])
        self.assertNotIn("SOFTWARE", mensagem)

    def test_divergence_reason_uses_the_closest_of_several_references(self):
        baixado = {2: ("a",), 3: ("b",), 4: ("c",)}
        distante = {2: ("x",), 3: ("y",), 4: ("z",)}
        proxima = {2: ("a",), 3: ("b",), 4: ("d",)}
        for referencias in ([distante, proxima], [proxima, distante]):
            with self.subTest(ordem=[referencias.index(proxima)]):
                self.assertEqual(automacao._motivo_da_divergencia(baixado, referencias), "Linhas diferentes da importação: 4.")
        self.assertEqual(automacao._motivo_da_divergencia(baixado, [distante]), "Linhas diferentes da importação: 2, 3, 4.")
        reordenada = {2: ("c",), 3: ("a",), 4: ("b",)}
        self.assertEqual(automacao._motivo_da_divergencia(baixado, [distante, reordenada]), "Só a ordem das linhas mudou (filtro/ordenação no Excel).")

    def _rodar_baixar_e_conferir(self, conferir, baixar=None):
        """Roda a rotina enviar com download e conferência simulados; devolve (código ou exceção, mocks)."""
        with tempfile.TemporaryDirectory() as pasta:
            arquivo = Path(pasta) / "Dashboard Operacional_SEBRAE.xlsx"
            arquivo.write_bytes(b"x")
            with patch.object(automacao, "arquivo_final_dashboard", return_value=arquivo), patch.object(automacao, "nova_aba"), \
                    patch.object(automacao, "DASHBOARD_SAIDA_DIR", Path(pasta) / "sebrae_dashboard_saida"), \
                    patch.object(automacao, "aguardar_login"), patch.object(automacao, "verificar_cancelamento"), \
                    patch.object(automacao, "duplicar_dashboard_na_pasta") as duplicar, \
                    patch.object(automacao, "baixar_dashboard_da_pasta", side_effect=baixar or (lambda p: Path("baixado.xlsx"))) as baixar_mock, \
                    patch.object(automacao, "conferir_dashboard_do_sharepoint", side_effect=conferir) as conferir_mock, \
                    patch.object(automacao, "guardar_backup_do_dashboard") as backup, \
                    patch.object(automacao, "enviar_arquivo_para_pasta") as enviar, \
                    patch.object(automacao, "registrar_erro"), patch.object(automacao.time, "sleep"), redirect_stdout(io.StringIO()):
                try:
                    resultado = automacao.rodar_rotina_enviar(MagicMock())
                except Exception as erro:
                    resultado = erro
        return resultado, {"duplicar": duplicar, "baixar": baixar_mock, "conferir": conferir_mock, "backup": backup, "enviar": enviar}

    def test_routine_stops_at_the_second_attempt_when_the_same_divergence_repeats(self):
        mensagem = automacao.MSG_SHAREPOINT_MUDOU + " Linhas diferentes da importação: 9."
        resultado, mocks = self._rodar_baixar_e_conferir(automacao.DashboardDivergente(mensagem, "a" * 64))
        self.assertIs(type(resultado), automacao.RotinaErro)  # terminal: não é EtapaInstavel, então não há 3ª tentativa
        self.assertEqual(str(resultado), mensagem)
        self.assertEqual(mocks["conferir"].call_count, 2)
        self.assertEqual(mocks["baixar"].call_count, 2)
        mocks["duplicar"].assert_called_once()  # nenhuma Duplicata extra
        mocks["backup"].assert_not_called()
        mocks["enviar"].assert_not_called()  # nenhum Replace

    def test_routine_keeps_trying_when_each_download_diverges_differently(self):
        divergencias = [automacao.DashboardDivergente(automacao.MSG_SHAREPOINT_MUDOU, letra * 64) for letra in "abc"]
        resultado, mocks = self._rodar_baixar_e_conferir(divergencias)
        self.assertIsInstance(resultado, automacao.EtapaInstavel)
        self.assertIn("mudou depois da importação", str(resultado))
        self.assertEqual(mocks["conferir"].call_count, 3)
        mocks["duplicar"].assert_called_once()
        mocks["enviar"].assert_not_called()

    def test_routine_goes_on_when_a_divergence_does_not_repeat(self):
        resultado, mocks = self._rodar_baixar_e_conferir([automacao.DashboardDivergente(automacao.MSG_SHAREPOINT_MUDOU, "a" * 64), None])
        self.assertEqual(resultado, 0)
        self.assertEqual(mocks["conferir"].call_count, 2)
        mocks["duplicar"].assert_called_once()
        mocks["backup"].assert_called_once()
        mocks["enviar"].assert_called_once()

    def test_routine_tries_three_times_on_a_common_transient_error(self):
        resultado, mocks = self._rodar_baixar_e_conferir(RuntimeError("falha transitória"))
        self.assertIsInstance(resultado, automacao.EtapaInstavel)
        self.assertIn("falha transitória", str(resultado))
        self.assertEqual(mocks["conferir"].call_count, 3)
        self.assertEqual(mocks["baixar"].call_count, 3)
        mocks["duplicar"].assert_called_once()
        mocks["enviar"].assert_not_called()

    def test_routine_downloads_again_after_a_corrupted_file_and_passes_the_real_precheck(self):
        base = self._edicao().dashboard()
        baixados = [b"isto nao e um xlsx", base]
        with tempfile.TemporaryDirectory() as pasta:
            self._estado(Path(pasta), base)
            arquivo = Path(pasta) / "Dashboard Operacional_SEBRAE.xlsx"
            arquivo.write_bytes(b"x")

            def _baixar(pagina):
                destino = Path(pasta) / f"baixado{len(baixados)}.xlsx"
                destino.write_bytes(baixados.pop(0))
                return destino

            with patch.object(automacao, "arquivo_final_dashboard", return_value=arquivo), patch.object(automacao, "nova_aba"), \
                    patch.object(automacao, "DASHBOARD_SAIDA_DIR", Path(pasta) / "sebrae_dashboard_saida"), \
                    patch.object(automacao, "aguardar_login"), patch.object(automacao, "verificar_cancelamento"), \
                    patch.object(automacao, "duplicar_dashboard_na_pasta") as duplicar, \
                    patch.object(automacao, "baixar_dashboard_da_pasta", side_effect=_baixar), \
                    patch.object(automacao, "guardar_backup_do_dashboard"), patch.object(automacao, "enviar_arquivo_para_pasta") as enviar, \
                    patch.object(automacao, "registrar_erro"), patch.object(automacao.time, "sleep"), redirect_stdout(io.StringIO()):
                codigo = automacao.rodar_rotina_enviar(MagicMock())
        self.assertEqual(codigo, 0)
        self.assertEqual(baixados, [])
        duplicar.assert_called_once()
        enviar.assert_called_once()

    def _rodar_enviar(self, pasta: str, falha_no_envio: bool, ao_enviar=None, falha_close=False):
        arquivo = Path(pasta) / "Dashboard Operacional_SEBRAE.xlsx"
        arquivo.write_bytes(b"conteudo novo")
        erro = ao_enviar or (automacao.RotinaErro("sem aviso") if falha_no_envio else None)
        with patch.object(automacao, "DASHBOARD_SAIDA_DIR", Path(pasta) / "sebrae_dashboard_saida"), \
                patch.object(automacao, "nova_aba", return_value=MagicMock(close=MagicMock(side_effect=OSError("close") if falha_close else None))), patch.object(automacao, "aguardar_login"), patch.object(automacao, "verificar_cancelamento"), \
                patch.object(automacao, "duplicar_dashboard_na_pasta"), patch.object(automacao, "baixar_dashboard_da_pasta"), \
                patch.object(automacao, "conferir_dashboard_do_sharepoint"), patch.object(automacao, "guardar_backup_do_dashboard"), \
                patch.object(automacao, "enviar_arquivo_para_pasta", side_effect=erro), patch.object(automacao, "registrar_erro"), \
                redirect_stdout(io.StringIO()):
            return automacao.rodar_rotina_enviar(MagicMock(), arquivo)

    def test_close_failure_after_confirmation_keeps_success_and_durable_status(self):
        from domains import sebrae_finalizacao as fin

        with tempfile.TemporaryDirectory() as pasta:
            self.assertEqual(self._rodar_enviar(pasta, False, falha_close=True), 0)
            self.assertEqual(fin.ler_envio(Path(pasta))["status"], "concluido")

    def test_independent_send_persists_cleanup_failure_and_blocks_another_upload(self):
        from domains import sebrae_finalizacao as fin

        with tempfile.TemporaryDirectory() as pasta:
            raiz = Path(pasta)
            origem = raiz / "origem.xlsx"
            origem.write_bytes(b"conteudo novo")
            copia = fin.guardar_pendente(raiz, origem, fin.agora_local(), motivo="x", tickets=[])
            chamadas = []
            with patch.object(fin, "descartar_pendente", side_effect=PermissionError("ocupado")):
                self.assertEqual(self._rodar_enviar(pasta, False, lambda *args: chamadas.append("upload")), 0)
            fin.gravar_resultado(raiz, {"sharepoint": None})
            self.assertTrue(fin.aviso_do_pendente(raiz)["limpeza_pendente"])
            with self.assertRaises(fin.DomainConflictError):
                self._rodar_enviar(pasta, False, lambda *args: chamadas.append("upload"))
            self.assertEqual(chamadas, ["upload"])
            self.assertTrue(copia.exists())

    def test_independent_send_does_not_delete_copy_created_during_upload(self):
        from domains import sebrae_finalizacao as fin

        with tempfile.TemporaryDirectory() as pasta:
            raiz = Path(pasta)
            copias = []
            def criar(page, arquivo):
                copias.append(fin.guardar_pendente(raiz, arquivo, fin.agora_local(), motivo="nova", tickets=[]))
            self.assertEqual(self._rodar_enviar(pasta, False, criar), 0)
            self.assertTrue(copias[0].exists())
            self.assertTrue(fin.aviso_do_pendente(raiz)["limpeza_pendente"])

    def test_source_changed_during_upload_stays_uncertain(self):
        from domains import sebrae_finalizacao as fin

        with tempfile.TemporaryDirectory() as pasta:
            def alterar(page, arquivo):
                arquivo.write_bytes(b"outros bytes")
            with self.assertRaises(automacao.RotinaErro):
                self._rodar_enviar(pasta, False, alterar)
            self.assertTrue(fin.aviso_do_pendente(Path(pasta))["incerto"])

    def test_confirmation_disk_failure_is_uncertain_and_cannot_be_auto_retried(self):
        from domains import sebrae_finalizacao as fin

        with tempfile.TemporaryDirectory() as pasta:
            gravar = fin.atomic_write_json
            chamadas = []
            def falhar_confirmacao(path, dados):
                if path == fin.caminho_envio(Path(pasta)) and dados.get("status") == "confirmado":
                    raise PermissionError("disco cheio")
                gravar(path, dados)
            with patch.object(fin, "atomic_write_json", side_effect=falhar_confirmacao):
                with self.assertRaises(fin.DomainBusyError):
                    self._rodar_enviar(pasta, False, lambda *args: chamadas.append("upload"))
            self.assertTrue(fin.aviso_do_pendente(Path(pasta))["incerto"])
            with self.assertRaises(fin.DomainConflictError):
                self._rodar_enviar(pasta, False, lambda *args: chamadas.append("upload"))
            self.assertEqual(chamadas, ["upload"])

    def test_routine_records_the_sha256_of_what_it_uploaded_and_nothing_on_failure(self):
        import hashlib

        from domains import sebrae_finalizacao

        with tempfile.TemporaryDirectory() as pasta:
            with self.assertRaisesRegex(automacao.RotinaErro, "sem aviso"):
                self._rodar_enviar(pasta, falha_no_envio=True)
            self.assertEqual(sebrae_finalizacao.ler_enviado(Path(pasta)), "")
            self.assertTrue(sebrae_finalizacao.aviso_do_pendente(Path(pasta))["incerto"])
            with self.assertRaises(sebrae_finalizacao.DomainConflictError):
                self._rodar_enviar(pasta, falha_no_envio=False)
        with tempfile.TemporaryDirectory() as pasta:
            self.assertEqual(self._rodar_enviar(pasta, falha_no_envio=False), 0)
            self.assertEqual(sebrae_finalizacao.ler_enviado(Path(pasta)), hashlib.sha256(b"conteudo novo").hexdigest())

    def test_routine_still_succeeds_when_recording_the_hash_fails_after_the_upload(self):
        from domains import sebrae_finalizacao

        with tempfile.TemporaryDirectory() as pasta, patch.object(sebrae_finalizacao, "gravar_enviado", side_effect=OSError("disco cheio")), \
                patch.object(automacao, "log") as log:
            self.assertEqual(self._rodar_enviar(pasta, falha_no_envio=False), 0)
        self.assertIn("disco cheio", str(log.call_args_list))

    def test_pending_copy_upload_refuses_the_dashboard_name_and_skips_duplicate_download_and_precheck(self):
        with tempfile.TemporaryDirectory() as pasta:
            igual = Path(pasta) / automacao.DASHBOARD_FINAL.upper()
            igual.write_bytes(b"x")
            with patch.object(automacao, "nova_aba") as aba, patch.object(automacao, "enviar_arquivo_para_pasta") as enviar:
                with self.assertRaisesRegex(automacao.RotinaErro, "não pode ter o nome do Dashboard"):
                    automacao.enviar_copia_pendente(MagicMock(), igual)
            aba.assert_not_called()
            enviar.assert_not_called()
            copia = Path(pasta) / "Dashboard Operacional_SEBRAE (pendente 2026-10-30 1405).xlsx"
            copia.write_bytes(b"x")
            with patch.object(automacao, "nova_aba") as aba, patch.object(automacao, "aguardar_login"), \
                    patch.object(automacao, "enviar_arquivo_para_pasta") as enviar, \
                    patch.object(automacao, "duplicar_dashboard_na_pasta") as duplicar, \
                    patch.object(automacao, "baixar_dashboard_da_pasta") as baixar, \
                    patch.object(automacao, "conferir_dashboard_do_sharepoint") as conferir:
                automacao.enviar_copia_pendente(MagicMock(), copia)
            enviar.assert_called_once_with(aba.return_value, copia)
            for nao_chamado in (duplicar, baixar, conferir):
                nao_chamado.assert_not_called()

    def test_close_routine_delegates_to_the_runner_module_with_sem_finalizar(self):
        from scripts import sebrae_fechar

        context = MagicMock()
        for valor in (False, True):
            with patch.object(sebrae_fechar, "executar", return_value=0) as executar:
                self.assertEqual(automacao.rodar_rotina_fechar(context, valor), 0)
            executar.assert_called_once_with(context, sys.modules[automacao.__name__], sem_finalizar=valor)


class RetomadaNoMesmoLinkTests(unittest.TestCase):
    """Clique acidental em outro link (ou troca de contrato): a etapa volta ao mesmo link e retoma."""

    def _pagina_ux(self, url):
        page = MagicMock()
        page.url = url
        page.goto.side_effect = lambda destino, **_: setattr(page, "url", destino)
        campo = page.locator.return_value  # #CodigosContratosFiltro (o fake devolve o mesmo locator para todo seletor)
        campo.count.return_value = 1
        campo.input_value.return_value = automacao.CONTRATO_NOME
        campo.get_attribute.return_value = automacao.CONTRATO
        campo.locator.return_value.all_inner_texts.return_value = [f"Contrato: {automacao.CONTRATO_NOME}"]
        return page, campo

    def _rodar_ux(self, rotina, page, campo):
        def selecionar(_pagina):  # a seleção real deixa o contrato certo no campo
            campo.input_value.return_value = automacao.CONTRATO_NOME

        with patch.object(automacao, "abrir_ux", return_value=page), \
                patch.object(automacao, "selecionar_contrato_ux", side_effect=selecionar) as selecionar_mock, \
                patch.object(automacao, "aguardar_login") as login, patch.object(automacao, "aguardar_estado"), \
                patch.object(automacao, "exportar_com_download", return_value=Path("ux.xlsx")) as exportar, \
                patch.object(automacao, "definir_pagina_ativa_para_recuperacao"), patch.object(automacao, "registrar_erro"), \
                patch.object(automacao, "verificar_cancelamento"), patch.object(automacao, "log"), \
                patch.object(automacao.time, "sleep"):
            self.assertEqual(rotina(MagicMock()), Path("ux.xlsx"))
        exportar.assert_called_once()
        return selecionar_mock, login

    def test_mesma_tela_ux_tolera_caixa_query_barra_e_index_mas_nao_outro_link(self):
        # Falso "saiu da tela" travaria o Salvar edições e as exportações: só outro link conta.
        base = "https://ux.simpress.com.br"
        for url in ("/MeusEquipamentos/Index", "/MeusEquipamentos", "/meusequipamentos/index/?pagina=2", "/MeusEquipamentos/#topo"):
            with self.subTest(url=url):
                page, _ = self._pagina_ux(base + url)
                self.assertTrue(automacao.ux_no_contrato(page, automacao.UX_EQUIPAMENTOS_URL))
        page, _ = self._pagina_ux(automacao.UX_PEDIDOS_URL + "?status=aberto")
        self.assertTrue(automacao.ux_no_contrato(page, automacao.UX_PEDIDOS_URL))
        for url in ("/Dashboard", "/equipamentos/acompanhamento"):
            with self.subTest(url=url):
                page, _ = self._pagina_ux(base + url)
                self.assertFalse(automacao.ux_no_contrato(page, automacao.UX_EQUIPAMENTOS_URL))

    def test_equipamentos_volta_ao_link_e_ao_contrato_quando_o_usuario_abre_outra_tela(self):
        page, campo = self._pagina_ux("https://ux.simpress.com.br/Dashboard")  # clicou em outro link do menu
        selecionar, login = self._rodar_ux(automacao.exportar_ux_equipamentos, page, campo)
        page.goto.assert_called_once_with(automacao.UX_EQUIPAMENTOS_URL, wait_until="domcontentloaded", timeout=automacao.CARREGAMENTO_MS)
        self.assertEqual(selecionar.call_count, 2)
        login.assert_called_once()
        self.assertIs(login.call_args.kwargs["entrar"], automacao.ux_entrar)

    def test_pedidos_refaz_contrato_e_busca_quando_o_contrato_muda_antes_do_excel(self):
        page, campo = self._pagina_ux(automacao.UX_PEDIDOS_URL)
        cliques = []

        def clicar(*_args, **_kwargs):
            cliques.append(1)
            if len(cliques) == 1:  # logo depois de Buscar, o usuário troca o contrato no filtro
                campo.input_value.return_value = "OUTRO CONTRATO"

        page.get_by_role.return_value.filter.return_value.first.click.side_effect = clicar
        selecionar, _ = self._rodar_ux(automacao.exportar_ux_pedidos, page, campo)
        page.goto.assert_called_once_with(automacao.UX_PEDIDOS_URL, wait_until="domcontentloaded", timeout=automacao.CARREGAMENTO_MS)
        self.assertEqual(selecionar.call_count, 2)
        self.assertEqual(len(cliques), 3)  # Buscar, Buscar de novo no contrato certo, Baixar detalhes

    def test_endpoint_volta_a_grade_de_todos_limpa_filtros_e_confere_o_total_da_tela(self):
        from scripts import verificar_usuarios_endpoint as usuarios
        page = MagicMock()
        page.url = automacao.ENDPOINT_URL
        page.goto.side_effect = lambda destino, **_: setattr(page, "url", destino)
        ordem = []

        def clicou_em_outro_link(_pagina):  # entre o login e a exportação o usuário abre outra tela do Endpoint
            page.url = automacao.ENDPOINT_URL.replace("inventory/computers", "patch/missingpatches")
        with patch.object(automacao, "nova_aba", return_value=page), patch.object(automacao, "endpoint_vigiar_avisos"), \
                patch.object(automacao, "aguardar_login") as login, \
                patch.object(automacao, "definir_pagina_ativa_para_recuperacao", side_effect=clicou_em_outro_link), \
                patch.object(automacao, "selecionar_todos_computadores", side_effect=lambda *_: ordem.append("todos")), \
                patch.object(automacao, "confirmar_modo_todos"), patch.object(automacao, "aguardar_estado"), \
                patch.object(usuarios, "_limpar_caixas_preenchidas", side_effect=lambda *_: ordem.append("limpar")), \
                patch.object(usuarios, "ler_grade", return_value={"total": 120, "carregando": False}), \
                patch.object(automacao, "exportar_com_download", side_effect=lambda *_: ordem.append("baixar") or Path("ep.xlsx")), \
                patch.object(automacao, "validar_xlsx_endpoint") as validar, patch.object(automacao, "registrar_erro"), \
                patch.object(automacao, "verificar_cancelamento"), patch.object(automacao, "log"), \
                patch.object(automacao.time, "sleep"):
            self.assertEqual(automacao.exportar_endpoint(MagicMock()), Path("ep.xlsx"))
        page.goto.assert_called_once_with(automacao.ENDPOINT_URL, wait_until="domcontentloaded", timeout=automacao.CARREGAMENTO_MS)
        self.assertEqual(login.call_count, 2)
        self.assertIs(login.call_args.kwargs["entrar"], automacao.endpoint_entrar)
        self.assertEqual(ordem, ["todos", "limpar", "baixar"])
        validar.assert_called_once_with(Path("ep.xlsx"), total_tela=120)

    def _fora_da_pasta_ate_voltar(self, page):
        """A linha do Dashboard só aparece depois do goto: o usuário tinha saído da pasta DASHBOARD SEBRAE."""
        return patch.object(automacao, "esperar_visivel", side_effect=lambda *_: page.goto.called)

    def test_dashboard_volta_a_pasta_antes_de_baixar(self):
        page = MagicMock()
        with patch.object(automacao, "nova_aba", return_value=page), patch.object(automacao, "aguardar_login") as login, \
                patch.object(automacao, "definir_pagina_ativa_para_recuperacao"), patch.object(automacao, "registrar_erro"), \
                self._fora_da_pasta_ate_voltar(page), patch.object(automacao, "log"), patch.object(automacao.time, "sleep"), \
                patch.object(automacao, "baixar_dashboard_da_pasta", side_effect=lambda p: Path("d.xlsx") if p.goto.called else None):
            self.assertEqual(automacao.exportar_dashboard_sebrae(MagicMock()), Path("d.xlsx"))
        page.goto.assert_called_once_with(automacao.DASHBOARD_PASTA_URL, wait_until="domcontentloaded", timeout=automacao.CARREGAMENTO_MS)
        self.assertEqual(login.call_count, 2)
        self.assertIs(login.call_args.kwargs["entrar"], automacao.pasta_dashboard_entrar)

    def test_enviar_volta_a_pasta_antes_de_baixar_e_conferir(self):
        page = MagicMock()
        with tempfile.TemporaryDirectory() as pasta:
            arquivo = Path(pasta) / "Dashboard Operacional_SEBRAE.xlsx"
            arquivo.write_bytes(b"x")
            with patch.object(automacao, "arquivo_final_dashboard", return_value=arquivo), patch.object(automacao, "nova_aba", return_value=page), \
                    patch.object(automacao, "DASHBOARD_SAIDA_DIR", Path(pasta) / "sebrae_dashboard_saida"), \
                    patch.object(automacao, "aguardar_login"), patch.object(automacao, "verificar_cancelamento"), \
                    patch.object(automacao, "duplicar_dashboard_na_pasta"), self._fora_da_pasta_ate_voltar(page), \
                    patch.object(automacao, "baixar_dashboard_da_pasta", return_value=Path(pasta) / "baixado.xlsx"), \
                    patch.object(automacao, "conferir_dashboard_do_sharepoint"), patch.object(automacao, "guardar_backup_do_dashboard"), \
                    patch.object(automacao, "enviar_arquivo_para_pasta"), patch.object(automacao, "log"), redirect_stdout(io.StringIO()):
                self.assertEqual(automacao.rodar_rotina_enviar(MagicMock()), 0)
        page.goto.assert_called_once_with(automacao.DASHBOARD_PASTA_URL, wait_until="domcontentloaded", timeout=automacao.CARREGAMENTO_MS)

    def test_duplicata_volta_a_pasta_e_so_clica_uma_vez_depois_da_guarda(self):
        page = MagicMock()
        ordem = []
        page.goto.side_effect = lambda *_a, **_k: ordem.append("goto")
        duplicata = page.get_by_role.return_value.first
        duplicata.click.side_effect = lambda *_a, **_k: ordem.append("clique")
        contagens = iter([1, 2])
        with patch.object(automacao, "_linha_do_dashboard"), patch.object(automacao, "_abrir_mais_acoes"), \
                patch.object(automacao, "_quantos_dashboards_na_lista", side_effect=lambda _p: next(contagens)), \
                patch.object(automacao, "_copias_na_lista", return_value=0), self._fora_da_pasta_ate_voltar(page), \
                patch.object(automacao, "visivel", return_value=True), \
                patch.object(automacao, "aguardar_login"), \
                patch.object(automacao, "aguardar_estabilidade_pre_clique", side_effect=lambda *_a: ordem.append("guarda")) as guarda, \
                patch.object(automacao, "verificar_cancelamento"), patch.object(automacao, "log"):
            automacao.duplicar_dashboard_na_pasta(page)
        self.assertEqual(ordem, ["goto", "guarda", "clique"])  # a guarda só confere; o clique que cria a cópia é único
        self.assertEqual(guarda.call_args.args[0], duplicata.is_visible)

    def test_upload_volta_a_pasta_antes_de_abrir_o_carregar(self):
        page = MagicMock()
        ordem = []
        page.goto.side_effect = lambda *_a, **_k: ordem.append("goto")
        botao = MagicMock()
        botao.click.side_effect = lambda *_a, **_k: ordem.append("carregar")

        def esperar(_loc, ms):
            if ms == 8000:  # já escolheu o arquivo: o resto do envio não importa aqui
                raise automacao.RotinaErro("fim do teste")
            return page.goto.called  # a linha do Dashboard só aparece depois do goto

        with tempfile.TemporaryDirectory() as pasta:
            arquivo = Path(pasta) / "Dashboard Operacional_SEBRAE.xlsx"
            arquivo.write_bytes(b"x")
            with patch.object(automacao, "esperar_visivel", side_effect=esperar), patch.object(automacao, "aguardar_login"), \
                    patch.object(automacao, "_botao_enviar", return_value=botao), patch.object(automacao, "log"), \
                    patch.object(automacao, "definir_pagina_ativa_para_recuperacao"):
                with self.assertRaisesRegex(automacao.RotinaErro, "fim do teste"):
                    automacao.enviar_arquivo_para_pasta(page, arquivo)
        self.assertEqual(ordem, ["goto", "carregar"])


# Textos montados com os modelos do OneDrive (módulo 5729 de ondemand.resx.js, en-us e pt-br, build 2026-10-23).
AVISOS_ENVIO_SUCESSO = [
    "Uploaded Dashboard Operacional_SEBRAE.xlsx to DASHBOARD SEBRAE",
    "Uploaded 1 item to DASHBOARD SEBRAE",
    "Uploaded 2 items to DASHBOARD SEBRAE",
    "Uploaded 1 item",
    "Dashboard Operacional_SEBRAE.xlsx carregado para DASHBOARD SEBRAE",
    "1 item carregado para DASHBOARD SEBRAE",
    "2 itens carregados para DASHBOARD SEBRAE",
    "1 item carregado",
    "2 itens carregados",
    "Upload complete",
    "Upload concluído",
]
AVISOS_ENVIO_NAO_SUCESSO = [
    "Dashboard Operacional_SEBRAE.xlsx wasn't uploaded to DASHBOARD SEBRAE",
    "Dashboard Operacional_SEBRAE.xlsx wasn’t uploaded to DASHBOARD SEBRAE",
    "1 item wasn't uploaded to DASHBOARD SEBRAE",
    "2 items weren't uploaded to DASHBOARD SEBRAE",
    "2 items weren’t uploaded",
    "Dashboard Operacional_SEBRAE.xlsx não foi carregado para DASHBOARD SEBRAE",
    "1 item não foi carregado para DASHBOARD SEBRAE",
    "2 itens não foram carregados para DASHBOARD SEBRAE",
    "2 itens não foram carregados",
    "Uploading 1 item to DASHBOARD SEBRAE",
    "Uploading Dashboard Operacional_SEBRAE.xlsx to DASHBOARD SEBRAE",
    "Carregando 1 item para DASHBOARD SEBRAE",
    "Carregando Dashboard Operacional_SEBRAE.xlsx para DASHBOARD SEBRAE",
    "Save Conflict",
    "Retry",
    "A few seconds ago",
    "590 KB",
    "Dashboard Operacional_SEBRAE.xlsx",
    "Uploaded",
    "Uploaded by Juliana",
]


class AvisoEnvioConcluidoTests(unittest.TestCase):
    """Só o aviso de sucesso confirma o envio; falha, andamento e texto da linha nunca confirmam."""

    def test_aceita_avisos_de_sucesso(self):
        for texto in AVISOS_ENVIO_SUCESSO:
            with self.subTest(texto=texto):
                self.assertRegex(texto, automacao._AVISO_ENVIO_CONCLUIDO)

    def test_recusa_falha_andamento_e_texto_da_linha(self):
        for texto in AVISOS_ENVIO_NAO_SUCESSO:
            with self.subTest(texto=texto):
                self.assertNotRegex(texto, automacao._AVISO_ENVIO_CONCLUIDO)

    def test_mesmo_resultado_no_regexp_do_navegador(self):
        # O Playwright repassa o padrão ao navegador como RegExp do JavaScript.
        import shutil
        import subprocess

        node = shutil.which("node")
        if not node:
            self.skipTest("node ausente")
        padrao = automacao._AVISO_ENVIO_CONCLUIDO
        self.assertEqual(padrao.flags & ~re.UNICODE, re.IGNORECASE)
        codigo = (
            "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));"
            "const r=new RegExp(d.src,'i');"
            "process.stdout.write(JSON.stringify([d.sim.map(t=>r.test(t)),d.nao.map(t=>r.test(t))]));"
        )
        dados = json.dumps({"src": padrao.pattern, "sim": AVISOS_ENVIO_SUCESSO, "nao": AVISOS_ENVIO_NAO_SUCESSO})
        saida = subprocess.run([node, "-e", codigo], input=dados, capture_output=True, text=True, encoding="utf-8", check=True)
        sim, nao = json.loads(saida.stdout)
        self.assertEqual(sim, [True] * len(AVISOS_ENVIO_SUCESSO))
        self.assertEqual(nao, [False] * len(AVISOS_ENVIO_NAO_SUCESSO))


if __name__ == "__main__":
    unittest.main()
