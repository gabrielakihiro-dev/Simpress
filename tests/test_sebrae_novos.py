import tempfile
import unittest
from pathlib import Path

from domains import sebrae_cruzamento, sebrae_novos as novos
from domains.sebrae_chamados import ChamadoSoftExpert

CHAMADO = ChamadoSoftExpert(
    numero="UTIC-2026-1378", titulo="Travando", descricao="Meu CPF 123.456.789-09", solicitante="Camila Lopes",
    habilitada_em="26/10/2026, 17:25:23", detalhes_atendimento_realizado="Criado o login\n\nana@pr.sebrae.com.br\nSebrae@000",
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

    def test_abertos_lidos_na_ordem_da_coluna_c_mesmo_gravados_fora_de_ordem(self):
        def aberto(numero, chamado):
            return {"numero": numero, "linha": 2, "titulo": numero, "chamado": chamado}
        gravados = [
            aberto("UTIC-2026-0010", "UTIC-2026-0010"), aberto("linha:3", ""), aberto("29474", "29474"),
            aberto("utic-2026-0002", "utic-2026-0002"), aberto("linha:5", "  "), aberto("999", "999"),
            aberto("UTIC-2026-0001", "UTIC-2026-0001"), aberto("UTIC20260001", "UTIC20260001"),  # same key: keeps the stored order
        ]
        novos.salvar_existentes(self.caminhos.existentes, [], "d.xlsx", abertos=gravados)
        # numbers by value, then text (no case, hyphen or apostrophe), then empty
        self.assertEqual([a["numero"] for a in novos.ler_existentes(self.caminhos.existentes)["abertos"]], [
            "999", "29474", "UTIC-2026-0001", "UTIC20260001", "utic-2026-0002", "UTIC-2026-0010", "linha:3", "linha:5",
        ])

    def test_novos_lidos_na_ordem_da_coluna_c_e_o_filtro_de_lancados_continua(self):
        def chamado(numero):
            return ChamadoSoftExpert(numero=numero, titulo=numero)
        novos.salvar_novos(self.caminhos.novos, [chamado(n) for n in ("UTIC-2026-0010", "", "UTIC-2026-0002", "123", "utic-2026-0001", "UTIC-2026-0003")], [], 0, {})
        self.assertEqual([c.numero for c in novos.ler_novos(self.caminhos.novos)["chamados"]], [
            "123", "utic-2026-0001", "UTIC-2026-0002", "UTIC-2026-0003", "UTIC-2026-0010", "",
        ])
        restantes = novos.ler_novos(self.caminhos.novos, ja_lancados={"UTIC-2026-0002"})["chamados"]
        self.assertEqual([c.numero for c in restantes], ["123", "utic-2026-0001", "UTIC-2026-0003", "UTIC-2026-0010", ""])

    def test_versao_so_muda_quando_o_conteudo_do_dashboard_muda(self):
        def importar(arquivo, sha):
            novos.salvar_existentes(self.caminhos.existentes, ["UTIC-2026-1"], arquivo, sha256=sha)
            return novos.ler_existentes(self.caminhos.existentes)["versao"]
        primeira = importar("a.xlsx", "aa" * 32)
        self.assertEqual(importar("b.xlsx", "aa" * 32), primeira)
        self.assertNotEqual(importar("c.xlsx", "bb" * 32), primeira)

    def test_novos_gravam_texto_ja_mascarado_e_somem_depois_de_lancados(self):
        novos.salvar_novos(self.caminhos.novos, [CHAMADO], [("UTIC-2026-1387", "alerta")], 3, {"UTIC-2026-9": "erro"})
        bruto = self.caminhos.novos.read_text(encoding="utf-8")
        self.assertNotIn("123.456.789-09", bruto)
        self.assertNotIn("Sebrae@000", bruto)
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


class AntigosComplementadosTest(unittest.TestCase):
    def test_i_vazio_usa_descricao_e_solicitante_do_softexpert_e_o_dashboard_vence_quando_preenchido(self):
        abertos = [
            {"numero": "UTIC-2026-0010", "usuario": "", "descricao": "", "automaticos": {"E": "", "K": "", "L": "", "N": ""}},
            {"numero": "UTIC-2026-0011", "usuario": "Ana", "descricao": "da planilha", "automaticos": {}},
        ]
        antigos = {n: {"descricao": "Para Camila Lopes", "solicitante": "API SEBRAE"} for n in ("UTIC-2026-0010", "UTIC-2026-0011")}
        efetivos = novos.complementar_antigos(abertos, antigos)
        self.assertEqual((efetivos[0]["descricao"], efetivos[0]["usuario"]), ("Para Camila Lopes", "API SEBRAE"))
        self.assertEqual((efetivos[1]["descricao"], efetivos[1]["usuario"]), ("da planilha", "Ana"))
        self.assertEqual(novos.complementar_antigos(abertos, {})[0], abertos[0])
        self.assertEqual(
            novos.preenchimentos(efetivos, REGISTROS, RELATORIO)["UTIC-2026-0010"],
            {"K": "ABC123", "L": "Dell", "N": "Curitiba", "E": "7303022"},
        )
        self.assertEqual(novos.preenchimentos(abertos, REGISTROS, RELATORIO), {})  # sem leitura, nada é achado


class PreenchimentosSoftExpertTest(unittest.TestCase):
    LIDO = {"titulo": "Abrir chamado", "descricao": "Notebook de Camila Lopes não liga", "solicitante": "API SEBRAE"}

    def test_g_e_i_vazios_vem_da_leitura_e_o_dashboard_vence_quando_preenchido(self):
        vazio = {"numero": "UTIC-2026-0010", "titulo": "", "usuario": "", "descricao": "texto da planilha"}
        cheio = {"numero": "UTIC-2026-0011", "titulo": "Do Dashboard", "usuario": "Ana", "descricao": ""}
        antigos = {"UTIC-2026-0010": self.LIDO, "UTIC-2026-0011": self.LIDO}
        self.assertEqual(novos.preenchimentos_softexpert([vazio, cheio], antigos),
                         {"UTIC-2026-0010": {"G": "Abrir chamado", "I": "API SEBRAE"}})
        self.assertEqual(novos.preenchimentos_softexpert([vazio], {}), {})  # sem leitura, nada

    def test_titulo_em_h_vira_g_e_h_recebe_a_descricao_lida(self):
        aberto = {"numero": "UTIC-2026-0833", "titulo": "", "usuario": "", "descricao": "  abrir   CHAMADO "}
        self.assertEqual(novos.preenchimentos_softexpert([aberto], {"UTIC-2026-0833": self.LIDO}),
                         {"UTIC-2026-0833": {"G": "Abrir chamado", "H": "Notebook de Camila Lopes não liga", "I": "API SEBRAE"}})
        # the name cross-reference reads the description, not the title left in H
        self.assertEqual(novos.complementar_antigos([aberto], {"UTIC-2026-0833": self.LIDO})[0]["descricao"], self.LIDO["descricao"])

    def test_h_so_troca_com_g_vazio_e_descricao_lida_diferente_do_titulo(self):
        com_g = {"numero": "U", "titulo": "Abrir chamado", "usuario": "Ana", "descricao": "Abrir chamado"}
        self.assertEqual(novos.preenchimentos_softexpert([com_g], {"U": self.LIDO}), {})
        h_proprio = {"numero": "U", "titulo": "", "usuario": "Ana", "descricao": "outro texto"}
        self.assertEqual(novos.preenchimentos_softexpert([h_proprio], {"U": self.LIDO}), {"U": {"G": "Abrir chamado"}})
        sem_descricao = {**self.LIDO, "descricao": ""}
        aberto = {"numero": "U", "titulo": "", "usuario": "Ana", "descricao": "Abrir chamado"}
        self.assertEqual(novos.preenchimentos_softexpert([aberto], {"U": sem_descricao}), {"U": {"G": "Abrir chamado"}})
        igual = {**self.LIDO, "descricao": "abrir chamado"}
        self.assertEqual(novos.preenchimentos_softexpert([aberto], {"U": igual}), {"U": {"G": "Abrir chamado"}})


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

    def test_os_do_vinculo_manual_do_utic_preenche_e_so_em_celula_vazia(self):
        vinculos = [{"chamado": "UTIC-2026-0094", "os": "555"}]
        item = {**self.aberto(usuario=""), "numero": "UTIC-2026-0094"}
        self.assertEqual(novos.preenchimentos([item], REGISTROS, RELATORIO, vinculos), {"UTIC-2026-0094": {"E": "555"}})  # even without a serial
        cheio = {**item, "automaticos": {"E": "999", "K": "", "L": "", "N": ""}}
        self.assertEqual(novos.preenchimentos([cheio], REGISTROS, RELATORIO, vinculos), {})
        sem_vinculo = {**self.aberto(usuario="", K="ABC123", L="Dell", N="X"), "numero": "UTIC-2026-0095"}
        self.assertEqual(novos.preenchimentos([sem_vinculo], REGISTROS, RELATORIO, vinculos), {"UTIC-2026-0095": {"E": "7303022"}})

    def test_macbook_com_ou_sem_s_acha_a_os_pela_equivalencia_e_nao_troca_valores(self):
        relatorio = {"chamados": [{"serie": "CXC9F072K1", "simpress": {"ordens_servico": ["77"]}}]}
        indice = {"unique": {"CXC9F072K1": "PRMAC001"}, "details_serials": {"SCXC9F072K1"}}
        com_s = self.aberto(usuario="", K="SCXC9F072K1", L="Mac", N="X")
        self.assertEqual(novos.preenchimentos([com_s], REGISTROS, relatorio), {})  # sem índice, série exata não acha
        self.assertEqual(novos.preenchimentos([com_s], REGISTROS, relatorio, indice_endpoint=indice), {"linha:2": {"E": "77"}})
        sem_s = self.aberto(usuario="", K="CXC9F072K1", L="Mac", N="X")
        relatorio_s = {"chamados": [{"serie": "SCXC9F072K1", "simpress": {"ordens_servico": ["88"]}}]}
        self.assertEqual(novos.preenchimentos([sem_s], REGISTROS, relatorio_s, indice_endpoint=indice), {"linha:2": {"E": "88"}})
        preenchido = self.aberto(usuario="", K="SCXC9F072K1", L="Mac", N="X", E="5")
        self.assertEqual(novos.preenchimentos([preenchido], REGISTROS, relatorio, indice_endpoint=indice), {})
        self.assertEqual(com_s["automaticos"]["K"], "SCXC9F072K1")

    def test_macbook_ambiguo_ou_serie_exata_com_os_nao_usa_a_equivalencia(self):
        relatorio = {"chamados": [{"serie": "CXC9F072K1", "simpress": {"ordens_servico": ["77"]}}]}
        ambiguo = {"unique": {"CXC9F072K1": "PRMAC001"}, "details_serials": {"SCXC9F072K1", "CXC9F072K1"}}
        com_s = self.aberto(usuario="", K="SCXC9F072K1", L="Mac", N="X")
        self.assertEqual(novos.preenchimentos([com_s], REGISTROS, relatorio, indice_endpoint=ambiguo), {})
        nao_mac = {"unique": {"CXC9F072K1": "PRNOTE001"}, "details_serials": {"SCXC9F072K1"}}
        self.assertEqual(novos.preenchimentos([com_s], REGISTROS, relatorio, indice_endpoint=nao_mac), {})
        dois = {"chamados": relatorio["chamados"] + [{"serie": "SCXC9F072K1", "simpress": {"ordens_servico": ["99"]}}]}
        indice = {"unique": {"CXC9F072K1": "PRMAC001"}, "details_serials": {"SCXC9F072K1"}}
        self.assertEqual(novos.preenchimentos([com_s], REGISTROS, dois, indice_endpoint=indice), {"linha:2": {"E": "99"}})  # exact wins

    def test_formulario_usa_o_vinculo_manual_antes_da_serie(self):
        item = novos.formulario([CHAMADO], REGISTROS, RELATORIO, [{"chamado": "UTIC-2026-1378", "os": "555"}])[0]
        self.assertEqual(item["linha"]["E"], "555")

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
        self.assertNotIn("Sebrae@000", saida["bloco_a_p"])

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

    def test_b_aceita_categorias_novas_aprovadas_fora_da_lista_importada(self):
        listas = {"A": ["SIMPRESS"], "B": ["INSTALAÇÃO", "OUTRO"]}
        for categoria in ("REDE", "IMPRESSORA", "LICENÇA", "SISTEMA"):
            novos.validar_listas({"B": categoria}, listas)
        with self.assertRaisesRegex(novos.ManuaisInvalidos, "coluna B"):
            novos.validar_listas({"B": "QUALQUER"}, listas)
        with self.assertRaisesRegex(novos.ManuaisInvalidos, "coluna A"):
            novos.validar_listas({"A": "REDE"}, listas)  # só B ganha as categorias novas

    def test_envio_aceita_categoria_nova_e_recusa_valor_fora_das_listas(self):
        listas = {"A": ["CLIENTE"], "B": ["INSTALAÇÃO", "OUTRO"]}
        linha = novos.linhas_completas([CHAMADO], {CHAMADO.numero: {**MANUAIS, "B": "IMPRESSORA"}}, REGISTROS, RELATORIO, listas=listas, exigir=False)[0]
        self.assertEqual(linha["B"], "IMPRESSORA")
        with self.assertRaisesRegex(novos.ManuaisInvalidos, "coluna B"):
            novos.linhas_completas([CHAMADO], {CHAMADO.numero: {**MANUAIS, "B": "QUALQUER"}}, REGISTROS, RELATORIO, listas=listas, exigir=False)

    def test_texto_manual_que_parece_formula_ganha_apostrofo(self):
        saida = novos.exportar([CHAMADO], {CHAMADO.numero: {**MANUAIS, "B": "=1+1"}}, REGISTROS, RELATORIO)
        self.assertEqual(saida["bloco_a_p"].split("\t")[1], "'=1+1")

    def test_titulo_digitado_no_site_vale_na_linha_e_em_branco_mantem_o_do_softexpert(self):
        def linha(**extra):
            return novos.linhas_completas([CHAMADO], {CHAMADO.numero: {**MANUAIS, **extra}}, REGISTROS, RELATORIO, exigir=False)[0]
        self.assertEqual(linha()["G"], "Travando")
        self.assertEqual(linha(G="")["G"], "Travando")
        self.assertEqual(linha(G="   \n  ")["G"], "Travando")
        self.assertEqual(linha(G="  Sem   rede  na sala 4 ")["G"], "Sem rede na sala 4")
        self.assertEqual(linha(G="x" * novos.MAX_TITULO)["G"], "x" * novos.MAX_TITULO)

    def test_titulo_digitado_e_mascarado_e_nunca_vira_formula(self):
        linha = novos.linhas_completas([CHAMADO], {CHAMADO.numero: {**MANUAIS, "G": "CPF 123.456.789-09 senha Sebrae@000"}}, REGISTROS, RELATORIO, exigir=False)[0]
        self.assertNotIn("123.456.789-09", linha["G"])
        self.assertIn("***.***.***-**", linha["G"])
        self.assertNotIn("Sebrae@000", linha["G"])
        self.assertEqual(novos.linhas_completas([CHAMADO], {CHAMADO.numero: {**MANUAIS, "G": "=1+1"}}, REGISTROS, RELATORIO, exigir=False)[0]["G"], "'=1+1")
        saida = novos.exportar([CHAMADO], {CHAMADO.numero: {**MANUAIS, "G": "Novo título"}}, REGISTROS, RELATORIO)
        self.assertEqual(saida["bloco_a_p"].split("\t")[6], "Novo título")

    def test_titulo_longo_demais_e_recusado_e_o_dashboard_nao_o_tem_como_manual(self):
        with self.assertRaisesRegex(novos.ManuaisInvalidos, "UTIC-2026-1378: A coluna G aceita até 300"):
            novos.linhas_completas([CHAMADO], {CHAMADO.numero: {**MANUAIS, "G": "x" * (novos.MAX_TITULO + 1)}}, REGISTROS, RELATORIO, exigir=False)
        self.assertNotIn("G", novos.validar_manuais({**MANUAIS, "G": "qualquer"}))  # G is handled apart from the manual columns


class MapearChavesDeLinhaTest(unittest.TestCase):
    @staticmethod
    def item(numero, titulo="", chamado="Sem chamado", usuario="", descricao=""):
        return {"numero": numero, "chamado": chamado, "titulo": titulo, "usuario": usuario, "descricao": descricao}

    def test_cada_chave_de_linha_vai_para_a_chave_do_mesmo_chamado(self):
        antes = [self.item("UTIC-2026-0003", "A", "UTIC-2026-0003"), self.item("linha:3", "Impressora"), self.item("linha:4", "Monitor")]
        depois = [self.item("linha:2", "Impressora"), self.item("linha:3", "Monitor"), self.item("UTIC-2026-0003", "A", "UTIC-2026-0003")]
        self.assertEqual(novos.mapear_chaves_de_linha(antes, depois), {"linha:3": "linha:2", "linha:4": "linha:3"})  # a UTIC key is not positional

    def test_conteudo_repetido_ou_ausente_nao_e_adivinhado(self):
        self.assertEqual(
            novos.mapear_chaves_de_linha(
                [self.item("linha:2", "Igual"), self.item("linha:3", "Igual"), self.item("linha:4", "Novo repetido"), self.item("linha:5", "Saiu")],
                [self.item("linha:2", "Igual"), self.item("linha:3", "Igual"), self.item("linha:6", "Novo repetido"), self.item("linha:7", "Novo repetido")],
            ),
            {"linha:2": None, "linha:3": None, "linha:4": None, "linha:5": None},
        )

    def test_qualquer_campo_do_conteudo_distingue_o_chamado(self):
        base = self.item("linha:2", "T", usuario="Camila", descricao="trava")
        for campo, valor in (("chamado", "21528"), ("usuario", "Outra"), ("descricao", "outra")):
            with self.subTest(campo=campo):
                self.assertEqual(novos.mapear_chaves_de_linha([base], [{**base, "numero": "linha:3", campo: valor}]), {"linha:2": None})
        self.assertEqual(novos.mapear_chaves_de_linha([base], [{**base, "numero": "linha:9"}]), {"linha:2": "linha:9"})

    def test_titulo_editado_no_site_segue_pela_segunda_chance_por_c_i_e_h(self):
        base = {"chamado": "Sem chamado", "usuario": "Camila", "descricao": "trava"}
        antes = [self.item("UTIC-2026-0003", "A", "UTIC-2026-0003"), {**base, "numero": "linha:3", "titulo": "Impressora"}]
        depois = [{**base, "numero": "linha:2", "titulo": "Impressora da sala 4"}, self.item("UTIC-2026-0003", "A", "UTIC-2026-0003")]  # G edited and the row moved
        self.assertEqual(novos.mapear_chaves_de_linha(antes, depois), {"linha:3": "linha:2"})

    def test_segunda_chance_nao_adivinha_com_c_i_h_repetidos_nem_destino_tomado(self):
        base = {"chamado": "Sem chamado", "usuario": "Camila", "descricao": "trava"}
        repetido_antes = [{**base, "numero": "linha:2", "titulo": "A"}, {**base, "numero": "linha:3", "titulo": "B"}]
        repetido_depois = [{**base, "numero": "linha:2", "titulo": "A editado"}, {**base, "numero": "linha:3", "titulo": "B editado"}]
        self.assertEqual(novos.mapear_chaves_de_linha(repetido_antes, repetido_depois), {"linha:2": None, "linha:3": None})
        self.assertEqual(novos.mapear_chaves_de_linha([{**base, "numero": "linha:2", "titulo": "A"}], repetido_depois), {"linha:2": None})  # two candidates now
        self.assertEqual(novos.mapear_chaves_de_linha(repetido_antes, [{**base, "numero": "linha:5", "titulo": "C"}]), {"linha:2": None, "linha:3": None})
        # an exact pair and an edited-title pair side by side: each keeps its own destination
        outro = {"chamado": "Sem chamado", "usuario": "Rui", "descricao": "rede"}
        antes = [{**base, "numero": "linha:2", "titulo": "A"}, {**outro, "numero": "linha:3", "titulo": "B"}]
        depois = [{**outro, "numero": "linha:2", "titulo": "B editado"}, {**base, "numero": "linha:3", "titulo": "A"}]
        self.assertEqual(novos.mapear_chaves_de_linha(antes, depois), {"linha:2": "linha:3", "linha:3": "linha:2"})

    def test_segunda_chance_exige_i_ou_h_preenchido_so_o_c_em_comum_nao_basta(self):
        vazio = {"chamado": "Sem chamado", "usuario": "", "descricao": ""}
        antes = [{**vazio, "numero": "linha:2", "titulo": "Impressora"}]
        depois = [{**vazio, "numero": "linha:3", "titulo": "Outro chamado sem solicitante nem descrição"}]
        self.assertEqual(novos.mapear_chaves_de_linha(antes, depois), {"linha:2": None})  # só C igual: outro chamado, não adivinha
        for campo, valor in (("usuario", "Camila"), ("descricao", "trava")):
            with self.subTest(preenchido=campo):
                self.assertEqual(
                    novos.mapear_chaves_de_linha([{**antes[0], campo: valor}], [{**depois[0], campo: valor}]), {"linha:2": "linha:3"},
                )  # I ou H preenchido basta para a segunda chance
        igual = [{**vazio, "numero": "linha:2", "titulo": "Impressora"}]
        self.assertEqual(novos.mapear_chaves_de_linha(igual, [{**igual[0], "numero": "linha:5"}]), {"linha:2": "linha:5"})  # C, G, I e H iguais: primeira chance

    def test_chamado_que_ganhou_utic_leva_a_chave_nova(self):
        antes, depois = [self.item("linha:2", "T")], [self.item("UTIC-2026-0007", "T")]
        self.assertEqual(novos.mapear_chaves_de_linha(antes, depois), {"linha:2": "UTIC-2026-0007"})


if __name__ == "__main__":
    unittest.main()
