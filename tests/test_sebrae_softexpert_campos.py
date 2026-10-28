import unittest
from datetime import date

from scripts import sebrae_softexpert as S


def ctl(rotulo, valor, tag="INPUT", leitura=True):
    return {"tag": tag, "rotulo": rotulo, "valor": valor, "leitura": leitura}


REGISTRO = [
    ctl("N° do chamado", "UTIC-2026-1378"),
    ctl("Data", "26/10/2026"),
    ctl("Título do chamado", "Verificar por que o computador está travando"),
    ctl("Solicitante", "Camila Vitoria Lopes de Oliveira"),
    ctl("Fale com a UTIC - Resuma abaixo a sua solicitação", "Meu computador esta travando", "TEXTAREA"),
]


class CamposDoRegistroTest(unittest.TestCase):
    def test_mapeia_pelos_rotulos_e_a_descricao_pelo_textarea(self):
        self.assertEqual(
            S.campos_do_registro(REGISTRO),
            {
                "numero": "UTIC-2026-1378",
                "titulo": "Verificar por que o computador está travando",
                "solicitante": "Camila Vitoria Lopes de Oliveira",
                "descricao": "Meu computador esta travando",
            },
        )

    def test_rotulo_da_descricao_pode_mudar_com_a_categoria(self):
        controles = REGISTRO[:-1] + [ctl("Descreva o acesso necessário", "Preciso de acesso", "TEXTAREA")]
        self.assertEqual(S.campos_do_registro(controles)["descricao"], "Preciso de acesso")

    def test_campo_editavel_nunca_e_lido(self):
        controles = [ctl("Solicitante", "Digitado agora", leitura=False), ctl("x", "rascunho", "TEXTAREA", leitura=False)]
        self.assertEqual(S.campos_do_registro(controles), {"numero": "", "titulo": "", "solicitante": "", "descricao": ""})


class DetalhesConcluidosTest(unittest.TestCase):
    def test_pega_o_textarea_somente_leitura_sem_asterisco(self):
        controles = [
            ctl("Detalhes do Atendimento Realizado", "Chamado encaminhado.", "TEXTAREA"),
            ctl("Detalhes do Atendimento Realizado*", "rascunho atual", "TEXTAREA", leitura=False),
        ]
        self.assertEqual(S.detalhes_concluidos(controles), "Chamado encaminhado.")

    def test_editavel_ou_vazio_nao_conta(self):
        self.assertEqual(S.detalhes_concluidos([ctl("Detalhes do Atendimento Realizado*", "x", "TEXTAREA", leitura=False)]), "")
        self.assertEqual(S.detalhes_concluidos([ctl("Detalhes do Atendimento Realizado", "", "TEXTAREA")]), "")


class HabilitadaDaListaTest(unittest.TestCase):
    HOJE = date(2026, 10, 28)

    def test_data_completa(self):
        self.assertEqual(S.habilitada_da_lista("Habilitada em\n26/10/2026, 17:25:23\nIniciador"), "26/10/2026, 17:25:23")

    def test_hoje_e_ontem_viram_data(self):
        self.assertEqual(S.habilitada_da_lista("Habilitada em\nOntem, 10:30:29", self.HOJE), "27/10/2026, 10:30:29")
        self.assertEqual(S.habilitada_da_lista("Habilitada em Hoje, 08:05", self.HOJE), "28/10/2026, 08:05")

    def test_sem_o_campo_devolve_vazio(self):
        self.assertEqual(S.habilitada_da_lista("Iniciador Fulano"), "")
        self.assertEqual(S.habilitada_da_lista(""), "")


class ConfirmacaoDeAssociarTest(unittest.TestCase):
    def test_botoes_aceitos_e_recusados(self):
        for rotulo in ("Sim", " Confirmar ", "confirmar"):
            self.assertTrue(S.NOME_SIM.search(rotulo), rotulo)
        for rotulo in ("Cancelar", "Não", "Confirmar envio"):
            self.assertFalse(S.NOME_SIM.search(rotulo), rotulo)

    def test_texto_do_dialogo_de_associar(self):
        self.assertTrue(S.TEXTO_CONFIRMACAO.search("Atenção Deseja associar esta atividade ao seu usuário?"))
        self.assertFalse(S.TEXTO_CONFIRMACAO.search("Deseja finalizar o chamado?"))


if __name__ == "__main__":
    unittest.main()
