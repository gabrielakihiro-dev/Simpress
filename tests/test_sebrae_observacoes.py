import json
import tempfile
import unittest
from pathlib import Path

from core.errors import DomainBusyError, DomainValidationError
from domains import sebrae_observacoes as obs


class SebraeObservacoesTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.state_dir = Path(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_validar_numero_observacao_utic_e_linha(self):
        self.assertEqual(obs.validar_numero_observacao("UTIC-2024-1234"), "UTIC-2024-1234")
        self.assertEqual(obs.validar_numero_observacao("utic-2025-9999"), "UTIC-2025-9999")
        self.assertEqual(obs.validar_numero_observacao("linha:1"), "linha:1")
        self.assertEqual(obs.validar_numero_observacao("linha:42"), "linha:42")

    def test_validar_numero_observacao_invalido(self):
        invalidos = [
            "",
            "   ",
            "LINHA:1",
            "linha:",
            "linha:abc",
            "UTIC-24-1",
            "UTIC-2024",
            "12345",
            None,
            "CHAMADO-1",
        ]
        for inv in invalidos:
            with self.subTest(numero=inv):
                with self.assertRaises(DomainValidationError) as ctx:
                    obs.validar_numero_observacao(inv)
                self.assertEqual(ctx.exception.status_code, 422)

    def test_validar_observacao_limpa_controles_e_formula(self):
        texto = "  Observação inicial\x00\x08 com quebra\r\ne mais texto.  "
        self.assertEqual(
            obs.validar_observacao(texto),
            "Observação inicial com quebra\ne mais texto.",
        )

        formulas = ["=SOMA(1,2)", "+12345", "-12345", "@ALGUMA_COISA"]
        for f in formulas:
            with self.subTest(formula=f):
                self.assertTrue(obs.validar_observacao(f).startswith("'"))

    def test_validar_observacao_mascara_cpfs_e_credenciais(self):
        texto = "Atendimento do CPF 123.456.789-00 com senha 123456."
        res = obs.validar_observacao(texto)
        self.assertNotIn("123.456.789-00", res)
        self.assertIn("***.***.***-**", res)

    def test_validar_observacao_limite_tamanho(self):
        obs.validar_observacao("a" * 4000)
        with self.assertRaises(DomainValidationError) as ctx:
            obs.validar_observacao("a" * 4001)
        self.assertEqual(ctx.exception.status_code, 422)

    def test_ler_observacoes_vazio_ou_inexistente(self):
        self.assertEqual(obs.ler_observacoes(self.state_dir), {})

    def test_ler_observacoes_arquivo_corrompido(self):
        arquivo = obs.caminho_observacoes(self.state_dir)
        arquivo.write_text("corrompido...", encoding="utf-8")
        with self.assertRaises(DomainBusyError):
            obs.ler_observacoes(self.state_dir)

    def test_ler_observacoes_estrutura_invalida(self):
        arquivo = obs.caminho_observacoes(self.state_dir)
        arquivo.write_text(json.dumps(["não", "um", "objeto"]), encoding="utf-8")
        with self.assertRaises(DomainBusyError):
            obs.ler_observacoes(self.state_dir)

        arquivo.write_text(json.dumps({"UTIC-2024-0001": "texto_direto"}), encoding="utf-8")
        with self.assertRaises(DomainBusyError):
            obs.ler_observacoes(self.state_dir)

    def test_salvar_e_ler_observacao(self):
        res1 = obs.salvar_observacao(self.state_dir, "UTIC-2024-0001", "Aguardando peça.")
        self.assertEqual(res1["numero"], "UTIC-2024-0001")
        self.assertEqual(res1["observacao"], "Aguardando peça.")
        self.assertTrue(res1["atualizado_em"])

        res2 = obs.salvar_observacao(self.state_dir, "linha:15", "Chamado legado sem UTIC.")
        self.assertEqual(res2["numero"], "linha:15")
        self.assertEqual(res2["observacao"], "Chamado legado sem UTIC.")

        lidas = obs.ler_observacoes(self.state_dir)
        self.assertEqual(lidas["UTIC-2024-0001"]["observacao"], "Aguardando peça.")
        self.assertEqual(lidas["linha:15"]["observacao"], "Chamado legado sem UTIC.")

    def test_salvar_observacao_vazia_remove_registro(self):
        obs.salvar_observacao(self.state_dir, "UTIC-2024-0001", "Texto temporário.")
        self.assertIn("UTIC-2024-0001", obs.ler_observacoes(self.state_dir))

        res = obs.salvar_observacao(self.state_dir, "UTIC-2024-0001", "")
        self.assertEqual(res["observacao"], "")
        self.assertNotIn("UTIC-2024-0001", obs.ler_observacoes(self.state_dir))

        # Salvar vazio em chave inexistente não falha
        res_novo_vazio = obs.salvar_observacao(self.state_dir, "linha:99", "   ")
        self.assertEqual(res_novo_vazio["observacao"], "")
        self.assertNotIn("linha:99", obs.ler_observacoes(self.state_dir))

    def test_ler_observacoes_devolve_campos_de_destaque_e_legado_vale_false(self):
        arquivo = obs.caminho_observacoes(self.state_dir)
        arquivo.write_text(json.dumps({"UTIC-2024-0001": {"observacao": "Antiga", "atualizado_em": "2026-01-01T10:00:00-03:00"}}), encoding="utf-8")
        self.assertEqual(obs.ler_observacoes(self.state_dir), {"UTIC-2024-0001": {
            "observacao": "Antiga", "atualizado_em": "2026-01-01T10:00:00-03:00", "destaque": False, "destaque_em": "",
        }})
        # salvar texto num arquivo legado não inventa destaque
        res = obs.salvar_observacao(self.state_dir, "UTIC-2024-0001", "Nova")
        self.assertFalse(res["destaque"])
        self.assertEqual(res["destaque_em"], "")

    def test_definir_destaque_marca_e_desmarca(self):
        res = obs.definir_destaque(self.state_dir, "utic-2024-0001", True)
        self.assertEqual(set(res), {"numero", "destaque", "destaque_em"})
        self.assertEqual(res["numero"], "UTIC-2024-0001")
        self.assertTrue(res["destaque"])
        self.assertTrue(res["destaque_em"])
        lida = obs.ler_observacoes(self.state_dir)["UTIC-2024-0001"]
        self.assertEqual((lida["observacao"], lida["destaque"], lida["destaque_em"]), ("", True, res["destaque_em"]))

        # marcar de novo mantém a data original
        self.assertEqual(obs.definir_destaque(self.state_dir, "UTIC-2024-0001", True)["destaque_em"], res["destaque_em"])

        res2 = obs.definir_destaque(self.state_dir, "UTIC-2024-0001", False)
        self.assertEqual((res2["destaque"], res2["destaque_em"]), (False, ""))
        self.assertNotIn("UTIC-2024-0001", obs.ler_observacoes(self.state_dir))  # sem texto, a entrada some

    def test_destaque_sobrevive_a_salvar_e_apagar_texto(self):
        obs.definir_destaque(self.state_dir, "linha:7", True)
        em = obs.ler_observacoes(self.state_dir)["linha:7"]["destaque_em"]

        res = obs.salvar_observacao(self.state_dir, "linha:7", "Importante.")
        self.assertEqual((res["destaque"], res["destaque_em"]), (True, em))
        res = obs.salvar_observacao(self.state_dir, "linha:7", "")
        self.assertTrue(res["destaque"])
        lida = obs.ler_observacoes(self.state_dir)["linha:7"]  # texto vazio, mas o destaque mantém a entrada
        self.assertEqual((lida["observacao"], lida["atualizado_em"], lida["destaque"], lida["destaque_em"]), ("", "", True, em))

    def test_texto_sobrevive_a_desmarcar_e_entrada_some_so_quando_vazia(self):
        obs.salvar_observacao(self.state_dir, "UTIC-2024-0002", "Anotação.")
        obs.definir_destaque(self.state_dir, "UTIC-2024-0002", True)
        obs.definir_destaque(self.state_dir, "UTIC-2024-0002", False)
        lida = obs.ler_observacoes(self.state_dir)["UTIC-2024-0002"]
        self.assertEqual((lida["observacao"], lida["destaque"], lida["destaque_em"]), ("Anotação.", False, ""))
        obs.salvar_observacao(self.state_dir, "UTIC-2024-0002", "")
        self.assertNotIn("UTIC-2024-0002", obs.ler_observacoes(self.state_dir))

    def test_chave_invalida_fica_fora_da_leitura_mas_nao_some_do_arquivo(self):
        arquivo = obs.caminho_observacoes(self.state_dir)
        manual = {"qualquer coisa": {"observacao": "à mão", "destaque": True}, "utic-2026-1": {"observacao": "minúscula", "destaque": True}}
        arquivo.write_text(json.dumps({**manual, "UTIC-2026-1": {"observacao": "ok", "destaque": True, "destaque_em": "x"}}), encoding="utf-8")
        self.assertEqual(list(obs.ler_observacoes(self.state_dir)), ["UTIC-2026-1"])
        obs.salvar_observacao(self.state_dir, "linha:3", "nova")
        obs.definir_destaque(self.state_dir, "UTIC-2026-1", False)
        gravado = json.loads(arquivo.read_text(encoding="utf-8"))
        self.assertEqual(gravado["qualquer coisa"], manual["qualquer coisa"])  # intacta, sem normalizar
        self.assertEqual(gravado["utic-2026-1"], manual["utic-2026-1"])
        self.assertEqual(gravado["UTIC-2026-1"]["destaque"], False)
        self.assertEqual(gravado["linha:3"]["observacao"], "nova")

    def test_definir_destaque_numero_invalido_e_arquivo_ilegivel(self):
        with self.assertRaises(DomainValidationError) as ctx:
            obs.definir_destaque(self.state_dir, "invalido", True)
        self.assertEqual(ctx.exception.status_code, 422)
        obs.caminho_observacoes(self.state_dir).write_text("corrompido...", encoding="utf-8")
        with self.assertRaises(DomainBusyError):
            obs.definir_destaque(self.state_dir, "UTIC-2024-0001", True)
        self.assertEqual(obs.caminho_observacoes(self.state_dir).read_text(encoding="utf-8"), "corrompido...")


class AcompanharChavesTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.state_dir = Path(self.temp_dir.name)
        self.arquivo = obs.caminho_observacoes(self.state_dir)

    def gravar(self, entradas):
        self.arquivo.write_text(json.dumps({chave: {"observacao": texto, "destaque": destaque} for chave, (texto, destaque) in entradas.items()}), encoding="utf-8")

    def lido(self):
        return {chave: (item["observacao"], item["destaque"]) for chave, item in json.loads(self.arquivo.read_text(encoding="utf-8")).items()}

    def test_move_a_entrada_inteira_e_nao_deixa_a_chave_antiga(self):
        self.gravar({"linha:3": ("Impressora", True), "UTIC-2026-0003": ("fica", False)})
        self.assertEqual(obs.acompanhar_chaves(self.state_dir, {"linha:3": "linha:2", "linha:4": "linha:3"}), [])
        self.assertEqual(self.lido(), {"linha:2": ("Impressora", True), "UTIC-2026-0003": ("fica", False)})

    def test_chaves_que_trocam_de_lugar_andam_juntas(self):
        self.gravar({"linha:3": ("A", False), "linha:4": ("B", True), "linha:5": ("C", False)})
        self.assertEqual(obs.acompanhar_chaves(self.state_dir, {"linha:3": "linha:4", "linha:4": "linha:3", "linha:5": "linha:6"}), [])
        self.assertEqual(self.lido(), {"linha:4": ("A", False), "linha:3": ("B", True), "linha:6": ("C", False)})

    def test_destino_ocupado_por_entrada_que_nao_sai_bloqueia_so_aquele_movimento(self):
        self.gravar({"linha:3": ("A", False), "linha:4": ("B", False), "linha:9": ("C", False)})
        mapa = {"linha:3": "linha:4", "linha:4": None, "linha:9": "linha:10"}
        self.assertEqual(obs.acompanhar_chaves(self.state_dir, mapa), ["linha:3", "linha:4"])  # 4 is unknown, so 3 cannot land on it
        self.assertEqual(self.lido(), {"linha:3": ("A", False), "linha:4": ("B", False), "linha:10": ("C", False)})

    def test_cadeia_bloqueada_inteira_fica_onde_estava(self):
        self.gravar({"linha:2": ("X", False), "linha:3": ("A", False), "linha:4": ("B", False)})
        self.assertEqual(obs.acompanhar_chaves(self.state_dir, {"linha:2": "linha:3", "linha:3": "linha:4", "linha:4": None}), ["linha:2", "linha:3", "linha:4"])
        self.assertEqual(self.lido(), {"linha:2": ("X", False), "linha:3": ("A", False), "linha:4": ("B", False)})

    def test_sem_mudanca_nao_cria_nem_regrava_o_arquivo(self):
        self.assertEqual(obs.acompanhar_chaves(self.state_dir, {"linha:3": "linha:2"}), [])
        self.assertFalse(self.arquivo.exists())
        self.gravar({"linha:3": ("A", False)})
        antes = self.arquivo.read_bytes()
        self.assertEqual(obs.acompanhar_chaves(self.state_dir, {"linha:3": "linha:3", "linha:8": "linha:9"}), [])
        self.assertEqual(self.arquivo.read_bytes(), antes)

    def test_entrada_de_chave_invalida_e_o_texto_original_nao_mudam(self):
        manual = {"qualquer coisa": {"observacao": "à mão", "destaque": True}}
        self.arquivo.write_text(json.dumps({**manual, "linha:3": {"observacao": "A", "destaque": False}}), encoding="utf-8")
        obs.acompanhar_chaves(self.state_dir, {"linha:3": "linha:2"})
        gravado = json.loads(self.arquivo.read_text(encoding="utf-8"))
        self.assertEqual(gravado["qualquer coisa"], manual["qualquer coisa"])
        self.assertEqual(gravado["linha:2"]["observacao"], "A")

    def test_arquivo_ilegivel_e_preservado(self):
        self.arquivo.write_text("corrompido...", encoding="utf-8")
        with self.assertRaises(DomainBusyError):
            obs.acompanhar_chaves(self.state_dir, {"linha:3": "linha:2"})
        self.assertEqual(self.arquivo.read_text(encoding="utf-8"), "corrompido...")


if __name__ == "__main__":
    unittest.main()
