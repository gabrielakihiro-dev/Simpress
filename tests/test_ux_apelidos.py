"""F7: bytes exportados, validação e gravação única em uma página local, sem UX real."""
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from openpyxl import Workbook
from core.errors import DomainError
from scripts import automacao_rotinas_chrome as automacao
from tests.test_chrome_automation import RunnerHarness
from tests.test_automacao_telas_browser import PAGINA_UX, ESTILO, localizar_navegador
from tests import test_chrome_automation as chrome_tests


def planilha():
    saida = io.BytesIO()
    workbook = Workbook()
    workbook.active.append(["Serie", "Apelido", "IdCliente"])
    workbook.save(saida)
    return saida.getvalue()


class UploadUxRouteTests(chrome_tests.AutomationRouteTests):
    def test_upload_entrega_nome_bytes_e_retornos_de_validacao(self):
        chamadas = []
        self.runner.start_ux_alias = lambda nome, dados: chamadas.append((nome, dados)) or {"rotina": "ux_apelidos"}
        dados = planilha()
        resposta = self.client.post('/api/automacao/ux-apelidos', files={"file": ("mesmo.xlsx", dados)}, headers={"Origin": self.origin})
        self.assertEqual(resposta.status_code, 202)
        self.assertEqual(chamadas, [("mesmo.xlsx", dados)])
        self.assertEqual(self.client.post('/api/automacao/ux-apelidos', files={"file": ("x.xlsx", dados)}, headers={"Origin": "https://evil.example"}).status_code, 403)
        self.assertEqual(len(chamadas), 1)

    def test_upload_rejeita_arquivo_extra_e_campo_duplicado(self):
        chamadas = []
        self.runner.start_ux_alias = lambda nome, dados: chamadas.append((nome, dados)) or {"rotina": "ux_apelidos"}
        dados = planilha()
        casos = [
            {"files": [("file", ("a.xlsx", dados)), ("file", ("b.xlsx", dados))]},
            {"files": {"file": ("a.xlsx", dados)}, "data": {"extra": "valor"}},
        ]
        for campos in casos:
            with self.subTest(campos=tuple(campos)):
                resposta = self.client.post("/api/automacao/ux-apelidos", **campos, headers={"Origin": self.origin})
                self.assertIn(resposta.status_code, (400, 422))
        self.assertEqual(chamadas, [])

    def test_upload_acima_de_um_mb_chega_ao_validador_e_nao_ao_limite_json(self):
        self.runner.start_ux_alias = lambda nome, dados: {"tamanho": len(dados)}
        dados = b"x" * (2 * 1024 * 1024)
        resposta = self.client.post('/api/automacao/ux-apelidos', files={"file": ("grande.xlsx", dados)})
        self.assertEqual(resposta.status_code, 202)
        self.assertEqual(resposta.json()["tamanho"], len(dados))


class AssistenteUxTests(unittest.TestCase):
    def test_prompt_e_schema_separam_resumo_f3_do_download_por_chat(self):
        from domains.assistant_chat import SYSTEM_PROMPT
        from domains.assistant_tools import TOOLS
        from domains.assistant_api import ROTINAS_VALIDAS, SimpressApi
        self.assertIn("ux_apelidos", SYSTEM_PROMPT)
        self.assertNotIn("ux_apelidos", ROTINAS_VALIDAS)
        # Atalhos atuais: Resumo F3 e Assistente F9; F7 (antiga Comparação) e F10 não existem mais como esses destinos.
        for texto in (SYSTEM_PROMPT, TOOLS["exportar_planilha"].description):
            self.assertIn("Resumo (F3)", texto)
            self.assertNotIn("(F7)", texto)
            self.assertNotIn("F10", texto)
        chamadas = []
        api = SimpressApi(lambda *args: chamadas.append(args) or (200, {}))
        self.assertFalse(api.executar_automacao("ux_apelidos")["sucesso"])
        self.assertEqual(chamadas, [])


class ArquivoUxTests(unittest.TestCase):
    def test_runner_recebe_bytes_exatos_e_limpa_copia_apos_execucao(self):
        with tempfile.TemporaryDirectory() as pasta:
            harness = RunnerHarness(Path(pasta))
            dados = planilha()
            estado = harness.runner.start_ux_alias("exportado.xlsx", dados)
            args = harness.popen_calls[0][0]
            self.assertEqual(estado["rotina"], "ux_apelidos")
            caminho = Path(args[args.index("--planilha-ux") + 1])
            self.assertEqual(caminho.name, "exportado.xlsx")
            self.assertEqual(caminho.read_bytes(), dados)
            harness.finish(0)
            self.assertFalse(caminho.exists())

    def test_cancelamento_depois_do_pedido_de_salvar_registra_resultado_incerto(self):
        with tempfile.TemporaryDirectory() as pasta:
            harness = RunnerHarness(Path(pasta), help_text="usage --rotina [--cancelar]")
            harness.runner.start_ux_alias("exportado.xlsx", planilha())
            harness.append_log("[UX Simpress] Planilha conferida; clicando uma vez em Salvar edições...\n")
            harness.runner.cancel()
            harness.finish(1)
            ultima = harness.runner.history(1)[0]
            self.assertEqual(ultima["status"], "falha")
            self.assertIn("resultado incerto", ultima["mensagem"].lower())

    def test_reinicio_depois_do_pedido_de_salvar_preserva_aviso_incerto(self):
        with tempfile.TemporaryDirectory() as pasta:
            harness = RunnerHarness(Path(pasta))
            harness.runner.start_ux_alias("exportado.xlsx", planilha())
            harness.append_log("[UX Simpress] Planilha conferida; clicando uma vez em Salvar edições...\n")
            recuperado = chrome_tests.ChromeAutomationRunner(harness.contract, is_alive=lambda _pid: False, watch=False)
            ultima = recuperado.history(1)[0]
            self.assertEqual(ultima["status"], "interrompido")
            self.assertIn("resultado incerto", ultima["mensagem"].lower())
            self.assertIn("confira manualmente", ultima["mensagem"].lower())
            (harness.contract.log_dir / "20261020_080000_ux_apelidos.json").write_text(json.dumps({
                "rotina": "ux_apelidos", "inicio": ultima["inicio"], "fim": ultima["fim"],
                "status": "interrompido", "codigo": 130, "mensagem": "Rotina interrompida pelo usuário.",
            }), encoding="utf-8")
            recuperada_com_resumo = recuperado.history(1)[0]
            self.assertIn("resultado incerto", recuperada_com_resumo["mensagem"].lower())
            self.assertIn("confira manualmente", recuperada_com_resumo["mensagem"].lower())
            harness.finish(0)

    def test_recusa_nome_tamanho_e_formato_sem_iniciar_processo(self):
        with tempfile.TemporaryDirectory() as pasta:
            harness = RunnerHarness(Path(pasta))
            for nome, dados in [("../x.xlsx", planilha()), ("x.xls", planilha()),
                                ("CON.xlsx", planilha()), ("x.xlsx", b""),
                                ("x.xlsx", b"nao e xlsx"), ("x.xlsx", b"x" * (20 * 1024 * 1024 + 1))]:
                with self.subTest(nome=nome, tamanho=len(dados)), self.assertRaises(DomainError):
                    harness.runner.start_ux_alias(nome, dados)
            self.assertEqual(harness.popen_calls, [])

    def test_rotina_dedicada_nao_pode_ser_iniciada_sem_arquivo(self):
        with tempfile.TemporaryDirectory() as pasta:
            harness = RunnerHarness(Path(pasta))
            with self.assertRaises(DomainError):
                harness.runner.start("ux_apelidos")


EDITOR = """
<a role="button" id="editar" hidden><i>&#xe84c;</i> Editar apelido e id</a>
<section role="dialog" hidden><h5>Editar apelido e id</h5>
 <label role="button" id="enviar"><i style="font-family:x">&#xe84c;</i> Enviar planilha</label><input type="file" id="arquivo" hidden>
 <span id="nome"></span><button id="salvar" hidden>Salvar edições</button>
</section><div role="alert" id="aviso"></div>
<script>
window.salvos=0; window.recebido=null;
buscar.addEventListener('click',()=>setTimeout(()=>editar.hidden=false,550));
editar.onclick=()=>document.querySelector('section').hidden=false;
enviar.onclick=()=>arquivo.click();
arquivo.onchange=async()=>{window.recebido=Array.from(new Uint8Array(await arquivo.files[0].arrayBuffer()));
 nome.textContent=window.nomeErrado?'outro.xlsx':arquivo.files[0].name; salvar.hidden=false;};
salvar.onclick=()=>{window.salvos++; if(!window.semConfirmacao) aviso.innerHTML='<button>&times;</button><div>Edições salvas com sucesso!</div>';};
</script>
"""


class FluxoUxBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.executavel = localizar_navegador()
        if cls.executavel is None:
            raise unittest.SkipTest("Chrome/Chromium não disponível")

    def rodar(self, modo="ok"):
        from playwright.sync_api import sync_playwright
        with tempfile.TemporaryDirectory() as pasta, sync_playwright() as pw:
            # Sem isso, o Chromium sem janela em runner lento pode pausar o rAF e o click espera "stable" por 30 s.
            browser = pw.chromium.launch(executable_path=str(self.executavel), headless=True, args=[
                "--disable-renderer-backgrounding", "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows"])
            try:
                contexto = browser.new_context()
                contexto.route("**/*", lambda rota: rota.abort())
                pagina = contexto.new_page()
                html = PAGINA_UX % {"estilo": ESTILO, "contrato": automacao.CONTRATO,
                                   "contrato_nome": automacao.CONTRATO_NOME}
                pagina.set_content(html.replace("</body>", EDITOR + "</body>"))
                if modo == "contrato":
                    pagina.locator('li[data-valor="16467"]').evaluate("e=>e.dataset.texto='OUTRO'")
                if modo == "contrato_duplicado":
                    pagina.locator('li[data-valor="16467"]').evaluate("e=>e.after(e.cloneNode(true))")
                if modo == "sem_upload":
                    pagina.locator("#enviar").evaluate("e=>e.remove()")
                if modo == "save_duplicado":
                    pagina.locator("#salvar").evaluate("e=>e.after(e.cloneNode(true))")
                pagina.evaluate("modo=>{window.nomeErrado=modo==='arquivo';window.semConfirmacao=modo==='confirmacao';}", modo)
                dados = planilha()
                arquivo = Path(pasta) / "recem-exportado.xlsx"
                arquivo.write_bytes(dados)
                def cancelar_apos_upload():
                    if modo == "cancelar" and pagina.locator("#arquivo").evaluate("e=>e.files.length"):
                        raise automacao.RotinaCancelada()
                    if modo == "cancelar_apos_salvar" and pagina.evaluate("window.salvos > 0"):
                        raise automacao.RotinaCancelada("pedido durante a confirmação")

                guarda_real = automacao.aguardar_estabilidade_pre_clique

                def guarda(verificar, descricao, **kwargs):
                    if modo == "contrato_na_guarda" and descricao.startswith("Salvar"):
                        # Durante a espera antes de Salvar, o usuário troca o contrato no filtro (cursor parado).
                        pagina.locator("#CodigosContratosFiltro").evaluate("e=>e.dataset.valor='99999'")
                        with patch.object(automacao, "obter_posicao_cursor", return_value=(0, 0)):
                            return guarda_real(verificar, descricao, espera_s=0.01, janelas=1)
                    return guarda_real(verificar, descricao, **kwargs)

                # A página local fica em about:blank: é o "mesmo link" da rotina neste teste.
                with patch.object(automacao, "abrir_ux", return_value=pagina), patch.object(automacao, "registrar_erro"), patch.object(automacao, "log"), \
                     patch.object(automacao, "verificar_cancelamento", side_effect=cancelar_apos_upload), patch.object(automacao, "UX_EDICOES_TIMEOUT_MS", 1000), \
                     patch.object(automacao, "UX_EQUIPAMENTOS_URL", pagina.url), \
                     patch.object(automacao, "aguardar_estabilidade_pre_clique", side_effect=guarda), \
                     patch.object(automacao, "voltar_ao_contrato_ux", wraps=automacao.voltar_ao_contrato_ux) as voltar:
                    if modo == "login_expirado":  # o retorno ao link esperou o login 10 min e desistiu: não repete
                        voltar.side_effect = automacao.RotinaErro("Tempo esgotado aguardando o login no UX Simpress.")
                    if modo == "ok":
                        automacao.atualizar_apelidos_ux(contexto, arquivo)
                    elif modo == "cancelar":
                        with self.assertRaises(automacao.RotinaCancelada):
                            automacao.atualizar_apelidos_ux(contexto, arquivo)
                    elif modo == "cancelar_apos_salvar":
                        with self.assertRaisesRegex(automacao.RotinaErro, "resultado incerto|Confira o UX"):
                            automacao.atualizar_apelidos_ux(contexto, arquivo)
                    else:
                        with self.assertRaises(automacao.RotinaErro):
                            automacao.atualizar_apelidos_ux(contexto, arquivo)
                self.assertEqual(pagina.evaluate("window.salvos"), 1 if modo in ("ok", "confirmacao", "cancelar_apos_salvar") else 0)
                if modo == "ok":
                    self.assertEqual(bytes(pagina.evaluate("window.recebido")), dados)
                    # A abertura do editor (repetível) confere a tela e o contrato e retoma no mesmo link se preciso.
                    voltar.assert_called_with(pagina, pagina.url)
                if modo == "login_expirado":
                    self.assertEqual(voltar.call_count, 1)
            finally:
                browser.close()

    def test_envia_mesmos_bytes_e_salva_uma_vez(self):
        self.rodar()

    def test_falha_segura_antes_de_salvar(self):
        for modo in ("contrato", "contrato_duplicado", "sem_upload", "save_duplicado", "arquivo", "login_expirado"):
            with self.subTest(modo=modo):
                self.rodar(modo)

    def test_contrato_trocado_na_espera_antes_de_salvar_aborta_sem_salvar(self):
        # Salvar edições nunca é repetido: a guarda só confere tela e contrato e aborta (RotinaErro, salvos == 0).
        self.rodar("contrato_na_guarda")

    def test_nao_repete_salvar_quando_confirmacao_nao_chega(self):
        self.rodar("confirmacao")

    def test_cancelamento_apos_upload_preserva_status_sem_salvar(self):
        self.rodar("cancelar")

    def test_cancelamento_apos_salvar_avisa_resultado_incerto(self):
        self.rodar("cancelar_apos_salvar")
