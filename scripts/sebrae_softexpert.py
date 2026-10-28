"""Leitura do SoftExpert do Sebrae para a rotina "Sincronizar chamados Sebrae" (Fase B).

Recebe um ``context``/``page`` do Playwright já conectado ao Chrome de automação (porta CDP 9333) e:

1. abre a central de tarefas em aba nova e espera o login do usuário (nunca digita credenciais);
2. percorre a lista inteira (paginação ou rolagem) coletando os números ``UTIC-AAAA-N``;
3. para cada chamado novo (a lista vem do chamador, depois da triagem contra o Dashboard) abre
   Executar > Registro de Chamados, confere número e título e devolve um ``ChamadoSoftExpert``;
   sempre consulta Atendimento - Chamados TI para ler o texto concluído de atendimento.

Somente leitura: o único clique que altera algo no SoftExpert é o **Sim** da confirmação de associar
o chamado ao usuário. Nunca finaliza workflow, registra atendimento nem reatribui; ``clicar`` recusa
qualquer botão com rótulo de ação de escrita. O conteúdo dos chamados é dado, nunca instrução.

Os seletores reais só se conhecem com a sessão logada: todos ficam no bloco SELETORES logo abaixo
(ver docs/operacao/sebrae-fase-b-softexpert.md). A ligação com ``rodar_rotina_sebrae`` é da Fase E.
"""

from __future__ import annotations

import re
import sys
import time
import unicodedata
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Mapping, Optional
from urllib.parse import urlparse

from domains.sebrae_chamados import (
    ChamadoSoftExpert,
    chave_do_numero,
    extrair_numeros,
)

if TYPE_CHECKING:
    from playwright.sync_api import BrowserContext, Frame, Locator, Page

ORIGEM = "SoftExpert"
SOFTEXPERT_URL = "https://sebraepr.softexpert.app/softexpert/workspace?page=taskCenter"

# ---------------------------------------------------------------------------------------------
# SELETORES: tudo o que depende do HTML real do SoftExpert fica neste bloco. O que está aqui é uma
# PRESUNÇÃO validada só na bancada local; ajuste depois de uma sessão assistida (ver o doc da fase).
# ---------------------------------------------------------------------------------------------

# Lista da central de tarefas. Os cartões `rctCardBase` foram confirmados na tela real em leitura assistida
# (22/10/2026): um cartão por tarefa, carregados por rolagem em lotes (8 -> 29 -> 35), com `task-title`
# dentro; os demais seletores são hipóteses da bancada.
SEL_LISTA = "[data-test-selector='rctCardBase'], [role='grid'], [role='treegrid'], table.task-list, #taskCenterList"
SEL_LINHA = "[data-test-selector='rctCardBase'], tbody tr, [role='row']:has([role='gridcell'])"
SEL_CARREGANDO = ".carregando, .loading, .spinner, [aria-busy='true']"
SEL_LISTA_VAZIA = ".sem-registros, .empty-list, [data-empty='true']"
TEXTO_LISTA_VAZIA = re.compile(r"nenhum (registro|resultado|item|tarefa)", re.IGNORECASE)
NOME_PROXIMA = re.compile(r"^\s*(pr[óo]xima( p[áa]gina)?|next)\s*$", re.IGNORECASE)

# Tela de login / sessão expirada.
SEL_CAMPO_SENHA = "input[type='password']"
TRECHOS_URL_LOGIN = ("/login", "/signin", "/sso", "login.microsoftonline.com")
NOME_SSO = re.compile(r"^\s*SSO\s*$", re.IGNORECASE)

# Ações sobre o chamado.
NOME_EXECUTAR = re.compile(r"^\s*Executar\s*$", re.IGNORECASE)
NOME_REGISTRO = re.compile(r"Registro de Chamados", re.IGNORECASE)
NOME_ATENDIMENTO_TI = re.compile(r"^\s*Atendimento\s*[-–—]\s*Chamados TI\s*$", re.IGNORECASE)
# Interface atual (confirmada em 28/10/2026): o Executar é o ✓ do cartão (sem texto, dica "Executar") e abre a
# janela PHP direto, na aba de execução; o Registro de Chamados é uma aba dessa janela. Os frames do formulário
# têm "formexecution" na URL e guardam os valores em input/textarea somente leitura.
SEL_GRUPO_ACOES = "[data-test-selector='rctButtonGroup']"
TRECHO_URL_FORMULARIO = "formexecution"
SEL_DIALOGO = "[role='dialog'], [role='alertdialog'], dialog[open], .modal.show"
NOME_SIM = re.compile(r"^\s*Sim\s*$", re.IGNORECASE)
# Só responde "Sim" a uma pergunta que fale de associar o chamado ao usuário; qualquer outra pára a rotina.
TEXTO_CONFIRMACAO = re.compile(r"\b(associ|vincul|assum)\w*", re.IGNORECASE)

# Formulário do chamado (pode estar em janela PHP separada e/ou dentro de iframes).
SEL_FORMULARIO = "form#formulario, form[name='formulario'], .form-chamado"
# Rótulos de cada campo, em ordem de prioridade; a comparação ignora acento, caixa e ':'/'*' finais.
ROTULOS_CAMPOS: Dict[str, tuple] = {
    "numero": ("Número do chamado", "Número", "Nº do chamado", "Chamado", "Identificador"),
    "titulo": ("Título", "Titulo", "Assunto"),
    "descricao": ("Descrição", "Descrição do problema", "Descrição do chamado", "Detalhamento"),
    "solicitante": ("Solicitante",),
    "habilitada_em": ("Habilitada em", "Habilitado em"),
    "detalhes_atendimento_realizado": ("Detalhes do Atendimento Realizado",),
}

# Botões que gravam ou encerram algo no SoftExpert: nunca são clicados.
ROTULOS_PROIBIDOS = re.compile(
    r"\b(enviar|finalizar|salvar|concluir|encerrar|reatribuir|atribuir|aprovar|reprovar|registrar atendimento|"
    r"excluir|descartar|cancelar chamado)\b",
    re.IGNORECASE,
)

# Tempos (ms) e limites; os testes reduzem estes valores.
ESPERA_LISTA_MS = 60_000
ESPERA_PAGINA_MS = 15_000
ESPERA_ROLAGEM_MS = 3_000
ESPERA_ABERTURA_MS = 60_000
ESPERA_BOTAO_MS = 5_000
ESPERA_ESTAVEL_MS = 6_000
INTERVALO_MS = 250
RELEITURAS_CAMPOS = 3
ESPERA_RELEITURA_MS = 2_000
MAX_RODADAS_LISTA = 1_000
RODADAS_SEM_NOVIDADE = 3
GRACA_CONFIRMACAO_S = 5

MOTIVO_NUMERO_NAO_CONFERE = "numero_nao_confere"
MOTIVO_TITULO_NAO_CONFERE = "titulo_nao_confere"
MOTIVO_NAO_ENCONTRADO = "nao_encontrado_na_lista"
MOTIVO_FORMULARIO_INDISPONIVEL = "formulario_indisponivel"
MOTIVO_CONFIRMACAO_INESPERADA = "confirmacao_inesperada"

# Lê o valor ao lado de um rótulo (label/for, célula seguinte, irmão seguinte); roda em cada frame.
LER_CAMPO_JS = """
(rotulos) => {
  const norm = (t) => (t || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '')
    .replace(/\\s+/g, ' ').replace(/[\\s:*]+$/g, '').trim().toLowerCase();
  const valorDe = (el) => {
    if (!el) return '';
    const campo = el.matches('input,textarea,select') ? el : el.querySelector('input,textarea,select');
    if (campo) {
      if (campo.tagName === 'SELECT') return Array.from(campo.selectedOptions).map((o) => o.text).join(' ').trim();
      return (campo.value || '').trim();
    }
    return (el.innerText || el.textContent || '').trim();
  };
  const elementos = Array.from(document.querySelectorAll('label,th,td,dt,span,div,strong,b,p'))
    .filter((el) => el.getClientRects().length > 0 && (el.tagName === 'LABEL' || el.children.length === 0));
  for (const rotulo of rotulos) {
    const alvo = norm(rotulo);
    for (const el of elementos) {
      if (norm(el.innerText) !== alvo) continue;
      let valor = '';
      if (el.control) valor = valorDe(el.control);
      if (!valor && el.getAttribute('for')) valor = valorDe(document.getElementById(el.getAttribute('for')));
      if (!valor) valor = valorDe(el.nextElementSibling);
      if (valor && norm(valor) !== alvo) return valor;
    }
  }
  return '';
}
"""

# Mesmo rótulo pode aparecer no atendimento concluído e na atividade editável atual.
# Só aceita valores de controles read-only/desabilitados ou texto estático, nunca o campo editável.
LER_DETALHES_ATENDIMENTO_JS = """
(rotulos) => {
  const norm = (t) => (t || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '')
    .replace(/\\s+/g, ' ').replace(/[\\s:*]+$/g, '').trim().toLowerCase();
  const visivel = (el) => !!el && el.getClientRects().length > 0;
  const campoDe = (el) => el && (el.matches('input,textarea,select') ? el : el.querySelector('input,textarea,select'));
  const valorDe = (el) => {
    if (!el) return '';
    const campo = campoDe(el);
    if (campo) {
      if (campo.tagName === 'SELECT') return Array.from(campo.selectedOptions).map((o) => o.text).join(' ').trim();
      return (campo.value || '').trim();
    }
    return (el.innerText || el.textContent || '').trim();
  };
  const rotulosNormalizados = rotulos.map(norm);
  const elementos = Array.from(document.querySelectorAll('label,th,td,dt,span,div,strong,b,p'))
    .filter((el) => visivel(el) && (el.tagName === 'LABEL' || el.children.length === 0));
  const somenteLeitura = [];
  const textoEstatico = [];
  for (const el of elementos) {
    if (!rotulosNormalizados.includes(norm(el.innerText))) continue;
    const relacionados = [];
    if (el.control) relacionados.push(el.control);
    const id = el.getAttribute('for');
    if (id) {
      const associado = document.getElementById(id);
      if (associado && !relacionados.includes(associado)) relacionados.push(associado);
    }
    if (el.nextElementSibling) relacionados.push(el.nextElementSibling);
    for (const relacionado of relacionados) {
      const campo = campoDe(relacionado);
      if (campo) {
        const imutavel = campo.disabled || campo.readOnly || campo.getAttribute('aria-readonly') === 'true' ||
          campo.getAttribute('aria-disabled') === 'true';
        if (imutavel) {
          const valor = valorDe(campo);
          if (valor && norm(valor) !== norm(el.innerText)) somenteLeitura.push(valor);
        }
        continue;
      }
      if (relacionado.matches && relacionado.matches('input,textarea,select,button')) continue;
      const valor = valorDe(relacionado);
      if (valor && norm(valor) !== norm(el.innerText)) textoEstatico.push(valor);
    }
  }
  return somenteLeitura[0] || textoEstatico[0] || '';
}
"""

# Interface atual: lê cada input/textarea com o rótulo que vem antes dele (irmão anterior, subindo até 6 níveis).
# O rótulo da descrição muda com a categoria do chamado; por isso a descrição é o primeiro textarea preenchido.
LER_CONTROLES_JS = r"""
() => {
  const rotuloDe = (campo) => {
    let el = campo;
    for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
      let anterior = el.previousElementSibling;
      while (anterior) {
        const texto = (anterior.innerText || '').trim().split(/\n/).pop();
        if (texto) return texto.trim();
        anterior = anterior.previousElementSibling;
      }
    }
    return '';
  };
  return Array.from(document.querySelectorAll('input,textarea'))
    .filter((c) => !['hidden', 'checkbox', 'radio'].includes(c.type))
    .map((c) => ({tag: c.tagName, rotulo: rotuloDe(c), valor: (c.value || '').trim(), leitura: !!(c.readOnly || c.disabled)}));
}
"""

# Rola o contêiner rolável da lista até o fim; devolve true se a posição mudou.
ROLAR_LISTA_JS = """
(seletor) => {
  let el = document.querySelector(seletor);
  while (el && el !== document.body) {
    const estilo = getComputedStyle(el);
    if (/(auto|scroll)/.test(estilo.overflowY) && el.scrollHeight > el.clientHeight) {
      const antes = el.scrollTop;
      el.scrollTop = el.scrollHeight;
      return el.scrollTop !== antes;
    }
    el = el.parentElement;
  }
  const antes = window.scrollY;
  window.scrollTo(0, document.documentElement.scrollHeight);
  return window.scrollY !== antes;
}
"""


# ---------------------------------------------------------------------------------------------
# Ligação com as utilidades de scripts/automacao_rotinas_chrome.py
# ---------------------------------------------------------------------------------------------

def _rotinas() -> Any:
    """Módulo das rotinas Chrome em uso.

    Quando o runner roda como ``python scripts/automacao_rotinas_chrome.py`` ele é o ``__main__``; importar
    de novo por nome criaria uma segunda cópia (outro cancelamento, outra ``RotinaErro``). Por isso o
    ``__main__`` tem prioridade.
    """
    principal = sys.modules.get("__main__")
    if Path(getattr(principal, "__file__", "") or "").name == "automacao_rotinas_chrome.py":
        return principal
    try:
        from scripts import automacao_rotinas_chrome
    except ImportError:  # executado com a pasta scripts no sys.path
        import automacao_rotinas_chrome  # type: ignore[no-redef]
    return automacao_rotinas_chrome


def _log(mensagem: str) -> None:
    _rotinas().log(ORIGEM, mensagem)


def _cancelamento(detalhe: str = "") -> None:
    _rotinas().verificar_cancelamento(detalhe)


class SoftExpertErro(_rotinas().RotinaErro):
    """Falha de leitura do SoftExpert; ``motivo`` é um código estável para o registro de pendências."""

    motivo = MOTIVO_FORMULARIO_INDISPONIVEL

    def __init__(self, mensagem: str, motivo: str = "") -> None:
        super().__init__(mensagem)
        if motivo:
            self.motivo = motivo


class SessaoExpirada(SoftExpertErro):
    """O SoftExpert voltou para a tela de login no meio da leitura (pendência, nunca "concluído")."""

    motivo = "sessao_expirada"


class ChamadoNaoConfere(SoftExpertErro):
    """Número ou título do formulário aberto não corresponde ao chamado escolhido na lista."""


class ChamadoNaoEncontrado(SoftExpertErro):
    motivo = MOTIVO_NAO_ENCONTRADO


@dataclass(frozen=True)
class ItemLista:
    """Uma linha da central de tarefas; ``texto`` é o texto bruto da linha (dado não confiável)."""

    numero: str
    texto: str


# ---------------------------------------------------------------------------------------------
# Utilidades de espera, leitura e clique
# ---------------------------------------------------------------------------------------------

def _esperar(pagina: "Page", condicao: Callable[[], Any], timeout_ms: int, intervalo_ms: int | None = None) -> Any:
    """Repete ``condicao`` até devolver algo verdadeiro (devolvido) ou esgotar o prazo (``None``).

    Usa ``wait_for_timeout`` para o Playwright seguir tratando eventos (janelas novas, diálogos) e confere o
    cancelamento a cada volta. Erros do Playwright (página em navegação) contam como "ainda não"; os
    ``SoftExpertErro`` da condição sobem.
    """
    intervalo = INTERVALO_MS if intervalo_ms is None else intervalo_ms
    limite = time.time() + timeout_ms / 1000
    while True:
        _cancelamento()
        try:
            resultado = condicao()
        except SoftExpertErro:
            raise
        except Exception:
            resultado = None
        if resultado:
            return resultado
        if time.time() >= limite:
            return None
        pagina.wait_for_timeout(intervalo)


def _sem_acentos(texto: str) -> str:
    decomposto = unicodedata.normalize("NFKD", texto or "")
    return " ".join("".join(c for c in decomposto if not unicodedata.combining(c)).lower().split())


def _visivel(locator: "Locator") -> bool:
    return bool(_rotinas().visivel(locator))


def tela_de_login(page: "Page") -> bool:
    """Tela de login do SoftExpert/SSO: campo de senha visível ou URL de autenticação."""
    if page.is_closed():
        return False
    url = page.url.lower()
    if any(trecho in url for trecho in TRECHOS_URL_LOGIN):
        return True
    return any(_visivel(frame.locator(SEL_CAMPO_SENHA)) for frame in page.frames)


def softexpert_logado(page: "Page") -> bool:
    """Central de tarefas aberta no host do SoftExpert, fora de qualquer tela de login."""
    if page.is_closed():
        return False
    esperado = urlparse(SOFTEXPERT_URL).hostname or ""
    if (urlparse(page.url).hostname or "") != esperado or tela_de_login(page):
        return False
    return _visivel(page.locator(SEL_LISTA))


def clicar(locator: "Locator", descricao: str) -> None:
    """Clica em um botão/item de menu, recusando rótulos de ação de escrita (finalizar, enviar, reatribuir…)."""
    primeiro = locator.first
    rotulo = " ".join(
        parte for parte in (primeiro.inner_text(timeout=5000), primeiro.get_attribute("aria-label") or "") if parte
    ).strip()
    if ROTULOS_PROIBIDOS.search(rotulo):
        raise SoftExpertErro(f"{descricao}: recusado o clique em {rotulo!r}; a rotina só lê o SoftExpert.")
    primeiro.click(timeout=15_000)


def _aguardar_sem_carregamento(page: "Page", timeout_ms: int) -> None:
    _esperar(page, lambda: not any(_visivel(f.locator(SEL_CARREGANDO)) for f in page.frames), timeout_ms)


# ---------------------------------------------------------------------------------------------
# Login e lista
# ---------------------------------------------------------------------------------------------

def _entrar_com_sso(page: "Page") -> bool:
    """Aciona uma vez o SSO visível na tela de login do SoftExpert; nunca informa credenciais."""
    host_esperado = (urlparse(SOFTEXPERT_URL).hostname or "").lower()
    if page.is_closed() or (urlparse(page.url).hostname or "").lower() != host_esperado or not tela_de_login(page):
        return False

    for frame in page.frames:
        candidatos = (
            frame.get_by_role("button", name=NOME_SSO),
            frame.get_by_role("link", name=NOME_SSO),
            frame.get_by_text("SSO", exact=True),
        )
        for candidato in candidatos:
            try:
                if candidato.count() != 1 or not _visivel(candidato):
                    continue
            except Exception:
                continue
            try:
                clicar(candidato, "entrar com SSO")
            except Exception as erro:
                # The shared login waiter gives the user the manual fallback; do not click twice.
                _rotinas().log(ORIGEM, f"Não foi possível acionar o SSO ({type(erro).__name__}); aguardando login manual.")
            return True
    return False


def garantir_login(page: "Page", *, permitir_sso: bool = False) -> None:
    """Aguarda login manual ou, na retomada autorizada, tenta uma vez o SSO do SoftExpert."""
    _rotinas().aguardar_login(page, ORIGEM, softexpert_logado, entrar=_entrar_com_sso if permitir_sso else None)


def abrir_softexpert(context: "BrowserContext") -> "Page":
    """Abre a central de tarefas em aba nova e devolve a aba já logada."""
    page = _rotinas().nova_aba(context, SOFTEXPERT_URL, ORIGEM)
    try:
        garantir_login(page)
        _aguardar_lista(page)
    except Exception:
        _rotinas().registrar_erro(page, ORIGEM)
        raise
    return page


def _aguardar_lista(page: "Page") -> None:
    """Lista visível e sem indicador de carregamento; se a sessão caiu, é ``SessaoExpirada``."""
    lista = page.locator(SEL_LISTA)

    def pronta() -> bool:
        return tela_de_login(page) or (_visivel(lista) and not _visivel(page.locator(SEL_CARREGANDO)))

    if not _esperar(page, pronta, ESPERA_LISTA_MS):
        raise SoftExpertErro(f"A central de tarefas não carregou em {ESPERA_LISTA_MS // 1000} s.")
    if tela_de_login(page):
        raise SessaoExpirada("O SoftExpert voltou para a tela de login ao abrir a central de tarefas.")


def _textos_linhas(page: "Page") -> List[str]:
    return [texto.strip() for texto in page.locator(SEL_LINHA).filter(visible=True).all_inner_texts() if texto.strip()]


def _botao_proxima(page: "Page") -> Optional["Locator"]:
    for papel in ("button", "link"):
        candidato = page.get_by_role(papel, name=NOME_PROXIMA).filter(visible=True)  # type: ignore[arg-type]
        if candidato.count():
            return candidato.first
    return None


def _proxima_disponivel(botao: "Locator") -> bool:
    try:
        return botao.is_enabled() and botao.get_attribute("aria-disabled") != "true"
    except Exception:
        return False


def _ler_pagina(page: "Page", itens: Dict[str, ItemLista]) -> int:
    """Acrescenta as linhas visíveis; usa o primeiro número da linha (o identificador) e devolve os novos."""
    novos = 0
    for texto in _textos_linhas(page):
        numeros = extrair_numeros(texto)
        if numeros and numeros[0] not in itens:
            itens[numeros[0]] = ItemLista(numeros[0], texto)
            novos += 1
    return novos


def listar_chamados(page: "Page", parar_em: str | None = None) -> List[ItemLista]:
    """Percorre TODA a lista da central de tarefas (paginação ou rolagem) e devolve os chamados em ordem.

    Com ``parar_em``, pára assim que esse número aparece, deixando a lista posicionada nele.
    Uma lista que não termina em ``MAX_RODADAS_LISTA`` voltas é falha, nunca resultado parcial.
    """
    _aguardar_lista(page)
    itens: Dict[str, ItemLista] = {}
    sem_novidade = 0
    for _ in range(MAX_RODADAS_LISTA):
        _cancelamento()
        novos = _ler_pagina(page, itens)
        if parar_em is not None and parar_em in itens:
            return list(itens.values())
        botao = _botao_proxima(page)
        if botao is not None:  # paginação: avança até o botão ficar desabilitado
            if not _proxima_disponivel(botao):
                break
            antes = _textos_linhas(page)
            clicar(botao, "Próxima página")
            if not _esperar(page, lambda: _textos_linhas(page) != antes, ESPERA_PAGINA_MS):
                raise SoftExpertErro("A lista não mudou depois de pedir a próxima página.")
            _aguardar_sem_carregamento(page, ESPERA_PAGINA_MS)
            continue
        # Rolagem: só termina depois de algumas voltas sem número novo.
        sem_novidade = 0 if novos else sem_novidade + 1
        if sem_novidade >= RODADAS_SEM_NOVIDADE:
            break
        antes = _textos_linhas(page)
        # A lista carrega mais linhas ~3 s depois de rolar, mesmo quando o scrollTop não mudou.
        page.evaluate(ROLAR_LISTA_JS, SEL_LISTA)
        _esperar(page, lambda: _textos_linhas(page) != antes, ESPERA_ROLAGEM_MS)
    else:
        raise SoftExpertErro("A lista da central de tarefas não terminou; o resultado seria parcial.")
    if not itens and not _lista_declarada_vazia(page) and not _textos_linhas(page):
        raise SoftExpertErro("A central de tarefas não mostrou nenhuma linha nem o aviso de lista vazia.")
    return list(itens.values())


def _lista_declarada_vazia(page: "Page") -> bool:
    return _visivel(page.locator(SEL_LISTA_VAZIA)) or _visivel(page.get_by_text(TEXTO_LISTA_VAZIA))


def coletar_numeros(page: "Page") -> List[str]:
    """Só os números ``UTIC-AAAA-N`` da lista completa, na ordem em que aparecem."""
    numeros = [item.numero for item in listar_chamados(page)]
    _log(f"Lista da central de tarefas: {len(numeros)} chamado(s).")
    return numeros


# ---------------------------------------------------------------------------------------------
# Formulário do chamado
# ---------------------------------------------------------------------------------------------

def titulo_confere(titulo_formulario: str, texto_linha: str) -> bool:
    """O título do formulário aparece na linha da lista (a lista pode abreviá-lo com reticências)."""
    titulo = _sem_acentos(titulo_formulario)
    if not titulo:
        return False
    linha = _sem_acentos(texto_linha)
    if titulo in linha:
        return True
    for trecho in re.split(r"[\t\n|]+", texto_linha):
        parte = _sem_acentos(trecho).rstrip(".… ").strip()
        if len(parte) >= 8 and titulo.startswith(parte):
            return True
    return False


def _frames(page: "Page") -> List["Frame"]:
    return [] if page.is_closed() else list(page.frames)


def campos_do_registro(controles: List[Mapping[str, Any]]) -> Dict[str, str]:
    """Número, título, solicitante e descrição a partir dos controles (rótulo, valor) do Registro de Chamados."""
    campos = {"numero": "", "titulo": "", "solicitante": "", "descricao": ""}
    for controle in controles:
        rotulo = _sem_acentos(str(controle.get("rotulo") or "")).rstrip(" *:")
        valor = str(controle.get("valor") or "").strip()
        if not valor or not controle.get("leitura"):
            continue  # nunca lê campo editável (rascunho da atividade atual)
        if "do chamado" in rotulo and rotulo[:1] == "n" and "titulo" not in rotulo:
            chave = "numero"
        elif rotulo.startswith("titulo"):
            chave = "titulo"
        elif rotulo == "solicitante":
            chave = "solicitante"
        elif controle.get("tag") == "TEXTAREA":
            chave = "descricao"
        else:
            continue
        campos[chave] = campos[chave] or valor
    return campos


def detalhes_concluidos(controles: List[Mapping[str, Any]]) -> str:
    """Texto do atendimento já concluído: textarea somente leitura cujo rótulo não tem ``*`` (o editável tem)."""
    alvo = _sem_acentos(ROTULOS_CAMPOS["detalhes_atendimento_realizado"][0])
    for controle in controles:
        rotulo = _sem_acentos(str(controle.get("rotulo") or ""))
        if controle.get("tag") == "TEXTAREA" and controle.get("leitura") and rotulo == alvo and controle.get("valor"):
            return str(controle["valor"]).strip()
    return ""


def habilitada_da_lista(texto: str, hoje: Optional[date] = None) -> str:
    """``Habilitada em`` do cartão da lista; ``Hoje``/``Ontem`` viram a data. Vazio se não achar."""
    achado = re.search(r"Habilitada em\s*(Hoje|Ontem|\d{2}/\d{2}/\d{4})\s*,?\s*(\d{2}:\d{2}(?::\d{2})?)", texto or "", re.IGNORECASE)
    if not achado:
        return ""
    dia, hora = achado.groups()
    if dia.lower() in ("hoje", "ontem"):
        dia = ((hoje or date.today()) - timedelta(days=int(dia.lower() == "ontem"))).strftime("%d/%m/%Y")
    return f"{dia}, {hora}"


def _controles_por_frame(page: "Page") -> List[List[Dict[str, Any]]]:
    por_frame: List[List[Dict[str, Any]]] = []
    for frame in _frames(page):
        try:
            por_frame.append(frame.evaluate(LER_CONTROLES_JS))
        except Exception:
            continue  # frame em navegação
    return por_frame


def _controles(page: "Page") -> List[Dict[str, Any]]:
    return [controle for controles in _controles_por_frame(page) for controle in controles]


def _registro(page: "Page") -> Dict[str, str]:
    """Campos do Registro de Chamados: só do frame que tem o "N° do chamado" (outros frames têm outros textareas)."""
    for controles in _controles_por_frame(page):
        campos = campos_do_registro(controles)
        if campos["numero"]:
            return campos
    return {"numero": "", "titulo": "", "solicitante": "", "descricao": ""}


def _janela_de_execucao(page: "Page") -> bool:
    return any(TRECHO_URL_FORMULARIO in frame.url for frame in _frames(page))


def _abrir_aba_registro(formulario: "Page") -> None:
    """Interface atual: o Registro de Chamados é uma aba da janela; seleciona-a (só leitura) se ainda não carregou."""
    if "wf_gen_instance" not in formulario.url:
        return  # janela da interface antiga: o registro já vem aberto
    def numero_lido() -> str:
        return _registro(formulario)["numero"]

    _esperar(formulario, lambda: _janela_de_execucao(formulario), ESPERA_ABERTURA_MS)
    if numero_lido():
        return
    aba = formulario.get_by_text(NOME_REGISTRO).filter(visible=True)
    if _esperar(formulario, lambda: aba.count() == 1, ESPERA_ABERTURA_MS):
        clicar(aba, "aba Registro de Chamados")
        _esperar(formulario, numero_lido, ESPERA_ABERTURA_MS)
        _aguardar_estavel(formulario)


def _ler_campo(page: "Page", chave: str) -> str:
    for frame in _frames(page):
        try:
            valor = frame.evaluate(LER_CAMPO_JS, list(ROTULOS_CAMPOS[chave]))
        except Exception:
            continue  # frame em navegação
        if valor and str(valor).strip():
            return str(valor).strip()
    if chave in ("numero", "titulo", "solicitante", "descricao"):
        return _registro(page)[chave]
    return ""


def _ler_detalhes_atendimento_visiveis(page: "Page") -> str:
    concluido = detalhes_concluidos(_controles(page))
    if concluido:
        return concluido
    for frame in _frames(page):
        try:
            valor = frame.evaluate(LER_DETALHES_ATENDIMENTO_JS, list(ROTULOS_CAMPOS["detalhes_atendimento_realizado"]))
        except Exception:
            continue  # frame em navegação
        if valor and str(valor).strip().strip("*").strip():  # "*" sozinho é o asterisco do rótulo, não um valor
            return str(valor).strip()
    return ""


def _ler_detalhes_atendimento(page: "Page", numero: str) -> str:
    """Abre a seção somente leitura de Atendimento TI e lê seus detalhes."""
    valor = _esperar(page, lambda: _ler_detalhes_atendimento_visiveis(page), ESPERA_ESTAVEL_MS)
    if valor:
        return str(valor)

    for frame in _frames(page):
        candidatos = (
            frame.get_by_role("tab", name=NOME_ATENDIMENTO_TI),
            frame.get_by_role("link", name=NOME_ATENDIMENTO_TI),
            frame.get_by_role("button", name=NOME_ATENDIMENTO_TI),
            frame.get_by_text(NOME_ATENDIMENTO_TI, exact=True),
        )
        for candidato in candidatos:
            try:
                visiveis = candidato.filter(visible=True)
                if visiveis.count() != 1:
                    continue
                clicar(visiveis, "Atendimento - Chamados TI")
                _aguardar_estavel(page)
                return str(_esperar(page, lambda: _ler_detalhes_atendimento_visiveis(page), ESPERA_ESTAVEL_MS) or "")
            except SoftExpertErro:
                raise
            except Exception:
                continue

    raise SoftExpertErro(
        f"{numero}: a seção Atendimento - Chamados TI não ficou disponível para consultar os detalhes."
    )


def _formulario_visivel(page: "Page") -> bool:
    return any(_visivel(frame.locator(SEL_FORMULARIO)) for frame in _frames(page)) or _janela_de_execucao(page)


def _aguardar_estavel(page: "Page") -> None:
    """Espera o texto do formulário parar de mudar (campos condicionais costumam surgir depois)."""
    def assinatura() -> int:
        total = 0
        for frame in _frames(page):
            try:
                total += len(frame.evaluate("() => document.body ? document.body.innerText : ''"))
            except Exception:
                pass
        return total

    _aguardar_sem_carregamento(page, ESPERA_ESTAVEL_MS)
    anterior = -1
    for _ in range(max(1, ESPERA_ESTAVEL_MS // 300)):
        atual = assinatura()
        if atual == anterior:
            return
        anterior = atual
        page.wait_for_timeout(300)


def _responder_confirmacao(alvos: List["Page"], respondidas: List[float]) -> bool:
    """Responde Sim à pergunta de associar o chamado ao usuário, se ela estiver na tela.

    Uma pergunta com outro texto não é respondida: a rotina pára. Devolve True se clicou.
    """
    for alvo in alvos:
        for frame in _frames(alvo):
            for dialogo in frame.locator(SEL_DIALOGO).filter(visible=True).all():
                sim = dialogo.get_by_role("button", name=NOME_SIM).filter(visible=True)
                if not sim.count():
                    continue
                texto = dialogo.inner_text(timeout=5000)
                if not TEXTO_CONFIRMACAO.search(texto):
                    raise SoftExpertErro(
                        "Apareceu uma confirmação que não é a de associar o chamado ao usuário; nada foi clicado.",
                        MOTIVO_CONFIRMACAO_INESPERADA,
                    )
                if respondidas:
                    # O diálogo ainda pode estar fechando logo depois do Sim; só é erro se persistir ou voltar.
                    if time.time() - respondidas[0] < GRACA_CONFIRMACAO_S:
                        return False
                    raise SoftExpertErro(
                        "A confirmação de associar o chamado voltou depois do Sim; nada foi clicado de novo.",
                        MOTIVO_CONFIRMACAO_INESPERADA,
                    )
                clicar(sim, "Confirmação de associar o chamado")
                respondidas.append(time.time())
                _log("Confirmação de associar o chamado ao usuário: Sim.")
                return True
    return False


def _tratar_dialogo_nativo(respondidas: List[float]) -> Callable[[Any], None]:
    """``window.confirm`` do SoftExpert: aceita só a pergunta de associar; qualquer outra é recusada."""
    def tratar(dialogo: Any) -> None:
        try:
            if dialogo.type == "confirm" and TEXTO_CONFIRMACAO.search(dialogo.message or "") and not respondidas:
                respondidas.append(time.time())
                _log("Confirmação de associar o chamado ao usuário: Sim.")
                dialogo.accept()
            else:
                dialogo.dismiss()
        except Exception:
            pass

    return tratar


def _clicar_icone_executar(page: "Page", linha: "Locator", numero: str) -> None:
    """Clica no ✓ do cartão, mas só depois de a dica mostrar "Executar" (o ícone não tem texto nem nome)."""
    linha.hover()
    botao = linha.locator(SEL_GRUPO_ACOES).first.locator("button").first
    botao.hover()
    dica = page.get_by_text(NOME_EXECUTAR).filter(visible=True)
    if not _esperar(page, lambda: dica.count(), ESPERA_BOTAO_MS):
        raise SoftExpertErro(f"{numero}: o ícone da linha não mostrou a dica Executar; nada foi clicado.")
    clicar(botao, "Executar")


def _abrir_formulario(context: "BrowserContext", page: "Page", linha: "Locator", numero: str) -> "Page":
    """Executar > Registro de Chamados; devolve a janela (PHP) ou a própria aba que mostra o formulário pronto."""
    novas: List["Page"] = []
    respondidas: List[float] = []
    tratar = _tratar_dialogo_nativo(respondidas)

    def nova_janela(janela: "Page") -> None:
        novas.append(janela)
        janela.on("dialog", tratar)

    context.on("page", nova_janela)
    page.on("dialog", tratar)
    try:
        if linha.locator(SEL_GRUPO_ACOES).count():
            _clicar_icone_executar(page, linha, numero)  # interface atual: o ✓ já abre o formulário
        else:
            linha.click(timeout=15_000)
            executar = page.get_by_role("button", name=NOME_EXECUTAR).filter(visible=True)
            if not _esperar(page, lambda: executar.count() and executar.first.is_enabled(), ESPERA_ABERTURA_MS):
                raise SoftExpertErro(f"{numero}: o botão Executar não ficou disponível depois de selecionar a linha.")
            clicar(executar, "Executar")
            item = page.get_by_role("menuitem", name=NOME_REGISTRO).or_(page.get_by_text(NOME_REGISTRO)).filter(visible=True)
            if not _esperar(page, lambda: item.count(), ESPERA_ABERTURA_MS):
                raise SoftExpertErro(f"{numero}: o item Registro de Chamados não apareceu no menu Executar.")
            clicar(item, "Registro de Chamados")

        def formulario() -> Optional["Page"]:
            candidatos = [janela for janela in novas if not janela.is_closed()] + [page]
            for candidato in candidatos:
                if tela_de_login(candidato):
                    raise SessaoExpirada(f"{numero}: o SoftExpert pediu o login ao abrir o Registro de Chamados.")
            if _responder_confirmacao(candidatos, respondidas):
                return None
            for candidato in candidatos:
                lista_na_tela = candidato is page and _visivel(page.locator(SEL_LISTA))
                if not lista_na_tela and _formulario_visivel(candidato):
                    return candidato
            return None

        resultado = _esperar(page, formulario, ESPERA_ABERTURA_MS)
        if resultado is None:
            raise SoftExpertErro(
                f"{numero}: o formulário do Registro de Chamados não abriu em {ESPERA_ABERTURA_MS // 1000} s.",
                MOTIVO_FORMULARIO_INDISPONIVEL,
            )
        return resultado  # type: ignore[no-any-return]
    except BaseException:
        # Falha ou cancelamento antes do formulário: não deixa a janela PHP aberta.
        for janela in novas:
            try:
                if not janela.is_closed():
                    janela.close()
            except Exception:
                pass
        raise
    finally:
        context.remove_listener("page", nova_janela)
        page.remove_listener("dialog", tratar)
        for janela in novas:
            try:
                janela.remove_listener("dialog", tratar)
            except Exception:
                pass


def _fechar_formulario(context: "BrowserContext", page: "Page", formulario: Optional["Page"]) -> None:
    """Fecha só a janela PHP aberta pela rotina; no modo mesma aba, volta para a lista."""
    if formulario is None:
        return
    try:
        if formulario is not page:
            if not formulario.is_closed():
                formulario.close()
        else:
            page.goto(SOFTEXPERT_URL, wait_until="domcontentloaded", timeout=_rotinas().CARREGAMENTO_MS)
            _aguardar_lista(page)
    except Exception as erro:
        _log(f"Aviso: não foi possível fechar o formulário do chamado ({type(erro).__name__}).")


def _conferir(formulario: "Page", numero: str, texto_linha: str) -> str:
    """Confere número e título do formulário aberto com os da lista; devolve o título lido."""
    lido = _ler_campo(formulario, "numero")
    if extrair_numeros(lido)[:1] != [numero]:
        raise ChamadoNaoConfere(
            f"{numero}: o formulário aberto é de outro chamado ({extrair_numeros(lido) or 'sem número'}).",
            MOTIVO_NUMERO_NAO_CONFERE,
        )
    titulo = _ler_campo(formulario, "titulo")
    if not titulo_confere(titulo, texto_linha):
        raise ChamadoNaoConfere(
            f"{numero}: o título do formulário não corresponde ao da lista.", MOTIVO_TITULO_NAO_CONFERE
        )
    return titulo


def _extrair_uma_vez(context: "BrowserContext", page: "Page", numero: str) -> ChamadoSoftExpert:
    _log(f"{numero}: abrindo o chamado.")
    page.goto(SOFTEXPERT_URL, wait_until="domcontentloaded", timeout=_rotinas().CARREGAMENTO_MS)
    _aguardar_lista(page)
    encontrados = listar_chamados(page, parar_em=numero)
    item = next((i for i in encontrados if i.numero == numero), None)
    if item is None:
        raise ChamadoNaoEncontrado(f"{numero}: não está na lista da central de tarefas.")
    # Sem âncora à esquerda: o texto bruto do cartão cola o título ao rótulo anterior ("atividadeUTIC-…").
    padrao = re.compile(rf"{re.escape(numero)}(?!\d)", re.IGNORECASE)
    linha = page.locator(SEL_LINHA).filter(visible=True).filter(has_text=padrao).first
    formulario: Optional["Page"] = None
    try:
        formulario = _abrir_formulario(context, page, linha, numero)
        _aguardar_estavel(formulario)
        _abrir_aba_registro(formulario)
        titulo = _conferir(formulario, numero, item.texto)
        campos = {chave: _ler_campo(formulario, chave) for chave in ("descricao", "solicitante", "habilitada_em")}
        # Na interface atual o "Habilitada em" não está no formulário: vem do cartão da lista.
        campos["habilitada_em"] = campos["habilitada_em"] or habilitada_da_lista(item.texto)
        for tentativa in range(1, RELEITURAS_CAMPOS + 1):
            if all(campos.values()):
                break
            formulario.wait_for_timeout(ESPERA_RELEITURA_MS)
            _aguardar_estavel(formulario)
            _log(f"{numero}: relendo campos vazios ({tentativa}/{RELEITURAS_CAMPOS}).")
            campos = {chave: _ler_campo(formulario, chave) or campos[chave] for chave in campos}
            # Depois de uma releitura o título/número ainda precisam ser os do chamado escolhido.
            _conferir(formulario, numero, item.texto)
        _log(f"{numero}: consultando Atendimento - Chamados TI para ler os detalhes concluídos.")
        detalhes_atendimento = _ler_detalhes_atendimento(formulario, numero)
        return ChamadoSoftExpert(
            numero=chave_do_numero(numero),
            titulo=titulo,
            descricao=campos["descricao"],
            solicitante=campos["solicitante"],
            habilitada_em=campos["habilitada_em"],
            detalhes_atendimento_realizado=detalhes_atendimento,
        )
    finally:
        _fechar_formulario(context, page, formulario)


def extrair_chamado(context: "BrowserContext", page: "Page", numero: str) -> ChamadoSoftExpert:
    """Lê um chamado: Executar > Registro de Chamados, janela PHP, confirmação, conferência e campos.

    ``page`` é a aba da central de tarefas. Levanta ``ChamadoNaoConfere``, ``ChamadoNaoEncontrado``,
    ``SessaoExpirada`` ou ``SoftExpertErro``; nenhum deles deixa janela PHP aberta.
    """
    numero = chave_do_numero(numero)
    try:
        return _extrair_uma_vez(context, page, numero)
    except SoftExpertErro:
        _rotinas().registrar_erro(page, ORIGEM)
        raise


def extrair_chamados(
    context: "BrowserContext", page: "Page", numeros: List[str]
) -> Dict[str, "ChamadoSoftExpert | SoftExpertErro"]:
    """Lê vários chamados, um de cada vez; a falha de um não impede os seguintes.

    Número que não confere ou ausente vira o próprio erro no resultado (o chamador o registra como
    pendência). Sessão expirada espera o login e tenta o chamado mais uma vez; se cair de novo, sobe.
    O cancelamento é conferido entre dois chamados.
    """
    resultado: Dict[str, "ChamadoSoftExpert | SoftExpertErro"] = {}
    for numero in numeros:
        _cancelamento(f"Cancelado antes de ler {numero}.")
        try:
            try:
                resultado[numero] = extrair_chamado(context, page, numero)
            except SessaoExpirada:
                _log(f"{numero}: sessão expirada; aguardando novo login.")
                page.goto(SOFTEXPERT_URL, wait_until="domcontentloaded", timeout=_rotinas().CARREGAMENTO_MS)
                garantir_login(page, permitir_sso=True)
                resultado[numero] = extrair_chamado(context, page, numero)
        except (ChamadoNaoConfere, ChamadoNaoEncontrado) as erro:
            _log(f"{numero}: {erro}")
            resultado[numero] = erro
    return resultado
