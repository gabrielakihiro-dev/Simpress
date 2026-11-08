"""Chrome adapter for the UX "Gerar ticket" form (address update after a transfer). Sibling of PortalUXChrome."""
from __future__ import annotations

from contextlib import contextmanager
import logging
import re
from time import monotonic
from typing import Any, Callable, Iterator, TypeVar
from urllib.parse import urlsplit

from domains.ux_chamados import MSG_SEM_ENVIO, SERIES_SEM_ENVIO_REAL, ErroUX, envio_desativado
from domains.ux_chamados_browser import (
    CONTROLES_MS, ESPERA_LOGIN_S, ESPERA_OS_S, ORIGEM_UX, _botao, _fechar_aviso_backup, _ler_lista_acessivel, _rota,
    _unico, _valor_confere, automation, contexto_chrome_ux,
)
from domains.ux_ticket import (
    ANEXO_MAX, CHAMADO_INTERNO_MAX, CONTRATO, DESCRICAO_MAX, INCIDENTE, MOTIVO, Formulario,
)

T = TypeVar("T")
logger = logging.getLogger(__name__)
ROTA_CONSULTA = "/ng/gerar-ticket/consulta"
ROTA_ABRIR = "/ng/gerar-ticket/abrir-ticket"
DESCRICAO = 'textarea[placeholder="Nos conte, em detalhes, o que houve."]'
MIME_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
DIGITOS = "telefone"  # _valor_confere compares digits only for this field name
TENTATIVAS = 3  # whole preparation from the consulta screen, first try included
ROTULO_CONTRATO = re.compile(r"^[ \t]*NOME DO CONTRATO[ \t]*:?[ \t]*(?:\n[ \t]*)?([^\n\t]+?)[ \t]*$", re.MULTILINE)
ROTULO_MODELO = re.compile(r"^[ \t]*MODELO[ \t]*:?[ \t]*(?:\n[ \t]*)?([^\n\t]+?)[ \t]*$", re.MULTILINE)
# shortcut: detector genérico, ajustar quando houver print de um ticket finalizado.
NUMERO_TICKET = re.compile(r"\b(?:ticket|protocolo|chamado)\b[^0-9\n]{0,30}?#?\s*(\d{3,24})\b", re.IGNORECASE)
MSG_ABA = "A aba da sessão foi fechada ou saiu do UX. Prepare novamente."
# Never retried: data validation (422), login timeout or Chrome (503), a lost tab, a user choice to redo.
SEM_RETENTATIVA = {"aba_perdida", "endereco_ambiguo"}


def _do_contrato(texto: str) -> bool:
    return re.match(rf"{CONTRATO}(?!\d)", texto.strip()) is not None


def _na_rota(page: Any, rota: str) -> None:
    """Route guard: an accidental click (link, /ng/home, another site) fails the current step."""
    if _rota(page.url) != rota:
        raise ErroUX(409, "A aba do UX saiu da tela esperada.", codigo="rota_inesperada")


def _no_login(page: Any) -> bool:
    url = page.url.lower()
    return urlsplit(url).netloc != "ux.simpress.com.br" or "login" in url or "autenticacao" in url


def _repetivel(erro: Exception) -> bool:
    if isinstance(erro, ErroUX):
        return erro.status == 409 and erro.codigo not in SEM_RETENTATIVA
    return True  # Playwright errors and timeouts


def _selecionado(page: Any, campo: str) -> str:
    """ng-select keeps the chosen label outside the input (input_value() is the search box)."""
    rotulo = page.locator(f"ng-select:has(input#{campo}) .ng-value-label")
    if rotulo.count() != 1:
        return ""
    return str(rotulo.inner_text(timeout=CONTROLES_MS)).strip()


def _escolher(page: Any, campo: str, alvo: str | None, *, busca: str | None = None) -> str:
    """Pick exactly one option of an ng-select; alvo=None picks the single contract option. Returns the label."""
    listas = page.get_by_role("listbox").filter(visible=True)
    if listas.count():
        raise ErroUX(409, "Feche a lista aberta no Chrome do UX antes de continuar.")
    entrada = _unico(page.locator(f"input#{campo}"))
    entrada.click(timeout=CONTROLES_MS)
    if busca is not None:
        entrada.fill(busca, timeout=CONTROLES_MS)
    lista = _unico(listas)
    lista.get_by_role("option").filter(visible=True).first.wait_for(state="visible", timeout=CONTROLES_MS)
    opcoes = [texto for texto, _ in _ler_lista_acessivel(page, lista)]
    achadas = [texto for texto in opcoes if (_do_contrato(texto) if alvo is None else texto == alvo)]
    # The UX may list the same address twice with an identical label: one label = one choice. Different labels still fail.
    if len(set(achadas)) != 1:
        page.keyboard.press("Escape")
        raise ErroUX(409, "A opção esperada não corresponde a uma única opção do UX.")
    lista.get_by_role("option", name=achadas[0], exact=True).first.click(timeout=CONTROLES_MS)
    lista.wait_for(state="hidden", timeout=CONTROLES_MS)
    if _selecionado(page, campo) != achadas[0]:
        raise ErroUX(409, "O UX não manteve a opção escolhida.")
    return achadas[0]


def _preencher(campo: Any, valor: str, *, nome: str = "", digitado: str | None = None) -> None:
    campo.fill(valor if digitado is None else digitado, timeout=CONTROLES_MS)
    if not _valor_confere(nome, str(campo.input_value(timeout=CONTROLES_MS)).replace("\r\n", "\n"), valor):
        raise ErroUX(409, "O UX não manteve um dos valores preenchidos.")


def _fechar_popup(popup: Any) -> None:
    try:
        popup.close()
    except Exception:
        pass  # already closed


class PortalTicketUXChrome:
    def __init__(self, contexto: Any) -> None:
        self._contexto = contexto
        self._pronto: tuple[str, str, str, str, Formulario] | None = None
        self._etapa = ""
        self._vigiadas: list[Any] = []

    def _vigiar(self, page: Any) -> Any:
        """Close windows opened by an accidental click in the session tab; other tabs are never touched."""
        if not any(vigiada is page for vigiada in self._vigiadas):
            page.on("popup", _fechar_popup)
            self._vigiadas.append(page)
        return page

    def _fechar_popups(self, page: Any) -> None:
        """Also catch popups opened between requests, before this connection's listener existed."""
        for outra in list(self._contexto.pages):
            try:
                aberta_pela_sessao = outra is not page and outra.opener() is page
            except Exception:
                aberta_pela_sessao = False
            if aberta_pela_sessao:
                _fechar_popup(outra)

    def _aba(self, nome: str) -> Any:
        """The session tab: the single UX tab whose window.name starts with the session name (any UX route)."""
        abas = [
            page for page in self._contexto.pages
            if urlsplit(page.url).netloc == "ux.simpress.com.br" and str(page.evaluate("window.name")).startswith(f"{nome}:")
        ]
        if len(abas) != 1:
            raise ErroUX(409, MSG_ABA, codigo="aba_perdida")
        return self._vigiar(abas[0])

    def fechar(self, aba: str) -> None:
        """Close only the session's own tab; no click and no navigation."""
        self._aba(aba).close()

    def _passo(self, page: Any, nome: str, acao: Callable[[], T], *, rota: str = ROTA_ABRIR, depois: str | None = None) -> T:
        """One named step, with the route checked before and after it."""
        self._etapa = nome
        _na_rota(page, rota)
        resultado = acao()
        _na_rota(page, depois or rota)
        return resultado

    def _com_contingencia(
        self, page: Any, aba: str, refazer: Callable[[], T], primeira: Callable[[], T] | None = None,
    ) -> T:
        """Any retryable failure: back to the consulta in the SAME tab and redo everything from the contract.

        At most TENTATIVAS tries; a lost login waits like F1 and does not spend a try (bounded by TENTATIVAS too).
        The log keeps only the step name, the try number and the error class, never selectors or form data.
        """
        tentativa = logins = 0
        acao = primeira or (lambda: self._de_novo(page, aba, refazer))
        while True:
            tentativa += 1
            try:
                resultado = acao()
                self._fechar_popups(page)
                return resultado
            except Exception as erro:
                if page.is_closed():
                    raise ErroUX(409, MSG_ABA, codigo="aba_perdida") from None
                self._fechar_popups(page)
                if not _repetivel(erro):
                    raise
                logger.warning("UX ticket: passo %s, tentativa %d/%d, %s", self._etapa, tentativa, TENTATIVAS, type(erro).__name__)
                if _no_login(page) and logins < TENTATIVAS:
                    logins += 1
                    tentativa -= 1
                elif tentativa >= TENTATIVAS:
                    raise ErroUX(409, (
                        f'O UX falhou no passo "{self._etapa}" depois de {TENTATIVAS} tentativas. '
                        "Confira a aba do UX no Chrome de automação e prepare novamente."
                    ), codigo="ux_tentativas_esgotadas") from None
            acao = lambda: self._de_novo(page, aba, refazer)  # noqa: E731

    def _de_novo(self, page: Any, aba: str, refazer: Callable[[], T]) -> T:
        self._etapa = "Abrir a consulta"
        page.goto(ORIGEM_UX + ROTA_CONSULTA, wait_until="domcontentloaded", timeout=CONTROLES_MS)
        self._esperar_consulta(page)
        page.evaluate("(nome) => { window.name = nome; }", f"{aba}:consulta")  # lets cancel close it from here on
        return refazer()

    @staticmethod
    def _equipamento(page: Any, serial: str) -> str:
        """Check série, contract 16467 and a single MODELO in the header; return the model."""
        texto = str(_unico(page.locator("body")).inner_text(timeout=CONTROLES_MS))
        contratos = ROTULO_CONTRATO.findall(texto)
        modelos = ROTULO_MODELO.findall(texto)
        if (
            not re.search(rf"(?<![A-Z0-9]){re.escape(serial)}(?![A-Z0-9])", texto)
            or len(contratos) != 1 or not _do_contrato(contratos[0]) or len(modelos) != 1
        ):
            raise ErroUX(409, "O equipamento exibido no UX não corresponde à série, ao contrato ou ao modelo esperado.")
        return str(modelos[0]).strip()

    def _conferir_equipamento(self, page: Any, serial: str, modelo: str) -> None:
        if self._equipamento(page, serial) != modelo:
            raise ErroUX(409, "O modelo exibido no UX mudou.")

    @staticmethod
    def _esperar_consulta(page: Any) -> None:
        """Logged out: click "Acesso Time(s) Simpress" and pick gansouza once (never password or MFA), then wait
        like F1; once logged in elsewhere (/ng/home), go back to the search once."""
        if _no_login(page):
            automation.aguardar_login(page, "UX Simpress", automation.ux_logado, entrar=automation.ux_entrar,
                                      email=automation.EMAIL_DASHBOARD, esperar_usuario=False)
        limite = monotonic() + ESPERA_LOGIN_S
        voltou = False
        while monotonic() < limite:
            rota = _rota(page.url)
            if rota == ROTA_CONSULTA and page.locator("input#inputNumeroSerie").filter(visible=True).count() == 1:
                return
            if rota and rota != ROTA_CONSULTA and not voltou and automation.ux_logado(page):
                page.goto(ORIGEM_UX + ROTA_CONSULTA, wait_until="domcontentloaded", timeout=CONTROLES_MS)
                voltou = True
            page.wait_for_timeout(300)
        raise ErroUX(503, "Conclua o login manual no Chrome de automação e prepare novamente.")

    @staticmethod
    def _abrir_card(page: Any, serial: str) -> None:
        cartoes = page.locator("app-consulta-card-gerar-ticket")
        da_serie = cartoes.filter(has=page.locator("div.numeroSerieEquipamento", has_text=re.compile(
            rf"^\s*{re.escape(serial)}\s*$",
        )))
        anterior = -1
        prazo = monotonic() + CONTROLES_MS / 1000
        while monotonic() < prazo:  # results arrive asynchronously: wait for a stable, non-empty count
            atual = cartoes.count()
            if atual and atual == anterior:
                break
            anterior = atual
            page.wait_for_timeout(300)
        if da_serie.count() != 1:
            raise ErroUX(409, "O UX não mostrou exatamente um equipamento com essa série no contrato 16467.")
        _unico(da_serie.locator("div.card.cursor-pointer")).click(timeout=CONTROLES_MS)
        prazo = monotonic() + CONTROLES_MS / 1000
        while _rota(page.url) != ROTA_ABRIR:
            if monotonic() >= prazo:
                raise ErroUX(409, "O UX não abriu o formulário do ticket.")
            page.wait_for_timeout(200)

    @staticmethod
    def _ler_enderecos(page: Any) -> list[str]:
        """Open Meus Endereços and read every option; an empty list goes back to the user, never retried."""
        entrada = _unico(page.locator("input#novo-endereco"))
        entrada.click(timeout=CONTROLES_MS)  # waits until the search enables the control
        lista = _unico(page.get_by_role("listbox"))
        lista.locator('[role="option"], .ng-option').first.wait_for(state="visible", timeout=CONTROLES_MS)
        habilitadas = lista.locator('[role="option"]:not([aria-disabled="true"])')
        for _ in range(4):  # "Loading..." / "No items found" are .ng-option without a usable role=option
            if habilitadas.count():
                break
            page.wait_for_timeout(250)
        opcoes = [texto for texto, _ in _ler_lista_acessivel(page, lista)] if habilitadas.count() else []
        page.keyboard.press("Escape")
        lista.wait_for(state="hidden", timeout=CONTROLES_MS)
        return list(dict.fromkeys(opcoes))  # identical labels (e.g. Irati listed twice) are one address

    def _ate_enderecos(self, page: Any, serial: str, aba: str, cep: str) -> tuple[str, list[str]]:
        """From the consulta screen: contract → série → card → Incidente → Motivo → CEP → Meus Endereços."""
        self._passo(page, "Contrato", lambda: _escolher(page, "selectContrato", None, busca=CONTRATO), rota=ROTA_CONSULTA)
        self._passo(page, "Número de série", lambda: _preencher(_unico(page.locator("input#inputNumeroSerie")), serial),
                    rota=ROTA_CONSULTA)
        self._passo(page, "Buscar", lambda: _unico(_botao(page, "Buscar")).click(timeout=CONTROLES_MS), rota=ROTA_CONSULTA)
        self._passo(page, "Cartão do equipamento", lambda: self._abrir_card(page, serial), rota=ROTA_CONSULTA,
                    depois=ROTA_ABRIR)
        page.evaluate("(nome) => { window.name = nome; }", f"{aba}:abrir-ticket")
        self._passo(page, "Aviso de backup", lambda: _fechar_aviso_backup(page, espera_ms=1000))
        modelo = self._passo(page, "Cabeçalho do equipamento", lambda: self._equipamento(page, serial))
        self._passo(page, "Incidente", lambda: _escolher(page, "selectIncidente", INCIDENTE))
        self._passo(page, "Motivo", lambda: _escolher(page, "selectMotivo", MOTIVO))
        self._passo(page, "CEP", lambda: _preencher(_unico(page.locator("input#cep-novo-endereco")), cep, nome=DIGITOS))
        self._passo(page, "Buscar meus Endereços",
                    lambda: _unico(_botao(page, "Buscar meus Endereços")).click(timeout=CONTROLES_MS))
        opcoes = self._passo(page, "Meus Endereços", lambda: self._ler_enderecos(page))
        return modelo, opcoes

    def _fluxo(
        self, page: Any, serial: str, aba: str, cep: str, modelo: str, endereco: str,
        formulario: Formulario | None = None,
    ) -> None:
        """The whole preparation again, reusing the address the user already chose (revalidated on the new list)."""
        atual, opcoes = self._ate_enderecos(page, serial, aba, cep)
        if atual != modelo:
            raise ErroUX(409, "O modelo exibido no UX mudou.")
        if opcoes.count(endereco) != 1:
            raise ErroUX(409, "A lista de Meus Endereços mudou no UX. Prepare novamente e escolha o endereço.",
                         codigo="endereco_ambiguo")
        self._passo(page, "Endereço", lambda: _escolher(page, "novo-endereco", endereco))
        if formulario is not None:
            self._preencher_campos(page, formulario)
            self._conferir_tudo(page, serial, modelo, cep, formulario)

    def preparar(self, serial: str, aba: str, cep: str) -> tuple[str, list[str]]:
        """Return the model and every Meus Endereços option; the address itself is chosen by the service."""
        page = self._vigiar(self._contexto.new_page())
        page.bring_to_front()
        return self._com_contingencia(page, aba, lambda: self._ate_enderecos(page, serial, aba, cep))

    @staticmethod
    def _conferir_escolhas(page: Any, endereco: str | None = None) -> None:
        esperado = {"selectIncidente": INCIDENTE, "selectMotivo": MOTIVO}
        if endereco is not None:
            esperado["novo-endereco"] = endereco
        if any(_selecionado(page, campo) != valor for campo, valor in esperado.items()):
            raise ErroUX(409, "Incidente, motivo ou endereço mudaram no UX.")

    def escolher_endereco(self, serial: str, modelo: str, aba: str, endereco: str, cep: str) -> None:
        page = self._aba(aba)

        def primeira() -> None:
            self._passo(page, "Cabeçalho do equipamento", lambda: self._conferir_equipamento(page, serial, modelo))
            self._passo(page, "Incidente e motivo", lambda: self._conferir_escolhas(page))
            self._passo(page, "Endereço", lambda: _escolher(page, "novo-endereco", endereco))
            self._passo(page, "Cabeçalho do equipamento", lambda: self._conferir_equipamento(page, serial, modelo))

        self._com_contingencia(page, aba, lambda: self._fluxo(page, serial, aba, cep, modelo, endereco), primeira)

    @staticmethod
    def _anexar(page: Any, nome: str, conteudo: bytes) -> None:
        """Ready only when the portal lists the file name once. Never clicks "Anexar documento"."""
        if not conteudo or len(conteudo) > ANEXO_MAX:
            raise ErroUX(422, "A planilha gerada passa de 5 MB, o limite de anexo do UX.")
        listado = page.get_by_text(nome)
        if listado.count() > 1:
            raise ErroUX(409, "O anexo aparece mais de uma vez no UX.")
        if listado.count() == 1:
            return  # already attached by an earlier simulation of this session
        entrada = page.locator('input[type="file"]')
        if entrada.count() != 1:
            raise ErroUX(409, "O UX não mostrou um único campo de anexo.")
        entrada.set_input_files({"name": nome, "mimeType": MIME_XLSX, "buffer": conteudo}, timeout=CONTROLES_MS)
        for _ in range(20):
            if listado.count() == 1:
                return
            page.wait_for_timeout(250)
        raise ErroUX(409, "O UX não confirmou o anexo da planilha.")

    def _campo(self, page: Any, nome: str, seletor: str, valor: str, *, modo: str = "", digitado: str | None = None) -> None:
        self._passo(page, nome, lambda: _preencher(_unico(page.locator(seletor)), valor, nome=modo, digitado=digitado))

    def _preencher_campos(self, page: Any, formulario: Formulario) -> None:
        """CNPJs → Registro → anexo → solicitante → Nº interno; stops before Finalizar."""
        self._passo(page, "Aviso de backup", lambda: _fechar_aviso_backup(page))
        self._passo(page, "Incidente, motivo e endereço", lambda: self._conferir_escolhas(page, formulario.endereco))
        self._campo(page, "CNPJ de instalação", "input#atualizarCnpjInstalacao", formulario.cnpj_instalacao, modo=DIGITOS)
        self._campo(page, "CNPJ de faturamento", "input#atualizarCnpjFaturamento", formulario.cnpj_faturamento, modo=DIGITOS)
        self._campo(page, "Registro", DESCRICAO, formulario.descricao)
        self._passo(page, "Anexo", lambda: self._anexar(page, formulario.arquivo_nome, formulario.arquivo))
        self._campo(page, "Nome", "input#nome", formulario.nome)
        self._campo(page, "E-mail", "input#email", formulario.email)
        self._campo(page, "Telefone", "input#telefone", formulario.telefone, modo=DIGITOS,
                    digitado=re.sub(r"\D", "", formulario.telefone))
        self._campo(page, "Nº do chamado interno", "input#InputNumeroChamado", formulario.chamado_interno)

    def _conferir_tudo(self, page: Any, serial: str, modelo: str, cep: str, formulario: Formulario) -> None:
        """Final check: re-read every field on screen; any difference is a failure of this step."""
        self._etapa = "Conferência final"
        _na_rota(page, ROTA_ABRIR)
        self._conferir_equipamento(page, serial, modelo)
        self._conferir_escolhas(page, formulario.endereco)
        esperados = (
            ("input#cep-novo-endereco", cep, DIGITOS),
            ("input#atualizarCnpjInstalacao", formulario.cnpj_instalacao, DIGITOS),
            ("input#atualizarCnpjFaturamento", formulario.cnpj_faturamento, DIGITOS),
            (DESCRICAO, formulario.descricao, ""),
            ("input#nome", formulario.nome, ""),
            ("input#email", formulario.email, ""),
            ("input#telefone", formulario.telefone, DIGITOS),
            ("input#InputNumeroChamado", formulario.chamado_interno, ""),
        )
        for seletor, esperado, modo in esperados:
            atual = str(_unico(page.locator(seletor)).input_value(timeout=CONTROLES_MS)).replace("\r\n", "\n")
            if not _valor_confere(modo, atual, esperado):
                raise ErroUX(409, "A conferência final encontrou um campo diferente do esperado.")
        if page.get_by_text(formulario.arquivo_nome).count() != 1:
            raise ErroUX(409, "A conferência final não encontrou o anexo uma única vez.")
        _na_rota(page, ROTA_ABRIR)

    def preencher(self, serial: str, modelo: str, aba: str, cep: str, formulario: Formulario) -> None:
        """Fill the form and finish with the full re-read; any failure redoes everything from the consulta."""
        self._pronto = None
        if len(formulario.descricao) > DESCRICAO_MAX or len(formulario.chamado_interno) > CHAMADO_INTERNO_MAX:
            raise ErroUX(422, "O registro ou o Nº do chamado interno passa do limite do UX.")
        page = self._aba(aba)

        def primeira() -> None:
            self._passo(page, "Cabeçalho do equipamento", lambda: self._conferir_equipamento(page, serial, modelo))
            self._preencher_campos(page, formulario)
            self._conferir_tudo(page, serial, modelo, cep, formulario)

        self._com_contingencia(
            page, aba, lambda: self._fluxo(page, serial, aba, cep, modelo, formulario.endereco, formulario), primeira,
        )
        self._pronto = (serial, modelo, aba, cep, formulario)

    def enviar(self, aba: str, antes_do_clique: Callable[[], None]) -> str:
        """Final re-read (with the contingency), then click Finalizar once and wait once for the ticket number."""
        pronto, self._pronto = self._pronto, None
        if envio_desativado() or (pronto is not None and pronto[0] in SERIES_SEM_ENVIO_REAL):
            raise ErroUX(422, MSG_SEM_ENVIO)  # last barrier before the click
        if pronto is None or pronto[2] != aba:
            raise ErroUX(409, "A aba não está pronta para envio.")
        serial, modelo, _, cep, formulario = pronto
        page = self._aba(aba)
        self._com_contingencia(
            page, aba, lambda: self._fluxo(page, serial, aba, cep, modelo, formulario.endereco, formulario),
            lambda: self._conferir_tudo(page, serial, modelo, cep, formulario),
        )
        antes_do_clique()  # the service records "incerto" here, before the click
        # NUNCA repetir daqui em diante: depois do clique em Finalizar não há contingência, recarga nem volta à
        # consulta (risco de ticket duplicado). Timeout ou qualquer anomalia vira "incerto" com conferência manual.
        _unico(_botao(page, "Finalizar")).click(timeout=CONTROLES_MS)
        ignorar = {CONTRATO, formulario.chamado_interno.strip()}
        prazo = monotonic() + ESPERA_OS_S
        while monotonic() < prazo:
            dialogos = page.locator("[role=dialog], .modal, app-modal").filter(visible=True)
            textos = [str(dialogos.nth(i).inner_text(timeout=CONTROLES_MS)) for i in range(dialogos.count())]
            if _rota(page.url) != ROTA_ABRIR:
                textos.append(str(page.locator("body").inner_text(timeout=CONTROLES_MS)))
            numeros = {n for texto in textos for n in NUMERO_TICKET.findall(texto)} - ignorar
            if len(numeros) == 1:
                return numeros.pop()
            page.wait_for_timeout(250)
        raise TimeoutError("O UX não mostrou um número de ticket inequívoco.")


@contextmanager
def conectar_ux_ticket() -> Iterator[PortalTicketUXChrome]:
    with contexto_chrome_ux() as contexto:
        yield PortalTicketUXChrome(contexto)
