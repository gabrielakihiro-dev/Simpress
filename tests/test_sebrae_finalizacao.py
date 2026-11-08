import json
import os
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from core.errors import DomainBusyError, DomainConflictError, DomainValidationError
from domains import sebrae_dashboard_gravacao as G
from domains import sebrae_finalizacao as fin
from domains import sebrae_novos
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


class DescricaoEditadaTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def test_guarda_lista_e_apaga_com_texto_vazio_sem_tocar_nos_outros_campos(self):
        fin.definir_descricao(self.dir, UTIC, "para finalizar")
        item = fin.definir_descricao_editada(self.dir, UTIC, "editada")
        self.assertEqual((item["descricao_editada"], fin.publico(item)["descricao_editada"]), ("editada", "editada"))
        self.assertEqual(fin.descricoes_editadas(self.dir), {UTIC: "editada"})
        item = fin.definir_descricao_editada(self.dir, UTIC, "")
        self.assertEqual(fin.descricoes_editadas(self.dir), {})
        self.assertEqual((fin.publico(item)["descricao_editada"], item["descricao_finalizacao"]), ("", "para finalizar"))

    def test_recusa_numero_ruim_e_texto_grande(self):
        with self.assertRaises(DomainValidationError):
            fin.definir_descricao_editada(self.dir, "linha:2", "x")
        with self.assertRaises(DomainValidationError):
            fin.definir_descricao_editada(self.dir, UTIC, "x" * 4001)


class EstadoTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def test_remocao_pdf_pendente_sobrevive_reload_e_retry_nao_apaga_upload_novo(self):
        fin.anexar_pdf(self.dir, UTIC, "laudo.pdf", PDF)
        antigo = fin.dados_para_finalizar(self.dir, UTIC)[1]
        with patch.object(fin.shutil, "rmtree", side_effect=PermissionError("ocupado")):
            with self.assertRaises(DomainBusyError):
                fin.remover_pdf(self.dir, UTIC)
        self.assertTrue(fin.publico(fin.ler_estado(self.dir)[UTIC])["pdf_remocao_pendente"])
        fin.anexar_pdf(self.dir, UTIC, "laudo.pdf", PDF + b"novo")
        novo = fin.dados_para_finalizar(self.dir, UTIC)[1]
        self.assertNotEqual(novo, antigo)
        fin.remover_pdf(self.dir, UTIC, somente_pendentes=True)
        self.assertFalse(antigo.exists())
        self.assertEqual(novo.read_bytes(), PDF + b"novo")
        self.assertFalse(fin.publico(fin.ler_estado(self.dir)[UTIC]).get("pdf_remocao_pendente", False))
        fin.remover_pdf(self.dir, UTIC, somente_pendentes=True)
        self.assertEqual(novo.read_bytes(), PDF + b"novo")

    def test_remover_pdf_preserva_arquivo_se_gravacao_do_estado_falha(self):
        fin.anexar_pdf(self.dir, UTIC, "laudo.pdf", PDF)
        anterior = fin.dados_para_finalizar(self.dir, UTIC)[1]
        estado = (self.dir / "sebrae_finalizacao.json").read_bytes()
        with patch.object(fin, "atomic_write_json", side_effect=PermissionError("bloqueado")):
            with self.assertRaises((OSError, DomainBusyError)):
                fin.remover_pdf(self.dir, UTIC)
        self.assertEqual(anterior.read_bytes(), PDF)
        self.assertEqual((self.dir / "sebrae_finalizacao.json").read_bytes(), estado)

    def test_remover_pdf_reflete_falha_de_diretorio_sem_referencia_pendurada(self):
        for parcial in (False, True):
            with self.subTest(parcial=parcial):
                fin.anexar_pdf(self.dir, UTIC, "laudo.pdf", PDF)
                anterior = fin.dados_para_finalizar(self.dir, UTIC)[1]
                def falhar(*args, **kwargs):
                    if parcial:
                        anterior.unlink()
                    raise PermissionError("bloqueado")
                with patch.object(fin.shutil, "rmtree", side_effect=falhar):
                    with self.assertRaises(DomainBusyError):
                        fin.remover_pdf(self.dir, UTIC)
                self.assertNotIn("pdf", fin.ler_estado(self.dir)[UTIC])
                self.assertIsNone(fin.dados_para_finalizar(self.dir, UTIC)[1])

    def test_estado_invalido_e_preservado_e_bloqueia_mutacoes(self):
        caminho = self.dir / "sebrae_finalizacao.json"
        for conteudo in (b"{invalido", b"\xff", b"[]", b'{"UTIC-2026-0001": {"finalizacao": {"status": "ok"}}, "ruim": 1}'):
            with self.subTest(conteudo=conteudo):
                caminho.write_bytes(conteudo)
                with self.assertRaises(DomainBusyError):
                    fin.definir_descricao(self.dir, UTIC, "novo")
                self.assertEqual(caminho.read_bytes(), conteudo)

    def test_estado_corrompido_nao_apaga_o_pdf_existente(self):
        fin.anexar_pdf(self.dir, UTIC, "anterior.pdf", PDF)
        anterior = fin.dados_para_finalizar(self.dir, UTIC)[1]
        caminho = self.dir / "sebrae_finalizacao.json"
        caminho.write_text("{invalido", encoding="utf-8")
        for mudar in (
            lambda: fin.anexar_pdf(self.dir, UTIC, "novo.pdf", PDF + b"novo"),
            lambda: fin.remover_pdf(self.dir, UTIC),
        ):
            with self.assertRaises(DomainBusyError):
                mudar()
            self.assertEqual(anterior.read_bytes(), PDF)
            self.assertEqual(caminho.read_text(encoding="utf-8"), "{invalido")

    def test_ficha_mascara_textos_e_chaves_sensiveis_recursivamente(self):
        ficha = {"titulo": "senha é Segredo123", "detalhes": [{"password": "Outra123", "texto": "CPF 529.982.247-25"}], "valores": {"A": "=1+1", "B": "+1", "D": "@x", "S": "-x"}}
        fin.definir_ficha(self.dir, UTIC, ficha)
        salva = fin.ler_estado(self.dir)[UTIC]["ficha"]
        serializada = json.dumps(salva, ensure_ascii=False)
        for sensivel in ("Segredo123", "Outra123", "529.982.247-25"):
            self.assertNotIn(sensivel, serializada)
        self.assertEqual(salva["detalhes"][0][fin.OMITIDO + " 1"], fin.OMITIDO)
        self.assertIn("***.***.***-**", salva["detalhes"][0]["texto"])
        self.assertTrue(all(valor.startswith("'") for valor in salva["valores"].values()))

    def test_ficha_mascara_chaves_de_senha_com_qualificadores(self):
        for chave in ("senha", "senha temporaria", "password_hint", "usuario_senha"):
            with self.subTest(chave=chave):
                fin.definir_ficha(self.dir, UTIC, {"detalhes": [{chave: "Segredo123"}]})
                salva = fin.ler_estado(self.dir)[UTIC]["ficha"]["detalhes"][0]
                self.assertEqual(set(salva.values()), {"[DADO SENSÍVEL OMITIDO]"})

    def test_ficha_mascara_campos_camelcase_numericos_e_segredo_na_chave(self):
        for chave in ("senhaUsuario", "senha123", "usuarioSenha", "senhaSegredo123", "Segredo123Senha", "passwordUsuario", "pwd123"):
            with self.subTest(chave=chave):
                fin.definir_ficha(self.dir, UTIC, {"detalhes": [{chave: "Credencial789"}]})
                salva = fin.ler_estado(self.dir)[UTIC]["ficha"]
                self.assertEqual(salva["detalhes"][0], {fin.OMITIDO + " 1": fin.OMITIDO})

    def test_ficha_oculta_segredo_separado_por_underscore_na_chave(self):
        for chave in ("senha_Segredo123", "Segredo123_senha"):
            with self.subTest(chave=chave):
                fin.definir_ficha(self.dir, UTIC, {"detalhes": [{chave: "Credencial789"}]})
                self.assertEqual(fin.ler_estado(self.dir)[UTIC]["ficha"], {"detalhes": [{fin.OMITIDO + " 1": fin.OMITIDO}]})

    def test_ficha_mantem_varias_chaves_de_credencial_sem_segredos_ou_colisao(self):
        chaves = ("Segredo123-senha", "Segredo123.senha", "senha.Segredo123", "senha_Segredo123", "Segredo123_senha", "senha", "password", "senha: segredo", "senha: outro")
        fin.definir_ficha(self.dir, UTIC, {"detalhes": [{chave: "Credencial789" for chave in chaves}]})
        salva = fin.ler_estado(self.dir)[UTIC]["ficha"]["detalhes"][0]
        self.assertEqual(salva, {fin.OMITIDO + f" {i}": fin.OMITIDO for i in range(1, len(chaves) + 1)})

    def test_ficha_oculta_prefixo_e_sufixo_com_ponto_ou_hifen(self):
        for chave in ("Segredo123-senha", "Segredo123.senha", "senha.Segredo123"):
            with self.subTest(chave=chave):
                fin.definir_ficha(self.dir, UTIC, {"detalhes": [{chave: "Credencial789"}]})
                self.assertEqual(fin.ler_estado(self.dir)[UTIC]["ficha"], {"detalhes": [{fin.OMITIDO + " 1": fin.OMITIDO}]})

    def test_ficha_limita_bytes_utf8_e_nao_apenas_quantidade_de_caracteres(self):
        with self.assertRaises(DomainValidationError) as ctx:
            fin.definir_ficha(self.dir, UTIC, {"titulo": "😀" * 60000})
        self.assertEqual(ctx.exception.status_code, 413)
        self.assertFalse((self.dir / "sebrae_finalizacao.json").exists())

    def test_ficha_sanitiza_chaves_arbitrarias_aninhadas(self):
        ficha = {"CPF 529.982.247-25": [{"detalhes": {"senha é segredo": "nao guardar", "observacao senha e Segredo123": "ocultar", "=1+1": "texto"}}]}
        fin.definir_ficha(self.dir, UTIC, ficha)
        salva = fin.ler_estado(self.dir)[UTIC]["ficha"]
        serializada = json.dumps(salva, ensure_ascii=False)
        for sensivel in ("529.982.247-25", "segredo", "Segredo123", "nao guardar", "ocultar"):
            self.assertNotIn(sensivel, serializada)
        detalhes = salva["CPF ***.***.***-**"][0]["detalhes"]
        self.assertEqual(detalhes[fin.OMITIDO + " 1"], fin.OMITIDO)
        self.assertEqual(detalhes["'=1+1"], "texto")

    def test_ficha_recusa_colisao_de_chaves_sem_persistir(self):
        fin.definir_ficha(self.dir, UTIC, {"titulo": "anterior"})
        caminho = self.dir / "sebrae_finalizacao.json"
        anterior = caminho.read_bytes()
        for chaves in (
            {"CPF 529.982.247-25": "a", "CPF 123.456.789-09": "b"},
            {"=1+1": "a", "'=1+1": "b"},
        ):
            with self.subTest(chaves=chaves):
                with self.assertRaises(DomainValidationError) as ctx:
                    fin.definir_ficha(self.dir, UTIC, {"detalhes": [{"campos": chaves}]})
                self.assertEqual(ctx.exception.status_code, 422)
                self.assertEqual(caminho.read_bytes(), anterior)

    def test_ficha_oculta_valores_de_pares_rotulados_recursivamente(self):
        ficha = {"detalhes": [["senha", "Segredo123"], ["password", {"valor": "OutroSegredo"}], ["Senha.Segredo123", "Credencial789"], ["Descrição", {"aninhado": [["pwd", "NaoPersistir"]]}]]}
        fin.definir_ficha(self.dir, UTIC, ficha)
        salva = fin.ler_estado(self.dir)[UTIC]["ficha"]
        self.assertEqual(salva, {"detalhes": [["senha", fin.OMITIDO], ["password", fin.OMITIDO], [fin.OMITIDO, fin.OMITIDO], ["Descrição", {"aninhado": [["pwd", fin.OMITIDO]]}]]})

    def test_ficha_reserva_chaves_comuns_antes_de_numerar_credenciais(self):
        for campos in (
            {"senha": "x", fin.OMITIDO + " 1": "texto", "password": "y", fin.OMITIDO + " 3": "outro"},
            {fin.OMITIDO + " 3": "outro", "password": "y", fin.OMITIDO + " 1": "texto", "senha": "x"},
        ):
            with self.subTest(campos=campos):
                fin.definir_ficha(self.dir, UTIC, {"detalhes": [campos]})
                salva = fin.ler_estado(self.dir)[UTIC]["ficha"]["detalhes"][0]
                self.assertEqual(salva, {fin.OMITIDO + " 1": "texto", fin.OMITIDO + " 2": fin.OMITIDO, fin.OMITIDO + " 3": "outro", fin.OMITIDO + " 4": fin.OMITIDO})

    def test_falha_ao_gravar_pdf_ou_json_preserva_anexo_e_estado_anteriores(self):
        for gravacao in ("atomic_write_bytes", "atomic_write_json"):
            for nome in ("anterior.pdf", "novo.pdf"):
                with self.subTest(gravacao=gravacao, nome=nome):
                    raiz = self.dir / gravacao / nome
                    fin.anexar_pdf(raiz, UTIC, "anterior.pdf", PDF)
                    anterior = fin.dados_para_finalizar(raiz, UTIC)[1]
                    estado = (raiz / "sebrae_finalizacao.json").read_bytes()
                    with patch.object(fin, gravacao, side_effect=OSError("falha de gravação simulada")):
                        with self.assertRaises(OSError):
                            fin.anexar_pdf(raiz, UTIC, nome, PDF + b"novo")
                    self.assertEqual(anterior.read_bytes(), PDF)
                    self.assertEqual((raiz / "sebrae_finalizacao.json").read_bytes(), estado)
                    self.assertEqual(fin.dados_para_finalizar(raiz, UTIC)[1], anterior)

    def test_pdf_com_mesmo_nome_so_substitui_a_versao_antiga_apos_commit_do_json(self):
        fin.anexar_pdf(self.dir, UTIC, "laudo.pdf", PDF)
        anterior = fin.dados_para_finalizar(self.dir, UTIC)[1]
        gravar_json = fin.atomic_write_json

        def conferir_e_gravar(caminho, dados):
            self.assertEqual(anterior.read_bytes(), PDF)
            return gravar_json(caminho, dados)

        with patch.object(fin, "atomic_write_json", side_effect=conferir_e_gravar):
            fin.anexar_pdf(self.dir, UTIC, "laudo.pdf", PDF + b"novo")
        novo = fin.dados_para_finalizar(self.dir, UTIC)[1]
        self.assertEqual(novo.name, "laudo.pdf")
        self.assertEqual(novo.read_bytes(), PDF + b"novo")
        self.assertFalse(anterior.exists())

    def test_erro_reportado_apos_substituir_json_restaura_a_referencia_anterior(self):
        fin.anexar_pdf(self.dir, UTIC, "laudo.pdf", PDF)
        anterior = fin.dados_para_finalizar(self.dir, UTIC)[1]
        arquivo = self.dir / "sebrae_finalizacao.json"
        estado = arquivo.read_bytes()
        gravar_json = fin.atomic_write_json

        def gravar_e_falhar(caminho, dados):
            gravar_json(caminho, dados)
            raise OSError("falha após substituição do JSON")

        with patch.object(fin, "atomic_write_json", side_effect=gravar_e_falhar):
            with self.assertRaises(OSError):
                fin.anexar_pdf(self.dir, UTIC, "laudo.pdf", PDF + b"novo")
        self.assertEqual(arquivo.read_bytes(), estado)
        self.assertEqual(fin.dados_para_finalizar(self.dir, UTIC)[1], anterior)
        self.assertEqual(anterior.read_bytes(), PDF)

    def test_falha_na_limpeza_do_pdf_antigo_nao_desfaz_commit_nem_retorna_erro(self):
        for erro in (FileNotFoundError("versão antiga já removida"), PermissionError("arquivo ocupado")):
            with self.subTest(erro=type(erro).__name__):
                raiz = self.dir / type(erro).__name__
                fin.anexar_pdf(raiz, UTIC, "anterior.pdf", PDF)
                with patch.object(fin.shutil, "rmtree", side_effect=erro), self.assertLogs("domains.sebrae_finalizacao", "WARNING") as logs:
                    item = fin.anexar_pdf(raiz, UTIC, "novo.pdf", PDF + b"novo")
                novo = fin.dados_para_finalizar(raiz, UTIC)[1]
                self.assertEqual(novo.read_bytes(), PDF + b"novo")
                self.assertEqual(fin.publico(item)["pdf"]["nome"], "novo.pdf")
                self.assertEqual(fin.ler_estado(raiz)[UTIC]["pdf"]["nome"], "novo.pdf")
                self.assertIn(type(erro).__name__, logs.output[0])

    def test_descricao_e_pdf_ficam_no_estado_e_o_pdf_novo_substitui_o_antigo(self):
        fin.definir_descricao(self.dir, UTIC, "feito")
        fin.anexar_pdf(self.dir, UTIC, "a.pdf", PDF)
        fin.anexar_pdf(self.dir, UTIC, "b.pdf", PDF + b"x")
        descricao, caminho = fin.dados_para_finalizar(self.dir, UTIC)
        self.assertEqual(descricao, "feito")
        self.assertEqual(caminho.name, "b.pdf")
        self.assertEqual([p.name for p in fin.pasta_anexos(self.dir, UTIC).rglob("*.pdf")], ["b.pdf"])
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

    def test_metadado_com_subpasta_nao_autoriza_apagar_a_pasta_do_chamado(self):
        pasta = fin.pasta_anexos(self.dir, UTIC)
        (pasta / "sub").mkdir(parents=True)
        anterior = pasta / "anterior.pdf"
        anterior.write_bytes(PDF)
        fin._alterar(self.dir, UTIC, lambda item: item.update(pdf={"nome": "sub/../anterior.pdf", "tamanho": len(PDF)}))
        fin.anexar_pdf(self.dir, UTIC, "novo.pdf", PDF + b"novo")
        self.assertEqual(fin.dados_para_finalizar(self.dir, UTIC)[1].read_bytes(), PDF + b"novo")
        self.assertEqual(anterior.read_bytes(), PDF)

    def test_finalizacao_so_ok_gera_encerramento_e_so_ok_bloqueia_nova_tentativa(self):
        fin.registrar_finalizacao(self.dir, UTIC, fin.STATUS_OK, "30/10/2026 14:05")
        fin.registrar_finalizacao(self.dir, "UTIC-2026-0002", fin.STATUS_NAO_ENCONTRADO)
        fin.registrar_finalizacao(self.dir, "UTIC-2026-0003", fin.STATUS_ERRO)
        self.assertEqual(fin.encerramentos_registrados(self.dir), {UTIC: "30/10/2026 14:05"})
        self.assertTrue(fin.ja_finalizado(self.dir, UTIC))
        self.assertFalse(fin.ja_finalizado(self.dir, "UTIC-2026-0002"))
        self.assertFalse(fin.ja_finalizado(self.dir, "UTIC-2026-0003"))

    def test_finalizados_no_dashboard_listam_so_o_ok_do_softexpert_com_a_ficha(self):
        a, b, c = UTIC, "UTIC-2026-0002", "UTIC-2026-0003"
        for numero in (a, b, c):
            fin.definir_descricao(self.dir, numero, f"feito {numero[-1]}")
        fin.definir_ficha(self.dir, a, {"titulo": "Chamado A", "valores": {"A": "x"}})
        fin.registrar_finalizacao(self.dir, a, fin.STATUS_OK, "30/10/2026 14:05")
        fin.registrar_finalizacao(self.dir, b, fin.STATUS_OK, "30/10/2026 15:00")
        fin.registrar_finalizacao(self.dir, c, fin.STATUS_ERRO)
        achados = fin.finalizados_no_dashboard(self.dir)
        self.assertEqual(sorted(x["numero"] for x in achados), [a, b])
        por_numero = {x["numero"]: x for x in achados}
        self.assertEqual((por_numero[a]["encerrado_em"], por_numero[a]["descricao"]), ("30/10/2026 14:05", f"feito {a[-1]}"))
        self.assertEqual(por_numero[a]["ficha"], {"titulo": "Chamado A", "valores": {"A": "x"}})
        self.assertIsNone(por_numero[b]["ficha"])

    def test_finalizados_no_dashboard_devolvem_so_os_100_mais_recentes(self):
        for n in range(105):
            em = f"2026-10-30T10:{n // 60:02d}:{n % 60:02d}"
            fin._alterar(self.dir, f"UTIC-2026-{n:04d}", lambda item, em=em: item.update(finalizacao={"status": fin.STATUS_OK, "em": em, "encerrado_em": ""}))
        achados = fin.finalizados_no_dashboard(self.dir)
        self.assertEqual(len(achados), fin.MAX_FINALIZADOS_NO_DASHBOARD)
        self.assertEqual(achados[0]["numero"], "UTIC-2026-0104")
        self.assertEqual(achados[-1]["numero"], "UTIC-2026-0005")  # 0000 a 0004 (os mais velhos) ficam de fora
        self.assertEqual(len(fin.ler_estado(self.dir)), 105)  # o estado em disco guarda todos

    def test_ficha_precisa_ser_objeto_pequeno(self):
        with self.assertRaises(DomainValidationError):
            fin.definir_ficha(self.dir, UTIC, "texto")
        with self.assertRaises(DomainValidationError):
            fin.definir_ficha(self.dir, UTIC, {"x": "a" * fin.MAX_FICHA})

    def test_texto_do_encerramento_usa_horario_de_brasilia(self):
        self.assertEqual(fin.texto_do_encerramento(datetime(2026, 10, 30, 17, 5, tzinfo=timezone.utc)), "30/10/2026 14:05")


class JobTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def test_job_sem_fuso_usa_brasilia_e_data_futura_e_invalida(self):
        agora = datetime(2026, 10, 30, 14, 5, tzinfo=fin.FUSO)
        for criado, esperado in (("2026-10-30T14:00:00", True), ("2026-10-30T14:06:00", False), ("invalido", False)):
            with self.subTest(criado=criado):
                self.assertEqual(fin._job_valido({"criado_em": criado}, agora), esperado)

    def test_job_com_fusos_incompativeis_e_recusado_sem_excecao(self):
        self.assertFalse(fin._job_valido({"criado_em": "2026-10-30T14:00:00-03:00"}, datetime(2026, 10, 30, 14, 5)))

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
        self.assertRegex(pendente.name, r"^Dashboard Operacional_SEBRAE \(pendente 2026-10-30 140500-n\d+\)\.xlsx$")
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

    def test_duas_copias_no_mesmo_instante_nao_sobrescrevem_o_registro_anterior(self):
        momento = datetime(2026, 10, 30, 17, 5, tzinfo=timezone.utc)
        primeira = fin.guardar_pendente(self.dir, self.origem, momento, motivo="primeira", tickets=[UTIC])
        self.origem.write_bytes(b"outra copia")
        segunda = fin.guardar_pendente(self.dir, self.origem, momento, motivo="segunda", tickets=[])
        self.assertNotEqual(primeira, segunda)
        self.assertNotEqual(primeira.read_bytes(), segunda.read_bytes())
        self.assertEqual(json.loads(primeira.with_suffix(".json").read_text(encoding="utf-8"))["motivo"], "primeira")
        self.assertEqual(fin.pendente_mais_recente(self.dir)[0], segunda)

    def test_tocar_copia_antiga_nao_promove_e_limpeza_so_remove_bytes_enviados(self):
        momento = datetime(2026, 10, 30, 17, 5, tzinfo=timezone.utc)
        with patch.object(time, "time_ns", return_value=1793379900000000000):
            antiga = fin.guardar_pendente(self.dir, self.origem, momento, motivo="antiga", tickets=[])
            self.origem.write_bytes(b"snapshot mais nova")
            nova = fin.guardar_pendente(self.dir, self.origem, momento - timedelta(days=1), motivo="nova", tickets=[])
        os.utime(antiga, ns=(1999999999999999999, 1999999999999999999))
        escolhida = fin.pendente_mais_recente(self.dir)[0]
        self.assertEqual(escolhida, nova)
        self.assertEqual(escolhida.read_bytes(), b"snapshot mais nova")
        envio = fin.preparar_envio(self.dir, escolhida.read_bytes(), pendente=escolhida)
        fin.marcar_envio_incerto(self.dir, envio)
        fin.confirmar_envio(self.dir, envio)
        fin.descartar_pendentes(self.dir)
        self.assertTrue(antiga.exists())  # Different bytes are not proven covered by the uploaded snapshot.
        self.assertFalse(nova.exists())

    def test_nomes_legados_usam_timestamp_embutido_em_vez_de_mtime(self):
        pasta = fin.pasta_pendente(self.dir)
        pasta.mkdir()
        antiga = pasta / "Dashboard Operacional_SEBRAE (pendente 2026-10-29 1405).xlsx"
        nova = pasta / "Dashboard Operacional_SEBRAE (pendente 2026-10-30 1405).xlsx"
        antiga.write_bytes(b"antiga")
        nova.write_bytes(b"nova")
        os.utime(antiga, ns=(1999999999999999999, 1999999999999999999))
        self.assertEqual(fin.pendente_mais_recente(self.dir)[0], nova)

    def test_ordem_legada_ambigua_recusa_selecao_e_descarte_sem_apagar_copias(self):
        pasta = fin.pasta_pendente(self.dir)
        pasta.mkdir()
        copias = [
            pasta / "Dashboard Operacional_SEBRAE (pendente 2026-10-30 1405).xlsx",
            pasta / "Dashboard Operacional_SEBRAE (pendente 2026-10-30 140500-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa).xlsx",
        ]
        for copia in copias:
            copia.write_bytes(self.origem.read_bytes())
        with self.assertRaises(DomainConflictError):
            fin.pendente_mais_recente(self.dir)
        with self.assertLogs("domains.sebrae_finalizacao", "WARNING") as logs:
            fin.descartar_pendentes(self.dir)
        self.assertTrue(all(copia.is_file() for copia in copias))
        self.assertIn("ambígua", logs.output[0])
        from scripts import sebrae_fechar
        from tests.test_sebrae_fechar import Rotinas

        rotinas = Rotinas()
        fin.gravar_job(self.dir, [], acao=fin.ACAO_REENVIAR)
        with self.assertRaises(DomainConflictError):
            sebrae_fechar.executar(None, rotinas, state_dir=self.dir)
        self.assertEqual(rotinas.enviadas, [])
        self.assertTrue(all(copia.is_file() for copia in copias))
        self.assertFalse(fin.ler_resultado(self.dir)["em_andamento"])
        aviso = fin.aviso_do_pendente(self.dir)
        self.assertTrue(aviso["falhou"])
        self.assertIn("ambígua", aviso["motivo"])

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
        envio = fin.preparar_envio(self.dir, self.origem.read_bytes())
        fin.marcar_envio_incerto(self.dir, envio)
        fin.confirmar_envio(self.dir, envio)
        fin.descartar_pendentes(self.dir)
        self.assertIsNone(fin.pendente_mais_recente(self.dir))
        self.assertEqual([p for p in fin.pasta_pendente(self.dir).glob("*") if p.suffix in (".xlsx", ".json")], [])

    def test_aviso_sem_falha_nao_traz_sugestoes_e_hash_enviado_volta(self):
        self.assertEqual(fin.aviso_sharepoint(False)["sugestoes"], [])
        self.assertEqual(fin.ler_enviado(self.dir), "")
        fin.gravar_enviado(self.dir, "abc")
        self.assertEqual(fin.ler_enviado(self.dir), "abc")
        self.assertIsNone(fin.ler_copia_enviada(self.dir))  # sem cópia
        import hashlib

        corpo = b"xlsx enviado"
        fin.gravar_enviado(self.dir, hashlib.sha256(corpo).hexdigest(), corpo)
        self.assertEqual(fin.ler_copia_enviada(self.dir), corpo)
        fin.caminho_copia_enviada(self.dir).write_bytes(b"adulterada")
        self.assertIsNone(fin.ler_copia_enviada(self.dir))  # cópia que não bate com o hash é ignorada


class EnvioDuravelTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.origem = self.dir / "saida.xlsx"
        self.origem.write_bytes(b"snapshot")
        self.importar("a" * 64)

    def importar(self, sha256):
        sebrae_novos.salvar_existentes(sebrae_novos.caminhos_padrao(self.dir).existentes, [], "Dashboard.xlsx", sha256=sha256)

    def preparar(self):
        return fin.preparar_envio(self.dir, self.origem.read_bytes())

    def test_aviso_separa_declaracao_anterior_do_reenvio_confirmado_no_reload(self):
        envio = self.preparar()
        sha = fin.ler_envio(self.dir)["sha256"]
        fin.marcar_envio_incerto(self.dir, envio)
        fin.recuperar_envio(self.dir, envio, "declarar_nao_enviado", confirmacao=f"CONFIRMO NAO APLICADO {envio}")
        self.assertFalse(fin.aviso_do_pendente(self.dir)["reenvio_confirmado"])
        fin.retomar_envio_snapshot(self.dir, envio, sha)
        fin.marcar_envio_incerto(self.dir, envio)
        fin.confirmar_envio(self.dir, envio)
        for concluido in (False, True):
            if concluido:
                fin.descartar_pendentes(self.dir, envio_id=envio)
            aviso = fin.aviso_do_pendente(self.dir)
            self.assertTrue(aviso["reenvio_confirmado"])
            self.assertEqual(aviso["recuperacao"]["acao"], "declarar_nao_enviado")
            self.assertEqual(fin.ler_envio(self.dir)["id"], envio)

    def test_job_da_snapshot_preserva_id_hash_e_recusa_fase_ou_hash_antigo(self):
        envio = self.preparar()
        sha = fin.ler_envio(self.dir)["sha256"]
        fin.marcar_envio_incerto(self.dir, envio)
        with self.assertRaises(DomainConflictError):
            fin.gravar_job(self.dir, [], acao="reenviar_snapshot", envio_id=envio, sha256=sha)
        fin.recuperar_envio(self.dir, envio, "declarar_nao_enviado", confirmacao=f"CONFIRMO NAO APLICADO {envio}")
        with self.assertRaises(DomainConflictError):
            fin.gravar_job(self.dir, [], acao="reenviar_snapshot", envio_id=envio, sha256="0" * 64)
        fin.gravar_job(self.dir, [], acao="reenviar_snapshot", envio_id=envio, sha256=sha)
        job = fin.consumir_job(self.dir)
        self.assertEqual((job["acao"], job["envio_id"], job["sha256"]), ("reenviar_snapshot", envio, sha))

    def test_snapshot_so_e_reenviada_sobre_a_importacao_em_que_foi_montada(self):
        envio = self.preparar()
        sha = fin.ler_envio(self.dir)["sha256"]
        self.assertEqual(fin.ler_envio(self.dir)["base_sha256"], "a" * 64)
        fin.marcar_envio_incerto(self.dir, envio)
        fin.recuperar_envio(self.dir, envio, "declarar_nao_enviado", confirmacao=f"CONFIRMO NAO APLICADO {envio}")
        self.importar("b" * 64)  # o site importou de novo: a snapshot vem de uma base antiga
        with self.assertRaisesRegex(DomainConflictError, "antes da última importação"):
            fin.gravar_job(self.dir, [], acao="reenviar_snapshot", envio_id=envio, sha256=sha)
        with self.assertRaisesRegex(DomainConflictError, "antes da última importação"):
            fin.retomar_envio_snapshot(self.dir, envio, sha)
        self.assertTrue(fin.snapshot_envio(self.dir, envio).exists())  # nada foi apagado
        self.importar("a" * 64)
        fin.gravar_job(self.dir, [], acao="reenviar_snapshot", envio_id=envio, sha256=sha)

    def test_snapshot_sem_base_registrada_e_recusada(self):
        envio = self.preparar()
        sha = fin.ler_envio(self.dir)["sha256"]
        fin.marcar_envio_incerto(self.dir, envio)
        fin.recuperar_envio(self.dir, envio, "declarar_nao_enviado", confirmacao=f"CONFIRMO NAO APLICADO {envio}")
        registro = fin.ler_envio(self.dir)
        registro.pop("base_sha256")
        fin.atomic_write_json(fin.caminho_envio(self.dir), registro)
        with self.assertRaises(DomainConflictError):
            fin.gravar_job(self.dir, [], acao="reenviar_snapshot", envio_id=envio, sha256=sha)

    def test_legado_confirmado_vazio_exige_frase_e_e_idempotente_sem_apagar(self):
        fin.gravar_resultado(self.dir, {"sharepoint": {"falhou": False, "limpeza_pendente": True}})
        envio = fin.ler_envio(self.dir)["id"]
        with self.assertRaises(DomainConflictError):
            fin.recuperar_envio(self.dir, envio, "concluir_legado", confirmacao="sim")
        frase = f"CONFIRMO LEGADO CONFERIDO E ARQUIVOS PRESERVADOS {envio}"
        with patch.object(fin.shutil, "rmtree", side_effect=AssertionError("não excluir")), patch.object(fin, "descartar_pendente", side_effect=AssertionError("não excluir")):
            self.assertEqual(fin.recuperar_envio(self.dir, envio, "concluir_legado", confirmacao=frase)["status"], "concluido")
            self.assertEqual(fin.recuperar_envio(self.dir, envio, "concluir_legado", confirmacao=frase)["status"], "concluido")
        self.assertEqual(len(fin.ler_envio(self.dir)["resolucoes"]), 1)

    def test_falha_entre_arquivo_de_historico_e_diario_nao_libera_legado_no_restart(self):
        fin.gravar_resultado(self.dir, {"sharepoint": {"falhou": False, "limpeza_pendente": True}})
        envio = fin.ler_envio(self.dir)["id"]
        frase = f"CONFIRMO LEGADO CONFERIDO E ARQUIVOS PRESERVADOS {envio}"
        gravar = fin.atomic_write_json
        def falhar(path, dados):
            if path == fin.caminho_envio(self.dir) and dados.get("status") == "concluido":
                raise PermissionError("disco")
            gravar(path, dados)
        with patch.object(fin, "atomic_write_json", side_effect=falhar):
            with self.assertRaises(DomainBusyError):
                fin.recuperar_envio(self.dir, envio, "concluir_legado", confirmacao=frase)
        self.assertEqual(fin.ler_envio(self.dir)["status"], "confirmado")
        with self.assertRaises(DomainConflictError):
            fin.exigir_envio_livre(self.dir)
        self.assertEqual(fin.recuperar_envio(self.dir, envio, "concluir_legado", confirmacao=frase)["status"], "concluido")
        self.assertEqual(len(fin.ler_envio(self.dir)["resolucoes"]), 1)

    def test_legado_com_qualquer_arquivo_sidecar_pasta_ou_fase_incerta_nao_conclui(self):
        fin.gravar_resultado(self.dir, {"sharepoint": {"falhou": False, "limpeza_pendente": True}})
        registro = fin.ler_envio(self.dir)
        envio = registro["id"]
        frase = f"CONFIRMO LEGADO CONFERIDO E ARQUIVOS PRESERVADOS {envio}"
        pasta = fin.pasta_pendente(self.dir)
        pasta.mkdir()
        for nome in ("legado.xlsx", "legado.json", ".oculto"):
            arquivo = pasta / nome
            arquivo.write_bytes(b"preservar")
            with self.assertRaises(DomainConflictError):
                fin.recuperar_envio(self.dir, envio, "concluir_legado", confirmacao=frase)
            self.assertEqual(arquivo.read_bytes(), b"preservar")
            arquivo.unlink()
        (pasta / "subpasta").mkdir()
        with self.assertRaises(DomainConflictError):
            fin.recuperar_envio(self.dir, envio, "concluir_legado", confirmacao=frase)
        (pasta / "subpasta").rmdir()
        registro["status"] = "incerto"
        fin.atomic_write_json(fin.caminho_envio(self.dir), registro)
        with self.assertRaises(DomainConflictError):
            fin.recuperar_envio(self.dir, envio, "concluir_legado", confirmacao=frase)

    def test_snapshot_duravel_e_pendente_diferente_nao_autoriza_apagar_anteriores(self):
        antigo = fin.guardar_pendente(self.dir, self.origem, fin.agora_local(), motivo="antigo", tickets=[])
        self.origem.write_bytes(b"nova snapshot")
        novo = fin.guardar_pendente(self.dir, self.origem, fin.agora_local(), motivo="novo", tickets=[])
        envio = fin.preparar_envio(self.dir, novo.read_bytes(), pendente=novo)
        self.assertEqual(fin.snapshot_envio(self.dir, envio).read_bytes(), b"nova snapshot")
        fin.marcar_envio_incerto(self.dir, envio)
        fin.confirmar_envio(self.dir, envio)
        self.assertFalse(fin.descartar_pendentes(self.dir))
        self.assertTrue(antigo.exists())
        self.assertFalse(novo.exists())

    def test_recuperacao_confirmada_so_repete_limpeza_sem_upload_e_preserva_novas(self):
        antigo = fin.guardar_pendente(self.dir, self.origem, fin.agora_local(), motivo="x", tickets=[])
        envio = self.preparar()
        fin.marcar_envio_incerto(self.dir, envio)
        fin.confirmar_envio(self.dir, envio)
        novo = fin.guardar_pendente(self.dir, self.origem, fin.agora_local(), motivo="novo", tickets=[])
        fin.recuperar_envio(self.dir, envio, "limpar")
        self.assertFalse(antigo.exists())
        self.assertTrue(novo.exists())
        self.assertTrue(fin.aviso_do_pendente(self.dir)["limpeza_pendente"])

    def test_reconciliacao_humana_tipificada_preserva_snapshot_e_nao_dispara_job(self):
        for acao, frase, status in (("confirmar_recebimento", "CONFIRMO APLICADO", "concluido"),
                                    ("declarar_nao_enviado", "CONFIRMO NAO APLICADO", "falhou")):
            with self.subTest(acao=acao):
                self.setUp()
                envio = self.preparar()
                fin.marcar_envio_incerto(self.dir, envio)
                with self.assertRaises(DomainConflictError):
                    fin.recuperar_envio(self.dir, envio, acao, confirmacao="sim")
                fin.recuperar_envio(self.dir, envio, acao, confirmacao=f"{frase} {envio}")
                self.assertEqual(fin.ler_envio(self.dir)["status"], status)
                self.assertEqual(fin.snapshot_envio(self.dir, envio).read_bytes(), b"snapshot")
                self.assertFalse(fin.caminho_job(self.dir).exists())
                historico = self.dir / "sebrae_dashboard_envios" / envio / "registro.json"
                self.assertEqual(json.loads(historico.read_text(encoding="utf-8"))["resolucoes"][-1]["acao"], acao)
                if acao == "declarar_nao_enviado":
                    fin.preparar_envio(self.dir, b"outra snapshot")
                    self.assertEqual(json.loads(historico.read_text(encoding="utf-8"))["resolucoes"][-1]["acao"], acao)

    def test_recuperacao_recusa_id_stale_worker_ativo_snapshot_divergente_e_legado(self):
        envio = self.preparar()
        fin.marcar_envio_incerto(self.dir, envio)
        with self.assertRaises(DomainConflictError):
            fin.recuperar_envio(self.dir, "a" * 32, "limpar")
        with self.assertRaises(DomainConflictError):
            fin.recuperar_envio(self.dir, envio, "limpar", em_andamento=lambda: True)
        fin.snapshot_envio(self.dir, envio).write_bytes(b"alterado")
        with self.assertRaises(DomainConflictError):
            fin.recuperar_envio(self.dir, envio, "confirmar_recebimento", confirmacao=f"CONFIRMO APLICADO {envio}")
        self.assertEqual(fin.ler_envio(self.dir)["status"], "incerto")
        self.setUp()
        fin.gravar_resultado(self.dir, {"sharepoint": {"falhou": False, "limpeza_pendente": True}})
        legado = fin.ler_envio(self.dir)
        with self.assertRaises(DomainConflictError):
            fin.recuperar_envio(self.dir, legado["id"], "limpar")

    def test_aviso_legado_migra_antes_de_resultado_transitorio_ser_substituido(self):
        fin.gravar_resultado(self.dir, {"sharepoint": {"falhou": False, "limpeza_pendente": True}})
        fin.gravar_resultado(self.dir, {"sharepoint": None, "em_andamento": True})
        self.assertTrue(fin.aviso_do_pendente(self.dir)["limpeza_pendente"])
        with self.assertRaises(DomainConflictError):
            fin.gravar_job(self.dir, [], acao=fin.ACAO_REENVIAR)

    def test_copia_criada_durante_envio_e_identidade_alterada_nao_sao_apagadas(self):
        antigo = fin.guardar_pendente(self.dir, self.origem, fin.agora_local(), motivo="x", tickets=[])
        envio = self.preparar()
        fin.marcar_envio_incerto(self.dir, envio)
        novo = fin.guardar_pendente(self.dir, self.origem, fin.agora_local(), motivo="novo", tickets=[])
        antigo.write_bytes(b"alterado")
        fin.confirmar_envio(self.dir, envio)
        self.assertFalse(fin.descartar_pendentes(self.dir))
        self.assertEqual(antigo.read_bytes(), b"alterado")
        self.assertTrue(novo.is_file())
        fin.gravar_resultado(self.dir, {"sharepoint": None})
        with self.assertRaises(DomainConflictError):
            self.preparar()

    def test_confirmacao_local_falha_apos_upload_fica_incerta_e_bloqueia(self):
        envio = self.preparar()
        fin.marcar_envio_incerto(self.dir, envio)
        with patch.object(fin, "atomic_write_json", side_effect=PermissionError("disco")):
            with self.assertRaises(DomainBusyError):
                fin.confirmar_envio(self.dir, envio)
        self.assertTrue(fin.aviso_do_pendente(self.dir)["incerto"])
        with self.assertRaises(DomainConflictError):
            fin.exigir_envio_livre(self.dir)

    def test_diario_corrompido_ou_impossivel_de_gravar_bloqueia_antes_de_upload(self):
        contraditorio = {"id": "a" * 32, "status": "concluido", "sha256": "b" * 64, "copias": [], "limpeza_pendente": True}
        for dados in (b"{ruim", b"[]", b'{"status":"confirmado"}', json.dumps(contraditorio).encode()):
            fin.caminho_envio(self.dir).write_bytes(dados)
            with self.assertRaises(DomainBusyError):
                fin.exigir_envio_livre(self.dir)
            self.assertEqual(fin.caminho_envio(self.dir).read_bytes(), dados)
        fin.caminho_envio(self.dir).unlink()
        with patch.object(fin, "atomic_write_json", side_effect=PermissionError("disco")):
            with self.assertRaises(DomainBusyError):
                self.preparar()


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

    def test_horario_do_softexpert_substitui_o_r_digitado_a_mao(self):
        primeiro, _ = G.registrar_encerramentos(montar(), {UTIC: "29/10/2026 08:00"})
        segundo, estados = G.registrar_encerramentos(primeiro.conteudo, {UTIC: self.QUANDO})
        self.assertEqual(estados, {UTIC: G.ENCERRAMENTO_GRAVADO})
        self.assertRegex(linha_xml(segundo.conteudo, 2), R_1405)
        self.assertEqual(ler_coluna_c(segundo.conteudo), ler_coluna_c(primeiro.conteudo))

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
