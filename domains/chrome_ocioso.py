"""Closes the automation Chrome (CDP port 9333) after a stretch with no routine (docs/operacao/automacao-chrome.md).

Any use of the shared lock (routine, Endpoint lookup, PowerShell, UX) resets the clock. A prepared UX
session or a PowerShell/remote-control tab left open for the user keeps Chrome open. Chrome still
listens on the TCP debugging port while open; moving to --remote-debugging-pipe is a pending item.
"""

import logging
import os
import time
from importlib import import_module
from typing import Callable, Optional

logger = logging.getLogger(__name__)

LIMITE_PADRAO_S = 10 * 60
VERIFICAR_A_CADA_S = 60
ESPERA_FECHAR_S = 10


def limite_configurado() -> float:
    """``SIMPRESS_CHROME_OCIOSO_S`` overrides the 10 minutes; 0 or less turns the close off."""
    valor = os.environ.get("SIMPRESS_CHROME_OCIOSO_S", "").strip()
    try:
        return float(valor) if valor else LIMITE_PADRAO_S
    except ValueError:
        return LIMITE_PADRAO_S


class FechamentoOcioso:
    """One ``verificar()`` per minute; closes Chrome once nothing used it for ``limite`` seconds."""

    def __init__(
        self,
        *,
        limite: float,
        ultimo_uso: Callable[[], Optional[float]],
        ocupado: Callable[[], bool],
        cdp_ativo: Callable[[], bool],
        fechar: Callable[[], None],
        relogio: Callable[[], float] = time.time,
    ) -> None:
        self._limite = limite
        self._ultimo_uso = ultimo_uso
        self._ocupado = ocupado
        self._cdp_ativo = cdp_ativo
        self._fechar = fechar
        self._relogio = relogio
        # Never 0: a fresh server must not close a Chrome the user has just opened.
        self._ultima_atividade = relogio()

    def verificar(self) -> bool:
        """Return True when this call asked Chrome to close."""
        agora = self._relogio()
        uso = self._ultimo_uso()
        if uso is not None:
            self._ultima_atividade = max(self._ultima_atividade, uso)
        if self._ocupado():
            self._ultima_atividade = agora
            return False
        if agora - self._ultima_atividade < self._limite:
            return False
        self._ultima_atividade = agora  # a failed close waits for another full idle stretch
        if not self._cdp_ativo():
            return False
        self._fechar()
        return True


def fechar_chrome_de_automacao(sessao_viva: Callable[[], bool]) -> None:
    """Close under the shared lock (no routine starts meanwhile): CDP Browser.close first, then the profile processes."""
    automation = import_module("scripts.automacao_rotinas_chrome")
    try:
        with automation.trava_execucao("fechar_chrome_ocioso"):
            if sessao_viva():  # re-checked while holding the lock
                return
            try:
                from playwright.sync_api import sync_playwright

                with sync_playwright() as pw:
                    browser = pw.chromium.connect_over_cdp(automation.CDP_URL, timeout=10_000)
                    # browser.close() on a CDP connection only disconnects; Browser.close quits and keeps the logins.
                    browser.new_browser_cdp_session().send("Browser.close")
            except Exception as error:
                logger.info("Browser.close não respondeu (%s); conferindo a porta antes de encerrar o perfil.", type(error).__name__)
            limite = time.time() + ESPERA_FECHAR_S
            while automation.cdp_ativo() and time.time() < limite:
                time.sleep(0.5)
            if automation.cdp_ativo():
                automation.encerrar_chrome_do_perfil()
            logger.info("Chrome de automação fechado após %s minutos sem uso.", int(limite_configurado() // 60))
    except automation.TravaOcupada:
        return  # a routine started meanwhile; its lock use resets the clock
