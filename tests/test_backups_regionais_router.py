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

from core.integrity import FileBusyError, TransactionConflictError
from domains.coverage import Manutencao
from domains.effective_alias import build_endpoint_alias_index
from routers.backups_regionais import BackupsRegionaisServices, create_backups_regionais_router

AGORA = datetime(2026, 11, 12, 12, 0, tzinfo=timezone(timedelta(hours=-3)))
CONFIRMAR = "/api/backups-regionais/confirmar"
DESFAZER = "/api/backups-regionais/desfazer"
CAMPOS = {"serie", "cidade", "confirmado_em", "expira_em"}


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
        router = create_backups_regionais_router(BackupsRegionaisServices(
            state_file=lambda: self.state,
            transaction_root=lambda: self.root,
            equipamentos=lambda: self.equipamentos,
            endpoint=lambda: self.ler_endpoint(),
            estado_cobertura=lambda: {"disponibilidade": {}, "reservas": {}, "movimentacoes": {}, "devolucoes": {}},
            manutencao=lambda: Manutencao(),
            agora=lambda: self.agora,
        ))
        app = FastAPI()
        app.include_router(router)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

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

    def test_confirmar_candidata_grava_so_os_quatro_campos_e_repetir_mantem_o_prazo(self):
        resposta = self.post(CONFIRMAR)
        registro = resposta["confirmacao"]
        self.assertFalse(resposta["repetido"])
        self.assertEqual(set(registro), CAMPOS)
        self.assertEqual((registro["serie"], registro["cidade"]), ("NB1", "Cascavel"))
        self.assertEqual(registro["confirmado_em"], AGORA.isoformat(timespec="seconds"))
        self.assertEqual(registro["expira_em"], (AGORA + timedelta(days=7)).isoformat(timespec="seconds"))
        self.assertEqual(self.arquivo(), {"esquema": 1, "confirmacoes": [registro]})

        self.agora = AGORA + timedelta(days=1)
        segunda = self.post(CONFIRMAR)
        self.assertTrue(segunda["repetido"])
        self.assertEqual(segunda["confirmacao"]["expira_em"], registro["expira_em"])
        self.assertEqual(self.arquivo(), {"esquema": 1, "confirmacoes": [registro]})

    def test_endpoint_com_falha_nao_derruba_confirmar_e_o_log_so_tem_a_classe(self):
        def falha():
            raise OSError(r"C:\caminho\local\endpoint.xlsx")
        self.ler_endpoint = falha
        with self.assertLogs(level="WARNING") as logs:
            registro = self.post(CONFIRMAR)["confirmacao"]  # o painel mostra NB1 com fonte_endpoint_indisponivel
        self.assertEqual((registro["serie"], registro["cidade"]), ("NB1", "Cascavel"))
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
        esperado = (AGORA + timedelta(days=7)).isoformat(timespec="seconds")
        self.assertEqual(resposta["confirmacao"]["expira_em"], esperado)
        confirmacoes = self.arquivo()["confirmacoes"]
        self.assertEqual(len(confirmacoes), 1)
        self.assertEqual(confirmacoes[0]["expira_em"], esperado)

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


if __name__ == "__main__":
    unittest.main()
