"""Draft texts (e-mail or message) the assistant helps write. Nothing is sent: the draft is only text in the answer.

The server gathers the exact facts (serials, hostnames, counts, dates) from the latest sheet comparison and builds a
`esqueleto` with them already in place, short lists cut at `LIMITE_ITENS` ("e mais X"). The model only adds greeting,
tone and the request; it copies the lines of the skeleton without changing them. The skeleton goes through the privacy
mask like any tool result (hostnames become markers there and are restored only on screen). Only serial, hostname,
places and days enter the facts: never users, e-mails, phones, CPFs or free text of the sheets.
"""

from datetime import datetime
from typing import Any, Dict, List, Tuple

from domains.assistant_api import SimpressApi, _dict, _exemplo_comparacao
from domains.assistant_lgpd import limpar_texto_sensivel
from domains.history_insights import PENDING_CATEGORIES
from domains.inventory_comparison import is_sebrae_owned_notebook_serial

LIMITE_ITENS = 10  # split among the sections (at least MIN_ITENS_SECAO each) so the result fits what the chat keeps of a tool result
MIN_ITENS_SECAO = 1
LIMITE_COMPLEMENTO = 200

# Titles of the sections shown in the draft (approved labels: "na Simpress", "no Endpoint").
_TITULOS = {
    **PENDING_CATEGORIES,
    "ausentes_no_endpoint": "Séries na Simpress sem correspondência no Endpoint",
    "ausentes_em_detalhes": "Séries no Endpoint sem correspondência na Simpress",
}
# type -> (subject, sections of the comparison)
TIPOS: Dict[str, Tuple[str, Tuple[str, ...]]] = {
    "sem_acesso_7_dias": ("Equipamentos sem acesso há 7 dias ou mais", ("sem_acesso_7_dias",)),
    "sem_correspondencia": ("Equipamentos sem correspondência entre Simpress e Endpoint", ("ausentes_no_endpoint", "ausentes_em_detalhes")),
    "localidade_divergente": ("Equipamentos com localidade divergente", ("divergencias_local",)),
    "pendencias_operacionais": ("Pendências operacionais da última atualização de inventário", tuple(PENDING_CATEGORIES)),
}
DESCRICAO_TIPOS = {
    "sem_acesso_7_dias": "equipamentos sem acesso (verificação no Endpoint) há 7 dias ou mais",
    "sem_correspondencia": "séries sem correspondência entre a Simpress e o Endpoint",
    "localidade_divergente": "séries com a localidade cadastrada na Simpress diferente da prevista",
    "pendencias_operacionais": "todas as pendências operacionais da última comparação",
}


def _data(horario: Any) -> str:
    """AAAA-MM-DD... to DD/MM/AAAA; anything else is shown cleaned."""
    texto = limpar_texto_sensivel(horario)[:10]
    try:
        return datetime.strptime(texto, "%Y-%m-%d").strftime("%d/%m/%Y")
    except ValueError:
        return texto


def _linha(item: Dict[str, Any]) -> str:
    serie, host = item.get("serie"), item.get("computador")
    nome = f"{serie} ({host})" if serie and host else str(serie or host or "item sem série nem hostname")
    if "dias_sem_acesso" in item:
        nome += f" — {item['dias_sem_acesso']} dias sem verificação"
    if "local_previsto" in item or "local_na_simpress" in item:
        nome += f" — local previsto: {item.get('local_previsto') or 'não informado'}; local na Simpress: {item.get('local_na_simpress') or 'não informado'}"
    return f"- {nome}"


def _secoes(comparacao: Dict[str, Any], campos: Tuple[str, ...]) -> List[Dict[str, Any]]:
    """Sections with items, merged by title; Sebrae notebooks stay out of the unmatched lists (AGENTS.md)."""
    por_titulo: Dict[str, List[Dict[str, Any]]] = {}
    for campo in campos:
        for item in comparacao.get(campo) or []:
            if isinstance(item, dict) and not (campo.startswith("ausentes_") and is_sebrae_owned_notebook_serial(item.get("serie") or item.get("serial"))):
                por_titulo.setdefault(_TITULOS[campo], []).append(_exemplo_comparacao(item))
    return [{"titulo": titulo, "total": len(itens), "itens": itens} for titulo, itens in por_titulo.items()]


def montar_rascunho(api: SimpressApi, tipo: Any = "", assunto_extra: Any = "") -> Dict[str, Any]:
    """Facts and skeleton for a draft of the given closed `tipo`; `assunto_extra` is one optional line from the user."""
    if not isinstance(tipo, str) or tipo not in TIPOS:
        return {"erro": "Tipo de rascunho desconhecido.", "tipos_validos": DESCRICAO_TIPOS}
    assunto, campos = TIPOS[tipo]
    evento, detalhe, falha = api.ultimo_evento()
    if falha is not None or evento is None or detalhe is None:
        return falha or {"erro": "Histórico indisponível."}
    secoes = _secoes(_dict(_dict(_dict(detalhe).get("evento")).get("comparacao")), campos)
    total = sum(s["total"] for s in secoes)
    data = _data(evento.get("horario"))
    if not total:
        return {"tipo": tipo, "total": 0, "mensagem": f"Não há itens desse tipo na última comparação ({data}). Diga isso e não escreva cobrança."}

    por_secao = max(MIN_ITENS_SECAO, LIMITE_ITENS // len(secoes))
    blocos = []
    for s in secoes:
        s["itens"] = s["itens"][:por_secao]
        s["omitidos"] = s["total"] - len(s["itens"])
        linhas = [_linha(i) for i in s["itens"]] + ([f"- e mais {s['omitidos']}"] if s["omitidos"] else [])
        blocos.append(f"{s['titulo']} ({s['total']}):\n" + "\n".join(linhas))
    complemento = " ".join(limpar_texto_sensivel(assunto_extra).split())[:LIMITE_COMPLEMENTO] if isinstance(assunto_extra, str) else ""
    esqueleto = (
        f"Assunto: {assunto} ({total})\n\n"
        f"Na última comparação de planilhas do Simpress ({data}), encontramos {total} item(ns):\n\n" + "\n\n".join(blocos)
        + (f"\n\nObservação do solicitante: {complemento}" if complemento else "")
    )
    return {
        "tipo": tipo,
        "total": total,
        "horario_comparacao": data,
        # Hostnames only, so the mask registers them and swaps them inside `esqueleto` too (that key is free text for the mask).
        "itens": [{"computador": i["computador"]} for s in secoes for i in s["itens"] if i.get("computador")],
        "esqueleto": esqueleto,
        "instrucao": "Copie as linhas de lista do esqueleto sem alterar séries, hostnames, números nem datas. Só escreva saudação, tom, o pedido e a despedida. Nada é enviado: é só texto.",
    }
