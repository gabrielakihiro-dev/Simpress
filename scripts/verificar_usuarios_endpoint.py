"""Rotina "Verificar usuários": confere no Endpoint Central as pendências de usuário logado.

Para cada pendência ainda sem decisão (``GET /api/usuarios/pendencias``), pesquisa o computador na
grade "Todos os computadores" do Endpoint (série, série sem o ``S`` de MacBook e hostname) e lê o
usuário. Quando "Usuários logados" está vazio, abre o detalhe do computador e lê o "Usuário do último logon"
de Sistema > Usuários, que é a base; a tabela de Sistema > Usuários só entra quando o último logon não serve.
A decisão sai por ``POST /api/usuarios/pendencias/{id}/decidir`` e a anotação da linha de "Mudanças de
usuário logado" por ``PUT /api/historico-comparacoes/{evento}/anotacoes/{anotacao_id}``.

Regras:
- Só navegação pelo navegador no Endpoint Central; o login é sempre do usuário.
- Leitura não confirmada nunca decide: filtro que a grade não confirma, detalhe ou aba que não abre
  e tabela que não carrega levantam ``RotinaErro`` e nada é decidido.
- O módulo recebe o módulo de automação em execução (``automacao``) para compartilhar o controle de
  cancelamento; não importe ``scripts.automacao_rotinas_chrome`` aqui.
"""

from __future__ import annotations

import json
import os
import re
import time
import unicodedata
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from types import ModuleType
from typing import TYPE_CHECKING, Any, Callable

if TYPE_CHECKING:
    from playwright.sync_api import BrowserContext, Locator, Page

ORIGEM = "Verificar usuários"
USUARIOS_INVALIDOS = frozenset({
    "", "na", "n/a", "--", "-", "administrador", "convidado", "defaultaccount", "wdagutilityaccount", "root",
})
# Contas técnicas que nunca são o usuário da máquina, mesmo quando aparecem em Sistema > Usuários.
USUARIOS_IGNORADOS = frozenset({"uiflowservice"})
PREFIXOS_USUARIO_IGNORADO = ("codexsandbox", "default")
# Cabeçalhos aceitos para a coluna do nome na tabela de Sistema > Usuários, em ordem de preferência.
CABECALHOS_USUARIO_SISTEMA = ("nome do usuario", "nome de usuario", "usuario", "nome")
COLUNA_SERIE = "numero de serie"
COLUNA_NOME = "nome do computador"
COLUNA_USUARIOS = "usuarios logados"
HREF_DETALHE = re.compile(r"^#/uems/inventory/computers/[A-Za-z0-9_-]+$")
URL_DETALHE = re.compile(r"#/uems/inventory/computers/[A-Za-z0-9_-]+(/|$)")
LIMITE_ANOTACAO = 2000
CONFIRMACAO_FILTRO_S = 25
ATRASO_DIGITACAO_MS = 40

JS_LER_GRADE = """
() => {
  const visivel = el => el.getClientRects().length > 0;
  const texto = el => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  const caixa = el => { const r = el.getBoundingClientRect(); return {x0: r.left, x1: r.right}; };
  const cabecalhos = [...document.querySelectorAll('.ember-table-header-cell')]
    .filter(visivel).map(el => ({texto: texto(el), ...caixa(el)}));
  const linhas = [...document.querySelectorAll('.ember-table-table-row')]
    .filter(row => !row.classList.contains('ember-table-header-row') && visivel(row))
    .map(row => [...row.querySelectorAll('.ember-table-cell')].map(celula => {
      const link = celula.querySelector('a.anchor-text');
      return {texto: texto(celula), ...caixa(celula), href: link ? (link.getAttribute('href') || '') : ''};
    }));
  const corpo = document.body ? document.body.innerText : '';
  return {
    cabecalhos, linhas,
    carregando: [...document.querySelectorAll('.page-loader-wrapper, .spinner')].some(visivel),
    vazia: /Nenhum dado dispon[ií]vel/i.test(corpo) || /(^|\\s)0\\s*-\\s*0\\s*de(\\s|$)/.test(corpo),
  };
}
"""

JS_LER_USUARIOS_SISTEMA = """
(prioridade) => {
  const visivel = el => el.getClientRects().length > 0;
  const texto = el => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  const norm = s => s.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().trim();
  const cabecalhos = [...document.querySelectorAll('.ember-table-header-cell, th')].filter(visivel);
  const carregando = [...document.querySelectorAll('.page-loader-wrapper, .spinner')].some(visivel);
  const corpo = document.body ? document.body.innerText : '';
  const ultimo = ((corpo.match(/Usu.rio do .ltimo logon\\s*:\\s*([^\\n\\r]+)/i) || [])[1] || '').trim();
  for (const alvo of prioridade) {
    const cab = cabecalhos.find(el => norm(texto(el)) === alvo);
    if (!cab) continue;
    const recipiente = cab.closest('.ember-table, table') || document.body;
    const caixa = cab.getBoundingClientRect();
    let nomes;
    if (cab.tagName === 'TH') {
      const indice = [...cab.parentElement.children].indexOf(cab);
      nomes = [...recipiente.querySelectorAll('tbody tr')].filter(visivel)
        .map(tr => tr.children[indice] ? texto(tr.children[indice]) : '');
    } else {
      nomes = [...recipiente.querySelectorAll('.ember-table-table-row')]
        .filter(row => !row.classList.contains('ember-table-header-row') && visivel(row))
        .map(row => {
          const celula = [...row.querySelectorAll('.ember-table-cell')].find(c => {
            const r = c.getBoundingClientRect();
            const centro = (r.left + r.right) / 2;
            return centro >= caixa.left && centro <= caixa.right;
          });
          return celula ? texto(celula) : '';
        });
    }
    return {cabecalho: alvo, nomes, ultimo, carregando, vazia: /Nenhum dado dispon[ií]vel|No data/i.test(texto(recipiente))};
  }
  return {cabecalho: '', nomes: [], ultimo, carregando, vazia: false};
}
"""


@dataclass(frozen=True)
class Decisao:
    """Resultado de ``avaliar_decisao``: ``decisao`` None deixa a pendência aberta (só anota)."""

    decisao: str | None
    anotacao: str
    aviso: str = ""


def normalizar(texto: Any) -> str:
    sem_acento = unicodedata.normalize("NFD", str(texto or ""))
    sem_acento = "".join(c for c in sem_acento if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", sem_acento).strip().casefold()


def normalizar_usuario(texto: Any) -> str:
    """Compara usuários ignorando domínio (``DOM\\ana`` e ``ana@dom``), caixa e acentos."""
    valor = normalizar(texto)
    if "\\" in valor:
        valor = valor.rsplit("\\", 1)[1]
    return valor.split("@", 1)[0].strip()


def usuario_ignorado(nome: Any) -> bool:
    """Contas do Codex, ``Default*`` e UI Flow Service: não contam como usuário da máquina."""
    chave = re.sub(r"\s+", "", normalizar_usuario(nome))
    return chave in USUARIOS_IGNORADOS or chave.startswith(PREFIXOS_USUARIO_IGNORADO)


def usuario_valido(nome: Any) -> bool:
    return (
        normalizar_usuario(nome) not in USUARIOS_INVALIDOS
        and normalizar(nome) not in USUARIOS_INVALIDOS
        and not usuario_ignorado(nome)
    )


def escolher_usuario_lista(texto: Any) -> str:
    """Primeiro nome válido de "Usuários logados" (vários nomes separados por vírgula)."""
    for nome in re.split(r"[,;]", str(texto or "")):
        if usuario_valido(nome):
            return nome.strip()
    return ""


def escolher_usuario_sistema(nomes: list[str], ultimo_logon: str = "") -> str:
    """Base do Sistema: o usuário do último logon; sem um válido, a primeira linha válida de Sistema > Usuários."""
    if usuario_valido(ultimo_logon):
        return str(ultimo_logon).strip()
    for nome in nomes:
        if usuario_valido(nome):
            return str(nome).strip()
    return ""


def serie_sem_s(serie: str) -> str:
    """Série de MacBook no Endpoint: a de EquipamentosDetalhes sem o ``S`` inicial."""
    serie = str(serie or "").strip()
    return serie[1:] if len(serie) > 1 and serie[0].upper() == "S" else ""


def avaliar_decisao(
    pendencia: dict, achou: bool, usuario: str, fonte: str = "Usuários logados", sistema_consultado: bool = True,
) -> Decisao:
    """Tabela de decisão: o que fazer com a pendência dado o que o Endpoint mostrou."""
    ausente = pendencia.get("tipo") == "usuario_ausente"
    quando_sem_usuario = "remover" if ausente else "recusar"
    esperado = pendencia.get("usuario_atual") if ausente else pendencia.get("usuario_endpoint")
    if not achou:
        return Decisao(
            quando_sem_usuario, "Computador não encontrado no Endpoint (série e hostname).",
            "Computador não encontrado no Endpoint (série e hostname)",
        )
    if not usuario:
        if not sistema_consultado:
            return Decisao(None, "Sistema > Usuários não consultado.")
        return Decisao(
            quando_sem_usuario, "Sem usuário válido em Sistema > Usuários.",
            "Sem usuário válido em Sistema > Usuários",
        )
    if normalizar_usuario(usuario) == normalizar_usuario(esperado):
        return Decisao("manter" if ausente else "permitir", f"{fonte} confirma o usuário {usuario}.")
    return Decisao(None, f"{fonte} informa outro usuário ({usuario}); a pendência continua aberta para decisão manual.")


# --------------------------------------------------------------------------
# API do Simpress (servidor local)
# --------------------------------------------------------------------------

def url_servidor() -> str:
    return f"http://127.0.0.1:{int(os.environ.get('SIMPRESS_PORT', '8000'))}"


def chamar_api(automacao: ModuleType, metodo: str, caminho: str, corpo: dict | None = None) -> Any:
    pedido = urllib.request.Request(
        url_servidor() + caminho, method=metodo,
        data=json.dumps(corpo).encode("utf-8") if corpo is not None else None,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(pedido, timeout=30) as resposta:
            return json.load(resposta)
    except urllib.error.HTTPError as erro:
        detalhe = ""
        try:
            detalhe = str(json.load(erro).get("detail") or "")
        except Exception:
            pass
        raise ErroApi(erro.code, detalhe) from erro
    except (urllib.error.URLError, OSError) as erro:
        raise automacao.RotinaErro(f"O servidor Simpress não respondeu em {url_servidor()}: {erro}") from erro


class ErroApi(Exception):
    def __init__(self, status: int, detalhe: str) -> None:
        super().__init__(f"HTTP {status}: {detalhe}" if detalhe else f"HTTP {status}")
        self.status = status


def listar_pendencias(automacao: ModuleType) -> list[dict]:
    dados = chamar_api(automacao, "GET", "/api/usuarios/pendencias")
    return [p for p in dados.get("pendencias", []) if p.get("estado") == "pendente"]


def localizar_linha_anotacao(automacao: ModuleType, pendencia_id: str) -> dict | None:
    """Linha de "Mudanças de usuário logado" da pendência: evento, ``anotacao_id`` e anotação atual.

    Percorre os históricos do mais recente ao mais antigo, sem limite, e fica com a primeira ocorrência.
    """
    eventos = chamar_api(automacao, "GET", "/api/historico-comparacoes").get("eventos", [])
    for evento in eventos:
        try:
            detalhe = chamar_api(automacao, "GET", f"/api/historico-comparacoes/{evento['id']}")
        except ErroApi:
            continue
        linhas = ((detalhe.get("evento") or {}).get("comparacao") or {}).get("mudancas_usuarios") or []
        for linha in linhas:
            if linha.get("pendencia_id") == pendencia_id and linha.get("anotacao_id"):
                return {"evento_id": evento["id"], "linha": linha}
    return None


def montar_anotacao(atual: str, nova: str) -> str:
    carimbo = f"[Verificação automática {datetime.now():%d/%m/%Y %H:%M}] {nova}"
    if carimbo in atual:
        return atual
    junto = f"{atual}\n{carimbo}".strip() if atual.strip() else carimbo
    return junto if len(junto) <= LIMITE_ANOTACAO else carimbo[:LIMITE_ANOTACAO]


def anotar(automacao: ModuleType, pendencia: dict, texto: str) -> bool:
    achado = localizar_linha_anotacao(automacao, pendencia["id"])
    if achado is None:
        automacao.log(ORIGEM, f"[AVISO] Linha de anotação não encontrada para {pendencia['serie']}; anotação não gravada.")
        return False
    linha = achado["linha"]
    corpo: dict[str, Any] = {"anotacao": montar_anotacao(str(linha.get("anotacao") or ""), texto)}
    if isinstance(linha.get("anotacao_revisoes"), list):
        corpo["base_revisoes"] = linha["anotacao_revisoes"]
    try:
        chamar_api(automacao, "PUT", f"/api/historico-comparacoes/{achado['evento_id']}/anotacoes/{linha['anotacao_id']}", corpo)
    except ErroApi as erro:
        automacao.log(ORIGEM, f"[AVISO] Anotação de {pendencia['serie']} não gravada ({erro}).")
        return False
    return True


def decidir(automacao: ModuleType, pendencia: dict, decisao: str) -> bool:
    try:
        chamar_api(automacao, "POST", f"/api/usuarios/pendencias/{pendencia['id']}/decidir", {"decisao": decisao})
    except ErroApi as erro:
        automacao.log(ORIGEM, f"[AVISO] O servidor não aplicou '{decisao}' em {pendencia['serie']} ({erro}).")
        return False
    return True


# --------------------------------------------------------------------------
# Grade "Todos os computadores" (ember-table)
# --------------------------------------------------------------------------

def ler_grade(page: "Page") -> dict:
    return page.evaluate(JS_LER_GRADE)


def achar_cabecalho(grade: dict, coluna: str) -> dict | None:
    return next((c for c in grade["cabecalhos"] if coluna in normalizar(c["texto"])), None)


def valor_da_coluna(linha: list[dict], cabecalho: dict | None) -> str:
    """Texto das células cujo centro cai sob o cabeçalho (a ordem das colunas muda entre as visões)."""
    if cabecalho is None:
        return ""
    return " ".join(
        c["texto"] for c in linha if cabecalho["x0"] <= (c["x0"] + c["x1"]) / 2 <= cabecalho["x1"] and c["texto"]
    ).strip()


def grade_pronta(page: "Page") -> bool:
    grade = ler_grade(page)
    return (
        not grade["carregando"]
        and all(achar_cabecalho(grade, c) for c in (COLUNA_NOME, COLUNA_SERIE, COLUNA_USUARIOS))
    )


def preparar_grade(page: "Page", automacao: ModuleType) -> None:
    automacao.acionar_quando_pronto(
        lambda: None, "A grade do Endpoint não carregou", confirmar=lambda: grade_pronta(page), intervalo_s=1.0,
    )


def restaurar_grade(page: "Page", automacao: ModuleType) -> None:
    """Volta à grade "Todos os computadores", sem filtros, pronta para a próxima pesquisa."""
    page.goto(automacao.ENDPOINT_URL, wait_until="domcontentloaded", timeout=automacao.CARREGAMENTO_MS)
    automacao.selecionar_todos_computadores(page)
    automacao.confirmar_modo_todos(page)
    preparar_grade(page, automacao)


def _caixas_de_filtro(page: "Page") -> "Locator":
    return page.locator("input.search-text-box").filter(visible=True)


def _localizar_campo(page: "Page", cabecalho: dict) -> "Locator | None":
    """Caixa de filtro sob o cabeçalho (a barra de pesquisa tem uma caixa por coluna, alinhada pela posição x)."""
    caixas = _caixas_de_filtro(page)
    for i in range(caixas.count()):
        caixa = caixas.nth(i).bounding_box()
        if caixa and cabecalho["x0"] <= caixa["x"] + caixa["width"] / 2 <= cabecalho["x1"]:
            return caixas.nth(i)
    return None


def _valor_do_campo(page: "Page", cabecalho: dict) -> str:
    campo = _localizar_campo(page, cabecalho)
    return campo.input_value() if campo else ""


def _abrir_campo_filtro(page: "Page", automacao: ModuleType, coluna: str) -> "Locator":
    """Abre a barra de pesquisa pela lupa da barra de ferramentas (única da tela) e devolve a caixa da coluna.

    O cabeçalho é lido só depois de a barra abrir: ao aparecer, ela pode deslocar as colunas, e uma posição
    lida antes levaria o valor para a caixa da coluna vizinha (por exemplo, número de série em Usuários logados)."""
    if not _caixas_de_filtro(page).count():
        page.locator("button[id$='_searchButton']").filter(visible=True).first.click()
        automacao.aguardar_estado(_caixas_de_filtro(page).first, "visible", 15000)
    cabecalho = achar_cabecalho(ler_grade(page), coluna)
    if cabecalho is None:
        raise automacao.RotinaErro(f"A coluna '{coluna}' não está visível na grade do Endpoint.")
    campo = _localizar_campo(page, cabecalho)
    if campo is None:
        # Coluna fora da área visível: rola até o cabeçalho e relê a posição dele (a grade deslocou).
        page.locator(".ember-table-header-cell").filter(has_text=cabecalho["texto"]).first.scroll_into_view_if_needed()
        page.wait_for_timeout(300)
        atual = achar_cabecalho(ler_grade(page), coluna)
        campo = _localizar_campo(page, atual) if atual else None
    if campo is None:
        raise automacao.RotinaErro(f"A caixa de filtro da coluna '{coluna}' não foi encontrada.")
    return campo


def _limpar_caixas_preenchidas(page: "Page") -> None:
    """Esvazia as caixas da barra de pesquisa que ficaram com texto após uma tentativa sem confirmação,
    para que o valor não continue filtrando outra coluna nas pesquisas seguintes."""
    caixas = _caixas_de_filtro(page)
    for i in range(caixas.count()):
        caixa = caixas.nth(i)
        if caixa.input_value():
            _digitar(caixa, "")


def _digitar(campo: "Locator", valor: str) -> None:
    # fill() troca o valor sem os eventos de teclado que o componente Ember usa para guardar o texto
    # do filtro; digitar tecla a tecla (depois de limpar com Ctrl+A/Backspace) é o que ele reconhece.
    campo.click()
    campo.press("Control+A")
    campo.press("Backspace")
    if valor:
        digitar = getattr(campo, "press_sequentially", None) or campo.type
        digitar(valor, delay=ATRASO_DIGITACAO_MS)
    campo.press("Enter")


def _aguardar_grade_estavel(page: "Page", automacao: ModuleType, aceitar: Callable[[dict], bool], limite_s: float) -> dict | None:
    """Espera ``aceitar(grade)`` ficar verdadeiro em duas leituras seguidas, com a tela fora do carregamento."""
    fim = time.time() + limite_s
    anterior = None
    while time.time() < fim:
        automacao.verificar_cancelamento()
        grade = ler_grade(page)
        if not grade["carregando"] and aceitar(grade):
            if anterior is not None:
                return grade
            anterior = grade
        else:
            anterior = None
        time.sleep(0.6)
    return None


def aplicar_filtro(page: "Page", automacao: ModuleType, coluna: str, valor: str) -> dict:
    """Filtra a coluna e só devolve a grade quando ela confirma: valor no campo e linhas que o contêm
    (ou grade vazia confirmada). Sem confirmação levanta ``RotinaErro``; nada é decidido."""
    alvo = normalizar(valor)
    for tentativa in (1, 2):
        campo = _abrir_campo_filtro(page, automacao, coluna)
        _digitar(campo, valor)

        def confirmada(g: dict) -> bool:
            # A grade rola na horizontal ao focar uma coluna fora da tela: posições relidas a cada leitura.
            cab = achar_cabecalho(g, coluna)
            if cab is None or _valor_do_campo(page, cab) != valor:
                return False
            if g["linhas"]:
                return all(alvo in normalizar(valor_da_coluna(linha, cab)) for linha in g["linhas"])
            return g["vazia"]

        confirmado = _aguardar_grade_estavel(page, automacao, confirmada, CONFIRMACAO_FILTRO_S)
        if confirmado is not None:
            return confirmado
        automacao.log(ORIGEM, f"[AVISO] Filtro '{coluna}' não confirmado (tentativa {tentativa}/2).")
        _limpar_caixas_preenchidas(page)
    raise automacao.RotinaErro(
        f"A grade do Endpoint não confirmou o filtro da coluna '{coluna}' em {2 * CONFIRMACAO_FILTRO_S} s."
    )


def limpar_filtro(page: "Page", automacao: ModuleType, coluna: str) -> None:
    """Remove o filtro da coluna; com um filtro antigo ativo, a próxima pesquisa cruzaria os dois."""
    campo = _abrir_campo_filtro(page, automacao, coluna)
    _digitar(campo, "")
    if _aguardar_grade_estavel(page, automacao, lambda g: bool(g["linhas"]) and (achar_cabecalho(g, coluna) is not None) and _valor_do_campo(page, achar_cabecalho(g, coluna)) == "", CONFIRMACAO_FILTRO_S) is None:
        raise automacao.RotinaErro(f"A grade do Endpoint não confirmou a limpeza do filtro '{coluna}'.")


def pesquisar_computador_endpoint(
    page: "Page", automacao: ModuleType, serie: str, hostname: str,
    ao_encontrar: Callable[["Page", dict], dict | None] | None = None,
) -> dict:
    """Série, depois série sem ``S`` (MacBook) e por fim hostname, sempre com correspondência exata.

    Devolve ``{"estado": "unico"|"ambiguo"|"ausente", "linha", "extra"}``. Com um único resultado chama
    ``ao_encontrar(page, linha)`` com o filtro aplicado; se ele devolver algo, a grade já foi restaurada.
    """
    tentativas = [(COLUNA_SERIE, serie)]
    if serie_sem_s(serie):
        tentativas.append((COLUNA_SERIE, serie_sem_s(serie)))
    if hostname.strip():
        tentativas.append((COLUNA_NOME, hostname.strip()))
    for coluna, valor in tentativas:
        grade = aplicar_filtro(page, automacao, coluna, valor)
        cabecalho = achar_cabecalho(grade, coluna)
        encontrados = []
        for celulas in grade["linhas"]:
            if normalizar(valor_da_coluna(celulas, cabecalho)) == normalizar(valor):
                href = next((c["href"] for c in celulas if c.get("href")), "")
                encontrados.append({
                    "coluna": coluna, "valor": valor, "href": href,
                    "nome": valor_da_coluna(celulas, achar_cabecalho(grade, COLUNA_NOME)),
                    "usuarios": valor_da_coluna(celulas, achar_cabecalho(grade, COLUNA_USUARIOS)),
                })
        resultado: dict = {"estado": "ausente", "linha": None, "extra": None}
        if len(encontrados) == 1:
            resultado.update(estado="unico", linha=encontrados[0])
            if ao_encontrar is not None:
                resultado["extra"] = ao_encontrar(page, encontrados[0])
        elif encontrados:
            resultado.update(estado="ambiguo", linha=encontrados[0])
        if resultado["extra"] is None:
            limpar_filtro(page, automacao, coluna)
        if resultado["estado"] != "ausente":
            return resultado
    return {"estado": "ausente", "linha": None, "extra": None}


# --------------------------------------------------------------------------
# Detalhe do computador: Sistema > Usuários (P8)
# --------------------------------------------------------------------------

def abrir_aba(page: "Page", automacao: ModuleType, nome: str) -> None:
    padrao = re.compile(rf"^\s*{re.escape(nome)}\s*$", re.IGNORECASE)
    alvo = (
        page.get_by_role("tab", name=padrao)
        .or_(page.get_by_role("link", name=padrao))
        .or_(page.get_by_role("menuitem", name=padrao))
    ).filter(visible=True).first
    try:
        automacao.aguardar_estado(alvo, "visible", 30000)
    except Exception as erro:
        raise automacao.RotinaErro(f"A aba '{nome}' do detalhe do computador não apareceu.") from erro
    alvo.click()


def ler_usuarios_sistema(page: "Page", automacao: ModuleType) -> dict[str, Any]:
    """Nomes de Sistema > Usuários, de cima para baixo, e o usuário do último logon, depois de a tabela carregar e ficar estável."""
    fim = time.time() + automacao.CARREGAMENTO_MS / 1000
    anterior = None
    while time.time() < fim:
        automacao.verificar_cancelamento()
        leitura = page.evaluate(JS_LER_USUARIOS_SISTEMA, list(CABECALHOS_USUARIO_SISTEMA))
        confirmada = bool(leitura["cabecalho"]) and not leitura["carregando"] and (bool(leitura["nomes"]) or leitura["vazia"])
        if confirmada:
            atual = (leitura["nomes"], leitura["ultimo"])
            if anterior == atual:
                return {"nomes": [n for n in leitura["nomes"] if n], "ultimo_logon": leitura["ultimo"]}
            anterior = atual
        else:
            anterior = None
        time.sleep(0.8)
    raise automacao.RotinaErro("A tabela de Sistema > Usuários não carregou; nenhuma decisão foi tomada.")


def consultar_usuarios_sistema(page: "Page", automacao: ModuleType, linha: dict) -> dict:
    """Abre o detalhe do computador (link do nome), lê Sistema > Usuários e volta à grade."""
    href = str(linha.get("href") or "")
    if not HREF_DETALHE.match(href):
        raise automacao.RotinaErro(f"O link do detalhe de {linha.get('nome') or linha.get('valor')} não foi identificado.")
    try:
        automacao.log(ORIGEM, f"Lendo Sistema > Usuários de {linha.get('nome') or linha.get('valor')}...")
        page.locator(f'a.anchor-text[href="{href}"]').first.click()
        automacao.acionar_quando_pronto(
            lambda: None, "O detalhe do computador não abriu", confirmar=lambda: bool(URL_DETALHE.search(page.url)),
        )
        abrir_aba(page, automacao, "Sistema")
        abrir_aba(page, automacao, "Usuários")
        return ler_usuarios_sistema(page, automacao)
    finally:
        restaurar_grade(page, automacao)


# --------------------------------------------------------------------------
# Rotina
# --------------------------------------------------------------------------

def processar_pendencia(page: "Page", automacao: ModuleType, pendencia: dict) -> str:
    """Pesquisa, decide e anota uma pendência; devolve ``decidida``, ``anotada`` ou ``falha_api``."""
    serie, hostname = str(pendencia["serie"]), str(pendencia.get("computador") or "")
    automacao.log(ORIGEM, f"Pendência {serie} ({hostname or 'sem hostname'}): pesquisando no Endpoint...")

    def ao_encontrar(pg: "Page", linha: dict) -> dict | None:
        if escolher_usuario_lista(linha["usuarios"]):
            return None
        return consultar_usuarios_sistema(pg, automacao, linha)

    resultado = pesquisar_computador_endpoint(page, automacao, serie, hostname, ao_encontrar)
    if resultado["estado"] == "ambiguo":
        veredito = Decisao(None, "Mais de um computador corresponde no Endpoint; a pendência continua aberta.")
    elif resultado["estado"] == "ausente":
        veredito = avaliar_decisao(pendencia, achou=False, usuario="")
    else:
        usuario = escolher_usuario_lista(resultado["linha"]["usuarios"])
        fonte = "Usuários logados"
        consultado = False
        if not usuario and resultado["extra"] is not None:
            sistema = resultado["extra"]
            usuario, fonte, consultado = escolher_usuario_sistema(sistema["nomes"], sistema["ultimo_logon"]), "Sistema", True
        veredito = avaliar_decisao(pendencia, True, usuario, fonte, sistema_consultado=consultado or bool(usuario))
    if veredito.aviso:
        automacao.log(ORIGEM, f"[AVISO] {serie}: {veredito.aviso}.")
    aplicada = veredito.decisao is not None and decidir(automacao, pendencia, veredito.decisao)
    anotar(automacao, pendencia, veredito.anotacao)
    automacao.log(ORIGEM, f"{serie}: {veredito.decisao if aplicada else 'pendente'} - {veredito.anotacao}")
    return "decidida" if aplicada else "anotada"


def verificar_usuarios_endpoint(context: "BrowserContext", automacao: ModuleType) -> int:
    pendencias = listar_pendencias(automacao)
    if not pendencias:
        automacao.log(ORIGEM, "Nenhuma pendência de usuário aguardando decisão.")
        return 0
    automacao.log(ORIGEM, f"{len(pendencias)} pendência(s) de usuário para conferir.")
    page = automacao.nova_aba(context, automacao.ENDPOINT_URL, "Endpoint Central")
    contagem = {"decidida": 0, "anotada": 0}
    try:
        automacao.aguardar_login(page, "Endpoint Central", automacao.endpoint_logado)
        restaurar_grade(page, automacao)
        for pendencia in pendencias:
            automacao.verificar_cancelamento()
            contagem[processar_pendencia(page, automacao, pendencia)] += 1
    except Exception:
        automacao.registrar_erro(page, "Endpoint Central")
        raise
    ultimo = str(pendencias[-1].get("computador") or "").strip()
    if ultimo:
        try:  # a aba fica aberta com a grade filtrada pelo hostname da última pendência
            aplicar_filtro(page, automacao, COLUNA_NOME, ultimo)
        except automacao.RotinaErro as erro:
            automacao.log(ORIGEM, f"[AVISO] Grade final não filtrada pelo hostname: {erro}")
    automacao.log(ORIGEM, f"Concluído: {contagem['decidida']} decidida(s), {contagem['anotada']} só anotada(s).")
    return 0
