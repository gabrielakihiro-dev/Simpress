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
    def test_alertas_do_endpoint_tambem_sao_novos(self):
        titulos = {
            "UTIC-2026-0094": "Já lançado",
            "UTIC-2026-1378": "Verificar por que o computador está travando",
            "UTIC-2026-1387": "Endpoint Central - Reactivated Computer(s) Added Back to ...",
            "UTIC-2026-1253": "Endpoint Central - Computer(s) Added to \"Staged\" Page",
        }
        resultado = dash.triar_novos(titulos, {"UTIC-2026-0094"})
        self.assertEqual(set(resultado.novos), {"UTIC-2026-1378", "UTIC-2026-1387", "UTIC-2026-1253"})
        self.assertEqual(resultado.ignorados, ("UTIC-2026-0094",))
        self.assertEqual(resultado.pendentes, ())


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

    def test_descricao_editada_no_site_que_comeca_com_formula_ganha_apostrofo_na_coluna_h(self):
        from domains.sebrae_novos import aplicar_descricoes_novos, descricao_segura
        chamado = ChamadoSoftExpert("UTIC-2026-1", titulo="T", descricao="original", solicitante="Ana")
        editado = aplicar_descricoes_novos([chamado], {"UTIC-2026-1": descricao_segura("=1+1 CPF 123.456.789-09")})[0]
        h = dash.montar_linha(editado)["H"]
        self.assertTrue(h.startswith("'=1+1"), h)
        self.assertNotIn("123.456.789-09", h)

    def test_descricao_vazia_nao_usa_o_titulo(self):
        chamado = ChamadoSoftExpert("UTIC-2026-1", titulo="Título", descricao="", solicitante="Ana")
        self.assertEqual(dash.montar_linha(chamado)["H"], "")


class CredenciaisTest(unittest.TestCase):
    def test_descricao_ficticia_e_passphrase_sao_tratadas_sem_vazamento_parcial(self):
        for texto, esperado in (
            ("A senha fictícia foi alterada com sucesso", "A senha fictícia foi alterada com sucesso"),
            ("senha fictícia foi alterada para segredo", "senha fictícia foi alterada para " + dash.OMITIDO),
            ("senha fictícia é frase secreta", "senha fictícia é " + dash.OMITIDO),
            ("senha fictícia e frase secreta para acesso", "senha fictícia e " + dash.OMITIDO + " para acesso"),
        ):
            with self.subTest(texto=texto):
                self.assertEqual(dash.omitir_credenciais(texto), esperado)
                self.assertEqual(dash.omitir_credenciais(esperado), esperado)

    def test_senhas_ficticias_e_de_teste_sao_omitidas(self):
        for texto in ("A senha fictícia é TokenSintetico123", "A senha ficticia é TokenSintetico123", "senha de teste é TokenSintetico123"):
            with self.subTest(texto=texto):
                esperado = texto.replace("TokenSintetico123", dash.OMITIDO)
                self.assertEqual(dash.omitir_credenciais(texto), esperado)
                chamado = ChamadoSoftExpert("UTIC-2026-1", detalhes_atendimento_realizado=texto)
                self.assertEqual(dash.montar_linha(chamado)["F"], esperado)

    def test_senha_minuscula_apos_e_preserva_contexto(self):
        for texto, esperado in (
            ("senha e segredo para acesso", "senha e " + dash.OMITIDO + " para acesso"),
            ("password e abc para acesso.", "password e " + dash.OMITIDO + " para acesso."),
        ):
            with self.subTest(texto=texto):
                self.assertEqual(dash.omitir_credenciais(texto), esperado)
                self.assertEqual(dash.omitir_credenciais(esperado), esperado)
                chamado = ChamadoSoftExpert("UTIC-2026-1", detalhes_atendimento_realizado=texto)
                self.assertEqual(dash.montar_linha(chamado)["F"], esperado)

    def test_valor_simples_minusculo_apos_e_e_omitido(self):
        for texto, esperado in (
            ("senha e segredo", "senha e " + dash.OMITIDO),
            ("password e segredo", "password e " + dash.OMITIDO),
        ):
            with self.subTest(texto=texto):
                self.assertEqual(dash.omitir_credenciais(texto), esperado)

    def test_e_gramatical_e_marcador_existente_sao_preservados(self):
        for texto in (
            "A senha e o usuário foram alterados",
            "senha fictícia e frase secreta",
            "O usuário esqueceu a senha e precisa de ajuda",
            "O usuário esqueceu a senha e solicitou ajuda",
            "O usuário esqueceu a senha e não consegue entrar",
            "O usuário perdeu a senha e precisa redefinir o acesso.",
        ):
            with self.subTest(texto=texto):
                self.assertEqual(dash.omitir_credenciais(texto), texto)
        for texto in ("senha e Segredo123 para acesso", "senha e sebrae@123 para acesso", "senha e " + dash.OMITIDO + " para acesso"):
            with self.subTest(texto=texto):
                limpo = dash.omitir_credenciais(texto)
                self.assertEqual(limpo, "senha e " + dash.OMITIDO + " para acesso")
                self.assertEqual(dash.omitir_credenciais(limpo), limpo)

    def test_narrativa_de_ajuda_para_acesso_e_preservada_na_coluna_f(self):
        texto = "O usuário esqueceu a senha e solicitou ajuda para acesso"
        self.assertEqual(dash.omitir_credenciais(texto), texto)
        chamado = ChamadoSoftExpert("UTIC-2026-1", detalhes_atendimento_realizado=texto)
        self.assertEqual(dash.montar_linha(chamado)["F"], texto)

    def test_senha_explicita_apos_continuacao_gramatical_ainda_e_omitida(self):
        texto = "O usuário esqueceu a senha e precisa de ajuda; password: Segredo123"
        self.assertEqual(dash.omitir_credenciais(texto), "O usuário esqueceu a senha e precisa de ajuda; password: " + dash.OMITIDO)

    def test_credenciais_simples_apos_rotulos_e_verbos_sao_omitidas(self):
        for rotulo in ("senha", "senha é", "password é", "senha eh", "senha foi", "senha será"):
            for segredo in ("segredo", "Segredo123", "abc", "segura"):
                with self.subTest(rotulo=rotulo, segredo=segredo):
                    texto = rotulo + " " + segredo
                    self.assertEqual(dash.omitir_credenciais(texto), rotulo + " " + dash.OMITIDO)
                    chamado = ChamadoSoftExpert("UTIC-2026-1", detalhes_atendimento_realizado=texto)
                    self.assertEqual(dash.montar_linha(chamado)["F"], rotulo + " " + dash.OMITIDO)

    def test_senha_alterada_para_palavra_minuscula_e_omitida(self):
        self.assertEqual(dash.omitir_credenciais("senha foi alterada para segredo"), "senha foi alterada para " + dash.OMITIDO)

    def test_rotulo_simples_sem_separador_omite_senha(self):
        for rotulo in ("Senha", "password", "senha atual é", "senha nova:", "senha antiga:"):
            with self.subTest(rotulo=rotulo):
                self.assertEqual(dash.omitir_credenciais(rotulo + " Segredo123"), rotulo + " " + dash.OMITIDO)

    def test_senhas_qualificadas_com_maiusculas_ou_simbolos_sao_omitidas(self):
        for segredo in ("SENHASECRETA", "abcDEF", "!@#abc", "abc#def", "123ABC", "abc!", "abcdefgh"):
            with self.subTest(segredo=segredo):
                self.assertEqual(dash.omitir_credenciais("senha temporária " + segredo), "senha temporária " + dash.OMITIDO)

    def test_senha_explicita_apos_mencao_ambigua_e_omitida(self):
        for prefixo, credencial in (("senha temporária forte; ", "senha: Segredo123"), ("senha de acesso do sistema; ", "password=Segredo123")):
            with self.subTest(prefixo=prefixo):
                omitido = dash.omitir_credenciais(prefixo + credencial)
                self.assertTrue(omitido.startswith(prefixo))
                self.assertNotIn("Segredo123", omitido)
                self.assertIn(dash.OMITIDO, omitido)

    def test_senha_com_espacos_e_na_proxima_linha_nao_vaza_e_preserva_contexto(self):
        for texto in ("senha: frase secreta", "Contexto\nsenha:\n\nfrase secreta\nFim", "Senha\nSegredo123", "password\nSegredo123", "Senha\n\nSegredo123", "password\n\nSegredo123", "Senha é:\nSegredo123", "A senha temporária é\nSegredo123", "Senha padrão:\nSegredo123"):
            with self.subTest(texto=texto):
                omitido = dash.omitir_credenciais(texto)
                self.assertNotIn("frase", omitido)
                self.assertNotIn("secreta", omitido)
                self.assertNotIn("Segredo123", omitido)
                self.assertIn(dash.OMITIDO, omitido)
                if "Contexto" in texto:
                    self.assertIn("Contexto", omitido)
                    self.assertIn("Fim", omitido)

    def test_mencao_sem_credencial_preserva_o_texto(self):
        for texto in ("Como criar uma senha forte?", "O usuário esqueceu a senha e precisa redefinir o acesso.", "password_hint: nome do primeiro animal", "Senha temporária forte?", "Senha de acesso do sistema", "Senha de acesso 2FA habilitada", "senha de acesso 2fa habilitada", "A senha esquecida impede o acesso.", "senha atualizada com sucesso", "senha foi alterada", "senha foi alterada\nContexto preservado"):
            with self.subTest(texto=texto):
                self.assertEqual(dash.omitir_credenciais(texto), texto)

    def test_senhas_em_linguagem_natural_sao_omitidas(self):
        for texto in ("senha é Segredo123", "password é Segredo123", "a senha temporária foi Segredo123", "passwd será Segredo123", "a senha de acesso e Segredo123", "A senha foi alterada para Segredo123", "Senha de acesso Segredo123", "Senha temporária Segredo123", "Senha temporária 123456", "Senha de acesso Segredo"):
            with self.subTest(texto=texto):
                omitido = dash.omitir_credenciais(texto)
                self.assertNotIn("Segredo123", omitido)
                self.assertNotIn("123456", omitido)
                if texto == "Senha de acesso Segredo":
                    self.assertNotIn("Segredo", omitido)
                self.assertIn(dash.OMITIDO, omitido)

    def test_senha_apos_login_e_senha_rotulada_sao_omitidas(self):
        texto = "Criado o login\n\ncvalente@pr.sebrae.com.br\nSebrae@661"
        self.assertEqual(dash.omitir_credenciais(texto).splitlines()[-1], dash.OMITIDO)
        self.assertIn("cvalente@pr.sebrae.com.br", dash.omitir_credenciais(texto))
        self.assertEqual(dash.omitir_credenciais("Senha: abc123 ok"), "Senha: " + dash.OMITIDO)

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
