"""Writes tickets into a COPY of the imported Dashboard (docs/operacao/sincronizar-chamados-sebrae.md).

A ``.xlsx`` is a ZIP of XML parts. Only the text of the CHAMADOS sheet, ``workbook.xml`` and the ``Tabela3`` pivot cache
are edited here (``calcChain.xml`` is dropped when rows move), by plain text splicing: every other part is copied byte for
byte, so the validations (x14 extension), pivots, charts and comments survive. openpyxl is never used to write: it would drop them.

One primitive sets cells in a row; it serves new tickets (first free rows of ``Tabela3``) and edits of the manual
columns of tickets already in the sheet. Ticket content is data; nothing here interprets it.

Every copy leaves with the data rows of ``Tabela3`` sorted by column C, like Excel's "Classificar do Menor para o Maior"
(``chave_coluna_c``): the cells of columns A:W move with their style, the row attributes and the cells right of W stay by
position, and ``hidden`` follows the saved filter of column D.
"""

from __future__ import annotations

import io
import logging
import re
import zipfile
from collections import Counter
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta
from html import unescape
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple, Union
from xml.etree import ElementTree

from domains.sebrae_chamados import extrair_numeros
from domains.sebrae_dashboard import ABA, DashboardInvalido, MANUAIS, _validar_pacote, ler_coluna_c
from domains.sebrae_novos import STATUS_FINALIZADO

logger = logging.getLogger(__name__)

TABELA = "Tabela3"
FORMATO_DATA_HORA = "%d/%m/%Y %H:%M"
_EPOCA = datetime(1899, 12, 30)
COLUNAS_DE_DADO = tuple("ABCDEFGHIJKLMNOP") + ("R", "S")  # a row with any of these filled is a ticket row
COLUNAS_DE_TABELA = tuple("ABCDEFGHIJKLMNOPQRSTUV")
COLUNAS_DE_DATA = ("P", "R")
FORMULAS_DA_LINHA = ("Q", "T", "U", "V")
MAX_CARACTERES_CELULA = 32_767
INDICE_DA_COLUNA_W = 23

_SHEET_TAG = re.compile(r"<sheet\b[^>]*/>")
_ATRIBUTO = re.compile(r'([\w:]+)="([^"]*)"')
_LINHA = re.compile(r'<row r="(\d+)"([^>]*?)(?:/>|>(.*?)</row>)', re.DOTALL)
_CELULA = re.compile(r'<c r="([A-Z]+)\d+"([^>]*?)(?:/>|>(.*?)</c>)', re.DOTALL)
_SI = re.compile(r"<si\b[^>]*?(?:/>|>(.*?)</si>)", re.DOTALL)
_TEXTO = re.compile(r"<t\b[^>]*?(?:/>|>(.*?)</t>)", re.DOTALL)
_PROIBIDOS_XML = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")
_ESCAPE_LITERAL = re.compile(r"_x(?=[0-9A-Fa-f]{4}_)")
_REFERENCIA_DE_LINHA = re.compile(r"(?<![A-Za-z0-9_.])\$?[A-Z]{1,3}\$?\d+(?![\dA-Za-z_(])")  # A1, $B$7 (not LOG10( or Tabela3)


class GravacaoInvalida(DashboardInvalido):
    """The copy cannot be written; the message is meant for the user."""


@dataclass(frozen=True)
class LinhaGravada:
    numero: str
    linha: int
    tipo: str  # "novo" | "alterado"
    celulas: Tuple[str, ...]


@dataclass(frozen=True)
class Resultado:
    conteudo: bytes
    linhas: Tuple[LinhaGravada, ...] = field(default_factory=tuple)


# ---------------------------------------------------------------------------- package

def _letra_para_indice(letra: str) -> int:
    indice = 0
    for caractere in letra:
        indice = indice * 26 + ord(caractere) - 64
    return indice


def _atributos(tag: str) -> Dict[str, str]:
    return dict(_ATRIBUTO.findall(tag))


def _alvo(base: str, destino: str) -> str:
    if destino.startswith("/"):
        return destino.lstrip("/")
    partes = base.split("/")[:-1]
    for pedaco in destino.split("/"):
        if pedaco == "..":
            partes.pop()
        elif pedaco != ".":
            partes.append(pedaco)
    return "/".join(partes)


def _relacoes(texto: str, base: str) -> Dict[str, Tuple[str, str]]:
    achadas: Dict[str, Tuple[str, str]] = {}
    for tag in re.findall(r"<Relationship\b[^>]*/>", texto):
        atributos = _atributos(tag)
        achadas[atributos.get("Id", "")] = (atributos.get("Type", ""), _alvo(base, atributos.get("Target", "")))
    return achadas


@dataclass
class _Pacote:
    entradas: List[zipfile.ZipInfo]
    partes: Dict[str, bytes]
    aba: str
    tabela_ultima_linha: int
    compartilhadas: List[str]
    tabela: str = ""  # path of the ``Tabela3`` table part

    def texto(self, nome: str) -> str:
        return self.partes[nome].decode("utf-8")


def _ler_pacote(conteudo: bytes) -> _Pacote:
    try:
        with zipfile.ZipFile(io.BytesIO(conteudo)) as arquivo:
            _validar_pacote(arquivo)
            entradas = arquivo.infolist()
            partes = {entrada.filename: arquivo.read(entrada) for entrada in entradas}
    except zipfile.BadZipFile as erro:
        raise DashboardInvalido("O arquivo guardado não é uma planilha .xlsx válida.") from erro
    pacote = _Pacote(entradas, partes, "", 0, [])
    try:
        livro = pacote.texto("xl/workbook.xml")
        rel_id = next(
            _atributos(tag).get("r:id", "") for tag in _SHEET_TAG.findall(livro)
            if unescape(_atributos(tag).get("name", "")) == ABA
        )
        aba = _relacoes(pacote.texto("xl/_rels/workbook.xml.rels"), "xl/workbook.xml")[rel_id][1]
        pacote.aba = aba
        base_rels = aba.rsplit("/", 1)[0] + "/_rels/" + aba.rsplit("/", 1)[1] + ".rels"
        ultima = 0
        parte_da_tabela = ""
        for tipo, destino in _relacoes(pacote.texto(base_rels), aba).values():
            if not tipo.endswith("/table"):
                continue
            tabela = pacote.texto(destino)
            cabeca = re.search(r"<table\b[^>]*>", tabela)
            if cabeca and TABELA in (_atributos(cabeca.group(0)).get("displayName"), _atributos(cabeca.group(0)).get("name")):
                referencia = re.fullmatch(r"A1:W(\d+)", _atributos(cabeca.group(0)).get("ref", ""))
                if not referencia:
                    raise GravacaoInvalida(f"A {TABELA} não cobre as colunas A:W; atualize o Dashboard.")
                ultima = int(referencia.group(1))
                parte_da_tabela = destino
        if not ultima:
            raise GravacaoInvalida(f"A aba {ABA} não tem a tabela {TABELA}.")
        pacote.tabela_ultima_linha = ultima
        pacote.tabela = parte_da_tabela
        if "xl/sharedStrings.xml" in partes:
            pacote.compartilhadas = [
                unescape("".join(_TEXTO.findall(re.sub(r"<rPh\b.*?</rPh>", "", corpo or "", flags=re.DOTALL))))
                for corpo in _SI.findall(pacote.texto("xl/sharedStrings.xml"))
            ]
    except (StopIteration, KeyError, UnicodeDecodeError) as erro:
        raise GravacaoInvalida("A estrutura do Dashboard guardado não é a esperada.") from erro
    return pacote


# ---------------------------------------------------------------------------- reading rows

@dataclass
class _Linha:
    numero: int
    abertura: str
    celulas: Dict[str, str]  # column letter -> raw ``<c>`` XML
    inicio: int  # span of the whole ``<row>`` in the sheet text
    fim: int


def _linhas_da_aba(texto: str) -> Tuple[int, int, Dict[int, _Linha]]:
    inicio = texto.find("<sheetData>")
    fim = texto.find("</sheetData>")
    if inicio < 0 or fim < 0:
        raise GravacaoInvalida("A aba CHAMADOS não tem dados legíveis.")
    inicio += len("<sheetData>")
    linhas: Dict[int, _Linha] = {}
    for achado in _LINHA.finditer(texto, inicio, fim):
        linha = _linha_de(achado)
        linhas[linha.numero] = linha
    return inicio, fim, linhas


def _linha_de(achado: "re.Match[str]") -> _Linha:
    celulas = {m.group(1): m.group(0) for m in _CELULA.finditer(achado.group(3) or "")}
    abertura = achado.group(0)[: achado.group(0).find(">") + 1].replace("/>", ">")
    return _Linha(int(achado.group(1)), abertura, celulas, achado.start(), achado.end())


def _valor_celula(bruto: str, compartilhadas: Sequence[str]) -> Optional[str]:
    """Text of a constant cell; formula cells and empty cells give ``None``."""
    achado = _CELULA.fullmatch(bruto)
    if not achado or achado.group(3) is None or "<f" in achado.group(3):
        return None
    tipo = _atributos(achado.group(2)).get("t", "n")
    corpo = achado.group(3)
    if tipo == "inlineStr":
        texto = unescape("".join(_TEXTO.findall(corpo)))
    else:
        v = re.search(r"<v>(.*?)</v>", corpo, re.DOTALL)
        if v is None:
            return None
        texto = unescape(v.group(1))
        if tipo == "s":
            try:
                texto = compartilhadas[int(texto)]
            except (ValueError, IndexError):
                return None
    return texto if texto.strip() else None


def _serial_para_texto(serial: str) -> str:
    try:
        return (_EPOCA + timedelta(days=float(serial), seconds=30)).strftime(FORMATO_DATA_HORA)  # +30 s: round to the minute
    except (ValueError, OverflowError):
        return serial


def _valor_legivel(letra: str, bruto: str, compartilhadas: Sequence[str]) -> str:
    valor = _valor_celula(bruto, compartilhadas)
    if valor is None:
        return ""
    if letra in COLUNAS_DE_DATA and re.fullmatch(r"-?\d+(\.\d+)?", valor):
        return _serial_para_texto(valor)
    return " ".join(valor.split())


def _tem_dado(linha: _Linha, compartilhadas: Sequence[str]) -> bool:
    return any(_valor_celula(linha.celulas.get(letra, ""), compartilhadas) is not None for letra in COLUNAS_DE_DADO)


def valores_dos_chamados(conteudo: bytes) -> Dict[int, Tuple[str, ...]]:
    """Per ticket row, the readable values of every data column (``COLUNAS_DE_DADO``); styles, zip order and metadata are ignored.

    Formula cells read as empty, like everywhere else in this module. Used to compare two copies of the Dashboard."""
    pacote = _ler_pacote(conteudo)
    _, _, linhas = _linhas_da_aba(pacote.texto(pacote.aba))
    return {
        numero: tuple(_valor_legivel(letra, linha.celulas.get(letra, ""), pacote.compartilhadas) for letra in COLUNAS_DE_DADO)
        for numero, linha in linhas.items() if numero >= 2 and _tem_dado(linha, pacote.compartilhadas)
    }


CHAVE_DE_LINHA = "linha:"
AUTOMATICAS_VAZIAS = ("E", "K", "L", "N")  # filled by the site only into empty cells


@dataclass(frozen=True)
class ChamadoAberto:
    numero: str  # key: the UTIC when the row has exactly one and no other row repeats it, else ``linha:<row>``
    linha: int
    titulo: str
    valores: Mapping[str, str]  # manual columns as stored in the sheet
    chamado: str = ""  # column C as the sheet shows it
    usuario: str = ""  # column I
    automaticos: Mapping[str, str] = field(default_factory=dict)  # E, K, L, N as stored
    descricao: str = ""  # column H, only read to spot a ticket opened for another person

    def como_dict(self) -> Dict[str, object]:
        return {
            "numero": self.numero, "titulo": self.titulo, "valores": dict(self.valores), "linha": self.linha,
            "chamado": self.chamado, "usuario": self.usuario, "automaticos": dict(self.automaticos),
            "descricao": self.descricao,
        }


def _abertos(linhas: Mapping[int, _Linha], compartilhadas: Sequence[str]) -> List[ChamadoAberto]:
    """Every ticket row whose D is EM ABERTO or empty (the saved filter of column D), with or without a UTIC."""
    def lido(linha: _Linha, letra: str) -> str:
        return _valor_legivel(letra, linha.celulas.get(letra, ""), compartilhadas)

    abertas: List[Tuple[_Linha, str, str, Dict[str, str]]] = []
    repeticoes: Dict[str, int] = {}
    for numero in sorted(linhas):
        linha = linhas[numero]
        if numero < 2 or not _tem_dado(linha, compartilhadas):
            continue
        chamado = lido(linha, "C")
        numeros_c = extrair_numeros(chamado)
        utic = numeros_c[0] if len(numeros_c) == 1 else ""
        if utic:
            repeticoes[utic] = repeticoes.get(utic, 0) + 1
        valores = {letra: lido(linha, letra) for letra in MANUAIS}
        if valores["D"].upper() in ("", "EM ABERTO"):
            abertas.append((linha, chamado, utic, valores))
    return [
        ChamadoAberto(
            utic if utic and repeticoes[utic] == 1 else f"{CHAVE_DE_LINHA}{linha.numero}", linha.numero, lido(linha, "G"), valores,
            chamado, lido(linha, "I"), {letra: lido(linha, letra) for letra in AUTOMATICAS_VAZIAS},
            lido(linha, "H")[:2000],
        )
        for linha, chamado, utic, valores in abertas
    ]


def chamados_para_editar(conteudo: bytes) -> List[ChamadoAberto]:
    """Old tickets the site mirrors: D is EM ABERTO or empty, including rows with no UTIC ("Sem chamado", legacy numbers)."""
    pacote = _ler_pacote(conteudo)
    _, _, linhas = _linhas_da_aba(pacote.texto(pacote.aba))
    return _abertos(linhas, pacote.compartilhadas)


def ler_listas(conteudo: bytes) -> Dict[str, List[str]]:
    """Options of the A and B dropdowns: ``LISTAS!T`` (RESPONSAVEL) and ``LISTAS!D`` (CATEGORIA), below their headers.

    Empty when the sheet or a header is not the expected one: the site then keeps free text instead of refusing."""
    import warnings

    from openpyxl import load_workbook

    colunas = {"A": (19, "RESPONSAVEL"), "B": (3, "CATEGORIA")}
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            livro = load_workbook(io.BytesIO(conteudo), read_only=True, data_only=True)
        try:
            if "LISTAS" not in livro.sheetnames:
                return {}
            linhas = list(livro["LISTAS"].iter_rows(min_row=1, max_row=200, max_col=20, values_only=True))
        finally:
            livro.close()
    except (OSError, KeyError, ValueError, zipfile.BadZipFile):
        return {}
    listas: Dict[str, List[str]] = {}
    for letra, (indice, cabecalho) in colunas.items():
        if not linhas or str(linhas[0][indice] if len(linhas[0]) > indice else "").strip().upper() != cabecalho:
            continue
        itens: List[str] = []
        for linha in linhas[1:]:
            valor = " ".join(str(linha[indice] if len(linha) > indice and linha[indice] is not None else "").split())
            if not valor:
                break
            itens.append(valor)
        listas[letra] = itens
    return listas


# ---------------------------------------------------------------------------- writing cells

def _texto_xml(valor: str) -> str:
    limpo = _ESCAPE_LITERAL.sub("_x005F_x", _PROIBIDOS_XML.sub("", valor))[:MAX_CARACTERES_CELULA]
    return limpo.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _serial(valor: str) -> str:
    momento = datetime.strptime(valor, FORMATO_DATA_HORA)
    dias = (momento - _EPOCA).total_seconds() / 86400
    return f"{dias:.10f}".rstrip("0").rstrip(".")


def _sem_apostrofo_de_texto(valor: str) -> str:
    """``_texto_de_celula`` prefixes ``'`` before ``= + - @`` for paste; an inline string needs none."""
    return valor[1:] if len(valor) > 1 and valor[0] == "'" and valor[1] in "=+-@" else valor


def _celula(letra: str, numero: int, estilo: str, valor: str) -> str:
    referencia = f'r="{letra}{numero}"' + (f' s="{estilo}"' if estilo else "")
    if letra in COLUNAS_DE_DATA:
        try:
            return f"<c {referencia}><v>{_serial(valor)}</v></c>"
        except ValueError:
            raise GravacaoInvalida(f"{letra}{numero}: data inválida; use dd/MM/aaaa HH:mm.") from None
    if letra == "E" and valor.isdigit():
        return f"<c {referencia}><v>{valor}</v></c>"
    return f'<c {referencia} t="inlineStr"><is><t xml:space="preserve">{_texto_xml(_sem_apostrofo_de_texto(valor))}</t></is></c>'


def _limpar_cache_de_formula(letra: str, numero: int, bruto: str) -> str:
    """A formula cell keeps its ``<f>``; the cached value goes so the recalculation on load is the only truth."""
    achado = _CELULA.fullmatch(bruto)
    if not achado or achado.group(3) is None or "<f" not in achado.group(3):
        return bruto
    atributos = re.sub(r'\s+t="[^"]*"', "", achado.group(2))
    corpo = re.sub(r"<v>.*?</v>|<v/>", "", achado.group(3), flags=re.DOTALL)
    return f'<c r="{letra}{numero}"{atributos}>{corpo}</c>'


def _estilos_modais(linhas: Mapping[int, _Linha], compartilhadas: Sequence[str]) -> Dict[str, str]:
    contagem: Dict[str, Dict[str, int]] = {}
    for linha in linhas.values():
        if linha.numero < 2 or not _tem_dado(linha, compartilhadas):
            continue
        for letra in COLUNAS_DE_TABELA:
            achado = _CELULA.fullmatch(linha.celulas.get(letra, ""))
            estilo = _atributos(achado.group(2)).get("s", "") if achado else ""
            if estilo:
                contagem.setdefault(letra, {})[estilo] = contagem.setdefault(letra, {}).get(estilo, 0) + 1
    return {letra: max(estilos, key=lambda e: estilos[e]) for letra, estilos in contagem.items()}


def _formula_de_q(linhas: Mapping[int, _Linha]) -> str:
    for numero in sorted(linhas, reverse=True):
        achado = _CELULA.fullmatch(linhas[numero].celulas.get("Q", ""))
        if achado and achado.group(3):
            formula = re.search(r"<f>(.*?)</f>", achado.group(3), re.DOTALL)
            if formula:
                return formula.group(1)
    return ""


def _estilo_da_celula(bruto: str) -> str:
    achado = _CELULA.fullmatch(bruto)
    return _atributos(achado.group(2)).get("s", "") if achado else ""


def _reescrever_linha(
    linha: _Linha, valores: Mapping[str, str], estilos: Mapping[str, str], formula_q: str, manter_estilo: bool,
) -> str:
    """The row with ``valores`` set (empty values leave the cell alone); formula caches dropped.

    A cell keeps its own style when ``manter_estilo`` (edit of an existing ticket); otherwise it takes the
    most common style of its column (new rows: the free rows below row 350 carry unrelated styles)."""
    celulas = dict(linha.celulas)
    for letra, valor in valores.items():
        if valor == "":
            continue
        proprio = _estilo_da_celula(celulas.get(letra, "")) if manter_estilo else ""
        celulas[letra] = _celula(letra, linha.numero, proprio or estilos.get(letra, ""), valor)
    if formula_q and "<f" not in celulas.get("Q", ""):
        estilo_q = estilos.get("Q", "")
        celulas["Q"] = f'<c r="Q{linha.numero}"' + (f' s="{estilo_q}"' if estilo_q else "") + f' t="str"><f>{formula_q}</f></c>'
    for letra in FORMULAS_DA_LINHA:
        if letra in celulas:
            celulas[letra] = _limpar_cache_de_formula(letra, linha.numero, celulas[letra])
    ordenadas = "".join(celulas[letra] for letra in sorted(celulas, key=_letra_para_indice))
    return f"{linha.abertura}{ordenadas}</row>"


# ---------------------------------------------------------------------------- sorting by column C

def chave_coluna_c(valor: Optional[str], numerico: Optional[bool] = None) -> Tuple[int, Union[float, str]]:
    """Sort key of a column C cell, like Excel's "Classificar do Menor para o Maior": numbers by value, then text, then empty.

    Text compares without case and ignoring hyphens and apostrophes (Excel ignores them). ``numerico`` says the cell is a
    number cell (no ``t`` attribute); ``None`` infers it from the digits of ``valor``.
    """
    if valor is None or not valor.strip():
        return (2, "")
    if numerico is None:
        numerico = valor.isdigit()
    if numerico:
        try:
            return (0, float(valor))
        except ValueError:
            pass
    return (1, valor.casefold().replace("-", "").replace("'", ""))


def _chave_da_linha(linha: _Linha, compartilhadas: Sequence[str]) -> Tuple[int, Union[float, str]]:
    bruto = linha.celulas.get("C", "")
    valor = _valor_celula(bruto, compartilhadas)  # raw text: Excel compares the real spaces
    achado = _CELULA.fullmatch(bruto)
    return chave_coluna_c(valor, achado is not None and _atributos(achado.group(2)).get("t", "n") == "n")


def _assinatura(linha: _Linha) -> Tuple[Tuple[str, str], ...]:
    """Cells A:W of a row as stored (value, formula, style), without the row number: what a sort must only move."""
    return tuple(
        (letra, re.sub(r' r="[A-Z]+\d+"', "", linha.celulas[letra], count=1))
        for letra in sorted(linha.celulas, key=_letra_para_indice) if _letra_para_indice(letra) <= INDICE_DA_COLUNA_W
    )


def _formula_presa_a_linha(bruto: str) -> bool:
    """True when moving the cell to another row would change what its formula means."""
    if re.search(r'<f\b[^>]*\bt="(?:shared|array)"', bruto):
        return True
    for formula in re.findall(r"<f\b[^>]*>(.*?)</f>", bruto, re.DOTALL):
        limpa = re.sub(r'"(?:[^"]|"")*"', "", unescape(formula))
        while (menor := re.sub(r"\[[^\[\]]*\]", "", limpa)) != limpa:  # Tabela3[[#This Row],[X]] needs no rewrite
            limpa = menor
        if _REFERENCIA_DE_LINHA.search(limpa):
            return True
    return False


def _filtro_da_coluna_d(pacote: _Pacote) -> Optional[Tuple[frozenset, bool]]:
    """Values (upper case) the saved filter of column D lets through, and whether blanks pass; ``None`` without such filter."""
    for achado in re.finditer(r"<filterColumn\b([^>]*?)(?:/>|>(.*?)</filterColumn>)", pacote.texto(pacote.tabela), re.DOTALL):
        if _atributos(achado.group(1)).get("colId") != "3":
            continue
        filtros = re.search(r"<filters\b([^>]*?)(?:/>|>(.*?)</filters>)", achado.group(2) or "", re.DOTALL)
        if filtros is None or "<dateGroupItem" in (filtros.group(2) or ""):
            return None
        valores = frozenset(" ".join(unescape(v).split()).upper() for v in re.findall(r'<filter\b[^>]*\bval="([^"]*)"', filtros.group(2) or ""))
        return valores, _atributos(filtros.group(1)).get("blank") in ("1", "true")
    return None


def _com_oculta(abertura: str, ocultar: bool) -> str:
    if (_atributos(abertura).get("hidden") in ("1", "true")) == ocultar:
        return abertura
    sem = re.sub(r'\s+hidden="[^"]*"', "", abertura)
    return sem[:-1] + ' hidden="1">' if ocultar else sem


@dataclass(frozen=True)
class _Ordem:
    substituicoes: Mapping[int, str]
    mapa: Mapping[int, int]  # row before the sort -> row after it, for the rows of the sorted range
    ultimo: int  # last row of the sorted range (0: nothing to sort)
    esperado: Mapping[Tuple[Tuple[str, str], ...], int]  # multiset of ``_assinatura`` the sorted range must keep


def _ordenar(pacote: _Pacote, linhas: Mapping[int, _Linha], substituicoes: Mapping[int, str]) -> _Ordem:
    """Sorts the data rows (2 .. last) by column C, stable, over the rows as they will be written (``substituicoes`` applied)."""
    compartilhadas = pacote.compartilhadas
    finais = dict(linhas)
    for numero, bruto in substituicoes.items():
        achado = _LINHA.fullmatch(bruto)
        if achado is None:
            raise GravacaoInvalida(f"A linha {numero} gravada não pôde ser lida para ordenar; nada foi entregue.")
        finais[numero] = replace(_linha_de(achado), inicio=linhas[numero].inicio, fim=linhas[numero].fim)
    dados = [n for n in sorted(finais) if n >= 2 and _tem_dado(finais[n], compartilhadas)]
    if not dados:
        return _Ordem(substituicoes, {}, 0, Counter())
    faixa = range(2, dados[-1] + 1)
    if any(n not in finais for n in faixa):
        raise GravacaoInvalida("A aba CHAMADOS tem linhas faltando entre os chamados; não foi possível ordenar a coluna C. Nada foi entregue.")
    ordem = sorted(faixa, key=lambda n: _chave_da_linha(finais[n], compartilhadas))  # stable: ties keep the sheet order
    for destino, origem in zip(faixa, ordem):
        if origem == destino:
            continue
        for letra, bruto in finais[origem].celulas.items():
            if _letra_para_indice(letra) <= INDICE_DA_COLUNA_W and _formula_presa_a_linha(bruto):
                raise GravacaoInvalida(f"A fórmula de {letra}{origem} depende do número da linha; não dá para ordenar a coluna C sem quebrá-la. Nada foi entregue.")
    filtro = _filtro_da_coluna_d(pacote)
    novas: Dict[int, str] = {}
    for destino, origem in zip(faixa, ordem):
        alvo, fonte = finais[destino], finais[origem]
        celulas = {l: re.sub(r'^<c r="([A-Z]+)\d+"', rf'<c r="\g<1>{destino}"', c, count=1) for l, c in fonte.celulas.items() if _letra_para_indice(l) <= INDICE_DA_COLUNA_W}
        celulas.update({l: c for l, c in alvo.celulas.items() if _letra_para_indice(l) > INDICE_DA_COLUNA_W})  # right of W stays by position
        abertura = alvo.abertura
        if filtro is not None:
            status = _valor_legivel("D", celulas.get("D", ""), compartilhadas).upper()
            abertura = _com_oculta(abertura, status not in filtro[0] and not (status == "" and filtro[1]))
        if origem == destino and abertura == alvo.abertura:
            if destino in substituicoes:
                novas[destino] = substituicoes[destino]
            continue
        novas[destino] = abertura + "".join(celulas[l] for l in sorted(celulas, key=_letra_para_indice)) + "</row>"
    return _Ordem(novas, dict(zip(ordem, faixa)), dados[-1], Counter(_assinatura(finais[n]) for n in faixa))


# ---------------------------------------------------------------------------- categories (LISTAS!D)

# Users of the list: validations of CHAMADOS (x14 ``xm:f`` or plain ``formula1``) and defined names, as ``LISTAS!$D$2:$D$<last row>``.
_VALIDACAO_D = re.compile(r"((?:<xm:f>|<formula1>)\s*'?LISTAS'?!\$D\$2:\$D\$)(\d+)(\s*</(?:xm:f|formula1)>)")
_NOME_D = re.compile(r"(<definedName\b[^>]*>\s*'?LISTAS'?!\$D\$2:\$D\$)(\d+)(\s*</definedName>)")


def _categorias() -> Tuple[Tuple[str, ...], Callable[[Any], str]]:
    from domains.sebrae_categoria import CATEGORIAS_NOVAS, normalizar  # sebrae_categoria imports this module: a top-level import would be circular

    return CATEGORIAS_NOVAS, normalizar


def _parte_da_aba(ler: Callable[[str], bytes], nome: str) -> str:
    """Path of the sheet called ``nome`` (``workbook.xml`` plus its relationships); ``""`` when there is none."""
    try:
        livro = ler("xl/workbook.xml").decode("utf-8")
        rel_id = next(_atributos(tag).get("r:id", "") for tag in _SHEET_TAG.findall(livro) if unescape(_atributos(tag).get("name", "")) == nome)
        return _relacoes(ler("xl/_rels/workbook.xml.rels").decode("utf-8"), "xl/workbook.xml")[rel_id][1]
    except (StopIteration, KeyError, UnicodeDecodeError):
        return ""


def _coluna_d(texto: str, compartilhadas: Sequence[str]) -> Optional[List[str]]:
    """Values of ``LISTAS!D`` under the header ``CATEGORIA``; ``None`` when the sheet is not what this module expects.

    Not expected: another header, a gap in the list, a value below the gap, or a formula in the list."""
    _, normalizar = _categorias()
    try:
        _, _, linhas = _linhas_da_aba(texto)
    except GravacaoInvalida:
        return None
    cabecalho = linhas.get(1)
    if cabecalho is None or normalizar(_valor_celula(cabecalho.celulas.get("D", ""), compartilhadas)) != "categoria":
        return None
    ocupadas: List[int] = []
    valores: List[str] = []
    for numero in sorted(n for n in linhas if n >= 2):
        bruto = linhas[numero].celulas.get("D", "")
        if "<f" in bruto:
            return None
        valor = _valor_celula(bruto, compartilhadas)
        if valor is not None:  # blank or absent cells are the gap the checks below look for
            ocupadas.append(numero)
            valores.append(valor)
    return valores if ocupadas == list(range(2, 2 + len(ocupadas))) else None


def _ler_listas_d(ler: Callable[[str], bytes], compartilhadas: Sequence[str]) -> Optional[Tuple[str, str, List[str]]]:
    """``(part, sheet text, values of LISTAS!D)``, or ``None`` when there is no usable LISTAS sheet."""
    parte = _parte_da_aba(ler, "LISTAS")
    if not parte:
        return None
    try:
        texto = ler(parte).decode("utf-8")
    except (KeyError, UnicodeDecodeError):
        return None
    valores = _coluna_d(texto, compartilhadas)
    return None if valores is None else (parte, texto, valores)


def _alargar_spans(abertura: str) -> str:
    achado = re.search(r'\bspans="(\d+):(\d+)"', abertura)
    if achado is None or int(achado.group(1)) <= 4 <= int(achado.group(2)):
        return abertura
    return abertura.replace(achado.group(0), f'spans="{min(4, int(achado.group(1)))}:{max(4, int(achado.group(2)))}"', 1)


def _inserir_em_d(texto: str, valores: Sequence[str], ultima: int) -> str:
    """The LISTAS sheet with ``valores`` as inline strings in D, right under row ``ultima``; rows keep their order, other cells stay."""
    _, fim, linhas = _linhas_da_aba(texto)
    estilo_da_lista = _estilo_da_celula(linhas[ultima].celulas.get("D", "")) if ultima > 1 and ultima in linhas else ""  # never the header's style
    edicoes: List[Tuple[int, int, int, str]] = []  # (start, end, row number, new text); start == end inserts
    for deslocamento, valor in enumerate(valores):
        numero = ultima + 1 + deslocamento
        existente = linhas.get(numero)
        estilo = (_estilo_da_celula(existente.celulas.get("D", "")) if existente else "") or estilo_da_lista
        celula = f'<c r="D{numero}"' + (f' s="{estilo}"' if estilo else "") + f' t="inlineStr"><is><t>{_texto_xml(valor)}</t></is></c>'
        if existente is not None:
            celulas = {**existente.celulas, "D": celula}
            novo = _alargar_spans(existente.abertura) + "".join(celulas[l] for l in sorted(celulas, key=_letra_para_indice)) + "</row>"
            edicoes.append((existente.inicio, existente.fim, numero, novo))
        else:
            seguinte = min((n for n in linhas if n > numero), default=None)
            posicao = linhas[seguinte].inicio if seguinte is not None else fim
            edicoes.append((posicao, posicao, numero, f'<row r="{numero}">{celula}</row>'))
    saida = ""
    cursor = 0
    for inicio, ate, _, novo in sorted(edicoes, key=lambda e: (e[0], e[2])):
        saida += texto[cursor:inicio] + novo
        cursor = ate
    saida += texto[cursor:]
    achado = re.search(r'<dimension ref="([A-Z]+\d+:[A-Z]+)(\d+)"', saida)
    if achado and int(achado.group(2)) < ultima + len(valores):
        saida = saida.replace(achado.group(0), f'<dimension ref="{achado.group(1)}{ultima + len(valores)}"', 1)
    return saida


def _estender_lista(texto: str, padrao: "re.Pattern[str]", ultima: int, nova: int) -> str:
    """Moves ``$D$<n>`` to ``nova`` where the reference ends at the old last row (or inside the new rows); a longer or shorter range is the user's."""
    return padrao.sub(lambda m: f"{m.group(1)}{nova}{m.group(3)}" if ultima <= int(m.group(2)) < nova else m.group(0), texto)


def _acrescentar_categorias(pacote: _Pacote, partes: Dict[str, bytes]) -> None:
    """Adds the categories of ``CATEGORIAS_NOVAS`` that LISTAS!D lacks (user's authorization of 09/11/2026: only add, never remove) and widens the B validation.

    No-op (with a warning in the log, no data) when there is no LISTAS sheet, no column D under ``CATEGORIA`` or no validation that reads it: the copy must still be generated.
    Names compare without accent or case. Nothing but ``partes`` is touched (``sharedStrings`` stays as it was)."""
    categorias, normalizar = _categorias()
    lida = _ler_listas_d(partes.__getitem__, pacote.compartilhadas)
    if lida is None:
        logger.warning("Categorias novas não acrescentadas: LISTAS!D ausente ou fora do formato esperado.")
        return
    parte, texto, atuais = lida
    existentes = {normalizar(valor) for valor in atuais}
    faltam = [categoria for categoria in categorias if normalizar(categoria) not in existentes]
    folha = partes[pacote.aba].decode("utf-8")
    livro = partes["xl/workbook.xml"].decode("utf-8")
    if not faltam:
        return
    if not (_VALIDACAO_D.search(folha) or _NOME_D.search(livro)):
        logger.warning("Categorias novas não acrescentadas: nenhuma validação de dados lê LISTAS!D.")
        return
    ultima = 1 + len(atuais)
    nova = ultima + len(faltam)
    novo_texto = _inserir_em_d(texto, faltam, ultima)
    partes[parte] = novo_texto.encode("utf-8")
    partes[pacote.aba] = _estender_lista(folha, _VALIDACAO_D, ultima, nova).encode("utf-8")
    partes["xl/workbook.xml"] = _estender_lista(livro, _NOME_D, ultima, nova).encode("utf-8")
    rels = parte.rsplit("/", 1)[0] + "/_rels/" + parte.rsplit("/", 1)[1] + ".rels"
    if rels in partes:  # a table that is exactly D1:D<last> grows with the list; any other shape is left alone
        for tipo, destino in _relacoes(partes[rels].decode("utf-8"), parte).values():
            if tipo.endswith("/table") and destino in partes:
                partes[destino] = partes[destino].decode("utf-8").replace(f'ref="D1:D{ultima}"', f'ref="D1:D{nova}"').encode("utf-8")


def _categorias_conferem(arquivo: zipfile.ZipFile, pacote: _Pacote) -> bool:
    """LISTAS!D of the copy keeps every original value in place and adds only categories of ``CATEGORIAS_NOVAS`` that were missing, once each."""
    categorias, normalizar = _categorias()
    antes = _ler_listas_d(pacote.partes.__getitem__, pacote.compartilhadas)
    depois = _ler_listas_d(arquivo.read, pacote.compartilhadas)
    if antes is None or depois is None:
        return antes is None and depois is None
    ElementTree.fromstring(depois[1])  # ParseError is handled by ``_conferir``
    originais, finais = antes[2], depois[2]
    acrescentadas = [normalizar(valor) for valor in finais[len(originais):]]
    permitidas = {normalizar(c) for c in categorias} - {normalizar(valor) for valor in originais}
    return finais[: len(originais)] == originais and len(set(acrescentadas)) == len(acrescentadas) and set(acrescentadas) <= permitidas


# ---------------------------------------------------------------------------- entry point

def atualizar(
    conteudo: bytes,
    novas: Sequence[Mapping[str, str]] = (),
    edicoes: Optional[Mapping[str, Mapping[str, str]]] = None,
    automaticos: Optional[Mapping[str, Mapping[str, str]]] = None,
) -> Resultado:
    """Copy of the Dashboard with ``novas`` in the first free rows of Tabela3 and ``edicoes`` in existing rows.

    ``novas``: rows as ``sebrae_novos`` builds them (keys are column letters, ``C`` is the ticket).
    ``edicoes``: ``{key: {manual column: value}}`` (key as in ``ChamadoAberto.numero``); only manual columns, only
    cells whose value changed, and blank values never erase a cell.
    ``automaticos``: ``{key: {E, K, L or N: value}}``, written only into cells that are empty in the sheet.
    Raises ``GravacaoInvalida`` (message for the user) when it cannot.
    """
    edicoes = edicoes or {}
    automaticos = automaticos or {}
    anteriores = ler_coluna_c(conteudo)  # also checks the headers of the sheet
    pacote = _ler_pacote(conteudo)
    texto = pacote.texto(pacote.aba)
    inicio, fim, linhas = _linhas_da_aba(texto)
    compartilhadas = pacote.compartilhadas

    repetidas = sorted(str(linha.get("C", "")) for linha in novas if str(linha.get("C", "")) in anteriores)
    if repetidas:
        raise GravacaoInvalida(f"{repetidas[0]} já está na coluna C do Dashboard.")
    if len({str(linha.get("C", "")) for linha in novas}) != len(novas):
        raise GravacaoInvalida("Há chamados repetidos entre as linhas novas.")

    estilos = _estilos_modais(linhas, compartilhadas)
    formula_q = _formula_de_q(linhas)
    com_dado = [n for n, l in linhas.items() if n >= 2 and _tem_dado(l, compartilhadas)]
    primeira_livre = (max(com_dado) if com_dado else 1) + 1
    if novas and (primeira_livre + len(novas) - 1 > pacote.tabela_ultima_linha or any(n not in linhas for n in range(primeira_livre, primeira_livre + len(novas)))):
        raise GravacaoInvalida(f"Sem espaço na {TABELA}: faltam linhas livres para {len(novas)} chamado(s).")

    substituicoes: Dict[int, str] = {}
    gravadas: List[LinhaGravada] = []
    for deslocamento, valores in enumerate(novas):
        numero_linha = primeira_livre + deslocamento
        letras = {letra: str(valor) for letra, valor in valores.items() if letra in COLUNAS_DE_TABELA and letra not in FORMULAS_DA_LINHA}
        substituicoes[numero_linha] = _reescrever_linha(linhas[numero_linha], letras, estilos, formula_q, False)
        gravadas.append(LinhaGravada(str(valores.get("C", "")), numero_linha, "novo", tuple(sorted(l for l, v in letras.items() if v != ""))))

    if edicoes or automaticos:
        abertos = {c.numero: c for c in _abertos(linhas, compartilhadas)}
        for chamado in [*edicoes, *(c for c in automaticos if c not in edicoes)]:
            aberto = abertos.get(chamado)
            if aberto is None:
                raise GravacaoInvalida(f"{chamado}: não está entre os chamados antigos em aberto do Dashboard.")
            linha = linhas[aberto.linha]
            alteradas: Dict[str, str] = {}
            for letra, novo in (edicoes.get(chamado) or {}).items():
                if letra not in MANUAIS:
                    raise GravacaoInvalida(f"{chamado}: a coluna {letra} não pode ser editada pelo site.")
                novo = " ".join(str(novo).split())
                if novo and novo != _valor_legivel(letra, linha.celulas.get(letra, ""), compartilhadas):
                    alteradas[letra] = novo
            for letra, novo in (automaticos.get(chamado) or {}).items():
                if letra not in AUTOMATICAS_VAZIAS:
                    raise GravacaoInvalida(f"{chamado}: a coluna {letra} não pode ser preenchida pelo site.")
                if novo and _valor_celula(linha.celulas.get(letra, ""), compartilhadas) is None:  # never over an existing value
                    alteradas[letra] = " ".join(str(novo).split())
            if alteradas:
                substituicoes[linha.numero] = _reescrever_linha(linha, alteradas, estilos, "", True)
                gravadas.append(LinhaGravada(chamado, linha.numero, "alterado", tuple(sorted(alteradas))))

    resultado, mapa = _entregar(pacote, texto, linhas, substituicoes, anteriores, [str(l.get("C", "")) for l in novas], True)
    return Resultado(resultado, tuple(replace(g, linha=mapa.get(g.linha, g.linha)) for g in gravadas))


def _entregar(
    pacote: _Pacote, texto: str, linhas: Mapping[int, _Linha], substituicoes: Mapping[int, str], anteriores: frozenset[str], novos: Sequence[str],
    categorias: bool = False,
) -> Tuple[bytes, Mapping[int, int]]:
    """Sorts by column C, builds the workbook and checks it; the map gives the final row of every row of the sorted range.

    ``categorias``: also completes LISTAS!D (only ``atualizar``; closing a ticket must not touch the lists)."""
    ordem = _ordenar(pacote, linhas, substituicoes)
    conteudo = _montar(pacote, texto, linhas, ordem.substituicoes, any(antes != depois for antes, depois in ordem.mapa.items()), categorias)
    _conferir(conteudo, anteriores, novos, pacote, ordem, categorias)
    return conteudo, ordem.mapa


def _montar(
    pacote: _Pacote, texto: str, linhas: Mapping[int, _Linha], substituicoes: Mapping[int, str], sem_calc_chain: bool = False, categorias: bool = False,
) -> bytes:
    """The workbook with the rewritten rows spliced into the sheet; every other part is copied as it was.

    ``sem_calc_chain``: rows moved, so the calculation chain (which lists cells by address) is dropped with its
    content type and relationship; Excel rebuilds it on load."""
    novo_texto = ""
    cursor = 0
    for numero_linha in sorted(substituicoes):
        original = linhas[numero_linha]
        novo_texto += texto[cursor:original.inicio] + substituicoes[numero_linha]
        cursor = original.fim
    novo_texto += texto[cursor:]

    partes = dict(pacote.partes)
    if sem_calc_chain:
        partes.pop("xl/calcChain.xml", None)
        for nome, padrao in (
            ("[Content_Types].xml", r'<Override\b[^>]*\bPartName="/xl/calcChain\.xml"[^>]*/>'),
            ("xl/_rels/workbook.xml.rels", r'<Relationship\b[^>]*\bType="[^"]*/calcChain"[^>]*/>'),
        ):
            if nome in partes:
                partes[nome] = re.sub(padrao, "", partes[nome].decode("utf-8")).encode("utf-8")
    partes[pacote.aba] = novo_texto.encode("utf-8")
    partes["xl/workbook.xml"] = _recalcular_ao_abrir(pacote.texto("xl/workbook.xml")).encode("utf-8")
    if categorias:
        _acrescentar_categorias(pacote, partes)
    for nome, dados in pacote.partes.items():
        if nome.startswith("xl/pivotCache/pivotCacheDefinition") and nome.endswith(".xml") and f'name="{TABELA}"' in dados.decode("utf-8", "ignore"):
            partes[nome] = _atualizar_ao_abrir(dados.decode("utf-8")).encode("utf-8")

    saida = io.BytesIO()
    with zipfile.ZipFile(saida, "w") as destino:
        for entrada in pacote.entradas:
            if entrada.filename not in partes:
                continue
            copia = zipfile.ZipInfo(entrada.filename, entrada.date_time)
            copia.compress_type = entrada.compress_type
            copia.external_attr = entrada.external_attr
            copia.create_system = entrada.create_system
            destino.writestr(copia, partes[entrada.filename])
    return saida.getvalue()


ENCERRAMENTO_GRAVADO = "gravado"
ENCERRAMENTO_NAO_ENCONTRADO = "nao_encontrado"
ENCERRAMENTO_AMBIGUO = "ambiguo"


def registrar_encerramentos(conteudo: bytes, encerramentos: Mapping[str, str]) -> Tuple[Resultado, Dict[str, str]]:
    """Writes DT ENCERRAMENTO (column R) and status D = FINALIZADO of tickets closed in SoftExpert; the row is found by the UTIC in column C.

    ``encerramentos``: ``{UTIC: "dd/MM/aaaa HH:mm"}``. Unlike ``atualizar`` this reaches rows of any status (the
    ticket has just been finalized) but only columns D and R, and only when exactly one row holds the UTIC. The SoftExpert time
    replaces a date typed by hand in R (the user chose this on 31/10/2026). Gives the new workbook (the same
    bytes when nothing changed) and, per UTIC, ``gravado`` / ``nao_encontrado`` / ``ambiguo``.
    """
    anteriores = ler_coluna_c(conteudo)  # also checks the headers of the sheet
    pacote = _ler_pacote(conteudo)
    texto = pacote.texto(pacote.aba)
    _, _, linhas = _linhas_da_aba(texto)
    por_numero: Dict[str, List[_Linha]] = {}
    for numero in sorted(linhas):
        linha = linhas[numero]
        if numero >= 2 and _tem_dado(linha, pacote.compartilhadas):
            achados = extrair_numeros(_valor_legivel("C", linha.celulas.get("C", ""), pacote.compartilhadas))
            for utic in set(achados):
                por_numero.setdefault(utic, []).append(linha)
    estados: Dict[str, str] = {}
    substituicoes: Dict[int, str] = {}
    gravadas: List[LinhaGravada] = []
    estilos = _estilos_modais(linhas, pacote.compartilhadas)
    for utic, quando in encerramentos.items():
        donas = por_numero.get(utic, [])
        if not donas:
            estados[utic] = ENCERRAMENTO_NAO_ENCONTRADO
        elif len(donas) > 1:
            estados[utic] = ENCERRAMENTO_AMBIGUO
        else:
            # R vazia ou digitada à mão: o horário do SoftExpert substitui. D junto com R: a linha finalizada no SoftExpert não pode continuar "EM ABERTO".
            substituicoes[donas[0].numero] = _reescrever_linha(donas[0], {"D": STATUS_FINALIZADO, "R": quando}, estilos, "", True)
            gravadas.append(LinhaGravada(utic, donas[0].numero, "alterado", ("D", "R")))
            estados[utic] = ENCERRAMENTO_GRAVADO
    if not substituicoes:
        return Resultado(conteudo), estados
    novo, mapa = _entregar(pacote, texto, linhas, substituicoes, anteriores, [])
    return Resultado(novo, tuple(replace(g, linha=mapa.get(g.linha, g.linha)) for g in gravadas)), estados


def _recalcular_ao_abrir(workbook: str) -> str:
    achado = re.search(r"<calcPr\b([^>]*?)/>", workbook)
    if achado is None or "fullCalcOnLoad" in achado.group(1):
        return workbook  # no calcPr to extend: inserting one out of schema order would corrupt the file
    return workbook.replace(achado.group(0), f'<calcPr{achado.group(1)} fullCalcOnLoad="1"/>', 1)


def _atualizar_ao_abrir(cache: str) -> str:
    achado = re.search(r"<pivotCacheDefinition\b[^>]*>", cache)
    if achado is None or "refreshOnLoad" in achado.group(0):
        return cache
    return cache.replace(achado.group(0), achado.group(0)[:-1] + ' refreshOnLoad="1">', 1)


def _conferir(conteudo: bytes, anteriores: frozenset[str], novos: Sequence[str], pacote: _Pacote, ordem: _Ordem, categorias: bool = False) -> None:
    """Self-check before handing the file over: it must reopen, be well formed, keep column C coherent and be a pure reordering of the rows.

    ``categorias``: LISTAS!D must keep its original values in order and only gain ``CATEGORIAS_NOVAS``."""
    try:
        with zipfile.ZipFile(io.BytesIO(conteudo)) as arquivo:
            if arquivo.testzip() is not None:
                raise GravacaoInvalida("A cópia gerada ficou corrompida; nada foi entregue.")
            folha = arquivo.read(pacote.aba).decode("utf-8")
            ElementTree.fromstring(folha)
            ElementTree.fromstring(arquivo.read("xl/workbook.xml"))
            if categorias and not _categorias_conferem(arquivo, pacote):
                raise GravacaoInvalida("A lista de categorias da cópia não confere com a original; nada foi entregue.")
        if ler_coluna_c(conteudo) != anteriores | frozenset(novos):
            raise GravacaoInvalida("A coluna C da cópia não confere com o esperado; nada foi entregue.")
    except (zipfile.BadZipFile, ElementTree.ParseError) as erro:
        raise GravacaoInvalida("A cópia gerada não passou na conferência; nada foi entregue.") from erro
    if not ordem.ultimo:
        return
    _, _, linhas = _linhas_da_aba(folha)
    faixa = range(2, ordem.ultimo + 1)
    if any(n not in linhas for n in faixa) or Counter(_assinatura(linhas[n]) for n in faixa) != ordem.esperado:
        raise GravacaoInvalida("As linhas da cópia não conferem com as originais depois de ordenar; nada foi entregue.")
    if any((ref := re.match(r'<c r="[A-Z]+(\d+)"', c)) is None or int(ref.group(1)) != n for n in faixa for c in linhas[n].celulas.values()):
        raise GravacaoInvalida("Uma célula da cópia ficou na linha errada depois de ordenar; nada foi entregue.")
    chaves = [_chave_da_linha(linhas[n], pacote.compartilhadas) for n in faixa]
    if any(a > b for a, b in zip(chaves, chaves[1:])):
        raise GravacaoInvalida("A coluna C da cópia não ficou em ordem crescente; nada foi entregue.")


__all__ = [
    "AUTOMATICAS_VAZIAS", "CHAVE_DE_LINHA", "ChamadoAberto", "ENCERRAMENTO_AMBIGUO", "ENCERRAMENTO_GRAVADO",
    "ENCERRAMENTO_NAO_ENCONTRADO", "GravacaoInvalida", "LinhaGravada", "Resultado",
    "atualizar", "chamados_para_editar", "chave_coluna_c", "ler_listas", "registrar_encerramentos",
]
