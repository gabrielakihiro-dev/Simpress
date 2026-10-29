import tempfile
import types
import unittest
from pathlib import Path

from domains import sebrae_historico, sebrae_novos
from domains.sebrae_chamados import ChamadoSoftExpert
from scripts import sebrae_leitura


class SoftExpertErro(Exception):
    pass


class SessaoExpirada(SoftExpertErro):
    pass


class ChamadoNaoConfere(SoftExpertErro):
    pass


class ChamadoNaoEncontrado(SoftExpertErro):
    pass


class Aba:
    def is_closed(self):
        return getattr(self, "fechada", False)

    def close(self):
        self.fechada = True


def item(numero, titulo):
    return types.SimpleNamespace(numero=numero, texto=f"{numero} {titulo}")


class Rotinas:
    class RotinaErro(RuntimeError):
        pass

    CARREGAMENTO_MS = 1

    def __init__(self):
        self.logs = []
        self.cancelar_em = None

    def agora_iso(self):
        return "agora"

    def log(self, origem, texto):
        self.logs.append(texto)

    def verificar_cancelamento(self, detalhe=""):
        if self.cancelar_em and self.cancelar_em in detalhe:
            raise KeyboardInterrupt


def modulo(itens, leituras, aba):
    chamadas = []

    def extrair(contexto, pagina, numero):
        chamadas.append(numero)
        resultado = leituras[numero]
        if isinstance(resultado, list):  # one result per attempt
            resultado = resultado.pop(0)
        if isinstance(resultado, Exception):
            raise resultado
        return resultado

    return types.SimpleNamespace(
        SoftExpertErro=SoftExpertErro, SessaoExpirada=SessaoExpirada, ChamadoNaoConfere=ChamadoNaoConfere,
        ChamadoNaoEncontrado=ChamadoNaoEncontrado, SOFTEXPERT_URL="https://x", chamadas=chamadas,
        abrir_softexpert=lambda contexto: aba, listar_chamados=lambda pagina: itens, extrair_chamado=extrair,
        garantir_login=lambda pagina, permitir_sso=False: None,
    )


class LeituraTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.caminhos = sebrae_novos.caminhos_padrao(self.dir)
        self.rotinas = Rotinas()
        self.aba = Aba()

    def rodar(self, itens, leituras):
        mod = modulo(itens, leituras, self.aba)
        codigo = sebrae_leitura.executar(None, self.rotinas, state_dir=self.dir, modulo=mod)
        return codigo, mod

    def test_sem_dashboard_importado_recusa_antes_de_abrir_o_softexpert(self):
        mod = modulo([], {}, self.aba)
        with self.assertRaisesRegex(Rotinas.RotinaErro, "Importe o Dashboard"):
            sebrae_leitura.executar(None, self.rotinas, state_dir=self.dir, modulo=mod)
        self.assertFalse(getattr(self.aba, "fechada", False))

    def test_le_so_os_novos_e_registra_alertas_ignorados_e_erros(self):
        sebrae_novos.salvar_existentes(self.caminhos.existentes, ["UTIC-2026-0001"], "d.xlsx")
        itens = [
            item("UTIC-2026-0001", "Já lançado"),
            item("UTIC-2026-0002", "Teclado"),
            item("UTIC-2026-0003", "Endpoint Central - Computer(s) Added"),
            item("UTIC-2026-0004", "Sumiu"),
        ]
        leituras = {
            "UTIC-2026-0002": ChamadoSoftExpert("UTIC-2026-0002", titulo="Teclado", solicitante="Ana"),
            "UTIC-2026-0004": ChamadoNaoEncontrado("não achei"),
        }
        codigo, mod = self.rodar(itens, leituras)
        self.assertEqual((codigo, mod.chamadas), (0, ["UTIC-2026-0002", "UTIC-2026-0004"]))
        salvo = sebrae_novos.ler_novos(self.caminhos.novos)
        self.assertEqual([c.numero for c in salvo["chamados"]], ["UTIC-2026-0002"])
        self.assertEqual((salvo["ignorados"], [p["numero"] for p in salvo["pendentes"]]), (1, ["UTIC-2026-0003"]))
        self.assertEqual(salvo["erros"], {"UTIC-2026-0004": "não achei"})
        self.assertTrue(self.aba.fechada)

    def test_falha_do_formulario_tenta_de_novo_uma_vez(self):
        sebrae_novos.salvar_existentes(self.caminhos.existentes, ["UTIC-2026-0001"], "d.xlsx")
        leituras = {"UTIC-2026-0002": [SoftExpertErro("não abriu"), ChamadoSoftExpert("UTIC-2026-0002")]}
        codigo, mod = self.rodar([item("UTIC-2026-0002", "x")], leituras)
        self.assertEqual(mod.chamadas, ["UTIC-2026-0002", "UTIC-2026-0002"])
        self.assertEqual(len(sebrae_novos.ler_novos(self.caminhos.novos)["chamados"]), 1)

    def test_falha_persistente_vira_erro_do_chamado_sem_derrubar_a_rotina(self):
        sebrae_novos.salvar_existentes(self.caminhos.existentes, ["UTIC-2026-0001"], "d.xlsx")
        leituras = {"UTIC-2026-0002": [SoftExpertErro("a"), SoftExpertErro("b")]}
        self.rodar([item("UTIC-2026-0002", "x")], leituras)
        self.assertEqual(sebrae_novos.ler_novos(self.caminhos.novos)["erros"], {"UTIC-2026-0002": "b"})

    def test_cancelamento_mantem_o_que_ja_foi_lido_e_fecha_a_aba(self):
        sebrae_novos.salvar_existentes(self.caminhos.existentes, ["UTIC-2026-0001"], "d.xlsx")
        self.rotinas.cancelar_em = "UTIC-2026-0003"
        leituras = {n: ChamadoSoftExpert(n) for n in ("UTIC-2026-0002", "UTIC-2026-0003")}
        with self.assertRaises(KeyboardInterrupt):
            self.rodar([item(n, "x") for n in leituras], leituras)
        self.assertEqual([c.numero for c in sebrae_novos.ler_novos(self.caminhos.novos)["chamados"]], ["UTIC-2026-0002"])
        self.assertTrue(self.aba.fechada)

    def buscas(self):
        return [i for i in sebrae_historico.listar(self.caminhos.historico)["itens"] if i["tipo"] == "busca"]

    def test_busca_entra_no_historico_so_com_numeros(self):
        sebrae_novos.salvar_existentes(self.caminhos.existentes, ["UTIC-2026-0001"], "d.xlsx")
        itens = [
            item("UTIC-2026-0001", "Já lançado"),
            item("UTIC-2026-0002", "Teclado"),
            item("UTIC-2026-0003", "Endpoint Central - Computer(s) Added"),
            item("UTIC-2026-0004", "Sumiu"),
        ]
        leituras = {
            "UTIC-2026-0002": ChamadoSoftExpert("UTIC-2026-0002", titulo="Teclado", solicitante="Ana"),
            "UTIC-2026-0004": ChamadoNaoEncontrado("não achei"),
        }
        self.rodar(itens, leituras)
        (busca,) = self.buscas()
        self.assertEqual((busca["n_lidos"], busca["ignorados"], busca["n_pendentes"], busca["n_erros"]), (1, 1, 1, 1))
        detalhe = sebrae_historico.obter(self.caminhos.historico, busca["id"])
        self.assertEqual((detalhe["lidos"], detalhe["pendentes"], detalhe["erros"]),
                         (["UTIC-2026-0002"], ["UTIC-2026-0003"], ["UTIC-2026-0004"]))
        texto = self.caminhos.historico.read_text(encoding="utf-8")
        self.assertNotIn("Teclado", texto)
        self.assertNotIn("não achei", texto)

    def test_cancelamento_ainda_registra_o_que_a_busca_leu(self):
        sebrae_novos.salvar_existentes(self.caminhos.existentes, ["UTIC-2026-0001"], "d.xlsx")
        self.rotinas.cancelar_em = "UTIC-2026-0003"
        leituras = {n: ChamadoSoftExpert(n) for n in ("UTIC-2026-0002", "UTIC-2026-0003")}
        with self.assertRaises(KeyboardInterrupt):
            self.rodar([item(n, "x") for n in leituras], leituras)
        (busca,) = self.buscas()
        self.assertEqual(sebrae_historico.obter(self.caminhos.historico, busca["id"])["lidos"], ["UTIC-2026-0002"])

    def test_sessao_expirada_na_lista_nao_registra_busca(self):
        sebrae_novos.salvar_existentes(self.caminhos.existentes, ["UTIC-2026-0001"], "d.xlsx")
        mod = modulo([], {}, self.aba)
        mod.listar_chamados = lambda pagina: (_ for _ in ()).throw(SessaoExpirada("login"))
        with self.assertRaises(Rotinas.RotinaErro):
            sebrae_leitura.executar(None, self.rotinas, state_dir=self.dir, modulo=mod)
        self.assertFalse(self.caminhos.historico.exists())

    def test_historico_ilegivel_nao_derruba_a_busca_nem_e_sobrescrito(self):
        sebrae_novos.salvar_existentes(self.caminhos.existentes, ["UTIC-2026-0001"], "d.xlsx")
        self.caminhos.historico.write_text("{ quebrado", encoding="utf-8")
        leituras = {"UTIC-2026-0002": ChamadoSoftExpert("UTIC-2026-0002")}
        codigo, _ = self.rodar([item("UTIC-2026-0002", "x")], leituras)
        self.assertEqual(codigo, 0)
        self.assertEqual(len(sebrae_novos.ler_novos(self.caminhos.novos)["chamados"]), 1)
        self.assertEqual(self.caminhos.historico.read_text(encoding="utf-8"), "{ quebrado")
        self.assertTrue(any("Histórico não gravado (HistoricoIlegivel)" in t for t in self.rotinas.logs))

    def test_sessao_expirada_na_lista_pede_login(self):
        sebrae_novos.salvar_existentes(self.caminhos.existentes, ["UTIC-2026-0001"], "d.xlsx")
        mod = modulo([], {}, self.aba)

        def cai(pagina):
            raise SessaoExpirada("login")

        mod.listar_chamados = cai
        with self.assertRaisesRegex(Rotinas.RotinaErro, "Login não concluído"):
            sebrae_leitura.executar(None, self.rotinas, state_dir=self.dir, modulo=mod)


if __name__ == "__main__":
    unittest.main()
