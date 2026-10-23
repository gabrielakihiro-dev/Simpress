"""Orchestration of the Sebrae sync with fake SoftExpert and Dashboard adapters (no browser, no real data)."""

import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional
from unittest.mock import patch

from domains import sebrae_orquestracao as orq
from domains.sebrae_agendamento import FUSO, AgendadorSebrae, caminhos_padrao
from domains.sebrae_chamados import COLUNAS_GRAVADAS, ChamadoSoftExpert, ResumoExecucao
from domains.sebrae_orquestracao import (
    CancelamentoSolicitado,
    LoginNecessarioErro,
    ResultadoGravacao,
    sincronizar,
)

EXISTENTES = [f"UTIC-2026-{numero:04d}" for numero in range(1, 31)]  # the 30 rows already in the Dashboard
INCIDENTE = "A impressora não funciona desde ontem."
SOLICITACAO = "Solicito acesso ao sistema financeiro."


def chamado(numero: str, descricao: str = INCIDENTE, **campos: str) -> ChamadoSoftExpert:
    dados = {"titulo": "Título", "descricao": descricao, "solicitante": "Maria Souza", "habilitada_em": "21/10/2026 10:30"}
    dados.update(campos)
    return ChamadoSoftExpert(numero=numero, **dados)


class ErroComMotivo(RuntimeError):
    def __init__(self, motivo: str) -> None:
        super().__init__("texto da confirmação não deve ser registrado")
        self.motivo = motivo


class SoftExpertFalso:
    def __init__(self, chamados: Iterable[ChamadoSoftExpert], listados: Optional[List[str]] = None) -> None:
        self.chamados: Dict[str, ChamadoSoftExpert] = {item.numero: item for item in chamados}
        self.listados = listados if listados is not None else list(self.chamados)
        self.lidos: List[str] = []
        self.erro_listagem: Optional[BaseException] = None
        self.erros: Dict[str, BaseException] = {}
        self.ao_ler: Optional[Callable[[str], None]] = None

    def listar_numeros(self) -> List[str]:
        if self.erro_listagem is not None:
            raise self.erro_listagem
        return list(self.listados)

    def ler_chamado(self, numero: str) -> ChamadoSoftExpert:
        self.lidos.append(numero)
        if self.ao_ler is not None:
            self.ao_ler(numero)
        if numero in self.erros:
            raise self.erros[numero]
        return self.chamados[numero]


class DashboardFalso:
    def __init__(self, coluna_c: Optional[List[Any]] = None) -> None:
        self.coluna_c: List[Any] = list(EXISTENTES if coluna_c is None else coluna_c)
        self.linhas: List[Dict[str, str]] = []
        self.chamadas_gravar: List[Mapping[str, str]] = []
        self.leituras = 0
        self.erro_leitura: Optional[BaseException] = None
        self.erro_leitura_apos_gravar: Optional[BaseException] = None
        self.erro_gravar: Dict[str, BaseException] = {}
        self.resultado_forcado: Dict[str, ResultadoGravacao] = {}
        self.antes_de_gravar: Optional[Callable[[str], None]] = None
        self.depois_de_gravar: Optional[Callable[[str], None]] = None
        self.nao_persistir: set = set()  # accepted by the writer but never visible in column C
        self.duplicar: set = set()  # written twice (another writer)

    def ler_coluna_c(self) -> List[Any]:
        self.leituras += 1
        if self.erro_leitura is not None:
            raise self.erro_leitura
        if self.erro_leitura_apos_gravar is not None and self.chamadas_gravar:
            raise self.erro_leitura_apos_gravar
        return list(self.coluna_c)

    def gravar_linha(self, linha: Mapping[str, str]) -> ResultadoGravacao:
        numero = linha["C"]
        self.chamadas_gravar.append(dict(linha))
        if self.antes_de_gravar:
            self.antes_de_gravar(numero)
        if numero in self.erro_gravar:
            raise self.erro_gravar[numero]
        if numero in self.resultado_forcado:
            return self.resultado_forcado[numero]
        assert numero not in self.coluna_c, "the writer must never overwrite an existing row"
        self.linhas.append(dict(linha))
        if numero not in self.nao_persistir:
            self.coluna_c.append(numero)
            if numero in self.duplicar:
                self.coluna_c.append(numero)
        if self.depois_de_gravar:
            self.depois_de_gravar(numero)
        return ResultadoGravacao(numero, tuple(COLUNAS_GRAVADAS), True)


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.estado = Path(self._tmp.name) / "state" / "sebrae_chamados_estado.json"
        self.tempo = datetime(2026, 10, 21, 10, 0, tzinfo=FUSO)
        self.cancelar = False

    def rodar(self, softexpert: SoftExpertFalso, dashboard: DashboardFalso, **opcoes: Any) -> orq.ResultadoOrquestracao:
        opcoes.setdefault("cancelado", lambda: self.cancelar)
        opcoes.setdefault("agora", lambda: self.tempo)
        return sincronizar(softexpert, dashboard, self.estado, **opcoes)

    def ler_estado(self) -> Dict[str, Any]:
        return json.loads(self.estado.read_text(encoding="utf-8"))

    def lista_com(self, *novos: ChamadoSoftExpert, extras: Iterable[str] = ()) -> SoftExpertFalso:
        """A SoftExpert list with the 30 existing tickets, the new ones and any extra numbers."""
        itens = [chamado(numero) for numero in EXISTENTES] + list(novos)
        return SoftExpertFalso(itens, listados=EXISTENTES + [item.numero for item in novos] + list(extras))


class FluxoCompletoTests(Base):
    def test_includes_only_new_tickets_and_keeps_the_30_existing_rows(self):
        softexpert = self.lista_com(chamado("UTIC-2026-0101"), chamado("UTIC-2026-0102", SOLICITACAO))
        dashboard = DashboardFalso()
        resultado = self.rodar(softexpert, dashboard)
        self.assertEqual(resultado.situacao, orq.SITUACAO_CONCLUIDA)
        self.assertEqual((resultado.resumo.incluidos, resultado.resumo.ignorados, resultado.resumo.pendentes), (2, 30, 0))
        self.assertEqual(resultado.codigo_saida, 0)
        self.assertEqual([linha["C"] for linha in dashboard.linhas], ["UTIC-2026-0101", "UTIC-2026-0102"])
        self.assertEqual(dashboard.linhas[0]["H"], "INCIDENTE")
        self.assertEqual(dashboard.linhas[1]["H"], "SOLICITAÇÃO")
        self.assertEqual(dashboard.coluna_c[:30], EXISTENTES)
        # The 30 duplicates were never opened.
        self.assertEqual(softexpert.lidos, ["UTIC-2026-0101", "UTIC-2026-0102"])

    def test_only_the_seven_columns_are_ever_handed_to_the_writer(self):
        dashboard = DashboardFalso()
        self.rodar(self.lista_com(chamado("UTIC-2026-0101")), dashboard)
        self.assertEqual(len(dashboard.chamadas_gravar), 1)
        linha = dashboard.chamadas_gravar[0]
        self.assertEqual(sorted(linha), sorted(COLUNAS_GRAVADAS))
        self.assertEqual(linha["M"], "Sebrae")
        self.assertEqual(linha["O"], "PR")
        self.assertEqual(linha["P"], "21/10/2026 10:30")
        self.assertEqual(linha["G"], "Maria Souza")

    def test_a_number_already_in_column_c_is_ignored_whole_even_inside_composite_values(self):
        dashboard = DashboardFalso(["27371 / UTIC-2026-0094", "utic-2026-0095"])
        softexpert = SoftExpertFalso([chamado("UTIC-2026-0094"), chamado("UTIC-2026-0095")])
        resultado = self.rodar(softexpert, dashboard)
        self.assertEqual((resultado.resumo.incluidos, resultado.resumo.ignorados), (0, 2))
        self.assertEqual(softexpert.lidos, [])
        self.assertEqual(dashboard.chamadas_gravar, [])

    def test_leading_zeros_are_kept_and_different_numbers_are_not_mixed_up(self):
        dashboard = DashboardFalso(["UTIC-2026-0094"])
        softexpert = SoftExpertFalso([chamado("UTIC-2026-0094"), chamado("UTIC-2026-094")])
        resultado = self.rodar(softexpert, dashboard)
        self.assertEqual(resultado.resumo.ignorados, 1)
        self.assertEqual([linha["C"] for linha in dashboard.linhas], ["UTIC-2026-094"])

    def test_the_two_known_pending_tickets_stay_pending_and_are_never_opened_or_written(self):
        softexpert = self.lista_com(
            chamado("UTIC-2026-0101"), chamado("UTIC-2026-1253"), chamado("UTIC-2026-1177")
        )
        dashboard = DashboardFalso()
        resultado = self.rodar(softexpert, dashboard)
        self.assertEqual(resultado.resumo.incluidos, 1)
        self.assertEqual({n for n, _ in resultado.resumo.pendencias}, {"UTIC-2026-1253", "UTIC-2026-1177"})
        self.assertNotIn("UTIC-2026-1253", softexpert.lidos)
        self.assertNotIn("UTIC-2026-1177", softexpert.lidos)
        self.assertEqual([linha["C"] for linha in dashboard.linhas], ["UTIC-2026-0101"])
        self.assertEqual(set(self.ler_estado()["pendencias"]), {"UTIC-2026-1253", "UTIC-2026-1177"})

    def test_a_known_pending_ticket_already_in_the_dashboard_is_a_duplicate_not_a_pending(self):
        dashboard = DashboardFalso(EXISTENTES + ["UTIC-2026-1253"])
        softexpert = SoftExpertFalso([], listados=["UTIC-2026-1253"])
        resultado = self.rodar(softexpert, dashboard)
        self.assertEqual((resultado.resumo.ignorados, resultado.resumo.pendentes), (1, 0))

    def test_ambiguous_tickets_are_pending_with_a_reason_and_not_written(self):
        softexpert = self.lista_com(
            chamado("UTIC-2026-0101", "Bom dia"),
            chamado("UTIC-2026-0102", "O sistema não abre e preciso de acesso novo"),
            chamado("UTIC-2026-0103", solicitante=""),
            chamado("UTIC-2026-0104", habilitada_em=""),
        )
        dashboard = DashboardFalso()
        resultado = self.rodar(softexpert, dashboard)
        self.assertEqual(resultado.resumo.incluidos, 0)
        self.assertEqual(dashboard.chamadas_gravar, [])
        self.assertEqual(
            self.ler_estado()["pendencias"],
            {
                "UTIC-2026-0101": "sem_indicios_de_tipo",
                "UTIC-2026-0102": "indicios_conflitantes",
                "UTIC-2026-0103": "sem_solicitante",
                "UTIC-2026-0104": "sem_data_de_abertura",
            },
        )

    def test_a_form_that_belongs_to_another_ticket_is_never_written(self):
        softexpert = self.lista_com(chamado("UTIC-2026-0101"))
        softexpert.chamados["UTIC-2026-0101"] = chamado("UTIC-2026-0999")
        dashboard = DashboardFalso()
        resultado = self.rodar(softexpert, dashboard)
        self.assertEqual(dashboard.chamadas_gravar, [])
        self.assertEqual(self.ler_estado()["pendencias"], {"UTIC-2026-0101": "formulario_de_outro_chamado"})
        self.assertEqual(resultado.resumo.incluidos, 0)

    def test_a_second_run_does_not_duplicate_what_the_first_one_wrote(self):
        softexpert = self.lista_com(chamado("UTIC-2026-0101"))
        dashboard = DashboardFalso()
        self.rodar(softexpert, dashboard)
        segunda = self.rodar(softexpert, dashboard)
        self.assertEqual((segunda.resumo.incluidos, segunda.resumo.ignorados), (0, 31))
        self.assertEqual(len(dashboard.linhas), 1)

    def test_state_file_has_the_documented_shape(self):
        self.rodar(self.lista_com(chamado("UTIC-2026-0101"), extras=["UTIC-2026-1253"]), DashboardFalso())
        estado = self.ler_estado()
        execucao = estado["ultima_execucao"]
        self.assertEqual(execucao["inicio"], "2026-10-21T10:00:00-03:00")
        self.assertEqual(execucao["situacao"], "concluida")
        self.assertEqual((execucao["incluidos"], execucao["ignorados"], execucao["pendentes"]), (1, 30, 1))
        self.assertEqual(execucao["detalhes"][-1], {"numero": "UTIC-2026-0101", "resultado": "incluido", "tipo": "INCIDENTE"})
        self.assertFalse(estado["login_necessario"])
        self.assertTrue(estado["ultimo_aviso"])
        self.assertEqual(list(self.estado.parent.glob("*.tmp")), [])

    def test_the_scheduler_summary_reads_the_state_written_by_the_routine(self):
        self.rodar(self.lista_com(chamado("UTIC-2026-0101"), extras=["UTIC-2026-1253"]), DashboardFalso())
        agendador = AgendadorSebrae(caminhos_padrao(self.estado.parent), lambda rotina: None, agora=lambda: self.tempo)
        resumo = agendador.resumo()
        self.assertEqual(resumo["ultima_execucao"]["incluidos"], 1)
        self.assertEqual([p["numero"] for p in resumo["pendencias"]], ["UTIC-2026-1253"])
        self.assertFalse(resumo["login_necessario"])


class ConcorrenciaETriagemTests(Base):
    def test_a_ticket_that_shows_up_while_the_run_is_going_is_ignored_and_not_written(self):
        softexpert = self.lista_com(chamado("UTIC-2026-0101"), chamado("UTIC-2026-0102"))
        dashboard = DashboardFalso()

        def outro_usuario_inclui(numero: str) -> None:
            if numero == "UTIC-2026-0102":
                dashboard.coluna_c.append("UTIC-2026-0102 (incluído por outra pessoa)")

        softexpert.ao_ler = outro_usuario_inclui
        resultado = self.rodar(softexpert, dashboard)
        self.assertEqual([linha["C"] for linha in dashboard.linhas], ["UTIC-2026-0101"])
        self.assertEqual((resultado.resumo.incluidos, resultado.resumo.ignorados), (1, 31))

    def test_empty_column_c_stops_the_run_instead_of_treating_every_ticket_as_new(self):
        softexpert = SoftExpertFalso([chamado("UTIC-2026-0101")])
        dashboard = DashboardFalso([])
        resultado = self.rodar(softexpert, dashboard)
        self.assertEqual(resultado.situacao, orq.SITUACAO_FALHA)
        self.assertEqual(resultado.resumo.falha, orq.FALHA_DASHBOARD_VAZIO)
        self.assertEqual(dashboard.chamadas_gravar, [])
        self.assertEqual(softexpert.lidos, [])

    def test_empty_column_c_can_be_allowed_for_a_brand_new_dashboard(self):
        dashboard = DashboardFalso([])
        resultado = self.rodar(SoftExpertFalso([chamado("UTIC-2026-0101")]), dashboard, permitir_dashboard_vazio=True)
        self.assertEqual(resultado.resumo.incluidos, 1)

    def test_a_dashboard_read_failure_stops_before_touching_softexpert(self):
        dashboard = DashboardFalso()
        dashboard.erro_leitura = TimeoutError("lento")
        softexpert = self.lista_com(chamado("UTIC-2026-0101"))
        resultado = self.rodar(softexpert, dashboard)
        self.assertEqual(resultado.situacao, orq.SITUACAO_FALHA)
        self.assertEqual(resultado.resumo.falha, "falha_leitura_dashboard: TimeoutError")
        self.assertEqual(softexpert.lidos, [])

    def test_a_softexpert_list_failure_writes_nothing(self):
        softexpert = self.lista_com(chamado("UTIC-2026-0101"))
        softexpert.erro_listagem = RuntimeError("página mudou")
        dashboard = DashboardFalso()
        resultado = self.rodar(softexpert, dashboard)
        self.assertEqual(resultado.resumo.falha, "falha_leitura_softexpert: RuntimeError")
        self.assertEqual(dashboard.chamadas_gravar, [])

    def test_one_unreadable_ticket_becomes_pending_and_the_next_one_is_still_processed(self):
        softexpert = self.lista_com(chamado("UTIC-2026-0101"), chamado("UTIC-2026-0102"))
        softexpert.erros["UTIC-2026-0101"] = TimeoutError("formulário não abriu")
        dashboard = DashboardFalso()
        resultado = self.rodar(softexpert, dashboard)
        self.assertEqual(resultado.situacao, orq.SITUACAO_CONCLUIDA)
        self.assertEqual([linha["C"] for linha in dashboard.linhas], ["UTIC-2026-0102"])
        self.assertEqual(self.ler_estado()["pendencias"], {"UTIC-2026-0101": "falha_ao_ler_chamado"})

    def test_three_unreadable_tickets_in_a_row_stop_the_run_and_keep_the_counts(self):
        novos = [chamado(f"UTIC-2026-01{n:02d}") for n in range(1, 6)]
        softexpert = self.lista_com(*novos)
        softexpert.erros.update({"UTIC-2026-0102": OSError(), "UTIC-2026-0103": OSError(), "UTIC-2026-0104": OSError()})
        dashboard = DashboardFalso()
        resultado = self.rodar(softexpert, dashboard)
        self.assertEqual(resultado.situacao, orq.SITUACAO_FALHA)
        self.assertEqual(resultado.resumo.falha, orq.FALHA_LEITURAS_SEGUIDAS)
        self.assertEqual(resultado.resumo.incluidos, 1)
        self.assertNotIn("UTIC-2026-0105", softexpert.lidos)

    def test_an_unexpected_soft_expert_confirmation_stops_immediately(self):
        novos = [chamado(f"UTIC-2026-01{n:02d}") for n in range(1, 4)]
        softexpert = self.lista_com(*novos)
        softexpert.erros["UTIC-2026-0101"] = ErroComMotivo(orq.MOTIVO_CONFIRMACAO_INESPERADA)

        resultado = self.rodar(softexpert, DashboardFalso())

        self.assertEqual(resultado.situacao, orq.SITUACAO_FALHA)
        self.assertEqual(resultado.resumo.falha, orq.MOTIVO_CONFIRMACAO_INESPERADA)
        self.assertEqual(resultado.resumo.incluidos, 0)
        self.assertEqual(softexpert.lidos, ["UTIC-2026-0101"])
        self.assertEqual(
            self.ler_estado()["pendencias"],
            {"UTIC-2026-0101": orq.MOTIVO_CONFIRMACAO_INESPERADA},
        )

    def test_a_successful_read_resets_the_failure_streak(self):
        novos = [chamado(f"UTIC-2026-01{n:02d}") for n in range(1, 7)]
        softexpert = self.lista_com(*novos)
        softexpert.erros.update({"UTIC-2026-0101": OSError(), "UTIC-2026-0102": OSError(), "UTIC-2026-0104": OSError(), "UTIC-2026-0105": OSError()})
        resultado = self.rodar(softexpert, DashboardFalso())
        self.assertEqual(resultado.situacao, orq.SITUACAO_CONCLUIDA)
        self.assertEqual(resultado.resumo.incluidos, 2)

    def test_the_progress_log_never_carries_ticket_text(self):
        linhas: List[str] = []
        softexpert = self.lista_com(chamado("UTIC-2026-0101", "SEGREDO-NA-DESCRICAO não funciona", solicitante="NOME-SECRETO"))
        self.rodar(softexpert, DashboardFalso(), log=linhas.append)
        self.assertTrue(linhas)
        texto = "\n".join(linhas)
        self.assertNotIn("SEGREDO", texto)
        self.assertNotIn("NOME-SECRETO", texto)


class CancelamentoELoginTests(Base):
    def test_cancelling_between_tickets_keeps_what_was_included_and_stops_the_rest(self):
        softexpert = self.lista_com(chamado("UTIC-2026-0101"), chamado("UTIC-2026-0102"), chamado("UTIC-2026-0103"))
        dashboard = DashboardFalso()
        dashboard.depois_de_gravar = lambda numero: setattr(self, "cancelar", True)
        resultado = self.rodar(softexpert, dashboard)
        self.assertEqual(resultado.situacao, orq.SITUACAO_CANCELADA)
        self.assertEqual(resultado.codigo_saida, 1)
        self.assertEqual(resultado.resumo.incluidos, 1)
        self.assertEqual([linha["C"] for linha in dashboard.linhas], ["UTIC-2026-0101"])
        self.assertEqual(softexpert.lidos, ["UTIC-2026-0101"])
        execucao = self.ler_estado()["ultima_execucao"]
        self.assertEqual((execucao["situacao"], execucao["incluidos"]), ("cancelada", 1))

    def test_cancellation_is_not_checked_inside_a_row_write(self):
        consultas: List[str] = []
        dashboard = DashboardFalso()
        dashboard.antes_de_gravar = lambda numero: consultas.append("gravando")
        dashboard.depois_de_gravar = lambda numero: consultas.append("gravado")

        def cancelado() -> bool:
            consultas.append("cancelado?")
            return False

        self.rodar(self.lista_com(chamado("UTIC-2026-0101")), dashboard, cancelado=cancelado)
        self.assertIn("cancelado?", consultas[:consultas.index("gravando")])
        self.assertEqual(consultas[consultas.index("gravando"):], ["gravando", "gravado"])

    def test_a_cancel_requested_before_the_start_reads_and_writes_nothing(self):
        self.cancelar = True
        softexpert = self.lista_com(chamado("UTIC-2026-0101"))
        dashboard = DashboardFalso()
        resultado = self.rodar(softexpert, dashboard)
        self.assertEqual(resultado.situacao, orq.SITUACAO_CANCELADA)
        self.assertEqual((dashboard.leituras, softexpert.lidos, dashboard.chamadas_gravar), (0, [], []))
        self.assertFalse(resultado.avisar)

    def test_a_cancellation_raised_by_an_adapter_is_handled_the_same_way(self):
        softexpert = self.lista_com(chamado("UTIC-2026-0101"), chamado("UTIC-2026-0102"))
        softexpert.erros["UTIC-2026-0102"] = CancelamentoSolicitado()
        dashboard = DashboardFalso()
        resultado = self.rodar(softexpert, dashboard)
        self.assertEqual(resultado.situacao, orq.SITUACAO_CANCELADA)
        self.assertEqual(resultado.resumo.incluidos, 1)

    def test_cancelling_does_not_notify_unless_something_was_included_and_keeps_the_baseline(self):
        self.rodar(self.lista_com(extras=["UTIC-2026-1253"]), DashboardFalso())
        baseline = self.ler_estado()["ultimo_aviso"]
        self.assertTrue(baseline)
        self.cancelar = True
        resultado = self.rodar(self.lista_com(extras=["UTIC-2026-1253"]), DashboardFalso())
        self.assertFalse(resultado.avisar)
        self.assertEqual(self.ler_estado()["ultimo_aviso"], baseline)
        self.assertEqual(set(self.ler_estado()["pendencias"]), {"UTIC-2026-1253"})

    def test_login_expired_in_softexpert_is_a_pending_login_not_a_completion(self):
        softexpert = self.lista_com(chamado("UTIC-2026-0101"))
        softexpert.erro_listagem = LoginNecessarioErro("SoftExpert")
        resultado = self.rodar(softexpert, DashboardFalso())
        self.assertEqual(resultado.situacao, orq.SITUACAO_LOGIN)
        self.assertTrue(resultado.resumo.login_necessario)
        self.assertEqual(resultado.codigo_saida, 1)
        estado = self.ler_estado()
        self.assertTrue(estado["login_necessario"])
        self.assertEqual(estado["login_sistema"], "SoftExpert")
        self.assertIn("SoftExpert", resultado.aviso[1])

    def test_login_expired_in_the_dashboard_stops_before_reading_softexpert(self):
        dashboard = DashboardFalso()
        dashboard.erro_leitura = LoginNecessarioErro("SharePoint")
        softexpert = self.lista_com(chamado("UTIC-2026-0101"))
        resultado = self.rodar(softexpert, dashboard)
        self.assertEqual(resultado.situacao, orq.SITUACAO_LOGIN)
        self.assertEqual(softexpert.lidos, [])
        self.assertEqual(self.ler_estado()["login_sistema"], "SharePoint")

    def test_login_lost_mid_run_keeps_the_inclusions_already_confirmed(self):
        softexpert = self.lista_com(chamado("UTIC-2026-0101"), chamado("UTIC-2026-0102"))
        softexpert.erros["UTIC-2026-0102"] = LoginNecessarioErro("SoftExpert")
        dashboard = DashboardFalso()
        resultado = self.rodar(softexpert, dashboard)
        self.assertEqual(resultado.situacao, orq.SITUACAO_LOGIN)
        self.assertEqual(resultado.resumo.incluidos, 1)
        self.assertTrue(resultado.avisar)
        self.assertIn("1 chamado(s) novo(s)", resultado.aviso[1])
        self.assertEqual(self.ler_estado()["ultima_execucao"]["incluidos"], 1)

    def test_login_lost_during_a_write_leaves_the_ticket_pending_and_unconfirmed(self):
        dashboard = DashboardFalso()
        dashboard.erro_gravar["UTIC-2026-0101"] = LoginNecessarioErro("SharePoint")
        resultado = self.rodar(self.lista_com(chamado("UTIC-2026-0101")), dashboard)
        self.assertEqual(resultado.situacao, orq.SITUACAO_LOGIN)
        self.assertEqual(resultado.resumo.incluidos, 0)
        self.assertEqual(self.ler_estado()["pendencias"], {"UTIC-2026-0101": "gravacao_nao_confirmada"})

    def test_the_next_clean_run_clears_the_login_flag(self):
        softexpert = self.lista_com(chamado("UTIC-2026-0101"))
        softexpert.erro_listagem = LoginNecessarioErro("SoftExpert")
        self.rodar(softexpert, DashboardFalso())
        self.assertTrue(self.ler_estado()["login_necessario"])
        self.rodar(self.lista_com(), DashboardFalso())
        estado = self.ler_estado()
        self.assertFalse(estado["login_necessario"])
        self.assertNotIn("login_sistema", estado)

    def test_a_keyboard_interrupt_persists_the_run_and_propagates(self):
        softexpert = self.lista_com(chamado("UTIC-2026-0101"), chamado("UTIC-2026-0102"))
        softexpert.erros["UTIC-2026-0102"] = KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            self.rodar(softexpert, DashboardFalso())
        execucao = self.ler_estado()["ultima_execucao"]
        self.assertEqual((execucao["situacao"], execucao["incluidos"]), ("interrompida", 1))


class GravacaoTests(Base):
    def test_a_partial_write_records_confirmed_and_missing_cells_and_stops_writing(self):
        softexpert = self.lista_com(chamado("UTIC-2026-0101"), chamado("UTIC-2026-0102"), chamado("UTIC-2026-0103"))
        dashboard = DashboardFalso()
        dashboard.resultado_forcado["UTIC-2026-0102"] = ResultadoGravacao("UTIC-2026-0102", ("C", "F", "G"), False)
        resultado = self.rodar(softexpert, dashboard)
        self.assertEqual(resultado.situacao, orq.SITUACAO_FALHA)
        self.assertEqual(resultado.resumo.incluidos, 1)
        self.assertEqual(resultado.resumo.falha, "falha_gravacao: gravacao_parcial")
        self.assertEqual([c["C"] for c in dashboard.chamadas_gravar], ["UTIC-2026-0101", "UTIC-2026-0102"])
        self.assertNotIn("UTIC-2026-0103", softexpert.lidos)
        parcial = [d for d in self.ler_estado()["ultima_execucao"]["detalhes"] if d["numero"] == "UTIC-2026-0102"][0]
        self.assertEqual(parcial["motivo"], "gravacao_parcial")
        self.assertEqual(parcial["campos_confirmados"], ["C", "F", "G"])
        self.assertEqual(parcial["campos_pendentes"], ["H", "M", "O", "P"])
        self.assertFalse(parcial["salvo"])
        self.assertEqual(self.ler_estado()["pendencias"], {"UTIC-2026-0102": "gravacao_parcial"})

    def test_all_seven_cells_without_a_confirmed_save_is_not_an_inclusion(self):
        dashboard = DashboardFalso()
        dashboard.resultado_forcado["UTIC-2026-0101"] = ResultadoGravacao("UTIC-2026-0101", tuple(COLUNAS_GRAVADAS), False)
        resultado = self.rodar(self.lista_com(chamado("UTIC-2026-0101")), dashboard)
        self.assertEqual(resultado.resumo.incluidos, 0)
        self.assertEqual(resultado.situacao, orq.SITUACAO_FALHA)

    def test_a_writer_that_raises_keeps_earlier_counts_and_marks_the_ticket_unconfirmed(self):
        softexpert = self.lista_com(chamado("UTIC-2026-0101"), chamado("UTIC-2026-0102"), chamado("UTIC-2026-0103"))
        dashboard = DashboardFalso()
        dashboard.erro_gravar["UTIC-2026-0102"] = RuntimeError("célula bloqueada")
        resultado = self.rodar(softexpert, dashboard)
        self.assertEqual(resultado.situacao, orq.SITUACAO_FALHA)
        self.assertEqual(resultado.resumo.falha, "falha_gravacao: RuntimeError")
        self.assertEqual(resultado.resumo.incluidos, 1)
        self.assertEqual(self.ler_estado()["pendencias"], {"UTIC-2026-0102": "gravacao_nao_confirmada"})
        self.assertNotIn("UTIC-2026-0103", softexpert.lidos)

    def test_a_writer_that_names_the_reason_keeps_it_in_the_pending_item_and_the_failure(self):
        dashboard = DashboardFalso()
        dashboard.resultado_forcado["UTIC-2026-0101"] = ResultadoGravacao(
            "UTIC-2026-0101", ("C", "F", "G", "H", "M", "O", "P"), False, erro="nao_salvo"
        )
        resultado = self.rodar(self.lista_com(chamado("UTIC-2026-0101")), dashboard)
        self.assertEqual(resultado.resumo.falha, "falha_gravacao: gravacao_nao_salvo")
        self.assertEqual(self.ler_estado()["pendencias"], {"UTIC-2026-0101": "gravacao_nao_salvo"})

    def test_a_writer_that_reports_a_duplicate_counts_it_as_ignored_and_goes_on(self):
        dashboard = DashboardFalso()
        dashboard.resultado_forcado["UTIC-2026-0101"] = ResultadoGravacao("UTIC-2026-0101", (), False, duplicado=True)
        resultado = self.rodar(self.lista_com(chamado("UTIC-2026-0101"), chamado("UTIC-2026-0102")), dashboard)
        self.assertEqual(resultado.situacao, orq.SITUACAO_CONCLUIDA)
        self.assertEqual((resultado.resumo.incluidos, resultado.resumo.ignorados), (1, 31))
        self.assertEqual(self.ler_estado()["pendencias"], {})

    def test_a_writer_that_rejects_the_row_leaves_the_ticket_pending_and_goes_on(self):
        dashboard = DashboardFalso()
        dashboard.resultado_forcado["UTIC-2026-0101"] = ResultadoGravacao(
            "UTIC-2026-0101", (), False, motivo_pendente="gravacao_invalido"
        )
        resultado = self.rodar(self.lista_com(chamado("UTIC-2026-0101"), chamado("UTIC-2026-0102")), dashboard)
        self.assertEqual(resultado.situacao, orq.SITUACAO_CONCLUIDA)
        self.assertEqual(resultado.resumo.incluidos, 1)
        self.assertEqual(self.ler_estado()["pendencias"], {"UTIC-2026-0101": "gravacao_invalido"})

    def test_a_ticket_unavailable_for_a_known_reason_is_pending_without_counting_as_a_streak_failure(self):
        novos = [chamado(f"UTIC-2026-01{n:02d}") for n in range(1, 6)]
        softexpert = self.lista_com(*novos)
        for n in range(1, 5):
            softexpert.erros[f"UTIC-2026-01{n:02d}"] = orq.ChamadoIndisponivelErro("numero_nao_confere")
        resultado = self.rodar(softexpert, DashboardFalso())
        self.assertEqual(resultado.situacao, orq.SITUACAO_CONCLUIDA)
        self.assertEqual(resultado.resumo.incluidos, 1)
        self.assertEqual(set(self.ler_estado()["pendencias"].values()), {"numero_nao_confere"})

    def test_a_result_for_another_ticket_is_not_trusted(self):
        dashboard = DashboardFalso()
        dashboard.resultado_forcado["UTIC-2026-0101"] = ResultadoGravacao("UTIC-2026-0999", tuple(COLUNAS_GRAVADAS), True)
        resultado = self.rodar(self.lista_com(chamado("UTIC-2026-0101")), dashboard)
        self.assertEqual(resultado.resumo.incluidos, 0)
        self.assertEqual(resultado.situacao, orq.SITUACAO_FALHA)

    def test_the_final_reread_moves_a_missing_row_out_of_the_included_count(self):
        dashboard = DashboardFalso()
        dashboard.nao_persistir.add("UTIC-2026-0101")
        resultado = self.rodar(self.lista_com(chamado("UTIC-2026-0101"), chamado("UTIC-2026-0102")), dashboard)
        self.assertEqual(resultado.resumo.incluidos, 1)
        self.assertEqual(resultado.situacao, orq.SITUACAO_FALHA)
        self.assertEqual(self.ler_estado()["pendencias"], {"UTIC-2026-0101": "ausente_na_releitura_final"})

    def test_a_row_that_ends_up_twice_in_column_c_is_reported_as_a_failure(self):
        dashboard = DashboardFalso()
        dashboard.duplicar.add("UTIC-2026-0101")
        resultado = self.rodar(self.lista_com(chamado("UTIC-2026-0101")), dashboard)
        self.assertEqual(resultado.resumo.incluidos, 1)
        self.assertEqual(resultado.resumo.falha, orq.FALHA_DUPLICIDADE)
        detalhe = [d for d in resultado.detalhes if d.get("motivo") == "duplicado_no_dashboard"][0]
        self.assertEqual(detalhe["ocorrencias"], 2)

    def test_a_failed_final_reread_keeps_the_counts_of_rows_already_confirmed(self):
        dashboard = DashboardFalso()
        dashboard.erro_leitura_apos_gravar = TimeoutError("sem resposta")
        resultado = self.rodar(self.lista_com(chamado("UTIC-2026-0101")), dashboard)
        self.assertEqual(resultado.resumo.incluidos, 1)
        self.assertEqual(resultado.situacao, orq.SITUACAO_FALHA)
        self.assertEqual(resultado.resumo.falha, "releitura_final_falhou: TimeoutError")

    def test_the_final_reread_also_runs_after_an_aborted_run(self):
        softexpert = self.lista_com(chamado("UTIC-2026-0101"), chamado("UTIC-2026-0102"))
        dashboard = DashboardFalso()
        dashboard.nao_persistir.add("UTIC-2026-0101")
        dashboard.resultado_forcado["UTIC-2026-0102"] = ResultadoGravacao("UTIC-2026-0102", ("C",), False)
        resultado = self.rodar(softexpert, dashboard)
        self.assertEqual(resultado.situacao, orq.SITUACAO_FALHA)
        self.assertEqual(resultado.resumo.incluidos, 0)  # 0101 was not found again in column C
        self.assertEqual(
            self.ler_estado()["pendencias"],
            {"UTIC-2026-0101": "ausente_na_releitura_final", "UTIC-2026-0102": "gravacao_parcial"},
        )

    def test_login_lost_right_after_a_confirmed_row_skips_the_reread_and_keeps_the_count(self):
        softexpert = self.lista_com(chamado("UTIC-2026-0101"), chamado("UTIC-2026-0102"))
        softexpert.erros["UTIC-2026-0102"] = LoginNecessarioErro("SoftExpert")
        resultado = self.rodar(softexpert, DashboardFalso())
        self.assertEqual((resultado.situacao, resultado.resumo.incluidos), (orq.SITUACAO_LOGIN, 1))

    def test_a_state_write_failure_does_not_lose_the_result(self):
        with patch.object(orq, "gravar_estado", side_effect=OSError("disco")):
            resultado = self.rodar(self.lista_com(chamado("UTIC-2026-0101")), DashboardFalso())
        self.assertEqual(resultado.resumo.incluidos, 1)
        self.assertEqual(resultado.situacao, orq.SITUACAO_CONCLUIDA)


class PendenciasPersistidasTests(Base):
    def test_an_aborted_run_keeps_earlier_pending_items_still_open(self):
        self.rodar(self.lista_com(extras=["UTIC-2026-1253", "UTIC-2026-1177"]), DashboardFalso())
        softexpert = self.lista_com()
        softexpert.erro_listagem = LoginNecessarioErro("SoftExpert")
        self.rodar(softexpert, DashboardFalso())
        self.assertEqual(set(self.ler_estado()["pendencias"]), {"UTIC-2026-1253", "UTIC-2026-1177"})

    def test_an_aborted_run_drops_earlier_pending_items_now_present_in_the_dashboard(self):
        self.rodar(self.lista_com(extras=["UTIC-2026-1253", "UTIC-2026-1177"]), DashboardFalso())
        softexpert = self.lista_com()
        softexpert.erro_listagem = RuntimeError()
        self.rodar(softexpert, DashboardFalso(EXISTENTES + ["UTIC-2026-1253"]))
        self.assertEqual(set(self.ler_estado()["pendencias"]), {"UTIC-2026-1177"})

    def test_a_completed_run_replaces_the_pending_set(self):
        self.rodar(self.lista_com(extras=["UTIC-2026-1253", "UTIC-2026-1177"]), DashboardFalso())
        self.rodar(self.lista_com(extras=["UTIC-2026-1253"]), DashboardFalso())
        self.assertEqual(set(self.ler_estado()["pendencias"]), {"UTIC-2026-1253"})

    def test_a_pending_ticket_that_is_included_later_leaves_the_pending_set(self):
        softexpert = self.lista_com(chamado("UTIC-2026-0101", "Bom dia"))
        self.rodar(softexpert, DashboardFalso())
        self.assertEqual(self.ler_estado()["pendencias"], {"UTIC-2026-0101": "sem_indicios_de_tipo"})
        softexpert.chamados["UTIC-2026-0101"] = chamado("UTIC-2026-0101", INCIDENTE)
        resultado = self.rodar(softexpert, DashboardFalso())
        self.assertEqual(resultado.resumo.incluidos, 1)
        self.assertEqual(self.ler_estado()["pendencias"], {})

    def test_a_corrupt_state_file_is_read_as_empty(self):
        self.estado.parent.mkdir(parents=True)
        self.estado.write_text("{ não é json", encoding="utf-8")
        resultado = self.rodar(self.lista_com(chamado("UTIC-2026-0101")), DashboardFalso())
        self.assertEqual(resultado.resumo.incluidos, 1)
        self.assertEqual(self.ler_estado()["ultima_execucao"]["incluidos"], 1)

    def test_state_helpers_ignore_unexpected_value_types(self):
        self.estado.parent.mkdir(parents=True)
        self.estado.write_text(json.dumps({"pendencias": ["x"], "ultima_execucao": "y", "login_necessario": 1}), encoding="utf-8")
        estado = orq.ler_estado(self.estado)
        self.assertEqual((estado["pendencias"], estado["ultima_execucao"], estado["login_necessario"]), ({}, None, True))
        self.estado.write_text("[]", encoding="utf-8")
        self.assertEqual(orq.ler_estado(self.estado), orq.estado_vazio())


class AvisosTests(Base):
    def test_known_pending_items_notify_once_and_stay_silent_afterwards(self):
        primeira = self.rodar(self.lista_com(extras=["UTIC-2026-1253", "UTIC-2026-1177"]), DashboardFalso())
        self.assertTrue(primeira.avisar)
        self.assertIn("UTIC-2026-1253", primeira.aviso[1])
        for _ in range(3):
            repetida = self.rodar(self.lista_com(extras=["UTIC-2026-1253", "UTIC-2026-1177"]), DashboardFalso())
            self.assertFalse(repetida.avisar)
            self.assertIsNone(repetida.aviso)

    def test_nothing_new_and_nothing_pending_is_silent(self):
        resultado = self.rodar(self.lista_com(), DashboardFalso())
        self.assertFalse(resultado.avisar)
        self.assertEqual((resultado.resumo.incluidos, resultado.resumo.ignorados, resultado.resumo.pendentes), (0, 30, 0))

    def test_a_changed_pending_set_notifies_again(self):
        self.rodar(self.lista_com(extras=["UTIC-2026-1253"]), DashboardFalso())
        mudou = self.rodar(self.lista_com(extras=["UTIC-2026-1253", "UTIC-2026-1177"]), DashboardFalso())
        self.assertTrue(mudou.avisar)

    def test_inclusions_always_notify_but_do_not_make_the_next_pending_notice_repeat(self):
        self.rodar(self.lista_com(extras=["UTIC-2026-1253"]), DashboardFalso())
        dashboard = DashboardFalso()
        com_inclusao = self.rodar(self.lista_com(chamado("UTIC-2026-0101"), extras=["UTIC-2026-1253"]), dashboard)
        self.assertTrue(com_inclusao.avisar)
        self.assertIn("1 chamado(s) novo(s) incluído(s)", com_inclusao.aviso[1])
        depois = self.rodar(self.lista_com(chamado("UTIC-2026-0101"), extras=["UTIC-2026-1253"]), dashboard)
        self.assertFalse(depois.avisar)

    def test_a_problem_that_goes_away_and_comes_back_is_new_again(self):
        self.rodar(self.lista_com(extras=["UTIC-2026-1253"]), DashboardFalso())
        self.assertFalse(self.rodar(self.lista_com(extras=["UTIC-2026-1253"]), DashboardFalso()).avisar)
        self.rodar(self.lista_com(), DashboardFalso())  # resolved
        self.assertEqual(self.ler_estado()["ultimo_aviso"], "")
        self.assertTrue(self.rodar(self.lista_com(extras=["UTIC-2026-1253"]), DashboardFalso()).avisar)

    def test_the_same_failure_notifies_once_and_a_different_one_notifies_again(self):
        def com_erro(erro: BaseException) -> orq.ResultadoOrquestracao:
            softexpert = self.lista_com()
            softexpert.erro_listagem = erro
            return self.rodar(softexpert, DashboardFalso())

        self.assertTrue(com_erro(RuntimeError()).avisar)
        self.assertFalse(com_erro(RuntimeError()).avisar)
        self.assertTrue(com_erro(TimeoutError()).avisar)
        self.assertTrue(com_erro(LoginNecessarioErro("SoftExpert")).avisar)
        self.assertFalse(com_erro(LoginNecessarioErro("SoftExpert")).avisar)

    def test_the_notice_lists_a_few_pending_numbers_and_never_ticket_text(self):
        resumo = ResumoExecucao(
            pendentes=5,
            pendencias=tuple((f"UTIC-2026-000{n}", "sem_indicios_de_tipo") for n in range(1, 6)),
        )
        titulo, texto = orq.montar_aviso(resumo, orq.SITUACAO_CONCLUIDA)
        self.assertEqual(titulo, "Simpress: chamados Sebrae")
        self.assertIn("UTIC-2026-0001 (sem_indicios_de_tipo)", texto)
        self.assertIn("e mais 2", texto)
        self.assertNotIn("UTIC-2026-0004", texto)

    def test_failure_notice_mentions_the_stage_only(self):
        _, texto = orq.montar_aviso(ResumoExecucao(falha="falha_gravacao: RuntimeError"), orq.SITUACAO_FALHA)
        self.assertEqual(texto, "A sincronização não terminou (falha_gravacao: RuntimeError).")


if __name__ == "__main__":
    unittest.main()
