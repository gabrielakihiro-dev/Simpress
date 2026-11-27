"""Auxiliares puros da gravação da cópia atualizada (domains/sebrae_dashboard_atualizacao.py), sem passar pelo HTTP."""

from __future__ import annotations

import unittest

from core.errors import DomainValidationError
from domains import sebrae_dashboard_atualizacao as atualizacao


class FaltaEncerramentoTest(unittest.TestCase):
    def test_frase_exata(self) -> None:
        self.assertEqual(
            atualizacao.falta_encerramento("UTIC-2026-1"),
            "Informe a DT ENCERRAMENTO (coluna R) do chamado UTIC-2026-1 antes de finalizar.",
        )


class ExigirOutroTecnicoTest(unittest.TestCase):
    def test_nada_falta_nao_levanta(self) -> None:
        atualizacao.exigir_outro_tecnico("UTIC-2026-1", {"A": "Cliente", "B": "Rede", "D": "finalizado", "R": "01/11/2026 09:05"})

    def test_lista_as_faltas_com_e_no_fim_e_status_422(self) -> None:
        with self.assertRaises(DomainValidationError) as erro:
            atualizacao.exigir_outro_tecnico("UTIC-2026-1", {"A": " ", "D": "EM ABERTO", "R": "01/11/2026"})
        self.assertEqual(erro.exception.status_code, 422)
        self.assertEqual(
            erro.exception.detail,
            "Para registrar UTIC-2026-1 como finalizado por outro técnico, preencha A (Cliente/Simpress), B (Categoria), "
            "D (FINALIZADO) e R (DT ENCERRAMENTO, dd/MM/aaaa HH:mm).",
        )

    def test_uma_falta_sem_e(self) -> None:
        with self.assertRaises(DomainValidationError) as erro:
            atualizacao.exigir_outro_tecnico("UTIC-2026-1", {"A": "Cliente", "B": "Rede", "D": "FINALIZADO"})
        self.assertEqual(
            erro.exception.detail,
            "Para registrar UTIC-2026-1 como finalizado por outro técnico, preencha R (DT ENCERRAMENTO, dd/MM/aaaa HH:mm).",
        )


if __name__ == "__main__":
    unittest.main()
