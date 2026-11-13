"""Lembretes (Ferramentas): API local em ``data/state/lembretes.json``.

Só dados sintéticos e pasta temporária: o ``data/`` real nunca é lido nem gravado aqui.
"""

import contextlib
import json
import logging
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

import main
from domains.lembretes import Lembretes
from domains.sebrae_observacoes import FUSO
from routers.lembretes import create_lembretes_router

SEGREDO = "descricao-sigilosa-zeta"
CAMPOS = {
    "id", "descricao", "criado_em", "alterado_em", "concluido", "concluido_em", "origem",
    "data_agendada", "hora_agendada",
}


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
        self.assertIsNone(item["data_agendada"])
        self.assertIsNone(item["hora_agendada"])
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

    def test_item_sem_campos_opcionais_e_lido_com_null(self):
        item = {"id": "a1", "descricao": "Texto", "criado_em": "2026-11-12T08:00:00-03:00", "concluido": False}
        self.arquivo.write_text(json.dumps({"version": 1, "lembretes": [item]}), encoding="utf-8")
        nulos = {
            "alterado_em": None, "concluido_em": None, "origem": None, "data_agendada": None, "hora_agendada": None,
        }
        self.assertEqual(self.lembretes(), [{**item, **nulos}])
        self.assertEqual(self.client.patch("/api/lembretes/a1", json={"concluido": True}).status_code, 200)
        # A gravação seguinte já leva os campos novos como null.
        self.assertEqual(self.gravado()["lembretes"][0]["data_agendada"], None)
        self.assertIn("hora_agendada", self.gravado()["lembretes"][0])

    def test_item_com_data_e_hora_fora_do_formato_nao_torna_o_arquivo_ilegivel(self):
        # O formato só é conferido na entrada da API: um arquivo editado à mão continua legível.
        item = {"id": "a1", "descricao": "Texto", "criado_em": "t", "concluido": False,
                "data_agendada": "13/11/2026", "hora_agendada": "tarde"}
        self.arquivo.write_text(json.dumps({"version": 1, "lembretes": [item]}), encoding="utf-8")
        lido = self.lembretes()[0]
        self.assertEqual((lido["data_agendada"], lido["hora_agendada"]), ("13/11/2026", "tarde"))

    def test_data_ou_hora_que_nao_e_texto_no_arquivo_torna_ilegivel(self):
        for campo, valor in (("data_agendada", 20261113), ("hora_agendada", 900), ("data_agendada", ["2026-11-13"])):
            with self.subTest(campo=campo, valor=valor):
                item = {"id": "a1", "descricao": "Texto", "criado_em": "t", "concluido": False, campo: valor}
                conteudo = json.dumps({"version": 1, "lembretes": [item]})
                self.arquivo.write_text(conteudo, encoding="utf-8")
                self.assertEqual(self.client.get("/api/lembretes").status_code, 503)
                self.assertEqual(self.arquivo.read_text(encoding="utf-8"), conteudo)

    def test_surrogate_isolado_devolve_422_e_nao_grava(self):
        # Escapado no JSON: o surrogate só existe depois do parse no servidor.
        corpo = b'{"descricao": "ab\\ud800"}'
        resposta = self.client.post("/api/lembretes", content=corpo, headers={"Content-Type": "application/json"})
        self.assertEqual(resposta.status_code, 422, resposta.text)
        self.assertFalse(self.arquivo.exists())

    def test_leitura_bloqueada_pelo_windows_devolve_503_ocupado(self):
        self.criar("Texto")
        with mock.patch.object(Path, "read_text", side_effect=PermissionError):
            resposta = self.client.get("/api/lembretes")
        self.assertEqual(resposta.status_code, 503)
        self.assertEqual(resposta.json()["codigo"], "lembretes_ocupados")

    def test_falha_ao_gravar_devolve_503_e_mantem_o_arquivo(self):
        item = self.criar("Texto")
        antes = self.arquivo.read_text(encoding="utf-8")
        with mock.patch("domains.lembretes.atomic_write_json", side_effect=OSError("disco cheio")):
            resposta = self.client.patch(f"/api/lembretes/{item['id']}", json={"descricao": "Novo"})
        self.assertEqual(resposta.status_code, 503)
        self.assertEqual(resposta.json()["codigo"], "lembretes_gravacao")
        self.assertEqual(self.arquivo.read_text(encoding="utf-8"), antes)


class DataAgendadaTests(LembretesBase):
    def test_criar_com_data_e_hora(self):
        item = self.criar(data_agendada="2026-11-14", hora_agendada="09:30")
        self.assertEqual((item["data_agendada"], item["hora_agendada"]), ("2026-11-14", "09:30"))
        self.assertEqual(self.lembretes(), [item])
        self.assertEqual(self.gravado()["lembretes"], [item])

    def test_criar_so_com_data_e_com_null_explicito(self):
        so_data = self.criar(data_agendada="2026-11-14")
        self.assertEqual((so_data["data_agendada"], so_data["hora_agendada"]), ("2026-11-14", None))
        nulos = self.criar(data_agendada=None, hora_agendada=None)
        self.assertEqual((nulos["data_agendada"], nulos["hora_agendada"]), (None, None))

    def test_criar_aceita_data_passada(self):
        # O e2e precisa criar um atrasado; o POST não compara com hoje.
        item = self.criar(data_agendada="2020-01-01")
        self.assertEqual(item["data_agendada"], "2020-01-01")

    def test_data_invalida_devolve_422_data_invalida_e_nao_grava(self):
        invalidas = {
            "dia inexistente": "2026-02-30",
            "sem hifens": "20261113",
            "semana ISO": "2026-W46-5",
            "dia/mês/ano": "13/11/2026",
            "vazia": "",
            "espaço na ponta": " 2026-11-13",
            "quebra de linha na ponta": "2026-11-13\n",
            "com hora": "2026-11-13T09:00",
            "dígitos árabes": "٢٠٢٦-١١-١٣",
            "mês 13": "2026-13-01",
        }
        for nome, valor in invalidas.items():
            with self.subTest(nome=nome):
                resposta = self.client.post("/api/lembretes", json={"descricao": "Texto", "data_agendada": valor})
                self.assertEqual(resposta.status_code, 422, resposta.text)
                self.assertEqual(resposta.json()["codigo"], "data_invalida")
        self.assertFalse(self.arquivo.exists())

    def test_hora_invalida_devolve_422_hora_invalida_e_nao_grava(self):
        invalidas = {
            "com segundos": "09:00:30", "sem dois-pontos": "0900", "24:00": "24:00", "sem zero": "9:00",
            "minuto 60": "09:60", "vazia": "", "quebra de linha": "09:00\n", "com espaço": " 09:00",
        }
        for nome, valor in invalidas.items():
            with self.subTest(nome=nome):
                resposta = self.client.post(
                    "/api/lembretes",
                    json={"descricao": "Texto", "data_agendada": "2026-11-13", "hora_agendada": valor},
                )
                self.assertEqual(resposta.status_code, 422, resposta.text)
                self.assertEqual(resposta.json()["codigo"], "hora_invalida")
        self.assertFalse(self.arquivo.exists())

    def test_horas_limite_sao_aceitas(self):
        for hora in ("00:00", "23:59", "12:05"):
            with self.subTest(hora=hora):
                self.assertEqual(self.criar(data_agendada="2026-11-13", hora_agendada=hora)["hora_agendada"], hora)

    def test_hora_sem_data_no_post_devolve_422(self):
        for extra in ({"hora_agendada": "10:00"}, {"data_agendada": None, "hora_agendada": "10:00"}):
            with self.subTest(extra=extra):
                resposta = self.client.post("/api/lembretes", json={"descricao": "Texto", **extra})
                self.assertEqual(resposta.status_code, 422, resposta.text)
                self.assertEqual(resposta.json()["codigo"], "hora_invalida")
        self.assertFalse(self.arquivo.exists())

    def test_valor_que_nao_e_texto_cai_no_422_do_pydantic(self):
        for campo, valor in (("data_agendada", 20261113), ("hora_agendada", 900), ("data_agendada", ["2026-11-13"])):
            with self.subTest(campo=campo, valor=valor):
                resposta = self.client.post("/api/lembretes", json={"descricao": "Texto", campo: valor})
                self.assertEqual(resposta.status_code, 422, resposta.text)
        self.assertFalse(self.arquivo.exists())

    def patch(self, item: dict, corpo: dict):
        return self.client.patch(f"/api/lembretes/{item['id']}", json=corpo)

    def test_patch_hora_em_item_com_data_e_ok(self):
        item = self.criar(data_agendada="2026-11-14")
        resposta = self.patch(item, {"hora_agendada": "10:00"})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual((resposta.json()["data_agendada"], resposta.json()["hora_agendada"]), ("2026-11-14", "10:00"))

    def test_patch_hora_em_item_sem_data_devolve_422_e_nao_grava(self):
        item = self.criar()
        antes = self.gravado()
        resposta = self.patch(item, {"hora_agendada": "10:00"})
        self.assertEqual(resposta.status_code, 422, resposta.text)
        self.assertEqual(resposta.json()["codigo"], "hora_invalida")
        self.assertEqual(self.gravado(), antes)

    def test_patch_data_null_limpa_data_e_hora(self):
        item = self.criar(data_agendada="2026-11-14", hora_agendada="10:00")
        atual = self.patch(item, {"data_agendada": None})
        self.assertEqual(atual.status_code, 200, atual.text)
        self.assertEqual((atual.json()["data_agendada"], atual.json()["hora_agendada"]), (None, None))
        self.assertEqual(self.gravado()["lembretes"][0]["hora_agendada"], None)

    def test_patch_data_null_com_hora_devolve_422_e_nao_grava(self):
        item = self.criar(data_agendada="2026-11-14", hora_agendada="10:00")
        antes = self.gravado()
        resposta = self.patch(item, {"data_agendada": None, "hora_agendada": "11:00"})
        self.assertEqual(resposta.status_code, 422, resposta.text)
        self.assertEqual(resposta.json()["codigo"], "hora_invalida")
        self.assertEqual(self.gravado(), antes)

    def test_patch_hora_null_limpa_so_a_hora(self):
        item = self.criar(data_agendada="2026-11-14", hora_agendada="10:00")
        atual = self.patch(item, {"hora_agendada": None}).json()
        self.assertEqual((atual["data_agendada"], atual["hora_agendada"]), ("2026-11-14", None))

    def test_patch_so_a_data_mantem_a_hora(self):
        item = self.criar(data_agendada="2026-11-14", hora_agendada="10:00")
        atual = self.patch(item, {"data_agendada": "2026-11-20"}).json()
        self.assertEqual((atual["data_agendada"], atual["hora_agendada"]), ("2026-11-20", "10:00"))

    def test_patch_data_e_hora_juntas_em_item_sem_data(self):
        item = self.criar()
        atual = self.patch(item, {"data_agendada": "2026-11-20", "hora_agendada": "08:15"}).json()
        self.assertEqual((atual["data_agendada"], atual["hora_agendada"]), ("2026-11-20", "08:15"))

    def test_patch_de_outro_campo_nao_mexe_na_agenda(self):
        item = self.criar(data_agendada="2026-11-14", hora_agendada="10:00")
        atual = self.patch(item, {"concluido": True}).json()
        self.assertEqual((atual["data_agendada"], atual["hora_agendada"]), ("2026-11-14", "10:00"))

    def test_mudar_a_data_nao_altera_alterado_em(self):
        item = self.criar("Texto", data_agendada="2026-11-14")
        for corpo in ({"data_agendada": "2026-11-20"}, {"hora_agendada": "10:00"}, {"data_agendada": None}):
            with self.subTest(corpo=corpo):
                self.assertIsNone(self.patch(item, corpo).json()["alterado_em"])
        self.assertIsNotNone(self.patch(item, {"descricao": "Outro texto"}).json()["alterado_em"])

    def test_patch_com_data_ou_hora_invalida_devolve_422_e_nao_grava(self):
        item = self.criar(data_agendada="2026-11-14", hora_agendada="10:00")
        antes = self.gravado()
        casos = (
            ({"data_agendada": "2026-02-30"}, "data_invalida"), ({"data_agendada": "20261113"}, "data_invalida"),
            ({"data_agendada": "2026-W46-5"}, "data_invalida"), ({"hora_agendada": "09:00:30"}, "hora_invalida"),
            ({"hora_agendada": "0900"}, "hora_invalida"), ({"hora_agendada": "24:00"}, "hora_invalida"),
        )
        for corpo, codigo in casos:
            with self.subTest(corpo=corpo):
                resposta = self.patch(item, corpo)
                self.assertEqual(resposta.status_code, 422, resposta.text)
                self.assertEqual(resposta.json()["codigo"], codigo)
        self.assertEqual(self.gravado(), antes)


class ReagendarAtrasadosTests(LembretesBase):
    def dominio(self, hoje: list[date]) -> Lembretes:
        return Lembretes(self.arquivo, hoje=lambda: hoje[0])

    def test_move_so_pendentes_atrasados_para_hoje_mantendo_a_hora(self):
        dominio = self.dominio([date(2026, 11, 13)])
        atrasado = dominio.criar("Atrasado", None, "2026-11-10", "17:00")
        atrasado_sem_hora = dominio.criar("Atrasado sem hora", None, "2026-01-02")
        de_hoje = dominio.criar("De hoje", None, "2026-11-13", "08:00")
        futuro = dominio.criar("Futuro", None, "2026-11-14", "09:00")
        sem_data = dominio.criar("Sem data")
        concluido = dominio.criar("Concluído atrasado", None, "2026-11-01", "10:00")
        dominio.atualizar(concluido["id"], {"concluido": True})
        concluido = next(i for i in dominio.listar() if i["id"] == concluido["id"])

        lista, reagendados = dominio.reagendar_atrasados()

        self.assertEqual(reagendados, 2)
        por_id = {i["id"]: i for i in lista}
        self.assertEqual((por_id[atrasado["id"]]["data_agendada"], por_id[atrasado["id"]]["hora_agendada"]),
                         ("2026-11-13", "17:00"))
        self.assertEqual((por_id[atrasado_sem_hora["id"]]["data_agendada"], por_id[atrasado_sem_hora["id"]]["hora_agendada"]),
                         ("2026-11-13", None))
        for intacto in (de_hoje, futuro, sem_data, concluido):
            self.assertEqual(por_id[intacto["id"]], intacto)
        self.assertEqual(lista, dominio.listar())  # a lista devolvida é o que ficou gravado
        self.assertEqual([i["id"] for i in lista], [i["id"] for i in self.gravado()["lembretes"]])

    def test_sem_atrasados_devolve_zero_e_nao_grava(self):
        dominio = self.dominio([date(2026, 11, 13)])
        self.assertEqual(dominio.reagendar_atrasados(), ([], 0))
        self.assertFalse(self.arquivo.exists())  # nem cria o arquivo

        dominio.criar("De hoje", None, "2026-11-13")
        dominio.criar("Sem data")
        antes_bytes = self.arquivo.read_bytes()
        _, reagendados = dominio.reagendar_atrasados()
        self.assertEqual(reagendados, 0)
        self.assertEqual(self.arquivo.read_bytes(), antes_bytes)

    def test_sem_atrasados_nao_chama_a_gravacao(self):
        dominio = self.dominio([date(2026, 11, 13)])
        dominio.criar("Futuro", None, "2026-11-20")
        with mock.patch("domains.lembretes.atomic_write_json") as gravar:
            self.assertEqual(dominio.reagendar_atrasados()[1], 0)
        gravar.assert_not_called()

    def test_virada_do_dia_com_hoje_injetado(self):
        hoje = [date(2026, 11, 12)]
        dominio = self.dominio(hoje)
        item = dominio.criar("Do dia 12", None, "2026-11-12", "23:30")
        self.assertEqual(dominio.reagendar_atrasados()[1], 0)  # dia 12 ainda é hoje
        hoje[0] = date(2026, 11, 13)  # passou da meia-noite
        lista, reagendados = dominio.reagendar_atrasados()
        self.assertEqual(reagendados, 1)
        self.assertEqual((lista[0]["id"], lista[0]["data_agendada"], lista[0]["hora_agendada"]),
                         (item["id"], "2026-11-13", "23:30"))
        self.assertEqual(dominio.reagendar_atrasados()[1], 0)  # idempotente no mesmo dia

    def test_data_fora_do_formato_no_arquivo_nao_e_mexida(self):
        itens = [
            {"id": "a1", "descricao": "Texto", "criado_em": "t", "concluido": False, "data_agendada": "01/01/2020"},
            {"id": "a2", "descricao": "Texto", "criado_em": "t", "concluido": False, "data_agendada": "2020-02-30"},
        ]
        self.arquivo.write_text(json.dumps({"version": 1, "lembretes": itens}), encoding="utf-8")
        antes_bytes = self.arquivo.read_bytes()
        self.assertEqual(self.dominio([date(2026, 11, 13)]).reagendar_atrasados()[1], 0)
        self.assertEqual(self.arquivo.read_bytes(), antes_bytes)

    def test_rota_devolve_lista_completa_e_contagem(self):
        atrasado = self.criar("Atrasado", data_agendada="2020-01-01", hora_agendada="07:45")
        futuro = self.criar("Futuro", data_agendada="2999-01-01")
        sem_data = self.criar("Sem data")
        antes = datetime.now(FUSO).date().isoformat()
        resposta = self.client.post("/api/lembretes/reagendar-atrasados")
        depois = datetime.now(FUSO).date().isoformat()
        self.assertEqual(resposta.status_code, 200, resposta.text)
        corpo = resposta.json()
        self.assertEqual(set(corpo), {"lembretes", "reagendados"})
        self.assertEqual(corpo["reagendados"], 1)
        por_id = {i["id"]: i for i in corpo["lembretes"]}
        self.assertEqual(len(por_id), 3)
        self.assertIn(por_id[atrasado["id"]]["data_agendada"], {antes, depois})  # hoje em America/Sao_Paulo
        self.assertEqual(por_id[atrasado["id"]]["hora_agendada"], "07:45")
        self.assertEqual(por_id[futuro["id"]], futuro)
        self.assertEqual(por_id[sem_data["id"]], sem_data)
        self.assertEqual(corpo["lembretes"], self.lembretes())

    def test_rota_sem_atrasados_devolve_zero_e_nao_cria_o_arquivo(self):
        resposta = self.client.post("/api/lembretes/reagendar-atrasados")
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual(resposta.json(), {"lembretes": [], "reagendados": 0})
        self.assertFalse(self.arquivo.exists())

    def test_rota_com_arquivo_ilegivel_devolve_503_e_preserva(self):
        self.arquivo.write_text("{não é json", encoding="utf-8")
        resposta = self.client.post("/api/lembretes/reagendar-atrasados")
        self.assertEqual(resposta.status_code, 503)
        self.assertEqual(resposta.json()["codigo"], "lembretes_ilegiveis")
        self.assertEqual(self.arquivo.read_text(encoding="utf-8"), "{não é json")

    def test_data_padrao_de_hoje_usa_america_sao_paulo(self):
        antes = datetime.now(FUSO).date()
        hoje = Lembretes(self.arquivo)._hoje()
        depois = datetime.now(FUSO).date()
        self.assertIn(hoje, {antes, depois})


class LogTests(LembretesBase):
    def test_log_nunca_leva_a_descricao(self):
        with capturar_logs() as linhas:
            item = self.criar(f"Anotação {SEGREDO}", origem="entrega")
            self.client.patch(f"/api/lembretes/{item['id']}", json={"descricao": f"Editada {SEGREDO}"})
            self.client.patch(f"/api/lembretes/{item['id']}", json={"concluido": True})
            self.client.post("/api/lembretes", json={"descricao": f"{SEGREDO}\x00"})  # 422
            self.client.post("/api/lembretes", json={"descricao": SEGREDO * 100})  # 422 (limite)
            self.client.patch("/api/lembretes/inexistente", json={"descricao": SEGREDO})  # 404
            self.client.patch(f"/api/lembretes/{item['id']}", json={"data_agendada": "2026-11-20"})
            self.client.post("/api/lembretes", json={"descricao": SEGREDO, "data_agendada": "2026-02-30"})  # 422
            self.client.post("/api/lembretes", json={"descricao": SEGREDO, "hora_agendada": "10:00"})  # 422
            self.client.post("/api/lembretes", json={"descricao": SEGREDO, "data_agendada": "2020-01-01"})
            self.client.post("/api/lembretes/reagendar-atrasados")
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
            ("POST", "/api/lembretes/reagendar-atrasados", None),
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
        self.assertEqual(set(caminhos["/api/lembretes/reagendar-atrasados"]), {"post"})


if __name__ == "__main__":
    unittest.main()
