"""Data feeding the Dashboard row: equipment records by person name (K, L, N) and the OS of a series (E).

Pure functions over data the app already holds: the equipment search index (EquipamentosDetalhes merged
with the Endpoint/InvAll logged user and the Microsoft Entra name) and the ticket report. Nothing here
reads files or opens a browser; ``domains/sebrae_dashboard.py`` decides what to do with the result.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Mapping, Tuple

from domains.equipment_search import normalize_search_term

# AGENTS.md: hostnames with these prefixes are installed in Curitiba whatever EquipamentosDetalhes says.
PREFIXOS_CURITIBA = ("PRNOTESJP", "PRNOTERL", "PRNOTEARC")
CIDADE_CURITIBA = "Curitiba"


def registros_de_equipamentos(equipamentos: Iterable[Mapping[str, Any]]) -> List[Dict[str, str]]:
    """``cruzar_por_nome`` records: one per equipment that has a person name (Entra/manual)."""
    registros: List[Dict[str, str]] = []
    for item in equipamentos:
        nome = str(item.get("nome_pessoa") or "").strip()
        if not nome:
            continue
        apelido = normalize_search_term(item.get("apelido"))
        cidade = CIDADE_CURITIBA if apelido.startswith(PREFIXOS_CURITIBA) else str(item.get("retirada_cidade") or "").strip()
        registros.append({
            "nome": nome,
            "serie": str(item.get("serial") or "").strip(),
            "modelo": str(item.get("modelo") or "").strip(),
            "cidade": cidade,
        })
    return registros


def _palavras(texto: Any) -> str:
    return " " + " ".join("".join(c if c.isalnum() else " " for c in normalize_search_term(texto)).split()) + " "


def pessoas_citadas(descricao: Any, solicitante: Any, registros: Iterable[Mapping[str, Any]]) -> List[str]:
    """Distinct names from the records, other than the requester, that the ticket description mentions.

    A name that contains, or is part of, the requester's own name is the requester, not another person; a name
    that is part of a longer cited name ("Ana Souza" in "Ana Souza Lima") is the longer one.
    shortcut: only full names that exist in the records are recognised (whole words, no accents/case), upgrade if
    descriptions cite people by first name only.
    """
    texto, dono = _palavras(descricao), _palavras(solicitante)
    if not texto.strip():
        return []
    achados: Dict[str, str] = {}
    for registro in registros:
        nome = _palavras(registro.get("nome"))
        if len(nome.split()) < 2 or nome in dono or dono in nome or nome not in texto:
            continue
        achados.setdefault(nome, str(registro.get("nome") or "").strip())
    return [original for nome, original in achados.items() if not any(nome != outro and nome in outro for outro in achados)]


def nome_do_chamado(descricao: Any, solicitante: Any, registros: Iterable[Mapping[str, Any]]) -> Tuple[str, List[str]]:
    """(name to look the equipment up by, people cited in the description).

    A ticket opened on behalf of one registered person belongs to that person: the name in the description wins
    over the requester. With two or more different people cited nothing is guessed (empty name); with none cited
    the requester is the name.
    """
    citadas = pessoas_citadas(descricao, solicitante, registros)
    if len(citadas) == 1:
        return citadas[0], citadas
    return ("" if citadas else str(solicitante or "")), citadas


def avisos_de_nome(descricao: Any, solicitante: Any, registros: Iterable[Mapping[str, Any]]) -> Dict[str, str]:
    """Screen notes: ``nome_da_descricao`` is the person the equipment was looked up by, ``outra_pessoa`` the first of
    several cited people (nothing was filled)."""
    _, citadas = nome_do_chamado(descricao, solicitante, registros)
    return {"nome_da_descricao": citadas[0] if len(citadas) == 1 else "", "outra_pessoa": citadas[0] if len(citadas) > 1 else ""}


def _chave_serie(serie: Any) -> str:
    return "".join(c for c in normalize_search_term(serie) if c.isalnum())


def _numero_da_os(valor: Any) -> int:
    texto = str(valor or "").strip()
    return int(texto) if texto.isdigit() else -1


def os_da_serie(relatorio: Mapping[str, Any] | None, serie: str) -> str:
    """Latest OS linked to the series in the ticket report; empty when the series has no ticket/OS yet."""
    alvo = _chave_serie(serie)
    chamados = (relatorio or {}).get("chamados")
    if not alvo or not isinstance(chamados, list):
        return ""
    candidatas: List[str] = []
    for chamado in chamados:
        if not isinstance(chamado, dict) or _chave_serie(chamado.get("serie")) != alvo:
            continue
        simpress = chamado.get("simpress")
        ordens = simpress.get("ordens_servico") if isinstance(simpress, dict) else None
        candidatas += [str(os_).strip() for os_ in ordens or [] if str(os_).strip()]
        oracle = chamado.get("oracle")
        candidatas += [
            str(item.get("ordem_servico") or "").strip() for item in (oracle if isinstance(oracle, list) else []) if isinstance(item, dict)
        ]
    candidatas = [os_ for os_ in candidatas if os_]
    # shortcut: non-numeric OS ids rank last, ties keep report order; revisit if OS ids stop being numeric.
    return max(candidatas, key=_numero_da_os) if candidatas else ""
