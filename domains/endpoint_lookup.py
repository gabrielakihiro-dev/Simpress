"""Read-only, serial-scoped Endpoint lookup in a private Chrome tab."""
from typing import Any, Collection
from importlib import import_module

from domains.effective_alias import mac_endpoint_serial_key
from domains.inventory_comparison import normalize_reference_value

# The legacy scripts remain outside the application's gradual typing boundary.
automation = import_module("scripts.automacao_rotinas_chrome")
grid = import_module("scripts.verificar_usuarios_endpoint")


def consultar_grade(page: Any, automacao: Any, serial: str, macbook: bool, details_serials: Collection[str] = ()) -> dict[str, Any]:
    tentativas = [serial]
    if macbook and serial.upper().startswith("S") and len(serial) > 1:
        tentativas.append(serial[1:])
    for valor in tentativas:
        if valor != serial:
            detalhes = [normalize_reference_value(s) for s in details_serials]
            chave = normalize_reference_value(serial)
            if detalhes.count(chave) != 1 or chave[1:] in detalhes:
                return {"status": "ambiguous", "serial": serial, "origem": "base_local"}
            # A confirmed full grid prevents the previous empty result from satisfying the next filter.
            grid.limpar_filtro(page, automacao, grid.COLUNA_SERIE)
        grade = grid.aplicar_filtro(page, automacao, grid.COLUNA_SERIE, valor)
        if grade.get("carregando") or (grade.get("total") is not None and grade["total"] != len(grade["linhas"])):
            raise RuntimeError("A grade do Endpoint não confirmou todas as linhas filtradas.")
        cab_serie = grid.achar_cabecalho(grade, grid.COLUNA_SERIE)
        cab_usuario = next((c for c in grade["cabecalhos"] if grid.normalizar(c["texto"]) == "usuario do ultimo logon"), None)
        if cab_serie is None or cab_usuario is None:
            raise RuntimeError("A coluna Usuário do último logon não está visível no Endpoint.")
        linhas = [linha for linha in grade["linhas"] if grid.normalizar(grid.valor_da_coluna(linha, cab_serie)) == grid.normalizar(valor)]
        if len(linhas) > 1:
            return {"status": "ambiguous", "serial": serial}
        if linhas:
            if valor != serial:
                hostname = grid.valor_da_coluna(linhas[0], grid.achar_cabecalho(grade, grid.COLUNA_NOME))
                index = {"unique": {normalize_reference_value(valor): hostname}, "details_serials": set(detalhes)}
                if not mac_endpoint_serial_key(index, normalize_reference_value(serial)):
                    return {"status": "ambiguous", "serial": serial, "origem": "correspondencia_mac"}
            result: dict[str, Any] = {"status": "found", "serial": serial, "ultimo_logon": grid.valor_da_coluna(linhas[0], cab_usuario)}
            if valor != serial:
                result["_fallback_mac"] = True
            return result
    return {"status": "not_found", "serial": serial}


NOME_ABA_CONSULTA = "simpress-consulta-endpoint"


def _e_aba_da_consulta(aba: Any) -> bool:
    try:
        return aba.evaluate("window.name") == NOME_ABA_CONSULTA
    except Exception:
        return False


def _preparar_aba(pw: Any) -> Any:
    """Abre (ou reaproveita) a aba do Endpoint, sempre no Chrome de automação (porta 9333), com a grade completa pronta."""
    browser = pw.chromium.connect_over_cdp("http://127.0.0.1:9333", timeout=10000)
    if not browser.contexts:
        raise RuntimeError("Chrome sem contexto de navegação.")
    contexto = browser.contexts[0]
    # A aba fica aberta depois da consulta (pedido do usuário, 04/11/2026); a próxima consulta reaproveita a mesma.
    page = next((aba for aba in contexto.pages if _e_aba_da_consulta(aba)), None)
    if page is None:
        page = contexto.new_page()
        page.evaluate(f"window.name = '{NOME_ABA_CONSULTA}'")
    page.goto(automation.ENDPOINT_URL, wait_until="domcontentloaded", timeout=automation.CARREGAMENTO_MS)
    automation.selecionar_todos_computadores(page)
    automation.confirmar_modo_todos(page)

    def pronta() -> bool:
        leitura = grid.ler_grade(page)
        return not leitura["carregando"] and all(
            grid.achar_cabecalho(leitura, coluna)
            for coluna in (grid.COLUNA_SERIE, "usuario do ultimo logon")
        )

    automation.acionar_quando_pronto(lambda: None, "A grade do Endpoint não carregou", confirmar=pronta)
    return page


def consultar(serial: str, macbook: bool, details_serials: Collection[str] = ()) -> dict[str, Any]:
    with automation.trava_execucao("consulta_endpoint"):
        from playwright.sync_api import sync_playwright

        # Ignore cancellation left by an earlier run, without deleting its operational file.
        setattr(automation, "_inicio_execucao", automation.time.time())
        with sync_playwright() as pw:
            page = _preparar_aba(pw)
            return consultar_grade(page, automation, serial, macbook, details_serials)


MOTIVO_CONTROLE_REMOTO = "acesso"
_LINHA = ".ember-table-table-row:not(.ember-table-header-row)"
_ITEM_CONTROLE_REMOTO = 'li.zmenu__item[data-label="Controle remoto"]:visible'


def _menu_com_controle_remoto(page: Any, esperar_ms: int = 5000) -> bool:
    from playwright.sync_api import TimeoutError as PlaywrightTimeout

    try:
        page.locator(_ITEM_CONTROLE_REMOTO).first.wait_for(state="visible", timeout=esperar_ms)
        return True
    except PlaywrightTimeout:
        return False


def _conectar_controle_remoto(page: Any) -> None:
    page.locator(_ITEM_CONTROLE_REMOTO).first.click(timeout=10000)
    page.locator('textarea[name="reasonMessage"]:visible').fill(MOTIVO_CONTROLE_REMOTO, timeout=15000)
    page.locator("button.button-primary-form:visible", has_text="Conectar").click(timeout=10000)
    # Dá tempo de o clique ser processado; nada é fechado depois (o usuário continua a sessão).
    page.wait_for_timeout(2000)


def controle_remoto(serial: str, macbook: bool, details_serials: Collection[str] = (), antes_de_conectar: Any = None) -> dict[str, Any]:
    """Filtra a série como a consulta e abre o Controle remoto (motivo "acesso"); não fecha aba nem janela."""
    with automation.trava_execucao("consulta_endpoint"):
        from playwright.sync_api import sync_playwright

        setattr(automation, "_inicio_execucao", automation.time.time())
        with sync_playwright() as pw:
            page = _preparar_aba(pw)
            achado = consultar_grade(page, automation, serial, macbook, details_serials)
            if achado["status"] != "found":
                return achado
            if achado.get("_fallback_mac") and antes_de_conectar is not None and not antes_de_conectar():
                return {"status": "ambiguous", "serial": serial, "origem": "base_local"}
            linha = page.locator(_LINHA).first
            hostname = linha.locator("a.anchor-text").first.inner_text(timeout=10000).strip()
            linha.locator(".resource-action--button").first.click(timeout=10000)
            if not _menu_com_controle_remoto(page):
                # Monitor vermelho ou sem a opção: tenta o menu "Ações" da página do computador.
                page.keyboard.press("Escape")
                linha.locator("a.anchor-text").first.click(timeout=10000)
                page.locator(".resource-action--tab .resource-action--button").first.click(timeout=20000)
                if not _menu_com_controle_remoto(page):
                    page.keyboard.press("Escape")
                    return {"status": "offline", "serial": serial, "hostname": hostname}
            _conectar_controle_remoto(page)
            return {"status": "connected", "serial": serial, "hostname": hostname}
