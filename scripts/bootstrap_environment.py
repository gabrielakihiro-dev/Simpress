"""Create the local virtual environment and install pinned requirements when needed."""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import subprocess
import sys
from typing import Callable, Sequence
import venv


MINIMUM_PYTHON = (3, 12)
INSTALL_MARKER = ".simpress-requirements-sha256"


def _requirements_digest(requirements: Sequence[Path]) -> str:
    digest = hashlib.sha256()
    for path in requirements:
        if not path.is_file():
            raise FileNotFoundError(f"Arquivo de dependências não encontrado: {path}")
        digest.update(path.name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def ensure_environment(
    project_root: Path,
    *,
    postgres_pilot: bool = False,
    python_version: Sequence[int] | None = None,
    command_runner: Callable[..., subprocess.CompletedProcess] = subprocess.run,
    environment_creator: Callable[[Path], None] | None = None,
    report: Callable[[str], None] = print,
) -> Path:
    """Ensure .venv exists and its pinned dependency manifest is installed."""
    root = Path(project_root).resolve()
    version = tuple(sys.version_info[:3] if python_version is None else python_version[:3])
    if version < MINIMUM_PYTHON:
        minimum = ".".join(map(str, MINIMUM_PYTHON))
        found = ".".join(map(str, version))
        raise RuntimeError(f"Python {minimum} ou superior é necessário; versão encontrada: {found}.")

    venv_dir = root / ".venv"
    python_path = venv_dir / "Scripts" / "python.exe"
    if not python_path.is_file():
        creator = environment_creator or venv.EnvBuilder(with_pip=True).create
        creator(venv_dir)
    if not python_path.is_file():
        raise RuntimeError(f"O ambiente virtual não foi criado corretamente em {venv_dir}.")

    runtime_requirements = root / "requirements.txt"
    requirements = [runtime_requirements]
    install_manifest = runtime_requirements
    if postgres_pilot:
        postgres_requirements = root / "requirements-postgres.txt"
        requirements.append(postgres_requirements)
        install_manifest = postgres_requirements

    digest = _requirements_digest(requirements)
    marker = venv_dir / INSTALL_MARKER
    try:
        installed_digest = marker.read_text(encoding="ascii").strip()
    except OSError:
        installed_digest = ""

    pip_command = [str(python_path), "-m", "pip", "--version"]
    pip_status = command_runner(
        pip_command, cwd=str(root), check=False, capture_output=True,
    )
    if pip_status.returncode != 0:
        report("Recuperando o pip ausente no ambiente virtual com ensurepip.")
        recovery = command_runner(
            [str(python_path), "-m", "ensurepip", "--upgrade"],
            cwd=str(root),
            check=False,
        )
        if recovery.returncode != 0:
            raise RuntimeError(
                f"Não foi possível recuperar o pip (código {recovery.returncode}). "
                "Verifique se a instalação do Python inclui o módulo ensurepip."
            )
        pip_status = command_runner(
            pip_command, cwd=str(root), check=False, capture_output=True,
        )
        if pip_status.returncode != 0:
            raise RuntimeError("O pip continua indisponível após executar ensurepip.")
        # A repaired environment must reinstall even if an old marker exists.
        marker.unlink(missing_ok=True)
        installed_digest = ""

    if installed_digest == digest:
        report("Dependências do projeto já estão preparadas.")
        return python_path

    report("Instalando as dependências fixadas do projeto; a primeira instalação requer internet.")
    result = command_runner(
        [
            str(python_path),
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "-r",
            str(install_manifest),
        ],
        cwd=str(root),
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"A instalação das dependências terminou com código {result.returncode}. "
            "Confira a conexão com a internet e tente novamente."
        )

    temporary_marker = marker.with_name(f"{marker.name}.tmp")
    temporary_marker.write_text(f"{digest}\n", encoding="ascii")
    os.replace(temporary_marker, marker)
    report("Ambiente Python pronto.")
    return python_path


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--project-root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
    )
    parser.add_argument(
        "--postgres-pilot",
        action="store_true",
        help="Install the optional PostgreSQL pilot dependencies too.",
    )
    args = parser.parse_args(argv)
    try:
        ensure_environment(args.project_root, postgres_pilot=args.postgres_pilot)
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"[ERRO] {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
