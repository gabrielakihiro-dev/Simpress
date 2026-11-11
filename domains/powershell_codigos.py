"""Lista editável de códigos prontos do PowerShell da Home, só local, em ``data/state/powershell_codigos.json``.

O arquivo guarda ``{"codigos": [{id, titulo, modo, comando}]}``. Arquivo ausente devolve o padrão (``SEED``) sem gravar;
lista vazia gravada pelo usuário continua vazia. A rota só insere o comando no terminal; nunca envia Enter.
"""

from __future__ import annotations

import json
import re
import unicodedata
import uuid
from pathlib import Path
from typing import Any, Dict, List

from core.errors import DomainBusyError, DomainValidationError
from core.integrity import FileBusyError, atomic_write_json, lock_paths
from domains.endpoint_lookup import validar_comando

MAX_CODIGOS = 200
MAX_TITULO = 80
MAX_ID = 64
_MODOS = ("usuario", "sistema")
_ID_VALIDO = re.compile(r"[A-Za-z0-9_.-]+")

# Fila de impressão (servidor prsrvvm-imp) e a localidade mostrada como título.
_FILAS = (
    ("VP_BARRACAO", "Barracão"),
    ("VP_BOA_VISTA", "Boa Vista"),
    ("VP_CAMPOMOURAO_", "Campo Mourão"),
    ("VP_CASCAVEL", "Cascavel"),
    ("VP_CIANORTE", "Cianorte"),
    ("VP_CIC", "CIC"),
    ("VP_COLOMBO", "Colombo"),
    ("VP_CORNELIO_PROCOPIO", "Cornélio Procópio"),
    ("VP_CURITIBA_", "Curitiba"),
    ("VP_CURITIBA_MAC", "Curitiba (Mac)"),
    ("VP_EPSON", "Epson"),
    ("VP_FOZDOIGUAÇU", "Foz do Iguaçu"),
    ("VP_FRANCISCOBELTRAO", "Francisco Beltrão"),
    ("VP_GUARAPUAVA", "Guarapuava"),
    ("VP_IRATI_", "Irati"),
    ("VP_IVAIPORA_", "Ivaiporã"),
    ("VP_JACAREZINHO", "Jacarezinho"),
    ("VP_LARANJEIRAS", "Laranjeiras"),
    ("VP_LONDRINA_", "Londrina"),
    ("VP_MARINGA_", "Maringá"),
    ("VP_PARANAGUA", "Paranaguá"),
    ("VP_PARANAVAI", "Paranavaí"),
    ("VP_PATOBRANCO", "Pato Branco"),
    ("VP_PONTAGROSSA", "Ponta Grossa"),
    ("VP_PORECATU", "Porecatu"),
    ("VP_RIONEGRO_", "Rio Negro"),
    ("VP_SANTAFELICIDADE_", "Santa Felicidade"),
    ("VP_SAOJOSEDOSPINHAIS", "São José dos Pinhais"),
    ("VP_TELEMACOBORBA", "Telêmaco Borba"),
    ("VP_TOLEDO", "Toledo"),
    ("VP_UMUARAMA", "Umuarama"),
)


def _id_seed(fila: str) -> str:
    # Id só ASCII (a fila "VP_FOZDOIGUAÇU" vira "vp_fozdoiguacu"); estável entre execuções.
    return unicodedata.normalize("NFKD", fila).encode("ascii", "ignore").decode("ascii").lower()


SEED: tuple[Dict[str, str], ...] = tuple(
    {"id": _id_seed(fila), "titulo": titulo, "modo": "usuario", "comando": f'Add-Printer -ConnectionName "\\\\prsrvvm-imp\\{fila}"'}
    for fila, titulo in _FILAS
)


def _erro(mensagem: str) -> DomainValidationError:
    return DomainValidationError(mensagem, status_code=422)


def _validar_titulo(valor: Any) -> str:
    if not isinstance(valor, str):
        raise _erro("Informe o título do código.")
    titulo = valor.strip()
    if not 1 <= len(titulo) <= MAX_TITULO:
        raise _erro(f"O título deve ter de 1 a {MAX_TITULO} caracteres.")
    if any(unicodedata.category(c) in ("Cc", "Cf", "Zl", "Zp") for c in titulo):
        raise _erro("O título não pode ter quebra de linha nem caracteres de controle.")
    return titulo


def _validar_item(bruto: Any) -> Dict[str, str]:
    if not isinstance(bruto, dict):
        raise _erro("Cada código precisa de id, título, modo e comando.")
    modo = bruto.get("modo")
    if modo not in _MODOS:
        raise _erro('O modo deve ser "usuario" ou "sistema".')
    comando = bruto.get("comando")
    if not isinstance(comando, str):
        raise _erro("Informe o comando.")
    try:
        comando = validar_comando(comando)
    except ValueError as error:
        raise _erro(str(error)) from None
    ident = bruto.get("id")
    if ident is None or ident == "":
        ident = uuid.uuid4().hex[:12]
    elif not isinstance(ident, str) or len(ident) > MAX_ID or not _ID_VALIDO.fullmatch(ident):
        raise _erro(f"O id deve ter até {MAX_ID} caracteres entre letras, números, ponto, hífen e sublinhado.")
    return {"id": ident, "titulo": _validar_titulo(bruto.get("titulo")), "modo": str(modo), "comando": comando}


def _validar_lista(itens: Any) -> List[Dict[str, str]]:
    if not isinstance(itens, list):
        raise _erro("A lista de códigos é inválida.")
    if len(itens) > MAX_CODIGOS:
        raise _erro(f"A lista aceita no máximo {MAX_CODIGOS} códigos.")
    validos = [_validar_item(item) for item in itens]
    if len({item["id"] for item in validos}) != len(validos):
        raise _erro("Há códigos com o mesmo id.")
    return validos


def _carregar(arquivo: Path) -> List[Dict[str, str]]:
    try:
        dados = json.loads(arquivo.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return [dict(item) for item in SEED]
    except (OSError, ValueError, FileBusyError) as error:
        raise DomainBusyError(
            "O registro de códigos do PowerShell está ilegível e foi preservado. Restaure uma cópia válida antes de alterar a lista."
        ) from error
    try:
        if not isinstance(dados, dict) or "codigos" not in dados:
            raise _erro("estrutura")
        return _validar_lista(dados["codigos"])
    except DomainValidationError as error:
        raise DomainBusyError(
            "O registro de códigos do PowerShell tem estrutura inválida e foi preservado. Restaure uma cópia válida antes de alterar a lista."
        ) from error


def ler_codigos(arquivo: Path) -> List[Dict[str, str]]:
    return _carregar(arquivo)


def salvar_codigos(arquivo: Path, itens: Any) -> List[Dict[str, str]]:
    """Substitui a lista inteira, sob lock; arquivo existente ilegível não é sobrescrito."""
    validos = _validar_lista(itens)
    try:
        with lock_paths([arquivo]):
            _carregar(arquivo)
            arquivo.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_json(arquivo, {"codigos": validos})
    except FileBusyError as error:
        raise DomainBusyError("O registro de códigos do PowerShell está ocupado no momento. Tente novamente em instantes.") from error
    return validos
