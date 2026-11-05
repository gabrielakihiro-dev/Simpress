"""Harness pós-geração real (Fase 1: dossiê #2/#3 — antes checava uma string fixa, não o
código de fato gerado, e o retorno `valido` nunca era lido).

`ast.parse` no conteúdo real, trava de escopo antes de escrever, pytest num diretório
sandbox isolado e ruff opcional (não bloqueia se estiver indisponível no ambiente).
"""

import ast
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Tuple

from .scope_lock import ForaDoEscopoError, resolver_dentro_do_escopo

TIMEOUT_PADRAO_S = 30.0
SEM_TESTES_COLETADOS = 5
_TEMPO_PYTEST = re.compile(r"\s+in\s+[\d.]+s\s*$")


@dataclass(frozen=True)
class ResultadoHarness:
    ok: bool
    erro: str = ""
    assinatura_erro: str = ""  # usada pelo circuit breaker para detectar erro repetido
    caminho_escrito: Optional[Path] = None


def preparar_sandbox(sandbox_dir: Path) -> Path:
    """Começa a missão (ou cada iteração de correção) com o sandbox limpo.

    Quem valida que `sandbox_dir` não escapou de `motor_ia/` é quem o monta
    (`config.carregar_config`); aqui ele já é confiável, inclusive o `tmp_path` dos testes.
    """
    sandbox_dir = Path(sandbox_dir)
    if sandbox_dir.exists():
        shutil.rmtree(sandbox_dir)
    sandbox_dir.mkdir(parents=True)
    return sandbox_dir


def rodar_harness(sandbox_dir: Path, arquivo_relativo: str, conteudo: str, timeout_s: float = TIMEOUT_PADRAO_S) -> ResultadoHarness:
    try:
        caminho = resolver_dentro_do_escopo(sandbox_dir, arquivo_relativo)
    except ForaDoEscopoError as erro:
        return ResultadoHarness(ok=False, erro=str(erro), assinatura_erro="fora_do_escopo")

    valido, msg_ast = _validar_sintaxe(conteudo)
    if not valido:
        return ResultadoHarness(ok=False, erro=f"Sintaxe inválida: {msg_ast}", assinatura_erro=_assinatura(msg_ast))

    caminho.parent.mkdir(parents=True, exist_ok=True)
    caminho.write_text(conteudo, encoding="utf-8")

    pytest_ok, pytest_saida = _rodar_pytest(sandbox_dir, timeout_s)
    if not pytest_ok:
        return ResultadoHarness(ok=False, erro=pytest_saida, assinatura_erro=_assinatura(pytest_saida), caminho_escrito=caminho)

    _rodar_ruff(sandbox_dir)  # só registrado; nunca bloqueia o harness (ruff pode faltar no ambiente)

    return ResultadoHarness(ok=True, caminho_escrito=caminho)


def _validar_sintaxe(conteudo: str) -> Tuple[bool, str]:
    try:
        ast.parse(conteudo)
        return True, ""
    except SyntaxError as erro:
        return False, str(erro)


def _assinatura(erro: str) -> str:
    """Normaliza o erro para o circuit breaker comparar repetição. A linha `FAILED ...` do
    pytest já identifica teste + tipo + mensagem do erro; sem ela, cai na última linha não
    vazia (ex.: `SyntaxError: ...`)."""
    for linha in erro.splitlines():
        linha = linha.strip()
        if linha.startswith("FAILED ") or linha.startswith("ERROR "):
            return linha
    linhas = [l.strip() for l in erro.splitlines() if l.strip()]
    if not linhas:
        return erro.strip()
    # Fallback (ex.: "1 error in 0.12s"): tira o tempo, que muda a cada rodada e faria o
    # circuit breaker nunca reconhecer o mesmo erro duas vezes.
    return _TEMPO_PYTEST.sub("", linhas[-1])


def _ambiente_sem_chaves() -> dict:
    # O código gerado roda isolado (-I): nunca deve conseguir ler as chaves de API do processo pai.
    env = dict(os.environ)
    for chave in ("OPENROUTER_API_KEY", "DEEPSEEK_API_KEY"):
        env.pop(chave, None)
    return env


def _rodar_pytest(sandbox_dir: Path, timeout_s: float) -> Tuple[bool, str]:
    try:
        resultado = subprocess.run(
            [sys.executable, "-I", "-m", "pytest", "-q"],
            cwd=sandbox_dir,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            env=_ambiente_sem_chaves(),
        )
    except subprocess.TimeoutExpired:
        return False, "pytest excedeu o tempo limite."
    if resultado.returncode == SEM_TESTES_COLETADOS:
        # dossiê #4: o loop Harness->correção existia no diagrama, mas nenhum teste rodava
        # de fato. Um arquivo sem teste nenhum não pode contar como "harness ok".
        return False, "nenhum teste coletado: o arquivo deve se chamar test_*.py e conter funções test_*."
    if resultado.returncode != 0:
        return False, (resultado.stdout + resultado.stderr)[-4000:]
    return True, ""


def _rodar_ruff(sandbox_dir: Path) -> None:
    try:
        subprocess.run(
            [sys.executable, "-m", "ruff", "check", "."],
            cwd=sandbox_dir,
            capture_output=True,
            timeout=10,
        )
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        pass  # ruff indisponível neste ambiente; não bloqueia o harness.
