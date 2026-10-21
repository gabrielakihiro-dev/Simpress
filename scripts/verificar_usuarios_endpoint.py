"""Verificação automática de pendências de usuários no Endpoint Central.

Para cada pendência aberta dos tipos ``usuario_ausente`` e ``substituicao_manual``, pesquisa
o computador na grade "Todos os computadores" (pela série e, se preciso, pelo hostname), lê a
coluna "Usuários logados" e decide pela mesma API dos botões do histórico, ou anota a linha e
deixa a pendência para o usuário.

Por enquanto a conferência usa só a grade inicial: o detalhe do computador (Sistema > Usuários)
não é aberto. Uma linha com "Usuários logados" vazio fica pendente com anotação, em vez de ser
removida sem essa segunda conferência. No fim, a aba do Endpoint fica aberta com a grade filtrada
pelo hostname da última pendência conferida.

A grade do Endpoint é uma ember-table (não há ``<table>``): cabeçalhos em
``.ember-table-header-cell``, linhas em ``.ember-table-table-row`` e filtros em
``input.search-text-box``, que só aplicam com Enter. Cada filtro e cada célula são associados à
coluna pela posição horizontal do cabeçalho, porque a ordem das colunas muda entre as visões.
"""

from __future__ import annotations

import json
import os
import time
import unicodedata
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from types import ModuleType
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from playwright.sync_api import BrowserContext, Page


CONTAS_IGNORADAS = frozenset({
    "administrador",
    "administrator",
    "convidado",
    "guest",
    "defaultaccount",
    "wdagutilityaccount",
    "root",
})

VALORES_VAZIOS_ENDPOINT = frozenset({"", "na", "n/a", "--", "-"})

# Trechos (sem acento, minúsculos) que identificam as colunas da grade "Todos os computadores".
COLUNAS_GRADE = {
    "nome": "nome do computador",
    "usuarios": "usuarios logados",
    "serie": "numero de serie",
}
# Prazo para a grade confirmar um filtro (consulta ao servidor do Endpoint).
ESPERA_FILTRO_MS = 60_000
ANOTACAO_LIMITE = 2000
# Eventos do histórico percorridos atrás da linha da pendência (o mais recente primeiro).
EVENTOS_ANOTACAO = 10


@dataclass(frozen=True)
class DecisaoResultado:
    decidir: bool
    decisao: str
    aviso: bool
    motivo_aviso: str
    anotacao_decisao: str
    status_resumo: str  # "mantidos", "removidos", "pendentes", "ambiguos"


def normalizar_usuario(usuario: str | None) -> str:
    """Remove domínio (PR-SEBRAE\\user, user@domain) e normaliza em minúsculas."""
    if not usuario:
        return ""
    u = str(usuario).strip()
    if "\\" in u:
        u = u.split("\\", 1)[-1].strip()
    if "/" in u:
        u = u.split("/", 1)[-1].strip()
    if "@" in u:
        u = u.split("@", 1)[0].strip()
    return u.casefold()


def usuarios_iguais(u1: str | None, u2: str | None) -> bool:
    """Compara usuários sem diferenciar maiúsculas/minúsculas e sem domínio."""
    n1 = normalizar_usuario(u1)
    n2 = normalizar_usuario(u2)
    return bool(n1 and n2 and n1 == n2)


def eh_vazio_ou_na(texto: str | None) -> bool:
    """Verifica se o valor retornado pela tabela/sistema é vazio ou nulo (NA, N/A, --)."""
    if texto is None:
        return True
    return str(texto).strip().casefold() in VALORES_VAZIOS_ENDPOINT


def eh_conta_interna(usuario: str | None) -> bool:
    """Identifica contas padrão que devem ser ignoradas (Administrador, Convidado, root etc.)."""
    return normalizar_usuario(usuario) in CONTAS_IGNORADAS


def escolher_usuario_sistema(linhas_usuarios: list[str]) -> str | None:
    """Primeira linha válida de cima para baixo, ignorando contas internas e valores vazios."""
    for nome in linhas_usuarios:
        if eh_vazio_ou_na(nome) or eh_conta_interna(nome):
            continue
        return nome.strip()
    return None


def escolher_usuario_lista(texto: str | None, usuario_pendencia: str) -> str | None:
    """Usuário da coluna "Usuários logados", que pode trazer vários nomes separados por vírgula.

    Se o usuário da pendência estiver entre eles, é o escolhido; senão, vale o primeiro válido.
    """
    nomes = [parte for parte in str(texto or "").split(",")]
    validos = [n.strip() for n in nomes if not eh_vazio_ou_na(n) and not eh_conta_interna(n)]
    igual = next((n for n in validos if usuarios_iguais(n, usuario_pendencia)), None)
    return igual or (validos[0] if validos else None)


def tratar_serie_macbook(serie: str) -> str | None:
    """Para MacBook, se a série tem 'S' inicial, tenta sem o 'S' (regra do AGENTS.md)."""
    s = (serie or "").strip()
    if s.upper().startswith("S") and len(s) > 1:
        return s[1:]
    return None


# Decisões por tipo: (confirmar, desfazer, particípio usado no aviso e na anotação).
_DECISOES_POR_TIPO = {
    "usuario_ausente": ("manter", "remover", "removido"),
    "substituicao_manual": ("permitir", "recusar", "recusado"),
}


def avaliar_decisao(
    tipo: str,
    usuario_pendencia: str,
    usuario_encontrado: str | None,
    computador_achado: bool,
    ambiguo: bool = False,
    fonte: str = "",
    sistema_consultado: bool = True,
) -> DecisaoResultado:
    """Calcula a decisão e a anotação segundo a tabela de decisão combinada.

    ``sistema_consultado=False`` indica que só a grade inicial foi lida: sem usuário nela, a
    pendência fica para o usuário em vez de ser removida/recusada.
    """
    def pendente(anotacao: str, status: str = "pendentes") -> DecisaoResultado:
        return DecisaoResultado(False, "", False, "", anotacao, status)

    if ambiguo:
        return pendente("mais de um computador encontrado (ambíguo); deixado pendente", "ambiguos")
    if tipo not in _DECISOES_POR_TIPO:
        return pendente(f"tipo desconhecido ({tipo})")
    confirmar, desfazer, desfeito = _DECISOES_POR_TIPO[tipo]

    if computador_achado and usuario_encontrado and not eh_vazio_ou_na(usuario_encontrado):
        if usuarios_iguais(usuario_encontrado, usuario_pendencia):
            if tipo == "usuario_ausente":
                anotacao = f"mesmo usuário confirmado ({usuario_encontrado}); mantido"
            else:
                anotacao = f"usuário novo confirmado ({usuario_encontrado}); permitido"
            return DecisaoResultado(True, confirmar, False, "", anotacao, "mantidos")
        return pendente(f"Endpoint mostra {usuario_encontrado} ({fonte}); deixado pendente")

    if computador_achado and not sistema_consultado:
        return pendente("Usuários logados vazio no Endpoint; Sistema > Usuários não consultado; deixado pendente")

    motivo = "sem usuário válido" if computador_achado else "computador não encontrado"
    return DecisaoResultado(
        True, desfazer, True, motivo, f"{motivo} no Endpoint; {desfeito} automaticamente", "removidos",
    )


def formatar_anotacao(
    agora: datetime,
    serie: str,
    hostname: str,
    filtro: str,
    fonte: str,
    usuario_lido: str | None,
    decisao: str,
) -> str:
    dh = agora.strftime("%d/%m/%Y %H:%M")
    user_str = usuario_lido or "nenhum"
    return (
        f"[{dh}] Verificar usuários — Série: {serie} | Hostname: {hostname or '—'} | "
        f"Filtro: {filtro} | Fonte: {fonte} | Usuário lido: {user_str} | Decisão: {decisao}"
    )


# --------------------------------------------------------------------------
# Comunicação com a API do servidor Simpress local
# --------------------------------------------------------------------------

def _servidor_responde(porta: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{porta}/api/stats", timeout=0.8) as resp:
            return resp.status == 200
    except OSError:
        return False


def descobrir_porta_servidor() -> int:
    env_port = os.environ.get("SIMPRESS_PORT")
    if env_port and env_port.isdigit() and _servidor_responde(int(env_port)):
        return int(env_port)
    for p in range(8000, 8100):
        if _servidor_responde(p):
            return p
    raise RuntimeError(
        "O servidor Simpress não está em execução (portas 8000-8099). Inicie o servidor com iniciar_servidor.bat."
    )


def _get_json(url: str, timeout: float = 10) -> Any:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def obter_pendencias_abertas(porta: int) -> list[dict[str, Any]]:
    try:
        dados = _get_json(f"http://127.0.0.1:{porta}/api/usuarios/pendencias")
    except Exception as erro:
        raise RuntimeError(f"Erro ao consultar /api/usuarios/pendencias: {erro}") from erro
    pendencias = dados.get("pendencias", []) if isinstance(dados, dict) else []
    return [
        p for p in pendencias
        if isinstance(p, dict)
        and p.get("estado") == "pendente"
        and p.get("tipo") in _DECISOES_POR_TIPO
    ]


def decidir_pendencia(porta: int, pendencia_id: str, decisao: str) -> tuple[bool, int, str]:
    url = f"http://127.0.0.1:{porta}/api/usuarios/pendencias/{pendencia_id}/decidir"
    payload = json.dumps({"decisao": decisao}).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return True, resp.status, ""
    except urllib.error.HTTPError as err:
        detalhe = err.read().decode("utf-8", errors="replace")
        return False, err.code, detalhe
    except Exception as err:
        return False, 500, str(err)


def localizar_linha_anotacao(porta: int, serie: str, pendencia_id: str) -> tuple[str, dict[str, Any]] | None:
    """(evento, linha) de "Mudanças de usuário logado" ligada à pendência.

    Procura pelo ``pendencia_id`` nos eventos mais recentes; pela série só no evento mais
    recente que tenha essas mudanças, e só se ela aparecer uma única vez.
    """
    base = f"http://127.0.0.1:{porta}/api/historico-comparacoes"
    lista = _get_json(base)
    eventos = lista.get("eventos", []) if isinstance(lista, dict) else []
    serie_norm = serie.strip().upper()
    candidato_serie: tuple[str, dict[str, Any]] | None = None
    serie_conferida = False
    for resumo in eventos[:EVENTOS_ANOTACAO]:
        evento_id = str(resumo.get("id") or "") if isinstance(resumo, dict) else ""
        if not evento_id or resumo.get("somente_anotacoes_sincronizadas"):
            continue
        try:
            evento = _get_json(f"{base}/{evento_id}").get("evento", {})
        except Exception:
            continue
        mudancas = (evento.get("comparacao") or {}).get("mudancas_usuarios")
        if not isinstance(mudancas, list):
            continue
        linhas = [item for item in mudancas if isinstance(item, dict) and item.get("anotacao_id")]
        por_id = next((item for item in linhas if pendencia_id and str(item.get("pendencia_id") or "") == pendencia_id), None)
        if por_id is not None:
            return evento_id, por_id
        if not serie_conferida and linhas:
            serie_conferida = True
            mesmas = [item for item in linhas if str(item.get("serie") or "").strip().upper() == serie_norm]
            if len(mesmas) == 1:
                candidato_serie = (evento_id, mesmas[0])
    return candidato_serie


def gravar_anotacao_linha(porta: int, serie: str, pendencia_id: str, texto_anotacao: str) -> bool:
    """Acrescenta ``texto_anotacao`` à anotação da linha da pendência; ``False`` se não achar a linha."""
    achado = localizar_linha_anotacao(porta, serie, pendencia_id)
    if achado is None:
        return False
    evento_id, item = achado
    existente = str(item.get("anotacao") or "").strip()
    novo = f"{existente}\n{texto_anotacao}" if existente else texto_anotacao
    # Acima do limite, descarta o início: a conferência mais recente é a que importa.
    novo = novo[-ANOTACAO_LIMITE:]
    url = f"http://127.0.0.1:{porta}/api/historico-comparacoes/{evento_id}/anotacoes/{item['anotacao_id']}"
    req = urllib.request.Request(
        url, data=json.dumps({"anotacao": novo}).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="PUT",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.status in (200, 201)


# --------------------------------------------------------------------------
# Grade "Todos os computadores" do Endpoint Central (Playwright)
# --------------------------------------------------------------------------

_JS_GRADE = """() => {
  const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const centro = (el) => { const r = el.getBoundingClientRect(); return (r.left + r.right) / 2; };
  const cabecalhos = [...document.querySelectorAll('.ember-table-header-cell')].filter(vis).map((h) => {
    const r = h.getBoundingClientRect();
    return {titulo: h.innerText.trim(), x0: r.left, x1: r.right};
  }).filter((h) => h.titulo);
  const filtros = [...document.querySelectorAll('input.search-text-box')].filter(vis)
    .map((i) => ({id: i.id, cx: centro(i), valor: i.value}));
  const linhas = [...document.querySelectorAll('.ember-table-table-row')].filter(vis)
    .filter((r) => !r.classList.contains('ember-table-header-row'))
    .map((r) => [...r.querySelectorAll('.ember-table-cell')].map((c) => [centro(c), c.innerText.trim()]));
  const texto = document.body.innerText;
  const rodape = (texto.match(/\\d+\\s*-\\s*\\d+\\s*de/) || [''])[0];
  const carregando = [...document.querySelectorAll('.page-loader-wrapper, .spinner')].some(vis);
  const vazio = linhas.length === 0 && (/^0\\s*-\\s*0/.test(rodape) || /Nenhum dado dispon/i.test(texto));
  return {cabecalhos, filtros, linhas, rodape, carregando, vazio};
}"""


def _sem_acento(texto: str) -> str:
    decomposto = unicodedata.normalize("NFKD", texto)
    return "".join(c for c in decomposto if not unicodedata.combining(c)).casefold()


def ler_grade(page: "Page") -> dict[str, Any]:
    return page.evaluate(_JS_GRADE)


def colunas_grade(grade: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Cabeçalho de cada coluna usada (nome, usuarios, serie); ``RotinaErro`` se faltar alguma."""
    colunas = {}
    for chave, trecho in COLUNAS_GRADE.items():
        cabecalho = next((h for h in grade["cabecalhos"] if trecho in _sem_acento(h["titulo"])), None)
        if cabecalho is not None:
            colunas[chave] = cabecalho
    return colunas


def _na_coluna(cx: float, cabecalho: dict[str, Any]) -> bool:
    return cabecalho["x0"] <= cx <= cabecalho["x1"]


def filtro_da_coluna(grade: dict[str, Any], cabecalho: dict[str, Any]) -> dict[str, Any] | None:
    return next((f for f in grade["filtros"] if _na_coluna(f["cx"], cabecalho)), None)


def linhas_grade(grade: dict[str, Any]) -> list[dict[str, str]]:
    """Linhas visíveis como ``{nome, usuarios, serie}``, associando cada célula pela posição."""
    colunas = colunas_grade(grade)
    linhas = []
    for celulas in grade["linhas"]:
        linha = {}
        for chave, cabecalho in colunas.items():
            linha[chave] = next((texto for cx, texto in celulas if _na_coluna(cx, cabecalho)), "")
        linhas.append(linha)
    return linhas


def preparar_grade(page: "Page", automacao: ModuleType) -> None:
    """Confere as colunas da visão "Todos os computadores" e abre os filtros pela lupa."""
    limite = time.time() + automacao.CARREGAMENTO_MS / 1000
    while True:
        automacao.verificar_cancelamento()
        grade = ler_grade(page)
        colunas = colunas_grade(grade)
        if len(colunas) == len(COLUNAS_GRADE) and not grade["carregando"]:
            break
        if time.time() >= limite:
            faltando = sorted(set(COLUNAS_GRADE) - set(colunas))
            raise automacao.RotinaErro(f"A grade do Endpoint não mostrou as colunas esperadas ({', '.join(faltando)}).")
        page.wait_for_timeout(500)
    if all(filtro_da_coluna(grade, colunas[c]) for c in ("nome", "serie")):
        return
    lupa = page.locator("button[id$='_searchButton']").filter(visible=True)
    if lupa.count() != 1:
        raise automacao.RotinaErro("A lupa de pesquisa da grade do Endpoint não foi encontrada.")
    # Um clique só: a lupa alterna os filtros, então repetir o clique os fecharia.
    lupa.first.click()
    limite = time.time() + 15
    while time.time() < limite:
        automacao.verificar_cancelamento()
        grade = ler_grade(page)
        colunas = colunas_grade(grade)
        if all(c in colunas and filtro_da_coluna(grade, colunas[c]) for c in ("nome", "serie")):
            return
        page.wait_for_timeout(300)
    raise automacao.RotinaErro("Os filtros das colunas 'Nome do computador' e 'Número de série' não apareceram.")


def aplicar_filtro(page: "Page", automacao: ModuleType, chave: str, valor: str) -> list[dict[str, str]]:
    """Digita ``valor`` no filtro da coluna, aplica com Enter e espera a grade confirmar.

    A grade só é aceita quando o campo mantém o valor e as linhas batem com ele (todas contêm o
    valor, ou a grade mostra "0 - 0"/"Nenhum dado disponível"). Com o filtro vazio, a grade
    precisa voltar a ter linhas. Sem essa confirmação, levanta ``RotinaErro``: um resultado não
    confirmado nunca vira "computador não encontrado".
    """
    grade = ler_grade(page)
    colunas = colunas_grade(grade)
    filtro = filtro_da_coluna(grade, colunas[chave]) if chave in colunas else None
    if filtro is None or not filtro["id"]:
        raise automacao.RotinaErro(f"O filtro da coluna '{COLUNAS_GRADE[chave]}' não foi encontrado na grade do Endpoint.")
    campo = page.locator(f"[id='{filtro['id']}']")
    campo.fill(valor)
    campo.press("Enter")
    procurado = valor.strip().casefold()
    limite = time.time() + ESPERA_FILTRO_MS / 1000
    page.wait_for_timeout(300)
    while True:
        automacao.verificar_cancelamento()
        grade = ler_grade(page)
        colunas = colunas_grade(grade)
        filtro = filtro_da_coluna(grade, colunas[chave]) if chave in colunas else None
        if not grade["carregando"] and filtro is not None and filtro["valor"].strip().casefold() == procurado:
            linhas = linhas_grade(grade)
            if not procurado and linhas:
                return linhas
            if procurado and grade["vazio"]:
                return []
            if procurado and linhas and all(procurado in linha.get(chave, "").casefold() for linha in linhas):
                return linhas
        if time.time() >= limite:
            raise automacao.RotinaErro(
                f"A grade do Endpoint não confirmou o filtro da coluna '{COLUNAS_GRADE[chave]}' em {ESPERA_FILTRO_MS // 1000} s; "
                "nenhuma decisão foi tomada para esta pendência."
            )
        page.wait_for_timeout(250)


def pesquisar_computador_endpoint(
    page: "Page", automacao: ModuleType, serie: str, hostname: str,
) -> tuple[list[dict[str, str]], str]:
    """Linhas com série (ou hostname) exatamente igual e o filtro que as achou.

    Cada filtro é limpo logo depois de lido, para a grade voltar à lista completa antes da
    próxima pesquisa (assim um resultado vazio anterior nunca é confundido com o novo).
    """
    tentativas = [("serie", serie, "série")]
    serie_sem_s = tratar_serie_macbook(serie)
    if serie_sem_s:
        tentativas.append(("serie", serie_sem_s, "série (sem S)"))
    tentativas.append(("nome", hostname, "hostname"))
    for chave, valor, rotulo in tentativas:
        valor = valor.strip()
        if not valor:
            continue
        linhas = aplicar_filtro(page, automacao, chave, valor)
        exatas = [linha for linha in linhas if linha.get(chave, "").strip().casefold() == valor.casefold()]
        aplicar_filtro(page, automacao, chave, "")
        if exatas:
            return exatas, rotulo
    return [], "nenhum"


# --------------------------------------------------------------------------
# Rotina
# --------------------------------------------------------------------------

def abrir_grade_endpoint(context: "BrowserContext", automacao: ModuleType) -> "Page":
    page = automacao.nova_aba(context, automacao.ENDPOINT_URL, "Endpoint Central")
    automacao.aguardar_login(page, "Endpoint Central", automacao.endpoint_logado)
    if not page.url.rstrip("/").endswith("inventory/computers"):
        page.goto(automacao.ENDPOINT_URL, wait_until="domcontentloaded", timeout=automacao.CARREGAMENTO_MS)
    automacao.selecionar_todos_computadores(page)
    automacao.confirmar_modo_todos(page)
    preparar_grade(page, automacao)
    return page


def verificar_usuarios_endpoint(context: "BrowserContext", automacao: ModuleType) -> int:
    """Confere as pendências abertas; ``automacao`` é o módulo ``automacao_rotinas_chrome`` em execução."""
    origem = "Verificar usuários"
    porta = descobrir_porta_servidor()
    pendencias = obter_pendencias_abertas(porta)
    if not pendencias:
        automacao.log(origem, "Nenhuma pendência de usuário aberta para verificar.")
        return 0
    automacao.log(origem, f"{len(pendencias)} pendência(s) de usuário para conferir no Endpoint Central.")

    contagem = {"mantidos": 0, "removidos": 0, "pendentes": 0, "ambiguos": 0, "conflitos": 0, "erros": 0}
    avisos: list[str] = []
    # A aba fica aberta no fim (também em caso de falha), para o usuário conferir a última pesquisa.
    page = abrir_grade_endpoint(context, automacao)
    ultimo_hostname = ""
    try:
        for i, p in enumerate(pendencias, start=1):
            automacao.verificar_cancelamento("Verificação de usuários cancelada pelo usuário.")
            pend_id = str(p.get("id") or "")
            serie = str(p.get("serie") or "").strip()
            hostname = str(p.get("computador") or "").strip()
            tipo = str(p.get("tipo") or "").strip()
            usuario_pendencia = str(p.get("usuario_atual" if tipo == "usuario_ausente" else "usuario_endpoint") or "").strip()
            automacao.log(origem, f"[{i}/{len(pendencias)}] {serie} ({hostname or 'sem hostname'}) — {tipo}, esperado {usuario_pendencia or '—'}")
            ultimo_hostname = hostname or ultimo_hostname

            # Uma falha na grade interrompe a rotina: sem confirmação, nenhuma pendência é decidida.
            linhas, filtro_usado = pesquisar_computador_endpoint(page, automacao, serie, hostname)
            usuario_lido = None
            fonte = "lista" if linhas else "nenhuma"
            if len(linhas) == 1:
                usuario_lido = escolher_usuario_lista(linhas[0].get("usuarios"), usuario_pendencia)
            resultado = avaliar_decisao(
                tipo, usuario_pendencia, usuario_lido,
                computador_achado=bool(linhas), ambiguo=len(linhas) > 1, fonte=fonte, sistema_consultado=False,
            )

            desfecho = resultado.anotacao_decisao
            status = resultado.status_resumo
            if resultado.decidir:
                ok, codigo, detalhe = decidir_pendencia(porta, pend_id, resultado.decisao)
                if not ok:
                    status = "conflitos" if codigo == 409 else "erros"
                    desfecho = f"decisão '{resultado.decisao}' não aplicada (HTTP {codigo})"
                    marcador = "" if codigo == 409 else "[FALHA] "
                    automacao.log(origem, f"{marcador}{serie}: {desfecho}. {detalhe[:200]}".strip())
                elif resultado.aviso:
                    aviso = f"{serie} {hostname or '—'} — {resultado.motivo_aviso} — {resultado.anotacao_decisao.rsplit('; ', 1)[-1]}"
                    print(f"[AVISO] {origem}: {aviso}", flush=True)
                    avisos.append(aviso)
            contagem[status] += 1
            automacao.log(origem, f"{serie}: {desfecho}.")

            texto = formatar_anotacao(datetime.now(), serie, hostname, filtro_usado, fonte, usuario_lido, desfecho)
            try:
                if not gravar_anotacao_linha(porta, serie, pend_id, texto):
                    automacao.log(origem, f"[AVISO] {serie}: linha do histórico não encontrada; anotação não gravada.")
            except Exception as erro:
                automacao.log(origem, f"[AVISO] {serie}: anotação não gravada ({automacao.descrever_erro(erro)}).")
    finally:
        try:
            page.bring_to_front()
        except Exception:
            pass

    if ultimo_hostname:
        try:
            aplicar_filtro(page, automacao, "nome", ultimo_hostname)
            automacao.log(origem, f"Aba do Endpoint mantida aberta com a pesquisa do hostname {ultimo_hostname}.")
        except Exception as erro:
            automacao.log(origem, f"[AVISO] A pesquisa final do hostname não foi aplicada ({automacao.descrever_erro(erro)}).")

    print("\n=== Resumo da verificação de usuários ===", flush=True)
    print(f"Total verificado: {len(pendencias)}", flush=True)
    print(f"Mantidos/permitidos: {contagem['mantidos']}", flush=True)
    print(f"Removidos/recusados: {contagem['removidos']}", flush=True)
    print(f"Pendentes com anotação: {contagem['pendentes']}", flush=True)
    print(f"Ambíguos: {contagem['ambiguos']}", flush=True)
    print(f"Já decididas/desatualizadas (409): {contagem['conflitos']}", flush=True)
    print(f"Erros: {contagem['erros']}", flush=True)
    if avisos:
        print("\nRemoções/recusas automáticas (revise):", flush=True)
        for aviso in avisos:
            print(f"  - {aviso}", flush=True)
    return 0 if contagem["erros"] == 0 else 1
