"""Circuit breaker (Fase 1): para a missão se o mesmo erro do harness repetir N vezes
seguidas, ou se o custo (da missão ou do dia) passar do teto configurado.
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from . import usage_log
from .config import LimitesConfig


class CircuitBreakerError(Exception):
    pass


@dataclass
class CircuitBreaker:
    limites: LimitesConfig
    log_path: Path
    custo_missao_usd: float = 0.0
    _ultima_assinatura: Optional[str] = field(default=None, repr=False)
    _repeticoes: int = field(default=0, repr=False)

    def registrar_custo(self, custo_usd: float) -> None:
        self.custo_missao_usd += custo_usd
        if self.custo_missao_usd > self.limites.teto_custo_missao_usd:
            raise CircuitBreakerError(
                f"Custo da missão (US$ {self.custo_missao_usd:.4f}) passou do teto "
                f"(US$ {self.limites.teto_custo_missao_usd:.2f})."
            )
        custo_hoje = usage_log.custo_hoje_usd(self.log_path)
        if custo_hoje > self.limites.teto_custo_dia_usd:
            raise CircuitBreakerError(
                f"Custo do dia (US$ {custo_hoje:.4f}) passou do teto "
                f"(US$ {self.limites.teto_custo_dia_usd:.2f})."
            )

    def registrar_erro_harness(self, assinatura: str) -> None:
        if assinatura == self._ultima_assinatura:
            self._repeticoes += 1
        else:
            self._ultima_assinatura = assinatura
            self._repeticoes = 1
        if self._repeticoes >= self.limites.repeticoes_erro_para_parar:
            raise CircuitBreakerError(f"Mesmo erro do harness repetido {self._repeticoes}x: {assinatura}")
