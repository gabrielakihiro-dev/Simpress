"""Busca da Home por chamado Sebrae e OS: ``GET /api/buscar/chamados-os``, só leitura, dados sintéticos."""

import json
import logging
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from core.errors import DomainBusyError
from domains.busca_chamados_os import buscar_chamados, buscar_os
from routers.operations import create_operations_router

CPF = "123.456.789-09"
NOME = "Beltrano Sintetico da Silva"


def ordem(fonte, os, utic=None):
    return {"fonte": fonte, "os": os, "serie": "ABC123", "status": "Aberta", "fila": "", "dias_aberta": None,
            "utic": {"chamado": utic, "origem": "Manual"} if utic else None}


def _levanta():
    raise DomainBusyError("ilegível")


def fontes(**abas):
    """``{aba: [número ou (número, textos)]}`` no formato do domínio."""
    return {aba: [(i, {}) if isinstance(i, str) else i for i in itens] for aba, itens in abas.items()}


class DominioTests(unittest.TestCase):
    def test_chamados_parciais_aba_ordem_dedup_e_limite(self):
        f = fontes(novos=["UTIC-2026-15"], antigos=["UTIC-2026-15", "UTIC-2026-150"], finalizados=["UTIC-2026-1"])
        # mudança de requisito 26/11/2026: série acha OS e chamado vinculado (sem OS achada, termo de série não acha chamado)
        self.assertEqual(buscar_chamados(f, "ABC123"), [])
        self.assertEqual(buscar_chamados(f, "utic-2026-15"),
                         [{"numero": "UTIC-2026-15", "aba": "novos", "campo": "numero"},
                          {"numero": "UTIC-2026-150", "aba": "antigos", "campo": "numero"}])
        self.assertEqual(buscar_chamados(f, "2026-15")[0], {"numero": "UTIC-2026-15", "aba": "novos", "campo": "numero"})
        self.assertEqual(len(buscar_chamados(fontes(antigos=[f"UTIC-2026-{n}" for n in range(10, 20)]), "UTIC-2026-1")), 5)

    def test_os_so_digitos_com_quatro_ou_mais(self):
        ordens = [ordem("simpress", "7285070", "UTIC-2026-15"), ordem("oracle", "7285070"), ordem("oracle", "999")]
        achadas = buscar_os(ordens, " 7285 ")
        self.assertEqual([(o["fonte"], o["utic"], o["campo"]) for o in achadas], [("simpress", "UTIC-2026-15", "os"), ("oracle", None, "os")])
        self.assertEqual(buscar_os(ordens, "728"), [])
        self.assertEqual(buscar_os(ordens, "ZZZ"), [])
        self.assertEqual(len(buscar_os([ordem("oracle", f"12345{n}") for n in range(9)], "12345")), 5)

    def test_texto_so_com_tres_ou_mais_caracteres_com_e_sem_acento(self):
        f = fontes(novos=[("UTIC-2026-15", {"solicitante": "José Açaí"})], antigos=[("UTIC-2026-20", {"titulo": "Teclado quebrado"})])
        self.assertEqual(buscar_chamados(f, "jose acai"), [{"numero": "UTIC-2026-15", "aba": "novos", "campo": "solicitante"}])
        self.assertEqual(buscar_chamados(f, "TECLADO"), [{"numero": "UTIC-2026-20", "aba": "antigos", "campo": "titulo"}])
        self.assertEqual(buscar_chamados(f, "te"), [])

    def test_prioridade_dedup_e_campos_de_os(self):
        ordens = [ordem("oracle", "1111111"), ordem("oracle", "2222222", "UTIC-2026-15"), ordem("oracle", "3333333")]
        ordens[0]["serie"], ordens[1]["serie"], ordens[2]["serie"] = "ZZ9", "ABC123", "EQ77"
        desc = {("oracle", "1111111"): "Falha na Mariana CPF 123.456.789-09"}
        achadas = buscar_os(ordens, "abc", descricoes=desc)
        self.assertEqual([(o["os"], o["campo"]) for o in achadas], [("2222222", "serie")])
        achadas = buscar_os(ordens, "eq77", series_equipamento=["eq77"])
        self.assertEqual([(o["os"], o["campo"]) for o in achadas], [("3333333", "serie")])
        achadas = buscar_os(ordens, "xx", series_equipamento=["EQ77"])
        self.assertEqual([(o["os"], o["campo"]) for o in achadas], [("3333333", "equipamento")])
        self.assertEqual([(o["os"], o["campo"]) for o in buscar_os(ordens, "mariana", descricoes=desc)], [("1111111", "descricao")])
        self.assertEqual(buscar_os(ordens, "ana", descricoes=desc), [])  # início de palavra, como a F6
        self.assertEqual(buscar_os(ordens, "123.456.789-09", descricoes=desc), [])  # CPF mascarado antes da busca
        self.assertEqual([(o["os"], o["campo"]) for o in buscar_os(ordens, "utic-2026-15")], [("2222222", "chamado_vinculado")])
        # chamado: número vence vínculo e texto; vínculo vence texto; um chamado aparece uma vez
        f = fontes(novos=[("UTIC-2026-15", {"titulo": "abc"}), ("UTIC-2026-16", {"titulo": "abc"})],
                   antigos=[("UTIC-2026-17", {"titulo": "abc"}), ("UTIC-2026-15", {})])
        achadas = buscar_os(ordens, "abc")
        achadas[0]["utic"] = "UTIC-2026-16"
        self.assertEqual(buscar_chamados(f, "abc", os_achadas=achadas),
                         [{"numero": "UTIC-2026-16", "aba": "novos", "campo": "os_vinculada"},
                          {"numero": "UTIC-2026-15", "aba": "novos", "campo": "titulo"},
                          {"numero": "UTIC-2026-17", "aba": "antigos", "campo": "titulo"}])


class RotaTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(dir=tempfile.gettempdir())
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.tickets = fontes(novos=[("UTIC-2026-15", {"titulo": f"Mouse CPF {CPF}", "solicitante": NOME, "descricao": f"Trocar fonte zzdescx CPF {CPF}"})],
                              antigos=[("UTIC-2026-20", {"titulo": "Teclado quebrado"})], finalizados=["UTIC-2026-30"])
        self.series_equipamento = []

    def series_para(self, q):
        if isinstance(self.series_equipamento, Exception):
            raise self.series_equipamento
        return self.series_equipamento

    def client(self, **extra):
        router = create_operations_router(
            load_comparison_history=lambda: [], comparison_history_for_display=lambda e: e,
            ticket_report_path=lambda: self.root / "tickets.json", transaction_root=lambda: self.root,
            ticket_os_links_file=lambda: self.root / "vinculos.json",
            **{"sebrae_tickets": lambda: self.tickets, "equipment_series_for_term": self.series_para, **extra},
        )
        app = FastAPI()
        app.include_router(router)
        return TestClient(app)

    def write_report(self, links=None, descricao=f"Notebook do {NOME} CPF {CPF}"):
        row = {"serie": "ABC123", "simpress": {"ordens_servico": ["7285070"], "status": ["Aberta"]},
               "oracle": [{"ordem_servico": "7285070", "status": "Em atendimento", "usuario": NOME, "descricao": descricao}]}
        snap = {"id": "imp-1", "atualizado_em": "2026-11-01T09:00:00", "fontes": {}, "resumo": {}, "chamados": [row]}
        (self.root / "tickets.json").write_text(json.dumps({**{k: snap[k] for k in ("atualizado_em", "fontes", "resumo", "chamados")},
                                                            "snapshot_id": "imp-1", "historico": [snap]}), encoding="utf-8")
        (self.root / "vinculos.json").write_text(json.dumps({"version": 1, "vinculos": links or {}}), encoding="utf-8")

    def link(self):
        link = {"fonte": "oracle", "serie": "ABC123", "os": "7285070", "ano": 2026, "numero": "15", "chamado": "UTIC-2026-15"}
        return {json.dumps(["oracle", "ABC123", "7285070"], separators=(",", ":")): link}

    def busca(self, q, client=None):
        return (client or self.client()).get("/api/buscar/chamados-os", params={"q": q}).json()

    def test_validacao_do_termo(self):
        client = self.client()
        self.assertEqual(client.get("/api/buscar/chamados-os", params={"q": "a"}).status_code, 422)
        self.assertEqual(client.get("/api/buscar/chamados-os", params={"q": "a" * 201}).status_code, 422)
        self.assertEqual(client.get("/api/buscar/chamados-os").status_code, 422)

    def test_chamados_e_os_com_vinculo_sem_campos_extras(self):
        self.write_report(self.link())
        self.assertEqual(self.busca("2026-20"), {"chamados": [{"numero": "UTIC-2026-20", "aba": "antigos", "campo": "numero"}], "os": []})
        corpo = self.busca("7285")
        self.assertEqual({(o["fonte"], o["os"], o["utic"], o["campo"]) for o in corpo["os"]},
                         {("simpress", "7285070", None, "os"), ("oracle", "7285070", "UTIC-2026-15", "os")})
        self.assertEqual(corpo["chamados"], [{"numero": "UTIC-2026-15", "aba": "novos", "campo": "os_vinculada"}])
        self.assertEqual(set(corpo["os"][0]), {"fonte", "os", "serie", "status", "utic", "campo"})
        self.assertEqual(set(corpo["chamados"][0]), {"numero", "aba", "campo"})

    def test_serie_acha_os_e_chamado_vinculado(self):
        self.write_report(self.link())
        corpo = self.busca("abc123")
        self.assertEqual({(o["fonte"], o["campo"]) for o in corpo["os"]}, {("simpress", "serie"), ("oracle", "serie")})
        self.assertEqual(corpo["chamados"], [{"numero": "UTIC-2026-15", "aba": "novos", "campo": "os_vinculada"}])

    def test_equipamento_pela_busca_de_equipamentos(self):
        self.write_report()
        self.series_equipamento = ["abc123"]
        corpo = self.busca("prnotexyz")  # hostname, apelido ou nome: quem resolve é a busca de equipamentos
        self.assertEqual({o["campo"] for o in corpo["os"]}, {"equipamento"})
        self.assertEqual(len(corpo["os"]), 2)
        self.series_equipamento = []
        self.assertEqual(self.busca("prnotexyz"), {"chamados": [], "os": []})

    def test_busca_de_equipamentos_falhando_segue_sem_ela(self):
        self.write_report()
        client = self.client()
        self.series_equipamento = TypeError("x")  # a busca de equipamentos levanta
        corpo = self.busca("7285", client)
        self.assertEqual(len(corpo["os"]), 2)

    def test_texto_de_chamado_e_de_os_so_com_tres_caracteres(self):
        self.write_report()
        corpo = self.busca("beltrano")  # o nome também está na descrição Oracle da OS
        self.assertEqual(corpo["chamados"], [{"numero": "UTIC-2026-15", "aba": "novos", "campo": "solicitante"}])
        self.assertEqual([o["campo"] for o in corpo["os"]], ["descricao"])
        self.assertEqual(self.busca("BELTRÁNO")["chamados"][0]["campo"], "solicitante")  # acento e caixa não contam
        self.assertEqual(self.busca("Sintético")["chamados"][0]["campo"], "solicitante")
        self.assertEqual(self.busca("teclado")["chamados"], [{"numero": "UTIC-2026-20", "aba": "antigos", "campo": "titulo"}])
        self.assertEqual(self.busca("te"), {"chamados": [], "os": []})
        self.assertEqual([(o["os"], o["campo"]) for o in self.busca("notebook")["os"]], [("7285070", "descricao")])

    def test_descricao_acha_chamado_sem_devolver_o_texto(self):
        self.write_report()
        corpo = self.busca("zzdescx")
        self.assertEqual(corpo["chamados"], [{"numero": "UTIC-2026-15", "aba": "novos", "campo": "descricao"}])
        self.assertNotIn("Trocar", json.dumps(corpo))
        self.assertEqual(self.busca("descx")["chamados"], [])  # início de palavra
        self.assertEqual(self.busca(CPF)["chamados"], [])  # CPF mascarado antes de comparar

    def test_ordem_prioridade_e_limite(self):
        self.tickets = fontes(novos=[(f"UTIC-2026-{n}", {"titulo": "mouse"}) for n in range(10, 17)],
                              antigos=[("UTIC-2026-99", {"titulo": "x"})])
        self.assertEqual(len(self.busca("mouse")["chamados"]), 5)
        self.tickets["antigos"] = [("UTIC-2026-88", {"titulo": "mouse"}), ("UTIC-2026-88", {"titulo": "mouse"}), ("UTIC-2026-15", {})]
        self.tickets["novos"] = [("UTIC-2026-10", {"titulo": "mouse"})]
        self.assertEqual([c["campo"] for c in self.busca("utic-2026-8")["chamados"]], ["numero"])
        self.assertEqual([c["numero"] for c in self.busca("mouse")["chamados"]], ["UTIC-2026-10", "UTIC-2026-88"])

    def test_observacao_e_credencial_nao_sao_fonte(self):
        self.write_report()
        for nome, conteudo in (("os_observacoes.json", {"x": "zzobservacao"}), ("sebrae_observacoes.json", {"UTIC-2026-15": "zzobservacao"}),
                               ("sebrae_credenciais.json", {"UTIC-2026-15": "zzobservacao"}),
                               ("sebrae_chamados_encerrados.json", {"UTIC-2026-15": "zzobservacao"})):
            (self.root / nome).write_text(json.dumps(conteudo), encoding="utf-8")
        self.assertEqual(self.busca("zzobservacao"), {"chamados": [], "os": []})

    def test_lgpd_resposta_sem_texto_e_cpf_nao_acha(self):
        self.write_report(self.link())
        for q in ("7285", "abc123", "beltrano", "notebook", "mouse"):
            corpo = json.dumps(self.busca(q))
            for proibido in (CPF, NOME, '"titulo":', '"descricao":', '"solicitante":', '"usuario":'):
                self.assertNotIn(proibido, corpo)
        self.assertEqual(self.busca(CPF), {"chamados": [], "os": []})

    def test_marca_de_finalizacao_vincula_a_os_ao_chamado(self):
        self.write_report()
        marca = {"serie": "ABC123", "os": "7285070", "chamado": "UTIC-2026-30", "ativa": True, "finalizado_em": ""}
        client = self.client(ticket_os_marks_file=lambda: self.root / "marcas.json")
        with patch("routers.operations.ler_marcas", return_value=[marca]):
            corpo = self.busca("utic-2026-30", client)
            self.assertEqual({(o["fonte"], o["utic"], o["campo"]) for o in corpo["os"]},
                             {("simpress", "UTIC-2026-30", "chamado_vinculado"), ("oracle", "UTIC-2026-30", "chamado_vinculado")})
            self.assertEqual(self.busca("7285", client)["chamados"], [{"numero": "UTIC-2026-30", "aba": "finalizados", "campo": "os_vinculada"}])

    def test_fonte_de_chamados_quebrada_nao_derruba_as_os(self):
        self.write_report()
        client = self.client(sebrae_tickets=_levanta)
        with self.assertLogs(level=logging.DEBUG) as logs:
            logging.getLogger().debug("sentinela")
            resposta = client.get("/api/buscar/chamados-os", params={"q": "7285070"})
        self.assertEqual(resposta.status_code, 200)
        self.assertEqual(len(resposta.json()["os"]), 2)
        self.assertEqual(resposta.json()["chamados"], [])
        self.assertTrue(any("DomainBusyError" in linha for linha in logs.output))
        self.assertNotIn("7285070", "\n".join(r.getMessage() for r in logs.records if r.name != "httpx"))

    def test_relatorio_ausente_ou_ilegivel_nao_derruba(self):
        client = self.client()
        self.assertEqual(self.busca("7285", client), {"chamados": [], "os": []})
        (self.root / "tickets.json").write_text("{", encoding="utf-8")
        self.assertEqual(self.busca("7285", client), {"chamados": [], "os": []})
        self.assertEqual(len(self.busca("teclado", client)["chamados"]), 1)  # a fonte de chamados segue valendo

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

    def test_equipamentos_falhando_nao_loga_o_termo(self):
        self.write_report()
        client = self.client()
        with self.assertLogs(level=logging.DEBUG) as logs:
            logging.getLogger().debug("sentinela")
            self.series_equipamento = TypeError("x")
            self.busca("7285070", client)
        self.assertTrue(any("TypeError" in linha for linha in logs.output))
        self.assertNotIn("7285070", "\n".join(r.getMessage() for r in logs.records if r.name != "httpx"))


class MainFontesTests(unittest.TestCase):
    """``_sebrae_tickets`` do main: fonte ilegível é pulada; título, solicitante e descrição; sem observação."""

    def test_fontes_ilegiveis_e_campos_do_f5(self):
        import main
        with tempfile.TemporaryDirectory(dir=tempfile.gettempdir()) as tmp:
            state = Path(tmp)
            (state / "sebrae_dashboard_existentes.json").write_text(json.dumps({
                "numeros": ["UTIC-2026-99"], "abertos": [{"chamado": "UTIC-2026-20", "usuario": NOME, "titulo": "Teclado", "descricao": "zzdesc"}]}), encoding="utf-8")
            (state / "sebrae_novos.json").write_text(json.dumps({"chamados": [
                {"numero": "UTIC-2026-15", "titulo": "Mouse", "solicitante": NOME, "descricao": "zzdesc"}]}), encoding="utf-8")
            (state / "sebrae_observacoes.json").write_text(json.dumps({"UTIC-2026-15": "zzobs"}), encoding="utf-8")
            with patch.object(main, "STATE_DIR", state), self.assertLogs(level=logging.DEBUG) as logs:
                logging.getLogger().debug("sentinela")
                (state / "sebrae_finalizacao.json").write_text("{", encoding="utf-8")  # ler_estado levanta DomainBusyError
                fontes = main._sebrae_tickets()
            self.assertEqual(fontes, {"novos": [("UTIC-2026-15", {"titulo": "Mouse", "solicitante": NOME, "descricao": "zzdesc"})],
                                      "antigos": [("UTIC-2026-20", {"titulo": "Teclado", "solicitante": NOME, "descricao": "zzdesc"})], "finalizados": []})
            self.assertNotIn("zzobs", json.dumps(fontes))
            self.assertTrue(any("DomainBusyError" in linha for linha in logs.output))


if __name__ == "__main__":
    unittest.main()
