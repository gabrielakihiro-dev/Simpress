"""E-mails por modelo pelo Outlook (Home): modelos, contatos do Entra, envio com runner falso e script fixo.

Só dados sintéticos, pasta temporária e runner falso: o ``outlook_mail.ps1`` nunca é executado aqui.
"""

import contextlib
import json
import logging
import os
import re
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from core.integrity import FileBusyError, FileTransactionError
from domains import outlook_mail
from domains.outlook_mail import CORPO_CABO, SCRIPT_PS1
from routers.outlook_mail import create_outlook_mail_router

SEGREDO_CORPO = "corpo-secreto-xyz"
SEGREDO_NOME = "Pessoa Sigilosa Zeta"
SEGREDO_SETOR = "Setor Sigiloso Zeta"
SEGREDO_PARA = "destino.sigiloso@exemplo.test"
SEGREDO_MODELO = "Modelo Sigiloso Zeta"
SEGREDO_BUSCA = "termobuscasigiloso"

DIRETORIO = {
    "aderetti": "Allex Fernando Deretti",
    "fneves": "Fabio Neves",
    "fnsilva": "Fabio Neves Silva",
    "fsneves": "Fabio Souza Neves",
    "rkriki": "Robinson Luiz de Souza Kriki Silvestre",
    "rkrikij": "Robinson Luiz de Souza Kriki Silvestre Junior",
    "jalvares": "José Álvares",
    "ana": "Ana Silva",
    "mariana": "Mariana Silva",
    "prnoteabc$": "Maquina Teste",
    "convidado_exemplo.test#ext#": "Convidado Externo",
}


class RunnerFalso:
    """Faz o papel de ``subprocess.run``: guarda as chamadas e devolve a saída combinada."""

    def __init__(self, saida: str = "OK:aberto\n", *, expira=False, expira_com=None, excecao=None):
        self.saida = saida
        self.expira = expira
        self.expira_com = expira_com
        self.excecao = excecao
        self.chamadas: list[tuple[list[str], dict]] = []

    def __call__(self, comando, **opcoes):
        self.chamadas.append((list(comando), opcoes))
        if self.excecao is not None:
            raise self.excecao
        if self.expira or self.expira_com is not None:
            raise subprocess.TimeoutExpired(comando, opcoes["timeout"], output=self.expira_com)
        return subprocess.CompletedProcess(comando, 0, stdout=self.saida.encode("utf-8"), stderr=b"")

    def pedido(self) -> dict:
        return json.loads(self.chamadas[-1][1]["input"].decode("utf-8"))


class ListaDeLogs(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.DEBUG)
        self.linhas: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.linhas.append(record.getMessage())


@contextlib.contextmanager
def capturar_logs():
    """Só os logs do app (o httpx do TestClient registra a URL da chamada, que não é do app)."""
    lista = ListaDeLogs()
    nomes = ("domains.outlook_mail", "routers.outlook_mail")
    antes = {nome: logging.getLogger(nome).level for nome in nomes}
    for nome in nomes:
        logging.getLogger(nome).addHandler(lista)
        logging.getLogger(nome).setLevel(logging.DEBUG)
    try:
        yield lista.linhas
    finally:
        for nome in nomes:
            logging.getLogger(nome).removeHandler(lista)
            logging.getLogger(nome).setLevel(antes[nome])


def pedido_email(**mudancas) -> dict:
    base = {
        "conta": "sebrae", "para": "Allex Fernando Deretti;", "cc": "", "assunto": "Assunto",
        "corpo": "Corpo", "nome": "Fulana", "setor": "TI", "modo": "abrir", "confirmado": False,
    }
    base.update(mudancas)
    return base


class OutlookMailBase(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.pasta = Path(temp.name)
        self.arquivo = self.pasta / "outlook_email_modelos.json"
        self.entra = self.pasta / "entra_users.json"
        self.escrever_diretorio(DIRETORIO)
        self.runner = RunnerFalso()
        self.client = self.novo_client(self.runner)

    def escrever_diretorio(self, usuarios: dict) -> None:
        self.entra.write_text(json.dumps({"version": 1, "users": usuarios}), encoding="utf-8")

    def novo_client(self, runner) -> TestClient:
        app = FastAPI()
        app.include_router(create_outlook_mail_router(self.arquivo, self.entra, executar_processo=runner))
        return TestClient(app)

    def config(self) -> dict:
        resposta = self.client.get("/api/outlook/email/configuracao")
        self.assertEqual(resposta.status_code, 200, resposta.text)
        return resposta.json()

    def modelo(self, modelo_id: str) -> dict:
        return next(m for m in self.config()["modelos"] if m["id"] == modelo_id)

    def criar(self, **corpo) -> dict:
        resposta = self.client.post("/api/outlook/email/modelos", json=corpo)
        self.assertEqual(resposta.status_code, 200, resposta.text)
        return resposta.json()

    def enviar(self, **mudancas):
        return self.client.post("/api/outlook/email", json=pedido_email(**mudancas))


class ModelosTests(OutlookMailBase):
    def test_semente_do_cabo_tem_corpo_literal_com_espacos_finais(self):
        cabo = self.config()["modelos"][0]
        self.assertEqual(cabo["id"], "cabo")
        self.assertEqual(cabo["nome"], "Modelo 1 - Cabo")
        self.assertEqual(cabo["conta"], "sebrae")
        self.assertEqual(cabo["para"], "Allex Fernando Deretti;")
        self.assertEqual(cabo["cc"], "Fabio Neves; Robinson Luiz de Souza Kriki Silvestre;")
        self.assertEqual(cabo["assunto"], "Instalação do Cabo de Segurança")
        self.assertEqual(
            cabo["corpo"],
            "Allex, \n"
            "Solicito a instalação de um cabo de segurança para o(a) {nome} - {setor}\n"
            "O cabo já está com o(a) colaborador(a).\n"
            "Qualquer dúvida estarei à disposição. \n"
            "Att. Gabriel Akihiro",
        )
        self.assertEqual(cabo["corpo"], CORPO_CABO)
        self.assertTrue(cabo["corpo"].startswith("Allex, \n"))
        self.assertIn("disposição. \n", cabo["corpo"])

    def test_configuracao_traz_contas_modelos_e_diretorio(self):
        dados = self.config()
        self.assertEqual(
            {c["id"]: (c["padrao"], c["rotulo"]) for c in dados["contas"]},
            {"sebrae": (True, "Sebrae"), "simpress": (False, "Simpress")},
        )
        self.assertEqual({c["email"] for c in dados["contas"]}, {"gakihiro@pr.sebrae.com.br", "gansouza@simpress.com.br"})
        self.assertEqual(dados["diretorio"], {"disponivel": True, "total": len(DIRETORIO) - 2})

    def test_arquivo_so_e_criado_na_primeira_edicao(self):
        self.config()
        self.assertFalse(self.arquivo.exists())
        resposta = self.client.put("/api/outlook/email/modelos/cabo", json={"assunto": "Novo assunto"})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        gravado = json.loads(self.arquivo.read_text(encoding="utf-8"))
        self.assertEqual(gravado["version"], 1)
        self.assertEqual([m["id"] for m in gravado["modelos"]], ["cabo"])
        self.assertEqual(gravado["modelos"][0]["assunto"], "Novo assunto")
        self.assertEqual(gravado["modelos"][0]["corpo"], CORPO_CABO)

    def test_criar_vazio_e_duplicar(self):
        vazio = self.criar()
        self.assertEqual(
            (vazio["nome"], vazio["conta"], vazio["para"], vazio["cc"], vazio["assunto"], vazio["corpo"]),
            ("Novo modelo", "sebrae", "", "", "", ""),
        )
        self.assertRegex(vazio["id"], r"^[0-9a-f]{12}$")
        nomeado = self.criar(nome="  Outro modelo ")
        self.assertEqual(nomeado["nome"], "Outro modelo")
        copia = self.criar(copiar_de="cabo")
        self.assertEqual(copia["nome"], "Modelo 1 - Cabo (cópia)")
        self.assertEqual(copia["corpo"], CORPO_CABO)
        self.assertEqual(copia["cc"], self.modelo("cabo")["cc"])
        self.assertNotEqual(copia["id"], "cabo")
        copia2 = self.criar(copiar_de="cabo")
        self.assertEqual(copia2["nome"], "Modelo 1 - Cabo (cópia) 2")
        inexistente = self.client.post("/api/outlook/email/modelos", json={"copiar_de": "naoexiste"})
        self.assertEqual((inexistente.status_code, inexistente.json()["codigo"]), (404, "modelo_inexistente"))

    def test_put_parcial_so_muda_os_campos_enviados(self):
        antes = self.modelo("cabo")
        resposta = self.client.put("/api/outlook/email/modelos/cabo", json={"assunto": "Só o assunto", "conta": "simpress"})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        depois = self.modelo("cabo")
        self.assertEqual((depois["assunto"], depois["conta"]), ("Só o assunto", "simpress"))
        for campo in ("nome", "para", "cc", "corpo"):
            self.assertEqual(depois[campo], antes[campo])
        self.assertNotEqual(depois["atualizado_em"], "")
        desconhecido = self.client.put("/api/outlook/email/modelos/cabo", json={"id": "x"})
        self.assertEqual(desconhecido.status_code, 422)
        conta_ruim = self.client.put("/api/outlook/email/modelos/cabo", json={"conta": "outra"})
        self.assertEqual((conta_ruim.status_code, conta_ruim.json()["codigo"]), (422, "campo_invalido"))
        sem_modelo = self.client.put("/api/outlook/email/modelos/inexistente", json={"assunto": "x"})
        self.assertEqual((sem_modelo.status_code, sem_modelo.json()["codigo"]), (404, "modelo_inexistente"))
        id_ruim = self.client.put("/api/outlook/email/modelos/ID%20RUIM", json={"assunto": "x"})
        self.assertEqual((id_ruim.status_code, id_ruim.json()["codigo"]), (404, "modelo_inexistente"))

    def test_nome_duplicado_sem_distinguir_maiusculas_e_422(self):
        resposta = self.client.post("/api/outlook/email/modelos", json={"nome": "MODELO 1 - cabo"})
        self.assertEqual((resposta.status_code, resposta.json()["codigo"]), (422, "nome_duplicado"))
        outro = self.criar(nome="Segundo")
        renomear = self.client.put(f"/api/outlook/email/modelos/{outro['id']}", json={"nome": "modelo 1 - CABO"})
        self.assertEqual((renomear.status_code, renomear.json()["codigo"]), (422, "nome_duplicado"))
        mesmo = self.client.put(f"/api/outlook/email/modelos/{outro['id']}", json={"nome": "SEGUNDO"})
        self.assertEqual(mesmo.status_code, 200, mesmo.text)
        self.assertEqual(self.modelo(outro["id"])["nome"], "SEGUNDO")

    def test_excluir_o_ultimo_modelo_e_422(self):
        recusa = self.client.delete("/api/outlook/email/modelos/cabo")
        self.assertEqual((recusa.status_code, recusa.json()["codigo"]), (422, "ultimo_modelo"))
        self.assertEqual(recusa.json()["detail"], "Mantenha ao menos um modelo.")
        outro = self.criar(nome="Segundo")
        ok = self.client.delete(f"/api/outlook/email/modelos/{outro['id']}")
        self.assertEqual((ok.status_code, ok.json()), (200, {"ok": True}))
        self.assertEqual([m["id"] for m in self.config()["modelos"]], ["cabo"])
        sem = self.client.delete(f"/api/outlook/email/modelos/{outro['id']}")
        self.assertEqual((sem.status_code, sem.json()["codigo"]), (404, "modelo_inexistente"))

    def test_restaurar_so_vale_para_o_cabo(self):
        self.client.put("/api/outlook/email/modelos/cabo", json={
            "nome": "Meu cabo", "conta": "simpress", "para": "x", "cc": "y", "assunto": "z", "corpo": "w",
        })
        resposta = self.client.post("/api/outlook/email/modelos/cabo/restaurar")
        self.assertEqual(resposta.status_code, 200, resposta.text)
        cabo = self.modelo("cabo")
        self.assertEqual(cabo["nome"], "Meu cabo")
        self.assertEqual(
            (cabo["conta"], cabo["para"], cabo["cc"], cabo["assunto"], cabo["corpo"]),
            ("sebrae", "Allex Fernando Deretti;", "Fabio Neves; Robinson Luiz de Souza Kriki Silvestre;",
             "Instalação do Cabo de Segurança", CORPO_CABO),
        )
        outro = self.criar(nome="Outro")
        recusa = self.client.post(f"/api/outlook/email/modelos/{outro['id']}/restaurar")
        self.assertEqual((recusa.status_code, recusa.json()["codigo"]), (422, "sem_padrao"))

    def test_limite_de_50_modelos(self):
        modelos = [outlook_mail.semente_cabo()] + [
            {**outlook_mail.semente_cabo(), "id": f"m{n}", "nome": f"Modelo {n}"} for n in range(49)
        ]
        self.arquivo.write_text(json.dumps({"version": 1, "modelos": modelos}), encoding="utf-8")
        recusa = self.client.post("/api/outlook/email/modelos", json={})
        self.assertEqual((recusa.status_code, recusa.json()["codigo"]), (422, "limite_modelos"))
        duplicar = self.client.post("/api/outlook/email/modelos", json={"copiar_de": "cabo"})
        self.assertEqual((duplicar.status_code, duplicar.json()["codigo"]), (422, "limite_modelos"))
        self.assertEqual(len(self.config()["modelos"]), 50)
        self.client.delete("/api/outlook/email/modelos/m0")
        self.assertEqual(self.client.post("/api/outlook/email/modelos", json={}).status_code, 200)

    def test_limites_de_campos_e_caracteres_de_controle(self):
        casos = {
            "nome": ("n" * 81, "n" * 80),
            "para": ("p" * 1001, "p" * 1000),
            "cc": ("c" * 1001, "c" * 1000),
            "assunto": ("a" * 201, "a" * 200),
            "corpo": ("b" * 4001, "b" * 4000),
        }
        for campo, (longo, no_limite) in casos.items():
            with self.subTest(campo=campo):
                recusa = self.client.put("/api/outlook/email/modelos/cabo", json={campo: longo})
                self.assertEqual((recusa.status_code, recusa.json()["codigo"]), (422, "campo_invalido"))
                self.assertEqual(self.client.put("/api/outlook/email/modelos/cabo", json={campo: no_limite}).status_code, 200)
        for campo in ("nome", "para", "cc", "assunto", "corpo"):
            with self.subTest(controle=campo):
                recusa = self.client.put("/api/outlook/email/modelos/cabo", json={campo: "a\x00b"})
                self.assertEqual((recusa.status_code, recusa.json()["codigo"]), (422, "campo_invalido"))
        # \n e \t só são aceitos no corpo.
        self.assertEqual(self.client.put("/api/outlook/email/modelos/cabo", json={"corpo": "l1\n\tl2"}).status_code, 200)
        self.assertEqual(self.client.put("/api/outlook/email/modelos/cabo", json={"assunto": "a\nb"}).status_code, 422)
        self.assertEqual(self.client.put("/api/outlook/email/modelos/cabo", json={"nome": ""}).status_code, 422)
        self.assertEqual(self.client.put("/api/outlook/email/modelos/cabo", json={"nome": None}).status_code, 422)

    def test_gravacao_atomica_falha_sem_alterar_o_arquivo(self):
        self.client.put("/api/outlook/email/modelos/cabo", json={"assunto": "Antes"})
        bytes_antes = self.arquivo.read_bytes()
        with mock.patch("domains.outlook_mail.atomic_write_json", side_effect=FileTransactionError("falhou")):
            falha = self.client.put("/api/outlook/email/modelos/cabo", json={"assunto": "Depois"})
        self.assertEqual((falha.status_code, falha.json()["codigo"]), (503, "modelos_gravacao"))
        self.assertEqual(self.arquivo.read_bytes(), bytes_antes)
        with mock.patch("domains.outlook_mail.lock_paths", side_effect=FileBusyError("ocupado")):
            ocupado = self.client.put("/api/outlook/email/modelos/cabo", json={"assunto": "Depois"})
        self.assertEqual((ocupado.status_code, ocupado.json()["codigo"]), (503, "modelos_ocupados"))
        self.assertEqual(self.arquivo.read_bytes(), bytes_antes)
        # Sem sobra de arquivo temporário: só o JSON e a trava de arquivo.
        restos = {p.name for p in self.pasta.iterdir() if "outlook_email_modelos" in p.name and not p.name.endswith(".lock")}
        self.assertEqual(restos, {self.arquivo.name})

    def test_gravacao_usa_arquivo_temporario_e_substituicao(self):
        with mock.patch("domains.outlook_mail.atomic_write_json", wraps=outlook_mail.atomic_write_json) as escrita:
            self.client.put("/api/outlook/email/modelos/cabo", json={"assunto": "Atômico"})
        escrita.assert_called_once()
        self.assertEqual(json.loads(self.arquivo.read_text(encoding="utf-8"))["modelos"][0]["assunto"], "Atômico")

    def test_arquivo_corrompido_vira_503_sem_sobrescrever(self):
        invalidos = [
            b"{corrompido", b"[]", b'{"version": 2, "modelos": []}', b'{"version": 1, "modelos": []}',
            b'{"version": 1, "modelos": [{"id": "x"}]}', b"\xff\xfe\x00",
        ]
        for conteudo in invalidos:
            with self.subTest(conteudo=conteudo):
                self.arquivo.write_bytes(conteudo)
                for resposta in (
                    self.client.get("/api/outlook/email/configuracao"),
                    self.client.put("/api/outlook/email/modelos/cabo", json={"assunto": "x"}),
                    self.client.post("/api/outlook/email/modelos", json={}),
                    self.client.delete("/api/outlook/email/modelos/cabo"),
                    self.client.post("/api/outlook/email/modelos/cabo/restaurar"),
                ):
                    self.assertEqual((resposta.status_code, resposta.json()["codigo"]), (503, "modelos_ilegiveis"))
                self.assertEqual(self.arquivo.read_bytes(), conteudo)


class ContatosTests(OutlookMailBase):
    def buscar(self, termo: str):
        return self.client.get("/api/outlook/contatos", params={"q": termo})

    def test_busca_exige_ao_menos_2_caracteres(self):
        for termo in ("", "a", " a "):
            with self.subTest(termo=termo):
                resposta = self.buscar(termo)
                self.assertEqual((resposta.status_code, resposta.json()["codigo"]), (422, "consulta_curta"))
        self.assertEqual(self.buscar("fn").status_code, 200)

    def test_busca_ignora_acento_e_maiuscula_e_acha_pelo_login(self):
        for termo in ("jose", "JOSÉ", "alvares", "ÁLVA", "jalv"):
            with self.subTest(termo=termo):
                contatos = self.buscar(termo).json()["contatos"]
                self.assertEqual(contatos, [{"nome": "José Álvares", "email": "jalvares@pr.sebrae.com.br"}])

    def test_busca_deixa_contas_de_maquina_e_convidados_de_fora(self):
        for termo in ("maquina", "prnoteabc", "convidado", "externo", "ext"):
            with self.subTest(termo=termo):
                self.assertEqual(self.buscar(termo).json()["contatos"], [])

    def test_busca_devolve_no_maximo_8_resultados(self):
        self.escrever_diretorio({f"teste{n:02d}": f"Teste Pessoa {n:02d}" for n in range(12)})
        contatos = self.buscar("teste").json()["contatos"]
        self.assertEqual(len(contatos), 8)
        self.assertEqual([c["nome"] for c in contatos], [f"Teste Pessoa {n:02d}" for n in range(8)])

    def test_prefixo_de_palavra_vem_antes_de_contem(self):
        nomes = [c["nome"] for c in self.buscar("ana").json()["contatos"]]
        self.assertEqual(nomes, ["Ana Silva", "Mariana Silva"])

    def test_diretorio_indisponivel_nao_quebra_a_configuracao(self):
        self.entra.write_text("{corrompido", encoding="utf-8")
        self.assertEqual(self.config()["diretorio"], {"disponivel": False, "total": 0})
        self.assertEqual(self.buscar("fabio").json()["contatos"], [])
        resolvido = self.client.post("/api/outlook/contatos/resolver", json={"tokens": ["Fabio Neves"]}).json()
        self.assertEqual(resolvido["resultados"][0]["status"], "nenhum")


class ResolverTests(OutlookMailBase):
    def resolver(self, *tokens: str) -> list[dict]:
        resposta = self.client.post("/api/outlook/contatos/resolver", json={"tokens": list(tokens)})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        return resposta.json()["resultados"]

    def test_resolver_unico_ambiguo_nenhum_e_email(self):
        unico, ambiguo, nenhum, email = self.resolver("Allex Deretti", "Silva", "Fulano Inexistente", "alguem@exemplo.test")
        self.assertEqual(unico, {
            "token": "Allex Deretti", "status": "unico", "nome": "Allex Fernando Deretti",
            "email": "aderetti@pr.sebrae.com.br",
        })
        self.assertEqual(ambiguo["status"], "ambiguo")
        self.assertEqual(
            {o["nome"] for o in ambiguo["opcoes"]}, {"Fabio Neves Silva", "Ana Silva", "Mariana Silva"},
        )
        self.assertEqual(nenhum, {"token": "Fulano Inexistente", "status": "nenhum"})
        self.assertEqual(email, {"token": "alguem@exemplo.test", "status": "unico", "email": "alguem@exemplo.test"})

    def test_resolver_ignora_acento_e_maiuscula(self):
        (resultado,) = self.resolver("JOSE alvares")
        self.assertEqual((resultado["status"], resultado["email"]), ("unico", "jalvares@pr.sebrae.com.br"))

    def test_resolver_nome_exato_vale_mais_que_nomes_que_so_contem_as_palavras(self):
        # Mesma forma do Cc da semente, só com dados sintéticos.
        fabio, robinson = self.resolver("Fabio Neves", "Robinson Luiz de Souza Kriki Silvestre")
        self.assertEqual(fabio, {
            "token": "Fabio Neves", "status": "unico", "nome": "Fabio Neves", "email": "fneves@pr.sebrae.com.br",
        })
        self.assertEqual((robinson["status"], robinson["email"]), ("unico", "rkriki@pr.sebrae.com.br"))
        # Sem o nome exato, as mesmas palavras ainda dão mais de uma pessoa.
        (sem_exato,) = self.resolver("Fabio")
        self.assertEqual(sem_exato["status"], "ambiguo")
        (parcial,) = self.resolver("Robinson Silvestre")
        self.assertEqual(parcial["status"], "ambiguo")

    def test_resolver_dois_nomes_exatos_iguais_continua_ambiguo(self):
        self.escrever_diretorio({"fneves": "Fabio Neves", "fneves2": "FÁBIO  neves", "fnsilva": "Fabio Neves Silva"})
        (resultado,) = self.resolver("Fabio Neves")
        self.assertEqual(resultado["status"], "ambiguo")
        self.assertEqual({o["email"] for o in resultado["opcoes"]}, {"fneves@pr.sebrae.com.br", "fneves2@pr.sebrae.com.br"})

    def test_resolver_nome_exato_com_acento_e_caixa_diferentes(self):
        self.escrever_diretorio({"jalvares": "José Álvares", "jalvares2": "José Álvares Filho"})
        (resultado,) = self.resolver("JOSE ALVARES")
        self.assertEqual((resultado["status"], resultado["email"]), ("unico", "jalvares@pr.sebrae.com.br"))

    def test_resolver_deixa_maquinas_e_convidados_de_fora(self):
        for token in ("Maquina Teste", "Convidado Externo"):
            with self.subTest(token=token):
                (resultado,) = self.resolver(token)
                self.assertEqual(resultado["status"], "nenhum")

    def test_resolver_limita_tokens_e_tamanho(self):
        muitos = self.client.post("/api/outlook/contatos/resolver", json={"tokens": ["a"] * 51})
        self.assertEqual((muitos.status_code, muitos.json()["codigo"]), (422, "campo_invalido"))
        longo = self.client.post("/api/outlook/contatos/resolver", json={"tokens": ["a" * 201]})
        self.assertEqual((longo.status_code, longo.json()["codigo"]), (422, "campo_invalido"))

    def test_resolver_so_le_o_diretorio(self):
        antes = self.entra.read_bytes()
        self.resolver("Fabio Neves")
        self.assertEqual(self.entra.read_bytes(), antes)


class EnvioTests(OutlookMailBase):
    def test_validacao_e_limites_do_pedido(self):
        recusas = {
            "conta desconhecida": ({"conta": "outra"}, "conta_ausente"),
            "para so com ponto e virgula no enviar": ({"para": " ; ", "modo": "enviar", "confirmado": True}, "campo_invalido"),
            "para longo": ({"para": "p" * 1001}, "campo_invalido"),
            "cc longo": ({"cc": "c" * 1001}, "campo_invalido"),
            "assunto longo": ({"assunto": "a" * 201}, "campo_invalido"),
            "corpo longo": ({"corpo": "b" * 4001}, "campo_invalido"),
            "controle no assunto": ({"assunto": "a\x07b"}, "campo_invalido"),
            "quebra de linha no assunto": ({"assunto": "a\nb"}, "campo_invalido"),
            "controle no corpo": ({"corpo": "a\x00b"}, "campo_invalido"),
            "nome longo": ({"nome": "n" * 201}, "campo_invalido"),
            "setor com controle": ({"setor": "s\x00"}, "campo_invalido"),
        }
        for nome, (mudancas, codigo) in recusas.items():
            with self.subTest(nome):
                resposta = self.enviar(**mudancas)
                self.assertEqual((resposta.status_code, resposta.json()["codigo"]), (422, codigo), resposta.text)
        modo_ruim = self.enviar(modo="apagar")
        self.assertEqual(modo_ruim.status_code, 422)
        extra = self.client.post("/api/outlook/email", json={**pedido_email(), "script": "x"})
        self.assertEqual(extra.status_code, 422)
        self.assertEqual(self.runner.chamadas, [])
        corpo_no_limite = self.enviar(corpo="b" * 4000, para="p" * 1000)
        self.assertEqual(corpo_no_limite.status_code, 200, corpo_no_limite.text)
        com_quebras = self.enviar(corpo="l1\n\tl2")
        self.assertEqual(com_quebras.status_code, 200, com_quebras.text)

    def test_enviar_exige_confirmado_true(self):
        self.runner.saida = "PASSO:antes_send\nOK:enviado\n"
        sem = self.enviar(modo="enviar")
        self.assertEqual((sem.status_code, sem.json()["codigo"]), (422, "confirmacao_necessaria"))
        falso = self.enviar(modo="enviar", confirmado=False)
        self.assertEqual((falso.status_code, falso.json()["codigo"]), (422, "confirmacao_necessaria"))
        texto = self.enviar(modo="enviar", confirmado="true")
        self.assertEqual(texto.status_code, 422)
        self.assertEqual(self.runner.chamadas, [])
        ok = self.enviar(modo="enviar", confirmado=True)
        self.assertEqual((ok.status_code, ok.json()), (200, {"status": "enviado", "conta": "sebrae"}))
        self.assertEqual(len(self.runner.chamadas), 1)

    def test_abrir_nao_exige_confirmado(self):
        resposta = self.enviar(modo="abrir")
        self.assertEqual((resposta.status_code, resposta.json()), (200, {"status": "aberto", "conta": "sebrae"}))
        self.assertEqual(self.runner.pedido()["modo"], "abrir")

    def test_substitui_nome_e_setor_no_assunto_e_no_corpo(self):
        self.enviar(assunto="Cabo para {nome}", corpo="Para o(a) {nome} - {setor}\n{setor} / {nome}", nome=" Fulana de Tal ", setor="Financeiro")
        pedido = self.runner.pedido()
        self.assertEqual(pedido["assunto"], "Cabo para Fulana de Tal")
        self.assertEqual(pedido["corpo"], "Para o(a) Fulana de Tal - Financeiro\nFinanceiro / Fulana de Tal")
        # Uma só passada: um valor que parece marcador não é substituído de novo.
        self.enviar(corpo="{nome} - {setor}", nome="{setor}", setor="TI")
        self.assertEqual(self.runner.pedido()["corpo"], "{setor} - TI")

    def test_valor_vazio_vira_marcador_no_abrir(self):
        resposta = self.enviar(modo="abrir", assunto="Cabo {nome}", corpo="{nome} - {setor}", nome="", setor="  ")
        self.assertEqual(resposta.status_code, 200, resposta.text)
        pedido = self.runner.pedido()
        self.assertEqual(pedido["assunto"], "Cabo [Nome da pessoa]")
        self.assertEqual(pedido["corpo"], "[Nome da pessoa] - [Setor]")

    def test_marcador_restante_bloqueia_so_o_enviar(self):
        aberto = self.enviar(modo="abrir", corpo="{nome} - {setor}", nome="", setor="")
        self.assertEqual(aberto.status_code, 200, aberto.text)
        chamadas = len(self.runner.chamadas)
        self.runner.saida = "PASSO:antes_send\nOK:enviado\n"
        bloqueado = self.enviar(modo="enviar", confirmado=True, corpo="{nome} - {setor}", nome="", setor="")
        self.assertEqual((bloqueado.status_code, bloqueado.json()["codigo"]), (422, "marcador_pendente"))
        self.assertEqual(bloqueado.json()["detail"], "Preencha o nome da pessoa e o setor antes de enviar.")
        self.assertEqual(len(self.runner.chamadas), chamadas)
        liberado = self.enviar(modo="enviar", confirmado=True, corpo="{nome} - {setor}", nome="Fulana", setor="TI")
        self.assertEqual(liberado.status_code, 200, liberado.text)

    def test_marcador_restante_no_assunto_bloqueia_o_enviar(self):
        self.runner.saida = "PASSO:antes_send\nOK:enviado\n"
        bloqueado = self.enviar(modo="enviar", confirmado=True, assunto="Cabo {nome}", corpo="sem marcador", nome="", setor="TI")
        self.assertEqual((bloqueado.status_code, bloqueado.json()["codigo"]), (422, "marcador_pendente"))
        digitado = self.enviar(modo="enviar", confirmado=True, assunto="Cabo [Setor]", corpo="x", nome="N", setor="TI")
        self.assertEqual((digitado.status_code, digitado.json()["codigo"]), (422, "marcador_pendente"))
        self.assertEqual(self.runner.chamadas, [])
        liberado = self.enviar(modo="enviar", confirmado=True, assunto="Cabo {nome}", corpo="x", nome="Fulana", setor="TI")
        self.assertEqual(liberado.status_code, 200, liberado.text)

    def test_cada_codigo_de_erro_do_script_vira_o_status_certo(self):
        casos = [
            ("ERRO:conta_ausente\n", 422, "conta_ausente"),
            ("ERRO:destinatario_nao_resolvido\n", 422, "destinatario_nao_resolvido"),
            ("ERRO:outlook_fechado\n", 503, "outlook_fechado"),
            ("ERRO:outlook_indisponivel\n", 503, "outlook_indisponivel"),
            ("ERRO:codigo_novo_qualquer\n", 503, "outlook_indisponivel"),
            ("", 503, "outlook_indisponivel"),
            ("lixo qualquer\n", 503, "outlook_indisponivel"),
            ("PASSO:antes_send\nERRO:envio_recusado\n", 502, "envio_recusado"),
        ]
        for saida, status, codigo in casos:
            with self.subTest(saida=saida):
                self.runner.saida = saida
                resposta = self.enviar(modo="enviar", confirmado=True)
                self.assertEqual((resposta.status_code, resposta.json()["codigo"]), (status, codigo), resposta.text)
        # No abrir, os erros de conta e de COM também aparecem.
        self.runner.saida = "ERRO:conta_ausente\n"
        resposta = self.enviar(modo="abrir")
        self.assertEqual((resposta.status_code, resposta.json()["codigo"]), (422, "conta_ausente"))
        self.assertIn("gakihiro@pr.sebrae.com.br", resposta.json()["detail"])

    def test_sistema_sem_powershell_vira_outlook_indisponivel(self):
        cliente = self.novo_client(RunnerFalso(excecao=FileNotFoundError("powershell.exe")))
        resposta = cliente.post("/api/outlook/email", json=pedido_email(modo="enviar", confirmado=True))
        self.assertEqual((resposta.status_code, resposta.json()["codigo"]), (503, "outlook_indisponivel"))
        self.assertEqual(
            resposta.json()["detail"], "Outlook (classic) indisponível. Abra o Outlook clássico e tente de novo.",
        )

    def test_abrir_com_destinatario_nao_resolvido_abre_e_avisa(self):
        self.runner.saida = "AVISO:destinatario_nao_resolvido\nOK:aberto\n"
        resposta = self.enviar(modo="abrir")
        corpo = resposta.json()
        self.assertEqual((resposta.status_code, corpo["status"], corpo["conta"]), (200, "aberto", "sebrae"))
        self.assertEqual(
            corpo["aviso"], "Alguns destinatários não foram reconhecidos no Outlook. Confira os nomes antes de enviar.",
        )

    def test_enviar_com_destinatario_nao_resolvido_nao_envia(self):
        self.runner.saida = "ERRO:destinatario_nao_resolvido\n"
        resposta = self.enviar(modo="enviar", confirmado=True)
        self.assertEqual((resposta.status_code, resposta.json()["codigo"]), (422, "destinatario_nao_resolvido"))

    def test_outlook_fechado_no_enviar_vira_503_sem_criar_item(self):
        self.runner.saida = "ERRO:outlook_fechado\n"
        resposta = self.enviar(modo="enviar", confirmado=True)
        self.assertEqual((resposta.status_code, resposta.json()["codigo"]), (503, "outlook_fechado"))
        self.assertEqual(
            resposta.json()["detail"], "O Outlook (classic) não está aberto. Abra o Outlook e tente enviar de novo.",
        )
        self.assertNotIn("incerto", resposta.text)
        # O script confere o processo antes de qualquer COM ou item (prova estrutural; o .ps1 não roda aqui).
        script = SCRIPT_PS1.read_text(encoding="ascii")
        self.assertLess(script.index("Get-Process -Name OUTLOOK"), script.index("New-Object -ComObject"))
        self.assertLess(script.index("CODE:outlook_fechado"), script.index("New-Object -ComObject"))
        self.assertLess(script.index("New-Object -ComObject"), script.index("CreateItem"))

    def test_excecao_no_send_vira_envio_recusado_e_nao_incerto(self):
        self.runner.saida = "PASSO:antes_send\nERRO:envio_recusado\n"
        resposta = self.enviar(modo="enviar", confirmado=True)
        self.assertEqual((resposta.status_code, resposta.json()["codigo"]), (502, "envio_recusado"))
        self.assertNotIn("status", resposta.json())
        self.assertIn("nada foi enviado", resposta.json()["detail"])
        script = SCRIPT_PS1.read_text(encoding="ascii")
        # No script: o marcador sai antes do Send(), o Send() está num try cuja falha vira envio_recusado,
        # e o rascunho é descartado (Close(1)) no finally.
        self.assertLess(script.index("PASSO:antes_send"), script.index(".Send()"))
        self.assertLess(script.index(".Send()"), script.index("CODE:envio_recusado"))
        self.assertLess(script.index("PASSO:antes_send") , script.index("Say 'OK:enviado'"))
        self.assertRegex(script, r"finally \{[^}]*\.Close\(1\)")
        self.assertIn("[Console]::Out.Flush()", script)

    def test_enviar_ok_devolve_enviado(self):
        self.runner.saida = "PASSO:antes_send\nOK:enviado\n"
        resposta = self.enviar(modo="enviar", confirmado=True, conta="simpress")
        self.assertEqual((resposta.status_code, resposta.json()), (200, {"status": "enviado", "conta": "simpress"}))
        self.assertEqual(self.runner.pedido()["conta_email"], "gansouza@simpress.com.br")

    def test_timeout_no_enviar_depois_do_marcador_e_incerto(self):
        cliente = self.novo_client(RunnerFalso(expira_com=b"PASSO:antes_send\r\n"))
        resposta = cliente.post("/api/outlook/email", json=pedido_email(modo="enviar", confirmado=True))
        corpo = resposta.json()
        self.assertEqual((resposta.status_code, corpo["status"], corpo["conta"]), (200, "incerto", "sebrae"))
        self.assertIn("Itens Enviados", corpo["aviso"])

    def test_timeout_no_enviar_sem_marcador_e_erro_simples(self):
        for parcial in (None, b"", b"algum lixo\r\n"):
            with self.subTest(parcial=parcial):
                cliente = self.novo_client(RunnerFalso(expira=True, expira_com=parcial))
                resposta = cliente.post("/api/outlook/email", json=pedido_email(modo="enviar", confirmado=True))
                self.assertEqual((resposta.status_code, resposta.json()["codigo"]), (504, "outlook_sem_resposta"))
                self.assertIn("nada foi enviado", resposta.json()["detail"])
                self.assertNotIn("status", resposta.json())

    def test_timeout_no_abrir_devolve_aviso_de_que_a_janela_pode_aparecer(self):
        cliente = self.novo_client(RunnerFalso(expira=True))
        resposta = cliente.post("/api/outlook/email", json=pedido_email(modo="abrir"))
        corpo = resposta.json()
        self.assertEqual((resposta.status_code, corpo["status"]), (200, "aberto"))
        self.assertIn("A janela do e-mail pode aparecer em instantes", corpo["aviso"])

    def test_variavel_sem_envio_recusa_o_envio_real_e_e_lida_a_cada_pedido(self):
        self.runner.saida = "PASSO:antes_send\nOK:enviado\n"
        with mock.patch.dict(os.environ, {"SIMPRESS_OUTLOOK_SEM_ENVIO": "1"}):
            recusado = self.enviar(modo="enviar", confirmado=True)
            self.assertEqual((recusado.status_code, recusado.json()["codigo"]), (422, "envio_desativado"))
            self.assertEqual(self.runner.chamadas, [])
            self.runner.saida = "OK:aberto\n"
            self.assertEqual(self.enviar(modo="abrir").status_code, 200)
        self.assertEqual(len(self.runner.chamadas), 1)
        self.runner.saida = "PASSO:antes_send\nOK:enviado\n"
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SIMPRESS_OUTLOOK_SEM_ENVIO", None)
            self.assertEqual(self.enviar(modo="enviar", confirmado=True).status_code, 200)

    def test_trava_em_processo_responde_409_e_libera_no_fim(self):
        entrou, liberar = threading.Event(), threading.Event()
        respostas: dict[str, object] = {}

        def runner_lento(comando, **opcoes):
            entrou.set()
            liberar.wait(10)
            return subprocess.CompletedProcess(comando, 0, stdout=b"OK:aberto\n", stderr=b"")

        cliente = self.novo_client(runner_lento)
        primeiro = threading.Thread(
            target=lambda: respostas.update(primeiro=cliente.post("/api/outlook/email", json=pedido_email(modo="abrir"))),
        )
        primeiro.start()
        try:
            self.assertTrue(entrou.wait(10))
            for modo in ("abrir", "enviar"):
                with self.subTest(modo=modo):
                    ocupado = cliente.post("/api/outlook/email", json=pedido_email(modo=modo, confirmado=True))
                    self.assertEqual(ocupado.status_code, 409)
                    self.assertEqual(ocupado.json()["codigo"], "ocupado")
                    self.assertEqual(ocupado.json()["detail"], "Já há um e-mail sendo preparado. Aguarde.")
        finally:
            liberar.set()
            primeiro.join(10)
        self.assertEqual(respostas["primeiro"].status_code, 200)
        # Liberada a trava, o próximo pedido passa; e uma exceção também solta a trava.
        self.assertEqual(cliente.post("/api/outlook/email", json=pedido_email()).status_code, 200)

    def test_trava_e_solta_quando_o_runner_falha(self):
        chamadas = []

        def runner_que_falha(comando, **opcoes):
            chamadas.append(1)
            if len(chamadas) == 1:
                raise RuntimeError("falha qualquer")
            return subprocess.CompletedProcess(comando, 0, stdout=b"OK:aberto\n", stderr=b"")

        cliente = self.novo_client(runner_que_falha)
        falha = cliente.post("/api/outlook/email", json=pedido_email())
        self.assertEqual((falha.status_code, falha.json()["codigo"]), (500, "erro_inesperado"))
        self.assertNotIn("falha qualquer", falha.text)
        self.assertEqual(cliente.post("/api/outlook/email", json=pedido_email()).status_code, 200)

    def test_stdin_vai_em_utf8_sem_perder_acentos(self):
        resposta = self.enviar(
            assunto="Instalação do Cabo de Segurança", corpo="Solicito a instalação, segurança e à disposição.",
            nome="José Álvares", setor="Gestão",
        )
        self.assertEqual(resposta.status_code, 200, resposta.text)
        comando, opcoes = self.runner.chamadas[-1]
        entrada = opcoes["input"]
        self.assertIsInstance(entrada, bytes)
        self.assertIn("Instalação do Cabo de Segurança".encode("utf-8"), entrada)
        self.assertNotIn(b"\\u00e7", entrada)
        pedido = json.loads(entrada.decode("utf-8"))
        self.assertEqual(pedido["assunto"], "Instalação do Cabo de Segurança")
        self.assertEqual(pedido["corpo"], "Solicito a instalação, segurança e à disposição.")
        self.assertNotIn("text", opcoes)
        self.assertNotIn("universal_newlines", opcoes)
        self.assertNotIn("encoding", opcoes)
        self.assertIs(opcoes["capture_output"], True)
        self.assertEqual(opcoes["timeout"], 60)

    def test_script_fixo_com_file_e_noprofile_e_dados_fora_dos_argumentos(self):
        self.enviar(
            para=SEGREDO_PARA, assunto="Assunto " + SEGREDO_NOME, corpo=SEGREDO_CORPO, nome=SEGREDO_NOME, setor=SEGREDO_SETOR,
        )
        comando, opcoes = self.runner.chamadas[-1]
        self.assertEqual(
            comando,
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-File", str(SCRIPT_PS1.resolve())],
        )
        self.assertEqual(SCRIPT_PS1, Path(outlook_mail.__file__).with_name("outlook_mail.ps1"))
        self.assertTrue(SCRIPT_PS1.is_file())
        for dado in (SEGREDO_PARA, SEGREDO_NOME, SEGREDO_CORPO, SEGREDO_SETOR, "Assunto"):
            self.assertFalse(any(dado in argumento for argumento in comando))
            self.assertNotIn(dado, SCRIPT_PS1.read_text(encoding="ascii"))
        self.assertNotIn("shell", opcoes)
        if os.name == "nt":
            self.assertEqual(opcoes["creationflags"], subprocess.CREATE_NO_WINDOW)
        else:
            self.assertNotIn("creationflags", opcoes)

    def test_script_e_ascii_e_so_envia_depois_do_marcador(self):
        bytes_do_script = SCRIPT_PS1.read_bytes()
        self.assertTrue(all(b < 128 for b in bytes_do_script))
        script = bytes_do_script.decode("ascii")
        self.assertEqual(script.count(".Send()"), 1)
        self.assertEqual(script.count(".Display($false)"), 1)
        self.assertIn("[Console]::OpenStandardInput()", script)
        self.assertIn("System.Text.UTF8Encoding", script)
        self.assertIn("SmtpAddress", script)
        self.assertIn("SendUsingAccount", script)
        self.assertIn("InvokeMember", script)
        self.assertIn("CODE:conta_ausente", script)
        # Nenhum texto em português no script: só códigos e marcadores.
        self.assertIsNone(re.search(r"[^\x00-\x7f]", script))

    def test_conta_ausente_nunca_cai_em_outra_conta(self):
        self.runner.saida = "ERRO:conta_ausente\n"
        resposta = self.enviar(modo="enviar", confirmado=True, conta="simpress")
        self.assertEqual((resposta.status_code, resposta.json()["codigo"]), (422, "conta_ausente"))
        self.assertEqual(self.runner.pedido()["conta_email"], "gansouza@simpress.com.br")
        script = SCRIPT_PS1.read_text(encoding="ascii")
        self.assertLess(script.index("-ieq [string]$pedido.conta_email"), script.index("CODE:conta_ausente"))
        self.assertNotRegex(script, r"Accounts\s*\[\s*(0|1)\s*\]|DefaultAccount")


class LogsTests(OutlookMailBase):
    def test_logs_nao_levam_corpo_destinatarios_nomes_modelo_nem_busca(self):
        self.runner.saida = "PASSO:antes_send\nOK:enviado\n"
        sensiveis = (SEGREDO_CORPO, SEGREDO_NOME, SEGREDO_SETOR, SEGREDO_PARA, SEGREDO_MODELO, SEGREDO_BUSCA, "Fabio Neves")
        with capturar_logs() as linhas:
            self.criar(nome=SEGREDO_MODELO)
            self.client.get("/api/outlook/contatos", params={"q": SEGREDO_BUSCA})
            self.client.post("/api/outlook/contatos/resolver", json={"tokens": [SEGREDO_NOME, "Fabio Neves"]})
            enviado = self.enviar(
                modo="enviar", confirmado=True, para=SEGREDO_PARA, cc=SEGREDO_PARA, assunto=SEGREDO_MODELO,
                corpo=SEGREDO_CORPO, nome=SEGREDO_NOME, setor=SEGREDO_SETOR,
            )
            self.runner.saida = "ERRO:outlook_fechado\n"
            self.enviar(modo="enviar", confirmado=True, corpo=SEGREDO_CORPO, nome=SEGREDO_NOME, setor=SEGREDO_SETOR, para=SEGREDO_PARA)
            self.enviar(conta=SEGREDO_NOME, corpo=SEGREDO_CORPO)
            self.client.put("/api/outlook/email/modelos/cabo", json={"corpo": SEGREDO_CORPO, "nome": SEGREDO_MODELO + "2"})
        self.assertEqual(enviado.status_code, 200, enviado.text)
        texto = "\n".join(linhas)
        self.assertIn("modo=enviar", texto)
        self.assertIn("conta=sebrae", texto)
        self.assertIn("codigo=outlook_fechado", texto)
        self.assertIn("conta=desconhecida", texto)
        for dado in sensiveis:
            self.assertNotIn(dado, texto)

    def test_erro_inesperado_registra_so_a_classe(self):
        cliente = self.novo_client(RunnerFalso(excecao=RuntimeError(f"explodiu com {SEGREDO_CORPO}")))
        with capturar_logs() as linhas:
            resposta = cliente.post("/api/outlook/email", json=pedido_email(corpo=SEGREDO_CORPO, para=SEGREDO_PARA))
        self.assertEqual((resposta.status_code, resposta.json()["codigo"]), (500, "erro_inesperado"))
        texto = "\n".join(linhas)
        self.assertIn("RuntimeError", texto)
        self.assertNotIn(SEGREDO_CORPO, texto)
        self.assertNotIn(SEGREDO_PARA, texto)
        self.assertNotIn(SEGREDO_CORPO, resposta.text)

    def test_diretorio_ilegivel_registra_so_a_classe(self):
        self.entra.write_text("{corrompido " + SEGREDO_BUSCA, encoding="utf-8")
        with capturar_logs() as linhas:
            self.client.get("/api/outlook/email/configuracao")
        texto = "\n".join(linhas)
        self.assertIn("JSONDecodeError", texto)
        self.assertNotIn(SEGREDO_BUSCA, texto)


if __name__ == "__main__":
    unittest.main()
