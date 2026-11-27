"""Finalização no SoftExpert e rotinas ``fechar``/``enviar`` do Dashboard Sebrae (POST /api/sebrae/dashboard/atualizar,
finalizar-softexpert, conflitos e reenvios), extraídas de ``routers/sebrae_dashboard.py``.

Não depende de HTTP: cada função recebe ``services`` e valores simples; payload, ``versao_importacao`` e resposta ficam no
router. A trava de ``disparar`` (guarda da base, envio e job, nesta ordem) é o que impede repetir a ``fechar``, que é irreversível.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from core.errors import DomainBusyError, DomainConflictError, DomainError
from core.integrity import lock_paths
from domains import sebrae_finalizacao as fin, sebrae_novos
from domains import sebrae_dashboard_importacao as importacao, sebrae_dashboard_tela as tela
from domains.sebrae_chamados import chave_do_numero
from domains.sebrae_dashboard_tela import SebraeDashboardServices

logger = logging.getLogger("routers.sebrae_dashboard")  # mesmo logger do router: os testes usam assertLogs com esse nome e a saída de log não muda


def base_guard(services: SebraeDashboardServices) -> Path:
    return services.caminhos().existentes.parent / "sebrae_dashboard_base.guard"


def encerramento_do_pedido(services: SebraeDashboardServices, numero: str, encerramento: str, enviados: Sequence[Tuple[str, str]]) -> str:
    """R deste chamado: ``encerramento`` do corpo, senão o de ``edicoes``/``chamados``, senão o do Dashboard importado; ``""`` se faltar.

    ``enviados``: pares ``(numero, R)`` das edições e depois dos chamados (nessa ordem, a primeira vale)."""
    if encerramento.strip():
        return fin.encerramento_valido(encerramento)  # informado e fora do formato: não cai para outra fonte
    enviado = next((r for n, r in enviados if n == numero and r.strip()), "")
    if enviado:
        return fin.encerramento_valido(enviado)
    importado = sebrae_novos.ler_existentes(services.caminhos().existentes) or {}
    guardado = next((str((a.get("valores") or {}).get("R") or "") for a in importado.get("abertos", []) if str(a.get("numero")) == numero), "")
    return fin.encerramento_valido(guardado)


def congelar_os_vinculada(services: SebraeDashboardServices, pasta: Path, numeros: Sequence[str]) -> None:
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


def enviar_apos_atualizar(
    services: SebraeDashboardServices, pedido: bool, gravada: bool, fechar_iniciada: bool, finalizar_pedido: bool = False,
) -> Dict[str, Any]:
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
    return iniciar_envio(services)


def iniciar_envio(services: SebraeDashboardServices) -> Dict[str, Any]:
    """Starts the routine ``enviar`` with the same guards for both callers; a failure comes back as ``motivo``, never as an error."""
    if services.runner is None:
        return {"iniciado": False, "motivo": "A automação não está disponível neste servidor."}
    pasta = tela.pasta_estado(services)
    try:
        fin.exigir_envio_livre(pasta)
        exigir_rotina_livre(services, pasta)
        services.runner().start("enviar")
    except DomainError as erro:
        return {"iniciado": False, "motivo": str(erro.detail)}
    except Exception as erro:  # noqa: BLE001 - o arquivo já foi gravado; log só o tipo
        logger.warning("Não iniciei a rotina enviar (%s).", type(erro).__name__)
        return {"iniciado": False, "motivo": "Não foi possível iniciar o envio ao SharePoint."}
    return {"iniciado": True, "motivo": ""}


def fechar_inativo(motivo: str, pulados: Sequence[Mapping[str, str]] = ()) -> Dict[str, Any]:
    return {"iniciado": False, "motivo": motivo, "numeros": [], "pulados": [dict(p) for p in pulados]}


def encerramentos_manuais(services: SebraeDashboardServices, com_r: Mapping[str, str]) -> Dict[str, str]:
    """``{UTIC: R}`` dos que a última leitura do SoftExpert não achou (regra do usuário, 12/11/2026): se a ``fechar`` também não os achar,
    o R do usuário os registra como finalizados por outro técnico. Chamado achado na leitura nunca entra aqui.
    Quem chama passa só os confirmados pelo usuário (decisão de 25/11/2026)."""
    if not com_r:
        return {}
    perdidos = tela.nao_encontrados(services, tela.leitura_antigos(services))
    return {numero: r for numero, r in com_r.items() if numero in perdidos}


def finalizar_marcados(
    services: SebraeDashboardServices, edicoes: Mapping[str, Mapping[str, str]], confirmados: Iterable[str] = (),
) -> Dict[str, Any]:
    """Tickets (old edits and new rows) whose D the user just set to FINALIZADO go to the ``fechar`` routine; a failure here never fails the update."""
    pasta = tela.pasta_estado(services)
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
        return fechar_inativo("", pulados)
    try:
        confirmados = set(confirmados)
        manuais = encerramentos_manuais(services, {n: r for n, r in com_r.items() if n in confirmados})
        disparar(services, numeros, pulados, encerramentos_manuais=manuais, encerramentos=com_r)
    except DomainError as erro:
        return fechar_inativo(str(erro.detail), pulados)
    return {"iniciado": True, "motivo": "", "numeros": numeros, "pulados": pulados}


def rotina_em_andamento(services: SebraeDashboardServices) -> Optional[Mapping[str, Any]]:
    """Estado do runner quando alguma rotina roda agora; ``None`` se está livre (ou sem runner: quem chama já recusa antes)."""
    if services.runner is None:
        return None
    ativo = services.runner().state()
    return ativo if ativo.get("estado") == "em_andamento" else None


def exigir_sem_finalizacao(services: SebraeDashboardServices, mensagem: str) -> None:
    """409 com pedido de finalização esperando ou ``fechar``/``enviar`` rodando (outras rotinas, como ``antigos``, não bloqueiam).

    Estado do executor ilegível: 503, sem gravar (não dá para saber se a ``fechar`` está gravando a mesma saída)."""
    try:
        ativa = rotina_em_andamento(services)
    except Exception as erro:  # noqa: BLE001
        logger.warning("Estado do executor de rotinas ilegível (%s).", type(erro).__name__)
        raise DomainBusyError("Não foi possível conferir se há rotina em execução. Tente de novo.") from erro
    if ativa is None and services.runner is not None and (orfaos := fin.descartar_job_orfao(tela.pasta_estado(services))) is not None:  # mesma regra de ``exigir_rotina_livre``
        logger.warning("Pedido de finalização órfão descartado (%s chamado(s)).", orfaos)
    if fin.job_pendente(tela.pasta_estado(services)) or (ativa is not None and ativa.get("rotina") in ("fechar", "enviar")):
        raise DomainConflictError(mensagem)


def exigir_rotina_livre(services: SebraeDashboardServices, pasta: Path) -> None:
    """409 quando há pedido de finalização esperando ou uma rotina rodando; um runner sem estado legível deixa o ``start`` decidir."""
    try:
        ativa = rotina_em_andamento(services)
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


def disparar(
    services: SebraeDashboardServices, numeros: Sequence[str], pulados: Sequence[Mapping[str, str]] = (), acao: str = fin.ACAO_FINALIZAR, *,
    envio_id: str = "", sha256: str = "", encerramentos_manuais: Mapping[str, str] = {}, encerramentos: Mapping[str, str] = {},
) -> None:
    """Writes the one-shot job and starts ``fechar`` under one lock on the job file: two requests cannot overwrite each other's job.

    409 when a run is in progress or another job still waits; the job is removed if the routine does not start."""
    if services.runner is None:
        raise DomainBusyError("A automação não está disponível neste servidor.")
    runner = services.runner()
    pasta = tela.pasta_estado(services)
    with lock_paths([base_guard(services), fin.caminho_envio(pasta), fin.caminho_job(pasta)]):
        exigir_rotina_livre(services, pasta)
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
                congelar_os_vinculada(services, pasta, numeros)  # before the job: the link may change while the routine runs
            fin.gravar_job(pasta, numeros, pulados=pulados, acao=acao, encerramentos_manuais=encerramentos_manuais, encerramentos=encerramentos)
        try:
            runner.start("fechar")
        except BaseException:
            fin.apagar_job(pasta)
            raise
