"""Cobertura de Equipamentos: regras puras (sem I/O).

O estado operacional (``data/state/operacao_cobertura.json``) é um dict com as seções de ``SECOES``. Cada função de
transição recebe o estado lido, devolve ``(novo_estado, registro)`` sobre uma cópia e nunca toca arquivos nem o
cadastro (``EquipamentosDetalhes``). Quem grava é ``domains/coverage_store.py``, dentro de uma
``AtomicFileTransaction``, de modo que a elegibilidade é sempre recalculada sobre o estado relido na transação.
"""

from __future__ import annotations

import copy
import unicodedata
import uuid
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Dict, FrozenSet, Iterable, List, Mapping, Optional, Set, Tuple

from domains.equipment_search import normalize_search_term
from domains.inventory_comparison import SEBRAE_OWNED_NOTEBOOK_SERIALS
from domains.sebrae_cruzamento import CIDADE_CURITIBA, PREFIXOS_CURITIBA

Estado = Dict[str, Any]
Registro = Dict[str, Any]

ESQUEMA = 1
SECOES = ("disponibilidade", "demandas", "devolucoes", "reservas", "movimentacoes", "vinculos", "rejeicoes")
VALIDADE_DISPONIBILIDADE_DIAS = 7  # D2
VALIDADE_RESERVA_DIAS = 7  # D2
DIAS_PREPARO_PADRAO = 2  # O1b
ARQUIVAR_APOS_DIAS = 30  # D6
QUANTIDADE_MAXIMA = 50
KIT_ITENS = ("notebook", "carregador", "monitor", "preparacao")
TIPOS_DIVERGENCIA = ("serie_diferente", "item_faltando", "avaria")
RESOLUCOES = ("aceitar", "corrigir", "cancelar")
SITUACOES_DISPONIBILIDADE = ("disponivel", "em_manutencao", "indisponivel")

MOTIVOS_CONFLITO = frozenset({
    "reserva_ativa", "reserva_vencida_em_revisao", "reserva_em_espera", "movimentacao_aberta", "devolucao_pendente",
})
MOVIMENTACAO_ABERTA = frozenset({"preparada", "gerada", "coletada", "em_transito", "recebida_com_divergencia"})
MOVIMENTACAO_ENTREGUE = frozenset({"recebida", "encerrada"})
# Próximos estados aceitos por POST .../estado ("cancelada" só a partir de "preparada", tratado à parte).
PROXIMOS_ESTADOS: Dict[str, Dict[str, FrozenSet[str]]] = {
    "transporte": {
        "gerada": frozenset({"coletada"}),
        "coletada": frozenset({"em_transito"}),
        "em_transito": frozenset({"recebida", "recebida_com_divergencia"}),
        "recebida": frozenset({"encerrada"}),
    },
    "local": {"preparada": frozenset({"recebida", "recebida_com_divergencia"})},
}
# Estados que fecham um caso (contam para o arquivamento D6).
FECHADOS: Dict[str, FrozenSet[str]] = {
    "demandas": frozenset({"encerrada", "cancelada"}),
    "devolucoes": frozenset({"recebida", "cancelada"}),
    "reservas": frozenset({"consumida", "cancelada"}),
    "movimentacoes": frozenset({"recebida", "encerrada", "cancelada"}),
}
REFERENCIAS = ("demanda_id", "devolucao_id", "reserva_id", "movimentacao_id")
AVISO_MANUTENCAO = "Manutenção não verificada"
SINAL_CHAMADO = "Chamado possivelmente relacionado"


class CoberturaErro(Exception):
    """Erro de regra com código estável (``codigo``), status HTTP e dados extras para a resposta."""

    def __init__(self, codigo: str, status: int, mensagem: str, **extra: Any) -> None:
        super().__init__(mensagem)
        self.codigo = codigo
        self.status = status
        self.mensagem = mensagem
        self.extra = extra

    def detalhe(self) -> Dict[str, Any]:
        return {"codigo": self.codigo, "mensagem": self.mensagem, **self.extra}


@dataclass(frozen=True)
class Manutencao:
    """Séries em manutenção (chaves de ``chave_serie``) e sinais que não bloqueiam.

    ``ilegivel``: a fonte não pôde ser lida; nada é bloqueado nem liberado por manutenção e reservar exige
    ``manutencao_conferida``.
    """

    series: FrozenSet[str] = frozenset()
    sinais: FrozenSet[str] = frozenset()
    ilegivel: bool = False


@dataclass(frozen=True)
class Contexto:
    """Dados externos de uma operação: data do dia, carimbo de hora, manutenção e cadastro (``chave_serie`` -> item)."""

    hoje: date
    agora: str
    manutencao: Manutencao = Manutencao()
    cadastro: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)


# ----------------------------------------------------------------------------------------------- normalização


def chave_serie(serie: Any) -> str:
    """Chave única de comparação de séries: sem acento, maiúscula e só letras e dígitos."""
    return "".join(c for c in normalize_search_term(serie) if c.isalnum())


_SEBRAE = frozenset(chave_serie(serie) for serie in SEBRAE_OWNED_NOTEBOOK_SERIALS)


def eh_sebrae(serie: Any) -> bool:
    return chave_serie(serie) in _SEBRAE


def dobrar(texto: Any) -> str:
    """Texto para comparar cidades: sem acento, sem caixa e com espaços normalizados."""
    decomposto = unicodedata.normalize("NFKD", str(texto or ""))
    return " ".join("".join(c for c in decomposto if not unicodedata.combining(c)).casefold().split())


def cidade_do_cadastro(item: Optional[Mapping[str, Any]]) -> str:
    """Cidade do cadastro; hostnames PRNOTESJP/PRNOTERL/PRNOTEARC contam como Curitiba."""
    if not item:
        return ""
    if normalize_search_term(item.get("apelido")).startswith(PREFIXOS_CURITIBA):
        return CIDADE_CURITIBA
    return str(item.get("retirada_cidade") or "").strip()


def indexar_cadastro(itens: Iterable[Mapping[str, Any]]) -> Dict[str, Mapping[str, Any]]:
    return {chave_serie(item.get("serial")): item for item in itens if chave_serie(item.get("serial"))}


def estado_vazio() -> Estado:
    return {"esquema": ESQUEMA, **{secao: {} for secao in SECOES}}


def _data(valor: Any) -> Optional[date]:
    try:
        return date.fromisoformat(str(valor or ""))
    except ValueError:
        return None


def _exigir_data(valor: Any, campo: str) -> date:
    convertida = _data(valor)
    if convertida is None:
        raise CoberturaErro("dados_invalidos", 422, f"Informe {campo} no formato AAAA-MM-DD.", campo=campo)
    return convertida


def _texto(valor: Any, campo: str, limite: int, obrigatorio: bool = True) -> str:
    texto = " ".join(str(valor or "").split())
    if obrigatorio and not texto:
        raise CoberturaErro("dados_invalidos", 422, f"Informe {campo}.", campo=campo)
    if len(texto) > limite:
        raise CoberturaErro("dados_invalidos", 422, f"{campo} aceita no máximo {limite} caracteres.", campo=campo)
    return texto


def _novo_id(prefixo: str) -> str:
    return f"{prefixo}-{uuid.uuid4().hex[:12]}"


# ------------------------------------------------------------------------------------------- estados derivados


def disponibilidade_efetiva(registro: Optional[Mapping[str, Any]], hoje: date) -> str:
    """``disponivel`` vencida volta a ``a_confirmar`` (derivado, sem gravar)."""
    if not registro:
        return "a_confirmar"
    situacao = str(registro.get("estado") or "a_confirmar")
    if situacao == "disponivel":
        validade = _data(registro.get("valida_ate"))
        if validade is None or validade < hoje:
            return "a_confirmar"
    return situacao


def reserva_vencida(reserva: Mapping[str, Any], hoje: date) -> bool:
    validade = _data(reserva.get("valida_ate"))
    return reserva.get("estado") == "ativa" and (validade is None or validade < hoje)


def situacao_devolucao(devolucao: Mapping[str, Any], hoje: date) -> str:
    """``atrasada`` é derivado: ``prevista`` com a data já passada."""
    situacao = str(devolucao.get("estado") or "")
    prevista = _data(devolucao.get("data_prevista"))
    if situacao == "prevista" and prevista is not None and prevista < hoje:
        return "atrasada"
    return situacao


def kit_pronto(reserva: Mapping[str, Any]) -> bool:
    kit = reserva.get("kit")
    return isinstance(kit, dict) and bool(kit) and all(bool(valor) for valor in kit.values())


def _dias(n: int) -> str:
    return f"{n} dia" if n == 1 else f"{n} dias"


# ------------------------------------------------------------------------------------------------ bloqueio


def motivo_bloqueio(
    estado: Mapping[str, Any],
    serie: Any,
    hoje: date,
    manutencao: Manutencao,
    *,
    ignorar_reserva: Optional[str] = None,
    para_espera: bool = False,
) -> Optional[Dict[str, str]]:
    """Primeiro motivo que impede uma nova destinação da série, ou ``None`` se ela estiver livre.

    ``para_espera``: avalia uma reserva em espera sobre uma devolução desta série, que aceita a devolução pendente e
    a falta de disponibilidade confirmada. ``ignorar_reserva``: a própria reserva (renovação, preparo).
    """
    alvo = chave_serie(serie)
    if not alvo:
        return {"motivo": "sem_disponibilidade", "id": ""}
    reservas = sorted(
        (r for r in estado.get("reservas", {}).values()
         if chave_serie(r.get("serie")) == alvo and r.get("id") != ignorar_reserva),
        key=lambda r: str(r.get("id")),
    )
    for reserva in reservas:
        if reserva.get("estado") == "ativa" and not reserva_vencida(reserva, hoje):
            return {"motivo": "reserva_ativa", "id": str(reserva.get("id"))}
    for reserva in reservas:
        if reserva_vencida(reserva, hoje):
            return {"motivo": "reserva_vencida_em_revisao", "id": str(reserva.get("id"))}
    for reserva in reservas:
        if reserva.get("estado") == "em_espera":
            return {"motivo": "reserva_em_espera", "id": str(reserva.get("id"))}
    for mov in sorted(estado.get("movimentacoes", {}).values(), key=lambda m: str(m.get("id"))):
        if chave_serie(mov.get("serie")) == alvo and mov.get("estado") in MOVIMENTACAO_ABERTA:
            return {"motivo": "movimentacao_aberta", "id": str(mov.get("id"))}
    if not para_espera:
        for dev in sorted(estado.get("devolucoes", {}).values(), key=lambda d: str(d.get("id"))):
            if chave_serie(dev.get("serie")) == alvo and dev.get("estado") == "prevista":
                return {"motivo": "devolucao_pendente", "id": str(dev.get("id"))}
    if not manutencao.ilegivel and alvo in manutencao.series:
        return {"motivo": "manutencao", "id": alvo}
    if not para_espera and disponibilidade_efetiva(estado.get("disponibilidade", {}).get(alvo), hoje) != "disponivel":
        return {"motivo": "sem_disponibilidade", "id": alvo}
    return None


def _erro_do_bloqueio(bloqueio: Mapping[str, str]) -> CoberturaErro:
    motivo = bloqueio["motivo"]
    if motivo in MOTIVOS_CONFLITO:
        return CoberturaErro(
            "conflito_reserva", 409, "Esta máquina já tem destino.", motivo=motivo, bloqueio_id=bloqueio["id"],
        )
    return CoberturaErro("serie_indisponivel", 422, "Esta máquina não pode ser reservada agora.", motivo=motivo)


# ------------------------------------------------------------------------------------------------ cobertura


def _vaga(demanda: Mapping[str, Any], indice: int) -> Registro:
    return {
        "id": f"{demanda['id']}:{indice}",
        "demanda_id": demanda["id"],
        "indice": indice,
        "data": demanda.get("data"),
        "cidade": demanda.get("cidade"),
        "perfil": demanda.get("perfil", ""),
        "monitor": bool(demanda.get("monitor")),
        "situacao": "sem_cobertura",
        "serie": None,
        "reserva_id": None,
        "devolucao_id": None,
        "movimentacao_id": None,
        "selos": [],
        "motivo": None,
    }


def _motivo_atraso(devolucao: Mapping[str, Any], hoje: date) -> Optional[str]:
    prevista = _data(devolucao.get("data_prevista"))
    if prevista is not None and prevista < hoje:
        return f"Devolução atrasada há {_dias((hoje - prevista).days)}"
    return None


def build_coverage(
    estado: Mapping[str, Any],
    hoje: date,
    manutencao: Manutencao = Manutencao(),
    dias_preparo: int = DIAS_PREPARO_PADRAO,
) -> Dict[str, Any]:
    """Calcula todas as vagas juntas; cada série e cada devolução cobre no máximo uma vaga."""
    disponibilidade = estado.get("disponibilidade", {})
    reservas = estado.get("reservas", {})
    devolucoes = estado.get("devolucoes", {})
    movimentacoes = estado.get("movimentacoes", {})

    def cidade_da_serie(serie: Any) -> str:
        return str((disponibilidade.get(chave_serie(serie)) or {}).get("cidade") or "")

    demandas = sorted(
        (d for d in estado.get("demandas", {}).values() if d.get("estado") == "aberta"),
        key=lambda d: (str(d.get("data")), str(d.get("criada_em")), str(d.get("id"))),
    )
    vagas: List[Registro] = []
    restantes: List[Tuple[Tuple[str, str, str, int], Registro]] = []
    for demanda in demandas:
        compromissos: List[Registro] = []
        movs = sorted(
            (m for m in movimentacoes.values() if m.get("demanda_id") == demanda["id"] and m.get("estado") != "cancelada"),
            key=lambda m: str(m.get("criada_em")),
        )
        for mov in movs:
            entregue = mov.get("estado") in MOVIMENTACAO_ENTREGUE
            selos = [] if entregue else ["Em movimento"]
            if mov.get("estado") == "recebida_com_divergencia":
                selos.append("Recebida com divergência")
            compromissos.append({
                "situacao": "entregue" if entregue else "atendivel",
                "serie": mov.get("serie_recebida") or mov.get("serie"),
                "reserva_id": mov.get("reserva_id"),
                "movimentacao_id": mov.get("id"),
                "selos": selos,
            })
        ligadas = sorted(
            (r for r in reservas.values() if r.get("demanda_id") == demanda["id"] and r.get("estado") in ("ativa", "em_espera")),
            # sorted é estável: empate em criada_em mantém a ordem de inserção (ids são aleatórios)
            key=lambda r: (r.get("estado") != "ativa", str(r.get("criada_em"))),
        )
        for reserva in ligadas:
            if reserva.get("estado") == "ativa":
                selos = []
                if kit_pronto(reserva):
                    selos.append("Kit pronto")
                if reserva_vencida(reserva, hoje):
                    selos.append("Reserva vencida")
                if dobrar(cidade_da_serie(reserva.get("serie"))) != dobrar(demanda.get("cidade")):
                    selos.append("Transferência")
                compromissos.append({"situacao": "atendivel", "serie": reserva.get("serie"), "reserva_id": reserva.get("id"), "selos": selos})
            else:
                devolucao = devolucoes.get(str(reserva.get("devolucao_id"))) or {}
                compromissos.append({
                    "situacao": "condicionada",
                    "serie": reserva.get("serie"),
                    "reserva_id": reserva.get("id"),
                    "devolucao_id": reserva.get("devolucao_id"),
                    "selos": [],
                    "motivo": _motivo_atraso(devolucao, hoje),
                })
        for indice in range(1, int(demanda.get("quantidade") or 0) + 1):
            vaga = _vaga(demanda, indice)
            if compromissos:
                vaga.update(compromissos.pop(0))
            else:
                chave = (str(demanda.get("data")), str(demanda.get("criada_em")), str(demanda.get("id")), indice)
                restantes.append((chave, vaga))
            vagas.append(vaga)

    livres = sorted(
        (
            {
                "serie": registro.get("serie"),
                "cidade": registro.get("cidade"),
                "confirmada_em": registro.get("confirmada_em"),
                "valida_ate": registro.get("valida_ate"),
                "sinal": SINAL_CHAMADO if chave in manutencao.sinais else None,
            }
            for chave, registro in disponibilidade.items()
            if not eh_sebrae(chave) and motivo_bloqueio(estado, registro.get("serie") or chave, hoje, manutencao) is None
        ),
        key=lambda s: (str(s.get("confirmada_em")), str(s.get("serie"))),
    )
    devolucoes_livres = sorted(
        (
            d for d in devolucoes.values()
            if d.get("estado") == "prevista" and not eh_sebrae(d.get("serie"))
            and motivo_bloqueio(estado, d.get("serie"), hoje, manutencao, para_espera=True) is None
        ),
        key=lambda d: (str(d.get("data_prevista")), str(d.get("criada_em")), str(d.get("id"))),
    )
    usadas: Set[str] = set()
    devolucoes_usadas: Set[str] = set()
    for _, vaga in sorted(restantes, key=lambda item: item[0]):
        data_vaga = _data(vaga.get("data"))
        mesma = [s for s in livres if chave_serie(s["serie"]) not in usadas and dobrar(s.get("cidade")) == dobrar(vaga.get("cidade"))]
        outra = [s for s in livres if chave_serie(s["serie"]) not in usadas]
        escolhida = next(iter(mesma or outra), None)
        if escolhida is not None:
            usadas.add(chave_serie(escolhida["serie"]))
            vaga.update({"situacao": "atendivel", "serie": escolhida["serie"]})
            if not mesma:
                vaga["selos"] = ["Transferência"]
            continue
        for devolucao in devolucoes_livres:
            prevista = _data(devolucao.get("data_prevista"))
            if devolucao["id"] in devolucoes_usadas or prevista is None or data_vaga is None:
                continue
            if prevista + timedelta(days=dias_preparo) <= data_vaga:
                devolucoes_usadas.add(devolucao["id"])
                vaga.update({
                    "situacao": "condicionada",
                    "serie": devolucao.get("serie"),
                    "devolucao_id": devolucao["id"],
                    "motivo": _motivo_atraso(devolucao, hoje),
                })
                break

    for vaga in vagas:
        data_vaga = _data(vaga.get("data"))
        if vaga["situacao"] != "entregue" and data_vaga is not None and data_vaga < hoje:
            vaga["selos"] = [*vaga["selos"], "Prazo perdido"]

    contagens = {situacao: 0 for situacao in ("atendivel", "condicionada", "sem_cobertura", "entregue")}
    for vaga in vagas:
        contagens[vaga["situacao"]] += 1

    series_conhecidas: Dict[str, Any] = {chave: registro.get("serie") or chave for chave, registro in disponibilidade.items()}
    for secao in ("reservas", "devolucoes", "movimentacoes"):
        for registro in estado.get(secao, {}).values():
            series_conhecidas.setdefault(chave_serie(registro.get("serie")), registro.get("serie"))
    bloqueios = []
    for chave_conhecida, serie in sorted(series_conhecidas.items()):
        if not chave_conhecida or eh_sebrae(chave_conhecida):
            continue
        bloqueio = motivo_bloqueio(estado, serie, hoje, manutencao)
        if bloqueio is not None:
            bloqueios.append({"serie": serie, **bloqueio})

    return {
        "hoje": hoje.isoformat(),
        "vagas": vagas,
        "contagens": contagens,
        "disponiveis": livres,
        "bloqueios": bloqueios,
        "reservas_vencidas": sorted(str(r.get("id")) for r in reservas.values() if reserva_vencida(r, hoje)),
        "manutencao": {"verificada": not manutencao.ilegivel, "aviso": AVISO_MANUTENCAO if manutencao.ilegivel else ""},
        "sinais": [{"serie": chave, "sinal": SINAL_CHAMADO} for chave in sorted(manutencao.sinais)],
    }


# ------------------------------------------------------------------------------------------------ transições


def _buscar(estado: Estado, secao: str, registro_id: str, nome: str) -> Registro:
    registro = estado[secao].get(registro_id)
    if not isinstance(registro, dict):
        raise CoberturaErro("nao_encontrado", 404, f"{nome} não encontrada.", id=registro_id)
    return registro


def _conferir_rev(registro: Mapping[str, Any], rev: Any) -> None:
    if isinstance(rev, bool) or not isinstance(rev, int) or registro.get("rev") != rev:
        raise CoberturaErro(
            "registro_alterado", 409, "Este registro foi alterado por outra ação. Recarregue e tente de novo.",
            id=registro.get("id"), rev_atual=registro.get("rev"),
        )


def _tocar(registro: Registro, ctx: Contexto) -> Registro:
    registro["rev"] = int(registro.get("rev") or 0) + 1
    registro["atualizado_em"] = ctx.agora
    return registro


def _exigir_estado(registro: Mapping[str, Any], permitidos: Iterable[str], nome: str) -> None:
    if registro.get("estado") not in set(permitidos):
        raise CoberturaErro(
            "transicao_invalida", 409, f"{nome} está em '{registro.get('estado')}' e não aceita esta ação.",
            id=registro.get("id"), estado=registro.get("estado"),
        )


def _gravar_disponibilidade(estado: Estado, ctx: Contexto, serie: Any, situacao: str, cidade: str, **extra: Any) -> Registro:
    chave = chave_serie(serie)
    registro = estado["disponibilidade"].get(chave) or {"id": chave, "serie": str(serie).strip(), "rev": 0}
    registro.update({"estado": situacao, "cidade": cidade or registro.get("cidade") or "", **extra})
    if situacao != "disponivel":
        registro["valida_ate"] = None
    estado["disponibilidade"][chave] = _tocar(registro, ctx)
    return registro


def registrar_demanda(
    estado: Estado, ctx: Contexto, *, data: Any, cidade: Any, quantidade: Any, perfil: Any = "", monitor: bool = False,
    observacao: Any = "",
) -> Tuple[Estado, Registro]:
    novo = copy.deepcopy(estado)
    dia = _exigir_data(data, "a data da necessidade")
    if isinstance(quantidade, bool) or not isinstance(quantidade, int) or not 1 <= quantidade <= QUANTIDADE_MAXIMA:
        raise CoberturaErro("dados_invalidos", 422, f"A quantidade vai de 1 a {QUANTIDADE_MAXIMA}.", campo="quantidade")
    demanda = {
        "id": _novo_id("dem"),
        "estado": "aberta",
        "data": dia.isoformat(),
        "cidade": _texto(cidade, "a cidade", 80),
        "quantidade": quantidade,
        "perfil": _texto(perfil, "o perfil", 80, obrigatorio=False),
        "monitor": bool(monitor),
        "observacao": _texto(observacao, "a observação", 500, obrigatorio=False),
        "criada_em": ctx.agora,
        "fechado_em": None,
        "rev": 0,
    }
    novo["demandas"][demanda["id"]] = _tocar(demanda, ctx)
    return novo, demanda


def cancelar_demanda(estado: Estado, ctx: Contexto, demanda_id: str, rev: Any) -> Tuple[Estado, Registro]:
    novo = copy.deepcopy(estado)
    demanda = _buscar(novo, "demandas", demanda_id, "Necessidade")
    _conferir_rev(demanda, rev)
    _exigir_estado(demanda, ("aberta",), "A necessidade")
    for mov in novo["movimentacoes"].values():
        if mov.get("demanda_id") == demanda_id and mov.get("estado") in MOVIMENTACAO_ABERTA:
            raise CoberturaErro(
                "conflito_reserva", 409, "A necessidade tem uma movimentação em andamento.",
                motivo="movimentacao_aberta", bloqueio_id=mov.get("id"),
            )
    for reserva in novo["reservas"].values():
        if reserva.get("demanda_id") == demanda_id and reserva.get("estado") in ("ativa", "em_espera"):
            reserva.update({"estado": "cancelada", "fechado_em": ctx.hoje.isoformat()})
            _tocar(reserva, ctx)
    demanda.update({"estado": "cancelada", "fechado_em": ctx.hoje.isoformat()})
    _tocar(demanda, ctx)
    return novo, demanda


def registrar_disponibilidade(
    estado: Estado, ctx: Contexto, *, serie: Any, situacao: str, cidade: Any = None, rev: Any = None,
) -> Tuple[Estado, Registro]:
    """Confirma disponível (7 dias), marca manutenção ou indisponível. Ativa a reserva em espera cuja devolução já
    foi recebida, na mesma transação."""
    novo = copy.deepcopy(estado)
    chave = chave_serie(serie)
    if not chave:
        raise CoberturaErro("dados_invalidos", 422, "Informe a série.", campo="serie")
    if situacao not in SITUACOES_DISPONIBILIDADE:
        raise CoberturaErro("dados_invalidos", 422, "Situação de disponibilidade desconhecida.", campo="estado")
    if eh_sebrae(chave):
        raise CoberturaErro("serie_indisponivel", 422, "Notebook próprio do Sebrae, fora do inventário da Simpress.", motivo="fora_do_inventario")
    atual = novo["disponibilidade"].get(chave)
    if atual is not None:
        _conferir_rev(atual, rev)
    item = ctx.cadastro.get(chave)
    cidade_final = _texto(cidade, "a cidade", 80, obrigatorio=False) or cidade_do_cadastro(item) or str((atual or {}).get("cidade") or "")
    nome = str((item or {}).get("serial") or (atual or {}).get("serie") or serie).strip()
    if situacao == "disponivel":
        if not cidade_final:
            raise CoberturaErro("dados_invalidos", 422, "Informe a cidade onde a máquina está.", campo="cidade")
        registro = _gravar_disponibilidade(
            novo, ctx, nome, situacao, cidade_final, confirmada_em=ctx.agora,
            valida_ate=(ctx.hoje + timedelta(days=VALIDADE_DISPONIBILIDADE_DIAS)).isoformat(),
        )
        for reserva in novo["reservas"].values():
            devolucao = novo["devolucoes"].get(str(reserva.get("devolucao_id"))) or {}
            if (reserva.get("estado") == "em_espera" and chave_serie(reserva.get("serie")) == chave
                    and devolucao.get("estado") == "recebida"):
                reserva.update({
                    "estado": "ativa",
                    "valida_ate": (ctx.hoje + timedelta(days=VALIDADE_RESERVA_DIAS)).isoformat(),
                    "ativada_em": ctx.agora,
                })
                _tocar(reserva, ctx)
    else:
        registro = _gravar_disponibilidade(novo, ctx, nome, situacao, cidade_final)
    return novo, registro


def registrar_devolucao(
    estado: Estado, ctx: Contexto, *, serie: Any, data_prevista: Any, cidade: Any = None, observacao: Any = "",
) -> Tuple[Estado, Registro]:
    novo = copy.deepcopy(estado)
    chave = chave_serie(serie)
    if not chave:
        raise CoberturaErro("dados_invalidos", 422, "Informe a série.", campo="serie")
    if eh_sebrae(chave):
        raise CoberturaErro("serie_indisponivel", 422, "Notebook próprio do Sebrae, fora do inventário da Simpress.", motivo="fora_do_inventario")
    for dev in novo["devolucoes"].values():
        if chave_serie(dev.get("serie")) == chave and dev.get("estado") == "prevista":
            raise CoberturaErro(
                "conflito_reserva", 409, "Esta série já tem uma devolução prevista.",
                motivo="devolucao_pendente", bloqueio_id=dev.get("id"),
            )
    item = ctx.cadastro.get(chave)
    devolucao = {
        "id": _novo_id("dev"),
        "estado": "prevista",
        "serie": str((item or {}).get("serial") or serie).strip(),
        "data_prevista": _exigir_data(data_prevista, "a data prevista").isoformat(),
        "cidade": _texto(cidade, "a cidade", 80, obrigatorio=False) or cidade_do_cadastro(item),
        "observacao": _texto(observacao, "a observação", 500, obrigatorio=False),
        "criada_em": ctx.agora,
        "fechado_em": None,
        "rev": 0,
    }
    novo["devolucoes"][devolucao["id"]] = _tocar(devolucao, ctx)
    return novo, devolucao


def reprogramar_devolucao(estado: Estado, ctx: Contexto, devolucao_id: str, rev: Any, data_prevista: Any) -> Tuple[Estado, Registro]:
    novo = copy.deepcopy(estado)
    devolucao = _buscar(novo, "devolucoes", devolucao_id, "Devolução")
    _conferir_rev(devolucao, rev)
    _exigir_estado(devolucao, ("prevista",), "A devolução")
    devolucao["data_prevista"] = _exigir_data(data_prevista, "a nova data prevista").isoformat()
    _tocar(devolucao, ctx)
    return novo, devolucao


def receber_devolucao(estado: Estado, ctx: Contexto, devolucao_id: str, rev: Any) -> Tuple[Estado, Registro]:
    """A série recebida fica ``a_confirmar``; a reserva em espera só vira ativa quando a disponibilidade for confirmada."""
    novo = copy.deepcopy(estado)
    devolucao = _buscar(novo, "devolucoes", devolucao_id, "Devolução")
    _conferir_rev(devolucao, rev)
    _exigir_estado(devolucao, ("prevista",), "A devolução")
    devolucao.update({"estado": "recebida", "recebida_em": ctx.agora, "fechado_em": ctx.hoje.isoformat()})
    _tocar(devolucao, ctx)
    _gravar_disponibilidade(novo, ctx, devolucao.get("serie"), "a_confirmar", str(devolucao.get("cidade") or ""))
    return novo, devolucao


def cancelar_devolucao(estado: Estado, ctx: Contexto, devolucao_id: str, rev: Any) -> Tuple[Estado, Registro]:
    """Cancela a devolução e a reserva em espera sobre ela; a vaga é recalculada."""
    novo = copy.deepcopy(estado)
    devolucao = _buscar(novo, "devolucoes", devolucao_id, "Devolução")
    _conferir_rev(devolucao, rev)
    _exigir_estado(devolucao, ("prevista",), "A devolução")
    devolucao.update({"estado": "cancelada", "fechado_em": ctx.hoje.isoformat()})
    _tocar(devolucao, ctx)
    for reserva in novo["reservas"].values():
        if reserva.get("devolucao_id") == devolucao_id and reserva.get("estado") == "em_espera":
            reserva.update({"estado": "cancelada", "fechado_em": ctx.hoje.isoformat(), "motivo_cancelamento": "devolucao_cancelada"})
            _tocar(reserva, ctx)
    return novo, devolucao


def _vagas_ocupadas(estado: Mapping[str, Any], demanda_id: str) -> int:
    reservas = sum(
        1 for r in estado["reservas"].values() if r.get("demanda_id") == demanda_id and r.get("estado") in ("ativa", "em_espera")
    )
    movs = sum(
        1 for m in estado["movimentacoes"].values() if m.get("demanda_id") == demanda_id and m.get("estado") != "cancelada"
    )
    return reservas + movs


def _kit_inicial(demanda: Mapping[str, Any]) -> Dict[str, bool]:
    return {item: False for item in KIT_ITENS if item != "monitor" or demanda.get("monitor")}


def reservar(
    estado: Estado, ctx: Contexto, *, demanda_id: str, serie: Any = None, devolucao_id: Optional[str] = None,
    manutencao_conferida: bool = False,
) -> Tuple[Estado, Registro]:
    """Reserva ativa (com ``serie``) ou em espera (com ``devolucao_id``). Não depende de ``rev``: a elegibilidade é
    recalculada sobre este estado."""
    novo = copy.deepcopy(estado)
    if (serie is None) == (devolucao_id is None):
        raise CoberturaErro("dados_invalidos", 422, "Informe a série ou a devolução, não as duas.", campo="serie")
    demanda = _buscar(novo, "demandas", demanda_id, "Necessidade")
    _exigir_estado(demanda, ("aberta",), "A necessidade")
    if _vagas_ocupadas(novo, demanda_id) >= int(demanda.get("quantidade") or 0):
        raise CoberturaErro("demanda_sem_vaga", 409, "Todas as vagas desta necessidade já têm máquina.", id=demanda_id)
    if ctx.manutencao.ilegivel and not manutencao_conferida:
        raise CoberturaErro(
            "serie_indisponivel", 422, f"{AVISO_MANUTENCAO}: confirme que a máquina não está em manutenção.",
            motivo="manutencao_nao_verificada",
        )
    devolucao: Optional[Registro] = None
    if devolucao_id is not None:
        devolucao = _buscar(novo, "devolucoes", devolucao_id, "Devolução")
        _exigir_estado(devolucao, ("prevista",), "A devolução")
        serie = devolucao.get("serie")
    if eh_sebrae(serie):
        raise CoberturaErro("serie_indisponivel", 422, "Notebook próprio do Sebrae, fora do inventário da Simpress.", motivo="fora_do_inventario")
    bloqueio = motivo_bloqueio(novo, serie, ctx.hoje, ctx.manutencao, para_espera=devolucao is not None)
    if bloqueio is not None:
        raise _erro_do_bloqueio(bloqueio)
    chave = chave_serie(serie)
    reserva = {
        "id": _novo_id("res"),
        "estado": "em_espera" if devolucao is not None else "ativa",
        "demanda_id": demanda_id,
        "serie": str((novo["disponibilidade"].get(chave) or {}).get("serie") or serie).strip(),
        "devolucao_id": devolucao_id,
        "movimentacao_id": None,
        "valida_ate": None if devolucao is not None else (ctx.hoje + timedelta(days=VALIDADE_RESERVA_DIAS)).isoformat(),
        "kit": _kit_inicial(demanda),
        "manutencao_conferida": bool(manutencao_conferida) if ctx.manutencao.ilegivel else None,
        "criada_em": ctx.agora,
        "fechado_em": None,
        "rev": 0,
    }
    novo["reservas"][reserva["id"]] = _tocar(reserva, ctx)
    return novo, reserva


def renovar_reserva(estado: Estado, ctx: Contexto, reserva_id: str, rev: Any) -> Tuple[Estado, Registro]:
    """Revalida a elegibilidade (disponibilidade vencida devolve 422) e dá mais 7 dias."""
    novo = copy.deepcopy(estado)
    reserva = _buscar(novo, "reservas", reserva_id, "Reserva")
    _conferir_rev(reserva, rev)
    _exigir_estado(reserva, ("ativa",), "A reserva")
    bloqueio = motivo_bloqueio(novo, reserva.get("serie"), ctx.hoje, ctx.manutencao, ignorar_reserva=reserva_id)
    if bloqueio is not None:
        raise _erro_do_bloqueio(bloqueio)
    reserva["valida_ate"] = (ctx.hoje + timedelta(days=VALIDADE_RESERVA_DIAS)).isoformat()
    _tocar(reserva, ctx)
    return novo, reserva


def cancelar_reserva(estado: Estado, ctx: Contexto, reserva_id: str, rev: Any) -> Tuple[Estado, Registro]:
    novo = copy.deepcopy(estado)
    reserva = _buscar(novo, "reservas", reserva_id, "Reserva")
    _conferir_rev(reserva, rev)
    _exigir_estado(reserva, ("ativa", "em_espera"), "A reserva")
    reserva.update({"estado": "cancelada", "fechado_em": ctx.hoje.isoformat()})
    _tocar(reserva, ctx)
    return novo, reserva


def marcar_kit(estado: Estado, ctx: Contexto, reserva_id: str, rev: Any, item: str, marcado: bool) -> Tuple[Estado, Registro]:
    novo = copy.deepcopy(estado)
    reserva = _buscar(novo, "reservas", reserva_id, "Reserva")
    _conferir_rev(reserva, rev)
    _exigir_estado(reserva, ("ativa", "em_espera"), "A reserva")
    kit: Dict[str, Any] = dict(reserva["kit"]) if isinstance(reserva.get("kit"), dict) else {}
    if item not in kit:
        raise CoberturaErro("dados_invalidos", 422, "Este item não faz parte do kit desta reserva.", campo="item")
    kit[item] = bool(marcado)
    reserva["kit"] = kit
    _tocar(reserva, ctx)
    return novo, reserva


def preparar_movimentacao(
    estado: Estado, ctx: Contexto, reserva_id: str, rev: Any, tipo: str = "transporte",
) -> Tuple[Estado, Registro]:
    """Consome a reserva e cria a movimentação ``preparada``, que passa a carregar o bloqueio da série."""
    novo = copy.deepcopy(estado)
    if tipo != "transporte":
        raise CoberturaErro("dados_invalidos", 422, "Só o tipo 'transporte' está disponível.", campo="tipo")
    reserva = _buscar(novo, "reservas", reserva_id, "Reserva")
    _conferir_rev(reserva, rev)
    _exigir_estado(reserva, ("ativa",), "A reserva")
    if reserva_vencida(reserva, ctx.hoje):
        raise CoberturaErro("reserva_vencida", 422, "A reserva venceu; renove antes de preparar.", motivo="reserva_vencida_em_revisao")
    if not kit_pronto(reserva):
        raise CoberturaErro("kit_incompleto", 422, "Marque todos os itens do kit antes de preparar o Transporte.")
    if not ctx.manutencao.ilegivel and chave_serie(reserva.get("serie")) in ctx.manutencao.series:
        raise CoberturaErro("serie_indisponivel", 422, "Esta máquina está em manutenção.", motivo="manutencao")
    demanda = novo["demandas"].get(str(reserva.get("demanda_id"))) or {}
    disponibilidade = novo["disponibilidade"].get(chave_serie(reserva.get("serie"))) or {}
    mov = {
        "id": _novo_id("mov"),
        "tipo": tipo,
        "estado": "preparada",
        "reserva_id": reserva_id,
        "demanda_id": reserva.get("demanda_id"),
        "serie": reserva.get("serie"),
        "origem_cidade": disponibilidade.get("cidade") or "",
        "destino_cidade": demanda.get("cidade") or "",
        "chave": str(uuid.uuid4()),
        # Preenchidos pelo vínculo com o histórico de transferências (bloco 2): id e cópia dos campos.
        "historico_id": None,
        "transferencia": None,
        "reserva_valida_ate": reserva.get("valida_ate"),
        "recebimento": None,
        "divergencia": None,
        "resolucao": None,
        "serie_recebida": None,
        "criada_em": ctx.agora,
        "fechado_em": None,
        "rev": 0,
    }
    novo["movimentacoes"][mov["id"]] = _tocar(mov, ctx)
    reserva.update({"estado": "consumida", "movimentacao_id": mov["id"], "fechado_em": ctx.hoje.isoformat()})
    _tocar(reserva, ctx)
    return novo, mov


def _talvez_encerrar_demanda(estado: Estado, ctx: Contexto, demanda_id: Any) -> None:
    demanda = estado["demandas"].get(str(demanda_id))
    if not demanda or demanda.get("estado") != "aberta":
        return
    entregues = sum(
        1 for m in estado["movimentacoes"].values() if m.get("demanda_id") == demanda_id and m.get("estado") in MOVIMENTACAO_ENTREGUE
    )
    if entregues >= int(demanda.get("quantidade") or 0):
        demanda.update({"estado": "encerrada", "fechado_em": ctx.hoje.isoformat()})
        _tocar(demanda, ctx)


def _entregar(estado: Estado, ctx: Contexto, mov: Registro, serie: Any) -> None:
    mov.update({"estado": "recebida", "fechado_em": ctx.hoje.isoformat()})
    _gravar_disponibilidade(estado, ctx, serie, "entregue", str(mov.get("destino_cidade") or ""), movimentacao_id=mov["id"])
    _talvez_encerrar_demanda(estado, ctx, mov.get("demanda_id"))


def mudar_estado_movimentacao(
    estado: Estado, ctx: Contexto, mov_id: str, rev: Any, novo_estado: str, *, recebido_por: Any = None,
    data: Any = None, comprovante: Any = None, divergencia: Optional[Mapping[str, Any]] = None,
) -> Tuple[Estado, Registro]:
    novo = copy.deepcopy(estado)
    mov = _buscar(novo, "movimentacoes", mov_id, "Movimentação")
    _conferir_rev(mov, rev)
    atual = str(mov.get("estado"))
    if novo_estado == "cancelada":
        _exigir_estado(mov, ("preparada",), "A movimentação")
        mov.update({"estado": "cancelada", "fechado_em": ctx.hoje.isoformat()})
        reserva = novo["reservas"].get(str(mov.get("reserva_id")))
        if reserva is not None:
            # Volta a ativa com a validade original; se ela já passou, fica vencida em revisão.
            reserva.update({"estado": "ativa", "valida_ate": mov.get("reserva_valida_ate"), "movimentacao_id": None, "fechado_em": None})
            _tocar(reserva, ctx)
        _tocar(mov, ctx)
        return novo, mov
    permitidos = PROXIMOS_ESTADOS.get(str(mov.get("tipo")), {}).get(atual, frozenset())
    if novo_estado not in permitidos:
        raise CoberturaErro(
            "transicao_invalida", 409, f"A movimentação está em '{atual}' e não pode ir para '{novo_estado}'.",
            id=mov_id, estado=atual,
        )
    if novo_estado in ("recebida", "recebida_com_divergencia"):
        mov["recebimento"] = {
            "recebido_por": _texto(recebido_por, "quem recebeu", 120),
            "data": _exigir_data(data, "a data do recebimento").isoformat(),
            "comprovante": _texto(comprovante, "o comprovante", 500, obrigatorio=False),
        }
    if novo_estado == "recebida_com_divergencia":
        div = dict(divergencia or {})
        if div.get("tipo") not in TIPOS_DIVERGENCIA:
            raise CoberturaErro("dados_invalidos", 422, "Informe o tipo da divergência.", campo="divergencia")
        mov["divergencia"] = {
            "tipo": div["tipo"],
            "descricao": _texto(div.get("descricao"), "a descrição da divergência", 500, obrigatorio=False),
            "serie_recebida": _texto(div.get("serie_recebida"), "a série recebida", 60, obrigatorio=False) or None,
        }
        mov["estado"] = novo_estado
    elif novo_estado == "recebida":
        _entregar(novo, ctx, mov, mov.get("serie"))
    else:
        mov["estado"] = novo_estado
    _tocar(mov, ctx)
    return novo, mov


def resolver_divergencia(
    estado: Estado, ctx: Contexto, mov_id: str, rev: Any, resolucao: str, serie_recebida: Any = None,
) -> Tuple[Estado, Registro]:
    """``aceitar`` encerra como recebida; ``corrigir`` registra a série que chegou como entregue e devolve só a original
    a ``a_confirmar``; ``cancelar`` cancela a movimentação e reabre a vaga."""
    novo = copy.deepcopy(estado)
    mov = _buscar(novo, "movimentacoes", mov_id, "Movimentação")
    _conferir_rev(mov, rev)
    _exigir_estado(mov, ("recebida_com_divergencia",), "A movimentação")
    if resolucao not in RESOLUCOES:
        raise CoberturaErro("dados_invalidos", 422, "Resolução desconhecida.", campo="resolucao")
    original = mov.get("serie")
    origem = str(mov.get("origem_cidade") or "")
    mov["resolucao"] = {"tipo": resolucao, "em": ctx.agora}
    if resolucao == "aceitar":
        _entregar(novo, ctx, mov, original)
    elif resolucao == "corrigir":
        recebida = _texto(serie_recebida, "a série recebida", 60)
        if not chave_serie(recebida) or chave_serie(recebida) == chave_serie(original):
            raise CoberturaErro("dados_invalidos", 422, "A série recebida precisa ser diferente da série enviada.", campo="serie_recebida")
        mov["serie_recebida"] = recebida
        _entregar(novo, ctx, mov, recebida)
        _gravar_disponibilidade(novo, ctx, original, "a_confirmar", origem)
    else:
        mov.update({"estado": "cancelada", "fechado_em": ctx.hoje.isoformat()})
        _gravar_disponibilidade(novo, ctx, original, "a_confirmar", origem)
    _tocar(mov, ctx)
    return novo, mov


# ----------------------------------------------------------------------------------------- arquivamento (D6)


def separar_arquivaveis(estado: Estado, hoje: date) -> Tuple[Estado, Dict[str, Dict[str, Registro]]]:
    """Tira do estado os casos fechados há mais de 30 dias sem ligação com um caso aberto.

    Um caso fechado fica enquanto um caso aberto o referencia ou ele referencia um caso aberto (ex.: a movimentação
    recebida de uma necessidade ainda aberta continua contando a vaga entregue).
    """
    limite = hoje - timedelta(days=ARQUIVAR_APOS_DIAS)
    abertos: Dict[str, Registro] = {}
    for secao, fechados in FECHADOS.items():
        for registro_id, registro in estado.get(secao, {}).items():
            if registro.get("estado") not in fechados:
                abertos[str(registro_id)] = registro
    protegidos: Set[str] = set(abertos)
    for registro in abertos.values():
        protegidos.update(str(registro.get(ref)) for ref in REFERENCIAS if registro.get(ref))
    novo = copy.deepcopy(estado)
    movidos: Dict[str, Dict[str, Registro]] = {}
    for secao, fechados in FECHADOS.items():
        for registro_id, registro in list(novo.get(secao, {}).items()):
            fechado_em = _data(registro.get("fechado_em"))
            if registro.get("estado") not in fechados or fechado_em is None or fechado_em >= limite:
                continue
            if str(registro_id) in protegidos or any(str(registro.get(ref)) in abertos for ref in REFERENCIAS if registro.get(ref)):
                continue
            movidos.setdefault(secao, {})[registro_id] = novo[secao].pop(registro_id)
    return novo, movidos


def juntar_arquivados(arquivo: Estado, movidos: Mapping[str, Mapping[str, Registro]]) -> Estado:
    novo = copy.deepcopy(arquivo)
    for secao, registros in movidos.items():
        novo.setdefault(secao, {}).update(copy.deepcopy(dict(registros)))
    return novo


def buscar_caso(estado: Mapping[str, Any], caso_id: str) -> Optional[Tuple[str, Registro]]:
    for secao in SECOES:
        registro = estado.get(secao, {}).get(caso_id)
        if isinstance(registro, dict):
            return secao, registro
    return None


def anotar_casos(estado: Mapping[str, Any], hoje: date) -> Dict[str, Any]:
    """Cópia das seções com os campos derivados que a tela precisa (sem gravar nada)."""
    casos: Dict[str, Any] = copy.deepcopy({secao: dict(estado.get(secao, {})) for secao in SECOES})
    for registro in casos["disponibilidade"].values():
        registro["estado_efetivo"] = disponibilidade_efetiva(registro, hoje)
    for registro in casos["devolucoes"].values():
        registro["situacao"] = situacao_devolucao(registro, hoje)
    for registro in casos["reservas"].values():
        registro["vencida"] = reserva_vencida(registro, hoje)
        registro["kit_pronto"] = kit_pronto(registro)
    return casos
