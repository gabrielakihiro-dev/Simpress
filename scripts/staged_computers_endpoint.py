"""Etapa "Staged Computers": procura no Endpoint Central os hostnames que sumiram do Endpoint.

Depois de Inventários/Ambas, lê o evento mais recente do histórico e, nas linhas de "Passou de 60 dias sem
acesso" com situação ``saiu_endpoint`` (o notebook deixou a lista do Endpoint), procura o hostname na grade
de Staged Computers do Endpoint. O resultado vai para a anotação da própria linha
(``PUT /api/historico-comparacoes/{evento}/anotacoes/{anotacao_id}``).

Regras:
- Só leitura na página: nenhum clique, caixa de seleção, aprovação nem "Configure Inactive Computer Policy".
  A aba é própria, o login é sempre do usuário e a aba nunca é fechada.
- "Não encontrado" só vale com a grade completa: o fim da paginação ("1 - N") tem de ser igual às linhas
  lidas e menor que as linhas por página escolhidas na tela ("Rows per page", salvo pelo Endpoint), o botão de
  próxima página tem de estar desativado, nenhuma caixa de busca pode ter texto e grade vazia exige
  "Nenhum dado disponível". Sem isso as linhas encontradas ainda são anotadas, mas nenhum "não encontrado"
  é gravado. Limite: o filtro avançado não é detectado.
- Anotação em conflito ou com integridade inválida não é tocada, e a linha é relida logo antes de gravar.
- O hostname é comparado só com "Nome do computador" e "Nome completo do computador", nunca com "Nome amigável".
- Usuários logados, IP e MAC não são lidos nem guardados.
- O módulo recebe o módulo de automação em execução (``automacao``); não importe
  ``scripts.automacao_rotinas_chrome`` aqui.
"""

from __future__ import annotations

import re
import time
from datetime import datetime
from types import ModuleType
from typing import TYPE_CHECKING

from scripts.verificar_usuarios_endpoint import (
    LIMITE_ANOTACAO, ErroApi, achar_cabecalho, chamar_api, ler_grade, normalizar, valor_da_coluna,
)

if TYPE_CHECKING:
    from playwright.sync_api import BrowserContext, Page

ORIGEM = "Staged Computers"
URL_STAGED_COMPUTERS = "https://centralendpoint.pr.sebrae.com.br/webclient#/uems/agent/som/staged-computers"
ID_BOTAO_BUSCA = "SoMStagedComputers_searchButton"  # presente = tela pronta
LINHAS_POR_PAGINA = 25  # padrão do Endpoint, usado só se a tela não mostrar "Rows per page"
LEITURAS_SEM_PAGINACAO = 5  # leituras iguais (~4 s) antes de aceitar que a paginação não vai aparecer
COLUNAS_NOME = ("nome do computador", "nome completo do computador")
COLUNA_ESCRITORIO = "escritorio remoto"
COLUNA_GERENCIAMENTO = "management status"
COLUNA_AGENTE = "status do agente"
COLUNA_CONTATO = "horario do ultimo contato"
MENSAGEM_NAO_ENCONTRADO = "Não encontrado em Staged Computers do Endpoint."
CARIMBO = re.compile(r"^\[Staged Computers \d{2}/\d{2}/\d{4} \d{2}:\d{2}\] (.*)$")

# A tela mostra "1 - 5 de" sem o total: o fim do intervalo é o número de computadores da página.
# Junto vêm as linhas por página escolhidas, o botão de próxima página e as caixas de busca com texto.
JS_LER_PAGINACAO = """
() => {
  const corpo = document.body ? document.body.innerText : '';
  const achou = corpo.match(/(?:^|\\s)(\\d+)\\s*[-–]\\s*(\\d+)\\s+de(?:\\s|$)/i);
  if (!achou) return null;
  const visivel = el => el.getClientRects().length > 0;
  const tamanho = document.querySelector('select.tvp-paginator');
  const proxima = document.querySelector('button.tvp-footer__navig-button__right');
  const busca = [...document.querySelectorAll('input[type=text], input[type=search], input:not([type])')]
    .some(el => visivel(el) && el.value.trim());
  return {
    inicio: Number(achou[1]), fim: Number(achou[2]),
    por_pagina: tamanho && /^\\d+$/.test(tamanho.value) ? Number(tamanho.value) : null,
    proxima_ativa: proxima ? !proxima.disabled : null,
    busca,
    nenhum_dado: /Nenhum dado dispon[ií]vel|No data/i.test(corpo),
  };
}
"""


# --------------------------------------------------------------------------
# API do Simpress
# --------------------------------------------------------------------------

def listar_saiu_endpoint(automacao: ModuleType) -> tuple[str, list[dict]]:
    """Atualização mais recente do histórico e suas linhas ``saiu_endpoint`` (com ``anotacao_id`` e hostname).

    Como o Resumo, ignora restaurações e eventos refeitos só com anotações sincronizadas."""
    eventos = chamar_api(automacao, "GET", "/api/historico-comparacoes").get("eventos", [])
    evento_id = next(
        (str(e["id"]) for e in eventos
         if isinstance(e, dict) and e.get("id") and e.get("tipo") != "restauracao"
         and not e.get("somente_anotacoes_sincronizadas")),
        "",
    )
    return (evento_id, linhas_saiu_endpoint(automacao, evento_id)) if evento_id else ("", [])


def linhas_saiu_endpoint(automacao: ModuleType, evento_id: str) -> list[dict]:
    detalhe = chamar_api(automacao, "GET", f"/api/historico-comparacoes/{evento_id}")
    linhas = ((detalhe.get("evento") or {}).get("comparacao") or {}).get("sem_acesso_60_dias") or []
    return [l for l in linhas if l.get("situacao") == "saiu_endpoint" and l.get("anotacao_id")]


def ultima_mensagem(atual: str) -> str | None:
    """Mensagem (sem o carimbo) da última entrada "[Staged Computers ...]" da anotação."""
    for linha in reversed(str(atual or "").splitlines()):
        achou = CARIMBO.match(linha.strip())
        if achou:
            return achou.group(1)
    return None


def montar_anotacao(atual: str, nova: str) -> str:
    carimbo = f"[Staged Computers {datetime.now():%d/%m/%Y %H:%M}] {nova}"
    return f"{atual.rstrip()}\n{carimbo}" if atual.strip() else carimbo


def anotar(automacao: ModuleType, evento_id: str, linha: dict, mensagem: str) -> str:
    """Acrescenta a mensagem à anotação da linha: ``gravada``, ``igual`` (sem PUT) ou ``falha``."""
    serie = linha.get("serie")
    if linha.get("anotacao_conflito") or linha.get("anotacao_integridade_invalida"):
        # Em conflito a anotação chega vazia: gravar só o carimbo esconderia a nota do usuário.
        automacao.log(ORIGEM, f"[AVISO] Anotação de {serie} não gravada: está em conflito ou com integridade inválida; resolva no Resumo.")
        return "falha"
    atual = str(linha.get("anotacao") or "")
    if ultima_mensagem(atual) == mensagem:
        return "igual"
    texto = montar_anotacao(atual, mensagem)
    if len(texto) > LIMITE_ANOTACAO:  # nunca troca a nota do usuário por só o carimbo
        automacao.log(ORIGEM, f"[AVISO] Anotação de {serie} não gravada: passaria de {LIMITE_ANOTACAO} caracteres.")
        return "falha"
    corpo: dict = {"anotacao": texto}
    if isinstance(linha.get("anotacao_revisoes"), list):
        corpo["base_revisoes"] = linha["anotacao_revisoes"]
    try:
        chamar_api(automacao, "PUT", f"/api/historico-comparacoes/{evento_id}/anotacoes/{linha['anotacao_id']}", corpo)
    except ErroApi as erro:
        automacao.log(ORIGEM, f"[AVISO] Anotação de {serie} não gravada ({erro}).")
        return "falha"
    return "gravada"


# --------------------------------------------------------------------------
# Grade de Staged Computers (ember-table), só leitura
# --------------------------------------------------------------------------

def ler_paginacao(page: "Page") -> dict | None:
    """Rodapé da grade (``JS_LER_PAGINACAO``), ou ``None`` se a tela ainda não mostra "1 - N de"."""
    return page.evaluate(JS_LER_PAGINACAO) or None


def ler_tela(page: "Page", automacao: ModuleType) -> tuple[dict, dict | None]:
    """Grade e paginação, depois de a tela sair do carregamento e as leituras seguidas coincidirem.

    Duas leituras iguais bastam; sem o texto da paginação (pode aparecer depois das linhas) ou com a grade
    vazia (pode ser antes de os dados chegarem) esperam-se ``LEITURAS_SEM_PAGINACAO``, e o portão de completude recusa o resultado. Sem leitura estável o prazo
    acaba: com a grade presente devolve a última leitura; sem grade nenhuma levanta ``RotinaErro``."""
    fim = time.time() + automacao.CARREGAMENTO_MS / 1000
    anterior = ultima = None
    iguais = 0
    while time.time() < fim:
        automacao.verificar_cancelamento()
        grade = ler_grade(page)
        paginacao = ler_paginacao(page)
        if not grade["carregando"] and grade["cabecalhos"]:
            ultima = (grade, paginacao)
            atual = (paginacao, [[c["texto"] for c in celulas] for celulas in grade["linhas"]])
            iguais = iguais + 1 if atual == anterior else 0
            anterior = atual
            if iguais >= (1 if paginacao is not None and grade["linhas"] else LEITURAS_SEM_PAGINACAO):
                return ultima
        else:
            anterior, iguais = None, 0
        time.sleep(0.8)
    if ultima is None:
        raise automacao.RotinaErro("A grade de Staged Computers não carregou; nada foi anotado.")
    return ultima


def motivo_incompleta(grade: dict, paginacao: dict | None) -> str:
    """Vazio quando a grade prova que lista todos os computadores; senão, o motivo de não provar."""
    if paginacao is None:
        return "o texto da paginação não foi lido"
    inicio, total = int(paginacao["inicio"]), int(paginacao["fim"])
    por_pagina = paginacao.get("por_pagina") or LINHAS_POR_PAGINA
    lidas = len(grade["linhas"])
    if inicio > 1:
        return f"a grade não está na primeira página (começa em {inicio})"
    if total != lidas:
        return f"a paginação indica {total} computador(es), mas {lidas} linha(s) foram lidas"
    if total >= por_pagina:
        return f"a página está cheia ({total} de {por_pagina}); pode haver mais páginas"
    if paginacao.get("proxima_ativa"):
        return "o botão de próxima página está ativo"
    if paginacao.get("busca"):
        return "há texto numa caixa de busca da grade"
    if not lidas and not paginacao.get("nenhum_dado"):
        return "a grade está vazia sem a mensagem 'Nenhum dado disponível'"
    return ""


def linhas_do_hostname(grade: dict, hostname: str) -> list[list[dict]]:
    """Linhas cujo "Nome do computador" é o hostname ou cujo "Nome completo" é ele (ou ``hostname.dominio``)."""
    alvo = normalizar(hostname)
    nome, completo = (achar_cabecalho(grade, coluna) for coluna in COLUNAS_NOME)
    achadas = []
    for celulas in grade["linhas"]:
        valor_nome = normalizar(valor_da_coluna(celulas, nome))
        valor_completo = normalizar(valor_da_coluna(celulas, completo))
        if alvo and (alvo in (valor_nome, valor_completo) or valor_completo.startswith(alvo + ".")):
            achadas.append(celulas)
    return achadas


def mensagem_encontrado(grade: dict, celulas: list[dict]) -> str:
    def campo(coluna: str) -> str:
        return valor_da_coluna(celulas, achar_cabecalho(grade, coluna)) or "não informado"

    return (
        f"Encontrado em Staged Computers do Endpoint: escritório {campo(COLUNA_ESCRITORIO)}, "
        f"status {campo(COLUNA_GERENCIAMENTO)}/{campo(COLUNA_AGENTE)}, último contato {campo(COLUNA_CONTATO)}."
    )


# --------------------------------------------------------------------------
# Rotina
# --------------------------------------------------------------------------

def verificar_staged_computers(context: "BrowserContext", automacao: ModuleType) -> int:
    automacao.verificar_cancelamento()
    evento_id, linhas = listar_saiu_endpoint(automacao)
    sem_hostname = [l for l in linhas if not str(l.get("computador") or "").strip()]
    linhas = [l for l in linhas if l not in sem_hostname]
    if sem_hostname:
        automacao.log(ORIGEM, f"[AVISO] {len(sem_hostname)} linha(s) sem hostname não podem ser procuradas.")
    if not linhas:
        automacao.log(ORIGEM, "Nenhum notebook que saiu do Endpoint (passou de 60 dias) para procurar em Staged Computers.")
        return 0
    automacao.log(ORIGEM, f"{len(linhas)} hostname(s) que saíram do Endpoint para procurar em Staged Computers.")
    page = automacao.nova_aba(context, URL_STAGED_COMPUTERS, "Endpoint Central")
    automacao.definir_pagina_ativa_para_recuperacao(page)
    automacao.endpoint_vigiar_avisos(page)
    def ler() -> tuple[dict, dict | None]:
        # O login ou um clique acidental pode tirar a aba da tela: volta ao mesmo link (goto, nunca reload).
        if "staged-computers" not in page.url.lower():
            page.goto(URL_STAGED_COMPUTERS, wait_until="domcontentloaded", timeout=automacao.CARREGAMENTO_MS)
        automacao.aguardar_estado(page.locator(f"#{ID_BOTAO_BUSCA}"), "visible")
        lida = ler_tela(page, automacao)
        if "staged-computers" not in page.url.lower():  # outra grade com as mesmas colunas daria "não encontrado" falso
            raise automacao.EtapaInstavel("a aba saiu de Staged Computers durante a leitura")
        return lida

    try:
        automacao.aguardar_login(page, "Endpoint Central", automacao.endpoint_logado)
        grade, paginacao = automacao.etapa_resiliente(ler, "Ler Staged Computers", recuperar=lambda: None)
    except Exception:
        automacao.registrar_erro(page, "Endpoint Central")
        raise
    if not any(achar_cabecalho(grade, coluna) for coluna in COLUNAS_NOME):
        automacao.log(ORIGEM, "[AVISO] As colunas de nome do computador não estão visíveis em Staged Computers; nada foi anotado.")
        return 0
    motivo = motivo_incompleta(grade, paginacao)
    if motivo:
        automacao.log(ORIGEM, f"[AVISO] Grade de Staged Computers sem prova de estar completa ({motivo}): 'não encontrado' não será anotado.")
    contagem = {"gravada": 0, "igual": 0, "falha": 0, "ignorada": 0}
    # Relê as linhas: o login e a leitura podem levar minutos, e a nota pode ter mudado no Resumo.
    atuais = {l["anotacao_id"]: l for l in linhas_saiu_endpoint(automacao, evento_id)}
    for linha in linhas:
        linha = atuais.get(linha["anotacao_id"])
        if linha is None:
            contagem["ignorada"] += 1
            continue
        automacao.verificar_cancelamento()
        achadas = linhas_do_hostname(grade, str(linha["computador"]))
        if achadas:
            mensagem = mensagem_encontrado(grade, achadas[0])
        elif not motivo:
            mensagem = MENSAGEM_NAO_ENCONTRADO
        else:
            contagem["ignorada"] += 1
            continue
        resultado = anotar(automacao, evento_id, linha, mensagem)
        contagem[resultado] += 1
        automacao.log(ORIGEM, f"{linha.get('serie')}: {'encontrado' if achadas else 'não encontrado'} ({resultado}).")
    automacao.log(
        ORIGEM,
        f"Concluído: {contagem['gravada']} anotada(s), {contagem['igual']} já igual(is), "
        f"{contagem['falha']} com falha, {contagem['ignorada']} sem prova para 'não encontrado'.",
    )
    return 0
