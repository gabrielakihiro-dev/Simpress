"""Busca da Home por chamado Sebrae (UTIC) e por OS: filtro puro, só devolve número, aba, OS, série, status e UTIC."""

from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List, Mapping, Sequence

ABAS = ("novos", "antigos", "finalizados")
_ANO_PARCIAL = re.compile(r"^\d{4}-\d*$")
_SO_DIGITOS_4 = re.compile(r"^\d{4,}$")


def _chave(texto: Any) -> str:
    return re.sub(r"\s+", "", str(texto or "")).upper()


def termo_de_chamado(termo: str) -> str:
    """Termo normalizado se parece número de chamado (``UTIC...`` ou ``AAAA-N``); senão ``""``."""
    chave = _chave(termo)
    return chave if "UTIC" in chave or _ANO_PARCIAL.match(chave) else ""


def termo_de_os(termo: str) -> str:
    chave = _chave(termo)
    return chave if _SO_DIGITOS_4.match(chave) else ""


def buscar_chamados(fontes: Mapping[str, Iterable[str]], termo: str, limite: int = 5) -> List[Dict[str, str]]:
    """Números que contêm o termo, na ordem novos, antigos, finalizados, sem repetir número."""
    chave = termo_de_chamado(termo)
    achados: Dict[str, str] = {}
    for aba in ABAS if chave else ():
        for numero in fontes.get(aba, ()):
            if chave in _chave(numero):
                achados.setdefault(_chave(numero), aba)
    return [{"numero": numero, "aba": aba} for numero, aba in list(achados.items())[:limite]]


def buscar_os(ordens: Sequence[Mapping[str, Any]], termo: str, limite: int = 5) -> List[Dict[str, Any]]:
    """Ordens (de ``current_orders``) cuja chave contém o termo; só os campos públicos."""
    chave = termo_de_os(termo)
    if not chave:
        return []
    utic = lambda o: (o.get("utic") or {}).get("chamado") or None  # noqa: E731
    return [
        {"fonte": o["fonte"], "os": o["os"], "serie": o["serie"], "status": o["status"], "utic": utic(o)}
        for o in ordens if chave in _chave(o["os"])
    ][:limite]
