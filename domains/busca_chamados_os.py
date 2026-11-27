"""Busca da Home por chamado Sebrae e por OS: filtro puro; cada item diz só por qual ``campo`` achou, nunca o trecho.

Texto: título e solicitante dos chamados como o filtro do F5 (`entradaVisao`, estado.ts); a descrição dos chamados o F5 não procura, a busca global sim;
OS como o filtro da F6 (`tabela-os.ts`).
Observação, senha e encerrados nunca entram aqui (invariante de ``domains/AGENTS.md``).
"""

from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from domains.equipment_search import normalize_search_term as _norma
from domains.sebrae_chamados import mascarar_cpfs
from domains.sebrae_dashboard import omitir_credenciais

ABAS = ("novos", "antigos", "finalizados")
_ANO_PARCIAL = re.compile(r"^\d{4}-\d*$")
_SO_DIGITOS_4 = re.compile(r"^\d{4,}$")
_MIN_TEXTO = 3
# (aba, [(numero, {campo: texto})]) por aba: o que o F5 procura de cada chamado.
FontesChamados = Mapping[str, Iterable[Tuple[str, Mapping[str, str]]]]


def _chave(texto: Any) -> str:
    return re.sub(r"\s+", "", str(texto or "")).upper()


def _texto_seguro(texto: Any) -> str:
    return _norma(mascarar_cpfs(omitir_credenciais(texto)))


def _palavras_iniciam(norma: str, texto: str) -> bool:
    """Como a F6: cada palavra do termo começa uma palavra do texto ("ana" não acha "Mariana")."""
    return bool(texto) and all(re.search(r"(^|[^A-Z0-9])" + re.escape(p), texto) for p in norma.split())


def termo_de_chamado(termo: str) -> str:
    """Termo normalizado se parece número de chamado (``UTIC...`` ou ``AAAA-N``); senão ``""``."""
    chave = _chave(termo)
    return chave if "UTIC" in chave or _ANO_PARCIAL.match(chave) else ""


def termo_de_os(termo: str) -> str:
    chave = _chave(termo)
    return chave if _SO_DIGITOS_4.match(chave) else ""


def descricoes_oracle(linhas: Iterable[Mapping[str, Any]]) -> Dict[Tuple[str, str], str]:
    """``{("oracle", OS sem espaços): descrição crua}`` das linhas do relatório (o que a F6 chama de ``descricaoBusca``)."""
    achadas: Dict[Tuple[str, str], str] = {}
    for linha in linhas:
        for item in linha.get("oracle") or []:
            if isinstance(item, dict) and item.get("descricao"):
                chave = ("oracle", _chave(item.get("ordem_servico")))
                achadas[chave] = f"{achadas.get(chave, '')} {item['descricao']}".strip()
    return achadas


def _campo_os(ordem: Mapping[str, Any], norma: str, numero: str, chamado: str, series_equipamento: frozenset,
              descricoes: Mapping[Tuple[str, str], str]) -> Optional[str]:
    serie = _norma(ordem["serie"])
    if numero and numero in _chave(ordem["os"]):
        return "os"
    if norma and norma in serie:
        return "serie"
    if serie in series_equipamento:
        return "equipamento"
    if chamado and chamado in _chave((ordem.get("utic") or {}).get("chamado")):
        return "chamado_vinculado"
    if len(norma) >= _MIN_TEXTO:
        descricao = _texto_seguro(descricoes.get((ordem["fonte"], _chave(ordem["os"]))))
        if _palavras_iniciam(norma, descricao):
            return "descricao"
    return None


_PRIORIDADE_OS = ("os", "serie", "equipamento", "chamado_vinculado", "descricao")


def buscar_os(
    ordens: Sequence[Mapping[str, Any]], termo: str, limite: Optional[int] = 5,
    series_equipamento: Iterable[str] = (), descricoes: Optional[Mapping[Tuple[str, str], str]] = None,
) -> List[Dict[str, Any]]:
    """Ordens (de ``current_orders``) achadas pelo termo, por prioridade de ``campo`` e depois na ordem da importação."""
    series = frozenset(_norma(s) for s in series_equipamento if _norma(s))
    norma, numero, chamado = _norma(termo), termo_de_os(termo), termo_de_chamado(termo)
    achadas = []
    for o in ordens:
        campo = _campo_os(o, norma, numero, chamado, series, descricoes or {})
        if campo:
            achadas.append({"fonte": o["fonte"], "os": o["os"], "serie": o["serie"], "status": o["status"],
                            "utic": (o.get("utic") or {}).get("chamado") or None, "campo": campo})
    achadas.sort(key=lambda a: _PRIORIDADE_OS.index(a["campo"]))
    return achadas[:limite]


def buscar_chamados(
    fontes: FontesChamados, termo: str, limite: Optional[int] = 5, os_achadas: Sequence[Mapping[str, Any]] = (),
) -> List[Dict[str, str]]:
    """Chamados achados (novos, antigos, finalizados), sem repetir número; fica o ``campo`` de maior prioridade."""
    numero_do_termo = termo_de_chamado(termo)
    norma = _norma(termo)
    vinculados = {_chave(o["utic"]) for o in os_achadas if o.get("utic")}
    melhores: Dict[str, Tuple[int, str, str, str]] = {}
    for aba in ABAS:
        for numero, textos in fontes.get(aba, ()):
            chave = _chave(numero)
            if numero_do_termo and numero_do_termo in chave:
                achado: Optional[Tuple[int, str]] = (0, "numero")
            elif chave in vinculados:
                achado = (1, "os_vinculada")
            elif len(norma) >= _MIN_TEXTO:
                # título e solicitante como o filtro do F5; a descrição (o F5 não procura) por início de palavra, por último
                achado = next(((2, c) for c in ("titulo", "solicitante") if norma in _texto_seguro(textos.get(c))), None)
                if not achado and _palavras_iniciam(norma, _texto_seguro(textos.get("descricao"))):
                    achado = (2, "descricao")
            else:
                achado = None
            if achado and (chave not in melhores or achado[0] < melhores[chave][0]):
                melhores[chave] = (achado[0], chave, aba, achado[1])
    ordenados = sorted(melhores.values(), key=lambda m: m[0])  # estável: mantém a ordem das abas
    return [{"numero": chave, "aba": aba, "campo": campo} for _, chave, aba, campo in ordenados[:limite]]
