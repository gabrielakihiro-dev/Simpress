"""Remove duplicate temporaries and quarantine differing snapshots older than seven days."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Dict

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

# The logic lives in core/limpeza_temporarios.py (shared with the "Saúde local" routes).
from core.limpeza_temporarios import (  # noqa: E402
    DEFAULT_MIN_AGE_HOURS,
    QUARANTINE_DIRECTORY,
    CleanupBlockedError,
    cleanup_local_temps,
)

__all__ = ["CleanupBlockedError", "DEFAULT_MIN_AGE_HOURS", "QUARANTINE_DIRECTORY", "cleanup_local_temps"]


def _summary(result: Dict[str, int], *, dry_run: bool) -> str:
    action = "candidato(s) seguro(s)" if dry_run else "arquivo(s) removido(s)"
    count = result["iguais_prontos"] if dry_run else result["removidos"]
    return (
        f"Limpeza concluída: {count} {action}; "
        f"{result['quarentena_prontos'] if dry_run else result['quarentenados']} "
        f"versão(ões) diferente(s) {'para quarentena' if dry_run else 'em quarentena'}; "
        f"{result['diferentes_preservados']} versão(ões) diferente(s), "
        f"{result['recentes_preservados']} arquivo(s) recente(s) e "
        f"{result['bloqueados_preservados']} arquivo(s) bloqueado(s) preservado(s)."
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Remove duplicatas antigas e move versões diferentes com mais de 7 dias para quarentena.",
    )
    parser.add_argument(
        "--min-age-hours",
        type=float,
        default=DEFAULT_MIN_AGE_HOURS,
        help="Idade mínima para considerar um temporário (padrão: 24 horas).",
    )
    arguments = parser.parse_args()
    try:
        report = cleanup_local_temps(
            PROJECT_ROOT,
            min_age_hours=arguments.min_age_hours,
            dry_run=not arguments.apply,
        )
    except (CleanupBlockedError, OSError, ValueError) as error:
        raise SystemExit(f"Limpeza interrompida com segurança: {error}") from error
    print(_summary(report, dry_run=not arguments.apply))
