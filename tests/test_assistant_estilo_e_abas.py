"""Assistente alinhado às telas de 13/11/2026 (OS F6, Relatório F8, F7, F5) e à regra de estilo de escrita (regra 42)."""

import unittest

from domains.assistant_chat import SYSTEM_PROMPT
from domains.assistant_tools import TOOLS, grupos_da_mensagem, schemas_para_mensagem


def regra(inicio: str) -> str:
    return SYSTEM_PROMPT[SYSTEM_PROMPT.index(inicio):].split("\n", 1)[0]


def bloco(inicio: str, fim: str) -> str:
    # Rule 42 spans several lines (bullets): from its start to the next section.
    comeco = SYSTEM_PROMPT.index(inicio)
    return SYSTEM_PROMPT[comeco:SYSTEM_PROMPT.index(fim, comeco)]


class AbasAtualizadasTests(unittest.TestCase):
    def test_regra_32_cita_o_selo_entregue(self):
        texto = regra("32. Tela OS (F6)")
        for trecho in ("selo `Entregue`", "`Pedido entregue`", "com ou sem vínculo UTIC", "se ela não tiver o selo `Entregue`"):
            self.assertIn(trecho, texto)

    def test_regra_41_orienta_f8_f7_e_desfazer_finalizacao(self):
        texto = regra("41. Relatório Mensal (F8)")
        for trecho in (
            "`Visão geral`", "`OS e pedidos do mês`", "`Pendências da comparação`", "`Chamados (F5)`", "`Base atual`",
            "obter_relatorio_mensal", '"Histórico de apelidos"', '"Finalizado por outro técnico"', '"Desfazer finalização"',
            "sem mexer no SoftExpert nem no SharePoint", "Você não tem ferramenta para isso",
        ):
            self.assertIn(trecho, texto)
        # The tool trims the monthly ticket list; the prompt must not call it complete.
        self.assertIn("resumo de cada sub-aba, com listas cortadas", texto)
        self.assertNotIn("traz os dados de todas", texto)

    def test_regra_37_reagendar_move_todos_os_atrasados(self):
        # The button sits on the overdue group (lembretes.js) and moves every overdue reminder at once.
        texto = regra("37. Termos de entrega")
        self.assertIn('o grupo dos atrasados tem o botão "Reagendar para hoje", que move todos os atrasados de uma vez', texto)
        self.assertNotIn("o atrasado ganha", texto)

    def test_descricao_do_relatorio_aponta_a_sub_aba(self):
        self.assertIn("sub-aba `Chamados (F5)`", TOOLS["obter_relatorio_mensal"].description)

    def test_anote_na_linha_do_tempo_leva_a_ferramenta_certa(self):
        # Before 13/11/2026 the phrase only matched `historico`, so `anotar_linha_do_tempo` was left out of the round.
        frase = "anote na linha do tempo que o técnico ligou"
        self.assertIn("chamados", grupos_da_mensagem(frase))
        nomes = [s["function"]["name"] for s in schemas_para_mensagem(frase)]
        self.assertIn("anotar_linha_do_tempo", nomes)


class EstiloDeEscritaTests(unittest.TestCase):
    def test_regra_42_traz_o_estilo_e_a_prioridade(self):
        texto = bloco("42. Estilo de escrita", "POLÍTICA DE SEGURANÇA:")
        for trecho in (
            "Ótima pergunta!", "Espero ter ajudado", "além disso", "vale destacar que", "crucial",
            "não é apenas X, mas também Y", "Sem emoji", "sem negrito nem outro markdown", "Ressalva só quando houver dúvida real",
            "Planilha Exportada com Sucesso!", "máscaras de LGPD", "cartão de confirmação", "os avisos e ressalvas que outra regra manda dizer", "valem sempre acima deste estilo",
        ):
            self.assertIn(trecho, texto)

    def test_abertura_do_prompt_aponta_a_regra_de_estilo(self):
        self.assertIn("(veja a regra 42)", SYSTEM_PROMPT.split("\n", 2)[1])


if __name__ == "__main__":
    unittest.main()
