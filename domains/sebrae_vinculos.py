"""Link between the Dashboard's ticket (column C) and the OS column of the ticket table (``os_chamados_vinculos.json``).

Pure functions, except ``read_ticket_os_links``, the only one that reads the store. ``vinculos_derivados`` reads the Dashboard (C = UTIC, K = serial, E = OS) and the ticket report and
proposes links in the store's format; ``os_do_chamado`` goes the other way, giving the OS a manual link sets on a UTIC.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Collection, Dict, Iterable, Iterator, List, Mapping, Optional, Sequence, Set, Tuple

from core.errors import DomainBusyError
from domains.inventory_comparison import normalize_reference_value
from domains.sebrae_chamados import NUMERO_UTIC
from domains.sebrae_cruzamento import _chave_serie, _numero_da_os, serie_equivalente_macbook


def _os_chave(valor: Any) -> str:
    return re.sub(r"\s+", "", str(valor or "")).upper()


def ticket_os_link_key(fonte: str, serie: str, ordem_servico: str) -> str:
    ordem_key = re.sub(r"\s+", "", str(ordem_servico or "")).upper()
    return json.dumps(
        [fonte, normalize_reference_value(serie), ordem_key],
        ensure_ascii=False, separators=(",", ":"),
    )


def read_ticket_os_links(path: Path) -> Dict[str, Any]:
    """The manual-link store; a missing file is an empty store, an unreadable or invalid one raises ``DomainBusyError`` (503)."""
    if not path.exists():
        return {"version": 1, "vinculos": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise DomainBusyError("Os vínculos manuais de OS não puderam ser lidos.") from None
    if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("vinculos"), dict):
        raise DomainBusyError("Os vínculos manuais de OS estão inválidos.")
    links = data["vinculos"]
    for key, link in links.items():
        if not isinstance(key, str) or not isinstance(link, dict):
            raise DomainBusyError("Os vínculos manuais de OS estão inválidos.")
        try:
            fonte = link["fonte"]
            serie = link["serie"]
            ordem = link["os"]
            ano = int(link["ano"])
            numero = link["numero"]
            expected_key = ticket_os_link_key(fonte, serie, ordem)
            valid = (
                fonte in {"simpress", "oracle"}
                and bool(str(serie).strip()) and bool(str(ordem).strip())
                and 2000 <= ano <= 9999
                and isinstance(numero, str) and re.fullmatch(r"\d{1,24}", numero)
                and key == expected_key
            )
        except (KeyError, TypeError, ValueError):
            valid = False
            numero = ""
            ano = 0
        if not valid:
            raise DomainBusyError("Os vínculos manuais de OS estão inválidos.")
        link["ano"] = ano
        link["chamado"] = f"UTIC-{ano}-{numero}"
    return data


def finalization_links_by_key(items: Iterable[Dict[str, Any]], manual: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    """Finalization links by key; a manual link on the key wins and the first item of a key wins."""
    found: Dict[str, Dict[str, Any]] = {}
    for item in items:
        key = ticket_os_link_key(item["fonte"], item["serie"], item["os"])
        if key not in manual:
            found.setdefault(key, item)
    return found


def derived_links(items: Iterable[Dict[str, Any]], manual: Mapping[str, Any]) -> List[Dict[str, Any]]:
    """Dashboard-derived links; the last item of a key wins, and a manual link on the same key always wins.
    shortcut: derived links are never stored, so clearing one in the editor makes it reappear; upgrade if a "dismissed" list is needed."""
    derived = {ticket_os_link_key(item["fonte"], item["serie"], item["os"]): item for item in items}
    return [item for key, item in derived.items() if key not in manual]


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


def ordens_da_serie_com_macbook(
    chamados: Sequence[Any], serie: Any, indice_endpoint: Mapping[str, Any] | None = None,
) -> Dict[str, Dict[str, Tuple[str, str]]]:
    """``_ordens_da_serie`` for ``serie``; a MacBook serial with no OS as written is tried in its other ``S`` spelling."""
    ordens = _ordens_da_serie(chamados, _chave_serie(serie))
    if not ordens and (outra := _chave_serie(serie_equivalente_macbook(serie, indice_endpoint))):
        ordens = _ordens_da_serie(chamados, outra)
    return ordens


def cita_chamado(texto: Any, ano: Any, numero: Any) -> bool:
    """True when ``texto`` names the UTIC ``ano``/``numero`` (e.g. ``UTIC-2026-0094``, ``utic 2026 94``): the strong key of an OS.

    Separators and leading zeros are free; ``UTIC-2026-940`` never matches number 94."""
    digitos = str(numero or "").strip()
    if not digitos.isdigit() or not str(ano or "").strip().isdigit():
        return False
    return re.search(rf"UTIC\W*{int(ano)}\W*0*{int(digitos)}(?!\d)", str(texto or ""), re.IGNORECASE) is not None


def _data_br(valor: Any) -> str:
    """Oracle ``data_criacao`` (ISO or ``dd/mm/aaaa [hh:mm[:ss]]``) as ``DD/MM/AAAA``; empty when it is not a date."""
    texto = str(valor or "").strip()
    if not texto:
        return ""
    try:
        return datetime.fromisoformat(texto).strftime("%d/%m/%Y")
    except ValueError:
        pass
    for formato in ("%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d/%m/%Y"):
        try:
            return datetime.strptime(texto, formato).strftime("%d/%m/%Y")
        except ValueError:
            continue
    return ""


def _registros_da_os(chamados: Sequence[Any], alvo: str) -> Iterator[Tuple[Dict[str, Any], Optional[Dict[str, Any]]]]:
    """``(report row, oracle record or None)`` for every place the OS ``alvo`` (``_os_chave``) appears: Oracle first, then Simpress."""
    achados_simpress = []
    for chamado in chamados:
        if not isinstance(chamado, dict):
            continue
        oracle = chamado.get("oracle")
        for item in oracle if isinstance(oracle, list) else []:
            if isinstance(item, dict) and _os_chave(item.get("ordem_servico")) == alvo:
                yield chamado, item
        simpress = chamado.get("simpress")
        ordens = simpress.get("ordens_servico") if isinstance(simpress, dict) else None
        if any(_os_chave(o) == alvo for o in ordens or []):
            achados_simpress.append(chamado)
    for chamado in achados_simpress:
        yield chamado, None


def textos_da_os(chamados: Sequence[Any], os_chave: Any) -> Dict[str, str]:
    """``{assunto, descricao, data (DD/MM/AAAA), serie, fonte}`` of the OS in the report; all empty when it is not there.

    Oracle (the first record with the OS) gives the texts and the date; an OS only in Simpress has ``fonte: "simpress"``
    and empty texts. ``serie`` is spelled as in the report row."""
    alvo = _os_chave(os_chave)
    for chamado, item in _registros_da_os(chamados, alvo) if alvo else ():
        serie = str(chamado.get("serie") or "").strip()
        if item is None:
            return {"assunto": "", "descricao": "", "data": "", "serie": serie, "fonte": "simpress"}
        return {
            "assunto": str(item.get("assunto") or "").strip(), "descricao": str(item.get("descricao") or "").strip(),
            "data": _data_br(item.get("data_criacao")), "serie": serie, "fonte": "oracle",
        }
    return {"assunto": "", "descricao": "", "data": "", "serie": "", "fonte": ""}


def textos_da_chave_forte(chamados: Sequence[Any], os_chave: Any) -> List[str]:
    """Every text of the OS that can hold the UTIC number: Oracle subject and description, UX ``chamados_cliente`` of the Simpress row."""
    alvo = _os_chave(os_chave)
    textos: List[str] = []
    for chamado, item in _registros_da_os(chamados, alvo) if alvo else ():
        if item is not None:
            textos += [str(item.get("assunto") or ""), str(item.get("descricao") or "")]
        else:
            textos += [str(c or "") for c in (chamado.get("simpress") or {}).get("chamados_cliente") or []]
    return textos


def os_cita_chamado(chamados: Sequence[Any], os_chave: Any, ano: Any, numero: Any) -> bool:
    """Strong key: the text of the OS ``os_chave`` names the UTIC ``ano``/``numero``."""
    return any(cita_chamado(texto, ano, numero) for texto in textos_da_chave_forte(chamados, os_chave))


def _numero_da_chave(ordens: Mapping[str, Mapping[str, Tuple[str, str]]], chave: str) -> int:
    return _numero_da_os(next(iter(ordens[chave].values()))[0])


def candidatas_de_troca(
    ordens: Mapping[str, Mapping[str, Tuple[str, str]]], atual: str, recusadas: Collection[str] = (),
) -> List[str]:
    """OS keys of the serial that may replace the ticket's E (``atual`` = ``_os_chave`` of the effective E), newest first.

    Not refused for the ticket and different from E. With E in the serial only a higher OS number counts; with E outside
    the serial (or empty) every OS of it does, since the serial is the main key."""
    banidas = {_os_chave(o) for o in recusadas} | {atual}
    candidatas = [chave for chave in ordens if chave not in banidas]
    if atual in ordens:
        candidatas = [chave for chave in candidatas if _numero_da_chave(ordens, chave) > _numero_da_chave(ordens, atual)]
    return sorted(candidatas, key=lambda chave: (_numero_da_chave(ordens, chave), chave), reverse=True)


def donos_da_e(abertos: Sequence[Mapping[str, Any]], vinculos: Sequence[Mapping[str, Any]] = ()) -> Dict[str, Set[str]]:
    """``{_os_chave: {chamados}}``: which open tickets hold each OS in their effective E (manual link, else the row's E)."""
    donos: Dict[str, Set[str]] = {}
    for item in abertos:
        numero = str(item.get("numero") or "").strip()
        atual = _os_chave(os_do_chamado(vinculos, numero) or (item.get("automaticos") or {}).get("E"))
        if numero and atual:
            donos.setdefault(atual, set()).add(numero)
    return donos


def vinculos_derivados(
    abertos: Sequence[Mapping[str, Any]], relatorio: Mapping[str, Any] | None, indice_endpoint: Mapping[str, Any] | None = None,
    recusadas: Mapping[str, Collection[str]] | None = None, *, chave_forte: bool = True,
    manuais: Sequence[Mapping[str, Any]] = (),
) -> List[Dict[str, Any]]:
    """Links proposed by Dashboard rows with a full UTIC in C and a serial in K, marked ``origem: "dashboard"``.

    A MacBook serial with no OS as written is looked up in its other ``S`` spelling (``indice_endpoint``, unique match
    only); the link keeps the serial as the report has it.

    The target OS depends on the row's E:
    - E is an OS of the serial: E, unless a newer OS of the serial (not refused in ``recusadas`` for this UTIC) holds the
      UTIC number in its text (strong key); then the newest of those.
    - E is filled but outside the serial: the newest OS of the serial with the strong key (not refused); without it, nothing.
    - E is empty: the serial's only OS; zero or several OS is ambiguous and yields nothing.
    A newer OS without the strong key is only a suggestion (``sebrae_os_nova``) and never becomes a link here. An OS
    already in the effective E of ANOTHER open ticket (its ``manuais`` link, else its E) is never a swap target. ``chave_forte=False`` restores the old rule (no swap;
    E outside the serial links the serial's only OS): the Coverage tab (F10) keeps it, since it only needs to know which
    serials have an open ticket, and so does any caller that could not read the refusals strictly.
    One entry per source (simpress/oracle) holding that OS. A (source, serial, OS) asked by two different UTIC is
    dropped for both.
    """
    chamados = (relatorio or {}).get("chamados")
    if not isinstance(chamados, list):
        return []
    entradas: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
    donos: Dict[Tuple[str, str, str], Set[str]] = {}
    da_e = donos_da_e(abertos, manuais) if chave_forte else {}
    for item in abertos:
        achado = NUMERO_UTIC.fullmatch(str(item.get("numero") or "").strip())  # ``linha:<n>`` never matches
        serie = str((item.get("automaticos") or {}).get("K") or "").strip()
        if not achado or not serie or not 2000 <= int(achado.group(1)) <= 9999 or len(achado.group(2)) > 24:
            continue
        ordens = ordens_da_serie_com_macbook(chamados, serie, indice_endpoint)
        numero = f"UTIC-{achado.group(1)}-{achado.group(2)}"
        atual = _os_chave((item.get("automaticos") or {}).get("E"))
        if atual:
            do_outro = [chave for chave, quem in da_e.items() if quem - {str(item.get("numero")).strip()}]
            fortes = [
                chave for chave in candidatas_de_troca(ordens, atual, [*((recusadas or {}).get(numero) or ()), *do_outro])
                if os_cita_chamado(chamados, chave, achado.group(1), achado.group(2))
            ] if chave_forte else []
            unica = next(iter(ordens)) if len(ordens) == 1 and not chave_forte else ""
            alvo = fortes[0] if fortes else atual if atual in ordens else unica
        else:
            alvo = next(iter(ordens)) if len(ordens) == 1 else ""
        if not alvo:
            continue
        for fonte, (ordem, serie_relatorio) in ordens[alvo].items():
            chave = (fonte, _chave_serie(serie_relatorio), alvo)
            donos.setdefault(chave, set()).add(numero)
            entradas[chave] = {
                "fonte": fonte, "serie": serie_relatorio, "os": ordem, "ano": int(achado.group(1)),
                "numero": achado.group(2), "chamado": numero, "origem": "dashboard",
            }
    return [entrada for chave, entrada in entradas.items() if len(donos[chave]) == 1]


def vinculos_da_finalizacao(
    marcas: Sequence[Mapping[str, Any]], relatorio: Mapping[str, Any] | None,
) -> List[Dict[str, Any]]:
    """Links implied by the ACTIVE finalization marks (``ler_marcas``, newest first), marked ``origem: "finalizacao"``.

    The year and number come from the mark's own UTIC (never a fixed year). One entry per source (simpress/oracle) that
    holds the mark's OS under its serial; serial and OS keep the report's spelling. A mark whose OS the report does not
    have yields nothing. The first (newest) active mark of a (source, serial, OS) wins. The serial must match as written
    (no MacBook ``S`` fallback): the F6 tab puts an OS in ``Finalizadas`` by the same exact serial, so both stay in step.
    """
    chamados = (relatorio or {}).get("chamados")
    if not isinstance(chamados, list):
        return []
    entradas: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
    for marca in marcas:
        achado = NUMERO_UTIC.fullmatch(str(marca.get("chamado") or "").strip())
        serie, alvo = str(marca.get("serie") or "").strip(), _os_chave(marca.get("os"))
        if not marca.get("ativa") or not achado or not serie or not alvo or not 2000 <= int(achado.group(1)) <= 9999 or len(achado.group(2)) > 24:
            continue
        for fonte, (ordem, serie_relatorio) in _ordens_da_serie(chamados, _chave_serie(serie)).get(alvo, {}).items():
            entradas.setdefault((fonte, _chave_serie(serie_relatorio), alvo), {
                "fonte": fonte, "serie": serie_relatorio, "os": ordem, "ano": int(achado.group(1)), "numero": achado.group(2),
                "chamado": f"UTIC-{achado.group(1)}-{achado.group(2)}", "origem": "finalizacao",
                "finalizado_em": str(marca.get("finalizado_em") or ""),
            })
    return list(entradas.values())


def vinculo_do_chamado(vinculos: Sequence[Mapping[str, Any]], numero: str) -> Optional[Mapping[str, Any]]:
    """Link whose ``chamado`` is ``numero``; ``None`` if none.

    With several, the most recently saved one wins (``salvo_em``, written by ``PUT vinculos-os``), so an OS just accepted
    in the F5 beats an older manual link even with a lower or non-numeric number (UX). Ties and links saved before
    ``salvo_em`` existed fall back to the highest OS (as ``os_da_serie``)."""
    alvo = str(numero or "").strip().upper()
    achados = [
        v for v in vinculos
        if alvo and str(v.get("chamado") or "").strip().upper() == alvo and str(v.get("os") or "").strip()
    ]
    return max(achados, key=lambda v: (str(v.get("salvo_em") or ""), _numero_da_os(str(v.get("os")).strip()))) if achados else None


def os_do_chamado(vinculos: Sequence[Mapping[str, Any]], numero: str) -> str:
    """OS of the link ``vinculo_do_chamado`` picks for ``numero`` (newest ``salvo_em``, then highest OS); empty if none."""
    achado = vinculo_do_chamado(vinculos, numero)
    return str(achado.get("os") or "").strip() if achado else ""
