"""Lembretes (Ferramentas): API local em ``data/state/lembretes.json``.

Só dados sintéticos e pasta temporária: o ``data/`` real nunca é lido nem gravado aqui.
"""

import contextlib
import json
import logging
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

import main
from domains.lembretes import Lembretes
from routers.lembretes import create_lembretes_router

SEGREDO = "descricao-sigilosa-zeta"
CAMPOS = {"id", "descricao", "criado_em", "alterado_em", "concluido", "concluido_em", "origem"}


class ListaDeLogs(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.DEBUG)
        self.linhas: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.linhas.append(self.format(record))  # inclui o traceback, se houver


@contextlib.contextmanager
def capturar_logs():
    """Todos os logs do processo durante o bloco (o formato inclui exceções)."""
    lista = ListaDeLogs()
    raiz = logging.getLogger()
    nivel = raiz.level
    raiz.addHandler(lista)
    raiz.setLevel(logging.DEBUG)
    try:
        yield lista.linhas
    finally:
        raiz.removeHandler(lista)
        raiz.setLevel(nivel)


class LembretesBase(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.arquivo = Path(temp.name) / "lembretes.json"
        app = FastAPI()
        app.include_router(create_lembretes_router(self.arquivo))
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def criar(self, descricao="Ligar para o fornecedor", **extra) -> dict:
        resposta = self.client.post("/api/lembretes", json={"descricao": descricao, **extra})
        self.assertEqual(resposta.status_code, 201, resposta.text)
        return resposta.json()

    def lembretes(self) -> list[dict]:
        resposta = self.client.get("/api/lembretes")
        self.assertEqual(resposta.status_code, 200, resposta.text)
        return resposta.json()["lembretes"]

    def gravado(self) -> dict:
        return json.loads(self.arquivo.read_text(encoding="utf-8"))


class CrudTests(LembretesBase):
    def test_sem_arquivo_devolve_lista_vazia_e_nao_grava(self):
        resposta = self.client.get("/api/lembretes")
        self.assertEqual(resposta.status_code, 200)
        self.assertEqual(resposta.json(), {"lembretes": []})
        self.assertFalse(self.arquivo.exists())

    def test_criar_devolve_201_com_o_item_completo(self):
        item = self.criar("  Ligar para o fornecedor  ")
        self.assertEqual(set(item), CAMPOS)
        self.assertEqual(item["descricao"], "Ligar para o fornecedor")
        self.assertRegex(item["id"], r"^[a-z0-9_-]{1,40}$")
        datetime.fromisoformat(item["criado_em"])
        self.assertIsNone(item["alterado_em"])
        self.assertIs(item["concluido"], False)
        self.assertIsNone(item["concluido_em"])
        self.assertIsNone(item["origem"])
        self.assertEqual(self.lembretes(), [item])

    def test_origem_entrega_e_devolucao_sao_aceitas(self):
        for origem in ("entrega", "devolucao"):
            with self.subTest(origem=origem):
                self.assertEqual(self.criar(origem=origem)["origem"], origem)
        self.assertEqual(self.criar(origem=None)["origem"], None)

    def test_crud_completo(self):
        primeiro, segundo = self.criar("Primeiro"), self.criar("Segundo")
        self.assertNotEqual(primeiro["id"], segundo["id"])
        self.assertEqual([i["descricao"] for i in self.lembretes()], ["Primeiro", "Segundo"])

        editado = self.client.patch(f"/api/lembretes/{primeiro['id']}", json={"descricao": "Primeiro editado"})
        self.assertEqual(editado.status_code, 200, editado.text)
        self.assertEqual(editado.json()["descricao"], "Primeiro editado")
        datetime.fromisoformat(editado.json()["alterado_em"])

        concluido = self.client.patch(f"/api/lembretes/{primeiro['id']}", json={"concluido": True}).json()
        self.assertIs(concluido["concluido"], True)
        datetime.fromisoformat(concluido["concluido_em"])
        self.assertEqual(concluido["descricao"], "Primeiro editado")

        reaberto = self.client.patch(f"/api/lembretes/{primeiro['id']}", json={"concluido": False}).json()
        self.assertIs(reaberto["concluido"], False)
        self.assertIsNone(reaberto["concluido_em"])

        apagado = self.client.delete(f"/api/lembretes/{primeiro['id']}")
        self.assertEqual(apagado.status_code, 204)
        self.assertEqual(apagado.content, b"")
        self.assertEqual([i["id"] for i in self.lembretes()], [segundo["id"]])

    def test_patch_vazio_devolve_o_item_sem_mudar(self):
        item = self.criar()
        resposta = self.client.patch(f"/api/lembretes/{item['id']}", json={})
        self.assertEqual(resposta.status_code, 200)
        self.assertEqual(resposta.json(), item)

    def test_dados_persistem_entre_instancias(self):
        item = self.criar()
        app = FastAPI()
        app.include_router(create_lembretes_router(self.arquivo))
        with TestClient(app) as outro:
            self.assertEqual(outro.get("/api/lembretes").json(), {"lembretes": [item]})

    def test_arquivo_gravado_tem_version_1_e_a_lista(self):
        item = self.criar("Anotação", origem="entrega")
        self.assertEqual(self.gravado(), {"version": 1, "lembretes": [item]})


class EdicaoTests(LembretesBase):
    def test_editar_com_o_mesmo_texto_nao_muda_alterado_em(self):
        item = self.criar("Mesmo texto")
        for texto in ("Mesmo texto", "  Mesmo texto  "):
            with self.subTest(texto=texto):
                atual = self.client.patch(f"/api/lembretes/{item['id']}", json={"descricao": texto}).json()
                self.assertIsNone(atual["alterado_em"])
                self.assertEqual(atual["descricao"], "Mesmo texto")
        self.assertIsNone(self.gravado()["lembretes"][0]["alterado_em"])

    def test_concluir_nao_define_alterado_em(self):
        item = self.criar()
        atual = self.client.patch(f"/api/lembretes/{item['id']}", json={"concluido": True}).json()
        self.assertIsNone(atual["alterado_em"])

    def test_datas_com_relogio_controlado(self):
        horas = iter(["t1", "t2", "t3", "t4", "t5", "t6"])
        dominio = Lembretes(self.arquivo, agora=lambda: next(horas))
        item = dominio.criar("Texto")
        self.assertEqual((item["criado_em"], item["alterado_em"], item["concluido_em"]), ("t1", None, None))
        self.assertEqual(dominio.atualizar(item["id"], {"descricao": "Texto"})["alterado_em"], None)
        self.assertEqual(dominio.atualizar(item["id"], {"descricao": "Outro"})["alterado_em"], "t2")
        self.assertEqual(dominio.atualizar(item["id"], {"concluido": True})["concluido_em"], "t3")
        # Concluir de novo mantém a data da primeira conclusão; desmarcar zera.
        self.assertEqual(dominio.atualizar(item["id"], {"concluido": True})["concluido_em"], "t3")
        reaberto = dominio.atualizar(item["id"], {"concluido": False})
        self.assertEqual((reaberto["concluido"], reaberto["concluido_em"], reaberto["alterado_em"]), (False, None, "t2"))
        self.assertEqual(dominio.atualizar(item["id"], {"concluido": True})["concluido_em"], "t4")


class ErrosTests(LembretesBase):
    def test_id_desconhecido_devolve_404_no_patch_e_no_delete(self):
        self.criar()
        antes = self.gravado()
        for lembrete_id in ("inexistente", "ID INVALIDO!", "x" * 100):
            with self.subTest(lembrete_id=lembrete_id):
                patch = self.client.patch(f"/api/lembretes/{lembrete_id}", json={"concluido": True})
                self.assertEqual(patch.status_code, 404, patch.text)
                self.assertEqual(patch.json()["codigo"], "lembrete_inexistente")
                delete = self.client.delete(f"/api/lembretes/{lembrete_id}")
                self.assertEqual(delete.status_code, 404, delete.text)
        self.assertEqual(self.gravado(), antes)

    def test_descricao_invalida_devolve_422_e_nao_grava(self):
        invalidas = {
            "vazia": "",
            "so espacos": "   ",
            "so quebra de linha": "\n\t ",
            "2001 caracteres": "a" * 2001,
            "controle nulo": "abc\x00def",
            "controle de quebra de linha": "abc\ndef",
            "controle de tabulação": "abc\tdef",
            "controle de escape": "abc\x1bdef",
        }
        for nome, descricao in invalidas.items():
            with self.subTest(nome=nome):
                resposta = self.client.post("/api/lembretes", json={"descricao": descricao})
                self.assertEqual(resposta.status_code, 422, resposta.text)
                self.assertEqual(resposta.json()["codigo"], "descricao_invalida")
        self.assertFalse(self.arquivo.exists())

    def test_limite_de_2000_caracteres_vale_depois_do_strip(self):
        self.assertEqual(len(self.criar(" " + "a" * 2000 + " ")["descricao"]), 2000)

    def test_origem_invalida_devolve_422(self):
        for origem in ("outra", "", "Entrega", 1, ["entrega"]):
            with self.subTest(origem=origem):
                resposta = self.client.post("/api/lembretes", json={"descricao": "Texto", "origem": origem})
                self.assertEqual(resposta.status_code, 422, resposta.text)
        self.assertFalse(self.arquivo.exists())

    def test_corpo_malformado_devolve_422(self):
        for corpo in ({}, {"descricao": 5}, {"descricao": None}, {"descricao": "Texto", "extra": 1}):
            with self.subTest(corpo=corpo):
                self.assertEqual(self.client.post("/api/lembretes", json=corpo).status_code, 422)
        self.assertFalse(self.arquivo.exists())

    def test_patch_invalido_devolve_422_e_nao_grava(self):
        item = self.criar("Texto")
        antes = self.gravado()
        corpos = (
            {"descricao": ""}, {"descricao": "   "}, {"descricao": "a" * 2001}, {"descricao": "a\x00b"},
            {"descricao": None}, {"descricao": 5}, {"concluido": "sim"}, {"concluido": 1}, {"concluido": None},
            {"origem": "entrega"},
        )
        for corpo in corpos:
            with self.subTest(corpo=corpo):
                resposta = self.client.patch(f"/api/lembretes/{item['id']}", json=corpo)
                self.assertEqual(resposta.status_code, 422, resposta.text)
        self.assertEqual(self.gravado(), antes)

    def test_arquivo_ilegivel_devolve_503_e_e_preservado(self):
        for conteudo in ("{não é json", json.dumps({"version": 2, "lembretes": []}), json.dumps({"version": 1}),
                         json.dumps({"version": 1, "lembretes": [{"id": "a"}]})):
            with self.subTest(conteudo=conteudo):
                self.arquivo.write_text(conteudo, encoding="utf-8")
                self.assertEqual(self.client.get("/api/lembretes").status_code, 503)
                resposta = self.client.post("/api/lembretes", json={"descricao": "Texto"})
                self.assertEqual(resposta.status_code, 503)
                self.assertEqual(resposta.json()["codigo"], "lembretes_ilegiveis")
                self.assertEqual(self.arquivo.read_text(encoding="utf-8"), conteudo)

    def test_falha_ao_gravar_devolve_503_e_mantem_o_arquivo(self):
        item = self.criar("Texto")
        antes = self.arquivo.read_text(encoding="utf-8")
        with mock.patch("domains.lembretes.atomic_write_json", side_effect=OSError("disco cheio")):
            resposta = self.client.patch(f"/api/lembretes/{item['id']}", json={"descricao": "Novo"})
        self.assertEqual(resposta.status_code, 503)
        self.assertEqual(resposta.json()["codigo"], "lembretes_gravacao")
        self.assertEqual(self.arquivo.read_text(encoding="utf-8"), antes)


class LogTests(LembretesBase):
    def test_log_nunca_leva_a_descricao(self):
        with capturar_logs() as linhas:
            item = self.criar(f"Anotação {SEGREDO}", origem="entrega")
            self.client.patch(f"/api/lembretes/{item['id']}", json={"descricao": f"Editada {SEGREDO}"})
            self.client.patch(f"/api/lembretes/{item['id']}", json={"concluido": True})
            self.client.post("/api/lembretes", json={"descricao": f"{SEGREDO}\x00"})  # 422
            self.client.post("/api/lembretes", json={"descricao": SEGREDO * 100})  # 422 (limite)
            self.client.patch("/api/lembretes/inexistente", json={"descricao": SEGREDO})  # 404
            self.client.get("/api/lembretes")
            self.client.delete(f"/api/lembretes/{item['id']}")
        self.assertTrue(any("Lembretes" in linha for linha in linhas), "o teste não viu nenhum log do app")
        self.assertFalse([linha for linha in linhas if SEGREDO in linha])

    def test_erro_inesperado_registra_so_a_classe(self):
        with capturar_logs() as linhas:
            with mock.patch("domains.lembretes.atomic_write_json", side_effect=RuntimeError(SEGREDO)):
                resposta = self.client.post("/api/lembretes", json={"descricao": SEGREDO})
        self.assertEqual(resposta.status_code, 500)
        self.assertEqual(resposta.json()["codigo"], "erro_inesperado")
        self.assertNotIn(SEGREDO, resposta.text)
        self.assertTrue(any("RuntimeError" in linha for linha in linhas))
        self.assertFalse([linha for linha in linhas if SEGREDO in linha])


class SessaoTests(unittest.TestCase):
    def test_sem_cookie_de_sessao_devolve_401(self):
        """O middleware do app real barra antes de qualquer rota: nada é lido nem gravado."""
        client = TestClient(
            main.app, base_url=f"http://127.0.0.1:{main.SERVER_PORT}", client=("127.0.0.1", 1234),
        )
        self.addCleanup(client.close)
        pedidos = (
            ("GET", "/api/lembretes", None),
            ("POST", "/api/lembretes", {"descricao": "Texto"}),
            ("PATCH", "/api/lembretes/abc", {"concluido": True}),
            ("DELETE", "/api/lembretes/abc", None),
        )
        for metodo, caminho, corpo in pedidos:
            with self.subTest(metodo=metodo):
                self.assertEqual(client.request(metodo, caminho, json=corpo).status_code, 401)

    def test_rotas_estao_registradas_no_app(self):
        caminhos = main.app.openapi()["paths"]
        self.assertEqual(set(caminhos["/api/lembretes"]), {"get", "post"})
        self.assertEqual(set(caminhos["/api/lembretes/{lembrete_id}"]), {"patch", "delete"})


if __name__ == "__main__":
    unittest.main()
