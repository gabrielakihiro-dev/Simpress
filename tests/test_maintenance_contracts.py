import asyncio
import io
import re
import tempfile
import unittest
import zipfile
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

import app_config


with patch(
    "openpyxl.load_workbook",
    side_effect=RuntimeError("testes não acessam planilhas locais"),
):
    with redirect_stdout(io.StringIO()):
        import main


PROJECT_ROOT = Path(__file__).resolve().parents[1]


class MaintenanceContractTests(unittest.TestCase):
    def test_application_paths_remain_project_relative_and_reexported(self):
        self.assertEqual(app_config.BASE_DIR, PROJECT_ROOT.resolve())
        self.assertEqual(main.BASE_DIR, app_config.BASE_DIR)

        for name in (
            "STATIC_DIR",
            "INPUT_DIR",
            "TEMPLATE_FILE",
            "DETAILS_UPLOAD_FILE",
            "ENDPOINT_UPLOAD_FILE",
            "DETAILS_EXPORT_BASELINE_FILE",
            "EXPORT_MODEL_FILE",
            "UPLOAD_BACKUPS_DIR",
            "CUSTOM_UNIDADES_FILE",
            "MODIFIED_APELIDOS_FILE",
            "ALIAS_HISTORY_FILE",
            "COMPARISON_HISTORY_FILE",
            "TRANSACTION_ROOT",
        ):
            with self.subTest(path=name):
                self.assertEqual(getattr(main, name), getattr(app_config, name))

    def test_openapi_keeps_existing_route_and_method_contracts(self):
        expected = {
            "/": {"get"},
            "/api/equipamento/{serial}": {"get"},
            "/api/equipamento/salvar": {"post"},
            "/api/equipamento/atualizar-apelido": {"post"},
            "/api/historico-alteracoes": {"get"},
            "/api/historico-apelidos": {"get"},
            "/api/historico-comparacoes": {"get"},
            "/api/historico-comparacoes/{evento_id}": {"get", "delete"},
            "/api/historico-alteracoes/{evento_id}": {"delete"},
            "/api/historico-apelidos/{evento_id}": {"delete"},
            "/api/equipamento/apelido/desfazer": {"post"},
            "/api/equipamento/apelidos-modificados": {"get"},
            "/api/exportar-equipamentos": {"get"},
            "/api/recarregar-base": {"post"},
            "/api/planilhas/atualizar": {"post"},
            "/api/unidade/salvar": {"post"},
            "/api/unidades": {"get"},
            "/api/buscar": {"get"},
            "/api/stats": {"get"},
            "/api/gerar-planilha": {"post"},
        }

        paths = main.app.openapi()["paths"]
        for path, methods in expected.items():
            with self.subTest(path=path):
                self.assertIn(path, paths)
                self.assertTrue(methods.issubset(paths[path]))

    def test_non_xlsx_upload_is_rejected_before_workbook_processing(self):
        with self.assertRaises(main.HTTPException) as raised:
            main.validate_uploaded_workbook(b"fictional invalid upload", "endpoint")

        self.assertEqual(raised.exception.status_code, 400)

    def test_frontend_references_assets_served_from_the_existing_static_mount(self):
        index_file = app_config.STATIC_DIR / "index.html"
        html = index_file.read_text(encoding="utf-8")
        self.assertIn('<link rel="stylesheet" href="/static/vendor/fonts.css">', html)
        self.assertIn('<link rel="stylesheet" href="/static/vendor/tailwind-3.4.17.css">', html)
        self.assertIn('<script src="/static/vendor/lucide-1.48.0.min.js"></script>', html)
        self.assertIn('<link rel="stylesheet" href="/static/app.css">', html)
        self.assertIn('<script src="/static/transfer-utils.js"></script>', html)
        self.assertIn('<script src="/static/app.js"></script>', html)
        self.assertNotRegex(html, r"https://(?:fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.tailwindcss\.com|unpkg\.com)")
        self.assertTrue((app_config.STATIC_DIR / "app.css").is_file())
        self.assertTrue((app_config.STATIC_DIR / "app.js").is_file())
        self.assertTrue((app_config.STATIC_DIR / "transfer-utils.js").is_file())
        self.assertTrue((app_config.STATIC_DIR / "vendor" / "fonts.css").is_file())
        self.assertTrue((app_config.STATIC_DIR / "vendor" / "tailwind-3.4.17.css").is_file())
        self.assertTrue((app_config.STATIC_DIR / "vendor" / "lucide-1.48.0.min.js").is_file())

        mounts = [
            route for route in main.app.routes
            if getattr(route, "name", None) == "static"
        ]
        self.assertEqual(len(mounts), 1)
        self.assertEqual(mounts[0].path, "/static")

    def test_restore_invalidates_stale_equipment_and_refreshes_inventory_views(self):
        script = (app_config.STATIC_DIR / "app.js").read_text(encoding="utf-8")
        invalidation_start = script.index("function invalidarDadosEquipamentoAposRestauracao()")
        invalidation_end = script.index("const inputSerialInicial", invalidation_start)
        invalidation = script[invalidation_start:invalidation_end]
        self.assertIn('serialInput.value = ""', invalidation)
        self.assertIn("invalidarBuscasEquipamento()", invalidation)
        self.assertIn("limparSelecaoEquipamento()", invalidation)
        self.assertIn("fecharAutocomplete()", invalidation)

        restore_start = script.index("async function restaurarHistoricoComparacao")
        restore_end = script.index("async function consultarHistoricoComparacao", restore_start)
        restore = script[restore_start:restore_end]
        for refresh in (
            "invalidarDadosEquipamentoAposRestauracao()",
            "carregarEstatisticas()",
            "carregarUnidades()",
            "carregarHistoricoComparacoes()",
            "carregarContagemHistoricoComparacoes()",
        ):
            with self.subTest(refresh=refresh):
                self.assertIn(refresh, restore)

    def test_dialog_overlays_stack_above_the_header_and_keep_keyboard_trapping(self):
        html = (app_config.STATIC_DIR / "index.html").read_text(encoding="utf-8")
        css = (app_config.STATIC_DIR / "app.css").read_text(encoding="utf-8")
        script = (app_config.STATIC_DIR / "app.js").read_text(encoding="utf-8")

        dialogs = re.findall(r'<div id="(modal-[^"]+)" class="([^"]+)"', html)
        self.assertGreater(len(dialogs), 0)
        for dialog_id, class_names in dialogs:
            with self.subTest(dialog=dialog_id):
                self.assertIn("modal-overlay", class_names)

        overlay = re.search(r"\.modal-overlay\s*\{\s*z-index:\s*(\d+)\s*!important;\s*\}", css)
        header = re.search(r"\.site-header\s*\{\s*z-index:\s*(\d+)\s*!important;\s*\}", css)
        self.assertIsNotNone(overlay)
        self.assertIsNotNone(header)
        self.assertGreater(int(overlay.group(1)), int(header.group(1)))
        self.assertIn('dialog.setAttribute("aria-modal", "true")', script)
        self.assertIn('if (event.key === "Escape")', script)
        self.assertIn('if (event.key !== "Tab") return;', script)
        self.assertIn("event.shiftKey", script)
        self.assertIn("target.focus({ preventScroll: true })", script)

    def test_startup_readiness_maps_missing_files_to_unavailable_functions(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            details = root / "EquipamentosDetalhes_atual.xlsx"

            with zipfile.ZipFile(details, "w") as archive:
                archive.writestr("[Content_Types].xml", "<Types/>")
                archive.writestr("xl/workbook.xml", "<workbook/>")

            with (
                patch.object(main, "get_primary_equipment_file", return_value=details),
                patch.object(main, "get_details_files", return_value=[details]),
                patch.object(main, "TEMPLATE_FILE", root / "template.xlsx"),
                patch.object(main, "DETAILS_UPLOAD_FILE", details),
                patch.object(main, "ENDPOINT_UPLOAD_FILE", root / "endpoint.xlsx"),
                patch.object(main, "EXPORT_MODEL_FILE", root / "export.xlsx"),
            ):
                report = main.get_startup_readiness()

            self.assertTrue(report["files"]["inventario_equipamentos"]["available"])
            self.assertFalse(report["functions"]["geracao_transferencia"]["available"])
            self.assertEqual(
                report["functions"]["geracao_transferencia"]["missing_files"],
                ["template.xlsx"],
            )
            self.assertFalse(report["functions"]["comparacao_atualizacao_inventarios"]["available"])
            self.assertEqual(
                report["functions"]["comparacao_atualizacao_inventarios"]["missing_files"],
                ["endpoint.xlsx"],
            )
            self.assertFalse(report["functions"]["exportacao_equipamentos"]["available"])

    def test_startup_readiness_marks_corrupt_xlsx_package_unavailable(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "bad.xlsx"
            path.write_bytes(b"not an xlsx archive")

            status = main._check_startup_xlsx(path)

        self.assertFalse(status["available"])
        self.assertEqual(status["reason"], "arquivo inacessível ou XLSX inválido")

    def test_application_startup_reports_readiness_without_workbook_values(self):
        output = io.StringIO()

        async def run_application_lifespan():
            async with main.app.router.lifespan_context(main.app):
                pass

        with redirect_stdout(output):
            asyncio.run(run_application_lifespan())

        self.assertIn("[PRONTIDÃO] Verificação dos arquivos locais:", output.getvalue())
        self.assertIn(
            "[PRONTIDÃO] Geração de planilha de transferência: arquivos necessários presentes (checagem estrutural).",
            output.getvalue(),
        )


if __name__ == "__main__":
    unittest.main()
