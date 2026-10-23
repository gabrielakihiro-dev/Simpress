"""Rotina "Verificar usuários": decisão, grade do Endpoint e Sistema > Usuários, sem navegador real."""

import unittest
from unittest.mock import Mock, patch

from scripts import automacao_rotinas_chrome as automacao
from scripts import verificar_usuarios_endpoint as rotina

COLUNAS = (("Nome do computador", 0, 100), ("Rótulo de serviço/Número de série", 100, 200), ("Usuários logados", 200, 300))
# Ao abrir a barra de pesquisa, a grade reorganiza as colunas: série e usuários trocam de lugar.
COLUNAS_DESLOCADAS = (("Nome do computador", 0, 100), ("Rótulo de serviço/Número de série", 200, 300), ("Usuários logados", 100, 200))


class Elemento:
    """Locator falso: guarda cliques e teclas num registro compartilhado com a página."""

    def __init__(self, pagina, acao=None, existe=True):
        self.pagina, self.acao, self.existe = pagina, acao, existe

    def filter(self, **_):
        return self

    @property
    def first(self):
        return self

    def or_(self, _outro):
        return self

    def count(self):
        return 1 if self.existe else 0

    def wait_for(self, state="visible", timeout=0):
        if not self.existe:
            raise TimeoutError("não apareceu")

    def click(self):
        if self.acao:
            self.acao()


class CampoFiltro(Elemento):
    """Caixa de filtro de uma coluna da barra de pesquisa."""

    def __init__(self, pagina, indice):
        super().__init__(pagina)
        self.indice = indice

    def bounding_box(self):
        _, x0, x1 = self.pagina.colunas[self.indice]
        return {"x": x0 + 5, "y": 0, "width": x1 - x0 - 10, "height": 20}

    def press(self, tecla):
        p = self.pagina
        if tecla == "Control+A":
            p.selecionado = True
        elif tecla == "Backspace":
            atual = p.buffers.get(self.indice, "")
            p.buffers[self.indice] = "" if p.selecionado else atual[:-1]
            p.selecionado = False
        elif tecla == "Enter" and not p.surda:
            p.filtros[self.indice] = p.buffers.get(self.indice, "")

    def press_sequentially(self, texto, delay=0):
        self.pagina.buffers[self.indice] = self.pagina.buffers.get(self.indice, "") + texto

    def input_value(self):
        return self.pagina.buffers.get(self.indice, "")


class Caixas:
    """``input.search-text-box``: sem caixas até a lupa da barra de ferramentas abrir a pesquisa."""

    def __init__(self, pagina):
        self.pagina = pagina

    def filter(self, **_):
        return self

    @property
    def first(self):
        return Elemento(self.pagina, existe=self.pagina.barra_aberta)

    def count(self):
        return len(COLUNAS) if self.pagina.barra_aberta else 0

    def nth(self, i):
        return CampoFiltro(self.pagina, i)


class LupaPesquisa(Elemento):
    @property
    def first(self):
        return self

    def click(self):
        self.pagina.barra_aberta = True
        if self.pagina.deslocar_ao_abrir:
            self.pagina.colunas = COLUNAS_DESLOCADAS


class PaginaEndpoint:
    """Endpoint falso: grade filtrável por coluna, detalhe do computador e Sistema > Usuários.

    ``surda`` simula o Enter que não aplica o filtro (valor não registrado pelo componente).
    ``deslocar_ao_abrir`` simula a grade que muda de layout quando a barra de pesquisa abre."""

    def __init__(
        self, computadores, usuarios_sistema=None, surda=False, aba_ausente=None, deslocar_ao_abrir=False, ultimos_logon=None,
    ):
        self.computadores = computadores
        self.usuarios_sistema = usuarios_sistema or {}
        self.ultimos_logon = ultimos_logon or {}
        self.surda, self.aba_ausente, self.deslocar_ao_abrir = surda, aba_ausente, deslocar_ao_abrir
        self.visitas, self.historico_abas = [], []
        self.url = automacao.ENDPOINT_URL
        self.reiniciar()

    def reiniciar(self):
        self.filtros, self.buffers, self.selecionado = {}, {}, False
        self.barra_aberta = False
        self.colunas = COLUNAS
        self.detalhe, self.abas = None, []

    @property
    def abas_clicadas(self):
        return self.historico_abas

    def goto(self, url, **_):
        self.visitas.append(url)
        self.url = url
        self.reiniciar()

    def locator(self, seletor):
        if "search-text-box" in seletor:
            return Caixas(self)
        if "_searchButton" in seletor:
            return LupaPesquisa(self)
        href = seletor.split('href="')[1].rstrip('"]')
        return Elemento(self, lambda: self._abrir_detalhe(href))

    def get_by_role(self, _papel, name):
        nome = next(n for n in ("Sistema", "Usuários") if name.match(n))
        return Elemento(self, lambda: (self.abas.append(nome), self.historico_abas.append(nome)), existe=nome != self.aba_ausente)

    def _abrir_detalhe(self, href):
        self.detalhe = next(c for c in self.computadores if c["href"] == href)
        self.url = automacao.ENDPOINT_URL.split("#")[0] + href + "/summary"

    def _visiveis(self):
        saida = []
        for c in self.computadores:
            valores = (c["nome"], c["serie"], c["usuarios"])
            if all(texto.casefold() in valores[i].casefold() for i, texto in self.filtros.items() if texto):
                saida.append(c)
        return saida

    def evaluate(self, js, *args):
        if js == rotina.JS_LER_GRADE:
            linhas = [
                [
                    {"texto": c[campo], "x0": self.colunas[i][1], "x1": self.colunas[i][2], "href": c["href"] if i == 0 else ""}
                    for i, campo in enumerate(("nome", "serie", "usuarios"))
                ]
                for c in self._visiveis()
            ]
            if self.detalhe:
                return {"cabecalhos": [], "linhas": [], "carregando": False, "vazia": False}
            return {
                "cabecalhos": [{"texto": t, "x0": x0, "x1": x1} for t, x0, x1 in self.colunas],
                "linhas": linhas, "carregando": False, "vazia": not linhas,
            }
        if js == rotina.JS_LER_ULTIMO_LOGON:
            ultimo = self.ultimos_logon.get(self.detalhe["nome"], "") if self.detalhe else ""
            return {"presente": bool(ultimo), "ultimo": ultimo, "carregando": False}
        if self.detalhe and self.abas[-2:] == ["Sistema", "Usuários"]:
            nomes = self.usuarios_sistema.get(self.detalhe["nome"], [])
            ultimo = self.ultimos_logon.get(self.detalhe["nome"], "")
            return {"cabecalho": "nome do usuario", "nomes": nomes, "ultimo": ultimo, "carregando": False, "vazia": not nomes}
        return {"cabecalho": "", "nomes": [], "ultimo": "", "carregando": False, "vazia": False}


def computador(nome, serie, usuarios="", href=None):
    return {"nome": nome, "serie": serie, "usuarios": usuarios, "href": href or f"#/uems/inventory/computers/{abs(hash(nome)) % 9999}"}


def pendencia(tipo="usuario_ausente", serie="BRJ0000TST", atual="carla", endpoint="", computador_="HOST-1"):
    return {"id": "p1", "serie": serie, "computador": computador_, "tipo": tipo, "estado": "pendente",
            "usuario_atual": atual, "usuario_endpoint": endpoint}


class AmbienteBase(unittest.TestCase):
    def setUp(self):
        for patcher in (patch.object(rotina.time, "sleep", lambda *_: None), patch.object(rotina, "ESPERA_ULTIMO_LOGON_S", 0.02)):
            patcher.start()
            self.addCleanup(patcher.stop)
        for nome in ("log", "registrar_erro", "selecionar_todos_computadores", "confirmar_modo_todos"):
            patcher = patch.object(automacao, nome, Mock())
            patcher.start()
            self.addCleanup(patcher.stop)


class DecisaoTest(unittest.TestCase):
    def test_tabela_de_decisao_usuario_ausente(self):
        p = pendencia("usuario_ausente", atual="carla")
        self.assertEqual(rotina.avaliar_decisao(p, True, "CARLA").decisao, "manter")
        diferente = rotina.avaliar_decisao(p, True, "davi")
        self.assertEqual((diferente.decisao, diferente.aplicar_usuario), ("remover", "davi"))
        sem = rotina.avaliar_decisao(p, True, "", "Sistema")
        self.assertEqual((sem.decisao, bool(sem.aviso)), ("remover", True))
        ausente = rotina.avaliar_decisao(p, False, "")
        self.assertEqual((ausente.decisao, bool(ausente.aviso)), ("remover", True))

    def test_tabela_de_decisao_substituicao_manual(self):
        p = pendencia("substituicao_manual", atual="carla", endpoint="davi")
        self.assertEqual(rotina.avaliar_decisao(p, True, "DOM\\davi").decisao, "permitir")
        igual_ao_manual = rotina.avaliar_decisao(p, True, "carla")
        self.assertEqual((igual_ao_manual.decisao, igual_ao_manual.aplicar_usuario), ("recusar", ""))
        outro = rotina.avaliar_decisao(p, True, "bia")
        self.assertEqual((outro.decisao, outro.aplicar_usuario), ("recusar", "bia"))
        sem = rotina.avaliar_decisao(p, True, "", "Sistema")
        self.assertEqual((sem.decisao, bool(sem.aviso)), ("recusar", True))
        self.assertEqual(rotina.avaliar_decisao(p, False, "").decisao, "recusar")

    def test_escolha_de_usuarios(self):
        self.assertEqual(rotina.limpar_usuario_logon("MRamos Horário da última inicialização : out 22, 2026 12:21 PM"), "MRamos")
        self.assertEqual(rotina.limpar_usuario_logon("Horário da última inicialização : out 22"), "")
        self.assertEqual(rotina.escolher_usuario_sistema(["Horário da última inicialização : out 22", "ana"]), "ana")
        self.assertEqual(rotina.escolher_usuario_sistema(["", "root", "Convidado", "WDAGUtilityAccount", "davi", "ana"]), "davi")
        self.assertEqual(rotina.escolher_usuario_sistema(["Administrador", "DefaultAccount", "N/A"]), "")

    def test_grade_aceita_um_usuario_valido_e_marca_varios_como_ambiguos(self):
        self.assertEqual(rotina.escolher_usuario_grade("NA, DOM\\carla, carla"), ("DOM\\carla", False))
        self.assertEqual(rotina.escolher_usuario_grade("Administrador, CodexSandboxOffline"), ("", False))
        self.assertEqual(rotina.escolher_usuario_grade("carla, davi"), ("", True))

    def test_contas_tecnicas_e_codex_nao_contam_como_usuario(self):
        for nome in ("CodexSandboxOffline", "CodexSandboxOnline", "Default User", "UI Flow Service", "UIFlowService"):
            self.assertFalse(rotina.usuario_valido(nome), nome)
        self.assertEqual(rotina.escolher_usuario_sistema(["CodexSandboxOffline", "Default", "UI Flow Service", "davi"]), "davi")

    def test_ultimo_logon_e_a_base_do_sistema(self):
        self.assertEqual(rotina.escolher_usuario_sistema(["davi"], "MRamos"), "MRamos")
        self.assertEqual(rotina.escolher_usuario_sistema(["davi"], "CodexSandboxOffline"), "davi")
        self.assertEqual(rotina.escolher_usuario_sistema([], ""), "")

    def test_serie_sem_s_so_para_serie_com_s(self):
        self.assertEqual(rotina.serie_sem_s("SCMVXKV7YCM"), "CMVXKV7YCM")
        self.assertEqual(rotina.serie_sem_s("BRJ123"), "BRJ123"[0:0] or "")
        self.assertEqual(rotina.serie_sem_s("S"), "")


class GradeTest(AmbienteBase):
    def test_filtro_digitado_e_confirmado(self):
        pagina = PaginaEndpoint([computador("H1", "AAA1"), computador("H2", "BBB2")])
        grade = rotina.aplicar_filtro(pagina, automacao, "numero de serie", "AAA1")
        self.assertEqual([l[0]["texto"] for l in grade["linhas"]], ["H1"])

    def test_valor_nao_vai_para_a_coluna_vizinha_quando_a_barra_desloca_a_grade(self):
        pagina = PaginaEndpoint([computador("H1", "AAA1", "ana"), computador("H2", "BBB2", "ana")], deslocar_ao_abrir=True)
        grade = rotina.aplicar_filtro(pagina, automacao, "numero de serie", "AAA1")
        self.assertEqual(pagina.filtros, {1: "AAA1"})
        self.assertEqual([l[0]["texto"] for l in grade["linhas"]], ["H1"])

    def test_tentativa_sem_confirmacao_esvazia_as_caixas(self):
        pagina = PaginaEndpoint([computador("H1", "AAA1"), computador("H2", "BBB2")], surda=True)
        with patch.object(rotina, "CONFIRMACAO_FILTRO_S", 0.05):
            with self.assertRaises(automacao.RotinaErro):
                rotina.aplicar_filtro(pagina, automacao, "numero de serie", "AAA1")
        self.assertFalse(any(pagina.buffers.values()))

    def test_grade_vazia_confirmada(self):
        pagina = PaginaEndpoint([computador("H1", "AAA1")])
        grade = rotina.aplicar_filtro(pagina, automacao, "numero de serie", "ZZZ9")
        self.assertTrue(grade["vazia"])

    def test_filtro_nao_confirmado_levanta_erro(self):
        pagina = PaginaEndpoint([computador("H1", "AAA1"), computador("H2", "BBB2")], surda=True)
        with patch.object(rotina, "CONFIRMACAO_FILTRO_S", 0.05):
            with self.assertRaises(automacao.RotinaErro):
                rotina.aplicar_filtro(pagina, automacao, "numero de serie", "AAA1")

    def test_busca_por_serie_sem_s_e_limpa_o_filtro(self):
        pagina = PaginaEndpoint([computador("MAC", "CMVXKV7YCM", "ana")])
        r = rotina.pesquisar_computador_endpoint(pagina, automacao, "SCMVXKV7YCM", "")
        self.assertEqual((r["estado"], r["linha"]["usuarios"]), ("unico", "ana"))
        self.assertFalse(any(pagina.filtros.values()))

    def test_busca_por_hostname_quando_a_serie_nao_existe(self):
        pagina = PaginaEndpoint([computador("HOST-1", "OUTRA")])
        r = rotina.pesquisar_computador_endpoint(pagina, automacao, "BRJ0000TST", "host-1")
        self.assertEqual((r["estado"], r["linha"]["nome"]), ("unico", "HOST-1"))
        self.assertFalse(any(pagina.filtros.values()))

    def test_correspondencia_exata_e_ambigua(self):
        pagina = PaginaEndpoint([computador("H1", "XX1"), computador("H2", "XX1")])
        self.assertEqual(rotina.pesquisar_computador_endpoint(pagina, automacao, "XX1", "")["estado"], "ambiguo")
        parcial = PaginaEndpoint([computador("H1", "XX10")])
        self.assertEqual(rotina.pesquisar_computador_endpoint(parcial, automacao, "XX1", "")["estado"], "ausente")


class SistemaTest(AmbienteBase):
    def setUp(self):
        super().setUp()
        self.chamadas = []
        self.anotacoes = []
        self.linha = {"pendencia_id": "p1", "anotacao_id": "a1", "anotacao": ""}
        patcher = patch.object(rotina, "chamar_api", self._api)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _api(self, _automacao, metodo, caminho, corpo=None):
        self.chamadas.append((metodo, caminho, corpo))
        if caminho == "/api/historico-comparacoes":
            return {"eventos": [{"id": "ev1"}]}
        if caminho == "/api/historico-comparacoes/ev1":
            return {"evento": {"comparacao": {"mudancas_usuarios": [self.linha]}}}
        return {}

    def _decisoes(self):
        return [c[2]["decisao"] for c in self.chamadas if c[1].endswith("/decidir")]

    def _anotacoes(self):
        return [c[2]["anotacao"] for c in self.chamadas if c[0] == "PUT"]

    def test_sistema_usa_a_primeira_linha_valida_e_mantem(self):
        pagina = PaginaEndpoint(
            [computador("HOST-1", "BRJ0000TST", "NA")], {"HOST-1": ["Administrador", "", "carla", "davi"]},
        )
        rotina.processar_pendencia(pagina, automacao, pendencia(atual="carla"))
        self.assertEqual(self._decisoes(), ["manter"])
        self.assertEqual(pagina.abas_clicadas, ["Sistema", "Usuários"])
        self.assertEqual(pagina.visitas[-1], automacao.ENDPOINT_URL)
        self.assertIn("Sistema confirma o usuário carla", self._anotacoes()[0])

    def test_ultimo_logon_decide_mesmo_com_contas_tecnicas_na_tabela(self):
        pagina = PaginaEndpoint(
            [computador("HOST-1", "BRJ5512FFS", "outro.usuario")],
            {"HOST-1": ["CodexSandboxOffline", "Default", "UI Flow Service"]},
            ultimos_logon={"HOST-1": "MRamos"},
        )
        rotina.processar_pendencia(pagina, automacao, pendencia(serie="BRJ5512FFS", atual="MRamos"))
        self.assertEqual(self._decisoes(), ["manter"])
        self.assertEqual(pagina.abas_clicadas, [])
        self.assertIn("Último logon confirma o usuário MRamos", self._anotacoes()[0])

    def test_ultimo_logon_com_horario_colado_ao_nome_confirma(self):
        pagina = PaginaEndpoint(
            [computador("HOST-1", "BRJ5512FFS", "")],
            ultimos_logon={"HOST-1": "MRamos Horário da última inicialização : out 22, 2026 12:21 PM"},
        )
        rotina.processar_pendencia(pagina, automacao, pendencia(serie="BRJ5512FFS", atual="MRamos"))
        self.assertEqual(self._decisoes(), ["manter"])

    def test_ultimo_logon_diferente_aplica_o_novo_usuario(self):
        pagina = PaginaEndpoint([computador("HOST-1", "BRJ0000TST", "")], ultimos_logon={"HOST-1": "davi"})
        rotina.processar_pendencia(pagina, automacao, pendencia(atual="carla"))
        self.assertEqual(self._decisoes(), ["remover"])
        self.assertIn(("POST", "/api/equipamento/atualizar-usuario", {"serial": "BRJ0000TST", "usuario": "davi"}), self.chamadas)
        self.assertIn("outro usuário (davi)", self._anotacoes()[0])

    def test_substituicao_manual_com_ultimo_logon_novo_recusa_e_grava(self):
        pagina = PaginaEndpoint([computador("HOST-1", "BRJ0000TST", "")], ultimos_logon={"HOST-1": "bia"})
        rotina.processar_pendencia(pagina, automacao, pendencia("substituicao_manual", atual="carla", endpoint="davi"))
        self.assertEqual(self._decisoes(), ["recusar"])
        self.assertIn(("POST", "/api/equipamento/atualizar-usuario", {"serial": "BRJ0000TST", "usuario": "bia"}), self.chamadas)

    def test_falha_ao_gravar_o_novo_usuario_vai_para_a_anotacao(self):
        pagina = PaginaEndpoint([computador("HOST-1", "BRJ0000TST", "")], ultimos_logon={"HOST-1": "davi"})
        with patch.object(rotina, "aplicar_usuario", return_value=False):
            rotina.processar_pendencia(pagina, automacao, pendencia(atual="carla"))
        self.assertIn("Não foi possível gravar o novo usuário", self._anotacoes()[0])

    def test_ultimo_logon_tecnico_cai_para_sistema(self):
        pagina = PaginaEndpoint(
            [computador("HOST-1", "BRJ0000TST", "")], {"HOST-1": ["carla"]}, ultimos_logon={"HOST-1": "CodexSandboxOffline"},
        )
        rotina.processar_pendencia(pagina, automacao, pendencia(atual="carla"))
        self.assertEqual(self._decisoes(), ["manter"])
        self.assertEqual(pagina.abas_clicadas, ["Sistema", "Usuários"])

    def test_so_contas_internas_remove_com_aviso(self):
        pagina = PaginaEndpoint(
            [computador("HOST-1", "BRJ0000TST", "")], {"HOST-1": ["Administrador", "Convidado", "WDAGUtilityAccount"]},
        )
        with patch.object(automacao, "log") as log:
            rotina.processar_pendencia(pagina, automacao, pendencia(atual="carla"))
        self.assertEqual(self._decisoes(), ["remover"])
        self.assertTrue(any("[AVISO]" in str(c) for c in log.call_args_list))

    def test_substituicao_manual_sem_usuario_valido_recusa(self):
        pagina = PaginaEndpoint([computador("HOST-1", "BRJ0000TST", "N/A")], {"HOST-1": []})
        rotina.processar_pendencia(pagina, automacao, pendencia("substituicao_manual", "carla", "davi"))
        self.assertEqual(self._decisoes(), ["recusar"])

    def test_usuarios_logados_da_grade_com_usuario_unico_decide_antes_de_sistema(self):
        pagina = PaginaEndpoint([computador("HOST-1", "BRJ0000TST", "carla")], {"HOST-1": ["davi"]})
        rotina.processar_pendencia(pagina, automacao, pendencia(atual="carla"))
        self.assertEqual(pagina.abas_clicadas, [])
        self.assertEqual(self._decisoes(), ["manter"])
        self.assertIn("Usuários logados confirma o usuário carla", self._anotacoes()[0])

    def test_grade_com_varios_usuarios_validos_mantem_pendencia_aberta(self):
        pagina = PaginaEndpoint(
            [computador("HOST-1", "BRJ0000TST", "carla, davi")],
            {"HOST-1": ["carla"]},
            ultimos_logon={"HOST-1": "CodexSandboxOffline"},
        )
        rotina.processar_pendencia(pagina, automacao, pendencia(atual="carla"))
        self.assertEqual(self._decisoes(), [])
        self.assertEqual(pagina.abas_clicadas, [])
        self.assertIn("Mais de um usuário válido", self._anotacoes()[0])

    def test_computador_nao_encontrado_remove_com_aviso(self):
        pagina = PaginaEndpoint([computador("OUTRO", "ZZZ")])
        rotina.processar_pendencia(pagina, automacao, pendencia(atual="carla"))
        self.assertEqual(self._decisoes(), ["remover"])

    def test_volta_a_grade_mesmo_com_erro_e_nao_decide(self):
        pagina = PaginaEndpoint([computador("HOST-1", "BRJ0000TST", "")], aba_ausente="Usuários")
        with self.assertRaises(automacao.RotinaErro):
            rotina.processar_pendencia(pagina, automacao, pendencia(atual="carla"))
        self.assertEqual(self._decisoes(), [])
        self.assertEqual(pagina.visitas[-1], automacao.ENDPOINT_URL)
        self.assertIsNone(pagina.detalhe)

    def test_tabela_que_nao_carrega_nao_decide(self):
        pagina = PaginaEndpoint([computador("HOST-1", "BRJ0000TST", "")])
        pagina.evaluate = lambda js, *a, _o=pagina.evaluate: (
            _o(js, *a) if js in (rotina.JS_LER_GRADE, rotina.JS_LER_ULTIMO_LOGON)
            else {"cabecalho": "", "nomes": [], "carregando": True, "vazia": False}
        )
        with patch.object(automacao, "CARREGAMENTO_MS", 50), self.assertRaises(automacao.RotinaErro):
            rotina.processar_pendencia(pagina, automacao, pendencia())
        self.assertEqual(self._decisoes(), [])

    def test_anotacao_acrescenta_sem_duplicar(self):
        self.linha["anotacao"] = "nota do usuário"
        pagina = PaginaEndpoint([computador("OUTRO", "ZZZ")])
        rotina.processar_pendencia(pagina, automacao, pendencia())
        [texto] = self._anotacoes()
        self.assertTrue(texto.startswith("nota do usuário\n[Verificação automática"))

    def test_anotacao_busca_em_historico_antigo_e_usa_o_mais_recente(self):
        eventos = [{"id": f"ev{n}"} for n in range(1, 31)]
        detalhes = {e["id"]: {"evento": {"comparacao": {"mudancas_usuarios": []}}} for e in eventos}
        antigo = dict(self.linha, anotacao_id="antigo")
        recente = dict(self.linha, anotacao_id="recente")
        detalhes["ev25"]["evento"]["comparacao"]["mudancas_usuarios"] = [recente]
        detalhes["ev30"]["evento"]["comparacao"]["mudancas_usuarios"] = [antigo]

        def api(_automacao, metodo, caminho, corpo=None):
            self.chamadas.append((metodo, caminho, corpo))
            if caminho == "/api/historico-comparacoes":
                return {"eventos": eventos}
            return detalhes.get(caminho.rsplit("/", 1)[-1], {})

        with patch.object(rotina, "chamar_api", api):
            achado = rotina.localizar_linha_anotacao(automacao, "p1")
        self.assertEqual((achado["evento_id"], achado["linha"]["anotacao_id"]), ("ev25", "recente"))

    def test_anotacao_sem_linha_no_historico_avisa_e_nao_grava(self):
        def api(_automacao, metodo, caminho, corpo=None):
            self.chamadas.append((metodo, caminho, corpo))
            if caminho == "/api/historico-comparacoes":
                return {"eventos": [{"id": "ev1"}]}
            return {"evento": {"comparacao": {"mudancas_usuarios": []}}}

        with patch.object(rotina, "chamar_api", api):
            gravou = rotina.anotar(automacao, {"id": "p1", "serie": "BRJ0000TST"}, "texto")
        self.assertFalse(gravou)
        self.assertFalse([c for c in self.chamadas if c[0] == "PUT"])
        avisos = [c.args[1] for c in automacao.log.call_args_list if "[AVISO]" in c.args[1]]
        self.assertTrue(any("BRJ0000TST" in a and "não gravada" in a for a in avisos))

    def test_rotina_deixa_a_aba_filtrada_pelo_hostname_da_ultima(self):
        pagina = PaginaEndpoint([computador("HOST-1", "BRJ0000TST", "carla")])
        pagina.close = Mock()
        pendencias = [pendencia(atual="carla")]
        with patch.object(rotina, "listar_pendencias", return_value=pendencias), \
                patch.object(automacao, "nova_aba", return_value=pagina), \
                patch.object(automacao, "aguardar_login"), patch.object(automacao, "endpoint_logado"):
            codigo = rotina.verificar_usuarios_endpoint(Mock(), automacao)
        self.assertEqual(codigo, 0)
        self.assertEqual(pagina.filtros.get(0), "HOST-1")
        pagina.close.assert_not_called()

    def test_sem_pendencias_nao_abre_o_endpoint(self):
        with patch.object(rotina, "listar_pendencias", return_value=[]), patch.object(automacao, "nova_aba") as aba:
            self.assertEqual(rotina.verificar_usuarios_endpoint(Mock(), automacao), 0)
        aba.assert_not_called()


if __name__ == "__main__":
    unittest.main()
