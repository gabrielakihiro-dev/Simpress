"""Link between the Dashboard's ticket (column C) and the OS column of the ticket table (``os_chamados_vinculos.json``).

Pure functions. ``vinculos_derivados`` reads the Dashboard (C = UTIC, K = serial, E = OS) and the ticket report and
proposes links in the store's format; ``os_do_chamado`` goes the other way, giving the OS a manual link sets on a UTIC.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Mapping, Sequence, Set, Tuple

from domains.sebrae_chamados import NUMERO_UTIC
from domains.sebrae_cruzamento import _chave_serie, _numero_da_os


def _os_chave(valor: Any) -> str:
    return re.sub(r"\s+", "", str(valor or "")).upper()


def _ordens_da_serie(chamados: Sequence[Any], alvo: str) -> Dict[str, Dict[str, Tuple[str, str]]]:
    """``{os key: {fonte: (os, serie as in the report)}}`` for every report record of the serial."""
    ordens: Dict[str, Dict[str, Tuple[str, str]]] = {}
    for chamado in chamados:
        if not isinstance(chamado, dict) or _chave_serie(chamado.get("serie")) != alvo:
            continue
        serie = str(chamado.get("serie") or "").strip()
        simpress = chamado.get("simpress")
        oracle = chamado.get("oracle")
        achadas = [("simpress", o) for o in (simpress.get("ordens_servico") if isinstance(simpress, dict) else None) or []]
        achadas += [("oracle", i.get("ordem_servico")) for i in (oracle if isinstance(oracle, list) else []) if isinstance(i, dict)]
        for fonte, ordem in achadas:
            texto = str(ordem or "").strip()
            if texto:
                ordens.setdefault(_os_chave(texto), {}).setdefault(fonte, (texto, serie))
    return ordens


def vinculos_derivados(abertos: Sequence[Mapping[str, Any]], relatorio: Mapping[str, Any] | None) -> List[Dict[str, Any]]:
    """Links proposed by Dashboard rows with a full UTIC in C and a serial in K, marked ``origem: "dashboard"``.

    The target OS is the row's E when the serial has it, else the serial's only OS; zero or several OS is ambiguous and
    yields nothing. One entry per source (simpress/oracle) holding that OS. A (source, serial, OS) asked by two
    different UTIC is dropped for both.
    """
    chamados = (relatorio or {}).get("chamados")
    if not isinstance(chamados, list):
        return []
    entradas: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
    donos: Dict[Tuple[str, str, str], Set[str]] = {}
    for item in abertos:
        achado = NUMERO_UTIC.fullmatch(str(item.get("numero") or "").strip())  # ``linha:<n>`` never matches
        serie = str((item.get("automaticos") or {}).get("K") or "").strip()
        if not achado or not serie or not 2000 <= int(achado.group(1)) <= 9999 or len(achado.group(2)) > 24:
            continue
        ordens = _ordens_da_serie(chamados, _chave_serie(serie))
        atual = _os_chave((item.get("automaticos") or {}).get("E"))
        alvo = atual if atual in ordens else next(iter(ordens)) if len(ordens) == 1 else ""
        if not alvo:
            continue
        numero = f"UTIC-{achado.group(1)}-{achado.group(2)}"
        for fonte, (ordem, serie_relatorio) in ordens[alvo].items():
            chave = (fonte, _chave_serie(serie_relatorio), alvo)
            donos.setdefault(chave, set()).add(numero)
            entradas[chave] = {
                "fonte": fonte, "serie": serie_relatorio, "os": ordem, "ano": int(achado.group(1)),
                "numero": achado.group(2), "chamado": numero, "origem": "dashboard",
            }
    return [entrada for chave, entrada in entradas.items() if len(donos[chave]) == 1]


def os_do_chamado(vinculos: Sequence[Mapping[str, Any]], numero: str) -> str:
    """OS of the links whose ``chamado`` is ``numero``; with several, the highest one (as ``os_da_serie``); empty if none."""
    alvo = str(numero or "").strip().upper()
    ordens = [
        str(v.get("os") or "").strip() for v in vinculos
        if alvo and str(v.get("chamado") or "").strip().upper() == alvo and str(v.get("os") or "").strip()
    ]
    return max(ordens, key=_numero_da_os) if ordens else ""
