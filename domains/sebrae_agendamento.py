"""Weekday schedule of the "Sincronizar chamados Sebrae" routine (docs/operacao/sincronizar-chamados-sebrae.md).

Starts are 09:15, 09:45 ... 17:45 (America/Sao_Paulo), Monday to Friday, never at 18:00.
A start fires at most once and only while the server sees it within ``TOLERANCIA_SLOT``;
missed starts are dropped, never accumulated. The scheduler starts the routine through the
same ``ChromeAutomationRunner`` as the Automação screen, so the existing lock keeps two
runs from overlapping: a busy runner simply skips the start.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
from zoneinfo import ZoneInfo

from core.errors import DomainConflictError, DomainError
from core.integrity import atomic_write_json

logger = logging.getLogger(__name__)

ROTINA = "sebrae"
FUSO = ZoneInfo("America/Sao_Paulo")
DIAS_UTEIS = (0, 1, 2, 3, 4)  # Monday to Friday
PRIMEIRO_HORARIO = (9, 15)
ULTIMO_HORARIO = (17, 45)
INTERVALO_MINUTOS = 30
TOLERANCIA_SLOT = timedelta(minutes=5)
DESCRICAO_HORARIO = "segunda a sexta, das 09h15 às 17h45, a cada 30 minutos"

# Flipped to True only after the controlled real run (phase E of the spec); until then the
# schedule cannot be turned on, so a half-built routine never fails every 30 minutes.
ROTINA_PRONTA = False

RESULTADO_INICIADA = "iniciada"
RESULTADO_OCUPADA = "pulado: ocupada"
RESULTADO_ERRO = "erro ao iniciar"


def _em_sao_paulo(agora: datetime) -> datetime:
    if agora.tzinfo is None:
        return agora.replace(tzinfo=FUSO)
    return agora.astimezone(FUSO)


def horarios_do_dia(dia: date) -> List[datetime]:
    """Start times of one day; empty on weekends."""
    if dia.weekday() not in DIAS_UTEIS:
        return []
    atual = datetime(dia.year, dia.month, dia.day, *PRIMEIRO_HORARIO, tzinfo=FUSO)
    ultimo = datetime(dia.year, dia.month, dia.day, *ULTIMO_HORARIO, tzinfo=FUSO)
    horarios = []
    while atual <= ultimo:
        horarios.append(atual)
        atual = (atual.replace(tzinfo=None) + timedelta(minutes=INTERVALO_MINUTOS)).replace(tzinfo=FUSO)
    return horarios


def proximo_horario(agora: datetime) -> datetime:
    """First start strictly after ``agora``."""
    local = _em_sao_paulo(agora)
    dia = local.date()
    for _ in range(8):
        for horario in horarios_do_dia(dia):
            if horario > local:
                return horario
        dia += timedelta(days=1)
    raise RuntimeError("Nenhum horário encontrado nos próximos 8 dias.")  # pragma: no cover


def horario_vigente(agora: datetime, tolerancia: timedelta = TOLERANCIA_SLOT) -> Optional[datetime]:
    """The start whose window ``[horario, horario + tolerancia]`` contains ``agora``, if any."""
    local = _em_sao_paulo(agora)
    for horario in horarios_do_dia(local.date()):
        if horario <= local <= horario + tolerancia:
            return horario
    return None


def _iso(valor: datetime) -> str:
    return valor.astimezone(FUSO).isoformat(timespec="seconds")


def _ler_json(caminho: Path) -> Dict[str, Any]:
    try:
        dados = json.loads(caminho.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        return {}
    return dados if isinstance(dados, dict) else {}


def _gravar_json(caminho: Path, dados: Dict[str, Any]) -> None:
    caminho.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(caminho, dados)


@dataclass(frozen=True)
class CaminhosSebrae:
    agendamento: Path
    estado_chamados: Path


def caminhos_padrao(state_dir: Path) -> CaminhosSebrae:
    return CaminhosSebrae(
        agendamento=state_dir / "sebrae_agendamento.json",
        estado_chamados=state_dir / "sebrae_chamados_estado.json",
    )


class AgendadorSebrae:
    """Persisted on/off switch plus the once-per-start trigger."""

    def __init__(
        self,
        caminhos: CaminhosSebrae,
        iniciar: Callable[[str], Any],
        *,
        agora: Callable[[], datetime] = lambda: datetime.now(FUSO),
        pronta: bool = ROTINA_PRONTA,
    ) -> None:
        self.caminhos = caminhos
        self._iniciar = iniciar
        self._agora = agora
        self._pronta = pronta

    # ------------------------------------------------------------------ persisted state

    def _configuracao(self) -> Dict[str, Any]:
        dados = _ler_json(self.caminhos.agendamento)
        ativo = bool(dados.get("ativo")) and self._pronta
        return {
            "ativo": ativo,
            "ultimo_slot_disparado": str(dados.get("ultimo_slot_disparado") or ""),
            "ultimo_disparo": dados.get("ultimo_disparo") if isinstance(dados.get("ultimo_disparo"), dict) else None,
        }

    def _salvar(self, configuracao: Dict[str, Any]) -> None:
        _gravar_json(self.caminhos.agendamento, {**configuracao, "atualizado_em": _iso(self._agora())})

    def definir_ativo(self, ativo: bool) -> Dict[str, Any]:
        """Turns the schedule on or off; turning it on is refused until the routine is complete."""
        if ativo and not self._pronta:
            raise DomainConflictError(
                "A sincronização ainda não está completa (leitura do SoftExpert e gravação no Dashboard). "
                "O agendamento só pode ser ativado depois da execução controlada."
            )
        configuracao = self._configuracao()
        configuracao["ativo"] = bool(ativo)
        self._salvar(configuracao)
        return self.resumo()

    # ------------------------------------------------------------------ trigger

    def verificar(self) -> Optional[str]:
        """One scheduler tick; returns the outcome when a start was due, else None."""
        configuracao = self._configuracao()
        if not configuracao["ativo"]:
            return None
        agora = self._agora()
        horario = horario_vigente(agora)
        if horario is None:
            return None
        chave = _iso(horario)
        if configuracao["ultimo_slot_disparado"] == chave:
            return None
        try:
            self._iniciar(ROTINA)
            resultado = RESULTADO_INICIADA
        except DomainConflictError:
            resultado = RESULTADO_OCUPADA
        except DomainError as erro:
            logger.warning("A sincronização agendada não pôde iniciar (%s).", type(erro).__name__)
            resultado = RESULTADO_ERRO
        except Exception as erro:  # a scheduler tick must never take the worker down
            logger.warning("A sincronização agendada falhou ao iniciar (%s).", type(erro).__name__)
            resultado = RESULTADO_ERRO
        configuracao["ultimo_slot_disparado"] = chave
        configuracao["ultimo_disparo"] = {"horario": chave, "resultado": resultado, "em": _iso(agora)}
        try:
            self._salvar(configuracao)
        except OSError:
            logger.warning("O registro do horário disparado não foi gravado.")
        return resultado

    # ------------------------------------------------------------------ summary

    def resumo(self) -> Dict[str, Any]:
        configuracao = self._configuracao()
        estado = _ler_json(self.caminhos.estado_chamados)
        ultima_bruta = estado.get("ultima_execucao")
        ultima: Optional[Dict[str, Any]] = ultima_bruta if isinstance(ultima_bruta, dict) else None
        pendencias_brutas = estado.get("pendencias")
        pendencias: Dict[str, Any] = pendencias_brutas if isinstance(pendencias_brutas, dict) else {}
        return {
            "agendamento": {
                "ativo": configuracao["ativo"],
                "pronta": self._pronta,
                "horario": DESCRICAO_HORARIO,
                "fuso": "America/Sao_Paulo",
                "proxima_execucao": _iso(proximo_horario(self._agora())) if configuracao["ativo"] else None,
                "ultimo_disparo": configuracao["ultimo_disparo"],
                "aviso": "O computador precisa estar ligado e o servidor local da Simpress em execução.",
            },
            "ultima_execucao": ultima,
            "pendencias": [{"numero": str(numero), "motivo": str(motivo)} for numero, motivo in pendencias.items()],
            "login_necessario": bool(estado.get("login_necessario")),
        }
