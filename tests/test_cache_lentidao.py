"""Caches da correção de lentidão (Resumo F3 e Relatório): a resposta tem de ser a mesma de antes, só mais rápida.

Dados sintéticos: séries `BRT8xx...`, nomes fictícios e um .xlsx montado na hora; nada de `config/cliente.json` real.
"""

import json
import os
import tempfile
import unittest
from datetime import datetime
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

import openpyxl

import core.config as app_config
from domains import regras_negocio, sebrae_cruzamento, sebrae_dashboard
from domains.equipment_search import normalize_search_term
from domains.inventory_comparison import filter_sebrae_owned_unmatched_items
from domains.regras_negocio import e_serie_sebrae, normalize_reference_value, predicado_serie_sebrae, series_sebrae
from domains.sebrae_dashboard import CABECALHOS, DashboardInvalido, ler_datas_chamados

VARIAVEL = "SIMPRESS_CLIENTE_SERIES_SEBRAE_FORA"
CLIENTE = {"contrato": "20202", "cnpj_faturamento": "44.555.666/0001-81"}


class SeriesSebraeMemorizadasTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.arquivo = Path(self.temp.name) / "cliente.json"
        for patcher in (patch.dict(os.environ, {}), patch.object(app_config, "CLIENT_CONFIG_FILE", self.arquivo)):
            patcher.start()
            self.addCleanup(patcher.stop)
        os.environ.pop(VARIAVEL, None)

    def grava(self, series, mtime_ns=None):
        self.arquivo.write_text(json.dumps({**CLIENTE, "series_sebrae_fora": series}), encoding="utf-8")
        if mtime_ns is not None:
            os.utime(self.arquivo, ns=(mtime_ns, mtime_ns))

    def test_variavel_de_ambiente_trocada_muda_a_resposta(self):
        os.environ[VARIAVEL] = "BRT800XA01"
        predicado = predicado_serie_sebrae()
        self.assertTrue(e_serie_sebrae("brt-800 xa01"))
        self.assertTrue(predicado("BRT800XA01"))
        self.assertFalse(e_serie_sebrae("BRT800XA02"))
        os.environ[VARIAVEL] = "BRT800XA02, BRT800XA03"
        self.assertFalse(e_serie_sebrae("BRT800XA01"))
        self.assertTrue(e_serie_sebrae("BRT800XA02"))
        self.assertFalse(predicado_serie_sebrae()("BRT800XA01"))
        self.assertTrue(predicado_serie_sebrae()("brt800xa03"))
        self.assertEqual(series_sebrae(), frozenset({"BRT800XA02", "BRT800XA03"}))

    def test_arquivo_mudado_muda_a_resposta_mesmo_com_o_mesmo_tamanho(self):
        self.grava(["BRT800XB01"], mtime_ns=1_700_000_000_000_000_000)
        self.assertTrue(e_serie_sebrae("BRT800XB01"))
        self.assertFalse(e_serie_sebrae("BRT800XB02"))
        self.grava(["BRT800XB02"], mtime_ns=1_700_000_001_000_000_000)  # mesmo tamanho, outro mtime
        self.assertFalse(e_serie_sebrae("BRT800XB01"))
        self.assertTrue(e_serie_sebrae("BRT800XB02"))
        self.assertTrue(predicado_serie_sebrae()("BRT800XB02"))

    def test_arquivo_ausente_ou_invalido_nao_deixa_nenhuma_serie_de_fora(self):
        self.grava(["BRT800XC01"])
        self.assertTrue(e_serie_sebrae("BRT800XC01"))
        self.arquivo.write_text("{não é json", encoding="utf-8")
        self.assertFalse(e_serie_sebrae("BRT800XC01"))
        self.assertEqual(series_sebrae(), frozenset())
        self.grava(["BRT800XC01"])
        self.assertTrue(e_serie_sebrae("BRT800XC01"))
        self.arquivo.unlink()
        self.assertFalse(e_serie_sebrae("BRT800XC01"))

    def test_entradas_vazias_ou_so_pontuacao_sao_descartadas_como_antes(self):
        os.environ[VARIAVEL] = "BRT800XD01, ---, BRT800XD02"
        esperado = frozenset(filter(None, (normalize_reference_value(s) for s in app_config.client_own_serials())))
        self.assertEqual(series_sebrae(), esperado)
        self.assertEqual(series_sebrae(), frozenset({"BRT800XD01", "BRT800XD02"}))
        self.assertFalse(e_serie_sebrae(None))
        self.assertFalse(e_serie_sebrae(""))

    def test_filtro_de_itens_sem_par_da_o_mesmo_resultado_de_antes(self):
        os.environ[VARIAVEL] = "BRT800XE01,BRT800XE02"
        itens = [
            {"serie": "brt-800-xe01", "nome": "Fulano Fictício"},
            {"serie": "BRT800XE99"},
            "texto solto",
            {"sem_serie": True},
            {"serie": None},
            {"serie": " BRT800XE02 "},
        ]
        antes = [item for item in itens if not isinstance(item, dict) or not e_serie_sebrae(item.get("serie"))]
        self.assertEqual(filter_sebrae_owned_unmatched_items(itens), antes)
        self.assertEqual(len(antes), 4)
        self.assertEqual(filter_sebrae_owned_unmatched_items("não é lista"), [])
        os.environ[VARIAVEL] = "BRT800XE99"
        self.assertEqual([i for i in filter_sebrae_owned_unmatched_items(itens) if isinstance(i, dict) and i.get("serie")],
                         [{"serie": "brt-800-xe01", "nome": "Fulano Fictício"}, {"serie": " BRT800XE02 "}])

    def test_conjunto_so_e_recalculado_quando_o_valor_bruto_muda(self):
        os.environ[VARIAVEL] = "BRT800XF01"
        with patch.object(regras_negocio, "normalize_reference_value", wraps=normalize_reference_value) as normaliza:
            series_sebrae()
            chamadas = normaliza.call_count
            for _ in range(5):
                series_sebrae()
            self.assertEqual(normaliza.call_count, chamadas)
            os.environ[VARIAVEL] = "BRT800XF02"
            series_sebrae()
            self.assertGreater(normaliza.call_count, chamadas)


def xlsx_dashboard(linhas):
    """Dashboard sintético: cabeçalho de CABECALHOS e uma linha por `(chamado, titulo, serie, abertura)`."""
    livro = openpyxl.Workbook()
    aba = livro.active
    aba.title = "CHAMADOS"
    aba.append(list(CABECALHOS.values()))
    for chamado, titulo, serie, abertura in linhas:
        linha = [None] * len(CABECALHOS)
        linha[2], linha[6], linha[10], linha[15] = chamado, titulo, serie, abertura
        aba.append(linha)
    saida = BytesIO()
    livro.save(saida)
    return saida.getvalue()


class DatasDoDashboardMemorizadasTests(unittest.TestCase):
    def setUp(self):
        patcher = patch.object(sebrae_dashboard, "_datas_chamados_cache", (b"", []))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.a = xlsx_dashboard([("UTIC-2026-0801", "Teclado", " SN-FIC-801 ", datetime(2026, 10, 2, 9, 0))])
        self.b = xlsx_dashboard([("UTIC-2026-0802", "Mouse", "SN-FIC-802", datetime(2026, 10, 3, 9, 0)),
                                 ("UTIC-2026-0803", "Monitor", "SN-FIC-803", "05/10/2026")])

    def test_mesmos_bytes_dao_resultado_igual_em_objetos_distintos(self):
        primeiro = ler_datas_chamados(self.a)
        segundo = ler_datas_chamados(self.a)
        self.assertEqual(primeiro, segundo)
        self.assertIsNot(primeiro, segundo)
        self.assertIsNot(primeiro[0], segundo[0])
        self.assertEqual((primeiro[0]["linha"], primeiro[0]["serie"]), (2, "SN-FIC-801"))

    def test_alterar_o_retorno_nao_estraga_a_chamada_seguinte(self):
        primeiro = ler_datas_chamados(self.a)
        original = [dict(item) for item in primeiro]
        primeiro[0]["titulo"] = "alterado"
        primeiro[0]["extra"] = 1
        primeiro.append({"linha": 99})
        ler_datas_chamados(self.a)  # lê do cache (a primeira chamada gravou)
        segundo = ler_datas_chamados(self.a)
        segundo[0]["titulo"] = "outro"
        self.assertEqual(ler_datas_chamados(self.a), original)

    def test_bytes_diferentes_dao_outro_resultado_e_voltar_recalcula_igual(self):
        resultado_a = ler_datas_chamados(self.a)
        resultado_b = ler_datas_chamados(self.b)
        self.assertNotEqual(resultado_a, resultado_b)
        self.assertEqual([item["chamado"] for item in resultado_b], ["UTIC-2026-0802", "UTIC-2026-0803"])
        self.assertEqual(ler_datas_chamados(self.a), resultado_a)

    def test_resultado_memorizado_e_igual_ao_calculado_sem_cache(self):
        memorizado = ler_datas_chamados(self.b)
        memorizado = ler_datas_chamados(self.b)
        with patch.object(sebrae_dashboard, "_datas_chamados_cache", (b"", [])):
            self.assertEqual(ler_datas_chamados(self.b), memorizado)

    def test_a_planilha_so_e_aberta_uma_vez_para_os_mesmos_bytes(self):
        with patch.object(sebrae_dashboard, "_linhas_preenchidas", wraps=sebrae_dashboard._linhas_preenchidas) as abre:
            for _ in range(4):
                ler_datas_chamados(self.a)
            self.assertEqual(abre.call_count, 1)

    def test_xlsx_invalido_levanta_em_toda_chamada_mesmo_repetida(self):
        invalido = b"isto nao e um xlsx"
        for _ in range(3):
            with self.assertRaises(DashboardInvalido):
                ler_datas_chamados(invalido)
        ler_datas_chamados(self.a)  # um sucesso no cache não esconde o erro de outros bytes
        for _ in range(2):
            with self.assertRaises(DashboardInvalido):
                ler_datas_chamados(invalido)

    def test_cabecalho_errado_levanta_em_toda_chamada(self):
        livro = openpyxl.Workbook()
        livro.active.title = "CHAMADOS"
        livro.active.append(["A", "B", "C"])
        saida = BytesIO()
        livro.save(saida)
        for _ in range(2):
            with self.assertRaises(DashboardInvalido):
                ler_datas_chamados(saida.getvalue())


def palavras_original(texto):
    """Fórmula de `_palavras` antes do cache, copiada à parte para comparar."""
    return " " + " ".join("".join(c if c.isalnum() else " " for c in normalize_search_term(texto)).split()) + " "


class PalavrasMemorizadasTests(unittest.TestCase):
    def test_saida_igual_a_original_para_none_int_str_e_outros_tipos(self):
        casos = [None, 0, 123, 4.5, True, "", "   ", "Ana Souza", "  João  da-Silva (M) ", "ÁÉÍ ÕÜ", ["Ana"], b"x"]
        for caso in casos:
            with self.subTest(caso=caso):
                self.assertEqual(sebrae_cruzamento._palavras(caso), palavras_original(caso))
                self.assertEqual(sebrae_cruzamento._palavras(caso), palavras_original(caso))  # repetida: mesmo valor

    def test_so_str_passa_pelo_cache(self):
        sebrae_cruzamento._palavras_de_str.cache_clear()
        sebrae_cruzamento._palavras("Beltrano Fictício")
        sebrae_cruzamento._palavras("Beltrano Fictício")
        info = sebrae_cruzamento._palavras_de_str.cache_info()
        self.assertEqual((info.hits, info.misses), (1, 1))
        for valor in (None, 7, 7.5):
            sebrae_cruzamento._palavras(valor)
        self.assertEqual(sebrae_cruzamento._palavras_de_str.cache_info().currsize, 1)

    def test_pessoas_citadas_nao_muda(self):
        registros = [{"nome": "Ana Souza"}, {"nome": "Ana Souza Lima"}, {"nome": "Carlos Fictício"}, {"nome": None}, {}]
        for _ in range(2):
            self.assertEqual(
                sebrae_cruzamento.pessoas_citadas("Notebook da ana souza lima, ok", "Carlos Fictício", registros),
                ["Ana Souza Lima"],
            )
            self.assertEqual(sebrae_cruzamento.pessoas_citadas(None, "Carlos", registros), [])


if __name__ == "__main__":
    unittest.main()
