"""History of the Dashboard Sebrae imports and of the new-ticket searches (docs/operacao/sincronizar-chamados-sebrae.md,
"Histórico de importações do Dashboard Sebrae").

Everything about where and how the history is stored lives here, so moving it to a shared folder later touches
one module. Only ticket numbers, the two valid statuses (column D), the closing date (column R), counts and the
file name are kept; no ticket text, CPF or password ever enters the file.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional
from uuid import uuid4

from core.integrity import atomic_write_json, lock_paths
from domains.sebrae_chamados import mascarar_cpfs

MAX_ENTRADAS = 200  # about 2 months of daily imports at a few KB each; older entries drop out by themselves
MAX_NUMEROS = 500
MAX_ARQUIVO = 200
TIPO_IMPORTACAO = "importacao"
TIPO_BUSCA = "busca"
_LISTAS = ("adicionados", "removidos", "alterados", "lidos", "pendentes", "erros")
_MAPA_VAZIO: Mapping[str, Any] = {}


class HistoricoIlegivel(ValueError):
    """The history file exists but cannot be trusted; it is never overwritten."""


def agora_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _ler(caminho: Path) -> Dict[str, Any]:
    if not caminho.exists():
        return {"versao": 1, "mapa": None, "itens": []}
    try:
        dados = json.loads(caminho.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as erro:
        raise HistoricoIlegivel("O histórico do Dashboard Sebrae está ilegível; os dados foram preservados.") from erro
    if not isinstance(dados, dict) or not isinstance(dados.get("itens"), list) or any(
        not isinstance(item, dict) for item in dados["itens"]
    ):
        raise HistoricoIlegivel("O histórico do Dashboard Sebrae está ilegível; os dados foram preservados.")
    if not isinstance(dados.get("mapa"), dict):
        dados["mapa"] = None
    return dados


def _gravar(caminho: Path, dados: Dict[str, Any]) -> None:
    dados["itens"] = dados["itens"][-MAX_ENTRADAS:]
    atomic_write_json(caminho, dados)


def _cortar(numeros: Iterable[str]) -> List[str]:
    return sorted(numeros)[:MAX_NUMEROS]


def _nova_entrada(dados: Dict[str, Any], tipo: str, em: str, **campos: Any) -> Dict[str, Any]:
    seq = int(dados["itens"][-1].get("seq") or 0) + 1 if dados["itens"] else 1
    return {"id": uuid4().hex, "seq": seq, "tipo": tipo, "em": em or agora_iso(), **campos}


def _ultima_importacao(dados: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    return next((i for i in reversed(dados["itens"]) if i.get("tipo") == TIPO_IMPORTACAO), None)


def _nome_do_arquivo(arquivo: str) -> str:
    return mascarar_cpfs(re.split(r"[/\\]", str(arquivo or ""))[-1])[:MAX_ARQUIVO]


def registrar_importacao(
    caminho: Path,
    *,
    arquivo: str,
    sha256: str,
    mapa: Mapping[str, Mapping[str, str]],
    base_numeros: Optional[Iterable[str]] = None,
    em: str = "",
) -> Dict[str, Any]:
    """Compares ``mapa`` (number -> status and closing date) with the previous import.

    ``base_numeros`` is the fallback base when the history has no previous map (first import after the
    history was introduced). Nothing changed: no new entry, only ``repeticoes`` of the last import grows.
    Returns ``{"entrada", "reimportado"}``.
    """
    novo = {str(n): {"status": str(v.get("status") or ""), "encerramento": str(v.get("encerramento") or "")}
            for n, v in mapa.items()}
    with lock_paths([caminho]):
        dados = _ler(caminho)
        anterior = dados["mapa"]
        base = set(anterior) if anterior is not None else (None if base_numeros is None else set(base_numeros))
        adicionados = sorted(set(novo) - base) if base is not None else []
        removidos = sorted(base - set(novo)) if base is not None else []
        alterados = [
            {"numero": n, "de": anterior[n].get("status", ""), "para": novo[n]["status"],
             "encerramento": novo[n]["encerramento"]}
            for n in sorted(set(novo) & set(anterior or _MAPA_VAZIO))
            if anterior[n].get("status", "") != novo[n]["status"]
        ]
        dados["mapa"] = novo
        ultima = _ultima_importacao(dados)
        if base is not None and ultima is not None and not (adicionados or removidos or alterados):
            ultima["repeticoes"] = int(ultima.get("repeticoes") or 0) + 1
            ultima["ultima_repeticao_em"] = em or agora_iso()
            _gravar(caminho, dados)
            return {"entrada": dict(ultima), "reimportado": True}
        entrada = _nova_entrada(
            dados, TIPO_IMPORTACAO, em,
            arquivo=_nome_do_arquivo(arquivo), sha256=str(sha256), total=len(novo), inicial=base is None,
            adicionados=_cortar(adicionados), removidos=_cortar(removidos), alterados=alterados[:MAX_NUMEROS],
            n_adicionados=len(adicionados), n_removidos=len(removidos), n_alterados=len(alterados),
            truncado=max(len(adicionados), len(removidos), len(alterados)) > MAX_NUMEROS,
            repeticoes=0, ultima_repeticao_em="",
        )
        dados["itens"].append(entrada)
        _gravar(caminho, dados)
        return {"entrada": dict(entrada), "reimportado": False}


def registrar_busca(
    caminho: Path,
    *,
    lidos: Iterable[str],
    ignorados: int,
    pendentes: Iterable[str],
    erros: Iterable[str],
    em: str = "",
) -> Dict[str, Any]:
    lidos, pendentes, erros = list(lidos), list(pendentes), list(erros)
    with lock_paths([caminho]):
        dados = _ler(caminho)
        ultima = _ultima_importacao(dados)
        entrada = _nova_entrada(
            dados, TIPO_BUSCA, em,
            importacao_id=ultima["id"] if ultima else "", ignorados=int(ignorados),
            lidos=_cortar(lidos), pendentes=_cortar(pendentes), erros=_cortar(erros),
            n_lidos=len(lidos), n_pendentes=len(pendentes), n_erros=len(erros),
        )
        dados["itens"].append(entrada)
        _gravar(caminho, dados)
        return dict(entrada)


def listar(caminho: Path, limite: int = 50, pagina: int = 1, tipo: str = "") -> Dict[str, Any]:
    """Newest first; items carry counts only (the lists come from ``obter``)."""
    itens = _ler(caminho)["itens"]
    filtrados = [i for i in reversed(itens) if not tipo or i.get("tipo") == tipo]
    inicio = (max(pagina, 1) - 1) * limite
    leves = [{k: v for k, v in i.items() if k not in _LISTAS} for i in filtrados[inicio:inicio + limite]]
    return {
        "total": len(filtrados), "pagina": max(pagina, 1), "itens": leves,
        "importacoes": sum(1 for i in itens if i.get("tipo") == TIPO_IMPORTACAO),
        "buscas": sum(1 for i in itens if i.get("tipo") == TIPO_BUSCA),
    }


def obter(caminho: Path, entrada_id: str) -> Optional[Dict[str, Any]]:
    return next((dict(i) for i in _ler(caminho)["itens"] if i.get("id") == entrada_id), None)
