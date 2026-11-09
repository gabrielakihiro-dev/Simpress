"""Synthetic clock, local temporary state and fake runner: no Chrome or operational data."""
import json
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import Mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from core.errors import DomainConflictError, DomainValidationError
from domains.dashboard_agendamento import AgendadorDashboard
from routers.automation import AutomationRouteServices, create_automation_router
from domains.sebrae_agendamento import FUSO
from domains.assistant_api import SimpressApi
from domains.assistant_tools import TOOLS, grupos_da_mensagem


class DashboardAgendamentoTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.now = datetime(2026, 11, 8, 23, 45, tzinfo=FUSO)  # Sunday, outside the legacy schedule
        self.start = Mock()
        self.path = Path(self.tmp.name) / "schedule.json"
        self.scheduler = AgendadorDashboard(self.path, self.start, agora=lambda: self.now)

    def test_activation_waits_30_minutes_and_runs_once_even_after_restart(self):
        self.assertFalse(self.scheduler.resumo()["ativo"])
        self.assertIsNone(self.scheduler.verificar())
        self.scheduler.definir_ativo(True)
        self.assertIsNone(self.scheduler.verificar())
        self.now += timedelta(minutes=30)
        self.assertEqual(self.scheduler.verificar(), "iniciada")
        self.start.assert_called_once_with("dashboard")
        restarted = AgendadorDashboard(self.path, self.start, agora=lambda: self.now)
        self.assertIsNone(restarted.verificar())
        self.scheduler.definir_ativo(False)
        self.now += timedelta(hours=1)
        self.assertIsNone(restarted.verificar())

    def test_busy_failure_and_missed_slots_are_never_queued(self):
        self.scheduler.definir_ativo(True)
        self.now += timedelta(minutes=30)
        self.start.side_effect = DomainConflictError("occupied")
        self.assertEqual(self.scheduler.verificar(), "pulado: ocupada")
        self.assertIsNone(self.scheduler.verificar())
        self.start.side_effect = RuntimeError("failed")
        self.now += timedelta(minutes=30)
        self.assertEqual(self.scheduler.verificar(), "erro ao iniciar")
        self.now += timedelta(hours=10)
        self.assertEqual(self.scheduler.verificar(), "pulado: horário perdido")
        self.assertEqual(self.start.call_count, 2)

    def test_repeated_activation_does_not_postpone_next_run(self):
        next_run = self.scheduler.definir_ativo(True)["proxima_execucao"]
        self.now += timedelta(minutes=10)
        self.assertEqual(self.scheduler.definir_ativo(True)["proxima_execucao"], next_run)

    def test_default_interval_is_30_when_absent_or_invalid(self):
        self.assertEqual(self.scheduler.resumo()["intervalo_minutos"], 30)
        for invalid in (45, "60", 60.0, True, None, [60]):
            with self.subTest(invalid=invalid):
                self.path.write_text(json.dumps({"ativo": False, "intervalo_minutos": invalid}), encoding="utf-8")
                self.assertEqual(self.scheduler.resumo()["intervalo_minutos"], 30)
        self.assertEqual(self.scheduler.definir_ativo(True)["intervalo_minutos"], 30)

    def test_each_allowed_interval_is_saved_and_survives_restart(self):
        for minutes in (60, 90, 120, 30):
            with self.subTest(minutes=minutes):
                result = self.scheduler.definir_ativo(True, minutes)
                self.assertEqual(result["intervalo_minutos"], minutes)
                self.assertEqual(json.loads(self.path.read_text(encoding="utf-8"))["intervalo_minutos"], minutes)
                restarted = AgendadorDashboard(self.path, self.start, agora=lambda: self.now)
                self.assertEqual(restarted.resumo()["intervalo_minutos"], minutes)

    def test_invalid_interval_is_refused_before_touching_the_file(self):
        self.scheduler.definir_ativo(True, 60)
        saved = self.path.read_text(encoding="utf-8")
        for invalid in (0, 45, 150, -30, "60", 60.0, True):
            with self.subTest(invalid=invalid):
                with self.assertRaises(DomainValidationError) as error:
                    self.scheduler.definir_ativo(True, invalid)
                self.assertEqual(error.exception.status_code, 422)
        self.assertEqual(self.path.read_text(encoding="utf-8"), saved)

    def test_changing_interval_rearms_only_when_active(self):
        first = self.scheduler.definir_ativo(True, 60)
        self.assertEqual(first["proxima_execucao"], (self.now + timedelta(minutes=60)).isoformat())
        self.now += timedelta(minutes=10)
        same = self.scheduler.definir_ativo(True, 60)
        self.assertEqual(same["proxima_execucao"], first["proxima_execucao"])
        omitted = self.scheduler.definir_ativo(True)
        self.assertEqual(omitted["proxima_execucao"], first["proxima_execucao"])
        self.assertEqual(omitted["intervalo_minutos"], 60)
        changed = self.scheduler.definir_ativo(True, 120)
        self.assertEqual(changed["proxima_execucao"], (self.now + timedelta(minutes=120)).isoformat())
        paused = self.scheduler.definir_ativo(False, 90)
        self.assertFalse(paused["ativo"])
        self.assertIsNone(paused["proxima_execucao"])
        self.assertEqual(paused["intervalo_minutos"], 90)
        resumed = self.scheduler.definir_ativo(True)
        self.assertEqual(resumed["proxima_execucao"], (self.now + timedelta(minutes=90)).isoformat())

    def test_verify_uses_the_saved_interval(self):
        self.scheduler.definir_ativo(True, 90)
        self.now += timedelta(minutes=30)
        self.assertIsNone(self.scheduler.verificar())
        self.now += timedelta(minutes=60)
        self.assertEqual(self.scheduler.verificar(), "iniciada")
        self.assertEqual(self.scheduler.resumo()["proxima_execucao"], (self.now + timedelta(minutes=90)).isoformat())
        self.now += timedelta(minutes=89)
        self.assertIsNone(self.scheduler.verificar())
        self.start.assert_called_once_with("dashboard")
        # A broken next-run time is rearmed with the saved interval too.
        self.path.write_text(json.dumps({"ativo": True, "intervalo_minutos": 120, "proxima_execucao": "garbage"}),
                             encoding="utf-8")
        self.assertIsNone(self.scheduler.verificar())
        self.assertEqual(self.scheduler.resumo()["proxima_execucao"], (self.now + timedelta(minutes=120)).isoformat())

    def test_router_accepts_the_interval_and_refuses_other_bodies(self):
        app = FastAPI()
        app.include_router(create_automation_router(AutomationRouteServices(
            runner=lambda: None, sebrae=lambda: None, dashboard=lambda: self.scheduler)))  # type: ignore[arg-type]
        client = TestClient(app)
        url = "/api/automacao/dashboard/agendamento"
        ok = client.put(url, json={"ativo": True, "intervalo_minutos": 90})
        self.assertEqual((ok.status_code, ok.json()["intervalo_minutos"], ok.json()["ativo"]), (200, 90, True))
        self.assertEqual(client.get(url).json()["intervalo_minutos"], 90)
        kept = client.put(url, json={"ativo": False})
        self.assertEqual((kept.status_code, kept.json()["intervalo_minutos"]), (200, 90))
        for body in ({"ativo": True, "intervalo_minutos": 45}, {"ativo": True, "intervalo_minutos": "x"},
                     {"ativo": True, "intervalo_minutos": 150}, {"ativo": True, "extra": 1}, {"intervalo_minutos": 60}):
            with self.subTest(body=body):
                self.assertEqual(client.put(url, json=body).status_code, 422)
        self.assertEqual(self.scheduler.resumo()["intervalo_minutos"], 90)

    def test_assistant_requires_confirmation_and_sends_interval_only_when_given(self):
        tool = TOOLS["definir_agendamento_dashboard"]
        self.assertTrue(tool.changes_data)
        self.assertIn("30 minutos", tool.describe({"ativo": True}))
        for minutes, label in ((30, "30 minutos"), (60, "1h"), (90, "1h30"), (120, "2h")):
            self.assertIn(f"a cada {label}", tool.describe({"ativo": True, "intervalo_minutos": minutes}))
        self.assertEqual(tool.properties["intervalo_minutos"]["enum"], [30, 60, 90, 120])
        self.assertEqual(tool.required, ["ativo"])
        for message in ("agendar a cada 30 minutos", "repetir a cada 1h30", "repetir a cada 2h",
                        "repetir a cada 90 minutos", "repetir a cada hora e meia"):
            self.assertIn("automacao", grupos_da_mensagem(message))
        for message in ("reunião às 1h", "o prazo é de 2h", "tenho 60 minutos"):
            self.assertNotIn("automacao", grupos_da_mensagem(message))
        api = SimpressApi.__new__(SimpressApi)
        api._chamar = Mock(return_value=(True, {"ativo": True, "intervalo_minutos": 30, "caminho": "private"}))
        self.assertTrue(api.definir_agendamento_dashboard(True)["ativo"])
        api._chamar.assert_called_once_with("PUT", "/api/automacao/dashboard/agendamento", corpo={"ativo": True})
        api._chamar = Mock(return_value=(True, {"ativo": True, "intervalo_minutos": 120}))
        self.assertEqual(api.definir_agendamento_dashboard(True, 120)["intervalo_minutos"], 120)
        api._chamar.assert_called_once_with("PUT", "/api/automacao/dashboard/agendamento",
                                            corpo={"ativo": True, "intervalo_minutos": 120})
        api._chamar = Mock()
        for invalid in (45, "60", True):
            self.assertIn("erro", api.definir_agendamento_dashboard(True, invalid))
        api._chamar.assert_not_called()
        api._chamar = Mock(return_value=(True, {"ativo": True, "intervalo_minutos": 90, "caminho": "private"}))
        consulta = api.consultar_agendamento_dashboard()
        self.assertEqual(consulta["intervalo_minutos"], 90)
        self.assertNotIn("caminho", str(consulta))
        api._chamar = Mock(return_value=(True, {"ativo": True}))
        self.assertEqual(api.consultar_agendamento_dashboard()["intervalo_minutos"], 30)

    def test_two_scheduler_instances_share_the_file_lock(self):
        from concurrent.futures import ThreadPoolExecutor
        self.scheduler.definir_ativo(True)
        self.now += timedelta(minutes=30)
        other = AgendadorDashboard(self.path, self.start, agora=lambda: self.now)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda scheduler: scheduler.verificar(), [self.scheduler, other]))
        self.assertEqual(results.count("iniciada"), 1)
        self.start.assert_called_once_with("dashboard")

    def test_changed_import_rejects_update_and_both_finalization_paths_before_writes(self):
        from domains import sebrae_novos
        from routers.sebrae_dashboard import (create_sebrae_dashboard_router, SebraeDashboardServices,
                                             AtualizarPayload, FinalizarPayload)
        paths = sebrae_novos.caminhos_padrao(Path(self.tmp.name))
        sebrae_novos.salvar_existentes(paths.existentes, ["UTIC-2026-1"], "first.xlsx")
        old = sebrae_novos.ler_existentes(paths.existentes)["versao"]
        sebrae_novos.salvar_existentes(paths.existentes, ["UTIC-2026-1"], "second.xlsx")
        self.assertNotEqual(old, sebrae_novos.ler_existentes(paths.existentes)["versao"])
        router = create_sebrae_dashboard_router(SebraeDashboardServices(
            caminhos=lambda: paths, max_upload_bytes=lambda: 10000, registros=lambda: [],
            relatorio_chamados=lambda: None, runner=lambda: self.start))
        routes = {route.path: route.endpoint for route in router.routes if "POST" in route.methods}
        cases = [
            ("/api/sebrae/dashboard/atualizar", AtualizarPayload()),
            ("/api/sebrae/dashboard/atualizar", AtualizarPayload(versao_importacao=old)),
            ("/api/sebrae/dashboard/atualizar", AtualizarPayload(versao_importacao=old, finalizar_softexpert=True)),
            ("/api/sebrae/finalizar-softexpert", FinalizarPayload(numero="UTIC-2026-1", confirmado=True, versao_importacao=old)),
            ("/api/sebrae/finalizar-softexpert", FinalizarPayload(numero="UTIC-2026-1", confirmado=True)),
        ]
        for url, payload in cases:
            with self.subTest(url=url, payload=payload):
                with self.assertRaises(DomainConflictError):
                    routes[url](payload)
        self.start.assert_not_called()
        self.assertFalse(sebrae_novos.caminho_saida(paths, "Dashboard Operacional_SEBRAE.xlsx").exists())

    def test_pending_output_skips_schedule_without_starting_chrome(self):
        scheduler = AgendadorDashboard(self.path, self.start, agora=lambda: self.now,
                                        impedimento=lambda: "Dashboard atualizado aguardando envio")
        scheduler.definir_ativo(True)
        self.now += timedelta(minutes=30)
        self.assertEqual(scheduler.verificar(), "pulado: saída pendente")
        self.assertIn("aguardando envio", scheduler.resumo()["bloqueio"])
        self.start.assert_not_called()

    def test_pending_output_blocks_automatic_import_but_manual_import_preserves_bytes(self):
        import json
        from domains import sebrae_novos, sebrae_finalizacao
        from routers.sebrae_dashboard import create_sebrae_dashboard_router, SebraeDashboardServices, NOME_ATUALIZADO
        from tests.test_sebrae_dashboard_gravacao import montar
        paths = sebrae_novos.caminhos_padrao(Path(self.tmp.name))
        router = create_sebrae_dashboard_router(SebraeDashboardServices(
            caminhos=lambda: paths, max_upload_bytes=lambda: 1000000, registros=lambda: [],
            relatorio_chamados=lambda: None))
        endpoint = next(route.endpoint for route in router.routes if route.path == "/api/sebrae/dashboard")
        contents = montar(("UTIC-2026-1",), status=("EM ABERTO",))
        imported = dict(zip(endpoint.__code__.co_freevars, (cell.cell_contents for cell in endpoint.__closure__)))
        def upload(automatico):
            return imported["_importar_bloqueado"](contents, frozenset(("UTIC-2026-1",)), "Dashboard.xlsx", automatico)
        upload(False)
        version = sebrae_novos.ler_existentes(paths.existentes)["versao"]
        output = sebrae_novos.caminho_saida(paths, NOME_ATUALIZADO)
        output.parent.mkdir(parents=True, exist_ok=True)
        pending = b"manually updated output, never sent"
        output.write_bytes(pending)
        self.assertTrue(sebrae_novos.dashboard_saida_pendente(paths))
        with self.assertRaises(DomainConflictError):
            upload(True)
        self.assertEqual(output.read_bytes(), pending)
        self.assertEqual(sebrae_novos.ler_existentes(paths.existentes)["versao"], version)
        response = upload(False)
        self.assertTrue(json.loads(response.body)["saida_anterior_preservada"])
        self.assertEqual([p.read_bytes() for p in (output.parent / "preservados").glob("*.xlsx")], [pending])
        self.assertFalse(output.exists())
        output.write_bytes(contents)
        import hashlib
        sebrae_finalizacao.gravar_enviado(paths.existentes.parent, hashlib.sha256(contents).hexdigest(), contents)
        self.assertFalse(sebrae_novos.dashboard_saida_pendente(paths))
        upload(True)  # confirmed-sent output does not block the automatic refresh


if __name__ == "__main__":
    unittest.main()
