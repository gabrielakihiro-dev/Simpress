"""Backups regionais (Resumo F3): confirmar e desfazer manualmente um backup por série e cidade.

Manter e Excluir (só para confirmação com ``decisao_pendente``: apelido manual e usuário real novo no Endpoint; senão 409
``sem_decisao_pendente``): Manter regrava a confirmação com o usuário atual e registra a decisão; Excluir remove antes o
apelido manual (``remover_apelido_manual``; erro dele vira 409 ou o status dele com `apelido_nao_removido`, e nada mais é gravado) e depois a confirmação, registrando a decisão.

Cálculo em ``domains/backups_regionais.py``; gravação em ``domains/backups_regionais_store.py``
(``AtomicFileTransaction``, sem lock Python). Nada aqui grava em ``EquipamentosDetalhes`` nem em sistemas externos.

Confirmar só aceita a série que o cálculo atual mostra naquela cidade como candidata ou já contada (por marca ou por
confirmação); repetir com confirmação nova com o mesmo usuário não muda nada (``repetido: true``). Sem Endpoint → 409 ``endpoint_indisponivel``. Erros:
``HTTPException`` com ``detail = {"codigo", "mensagem"}``. Arquivo ocupado ou falha passageira de leitura (``OSError``)
→ 409 ``arquivo_ocupado``; estado ilegível → 503 ``estado_ilegível`` (o arquivo é preservado); série fora do
cálculo → 422 ``serie_nao_elegivel``; falha de gravação → 500 ``falha_gravacao``.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Mapping, NoReturn, Optional, Tuple

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from core.errors import DomainError
from core.integrity import FileBusyError, FileTransactionError
from domains import backups_regionais_store as store_mod
from domains.backups_regionais import build_backups_regionais, usuario_ref
from domains.backups_regionais_store import BackupsRegionaisStore, EstadoIlegivel, eh_ilegivel
from domains.coverage import Manutencao
from domains.effective_alias import endpoint_user_for_serial
from domains.regras_negocio import normalize_reference_value

logger = logging.getLogger(__name__)

MENSAGEM_ILEGIVEL = "As confirmações de backup estão ilegíveis; os dados foram preservados e nada foi gravado."
LIMITACAO_CONFIRMACOES = "Confirmações de backup ilegíveis: backups confirmados à mão não foram contados."
LIMITACAO_CONFIRMACOES_INDISPONIVEIS = (
    "Confirmações de backup indisponíveis no momento: backups confirmados à mão não foram contados."
)


@dataclass(frozen=True)
class BackupsRegionaisServices:
    state_file: Callable[[], Path]
    transaction_root: Callable[[], Path]
    # Entradas do cálculo, todas só leitura (ver o contrato em domains/backups_regionais.py).
    equipamentos: Callable[[], Optional[Iterable[Mapping[str, Any]]]]
    endpoint: Callable[[], Optional[Mapping[str, Any]]]
    estado_cobertura: Callable[[], Optional[Mapping[str, Any]]]
    manutencao: Callable[[], Manutencao]
    agora: Callable[[], datetime] = lambda: datetime.now().astimezone()
    # Séries com apelido manual (só leitura) e remoção desse apelido (escrita do módulo de apelidos); ver Excluir.
    series_apelido_manual: Callable[[], Iterable[str]] = lambda: ()
    remover_apelido_manual: Optional[Callable[[str], Any]] = None


class ConfirmacaoPayload(BaseModel):
    model_config = {"extra": "forbid"}

    serie: str = Field(min_length=1, max_length=60)
    cidade: str = Field(min_length=1, max_length=80)


def _falhar(error: BaseException) -> NoReturn:
    if isinstance(error, FileBusyError):
        raise HTTPException(status_code=409, detail={
            "codigo": "arquivo_ocupado", "mensagem": "O arquivo de backups está ocupado. Tente de novo.",
        }) from error
    if eh_ilegivel(error):
        raise HTTPException(status_code=503, detail={"codigo": "estado_ilegível", "mensagem": MENSAGEM_ILEGIVEL}) from error
    # O texto da exceção pode ter caminho local: fica só no log do servidor.
    logger.error("Falha ao gravar as confirmações de backup.", exc_info=error)
    raise HTTPException(status_code=500, detail={
        "codigo": "falha_gravacao", "mensagem": "Não foi possível salvar a confirmação. Tente de novo; se o erro continuar, avise o suporte.",
    }) from error


def _entrada_tolerante(descricao: str, ler: Callable[[], Any], padrao: Any) -> Any:
    """Uma entrada do cálculo; qualquer falha vira ``padrao``. Só a classe do erro vai ao log (sem caminho nem dado)."""
    try:
        return ler()
    except Exception as error:
        logger.warning("Falha ao ler %s dos Backups regionais: %s.", descricao, type(error).__name__)
        return padrao


def _entradas(services: BackupsRegionaisServices) -> Tuple[Any, Any, Any, Manutencao]:
    """Cadastro, Endpoint, Cobertura e manutenção, cada um isolado: o painel e a rota de confirmar leem igual."""
    endpoint = _entrada_tolerante("o Endpoint", services.endpoint, {"available": False})
    manuais = _entrada_tolerante("os apelidos manuais", lambda: set(services.series_apelido_manual()), set())
    if isinstance(endpoint, Mapping):
        endpoint = {**endpoint, "series_apelido_manual": manuais}
    return (
        _entrada_tolerante("o cadastro", services.equipamentos, None),
        endpoint,
        _entrada_tolerante("a Cobertura", services.estado_cobertura, None),
        _entrada_tolerante("a manutenção", services.manutencao, Manutencao(ilegivel=True)),
    )


def ler_painel_backups(services: BackupsRegionaisServices) -> Dict[str, Any]:
    """``backups_regionais`` do ``/api/painel``: o mesmo cálculo da rota de confirmar, só leitura e independente do histórico.

    Cada entrada é isolada: Endpoint com falha vira ``{"available": False}``; cobertura, cadastro e confirmações ilegíveis
    viram ``None``/``[]``; manutenção com falha vira ``Manutencao(ilegivel=True)``. Nenhuma delas derruba o painel.
    ``fontes["confirmacoes"]`` (``ok``, ``ilegivel`` ou ``indisponivel`` para falha passageira de leitura) e a
    limitação em pt-BR dizem se as confirmações manuais puderam ser lidas.
    """
    agora = services.agora()
    equipamentos, endpoint, cobertura, manutencao = _entradas(services)
    fonte, confirmacoes = "ok", []
    try:
        confirmacoes = BackupsRegionaisStore(services.state_file(), services.transaction_root()).ler()["confirmacoes"]
    except Exception as error:  # só a classe vai ao log (sem caminho nem dado)
        fonte = "ilegivel" if isinstance(error, EstadoIlegivel) else "indisponivel"
        logger.warning("Falha ao ler as confirmações dos Backups regionais: %s.", type(error).__name__)
    resultado = build_backups_regionais(equipamentos, endpoint, confirmacoes, cobertura, manutencao, agora)
    resultado["fontes"]["confirmacoes"] = fonte
    if fonte != "ok":
        resultado["limitacoes"].append(
            LIMITACAO_CONFIRMACOES if fonte == "ilegivel" else LIMITACAO_CONFIRMACOES_INDISPONIVEIS
        )
    return resultado


def _pendente(calculo: Mapping[str, Any], serie: str, cidade: str) -> Optional[Tuple[str, str]]:
    """``(serie, cidade)`` do item com ``decisao_pendente`` naquela série e cidade, ou ``None``."""
    chave_serie, chave_cidade = normalize_reference_value(serie), normalize_reference_value(cidade)
    itens = [
        (g["cidade"], item) for g in calculo.get("prioritarias", []) for item in (*g["backups"], *g["conferencia"])
    ] + [(g["cidade"], item) for g in calculo.get("sobras", []) for item in g["itens"]]
    for nome, item in itens:
        if (
            normalize_reference_value(item["serie"]) == chave_serie
            and normalize_reference_value(nome) == chave_cidade
            and (item.get("confirmacao") or {}).get("decisao_pendente")
        ):
            return item["serie"], nome
    return None


def series_elegiveis(calculo: Mapping[str, Any], cidade: str) -> Dict[str, Tuple[str, str]]:
    """``{serie_normalizada: (serie, cidade)}`` que o cálculo mostra na cidade como candidata ou já contada."""
    chave_cidade = normalize_reference_value(cidade)
    grupos = [
        (g["cidade"], [*g["candidatos"], *g["backups"]]) for g in calculo.get("prioritarias", [])
    ] + [
        (g["cidade"], g["candidatos"]) for g in calculo.get("outras_candidatos", [])
    ] + [
        (g["cidade"], [{"serie": s} for s in g["series"]]) for g in calculo.get("sobras", []) if not g.get("prioritaria")
    ]
    return {
        normalize_reference_value(item["serie"]): (item["serie"], nome)
        for nome, itens in grupos if normalize_reference_value(nome) == chave_cidade
        for item in itens
    }


def create_backups_regionais_router(services: BackupsRegionaisServices) -> APIRouter:
    router = APIRouter()

    def store() -> BackupsRegionaisStore:
        return BackupsRegionaisStore(services.state_file(), services.transaction_root())

    def gravar(operacao: Callable[[store_mod.Estado], Tuple[store_mod.Estado, Any]]) -> Any:
        try:
            return store().escrever(operacao)
        except (FileBusyError, EstadoIlegivel, FileTransactionError, OSError) as error:
            _falhar(error)

    @router.post("/api/backups-regionais/confirmar")
    def confirmar(payload: ConfirmacaoPayload) -> Dict[str, Any]:
        """Confirma sem prazo, gravando só o pseudônimo do usuário do Endpoint; repetir com o mesmo usuário não muda nada."""
        agora = services.agora()
        try:
            atual = store().ler()
        except EstadoIlegivel as error:
            _falhar(error)
        except OSError as error:
            # Leitura direta presa (antivírus, sincronização): passageira, mesmo 409 do arquivo ocupado.
            _falhar(FileBusyError(type(error).__name__))
        # Endpoint e cadastro são lidos antes, fora de qualquer transação; a gravação só toca o arquivo de backups.
        # Mesma leitura tolerante do painel: o que a tela mostrou como candidato continua confirmável.
        equipamentos, endpoint, cobertura, manutencao = _entradas(services)
        calculo = build_backups_regionais(equipamentos, endpoint, atual["confirmacoes"], cobertura, manutencao, agora)
        achada = series_elegiveis(calculo, payload.cidade).get(normalize_reference_value(payload.serie))
        if achada is None:
            raise HTTPException(status_code=422, detail={
                "codigo": "serie_nao_elegivel",
                "mensagem": "Esta série não aparece como candidata a backup nesta cidade.",
            })
        serie, cidade = achada
        if _pendente(calculo, serie, cidade) is not None:
            raise HTTPException(status_code=409, detail={
                "codigo": "decisao_pendente",
                "mensagem": "Este backup tem uma decisão pendente: escolha Manter ou Excluir.",
            })
        if not (endpoint or {}).get("available"):
            # Foto vazia confundiria "usuário desconhecido" com "sem usuário".
            raise HTTPException(status_code=409, detail={
                "codigo": "endpoint_indisponivel",
                "mensagem": "O Endpoint está indisponível; não dá para confirmar o backup agora.",
            })
        ref = usuario_ref(endpoint_user_for_serial(endpoint, normalize_reference_value(serie)))
        registro, repetido = gravar(lambda estado: _confirmar(estado, serie, cidade, agora, ref))
        publico = {campo: registro[campo] for campo in ("serie", "cidade", "confirmado_em", "tipo")}  # sem usuario_ref
        return {"confirmacao": publico, "repetido": repetido}

    def pendente(payload: ConfirmacaoPayload) -> Tuple[Tuple[str, str], Mapping[str, Any], Any, str]:
        """``((serie, cidade), endpoint, agora, usuario_ref_visto)`` da decisão pendente; sem Endpoint ou sem ela, 409."""
        agora = services.agora()
        try:
            atual = store().ler()
        except EstadoIlegivel as error:
            _falhar(error)
        except OSError as error:
            _falhar(FileBusyError(type(error).__name__))
        equipamentos, endpoint, cobertura, manutencao = _entradas(services)
        if not (endpoint or {}).get("available"):
            raise HTTPException(status_code=409, detail={
                "codigo": "endpoint_indisponivel",
                "mensagem": "O Endpoint está indisponível; não dá para decidir sobre o backup agora.",
            })
        calculo = build_backups_regionais(equipamentos, endpoint, atual["confirmacoes"], cobertura, manutencao, agora)
        achada = _pendente(calculo, payload.serie, payload.cidade)
        if achada is None:
            raise HTTPException(status_code=409, detail={
                "codigo": "sem_decisao_pendente", "mensagem": "Este backup não tem decisão pendente.",
            })
        visto = next((r for r in atual["confirmacoes"] if store_mod._mesma(r, *achada)), None)
        return achada, endpoint, agora, str((visto or {}).get("usuario_ref", ""))

    def vigente_visto(estado: store_mod.Estado, serie: str, cidade: str, ref_visto: str) -> bool:
        """O registro novo que a tela viu ainda está lá, com o mesmo usuário (outra decisão não o trocou)."""
        return any(
            store_mod._mesma(r, serie, cidade) and r.get("tipo") == store_mod.TIPO_BACKUP and r["usuario_ref"] == ref_visto
            for r in estado["confirmacoes"]
        )

    @router.post("/api/backups-regionais/manter")
    def manter(payload: ConfirmacaoPayload) -> Dict[str, Any]:
        """Mantém o backup com o usuário atual do Endpoint; o apelido manual não muda."""
        (serie, cidade), endpoint, agora, ref_visto = pendente(payload)
        ref = usuario_ref(endpoint_user_for_serial(endpoint, normalize_reference_value(serie)))

        def operacao(estado: store_mod.Estado) -> Tuple[store_mod.Estado, None]:
            if not vigente_visto(estado, serie, cidade, ref_visto):  # outra decisão chegou antes: nada é gravado
                raise HTTPException(status_code=409, detail={
                    "codigo": "sem_decisao_pendente", "mensagem": "Este backup não tem decisão pendente.",
                })
            novo, _registro, _repetido = store_mod.confirmar(estado, serie, cidade, agora, usuario_ref=ref)
            return store_mod.registrar_decisao(novo, serie, cidade, "manter", agora), None

        gravar(operacao)
        return {"serie": serie, "cidade": cidade, "decisao": "manter"}

    @router.post("/api/backups-regionais/excluir")
    def excluir(payload: ConfirmacaoPayload) -> Dict[str, Any]:
        """Remove o apelido manual, depois a confirmação, e registra a decisão."""
        (serie, cidade), _endpoint, agora, ref_visto = pendente(payload)
        if services.remover_apelido_manual is None:
            raise HTTPException(status_code=500, detail={
                "codigo": "falha_gravacao", "mensagem": "Não foi possível remover o apelido manual.",
            })
        try:
            services.remover_apelido_manual(serie)
        except DomainError as error:  # nada mais é gravado; o texto do erro pode ter série ou caminho: só a classe vai ao log
            logger.warning("Falha ao remover o apelido manual no Excluir dos Backups: %s.", type(error).__name__)
            raise HTTPException(status_code=error.status_code, detail={
                "codigo": "apelido_nao_removido",
                "mensagem": "Não foi possível remover o apelido manual; nada foi alterado.",
            }) from error

        def operacao(estado: store_mod.Estado) -> Tuple[store_mod.Estado, None]:
            if not vigente_visto(estado, serie, cidade, ref_visto):
                # Corrida com Manter/Desfazer: a confirmação já mudou; não a remove nem grava decisão (o apelido já saiu).
                return estado, None
            novo, _removido = store_mod.desfazer(estado, serie, cidade)
            return store_mod.registrar_decisao(novo, serie, cidade, "excluir", agora), None

        # shortcut: se esta gravação falhar, o apelido já saiu e a confirmação passa a cair como usuario_mudou; só a decisão não é gravada.
        gravar(operacao)
        return {"serie": serie, "cidade": cidade, "decisao": "excluir"}

    @router.post("/api/backups-regionais/desfazer")
    def desfazer(payload: ConfirmacaoPayload) -> Dict[str, Any]:
        """Remove a confirmação da série naquela cidade; sem registro, ``removido: false``."""
        agora = services.agora()
        removido = gravar(lambda estado: store_mod.desfazer(estado, payload.serie, payload.cidade, agora))
        origem = removido or {"serie": payload.serie, "cidade": payload.cidade}
        return {"serie": origem["serie"], "cidade": origem["cidade"], "removido": removido is not None}

    return router


def _confirmar(
    estado: store_mod.Estado, serie: str, cidade: str, agora: datetime, ref: str,
) -> Tuple[store_mod.Estado, Tuple[Any, bool]]:
    novo, registro, repetido = store_mod.confirmar(estado, serie, cidade, agora, usuario_ref=ref)
    return novo, (registro, repetido)
