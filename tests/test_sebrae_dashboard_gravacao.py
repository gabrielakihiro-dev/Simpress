import io
import re
import unittest
import zipfile

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


def linha_de_chamado(n, chamado, d="EM ABERTO", a="SIMPRESS"):
    celulas = texto(f"A{n}", a, 60) + texto(f"C{n}", chamado) + texto(f"D{n}", d, 55) + texto(f"G{n}", "titulo", 112)
    celulas += f'<c r="P{n}" s="92"><v>46000.5</v></c>' + formulas(n)
    return f'<row r="{n}" spans="1:22">{celulas}</row>'


def linha_vazia(n, com_q=True):
    return f'<row r="{n}" spans="1:22"><c r="G{n}" s="112" t="s"><v>1</v></c>{formulas(n, com_q)}</row>'


def montar(chamados=("UTIC-2026-0001", "UTIC-2026-0002"), ultima=8, status=("EM ABERTO", "FINALIZADO")):
    cabecalho = "".join(texto(f"{letra}1", titulo, 1) for letra, titulo in CABECALHOS.items())
    linhas = [f'<row r="1">{cabecalho}</row>']
    for indice, chamado in enumerate(chamados):
        linhas.append(linha_de_chamado(2 + indice, chamado, status[indice]))
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
            "</Types>"
        ),
        "_rels/.rels": (
            f'<Relationships xmlns="{REL}"><Relationship Id="rId1" Type="{DOC}/officeDocument" Target="xl/workbook.xml"/></Relationships>'
        ),
        "xl/workbook.xml": f'<workbook {NS}><sheets><sheet name="CHAMADOS" sheetId="2" r:id="rId4"/></sheets><calcPr calcId="191028"/></workbook>',
        "xl/_rels/workbook.xml.rels": (
            f'<Relationships xmlns="{REL}"><Relationship Id="rId4" Type="{DOC}/worksheet" Target="worksheets/sheet4.xml"/>'
            f'<Relationship Id="rId5" Type="{DOC}/sharedStrings" Target="sharedStrings.xml"/></Relationships>'
        ),
        "xl/worksheets/sheet4.xml": f'<worksheet {NS}><sheetData>{"".join(linhas)}</sheetData><extLst><ext uri="{{x}}">keep-validation</ext></extLst></worksheet>',
        "xl/worksheets/_rels/sheet4.xml.rels": (
            f'<Relationships xmlns="{REL}"><Relationship Id="rId2" Type="{DOC}/table" Target="../tables/table2.xml"/></Relationships>'
        ),
        "xl/tables/table2.xml": f'<table xmlns="x" name="Tabela3" displayName="Tabela3" ref="A1:W{ultima}"/>',
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

    def test_novo_e_edicao_juntos(self):
        resultado = G.atualizar(montar(), [NOVA], {"UTIC-2026-0001": {"A": "CLIENTE"}})
        self.assertEqual({(g.numero, g.tipo) for g in resultado.linhas}, {("UTIC-2026-0099", "novo"), ("UTIC-2026-0001", "alterado")})


if __name__ == "__main__":
    unittest.main()
