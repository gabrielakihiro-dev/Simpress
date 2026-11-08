"""Observação do andamento por OS da aba OS (F6), só local, em ``data/state/os_observacoes.json``.

Mesma validação da observação dos chamados (F5); não entra na busca, nos filtros nem na exportação.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List

from core.errors import DomainBusyError, DomainValidationError
from core.integrity import FileBusyError, atomic_write_json, lock_paths
from domains.inventory_comparison import normalize_reference_value
from domains.sebrae_observacoes import agora_iso, validar_observacao


def chave_os(serie: Any, ordem_servico: Any) -> str:
    """Mesma chave do front: ``JSON.stringify([serialKey(serie), orderKey(os)])``."""
    serie_key = normalize_reference_value(serie)
    ordem_key = re.sub(r"\s+", "", str(ordem_servico or "")).upper()
    if not serie_key or not ordem_key:
        raise DomainValidationError("Informe a série e o número da OS.", status_code=422)
    return json.dumps([serie_key, ordem_key], ensure_ascii=False, separators=(",", ":"))


def _carregar(arquivo: Path) -> Dict[str, Any]:
    try:
        dados = json.loads(arquivo.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError, FileBusyError) as error:
        raise DomainBusyError(
            "O registro de observações está ilegível e foi preservado. Restaure uma cópia válida antes de alterar os chamados."
        ) from error
    if not isinstance(dados, dict) or any(
        not isinstance(item, dict) or not isinstance(item.get("observacao"), str) for item in dados.values()
    ):
        raise DomainBusyError(
            "O registro de observações tem estrutura inválida e foi preservado. Restaure uma cópia válida antes de alterar os chamados."
        )
    return dados


def ler_observacoes(arquivo: Path) -> List[Dict[str, str]]:
    return [
        {
            "serie": str(item.get("serie") or ""),
            "os": str(item.get("os") or ""),
            "observacao": item["observacao"],
            "atualizado_em": str(item.get("atualizado_em") or ""),
        }
        for item in _carregar(arquivo).values()
    ]


def salvar_observacao(arquivo: Path, serie: str, ordem_servico: str, texto: Any) -> Dict[str, str]:
    """Grava sob lock; texto vazio remove a entrada."""
    chave = chave_os(serie, ordem_servico)
    observacao = validar_observacao(texto)
    entrada = {"serie": serie, "os": ordem_servico, "observacao": observacao, "atualizado_em": agora_iso() if observacao else ""}
    try:
        with lock_paths([arquivo]):
            dados = _carregar(arquivo)
            if observacao:
                dados[chave] = entrada
            else:
                dados.pop(chave, None)
            arquivo.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_json(arquivo, dados)
    except FileBusyError as error:
        raise DomainBusyError("O registro de observações está ocupado no momento. Tente novamente em instantes.") from error
    return entrada
