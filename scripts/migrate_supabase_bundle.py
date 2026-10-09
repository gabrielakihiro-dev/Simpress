"""Offline plan for an explicitly supplied stage-8 synthetic migration bundle."""

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from persistence.migration import MigrationBundle
import main as domain


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true", required=True)
    args = parser.parse_args()
    print(json.dumps(MigrationBundle(args.bundle, domain).dry_run(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Simulação recusada ({type(error).__name__}); conteúdo e detalhes suprimidos.", file=sys.stderr)
        sys.exit(1)
