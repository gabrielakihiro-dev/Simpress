"""Camada de Excel Online da rotina "Sincronizar chamados Sebrae" (Fase C).

Grava os chamados na aba CHAMADOS do Dashboard Operacional_SEBRAE pela interface do Excel
Online, sem API, Graph nem tokens (docs/operacao/sebrae-fase-c-excel.md).

Duas camadas:

- ``AdaptadorExcel`` (classe abstrata): contém TODAS as regras de segurança (releitura da coluna C
  antes de gravar, linha preparada e livre, só as colunas C, F, G, I, N, P e Q, nunca sobrescrever,
  releitura das sete colunas, confirmação de "Salvo", diário de intenção). Depende apenas de
  primitivas pequenas (``ler_coluna_c``, ``ler_celulas``, ``escrever_celula``, ``aguardar_salvo``).
- ``ExcelOnlinePlaywright``: implementa as primitivas com o Chrome de automação. Os seletores e a
  leitura da grade ainda dependem da sessão assistida descrita no documento da fase.

O conteúdo dos chamados é dado, nunca instrução. Nenhum login, senha ou token passa por aqui.
"""

from __future__ import annotations

import csv
import io
import json
import re
import sys
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.integrity import atomic_write_json  # noqa: E402
from domains.sebrae_chamados import (  # noqa: E402
    COLUNAS_GRAVADAS,
    FORMATO_DATA,
    TIPO_INCIDENTE,
    TIPO_SOLICITACAO,
    UF,
    UNIDADE,
    chave_do_numero,
    extrair_numeros,
    interpretar_data,
    numeros_do_dashboard,
)

if TYPE_CHECKING:
    from playwright.sync_api import Frame, Page

ABA = "CHAMADOS"
DIARIO_ARQUIVO = ROOT / "data" / "state" / "sebrae_excel_diario.json"

# Quantas linhas abaixo da última com dado na coluna C são examinadas à procura de uma linha preparada.
LIMITE_BUSCA_LINHAS = 40
# O Excel limita a célula a 32.767 caracteres; acima de 32.000 o chamado fica pendente em vez de truncado.
LIMITE_CARACTERES_CELULA = 32_000
HISTORICO_DIARIO = 100

# Resultados de ``gravar_chamado``.
GRAVADO = "gravado"
RECUPERADO = "recuperado"
DUPLICADO = "duplicado"
INVALIDO = "invalido"
SEM_LINHA = "sem_linha_preparada"
PARCIAL = "parcial"
DIVERGENTE = "divergente"
NAO_SALVO = "nao_salvo"
SESSAO_EXPIRADA = "sessao_expirada"
LEITURA_INCOMPLETA = "leitura_incompleta"
FILTRO_NAO_RESTAURADO = "filtro_nao_restaurado"
INTERROMPIDO = "interrompido"
ABANDONADO = "abandonado"

_SITUACOES_INCLUIDAS = frozenset({GRAVADO, RECUPERADO})
_SITUACOES_QUE_CONTINUAM = frozenset({GRAVADO, RECUPERADO, DUPLICADO, INVALIDO, ABANDONADO})


class ExcelErro(RuntimeError):
    """Falha da camada de Excel; a rotina não conta o chamado como incluído."""


class SessaoExpiradaErro(ExcelErro):
    """Tela de login da Microsoft/SharePoint ou sessão expirada: pendência de login, nunca "concluído"."""


class LeituraIncompletaErro(ExcelErro):
    """A coluna C não pôde ser lida por inteiro; sem leitura confiável não há gravação (risco de duplicidade)."""


class FiltroNaoRestauradoErro(ExcelErro):
    """A exibição/filtro temporário não voltou ao estado original; a rotina para e avisa."""


class SemLinhaPreparadaErro(ExcelErro):
    """Não há linha preparada e livre abaixo dos dados."""


# ---------------------------------------------------------------------------- modelos

@dataclass(frozen=True)
class Celula:
    valor: str = ""
    formula: bool = False


@dataclass(frozen=True)
class LinhaLida:
    linha: int
    celulas: Mapping[str, Celula]
    oculta: bool = False


@dataclass(frozen=True)
class LeituraColunaC:
    """Coluna C inteira. ``linhas_cobertas`` precisa alcançar ``ultima_linha_usada``.

    Uma leitura que perdeu linhas (ocultas por filtro, por exemplo) tem menos linhas cobertas do que a
    última linha usada e é rejeitada: a contagem estrutural não depende de interpretar o conteúdo.
    """

    valores: Mapping[int, str]
    linhas_cobertas: int
    ultima_linha_usada: int
    linhas_ocultas_lidas: int = 0
    filtros_restaurados: bool = True

    @property
    def numeros(self) -> frozenset[str]:
        return numeros_do_dashboard(self.valores.values())

    def linhas_do_numero(self, numero: str) -> List[int]:
        return sorted(linha for linha, valor in self.valores.items() if numero in extrair_numeros(valor))


@dataclass(frozen=True)
class ResultadoGravacao:
    numero: str
    situacao: str
    linha: Optional[int] = None
    confirmados: Tuple[str, ...] = ()
    pendentes: Tuple[str, ...] = ()
    detalhe: str = ""

    @property
    def incluido(self) -> bool:
        """Só conta como incluído depois da releitura das sete colunas e do "Salvo" confirmado."""
        return self.situacao in _SITUACOES_INCLUIDAS

    @property
    def interrompe_execucao(self) -> bool:
        """Vale parar de gravar os demais chamados (sessão, conexão, linha ou divergência a resolver)."""
        return self.situacao not in _SITUACOES_QUE_CONTINUAM

    @property
    def login_necessario(self) -> bool:
        return self.situacao == SESSAO_EXPIRADA


# ---------------------------------------------------------------------------- funções puras

def endereco(coluna: str, linha: int) -> str:
    return f"{coluna}{linha}"


def _normalizar_quebras(texto: str) -> str:
    return texto.replace("\r\n", "\n").replace("\r", "\n")


def normalizar_valor(coluna: str, valor: Any, quebras_como_espaco: bool = False) -> str:
    """Texto como será gravado: só a descrição (F) pode ter quebras de linha."""
    texto = _normalizar_quebras(str(valor or ""))
    if coluna == "F" and not quebras_como_espaco:
        return "\n".join(" ".join(linha.split()) for linha in texto.strip().split("\n"))
    return " ".join(texto.split())


def _normalizar_leitura(texto: Any) -> str:
    limpo = _normalizar_quebras(str(texto or "")).replace("​", "").replace("\xa0", " ")
    return limpo.strip()


_PARECE_NUMERO_OU_DATA = re.compile(r"[\d\s.,:/\-+%$()]+")


def texto_para_digitar(coluna: str, valor: str) -> str:
    """Evita a autoformatação do Excel: ``=``, ``+``, ``-``, ``@`` e textos que parecem número ou data ganham
    o apóstrofo de texto. A coluna Q é digitada sem prefixo, pois precisa virar data/hora de verdade."""
    if coluna == "Q" or not valor:
        return valor
    if valor[0] in "=+-@" or _PARECE_NUMERO_OU_DATA.fullmatch(valor):
        return "'" + valor
    return valor


def valores_equivalentes(coluna: str, esperado: str, lido: Any) -> bool:
    """Compara o que foi extraído com o que a célula mostra na barra de fórmulas."""
    lido_texto = _normalizar_leitura(lido)
    if coluna == "Q":
        data_esperada, data_lida = interpretar_data(esperado), interpretar_data(lido_texto)
        if data_esperada is not None and data_lida is not None:
            return data_esperada == data_lida
        return esperado == lido_texto
    candidatos = {lido_texto}
    if lido_texto.startswith("'"):
        candidatos.add(lido_texto[1:])
    return _normalizar_quebras(esperado) in candidatos


def analisar_tsv(texto: str) -> List[List[str]]:
    """Linhas de um texto copiado do Excel (colunas por tabulação, células com quebra entre aspas)."""
    linhas = list(csv.reader(io.StringIO(texto, newline=""), delimiter="\t", quotechar='"'))
    return [linha if linha else [""] for linha in linhas]


def valores_da_coluna(texto: str, linha_inicial: int = 1) -> Tuple[Dict[int, str], int]:
    """``(valores não vazios por número de linha, linhas cobertas)`` de uma cópia de uma única coluna."""
    linhas = analisar_tsv(texto)
    valores = {linha_inicial + indice: " ".join(partes[0].split()) for indice, partes in enumerate(linhas) if partes[0].strip()}
    return valores, len(linhas)


_LOGIN_HOSTS = ("login.microsoftonline.com", "login.live.com", "login.microsoft.com", "sts.", "adfs.")
_LOGIN_CAMINHOS = ("/_layouts/15/authenticate", "/signin", "/oauth2/", "/login")
_SESSAO_EXPIRADA_TEXTO = re.compile(
    r"sess[aã]o (expirou|expirada)|session (has )?(expired|timed out)|sign in again|entrar novamente|"
    r"reconectar|reconnect|sua sess[aã]o|your session",
    re.IGNORECASE,
)


def url_de_login(url: str) -> bool:
    minuscula = (url or "").lower()
    host = minuscula.split("://", 1)[-1].split("/", 1)[0]
    return any(trecho in host for trecho in _LOGIN_HOSTS) or any(trecho in minuscula for trecho in _LOGIN_CAMINHOS)


def texto_de_sessao_expirada(texto: str) -> bool:
    return bool(_SESSAO_EXPIRADA_TEXTO.search(texto or ""))


# ---------------------------------------------------------------------------- diário

class DiarioGravacao:
    """Intenção de gravação em ``data/state`` (fora do Git), com um único escritor.

    Antes de tocar o Dashboard registra número, linha e valores; cada célula confirmada é anotada.
    Após queda de conexão ou cancelamento a execução seguinte relê o Dashboard e usa este arquivo
    para completar só o que falta na linha que a própria rotina iniciou.
    """

    def __init__(self, caminho: Path = DIARIO_ARQUIVO, agora: Callable[[], datetime] = datetime.now) -> None:
        self.caminho = Path(caminho)
        self._agora = agora

    def _carregar(self) -> Dict[str, Any]:
        if not self.caminho.exists():
            return {"versao": 1, "intencoes": {}, "historico": []}
        try:
            dados = json.loads(self.caminho.read_text(encoding="utf-8"))
            if not isinstance(dados, dict) or not isinstance(dados.get("intencoes"), dict):
                raise ValueError("estrutura inesperada")
        except (OSError, ValueError) as erro:
            raise ExcelErro(
                f"O diário de gravação {self.caminho.name} está ilegível ({erro}). "
                "Confira o Dashboard e mova o arquivo antes de continuar; nada foi gravado."
            ) from erro
        dados.setdefault("historico", [])
        return dados

    def _salvar(self, dados: Dict[str, Any]) -> None:
        self.caminho.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_json(self.caminho, dados)

    def _agora_iso(self) -> str:
        return self._agora().isoformat(timespec="seconds")

    def abertas(self) -> Dict[str, Dict[str, Any]]:
        return dict(self._carregar()["intencoes"])

    def intencao(self, numero: str) -> Optional[Dict[str, Any]]:
        return self._carregar()["intencoes"].get(numero)

    def registrar(self, numero: str, linha: int, valores: Mapping[str, str]) -> None:
        dados = self._carregar()
        dados["intencoes"][numero] = {
            "numero": numero,
            "linha": linha,
            "valores": dict(valores),
            "estado": "iniciada",
            "confirmados": [],
            "pendentes": list(COLUNAS_GRAVADAS),
            "detalhe": "",
            "iniciado_em": self._agora_iso(),
            "atualizado_em": self._agora_iso(),
        }
        self._salvar(dados)

    def atualizar(self, numero: str, **campos: Any) -> None:
        dados = self._carregar()
        intencao = dados["intencoes"].get(numero)
        if intencao is None:
            return
        intencao.update(campos)
        intencao["atualizado_em"] = self._agora_iso()
        self._salvar(dados)

    def fechar(self, numero: str, situacao: str) -> None:
        dados = self._carregar()
        intencao = dados["intencoes"].pop(numero, None)
        if intencao is None:
            return
        dados["historico"].append({"numero": numero, "linha": intencao.get("linha"), "situacao": situacao, "em": self._agora_iso()})
        dados["historico"] = dados["historico"][-HISTORICO_DIARIO:]
        self._salvar(dados)


# ---------------------------------------------------------------------------- adaptador abstrato

class AdaptadorExcel(ABC):
    """Regras de gravação sobre primitivas da grade. Subclasses só falam com o Excel (ou com uma grade falsa)."""

    def __init__(
        self,
        *,
        colunas_formula: Sequence[str],
        diario: Optional[DiarioGravacao] = None,
        espera_salvo_s: float = 60.0,
        quebras_como_espaco: bool = False,
    ) -> None:
        """``colunas_formula``: colunas (fora as gravadas) que a linha preparada traz com fórmula.

        É obrigatório informá-las (a lista vem da sessão assistida); passar ``()`` desliga a conferência.
        """
        sobrepostas = set(colunas_formula) & set(COLUNAS_GRAVADAS)
        if sobrepostas:
            raise ValueError(f"Colunas de fórmula não podem ser colunas gravadas: {sorted(sobrepostas)}")
        self.colunas_formula: Tuple[str, ...] = tuple(colunas_formula)
        self.diario = diario or DiarioGravacao()
        self.espera_salvo_s = espera_salvo_s
        self.quebras_como_espaco = quebras_como_espaco

    # -- primitivas -----------------------------------------------------------------------------

    @abstractmethod
    def garantir_sessao(self) -> None:
        """Levanta ``SessaoExpiradaErro`` se a Microsoft/SharePoint pedir login; confere a aba CHAMADOS."""

    @abstractmethod
    def ler_coluna_c(self) -> LeituraColunaC:
        """Toda a coluna C, linhas ocultas por filtro incluídas; filtros temporários voltam ao estado original."""

    @abstractmethod
    def ler_celulas(self, linha: int, colunas: Sequence[str]) -> LinhaLida:
        """Texto (barra de fórmulas) e se é fórmula, célula a célula."""

    @abstractmethod
    def escrever_celula(self, linha: int, coluna: str, valor: str) -> None:
        """Digita sem autoformatação numa única célula."""

    @abstractmethod
    def aguardar_salvo(self, timeout_s: float) -> bool:
        """Verdadeiro quando o indicador mostra "Salvo" de forma estável."""

    def celula_e_data(self, linha: int, coluna: str) -> Optional[bool]:
        """``None`` quando a implementação não sabe; ``False`` indica que a data foi gravada como texto."""
        return None

    # -- leitura --------------------------------------------------------------------------------

    def _ler_validada(self) -> LeituraColunaC:
        leitura = self.ler_coluna_c()
        if not leitura.filtros_restaurados:
            raise FiltroNaoRestauradoErro("O filtro/exibição temporário não voltou ao estado original; confira a aba CHAMADOS.")
        if leitura.linhas_cobertas < leitura.ultima_linha_usada:
            raise LeituraIncompletaErro(
                f"Leitura incompleta da coluna C: {leitura.linhas_cobertas} de {leitura.ultima_linha_usada} linhas "
                "(possíveis linhas ocultas por filtro). Nada foi gravado."
            )
        return leitura

    def ler_numeros_coluna_c(self) -> frozenset[str]:
        """Números ``UTIC-AAAA-NNNN`` de toda a coluna C (valores compostos incluídos)."""
        return self._ler_validada().numeros

    # -- linha preparada e livre ----------------------------------------------------------------

    def _disponibilidade(self, lida: LinhaLida) -> Tuple[bool, str]:
        if lida.oculta:
            return False, "linha oculta"
        for coluna in COLUNAS_GRAVADAS:
            celula = lida.celulas.get(coluna)
            if celula is None:
                return False, f"coluna {coluna} não lida"
            if celula.formula or _normalizar_leitura(celula.valor):
                return False, f"coluna {coluna} ocupada"
        for coluna in self.colunas_formula:
            celula = lida.celulas.get(coluna)
            if celula is None or not celula.formula:
                return False, f"fórmula ausente na coluna {coluna}"
        return True, ""

    def _procurar_linha(self, leitura: LeituraColunaC) -> Tuple[int, LinhaLida]:
        inicio = (max(leitura.valores) if leitura.valores else 1) + 1
        colunas = tuple(COLUNAS_GRAVADAS) + self.colunas_formula
        for linha in range(inicio, inicio + LIMITE_BUSCA_LINHAS):
            lida = self.ler_celulas(linha, colunas)
            if self._disponibilidade(lida)[0]:
                return linha, lida
        raise SemLinhaPreparadaErro(
            f"Nenhuma linha preparada e livre nas {LIMITE_BUSCA_LINHAS} linhas após a linha {inicio - 1}. "
            "Prepare novas linhas no Dashboard; nada foi gravado."
        )

    def proxima_linha_livre(self, leitura: Optional[LeituraColunaC] = None) -> int:
        """Primeira linha abaixo da última com dado na coluna C com as sete células vazias e as fórmulas presentes."""
        return self._procurar_linha(leitura or self._ler_validada())[0]

    # -- gravação -------------------------------------------------------------------------------

    def _validar_linha(self, linha: Mapping[str, str]) -> Tuple[str, Dict[str, str]]:
        if set(linha) != set(COLUNAS_GRAVADAS):
            raise ValueError(f"A linha deve ter exatamente as colunas {', '.join(COLUNAS_GRAVADAS)}.")
        numero = chave_do_numero(str(linha["C"]).strip())
        valores = {coluna: normalizar_valor(coluna, linha[coluna], self.quebras_como_espaco) for coluna in COLUNAS_GRAVADAS}
        valores["C"] = numero
        for coluna in ("F", "G"):
            if not valores[coluna]:
                raise ValueError(f"Coluna {coluna} vazia.")
        if valores["I"] not in (TIPO_INCIDENTE, TIPO_SOLICITACAO):
            raise ValueError(f"Tipo inválido: {valores['I']!r}.")
        if valores["N"] != UNIDADE or valores["P"] != UF:
            raise ValueError(f"Unidade e UF devem ser {UNIDADE!r} e {UF!r}.")
        data = interpretar_data(valores["Q"])
        if data is None or data.strftime(FORMATO_DATA) != valores["Q"]:
            raise ValueError("Data de abertura fora do formato dd/MM/yyyy HH:mm.")
        for coluna, valor in valores.items():
            if len(valor) > LIMITE_CARACTERES_CELULA:
                raise ValueError(f"Coluna {coluna} excede {LIMITE_CARACTERES_CELULA} caracteres.")
        return numero, valores

    def gravar_chamado(self, linha: Mapping[str, str], *, somente_retomar: bool = False) -> ResultadoGravacao:
        """Grava um chamado; nunca levanta por falha do Excel (devolve a situação para a rotina decidir).

        Com ``somente_retomar`` só conclui uma intenção aberta no diário; sem ela, não inicia uma linha nova.
        """
        try:
            numero, valores = self._validar_linha(linha)
        except ValueError as erro:
            return ResultadoGravacao(str(linha.get("C", "")), INVALIDO, detalhe=str(erro))
        try:
            self.garantir_sessao()
            retomado = self._retomar(numero, valores)
            if retomado is not None:
                return retomado
            if somente_retomar:
                return ResultadoGravacao(numero, ABANDONADO, detalhe="A intenção anterior não deixou nada no Dashboard.")
            return self._gravar_nova(numero, valores)
        except SessaoExpiradaErro as erro:
            return self._falha(numero, SESSAO_EXPIRADA, erro)
        except LeituraIncompletaErro as erro:
            return self._falha(numero, LEITURA_INCOMPLETA, erro)
        except FiltroNaoRestauradoErro as erro:
            return self._falha(numero, FILTRO_NAO_RESTAURADO, erro)
        except SemLinhaPreparadaErro as erro:
            return self._falha(numero, SEM_LINHA, erro)
        except Exception as erro:  # queda de conexão, timeout do Playwright, aba fechada…
            return self._falha(numero, INTERROMPIDO, erro)

    def recuperar_pendencias(self) -> List[ResultadoGravacao]:
        """Relê o Dashboard e conclui as intenções abertas no diário (use no início da execução)."""
        resultados: List[ResultadoGravacao] = []
        for numero, intencao in self.diario.abertas().items():
            resultado = self.gravar_chamado(intencao["valores"], somente_retomar=True)
            resultados.append(resultado)
            if resultado.interrompe_execucao:
                break
        return resultados

    def _falha(self, numero: str, situacao: str, erro: BaseException) -> ResultadoGravacao:
        detalhe = " ".join(str(erro).split()) or type(erro).__name__
        try:
            intencao = self.diario.intencao(numero)
            if intencao is not None:
                self.diario.atualizar(numero, estado=situacao, detalhe=detalhe)
        except ExcelErro:  # diário ilegível: o resultado original continua valendo
            intencao = None
        if intencao is None:
            return ResultadoGravacao(numero, situacao, detalhe=detalhe)
        return ResultadoGravacao(
            numero, situacao, intencao.get("linha"), tuple(intencao.get("confirmados", ())), tuple(intencao.get("pendentes", ())), detalhe
        )

    def _gravar_nova(self, numero: str, valores: Dict[str, str]) -> ResultadoGravacao:
        # Releitura imediatamente antes de gravar: outra pessoa pode ter incluído o chamado.
        leitura = self._ler_validada()
        existentes = leitura.linhas_do_numero(numero)
        if existentes:
            return ResultadoGravacao(numero, DUPLICADO, existentes[0], detalhe="Número já presente na coluna C; linha preservada.")
        # A leitura da linha em _procurar_linha é a última antes da primeira escrita; o diário nasce antes de tocar o Dashboard.
        linha, _lida = self._procurar_linha(leitura)
        self.diario.registrar(numero, linha, valores)
        return self._escrever_e_verificar(numero, valores, linha, list(COLUNAS_GRAVADAS), [], recuperando=False)

    def _retomar(self, numero: str, valores: Dict[str, str]) -> Optional[ResultadoGravacao]:
        intencao = self.diario.intencao(numero)
        if intencao is None:
            return None
        linha = int(intencao["linha"])
        leitura = self._ler_validada()
        existentes = leitura.linhas_do_numero(numero)
        if not existentes:
            lida = self.ler_celulas(linha, COLUNAS_GRAVADAS)
            vazia = all(not lida.celulas[c].formula and not _normalizar_leitura(lida.celulas[c].valor) for c in COLUNAS_GRAVADAS)
            self.diario.fechar(numero, "abandonada" if vazia else "abandonada_linha_ocupada")
            return None
        if linha not in existentes:
            self.diario.fechar(numero, "presente_em_outra_linha")
            return ResultadoGravacao(numero, DUPLICADO, existentes[0], detalhe="Número já presente em outra linha; linha preservada.")
        lida = self.ler_celulas(linha, COLUNAS_GRAVADAS)
        confirmados: List[str] = []
        pendentes: List[str] = []
        conflitos: List[str] = []
        for coluna in COLUNAS_GRAVADAS:
            celula = lida.celulas[coluna]
            if valores_equivalentes(coluna, valores[coluna], celula.valor):
                confirmados.append(coluna)
            elif not celula.formula and not _normalizar_leitura(celula.valor):
                pendentes.append(coluna)
            else:
                conflitos.append(coluna)
        if conflitos:
            detalhe = f"Células com conteúdo diferente do extraído: {', '.join(conflitos)}; nada foi sobrescrito."
            self.diario.atualizar(numero, estado=DIVERGENTE, confirmados=confirmados, pendentes=pendentes + conflitos, detalhe=detalhe)
            return ResultadoGravacao(numero, DIVERGENTE, linha, tuple(confirmados), tuple(pendentes + conflitos), detalhe)
        return self._escrever_e_verificar(numero, valores, linha, pendentes, confirmados, recuperando=True)

    def _escrever_e_verificar(
        self, numero: str, valores: Dict[str, str], linha: int, a_escrever: List[str], confirmados: List[str], recuperando: bool
    ) -> ResultadoGravacao:
        pendentes = [coluna for coluna in COLUNAS_GRAVADAS if coluna not in confirmados]

        def resultado(situacao: str, detalhe: str = "") -> ResultadoGravacao:
            self.diario.atualizar(numero, estado=situacao, confirmados=list(confirmados), pendentes=list(pendentes), detalhe=detalhe)
            return ResultadoGravacao(numero, situacao, linha, tuple(confirmados), tuple(pendentes), detalhe)

        self.diario.atualizar(numero, estado="escrevendo", confirmados=list(confirmados), pendentes=list(pendentes))
        for coluna in a_escrever:
            atual = self.ler_celulas(linha, (coluna,)).celulas[coluna]
            if valores_equivalentes(coluna, valores[coluna], atual.valor) and not atual.formula and _normalizar_leitura(atual.valor):
                confirmados.append(coluna)
                pendentes.remove(coluna)
                continue
            if atual.formula or _normalizar_leitura(atual.valor):
                return resultado(PARCIAL, f"A célula {endereco(coluna, linha)} foi ocupada por outra edição; nada foi sobrescrito.")
            self.escrever_celula(linha, coluna, valores[coluna])
            lido = self.ler_celulas(linha, (coluna,)).celulas[coluna]
            if not valores_equivalentes(coluna, valores[coluna], lido.valor):
                return resultado(DIVERGENTE, f"{endereco(coluna, linha)} ficou com conteúdo diferente do extraído; corrija na planilha.")
            if coluna == "Q" and self.celula_e_data(linha, coluna) is False:
                return resultado(DIVERGENTE, f"{endereco(coluna, linha)} foi gravada como texto, não como data/hora.")
            confirmados.append(coluna)
            pendentes.remove(coluna)
            self.diario.atualizar(numero, confirmados=list(confirmados), pendentes=list(pendentes))

        final = self.ler_celulas(linha, COLUNAS_GRAVADAS)
        diferentes = [c for c in COLUNAS_GRAVADAS if not valores_equivalentes(c, valores[c], final.celulas[c].valor)]
        if diferentes:
            confirmados[:] = [c for c in COLUNAS_GRAVADAS if c not in diferentes]
            pendentes[:] = diferentes
            return resultado(DIVERGENTE, f"A releitura divergiu do extraído em {', '.join(diferentes)}.")
        if not self.aguardar_salvo(self.espera_salvo_s):
            return resultado(NAO_SALVO, "O indicador \"Salvo\" não foi confirmado; a próxima execução relê o Dashboard antes de tentar de novo.")
        self.diario.fechar(numero, "concluida")
        return ResultadoGravacao(numero, RECUPERADO if recuperando else GRAVADO, linha, tuple(COLUNAS_GRAVADAS), ())


# ---------------------------------------------------------------------------- Playwright

class Seletores:
    """Candidatos de seletor do Excel Online (pt-BR e en-US). NÃO validados: dependem da sessão assistida (V0)."""

    caixa_nome = 'input[aria-label="Caixa de Nome"], input[aria-label="Name Box"], #FormulaBar-NameBox-input'
    barra_formula = (
        '#formulaBarTextDivId_textElement, [aria-label="Barra de Fórmulas"], [aria-label="Formula Bar"], '
        '[id*="formulaBar"][role="textbox"]'
    )
    aba_ativa = '[role="tab"][aria-selected="true"]'
    salvo = re.compile(r"^\s*(Salvo|Saved)\b", re.IGNORECASE)
    salvando = re.compile(r"Salvando|Saving", re.IGNORECASE)
    sair_exibicao = re.compile(r"^(Sair|Exit)\b", re.IGNORECASE)


class ExcelOnlinePlaywright(AdaptadorExcel):
    """Primitivas sobre a aba do Excel Online já aberta no Chrome de automação (login feito pelo usuário)."""

    def __init__(
        self,
        page: "Page",
        *,
        colunas_formula: Sequence[str],
        aba: str = ABA,
        arquivo_esperado: str = "Operacional_SEBRAE",
        diario: Optional[DiarioGravacao] = None,
        espera_salvo_s: float = 60.0,
        quebras_como_espaco: bool = False,
        log: Optional[Callable[[str], None]] = None,
    ) -> None:
        super().__init__(colunas_formula=colunas_formula, diario=diario, espera_salvo_s=espera_salvo_s, quebras_como_espaco=quebras_como_espaco)
        self.page = page
        self.aba = aba
        self.arquivo_esperado = arquivo_esperado
        self._log = log or (lambda texto: print(f"[Excel] {texto}", flush=True))
        self._permissoes_dadas = False

    # -- infraestrutura -----------------------------------------------------------------------

    def _frames(self) -> List["Frame"]:
        return list(self.page.frames)

    def _app(self) -> "Frame":
        for frame in self._frames():
            try:
                if frame.locator(Seletores.caixa_nome).filter(visible=True).count():
                    return frame
            except Exception:
                continue
        raise ExcelErro("A grade do Excel Online não foi encontrada na aba (Caixa de Nome ausente).")

    def _texto_visivel(self) -> str:
        partes: List[str] = []
        for frame in self._frames():
            try:
                partes.append(frame.locator("body").inner_text(timeout=2000))
            except Exception:
                continue
        return "\n".join(partes)

    def _ir_para(self, alvo: str) -> None:
        """Seleciona a célula/intervalo pela Caixa de Nome e confere a seleção antes de qualquer escrita."""
        app = self._app()
        caixa = app.locator(Seletores.caixa_nome).filter(visible=True).first
        caixa.click()
        self.page.keyboard.press("Control+A")
        self.page.keyboard.type(alvo)
        self.page.keyboard.press("Enter")
        if ":" not in alvo:
            atual = (caixa.input_value() or "").replace("$", "").upper()
            if atual != alvo.upper():
                raise ExcelErro(f"A seleção foi para {atual or '?'} em vez de {alvo}; nada foi digitado.")

    def _texto_da_barra(self) -> str:
        barra = self._app().locator(Seletores.barra_formula).filter(visible=True).first
        return barra.inner_text(timeout=5000)

    def _aba_selecionada(self) -> str:
        try:
            return (self._app().locator(Seletores.aba_ativa).first.inner_text(timeout=3000) or "").strip()
        except Exception:
            return ""

    def _conceder_area_de_transferencia(self) -> None:
        if self._permissoes_dadas:
            return
        try:
            origem = "/".join(self.page.url.split("/", 3)[:3])
            self.page.context.grant_permissions(["clipboard-read", "clipboard-write"], origin=origem)
        except Exception as erro:
            self._log(f"Permissão da área de transferência não concedida ({erro}); a cópia da coluna C pode falhar.")
        self._permissoes_dadas = True

    # -- primitivas ---------------------------------------------------------------------------

    def garantir_sessao(self) -> None:
        if url_de_login(self.page.url):
            raise SessaoExpiradaErro("A Microsoft/SharePoint pediu login. Faça o login no Chrome de automação.")
        limite = time.time() + 20
        while True:
            try:
                self._app()
                break
            except ExcelErro:
                if texto_de_sessao_expirada(self._texto_visivel()) or url_de_login(self.page.url):
                    raise SessaoExpiradaErro("Sessão do Excel Online expirada. Faça o login no Chrome de automação.") from None
                if time.time() >= limite:
                    raise
                time.sleep(1)
        if texto_de_sessao_expirada(self._texto_visivel()):
            raise SessaoExpiradaErro("O Excel Online avisou que a sessão expirou. Faça o login no Chrome de automação.")
        titulo = self.page.title()
        if self.arquivo_esperado.lower() not in titulo.lower():
            raise ExcelErro(f"A aba aberta ({titulo!r}) não parece ser o Dashboard ({self.arquivo_esperado}); nada foi lido nem gravado.")
        self._conceder_area_de_transferencia()
        if self._aba_selecionada().lower() != self.aba.lower():
            self._app().get_by_role("tab", name=self.aba, exact=True).click()
            if self._aba_selecionada().lower() != self.aba.lower():
                raise ExcelErro(f"A aba {self.aba} não pôde ser selecionada.")

    def _ultima_linha_usada(self) -> int:
        self._ir_para("A1")
        self.page.keyboard.press("Control+End")
        caixa = self._app().locator(Seletores.caixa_nome).filter(visible=True).first
        correspondencia = re.fullmatch(r"\$?[A-Z]+\$?(\d+)", (caixa.input_value() or "").strip().upper())
        if not correspondencia:
            raise LeituraIncompletaErro("Não foi possível descobrir a última linha usada (Ctrl+End).")
        return int(correspondencia.group(1))

    def _copiar_intervalo(self, intervalo: str) -> str:
        self._ir_para(intervalo)
        app = self._app()
        sentinela = f"__simpress_{time.time_ns()}__"
        app.evaluate("(texto) => navigator.clipboard.writeText(texto)", sentinela)
        self.page.keyboard.press("Control+C")
        limite = time.time() + 6
        while time.time() < limite:
            texto = app.evaluate("() => navigator.clipboard.readText()")
            if texto and texto != sentinela:
                return str(texto)
            time.sleep(0.4)
        raise LeituraIncompletaErro("A cópia da coluna C não chegou à área de transferência.")

    def _copiar_coluna_c(self, ultima_linha: int) -> str:
        return self._copiar_intervalo(f"C1:C{ultima_linha}")

    def _abrir_exibicao_temporaria(self) -> None:
        """Exibição de folha pessoal (sem filtros), que não altera o filtro compartilhado. A confirmar em V4."""
        app = self._app()
        try:
            app.get_by_role("tab", name=re.compile(r"^(Exibir|View)$", re.IGNORECASE)).click(timeout=5000)
            app.get_by_role("button", name=re.compile(r"Exibi[cç][õo]es? de Planilha|Sheet View", re.IGNORECASE)).first.click(timeout=5000)
            app.get_by_role("menuitem", name=re.compile(r"^(Nova|New)", re.IGNORECASE)).first.click(timeout=5000)
        except Exception as erro:
            raise LeituraIncompletaErro(f"A exibição temporária sem filtro não pôde ser aberta ({erro}). Nada foi gravado.") from erro

    def _exibicao_padrao_ativa(self) -> bool:
        try:
            return not self._app().get_by_role("button", name=Seletores.sair_exibicao).filter(visible=True).count()
        except Exception:
            return False

    def _fechar_exibicao_temporaria(self) -> None:
        app = self._app()
        try:
            app.get_by_role("button", name=Seletores.sair_exibicao).filter(visible=True).first.click(timeout=5000)
        except Exception:
            pass
        if not self._exibicao_padrao_ativa():
            raise FiltroNaoRestauradoErro("A exibição temporária continua aberta; saia dela manualmente na aba CHAMADOS.")

    def ler_coluna_c(self) -> LeituraColunaC:
        self.garantir_sessao()
        ultima = self._ultima_linha_usada()
        valores, cobertas = valores_da_coluna(self._copiar_coluna_c(ultima))
        if cobertas >= ultima:
            return LeituraColunaC(valores, cobertas, ultima)
        self._log(f"A cópia trouxe {cobertas} de {ultima} linhas (filtro ativo); relendo numa exibição temporária sem filtro.")
        cobertas_visiveis = cobertas
        aberta = False
        try:
            self._abrir_exibicao_temporaria()
            aberta = True
            valores, cobertas = valores_da_coluna(self._copiar_coluna_c(ultima))
        finally:
            if aberta:
                self._fechar_exibicao_temporaria()
        return LeituraColunaC(valores, cobertas, ultima, linhas_ocultas_lidas=max(0, cobertas - cobertas_visiveis))

    def ler_celulas(self, linha: int, colunas: Sequence[str]) -> LinhaLida:
        celulas: Dict[str, Celula] = {}
        for coluna in colunas:
            self._ir_para(endereco(coluna, linha))
            texto = self._texto_da_barra()
            celulas[coluna] = Celula(_normalizar_leitura(texto), texto.strip().startswith("="))
        return LinhaLida(linha, celulas)

    def escrever_celula(self, linha: int, coluna: str, valor: str) -> None:
        if self._aba_selecionada().lower() != self.aba.lower():
            raise ExcelErro(f"A aba ativa não é {self.aba}; nada foi digitado.")
        self._ir_para(endereco(coluna, linha))
        digitar = texto_para_digitar(coluna, valor)
        self.page.keyboard.press("F2")
        for indice, trecho in enumerate(digitar.split("\n")):
            if indice:
                self.page.keyboard.press("Alt+Enter")
            self.page.keyboard.insert_text(trecho)
        # Delete remove a sugestão de preenchimento automático (ex.: "PR" virando outro valor da coluna).
        self.page.keyboard.press("Delete")
        self.page.keyboard.press("Enter")

    def aguardar_salvo(self, timeout_s: float) -> bool:
        limite = time.time() + timeout_s
        time.sleep(1.0)
        estaveis = 0
        while time.time() < limite:
            salvo = salvando = False
            for frame in self._frames():
                try:
                    salvo = salvo or frame.get_by_text(Seletores.salvo).filter(visible=True).count() > 0
                    salvando = salvando or frame.get_by_text(Seletores.salvando).filter(visible=True).count() > 0
                except Exception:
                    continue
            estaveis = estaveis + 1 if salvo and not salvando else 0
            if estaveis >= 2:
                return True
            time.sleep(1.0)
        return False
