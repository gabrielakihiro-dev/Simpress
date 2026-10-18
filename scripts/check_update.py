"""Offer an optional fast-forward update from origin/main when the launcher starts.

Never resets, cleans, stashes or forces anything: any doubt means "keep the current
version". See docs/operacao/atualizacao-um-clique.md.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import sys
from typing import Callable, Sequence


REMOTE = "origin"
BRANCH = "main"
UPSTREAM = f"{REMOTE}/{BRANCH}"
DISABLE_VARIABLE = "SIMPRESS_VERIFICAR_ATUALIZACAO"
TIMEOUT_VARIABLE = "SIMPRESS_ATUALIZACAO_TIMEOUT"
DEFAULT_TIMEOUT_SECONDS = 60.0
DISABLED_VALUES = {"0", "nao", "não", "n", "false", "off", "no"}
ACCEPTED_ANSWERS = {"s", "sim"}
MAX_LISTED_COMMITS = 10

EXIT_CONTINUE = 0
EXIT_LAUNCHER_CHANGED = 3

LAUNCHER = "iniciar_servidor.bat"
REQUIREMENTS = "requirements.txt"
KEEP_CURRENT = "Iniciando com a versão atual."

Runner = Callable[..., subprocess.CompletedProcess]


class _GitUnavailable(Exception):
    pass


def _git(
    root: Path,
    args: Sequence[str],
    *,
    runner: Runner,
    timeout: float | None = None,
) -> subprocess.CompletedProcess:
    environment = dict(os.environ)
    # Never wait for credentials in the launcher window.
    environment["GIT_TERMINAL_PROMPT"] = "0"
    try:
        return runner(
            ["git", "-C", str(root), *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            timeout=timeout,
            env=environment,
        )
    except FileNotFoundError as error:
        raise _GitUnavailable() from error


def _timeout_seconds() -> float:
    try:
        value = float(os.environ.get(TIMEOUT_VARIABLE, DEFAULT_TIMEOUT_SECONDS))
    except ValueError:
        return DEFAULT_TIMEOUT_SECONDS
    return value if value > 0 else DEFAULT_TIMEOUT_SECONDS


def _blob(root: Path, revision: str, path: str, runner: Runner) -> str:
    result = _git(root, ["rev-parse", "--verify", "--quiet", f"{revision}:{path}"], runner=runner)
    return result.stdout.strip() if result.returncode == 0 else ""


def _ask(prompt: Callable[[str], str]) -> bool:
    try:
        answer = prompt("Há uma versão nova. Atualizar agora? (S/N) ")
    except (EOFError, OSError):
        return False
    return answer.strip().lower() in ACCEPTED_ANSWERS


def check_for_update(
    project_root: Path,
    *,
    runner: Runner = subprocess.run,
    prompt: Callable[[str], str] = input,
    report: Callable[[str], None] = print,
    environ: dict[str, str] | None = None,
) -> int:
    """Return EXIT_LAUNCHER_CHANGED when the launcher itself was updated, else EXIT_CONTINUE."""
    env = os.environ if environ is None else environ
    if env.get(DISABLE_VARIABLE, "").strip().lower() in DISABLED_VALUES:
        report(f"Verificação de atualização desativada ({DISABLE_VARIABLE}=0).")
        return EXIT_CONTINUE

    root = Path(project_root).resolve()
    timeout = _timeout_seconds()
    try:
        return _check(root, runner=runner, prompt=prompt, report=report, timeout=timeout)
    except _GitUnavailable:
        report("Git não encontrado; a verificação de atualização foi ignorada.")
    except subprocess.TimeoutExpired:
        report("O Git demorou demais para responder (sem rede ou servidor lento).")
        report(KEEP_CURRENT)
    return EXIT_CONTINUE


def _check(
    root: Path,
    *,
    runner: Runner,
    prompt: Callable[[str], str],
    report: Callable[[str], None],
    timeout: float,
) -> int:
    inside = _git(root, ["rev-parse", "--is-inside-work-tree"], runner=runner)
    if inside.returncode != 0 or inside.stdout.strip() != "true":
        report("Esta pasta não é um repositório Git; a verificação de atualização foi ignorada.")
        return EXIT_CONTINUE

    branch = _git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], runner=runner)
    if branch.returncode != 0:
        report("Não há branch ativo (HEAD destacado); a atualização foi ignorada.")
        report(KEEP_CURRENT)
        return EXIT_CONTINUE
    current_branch = branch.stdout.strip()
    if current_branch != BRANCH:
        report(f"Atualização automática disponível só no branch {BRANCH} (atual: {current_branch}).")
        report(KEEP_CURRENT)
        return EXIT_CONTINUE

    report("Verificando se há uma versão nova do Simpress...")
    fetch = _git(root, ["fetch", "--quiet", REMOTE, BRANCH], runner=runner, timeout=timeout)
    if fetch.returncode != 0:
        report(f"Não foi possível consultar o servidor Git (sem rede ou sem acesso ao {REMOTE}).")
        report(KEEP_CURRENT)
        return EXIT_CONTINUE

    counts = _git(root, ["rev-list", "--left-right", "--count", f"HEAD...{UPSTREAM}"], runner=runner)
    try:
        if counts.returncode != 0:
            raise ValueError(counts.stderr)
        local_only, remote_only = (int(value) for value in counts.stdout.split())
    except ValueError:
        report(f"Não foi possível comparar a versão local com {UPSTREAM}.")
        report(KEEP_CURRENT)
        return EXIT_CONTINUE

    if remote_only == 0:
        report("Você já está na versão mais recente.")
        return EXIT_CONTINUE
    if local_only:
        report(
            f"A versão local tem commits que não estão em {UPSTREAM}; "
            "a atualização automática não é possível."
        )
        report(KEEP_CURRENT)
        return EXIT_CONTINUE

    status = _git(root, ["status", "--porcelain", "--untracked-files=no"], runner=runner)
    if status.returncode != 0:
        report("Não foi possível conferir as alterações locais.")
        report(KEEP_CURRENT)
        return EXIT_CONTINUE
    changed = [line for line in status.stdout.splitlines() if line.strip()]
    if changed:
        report("Há uma versão nova, mas existem alterações locais em arquivos do projeto:")
        for line in changed[:MAX_LISTED_COMMITS]:
            report(f"  {line.strip()}")
        if len(changed) > MAX_LISTED_COMMITS:
            report(f"  ... e mais {len(changed) - MAX_LISTED_COMMITS}.")
        report("Nada foi alterado. Peça ajuda para revisar essas alterações antes de atualizar.")
        report(KEEP_CURRENT)
        return EXIT_CONTINUE

    log = _git(
        root,
        ["log", "--oneline", "--no-decorate", f"-n{MAX_LISTED_COMMITS}", f"HEAD..{UPSTREAM}"],
        runner=runner,
    )
    report(f"Novidades disponíveis ({remote_only} commit(s)):")
    for line in log.stdout.splitlines():
        report(f"  {line}")

    if not _ask(prompt):
        report("Atualização adiada. " + KEEP_CURRENT)
        return EXIT_CONTINUE

    old_requirements = _blob(root, "HEAD", REQUIREMENTS, runner)
    old_launcher = _blob(root, "HEAD", LAUNCHER, runner)
    pull = _git(root, ["pull", "--ff-only", REMOTE, BRANCH], runner=runner, timeout=timeout)
    if pull.returncode != 0:
        report("A atualização não foi aplicada (git pull --ff-only falhou):")
        for line in (pull.stderr or pull.stdout).strip().splitlines():
            report(f"  {line}")
        report(KEEP_CURRENT)
        return EXIT_CONTINUE

    report("Atualização concluída.")
    if _blob(root, "HEAD", REQUIREMENTS, runner) != old_requirements:
        report("O requirements.txt mudou; as dependências serão reinstaladas a seguir.")
    if _blob(root, "HEAD", LAUNCHER, runner) != old_launcher:
        report("O inicializador foi atualizado e será reiniciado.")
        return EXIT_LAUNCHER_CHANGED
    return EXIT_CONTINUE


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--project-root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
    )
    args = parser.parse_args(argv)
    try:
        return check_for_update(args.project_root)
    except (OSError, subprocess.SubprocessError) as error:
        print(f"[AVISO] A verificação de atualização falhou: {error}", file=sys.stderr)
        print(KEEP_CURRENT)
        return EXIT_CONTINUE


if __name__ == "__main__":
    raise SystemExit(main())
