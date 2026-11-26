"""Assistente alinhado às telas (Home F1, Resumo F3, F5, F6, F7, F8, F10, Termos, Config local, Celular) e à regra de estilo (regra 42)."""

import unittest
from pathlib import Path

from domains.assistant_chat import SYSTEM_PROMPT
from domains.assistant_tools import NUCLEO_FERRAMENTAS, TOOLS, grupos_da_mensagem, schemas_para_mensagem, tool_schemas


def regra(inicio: str) -> str:
    return SYSTEM_PROMPT[SYSTEM_PROMPT.index(inicio):].split("\n", 1)[0]


def bloco(inicio: str, fim: str) -> str:
    # Rule 42 spans several lines (bullets): from its start to the next section.
    comeco = SYSTEM_PROMPT.index(inicio)
    return SYSTEM_PROMPT[comeco:SYSTEM_PROMPT.index(fim, comeco)]


class AbasAtualizadasTests(unittest.TestCase):
    def test_regra_32_cita_o_selo_entregue(self):
        texto = regra("32. Tela OS (F6)")
        for trecho in ("selo `Entregue`", "`Pedido entregue`", "com ou sem vínculo UTIC", "se ela não tiver o selo `Entregue`",
                       "lista de OS à esquerda e o detalhe de uma OS por vez à direita",
                       'não existe mais "Comparação com a importação anterior"'):
            self.assertIn(trecho, texto)

    def test_regra_41_orienta_f8_f7_e_desfazer_finalizacao(self):
        texto = regra("41. Relatório Mensal (F8)")
        for trecho in (
            "`Visão geral`", "`OS e pedidos do mês`", "`Chamados (F5)`", "`Base atual`", "`Tendências`",
            "obter_relatorio_mensal", '"Histórico de apelidos"', '"Finalizado por outro técnico"', '"Desfazer finalização"',
            "sem mexer no SoftExpert nem no SharePoint", "Você não tem ferramenta para isso",
            "Todos, Apelido, Usuário, Endereço, Avisos do Endpoint", "Somente com ação disponível",
        ):
            self.assertIn(trecho, texto)
        # The tool trims the monthly ticket list; the prompt must not call it complete.
        self.assertIn("resumo de cada sub-aba, com listas cortadas", texto)
        self.assertNotIn("traz os dados de todas", texto)
        # A sub-aba de comparação saiu do F8 no Novo layout (18/11/2026).
        self.assertNotIn("Pendências da comparação", texto)

    def test_regra_37_reagendar_move_todos_os_atrasados(self):
        # The button sits on the overdue group (lembretes.js) and moves every overdue reminder at once.
        texto = regra("37. Termos de entrega")
        self.assertIn('o grupo dos atrasados tem o botão "Reagendar para hoje", que move todos os atrasados de uma vez', texto)
        self.assertIn('"Prévia do PDF"', texto)
        self.assertNotIn("o atrasado ganha", texto)

    def test_novas_atualizacoes_de_home_resumo_f5_f10_config_e_celular(self):
        self.assertIn('link "Ver inteiro"', regra("29. PowerShell no Endpoint"))
        self.assertIn('"Editor do comando"', regra("29. PowerShell no Endpoint"))
        self.assertIn('"Desfazer" direto no aviso da reserva', regra("30. Cobertura"))
        regra_31 = regra("31. Tela Chamados (F5)")
        for trecho in ('"Mostrar senha"', '"OS nova?"', '"OS sem relação?"', "destacados em rosa",
                       "você nunca lê, vê nem repete senhas", "Conflito de edição no SharePoint"):
            self.assertIn(trecho, regra_31)
        regra_36 = regra("36. Sugestão de Responsável (A)")
        for trecho in ("cabo HDMI ou cabo de força do monitor", "Chamados antigos em aberto também recebem sugestões de A e J"):
            self.assertIn(trecho, regra_36)
        self.assertIn('rodapé do cartão "Chamados abertos"', regra("38. E-mails por modelo pelo Outlook"))
        self.assertIn('rodapé do cartão "Chamados abertos"', regra("39. Dossiê do equipamento"))
        self.assertIn('"Confirmar Backup"', regra("40. Backups regionais"))
        bloco_41b = bloco("41b. Home (F1), Resumo (F3)", "42. Estilo de escrita")
        for trecho in (
            "zbook", "elitebook", '"Salvar como padrão"', '"Restaurar modelo"',
            "`Visão Geral`", "`Divergências`", "`Apelidos`", "`Usuários`", "`Sem acesso`", "`Backups`",
            '"Backup <Cidade>"', "Administrador no Endpoint",
            "Configuração local", "Contas das automações e Links internos", "Dados do cliente", "Assistente com IA",
            "iniciar_servidor_celular.bat", "iniciar_servidor_celular_tailscale.bat", "Tailscale", "Funnel",
        ):
            self.assertIn(trecho, bloco_41b)

    def test_descricao_do_relatorio_e_prontidao(self):
        self.assertIn("sub-aba `Chamados (F5)`", TOOLS["obter_relatorio_mensal"].description)
        self.assertIn("configuracao_local", TOOLS["obter_prontidao"].description)

    def test_anote_na_linha_do_tempo_leva_a_ferramenta_certa(self):
        # Before 13/11/2026 the phrase only matched `historico`, so `anotar_linha_do_tempo` was left out of the round.
        frase = "anote na linha do tempo que o técnico ligou"
        self.assertIn("chamados", grupos_da_mensagem(frase))
        nomes = [s["function"]["name"] for s in schemas_para_mensagem(frase)]
        self.assertIn("anotar_linha_do_tempo", nomes)

    def test_telas_ajuda_economiza_schemas_sem_ferramentas_destrutivas(self):
        total_completo = len(tool_schemas())
        for frase in (
            "como acesso o Simpress pelo celular com Tailscale?",
            "onde configuro a chave da IA na configuração local?",
        ):
            with self.subTest(frase=frase):
                self.assertIn("telas_ajuda", grupos_da_mensagem(frase))
                selecionadas = schemas_para_mensagem(frase)
                self.assertLessEqual(len(selecionadas), len(NUCLEO_FERRAMENTAS))
                nomes = {s["function"]["name"] for s in selecionadas}
                self.assertNotIn("finalizar_chamado_softexpert", nomes)
                self.assertNotIn("executar_automacao_chrome", nomes)
        for frase in (
            "onde vejo a prévia do PDF do termo de entrega?",
            "como salvo como padrão um texto no chamado manual?",
        ):
            with self.subTest(frase=frase):
                self.assertIn("telas_ajuda", grupos_da_mensagem(frase))
                selecionadas = schemas_para_mensagem(frase)
                self.assertLess(len(selecionadas), total_completo // 2)
                nomes = {s["function"]["name"] for s in selecionadas}
                self.assertNotIn("finalizar_chamado_softexpert", nomes)
                self.assertNotIn("executar_automacao_chrome", nomes)

    def test_assistente_nao_acessa_credenciais_do_f5(self):
        raiz = Path(__file__).resolve().parents[1]
        for arquivo in [*raiz.glob("domains/assistant*.py"), *raiz.glob("routers/assistant*.py")]:
            fonte = arquivo.read_text(encoding="utf-8")
            self.assertNotIn("sebrae_credenciais.json", fonte, arquivo.name)


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
