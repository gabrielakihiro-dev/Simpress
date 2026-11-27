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
import logging
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Literal, Mapping, Optional, Sequence, Tuple

from fastapi import APIRouter, File, Query, UploadFile
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

from core.errors import DomainBusyError, DomainConflictError, DomainError, DomainValidationError
from core.config import REGIONAL_REPRESENTATIVE_DEFAULTS_FILE, REGIONAL_REPRESENTATIVES_FILE, format_size_limit
from core.integrity import atomic_write_json, lock_paths
from domains import (
    local_setup, sebrae_credenciais, sebrae_dashboard_gravacao, sebrae_finalizacao as fin,
    sebrae_historico, sebrae_novos, sebrae_observacoes as obs, sebrae_os_recusadas,
)
from domains import sebrae_categoria  # noqa: F401 - reexportado: os testes fazem patch.object(rota_sebrae.sebrae_categoria, ...)
from domains.sebrae_chamados import chave_do_numero, mascarar_cpfs
from domains import sebrae_dashboard_atualizacao as atualizacao, sebrae_dashboard_importacao as importacao, sebrae_dashboard_tela as tela
from domains.sebrae_dashboard import DashboardInvalido, ler_coluna_c
from domains.sebrae_dashboard_tela import NOME_ATUALIZADO as NOME_ATUALIZADO, SebraeDashboardServices as SebraeDashboardServices  # reexportados (main.py e testes)

MAX_CHAMADOS_POR_EXPORTACAO = 200
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

    def _pasta_estado() -> Path:
        return tela.pasta_estado(services)

    def _nomes_representantes() -> List[Any]:
        """Nomes dos representantes regionais (padrão local e alterados); arquivo ilegível vale só o padrão."""
        try:
            salvos, _ = local_setup.load_regional_representatives(REGIONAL_REPRESENTATIVES_FILE)
        except Exception as erro:  # noqa: BLE001 - só serve para mascarar nomes; o padrão continua valendo
            logger.warning("Representantes regionais ilegíveis; vale só o padrão (%s).", type(erro).__name__)
            salvos = {}
        # O padrão vem do arquivo local (o código tem os nomes em branco): sem ele os nomes reais deixariam de ser mascarados.
        padroes_efetivos, _ = local_setup.effective_regional_representative_defaults(REGIONAL_REPRESENTATIVE_DEFAULTS_FILE)
        padroes = [dados.get("nome") for dados in padroes_efetivos.values()]
        return [*padroes, *(dados.get("nome") for dados in salvos.values() if isinstance(dados, dict))]

    def _nomes_pessoas() -> List[Any]:
        """Nomes conhecidos de pessoas (inventário e representantes): nunca viram palavra do índice nem saem para a IA."""
        return [*(registro.get("nome") for registro in services.registros()), *_nomes_representantes()]

    @router.get("/api/sebrae/novos")
    def novos_chamados():
        """Dashboard importado e chamados novos lidos do SoftExpert, com as colunas automáticas já calculadas."""
        return JSONResponse(tela.estado(services, _nomes_pessoas), headers={"Cache-Control": "no-store"})

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

    def _importar_bloqueado(conteudo: bytes, numeros: Any, nome: str, automatico: bool):
        with lock_paths([_base_guard()]):
            ativa = _rotina_em_andamento()
            if ativa is None and services.runner is not None and (orfaos := fin.descartar_job_orfao(_pasta_estado())) is not None:  # mesma regra de ``_exigir_rotina_livre``
                logger.warning("Pedido de finalização órfão descartado (%s chamado(s)).", orfaos)
            if fin.job_pendente(_pasta_estado()) or (ativa is not None and ativa.get("rotina") in ("fechar", "enviar")):
                raise DomainConflictError("Aguarde a finalização em andamento antes de reimportar o Dashboard.")
            corpo = importacao.importar(services, conteudo, numeros, nome, automatico, _nomes_pessoas)
            return JSONResponse(corpo, headers={"Cache-Control": "no-store"})

    def _congelar_os_vinculada(pasta, numeros: Sequence[str]) -> None:
        """Photo of the OS linked to each ticket whose finalization was just requested; it never blocks the finalization."""
        try:
            importado = sebrae_novos.ler_existentes(services.caminhos().existentes)
            resolver = importacao.resolvedor_os(services, importado["abertos"] if importado else [])
        except Exception as erro:  # noqa: BLE001
            logger.warning("OS vinculada não congelada (%s).", type(erro).__name__)
            return
        for numero in numeros:
            try:
                fin.congelar_os_vinculada(pasta, numero, resolver(numero))
            except Exception as erro:  # noqa: BLE001 - log only the type, never ticket data
                logger.warning("OS vinculada não congelada (%s).", type(erro).__name__)

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

    @router.post("/api/sebrae/dashboard/atualizar")
    def atualizar_dashboard(payload: AtualizarPayload):
        """Cópia do Dashboard importado com os chamados novos e as edições; o original e a cópia guardada ficam intactos.

        Responsável, Status e Tipo podem ficar em branco (a linha é gravada sem eles). Série, Modelo, Cidade e OS vazios dos
        antigos em aberto são preenchidos pelo nome da coluna I. 422 se não houver importação válida, se um Status/Tipo
        preenchido for inválido, se o chamado repetir ou se a Tabela3 não tiver linhas livres."""
        with lock_paths([_base_guard()]):
            _exigir_versao(payload.versao_importacao)
            # fechar/enviar (ou o pedido esperando) gravam D e R na mesma saída: refazê-la agora a deixaria sem o recém-finalizado
            _exigir_sem_finalizacao("Aguarde a finalização ou o envio em andamento antes de atualizar o Dashboard. Nada foi gravado.")
            confirmados = dict.fromkeys(payload.confirmar_outro_tecnico, "") if payload.finalizar_softexpert else None
            importado, resultado, conteudo, gravada, edicoes = _gravar_atualizacao(payload.chamados, payload.edicoes, exigir_encerramento=True, confirmados=confirmados)
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

    def _gravar_atualizacao(chamados: Sequence[ChamadoManual], edicoes: Sequence[ChamadoManual], **opcoes: Any):
        return atualizacao.gravar_atualizacao(
            services, [c.model_dump() for c in chamados], [e.model_dump() for e in edicoes], _nomes_pessoas, **opcoes,
        )

    def _fechar_inativo(motivo: str, pulados: Sequence[Mapping[str, str]] = ()) -> Dict[str, Any]:
        return {"iniciado": False, "motivo": motivo, "numeros": [], "pulados": [dict(p) for p in pulados]}

    def _encerramentos_manuais(com_r: Mapping[str, str]) -> Dict[str, str]:
        """``{UTIC: R}`` dos que a última leitura do SoftExpert não achou (regra do usuário, 12/11/2026): se a ``fechar`` também não os achar,
        o R do usuário os registra como finalizados por outro técnico. Chamado achado na leitura nunca entra aqui.
        Quem chama passa só os confirmados pelo usuário (decisão de 25/11/2026)."""
        if not com_r:
            return {}
        perdidos = tela.nao_encontrados(services, tela.leitura_antigos(services))
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

    def _exigir_sem_finalizacao(mensagem: str) -> None:
        """409 com pedido de finalização esperando ou ``fechar``/``enviar`` rodando (outras rotinas, como ``antigos``, não bloqueiam).

        Estado do executor ilegível: 503, sem gravar (não dá para saber se a ``fechar`` está gravando a mesma saída)."""
        try:
            ativa = _rotina_em_andamento()
        except Exception as erro:  # noqa: BLE001
            logger.warning("Estado do executor de rotinas ilegível (%s).", type(erro).__name__)
            raise DomainBusyError("Não foi possível conferir se há rotina em execução. Tente de novo.") from erro
        if ativa is None and services.runner is not None and (orfaos := fin.descartar_job_orfao(_pasta_estado())) is not None:  # mesma regra de ``_exigir_rotina_livre``
            logger.warning("Pedido de finalização órfão descartado (%s chamado(s)).", orfaos)
        if fin.job_pendente(_pasta_estado()) or (ativa is not None and ativa.get("rotina") in ("fechar", "enviar")):
            raise DomainConflictError(mensagem)

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
        sebrae_os_recusadas.recusar(_pasta_estado(), fin.validar_numero(numero), payload.os)  # só UTIC-AAAA-N: linha:N não identifica o chamado
        return JSONResponse({"ok": True}, headers={"Cache-Control": "no-store"})

    @router.put("/api/sebrae/chamados/{numero}/os-manter")
    def manter_os(numero: str, payload: OsRecusadaPayload):
        """Mantém a OS que já está na E (aviso "sem relação" encerrado); só local, nada é gravado no Dashboard."""
        sebrae_os_recusadas.manter(_pasta_estado(), fin.validar_numero(numero), payload.os)  # só UTIC-AAAA-N: linha:N não identifica o chamado
        return JSONResponse({"ok": True}, headers={"Cache-Control": "no-store"})

    @router.put("/api/sebrae/chamados/{numero}/os-remover")
    def remover_os(numero: str, payload: OsRecusadaPayload):
        """Recusa a OS e manda limpar a E: a próxima gravação do Dashboard esvazia só a E que ainda for essa OS."""
        sebrae_os_recusadas.remover(_pasta_estado(), fin.validar_numero(numero), payload.os)  # só UTIC-AAAA-N: linha:N não identifica o chamado
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
                raise DomainValidationError(atualizacao.falta_encerramento(numero), status_code=422)
            # Decisão do usuário (25/11/2026): só com a confirmação explícita o R vira "finalizado por outro técnico" (se a leitura não achou o chamado).
            confirmados = {numero: quando} if payload.confirmar_outro_tecnico else {}
            # Os campos manuais entram na cópia de saída antes da rotina, que depois só grava R e D: sem isso o Dashboard enviado ao SharePoint perderia A, B, J e S.
            if payload.chamados or payload.edicoes:
                if services.runner is not None:
                    _exigir_rotina_livre(pasta)  # a rotina ocupada recusa antes de refazer a cópia; _disparar confere de novo dentro do lock
                gravacao = _gravar_atualizacao(payload.chamados, payload.edicoes, aceita_vazio=True, confirmados=confirmados)
                if gravacao is not None and not gravacao[3]:
                    raise DomainBusyError("Não consegui gravar os campos manuais na cópia do Dashboard; nada foi finalizado.")
            elif confirmados:  # sem campos manuais no corpo, D nunca é FINALIZADO: recusa com o que falta
                importado = sebrae_novos.ler_existentes(services.caminhos().existentes) or {}
                guardado = next((a.get("valores") or {} for a in importado.get("abertos", []) if str(a.get("numero")) == numero), {})
                atualizacao.exigir_outro_tecnico(numero, {**guardado, "R": quando})
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
        pasta = _pasta_estado()
        arquivo = fin.caminho_conflitos(pasta)
        with lock_paths([_base_guard()]), lock_paths([arquivo]):  # mesma ordem da importação: uma reimportação não entra entre conferir e gravar
            _exigir_versao(payload.versao_importacao)
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

    return router
