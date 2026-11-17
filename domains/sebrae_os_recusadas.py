"""OS que o usuário recusou (ou decidiu manter) para um chamado do F5, guardadas só no computador.

Uma OS recusada para um chamado nunca mais é sugerida nem trocada sozinha para ele (``sebrae_os_nova``).
O registro vive em ``data/state/sebrae_os_recusadas.json`` (``{"version": 1, "recusadas": {numero: [os, ...]}}``),
não leva nome, texto nem dado pessoal e nunca vai ao SoftExpert, ao Dashboard ou ao SharePoint.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from core.errors import DomainBusyError, DomainValidationError
from core.integrity import FileBusyError, atomic_write_json, lock_paths
from domains.sebrae_observacoes import numero_observacao_valido, validar_numero_observacao
from domains.sebrae_vinculos import _os_chave

logger = logging.getLogger(__name__)
MAX_OS = 32
_PADRAO_OS = re.compile(rf"^[A-Z0-9-]{{1,{MAX_OS}}}$")


def caminho_recusadas(state_dir: Path) -> Path:
    """Caminho do arquivo JSON das OS recusadas dentro do diretório de estado."""
    return Path(state_dir) / "sebrae_os_recusadas.json"


def validar_os(os_: Any) -> str:
    """OS na mesma chave do cruzamento (``_os_chave``: sem espaços, maiúsculas); letras, números e hífen, até 32 caracteres."""
    valor = _os_chave(os_)
    if not _PADRAO_OS.match(valor):
        raise DomainValidationError(f"Informe a OS só com letras, números e hífen, até {MAX_OS} caracteres.", status_code=422)
    return valor


def _carregar(state_dir: Path) -> Dict[str, Any]:
    """Conteúdo bruto de ``recusadas`` com a estrutura conferida; nunca altera o disco."""
    arquivo = caminho_recusadas(state_dir)
    try:
        dados = json.loads(arquivo.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError, FileBusyError) as error:
        raise DomainBusyError(
            "O registro de OS recusadas está ilegível e foi preservado. Restaure uma cópia válida antes de continuar."
        ) from error
    recusadas = dados.get("recusadas") if isinstance(dados, dict) else None
    if not isinstance(dados, dict) or dados.get("version") != 1 or not isinstance(recusadas, dict) or any(
        not isinstance(lista, list) or any(not isinstance(os_, str) for os_ in lista) for lista in recusadas.values()
    ):
        raise DomainBusyError(
            "O registro de OS recusadas tem estrutura inválida e foi preservado. Restaure uma cópia válida antes de continuar."
        )
    return recusadas


def ler(state_dir: Path) -> Dict[str, List[str]]:
    """``{numero do chamado: [OS recusadas]}``; chave fora de ``UTIC-AAAA-N``/``linha:N`` (JSON editado à mão) fica de fora."""
    return {
        numero: [os_ for os_ in lista if os_.strip()]
        for numero, lista in _carregar(state_dir).items() if numero_observacao_valido(numero)
    }


def ler_ou_none(state_dir: Path) -> Optional[Dict[str, List[str]]]:
    """``ler`` estrito para quem GRAVA (marcas e congelamento de OS): registro ilegível devolve ``None``.

    Quem recebe ``None`` não aplica troca por chave forte (``vinculos_derivados(chave_forte=False)``), porque sem as recusas
    uma OS já recusada poderia voltar a valer. O log leva só o tipo do erro, nunca número de chamado nem OS."""
    try:
        return ler(state_dir)
    except DomainBusyError as erro:
        logger.warning("Registro de OS recusadas indisponível (%s).", type(erro).__name__)
        return None


def ler_ou_vazio(state_dir: Path) -> Dict[str, List[str]]:
    """``ler`` para quem só lê (telas e vínculos derivados): registro ilegível vale como "nenhuma recusa", sem derrubar a tela."""
    return ler_ou_none(state_dir) or {}


def recusar(state_dir: Path, numero: str, os_: Any) -> Dict[str, str]:
    """Grava, sob trava, que a OS não vale para o chamado; repetir a mesma recusa não duplica. Devolve ``{numero, os}``."""
    chave, ordem = validar_numero_observacao(numero), validar_os(os_)
    arquivo = caminho_recusadas(state_dir)
    try:
        with lock_paths([arquivo]):
            recusadas = _carregar(state_dir)
            lista = recusadas.get(chave) or []
            if ordem not in {_os_chave(o) for o in lista}:
                recusadas[chave] = [*lista, ordem]
                arquivo.parent.mkdir(parents=True, exist_ok=True)
                atomic_write_json(arquivo, {"version": 1, "recusadas": recusadas})
    except FileBusyError as error:
        raise DomainBusyError("O registro de OS recusadas está ocupado no momento. Tente novamente em instantes.") from error
    return {"numero": chave, "os": ordem}
