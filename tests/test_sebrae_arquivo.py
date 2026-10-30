import json
import tempfile
import unittest
from pathlib import Path

from domains import sebrae_arquivo


def aberto(numero, **valores):
    return {"numero": numero, "titulo": "Texto livre", "usuario": "Camila Lopes", "valores": {"A": "CLIENTE", **valores}}


def final(encerramento="28/10/2026 10:00"):
    return {"status": "FINALIZADO", "encerramento": encerramento}


class ArquivoEncerradosTest(unittest.TestCase):
    def setUp(self):
        self.caminho = Path(tempfile.mkdtemp()) / "sebrae_chamados_encerrados.json"

    def registrar(self, abertos, mapa, **extra):
        return sebrae_arquivo.registrar_saidas(self.caminho, abertos_antes=abertos, mapa=mapa, **extra)

    def test_finalizado_e_removido_entram_e_aberto_continua_fora(self):
        resultado = self.registrar(
            [aberto("UTIC-1", B="REDE", J="INCIDENTE", S="DISPONIBILIDADE"), aberto("UTIC-2"), aberto("UTIC-3")],
            {"UTIC-1": final(), "UTIC-3": {"status": "EM ABERTO", "encerramento": ""}},
            visto_em="2026-10-27T09:00:00-03:00", sha256="h1",
        )
        self.assertEqual(resultado, {"registrados": 2, "semeados": 0, "nao_rastreaveis": 0})
        itens = sebrae_arquivo.ler(self.caminho)["itens"]
        self.assertEqual(sorted(itens), ["UTIC-1", "UTIC-2"])
        self.assertEqual((itens["UTIC-1"]["categoria"], itens["UTIC-1"]["tipo"], itens["UTIC-1"]["sla"]), ("REDE", "INCIDENTE", "DISPONIBILIDADE"))
        ciclo = itens["UTIC-1"]["ciclos"][0]
        self.assertEqual((ciclo["motivo"], ciclo["status"], ciclo["encerramento"]), ("finalizado", "FINALIZADO", "28/10/2026 10:00"))
        self.assertEqual(ciclo["visto_aberto_em"], "2026-10-27T09:00:00-03:00")
        self.assertEqual(itens["UTIC-2"]["ciclos"][0]["motivo"], "saiu_do_dashboard")

    def test_mesma_importacao_repetida_nao_duplica_o_ciclo(self):
        for _ in range(2):
            self.registrar([aberto("UTIC-1")], {"UTIC-1": final()}, sha256="h1")
        self.assertEqual(len(sebrae_arquivo.ler(self.caminho)["itens"]["UTIC-1"]["ciclos"]), 1)

    def test_chamado_reaberto_que_fecha_de_novo_ganha_outro_ciclo(self):
        self.registrar([aberto("UTIC-1")], {"UTIC-1": final()}, sha256="h1")
        self.registrar([aberto("UTIC-1")], {"UTIC-1": final("29/10/2026 08:00")}, sha256="h2")
        ciclos = sebrae_arquivo.ler(self.caminho)["itens"]["UTIC-1"]["ciclos"]
        self.assertEqual([c["encerramento"] for c in ciclos], ["28/10/2026 10:00", "29/10/2026 08:00"])

    def test_primeira_vez_semeia_os_finalizados_que_ja_estao_no_dashboard(self):
        mapa = {"UTIC-1": final(), "UTIC-2": {"status": "EM ABERTO", "encerramento": ""}, "UTIC-3": final("01/10/2026 09:00")}
        self.assertEqual(self.registrar([], mapa, sha256="h1")["semeados"], 2)
        self.assertEqual(sorted(sebrae_arquivo.ler(self.caminho)["itens"]), ["UTIC-1", "UTIC-3"])
        # later imports only follow the tickets that leave the open list
        self.assertEqual(self.registrar([], {**mapa, "UTIC-4": final()}, sha256="h2")["semeados"], 0)

    def test_chamado_sem_utic_unico_so_e_contado(self):
        resultado = self.registrar([aberto("linha:7"), aberto("UTIC-1")], {"UTIC-1": final()}, sha256="h1")
        self.assertEqual((resultado["registrados"], resultado["nao_rastreaveis"]), (1, 1))
        dados = sebrae_arquivo.ler(self.caminho)
        self.assertEqual((sorted(dados["itens"]), dados["nao_rastreaveis"]), (["UTIC-1"], 1))

    def test_nao_guarda_texto_livre_nome_nem_responsavel(self):
        self.registrar([aberto("UTIC-1")], {"UTIC-1": final()}, sha256="h1")
        conteudo = self.caminho.read_text(encoding="utf-8")
        for proibido in ("Texto livre", "Camila", "CLIENTE"):
            self.assertNotIn(proibido, conteudo)

    def test_arquivo_ilegivel_nao_e_sobrescrito(self):
        self.caminho.write_text("{ quebrado", encoding="utf-8")
        with self.assertRaises(sebrae_arquivo.ArquivoIlegivel):
            self.registrar([aberto("UTIC-1")], {"UTIC-1": final()})
        self.assertEqual(self.caminho.read_text(encoding="utf-8"), "{ quebrado")
        self.caminho.write_text(json.dumps({"itens": []}), encoding="utf-8")
        with self.assertRaises(sebrae_arquivo.ArquivoIlegivel):
            self.registrar([], {})


if __name__ == "__main__":
    unittest.main()
