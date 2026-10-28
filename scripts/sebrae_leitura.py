"""Rotina ``sebrae``: lê no SoftExpert os chamados que o Dashboard importado ainda não tem.

Só leitura, com uma exceção: a confirmação de associar o chamado ao usuário (botão Sim) que o SoftExpert
pede ao abrir o formulário é aceita por ``sebrae_softexpert.extrair_chamado``. Entrada: ``data/state/sebrae_dashboard_existentes.json`` (coluna C do Dashboard importado no site).
Saída: ``data/state/sebrae_novos.json`` (CPF e senhas já mascarados), que a tela do site mostra como formulário.
Nada mais é gravado no SoftExpert nem no Excel; o chamado de cada leitura é fechado sem salvar. Ver
docs/operacao/sincronizar-chamados-sebrae.md ("Tela no site").

As utilidades do runner (log, cancelamento, abas, login) entram por ``rotinas``, o módulo do runner em uso,
para não existir uma segunda cópia dele quando roda como ``__main__``.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, List, Optional

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from domains import sebrae_novos  # noqa: E402
from domains.sebrae_chamados import ChamadoSoftExpert  # noqa: E402
from domains.sebrae_dashboard import triar_novos  # noqa: E402
from scripts import sebrae_softexpert  # noqa: E402

if TYPE_CHECKING:
    from playwright.sync_api import BrowserContext, Page

STATE_DIR = ROOT / "data" / "state"
MARCA_LOGIN_NAO_CONCLUIDO = "Login não concluído"
TENTATIVAS_POR_CHAMADO = 2  # the PHP window sometimes takes longer than the wait; one more try is enough


def _fechar_aba(pagina: Optional["Page"]) -> None:
    try:
        if pagina is not None and not pagina.is_closed():
            pagina.close()
    except Exception:  # closing a tab is housekeeping; it must not hide the result of the run
        pass


def _ler_chamado(
    context: "BrowserContext", pagina: "Page", numero: str, rotinas: Any, modulo: Any
) -> "ChamadoSoftExpert | str":
    """The ticket, or the reason it could not be read (never page content)."""
    motivo = ""
    for tentativa in range(1, TENTATIVAS_POR_CHAMADO + 1):
        try:
            try:
                return modulo.extrair_chamado(context, pagina, numero)
            except modulo.SessaoExpirada:
                rotinas.log("Sebrae", f"{numero}: sessão expirada; aguardando novo login.")
                pagina.goto(modulo.SOFTEXPERT_URL, wait_until="domcontentloaded", timeout=rotinas.CARREGAMENTO_MS)
                modulo.garantir_login(pagina, permitir_sso=True)
                return modulo.extrair_chamado(context, pagina, numero)
        except (modulo.ChamadoNaoConfere, modulo.ChamadoNaoEncontrado) as erro:
            return str(erro)  # a different ticket or a missing one does not change on a retry
        except modulo.SoftExpertErro as erro:
            motivo = str(erro)
            rotinas.log("Sebrae", f"{numero}: tentativa {tentativa} falhou ({type(erro).__name__}).")
    return motivo


def executar(
    context: "BrowserContext",
    rotinas: Any,
    *,
    state_dir: Path = STATE_DIR,
    modulo: Any = sebrae_softexpert,
) -> int:
    caminhos = sebrae_novos.caminhos_padrao(state_dir)
    existentes = sebrae_novos.ler_existentes(caminhos.existentes)
    print(f"\n=== LER CHAMADOS NOVOS DO SOFTEXPERT (início {rotinas.agora_iso()}) ===", flush=True)
    if existentes is None:
        raise rotinas.RotinaErro("Importe o Dashboard no site antes de buscar os chamados novos.")
    log = lambda texto: rotinas.log("Sebrae", texto)  # noqa: E731
    pagina: Optional["Page"] = None
    try:
        try:
            pagina = modulo.abrir_softexpert(context)
            itens = modulo.listar_chamados(pagina)
        except modulo.SessaoExpirada:
            raise rotinas.RotinaErro(f"{MARCA_LOGIN_NAO_CONCLUIDO}: entre no SoftExpert e execute de novo.") from None
        triagem = triar_novos({item.numero: item.texto for item in itens}, existentes["numeros"])
        log(
            f"Lista: {len(itens)} chamado(s); {len(triagem.ignorados)} já no Dashboard, "
            f"{len(triagem.pendentes)} pendente(s), {len(triagem.novos)} novo(s)."
        )
        lidos: List[ChamadoSoftExpert] = []
        erros: Dict[str, str] = {}
        for numero in triagem.novos:
            rotinas.verificar_cancelamento(f"Cancelado antes de ler {numero}.")
            resultado = _ler_chamado(context, pagina, numero, rotinas, modulo)
            if isinstance(resultado, str):
                erros[numero] = resultado
                log(f"{numero}: não lido ({resultado}).")
            else:
                lidos.append(resultado)
                log(f"{numero}: lido.")
            # Saved after each ticket: a cancel or a crash keeps what was already read.
            sebrae_novos.salvar_novos(caminhos.novos, lidos, triagem.pendentes, len(triagem.ignorados), erros)
        sebrae_novos.salvar_novos(caminhos.novos, lidos, triagem.pendentes, len(triagem.ignorados), erros)
    finally:
        _fechar_aba(pagina)
    log(f"Concluído: {len(lidos)} lido(s), {len(erros)} com erro.")
    print(
        "\n[SUCESSO] Chamados novos lidos; abra a tela Automação para preencher e exportar."
        if not erros
        else f"\n[SUCESSO] {len(lidos)} chamado(s) lido(s); {len(erros)} não puderam ser lidos (veja o log).",
        flush=True,
    )
    return 0
