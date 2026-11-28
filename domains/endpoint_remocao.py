"""Remove o computador antigo no Endpoint Central (Comparação > Apelidos, botão "Remover mais antigo").

AUTORIZAÇÃO DE ESCRITA EM SISTEMA EXTERNO (Endpoint), dada pelo usuário em 27/11/2026: remover computador no
Endpoint Central a partir do botão "Remover mais antigo", com os passos abaixo.

1. ``goto`` em ``<ENDPOINT_URL sem #>#/uems/agent/som/computers?managedStatus=true``; login, senha e MFA são do usuário.
2. Espera a lista carregar; filtro "Nome do computador" (caixa "Somente sequência") com o hostname; exige a faixa
   ``1 - 1`` no rodapé (o portal mostra ``1 - N de Total de registros``, sem o total; o link não é clicado) e uma
   única linha de nome igual (só maiúsculas e espaços normalizados). Senão para sem clicar: ``nao_encontrado`` ou
   ``ambiguo``.
3. Antes de marcar, o "Horário do último contato" da linha precisa ser anterior, por dia, ao ``corte`` (última
   verificação do hostname mais recente): o SoM não tem série e o nome pode ter sido reaproveitado. ``--``, data
   ilegível ou sem ``corte``: ``contato_recente``, sem clicar nada.
   ``check()`` no checkbox da linha; confere um "selecionar todos" visível e um único checkbox de linha marcado (o
   portal marca o "selecionar todos" sozinho quando a única linha da faixa ``1 - 1`` é marcada).
4. "Remover computador(es)"; no diálogo "Esta ação resulta em": contagem de selecionados = 1 e "Remove MDM
   enrollment Profile" marcado com um único clique no label (só se estiver desmarcado; o input é invisível).
   Motivo obrigatório: para antes do clique final.
   Toda saída antes do "Sim" captura, fecha o ``[role=alertdialog]`` só pelo Cancel/Cancelar e desmarca a linha.
5. "Sim, prosseguir" só com ``confirmado is True`` e ``SIMPRESS_ENDPOINT_SEM_REMOCAO`` diferente de ``1``; senão
   captura o diálogo (pasta temporária), clica "Cancel" e devolve ``cancelado_sem_confirmacao`` ou
   ``recusado_por_configuracao``. O "Sim" é um único clique, nunca repetido; timeout, erro ou "pare" depois dele é
   ``incerto``. A captura é só do diálogo (as 20 mais recentes ficam na pasta).
6. Depois do "Sim", espera na mesma página (até 15 s, sem clicar; sai assim que a linha some) o carregamento sumir e a linha sair; ``removido``
   só depois de novo ``goto`` (via ``about:blank``; nunca ``reload``) e refiltro com 0 linhas (refeito a cada 5 s por até
   15 s, no máximo 3 buscas); ainda aparece: ``incerto``.

``removido`` exige duas buscas seguidas com o aviso exato "Nenhum computador gerenciado.", faixa ``0 - 0``, nada
carregando e a caixa de filtro com o próprio hostname. Imediatamente antes do "Sim", ``antes_do_clique`` grava o
marcador durável "em_andamento" (sem ele, não clica); ``apos_trava`` relê as pendências já com a trava.

Log só com etapa e resultado: nunca hostname, usuário, senha nem motivo.
"""
import logging
import math
import os
import re
import tempfile
import time
import unicodedata
from datetime import datetime
from importlib import import_module
from pathlib import Path
from typing import Any, Callable

from core.config import local_setting
from domains.inventory_comparison import _parse_verification_datetime

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
_CANCELAR = re.compile(r"^\s*(?:Cancelar|Cancel)\s*$", re.I)  # o portal mostra "Cancel"
_ALERTA = "[role=alertdialog]"
ESPERA_FECHAR_ALERTA_MS = 10_000
ESPERA_CONTEUDO_DIALOGO_MS = 15_000
TEXTO_GRADE_VAZIA = "Nenhum computador gerenciado."
# Depois do "Sim": o portal demora para remover e atualiza a tela sozinho; a conferência refaz só o filtro.
ESPERA_REMOCAO_MS = 15_000
INTERVALO_PORTAL_MS = 1_000
ESPERA_CONFERENCIA_MS = 15_000
INTERVALO_CONFERENCIA_MS = 5_000
BUSCAS_CONFERENCIA = 3
_CARREGANDO = ", ".join(
    f"[class*={nome}]:visible" for nome in ("loader", "loading", "spinner", "mask")
)
CAPTURAS_MANTIDAS = 20
# Fração da viewport (largura E altura) a partir da qual a caixa é a moldura de tela cheia, não o painel.
LIMITE_CAPTURA = 0.8
COLUNA_CONTATO = "horario do ultimo contato"
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
    "marcador_nao_gravado": "Não consegui registrar a remoção em andamento no cockpit; cancelei sem remover.",
    "contato_recente": (
        "O computador falou com o Endpoint Central no dia da última verificação do hostname mais recente ou depois "
        "(ou a data não pôde ser lida): o nome pode ter sido reaproveitado. Confira no Endpoint; nada foi removido."
    ),
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


_FAIXA = re.compile(r"(?:^|\s)(\d+)\s*[-–]\s*(\d+)\s+de\b", re.I)


def _faixa(page: Any) -> tuple[int, int] | None:
    """Início e fim da faixa do rodapé (``1 - 500 de Total de registros``); o total não aparece na tela."""
    achado = _FAIXA.search(str(page.evaluate("document.body ? document.body.innerText : ''") or ""))
    return (int(achado.group(1)), int(achado.group(2))) if achado else None


def _aguardar_lista(page: Any, automacao: Any) -> None:
    """Espera a grade sair do carregamento, com a coluna do nome, linhas ou rodapé e a lupa (ou caixas) utilizável."""
    lupa = page.locator("button[id$='_searchButton']").filter(visible=True)
    caixas = page.locator("input.search-text-box").filter(visible=True)

    def pronta() -> bool:
        try:
            grade = grid.ler_grade(page)
            return (
                not grade["carregando"] and grid.achar_cabecalho(grade, grid.COLUNA_NOME) is not None
                and (bool(grade["linhas"]) or bool(grade["vazia"]) or _faixa(page) is not None)
                and (caixas.count() > 0 or (lupa.count() > 0 and lupa.first.is_enabled()))
            )
        except Exception:
            return False

    automacao.acionar_quando_pronto(lambda: None, "A lista de computadores do Endpoint não carregou", confirmar=pronta)


def _filtrar(page: Any, automacao: Any, hostname: str) -> tuple[dict[str, Any], list[str]]:
    _aguardar_lista(page, automacao)
    grade = grid.aplicar_filtro(page, automacao, grid.COLUNA_NOME, hostname, modo_todos=False)
    cabecalho = grid.achar_cabecalho(grade, grid.COLUNA_NOME)
    return grade, [grid.valor_da_coluna(linha, cabecalho) for linha in grade["linhas"]]


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


def _fechar_alertas(page: Any) -> bool:
    """Fecha todo ``[role=alertdialog]`` visível só pelo botão de nome exato Cancel/Cancelar; nunca toca no "Sim"."""
    alertas = page.locator(_ALERTA).filter(visible=True)
    try:
        for _ in range(3):
            antes = alertas.count()
            if not antes:
                return True
            alertas.first.get_by_role("button", name=_CANCELAR).first.click(timeout=10000)
            fim = time.monotonic() + ESPERA_FECHAR_ALERTA_MS / 1000
            while alertas.count() >= antes and time.monotonic() < fim:
                page.wait_for_timeout(200)
        return not alertas.count()
    except Exception as erro:
        logger.debug("Não foi possível fechar o diálogo do Endpoint pelo Cancel (%s).", type(erro).__name__)
        return False


def _sair_sem_remover(page: Any, automacao: Any, caixa: Any, pasta: Path | None, resultado: str) -> dict[str, Any]:
    """Saída antes do "Sim": captura, fecha o diálogo pelo Cancel, espera sumir e desmarca a linha."""
    captura = _capturar(page, pasta)
    fechado = _fechar_alertas(page)
    _desmarcar(caixa)
    saida = _resultado(automacao, resultado, captura=captura)
    if not fechado:
        saida["dialogo_aberto"] = True
        saida["mensagem"] += " O diálogo ficou aberto no Endpoint Central: clique em Cancel."
    return saida


_JS_PAINEL = """
(alerta, limite) => {
  const titulo = [...alerta.querySelectorAll('*')]
    .find(el => el.children.length === 0 && /Esta a[çc][ãa]o resulta em/i.test(el.textContent || ''));
  const botoes = [...alerta.querySelectorAll('button')].filter(b => /^\\s*(Cancel|Cancelar)\\s*$/i.test(b.textContent || ''));
  if (!titulo || botoes.length !== 1) return null;
  // Menor bloco com o título e o Cancel: o painel visível, sem a moldura que cobre a página.
  let painel = titulo.parentElement;
  while (painel && painel !== alerta && !painel.contains(botoes[0])) painel = painel.parentElement;
  const r = (painel || alerta).getBoundingClientRect();
  const x = Math.max(0, r.left), y = Math.max(0, r.top);
  const largura = Math.min(window.innerWidth, r.right) - x, altura = Math.min(window.innerHeight, r.bottom) - y;
  if (largura <= 0 || altura <= 0) return null;
  // Moldura de tela cheia (cobre a grade com nome e usuário): não captura.
  if (largura >= limite * window.innerWidth && altura >= limite * window.innerHeight) return null;
  return {x, y, width: largura, height: altura};
}
"""


def _caixa_estavel(page: Any, alerta: Any) -> dict[str, float] | None:
    """Caixa do painel igual em 2 leituras seguidas (fim da animação); sem estabilizar, None (sem captura)."""
    anterior = None
    for _ in range(15):
        atual = alerta.evaluate(_JS_PAINEL, LIMITE_CAPTURA)
        if atual is not None and atual == anterior:
            return dict(atual)
        anterior = atual
        page.wait_for_timeout(200)
    return None


def _zoom(page: Any) -> float | None:
    """Zoom do viewport visual (Page.getLayoutMetrics); None se não der para ler (sem captura)."""
    try:
        cdp = page.context.new_cdp_session(page)
        try:
            zoom = float(cdp.send("Page.getLayoutMetrics")["cssVisualViewport"]["zoom"])
        finally:
            cdp.detach()
    except Exception as erro:
        logger.debug("Não foi possível ler o zoom da aba do Endpoint (%s).", type(erro).__name__)
        return None
    return zoom if math.isfinite(zoom) and zoom > 0 else None


def _capturar(page: Any, pasta: Path | None) -> str:
    """Só o painel do diálogo (a página tem colunas com nome e usuário fora da tela); guarda as últimas capturas."""
    destino = Path(pasta or Path(tempfile.gettempdir()) / "simpress_endpoint_remocao")
    try:
        alertas = page.locator(_ALERTA).filter(visible=True)
        if alertas.count() != 1:
            return ""
        caixa = _caixa_estavel(page, alertas.first)
        if caixa is None:
            return ""
        # O Chrome de automação desenha 1920 px CSS numa janela de 1280 (zoom 0,667): o clip vai em pixels de tela.
        zoom = _zoom(page)
        if zoom is None:  # sem o zoom, um clip em pixels CSS pegaria outra parte da tela (LGPD): não captura
            return ""
        destino.mkdir(parents=True, exist_ok=True)
        arquivo = destino / f"dialogo-remocao-{datetime.now():%Y%m%d-%H%M%S-%f}.png"
        page.screenshot(path=str(arquivo), clip={chave: valor * zoom for chave, valor in caixa.items()}, timeout=10000)
        antigas = sorted(destino.glob("dialogo-remocao-*.png"), key=lambda item: item.stat().st_mtime, reverse=True)
        for velha in antigas[CAPTURAS_MANTIDAS:]:
            velha.unlink(missing_ok=True)
        return str(arquivo)
    except Exception as erro:
        logger.debug("Não foi possível capturar o diálogo do Endpoint (%s).", type(erro).__name__)
        return ""


def _conferir_dialogo(dialogo: Any, automacao: Any) -> tuple[str | None, Any]:
    """Devolve (motivo da parada, checkbox do MDM); nenhum clique final acontece aqui.

    O portal mostra a moldura do diálogo antes do conteúdo (texto, MDM, motivo e botões chegam ~1 s depois).
    """
    def parar(conferencia: str) -> tuple[str | None, Any]:
        automacao.log(ORIGEM, f"Diálogo não reconhecido: {conferencia}.")  # só o nome da conferência, nunca texto do portal
        return "dialogo_inesperado", None

    cancelar = dialogo.get_by_role("button", name=_CANCELAR)

    def conteudo_pronto() -> bool:
        try:
            return cancelar.count() == 1 and cancelar.first.is_visible() and bool(
                _CONTAGEM.search(dialogo.inner_text(timeout=2000))
            )
        except Exception:
            return False

    try:
        automacao.acionar_quando_pronto(
            lambda: None, "O conteúdo do diálogo de remoção não apareceu",
            timeout_ms=ESPERA_CONTEUDO_DIALOGO_MS, confirmar=conteudo_pronto, intervalo_s=0.3,
        )
    except automacao.RotinaErro:
        return parar("conteudo")
    texto = dialogo.inner_text(timeout=10000)
    if _MOTIVO_OBRIGATORIO.search(texto) or dialogo.locator(
        "textarea[required], input[type=text][required], [aria-required=true]"
    ).filter(visible=True).count():
        return "motivo_obrigatorio", None
    contagem = _CONTAGEM.search(texto)
    if contagem is None or int(contagem.group(1)) != 1:
        return parar("contagem")
    # Checkbox estilizado: o input tem 0x0 e opacidade 0; quem recebe o clique é o label que o contém.
    rotulo = dialogo.locator("label").filter(has_text=_MDM)
    mdm = rotulo.locator("input[type=checkbox]")
    if rotulo.count() != 1 or mdm.count() != 1:
        return parar("mdm_nao_encontrado")
    if not mdm.is_checked():
        rotulo.click(timeout=10000)  # um único clique: o label alterna, então nunca clica se já estiver marcado
        fim = time.monotonic() + 3
        while not mdm.is_checked() and time.monotonic() < fim:
            dialogo.page.wait_for_timeout(200)
    if not mdm.is_checked():
        return parar("mdm_nao_marcou")
    return None, mdm


def _desmarcar(caixa: Any) -> None:
    try:
        caixa.uncheck(timeout=5000)
    except Exception as erro:
        logger.debug("Não foi possível desmarcar a linha do Endpoint (%s).", type(erro).__name__)


def contato_anterior_ao_corte(contato: Any, corte: Any) -> bool:
    """Último contato estritamente anterior, por dia, à última verificação do hostname mais recente.

    O SoM não tem coluna de série: um nome reaproveitado por outro computador teria contato recente. Data vazia
    (``--``), ilegível ou sem corte: False (não remove).
    """
    momento = _parse_verification_datetime(str(contato or "").strip(), None)
    limite = _parse_verification_datetime(corte, None) if corte else None
    return momento is not None and limite is not None and momento.date() < limite.date()


def remover_na_pagina(
    page: Any, automacao: Any, hostname: str, confirmado: bool = False, pasta_captura: Path | None = None,
    *, corte: str | None = None, antes_do_clique: Callable[[], None] | None = None,
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
    if len(exatos) != 1 or len(nomes) != 1 or _faixa(page) != (1, 1):
        return _resultado(automacao, "ambiguo")

    linha = page.locator(_LINHA).filter(visible=True)
    if linha.count() != 1 or _nome(linha.first.locator("a.anchor-text").first.inner_text(timeout=10000)) != _nome(hostname):
        return _resultado(automacao, "ambiguo")
    if not contato_anterior_ao_corte(
        grid.valor_da_coluna(grade["linhas"][0], grid.achar_cabecalho(grade, COLUNA_CONTATO)), corte
    ):
        return _resultado(automacao, "contato_recente")
    caixa = linha.first.locator("input[type=checkbox]").first
    try:
        caixa.check(timeout=10000)
        todos = page.locator(_CHECK_TODOS).filter(visible=True)
        marcados = page.locator(f"{_LINHA} input[type=checkbox]:checked").count()
        botao = page.locator("button, a, [role=button]").filter(has_text=_BOTAO_REMOVER).filter(visible=True)
        # Com a faixa 1 - 1 já exigida, o "selecionar todos" marcado sozinho é esperado; a trava real é a contagem 1 do diálogo.
        selecao_ok = todos.count() == 1 and marcados == 1 and botao.count() == 1
    except BaseException:
        _desmarcar(caixa)
        raise
    if not selecao_ok:
        _desmarcar(caixa)
        return _resultado(automacao, "grade_inesperada")
    automacao.log(ORIGEM, "Abrindo o diálogo de remoção.")
    # Daqui até o "Sim", toda saída fecha o diálogo pelo Cancel e desmarca a linha (nunca o deixa aberto).
    alertas = page.locator(_ALERTA).filter(has_text=_TEXTO_DIALOGO).filter(visible=True)
    mdm: Any = None
    parada: str | None = None
    try:
        botao.first.click(timeout=10000)  # só abre o diálogo; nada é removido aqui
        try:
            alertas.first.wait_for(state="visible", timeout=20000)
            if alertas.count() != 1:
                automacao.log(ORIGEM, "Diálogo não reconhecido: dialogo_ausente.")
                parada = "dialogo_inesperado"
            else:
                parada, mdm = _conferir_dialogo(alertas.first, automacao)
        except Exception as erro:
            automacao.log(ORIGEM, f"Diálogo não reconhecido: erro {type(erro).__name__}.")
            parada = "dialogo_inesperado"
    except BaseException:
        _fechar_alertas(page)
        _desmarcar(caixa)
        raise
    if parada is not None or not remocao_liberada(confirmado):
        if parada is None:
            parada = "cancelado_sem_confirmacao" if confirmado is not True else "recusado_por_configuracao"
        return _sair_sem_remover(page, automacao, caixa, pasta_captura, parada)
    return _confirmar_remocao(
        page, automacao, hostname, confirmado, alertas.first, mdm, caixa, pasta_captura, antes_do_clique
    )


def _confirmar_remocao(
    page: Any, automacao: Any, hostname: str, confirmado: bool, dialogo: Any, mdm: Any, caixa: Any, pasta: Path | None,
    antes_do_clique: Callable[[], None] | None = None,
) -> dict[str, Any]:
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
        _fechar_alertas(page)  # "pare"/"cancelar" ou diálogo instável: nada foi removido
        _desmarcar(caixa)
        raise
    if not remocao_liberada(confirmado):  # a variável pode ter mudado durante a espera
        return _sair_sem_remover(page, automacao, caixa, pasta, "recusado_por_configuracao")

    automacao.log(ORIGEM, "Confirmando a remoção (clique único).")
    if antes_do_clique is not None:
        try:
            antes_do_clique()  # marcador durável "em_andamento": sem ele, nunca clica
        except Exception as erro:
            logger.debug("Marcador da remoção no Endpoint não gravado (%s).", type(erro).__name__)
            return _sair_sem_remover(page, automacao, caixa, pasta, "marcador_nao_gravado")
    inicio = time.monotonic()
    try:
        # Reconfere depois do marcador; se mudou, sai sem clicar (o domínio limpa o marcador: resultado sem clique).
        if not pronto():
            automacao.log(ORIGEM, "Diálogo não reconhecido: mudou_depois_do_marcador.")
            return _sair_sem_remover(page, automacao, caixa, pasta, "dialogo_inesperado")
        sim.click(timeout=10000)  # irreversível: um único clique, fora de qualquer etapa que refaça
        dialogo.wait_for(state="hidden", timeout=ESPERA_DIALOGO_FECHAR_MS)
        automacao.log(ORIGEM, f"Diálogo fechou em {time.monotonic() - inicio:.0f} s.")
        # O portal demora para remover e atualiza a grade sozinho: sair agora poderia abortar a remoção.
        atualizou = _aguardar_portal(page, automacao, hostname)
        automacao.log(ORIGEM, f"Grade {'atualizada' if atualizou else 'sem atualização'} em {time.monotonic() - inicio:.0f} s.")
        url = url_som(automacao)
        # Nunca reload. goto para a mesma URL com "#" só troca o fragmento e não relê a grade: passa por
        # about:blank para o mesmo endereço abrir como documento novo.
        page.goto("about:blank")
        page.goto(url, wait_until="domcontentloaded", timeout=automacao.CARREGAMENTO_MS)
        if not automacao.endpoint_logado(page):
            return _resultado(automacao, "incerto")
        # Só o filtro é refeito (caixa e lupa da grade); o diálogo e o botão de remover nunca são tocados de novo.
        fim = time.monotonic() + ESPERA_CONFERENCIA_MS / 1000
        vazias_seguidas = 0
        for busca in range(1, BUSCAS_CONFERENCIA + 1):
            grade, nomes = _filtrar(page, automacao, hostname)  # "pare" aqui cai no except: incerto
            url_atual = str(page.url)
            if "agent/som/computers" not in url_atual or "managedStatus=true" not in url_atual:  # outra tela: vazio não prova nada
                return _resultado(automacao, "incerto")
            vazias_seguidas = vazias_seguidas + 1 if _vazia_confirmada(page, grade, nomes, hostname) else 0
            if vazias_seguidas >= 2:
                automacao.log(ORIGEM, f"Remoção confirmada em {time.monotonic() - inicio:.0f} s.")
                return _resultado(automacao, "removido")
            if busca == BUSCAS_CONFERENCIA or time.monotonic() >= fim:
                break
            page.wait_for_timeout(INTERVALO_CONFERENCIA_MS)
        automacao.log(ORIGEM, f"Remoção não confirmada em {time.monotonic() - inicio:.0f} s.")
        return _resultado(automacao, "incerto")
    except (Exception, automacao.RotinaCancelada) as erro:
        logger.debug("Conferência da remoção no Endpoint interrompida (%s).", type(erro).__name__)
        return _resultado(automacao, "incerto")


def _vazia_confirmada(page: Any, grade: dict[str, Any], nomes: list[str], hostname: str) -> bool:
    """Grade vazia que prova a remoção: aviso exato, faixa 0 - 0, nada carregando e o filtro com o próprio hostname."""
    try:
        cabecalho = grid.achar_cabecalho(grade, grid.COLUNA_NOME)
        return (
            not nomes and bool(grade.get("vazia"))
            and page.get_by_text(TEXTO_GRADE_VAZIA, exact=True).filter(visible=True).count() > 0
            and _faixa(page) == (0, 0)
            and page.locator(_CARREGANDO).count() == 0
            and cabecalho is not None and grid._valor_do_campo(page, cabecalho) == hostname
        )
    except Exception as erro:
        logger.debug("Conferência da grade vazia do Endpoint falhou (%s).", type(erro).__name__)
        return False


def _aguardar_portal(page: Any, automacao: Any, hostname: str) -> bool:
    """Na mesma página, sem clicar: espera o carregamento sumir e a linha sair (ou a grade mudar). False no prazo."""
    carregando = page.locator(_CARREGANDO)

    def retrato() -> tuple[tuple[str, ...], tuple[int, int] | None]:
        grade = grid.ler_grade(page)
        cabecalho = grid.achar_cabecalho(grade, grid.COLUNA_NOME)
        return tuple(_nome(grid.valor_da_coluna(linha, cabecalho)) for linha in grade["linhas"]), _faixa(page)

    antes = None
    fim = time.monotonic() + ESPERA_REMOCAO_MS / 1000
    while time.monotonic() < fim:
        page.wait_for_timeout(INTERVALO_PORTAL_MS)
        automacao.verificar_cancelamento()  # "pare" durante a espera: incerto (o clique já aconteceu)
        try:
            if antes is None:
                antes = retrato()  # a primeira leitura também pode falhar: fica no mesmo laço
                continue
            if carregando.count():
                continue
            agora = retrato()
        except Exception as erro:
            logger.debug("Leitura da grade do Endpoint falhou durante a espera (%s).", type(erro).__name__)
            continue
        if _nome(hostname) not in agora[0] or agora != antes:
            return True
    return False


def remover_computador(
    hostname: str, confirmado: bool = False, pasta_captura: Path | None = None, *, corte: str | None = None,
    antes_do_clique: Callable[[], None] | None = None, apos_trava: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Abre uma aba nova no Chrome de automação e remove o computador ``hostname`` (ver docstring do módulo)."""
    hostname = validar_hostname(hostname)
    with automation.trava_execucao("remover_endpoint"):
        if apos_trava is not None:
            apos_trava()  # relê as pendências já com a trava: outro pedido pode ter deixado uma
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
            return remover_na_pagina(
                page, automation, hostname, confirmado, pasta_captura, corte=corte, antes_do_clique=antes_do_clique
            )
