"""Assinatura do técnico (PDF dos Termos): ``GET /api/assinatura-tecnico``.

Só SVG sintético e pasta temporária: o ``data/state`` real nunca é lido aqui.
"""

import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

import main
from routers.assinatura_tecnico import LIMITE_BYTES, create_assinatura_tecnico_router

SVG_SINTETICO = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40">'
    '<path d="M5 30 C 20 5, 35 35, 50 20 S 80 10, 95 25" fill="none" stroke="#000" stroke-width="2"/></svg>'
)
CABECALHOS_ESPERADOS = {
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
}


class AssinaturaTecnicoTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.arquivo = Path(temp.name) / "assinatura_tecnico.svg"
        app = FastAPI()
        app.include_router(create_assinatura_tecnico_router(self.arquivo))
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def pedir(self):
        return self.client.get("/api/assinatura-tecnico")

    def test_sem_arquivo_devolve_404_json_e_nao_cria_o_arquivo(self):
        resposta = self.pedir()
        self.assertEqual(resposta.status_code, 404)
        self.assertEqual(resposta.json()["codigo"], "assinatura_ausente")
        self.assertFalse(self.arquivo.exists())

    def test_arquivo_valido_devolve_svg_com_os_tres_cabecalhos(self):
        self.arquivo.write_text(SVG_SINTETICO, encoding="utf-8")
        resposta = self.pedir()
        self.assertEqual(resposta.status_code, 200)
        self.assertEqual(resposta.headers["content-type"], "image/svg+xml")
        for nome, valor in CABECALHOS_ESPERADOS.items():
            self.assertEqual(resposta.headers[nome], valor, nome)
        self.assertEqual(resposta.text, SVG_SINTETICO)

    def test_conteudo_que_executa_ou_busca_fora_devolve_422_sem_entregar(self):
        casos = {
            "script": SVG_SINTETICO.replace("</svg>", "<SCRIPT>alert(1)</SCRIPT></svg>"),
            "onload": SVG_SINTETICO.replace("<svg ", '<svg onload="alert(1)" '),
            "onclick em maiúsculas": SVG_SINTETICO.replace("<path ", '<path ONCLICK = "x" '),
            "javascript:": SVG_SINTETICO.replace("<path ", '<path style="fill:url(JavaScript:x)" '),
            "foreignObject": SVG_SINTETICO.replace("</svg>", "<foreignObject></foreignObject></svg>"),
            "href": SVG_SINTETICO.replace("</svg>", '<use xlink:href="#a"/></svg>'),
            "entity": '<!DOCTYPE svg [<!ENTITY a "b">]>' + SVG_SINTETICO,
        }
        for nome, conteudo in casos.items():
            with self.subTest(nome):
                self.arquivo.write_text(conteudo, encoding="utf-8")
                resposta = self.pedir()
                self.assertEqual(resposta.status_code, 422)
                self.assertEqual(resposta.json()["codigo"], "assinatura_invalida")
                self.assertNotIn("svg", resposta.headers["content-type"])
                self.assertNotIn("alert(1)", resposta.text)

    def test_arquivo_acima_de_64_kb_devolve_422(self):
        self.arquivo.write_text(SVG_SINTETICO + " " * LIMITE_BYTES, encoding="utf-8")
        resposta = self.pedir()
        self.assertEqual(resposta.status_code, 422)
        self.assertEqual(resposta.json()["codigo"], "assinatura_invalida")

    def test_arquivo_que_nao_e_utf8_devolve_422(self):
        self.arquivo.write_bytes(b"\xff\xfe\x00<svg/>")
        self.assertEqual(self.pedir().status_code, 422)

    def test_arquivo_sem_svg_devolve_422(self):
        self.arquivo.write_text("<html><body>texto qualquer</body></html>", encoding="utf-8")
        self.assertEqual(self.pedir().status_code, 422)


class SessaoTests(unittest.TestCase):
    def test_sem_cookie_de_sessao_devolve_401(self):
        """O middleware do app real barra antes da rota: a assinatura não é lida."""
        client = TestClient(main.app, base_url=f"http://127.0.0.1:{main.SERVER_PORT}", client=("127.0.0.1", 1234))
        self.addCleanup(client.close)
        self.assertEqual(client.get("/api/assinatura-tecnico").status_code, 401)

    def test_rota_esta_registrada_no_app(self):
        self.assertEqual(set(main.app.openapi()["paths"]["/api/assinatura-tecnico"]), {"get"})


if __name__ == "__main__":
    unittest.main()
