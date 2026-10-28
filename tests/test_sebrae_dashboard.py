import io
import unittest

from openpyxl import Workbook

from domains import sebrae_dashboard as dash
from domains.sebrae_chamados import ChamadoSoftExpert

CABECALHO = [
    "RESPONSÁVEL", "Categoria", "CHAMADO", "STATUS CHAMADO", "OS", "Atendimento Realizado", "Título",
    "Descrição Chamado", "Nome Usuário", "TIPO DO CHAMADO", "Série", "MODELO", "UNIDADE", "CIDADE", "UF",
    "DATA ABERTURA", "Mês", "DT ENCERRAMENTO", "TIPO SLA", "DIAS ABERTOS", "AGING", "HR CONSUMIDA", "PRODUZINDO",
]


def planilha(cabecalho=CABECALHO, coluna_c=("UTIC-2026-0094", "Sem chamado", "27371 / UTIC-2026-0095"), aba="CHAMADOS"):
    livro = Workbook()
    ws = livro.active
    ws.title = aba
    ws.append(cabecalho)
    for valor in coluna_c:
        ws.append([None, None, valor])
    buffer = io.BytesIO()
    livro.save(buffer)
    return buffer.getvalue()


class ImportacaoTest(unittest.TestCase):
    def test_le_coluna_c_inclusive_valor_composto(self):
        self.assertEqual(dash.ler_coluna_c(planilha()), frozenset({"UTIC-2026-0094", "UTIC-2026-0095"}))

    def test_recusa_dashboard_sem_a_coluna_titulo(self):
        antigo = CABECALHO[:6] + CABECALHO[7:]
        with self.assertRaisesRegex(dash.DashboardInvalido, "coluna Título em G"):
            dash.ler_coluna_c(planilha(cabecalho=antigo))

    def test_recusa_arquivo_que_nao_e_xlsx_e_aba_ausente_e_coluna_c_vazia(self):
        with self.assertRaises(dash.DashboardInvalido):
            dash.ler_coluna_c(b"nao e planilha")
        with self.assertRaisesRegex(dash.DashboardInvalido, "aba CHAMADOS"):
            dash.ler_coluna_c(planilha(aba="OUTRA"))
        with self.assertRaisesRegex(dash.DashboardInvalido, "nenhum número UTIC"):
            dash.ler_coluna_c(planilha(coluna_c=("Sem chamado",)))


class TriagemTest(unittest.TestCase):
    def test_novos_ignorados_e_alertas_do_endpoint(self):
        titulos = {
            "UTIC-2026-0094": "Já lançado",
            "UTIC-2026-1378": "Verificar por que o computador está travando",
            "UTIC-2026-1387": "Endpoint Central - Reactivated Computer(s) Added Back to ...",
            "UTIC-2026-1253": "Endpoint Central - Computer(s) Added to \"Staged\" Page",
        }
        resultado = dash.triar_novos(titulos, {"UTIC-2026-0094"})
        self.assertEqual(resultado.novos, ("UTIC-2026-1378",))
        self.assertEqual(resultado.ignorados, ("UTIC-2026-0094",))
        self.assertEqual({numero for numero, _ in resultado.pendentes}, {"UTIC-2026-1387", "UTIC-2026-1253"})


def reg(nome, serie, modelo="", cidade="", **extra):
    return {"nome": nome, "serie": serie, "modelo": modelo, "cidade": cidade, **extra}


class CruzamentoTest(unittest.TestCase):
    def test_unico_ignora_acento_caixa_e_espacos(self):
        r = dash.cruzar_por_nome("camila  vitória lopes", [reg("Camila Vitoria Lopes", "ABC123", "Dell 5440", "Curitiba")])
        self.assertEqual((r.status, r.serie, r.modelo, r.cidade), (dash.CRUZ_UNICO, "ABC123", "Dell 5440", "Curitiba"))

    def test_ausente_e_nome_vazio(self):
        self.assertEqual(dash.cruzar_por_nome("Fulano", [reg("Outro", "X1")]).status, dash.CRUZ_AUSENTE)
        self.assertEqual(dash.cruzar_por_nome("", [reg("", "X1")]).status, dash.CRUZ_AUSENTE)

    def test_duas_series_diferentes_e_ambiguo_sem_escolher(self):
        r = dash.cruzar_por_nome("Ana", [reg("Ana", "A1", "Dell"), reg("Ana", "B2", "HP")])
        self.assertEqual((r.status, r.serie, r.candidatos), (dash.CRUZ_AMBIGUO, "", 2))

    def test_mesma_serie_em_duas_fontes_e_um_candidato_e_completa_campos(self):
        r = dash.cruzar_por_nome("Ana", [reg("Ana", "A1", "", "Curitiba"), reg("Ana", "A1", "Dell", "")])
        self.assertEqual((r.status, r.modelo, r.cidade), (dash.CRUZ_UNICO, "Dell", "Curitiba"))

    def test_macbook_com_e_sem_s_inicial_e_um_candidato_mas_outra_serie_nao(self):
        mac = [reg("Ana", "SCMVXKV7YCM", "MacBook Pro"), reg("Ana", "CMVXKV7YCM", "MacBook Pro")]
        self.assertEqual(dash.cruzar_por_nome("Ana", mac).status, dash.CRUZ_UNICO)
        nao_mac = [reg("Ana", "SABC", "Dell"), reg("Ana", "ABC", "Dell")]
        self.assertEqual(dash.cruzar_por_nome("Ana", nao_mac).status, dash.CRUZ_AMBIGUO)

    def test_serie_propria_do_sebrae_e_ignorada(self):
        self.assertEqual(dash.cruzar_por_nome("Ana", [reg("Ana", "BRJ135P5XS")]).status, dash.CRUZ_AUSENTE)


CHAMADO = ChamadoSoftExpert(
    numero="UTIC-2026-1378",
    titulo="Verificar por que o computador está travando",
    descricao="Meu computador esta travando demais.\nCPF 123.456.789-09",
    solicitante="Camila Vitoria Lopes de Oliveira",
    habilitada_em="26/10/2026, 17:25:23",
    detalhes_atendimento_realizado="Chamado, sendo direcionado.\n\nObrigado !!!",
)


class LinhaTest(unittest.TestCase):
    def test_colunas_automaticas_fixas_e_cruzamento_unico(self):
        cruz = dash.Cruzamento(dash.CRUZ_UNICO, "ABC123", "Dell 5440", "Curitiba", 1)
        linha = dash.montar_linha(CHAMADO, cruz, os_da_serie="7303022")
        self.assertEqual(
            linha,
            {
                "C": "UTIC-2026-1378", "E": "7303022", "F": "Chamado, sendo direcionado. Obrigado !!!",
                "G": "Verificar por que o computador está travando",
                "H": "Meu computador esta travando demais. CPF ***.***.***-**",
                "I": "Camila Vitoria Lopes de Oliveira", "K": "ABC123", "L": "Dell 5440", "M": "Sebrae",
                "N": "Curitiba", "O": "PR", "P": "26/10/2026 17:25",
            },
        )

    def test_sem_cruzamento_unico_serie_modelo_cidade_e_os_ficam_vazios(self):
        for cruz in (None, dash.Cruzamento(dash.CRUZ_AMBIGUO, candidatos=2)):
            linha = dash.montar_linha(CHAMADO, cruz, os_da_serie="7303022")
            self.assertEqual([linha[c] for c in "EKLN"], ["", "", "", ""])

    def test_nao_inclui_manuais_formulas_nem_w(self):
        linha = dash.montar_linha(CHAMADO)
        for coluna in dash.MANUAIS + dash.FORMULAS + dash.INTOCADAS:
            self.assertNotIn(coluna, linha)

    def test_texto_que_comeca_com_formula_ganha_apostrofo(self):
        chamado = ChamadoSoftExpert("UTIC-2026-1", titulo="=HYPERLINK(\"x\")", descricao="-lista", solicitante="+55 @a")
        linha = dash.montar_linha(chamado)
        self.assertEqual((linha["G"][0], linha["H"][0], linha["I"][0]), ("'", "'", "'"))

    def test_descricao_vazia_nao_usa_o_titulo(self):
        chamado = ChamadoSoftExpert("UTIC-2026-1", titulo="Título", descricao="", solicitante="Ana")
        self.assertEqual(dash.montar_linha(chamado)["H"], "")


class CredenciaisTest(unittest.TestCase):
    def test_senha_apos_login_e_senha_rotulada_sao_omitidas(self):
        texto = "Criado o login\n\ncvalente@pr.sebrae.com.br\nSebrae@661"
        self.assertEqual(dash.omitir_credenciais(texto).splitlines()[-1], dash.OMITIDO)
        self.assertIn("cvalente@pr.sebrae.com.br", dash.omitir_credenciais(texto))
        self.assertEqual(dash.omitir_credenciais("Senha: abc123 ok"), "Senha: " + dash.OMITIDO + " ok")

    def test_senha_inicial_do_padrao_sebrae_some_mesmo_na_linha_do_email(self):
        omitido = dash.omitir_credenciais("Login ana@pr.sebrae.com.br senha Sebrae@661 ok")
        self.assertNotIn("661", omitido)
        self.assertIn("ana@pr.sebrae.com.br", omitido)

    def test_lista_de_emails_e_texto_comum_ficam_intactos(self):
        texto = "a@x.com\nb@x.com\nObrigado, tudo certo"
        self.assertEqual(dash.omitir_credenciais(texto), texto)

    def test_linha_montada_nao_carrega_a_senha(self):
        chamado = ChamadoSoftExpert("UTIC-2026-1", detalhes_atendimento_realizado="Criado o login\n\nana@pr.sebrae.com.br\nSebrae@661")
        self.assertNotIn("Sebrae@661", dash.montar_linha(chamado)["F"])


class ColagemTest(unittest.TestCase):
    def test_blocos_a_p_e_r_s_pulam_a_formula_q(self):
        linha = {"A": "Gabriel", "C": "UTIC-2026-1378", "P": "26/10/2026 17:25", "R": "", "S": "SLA"}
        bloco_ap, bloco_rs = dash.linhas_para_colar([linha, {"C": "UTIC-2026-1"}])
        primeira, segunda = bloco_ap.split("\n")
        self.assertEqual(primeira.split("\t")[:3], ["Gabriel", "", "UTIC-2026-1378"])
        self.assertEqual(len(primeira.split("\t")), 16)  # A..P
        self.assertEqual(segunda.split("\t")[2], "UTIC-2026-1")
        self.assertEqual(bloco_rs.split("\n"), ["\tSLA", "\t"])


if __name__ == "__main__":
    unittest.main()
