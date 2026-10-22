"""Weekday schedule of the Sebrae sync: slots, tolerance, no catch-up, busy runner and API."""

import importlib.util
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import date, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

with (
    patch("core.integrity.recover_pending_transactions", return_value=None),
    patch("openpyxl.load_workbook", side_effect=RuntimeError("operational data blocked")),
    redirect_stdout(io.StringIO()),
):
    import main

from core.errors import DomainBusyError, DomainConflictError
from domains import sebrae_agendamento as agenda
from domains.sebrae_agendamento import FUSO, AgendadorSebrae, caminhos_padrao

HTTP_TEST_AVAILABLE = importlib.util.find_spec("httpx") is not None
if HTTP_TEST_AVAILABLE:
    from fastapi.testclient import TestClient


def sp(ano, mes, dia, hora, minuto, segundo=0):
    return datetime(ano, mes, dia, hora, minuto, segundo, tzinfo=FUSO)


class SlotTests(unittest.TestCase):
    def test_a_weekday_has_the_expected_starts_and_never_18h(self):
        horarios = agenda.horarios_do_dia(date(2026, 10, 21))  # Wednesday
        textos = [f"{h:%H:%M}" for h in horarios]
        self.assertEqual(textos[:4], ["09:15", "09:45", "10:15", "10:45"])
        self.assertEqual(textos[-3:], ["16:45", "17:15", "17:45"])
        self.assertEqual(len(textos), 18)
        self.assertNotIn("18:00", textos)
        self.assertNotIn("09:00", textos)

    def test_weekends_have_no_starts(self):
        self.assertEqual(agenda.horarios_do_dia(date(2026, 10, 24)), [])  # Saturday
        self.assertEqual(agenda.horarios_do_dia(date(2026, 10, 25)), [])  # Sunday

    def test_next_start_inside_the_window(self):
        self.assertEqual(agenda.proximo_horario(sp(2026, 10, 21, 9, 15)), sp(2026, 10, 21, 9, 45))
        self.assertEqual(agenda.proximo_horario(sp(2026, 10, 21, 10, 0)), sp(2026, 10, 21, 10, 15))

    def test_next_start_before_and_after_the_window(self):
        self.assertEqual(agenda.proximo_horario(sp(2026, 10, 21, 7, 0)), sp(2026, 10, 21, 9, 15))
        self.assertEqual(agenda.proximo_horario(sp(2026, 10, 21, 17, 45)), sp(2026, 10, 22, 9, 15))
        self.assertEqual(agenda.proximo_horario(sp(2026, 10, 21, 18, 0)), sp(2026, 10, 22, 9, 15))

    def test_friday_evening_and_weekend_go_to_monday(self):
        segunda = sp(2026, 10, 26, 9, 15)
        self.assertEqual(agenda.proximo_horario(sp(2026, 10, 23, 17, 46)), segunda)  # Friday night
        self.assertEqual(agenda.proximo_horario(sp(2026, 10, 24, 12, 0)), segunda)
        self.assertEqual(agenda.proximo_horario(sp(2026, 10, 25, 23, 59)), segunda)

    def test_time_zone_is_sao_paulo_whatever_the_input_zone(self):
        utc = datetime(2026, 10, 21, 12, 20, tzinfo=agenda.ZoneInfo("UTC"))  # 09:20 in Sao Paulo
        self.assertEqual(agenda.horario_vigente(utc), sp(2026, 10, 21, 9, 15))
        self.assertEqual(agenda.proximo_horario(utc), sp(2026, 10, 21, 9, 45))

    def test_naive_times_are_read_as_sao_paulo(self):
        self.assertEqual(agenda.proximo_horario(datetime(2026, 10, 21, 9, 0)), sp(2026, 10, 21, 9, 15))

    def test_tolerance_window(self):
        self.assertEqual(agenda.horario_vigente(sp(2026, 10, 21, 9, 15)), sp(2026, 10, 21, 9, 15))
        self.assertEqual(agenda.horario_vigente(sp(2026, 10, 21, 9, 20)), sp(2026, 10, 21, 9, 15))
        self.assertIsNone(agenda.horario_vigente(sp(2026, 10, 21, 9, 20, 1)))
        self.assertIsNone(agenda.horario_vigente(sp(2026, 10, 21, 9, 14, 59)))
        self.assertIsNone(agenda.horario_vigente(sp(2026, 10, 21, 18, 0)))
        self.assertIsNone(agenda.horario_vigente(sp(2026, 10, 24, 9, 15)))  # Saturday


class SchedulerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.state = Path(temporary.name)
        self.now = sp(2026, 10, 21, 9, 15)
        self.started = []
        self.start_error = None

    def iniciar(self, rotina):
        if self.start_error is not None:
            raise self.start_error
        self.started.append(rotina)
        return {"estado": "em_andamento"}

    def scheduler(self, **kwargs):
        kwargs.setdefault("pronta", True)
        return AgendadorSebrae(caminhos_padrao(self.state), self.iniciar, agora=lambda: self.now, **kwargs)

    def test_paused_by_default_and_never_starts(self):
        agendador = self.scheduler()
        self.assertFalse(agendador.resumo()["agendamento"]["ativo"])
        self.assertIsNone(agendador.verificar())
        self.assertEqual(self.started, [])

    def test_cannot_be_turned_on_while_the_routine_is_incomplete(self):
        agendador = self.scheduler(pronta=False)
        with self.assertRaises(DomainConflictError):
            agendador.definir_ativo(True)
        self.assertFalse(agendador.resumo()["agendamento"]["ativo"])
        self.assertFalse(agenda.ROTINA_PRONTA, "Só ligue ROTINA_PRONTA depois da execução controlada real (fase E).")

    def test_a_stored_on_switch_is_ignored_while_the_routine_is_incomplete(self):
        self.scheduler().definir_ativo(True)
        self.assertFalse(self.scheduler(pronta=False).resumo()["agendamento"]["ativo"])
        self.assertIsNone(self.scheduler(pronta=False).verificar())

    def test_each_start_fires_once(self):
        agendador = self.scheduler()
        agendador.definir_ativo(True)
        self.assertEqual(agendador.verificar(), "iniciada")
        self.now += timedelta(seconds=20)
        self.assertIsNone(agendador.verificar())
        self.assertEqual(self.started, ["sebrae"])
        self.now = sp(2026, 10, 21, 9, 45)
        self.assertEqual(agendador.verificar(), "iniciada")
        self.assertEqual(self.started, ["sebrae", "sebrae"])

    def test_a_restart_inside_the_window_does_not_fire_twice(self):
        self.scheduler().definir_ativo(True)
        self.scheduler().verificar()
        self.now += timedelta(minutes=2)
        self.assertIsNone(self.scheduler().verificar())  # a new object, as after a server restart
        self.assertEqual(self.started, ["sebrae"])

    def test_missed_starts_are_not_made_up(self):
        agendador = self.scheduler()
        agendador.definir_ativo(True)
        self.now = sp(2026, 10, 21, 12, 40)  # computer was off since 09:15
        self.assertIsNone(agendador.verificar())
        self.now = sp(2026, 10, 21, 13, 7)  # between windows: 12:45 is over, 13:15 has not come
        self.assertIsNone(agendador.verificar())
        self.assertEqual(self.started, [])

    def test_never_fires_at_18h_or_on_weekends(self):
        agendador = self.scheduler()
        agendador.definir_ativo(True)
        for momento in (sp(2026, 10, 21, 18, 0), sp(2026, 10, 24, 9, 15), sp(2026, 10, 25, 9, 15), sp(2026, 10, 21, 8, 59)):
            self.now = momento
            self.assertIsNone(agendador.verificar(), momento)
        self.assertEqual(self.started, [])

    def test_a_busy_runner_skips_the_start_without_queueing(self):
        agendador = self.scheduler()
        agendador.definir_ativo(True)
        self.start_error = DomainConflictError("Já há uma rotina em andamento")
        self.assertEqual(agendador.verificar(), "pulado: ocupada")
        self.start_error = None
        self.now += timedelta(minutes=1)
        self.assertIsNone(agendador.verificar())  # same start: no retry
        self.assertEqual(self.started, [])
        self.assertEqual(agendador.resumo()["agendamento"]["ultimo_disparo"]["resultado"], "pulado: ocupada")
        self.now = sp(2026, 10, 21, 9, 45)
        self.assertEqual(agendador.verificar(), "iniciada")

    def test_start_failures_are_recorded_and_do_not_raise(self):
        agendador = self.scheduler()
        agendador.definir_ativo(True)
        self.start_error = DomainBusyError("Não foi possível iniciar a automação.")
        self.assertEqual(agendador.verificar(), "erro ao iniciar")
        self.start_error = RuntimeError("inesperado")
        self.now = sp(2026, 10, 21, 9, 45)
        self.assertEqual(agendador.verificar(), "erro ao iniciar")

    def test_settings_persist_across_instances(self):
        self.scheduler().definir_ativo(True)
        retomado = self.scheduler()
        self.assertTrue(retomado.resumo()["agendamento"]["ativo"])
        retomado.definir_ativo(False)
        self.assertFalse(self.scheduler().resumo()["agendamento"]["ativo"])
        gravado = json.loads(caminhos_padrao(self.state).agendamento.read_text(encoding="utf-8"))
        self.assertIn("atualizado_em", gravado)

    def test_summary_shows_next_run_state_and_pending_items(self):
        agendador = self.scheduler()
        self.assertIsNone(agendador.resumo()["agendamento"]["proxima_execucao"])
        agendador.definir_ativo(True)
        self.now = sp(2026, 10, 23, 17, 50)
        resumo = agendador.resumo()
        self.assertEqual(resumo["agendamento"]["proxima_execucao"], "2026-10-26T09:15:00-03:00")
        self.assertEqual(resumo["agendamento"]["fuso"], "America/Sao_Paulo")
        self.assertIn("computador precisa estar ligado", resumo["agendamento"]["aviso"])
        self.assertEqual((resumo["ultima_execucao"], resumo["pendencias"], resumo["login_necessario"]), (None, [], False))
        caminhos_padrao(self.state).estado_chamados.write_text(json.dumps({
            "ultima_execucao": {"incluidos": 3, "ignorados": 10, "pendentes": 2},
            "pendencias": {"UTIC-2026-1253": "motivo"},
            "login_necessario": True,
        }), encoding="utf-8")
        resumo = agendador.resumo()
        self.assertEqual(resumo["ultima_execucao"]["incluidos"], 3)
        self.assertEqual(resumo["pendencias"], [{"numero": "UTIC-2026-1253", "motivo": "motivo"}])
        self.assertTrue(resumo["login_necessario"])

    def test_corrupt_files_read_as_empty(self):
        caminhos = caminhos_padrao(self.state)
        caminhos.agendamento.write_text("{não é json", encoding="utf-8")
        caminhos.estado_chamados.write_text("[1, 2]", encoding="utf-8")
        resumo = self.scheduler().resumo()
        self.assertFalse(resumo["agendamento"]["ativo"])
        self.assertIsNone(resumo["ultima_execucao"])


@unittest.skipUnless(HTTP_TEST_AVAILABLE, "Optional httpx test dependency is not installed")
class SebraeRouteTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.agendador = AgendadorSebrae(
            caminhos_padrao(Path(temporary.name)), lambda rotina: None, agora=lambda: sp(2026, 10, 21, 10, 0), pronta=False,
        )
        patcher = patch.object(main, "_sebrae_scheduler", self.agendador)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.origin = f"http://127.0.0.1:{main.SERVER_PORT}"
        self.client = TestClient(main.app, base_url=self.origin, client=("127.0.0.1", 1234))
        self.addCleanup(self.client.close)

    def test_summary(self):
        response = self.client.get("/api/automacao/sebrae/resumo")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["cache-control"], "no-store")
        corpo = response.json()
        self.assertFalse(corpo["agendamento"]["ativo"])
        self.assertFalse(corpo["agendamento"]["pronta"])
        self.assertEqual(corpo["pendencias"], [])

    def test_turning_on_is_refused_with_409_while_incomplete_and_pausing_works(self):
        headers = {"Origin": self.origin}
        recusado = self.client.put("/api/automacao/sebrae/agendamento", json={"ativo": True}, headers=headers)
        self.assertEqual(recusado.status_code, 409)
        self.assertIn("ainda não está completa", recusado.json()["detail"])
        self.assertEqual(self.client.put("/api/automacao/sebrae/agendamento", json={"ativo": False}, headers=headers).status_code, 200)

    def test_invalid_payloads_are_422(self):
        for corpo in ({}, {"ativo": "talvez"}, {"ativo": True, "extra": 1}):
            with self.subTest(corpo=corpo):
                self.assertEqual(self.client.put("/api/automacao/sebrae/agendamento", json=corpo).status_code, 422)

    def test_cross_site_requests_are_refused(self):
        self.assertEqual(self.client.put("/api/automacao/sebrae/agendamento", json={"ativo": False},
                                         headers={"Origin": "http://evil.example"}).status_code, 403)
        self.assertEqual(self.client.get("/api/automacao/sebrae/resumo",
                                         headers={"Sec-Fetch-Site": "cross-site"}).status_code, 403)


if __name__ == "__main__":
    unittest.main()
