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
from typing import Any, Callable, Dict, Iterable, List, Literal, Mapping, Optional, Sequence

from fastapi import APIRouter, File, Query, UploadFile
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

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
    versao_importacao: str = Field("", max_length=128)
    finalizar_softexpert: bool = False  # só True (diálogo "Atualizar e finalizar") dispara a rotina fechar em massa; irreversível


@dataclass(frozen=True)
class SebraeDashboardServices:
    caminhos: Callable[[], sebrae_novos.Caminhos]
    max_upload_bytes: Callable[[], int]
    registros: Callable[[], Sequence[Mapping[str, Any]]]  # equipment records by person name (EquipamentosDetalhes, Endpoint, Entra)
    relatorio_chamados: Callable[[], Optional[Mapping[str, Any]]]  # ticket report, for column E
    vinculos_os: Callable[[], Sequence[Mapping[str, Any]]] = lambda: ()  # manual links UTIC -> OS of the ticket table, for column E
    apelidos: Callable[[], Mapping[str, str]] = lambda: {}  # SERIE -> apelido, só para exibir no cartão (nunca gravado)
    runner: Optional[Callable[[], ChromeAutomationRunner]] = None  # starts the ``fechar`` routine; without it nothing is finalized


class FinalizarPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    numero: str = Field(..., min_length=1, max_length=40)
    versao_importacao: str = Field("", max_length=128)
    confirmado: bool = False  # clique explícito após o diálogo "Confirmar finalização"; sem isso nada é disparado
    # Mesmo corpo do "Atualizar Dashboard" (todos os novos em `chamados`, todos os antigos editados em `edicoes`): a cópia de saída é refeita da importada, então mandar só este chamado apagaria os demais.
    chamados: List[ChamadoManual] = Field(default_factory=list, max_length=MAX_CHAMADOS_POR_EXPORTACAO)
    edicoes: List[ChamadoManual] = Field(default_factory=list, max_length=MAX_CHAMADOS_POR_EXPORTACAO)


class DescricaoPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    descricao_finalizacao: str = Field("", max_length=fin.MAX_DESCRICAO * 2)  # the exact limit is checked (and explained) by the domain


class DescricaoEditadaPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    descricao: str = Field("", max_length=fin.MAX_DESCRICAO * 2)  # limite exato e mensagem ficam no domínio


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


class ReenvioSnapshotPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    envio_id: str = Field(..., pattern=r"^[a-f0-9]{32}$")
    sha256: str = Field(..., pattern=r"^[a-f0-9]{64}$")
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

    def _abertos_com_sugestoes(abertos: Sequence[Mapping[str, Any]]) -> List[Dict[str, Any]]:
        """Old open tickets plus what "Atualizar Dashboard" would fill into their empty E, K, L and N.

        An old ticket already read from SoftExpert (rotina ``antigos``) gets the same cross-reference as a new one:
        its description and requester fill the Dashboard's empty H and I for the name lookup (the API keeps both as they are)."""
        antigos = sebrae_novos.ler_antigos(sebrae_novos.caminho_antigos(services.caminhos())) if abertos else {}
        if antigos:
            antigos = sebrae_novos.aplicar_descricoes_antigos(antigos, fin.descricoes_editadas(_pasta_estado()))
        efetivos = sebrae_novos.complementar_antigos(abertos, antigos)
        registros = services.registros() if abertos else []
        sugestoes = sebrae_novos.preenchimentos(efetivos, registros, _relatorio(), services.vinculos_os()) if abertos else {}
        finalizacao = fin.ler_estado(_pasta_estado()) if abertos else {}
        apelidos = services.apelidos() if abertos else {}
        return [
            {**a, "automaticos_sugeridos": sugestoes.get(str(a.get("numero")), {}),
             "apelido": _apelido(apelidos, (a.get("automaticos") or {}).get("K") or sugestoes.get(str(a.get("numero")), {}).get("K")),
             **sebrae_cruzamento.avisos_de_nome(e.get("descricao"), e.get("usuario"), registros),
             "softexpert": fin.publico(finalizacao.get(str(a.get("numero")))),
             "leitura_softexpert": antigos.get(str(a.get("numero")))}  # ``softexpert`` is the finalization state; this is the read data
            for a, e in zip(abertos, efetivos)
        ]

    def _apelido(apelidos: Mapping[str, str], serie: Any) -> str:
        return apelidos.get(str(serie or "").strip().upper(), "")

    def _pasta_estado():
        return fin.pasta_estado(services.caminhos().existentes)

    def _novos(caminhos: sebrae_novos.Caminhos, lancados: Iterable[str]) -> Optional[Dict[str, Any]]:
        """Chamados novos da última busca já com a descrição que o usuário editou no site (lápis do cartão)."""
        novos = sebrae_novos.ler_novos(caminhos.novos, lancados)
        if novos is not None:
            novos["chamados"] = sebrae_novos.aplicar_descricoes_novos(novos["chamados"], fin.descricoes_editadas(_pasta_estado()))
        return novos

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
        novos = _novos(caminhos, lancados) if importado else None
        finalizacao = fin.ler_estado(_pasta_estado()) if novos else {}
        apelidos = services.apelidos() if novos else {}
        return {
            "importado": None if importado is None else {
                "versao": importado["versao"], "arquivo": importado["arquivo"], "importado_em": importado["importado_em"], "total": len(lancados),
                "listas": importado["listas"], "abertos": _abertos_com_sugestoes(importado["abertos"]),
                "finalizados": fin.finalizados_no_dashboard(_pasta_estado()),
                "atualizavel": sebrae_novos.ler_planilha(sebrae_novos.caminho_planilha(caminhos), importado["sha256"]) is not None,
                "saida_pronta": sebrae_novos.caminho_saida(caminhos, NOME_ATUALIZADO).is_file(),
            },
            "novos": None if novos is None else {
                "lidos_em": novos["lidos_em"], "ignorados": novos["ignorados"], "pendentes": novos["pendentes"],
                "erros": novos["erros"],
                "formulario": [
                    {**item, "apelido": _apelido(apelidos, item["linha"].get("K")), "softexpert": fin.publico(finalizacao.get(item["numero"]))}
                    for item in sebrae_novos.formulario(novos["chamados"], services.registros(), _relatorio(), services.vinculos_os())
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

    def _importar_bloqueado(conteudo: bytes, numeros: Any, nome: str, automatico: bool):
        with lock_paths([_base_guard()]):
            if automatico and sebrae_novos.dashboard_saida_pendente(services.caminhos()):
                raise DomainConflictError("Há um Dashboard atualizado aguardando envio. Envie ou preserve e confira essa cópia antes de repetir Baixar, importar e buscar; a importação automática foi impedida para não perder alterações.")
            ativa = _rotina_em_andamento()
            if fin.job_pendente(_pasta_estado()) or (ativa is not None and ativa.get("rotina") in ("fechar", "enviar")):
                raise DomainConflictError("Aguarde a finalização em andamento antes de reimportar o Dashboard.")
            anteriores = sebrae_novos.ler_existentes(services.caminhos().existentes)
            _arquivar_encerrados(conteudo, anteriores)
            preservada = sebrae_novos.caminho_saida(services.caminhos(), NOME_ATUALIZADO).is_file()
            _guardar_importado(conteudo, numeros, nome)
            historico_ok = _registrar_historico(conteudo, nome, anteriores)
            return JSONResponse({**_estado(), "historico_ok": historico_ok, "arquivo_ok": True, "saida_anterior_preservada": preservada}, headers={"Cache-Control": "no-store"})

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
        saida = sebrae_novos.caminho_saida(caminhos, NOME_ATUALIZADO)
        if saida.is_file():
            from uuid import uuid4
            preservada = saida.parent / "preservados" / f"{uuid4().hex}.xlsx"
            preservada.parent.mkdir(parents=True, exist_ok=True)
            saida.replace(preservada)  # only after the complete copy has a safe destination; never delete pending edits
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
            importado, resultado, conteudo, gravada, edicoes = _gravar_atualizacao(payload)
            return JSONResponse({
                "arquivo": NOME_ATUALIZADO,
                "base": {"arquivo": importado["arquivo"], "importado_em": importado["importado_em"]},
                "linhas": [
                    {"numero": g.numero, "linha": g.linha, "tipo": g.tipo, "celulas": list(g.celulas)} for g in resultado.linhas
                ],
                "conteudo_base64": base64.b64encode(conteudo).decode("ascii"),
                "fechar": (
                    _fechar_inativo("A cópia de saída não foi gravada; nada foi finalizado.") if not gravada
                    else _finalizar_marcados({**{c.numero: {"D": c.D} for c in payload.chamados}, **edicoes}) if payload.finalizar_softexpert
                    else _fechar_inativo("finalização no SoftExpert não confirmada")
                ),
            }, headers={"Cache-Control": "no-store"})

    def _gravar_atualizacao(payload: AtualizarPayload, *, aceita_vazio: bool = False):
        """Monta a cópia atualizada e a grava em ``sebrae_dashboard_saida``; devolve (importado, resultado, conteudo, gravada, edicoes validadas).

        Com ``aceita_vazio`` e nada a gravar, devolve ``None`` em vez de 422."""
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
            automaticos = sebrae_novos.preenchimentos(abertos, services.registros(), _relatorio(), services.vinculos_os())
            if not linhas and not edicoes and not automaticos:
                if aceita_vazio:
                    return None
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
        return importado, resultado, conteudo, gravada, edicoes

    def _reaplicar_encerramentos(conteudo: bytes) -> bytes:
        """A saída é refeita da cópia importada a cada "Atualizar": as datas de encerramento já gravadas voltam à coluna R (o horário do SoftExpert substitui um R digitado à mão)."""
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
        """Tickets (old edits and new rows) whose D the user just set to FINALIZADO go to the ``fechar`` routine; a failure here never fails the update."""
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

    def _rotina_em_andamento() -> Optional[Mapping[str, Any]]:
        """Estado do runner quando alguma rotina roda agora; ``None`` se está livre (ou sem runner: quem chama já recusa antes)."""
        if services.runner is None:
            return None
        ativo = services.runner().state()
        return ativo if ativo.get("estado") == "em_andamento" else None

    def _exigir_rotina_livre(pasta) -> None:
        """409 quando há pedido de finalização esperando ou uma rotina rodando; um runner sem estado legível deixa o ``start`` decidir."""
        if fin.job_pendente(pasta):
            raise DomainConflictError("Já há um pedido de finalização esperando a rotina começar. Aguarde terminar.")
        try:
            ativa = _rotina_em_andamento()
        except Exception:  # noqa: BLE001
            return
        if ativa is not None:
            raise DomainConflictError("Já há uma rotina em execução. Aguarde terminar.")

    def _disparar(numeros: Sequence[str], pulados: Sequence[Mapping[str, str]] = (), acao: str = fin.ACAO_FINALIZAR, *, envio_id: str = "", sha256: str = "") -> None:
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
                fin.gravar_job(pasta, numeros, pulados=pulados, acao=acao)
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
        """Lápis do cartão: texto do bloco "Descrição" editado só neste site (SoftExpert e coluna H já lançada não mudam); vazio restaura o original."""
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
        return sebrae_novos.ler_antigos(sebrae_novos.caminho_antigos(caminhos)).get(numero, {}).get("descricao", "")

    @router.put("/api/sebrae/chamados/{numero}/ficha")
    def definir_ficha(numero: str, payload: FichaPayload):
        """Cartão do chamado como estava na tela ao finalizar; aparece de novo em "Chamados finalizados"."""
        numero = _exigir_finalizavel(numero)
        fin.definir_ficha(_pasta_estado(), numero, payload.ficha)
        return JSONResponse({"numero": numero}, headers={"Cache-Control": "no-store"})

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
                raise DomainConflictError(f"{numero} já foi finalizado no SoftExpert.")
            if not fin.dados_para_finalizar(pasta, numero)[0]:
                raise DomainValidationError("Preencha a descrição para finalizar o chamado antes de finalizar.", status_code=422)
            # Os campos manuais entram na cópia de saída antes da rotina, que depois só grava R e D: sem isso o Dashboard enviado ao SharePoint perderia A, B, J e S.
            if payload.chamados or payload.edicoes:
                if services.runner is not None:
                    _exigir_rotina_livre(pasta)  # a rotina ocupada recusa antes de refazer a cópia; _disparar confere de novo dentro do lock
                gravacao = _gravar_atualizacao(AtualizarPayload(chamados=payload.chamados, edicoes=payload.edicoes, versao_importacao=payload.versao_importacao), aceita_vazio=True)
                if gravacao is not None and not gravacao[3]:
                    raise DomainBusyError("Não consegui gravar os campos manuais na cópia do Dashboard; nada foi finalizado.")
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
                ativo = _rotina_em_andamento()
                rodando = ativo is not None and ativo.get("rotina") == "fechar"
            except Exception:  # noqa: BLE001 - sem o estado do runner, vale o que o arquivo diz
                rodando = bool(resultado and resultado.get("em_andamento"))
        return JSONResponse({
            "em_andamento": rodando, "resultado": resultado, "sharepoint": fin.aviso_do_pendente(pasta),
        }, headers={"Cache-Control": "no-store"})

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
            except Exception:  # noqa: BLE001 - sem o estado do runner, vale o arquivo
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
            raise DomainValidationError(f"{desconhecidos[0]} não está entre os chamados novos.", status_code=422)
        return sebrae_novos.linhas_completas(escolhidos, manuais, services.registros(), _relatorio(), importado["listas"], exigir=False, vinculos=services.vinculos_os())

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
