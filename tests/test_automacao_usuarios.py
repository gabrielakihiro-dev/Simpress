"""Testes unitários da rotina de verificação de usuários no Endpoint Central.

Cobre:
- Escolha do usuário (filtro de contas internas, primeira linha válida, NA/N/A/--, domínio)
- Tabela de decisão (usuario_ausente e substituicao_manual)
- Série MacBook (com e sem "S" inicial)
- Tratamento de 409 (pendência desatualizada)
- Formatação de anotação
- Grade ember-table do Endpoint (colunas pela posição, confirmação do filtro, pesquisa)
- Anotação na linha do histórico e fluxo da rotina com Playwright mockado
"""

from __future__ import annotations

import io
import json
import unittest
from contextlib import redirect_stdout
from datetime import datetime
from unittest.mock import MagicMock, patch

from scripts import automacao_rotinas_chrome as automacao_real
from scripts.verificar_usuarios_endpoint import (
    aplicar_filtro,
    avaliar_decisao,
    colunas_grade,
    decidir_pendencia,
    eh_conta_interna,
    eh_vazio_ou_na,
    escolher_usuario_lista,
    escolher_usuario_sistema,
    filtro_da_coluna,
    formatar_anotacao,
    gravar_anotacao_linha,
    linhas_grade,
    localizar_linha_anotacao,
    normalizar_usuario,
    pesquisar_computador_endpoint,
    tratar_serie_macbook,
    usuarios_iguais,
    verificar_usuarios_endpoint,
)


class EscolhaUsuarioTests(unittest.TestCase):
    def test_normalizar_usuario_remove_dominio_e_espacos(self):
        self.assertEqual(normalizar_usuario(r"PR-SEBRAE\jteste"), "jteste")
        self.assertEqual(normalizar_usuario("sebrae/jsilva"), "jsilva")
        self.assertEqual(normalizar_usuario("maria@sebraepr.com.br"), "maria")
        self.assertEqual(normalizar_usuario("  JoaoSilva  "), "joaosilva")
        self.assertEqual(normalizar_usuario(""), "")
        self.assertEqual(normalizar_usuario(None), "")

    def test_usuarios_iguais_ignora_maiusculas_e_dominio(self):
        self.assertTrue(usuarios_iguais(r"PR-SEBRAE\jteste", "jteste"))
        self.assertTrue(usuarios_iguais("JTESTE", "jteste"))
        self.assertTrue(usuarios_iguais(r"PR-SEBRAE\MTeste", "mteste"))
        self.assertFalse(usuarios_iguais("usuario1", "usuario2"))
        self.assertFalse(usuarios_iguais("", "usuario"))
        self.assertFalse(usuarios_iguais(None, None))

    def test_eh_vazio_ou_na_reconhece_variacoes_de_vazio(self):
        self.assertTrue(eh_vazio_ou_na(""))
        self.assertTrue(eh_vazio_ou_na(None))
        self.assertTrue(eh_vazio_ou_na("   "))
        self.assertTrue(eh_vazio_ou_na("NA"))
        self.assertTrue(eh_vazio_ou_na("N/A"))
        self.assertTrue(eh_vazio_ou_na("n/a"))
        self.assertTrue(eh_vazio_ou_na("--"))
        self.assertTrue(eh_vazio_ou_na("-"))
        self.assertFalse(eh_vazio_ou_na("jteste"))

    def test_eh_conta_interna_ignora_contas_padrao(self):
        self.assertTrue(eh_conta_interna("Administrador"))
        self.assertTrue(eh_conta_interna(r"PR-SEBRAE\ADMINISTRADOR"))
        self.assertTrue(eh_conta_interna("administrator"))
        self.assertTrue(eh_conta_interna("Convidado"))
        self.assertTrue(eh_conta_interna("guest"))
        self.assertTrue(eh_conta_interna("DefaultAccount"))
        self.assertTrue(eh_conta_interna("WDAGUtilityAccount"))
        self.assertTrue(eh_conta_interna("wdagutilityaccount"))
        self.assertFalse(eh_conta_interna("jteste"))
        self.assertFalse(eh_conta_interna("usuario_comum"))

    def test_escolher_usuario_sistema_pega_primeira_linha_valida(self):
        linhas = ["Administrador", "DefaultAccount", "jteste", "Convidado", "outro_usuario"]
        self.assertEqual(escolher_usuario_sistema(linhas), "jteste")

    def test_escolher_usuario_sistema_ignora_na_e_vazios(self):
        linhas = ["", "N/A", "WDAGUtilityAccount", "  ", "--", "jsilva"]
        self.assertEqual(escolher_usuario_sistema(linhas), "jsilva")

    def test_escolher_usuario_sistema_retorna_none_se_so_houver_contas_internas_ou_vazios(self):
        linhas = ["Administrador", "Convidado", "DefaultAccount", "N/A", "--"]
        self.assertIsNone(escolher_usuario_sistema(linhas))
        self.assertIsNone(escolher_usuario_sistema([]))


class SerieMacbookTests(unittest.TestCase):
    def test_remove_s_inicial_quando_presente(self):
        self.assertEqual(tratar_serie_macbook("SCMVXKV7YCM"), "CMVXKV7YCM")
        self.assertEqual(tratar_serie_macbook("s12345"), "12345")

    def test_retorna_none_quando_nao_comeca_com_s(self):
        self.assertIsNone(tratar_serie_macbook("BRJ0000TST"))
        self.assertIsNone(tratar_serie_macbook("CMVXKV7YCM"))
        self.assertIsNone(tratar_serie_macbook("S"))
        self.assertIsNone(tratar_serie_macbook(""))


class TabelaDecisaoTests(unittest.TestCase):
    def test_usuario_ausente_mesmo_usuario_encontrado_decide_manter(self):
        r = avaliar_decisao(
            tipo="usuario_ausente",
            usuario_pendencia="jteste",
            usuario_encontrado=r"PR-SEBRAE\jteste",
            computador_achado=True,
            ambiguo=False,
            fonte="lista",
        )
        self.assertTrue(r.decidir)
        self.assertEqual(r.decisao, "manter")
        self.assertFalse(r.aviso)
        self.assertEqual(r.status_resumo, "mantidos")
        self.assertIn("mesmo usuário confirmado", r.anotacao_decisao)

    def test_usuario_ausente_outro_usuario_valido_deixa_pendente_com_anotacao(self):
        r = avaliar_decisao(
            tipo="usuario_ausente",
            usuario_pendencia="jteste",
            usuario_encontrado="jcosta",
            computador_achado=True,
            ambiguo=False,
            fonte="lista",
        )
        self.assertFalse(r.decidir)
        self.assertEqual(r.decisao, "")
        self.assertFalse(r.aviso)
        self.assertEqual(r.status_resumo, "pendentes")
        self.assertIn("Endpoint mostra jcosta (lista)", r.anotacao_decisao)

    def test_usuario_ausente_computador_sem_usuario_valido_decide_remover_com_aviso(self):
        r = avaliar_decisao(
            tipo="usuario_ausente",
            usuario_pendencia="jteste",
            usuario_encontrado=None,
            computador_achado=True,
            ambiguo=False,
        )
        self.assertTrue(r.decidir)
        self.assertEqual(r.decisao, "remover")
        self.assertTrue(r.aviso)
        self.assertEqual(r.motivo_aviso, "sem usuário válido")
        self.assertEqual(r.status_resumo, "removidos")

    def test_usuario_ausente_computador_nao_encontrado_decide_remover_com_aviso(self):
        r = avaliar_decisao(
            tipo="usuario_ausente",
            usuario_pendencia="jteste",
            usuario_encontrado=None,
            computador_achado=False,
            ambiguo=False,
        )
        self.assertTrue(r.decidir)
        self.assertEqual(r.decisao, "remover")
        self.assertTrue(r.aviso)
        self.assertEqual(r.motivo_aviso, "computador não encontrado")
        self.assertEqual(r.status_resumo, "removidos")

    def test_substituicao_manual_usuario_novo_confirmado_decide_permitir(self):
        r = avaliar_decisao(
            tipo="substituicao_manual",
            usuario_pendencia="jsilva",
            usuario_encontrado=r"PR-SEBRAE\jsilva",
            computador_achado=True,
            ambiguo=False,
            fonte="Sistema",
        )
        self.assertTrue(r.decidir)
        self.assertEqual(r.decisao, "permitir")
        self.assertFalse(r.aviso)
        self.assertEqual(r.status_resumo, "mantidos")
        self.assertIn("usuário novo confirmado", r.anotacao_decisao)

    def test_substituicao_manual_outro_usuario_deixa_pendente(self):
        r = avaliar_decisao(
            tipo="substituicao_manual",
            usuario_pendencia="jsilva",
            usuario_encontrado="mrocha",
            computador_achado=True,
            ambiguo=False,
            fonte="Sistema",
        )
        self.assertFalse(r.decidir)
        self.assertEqual(r.decisao, "")
        self.assertFalse(r.aviso)
        self.assertEqual(r.status_resumo, "pendentes")
        self.assertIn("Endpoint mostra mrocha (Sistema)", r.anotacao_decisao)

    def test_substituicao_manual_sem_usuario_decide_recusar_com_aviso(self):
        r = avaliar_decisao(
            tipo="substituicao_manual",
            usuario_pendencia="jsilva",
            usuario_encontrado=None,
            computador_achado=True,
            ambiguo=False,
        )
        self.assertTrue(r.decidir)
        self.assertEqual(r.decisao, "recusar")
        self.assertTrue(r.aviso)
        self.assertEqual(r.motivo_aviso, "sem usuário válido")
        self.assertEqual(r.status_resumo, "removidos")

    def test_substituicao_manual_computador_nao_encontrado_decide_recusar_com_aviso(self):
        r = avaliar_decisao(
            tipo="substituicao_manual",
            usuario_pendencia="jsilva",
            usuario_encontrado=None,
            computador_achado=False,
            ambiguo=False,
        )
        self.assertTrue(r.decidir)
        self.assertEqual(r.decisao, "recusar")
        self.assertTrue(r.aviso)
        self.assertEqual(r.motivo_aviso, "computador não encontrado")
        self.assertEqual(r.status_resumo, "removidos")

    def test_resultado_ambiguo_deixa_pendente_sem_decidir(self):
        r = avaliar_decisao(
            tipo="usuario_ausente",
            usuario_pendencia="jteste",
            usuario_encontrado=None,
            computador_achado=True,
            ambiguo=True,
        )
        self.assertFalse(r.decidir)
        self.assertEqual(r.decisao, "")
        self.assertFalse(r.aviso)
        self.assertEqual(r.status_resumo, "ambiguos")
        self.assertIn("ambíguo", r.anotacao_decisao)


class AnotacaoFormatacaoTests(unittest.TestCase):
    def test_formatar_anotacao_contem_todos_os_campos_obrigatorios(self):
        agora = datetime(2026, 10, 21, 15, 30)
        texto = formatar_anotacao(
            agora=agora,
            serie="BRJ0000TST",
            hostname="PRNOTETST001",
            filtro="série",
            fonte="lista",
            usuario_lido="jteste",
            decisao="manter",
        )
        self.assertIn("21/10/2026 15:30", texto)
        self.assertIn("Série: BRJ0000TST", texto)
        self.assertIn("Hostname: PRNOTETST001", texto)
        self.assertIn("Filtro: série", texto)
        self.assertIn("Fonte: lista", texto)
        self.assertIn("Usuário lido: jteste", texto)
        self.assertIn("Decisão: manter", texto)


class Tratamento409Tests(unittest.TestCase):
    def test_decidir_pendencia_captura_409(self):
        import urllib.error

        resposta_falsa = urllib.error.HTTPError(
            url="http://127.0.0.1:8000/api/usuarios/pendencias/123/decidir",
            code=409,
            msg="Conflict",
            hdrs=MagicMock(),
            fp=MagicMock(read=lambda: b'{"detail": "Esta pendencia ja foi decidida."}'),
        )

        with patch("urllib.request.urlopen", side_effect=resposta_falsa):
            sucesso, codigo, detalhe = decidir_pendencia(8000, "123", "manter")
            self.assertFalse(sucesso)
            self.assertEqual(codigo, 409)
            self.assertIn("ja foi decidida", detalhe)


def _grade(linhas, valor_serie="", valor_nome="", carregando=False, vazio=False):
    """Estado da grade como o _JS_GRADE devolve: Nome [0-100], Usuários [100-200], Série [200-300]."""
    return {
        "cabecalhos": [
            {"titulo": "Nome do computador", "x0": 0, "x1": 100},
            {"titulo": "Usuários logados", "x0": 100, "x1": 200},
            {"titulo": "Rótulo de serviço/número de série", "x0": 200, "x1": 300},
        ],
        "filtros": [
            {"id": "filtro-nome", "cx": 50, "valor": valor_nome},
            {"id": "filtro-serie", "cx": 250, "valor": valor_serie},
        ],
        # Duas células vazias (checkbox e editar) antes das colunas, como na grade real.
        "linhas": [[[-40, ""], [-20, ""], [50, nome], [150, usuarios], [250, serie]] for nome, usuarios, serie in linhas],
        "rodape": "0 - 0 de" if vazio else "1 - 1 de",
        "carregando": carregando,
        "vazio": vazio,
    }


class GradeEndpointTests(unittest.TestCase):
    def test_linhas_grade_associa_celulas_pela_posicao_do_cabecalho(self):
        grade = _grade([("PC01", "ana,root", "SER01")])
        self.assertEqual(linhas_grade(grade), [{"nome": "PC01", "usuarios": "ana,root", "serie": "SER01"}])
        self.assertEqual(filtro_da_coluna(grade, colunas_grade(grade)["serie"])["id"], "filtro-serie")

    def test_escolher_usuario_lista_separa_virgulas_e_prefere_o_da_pendencia(self):
        self.assertEqual(escolher_usuario_lista("svcbackup,bruno", "bruno"), "bruno")
        self.assertEqual(escolher_usuario_lista("root, ana", "outro"), "ana")
        self.assertEqual(escolher_usuario_lista(r"PR-SEBRAE\jteste", "jteste"), r"PR-SEBRAE\jteste")
        self.assertIsNone(escolher_usuario_lista("NA", "x"))
        self.assertIsNone(escolher_usuario_lista("--", "x"))
        self.assertIsNone(escolher_usuario_lista("root", "x"))

    def _aplicar(self, estados, valor="SER01"):
        page = MagicMock()
        page.evaluate.side_effect = estados
        automacao = MagicMock(RotinaErro=automacao_real.RotinaErro)
        with patch("scripts.verificar_usuarios_endpoint.ESPERA_FILTRO_MS", 0):
            return aplicar_filtro(page, automacao, "serie", valor), page

    def test_aplicar_filtro_espera_a_grade_bater_com_o_valor(self):
        antes = _grade([("PC09", "x", "SER09")])
        carregando = _grade([("PC09", "x", "SER09")], valor_serie="SER01", carregando=True)
        pronta = _grade([("PC01", "ana", "SER01")], valor_serie="SER01")
        with patch("scripts.verificar_usuarios_endpoint.ESPERA_FILTRO_MS", 10_000):
            page = MagicMock()
            page.evaluate.side_effect = [antes, carregando, antes | {"filtros": pronta["filtros"]}, pronta]
            linhas = aplicar_filtro(page, MagicMock(RotinaErro=automacao_real.RotinaErro), "serie", "SER01")
        self.assertEqual(linhas, [{"nome": "PC01", "usuarios": "ana", "serie": "SER01"}])
        page.locator.assert_called_with("[id='filtro-serie']")
        page.locator.return_value.press.assert_called_once_with("Enter")

    def test_aplicar_filtro_aceita_grade_vazia_confirmada(self):
        linhas, _ = self._aplicar([_grade([("PC09", "x", "SER09")]), _grade([], valor_serie="SER01", vazio=True)])
        self.assertEqual(linhas, [])

    def test_aplicar_filtro_sem_confirmacao_levanta_erro_em_vez_de_nao_encontrado(self):
        # Campo sem o valor digitado: o filtro não aplicou, então nada é decidido.
        with self.assertRaises(automacao_real.RotinaErro):
            self._aplicar([_grade([("PC09", "x", "SER09")]), _grade([], valor_serie="", vazio=True)])

    def test_aplicar_filtro_sem_coluna_levanta_erro(self):
        grade = _grade([])
        grade["filtros"] = []
        with self.assertRaises(automacao_real.RotinaErro):
            self._aplicar([grade])


class PesquisaComputadorTests(unittest.TestCase):
    def _pesquisar(self, respostas, serie, hostname):
        chamadas = []

        def aplicar(page, automacao, chave, valor):
            chamadas.append((chave, valor))
            return respostas.get((chave, valor), []) if valor else [{"nome": "todos"}]

        with patch("scripts.verificar_usuarios_endpoint.aplicar_filtro", side_effect=aplicar):
            return (*pesquisar_computador_endpoint(MagicMock(), MagicMock(), serie, hostname), chamadas)

    def test_encontra_por_serie_e_limpa_o_filtro(self):
        linha = {"nome": "PC01", "usuarios": "u", "serie": "SER01"}
        linhas, filtro, chamadas = self._pesquisar({("serie", "SER01"): [linha]}, "SER01", "PC01")
        self.assertEqual((linhas, filtro), ([linha], "série"))
        self.assertEqual(chamadas, [("serie", "SER01"), ("serie", "")])

    def test_macbook_tenta_sem_s(self):
        linha = {"nome": "MAC", "usuarios": "u", "serie": "CMVXKV7YCM"}
        linhas, filtro, _ = self._pesquisar({("serie", "CMVXKV7YCM"): [linha]}, "SCMVXKV7YCM", "")
        self.assertEqual((linhas, filtro), ([linha], "série (sem S)"))

    def test_recorre_ao_hostname_e_ignora_correspondencia_parcial(self):
        parcial = {"nome": "PC010", "usuarios": "u", "serie": "BRJ010"}
        linha = {"nome": "PC01", "usuarios": "u", "serie": "OUTRA"}
        linhas, filtro, chamadas = self._pesquisar(
            {("serie", "BRJ01"): [parcial], ("nome", "PC01"): [parcial, linha]}, "BRJ01", "PC01",
        )
        self.assertEqual((linhas, filtro), ([linha], "hostname"))
        self.assertEqual(chamadas, [("serie", "BRJ01"), ("serie", ""), ("nome", "PC01"), ("nome", "")])

    def test_nao_encontrado(self):
        linhas, filtro, _ = self._pesquisar({}, "SER01", "PC01")
        self.assertEqual((linhas, filtro), ([], "nenhum"))


class SomenteGradeInicialTests(unittest.TestCase):
    def test_lista_vazia_sem_consultar_sistema_deixa_pendente(self):
        for tipo in ("usuario_ausente", "substituicao_manual"):
            r = avaliar_decisao(tipo, "jsilva", None, computador_achado=True, fonte="lista", sistema_consultado=False)
            self.assertFalse(r.decidir)
            self.assertFalse(r.aviso)
            self.assertEqual(r.status_resumo, "pendentes")
            self.assertIn("Sistema > Usuários não consultado", r.anotacao_decisao)

    def test_computador_nao_encontrado_continua_removendo_com_aviso(self):
        r = avaliar_decisao("usuario_ausente", "jsilva", None, computador_achado=False, sistema_consultado=False)
        self.assertEqual((r.decidir, r.decisao, r.aviso), (True, "remover", True))
        r = avaliar_decisao("substituicao_manual", "jsilva", None, computador_achado=False, sistema_consultado=False)
        self.assertEqual((r.decisao, r.anotacao_decisao), ("recusar", "computador não encontrado no Endpoint; recusado automaticamente"))


class AnotacaoHistoricoTests(unittest.TestCase):
    def _respostas(self, eventos):
        def get_json(url, timeout=10):
            if url.endswith("/api/historico-comparacoes"):
                return {"total": len(eventos), "eventos": [{"id": eid} for eid in eventos]}
            return {"evento": {"comparacao": {"mudancas_usuarios": eventos[url.rsplit("/", 1)[-1]]}}}
        return get_json

    def test_localiza_pela_pendencia_em_evento_anterior(self):
        eventos = {
            "e2": [{"serie": "SER09", "pendencia_id": "p9", "anotacao_id": "a9"}],
            "e1": [{"serie": "SER01", "pendencia_id": "p1", "anotacao_id": "a1"}],
        }
        with patch("scripts.verificar_usuarios_endpoint._get_json", side_effect=self._respostas(eventos)):
            self.assertEqual(localizar_linha_anotacao(8000, "SER01", "p1"), ("e1", eventos["e1"][0]))

    def test_serie_so_vale_no_evento_mais_recente_e_se_unica(self):
        eventos = {
            "e2": [{"serie": "SER01", "pendencia_id": "", "anotacao_id": "a2"}],
            "e1": [{"serie": "SER01", "pendencia_id": "", "anotacao_id": "a1"}],
        }
        with patch("scripts.verificar_usuarios_endpoint._get_json", side_effect=self._respostas(eventos)):
            self.assertEqual(localizar_linha_anotacao(8000, "SER01", "p1"), ("e2", eventos["e2"][0]))
        eventos["e2"].append({"serie": "SER01", "pendencia_id": "", "anotacao_id": "a3"})
        with patch("scripts.verificar_usuarios_endpoint._get_json", side_effect=self._respostas(eventos)):
            self.assertIsNone(localizar_linha_anotacao(8000, "SER01", "p1"))

    def test_gravar_anotacao_acrescenta_e_respeita_limite(self):
        item = {"anotacao_id": "a1", "anotacao": "x" * 1990}
        resposta = MagicMock(status=200)
        resposta.__enter__.return_value = resposta
        with (
            patch("scripts.verificar_usuarios_endpoint.localizar_linha_anotacao", return_value=("e1", item)),
            patch("urllib.request.urlopen", return_value=resposta) as urlopen,
        ):
            self.assertTrue(gravar_anotacao_linha(8000, "SER01", "p1", "nova linha"))
        req = urlopen.call_args[0][0]
        self.assertTrue(req.full_url.endswith("/api/historico-comparacoes/e1/anotacoes/a1"))
        enviado = json.loads(req.data)["anotacao"]
        self.assertEqual(len(enviado), 2000)
        self.assertTrue(enviado.endswith("\nnova linha"))


class RotinaUsuariosTests(unittest.TestCase):
    def _automacao(self):
        automacao = MagicMock(RotinaErro=automacao_real.RotinaErro, CARREGAMENTO_MS=1000)
        automacao.descrever_erro.side_effect = str
        return automacao

    def _rodar(self, pendencia, linhas, decidir=(True, 200, "")):
        automacao = self._automacao()
        with (
            patch("scripts.verificar_usuarios_endpoint.descobrir_porta_servidor", return_value=8000),
            patch("scripts.verificar_usuarios_endpoint.obter_pendencias_abertas", return_value=[pendencia]),
            patch("scripts.verificar_usuarios_endpoint.abrir_grade_endpoint") as abrir,
            patch("scripts.verificar_usuarios_endpoint.pesquisar_computador_endpoint", return_value=(linhas, "série")),
            patch("scripts.verificar_usuarios_endpoint.decidir_pendencia", return_value=decidir) as decidir_mock,
            patch("scripts.verificar_usuarios_endpoint.gravar_anotacao_linha", return_value=True) as anotar,
            patch("scripts.verificar_usuarios_endpoint.aplicar_filtro") as filtro_final,
            redirect_stdout(io.StringIO()) as saida,
        ):
            codigo = verificar_usuarios_endpoint(MagicMock(), automacao)
        # A aba fica aberta, filtrada pelo hostname da última pendência.
        abrir.return_value.close.assert_not_called()
        filtro_final.assert_called_once_with(abrir.return_value, automacao, "nome", pendencia["computador"])
        return codigo, decidir_mock, anotar, saida.getvalue()

    PENDENCIA = {"id": "p1", "serie": "SER01", "computador": "PC01", "tipo": "usuario_ausente",
                 "estado": "pendente", "usuario_atual": "jteste"}

    def test_mesmo_usuario_mantem_e_anota(self):
        codigo, decidir_mock, anotar, _ = self._rodar(self.PENDENCIA, [{"nome": "PC01", "usuarios": "JTESTE", "serie": "SER01"}])
        self.assertEqual(codigo, 0)
        decidir_mock.assert_called_once_with(8000, "p1", "manter")
        self.assertIn("Usuário lido: JTESTE", anotar.call_args[0][3])

    def test_nao_encontrado_remove_e_avisa_so_depois_da_decisao(self):
        codigo, decidir_mock, _, saida = self._rodar(self.PENDENCIA, [])
        decidir_mock.assert_called_once_with(8000, "p1", "remover")
        self.assertIn("[AVISO] Verificar usuários: SER01 PC01 — computador não encontrado — removido automaticamente", saida)
        _, _, _, saida = self._rodar(self.PENDENCIA, [], decidir=(False, 409, "ja decidida"))
        self.assertNotIn("[AVISO] Verificar usuários: SER01", saida)
        self.assertIn("(409): 1", saida)

    def test_recusa_avisa_recusado(self):
        pendencia = dict(self.PENDENCIA, tipo="substituicao_manual", usuario_endpoint="novo")
        _, decidir_mock, _, saida = self._rodar(pendencia, [])
        decidir_mock.assert_called_once_with(8000, "p1", "recusar")
        self.assertIn("— recusado automaticamente", saida)

    def test_lista_vazia_nao_decide(self):
        _, decidir_mock, anotar, _ = self._rodar(self.PENDENCIA, [{"nome": "PC01", "usuarios": "NA", "serie": "SER01"}])
        decidir_mock.assert_not_called()
        self.assertIn("Sistema > Usuários não consultado", anotar.call_args[0][3])

    def test_falha_da_grade_interrompe_sem_decidir_e_deixa_a_aba_aberta(self):
        automacao = self._automacao()
        with (
            patch("scripts.verificar_usuarios_endpoint.descobrir_porta_servidor", return_value=8000),
            patch("scripts.verificar_usuarios_endpoint.obter_pendencias_abertas", return_value=[self.PENDENCIA]),
            patch("scripts.verificar_usuarios_endpoint.abrir_grade_endpoint") as abrir,
            patch("scripts.verificar_usuarios_endpoint.pesquisar_computador_endpoint",
                  side_effect=automacao_real.RotinaErro("grade não confirmou")),
            patch("scripts.verificar_usuarios_endpoint.decidir_pendencia") as decidir_mock,
        ):
            with self.assertRaises(automacao_real.RotinaErro):
                verificar_usuarios_endpoint(MagicMock(), automacao)
        decidir_mock.assert_not_called()
        abrir.return_value.close.assert_not_called()


if __name__ == "__main__":
    unittest.main()
