"""Códigos prontos do PowerShell da Home: padrão, gravação local, validação e rotas."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient
from pydantic import ValidationError

from core.errors import DomainBusyError, DomainValidationError
from domains.powershell_codigos import SEED, ler_codigos, salvar_codigos
from routers.endpoint_lookup import CodigoPowerShellPayload, CodigosPowerShellPayload, create_endpoint_lookup_router
from security import sessao_local

ROTA = "/api/endpoint/powershell/codigos"
COMANDO_FOZ = r'Add-Printer -ConnectionName "\\prsrvvm-imp\VP_FOZDOIGUAÇU"'


def item(**campos):
    return {"id": "a1", "titulo": "Teste", "modo": "usuario", "comando": "Get-Printer", **campos}


def route_handler(router, method):
    return next(route.endpoint for route in router.routes if route.path == ROTA and method in route.methods)


class PowerShellCodigosDominioTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.arquivo = Path(self._dir.name) / "data" / "state" / "powershell_codigos.json"

    def tearDown(self):
        self._dir.cleanup()

    def test_arquivo_ausente_devolve_seed_sem_gravar(self):
        codigos = ler_codigos(self.arquivo)
        self.assertEqual(len(codigos), 31)
        self.assertEqual(codigos, list(SEED))
        self.assertFalse(self.arquivo.exists())
        self.assertEqual({c["modo"] for c in codigos}, {"usuario"})
        self.assertEqual(len({c["id"] for c in codigos}), 31)
        foz = next(c for c in codigos if c["titulo"] == "Foz do Iguaçu")
        self.assertEqual(foz["comando"], COMANDO_FOZ)
        barracao = codigos[0]
        self.assertEqual(barracao, {"id": "vp_barracao", "titulo": "Barracão", "modo": "usuario",
                                    "comando": r'Add-Printer -ConnectionName "\\prsrvvm-imp\VP_BARRACAO"'})

    def test_ler_devolve_copia_do_seed(self):
        ler_codigos(self.arquivo)[0]["titulo"] = "Alterado"
        self.assertEqual(ler_codigos(self.arquivo)[0]["titulo"], "Barracão")

    def test_salva_e_le_preservando_acentos_e_gera_id(self):
        salvo = salvar_codigos(self.arquivo, [item(titulo="  Foz do Iguaçu  ", comando=COMANDO_FOZ), item(id=None, modo="sistema")])
        self.assertEqual(salvo[0]["titulo"], "Foz do Iguaçu")
        self.assertTrue(salvo[1]["id"])
        self.assertNotEqual(salvo[1]["id"], "a1")
        self.assertEqual(ler_codigos(self.arquivo), salvo)
        self.assertIn("Iguaçu", self.arquivo.read_text(encoding="utf-8"))
        self.assertEqual(ler_codigos(self.arquivo)[0]["comando"], COMANDO_FOZ)

    def test_lista_vazia_gravada_continua_vazia(self):
        self.assertEqual(salvar_codigos(self.arquivo, []), [])
        self.assertEqual(ler_codigos(self.arquivo), [])

    def test_recusa_entradas_invalidas_sem_gravar(self):
        invalidos = {
            "quebra de linha": [item(comando="Get-Printer\nGet-Process")],
            "retorno de carro": [item(comando="Get-Printer\rGet-Process")],
            "U+2028": [item(comando="Get-Printer\u2028Get-Process")],
            "largura zero": [item(comando="Get-Printer\u200bx")],
            "comando longo": [item(comando="a" * 2001)],
            "comando vazio": [item(comando="   ")],
            "modo invalido": [item(modo="admin")],
            "titulo vazio": [item(titulo="   ")],
            "titulo longo": [item(titulo="t" * 81)],
            "titulo com controle": [item(titulo="a\nb")],
            "titulo largura zero": [item(titulo="a\u200bb")],
            "mais de 200": [item(id=f"i{n}") for n in range(201)],
            "id duplicado": [item(id="x"), item(id="x", titulo="Outro")],
            "id invalido": [item(id="a b")],
            "item que nao e objeto": ["Get-Printer"],
            "lista que nao e lista": {"codigos": []},
        }
        for nome, itens in invalidos.items():
            with self.subTest(nome):
                with self.assertRaises(DomainValidationError) as erro:
                    salvar_codigos(self.arquivo, itens)
                self.assertEqual(erro.exception.status_code, 422)
                self.assertNotIn("Get-Printer", str(erro.exception.detail))
        self.assertFalse(self.arquivo.exists())

    def test_aceita_limites(self):
        itens = [item(id=f"i{n}", titulo="t" * 80, comando="a" * 2000) for n in range(200)]
        self.assertEqual(len(salvar_codigos(self.arquivo, itens)), 200)

    def test_arquivo_ilegivel_ou_invalido_e_preservado(self):
        self.arquivo.parent.mkdir(parents=True)
        for conteudo in ("{não é json", "[1]", '{"codigos": "x"}', '{"codigos": [{"id": "a"}]}', '{"outro": []}'):
            with self.subTest(conteudo):
                self.arquivo.write_text(conteudo, encoding="utf-8")
                with self.assertRaises(DomainBusyError) as erro:
                    ler_codigos(self.arquivo)
                self.assertEqual(erro.exception.status_code, 503)
                with self.assertRaises(DomainBusyError):
                    salvar_codigos(self.arquivo, [item()])
                self.assertEqual(self.arquivo.read_text(encoding="utf-8"), conteudo)

    def test_payload_recusa_campos_extras_e_tipos_errados(self):
        with self.assertRaises(ValidationError):
            CodigoPowerShellPayload(titulo="a", modo="usuario", comando="x", extra=1)
        with self.assertRaises(ValidationError):
            CodigoPowerShellPayload(titulo=1, modo="usuario", comando="x")
        with self.assertRaises(ValidationError):
            CodigosPowerShellPayload(codigos="x")


class PowerShellCodigosRotaTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.arquivo = Path(self._dir.name) / "powershell_codigos.json"
        router = create_endpoint_lookup_router(lambda serial: {}, codigos_file=lambda: self.arquivo)
        self.ler = route_handler(router, "GET")
        self.salvar = route_handler(router, "PUT")

    def tearDown(self):
        self._dir.cleanup()

    def test_put_get_round_trip_preserva_ccedilha(self):
        self.assertEqual(len(self.ler()["codigos"]), 31)
        payload = CodigosPowerShellPayload(codigos=[
            CodigoPowerShellPayload(id="foz", titulo="Foz do Iguaçu", modo="usuario", comando=COMANDO_FOZ),
            CodigoPowerShellPayload(titulo="Sistema", modo="sistema", comando="Get-Date"),
        ])
        salvo = self.salvar(payload)["codigos"]
        self.assertEqual(self.ler()["codigos"], salvo)
        self.assertEqual(salvo[0]["comando"], COMANDO_FOZ)
        self.assertEqual(json.loads(self.arquivo.read_text(encoding="utf-8"))["codigos"], salvo)


class PowerShellCodigosHttpTests(unittest.TestCase):
    def test_http_real_com_arquivo_temporario(self):
        import main

        with tempfile.TemporaryDirectory() as pasta:
            arquivo = Path(pasta) / "powershell_codigos.json"
            client = TestClient(main.app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 50000),
                                cookies={sessao_local.nome_cookie(main.SERVER_PORT): sessao_local.SEGREDO})
            with mock.patch.object(main, "STATE_DIR", Path(pasta)):
                lido = client.get(ROTA)
                self.assertEqual(lido.status_code, 200)
                self.assertEqual(len(lido.json()["codigos"]), 31)
                self.assertFalse(arquivo.exists())

                corpo = {"codigos": [{"id": "foz", "titulo": "Foz do Iguaçu", "modo": "usuario", "comando": COMANDO_FOZ}]}
                gravado = client.put(ROTA, json=corpo)
                self.assertEqual(gravado.status_code, 200)
                self.assertEqual(gravado.json(), corpo)
                self.assertEqual(client.get(ROTA).json(), corpo)
                self.assertIn("Iguaçu", arquivo.read_text(encoding="utf-8"))

                for ruim in ({**corpo["codigos"][0], "comando": "Get-Printer\nGet-Process"},
                             {**corpo["codigos"][0], "modo": "admin"},
                             {**corpo["codigos"][0], "titulo": ""}):
                    recusado = client.put(ROTA, json={"codigos": [ruim]})
                    self.assertEqual(recusado.status_code, 422)
                    self.assertNotIn("Get-Process", recusado.text)
                self.assertEqual(client.get(ROTA).json(), corpo)

                arquivo.write_text("{ilegível", encoding="utf-8")
                self.assertEqual(client.get(ROTA).status_code, 503)
                self.assertEqual(client.put(ROTA, json=corpo).status_code, 503)
                self.assertEqual(arquivo.read_text(encoding="utf-8"), "{ilegível")


if __name__ == "__main__":
    unittest.main()
