import tempfile
import unittest
from pathlib import Path

from domains import sebrae_cruzamento, sebrae_novos as novos
from domains.sebrae_chamados import ChamadoSoftExpert

CHAMADO = ChamadoSoftExpert(
    numero="UTIC-2026-1378", titulo="Travando", descricao="Meu CPF 123.456.789-09", solicitante="Camila Lopes",
    habilitada_em="26/10/2026, 17:25:23", detalhes_atendimento_realizado="Criado o login\n\nana@pr.sebrae.com.br\nSebrae@661",
)
REGISTROS = [{"nome": "Camila Lopes", "serie": "ABC123", "modelo": "Dell", "cidade": "Curitiba"}]
RELATORIO = {"chamados": [{"serie": "ABC123", "simpress": {"ordens_servico": ["7303022"]}}]}
MANUAIS = {"A": "CLIENTE", "B": "LENTIDÃO", "D": "em aberto", "J": "incidente", "R": "", "S": "DISPONIBILIDADE"}


class EstadoTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.caminhos = novos.caminhos_padrao(self.dir)

    def test_existentes_ida_e_volta(self):
        self.assertIsNone(novos.ler_existentes(self.caminhos.existentes))
        self.assertEqual(novos.salvar_existentes(self.caminhos.existentes, ["UTIC-2026-2", "UTIC-2026-1", "UTIC-2026-1"], "d.xlsx"), 2)
        lido = novos.ler_existentes(self.caminhos.existentes)
        self.assertEqual((lido["arquivo"], lido["numeros"]), ("d.xlsx", frozenset({"UTIC-2026-1", "UTIC-2026-2"})))

    def test_novos_gravam_texto_ja_mascarado_e_somem_depois_de_lancados(self):
        novos.salvar_novos(self.caminhos.novos, [CHAMADO], [("UTIC-2026-1387", "alerta")], 3, {"UTIC-2026-9": "erro"})
        bruto = self.caminhos.novos.read_text(encoding="utf-8")
        self.assertNotIn("123.456.789-09", bruto)
        self.assertNotIn("Sebrae@661", bruto)
        lido = novos.ler_novos(self.caminhos.novos)
        self.assertEqual([c.numero for c in lido["chamados"]], ["UTIC-2026-1378"])
        self.assertEqual(lido["ignorados"], 3)
        escondido = novos.ler_novos(self.caminhos.novos, ja_lancados={"UTIC-2026-1378", "UTIC-2026-1387"})
        self.assertEqual((escondido["chamados"], escondido["pendentes"]), ([], []))

    def test_arquivo_ausente_ou_corrompido_devolve_none(self):
        self.assertIsNone(novos.ler_novos(self.caminhos.novos))
        self.caminhos.novos.write_text("{", encoding="utf-8")
        self.assertIsNone(novos.ler_novos(self.caminhos.novos))


class FormularioTest(unittest.TestCase):
    def test_cruzamento_unico_preenche_serie_modelo_cidade_e_os(self):
        item = novos.formulario([CHAMADO], REGISTROS, RELATORIO)[0]
        self.assertEqual((item["linha"]["K"], item["linha"]["L"], item["linha"]["N"], item["linha"]["E"]), ("ABC123", "Dell", "Curitiba", "7303022"))
        self.assertEqual(item["cruzamento"], {"status": "unico", "candidatos": 1})

    def test_nome_da_descricao_liga_o_equipamento_de_quem_o_chamado_foi_aberto(self):
        duas = REGISTROS + [{"nome": "Ícaro Gabriel Duarte Campos", "serie": "XYZ9", "modelo": "HP", "cidade": "Maringá"}]
        para_outro = ChamadoSoftExpert(numero="UTIC-2026-1188", descricao="Abri para o icaro gabriel duarte campos (UCS), teclado.", solicitante="Camila Lopes")
        item = novos.formulario([para_outro], duas, RELATORIO)[0]
        self.assertEqual([item["linha"][c] for c in "KLN"], ["XYZ9", "HP", "Maringá"])  # the cited person, not the requester
        self.assertEqual((item["cruzamento"]["status"], item["nome_da_descricao"], item["outra_pessoa"]), ("unico", "Ícaro Gabriel Duarte Campos", ""))
        proprio = ChamadoSoftExpert(numero="UTIC-2026-1189", descricao="Camila Lopes sem rede", solicitante="Camila Lopes")
        item = novos.formulario([proprio], duas, RELATORIO)[0]
        self.assertEqual((item["linha"]["K"], item["nome_da_descricao"], item["outra_pessoa"]), ("ABC123", "", ""))

    def test_solicitante_sem_equipamento_usa_o_nome_da_descricao(self):
        api = ChamadoSoftExpert(numero="UTIC-2026-1190", descricao="Nome do(a) colaborador(a): Camila Lopes Horário: 09h", solicitante="API SEBRAE")
        item = novos.formulario([api], REGISTROS, RELATORIO)[0]
        self.assertEqual((item["linha"]["K"], item["linha"]["E"]), ("ABC123", "7303022"))

    def test_duas_pessoas_na_descricao_nao_preenche_e_avisa(self):
        duas = REGISTROS + [{"nome": "Ícaro Gabriel Duarte Campos", "serie": "XYZ9", "modelo": "HP", "cidade": "Maringá"}]
        dupla = ChamadoSoftExpert(numero="UTIC-2026-1191", descricao="Camila Lopes e Icaro Gabriel Duarte Campos", solicitante="API SEBRAE")
        item = novos.formulario([dupla], duas, RELATORIO)[0]
        self.assertEqual([item["linha"][c] for c in "EKLN"], ["", "", "", ""])
        self.assertEqual((item["cruzamento"]["status"], item["nome_da_descricao"], item["outra_pessoa"]), ("ausente", "", "Camila Lopes"))

    def test_nome_dentro_de_nome_maior_conta_como_uma_pessoa(self):
        reg = [{"nome": "Ana Souza", "serie": "A1"}, {"nome": "Ana Souza Lima", "serie": "B2"}]
        self.assertEqual(sebrae_cruzamento.pessoas_citadas("Para Ana Souza Lima", "API SEBRAE", reg), ["Ana Souza Lima"])

    def test_sem_registros_fica_vazio_e_ausente(self):
        item = novos.formulario([CHAMADO], [], None)[0]
        self.assertEqual([item["linha"][c] for c in "EKLN"], ["", "", "", ""])
        self.assertEqual(item["cruzamento"]["status"], "ausente")


class PreenchimentosTest(unittest.TestCase):
    def aberto(self, usuario="Camila Lopes", **atuais):
        return {"numero": "linha:2", "usuario": usuario, "automaticos": {"E": "", "K": "", "L": "", "N": "", **atuais}}

    def test_nome_unico_preenche_serie_modelo_cidade_e_os(self):
        self.assertEqual(
            novos.preenchimentos([self.aberto()], REGISTROS, RELATORIO),
            {"linha:2": {"K": "ABC123", "L": "Dell", "N": "Curitiba", "E": "7303022"}},
        )

    def test_so_preenche_o_que_esta_vazio_e_nao_mistura_com_outra_serie(self):
        self.assertEqual(novos.preenchimentos([self.aberto(L="HP")], REGISTROS, RELATORIO)["linha:2"].keys(), {"K", "N", "E"})
        self.assertEqual(novos.preenchimentos([self.aberto(K="abc123", L="Dell", N="Curitiba", E="1")], REGISTROS, RELATORIO), {})
        outra = novos.preenchimentos([self.aberto(K="ZZZ999")], REGISTROS, RELATORIO)
        self.assertNotIn("linha:2", outra)  # different serial: K, L and N stay; no OS known for it

    def test_os_vem_da_serie_que_a_linha_ja_tem_mesmo_sem_nome(self):
        self.assertEqual(novos.preenchimentos([self.aberto(usuario="", K="ABC123", L="Dell", N="X")], REGISTROS, RELATORIO), {"linha:2": {"E": "7303022"}})

    def test_aberto_para_outra_pessoa_preenche_pelo_nome_da_descricao(self):
        duas = REGISTROS + [{"nome": "Ícaro Gabriel Duarte Campos", "serie": "XYZ9", "modelo": "HP", "cidade": "Maringá"}]
        item = {**self.aberto(), "descricao": "Aberto para Icaro Gabriel Duarte Campos"}
        self.assertEqual(novos.preenchimentos([item], duas, RELATORIO), {"linha:2": {"K": "XYZ9", "L": "HP", "N": "Maringá"}})  # no OS known for XYZ9
        com_serie = {**item, "automaticos": {"E": "", "K": "ABC123", "L": "", "N": ""}}
        self.assertEqual(novos.preenchimentos([com_serie], duas, RELATORIO), {"linha:2": {"E": "7303022"}})  # a serial already in the row is never replaced
        self.assertEqual(novos.preenchimentos([{**self.aberto(), "descricao": "Camila Lopes sem rede"}], duas, RELATORIO).keys(), {"linha:2"})

    def test_aberto_com_duas_pessoas_na_descricao_nao_preenche(self):
        duas = REGISTROS + [{"nome": "Ícaro Gabriel Duarte Campos", "serie": "XYZ9", "modelo": "HP", "cidade": "Maringá"}]
        item = {**self.aberto(usuario="API SEBRAE"), "descricao": "Camila Lopes e Icaro Gabriel Duarte Campos"}
        self.assertEqual(novos.preenchimentos([item], duas, RELATORIO), {})

    def test_estado_antigo_sem_usuario_nem_automaticos_nao_quebra(self):
        self.assertEqual(novos.preenchimentos([{"numero": "UTIC-2026-0001", "titulo": "x", "valores": {}}], REGISTROS, RELATORIO), {})

    def test_nome_ausente_ou_ambiguo_nao_preenche(self):
        duplicado = REGISTROS + [{"nome": "Camila Lopes", "serie": "OUTRA1", "modelo": "HP", "cidade": "Maringá"}]
        self.assertEqual(novos.preenchimentos([self.aberto()], duplicado, RELATORIO), {})
        self.assertEqual(novos.preenchimentos([self.aberto(usuario="Fulano")], REGISTROS, RELATORIO), {})
        self.assertEqual(novos.preenchimentos([self.aberto()], [], None), {})


class ExportarTest(unittest.TestCase):
    def test_gera_blocos_com_manuais_normalizados_e_a_mensagem_aprovada(self):
        saida = novos.exportar([CHAMADO], {CHAMADO.numero: MANUAIS}, REGISTROS, RELATORIO)
        primeira = saida["bloco_a_p"].split("\t")
        self.assertEqual((primeira[0], primeira[3], primeira[9]), ("CLIENTE", "EM ABERTO", "INCIDENTE"))
        self.assertEqual(saida["bloco_r_s"], "\tDISPONIBILIDADE")
        self.assertEqual(saida["mensagem"], "Planilha Exportada com Sucesso!")
        self.assertNotIn("Sebrae@661", saida["bloco_a_p"])

    def test_recusa_campos_faltando_ou_invalidos(self):
        for manuais, trecho in (
            ({**MANUAIS, "A": ""}, "RESPONSÁVEL"),
            ({**MANUAIS, "D": "TALVEZ"}, "STATUS"),
            ({**MANUAIS, "J": ""}, "TIPO DO CHAMADO"),
            ({**MANUAIS, "R": "ontem"}, "DT ENCERRAMENTO"),
            ({**MANUAIS, "B": "x" * 81}, "80"),
        ):
            with self.assertRaisesRegex(novos.ManuaisInvalidos, trecho):
                novos.exportar([CHAMADO], {CHAMADO.numero: manuais}, REGISTROS, RELATORIO)
        with self.assertRaisesRegex(novos.ManuaisInvalidos, "Preencha"):
            novos.exportar([CHAMADO], {}, REGISTROS, RELATORIO)
        with self.assertRaisesRegex(novos.ManuaisInvalidos, "Não há chamados"):
            novos.exportar([], {}, REGISTROS, RELATORIO)

    def test_sem_exigir_a_d_j_vazios_passam_mas_preenchidos_invalidos_falham(self):
        vazios = novos.validar_manuais({}, exigir=False)
        self.assertEqual([vazios[c] for c in "ADJ"], ["", "", ""])
        self.assertEqual(novos.validar_manuais({"D": "finalizado", "J": "solicitação"}, exigir=False)["D"], "FINALIZADO")
        for manuais, trecho in (
            ({"D": "TALVEZ"}, "STATUS"), ({"J": "OUTRO"}, "TIPO DO CHAMADO"),
            ({"R": "ontem"}, "DT ENCERRAMENTO"), ({"B": "x" * 81}, "80"),
        ):
            with self.assertRaisesRegex(novos.ManuaisInvalidos, trecho):
                novos.validar_manuais(manuais, exigir=False)
        with self.assertRaisesRegex(novos.ManuaisInvalidos, "RESPONSÁVEL"):
            novos.validar_manuais({})  # strict by default

    def test_linhas_completas_sem_exigir_aceita_chamado_ausente_e_exportar_segue_estrito(self):
        linha = novos.linhas_completas([CHAMADO], {}, REGISTROS, RELATORIO, exigir=False)[0]
        self.assertEqual([linha[c] for c in "ADJ"], ["", "", ""])
        self.assertEqual(linha["C"], CHAMADO.numero)
        with self.assertRaisesRegex(novos.ManuaisInvalidos, "STATUS"):
            novos.linhas_completas([CHAMADO], {CHAMADO.numero: {"D": "TALVEZ"}}, REGISTROS, RELATORIO, exigir=False)
        with self.assertRaisesRegex(novos.ManuaisInvalidos, "Preencha"):
            novos.linhas_completas([CHAMADO], {}, REGISTROS, RELATORIO)
        with self.assertRaisesRegex(novos.ManuaisInvalidos, "RESPONSÁVEL"):
            novos.exportar([CHAMADO], {CHAMADO.numero: {**MANUAIS, "A": ""}}, REGISTROS, RELATORIO)

    def test_texto_manual_que_parece_formula_ganha_apostrofo(self):
        saida = novos.exportar([CHAMADO], {CHAMADO.numero: {**MANUAIS, "B": "=1+1"}}, REGISTROS, RELATORIO)
        self.assertEqual(saida["bloco_a_p"].split("\t")[1], "'=1+1")


if __name__ == "__main__":
    unittest.main()
