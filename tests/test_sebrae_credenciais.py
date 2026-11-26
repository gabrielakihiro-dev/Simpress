"""Senha do chamado no F5 (exceção de LGPD autorizada em 19/11/2026): só dados sintéticos."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from domains import sebrae_credenciais, sebrae_novos
from domains.sebrae_chamados import ChamadoSoftExpert
from tests import test_sebrae_fechar as fechar
from tests import test_sebrae_leitura as leitura
from tests.test_sebrae_dashboard_gravacao import montar
from tests.test_sebrae_dashboard_router import RotasBase

DESCRICAO = "Usuário criado\nSenha: Abc12345\nCPF 123.456.789-09"


class ExtrairTest(unittest.TestCase):
    def test_devolve_o_que_a_mascara_esconde(self):
        self.assertEqual(sebrae_credenciais.extrair(DESCRICAO), ["Abc12345"])
        self.assertEqual(sebrae_credenciais.extrair("a senha temporária foi Xyz98765"), ["Xyz98765"])
        self.assertEqual(sebrae_credenciais.extrair("login\nfulano@exemplo.com\nQwerty123"), ["Qwerty123"])
        self.assertEqual(sebrae_credenciais.extrair("Use Sebrae@2026 no acesso", "Senha: Sebrae@2026"), ["Sebrae@2026"])

    def test_texto_sem_senha_nao_devolve_nada(self):
        self.assertEqual(sebrae_credenciais.extrair("Teclado com defeito", "", None), [])


class GuardarTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def test_guarda_so_os_valores_le_e_remove(self):
        self.assertTrue(sebrae_credenciais.guardar(self.dir, "UTIC-2026-0002", "Teclado", DESCRICAO))
        bruto = (self.dir / sebrae_credenciais.ARQUIVO).read_text(encoding="utf-8")
        self.assertEqual(json.loads(bruto), {"UTIC-2026-0002": ["Abc12345"]})
        self.assertNotIn("123.456", bruto)  # nunca a descrição inteira
        self.assertEqual(sebrae_credenciais.numeros(self.dir), {"UTIC-2026-0002"})
        sebrae_credenciais.remover(self.dir, "UTIC-2026-0002")
        self.assertEqual(sebrae_credenciais.ler(self.dir, "UTIC-2026-0002"), [])

    def test_sem_senha_nao_cria_arquivo(self):
        self.assertFalse(sebrae_credenciais.guardar(self.dir, "UTIC-2026-0002", "Teclado"))
        self.assertFalse((self.dir / sebrae_credenciais.ARQUIVO).exists())


class LeituraGuardaSenhaTest(unittest.TestCase):
    setUp, rodar = leitura.LeituraTest.setUp, leitura.LeituraTest.rodar  # só o preparo, sem herdar os testes de lá

    def test_leitura_guarda_a_senha_a_parte_e_o_json_da_tela_continua_mascarado(self):
        sebrae_novos.salvar_existentes(self.caminhos.existentes, ["UTIC-2026-0001"], "d.xlsx")
        leituras = {"UTIC-2026-0002": ChamadoSoftExpert("UTIC-2026-0002", titulo="Acesso", descricao=DESCRICAO)}
        self.rodar([leitura.item("UTIC-2026-0002", "Acesso")], leituras)
        self.assertNotIn("Abc12345", self.caminhos.novos.read_text(encoding="utf-8"))
        self.assertEqual(sebrae_credenciais.ler(self.dir, "UTIC-2026-0002"), ["Abc12345"])
        self.assertFalse(any("Abc12345" in texto for texto in self.rotinas.logs))


class FinalizarApagaSenhaTest(fechar.FecharBase):
    def test_finalizado_no_softexpert_apaga_a_senha_guardada(self):
        sebrae_credenciais.guardar(self.dir, fechar.B, DESCRICAO)
        sebrae_credenciais.guardar(self.dir, fechar.C, DESCRICAO)
        self.descrever(fechar.B)
        self.rodar({fechar.B: fechar.ok()}, [fechar.B])
        self.assertEqual(sebrae_credenciais.numeros(self.dir), {fechar.C})

    def test_finalizado_por_outro_tecnico_mantem_a_senha_guardada(self):
        # decisão do usuário (25/11/2026): preserva o Desfazer finalização; a senha só sai na importação
        sebrae_credenciais.guardar(self.dir, fechar.B, DESCRICAO)
        self.descrever(fechar.B)
        self.rodar({fechar.B: fechar.com_status("nao_encontrado")}, [fechar.B], manuais={fechar.B: "12/11/2026 09:30"})
        self.assertEqual(self.por_numero()[fechar.B]["status"], "finalizado_outro_tecnico")
        self.assertEqual(sebrae_credenciais.numeros(self.dir), {fechar.B})

    def test_nao_encontrado_sem_encerramento_manual_mantem_a_senha(self):
        sebrae_credenciais.guardar(self.dir, fechar.B, DESCRICAO)
        self.descrever(fechar.B)
        self.rodar({fechar.B: fechar.com_status("nao_encontrado")}, [fechar.B])
        self.assertEqual(sebrae_credenciais.numeros(self.dir), {fechar.B})

    def test_falha_ao_apagar_nao_muda_o_resultado_e_o_log_so_traz_o_tipo(self):
        sebrae_credenciais.guardar(self.dir, fechar.B, DESCRICAO)
        self.descrever(fechar.B)
        with patch.object(sebrae_credenciais, "remover", side_effect=OSError("Abc12345")):
            self.rodar({fechar.B: fechar.ok()}, [fechar.B])
        self.assertEqual(self.por_numero()[fechar.B]["status"], fechar.fin.STATUS_OK)
        self.assertTrue(any("senha guardada não apagada (OSError)" in texto for texto in self.rotinas.logs))
        self.assertFalse(any("Abc12345" in texto for texto in self.rotinas.logs))


class ImportacaoApagaSenhaTest(RotasBase):
    NOVO = "UTIC-2026-1378"  # lido do SoftExpert, ainda fora da coluna C

    def setUp(self):
        super().setUp()
        self.pasta = self.caminhos.existentes.parent
        for numero in ("UTIC-2026-0001", "UTIC-2026-0002", self.NOVO):
            sebrae_credenciais.guardar(self.pasta, numero, DESCRICAO)

    def test_encerrado_na_importacao_apaga_e_aberto_ou_novo_mantem(self):
        self.assertEqual(self.importar(montar()).status_code, 200)  # 0001 EM ABERTO, 0002 FINALIZADO
        self.assertEqual(sebrae_credenciais.numeros(self.pasta), {"UTIC-2026-0001", self.NOVO})
        self.assertEqual(self.importar(montar(status=("FINALIZADO", "FINALIZADO"))).status_code, 200)
        self.assertEqual(sebrae_credenciais.numeros(self.pasta), {self.NOVO})

    def test_chamado_que_some_da_coluna_c_apaga_a_senha(self):
        self.importar(montar())
        self.assertEqual(self.importar(montar(chamados=("UTIC-2026-0003",), status=("EM ABERTO",))).status_code, 200)
        self.assertEqual(sebrae_credenciais.numeros(self.pasta), {self.NOVO})

    def test_falha_ao_apagar_nao_bloqueia_a_importacao(self):
        with patch.object(sebrae_credenciais, "remover", side_effect=OSError("Abc12345")), self.assertLogs(level="WARNING") as logs:
            resposta = self.importar(montar())
        self.assertEqual(resposta.status_code, 200)
        self.assertTrue(any("OSError" in linha for linha in logs.output))
        self.assertFalse(any("Abc12345" in linha for linha in logs.output))

    def test_limite_de_quantidade_na_importacao_pula_a_limpeza_e_avisa(self):
        nums = tuple(f"UTIC-2026-{n:04d}" for n in range(1, 9))  # 8 abertos, todos com senha (+ NOVO = 9 guardadas)
        for numero in nums:
            sebrae_credenciais.guardar(self.pasta, numero, DESCRICAO)
        self.assertEqual(self.importar(montar(chamados=nums, status=("EM ABERTO",) * 8, ultima=12)).status_code, 200)
        resposta = self.importar(montar(chamados=("UTIC-2026-0099",), status=("EM ABERTO",)))  # a planilha "perdeu" os 8
        self.assertEqual(resposta.status_code, 200)  # a importação segue
        self.assertEqual(len(sebrae_credenciais.numeros(self.pasta)), 9)  # nenhuma apagada
        aviso = resposta.json()["aviso"]
        self.assertIn("apagaria 8 senhas", aviso)
        self.assertIn("sumiram da coluna C (de 9 guardadas)", aviso)
        self.assertNotIn("UTIC-2026", aviso)
        self.assertNotIn("Abc12345", resposta.text)

    def test_sem_aviso_quando_sai_uma_unica_senha(self):
        self.importar(montar())
        resposta = self.importar(montar(chamados=("UTIC-2026-0003",), status=("EM ABERTO",)))  # 1 apagada (0001)
        self.assertNotIn("aviso", resposta.json())
        self.assertNotIn("UTIC-2026-0001", sebrae_credenciais.numeros(self.pasta))


class LimiteNaImportacaoTest(RotasBase):
    """Limites exatos pelo router: só os que SAEM da coluna C contam; cada caso guarda ``total`` senhas e tira ``saem`` da planilha."""

    def cenario(self, total, saem):
        pasta = self.caminhos.existentes.parent
        nums = tuple(f"UTIC-2026-{n:04d}" for n in range(1, total + 1))
        for numero in nums:
            sebrae_credenciais.guardar(pasta, numero, DESCRICAO)
        self.assertEqual(self.importar(montar(chamados=nums, status=("EM ABERTO",) * total, ultima=total + 6)).status_code, 200)
        resto = nums[saem:] + ("UTIC-2026-9999",)  # os `saem` primeiros somem da coluna C; 9999 não tem senha
        resposta = self.importar(montar(chamados=resto, status=("EM ABERTO",) * len(resto), ultima=len(resto) + 6))
        self.assertEqual(resposta.status_code, 200)
        return resposta.json(), len(sebrae_credenciais.numeros(pasta))

    def test_5_que_sairam_apagam(self):
        corpo, restantes = self.cenario(20, 5)
        self.assertEqual((restantes, "aviso" in corpo), (15, False))

    def test_6_que_sairam_pulam(self):
        corpo, restantes = self.cenario(20, 6)
        self.assertEqual(restantes, 20)
        self.assertIn("apagaria 6 senhas", corpo["aviso"])

    def test_2_de_4_apagam(self):
        corpo, restantes = self.cenario(4, 2)
        self.assertEqual((restantes, "aviso" in corpo), (2, False))

    def test_3_de_4_pulam(self):
        corpo, restantes = self.cenario(4, 3)
        self.assertEqual(restantes, 4)
        self.assertIn("(de 4 guardadas)", corpo["aviso"])

    def test_1_de_1_apaga(self):
        corpo, restantes = self.cenario(1, 1)
        self.assertEqual((restantes, "aviso" in corpo), (0, False))

    def test_finalizados_em_massa_apagam_sem_aviso(self):
        pasta = self.caminhos.existentes.parent
        nums = tuple(f"UTIC-2026-{n:04d}" for n in range(1, 11))
        for numero in nums:
            sebrae_credenciais.guardar(pasta, numero, DESCRICAO)
        status = ("FINALIZADO",) * 6 + ("EM ABERTO",) * 4
        resposta = self.importar(montar(chamados=nums, status=status, ultima=16))
        self.assertEqual(resposta.status_code, 200)
        self.assertNotIn("aviso", resposta.json())
        self.assertEqual(sebrae_credenciais.numeros(pasta), frozenset(nums[6:]))

    def test_saidas_em_massa_pulam_so_elas_e_a_importacao_repetida_nao_prende(self):
        pasta = self.caminhos.existentes.parent
        nums = tuple(f"UTIC-2026-{n:04d}" for n in range(1, 13))  # 12 senhas
        for numero in nums:
            sebrae_credenciais.guardar(pasta, numero, DESCRICAO)
        self.importar(montar(chamados=nums, status=("EM ABERTO",) * 12, ultima=18))
        # 6 somem da coluna C (0001..0006), 2 vêm FINALIZADO (0007, 0008), 4 seguem abertos (0009..0012)
        folha = nums[6:] + ("UTIC-2026-9999",)
        status = ("FINALIZADO", "FINALIZADO") + ("EM ABERTO",) * 5
        primeira = self.importar(montar(chamados=folha, status=status, ultima=13))
        self.assertEqual(primeira.status_code, 200)
        self.assertIn("apagaria 6 senhas", primeira.json()["aviso"])
        self.assertEqual(sebrae_credenciais.numeros(pasta), frozenset(nums[:6] + nums[8:]))  # só os FINALIZADO foram
        # 2ª importação igual: FINALIZADO já apagados e saídas já fora de abertos; nada a pular nem a avisar
        segunda = self.importar(montar(chamados=folha, status=status, ultima=13))
        self.assertEqual(segunda.status_code, 200)
        self.assertNotIn("aviso", segunda.json())
        self.assertEqual(sebrae_credenciais.numeros(pasta), frozenset(nums[:6] + nums[8:]))


class LimiteRemoverEncerradosTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def guardar(self, total):
        nums = [f"UTIC-2026-{n:04d}" for n in range(1, total + 1)]
        for numero in nums:
            sebrae_credenciais.guardar(self.dir, numero, DESCRICAO)
        return nums

    def sair(self, nums):
        """Os ``nums`` estavam abertos e a nova planilha não os traz (sem coluna C, por exemplo)."""
        return sebrae_credenciais.remover_encerrados(self.dir, {}, [{"numero": n} for n in nums])

    def test_mais_de_5_pula(self):
        nums = self.guardar(100)
        r = self.sair(nums[:6])
        self.assertEqual((r.pulado, r.apagadas, r.previstas_saida, r.guardadas), (True, 0, 6, 100))
        self.assertEqual(len(sebrae_credenciais.numeros(self.dir)), 100)

    def test_mais_de_50_por_cento_pula(self):
        nums = self.guardar(4)
        r = self.sair(nums[:3])
        self.assertTrue(r.pulado)
        self.assertEqual(len(sebrae_credenciais.numeros(self.dir)), 4)

    def test_dentro_do_limite_apaga(self):
        nums = self.guardar(4)
        r = self.sair(nums[:2])  # 50% nao e mais de 50%
        self.assertEqual((r.pulado, r.apagadas), (False, 2))
        self.assertEqual(len(sebrae_credenciais.numeros(self.dir)), 2)
        pasta2 = Path(tempfile.mkdtemp())
        for n in range(1, 21):
            sebrae_credenciais.guardar(pasta2, f"UTIC-2026-{n:04d}", DESCRICAO)
        r = sebrae_credenciais.remover_encerrados(pasta2, {}, [{"numero": f"UTIC-2026-{n:04d}"} for n in range(1, 6)])
        self.assertEqual((r.pulado, r.apagadas), (False, 5))  # 5 de 20

    def test_um_de_um_apaga(self):
        nums = self.guardar(1)
        r = self.sair(nums)
        self.assertEqual((r.pulado, r.apagadas), (False, 1))
        self.assertEqual(sebrae_credenciais.numeros(self.dir), frozenset())

    def test_conta_so_quem_tem_senha(self):
        nums = self.guardar(6)
        saindo = nums[:3] + [f"UTIC-2026-9{n:03d}" for n in range(20)]  # 20 abertos sem senha saem junto: nao contam
        r = self.sair(saindo)
        self.assertEqual((r.pulado, r.previstas_saida), (False, 3))

    def test_planilha_cortada_nao_apaga_nada(self):
        nums = self.guardar(3)
        r = self.sair(nums)  # planilha truncada: todo aberto "saiu"
        self.assertTrue(r.pulado)
        self.assertEqual(len(sebrae_credenciais.numeros(self.dir)), 3)

    def test_finalizado_apaga_sempre_mesmo_em_massa(self):
        nums = self.guardar(10)
        mapa = {n: {"status": "FINALIZADO"} for n in nums[:6]}
        mapa.update({n: {"status": "EM ABERTO"} for n in nums[6:]})
        r = sebrae_credenciais.remover_encerrados(self.dir, mapa, [])
        self.assertEqual((r.pulado, r.apagadas, r.previstas_saida), (False, 6, 0))
        self.assertEqual(sebrae_credenciais.numeros(self.dir), frozenset(nums[6:]))

    def test_trava_pula_so_os_que_sairam_e_apaga_os_finalizados(self):
        nums = self.guardar(20)
        mapa = {nums[0]: {"status": "FINALIZADO"}, nums[1]: {"status": "FINALIZADO"}}
        r = sebrae_credenciais.remover_encerrados(self.dir, mapa, [{"numero": n} for n in nums[2:9]])  # 7 saem
        self.assertEqual((r.pulado, r.apagadas, r.previstas_saida, r.guardadas), (True, 2, 7, 20))
        self.assertEqual(sebrae_credenciais.numeros(self.dir), frozenset(nums[2:]))

    def test_arquivo_ausente_nao_pula(self):
        r = self.sair(["UTIC-2026-0001"])
        self.assertEqual((r.pulado, r.apagadas, r.guardadas), (False, 0, 0))


class RotaCredenciaisTest(RotasBase):
    def test_lista_so_traz_o_sinal_e_a_rota_traz_o_valor_sem_cache(self):
        self.importar()
        chamado = ChamadoSoftExpert("UTIC-2026-1378", titulo="Acesso", descricao=DESCRICAO)
        sebrae_novos.salvar_novos(self.caminhos.novos, [chamado], [], 0, {})
        sebrae_credenciais.guardar(self.caminhos.existentes.parent, chamado.numero, DESCRICAO)
        lista = self.cliente.get("/api/sebrae/novos")
        self.assertNotIn("Abc12345", lista.text)
        self.assertTrue(lista.json()["novos"]["formulario"][0]["tem_credencial"])
        resposta = self.cliente.get("/api/sebrae/chamados/utic-2026-1378/credenciais")
        self.assertEqual(resposta.status_code, 200)
        self.assertEqual(resposta.json(), {"numero": "UTIC-2026-1378", "credenciais": ["Abc12345"]})
        self.assertEqual(resposta.headers["cache-control"], "no-store")
        self.assertEqual(self.cliente.get("/api/sebrae/chamados/x/credenciais").status_code, 422)

if __name__ == "__main__":
    unittest.main()
