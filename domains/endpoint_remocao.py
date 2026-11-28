"""Remove o computador antigo no Endpoint Central (Comparação > Apelidos, botão "Remover mais antigo").

AUTORIZAÇÃO DE ESCRITA EM SISTEMA EXTERNO (Endpoint), dada pelo usuário em 27/11/2026: remover computador no
Endpoint Central a partir do botão "Remover mais antigo", com os passos abaixo.

1. ``goto`` em ``<ENDPOINT_URL sem #>#/uems/agent/som/computers?managedStatus=true``; login, senha e MFA são do usuário.
2. Filtro "Nome do computador" com o hostname; exige paginador ``1 - 1 de 1`` e uma única linha de nome igual
   (só maiúsculas e espaços normalizados). Senão para sem clicar: ``nao_encontrado`` ou ``ambiguo``.
3. ``check()`` no checkbox da linha; confere "selecionar todos" desmarcado e um único checkbox marcado.
4. "Remover computador(es)"; no diálogo "Esta ação resulta em": contagem de selecionados = 1 e "Remove MDM
   enrollment Profile" marcado com ``check()`` (nunca ``click()``). Motivo obrigatório: para antes do clique final.
5. "Sim, prosseguir" só com ``confirmado is True`` e ``SIMPRESS_ENDPOINT_SEM_REMOCAO`` diferente de ``1``; senão
   captura o diálogo (pasta temporária), clica "Cancelar" e devolve ``cancelado_sem_confirmacao`` ou
   ``recusado_por_configuracao``. O "Sim" é um único clique, nunca repetido; timeout ou erro depois dele é ``incerto``.
6. ``removido`` só depois de novo ``goto`` (via ``about:blank``; nunca ``reload``) e refiltro com 0 linhas; ainda aparece: ``incerto``.

Log só com etapa e resultado: nunca hostname, usuário, senha nem motivo.
"""
import logging
import os
import re
import tempfile
import unicodedata
from datetime import datetime
from importlib import import_module
from pathlib import Path
from typing import Any

from core.config import local_setting

logger = logging.getLogger(__name__)

# Os scripts legados ficam fora da tipagem gradual da aplicação (mesmo padrão de endpoint_lookup).
automation = import_module("scripts.automacao_rotinas_chrome")
grid = import_module("scripts.verificar_usuarios_endpoint")

VAR_SEM_REMOCAO = "SIMPRESS_ENDPOINT_SEM_REMOCAO"
ROTA_SOM = "#/uems/agent/som/computers?managedStatus=true"
ORIGEM = "Remover no Endpoint"
ESPERA_DIALOGO_FECHAR_MS = 60_000
MAX_HOSTNAME = 160

_LINHA = ".ember-table-table-row:not(.ember-table-header-row)"
_CHECK_TODOS = ".ember-table-header-row input[type=checkbox]"
_TEXTO_DIALOGO = re.compile(r"Esta a[çc][ãa]o resulta em", re.I)
_BOTAO_REMOVER = re.compile(r"Remover computador", re.I)
_CONTAGEM = re.compile(r"(\d+)\s+(?:selected\s+devices?|dispositivos?\s+selecionados?)", re.I)
_MDM = re.compile(r"Remove MDM enrollment Profile", re.I)
_MOTIVO_OBRIGATORIO = re.compile(r"(?:motivo|reason)[^\n*]{0,40}\*", re.I)
_CANCELAR = re.compile(r"^\s*Cancelar\s*$", re.I)
_SIM = re.compile(r"Sim,?\s*prosseguir", re.I)

MENSAGENS = {
    "removido": "Computador removido no Endpoint Central (a nova pesquisa não o encontrou mais).",
    "incerto": "Não deu para confirmar a remoção no Endpoint Central. Confira lá antes de tentar de novo; nada foi gravado no cockpit.",
    "nao_encontrado": "O computador não foi encontrado no Endpoint Central; nada foi removido.",
    "ambiguo": "A pesquisa no Endpoint Central não trouxe uma única linha com esse nome exato; nada foi removido.",
    "grade_inesperada": "A seleção na grade do Endpoint Central não ficou com uma única linha marcada; nada foi removido.",
    "dialogo_inesperado": "O diálogo de remoção do Endpoint Central não estava como esperado; cancelei sem remover.",
    "motivo_obrigatorio": "O Endpoint Central pediu um motivo obrigatório; cancelei sem remover.",
    "cancelado_sem_confirmacao": "Simulação: o diálogo foi conferido e cancelado sem remover (falta a confirmação).",
    "recusado_por_configuracao": f"A remoção real está desativada ({VAR_SEM_REMOCAO}); o diálogo foi cancelado sem remover.",
}


def remocao_liberada(confirmado: Any) -> bool:
    """Lido a cada chamada: a variável vale sem reiniciar o servidor."""
    return confirmado is True and os.environ.get(VAR_SEM_REMOCAO) != "1"


def url_som(automacao: Any) -> str:
    return str(automacao.ENDPOINT_URL).split("#")[0] + ROTA_SOM


def validar_hostname(hostname: str) -> str:
    texto = str(hostname or "").strip()
    if not texto or len(texto) > MAX_HOSTNAME or any(unicodedata.category(c).startswith("C") for c in texto):
        raise ValueError("Informe um hostname válido.")
    return texto


def _nome(texto: Any) -> str:
    return " ".join(str(texto or "").split()).upper()


def _resultado(automacao: Any, resultado: str, **extra: Any) -> dict[str, Any]:
    automacao.log(ORIGEM, f"Resultado: {resultado}.")
    return {"resultado": resultado, "mensagem": MENSAGENS[resultado], **extra}


def _filtrar(page: Any, automacao: Any, hostname: str) -> tuple[dict[str, Any], list[str]]:
    grade = grid.aplicar_filtro(page, automacao, grid.COLUNA_NOME, hostname, modo_todos=False)
    cabecalho = grid.achar_cabecalho(grade, grid.COLUNA_NOME)
    return grade, [grid.valor_da_coluna(linha, cabecalho) for linha in grade["linhas"]]


class _SemCancelamento:
    """Depois do clique final o pedido de cancelamento não interrompe a conferência (só o resultado ``incerto``)."""

    def __init__(self, base: Any) -> None:
        self._base = base

    def __getattr__(self, nome: str) -> Any:
        return getattr(self._base, nome)

    def verificar_cancelamento(self, detalhe: str = "") -> None:
        return None


def _abrir_lista(page: Any, automacao: Any) -> None:
    url = url_som(automacao)
    page.goto(url, wait_until="domcontentloaded", timeout=automacao.CARREGAMENTO_MS)

    def esperar_login() -> None:
        automacao.aguardar_login(
            page, "Endpoint Central", automacao.endpoint_logado,
            entrar=automacao.endpoint_entrar, email=local_setting("SIMPRESS_SOFTEXPERT_EMAIL", "softexpert_email"),
        )

    esperar_login()
    if "agent/som/computers" not in str(page.url):
        page.goto(url, wait_until="domcontentloaded", timeout=automacao.CARREGAMENTO_MS)
        if not automacao.endpoint_logado(page):
            esperar_login()
    automacao.definir_pagina_ativa_para_recuperacao(page)


def _cancelar_dialogo(dialogo: Any) -> None:
    try:
        dialogo.get_by_role("button", name=_CANCELAR).first.click(timeout=10000)
    except Exception as erro:
        logger.debug("Não foi possível clicar em Cancelar no diálogo do Endpoint (%s).", type(erro).__name__)


def _capturar(page: Any, pasta: Path | None) -> str:
    destino = Path(pasta or Path(tempfile.gettempdir()) / "simpress_endpoint_remocao")
    try:
        destino.mkdir(parents=True, exist_ok=True)
        arquivo = destino / f"dialogo-remocao-{datetime.now():%Y%m%d-%H%M%S-%f}.png"
        page.screenshot(path=str(arquivo))
        return str(arquivo)
    except Exception as erro:
        logger.debug("Não foi possível capturar o diálogo do Endpoint (%s).", type(erro).__name__)
        return ""


def _conferir_dialogo(dialogo: Any) -> tuple[str | None, Any]:
    """Devolve (motivo da parada, checkbox do MDM); nenhum clique final acontece aqui."""
    texto = dialogo.inner_text(timeout=10000)
    if _MOTIVO_OBRIGATORIO.search(texto) or dialogo.locator(
        "textarea[required], input[type=text][required], [aria-required=true]"
    ).filter(visible=True).count():
        return "motivo_obrigatorio", None
    contagem = _CONTAGEM.search(texto)
    if contagem is None or int(contagem.group(1)) != 1:
        return "dialogo_inesperado", None
    mdm = dialogo.get_by_label(_MDM)
    if mdm.count() != 1:
        return "dialogo_inesperado", None
    mdm.check(timeout=10000)  # idempotente: já marcado continua marcado
    if not mdm.is_checked():
        return "dialogo_inesperado", None
    return None, mdm


def _desmarcar(caixa: Any) -> None:
    try:
        caixa.uncheck(timeout=5000)
    except Exception as erro:
        logger.debug("Não foi possível desmarcar a linha do Endpoint (%s).", type(erro).__name__)


def remover_na_pagina(
    page: Any, automacao: Any, hostname: str, confirmado: bool = False, pasta_captura: Path | None = None,
) -> dict[str, Any]:
    """Executa os passos do docstring do módulo na aba ``page``; nunca fecha abas."""
    hostname = validar_hostname(hostname)
    automacao.log(ORIGEM, "Abrindo a lista de computadores gerenciados.")
    _abrir_lista(page, automacao)

    automacao.log(ORIGEM, "Filtrando pelo nome do computador.")
    grade, nomes = _filtrar(page, automacao, hostname)
    exatos = [nome for nome in nomes if _nome(nome) == _nome(hostname)]
    if not exatos:
        return _resultado(automacao, "nao_encontrado")
    if len(exatos) != 1 or len(nomes) != 1 or grade.get("total") != 1:
        return _resultado(automacao, "ambiguo")

    linha = page.locator(_LINHA).filter(visible=True)
    if linha.count() != 1 or _nome(linha.first.locator("a.anchor-text").first.inner_text(timeout=10000)) != _nome(hostname):
        return _resultado(automacao, "ambiguo")
    caixa = linha.first.locator("input[type=checkbox]").first
    caixa.check(timeout=10000)
    todos = page.locator(_CHECK_TODOS).filter(visible=True)
    marcados = page.locator(f"{_LINHA} input[type=checkbox]:checked").count()
    if todos.count() != 1 or todos.first.is_checked() or marcados != 1:
        _desmarcar(caixa)
        return _resultado(automacao, "grade_inesperada")

    automacao.log(ORIGEM, "Abrindo o diálogo de remoção.")
    botao = page.locator("button, a, [role=button]").filter(has_text=_BOTAO_REMOVER).filter(visible=True)
    if botao.count() != 1:
        _desmarcar(caixa)
        return _resultado(automacao, "grade_inesperada")
    botao.first.click(timeout=10000)  # só abre o diálogo; nada é removido aqui
    # O menor bloco que tem o texto do diálogo e o botão Cancelar (ancestrais vêm antes no DOM, então ``last``).
    dialogo = (
        page.locator("div").filter(has_text=_TEXTO_DIALOGO)
        .filter(has=page.get_by_role("button", name=_CANCELAR)).filter(visible=True).last
    )
    try:
        dialogo.wait_for(state="visible", timeout=20000)
    except Exception:
        _desmarcar(caixa)
        return _resultado(automacao, "dialogo_inesperado")

    try:
        parada, mdm = _conferir_dialogo(dialogo)
    except Exception:
        parada, mdm = "dialogo_inesperado", None
    if parada is not None or not remocao_liberada(confirmado):
        captura = _capturar(page, pasta_captura)
        _cancelar_dialogo(dialogo)
        if parada is None:
            parada = "cancelado_sem_confirmacao" if confirmado is not True else "recusado_por_configuracao"
        return _resultado(automacao, parada, captura=captura)
    return _confirmar_remocao(page, automacao, hostname, confirmado, dialogo, mdm)


def _confirmar_remocao(page: Any, automacao: Any, hostname: str, confirmado: bool, dialogo: Any, mdm: Any) -> dict[str, Any]:
    """Único caminho que conhece o botão "Sim"; só é chamado com a remoção liberada."""
    sim = dialogo.get_by_role("button", name=_SIM)

    def pronto() -> bool:
        try:
            return sim.count() == 1 and sim.is_enabled() and mdm.is_checked()
        except Exception:
            return False

    try:
        automacao.aguardar_estabilidade_pre_clique(pronto, "Confirmar a remoção no Endpoint")
    except BaseException:
        _cancelar_dialogo(dialogo)  # "pare"/"cancelar" ou diálogo instável: nada foi removido
        raise
    if not remocao_liberada(confirmado):  # a variável pode ter mudado durante a espera
        _cancelar_dialogo(dialogo)
        return _resultado(automacao, "recusado_por_configuracao")

    automacao.log(ORIGEM, "Confirmando a remoção (clique único).")
    seguro = _SemCancelamento(automacao)
    try:
        sim.click(timeout=10000)  # irreversível: um único clique, fora de qualquer etapa que refaça
        dialogo.wait_for(state="hidden", timeout=ESPERA_DIALOGO_FECHAR_MS)
        url = url_som(automacao)
        # Nunca reload. goto para a mesma URL com "#" só troca o fragmento e não relê a grade: passa por
        # about:blank para o mesmo endereço abrir como documento novo.
        page.goto("about:blank")
        page.goto(url, wait_until="domcontentloaded", timeout=automacao.CARREGAMENTO_MS)
        if not automacao.endpoint_logado(page):
            return _resultado(automacao, "incerto")
        grade, nomes = _filtrar(page, seguro, hostname)
        if "agent/som/computers" not in str(page.url):  # o portal levou a outra tela: a lista vazia não prova nada
            return _resultado(automacao, "incerto")
    except (Exception, automacao.RotinaCancelada) as erro:
        logger.debug("Conferência da remoção no Endpoint interrompida (%s).", type(erro).__name__)
        return _resultado(automacao, "incerto")
    if not nomes and grade.get("vazia"):
        return _resultado(automacao, "removido")
    return _resultado(automacao, "incerto")


def remover_computador(hostname: str, confirmado: bool = False, pasta_captura: Path | None = None) -> dict[str, Any]:
    """Abre uma aba nova no Chrome de automação e remove o computador ``hostname`` (ver docstring do módulo)."""
    hostname = validar_hostname(hostname)
    with automation.trava_execucao("remover_endpoint"):
        from playwright.sync_api import sync_playwright

        # Ignora cancelamento deixado por uma execução anterior, sem apagar o arquivo dela.
        setattr(automation, "_inicio_execucao", automation.time.time())
        with sync_playwright() as pw:
            automation.registrar_driver(pw)
            automation.garantir_chrome()
            browser = pw.chromium.connect_over_cdp(automation.CDP_URL, timeout=10000)
            if not browser.contexts:
                raise automation.RotinaErro("Chrome sem contexto de navegação.")
            page = browser.contexts[0].new_page()  # aba própria; fica aberta para o usuário conferir
            return remover_na_pagina(page, automation, hostname, confirmado, pasta_captura)
