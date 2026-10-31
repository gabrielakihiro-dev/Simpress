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
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence

from fastapi import APIRouter, File, Query, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from core.errors import DomainBusyError, DomainConflictError, DomainError, DomainValidationError
from core.config import format_size_limit
from core.integrity import lock_paths
from domains import (
    sebrae_arquivo, sebrae_cruzamento, sebrae_dashboard_gravacao, sebrae_finalizacao as fin, sebrae_historico, sebrae_novos,
)
from domains.chrome_automation import ChromeAutomationRunner
from domains.sebrae_chamados import chave_do_numero
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


class ExportarPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    chamados: List[ChamadoManual] = Field(..., min_length=1, max_length=MAX_CHAMADOS_POR_EXPORTACAO)


class AtualizarPayload(BaseModel):
    """``chamados``: novos, escritos nas primeiras linhas livres. ``edicoes``: antigos EM ABERTO/sem status, só campos manuais."""

    model_config = ConfigDict(extra="forbid")

    chamados: List[ChamadoManual] = Field(default_factory=list, max_length=MAX_CHAMADOS_POR_EXPORTACAO)
    edicoes: List[ChamadoManual] = Field(default_factory=list, max_length=MAX_CHAMADOS_POR_EXPORTACAO)
    finalizar_softexpert: bool = False  # só True (diálogo "Atualizar e finalizar") dispara a rotina fechar em massa; irreversível


@dataclass(frozen=True)
class SebraeDashboardServices:
    caminhos: Callable[[], sebrae_novos.Caminhos]
    max_upload_bytes: Callable[[], int]
    registros: Callable[[], Sequence[Mapping[str, Any]]]  # equipment records by person name (EquipamentosDetalhes, Endpoint, Entra)
    relatorio_chamados: Callable[[], Optional[Mapping[str, Any]]]  # ticket report, for column E
    runner: Optional[Callable[[], ChromeAutomationRunner]] = None  # starts the ``fechar`` routine; without it nothing is finalized


class FinalizarPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    numero: str = Field(..., min_length=1, max_length=40)
    confirmado: bool = False  # clique explícito após o diálogo "Confirmar finalização"; sem isso nada é disparado


class DescricaoPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    descricao_finalizacao: str = Field("", max_length=fin.MAX_DESCRICAO * 2)  # the exact limit is checked (and explained) by the domain


def create_sebrae_dashboard_router(services: SebraeDashboardServices) -> APIRouter:
    router = APIRouter()

    def _relatorio() -> Optional[Mapping[str, Any]]:
        try:
            return services.relatorio_chamados()
        except (OSError, ValueError):
            return None  # an unreadable ticket report only leaves column E empty

    def _abertos_com_sugestoes(abertos: Sequence[Mapping[str, Any]]) -> List[Dict[str, Any]]:
        """Old open tickets plus what "Atualizar Dashboard" would fill into their empty E, K, L and N."""
        registros = services.registros() if abertos else []
        sugestoes = sebrae_novos.preenchimentos(abertos, registros, _relatorio()) if abertos else {}
        finalizacao = fin.ler_estado(_pasta_estado()) if abertos else {}
        return [
            {**a, "automaticos_sugeridos": sugestoes.get(str(a.get("numero")), {}),
             **sebrae_cruzamento.avisos_de_nome(a.get("descricao"), a.get("usuario"), registros),
             "softexpert": fin.publico(finalizacao.get(str(a.get("numero"))))}
            for a in abertos
        ]

    def _pasta_estado():
        return fin.pasta_estado(services.caminhos().existentes)

    def _estado() -> Dict[str, Any]:
        corpo = _estado_base()
        # só aparecem quando existem: a tela vazia continua {"importado": None, "novos": None}
        resultado = fin.ler_resultado(_pasta_estado())
        if resultado is not None:
            corpo["fechar"] = resultado
        pendente = fin.aviso_do_pendente(_pasta_estado())
        if pendente is not None:
            corpo["sharepoint"] = pendente
        return corpo

    def _estado_base() -> Dict[str, Any]:
        caminhos = services.caminhos()
        importado = sebrae_novos.ler_existentes(caminhos.existentes)
        lancados = importado["numeros"] if importado else frozenset()
        novos = sebrae_novos.ler_novos(caminhos.novos, lancados) if importado else None
        return {
            "importado": None if importado is None else {
                "arquivo": importado["arquivo"], "importado_em": importado["importado_em"], "total": len(lancados),
                "listas": importado["listas"], "abertos": _abertos_com_sugestoes(importado["abertos"]),
                "atualizavel": sebrae_novos.ler_planilha(sebrae_novos.caminho_planilha(caminhos), importado["sha256"]) is not None,
                "saida_pronta": sebrae_novos.caminho_saida(caminhos, NOME_ATUALIZADO).is_file(),
            },
            "novos": None if novos is None else {
                "lidos_em": novos["lidos_em"], "ignorados": novos["ignorados"], "pendentes": novos["pendentes"],
                "erros": novos["erros"],
                "formulario": sebrae_novos.formulario(novos["chamados"], services.registros(), _relatorio()),
            },
        }

    @router.get("/api/sebrae/novos")
    def novos_chamados():
        """Dashboard importado e chamados novos lidos do SoftExpert, com as colunas automáticas já calculadas."""
        return JSONResponse(_estado(), headers={"Cache-Control": "no-store"})

    @router.post("/api/sebrae/dashboard")
    async def importar_dashboard(file: UploadFile = File(...)):
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
        anteriores = sebrae_novos.ler_existentes(services.caminhos().existentes)
        # the archive is written BEFORE the previous open list is overwritten; if it fails, nothing is replaced
        await asyncio.to_thread(_arquivar_encerrados, conteudo, anteriores)
        await asyncio.to_thread(_guardar_importado, conteudo, numeros, nome)
        historico_ok = await asyncio.to_thread(_registrar_historico, conteudo, nome, anteriores)
        return JSONResponse({**_estado(), "historico_ok": historico_ok, "arquivo_ok": True}, headers={"Cache-Control": "no-store"})

    def _arquivar_encerrados(conteudo: bytes, anteriores: Optional[Mapping[str, Any]]) -> None:
        """Tickets that left the open list go to the permanent archive; unlike the history, a failure blocks the import
        (the previous Dashboard stays in place, so a retry still sees the same tickets leaving)."""
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

    def _guardar_importado(conteudo: bytes, numeros: Any, nome: str) -> None:
        """Numbers, A/B lists and open tickets go to the JSON; the file itself is kept for "Atualizar Dashboard".
        A Dashboard the writer cannot read still imports, so the paste flow keeps working."""
        caminhos = services.caminhos()
        # a saída antiga vem da importação anterior; enviá-la ao SharePoint apagaria o que entrou desde então
        sebrae_novos.caminho_saida(caminhos, NOME_ATUALIZADO).unlink(missing_ok=True)
        try:
            listas = sebrae_dashboard_gravacao.ler_listas(conteudo)
            abertos = [c.como_dict() for c in sebrae_dashboard_gravacao.chamados_para_editar(conteudo)]
            sha256 = sebrae_novos.salvar_planilha(sebrae_novos.caminho_planilha(caminhos), conteudo)
        except DashboardInvalido:
            listas, abertos, sha256 = {}, [], ""
        sebrae_novos.salvar_existentes(caminhos.existentes, numeros, nome, sha256=sha256, listas=listas, abertos=abertos)

    @router.post("/api/sebrae/exportar")
    def exportar(payload: ExportarPayload):
        """Blocos A:P e R:S dos chamados enviados; 422 se faltar campo manual ou o chamado já não for novo."""
        caminhos = services.caminhos()
        importado = sebrae_novos.ler_existentes(caminhos.existentes)
        if importado is None:
            raise DomainValidationError("Importe o Dashboard antes de exportar.", status_code=422)
        novos = sebrae_novos.ler_novos(caminhos.novos, importado["numeros"])
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
            resultado = sebrae_novos.exportar(escolhidos, manuais, services.registros(), _relatorio(), importado["listas"])
        except sebrae_novos.ManuaisInvalidos as erro:
            raise DomainValidationError(str(erro), status_code=422) from None
        return JSONResponse(resultado, headers={"Cache-Control": "no-store"})

    @router.post("/api/sebrae/dashboard/atualizar")
    def atualizar_dashboard(payload: AtualizarPayload):
        """Cópia do Dashboard importado com os chamados novos e as edições; o original e a cópia guardada ficam intactos.

        Responsável, Status e Tipo podem ficar em branco (a linha é gravada sem eles). Série, Modelo, Cidade e OS vazios dos
        antigos em aberto são preenchidos pelo nome da coluna I. 422 se não houver importação válida, se um Status/Tipo
        preenchido for inválido, se o chamado repetir ou se a Tabela3 não tiver linhas livres."""
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
            linhas = _linhas_novas(payload, importado, caminhos)
            edicoes = _edicoes(payload, planilha, importado["listas"])
            abertos = [c.como_dict() for c in sebrae_dashboard_gravacao.chamados_para_editar(planilha)]
            automaticos = sebrae_novos.preenchimentos(abertos, services.registros(), _relatorio())
            if not linhas and not edicoes and not automaticos:
                raise DomainValidationError("Não há chamados novos, alterações nem dados para preencher.", status_code=422)
            resultado = sebrae_dashboard_gravacao.atualizar(planilha, linhas, edicoes, automaticos)
        except (sebrae_novos.ManuaisInvalidos, DashboardInvalido) as erro:
            raise DomainValidationError(str(erro), status_code=422) from None
        conteudo = _reaplicar_encerramentos(resultado.conteudo)
        saida = sebrae_novos.caminho_saida(caminhos, NOME_ATUALIZADO)
        gravada = False
        try:
            with lock_paths([saida]):  # a rotina fechar grava a coluna R neste mesmo arquivo
                sebrae_novos.salvar_planilha(saida, conteudo)
            gravada = True
        except OSError:  # o download do usuário segue; só o "Enviar ao SharePoint" fica sem arquivo
            logger.warning("Não gravei a cópia de saída do Dashboard.", exc_info=True)
        return JSONResponse({
            "arquivo": NOME_ATUALIZADO,
            "base": {"arquivo": importado["arquivo"], "importado_em": importado["importado_em"]},
            "linhas": [
                {"numero": g.numero, "linha": g.linha, "tipo": g.tipo, "celulas": list(g.celulas)} for g in resultado.linhas
            ],
            "conteudo_base64": base64.b64encode(conteudo).decode("ascii"),
            "fechar": (
                _fechar_inativo("A cópia de saída não foi gravada; nada foi finalizado.") if not gravada
                else _finalizar_marcados(edicoes) if payload.finalizar_softexpert
                else _fechar_inativo("finalização no SoftExpert não confirmada")
            ),
        }, headers={"Cache-Control": "no-store"})

    def _reaplicar_encerramentos(conteudo: bytes) -> bytes:
        """A saída é refeita da cópia importada a cada "Atualizar": as datas de encerramento já gravadas voltam à coluna R (só se vazia)."""
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

    def _finalizar_marcados(edicoes: Mapping[str, Mapping[str, str]]) -> Dict[str, Any]:
        """Tickets whose D the user just set to FINALIZADO go to the ``fechar`` routine; a failure here never fails the update."""
        pasta = _pasta_estado()
        numeros: List[str] = []
        pulados: List[Dict[str, str]] = []
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
            else:
                numeros.append(numero)
        if not numeros:
            return _fechar_inativo("", pulados)
        try:
            _disparar(numeros, pulados)
        except DomainError as erro:
            return _fechar_inativo(str(erro.detail), pulados)
        return {"iniciado": True, "motivo": "", "numeros": numeros, "pulados": pulados}

    def _disparar(numeros: Sequence[str], pulados: Sequence[Mapping[str, str]] = (), acao: str = fin.ACAO_FINALIZAR) -> None:
        """Writes the one-shot job and starts ``fechar`` under one lock on the job file: two requests cannot overwrite each other's job.

        409 when a run is in progress or another job still waits; the job is removed if the routine does not start."""
        if services.runner is None:
            raise DomainBusyError("A automação não está disponível neste servidor.")
        runner = services.runner()
        pasta = _pasta_estado()
        with lock_paths([fin.caminho_job(pasta)]):
            if fin.job_pendente(pasta):
                raise DomainConflictError("Já há um pedido de finalização esperando a rotina começar. Aguarde terminar.")
            fin.gravar_job(pasta, numeros, pulados=pulados, acao=acao)
            try:
                runner.start("fechar")
            except BaseException:
                fin.apagar_job(pasta)
                raise

    def _exigir_aberto(numero: str) -> str:
        numero = fin.validar_numero(numero)
        importado = sebrae_novos.ler_existentes(services.caminhos().existentes)
        if importado is None:
            raise DomainValidationError("Importe o Dashboard antes.", status_code=422)
        if numero not in {str(a.get("numero")) for a in importado["abertos"]}:
            raise DomainValidationError(f"{numero} não é um chamado antigo EM ABERTO ou sem status.", status_code=422)
        return numero

    @router.put("/api/sebrae/chamados/{numero}/finalizacao")
    def definir_descricao(numero: str, payload: DescricaoPayload):
        """Texto de "Detalhes do Atendimento Realizado" deste chamado; vazio apaga."""
        numero = _exigir_aberto(numero)
        item = fin.definir_descricao(_pasta_estado(), numero, payload.descricao_finalizacao)
        return JSONResponse({"numero": numero, **fin.publico(item)}, headers={"Cache-Control": "no-store"})

    @router.post("/api/sebrae/chamados/{numero}/anexo")
    async def anexar_pdf(numero: str, file: UploadFile = File(...)):
        """Um PDF opcional por chamado (extensão, assinatura %PDF e tamanho conferidos); o novo substitui o anterior."""
        numero = await asyncio.to_thread(_exigir_aberto, numero)
        limite = min(services.max_upload_bytes(), fin.MAX_PDF_BYTES)
        conteudo = await file.read(limite + 1)
        item = await asyncio.to_thread(fin.anexar_pdf, _pasta_estado(), numero, file.filename, conteudo, limite)
        return JSONResponse({"numero": numero, **fin.publico(item)}, headers={"Cache-Control": "no-store"})

    @router.delete("/api/sebrae/chamados/{numero}/anexo")
    def remover_pdf(numero: str):
        numero = _exigir_aberto(numero)
        return JSONResponse({"numero": numero, **fin.publico(fin.remover_pdf(_pasta_estado(), numero))}, headers={"Cache-Control": "no-store"})

    @router.post("/api/sebrae/finalizar-softexpert", status_code=202)
    def finalizar_softexpert(payload: FinalizarPayload):
        """Finaliza UM chamado no SoftExpert (botão por chamado). Irreversível: só chamados antigos em aberto, com descrição."""
        if not payload.confirmado:
            raise DomainValidationError("Confirme a finalização no SoftExpert antes de enviar.", status_code=422)
        numero = _exigir_aberto(payload.numero)
        pasta = _pasta_estado()
        if fin.ja_finalizado(pasta, numero):
            raise DomainConflictError(f"{numero} já foi finalizado no SoftExpert.")
        if not fin.dados_para_finalizar(pasta, numero)[0]:
            raise DomainValidationError("Preencha a descrição para finalizar o chamado antes de finalizar.", status_code=422)
        _disparar([numero])
        return JSONResponse({"iniciado": True, "numeros": [numero]}, status_code=202, headers={"Cache-Control": "no-store"})

    @router.get("/api/sebrae/finalizar-softexpert")
    def resultado_finalizacao():
        """Resultado da última rotina ``fechar`` (um item por chamado) e o aviso do SharePoint, se houver cópia pendente."""
        pasta = _pasta_estado()
        resultado = fin.ler_resultado(pasta)
        rodando = False
        if services.runner is not None:
            try:
                ativo = services.runner().state()
                rodando = ativo.get("estado") == "em_andamento" and ativo.get("rotina") == "fechar"
            except Exception:  # noqa: BLE001 - sem o estado do runner, vale o que o arquivo diz
                rodando = bool(resultado and resultado.get("em_andamento"))
        return JSONResponse({
            "em_andamento": rodando, "resultado": resultado, "sharepoint": fin.aviso_do_pendente(pasta),
        }, headers={"Cache-Control": "no-store"})

    @router.post("/api/sebrae/dashboard/pendente/reenviar", status_code=202)
    def reenviar_pendente():
        """Botão Tentar substituir de novo: a rotina reenvia a cópia pendente mais recente, com a mesma conferência do SharePoint."""
        if fin.pendente_mais_recente(_pasta_estado()) is None:
            raise DomainValidationError("Não há cópia pendente do Dashboard para enviar.", status_code=422)
        _disparar([], acao=fin.ACAO_REENVIAR)
        return JSONResponse({"iniciado": True}, status_code=202, headers={"Cache-Control": "no-store"})

    def _linhas_novas(payload: AtualizarPayload, importado: Mapping[str, Any], caminhos: sebrae_novos.Caminhos) -> List[Dict[str, str]]:
        if not payload.chamados:
            return []
        novos = sebrae_novos.ler_novos(caminhos.novos, importado["numeros"])
        if novos is None:
            raise DomainValidationError("Busque os chamados novos antes de atualizar.", status_code=422)
        manuais = {item.numero: item.model_dump(exclude={"numero"}) for item in payload.chamados}
        if len(manuais) != len(payload.chamados):
            raise DomainValidationError("Há chamados repetidos na atualização.", status_code=422)
        escolhidos = [c for c in novos["chamados"] if c.numero in manuais]
        desconhecidos = sorted(set(manuais) - {c.numero for c in escolhidos})
        if desconhecidos:
            raise DomainValidationError(f"{desconhecidos[0]} não está entre os chamados novos.", status_code=422)
        return sebrae_novos.linhas_completas(escolhidos, manuais, services.registros(), _relatorio(), importado["listas"], exigir=False)

    def _edicoes(payload: AtualizarPayload, planilha: bytes, listas: Mapping[str, Sequence[str]]) -> Dict[str, Dict[str, str]]:
        """Merged (stored + sent) manual values that are filled pass the same rules as a new ticket (A, D and J may stay
        blank); an off-list A/B it already has is kept."""
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
            except sebrae_novos.ManuaisInvalidos as erro:
                raise sebrae_novos.ManuaisInvalidos(f"{item.numero}: {erro}") from None
            edicoes[item.numero] = validados
        return edicoes

    return router
