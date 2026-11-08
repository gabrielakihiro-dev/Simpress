import unittest

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from routers.automation import AutomationRouteServices, create_automation_router
from security.limite_taxa import LimiteTaxa


class LimiteTaxaTests(unittest.TestCase):
    def test_window_slides_and_reports_the_wait(self) -> None:
        agora = [100.0]
        limite = LimiteTaxa(2, janela=60, relogio=lambda: agora[0])
        limite.exigir()
        agora[0] = 130.0
        limite.exigir()
        with self.assertRaises(HTTPException) as erro:
            limite.exigir()
        self.assertEqual(erro.exception.status_code, 429)
        self.assertEqual(erro.exception.headers, {"Retry-After": "31"})
        agora[0] = 160.0  # the first call left the window; the refused one was not counted
        limite.exigir()
        with self.assertRaises(HTTPException):
            limite.exigir()

    def test_automation_start_is_capped_per_minute(self) -> None:
        iniciadas = []

        class Runner:
            def start(self, rotina):
                iniciadas.append(rotina)
                return {"rotina": rotina}

        app = FastAPI()
        app.include_router(create_automation_router(AutomationRouteServices(runner=Runner, sebrae=lambda: None)))  # type: ignore[arg-type]
        client = TestClient(app)
        for _ in range(10):
            self.assertEqual(client.post("/api/automacao/executar", json={"rotina": "os"}).status_code, 202)
        recusada = client.post("/api/automacao/executar", json={"rotina": "os"})
        self.assertEqual(recusada.status_code, 429)
        self.assertEqual(len(iniciadas), 10)


if __name__ == "__main__":
    unittest.main()
