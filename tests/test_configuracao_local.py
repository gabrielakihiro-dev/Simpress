"""Configuração local pelo site (contas, links e chaves de IA): só diretórios temporários e valores fictícios.

Nunca lê nem grava o config/contas_automacao.json, o arquivo de chaves (.env) ou o data/state reais da máquina.
"""

import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

with (
    patch("core.integrity.recover_pending_transactions", return_value=None),
    patch("openpyxl.load_workbook", side_effect=RuntimeError("operational data blocked")),
    redirect_stdout(io.StringIO()),
):
    import main
from domains import configuracao_local as configuracao
from domains.local_setup import cnpj_valido
from routers.configuracao_local import create_configuracao_local_router
from security import sessao_local

VARIAVEIS = (
    "SIMPRESS_DASHBOARD_EMAIL", "SIMPRESS_SOFTEXPERT_EMAIL", "SIMPRESS_ENDPOINT_USUARIO",
    "SIMPRESS_OUTLOOK_EMAIL_SIMPRESS", "SIMPRESS_OUTLOOK_EMAIL_SEBRAE", "SIMPRESS_DASHBOARD_PASTA_URL",
    "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY",
    "SIMPRESS_CLIENTE_CONTRATO", "SIMPRESS_CLIENTE_CNPJ_FATURAMENTO", "SIMPRESS_CLIENTE_SERIES_SEBRAE_FORA",
)
# "chave" no valor: o verificador de credenciais do repositório trata como exemplo, não como segredo.
CHAVE_OPENROUTER = "chave-ficticia-ABCD1234efgh5678WXYZ"
CHAVE_DEEPSEEK = "chave-ficticia-QRST9876uvwx5432MNOP"
CLIENTE_VALIDO = {"contrato": "20202", "cnpj_faturamento": "11.222.333/0001-81", "series_sebrae_fora": []}
LINK = "https://exemplo.invalid/sites/pasta-do-dashboard"


class ConfiguracaoBase(unittest.TestCase):
    def setUp(self):
        patcher = patch.dict(os.environ)
        patcher.start()
        self.addCleanup(patcher.stop)
        for variavel in VARIAVEIS:
            os.environ.pop(variavel, None)
        temporario = tempfile.TemporaryDirectory()
        self.addCleanup(temporario.cleanup)
        self.raiz = Path(temporario.name)
        self.contas = self.raiz / "config" / "contas_automacao.json"
        self.cliente = self.raiz / "config" / "cliente.json"
        self.env = self.raiz / ".env"
        self.backups = self.raiz / "data" / "state" / "config_backups"
        self.cliente.parent.mkdir(parents=True)
        self.cliente.write_text(json.dumps(CLIENTE_VALIDO), encoding="utf-8")
        app = FastAPI()
        app.include_router(create_configuracao_local_router(
            contas_file=lambda: self.contas, client_file=lambda: self.cliente,
            env_file=lambda: self.env, backups_directory=lambda: self.backups,
        ))
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def contas_gravadas(self) -> dict:
        return json.loads(self.contas.read_text(encoding="utf-8"))

    def put_contas(self, **campos):
        return self.client.put("/api/config/local/contas", json=campos)

    def put_assistente(self, **campos):
        return self.client.put("/api/config/local/assistente", json=campos)


class RotasContasTests(ConfiguracaoBase):
    def test_valores_invalidos_dao_422_sem_ecoar_o_valor_e_sem_gravar(self):
        invalidos = (
            {"conta_simpress": "sem-arroba-nenhum"},
            {"conta_sebrae": "nome@semponto"},
            {"conta_simpress": "dois@@exemplo.invalid"},
            {"usuario_endpoint": "dominio\\usuario"},
            {"usuario_endpoint": "usuario@exemplo.invalid"},
            {"usuario_endpoint": "com espaco"},
            {"links": {"dashboard_pasta_url": "http://exemplo.invalid/pasta"}},
            {"links": {"dashboard_pasta_url": "https:///sem-host"}},
            {"links": {"dashboard_pasta_url": "https://exemplo.invalid/com espaco"}},
            {"links": {"chave_desconhecida": LINK}},
        )
        for campos in invalidos:
            with self.subTest(campos=str(campos)):
                resposta = self.put_contas(**campos)
                self.assertEqual(resposta.status_code, 422, resposta.text)
                for valor in (*campos.values(), *(campos["links"].values() if "links" in campos else ())):
                    if isinstance(valor, str):
                        self.assertNotIn(valor, resposta.text)
        self.assertFalse(self.contas.exists())

    def test_um_grupo_grava_varias_chaves_e_o_get_devolve_o_resultado(self):
        resposta = self.put_contas(
            conta_simpress="pessoa@exemplo.invalid", conta_sebrae="outra@exemplo.invalid",
            usuario_endpoint="nome.usuario", usar_no_outlook_simpress=True, usar_no_outlook_sebrae=False,
            links={"dashboard_pasta_url": LINK},
        )
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual(self.contas_gravadas(), {
            "dashboard_email": "pessoa@exemplo.invalid", "outlook_email_simpress": "pessoa@exemplo.invalid",
            "softexpert_email": "outra@exemplo.invalid",
            "endpoint_usuario": "nome.usuario",
            "dashboard_pasta_url": LINK,
        })
        corpo = resposta.json()
        self.assertEqual(corpo, self.client.get("/api/config/local").json())
        por_id = {conta["id"]: conta for conta in corpo["contas"]}
        self.assertEqual(por_id["conta_simpress"]["valor"], "pessoa@exemplo.invalid")
        self.assertEqual(por_id["conta_simpress"]["fonte"], "arquivo")
        self.assertIs(por_id["conta_simpress"]["usar_no_outlook"], True)
        self.assertIs(por_id["conta_sebrae"]["usar_no_outlook"], False)
        self.assertIsNone(por_id["usuario_endpoint"]["usar_no_outlook"])
        self.assertEqual(corpo["links"][0]["valor"], LINK)
        self.assertEqual(corpo["status"]["state"], "ready")

    def test_campos_do_get_tem_os_nomes_do_contrato(self):
        corpo = self.client.get("/api/config/local").json()
        self.assertEqual(set(corpo), {"status", "contas", "links", "contas_arquivo_invalido", "cliente", "assistente"})
        self.assertEqual(set(corpo["status"]), {"state", "faltando", "reason", "assistente_ia"})
        self.assertEqual(
            {campo for conta in corpo["contas"] for campo in conta},
            {"id", "rotulo", "placeholder", "usado_para", "ajuda", "tipo", "valor", "fonte", "somente_leitura",
             "usar_no_outlook", "valido"},
        )
        self.assertEqual(
            set(corpo["links"][0]),
            {"chave", "rotulo", "placeholder", "usado_para", "ajuda", "obrigatorio", "valor", "fonte",
             "somente_leitura", "valido"},
        )
        self.assertEqual(set(corpo["cliente"]), {"configurado", "arquivo_invalido", "valido"})
        self.assertEqual(set(corpo["assistente"]), {"openrouter", "deepseek"})
        self.assertEqual(set(corpo["assistente"]["openrouter"]), {"configurada", "final", "fonte"})
        self.assertEqual(
            [conta["id"] for conta in corpo["contas"]], ["conta_simpress", "conta_sebrae", "usuario_endpoint"],
        )
        self.assertNotIn("contrato", json.dumps(corpo["cliente"]))

    def test_variavel_de_ambiente_deixa_o_campo_somente_leitura_e_nao_e_gravada(self):
        os.environ["SIMPRESS_SOFTEXPERT_EMAIL"] = "ambiente@exemplo.invalid"
        corpo = self.client.get("/api/config/local").json()
        sebrae = next(conta for conta in corpo["contas"] if conta["id"] == "conta_sebrae")
        self.assertEqual((sebrae["valor"], sebrae["fonte"], sebrae["somente_leitura"]), ("ambiente@exemplo.invalid", "ambiente", True))

        resposta = self.put_contas(conta_sebrae="arquivo@exemplo.invalid")
        self.assertEqual(resposta.status_code, 200, resposta.text)
        gravado = self.contas_gravadas()
        self.assertNotIn("softexpert_email", gravado)
        self.assertEqual(gravado["outlook_email_sebrae"], "arquivo@exemplo.invalid")
        sebrae = next(conta for conta in resposta.json()["contas"] if conta["id"] == "conta_sebrae")
        self.assertEqual(sebrae["valor"], "ambiente@exemplo.invalid")

    def test_desmarcar_o_outlook_com_o_campo_em_branco_remove_so_o_espelho_e_marcar_volta_a_gravar(self):
        self.put_contas(conta_simpress="pessoa@exemplo.invalid", usar_no_outlook_simpress=True)
        resposta = self.put_contas(conta_simpress="", usar_no_outlook_simpress=False)
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual(self.contas_gravadas(), {"dashboard_email": "pessoa@exemplo.invalid"})
        self.assertIs(resposta.json()["contas"][0]["usar_no_outlook"], False)

        resposta = self.put_contas(conta_simpress="", usar_no_outlook_simpress=True)
        self.assertEqual(
            self.contas_gravadas(),
            {"dashboard_email": "pessoa@exemplo.invalid", "outlook_email_simpress": "pessoa@exemplo.invalid"},
        )
        self.assertIs(resposta.json()["contas"][0]["usar_no_outlook"], True)

    def test_desmarcar_o_outlook_com_conta_nova_tambem_remove_o_espelho_antigo(self):
        self.put_contas(conta_sebrae="velha@exemplo.invalid")
        self.put_contas(conta_sebrae="nova@exemplo.invalid", usar_no_outlook_sebrae=False)
        self.assertEqual(self.contas_gravadas(), {"softexpert_email": "nova@exemplo.invalid"})

    def test_email_do_outlook_diferente_da_conta_so_muda_com_pedido_explicito_de_marcar(self):
        self.contas.parent.mkdir(parents=True, exist_ok=True)
        inicial = {"dashboard_email": "conta@exemplo.invalid", "outlook_email_simpress": "envio@exemplo.invalid"}
        self.contas.write_text(json.dumps(inicial), encoding="utf-8")
        for corpo in ({}, {"usar_no_outlook_simpress": False}, {"conta_simpress": "", "usar_no_outlook_sebrae": True}):
            with self.subTest(corpo=str(corpo)):
                self.assertEqual(self.put_contas(**corpo).status_code, 200)
                self.assertEqual(self.contas_gravadas(), inicial)
        self.assertFalse(self.backups.exists())
        self.put_contas(usar_no_outlook_simpress=True)
        self.assertEqual(self.contas_gravadas()["outlook_email_simpress"], "conta@exemplo.invalid")

    def test_caixa_do_outlook_ausente_com_o_campo_em_branco_nao_cria_espelho(self):
        self.put_contas(conta_simpress="pessoa@exemplo.invalid", usar_no_outlook_simpress=False)
        self.put_contas(usuario_endpoint="nome.usuario")
        self.assertEqual(self.contas_gravadas(), {"dashboard_email": "pessoa@exemplo.invalid", "endpoint_usuario": "nome.usuario"})

    def test_outlook_vindo_de_variavel_de_ambiente_nao_e_tocado_ao_desmarcar(self):
        os.environ["SIMPRESS_OUTLOOK_EMAIL_SIMPRESS"] = "ambiente@exemplo.invalid"
        self.put_contas(conta_simpress="pessoa@exemplo.invalid", usar_no_outlook_simpress=True)
        self.put_contas(conta_simpress="", usar_no_outlook_simpress=False)
        self.assertEqual(self.contas_gravadas(), {"dashboard_email": "pessoa@exemplo.invalid"})

    def test_campo_em_branco_mantem_o_valor_e_nao_regrava_nem_faz_backup(self):
        self.put_contas(conta_simpress="pessoa@exemplo.invalid", usuario_endpoint="nome.usuario")
        antes = self.contas.read_bytes()
        resposta = self.put_contas(conta_simpress="", usuario_endpoint="   ")
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual(self.contas.read_bytes(), antes)
        self.assertFalse(self.backups.exists())
        self.assertEqual(resposta.json()["contas"][0]["valor"], "pessoa@exemplo.invalid")

    def test_chaves_desconhecidas_do_arquivo_sao_preservadas(self):
        self.contas.parent.mkdir(parents=True, exist_ok=True)
        self.contas.write_text(json.dumps({"campo_futuro": "valor", "dashboard_email": "velho@exemplo.invalid"}), encoding="utf-8")
        self.put_contas(conta_simpress="novo@exemplo.invalid", usar_no_outlook_simpress=False)
        self.assertEqual(self.contas_gravadas(), {"campo_futuro": "valor", "dashboard_email": "novo@exemplo.invalid"})

    def test_arquivo_de_contas_ilegivel_aparece_como_invalido_sem_derrubar_o_get(self):
        self.contas.parent.mkdir(parents=True, exist_ok=True)
        self.contas.write_text("{ nao e json", encoding="utf-8")
        corpo = self.client.get("/api/config/local").json()
        self.assertTrue(corpo["contas_arquivo_invalido"])
        self.assertEqual(corpo["status"]["state"], "invalid")
        self.assertIn("contas_automacao.json", corpo["status"]["reason"])

    def test_falha_de_gravacao_vira_500_sem_vazar_valor_nem_ir_ao_log(self):
        with (
            patch("domains.configuracao_local.atomic_write_json", side_effect=OSError(f"disco cheio {CHAVE_OPENROUTER}")),
            self.assertLogs(level="DEBUG") as capturado,
        ):
            resposta = self.put_contas(conta_simpress="pessoa@exemplo.invalid")
        self.assertEqual(resposta.status_code, 500)
        self.assertEqual(resposta.json()["detail"], "Não foi possível gravar a configuração local.")
        registros = "\n".join(capturado.output)
        self.assertNotIn(CHAVE_OPENROUTER, registros + resposta.text)
        self.assertNotIn("pessoa@exemplo.invalid", registros + resposta.text)


class RotasAssistenteTests(ConfiguracaoBase):
    def test_a_chave_nunca_volta_na_resposta_nem_vai_ao_log(self):
        with self.assertLogs(level="DEBUG") as capturado:
            gravar = self.put_assistente(openrouter_api_key=CHAVE_OPENROUTER)
            ler = self.client.get("/api/config/local")
            recusada = self.put_assistente(deepseek_api_key="com espaco")
        self.assertEqual(gravar.status_code, 200, gravar.text)
        self.assertEqual(recusada.status_code, 422)
        self.assertEqual(
            gravar.json()["openrouter"], {"configurada": True, "final": "…WXYZ", "fonte": "arquivo"},
        )
        self.assertEqual(gravar.json()["deepseek"], {"configurada": False, "final": "", "fonte": ""})
        self.assertEqual(ler.json()["assistente"], gravar.json())
        for texto in (gravar.text, ler.text, recusada.text, "\n".join(capturado.output)):
            self.assertNotIn(CHAVE_OPENROUTER, texto)
            self.assertNotIn("com espaco", texto)
        self.assertIn(f"OPENROUTER_API_KEY={CHAVE_OPENROUTER}", self.env.read_text(encoding="utf-8"))

    def test_chave_invalida_da_422(self):
        for chave in ("tem espaco", "tem=igual", "tem#cardinal", "tem\nquebra", "x" * 201):
            with self.subTest(chave=chave[:12]):
                self.assertEqual(self.put_assistente(openrouter_api_key=chave).status_code, 422)
        self.assertFalse(self.env.exists())

    def test_em_branco_ou_ausente_mantem_a_chave_atual(self):
        self.put_assistente(openrouter_api_key=CHAVE_OPENROUTER)
        antes = self.env.read_bytes()
        for corpo in ({}, {"openrouter_api_key": ""}, {"openrouter_api_key": "   ", "deepseek_api_key": None}):
            with self.subTest(corpo=str(corpo)):
                resposta = self.put_assistente(**corpo)
                self.assertEqual(resposta.status_code, 200, resposta.text)
                self.assertTrue(resposta.json()["openrouter"]["configurada"])
                self.assertEqual(self.env.read_bytes(), antes)
        self.assertFalse(self.backups.exists())

    def test_remover_apaga_so_a_linha_da_chave_e_preserva_o_resto(self):
        self.env.write_text(
            f"# comentário\nOUTRA=1\nOPENROUTER_API_KEY={CHAVE_OPENROUTER}\nDEEPSEEK_API_KEY={CHAVE_DEEPSEEK}\n",
            encoding="utf-8",
        )
        resposta = self.client.delete("/api/config/local/assistente/openrouter")
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual(resposta.json()["openrouter"], {"configurada": False, "final": "", "fonte": ""})
        self.assertTrue(resposta.json()["deepseek"]["configurada"])
        self.assertEqual(self.env.read_text(encoding="utf-8"), f"# comentário\nOUTRA=1\nDEEPSEEK_API_KEY={CHAVE_DEEPSEEK}\n")

    def test_remover_nao_faz_backup_para_nao_guardar_a_chave_removida(self):
        self.env.write_text(f"OUTRA=1\nOPENROUTER_API_KEY={CHAVE_OPENROUTER}\n", encoding="utf-8")
        resposta = self.client.delete("/api/config/local/assistente/openrouter")
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertFalse(self.backups.exists())

    def test_gravar_continua_com_backup_e_remover_nao_acrescenta_outro(self):
        self.env.write_text("OUTRA=1\n", encoding="utf-8")
        self.put_assistente(deepseek_api_key=CHAVE_DEEPSEEK)
        (copia,) = self.backups.glob(".env.*.bak")
        self.assertEqual(self.client.delete("/api/config/local/assistente/deepseek").status_code, 200)
        self.assertEqual(list(self.backups.glob(".env.*.bak")), [copia])
        self.assertNotIn("DEEPSEEK", self.env.read_text(encoding="utf-8"))

    def test_chave_vinda_de_variavel_de_ambiente_recusa_gravar_e_remover_sem_alterar_nada(self):
        os.environ["OPENROUTER_API_KEY"] = CHAVE_OPENROUTER
        original = "OUTRA=1\nOPENROUTER_API_KEY=chave-ficticia-do-arquivo\n"
        self.env.write_text(original, encoding="utf-8")
        gravar = self.put_assistente(openrouter_api_key="chave-ficticia-nova-9999")
        ambos = self.put_assistente(openrouter_api_key="chave-ficticia-nova-8888", deepseek_api_key=CHAVE_DEEPSEEK)
        remover = self.client.delete("/api/config/local/assistente/openrouter")
        for resposta in (gravar, ambos, remover):
            self.assertEqual(resposta.status_code, 422, resposta.text)
            self.assertIn("variável de ambiente", resposta.json()["detail"])
            for segredo in (CHAVE_OPENROUTER, CHAVE_DEEPSEEK, "chave-ficticia-nova"):
                self.assertNotIn(segredo, resposta.text)
        self.assertEqual(self.env.read_text(encoding="utf-8"), original, "nem a chave do outro provedor foi gravada")
        self.assertFalse(self.backups.exists())

    def test_so_a_chave_do_ambiente_e_recusada_a_outra_continua_gravavel_e_removivel(self):
        os.environ["OPENROUTER_API_KEY"] = CHAVE_OPENROUTER
        self.assertEqual(self.put_assistente(deepseek_api_key=CHAVE_DEEPSEEK).status_code, 200)
        self.assertEqual(self.client.delete("/api/config/local/assistente/deepseek").status_code, 200)
        self.assertNotIn("DEEPSEEK", self.env.read_text(encoding="utf-8"))

    def test_remover_chave_desconhecida_da_404_e_sem_arquivo_nada_e_criado(self):
        self.assertEqual(self.client.delete("/api/config/local/assistente/outra").status_code, 404)
        resposta = self.client.delete("/api/config/local/assistente/deepseek")
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertFalse(self.env.exists())

    def test_o_arquivo_de_chaves_preserva_comentarios_outras_linhas_e_quebras_crlf(self):
        original = (
            "# Chaves locais\r\n\r\nOUTRA=valor\r\n# OPENROUTER_API_KEY=comentada-fica-igual\r\n"
            "OPENROUTER_API_KEY=antiga\r\nFINAL=sem-quebra"
        )
        self.env.write_bytes(original.encode("utf-8"))
        resposta = self.put_assistente(openrouter_api_key=CHAVE_OPENROUTER, deepseek_api_key=CHAVE_DEEPSEEK)
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual(
            self.env.read_bytes().decode("utf-8"),
            "# Chaves locais\r\n\r\nOUTRA=valor\r\n# OPENROUTER_API_KEY=comentada-fica-igual\r\n"
            f"OPENROUTER_API_KEY={CHAVE_OPENROUTER}\r\nFINAL=sem-quebra\r\nDEEPSEEK_API_KEY={CHAVE_DEEPSEEK}\r\n",
        )

    def test_o_texto_de_exemplo_conta_como_nao_configurada(self):
        self.env.write_text(f"OPENROUTER_API_KEY={configuracao.PLACEHOLDER_KEY_PREFIX}-sua-chave\n", encoding="utf-8")
        self.assertEqual(
            self.client.get("/api/config/local").json()["assistente"]["openrouter"],
            {"configurada": False, "final": "", "fonte": ""},
        )

    def test_variavel_de_ambiente_aparece_como_fonte_e_chave_curta_so_mostra_reticencias(self):
        os.environ["DEEPSEEK_API_KEY"] = "chave-curta"
        assistente = self.client.get("/api/config/local").json()["assistente"]
        self.assertEqual(assistente["deepseek"], {"configurada": True, "final": "…", "fonte": "ambiente"})

    def test_arquivo_de_chaves_grande_demais_ou_fora_de_utf8_e_recusado_sem_alterar(self):
        for conteudo in (b"#" * (configuracao.MAX_ENV_FILE_BYTES + 1), b"\xff\xfe\x00chave"):
            with self.subTest(tamanho=len(conteudo)):
                self.env.write_bytes(conteudo)
                resposta = self.put_assistente(openrouter_api_key=CHAVE_OPENROUTER)
                self.assertEqual(resposta.status_code, 422, resposta.text)
                self.assertEqual(self.env.read_bytes(), conteudo)
                self.assertNotIn(CHAVE_OPENROUTER, resposta.text)


class BackupTests(ConfiguracaoBase):
    def test_backup_com_rotacao_mantem_os_cinco_mais_recentes_mesmo_no_mesmo_segundo(self):
        instante = datetime(2026, 11, 14, 10, 0, 0)  # relógio parado: os nomes avançam 1 s sozinhos
        for numero in range(1, 9):
            configuracao.gravar_contas(
                self.contas, self.backups, {"conta_simpress": f"u{numero}@exemplo.invalid"}, {}, {"conta_simpress": False},
                ambiente={}, agora=lambda: instante,
            )
            if numero == 1:
                self.assertFalse(self.backups.exists(), "sem arquivo anterior não há o que copiar")
        copias = sorted(self.backups.glob("contas_automacao.json.*.bak"))
        self.assertEqual(len(copias), configuracao.BACKUPS_MANTIDOS)
        self.assertEqual(
            [json.loads(copia.read_text(encoding="utf-8"))["dashboard_email"] for copia in copias],
            [f"u{numero}@exemplo.invalid" for numero in range(3, 8)],
        )
        self.assertEqual(self.contas_gravadas()["dashboard_email"], "u8@exemplo.invalid")
        self.assertRegex(copias[0].name, r"^contas_automacao\.json\.\d{8}-\d{6}\.bak$")

    def test_backup_do_arquivo_de_chaves_usa_o_mesmo_padrao_de_nome(self):
        self.env.write_text("OUTRA=1\n", encoding="utf-8")
        configuracao.gravar_assistente(
            self.env, self.backups, {"openrouter": CHAVE_OPENROUTER}, agora=lambda: datetime(2026, 11, 14, 10, 0, 0),
        )
        (copia,) = self.backups.glob(".env.*.bak")
        self.assertEqual(copia.name, ".env.20261114-100000.bak")
        self.assertEqual(copia.read_text(encoding="utf-8"), "OUTRA=1\n")

    def test_backup_nao_apaga_o_mais_novo_quando_o_relogio_volta(self):
        base = datetime(2026, 11, 14, 10, 0, 0)
        relogios = [base + timedelta(minutes=5)] * 2 + [base] * 6  # relógio atrasou depois dos primeiros backups
        for numero, relogio in enumerate(relogios, start=1):
            configuracao.gravar_contas(
                self.contas, self.backups, {"conta_simpress": f"u{numero}@exemplo.invalid"}, {}, {"conta_simpress": False},
                ambiente={}, agora=lambda relogio=relogio: relogio,
            )
        ultimo = sorted(self.backups.glob("contas_automacao.json.*.bak"))[-1]
        self.assertEqual(json.loads(ultimo.read_text(encoding="utf-8"))["dashboard_email"], "u7@exemplo.invalid")


class StatusTests(ConfiguracaoBase):
    def status(self) -> dict:
        return configuracao.status_configuracao(self.contas, self.cliente, self.env, {})

    def test_pendente_lista_so_identificadores_e_nunca_valores(self):
        self.cliente.unlink()
        estado = self.status()
        self.assertEqual(estado["state"], "pending")
        self.assertEqual(
            estado["faltando"],
            ["conta_simpress", "conta_sebrae", "usuario_endpoint", "dashboard_pasta_url", "dados_cliente"],
        )
        self.assertTrue(estado["reason"].startswith("Falta: "))
        self.assertIs(estado["assistente_ia"], False)

    def test_a_lista_diminui_conforme_cada_item_e_configurado_ate_ficar_pronto(self):
        configuracao.gravar_contas(
            self.contas, self.backups, {"conta_simpress": "pessoa@exemplo.invalid"}, {}, {}, ambiente={},
        )
        self.assertEqual(self.status()["faltando"], ["conta_sebrae", "usuario_endpoint", "dashboard_pasta_url"])
        configuracao.gravar_contas(
            self.contas, self.backups,
            {"conta_sebrae": "outra@exemplo.invalid", "usuario_endpoint": "nome.usuario"},
            {"dashboard_pasta_url": LINK}, {}, ambiente={},
        )
        self.assertEqual(self.status(), {"state": "ready", "faltando": [], "reason": "", "assistente_ia": False})

    def test_a_chave_de_ia_nunca_deixa_o_estado_pendente_mas_aparece_no_status(self):
        configuracao.gravar_assistente(self.env, self.backups, {"openrouter": CHAVE_OPENROUTER})
        estado = self.status()
        self.assertEqual(estado["state"], "pending")
        self.assertIs(estado["assistente_ia"], True)

    def test_valor_recusado_e_arquivo_ilegivel_dao_invalido_com_prioridade_sobre_pendente(self):
        self.contas.parent.mkdir(parents=True, exist_ok=True)
        self.contas.write_text(json.dumps({"dashboard_email": "sem-arroba"}), encoding="utf-8")
        estado = self.status()
        self.assertEqual(estado["state"], "invalid")
        self.assertEqual(estado["faltando"], [])
        self.assertNotIn("sem-arroba", estado["reason"])
        self.assertIn("Conta Simpress", estado["reason"])
        self.cliente.write_text("{ nao e json", encoding="utf-8")
        self.contas.write_text("{}", encoding="utf-8")
        self.assertIn("cliente.json", self.status()["reason"])

    def test_cnpj_com_digito_verificador_errado_no_arquivo_do_cliente_e_invalido(self):
        self.cliente.write_text(json.dumps({**CLIENTE_VALIDO, "cnpj_faturamento": "11.222.333/0001-82"}), encoding="utf-8")
        estado = self.status()
        self.assertEqual(estado["state"], "invalid")
        self.assertIn("Dados do cliente", estado["reason"])

    def test_o_servico_de_prontidao_usa_os_arquivos_da_configuracao_local(self):
        arquivos = (self.contas, self.cliente, self.env)
        with patch.object(main, "_configuracao_local_files", return_value=arquivos):
            self.assertEqual(
                main._readiness_services.configuracao_local()["faltando"],
                ["conta_simpress", "conta_sebrae", "usuario_endpoint", "dashboard_pasta_url"],
            )
            antes = main._readiness_signature()
            configuracao.gravar_contas(
                self.contas, self.backups, {"conta_simpress": "pessoa@exemplo.invalid"}, {}, {}, ambiente={},
            )
            self.assertNotEqual(main._readiness_signature(), antes)
            self.assertEqual(main._readiness_services.configuracao_local()["faltando"][0], "conta_sebrae")


class CnpjTests(unittest.TestCase):
    def test_digitos_verificadores(self):
        for valido in ("11.222.333/0001-81", "44.555.666/0001-81", "00.000.000/0001-91"):
            with self.subTest(valido=valido):
                self.assertTrue(cnpj_valido(valido))
        for invalido in ("11.222.333/0001-82", "44.555.666/0001-72", "11.111.111/1111-11", "11222333000181", "", "1.2.3"):
            with self.subTest(invalido=invalido):
                self.assertFalse(cnpj_valido(invalido))


class SessaoLocalTests(unittest.TestCase):
    """As rotas novas ficam atrás do cookie de sessão como todo /api/*."""

    def setUp(self):
        self.client = TestClient(main.app, base_url=f"http://127.0.0.1:{main.SERVER_PORT}", client=("127.0.0.1", 1234))
        self.addCleanup(self.client.close)

    def test_sem_o_cookie_todas_as_rotas_respondem_401_e_nada_e_gravado(self):
        self.assertNotIn(sessao_local.nome_cookie(main.SERVER_PORT), self.client.cookies)
        pedidos = (
            ("GET", "/api/config/local", None),
            ("PUT", "/api/config/local/contas", {"conta_simpress": "pessoa@exemplo.invalid"}),
            ("PUT", "/api/config/local/assistente", {"openrouter_api_key": CHAVE_OPENROUTER}),
            ("DELETE", "/api/config/local/assistente/openrouter", None),
        )
        with patch("domains.configuracao_local.atomic_write_json") as json_gravado, \
                patch("domains.configuracao_local.atomic_write_bytes") as bytes_gravados:
            for metodo, caminho, corpo in pedidos:
                with self.subTest(metodo=metodo, caminho=caminho):
                    resposta = self.client.request(metodo, caminho, json=corpo)
                    self.assertEqual(resposta.status_code, 401, resposta.text)
                    self.assertNotIn(CHAVE_OPENROUTER, resposta.text)
        json_gravado.assert_not_called()
        bytes_gravados.assert_not_called()


if __name__ == "__main__":
    unittest.main()
