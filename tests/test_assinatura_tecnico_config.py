"""Config da assinatura do técnico: ``GET/PUT /api/assinatura-tecnico/config`` (pasta temporária, nunca o ``data/state`` real)."""

import json
import logging
import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.assinatura_tecnico import create_assinatura_tecnico_router


class AssinaturaConfigTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.pasta = Path(temp.name)
        app = FastAPI()
        app.include_router(create_assinatura_tecnico_router(
            self.pasta / "a.svg", self.pasta / "assinatura_tecnico.json", self.pasta / "config_backups"))
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def put(self, estilo, nome):
        return self.client.put("/api/assinatura-tecnico/config", json={"estilo": estilo, "nome": nome})

    def test_sem_arquivo_devolve_desenho_vazio(self):
        resposta = self.client.get("/api/assinatura-tecnico/config")
        self.assertEqual((resposta.status_code, resposta.json()), (200, {"estilo": "desenho", "nome": ""}))

    def test_nomes_validos_gravam_e_o_get_devolve(self):
        casos = [
            ("Ana", "Ana"), ("Maria Eduarda Souza", "Maria Eduarda Souza"),
            ("José da Conceição Gonçalves", "José da Conceição Gonçalves"),
            ("Pedro D\u2019Ávila", "Pedro D'Ávila"), ("Ana-Clara", "Ana-Clara"), ("JOÃO PAULO", "JOÃO PAULO"),
            ("  Ana   Lima ", "Ana Lima"), ("a" * 80, "a" * 80),
        ]
        for enviado, esperado in casos:
            with self.subTest(enviado=enviado):
                resposta = self.put("great-vibes", enviado)
                self.assertEqual((resposta.status_code, resposta.json()), (200, {"estilo": "great-vibes", "nome": esperado}))
                self.assertEqual(self.client.get("/api/assinatura-tecnico/config").json(),
                                 {"estilo": "great-vibes", "nome": esperado})

    def test_desenho_preserva_ou_aceita_nome_vazio(self):
        self.assertEqual(self.put("desenho", "").status_code, 200)
        self.assertEqual(self.put("desenho", "Ana").json(), {"estilo": "desenho", "nome": "Ana"})

    def test_invalidos_dao_422_sem_eco_e_sem_log(self):
        casos = [
            ("digitada", "a" * 81, "assinatura_nome_invalido"), ("digitada", "Ana1", "assinatura_nome_invalido"),
            ("digitada", "<b>", "assinatura_nome_invalido"), ("digitada", "Ana\x07", "assinatura_nome_invalido"),
            ("allura", "", "assinatura_nome_invalido"),
            *[("digitada", n, "assinatura_nome_invalido") for n in
              ("Жанна Ana", "\U0001d4d0na", "שלום Ana", "Việt", "Ana\u3164Lima")], ("allura", "   ", "assinatura_nome_invalido"),
            ("comic-sans", "SegredoXyz", "assinatura_estilo_invalido"),
        ]
        for estilo, nome, codigo in casos:
            with self.subTest(estilo=estilo, nome=nome[:5]), self.assertLogs(level="DEBUG") as logs:
                logging.getLogger("t").debug("sentinela")
                resposta = self.put(estilo, nome)
                self.assertEqual(resposta.status_code, 422)
                corpo = resposta.json()
                self.assertEqual(set(corpo), {"detail", "codigo"})
                self.assertEqual(corpo["codigo"], codigo)
                for trecho in (nome, estilo if codigo.endswith("estilo_invalido") else "\0"):
                    if trecho.strip():
                        self.assertNotIn(trecho, resposta.text)
                self.assertNotIn(nome.strip() or "\0", "\n".join(logs.output).replace("sentinela", ""))
        self.assertFalse((self.pasta / "assinatura_tecnico.json").exists())

    def test_corpo_que_nao_e_objeto_da_422(self):
        resposta = self.client.put("/api/assinatura-tecnico/config", content=b"[1]", headers={"content-type": "application/json"})
        self.assertEqual((resposta.status_code, resposta.json()["codigo"]), (422, "assinatura_corpo_invalido"))

    def test_gravacao_nao_loga_o_nome_e_segunda_gravacao_cria_backup(self):
        with self.assertLogs("domains.configuracao_local", level="INFO") as logs:
            self.put("sacramento", "Nome Secreto")
        self.assertEqual(logs.output, ["INFO:domains.configuracao_local:configuracao_local: assinatura_tecnico gravada"])
        self.assertEqual(list((self.pasta / "config_backups").glob("*.bak")), [])
        self.put("allura", "Outro Nome")
        backups = list((self.pasta / "config_backups").glob("assinatura_tecnico.json.*.bak"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(json.loads(backups[0].read_text(encoding="utf-8")), {"estilo": "sacramento", "nome": "Nome Secreto"})

    def ler_erro(self, conteudo):
        (self.pasta / "assinatura_tecnico.json").write_text(conteudo, encoding="utf-8")
        with self.assertLogs("routers.assinatura_tecnico", level="WARNING") as logs:
            resposta = self.client.get("/api/assinatura-tecnico/config")
        self.assertEqual(resposta.status_code, 500)
        self.assertEqual(set(resposta.json()), {"detail", "codigo"})
        self.assertEqual(resposta.json()["codigo"], "assinatura_config_ilegivel")
        for segredo in ("Bruno", "allura"):
            self.assertNotIn(segredo, resposta.text)
            self.assertNotIn(segredo, "\n".join(logs.output))
        self.assertIn("codigo=assinatura_config_ilegivel", "\n".join(logs.output))

    def test_arquivo_corrompido_vira_erro_e_nunca_desenho(self):
        self.ler_erro('{"estilo":"allura","nome":"Bru')

    def test_json_valido_mas_invalido_vira_erro(self):
        self.ler_erro('{"estilo":"allura","nome":""}')
        self.ler_erro('{"estilo":"allura","nome":"Bruno 2"}')
        self.ler_erro("[]")

    def test_put_depois_de_corrompido_grava_e_faz_backup(self):
        arquivo = self.pasta / "assinatura_tecnico.json"
        arquivo.write_text('{"estilo":"allura","nome":"Bruno', encoding="utf-8")
        self.assertEqual(self.put("allura", "Bruno").status_code, 200)
        self.assertEqual(self.client.get("/api/assinatura-tecnico/config").json(), {"estilo": "allura", "nome": "Bruno"})
        backups = list((self.pasta / "config_backups").glob("assinatura_tecnico.json.*.bak"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(encoding="utf-8"), '{"estilo":"allura","nome":"Bruno')

    def test_tab_e_feff_no_nome_sao_recusados(self):
        for nome in ("Ana	Lima", "Ana﻿", "﻿Ana"):
            with self.subTest(nome=nome):
                self.assertEqual(self.put("allura", nome).status_code, 422)


if __name__ == "__main__":
    unittest.main()
