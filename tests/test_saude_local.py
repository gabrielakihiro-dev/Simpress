"""Saúde local: GET, prévia, limpeza, diagnóstico and the read-only assistant tool, on synthetic data only."""

import json
import logging
import os
import re
import tempfile
import time
import unittest
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient
from pydantic import ValidationError

import main
from domains import saude_local
from domains.assistant_api import SimpressApi
from domains.assistant_tools import NUCLEO_FERRAMENTAS, TOOLS
from routers.saude_local import Diagnostico, SaudeLocalRouteServices, create_saude_local_router
from security import sessao_local

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CPF = "123.456.789-09"
EMAIL = "fulano@exemplo.com"
PESSOA = "Fulano da Silva"
WINDOWS_PATH = r"C:\Users\fulano.tal\a.xlsx"


def _envelhecer(path: Path, horas: float) -> None:
    momento = time.time() - horas * 3600
    os.utime(path, (momento, momento))


def _escrever(path: Path, conteudo: bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(conteudo)
    return path


def _snapshot(raiz: Path) -> Dict[str, Tuple[int, bytes]]:
    """mtime + content of every file and folder under ``raiz`` (folders by mtime; no link followed)."""
    resultado: Dict[str, Tuple[int, bytes]] = {}
    for atual, pastas, arquivos in os.walk(raiz, followlinks=False):
        for nome in pastas:
            pasta = Path(atual) / nome
            resultado[pasta.relative_to(raiz).as_posix() + "/"] = (pasta.lstat().st_mtime_ns, b"")
        for nome in arquivos:
            caminho = Path(atual) / nome
            conteudo = b"<link>" if caminho.is_symlink() else caminho.read_bytes()
            resultado[caminho.relative_to(raiz).as_posix()] = (caminho.lstat().st_mtime_ns, conteudo)
    return resultado


def _textos(valor: Any) -> Iterator[str]:
    """Every key and string inside a decoded JSON value (catches escaped backslashes the raw text would hide)."""
    if isinstance(valor, dict):
        for chave, item in valor.items():
            yield str(chave)
            yield from _textos(item)
    elif isinstance(valor, list):
        for item in valor:
            yield from _textos(item)
    elif isinstance(valor, str):
        yield valor


class _CapturaLogs(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.DEBUG)
        self.textos: List[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        texto = record.getMessage()
        if record.exc_info:
            texto += logging.Formatter().formatException(record.exc_info)
        self.textos.append(texto)


class SaudeLocalBase(unittest.TestCase):
    def setUp(self) -> None:
        contexto = tempfile.TemporaryDirectory(prefix=f"{PESSOA}-")
        self.addCleanup(contexto.cleanup)
        self.root = Path(contexto.name).resolve()
        self.chrome_ocupado = False
        self.prontidao: Dict[str, Any] = {"files": {}, "functions": {}}
        state = self.root / "data" / "state"
        self.entradas = (state / "entrada_automatica", state / "entrada_chamados", state / "entrada_usuarios_entra")
        self._montar_base()
        self.client = self._cliente()

    def _montar_base(self) -> None:
        r = self.root
        state = r / "data" / "state"
        pessoal = json.dumps({"nome": PESSOA, "cpf": CPF, "email": EMAIL}).encode()
        self.protegidos = [
            _escrever(state / "historico_chamados.json", pessoal),
            _escrever(state / "lembretes.json", b'{"' + PESSOA.encode() + b'": '),
            _escrever(state / "usuarios_entra_pr.json", b"   \n"),
            _escrever(state / f"{CPF}.json", pessoal),
            _escrever(state / "sebrae_novos.corrompido-20261126-101010.json", pessoal),
            _escrever(r / "data" / "planilhas_entrada" / "EquipamentosDetalhes_atual.xlsx", b"planilha ativa"),
            _escrever(r / "data" / "planilhas_entrada" / "_backups" / "20261120" / "EquipamentosDetalhes_atual.xlsx", b"backup"),
            _escrever(r / "data" / "logs" / "app.log", f"login {PESSOA} cpf {CPF} {EMAIL}".encode()),
            _escrever(r / "data" / "pacotes_locais" / "pacote-1.zip", b"pacote"),
            _escrever(self.entradas[0] / "processadas" / "lote-1" / "inventario.xlsx", b"lote"),
            _escrever(self.entradas[1] / "falhas" / "lote-2" / "os.xlsx", b"falha"),
        ]
        historico = state / "historico_comparacoes"
        self.alvo = _escrever(historico / "historico_comparacoes.json", b"historico atual")
        self.tmp_igual = _escrever(historico / ".historico_comparacoes.json.a1b2c3d4.tmp", b"historico atual")
        _envelhecer(self.tmp_igual, 30)
        self.tmp_antigo = _escrever(historico / ".historico_comparacoes.json.e5f6g7h8.tmp", b"versao antiga")
        _envelhecer(self.tmp_antigo, 8 * 24)
        anexos = state / "sebrae_anexos" / "1"
        _escrever(anexos / "Termo_Fulano.pdf", b"%PDF termo")
        self.tmp_anexo = _escrever(anexos / ".Termo_Fulano.pdf.abcd1234.tmp", b"%PDF termo")
        _envelhecer(self.tmp_anexo, 30)

    def _app(self) -> FastAPI:
        app = FastAPI()
        app.include_router(create_saude_local_router(SaudeLocalRouteServices(
            base_dir=lambda: self.root,
            entradas=lambda: self.entradas,
            chrome_ocupado=lambda: self.chrome_ocupado,
            prontidao=lambda: self.prontidao,
            versao_app=lambda: "1.3.0",
        )))
        app.add_exception_handler(RequestValidationError, main.validation_error_handler)  # type: ignore[arg-type]
        app.add_middleware(main.LocalRequestSafetyMiddleware)
        return app

    def _cliente(self, *, com_cookie: bool = True) -> TestClient:
        headers = sessao_local.cabecalhos_sessao(main.SERVER_PORT) if com_cookie else None
        client = TestClient(self._app(), base_url=f"http://127.0.0.1:{main.SERVER_PORT}",
                            client=("127.0.0.1", 1234), headers=headers)
        self.addCleanup(client.close)
        return client


    def _sem_dado_pessoal(self, texto: str, *, extra: Tuple[str, ...] = ()) -> None:
        proibidos = ("Fulano", "fulano", CPF, "12345678909", EMAIL, str(self.root), "Users", "Termo_") + extra
        try:
            textos = list(_textos(json.loads(texto)))
        except ValueError:
            textos = []
        for valor in [texto, *textos]:
            for proibido in proibidos:
                self.assertNotIn(proibido, valor)


class LimpezaTests(SaudeLocalBase):
    def test_previa_nao_altera_e_limpeza_nunca_toca_arquivos_protegidos(self) -> None:
        antes = _snapshot(self.root)
        protegidos = {p.relative_to(self.root).as_posix(): antes[p.relative_to(self.root).as_posix()] for p in self.protegidos}

        previa = self.client.post("/api/saude-local/limpeza/previa")
        self.assertEqual(previa.status_code, 200, previa.text)
        corpo = previa.json()
        self.assertFalse(corpo["aplicada"])
        self.assertEqual(
            sorted((i["acao"], i["area"], i["caminho"]) for i in corpo["itens"]),
            [("quarentena", "state", "historico_comparacoes/.historico_comparacoes.json.e5f6g7h8.tmp"),
             ("remover", "state", "historico_comparacoes/.historico_comparacoes.json.a1b2c3d4.tmp"),
             ("remover", "state", "sebrae_anexos/1/.Termo_Fulano.pdf.abcd1234.tmp")],
        )
        self.assertEqual(corpo["totais"]["remover_arquivos"], 2)
        self.assertEqual(corpo["totais"]["quarentena_bytes"], len(b"versao antiga"))
        self.assertEqual(_snapshot(self.root), antes)

        limpeza = self.client.post("/api/saude-local/limpeza", json={"confirmado": True})
        self.assertEqual(limpeza.status_code, 200, limpeza.text)
        self.assertTrue(limpeza.json()["aplicada"])
        self.assertEqual(limpeza.json()["totais"]["remover_arquivos"], 2)
        self.assertEqual(limpeza.json()["totais"]["quarentena_arquivos"], 1)
        self.assertFalse(self.tmp_igual.exists())
        self.assertFalse(self.tmp_anexo.exists())
        self.assertFalse(self.tmp_antigo.exists())
        self.assertEqual(len(list((self.alvo.parent / ".temp-quarantine").glob(f"*/{self.tmp_antigo.name}"))), 1)
        depois = _snapshot(self.root)
        for relativo, valor in protegidos.items():
            self.assertEqual(depois.get(relativo), valor, relativo)
        self.assertEqual(self.alvo.read_bytes(), b"historico atual")

    def test_item_com_cpf_no_nome_sai_mascarado(self) -> None:
        pasta = self.root / "data" / "state" / f"anexo {CPF}"
        _escrever(pasta / "doc.json", b"x")
        tmp = _escrever(pasta / ".doc.json.zzzz1111.tmp", b"x")
        _envelhecer(tmp, 30)
        corpo = self.client.post("/api/saude-local/limpeza/previa").json()
        caminhos = [i["caminho"] for i in corpo["itens"]]
        self.assertIn("anexo ***.***.***-**/.doc.json.zzzz1111.tmp", caminhos)
        self.assertNotIn(CPF, json.dumps(corpo))

    def test_limpeza_sem_confirmado_responde_422_e_nada_muda(self) -> None:
        antes = _snapshot(self.root)
        for kwargs in ({}, {"json": {}}, {"json": {"confirmado": False}}, {"json": {"confirmado": "true"}},
                       {"json": {"confirmado": 1}}, {"json": {"confirmado": True, "extra": 1}}):
            with self.subTest(kwargs=kwargs):
                resposta = self.client.post("/api/saude-local/limpeza", **kwargs)
                self.assertEqual(resposta.status_code, 422, resposta.text)
                self._sem_dado_pessoal(resposta.text)
        self.assertEqual(_snapshot(self.root), antes)

    def _recusas(self) -> List[Tuple[str, Callable[[], Any]]]:
        def chrome() -> None:
            self.chrome_ocupado = True

        def importacao() -> None:
            _escrever(self.entradas[2] / "processando" / "usuarios.csv", b"x")

        def transacoes() -> None:
            _escrever(self.root / ".transactions" / "tx-1" / "manifest.json", b"{}")

        def migracao() -> None:
            (self.root / "data" / "planilhas_entrada" / ".upload-staging-1").mkdir()

        return [("chrome", chrome), ("importacao", importacao), ("transacoes", transacoes), ("migracao", migracao)]

    def test_recusas_409_com_codigo_e_mensagem_exatos_sem_mexer_em_nada(self) -> None:
        for codigo, preparar in self._recusas():
            for rota, corpo in (("/api/saude-local/limpeza/previa", None), ("/api/saude-local/limpeza", {"confirmado": True})):
                with self.subTest(codigo=codigo, rota=rota):
                    self.setUp()
                    preparar()
                    antes = _snapshot(self.root)
                    with patch("core.integrity.recover_pending_transactions") as recuperar:
                        resposta = self.client.post(rota, json=corpo)
                    recuperar.assert_not_called()
                    self.assertEqual(resposta.status_code, 409, resposta.text)
                    self.assertEqual(resposta.json(), {"detail": {"codigo": codigo, "mensagem": saude_local.MENSAGENS_RECUSA[codigo]}})
                    self._sem_dado_pessoal(resposta.text)
                    self.assertEqual(_snapshot(self.root), antes)
                    self.assertTrue(self.tmp_igual.exists())

    def test_outra_limpeza_em_andamento_recusa_previa_e_limpeza(self) -> None:
        antes = _snapshot(self.root)
        self.assertTrue(saude_local.LOCK_LIMPEZA.acquire(blocking=False))
        try:
            for rota, corpo in (("/api/saude-local/limpeza/previa", None), ("/api/saude-local/limpeza", {"confirmado": True})):
                resposta = self.client.post(rota, json=corpo)
                self.assertEqual(resposta.status_code, 409)
                self.assertEqual(resposta.json()["detail"], {
                    "codigo": "limpeza_em_andamento",
                    "mensagem": "Limpeza recusada: outra limpeza já está em andamento."})
        finally:
            saude_local.LOCK_LIMPEZA.release()
        self.assertEqual(_snapshot(self.root), antes)
        self.assertEqual(self.client.post("/api/saude-local/limpeza/previa").status_code, 200)

    def test_processando_vazio_nao_recusa(self) -> None:
        (self.entradas[0] / "processando").mkdir(parents=True)
        self.assertEqual(self.client.post("/api/saude-local/limpeza/previa").status_code, 200)

    def test_gets_e_previa_nunca_recuperam_transacao(self) -> None:
        manifesto = _escrever(self.root / ".transactions" / "tx-1" / "manifest.json", b'{"sintetico": true}')
        antes = _snapshot(self.root / ".transactions")
        with patch("core.integrity.recover_pending_transactions", side_effect=AssertionError("recuperou")) as recuperar:
            saude = self.client.get("/api/saude-local")
            diagnostico = self.client.get("/api/saude-local/diagnostico")
            previa = self.client.post("/api/saude-local/limpeza/previa")
        recuperar.assert_not_called()
        self.assertEqual(saude.json()["transacoes"], {"situacao": "pendente", "quantidade": 1})
        self.assertEqual(diagnostico.json()["transacoes"], {"situacao": "pendente", "quantidade": 1})
        self.assertEqual(previa.status_code, 409)
        self.assertEqual(previa.json()["detail"]["codigo"], "transacoes")
        self.assertEqual(_snapshot(self.root / ".transactions"), antes)
        self.assertTrue(manifesto.is_file())

    def test_gets_e_previa_nao_gravam_nada(self) -> None:
        _escrever(self.root / ".transactions" / "tx-1" / "manifest.json", b"{}")
        antes = _snapshot(self.root)
        self.assertEqual(self.client.get("/api/saude-local").status_code, 200)
        self.assertEqual(_snapshot(self.root), antes)
        self.assertEqual(self.client.get("/api/saude-local/diagnostico").status_code, 200)
        self.assertEqual(_snapshot(self.root), antes)
        (self.root / ".transactions" / "tx-1" / "manifest.json").unlink()
        (self.root / ".transactions" / "tx-1").rmdir()
        (self.root / ".transactions").rmdir()
        antes = _snapshot(self.root)
        previa = self.client.post("/api/saude-local/limpeza/previa")
        self.assertEqual(previa.status_code, 200)
        self.assertEqual(len(previa.json()["itens"]), 3)
        self.assertEqual(_snapshot(self.root), antes)  # no .lock, no folder, no mtime change

    def test_transacoes_ilegivel_nao_derruba_o_get_e_nao_diz_limpo(self) -> None:
        (self.root / ".transactions").mkdir()
        original = Path.iterdir

        def iterdir(caminho: Path) -> Any:
            if caminho.name == ".transactions":
                raise PermissionError(13, "negado", str(caminho))
            return original(caminho)

        with patch.object(Path, "iterdir", iterdir):
            saude = self.client.get("/api/saude-local")
            diagnostico = self.client.get("/api/saude-local/diagnostico")
            limpeza = self.client.post("/api/saude-local/limpeza", json={"confirmado": True})
        self.assertEqual(saude.status_code, 200, saude.text)
        self.assertEqual(saude.json()["transacoes"], {"situacao": "pendente", "quantidade": 0})
        self.assertEqual(diagnostico.json()["transacoes"], {"situacao": "pendente", "quantidade": 0})
        self.assertEqual(limpeza.status_code, 503)
        self.assertTrue(self.tmp_igual.exists())

    def _capturar(self, acao: Callable[[], Any]) -> Tuple[Any, List[str]]:
        captura = _CapturaLogs()
        raiz_log = logging.getLogger()
        nivel = raiz_log.level
        raiz_log.addHandler(captura)
        raiz_log.setLevel(logging.DEBUG)
        try:
            return acao(), captura.textos
        finally:
            raiz_log.removeHandler(captura)
            raiz_log.setLevel(nivel)

    def test_falha_ao_mover_para_quarentena_e_preservada_sem_nome_no_log(self) -> None:
        from core.integrity import FileTransactionError

        erro = FileTransactionError("Falha ao substituir '.Termo_Fulano.pdf.abcd1234.tmp': 12345678909.")
        with patch("core.integrity._replace_with_retries", side_effect=erro):
            resposta, logs = self._capturar(
                lambda: self.client.post("/api/saude-local/limpeza", json={"confirmado": True}))
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual(resposta.json()["totais"]["quarentena_arquivos"], 0)
        self.assertGreaterEqual(resposta.json()["totais"]["preservados"], 1)
        self.assertEqual(self.tmp_antigo.read_bytes(), b"versao antiga")
        for texto in logs:
            for proibido in ("Fulano", "fulano", "Termo_", "12345678909"):
                self.assertNotIn(proibido, texto)

    def test_erro_inesperado_vira_503_sem_nome_no_log(self) -> None:
        with patch.object(saude_local, "cleanup_local_temps", side_effect=RuntimeError(f"Termo_Fulano {CPF}")):
            resposta, logs = self._capturar(
                lambda: self.client.post("/api/saude-local/limpeza", json={"confirmado": True}))
        self.assertEqual(resposta.status_code, 503)
        self.assertEqual(resposta.json(), {"detail": "Não foi possível concluir a limpeza com segurança."})
        self.assertTrue(any("RuntimeError" in texto for texto in logs))
        for texto in logs:
            for proibido in ("Fulano", "fulano", "Termo_", CPF, "12345678909"):
                self.assertNotIn(proibido, texto)

    def test_pasta_de_quarentena_link_recusa_e_preserva_o_temporario(self) -> None:
        contexto = tempfile.TemporaryDirectory(prefix="saude-quarentena-fora-")
        self.addCleanup(contexto.cleanup)
        fora = Path(contexto.name)
        try:
            os.symlink(fora, self.alvo.parent / ".temp-quarantine", target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("Sem permissão para criar link simbólico.")
        resposta = self.client.post("/api/saude-local/limpeza", json={"confirmado": True})
        self.assertEqual(resposta.status_code, 503)
        self.assertEqual(resposta.json(), {"detail": "Não foi possível concluir a limpeza com segurança."})
        self.assertEqual(self.tmp_antigo.read_bytes(), b"versao antiga")
        self.assertEqual(list(fora.iterdir()), [])

class DiagnosticoTests(SaudeLocalBase):
    def test_saude_e_diagnostico_sem_dado_pessoal(self) -> None:
        self.prontidao = {
            "backend": "files",
            "files": {
                "inventario_equipamentos": {"available": False, "file": WINDOWS_PATH, "reason": WINDOWS_PATH, "state": "invalid"},
                "historico_chamados": {"available": True, "file": "historico_chamados.json", "reason": "OK", "state": "ready"},
                "estranho": {"available": False, "file": WINDOWS_PATH, "reason": "x", "state": f"desconhecido {PESSOA}"},
                f"chave {PESSOA}": {"available": True, "state": "ready"},
            },
            "functions": {
                "geracao_transferencia": {"available": False, "missing_files": [WINDOWS_PATH], "state": "invalid"},
            },
            "gravacao_bloqueada": {"available": False, "state": "invalid", "reason": WINDOWS_PATH},
            "configuracao_local": {"state": "pending", "faltando": ["conta_simpress"], "reason": WINDOWS_PATH},
        }
        captura = _CapturaLogs()
        raiz_log = logging.getLogger()
        nivel = raiz_log.level
        raiz_log.addHandler(captura)
        raiz_log.setLevel(logging.DEBUG)
        try:
            saude = self.client.get("/api/saude-local")
            diagnostico = self.client.get("/api/saude-local/diagnostico")
            previa = self.client.post("/api/saude-local/limpeza/previa")
            limpeza = self.client.post("/api/saude-local/limpeza", json={"confirmado": True})
            sem_confirmado = self.client.post("/api/saude-local/limpeza", json={})
            self.chrome_ocupado = True
            recusa = self.client.post("/api/saude-local/limpeza", json={"confirmado": True})
        finally:
            raiz_log.removeHandler(captura)
            raiz_log.setLevel(nivel)
        for resposta in (saude, diagnostico, previa, limpeza):
            self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual((sem_confirmado.status_code, recusa.status_code), (422, 409))
        for resposta in (saude, diagnostico, sem_confirmado, recusa):
            self._sem_dado_pessoal(resposta.text, extra=("a.xlsx", "C:"))
        for texto in captura.textos:
            for proibido in ("Fulano", "fulano", CPF, "12345678909", EMAIL, str(self.root), "Termo_"):
                self.assertNotIn(proibido, texto)

        corpo = diagnostico.json()
        self.assertEqual(corpo["formato"], 1)
        self.assertEqual(set(corpo), {"formato", "gerado_em", "app", "prontidao", "areas", "disco", "estado_json", "transacoes"})
        self.assertEqual(corpo["app"]["versao"], "1.3.0")
        self.assertEqual(corpo["prontidao"], {
            "arquivos": {"inventario_equipamentos": "invalid", "historico_chamados": "ready", "estranho": "invalid"},
            "funcoes": {"geracao_transferencia": {"available": False, "state": "invalid"}},
        })
        por_nome = {a["nome"]: a for a in saude.json()["estado_json"]["arquivos"]}
        self.assertEqual(por_nome["historico_chamados.json"]["situacao"], "integro")
        self.assertEqual((por_nome["lembretes.json"]["situacao"], por_nome["lembretes.json"]["erro"]), ("invalido", "JSONDecodeError"))
        self.assertEqual(por_nome["usuarios_entra_pr.json"]["situacao"], "vazio")
        self.assertEqual(saude.json()["estado_json"]["outros"], 1)
        self.assertEqual(saude.json()["estado_json"]["copias_corrompidas"], 1)
        self.assertEqual([a["chave"] for a in saude.json()["areas"]],
                         ["backups_planilhas", "logs", "lotes_processados", "pacotes_locais", "quarentena"])
        self.assertEqual(corpo["areas"][2]["arquivos"], 2)  # processadas + falhas
        self.assertEqual(corpo["areas"][4]["arquivos"], 1)  # the corrupted copy

    def test_json_corrompido_em_subpasta_aparece_como_invalido(self) -> None:
        state = self.root / "data" / "state"
        _escrever(state / "usuarios_manuais" / "usuarios_pendencias.json", f'{{"{PESSOA}": '.encode())
        _escrever(state / "apelidos_modificados" / "apelidos_modificados.json", b"{}")
        _escrever(state / "usuarios_manuais" / f"{CPF}.json", b"{")  # not in the list: never opened nor named
        resposta = self.client.get("/api/saude-local")
        por_nome = {a["nome"]: a for a in resposta.json()["estado_json"]["arquivos"]}
        self.assertEqual(por_nome["usuarios_manuais/usuarios_pendencias.json"]["situacao"], "invalido")
        self.assertEqual(por_nome["usuarios_manuais/usuarios_pendencias.json"]["erro"], "JSONDecodeError")
        self.assertEqual(por_nome["apelidos_modificados/apelidos_modificados.json"]["situacao"], "integro")
        self.assertEqual(por_nome["historico_comparacoes/historico_comparacoes.json"]["situacao"], "invalido")
        self.assertNotIn("usuarios_manuais/usuarios_manuais.json", por_nome)
        self.assertEqual(resposta.json()["estado_json"]["outros"], 1)  # only the top level is counted
        self._sem_dado_pessoal(resposta.text)
        Diagnostico.model_validate(self.client.get("/api/saude-local/diagnostico").json())

    def test_json_grande_demais_nao_e_aberto(self) -> None:
        grande = self.root / "data" / "state" / "lembretes.json"
        with patch.object(saude_local, "MAX_JSON_BYTES", 3), patch.object(Path, "read_bytes", side_effect=AssertionError("abriu")):
            estado = saude_local.estado_json(self.root)
        situacoes = {a["nome"]: a["situacao"] for a in estado["arquivos"]}
        self.assertEqual(situacoes["lembretes.json"], "grande_demais")
        self.assertTrue(grande.is_file())

    def test_schema_do_diagnostico_recusa_campo_extra(self) -> None:
        corpo = self.client.get("/api/saude-local/diagnostico").json()
        Diagnostico.model_validate(corpo)
        for caminho, extra in ((("",), "reason"), (("app",), "hostname"), (("prontidao",), "configuracao_local"),
                               (("transacoes",), "itens"), (("estado_json",), "caminho")):
            with self.subTest(extra=extra):
                alterado = json.loads(json.dumps(corpo))
                alvo = alterado if caminho == ("",) else alterado[caminho[0]]
                alvo[extra] = "x"
                with self.assertRaises(ValidationError):
                    Diagnostico.model_validate(alterado)
        alterado = json.loads(json.dumps(corpo))
        alterado["prontidao"]["funcoes"]["x"] = {"available": True, "state": "ready", "missing_files": []}
        with self.assertRaises(ValidationError):
            Diagnostico.model_validate(alterado)

    def test_download_tem_cabecalhos_e_exige_sessao(self) -> None:
        resposta = self.client.get("/api/saude-local/diagnostico")
        self.assertEqual(resposta.status_code, 200)
        self.assertRegex(resposta.headers["content-disposition"],
                         r'^attachment; filename="diagnostico-simpress-\d{8}-\d{6}\.json"$')
        self.assertTrue(resposta.headers["content-type"].startswith("application/json"))
        self.assertIn("no-store", resposta.headers["cache-control"])
        self.assertEqual(resposta.headers["x-content-type-options"], "nosniff")
        anonimo = self._cliente(com_cookie=False)
        for metodo, rota in (("GET", "/api/saude-local"), ("GET", "/api/saude-local/diagnostico"),
                             ("POST", "/api/saude-local/limpeza/previa"), ("POST", "/api/saude-local/limpeza")):
            with self.subTest(rota=rota):
                self.assertEqual(anonimo.request(metodo, rota, json={"confirmado": True}).status_code, 401)

    def test_app_real_registra_as_rotas_atras_da_sessao(self) -> None:
        client = TestClient(main.app, base_url=f"http://127.0.0.1:{main.SERVER_PORT}", client=("127.0.0.1", 1234))
        self.addCleanup(client.close)
        self.assertEqual(client.get("/api/saude-local").status_code, 401)
        caminhos = set(main.app.openapi()["paths"])
        self.assertTrue({"/api/saude-local", "/api/saude-local/limpeza/previa", "/api/saude-local/limpeza",
                         "/api/saude-local/diagnostico"} <= caminhos)


class ChromeOcupadoNoMainTests(SaudeLocalBase):
    def test_leitura_da_trava_nao_cria_o_runner_nem_grava(self) -> None:
        state = self.root / "data" / "state"
        logs = self.root / "data" / "logs"
        with patch.object(main, "_chrome_automation_runner", None), patch.object(main, "STATE_DIR", state), \
                patch.object(main, "LOG_DIR", logs), patch.object(main, "BASE_DIR", self.root), \
                patch.object(main, "ChromeAutomationRunner", side_effect=AssertionError("criou o runner")):
            antes = _snapshot(self.root)
            self.assertFalse(main._chrome_automation_busy())
            self.assertEqual(_snapshot(self.root), antes)
            (state / "automacao_chrome.lock").write_text(json.dumps({"pid": os.getpid(), "rotina": "os"}), encoding="utf-8")
            antes = _snapshot(self.root)
            self.assertTrue(main._chrome_automation_busy())
            self.assertEqual(_snapshot(self.root), antes)
            self.assertIsNone(main._chrome_automation_runner)

class LinksEPacotesTests(SaudeLocalBase):
    def test_link_para_fora_da_raiz_nao_e_medido_nem_apagado(self) -> None:
        contexto = tempfile.TemporaryDirectory(prefix="saude-fora-")
        self.addCleanup(contexto.cleanup)
        fora = Path(contexto.name)
        alvo = _escrever(fora / "alvo.json", b"x" * 5000)
        tmp_fora = _escrever(fora / ".alvo.json.a1b2c3d4.tmp", b"x" * 5000)
        _envelhecer(tmp_fora, 30)
        try:
            os.symlink(fora, self.root / "data" / "state" / "link-fora", target_is_directory=True)
            os.symlink(fora, self.root / "data" / "logs" / "link-fora", target_is_directory=True)
            os.symlink(fora, self.root / "data" / "planilhas_entrada" / "_backups" / "link-fora", target_is_directory=True)
            os.symlink(tmp_fora, self.root / "data" / "state" / ".alvo.json.zzzz9999.tmp")
            _escrever(self.root / "data" / "state" / "alvo.json", b"x" * 5000)
        except (OSError, NotImplementedError):
            self.skipTest("Sem permissão para criar link simbólico.")
        antes_fora = _snapshot(fora)

        saude = self.client.get("/api/saude-local").json()
        areas = {a["chave"]: a for a in saude["areas"]}
        self.assertEqual(areas["logs"]["bytes"], (self.root / "data" / "logs" / "app.log").stat().st_size)
        self.assertEqual(areas["backups_planilhas"]["arquivos"], 1)
        previa = self.client.post("/api/saude-local/limpeza/previa").json()
        limpeza = self.client.post("/api/saude-local/limpeza", json={"confirmado": True}).json()
        for corpo in (previa, limpeza):
            self.assertFalse([i for i in corpo["itens"] if "alvo" in i["caminho"] or "link-fora" in i["caminho"]])
        self.assertEqual(_snapshot(fora), antes_fora)
        self.assertTrue(alvo.is_file() and tmp_fora.is_file())
        self.assertTrue((self.root / "data" / "state" / ".alvo.json.zzzz9999.tmp").is_symlink())

    def _pacotes(self) -> Dict[str, Any]:
        areas = {a["chave"]: a for a in self.client.get("/api/saude-local").json()["areas"]}
        return areas["pacotes_locais"]

    def test_pacotes_locais_usa_a_chave_pasta_e_o_padrao(self) -> None:
        self.assertEqual(self._pacotes(), {"chave": "pacotes_locais", "arquivos": 1, "bytes": 6, "existe": True})

        contexto = tempfile.TemporaryDirectory(prefix=f"pacotes {PESSOA}-")
        self.addCleanup(contexto.cleanup)
        configurada = Path(contexto.name)
        _escrever(configurada / "a.zip", b"12")
        _escrever(configurada / "sub" / "b.zip", b"345")
        config = _escrever(self.root / "config" / "pacote_local.json", json.dumps({"pasta": str(configurada)}).encode())
        texto = self.client.get("/api/saude-local").text
        self.assertEqual(self._pacotes(), {"chave": "pacotes_locais", "arquivos": 2, "bytes": 5, "existe": True})
        self.assertNotIn(PESSOA, texto)
        self.assertNotIn(str(configurada), texto)

        for rede in ("\\\\servidor\\pacotes", "//servidor/pacotes", "/\\servidor\\pacotes", "\\/servidor\\pacotes"):
            config.write_text(json.dumps({"pasta": rede}), encoding="utf-8")
            self.assertEqual(self._pacotes(), {"chave": "pacotes_locais", "arquivos": 0, "bytes": 0, "existe": False}, rede)
        config.write_text(json.dumps({"pasta": str(configurada / "nao-existe")}), encoding="utf-8")
        self.assertEqual(self._pacotes(), {"chave": "pacotes_locais", "arquivos": 0, "bytes": 0, "existe": False})
        for invalido in ("{quebrado", json.dumps({"pasta": ""}), json.dumps(["x"])):
            config.write_text(invalido, encoding="utf-8")
            self.assertEqual(self._pacotes()["arquivos"], 1, invalido)


class AssistenteSaudeLocalTests(unittest.TestCase):
    def test_ferramenta_so_leitura_existe_e_nao_ha_ferramenta_de_limpeza(self) -> None:
        ferramenta = TOOLS["obter_saude_local"]
        self.assertFalse(ferramenta.changes_data)
        self.assertIn("obter_saude_local", NUCLEO_FERRAMENTAS)
        self.assertFalse([nome for nome in TOOLS if "limp" in nome or "saude" in nome and nome != "obter_saude_local"])
        arquivos = sorted(p.relative_to(PROJECT_ROOT).as_posix() for p in (PROJECT_ROOT / "domains").glob("assistant_api*.py"))
        for arquivo in (*arquivos, "domains/assistant_tools.py", "domains/assistant_chat.py"):
            texto = (PROJECT_ROOT / arquivo).read_text(encoding="utf-8")
            self.assertNotIn("/api/saude-local/limpeza", texto, arquivo)
            self.assertNotIn("/api/saude-local/diagnostico", texto, arquivo)

        chamadas: List[Tuple[str, str]] = []

        def transporte(metodo: str, caminho: str, params: Optional[Dict[str, Any]], corpo: Any) -> Tuple[int, Any]:
            chamadas.append((metodo, caminho))
            return 200, {"transacoes": {"situacao": "limpo", "quantidade": 0}}

        resultado = ferramenta.run(SimpressApi(transporte), {})
        self.assertEqual(chamadas, [("GET", "/api/saude-local")])
        self.assertEqual(resultado["dados"]["transacoes"]["situacao"], "limpo")


if __name__ == "__main__":
    unittest.main()
