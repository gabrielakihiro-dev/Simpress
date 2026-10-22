"""Liga a leitura do SoftExpert (Fase B) e o Excel Online (Fase C) à orquestração (Fase E).

``rodar_rotina_sebrae`` (scripts/automacao_rotinas_chrome.py) chama ``executar``. Aqui ficam só os adaptadores
entre os módulos do navegador e os ``Protocol``s de ``domains/sebrae_orquestracao.py``: traduzem exceções
(sessão expirada, cancelamento, chamado indisponível) e resultados de gravação, e abrem as abas. As regras
de decisão, estado e aviso estão em ``domains``; a segurança da gravação (linha livre, releitura das sete
colunas, "Salvo", diário) está em ``scripts/sebrae_excel.py``. Ver docs/operacao/sincronizar-chamados-sebrae.md.

As utilidades do runner (log, cancelamento, abas, login, aviso) entram por ``rotinas`` (o módulo do runner em
uso), para não existir uma segunda cópia dele quando roda como ``__main__``.
"""

from __future__ import annotations

import json
import re
import sys
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Iterable, Iterator, Mapping, Optional, Tuple
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from domains import sebrae_orquestracao as orq  # noqa: E402
from domains.sebrae_agendamento import caminhos_padrao  # noqa: E402
from domains.sebrae_chamados import COLUNAS_GRAVADAS, ChamadoSoftExpert  # noqa: E402
from scripts import sebrae_excel, sebrae_softexpert  # noqa: E402

if TYPE_CHECKING:
    from playwright.sync_api import BrowserContext, Page

STATE_DIR = ROOT / "data" / "state"
CONFIG_ARQUIVO = STATE_DIR / "sebrae_config.json"
SISTEMA_SOFTEXPERT = "SoftExpert"
SISTEMA_DASHBOARD = "SharePoint"
ORIGEM_EXCEL = "Excel Online"
MARCA_LOGIN_NAO_CONCLUIDO = "Login não concluído"


class ConfiguracaoSebraeErro(Exception):
    """``data/state/sebrae_config.json`` ausente ou incompleto; nada foi aberto nem lido."""


class RecuperacaoInterrompidaErro(Exception):
    """O diário do Excel tinha uma gravação a concluir e a retomada não pôde terminar."""


@dataclass(frozen=True)
class Configuracao:
    dashboard_url: str
    colunas_formula: Tuple[str, ...]
    quebras_como_espaco: bool = False
    modo_sombra: bool = False  # o modelo local só sugere o tipo; ver scripts/sebrae_sombra.py


_COLUNA = re.compile(r"^[A-Z]{1,3}$")


def carregar_configuracao(caminho: Path = CONFIG_ARQUIVO) -> Configuracao:
    """URL do Dashboard e colunas com fórmula, definidas na sessão assistida (V5); fora do Git, sem segredos.

    ``colunas_formula`` é obrigatório: ``[]`` (explícito) desliga a conferência de fórmulas da linha preparada.
    """
    try:
        dados = json.loads(caminho.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ConfiguracaoSebraeErro(
            f"Falta {caminho.name}: informe o endereço do Dashboard e as colunas com fórmula (docs/operacao/sebrae-fase-e-execucao.md)."
        ) from None
    except (OSError, UnicodeError, ValueError):
        raise ConfiguracaoSebraeErro(f"{caminho.name} não pôde ser lido como JSON.") from None
    if not isinstance(dados, dict):
        raise ConfiguracaoSebraeErro(f"{caminho.name} deve ser um objeto JSON.")
    url = str(dados.get("dashboard_url") or "").strip()
    analisada = urlparse(url)
    if analisada.scheme != "https" or not analisada.netloc or analisada.username or analisada.password:
        raise ConfiguracaoSebraeErro("dashboard_url deve ser um endereço https do Dashboard, sem usuário nem senha.")
    if sebrae_excel.url_de_login(url):
        raise ConfiguracaoSebraeErro("dashboard_url aponta para uma tela de login; use o endereço do arquivo.")
    colunas = dados.get("colunas_formula")
    if not isinstance(colunas, list) or not all(isinstance(c, str) and _COLUNA.match(c) for c in colunas):
        raise ConfiguracaoSebraeErro("colunas_formula deve ser uma lista de letras de coluna (use [] para nenhuma).")
    return Configuracao(
        url, tuple(colunas), bool(dados.get("quebras_como_espaco", False)), dados.get("modo_sombra") is True
    )


@contextmanager
def _traduzindo(rotinas: Any, sistema: str) -> Iterator[None]:
    """Cancelamento do runner vira ``CancelamentoSolicitado``; espera de login esgotada vira login necessário."""
    try:
        yield
    except rotinas.RotinaCancelada:
        raise orq.CancelamentoSolicitado() from None
    except rotinas.RotinaErro as erro:
        if str(erro).startswith(MARCA_LOGIN_NAO_CONCLUIDO):
            raise orq.LoginNecessarioErro(sistema) from None
        raise


# ---------------------------------------------------------------------------- SoftExpert

class LeitorSoftExpertReal:
    """``LeitorSoftExpert`` sobre ``scripts/sebrae_softexpert.py``; a aba abre na primeira leitura."""

    def __init__(
        self,
        context: "BrowserContext",
        rotinas: Any,
        *,
        modulo: Any = sebrae_softexpert,
        log: Callable[[str], None] = lambda texto: None,
    ) -> None:
        self.context = context
        self.rotinas = rotinas
        self.modulo = modulo
        self.log = log
        self.pagina: Optional["Page"] = None

    def _aba(self) -> "Page":
        if self.pagina is None:
            self.pagina = self.modulo.abrir_softexpert(self.context)
        return self.pagina

    def listar_numeros(self) -> Iterable[str]:
        with _traduzindo(self.rotinas, SISTEMA_SOFTEXPERT):
            try:
                return list(self.modulo.coletar_numeros(self._aba()))
            except self.modulo.SessaoExpirada:
                raise orq.LoginNecessarioErro(SISTEMA_SOFTEXPERT) from None

    def ler_chamado(self, numero: str) -> ChamadoSoftExpert:
        with _traduzindo(self.rotinas, SISTEMA_SOFTEXPERT):
            pagina = self._aba()
            try:
                return self._extrair(pagina, numero)
            except self.modulo.SessaoExpirada:
                # Same as extrair_chamados: wait for a new login once, then read the ticket again.
                self.log(f"{numero}: sessão expirada; aguardando novo login.")
                pagina.goto(self.modulo.SOFTEXPERT_URL, wait_until="domcontentloaded", timeout=self.rotinas.CARREGAMENTO_MS)
                self.modulo.garantir_login(pagina, permitir_sso=True)
                try:
                    return self._extrair(pagina, numero)
                except self.modulo.SessaoExpirada:
                    raise orq.LoginNecessarioErro(SISTEMA_SOFTEXPERT) from None

    def _extrair(self, pagina: "Page", numero: str) -> ChamadoSoftExpert:
        try:
            chamado: ChamadoSoftExpert = self.modulo.extrair_chamado(self.context, pagina, numero)
            return chamado
        except (self.modulo.ChamadoNaoConfere, self.modulo.ChamadoNaoEncontrado) as erro:
            raise orq.ChamadoIndisponivelErro(erro.motivo) from None

    def fechar(self) -> None:
        if self.pagina is not None:
            _fechar_aba(self.pagina)


# ---------------------------------------------------------------------------- Dashboard

class DashboardReal:
    """``DashboardSebrae`` sobre ``AdaptadorExcel``; abre o Dashboard e conclui o diário na primeira leitura."""

    def __init__(
        self,
        context: Optional["BrowserContext"],
        rotinas: Any,
        configuracao: Configuracao,
        *,
        adaptador: Optional[sebrae_excel.AdaptadorExcel] = None,
        log: Callable[[str], None] = lambda texto: None,
    ) -> None:
        self.context = context
        self.rotinas = rotinas
        self.configuracao = configuracao
        self.log = log
        self.adaptador = adaptador
        self.pagina: Optional["Page"] = None
        self._recuperado = False

    def _excel(self) -> sebrae_excel.AdaptadorExcel:
        if self.adaptador is None:
            assert self.context is not None
            pagina = self.rotinas.nova_aba(self.context, self.configuracao.dashboard_url, ORIGEM_EXCEL)
            self.pagina = pagina
            self.rotinas.aguardar_login(pagina, ORIGEM_EXCEL, self._logado)
            self.adaptador = sebrae_excel.ExcelOnlinePlaywright(
                pagina,
                colunas_formula=self.configuracao.colunas_formula,
                quebras_como_espaco=self.configuracao.quebras_como_espaco,
                log=lambda texto: self.rotinas.log(ORIGEM_EXCEL, texto),
            )
        return self.adaptador

    @staticmethod
    def _logado(pagina: "Page") -> bool:
        return not sebrae_excel.url_de_login(pagina.url) and "operacional_sebrae" in pagina.title().lower()

    def _preparar(self) -> sebrae_excel.AdaptadorExcel:
        """Opens the Dashboard and finishes any write left half-done by an earlier run, before anything is read."""
        excel = self._excel()
        if not self._recuperado:
            self._recuperado = True
            for resultado in excel.recuperar_pendencias():
                self.log(f"{resultado.numero}: retomada do diário ({resultado.situacao}).")
                if resultado.login_necessario:
                    raise orq.LoginNecessarioErro(SISTEMA_DASHBOARD)
                if resultado.interrompe_execucao:
                    raise RecuperacaoInterrompidaErro(resultado.situacao)
        return excel

    def ler_coluna_c(self) -> Iterable[Any]:
        with _traduzindo(self.rotinas, SISTEMA_DASHBOARD):
            try:
                # Validated read: it refuses a column C that lost rows (filters), so a duplicate is never risked.
                leitura = self._preparar()._ler_validada()
            except sebrae_excel.SessaoExpiradaErro:
                raise orq.LoginNecessarioErro(SISTEMA_DASHBOARD) from None
            return list(leitura.valores.values())

    def gravar_linha(self, linha: Mapping[str, str]) -> orq.ResultadoGravacao:
        with _traduzindo(self.rotinas, SISTEMA_DASHBOARD):
            resultado = self._preparar().gravar_chamado(linha)
        return traduzir_gravacao(resultado)

    def fechar(self) -> None:
        if self.pagina is not None:
            _fechar_aba(self.pagina)


def traduzir_gravacao(resultado: sebrae_excel.ResultadoGravacao) -> orq.ResultadoGravacao:
    """Result of the Excel layer in the vocabulary of the orchestration."""
    numero = resultado.numero
    if resultado.login_necessario:
        raise orq.LoginNecessarioErro(SISTEMA_DASHBOARD)
    if resultado.incluido:
        return orq.ResultadoGravacao(numero, tuple(COLUNAS_GRAVADAS), True)
    if resultado.situacao == sebrae_excel.DUPLICADO:
        return orq.ResultadoGravacao(numero, (), False, duplicado=True)
    if resultado.situacao in (sebrae_excel.INVALIDO, sebrae_excel.ABANDONADO):
        return orq.ResultadoGravacao(numero, (), False, motivo_pendente=f"gravacao_{resultado.situacao}")
    # parcial, divergente, nao_salvo, leitura_incompleta, filtro_nao_restaurado, sem_linha_preparada, interrompido
    return orq.ResultadoGravacao(numero, tuple(resultado.confirmados), False, erro=resultado.situacao)


def _fechar_aba(pagina: "Page") -> None:
    try:
        if not pagina.is_closed():
            pagina.close()
    except Exception:  # closing a tab is housekeeping; it must not hide the result of the run
        pass


# ---------------------------------------------------------------------------- entry point

def executar(
    context: "BrowserContext",
    rotinas: Any,
    *,
    caminho_estado: Optional[Path] = None,
    caminho_config: Path = CONFIG_ARQUIVO,
    softexpert: Optional[orq.LeitorSoftExpert] = None,
    dashboard: Optional[orq.DashboardSebrae] = None,
) -> int:
    """Roda uma sincronização. ``rotinas``: módulo do runner (log, cancelamento, abas, login, aviso)."""
    inicio = rotinas.agora_iso()
    print(f"\n=== SINCRONIZAR CHAMADOS SEBRAE (início {inicio}) ===", flush=True)
    try:
        configuracao = carregar_configuracao(caminho_config)
    except ConfiguracaoSebraeErro as erro:
        rotinas.avisar("Simpress: chamados Sebrae", str(erro))
        raise rotinas.RotinaErro(str(erro)) from None

    def log(texto: str) -> None:
        rotinas.log("Sebrae", texto)

    softexpert = softexpert or LeitorSoftExpertReal(context, rotinas, log=log)
    dashboard = dashboard or DashboardReal(context, rotinas, configuracao, log=log)
    observar = None
    if configuracao.modo_sombra:
        from scripts import sebrae_sombra

        observar = sebrae_sombra.criar_observador()
        log("Modo sombra ligado: sugestões do modelo local vão só para o caderno local.")
    resultado: Optional[orq.ResultadoOrquestracao] = None
    try:
        resultado = orq.sincronizar(
            softexpert,
            dashboard,
            caminho_estado or caminhos_padrao(STATE_DIR).estado_chamados,
            cancelado=rotinas.cancelamento_pedido,
            log=log,
            observar=observar,
        )
    finally:
        if resultado is None or resultado.situacao != orq.SITUACAO_LOGIN:
            # The tabs stay open only when the user has to sign in; otherwise a run every 30 minutes piles them up.
            for aba in (softexpert, dashboard):
                fechar = getattr(aba, "fechar", None)
                if callable(fechar):
                    fechar()
    if resultado.aviso is not None:
        rotinas.avisar(*resultado.aviso)
    resumo = resultado.resumo
    log(
        f"Situação: {resultado.situacao}. Incluídos: {resumo.incluidos}; ignorados: {resumo.ignorados}; "
        f"pendentes: {resumo.pendentes}."
    )
    if resultado.situacao == orq.SITUACAO_CANCELADA:
        raise rotinas.RotinaCancelada("Os chamados já incluídos foram mantidos.")
    print(
        "\n[SUCESSO] Sincronização de chamados Sebrae concluída."
        if resultado.codigo_saida == 0
        else "\n[FALHA] Sincronização de chamados Sebrae não foi concluída.",
        flush=True,
    )
    return resultado.codigo_saida
