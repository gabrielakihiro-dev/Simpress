"""Pacote local (Configuração local): exportar, prévia, restaurar e desfazer.

Só dados sintéticos numa pasta temporária: o ``data/``, o ``config/`` e o ``.transactions`` reais nunca são lidos nem
gravados. Os serviços do app (transação, carga da base, guardas) entram por injeção.
"""

import contextlib
import fnmatch
import hashlib
import io
import json
import logging
import os
import re
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient
from openpyxl import Workbook

import core.config
from core.config import BASE_DIR, MAX_UPLOAD_BYTES, STATE_DIR
from core.integrity import AtomicFileTransaction
from domains import inventory_inbox, pacote_local
from domains.pacote_local import ALLOWLIST, FORA, PacoteLocalServices
from routers.pacote_local import create_pacote_local_router

SEGREDO = "conteudo-sigiloso-omega"
LOCAL = ("127.0.0.1", 1234)
LEMBRETES = "data/state/lembretes.json"
OBSERVACOES = "data/state/os_observacoes.json"
CHAMADOS = "data/state/historico_chamados.json"
NOME = "pacote-local-20260101-000000.zip"


def cliente_rel() -> str:
    return core.config.CLIENT_CONFIG_FILE.relative_to(BASE_DIR).as_posix()


def planilha() -> bytes:
    livro = Workbook()
    livro.active.append(["Serie", "Modelo"])
    livro.active.append(["SINT001", "Modelo sintético"])
    saida = io.BytesIO()
    livro.save(saida)
    return saida.getvalue()


def montar_zip(arquivos: dict, manifesto=None, extras=(), versao="1.3.0", tipo="exportacao", ausentes=()) -> bytes:
    """Zip de teste; ``manifesto`` None monta um coerente, False omite, dict usa o dado."""
    if manifesto is None:
        manifesto = {
            "formato": 1, "tipo": tipo, "versao_app": versao, "criado_em": "2026-01-01T00:00:00-03:00",
            "arquivos": [
                {"caminho": nome, "tamanho_bytes": len(dados), "sha256": hashlib.sha256(dados).hexdigest()}
                for nome, dados in arquivos.items()
            ],
            "ausentes": list(ausentes),
        }
    saida = io.BytesIO()
    with zipfile.ZipFile(saida, "w", zipfile.ZIP_DEFLATED) as pacote:
        if manifesto is not False:
            pacote.writestr("manifesto.json", json.dumps(manifesto))
        for nome, dados in arquivos.items():
            pacote.writestr(nome, dados)
        for info, dados in extras:
            pacote.writestr(info, dados)
    return saida.getvalue()


class PacoteLocalBase(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name).resolve() / "app"
        self.base.mkdir()
        self.automacao = False
        self.admissao = threading.BoundedSemaphore(1)
        self.publicados = []
        self.carregar = mock.Mock(return_value={"equipamentos_cache": {}})
        self.services = PacoteLocalServices(
            base_dir=lambda: self.base,
            arquivo_config=lambda: self.base / "config" / "pacote_local.json",
            app_version="1.3.0",
            max_upload_bytes=MAX_UPLOAD_BYTES,
            inventory_state_transaction=lambda alvos: AtomicFileTransaction(self.base, alvos),
            load_database=self.carregar,
            publish_database_state=self.publicados.append,
            validate_uploaded_workbook=lambda dados, papel: {},
            automacao_em_andamento=lambda: self.automacao,
            upload_admission=lambda: self.admissao,
            travas_importacao=lambda: [inventory_inbox.try_worker_lock(self.base / "inbox" / ".importador.lock")],
            transacao_pendente=lambda: False,
        )
        app = FastAPI()
        app.include_router(create_pacote_local_router(self.services))
        self.client = TestClient(app, client=LOCAL)
        self.pasta = self.base / "data" / "pacotes_locais"

    def gravar(self, rel: str, dados) -> None:
        alvo = self.base / rel
        alvo.parent.mkdir(parents=True, exist_ok=True)
        alvo.write_bytes(dados if isinstance(dados, bytes) else json.dumps(dados).encode("utf-8"))

    def estado(self) -> dict:
        return {rel: (self.base / rel).read_bytes() for rel in ALLOWLIST if (self.base / rel).is_file()}

    def colocar(self, dados: bytes, nome: str = NOME) -> str:
        self.pasta.mkdir(parents=True, exist_ok=True)
        (self.pasta / nome).write_bytes(dados)
        return nome

    def previa(self, nome: str):
        return self.client.get(f"/api/pacote-local/{nome}/previa")

    def restaurar(self, nome: str, token: str, confirmado=True):
        return self.client.post(f"/api/pacote-local/{nome}/restaurar", json={"preview_token": token, "confirmado": confirmado})


class AllowlistTests(unittest.TestCase):
    def test_toda_constante_de_estado_ou_config_esta_na_allowlist_ou_fora(self):
        config_dir = BASE_DIR / "config"
        faltando = []
        for nome, valor in vars(core.config).items():
            if not nome.endswith(("_FILE", "_DIR")) or not isinstance(valor, Path):
                continue
            if not (valor.is_relative_to(STATE_DIR) or valor.is_relative_to(config_dir)) or valor == STATE_DIR:
                continue
            rel = valor.relative_to(BASE_DIR).as_posix()
            if rel not in ALLOWLIST and rel not in FORA:
                faltando.append(nome)
        self.assertEqual(faltando, [])

    def test_arquivos_persistentes_sem_constante_estao_na_allowlist_ou_fora(self):
        """Nomes literais em main.py (STATE_DIR / "x") e os conhecidos sem constante; nunca varre o data/ real."""
        literais = re.findall(r'STATE_DIR / "([^"]+)"', (BASE_DIR / "main.py").read_text(encoding="utf-8"))
        conhecidos = [
            "data/planilhas_entrada/_modelos/transferencia.xlsx", "data/state/usuarios_manuais/usuarios_pendencias.json",
            "data/state/dashboard_agendamento.json", "data/state/inventory_update_idempotency.json",
            "data/state/assinatura_tecnico.svg", "data/state/sebrae_historico.json", "data/state/sebrae_os_recusadas.json",
            "data/state/sebrae_excel_diario.json", "data/state/sebrae_categoria_indice.json",
        ]
        faltando = [
            rel for rel in [f"data/state/{nome}" for nome in literais] + conhecidos
            if rel not in ALLOWLIST and not any(fnmatch.fnmatchcase(rel, padrao) for padrao in FORA)
        ]
        self.assertGreater(len(literais), 5)
        self.assertEqual(faltando, [])
        self.assertIn("data/planilhas_entrada/_modelos/transferencia.xlsx", ALLOWLIST)
        self.assertIn("data/state/usuarios_manuais/usuarios_pendencias.json", ALLOWLIST)

    def test_allowlist_so_json_e_xlsx_e_sem_sobreposicao_com_fora(self):
        self.assertTrue(all(rel.endswith((".json", ".xlsx")) for rel in ALLOWLIST))
        self.assertEqual(len(set(ALLOWLIST)), len(ALLOWLIST))
        self.assertEqual(set(ALLOWLIST) & set(FORA), set())
        for sensivel in (".env", "data/state/config_backups", "data/state/sebrae_credenciais.json", "config/pacote_local.json"):
            self.assertIn(sensivel, FORA)
        self.assertIn(CHAMADOS, ALLOWLIST)


class ExportarTests(PacoteLocalBase):
    def test_exporta_so_a_allowlist(self):
        self.gravar(LEMBRETES, {"lembretes": [SEGREDO]})
        self.gravar(cliente_rel(), {"contrato": "123", "cnpj_faturamento": ""})
        self.gravar(".env", b"OPENROUTER_API_KEY=" + SEGREDO.encode())
        self.gravar("data/state/config_backups/contas_automacao.json.20260101-000000.bak", b"{}")
        self.gravar("data/state/sebrae_credenciais.json", {"x": SEGREDO})
        self.gravar("config/pacote_local.json", {"pasta": ""})
        resposta = self.client.post("/api/pacote-local/exportar")
        self.assertEqual(resposta.status_code, 200, resposta.text)
        corpo = resposta.json()
        self.assertRegex(corpo["arquivo"], pacote_local.NOME_PACOTE)
        self.assertEqual(corpo["arquivos"], 2)
        self.assertEqual(corpo["ausentes"], len(ALLOWLIST) - 2)
        with zipfile.ZipFile(self.pasta / corpo["arquivo"]) as pacote:
            nomes = set(pacote.namelist())
            manifesto = json.loads(pacote.read("manifesto.json"))
        self.assertEqual(nomes, {"manifesto.json", LEMBRETES, cliente_rel()})
        self.assertEqual(manifesto["tipo"], "exportacao")
        self.assertEqual(manifesto["versao_app"], "1.3.0")
        lista = self.client.get("/api/pacote-local").json()
        self.assertTrue(lista["pasta_padrao"])
        self.assertIsNone(lista["erro_pasta"])
        self.assertEqual([item["arquivo"] for item in lista["pacotes"]], [corpo["arquivo"]])
        self.assertEqual(lista["pacotes"][0]["tipo"], "exportacao")
        self.assertEqual([p.name for p in self.pasta.iterdir()], [corpo["arquivo"]])  # sem temporário

    def test_nunca_sobrescreve_pacote_com_o_mesmo_nome(self):
        self.gravar(LEMBRETES, {"a": 1})
        with mock.patch.object(pacote_local, "datetime", wraps=pacote_local.datetime) as relogio:
            relogio.now.return_value = pacote_local.datetime(2026, 1, 1, 0, 0, 0)
            self.assertEqual(self.client.post("/api/pacote-local/exportar").status_code, 200)
            antes = (self.pasta / NOME).read_bytes()
            self.gravar(LEMBRETES, {"a": 2})
            resposta = self.client.post("/api/pacote-local/exportar")
        self.assertEqual(resposta.status_code, 409)
        self.assertEqual((self.pasta / NOME).read_bytes(), antes)


class ValidacaoTests(PacoteLocalBase):
    def recusa(self, dados: bytes, motivo: str) -> None:
        resposta = self.previa(self.colocar(dados))
        self.assertEqual(resposta.status_code, 422, resposta.text)
        self.assertEqual(resposta.json()["detail"], f"Pacote recusado: {motivo}")

    def test_hash_errado(self):
        manifesto = json.loads(zipfile.ZipFile(io.BytesIO(montar_zip({LEMBRETES: b"{}"}))).read("manifesto.json"))
        manifesto["arquivos"][0]["sha256"] = "0" * 64
        self.recusa(montar_zip({LEMBRETES: b"{}"}, manifesto), "arquivo não confere com o manifesto")

    def test_caminho_com_pontos_ou_absoluto(self):
        self.recusa(montar_zip({}, extras=[("data/../config/x.json", b"{}")]), "caminho inválido no pacote")
        self.recusa(montar_zip({}, extras=[("/etc/x.json", b"{}")]), "caminho inválido no pacote")

    def test_arquivo_que_sobra_fora_do_manifesto(self):
        self.recusa(montar_zip({LEMBRETES: b"{}"}, extras=[(OBSERVACOES, b"{}")]), "arquivo não confere com o manifesto")

    def test_entrada_fora_da_allowlist_mesmo_no_manifesto(self):
        self.recusa(montar_zip({"data/state/sebrae_credenciais.json": b"{}"}), "arquivo fora da lista permitida")
        self.recusa(montar_zip({".env": b"X=1"}), "arquivo fora da lista permitida")

    def test_symlink_no_zip(self):
        info = zipfile.ZipInfo(LEMBRETES)
        info.external_attr = 0o120777 << 16
        self.recusa(montar_zip({}, extras=[(info, b"/etc/passwd")]), "caminho inválido no pacote")

    def test_sem_manifesto(self):
        self.recusa(montar_zip({LEMBRETES: b"{}"}, manifesto=False), "manifesto ausente ou inválido")
        self.recusa(b"nao e zip", "manifesto ausente ou inválido")

    def test_versao_mais_nova(self):
        self.recusa(montar_zip({LEMBRETES: b"{}"}, versao="1.4.0"), "pacote de uma versão mais nova do app")

    def test_limites_de_tamanho(self):
        servicos = self.services
        self.services = PacoteLocalServices(**{**servicos.__dict__, "max_upload_bytes": 10})
        app = FastAPI()
        app.include_router(create_pacote_local_router(self.services))
        self.client = TestClient(app, client=LOCAL)
        self.recusa(montar_zip({LEMBRETES: b'{"a": "' + b"x" * 20 + b'"}'}), "pacote grande demais (limite 10 bytes)")
        with mock.patch.object(pacote_local, "LIMITE_ZIP", 50):
            self.recusa(montar_zip({LEMBRETES: b"{}"}), "pacote grande demais (limite 50 bytes)")

    def test_conteudo_invalido(self):
        self.recusa(montar_zip({cliente_rel(): b'{"cnpj_faturamento": "11.111.111/1111-11"}'}),
                    f"conteúdo inválido em {cliente_rel()}")
        self.recusa(montar_zip({CHAMADOS: b'{"chamados": {}}'}), f"conteúdo inválido em {CHAMADOS}")
        self.recusa(montar_zip({"data/planilhas_entrada/EquipamentosDetalhes_atual.xlsx": b"PK nada"}),
                    "conteúdo inválido em data/planilhas_entrada/EquipamentosDetalhes_atual.xlsx")

    def test_404_para_nome_fora_do_padrao(self):
        self.colocar(montar_zip({LEMBRETES: b"{}"}), "outro.zip")
        self.assertEqual(self.previa("outro.zip").status_code, 404)
        self.assertEqual(self.previa("pacote-local-20990101-000000.zip").status_code, 404)


class RestaurarTests(PacoteLocalBase):
    def preparar(self):
        """Exporta {lembretes, cliente, planilha}; depois muda lembretes, apaga cliente e cria observações."""
        self.gravar(LEMBRETES, {"lembretes": ["original", SEGREDO]})
        self.gravar(cliente_rel(), {"contrato": "123", "cnpj_faturamento": ""})
        self.gravar("data/planilhas_entrada/EquipamentosDetalhes_atual.xlsx", planilha())
        exportado = self.client.post("/api/pacote-local/exportar").json()["arquivo"]
        self.original = self.estado()
        self.gravar(LEMBRETES, {"lembretes": ["alterado"]})
        (self.base / cliente_rel()).unlink()
        self.gravar(OBSERVACOES, {"observacoes": {}})
        self.alterado = self.estado()
        return exportado

    def test_sem_confirmado_nao_faz_nada(self):
        nome = self.preparar()
        token = self.previa(nome).json()["preview_token"]
        for corpo in ({"preview_token": token}, {"preview_token": token, "confirmado": False}):
            self.assertEqual(self.client.post(f"/api/pacote-local/{nome}/restaurar", json=corpo).status_code, 422)
        self.assertEqual(self.client.post(f"/api/pacote-local/{nome}/restaurar",
                                          json={"preview_token": token, "confirmado": "true"}).status_code, 422)
        self.assertEqual(self.estado(), self.alterado)
        self.assertEqual(len(list(self.pasta.iterdir())), 1)

    def test_token_velho(self):
        nome = self.preparar()
        token = self.previa(nome).json()["preview_token"]
        self.gravar(LEMBRETES, {"lembretes": ["mudou depois da previa"]})
        resposta = self.restaurar(nome, token)
        self.assertEqual(resposta.status_code, 409)
        self.assertEqual(resposta.json()["detail"], "Restauração recusada: o estado mudou desde a prévia; abra a prévia de novo")

    def test_guardas(self):
        nome = self.preparar()
        token = self.previa(nome).json()["preview_token"]
        self.automacao = True
        self.assertEqual(self.restaurar(nome, token).json()["detail"], "Restauração recusada: uma automação está em execução")
        self.automacao = False
        self.admissao.acquire()
        resposta = self.restaurar(nome, token)
        self.admissao.release()
        self.assertEqual((resposta.status_code, resposta.json()["detail"]),
                         (409, "Restauração recusada: uma importação está em andamento"))
        with inventory_inbox.try_worker_lock(self.base / "inbox" / ".importador.lock") as livre:
            self.assertTrue(livre)
            resposta = self.restaurar(nome, token)
        self.assertEqual((resposta.status_code, resposta.json()["detail"]),
                         (409, "Restauração recusada: uma importação está em andamento"))
        self.assertEqual(self.estado(), self.alterado)
        self.assertTrue(self.admissao.acquire(blocking=False))  # a guarda foi liberada
        self.admissao.release()

    def test_ida_e_volta_com_desfazer(self):
        nome = self.preparar()
        previa = self.previa(nome).json()
        acoes = {item["caminho"]: item["acao"] for item in previa["itens"]}
        self.assertEqual(acoes[LEMBRETES], "substituir")
        self.assertEqual(acoes[cliente_rel()], "criar")
        self.assertEqual(acoes["data/planilhas_entrada/EquipamentosDetalhes_atual.xlsx"], "igual")
        self.assertEqual(acoes[OBSERVACOES], "manter")
        self.assertTrue(previa["muda_links"])
        self.assertEqual(previa["totais"], {"substituir": 1, "criar": 1, "igual": 1, "manter": 1, "apagar": 0})

        with self.assertLogs("domains.pacote_local", level=logging.INFO) as logs:
            resposta = self.restaurar(nome, previa["preview_token"])
        self.assertEqual(resposta.status_code, 200, resposta.text)
        corpo = resposta.json()
        self.assertEqual({k: corpo[k] for k in ("substituidos", "criados", "apagados", "mantidos")},
                         {"substituidos": 1, "criados": 1, "apagados": 0, "mantidos": 1})
        self.assertEqual(self.estado(), {**self.original, OBSERVACOES: self.alterado[OBSERVACOES]})  # mantido
        self.assertEqual(len(self.publicados), 1)
        self.assertNotIn(SEGREDO, "\n".join(logs.output))
        self.assertNotIn(str(self.base), "\n".join(logs.output))

        desfazer = corpo["pacote_desfazer"]
        previa_desfazer = self.previa(desfazer).json()
        self.assertEqual(previa_desfazer["tipo"], "desfazer")
        self.assertIn({"caminho": cliente_rel(), "acao": "apagar"}, previa_desfazer["itens"])
        resposta = self.restaurar(desfazer, previa_desfazer["preview_token"])
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual(resposta.json()["apagados"], 1)
        self.assertEqual(self.estado(), self.alterado)  # volta exato, inclusive apagar o que não existia

    def test_ja_corresponde(self):
        self.gravar(LEMBRETES, {"a": 1})
        nome = self.client.post("/api/pacote-local/exportar").json()["arquivo"]
        resposta = self.restaurar(nome, self.previa(nome).json()["preview_token"])
        self.assertEqual((resposta.status_code, resposta.json()["detail"]), (409, "Este pacote já corresponde ao estado atual."))

    def test_desfazer_criado_antes_de_gravar_e_falha_aborta(self):
        nome = self.preparar()
        token = self.previa(nome).json()["preview_token"]
        gravar_original = pacote_local._gravar_pacote
        vistos = []

        def espiar(services, pasta, tipo):
            vistos.append((tipo, (self.base / LEMBRETES).read_bytes()))
            return gravar_original(services, pasta, tipo)

        with mock.patch.object(pacote_local, "_gravar_pacote", side_effect=espiar):
            self.assertEqual(self.restaurar(nome, token).status_code, 200)
        self.assertEqual(vistos, [("desfazer", self.alterado[LEMBRETES])])

        self.setUp()
        nome = self.preparar()
        token = self.previa(nome).json()["preview_token"]
        falha = pacote_local.DomainError("disco cheio", status_code=422)
        with mock.patch.object(pacote_local, "_gravar_pacote", side_effect=falha):
            resposta = self.restaurar(nome, token)
        self.assertEqual(resposta.status_code, 422)
        self.assertEqual(self.estado(), self.alterado)

    def test_estado_atual_invalido_barra_o_desfazer_sem_gravar(self):
        nome = self.preparar()
        self.gravar(cliente_rel(), {"contrato": "123", "cnpj_faturamento": "11.111.111/1111-11"})
        self.alterado = self.estado()
        resposta = self.restaurar(nome, self.previa(nome).json()["preview_token"])
        self.assertEqual(resposta.status_code, 409)
        self.assertTrue(resposta.json()["detail"].startswith(
            "Restauração recusada: o pacote de desfazer do estado atual não passou na conferência"))
        self.assertEqual([p.name for p in self.pasta.iterdir()], [nome])
        self.assertEqual(self.estado(), self.alterado)

    def test_falha_depois_de_gravar_volta_os_arquivos(self):
        nome = self.preparar()
        token = self.previa(nome).json()["preview_token"]
        self.carregar.side_effect = RuntimeError(SEGREDO)
        resposta = self.restaurar(nome, token)
        self.assertEqual((resposta.status_code, resposta.json()["detail"]), (500, pacote_local.MSG_FALHA))
        self.assertEqual(self.estado(), self.alterado)
        self.assertEqual(self.publicados, [])


class PastaTests(PacoteLocalBase):
    def salvar(self, texto: str):
        return self.client.put("/api/pacote-local/pasta", json={"pasta": texto})

    def test_pastas_recusadas(self):
        (self.base / "static").mkdir()
        sincronizada = self.base / "OneDrive - Empresa" / "pacotes"
        sincronizada.mkdir(parents=True)
        outra = self.base / "Dropbox" / "x"
        outra.mkdir(parents=True)
        real = self.base / "real"
        real.mkdir()
        (self.base / "atalho").symlink_to(real, target_is_directory=True)
        rede = "Use uma pasta deste computador (sem OneDrive, rede ou unidade removível)."
        casos = {
            "\\\\servidor\\pasta": rede,
            "//servidor/pasta": rede,
            str(sincronizada): rede,
            str(outra): rede,
            str(self.base / "nao-existe"): "A pasta não existe ou não aceita escrita.",
            "relativa/pasta": "A pasta não existe ou não aceita escrita.",
            str(self.base / "static"): "Pasta não permitida.",
            str(self.base / "atalho"): "Pasta não permitida.",
        }
        for texto, mensagem in casos.items():
            with self.subTest(texto=texto):
                resposta = self.salvar(texto)
                self.assertEqual((resposta.status_code, resposta.json()["detail"]), (422, mensagem))
        with mock.patch.dict(os.environ, {"OneDrive": str(real)}):
            self.assertEqual(self.salvar(str(real)).json()["detail"], rede)
        self.assertFalse((self.base / "config" / "pacote_local.json").exists())

    def test_salva_pasta_valida_e_volta_ao_padrao(self):
        escolhida = self.base / "pacotes"
        escolhida.mkdir()
        resposta = self.salvar(str(escolhida))
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual((resposta.json()["pasta"], resposta.json()["pasta_padrao"]), (str(escolhida), False))
        self.gravar(LEMBRETES, {"a": 1})
        arquivo = self.client.post("/api/pacote-local/exportar").json()["arquivo"]
        self.assertTrue((escolhida / arquivo).is_file())
        self.assertTrue(self.salvar("").json()["pasta_padrao"])

    def test_pasta_configurada_que_sumiu(self):
        self.gravar("config/pacote_local.json", {"pasta": str(self.base / "sumiu")})
        lista = self.client.get("/api/pacote-local").json()
        self.assertEqual((lista["pacotes"], lista["erro_pasta"]), ([], "A pasta não existe ou não aceita escrita."))


class AssistenteTests(unittest.TestCase):
    def test_prompt_diz_que_o_assistente_nao_mexe_no_pacote(self):
        from domains.assistant_chat import SYSTEM_PROMPT

        self.assertIn("Pacote local (fim da Configuração local)", SYSTEM_PROMPT)
        self.assertIn("Você não exporta, não lista e não restaura pacotes.", SYSTEM_PROMPT)


class AcessoTests(PacoteLocalBase):
    def test_so_neste_computador_mesmo_com_rede_ligada(self):
        rede = TestClient(self.client.app, client=("192.168.0.20", 1234))
        with mock.patch.dict(os.environ, {"SIMPRESS_ACESSO_REDE": "1", "SIMPRESS_ACESSO_TAILSCALE": "1"}):
            self.assertEqual(rede.get("/api/pacote-local").status_code, 200)
            chamadas = (
                rede.put("/api/pacote-local/pasta", json={"pasta": ""}),
                rede.post("/api/pacote-local/exportar"),
                rede.post(f"/api/pacote-local/{NOME}/restaurar", json={"preview_token": "0" * 64, "confirmado": True}),
                TestClient(self.client.app, client=("100.100.1.1", 1234)).post("/api/pacote-local/exportar"),
            )
        for resposta in chamadas:
            self.assertEqual((resposta.status_code, resposta.json()["detail"]), (403, "Disponível só neste computador."))
        self.assertFalse(self.pasta.exists() and any(self.pasta.iterdir()))

    def test_rota_sem_cookie_401(self):
        import main

        client = TestClient(main.app, base_url=f"http://127.0.0.1:{main.SERVER_PORT}", client=LOCAL)
        for metodo, caminho in (("get", "/api/pacote-local"), ("post", "/api/pacote-local/exportar"),
                                ("get", f"/api/pacote-local/{NOME}/previa")):
            self.assertEqual(getattr(client, metodo)(caminho).status_code, 401)


if __name__ == "__main__":
    unittest.main()
