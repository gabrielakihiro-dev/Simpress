"""Busca da Home por chamado Sebrae e OS: ``GET /api/buscar/chamados-os``, só leitura, dados sintéticos."""

import json
import logging
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from domains.busca_chamados_os import buscar_chamados, buscar_os
from routers.operations import create_operations_router

CPF = "123.456.789-09"
NOME = "Beltrano Sintetico da Silva"


def ordem(fonte, os, utic=None):
    return {"fonte": fonte, "os": os, "serie": "ABC123", "status": "Aberta", "fila": "", "dias_aberta": None,
            "utic": {"chamado": utic, "origem": "Manual"} if utic else None}


class DominioTests(unittest.TestCase):
    def test_chamados_parciais_aba_ordem_dedup_e_limite(self):
        fontes = {"novos": ["UTIC-2026-15"], "antigos": ["UTIC-2026-15", "UTIC-2026-150"], "finalizados": ["UTIC-2026-1"]}
        self.assertEqual(buscar_chamados(fontes, "ABC123"), [])
        self.assertEqual(buscar_chamados(fontes, "utic-2026-15"),
                         [{"numero": "UTIC-2026-15", "aba": "novos"}, {"numero": "UTIC-2026-150", "aba": "antigos"}])
        self.assertEqual(buscar_chamados(fontes, "2026-15")[0], {"numero": "UTIC-2026-15", "aba": "novos"})
        self.assertEqual(len(buscar_chamados({"antigos": [f"UTIC-2026-{n}" for n in range(10, 20)]}, "UTIC-2026-1")), 5)

    def test_os_so_digitos_com_quatro_ou_mais(self):
        ordens = [ordem("simpress", "7285070", "UTIC-2026-15"), ordem("oracle", "7285070"), ordem("oracle", "999")]
        achadas = buscar_os(ordens, " 7285 ")
        self.assertEqual([(o["fonte"], o["utic"]) for o in achadas], [("simpress", "UTIC-2026-15"), ("oracle", None)])
        self.assertEqual(buscar_os(ordens, "728"), [])
        self.assertEqual(buscar_os(ordens, "ABC123"), [])
        self.assertEqual(len(buscar_os([ordem("oracle", f"12345{n}") for n in range(9)], "12345")), 5)


class RotaTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(dir=tempfile.gettempdir())
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.numeros = {"novos": ["UTIC-2026-15"], "antigos": ["UTIC-2026-20"], "finalizados": ["UTIC-2026-30"]}

    def client(self):
        router = create_operations_router(
            load_comparison_history=lambda: [], comparison_history_for_display=lambda e: e,
            ticket_report_path=lambda: self.root / "tickets.json", transaction_root=lambda: self.root,
            ticket_os_links_file=lambda: self.root / "vinculos.json",
            sebrae_ticket_numbers=lambda: self.numeros,
        )
        app = FastAPI()
        app.include_router(router)
        return TestClient(app)

    def write_report(self, links=None):
        row = {"serie": "ABC123", "simpress": {"ordens_servico": ["7285070"], "status": ["Aberta"]},
               "oracle": [{"ordem_servico": "7285070", "status": "Em atendimento", "usuario": NOME}]}
        snap = {"id": "imp-1", "atualizado_em": "2026-11-01T09:00:00", "fontes": {}, "resumo": {}, "chamados": [row]}
        (self.root / "tickets.json").write_text(json.dumps({**{k: snap[k] for k in ("atualizado_em", "fontes", "resumo", "chamados")},
                                                            "snapshot_id": "imp-1", "historico": [snap]}), encoding="utf-8")
        (self.root / "vinculos.json").write_text(json.dumps({"version": 1, "vinculos": links or {}}), encoding="utf-8")

    def test_validacao_do_termo(self):
        client = self.client()
        self.assertEqual(client.get("/api/buscar/chamados-os", params={"q": "a"}).status_code, 422)
        self.assertEqual(client.get("/api/buscar/chamados-os", params={"q": "a" * 201}).status_code, 422)
        self.assertEqual(client.get("/api/buscar/chamados-os").status_code, 422)

    def test_chamados_e_os_com_vinculo_sem_campos_extras(self):
        link = {"fonte": "oracle", "serie": "ABC123", "os": "7285070", "ano": 2026, "numero": "15", "chamado": "UTIC-2026-15"}
        self.write_report({json.dumps(["oracle", "ABC123", "7285070"], separators=(",", ":")): link})
        client = self.client()
        self.assertEqual(client.get("/api/buscar/chamados-os", params={"q": "2026-20"}).json(),
                         {"chamados": [{"numero": "UTIC-2026-20", "aba": "antigos"}], "os": []})
        corpo = client.get("/api/buscar/chamados-os", params={"q": "7285"}).json()
        self.assertEqual(corpo["chamados"], [])
        self.assertEqual({(o["fonte"], o["os"], o["utic"]) for o in corpo["os"]},
                         {("simpress", "7285070", None), ("oracle", "7285070", "UTIC-2026-15")})
        self.assertEqual(set(corpo["os"][0]), {"fonte", "os", "serie", "status", "utic"})
        self.assertNotIn(NOME, json.dumps(corpo))
        self.assertEqual(client.get("/api/buscar/chamados-os", params={"q": "ABC123"}).json(), {"chamados": [], "os": []})

    def test_relatorio_ausente_ou_ilegivel_nao_derruba(self):
        client = self.client()
        self.assertEqual(client.get("/api/buscar/chamados-os", params={"q": "7285"}).json(), {"chamados": [], "os": []})
        (self.root / "tickets.json").write_text("{", encoding="utf-8")
        self.assertEqual(client.get("/api/buscar/chamados-os", params={"q": "7285"}).json(), {"chamados": [], "os": []})

    def test_sem_leitor_de_chamados(self):
        router = create_operations_router(
            load_comparison_history=lambda: [], comparison_history_for_display=lambda e: e,
            ticket_report_path=lambda: self.root / "tickets.json", transaction_root=lambda: self.root)
        app = FastAPI()
        app.include_router(router)
        self.assertEqual(TestClient(app).get("/api/buscar/chamados-os", params={"q": "UTIC-2026"}).json(), {"chamados": [], "os": []})

    def test_termo_nunca_aparece_no_log(self):
        (self.root / "tickets.json").write_text("{", encoding="utf-8")  # força o caminho de falha
        with self.assertLogs(level=logging.DEBUG) as logs:
            logging.getLogger().debug("sentinela")
            self.client().get("/api/buscar/chamados-os", params={"q": "7285070"})
        self.assertTrue(any("HTTP 503" in linha for linha in logs.output))
        # the test client's own httpx line carries the URL; the server code must not
        self.assertNotIn("7285070", "\n".join(r.getMessage() for r in logs.records if r.name != "httpx"))


class MainFontesTests(unittest.TestCase):
    """``_sebrae_ticket_numbers`` do main: fonte ilegível é pulada; só números, nunca CPF, nome ou usuário (LGPD)."""

    def test_fontes_ilegiveis_e_lgpd(self):
        import main
        with tempfile.TemporaryDirectory(dir=tempfile.gettempdir()) as tmp:
            state = Path(tmp)
            (state / "sebrae_dashboard_existentes.json").write_text(json.dumps({
                "numeros": ["UTIC-2026-99"], "abertos": [{"chamado": "UTIC-2026-20", "usuario": NOME}]}), encoding="utf-8")
            (state / "sebrae_novos.json").write_text(json.dumps({"chamados": [
                {"numero": "UTIC-2026-15", "titulo": f"CPF {CPF}", "solicitante": NOME}]}), encoding="utf-8")
            with patch.object(main, "STATE_DIR", state), self.assertLogs(level=logging.DEBUG) as logs:
                logging.getLogger().debug("sentinela")
                with patch.object(main.sebrae_finalizacao, "finalizados_no_dashboard", side_effect=ValueError("x")):
                    fontes = main._sebrae_ticket_numbers()
            resposta = json.dumps({"chamados": buscar_chamados(fontes, "UTIC-2026")})
            self.assertEqual(fontes, {"novos": ["UTIC-2026-15"], "antigos": ["UTIC-2026-20"], "finalizados": []})
            for proibido in (CPF, NOME, "usuario", "titulo", "solicitante"):
                self.assertNotIn(proibido, resposta)
            self.assertTrue(any("ValueError" in linha for linha in logs.output))


if __name__ == "__main__":
    unittest.main()
