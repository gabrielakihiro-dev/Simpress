"""Per-minute caps for routes that spend money or start Chrome.

The server is single-user and local, so one in-memory window per route is enough:
it stops a runaway loop (a stuck tab, a script, a repeated click) without persisting anything.
"""

import threading
import time
from collections import deque
from typing import Callable, Deque

from fastapi import HTTPException

JANELA_SEGUNDOS = 60.0


class LimiteTaxa:
    """Sliding window: at most ``maximo`` calls in any ``janela`` seconds."""

    def __init__(self, maximo: int, janela: float = JANELA_SEGUNDOS, relogio: Callable[[], float] = time.monotonic) -> None:
        self.maximo = maximo
        self.janela = janela
        self._relogio = relogio
        self._chamadas: Deque[float] = deque()
        self._trava = threading.Lock()

    def exigir(self) -> None:
        """Count one call or raise 429 with Retry-After when the window is full."""
        with self._trava:
            agora = self._relogio()
            while self._chamadas and agora - self._chamadas[0] >= self.janela:
                self._chamadas.popleft()
            if len(self._chamadas) >= self.maximo:
                espera = max(1, int(self.janela - (agora - self._chamadas[0])) + 1)
                raise HTTPException(
                    status_code=429,
                    detail="Muitas solicitações seguidas. Aguarde um minuto e tente de novo.",
                    headers={"Retry-After": str(espera)},
                )
            self._chamadas.append(agora)
