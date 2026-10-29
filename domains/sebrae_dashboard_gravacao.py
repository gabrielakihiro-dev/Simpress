"""Writes tickets into a COPY of the imported Dashboard (docs/operacao/sincronizar-chamados-sebrae.md).

A ``.xlsx`` is a ZIP of XML parts. Only the text of the CHAMADOS sheet, ``workbook.xml``, ``calcChain.xml`` and the
``Tabela3`` pivot cache are edited here, by plain text splicing: every other part is copied byte for byte, so the
validations (x14 extension), pivots, charts and comments survive. openpyxl is never used to write: it would drop them.

One primitive sets cells in a row; it serves new tickets (first free rows of ``Tabela3``) and edits of the manual
columns of tickets already in the sheet. Ticket content is data; nothing here interprets it.
"""

from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from html import unescape
from typing import Dict, List, Mapping, Optional, Sequence, Tuple
from xml.etree import ElementTree

from domains.sebrae_dashboard import ABA, DashboardInvalido, MANUAIS, _validar_pacote, ler_coluna_c

TABELA = "Tabela3"
FORMATO_DATA_HORA = "%d/%m/%Y %H:%M"
_EPOCA = datetime(1899, 12, 30)
COLUNAS_DE_DADO = tuple("ABCDEFGHIJKLMNOP") + ("R", "S")  # a row with any of these filled is a ticket row
COLUNAS_DE_TABELA = tuple("ABCDEFGHIJKLMNOPQRSTUV")
COLUNAS_DE_DATA = ("P", "R")
FORMULAS_DA_LINHA = ("Q", "T", "U", "V")
MAX_CARACTERES_CELULA = 32_767

_SHEET_TAG = re.compile(r"<sheet\b[^>]*/>")
_ATRIBUTO = re.compile(r'([\w:]+)="([^"]*)"')
_LINHA = re.compile(r'<row r="(\d+)"([^>]*?)(?:/>|>(.*?)</row>)', re.DOTALL)
_CELULA = re.compile(r'<c r="([A-Z]+)\d+"([^>]*?)(?:/>|>(.*?)</c>)', re.DOTALL)
_SI = re.compile(r"<si\b[^>]*?(?:/>|>(.*?)</si>)", re.DOTALL)
_TEXTO = re.compile(r"<t\b[^>]*?(?:/>|>(.*?)</t>)", re.DOTALL)
_PROIBIDOS_XML = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")
_ESCAPE_LITERAL = re.compile(r"_x(?=[0-9A-Fa-f]{4}_)")


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
        if not ultima:
            raise GravacaoInvalida(f"A aba {ABA} não tem a tabela {TABELA}.")
        pacote.tabela_ultima_linha = ultima
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
        numero = int(achado.group(1))
        celulas = {m.group(1): m.group(0) for m in _CELULA.finditer(achado.group(3) or "")}
        abertura = achado.group(0)[: achado.group(0).find(">") + 1].replace("/>", ">")
        linhas[numero] = _Linha(numero, abertura, celulas, achado.start(), achado.end())
    return inicio, fim, linhas


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


@dataclass(frozen=True)
class ChamadoAberto:
    numero: str
    linha: int
    titulo: str
    valores: Mapping[str, str]  # manual columns as stored in the sheet


def chamados_para_editar(conteudo: bytes) -> List[ChamadoAberto]:
    """Tickets already in the sheet whose D is EM ABERTO or empty (the saved filter of column D)."""
    pacote = _ler_pacote(conteudo)
    _, _, linhas = _linhas_da_aba(pacote.texto(pacote.aba))
    encontrados: List[ChamadoAberto] = []
    vistos: Dict[str, int] = {}
    for numero in sorted(linhas):
        linha = linhas[numero]
        if numero < 2 or not _tem_dado(linha, pacote.compartilhadas):
            continue
        chamado = _valor_legivel("C", linha.celulas.get("C", ""), pacote.compartilhadas)
        if not re.fullmatch(r"UTIC-\d{4}-\d+", chamado):
            continue
        vistos[chamado] = vistos.get(chamado, 0) + 1
        valores = {letra: _valor_legivel(letra, linha.celulas.get(letra, ""), pacote.compartilhadas) for letra in MANUAIS}
        if valores["D"].upper() in ("", "EM ABERTO"):
            encontrados.append(ChamadoAberto(chamado, numero, _valor_legivel("G", linha.celulas.get("G", ""), pacote.compartilhadas), valores))
    return [c for c in encontrados if vistos[c.numero] == 1]


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


# ---------------------------------------------------------------------------- entry point

def atualizar(
    conteudo: bytes,
    novas: Sequence[Mapping[str, str]] = (),
    edicoes: Optional[Mapping[str, Mapping[str, str]]] = None,
) -> Resultado:
    """Copy of the Dashboard with ``novas`` in the first free rows of Tabela3 and ``edicoes`` in existing rows.

    ``novas``: rows as ``sebrae_novos`` builds them (keys are column letters, ``C`` is the ticket).
    ``edicoes``: ``{ticket: {manual column: value}}``; only manual columns, only cells whose value changed,
    and blank values never erase a cell. Raises ``GravacaoInvalida`` (message for the user) when it cannot.
    """
    edicoes = edicoes or {}
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

    if edicoes:
        por_chamado: Dict[str, List[int]] = {}
        for numero_linha, linha in linhas.items():
            valor_c = _valor_legivel("C", linha.celulas.get("C", ""), compartilhadas)
            if valor_c in edicoes:
                por_chamado.setdefault(valor_c, []).append(numero_linha)
        for chamado, mudancas in edicoes.items():
            achadas = por_chamado.get(chamado, [])
            if len(achadas) != 1:
                raise GravacaoInvalida(f"{chamado}: " + ("não está na coluna C do Dashboard." if not achadas else "aparece mais de uma vez na coluna C; corrija a planilha."))
            linha = linhas[achadas[0]]
            alteradas: Dict[str, str] = {}
            for letra, novo in mudancas.items():
                if letra not in MANUAIS:
                    raise GravacaoInvalida(f"{chamado}: a coluna {letra} não pode ser editada pelo site.")
                novo = " ".join(str(novo).split())
                if novo and novo != _valor_legivel(letra, linha.celulas.get(letra, ""), compartilhadas):
                    alteradas[letra] = novo
            if alteradas:
                substituicoes[achadas[0]] = _reescrever_linha(linha, alteradas, estilos, "", True)
                gravadas.append(LinhaGravada(chamado, achadas[0], "alterado", tuple(sorted(alteradas))))

    novo_texto = ""
    cursor = 0
    for numero_linha in sorted(substituicoes):
        original = linhas[numero_linha]
        novo_texto += texto[cursor:original.inicio] + substituicoes[numero_linha]
        cursor = original.fim
    novo_texto += texto[cursor:]

    # calcChain is left alone: fullCalcOnLoad makes Excel rebuild it (shortcut: if Excel asks to repair, drop the part).
    partes = dict(pacote.partes)
    partes[pacote.aba] = novo_texto.encode("utf-8")
    partes["xl/workbook.xml"] = _recalcular_ao_abrir(pacote.texto("xl/workbook.xml")).encode("utf-8")
    for nome, dados in pacote.partes.items():
        if nome.startswith("xl/pivotCache/pivotCacheDefinition") and nome.endswith(".xml") and f'name="{TABELA}"' in dados.decode("utf-8", "ignore"):
            partes[nome] = _atualizar_ao_abrir(dados.decode("utf-8")).encode("utf-8")

    saida = io.BytesIO()
    with zipfile.ZipFile(saida, "w") as destino:
        for entrada in pacote.entradas:
            copia = zipfile.ZipInfo(entrada.filename, entrada.date_time)
            copia.compress_type = entrada.compress_type
            copia.external_attr = entrada.external_attr
            copia.create_system = entrada.create_system
            destino.writestr(copia, partes[entrada.filename])
    resultado = saida.getvalue()
    _conferir(resultado, anteriores, [str(l.get("C", "")) for l in novas], pacote.aba)
    return Resultado(resultado, tuple(gravadas))


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


def _conferir(conteudo: bytes, anteriores: frozenset[str], novos: Sequence[str], aba: str) -> None:
    """Self-check before handing the file over: it must reopen, be well formed and keep column C coherent."""
    try:
        with zipfile.ZipFile(io.BytesIO(conteudo)) as arquivo:
            if arquivo.testzip() is not None:
                raise GravacaoInvalida("A cópia gerada ficou corrompida; nada foi entregue.")
            ElementTree.fromstring(arquivo.read(aba))
            ElementTree.fromstring(arquivo.read("xl/workbook.xml"))
        if ler_coluna_c(conteudo) != anteriores | frozenset(novos):
            raise GravacaoInvalida("A coluna C da cópia não confere com o esperado; nada foi entregue.")
    except (zipfile.BadZipFile, ElementTree.ParseError) as erro:
        raise GravacaoInvalida("A cópia gerada não passou na conferência; nada foi entregue.") from erro


__all__ = [
    "ChamadoAberto", "GravacaoInvalida", "LinhaGravada", "Resultado", "atualizar", "chamados_para_editar", "ler_listas",
]
