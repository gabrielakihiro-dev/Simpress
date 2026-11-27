"""Auxiliares puros do estado da tela F5 (domains/sebrae_dashboard_tela.py), sem passar pelo HTTP."""

from __future__ import annotations

import unittest

from domains import sebrae_dashboard_tela as tela


class AuxiliaresDaTelaTest(unittest.TestCase):
    def test_uma_vez_le_cada_fonte_so_uma_vez_por_resposta(self) -> None:
        chamadas = []

        def ler() -> str:
            chamadas.append(1)
            return "valor"

        leituras: dict = {}
        self.assertEqual([tela.uma_vez(leituras, "fonte", ler) for _ in range(3)], ["valor"] * 3)
        self.assertEqual(len(chamadas), 1)
        tela.uma_vez(None, "fonte", ler)  # sem cache: lê de novo
        self.assertEqual(len(chamadas), 2)

    def test_sem_relacao_vai_para_a_propria_chave(self) -> None:
        sem_relacao = {"tipo": "sem_relacao", "os": "OS-1"}
        self.assertEqual(tela.os_nova_e_sem_relacao(sem_relacao), {"os_nova": None, "os_sem_relacao": sem_relacao})
        nova = {"tipo": "troca", "nova": "OS-2"}
        self.assertEqual(tela.os_nova_e_sem_relacao(nova), {"os_nova": nova, "os_sem_relacao": None})
        self.assertEqual(tela.os_nova_e_sem_relacao(None), {"os_nova": None, "os_sem_relacao": None})

    def test_destaque_e_apelido(self) -> None:
        self.assertTrue(tela.destacado({"UTIC-1": {"destaque": True}}, "UTIC-1"))
        self.assertFalse(tela.destacado({}, None))
        self.assertEqual(tela.apelido({"ABC123": "Sala 2"}, " abc123 "), "Sala 2")
        self.assertEqual(tela.apelido({}, None), "")


if __name__ == "__main__":
    unittest.main()
