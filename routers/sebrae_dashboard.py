"""Chamados Sebrae na tela Automação: importar o Dashboard, listar os novos, gerar as linhas para colar e
atualizar uma CÓPIA do Dashboard.

O Dashboard original nunca é alterado por aqui; no SoftExpert só a confirmação de associar o chamado ao usuário e, a pedido do
usuário (D = FINALIZADO), a finalização do chamado pela rotina ``fechar`` (scripts/sebrae_fechar.py).
O importado fica em ``data/state`` (números já lançados, listas A/B, chamados abertos e a cópia do .xlsx); a leitura
do SoftExpert é a rotina ``sebrae`` (scripts/sebrae_leitura.py).
Ver docs/operacao/sincronizar-chamados-sebrae.md ("Tela no site").
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Literal, Mapping, Optional, Sequence, Tuple

from fastapi import APIRouter, File, Query, UploadFile
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

from core.errors import DomainBusyError, DomainConflictError, DomainError, DomainValidationError
from core.config import REGIONAL_REPRESENTATIVE_DEFAULTS_FILE, REGIONAL_REPRESENTATIVES_FILE, format_size_limit
from core.integrity import atomic_write_json, lock_paths
from domains import (
    local_setup, os_marcas_finalizacao as marcas, sebrae_arquivo, sebrae_categoria, sebrae_categoria_ia, sebrae_credenciais, sebrae_cruzamento, sebrae_dashboard_gravacao, sebrae_finalizacao as fin,
    sebrae_historico, sebrae_novos, sebrae_observacoes as obs, sebrae_os_nova, sebrae_os_recusadas, sebrae_vinculos,
)
from domains.assistant_lgpd import e_solicitante_sistema
from domains.chrome_automation import ChromeAutomationRunner
from domains.sebrae_chamados import chave_do_numero, mascarar_cpfs
from domains.sebrae_dashboard import MANUAIS, DashboardInvalido, ler_coluna_c, ler_status_chamados

MAX_CHAMADOS_POR_EXPORTACAO = 200
NOME_ATUALIZADO = "Dashboard Operacional_SEBRAE.xlsx"
logger = logging.getLogger(__name__)


class ChamadoManual(BaseModel):
    model_config = ConfigDict(extra="forbid")

    numero: str = Field(..., min_length=1, max_length=40)
    A: str = Field("", max_length=200)
    B: str = Field("", max_length=200)
    D: str = Field("", max_length=40)
    J: str = Field("", max_length=40)
    R: str = Field("", max_length=40)
    S: str = Field("", max_length=200)
    G: str = Field("", max_length=sebrae_novos.MAX_TITULO)  # title typed on the site; blank keeps the one from SoftExpert/Dashboard


class ExportarPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    chamados: List[ChamadoManual] = Field(..., min_length=1, max_length=MAX_CHAMADOS_POR_EXPORTACAO)


class AtualizarPayload(BaseModel):
    """``chamados``: novos, escritos nas primeiras linhas livres. ``edicoes``: antigos EM ABERTO/sem status, só campos manuais."""

    model_config = ConfigDict(extra="forbid")

    chamados: List[ChamadoManual] = Field(default_factory=list, max_length=MAX_CHAMADOS_POR_EXPORTACAO)
    edicoes: List[ChamadoManual] = Field(default_factory=list, max_length=MAX_CHAMADOS_POR_EXPORTACAO)
    versao_importacao: str = Field("", max_length=128)
    finalizar_softexpert: bool = False  # só True (diálogo "Atualizar e finalizar") dispara a rotina fechar em massa; irreversível
    enviar_sharepoint: bool = False  # True (clique em "Atualizar Dashboard") inicia a rotina enviar depois da cópia gravada, se a fechar não rodou
    # Decisão do usuário (25/11/2026): UTICs que o usuário confirmou na tela como finalizados por outro técnico; só eles, se a leitura
    # e a fechar não os acharem, viram ``finalizado_outro_tecnico`` (A, B, D=FINALIZADO e R conferidos antes; só com ``finalizar_softexpert``).
    confirmar_outro_tecnico: List[str] = Field(default_factory=list, max_length=MAX_CHAMADOS_POR_EXPORTACAO)


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


class FinalizarPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    numero: str = Field(..., min_length=1, max_length=40)
    versao_importacao: str = Field("", max_length=128)
    confirmado: bool = False  # clique explícito após o diálogo "Confirmar finalização"; sem isso nada é disparado
    # DT ENCERRAMENTO (R) "dd/MM/aaaa HH:mm" informada pelo usuário (Assistente); vazia, vale o R deste chamado em `chamados`/`edicoes` ou no Dashboard importado.
    encerramento: str = Field("", max_length=40)
    # Mesmo corpo do "Atualizar Dashboard" (todos os novos em `chamados`, todos os antigos editados em `edicoes`): a cópia de saída é refeita da importada, então mandar só este chamado apagaria os demais.
    chamados: List[ChamadoManual] = Field(default_factory=list, max_length=MAX_CHAMADOS_POR_EXPORTACAO)
    edicoes: List[ChamadoManual] = Field(default_factory=list, max_length=MAX_CHAMADOS_POR_EXPORTACAO)
    # Decisão do usuário (25/11/2026): confirmação explícita, na tela, de que este chamado foi finalizado por outro técnico; o Assistente nunca manda.
    confirmar_outro_tecnico: bool = Field(False, strict=True)


class DescricaoPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    descricao_finalizacao: str = Field("", max_length=fin.MAX_DESCRICAO * 2)  # the exact limit is checked (and explained) by the domain


class DescricaoEditadaPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    descricao: str = Field("", max_length=fin.MAX_DESCRICAO * 2)  # limite exato e mensagem ficam no domínio


class ObservacaoPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    observacao: str = Field("", max_length=4000)


class OsRecusadaPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    os: str = Field(max_length=64)  # letras, números e hífen até 32 (sem espaços, em maiúsculas); a mensagem exata vem do domínio


class DestaquePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    destaque: bool = Field(..., strict=True)


class FichaPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ficha: Dict[str, Any]

    @field_validator("ficha")
    @classmethod
    def validar_campos(cls, ficha: Dict[str, Any]) -> Dict[str, Any]:
        for campo in ("titulo", "solicitante"):
            if campo in ficha and not isinstance(ficha[campo], str):
                raise ValueError(f"{campo} precisa ser texto.")
        for campo in ("fatos", "detalhes"):
            if campo in ficha and (not isinstance(ficha[campo], list) or any(
                not isinstance(par, list) or len(par) != 2 or not all(isinstance(valor, str) for valor in par)
                for par in ficha[campo]
            )):
                raise ValueError(f"{campo} precisa ser uma lista de pares de textos.")
        if "manuais" in ficha and (not isinstance(ficha["manuais"], dict) or any(
            not isinstance(valor, str) for valor in ficha["manuais"].values()
        )):
            raise ValueError("manuais precisa ser um objeto com valores textuais.")
        return ficha


class RecuperacaoEnvioPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    envio_id: str = Field(..., pattern=r"^[a-f0-9]{32}$")
    acao: Literal["limpar", "confirmar_recebimento", "declarar_nao_enviado", "concluir_legado"]
    confirmacao: str = Field("", max_length=100)


class ConflitosPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    escolhas: Dict[str, Literal["sharepoint", "site"]] = Field(..., max_length=500)
    enviar: bool = Field(False, strict=True)
    versao_importacao: str = Field("", max_length=128)


class ReenvioSnapshotPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    envio_id: str = Field(..., pattern=r"^[a-f0-9]{32}$")
    sha256: str = Field(..., pattern=r"^[a-f0-9]{64}$")
    confirmado: bool = Field(False, strict=True)


class DesfazerOutroTecnicoPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    numero: str = Field(..., max_length=40)
    confirmado: bool = Field(False, strict=True)


def create_sebrae_dashboard_router(services: SebraeDashboardServices) -> APIRouter:
    router = APIRouter()

    def _base_guard():
        return services.caminhos().existentes.parent / "sebrae_dashboard_base.guard"

    def _exigir_versao(versao: str) -> None:
        atual = sebrae_novos.ler_existentes(services.caminhos().existentes)
        if atual is None:
            raise DomainValidationError("Importe o Dashboard antes de atualizar ou finalizar.", status_code=422)
        if not versao or versao != atual["versao"]:
            raise DomainConflictError("O Dashboard foi reimportado ou a tela está desatualizada. Recarregue e confira os campos antes de atualizar ou finalizar. Nada foi gravado ou finalizado.")

    def _relatorio() -> Optional[Mapping[str, Any]]:
        try:
            return services.relatorio_chamados()
        except (OSError, ValueError):
            return None  # an unreadable ticket report only leaves column E empty

    def _indice_endpoint() -> Optional[Mapping[str, Any]]:
        try:
            return services.indice_endpoint()
        except Exception as erro:  # an optional fallback must never break the screen or the update
            logger.warning("Índice do Endpoint indisponível para a OS de MacBook (erro=%s).", type(erro).__name__)
            return None  # without the index E just keeps the exact-serial match

    def _leitura_antigos() -> Dict[str, Dict[str, str]]:
        """SoftExpert read of the old open tickets with the description edited on the site; the screen and "Atualizar" share it."""
        antigos = sebrae_novos.ler_antigos(sebrae_novos.caminho_antigos(services.caminhos()))
        return sebrae_novos.aplicar_descricoes_antigos(antigos, fin.descricoes_editadas(_pasta_estado())) if antigos else {}

    def _nao_encontrados(antigos: Mapping[str, Mapping[str, str]]) -> set:
        """Old tickets missing from SoftExpert's task center on the last read and absent from the cached read (one rule for the screen badge and the 422)."""
        lidos = set((sebrae_novos.ler_resultado_antigos(services.caminhos()) or {}).get("nao_encontrados") or [])
        return {str(n) for n in lidos} - set(antigos)

    def _falta_encerramento(numero: str) -> str:
        """Mesma frase no 422 de Atualizar e do botão por chamado (o front repete no singular: ``avisoEncerramento``)."""
        return f"Informe a DT ENCERRAMENTO (coluna R) do chamado {numero} antes de finalizar."

    def _exigir_outro_tecnico(numero: str, valores: Mapping[str, Any]) -> None:
        """Decisão do usuário (25/11/2026): confirmar "finalizado por outro técnico" exige A, B, D=FINALIZADO e R válida; ``valores`` são os que vão à cópia."""
        faltas = [rotulo for letra, rotulo in (("A", "A (Cliente/Simpress)"), ("B", "B (Categoria)")) if not str(valores.get(letra) or "").strip()]
        if str(valores.get("D") or "").strip().upper() != sebrae_novos.STATUS_FINALIZADO:
            faltas.append("D (FINALIZADO)")
        if not fin.encerramento_valido(valores.get("R")):
            faltas.append("R (DT ENCERRAMENTO, dd/MM/aaaa HH:mm)")
        if faltas:
            lista = faltas[0] if len(faltas) == 1 else f"{', '.join(faltas[:-1])} e {faltas[-1]}"
            raise DomainValidationError(f"Para registrar {numero} como finalizado por outro técnico, preencha {lista}.", status_code=422)

    def _tem_encerramento(numero: str, r: Any) -> bool:
        """R válido enviado/gravado, ou chamado já finalizado por este site (o R registrado volta pela ``_reaplicar_encerramentos``)."""
        return bool(fin.encerramento_valido(r)) or fin.ja_finalizado(_pasta_estado(), numero)

    def _encerramento_do_pedido(payload: FinalizarPayload, numero: str) -> str:
        """R deste chamado: ``encerramento`` do corpo, senão o de ``edicoes``/``chamados``, senão o do Dashboard importado; ``""`` se faltar."""
        if payload.encerramento.strip():
            return fin.encerramento_valido(payload.encerramento)  # informado e fora do formato: não cai para outra fonte
        enviado = next((i.R for i in [*payload.edicoes, *payload.chamados] if i.numero == numero and i.R.strip()), "")
        if enviado:
            return fin.encerramento_valido(enviado)
        importado = sebrae_novos.ler_existentes(services.caminhos().existentes) or {}
        guardado = next((str((a.get("valores") or {}).get("R") or "") for a in importado.get("abertos", []) if str(a.get("numero")) == numero), "")
        return fin.encerramento_valido(guardado)

    def _automaticos_dos_abertos(
        abertos: Sequence[Mapping[str, Any]], antigos: Mapping[str, Mapping[str, str]], registros: Sequence[Mapping[str, Any]],
        relatorio: Optional[Mapping[str, Any]], indice: Optional[Mapping[str, Any]],
    ) -> Dict[str, Dict[str, str]]:
        """What "Atualizar Dashboard" fills in the old open rows: G, H and I from the SoftExpert read, then E, K, L and N
        from the name cross-reference fed by that same read (screen and write use this one function).

        ``relatorio`` and ``indice`` are read once by the caller and shared with ``_os_novas_dos_abertos``."""
        efetivos = sebrae_novos.complementar_antigos(abertos, antigos)
        cruzados = sebrae_novos.preenchimentos(
            efetivos, registros, relatorio, services.vinculos_os(), indice, sebrae_os_recusadas.ler_ou_vazio(_pasta_estado()),
        )
        lidos = sebrae_novos.preenchimentos_softexpert(abertos, antigos)
        return {n: {**lidos.get(n, {}), **cruzados.get(n, {})} for n in {*lidos, *cruzados}}

    def _os_novas_dos_abertos(
        abertos: Sequence[Mapping[str, Any]], antigos: Mapping[str, Mapping[str, str]], registros: Sequence[Mapping[str, Any]],
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
                efetivos, relatorio, list(services.vinculos_os()), sebrae_os_recusadas.ler(_pasta_estado()), registros, indice,
                sebrae_os_recusadas.mantidas(_pasta_estado()),
            )
        except DomainBusyError as erro:
            logger.warning("OS nova sugerida indisponível (%s).", type(erro).__name__)
        except Exception as erro:  # noqa: BLE001 - a sugestão é só auxílio; o F5 segue sem ela
            logger.warning("Falha ao calcular a OS nova sugerida (%s).", type(erro).__name__)
        return {}

    def _limpar_e_dos_abertos(abertos: Sequence[Mapping[str, Any]], trocas: Mapping[str, str]) -> Dict[str, str]:
        """E que o usuário mandou Remover e que ainda são essa OS (``sebrae_os_nova.limpar_e``); registro ilegível: nada é limpo."""
        try:
            removidas = sebrae_os_recusadas.removidas(_pasta_estado())
        except DomainBusyError:
            return {}
        return sebrae_os_nova.limpar_e(abertos, removidas, list(services.vinculos_os()), trocas)

    def _sugestoes_antigo(aberto: Mapping[str, Any], efetivo: Mapping[str, Any], lido: Optional[Mapping[str, str]], opcoes_a: Sequence[str]) -> Dict[str, Optional[str]]:
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

    def _uma_vez(leituras: Optional[Dict[str, Any]], chave: str, ler: Callable[[], Any]) -> Any:
        """Each source read at most once per response (``leituras`` lives only for that response, so nothing goes stale)."""
        if leituras is None:
            return ler()
        if chave not in leituras:
            leituras[chave] = ler()
        return leituras[chave]

    def _abertos_com_sugestoes(
        abertos: Sequence[Mapping[str, Any]], observacoes: Optional[Mapping[str, Mapping[str, str]]] = None, opcoes_a: Sequence[str] = (),
        leituras: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        """Old open tickets plus what "Atualizar Dashboard" would fill into their empty E, K, L and N.

        An old ticket already read from SoftExpert (rotina ``antigos``) gets the same cross-reference as a new one:
        its description and requester fill the Dashboard's empty H and I for the name lookup (the API keeps both as they are)."""
        antigos = _leitura_antigos() if abertos else {}
        # Not in SoftExpert's task center on the last read (e.g. closed by another technician): the F5 card is tinted to check later.
        nao_encontrados = _nao_encontrados(antigos) if abertos else set()
        efetivos = sebrae_novos.complementar_antigos(abertos, antigos)
        registros = _uma_vez(leituras, "registros", services.registros) if abertos else []
        relatorio, indice = (_uma_vez(leituras, "relatorio", _relatorio), _indice_endpoint()) if abertos else (None, None)
        sugestoes = _automaticos_dos_abertos(abertos, antigos, registros, relatorio, indice) if abertos else {}
        os_novas = _os_novas_dos_abertos(abertos, antigos, registros, sugestoes, relatorio, indice)
        finalizacao = fin.ler_estado(_pasta_estado()) if abertos else {}
        obs_map = observacoes if observacoes is not None else (obs.ler_observacoes(_pasta_estado()) if abertos else {})
        apelidos = _uma_vez(leituras, "apelidos", services.apelidos) if abertos else {}
        com_senha = sebrae_credenciais.numeros(_pasta_estado()) if abertos else frozenset()
        return [
            {**a, "automaticos_sugeridos": sugestoes.get(str(a.get("numero")), {}),
             "apelido": _apelido(apelidos, (a.get("automaticos") or {}).get("K") or sugestoes.get(str(a.get("numero")), {}).get("K")),
             **sebrae_cruzamento.avisos_de_nome(e.get("descricao"), e.get("usuario"), registros),
             "softexpert": fin.publico(finalizacao.get(str(a.get("numero")))),
             "leitura_softexpert": antigos.get(str(a.get("numero"))),
             "nao_encontrado_softexpert": str(a.get("numero")) in nao_encontrados,
             "tem_credencial": str(a.get("numero")) in com_senha,  # only the flag; the value needs the click (GET .../credenciais)
             "observacao": obs_map.get(str(a.get("numero") or ""), {}).get("observacao", ""),
             "destaque": _destacado(obs_map, a.get("numero")),
             **_os_nova_e_sem_relacao(os_novas.get(str(a.get("numero")))),  # ``softexpert`` is the finalization state; this is the read data
             **_sugestoes_antigo(a, e, antigos.get(str(a.get("numero"))), opcoes_a)}
            for a, e in zip(abertos, efetivos)
        ]

    def _os_nova_e_sem_relacao(sugestao: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        """``sem_relacao`` goes to its own key: the current F5 screen reads ``os_nova.nova`` and would break on it."""
        if sugestao and sugestao.get("tipo") == "sem_relacao":
            return {"os_nova": None, "os_sem_relacao": sugestao}
        return {"os_nova": sugestao, "os_sem_relacao": None}

    def _destacado(observacoes: Mapping[str, Mapping[str, Any]], numero: Any) -> bool:
        return bool(observacoes.get(str(numero or ""), {}).get("destaque"))

    def _apelido(apelidos: Mapping[str, str], serie: Any) -> str:
        return apelidos.get(str(serie or "").strip().upper(), "")

    def _pasta_estado():
        return fin.pasta_estado(services.caminhos().existentes)

    def _nomes_representantes() -> List[Any]:
        """Nomes dos representantes regionais (padrão local e alterados); arquivo ilegível vale só o padrão."""
        try:
            salvos, _ = local_setup.load_regional_representatives(REGIONAL_REPRESENTATIVES_FILE)
        except Exception:  # noqa: BLE001 - só serve para mascarar nomes; o padrão continua valendo
            salvos = {}
        # O padrão vem do arquivo local (o código tem os nomes em branco): sem ele os nomes reais deixariam de ser mascarados.
        padroes_efetivos, _ = local_setup.effective_regional_representative_defaults(REGIONAL_REPRESENTATIVE_DEFAULTS_FILE)
        padroes = [dados.get("nome") for dados in padroes_efetivos.values()]
        return [*padroes, *(dados.get("nome") for dados in salvos.values() if isinstance(dados, dict))]

    def _nomes_pessoas() -> List[Any]:
        """Nomes conhecidos de pessoas (inventário e representantes): nunca viram palavra do índice nem saem para a IA."""
        return [*(registro.get("nome") for registro in services.registros()), *_nomes_representantes()]

    def _reindexar_categoria(conteudo: bytes) -> None:
        """Refaz o índice local da sugestão de categoria (B) e tipo (J); só aprende, nunca bloqueia importar nem atualizar."""
        try:
            sebrae_categoria.construir_indice(conteudo, _pasta_estado() / sebrae_categoria.ARQUIVO_INDICE, _nomes_pessoas())
        except Exception as erro:  # noqa: BLE001 - log only the type, never ticket data
            logger.warning("Não atualizei o índice de sugestão de categoria (%s).", type(erro).__name__)

    def _sugestoes_categoria(
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

    def _novos(caminhos: sebrae_novos.Caminhos, lancados: Iterable[str]) -> Optional[Dict[str, Any]]:
        """Chamados novos da última busca já com a descrição que o usuário editou no site (lápis do cartão)."""
        novos = sebrae_novos.ler_novos(caminhos.novos, lancados)
        if novos is not None:
            novos["chamados"] = sebrae_novos.aplicar_descricoes_novos(novos["chamados"], fin.descricoes_editadas(_pasta_estado()))
        return novos

    def _estado(ia: bool = True) -> Dict[str, Any]:
        corpo = _estado_base(ia)
        # só aparecem quando existem: a tela vazia continua {"importado": None, "novos": None}
        resultado = fin.ler_resultado(_pasta_estado())
        if resultado is not None:
            corpo["fechar"] = resultado
        pendente = fin.aviso_do_pendente(_pasta_estado())
        if pendente is not None:
            corpo["sharepoint"] = pendente
        return corpo

    def _sugestor_ia(novos: Mapping[str, Any], importado: Optional[Mapping[str, Any]] = None) -> Optional[sebrae_categoria_ia.SugestorIA]:
        """Sugestor por IA desta resposta (None com a chave SIMPRESS_SUGESTAO_IA desligada); conhece os nomes para mascarar."""
        try:
            sugestor = sebrae_categoria_ia.criar()
            if sugestor is not None:
                sugestor.registrar_nomes(_nomes_pessoas())
                sugestor.registrar_nomes([chamado.solicitante for chamado in novos["chamados"]])
                sugestor.registrar_nomes([linha.get("usuario") for linha in (importado or {}).get("abertos", [])])
            return sugestor
        except Exception as erro:  # noqa: BLE001 - the optional AI never breaks the list; log only the class, never ticket data
            logger.warning("Sugestão de categoria por IA indisponível (erro=%s).", type(erro).__name__)
            return None

    def _estado_base(ia: bool = True) -> Dict[str, Any]:
        caminhos = services.caminhos()
        importado = sebrae_novos.ler_existentes(caminhos.existentes)
        lancados = importado["numeros"] if importado else frozenset()
        novos = _novos(caminhos, lancados) if importado else None
        pasta = _pasta_estado()
        finalizacao = fin.ler_estado(pasta) if (novos or importado) else {}
        observacoes = obs.ler_observacoes(pasta) if (novos or importado) else {}
        com_senha = sebrae_credenciais.numeros(pasta) if novos else frozenset()
        leituras: Dict[str, Any] = {}
        apelidos = _uma_vez(leituras, "apelidos", services.apelidos) if novos else {}
        indice_categoria = sebrae_categoria.carregar_indice(_pasta_estado() / sebrae_categoria.ARQUIVO_INDICE) if novos else None  # uma leitura por resposta
        lista_b = importado["listas"].get("B", []) if importado else []
        vistas = {sebrae_categoria.normalizar(opcao) for opcao in lista_b}
        opcoes_b = [*lista_b, *(c for c in sebrae_categoria.CATEGORIAS_NOVAS if sebrae_categoria.normalizar(c) not in vistas)]
        opcoes_a = importado["listas"].get("A", []) if importado else []
        sugestor = _sugestor_ia(novos, importado) if (novos and ia) else None  # IA opcional: fora de qualquer trava de arquivo (ia=False)
        finalizados = [
            {**f, "observacao": observacoes.get(str(f.get("numero") or ""), {}).get("observacao", ""),
             "destaque": _destacado(observacoes, f.get("numero"))}
            for f in fin.finalizados_no_dashboard(pasta)
        ] if importado else []
        return {
            "importado": None if importado is None else {
                "versao": importado["versao"], "arquivo": importado["arquivo"], "importado_em": importado["importado_em"], "total": len(lancados),
                "listas": importado["listas"], "abertos": _abertos_com_sugestoes(importado["abertos"], observacoes, opcoes_a, leituras),
                "finalizados": finalizados,
                "atualizavel": sebrae_novos.ler_planilha(sebrae_novos.caminho_planilha(caminhos), importado["sha256"]) is not None,
                "saida_pronta": sebrae_novos.caminho_saida(caminhos, NOME_ATUALIZADO).is_file(),
            },
            "novos": None if novos is None else {
                "lidos_em": novos["lidos_em"], "ignorados": novos["ignorados"], "pendentes": novos["pendentes"],
                "erros": novos["erros"],
                "formulario": [
                    {**item, "apelido": _apelido(apelidos, item["linha"].get("K")),
                     "softexpert": fin.publico(finalizacao.get(item["numero"])),
                     "observacao": observacoes.get(item["numero"], {}).get("observacao", ""),
                     "destaque": _destacado(observacoes, item["numero"]),
                     "tem_credencial": item["numero"] in com_senha,
                     **_sugestoes_categoria(item["linha"], opcoes_b, indice_categoria, sugestor, opcoes_a)}
                    for item in sebrae_novos.formulario(
                        novos["chamados"], _uma_vez(leituras, "registros", services.registros), _uma_vez(leituras, "relatorio", _relatorio),
                        services.vinculos_os())
                ],
            },
        }

    @router.get("/api/sebrae/novos")
    def novos_chamados():
        """Dashboard importado e chamados novos lidos do SoftExpert, com as colunas automáticas já calculadas."""
        return JSONResponse(_estado(), headers={"Cache-Control": "no-store"})

    @router.post("/api/sebrae/dashboard")
    async def importar_dashboard(file: UploadFile = File(...), automatico: bool = Query(False)):
        nome = re.split(r"[/\\]", str(file.filename or ""))[-1]
        if not nome.lower().endswith(".xlsx"):
            raise DomainValidationError("Selecione o Dashboard Operacional_SEBRAE em .xlsx.", status_code=422)
        limite = services.max_upload_bytes()
        conteudo = await file.read(limite + 1)
        if not conteudo:
            raise DomainValidationError("O arquivo do Dashboard está vazio.", status_code=422)
        if len(conteudo) > limite:
            raise DomainValidationError(f"O Dashboard excede o limite de {format_size_limit(limite)}.", status_code=413)
        try:
            numeros = await asyncio.to_thread(ler_coluna_c, conteudo)
        except DashboardInvalido as erro:
            raise DomainValidationError(str(erro), status_code=422) from None
        return await asyncio.to_thread(_importar_bloqueado, conteudo, numeros, nome, automatico)

    def _valores_ou_none(conteudo: Optional[bytes]) -> Optional[Dict[int, Any]]:
        """Row values of a Dashboard copy; ``None`` when it is missing or unreadable, so it never equals anything."""
        if conteudo is None:
            return None
        try:
            return sebrae_dashboard_gravacao.valores_dos_chamados(conteudo)
        except (OSError, ValueError, KeyError):  # DashboardInvalido and GravacaoInvalida are ValueError
            return None

    def _mesma_planilha(baixada: bytes, referencia: Optional[bytes]) -> bool:
        """Same bytes, or same ticket-row values (a re-save in Excel changes bytes, not data)."""
        if referencia is None:
            return False
        if hashlib.sha256(baixada).digest() == hashlib.sha256(referencia).digest():
            return True
        valores = _valores_ou_none(baixada)
        return valores is not None and valores == _valores_ou_none(referencia)

    def _classificar_saida_pendente(conteudo: bytes) -> str:
        """Compare the Dashboard just downloaded with the pending output and with the imported base (read only):
        ``igual_saida`` (the output is already there), ``igual_base`` (nothing changed, the output can still be sent)
        or ``divergente`` (edited after the import, or no readable base: the output can no longer be sent)."""
        caminhos = services.caminhos()
        try:
            saida = sebrae_novos.caminho_saida(caminhos, NOME_ATUALIZADO).read_bytes()
        except OSError:
            saida = None
        if _mesma_planilha(conteudo, saida):
            return "igual_saida"
        importado = sebrae_novos.ler_existentes(caminhos.existentes)
        base = sebrae_novos.ler_planilha(sebrae_novos.caminho_planilha(caminhos), importado["sha256"]) if importado else None
        if _mesma_planilha(conteudo, base):
            return "igual_base"
        # Same acceptance as the check of ``enviar``: the file this site last put on SharePoint (hash, or values after SharePoint re-saved it).
        pasta = _pasta_estado()
        enviado = fin.ler_enviado(pasta)
        if (enviado and hashlib.sha256(conteudo).hexdigest() == enviado) or _mesma_planilha(conteudo, fin.ler_copia_enviada(pasta)):
            return "igual_base"
        return "divergente"

    def _importar_bloqueado(conteudo: bytes, numeros: Any, nome: str, automatico: bool):
        with lock_paths([_base_guard()]):
            ativa = _rotina_em_andamento()
            if ativa is None and services.runner is not None and (orfaos := fin.descartar_job_orfao(_pasta_estado())) is not None:  # mesma regra de ``_exigir_rotina_livre``
                logger.warning("Pedido de finalização órfão descartado (%s chamado(s)).", orfaos)
            if fin.job_pendente(_pasta_estado()) or (ativa is not None and ativa.get("rotina") in ("fechar", "enviar")):
                raise DomainConflictError("Aguarde a finalização em andamento antes de reimportar o Dashboard.")
            substituida = False
            if automatico and sebrae_novos.dashboard_saida_pendente(services.caminhos()):
                situacao = _classificar_saida_pendente(conteudo)  # before _guardar_importado replaces the base
                if situacao == "igual_base":
                    raise DomainConflictError("Há um Dashboard atualizado aguardando envio e o Dashboard do SharePoint não mudou desde a importação. Clique em Enviar ao SharePoint; a importação automática foi impedida para não perder alterações.")
                substituida = situacao == "divergente"
            # tudo o que a resposta e as gravações leem, ANTES de gravar: arquivo ilegível dá 503 sem gravar nada (``_estado`` roda no fim)
            anteriores = sebrae_novos.ler_existentes(services.caminhos().existentes, estrito=True)
            obs.ler_observacoes(_pasta_estado())
            fin.ler_estado(_pasta_estado())
            arquivo_marcas = marcas.caminho_marcas(_pasta_estado())
            marcas.validar_legivel(arquivo_marcas)  # marks unreadable: stop before anything of this import is written
            mapa = _arquivar_encerrados(conteudo, anteriores)
            _registrar_marcas(arquivo_marcas, mapa, anteriores)
            preservada = _guardar_importado(conteudo, numeros, nome)
            avisos = []
            aviso_senhas = _apagar_senhas_encerradas(mapa, anteriores)  # after the new base is stored: a failed import prunes nothing
            if aviso_senhas:
                avisos.append(aviso_senhas)
            aviso_linhas = _acompanhar_chaves_de_linha(anteriores)  # after the new base is stored: a retry never moves keys twice
            historico_ok = _registrar_historico(conteudo, nome, anteriores)
            # ia=False: the optional AI call (network, up to ~8 s) must not hold the file lock; the next GET fills the suggestions
            corpo = {**_estado(ia=False), "historico_ok": historico_ok, "arquivo_ok": True, "saida_anterior_preservada": preservada is not None}
            if substituida and preservada is not None:
                corpo["saida_pendente_substituida"] = True
                avisos.append(
                    "O Dashboard no SharePoint foi editado depois da última importação (por exemplo, linha preenchida à mão ou linhas reordenadas). "
                    "A cópia gerada por Atualizar Dashboard não podia mais ser enviada sem apagar essas edições; "
                    f"ela foi guardada em data/state/sebrae_dashboard_saida/preservados/{preservada.name}. "
                    "O rascunho da tela continua: confira os cartões, clique em Atualizar Dashboard e depois em Enviar ao SharePoint."
                )
            if aviso_linhas:
                avisos.append(aviso_linhas)
            if avisos:
                corpo["aviso"] = " ".join(avisos)
            return JSONResponse(corpo, headers={"Cache-Control": "no-store"})

    def _acompanhar_chaves_de_linha(anteriores: Optional[Mapping[str, Any]]) -> str:
        """Chamados antigos sem UTIC têm a chave ``linha:<n>``; se a planilha mudou de ordem, a observação e o destaque seguem o chamado
        de mesmo conteúdo (C, G, I, H) e único nas duas importações. Devolve o aviso dos que não deu para seguir ('' se nenhum)."""
        atuais = sebrae_novos.ler_existentes(services.caminhos().existentes)
        if not anteriores or not atuais or not atuais["abertos"]:
            return ""
        mapa = sebrae_novos.mapear_chaves_de_linha(anteriores["abertos"], atuais["abertos"])
        try:
            sem_rastro = obs.acompanhar_chaves(_pasta_estado(), mapa) if any(nova != antiga for antiga, nova in mapa.items()) else []
        except Exception as erro:  # noqa: BLE001 - the import is already stored (a retry would see an identity mapping): say what was left behind, log only the type
            logger.warning("Observações dos chamados sem UTIC não foram movidas para as novas linhas (%s).", type(erro).__name__)
            return (
                "Não consegui mover as observações e os destaques dos chamados antigos sem UTIC para as novas linhas da planilha "
                "(registro de observações ocupado ou ilegível). Confira as observações dos chamados sem UTIC."
            )
        if not sem_rastro:
            return ""
        return (
            "As linhas da planilha mudaram de lugar e não consegui seguir com segurança (conteúdo repetido ou ausente) a observação ou o destaque de: "
            f"{', '.join(sem_rastro[:10])}{' e outros' if len(sem_rastro) > 10 else ''}. Eles continuam nesses números de linha; confira em qual chamado estão."
        )

    def _arquivar_encerrados(conteudo: bytes, anteriores: Optional[Mapping[str, Any]]) -> Mapping[str, Mapping[str, str]]:
        """Tickets that left the open list go to the permanent archive; unlike the history, a failure blocks the import
        (the previous Dashboard stays in place, so a retry still sees the same tickets leaving). Returns the new Dashboard's
        ticket statuses, which the marks of the OS tab reuse."""
        try:
            mapa = ler_status_chamados(conteudo)
        except DashboardInvalido as erro:
            raise DomainValidationError(str(erro), status_code=422) from None
        try:
            sebrae_arquivo.registrar_saidas(
                sebrae_novos.caminho_arquivo(services.caminhos()),
                abertos_antes=anteriores["abertos"] if anteriores else [], mapa=mapa,
                visto_em=str(anteriores["importado_em"]) if anteriores else "", sha256=hashlib.sha256(conteudo).hexdigest(),
            )
        except Exception as erro:  # noqa: BLE001 - log only the type, never ticket data
            logger.warning("Arquivo de chamados encerrados não gravado (%s).", type(erro).__name__)
            raise DomainBusyError(
                "Não foi possível guardar os chamados encerrados; o Dashboard não foi importado e o anterior foi mantido. "
                "Tente novamente."
            ) from None
        return mapa

    def _apagar_senhas_encerradas(mapa: Mapping[str, Mapping[str, str]], anteriores: Optional[Mapping[str, Any]]) -> str:
        """Stored F5 password of a ticket closed (D FINALIZADO) or gone from column C in this import (FINALIZADO always; the gone-from-C ones obey the count limit); never blocks the import.
        Returns a warning (counts only, no ticket numbers) when the gone-from-C cleanup was skipped for deleting too many at once, else ''."""
        try:
            resultado = sebrae_credenciais.remover_encerrados(_pasta_estado(), mapa, anteriores["abertos"] if anteriores else [])
        except Exception as erro:  # noqa: BLE001 - log only the type, never ticket data
            logger.warning("Senhas guardadas dos chamados encerrados não apagadas (%s).", type(erro).__name__)
            return ""
        if not resultado.pulado:
            return ""
        return (
            f"A importação apagaria {resultado.previstas_saida} senhas guardadas de chamados que sumiram da coluna C "
            f"(de {resultado.guardadas} guardadas); essas não foram apagadas. Confira se a planilha está completa."
        )

    def _resolvedor_os(abertos: Sequence[Mapping[str, Any]]) -> marcas.Resolvedor:
        """Link UTIC -> OS for the mark of the OS tab: manual wins over the one derived from ``abertos``; several OS give the highest."""
        def derivados() -> List[Dict[str, Any]]:
            # These callers WRITE (marks, frozen OS): an unreadable refusal file must not let a strong-key swap through.
            recusadas = sebrae_os_recusadas.ler_ou_none(_pasta_estado())
            return sebrae_vinculos.vinculos_derivados(
                abertos, _relatorio(), _indice_endpoint(), recusadas, chave_forte=recusadas is not None,
                manuais=list(services.vinculos_os()),
            )

        return marcas.resolvedor(list(services.vinculos_os()), derivados)

    def _registrar_marcas(arquivo, mapa: Mapping[str, Mapping[str, str]], anteriores: Optional[Mapping[str, Any]]) -> None:
        """Source c of the marks: a UTIC open in the previous import, gone from the new one and not finalized by this site.
        Only an unreadable or busy marks file (``DomainBusyError``) blocks the import; any other failure is logged and the import goes on."""
        if not anteriores or not anteriores.get("abertos"):
            return
        try:
            saidas = marcas.detectar_saidas(
                anteriores["abertos"], mapa, fin.ler_estado(_pasta_estado()), _resolvedor_os(anteriores["abertos"]),
            )
            marcas.registrar_saidas(arquivo, saidas)
        except DomainBusyError:
            raise
        except Exception as erro:  # noqa: BLE001 - log only the type, never ticket data
            logger.warning("Marcas de OS finalizada não registradas na importação (%s).", type(erro).__name__)

    def _congelar_os_vinculada(pasta, numeros: Sequence[str]) -> None:
        """Photo of the OS linked to each ticket whose finalization was just requested; it never blocks the finalization."""
        try:
            importado = sebrae_novos.ler_existentes(services.caminhos().existentes)
            resolver = _resolvedor_os(importado["abertos"] if importado else [])
        except Exception as erro:  # noqa: BLE001
            logger.warning("OS vinculada não congelada (%s).", type(erro).__name__)
            return
        for numero in numeros:
            try:
                fin.congelar_os_vinculada(pasta, numero, resolver(numero))
            except Exception as erro:  # noqa: BLE001 - log only the type, never ticket data
                logger.warning("OS vinculada não congelada (%s).", type(erro).__name__)

    def _registrar_historico(conteudo: bytes, nome: str, anteriores: Optional[Mapping[str, Any]]) -> bool:
        """The history never blocks an import: a failure only turns ``historico_ok`` false."""
        try:
            sebrae_historico.registrar_importacao(
                services.caminhos().historico, arquivo=nome, sha256=hashlib.sha256(conteudo).hexdigest(),
                mapa=ler_status_chamados(conteudo), base_numeros=anteriores["numeros"] if anteriores else None,
            )
            return True
        except Exception as erro:  # noqa: BLE001 - log only the type, never ticket data
            logger.warning("Histórico do Dashboard Sebrae não gravado (%s).", type(erro).__name__)
            return False

    @router.get("/api/sebrae/historico")
    def listar_historico(
        limite: int = Query(50, ge=1, le=200),
        pagina: int = Query(1, ge=1, le=1000),
        tipo: str = Query("", pattern="^(importacao|busca)?$"),
    ):
        """Importações e buscas, da mais recente para a mais antiga; itens leves (só contagens)."""
        try:
            corpo = sebrae_historico.listar(services.caminhos().historico, limite, pagina, tipo)
        except sebrae_historico.HistoricoIlegivel as erro:
            raise DomainBusyError(str(erro)) from None
        return JSONResponse(corpo, headers={"Cache-Control": "no-store"})

    @router.get("/api/sebrae/historico/{entrada_id}")
    def detalhe_historico(entrada_id: str):
        try:
            entrada = sebrae_historico.obter(services.caminhos().historico, entrada_id)
        except sebrae_historico.HistoricoIlegivel as erro:
            raise DomainBusyError(str(erro)) from None
        if entrada is None:
            raise DomainValidationError("Entrada do histórico não encontrada.", status_code=404)
        return JSONResponse(entrada, headers={"Cache-Control": "no-store"})

    def _guardar_importado(conteudo: bytes, numeros: Any, nome: str) -> Optional[Path]:
        """Numbers, A/B lists and open tickets go to the JSON; the file itself is kept for "Atualizar Dashboard".
        A Dashboard the writer cannot read still imports, so the paste flow keeps working.
        Returns the path the old output was moved to, or ``None`` when there was none."""
        caminhos = services.caminhos()
        preservada = None
        # a saída antiga vem da importação anterior; enviá-la ao SharePoint apagaria o que entrou desde então
        saida = sebrae_novos.caminho_saida(caminhos, NOME_ATUALIZADO)
        if saida.is_file():
            from uuid import uuid4
            preservada = saida.parent / "preservados" / f"{uuid4().hex}.xlsx"
            preservada.parent.mkdir(parents=True, exist_ok=True)
            saida.replace(preservada)  # only after the complete copy has a safe destination; never delete pending edits
        try:  # a origem da saída e os conflitos pertencem à importação anterior; com a nova, valem de novo só depois de Atualizar
            fin.apagar_origem_saida(saida)
            fin.limpar_conflitos(fin.pasta_estado(caminhos.existentes))
        except OSError:
            logger.warning("Não apaguei a origem da saída nem os conflitos da importação anterior.", exc_info=True)
        try:
            listas = sebrae_dashboard_gravacao.ler_listas(conteudo)
            abertos = [c.como_dict() for c in sebrae_dashboard_gravacao.chamados_para_editar(conteudo)]
            sha256 = sebrae_novos.salvar_planilha(sebrae_novos.caminho_planilha(caminhos), conteudo)
        except DashboardInvalido:
            listas, abertos, sha256 = {}, [], ""
        sebrae_novos.salvar_existentes(caminhos.existentes, numeros, nome, sha256=sha256, listas=listas, abertos=abertos)
        if sha256:  # sem planilha legível não há o que aprender
            _reindexar_categoria(conteudo)
        return preservada

    @router.post("/api/sebrae/exportar")
    def exportar(payload: ExportarPayload):
        """Blocos A:P e R:S dos chamados enviados; 422 se faltar campo manual ou o chamado já não for novo."""
        caminhos = services.caminhos()
        importado = sebrae_novos.ler_existentes(caminhos.existentes)
        if importado is None:
            raise DomainValidationError("Importe o Dashboard antes de exportar.", status_code=422)
        novos = _novos(caminhos, importado["numeros"])
        if novos is None:
            raise DomainValidationError("Busque os chamados novos antes de exportar.", status_code=422)
        manuais = {item.numero: item.model_dump(exclude={"numero"}) for item in payload.chamados}
        if len(manuais) != len(payload.chamados):
            raise DomainValidationError("Há chamados repetidos na exportação.", status_code=422)
        escolhidos = [c for c in novos["chamados"] if c.numero in manuais]
        desconhecidos = sorted(set(manuais) - {c.numero for c in escolhidos})
        if desconhecidos:
            raise DomainValidationError(f"{desconhecidos[0]} não está entre os chamados novos.", status_code=422)
        try:
            resultado = sebrae_novos.exportar(escolhidos, manuais, services.registros(), _relatorio(), importado["listas"], services.vinculos_os())
        except sebrae_novos.ManuaisInvalidos as erro:
            raise DomainValidationError(str(erro), status_code=422) from None
        return JSONResponse(resultado, headers={"Cache-Control": "no-store"})

    @router.post("/api/sebrae/dashboard/atualizar")
    def atualizar_dashboard(payload: AtualizarPayload):
        """Cópia do Dashboard importado com os chamados novos e as edições; o original e a cópia guardada ficam intactos.

        Responsável, Status e Tipo podem ficar em branco (a linha é gravada sem eles). Série, Modelo, Cidade e OS vazios dos
        antigos em aberto são preenchidos pelo nome da coluna I. 422 se não houver importação válida, se um Status/Tipo
        preenchido for inválido, se o chamado repetir ou se a Tabela3 não tiver linhas livres."""
        with lock_paths([_base_guard()]):
            _exigir_versao(payload.versao_importacao)
            confirmados = dict.fromkeys(payload.confirmar_outro_tecnico, "") if payload.finalizar_softexpert else None
            importado, resultado, conteudo, gravada, edicoes = _gravar_atualizacao(payload, exigir_encerramento=True, confirmados=confirmados)
            fechar = (
                _fechar_inativo("A cópia de saída não foi gravada; nada foi finalizado.") if not gravada
                else _finalizar_marcados({**{c.numero: {"D": c.D, "R": c.R} for c in payload.chamados}, **edicoes}, payload.confirmar_outro_tecnico)
                if payload.finalizar_softexpert
                else _fechar_inativo("finalização no SoftExpert não confirmada")
            )
            return JSONResponse({
                "arquivo": NOME_ATUALIZADO,
                "base": {"arquivo": importado["arquivo"], "importado_em": importado["importado_em"]},
                "linhas": [
                    {"numero": g.numero, "linha": g.linha, "tipo": g.tipo, "celulas": list(g.celulas)} for g in resultado.linhas
                ],
                "conteudo_base64": base64.b64encode(conteudo).decode("ascii"),
                "fechar": fechar,
                "enviar": _enviar_apos_atualizar(
                    payload.enviar_sharepoint, gravada, bool(fechar["iniciado"]), payload.finalizar_softexpert,
                ),
            }, headers={"Cache-Control": "no-store"})

    def _enviar_apos_atualizar(pedido: bool, gravada: bool, fechar_iniciada: bool, finalizar_pedido: bool = False) -> Dict[str, Any]:
        """Starts ``enviar`` right after the copy is saved, unless ``fechar`` runs (it already sends); a failure never fails the update."""
        if not gravada:
            return {"iniciado": False, "motivo": "A cópia de saída não foi gravada; nada foi enviado."}
        if fechar_iniciada:
            return {"iniciado": False, "motivo": "a rotina fechar já envia ao SharePoint"}
        if finalizar_pedido:
            # Finalizar pedido e nada finalizado: enviar gravaria D=FINALIZADO sem SoftExpert e geraria marca falsa de outro técnico.
            return {"iniciado": False, "motivo": "nenhum chamado foi finalizado no SoftExpert"}
        if not pedido:
            return {"iniciado": False, "motivo": ""}
        return _iniciar_envio()

    def _iniciar_envio() -> Dict[str, Any]:
        """Starts the routine ``enviar`` with the same guards for both callers; a failure comes back as ``motivo``, never as an error."""
        if services.runner is None:
            return {"iniciado": False, "motivo": "A automação não está disponível neste servidor."}
        pasta = _pasta_estado()
        try:
            fin.exigir_envio_livre(pasta)
            _exigir_rotina_livre(pasta)
            services.runner().start("enviar")
        except DomainError as erro:
            return {"iniciado": False, "motivo": str(erro.detail)}
        except Exception as erro:  # noqa: BLE001 - o arquivo já foi gravado; log só o tipo
            logger.warning("Não iniciei a rotina enviar (%s).", type(erro).__name__)
            return {"iniciado": False, "motivo": "Não foi possível iniciar o envio ao SharePoint."}
        return {"iniciado": True, "motivo": ""}

    def _gravar_atualizacao(
        payload: AtualizarPayload, *, aceita_vazio: bool = False, exigir_encerramento: bool = False,
        confirmados: Optional[Mapping[str, str]] = None,
    ):
        """Monta a cópia atualizada e a grava em ``sebrae_dashboard_saida``; devolve (importado, resultado, conteudo, gravada, edicoes validadas).

        Com ``aceita_vazio`` e nada a gravar, devolve ``None`` em vez de 422. Com ``exigir_encerramento`` (só o "Atualizar"),
        D=FINALIZADO à mão (novo ou antigo) exige a coluna R (regra de 24/11/2026); o ``finalizar-softexpert`` por cartão confere só o
        próprio chamado, antes de chamar esta função.

        ``confirmados`` (só pedidos que disparam a ``fechar``): ``{UTIC confirmado como finalizado por outro técnico: R a conferir}``
        (``""`` = o R do chamado). Cada um passa por ``_exigir_outro_tecnico`` antes de gravar; o não encontrado na leitura e não
        confirmado vai à cópia sem D e R (a ``fechar`` grava os dois se achar o chamado), senão iria ao SharePoint como FINALIZADO."""
        caminhos = services.caminhos()
        importado = sebrae_novos.ler_existentes(caminhos.existentes)
        if importado is None:
            raise DomainValidationError("Importe o Dashboard antes de atualizar.", status_code=422)
        planilha = sebrae_novos.ler_planilha(sebrae_novos.caminho_planilha(caminhos), importado["sha256"])
        if planilha is None:
            raise DomainValidationError(
                "A cópia do Dashboard importado não está disponível ou mudou; importe o Dashboard de novo.", status_code=422,
            )
        try:
            if exigir_encerramento:
                for novo in payload.chamados:
                    if novo.D.strip().upper() == sebrae_novos.STATUS_FINALIZADO and not _tem_encerramento(novo.numero, novo.R):
                        raise sebrae_novos.ManuaisInvalidos(_falta_encerramento(novo.numero))
            linhas = _linhas_novas(payload, importado, caminhos)
            edicoes = _edicoes(payload, planilha, importado["listas"], exigir_encerramento)
            abertos = [c.como_dict() for c in sebrae_dashboard_gravacao.chamados_para_editar(planilha)]
            if confirmados:  # valores que vão à cópia: os mesclados das edições, os do novo ou os já gravados
                guardados: Dict[str, Any] = {str(a["numero"]): a["valores"] for a in abertos}
                novos = {c.numero: c.model_dump() for c in payload.chamados}
                for numero, r in confirmados.items():
                    valores: Mapping[str, Any] = edicoes.get(numero) or novos.get(numero) or guardados.get(numero) or {}
                    _exigir_outro_tecnico(numero, {**valores, "R": r} if r else valores)
            antigos = _leitura_antigos() if abertos else {}
            registros = services.registros() if abertos else []
            relatorio, indice = (_relatorio(), _indice_endpoint()) if abertos else (None, None)
            automaticos = _automaticos_dos_abertos(abertos, antigos, registros, relatorio, indice) if abertos else {}
            trocas = sebrae_os_nova.trocas_e(
                _os_novas_dos_abertos(abertos, antigos, registros, automaticos, relatorio, indice), abertos, list(services.vinculos_os()),
            )
            limpar = _limpar_e_dos_abertos(abertos, trocas)
            descricoes = _descricoes_editadas_dos_antigos(abertos)
            if not linhas and not edicoes and not automaticos and not descricoes and not trocas and not limpar:
                if aceita_vazio:
                    return None
                raise DomainValidationError("Não há chamados novos, alterações nem dados para preencher.", status_code=422)
            gravar = {**edicoes, **{n: {**edicoes.get(n, {}), "H": h} for n, h in descricoes.items()}}
            if confirmados is not None:  # em branco não apaga: fica o D e o R da cópia importada
                perdidos = _nao_encontrados(antigos) - set(confirmados)
                gravar = {
                    n: ({**v, "D": "", "R": ""} if n in perdidos and v.get("D") == sebrae_novos.STATUS_FINALIZADO else v)
                    for n, v in gravar.items()
                }
            resultado = sebrae_dashboard_gravacao.atualizar(planilha, linhas, gravar, automaticos, trocas, limpar)
        except (sebrae_novos.ManuaisInvalidos, DashboardInvalido) as erro:
            raise DomainValidationError(str(erro), status_code=422) from None
        conteudo = _reaplicar_encerramentos(resultado.conteudo)
        saida = sebrae_novos.caminho_saida(caminhos, NOME_ATUALIZADO)
        gravada = False
        try:
            with lock_paths([saida]):  # a rotina fechar grava a coluna R neste mesmo arquivo
                fin.apagar_origem_saida(saida)  # sem o JSON de origem, a saída nunca é mesclada com o SharePoint
                sebrae_novos.salvar_planilha(saida, conteudo)
                try:
                    fin.gravar_origem_saida(saida, importado["sha256"])  # a coluna R, gravada depois, não muda a base
                except (OSError, RuntimeError):
                    logger.warning("Não gravei a origem da cópia de saída do Dashboard.", exc_info=True)
            gravada = True
            _reindexar_categoria(conteudo)  # aprende com o B e o J que o usuário acabou de classificar
        except OSError:  # o download do usuário segue; só o "Enviar ao SharePoint" fica sem arquivo
            logger.warning("Não gravei a cópia de saída do Dashboard.", exc_info=True)
        return importado, resultado, conteudo, gravada, edicoes

    def _descricoes_editadas_dos_antigos(abertos: Sequence[Mapping[str, Any]]) -> Dict[str, str]:
        """``{chave: texto}`` da descrição editada no lápis do cartão, para a coluna H dos antigos em aberto cujo H é diferente.

        Só vale para chave UTIC (``linha:<n>`` nunca tem texto editado). Vai só à cópia do Dashboard: o SoftExpert e a rotina
        ``fechar`` nunca a recebem. Texto vazio não chega aqui (restaurar não apaga um H já gravado)."""
        editadas = fin.descricoes_editadas(_pasta_estado())
        if not editadas:
            return {}
        textos = {a["numero"]: (sebrae_novos.descricao_para_celula(editadas[a["numero"]]), a["descricao"]) for a in abertos if a["numero"] in editadas}
        return {n: novo for n, (novo, atual) in textos.items() if novo and not sebrae_dashboard_gravacao.h_ja_gravado(novo, atual)}

    def _reaplicar_encerramentos(conteudo: bytes) -> bytes:
        """A saída é refeita da cópia importada a cada "Atualizar": as datas de encerramento registradas ao finalizar (o R que o usuário informou) voltam à coluna R."""
        encerramentos = fin.encerramentos_registrados(_pasta_estado())
        if not encerramentos:
            return conteudo
        try:
            return sebrae_dashboard_gravacao.registrar_encerramentos(conteudo, encerramentos)[0].conteudo
        except Exception as erro:  # noqa: BLE001 - a atualização não pode falhar por isso; log só o tipo
            logger.warning("Datas de encerramento não reaplicadas à saída (%s).", type(erro).__name__)
            return conteudo

    def _fechar_inativo(motivo: str, pulados: Sequence[Mapping[str, str]] = ()) -> Dict[str, Any]:
        return {"iniciado": False, "motivo": motivo, "numeros": [], "pulados": [dict(p) for p in pulados]}

    def _encerramentos_manuais(com_r: Mapping[str, str]) -> Dict[str, str]:
        """``{UTIC: R}`` dos que a última leitura do SoftExpert não achou (regra do usuário, 12/11/2026): se a ``fechar`` também não os achar,
        o R do usuário os registra como finalizados por outro técnico. Chamado achado na leitura nunca entra aqui.
        Quem chama passa só os confirmados pelo usuário (decisão de 25/11/2026)."""
        if not com_r:
            return {}
        perdidos = _nao_encontrados(_leitura_antigos())
        return {numero: r for numero, r in com_r.items() if numero in perdidos}

    def _finalizar_marcados(edicoes: Mapping[str, Mapping[str, str]], confirmados: Iterable[str] = ()) -> Dict[str, Any]:
        """Tickets (old edits and new rows) whose D the user just set to FINALIZADO go to the ``fechar`` routine; a failure here never fails the update."""
        pasta = _pasta_estado()
        numeros: List[str] = []
        pulados: List[Dict[str, str]] = []
        com_r: Dict[str, str] = {}
        for chave, valores in edicoes.items():
            if str(valores.get("D") or "").strip().upper() != sebrae_novos.STATUS_FINALIZADO:
                continue
            try:
                numero = chave_do_numero(chave)  # "linha:<n>" (sem UTIC) nunca chega ao SoftExpert
            except ValueError:
                pulados.append({"numero": chave, "motivo": "sem_numero"})
                continue
            if fin.ja_finalizado(pasta, numero):
                pulados.append({"numero": numero, "motivo": fin.STATUS_JA_FINALIZADO})
            elif not fin.dados_para_finalizar(pasta, numero)[0]:
                pulados.append({"numero": numero, "motivo": fin.STATUS_SEM_DESCRICAO})
            elif not fin.encerramento_valido(valores.get("R")):
                pulados.append({"numero": numero, "motivo": fin.STATUS_SEM_ENCERRAMENTO})  # regra de 24/11/2026: sem R, não finaliza
            else:
                numeros.append(numero)
                com_r[numero] = fin.encerramento_valido(valores.get("R"))
        if not numeros:
            return _fechar_inativo("", pulados)
        try:
            confirmados = set(confirmados)
            manuais = _encerramentos_manuais({n: r for n, r in com_r.items() if n in confirmados})
            _disparar(numeros, pulados, encerramentos_manuais=manuais, encerramentos=com_r)
        except DomainError as erro:
            return _fechar_inativo(str(erro.detail), pulados)
        return {"iniciado": True, "motivo": "", "numeros": numeros, "pulados": pulados}

    def _rotina_em_andamento() -> Optional[Mapping[str, Any]]:
        """Estado do runner quando alguma rotina roda agora; ``None`` se está livre (ou sem runner: quem chama já recusa antes)."""
        if services.runner is None:
            return None
        ativo = services.runner().state()
        return ativo if ativo.get("estado") == "em_andamento" else None

    def _exigir_rotina_livre(pasta) -> None:
        """409 quando há pedido de finalização esperando ou uma rotina rodando; um runner sem estado legível deixa o ``start`` decidir."""
        try:
            ativa = _rotina_em_andamento()
        except Exception as erro:  # noqa: BLE001
            logger.warning("Não foi possível ler o estado da rotina antes da finalização (%s).", type(erro).__name__)
            if fin.job_pendente(pasta):
                raise DomainConflictError("Já há um pedido de finalização esperando a rotina começar. Aguarde terminar.") from None
            return
        if ativa is None and services.runner is not None and (orfaos := fin.descartar_job_orfao(pasta)) is not None:  # nenhuma rotina rodando e o pedido nunca foi consumido
            logger.warning("Pedido de finalização órfão descartado (%s chamado(s)).", orfaos)
        if fin.job_pendente(pasta):
            raise DomainConflictError("Já há um pedido de finalização esperando a rotina começar. Aguarde terminar.")
        if ativa is not None:
            raise DomainConflictError("Já há uma rotina em execução. Aguarde terminar.")

    def _disparar(
        numeros: Sequence[str], pulados: Sequence[Mapping[str, str]] = (), acao: str = fin.ACAO_FINALIZAR, *, envio_id: str = "", sha256: str = "",
        encerramentos_manuais: Mapping[str, str] = {}, encerramentos: Mapping[str, str] = {},
    ) -> None:
        """Writes the one-shot job and starts ``fechar`` under one lock on the job file: two requests cannot overwrite each other's job.

        409 when a run is in progress or another job still waits; the job is removed if the routine does not start."""
        if services.runner is None:
            raise DomainBusyError("A automação não está disponível neste servidor.")
        runner = services.runner()
        pasta = _pasta_estado()
        with lock_paths([_base_guard(), fin.caminho_envio(pasta), fin.caminho_job(pasta)]):
            _exigir_rotina_livre(pasta)
            if acao == fin.ACAO_REENVIAR_SNAPSHOT:
                try:
                    estado = runner.state().get("estado")
                except Exception as error:
                    raise DomainBusyError("Não foi possível confirmar que a automação está livre.") from error
                if estado not in ("livre", "em_andamento"):
                    raise DomainBusyError("O estado da automação é desconhecido.")
                if estado != "livre":
                    raise DomainConflictError("Aguarde a rotina em andamento antes de reenviar esta cópia.")
                fin.gravar_job(pasta, numeros, pulados=pulados, acao=acao, envio_id=envio_id, sha256=sha256)
            else:
                if acao == fin.ACAO_FINALIZAR:
                    _congelar_os_vinculada(pasta, numeros)  # before the job: the link may change while the routine runs
                fin.gravar_job(pasta, numeros, pulados=pulados, acao=acao, encerramentos_manuais=encerramentos_manuais, encerramentos=encerramentos)
            try:
                runner.start("fechar")
            except BaseException:
                fin.apagar_job(pasta)
                raise

    def _exigir_finalizavel(numero: str) -> str:
        """Antigo EM ABERTO/sem status do Dashboard importado ou novo da última busca (ainda fora do Dashboard)."""
        numero = fin.validar_numero(numero)
        caminhos = services.caminhos()
        importado = sebrae_novos.ler_existentes(caminhos.existentes)
        if importado is None:
            raise DomainValidationError("Importe o Dashboard antes.", status_code=422)
        if numero in {str(a.get("numero")) for a in importado["abertos"]}:
            return numero
        novos = sebrae_novos.ler_novos(caminhos.novos, importado["numeros"])
        if novos is not None and any(c.numero == numero for c in novos["chamados"]):
            return numero
        raise DomainValidationError(f"{numero} não é um chamado antigo EM ABERTO nem um chamado novo da busca.", status_code=422)

    @router.put("/api/sebrae/chamados/{numero}/finalizacao")
    def definir_descricao(numero: str, payload: DescricaoPayload):
        """Texto de "Detalhes do Atendimento Realizado" deste chamado; vazio apaga."""
        numero = _exigir_finalizavel(numero)
        item = fin.definir_descricao(_pasta_estado(), numero, payload.descricao_finalizacao)
        return JSONResponse({"numero": numero, **fin.publico(item)}, headers={"Cache-Control": "no-store"})

    @router.put("/api/sebrae/chamados/{numero}/descricao")
    def definir_descricao_editada(numero: str, payload: DescricaoEditadaPayload):
        """Lápis do cartão: texto do bloco "Descrição" editado neste site. Vai à coluna H da cópia do Dashboard no próximo "Atualizar"
        (linha nova ou antigo em aberto de chave UTIC); o SoftExpert e a rotina ``fechar`` nunca o recebem. Vazio restaura o original só
        no site: não apaga nem desfaz um H já enviado (o usuário corrige à mão no Dashboard)."""
        numero = _exigir_finalizavel(numero)
        item = fin.definir_descricao_editada(_pasta_estado(), numero, sebrae_novos.descricao_segura(payload.descricao))
        # `descricao` = o que o cartão passa a mostrar; ao restaurar, o texto original lido do SoftExpert
        return JSONResponse(
            {"numero": numero, "descricao": item.get("descricao_editada") or _descricao_original(numero), **fin.publico(item)},
            headers={"Cache-Control": "no-store"},
        )

    def _descricao_original(numero: str) -> str:
        caminhos = services.caminhos()
        novos = sebrae_novos.ler_novos(caminhos.novos)
        achado = next((c.descricao for c in novos["chamados"] if c.numero == numero), None) if novos else None
        if achado is not None:
            return achado
        # antigo: a coluna H do Dashboard vale primeiro (o cartão mostra a mesma), depois a leitura do SoftExpert
        importado = sebrae_novos.ler_existentes(caminhos.existentes)
        no_dashboard = next((str(a.get("descricao") or "") for a in (importado or {}).get("abertos", []) if str(a.get("numero")) == numero), "")
        return no_dashboard or sebrae_novos.ler_antigos(sebrae_novos.caminho_antigos(caminhos)).get(numero, {}).get("descricao", "")

    @router.put("/api/sebrae/chamados/{numero}/ficha")
    def definir_ficha(numero: str, payload: FichaPayload):
        """Cartão do chamado como estava na tela ao finalizar; aparece de novo em "Chamados finalizados"."""
        numero = _exigir_finalizavel(numero)
        fin.definir_ficha(_pasta_estado(), numero, payload.ficha)
        return JSONResponse({"numero": numero}, headers={"Cache-Control": "no-store"})

    @router.put("/api/sebrae/chamados/{numero}/observacao")
    def definir_observacao(numero: str, payload: ObservacaoPayload):
        """Anotação interna do chamado (salva automaticamente em disco, sem tocar SoftExpert nem Dashboard)."""
        resultado = obs.salvar_observacao(_pasta_estado(), numero, payload.observacao)
        return JSONResponse(resultado, headers={"Cache-Control": "no-store"})

    @router.put("/api/sebrae/chamados/{numero}/os-recusada")
    def recusar_os(numero: str, payload: OsRecusadaPayload):
        """Recusa (ou mantém) a OS sugerida: o par chamado + OS nunca mais é sugerido nem trocado sozinho (só local)."""
        sebrae_os_recusadas.recusar(_pasta_estado(), numero, payload.os)
        return JSONResponse({"ok": True}, headers={"Cache-Control": "no-store"})

    @router.put("/api/sebrae/chamados/{numero}/os-manter")
    def manter_os(numero: str, payload: OsRecusadaPayload):
        """Mantém a OS que já está na E (aviso "sem relação" encerrado); só local, nada é gravado no Dashboard."""
        sebrae_os_recusadas.manter(_pasta_estado(), numero, payload.os)
        return JSONResponse({"ok": True}, headers={"Cache-Control": "no-store"})

    @router.put("/api/sebrae/chamados/{numero}/os-remover")
    def remover_os(numero: str, payload: OsRecusadaPayload):
        """Recusa a OS e manda limpar a E: a próxima gravação do Dashboard esvazia só a E que ainda for essa OS."""
        sebrae_os_recusadas.remover(_pasta_estado(), numero, payload.os)
        return JSONResponse({"ok": True}, headers={"Cache-Control": "no-store"})

    @router.put("/api/sebrae/chamados/{numero}/destaque")
    def definir_destaque(numero: str, payload: DestaquePayload):
        """Destaque manual do chamado (só local, inclusive finalizado; fica até o usuário tirar)."""
        resultado = obs.definir_destaque(_pasta_estado(), numero, payload.destaque)
        return JSONResponse(resultado, headers={"Cache-Control": "no-store"})

    @router.get("/api/sebrae/chamados/{numero}/credenciais")
    def credenciais_do_chamado(numero: str):
        """Senhas do chamado, só no clique em "Mostrar senha" do F5 (exceção de LGPD autorizada em 19/11/2026); nunca em log."""
        numero = fin.validar_numero(numero)
        return JSONResponse(
            {"numero": numero, "credenciais": sebrae_credenciais.ler(_pasta_estado(), numero)},
            headers={"Cache-Control": "no-store"},
        )

    @router.get("/api/sebrae/observacoes")
    def listar_observacoes():
        """Lista todas as anotações internas gravadas em disco."""
        return JSONResponse({"observacoes": obs.ler_observacoes(_pasta_estado())}, headers={"Cache-Control": "no-store"})

    @router.post("/api/sebrae/chamados/{numero}/anexo")
    async def anexar_pdf(numero: str, file: UploadFile = File(...)):
        """Um PDF opcional por chamado (extensão, assinatura %PDF e tamanho conferidos); o novo substitui o anterior."""
        numero = await asyncio.to_thread(_exigir_finalizavel, numero)
        limite = min(services.max_upload_bytes(), fin.MAX_PDF_BYTES)
        conteudo = await file.read(limite + 1)
        item = await asyncio.to_thread(fin.anexar_pdf, _pasta_estado(), numero, file.filename, conteudo, limite)
        return JSONResponse({"numero": numero, **fin.publico(item)}, headers={"Cache-Control": "no-store"})

    @router.delete("/api/sebrae/chamados/{numero}/anexo")
    def remover_pdf(numero: str, somente_pendentes: bool = False):
        numero = fin.validar_numero(numero) if somente_pendentes else _exigir_finalizavel(numero)
        pasta = _pasta_estado()
        try:
            item = fin.remover_pdf(pasta, numero, somente_pendentes=somente_pendentes)
        except DomainBusyError as error:
            item = fin.ler_estado(pasta).get(numero, {})
            if not item.get("pdf_remocao"):
                raise
            return JSONResponse({"numero": numero, **fin.publico(item), "detail": error.detail}, status_code=503, headers={"Cache-Control": "no-store"})
        return JSONResponse({"numero": numero, **fin.publico(item)}, headers={"Cache-Control": "no-store"})

    @router.post("/api/sebrae/finalizar-softexpert", status_code=202)
    def finalizar_softexpert(payload: FinalizarPayload):
        """Finaliza UM chamado no SoftExpert (botão por chamado). Irreversível: só antigos em aberto ou novos da busca, com descrição."""
        with lock_paths([_base_guard()]):
            _exigir_versao(payload.versao_importacao)
            if not payload.confirmado:
                raise DomainValidationError("Confirme a finalização no SoftExpert antes de enviar.", status_code=422)
            numero = _exigir_finalizavel(payload.numero)
            pasta = _pasta_estado()
            if fin.ja_finalizado(pasta, numero):
                raise DomainConflictError(f"{numero} já está entre os chamados finalizados.")
            if not fin.dados_para_finalizar(pasta, numero)[0]:
                raise DomainValidationError("Preencha a descrição para finalizar o chamado antes de finalizar.", status_code=422)
            # Regra de 24/11/2026: o R vem do usuário, nunca da hora atual; conferido antes de gravar a cópia (D=FINALIZADO sem SoftExpert não vai à saída).
            quando = _encerramento_do_pedido(payload, numero)
            if not quando:
                raise DomainValidationError(_falta_encerramento(numero), status_code=422)
            # Decisão do usuário (25/11/2026): só com a confirmação explícita o R vira "finalizado por outro técnico" (se a leitura não achou o chamado).
            confirmados = {numero: quando} if payload.confirmar_outro_tecnico else {}
            # Os campos manuais entram na cópia de saída antes da rotina, que depois só grava R e D: sem isso o Dashboard enviado ao SharePoint perderia A, B, J e S.
            if payload.chamados or payload.edicoes:
                if services.runner is not None:
                    _exigir_rotina_livre(pasta)  # a rotina ocupada recusa antes de refazer a cópia; _disparar confere de novo dentro do lock
                gravacao = _gravar_atualizacao(
                    AtualizarPayload(chamados=payload.chamados, edicoes=payload.edicoes, versao_importacao=payload.versao_importacao),
                    aceita_vazio=True, confirmados=confirmados,
                )
                if gravacao is not None and not gravacao[3]:
                    raise DomainBusyError("Não consegui gravar os campos manuais na cópia do Dashboard; nada foi finalizado.")
            elif confirmados:  # sem campos manuais no corpo, D nunca é FINALIZADO: recusa com o que falta
                importado = sebrae_novos.ler_existentes(services.caminhos().existentes) or {}
                guardado = next((a.get("valores") or {} for a in importado.get("abertos", []) if str(a.get("numero")) == numero), {})
                _exigir_outro_tecnico(numero, {**guardado, "R": quando})
            _disparar([numero], encerramentos_manuais=_encerramentos_manuais(confirmados), encerramentos={numero: quando})
            return JSONResponse({"iniciado": True, "numeros": [numero]}, status_code=202, headers={"Cache-Control": "no-store"})

    @router.post("/api/sebrae/finalizacao/desfazer-outro-tecnico")
    def desfazer_outro_tecnico(payload: DesfazerOutroTecnicoPayload):
        """Desfaz o registro local "finalizado por outro técnico": o chamado volta aos abertos para corrigir D e R pelo cartão.

        Só dados locais mudam (estado e último resultado da rotina); nada vai ao SoftExpert, ao SharePoint nem dispara rotina."""
        if not payload.confirmado:
            raise DomainValidationError("Confirme para desfazer a finalização.", status_code=422)
        numero = fin.validar_numero(payload.numero)
        pasta = _pasta_estado()
        with lock_paths([_base_guard(), fin.caminho_job(pasta)]):
            _exigir_rotina_livre(pasta)  # um pedido pendente com R manual registraria o chamado de novo
            try:  # aqui não há `start` depois para barrar: sem ler o runner, uma `fechar` rodando regravaria o resultado
                _rotina_em_andamento()
            except Exception as exc:  # noqa: BLE001
                raise DomainBusyError("Não foi possível conferir se há rotina em execução. Tente de novo.") from exc
            fin.exigir_outro_tecnico(pasta, numero)
            # O resultado vem antes do estado: se a gravação dele falhar, o estado continua igual e a nova tentativa funciona.
            resultado = fin.ler_resultado(pasta)
            itens = resultado.get("resultados") if isinstance(resultado, dict) else None
            if isinstance(itens, list):
                mudou = False
                for r in itens:
                    if isinstance(r, dict) and str(r.get("numero") or "").strip().upper() == numero:
                        r.update(status=fin.STATUS_NAO_ENCONTRADO, encerrado_em="")  # a tela não devolve o R nem o move de volta para Finalizados
                        mudou = True
                if mudou and resultado is not None:
                    fin.gravar_resultado(pasta, resultado)
            fin.desfazer_outro_tecnico(pasta, numero)
        return JSONResponse({"numero": numero, "desfeito": True}, headers={"Cache-Control": "no-store"})

    @router.get("/api/sebrae/finalizar-softexpert")
    def resultado_finalizacao():
        """Resultado da última rotina ``fechar`` (um item por chamado) e o aviso do SharePoint, se houver cópia pendente."""
        pasta = _pasta_estado()
        resultado = fin.ler_resultado(pasta)
        rodando = False
        if services.runner is not None:
            try:
                ativo = _rotina_em_andamento()
                rodando = ativo is not None and ativo.get("rotina") == "fechar"
            except Exception as erro:  # noqa: BLE001 - sem o estado do runner, vale o que o arquivo diz
                logger.warning("Não foi possível ler o estado da rotina de fechar (%s).", type(erro).__name__)
                rodando = bool(resultado and resultado.get("em_andamento"))
        return JSONResponse({
            "em_andamento": rodando, "resultado": resultado, "sharepoint": fin.aviso_do_pendente(pasta),
            "conflitos": len((fin.ler_conflitos(pasta) or {}).get("conflitos") or []),
        }, headers={"Cache-Control": "no-store"})

    def _com_titulo_e_solicitante(conflitos: List[Any], atual: Optional[Mapping[str, Any]]) -> List[Any]:
        """Cópia de cada conflito com ``titulo`` (G) e ``solicitante`` (I) do chamado, só para a tela: nunca gravados nem em log.

        Fonte: a base importada (``abertos``, que já guarda G e I; a chave é o UTIC só quando ele é único na planilha) e, para
        chamado novo ausente da base, ``sebrae_novos.json``. ``linha:<n>``, UTIC repetido ou não achado: vazio, sem adivinhar a linha."""
        fontes: Dict[str, Tuple[str, str]] = {}
        if atual:
            novos = sebrae_novos.ler_novos(services.caminhos().novos) or {}
            for chamado in novos.get("chamados") or []:
                if chamado.numero not in atual["numeros"]:  # na base, só a linha da base vale (repetido fica vazio)
                    fontes.setdefault(chamado.numero, (chamado.titulo, chamado.solicitante))
            for aberto in atual["abertos"]:
                numero = str(aberto.get("numero") or "")
                if numero and not numero.startswith(sebrae_dashboard_gravacao.CHAVE_DE_LINHA):
                    fontes[numero] = (str(aberto.get("titulo") or ""), str(aberto.get("usuario") or ""))
        saida: List[Any] = []
        for conflito in conflitos:
            if isinstance(conflito, dict):
                titulo, solicitante = fontes.get(str(conflito.get("chamado") or ""), ("", ""))
                conflito = {**conflito, "titulo": mascarar_cpfs(titulo), "solicitante": mascarar_cpfs(solicitante)}
            saida.append(conflito)
        return saida

    @router.get("/api/sebrae/dashboard/conflitos")
    def listar_conflitos():
        """Células em conflito entre o SharePoint e o site (valores só aqui e na tela) e as escolhas já feitas; vazio sem conflito."""
        dados = fin.ler_conflitos(_pasta_estado()) or {}
        atual = sebrae_novos.ler_existentes(services.caminhos().existentes)
        return JSONResponse({
            "conflitos": _com_titulo_e_solicitante(dados.get("conflitos") or [], atual), "escolhas": fin.escolhas_dos_conflitos(_pasta_estado()),
            "criado_em": str(dados.get("criado_em") or ""), "versao_importacao": atual["versao"] if atual else "",
        }, headers={"Cache-Control": "no-store"})

    @router.post("/api/sebrae/dashboard/conflitos")
    def escolher_conflitos(payload: ConflitosPayload):
        """Grava as escolhas por conflito (``sharepoint`` ou ``site``); com ``enviar`` inicia a rotina ``enviar`` de novo.

        Exige a ``versao_importacao`` atual (409 se ausente ou antiga). ``site`` num conflito com ``aceita_site`` falso é 422."""
        _exigir_versao(payload.versao_importacao)
        pasta = _pasta_estado()
        arquivo = fin.caminho_conflitos(pasta)
        with lock_paths([arquivo]):
            dados = fin.ler_conflitos(pasta) or {}
            conflitos = [conflito for conflito in dados.get("conflitos") or [] if isinstance(conflito, dict)]
            ids = {str(conflito.get("id")) for conflito in conflitos}
            if not ids:
                raise DomainValidationError("Não há conflitos de edição para escolher.", status_code=422)
            if any(chave not in ids for chave in payload.escolhas):
                raise DomainValidationError("Há escolha para um conflito que não existe mais; recarregue a lista.", status_code=422)
            so_sharepoint = {str(conflito.get("id")) for conflito in conflitos if conflito.get("aceita_site") is False}  # an old conflict without the key accepts both
            if any(valor == "site" and chave in so_sharepoint for chave, valor in payload.escolhas.items()):
                raise DomainValidationError("Esse conflito só pode manter o valor do SharePoint.", status_code=422)
            escolhas = {**fin.escolhas_dos_conflitos(pasta), **payload.escolhas}
            atomic_write_json(arquivo, {**dados, "escolhas": escolhas})
        envio = _iniciar_envio() if payload.enviar else {"iniciado": False, "motivo": ""}
        return JSONResponse({"escolhas": escolhas, "enviar": envio}, headers={"Cache-Control": "no-store"})

    @router.post("/api/sebrae/antigos/ler", status_code=202)
    def ler_antigos():
        """Botão de ler os chamados antigos no SoftExpert: inicia a rotina ``antigos`` (só leitura, só os que ainda não foram lidos)."""
        if services.runner is None:
            raise DomainBusyError("A automação não está disponível neste servidor.")
        if sebrae_novos.ler_existentes(services.caminhos().existentes) is None:
            raise DomainValidationError("Importe o Dashboard antes.", status_code=422)
        services.runner().start("antigos")  # 409 quando outra rotina roda
        return JSONResponse({"iniciado": True}, status_code=202, headers={"Cache-Control": "no-store"})

    @router.get("/api/sebrae/antigos/ler")
    def resultado_antigos():
        """``em_andamento`` e o resumo da última leitura de antigos (``lidos``, ``falhas``, ``sem_utic``, ``ja_lidos``); ``resultado`` é null antes da primeira."""
        rodando = False
        if services.runner is not None:
            try:
                ativo = _rotina_em_andamento()
                rodando = ativo is not None and ativo.get("rotina") == "antigos"
            except Exception as erro:  # noqa: BLE001 - sem o estado do runner, vale o arquivo
                logger.warning("Não foi possível ler o estado da rotina de antigos (%s).", type(erro).__name__)
                pass
        resultado = sebrae_novos.ler_resultado_antigos(services.caminhos())
        return JSONResponse({"em_andamento": rodando, "resultado": resultado}, headers={"Cache-Control": "no-store"})

    @router.post("/api/sebrae/dashboard/pendente/reenviar", status_code=202)
    def reenviar_pendente():
        """Botão Tentar substituir de novo: a rotina reenvia a cópia pendente mais recente, com a mesma conferência do SharePoint."""
        fin.exigir_envio_livre(_pasta_estado())
        if fin.pendente_mais_recente(_pasta_estado()) is None:
            raise DomainValidationError("Não há cópia pendente do Dashboard para enviar.", status_code=422)
        _disparar([], acao=fin.ACAO_REENVIAR)
        return JSONResponse({"iniciado": True}, status_code=202, headers={"Cache-Control": "no-store"})

    @router.post("/api/sebrae/dashboard/envio/recuperar")
    def recuperar_envio(payload: RecuperacaoEnvioPayload):
        def em_andamento() -> bool:
            if services.runner is None:
                return bool((fin.ler_resultado(_pasta_estado()) or {}).get("em_andamento"))
            try:
                ativo = services.runner().state()
                if ativo.get("estado") not in ("livre", "em_andamento"):
                    raise ValueError("estado desconhecido")
                return ativo["estado"] == "em_andamento"
            except Exception as error:
                raise DomainBusyError("Não foi possível confirmar que a automação está livre. Tente novamente.") from error

        resultado = fin.recuperar_envio(_pasta_estado(), payload.envio_id, payload.acao, confirmacao=payload.confirmacao, em_andamento=em_andamento)
        return JSONResponse(resultado, headers={"Cache-Control": "no-store"})

    @router.post("/api/sebrae/dashboard/envio/reenviar-snapshot", status_code=202)
    def reenviar_snapshot(payload: ReenvioSnapshotPayload):
        if not payload.confirmado:
            raise DomainValidationError("Confirme o reenvio separado desta cópia revisada.", status_code=422)
        _disparar([], acao=fin.ACAO_REENVIAR_SNAPSHOT, envio_id=payload.envio_id, sha256=payload.sha256)
        return JSONResponse({"iniciado": True, "envio_id": payload.envio_id, "sha256": payload.sha256}, status_code=202, headers={"Cache-Control": "no-store"})

    @router.get("/api/sebrae/dashboard/envio/{envio_id}/snapshot")
    def snapshot_envio(envio_id: str):
        with lock_paths([fin.caminho_envio(_pasta_estado())]):
            conteudo = fin.conteudo_snapshot_envio(_pasta_estado(), envio_id)
        return Response(conteudo, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headers={
            "Cache-Control": "no-store", "Content-Disposition": f'attachment; filename="{fin.NOME_DASHBOARD}"',
        })

    def _linhas_novas(payload: AtualizarPayload, importado: Mapping[str, Any], caminhos: sebrae_novos.Caminhos) -> List[Dict[str, str]]:
        if not payload.chamados:
            return []
        novos = _novos(caminhos, importado["numeros"])
        if novos is None:
            raise DomainValidationError("Busque os chamados novos antes de atualizar.", status_code=422)
        manuais = {item.numero: item.model_dump(exclude={"numero"}) for item in payload.chamados}
        if len(manuais) != len(payload.chamados):
            raise DomainValidationError("Há chamados repetidos na atualização.", status_code=422)
        escolhidos = [c for c in novos["chamados"] if c.numero in manuais]
        desconhecidos = sorted(set(manuais) - {c.numero for c in escolhidos})
        if desconhecidos:
            ja_no_dashboard = next((n for n in desconhecidos if n in importado["numeros"]), None)
            if ja_no_dashboard:  # typed into the Dashboard by hand after the search
                raise DomainValidationError(f"{ja_no_dashboard} já está no Dashboard (incluído à mão depois da busca); confira-o em Chamados antigos em aberto e atualize de novo.", status_code=422)
            raise DomainValidationError(f"{desconhecidos[0]} não está entre os chamados novos.", status_code=422)
        return sebrae_novos.linhas_completas(escolhidos, manuais, services.registros(), _relatorio(), importado["listas"], exigir=False, vinculos=services.vinculos_os())

    def _edicoes(payload: AtualizarPayload, planilha: bytes, listas: Mapping[str, Sequence[str]], exigir_encerramento: bool = False) -> Dict[str, Dict[str, str]]:
        """Merged (stored + sent) manual values that are filled pass the same rules as a new ticket (A, D and J may stay
        blank); an off-list A/B it already has is kept. The title (G) goes only when typed, already masked.

        With ``exigir_encerramento``: D=FINALIZADO without a valid R (none sent, none stored) is refused (rule of 24/11/2026: the
        closing date is always typed by the user, never the current time)."""
        if not payload.edicoes:
            return {}
        abertos = {c.numero: c for c in sebrae_dashboard_gravacao.chamados_para_editar(planilha)}
        edicoes: Dict[str, Dict[str, str]] = {}
        for item in payload.edicoes:
            atual = abertos.get(item.numero)
            if atual is None:
                raise DomainValidationError(f"{item.numero} não é um chamado antigo EM ABERTO ou sem status.", status_code=422)
            if item.numero in edicoes:
                raise DomainValidationError("Há chamados repetidos na atualização.", status_code=422)
            enviados = item.model_dump(exclude={"numero"})
            mesclados = {letra: str(enviados.get(letra) or "") or atual.valores.get(letra, "") for letra in MANUAIS}
            try:
                validados = sebrae_novos.validar_manuais(mesclados, exigir=False)
                sebrae_novos.validar_listas(validados, listas, atual.valores)
                titulo = sebrae_novos.titulo_editado(enviados)
                if titulo:  # G is not in MANUAIS: it only goes when typed; the ticket is still found by its key, never by the title
                    validados["G"] = titulo
            except sebrae_novos.ManuaisInvalidos as erro:
                raise sebrae_novos.ManuaisInvalidos(f"{item.numero}: {erro}") from None
            if exigir_encerramento and validados["D"] == sebrae_novos.STATUS_FINALIZADO and not _tem_encerramento(item.numero, validados["R"]):
                raise sebrae_novos.ManuaisInvalidos(_falta_encerramento(item.numero))
            edicoes[item.numero] = validados
        return edicoes

    return router
