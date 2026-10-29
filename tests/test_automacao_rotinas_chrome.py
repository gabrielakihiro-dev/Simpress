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
from unittest.mock import patch

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

    def test_arquivo_final_dashboard_picks_the_newest_download_and_fails_without_one(self):
        with patch.object(automacao, "pastas_download_chrome", return_value=[self.root]):
            with self.assertRaisesRegex(automacao.RotinaErro, "Atualizar Dashboard"):
                automacao.arquivo_final_dashboard()
            velho = self.root / automacao.DASHBOARD_FINAL
            novo = self.root / "Dashboard Operacional_SEBRAE (atualizado) (1).xlsx"
            for arquivo, instante in ((velho, 1_000_000), (novo, 2_000_000)):
                with zipfile.ZipFile(arquivo, "w") as xlsx:
                    xlsx.writestr("a", "b")
                os.utime(arquivo, (instante, instante))
            (self.root / "Dashboard Operacional_SEBRAE.xlsx").write_bytes(b"PK")  # a cópia baixada do Excel não é o final
            self.assertEqual(automacao.arquivo_final_dashboard(), novo)

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


class FakeLocator:
    def __init__(self, frame, regex):
        self.frame, self.regex = frame, regex

    def _achados(self):
        return [texto for texto in self.frame.visiveis if self.regex.search(texto)]

    def filter(self, visible=True):
        return self

    def count(self):
        return len(self._achados())

    @property
    def first(self):
        return self

    def wait_for(self, state="visible", timeout=0):
        if not self._achados():
            raise AssertionError(f"rótulo não apareceu: {self.regex.pattern}")

    def click(self):
        achados = self._achados()
        if not achados:
            raise AssertionError(f"rótulo não apareceu: {self.regex.pattern}")
        self.frame.cliques.append(achados[0])
        self.frame.visiveis = self.frame.proximos.get(achados[0], self.frame.visiveis)


class FakeFrame:
    """Frame do Excel Online: `visiveis` são os textos na tela; `proximos` diz o que aparece após clicar."""

    def __init__(self, visiveis, proximos=None):
        self.visiveis, self.proximos, self.cliques = list(visiveis), proximos or {}, []

    def get_by_text(self, regex):
        return FakeLocator(self, regex)


class FakePage:
    def __init__(self, url, frames):
        self.url, self.frames = url, frames


IDIOMAS = {
    "en": ("File", "Create a Copy", "Download a Copy"),
    "pt-BR": ("Arquivo", "Criar uma Cópia", "Baixar uma Cópia"),
}
URL_EXCEL = "https://simpress-my.sharepoint.com/:x:/r/personal/x/_layouts/15/doc2.aspx"


def frame_do_excel(idioma):
    arquivo, copia, baixar = IDIOMAS[idioma]
    return FakeFrame([arquivo, "Home"], {arquivo: [copia, "Save As"], copia: [baixar, "Save a Copy"]})


class DashboardMenuLabelsTests(unittest.TestCase):
    def test_menu_matches_english_and_portuguese_excel_online(self):
        for texto in ("File", "Arquivo", "  Arquivo "):
            self.assertTrue(automacao._MENU_ARQUIVO.match(texto), texto)
        for texto in ("Create a Copy", "Criar uma Cópia", "criar uma copia"):
            self.assertTrue(automacao._MENU_CRIAR_COPIA.match(texto), texto)
        for texto in ("Download a Copy", "Baixar uma Cópia", "baixar uma copia"):
            self.assertTrue(automacao._MENU_BAIXAR_COPIA.match(texto), texto)
        self.assertFalse(automacao._MENU_ARQUIVO.match("Arquivos recentes"))
        self.assertFalse(automacao._MENU_ARQUIVO.match("Profile"))
        self.assertFalse(automacao._MENU_BAIXAR_COPIA.match("Baixar como PDF"))

    def test_login_is_detected_in_both_languages(self):
        for idioma in IDIOMAS:
            with self.subTest(idioma=idioma):
                page = FakePage(URL_EXCEL, [FakeFrame([]), frame_do_excel(idioma)])
                self.assertTrue(automacao.dashboard_logado(page))

    def test_login_is_not_detected_without_the_file_menu_or_on_a_login_page(self):
        sem_menu = FakePage(URL_EXCEL, [FakeFrame(["Sign in", "Entrar"])])
        self.assertFalse(automacao.dashboard_logado(sem_menu))
        for idioma in IDIOMAS:
            with self.subTest(idioma=idioma):
                self.assertFalse(automacao.dashboard_logado(FakePage("https://login.microsoftonline.com/x", [frame_do_excel(idioma)])))
                self.assertFalse(automacao.dashboard_logado(FakePage("https://outro.com/", [frame_do_excel(idioma)])))

    def test_download_copy_follows_the_menu_in_both_languages(self):
        def exportar(page, origem, clicar, prefixo):
            clicar()
            return Path("copia.xlsx")

        for idioma, rotulos in IDIOMAS.items():
            with self.subTest(idioma=idioma), patch.object(automacao, "exportar_com_download", exportar), patch.object(automacao, "log"):
                frame = frame_do_excel(idioma)
                self.assertEqual(automacao.baixar_copia_dashboard(FakePage(URL_EXCEL, [frame])), Path("copia.xlsx"))
                self.assertEqual(frame.cliques, list(rotulos))

    def test_download_copy_without_the_file_menu_fails_clearly(self):
        with self.assertRaises(automacao.RotinaErro):
            automacao.baixar_copia_dashboard(FakePage(URL_EXCEL, [FakeFrame(["Home"])]))


if __name__ == "__main__":
    unittest.main()
