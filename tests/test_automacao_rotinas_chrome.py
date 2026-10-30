import io
import json
import os
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
        def executar(_rotina):
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

    def _enviar(self, page, concluido=True, em_uso=False):
        """Roda o envio com o aviso de conclusão (``concluido``) e o de arquivo em uso (``em_uso``) simulados."""
        aviso = page.get_by_text.return_value.first
        with tempfile.TemporaryDirectory() as pasta:
            arquivo = Path(pasta) / "Dashboard Operacional_SEBRAE.xlsx"
            arquivo.write_bytes(b"x")
            with patch.object(automacao, "esperar_visivel", return_value=True), \
                    patch.object(automacao, "visivel", side_effect=lambda loc: concluido if loc is aviso else em_uso), \
                    patch.object(automacao, "verificar_cancelamento"), patch.object(automacao, "log"), \
                    patch.object(automacao, "_botao_enviar"):
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

    def test_upload_refuses_when_only_keep_both_is_offered(self):
        page = self._pagina({"manter"})
        with self.assertRaisesRegex(automacao.RotinaErro, "Keep both"):
            self._enviar(page)
        page.locators["manter"].first.click.assert_not_called()

    def test_upload_fails_clearly_when_the_dashboard_is_in_use(self):
        page = self._pagina({"substituir"})
        with self.assertRaisesRegex(automacao.RotinaErro, "em uso ou bloqueado"):
            self._enviar(page, concluido=False, em_uso=True)

    def test_upload_fails_without_the_completion_notice_even_if_the_row_text_changes(self):
        # O texto da linha ("há 4 minutos" -> "há 5 minutos") muda sozinho; só o aviso de conclusão vale.
        page = self._pagina({"substituir"})
        textos = iter(f"há {n} minutos" for n in range(1000))
        with patch.object(automacao, "_localizar_linha_do_dashboard") as linha, \
                patch.object(automacao.time, "time", side_effect=[0, 1, 2, 3, 500, 500]):
            linha.return_value.inner_text.side_effect = lambda **_: next(textos)
            with self.assertRaisesRegex(automacao.RotinaErro, "não mudou"):
                self._enviar(page, concluido=False)

    def test_duplicate_clicks_the_menu_and_waits_for_the_copy(self):
        page = MagicMock()
        contagens = iter([1, 1, 2])
        with patch.object(automacao, "_linha_do_dashboard"), patch.object(automacao, "_abrir_mais_acoes") as abrir, \
                patch.object(automacao, "_quantos_dashboards_na_lista", side_effect=lambda _p: next(contagens)), \
                patch.object(automacao, "verificar_cancelamento"), patch.object(automacao, "log"):
            automacao.duplicar_dashboard_na_pasta(page)
        abrir.assert_called_once()
        self.assertIs(page.get_by_role.call_args.kwargs["name"], automacao._MENU_DUPLICATA)
        page.get_by_role.return_value.first.click.assert_called_once()

    def test_duplicate_stops_without_overwriting_when_the_copy_does_not_appear(self):
        page = MagicMock()
        with patch.object(automacao, "_linha_do_dashboard"), patch.object(automacao, "_abrir_mais_acoes"), \
                patch.object(automacao, "_quantos_dashboards_na_lista", return_value=1), \
                patch.object(automacao.time, "time", side_effect=[0, 1, 99, 99]), \
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
            with patch.object(automacao, "arquivo_final_dashboard", return_value=arquivo), patch.object(automacao, "nova_aba", return_value=page), \
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

    def test_routine_does_not_upload_when_the_precheck_fails(self):
        with tempfile.TemporaryDirectory() as pasta:
            with patch.object(automacao, "arquivo_final_dashboard", return_value=Path(pasta) / "x.xlsx"), patch.object(automacao, "nova_aba"), \
                    patch.object(automacao, "aguardar_login"), patch.object(automacao, "verificar_cancelamento"), \
                    patch.object(automacao, "duplicar_dashboard_na_pasta"), patch.object(automacao, "baixar_dashboard_da_pasta"), \
                    patch.object(automacao, "conferir_dashboard_do_sharepoint", side_effect=automacao.RotinaErro(automacao.MSG_SHAREPOINT_MUDOU)), \
                    patch.object(automacao, "guardar_backup_do_dashboard") as backup, patch.object(automacao, "enviar_arquivo_para_pasta") as enviar, \
                    patch.object(automacao, "registrar_erro"), redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(automacao.RotinaErro, "importe de novo"):
                    automacao.rodar_rotina_enviar(MagicMock())
        backup.assert_not_called()
        enviar.assert_not_called()


if __name__ == "__main__":
    unittest.main()
