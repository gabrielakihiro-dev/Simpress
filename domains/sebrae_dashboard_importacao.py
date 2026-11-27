"""Importação do Dashboard Sebrae (POST /api/sebrae/dashboard), extraída de ``routers/sebrae_dashboard.py``.

Não depende de HTTP: cada função recebe ``services``; a trava de arquivo e a checagem de rotina em andamento ficam no router.
"""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence

from core.errors import DomainBusyError, DomainConflictError, DomainValidationError
from domains import (
    os_marcas_finalizacao as marcas, sebrae_arquivo, sebrae_categoria, sebrae_credenciais, sebrae_dashboard_gravacao, sebrae_finalizacao as fin,
    sebrae_historico, sebrae_novos, sebrae_observacoes as obs, sebrae_os_recusadas, sebrae_vinculos,
)
from domains import sebrae_dashboard_tela as tela
from domains.sebrae_dashboard import DashboardInvalido, ler_status_chamados
from domains.sebrae_dashboard_tela import SebraeDashboardServices

logger = logging.getLogger("routers.sebrae_dashboard")  # mesmo logger do router: os testes usam assertLogs com esse nome e a saída de log não muda


def valores_ou_none(conteudo: Optional[bytes]) -> Optional[Dict[int, Any]]:
    """Row values of a Dashboard copy; ``None`` when it is missing or unreadable, so it never equals anything."""
    if conteudo is None:
        return None
    try:
        return sebrae_dashboard_gravacao.valores_dos_chamados(conteudo)
    except (OSError, ValueError, KeyError):  # DashboardInvalido and GravacaoInvalida are ValueError
        return None


def mesma_planilha(baixada: bytes, referencia: Optional[bytes]) -> bool:
    """Same bytes, or same ticket-row values (a re-save in Excel changes bytes, not data)."""
    if referencia is None:
        return False
    if hashlib.sha256(baixada).digest() == hashlib.sha256(referencia).digest():
        return True
    valores = valores_ou_none(baixada)
    return valores is not None and valores == valores_ou_none(referencia)


def classificar_saida_pendente(services: SebraeDashboardServices, conteudo: bytes) -> str:
    """Compare the Dashboard just downloaded with the pending output and with the imported base (read only):
    ``igual_saida`` (the output is already there), ``igual_base`` (nothing changed, the output can still be sent)
    or ``divergente`` (edited after the import, or no readable base: the output can no longer be sent)."""
    caminhos = services.caminhos()
    try:
        saida = sebrae_novos.caminho_saida(caminhos, tela.NOME_ATUALIZADO).read_bytes()
    except OSError:
        saida = None
    if mesma_planilha(conteudo, saida):
        return "igual_saida"
    importado = sebrae_novos.ler_existentes(caminhos.existentes)
    base = sebrae_novos.ler_planilha(sebrae_novos.caminho_planilha(caminhos), importado["sha256"]) if importado else None
    if mesma_planilha(conteudo, base):
        return "igual_base"
    # Same acceptance as the check of ``enviar``: the file this site last put on SharePoint (hash, or values after SharePoint re-saved it).
    pasta = tela.pasta_estado(services)
    enviado = fin.ler_enviado(pasta)
    if (enviado and hashlib.sha256(conteudo).hexdigest() == enviado) or mesma_planilha(conteudo, fin.ler_copia_enviada(pasta)):
        return "igual_base"
    return "divergente"


def acompanhar_chaves_de_linha(services: SebraeDashboardServices, anteriores: Optional[Mapping[str, Any]]) -> str:
    """Chamados antigos sem UTIC têm a chave ``linha:<n>``; se a planilha mudou de ordem, a observação e o destaque seguem o chamado
    de mesmo conteúdo (C, G, I, H) e único nas duas importações. Devolve o aviso dos que não deu para seguir ('' se nenhum)."""
    atuais = sebrae_novos.ler_existentes(services.caminhos().existentes)
    if not anteriores or not atuais or not atuais["abertos"]:
        return ""
    mapa = sebrae_novos.mapear_chaves_de_linha(anteriores["abertos"], atuais["abertos"])
    try:
        sem_rastro = obs.acompanhar_chaves(tela.pasta_estado(services), mapa) if any(nova != antiga for antiga, nova in mapa.items()) else []
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


def arquivar_encerrados(services: SebraeDashboardServices, conteudo: bytes, anteriores: Optional[Mapping[str, Any]]) -> Mapping[str, Mapping[str, str]]:
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


def apagar_senhas_encerradas(services: SebraeDashboardServices, mapa: Mapping[str, Mapping[str, str]], anteriores: Optional[Mapping[str, Any]]) -> str:
    """Stored F5 password of a ticket closed (D FINALIZADO) or gone from column C in this import (FINALIZADO always; the gone-from-C ones obey the count limit); never blocks the import.
    Returns a warning (counts only, no ticket numbers) when the gone-from-C cleanup was skipped for deleting too many at once, else ''."""
    try:
        resultado = sebrae_credenciais.remover_encerrados(tela.pasta_estado(services), mapa, anteriores["abertos"] if anteriores else [])
    except Exception as erro:  # noqa: BLE001 - log only the type, never ticket data
        logger.warning("Senhas guardadas dos chamados encerrados não apagadas (%s).", type(erro).__name__)
        return ""
    if not resultado.pulado:
        return ""
    return (
        f"A importação apagaria {resultado.previstas_saida} senhas guardadas de chamados que sumiram da coluna C "
        f"(de {resultado.guardadas} guardadas); essas não foram apagadas. Confira se a planilha está completa."
    )


def resolvedor_os(services: SebraeDashboardServices, abertos: Sequence[Mapping[str, Any]]) -> marcas.Resolvedor:
    """Link UTIC -> OS for the mark of the OS tab: manual wins over the one derived from ``abertos``; several OS give the highest."""
    def derivados() -> List[Dict[str, Any]]:
        # These callers WRITE (marks, frozen OS): an unreadable refusal file must not let a strong-key swap through.
        recusadas = sebrae_os_recusadas.ler_ou_none(tela.pasta_estado(services))
        return sebrae_vinculos.vinculos_derivados(
            abertos, tela.relatorio(services), tela.indice_endpoint(services), recusadas, chave_forte=recusadas is not None,
            manuais=list(services.vinculos_os()),
        )

    return marcas.resolvedor(list(services.vinculos_os()), derivados)


def registrar_marcas(services: SebraeDashboardServices, arquivo: Path, mapa: Mapping[str, Mapping[str, str]], anteriores: Optional[Mapping[str, Any]]) -> None:
    """Source c of the marks: a UTIC open in the previous import, gone from the new one and not finalized by this site.
    Only an unreadable or busy marks file (``DomainBusyError``) blocks the import; any other failure is logged and the import goes on."""
    if not anteriores or not anteriores.get("abertos"):
        return
    try:
        saidas = marcas.detectar_saidas(
            anteriores["abertos"], mapa, fin.ler_estado(tela.pasta_estado(services)), resolvedor_os(services, anteriores["abertos"]),
        )
        marcas.registrar_saidas(arquivo, saidas)
    except DomainBusyError:
        raise
    except Exception as erro:  # noqa: BLE001 - log only the type, never ticket data
        logger.warning("Marcas de OS finalizada não registradas na importação (%s).", type(erro).__name__)


def registrar_historico(services: SebraeDashboardServices, conteudo: bytes, nome: str, anteriores: Optional[Mapping[str, Any]]) -> bool:
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


def reindexar_categoria(services: SebraeDashboardServices, conteudo: bytes, nomes_pessoas: Callable[[], List[Any]]) -> None:
    """Refaz o índice local da sugestão de categoria (B) e tipo (J); só aprende, nunca bloqueia importar nem atualizar."""
    try:
        sebrae_categoria.construir_indice(conteudo, tela.pasta_estado(services) / sebrae_categoria.ARQUIVO_INDICE, nomes_pessoas())
    except Exception as erro:  # noqa: BLE001 - log only the type, never ticket data
        logger.warning("Não atualizei o índice de sugestão de categoria (%s).", type(erro).__name__)


def guardar_importado(services: SebraeDashboardServices, conteudo: bytes, numeros: Any, nome: str, nomes_pessoas: Callable[[], List[Any]]) -> Optional[Path]:
    """Numbers, A/B lists and open tickets go to the JSON; the file itself is kept for "Atualizar Dashboard".
    A Dashboard the writer cannot read still imports, so the paste flow keeps working.
    Returns the path the old output was moved to, or ``None`` when there was none."""
    caminhos = services.caminhos()
    preservada = None
    # a saída antiga vem da importação anterior; enviá-la ao SharePoint apagaria o que entrou desde então
    saida = sebrae_novos.caminho_saida(caminhos, tela.NOME_ATUALIZADO)
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
        reindexar_categoria(services, conteudo, nomes_pessoas)
    return preservada


def importar(
    services: SebraeDashboardServices, conteudo: bytes, numeros: Any, nome: str, automatico: bool, nomes_pessoas: Callable[[], List[Any]],
) -> Dict[str, Any]:
    substituida = False
    if automatico and sebrae_novos.dashboard_saida_pendente(services.caminhos()):
        situacao = classificar_saida_pendente(services, conteudo)  # before guardar_importado replaces the base
        if situacao == "igual_base":
            raise DomainConflictError("Há um Dashboard atualizado aguardando envio e o Dashboard do SharePoint não mudou desde a importação. Clique em Enviar ao SharePoint; a importação automática foi impedida para não perder alterações.")
        substituida = situacao == "divergente"
    # tudo o que a resposta e as gravações leem, ANTES de gravar: arquivo ilegível dá 503 sem gravar nada (``_estado`` roda no fim)
    anteriores = sebrae_novos.ler_existentes(services.caminhos().existentes, estrito=True)
    obs.ler_observacoes(tela.pasta_estado(services))
    fin.ler_estado(tela.pasta_estado(services))
    arquivo_marcas = marcas.caminho_marcas(tela.pasta_estado(services))
    marcas.validar_legivel(arquivo_marcas)  # marks unreadable: stop before anything of this import is written
    mapa = arquivar_encerrados(services, conteudo, anteriores)
    registrar_marcas(services, arquivo_marcas, mapa, anteriores)
    preservada = guardar_importado(services, conteudo, numeros, nome, nomes_pessoas)
    avisos = []
    aviso_senhas = apagar_senhas_encerradas(services, mapa, anteriores)  # after the new base is stored: a failed import prunes nothing
    if aviso_senhas:
        avisos.append(aviso_senhas)
    aviso_linhas = acompanhar_chaves_de_linha(services, anteriores)  # after the new base is stored: a retry never moves keys twice
    historico_ok = registrar_historico(services, conteudo, nome, anteriores)
    # ia=False: the optional AI call (network, up to ~8 s) must not hold the file lock; the next GET fills the suggestions
    corpo = {**tela.estado(services, nomes_pessoas, ia=False), "historico_ok": historico_ok, "arquivo_ok": True, "saida_anterior_preservada": preservada is not None}
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
    return corpo
