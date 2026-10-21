"""Rotina de inventários (UX + Endpoint) em janelas pequenas, médias e grandes, num Chrome real via CDP.

Uma bancada local imita as telas usadas pela rotina, inclusive o que os sites escondem em
janelas estreitas (saudação "Olá," e botões de exportação abaixo de 1200 px). O Chrome é iniciado
como na rotina (porta CDP + perfil próprio), em modo headless e com os domínios dos sites
apontados para a bancada; nenhum site externo, login ou dado operacional é usado.

Por padrão roda uma janela pequena, uma média e uma grande. SIMPRESS_TESTE_TODAS_TELAS=1 roda
todas as resoluções de TELAS_TODAS; SIMPRESS_TESTE_COM_JANELA=1 abre o Chrome visível em vez de
headless e SIMPRESS_TESTE_VERBOSO=1 mostra o log da rotina. Sem Chrome nem Chromium do Playwright,
o teste é pulado.
"""

import importlib.util
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from scripts import automacao_rotinas_chrome as automacao

PLAYWRIGHT_AVAILABLE = importlib.util.find_spec("playwright") is not None

UX_HOST = "ux.simpress.com.br"
ENDPOINT_HOST = "centralendpoint.pr.sebrae.com.br"
NOME_ZIP_UX = "EquipamentosDetalhes_20261020_0923_83685.zip"
NOME_XLSX_ENDPOINT = "InvAllComputersSummary.xlsx"

# (largura, altura, escala): a escala imita o zoom do Windows (125% e 150%) e telas 4K.
TELAS_PADRAO = [(640, 480, 1), (1024, 768, 1), (1920, 1080, 1)]
TELAS_TODAS = [
    (500, 400, 1), (640, 480, 1), (800, 600, 1), (1024, 768, 1), (1280, 720, 1), (1280, 1024, 1),
    (1366, 768, 1), (1440, 900, 1), (1600, 900, 1), (1920, 1080, 1.25), (1920, 1080, 1.5),
    (1920, 1080, 1), (2560, 1440, 1), (3840, 2160, 1), (3840, 2160, 2),
]

ESTILO = """
body{font-family:sans-serif;margin:0}
header{display:flex;justify-content:space-between;padding:8px;background:#036;color:#fff}
.so-largo{display:none}
@media (min-width:1200px){.so-largo{display:block}}
.oculto{display:none!important}
#lista{border:1px solid #999;background:#fff;max-width:420px}
"""

PAGINA_UX = """<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><style>%(estilo)s</style></head><body>
<header><span>UX Simpress</span><span class="so-largo">Olá, gabriel!</span></header>
<h1>Meus equipamentos</h1>
<input id="CodigosContratosFiltro" readonly data-valor="" value="" placeholder="Contrato/Nome">
<div id="lista" class="oculto">
  <span id="desmarcar">Desmarcar todos</span>
  <input placeholder="Buscar Contrato/Nome">
  <ul>
    <li data-valor="99999" data-texto="99999 - OUTRO CONTRATO">99999 - OUTRO CONTRATO</li>
    <li data-valor="%(contrato)s" data-texto="%(contrato_nome)s">%(contrato_nome)s</li>
  </ul>
</div>
<div id="aguarde" class="oculto">Aguarde...</div>
<button id="buscar">Buscar</button>
<div id="exportacao" class="oculto">
  <button id="ExportarDropdown" class="so-largo">Baixar detalhes</button>
  <a id="ExportarXlsx" class="oculto" href="/download/ux.zip">Excel</a>
</div>
<script>
const campo = document.getElementById('CodigosContratosFiltro');
const lista = document.getElementById('lista');
const aguarde = (ms, depois) => {
  aguarde.el.classList.remove('oculto');
  setTimeout(() => { aguarde.el.classList.add('oculto'); depois(); }, ms);
};
aguarde.el = document.getElementById('aguarde');
campo.addEventListener('click', (e) => { e.stopPropagation(); lista.classList.remove('oculto'); });
lista.addEventListener('click', (e) => e.stopPropagation());
document.getElementById('desmarcar').addEventListener('click', () => {
  lista.querySelectorAll('i.icon-ok-squared').forEach((i) => i.remove());
});
lista.querySelector('input').addEventListener('input', (e) => {
  lista.querySelectorAll('li').forEach((li) => {
    li.classList.toggle('oculto', !li.dataset.texto.includes(e.target.value));
  });
});
lista.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => {
  const marcado = li.querySelector('i.icon-ok-squared');
  if (marcado) marcado.remove(); else li.insertAdjacentHTML('afterbegin', '<i class="icon-ok-squared">✓</i>');
}));
document.querySelector('h1').addEventListener('click', () => {
  if (lista.classList.contains('oculto')) return;
  lista.classList.add('oculto');
  const escolhido = lista.querySelector('li i.icon-ok-squared');
  aguarde(700, () => {
    const li = escolhido && escolhido.parentElement;
    campo.value = li ? li.dataset.texto : '';
    campo.dataset.valor = li ? li.dataset.valor : '';
  });
});
document.getElementById('buscar').addEventListener('click', () => {
  aguarde(500, () => document.getElementById('exportacao').classList.remove('oculto'));
});
document.getElementById('ExportarDropdown').addEventListener('click', () => {
  document.getElementById('ExportarXlsx').classList.remove('oculto');
});
</script></body></html>"""

PAGINA_ENDPOINT = """<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><style>%(estilo)s</style></head><body>
<header><span>Endpoint Central</span><span class="so-largo">admin</span></header>
<label><input type="radio" name="vista" value="InvComputersSummary" checked> Computadores verificados</label>
<label><input type="radio" name="vista" value="InvAllComputersSummary"> Todos os computadores</label>
<button id="InvAllComputersSummary-export" class="so-largo oculto">Exportar</button>
<div id="modal" class="oculto">
  <label class="radiobox"><input type="radio" name="exportFormat" value="pdf" checked style="display:none"> PDF</label>
  <label class="radiobox"><input type="radio" name="exportFormat" value="xls" style="display:none"> XLSX</label>
  <label class="checkbox--form"><input type="checkbox" name="userConsent" style="display:none"> Declaração de privacidade</label>
  <button id="export_option_submit">Exportar</button>
</div>
<script>
document.querySelectorAll('input[name=vista]').forEach((r) => r.addEventListener('change', () => {
  const todos = document.querySelector('input[value=InvAllComputersSummary]').checked;
  document.getElementById('InvAllComputersSummary-export').classList.toggle('oculto', !todos);
}));
document.getElementById('InvAllComputersSummary-export').addEventListener('click', () => {
  document.getElementById('modal').classList.remove('oculto');
});
document.getElementById('export_option_submit').addEventListener('click', () => {
  location.href = '/download/endpoint.xlsx';
});
</script></body></html>"""


def xlsx_endpoint() -> bytes:
    from openpyxl import Workbook

    planilha = Workbook()
    aba = planilha.active
    aba.append(list(automacao.ENDPOINT_CABECALHOS))
    for indice in range(1, 4):
        aba.append([f"PRNOTE{indice:03d}", f"SERIE{indice:04d}"])
    saida = io.BytesIO()
    planilha.save(saida)
    return saida.getvalue()


def zip_ux() -> bytes:
    saida = io.BytesIO()
    with zipfile.ZipFile(saida, "w") as arquivo:
        arquivo.writestr("EquipamentosDetalhes.xlsx", xlsx_endpoint())
    return saida.getvalue()


def criar_servidor() -> ThreadingHTTPServer:
    valores = {"estilo": ESTILO, "contrato": automacao.CONTRATO, "contrato_nome": automacao.CONTRATO_NOME}
    paginas = {
        "/MeusEquipamentos/Index": PAGINA_UX % valores,
        "/webclient": PAGINA_ENDPOINT % valores,
    }
    downloads = {
        "/download/ux.zip": (NOME_ZIP_UX, zip_ux()),
        "/download/endpoint.xlsx": (NOME_XLSX_ENDPOINT, xlsx_endpoint()),
    }

    class Bancada(BaseHTTPRequestHandler):
        def do_GET(self):
            caminho = self.path.split("?", 1)[0]
            if caminho in paginas:
                corpo = paginas[caminho].encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
            elif caminho in downloads:
                nome, corpo = downloads[caminho]
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Disposition", f'attachment; filename="{nome}"')
            else:
                corpo = b""
                self.send_response(404)
            self.send_header("Content-Length", str(len(corpo)))
            self.end_headers()
            self.wfile.write(corpo)

        def log_message(self, *_args):
            pass

    class Servidor(ThreadingHTTPServer):
        def handle_error(self, request, client_address):
            if not isinstance(sys.exc_info()[1], ConnectionError):  # Chrome fechando conexões no fim
                super().handle_error(request, client_address)

    servidor = Servidor(("127.0.0.1", 0), Bancada)
    threading.Thread(target=servidor.serve_forever, daemon=True).start()
    return servidor


def localizar_navegador() -> Path | None:
    try:
        return automacao.localizar_chrome()
    except automacao.RotinaErro:
        pass
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as pw:
            caminho = Path(pw.chromium.executable_path)
        return caminho if caminho.is_file() else None
    except Exception:
        return None


def porta_livre() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class ChromeDaBancada:
    """Chrome com porta CDP e perfil próprios, como o Chrome de automação da rotina."""

    def __init__(self, executavel: Path, pasta: Path, largura: int, altura: int, escala: float, porta_site: int) -> None:
        self.porta = porta_livre()
        self.perfil = pasta / "perfil"
        self.downloads_chrome = pasta / "downloads_chrome"
        self.downloads_chrome.mkdir(parents=True)
        (self.perfil / "Default").mkdir(parents=True)
        preferencias = {"download": {"default_directory": str(self.downloads_chrome), "prompt_for_download": False}}
        (self.perfil / "Default" / "Preferences").write_text(json.dumps(preferencias), encoding="utf-8")
        regras = f"MAP {UX_HOST} 127.0.0.1,MAP {ENDPOINT_HOST} 127.0.0.1"
        # Os sites reais usam HTTPS; a bancada usa HTTP e o Chrome seguraria o download como inseguro.
        seguras = f"http://{UX_HOST}:{porta_site},http://{ENDPOINT_HOST}:{porta_site}"
        self.processo = subprocess.Popen(
            [
                str(executavel), *([] if os.environ.get("SIMPRESS_TESTE_COM_JANELA") == "1" else ["--headless=new"]),
                f"--remote-debugging-port={self.porta}",
                f"--user-data-dir={self.perfil}", "--no-first-run", "--no-default-browser-check",
                f"--window-size={largura},{altura}", f"--force-device-scale-factor={escala}",
                "--no-proxy-server", f"--host-resolver-rules={regras}",
                f"--unsafely-treat-insecure-origin-as-secure={seguras}", "about:blank",
            ],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        self.url = f"http://127.0.0.1:{self.porta}"
        limite = time.time() + 30
        while time.time() < limite:
            try:
                with urllib.request.urlopen(f"{self.url}/json/version", timeout=1):
                    return
            except OSError:
                time.sleep(0.3)
        self.fechar()
        raise RuntimeError("O Chrome da bancada não abriu a porta CDP.")

    def fechar(self) -> None:
        self.processo.terminate()
        try:
            self.processo.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.processo.kill()


def conexao_extra(url_cdp: str) -> None:
    """Outra conexão Playwright ao mesmo Chrome que entra e sai (como uma inspeção manual)."""
    codigo = (
        "import sys\nfrom playwright.sync_api import sync_playwright\n"
        "with sync_playwright() as p:\n    b = p.chromium.connect_over_cdp(sys.argv[1])\n    b.contexts[0].pages\n"
    )
    subprocess.run([sys.executable, "-c", codigo, url_cdp], check=True, timeout=60, capture_output=True)


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "playwright não está instalado")
class RotinaInventariosEmTodasAsTelasTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.executavel = localizar_navegador()
        if cls.executavel is None:
            raise unittest.SkipTest("Nem o Google Chrome nem o Chromium do Playwright foram encontrados.")
        cls.servidor = criar_servidor()
        cls.porta_site = cls.servidor.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.servidor.shutdown()
        cls.servidor.server_close()

    def rodar(self, largura: int, altura: int, escala: float, outra_conexao: bool = False) -> dict:
        """Roda exportar_ux_equipamentos e exportar_endpoint reais contra a bancada; devolve o resultado."""
        from playwright.sync_api import sync_playwright

        pasta = Path(tempfile.mkdtemp(prefix=".bancada-telas-"))
        self.addCleanup(shutil.rmtree, pasta, ignore_errors=True)
        chrome = ChromeDaBancada(self.executavel, pasta, largura, altura, escala, self.porta_site)
        self.addCleanup(chrome.fechar)
        mensagens: list[str] = []
        verboso = os.environ.get("SIMPRESS_TESTE_VERBOSO") == "1"

        def registrar(origem: str, msg: str) -> None:
            mensagens.append(f"[{origem}] {msg}")
            if verboso:
                print(f"{time.strftime('%H:%M:%S')} [{origem}] {msg}", flush=True)

        downloads = pasta / "downloads"
        with (
            patch.object(automacao, "DOWNLOADS_DIR", downloads),
            patch.object(automacao, "CHROME_PROFILE_DIR", chrome.perfil),
            patch.object(automacao, "ERROS_DIR", pasta / "erros"),
            patch.object(automacao, "UX_EQUIPAMENTOS_URL", f"http://{UX_HOST}:{self.porta_site}/MeusEquipamentos/Index"),
            patch.object(
                automacao, "ENDPOINT_URL",
                f"http://{ENDPOINT_HOST}:{self.porta_site}/webclient#/uems/inventory/computers",
            ),
            patch.object(automacao, "LOGIN_TIMEOUT_S", 20),
            patch.object(automacao, "COPIA_CHROME_S", 15),
            patch.object(automacao, "verificar_cancelamento"),
            patch.object(automacao, "avisar"),
            patch.object(automacao, "registrar_captura"),
            patch.object(automacao, "log", registrar),
            sync_playwright() as pw,
        ):
            browser = pw.chromium.connect_over_cdp(chrome.url)
            try:
                context = browser.contexts[0]
                sonda = context.new_page()
                sonda.goto(automacao.UX_EQUIPAMENTOS_URL)
                area = sonda.evaluate("[innerWidth, innerHeight]")
                saudacao_visivel = sonda.get_by_text("Olá, gabriel!").is_visible()
                sonda.close()
                if outra_conexao:
                    conexao_extra(chrome.url)
                ux = automacao.exportar_ux_equipamentos(context)
                if outra_conexao:
                    conexao_extra(chrome.url)
                endpoint = automacao.exportar_endpoint(context)
            except Exception as erro:
                raise AssertionError(f"Falhou em {largura}x{altura} (escala {escala}): {erro}\n" + "\n".join(mensagens))
            finally:
                browser.close()
        return {
            "area": area, "saudacao_visivel": saudacao_visivel, "ux": ux, "endpoint": endpoint,
            "mensagens": mensagens, "downloads": downloads, "downloads_chrome": chrome.downloads_chrome,
        }

    def conferir(self, resultado: dict, largura: int, altura: int, escala: float) -> None:
        contexto = f"{largura}x{altura} escala {escala} (área {resultado['area']})"
        for arquivo in (resultado["ux"], resultado["endpoint"]):
            self.assertEqual(arquivo.parent, resultado["downloads"], contexto)
            self.assertTrue(automacao.arquivo_valido(arquivo), f"{contexto}: {arquivo.name} inválido")
        self.assertTrue(resultado["ux"].name.startswith("EquipamentosDetalhes_"), contexto)
        self.assertTrue(resultado["endpoint"].name.startswith("InvAllComputersSummary"), contexto)
        vazios = [p.name for p in resultado["downloads"].iterdir() if p.stat().st_size == 0]
        self.assertEqual(vazios, [], f"{contexto}: downloads vazios deixados na pasta")
        pequena = resultado["area"][0] < automacao.TELA_MINIMA[0] or resultado["area"][1] < automacao.TELA_MINIMA[1]
        ajustou = any("a página será desenhada em" in m for m in resultado["mensagens"])
        self.assertEqual(ajustou, pequena, f"{contexto}: ajuste de tela inesperado")
        # A bancada precisa reproduzir o problema: abaixo de 1200 px a saudação some.
        self.assertEqual(resultado["saudacao_visivel"], resultado["area"][0] >= 1200, contexto)

    def test_exporta_ux_e_endpoint_em_cada_tamanho_de_janela(self):
        telas = TELAS_TODAS if os.environ.get("SIMPRESS_TESTE_TODAS_TELAS") == "1" else TELAS_PADRAO
        for largura, altura, escala in telas:
            with self.subTest(tela=f"{largura}x{altura}", escala=escala):
                self.conferir(self.rodar(largura, altura, escala), largura, altura, escala)

    def test_outra_conexao_ao_chrome_nao_gera_download_vazio(self):
        # Reproduz a falha real: outra conexão CDP troca o destino dos downloads e o Playwright
        # recebe 0 bytes; a rotina deve usar a cópia que o próprio Chrome gravou.
        resultado = self.rodar(800, 600, 1, outra_conexao=True)
        self.conferir(resultado, 800, 600, 1)
        self.assertTrue(
            any("cópia do Chrome" in m for m in resultado["mensagens"]),
            "A outra conexão não reproduziu o download vazio:\n" + "\n".join(resultado["mensagens"]),
        )


if __name__ == "__main__":
    unittest.main()
