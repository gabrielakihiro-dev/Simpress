import unittest

from domains.assistant_chat import SYSTEM_PROMPT


def regra(inicio: str) -> str:
    # Each numbered rule is a single line of the prompt.
    return SYSTEM_PROMPT[SYSTEM_PROMPT.index(inicio):].split("\n", 1)[0]


class AssistenteTermosTests(unittest.TestCase):
    def test_regra_37_explica_termos_sem_ferramenta(self):
        texto = regra("37. Termos de entrega e devolução")
        for trecho in (
            "Ferramentas",
            "sem atalho",
            "Termo Entrega",
            "Termo Devolução",
            "Gerar PDF",
            "série na Home",
            "Notebook",
            "<série> - <nome completo>",
            "Não existe ferramenta",
        ):
            self.assertIn(trecho, texto)

    def test_regra_38_aponta_a_home_e_nunca_diz_que_enviou(self):
        texto = regra("38. E-mails por modelo pelo Outlook")
        for trecho in (
            "Home (F1)",
            '"Enviar e-mail"',
            '"E-mail pelo Outlook"',
            '"Modelo 1 - Cabo"',
            '"Abrir no Outlook"',
            '"Enviar pelo Outlook"',
            '"Copiar Texto"',
            "Não existe ferramenta de e-mail pelo Outlook",
            "nunca diz que enviou",
            "que criou, alterou ou excluiu um modelo",
        ):
            self.assertIn(trecho, texto)
        self.assertNotIn("@", texto)

    def test_prompt_nao_leva_contas_nem_nomes_da_semente_do_cabo(self):
        # The prompt goes to OpenRouter: no sender account or name from the Cabo seed.
        from domains.outlook_mail import CAMPOS_PADRAO_CABO, CONTAS_REMETENTE
        semente = " ".join([CAMPOS_PADRAO_CABO["para"], CAMPOS_PADRAO_CABO["cc"], CAMPOS_PADRAO_CABO["corpo"]])
        nomes = {palavra.strip(",;") for palavra in semente.split() if palavra[:1].isupper() and len(palavra.strip(",;")) > 3}
        nomes -= {"Solicito", "Qualquer", "Att."}
        self.assertTrue(nomes)
        for nome in nomes:
            self.assertNotIn(nome, SYSTEM_PROMPT)
        # Rule 33 already names the UX login account; rule 38 must not name any sender account.
        for conta in CONTAS_REMETENTE.values():
            self.assertNotIn(conta["email"], regra("38. E-mails por modelo pelo Outlook"))


class AssistenteDossieTests(unittest.TestCase):
    def test_regra_39_aponta_o_dossie_na_home_sem_concluir_encerramento(self):
        texto = regra("39. Dossiê do equipamento")
        for trecho in (
            "Home (F1)",
            '"Ver dossiê"',
            '"Dossiê do equipamento"',
            '"OS e chamados"',
            '"Mudanças da série nas importações de OS"',
            "não de cada OS",
            "nunca diz que foi",
            '"Ver OS"',
            "Não existe ferramenta do dossiê",
        ):
            self.assertIn(trecho, texto)

if __name__ == "__main__":
    unittest.main()
