"""Local opt-in schedule for the existing read-only dashboard routine."""
from datetime import datetime, timedelta
from pathlib import Path
from core.integrity import lock_paths
from typing import Any, Callable

from core.errors import DomainConflictError, DomainValidationError
from domains.sebrae_agendamento import FUSO, _ler_json, _gravar_json, _iso

INTERVALOS_PERMITIDOS = (30, 60, 90, 120)
INTERVALO_PADRAO = 30


def _intervalo_valido(valor: Any) -> int | None:
    return valor if type(valor) is int and valor in INTERVALOS_PERMITIDOS else None


class AgendadorDashboard:
    def __init__(self, caminho: Path, iniciar: Callable[[str], Any], *, agora: Callable[[], datetime] = lambda: datetime.now(FUSO), impedimento: Callable[[], str] = lambda: "") -> None:
        self.caminho = caminho
        self._iniciar = iniciar
        self._agora = agora
        self._impedimento = impedimento

    def resumo(self) -> dict[str, Any]:
        dados = _ler_json(self.caminho)
        return {"bloqueio": self._impedimento(), "ativo": dados.get("ativo") is True,
                "intervalo_minutos": _intervalo_valido(dados.get("intervalo_minutos")) or INTERVALO_PADRAO,
                "proxima_execucao": dados.get("proxima_execucao"), "ultimo_disparo": dados.get("ultimo_disparo"),
                "aviso": "O computador e o servidor local precisam permanecer ligados. Senha e MFA continuam manuais. Horários perdidos não são acumulados."}

    def definir_ativo(self, ativo: bool, intervalo_minutos: int | None = None) -> dict[str, Any]:
        if intervalo_minutos is not None and _intervalo_valido(intervalo_minutos) is None:
            raise DomainValidationError("Intervalo inválido. Use 30, 60, 90 ou 120 minutos.", status_code=422)
        with lock_paths([self.caminho]):
            dados = self.resumo()
            mudou = intervalo_minutos is not None and intervalo_minutos != dados["intervalo_minutos"]
            if intervalo_minutos is not None:
                dados["intervalo_minutos"] = intervalo_minutos
            if ativo and (not dados["ativo"] or mudou):
                dados["proxima_execucao"] = _iso(self._agora() + timedelta(minutes=dados["intervalo_minutos"]))
            if not ativo:
                dados["proxima_execucao"] = None
            dados["ativo"] = ativo
            _gravar_json(self.caminho, dados)
            return dados

    def verificar(self) -> str | None:
        with lock_paths([self.caminho]):
            dados = self.resumo()
            if not dados["ativo"]:
                return None
            agora = self._agora()
            try:
                horario = datetime.fromisoformat(dados["proxima_execucao"])
                if horario.tzinfo is None:
                    raise ValueError("horário sem fuso")
            except (ValueError, TypeError):
                dados["proxima_execucao"] = _iso(agora + timedelta(minutes=dados["intervalo_minutos"]))
                _gravar_json(self.caminho, dados)
                return None
            if agora < horario:
                return None
            # Claim before starting: a restart must not repeat the same scheduled run.
            dados["proxima_execucao"] = _iso(agora + timedelta(minutes=dados["intervalo_minutos"]))
            dados["ultimo_disparo"] = {"em": _iso(agora), "resultado": "pulado: horário perdido"}
            _gravar_json(self.caminho, dados)
            if agora - horario > timedelta(minutes=1):
                return dados["ultimo_disparo"]["resultado"]
            if dados["bloqueio"]:
                dados["ultimo_disparo"]["resultado"] = "pulado: saída pendente"
                _gravar_json(self.caminho, dados)
                return "pulado: saída pendente"
            try:
                self._iniciar("dashboard")
                resultado = "iniciada"
            except DomainConflictError:
                resultado = "pulado: ocupada"
            except Exception:
                resultado = "erro ao iniciar"
            dados["ultimo_disparo"]["resultado"] = resultado
            _gravar_json(self.caminho, dados)
            return resultado
