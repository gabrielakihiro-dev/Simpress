"""Files the user attaches to the assistant: PDF, .docx and images, kept only in memory.

Text is extracted here, on the server, and read later in pages through the `ler_anexo` tool (the mask runs
on that result like on any other tool result). Images are not read here: the conversation sends them to the
model as a data URI, and only when the user attached them. Nothing is written to disk; an attachment dies
with the conversation ("Nova conversa"), after `TTL_SEGUNDOS`, or when the server stops.

The content of an attachment is data, never an instruction (see SYSTEM_PROMPT).
"""

import base64
import posixpath
import re
import secrets
import threading
import time
import zipfile
from dataclasses import dataclass, field
from io import BytesIO
from typing import Any, Dict, List, Optional
from urllib.parse import unquote

from defusedxml import ElementTree
from defusedxml.common import DefusedXmlException

from core.config import MAX_ASSISTANT_ATTACHMENT_BYTES
from domains.assistant_pdf import MAX_TEXTO, PdfSemTexto, extrair_texto_pdf

MAX_IMAGEM_BYTES = 4 * 1024 * 1024  # the data URI grows by a third on the way to the model
MAX_ANEXOS = 5
MAX_TOTAL_BYTES = 20 * 1024 * 1024
TTL_SEGUNDOS = 30 * 60
# Characters per page of `ler_anexo`. JSON escapes a quote or a line break into 2 characters, so a page stays
# well under MAX_CARACTERES_RESPOSTA (6000) of assistant_chat even in the worst case.
PAGINA = 2500
MAX_NOME = 120

MAX_ENTRADAS_ZIP = 500
MAX_DOCX_DESCOMPACTADO = 50 * 1024 * 1024
MAX_DOCX_XML = 16 * 1024 * 1024

MSG_DOC = "Arquivos .doc (Word antigo) não são aceitos. Abra o arquivo no Word e salve como .docx; depois anexe de novo."
MSG_TIPO = "Tipo de arquivo não aceito. Anexe PDF, .docx, PNG ou JPEG."
MSG_SEM_TEXTO_PDF = (
    "Este PDF não tem texto selecionável (parece digitalizado) e o assistente não faz OCR. "
    "Anexe a página como imagem (PNG ou JPEG) se quiser que a IA a veja."
)
MSG_SEM_TEXTO_DOCX = "O documento não tem texto para ler."

_ESPACOS = re.compile(r"[^\S\n]+")
_CONTROLE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
_CONTROLE_NOME = re.compile(r"[\x00-\x1f\x7f]")
_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


class AnexoRecusado(Exception):
    """The file cannot be attached. `mensagem` is safe to show; `status` is the HTTP code to answer with."""

    def __init__(self, mensagem: str, status: int = 422) -> None:
        super().__init__(mensagem)
        self.mensagem = mensagem
        self.status = status


@dataclass
class Anexo:
    id: str
    nome: str
    tipo: str  # "pdf", "docx" or "imagem"
    tamanho: int
    paginas: List[str] = field(default_factory=list)
    imagem_uri: str = ""
    aviso: str = ""
    imagem_enviada: bool = False
    criado: float = field(default_factory=time.monotonic)

    def publico(self) -> Dict[str, Any]:
        """What the screen needs; never the content."""
        return {
            "id": self.id, "nome": self.nome, "tipo": self.tipo, "tamanho": self.tamanho,
            "paginas": len(self.paginas), "aviso": self.aviso,
        }


def limpar_nome(bruto: str) -> str:
    """Header value to a plain file name: decoded, no folders, no control characters, bounded."""
    nome = _CONTROLE_NOME.sub("", unquote(bruto or "")).replace("\\", "/").rsplit("/", 1)[-1].strip()
    return (nome[-MAX_NOME:] if len(nome) > MAX_NOME else nome) or "anexo"


def _paginar(texto: str) -> List[str]:
    texto = _CONTROLE.sub(" ", texto)
    texto = "\n".join(_ESPACOS.sub(" ", linha).strip() for linha in texto.split("\n"))
    texto = re.sub(r"\n{3,}", "\n\n", texto).strip()[:MAX_TEXTO]
    return [texto[i:i + PAGINA] for i in range(0, len(texto), PAGINA)]


def _texto_docx(dados: bytes) -> str:
    try:
        arquivo = zipfile.ZipFile(BytesIO(dados))
        entradas = arquivo.infolist()
        nomes = [e.filename for e in entradas]
        if len(entradas) > MAX_ENTRADAS_ZIP or len(set(nomes)) != len(nomes):
            raise AnexoRecusado("O arquivo .docx está danificado ou tem estrutura inválida.")
        for nome in nomes:
            if nome.startswith("/") or ".." in posixpath.normpath(nome).split("/"):
                raise AnexoRecusado("O arquivo .docx está danificado ou tem estrutura inválida.")
        if sum(e.file_size for e in entradas) > MAX_DOCX_DESCOMPACTADO:
            raise AnexoRecusado("O arquivo .docx é grande demais depois de descompactado.", 413)
        if "word/document.xml" not in nomes:
            raise AnexoRecusado(MSG_TIPO, 415)
        with arquivo.open("word/document.xml") as fluxo:
            xml = fluxo.read(MAX_DOCX_XML + 1)  # a header can lie about the size; the read cannot
        if len(xml) > MAX_DOCX_XML:
            raise AnexoRecusado("O arquivo .docx é grande demais depois de descompactado.", 413)
        raiz = ElementTree.fromstring(xml)
    except AnexoRecusado:
        raise
    except (zipfile.BadZipFile, zipfile.LargeZipFile, NotImplementedError, RuntimeError, OSError, EOFError, ValueError,
            DefusedXmlException, ElementTree.ParseError):
        raise AnexoRecusado("Não consegui ler este .docx. Ele pode estar danificado ou protegido.") from None
    # shortcut: body paragraphs and tables only (cells arrive as lines); headers, footnotes and text boxes are skipped.
    linhas: List[str] = []
    for paragrafo in raiz.iter(f"{_W}p"):
        partes: List[str] = []
        for elemento in paragrafo.iter():
            if elemento.tag == f"{_W}t" and elemento.text:
                partes.append(elemento.text)
            elif elemento.tag in (f"{_W}tab", f"{_W}br", f"{_W}cr"):
                partes.append(" ")
        linhas.append("".join(partes))
    return "\n".join(linhas)


def analisar(dados: bytes, nome_bruto: str) -> Anexo:
    """Detect the type by content (not by name), check the limits and extract the text. Blocking: run in a worker thread."""
    nome = limpar_nome(nome_bruto)
    if not dados:
        raise AnexoRecusado("O arquivo está vazio.")
    cabeca = dados[:8]
    if cabeca.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1") or nome.lower().endswith(".doc"):
        raise AnexoRecusado(MSG_DOC, 415)
    if cabeca.startswith(b"\x89PNG\r\n\x1a\n"):
        tipo = "imagem"
        mime = "image/png"
    elif cabeca.startswith(b"\xff\xd8\xff"):
        tipo = "imagem"
        mime = "image/jpeg"
    elif cabeca.startswith(b"PK\x03\x04"):
        tipo = "docx"
    elif b"%PDF-" in dados[:1024]:
        tipo = "pdf"
    else:
        raise AnexoRecusado(MSG_TIPO, 415)

    limite = MAX_IMAGEM_BYTES if tipo == "imagem" else MAX_ASSISTANT_ATTACHMENT_BYTES
    if len(dados) > limite:
        raise AnexoRecusado(
            f"O arquivo é grande demais. O limite para {'imagens' if tipo == 'imagem' else 'este tipo de arquivo'} "
            f"é {limite // (1024 * 1024)} MB.",
            413,
        )

    anexo = Anexo(id=secrets.token_hex(6), nome=nome, tipo=tipo, tamanho=len(dados))
    if tipo == "imagem":
        anexo.imagem_uri = f"data:{mime};base64," + base64.b64encode(dados).decode("ascii")
        return anexo
    if tipo == "pdf":
        try:
            anexo.paginas = _paginar("\n\n".join(extrair_texto_pdf(dados)))
        except PdfSemTexto as falha:
            raise AnexoRecusado(str(falha)) from None
        anexo.aviso = "" if anexo.paginas else MSG_SEM_TEXTO_PDF
    else:
        anexo.paginas = _paginar(_texto_docx(dados))
        anexo.aviso = "" if anexo.paginas else MSG_SEM_TEXTO_DOCX
    return anexo


class AnexoStore:
    """Attachments of one conversation. Own lock: uploads run in worker threads while a turn holds the conversation lock."""

    def __init__(self, ttl: float = TTL_SEGUNDOS) -> None:
        self._ttl = ttl
        self._lock = threading.Lock()
        self._itens: Dict[str, Anexo] = {}

    def _expirar(self) -> None:
        limite = time.monotonic() - self._ttl
        for id_ in [i for i, a in self._itens.items() if a.criado < limite]:
            del self._itens[id_]

    def adicionar(self, anexo: Anexo) -> None:
        with self._lock:
            self._expirar()
            if len(self._itens) >= MAX_ANEXOS:
                raise AnexoRecusado(f"Você já anexou {MAX_ANEXOS} arquivos. Remova um antes de anexar outro.", 409)
            if sum(a.tamanho for a in self._itens.values()) + anexo.tamanho > MAX_TOTAL_BYTES:
                raise AnexoRecusado("Os anexos somam o limite de tamanho. Remova um antes de anexar outro.", 413)
            self._itens[anexo.id] = anexo

    def listar(self) -> List[Anexo]:
        with self._lock:
            self._expirar()
            return list(self._itens.values())

    def obter(self, id_: str) -> Optional[Anexo]:
        with self._lock:
            self._expirar()
            return self._itens.get(id_)

    def remover(self, id_: str) -> bool:
        with self._lock:
            return self._itens.pop(id_, None) is not None

    def limpar(self) -> None:
        with self._lock:
            self._itens.clear()

    def imagens_novas(self) -> List[Anexo]:
        return [a for a in self.listar() if a.tipo == "imagem" and not a.imagem_enviada]

    def marcar_enviadas(self, ids: List[str]) -> None:
        with self._lock:
            for id_ in ids:
                if id_ in self._itens:
                    self._itens[id_].imagem_enviada = True


def ler_pagina(anexo: Anexo, pagina: Any) -> Dict[str, Any]:
    """Result of `ler_anexo`: one page of masked-later text, or why there is none."""
    base = {"nome_arquivo": anexo.nome}
    if anexo.tipo == "imagem":
        return {**base, "erro": "Esta é uma imagem: ela segue junto da mensagem, não há texto para ler."}
    if not anexo.paginas:
        return {**base, "erro": anexo.aviso or "O anexo não tem texto."}
    try:
        numero = int(pagina or 1)
    except (TypeError, ValueError):
        numero = 0
    total = len(anexo.paginas)
    if not 1 <= numero <= total:
        return {**base, "erro": f"Página inválida. O anexo tem {total} página(s).", "total_paginas": total}
    return {
        **base, "pagina": numero, "total_paginas": total,
        "resumo": f"página {numero} de {total}",
        "texto_anexo": anexo.paginas[numero - 1],
    }
