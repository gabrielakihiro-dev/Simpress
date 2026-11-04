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
        if grade.get("carregando") or grade.get("total") != len(grade["linhas"]):
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


def consultar(serial: str, macbook: bool, details_serials: Collection[str] = ()) -> dict[str, Any]:
    with automation.trava_execucao("consulta_endpoint"):
        from playwright.sync_api import sync_playwright

        # Ignore cancellation left by an earlier run, without deleting its operational file.
        setattr(automation, "_inicio_execucao", automation.time.time())
        with sync_playwright() as pw:
            browser = pw.chromium.connect_over_cdp("http://127.0.0.1:9333", timeout=10000)
            if not browser.contexts:
                raise RuntimeError("Chrome sem contexto de navegação.")
            page = browser.contexts[0].new_page()
            try:
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
                return consultar_grade(page, automation, serial, macbook, details_serials)
            finally:
                page.close()
