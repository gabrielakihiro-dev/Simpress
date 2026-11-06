"""Registro isolado de observações internas dos chamados SEBRAE.

As anotações registradas aqui não afetam nem são enviadas ao SoftExpert,
tampouco são gravadas na planilha ou no SharePoint do Dashboard Operacional.
Ficam salvas atomicamente em ``data/state/sebrae_observacoes.json``.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional
from zoneinfo import ZoneInfo

from core.errors import DomainBusyError, DomainValidationError
from core.integrity import FileBusyError, atomic_write_json, lock_paths
from domains.sebrae_chamados import mascarar_cpfs
from domains.sebrae_dashboard import omitir_credenciais

logger = logging.getLogger(__name__)

FUSO = ZoneInfo("America/Sao_Paulo")
MAX_OBSERVACAO = 4000
_CONTROLES = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_PADRAO_NUMERO_OBSERVACAO = re.compile(r"^(?:UTIC-\d{4}-\d+|linha:\d+)$")


def agora_local() -> datetime:
    return datetime.now(FUSO)


def agora_iso() -> str:
    return agora_local().isoformat(timespec="seconds")


def caminho_observacoes(state_dir: Path) -> Path:
    """Caminho do arquivo JSON de observações dentro do diretório de estado."""
    return Path(state_dir) / "sebrae_observacoes.json"


def validar_numero_observacao(numero: Any) -> str:
    """Valida identificador de chamado para observação.

    Aceita formato UTIC (UTIC-AAAA-NNNN) em maiúsculas (ou normalizado a partir de minúsculas)
    e identificadores de chamados antigos sem UTIC no formato linha:N em minúsculas.
    """
    valor = str(numero or "").strip()
    if valor.upper().startswith("UTIC-"):
        valor = valor.upper()
    if not _PADRAO_NUMERO_OBSERVACAO.match(valor):
        raise DomainValidationError(
            "Informe o número do chamado no formato UTIC-AAAA-NNNN ou linha:N.",
            status_code=422,
        )
    return valor


def validar_observacao(texto: Any) -> str:
    """Valida e sanitiza o texto da observação.

    Remove caracteres de controle, impõe limite de 4000 caracteres,
    aplica mascaramento de CPFs e omissão de credenciais e sanitiza prefixos de fórmula Excel.
    """
    limpo = _CONTROLES.sub("", str(texto or "").replace("\r\n", "\n").replace("\r", "\n")).strip()
    if len(limpo) > MAX_OBSERVACAO:
        raise DomainValidationError(
            f"A observação aceita até {MAX_OBSERVACAO} caracteres.",
            status_code=422,
        )
    if not limpo:
        return ""
    limpo = mascarar_cpfs(omitir_credenciais(limpo))
    if limpo.lstrip().startswith(("=", "+", "-", "@")):
        limpo = "'" + limpo
    return limpo


def ler_observacoes(state_dir: Path) -> Dict[str, Dict[str, str]]:
    """Lê todas as observações salvas em disco."""
    arquivo = caminho_observacoes(state_dir)
    try:
        dados = json.loads(arquivo.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError, FileBusyError) as error:
        raise DomainBusyError(
            "O registro de observações está ilegível e foi preservado. Restaure uma cópia válida antes de alterar os chamados."
        ) from error
    if not isinstance(dados, dict) or any(not isinstance(item, dict) for item in dados.values()):
        raise DomainBusyError(
            "O registro de observações tem estrutura inválida e foi preservado. Restaure uma cópia válida antes de alterar os chamados."
        )
    return {
        str(numero): {
            "observacao": str(item.get("observacao") or ""),
            "atualizado_em": str(item.get("atualizado_em") or ""),
        }
        for numero, item in dados.items()
    }


def salvar_observacao(state_dir: Path, numero: str, texto: Any) -> Dict[str, Any]:
    """Salva atomicamente uma observação sob lock; se o texto for vazio, remove a entrada."""
    chave = validar_numero_observacao(numero)
    observacao_limpa = validar_observacao(texto)
    agora = agora_iso()
    arquivo = caminho_observacoes(state_dir)
    try:
        with lock_paths([arquivo]):
            dados = ler_observacoes(state_dir)
            if observacao_limpa:
                dados[chave] = {"observacao": observacao_limpa, "atualizado_em": agora}
            else:
                dados.pop(chave, None)
            arquivo.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_json(arquivo, dados)
    except FileBusyError as error:
        raise DomainBusyError(
            "O registro de observações está ocupado no momento. Tente novamente em instantes."
        ) from error
    return {"numero": chave, "observacao": observacao_limpa, "atualizado_em": agora}
