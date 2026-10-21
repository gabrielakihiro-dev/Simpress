"""Validação do XLSX do Endpoint antes da importação (sem navegador)."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from openpyxl import Workbook

from scripts import automacao_rotinas_chrome as automacao

CAB = ["Nome do computador", "Rótulo de serviço/Número de série", "Usuários logados"]


def gerar(pasta: Path, linhas: int, cabecalho=CAB) -> Path:
    wb = Workbook()
    ws = wb.active
    ws.append(cabecalho)
    for i in range(linhas):
        ws.append([f"PC{i}", f"SER{i}", "u"])
    caminho = pasta / "e.xlsx"
    wb.save(caminho)
    return caminho


class ValidarXlsxEndpointTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.pasta = Path(tmp.name)
        patcher = patch.object(automacao, "log")
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_conta_linhas(self):
        self.assertEqual(automacao.validar_xlsx_endpoint(gerar(self.pasta, 12)), 12)

    def test_cabecalho_ausente(self):
        with self.assertRaises(automacao.RotinaErro):
            automacao.validar_xlsx_endpoint(gerar(self.pasta, 3, ["A", "B"]))

    def test_sem_linhas(self):
        with self.assertRaises(automacao.RotinaErro):
            automacao.validar_xlsx_endpoint(gerar(self.pasta, 0))

    def test_total_da_tela(self):
        arquivo = gerar(self.pasta, 100)
        self.assertEqual(automacao.validar_xlsx_endpoint(arquivo, 103), 100)
        with self.assertRaises(automacao.RotinaErro):
            automacao.validar_xlsx_endpoint(arquivo, 300)

    def test_arquivo_invalido(self):
        ruim = self.pasta / "x.xlsx"
        ruim.write_text("não é xlsx")
        with self.assertRaises(automacao.RotinaErro):
            automacao.validar_xlsx_endpoint(ruim)


if __name__ == "__main__":
    unittest.main()
