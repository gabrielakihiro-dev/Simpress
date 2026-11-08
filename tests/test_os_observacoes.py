"""Observação do andamento da aba OS (F6): gravação local, chave normalizada e limites da rota."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient
from security import sessao_local
from pydantic import ValidationError

from core.errors import DomainBusyError, DomainValidationError
from domains.os_observacoes import chave_os
from routers.operations import OsObservacaoPayload, create_operations_router

ROTA = "/api/operacoes/chamados/observacoes"


def route_handler(router, path, method):
    return next(route.endpoint for route in router.routes if route.path == path and method in route.methods)


class OsObservacoesTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.root = Path(self._dir.name)
        self.arquivo = self.root / "data" / "state" / "os_observacoes.json"
        router = create_operations_router(
            load_comparison_history=lambda: [],
            comparison_history_for_display=lambda event: event,
            ticket_report_path=lambda: self.root / "tickets.json",
            transaction_root=lambda: self.root,
            ticket_os_notes_file=lambda: self.arquivo,
        )
        self.ler = route_handler(router, ROTA, "GET")
        self.salvar = route_handler(router, ROTA, "PUT")

    def tearDown(self):
        self._dir.cleanup()

    def test_chave_igual_a_do_front(self):
        self.assertEqual(chave_os(" sn-1 ", " 72 85 "), '["SN1","7285"]')
        with self.assertRaises(DomainValidationError):
            chave_os("--", "7285")

    def test_salva_le_mascara_e_apaga_com_texto_vazio(self):
        self.assertEqual(self.ler(), {"observacoes": []})
        salvo = self.salvar(OsObservacaoPayload(serie=" SN-1 ", os="7285", observacao="Ligar CPF 123.456.789-09\r\n"))
        self.assertEqual(salvo["serie"], "SN-1")
        self.assertNotIn("123.456.789-09", salvo["observacao"])
        self.assertTrue(salvo["atualizado_em"])
        # Outra grafia da mesma série e OS substitui a mesma entrada.
        self.salvar(OsObservacaoPayload(serie="sn1", os="72 85", observacao="Peça pedida"))
        self.assertEqual([item["observacao"] for item in self.ler()["observacoes"]], ["Peça pedida"])
        self.assertEqual(list(json.loads(self.arquivo.read_text(encoding="utf-8"))), ['["SN1","7285"]'])
        self.salvar(OsObservacaoPayload(serie="SN-1", os="7285", observacao="   "))
        self.assertEqual(self.ler(), {"observacoes": []})

    def test_arquivo_invalido_e_preservado(self):
        self.arquivo.parent.mkdir(parents=True)
        self.arquivo.write_text("[1]", encoding="utf-8")
        with self.assertRaises(DomainBusyError):
            self.ler()
        with self.assertRaises(DomainBusyError):
            self.salvar(OsObservacaoPayload(serie="SN-1", os="7285", observacao="x"))
        self.assertEqual(self.arquivo.read_text(encoding="utf-8"), "[1]")

    def test_payload_recusa_excesso_campos_extras_e_serie_vazia(self):
        with self.assertRaises(ValidationError):
            OsObservacaoPayload(serie="SN-1", os="7285", observacao="x" * 4001)
        with self.assertRaises(ValidationError):
            OsObservacaoPayload(serie="SN-1", os="7285", observacao="x", outro=1)
        with self.assertRaises(ValidationError):
            OsObservacaoPayload(serie="  ", os="7285", observacao="x")


class OsObservacoesHttpTests(unittest.TestCase):
    def test_rota_recusa_origem_externa_e_texto_longo_sem_gravar(self):
        import main

        client = TestClient(main.app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 50000), cookies={sessao_local.nome_cookie(main.SERVER_PORT): sessao_local.SEGREDO})
        with mock.patch("routers.operations.salvar_observacao") as salvar:
            externo = client.put(ROTA, json={"serie": "SN-1", "os": "7285", "observacao": "x"},
                                 headers={"Sec-Fetch-Site": "cross-site"})
            longo = client.put(ROTA, json={"serie": "SN-1", "os": "7285", "observacao": "x" * 4001})
        self.assertEqual(externo.status_code, 403)
        self.assertEqual(longo.status_code, 422)
        salvar.assert_not_called()


if __name__ == "__main__":
    unittest.main()
