"""Registro isolado de observações internas dos chamados SEBRAE.

As anotações registradas aqui não afetam nem são enviadas ao SoftExpert,
tampouco são gravadas na planilha ou no SharePoint do Dashboard Operacional.
Ficam salvas atomicamente em ``data/state/sebrae_observacoes.json``.
O destaque manual do chamado (``destaque``/``destaque_em``) vive no mesmo registro e é igualmente só local.
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


def numero_observacao_valido(chave: Any) -> bool:
    """True só para a chave exata ``UTIC-AAAA-N`` ou ``linha:N`` (a que ``validar_numero_observacao`` grava)."""
    return isinstance(chave, str) and _PADRAO_NUMERO_OBSERVACAO.match(chave) is not None


def _carregar(state_dir: Path) -> Dict[str, Any]:
    """Conteúdo bruto do arquivo (chaves inclusive), só com a estrutura conferida; nunca altera o disco."""
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
    return dados


def _normalizar(item: Dict[str, Any]) -> Dict[str, Any]:
    destacado = item.get("destaque") is True
    return {
        "observacao": str(item.get("observacao") or ""),
        "atualizado_em": str(item.get("atualizado_em") or ""),
        "destaque": destacado,
        "destaque_em": str(item.get("destaque_em") or "") if destacado else "",
    }


def ler_observacoes(state_dir: Path) -> Dict[str, Dict[str, Any]]:
    """Lê as observações salvas em disco.

    Cada chamado traz ``observacao``, ``atualizado_em``, ``destaque`` (bool) e ``destaque_em`` (ISO local ou "").
    Arquivos antigos sem os campos de destaque valem como não destacados. Chave fora de ``UTIC-AAAA-N``/``linha:N``
    (JSON editado à mão) fica de fora do resultado, mas continua intacta no arquivo."""
    return {numero: _normalizar(item) for numero, item in _carregar(state_dir).items() if numero_observacao_valido(numero)}


def _gravar(state_dir: Path, chave: str, alterar) -> Dict[str, Any]:
    """Aplica ``alterar(entrada)`` sob lock e grava; a entrada some só sem texto e sem destaque.

    Entradas com chave inválida são devolvidas ao arquivo como estavam."""
    arquivo = caminho_observacoes(state_dir)
    try:
        with lock_paths([arquivo]):
            bruto = _carregar(state_dir)
            dados = {numero: (_normalizar(item) if numero_observacao_valido(numero) else item) for numero, item in bruto.items()}
            entrada = dados.get(chave) or {"observacao": "", "atualizado_em": "", "destaque": False, "destaque_em": ""}
            alterar(entrada)
            if entrada["observacao"] or entrada["destaque"]:
                dados[chave] = entrada
            else:
                dados.pop(chave, None)
            arquivo.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_json(arquivo, dados)
    except FileBusyError as error:
        raise DomainBusyError(
            "O registro de observações está ocupado no momento. Tente novamente em instantes."
        ) from error
    return entrada


def salvar_observacao(state_dir: Path, numero: str, texto: Any) -> Dict[str, Any]:
    """Salva atomicamente uma observação sob lock, preservando o destaque.

    Texto vazio limpa a observação; a entrada só é removida se também não houver destaque."""
    chave = validar_numero_observacao(numero)
    observacao_limpa = validar_observacao(texto)
    agora = agora_iso()

    def alterar(entrada: Dict[str, Any]) -> None:
        entrada["observacao"] = observacao_limpa
        entrada["atualizado_em"] = agora if observacao_limpa else ""

    entrada = _gravar(state_dir, chave, alterar)
    return {
        "numero": chave, "observacao": observacao_limpa, "atualizado_em": agora,
        "destaque": entrada["destaque"], "destaque_em": entrada["destaque_em"],
    }


def definir_destaque(state_dir: Path, numero: str, destaque: bool) -> Dict[str, Any]:
    """Marca ou desmarca o destaque do chamado (só local), preservando o texto da observação.

    Marcar de novo um chamado já destacado mantém a data original. Desmarcar sem texto remove a entrada."""
    chave = validar_numero_observacao(numero)
    agora = agora_iso()

    def alterar(entrada: Dict[str, Any]) -> None:
        if destaque:
            entrada["destaque_em"] = entrada["destaque_em"] or agora
        else:
            entrada["destaque_em"] = ""
        entrada["destaque"] = bool(destaque)

    entrada = _gravar(state_dir, chave, alterar)
    return {"numero": chave, "destaque": entrada["destaque"], "destaque_em": entrada["destaque_em"]}
