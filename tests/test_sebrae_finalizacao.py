import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from core.errors import DomainValidationError
from domains import sebrae_dashboard_gravacao as G
from domains import sebrae_finalizacao as fin
from domains.sebrae_dashboard import ler_coluna_c
from tests.test_sebrae_dashboard_gravacao import linha_xml, montar

UTIC = "UTIC-2026-0001"
PDF = b"%PDF-1.4\n%fake\n"
R_1405 = r'<c r="R\d+"[^>]*><v>46325\.586'  # 30/10/2026 14:05 as an Excel serial date


class ValidacaoTest(unittest.TestCase):
    def test_numero_aceita_utic_e_recusa_o_resto_com_422(self):
        self.assertEqual(fin.validar_numero(" utic-2026-0001 "), UTIC)
        for ruim in ("", "linha:2", "UTIC-26-1", "../x", "UTIC-2026-0001; rm"):
            with self.assertRaises(DomainValidationError) as ctx:
                fin.validar_numero(ruim)
            self.assertEqual(ctx.exception.status_code, 422)

    def test_descricao_mantem_quebras_tira_controles_e_limita_4000(self):
        self.assertEqual(fin.validar_descricao("  a\r\nb\x00c \x07"), "a\nbc")
        self.assertEqual(fin.validar_descricao(None), "")
        self.assertEqual(len(fin.validar_descricao("x" * 4000)), 4000)
        with self.assertRaises(DomainValidationError):
            fin.validar_descricao("x" * 4001)

    def test_nome_do_pdf_com_nome_reservado_do_windows_ganha_prefixo(self):
        for nome, esperado in (
            ("CON.pdf", "_CON.pdf"), ("nul.pdf", "_nul.pdf"), ("com1.x.pdf", "_com1.x.pdf"), ("x/AUX.pdf", "_AUX.pdf"),
            ("Lpt9.PDF", "_Lpt9.pdf"), ("console.pdf", "console.pdf"), ("com10.pdf", "com10.pdf"), ("laudo.pdf", "laudo.pdf"),
        ):
            self.assertEqual(fin.validar_pdf(nome, PDF), esperado, nome)

    def test_pdf_recusa_extensao_magic_vazio_grande_e_nome_com_pasta(self):
        self.assertEqual(fin.validar_pdf("laudo.PDF", PDF), "laudo.pdf")
        self.assertEqual(fin.validar_pdf("..\\..\\x/y/rel até.pdf", PDF), "rel at_.pdf")
        for nome, dados, codigo in (
            ("a.txt", PDF, 422), ("a.pdf", b"", 422), ("a.pdf", b"MZ\x90", 422), ("...pdf", PDF, 422), ("a.pdf", PDF * 10, 413),
        ):
            with self.assertRaises(DomainValidationError) as ctx:
                fin.validar_pdf(nome, dados, limite=50)
            self.assertEqual(ctx.exception.status_code, codigo, nome)


class EstadoTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def test_descricao_e_pdf_ficam_no_estado_e_o_pdf_novo_substitui_o_antigo(self):
        fin.definir_descricao(self.dir, UTIC, "feito")
        fin.anexar_pdf(self.dir, UTIC, "a.pdf", PDF)
        fin.anexar_pdf(self.dir, UTIC, "b.pdf", PDF + b"x")
        descricao, caminho = fin.dados_para_finalizar(self.dir, UTIC)
        self.assertEqual(descricao, "feito")
        self.assertEqual(caminho.name, "b.pdf")
        self.assertEqual([p.name for p in fin.pasta_anexos(self.dir, UTIC).glob("*.pdf")], ["b.pdf"])
        self.assertEqual(fin.publico(fin.ler_estado(self.dir)[UTIC])["pdf"], {"nome": "b.pdf", "tamanho": len(PDF) + 1})
        fin.remover_pdf(self.dir, UTIC)
        self.assertIsNone(fin.dados_para_finalizar(self.dir, UTIC)[1])
        self.assertIsNone(fin.publico(fin.ler_estado(self.dir)[UTIC])["pdf"])

    def test_descricao_vazia_limpa_e_numero_invalido_nao_grava(self):
        fin.definir_descricao(self.dir, UTIC, "feito")
        fin.definir_descricao(self.dir, UTIC, "")
        self.assertEqual(fin.dados_para_finalizar(self.dir, UTIC)[0], "")
        with self.assertRaises(DomainValidationError):
            fin.definir_descricao(self.dir, "linha:2", "x")
        with self.assertRaises(DomainValidationError):
            fin.anexar_pdf(self.dir, "../x", "a.pdf", PDF)
        self.assertEqual(list(fin.ler_estado(self.dir)), [UTIC])

    def test_pdf_do_estado_fora_da_pasta_do_chamado_nao_e_usado(self):
        fin.definir_descricao(self.dir, UTIC, "feito")
        fora = self.dir / "segredo.pdf"
        fora.write_bytes(PDF)
        fin._alterar(self.dir, UTIC, lambda item: item.update(pdf={"nome": "../../segredo.pdf", "tamanho": 1}))
        self.assertIsNone(fin.dados_para_finalizar(self.dir, UTIC)[1])

    def test_finalizacao_so_ok_gera_encerramento_e_so_ok_bloqueia_nova_tentativa(self):
        fin.registrar_finalizacao(self.dir, UTIC, fin.STATUS_OK, "30/10/2026 14:05")
        fin.registrar_finalizacao(self.dir, "UTIC-2026-0002", fin.STATUS_NAO_ENCONTRADO)
        fin.registrar_finalizacao(self.dir, "UTIC-2026-0003", fin.STATUS_ERRO)
        self.assertEqual(fin.encerramentos_registrados(self.dir), {UTIC: "30/10/2026 14:05"})
        self.assertTrue(fin.ja_finalizado(self.dir, UTIC))
        self.assertFalse(fin.ja_finalizado(self.dir, "UTIC-2026-0002"))
        self.assertFalse(fin.ja_finalizado(self.dir, "UTIC-2026-0003"))

    def test_texto_do_encerramento_usa_horario_de_brasilia(self):
        self.assertEqual(fin.texto_do_encerramento(datetime(2026, 10, 30, 17, 5, tzinfo=timezone.utc)), "30/10/2026 14:05")


class JobTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def test_job_e_consumido_uma_vez(self):
        fin.gravar_job(self.dir, [UTIC], confirmar_final=False, pulados=[{"numero": "linha:2", "motivo": "sem_numero"}])
        self.assertTrue(fin.job_pendente(self.dir))
        job = fin.consumir_job(self.dir)
        self.assertEqual(job, {
            "acao": fin.ACAO_FINALIZAR, "numeros": [UTIC], "confirmar_final": False,
            "pulados": [{"numero": "linha:2", "motivo": "sem_numero"}],
        })
        self.assertIsNone(fin.consumir_job(self.dir))
        self.assertFalse(fin.job_pendente(self.dir))

    def test_job_velho_ou_adulterado_e_descartado(self):
        fin.gravar_job(self.dir, [UTIC])
        depois = fin.agora_local() + fin.JOB_VALIDADE + timedelta(minutes=1)
        self.assertFalse(fin.job_pendente(self.dir, depois))
        self.assertIsNone(fin.consumir_job(self.dir, depois))
        self.assertFalse(fin.caminho_job(self.dir).exists())  # even a refused job is removed
        fin.caminho_job(self.dir).write_text("{nao e json", encoding="utf-8")
        self.assertIsNone(fin.consumir_job(self.dir))
        fin.gravar_job(self.dir, [UTIC], acao="apagar_tudo")
        self.assertIsNone(fin.consumir_job(self.dir))

    def test_resultado_vai_e_volta(self):
        self.assertIsNone(fin.ler_resultado(self.dir))
        fin.gravar_resultado(self.dir, {"em_andamento": False})
        self.assertEqual(fin.ler_resultado(self.dir), {"em_andamento": False})


class PendenteTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.origem = self.dir / "saida.xlsx"
        self.origem.write_bytes(montar())

    def test_copia_pendente_tem_nome_proprio_registro_json_e_aviso(self):
        momento = datetime(2026, 10, 30, 17, 5, tzinfo=timezone.utc)
        pendente = fin.guardar_pendente(self.dir, self.origem, momento, motivo="sem login", tickets=[UTIC])
        self.assertEqual(pendente.name, "Dashboard Operacional_SEBRAE (pendente 2026-10-30 1405).xlsx")
        self.assertNotEqual(pendente.name, fin.NOME_DASHBOARD)
        self.assertEqual(pendente.read_bytes(), self.origem.read_bytes())
        aviso = fin.aviso_do_pendente(self.dir)
        self.assertEqual(
            {k: aviso[k] for k in ("falhou", "motivo", "copia_local", "copia_sharepoint")},
            {"falhou": True, "motivo": "sem login", "copia_local": str(pendente), "copia_sharepoint": False},
        )
        self.assertEqual(len(aviso["sugestoes"]), 3)
        fin.marcar_copia_sharepoint(pendente)
        self.assertTrue(fin.aviso_do_pendente(self.dir)["copia_sharepoint"])

    def test_mais_recente_e_descartar_remove_xlsx_e_json(self):
        antigo = fin.guardar_pendente(self.dir, self.origem, datetime(2026, 10, 29, 9, 0, tzinfo=timezone.utc), motivo="a", tickets=[])
        novo = fin.guardar_pendente(self.dir, self.origem, datetime(2026, 10, 30, 9, 0, tzinfo=timezone.utc), motivo="b", tickets=[])
        self.assertEqual(fin.pendente_mais_recente(self.dir)[0], novo)
        fin.descartar_pendente(novo)
        self.assertEqual(fin.pendente_mais_recente(self.dir)[0], antigo)
        self.assertFalse(novo.with_suffix(".json").exists())
        fin.descartar_pendente(antigo)
        self.assertIsNone(fin.aviso_do_pendente(self.dir))

    def test_descartar_pendentes_remove_todas_as_copias_e_nao_falha_sem_nenhuma(self):
        fin.descartar_pendentes(self.dir)
        for dia in (28, 29, 30):
            fin.guardar_pendente(self.dir, self.origem, datetime(2026, 10, dia, 9, 0, tzinfo=timezone.utc), motivo="x", tickets=[])
        fin.descartar_pendentes(self.dir)
        self.assertIsNone(fin.pendente_mais_recente(self.dir))
        self.assertEqual([p for p in fin.pasta_pendente(self.dir).glob("*") if p.suffix in (".xlsx", ".json")], [])

    def test_aviso_sem_falha_nao_traz_sugestoes_e_hash_enviado_volta(self):
        self.assertEqual(fin.aviso_sharepoint(False)["sugestoes"], [])
        self.assertEqual(fin.ler_enviado(self.dir), "")
        fin.gravar_enviado(self.dir, "abc")
        self.assertEqual(fin.ler_enviado(self.dir), "abc")


class RegistrarEncerramentosTest(unittest.TestCase):
    QUANDO = "30/10/2026 14:05"

    def test_grava_so_as_colunas_d_e_r_da_linha_achada_pela_coluna_c_inclusive_finalizada(self):
        base = montar()
        resultado, estados = G.registrar_encerramentos(base, {"UTIC-2026-0002": self.QUANDO})
        self.assertEqual(estados, {"UTIC-2026-0002": G.ENCERRAMENTO_GRAVADO})
        self.assertRegex(linha_xml(resultado.conteudo, 3), R_1405)
        self.assertNotRegex(linha_xml(resultado.conteudo, 2), R_1405)
        self.assertEqual([(g.numero, g.celulas) for g in resultado.linhas], [("UTIC-2026-0002", ("D", "R"))])
        aberto = montar(status=("EM ABERTO", "EM ABERTO"))
        gravado, _ = G.registrar_encerramentos(aberto, {"UTIC-2026-0002": self.QUANDO})
        self.assertNotIn("FINALIZADO", linha_xml(aberto, 3))
        self.assertIn("FINALIZADO", linha_xml(gravado.conteudo, 3))  # D junto com R
        self.assertNotIn("FINALIZADO", linha_xml(gravado.conteudo, 2))
        self.assertEqual(ler_coluna_c(resultado.conteudo), ler_coluna_c(base))

    def test_nao_sobrescreve_r_preenchida_e_devolve_o_mesmo_arquivo(self):
        primeiro, _ = G.registrar_encerramentos(montar(), {UTIC: self.QUANDO})
        segundo, estados = G.registrar_encerramentos(primeiro.conteudo, {UTIC: "31/10/2026 08:00"})
        self.assertEqual(estados, {UTIC: G.ENCERRAMENTO_JA_PREENCHIDO})
        self.assertEqual(segundo.conteudo, primeiro.conteudo)
        self.assertRegex(linha_xml(segundo.conteudo, 2), R_1405)

    def test_numero_ausente_e_linha_ambigua_nao_gravam(self):
        resultado, estados = G.registrar_encerramentos(montar(), {"UTIC-2026-9999": self.QUANDO})
        self.assertEqual(estados, {"UTIC-2026-9999": G.ENCERRAMENTO_NAO_ENCONTRADO})
        self.assertEqual(resultado.linhas, ())
        duplicada = montar((UTIC, UTIC), status=("EM ABERTO", "EM ABERTO"))
        resultado, estados = G.registrar_encerramentos(duplicada, {UTIC: self.QUANDO})
        self.assertEqual(estados, {UTIC: G.ENCERRAMENTO_AMBIGUO})
        self.assertEqual(resultado.conteudo, duplicada)
        self.assertNotIn("FINALIZADO", linha_xml(resultado.conteudo, 2))  # nem D nem R


if __name__ == "__main__":
    unittest.main()
