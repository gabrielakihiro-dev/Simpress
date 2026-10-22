"""Rotina "Verificar usuários": decisão, grade do Endpoint e Sistema > Usuários, sem navegador real."""

import unittest
from unittest.mock import Mock, patch

from scripts import automacao_rotinas_chrome as automacao
from scripts import verificar_usuarios_endpoint as rotina

COLUNAS = (("Nome do computador", 0, 100), ("Rótulo de serviço/Número de série", 100, 200), ("Usuários logados", 200, 300))


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
    def __init__(self, pagina):
        super().__init__(pagina)

    def count(self):
        return 1 if self.pagina.campo_aberto else 0

    def press(self, tecla):
        if tecla == "Control+A":
            self.pagina.selecionado = True
        elif tecla == "Backspace":
            self.pagina.buffer = "" if self.pagina.selecionado else self.pagina.buffer[:-1]
            self.pagina.selecionado = False
        elif tecla == "Enter" and not self.pagina.surda:
            self.pagina.filtros[self.pagina.coluna_aberta] = self.pagina.buffer

    def press_sequentially(self, texto, delay=0):
        self.pagina.buffer += texto

    def input_value(self):
        return self.pagina.buffer


class Lupa(Elemento):
    def __init__(self, pagina, indice):
        super().__init__(pagina)
        self.indice = indice

    def bounding_box(self):
        _, x0, x1 = COLUNAS[self.indice]
        return {"x": x1 - 20, "y": 0, "width": 10, "height": 10}

    def click(self):
        p = self.pagina
        p.campo_aberto, p.coluna_aberta = True, self.indice
        p.buffer = p.filtros.get(self.indice, "")


class Lupas:
    def __init__(self, pagina):
        self.pagina = pagina

    def count(self):
        return len(COLUNAS)

    def nth(self, i):
        return Lupa(self.pagina, i)


class Teclado:
    def __init__(self, pagina):
        self.pagina = pagina

    def press(self, tecla):
        if tecla == "Escape":
            self.pagina.campo_aberto = False


class PaginaEndpoint:
    """Endpoint falso: grade filtrável por coluna, detalhe do computador e Sistema > Usuários.

    ``surda`` simula o Enter que não aplica o filtro (valor não registrado pelo componente)."""

    def __init__(self, computadores, usuarios_sistema=None, surda=False, aba_ausente=None):
        self.computadores = computadores
        self.usuarios_sistema = usuarios_sistema or {}
        self.surda, self.aba_ausente = surda, aba_ausente
        self.keyboard = Teclado(self)
        self.visitas, self.historico_abas = [], []
        self.url = automacao.ENDPOINT_URL
        self.reiniciar()

    def reiniciar(self):
        self.filtros, self.buffer, self.selecionado = {}, "", False
        self.campo_aberto, self.coluna_aberta = False, None
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
            return CampoFiltro(self)
        if "_searchButton" in seletor:
            return Lupas(self)
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
                    {"texto": c[campo], "x0": COLUNAS[i][1], "x1": COLUNAS[i][2], "href": c["href"] if i == 0 else ""}
                    for i, campo in enumerate(("nome", "serie", "usuarios"))
                ]
                for c in self._visiveis()
            ]
            if self.detalhe:
                return {"cabecalhos": [], "linhas": [], "carregando": False, "vazia": False}
            return {
                "cabecalhos": [{"texto": t, "x0": x0, "x1": x1} for t, x0, x1 in COLUNAS],
                "linhas": linhas, "carregando": False, "vazia": not linhas,
            }
        if self.detalhe and self.abas[-2:] == ["Sistema", "Usuários"]:
            nomes = self.usuarios_sistema.get(self.detalhe["nome"], [])
            return {"cabecalho": "nome do usuario", "nomes": nomes, "carregando": False, "vazia": not nomes}
        return {"cabecalho": "", "nomes": [], "carregando": False, "vazia": False}


def computador(nome, serie, usuarios="", href=None):
    return {"nome": nome, "serie": serie, "usuarios": usuarios, "href": href or f"#/uems/inventory/computers/{abs(hash(nome)) % 9999}"}


def pendencia(tipo="usuario_ausente", serie="BRJ0000TST", atual="carla", endpoint="", computador_="HOST-1"):
    return {"id": "p1", "serie": serie, "computador": computador_, "tipo": tipo, "estado": "pendente",
            "usuario_atual": atual, "usuario_endpoint": endpoint}


class AmbienteBase(unittest.TestCase):
    def setUp(self):
        for alvo in ("sleep",):
            patcher = patch.object(rotina.time, alvo, lambda *_: None)
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
        self.assertIsNone(rotina.avaliar_decisao(p, True, "davi").decisao)
        sem = rotina.avaliar_decisao(p, True, "", "Sistema", True)
        self.assertEqual((sem.decisao, bool(sem.aviso)), ("remover", True))
        ausente = rotina.avaliar_decisao(p, False, "")
        self.assertEqual((ausente.decisao, bool(ausente.aviso)), ("remover", True))

    def test_tabela_de_decisao_substituicao_manual(self):
        p = pendencia("substituicao_manual", atual="carla", endpoint="davi")
        self.assertEqual(rotina.avaliar_decisao(p, True, "DOM\\davi").decisao, "permitir")
        self.assertIsNone(rotina.avaliar_decisao(p, True, "carla").decisao)
        sem = rotina.avaliar_decisao(p, True, "", "Sistema", True)
        self.assertEqual((sem.decisao, bool(sem.aviso)), ("recusar", True))
        self.assertEqual(rotina.avaliar_decisao(p, False, "").decisao, "recusar")

    def test_sem_consultar_sistema_fica_pendente_e_anota(self):
        r = rotina.avaliar_decisao(pendencia(), True, "", sistema_consultado=False)
        self.assertIsNone(r.decisao)
        self.assertIn("Sistema > Usuários não consultado", r.anotacao)

    def test_escolha_de_usuarios(self):
        self.assertEqual(rotina.escolher_usuario_lista("NA, Administrador, ana, bia"), "ana")
        self.assertEqual(rotina.escolher_usuario_lista("--"), "")
        self.assertEqual(rotina.escolher_usuario_sistema(["", "root", "Convidado", "WDAGUtilityAccount", "davi", "ana"]), "davi")
        self.assertEqual(rotina.escolher_usuario_sistema(["Administrador", "DefaultAccount", "N/A"]), "")

    def test_serie_sem_s_so_para_serie_com_s(self):
        self.assertEqual(rotina.serie_sem_s("SCMVXKV7YCM"), "CMVXKV7YCM")
        self.assertEqual(rotina.serie_sem_s("BRJ123"), "BRJ123"[0:0] or "")
        self.assertEqual(rotina.serie_sem_s("S"), "")


class GradeTest(AmbienteBase):
    def test_filtro_digitado_e_confirmado(self):
        pagina = PaginaEndpoint([computador("H1", "AAA1"), computador("H2", "BBB2")])
        grade = rotina.aplicar_filtro(pagina, automacao, "numero de serie", "AAA1")
        self.assertEqual([l[0]["texto"] for l in grade["linhas"]], ["H1"])

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

    def test_outro_usuario_no_sistema_deixa_pendente_so_anota(self):
        pagina = PaginaEndpoint([computador("HOST-1", "BRJ0000TST", "--")], {"HOST-1": ["davi"]})
        rotina.processar_pendencia(pagina, automacao, pendencia(atual="carla"))
        self.assertEqual(self._decisoes(), [])
        self.assertIn("outro usuário (davi)", self._anotacoes()[0])

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

    def test_usuario_logado_da_grade_nao_abre_detalhe(self):
        pagina = PaginaEndpoint([computador("HOST-1", "BRJ0000TST", "Administrador, carla")])
        rotina.processar_pendencia(pagina, automacao, pendencia(atual="carla"))
        self.assertEqual(self._decisoes(), ["manter"])
        self.assertEqual(pagina.abas_clicadas, [])

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
            {"cabecalho": "", "nomes": [], "carregando": True, "vazia": False} if js != rotina.JS_LER_GRADE else _o(js, *a)
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
