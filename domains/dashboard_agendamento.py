"""Local opt-in schedule for the existing read-only dashboard routine."""
from datetime import datetime, timedelta
from pathlib import Path
from core.integrity import lock_paths
from typing import Any, Callable

from core.errors import DomainConflictError
from domains.sebrae_agendamento import FUSO, _ler_json, _gravar_json, _iso


class AgendadorDashboard:
    def __init__(self, caminho: Path, iniciar: Callable[[str], Any], *, agora: Callable[[], datetime] = lambda: datetime.now(FUSO), impedimento: Callable[[], str] = lambda: "") -> None:
        self.caminho = caminho
        self._iniciar = iniciar
        self._agora = agora
        self._impedimento = impedimento

    def resumo(self) -> dict[str, Any]:
        dados = _ler_json(self.caminho)
        return {"bloqueio": self._impedimento(), "ativo": dados.get("ativo") is True, "intervalo_minutos": 30,
                "proxima_execucao": dados.get("proxima_execucao"), "ultimo_disparo": dados.get("ultimo_disparo"),
                "aviso": "O computador e o servidor local precisam permanecer ligados. Senha e MFA continuam manuais. Horários perdidos não são acumulados."}

    def definir_ativo(self, ativo: bool) -> dict[str, Any]:
        with lock_paths([self.caminho]):
            dados = self.resumo()
            if ativo and not dados["ativo"]:
                dados["proxima_execucao"] = _iso(self._agora() + timedelta(minutes=30))
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
                dados["proxima_execucao"] = _iso(agora + timedelta(minutes=30))
                _gravar_json(self.caminho, dados)
                return None
            if agora < horario:
                return None
            # Claim before starting: a restart must not repeat the same scheduled run.
            dados["proxima_execucao"] = _iso(agora + timedelta(minutes=30))
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
