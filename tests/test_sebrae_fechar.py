import re
import tempfile
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path

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

    def rodar_rotina_enviar(self, context, arquivo=None):
        if self.falha_envio:
            raise self.falha_envio
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

    def test_envio_que_falha_e_depois_funciona_nao_deixa_pendente_e_o_reenvio_nao_regrava_dado_velho(self):
        self.descrever(A, B)
        self.rotinas.falha_envio = RuntimeError("sem login")
        self.rodar({A: ok()}, [A])
        self.assertIsNotNone(fin.pendente_mais_recente(self.dir))
        self.rotinas.falha_envio = None
        self.rodar({B: ok()}, [B])  # envio bem-sucedido: a saída já traz A e B
        self.assertIsNone(fin.pendente_mais_recente(self.dir))
        self.assertEqual([p for p in fin.pasta_pendente(self.dir).glob("*") if p.suffix in (".xlsx", ".json")], [])
        self.assertEqual(len(self.rotinas.enviadas), 1)
        with self.assertRaises(Rotinas.RotinaErro):  # nada a reenviar: a cópia velha (só A) nunca sobe por cima
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


if __name__ == "__main__":
    unittest.main()
