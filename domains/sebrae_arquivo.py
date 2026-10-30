"""Archive of the Sebrae tickets that left the open list (docs/operacao/sincronizar-chamados-sebrae.md).

On every Dashboard import, a ticket that was open in the previous import and now is FINALIZADO, or is gone from
column C, is recorded here by its UTIC number (upsert: one record per ticket, one ``ciclos`` entry per exit, so a
reopened ticket that closes again adds a cycle). The first import also seeds the tickets that are already FINALIZADO.
Unlike the import history (``sebrae_historico``), nothing ever expires.

Only the number, the exit reason, the status and closing date (D, R) and the category, type and SLA type (B, J, S)
are kept; no ticket text, user name or responsible (A) enters the file.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Mapping, Sequence

from core.integrity import atomic_write_json, lock_paths
from domains.sebrae_dashboard_gravacao import CHAVE_DE_LINHA
from domains.sebrae_historico import agora_iso

MOTIVO_FINALIZADO = "finalizado"
MOTIVO_SAIU = "saiu_do_dashboard"
STATUS_FINALIZADO = "FINALIZADO"
_CAMPOS_DO_CHAMADO = (("categoria", "B"), ("tipo", "J"), ("sla", "S"))


class ArquivoIlegivel(ValueError):
    """The archive exists but cannot be trusted; it is never overwritten."""


def _ler(caminho: Path) -> Dict[str, Any]:
    if not caminho.exists():
        return {"versao": 1, "itens": {}, "nao_rastreaveis": 0}
    try:
        dados = json.loads(caminho.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as erro:
        raise ArquivoIlegivel("O arquivo de chamados encerrados está ilegível; os dados foram preservados.") from erro
    if not isinstance(dados, dict) or not isinstance(dados.get("itens"), dict):
        raise ArquivoIlegivel("O arquivo de chamados encerrados está ilegível; os dados foram preservados.")
    return dados


def ler(caminho: Path) -> Dict[str, Any]:
    return _ler(caminho)


def registrar_saidas(
    caminho: Path,
    *,
    abertos_antes: Sequence[Mapping[str, Any]],
    mapa: Mapping[str, Mapping[str, str]],
    visto_em: str = "",
    sha256: str = "",
    em: str = "",
) -> Dict[str, int]:
    """``abertos_antes``: open tickets of the previous import; ``mapa``: number -> status and closing date of the new one.

    ``sha256`` is the new import's hash: the same import never adds a second cycle to a ticket (retry after a failure).
    Tickets keyed ``linha:<n>`` (no single UTIC) cannot be followed between imports and are only counted.
    Returns ``{"registrados", "semeados", "nao_rastreaveis"}``.
    """
    em = em or agora_iso()
    with lock_paths([caminho]):
        primeira_vez = not caminho.exists()
        dados = _ler(caminho)
        itens = dados["itens"]
        registrados = semeados = nao_rastreaveis = 0

        def anotar(numero: str, aberto: Mapping[str, Any], motivo: str, atual: Mapping[str, str]) -> bool:
            item = itens.setdefault(numero, {"numero": numero, "ciclos": []})
            ciclos = item["ciclos"]
            if sha256 and ciclos and ciclos[-1].get("sha256") == sha256:
                return False
            bruto = aberto.get("valores")
            valores: Mapping[str, Any] = bruto if isinstance(bruto, dict) else {}
            for campo, letra in _CAMPOS_DO_CHAMADO:
                if valores.get(letra):
                    item[campo] = str(valores[letra])
            ciclos.append({
                "saida_em": em, "motivo": motivo, "status": str(atual.get("status") or ""),
                "encerramento": str(atual.get("encerramento") or ""), "visto_aberto_em": visto_em, "sha256": sha256,
            })
            return True

        for aberto in abertos_antes:
            numero = str(aberto.get("numero") or "")
            if not numero or numero.startswith(CHAVE_DE_LINHA):
                nao_rastreaveis += 1
                continue
            atual = mapa.get(numero)
            if atual is None:
                registrados += anotar(numero, aberto, MOTIVO_SAIU, {})
            elif atual.get("status") == STATUS_FINALIZADO:
                registrados += anotar(numero, aberto, MOTIVO_FINALIZADO, atual)
        if primeira_vez:  # tickets already closed in the first Dashboard imported
            for numero, atual in mapa.items():
                if atual.get("status") == STATUS_FINALIZADO and numero not in itens:
                    semeados += anotar(numero, {}, MOTIVO_FINALIZADO, atual)
        dados.update(versao=1, nao_rastreaveis=nao_rastreaveis, atualizado_em=em)
        atomic_write_json(caminho, dados)
        return {"registrados": registrados, "semeados": semeados, "nao_rastreaveis": nao_rastreaveis}
