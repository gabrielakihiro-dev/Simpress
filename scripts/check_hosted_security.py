"""Read-only checks of environment variables; never connects or enables hosted operation."""
import os
from pathlib import Path
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from security.config import validate_hosted
from persistence.config import PersistenceError

if __name__ == "__main__":
    try:
        validate_hosted(os.environ)
        print("Pré-requisitos estáticos atendidos; hospedagem e TLS ainda exigem ensaio da Etapa 8.")
    except PersistenceError as error:
        print(error.detail,file=sys.stderr)
        sys.exit(1)
