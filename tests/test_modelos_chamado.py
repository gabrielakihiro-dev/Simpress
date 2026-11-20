"""Padrões do Chamado manual (Home F1): ``config/modelos_chamado.json``. Só pasta temporária e textos sintéticos."""

import json
import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.modelos_chamado import create_modelos_chamado_router


class ModelosChamadoTests(unittest.TestCase):
    def setUp(self) -> None:
        self.pasta = tempfile.TemporaryDirectory()
        self.arquivo = Path(self.pasta.name) / "modelos_chamado.json"
        app = FastAPI()
        app.include_router(create_modelos_chamado_router(self.arquivo))
        self.cliente = TestClient(app)

    def tearDown(self) -> None:
        self.pasta.cleanup()

    def test_sem_arquivo_lista_vazia_e_nada_gravado(self) -> None:
        resposta = self.cliente.get("/api/modelos-chamado")
        self.assertEqual(resposta.status_code, 200)
        self.assertEqual(resposta.json(), {"modelos": {}})
        self.assertFalse(self.arquivo.exists())

    def test_salva_e_le_o_padrao(self) -> None:
        corpo = {"rotulo": "  Visita técnica ", "texto": "Linha 1\n\tLinha 2"}
        resposta = self.cliente.put("/api/modelos-chamado/deslocamento", json=corpo)
        self.assertEqual(resposta.status_code, 200)
        esperado = {"deslocamento": {"rotulo": "Visita técnica", "texto": "Linha 1\n\tLinha 2"}}
        self.assertEqual(resposta.json(), {"modelos": esperado})
        self.assertEqual(json.loads(self.arquivo.read_text(encoding="utf-8")), esperado)
        self.cliente.put("/api/modelos-chamado/uso-inadequado", json={"rotulo": "Uso", "texto": "T"})
        self.assertEqual(set(self.cliente.get("/api/modelos-chamado").json()["modelos"]), {"deslocamento", "uso-inadequado"})

    def test_recusa_entrada_invalida_sem_gravar(self) -> None:
        casos = [
            ("outro", {"rotulo": "A", "texto": "B"}, 404),
            ("deslocamento", {"rotulo": " ", "texto": "B"}, 422),
            ("deslocamento", {"rotulo": "A" * 41, "texto": "B"}, 422),
            ("deslocamento", {"rotulo": "A\nB", "texto": "B"}, 422),
            ("deslocamento", {"rotulo": "A", "texto": "B" * 2501}, 422),
            ("deslocamento", {"rotulo": "A", "texto": "B\x00"}, 422),
            ("deslocamento", {"rotulo": "A", "texto": "B", "extra": 1}, 422),
        ]
        for slug, corpo, status in casos:
            with self.subTest(slug=slug, corpo=corpo):
                self.assertEqual(self.cliente.put(f"/api/modelos-chamado/{slug}", json=corpo).status_code, status)
        self.assertFalse(self.arquivo.exists())

    def test_arquivo_ilegivel_preservado(self) -> None:
        self.arquivo.write_text("{quebrado", encoding="utf-8")
        self.assertEqual(self.cliente.get("/api/modelos-chamado").status_code, 503)
        self.assertEqual(self.cliente.put("/api/modelos-chamado/deslocamento", json={"rotulo": "A", "texto": "B"}).status_code, 503)
        self.assertEqual(self.arquivo.read_text(encoding="utf-8"), "{quebrado")

    def test_ignora_chaves_desconhecidas(self) -> None:
        self.arquivo.write_text(json.dumps({"x": {"rotulo": "X"}, "deslocamento": {"rotulo": "D", "texto": 3}}), encoding="utf-8")
        self.assertEqual(self.cliente.get("/api/modelos-chamado").json(), {"modelos": {"deslocamento": {"rotulo": "D", "texto": ""}}})


if __name__ == "__main__":
    unittest.main()
