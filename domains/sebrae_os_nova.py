"""OS nova sugerida para um chamado antigo em aberto do F5 (decisão de 17/11/2026).

Funções puras sobre o relatório de chamados (``chamados[]``: ``serie``, ``simpress.ordens_servico``,
``simpress.chamados_cliente`` e ``oracle[]`` com ``ordem_servico``, ``assunto``, ``descricao``, ``data_criacao``).
A série (coluna K) é a chave principal; nome do solicitante e assunto parecido são só sinais. A chave forte é o número
UTIC do chamado escrito no texto da OS (``sebrae_vinculos.cita_chamado``). Nada aqui lê ou grava disco.

``E`` efetiva = OS do vínculo manual do chamado ou, sem ele, a coluna E da linha.

- Uma OS que já está na E efetiva de OUTRO chamado aberto nunca é sugerida nem trocada para este (decisão de 17/11/2026).
- E preenchida: as OS mais novas da série (ou toda OS da série, se E não é dela) que não foram recusadas para o chamado.
  Alguma com chave forte: ``troca`` (a mais nova entre elas; grava em E e o vínculo derivado aponta para ela).
  Sem chave forte: ``sugestao`` (a mais nova), que espera Aceitar ou Manter.
- E vazia e a série com OS: automático (``sebrae_novos.preenchimentos``); nada a sugerir. Com vínculo manual a E efetiva
  não está vazia: vale o item "E preenchida" acima. Ex.: E da planilha vazia, vínculo manual M e uma OS N mais nova da
  série que cita o UTIC dão ``troca`` para N; ``trocas_e`` devolve N e a gravação escreve N na E, por cima do M que o
  preenchimento poria (decisão registrada em 17/11/2026, revisão do PR #284).
- E vazia e a série sem OS: ``sem_os``, só quando exatamente uma OS do relatório tem a chave forte ou, na falta
  dela, cita o nome da pessoa do chamado. A chave forte não troca nada sozinha aqui.
"""

from __future__ import annotations

from typing import Any, Dict, Mapping, Optional, Sequence

from domains.assistant_lgpd import e_solicitante_sistema
from domains.sebrae_chamados import NUMERO_UTIC
from domains.sebrae_cruzamento import _palavras, nome_do_chamado
from domains.sebrae_vinculos import (
    _data_br, _os_chave, candidatas_de_troca, cita_chamado, donos_da_e, ordens_da_serie_com_macbook, os_cita_chamado,
    os_do_chamado, textos_da_os,
)

LIMIAR_ASSUNTO = 0.25  # Jaccard mínimo entre as palavras do chamado e as da OS para o sinal "assunto parecido"


def _palavras_longas(texto: Any) -> set:
    return {palavra for palavra in _palavras(texto).split() if len(palavra) >= 3}


def _assunto_parecido(chamado: Any, os_: Any) -> bool:
    a, b = _palavras_longas(chamado), _palavras_longas(os_)
    return bool(a and b) and len(a & b) / len(a | b) >= LIMIAR_ASSUNTO


def _nome_normalizado(item: Mapping[str, Any], registros: Sequence[Mapping[str, Any]]) -> str:
    """Nome da pessoa do chamado em palavras normalizadas, ou "" quando não há nome com duas palavras ou mais.

    Solicitante de sistema (``API SEBRAE``) não é pessoa: vale como sem nome."""
    bruto = nome_do_chamado(item.get("descricao"), item.get("usuario"), registros)[0]
    nome = "" if e_solicitante_sistema(bruto) else _palavras(bruto)
    return nome if len(nome.split()) >= 2 else ""


def _indice_de_os(chamados: Sequence[Any]) -> Dict[str, Dict[str, Any]]:
    """Toda OS do relatório: ``{chave: {os, serie, fonte, assunto, descricao, data, textos, palavras}}``.

    ``textos`` = assunto e descrição da Oracle mais os ``chamados_cliente`` do UX (onde mora a chave forte); ``palavras`` =
    assunto e descrição da Oracle normalizados (onde se procura o nome). A Oracle vale primeiro, como em ``textos_da_os``."""
    indice: Dict[str, Dict[str, Any]] = {}
    for chamado in chamados:
        if not isinstance(chamado, dict):
            continue
        serie = str(chamado.get("serie") or "").strip()
        oracle = chamado.get("oracle")
        for registro in oracle if isinstance(oracle, list) else []:
            ordem = str((registro or {}).get("ordem_servico") or "").strip() if isinstance(registro, dict) else ""
            if not ordem:
                continue
            assunto, descricao = str(registro.get("assunto") or "").strip(), str(registro.get("descricao") or "").strip()
            atual = indice.get(_os_chave(ordem))
            if atual is None or atual["fonte"] != "oracle":
                textos = atual["textos"] if atual else []
                atual = indice[_os_chave(ordem)] = {
                    "os": ordem, "serie": serie, "fonte": "oracle", "assunto": assunto, "descricao": descricao,
                    "data": _data_br(registro.get("data_criacao")), "textos": textos, "palavras": "",
                }
            atual["textos"] += [assunto, descricao]
            atual["palavras"] += " " + _palavras(f"{assunto} {descricao}")
        simpress = chamado.get("simpress")
        simpress = simpress if isinstance(simpress, dict) else {}
        for ordem in simpress.get("ordens_servico") or []:
            ordem = str(ordem or "").strip()
            if not ordem:
                continue
            atual = indice.setdefault(_os_chave(ordem), {
                "os": ordem, "serie": serie, "fonte": "simpress", "assunto": "", "descricao": "", "data": "",
                "textos": [], "palavras": "",
            })
            atual["textos"] += [str(c or "") for c in simpress.get("chamados_cliente") or []]
    return indice


def _da_serie(chamados: Sequence[Any], ordens: Mapping[str, Mapping[str, Any]], chave: str) -> Dict[str, str]:
    """``{os, serie, fonte, assunto, descricao, data}`` de uma OS da série do chamado, grafada como o relatório."""
    fonte = "oracle" if "oracle" in ordens[chave] else "simpress"
    ordem, serie = ordens[chave][fonte]
    texto = textos_da_os(chamados, chave)
    return {"os": ordem, "serie": serie, "fonte": fonte, "assunto": texto["assunto"], "descricao": texto["descricao"], "data": texto["data"]}


def _atual(chamados: Sequence[Any], ordens: Mapping[str, Mapping[str, Any]], atual: str, escrita: str) -> Dict[str, str]:
    """OS que está em E; fora do relatório só o número (como foi digitado), sem texto."""
    texto = textos_da_os(chamados, atual)
    ordem = next(iter(ordens[atual].values()))[0] if atual in ordens else escrita
    return {"os": ordem, "assunto": texto["assunto"], "descricao": texto["descricao"], "data": texto["data"]}


def _montar(
    tipo: str, atual: Optional[Dict[str, str]], nova: Dict[str, str], ano: str, numero: str, *,
    mesma_serie: bool, nome: bool, assunto: bool, numero_chamado: bool,
) -> Dict[str, Any]:
    return {
        "tipo": tipo, "atual": atual, "nova": nova,
        "sinais": {"mesma_serie": mesma_serie, "nome": nome, "assunto": assunto, "numero_chamado": numero_chamado},
        "aceitar": {"fonte": nova["fonte"], "serie": nova["serie"], "os": nova["os"], "ano": int(ano), "numero": numero},
    }


def os_novas(
    abertos_efetivos: Sequence[Mapping[str, Any]], relatorio: Mapping[str, Any] | None, vinculos: Sequence[Mapping[str, Any]],
    recusadas: Mapping[str, Sequence[str]] | None, registros: Sequence[Mapping[str, Any]],
    indice_endpoint: Mapping[str, Any] | None = None,
) -> Dict[str, Dict[str, Any]]:
    """``{numero do chamado: sugestão}`` para os antigos em aberto que têm OS nova a trocar ou sugerir.

    ``abertos_efetivos``: itens como ``ChamadoAberto.como_dict()`` já completados (``descricao`` e ``usuario`` do SoftExpert) e
    com ``automaticos`` K e E já preenchidos pelo cruzamento. ``vinculos``: vínculos manuais UTIC -> OS. ``recusadas``:
    ``{numero: [OS]}`` de ``sebrae_os_recusadas.ler``. Formato de cada sugestão: ``tipo`` (``troca``, ``sugestao`` ou ``sem_os``),
    ``atual`` (OS que está em E, ou ``None``), ``nova``, ``sinais`` e ``aceitar`` (corpo pronto do vínculo manual)."""
    chamados = (relatorio or {}).get("chamados")
    if not isinstance(chamados, list):
        return {}
    resultado: Dict[str, Dict[str, Any]] = {}
    geral: Optional[Dict[str, Dict[str, Any]]] = None  # só o caso sem OS precisa dele
    da_e = donos_da_e(abertos_efetivos, vinculos)
    for item in abertos_efetivos:
        achado = NUMERO_UTIC.fullmatch(str(item.get("numero") or "").strip())  # ``linha:<n>`` nunca casa
        if not achado or not 2000 <= int(achado.group(1)) <= 9999 or len(achado.group(2)) > 24:
            continue
        ano, digitos = achado.group(1), achado.group(2)
        numero = f"UTIC-{ano}-{digitos}"
        automaticos = item.get("automaticos") or {}
        serie = str(automaticos.get("K") or "").strip()
        escrita = os_do_chamado(vinculos, numero) or str(automaticos.get("E") or "").strip()
        atual = _os_chave(escrita)
        ordens = ordens_da_serie_com_macbook(chamados, serie, indice_endpoint) if serie else {}
        banidas = {_os_chave(o) for o in (recusadas or {}).get(numero) or ()}
        banidas |= {chave for chave, quem in da_e.items() if quem - {str(item.get("numero")).strip()}}  # E de outro chamado
        texto_chamado = f"{item.get('titulo') or ''} {item.get('descricao') or ''}"

        if atual:
            candidatas = candidatas_de_troca(ordens, atual, banidas)
            if not candidatas:
                continue
            fortes = [c for c in candidatas if os_cita_chamado(chamados, c, ano, digitos)]
            nova = _da_serie(chamados, ordens, (fortes or candidatas)[0])
            nome = _nome_normalizado(item, registros)
            resultado[str(item.get("numero")).strip()] = _montar(
                "troca" if fortes else "sugestao", _atual(chamados, ordens, atual, escrita), nova, ano, digitos,
                mesma_serie=True, nome=bool(nome) and nome in _palavras(f"{nova['assunto']} {nova['descricao']}"),
                assunto=_assunto_parecido(texto_chamado, f"{nova['assunto']} {nova['descricao']}"), numero_chamado=bool(fortes),
            )
        elif not ordens:
            geral = geral if geral is not None else _indice_de_os(chamados)
            nome = _nome_normalizado(item, registros)
            livres = {c: r for c, r in geral.items() if c not in banidas}
            fortes = [c for c, r in livres.items() if any(cita_chamado(t, ano, digitos) for t in r["textos"])]
            por_nome = [] if fortes or not nome else [c for c, r in livres.items() if nome in r["palavras"]]
            achadas = fortes or por_nome
            if len(achadas) != 1:
                continue  # nenhuma ou mais de uma: nada se adivinha
            registro = livres[achadas[0]]
            nova = {k: registro[k] for k in ("os", "serie", "fonte", "assunto", "descricao", "data")}
            resultado[str(item.get("numero")).strip()] = _montar(
                "sem_os", None, nova, ano, digitos, mesma_serie=False,
                nome=bool(nome) and nome in _palavras(f"{nova['assunto']} {nova['descricao']}"),
                assunto=_assunto_parecido(texto_chamado, f"{nova['assunto']} {nova['descricao']}"), numero_chamado=bool(fortes),
            )
    return resultado


def trocas_e(
    sugestoes: Mapping[str, Mapping[str, Any]], abertos: Sequence[Mapping[str, Any]], vinculos: Sequence[Mapping[str, Any]],
) -> Dict[str, str]:
    """``{numero: OS}`` que a gravação do Dashboard escreve na coluna E mesmo com E já preenchida.

    Junta o vínculo manual cuja OS difere da E da linha (``abertos`` com a E gravada na planilha) e as sugestões do tipo
    ``troca`` (a troca vale mais que o vínculo manual, como em ``os_novas``). Só chamados de ``abertos``, só a coluna E e só
    quando a OS difere da E gravada. E vazia sem ``troca`` segue o preenchimento normal (``sebrae_novos.preenchimentos``);
    E vazia COM ``troca`` (vínculo manual M e OS N mais nova com chave forte) também entra aqui: a gravação aplica a troca
    depois dos automáticos, então N vai para a E no lugar de M. Uma OS recusada para o chamado nunca chega aqui, porque
    ``os_novas`` já a descarta."""
    gravadas = {str(item.get("numero") or "").strip(): str((item.get("automaticos") or {}).get("E") or "").strip() for item in abertos}
    trocas: Dict[str, str] = {}
    for numero, gravada in gravadas.items():
        ligada = os_do_chamado(vinculos, numero)
        if gravada and ligada:
            trocas[numero] = ligada
    for numero, sugestao in sugestoes.items():
        if sugestao.get("tipo") == "troca" and numero in gravadas:
            trocas[numero] = str(sugestao["nova"]["os"])
    return {numero: os_ for numero, os_ in trocas.items() if _os_chave(os_) != _os_chave(gravadas[numero])}
