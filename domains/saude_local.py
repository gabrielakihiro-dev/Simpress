"""Saúde local: space used, state JSON health, pending transactions and temporary-file cleanup.

Read-only except ``executar_limpeza(aplicar=True)``, which reuses ``core/limpeza_temporarios.py``
without ever recovering a transaction. Nothing here returns or logs a path, a file content or
``str(error)``: only fixed names, enums and numbers (the cleanup items carry paths relative
to the area, with CPFs masked). Contract: ``docs/arquitetura/CONTRATOS_API_BACKEND.md``.
"""

from __future__ import annotations

import json
import os
import platform
import re
import shutil
import stat
import threading
from datetime import datetime, timezone
from pathlib import Path, PureWindowsPath
from typing import Any, Callable, Dict, Iterator, List, Literal, Optional, Sequence, Tuple, get_args

from core.limpeza_temporarios import QUARANTINE_DIRECTORY, CleanupBlockedError, cleanup_local_temps, inside_root
from core.local_paths import is_link_or_junction
from domains.assistant_lgpd import mascarar_cpfs

# State files of data/state (relative path, "/" for subfolders), named in core/config.py and domains/;
# only the existing ones are listed.
NomeJson = Literal[
    "assistente_busca_web.json", "assistente_conversas.json", "assistente_instrucoes.json", "assistente_notas.json",
    "backups_regionais.json", "dashboard_agendamento.json", "historico_alteracoes.json", "historico_chamados.json",
    "historico_transferencias.json", "inventory_update_idempotency.json", "lembretes.json", "nomes_pessoas_manuais.json",
    "operacao_cobertura.json", "operacao_cobertura_arquivados.json", "os_chamados_vinculos.json",
    "os_marcas_finalizacao.json", "os_observacoes.json", "outlook_email_modelos.json", "outlook_modelo_cabo_padrao.json",
    "powershell_codigos.json", "representantes_regionais_padrao.json", "sebrae_agendamento.json",
    "sebrae_antigos_resultado.json", "sebrae_antigos_softexpert.json", "sebrae_categoria_indice.json",
    "sebrae_chamados_encerrados.json", "sebrae_chamados_estado.json", "sebrae_config.json", "sebrae_credenciais.json",
    "sebrae_dashboard_conflitos.json", "sebrae_dashboard_enviado.json", "sebrae_dashboard_envio.json",
    "sebrae_dashboard_existentes.json", "sebrae_fechar_job.json", "sebrae_fechar_resultado.json",
    "sebrae_finalizacao.json", "sebrae_historico.json", "sebrae_novos.json", "sebrae_observacoes.json",
    "sebrae_os_recusadas.json", "unidades_custom.json", "usuarios_entra_pr.json", "ux_chamados_historico.json",
    "ux_solicitante.json", "ux_tickets_historico.json",
    "apelidos_modificados/apelidos_modificados.json", "historico_comparacoes/historico_comparacoes.json",
    "hostnames_removidos/hostnames_removidos.json", "usuarios_manuais/usuarios_manuais.json",
    "usuarios_manuais/usuarios_manuais_datas.json", "usuarios_manuais/usuarios_pendencias.json",
]
NOMES_JSON: Tuple[str, ...] = get_args(NomeJson)
ChaveArea = Literal["backups_planilhas", "logs", "lotes_processados", "pacotes_locais", "quarentena"]
AREAS: Tuple[str, ...] = get_args(ChaveArea)
SituacaoJson = Literal["integro", "invalido", "vazio", "ilegivel", "grande_demais"]
ErroJson = Literal[
    "JSONDecodeError", "UnicodeDecodeError", "ValueError", "RecursionError",
    "PermissionError", "FileNotFoundError", "IsADirectoryError", "OSError",
]
_ERROS_JSON: Tuple[str, ...] = get_args(ErroJson)
EstadoProntidao = Literal["ready", "awaiting_import", "invalid", "unavailable"]
_ESTADOS_PRONTIDAO: Tuple[str, ...] = get_args(EstadoProntidao)
CodigoRecusa = Literal["chrome", "importacao", "transacoes", "migracao", "limpeza_em_andamento"]

MAX_JSON_BYTES = 16 * 1024 * 1024
_CHAVE_PRONTIDAO = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_VERSAO = re.compile(r"^[0-9A-Za-z.+-]{1,32}$")
_TEXTO_SISTEMA = re.compile(r"^[0-9A-Za-z._+ -]{0,64}$")

MENSAGENS_RECUSA: Dict[str, str] = {
    "chrome": "Limpeza recusada: uma automação está usando o Chrome.",
    "importacao": "Limpeza recusada: há uma importação em andamento.",
    "transacoes": "Limpeza recusada: há transações pendentes.",
    "migracao": "Limpeza recusada: há uma migração de dados em andamento.",
    "limpeza_em_andamento": "Limpeza recusada: outra limpeza já está em andamento.",
}

# One cleanup (prévia or aplicação) at a time; a second one is refused, never queued.
LOCK_LIMPEZA = threading.Lock()


class RecusaLimpeza(Exception):
    def __init__(self, codigo: str) -> None:
        super().__init__(codigo)
        self.codigo = codigo
        self.mensagem = MENSAGENS_RECUSA[codigo]


def _agora() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _arquivos(pasta: Path) -> Iterator[Tuple[Path, int, bool]]:
    """(path, size, inside a quarantine folder) of every regular file; never follows links or junctions."""
    if not pasta.is_dir() or is_link_or_junction(pasta):
        return
    try:
        raiz = pasta.resolve()
    except OSError:
        return
    pilha: List[Tuple[Path, bool]] = [(pasta, False)]
    while pilha:
        atual, em_quarentena = pilha.pop()
        try:
            with os.scandir(atual) as iterador:
                entradas = list(iterador)
        except OSError:  # PermissionError on a subfolder: skip it
            continue
        for entrada in entradas:
            caminho = Path(entrada.path)
            try:
                if is_link_or_junction(caminho) or not caminho.resolve().is_relative_to(raiz):
                    continue
                if entrada.is_dir(follow_symlinks=False):
                    pilha.append((caminho, em_quarentena or entrada.name == QUARANTINE_DIRECTORY))
                elif entrada.is_file(follow_symlinks=False):
                    yield caminho, entrada.stat(follow_symlinks=False).st_size, em_quarentena
            except OSError:
                continue


def _area(chave: str, pastas: Sequence[Path]) -> Dict[str, Any]:
    arquivos = tamanho = 0
    for pasta in pastas:
        for _caminho, bytes_arquivo, _q in _arquivos(pasta):
            arquivos += 1
            tamanho += bytes_arquivo
    return {"chave": chave, "arquivos": arquivos, "bytes": tamanho, "existe": any(p.is_dir() for p in pastas)}


def _pasta_pacotes(base: Path) -> Optional[Path]:
    """Folder from config/pacote_local.json ("pasta"); missing, empty or unreadable -> data/pacotes_locais; network -> None."""
    try:
        dado = json.loads((base / "config" / "pacote_local.json").read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        dado = {}
    texto = dado.get("pasta") if isinstance(dado, dict) else None
    if not isinstance(texto, str) or not texto.strip():
        return base / "data" / "pacotes_locais"
    texto = texto.strip()
    # Any mix of "/" and "\" that starts a UNC path (\\server, //server, /\server, \/server) is a network folder.
    normalizado = texto.replace("/", "\\")
    if normalizado.startswith("\\\\") or PureWindowsPath(normalizado).drive.startswith("\\\\"):
        return None
    pasta = Path(texto).expanduser()
    return pasta if pasta.is_absolute() else base / pasta


def _quarentena(base: Path) -> Dict[str, Any]:
    """`.temp-quarantine` folders plus `*.corrompido-*` copies under data/, modelos/ and config/, each file once."""
    vistos: Dict[Path, int] = {}
    for raiz, aceita_quarentena in ((base / "data", True), (base / "modelos", True), (base / "config", False)):
        for caminho, tamanho, em_quarentena in _arquivos(raiz):
            if (aceita_quarentena and em_quarentena) or ".corrompido-" in caminho.name:
                vistos[caminho] = tamanho
    return {"chave": "quarentena", "arquivos": len(vistos), "bytes": sum(vistos.values()),
            "existe": bool(vistos)}


def medir_areas(base: Path, entradas: Sequence[Path]) -> List[Dict[str, Any]]:
    pacotes = _pasta_pacotes(base)
    lotes = [Path(entrada) / nome for entrada in entradas for nome in ("processadas", "falhas")]
    return [
        _area("backups_planilhas", [base / "data" / "planilhas_entrada" / "_backups"]),
        _area("logs", [base / "data" / "logs"]),
        _area("lotes_processados", lotes),
        _area("pacotes_locais", [pacotes] if pacotes is not None else []),
        _quarentena(base),
    ]


def _disco(base: Path) -> Optional[Dict[str, int]]:
    try:
        uso = shutil.disk_usage(base / "data")
    except OSError:
        return None
    return {"livre_bytes": int(uso.free), "total_bytes": int(uso.total)}


def _nome_erro(erro: BaseException) -> str:
    nome = type(erro).__name__
    if nome in _ERROS_JSON:
        return nome
    return "OSError" if isinstance(erro, OSError) else "ValueError"


def _situacao_json(caminho: Path, tamanho: int) -> Tuple[str, Optional[str]]:
    if tamanho > MAX_JSON_BYTES:
        return "grande_demais", None
    try:
        bruto = caminho.read_bytes()
    except OSError as erro:
        return "ilegivel", _nome_erro(erro)
    if not bruto.strip():
        return "vazio", None
    try:
        json.loads(bruto.decode("utf-8-sig"))
    except (ValueError, RecursionError) as erro:
        return "invalido", _nome_erro(erro)
    return "integro", None


def estado_json(base: Path) -> Dict[str, Any]:
    """Opens only the fixed names; other `*.json` at the top of data/state are just counted."""
    pasta = base / "data" / "state"
    arquivos: List[Dict[str, Any]] = []
    outros = copias = 0
    if pasta.is_dir() and not is_link_or_junction(pasta):
        try:
            with os.scandir(pasta) as iterador:
                entradas = {e.name: e for e in iterador}
        except OSError:
            entradas = {}
        for nome in NOMES_JSON:
            caminho = pasta / nome
            try:
                info = caminho.lstat()
                # Regular file only (lstat: a link is not), in a real subfolder inside data/state.
                if (not stat.S_ISREG(info.st_mode) or is_link_or_junction(caminho.parent)
                        or not inside_root(caminho, pasta)):
                    continue
            except OSError:
                continue
            situacao, erro = _situacao_json(caminho, info.st_size)
            arquivos.append({"nome": nome, "bytes": info.st_size, "situacao": situacao, "erro": erro})
        for nome in entradas:
            if not nome.endswith(".json") or nome in NOMES_JSON:
                continue
            if ".corrompido-" in nome:
                copias += 1
            else:
                outros += 1
    return {"arquivos": arquivos, "outros": outros, "copias_corrompidas": copias}


def transacoes(base: Path) -> Dict[str, Any]:
    """Counts entries in .transactions; never recovers nor opens them.

    Unlistable folder (PermissionError, other OSError): "pendente" with 0, because the count is unknown and
    saying "limpo" could hide an interrupted write; the contract enums stay unchanged and the GET still answers.
    """
    pasta = base / ".transactions"
    try:
        quantidade = sum(1 for _ in pasta.iterdir()) if pasta.is_dir() else 0
    except FileNotFoundError:
        quantidade = 0
    except OSError:
        return {"situacao": "pendente", "quantidade": 0}
    return {"situacao": "pendente" if quantidade else "limpo", "quantidade": quantidade}


def saude_local(base: Path, entradas: Sequence[Path]) -> Dict[str, Any]:
    """GET /api/saude-local: never writes anything."""
    return {
        "gerado_em": _agora(),
        "disco": _disco(base),
        "areas": medir_areas(base, entradas),
        "estado_json": estado_json(base),
        "transacoes": transacoes(base),
    }


def _importacao_em_andamento(entradas: Sequence[Path]) -> bool:
    for entrada in entradas:
        processando = Path(entrada) / "processando"
        try:
            if processando.is_dir() and any(processando.iterdir()):
                return True
        except FileNotFoundError:
            continue
    return False


def executar_limpeza(
    base: Path, entradas: Sequence[Path], chrome_ocupado: Callable[[], bool], *, aplicar: bool,
) -> Dict[str, Any]:
    """Prévia (aplicar=False) or aplicação; raises RecusaLimpeza with a contract code before touching anything."""
    if not LOCK_LIMPEZA.acquire(blocking=False):
        raise RecusaLimpeza("limpeza_em_andamento")
    try:
        if chrome_ocupado():
            raise RecusaLimpeza("chrome")
        if _importacao_em_andamento(entradas):
            raise RecusaLimpeza("importacao")
        itens: List[Dict[str, Any]] = []
        try:
            resultado = cleanup_local_temps(base, dry_run=not aplicar, itens=itens, recuperar_transacoes=False)
        except CleanupBlockedError as erro:
            if erro.codigo in ("transacoes", "migracao"):
                raise RecusaLimpeza(erro.codigo) from None
            raise
    finally:
        LOCK_LIMPEZA.release()
    for item in itens:
        item["caminho"] = mascarar_cpfs(item["caminho"])
    remover = [item for item in itens if item["acao"] == "remover"]
    quarentena = [item for item in itens if item["acao"] == "quarentena"]
    return {
        "aplicada": aplicar,
        "itens": itens,
        "totais": {
            "remover_arquivos": len(remover),
            "remover_bytes": sum(item["bytes"] for item in remover),
            "quarentena_arquivos": len(quarentena),
            "quarentena_bytes": sum(item["bytes"] for item in quarentena),
            "preservados": sum(resultado[chave] for chave in (
                "recentes_preservados", "diferentes_preservados", "sem_destino_preservados",
                "formato_desconhecido_preservado", "bloqueados_preservados",
            )),
        },
    }


def _prontidao_segura(relatorio: Dict[str, Any]) -> Dict[str, Any]:
    """Allowlist: only the state per key; never reason, file, missing_files nor configuracao_local."""
    def estado(valor: Any) -> str:
        return valor if valor in _ESTADOS_PRONTIDAO else "invalid"

    arquivos = relatorio.get("files")
    funcoes = relatorio.get("functions")
    arquivos = arquivos if isinstance(arquivos, dict) else {}
    funcoes = funcoes if isinstance(funcoes, dict) else {}
    return {
        "arquivos": {
            chave: estado(valor.get("state"))
            for chave, valor in arquivos.items()
            if isinstance(chave, str) and _CHAVE_PRONTIDAO.fullmatch(chave) and isinstance(valor, dict)
        },
        "funcoes": {
            chave: {"available": valor.get("available") is True, "state": estado(valor.get("state"))}
            for chave, valor in funcoes.items()
            if isinstance(chave, str) and _CHAVE_PRONTIDAO.fullmatch(chave) and isinstance(valor, dict)
        },
    }


def pacote_diagnostico(
    base: Path, entradas: Sequence[Path], prontidao: Dict[str, Any], versao_app: str,
) -> Dict[str, Any]:
    """Built in memory from an allowlist; nothing is written."""
    sistema = platform.system()
    versao_sistema = platform.release()
    return {
        "formato": 1,
        "gerado_em": _agora(),
        "app": {
            "versao": versao_app if _VERSAO.fullmatch(versao_app or "") else "desconhecida",
            "python": platform.python_version(),
            "sistema": sistema if _TEXTO_SISTEMA.fullmatch(sistema) else "",
            "versao_sistema": versao_sistema if _TEXTO_SISTEMA.fullmatch(versao_sistema) else "",
        },
        "prontidao": _prontidao_segura(prontidao if isinstance(prontidao, dict) else {}),
        "areas": medir_areas(base, entradas),
        "disco": _disco(base),
        "estado_json": estado_json(base),
        "transacoes": transacoes(base),
    }
