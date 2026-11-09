"""Etapa "Staged Computers": busca dos hostnames que saíram do Endpoint, sem navegador real."""

import re
import unittest
from unittest.mock import Mock, patch

from scripts import automacao_rotinas_chrome as automacao
from scripts import staged_computers_endpoint as rotina
from scripts import verificar_usuarios_endpoint as usuarios

COLUNAS = (
    ("Nome do computador", 0, 100), ("Nome amigável", 100, 200), ("Nome completo do computador", 200, 300),
    ("Escritório remoto", 300, 400), ("Management Status", 400, 500), ("Status do agente", 500, 600),
    ("Horário do último contato", 600, 700),
)
CAMPOS = ("nome", "amigavel", "completo", "escritorio", "gerenciamento", "agente", "contato")
ENCONTRADO_A = (
    "Encontrado em Staged Computers do Endpoint: escritório Curitiba, status Managed/Live, "
    "último contato 09/11/2026 08:00."
)
CARIMBO = re.compile(r"^\[Staged Computers \d{2}/\d{2}/\d{4} \d{2}:\d{2}\] ")


def pc(nome, amigavel="", completo="", escritorio="Curitiba", gerenciamento="Managed", agente="Live", contato="09/11/2026 08:00"):
    return dict(zip(CAMPOS, (nome, amigavel, completo or nome, escritorio, gerenciamento, agente, contato)))


class Elemento:
    def __init__(self, pagina, existe=True):
        self.pagina, self.existe = pagina, existe

    def wait_for(self, state="visible", timeout=0):
        if not self.existe:
            raise TimeoutError("não apareceu")


class PaginaStaged:
    """Staged Computers falso: só leitura. ``paginacao`` ``None`` = sem o texto "1 - N de"."""

    def __init__(self, computadores, paginacao="auto", carregando=False, por_pagina=None, proxima_ativa=False,
                 busca=False, nenhum_dado=None):
        self.computadores = computadores
        self.paginacao = (1, len(computadores)) if paginacao == "auto" else paginacao
        self.carregando = carregando
        self.rodape = {"por_pagina": por_pagina, "proxima_ativa": proxima_ativa, "busca": busca,
                       "nenhum_dado": (not computadores) if nenhum_dado is None else nenhum_dado}
        self.url = rotina.URL_STAGED_COMPUTERS
        self.visitas, self.seletores = [], []
        self.close = Mock()

    def goto(self, url, **_):
        self.visitas.append(url)
        self.url = url

    def locator(self, seletor):
        if "server-update" in seletor:  # vigia do aviso de hotfix, não faz parte da leitura
            return Mock()
        self.seletores.append(seletor)
        return Elemento(self)

    def add_locator_handler(self, *_args, **_kwargs):
        pass

    def evaluate(self, js, *_args):
        if js == usuarios.JS_LER_GRADE:
            linhas = [
                [{"texto": c[campo], "x0": COLUNAS[i][1], "x1": COLUNAS[i][2], "href": ""} for i, campo in enumerate(CAMPOS)]
                for c in self.computadores
            ]
            return {
                "cabecalhos": [{"texto": t, "x0": x0, "x1": x1} for t, x0, x1 in COLUNAS],
                "linhas": linhas, "carregando": self.carregando, "vazia": not linhas,
            }
        if js == rotina.JS_LER_PAGINACAO:
            if self.paginacao is None:
                return None
            return {"inicio": self.paginacao[0], "fim": self.paginacao[1], **self.rodape}
        raise AssertionError("leitura inesperada na página")


def item(computador="HOST-A", serie="BRJ0000001", situacao="saiu_endpoint", anotacao="", anotacao_id="a1"):
    return {
        "serie": serie, "computador": computador, "dias": 70, "situacao": situacao,
        "anotacao_id": anotacao_id, "anotacao": anotacao, "anotacao_revisoes": ["r1"],
    }


class Ambiente(unittest.TestCase):
    def setUp(self):
        self.itens = [item()]
        self.eventos = [{"id": "ev1"}]
        self.chamadas = []
        for patcher in (
            patch.object(rotina.time, "sleep", lambda *_: None),
            patch.object(rotina, "chamar_api", self._api),
            patch.object(automacao, "log", Mock()),
            patch.object(automacao, "registrar_erro", Mock()),
            patch.object(automacao, "aguardar_login", Mock()),
            patch.object(automacao, "endpoint_logado", Mock()),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def _api(self, _automacao, metodo, caminho, corpo=None):
        self.chamadas.append((metodo, caminho, corpo))
        if caminho == "/api/historico-comparacoes":
            return {"eventos": self.eventos}
        if caminho == "/api/historico-comparacoes/ev1":
            return {"evento": {"comparacao": {"sem_acesso_60_dias": self.itens}}}
        return {}

    def puts(self):
        return [c for c in self.chamadas if c[0] == "PUT"]

    def avisos(self):
        return [c.args[1] for c in automacao.log.call_args_list if "[AVISO]" in c.args[1]]

    def rodar(self, pagina):
        with patch.object(automacao, "nova_aba", return_value=pagina) as aba:
            codigo = rotina.verificar_staged_computers(Mock(), automacao)
        self.aba = aba
        return codigo


class EncontradoTest(Ambiente):
    def test_encontrado_anota_escritorio_status_e_ultimo_contato(self):
        pagina = PaginaStaged([pc("HOST-A"), pc("HOST-B")])
        self.assertEqual(self.rodar(pagina), 0)
        (_, caminho, corpo), = self.puts()
        self.assertEqual(caminho, "/api/historico-comparacoes/ev1/anotacoes/a1")
        self.assertRegex(corpo["anotacao"], CARIMBO)
        self.assertTrue(corpo["anotacao"].endswith(ENCONTRADO_A))
        self.assertEqual(corpo["base_revisoes"], ["r1"])
        pagina.close.assert_not_called()
        self.assertEqual(pagina.visitas, [])  # a aba já abriu na tela de Staged Computers

    def test_mantem_a_nota_do_usuario_e_acrescenta_o_carimbo(self):
        self.itens = [item(anotacao="Notebook do João")]
        self.rodar(PaginaStaged([pc("HOST-A")]))
        (_, _, corpo), = self.puts()
        primeira, segunda = corpo["anotacao"].split("\n")
        self.assertEqual(primeira, "Notebook do João")
        self.assertRegex(segunda, CARIMBO)

    def test_nome_completo_com_dominio_conta_e_prefixo_parecido_nao(self):
        self.itens = [item("HOST-A", "S1", anotacao_id="a1"), item("HOST-B", "S2", anotacao_id="a2")]
        pagina = PaginaStaged([pc("XYZ", completo="host-a.sebrae.local"), pc("XYZ2", completo="HOST-BB.sebrae.local")])
        self.rodar(pagina)
        textos = {c[1].rsplit("/", 1)[1]: c[2]["anotacao"] for c in self.puts()}
        self.assertTrue(textos["a1"].endswith(ENCONTRADO_A))
        self.assertTrue(textos["a2"].endswith(rotina.MENSAGEM_NAO_ENCONTRADO))

    def test_nome_amigavel_nao_conta(self):
        pagina = PaginaStaged([pc("OUTRO-PC", amigavel="HOST-A"), pc("HOST-C")])
        self.rodar(pagina)
        (_, _, corpo), = self.puts()
        self.assertTrue(corpo["anotacao"].endswith(rotina.MENSAGEM_NAO_ENCONTRADO))


class NaoEncontradoTest(Ambiente):
    def test_nao_encontrado_com_grade_completa_anota(self):
        self.rodar(PaginaStaged([pc("HOST-B"), pc("HOST-C")]))
        (_, _, corpo), = self.puts()
        self.assertTrue(corpo["anotacao"].endswith("Não encontrado em Staged Computers do Endpoint."))
        self.assertEqual(self.avisos(), [])

    def test_pagina_cheia_nao_anota_nao_encontrado_mas_anota_encontrado(self):
        self.itens = [item("HOST-A", "S1", anotacao_id="a1"), item("HOST-Z", "S2", anotacao_id="a2")]
        cheia = [pc("HOST-A")] + [pc(f"PC-{i}") for i in range(rotina.LINHAS_POR_PAGINA - 1)]
        self.rodar(PaginaStaged(cheia))
        (_, caminho, corpo), = self.puts()
        self.assertTrue(caminho.endswith("/a1"))
        self.assertTrue(corpo["anotacao"].endswith(ENCONTRADO_A))
        self.assertTrue(any("sem prova de estar completa" in a for a in self.avisos()))

    def test_paginacao_diferente_das_linhas_lidas_nao_anota_nao_encontrado(self):
        self.rodar(PaginaStaged([pc("HOST-B"), pc("HOST-C")], paginacao=(1, 5)))
        self.assertEqual(self.puts(), [])
        self.assertTrue(any("5 computador(es)" in a and "2 linha(s)" in a for a in self.avisos()))

    def test_sem_texto_de_paginacao_nao_anota_nao_encontrado(self):
        self.rodar(PaginaStaged([pc("HOST-B")], paginacao=None))
        self.assertEqual(self.puts(), [])
        self.assertTrue(any("paginação" in a for a in self.avisos()))

    def test_fora_da_primeira_pagina_nao_anota_nao_encontrado(self):
        self.rodar(PaginaStaged([pc("HOST-B")], paginacao=(26, 26)))
        self.assertEqual(self.puts(), [])

    def test_motivo_incompleta(self):
        def rodape(inicio, fim, **extra):
            return {"inicio": inicio, "fim": fim, "por_pagina": None, "proxima_ativa": False, "busca": False,
                    "nenhum_dado": False, **extra}

        grade = {"linhas": [[]] * 3}
        self.assertEqual(rotina.motivo_incompleta(grade, rodape(1, 3)), "")
        self.assertTrue(rotina.motivo_incompleta(grade, None))
        self.assertTrue(rotina.motivo_incompleta(grade, rodape(1, 4)))
        self.assertTrue(rotina.motivo_incompleta({"linhas": [[]] * 25}, rodape(1, 25)))
        # "Rows per page" salvo em 50: 30 linhas ainda provam a grade inteira; 50 não.
        self.assertEqual(rotina.motivo_incompleta({"linhas": [[]] * 30}, rodape(1, 30, por_pagina=50)), "")
        self.assertIn("50", rotina.motivo_incompleta({"linhas": [[]] * 50}, rodape(1, 50, por_pagina=50)))
        self.assertIn("próxima", rotina.motivo_incompleta(grade, rodape(1, 3, proxima_ativa=True)))
        self.assertIn("busca", rotina.motivo_incompleta(grade, rodape(1, 3, busca=True)))
        vazia = {"linhas": []}
        self.assertIn("vazia", rotina.motivo_incompleta(vazia, rodape(1, 0)))
        self.assertEqual(rotina.motivo_incompleta(vazia, rodape(1, 0, nenhum_dado=True)), "")

    def test_botao_proxima_ativo_ou_busca_com_texto_nao_anota_nao_encontrado(self):
        for extra in ({"proxima_ativa": True}, {"busca": True}):
            with self.subTest(**extra):
                self.chamadas = []
                self.rodar(PaginaStaged([pc("HOST-B")], **extra))
                self.assertEqual(self.puts(), [])

    def test_grade_vazia_com_nenhum_dado_anota_nao_encontrado(self):
        self.rodar(PaginaStaged([], paginacao=(1, 0)))
        (_, _, corpo), = self.puts()
        self.assertTrue(corpo["anotacao"].endswith(rotina.MENSAGEM_NAO_ENCONTRADO))


class SemTrabalhoTest(Ambiente):
    def test_sem_saiu_endpoint_nao_abre_aba(self):
        self.itens = [item(situacao="passou"), item(situacao="limite", anotacao_id="a2")]
        self.assertEqual(self.rodar(PaginaStaged([])), 0)
        self.aba.assert_not_called()
        self.assertEqual(self.puts(), [])

    def test_sem_evento_no_historico_nao_abre_aba(self):
        self.eventos = []
        self.assertEqual(self.rodar(PaginaStaged([])), 0)
        self.aba.assert_not_called()

    def test_linha_sem_hostname_ou_sem_anotacao_id_e_ignorada(self):
        self.itens = [item(computador=""), item(anotacao_id="")]
        self.assertEqual(self.rodar(PaginaStaged([])), 0)
        self.aba.assert_not_called()
        self.assertTrue(any("sem hostname" in a for a in self.avisos()))


class EventoTest(Ambiente):
    def test_pula_restauracao_e_evento_so_de_anotacoes(self):
        self.eventos = [{"id": "r1", "tipo": "restauracao"}, {"id": "s1", "somente_anotacoes_sincronizadas": True},
                        {"id": "ev1"}]
        self.rodar(PaginaStaged([pc("HOST-A")]))
        (_, caminho, _), = self.puts()
        self.assertEqual(caminho, "/api/historico-comparacoes/ev1/anotacoes/a1")
        self.assertNotIn(("GET", "/api/historico-comparacoes/r1", None), self.chamadas)


class ReleituraTest(Ambiente):
    def _detalhes(self, *listas):
        fila = list(listas)
        base = self._api

        def api(_automacao, metodo, caminho, corpo=None):
            if caminho == "/api/historico-comparacoes/ev1" and fila:
                self.chamadas.append((metodo, caminho, corpo))
                return {"evento": {"comparacao": {"sem_acesso_60_dias": fila.pop(0)}}}
            return base(_automacao, metodo, caminho, corpo)

        return patch.object(rotina, "chamar_api", api)

    def test_regrava_sobre_a_anotacao_relida_antes_do_put(self):
        nova = item(anotacao="Nota escrita durante a leitura")
        nova["anotacao_revisoes"] = ["r2"]
        with self._detalhes([item()], [nova]):
            self.rodar(PaginaStaged([pc("HOST-A")]))
        (_, _, corpo), = self.puts()
        self.assertTrue(corpo["anotacao"].startswith("Nota escrita durante a leitura\n"))
        self.assertEqual(corpo["base_revisoes"], ["r2"])

    def test_linha_que_sumiu_na_releitura_e_ignorada(self):
        with self._detalhes([item()], []):
            self.assertEqual(self.rodar(PaginaStaged([pc("HOST-A")])), 0)
        self.assertEqual(self.puts(), [])

    def test_anotacao_em_conflito_ou_invalida_nao_e_gravada(self):
        for campo in ("anotacao_conflito", "anotacao_integridade_invalida"):
            with self.subTest(campo=campo):
                self.chamadas = []
                self.itens = [{**item(), campo: True}]
                self.rodar(PaginaStaged([pc("HOST-A")]))
                self.assertEqual(self.puts(), [])
                self.assertTrue(any("conflito" in a for a in self.avisos()))


class IdempotenciaTest(Ambiente):
    def test_mesma_mensagem_nao_regrava(self):
        self.itens = [item(anotacao=f"nota\n[Staged Computers 01/11/2026 10:00] {ENCONTRADO_A}")]
        self.rodar(PaginaStaged([pc("HOST-A")]))
        self.assertEqual(self.puts(), [])

    def test_mensagem_diferente_acrescenta_nova_linha(self):
        antigo = f"[Staged Computers 01/11/2026 10:00] {rotina.MENSAGEM_NAO_ENCONTRADO}"
        self.itens = [item(anotacao=antigo)]
        self.rodar(PaginaStaged([pc("HOST-A")]))
        (_, _, corpo), = self.puts()
        linhas = corpo["anotacao"].split("\n")
        self.assertEqual(linhas[0], antigo)
        self.assertTrue(linhas[1].endswith(ENCONTRADO_A))

    def test_acima_do_limite_nao_grava_nem_trunca(self):
        self.itens = [item(anotacao="x" * (rotina.LIMITE_ANOTACAO - 10))]
        self.rodar(PaginaStaged([pc("HOST-A")]))
        self.assertEqual(self.puts(), [])
        self.assertTrue(any("não gravada" in a for a in self.avisos()))

    def test_erro_da_api_vira_aviso(self):
        def api(_automacao, metodo, caminho, corpo=None):
            if metodo == "PUT":
                raise rotina.ErroApi(409, "revisões mudaram")
            return self._api(_automacao, metodo, caminho, corpo)

        with patch.object(rotina, "chamar_api", api):
            self.assertEqual(self.rodar(PaginaStaged([pc("HOST-A")])), 0)
        self.assertTrue(any("não gravada" in a for a in self.avisos()))


class LeituraTest(Ambiente):
    def test_grade_que_nao_carrega_levanta_e_registra_erro(self):
        pagina = PaginaStaged([pc("HOST-A")], carregando=True)
        with patch.object(automacao, "CARREGAMENTO_MS", 30):
            with self.assertRaises(automacao.RotinaErro):
                self.rodar(pagina)
        automacao.registrar_erro.assert_called_once()
        self.assertEqual(self.puts(), [])
        pagina.close.assert_not_called()

    def test_volta_para_staged_computers_se_o_login_devolveu_a_outra_pagina(self):
        pagina = PaginaStaged([pc("HOST-A")])
        pagina.url = automacao.ENDPOINT_URL
        self.rodar(pagina)
        self.assertEqual(pagina.visitas, [rotina.URL_STAGED_COMPUTERS])

    def test_aba_que_sai_da_tela_durante_a_leitura_volta_ao_link_e_le_de_novo(self):
        pagina = PaginaStaged([pc("HOST-B")])
        avaliar = pagina.evaluate
        saidas = []

        def evaluate(js, *args):
            if js == rotina.JS_LER_PAGINACAO and not saidas:  # clique acidental na primeira leitura
                saidas.append(1)
                pagina.url = automacao.ENDPOINT_URL
            return avaliar(js, *args)

        pagina.evaluate = evaluate
        self.rodar(pagina)
        self.assertEqual(pagina.visitas, [rotina.URL_STAGED_COMPUTERS])
        (_, _, corpo), = self.puts()
        self.assertTrue(corpo["anotacao"].endswith(rotina.MENSAGEM_NAO_ENCONTRADO))

    def test_aba_que_nunca_volta_nao_anota_nada(self):
        pagina = PaginaStaged([pc("HOST-B")])
        avaliar = pagina.evaluate

        def evaluate(js, *args):
            if js == rotina.JS_LER_PAGINACAO:
                pagina.url = automacao.ENDPOINT_URL
            return avaliar(js, *args)

        pagina.evaluate = evaluate
        with self.assertRaises(automacao.EtapaInstavel):
            self.rodar(pagina)
        self.assertEqual(self.puts(), [])
        automacao.registrar_erro.assert_called_once()
        pagina.close.assert_not_called()

    def test_so_leitura_na_pagina(self):
        pagina = PaginaStaged([pc("HOST-A")])
        self.rodar(pagina)
        self.assertEqual(pagina.seletores, [f"#{rotina.ID_BOTAO_BUSCA}"])


if __name__ == "__main__":
    unittest.main()
