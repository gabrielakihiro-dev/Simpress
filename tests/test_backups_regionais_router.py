"""Rotas /api/backups-regionais: confirmar e desfazer, sessão, estado ilegível e arquivo ocupado.

Só dados sintéticos, pasta temporária e data fixa injetada; nunca usa ``data/``.
"""

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

with (
    mock.patch("core.integrity.recover_pending_transactions", return_value=None),
    mock.patch("openpyxl.load_workbook", side_effect=RuntimeError("operational data blocked")),
    redirect_stdout(io.StringIO()),
):
    import main

from fastapi import FastAPI
from fastapi.testclient import TestClient

from core.errors import DomainConflictError
from core.integrity import FileBusyError, TransactionConflictError
from domains.backups_regionais import usuario_ref
from domains.coverage import Manutencao
from domains.effective_alias import build_endpoint_alias_index
from routers.backups_regionais import BackupsRegionaisServices, create_backups_regionais_router

AGORA = datetime(2026, 11, 12, 12, 0, tzinfo=timezone(timedelta(hours=-3)))
CONFIRMAR = "/api/backups-regionais/confirmar"
DESFAZER = "/api/backups-regionais/desfazer"
MANTER = "/api/backups-regionais/manter"
EXCLUIR = "/api/backups-regionais/excluir"
CAMPOS = {"serie", "cidade", "confirmado_em", "tipo"}


def notebook(serie, cidade="Cascavel", base="", **extra):
    item = {
        "serial": serie, "tipo": "NOTEBOOK", "modelo": "Latitude 5440", "retirada_cidade": cidade,
        "_apelido_base": base, "apelido": base, "_apelido_manual_override": False,
        "serie_detalhes_duplicada": False,
    }
    item.update(extra)
    return item


def endpoint(*linhas):
    """Cada linha: (serie, hostname, verificado_em|None, usuario)."""
    registros = [
        {
            "SERIAL": serie, "NOMEDOCOMPUTADOR": hostname, "USUARIOSLOGADOS": usuario,
            "ULTIMAVERIFICACAOCOMEXITO": verificado.isoformat() if verificado else "",
        }
        for serie, hostname, verificado, *resto in linhas
        for usuario in [resto[0] if resto else ""]
    ]
    indice = build_endpoint_alias_index(registros)
    indice["manual_users"] = {}
    indice["user_holds"] = {}
    return indice


class BackupsRegionaisRouterTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.state = self.root / "data" / "state" / "backups_regionais.json"
        self.agora = AGORA
        # NB1 (Cascavel) e NB2 (Londrina) somem do Endpoint: candidatas. OUTRO só deixa o Endpoint disponível.
        self.equipamentos = [notebook("NB1", "Cascavel"), notebook("NB2", "Londrina")]
        self.endpoint = endpoint(("OUTRO", "PRNOTE-X", AGORA - timedelta(days=1)))
        self.ler_endpoint = lambda: self.endpoint
        self.manuais = set()
        self.removidos = []
        self.erro_apelido = None
        router = create_backups_regionais_router(BackupsRegionaisServices(
            state_file=lambda: self.state,
            transaction_root=lambda: self.root,
            equipamentos=lambda: self.equipamentos,
            endpoint=lambda: self.ler_endpoint(),
            estado_cobertura=lambda: {"disponibilidade": {}, "reservas": {}, "movimentacoes": {}, "devolucoes": {}},
            manutencao=lambda: Manutencao(),
            agora=lambda: self.agora,
            series_apelido_manual=lambda: self.manuais,
            remover_apelido_manual=lambda serie: self.remover(serie),
        ))
        app = FastAPI()
        app.include_router(router)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def remover(self, serie):
        if self.erro_apelido is not None:
            raise self.erro_apelido
        self.removidos.append(serie)

    def post(self, caminho, serie="NB1", cidade="Cascavel", status=200):
        resposta = self.client.post(caminho, json={"serie": serie, "cidade": cidade})
        self.assertEqual(resposta.status_code, status, resposta.text)
        return resposta.json()

    def arquivo(self):
        return json.loads(self.state.read_text(encoding="utf-8"))

    def semear(self, conteudo):
        self.state.parent.mkdir(parents=True)
        self.state.write_bytes(conteudo if isinstance(conteudo, bytes) else json.dumps(conteudo).encode("utf-8"))

    def test_sem_cookie_de_sessao_responde_401(self):
        client = TestClient(main.app, base_url=f"http://127.0.0.1:{main.SERVER_PORT}", client=("127.0.0.1", 1234))
        self.addCleanup(client.close)
        for caminho in (CONFIRMAR, DESFAZER):
            with self.subTest(caminho=caminho):
                self.assertEqual(client.post(caminho, json={"serie": "NB1", "cidade": "Cascavel"}).status_code, 401)

    def test_corpo_com_campo_extra_e_recusado(self):
        for caminho in (CONFIRMAR, DESFAZER):
            with self.subTest(caminho=caminho):
                resposta = self.client.post(caminho, json={"serie": "NB1", "cidade": "Cascavel", "expira_em": "2099-01-01"})
                self.assertEqual(resposta.status_code, 422, resposta.text)
        self.assertFalse(self.state.exists())

    def test_serie_que_nao_e_candidata_responde_422_sem_criar_arquivo(self):
        casos = (("ZZZ9", "Cascavel"), ("NB2", "Cascavel"), ("NB1", "Londrina"))  # inexistente, de outra cidade, cidade trocada
        for serie, cidade in casos:
            with self.subTest(serie=serie, cidade=cidade):
                erro = self.post(CONFIRMAR, serie, cidade, 422)["detail"]
                self.assertEqual(erro["codigo"], "serie_nao_elegivel")
        self.assertFalse(self.state.exists())

    def test_confirmar_candidata_grava_registro_sem_prazo_e_repetir_nao_muda_nada(self):
        resposta = self.post(CONFIRMAR)
        registro = resposta["confirmacao"]
        self.assertFalse(resposta["repetido"])
        self.assertEqual(set(registro), CAMPOS)  # a resposta nunca leva usuario_ref
        self.assertEqual((registro["serie"], registro["cidade"], registro["tipo"]), ("NB1", "Cascavel", "backup"))
        self.assertEqual(registro["confirmado_em"], AGORA.isoformat(timespec="seconds"))
        self.assertEqual(self.arquivo(), {"esquema": 1, "confirmacoes": [{**registro, "usuario_ref": ""}]})
        gravado = self.arquivo()

        self.agora = AGORA + timedelta(days=1)
        segunda = self.post(CONFIRMAR)
        self.assertTrue(segunda["repetido"])
        self.assertEqual(segunda["confirmacao"], registro)
        self.assertEqual(self.arquivo(), gravado)

    def com_usuario(self, usuario):
        """NB1 candidata com verificação velha (não é usuário vigente) e o usuário dado no Endpoint."""
        self.endpoint = endpoint(("NB1", "PRNOTE-1", AGORA - timedelta(days=30), usuario))
        self.endpoint["verified_by_serial"] = {}

    def test_confirmar_grava_ref_do_usuario_endpoint(self):
        self.com_usuario("joao")
        resposta = self.post(CONFIRMAR)
        self.assertEqual(set(resposta["confirmacao"]), CAMPOS)
        self.assertNotIn("sha256", json.dumps(resposta))
        self.assertEqual(self.arquivo()["confirmacoes"][0]["usuario_ref"], usuario_ref("joao"))
        self.assertTrue(usuario_ref("joao").startswith("sha256:"))

    def test_confirmar_com_admin_grava_ref_vazio(self):
        self.com_usuario(r".\Administrador")
        self.post(CONFIRMAR)
        self.assertEqual(self.arquivo()["confirmacoes"][0]["usuario_ref"], "")

    def test_confirmar_sem_usuario_grava_ref_vazio(self):
        self.post(CONFIRMAR)  # NB1 some do Endpoint
        self.assertEqual(self.arquivo()["confirmacoes"][0]["usuario_ref"], "")

    def test_confirmar_endpoint_indisponivel_409_nada_gravado(self):
        self.endpoint = {"available": False}
        erro = self.post(CONFIRMAR, status=409)["detail"]
        self.assertEqual(erro["codigo"], "endpoint_indisponivel")
        self.assertFalse(self.state.exists())

    def test_payload_com_usuario_recusado_422(self):
        resposta = self.client.post(CONFIRMAR, json={"serie": "NB1", "cidade": "Cascavel", "usuario": "joao"})
        self.assertEqual(resposta.status_code, 422, resposta.text)
        self.assertFalse(self.state.exists())

    def test_endpoint_com_falha_recusa_confirmar_409_e_o_log_so_tem_a_classe(self):
        def falha():
            raise OSError(r"C:\caminho\local\endpoint.xlsx")
        self.ler_endpoint = falha
        with self.assertLogs(level="WARNING") as logs:
            erro = self.post(CONFIRMAR, status=409)["detail"]  # o painel mostra NB1 com fonte_endpoint_indisponivel
        self.assertEqual(erro["codigo"], "endpoint_indisponivel")
        self.assertFalse(self.state.exists())
        self.assertTrue(any("OSError" in linha for linha in logs.output))
        self.assertFalse(any("caminho" in linha for linha in logs.output))

    def test_desfazer_remove_o_registro_e_repetir_responde_removido_false(self):
        self.post(CONFIRMAR)
        primeira = self.post(DESFAZER)
        self.assertEqual(primeira, {"serie": "NB1", "cidade": "Cascavel", "removido": True})
        self.assertEqual(self.arquivo(), {"esquema": 1, "confirmacoes": []})
        self.assertFalse(self.post(DESFAZER)["removido"])
        self.assertEqual(self.arquivo(), {"esquema": 1, "confirmacoes": []})

    def test_estado_ilegivel_responde_503_e_o_arquivo_fica_igual(self):
        conteudos = {
            "json_invalido": b"{quebrado",
            "chave_desconhecida": json.dumps({"esquema": 1, "confirmacoes": [], "extra": 1}).encode("utf-8"),
            "esquema_booleano": json.dumps({"esquema": True, "confirmacoes": []}).encode("utf-8"),
        }
        for nome, conteudo in conteudos.items():
            for caminho in (CONFIRMAR, DESFAZER):
                with self.subTest(conteudo=nome, caminho=caminho):
                    self.state.parent.mkdir(parents=True, exist_ok=True)
                    self.state.write_bytes(conteudo)
                    erro = self.post(caminho, status=503)["detail"]
                    self.assertEqual(erro["codigo"], "estado_ilegível")
                    self.assertEqual(self.state.read_bytes(), conteudo)

    def test_arquivo_ocupado_responde_409(self):
        ocupado = FileBusyError("SEGREDO C:/Users/pessoa/arquivo.json")
        with mock.patch("domains.backups_regionais_store.AtomicFileTransaction", side_effect=ocupado):
            for caminho in (CONFIRMAR, DESFAZER):
                with self.subTest(caminho=caminho):
                    resposta = self.client.post(caminho, json={"serie": "NB1", "cidade": "Cascavel"})
                    self.assertEqual(resposta.status_code, 409, resposta.text)
                    self.assertEqual(resposta.json()["detail"]["codigo"], "arquivo_ocupado")
                    self.assertNotIn("SEGREDO", resposta.text)
        self.assertFalse(self.state.exists())

    def test_falha_passageira_de_leitura_responde_409_e_nao_503(self):
        self.semear({"esquema": 1, "confirmacoes": []})
        # Desfazer não lê antes na rota: a leitura prévia do store também transforma o erro passageiro em 409 (não 500).
        for caminho in (CONFIRMAR, DESFAZER):
            with self.subTest(caminho=caminho):
                with mock.patch("pathlib.Path.read_text", side_effect=PermissionError("SEGREDO C:/Users/pessoa/arquivo.json")):
                    resposta = self.client.post(caminho, json={"serie": "NB1", "cidade": "Cascavel"})
                self.assertEqual(resposta.status_code, 409, resposta.text)
                self.assertEqual(resposta.json()["detail"]["codigo"], "arquivo_ocupado")
                self.assertNotIn("SEGREDO", resposta.text)
                self.assertEqual(self.arquivo(), {"esquema": 1, "confirmacoes": []})

    def test_gravar_poda_expiradas_antigas_e_mantem_a_recem_expirada(self):
        def registro(serie, cidade, expirou_ha):
            expira = AGORA - timedelta(days=expirou_ha)
            return {
                "serie": serie, "cidade": cidade,
                "confirmado_em": (expira - timedelta(days=7)).isoformat(timespec="seconds"),
                "expira_em": expira.isoformat(timespec="seconds"),
            }
        recente, antiga = registro("NB2", "Londrina", 1), registro("VELHA", "Cascavel", 8)
        self.semear({"esquema": 1, "confirmacoes": [recente, antiga]})
        self.post(CONFIRMAR)
        self.assertEqual([r["serie"] for r in self.arquivo()["confirmacoes"]], ["NB2", "NB1"])
        # Desfazer uma antiga devolve removido: true (a poda vem depois) e ela sai do arquivo.
        self.state.write_text(json.dumps({"esquema": 1, "confirmacoes": [recente, antiga]}), encoding="utf-8")
        self.assertTrue(self.post(DESFAZER, serie="VELHA")["removido"])
        self.assertEqual(self.arquivo(), {"esquema": 1, "confirmacoes": [recente]})

    def test_confirmacao_expirada_e_substituida_por_uma_nova(self):
        self.semear({"esquema": 1, "confirmacoes": [{
            "serie": "NB1", "cidade": "Cascavel",
            "confirmado_em": (AGORA - timedelta(days=8)).isoformat(timespec="seconds"),
            "expira_em": (AGORA - timedelta(days=1)).isoformat(timespec="seconds"),
        }]})
        resposta = self.post(CONFIRMAR)
        self.assertFalse(resposta["repetido"])
        self.assertEqual(resposta["confirmacao"]["tipo"], "backup")
        confirmacoes = self.arquivo()["confirmacoes"]
        self.assertEqual(confirmacoes, [{**resposta["confirmacao"], "usuario_ref": ""}])

    def test_desfazer_com_a_cidade_gravada_remove_mesmo_com_o_cadastro_em_outra(self):
        self.semear({"esquema": 1, "confirmacoes": [{
            "serie": "NB1", "cidade": "Londrina", "confirmado_em": AGORA.isoformat(timespec="seconds"),
            "tipo": "backup", "usuario_ref": "",
        }]})
        resposta = self.post(DESFAZER, cidade="Londrina")  # cadastro de NB1: Cascavel
        self.assertEqual(resposta, {"serie": "NB1", "cidade": "Londrina", "removido": True})
        self.assertEqual(self.arquivo(), {"esquema": 1, "confirmacoes": []})

    def test_desfazer_com_outra_grafia_remove_e_devolve_a_gravada(self):
        self.post(CONFIRMAR)
        resposta = self.post(DESFAZER, serie="nb1", cidade="CASCAVEL")
        self.assertEqual(resposta, {"serie": "NB1", "cidade": "Cascavel", "removido": True})
        self.assertEqual(self.arquivo(), {"esquema": 1, "confirmacoes": []})

    def test_rollback_com_conflito_responde_500_e_nao_503(self):
        conflito = TransactionConflictError("C:/Users/pessoa/arquivo.json")
        conflito.__cause__ = ValueError("estado")
        with mock.patch("domains.backups_regionais_store.AtomicFileTransaction", side_effect=conflito):
            resposta = self.client.post(DESFAZER, json={"serie": "NB1", "cidade": "Cascavel"})
        self.assertEqual(resposta.status_code, 500, resposta.text)
        self.assertEqual(resposta.json()["detail"]["codigo"], "falha_gravacao")
        self.assertNotIn("pessoa", resposta.text)

    # Manter e Excluir: NB1 confirmada por joao, apelido manual, Endpoint agora mostra maria.
    def com_pendencia(self):
        self.manuais = {"NB1"}
        self.endpoint = endpoint(("NB1", "PRNOTE-1", AGORA - timedelta(days=1), "maria"))
        self.semear({"esquema": 1, "confirmacoes": [{
            "serie": "NB1", "cidade": "Cascavel", "confirmado_em": AGORA.isoformat(timespec="seconds"),
            "tipo": "backup", "usuario_ref": usuario_ref("joao"),
        }]})

    def test_manter_regrava_ref_atual_e_grava_decisao(self):
        self.com_pendencia()
        resposta = self.post(MANTER)
        self.assertEqual(resposta, {"serie": "NB1", "cidade": "Cascavel", "decisao": "manter"})
        gravado = self.arquivo()
        self.assertEqual(gravado["confirmacoes"][0]["usuario_ref"], usuario_ref("maria"))
        self.assertEqual([(d["serie"], d["cidade"], d["decisao"]) for d in gravado["decisoes"]], [("NB1", "Cascavel", "manter")])
        self.assertEqual(self.removidos, [])
        # Mesmo usuário não pergunta de novo; outro usuário real pergunta.
        self.post(MANTER, status=409)
        self.endpoint = endpoint(("NB1", "PRNOTE-1", AGORA - timedelta(days=1), "pedro"))
        self.post(MANTER)

    def test_manter_e_excluir_sem_pendencia_409_nada_gravado(self):
        self.com_pendencia()
        for nome, manuais, serie in (("sem_apelido_manual", set(), "NB1"), ("outra_serie", {"NB1"}, "ZZZ")):
            for caminho in (MANTER, EXCLUIR):
                with self.subTest(caso=nome, caminho=caminho):
                    self.manuais = manuais
                    antes_ = self.state.read_bytes()
                    erro = self.post(caminho, serie, status=409)["detail"]
                    self.assertEqual(erro["codigo"], "sem_decisao_pendente")
                    self.assertEqual(self.state.read_bytes(), antes_)
        self.assertEqual(self.removidos, [])

    def test_excluir_remove_apelido_depois_confirmacao_e_grava_decisao(self):
        self.com_pendencia()
        resposta = self.post(EXCLUIR)
        self.assertEqual(resposta, {"serie": "NB1", "cidade": "Cascavel", "decisao": "excluir"})
        self.assertEqual(self.removidos, ["NB1"])
        gravado = self.arquivo()
        self.assertEqual(gravado["confirmacoes"], [])
        self.assertEqual([d["decisao"] for d in gravado["decisoes"]], ["excluir"])

    def test_excluir_com_erro_do_apelido_nada_gravado(self):
        self.com_pendencia()
        self.erro_apelido = DomainConflictError("SEGREDO NB1 C:/Users/pessoa/apelidos.json")
        antes_ = self.state.read_bytes()
        with self.assertLogs(level="WARNING") as logs:
            erro = self.post(EXCLUIR, status=409)["detail"]
        self.assertEqual(erro["codigo"], "apelido_nao_removido")
        self.assertNotIn("SEGREDO", json.dumps(erro))
        self.assertFalse(any("SEGREDO" in linha for linha in logs.output))
        self.assertEqual(self.state.read_bytes(), antes_)

    def test_respostas_sem_usuario_ref_nem_apelido(self):
        self.com_pendencia()
        self.equipamentos = [notebook("NB1", "Cascavel", base="Fulano (M)", apelido="Fulano (M)", _apelido_manual_override=True)]
        respostas = [self.client.post(CONFIRMAR, json={"serie": "NB1", "cidade": "Cascavel"}).text]  # 409 decisao_pendente
        respostas.append(json.dumps(self.post(MANTER)))
        self.endpoint = endpoint(("NB1", "PRNOTE-1", AGORA - timedelta(days=1), "pedro"))
        respostas.append(json.dumps(self.post(EXCLUIR)))
        for texto in respostas:
            self.assertNotIn("sha256", texto)
            self.assertNotIn("Fulano", texto)

    def test_confirmar_em_item_pendente_409_decisao_pendente(self):
        self.com_pendencia()
        antes_ = self.state.read_bytes()
        self.assertEqual(self.post(CONFIRMAR, status=409)["detail"]["codigo"], "decisao_pendente")
        self.assertEqual(self.state.read_bytes(), antes_)

    def test_manter_e_excluir_sem_endpoint_ou_com_admin_409_nada_gravado(self):
        self.com_pendencia()
        antes_ = self.state.read_bytes()
        for nome, endpoint_novo, codigo in (
            ("indisponivel", {"available": False}, "endpoint_indisponivel"),
            ("admin", endpoint(("NB1", "PRNOTE-1", AGORA - timedelta(days=1), r".\Administrador")), "sem_decisao_pendente"),
        ):
            for caminho in (MANTER, EXCLUIR):
                with self.subTest(caso=nome, caminho=caminho):
                    self.endpoint = endpoint_novo
                    self.assertEqual(self.post(caminho, status=409)["detail"]["codigo"], codigo)
                    self.assertEqual(self.state.read_bytes(), antes_)
        self.assertEqual(self.removidos, [])

    def test_corrida_manter_depois_de_outra_decisao_409_nada_gravado(self):
        self.com_pendencia()
        # A confirmação muda entre a leitura da rota e a gravação (outro Manter chegou antes).
        import routers.backups_regionais as rota
        chamadas = []
        real = rota._pendente

        def pendente_e_troca(calculo, serie, cidade):
            achada = real(calculo, serie, cidade)
            if achada and not chamadas:
                chamadas.append(1)
                outro = json.loads(self.state.read_text(encoding="utf-8"))
                outro["confirmacoes"][0]["usuario_ref"] = usuario_ref("pedro")
                self.state.write_text(json.dumps(outro), encoding="utf-8")
            return achada
        with mock.patch.object(rota, "_pendente", pendente_e_troca):
            erro = self.post(MANTER, status=409)["detail"]
        self.assertEqual(erro["codigo"], "sem_decisao_pendente")
        self.assertNotIn("decisoes", self.arquivo())
        self.assertEqual(self.arquivo()["confirmacoes"][0]["usuario_ref"], usuario_ref("pedro"))

    def test_corrida_excluir_depois_de_outra_decisao_409_nada_gravado(self):
        self.com_pendencia()
        import routers.backups_regionais as rota
        chamadas = []
        real = rota._pendente

        def pendente_e_troca(calculo, serie, cidade):
            achada = real(calculo, serie, cidade)
            if achada and not chamadas:
                chamadas.append(1)
                outro = json.loads(self.state.read_text(encoding="utf-8"))
                outro["confirmacoes"][0]["usuario_ref"] = usuario_ref("pedro")
                self.state.write_text(json.dumps(outro), encoding="utf-8")
            return achada
        with mock.patch.object(rota, "_pendente", pendente_e_troca):
            erro = self.post(EXCLUIR, status=409)["detail"]
        self.assertEqual(erro["codigo"], "sem_decisao_pendente")
        self.assertNotIn("decisoes", self.arquivo())
        self.assertEqual(self.arquivo()["confirmacoes"][0]["usuario_ref"], usuario_ref("pedro"))

    def test_decisoes_invalido_e_ilegivel_503(self):
        self.com_pendencia()
        conteudo = json.dumps({"esquema": 1, "confirmacoes": [], "decisoes": "x"}).encode("utf-8")
        self.state.write_bytes(conteudo)
        for caminho in (MANTER, EXCLUIR):
            with self.subTest(caminho=caminho):
                self.post(caminho, status=503)
                self.assertEqual(self.state.read_bytes(), conteudo)

    def test_corpo_extra_manter_excluir(self):
        self.com_pendencia()
        for caminho in (MANTER, EXCLUIR):
            self.assertEqual(self.client.post(caminho, json={"serie": "NB1", "cidade": "Cascavel", "x": 1}).status_code, 422)

if __name__ == "__main__":
    unittest.main()
