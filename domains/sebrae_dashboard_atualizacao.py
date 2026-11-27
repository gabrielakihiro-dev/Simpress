"""Gravação da cópia atualizada do Dashboard Sebrae (POST /api/sebrae/dashboard/atualizar e finalizar-softexpert), extraída de
``routers/sebrae_dashboard.py``.

Não depende de HTTP: cada função recebe ``services`` e valores simples (``chamados``/``edicoes`` são os dicts completos de
``ChamadoManual.model_dump()``, com ``numero``); payload, trava da base e rotinas ficam no router.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from core.errors import DomainValidationError
from core.integrity import lock_paths
from domains import sebrae_dashboard_gravacao, sebrae_finalizacao as fin, sebrae_novos, sebrae_os_nova
from domains import sebrae_dashboard_importacao as importacao, sebrae_dashboard_tela as tela
from domains.sebrae_dashboard import MANUAIS, DashboardInvalido
from domains.sebrae_dashboard_tela import NOME_ATUALIZADO, SebraeDashboardServices

logger = logging.getLogger("routers.sebrae_dashboard")  # mesmo logger do router: os testes usam assertLogs com esse nome e a saída de log não muda


def falta_encerramento(numero: str) -> str:
    """Mesma frase no 422 de Atualizar e do botão por chamado (o front repete no singular: ``avisoEncerramento``)."""
    return f"Informe a DT ENCERRAMENTO (coluna R) do chamado {numero} antes de finalizar."


def exigir_outro_tecnico(numero: str, valores: Mapping[str, Any]) -> None:
    """Decisão do usuário (25/11/2026): confirmar "finalizado por outro técnico" exige A, B, D=FINALIZADO e R válida; ``valores`` são os que vão à cópia."""
    faltas = [rotulo for letra, rotulo in (("A", "A (Cliente/Simpress)"), ("B", "B (Categoria)")) if not str(valores.get(letra) or "").strip()]
    if str(valores.get("D") or "").strip().upper() != sebrae_novos.STATUS_FINALIZADO:
        faltas.append("D (FINALIZADO)")
    if not fin.encerramento_valido(valores.get("R")):
        faltas.append("R (DT ENCERRAMENTO, dd/MM/aaaa HH:mm)")
    if faltas:
        lista = faltas[0] if len(faltas) == 1 else f"{', '.join(faltas[:-1])} e {faltas[-1]}"
        raise DomainValidationError(f"Para registrar {numero} como finalizado por outro técnico, preencha {lista}.", status_code=422)


def tem_encerramento(services: SebraeDashboardServices, numero: str, r: Any) -> bool:
    """R válido enviado/gravado, ou chamado já finalizado por este site (o R registrado volta pela ``reaplicar_encerramentos``)."""
    return bool(fin.encerramento_valido(r)) or fin.ja_finalizado(tela.pasta_estado(services), numero)


def gravar_atualizacao(
    services: SebraeDashboardServices, chamados: Sequence[Mapping[str, Any]], edicoes: Sequence[Mapping[str, Any]],
    nomes_pessoas: Callable[[], List[Any]], *, aceita_vazio: bool = False, exigir_encerramento: bool = False,
    confirmados: Optional[Mapping[str, str]] = None,
) -> Optional[Tuple[Dict[str, Any], sebrae_dashboard_gravacao.Resultado, bytes, bool, Dict[str, Dict[str, str]]]]:
    """Monta a cópia atualizada e a grava em ``sebrae_dashboard_saida``; devolve (importado, resultado, conteudo, gravada, edicoes validadas).

    Com ``aceita_vazio`` e nada a gravar, devolve ``None`` em vez de 422. Com ``exigir_encerramento`` (só o "Atualizar"),
    D=FINALIZADO à mão (novo ou antigo) exige a coluna R (regra de 24/11/2026); o ``finalizar-softexpert`` por cartão confere só o
    próprio chamado, antes de chamar esta função.

    ``confirmados`` (só pedidos que disparam a ``fechar``): ``{UTIC confirmado como finalizado por outro técnico: R a conferir}``
    (``""`` = o R do chamado). Cada um passa por ``exigir_outro_tecnico`` antes de gravar; o não encontrado na leitura e não
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
            for novo in chamados:
                if novo["D"].strip().upper() == sebrae_novos.STATUS_FINALIZADO and not tem_encerramento(services, novo["numero"], novo["R"]):
                    raise sebrae_novos.ManuaisInvalidos(falta_encerramento(novo["numero"]))
        linhas = linhas_novas(services, chamados, importado, caminhos)
        validadas = edicoes_validadas(services, edicoes, planilha, importado["listas"], exigir_encerramento)
        abertos = [c.como_dict() for c in sebrae_dashboard_gravacao.chamados_para_editar(planilha)]
        if confirmados:  # valores que vão à cópia: os mesclados das edições, os do novo ou os já gravados
            guardados: Dict[str, Any] = {str(a["numero"]): a["valores"] for a in abertos}
            novos = {c["numero"]: c for c in chamados}
            for numero, r in confirmados.items():
                valores: Mapping[str, Any] = validadas.get(numero) or novos.get(numero) or guardados.get(numero) or {}
                exigir_outro_tecnico(numero, {**valores, "R": r} if r else valores)
        antigos = tela.leitura_antigos(services) if abertos else {}
        registros = services.registros() if abertos else []
        relatorio, indice = (tela.relatorio(services), tela.indice_endpoint(services)) if abertos else (None, None)
        automaticos = tela.automaticos_dos_abertos(services, abertos, antigos, registros, relatorio, indice) if abertos else {}
        trocas = sebrae_os_nova.trocas_e(
            tela.os_novas_dos_abertos(services, abertos, antigos, registros, automaticos, relatorio, indice), abertos, list(services.vinculos_os()),
        )
        limpar = tela.limpar_e_dos_abertos(services, abertos, trocas)
        descricoes = descricoes_editadas_dos_antigos(services, abertos)
        if not linhas and not validadas and not automaticos and not descricoes and not trocas and not limpar:
            if aceita_vazio:
                return None
            raise DomainValidationError("Não há chamados novos, alterações nem dados para preencher.", status_code=422)
        gravar = {**validadas, **{n: {**validadas.get(n, {}), "H": h} for n, h in descricoes.items()}}
        if confirmados is not None:  # em branco não apaga: fica o D e o R da cópia importada
            perdidos = tela.nao_encontrados(services, antigos) - set(confirmados)
            gravar = {
                n: ({**v, "D": "", "R": ""} if n in perdidos and v.get("D") == sebrae_novos.STATUS_FINALIZADO else v)
                for n, v in gravar.items()
            }
        resultado = sebrae_dashboard_gravacao.atualizar(planilha, linhas, gravar, automaticos, trocas, limpar)
    except (sebrae_novos.ManuaisInvalidos, DashboardInvalido) as erro:
        raise DomainValidationError(str(erro), status_code=422) from None
    conteudo = reaplicar_encerramentos(services, resultado.conteudo)
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
        importacao.reindexar_categoria(services, conteudo, nomes_pessoas)  # aprende com o B e o J que o usuário acabou de classificar
    except OSError:  # o download do usuário segue; só o "Enviar ao SharePoint" fica sem arquivo
        logger.warning("Não gravei a cópia de saída do Dashboard.", exc_info=True)
    return importado, resultado, conteudo, gravada, validadas


def descricoes_editadas_dos_antigos(services: SebraeDashboardServices, abertos: Sequence[Mapping[str, Any]]) -> Dict[str, str]:
    """``{chave: texto}`` da descrição editada no lápis do cartão, para a coluna H dos antigos em aberto cujo H é diferente.

    Só vale para chave UTIC (``linha:<n>`` nunca tem texto editado). Vai só à cópia do Dashboard: o SoftExpert e a rotina
    ``fechar`` nunca a recebem. Texto vazio não chega aqui (restaurar não apaga um H já gravado)."""
    editadas = fin.descricoes_editadas(tela.pasta_estado(services))
    if not editadas:
        return {}
    textos = {a["numero"]: (sebrae_novos.descricao_para_celula(editadas[a["numero"]]), a["descricao"]) for a in abertos if a["numero"] in editadas}
    return {n: novo for n, (novo, atual) in textos.items() if novo and not sebrae_dashboard_gravacao.h_ja_gravado(novo, atual)}


def reaplicar_encerramentos(services: SebraeDashboardServices, conteudo: bytes) -> bytes:
    """A saída é refeita da cópia importada a cada "Atualizar": D=FINALIZADO e o R registrados ao finalizar voltam à linha do chamado.

    Decisão do usuário (26/11/2026): linha que a cópia importada já traz com D FINALIZADO e R válido (``dd/MM/aaaa HH:mm``) não
    muda, nem D nem R, mesmo com R diferente do registrado (o R digitado à mão vale). A gravação logo depois da ``fechar`` não passa por aqui."""
    encerramentos = fin.encerramentos_registrados(tela.pasta_estado(services))
    if not encerramentos:
        return conteudo
    try:
        return sebrae_dashboard_gravacao.registrar_encerramentos(conteudo, encerramentos, manter_finalizados=True)[0].conteudo
    except Exception as erro:  # noqa: BLE001 - a atualização não pode falhar por isso; log só o tipo
        logger.warning("Datas de encerramento não reaplicadas à saída (%s).", type(erro).__name__)
        return conteudo


def linhas_novas(
    services: SebraeDashboardServices, chamados: Sequence[Mapping[str, Any]], importado: Mapping[str, Any], caminhos: sebrae_novos.Caminhos,
) -> List[Dict[str, str]]:
    if not chamados:
        return []
    novos = tela.novos(services, caminhos, importado["numeros"])
    if novos is None:
        raise DomainValidationError("Busque os chamados novos antes de atualizar.", status_code=422)
    manuais = {item["numero"]: {k: v for k, v in item.items() if k != "numero"} for item in chamados}
    if len(manuais) != len(chamados):
        raise DomainValidationError("Há chamados repetidos na atualização.", status_code=422)
    escolhidos = [c for c in novos["chamados"] if c.numero in manuais]
    desconhecidos = sorted(set(manuais) - {c.numero for c in escolhidos})
    if desconhecidos:
        ja_no_dashboard = next((n for n in desconhecidos if n in importado["numeros"]), None)
        if ja_no_dashboard:  # typed into the Dashboard by hand after the search
            raise DomainValidationError(f"{ja_no_dashboard} já está no Dashboard (incluído à mão depois da busca); confira-o em Chamados antigos em aberto e atualize de novo.", status_code=422)
        raise DomainValidationError(f"{desconhecidos[0]} não está entre os chamados novos.", status_code=422)
    return sebrae_novos.linhas_completas(escolhidos, manuais, services.registros(), tela.relatorio(services), importado["listas"], exigir=False, vinculos=services.vinculos_os())


def edicoes_validadas(
    services: SebraeDashboardServices, edicoes: Sequence[Mapping[str, Any]], planilha: bytes, listas: Mapping[str, Sequence[str]],
    exigir_encerramento: bool = False,
) -> Dict[str, Dict[str, str]]:
    """Merged (stored + sent) manual values that are filled pass the same rules as a new ticket (A, D and J may stay
    blank); an off-list A/B it already has is kept. The title (G) goes only when typed, already masked.

    With ``exigir_encerramento``: D=FINALIZADO without a valid R (none sent, none stored) is refused (rule of 24/11/2026: the
    closing date is always typed by the user, never the current time). A stored R without the time, not sent again, counts as
    blank (26/11/2026): it never blocks an edit of A, B, J or S and, blank, it is never rewritten."""
    if not edicoes:
        return {}
    abertos = {c.numero: c for c in sebrae_dashboard_gravacao.chamados_para_editar(planilha)}
    validadas: Dict[str, Dict[str, str]] = {}
    for item in edicoes:
        numero = item["numero"]
        atual = abertos.get(numero)
        if atual is None:
            raise DomainValidationError(f"{numero} não é um chamado antigo EM ABERTO ou sem status.", status_code=422)
        if numero in validadas:
            raise DomainValidationError("Há chamados repetidos na atualização.", status_code=422)
        enviados = {k: v for k, v in item.items() if k != "numero"}
        mesclados = {letra: str(enviados.get(letra) or "") or atual.valores.get(letra, "") for letra in MANUAIS}
        if not str(enviados.get("R") or "").strip() and not fin.encerramento_valido(mesclados.get("R")):
            mesclados["R"] = ""  # regra de 25/11/2026: R guardado só com a data é falta de R; não trava a edição e não é regravado
        try:
            validados = sebrae_novos.validar_manuais(mesclados, exigir=False)
            sebrae_novos.validar_listas(validados, listas, atual.valores)
            titulo = sebrae_novos.titulo_editado(enviados)
            if titulo:  # G is not in MANUAIS: it only goes when typed; the ticket is still found by its key, never by the title
                validados["G"] = titulo
        except sebrae_novos.ManuaisInvalidos as erro:
            raise sebrae_novos.ManuaisInvalidos(f"{numero}: {erro}") from None
        if exigir_encerramento and validados["D"] == sebrae_novos.STATUS_FINALIZADO and not tem_encerramento(services, numero, validados["R"]):
            raise sebrae_novos.ManuaisInvalidos(falta_encerramento(numero))
        validadas[numero] = validados
    return validadas
