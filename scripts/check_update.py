"""Offer an optional fast-forward update to the newest published tag when the launcher starts.

Only tags named vMAJOR.MINOR.PATCH on origin and reachable from origin/main are offered;
untagged commits on main never are. Never resets, cleans, stashes or forces anything:
any doubt means "keep the current version". See docs/operacao/atualizacao-um-clique.md
and docs/guias/versionamento.md.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Callable, Sequence


REMOTE = "origin"
BRANCH = "main"
UPSTREAM = f"{REMOTE}/{BRANCH}"
TAG_PREFIX = "v"
DISABLE_VARIABLE = "SIMPRESS_VERIFICAR_ATUALIZACAO"
TIMEOUT_VARIABLE = "SIMPRESS_ATUALIZACAO_TIMEOUT"
DEFAULT_TIMEOUT_SECONDS = 60.0
DISABLED_VALUES = {"0", "nao", "não", "n", "false", "off", "no"}
ACCEPTED_ANSWERS = {"s", "sim"}
MAX_LISTED_FILES = 10
MAX_CHANGELOG_LINES = 40

EXIT_CONTINUE = 0
EXIT_LAUNCHER_CHANGED = 3

LAUNCHER = "iniciar_servidor.bat"
REQUIREMENTS = "requirements.txt"
CHANGELOG = "CHANGELOG.md"
KEEP_CURRENT = "Iniciando com a versão atual."

Runner = Callable[..., subprocess.CompletedProcess]
Version = tuple[int, int, int]

_TAG_PATTERN = re.compile(r"^refs/tags/v(\d+)\.(\d+)\.(\d+)(\^\{\})?$")
_CHANGELOG_HEADING = re.compile(r"^##\s+\[?v?(\d+)\.(\d+)\.(\d+)\]?")
_CHANGELOG_LINK = re.compile(r"^\[[^\]]+\]:\s")


class _GitUnavailable(Exception):
    pass


def format_version(version: Version) -> str:
    return f"{TAG_PREFIX}{version[0]}.{version[1]}.{version[2]}"


def parse_remote_tags(ls_remote_output: str) -> list[tuple[Version, str]]:
    """Map ``git ls-remote --tags`` lines to sorted (version, commit) pairs.

    Tags that are not exactly vMAJOR.MINOR.PATCH (pre-releases, other names) are ignored.
    Annotated tags appear twice; the peeled ``^{}`` line holds the commit and wins.
    """
    commits: dict[Version, str] = {}
    peeled: set[Version] = set()
    for line in ls_remote_output.splitlines():
        parts = line.split()
        if len(parts) != 2:
            continue
        match = _TAG_PATTERN.match(parts[1])
        if not match:
            continue
        version = (int(match[1]), int(match[2]), int(match[3]))
        if match[4]:
            commits[version] = parts[0]
            peeled.add(version)
        elif version not in peeled:
            commits[version] = parts[0]
    return sorted(commits.items())


def changelog_notes(text: str, installed: Version | None, newest: Version) -> list[str]:
    """Return the CHANGELOG sections of the versions after ``installed`` up to ``newest``."""
    notes: list[str] = []
    keep = False
    for line in text.splitlines():
        if line.startswith("## "):
            match = _CHANGELOG_HEADING.match(line)
            version = (int(match[1]), int(match[2]), int(match[3])) if match else None
            keep = version is not None and version <= newest and (installed is None or version > installed)
        elif _CHANGELOG_LINK.match(line):
            keep = False
        if keep:
            notes.append(line.rstrip())
    while notes and not notes[-1]:
        notes.pop()
    if len(notes) > MAX_CHANGELOG_LINES:
        notes = notes[:MAX_CHANGELOG_LINES] + [f"... (continua no {CHANGELOG})"]
    return notes


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


def _is_ancestor(root: Path, ancestor: str, descendant: str, runner: Runner) -> bool:
    """``merge-base --is-ancestor``; an unknown commit counts as "no"."""
    return _git(root, ["merge-base", "--is-ancestor", ancestor, descendant], runner=runner).returncode == 0


def _ask(prompt: Callable[[str], str], version: str) -> bool:
    try:
        answer = prompt(f"Há uma versão nova ({version}). Atualizar agora? (S/N) ")
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


def _keep_current(report: Callable[[str], None], message: str) -> int:
    report(message)
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
        return _keep_current(report, "Não há branch ativo (HEAD destacado); a atualização foi ignorada.")
    current_branch = branch.stdout.strip()
    if current_branch != BRANCH:
        return _keep_current(
            report, f"Atualização automática disponível só no branch {BRANCH} (atual: {current_branch})."
        )

    report("Verificando se há uma versão nova do Simpress...")
    no_network = f"Não foi possível consultar o servidor Git (sem rede ou sem acesso ao {REMOTE})."
    # Tags are read from origin, not from local refs, so a stray local tag is never offered.
    tags = _git(root, ["ls-remote", "--tags", REMOTE, f"{TAG_PREFIX}*"], runner=runner, timeout=timeout)
    if tags.returncode != 0:
        return _keep_current(report, no_network)
    versions = parse_remote_tags(tags.stdout)
    if not versions:
        report("Nenhuma versão publicada foi encontrada no servidor (tag no formato v1.2.3).")
        report(
            "A atualização automática só oferece versões testadas e publicadas com tag; "
            "commits novos sem tag não são oferecidos."
        )
        report(KEEP_CURRENT)
        return EXIT_CONTINUE

    fetch = _git(root, ["fetch", "--quiet", "--no-tags", REMOTE, BRANCH], runner=runner, timeout=timeout)
    if fetch.returncode != 0:
        return _keep_current(report, no_network)

    installed: Version | None = None
    for version, commit in reversed(versions):
        if _is_ancestor(root, commit, "HEAD", runner):
            installed = version
            break
    newest, target = versions[-1]
    if installed is not None and newest <= installed:
        report(f"Você já está na versão mais recente ({format_version(installed)}).")
        return EXIT_CONTINUE

    name = format_version(newest)
    if not _is_ancestor(root, target, UPSTREAM, runner):
        return _keep_current(
            report, f"A versão {name} não está no histórico de {UPSTREAM}; a atualização foi ignorada."
        )
    if not _is_ancestor(root, "HEAD", target, runner):
        return _keep_current(
            report,
            f"A versão local tem commits que não estão na versão {name}; "
            "a atualização automática não é possível.",
        )

    status = _git(root, ["status", "--porcelain", "--untracked-files=no"], runner=runner)
    if status.returncode != 0:
        return _keep_current(report, "Não foi possível conferir as alterações locais.")
    changed = [line for line in status.stdout.splitlines() if line.strip()]
    if changed:
        report(f"Há uma versão nova ({name}), mas existem alterações locais em arquivos do projeto:")
        for line in changed[:MAX_LISTED_FILES]:
            report(f"  {line.strip()}")
        if len(changed) > MAX_LISTED_FILES:
            report(f"  ... e mais {len(changed) - MAX_LISTED_FILES}.")
        return _keep_current(
            report, "Nada foi alterado. Peça ajuda para revisar essas alterações antes de atualizar."
        )

    installed_label = format_version(installed) if installed else "nenhuma versão publicada"
    report(f"Versão nova disponível: {name} (instalada: {installed_label}).")
    changelog = _git(root, ["show", f"{target}:{CHANGELOG}"], runner=runner)
    notes = changelog_notes(changelog.stdout if changelog.returncode == 0 else "", installed, newest)
    if notes:
        report(f"O que mudou (trecho do {CHANGELOG}):")
        for line in notes:
            report(f"  {line}" if line else "")
    else:
        report(f"O {CHANGELOG} não tem notas para a versão {name}.")

    if not _ask(prompt, name):
        report("Atualização adiada. " + KEEP_CURRENT)
        return EXIT_CONTINUE

    old_requirements = _blob(root, "HEAD", REQUIREMENTS, runner)
    old_launcher = _blob(root, "HEAD", LAUNCHER, runner)
    # Fast-forward only to the tagged commit: never creates a merge commit.
    update = _git(root, ["merge", "--ff-only", "--quiet", target], runner=runner, timeout=timeout)
    if update.returncode != 0:
        report(f"A atualização não foi aplicada (o fast-forward para {name} falhou):")
        for line in (update.stderr or update.stdout).strip().splitlines():
            report(f"  {line}")
        report(KEEP_CURRENT)
        return EXIT_CONTINUE

    report(f"Atualização concluída: Simpress {name}.")
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
