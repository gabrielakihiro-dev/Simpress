"""Synthetic clock, local temporary state and fake runner: no Chrome or operational data."""
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import Mock

from core.errors import DomainConflictError
from domains.dashboard_agendamento import AgendadorDashboard
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

    def test_assistant_requires_confirmation_and_sends_boolean_body(self):
        tool = TOOLS["definir_agendamento_dashboard"]
        self.assertTrue(tool.changes_data)
        self.assertIn("30 minutos", tool.describe({"ativo": True}))
        self.assertIn("automacao", grupos_da_mensagem("agendar a cada 30 minutos"))
        api = SimpressApi.__new__(SimpressApi)
        api._chamar = Mock(return_value=(True, {"ativo": True, "caminho": "private"}))
        self.assertTrue(api.definir_agendamento_dashboard(True)["ativo"])
        api._chamar.assert_called_once_with("PUT", "/api/automacao/dashboard/agendamento", corpo={"ativo": True})
        self.assertNotIn("caminho", str(api.consultar_agendamento_dashboard()))

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
