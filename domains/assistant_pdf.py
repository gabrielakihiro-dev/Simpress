"""Plain-text extraction from a PDF, in process and without extra libraries (none is installed).

shortcut: covers the common case (text in Flate streams or object streams, simple fonts, fonts with a
ToUnicode map). Encrypted files, other filters (LZW, ASCII85) and fonts without a ToUnicode map yield no
text; scanned pages never do (there is no OCR). Upgrade by adding `pypdf` if real files fail often.
"""

import logging
import re
import time
import zlib
from typing import Dict, List, Optional, Tuple

MAX_DESCOMPRIMIDO = 32 * 1024 * 1024
MAX_TEXTO = 300_000
MAX_SEGUNDOS = 20.0
MAX_MAPA_FONTE = 65_536
ARRAY_ESPACO = -200  # a gap this large inside a TJ array is a word space

_OBJETO = re.compile(rb"(?<![0-9])(\d+)\s+(\d+)\s+obj\b")
_REF = rb"(\d+)\s+\d+\s+R"
_TOKEN = re.compile(rb"%[^\r\n]*|<<|>>|\[|\]|<[0-9A-Fa-f\s]*>|/[^\s/\[\]()<>%]*|[+-]?(?:\d+\.?\d*|\.\d+)|[A-Za-z'\"*]+")


logger = logging.getLogger(__name__)


class PdfSemTexto(Exception):
    """The file cannot be read as text; the message is safe to show."""


def _descomprimir(dados: bytes, orcamento: List[int]) -> Optional[bytes]:
    decodificador = zlib.decompressobj()
    try:
        saida = decodificador.decompress(dados, orcamento[0] + 1)
    except zlib.error:
        return None
    if len(saida) > orcamento[0]:
        raise PdfSemTexto("O PDF descompactado é grande demais.")
    orcamento[0] -= len(saida)
    return saida


def _dict_balanceado(texto: bytes, inicio: int) -> bytes:
    """The `<< ... >>` that starts at `inicio` (nested dictionaries included)."""
    nivel = 0
    for achado in re.finditer(rb"<<|>>", texto[inicio:]):
        nivel += 1 if achado.group() == b"<<" else -1
        if nivel == 0:
            return texto[inicio:inicio + achado.end()]
    return texto[inicio:]


def _valor(dic: bytes, chave: bytes) -> Optional[bytes]:
    """Raw value after `/Chave`: a nested dictionary, a `[...]` array, a reference or one token."""
    achado = re.search(rb"/" + chave + rb"(?![A-Za-z0-9])\s*", dic)
    if not achado:
        return None
    resto = dic[achado.end():]
    if resto.startswith(b"<<"):
        return _dict_balanceado(resto, 0)
    if resto.startswith(b"["):
        return resto[:resto.find(b"]") + 1]
    ref = re.match(_REF, resto)
    if ref:
        return ref.group()
    simples = re.match(rb"/[^\s/\[\]()<>]+|[^\s/\[\]()<>]+", resto)
    return simples.group() if simples else None


def _refs(valor: Optional[bytes]) -> List[int]:
    return [int(n) for n in re.findall(_REF, valor or b"")]


class _Documento:
    def __init__(self, dados: bytes) -> None:
        self.objetos: Dict[int, Tuple[bytes, Optional[bytes]]] = {}
        self._fontes: Dict[int, "_Fonte"] = {}
        self._orcamento = [MAX_DESCOMPRIMIDO]
        marcas = list(_OBJETO.finditer(dados))
        for i, marca in enumerate(marcas):
            fim = marcas[i + 1].start() if i + 1 < len(marcas) else len(dados)
            corpo = dados[marca.end():fim]
            posicao = corpo.find(b"stream")
            dic = corpo if posicao < 0 else corpo[:posicao]
            fluxo = None
            if posicao >= 0:
                bruto = corpo[posicao + 6:].lstrip(b"\r\n")
                bruto = bruto[:bruto.rfind(b"endstream")] if b"endstream" in bruto else bruto
                fluxo = self._decodificar(dic, bruto)
            self.objetos[int(marca.group(1))] = (dic, fluxo)
        for numero in list(self.objetos):
            dic, fluxo = self.objetos[numero]
            if fluxo is not None and re.search(rb"/Type\s*/ObjStm", dic):
                self._abrir_fluxo_de_objetos(dic, fluxo)

    def _decodificar(self, dic: bytes, bruto: bytes) -> Optional[bytes]:
        filtro = _valor(dic, b"Filter")
        if filtro is None:
            return bruto
        if filtro.strip(b"[] ") in (b"/FlateDecode", b"/Fl"):
            return _descomprimir(bruto, self._orcamento)
        return None

    def _abrir_fluxo_de_objetos(self, dic: bytes, fluxo: bytes) -> None:
        quantidade = re.search(rb"/N\s+(\d+)", dic)
        primeiro = re.search(rb"/First\s+(\d+)", dic)
        if not quantidade or not primeiro:
            return
        pares = [int(n) for n in re.findall(rb"\d+", fluxo[:int(primeiro.group(1))])]
        base = int(primeiro.group(1))
        indices = list(zip(pares[0::2], pares[1::2]))[:int(quantidade.group(1))]
        for i, (numero, deslocamento) in enumerate(indices):
            fim = indices[i + 1][1] if i + 1 < len(indices) else len(fluxo) - base
            self.objetos.setdefault(numero, (fluxo[base + deslocamento:base + fim], None))

    def dic(self, numero: int) -> bytes:
        return self.objetos.get(numero, (b"", None))[0]

    def fluxo(self, numero: int) -> bytes:
        return self.objetos.get(numero, (b"", None))[1] or b""

    def paginas(self) -> List[int]:
        raiz = next((_refs(_valor(d, b"Pages"))[:1] for d, _ in self.objetos.values() if re.search(rb"/Type\s*/Catalog", d)), [])
        ordem: List[int] = []
        vistos: set = set()

        def visitar(numero: int, fundo: int = 0) -> None:
            dic = self.dic(numero)
            if fundo > 32 or numero in vistos:
                return
            vistos.add(numero)
            if re.search(rb"/Type\s*/Pages", dic):
                for filho in _refs(_valor(dic, b"Kids")):
                    visitar(filho, fundo + 1)
            elif re.search(rb"/Type\s*/Page(?![A-Za-z])", dic):
                ordem.append(numero)

        if raiz:
            visitar(raiz[0])
        return ordem or sorted(n for n, (d, _) in self.objetos.items() if re.search(rb"/Type\s*/Page(?![A-Za-z])", d))

    def recursos(self, numero: int, fundo: int = 0) -> bytes:
        """The page's /Resources dictionary, inherited from /Parent when the page has none."""
        dic = self.dic(numero)
        valor = _valor(dic, b"Resources")
        if valor is None and fundo < 32:
            pai = _refs(_valor(dic, b"Parent"))
            return self.recursos(pai[0], fundo + 1) if pai else b""
        ref = _refs(valor)
        return self.dic(ref[0]) if ref and not (valor or b"").startswith(b"<<") else valor or b""

    def fontes(self, recursos: bytes) -> Dict[bytes, "_Fonte"]:
        valor = _valor(recursos, b"Font") or b""
        if not valor.startswith(b"<<"):
            ref = _refs(valor)
            valor = self.dic(ref[0]) if ref else b""
        return {nome: self._fonte(int(numero)) for nome, numero in re.findall(rb"/([^\s/\[\]()<>]+)\s+" + _REF, valor)}

    def _fonte(self, numero: int) -> "_Fonte":
        if numero not in self._fontes:
            dic = self.dic(numero)
            mapa = _refs(_valor(dic, b"ToUnicode"))
            composta = bool(re.search(rb"/Subtype\s*/Type0", dic))
            self._fontes[numero] = _Fonte(self.fluxo(mapa[0]) if mapa else None, composta)
        return self._fontes[numero]


class _Fonte:
    """Turns the bytes of a PDF string into text."""

    def __init__(self, cmap: Optional[bytes], composta: bool) -> None:
        self.mapa: Dict[int, str] = {}
        self.largura = 2 if composta else 1
        self.legivel = bool(cmap) or not composta
        if cmap:
            self._ler_cmap(cmap)

    def _ler_cmap(self, cmap: bytes) -> None:
        def utf16(hexa: bytes) -> str:
            hexa = hexa + b"0" * (len(hexa) % 2)
            return bytes.fromhex(hexa.decode()).decode("utf-16-be", "replace")

        def guardar(codigo: int, texto: str) -> None:
            if len(self.mapa) < MAX_MAPA_FONTE:
                self.mapa[codigo] = texto

        codigo = re.search(rb"begincodespacerange\s*<([0-9A-Fa-f]+)>", cmap)
        if codigo:
            self.largura = max(1, len(codigo.group(1)) // 2)
        for bloco in re.findall(rb"beginbfchar(.*?)endbfchar", cmap, re.DOTALL):
            for origem, destino in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>", bloco):
                guardar(int(origem, 16), utf16(destino))
        for bloco in re.findall(rb"beginbfrange(.*?)endbfrange", cmap, re.DOTALL):
            for ini, fim, resto in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]*>|\[[^\]]*\])", bloco):
                inicio, limite = int(ini, 16), min(int(fim, 16), int(ini, 16) + 0xFFFF)
                destinos = re.findall(rb"<([0-9A-Fa-f]*)>", resto)
                if resto.startswith(b"["):
                    for deslocamento, destino in enumerate(destinos[:limite - inicio + 1]):
                        guardar(inicio + deslocamento, utf16(destino))
                elif destinos and destinos[0]:
                    base = utf16(destinos[0])
                    for deslocamento in range(limite - inicio + 1):
                        if not base or len(self.mapa) >= MAX_MAPA_FONTE:
                            break
                        guardar(inicio + deslocamento, base[:-1] + chr(min(ord(base[-1]) + deslocamento, 0x10FFFF)))

    def decodificar(self, dados: bytes) -> str:
        if not self.legivel:
            return ""
        if not self.mapa:
            return dados.decode("cp1252", "replace")
        passo = self.largura
        return "".join(self.mapa.get(int.from_bytes(dados[i:i + passo], "big"), "") for i in range(0, len(dados), passo))


_ESCAPES = {ord("n"): b"\n", ord("r"): b"\r", ord("t"): b"\t", ord("b"): b"\b", ord("f"): b"\f"}


def _cadeia_literal(dados: bytes, posicao: int) -> Tuple[bytes, int]:
    """String that starts after `(` at `posicao`; returns it and the position after the closing `)`."""
    saida = bytearray()
    nivel = 1
    i = posicao
    while i < len(dados):
        c = dados[i]
        if c == 0x5C and i + 1 < len(dados):  # backslash
            i += 1
            c = dados[i]
            octal = re.match(rb"[0-7]{1,3}", dados[i:i + 3])
            if octal:
                saida.append(int(octal.group(), 8) & 0xFF)
                i += len(octal.group())
                continue
            if c in _ESCAPES:
                saida += _ESCAPES[c]
            elif c not in (10, 13):
                saida.append(c)
        elif c == 0x28:
            nivel += 1
            saida.append(c)
        elif c == 0x29:
            nivel -= 1
            if nivel == 0:
                return bytes(saida), i + 1
            saida.append(c)
        else:
            saida.append(c)
        i += 1
    return bytes(saida), i


def _texto_do_conteudo(conteudo: bytes, fontes: Dict[bytes, _Fonte]) -> str:
    saida: List[str] = []
    operandos: List[object] = []
    fonte = _Fonte(None, False)
    i = 0
    while i < len(conteudo):
        if conteudo[i:i + 1] == b"(":
            cadeia, i = _cadeia_literal(conteudo, i + 1)
            operandos.append(cadeia)
            continue
        achado = _TOKEN.match(conteudo, i)
        if not achado:
            i += 1
            continue
        i = achado.end()
        token = achado.group()
        if token.startswith(b"<") and token not in (b"<<",):
            operandos.append(bytes.fromhex(re.sub(rb"\s", b"", token[1:-1]).decode() + ("0" if len(re.sub(rb"\s", b"", token[1:-1])) % 2 else "")))
        elif token.startswith(b"/"):
            operandos.append(token[1:])
        elif token in (b"[", b"]", b"<<", b">>") or token.startswith(b"%"):
            operandos.append(token if token in (b"[", b"]") else None)
        elif re.match(rb"[+-]?[\d.]", token):
            try:
                operandos.append(float(token))
            except ValueError:
                operandos.append(0.0)
        else:
            if token == b"BI":  # inline image: binary data up to EI
                fim = conteudo.find(b"EI", i)
                i = len(conteudo) if fim < 0 else fim + 2
            elif token == b"Tf" and len(operandos) >= 2 and isinstance(operandos[-2], bytes):
                fonte = fontes.get(operandos[-2]) or _Fonte(None, False)
            elif token == b"Tj" and operandos and isinstance(operandos[-1], bytes):
                saida.append(fonte.decodificar(operandos[-1]))
            elif token in (b"'", b'"'):
                saida.append("\n")
                if operandos and isinstance(operandos[-1], bytes):
                    saida.append(fonte.decodificar(operandos[-1]))
            elif token == b"TJ":
                inicio = max((k for k, v in enumerate(operandos) if v == b"["), default=-1)
                for item in operandos[inicio + 1:]:
                    if isinstance(item, bytes):
                        saida.append(fonte.decodificar(item))
                    elif isinstance(item, float) and item < ARRAY_ESPACO:
                        saida.append(" ")
            elif token in (b"Td", b"TD") and len(operandos) >= 2 and operandos[-1]:
                saida.append("\n")
            elif token in (b"T*", b"Tm", b"ET"):
                saida.append("\n")
            operandos = []
        if len(operandos) > 500:
            operandos = operandos[-50:]
    return "".join(saida)


def _extrair(dados: bytes) -> List[str]:
    if re.search(rb"/Encrypt\b", dados[-4096:] + dados[:4096]):
        raise PdfSemTexto("O PDF está protegido por senha. Salve uma cópia sem proteção e anexe de novo.")
    limite = time.monotonic() + MAX_SEGUNDOS
    documento = _Documento(dados)
    paginas: List[str] = []
    total = 0
    for numero in documento.paginas():
        if time.monotonic() > limite:
            raise PdfSemTexto("O PDF demorou demais para ser lido. Tente um arquivo menor.")
        dic = documento.dic(numero)
        valor = _valor(dic, b"Contents") or b""
        fontes = documento.fontes(documento.recursos(numero))
        texto = "\n".join(_texto_do_conteudo(documento.fluxo(ref), fontes) for ref in _refs(valor))
        texto = re.sub(r"[ \t]+\n", "\n", re.sub(r"\n{3,}", "\n\n", texto)).strip()
        if texto:
            paginas.append(texto)
            total += len(texto)
        if total > MAX_TEXTO:
            break
    return paginas


def extrair_texto_pdf(dados: bytes) -> List[str]:
    """Text of each page that has any. Raises PdfSemTexto (safe message) when the file cannot be read."""
    try:
        return _extrair(dados)
    except PdfSemTexto:
        raise
    except Exception:
        logger.warning("Falha ao ler o PDF anexado.", exc_info=False)
        raise PdfSemTexto("Não consegui ler este PDF. Ele pode estar danificado ou usar um formato não suportado.") from None
