import io
import re
import unittest
import zipfile
from xml.etree import ElementTree

from domains import sebrae_dashboard_gravacao as G
from domains.sebrae_dashboard import CABECALHOS

NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
DOC = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
FORMULA_Q = 'TEXT(Tabela3[[#This Row],[DT ENCERRAMENTO]],"mmm/aa")'


def texto(ref, valor, estilo=112):
    return f'<c r="{ref}" s="{estilo}" t="inlineStr"><is><t>{valor}</t></is></c>'


def formulas(n, com_q=True):
    q = f'<c r="Q{n}" s="100" t="str"><f>{FORMULA_Q}</f><v>jan/00</v></c>' if com_q else f'<c r="Q{n}" s="100"/>'
    return (
        q
        + f'<c r="T{n}" s="5" t="b" ca="1"><f>FALSE</f><v>0</v></c>'
        + f'<c r="U{n}" s="5" t="str" ca="1"><f>"x"</f><v>old</v></c>'
        + f'<c r="V{n}" s="5"><f>1+1</f><v>2</v></c>'
    )


def celula_de_c(n, chamado):
    return f'<c r="C{n}" s="112"><v>{chamado}</v></c>' if isinstance(chamado, int) else texto(f"C{n}", chamado)


def linha_de_chamado(n, chamado, d="EM ABERTO", a="SIMPRESS", oculta=False, extra=""):
    celulas = texto(f"A{n}", a, 60) + celula_de_c(n, chamado) + texto(f"D{n}", d, 55) + texto(f"G{n}", f"titulo {chamado}", 112)
    celulas += f'<c r="P{n}" s="92"><v>46000.5</v></c>' + formulas(n) + extra
    atributo = ' hidden="1"' if oculta else ""
    return f'<row r="{n}" spans="1:22"{atributo}>{celulas}</row>'


def linha_vazia(n, com_q=True):
    return f'<row r="{n}" spans="1:22"><c r="G{n}" s="112" t="s"><v>1</v></c>{formulas(n, com_q)}</row>'


FILTRO_D = '<autoFilter ref="A1:W8"><filterColumn colId="3"><filters blank="1"><filter val="EM ABERTO"/></filters></filterColumn></autoFilter>'


def montar(chamados=("UTIC-2026-0001", "UTIC-2026-0002"), ultima=8, status=("EM ABERTO", "FINALIZADO"), filtro_d=False, oculta=(), extras=None):
    """``chamados`` in sheet order (an int is a number cell); ``oculta``: rows with ``hidden``; ``extras``: row -> cells right of W."""
    cabecalho = "".join(texto(f"{letra}1", titulo, 1) for letra, titulo in CABECALHOS.items())
    linhas = [f'<row r="1">{cabecalho}</row>']
    for indice, chamado in enumerate(chamados):
        linhas.append(linha_de_chamado(2 + indice, chamado, status[indice], oculta=2 + indice in oculta, extra=(extras or {}).get(2 + indice, "")))
    primeira_vazia = 2 + len(chamados)
    for n in range(primeira_vazia, ultima + 1):
        linhas.append(linha_vazia(n, com_q=n < primeira_vazia + 1))
    partes = {
        "[Content_Types].xml": (
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet4.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
            '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/>'
            "</Types>"
        ),
        "_rels/.rels": (
            f'<Relationships xmlns="{REL}"><Relationship Id="rId1" Type="{DOC}/officeDocument" Target="xl/workbook.xml"/></Relationships>'
        ),
        "xl/workbook.xml": f'<workbook {NS}><sheets><sheet name="CHAMADOS" sheetId="2" r:id="rId4"/></sheets><calcPr calcId="191028"/></workbook>',
        "xl/_rels/workbook.xml.rels": (
            f'<Relationships xmlns="{REL}"><Relationship Id="rId4" Type="{DOC}/worksheet" Target="worksheets/sheet4.xml"/>'
            f'<Relationship Id="rId5" Type="{DOC}/sharedStrings" Target="sharedStrings.xml"/>'
            f'<Relationship Id="rId6" Type="{DOC}/calcChain" Target="calcChain.xml"/></Relationships>'
        ),
        "xl/worksheets/sheet4.xml": f'<worksheet {NS}><sheetData>{"".join(linhas)}</sheetData><extLst><ext uri="{{x}}">keep-validation</ext></extLst></worksheet>',
        "xl/worksheets/_rels/sheet4.xml.rels": (
            f'<Relationships xmlns="{REL}"><Relationship Id="rId2" Type="{DOC}/table" Target="../tables/table2.xml"/></Relationships>'
        ),
        "xl/tables/table2.xml": f'<table xmlns="x" name="Tabela3" displayName="Tabela3" ref="A1:W{ultima}">{FILTRO_D if filtro_d else ""}</table>',
        "xl/sharedStrings.xml": '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t xml:space="preserve"> </t></si><si><t/></si></sst>',
        "xl/calcChain.xml": '<calcChain xmlns="x"><c r="Q2" i="2"/></calcChain>',
        "xl/pivotCache/pivotCacheDefinition2.xml": '<pivotCacheDefinition xmlns="x" recordCount="3"><cacheSource type="worksheet"><worksheetSource name="Tabela3"/></cacheSource></pivotCacheDefinition>',
        "xl/pivotCache/pivotCacheDefinition1.xml": '<pivotCacheDefinition xmlns="x"><cacheSource type="worksheet"><worksheetSource ref="A1:B2" sheet="MAPA UX"/></cacheSource></pivotCacheDefinition>',
    }
    saida = io.BytesIO()
    with zipfile.ZipFile(saida, "w", zipfile.ZIP_DEFLATED) as arquivo:
        for nome, dados in partes.items():
            arquivo.writestr(nome, dados)
    return saida.getvalue()


def partes_de(conteudo):
    with zipfile.ZipFile(io.BytesIO(conteudo)) as arquivo:
        return {nome: arquivo.read(nome) for nome in arquivo.namelist()}


def linha_xml(conteudo, n):
    folha = partes_de(conteudo)["xl/worksheets/sheet4.xml"].decode()
    return re.search(rf'<row r="{n}".*?</row>', folha, re.DOTALL).group(0)


def _antes_da_coluna_p(conteudo, n, celulas):
    """Same workbook with ``celulas`` (columns between G and P) added to row ``n`` of the sheet."""
    partes = partes_de(conteudo)
    folha = partes["xl/worksheets/sheet4.xml"].decode()
    partes["xl/worksheets/sheet4.xml"] = folha.replace(f'<c r="P{n}"', celulas + f'<c r="P{n}"', 1).encode()
    saida = io.BytesIO()
    with zipfile.ZipFile(saida, "w", zipfile.ZIP_DEFLATED) as arquivo:
        for nome, dados in partes.items():
            arquivo.writestr(nome, dados)
    return saida.getvalue()


NOVA = {
    "A": "SIMPRESS", "B": "REDE", "C": "UTIC-2026-0099", "D": "EM ABERTO", "E": "123", "F": "feito",
    "G": "Título & <teste>", "H": "descrição", "I": "Fulano", "J": "INCIDENTE", "P": "26/10/2026 17:25",
}


class NovosChamadosTest(unittest.TestCase):
    def test_preenche_a_primeira_linha_livre_e_mantem_as_demais_partes_identicas(self):
        original = montar()
        resultado = G.atualizar(original, [NOVA])
        self.assertEqual([(g.numero, g.linha, g.tipo) for g in resultado.linhas], [("UTIC-2026-0099", 4, "novo")])
        linha = linha_xml(resultado.conteudo, 4)
        self.assertIn("<t xml:space=\"preserve\">UTIC-2026-0099</t>", linha)
        self.assertIn("Título &amp; &lt;teste&gt;", linha)
        self.assertRegex(linha, r'<c r="E4"[^>]*><v>123</v></c>')
        self.assertRegex(linha, r'<c r="P4"[^>]*><v>\d+\.\d+</v></c>')
        antes, depois = partes_de(original), partes_de(resultado.conteudo)
        mudadas = {nome for nome in antes if antes[nome] != depois[nome]}
        self.assertEqual(mudadas, {"xl/worksheets/sheet4.xml", "xl/workbook.xml", "xl/pivotCache/pivotCacheDefinition2.xml"})
        self.assertIn(b"keep-validation", depois["xl/worksheets/sheet4.xml"])

    def test_formulas_perdem_o_valor_guardado_e_q_e_escrita_onde_faltava(self):
        resultado = G.atualizar(montar(), [NOVA, {**NOVA, "C": "UTIC-2026-0100"}])
        for n in (4, 5):
            linha = linha_xml(resultado.conteudo, n)
            self.assertNotIn("jan/00", linha)
            self.assertNotIn("<v>old</v>", linha)
            self.assertRegex(linha, r'<c r="T%d"[^>]*><f>FALSE</f></c>' % n)
            self.assertIn(f"<f>{FORMULA_Q}</f>", linha)
            self.assertRegex(linha, r'<c r="U%d"[^>]*ca="1"><f>' % n)  # cached type dropped with the value

    def test_ativa_recalculo_e_atualizacao_do_pivot_so_da_tabela3(self):
        partes = partes_de(G.atualizar(montar(), [NOVA]).conteudo)
        self.assertIn(b'fullCalcOnLoad="1"', partes["xl/workbook.xml"])
        self.assertIn(b'refreshOnLoad="1"', partes["xl/pivotCache/pivotCacheDefinition2.xml"])
        self.assertNotIn(b"refreshOnLoad", partes["xl/pivotCache/pivotCacheDefinition1.xml"])

    def test_recusa_chamado_ja_existente_e_repetido_entre_novos(self):
        with self.assertRaisesRegex(G.GravacaoInvalida, "UTIC-2026-0001"):
            G.atualizar(montar(), [{**NOVA, "C": "UTIC-2026-0001"}])
        with self.assertRaises(G.GravacaoInvalida):
            G.atualizar(montar(), [NOVA, NOVA])

    def test_recusa_quando_as_linhas_da_tabela_acabam(self):
        pequeno = montar(ultima=4)  # rows 4 only free
        G.atualizar(pequeno, [NOVA])
        with self.assertRaisesRegex(G.GravacaoInvalida, "Sem espaço"):
            G.atualizar(pequeno, [NOVA, {**NOVA, "C": "UTIC-2026-0100"}])

    def test_escapes_de_xml_e_texto_de_formula(self):
        corpo = linha_xml(G.atualizar(montar(), [{**NOVA, "H": "x\x01y _x0041_"}]).conteudo, 4)
        self.assertNotIn("\x01", corpo)
        self.assertIn("_x005F_x0041_", corpo)
        corpo = linha_xml(G.atualizar(montar(), [{**NOVA, "H": "'=cmd"}]).conteudo, 4)
        self.assertIn(">=cmd<", corpo)  # the paste-time apostrophe is not part of an inline string


class EdicaoDeChamadosAntigosTest(unittest.TestCase):
    def test_lista_so_em_aberto_ou_sem_status(self):
        conteudo = montar(("UTIC-2026-0001", "UTIC-2026-0002"), status=("EM ABERTO", "FINALIZADO"))
        self.assertEqual([c.numero for c in G.chamados_para_editar(conteudo)], ["UTIC-2026-0001"])
        sem_status = montar(("UTIC-2026-0001",), status=("",))
        self.assertEqual([c.numero for c in G.chamados_para_editar(sem_status)], ["UTIC-2026-0001"])

    def test_celula_c_composta_com_um_so_numero_usa_o_utic_como_chave_e_as_demais_usam_a_linha(self):
        composto = "27371 / UTIC-2026-0094"
        conteudo = montar((composto, f"{composto} utic-2026-0095", "27 / UTIC-2026-0096", "UTIC-2026-0097 e UTIC-2026-0098"),
                          ultima=8, status=("EM ABERTO", "EM ABERTO", "FINALIZADO", "EM ABERTO"))
        self.assertEqual(
            [(c.numero, c.linha) for c in G.chamados_para_editar(conteudo)],
            [("UTIC-2026-0094", 2), ("linha:3", 3), ("linha:5", 5)],
        )
        sem_status = montar((composto,), status=("",))
        self.assertEqual([c.numero for c in G.chamados_para_editar(sem_status)], ["UTIC-2026-0094"])

    def test_espelha_chamado_sem_utic_e_edita_pela_linha(self):
        original = montar(("Sem chamado", "27011", "UTIC-2026-0001"), status=("EM ABERTO", "FINALIZADO", "FINALIZADO"))
        abertos = G.chamados_para_editar(original)
        self.assertEqual([(c.numero, c.chamado) for c in abertos], [("linha:2", "Sem chamado")])
        resultado = G.atualizar(original, edicoes={"linha:2": {"B": "REDE"}})
        # "27011" sorts before "Sem chamado": the edited row ends at row 3 (the key stays the pre-sort ``linha:2``)
        self.assertEqual([(g.numero, g.linha, g.celulas) for g in resultado.linhas], [("linha:2", 3, ("B",))])
        celula_c = re.compile(r'<c r="C\d".*?</c>')
        self.assertEqual(celula_c.search(linha_xml(resultado.conteudo, 3)).group(0), celula_c.search(linha_xml(original, 2)).group(0).replace('"C2"', '"C3"'))
        with self.assertRaisesRegex(G.GravacaoInvalida, "não está"):
            G.atualizar(original, edicoes={"linha:3": {"B": "REDE"}})  # finalized row is not mirrored

    def test_automaticos_so_preenchem_celulas_vazias(self):
        conteudo = _antes_da_coluna_p(montar(("Sem chamado", "UTIC-2026-0001"), status=("EM ABERTO", "FINALIZADO")), 2, texto("I2", "Camila Lopes") + texto("K2", "SERIE-ANTIGA"))
        abertos = G.chamados_para_editar(conteudo)
        self.assertEqual((abertos[0].usuario, dict(abertos[0].automaticos)), ("Camila Lopes", {"E": "", "K": "SERIE-ANTIGA", "L": "", "N": ""}))
        resultado = G.atualizar(conteudo, automaticos={"linha:2": {"E": "7303022", "K": "OUTRA", "L": "Dell", "N": "Curitiba"}})
        self.assertEqual([(g.numero, g.tipo, g.celulas) for g in resultado.linhas], [("linha:2", "alterado", ("E", "L", "N"))])
        linha = linha_xml(resultado.conteudo, 2)
        self.assertIn("SERIE-ANTIGA", linha)
        self.assertNotIn("OUTRA", linha)
        self.assertIn("Curitiba", linha)
        with self.assertRaises(G.GravacaoInvalida):
            G.atualizar(conteudo, automaticos={"linha:2": {"Q": "x"}})

    def test_edita_chamado_de_c_composto_sem_reescrever_a_c(self):
        composto = "27371 / UTIC-2026-0094"
        original = montar((composto,), status=("EM ABERTO",))
        edicao = {"A": "SIMPRESS", "B": "REDE", "D": "FINALIZADO", "J": "INCIDENTE", "R": "28/10/2026 14:30"}
        resultado = G.atualizar(original, edicoes={"UTIC-2026-0094": edicao})
        self.assertEqual([(g.numero, g.tipo, g.celulas) for g in resultado.linhas], [("UTIC-2026-0094", "alterado", ("B", "D", "J", "R"))])
        linha = linha_xml(resultado.conteudo, 2)
        celula_c = re.compile(r'<c r="C2".*?</c>')
        self.assertEqual(celula_c.search(linha).group(0), celula_c.search(linha_xml(original, 2)).group(0))
        self.assertIn("FINALIZADO", linha)
        self.assertEqual(G.chamados_para_editar(resultado.conteudo), [])

    def test_duplicata_e_c_ambiguo_so_se_editam_pela_linha_nunca_pelo_utic(self):
        conteudo = montar(("27371 / UTIC-2026-0094", "UTIC-2026-0094"), status=("EM ABERTO", "EM ABERTO"))
        self.assertEqual([c.numero for c in G.chamados_para_editar(conteudo)], ["linha:2", "linha:3"])
        with self.assertRaisesRegex(G.GravacaoInvalida, "não está"):
            G.atualizar(conteudo, edicoes={"UTIC-2026-0094": {"D": "FINALIZADO"}})
        ambigua = montar(("UTIC-2026-0094 e UTIC-2026-0095",), status=("EM ABERTO",))
        with self.assertRaisesRegex(G.GravacaoInvalida, "não está"):
            G.atualizar(ambigua, edicoes={"UTIC-2026-0094": {"D": "FINALIZADO"}})
        self.assertEqual([g.numero for g in G.atualizar(ambigua, edicoes={"linha:2": {"B": "REDE"}}).linhas], ["linha:2"])

    def test_altera_so_celulas_diferentes_e_zera_formulas_dependentes(self):
        original = montar()
        resultado = G.atualizar(original, edicoes={"UTIC-2026-0001": {"A": "SIMPRESS", "D": "FINALIZADO", "R": "27/10/2026 10:30"}})
        self.assertEqual([(g.numero, g.tipo, g.celulas) for g in resultado.linhas], [("UTIC-2026-0001", "alterado", ("D", "R"))])
        linha = linha_xml(resultado.conteudo, 2)
        self.assertIn("FINALIZADO", linha)
        self.assertIn('<c r="D2" s="55"', linha)  # keeps its own style
        self.assertNotIn("<v>old</v>", linha)
        self.assertEqual(linha_xml(resultado.conteudo, 3), linha_xml(original, 3))

    def test_valor_em_branco_nao_apaga_e_sem_diferenca_nada_muda(self):
        resultado = G.atualizar(montar(), edicoes={"UTIC-2026-0001": {"D": "", "A": "SIMPRESS"}})
        self.assertEqual(resultado.linhas, ())

    def test_recusa_coluna_nao_manual_e_chamado_inexistente(self):
        with self.assertRaises(G.GravacaoInvalida):
            G.atualizar(montar(), edicoes={"UTIC-2026-0001": {"F": "x"}})
        with self.assertRaisesRegex(G.GravacaoInvalida, "não está"):
            G.atualizar(montar(), edicoes={"UTIC-2026-7777": {"A": "CLIENTE"}})

    def test_titulo_g_preenchido_e_sobreposto_so_quando_muda_e_o_resto_da_planilha_fica_igual(self):
        original = montar()
        resultado = G.atualizar(original, edicoes={"UTIC-2026-0001": {"G": "  Novo   título & <teste> "}})
        self.assertEqual([(g.numero, g.tipo, g.celulas) for g in resultado.linhas], [("UTIC-2026-0001", "alterado", ("G",))])
        self.assertEqual(G.chamados_para_editar(resultado.conteudo)[0].titulo, "Novo título & <teste>")
        self.assertEqual(linha_xml(resultado.conteudo, 3), linha_xml(original, 3))
        self.assertEqual(G.chamados_para_editar(resultado.conteudo)[0].numero, "UTIC-2026-0001")  # still found by its C
        igual = G.atualizar(original, edicoes={"UTIC-2026-0001": {"G": "titulo UTIC-2026-0001"}})
        self.assertEqual(igual.linhas, ())

    def test_titulo_g_vazio_na_planilha_e_preenchido_e_em_branco_nunca_apaga(self):
        vazio = _trocar_na_folha(montar(), texto("G2", "titulo UTIC-2026-0001", 112), '<c r="G2" s="112"/>')
        self.assertEqual(G.chamados_para_editar(vazio)[0].titulo, "")
        resultado = G.atualizar(vazio, edicoes={"UTIC-2026-0001": {"G": "Impressora sem toner"}})
        self.assertEqual([g.celulas for g in resultado.linhas], [("G",)])
        self.assertEqual(G.chamados_para_editar(resultado.conteudo)[0].titulo, "Impressora sem toner")
        em_branco = G.atualizar(montar(), edicoes={"UTIC-2026-0001": {"G": "   "}})
        self.assertEqual(em_branco.linhas, ())  # blank never erases the title the sheet has

    def test_titulo_g_com_apostrofo_vira_texto_e_chamado_finalizado_nao_aceita_g(self):
        resultado = G.atualizar(montar(), edicoes={"UTIC-2026-0001": {"G": "'=1+1"}})
        self.assertEqual(G.chamados_para_editar(resultado.conteudo)[0].titulo, "=1+1")
        self.assertNotIn("<f>", linha_xml(resultado.conteudo, 2).split('<c r="G2"')[1].split("</c>")[0])
        with self.assertRaisesRegex(G.GravacaoInvalida, "não está"):
            G.atualizar(montar(), edicoes={"UTIC-2026-0002": {"G": "x"}})  # D is FINALIZADO: not mirrored
        with self.assertRaisesRegex(G.GravacaoInvalida, "coluna F"):
            G.atualizar(montar(), edicoes={"UTIC-2026-0001": {"F": "x"}})  # only A, B, D, J, R, S, G and H are editable by the site
        with self.assertRaisesRegex(G.GravacaoInvalida, "coluna C"):
            G.atualizar(montar(), edicoes={"UTIC-2026-0001": {"C": "UTIC-2026-0777"}})  # C is never rewritten
        with self.assertRaisesRegex(G.GravacaoInvalida, "coluna G"):
            G.atualizar(montar(), automaticos={"UTIC-2026-0001": {"G": "x"}})  # G only through ``edicoes``

    def test_descricao_h_vazia_ou_preenchida_e_sobreposta_so_quando_muda_e_em_branco_nunca_apaga(self):
        original = montar()  # no H cell in the row
        resultado = G.atualizar(original, edicoes={"UTIC-2026-0001": {"H": "  Nova   descrição & <teste> "}})
        self.assertEqual([(g.numero, g.tipo, g.celulas) for g in resultado.linhas], [("UTIC-2026-0001", "alterado", ("H",))])
        self.assertEqual(G.chamados_para_editar(resultado.conteudo)[0].descricao, "Nova descrição & <teste>")
        self.assertEqual(linha_xml(resultado.conteudo, 3), linha_xml(original, 3))
        preenchida = _antes_da_coluna_p(original, 2, texto("H2", "descricao antiga"))
        self.assertEqual(G.chamados_para_editar(preenchida)[0].descricao, "descricao antiga")
        editada = G.atualizar(preenchida, edicoes={"UTIC-2026-0001": {"H": "descricao editada"}})
        self.assertEqual([g.celulas for g in editada.linhas], [("H",)])
        self.assertEqual(G.chamados_para_editar(editada.conteudo)[0].descricao, "descricao editada")
        self.assertEqual(G.atualizar(preenchida, edicoes={"UTIC-2026-0001": {"H": "descricao antiga"}}).linhas, ())  # same text: nothing to write
        self.assertEqual(G.atualizar(preenchida, edicoes={"UTIC-2026-0001": {"H": "   "}}).linhas, ())  # blank never erases the H the sheet has
        self.assertEqual(G.chamados_para_editar(G.atualizar(preenchida, edicoes={"UTIC-2026-0001": {"H": ""}}).conteudo)[0].descricao, "descricao antiga")

    def test_titulo_g_e_descricao_h_do_mesmo_chamado_vao_juntos_com_os_manuais(self):
        resultado = G.atualizar(montar(), edicoes={"UTIC-2026-0001": {"A": "CLIENTE", "G": "Título novo", "H": "Descrição nova"}})
        self.assertEqual([(g.numero, g.celulas) for g in resultado.linhas], [("UTIC-2026-0001", ("A", "G", "H"))])
        aberto = G.chamados_para_editar(resultado.conteudo)[0]
        self.assertEqual((aberto.titulo, aberto.descricao, aberto.valores["A"]), ("Título novo", "Descrição nova", "CLIENTE"))
        self.assertEqual(aberto.numero, "UTIC-2026-0001")  # still found by its C

    def test_descricao_h_com_apostrofo_vira_texto_e_chamado_finalizado_nao_aceita_h(self):
        resultado = G.atualizar(montar(), edicoes={"UTIC-2026-0001": {"H": "'=1+1"}})
        self.assertEqual(G.chamados_para_editar(resultado.conteudo)[0].descricao, "=1+1")
        self.assertNotIn("<f>", linha_xml(resultado.conteudo, 2).split('<c r="H2"')[1].split("</c>")[0])
        with self.assertRaisesRegex(G.GravacaoInvalida, "não está"):
            G.atualizar(montar(), edicoes={"UTIC-2026-0002": {"H": "x"}})  # D is FINALIZADO: not mirrored
        with self.assertRaisesRegex(G.GravacaoInvalida, "coluna H"):
            G.atualizar(montar(), automaticos={"UTIC-2026-0001": {"H": "x"}})  # H only through ``edicoes``

    def test_g_h_e_manuais_com_inicio_de_formula_nao_voltam_como_alterados_ao_reaplicar(self):
        # a célula guarda ``-x``; o envio chega como ``'-x`` (``_texto_de_celula``): lidos e enviados têm de ser comparados na mesma forma
        for inicio in ("-", "=", "+", "@"):
            with self.subTest(inicio=inicio):
                edicao = {"G": f"'{inicio}titulo", "H": f"'{inicio}descricao", "S": f"'{inicio}sla"}
                primeira = G.atualizar(montar(), edicoes={"UTIC-2026-0001": edicao})
                self.assertEqual([g.celulas for g in primeira.linhas], [("G", "H", "S")])
                aberto = G.chamados_para_editar(primeira.conteudo)[0]
                self.assertEqual((aberto.titulo, aberto.descricao, aberto.valores["S"]), (f"{inicio}titulo", f"{inicio}descricao", f"{inicio}sla"))
                segunda = G.atualizar(primeira.conteudo, edicoes={"UTIC-2026-0001": edicao})
                self.assertEqual(segunda.linhas, ())  # sobre o que já foi gravado, o mesmo envio não muda nada
                mudado = G.atualizar(primeira.conteudo, edicoes={"UTIC-2026-0001": {**edicao, "G": f"'{inicio}outro"}})
                self.assertEqual([g.celulas for g in mudado.linhas], [("G",)])  # só o que de fato mudou

    def test_h_ja_gravado_compara_na_mesma_forma_e_tolera_o_corte_do_h_lido(self):
        self.assertTrue(G.h_ja_gravado("Cartucho trocado", "Cartucho trocado"))
        self.assertTrue(G.h_ja_gravado("  Cartucho   trocado ", "Cartucho trocado"))  # uma linha, sem espaço repetido
        self.assertTrue(G.h_ja_gravado("'-x", "-x"))  # apóstrofo protetor não está na célula
        self.assertTrue(G.h_ja_gravado("'=SOMA(1)", "=SOMA(1)"))
        self.assertFalse(G.h_ja_gravado("Cartucho", "Cartucho trocado"))
        self.assertFalse(G.h_ja_gravado("-x", "x"))
        longo = " ".join(["palavra"] * 400)  # 3199 caracteres
        cortado = longo[: G.LIMITE_H_LIDO]
        self.assertTrue(G.h_ja_gravado(longo, cortado))  # o H lido veio cortado: só o começo precisa bater
        self.assertFalse(G.h_ja_gravado("x" + longo, cortado))
        self.assertFalse(G.h_ja_gravado(longo, cortado[:-3]))  # abaixo do limite não é corte: tem de ser igual
        self.assertEqual(len(G.chamados_para_editar(_antes_da_coluna_p(montar(), 2, texto("H2", longo)))[0].descricao), G.LIMITE_H_LIDO)

    def test_novo_com_manuais_em_branco_nao_escreve_a_d_j_e_volta_a_ser_editavel(self):
        nova = {**NOVA, "A": "", "D": "", "J": ""}
        resultado = G.atualizar(montar(), [nova])
        self.assertEqual([(g.numero, g.linha, g.tipo) for g in resultado.linhas], [("UTIC-2026-0099", 4, "novo")])
        linha = linha_xml(resultado.conteudo, 4)
        self.assertIn("UTIC-2026-0099", linha)
        for coluna in "ADJ":
            self.assertNotIn(f'<c r="{coluna}4"', linha)
        reaberto = {c.numero: c for c in G.chamados_para_editar(resultado.conteudo)}
        self.assertIn("UTIC-2026-0099", reaberto)
        self.assertEqual([reaberto["UTIC-2026-0099"].valores.get(c, "") for c in "ADJ"], ["", "", ""])

    def test_novo_e_edicao_juntos(self):
        resultado = G.atualizar(montar(), [NOVA], {"UTIC-2026-0001": {"A": "CLIENTE"}})
        self.assertEqual({(g.numero, g.tipo) for g in resultado.linhas}, {("UTIC-2026-0099", "novo"), ("UTIC-2026-0001", "alterado")})


def _trocar_na_folha(conteudo, antigo, novo):
    """Same workbook with ``antigo`` replaced by ``novo`` in the sheet text."""
    partes = partes_de(conteudo)
    partes["xl/worksheets/sheet4.xml"] = partes["xl/worksheets/sheet4.xml"].decode().replace(antigo, novo).encode()
    saida = io.BytesIO()
    with zipfile.ZipFile(saida, "w", zipfile.ZIP_DEFLATED) as arquivo:
        for nome, dados in partes.items():
            arquivo.writestr(nome, dados)
    return saida.getvalue()


def sequencia(conteudo):
    """(C, G) of the ticket rows, in sheet order."""
    valores = G.valores_dos_chamados(conteudo)
    c, g = G.COLUNAS_DE_DADO.index("C"), G.COLUNAS_DE_DADO.index("G")
    return [(valores[n][c], valores[n][g]) for n in sorted(valores)]


def abertura_da_linha(conteudo, n):
    return re.search(rf'<row r="{n}"[^>]*>', partes_de(conteudo)["xl/worksheets/sheet4.xml"].decode()).group(0)


def celulas_na_linha_certa(conteudo):
    """True when every ``<c r=...>`` carries the number of the ``<row>`` that holds it."""
    folha = partes_de(conteudo)["xl/worksheets/sheet4.xml"].decode()
    return all(
        {int(n) for n in re.findall(r'<c r="[A-Z]+(\d+)"', corpo)} <= {int(numero)}
        for numero, corpo in re.findall(r'<row r="(\d+)"[^>]*>(.*?)</row>', folha, re.DOTALL)
    )


class OrdemDaColunaCTest(unittest.TestCase):
    def test_chave_ordena_como_o_excel(self):
        esperado = [("21528", True), ("29474", True), ("29147 / UTIC-2026-0111", None), ("PRT-000017/26", None),
                    ("Sem chamado", None), ("UTIC-2026-0093", None), ("UTIC-2026-1000", None), ("", None)]
        embaralhado = [esperado[i] for i in (6, 3, 7, 0, 5, 2, 4, 1)]
        self.assertEqual(sorted(embaralhado, key=lambda item: G.chave_coluna_c(*item)), esperado)
        self.assertEqual(G.chave_coluna_c("29474"), (0, 29474.0))  # inferred from the digits
        self.assertEqual(G.chave_coluna_c("29474", False), (1, "29474"))
        self.assertEqual(G.chave_coluna_c("Utic-2026-0001"), G.chave_coluna_c("UTIC20260001"))  # case, hyphen
        self.assertEqual(G.chave_coluna_c("O'Neil"), G.chave_coluna_c("oneil"))  # apostrophe
        self.assertEqual((G.chave_coluna_c(None), G.chave_coluna_c("  ")), ((2, ""), (2, "")))

    def test_base_fora_de_ordem_sai_ordenada_sem_novas_e_cada_linha_leva_suas_celulas(self):
        base = montar(("UTIC-2026-0003", 29474, "Sem chamado", 21528, "UTIC-2026-0001"), status=("EM ABERTO",) * 5)
        resultado = G.atualizar(base)
        ordem = ["21528", "29474", "Sem chamado", "UTIC-2026-0001", "UTIC-2026-0003"]
        self.assertEqual(sequencia(resultado.conteudo), [(c, f"titulo {c}") for c in ordem])
        self.assertEqual(resultado.linhas, ())
        self.assertTrue(celulas_na_linha_certa(resultado.conteudo))
        self.assertIn('<c r="C2" s="112"><v>21528</v></c>', linha_xml(resultado.conteudo, 2))  # a number stays a number, with its style
        self.assertIn(f"<f>{FORMULA_Q}</f>", linha_xml(resultado.conteudo, 2))
        self.assertEqual(linha_xml(resultado.conteudo, 7), linha_xml(base, 7))  # free rows are not touched
        self.assertEqual(partes_de(G.atualizar(resultado.conteudo).conteudo), partes_de(resultado.conteudo))  # already sorted: nothing moves

    def test_novas_caem_na_posicao_ordenada_e_a_linha_gravada_e_a_final(self):
        base = montar(("UTIC-2026-0001", "UTIC-2026-0003"), status=("EM ABERTO", "EM ABERTO"))
        resultado = G.atualizar(base, [{**NOVA, "C": "UTIC-2026-0099"}, {**NOVA, "C": "UTIC-2026-0002"}])
        self.assertEqual({(g.numero, g.linha, g.tipo) for g in resultado.linhas}, {("UTIC-2026-0002", 3, "novo"), ("UTIC-2026-0099", 5, "novo")})
        self.assertEqual([c for c, _ in sequencia(resultado.conteudo)], ["UTIC-2026-0001", "UTIC-2026-0002", "UTIC-2026-0003", "UTIC-2026-0099"])
        self.assertIn("UTIC-2026-0002", linha_xml(resultado.conteudo, 3))
        self.assertTrue(celulas_na_linha_certa(resultado.conteudo))

    def test_edicao_e_nova_juntas_com_ordenacao(self):
        base = montar(("UTIC-2026-0003", "UTIC-2026-0001"), status=("EM ABERTO", "EM ABERTO"))
        resultado = G.atualizar(base, [{**NOVA, "C": "UTIC-2026-0002"}], {"UTIC-2026-0003": {"A": "CLIENTE"}})
        self.assertEqual({(g.numero, g.linha, g.tipo) for g in resultado.linhas}, {("UTIC-2026-0002", 3, "novo"), ("UTIC-2026-0003", 4, "alterado")})
        self.assertEqual([c for c, _ in sequencia(resultado.conteudo)], ["UTIC-2026-0001", "UTIC-2026-0002", "UTIC-2026-0003"])
        self.assertIn("CLIENTE", linha_xml(resultado.conteudo, 4))
        self.assertNotIn("CLIENTE", linha_xml(resultado.conteudo, 2))

    def test_oculta_acompanha_o_filtro_da_d_depois_de_mover(self):
        base = montar(("UTIC-2026-0003", "UTIC-2026-0001", "UTIC-2026-0002"), status=("FINALIZADO", "EM ABERTO", "FINALIZADO"), filtro_d=True, oculta=(2, 4))
        resultado = G.atualizar(base)
        self.assertEqual([c for c, _ in sequencia(resultado.conteudo)], ["UTIC-2026-0001", "UTIC-2026-0002", "UTIC-2026-0003"])
        self.assertNotIn("hidden", abertura_da_linha(resultado.conteudo, 2))  # EM ABERTO moved into a hidden slot: shown
        self.assertIn('hidden="1"', abertura_da_linha(resultado.conteudo, 3))  # FINALIZADO moved into a visible slot: hidden
        self.assertIn('hidden="1"', abertura_da_linha(resultado.conteudo, 4))
        sem_filtro = G.atualizar(montar(("UTIC-2026-0002", "UTIC-2026-0001"), status=("EM ABERTO", "EM ABERTO"), oculta=(2,)))
        self.assertIn('hidden="1"', abertura_da_linha(sem_filtro.conteudo, 2))  # no filter to follow: hidden stays by position
        self.assertNotIn("hidden", abertura_da_linha(sem_filtro.conteudo, 3))

    def test_celulas_a_direita_da_w_ficam_na_posicao(self):
        extras = {2: '<c r="X2" s="5"><v>1</v></c>', 3: '<c r="X3" s="5"><v>2</v></c>'}
        resultado = G.atualizar(montar(("UTIC-2026-0002", "UTIC-2026-0001"), status=("EM ABERTO", "EM ABERTO"), extras=extras))
        for n, titulo in ((2, "titulo UTIC-2026-0001"), (3, "titulo UTIC-2026-0002")):
            linha = linha_xml(resultado.conteudo, n)
            self.assertIn(extras[n], linha)
            self.assertLess(linha.index(titulo), linha.index(f'<c r="X{n}"'))  # X still after the A..W cells

    def test_calc_chain_sai_so_quando_alguma_linha_muda_de_lugar(self):
        def calc_chain(conteudo):
            partes = {nome: dados.decode() for nome, dados in partes_de(conteudo).items() if nome != "xl/calcChain.xml"}
            return (
                "xl/calcChain.xml" in partes_de(conteudo),
                "calcChain" in partes["[Content_Types].xml"],
                "calcChain" in partes["xl/_rels/workbook.xml.rels"],
            )

        movido = G.atualizar(montar(("UTIC-2026-0002", "UTIC-2026-0001"), status=("EM ABERTO", "EM ABERTO"))).conteudo
        self.assertEqual(calc_chain(movido), (False, False, False))
        rels = partes_de(movido)["xl/_rels/workbook.xml.rels"].decode()
        self.assertIn('Id="rId4"', rels)  # the other relationships stay
        self.assertIn('Id="rId5"', rels)
        self.assertIn("/xl/sharedStrings.xml", partes_de(movido)["[Content_Types].xml"].decode())
        ordenada = montar(("UTIC-2026-0001", "UTIC-2026-0002"), status=("EM ABERTO", "EM ABERTO"))
        for resultado in (G.atualizar(ordenada), G.atualizar(ordenada, edicoes={"UTIC-2026-0001": {"A": "CLIENTE"}})):
            self.assertEqual(calc_chain(resultado.conteudo), (True, True, True))

    def test_encerramentos_saem_ordenados_e_sem_escrita_devolvem_os_mesmos_bytes(self):
        base = montar(("UTIC-2026-0002", "UTIC-2026-0001"), status=("EM ABERTO", "EM ABERTO"), filtro_d=True)
        resultado, estados = G.registrar_encerramentos(base, {"UTIC-2026-0002": "28/10/2026 14:30", "UTIC-2026-7777": "28/10/2026 14:30"})
        self.assertEqual(estados, {"UTIC-2026-0002": "gravado", "UTIC-2026-7777": "nao_encontrado"})
        self.assertEqual([(g.numero, g.linha) for g in resultado.linhas], [("UTIC-2026-0002", 3)])  # final row
        self.assertEqual([c for c, _ in sequencia(resultado.conteudo)], ["UTIC-2026-0001", "UTIC-2026-0002"])
        self.assertIn("FINALIZADO", linha_xml(resultado.conteudo, 3))
        self.assertNotIn("hidden", abertura_da_linha(resultado.conteudo, 2))
        self.assertIn('hidden="1"', abertura_da_linha(resultado.conteudo, 3))  # just finalized: the D filter hides it
        sem_escrita, estados = G.registrar_encerramentos(base, {"UTIC-2026-7777": "28/10/2026 14:30"})
        self.assertEqual((sem_escrita.conteudo, sem_escrita.linhas, estados), (base, (), {"UTIC-2026-7777": "nao_encontrado"}))

    def test_formula_presa_a_linha_recusa_so_quando_precisa_mover(self):
        fora_de_ordem = montar(("UTIC-2026-0002", "UTIC-2026-0001"), status=("EM ABERTO", "EM ABERTO"))
        for formula in ("B2+1", "$B$2+1", "SUM(V2:V3)", 'IF(A2="x",1,2)'):
            with self.subTest(formula), self.assertRaisesRegex(G.GravacaoInvalida, "Nada foi entregue"):
                G.atualizar(_trocar_na_folha(fora_de_ordem, "<f>1+1</f>", f"<f>{formula}</f>"))
        with self.assertRaisesRegex(G.GravacaoInvalida, "Nada foi entregue"):
            G.atualizar(_trocar_na_folha(fora_de_ordem, "<f>1+1</f>", '<f t="shared" ref="V2:V3" si="0">1+1</f>'))
        em_ordem = montar(("UTIC-2026-0001", "UTIC-2026-0002"), status=("EM ABERTO", "EM ABERTO"))
        G.atualizar(_trocar_na_folha(em_ordem, "<f>1+1</f>", "<f>B2+1</f>"))  # nothing moves: no problem
        for inofensiva in ('"A2"&amp;"x"', "LOG10(2)+1", FORMULA_Q):  # string, function name, structured reference
            G.atualizar(_trocar_na_folha(fora_de_ordem, "<f>1+1</f>", f"<f>{inofensiva}</f>"))

    def test_linha_faltando_entre_os_chamados_recusa_em_vez_de_ordenar(self):
        base = montar(("UTIC-2026-0001", "UTIC-2026-0002", "UTIC-2026-0003"), status=("EM ABERTO",) * 3)
        furada = _trocar_na_folha(base, linha_de_chamado(3, "UTIC-2026-0002"), "")
        with self.assertRaisesRegex(G.GravacaoInvalida, "Nada foi entregue"):
            G.atualizar(furada)

    def test_conferencia_recusa_arquivo_adulterado(self):
        base = montar(("UTIC-2026-0002", "UTIC-2026-0001"), status=("EM ABERTO", "EM ABERTO"))
        pacote = G._ler_pacote(base)
        texto = pacote.texto(pacote.aba)
        _, _, linhas = G._linhas_da_aba(texto)
        anteriores = G.ler_coluna_c(base)
        ordem = G._ordenar(pacote, linhas, {})
        bom = G._montar(pacote, texto, linhas, ordem.substituicoes, True)
        G._conferir(bom, anteriores, [], pacote, ordem)  # the real output passes
        adulterados = {
            "fora de ordem": G._montar(pacote, texto, linhas, {}, False),
            "conteudo trocado": _trocar_na_folha(bom, "titulo UTIC-2026-0001", "titulo outro"),
            "celula na linha errada": _trocar_na_folha(bom, '<c r="G3"', '<c r="G9"'),
        }
        for nome, conteudo in adulterados.items():
            with self.subTest(nome), self.assertRaisesRegex(G.GravacaoInvalida, "nada foi entregue"):
                G._conferir(conteudo, anteriores, [], pacote, ordem)


LISTAS = "xl/worksheets/sheet5.xml"
CATEGORIAS_ORIGINAIS = (
    "HARDWARE", "SOFTWARE", "ACESSO", "E-MAIL", "CELULAR", "TABLET", "TELEFONIA", "BACKUP", "SEGURANÇA", "IMPRESSÃO",
    "MONITOR", "NOTEBOOK", "PERIFÉRICOS", "VPN", "OUTRO",
)
X14 = 'xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"'


def com_listas(conteudo, categorias=CATEGORIAS_ORIGINAIS, validacao="LISTAS!$D$2:$D$16", simples=False, cabecalho="CATEGORIA"):
    """Same workbook with a LISTAS sheet (header in D1, ``categorias`` in D2.., a note in A of a loose row below) and the B validation of CHAMADOS."""
    partes = partes_de(conteudo)
    ultima = 1 + len(categorias)
    solta = ultima + 2
    linhas = [f'<row r="1" spans="1:4">{texto("A1", "TIPO", 7)}{texto("D1", cabecalho, 8)}</row>']
    for n, valor in enumerate(categorias, start=2):
        celula = f'<c r="D{n}" s="9" t="s"><v>2</v></c>' if n == 3 else texto(f"D{n}", valor, 9)  # D3 goes through sharedStrings
        linhas.append(f'<row r="{n}" spans="1:4">{texto("A2", "INCIDENTE", 7) if n == 2 else ""}{celula}</row>')
    linhas.append(f'<row r="{solta}" spans="1:1">{texto(f"A{solta}", "nota", 7)}</row>')
    partes[LISTAS] = f'<worksheet {NS}><dimension ref="A1:D{solta}"/><sheetData>{"".join(linhas)}</sheetData></worksheet>'.encode()
    partes["xl/sharedStrings.xml"] = partes["xl/sharedStrings.xml"].replace(b"</sst>", f"<si><t>{categorias[1]}</t></si></sst>".encode())
    partes["xl/workbook.xml"] = partes["xl/workbook.xml"].replace(b"</sheets>", b'<sheet name="LISTAS" sheetId="3" r:id="rId7"/></sheets>')
    partes["xl/_rels/workbook.xml.rels"] = partes["xl/_rels/workbook.xml.rels"].replace(
        b"</Relationships>", f'<Relationship Id="rId7" Type="{DOC}/worksheet" Target="worksheets/sheet5.xml"/></Relationships>'.encode()
    )
    partes["[Content_Types].xml"] = partes["[Content_Types].xml"].replace(
        b"</Types>", b'<Override PartName="/xl/worksheets/sheet5.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'
    )
    folha = partes["xl/worksheets/sheet4.xml"].decode()
    if validacao and simples:
        folha = folha.replace("</sheetData>", f'</sheetData><dataValidations count="1"><dataValidation type="list" sqref="B2:B8"><formula1>{validacao}</formula1></dataValidation></dataValidations>')
    elif validacao:
        folha = folha.replace(
            "</extLst>",
            f'<ext uri="{{y}}"><x14:dataValidations {X14} count="1"><x14:dataValidation type="list" allowBlank="1"><x14:formula1><xm:f>{validacao}</xm:f></x14:formula1>'
            "<xm:sqref>B2:B8</xm:sqref></x14:dataValidation></x14:dataValidations></ext></extLst>",
        )
    partes["xl/worksheets/sheet4.xml"] = folha.encode()
    saida = io.BytesIO()
    with zipfile.ZipFile(saida, "w", zipfile.ZIP_DEFLATED) as arquivo:
        for nome, dados in partes.items():
            arquivo.writestr(nome, dados)
    return saida.getvalue()


def valores_d(conteudo):
    """``(values of LISTAS!D from row 2 on, cell type by row)`` read straight from the XML, sharedStrings included."""
    partes = partes_de(conteudo)
    compartilhadas = [re.sub(r"<[^>]+>", "", s) for s in re.findall(r"<si>(.*?)</si>", partes["xl/sharedStrings.xml"].decode(), re.DOTALL)]
    valores, tipos = [], {}
    for achado in re.finditer(r'<c r="D(\d+)"([^>]*)>(.*?)</c>', partes[LISTAS].decode(), re.DOTALL):
        linha, atributos, corpo = int(achado.group(1)), achado.group(2), achado.group(3)
        if linha == 1:
            continue
        tipos[linha] = (re.search(r' t="(\w+)"', atributos) or [None, None])[1]
        bruto = re.sub(r"<[^>]+>", "", corpo)
        valores.append(compartilhadas[int(bruto)] if tipos[linha] == "s" else bruto)
    return valores, tipos


def validacoes(conteudo):
    folha = partes_de(conteudo)["xl/worksheets/sheet4.xml"].decode()
    return re.findall(r"LISTAS!\$D\$2:\$D\$\d+", folha)


class CategoriasDaListaTest(unittest.TestCase):
    def test_acrescenta_as_quatro_que_faltam_e_estende_a_validacao(self):
        base = com_listas(montar())
        resultado = G.atualizar(base)
        valores, tipos = valores_d(resultado.conteudo)
        self.assertEqual(valores, [*CATEGORIAS_ORIGINAIS, "IMPRESSORA", "LICENÇA", "SISTEMA", "REDE"])
        self.assertEqual({tipos[n] for n in range(17, 21)}, {"inlineStr"})
        self.assertEqual(validacoes(resultado.conteudo), ["LISTAS!$D$2:$D$20"])
        listas = partes_de(resultado.conteudo)[LISTAS].decode()
        self.assertIn('<dimension ref="A1:D20"/>', listas)
        self.assertIn('<c r="D17" s="9" t="inlineStr"><is><t>IMPRESSORA</t></is></c>', listas)
        self.assertIn('<c r="D18" s="9" t="inlineStr"><is><t>LICENÇA</t></is></c>', listas)  # the loose row 18 gains D after its A cell
        self.assertRegex(listas, r'<row r="18" spans="1:4"><c r="A18"[^>]*>.*?</c><c r="D18"')
        self.assertIn('<row r="19"><c r="D19" s="9"', listas)  # rows that did not exist are created in order
        self.assertLess(listas.index('<row r="18"'), listas.index('<row r="19"'))
        ElementTree.fromstring(listas)
        antes, depois = partes_de(base), partes_de(resultado.conteudo)
        self.assertEqual({nome for nome in antes if antes[nome] != depois[nome]}, {"xl/worksheets/sheet4.xml", LISTAS, "xl/workbook.xml", "xl/pivotCache/pivotCacheDefinition2.xml"})
        self.assertEqual(antes["xl/sharedStrings.xml"], depois["xl/sharedStrings.xml"])

    def test_valores_originais_ficam_iguais_e_na_mesma_ordem(self):
        resultado = G.atualizar(com_listas(montar()), [NOVA])
        valores, tipos = valores_d(resultado.conteudo)
        self.assertEqual(valores[: len(CATEGORIAS_ORIGINAIS)], list(CATEGORIAS_ORIGINAIS))
        self.assertEqual([tipos[n] for n in range(2, 17)], ["inlineStr", "s"] + ["inlineStr"] * 13)  # the originals keep their own cell types (D3 stays a sharedStrings cell)

    def test_nao_duplica_a_que_ja_existe_com_outra_grafia(self):
        for existente, faltam in (("Rede", ["IMPRESSORA", "LICENÇA", "SISTEMA"]), ("Licenca", ["IMPRESSORA", "SISTEMA", "REDE"]), (" sistema ", ["IMPRESSORA", "LICENÇA", "REDE"])):
            with self.subTest(existente):
                categorias = (*CATEGORIAS_ORIGINAIS[:-2], existente, "OUTRO")
                resultado = G.atualizar(com_listas(montar(), categorias))
                valores, _ = valores_d(resultado.conteudo)
                self.assertEqual(valores, [*categorias, *faltam])
                self.assertEqual(validacoes(resultado.conteudo), [f"LISTAS!$D$2:$D${16 + len(faltam)}"])

    def test_segunda_geracao_nao_muda_nada(self):
        primeira = G.atualizar(com_listas(montar()))
        segunda = G.atualizar(primeira.conteudo)
        self.assertEqual(partes_de(primeira.conteudo)[LISTAS], partes_de(segunda.conteudo)[LISTAS])
        self.assertEqual(validacoes(segunda.conteudo), ["LISTAS!$D$2:$D$20"])
        self.assertEqual(len(valores_d(segunda.conteudo)[0]), len(CATEGORIAS_ORIGINAIS) + 4)

    def test_validacao_simples_tambem_e_estendida_e_a_mais_longa_fica_como_esta(self):
        self.assertEqual(validacoes(G.atualizar(com_listas(montar(), simples=True)).conteudo), ["LISTAS!$D$2:$D$20"])
        longa = G.atualizar(com_listas(montar(), validacao="LISTAS!$D$2:$D$30"))
        self.assertEqual(validacoes(longa.conteudo), ["LISTAS!$D$2:$D$30"])  # the user's own range is not shortened
        self.assertEqual(len(valores_d(longa.conteudo)[0]), len(CATEGORIAS_ORIGINAIS) + 4)

    def test_sem_listas_ou_fora_do_formato_a_geracao_segue_sem_mexer(self):
        with self.assertLogs("domains.sebrae_dashboard_gravacao", "WARNING") as aviso:
            sem_aba = G.atualizar(montar(), [NOVA])
        self.assertNotIn("UTIC", " ".join(aviso.output))  # the warning carries no ticket data
        self.assertNotIn("LISTAS", b"".join(partes_de(sem_aba.conteudo).values()).decode("utf-8", "ignore"))
        for nome, base in {
            "sem validação": com_listas(montar(), validacao=None),
            "outro cabeçalho": com_listas(montar(), cabecalho="TIPO"),
        }.items():
            with self.subTest(nome):
                with self.assertLogs("domains.sebrae_dashboard_gravacao", "WARNING"):
                    resultado = G.atualizar(base, [NOVA])
                self.assertEqual(resultado.linhas[0].numero, "UTIC-2026-0099")
                self.assertEqual(partes_de(base)[LISTAS], partes_de(resultado.conteudo)[LISTAS])

    def test_lista_com_buraco_ou_formula_nao_e_tocada(self):
        base = com_listas(montar())
        partes = partes_de(base)
        listas = partes[LISTAS].decode()
        for nome, alterada in {
            "buraco": listas.replace('<row r="9" spans="1:4">' + texto("D9", "BACKUP", 9) + "</row>", ""),
            "fórmula": listas.replace(texto("D9", "BACKUP", 9), '<c r="D9" s="9"><f>"x"</f><v>x</v></c>'),
        }.items():
            with self.subTest(nome):
                self.assertNotEqual(alterada, listas)
                partes[LISTAS] = alterada.encode()
                saida = io.BytesIO()
                with zipfile.ZipFile(saida, "w", zipfile.ZIP_DEFLATED) as arquivo:
                    for parte, dados in partes.items():
                        arquivo.writestr(parte, dados)
                resultado = G.atualizar(saida.getvalue())
                self.assertEqual(partes_de(resultado.conteudo)[LISTAS], partes[LISTAS])
                self.assertEqual(validacoes(resultado.conteudo), ["LISTAS!$D$2:$D$16"])

    def test_encerrar_chamado_nao_mexe_nas_listas(self):
        base = com_listas(montar())
        novo, estados = G.registrar_encerramentos(base, {"UTIC-2026-0001": "09/11/2026 10:00"})
        self.assertEqual(estados, {"UTIC-2026-0001": G.ENCERRAMENTO_GRAVADO})
        self.assertEqual(partes_de(novo.conteudo)[LISTAS], partes_de(base)[LISTAS])
        self.assertEqual(validacoes(novo.conteudo), ["LISTAS!$D$2:$D$16"])

    def test_conferencia_recusa_lista_alterada(self):
        base = com_listas(montar())
        pacote = G._ler_pacote(base)
        texto_da_aba = pacote.texto(pacote.aba)
        _, _, linhas = G._linhas_da_aba(texto_da_aba)
        anteriores = G.ler_coluna_c(base)
        ordem = G._ordenar(pacote, linhas, {})
        bom = G._montar(pacote, texto_da_aba, linhas, ordem.substituicoes, False, True)
        G._conferir(bom, anteriores, [], pacote, ordem, True)  # the real output passes
        listas = partes_de(bom)[LISTAS].decode()
        adulteradas = {
            "valor trocado": listas.replace("<t>ACESSO</t>", "<t>OUTRO ACESSO</t>"),
            "valor removido": re.sub(r'<row r="5"[^>]*>.*?</row>', "", listas),
            "acréscimo repetido": listas.replace("<t>LICENÇA</t>", "<t>SISTEMA</t>"),
            "acréscimo fora da lista": listas.replace("<t>REDE</t>", "<t>OUTRA COISA</t>"),
        }
        for nome, alterada in adulteradas.items():
            with self.subTest(nome):
                self.assertNotEqual(alterada, listas)
                partes = partes_de(bom)
                partes[LISTAS] = alterada.encode()
                saida = io.BytesIO()
                with zipfile.ZipFile(saida, "w", zipfile.ZIP_DEFLATED) as arquivo:
                    for parte, dados in partes.items():
                        arquivo.writestr(parte, dados)
                with self.assertRaisesRegex(G.GravacaoInvalida, "categorias"):
                    G._conferir(saida.getvalue(), anteriores, [], pacote, ordem, True)


if __name__ == "__main__":
    unittest.main()
