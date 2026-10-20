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
- ``ambas``: as duas, em sequência.
- ``login``: só abre as abas para o usuário fazer login.

Cada exportação é clicada uma única vez; o arquivo é capturado pelo evento de
download do Playwright e gravado na pasta de Downloads com o nome original.
O login é sempre feito pelo usuário na janela do Chrome; o script apenas espera.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
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

LOGIN_TIMEOUT_S = 10 * 60
CARREGAMENTO_MS = 90_000
DOWNLOAD_MS = 5 * 60_000


class RotinaErro(RuntimeError):
    """Falha de uma etapa que interrompe a rotina sem repetir cliques."""


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


def nova_aba(context: "BrowserContext", url: str, origem: str) -> "Page":
    page = context.new_page()
    log(origem, f"Abrindo {url}")
    page.goto(url, wait_until="domcontentloaded", timeout=CARREGAMENTO_MS)
    return page


def aguardar_login(
    page: "Page",
    origem: str,
    logado: Callable[["Page"], bool],
    entrar: Callable[["Page"], bool] | None = None,
) -> None:
    """Espera o login sem digitar credenciais.

    ``entrar`` pode acionar uma única vez o acesso com a conta já conectada (SSO);
    se o login não concluir, o usuário é chamado para entrar na própria janela.
    """
    limite = time.time() + 15
    tentou_entrar = False
    while time.time() < limite:  # dá tempo para redirecionamentos de SSO
        if logado(page):
            log(origem, "Sessão ativa.")
            return
        if entrar is not None and not tentou_entrar and entrar(page):
            tentou_entrar = True
            limite = time.time() + 45
        page.wait_for_timeout(1000)
    if tentou_entrar:
        log(origem, "O acesso com a conta conectada não concluiu o login.")
    page.bring_to_front()
    log(origem, "AÇÃO NECESSÁRIA: faça o login na janela do Chrome de automação.")
    avisar(f"Simpress: login necessário no {origem}", "Faça o login na janela do Chrome de automação; a rotina continua sozinha.")
    log(origem, "A rotina continua sozinha assim que o login terminar (Ctrl+C cancela).")
    limite = time.time() + LOGIN_TIMEOUT_S
    while time.time() < limite:
        if logado(page):
            log(origem, "Login detectado; continuando.")
            page.wait_for_timeout(2000)
            return
        page.wait_for_timeout(2000)
    raise RotinaErro(f"Login não concluído em {LOGIN_TIMEOUT_S // 60} minutos.")


def nome_livre(pasta: Path, nome: str) -> Path:
    """Mesmo padrão do Chrome: 'arquivo (1).xlsx' quando o nome já existe."""
    destino = pasta / nome
    contador = 1
    while destino.exists():
        destino = pasta / f"{Path(nome).stem} ({contador}){Path(nome).suffix}"
        contador += 1
    return destino


def salvar_download(download: "Download", origem: str) -> Path:
    falha = download.failure()
    if falha:
        raise RotinaErro(f"Download falhou: {falha}")
    DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
    destino = nome_livre(DOWNLOADS_DIR, download.suggested_filename)
    download.save_as(destino)
    log(origem, f"Arquivo salvo: {destino.name} ({destino.stat().st_size:,} bytes)".replace(",", "."))
    return destino


def exportar_com_download(page: "Page", origem: str, clicar: Callable[[], None]) -> Path:
    """Clica uma única vez na exportação e grava o arquivo recebido."""
    with page.expect_download(timeout=DOWNLOAD_MS) as info:
        clicar()
    return salvar_download(info.value, origem)


def registrar_erro(page: "Page | None", origem: str) -> None:
    if page is None or page.is_closed():
        return
    try:
        ERROS_DIR.mkdir(parents=True, exist_ok=True)
        caminho = ERROS_DIR / f"{datetime.now():%Y%m%d_%H%M%S}_{origem.replace(' ', '_')}.png"
        page.screenshot(path=str(caminho))
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
            aguardar_login(page, "Oracle", oracle_logado)
            if esperar_visivel(campo, 8000) or reabrir_filtros_oracle(page, campo):
                return campo.first
    raise RotinaErro("Não foi possível abrir a Gestão de Solicitações pelo Menu do Oracle.")


def exportar_oracle(context: "BrowserContext") -> Path:
    page = nova_aba(context, ORACLE_URL, "Oracle")
    try:
        aguardar_login(page, "Oracle", oracle_logado)
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
        total.wait_for(state="visible", timeout=CARREGAMENTO_MS)
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
        arquivo = exportar_com_download(page, "Oracle", excel.first.click)
    except Exception:
        registrar_erro(page, "Oracle")
        raise
    page.close()
    return arquivo


# --------------------------------------------------------------------------
# UX Simpress
# --------------------------------------------------------------------------

def ux_logado(page: "Page") -> bool:
    url = page.url.lower()
    return "ux.simpress.com.br" in url and "autenticacao" not in url and "login" not in url and visivel(
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
    aguardar_login(page, "UX Simpress", ux_logado, entrar=ux_entrar)
    filtro = page.locator("#CodigosContratosFiltro")
    for tentativa in range(3):
        # Depois do SSO o UX pode redirecionar para o Dashboard alguns segundos depois; volta para a tela pedida.
        if page.url.lower().startswith(url.lower()) and esperar_visivel(filtro, 20000):
            return page
        log("UX Simpress", f"Tela atual {page.url}; voltando para {url}...")
        page.goto(url, wait_until="domcontentloaded", timeout=CARREGAMENTO_MS)
        aguardar_login(page, "UX Simpress", ux_logado, entrar=ux_entrar)
    if not esperar_visivel(filtro, 30000):
        raise RotinaErro(f"A tela {url} não carregou o filtro Contrato/Nome.")
    return page


def aguardar_ux_livre(page: "Page") -> None:
    """Espera sumir o aviso "Aguarde..." que o UX mostra enquanto carrega."""
    page.get_by_text("Aguarde...", exact=True).filter(visible=True).first.wait_for(
        state="hidden", timeout=CARREGAMENTO_MS
    )


def selecionar_contrato_ux(page: "Page") -> None:
    campo = page.locator("#CodigosContratosFiltro").first
    campo.wait_for(state="visible", timeout=CARREGAMENTO_MS)
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
        resumo.wait_for(state="visible", timeout=CARREGAMENTO_MS)
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
        arquivo = exportar_com_download(page, "UX Simpress", excel.click)
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
        exportar.wait_for(state="visible", timeout=CARREGAMENTO_MS)
        log("UX Simpress", "Busca concluída; exportando: Baixar detalhes > Excel...")
        exportar.click()
        excel = page.locator("#ExportarXlsx").filter(visible=True).first
        excel.wait_for(state="visible", timeout=10000)
        arquivo = exportar_com_download(page, "UX Simpress", excel.click)
    except Exception:
        registrar_erro(page, "UX Simpress")
        raise
    page.close()
    return arquivo


# --------------------------------------------------------------------------
# Endpoint Central
# --------------------------------------------------------------------------

def endpoint_logado(page: "Page") -> bool:
    return (
        "centralendpoint" in page.url.lower()
        and "#/uems" in page.url.lower()
        and not visivel(page.locator('input[type="password"]').filter(visible=True))
    )


def exportar_endpoint(context: "BrowserContext") -> Path:
    page = nova_aba(context, ENDPOINT_URL, "Endpoint Central")
    try:
        aguardar_login(page, "Endpoint Central", endpoint_logado)
        if "inventory/computers" not in page.url:
            page.goto(ENDPOINT_URL, wait_until="domcontentloaded", timeout=CARREGAMENTO_MS)

        log("Endpoint Central", "Selecionando 'Todos os computadores'...")
        todos = page.locator('input[type="radio"][value="InvAllComputersSummary"]').first
        todos.wait_for(state="attached", timeout=CARREGAMENTO_MS)
        if not todos.is_checked():
            todos.check(force=True)
        if not todos.is_checked():
            raise RotinaErro("'Todos os computadores' não ficou selecionado.")
        exportar = page.locator("#InvAllComputersSummary-export").filter(visible=True).first
        exportar.wait_for(state="visible", timeout=CARREGAMENTO_MS)

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
            page, "Endpoint Central", page.locator("#export_option_submit").filter(visible=True).first.click
        )
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
    resultado = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / script)], cwd=str(ROOT), env=ambiente_utf8(), check=False
    )
    if resultado.returncode != 0:
        log("Importação", f"{script} terminou com código {resultado.returncode}; conferindo o resultado do lote.")


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
        time.sleep(2)
    raise RotinaErro(f"O lote {lote_id} não foi processado em {timeout_s} s; confira {inbox}.")


def importar(nome: str, script_preparo: str, script_fila: str, inbox: Path, inicio: str) -> int:
    print(f"\n--- Importando {nome} pela pasta local ---", flush=True)
    lote = preparar_lote(script_preparo, inicio)
    if lote["estado"] == "pendentes":
        processar_fila(script_fila)
    resultado = confirmar_lote(inbox, lote["lote_id"])
    if resultado.get("status") == "concluido":
        LOTES_CONFIRMADOS.append(lote["lote_id"])
    log("Importação", f"status={resultado.get('status')} | {resultado.get('detalhe', '')}")
    log("Importação", f"Recibo: {resultado['pasta']}\\_resultado.json")
    return 0 if resultado.get("status") == "concluido" else 1


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
    return browser, browser.contexts[0]


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
    return codigo


def abrir_para_login(context: "BrowserContext") -> int:
    for url in (ORACLE_URL, UX_PEDIDOS_URL, ENDPOINT_URL):
        context.new_page().goto(url, wait_until="domcontentloaded", timeout=CARREGAMENTO_MS)
    print(
        "\nAbas do Oracle, UX Simpress e Endpoint Central abertas no Chrome de automação.\n"
        "Faça os logins com calma; o navegador continua aberto e as rotinas reaproveitam a sessão.",
        flush=True,
    )
    return 0


def executar(rotina: str) -> int:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser, context = conectar(p)
        try:
            if rotina == "login":
                return abrir_para_login(context)
            if rotina == "os":
                return com_aviso("OS", rodar_rotina_os, context)
            if rotina == "inventarios":
                return com_aviso("inventários", rodar_rotina_inventarios, context)
            codigos = []
            for nome, etapa in (("OS", rodar_rotina_os), ("inventários", rodar_rotina_inventarios)):
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--rotina", choices=["os", "inventarios", "ambas", "login"], default="os")
    args = parser.parse_args()
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    try:
        return executar(args.rotina)
    except KeyboardInterrupt:
        print("\n[CANCELADO] Rotina interrompida pelo usuário; nenhum lote foi importado depois disso.", flush=True)
        return 130
    except Exception as erro:
        print(f"\n[FALHA] {descrever_erro(erro)}", flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
