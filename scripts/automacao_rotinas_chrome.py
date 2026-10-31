"""Automação das rotinas de OS e de inventários no Google Chrome com Playwright.

O Chrome de automação usa um perfil próprio (``~/.chrome-automation``) e fica
escutando a porta de depuração local 9333. O script se conecta a ele pelo CDP,
abre uma aba nova para cada sistema e deixa o navegador aberto no final, para
que os logins (Oracle, UX Simpress e Endpoint Central) continuem válidos entre
as execuções. O Chrome pessoal do usuário não é tocado.

Rotinas:
- ``os``: Oracle (Gestão de Solicitações) + UX (Acompanhamento de pedidos),
  lote em ``data/state/entrada_chamados``.
- ``inventarios``: UX (Meus equipamentos) + Endpoint Central (Todos os
  computadores), lote em ``data/state/entrada_automatica``.
- ``usuarios``: confere no Endpoint Central as pendências de usuário logado
  (``scripts/verificar_usuarios_endpoint.py``); também roda no fim de ``inventarios`` e ``ambas``.
- ``ambas``: as duas, em sequência.
- ``login``: abre Endpoint, UX e Oracle e adianta o que não é senha/MFA (domínio ``pr-sebrae`` e
  "Fazer login" no Endpoint com a senha já preenchida pelo Chrome; conta Microsoft da Simpress no UX e no
  Oracle); depois espera o usuário.
- ``dashboard``: baixa uma cópia do Dashboard Operacional_SEBRAE no Excel Online (só leitura),
  importa no site local e roda a busca de chamados novos (``sebrae``).

Cada exportação é clicada uma única vez; o arquivo é capturado pelo evento de
download do Playwright e gravado na pasta de Downloads com o nome original.
O login é sempre feito pelo usuário na janela do Chrome; o script apenas espera.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Callable

if TYPE_CHECKING:
    from playwright.sync_api import BrowserContext, Download, Page

ROOT = Path(__file__).resolve().parents[1]

ONEDRIVE_DOWNLOADS = Path(r"C:\Users\gakihiro\OneDrive - SEBRAE\Downloads")
DOWNLOADS_DIR = ONEDRIVE_DOWNLOADS if ONEDRIVE_DOWNLOADS.is_dir() else Path.home() / "Downloads"
CHROME_PROFILE_DIR = Path(os.environ.get("SIMPRESS_CHROME_PROFILE", str(Path.home() / ".chrome-automation")))
CDP_PORT = int(os.environ.get("SIMPRESS_CHROME_PORT", "9333"))
CDP_URL = f"http://127.0.0.1:{CDP_PORT}"
ERROS_DIR = ROOT / "data" / "logs" / "automacao_chrome"

CONTRATO = "16467"
CONTRATO_NOME = "16467 - SERV DE APOIO AS MICRO E PEQ EMP DO PARANA SEBRAE PR"
FILTRO_ORACLE = f"{CONTRATO}/%"

ORACLE_URL = "https://simpress.custhelp.com/AgentWeb/"
UX_PEDIDOS_URL = "https://ux.simpress.com.br/equipamentos/acompanhamento"
UX_EQUIPAMENTOS_URL = "https://ux.simpress.com.br/MeusEquipamentos/Index"
ENDPOINT_URL = "https://centralendpoint.pr.sebrae.com.br/webclient#/uems/inventory/computers"
# Telas de login abertas por `login` ("Abrir Chrome para login").
ENDPOINT_LOGIN_URL = "https://centralendpoint.pr.sebrae.com.br/client#/login"
UX_LOGIN_URL = "https://ux.simpress.com.br/ng/autenticacao/login"
ENDPOINT_USUARIO = os.environ.get("SIMPRESS_ENDPOINT_USUARIO", "gakihiro")
ENDPOINT_DOMINIO = "pr-sebrae"  # valor do <select name="domainName"> (padrão da tela: "Autenticação local")
# Pasta do SharePoint de onde `dashboard` baixa (Mais ações > Baixar) e que recebe o arquivo final gerado pelo site ("Atualizar Dashboard").
DASHBOARD_PASTA_URL = (
    "https://simpress-my.sharepoint.com/shared?id=%2Fpersonal%2Fjufsouza%5Fsimpress%5Fcom%5Fbr%2FDocuments%2FClientes%2FSEBRAE%2FDASHBOARD%20SEBRAE"
    "&listurl=%2Fpersonal%2Fjufsouza%5Fsimpress%5Fcom%5Fbr%2FDocuments&viewid=4b249dd9%2D2ef5%2D4757%2Da0e3%2D2aa051004ae2"
)
DASHBOARD_FINAL = "Dashboard Operacional_SEBRAE.xlsx"  # nome gravado por routers/sebrae_dashboard.py
# Cópia do último "Atualizar Dashboard" (gravada pelo site); é a que `enviar` sobe, nunca um arquivo de Downloads.
DASHBOARD_SAIDA_DIR = ROOT / "data" / "state" / "sebrae_dashboard_saida"
# Contas escolhidas/digitadas na tela da Microsoft (só o e-mail; senha e MFA são sempre do usuário).
EMAIL_DASHBOARD = os.environ.get("SIMPRESS_DASHBOARD_EMAIL", "gansouza@simpress.com.br")
EMAIL_SOFTEXPERT = os.environ.get("SIMPRESS_SOFTEXPERT_EMAIL", "gakihiro@pr.sebrae.com.br")

LOGIN_TIMEOUT_S = 10 * 60
CARREGAMENTO_MS = 90_000
DOWNLOAD_MS = 5 * 60_000
# Espera pela cópia que o próprio Chrome grava quando o Playwright recebe o download vazio.
COPIA_CHROME_S = 60
# Menor área (CSS px) em que os sites mantêm o layout de desktop usado pela rotina.
TELA_MINIMA = (1440, 720)
# Sinal de cancelamento: o painel local (ou ``--cancelar``) cria o arquivo e a rotina para no próximo ponto de espera.
CANCELAR_ARQUIVO = ROOT / "data" / "state" / "automacao_chrome.cancelar"
_inicio_execucao = 0.0


class RotinaErro(RuntimeError):
    """Falha de uma etapa que interrompe a rotina sem repetir cliques."""


class RotinaCancelada(BaseException):
    """Pedido de cancelamento; deriva de BaseException para não ser engolido por ``except Exception``."""


def pedir_cancelamento() -> None:
    CANCELAR_ARQUIVO.parent.mkdir(parents=True, exist_ok=True)
    CANCELAR_ARQUIVO.write_text(agora_iso(), encoding="utf-8")


def apagar_sinal_cancelamento() -> None:
    try:
        CANCELAR_ARQUIVO.unlink(missing_ok=True)
    except OSError:
        pass


def iniciar_controle_cancelamento() -> None:
    """Descarta um sinal deixado por execução anterior; só pedidos feitos depois do início valem."""
    global _inicio_execucao
    _inicio_execucao = time.time()
    apagar_sinal_cancelamento()


def cancelamento_pedido() -> bool:
    try:
        # Folga de 2 s: o relógio de arquivos do Windows é mais grosso que time.time().
        return CANCELAR_ARQUIVO.stat().st_mtime >= _inicio_execucao - 2
    except OSError:
        return False


def verificar_cancelamento(detalhe: str = "") -> None:
    if cancelamento_pedido():
        raise RotinaCancelada(detalhe)


def aguardar_estado(locator, state: str, timeout_ms: int | None = None) -> None:
    """``locator.wait_for`` em fatias de 1 s, conferindo o pedido de cancelamento entre elas."""
    from playwright.sync_api import TimeoutError as PlaywrightTimeout

    limite = time.time() + (CARREGAMENTO_MS if timeout_ms is None else timeout_ms) / 1000
    while True:
        verificar_cancelamento()
        restante = int((limite - time.time()) * 1000)
        try:
            locator.wait_for(state=state, timeout=max(1, min(1000, restante)))
            return
        except PlaywrightTimeout:
            if restante <= 1000:
                raise


def acionar_quando_pronto(
    acao,
    descricao: str,
    timeout_ms: int | None = None,
    confirmar=None,
    intervalo_s: float = 1.0,
) -> None:
    """Repete ``acao`` até funcionar (e ``confirmar()``, se houver, ser verdadeiro).

    Serve para telas que já mostram o elemento no DOM enquanto ainda exibem o esqueleto de
    carregamento: o clique falha ou não tem efeito até a tela ficar pronta. Confere o pedido de
    cancelamento a cada tentativa e, esgotado o prazo, levanta ``RotinaErro`` com a descrição.
    """
    limite = time.time() + (CARREGAMENTO_MS if timeout_ms is None else timeout_ms) / 1000
    ultimo_erro = ""
    while True:
        verificar_cancelamento()
        if confirmar is not None and confirmar():
            return
        try:
            acao()
            if confirmar is None or confirmar():
                return
            ultimo_erro = "a ação não teve efeito"
        except Exception as erro:
            ultimo_erro = str(erro).strip().splitlines()[0] if str(erro).strip() else type(erro).__name__
        if time.time() >= limite:
            segundos = (CARREGAMENTO_MS if timeout_ms is None else timeout_ms) // 1000
            raise RotinaErro(f"{descricao}: a tela não ficou pronta em {segundos} s ({ultimo_erro}).")
        time.sleep(intervalo_s)


def log(origem: str, mensagem: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] [{origem}] {mensagem}", flush=True)


def avisar(titulo: str, mensagem: str) -> None:
    """Aviso do Windows (melhor esforço; ``SIMPRESS_AVISOS=0`` desliga)."""
    try:
        from scripts.avisos_windows import notificar
    except ImportError:
        from avisos_windows import notificar  # type: ignore[no-redef]
    notificar(titulo, mensagem, log=lambda texto: log("Aviso do Windows", texto))


def agora_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


# --------------------------------------------------------------------------
# Log por execução (data/logs/automacao_chrome/<AAAAMMDD_HHMMSS>_<rotina>.log + .json)
# --------------------------------------------------------------------------

LOGS_MANTIDOS = 100


class _Espelho:
    """Repete no arquivo de log tudo o que vai para o console, com flush a cada escrita."""

    def __init__(self, console, execucao: "ExecucaoLog") -> None:
        self.console = console
        self.execucao = execucao
        self.pendente = ""

    def write(self, texto: str) -> int:
        self.console.write(texto)
        self.execucao.gravar(texto)
        self.pendente += texto
        *linhas, self.pendente = self.pendente.split("\n")
        for linha in linhas:
            if linha.startswith("[FALHA] "):
                self.execucao.falhas.append(linha[len("[FALHA] "):].strip())
        return len(texto)

    def flush(self) -> None:
        self.console.flush()

    def __getattr__(self, nome: str):
        return getattr(self.console, nome)


class ExecucaoLog:
    def __init__(self, rotina: str, pasta: Path) -> None:
        pasta.mkdir(parents=True, exist_ok=True)
        self.rotina = rotina
        self.caminho = nome_livre(pasta, f"{datetime.now():%Y%m%d_%H%M%S}_{rotina}.log")
        self.resumo_caminho = self.caminho.with_suffix(".json")
        self.inicio = agora_iso()
        self.lotes: list[str] = []
        self.capturas: list[str] = []
        self.falhas: list[str] = []
        self.arquivo = self.caminho.open("w", encoding="utf-8", newline="\n")
        self.originais = (sys.stdout, sys.stderr)
        sys.stdout = _Espelho(sys.stdout, self)  # type: ignore[assignment]
        sys.stderr = _Espelho(sys.stderr, self)  # type: ignore[assignment]
        self.salvar_resumo("em_andamento", None, None)

    def gravar(self, texto: str) -> None:
        if not self.arquivo.closed:
            self.arquivo.write(texto)
            self.arquivo.flush()

    def salvar_resumo(self, status: str, codigo: int | None, fim: str | None, mensagem: str = "") -> None:
        resumo = {
            "rotina": self.rotina,
            "inicio": self.inicio,
            "fim": fim,
            "status": status,
            "codigo": codigo,
            "mensagem": mensagem,
            "log": str(self.caminho),
            "lotes": self.lotes,
            "capturas": self.capturas,
        }
        temporario = self.resumo_caminho.with_suffix(".json.tmp")
        temporario.write_text(json.dumps(resumo, ensure_ascii=False, indent=2), encoding="utf-8")
        temporario.replace(self.resumo_caminho)

    def finalizar(self, codigo: int) -> None:
        sys.stdout, sys.stderr = self.originais
        if codigo == 0:
            status, mensagem = "concluido", ""
        elif codigo == 130:
            status, mensagem = "cancelado", "Rotina interrompida pelo usuário."
        else:
            status = "falha"
            mensagem = " | ".join(self.falhas) or f"A rotina terminou com código {codigo}."
        rotulos = {"concluido": "concluído", "cancelado": "cancelado", "falha": "falha"}
        linha = f"[{datetime.now():%H:%M:%S}] [Execução] Status: {rotulos[status]} (código {codigo})"
        self.gravar(f"\n{linha}" + (f": {mensagem}" if status == "falha" else "") + "\n")
        self.arquivo.close()
        self.salvar_resumo(status, codigo, agora_iso(), mensagem)


_EXECUCAO: ExecucaoLog | None = None


def limpar_logs_antigos(pasta: Path, manter: int = LOGS_MANTIDOS) -> None:
    """Mantém os ``manter`` logs mais recentes (e seus .json); capturas .png não são tocadas."""
    # Os .site.log/.site.json são da tela Automação do site, que limpa os próprios registros.
    proprios = [log for log in pasta.glob("*.log") if not log.name.endswith(".site.log")]
    for antigo in sorted(proprios, reverse=True)[manter:]:
        for arquivo in (antigo, antigo.with_suffix(".json")):
            try:
                arquivo.unlink(missing_ok=True)
            except OSError:
                pass


def iniciar_log_execucao(rotina: str) -> Path:
    global _EXECUCAO
    if _EXECUCAO is not None:
        return _EXECUCAO.caminho
    _EXECUCAO = ExecucaoLog(rotina, ERROS_DIR)
    limpar_logs_antigos(ERROS_DIR)
    return _EXECUCAO.caminho


def finalizar_log_execucao(codigo: int) -> int:
    """Grava a linha de status e o resumo JSON; devolve o próprio código para o ``SystemExit``."""
    global _EXECUCAO
    if _EXECUCAO is not None:
        execucao, _EXECUCAO = _EXECUCAO, None
        execucao.finalizar(codigo)
    return codigo


def caminho_log_atual() -> Path | None:
    """Caminho do log da execução em andamento (``None`` fora de uma execução)."""
    return _EXECUCAO.caminho if _EXECUCAO is not None else None


def registrar_lote(lote_id: str) -> None:
    if _EXECUCAO is not None:
        _EXECUCAO.lotes.append(lote_id)
        _EXECUCAO.salvar_resumo("em_andamento", None, None)


def registrar_captura(caminho: Path) -> None:
    if _EXECUCAO is not None:
        _EXECUCAO.capturas.append(str(caminho))
        _EXECUCAO.salvar_resumo("em_andamento", None, None)


# --------------------------------------------------------------------------
# Chrome de automação (porta própria, perfil próprio, sobrevive ao script)
# --------------------------------------------------------------------------

def localizar_chrome() -> Path:
    candidatos = [
        Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe",
    ]
    for caminho in candidatos:
        if caminho.is_file():
            return caminho
    raise RotinaErro("Google Chrome não encontrado. Instale o Chrome ou ajuste localizar_chrome().")


def cdp_ativo() -> bool:
    try:
        with urllib.request.urlopen(f"{CDP_URL}/json/version", timeout=2) as resposta:
            return resposta.status == 200
    except OSError:
        return False


def encerrar_chrome_do_perfil() -> int:
    """Fecha só os processos do Chrome que usam o perfil de automação."""
    perfil = str(CHROME_PROFILE_DIR).replace("'", "''")
    comando = (
        "$n=0; Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | "
        f"Where-Object {{ $_.CommandLine -like '*--user-data-dir=*{perfil}*' }} | "
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }; $n"
    )
    resultado = subprocess.run(
        ["powershell", "-NoProfile", "-Command", comando], capture_output=True, text=True, check=False
    )
    try:
        return int((resultado.stdout or "0").strip().splitlines()[-1])
    except (ValueError, IndexError):
        return 0


def garantir_chrome() -> None:
    """Reaproveita o Chrome de automação na porta CDP ou o inicia destacado do script."""
    if cdp_ativo():
        log("Chrome", f"Reaproveitando o Chrome de automação na porta {CDP_PORT}.")
        return
    # Uma janela antiga do perfil sem a porta (por exemplo, da versão anterior) bloqueia o perfil.
    if encerrar_chrome_do_perfil():
        log("Chrome", "Janela antiga do perfil de automação fechada para liberar o perfil.")
        time.sleep(2)
    CHROME_PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    flags = 0
    if os.name == "nt":
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    subprocess.Popen(
        [
            str(localizar_chrome()),
            f"--remote-debugging-port={CDP_PORT}",
            f"--user-data-dir={CHROME_PROFILE_DIR}",
            "--no-first-run",
            "--no-default-browser-check",
            "--start-maximized",
            # Sem isto o Chrome descarta os cookies de sessão ao fechar e o Endpoint Central pede
            # o login de novo; com a restauração da última sessão eles ficam no perfil.
            "--restore-last-session",
            "about:blank",
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=flags,
        close_fds=True,
    )
    limite = time.time() + 30
    while time.time() < limite:
        if cdp_ativo():
            log("Chrome", f"Chrome de automação iniciado (porta {CDP_PORT}, perfil {CHROME_PROFILE_DIR}).")
            return
        time.sleep(0.5)
    raise RotinaErro(f"O Chrome não abriu a porta {CDP_PORT}. Feche as janelas do perfil de automação e tente de novo.")


# --------------------------------------------------------------------------
# Utilidades de página
# --------------------------------------------------------------------------

def visivel(locator) -> bool:
    try:
        return locator.filter(visible=True).count() > 0
    except Exception:
        return False


def esperar_visivel(locator, timeout_ms: int) -> bool:
    try:
        locator.filter(visible=True).first.wait_for(state="visible", timeout=timeout_ms)
        return True
    except Exception:
        return False


def presente(locator) -> bool:
    """Existe no DOM, mesmo oculto (por exemplo, num menu recolhido de tela estreita)."""
    try:
        return locator.count() > 0
    except Exception:
        return False


# Abas desenhadas em TELA_MINIMA: a sessão CDP guardada mantém a emulação viva.
_telas_ajustadas: dict = {}


def tamanho_emulado(largura: int, altura: int) -> tuple[int, int] | None:
    """Tamanho a emular para a área atual da aba, ou None se ela já comporta o layout de desktop."""
    if largura >= TELA_MINIMA[0] and altura >= TELA_MINIMA[1]:
        return None
    return max(largura, TELA_MINIMA[0]), max(altura, TELA_MINIMA[1])


def garantir_tela_minima(page: "Page", origem: str) -> None:
    """Com a janela do Chrome pequena, desenha a aba em TELA_MINIMA sem redimensionar a janela.

    Os sites escondem menus e saudações em telas estreitas e a rotina deixaria de achá-los.
    A emulação vale só enquanto a sessão CDP existir: some ao liberar a aba, ao fechá-la ou
    quando a rotina termina, mesmo após erro.
    """
    try:
        if page in _telas_ajustadas or page.is_closed():
            return
        largura, altura = page.evaluate("() => [window.innerWidth, window.innerHeight]")
        tamanho = tamanho_emulado(int(largura), int(altura))
        if tamanho is None:
            return
        sessao = page.context.new_cdp_session(page)
        sessao.send(
            "Emulation.setDeviceMetricsOverride",
            {"width": tamanho[0], "height": tamanho[1], "deviceScaleFactor": 0, "mobile": False},
        )
    except Exception as erro:
        log(origem, f"Não foi possível ajustar o tamanho da página ({descrever_erro(erro)}); seguindo com o da janela.")
        return
    _telas_ajustadas[page] = sessao
    page.once("close", lambda *_: _telas_ajustadas.pop(page, None))
    log(origem, f"Janela pequena ({largura}x{altura}); a página será desenhada em {tamanho[0]}x{tamanho[1]}.")


def liberar_tela_minima(page: "Page") -> None:
    """Volta a aba ao tamanho real da janela (por exemplo, para o usuário fazer o login)."""
    sessao = _telas_ajustadas.pop(page, None)
    if sessao is None:
        return
    try:
        sessao.send("Emulation.clearDeviceMetricsOverride")
        sessao.detach()
    except Exception:
        pass


def nova_aba(context: "BrowserContext", url: str, origem: str) -> "Page":
    verificar_cancelamento()
    page = context.new_page()
    log(origem, f"Abrindo {url}")
    page.goto(url, wait_until="domcontentloaded", timeout=CARREGAMENTO_MS)
    garantir_tela_minima(page, origem)
    return page


def clicar_sso(page: "Page", origem: str) -> bool:
    """Clica uma vez no botão/link "SSO" visível da tela de login (em qualquer frame), se existir."""
    nome = re.compile(r"^\s*SSO\s*$", re.IGNORECASE)
    for frame in page.frames:
        for candidato in (
            frame.get_by_role("button", name=nome),
            frame.get_by_role("link", name=nome),
            frame.get_by_text("SSO", exact=True),
        ):
            try:
                alvo = candidato.filter(visible=True)
                if alvo.count():
                    log(origem, "Clicando em 'SSO'...")
                    alvo.first.click()
                    return True
            except Exception:
                continue
    return False


def aguardar_login(
    page: "Page",
    origem: str,
    logado: Callable[["Page"], bool],
    entrar: Callable[["Page"], bool] | None = None,
    email: str | None = None,
    esperar_usuario: bool = True,
    apos_acao_s: int = 45,
) -> bool:
    """Espera o login sem digitar senha nem MFA (no máximo o e-mail, em ``entrar``).

    ``entrar`` pode acionar uma única vez o acesso com a conta já conectada (SSO);
    ``email`` escolhe essa conta (ou digita o e-mail) na tela da Microsoft, se ela aparecer.
    Se o login não concluir, o usuário é chamado para entrar na própria janela.
    Com ``esperar_usuario=False`` só faz as tentativas automáticas e devolve ``False`` sem esperar o
    usuário (quem chama espera várias abas juntas); devolve ``True`` quando a aba já está logada.
    """
    limite = time.time() + 15
    tentou_entrar = escolheu_conta = clicou_sso = False
    while time.time() < limite:  # dá tempo para redirecionamentos de SSO
        verificar_cancelamento()
        if logado(page):
            log(origem, "Sessão ativa.")
            garantir_tela_minima(page, origem)
            return True
        if email and not clicou_sso and "microsoftonline" not in page.url.lower() and clicar_sso(page, origem):
            clicou_sso = True
            limite = time.time() + apos_acao_s
        if email and not escolheu_conta and "microsoftonline" in page.url.lower():
            escolheu_conta = True
            entrar_microsoft(page, origem, email, concluido=logado)
            limite = time.time() + apos_acao_s
        if entrar is not None and not tentou_entrar and entrar(page):
            tentou_entrar = True
            limite = time.time() + apos_acao_s
        page.wait_for_timeout(1000)
    if tentou_entrar:
        log(origem, "O acesso com a conta conectada não concluiu o login.")
    liberar_tela_minima(page)  # o login aparece no tamanho real da janela
    if not esperar_usuario:
        return False
    page.bring_to_front()
    log(origem, "AÇÃO NECESSÁRIA: faça o login na janela do Chrome de automação.")
    avisar(f"Simpress: login necessário no {origem}", "Faça o login na janela do Chrome de automação; a rotina continua sozinha.")
    log(origem, "A rotina continua sozinha assim que o login terminar (Ctrl+C ou --cancelar interrompe).")
    limite = time.time() + LOGIN_TIMEOUT_S
    aviso_metade_enviado = False
    while time.time() < limite:
        verificar_cancelamento()
        if logado(page):
            log(origem, "Login detectado; continuando.")
            page.wait_for_timeout(2000)
            garantir_tela_minima(page, origem)
            return True
        if not aviso_metade_enviado and time.time() >= limite - LOGIN_TIMEOUT_S / 2:
            aviso_metade_enviado = True
            minutos_restantes = LOGIN_TIMEOUT_S // 60 // 2
            log(origem, f"Login ainda pendente; faltam cerca de {minutos_restantes} min para o tempo esgotar.")
            avisar(f"Simpress: login ainda pendente no {origem}", "Faça o login na janela do Chrome de automação antes que o tempo esgote.")
        page.wait_for_timeout(2000)
    raise RotinaErro(f"Login não concluído em {LOGIN_TIMEOUT_S // 60} minutos.")


def entrar_microsoft(
    page: "Page",
    origem: str,
    email: str,
    concluido: Callable[["Page"], bool] | None = None,
    espera_s: int = 30,
) -> None:
    """Na tela de login da Microsoft: clica na conta ``email`` ou, sem ela, em "Use another account",
    digita só o e-mail e avança. Nunca digita senha nem MFA: depois disso o usuário assume.

    Cada passo é feito uma única vez; termina ao aparecer a senha, quando ``concluido(page)`` ficar
    verdadeiro ou ao esgotar ``espera_s``.
    """
    escolheu = digitou = False
    escolhas = 0
    ultima_escolha = 0.0
    limite = time.time() + espera_s
    while time.time() < limite:
        verificar_cancelamento()
        if page.is_closed() or (concluido is not None and concluido(page)):
            return
        if "microsoftonline" not in page.url.lower():
            page.wait_for_timeout(500)
            continue
        if visivel(page.locator("input[type='password']")):
            return
        # A lista de contas pode voltar (por exemplo, no recarregamento do SSO): escolhe de novo, no máximo 3 vezes.
        if escolheu and escolhas < 3 and time.time() - ultima_escolha >= 10:
            escolheu = False
        if not escolheu and not digitou:
            # Só a conta pedida, pelo e-mail exato: nunca outra conta da lista (por exemplo, a do Sebrae).
            conta = page.get_by_text(re.compile(rf"^\s*{re.escape(email)}\s*$", re.IGNORECASE)).filter(visible=True)
            campo = page.locator("input[type='email'], input[name='loginfmt']").filter(visible=True)
            # "Use another account", "Another account", "Acessar Outra Conta", "Outra Conta".
            outra = page.get_by_text(re.compile(r"(another|outra)\s+(account|conta)", re.IGNORECASE)).filter(visible=True)
            if conta.count() and not campo.count():
                log(origem, f"Escolhendo a conta {email}...")
                conta.first.click()
                escolheu = True
                escolhas += 1
                ultima_escolha = time.time()
            elif campo.count():
                log(origem, f"Digitando o e-mail {email} e avançando (a senha fica com você)...")
                campo.first.fill(email)
                avancar = page.locator("#idSIButton9, input[type='submit']").filter(visible=True)
                if avancar.count():
                    avancar.first.click()
                else:
                    campo.first.press("Enter")
                digitou = True
            elif outra.count():
                log(origem, "Conta não listada; clicando em 'Outra Conta'...")
                outra.first.click()
        page.wait_for_timeout(500)


def nome_livre(pasta: Path, nome: str) -> Path:
    """Mesmo padrão do Chrome: 'arquivo (1).xlsx' quando o nome já existe."""
    destino = pasta / nome
    contador = 1
    while destino.exists():
        destino = pasta / f"{Path(nome).stem} ({contador}){Path(nome).suffix}"
        contador += 1
    return destino


def arquivo_valido(arquivo: Path) -> bool:
    """Não vazio e, para XLSX/ZIP, com a assinatura de ZIP (o XLSX também é um ZIP)."""
    try:
        if arquivo.stat().st_size == 0:
            return False
    except OSError:
        return False
    return arquivo.suffix.lower() not in (".xlsx", ".zip") or zipfile.is_zipfile(arquivo)


def pastas_download_chrome() -> list[Path]:
    """Pastas onde o próprio Chrome de automação pode ter gravado o arquivo."""
    pastas = [DOWNLOADS_DIR]
    try:
        preferencias = json.loads((CHROME_PROFILE_DIR / "Default" / "Preferences").read_text(encoding="utf-8"))
        padrao = (preferencias.get("download") or {}).get("default_directory")
        if padrao:
            pastas.append(Path(padrao))
    except (OSError, ValueError, AttributeError):
        pass
    pastas.append(Path.home() / "Downloads")
    unicas: list[Path] = []
    for pasta in pastas:
        if pasta not in unicas:
            unicas.append(pasta)
    return unicas


def padrao_do_nome(nome: str) -> "re.Pattern[str]":
    """'nome.ext' e as variações 'nome (N).ext' que o Chrome cria quando o nome já existe."""
    sugerido = Path(nome)
    return re.compile(re.escape(sugerido.stem) + r"(?: \(\d+\))?" + re.escape(sugerido.suffix), re.IGNORECASE)


def padrao_do_prefixo(prefixo: str) -> "re.Pattern[str]":
    """Exportação esperada pelo início do nome (expressão regular), em XLSX ou ZIP."""
    return re.compile(f"(?:{prefixo})" + r".*\.(?:xlsx|zip)", re.IGNORECASE)


def copia_do_chrome(padrao: "re.Pattern[str]", desde: float, ignorar: Path | None = None) -> Path | None:
    """Arquivo válido mais recente que o próprio Chrome gravou com esse nome a partir de ``desde``."""
    achados: list[tuple[float, Path]] = []
    for pasta in pastas_download_chrome():
        try:
            arquivos = list(pasta.iterdir())
        except OSError:
            continue
        for arquivo in arquivos:
            if arquivo == ignorar or not padrao.fullmatch(arquivo.name):
                continue
            try:
                modificado = arquivo.stat().st_mtime
            except OSError:
                continue
            if modificado >= desde - 1 and arquivo_valido(arquivo):
                achados.append((modificado, arquivo))
    return max(achados)[1] if achados else None


def usar_copia_do_chrome(copia: Path, origem: str) -> Path:
    """Traz para DOWNLOADS_DIR (onde a importação procura) o arquivo que o Chrome gravou em outra pasta."""
    if copia.parent != DOWNLOADS_DIR:
        DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
        destino = nome_livre(DOWNLOADS_DIR, copia.name)
        shutil.copy2(copia, destino)
        copia = destino
    log(origem, f"Arquivo salvo (cópia do Chrome): {copia.name} ({copia.stat().st_size:,} bytes)".replace(",", "."))
    return copia


def salvar_download(download: "Download", origem: str, desde: float | None = None) -> Path:
    """Grava o download e confere o conteúdo.

    Se outra conexão ao Chrome (porta 9333) trocar o comportamento de download, o Chrome grava o
    arquivo direto na pasta dele e o Playwright entrega uma cópia vazia: nesse caso usa a cópia do Chrome.
    """
    falha = download.failure()
    if falha:
        raise RotinaErro(f"Download falhou: {falha}")
    desde = time.time() - DOWNLOAD_MS / 1000 if desde is None else desde
    DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
    nome = download.suggested_filename
    destino = nome_livre(DOWNLOADS_DIR, nome)
    try:
        download.save_as(destino)
    except Exception as erro:
        log(origem, f"O Playwright não conseguiu gravar o download ({descrever_erro(erro)}).")
    if arquivo_valido(destino):
        log(origem, f"Arquivo salvo: {destino.name} ({destino.stat().st_size:,} bytes)".replace(",", "."))
        return destino

    tamanho = destino.stat().st_size if destino.exists() else 0
    log(origem, f"O arquivo recebido veio inválido ({tamanho} bytes); procurando a cópia gravada pelo próprio Chrome...")
    # A cópia inválida sai do caminho: a importação escolhe o download mais recente pelo nome.
    if destino.exists():
        if tamanho == 0:
            destino.unlink()
        else:
            destino.replace(nome_livre(destino.parent, destino.name + ".invalido"))
    padrao = padrao_do_nome(nome)
    limite = time.time() + COPIA_CHROME_S
    copia = copia_do_chrome(padrao, desde, destino)
    while copia is None and time.time() < limite:
        verificar_cancelamento()
        time.sleep(1)
        copia = copia_do_chrome(padrao, desde, destino)
    if copia is None:
        raise RotinaErro(
            f"O download de {nome} chegou vazio e o Chrome não gravou uma cópia válida em "
            f"{', '.join(str(p) for p in pastas_download_chrome())}."
        )
    return usar_copia_do_chrome(copia, origem)


def exportar_com_download(page: "Page", origem: str, clicar: Callable[[], None], prefixo: "str | re.Pattern[str] | None" = None) -> Path:
    """Clica uma única vez na exportação e grava o arquivo recebido.

    Com ``prefixo`` (início esperado do nome, ou um padrão já pronto do nome inteiro), também aceita o
    arquivo que o próprio Chrome gravar quando o aviso de download não chega ao Playwright (outra
    conexão à porta 9333 trocou o destino).
    """
    verificar_cancelamento()
    garantir_tela_minima(page, origem)
    desde = time.time()
    padrao = prefixo if isinstance(prefixo, re.Pattern) else padrao_do_prefixo(prefixo) if prefixo else None
    recebidos: list["Download"] = []

    def receber_download(download: "Download") -> None:
        # Playwright guarda atributos no callback; list.append não os aceita.
        recebidos.append(download)

    page.once("download", receber_download)
    try:
        clicar()
        limite = time.time() + DOWNLOAD_MS / 1000
        while not recebidos:  # espera em fatias para atender a um pedido de cancelamento
            if time.time() >= limite:
                raise RotinaErro(f"O download não começou em {DOWNLOAD_MS // 60_000} minutos.")
            verificar_cancelamento()
            page.wait_for_timeout(500)
            copia = copia_do_chrome(padrao, desde) if padrao is not None and not recebidos else None
            if copia is not None:
                log(origem, "O aviso de download não chegou ao Playwright; usando o arquivo gravado pelo Chrome.")
                return usar_copia_do_chrome(copia, origem)
        return salvar_download(recebidos[0], origem, desde)
    finally:
        page.remove_listener("download", receber_download)


def registrar_erro(page: "Page | None", origem: str) -> None:
    if page is None or page.is_closed():
        return
    try:
        ERROS_DIR.mkdir(parents=True, exist_ok=True)
        caminho = ERROS_DIR / f"{datetime.now():%Y%m%d_%H%M%S}_{origem.replace(' ', '_')}.png"
        page.screenshot(path=str(caminho))
        registrar_captura(caminho)
        log(origem, f"Captura da tela no erro: {caminho}")
    except Exception:
        pass


# --------------------------------------------------------------------------
# Oracle Service Cloud
# --------------------------------------------------------------------------

def oracle_logado(page: "Page") -> bool:
    return "custhelp.com/agentweb" in page.url.lower() and visivel(
        page.get_by_role("button", name="Navigation", exact=True)
    )


def reabrir_filtros_oracle(page: "Page", campo) -> bool:
    """Gestão de Solicitações aberta com resultados: o funil "Pesquisar" da barra reabre os filtros."""
    if not visivel(page.get_by_text(re.compile(r"Registros:\s*Total"))):
        return False
    funil = page.locator("button", has_text=re.compile(r"^\s*Pesquisar\s*$")).filter(visible=True)
    if not visivel(funil):
        return False
    log("Oracle", "Gestão de Solicitações aberta com resultados; reabrindo os filtros.")
    funil.first.click()
    return esperar_visivel(campo, 15000)


def abrir_pelo_menu_oracle(page: "Page") -> None:
    log("Oracle", "Abrindo pelo Menu: ☰ > Operação > Gestão > Gestão de Solicitações...")
    page.get_by_role("button", name="Navigation", exact=True).filter(visible=True).first.click()
    item = page.get_by_role("link", name="Gestão de Solicitações", exact=True).filter(visible=True)
    if not esperar_visivel(item, 3000):
        # Os grupos do menu alternam ao clicar: só abre o que estiver fechado.
        gestao = page.get_by_text("Gestão", exact=True).filter(visible=True)
        if not esperar_visivel(gestao, 2000):
            page.get_by_text("Operação", exact=True).filter(visible=True).first.click()
            gestao.first.wait_for(state="visible", timeout=10000)
        gestao.first.click()
        item.first.wait_for(state="visible", timeout=10000)
    item.first.click()


def abrir_gestao_solicitacoes(page: "Page", tentativas: int = 3):
    """Devolve o campo Contrato/Item, abrindo a Gestão de Solicitações só quando preciso.

    1. Se a Gestão de Solicitações já aparece ao abrir o Oracle, segue direto para o campo.
    2. Senão, abre pelo Menu.
    3. Se o Menu falhar, recarrega o Oracle e abre pelo Menu de novo.
    """
    campo = page.get_by_role("textbox", name="Contrato/Item", exact=True).filter(visible=True)
    if esperar_visivel(campo, 8000) or reabrir_filtros_oracle(page, campo):
        log("Oracle", "Gestão de Solicitações já estava na tela.")
        return campo.first
    for tentativa in range(1, tentativas + 1):
        try:
            abrir_pelo_menu_oracle(page)
            if esperar_visivel(campo, 20000) or reabrir_filtros_oracle(page, campo):
                return campo.first
            log("Oracle", f"O Menu não exibiu o campo Contrato/Item (tentativa {tentativa}/{tentativas}).")
        except Exception as erro:
            log("Oracle", f"Falha ao abrir pelo Menu (tentativa {tentativa}/{tentativas}): {descrever_erro(erro)}")
        if tentativa < tentativas:
            log("Oracle", "Recarregando o Oracle para abrir pelo Menu novamente...")
            page.keyboard.press("Escape")
            page.reload(wait_until="domcontentloaded", timeout=CARREGAMENTO_MS)
            aguardar_login(page, "Oracle", oracle_logado, email=EMAIL_DASHBOARD)
            if esperar_visivel(campo, 8000) or reabrir_filtros_oracle(page, campo):
                return campo.first
    raise RotinaErro("Não foi possível abrir a Gestão de Solicitações pelo Menu do Oracle.")


def exportar_oracle(context: "BrowserContext") -> Path:
    page = nova_aba(context, ORACLE_URL, "Oracle")
    try:
        aguardar_login(page, "Oracle", oracle_logado, email=EMAIL_DASHBOARD)
        campo = abrir_gestao_solicitacoes(page)

        log("Oracle", f"Preenchendo Contrato/Item com {FILTRO_ORACLE}...")
        campo.click()
        campo.press("Control+A")
        campo.press_sequentially(FILTRO_ORACLE, delay=60)
        campo.press("Tab")
        if campo.input_value().strip() != FILTRO_ORACLE:
            campo.fill(FILTRO_ORACLE)
        if campo.input_value().strip() != FILTRO_ORACLE:
            raise RotinaErro(f"O campo Contrato/Item ficou com {campo.input_value()!r}.")

        log("Oracle", "Pesquisando...")
        page.get_by_role("button", name="Pesquisar", exact=True).filter(visible=True).first.click()
        total = page.get_by_text(re.compile(r"Registros:\s*Total")).filter(visible=True).first
        aguardar_estado(total, "visible")
        log("Oracle", f"Pesquisa concluída ({total.inner_text().strip()}).")

        log("Oracle", "Exportando: ⋮ > Exportar > Excel...")
        page.locator("button.runtimeOptions").filter(visible=True).first.click()
        excel = page.locator('button[automationid$="coreExcelExport"]').filter(visible=True)
        submenu = page.locator("button.ws-submenu-menu-button.Exportar").filter(visible=True).first
        submenu.wait_for(state="visible", timeout=10000)
        submenu.hover()
        if not visivel(excel):
            submenu.click()
        excel.first.wait_for(state="visible", timeout=10000)
        arquivo = exportar_com_download(page, "Oracle", excel.first.click, r"Gest[ãa]o de Solicita[çc][õo]es")
    except Exception:
        registrar_erro(page, "Oracle")
        raise
    page.close()
    return arquivo


# --------------------------------------------------------------------------
# UX Simpress
# --------------------------------------------------------------------------

def ux_logado(page: "Page") -> bool:
    # "Olá, <nome>" fica num menu recolhido em janelas estreitas: basta existir na página.
    url = page.url.lower()
    return "ux.simpress.com.br" in url and "autenticacao" not in url and "login" not in url and presente(
        page.get_by_text(re.compile(r"^\s*Olá,", re.IGNORECASE))
    )


def ux_entrar(page: "Page") -> bool:
    """Na tela de autenticação do UX, clica uma vez em "Acesso Time Simpress" (SSO da conta conectada)."""
    if "autenticacao" not in page.url.lower():
        return False
    botao = page.locator("#loginAzID")
    if not visivel(botao):
        botao = page.get_by_role("button", name=re.compile(r"acesso\s+time\s+simpress", re.IGNORECASE))
    if not visivel(botao):
        return False
    log("UX Simpress", "Tela de login: clicando em 'Acesso Time Simpress' com a conta conectada...")
    botao.filter(visible=True).first.click()
    return True


def abrir_ux(context: "BrowserContext", url: str) -> "Page":
    page = nova_aba(context, url, "UX Simpress")
    aguardar_login(page, "UX Simpress", ux_logado, entrar=ux_entrar, email=EMAIL_DASHBOARD)
    filtro = page.locator("#CodigosContratosFiltro")
    for tentativa in range(3):
        # Depois do SSO o UX pode redirecionar para o Dashboard alguns segundos depois; volta para a tela pedida.
        if page.url.lower().startswith(url.lower()) and esperar_visivel(filtro, 20000):
            return page
        log("UX Simpress", f"Tela atual {page.url}; voltando para {url}...")
        page.goto(url, wait_until="domcontentloaded", timeout=CARREGAMENTO_MS)
        aguardar_login(page, "UX Simpress", ux_logado, entrar=ux_entrar, email=EMAIL_DASHBOARD)
    if not esperar_visivel(filtro, 30000):
        raise RotinaErro(f"A tela {url} não carregou o filtro Contrato/Nome.")
    return page


def aguardar_ux_livre(page: "Page") -> None:
    """Espera sumir o aviso "Aguarde..." que o UX mostra enquanto carrega."""
    aguardar_estado(page.get_by_text("Aguarde...", exact=True).filter(visible=True).first, "hidden")


def selecionar_contrato_ux(page: "Page") -> None:
    campo = page.locator("#CodigosContratosFiltro").first
    aguardar_estado(campo, "visible")
    aguardar_ux_livre(page)
    log("UX Simpress", f"Selecionando o contrato {CONTRATO_NOME}...")
    campo.click()
    desmarcar = page.get_by_text("Desmarcar todos", exact=True).filter(visible=True)
    if campo.input_value().strip() and visivel(desmarcar):
        desmarcar.first.click()
    busca = page.get_by_placeholder("Buscar Contrato/Nome").filter(visible=True).first
    busca.wait_for(state="visible", timeout=10000)
    busca.fill("")
    busca.press_sequentially(CONTRATO, delay=50)
    opcao = page.locator(f'li[data-valor="{CONTRATO}"]').filter(visible=True).first
    opcao.wait_for(state="visible", timeout=15000)
    texto = (opcao.get_attribute("data-texto") or "").strip()
    if texto != CONTRATO_NOME:
        raise RotinaErro(f"A opção do contrato não confere: {texto!r}.")
    if opcao.locator("i.icon-ok-squared").count() == 0:
        opcao.click()
    if opcao.locator("i.icon-ok-squared").count() == 0:
        raise RotinaErro("A opção do contrato não ficou marcada (✓).")
    # Fecha a lista clicando no título da tela (fora do seletor); o UX então recarrega os
    # filtros dependentes ("Aguarde...") e só depois grava o código no campo.
    page.locator("h1, h2").filter(visible=True).first.click()
    limite = time.time() + 60
    while time.time() < limite and (campo.get_attribute("data-valor") or "") != CONTRATO:
        verificar_cancelamento()
        page.wait_for_timeout(500)
    aguardar_ux_livre(page)
    valor = campo.input_value().strip()
    codigo = campo.get_attribute("data-valor") or ""
    if valor != CONTRATO_NOME or codigo != CONTRATO:
        raise RotinaErro(f"O campo Contrato/Nome ficou com {valor!r} (código {codigo!r}).")
    log("UX Simpress", "Contrato confirmado no campo (✓).")


def exportar_ux_pedidos(context: "BrowserContext") -> Path:
    page = None
    try:
        page = abrir_ux(context, UX_PEDIDOS_URL)
        selecionar_contrato_ux(page)
        page.get_by_role("button", name="Buscar", exact=True).filter(visible=True).first.click()
        resumo = page.get_by_text(re.compile(r"\d+\s+pedidos?\s+encontrados?")).filter(visible=True).first
        aguardar_estado(resumo, "visible")
        log("UX Simpress", f"Busca concluída: {resumo.inner_text().strip()}.")
        contratos = page.locator("strong", has_text=re.compile(r"^\s*Contrato:\s*$")).locator("xpath=..")
        textos = [t.replace("Contrato:", "").strip() for t in contratos.all_inner_texts()]
        divergentes = [t for t in textos if t != CONTRATO_NOME]
        if not textos or divergentes:
            raise RotinaErro(f"Cartões com contrato diferente de {CONTRATO}: {divergentes or 'nenhum cartão'}.")
        log("UX Simpress", f"{len(textos)} cartões visíveis conferidos com o contrato {CONTRATO}.")

        log("UX Simpress", "Exportando: Baixar detalhes > Excel...")
        page.get_by_role("button", name="Baixar detalhes").filter(visible=True).first.click()
        excel = page.locator('a.export-option[data-extensao="xlsx"]').filter(visible=True).first
        excel.wait_for(state="visible", timeout=10000)
        arquivo = exportar_com_download(page, "UX Simpress", excel.click, r"Acompanhamento[_ ]de[_ ]pedidos")
    except Exception:
        registrar_erro(page, "UX Simpress")
        raise
    page.close()
    return arquivo


def exportar_ux_equipamentos(context: "BrowserContext") -> Path:
    page = None
    try:
        page = abrir_ux(context, UX_EQUIPAMENTOS_URL)
        selecionar_contrato_ux(page)
        page.locator("#buscar").click()
        exportar = page.locator("#ExportarDropdown").filter(visible=True).first
        aguardar_estado(exportar, "visible")
        log("UX Simpress", "Busca concluída; exportando: Baixar detalhes > Excel...")
        exportar.click()
        excel = page.locator("#ExportarXlsx").filter(visible=True).first
        excel.wait_for(state="visible", timeout=10000)
        arquivo = exportar_com_download(page, "UX Simpress", excel.click, "EquipamentosDetalhes")
    except Exception:
        registrar_erro(page, "UX Simpress")
        raise
    page.close()
    return arquivo


# --------------------------------------------------------------------------
# Endpoint Central
# --------------------------------------------------------------------------

def endpoint_vigiar_avisos(page: "Page") -> None:
    """Fecha sozinho o aviso "New Hotfix Available" do Endpoint quando ele cobre a tela.

    O Playwright chama o tratador durante qualquer ação (clique, digitação) que o aviso esteja bloqueando;
    sem isso o clique espera 30 s e falha com ``Locator.click: Timeout 30000ms exceeded``.
    """
    aviso = page.locator(".server-update--notification").filter(has_text=re.compile(r"Do it later", re.IGNORECASE)).first

    def fechar(_aviso) -> None:
        log("Endpoint Central", "Aviso de atualização do Endpoint: clicando em 'Do it Later'...")
        try:
            aviso.get_by_text(re.compile(r"^\s*Do it later\s*$", re.IGNORECASE)).first.click(timeout=5000)
        except Exception:  # sem o botão, o X (aparece só com o mouse sobre o aviso)
            aviso.hover(timeout=3000)
            aviso.locator("[class*='close' i]").filter(visible=True).first.click(timeout=3000)

    page.add_locator_handler(aviso, fechar)


def endpoint_logado(page: "Page") -> bool:
    return (
        "centralendpoint" in page.url.lower()
        and "#/uems" in page.url.lower()
        and not visivel(page.locator('input[type="password"]').filter(visible=True))
    )


def endpoint_senha_preenchida(page: "Page") -> bool:
    """A senha já veio do Chrome (preenchimento automático)? Só confere se há algo; nunca lê nem guarda o valor."""
    try:
        return bool(
            page.locator("input[name='j_password']").first.evaluate(
                "e => e.value.length > 0 || e.matches(':-webkit-autofill')"
            )
        )
    except Exception:
        return False


def endpoint_escolher_dominio(page: "Page") -> bool:
    """Troca "Autenticação local" por ``pr-sebrae`` na lista da tela de login; True só se a troca ficou confirmada."""
    seletor = page.locator("select[name='domainName']")
    texto = page.locator(".zselectbox__text").filter(visible=True)

    def escolhido() -> bool:
        return seletor.input_value() == ENDPOINT_DOMINIO and ENDPOINT_DOMINIO in texto.first.inner_text()

    try:
        if escolhido():
            return True
        page.locator(".zselectbox__selected").filter(visible=True).first.click()
        opcao = page.locator(".zdropdownlist li").filter(has_text=re.compile(rf"^\s*{re.escape(ENDPOINT_DOMINIO)}\s*$"))
        opcao.filter(visible=True).first.click(timeout=5000)
        for _ in range(10):
            if escolhido():
                return True
            page.wait_for_timeout(300)
    except Exception as erro:
        log("Endpoint Central", f"Não consegui escolher '{ENDPOINT_DOMINIO}' na lista ({descrever_erro(erro)}).")
    return False


def endpoint_entrar(page: "Page") -> bool:
    """Tela de login do Endpoint: preenche só o usuário (se vazio), escolhe o domínio ``pr-sebrae`` e clica em
    "Fazer login" apenas quando o Chrome já preencheu a senha. Nunca digita senha nem o código do autenticador."""
    if "#/login" not in page.url.lower():
        return False
    usuario = page.locator("input[name='j_username']").filter(visible=True)
    if not visivel(page.locator("input[name='j_password']")) or not usuario.count():
        return False
    for _ in range(6):  # o preenchimento automático do Chrome pode chegar um pouco depois da tela
        if endpoint_senha_preenchida(page):
            break
        page.wait_for_timeout(500)
    com_senha = endpoint_senha_preenchida(page)
    if not usuario.first.input_value().strip():
        log("Endpoint Central", f"Preenchendo o usuário {ENDPOINT_USUARIO}...")
        usuario.first.fill(ENDPOINT_USUARIO)
    log("Endpoint Central", f"Escolhendo '{ENDPOINT_DOMINIO}' na lista de autenticação...")
    if not endpoint_escolher_dominio(page):
        return True  # sem a lista confirmada não envia a senha; o usuário termina
    if not com_senha:
        log("Endpoint Central", "Senha não preenchida pelo Chrome; digite a senha e clique em 'Fazer login'.")
        return True
    log("Endpoint Central", "Clicando em 'Fazer login' (o código do autenticador fica com você)...")
    page.locator("button[type='submit']").filter(has_text=re.compile(r"Fazer\s+login", re.IGNORECASE)).filter(
        visible=True
    ).first.click()
    return True


def selecionar_todos_computadores(page: "Page") -> None:
    todos = page.locator('input[type="radio"][value="InvAllComputersSummary"]').first
    aguardar_estado(todos, "attached")
    # O radio existe no DOM antes de a tela terminar de carregar (esqueleto), mas ainda não é clicável.
    acionar_quando_pronto(
        lambda: todos.check(force=True, timeout=2000),
        "'Todos os computadores' não ficou selecionado",
        confirmar=todos.is_checked,
    )


ENDPOINT_CABECALHOS = (
    "Nome do computador",
    "Rótulo de serviço/Número de série",
    "Usuário do último logon",
)


def validar_xlsx_endpoint(arquivo: Path, total_tela: int | None = None) -> int:
    """Confere cabeçalho e contagem do XLSX do Endpoint antes da importação; devolve as linhas de dados."""
    from openpyxl import load_workbook
    from domains.uploaded_workbooks import normalize_workbook_header

    try:
        planilha = load_workbook(arquivo, read_only=True, data_only=True)
    except Exception as erro:
        raise RotinaErro(f"Não foi possível abrir o XLSX do Endpoint: {erro}") from erro
    try:
        linhas = planilha.active.iter_rows(values_only=True)
        cabecalho = next(linhas, None) or ()
        normalizado = {normalize_workbook_header(c) for c in cabecalho if c is not None}
        faltando = [
            c for c in ENDPOINT_CABECALHOS
            if normalize_workbook_header(c) not in normalizado
        ]
        if faltando:
            raise RotinaErro(f"O XLSX do Endpoint não tem as colunas esperadas: {faltando}.")
        total = sum(1 for linha in linhas if any(c not in (None, "") for c in linha))
    finally:
        planilha.close()
    if total == 0:
        raise RotinaErro("O XLSX do Endpoint não tem linhas de dados.")
    if total_tela is not None and abs(total - total_tela) > max(5, total_tela // 10):
        raise RotinaErro(
            f"O XLSX do Endpoint tem {total} linhas, mas a tela mostra {total_tela}: modo de exportação possivelmente errado."
        )
    log("Endpoint Central", f"XLSX conferido: {total} linhas de dados" + (f" (tela: {total_tela})." if total_tela is not None else "."))
    return total


def confirmar_modo_todos(page: "Page") -> None:
    todos = page.locator('input[type="radio"][value="InvAllComputersSummary"]').first
    verificados = page.locator('input[type="radio"][value="InvComputersSummary"]').first
    if not todos.is_checked() or (verificados.count() and verificados.is_checked()):
        raise RotinaErro("O modo 'Todos os computadores' não está ativo (ou 'Computadores verificados' continua marcado).")


def exportar_endpoint(context: "BrowserContext") -> Path:
    page = nova_aba(context, ENDPOINT_URL, "Endpoint Central")
    endpoint_vigiar_avisos(page)
    try:
        aguardar_login(page, "Endpoint Central", endpoint_logado, entrar=endpoint_entrar, email=EMAIL_SOFTEXPERT)
        if "inventory/computers" not in page.url:
            page.goto(ENDPOINT_URL, wait_until="domcontentloaded", timeout=CARREGAMENTO_MS)

        log("Endpoint Central", "Selecionando 'Todos os computadores'...")
        selecionar_todos_computadores(page)
        confirmar_modo_todos(page)
        exportar = page.locator("#InvAllComputersSummary-export").filter(visible=True).first
        aguardar_estado(exportar, "visible")

        log("Endpoint Central", "Exportando: Exportar > XLSX + declaração de privacidade...")
        exportar.click()
        xlsx = page.locator('input[name="exportFormat"][value="xls"]')
        consentimento = page.locator('input[name="userConsent"]')
        xlsx.first.wait_for(state="attached", timeout=15000)
        if not xlsx.first.is_checked():
            page.locator("label.radiobox", has=xlsx).first.click()
        if not consentimento.first.is_checked():
            page.locator("label.checkbox--form", has=consentimento).first.click()
        if not (xlsx.first.is_checked() and consentimento.first.is_checked()):
            raise RotinaErro("Formato XLSX ou declaração de privacidade não ficaram marcados.")
        arquivo = exportar_com_download(
            page, "Endpoint Central", page.locator("#export_option_submit").filter(visible=True).first.click,
            "InvAllComputersSummary",
        )
        validar_xlsx_endpoint(arquivo)
    except Exception:
        registrar_erro(page, "Endpoint Central")
        raise
    page.close()
    return arquivo


# --------------------------------------------------------------------------
# Importação local (pastas de entrada)
# --------------------------------------------------------------------------

def ambiente_utf8() -> dict[str, str]:
    return {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}


def preparar_lote(script: str, inicio: str) -> dict:
    comando = [sys.executable, str(ROOT / "scripts" / script), "--since", inicio, "--downloads-dir", str(DOWNLOADS_DIR)]
    resultado = subprocess.run(
        comando, capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT), env=ambiente_utf8(), check=False
    )
    if resultado.returncode != 0:
        raise RotinaErro(f"{script} falhou: {(resultado.stderr or resultado.stdout).strip()}")
    lote = json.loads(resultado.stdout)
    log("Importação", f"Lote {lote['lote_id']} em {lote['estado']}" + (" (reutilizado)" if lote.get("reutilizado") else ""))
    return lote


def processar_fila(script: str) -> None:
    # A saída do processamento passa pelo print para chegar também ao log da execução.
    with subprocess.Popen(
        [sys.executable, str(ROOT / "scripts" / script)],
        cwd=str(ROOT), env=ambiente_utf8(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace",
    ) as processo:
        for linha in processo.stdout or []:
            print(linha.rstrip("\r\n"), flush=True)
    if processo.returncode != 0:
        log("Importação", f"{script} terminou com código {processo.returncode}; conferindo o resultado do lote.")


def confirmar_lote(inbox: Path, lote_id: str, timeout_s: int = 180) -> dict:
    """Aguarda o _resultado.json do lote (o servidor local também pode consumi-lo)."""
    limite = time.time() + timeout_s
    while time.time() < limite:
        for estado in ("processadas", "falhas"):
            pasta = inbox / estado
            if not pasta.is_dir():
                continue
            for candidato in sorted(pasta.glob(f"{lote_id}*")):
                if candidato.name != lote_id and not candidato.name.startswith(f"{lote_id}--"):
                    continue
                arquivo = candidato / "_resultado.json"
                if arquivo.is_file():
                    dados = json.loads(arquivo.read_text(encoding="utf-8"))
                    dados["pasta"] = str(candidato)
                    return dados
        # O lote já foi publicado: o cancelamento só para de esperar; a importação segue sozinha.
        verificar_cancelamento(
            f"O lote {lote_id} já estava em pendentes e a importação continua; confira o _resultado.json em {inbox}."
        )
        time.sleep(2)
    raise RotinaErro(f"O lote {lote_id} não foi processado em {timeout_s} s; confira {inbox}.")


def importar(nome: str, script_preparo: str, script_fila: str, inbox: Path, inicio: str) -> int:
    print(f"\n--- Importando {nome} pela pasta local ---", flush=True)
    verificar_cancelamento()  # último ponto antes de publicar o lote; depois disso a importação vai até o fim
    lote = preparar_lote(script_preparo, inicio)
    if lote["estado"] == "pendentes":
        processar_fila(script_fila)
    resultado = confirmar_lote(inbox, lote["lote_id"])
    registrar_lote(lote["lote_id"])
    if resultado.get("status") == "concluido":
        LOTES_CONFIRMADOS.append(lote["lote_id"])
    log("Importação", f"status={resultado.get('status')} | {resultado.get('detalhe', '')}")
    log("Importação", f"Recibo: {resultado['pasta']}\\_resultado.json")
    return 0 if resultado.get("status") == "concluido" else 1


# --------------------------------------------------------------------------
# Trava de execução única (o .bat e o site disputam o mesmo Chrome)
# --------------------------------------------------------------------------

TRAVA_PATH = ROOT / "data" / "state" / "automacao_chrome.lock"
# Trava vazia ou ilegível mais nova que isso pode estar sendo gravada agora.
TRAVA_GRAVACAO_S = 10


class TravaOcupada(RuntimeError):
    """Outra execução viva já controla o Chrome de automação."""


def pid_vivo(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return ctypes.get_last_error() == 5  # ERROR_ACCESS_DENIED: existe, mas é de outro usuário
        try:
            codigo = ctypes.c_ulong()
            if kernel32.GetExitCodeProcess(handle, ctypes.byref(codigo)):
                return codigo.value == 259  # STILL_ACTIVE
            return True
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _ler_arquivo_trava() -> dict | None:
    try:
        dados = json.loads(TRAVA_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        dados = None
    if isinstance(dados, dict) and isinstance(dados.get("pid"), int):
        return dados
    try:
        recente = time.time() - TRAVA_PATH.stat().st_mtime < TRAVA_GRAVACAO_S
    except FileNotFoundError:
        return None
    # Conteúdo incompleto: trata como em gravação (ocupada) só enquanto for recente.
    return {"pid": -1, "rotina": "?", "inicio": ""} if recente else {"pid": 0}


def ler_trava() -> dict | None:
    """Estado da execução em andamento ({pid, rotina, inicio}) ou None se livre ou órfã."""
    dados = _ler_arquivo_trava()
    if dados is None:
        return None
    if dados["pid"] == -1 or pid_vivo(dados["pid"]):
        return dados
    return None


def descrever_trava(dados: dict) -> str:
    try:
        desde = datetime.fromisoformat(str(dados.get("inicio"))).strftime("%H:%M")
    except ValueError:
        desde = "?"
    pid = dados.get("pid") if dados.get("pid", -1) > 0 else "?"
    return f"Já existe uma rotina em andamento (rotina {dados.get('rotina', '?')}, PID {pid}, desde {desde})"


def adquirir_trava(rotina: str) -> None:
    TRAVA_PATH.parent.mkdir(parents=True, exist_ok=True)
    for _ in range(3):
        try:
            fd = os.open(TRAVA_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            ocupada = ler_trava()
            if ocupada is not None:
                raise TravaOcupada(descrever_trava(ocupada)) from None
            try:  # órfã: o PID gravado não existe mais
                TRAVA_PATH.unlink()
            except FileNotFoundError:
                pass
            continue
        with os.fdopen(fd, "w", encoding="utf-8") as arquivo:
            json.dump({"pid": os.getpid(), "rotina": rotina, "inicio": agora_iso()}, arquivo)
        return
    raise TravaOcupada("Não foi possível obter a trava da automação; tente de novo em instantes.")


def liberar_trava() -> None:
    dados = _ler_arquivo_trava()
    if dados is not None and dados.get("pid") == os.getpid():
        try:
            TRAVA_PATH.unlink()
        except FileNotFoundError:
            pass


class trava_execucao:
    """Mantém a trava durante o bloco e a libera em erro ou Ctrl+C."""

    def __init__(self, rotina: str) -> None:
        self.rotina = rotina

    def __enter__(self) -> None:
        adquirir_trava(self.rotina)

    def __exit__(self, *_exc) -> None:
        liberar_trava()


# --------------------------------------------------------------------------
# Rotinas
# --------------------------------------------------------------------------

LOTES_CONFIRMADOS: list[str] = []


def com_aviso(nome: str, rotina: Callable[["BrowserContext"], int], context: "BrowserContext") -> int:
    """Roda a rotina e avisa no Windows o fim, com os lotes confirmados ou o erro."""
    LOTES_CONFIRMADOS.clear()
    try:
        codigo = rotina(context)
    except Exception as erro:
        avisar(f"Simpress: rotina de {nome} falhou", descrever_erro(erro))
        raise
    if codigo == 0:
        avisar(f"Simpress: rotina de {nome} concluída", "Lotes confirmados: " + (", ".join(LOTES_CONFIRMADOS) or "nenhum"))
    else:
        avisar(f"Simpress: rotina de {nome} não concluída", "O lote não foi confirmado; confira o log e o _resultado.json.")
    return codigo


def conectar(p):
    garantir_chrome()
    browser = p.chromium.connect_over_cdp(CDP_URL)
    if not browser.contexts:
        raise RotinaErro("O Chrome de automação não expôs nenhum contexto de navegação.")
    context = browser.contexts[0]
    # Fecha abas de sessões anteriores (reaproveitadas ou restauradas por --restore-last-session).
    antigas = list(context.pages)
    # Fechar a última aba encerra o Chrome (TargetClosedError em new_page): mantém uma aba nova aberta.
    context.new_page()
    for pagina in antigas:
        try:
            pagina.close()
        except Exception:
            pass
    return browser, context


def rodar_rotina_os(context: "BrowserContext") -> int:
    from core.config import AUTOMATIC_TICKET_INBOX_DIR

    inicio = agora_iso()
    print(f"\n=== ROTINA DE OS SIMPRESS (início {inicio}) ===", flush=True)
    oracle = exportar_oracle(context)
    ux = exportar_ux_pedidos(context)
    log("Downloads", f"Oracle: {oracle.name} | UX: {ux.name}")
    codigo = importar(
        "chamados", "prepare_ticket_downloads.py", "process_ticket_inbox.py", AUTOMATIC_TICKET_INBOX_DIR, inicio
    )
    print("\n[SUCESSO] Rotina de OS concluída." if codigo == 0 else "\n[FALHA] Rotina de OS não foi concluída.")
    return codigo


def rodar_rotina_inventarios(context: "BrowserContext") -> int:
    from core.config import AUTOMATIC_INVENTORY_INBOX_DIR

    inicio = agora_iso()
    print(f"\n=== ROTINA DE INVENTÁRIOS (início {inicio}) ===", flush=True)
    ux = exportar_ux_equipamentos(context)
    endpoint = exportar_endpoint(context)
    log("Downloads", f"UX: {ux.name} | Endpoint: {endpoint.name}")
    codigo = importar(
        "inventários", "prepare_inventory_downloads.py", "process_inventory_inbox.py",
        AUTOMATIC_INVENTORY_INBOX_DIR, inicio,
    )
    print("\n[SUCESSO] Rotina de inventários concluída." if codigo == 0 else "\n[FALHA] Rotina de inventários não foi concluída.")
    if codigo == 0:
        verificar_usuarios_apos_inventarios(context)
    return codigo


def rodar_rotina_usuarios(context: "BrowserContext") -> int:
    from scripts import verificar_usuarios_endpoint

    print(f"\n=== VERIFICAR USUÁRIOS (início {agora_iso()}) ===", flush=True)
    codigo = verificar_usuarios_endpoint.verificar_usuarios_endpoint(context, sys.modules[__name__])
    print("\n[SUCESSO] Verificação de usuários concluída.", flush=True)
    return codigo


def verificar_usuarios_apos_inventarios(context: "BrowserContext") -> None:
    """Fim de Inventários/Ambas: falha da verificação não desfaz a importação já confirmada."""
    try:
        rodar_rotina_usuarios(context)
    except Exception as erro:
        print(f"\n[AVISO] Verificação de usuários não concluída: {descrever_erro(erro)}", flush=True)


def rodar_rotina_sebrae(context: "BrowserContext") -> int:
    # Só leitura do SoftExpert: o resultado vai para data/state/sebrae_novos.json e o site mostra o formulário.
    # O fluxo antigo (sebrae_rotina: Excel Online + orquestração) fica sem uso até ser removido.
    from scripts import sebrae_leitura

    return sebrae_leitura.executar(context, sys.modules[__name__])


def rodar_rotina_fechar(context: "BrowserContext", sem_finalizar: bool = False) -> int:
    # Única rotina que ESCREVE no SoftExpert: finaliza só os chamados do pedido gravado pelo site (data/state/sebrae_fechar_job.json).
    from scripts import sebrae_fechar

    return sebrae_fechar.executar(context, sys.modules[__name__], sem_finalizar=sem_finalizar)


# --------------------------------------------------------------------------
# Dashboard Sebrae (pasta DASHBOARD SEBRAE do SharePoint): baixar, importar no site e buscar chamados novos
# --------------------------------------------------------------------------

# Rótulos nos dois idiomas; o nome na lista pode vir sem a extensão. Cópias ("... (1)", "Cópia") não casam.
_NOME_DASHBOARD_NA_LISTA = re.compile(r"^" + re.escape(Path(DASHBOARD_FINAL).stem) + r"(?:\.xlsx)?$", re.IGNORECASE)
_MENU_MAIS_ACOES = re.compile(r"More actions|Mais a[cç][õo]es", re.IGNORECASE)
_MENU_BAIXAR = re.compile(r"^\s*(Download|Baixar)\s*$", re.IGNORECASE)
# Nome gravado pelo Chrome: "nome.xlsx" ou "nome (N).xlsx"; "(atualizado)" e .zip ficam de fora.
_DASHBOARD_BAIXADO = padrao_do_nome(DASHBOARD_FINAL)
_MENU_DUPLICATA = re.compile(r"^\s*(Duplicate|Duplicata)\s*$", re.IGNORECASE)
_BOTAO_SUBSTITUIR = re.compile(r"^\s*(Replace|Substituir)\s*$", re.IGNORECASE)
_BOTAO_MANTER_AMBOS = re.compile(r"^\s*(Keep both|Manter ambos)\s*$", re.IGNORECASE)
_AVISO_ENVIO_CONCLUIDO = re.compile(
    r"upload(?:s)? (?:complete|finished)|uploaded to|carregad[oa] para|(?:upload|envio|carregamento) conclu[ií]do", re.IGNORECASE
)
_AVISO_ARQUIVO_EM_USO = re.compile(r"locked|in use|being used|checked out|bloquead|em uso|sendo usado|sendo editado", re.IGNORECASE)
# Cópia local do que estava no SharePoint antes de sobrepor (a cópia "Duplicata" fica lá, intocada).
DASHBOARD_BACKUPS_DIR = ROOT / "data" / "state" / "sebrae_backups"
DASHBOARD_BACKUPS_MAX = 20
MSG_SHAREPOINT_MUDOU = "O Dashboard no SharePoint mudou depois da importação; importe de novo."


def _localizar_linha_do_dashboard(page: "Page"):
    return page.get_by_role("row").filter(has=page.get_by_text(_NOME_DASHBOARD_NA_LISTA)).first


def _linha_do_dashboard(page: "Page"):
    linha = _localizar_linha_do_dashboard(page)
    if not esperar_visivel(linha, 15000):
        raise RotinaErro(f'Não achei "{DASHBOARD_FINAL}" na pasta DASHBOARD SEBRAE.')
    return linha


def _abrir_mais_acoes(linha) -> None:
    linha.hover()  # os três pontinhos só aparecem com o mouse na linha (ou com ela selecionada)
    linha.get_by_role("button", name=_MENU_MAIS_ACOES).first.click()


def baixar_dashboard_da_pasta(page: "Page") -> Path:
    """Linha do arquivo > Mais ações (...) > Baixar. Só lê: o Dashboard no SharePoint não é alterado."""
    linha = _linha_do_dashboard(page)

    def clicar() -> None:
        log("Dashboard", "Clicando em Mais ações > Baixar...")
        _abrir_mais_acoes(linha)
        baixar = page.get_by_role("menuitem", name=_MENU_BAIXAR).first
        baixar.wait_for(state="visible", timeout=15000)
        baixar.click()

    arquivo = exportar_com_download(page, "Dashboard", clicar, _DASHBOARD_BAIXADO)
    if arquivo.suffix.lower() != ".xlsx":
        raise RotinaErro(f"O SharePoint entregou {arquivo.name}, não um .xlsx; desmarque outros itens da pasta e tente de novo.")
    log("Dashboard", f"Dashboard baixado em {arquivo}")
    return arquivo


def exportar_dashboard_sebrae(context: "BrowserContext") -> Path:
    page = None
    try:
        page = nova_aba(context, DASHBOARD_PASTA_URL, "Dashboard")
        aguardar_login(page, "Dashboard", pasta_dashboard_logada, entrar=pasta_dashboard_entrar)
        arquivo = baixar_dashboard_da_pasta(page)
    except Exception:
        registrar_erro(page, "Dashboard")
        raise
    page.close()
    return arquivo


def montar_multipart(nome: str, conteudo: bytes) -> tuple[bytes, str]:
    """Corpo ``multipart/form-data`` com o campo ``file`` (o que ``POST /api/sebrae/dashboard`` espera)."""
    limite = f"----simpress{os.urandom(8).hex()}"
    nome_seguro = re.sub(r'["\r\n\\]', "_", nome)
    cabecalho = (
        f'--{limite}\r\nContent-Disposition: form-data; name="file"; filename="{nome_seguro}"\r\n'
        "Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n"
    )
    corpo = cabecalho.encode("utf-8") + conteudo + f"\r\n--{limite}--\r\n".encode("utf-8")
    return corpo, f"multipart/form-data; boundary={limite}"


def importar_dashboard_no_site(arquivo: Path) -> dict:
    corpo, tipo = montar_multipart(arquivo.name, arquivo.read_bytes())
    url = f"http://127.0.0.1:{int(os.environ.get('SIMPRESS_PORT', '8000'))}/api/sebrae/dashboard"
    pedido = urllib.request.Request(url, data=corpo, method="POST", headers={"Content-Type": tipo})
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(pedido, timeout=120) as resposta:
            return json.load(resposta)
    except urllib.error.HTTPError as erro:
        try:
            detalhe = str(json.load(erro).get("detail") or "")
        except Exception:
            detalhe = ""
        raise RotinaErro(f"O site recusou o Dashboard (HTTP {erro.code}): {detalhe}".rstrip(": ")) from erro
    except (urllib.error.URLError, OSError) as erro:
        raise RotinaErro(f"O servidor Simpress não respondeu em {url}: {erro}") from erro


def rodar_rotina_dashboard(context: "BrowserContext") -> int:
    print(f"\n=== DASHBOARD SEBRAE (início {agora_iso()}) ===", flush=True)
    arquivo = exportar_dashboard_sebrae(context)
    verificar_cancelamento()
    dados = importar_dashboard_no_site(arquivo)
    importado = dados.get("importado") or {}
    log("Dashboard", f"Dashboard importado: {importado.get('arquivo', arquivo.name)} ({importado.get('total', '?')} chamados).")
    verificar_cancelamento()
    codigo = rodar_rotina_sebrae(context)
    print("\n[SUCESSO] Dashboard importado e busca concluída." if codigo == 0 else "\n[FALHA] A busca de chamados novos não foi concluída.", flush=True)
    return codigo


def arquivo_final_dashboard() -> Path:
    """Arquivo que o site gravou em ``data/state`` no último "Atualizar Dashboard" (não o de Downloads, que pode ser a cópia baixada do SharePoint)."""
    arquivo = DASHBOARD_SAIDA_DIR / DASHBOARD_FINAL
    if not arquivo.is_file():
        raise RotinaErro(f'Não achei "{DASHBOARD_FINAL}" gerado pelo site. Use "Atualizar Dashboard" no site antes de enviar.')
    return arquivo


def _botao_enviar(page: "Page"):
    """Botão que abre o menu de envio: "Criar ou carregar"/"Create or upload" na tela Shared do OneDrive, "Carregar"/"Upload" na biblioteca."""
    return page.get_by_role("button", name=re.compile(r"^(?:Create or upload|Criar ou carregar|Upload|Carregar)$")).or_(
        page.get_by_role("menuitem", name=re.compile(r"^(?:Upload|Carregar)$"))).first


def pasta_dashboard_logada(page: "Page") -> bool:
    url = page.url.lower()
    return "sharepoint.com" in url and "login" not in url and visivel(_botao_enviar(page))


def pasta_dashboard_entrar(page: "Page") -> bool:
    if "microsoftonline" not in page.url.lower():
        return False
    entrar_microsoft(page, "Dashboard", EMAIL_SOFTEXPERT, concluido=pasta_dashboard_logada)
    return True


LIMITE_AVISO_COPIAS = 5
# Nome do Dashboard seguido de "Copiar", "- Cópia", "Copy" ou "(1)"; outro arquivo com o mesmo prefixo ("..._teste", "(atualizado)") não conta.
_COPIA_DO_DASHBOARD = re.compile(re.escape(Path(DASHBOARD_FINAL).stem) + r"\s*(?:[-–]\s*)?(?:(?:Copiar|C[óo]pia|Copy)\b|\(\d+\))", re.IGNORECASE)


def _quantos_dashboards_na_lista(page: "Page") -> int:
    """Linhas cujo nome contém o nome do Dashboard: o original e cópias ("... (1)", "... - Cópia")."""
    return page.get_by_role("row").filter(has_text=re.compile(re.escape(Path(DASHBOARD_FINAL).stem), re.IGNORECASE)).count()


def _copias_na_lista(page: "Page") -> int:
    return page.get_by_role("row").filter(has_text=_COPIA_DO_DASHBOARD).count()


def duplicar_dashboard_na_pasta(page: "Page") -> None:
    """Linha do arquivo > Mais ações (...) > Duplicata. A cópia é só segurança: nunca é aberta, baixada, renomeada nem apagada."""
    linha = _linha_do_dashboard(page)
    antes = _quantos_dashboards_na_lista(page)
    copias = _copias_na_lista(page)
    log("Dashboard", f"Cópias de segurança já na pasta: {copias}.")
    if copias > LIMITE_AVISO_COPIAS:
        log("Dashboard", f"Aviso: há {copias} cópias de segurança na pasta DASHBOARD SEBRAE; apague as antigas à mão (a rotina não apaga).")
    log("Dashboard", "Criando a cópia de segurança (Mais ações > Duplicata)...")
    _abrir_mais_acoes(linha)
    duplicata = page.get_by_role("menuitem", name=_MENU_DUPLICATA).first
    duplicata.wait_for(state="visible", timeout=15000)
    duplicata.click()
    limite = time.time() + 30
    while time.time() < limite:
        verificar_cancelamento()
        if _quantos_dashboards_na_lista(page) > antes:
            log("Dashboard", "Cópia de segurança criada na pasta (não será alterada).")
            return
        page.wait_for_timeout(1000)
    raise RotinaErro("A cópia (Duplicata) não apareceu na pasta do SharePoint; não substituí o Dashboard.")


def conferir_dashboard_do_sharepoint(baixado: Path) -> None:
    """Pré-checagem obrigatória: o arquivo do SharePoint tem de ser o que o site importou (mesmo hash ou mesmos valores em todas as colunas de dado dos chamados)."""
    import hashlib

    from domains import sebrae_finalizacao, sebrae_novos
    from domains.sebrae_dashboard import DashboardInvalido
    from domains.sebrae_dashboard_gravacao import valores_dos_chamados

    caminhos = sebrae_novos.caminhos_padrao(DASHBOARD_SAIDA_DIR.parent)
    existentes = sebrae_novos.ler_existentes(caminhos.existentes)
    if existentes is None:
        raise RotinaErro("O site não tem um Dashboard importado; use a rotina dashboard antes de enviar.")
    conteudo = baixado.read_bytes()
    hash_baixado = hashlib.sha256(conteudo).hexdigest()
    if existentes["sha256"] and hash_baixado == existentes["sha256"]:
        return
    # Segundo envio em diante: o SharePoint já tem o arquivo que o próprio site enviou, e não o importado.
    if hash_baixado == sebrae_finalizacao.ler_enviado(DASHBOARD_SAIDA_DIR.parent):
        return
    importada = sebrae_novos.ler_planilha(sebrae_novos.caminho_planilha(caminhos), existentes["sha256"])
    try:
        igual = importada is not None and valores_dos_chamados(conteudo) == valores_dos_chamados(importada)
    except DashboardInvalido as erro:
        raise RotinaErro(f"Não consegui conferir o Dashboard do SharePoint: {erro}") from erro
    if not igual:
        raise RotinaErro(MSG_SHAREPOINT_MUDOU)


def guardar_backup_do_dashboard(baixado: Path) -> Path:
    """Copia o Dashboard recém-baixado do SharePoint para ``sebrae_backups`` e mantém só os ``DASHBOARD_BACKUPS_MAX`` mais recentes."""
    from core.integrity import atomic_copy_file

    stem = Path(DASHBOARD_FINAL).stem
    destino = DASHBOARD_BACKUPS_DIR / f"{stem}_{datetime.now():%Y%m%d_%H%M%S}.xlsx"
    DASHBOARD_BACKUPS_DIR.mkdir(parents=True, exist_ok=True)
    atomic_copy_file(baixado, destino)
    for antigo in sorted(DASHBOARD_BACKUPS_DIR.glob(f"{stem}_*.xlsx"), key=lambda p: p.name)[:-DASHBOARD_BACKUPS_MAX]:
        try:
            antigo.unlink()
        except OSError:
            log("Dashboard", f"Não consegui apagar o backup antigo {antigo.name}.")
    log("Dashboard", f"Backup do Dashboard do SharePoint salvo em {destino}")
    return destino


def enviar_arquivo_para_pasta(page: "Page", arquivo: Path) -> None:
    """Carregar > Carregamento de arquivos (na tela Shared: Criar ou carregar > Carregamento de arquivos) na pasta aberta, sobrepondo o original com "Replace".

    Se o SharePoint oferecer só "Keep both", recusa: criaria um segundo arquivo em vez de atualizar o Dashboard.
    """
    log("Dashboard", f"Enviando {arquivo.name} ({arquivo.stat().st_size:,} bytes)...".replace(",", "."))
    _botao_enviar(page).click()
    arquivos = page.get_by_role("menuitem", name=re.compile(r"^(?:Files?(?: upload)?|Carregamento de arquivos)$")).first
    arquivos.wait_for(state="visible", timeout=15000)
    with page.expect_file_chooser(timeout=15000) as escolha:
        arquivos.click()
    escolha.value.set_files(str(arquivo))
    substituir = page.get_by_role("button", name=_BOTAO_SUBSTITUIR)
    manter = page.get_by_role("button", name=_BOTAO_MANTER_AMBOS)
    if esperar_visivel(substituir.or_(manter).first, 8000):
        if substituir.count() == 0:
            try:
                page.keyboard.press("Escape")
            except Exception:
                pass
            raise RotinaErro('O SharePoint ofereceu só "Keep both" (manter os dois); não enviei para não criar um segundo arquivo.')
        substituir.first.click()
    aviso_uso = page.get_by_role("dialog").or_(page.get_by_role("alertdialog")).filter(has_text=_AVISO_ARQUIVO_EM_USO)
    limite = time.time() + 90
    while time.time() < limite:
        verificar_cancelamento()
        if visivel(aviso_uso.first):
            raise RotinaErro("O SharePoint não deixou substituir: o Dashboard está em uso ou bloqueado por outra pessoa. Feche-o e envie de novo.")
        # Só o aviso confirma: o texto da linha muda sozinho (data relativa) mesmo se o envio falhar.
        if visivel(page.get_by_text(_AVISO_ENVIO_CONCLUIDO).first):
            return
        page.wait_for_timeout(1000)
    raise RotinaErro("Não vi o aviso de envio concluído em 90 s; o Dashboard pode ter sido enviado. Confira a pasta antes de repetir.")


def enviar_copia_pendente(context: "BrowserContext", arquivo: Path) -> None:
    """Sobe ``arquivo`` à pasta com o nome que ele já tem, sem duplicar, baixar nem conferir: nunca substitui o Dashboard original (o nome é outro)."""
    if arquivo.name.lower() == DASHBOARD_FINAL.lower():
        raise RotinaErro("A cópia pendente não pode ter o nome do Dashboard: substituiria o original sem conferência.")
    page = None
    try:
        page = nova_aba(context, DASHBOARD_PASTA_URL, "Dashboard")
        aguardar_login(page, "Dashboard", pasta_dashboard_logada, entrar=pasta_dashboard_entrar)
        enviar_arquivo_para_pasta(page, arquivo)
    except Exception:
        registrar_erro(page, "Dashboard")
        raise
    page.close()


def rodar_rotina_enviar(context: "BrowserContext", arquivo: "Path | None" = None) -> int:
    """``arquivo`` só é passado para reenviar uma cópia pendente (com o nome do Dashboard); sem ele vai o arquivo gravado pelo site."""
    import hashlib

    from domains import sebrae_finalizacao

    print(f"\n=== ENVIAR DASHBOARD ATUALIZADO (início {agora_iso()}) ===", flush=True)
    do_site = arquivo is None
    arquivo = arquivo if arquivo is not None else arquivo_final_dashboard()
    page = None
    try:
        page = nova_aba(context, DASHBOARD_PASTA_URL, "Dashboard")
        aguardar_login(page, "Dashboard", pasta_dashboard_logada, entrar=pasta_dashboard_entrar)
        duplicar_dashboard_na_pasta(page)
        verificar_cancelamento()
        baixado = baixar_dashboard_da_pasta(page)
        conferir_dashboard_do_sharepoint(baixado)
        guardar_backup_do_dashboard(baixado)
        verificar_cancelamento()
        enviar_arquivo_para_pasta(page, arquivo)
        # Guarda o hash do que subiu: o próximo envio reconhece esse arquivo no SharePoint como "sem mudança de terceiros".
        # Falha aqui não desfaz o envio: o SharePoint já aceitou; o próximo envio só cai na comparação de valores.
        try:
            sebrae_finalizacao.gravar_enviado(DASHBOARD_SAIDA_DIR.parent, hashlib.sha256(arquivo.read_bytes()).hexdigest())
        except (OSError, RuntimeError) as erro:  # RuntimeError: FileBusyError da trava de arquivo
            log("Dashboard", f"Não consegui guardar o hash do arquivo enviado ({erro}); o próximo envio usará só a comparação de valores.")
        if do_site:  # o arquivo do site é mais novo que qualquer cópia pendente: reenviá-la depois desfaria este envio
            try:
                sebrae_finalizacao.descartar_pendentes(DASHBOARD_SAIDA_DIR.parent)
            except OSError as erro:
                log("Dashboard", f"Não consegui apagar a cópia pendente antiga ({erro}); apague-a à mão.")
    except Exception:
        registrar_erro(page, "Dashboard")
        raise
    page.close()
    print(f"\n[SUCESSO] {arquivo.name} sobreposto na pasta DASHBOARD SEBRAE (cópia de segurança e backup local feitos).", flush=True)
    return 0


def abrir_para_login(context: "BrowserContext") -> int:
    """Abre Endpoint, UX e Oracle e adianta tudo o que não é senha nem MFA; depois espera o usuário nas abas pendentes.

    O login da UX e o do Oracle são o mesmo (conta Microsoft da Simpress): quando um conclui, a outra aba é
    reaberta pelo endereço do sistema para aproveitar a sessão em vez de pedir o login de novo.
    """
    # (nome, url, logado, entrar, email, segundos de espera depois da ação, compartilha o login da Simpress)
    sites = (
        ("Endpoint Central", ENDPOINT_LOGIN_URL, endpoint_logado, endpoint_entrar, None, 5, False),
        ("UX Simpress", UX_LOGIN_URL, ux_logado, ux_entrar, EMAIL_DASHBOARD, 45, True),
        ("Oracle", ORACLE_URL, oracle_logado, None, EMAIL_DASHBOARD, 45, True),
    )
    abas = [(site, nova_aba(context, site[1], site[0])) for site in sites]

    def tentar(site, page, recarregar: bool = False) -> bool:
        nome, url, logado, entrar, email, apos, _compartilha = site
        try:
            if recarregar:
                # Nunca page.reload(): na tela da Microsoft (saml2?sso_reload=true) o SAMLRequest se perde e dá AADSTS750054.
                page.goto(url, wait_until="domcontentloaded", timeout=CARREGAMENTO_MS)
            return aguardar_login(
                page, nome, logado, entrar=entrar, email=email, esperar_usuario=False, apos_acao_s=apos
            )
        except Exception as erro:  # uma aba com problema não impede as outras
            log(nome, f"Não foi possível adiantar o login ({descrever_erro(erro)}).")
            return False

    pendentes = []
    simpress_logada = False
    for site, page in abas:
        if tentar(site, page, recarregar=site[6] and simpress_logada):
            simpress_logada = simpress_logada or site[6]
        else:
            pendentes.append((site, page))

    if pendentes:
        _esperar_logins(pendentes, tentar)
    log("Login", "Login detectado; todas as abas estão prontas.")
    print(
        "\nAbas do Endpoint Central, UX Simpress e Oracle abertas e logadas no Chrome de automação.\n"
        "O navegador continua aberto e as rotinas reaproveitam a sessão.",
        flush=True,
    )
    return 0


def _esperar_logins(pendentes: list, tentar: Callable) -> None:
    """Espera o usuário concluir o login (senha/MFA) nas abas pendentes, sem repetir nenhuma ação automática."""

    def chamar_usuario() -> None:
        nomes = ", ".join(site[0] for site, _ in pendentes)
        pendentes[0][1].bring_to_front()
        log("Login", f"AÇÃO NECESSÁRIA: faça o login na janela do Chrome de automação ({nomes}).")
        avisar("Simpress: login necessário", f"Faça o login na janela do Chrome de automação ({nomes}); a rotina continua sozinha.")

    chamar_usuario()
    limite = time.time() + LOGIN_TIMEOUT_S
    while pendentes:
        verificar_cancelamento()
        mudou = False
        for item in list(pendentes):
            site, page = item
            if item not in pendentes:  # já resolvida pelo recarregamento da aba irmã
                continue
            if page.is_closed():
                log(site[0], "A aba foi fechada; seguindo sem ela.")
                pendentes.remove(item)
                mudou = True
            elif site[2](page):
                log(site[0], "Login concluído.")
                pendentes.remove(item)
                mudou = True
                # UX e Oracle usam a mesma conta: a outra aba só precisa reabrir para entrar.
                for outro in [p for p in pendentes if site[6] and p[0][6]]:
                    if tentar(*outro, recarregar=True):
                        pendentes.remove(outro)
        if not pendentes:
            return
        if mudou:
            chamar_usuario()
        if time.time() >= limite:
            raise RotinaErro(
                f"Login não concluído em {LOGIN_TIMEOUT_S // 60} minutos ({', '.join(s[0] for s, _ in pendentes)})."
            )
        pendentes[0][1].wait_for_timeout(2000)


def executar(rotina: str, sem_finalizar: bool = False) -> int:
    # A trava vem antes do Playwright: uma execução bloqueada responde mesmo sem ele instalado.
    with trava_execucao(rotina):
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            # Só depois da trava: uma execução bloqueada não pode apagar o pedido feito para a que está rodando.
            iniciar_controle_cancelamento()
            browser, context = conectar(p)
            try:
                if rotina == "login":
                    return abrir_para_login(context)
                if rotina == "os":
                    return com_aviso("OS", rodar_rotina_os, context)
                if rotina == "inventarios":
                    return com_aviso("inventários", rodar_rotina_inventarios, context)
                if rotina == "usuarios":
                    return com_aviso("usuários", rodar_rotina_usuarios, context)
                if rotina == "dashboard":
                    return rodar_rotina_dashboard(context)
                if rotina == "enviar":
                    return rodar_rotina_enviar(context)
                if rotina == "sebrae":
                    # Sem com_aviso: o aviso do Windows sai do resultado e só quando algo muda (sem repetição).
                    return rodar_rotina_sebrae(context)
                if rotina == "fechar":
                    return rodar_rotina_fechar(context, sem_finalizar)
                codigos = []
                for nome, etapa in (("OS", rodar_rotina_os), ("inventários", rodar_rotina_inventarios)):
                    verificar_cancelamento()
                    try:
                        codigos.append(com_aviso(nome, etapa, context))
                    except Exception as erro:  # a falha de uma rotina não impede a outra
                        print(f"\n[FALHA] {descrever_erro(erro)}", flush=True)
                        codigos.append(1)
                return 0 if all(c == 0 for c in codigos) else 1
            finally:
                # Só desconecta: o Chrome continua aberto e mantém os logins.
                browser.close()


def descrever_erro(erro: Exception) -> str:
    if isinstance(erro, RotinaErro):
        return str(erro)
    # Erros do Playwright trazem o log de chamadas inteiro; a primeira linha basta no terminal.
    primeira = (str(erro).strip().splitlines() or [""])[0]
    return f"{type(erro).__name__}: {primeira}"


COMANDO_INSTALAR_PLAYWRIGHT = r".venv\Scripts\python.exe -m pip install -r requirements.txt"


def mensagem_playwright_ausente() -> str:
    return (
        "O pacote Python 'playwright' não está instalado neste ambiente, e a automação precisa dele.\n"
        "Instale as dependências do projeto (na pasta do projeto) e execute a rotina de novo:\n"
        f"    {COMANDO_INSTALAR_PLAYWRIGHT}\n"
        "Não é preciso baixar navegadores: a automação usa o Google Chrome instalado."
    )


def playwright_instalado() -> bool:
    return importlib.util.find_spec("playwright") is not None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--rotina", choices=["os", "inventarios", "usuarios", "ambas", "login", "sebrae", "dashboard", "enviar", "fechar"], default="os")
    parser.add_argument(
        "--sem-finalizar", action="store_true",
        help="só com --rotina fechar: preenche e confere o formulário, mas não clica em Finalizar nem altera o Dashboard",
    )
    parser.add_argument(
        "--cancelar", action="store_true", help="pede o cancelamento da rotina em andamento (o Chrome continua aberto) e sai"
    )
    args = parser.parse_args()
    if args.cancelar:
        pedir_cancelamento()
        print(f"Pedido de cancelamento registrado em {CANCELAR_ARQUIVO}.", flush=True)
        return 0
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    iniciar_log_execucao(args.rotina)
    if not playwright_instalado():
        print(f"\n[ERRO] {mensagem_playwright_ausente()}", flush=True)
        return 3
    try:
        return executar(args.rotina, args.sem_finalizar)
    except TravaOcupada as erro:
        print(f"\n[BLOQUEADO] {erro}", flush=True)
        return 2
    except RotinaCancelada as cancelamento:
        apagar_sinal_cancelamento()
        detalhe = str(cancelamento)
        print("\n[CANCELADO] Rotina cancelada pelo usuário." + (f" {detalhe}" if detalhe else ""), flush=True)
        return 130
    except KeyboardInterrupt:
        print("\n[CANCELADO] Rotina interrompida pelo usuário; nenhum lote foi importado depois disso.", flush=True)
        return 130
    except Exception as erro:
        print(f"\n[FALHA] {descrever_erro(erro)}", flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(finalizar_log_execucao(main()))
