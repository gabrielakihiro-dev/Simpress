import re
import tempfile
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from core.integrity import FileBusyError, FileTransactionError
from core.errors import DomainBusyError, DomainConflictError
from domains import sebrae_finalizacao as fin
from domains import sebrae_novos
from scripts import sebrae_fechar
from tests.test_sebrae_dashboard_gravacao import linha_xml, montar

A, B, C = "UTIC-2026-0001", "UTIC-2026-0002", "UTIC-2026-0003"
AGORA = datetime(2026, 10, 30, 17, 5, tzinfo=timezone.utc)  # 30/10/2026 14:05 in Brasília
R_1405 = r'<c r="R\d+"[^>]*><v>46325\.586'
PDF = b"%PDF-1.4\n%fake\n"


class SoftExpertErro(Exception):
    motivo = ""


class SessaoExpirada(SoftExpertErro):
    pass


class RotinaCancelada(BaseException):
    pass


class Aba:
    def is_closed(self):
        return getattr(self, "fechada", False)

    def close(self):
        self.fechada = True


class Rotinas:
    class RotinaErro(RuntimeError):
        pass

    RotinaCancelada = RotinaCancelada

    def __init__(self):
        self.logs = []
        self.enviadas = []  # (arquivo, bytes) of every rodar_rotina_enviar call
        self.copias = []
        self.falha_envio = None
        self.falha_copia = None
        self.cancelar_no = None  # the Nth call (1-based) of verificar_cancelamento raises
        self.verificacoes = 0
        self.erros_registrados = 0

    def agora_iso(self):
        return "agora"

    def log(self, origem, texto):
        self.logs.append(texto)

    def descrever_erro(self, erro):
        return str(erro) or type(erro).__name__

    def registrar_erro(self, pagina, origem):
        self.erros_registrados += 1

    def verificar_cancelamento(self, detalhe=""):
        self.verificacoes += 1
        if self.cancelar_no == self.verificacoes:
            raise RotinaCancelada()

    def rodar_rotina_enviar(self, context, arquivo=None, *, envio_id=None):
        if self.falha_envio:
            raise self.falha_envio
        if envio_id:
            fin.marcar_envio_incerto(self.state_dir, envio_id)
        self.enviadas.append(None if arquivo is None else (Path(arquivo).name, Path(arquivo).read_bytes()))

    def enviar_copia_pendente(self, context, arquivo):
        if self.falha_copia:
            raise self.falha_copia
        self.copias.append(Path(arquivo))


def modulo(respostas, aba):
    """``respostas``: ``{numero: dict | Exception}`` returned/raised by ``finalizar_chamado``."""
    chamadas = []

    def finalizar_chamado(pagina, numero, descricao, *, pdf=None, enviar_email=None, confirmar_final=True):
        chamadas.append({"numero": numero, "descricao": descricao, "pdf": pdf, "confirmar_final": confirmar_final})
        resposta = respostas[numero]
        if isinstance(resposta, Exception):
            raise resposta
        return resposta

    return types.SimpleNamespace(
        SoftExpertErro=SoftExpertErro, SessaoExpirada=SessaoExpirada, chamadas=chamadas, aberturas=[],
        abrir_softexpert=lambda contexto: aba, finalizar_chamado=finalizar_chamado,
    )


def ok():
    return {"numero": "", "status": "ok", "detalhes": {"mensagem": "feito", "escritas": ["Finalizar"]}}


def com_status(status, **detalhes):
    return {"numero": "", "status": status, "detalhes": detalhes}


class FecharBase(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.caminhos = sebrae_novos.caminhos_padrao(self.dir)
        self.rotinas = Rotinas()
        self.rotinas.state_dir = self.dir
        self.aba = Aba()
        self.importado = montar((A, B, C), ultima=9, status=("EM ABERTO", "EM ABERTO", "EM ABERTO"))
        sha = sebrae_novos.salvar_planilha(sebrae_novos.caminho_planilha(self.caminhos), self.importado)
        sebrae_novos.salvar_existentes(self.caminhos.existentes, [A, B, C], "Dashboard.xlsx", sha256=sha)
        self.saida = sebrae_novos.caminho_saida(self.caminhos, fin.NOME_DASHBOARD)

    def descrever(self, *numeros):
        for numero in numeros:
            fin.definir_descricao(self.dir, numero, f"feito {numero}")

    def rodar(self, respostas, numeros, *, sem_finalizar=False, confirmar_final=True):
        fin.gravar_job(self.dir, numeros, confirmar_final=confirmar_final)
        mod = modulo(respostas, self.aba)
        codigo = sebrae_fechar.executar(
            None, self.rotinas, state_dir=self.dir, modulo=mod, sem_finalizar=sem_finalizar, agora=lambda: AGORA,
        )
        return codigo, mod

    def resultado(self):
        return fin.ler_resultado(self.dir)

    def por_numero(self):
        return {r["numero"]: r for r in self.resultado()["resultados"]}


class ValidarXlsxTest(unittest.TestCase):
    def test_dashboard_real_com_linhas_formatadas_ate_o_fim_da_planilha_e_aceito(self):
        import io
        import zipfile

        from core.xlsx_safety import validate_xlsx_archive
        from tests.test_sebrae_dashboard_gravacao import partes_de

        partes = partes_de(montar((A,), ultima=9, status=("EM ABERTO",)))
        folha = partes["xl/worksheets/sheet4.xml"].decode()
        partes["xl/worksheets/sheet4.xml"] = folha.replace("</sheetData>", '<row r="1048576"/></sheetData>').encode()
        saida = io.BytesIO()
        with zipfile.ZipFile(saida, "w", zipfile.ZIP_STORED) as arquivo:
            for nome, corpo in partes.items():
                arquivo.writestr(nome, corpo)
        with self.assertRaises(Exception):  # a validação geral rejeita (é por isso que a gravação da coluna R não a usa)
            validate_xlsx_archive(zipfile.ZipFile(io.BytesIO(saida.getvalue())))
        sebrae_fechar._validar_xlsx(saida.getvalue())


class FinalizarTest(FecharBase):
    def test_ok_grava_r_na_linha_achada_pela_coluna_c_e_envia_ao_sharepoint(self):
        self.descrever(B)
        codigo, mod = self.rodar({B: ok()}, [B])
        self.assertEqual(codigo, 0)
        self.assertEqual(mod.chamadas, [{"numero": B, "descricao": f"feito {B}", "pdf": None, "confirmar_final": True}])
        saida = self.saida.read_bytes()
        self.assertRegex(linha_xml(saida, 3), R_1405)  # B is on row 3
        self.assertNotRegex(linha_xml(saida, 2), R_1405)
        self.assertNotRegex(linha_xml(saida, 4), R_1405)
        self.assertEqual(self.rotinas.enviadas, [None])  # the "enviar" routine took the saída file
        self.assertEqual(fin.encerramentos_registrados(self.dir), {B: "30/10/2026 14:05"})
        resultado = self.resultado()
        self.assertFalse(resultado["em_andamento"])
        self.assertFalse(resultado["sharepoint"]["falhou"])
        self.assertEqual(self.por_numero()[B]["encerrado_em"], "30/10/2026 14:05")
        self.assertEqual(self.por_numero()[B]["planilha"], "gravado")
        self.assertTrue(self.aba.fechada)

    def test_descricao_e_pdf_vem_do_estado_na_hora_da_execucao(self):
        self.descrever(A)
        fin.anexar_pdf(self.dir, A, "laudo.pdf", PDF)
        _, mod = self.rodar({A: ok()}, [A])
        self.assertEqual(mod.chamadas[0]["pdf"].name, "laudo.pdf")

    def test_nao_encontrado_nao_escreve_r_nem_envia_e_deixa_tentar_de_novo(self):
        self.descrever(A)
        codigo, _ = self.rodar({A: com_status("nao_encontrado")}, [A])
        self.assertEqual(codigo, 0)
        self.assertFalse(self.saida.exists())
        self.assertEqual(self.rotinas.enviadas, [])
        self.assertEqual(fin.encerramentos_registrados(self.dir), {})
        self.assertFalse(fin.ja_finalizado(self.dir, A))
        self.assertEqual(self.por_numero()[A]["status"], "nao_encontrado")
        self.assertEqual(self.por_numero()[A]["encerrado_em"], "")

    def test_nao_encontrado_nao_sobrescreve_r_que_ja_existe_na_saida(self):
        self.descrever(A, B)
        self.rodar({A: ok()}, [A])
        antes = self.saida.read_bytes()
        self.rodar({A: com_status("nao_encontrado")}, [A])
        self.assertEqual(self.saida.read_bytes(), antes)

    def test_nao_encontrado_e_depois_ok_na_nova_tentativa_vira_ok_com_r_e_d(self):
        self.descrever(B)
        self.rodar({B: com_status("nao_encontrado")}, [B])
        self.assertFalse(fin.ja_finalizado(self.dir, B))  # a nova tentativa é permitida
        codigo, mod = self.rodar({B: ok()}, [B])
        self.assertEqual((codigo, len(mod.chamadas)), (0, 1))
        self.assertTrue(fin.ja_finalizado(self.dir, B))
        self.assertEqual(self.por_numero()[B]["status"], "ok")
        linha = linha_xml(self.saida.read_bytes(), 3)
        self.assertRegex(linha, R_1405)
        self.assertIn("FINALIZADO", linha)
        self.assertEqual(self.rotinas.enviadas, [None])  # só a segunda rodada subiu ao SharePoint

    def test_ok_grava_d_finalizado_junto_com_r_so_na_linha_do_chamado(self):
        self.descrever(B)
        self.assertNotIn("FINALIZADO", linha_xml(self.importado, 3))
        self.rodar({B: ok()}, [B])
        saida = self.saida.read_bytes()
        self.assertIn("FINALIZADO", linha_xml(saida, 3))
        self.assertNotIn("FINALIZADO", linha_xml(saida, 2))

    def test_sem_finalizar_so_preenche_e_nao_toca_r_estado_nem_sharepoint(self):
        self.descrever(A)
        codigo, mod = self.rodar({A: com_status("pronto", mensagem="conferido")}, [A], sem_finalizar=True)
        self.assertEqual(codigo, 0)
        self.assertFalse(mod.chamadas[0]["confirmar_final"])
        self.assertFalse(self.saida.exists())
        self.assertEqual(self.rotinas.enviadas, [])
        self.assertFalse(fin.ja_finalizado(self.dir, A))
        self.assertEqual(self.por_numero()[A]["status"], "pronto")
        self.assertFalse(self.resultado()["confirmar_final"])

    def test_job_com_confirmar_final_falso_tambem_nao_finaliza(self):
        self.descrever(A)
        _, mod = self.rodar({A: com_status("pronto")}, [A], confirmar_final=False)
        self.assertFalse(mod.chamadas[0]["confirmar_final"])

    def test_sem_descricao_pula_sem_abrir_o_chamado(self):
        self.descrever(B)
        codigo, mod = self.rodar({B: ok()}, [A, B])
        self.assertEqual([c["numero"] for c in mod.chamadas], [B])
        self.assertEqual(self.por_numero()[A]["status"], "sem_descricao")
        self.assertEqual(codigo, 0)

    def test_erro_em_um_chamado_nao_para_os_outros_e_o_ok_ainda_vai_ao_dashboard(self):
        self.descrever(A, B)
        codigo, _ = self.rodar({A: SoftExpertErro("botão sumiu"), B: ok()}, [A, B])
        self.assertEqual(codigo, 1)
        self.assertEqual(self.por_numero()[A]["status"], "erro")
        self.assertEqual(self.por_numero()[A]["mensagem"], "botão sumiu")
        self.assertEqual(self.por_numero()[B]["status"], "ok")
        self.assertRegex(linha_xml(self.saida.read_bytes(), 3), R_1405)
        self.assertEqual(len(self.rotinas.enviadas), 1)

    def test_status_erro_da_funcao_vira_erro_sem_data(self):
        self.descrever(A)
        codigo, _ = self.rodar({A: com_status("erro", mensagem="não confere", motivo="campo", escritas=["Categoria"])}, [A])
        self.assertEqual(codigo, 1)
        self.assertEqual(self.por_numero()[A]["motivo"], "campo")
        self.assertEqual(self.por_numero()[A]["escritas"], ["Categoria"])
        self.assertFalse(self.saida.exists())
        self.assertEqual(self.rotinas.enviadas, [])

    def test_sessao_expirada_marca_os_restantes_e_ainda_envia_os_ja_finalizados(self):
        self.descrever(A, B, C)
        codigo, mod = self.rodar({A: ok(), B: SessaoExpirada("login"), C: ok()}, [A, B, C])
        self.assertEqual(codigo, 1)
        self.assertEqual([c["numero"] for c in mod.chamadas], [A, B])  # C was never opened
        achados = self.por_numero()
        self.assertEqual((achados[A]["status"], achados[B]["motivo"], achados[C]["motivo"]), ("ok", "sessao_expirada", "softexpert_indisponivel"))
        self.assertRegex(linha_xml(self.saida.read_bytes(), 2), R_1405)
        self.assertEqual(len(self.rotinas.enviadas), 1)

    def test_numero_invalido_e_repetido(self):
        self.descrever(A)
        codigo, mod = self.rodar({A: ok()}, ["linha:2", A, A])
        self.assertEqual(codigo, 1)
        self.assertEqual(len(mod.chamadas), 1)
        self.assertEqual([r["status"] for r in self.resultado()["resultados"]], ["erro", "ok"])

    def test_duas_rodadas_acumulam_r_sem_perder_a_primeira(self):
        self.descrever(A, B)
        self.rodar({A: ok()}, [A])
        self.rodar({B: ok()}, [B])
        saida = self.saida.read_bytes()
        self.assertRegex(linha_xml(saida, 2), R_1405)
        self.assertRegex(linha_xml(saida, 3), R_1405)
        self.assertEqual(len(self.rotinas.enviadas), 2)

    def test_sem_pedido_valido_a_rotina_recusa(self):
        with self.assertRaises(Rotinas.RotinaErro):
            sebrae_fechar.executar(None, self.rotinas, state_dir=self.dir, modulo=modulo({}, self.aba))

    def test_cancelar_deixa_resultado_parcial_e_fecha_a_aba(self):
        self.descrever(A, B)
        self.rotinas.cancelar_no = 2
        with self.assertRaises(RotinaCancelada):
            self.rodar({A: ok(), B: ok()}, [A, B])
        resultado = self.resultado()
        self.assertTrue(resultado["cancelado"])
        self.assertFalse(resultado["em_andamento"])
        self.assertEqual([r["numero"] for r in resultado["resultados"]], [A])
        self.assertTrue(self.aba.fechada)
        self.assertEqual(self.rotinas.enviadas, [])
        # A is finalized in SoftExpert: the date stays in the state so the next "Atualizar Dashboard" re-applies it
        self.assertEqual(fin.encerramentos_registrados(self.dir), {A: "30/10/2026 14:05"})

    def test_sem_dashboard_importado_grava_aviso_e_nao_envia(self):
        sebrae_novos.caminho_planilha(self.caminhos).unlink()
        self.descrever(A)
        codigo, _ = self.rodar({A: ok()}, [A])
        self.assertEqual(self.rotinas.enviadas, [])
        self.assertIn("Não há Dashboard importado", self.resultado()["planilha"])
        self.assertEqual(self.por_numero()[A]["status"], "ok")
        self.assertEqual(codigo, 0)


class EnvioFalhoTest(FecharBase):
    def test_falha_no_envio_guarda_copia_pendente_sobe_com_outro_nome_e_avisa(self):
        self.descrever(A)
        self.rotinas.falha_envio = RuntimeError("sem login no SharePoint")
        codigo, _ = self.rodar({A: ok()}, [A])
        self.assertEqual(codigo, 1)
        pendente, registro = fin.pendente_mais_recente(self.dir)
        self.assertNotEqual(pendente.name, fin.NOME_DASHBOARD)
        self.assertEqual(pendente.read_bytes(), self.saida.read_bytes())
        self.assertEqual(registro["chamados"], [A])
        self.assertEqual(self.rotinas.copias, [pendente])
        aviso = self.resultado()["sharepoint"]
        self.assertEqual(
            {k: aviso[k] for k in ("falhou", "motivo", "copia_local", "copia_sharepoint")},
            {"falhou": True, "motivo": "sem login no SharePoint", "copia_local": str(pendente), "copia_sharepoint": True},
        )
        self.assertEqual(len(aviso["sugestoes"]), 3)
        self.assertTrue(fin.aviso_do_pendente(self.dir)["copia_sharepoint"])

    def test_se_a_copia_tambem_nao_sobe_o_aviso_diz_que_so_existe_a_copia_local(self):
        self.descrever(A)
        self.rotinas.falha_envio = RuntimeError("sem login")
        self.rotinas.falha_copia = RuntimeError("sem pasta")
        self.rodar({A: ok()}, [A])
        aviso = self.resultado()["sharepoint"]
        self.assertTrue(aviso["falhou"])
        self.assertFalse(aviso["copia_sharepoint"])
        self.assertTrue(Path(aviso["copia_local"]).is_file())
        self.assertFalse(fin.aviso_do_pendente(self.dir)["copia_sharepoint"])


class ReenviarTest(FecharBase):
    def preparar_job_snapshot(self):
        envio = fin.preparar_envio(self.dir, self.importado)
        sha = fin.ler_envio(self.dir)["sha256"]
        fin.marcar_envio_incerto(self.dir, envio)
        fin.recuperar_envio(self.dir, envio, "declarar_nao_enviado", confirmacao=f"CONFIRMO NAO APLICADO {envio}")
        fin.gravar_job(self.dir, [], acao="reenviar_snapshot", envio_id=envio, sha256=sha)
        return envio, sha

    def test_snapshot_alterada_apos_job_e_id_stale_bloqueiam_antes_de_envio(self):
        for alterar_id in (False, True):
            with self.subTest(alterar_id=alterar_id):
                self.setUp()
                envio, sha = self.preparar_job_snapshot()
                if alterar_id:
                    registro = fin.ler_envio(self.dir)
                    registro["id"] = "a" * 32
                    fin.atomic_write_json(fin.caminho_envio(self.dir), registro)
                else:
                    fin.snapshot_envio(self.dir, envio).write_bytes(b"alterado")
                with self.assertRaises(DomainConflictError):
                    sebrae_fechar.executar(None, self.rotinas, state_dir=self.dir)
                self.assertEqual(self.rotinas.enviadas, [])

    def test_falha_antes_de_persistir_retomada_nao_envia_e_permite_novo_clique(self):
        envio, sha = self.preparar_job_snapshot()
        gravar = fin.atomic_write_json
        def falhar(path, dados):
            if path == fin.caminho_envio(self.dir) and dados.get("status") == "preparado":
                raise PermissionError("disco")
            gravar(path, dados)
        with patch.object(fin, "atomic_write_json", side_effect=falhar):
            with self.assertRaises(fin.DomainBusyError):
                sebrae_fechar.executar(None, self.rotinas, state_dir=self.dir)
        self.assertEqual(self.rotinas.enviadas, [])
        self.assertEqual(fin.ler_envio(self.dir)["status"], "falhou")
        fin.gravar_job(self.dir, [], acao="reenviar_snapshot", envio_id=envio, sha256=sha)
        self.assertEqual(sebrae_fechar.executar(None, self.rotinas, state_dir=self.dir), 0)
    def test_reenvio_da_snapshot_funciona_sem_fila_e_preserva_fila_ambigua(self):
        for com_fila in (False, True):
            with self.subTest(com_fila=com_fila):
                self.setUp()
                envio = fin.preparar_envio(self.dir, self.importado)
                sha = fin.ler_envio(self.dir)["sha256"]
                fin.marcar_envio_incerto(self.dir, envio)
                fin.recuperar_envio(self.dir, envio, "declarar_nao_enviado", confirmacao=f"CONFIRMO NAO APLICADO {envio}")
                pasta = fin.pasta_pendente(self.dir)
                if com_fila:
                    pasta.mkdir()
                    (pasta / "ambiguo.xlsx").write_bytes(b"antigo")
                    (pasta / "ambiguo.json").write_bytes(b"sidecar")
                antes = {p.name: p.read_bytes() for p in pasta.glob("*")}
                fin.gravar_job(self.dir, [], acao="reenviar_snapshot", envio_id=envio, sha256=sha)
                with patch.object(fin, "pendente_mais_recente", side_effect=AssertionError("não selecionar fila")), patch.object(fin, "guardar_pendente", side_effect=AssertionError("não copiar para fila")):
                    self.assertEqual(sebrae_fechar.executar(None, self.rotinas, state_dir=self.dir), 0)
                self.assertEqual(self.rotinas.enviadas, [(fin.NOME_DASHBOARD, self.importado)])
                self.assertEqual({p.name: p.read_bytes() for p in pasta.glob("*")}, antes)
                self.assertEqual(fin.ler_envio(self.dir)["id"], envio)
    def test_erro_ao_salvar_resultado_depois_do_envio_confirmado_nao_desfaz_sucesso(self):
        self.criar_pendente()
        gravar = fin.gravar_resultado
        def falhar_no_fim(state_dir, resultado):
            if resultado.get("terminado_em"):
                raise OSError("disco")
            gravar(state_dir, resultado)
        with patch.object(fin, "gravar_resultado", side_effect=falhar_no_fim):
            self.assertEqual(self.pedir(), 0)
        self.assertEqual(fin.ler_envio(self.dir)["status"], "concluido")

    def test_id_divergente_apos_erro_local_nao_e_tratado_como_confirmacao(self):
        self.criar_pendente()
        def enviar(context, *, envio_id):
            registro = fin.ler_envio(self.dir)
            registro["id"] = "a" * 32
            registro["status"] = "confirmado"
            fin.atomic_write_json(fin.caminho_envio(self.dir), registro)
            raise OSError("close")
        with patch.object(self.rotinas, "rodar_rotina_enviar", side_effect=enviar), self.assertRaises(DomainConflictError):
            sebrae_fechar._enviar_ao_sharepoint(None, self.rotinas, self.dir, self.saida, [], self.rotinas.logs.append, lambda: AGORA)
        self.assertEqual(self.rotinas.copias, [])

    def test_erro_local_apos_confirmado_nao_cria_fallback_nos_dois_fluxos(self):
        for reenvio in (False, True):
            with self.subTest(reenvio=reenvio):
                self.setUp()
                self.criar_pendente()
                def enviar(context, arquivo=None, *, envio_id=None):
                    fin.marcar_envio_incerto(self.dir, envio_id)
                    fin.confirmar_envio(self.dir, envio_id)
                    raise OSError("close falhou")
                with patch.object(self.rotinas, "rodar_rotina_enviar", side_effect=enviar):
                    if reenvio:
                        self.assertEqual(self.pedir(), 0)
                    else:
                        aviso = sebrae_fechar._enviar_ao_sharepoint(None, self.rotinas, self.dir, self.saida, [], self.rotinas.logs.append, lambda: AGORA)
                        self.assertFalse(aviso["falhou"])
                self.assertEqual(self.rotinas.copias, [])
                self.assertNotIn("reenvio falhou", " ".join(self.rotinas.logs))
    def test_resultado_incerto_nao_e_sucesso_da_rotina_nem_falha_confirmada_do_envio(self):
        self.descrever(A)
        def incerto(context, *, envio_id):
            fin.marcar_envio_incerto(self.dir, envio_id)
            raise RuntimeError("sem confirmação remota")
        with patch.object(self.rotinas, "rodar_rotina_enviar", side_effect=incerto):
            codigo, _ = self.rodar({A: ok()}, [A])
        self.assertEqual(codigo, 1)
        self.assertTrue(self.resultado()["sharepoint"]["incerto"])
        self.assertFalse(self.resultado()["sharepoint"]["falhou"])
        with self.assertRaises(DomainConflictError):
            self.pedir()

    def test_nova_finalizacao_nao_apaga_marca_duravel_nem_dispara_outro_envio(self):
        pendente = self.criar_pendente()
        with patch.object(fin, "descartar_pendente", side_effect=PermissionError("ocupado")):
            self.assertEqual(self.pedir(), 0)
        self.descrever(B)
        codigo, mod = self.rodar({B: ok()}, [B])
        self.assertEqual(codigo, 0)
        self.assertEqual(len(mod.chamadas), 1)
        self.assertEqual(len(self.rotinas.enviadas), 1)
        self.assertTrue(pendente.exists())
        self.assertTrue(fin.aviso_do_pendente(self.dir)["limpeza_pendente"])
        self.assertFalse(fin.aviso_do_pendente(self.dir)["falhou"])

    def test_worker_nao_sobrescreve_aviso_nem_reenvia_apos_confirmacao_com_limpeza_pendente(self):
        pendente = self.criar_pendente()
        fin.gravar_resultado(self.dir, {"sharepoint": {"falhou": False, "limpeza_pendente": True}})
        with self.assertRaises(DomainConflictError):
            sebrae_fechar._reenviar_pendente(None, self.rotinas, self.dir, self.rotinas.logs.append)
        self.assertEqual(self.rotinas.enviadas, [])
        self.assertTrue(pendente.exists())
        self.assertTrue(fin.aviso_do_pendente(self.dir)["limpeza_pendente"])

    def test_trava_na_limpeza_nao_desfaz_envio_confirmado(self):
        with patch.object(fin, "descartar_pendentes", side_effect=FileBusyError("ocupado")):
            self.assertFalse(sebrae_fechar._descartar_pendentes(self.dir, self.rotinas.logs.append))
        self.assertIn("preservadas", " ".join(self.rotinas.logs))

    def test_reenvio_confirmado_avisa_quando_limpeza_preserva_copias(self):
        for conflito in (False, True):
            with self.subTest(conflito=conflito):
                self.setUp()
                pendente = self.criar_pendente()
                self.rotinas.logs.clear()
                if conflito:
                    outro = pendente.parent / "legado-ambiguo.xlsx"
                    def enviar(context, arquivo, *, envio_id=None):
                        fin.marcar_envio_incerto(self.dir, envio_id)
                        outro.write_bytes(self.importado)
                    alvo = patch.object(self.rotinas, "rodar_rotina_enviar", side_effect=enviar)
                else:
                    alvo = patch.object(fin, "descartar_pendente", side_effect=PermissionError("bloqueado"))
                with alvo:
                    self.assertEqual(self.pedir(), 0)
                self.assertTrue(pendente.exists())
                aviso = self.resultado()["sharepoint"]
                self.assertFalse(aviso["falhou"])
                self.assertTrue(aviso["limpeza_pendente"])
                self.assertTrue(fin.aviso_do_pendente(self.dir)["limpeza_pendente"])
                self.assertNotIn("foi removida", " ".join(self.rotinas.logs))
                self.assertIn("preservad", " ".join(self.rotinas.logs))

    def test_envio_confirmado_propaga_limpeza_adiada(self):
        pendente = self.criar_pendente()
        with patch.object(fin, "descartar_pendente", side_effect=PermissionError("bloqueado")):
            aviso = sebrae_fechar._enviar_ao_sharepoint(None, self.rotinas, self.dir, self.saida, [], self.rotinas.logs.append, lambda: AGORA)
        self.assertFalse(aviso["falhou"])
        self.assertTrue(aviso["limpeza_pendente"])
        self.assertTrue(pendente.exists())

    def test_reenvio_recusa_copia_pendente_montada_sobre_importacao_antiga(self):
        pendente = self.criar_pendente()
        sebrae_novos.salvar_existentes(self.caminhos.existentes, [A, B, C], "Dashboard.xlsx", sha256="b" * 64)  # reimportou depois
        with self.assertRaisesRegex(Rotinas.RotinaErro, "gerada antes da última importação"):
            self.pedir()
        self.assertEqual(self.rotinas.enviadas, [])
        self.assertTrue(pendente.exists())
        self.assertFalse(self.resultado()["em_andamento"])

    def test_reenvio_recusa_copia_pendente_sem_base_registrada(self):
        pendente = self.criar_pendente()
        registro = fin.pendente_mais_recente(self.dir)[1]
        registro.pop("base_sha256")
        fin.atomic_write_json(pendente.with_suffix(".json"), registro)
        with self.assertRaisesRegex(Rotinas.RotinaErro, "gerada antes da última importação"):
            self.pedir()
        self.assertEqual(self.rotinas.enviadas, [])
        self.assertTrue(pendente.exists())

    def test_reenvio_da_snapshot_recusa_importacao_posterior_ao_job(self):
        for alterar_base in (False, True):
            with self.subTest(alterar_base=alterar_base):
                self.setUp()
                envio = fin.preparar_envio(self.dir, self.importado)
                sha = fin.ler_envio(self.dir)["sha256"]
                fin.marcar_envio_incerto(self.dir, envio)
                fin.recuperar_envio(self.dir, envio, "declarar_nao_enviado", confirmacao=f"CONFIRMO NAO APLICADO {envio}")
                fin.gravar_job(self.dir, [], acao="reenviar_snapshot", envio_id=envio, sha256=sha)
                if alterar_base:
                    sebrae_novos.salvar_existentes(self.caminhos.existentes, [A, B, C], "Dashboard.xlsx", sha256="b" * 64)
                    with self.assertRaises(DomainConflictError):
                        sebrae_fechar.executar(None, self.rotinas, state_dir=self.dir)
                    self.assertEqual(self.rotinas.enviadas, [])
                else:
                    self.assertEqual(sebrae_fechar.executar(None, self.rotinas, state_dir=self.dir), 0)
                    self.assertEqual(self.rotinas.enviadas, [(fin.NOME_DASHBOARD, self.importado)])

    def pedir(self):
        fin.gravar_job(self.dir, [], acao=fin.ACAO_REENVIAR)
        return sebrae_fechar.executar(None, self.rotinas, state_dir=self.dir, modulo=modulo({}, self.aba), agora=lambda: AGORA)

    def criar_pendente(self):
        self.saida.parent.mkdir(parents=True, exist_ok=True)
        self.saida.write_bytes(self.importado)
        return fin.guardar_pendente(self.dir, self.saida, AGORA, motivo="sem login", tickets=[A])

    def test_reenvio_manda_a_copia_com_o_nome_do_dashboard_e_descarta_a_pendente(self):
        pendente = self.criar_pendente()
        self.assertEqual(self.pedir(), 0)
        self.assertEqual(self.rotinas.enviadas, [(fin.NOME_DASHBOARD, self.importado)])
        self.assertFalse(pendente.exists())
        self.assertFalse(self.resultado()["sharepoint"]["falhou"])
        self.assertEqual(self.resultado()["acao"], fin.ACAO_REENVIAR)

    def test_reenvio_que_falha_mantem_a_pendente_e_o_aviso(self):
        pendente = self.criar_pendente()
        self.rotinas.falha_envio = RuntimeError("ainda sem login")
        self.assertEqual(self.pedir(), 1)
        self.assertTrue(pendente.exists())
        aviso = self.resultado()["sharepoint"]
        self.assertEqual((aviso["falhou"], aviso["motivo"], aviso["copia_local"]), (True, "ainda sem login", str(pendente)))
        self.assertFalse(self.resultado()["em_andamento"])

    def test_reenvio_sem_pendente_falha_com_mensagem_e_resultado_final(self):
        with self.assertRaises(Rotinas.RotinaErro):
            self.pedir()
        self.assertFalse(self.resultado()["em_andamento"])

    def test_envio_novo_confirmado_preserva_copia_antiga_diferente_e_bloqueia_reenvio(self):
        self.descrever(A, B)
        self.rotinas.falha_envio = RuntimeError("sem login")
        self.rodar({A: ok()}, [A])
        self.assertIsNotNone(fin.pendente_mais_recente(self.dir))
        self.rotinas.falha_envio = None
        self.rodar({B: ok()}, [B])  # envio bem-sucedido: a saída já traz A e B
        self.assertIsNotNone(fin.pendente_mais_recente(self.dir))
        self.assertTrue(fin.aviso_do_pendente(self.dir)["limpeza_pendente"])
        self.assertEqual(len(self.rotinas.enviadas), 1)
        with self.assertRaises(DomainConflictError):  # a cópia velha (só A) nunca sobe por cima
            self.pedir()
        self.assertEqual(len(self.rotinas.enviadas), 1)
        enviado = self.saida.read_bytes()
        self.assertRegex(linha_xml(enviado, 2), R_1405)
        self.assertRegex(linha_xml(enviado, 3), R_1405)

    def test_pendente_que_nao_e_xlsx_valido_nao_e_enviada(self):
        pendente = self.criar_pendente()
        pendente.write_bytes(b"nao e um xlsx")
        self.assertEqual(self.pedir(), 1)
        self.assertEqual(self.rotinas.enviadas, [])
        self.assertTrue(pendente.exists())


class RobustezFase1BTest(FecharBase):
    def corromper_envio(self):
        fin.caminho_envio(self.dir).write_bytes(b"{nao e json")

    def test_gravar_resultado_nao_aborta_com_registro_de_envio_corrompido(self):
        self.corromper_envio()
        fin.gravar_resultado(self.dir, {"em_andamento": False})
        self.assertEqual(fin.ler_resultado(self.dir), {"em_andamento": False})
        self.assertEqual(fin.caminho_envio(self.dir).read_bytes(), b"{nao e json")  # preservado para conferencia

    def test_falha_de_escrita_da_migracao_legada_preserva_o_aviso_e_a_excecao_sobe(self):
        legado = {"sharepoint": {"limpeza_pendente": True}}
        fin.atomic_write_json(fin.caminho_resultado(self.dir), legado)
        with patch.object(fin, "_gravar_envio", side_effect=DomainBusyError("disco")), self.assertRaises(DomainBusyError):
            fin.gravar_resultado(self.dir, {"em_andamento": True})
        self.assertEqual(fin.ler_resultado(self.dir), legado)

    def test_envio_corrompido_de_ponta_a_ponta_nao_derruba_e_gera_copia_pendente_local_com_aviso(self):
        self.descrever(A)
        self.corromper_envio()
        codigo, _ = self.rodar({A: ok()}, [A])
        self.assertEqual(codigo, 1)
        pendente, registro = fin.pendente_mais_recente(self.dir)
        self.assertEqual(pendente.read_bytes(), self.saida.read_bytes())
        self.assertEqual(registro["chamados"], [A])
        aviso = self.resultado()["sharepoint"]
        self.assertTrue(aviso["falhou"])
        self.assertEqual(aviso["copia_local"], str(pendente))
        self.assertFalse(aviso["copia_sharepoint"])
        self.assertEqual((self.rotinas.enviadas, self.rotinas.copias), ([], []))
        self.assertEqual(fin.caminho_envio(self.dir).read_bytes(), b"{nao e json")

    def test_falha_local_em_preparar_envio_gera_copia_pendente_local_com_aviso(self):
        erros = (DomainBusyError("ocupado"), FileBusyError("lock"), FileTransactionError("falhou"), OSError("leitura"))
        for erro in erros:
            with self.subTest(erro=type(erro).__name__):
                self.setUp()
                self.descrever(A)
                with patch.object(fin, "preparar_envio", side_effect=erro):
                    codigo, _ = self.rodar({A: ok()}, [A])
                self.assertEqual(codigo, 1)
                pendente, _ = fin.pendente_mais_recente(self.dir)
                self.assertEqual(pendente.read_bytes(), self.saida.read_bytes())
                aviso = self.resultado()["sharepoint"]
                self.assertTrue(aviso["falhou"])
                self.assertEqual(aviso["copia_local"], str(pendente))
                self.assertEqual((self.rotinas.enviadas, self.rotinas.copias), ([], []))

    def test_falha_ao_guardar_copia_pendente_nao_derruba_depois_do_finalizar(self):
        for erro in (FileBusyError("lock"), FileTransactionError("falhou"), OSError("disco")):
            with self.subTest(erro=type(erro).__name__):
                self.setUp()
                self.descrever(A)
                with patch.object(fin, "preparar_envio", side_effect=DomainBusyError("ocupado")), \
                        patch.object(fin, "guardar_pendente", side_effect=erro):
                    codigo, _ = self.rodar({A: ok()}, [A])
                self.assertEqual(codigo, 1)
                aviso = self.resultado()["sharepoint"]
                self.assertTrue(aviso["falhou"])
                self.assertEqual((self.rotinas.enviadas, self.rotinas.copias), ([], []))

    def test_conflito_em_preparar_envio_preserva_local_sem_copia_pendente_nem_upload(self):
        self.descrever(A)
        with patch.object(fin, "preparar_envio", side_effect=DomainConflictError("envio mudou")):
            self.rodar({A: ok()}, [A])
        self.assertIsNone(fin.pendente_mais_recente(self.dir))
        self.assertTrue(self.saida.is_file())
        self.assertEqual((self.rotinas.enviadas, self.rotinas.copias), ([], []))

    def falhar_no_fim(self):
        gravar = fin.gravar_resultado

        def falhar(state_dir, resultado):
            if resultado.get("terminado_em"):
                raise OSError("disco")
            gravar(state_dir, resultado)

        return patch.object(fin, "gravar_resultado", side_effect=falhar)

    def test_finally_nao_esconde_a_excecao_original_e_fecha_as_abas(self):
        self.descrever(A, B)
        self.rotinas.cancelar_no = 2  # A abre a aba; o cancelamento chega antes de B
        fin.gravar_job(self.dir, [A, B])
        with self.falhar_no_fim(), self.assertRaises(RotinaCancelada):
            sebrae_fechar.executar(None, self.rotinas, state_dir=self.dir, modulo=modulo({A: ok(), B: ok()}, self.aba), agora=lambda: AGORA)
        self.assertTrue(any("OSError" in texto for texto in self.rotinas.logs))
        self.assertTrue(self.aba.is_closed())

    def test_finally_relanca_o_erro_do_salvar_no_caminho_de_sucesso_e_fecha_as_abas(self):
        self.descrever(A)
        with self.falhar_no_fim(), self.assertRaises(OSError):
            self.rodar({A: ok()}, [A])
        self.assertTrue(self.aba.is_closed())


if __name__ == "__main__":
    unittest.main()
