"""Camada de Excel da rotina Sebrae (Fase C) com uma grade falsa em memória; nenhum Dashboard real é tocado."""

import tempfile
import unittest
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence, Set, Tuple

from scripts import sebrae_excel as xl
from scripts.sebrae_excel import (
    AdaptadorExcel,
    Celula,
    DiarioGravacao,
    ExcelOnlinePlaywright,
    LeituraColunaC,
    LinhaLida,
)

LINHAS_TOTAIS = 30
COLUNAS_FORMULA = ("A", "R")
LINHA_VALIDA = {
    "C": "UTIC-2026-0200",
    "D": "Em Aberto",
    "F": "Impressora não imprime no setor financeiro",
    "G": "Maria da Silva",
    "H": "INCIDENTE",
    "M": "Sebrae",
    "O": "PR",
    "P": "21/10/2026 09:15",
}


def linha_valida(**alteracoes: str) -> Dict[str, str]:
    return {**LINHA_VALIDA, **alteracoes}


class GradeFalsa(AdaptadorExcel):
    """Planilha em memória: linhas 2-11 com chamados (4 e 5 ocultas por filtro) e 12-30 preparadas (fórmulas em A e R)."""

    def __init__(self, diario: DiarioGravacao, **opcoes: object) -> None:
        super().__init__(colunas_formula=COLUNAS_FORMULA, diario=diario, espera_salvo_s=0.0, **opcoes)  # type: ignore[arg-type]
        self.celulas: Dict[Tuple[int, str], str] = {}
        self.ocultas: Set[int] = {4, 5}
        self.escritas: List[Tuple[int, str, str]] = []
        self.leituras_c = 0
        self.salvo = True
        self.sessao_expirada = False
        self.leitura_so_visiveis = False
        self.filtros_restaurados = True
        self.corromper: Dict[str, str] = {}
        self.data_como_texto = False
        self.depois_de_escrever: Optional[Callable[[int, str, "GradeFalsa"], None]] = None
        self.falha_na_escrita: Optional[Tuple[int, BaseException]] = None
        self.ao_ler_linha: Optional[Callable[[int, Sequence[str], "GradeFalsa"], None]] = None
        self.celulas[(1, "C")] = "Chamado"
        for linha in range(2, 12):
            self.celulas[(linha, "C")] = f"UTIC-2026-{linha:04d}"
            self.celulas[(linha, "F")] = f"Descrição {linha}"
        self.celulas[(7, "C")] = "27371 / UTIC-2026-0094"
        for linha in range(2, LINHAS_TOTAIS + 1):
            self.celulas[(linha, "A")] = "=LIN()"
            self.celulas[(linha, "R")] = "=SE(P2<>\"\";1;0)"

    # -- primitivas --
    def garantir_sessao(self) -> None:
        if self.sessao_expirada:
            raise xl.SessaoExpiradaErro("login pedido")

    def ler_coluna_c(self) -> LeituraColunaC:
        self.garantir_sessao()
        self.leituras_c += 1
        linhas = [linha for linha in range(1, LINHAS_TOTAIS + 1) if not (self.leitura_so_visiveis and linha in self.ocultas)]
        valores = {linha: self.celulas[(linha, "C")] for linha in linhas if self.celulas.get((linha, "C"))}
        return LeituraColunaC(
            valores, len(linhas), LINHAS_TOTAIS,
            linhas_ocultas_lidas=0 if self.leitura_so_visiveis else len(self.ocultas),
            filtros_restaurados=self.filtros_restaurados,
        )

    def ler_celulas(self, linha: int, colunas: Sequence[str]) -> LinhaLida:
        if self.ao_ler_linha:
            self.ao_ler_linha(linha, colunas, self)
        celulas = {}
        for coluna in colunas:
            texto = self.celulas.get((linha, coluna), "")
            celulas[coluna] = Celula(texto, texto.startswith("="))
        return LinhaLida(linha, celulas, oculta=linha in self.ocultas)

    def escrever_celula(self, linha: int, coluna: str, valor: str) -> None:
        if self.falha_na_escrita and len(self.escritas) == self.falha_na_escrita[0]:
            raise self.falha_na_escrita[1]
        self.escritas.append((linha, coluna, valor))
        self.celulas[(linha, coluna)] = self.corromper.get(coluna, valor)
        if self.depois_de_escrever:
            self.depois_de_escrever(linha, coluna, self)

    def aguardar_salvo(self, timeout_s: float) -> bool:
        return self.salvo

    def celula_e_data(self, linha: int, coluna: str) -> Optional[bool]:
        return False if self.data_como_texto else None

    # -- apoio --
    def alvo(self) -> Dict[Tuple[int, str], str]:
        return {chave: valor for chave, valor in self.celulas.items() if chave[1] not in COLUNAS_FORMULA}

    def linha_ocupada(self, linha: int) -> bool:
        return any(self.celulas.get((linha, coluna)) for coluna in xl.COLUNAS_GRAVADAS)


class BaseGrade(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix=".sebrae-excel-test-")
        self.addCleanup(self.temp.cleanup)
        self.diario = DiarioGravacao(Path(self.temp.name) / "sebrae_excel_diario.json")
        self.grade = GradeFalsa(self.diario)

    def novo_motor(self) -> GradeFalsa:
        """Outra execução sobre a mesma planilha e o mesmo diário (como depois de uma queda)."""
        outra = GradeFalsa(self.diario)
        outra.celulas = self.grade.celulas
        outra.ocultas = self.grade.ocultas
        return outra

    def assertSoColunasGravadas(self, grade: GradeFalsa) -> None:
        for _linha, coluna, _valor in grade.escritas:
            self.assertIn(coluna, xl.COLUNAS_GRAVADAS)


class GravacaoFelizTests(BaseGrade):
    def test_grava_na_primeira_linha_preparada_e_so_nas_oito_colunas(self) -> None:
        antes = dict(self.grade.alvo())
        resultado = self.grade.gravar_chamado(linha_valida())
        self.assertEqual(resultado.situacao, xl.GRAVADO)
        self.assertTrue(resultado.incluido)
        self.assertEqual(resultado.linha, 12)
        self.assertEqual(resultado.pendentes, ())
        self.assertEqual([coluna for _l, coluna, _v in self.grade.escritas], list(xl.COLUNAS_GRAVADAS))
        self.assertSoColunasGravadas(self.grade)
        depois = self.grade.alvo()
        mudou = {chave for chave in depois if depois[chave] != antes.get(chave)}
        self.assertEqual({chave[0] for chave in mudou}, {12})
        for chave, valor in antes.items():
            self.assertEqual(depois[chave], valor)
        self.assertEqual(self.diario.abertas(), {})
        self.assertEqual(self.diario.caminho.exists(), True)

    def test_cpf_e_mascarado_antes_de_gravar_no_dashboard(self) -> None:
        resultado = self.grade.gravar_chamado(linha_valida(F="Notebook sem acesso. CPF 529.982.247-25"))
        self.assertEqual(resultado.situacao, xl.GRAVADO)
        self.assertEqual(self.grade.celulas[(12, "F")], "Notebook sem acesso. CPF ***.***.***-**")

    def test_cpf_e_mascarado_antes_de_persistir_no_diario(self) -> None:
        self.grade.falha_na_escrita = (1, RuntimeError("interrupção após a coluna C"))
        resultado = self.grade.gravar_chamado(linha_valida(F="Notebook sem acesso. CPF 52998224725"))
        self.assertEqual(resultado.situacao, xl.INTERROMPIDO)
        intencao = self.diario.intencao("UTIC-2026-0200")
        self.assertIsNotNone(intencao)
        self.assertEqual(intencao["valores"]["F"], "Notebook sem acesso. CPF ***.***.***-**")

    def test_segundo_envio_do_mesmo_chamado_e_duplicado(self) -> None:
        self.grade.gravar_chamado(linha_valida())
        escritas = len(self.grade.escritas)
        resultado = self.grade.gravar_chamado(linha_valida())
        self.assertEqual(resultado.situacao, xl.DUPLICADO)
        self.assertFalse(resultado.incluido)
        self.assertEqual(len(self.grade.escritas), escritas)

    def test_chamados_seguintes_usam_linhas_seguintes(self) -> None:
        self.grade.gravar_chamado(linha_valida())
        resultado = self.grade.gravar_chamado(linha_valida(C="UTIC-2026-0201"))
        self.assertEqual(resultado.linha, 13)

    def test_data_gravada_como_texto_e_divergencia(self) -> None:
        self.grade.data_como_texto = True
        resultado = self.grade.gravar_chamado(linha_valida())
        self.assertEqual(resultado.situacao, xl.DIVERGENTE)
        self.assertIn("P", resultado.pendentes)
        self.assertFalse(resultado.incluido)


class DuplicidadeTests(BaseGrade):
    def test_duplicidade_em_linha_oculta_por_filtro_nao_grava(self) -> None:
        self.grade.celulas[(4, "C")] = "UTIC-2026-0200"
        resultado = self.grade.gravar_chamado(linha_valida())
        self.assertEqual(resultado.situacao, xl.DUPLICADO)
        self.assertEqual(resultado.linha, 4)
        self.assertEqual(self.grade.escritas, [])

    def test_valor_composto_conta_como_duplicado(self) -> None:
        self.grade.celulas[(5, "C")] = "27371 / UTIC-2026-0200"
        self.assertIn("UTIC-2026-0200", self.grade.ler_numeros_coluna_c())
        resultado = self.grade.gravar_chamado(linha_valida())
        self.assertEqual(resultado.situacao, xl.DUPLICADO)
        self.assertEqual(self.grade.escritas, [])

    def test_composto_pre_existente_e_reconhecido(self) -> None:
        numeros = self.grade.ler_numeros_coluna_c()
        self.assertIn("UTIC-2026-0094", numeros)

    def test_leitura_que_perde_linhas_ocultas_e_rejeitada_sem_gravar(self) -> None:
        self.grade.celulas[(4, "C")] = "UTIC-2026-0200"
        self.grade.leitura_so_visiveis = True
        resultado = self.grade.gravar_chamado(linha_valida())
        self.assertEqual(resultado.situacao, xl.LEITURA_INCOMPLETA)
        self.assertTrue(resultado.interrompe_execucao)
        self.assertEqual(self.grade.escritas, [])
        with self.assertRaises(xl.LeituraIncompletaErro):
            self.grade.ler_numeros_coluna_c()

    def test_filtro_nao_restaurado_para_a_gravacao(self) -> None:
        self.grade.filtros_restaurados = False
        resultado = self.grade.gravar_chamado(linha_valida())
        self.assertEqual(resultado.situacao, xl.FILTRO_NAO_RESTAURADO)
        self.assertEqual(self.grade.escritas, [])

    def test_outra_pessoa_inclui_o_chamado_antes_da_releitura(self) -> None:
        self.grade.celulas[(12, "C")] = "UTIC-2026-0200"  # entrou depois da extração do SoftExpert
        resultado = self.grade.gravar_chamado(linha_valida())
        self.assertEqual(resultado.situacao, xl.DUPLICADO)
        self.assertEqual(self.grade.escritas, [])


class LinhaDisponivelTests(BaseGrade):
    def test_linha_ocupada_e_pulada_sem_alterar(self) -> None:
        self.grade.celulas[(12, "F")] = "rascunho de alguém"
        resultado = self.grade.gravar_chamado(linha_valida())
        self.assertEqual(resultado.linha, 13)
        self.assertEqual(self.grade.celulas[(12, "F")], "rascunho de alguém")
        self.assertFalse(any(linha == 12 for linha, _c, _v in self.grade.escritas))

    def test_linha_sem_formulas_nao_esta_preparada(self) -> None:
        for linha in range(12, LINHAS_TOTAIS + 1):
            del self.grade.celulas[(linha, "R")]
        resultado = self.grade.gravar_chamado(linha_valida())
        self.assertEqual(resultado.situacao, xl.SEM_LINHA)
        self.assertEqual(self.grade.escritas, [])

    def test_linha_oculta_nao_e_escolhida(self) -> None:
        self.grade.ocultas.add(12)
        self.assertEqual(self.grade.proxima_linha_livre(), 13)

    def test_sem_linha_dentro_do_limite_de_busca(self) -> None:
        self.assertEqual(self.grade.proxima_linha_livre(), 12)
        for linha in range(12, 12 + xl.LIMITE_BUSCA_LINHAS):
            self.grade.celulas[(linha, "F")] = "x"
        with self.assertRaises(xl.SemLinhaPreparadaErro):
            self.grade.proxima_linha_livre()

    def test_colunas_de_formula_nao_podem_ser_gravadas(self) -> None:
        with self.assertRaises(ValueError):
            AdaptadorExcel.__init__(self.grade, colunas_formula=("F",))


class EdicaoSimultaneaTests(BaseGrade):
    def test_linha_tomada_entre_a_leitura_e_a_escrita_nao_e_sobrescrita(self) -> None:
        def outra_pessoa(linha: int, colunas: Sequence[str], grade: GradeFalsa) -> None:
            if tuple(colunas) == ("C",) and linha == 12:
                grade.celulas[(12, "C")] = "UTIC-2026-0999"

        self.grade.ao_ler_linha = outra_pessoa
        resultado = self.grade.gravar_chamado(linha_valida())
        self.assertEqual(resultado.situacao, xl.PARCIAL)
        self.assertEqual(resultado.confirmados, ())
        self.assertEqual(self.grade.celulas[(12, "C")], "UTIC-2026-0999")
        self.assertEqual(self.grade.escritas, [])

    def test_celula_ocupada_no_meio_da_linha_registra_parcial_e_preserva_o_que_e_do_outro(self) -> None:
        def outra_pessoa(linha: int, colunas: Sequence[str], grade: GradeFalsa) -> None:
            if tuple(colunas) == ("G",):
                grade.celulas[(linha, "G")] = "Outro Nome"

        self.grade.ao_ler_linha = outra_pessoa
        resultado = self.grade.gravar_chamado(linha_valida())
        self.assertEqual(resultado.situacao, xl.PARCIAL)
        self.assertEqual(resultado.confirmados, ("C", "D", "F"))
        self.assertEqual(resultado.pendentes, ("G", "H", "M", "O", "P"))
        self.assertEqual(self.grade.celulas[(12, "G")], "Outro Nome")
        self.assertEqual(self.diario.intencao("UTIC-2026-0200")["estado"], xl.PARCIAL)
        self.assertTrue(resultado.interrompe_execucao)

    def test_apos_parcial_com_conflito_a_proxima_execucao_nao_sobrescreve(self) -> None:
        self.test_celula_ocupada_no_meio_da_linha_registra_parcial_e_preserva_o_que_e_do_outro()
        novo = self.novo_motor()
        resultado = novo.gravar_chamado(linha_valida())
        self.assertEqual(resultado.situacao, xl.DIVERGENTE)
        self.assertEqual(novo.escritas, [])
        self.assertEqual(novo.celulas[(12, "G")], "Outro Nome")


class QuedaERetomadaTests(BaseGrade):
    def test_queda_no_meio_registra_confirmados_e_pendentes(self) -> None:
        self.grade.falha_na_escrita = (2, ConnectionError("rede caiu"))
        resultado = self.grade.gravar_chamado(linha_valida())
        self.assertEqual(resultado.situacao, xl.INTERROMPIDO)
        self.assertEqual(resultado.confirmados, ("C", "D"))
        self.assertEqual(resultado.pendentes, ("F", "G", "H", "M", "O", "P"))
        self.assertFalse(resultado.incluido)
        self.assertIn("rede caiu", resultado.detalhe)
        self.assertIn("UTIC-2026-0200", self.diario.abertas())

    def test_retomada_completa_so_o_que_falta_na_mesma_linha(self) -> None:
        self.test_queda_no_meio_registra_confirmados_e_pendentes()
        novo = self.novo_motor()
        resultado = novo.gravar_chamado(linha_valida())
        self.assertEqual(resultado.situacao, xl.RECUPERADO)
        self.assertTrue(resultado.incluido)
        self.assertEqual(resultado.linha, 12)
        self.assertEqual([coluna for _l, coluna, _v in novo.escritas], ["F", "G", "H", "M", "O", "P"])
        self.assertEqual(novo.diario.abertas(), {})
        self.assertFalse(novo.linha_ocupada(13))

    def test_recuperar_pendencias_conclui_intencoes_abertas(self) -> None:
        self.test_queda_no_meio_registra_confirmados_e_pendentes()
        novo = self.novo_motor()
        resultados = novo.recuperar_pendencias()
        self.assertEqual([r.situacao for r in resultados], [xl.RECUPERADO])
        self.assertEqual(novo.recuperar_pendencias(), [])

    def test_retoma_diario_antigo_sem_status_em_aberto(self) -> None:
        self.grade.falha_na_escrita = (1, ConnectionError("rede caiu"))
        self.grade.gravar_chamado(linha_valida())
        antiga = dict(self.diario.intencao("UTIC-2026-0200")["valores"])
        antiga.pop("D")
        self.diario.atualizar("UTIC-2026-0200", valores=antiga)
        self.grade.falha_na_escrita = None

        resultado = self.novo_motor().recuperar_pendencias()[0]

        self.assertEqual(resultado.situacao, xl.RECUPERADO)
        self.assertEqual(self.grade.celulas[(12, "D")], "Em Aberto")

    def test_queda_antes_de_escrever_algo_e_abandonada_e_regrava_do_zero(self) -> None:
        self.grade.falha_na_escrita = (0, ConnectionError("rede caiu"))
        primeira = self.grade.gravar_chamado(linha_valida())
        self.assertEqual(primeira.situacao, xl.INTERROMPIDO)
        self.assertEqual(primeira.confirmados, ())
        novo = self.novo_motor()
        self.assertEqual([r.situacao for r in novo.recuperar_pendencias()], [xl.ABANDONADO])
        self.assertEqual(novo.escritas, [])
        resultado = novo.gravar_chamado(linha_valida())
        self.assertEqual(resultado.situacao, xl.GRAVADO)
        self.assertEqual(resultado.linha, 12)

    def test_intencao_de_linha_que_outro_ocupou_nao_e_retomada(self) -> None:
        self.grade.falha_na_escrita = (0, ConnectionError("rede caiu"))
        self.grade.gravar_chamado(linha_valida())
        self.grade.celulas[(12, "F")] = "texto de outra pessoa"
        novo = self.novo_motor()
        resultado = novo.gravar_chamado(linha_valida())
        self.assertEqual(resultado.situacao, xl.GRAVADO)
        self.assertEqual(resultado.linha, 13)
        self.assertEqual(novo.celulas[(12, "F")], "texto de outra pessoa")

    def test_chamado_que_apareceu_em_outra_linha_durante_a_queda_e_duplicado(self) -> None:
        self.test_queda_no_meio_registra_confirmados_e_pendentes()
        # Alguém apagou nossa linha parcial e incluiu o chamado mais abaixo.
        for coluna in xl.COLUNAS_GRAVADAS:
            self.grade.celulas.pop((12, coluna), None)
        self.grade.celulas[(20, "C")] = "UTIC-2026-0200"
        novo = self.novo_motor()
        resultado = novo.gravar_chamado(linha_valida())
        self.assertEqual(resultado.situacao, xl.DUPLICADO)
        self.assertEqual(resultado.linha, 20)
        self.assertEqual(novo.escritas, [])
        self.assertEqual(novo.diario.abertas(), {})

    def test_cancelamento_no_meio_nao_e_engolido_e_deixa_diario(self) -> None:
        class Cancelada(BaseException):
            pass

        self.grade.falha_na_escrita = (1, Cancelada())
        with self.assertRaises(Cancelada):
            self.grade.gravar_chamado(linha_valida())
        intencao = self.diario.intencao("UTIC-2026-0200")
        self.assertEqual(intencao["confirmados"], ["C"])


class ReleituraESalvoTests(BaseGrade):
    def test_autoformatacao_na_celula_e_divergencia_imediata(self) -> None:
        self.grade.corromper = {"H": "Incidente"}
        resultado = self.grade.gravar_chamado(linha_valida())
        self.assertEqual(resultado.situacao, xl.DIVERGENTE)
        self.assertEqual(resultado.confirmados, ("C", "D", "F", "G"))
        self.assertEqual(resultado.pendentes[0], "H")
        self.assertFalse(resultado.incluido)
        self.assertIn("UTIC-2026-0200", self.diario.abertas())

    def test_alteracao_posterior_detectada_na_releitura_final(self) -> None:
        def depois(linha: int, coluna: str, grade: GradeFalsa) -> None:
            if coluna == "P":
                grade.celulas[(linha, "G")] = "Alterado por outro"

        self.grade.depois_de_escrever = depois
        resultado = self.grade.gravar_chamado(linha_valida())
        self.assertEqual(resultado.situacao, xl.DIVERGENTE)
        self.assertEqual(resultado.pendentes, ("G",))
        self.assertNotIn("G", resultado.confirmados)

    def test_sem_indicador_salvo_nao_conta_e_proxima_execucao_confirma(self) -> None:
        self.grade.salvo = False
        resultado = self.grade.gravar_chamado(linha_valida())
        self.assertEqual(resultado.situacao, xl.NAO_SALVO)
        self.assertFalse(resultado.incluido)
        self.assertEqual(resultado.pendentes, ())
        novo = self.novo_motor()
        novo.salvo = True
        retomado = novo.gravar_chamado(linha_valida())
        self.assertEqual(retomado.situacao, xl.RECUPERADO)
        self.assertEqual(novo.escritas, [])
        self.assertEqual(novo.diario.abertas(), {})

    def test_zero_a_esquerda_e_texto_parecido_com_numero_ficam_como_texto(self) -> None:
        self.assertEqual(xl.texto_para_digitar("F", "=SOMA(A1)"), "'=SOMA(A1)")
        self.assertEqual(xl.texto_para_digitar("F", "-teste"), "'-teste")
        self.assertEqual(xl.texto_para_digitar("G", "00123"), "'00123")
        self.assertEqual(xl.texto_para_digitar("F", "12/05"), "'12/05")
        self.assertEqual(xl.texto_para_digitar("F", "Impressora parou"), "Impressora parou")
        self.assertEqual(xl.texto_para_digitar("P", "21/10/2026 09:15"), "21/10/2026 09:15")
        self.assertTrue(xl.valores_equivalentes("F", "=SOMA(A1)", "'=SOMA(A1)"))

    def test_data_equivalente_ignora_segundos_e_formato_de_entrada(self) -> None:
        self.assertTrue(xl.valores_equivalentes("P", "21/10/2026 09:15", "21/10/2026 09:15:00"))
        self.assertFalse(xl.valores_equivalentes("P", "21/10/2026 09:15", "21/10/2026 09:16:00"))


class SessaoTests(BaseGrade):
    def test_sessao_expirada_antes_de_tudo_nao_le_nem_grava(self) -> None:
        self.grade.sessao_expirada = True
        resultado = self.grade.gravar_chamado(linha_valida())
        self.assertEqual(resultado.situacao, xl.SESSAO_EXPIRADA)
        self.assertTrue(resultado.login_necessario)
        self.assertFalse(resultado.incluido)
        self.assertEqual(self.grade.escritas, [])

    def test_sessao_expirada_no_meio_registra_parcial_sem_concluir(self) -> None:
        self.grade.falha_na_escrita = (3, xl.SessaoExpiradaErro("login pedido"))
        resultado = self.grade.gravar_chamado(linha_valida())
        self.assertEqual(resultado.situacao, xl.SESSAO_EXPIRADA)
        self.assertEqual(resultado.confirmados, ("C", "D", "F"))
        self.assertEqual(resultado.pendentes, ("G", "H", "M", "O", "P"))
        self.assertFalse(resultado.incluido)

    def test_deteccao_de_login_pela_url_e_pelo_texto(self) -> None:
        self.assertTrue(xl.url_de_login("https://login.microsoftonline.com/common/oauth2/authorize?x=1"))
        self.assertTrue(xl.url_de_login("https://sebraepr.sharepoint.com/_layouts/15/Authenticate.aspx?Source=%2F"))
        self.assertFalse(xl.url_de_login("https://sebraepr.sharepoint.com/:x:/r/sites/ti/Dashboard.xlsx?web=1"))
        self.assertTrue(xl.texto_de_sessao_expirada("Sua sessão expirou. Entrar novamente"))
        self.assertTrue(xl.texto_de_sessao_expirada("Your session has timed out"))
        self.assertFalse(xl.texto_de_sessao_expirada("Descrição: impressora parou"))


class ValidacaoTests(BaseGrade):
    def test_linhas_invalidas_nao_tocam_o_dashboard(self) -> None:
        casos = [
            {k: v for k, v in LINHA_VALIDA.items() if k != "P"},
            {**LINHA_VALIDA, "X": "1"},
            linha_valida(M="Outro"),
            linha_valida(O="SC"),
            linha_valida(D="Em Atendimento"),
            linha_valida(H="OUTRO"),
            linha_valida(P="2026-10-21 09:15"),
            linha_valida(P="31/02/2026 09:15"),
            linha_valida(C="27371 / UTIC-2026-0094"),
            linha_valida(G="   "),
            linha_valida(F="x" * (xl.LIMITE_CARACTERES_CELULA + 1)),
        ]
        for caso in casos:
            with self.subTest(caso=str(caso)[:60]):
                resultado = self.grade.gravar_chamado(caso)
                self.assertEqual(resultado.situacao, xl.INVALIDO)
                self.assertFalse(resultado.interrompe_execucao)
        self.assertEqual(self.grade.escritas, [])
        self.assertEqual(self.grade.leituras_c, 0)

    def test_quebras_de_linha_da_descricao_sao_preservadas_ou_viram_espaco(self) -> None:
        self.assertEqual(xl.normalizar_valor("F", "linha 1\r\n  linha   2 "), "linha 1\nlinha 2")
        self.assertEqual(xl.normalizar_valor("F", "linha 1\nlinha 2", quebras_como_espaco=True), "linha 1 linha 2")
        self.assertEqual(xl.normalizar_valor("G", "Maria\n da  Silva"), "Maria da Silva")
        resultado = self.grade.gravar_chamado(linha_valida(F="Primeira\nSegunda"))
        self.assertEqual(resultado.situacao, xl.GRAVADO)
        self.assertEqual(self.grade.celulas[(12, "F")], "Primeira\nSegunda")


class DiarioTests(BaseGrade):
    def test_caminho_padrao_fica_em_data_state_fora_do_git(self) -> None:
        self.assertEqual(xl.DIARIO_ARQUIVO.parent.name, "state")
        self.assertEqual(xl.DIARIO_ARQUIVO.parent.parent.name, "data")

    def test_historico_e_limitado(self) -> None:
        for indice in range(xl.HISTORICO_DIARIO + 5):
            numero = f"UTIC-2026-{indice + 1:04d}"
            self.diario.registrar(numero, 12, LINHA_VALIDA)
            self.diario.fechar(numero, "concluida")
        self.assertEqual(len(self.diario._carregar()["historico"]), xl.HISTORICO_DIARIO)

    def test_diario_ilegivel_interrompe_sem_gravar(self) -> None:
        self.diario.caminho.write_text("{ nao e json", encoding="utf-8")
        resultado = self.grade.gravar_chamado(linha_valida())
        self.assertEqual(resultado.situacao, xl.INTERROMPIDO)
        self.assertEqual(self.grade.escritas, [])


class LeituraDaColunaTests(unittest.TestCase):
    def test_analise_do_texto_copiado_mantem_o_numero_das_linhas(self) -> None:
        copiado = 'Chamado\r\nUTIC-2026-0002\r\n\r\n"27371 /\r\nUTIC-2026-0094"\r\nUTIC-2026-0006\r\n'
        valores, cobertas = xl.valores_da_coluna(copiado)
        self.assertEqual(cobertas, 5)
        self.assertEqual(valores, {1: "Chamado", 2: "UTIC-2026-0002", 4: "27371 / UTIC-2026-0094", 5: "UTIC-2026-0006"})

    def test_cobertura_menor_que_a_ultima_linha_indica_linhas_perdidas(self) -> None:
        _valores, cobertas = xl.valores_da_coluna("Chamado\r\nUTIC-2026-0002\r\n")
        self.assertLess(cobertas, 30)

    def test_enderecos(self) -> None:
        self.assertEqual(xl.endereco("P", 12), "P12")


class PlaywrightLeituraTests(unittest.TestCase):
    """O fluxo de filtro temporário de ``ExcelOnlinePlaywright.ler_coluna_c``, sem navegador."""

    class Sem(ExcelOnlinePlaywright):
        def __init__(self, copias: List[str], falha_ao_fechar: bool = False, erro_na_copia: bool = False) -> None:
            super().__init__(page=None, colunas_formula=("A",), log=lambda texto: None)  # type: ignore[arg-type]
            self.copias = list(copias)
            self.eventos: List[str] = []
            self.falha_ao_fechar = falha_ao_fechar
            self.erro_na_copia = erro_na_copia

        def garantir_sessao(self) -> None:
            self.eventos.append("sessao")

        def _ultima_linha_usada(self) -> int:
            return 5

        def _copiar_coluna_c(self, ultima_linha: int) -> str:
            self.eventos.append("copiar")
            if self.erro_na_copia and "abrir" in self.eventos:
                raise xl.LeituraIncompletaErro("cópia falhou")
            return self.copias.pop(0)

        def _abrir_exibicao_temporaria(self) -> None:
            self.eventos.append("abrir")

        def _fechar_exibicao_temporaria(self) -> None:
            self.eventos.append("fechar")
            if self.falha_ao_fechar:
                raise xl.FiltroNaoRestauradoErro("continua aberta")

    COMPLETA = "Chamado\r\nUTIC-2026-0002\r\n\r\nUTIC-2026-0004\r\n\r\n"
    FILTRADA = "Chamado\r\nUTIC-2026-0002\r\n"

    def test_leitura_completa_nao_abre_exibicao_temporaria(self) -> None:
        adaptador = self.Sem([self.COMPLETA])
        leitura = adaptador.ler_coluna_c()
        self.assertEqual(leitura.linhas_cobertas, 5)
        self.assertNotIn("abrir", adaptador.eventos)

    def test_leitura_filtrada_usa_exibicao_temporaria_e_a_fecha(self) -> None:
        adaptador = self.Sem([self.FILTRADA, self.COMPLETA])
        leitura = adaptador.ler_coluna_c()
        self.assertEqual(leitura.numeros, {"UTIC-2026-0002", "UTIC-2026-0004"})
        self.assertEqual(adaptador.eventos[-3:], ["abrir", "copiar", "fechar"])
        self.assertTrue(leitura.filtros_restaurados)

    def test_exibicao_temporaria_e_fechada_mesmo_se_a_copia_falha(self) -> None:
        adaptador = self.Sem([self.FILTRADA, self.COMPLETA], erro_na_copia=True)
        with self.assertRaises(xl.LeituraIncompletaErro):
            adaptador.ler_coluna_c()
        self.assertEqual(adaptador.eventos[-1], "fechar")

    def test_falha_ao_restaurar_para_a_rotina(self) -> None:
        adaptador = self.Sem([self.FILTRADA, self.COMPLETA], falha_ao_fechar=True)
        with self.assertRaises(xl.FiltroNaoRestauradoErro):
            adaptador.ler_coluna_c()


if __name__ == "__main__":
    unittest.main()
