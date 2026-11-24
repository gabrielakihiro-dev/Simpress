"""Backups regionais: notebooks de backup livres por regional, como função pura (sem I/O nem log).

``build_backups_regionais`` recebe dados já lidos e devolve o contrato de ``backups_regionais`` do painel; a saída
não traz login nem usuário do Endpoint, mas ``apelido`` pode conter nome digitado à mão (apelido manual).

Contrato de entrada:

* ``equipamentos``: lista de dicts ou ``None`` (``None`` ou vazia = base não importada, ``fontes.cadastro=False``).
  Campos: ``serial``, ``tipo``, ``modelo``, ``retirada_cidade``, ``apelido``, ``_apelido_base``,
  ``_apelido_manual_override`` (bool), ``serie_detalhes_duplicada`` (bool).
* ``endpoint``: dict no formato de ``build_endpoint_alias_index`` mais ``manual_users`` (``{serial_key: login}``),
  ``user_holds`` (``{serial_key: {tipo, estado, usuario_atual, ...}}``) e ``verified_by_serial``. ``available: False``
  vira ``fontes.endpoint="indisponivel"``. Chaves por ``normalize_reference_value``.
* ``confirmacoes``: lista de ``{serie, cidade, confirmado_em, expira_em}`` (7 dias, ISO) ou ``{serie, cidade,
  confirmado_em, tipo, usuario_ref}`` (``tipo: "backup"``, sem prazo); ``usuario_ref`` nunca sai na saída.
* ``estado_cobertura``: estado da Cobertura ou ``None`` (ilegível: ``fontes.cobertura="ilegivel"``, sem bloqueio de
  cobertura). ``estado["disponibilidade"]`` usa a chave de ``chave_serie``.
* ``manutencao``: ``coverage.Manutencao``; ``ilegivel=True`` vira limitação e não bloqueia.
* ``agora``: datetime com fuso (naive levanta ``ValueError``). ISO sem fuso é lido no fuso de ``agora``.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional, Set, Tuple

from domains.coverage import Manutencao, chave_serie, disponibilidade_efetiva, motivo_bloqueio
from domains.effective_alias import endpoint_user_for_serial, strip_manual_alias_marker
from domains.equipment_search import categorize_equipment
from domains.inventory_comparison import SERIE_LOCAL_MAP, _parse_verification_datetime
from domains.regras_negocio import e_serie_sebrae, normalize_reference_value, usuario_e_administrador
from domains.user_holds import ACTIVE_STATES

CIDADES_PRIORITARIAS = ("Cascavel", "Londrina", "Pato Branco", "Maringá", "Ponta Grossa")
MINIMO = 1
DIAS_VERIFICACAO_RECENTE = 7

_PRIORITARIAS = {normalize_reference_value(cidade): cidade for cidade in CIDADES_PRIORITARIAS}
# Siglas e nomes de cidade normalizados; montada uma vez. Siglas vencem nomes (não há colisão no mapa real).
_TOKEN_CIDADE: Dict[str, str] = {
    **{normalize_reference_value(cidade): cidade for cidade in set(SERIE_LOCAL_MAP.values())},
    **{normalize_reference_value(sigla): cidade for sigla, cidade in SERIE_LOCAL_MAP.items()},
}
_DIGITOS = "0123456789"
_MOTIVOS_DISPONIBILIDADE = ("em_manutencao", "indisponivel")
_DATA_MINIMA = datetime.min.replace(tzinfo=timezone.utc)


def _cidades_lidas(nome: Any) -> Set[str]:
    """Cidades das leituras válidas do nome; vazio se ele não segue um formato de backup."""
    texto = normalize_reference_value(nome)
    if texto.startswith("BACKUP"):
        restos = [texto[len("BACKUP"):]]
    elif texto.startswith("PRNOTE"):
        sufixo = texto[len("PRNOTE"):]
        # PRNOTEBKPAB01 tem duas leituras: BKP+AB01 e BK+PAB01; só vale a que o resto iguala um token.
        restos = [sufixo[len(forma):] for forma in ("BACKUP", "BKP", "BK") if sufixo.startswith(forma)]
    else:
        return set()
    return {cidade for resto in restos if (cidade := _TOKEN_CIDADE.get(resto.rstrip(_DIGITOS)))}


def _classificar(cidades: Set[str], cidade_cadastro: Any) -> Tuple[Optional[str], Optional[str]]:
    if not cidades:
        return None, None
    if len(cidades) > 1:
        return None, "leitura_ambigua"
    lida = next(iter(cidades))
    esperada = normalize_reference_value(cidade_cadastro)
    if not esperada:
        return lida, "cidade_ausente"
    if normalize_reference_value(lida) != esperada:
        return lida, "cidade_divergente"
    return lida, None


def identificar_marca(nome: Any, cidade_cadastro: Any) -> Tuple[Optional[str], Optional[str]]:
    """Cidade lida do nome e o problema: ``(cidade, None)`` válida, ``(cidade, "cidade_divergente"|"cidade_ausente")``,
    ``(None, "leitura_ambigua")`` ou ``(None, None)`` quando o nome não é de backup."""
    return _classificar(_cidades_lidas(nome), cidade_cadastro)


def _marca_do_item(item: Mapping[str, Any], chave: str, endpoint: Mapping[str, Any]) -> Tuple[str, Optional[str], Optional[str]]:
    """``(apelido, cidade_lida, motivo)`` do item. Apelido manual (sem ``(M)``) vale sozinho, mesmo sem marca."""
    if item.get("_apelido_manual_override"):
        nome = strip_manual_alias_marker(item.get("apelido"))
        return (nome, *identificar_marca(nome, item.get("retirada_cidade")))
    nomes = [str(item.get("_apelido_base") or ""), str(endpoint.get("unique", {}).get(chave) or "")]
    lidas = [(nome, _cidades_lidas(nome)) for nome in nomes]
    cidades: Set[str] = set()
    for _, lidas_do_nome in lidas:
        cidades |= lidas_do_nome
    usado = next((nome for nome, cidades in lidas if cidades), "") or str(item.get("apelido") or "")
    return (usado, *_classificar(cidades, item.get("retirada_cidade")))


def _bloqueio(estado: Optional[Mapping[str, Any]], serie: str, hoje: Any, manutencao: Manutencao) -> Optional[str]:
    """Motivo que tira a série do cálculo; ``sem_disponibilidade`` só vale se a disponibilidade a bloqueia."""
    estado = estado if estado is not None else {}  # Cobertura ilegível: só a manutenção ainda bloqueia
    bloqueio = motivo_bloqueio(estado, serie, hoje, manutencao)
    if bloqueio is None:
        return None
    if bloqueio["motivo"] != "sem_disponibilidade":
        return bloqueio["motivo"]
    situacao = disponibilidade_efetiva(estado.get("disponibilidade", {}).get(chave_serie(serie)), hoje)
    return situacao if situacao in _MOTIVOS_DISPONIBILIDADE else None


_SUFIXO_HORARIO = re.compile(r"Hor[aá]rio\s+da\s+[uú]ltima[^:,;]*:[^,;]*,\s*\d{4}[^,;/]*", re.IGNORECASE)


def normalizar_usuario_endpoint(valor: Any) -> str:
    """Usuários do Endpoint (lista, sufixo `Horário da última...`, domínio, `@...`, acento, caixa, Administrador) em texto único e estável."""
    nomes = set()
    # A data do sufixo (`out 22, 2026 12:21 PM`) tem vírgula: sai antes de dividir a lista.
    texto = _SUFIXO_HORARIO.sub("", str(valor or ""))
    for parte in re.split(r",|;| / ", texto):
        if usuario_e_administrador(parte):
            continue
        sem_acento = "".join(c for c in unicodedata.normalize("NFKD", parte) if not unicodedata.combining(c)).casefold()
        nome = sem_acento.split("horario da ultima")[0].rsplit("\\", 1)[-1].split("@", 1)[0].strip()
        if nome:
            nomes.add(nome)
    return ",".join(sorted(nomes))


def usuario_ref(valor: Any) -> str:
    """Pseudônimo do usuário (hash sem segredo, não é anonimização); `""` sem usuário ou com Administrador."""
    normalizado = normalizar_usuario_endpoint(valor)
    return "sha256:" + hashlib.sha256(normalizado.encode("utf-8")).hexdigest() if normalizado else ""


def _confirmacoes_por_serie(confirmacoes: Optional[Iterable[Any]], agora: datetime) -> Dict[str, List[Dict[str, Any]]]:
    """Confirmações agrupadas por série; 7 dias com ``expira`` ilegível vale como expirada, ``backup`` não tem prazo."""
    resultado: Dict[str, List[Dict[str, Any]]] = {}
    for confirmacao in confirmacoes or []:
        if not isinstance(confirmacao, Mapping):
            continue
        chave = normalize_reference_value(confirmacao.get("serie"))
        if not chave:
            continue
        tipo = "backup" if confirmacao.get("tipo") == "backup" else "7_dias"
        expira = None if tipo == "backup" else _parse_verification_datetime(confirmacao.get("expira_em"), agora.tzinfo)
        resultado.setdefault(chave, []).append({
            "cidade": confirmacao.get("cidade"), "expira": expira, "tipo": tipo,
            "usuario_ref": str(confirmacao.get("usuario_ref") or ""),
        })
    return resultado


def _confirmacao_da_serie(lista: List[Dict[str, Any]], cidade_cadastro: str) -> Optional[Dict[str, Any]]:
    """A da cidade atual do cadastro vence; depois, a de maior validade (uma de outra cidade não esconde a atual)."""
    cidade = normalize_reference_value(cidade_cadastro)
    return max(
        lista,
        key=lambda c: (
            normalize_reference_value(c["cidade"]) == cidade, c["tipo"] == "backup", c["expira"] is not None, c["expira"] or _DATA_MINIMA,
        ),
        default=None,
    )


def _destino(cidade_cadastro: str, cidade_lida: Optional[str], motivo: Optional[str]) -> Tuple[str, str]:
    """``(chave, nome)`` da regional do item; vazio se ela não puder ser definida."""
    if cidade_cadastro:
        chave = normalize_reference_value(cidade_cadastro)
        return chave, _PRIORITARIAS.get(chave, cidade_cadastro)
    # Cadastro sem cidade: o item só aparece (em conferência) na prioritária que o nome indica.
    if motivo == "cidade_ausente" and cidade_lida:
        chave = normalize_reference_value(cidade_lida)
        if chave in _PRIORITARIAS:
            return chave, _PRIORITARIAS[chave]
    return "", ""


def build_backups_regionais(
    equipamentos: Optional[Iterable[Mapping[str, Any]]],
    endpoint: Optional[Mapping[str, Any]],
    confirmacoes: Optional[Iterable[Any]],
    estado_cobertura: Optional[Mapping[str, Any]],
    manutencao: Manutencao,
    agora: datetime,
) -> Dict[str, Any]:
    """Calcula ``backups_regionais`` (ver o contrato de entrada no docstring do módulo)."""
    if agora.tzinfo is None or agora.utcoffset() is None:
        raise ValueError("agora precisa ter fuso horário")
    hoje = agora.date()
    endpoint = dict(endpoint or {})
    endpoint_ok = bool(endpoint.get("available"))
    itens = [item for item in (equipamentos or []) if isinstance(item, Mapping)]
    fontes = {
        "cadastro": bool(itens),
        "endpoint": "ok" if endpoint_ok else "indisponivel",
        "cobertura": "ok" if estado_cobertura is not None else "ilegivel",
        "manutencao_verificada": not manutencao.ilegivel,
    }
    confirmadas = _confirmacoes_por_serie(confirmacoes, agora)
    verificacoes = endpoint.get("verified_by_serial") or {}
    grupos: Dict[str, Dict[str, Any]] = {
        chave: {"cidade": cidade, "backups": [], "candidatos": [], "conferencia": [], "excluidos": []}
        for chave, cidade in _PRIORITARIAS.items()
    }

    for item in sorted(itens, key=lambda i: normalize_reference_value(i.get("serial"))):
        serie = str(item.get("serial") or "").strip()
        chave = normalize_reference_value(serie)
        if not chave or e_serie_sebrae(serie) or categorize_equipment(item.get("tipo"), item.get("modelo")) != "notebook":
            continue
        cidade_cadastro = str(item.get("retirada_cidade") or "").strip()
        apelido, cidade_lida, motivo_marca = _marca_do_item(item, chave, endpoint)
        chave_cidade, nome_cidade = _destino(cidade_cadastro, cidade_lida, motivo_marca)
        if not chave_cidade:
            continue
        grupo = grupos.setdefault(
            chave_cidade,
            {"cidade": nome_cidade, "backups": [], "candidatos": [], "conferencia": [], "excluidos": []},
        )

        # Endpoint: presença, verificação e usuário vigente.
        presente = endpoint_ok and any(chave in endpoint.get(origem, {}) for origem in ("unique", "blank_hostnames", "duplicates"))
        verificacao = _parse_verification_datetime(verificacoes.get(chave), agora.tzinfo) if endpoint_ok else None
        dias = (agora - verificacao).days if verificacao is not None else None
        recente = presente and dias is not None and dias < DIAS_VERIFICACAO_RECENTE
        usuario_manual = str(endpoint.get("manual_users", {}).get(chave) or "").strip()
        trava = endpoint.get("user_holds", {}).get(chave) or {}
        trava_ativa = bool(str(trava.get("usuario_atual") or "").strip()) and trava.get("estado") in ACTIVE_STATES.get(
            str(trava.get("tipo")), ()
        )
        usuario_atual = endpoint_user_for_serial(endpoint, chave).strip() if presente else ""
        usuario_pleno = bool(usuario_manual) or trava_ativa or (recente and bool(usuario_atual))
        usuario_firme = bool(usuario_manual) or trava_ativa  # confirmação nova ignora o usuário recente do Endpoint
        usuario_vigente = usuario_pleno
        bloqueio = _bloqueio(estado_cobertura, serie, hoje, manutencao)
        duplicada = bool(item.get("serie_detalhes_duplicada")) or chave in endpoint.get("duplicates", {})

        # Confirmação manual: vigente só sem nenhum dos motivos abaixo (a invalidada só aparece, nada é apagado).
        confirmacao_vigente: Optional[Dict[str, Any]] = None
        confirmacao_invalidada: Optional[Dict[str, Any]] = None
        confirmada = _confirmacao_da_serie(confirmadas.get(chave, []), cidade_cadastro)
        if confirmada is not None:
            expira = confirmada["expira"]
            nova = confirmada["tipo"] == "backup"
            ref_atual = usuario_ref(usuario_atual)
            usuario_mudou = nova and presente and bool(ref_atual) and ref_atual != confirmada["usuario_ref"]
            motivo_invalida = (
                "expirada" if not nova and (expira is None or agora >= expira)
                else "cidade_mudou" if normalize_reference_value(confirmada["cidade"]) != normalize_reference_value(cidade_cadastro)
                else "usuario_vigente" if (usuario_firme if nova else usuario_pleno)
                else "usuario_mudou" if usuario_mudou
                else "bloqueio" if bloqueio
                else None
            )
            if motivo_invalida:
                confirmacao_invalidada = {"estado": "invalidada", "motivo": motivo_invalida}
            else:
                confirmacao_vigente = {
                    "estado": "vigente", "tipo": confirmada["tipo"], "expira_em": expira.isoformat() if expira else None,
                }
                usuario_vigente = usuario_firme if nova else usuario_pleno

        marca_valida = bool(cidade_lida) and motivo_marca is None
        mudou = bool(confirmacao_invalidada) and confirmacao_invalidada["motivo"] == "usuario_mudou"
        if usuario_vigente or bloqueio or mudou:
            excluido: Dict[str, Any] = {
                "serie": serie,
                "motivo": "usuario_mudou" if mudou else "usuario_vigente" if usuario_vigente else f"bloqueio:{bloqueio}",
            }
            if confirmacao_invalidada:
                excluido["confirmacao"] = confirmacao_invalidada
            grupo["excluidos"].append(excluido)
        elif duplicada or motivo_marca:
            grupo["conferencia"].append(
                {
                    "serie": serie, "apelido": apelido, "motivo": "serie_duplicada" if duplicada else motivo_marca,
                    # Confirmação gravada continua desfazível mesmo sem contar aqui.
                    "confirmacao": confirmacao_vigente or confirmacao_invalidada,
                }
            )
        elif (marca_valida and recente) or confirmacao_vigente:
            por_marca = marca_valida and recente
            grupo["backups"].append({
                "serie": serie,
                "apelido": apelido,
                "origem": "marca" if por_marca else "confirmacao",
                "ultima_verificacao": verificacao.isoformat() if verificacao is not None and presente else None,
                # Com marca e confirmação, a origem é a marca, mas a confirmação continua visível (e desfazível).
                "confirmado_ate": confirmacao_vigente["expira_em"] if confirmacao_vigente else None,
                "confirmacao": confirmacao_vigente,
            })
        else:
            grupo["candidatos"].append({
                "serie": serie,
                "apelido": apelido,
                "motivo": (
                    "fonte_endpoint_indisponivel" if not endpoint_ok
                    else "ausente_no_endpoint" if not presente
                    else "sem_verificacao_7_dias" if not recente
                    else "encontrado_sem_usuario"
                ),
                "ultima_verificacao": verificacao.isoformat() if verificacao is not None and presente else None,
                "dias_sem_verificacao": dias if verificacao is not None and presente else None,
                "confirmacao": confirmacao_invalidada,
            })

    completo = fontes["cadastro"] and endpoint_ok and estado_cobertura is not None and not manutencao.ilegivel
    prioritarias: List[Dict[str, Any]] = []
    pendencias: Dict[str, List[str]] = {"sem_backup": [], "conferir": []}
    for chave, cidade in _PRIORITARIAS.items():
        grupo = grupos[chave]
        grupo["backups"].sort(key=lambda backup: backup["origem"] != "marca")  # estável: marca antes de confirmação
        contados = len(grupo["backups"])
        status = (
            "ok" if contados >= MINIMO
            else "conferir" if grupo["candidatos"]
            else "sem_backup" if completo
            else "dados_insuficientes"
        )
        if status in pendencias:
            pendencias[status].append(cidade)
        prioritarias.append({
            "cidade": cidade, "status": status, "contados": contados, "minimo": MINIMO,
            "excedente": max(0, contados - MINIMO),
            "backups": grupo["backups"], "candidatos": grupo["candidatos"],
            "conferencia": grupo["conferencia"], "excluidos": grupo["excluidos"],
        })

    sobras: List[Dict[str, Any]] = []
    outras_candidatos: List[Dict[str, Any]] = []
    for chave, grupo in grupos.items():
        # ``itens`` acompanha ``series`` (mesma ordem) e diz como cada série contou e se tem confirmação vigente; sem ``apelido``.
        itens_sobra = [{k: backup[k] for k in ("serie", "origem", "confirmado_ate", "confirmacao")} for backup in grupo["backups"]]
        series = [item["serie"] for item in itens_sobra]
        if chave in _PRIORITARIAS:
            if len(series) > MINIMO:
                sobras.append({
                    "cidade": grupo["cidade"], "quantidade": len(series) - MINIMO, "series": series[MINIMO:],
                    "itens": itens_sobra[MINIMO:], "prioritaria": True,
                })
            continue
        if series:
            sobras.append({
                "cidade": grupo["cidade"], "quantidade": len(series), "series": series, "itens": itens_sobra,
                "prioritaria": False,
            })
        if grupo["candidatos"]:
            outras_candidatos.append({"cidade": grupo["cidade"], "candidatos": grupo["candidatos"]})

    def por_cidade(entrada: Mapping[str, Any]) -> str:
        return normalize_reference_value(entrada["cidade"])

    limitacoes = [
        texto for ativa, texto in (
            (not fontes["cadastro"], "Base de equipamentos não importada: dados insuficientes."),
            (not endpoint_ok, "Endpoint indisponível: uso recente não conferido."),
            (estado_cobertura is None, "Cobertura ilegível: reservas e movimentações não conferidas."),
            (manutencao.ilegivel, "Manutenção não verificada: dados insuficientes."),
        ) if ativa
    ]
    return {
        "gerado_em": agora.isoformat(),
        "minimo": MINIMO,
        "fontes": fontes,
        "limitacoes": limitacoes,
        "prioritarias": prioritarias,
        "sobras": sorted(sobras, key=por_cidade),
        "outras_candidatos": sorted(outras_candidatos, key=por_cidade),
        "pendencias": pendencias,
    }
