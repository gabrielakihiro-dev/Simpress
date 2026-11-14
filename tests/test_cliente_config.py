"""Client data (contract, billing CNPJ, own notebook series): configured locally, never in the code.

Every test uses the fictitious `config/cliente.exemplo.json` or a temporary file; the real client file and the
SIMPRESS_CLIENTE_* variables never reach these assertions.
"""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

import core.config as app_config
from core.config import CLIENT_NOT_CONFIGURED, client_billing_cnpj, client_contract, client_own_serials
from core.errors import DomainValidationError
from domains import equipment_edit, monthly_report, ux_ticket
from domains.local_setup import load_client_config, save_client_config
from domains.regras_negocio import e_serie_sebrae, series_sebrae
from domains.ux_chamados import ErroUX
from domains.ux_ticket import TicketsUX, exigir_dados_cliente
from routers.local_setup import create_local_setup_router
from routers.transfers import TransferenciaPayload
from scripts import automacao_rotinas_chrome as automacao

CLIENT_VARIABLES = (
    "SIMPRESS_CLIENTE_CONTRATO", "SIMPRESS_CLIENTE_CNPJ_FATURAMENTO", "SIMPRESS_CLIENTE_SERIES_SEBRAE_FORA",
)
EXAMPLE_FILE = app_config.BASE_DIR / "config" / "cliente.exemplo.json"
EXAMPLE_SERIES = {"BRT100XA01", "BRT100XA02", "BRT200XB0R", "BRT200XB0F", "BRT300XC01"}
VALID_CLIENT = {"contrato": "20202", "cnpj_faturamento": "44.555.666/0001-72"}
TRANSFER_FIELDS = {
    "serial": "SERIE-FICTICIA", "entrega_cnpj": "00.000.000/0000-00",
    "entrega_endereco": "DESTINO FICTICIO", "entrega_contato": "DESTINATARIO FICTICIO",
}


class ClientTestCase(unittest.TestCase):
    """Environment without client variables; ``configure`` points the helpers at a file (or at none)."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        environment = patch.dict(os.environ, {})
        environment.start()
        self.addCleanup(environment.stop)
        for variable in CLIENT_VARIABLES:
            os.environ.pop(variable, None)

    def configure(self, path):
        patcher = patch.object(app_config, "CLIENT_CONFIG_FILE", path)
        patcher.start()
        self.addCleanup(patcher.stop)

    def without_config(self):
        self.configure(self.root / "config" / "cliente.json")  # never created

    def with_example(self):
        self.configure(EXAMPLE_FILE)


class ClientConfigResolutionTests(ClientTestCase):
    def test_without_file_or_environment_everything_is_empty(self):
        self.without_config()
        self.assertEqual((client_contract(), client_billing_cnpj(), client_own_serials()), ("", "", ()))
        self.assertEqual(series_sebrae(), frozenset())
        self.assertFalse(e_serie_sebrae("BRT100XA01"))

    def test_fictitious_example_fills_every_value(self):
        self.with_example()
        self.assertEqual(client_contract(), "10101")
        self.assertEqual(client_billing_cnpj(), "11.222.333/0001-81")
        self.assertEqual(set(client_own_serials()), EXAMPLE_SERIES)
        self.assertTrue(e_serie_sebrae("brt100xa01"))
        self.assertFalse(e_serie_sebrae("BRT999ZZ99"))

    def test_environment_wins_over_the_file(self):
        self.with_example()
        os.environ["SIMPRESS_CLIENTE_CONTRATO"] = " 30303 "
        os.environ["SIMPRESS_CLIENTE_SERIES_SEBRAE_FORA"] = "BRT700XG01, BRT700XG02"
        self.assertEqual(client_contract(), "30303")
        self.assertEqual(client_own_serials(), ("BRT700XG01", "BRT700XG02"))
        self.assertEqual(client_billing_cnpj(), "11.222.333/0001-81")

    def test_values_are_read_on_every_call_and_the_series_follow_the_file(self):
        path = self.root / "cliente.json"
        self.configure(path)
        self.assertEqual(client_contract(), "")
        path.write_text(json.dumps({**VALID_CLIENT, "series_sebrae_fora": ["BRT100XA01"]}), encoding="utf-8")
        self.assertEqual(client_contract(), "20202")
        self.assertEqual(client_own_serials(), ("BRT100XA01",))
        path.write_text(json.dumps({**VALID_CLIENT, "series_sebrae_fora": ["BRT100XA01", "BRT100XA02"]}), encoding="utf-8")
        self.assertEqual(client_own_serials(), ("BRT100XA01", "BRT100XA02"))
        path.write_text("{não é json", encoding="utf-8")
        self.assertEqual((client_contract(), client_own_serials()), ("", ()))

    def test_versioned_example_is_fictitious_and_the_local_file_is_ignored(self):
        example = json.loads(EXAMPLE_FILE.read_text(encoding="utf-8"))
        self.assertEqual(set(example), {"contrato", "cnpj_faturamento", "series_sebrae_fora"})
        self.assertEqual(set(example["series_sebrae_fora"]), EXAMPLE_SERIES)
        ignored = subprocess.run(
            ["git", "check-ignore", "-q", "config/cliente.json"], cwd=app_config.BASE_DIR, check=False,
        )
        self.assertEqual(ignored.returncode, 0)

    def test_the_suite_never_reads_a_real_client_file(self):
        # tests/run_tests.py points the helpers at the example; a local config/cliente.json must not leak in.
        self.assertEqual(app_config.CLIENT_CONFIG_FILE.name, "cliente.exemplo.json")


class ClientConfigFileTests(ClientTestCase):
    def setUp(self):
        super().setUp()
        self.path = self.root / "config" / "cliente.json"

    def test_empty_when_nothing_is_configured(self):
        result = load_client_config(self.path, environment={})
        self.assertEqual((result["contrato"], result["cnpj_faturamento"], result["series_sebrae_fora"]), ("", "", []))
        self.assertFalse(result["cliente_configurado"])
        self.assertFalse(result["cliente_arquivo_invalido"])
        self.assertEqual(result["cliente_fontes"], {"contrato": "", "cnpj_faturamento": "", "series_sebrae_fora": ""})

    def test_save_round_trips_and_marks_the_file_as_the_source(self):
        save_client_config(self.path, "20202", "44.555.666/0001-72", ["BRT100XA01"])
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")), {
            "contrato": "20202", "cnpj_faturamento": "44.555.666/0001-72", "series_sebrae_fora": ["BRT100XA01"],
        })
        result = load_client_config(self.path, environment={})
        self.assertTrue(result["cliente_configurado"])
        self.assertEqual(result["cliente_fontes"]["contrato"], "arquivo")
        self.assertEqual(result["series_sebrae_fora"], ["BRT100XA01"])

    def test_series_none_keeps_the_stored_list_and_a_list_replaces_it(self):
        save_client_config(self.path, "20202", "44.555.666/0001-72", ["BRT100XA01", "BRT100XA02"])
        save_client_config(self.path, "30303", "44.555.666/0001-72")
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8"))["series_sebrae_fora"], ["BRT100XA01", "BRT100XA02"])
        save_client_config(self.path, "30303", "44.555.666/0001-72", [])
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8"))["series_sebrae_fora"], [])

    def test_environment_marks_its_fields_and_wins(self):
        save_client_config(self.path, "20202", "44.555.666/0001-72", ["BRT100XA01"])
        result = load_client_config(self.path, environment={
            "SIMPRESS_CLIENTE_CNPJ_FATURAMENTO": "11.222.333/0001-81",
            "SIMPRESS_CLIENTE_SERIES_SEBRAE_FORA": "BRT200XB0R,BRT200XB0F",
        })
        self.assertEqual(result["cnpj_faturamento"], "11.222.333/0001-81")
        self.assertEqual(result["series_sebrae_fora"], ["BRT200XB0R", "BRT200XB0F"])
        self.assertEqual(result["cliente_fontes"], {
            "contrato": "arquivo", "cnpj_faturamento": "ambiente", "series_sebrae_fora": "ambiente",
        })

    def test_partial_or_unreadable_file_is_not_configured(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text(json.dumps({"contrato": "20202", "cnpj_faturamento": 42}), encoding="utf-8")
        partial = load_client_config(self.path, environment={})
        self.assertEqual((partial["contrato"], partial["cnpj_faturamento"]), ("20202", ""))
        self.assertFalse(partial["cliente_configurado"])
        self.path.write_text("{não é json", encoding="utf-8")
        with self.assertLogs("domains.local_setup", level="WARNING"):
            broken = load_client_config(self.path, environment={})
        self.assertTrue(broken["cliente_arquivo_invalido"])
        self.assertFalse(broken["cliente_configurado"])


class RefusalWithoutClientDataTests(ClientTestCase):
    """Fail closed: with no contract configured nothing proceeds on a blank-equals-blank match."""

    def setUp(self):
        super().setUp()
        self.without_config()

    def test_ux_ticket_requires_contract_and_billing_cnpj(self):
        with self.assertRaises(ErroUX) as erro:
            exigir_dados_cliente()
        self.assertEqual(erro.exception.status, 422)
        self.assertEqual(str(erro.exception), CLIENT_NOT_CONFIGURED)
        # One of the two is not enough.
        os.environ["SIMPRESS_CLIENTE_CONTRATO"] = "20202"
        with self.assertRaises(ErroUX):
            exigir_dados_cliente()
        os.environ["SIMPRESS_CLIENTE_CNPJ_FATURAMENTO"] = "44.555.666/0001-72"
        self.assertEqual(exigir_dados_cliente(), ("20202", "44.555.666/0001-72"))

    def test_ux_ticket_service_refuses_before_opening_the_portal(self):
        conectar = MagicMock(side_effect=AssertionError("o portal não pode ser aberto sem os dados do cliente"))
        service = TicketsUX(self.root, conectar)
        with self.assertRaises(ErroUX) as erro:
            service.preparar(
                serial="abc123", entrega_endereco="Av. Tupi, 333 - Pato Branco/PR - CEP 85504-000",
                entrega_cidade="Pato Branco", entrega_cep="85504-000", entrega_cnpj="00.000.000/0000-00",
                arquivo_nome="Transferencia.xlsx", arquivo=b"xlsx",
            )
        self.assertEqual((erro.exception.status, str(erro.exception)), (422, CLIENT_NOT_CONFIGURED))
        with self.assertRaises(ErroUX) as erro:
            service.preparar_alterar_endereco(serial="abc123")
        self.assertEqual(erro.exception.status, 422)
        with self.assertRaises(ErroUX) as erro:
            service.executar(
                session_id="inexistente", serial="ABC123", descricao="Atualizar o endereço do equipamento.",
                solicitante={"nome": "Pessoa Fictícia", "email": "teste@example.test", "telefone": "(41) 99999-0000"},
                chamado_interno="", enviar=False, confirmado=False,
            )
        self.assertEqual((erro.exception.status, str(erro.exception)), (422, CLIENT_NOT_CONFIGURED))
        conectar.assert_not_called()

    def test_the_test_series_still_refuses_a_real_send_before_the_client_check(self):
        # BRM551RN1Y is a code invariant: its refusal does not depend on any client configuration.
        service = TicketsUX(self.root, MagicMock(side_effect=AssertionError("sem portal")))
        with self.assertRaises(ErroUX) as erro:
            service.executar(
                session_id="x", serial="BRM551RN1Y", descricao="Atualizar o endereço do equipamento.",
                solicitante={}, chamado_interno="", enviar=True, confirmado=True,
            )
        self.assertEqual(erro.exception.status, 422)
        self.assertNotEqual(str(erro.exception), CLIENT_NOT_CONFIGURED)

    def test_transfer_payload_is_refused_with_the_first_access_message(self):
        for contrato in (None, "", "20202"):
            with self.subTest(contrato=contrato), self.assertRaises(ValidationError) as erro:
                TransferenciaPayload(**TRANSFER_FIELDS, **({} if contrato is None else {"contrato": contrato}))
            self.assertIn(CLIENT_NOT_CONFIGURED, str(erro.exception))

    def test_equipment_edit_refuses_without_a_contract(self):
        with self.assertRaises(DomainValidationError) as erro:
            equipment_edit._configured_contract()
        self.assertEqual((erro.exception.status_code, erro.exception.detail), (422, CLIENT_NOT_CONFIGURED))

    def test_monthly_report_refuses_without_a_contract(self):
        with self.assertRaises(DomainValidationError) as erro:
            monthly_report.build_monthly_report_workbook({})
        self.assertEqual(erro.exception.status_code, 422)

    def test_chrome_routines_stop_before_opening_any_page(self):
        with self.assertRaises(automacao.RotinaErro) as erro:
            automacao.contrato_configurado()
        self.assertEqual(str(erro.exception), CLIENT_NOT_CONFIGURED)
        with patch.object(automacao, "nova_aba") as nova_aba, patch.object(automacao, "abrir_ux") as abrir_ux:
            with self.assertRaises(automacao.RotinaErro):
                automacao.exportar_oracle(MagicMock())
            with self.assertRaises(automacao.RotinaErro):
                automacao.exportar_ux_equipamentos(MagicMock())
        nova_aba.assert_not_called()
        abrir_ux.assert_not_called()
        self.assertFalse(automacao.ux_no_contrato(MagicMock(url="https://ux.exemplo.invalid/tela"), "https://ux.exemplo.invalid/tela"))


class WithClientDataTests(ClientTestCase):
    def setUp(self):
        super().setUp()
        self.with_example()

    def test_ux_ticket_reads_the_example(self):
        self.assertEqual(exigir_dados_cliente(), ("10101", "11.222.333/0001-81"))

    def test_transfer_payload_accepts_only_the_configured_contract(self):
        self.assertEqual(TransferenciaPayload(**TRANSFER_FIELDS).contrato, "10101")
        self.assertEqual(TransferenciaPayload(**TRANSFER_FIELDS, contrato=10101).contrato, "10101")
        with self.assertRaises(ValidationError) as erro:
            TransferenciaPayload(**TRANSFER_FIELDS, contrato="99999")
        self.assertIn("só gera transferências do contrato 10101", str(erro.exception))

    def test_chrome_routines_use_the_configured_contract(self):
        self.assertEqual(automacao.contrato_configurado(), "10101")
        self.assertEqual(automacao.contrato_nome("10101"), "10101 - SERV DE APOIO AS MICRO E PEQ EMP DO PARANA SEBRAE PR")

    def test_equipment_edit_uses_the_configured_contract(self):
        self.assertEqual(equipment_edit._configured_contract(), "10101")


class ClientConfigRouteTests(ClientTestCase):
    def setUp(self):
        super().setUp()
        self.path = self.root / "config" / "cliente.json"
        self.after_saved = MagicMock()
        router, _ = create_local_setup_router(
            model_path=lambda _kind: self.root / "modelo.xlsx",
            transaction_root=lambda: self.root,
            backups_directory=lambda: self.root / "backups",
            max_upload_bytes=lambda: 1024,
            parser_admission=lambda: None,
            export_dependency_paths=lambda: [],
            validate_export=lambda: None,
            client_config_file=lambda: self.path,
            after_client_config_saved=self.after_saved,
        )
        app = FastAPI()
        app.include_router(router)
        self.client = TestClient(app)

    def put(self, payload):
        return self.client.put("/api/config/cliente", json=payload)

    def test_get_reports_not_configured_until_something_is_saved(self):
        response = self.client.get("/api/config/cliente")
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["cliente_configurado"])
        self.assertEqual(response.json()["contrato"], "")

    def test_valid_data_is_written_returned_and_triggers_the_inventory_reload(self):
        response = self.put({**VALID_CLIENT, "series_sebrae_fora": [" brt100xa01 ", "BRT100XA01", "brt100xa02", ""]})
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body["cliente_configurado"])
        self.assertEqual((body["contrato"], body["cnpj_faturamento"]), ("20202", "44.555.666/0001-72"))
        self.assertEqual(body["series_sebrae_fora"], ["BRT100XA01", "BRT100XA02"])
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")), {
            **VALID_CLIENT, "series_sebrae_fora": ["BRT100XA01", "BRT100XA02"],
        })
        self.after_saved.assert_called_once_with()
        self.assertEqual(self.client.get("/api/config/cliente").json(), body)

    def test_omitted_series_keep_the_stored_list(self):
        self.put({**VALID_CLIENT, "series_sebrae_fora": ["BRT100XA01"]})
        response = self.put({**VALID_CLIENT, "contrato": "30303"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["series_sebrae_fora"], ["BRT100XA01"])
        self.assertEqual(response.json()["contrato"], "30303")

    def test_missing_or_invalid_values_are_rejected_without_writing(self):
        invalid = (
            {**VALID_CLIENT, "contrato": "  "},
            {**VALID_CLIENT, "cnpj_faturamento": ""},
            {**VALID_CLIENT, "contrato": "AB123"},
            {**VALID_CLIENT, "contrato": "1" * 13},
            {**VALID_CLIENT, "cnpj_faturamento": "44555666000172"},
            {**VALID_CLIENT, "series_sebrae_fora": ["BRT 100"]},
            {**VALID_CLIENT, "series_sebrae_fora": ["A" * 33]},
            {**VALID_CLIENT, "series_sebrae_fora": ["BRT100XA01"] * 201},
        )
        for payload in invalid:
            with self.subTest(payload=str(payload)[:80]):
                self.assertEqual(self.put(payload).status_code, 422)
        self.assertFalse(self.path.exists())
        self.after_saved.assert_not_called()

    def test_environment_fields_may_stay_blank_in_the_file(self):
        with patch.dict(os.environ, {"SIMPRESS_CLIENTE_CNPJ_FATURAMENTO": "11.222.333/0001-81"}):
            response = self.put({"contrato": "20202", "cnpj_faturamento": ""})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["cnpj_faturamento"], "11.222.333/0001-81")
        self.assertEqual(response.json()["cliente_fontes"]["cnpj_faturamento"], "ambiente")
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8"))["cnpj_faturamento"], "")

    def test_a_failed_reload_does_not_fail_the_save(self):
        self.after_saved.side_effect = RuntimeError("base indisponível")
        with self.assertLogs("routers.local_setup", level="WARNING"):
            response = self.put(VALID_CLIENT)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(self.path.exists())

    def test_a_write_failure_is_a_generic_500(self):
        with patch("routers.local_setup.save_client_config", side_effect=OSError("disco cheio")):
            with self.assertLogs("routers.local_setup", level="WARNING"):
                response = self.put(VALID_CLIENT)
        self.assertEqual(response.status_code, 500)
        self.assertNotIn("disco cheio", response.text)
        self.after_saved.assert_not_called()

    def test_routes_are_unavailable_without_a_configured_path(self):
        router, _ = create_local_setup_router(
            model_path=lambda _kind: self.root / "modelo.xlsx", transaction_root=lambda: self.root,
            backups_directory=lambda: self.root / "backups", max_upload_bytes=lambda: 1024,
            parser_admission=lambda: None, export_dependency_paths=lambda: [], validate_export=lambda: None,
        )
        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)
        self.assertEqual(client.get("/api/config/cliente").status_code, 404)
        self.assertEqual(client.put("/api/config/cliente", json=VALID_CLIENT).status_code, 404)


if __name__ == "__main__":
    unittest.main()
