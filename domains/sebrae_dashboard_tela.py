"""Estado da tela F5 do Dashboard Sebrae (GET /api/sebrae/novos), extraído de ``routers/sebrae_dashboard.py``.

Não depende de HTTP: cada função recebe ``services`` e devolve dados.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence

from core.errors import DomainBusyError
from domains import (
    sebrae_categoria, sebrae_categoria_ia, sebrae_credenciais, sebrae_cruzamento, sebrae_finalizacao as fin,
    sebrae_novos, sebrae_observacoes as obs, sebrae_os_nova, sebrae_os_recusadas,
)
from domains.assistant_lgpd import e_solicitante_sistema
from domains.chrome_automation import ChromeAutomationRunner

NOME_ATUALIZADO = "Dashboard Operacional_SEBRAE.xlsx"
logger = logging.getLogger("routers.sebrae_dashboard")  # nome do logger mantido para a saída e os filtros de log não mudarem


@dataclass(frozen=True)
class SebraeDashboardServices:
    caminhos: Callable[[], sebrae_novos.Caminhos]
    max_upload_bytes: Callable[[], int]
    registros: Callable[[], Sequence[Mapping[str, Any]]]  # equipment records by person name (EquipamentosDetalhes, Endpoint, Entra)
    relatorio_chamados: Callable[[], Optional[Mapping[str, Any]]]  # ticket report, for column E
    vinculos_os: Callable[[], Sequence[Mapping[str, Any]]] = lambda: ()  # manual links UTIC -> OS of the ticket table, for column E
    apelidos: Callable[[], Mapping[str, str]] = lambda: {}  # SERIE -> apelido, só para exibir no cartão (nunca gravado)
    indice_endpoint: Callable[[], Optional[Mapping[str, Any]]] = lambda: None  # Endpoint index + Simpress base serials, only for the MacBook ``S`` equivalence in column E
    runner: Optional[Callable[[], ChromeAutomationRunner]] = None  # starts the ``fechar`` routine; without it nothing is finalized


def pasta_estado(services: SebraeDashboardServices) -> Path:
    return fin.pasta_estado(services.caminhos().existentes)


def relatorio(services: SebraeDashboardServices) -> Optional[Mapping[str, Any]]:
    try:
        return services.relatorio_chamados()
    except (OSError, ValueError):
        return None  # an unreadable ticket report only leaves column E empty


def indice_endpoint(services: SebraeDashboardServices) -> Optional[Mapping[str, Any]]:
    try:
        return services.indice_endpoint()
    except Exception as erro:  # an optional fallback must never break the screen or the update
        logger.warning("Índice do Endpoint indisponível para a OS de MacBook (erro=%s).", type(erro).__name__)
        return None  # without the index E just keeps the exact-serial match


def leitura_antigos(services: SebraeDashboardServices) -> Dict[str, Dict[str, str]]:
    """SoftExpert read of the old open tickets with the description edited on the site; the screen and "Atualizar" share it."""
    antigos = sebrae_novos.ler_antigos(sebrae_novos.caminho_antigos(services.caminhos()))
    return sebrae_novos.aplicar_descricoes_antigos(antigos, fin.descricoes_editadas(pasta_estado(services))) if antigos else {}


def nao_encontrados(services: SebraeDashboardServices, antigos: Mapping[str, Mapping[str, str]]) -> set:
    """Old tickets missing from SoftExpert's task center on the last read and absent from the cached read (one rule for the screen badge and the 422)."""
    lidos = set((sebrae_novos.ler_resultado_antigos(services.caminhos()) or {}).get("nao_encontrados") or [])
    return {str(n) for n in lidos} - set(antigos)


def automaticos_dos_abertos(
    services: SebraeDashboardServices, abertos: Sequence[Mapping[str, Any]], antigos: Mapping[str, Mapping[str, str]], registros: Sequence[Mapping[str, Any]],
    relatorio: Optional[Mapping[str, Any]], indice: Optional[Mapping[str, Any]],
) -> Dict[str, Dict[str, str]]:
    """What "Atualizar Dashboard" fills in the old open rows: G, H and I from the SoftExpert read, then E, K, L and N
    from the name cross-reference fed by that same read (screen and write use this one function).

    ``relatorio`` and ``indice`` are read once by the caller and shared with ``os_novas_dos_abertos``."""
    efetivos = sebrae_novos.complementar_antigos(abertos, antigos)
    cruzados = sebrae_novos.preenchimentos(
        efetivos, registros, relatorio, services.vinculos_os(), indice, sebrae_os_recusadas.ler_ou_vazio(pasta_estado(services)),
    )
    lidos = sebrae_novos.preenchimentos_softexpert(abertos, antigos)
    return {n: {**lidos.get(n, {}), **cruzados.get(n, {})} for n in {*lidos, *cruzados}}


def os_novas_dos_abertos(
    services: SebraeDashboardServices, abertos: Sequence[Mapping[str, Any]], antigos: Mapping[str, Mapping[str, str]], registros: Sequence[Mapping[str, Any]],
    automaticos: Mapping[str, Mapping[str, str]], relatorio: Optional[Mapping[str, Any]], indice: Optional[Mapping[str, Any]],
) -> Dict[str, Dict[str, Any]]:
    """``{numero: sugestão de OS nova}`` dos antigos em aberto (``sebrae_os_nova``); a tela e a gravação usam esta função.

    A série (K) é a da planilha ou a que o cruzamento por nome acabou de achar; a E é só a da planilha (mais o vínculo
    manual, dentro do domínio). Registro de recusas ilegível: nenhuma sugestão, nunca uma troca às cegas. Falha de
    cálculo não derruba o F5; o log leva só o tipo do erro (sem nome, OS nem texto)."""
    if not abertos:
        return {}
    efetivos = [
        {**e, "automaticos": {
            **(e.get("automaticos") or {}),
            "K": str((e.get("automaticos") or {}).get("K") or "").strip() or str(automaticos.get(str(e.get("numero")), {}).get("K") or "").strip(),
        }}
        for e in sebrae_novos.complementar_antigos(abertos, antigos)
    ]
    try:
        return sebrae_os_nova.os_novas(
            efetivos, relatorio, list(services.vinculos_os()), sebrae_os_recusadas.ler(pasta_estado(services)), registros, indice,
            sebrae_os_recusadas.mantidas(pasta_estado(services)),
        )
    except DomainBusyError as erro:
        logger.warning("OS nova sugerida indisponível (%s).", type(erro).__name__)
    except Exception as erro:  # noqa: BLE001 - a sugestão é só auxílio; o F5 segue sem ela
        logger.warning("Falha ao calcular a OS nova sugerida (%s).", type(erro).__name__)
    return {}


def limpar_e_dos_abertos(services: SebraeDashboardServices, abertos: Sequence[Mapping[str, Any]], trocas: Mapping[str, str]) -> Dict[str, str]:
    """E que o usuário mandou Remover e que ainda são essa OS (``sebrae_os_nova.limpar_e``); registro ilegível: nada é limpo."""
    try:
        removidas = sebrae_os_recusadas.removidas(pasta_estado(services))
    except DomainBusyError:
        return {}
    return sebrae_os_nova.limpar_e(abertos, removidas, list(services.vinculos_os()), trocas)


def sugestoes_antigo(aberto: Mapping[str, Any], efetivo: Mapping[str, Any], lido: Optional[Mapping[str, str]], opcoes_a: Sequence[str]) -> Dict[str, Optional[str]]:
    """Sugestão de A e J de um chamado antigo em aberto, só para exibir (nada é gravado); campo já preenchido não é sugerido.

    Só as regras locais (``sugerir_responsavel`` e ``sugerir_tipo`` sem índice): sem IA e sem sugestão de B."""
    valores = aberto.get("valores") or {}
    textos = (efetivo.get("titulo") or (lido or {}).get("titulo"), efetivo.get("descricao"), (lido or {}).get("atendimento"), efetivo.get("usuario"))
    try:
        return {
            "sugestao_responsavel": None if str(valores.get("A") or "").strip() else sebrae_categoria.sugerir_responsavel(*textos, opcoes_a),
            "sugestao_tipo": None if str(valores.get("J") or "").strip() else sebrae_categoria.sugerir_tipo(*textos, None),
        }
    except Exception as erro:  # noqa: BLE001 - uma sugestão nunca derruba a lista; log só o tipo, nunca o texto do chamado
        logger.warning("Sugestão de A e J do chamado antigo indisponível (erro=%s).", type(erro).__name__)
        return {"sugestao_responsavel": None, "sugestao_tipo": None}


def uma_vez(leituras: Optional[Dict[str, Any]], chave: str, ler: Callable[[], Any]) -> Any:
    """Each source read at most once per response (``leituras`` lives only for that response, so nothing goes stale)."""
    if leituras is None:
        return ler()
    if chave not in leituras:
        leituras[chave] = ler()
    return leituras[chave]


def abertos_com_sugestoes(
    services: SebraeDashboardServices, abertos: Sequence[Mapping[str, Any]], observacoes: Optional[Mapping[str, Mapping[str, str]]] = None, opcoes_a: Sequence[str] = (),
    leituras: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """Old open tickets plus what "Atualizar Dashboard" would fill into their empty E, K, L and N.

    An old ticket already read from SoftExpert (rotina ``antigos``) gets the same cross-reference as a new one:
    its description and requester fill the Dashboard's empty H and I for the name lookup (the API keeps both as they are)."""
    antigos = leitura_antigos(services) if abertos else {}
    # Not in SoftExpert's task center on the last read (e.g. closed by another technician): the F5 card is tinted to check later.
    ausentes = nao_encontrados(services, antigos) if abertos else set()
    efetivos = sebrae_novos.complementar_antigos(abertos, antigos)
    registros = uma_vez(leituras, "registros", services.registros) if abertos else []
    relatorio_lido, indice = (uma_vez(leituras, "relatorio", lambda: relatorio(services)), indice_endpoint(services)) if abertos else (None, None)
    sugestoes = automaticos_dos_abertos(services, abertos, antigos, registros, relatorio_lido, indice) if abertos else {}
    os_novas = os_novas_dos_abertos(services, abertos, antigos, registros, sugestoes, relatorio_lido, indice)
    finalizacao = fin.ler_estado(pasta_estado(services)) if abertos else {}
    obs_map = observacoes if observacoes is not None else (obs.ler_observacoes(pasta_estado(services)) if abertos else {})
    apelidos = uma_vez(leituras, "apelidos", services.apelidos) if abertos else {}
    com_senha = sebrae_credenciais.numeros(pasta_estado(services)) if abertos else frozenset()
    return [
        {**a, "automaticos_sugeridos": sugestoes.get(str(a.get("numero")), {}),
         "apelido": apelido(apelidos, (a.get("automaticos") or {}).get("K") or sugestoes.get(str(a.get("numero")), {}).get("K")),
         **sebrae_cruzamento.avisos_de_nome(e.get("descricao"), e.get("usuario"), registros),
         "softexpert": fin.publico(finalizacao.get(str(a.get("numero")))),
         "leitura_softexpert": antigos.get(str(a.get("numero"))),
         "nao_encontrado_softexpert": str(a.get("numero")) in ausentes,
         "tem_credencial": str(a.get("numero")) in com_senha,  # only the flag; the value needs the click (GET .../credenciais)
         "observacao": obs_map.get(str(a.get("numero") or ""), {}).get("observacao", ""),
         "destaque": destacado(obs_map, a.get("numero")),
         **os_nova_e_sem_relacao(os_novas.get(str(a.get("numero")))),  # ``softexpert`` is the finalization state; this is the read data
         **sugestoes_antigo(a, e, antigos.get(str(a.get("numero"))), opcoes_a)}
        for a, e in zip(abertos, efetivos)
    ]


def os_nova_e_sem_relacao(sugestao: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """``sem_relacao`` goes to its own key: the current F5 screen reads ``os_nova.nova`` and would break on it."""
    if sugestao and sugestao.get("tipo") == "sem_relacao":
        return {"os_nova": None, "os_sem_relacao": sugestao}
    return {"os_nova": sugestao, "os_sem_relacao": None}


def destacado(observacoes: Mapping[str, Mapping[str, Any]], numero: Any) -> bool:
    return bool(observacoes.get(str(numero or ""), {}).get("destaque"))


def apelido(apelidos: Mapping[str, str], serie: Any) -> str:
    return apelidos.get(str(serie or "").strip().upper(), "")


def sugestoes_categoria(
    linha: Mapping[str, Any], opcoes: Sequence[str], indice: Optional[Mapping[str, Any]],
    sugestor: Optional[sebrae_categoria_ia.SugestorIA] = None, opcoes_a: Sequence[str] = (),
) -> Dict[str, Optional[str]]:
    """Sugestão de A, B e J de um chamado novo, só para exibir (nada é gravado); campo já preenchido não é sugerido.

    A (Responsável) vem só das regras locais (``sugerir_responsavel``): CLIENTE para usuário, acesso e software,
    SIMPRESS para defeito de hardware; nunca vai à IA.

    Com ``sugestor`` (IA opcional, desligada por padrão) só os chamados que ficaram em OUTRO são enviados, e a IA só
    troca OUTRO por outra categoria válida; o J da IA vale só se as regras locais não deram J.
    """
    a_atual, b_atual, j_atual = (str(linha.get(letra) or "").strip() for letra in ("A", "B", "J"))
    textos = (linha.get("G"), linha.get("H"), linha.get("F"), linha.get("I"))  # título, descrição, atendimento, solicitante
    try:
        responsavel = None if a_atual else sebrae_categoria.sugerir_responsavel(*textos, opcoes_a)
        categoria = None if b_atual else sebrae_categoria.sugerir(*textos, opcoes, indice)
        tipo = None if j_atual else sebrae_categoria.sugerir_tipo(*textos, indice, categoria=b_atual or categoria)
        sem_sinal = categoria is None or sebrae_categoria.normalizar(categoria) == "outro"
        if sugestor is not None and not b_atual and not j_atual and sem_sinal and not e_solicitante_sistema(textos[3]):
            resposta = sugestor.sugerir(textos[0], textos[1], textos[2], opcoes)
            if resposta is not None:
                if sebrae_categoria.normalizar(resposta.categoria) != "outro":
                    categoria = resposta.categoria
                tipo = tipo or resposta.tipo
        return {"sugestao_responsavel": responsavel, "sugestao_categoria": categoria, "sugestao_tipo": tipo}
    except Exception as erro:  # noqa: BLE001 - uma sugestão nunca derruba a tela; log só o tipo, nunca o texto do chamado
        logger.warning("Sugestão de categoria indisponível (erro=%s).", type(erro).__name__)
        return {"sugestao_responsavel": None, "sugestao_categoria": None, "sugestao_tipo": None}


def novos(services: SebraeDashboardServices, caminhos: sebrae_novos.Caminhos, lancados: Iterable[str]) -> Optional[Dict[str, Any]]:
    """Chamados novos da última busca já com a descrição que o usuário editou no site (lápis do cartão)."""
    novos = sebrae_novos.ler_novos(caminhos.novos, lancados)
    if novos is not None:
        novos["chamados"] = sebrae_novos.aplicar_descricoes_novos(novos["chamados"], fin.descricoes_editadas(pasta_estado(services)))
    return novos


def estado(services: SebraeDashboardServices, nomes_pessoas: Callable[[], List[Any]], ia: bool = True) -> Dict[str, Any]:
    corpo = estado_base(services, nomes_pessoas, ia)
    # só aparecem quando existem: a tela vazia continua {"importado": None, "novos": None}
    resultado = fin.ler_resultado(pasta_estado(services))
    if resultado is not None:
        corpo["fechar"] = resultado
    pendente = fin.aviso_do_pendente(pasta_estado(services))
    if pendente is not None:
        corpo["sharepoint"] = pendente
    return corpo


def sugestor_ia(nomes_pessoas: Callable[[], List[Any]], novos: Mapping[str, Any], importado: Optional[Mapping[str, Any]] = None) -> Optional[sebrae_categoria_ia.SugestorIA]:
    """Sugestor por IA desta resposta (None com a chave SIMPRESS_SUGESTAO_IA desligada); conhece os nomes para mascarar."""
    try:
        sugestor = sebrae_categoria_ia.criar()
        if sugestor is not None:
            sugestor.registrar_nomes(nomes_pessoas())
            sugestor.registrar_nomes([chamado.solicitante for chamado in novos["chamados"]])
            sugestor.registrar_nomes([linha.get("usuario") for linha in (importado or {}).get("abertos", [])])
        return sugestor
    except Exception as erro:  # noqa: BLE001 - the optional AI never breaks the list; log only the class, never ticket data
        logger.warning("Sugestão de categoria por IA indisponível (erro=%s).", type(erro).__name__)
        return None


def estado_base(services: SebraeDashboardServices, nomes_pessoas: Callable[[], List[Any]], ia: bool = True) -> Dict[str, Any]:
    caminhos = services.caminhos()
    importado = sebrae_novos.ler_existentes(caminhos.existentes)
    lancados = importado["numeros"] if importado else frozenset()
    novos_lidos = novos(services, caminhos, lancados) if importado else None
    pasta = pasta_estado(services)
    finalizacao = fin.ler_estado(pasta) if (novos_lidos or importado) else {}
    observacoes = obs.ler_observacoes(pasta) if (novos_lidos or importado) else {}
    com_senha = sebrae_credenciais.numeros(pasta) if novos_lidos else frozenset()
    leituras: Dict[str, Any] = {}
    apelidos = uma_vez(leituras, "apelidos", services.apelidos) if novos_lidos else {}
    indice_categoria = sebrae_categoria.carregar_indice(pasta_estado(services) / sebrae_categoria.ARQUIVO_INDICE) if novos_lidos else None  # uma leitura por resposta
    lista_b = importado["listas"].get("B", []) if importado else []
    vistas = {sebrae_categoria.normalizar(opcao) for opcao in lista_b}
    opcoes_b = [*lista_b, *(c for c in sebrae_categoria.CATEGORIAS_NOVAS if sebrae_categoria.normalizar(c) not in vistas)]
    opcoes_a = importado["listas"].get("A", []) if importado else []
    sugestor = sugestor_ia(nomes_pessoas, novos_lidos, importado) if (novos_lidos and ia) else None  # IA opcional: fora de qualquer trava de arquivo (ia=False)
    finalizados = [
        {**f, "observacao": observacoes.get(str(f.get("numero") or ""), {}).get("observacao", ""),
         "destaque": destacado(observacoes, f.get("numero"))}
        for f in fin.finalizados_no_dashboard(pasta)
    ] if importado else []
    return {
        "importado": None if importado is None else {
            "versao": importado["versao"], "arquivo": importado["arquivo"], "importado_em": importado["importado_em"], "total": len(lancados),
            "listas": importado["listas"], "abertos": abertos_com_sugestoes(services, importado["abertos"], observacoes, opcoes_a, leituras),
            "finalizados": finalizados,
            "atualizavel": sebrae_novos.ler_planilha(sebrae_novos.caminho_planilha(caminhos), importado["sha256"]) is not None,
            "saida_pronta": sebrae_novos.caminho_saida(caminhos, NOME_ATUALIZADO).is_file(),
        },
        "novos": None if novos_lidos is None else {
            "lidos_em": novos_lidos["lidos_em"], "ignorados": novos_lidos["ignorados"], "pendentes": novos_lidos["pendentes"],
            "erros": novos_lidos["erros"],
            "formulario": [
                {**item, "apelido": apelido(apelidos, item["linha"].get("K")),
                 "softexpert": fin.publico(finalizacao.get(item["numero"])),
                 "observacao": observacoes.get(item["numero"], {}).get("observacao", ""),
                 "destaque": destacado(observacoes, item["numero"]),
                 "tem_credencial": item["numero"] in com_senha,
                 **sugestoes_categoria(item["linha"], opcoes_b, indice_categoria, sugestor, opcoes_a)}
                for item in sebrae_novos.formulario(
                    novos_lidos["chamados"], uma_vez(leituras, "registros", services.registros), uma_vez(leituras, "relatorio", lambda: relatorio(services)),
                    services.vinculos_os())
            ],
        },
    }
