import io
import json
import tempfile
import unittest
from pathlib import Path

from openpyxl import Workbook

from domains import sebrae_historico as hist
from domains.sebrae_dashboard import ler_status_chamados
from tests.test_sebrae_dashboard import CABECALHO


def planilha_com_status(linhas, cabecalho=CABECALHO):
    """Dashboard with ``(C, D, R, F)`` per row; F is a free text column the history must never read."""
    livro = Workbook()
    ws = livro.active
    ws.title = "CHAMADOS"
    ws.append(cabecalho)
    for c, d, r, f in linhas:
        linha = [None] * 23
        linha[2], linha[3], linha[5], linha[17] = c, d, f, r
        ws.append(linha)
    buffer = io.BytesIO()
    livro.save(buffer)
    return buffer.getvalue()


def mapa(**itens):
    """``mapa(A=("EM ABERTO", ""))`` -> {"UTIC-2026-000A"...}; keys are the last digits."""
    return {f"UTIC-2026-{chave}": {"status": s, "encerramento": r} for chave, (s, r) in itens.items()}


ABERTO = ("EM ABERTO", "")
FECHADO = ("FINALIZADO", "28/10/2026 10:00")


class Base(unittest.TestCase):
    def setUp(self):
        self.caminho = Path(tempfile.mkdtemp()) / "sebrae_historico.json"

    def importar(self, m, arquivo="Dashboard.xlsx", sha="a" * 64, **extra):
        return hist.registrar_importacao(self.caminho, arquivo=arquivo, sha256=sha, mapa=m, **extra)


class ImportacaoTest(Base):
    def test_primeira_importacao_e_inicial_e_nao_lista_chamados(self):
        r = self.importar(mapa(**{"0001": ABERTO, "0002": FECHADO}))
        e = r["entrada"]
        self.assertTrue(e["inicial"])
        self.assertEqual((e["total"], e["adicionados"], e["removidos"], e["alterados"]), (2, [], [], []))
        self.assertEqual(e["repeticoes"], 0)

    def test_mostra_adicionados_removidos_e_mudanca_de_status(self):
        self.importar(mapa(**{"0001": ABERTO, "0002": ABERTO, "0003": ABERTO}))
        e = self.importar(mapa(**{"0001": FECHADO, "0002": ABERTO, "0004": ABERTO}), sha="b" * 64)["entrada"]
        self.assertEqual(e["adicionados"], ["UTIC-2026-0004"])
        self.assertEqual(e["removidos"], ["UTIC-2026-0003"])
        self.assertEqual(e["alterados"], [
            {"numero": "UTIC-2026-0001", "de": "EM ABERTO", "para": "FINALIZADO", "encerramento": "28/10/2026 10:00"}])
        self.assertFalse(e["inicial"])

    def test_importacao_sem_mudanca_so_conta_reimportado(self):
        primeira = self.importar(mapa(**{"0001": ABERTO}))["entrada"]
        r = self.importar(mapa(**{"0001": ABERTO}), sha="c" * 64)
        self.assertTrue(r["reimportado"])
        self.assertEqual(r["entrada"]["id"], primeira["id"])
        self.assertEqual(r["entrada"]["repeticoes"], 1)
        self.assertTrue(r["entrada"]["ultima_repeticao_em"])
        self.assertEqual(hist.listar(self.caminho)["total"], 1)

    def test_base_externa_serve_de_comparacao_quando_nao_ha_historico(self):
        e = self.importar(mapa(**{"0001": ABERTO, "0002": ABERTO}), base_numeros={"UTIC-2026-0001"})["entrada"]
        self.assertFalse(e["inicial"])
        self.assertEqual((e["adicionados"], e["removidos"], e["alterados"]), (["UTIC-2026-0002"], [], []))

    def test_guarda_so_nome_do_arquivo_mascarado(self):
        e = self.importar(mapa(**{"0001": ABERTO}), arquivo="C:\\x\\Dash 123.456.789-09.xlsx")["entrada"]
        self.assertEqual(e["arquivo"], "Dash ***.***.***-**.xlsx")

    def test_listas_longas_sao_cortadas_e_marcadas(self):
        self.importar(mapa(**{"0000": ABERTO}))
        grande = {f"UTIC-2026-{n:04d}": {"status": "EM ABERTO", "encerramento": ""} for n in range(hist.MAX_NUMEROS + 5)}
        e = self.importar(grande, sha="d" * 64)["entrada"]
        self.assertEqual(len(e["adicionados"]), hist.MAX_NUMEROS)
        self.assertTrue(e["truncado"])
        self.assertEqual(e["n_adicionados"], hist.MAX_NUMEROS + 4)

    def test_retencao_das_200_mais_recentes(self):
        for n in range(hist.MAX_ENTRADAS + 3):
            self.importar(mapa(**{f"{n:04d}": ABERTO}), sha=f"{n:064d}")
        lista = hist.listar(self.caminho, limite=200)
        self.assertEqual(lista["total"], hist.MAX_ENTRADAS)
        self.assertEqual(lista["itens"][0]["seq"], hist.MAX_ENTRADAS + 3)


class BuscaTest(Base):
    def test_busca_guarda_so_numeros_e_ligada_a_ultima_importacao(self):
        imp = self.importar(mapa(**{"0001": ABERTO}))["entrada"]
        e = hist.registrar_busca(self.caminho, lidos=["UTIC-2026-0005"], ignorados=3,
                                 pendentes=["UTIC-2026-0006"], erros=["UTIC-2026-0007"])
        self.assertEqual(e["tipo"], "busca")
        self.assertEqual(e["importacao_id"], imp["id"])
        self.assertEqual((e["n_lidos"], e["ignorados"], e["n_pendentes"], e["n_erros"]), (1, 3, 1, 1))
        self.assertEqual(e["lidos"], ["UTIC-2026-0005"])

    def test_reimportar_depois_de_uma_busca_incrementa_a_importacao_nao_a_busca(self):
        imp = self.importar(mapa(**{"0001": ABERTO}))["entrada"]
        hist.registrar_busca(self.caminho, lidos=[], ignorados=1, pendentes=[], erros=[])
        r = self.importar(mapa(**{"0001": ABERTO}), sha="e" * 64)
        self.assertEqual((r["entrada"]["id"], r["entrada"]["repeticoes"]), (imp["id"], 1))


class ListagemTest(Base):
    def test_listar_sem_arquivo_e_filtro_paginacao_e_detalhe(self):
        self.assertEqual(hist.listar(self.caminho), {"total": 0, "pagina": 1, "itens": [], "importacoes": 0, "buscas": 0})
        self.importar(mapa(**{"0001": ABERTO}))
        hist.registrar_busca(self.caminho, lidos=[], ignorados=0, pendentes=[], erros=[])
        todas = hist.listar(self.caminho)
        self.assertEqual((todas["total"], todas["importacoes"], todas["buscas"]), (2, 1, 1))
        self.assertEqual(todas["itens"][0]["tipo"], "busca")  # newest first
        self.assertNotIn("adicionados", todas["itens"][1])  # light items carry counts only
        self.assertEqual(hist.listar(self.caminho, tipo="importacao")["total"], 1)
        self.assertEqual(len(hist.listar(self.caminho, limite=1, pagina=2)["itens"]), 1)
        completo = hist.obter(self.caminho, todas["itens"][1]["id"])
        self.assertIn("adicionados", completo)
        self.assertIsNone(hist.obter(self.caminho, "nao-existe"))

    def test_arquivo_ilegivel_nao_e_sobrescrito(self):
        self.caminho.write_text("{ quebrado", encoding="utf-8")
        with self.assertRaises(hist.HistoricoIlegivel):
            hist.listar(self.caminho)
        with self.assertRaises(hist.HistoricoIlegivel):
            self.importar(mapa(**{"0001": ABERTO}))
        self.assertEqual(self.caminho.read_text(encoding="utf-8"), "{ quebrado")

    def test_mapa_guarda_so_status_e_data(self):
        self.importar(mapa(**{"0001": FECHADO}))
        dados = json.loads(self.caminho.read_text(encoding="utf-8"))
        self.assertEqual(dados["mapa"], {"UTIC-2026-0001": {"status": "FINALIZADO", "encerramento": "28/10/2026 10:00"}})


class LeituraDeStatusTest(unittest.TestCase):
    def test_le_so_status_valido_e_data_das_colunas_d_e_r(self):
        conteudo = planilha_com_status([
            ("UTIC-2026-0001", "EM ABERTO", None, "texto A"),
            ("27371 / UTIC-2026-0002", "finalizado", "28/10/2026 10:00", "x"),
            ("UTIC-2026-0003", "segredo qualquer", "lixo", "y"),
            ("Sem chamado", "EM ABERTO", None, "z"),
        ])
        self.assertEqual(ler_status_chamados(conteudo), {
            "UTIC-2026-0001": {"status": "EM ABERTO", "encerramento": ""},
            "UTIC-2026-0002": {"status": "FINALIZADO", "encerramento": "28/10/2026 10:00"},
            "UTIC-2026-0003": {"status": "", "encerramento": ""},
        })

    def test_data_como_datetime_vira_texto_do_dashboard_e_cabecalho_errado_recusa(self):
        from datetime import datetime
        from domains.sebrae_dashboard import DashboardInvalido
        conteudo = planilha_com_status([("UTIC-2026-0001", "FINALIZADO", datetime(2026, 10, 28, 9, 5), "")])
        self.assertEqual(ler_status_chamados(conteudo)["UTIC-2026-0001"]["encerramento"], "28/10/2026 09:05")
        with self.assertRaises(DashboardInvalido):
            ler_status_chamados(planilha_com_status([("UTIC-2026-0001", "", None, "")], cabecalho=CABECALHO[:6] + CABECALHO[7:]))


if __name__ == "__main__":
    unittest.main()
