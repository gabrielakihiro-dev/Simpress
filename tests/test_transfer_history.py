"""Transfer history route: append, list, search, retention and corrupt-file protection."""

import json
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers import transfer_history
from routers.transfer_history import TransferHistoryServices, create_transfer_history_router

VALID_PAYLOAD = {
    "serial": "brj5512fgd",
    "retirada_cidade": "Curitiba",
    "retirada_cnpj": "75.110.585/0001-00",
    "retirada_endereco": "R Caeté, 150 - Curitiba/PR",
    "entrega_cidade": "Londrina",
    "entrega_cnpj": "75.110.585/0010-00",
    "entrega_endereco": "Av Higienópolis, 100 - Londrina/PR",
    "entrega_contato": "Ana Souza",
    "entrega_email": "ana@pr.sebrae.com.br",
    "entrega_telefone": "(43) 99999-8888",
    "entrega_obs": "Substituição preventiva",
}


class TransferHistoryRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.file = self.root / "data" / "state" / "historico_transferencias.json"
        router, _ = create_transfer_history_router(TransferHistoryServices(
            history_file=lambda: self.file, transaction_root=lambda: self.root,
        ))
        app = FastAPI()
        app.include_router(router)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def post(self, **changes):
        return self.client.post("/api/historico-transferencias", json={**VALID_PAYLOAD, **changes})

    def test_python_lock_is_not_held_while_the_transaction_is_open(self):
        real = transfer_history.AtomicFileTransaction
        held = []

        class Spy(real):
            def __enter__(self):
                held.append(transfer_history._LOCK.locked())
                return super().__enter__()

        with patch.object(transfer_history, "AtomicFileTransaction", Spy):
            self.assertEqual(self.post().status_code, 201)
        self.assertEqual(held, [False])

    def test_missing_file_lists_as_empty(self):
        response = self.client.get("/api/historico-transferencias")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"total": 0, "itens": []})
        self.assertFalse(self.file.exists())

    def test_append_normalizes_serial_and_lists_newest_first(self):
        first = self.post()
        self.assertEqual(first.status_code, 201)
        self.assertTrue(first.json()["sucesso"])
        self.post(serial="zzz999", entrega_cidade="Maringá")
        items = self.client.get("/api/historico-transferencias").json()
        self.assertEqual(items["total"], 2)
        self.assertEqual([item["serial"] for item in items["itens"]], ["ZZZ999", "BRJ5512FGD"])
        stored = items["itens"][1]
        self.assertEqual(stored["entrega_cidade"], "Londrina")
        self.assertEqual(stored["payload"]["entrega_email"], "ana@pr.sebrae.com.br")
        self.assertRegex(stored["criado_em"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$")
        self.assertEqual(len(stored["id"]), 32)

    def test_invalid_payload_is_rejected_without_writing(self):
        for changes in ({"entrega_email": "ana@"}, {"entrega_telefone": "123"}, {"entrega_cnpj": "123"}, {"serial": ""}):
            with self.subTest(changes=changes):
                self.assertEqual(self.post(**changes).status_code, 422)
        self.assertFalse(self.file.exists())

    def test_search_ignores_case_and_accents_and_limit_applies(self):
        self.post()
        self.post(serial="abc1", entrega_cidade="Maringá", entrega_contato="Bruno")
        self.post(serial="abc2", entrega_cidade="Maringá", entrega_contato="Carla")
        self.assertEqual(self.client.get("/api/historico-transferencias", params={"busca": "MARINGA"}).json()["total"], 2)
        self.assertEqual(self.client.get("/api/historico-transferencias", params={"busca": "substituicao"}).json()["total"], 3)
        limited = self.client.get("/api/historico-transferencias", params={"limite": 1}).json()
        self.assertEqual((limited["total"], len(limited["itens"])), (3, 1))
        self.assertEqual(self.client.get("/api/historico-transferencias", params={"limite": 0}).status_code, 422)
        self.assertEqual(self.client.get("/api/historico-transferencias", params={"busca": "x" * 129}).status_code, 422)

    def test_retention_keeps_only_newest_records(self):
        original = transfer_history.MAX_HISTORY_RECORDS
        transfer_history.MAX_HISTORY_RECORDS = 3
        self.addCleanup(setattr, transfer_history, "MAX_HISTORY_RECORDS", original)
        for index in range(5):
            self.post(serial=f"S{index}")
        serials = [item["serial"] for item in self.client.get("/api/historico-transferencias").json()["itens"]]
        self.assertEqual(serials, ["S4", "S3", "S2"])

    def test_corrupt_file_is_preserved_and_reported(self):
        self.file.parent.mkdir(parents=True)
        for content in ("{not json", json.dumps({"nao": "uma lista"}), json.dumps(["texto"])):
            with self.subTest(content=content):
                self.file.write_text(content, encoding="utf-8")
                self.assertEqual(self.client.get("/api/historico-transferencias").status_code, 503)
                self.assertEqual(self.post().status_code, 503)
                self.assertEqual(self.file.read_text(encoding="utf-8"), content)


if __name__ == "__main__":
    unittest.main()
