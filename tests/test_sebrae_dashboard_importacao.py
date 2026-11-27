"""Auxiliares puros da importação do Dashboard (domains/sebrae_dashboard_importacao.py), sem passar pelo HTTP."""

from __future__ import annotations

import unittest

from domains import sebrae_dashboard_importacao as importacao
from tests.test_sebrae_dashboard_gravacao import montar


class MesmaPlanilhaTest(unittest.TestCase):
    def test_mesmos_bytes_sao_a_mesma_e_outro_status_nao(self) -> None:
        base = montar(("UTIC-2026-1",), status=("EM ABERTO",))
        self.assertTrue(importacao.mesma_planilha(base, base))
        self.assertFalse(importacao.mesma_planilha(base, montar(("UTIC-2026-1",), status=("FINALIZADO",))))

    def test_sem_referencia_ou_ilegivel_nunca_e_igual(self) -> None:
        base = montar(("UTIC-2026-1",), status=("EM ABERTO",))
        self.assertFalse(importacao.mesma_planilha(base, None))
        self.assertIsNone(importacao.valores_ou_none(None))
        self.assertIsNone(importacao.valores_ou_none(b"nao e xlsx"))
        self.assertFalse(importacao.mesma_planilha(b"nao e xlsx", b"outro lixo"))


if __name__ == "__main__":
    unittest.main()
