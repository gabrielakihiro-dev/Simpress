"""Read-only, serial-scoped Endpoint lookup in a private Chrome tab."""
import json
import re
import threading
import unicodedata
import urllib.request
from typing import Any, Collection
from importlib import import_module

from domains.effective_alias import mac_endpoint_serial_key
from domains.inventory_comparison import normalize_reference_value

# The legacy scripts remain outside the application's gradual typing boundary.
automation = import_module("scripts.automacao_rotinas_chrome")
grid = import_module("scripts.verificar_usuarios_endpoint")

# CDP target ids of the PowerShell/remote-control tabs left open for the user; the idle Chrome stays open while one exists.
_abas_de_sessao: set[str] = set()
_abas_de_sessao_trava = threading.Lock()


def _registrar_sessao(aba: Any) -> None:
    try:
        cdp = aba.context.new_cdp_session(aba)
        alvo = str(cdp.send("Target.getTargetInfo")["targetInfo"]["targetId"])
        cdp.detach()
    except Exception:
        return  # best effort: an unregistered tab only loses the idle-close protection
    with _abas_de_sessao_trava:
        _abas_de_sessao.add(alvo)


def _abas(page: Any) -> list[Any]:
    try:
        return list(page.context.pages)
    except Exception:
        return []


def sessao_viva() -> bool:
    """True while a registered PowerShell/remote-control tab is still open in the automation Chrome."""
    with _abas_de_sessao_trava:
        if not _abas_de_sessao:
            return False
    try:
        with urllib.request.urlopen(f"{automation.CDP_URL}/json/list", timeout=2) as resposta:
            abertas = {str(alvo.get("id")) for alvo in json.load(resposta) if isinstance(alvo, dict)}
    except (OSError, ValueError):
        return True  # unknown: never close over a session that may be open
    with _abas_de_sessao_trava:
        _abas_de_sessao.intersection_update(abertas)
        return bool(_abas_de_sessao)


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
            href = next((c.get("href") for c in linhas[0] if c.get("href")), "")
            if href:  # identidade da linha para o controle remoto; uso interno, nunca sai na resposta
                result["_href"] = href
                result["_hostname"] = grid.valor_da_coluna(linhas[0], grid.achar_cabecalho(grade, grid.COLUNA_NOME))
            return result
    return {"status": "not_found", "serial": serial}


NOME_ABA_CONSULTA = "simpress-consulta-endpoint"


def _e_aba_da_consulta(aba: Any) -> bool:
    try:
        return aba.evaluate("window.name") == NOME_ABA_CONSULTA
    except Exception:
        return False


def _preparar_aba(pw: Any) -> Any:
    """Abre (ou reaproveita) a aba do Endpoint, sempre no Chrome de automação (SIMPRESS_CHROME_PORT, padrão 9333), com a grade completa pronta."""
    automation.garantir_chrome()  # reopens the automation Chrome after the idle close
    browser = pw.chromium.connect_over_cdp(automation.CDP_URL, timeout=10000)  # same port garantir_chrome opened
    if not browser.contexts:
        raise RuntimeError("Chrome sem contexto de navegação.")
    contexto = browser.contexts[0]
    # A aba fica aberta depois da consulta (pedido do usuário, 04/11/2026); a próxima consulta reaproveita a mesma.
    page = next((aba for aba in contexto.pages if _e_aba_da_consulta(aba)), None)
    if page is None:
        page = contexto.new_page()
        page.evaluate(f"window.name = '{NOME_ABA_CONSULTA}'")
    page.goto(automation.ENDPOINT_URL, wait_until="domcontentloaded", timeout=automation.CARREGAMENTO_MS)
    # Mesmo login da exportação de inventários: escolhe pr-sebrae e espera o usuário (senha/MFA).
    def esperar_login() -> None:
        automation.aguardar_login(
            page, "Endpoint Central", automation.endpoint_logado,
            entrar=automation.endpoint_entrar, email=automation.EMAIL_SOFTEXPERT,
        )

    esperar_login()
    if "inventory/computers" not in page.url:
        page.goto(automation.ENDPOINT_URL, wait_until="domcontentloaded", timeout=automation.CARREGAMENTO_MS)
        # A sessão pode cair entre os dois goto; sem esta checagem a falha seria um erro genérico da grade.
        if not automation.endpoint_logado(page):
            esperar_login()
    automation.definir_pagina_ativa_para_recuperacao(page)
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
            result = consultar_grade(page, automation, serial, macbook, details_serials)
            result.pop("_href", None)
            result.pop("_hostname", None)
            return result


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


def _clicar_resiliente(acao: Any, descricao: str) -> None:
    """Clique de navegação (nunca o "Conectar", irreversível): refaz do zero em caso de instabilidade."""
    def _etapa() -> None:
        try:
            acao()
        except Exception as erro:
            raise automation.EtapaInstavel(str(erro)) from erro

    automation.etapa_resiliente(_etapa, descricao)


def _conectar_controle_remoto(page: Any, abrir_menu: Any, mesmo_contexto: Any, ainda_vale: Any = lambda: True) -> bool:
    """Devolve False, sem clicar, se ``ainda_vale`` recusar logo antes do Conectar."""
    motivo = page.locator('textarea[name="reasonMessage"]:visible')
    conectar = page.locator("button.button-primary-form:visible", has_text="Conectar")
    item = page.locator(_ITEM_CONTROLE_REMOTO)
    tentativas = [0]

    def _abrir_e_preencher() -> None:
        # Reversível. Na 1ª vez o menu deste computador acabou de abrir; ao refazer, um menu ou diálogo visível
        # pode ser de outra linha que o usuário abriu: fecha e reabre sempre pelo menu deste computador.
        tentativas[0] += 1
        if tentativas[0] > 1:
            if motivo.count() or item.count():
                page.keyboard.press("Escape")
            abrir_menu()
            item.first.click(timeout=10000)
        elif not motivo.count():
            if not item.count():
                abrir_menu()
            item.first.click(timeout=10000)
        motivo.fill(MOTIVO_CONTROLE_REMOTO, timeout=15000)

    _clicar_resiliente(_abrir_e_preencher, "Abrir o Controle remoto e preencher o motivo")

    def _pronto() -> bool:
        try:
            return bool(conectar.count()) and motivo.input_value(timeout=2000) == MOTIVO_CONTROLE_REMOTO and mesmo_contexto()
        except Exception:
            return False

    automation.aguardar_estabilidade_pre_clique(_pronto, "Conectar o controle remoto")
    if not ainda_vale():  # o pedido foi cancelado ou a base mudou durante a espera: fecha o diálogo sem conectar
        page.keyboard.press("Escape")
        return False
    antes = _abas(page)
    # Irreversível: um único clique, fora de qualquer etapa que refaça.
    conectar.click(timeout=10000)
    # Dá tempo de o clique ser processado; nada é fechado depois (o usuário continua a sessão).
    page.wait_for_timeout(2000)
    for aba in _abas(page):
        if aba not in antes:
            _registrar_sessao(aba)
    return True


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
            # O pedido ainda vale e, no fallback de MacBook, a base local não mudou: confere agora e de novo logo antes do Conectar.
            fallback = bool(achado.get("_fallback_mac"))
            recusado = {"status": "ambiguous", "serial": serial, "origem": "base_local" if fallback else "pedido_cancelado"}

            def _ainda_vale() -> bool:
                return antes_de_conectar is None or bool(antes_de_conectar(fallback))

            if not _ainda_vale():
                return recusado
            # Identidade pelo link da linha achada pela série, nunca pela posição na grade.
            href = str(achado.get("_href") or "")
            if not grid.HREF_DETALHE.match(href):
                raise automation.RotinaErro(f"O link do computador da série {serial} não foi identificado na grade do Endpoint.")
            link = f'a.anchor-text[href="{href}"]'
            linha = page.locator(f"{_LINHA}:has({link})")
            hostname = linha.first.locator("a.anchor-text").first.inner_text(timeout=10000).strip()
            if grid.normalizar(hostname) != grid.normalizar(achado.get("_hostname")):
                raise automation.RotinaErro(
                    f"A linha da série {serial} mudou no Endpoint ({hostname} em vez de {achado.get('_hostname')}); não abri o controle remoto.")

            def _no_detalhe() -> bool:
                return bool(re.search(re.escape(href) + r"(/|$)", page.url))

            def _abrir_menu_na_grade() -> None:
                if not linha.count():
                    raise automation.EtapaInstavel(f"a linha de {hostname} não está mais na grade")
                linha.first.locator(".resource-action--button").first.click(timeout=10000)

            def _abrir_menu_na_pagina() -> None:
                if not _no_detalhe():  # outro computador aberto ou ainda na grade: vai ao detalhe deste link
                    if page.locator(link).count():
                        page.locator(link).first.click(timeout=10000)
                    else:
                        page.goto(automation.ENDPOINT_URL.split("#")[0] + href, wait_until="domcontentloaded", timeout=automation.CARREGAMENTO_MS)
                    automation.acionar_quando_pronto(lambda: None, "A página do computador não abriu", confirmar=_no_detalhe)
                page.locator(".resource-action--tab .resource-action--button").first.click(timeout=20000)

            abrir_menu = _abrir_menu_na_grade
            _clicar_resiliente(abrir_menu, "Abrir menu de ações do computador")
            if not _menu_com_controle_remoto(page):
                # Monitor vermelho ou sem a opção: tenta o menu "Ações" da página do computador.
                page.keyboard.press("Escape")
                abrir_menu = _abrir_menu_na_pagina
                _clicar_resiliente(abrir_menu, "Abrir menu de ações na página do computador")
                if not _menu_com_controle_remoto(page):
                    page.keyboard.press("Escape")
                    return {"status": "offline", "serial": serial, "hostname": hostname}
            def _mesmo_contexto() -> bool:
                return bool(linha.count()) or _no_detalhe()

            if not _conectar_controle_remoto(page, abrir_menu, _mesmo_contexto, _ainda_vale):
                return recusado
            return {"status": "connected", "serial": serial, "hostname": hostname}


# --- PowerShell remoto (Gerente do Sistema). O comando só é INSERIDO no campo: nunca se envia Enter. ---
HOSTNAME_PADRAO_POWERSHELL = "PRNOTEUMU005"
_PREFIXO_FALLBACK_POWERSHELL = "prnote"
LIMITE_COMANDO_POWERSHELL = 2000
ESPERA_TERMINAL_S = 40
INTERVALO_TERMINAL_S = 4
_ITEM_GERENTE = 'li.zmenu__item[data-label="Gerente do Sistema"]:visible'
_ITEM_POWERSHELL = 'li.zmenu__item[data-label="PowerShell"]:visible'
_CAMPO_POWERSHELL = "#remotePowershellInputField"
_TEXTOS_PRONTO = ("Atualmente conectado como",)  # "Executar como" é só o rótulo do botão e aparece antes da conexão


def validar_comando(comando: str) -> str:
    """Rejeita comando vazio, grande demais ou com quebra de linha/controle (Enter embutido)."""
    if not comando.strip():
        raise ValueError("Informe o comando.")
    if len(comando) > LIMITE_COMANDO_POWERSHELL:
        raise ValueError(f"O comando excede {LIMITE_COMANDO_POWERSHELL} caracteres.")
    # Cc (controle, inclui \n e \r), Cf (bidi/largura zero), Zl e Zp (U+2028/2029): quebra de linha ou texto que engana o cartão.
    if any(c != "\t" and unicodedata.category(c) in ("Cc", "Cf", "Zl", "Zp") for c in comando):
        raise ValueError("O comando não pode ter quebra de linha nem caracteres de controle.")
    return comando


def _linhas_do_filtro(page: Any) -> list[tuple[str, bool, str]]:
    """(hostname, ícone 'Ao vivo', link) de cada linha; o link identifica o computador mesmo se a grade se mexer."""
    saida = []
    for i in range(page.locator(_LINHA).count()):
        linha = page.locator(_LINHA).nth(i)
        ancora = linha.locator("a.anchor-text").first
        nome = ancora.inner_text(timeout=10000).strip()
        href = ancora.get_attribute("href", timeout=2000) or ""
        try:
            alt = linha.locator(".resource-action--button img").first.get_attribute("alt", timeout=2000) or ""
        except Exception:
            alt = ""
        saida.append((nome, alt == "Ao vivo", href))
    return saida


def _escolher_host(page: Any, hostname: str, explicito: bool) -> dict[str, Any]:
    """Host explícito é sempre tentado (ícone vermelho não bloqueia); só o padrão offline cai para outro online."""
    grid.aplicar_filtro(page, automation, grid.COLUNA_NOME, hostname)
    alvo = next((l for l in _linhas_do_filtro(page) if l[0].upper() == hostname.upper()), None)
    if alvo is None:
        return {"status": "not_found", "hostname": hostname}
    if explicito or alvo[1]:
        return {"hostname": alvo[0], "href": alvo[2]}
    grid.limpar_filtro(page, automation, grid.COLUNA_NOME)
    grid.aplicar_filtro(page, automation, grid.COLUNA_NOME, _PREFIXO_FALLBACK_POWERSHELL)
    online = next((l for l in _linhas_do_filtro(page) if l[1]), None)
    if online is None:
        return {"status": "sem_host_online", "hostname": hostname, "hostname_padrao_offline": True}
    return {"hostname": online[0], "href": online[2], "hostname_padrao_offline": True}


def _texto_da_aba(aba: Any) -> str:
    try:
        return aba.evaluate("document.body ? document.body.innerText : ''") or ""
    except Exception:
        return ""


def _esperar_texto(aba: Any, textos: tuple[str, ...]) -> bool:
    """Polling de 4 s por ~40 s; 'desconectado' na tela encerra a espera como falha."""
    for _ in range(ESPERA_TERMINAL_S // INTERVALO_TERMINAL_S):
        texto = _texto_da_aba(aba)
        if "desconectado" in texto.lower():
            return False
        if any(t in texto for t in textos):
            return True
        aba.wait_for_timeout(INTERVALO_TERMINAL_S * 1000)
    return False


def _selecionar_usuario(aba: Any, usuario: str | None) -> tuple[str | None, dict[str, Any] | None]:
    aba.locator("button#runAsUserTargetBind").first.click(timeout=10000)
    aba.locator(".popover-list").first.wait_for(state="visible", timeout=10000)
    aba.locator(".popover-list li#availableUsersHeader button").first.click(timeout=10000)
    aba.wait_for_timeout(3000)  # dá tempo de a lista atualizar
    itens = aba.locator(".popover-list li:not([id])")
    nomes = [itens.nth(i).inner_text(timeout=5000).strip() for i in range(itens.count())]
    nomes = [n for n in nomes if n]
    if usuario:
        escolhido = next((n for n in nomes if n.lower() == usuario.lower()), None)
    else:
        escolhido = nomes[0] if len(nomes) == 1 else None
    if escolhido is None:
        status = "usuario_ambiguo" if len(nomes) > 1 and not usuario else "sem_usuario"
        return None, {"status": status, "usuarios": nomes}
    itens.nth(nomes.index(escolhido)).click(timeout=10000)
    return escolhido, None


def _preparar_terminal(aba: Any, modo: str, usuario: str | None) -> tuple[str | None, dict[str, Any] | None]:
    """Devolve (usuário conectado, None), (None, erro de usuário) ou (None, None) se o terminal falhou após 1 reload."""
    for tentativa in (1, 2):
        try:
            if tentativa == 2:
                aba.reload(wait_until="domcontentloaded")
            if not _esperar_texto(aba, _TEXTOS_PRONTO):
                continue
            if modo == "sistema":
                return "SYSTEM", None
            escolhido, erro = _selecionar_usuario(aba, usuario)
            if erro:
                return None, erro
            if _esperar_texto(aba, (f"Atualmente conectado como {escolhido}",)):
                return escolhido, None
        except Exception:
            continue
    return None, None


def _fechar_aba(aba: Any) -> None:
    try:
        aba.close()
    except Exception:
        pass


def _abrir_powershell_na_grade(page: Any, hostname: str, explicito: bool, modo: str, comando: str, usuario: str | None) -> dict[str, Any]:
    escolha = _escolher_host(page, hostname, explicito)
    if "href" not in escolha:
        return escolha
    usado, href = escolha["hostname"], escolha["href"]
    if not grid.HREF_DETALHE.match(href):
        raise automation.RotinaErro(f"O link do computador {usado} não foi identificado na grade do Endpoint; o PowerShell não foi aberto.")
    linha = page.locator(f'{_LINHA}:has(a.anchor-text[href="{href}"])')
    extra = {"hostname_padrao_offline": True} if escolha.get("hostname_padrao_offline") else {}

    def _abrir_aba() -> Any:
        # Refeito do zero se falhar: aba nova que sobrar desta tentativa é fechada antes da próxima.
        antes = list(page.context.pages)
        try:
            if not linha.count():
                raise automation.EtapaInstavel(f"a linha de {usado} não está mais na grade")
            linha.first.locator(".resource-action--button").first.click(timeout=10000)
            page.locator(_ITEM_GERENTE).first.hover(timeout=10000)
            with page.context.expect_page(timeout=20000) as nova:
                page.locator(_ITEM_POWERSHELL).first.click(timeout=10000)
            return nova.value
        except Exception as erro:
            for sobra in page.context.pages:
                if sobra is not page and sobra not in antes:
                    _fechar_aba(sobra)
            raise automation.EtapaInstavel(str(erro)) from erro

    aba = automation.etapa_resiliente(_abrir_aba, "Abrir o PowerShell do computador")
    conectado, erro = _preparar_terminal(aba, modo, usuario)
    if erro:
        _fechar_aba(aba)
        return {**erro, "hostname": usado, "modo": modo, **extra}
    if conectado is None:
        _fechar_aba(aba)
        return {"status": "erro_terminal", "hostname": usado, "modo": modo, **extra, "mensagem": (
            f"Não foi possível abrir o PowerShell em {usado} (conexão lenta, agente desconectado ou equipamento desligado). "
            "Recarreguei a página uma vez e o erro continuou; a execução foi cancelada.")}
    try:
        campo = aba.locator(_CAMPO_POWERSHELL).first
        campo.fill(comando, timeout=10000)  # só insere; nunca Enter
        confirmado = campo.input_value() == comando
    except Exception:
        confirmado = False
    if not confirmado:
        _fechar_aba(aba)
        return {"status": "erro_terminal", "hostname": usado, "modo": modo, **extra,
                "mensagem": f"O comando não foi confirmado no campo do PowerShell de {usado}; a execução foi cancelada."}
    _registrar_sessao(aba)
    return {"status": "inserido", "hostname": usado, "modo": modo, "usuario": conectado, "inserido": True, "enter_enviado": False, **extra}


def abrir_powershell(hostname: str | None, modo: str, comando: str, usuario: str | None = None) -> dict[str, Any]:
    """Abre o PowerShell do Gerente do Sistema e INSERE o comando no prompt; nunca envia Enter nem fecha a aba."""
    if modo not in ("sistema", "usuario"):
        raise ValueError("Modo inválido.")
    validar_comando(comando)
    explicito = bool(hostname)
    with automation.trava_execucao("consulta_endpoint"):
        from playwright.sync_api import sync_playwright

        automation.log("PowerShell", f"Inserindo comando (tamanho {len(comando)}, modo {modo}).")  # nunca o conteúdo
        setattr(automation, "_inicio_execucao", automation.time.time())
        with sync_playwright() as pw:
            page = _preparar_aba(pw)
            return _abrir_powershell_na_grade(page, hostname or HOSTNAME_PADRAO_POWERSHELL, explicito, modo, comando, usuario)
