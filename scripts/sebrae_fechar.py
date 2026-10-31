"""Rotina ``fechar``: finaliza no SoftExpert os chamados que o usuário marcou FINALIZADO no site.

Única escrita no SoftExpert fora a confirmação de associar o chamado (``sebrae_softexpert.finalizar_chamado``).
Entrada: o arquivo de pedido ``data/state/sebrae_fechar_job.json`` (números UTIC; o texto e o PDF de cada chamado
são lidos do estado no momento da execução). Saída: ``data/state/sebrae_fechar_resultado.json`` com um resultado por
chamado (``ok``, ``nao_encontrado``, ``erro``, ``sem_descricao`` e ``pronto`` no modo ``--sem-finalizar``).

Depois de finalizar, a data/hora do encerramento vai para a coluna R do Dashboard (linha achada pelo número na
coluna C, só se R estiver vazia) e o arquivo é enviado ao SharePoint pela rotina ``enviar``. Se o envio falhar,
fica uma cópia pendente em ``data/state/sebrae_dashboard_pendente`` e o resultado traz o aviso para a tela.

As utilidades do runner (log, cancelamento, abas, envio) entram por ``rotinas``, como em ``sebrae_leitura``;
os testes passam um falso em ``rotinas`` e em ``modulo``, sem navegador.
"""

from __future__ import annotations

import io
import shutil
import sys
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.integrity import atomic_write_bytes, lock_paths  # noqa: E402
from core.xlsx_safety import validate_xlsx_archive  # noqa: E402
from domains import sebrae_dashboard_gravacao as gravacao  # noqa: E402
from domains import sebrae_finalizacao as fin  # noqa: E402
from domains import sebrae_novos  # noqa: E402
from domains.sebrae_dashboard import ler_coluna_c  # noqa: E402
from scripts import sebrae_softexpert  # noqa: E402

if TYPE_CHECKING:
    from playwright.sync_api import BrowserContext, Page

STATE_DIR = ROOT / "data" / "state"
ORIGEM = "Sebrae fechar"
MOTIVO_SESSAO = "O SoftExpert pediu login de novo; entre no SoftExpert no Chrome de automação e finalize outra vez."


def _fechar_aba(pagina: Optional["Page"]) -> None:
    try:
        if pagina is not None and not pagina.is_closed():
            pagina.close()
    except Exception:  # fechar a aba é só limpeza; não pode esconder o resultado
        pass


def _validar_xlsx(conteudo: bytes) -> None:
    """O Dashboard que vai ao SharePoint precisa abrir como .xlsx e manter a coluna C."""
    with zipfile.ZipFile(io.BytesIO(conteudo)) as arquivo:
        validate_xlsx_archive(arquivo)
        if arquivo.testzip() is not None:
            raise ValueError("o arquivo está corrompido")
    ler_coluna_c(conteudo)


def _gravar_encerramentos(state_dir: Path, encerramentos: Dict[str, str]) -> "tuple[Optional[Path], Dict[str, str], str]":
    """Coluna R na cópia de saída (ou, se ainda não há, na cópia importada). Devolve (arquivo, estado por chamado, erro)."""
    caminhos = sebrae_novos.caminhos_padrao(state_dir)
    saida = sebrae_novos.caminho_saida(caminhos, fin.NOME_DASHBOARD)
    with lock_paths([saida]):
        if saida.is_file():
            base: Optional[bytes] = saida.read_bytes()
        else:
            existentes = sebrae_novos.ler_existentes(caminhos.existentes)
            base = sebrae_novos.ler_planilha(sebrae_novos.caminho_planilha(caminhos), existentes["sha256"]) if existentes else None
        if base is None:
            return None, {}, "Não há Dashboard importado utilizável; a coluna R não foi gravada."
        try:
            resultado, estados = gravacao.registrar_encerramentos(base, encerramentos)
            _validar_xlsx(resultado.conteudo)
        except Exception as erro:  # noqa: BLE001 - a mensagem da gravação é para o usuário
            return None, {}, f"A coluna R não foi gravada: {erro}"
        if resultado.linhas:
            atomic_write_bytes(saida, resultado.conteudo)
        return (saida if saida.is_file() else None), estados, ""


def _descartar_pendentes(state_dir: Path, log: Callable[[str], None]) -> None:
    """Depois de um envio bem-sucedido; falhar em apagar não desfaz o envio, só deixa o aviso para a tela."""
    try:
        fin.descartar_pendentes(state_dir)
    except OSError as erro:
        log(f"Não consegui apagar a cópia pendente antiga ({type(erro).__name__}); apague-a à mão em sebrae_dashboard_pendente.")


def _enviar_ao_sharepoint(
    context: "BrowserContext", rotinas: Any, state_dir: Path, saida: Path, chamados: List[str], log: Callable[[str], None],
    agora: Callable[[], datetime],
) -> Dict[str, Any]:
    """Substitui o Dashboard pela rotina ``enviar``; se falhar, guarda a cópia pendente e tenta subi-la com outro nome."""
    try:
        rotinas.rodar_rotina_enviar(context)
    except Exception as erro:  # noqa: BLE001 - RotinaCancelada (BaseException) sobe
        motivo = rotinas.descrever_erro(erro)
    else:
        _descartar_pendentes(state_dir, log)  # o que subiu é mais novo que qualquer cópia pendente: reenviá-la desfaria o envio
        return fin.aviso_sharepoint(False)
    log(f"Não consegui substituir o Dashboard no SharePoint: {motivo}")
    try:
        pendente = fin.guardar_pendente(state_dir, saida, agora(), motivo=motivo, tickets=chamados)
    except OSError as erro_local:
        log(f"Também não consegui guardar a cópia pendente ({type(erro_local).__name__}).")
        return fin.aviso_sharepoint(True, motivo)
    log(f"Cópia pendente guardada em {pendente}")
    copia_sharepoint = False
    try:
        rotinas.enviar_copia_pendente(context, pendente)
        fin.marcar_copia_sharepoint(pendente)
        copia_sharepoint = True
        log("A cópia pendente foi enviada à pasta DASHBOARD SEBRAE com outro nome; o original não foi alterado.")
    except Exception as erro_copia:  # noqa: BLE001
        log(f"A cópia pendente não subiu ao SharePoint: {rotinas.descrever_erro(erro_copia)}")
    return fin.aviso_sharepoint(True, motivo, str(pendente), copia_sharepoint)


def _reenviar_pendente(context: "BrowserContext", rotinas: Any, state_dir: Path, log: Callable[[str], None]) -> int:
    """\"Tentar substituir de novo\": envia a cópia pendente mais recente com o nome do Dashboard (a rotina ``enviar`` substitui)."""
    resultado: Dict[str, Any] = {
        "acao": fin.ACAO_REENVIAR, "iniciado_em": fin.agora_iso(), "terminado_em": None, "em_andamento": True,
        "resultados": [], "pulados": [], "sharepoint": None,
    }
    fin.gravar_resultado(state_dir, resultado)
    try:
        achado = fin.pendente_mais_recente(state_dir)
        if achado is None:
            raise rotinas.RotinaErro("Não há cópia pendente do Dashboard para enviar.")
        pendente, registro = achado
        with tempfile.TemporaryDirectory(prefix="dashboard-pendente-") as pasta:
            arquivo = Path(pasta) / fin.NOME_DASHBOARD
            shutil.copyfile(pendente, arquivo)
            try:
                _validar_xlsx(arquivo.read_bytes())
                rotinas.rodar_rotina_enviar(context, arquivo)
            except Exception as erro:  # noqa: BLE001
                motivo = rotinas.descrever_erro(erro)
                log(f"O reenvio falhou: {motivo}")
                resultado["sharepoint"] = fin.aviso_sharepoint(
                    True, motivo, str(pendente), bool(registro.get("copia_sharepoint")),
                )
                return 1
        _descartar_pendentes(state_dir, log)
        resultado["sharepoint"] = fin.aviso_sharepoint(False)
        log("Dashboard enviado; a cópia pendente local foi removida. Apague à mão a cópia \"(pendente ...)\" da pasta do SharePoint, se houver.")
        return 0
    finally:
        resultado["em_andamento"] = False
        resultado["terminado_em"] = fin.agora_iso()
        fin.gravar_resultado(state_dir, resultado)


def executar(
    context: "BrowserContext",
    rotinas: Any,
    *,
    state_dir: Path = STATE_DIR,
    modulo: Any = sebrae_softexpert,
    sem_finalizar: bool = False,
    agora: Callable[[], datetime] = fin.agora_local,
) -> int:
    log = lambda texto: rotinas.log(ORIGEM, texto)  # noqa: E731
    print(f"\n=== FINALIZAR CHAMADOS NO SOFTEXPERT (início {rotinas.agora_iso()}) ===", flush=True)
    job = fin.consumir_job(state_dir)
    if job is None:
        raise rotinas.RotinaErro("Não há pedido de finalização válido (ele vale por 2 horas); peça de novo pelo site.")
    if job["acao"] == fin.ACAO_REENVIAR:
        return _reenviar_pendente(context, rotinas, state_dir, log)

    confirmar = bool(job["confirmar_final"]) and not sem_finalizar
    resultado: Dict[str, Any] = {
        "acao": fin.ACAO_FINALIZAR, "iniciado_em": fin.agora_iso(), "terminado_em": None, "em_andamento": True,
        "confirmar_final": confirmar, "cancelado": False, "resultados": [], "pulados": list(job["pulados"]), "sharepoint": None,
        "planilha": "",
    }
    salvar = lambda: fin.gravar_resultado(state_dir, resultado)  # noqa: E731
    salvar()
    if not confirmar:
        log("Modo sem finalizar: o formulário é preenchido e conferido, mas Finalizar NÃO é clicado e nada vai ao Dashboard.")
    abas: List[Any] = []  # a aba do SoftExpert; fica aqui para fechar também quando a rotina é cancelada
    encerramentos: Dict[str, str] = {}
    try:
        try:
            _processar(context, rotinas, modulo, state_dir, job["numeros"], confirmar, resultado, encerramentos, salvar, agora, abas)
        except rotinas.RotinaCancelada:
            resultado["cancelado"] = True
            raise
        if encerramentos:
            saida, estados, erro_r = _gravar_encerramentos(state_dir, encerramentos)
            for item in resultado["resultados"]:
                if item["numero"] in estados:
                    item["planilha"] = estados[item["numero"]]
            resultado["planilha"] = erro_r
            if erro_r:
                log(erro_r)
            if saida is None:
                resultado["sharepoint"] = fin.aviso_sharepoint(False, erro_r or "Nada novo para enviar ao SharePoint.")
            else:
                salvar()
                resultado["sharepoint"] = _enviar_ao_sharepoint(context, rotinas, state_dir, saida, list(encerramentos), log, agora)
        falhas = any(r["status"] == fin.STATUS_ERRO for r in resultado["resultados"]) or bool((resultado["sharepoint"] or {}).get("falhou"))
        return 1 if falhas else 0
    finally:
        resultado["em_andamento"] = False
        resultado["terminado_em"] = fin.agora_iso()
        salvar()
        for aba in abas:
            _fechar_aba(aba)


def _processar(
    context: "BrowserContext", rotinas: Any, modulo: Any, state_dir: Path, numeros: List[str], confirmar: bool,
    resultado: Dict[str, Any], encerramentos: Dict[str, str], salvar: Callable[[], None], agora: Callable[[], datetime],
    abas: List[Any],
) -> None:
    """Um chamado por vez; a falha de um nunca interrompe os outros. A aba aberta entra em ``abas``."""
    log = lambda texto: rotinas.log(ORIGEM, texto)  # noqa: E731
    pagina: Optional["Page"] = None
    parada = ""  # preenchido quando o SoftExpert fica indisponível: os que faltam viram erro com esse motivo

    def anotar(numero: str, status: str, **extras: Any) -> Dict[str, Any]:
        item = {"numero": numero, "status": status, "em": fin.agora_iso(), "mensagem": "", "motivo": "", "captura": "",
                "encerrado_em": "", "planilha": "", **extras}
        resultado["resultados"].append(item)
        salvar()
        return item

    vistos: set[str] = set()
    for bruto in numeros:
        rotinas.verificar_cancelamento("Cancelado antes de finalizar o próximo chamado.")
        try:
            numero = fin.validar_numero(bruto)
        except Exception:  # noqa: BLE001 - DomainValidationError: número fora do formato
            anotar(str(bruto)[:40], fin.STATUS_ERRO, mensagem="Número de chamado inválido; nada foi aberto.")
            continue
        if numero in vistos:
            continue
        vistos.add(numero)
        descricao, pdf = fin.dados_para_finalizar(state_dir, numero)
        if not descricao:
            log(f"{numero}: sem descrição para finalizar; pulado.")
            anotar(numero, fin.STATUS_SEM_DESCRICAO, mensagem="Preencha a descrição para finalizar o chamado.")
            continue
        if parada:
            anotar(numero, fin.STATUS_ERRO, mensagem=parada, motivo="softexpert_indisponivel")
            continue
        try:
            if pagina is None:
                pagina = modulo.abrir_softexpert(context)
                abas.append(pagina)
            detalhes = modulo.finalizar_chamado(pagina, numero, descricao, pdf=pdf, confirmar_final=confirmar)
        except modulo.SessaoExpirada:
            parada = MOTIVO_SESSAO
            log(f"{numero}: {parada}")
            rotinas.registrar_erro(pagina, ORIGEM)
            anotar(numero, fin.STATUS_ERRO, mensagem=parada, motivo="sessao_expirada")
            continue
        except Exception as erro:  # noqa: BLE001 - validação antes de navegar, login que não concluiu, aba que caiu
            mensagem = rotinas.descrever_erro(erro)
            log(f"{numero}: erro ({mensagem}).")
            rotinas.registrar_erro(pagina, ORIGEM)
            anotar(numero, fin.STATUS_ERRO, mensagem=mensagem, motivo=str(getattr(erro, "motivo", "") or ""))
            if pagina is None:
                parada = mensagem  # nem a central de tarefas abriu: tentar o próximo chamado repetiria o mesmo erro
            continue
        status = str(detalhes.get("status") or fin.STATUS_ERRO)
        info = detalhes.get("detalhes") if isinstance(detalhes.get("detalhes"), dict) else {}
        extras = {
            "mensagem": str(info.get("mensagem") or ""), "motivo": str(info.get("motivo") or ""),
            "captura": str(info.get("captura") or ""), "escritas": [str(e) for e in info.get("escritas") or []],
        }
        if status == fin.STATUS_OK:
            quando = fin.texto_do_encerramento(agora())
            fin.registrar_finalizacao(state_dir, numero, fin.STATUS_OK, quando)
            encerramentos[numero] = quando
            anotar(numero, status, encerrado_em=quando, **extras)
            log(f"{numero}: finalizado no SoftExpert.")
        elif status == fin.STATUS_NAO_ENCONTRADO:
            # Não registra: fora da central não prova que está finalizado, e o usuário pode tentar de novo. Sem R.
            anotar(numero, status, **extras)
            log(f"{numero}: não está na central de tarefas; nada foi feito e a coluna R não é alterada.")
        elif status == fin.STATUS_PRONTO:
            anotar(numero, status, **extras)
            log(f"{numero}: formulário pronto; Finalizar não foi clicado.")
        else:
            rotinas.registrar_erro(pagina, ORIGEM)
            anotar(numero, fin.STATUS_ERRO, **extras)
            log(f"{numero}: erro ao finalizar ({extras['mensagem']}).")
