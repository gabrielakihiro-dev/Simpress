"""Orchestration of the "Sincronizar chamados Sebrae" routine (docs/operacao/sincronizar-chamados-sebrae.md).

Pure flow, no browser: the SoftExpert reader and the Dashboard reader/writer are ``Protocol``s, so the
script that drives Chrome only plugs adapters in and the whole decision chain is testable with fakes.

Flow: read column C -> read the SoftExpert list -> ``triagem`` -> per new ticket (cancellation checked
between tickets, never inside a write): extract -> ``decidir`` -> re-read column C -> write -> confirm ->
final re-read of column C -> ``ResumoExecucao`` -> atomic state file -> notification only when it changes.

Rules this module enforces on top of ``domains.sebrae_chamados``:
- a number already in column C is ignored whole, also when it appears while the run is going (concurrent edit);
- only the nine columns of ``COLUNAS_GRAVADAS`` are ever handed to the writer, and only for ``incluir``;
- a ticket counts as included only when the writer confirms all nine cells and the save;
- a partial failure (login, cancellation, error) keeps the counts of what was already confirmed;
- ticket content is data: it is never logged here, and failure texts carry only a stage and an exception type.
"""

from __future__ import annotations

import json
import logging
from collections import Counter
from dataclasses import dataclass, field, replace
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Protocol, Tuple

from core.integrity import atomic_write_json
from domains.sebrae_agendamento import FUSO
from domains.sebrae_chamados import (
    ACAO_INCLUIR,
    COLUNAS_GRAVADAS,
    ChamadoSoftExpert,
    ResumoExecucao,
    decidir,
    deve_avisar,
    extrair_numeros,
    impressao_digital,
    triagem,
)

logger = logging.getLogger(__name__)

SITUACAO_CONCLUIDA = "concluida"
SITUACAO_CANCELADA = "cancelada"
SITUACAO_LOGIN = "login_necessario"
SITUACAO_FALHA = "falha"
SITUACAO_INTERROMPIDA = "interrompida"

RESULTADO_INCLUIDO = "incluido"
RESULTADO_IGNORADO = "ignorado"
RESULTADO_PENDENTE = "pendente"

MOTIVO_FALHA_LEITURA = "falha_ao_ler_chamado"
MOTIVO_CONFIRMACAO_INESPERADA = "confirmacao_inesperada"
MOTIVO_GRAVACAO_PARCIAL = "gravacao_parcial"
MOTIVO_GRAVACAO_NAO_CONFIRMADA = "gravacao_nao_confirmada"
MOTIVO_AUSENTE_NA_RELEITURA = "ausente_na_releitura_final"
MOTIVO_LINHA_INVALIDA = "linha_com_colunas_inesperadas"

FALHA_DASHBOARD = "falha_leitura_dashboard"
FALHA_DASHBOARD_VAZIO = "dashboard_sem_numeros_na_coluna_c"
FALHA_SOFTEXPERT = "falha_leitura_softexpert"
FALHA_GRAVACAO = "falha_gravacao"
FALHA_LEITURAS_SEGUIDAS = "falhas_seguidas_na_leitura_dos_chamados"
FALHA_DUPLICIDADE = "duplicidade_apos_gravacao"
FALHA_RELEITURA_FINAL = "releitura_final_falhou"

# Consecutive unreadable tickets before the run stops: a dead browser would otherwise burn every timeout.
MAX_FALHAS_SEGUIDAS = 3
TITULO_AVISO = "Simpress: chamados Sebrae"
LIMITE_PENDENCIAS_NO_AVISO = 3


# ---------------------------------------------------------------------------- adapter contracts

class LoginNecessarioErro(Exception):
    """The session of ``sistema`` is gone and the user has to sign in again; nothing is "concluded" then."""

    def __init__(self, sistema: str = "") -> None:
        super().__init__(sistema)
        self.sistema = sistema


class ChamadoIndisponivelErro(Exception):
    """One ticket could not be read for a known reason (``motivo``); it becomes pending and the run goes on."""

    def __init__(self, motivo: str) -> None:
        super().__init__(motivo)
        self.motivo = motivo


class CancelamentoSolicitado(BaseException):
    """Cancellation request; a ``BaseException`` so a broad ``except Exception`` never swallows it."""


@dataclass(frozen=True)
class ResultadoGravacao:
    """What the writer confirmed after re-reading the row: columns whose value matched, and the save."""

    numero: str
    confirmados: Tuple[str, ...]
    salvo: bool
    erro: str = ""
    # Not written because the ticket already sits in the Dashboard (someone else added it): counted as ignored.
    duplicado: bool = False
    # Not written and nothing left in the Dashboard (e.g. invalid row): the ticket stays pending, the run goes on.
    motivo_pendente: str = ""

    @property
    def completo(self) -> bool:
        return self.salvo and set(COLUNAS_GRAVADAS) <= set(self.confirmados)


class LeitorSoftExpert(Protocol):
    def listar_numeros(self) -> Iterable[str]:
        """Every ticket number in the SoftExpert task list (all pages)."""
        ...

    def ler_chamado(self, numero: str) -> ChamadoSoftExpert:
        """Opens one ticket and reads the form; raises ``LoginNecessarioErro`` when the session expired."""
        ...


class DashboardSebrae(Protocol):
    def ler_coluna_c(self) -> Iterable[Any]:
        """Every value of column C of the whole data area, hidden rows included."""
        ...

    def gravar_linha(self, linha: Mapping[str, str]) -> ResultadoGravacao:
        """Writes the nine cells on a free prepared row, re-reads them, confirms the save. Never overwrites."""
        ...


@dataclass(frozen=True)
class ResultadoOrquestracao:
    situacao: str
    resumo: ResumoExecucao
    detalhes: Tuple[Mapping[str, Any], ...]
    avisar: bool
    aviso: Optional[Tuple[str, str]]
    login_sistema: str = ""

    @property
    def codigo_saida(self) -> int:
        return 0 if self.situacao == SITUACAO_CONCLUIDA else 1


# ---------------------------------------------------------------------------- state file

def estado_vazio() -> Dict[str, Any]:
    return {"ultima_execucao": None, "pendencias": {}, "login_necessario": False, "ultimo_aviso": ""}


def ler_estado(caminho: Path) -> Dict[str, Any]:
    """The persisted state; a missing or corrupt file reads as the empty state."""
    try:
        dados = json.loads(caminho.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        return estado_vazio()
    if not isinstance(dados, dict):
        return estado_vazio()
    estado = estado_vazio()
    pendencias = dados.get("pendencias")
    if isinstance(pendencias, dict):
        estado["pendencias"] = {str(numero): str(motivo) for numero, motivo in pendencias.items()}
    if isinstance(dados.get("ultima_execucao"), dict):
        estado["ultima_execucao"] = dados["ultima_execucao"]
    estado["login_necessario"] = bool(dados.get("login_necessario"))
    estado["ultimo_aviso"] = str(dados.get("ultimo_aviso") or "")
    if dados.get("login_sistema"):
        estado["login_sistema"] = str(dados["login_sistema"])
    return estado


def gravar_estado(caminho: Path, estado: Mapping[str, Any]) -> None:
    caminho.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(caminho, dict(estado))


# ---------------------------------------------------------------------------- helpers

def _iso(valor: datetime) -> str:
    return valor.astimezone(FUSO).isoformat(timespec="seconds")


def _contagem(valores: Iterable[Any]) -> Counter[str]:
    """How many times each ticket number appears in column C."""
    contagem: Counter[str] = Counter()
    for valor in valores:
        for numero in extrair_numeros(valor):
            contagem[numero] += 1
    return contagem


def _falha(etapa: str, erro: BaseException) -> str:
    """Stable failure code: stage plus exception type, never the message (it may carry page content)."""
    return f"{etapa}: {type(erro).__name__}"


def _sem_aviso_de_inclusao(resumo: ResumoExecucao) -> ResumoExecucao:
    return replace(resumo, incluidos=0)


class _Parar(Exception):
    """Internal: ends the loop after the situation was recorded."""


@dataclass
class _Execucao:
    """Mutable counters of one run; turned into the immutable summary at the end."""

    existentes: frozenset[str] = frozenset()
    incluidos: List[str] = field(default_factory=list)
    ignorados: List[str] = field(default_factory=list)
    pendencias: Dict[str, str] = field(default_factory=dict)
    detalhes: List[Dict[str, Any]] = field(default_factory=list)
    tentados: List[str] = field(default_factory=list)  # a write was started: the row may exist
    situacao: str = SITUACAO_CONCLUIDA
    falha: str = ""
    login_sistema: str = ""

    def detalhe(self, numero: str, resultado: str, motivo: str = "", **extra: Any) -> None:
        item: Dict[str, Any] = {"numero": numero, "resultado": resultado}
        if motivo:
            item["motivo"] = motivo
        item.update(extra)
        self.detalhes.append(item)

    def pendente(self, numero: str, motivo: str, **extra: Any) -> None:
        self.pendencias[numero] = motivo
        self.detalhe(numero, RESULTADO_PENDENTE, motivo, **extra)


# ---------------------------------------------------------------------------- the routine

def sincronizar(
    softexpert: LeitorSoftExpert,
    dashboard: DashboardSebrae,
    caminho_estado: Path,
    *,
    cancelado: Callable[[], bool] = lambda: False,
    agora: Callable[[], datetime] = lambda: datetime.now(FUSO),
    log: Callable[[str], None] = lambda texto: None,
    permitir_dashboard_vazio: bool = False,
) -> ResultadoOrquestracao:
    """Runs one synchronization, persists the state and decides whether to notify.

    Expected problems (login, cancellation, an adapter error) never raise: they become the situation of
    the result, with the counts reached so far. Only a ``BaseException`` such as Ctrl+C propagates, after
    the state of the interrupted run is written.
    """
    inicio = agora()
    anterior = ler_estado(caminho_estado)
    execucao = _Execucao()
    try:
        _fluxo(softexpert, dashboard, execucao, cancelado, log, permitir_dashboard_vazio)
    except _Parar:
        pass
    except CancelamentoSolicitado:
        execucao.situacao = SITUACAO_CANCELADA
    except LoginNecessarioErro as erro:
        execucao.situacao = SITUACAO_LOGIN
        execucao.login_sistema = erro.sistema
    except Exception as erro:  # an unexpected adapter error ends the run but keeps the counts
        execucao.situacao = SITUACAO_FALHA
        execucao.falha = execucao.falha or _falha("falha_inesperada", erro)
        logger.warning("A sincronização Sebrae terminou com erro inesperado (%s).", type(erro).__name__)
    except BaseException:
        execucao.situacao = SITUACAO_INTERROMPIDA
        _persistir(caminho_estado, anterior, execucao, inicio, agora(), None)
        raise
    if execucao.tentados and execucao.situacao != SITUACAO_LOGIN:
        # Final confirmation of what this run wrote, also after a stop, while the browser still answers.
        try:
            _releitura_final(dashboard, execucao, log)
        except LoginNecessarioErro as erro:
            execucao.detalhe("", RESULTADO_PENDENTE, FALHA_RELEITURA_FINAL, erro="LoginNecessarioErro")
            if execucao.situacao == SITUACAO_CONCLUIDA:
                execucao.situacao, execucao.login_sistema = SITUACAO_LOGIN, erro.sistema
    return _persistir(caminho_estado, anterior, execucao, inicio, agora(), log)


def _fluxo(
    softexpert: LeitorSoftExpert,
    dashboard: DashboardSebrae,
    execucao: _Execucao,
    cancelado: Callable[[], bool],
    log: Callable[[str], None],
    permitir_dashboard_vazio: bool,
) -> None:
    def verificar_cancelamento() -> None:
        if cancelado():
            raise CancelamentoSolicitado()

    verificar_cancelamento()
    # 1. Dashboard column C
    try:
        contagem_inicial = _contagem(dashboard.ler_coluna_c())
    except (LoginNecessarioErro, CancelamentoSolicitado):
        raise
    except Exception as erro:
        execucao.situacao, execucao.falha = SITUACAO_FALHA, _falha(FALHA_DASHBOARD, erro)
        raise _Parar() from erro
    execucao.existentes = frozenset(contagem_inicial)
    if not execucao.existentes and not permitir_dashboard_vazio:
        # An empty read of a Dashboard that already has tickets would turn every ticket into a duplicate row.
        execucao.situacao, execucao.falha = SITUACAO_FALHA, FALHA_DASHBOARD_VAZIO
        raise _Parar()
    log(f"Dashboard: {len(execucao.existentes)} chamado(s) na coluna C.")

    verificar_cancelamento()
    # 2. SoftExpert list
    try:
        listados = list(softexpert.listar_numeros())
    except (LoginNecessarioErro, CancelamentoSolicitado):
        raise
    except Exception as erro:
        execucao.situacao, execucao.falha = SITUACAO_FALHA, _falha(FALHA_SOFTEXPERT, erro)
        raise _Parar() from erro

    # 3. Triage: duplicates are ignored whole, known pending ones are never opened
    resultado_triagem = triagem(listados, execucao.existentes)
    for numero in resultado_triagem.ignorados:
        execucao.ignorados.append(numero)
        execucao.detalhe(numero, RESULTADO_IGNORADO, "duplicado")
    for numero, motivo in resultado_triagem.pendentes:
        execucao.pendente(numero, motivo)
    log(
        f"SoftExpert: {len(listados)} listado(s); {len(resultado_triagem.ignorados)} já no Dashboard, "
        f"{len(resultado_triagem.pendentes)} pendente(s) conhecido(s), {len(resultado_triagem.a_extrair)} novo(s)."
    )

    # 4. Each new ticket: extract -> decide -> re-read column C -> write -> confirm
    falhas_seguidas = 0
    for numero in resultado_triagem.a_extrair:
        verificar_cancelamento()  # between tickets only: a row write is never interrupted
        try:
            chamado = softexpert.ler_chamado(numero)
        except (LoginNecessarioErro, CancelamentoSolicitado):
            raise
        except ChamadoIndisponivelErro as erro:
            execucao.pendente(numero, erro.motivo)
            log(f"{numero}: pendente ({erro.motivo}).")
            continue
        except Exception as erro:
            motivo = getattr(erro, "motivo", "")
            if motivo == MOTIVO_CONFIRMACAO_INESPERADA:
                execucao.pendente(numero, motivo, erro=type(erro).__name__)
                execucao.situacao, execucao.falha = SITUACAO_FALHA, motivo
                log(f"{numero}: leitura interrompida ({motivo}).")
                raise _Parar() from erro
            falhas_seguidas += 1
            execucao.pendente(numero, MOTIVO_FALHA_LEITURA, erro=type(erro).__name__)
            log(f"{numero}: leitura falhou ({type(erro).__name__}).")
            if falhas_seguidas >= MAX_FALHAS_SEGUIDAS:
                execucao.situacao, execucao.falha = SITUACAO_FALHA, FALHA_LEITURAS_SEGUIDAS
                raise _Parar() from erro
            continue
        falhas_seguidas = 0
        _tratar_chamado(numero, chamado, dashboard, execucao, log)


def _tratar_chamado(
    numero: str,
    chamado: ChamadoSoftExpert,
    dashboard: DashboardSebrae,
    execucao: _Execucao,
    log: Callable[[str], None],
) -> None:
    decisao = decidir(chamado)
    if decisao.numero != numero:
        # The form opened is not the ticket asked for: never write it under another number.
        execucao.pendente(numero, "formulario_de_outro_chamado")
        log(f"{numero}: o formulário aberto é de outro chamado; não gravado.")
        return
    if decisao.acao != ACAO_INCLUIR:
        execucao.pendente(numero, decisao.motivo)
        log(f"{numero}: pendente ({decisao.motivo}).")
        return
    if set(decisao.linha) != set(COLUNAS_GRAVADAS):
        execucao.pendente(numero, MOTIVO_LINHA_INVALIDA)
        return

    # Re-read just before writing: someone may have added the ticket meanwhile (simultaneous edit).
    try:
        atuais = _contagem(dashboard.ler_coluna_c())
    except (LoginNecessarioErro, CancelamentoSolicitado):
        raise
    except Exception as erro:
        execucao.situacao, execucao.falha = SITUACAO_FALHA, _falha(FALHA_DASHBOARD, erro)
        raise _Parar() from erro
    if numero in atuais:
        execucao.ignorados.append(numero)
        execucao.detalhe(numero, RESULTADO_IGNORADO, "duplicado")
        log(f"{numero}: já apareceu no Dashboard; ignorado.")
        return

    execucao.tentados.append(numero)
    try:
        gravacao = dashboard.gravar_linha(dict(decisao.linha))
    except (LoginNecessarioErro, CancelamentoSolicitado):
        # The state of the row is unknown: keep it pending instead of counting or forgetting it.
        execucao.pendente(numero, MOTIVO_GRAVACAO_NAO_CONFIRMADA)
        raise
    except Exception as erro:
        execucao.pendente(numero, MOTIVO_GRAVACAO_NAO_CONFIRMADA, erro=type(erro).__name__)
        execucao.situacao, execucao.falha = SITUACAO_FALHA, _falha(FALHA_GRAVACAO, erro)
        raise _Parar() from erro

    if gravacao.numero != numero:
        execucao.pendente(numero, MOTIVO_GRAVACAO_NAO_CONFIRMADA)
        execucao.situacao, execucao.falha = SITUACAO_FALHA, f"{FALHA_GRAVACAO}: resultado_de_outro_chamado"
        raise _Parar()
    if gravacao.duplicado:
        execucao.ignorados.append(numero)
        execucao.detalhe(numero, RESULTADO_IGNORADO, "duplicado")
        log(f"{numero}: já está no Dashboard; ignorado.")
        return
    if gravacao.motivo_pendente:
        execucao.pendente(numero, gravacao.motivo_pendente)
        log(f"{numero}: pendente ({gravacao.motivo_pendente}).")
        return
    if gravacao.completo:
        execucao.incluidos.append(numero)
        execucao.pendencias.pop(numero, None)
        execucao.detalhe(numero, RESULTADO_INCLUIDO, tipo=decisao.tipo)
        log(f"{numero}: incluído ({decisao.tipo}).")
        return

    # Partial write: record exactly which cells were confirmed, and stop writing.
    confirmados = [coluna for coluna in COLUNAS_GRAVADAS if coluna in gravacao.confirmados]
    faltantes = [coluna for coluna in COLUNAS_GRAVADAS if coluna not in gravacao.confirmados]
    motivo = f"gravacao_{gravacao.erro}" if gravacao.erro else MOTIVO_GRAVACAO_PARCIAL
    execucao.pendente(
        numero,
        motivo,
        campos_confirmados=confirmados,
        campos_pendentes=faltantes,
        salvo=gravacao.salvo,
    )
    execucao.situacao, execucao.falha = SITUACAO_FALHA, f"{FALHA_GRAVACAO}: {motivo}"
    log(f"{numero}: gravação parcial (confirmadas: {', '.join(confirmados) or 'nenhuma'}).")
    raise _Parar()


def _releitura_final(dashboard: DashboardSebrae, execucao: _Execucao, log: Callable[[str], None]) -> None:
    """Confirms in column C what this run wrote. Also runs after an aborted run, when the browser still answers."""
    if not execucao.tentados:
        return
    try:
        contagem = _contagem(dashboard.ler_coluna_c())
    except LoginNecessarioErro:
        raise
    except Exception as erro:
        # Each row was already confirmed cell by cell; keep the counts and say the last check did not run.
        execucao.detalhe("", RESULTADO_PENDENTE, FALHA_RELEITURA_FINAL, erro=type(erro).__name__)
        if execucao.situacao == SITUACAO_CONCLUIDA:
            execucao.situacao, execucao.falha = SITUACAO_FALHA, _falha(FALHA_RELEITURA_FINAL, erro)
        return
    for numero in list(execucao.incluidos):
        vezes = contagem.get(numero, 0)
        if vezes == 0:
            execucao.incluidos.remove(numero)
            execucao.pendente(numero, MOTIVO_AUSENTE_NA_RELEITURA)
            if execucao.situacao == SITUACAO_CONCLUIDA:
                execucao.situacao, execucao.falha = SITUACAO_FALHA, f"{FALHA_GRAVACAO}: {MOTIVO_AUSENTE_NA_RELEITURA}"
        elif vezes > 1:
            execucao.detalhe(numero, RESULTADO_INCLUIDO, "duplicado_no_dashboard", ocorrencias=vezes)
            if execucao.situacao == SITUACAO_CONCLUIDA:
                execucao.situacao, execucao.falha = SITUACAO_FALHA, FALHA_DUPLICIDADE
    for numero in execucao.tentados:
        if numero in execucao.pendencias and numero in contagem:
            # Present in column C although the writer did not confirm it: the user has to look at the row.
            execucao.detalhe(numero, RESULTADO_PENDENTE, "presente_no_dashboard_sem_confirmacao")
    log(f"Releitura final: {len(execucao.incluidos)} incluído(s) confirmado(s) na coluna C.")


# ---------------------------------------------------------------------------- summary, state, notification

def _persistir(
    caminho_estado: Path,
    anterior: Mapping[str, Any],
    execucao: _Execucao,
    inicio: datetime,
    fim: datetime,
    log: Optional[Callable[[str], None]],
) -> ResultadoOrquestracao:
    completa = execucao.situacao == SITUACAO_CONCLUIDA
    pendencias_anteriores: Mapping[str, str] = anterior.get("pendencias") or {}
    if completa:
        pendencias = dict(execucao.pendencias)
    else:
        # An aborted run did not re-evaluate everything: keep the earlier pending items that are still open.
        resolvidos = set(execucao.existentes) | set(execucao.incluidos)
        pendencias = {n: m for n, m in pendencias_anteriores.items() if n not in resolvidos}
        pendencias.update(execucao.pendencias)
        for numero in execucao.incluidos:
            pendencias.pop(numero, None)

    login = execucao.situacao == SITUACAO_LOGIN
    cancelada = execucao.situacao in (SITUACAO_CANCELADA, SITUACAO_INTERROMPIDA)
    resumo = ResumoExecucao(
        incluidos=len(execucao.incluidos),
        ignorados=len(execucao.ignorados),
        pendentes=len(pendencias),
        login_necessario=login,
        falha=execucao.falha,
        pendencias=tuple(sorted(pendencias.items())),
    )

    ultimo_aviso = str(anterior.get("ultimo_aviso") or "")
    if cancelada:
        # The user stopped it: only new inclusions are worth a notice, and the baseline stays as it was.
        avisar = resumo.incluidos > 0
        novo_ultimo = ultimo_aviso
        login_necessario = bool(anterior.get("login_necessario"))
        login_sistema = str(anterior.get("login_sistema") or "")
    else:
        avisar = deve_avisar(resumo, ultimo_aviso)
        limpa = not (resumo.pendencias or resumo.login_necessario or resumo.falha.strip())
        if limpa:
            novo_ultimo = ""  # nothing open anymore: the same problem coming back is new again
        elif avisar:
            # Inclusions are not part of the baseline, or the next quiet run would repeat the same pending notice.
            novo_ultimo = impressao_digital(_sem_aviso_de_inclusao(resumo))
        else:
            novo_ultimo = ultimo_aviso
        login_necessario = login
        login_sistema = execucao.login_sistema if login else ""

    estado: Dict[str, Any] = {
        "ultima_execucao": {
            "inicio": _iso(inicio),
            "fim": _iso(fim),
            "situacao": execucao.situacao,
            "incluidos": resumo.incluidos,
            "ignorados": resumo.ignorados,
            "pendentes": resumo.pendentes,
            "falha": resumo.falha,
            "detalhes": list(execucao.detalhes),
        },
        "pendencias": pendencias,
        "login_necessario": login_necessario,
        "ultimo_aviso": novo_ultimo,
    }
    if login_sistema:
        estado["login_sistema"] = login_sistema
    try:
        gravar_estado(caminho_estado, estado)
    except OSError as erro:
        logger.warning("O estado da sincronização Sebrae não foi gravado (%s).", type(erro).__name__)
        if log is not None:
            log(f"O estado não pôde ser gravado ({type(erro).__name__}); confira o log e o Dashboard.")

    return ResultadoOrquestracao(
        situacao=execucao.situacao,
        resumo=resumo,
        detalhes=tuple(execucao.detalhes),
        avisar=avisar,
        aviso=montar_aviso(resumo, execucao.situacao, login_sistema or execucao.login_sistema) if avisar else None,
        login_sistema=execucao.login_sistema,
    )


def montar_aviso(resumo: ResumoExecucao, situacao: str, login_sistema: str = "") -> Tuple[str, str]:
    """Title and message of the Windows notice; only numbers, counts and reason codes, never ticket text."""
    partes: List[str] = []
    if resumo.incluidos:
        partes.append(f"{resumo.incluidos} chamado(s) novo(s) incluído(s) no Dashboard.")
    if situacao == SITUACAO_LOGIN:
        onde = f" no {login_sistema}" if login_sistema else ""
        partes.append(f"Faça o login{onde} no Chrome de automação; a sincronização foi interrompida.")
    elif situacao == SITUACAO_CANCELADA:
        partes.append("A sincronização foi cancelada.")
    elif resumo.falha.strip():
        partes.append(f"A sincronização não terminou ({resumo.falha}).")
    if resumo.pendencias:
        visiveis = [f"{numero} ({motivo})" for numero, motivo in resumo.pendencias[:LIMITE_PENDENCIAS_NO_AVISO]]
        resto = len(resumo.pendencias) - len(visiveis)
        texto = ", ".join(visiveis) + (f" e mais {resto}" if resto > 0 else "")
        partes.append(f"Pendentes: {texto}.")
    return TITULO_AVISO, " ".join(partes) or "Sem novidades."
