"""Ligação da rotina Sebrae: adaptadores sobre as Fases B e C com módulos e grade falsos (sem Chrome, sem sistemas reais)."""

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

from domains import sebrae_orquestracao as orq
from domains.sebrae_chamados import COLUNAS_GRAVADAS, ChamadoSoftExpert
from scripts import sebrae_excel as xl
from scripts import sebrae_rotina as rotina
from tests.test_sebrae_excel import GradeFalsa, linha_valida


class RotinaErroFalsa(RuntimeError):
    pass


class RotinaCanceladaFalsa(BaseException):
    pass


class SoftExpertErroFalso(RotinaErroFalsa):
    motivo = "formulario_indisponivel"


class SessaoExpiradaFalsa(SoftExpertErroFalso):
    motivo = "sessao_expirada"


class NaoConfereFalso(SoftExpertErroFalso):
    motivo = "numero_nao_confere"


class NaoEncontradoFalso(SoftExpertErroFalso):
    motivo = "nao_encontrado_na_lista"


def chamado(numero: str, descricao: str = "A impressora não funciona") -> ChamadoSoftExpert:
    return ChamadoSoftExpert(numero, "Título", descricao, "Maria Souza", "21/10/2026 10:30")


class PaginaFalsa:
    def __init__(self) -> None:
        self.fechada = False
        self.destinos: List[str] = []

    def goto(self, url: str, **opcoes: Any) -> None:
        self.destinos.append(url)

    def is_closed(self) -> bool:
        return self.fechada

    def close(self) -> None:
        self.fechada = True


class ModuloSoftExpertFalso:
    SessaoExpirada = SessaoExpiradaFalsa
    ChamadoNaoConfere = NaoConfereFalso
    ChamadoNaoEncontrado = NaoEncontradoFalso
    SOFTEXPERT_URL = "https://softexpert.invalido/"

    def __init__(self, listados: Optional[List[str]] = None) -> None:
        self.listados: Any = listados or []
        self.chamados: Dict[str, ChamadoSoftExpert] = {}
        self.respostas: Dict[str, List[Any]] = {}  # number -> exceptions/values consumed in order
        self.relogins = 0
        self.abertas = 0
        self.abrir_erro: Optional[BaseException] = None

    def abrir_softexpert(self, context: Any) -> PaginaFalsa:
        self.abertas += 1
        if self.abrir_erro is not None:
            raise self.abrir_erro
        return PaginaFalsa()

    def coletar_numeros(self, page: Any) -> List[str]:
        if isinstance(self.listados, BaseException):
            raise self.listados
        return list(self.listados)

    def extrair_chamado(self, context: Any, page: Any, numero: str) -> ChamadoSoftExpert:
        fila = self.respostas.get(numero)
        if fila:
            item = fila.pop(0)
            if isinstance(item, BaseException):
                raise item
            return item  # type: ignore[no-any-return]
        return self.chamados[numero]

    def garantir_login(self, page: Any) -> None:
        self.relogins += 1


def rotinas_falsas(cancelado: bool = False) -> SimpleNamespace:
    avisos: List[tuple] = []
    return SimpleNamespace(
        RotinaErro=RotinaErroFalsa,
        RotinaCancelada=RotinaCanceladaFalsa,
        CARREGAMENTO_MS=1000,
        log=lambda origem, texto: None,
        avisar=lambda titulo, mensagem: avisos.append((titulo, mensagem)),
        avisos=avisos,
        agora_iso=lambda: "2026-10-21T10:00:00-03:00",
        cancelamento_pedido=lambda: cancelado,
    )


class TraducaoDeGravacaoTests(unittest.TestCase):
    def test_a_confirmed_row_is_an_inclusion_with_the_seven_columns(self):
        r = rotina.traduzir_gravacao(xl.ResultadoGravacao("UTIC-2026-0200", xl.GRAVADO, 12, tuple(COLUNAS_GRAVADAS)))
        self.assertTrue(r.completo)
        r = rotina.traduzir_gravacao(xl.ResultadoGravacao("UTIC-2026-0200", xl.RECUPERADO, 12))
        self.assertTrue(r.completo)

    def test_duplicate_is_ignored_and_invalid_row_is_pending(self):
        dup = rotina.traduzir_gravacao(xl.ResultadoGravacao("UTIC-2026-0200", xl.DUPLICADO))
        self.assertTrue(dup.duplicado)
        invalida = rotina.traduzir_gravacao(xl.ResultadoGravacao("UTIC-2026-0200", xl.INVALIDO, detalhe="x"))
        self.assertEqual(invalida.motivo_pendente, "gravacao_invalido")
        self.assertFalse(invalida.completo)

    def test_every_stopping_situation_carries_its_confirmed_cells_and_name(self):
        for situacao in (
            xl.PARCIAL, xl.DIVERGENTE, xl.NAO_SALVO, xl.LEITURA_INCOMPLETA,
            xl.FILTRO_NAO_RESTAURADO, xl.SEM_LINHA, xl.INTERROMPIDO,
        ):
            r = rotina.traduzir_gravacao(xl.ResultadoGravacao("UTIC-2026-0200", situacao, 12, ("C", "F")))
            self.assertFalse(r.completo, situacao)
            self.assertEqual((r.confirmados, r.erro, r.salvo), (("C", "F"), situacao, False))

    def test_expired_session_becomes_a_login_request(self):
        with self.assertRaises(orq.LoginNecessarioErro) as ctx:
            rotina.traduzir_gravacao(xl.ResultadoGravacao("UTIC-2026-0200", xl.SESSAO_EXPIRADA))
        self.assertEqual(ctx.exception.sistema, "SharePoint")


class LeitorSoftExpertTests(unittest.TestCase):
    def leitor(self, modulo: ModuloSoftExpertFalso) -> rotina.LeitorSoftExpertReal:
        return rotina.LeitorSoftExpertReal(object(), rotinas_falsas(), modulo=modulo)  # type: ignore[arg-type]

    def test_the_tab_opens_once_and_the_list_is_returned(self):
        modulo = ModuloSoftExpertFalso(["UTIC-2026-0001", "UTIC-2026-0002"])
        leitor = self.leitor(modulo)
        self.assertEqual(list(leitor.listar_numeros()), ["UTIC-2026-0001", "UTIC-2026-0002"])
        leitor.listar_numeros()
        self.assertEqual(modulo.abertas, 1)

    def test_expired_session_in_the_list_is_a_login_request(self):
        modulo = ModuloSoftExpertFalso()
        modulo.listados = SessaoExpiradaFalsa("caiu")
        with self.assertRaises(orq.LoginNecessarioErro) as ctx:
            self.leitor(modulo).listar_numeros()
        self.assertEqual(ctx.exception.sistema, "SoftExpert")

    def test_a_login_wait_that_ran_out_is_a_login_request(self):
        modulo = ModuloSoftExpertFalso()
        modulo.abrir_erro = RotinaErroFalsa("Login não concluído em 10 minutos.")
        with self.assertRaises(orq.LoginNecessarioErro):
            self.leitor(modulo).listar_numeros()

    def test_other_runner_errors_pass_through(self):
        modulo = ModuloSoftExpertFalso()
        modulo.listados = RotinaErroFalsa("outro problema")
        with self.assertRaises(RotinaErroFalsa):
            self.leitor(modulo).listar_numeros()

    def test_the_runner_cancellation_becomes_the_domain_cancellation(self):
        modulo = ModuloSoftExpertFalso()
        modulo.listados = RotinaCanceladaFalsa()
        with self.assertRaises(orq.CancelamentoSolicitado):
            self.leitor(modulo).listar_numeros()

    def test_a_ticket_that_does_not_match_or_is_missing_is_unavailable_with_its_reason(self):
        modulo = ModuloSoftExpertFalso()
        modulo.respostas = {"UTIC-2026-0001": [NaoConfereFalso("x")], "UTIC-2026-0002": [NaoEncontradoFalso("y")]}
        leitor = self.leitor(modulo)
        with self.assertRaises(orq.ChamadoIndisponivelErro) as a:
            leitor.ler_chamado("UTIC-2026-0001")
        self.assertEqual(a.exception.motivo, "numero_nao_confere")
        with self.assertRaises(orq.ChamadoIndisponivelErro) as b:
            leitor.ler_chamado("UTIC-2026-0002")
        self.assertEqual(b.exception.motivo, "nao_encontrado_na_lista")

    def test_an_expired_session_waits_for_the_login_and_reads_the_ticket_again(self):
        modulo = ModuloSoftExpertFalso()
        modulo.respostas = {"UTIC-2026-0001": [SessaoExpiradaFalsa("caiu"), chamado("UTIC-2026-0001")]}
        lido = self.leitor(modulo).ler_chamado("UTIC-2026-0001")
        self.assertEqual(lido.numero, "UTIC-2026-0001")
        self.assertEqual(modulo.relogins, 1)

    def test_a_second_expiry_is_a_login_request(self):
        modulo = ModuloSoftExpertFalso()
        modulo.respostas = {"UTIC-2026-0001": [SessaoExpiradaFalsa("a"), SessaoExpiradaFalsa("b")]}
        with self.assertRaises(orq.LoginNecessarioErro):
            self.leitor(modulo).ler_chamado("UTIC-2026-0001")

    def test_an_unexpected_confirmation_is_not_hidden(self):
        modulo = ModuloSoftExpertFalso()
        modulo.respostas = {"UTIC-2026-0001": [SoftExpertErroFalso("confirmacao_inesperada")]}
        with self.assertRaises(SoftExpertErroFalso):
            self.leitor(modulo).ler_chamado("UTIC-2026-0001")

    def test_close_closes_the_tab_it_opened(self):
        modulo = ModuloSoftExpertFalso(["UTIC-2026-0001"])
        leitor = self.leitor(modulo)
        leitor.listar_numeros()
        pagina = leitor.pagina
        leitor.fechar()
        self.assertTrue(pagina.fechada)  # type: ignore[union-attr]


class DashboardRealTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix=".sebrae-rotina-test-")
        self.addCleanup(self.temp.cleanup)
        self.diario = xl.DiarioGravacao(Path(self.temp.name) / "diario.json")
        self.grade = GradeFalsa(self.diario)

    def dashboard(self, grade: Optional[GradeFalsa] = None) -> rotina.DashboardReal:
        configuracao = rotina.Configuracao("https://exemplo.invalido/dashboard", ("A", "R"))
        return rotina.DashboardReal(None, rotinas_falsas(), configuracao, adaptador=grade or self.grade)

    def test_reads_every_value_of_column_c_including_composite_cells(self):
        valores = list(self.dashboard().ler_coluna_c())
        self.assertIn("27371 / UTIC-2026-0094", valores)
        self.assertIn("UTIC-2026-0002", valores)

    def test_a_filtered_read_is_refused_instead_of_returned(self):
        self.grade.leitura_so_visiveis = True
        with self.assertRaises(xl.LeituraIncompletaErro):
            self.dashboard().ler_coluna_c()

    def test_expired_session_is_a_login_request(self):
        self.grade.sessao_expirada = True
        with self.assertRaises(orq.LoginNecessarioErro) as ctx:
            self.dashboard().ler_coluna_c()
        self.assertEqual(ctx.exception.sistema, "SharePoint")

    def test_writes_only_the_seven_columns_and_reports_the_inclusion(self):
        r = self.dashboard().gravar_linha(linha_valida())
        self.assertTrue(r.completo)
        self.assertEqual([c for _l, c, _v in self.grade.escritas], list(COLUNAS_GRAVADAS))

    def test_a_ticket_that_appeared_meanwhile_is_reported_as_duplicate(self):
        self.grade.celulas[(12, "C")] = "UTIC-2026-0200"
        r = self.dashboard().gravar_linha(linha_valida())
        self.assertTrue(r.duplicado)
        self.assertEqual(self.grade.escritas, [])

    def test_unsaved_row_is_reported_with_the_reason(self):
        self.grade.salvo = False
        r = self.dashboard().gravar_linha(linha_valida())
        self.assertFalse(r.completo)
        self.assertEqual(r.erro, xl.NAO_SALVO)

    def _outra_execucao(self) -> GradeFalsa:
        retomada = GradeFalsa(self.diario)
        retomada.celulas = self.grade.celulas
        retomada.ocultas = self.grade.ocultas
        return retomada

    def test_the_journal_is_finished_before_the_first_read(self):
        # A write that fell halfway in an earlier run: the next run completes it before reading column C.
        self.grade.falha_na_escrita = (3, RuntimeError("queda"))
        self.assertFalse(self.grade.gravar_chamado(linha_valida()).incluido)
        retomada = self._outra_execucao()
        valores = list(self.dashboard(retomada).ler_coluna_c())
        self.assertIn("UTIC-2026-0200", valores)
        self.assertTrue(all(retomada.celulas.get((12, c)) for c in COLUNAS_GRAVADAS))
        self.assertEqual(self.diario.abertas(), {})

    def test_a_journal_that_cannot_be_finished_stops_the_run(self):
        self.grade.falha_na_escrita = (3, RuntimeError("queda"))
        self.grade.gravar_chamado(linha_valida())
        retomada = self._outra_execucao()
        retomada.celulas[(12, "G")] = "Outra pessoa"
        with self.assertRaises(rotina.RecuperacaoInterrompidaErro):
            self.dashboard(retomada).ler_coluna_c()


class ConfiguracaoTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.caminho = Path(self.temp.name) / "sebrae_config.json"

    def escrever(self, dados: Any) -> None:
        self.caminho.write_text(json.dumps(dados), encoding="utf-8")

    def test_valid_file(self):
        self.escrever({"dashboard_url": "https://sebrae.sharepoint.com/x/Operacional_SEBRAE.xlsx", "colunas_formula": ["A", "R"]})
        cfg = rotina.carregar_configuracao(self.caminho)
        self.assertEqual((cfg.colunas_formula, cfg.quebras_como_espaco), (("A", "R"), False))

    def test_empty_formula_list_is_an_explicit_choice(self):
        self.escrever({"dashboard_url": "https://sebrae.sharepoint.com/x", "colunas_formula": []})
        self.assertEqual(rotina.carregar_configuracao(self.caminho).colunas_formula, ())

    def test_missing_file_asks_for_the_setup(self):
        with self.assertRaisesRegex(rotina.ConfiguracaoSebraeErro, "Falta sebrae_config.json"):
            rotina.carregar_configuracao(self.caminho)

    def test_rejects_bad_values(self):
        casos: List[Any] = [
            {"colunas_formula": []},
            {"dashboard_url": "http://sebrae.sharepoint.com/x", "colunas_formula": []},
            {"dashboard_url": "https://user:senha@sebrae.sharepoint.com/x", "colunas_formula": []},
            {"dashboard_url": "https://login.microsoftonline.com/x", "colunas_formula": []},
            {"dashboard_url": "https://sebrae.sharepoint.com/x"},
            {"dashboard_url": "https://sebrae.sharepoint.com/x", "colunas_formula": ["a1"]},
            {"dashboard_url": "https://sebrae.sharepoint.com/x", "colunas_formula": "A"},
            [],
        ]
        for dados in casos:
            self.escrever(dados)
            with self.assertRaises(rotina.ConfiguracaoSebraeErro, msg=str(dados)):
                rotina.carregar_configuracao(self.caminho)
        self.caminho.write_text("{ quebrado", encoding="utf-8")
        with self.assertRaises(rotina.ConfiguracaoSebraeErro):
            rotina.carregar_configuracao(self.caminho)


class ExecutarTests(unittest.TestCase):
    EXISTENTES = ["UTIC-2026-0002", "UTIC-2026-0094"]  # 0094 sits inside a composite cell of the fake grid

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix=".sebrae-rotina-test-")
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.estado = base / "sebrae_chamados_estado.json"
        self.config = base / "sebrae_config.json"
        self.config.write_text(
            json.dumps({"dashboard_url": "https://sebrae.sharepoint.com/x", "colunas_formula": ["A", "R"]}), encoding="utf-8"
        )
        self.grade = GradeFalsa(xl.DiarioGravacao(base / "diario.json"))
        self.modulo = ModuloSoftExpertFalso(self.EXISTENTES + ["UTIC-2026-0200", "UTIC-2026-1253"])
        self.modulo.chamados = {"UTIC-2026-0200": chamado("UTIC-2026-0200")}

    def montar(self, rotinas: SimpleNamespace) -> Dict[str, Any]:
        configuracao = rotina.carregar_configuracao(self.config)
        return {
            "softexpert": rotina.LeitorSoftExpertReal(object(), rotinas, modulo=self.modulo),  # type: ignore[arg-type]
            "dashboard": rotina.DashboardReal(None, rotinas, configuracao, adaptador=self.grade),
        }

    def rodar(self, rotinas: SimpleNamespace, **adaptadores: Any) -> int:
        return rotina.executar(
            object(), rotinas,  # type: ignore[arg-type]
            caminho_estado=self.estado, caminho_config=self.config, **(adaptadores or self.montar(rotinas)),
        )

    def estado_salvo(self) -> Dict[str, Any]:
        return json.loads(self.estado.read_text(encoding="utf-8"))  # type: ignore[no-any-return]

    def test_full_run_writes_only_the_new_ticket_and_keeps_known_pending_ones(self):
        rotinas = rotinas_falsas()
        self.assertEqual(self.rodar(rotinas), 0)
        self.assertEqual({(l, c) for l, c, _v in self.grade.escritas}, {(12, c) for c in COLUNAS_GRAVADAS})
        self.assertEqual(self.grade.celulas[(12, "C")], "UTIC-2026-0200")
        execucao = self.estado_salvo()["ultima_execucao"]
        self.assertEqual(
            (execucao["situacao"], execucao["incluidos"], execucao["ignorados"], execucao["pendentes"]), ("concluida", 1, 2, 1)
        )
        self.assertEqual(set(self.estado_salvo()["pendencias"]), {"UTIC-2026-1253"})
        self.assertEqual(len(rotinas.avisos), 1)
        self.assertIn("1 chamado(s) novo(s)", rotinas.avisos[0][1])

    def test_the_second_run_adds_nothing_and_stays_silent(self):
        self.rodar(rotinas_falsas())
        escritas = len(self.grade.escritas)
        rotinas = rotinas_falsas()
        self.assertEqual(self.rodar(rotinas), 0)
        self.assertEqual(len(self.grade.escritas), escritas)
        self.assertEqual(rotinas.avisos, [])

    def test_expired_softexpert_login_returns_failure_and_notifies(self):
        self.modulo.listados = SessaoExpiradaFalsa("caiu")
        rotinas = rotinas_falsas()
        self.assertEqual(self.rodar(rotinas), 1)
        self.assertTrue(self.estado_salvo()["login_necessario"])
        self.assertEqual(self.grade.escritas, [])
        self.assertIn("SoftExpert", rotinas.avisos[0][1])

    def test_cancellation_keeps_state_and_raises_the_runner_cancellation(self):
        with self.assertRaises(RotinaCanceladaFalsa):
            self.rodar(rotinas_falsas(cancelado=True))
        self.assertEqual(self.estado_salvo()["ultima_execucao"]["situacao"], "cancelada")
        self.assertEqual(self.grade.escritas, [])

    def test_missing_configuration_fails_before_opening_anything(self):
        self.config.unlink()
        rotinas = rotinas_falsas()
        with self.assertRaises(RotinaErroFalsa):
            rotina.executar(object(), rotinas, caminho_estado=self.estado, caminho_config=self.config)  # type: ignore[arg-type]
        self.assertEqual(self.modulo.abertas, 0)
        self.assertEqual(len(rotinas.avisos), 1)
        self.assertFalse(self.estado.exists())

    def test_tabs_are_closed_unless_the_user_has_to_sign_in(self):
        rotinas = rotinas_falsas()
        adaptadores = self.montar(rotinas)
        self.rodar(rotinas, **adaptadores)
        self.assertTrue(adaptadores["softexpert"].pagina.fechada)

        self.modulo.listados = SessaoExpiradaFalsa("caiu")
        adaptadores = self.montar(rotinas)
        adaptadores["softexpert"].pagina = PaginaFalsa()
        self.rodar(rotinas, **adaptadores)
        self.assertFalse(adaptadores["softexpert"].pagina.fechada)


if __name__ == "__main__":
    unittest.main()
