"""Chrome adapter for the UX ticket form."""
from __future__ import annotations

from contextlib import contextmanager
from importlib import import_module
import re
from time import monotonic
from typing import Any, Callable, Iterator
from urllib.parse import urlsplit

from domains.ux_chamados import MSG_SEM_ENVIO, SERIES_SEM_ENVIO_REAL, ErroUX, envio_desativado

automation = import_module("scripts.automacao_rotinas_chrome")


LeituraLista = tuple[list[tuple[int, str, int]], int, int, int]
LISTA_INCOMPLETA = "Não foi possível confirmar a lista completa de problemas no UX."
MSG_CHROME = "Não foi possível abrir ou conectar o Chrome de automação. Feche as janelas desse Chrome e tente de novo."


def ler_opcoes_rolaveis(
    ler: Callable[[], LeituraLista],
    rolar: Callable[[int], None],
    aguardar: Callable[[], None] = lambda: None,
) -> list[tuple[str, int]]:
    """Require stable rows and every ordinal in the total declared by the list."""
    encontradas: dict[int, tuple[str, int]] = {}
    esperado = total = 0
    for _ in range(256):
        anterior: LeituraLista | None = None
        for tentativa in range(6):
            if tentativa:
                aguardar()
            amostra = ler()
            linhas, atual, maximo, proximo = amostra
            if amostra != anterior or atual != esperado or not linhas:
                anterior = amostra
                continue
            total = total or linhas[0][2]
            indices = {posicao for posicao, _, _ in linhas}
            if len(indices) != len(linhas) or any(
                not isinstance(posicao, int) or not isinstance(declarado, int)
                or declarado != total or not 1 <= posicao <= total
                for posicao, _, declarado in linhas
            ):
                raise ErroUX(409, LISTA_INCOMPLETA)
            for posicao, texto, _ in linhas:
                if encontradas.setdefault(posicao, (texto, atual))[0] != texto:
                    raise ErroUX(409, "A lista de problemas mudou durante a leitura no UX.")
            if atual == maximo:
                if len(encontradas) == total:
                    return [encontradas[posicao] for posicao in sorted(encontradas)]
                continue  # The scrollbar can reach the end before the last rows render.
            esperado = min(proximo, maximo)
            if esperado <= atual:
                raise ErroUX(409, LISTA_INCOMPLETA)
            rolar(esperado)
            break
        else:
            break
    raise ErroUX(409, LISTA_INCOMPLETA)


@contextmanager
def contexto_chrome_ux() -> Iterator[Any]:
    """Each request owns its CDP connection; no Playwright objects cross threads."""
    try:
        with automation.trava_execucao("abrir_chamado_ux"):
            from playwright.sync_api import sync_playwright

            try:
                automation.garantir_chrome()  # opens the automation Chrome when it was closed
            except Exception:
                raise ErroUX(503, MSG_CHROME, codigo="chrome_indisponivel") from None
            with sync_playwright() as pw:
                try:
                    browser = pw.chromium.connect_over_cdp(automation.CDP_URL, timeout=10_000)
                except Exception:
                    raise ErroUX(503, MSG_CHROME, codigo="chrome_indisponivel") from None
                if not browser.contexts:
                    raise ErroUX(503, "Abra o Chrome de automação antes de preparar o chamado.")
                yield browser.contexts[0]
    except automation.TravaOcupada:
        raise ErroUX(409, "O Chrome está ocupado por outra automação. Tente novamente ao terminar.") from None



_SCRIPT_HOST = """
const temRolagem = node => node !== document.body && node !== document.documentElement
    && node.scrollHeight > node.clientHeight + 1 && node.clientHeight > 0
    && /^(auto|scroll)$/.test(getComputedStyle(node).overflowY);
const internos = [lista, ...lista.querySelectorAll('*')].filter(node =>
    temRolagem(node) && node.querySelector('[role="option"]'));
if (internos.length > 1) throw new Error('Lista com mais de uma área de rolagem');
let host = internos[0];
if (!host) {
    for (let pai = lista.parentElement; pai && pai !== document.body; pai = pai.parentElement) {
        if (temRolagem(pai)) { host = pai; break; }
    }
}
"""


def _rolar_lista(lista: Any, posicao: int) -> None:
    lista.evaluate("(lista, posicao) => {" + _SCRIPT_HOST + """
        if (host) host.scrollTop = posicao;
        else if (posicao !== 0) throw new Error('Área de rolagem ausente');
        return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }""", posicao)


def _ler_lista_completa_no_dom(page: Any, lista: Any) -> list[tuple[str, int]]:
    """ng-select renders every option without aria-posinset/setsize: accept only stable reads that reach the end."""
    def ler() -> tuple[list[str], int]:
        textos, fim = lista.evaluate("(lista) => {" + _SCRIPT_HOST + """
            if (host) host.scrollTop = host.scrollHeight;
            return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve([
                [...lista.querySelectorAll('[role="option"]')].filter(el => el.getAttribute('aria-disabled') !== 'true')
                    .map(el => el.innerText.trim()),
                host ? Number(host.scrollTop + host.clientHeight >= host.scrollHeight - 1) : 1,
            ]))));
        }""")
        return textos, fim

    anterior: list[str] | None = None
    for tentativa in range(6):
        if tentativa:
            page.wait_for_timeout(120)
        textos, fim = ler()
        if textos and fim and textos == anterior:
            return [(texto, 0) for texto in textos if texto]
        anterior = textos
    raise ErroUX(409, LISTA_INCOMPLETA)


def _ler_lista_acessivel(page: Any, lista: Any) -> list[tuple[str, int]]:
    if not lista.evaluate("(lista) => !!lista.querySelector('[role=\"option\"][aria-setsize]')"):
        return _ler_lista_completa_no_dom(page, lista)
    def ler() -> LeituraLista:
        linhas, atual, maximo, proximo = lista.evaluate("(lista) => {" + _SCRIPT_HOST + """
            const atual = host ? Math.round(host.scrollTop) : 0;
            const maximo = host ? host.scrollHeight - host.clientHeight : 0;
            const linhas = [...lista.querySelectorAll('[role="option"]')].flatMap(el => {
                if (!el.getBoundingClientRect().height) return [];
                return [[
                    Number(el.getAttribute('aria-posinset')),
                    el.getAttribute('aria-disabled') === 'true' ? '' : el.innerText.trim(),
                    Number(el.getAttribute('aria-setsize')),
                ]];
            });
            return [linhas, atual, maximo, atual + (host ? Math.max(1, Math.floor(host.clientHeight / 2)) : 0)];
        }""")
        return [tuple(linha) for linha in linhas], atual, maximo, proximo

    _rolar_lista(lista, 0)
    opcoes = ler_opcoes_rolaveis(ler, lambda pos: _rolar_lista(lista, pos), lambda: page.wait_for_timeout(60))
    return [(texto, posicao) for texto, posicao in opcoes if texto]

ORIGEM_UX = "https://ux.simpress.com.br"
ROTA_ATENDIMENTO = "/ng/solicitar-atendimento/equipamentos/"
ROTA_INICIAL = ROTA_ATENDIMENTO + "1"
ROTAS_FORMULARIO = (ROTA_INICIAL, ROTA_ATENDIMENTO + "2")
CONTROLES_MS = 10_000
ESPERA_LOGIN_S = 420
ESPERA_OS_S = 30
TITULO_SERIE_MODELO = re.compile(r"^\s*Número de série/Modelo:\s*([^/]+?)\s*/\s*(.+?)\s*$")
TITULO_OS = re.compile(r"^\s*#([0-9]{1,24})\s*$")
BOTAO_ENVIAR = re.compile(r"^Enviar solicita[cç][aã]o$", re.IGNORECASE)
IDS_SOLICITANTE = {"nome": "nome", "email": "email", "telefone": "telefone", "ramal": "ramal", "departamento_cargo": "cargo"}
CAMPOS_SOLICITANTE = {
    "nome": "Nome", "email": "E-mail", "telefone": "Telefone para contato",
    "ramal": "Ramal", "departamento_cargo": "Departamento/Cargo",
}


def _rota(url: str) -> str:
    partes = urlsplit(url)
    return partes.path.rstrip("/") if partes.scheme == "https" and partes.netloc == "ux.simpress.com.br" else ""


def _unico(locator: Any) -> Any:
    elemento = locator.filter(visible=True)
    elemento.wait_for(state="visible", timeout=CONTROLES_MS)
    return elemento


def _rotulado(page: Any, nome: str) -> Any:
    return page.get_by_label(nome, exact=True).or_(page.get_by_placeholder(nome, exact=True))


def _botao(page: Any, nome: str) -> Any:
    return page.get_by_role("button", name=nome, exact=True)


def _botao_enviar(page: Any) -> Any:
    """The real portal writes "Enviar Solicitação"; the plain-text spelling stays accepted."""
    return page.get_by_role("button", name=BOTAO_ENVIAR)


def _campo_serie(page: Any) -> Any:
    return _rotulado(page, "Número de série").or_(page.locator("input#numeroSerie"))


def _campo_solicitante(page: Any, campo: str) -> Any:
    """Contact inputs carry only aria-label=id (nome, email, telefone, ramal, cargo), never the visible label."""
    return _rotulado(page, CAMPOS_SOLICITANTE[campo]).or_(page.locator(f"input#{IDS_SOLICITANTE[campo]}"))


def _campo_descricao(page: Any) -> Any:
    return _rotulado(page, "Descreva o problema").or_(page.locator("textarea"))


def _fechar_aviso_backup(page: Any, espera_ms: int = 0) -> None:
    """Step 2 opens an informational "Backup de dados" modal that blocks every click until closed."""
    aviso = page.locator("app-modal[titulo='Backup de dados'] .fechar").filter(visible=True)
    for _ in range(max(1, espera_ms // 250 + 1)):
        if aviso.count() == 1:
            aviso.click(timeout=CONTROLES_MS)
            aviso.wait_for(state="hidden", timeout=CONTROLES_MS)
            return
        if espera_ms:
            page.wait_for_timeout(250)


def _valor_confere(campo: str, atual: str, esperado: str) -> bool:
    if campo == "telefone":
        return re.sub(r"\D", "", atual) == re.sub(r"\D", "", esperado)
    return atual == esperado


class PortalUXChrome:
    def __init__(self, contexto: Any) -> None:
        self._contexto = contexto
        self._pronto: tuple[str, str, str] | None = None

    @staticmethod
    def _identificar_equipamento(page: Any, serial: str) -> str:
        _unico(page.get_by_text("Etapa 2 de 2", exact=True))
        dados = _unico(page.get_by_text(TITULO_SERIE_MODELO)).inner_text(timeout=CONTROLES_MS)
        achado = TITULO_SERIE_MODELO.fullmatch(dados)
        if not achado or achado.group(1).strip().upper() != serial or not achado.group(2).strip():
            raise ErroUX(409, "O equipamento exibido no UX não corresponde à série selecionada.")
        return achado.group(2).strip()

    def _aba(self, nome: str, *, encerrada: bool = False) -> Any:
        """Find the session tab; `encerrada` accepts any UX route (after the submit the form route is gone)."""
        abas = []
        for page in self._contexto.pages:
            if encerrada:
                achada = urlsplit(page.url).netloc == "ux.simpress.com.br" and str(page.evaluate("window.name")).startswith(f"{nome}:")
            else:
                rota = _rota(page.url)
                achada = rota in ROTAS_FORMULARIO and page.evaluate("window.name") == f"{nome}:{rota}"
            if achada:
                abas.append(page)
        if len(abas) != 1:
            raise ErroUX(409, "A aba da sessão foi fechada ou saiu da rota do formulário. Prepare novamente.")
        return abas[0]

    def fechar(self, aba: str) -> None:
        """Close only the session's own tab; no click and no navigation."""
        self._aba(aba, encerrada=True).close()

    def _validar(self, serial: str, modelo: str, aba: str) -> Any:
        page = self._aba(aba)
        if self._identificar_equipamento(page, serial) != modelo:
            raise ErroUX(409, "O modelo exibido no UX mudou. Prepare novamente.")
        return page

    def validar(self, serial: str, modelo: str, aba: str) -> None:
        self._validar(serial, modelo, aba)

    @staticmethod
    def _esperar_etapa_inicial(page: Any) -> None:
        limite = monotonic() + ESPERA_LOGIN_S
        voltou = False
        while monotonic() < limite:
            rota = _rota(page.url)
            if rota == ROTA_INICIAL and _campo_serie(page).filter(visible=True).count() == 1:
                return
            if rota and rota != ROTA_INICIAL and not voltou and automation.ux_logado(page):
                page.goto(ORIGEM_UX + ROTA_INICIAL, wait_until="domcontentloaded", timeout=CONTROLES_MS)
                voltou = True
            page.wait_for_timeout(300)
        raise ErroUX(503, "Conclua o login manual no Chrome de automação e prepare novamente.")

    def preparar(self, serial: str, aba: str) -> tuple[str, list[str]]:
        page = self._contexto.new_page()
        page.goto(ORIGEM_UX + ROTA_INICIAL, wait_until="domcontentloaded", timeout=CONTROLES_MS)
        page.bring_to_front()
        self._esperar_etapa_inicial(page)
        _unico(_campo_serie(page)).fill(serial, timeout=CONTROLES_MS)
        _unico(_botao(page, "Buscar")).click(timeout=CONTROLES_MS)
        _unico(_botao(page, "Próximo")).click(timeout=CONTROLES_MS)
        rota = _rota(page.url)
        if rota not in ROTAS_FORMULARIO:
            raise ErroUX(409, "O UX saiu da rota esperada para o formulário.")
        modelo = self._identificar_equipamento(page, serial)
        rota = _rota(page.url)
        if rota not in ROTAS_FORMULARIO:
            raise ErroUX(409, "O UX saiu da rota esperada para o formulário.")
        page.evaluate("(nome) => { window.name = nome; }", f"{aba}:{rota}")
        _fechar_aviso_backup(page, espera_ms=3000)
        return modelo, self._opcoes(page)

    @staticmethod
    def _controle_problema(page: Any) -> Any:
        nome = "Selecione o problema"
        ng_select = page.locator("ng-select").filter(visible=True)
        if ng_select.count() == 1:
            return _unico(ng_select)
        return _unico(_rotulado(page, nome).or_(page.get_by_role("combobox", name=nome, exact=True)).or_(_botao(page, nome)))

    @staticmethod
    def _opcoes(page: Any, problema: str | None = None) -> list[str]:
        controle = PortalUXChrome._controle_problema(page)
        if controle.evaluate("(el) => el.tagName === 'SELECT'"):
            dados = controle.evaluate("""el => Array.from(el.options).map((o, i) =>
                [i, o.text.trim(), Boolean(o.value) && !o.matches(':disabled')])""")
            opcoes = [(i, nome) for i, nome, habilitada in dados if nome and habilitada]
            if problema is not None:
                indices = [i for i, nome in opcoes if nome == problema]
                if len(indices) != 1:
                    raise ErroUX(409, "O problema escolhido não corresponde a uma única opção do UX.")
                controle.select_option(index=indices[0], timeout=CONTROLES_MS)
            return [nome for _, nome in opcoes]

        # Custom controls must expose an accessible listbox and options.
        listas = page.get_by_role("listbox").filter(visible=True)
        if listas.count():
            raise ErroUX(409, "Feche a lista de problemas no Chrome antes de continuar.")
        controle.click(timeout=CONTROLES_MS)
        lista = _unico(listas)
        itens = lista.get_by_role("option").filter(visible=True)
        itens.first.wait_for(state="visible", timeout=CONTROLES_MS)
        posicoes = _ler_lista_acessivel(page, lista)
        if problema is None:
            page.keyboard.press("Escape")
            lista.wait_for(state="hidden", timeout=CONTROLES_MS)
        else:
            pos = [deslocamento for nome, deslocamento in posicoes if nome == problema]
            if len(pos) != 1:
                raise ErroUX(409, "O problema escolhido não corresponde a uma única opção do UX.")
            _rolar_lista(lista, pos[0])
            _unico(lista.get_by_role("option", name=problema, exact=True)).click(timeout=CONTROLES_MS)
            lista.wait_for(state="hidden", timeout=CONTROLES_MS)
        return [nome for nome, _ in posicoes]

    @staticmethod
    def _solicitante_faltando(page: Any, campos: dict[str, Any]) -> list[str]:
        """Without a local profile the portal's own Solicitante stays as it is; report what is still empty."""
        for _ in range(8):  # the Angular form fills its fields a moment after the step opens
            vazios = [c for c, el in campos.items() if c != "ramal" and not el.input_value(timeout=CONTROLES_MS).strip()]
            if not vazios:
                break
            page.wait_for_timeout(250)
        return [CAMPOS_SOLICITANTE[c] for c in vazios]

    def preencher(
        self, serial: str, modelo: str, aba: str, problema: str, descricao: str, solicitante: dict[str, str],
    ) -> list[str]:
        self._pronto = None
        page = self._validar(serial, modelo, aba)
        _unico(page.get_by_text("Solicitante", exact=True))
        _fechar_aviso_backup(page)
        campos = {campo: _unico(_campo_solicitante(page, campo)) for campo in CAMPOS_SOLICITANTE}
        texto = _unico(_campo_descricao(page))
        self._opcoes(page, problema)
        texto.fill(descricao, timeout=CONTROLES_MS)
        faltando = [] if solicitante else self._solicitante_faltando(page, campos)
        for campo, elemento in (campos.items() if solicitante else ()):
            valor = solicitante[campo]
            if not _valor_confere(campo, elemento.input_value(timeout=CONTROLES_MS), valor):
                elemento.fill(valor, timeout=CONTROLES_MS)
            if not _valor_confere(campo, elemento.input_value(timeout=CONTROLES_MS), valor):
                raise ErroUX(409, "O UX não manteve um dos valores do solicitante.")
        self._validar(serial, modelo, aba)
        self._pronto = (serial, modelo, aba)
        return faltando

    def enviar(self, aba: str) -> str:
        pronto, self._pronto = self._pronto, None
        if envio_desativado() or (pronto is not None and pronto[0] in SERIES_SEM_ENVIO_REAL):
            raise ErroUX(422, MSG_SEM_ENVIO)  # last barrier before the click
        if pronto is None or pronto[2] != aba:
            raise ErroUX(409, "A aba não está pronta para envio.")
        page = self._validar(*pronto)
        _unico(_botao_enviar(page)).click(timeout=CONTROLES_MS)
        prazo = monotonic() + ESPERA_OS_S
        while monotonic() < prazo:
            rota = _rota(page.url)
            if (
                rota.startswith("/ng/solicitar-atendimento/")
                and not _botao_enviar(page).filter(visible=True).count()
                and not page.get_by_text("Etapa 2 de 2", exact=True).filter(visible=True).count()
            ):
                os_visivel = page.get_by_text(TITULO_OS).filter(visible=True)
                if os_visivel.count() == 1:
                    achado = TITULO_OS.fullmatch(os_visivel.inner_text(timeout=CONTROLES_MS))
                    if achado:
                        return achado.group(1)
            page.wait_for_timeout(250)
        raise TimeoutError("O UX não mostrou uma OS inequívoca.")


@contextmanager
def conectar_ux() -> Iterator[PortalUXChrome]:
    with contexto_chrome_ux() as contexto:
        yield PortalUXChrome(contexto)

