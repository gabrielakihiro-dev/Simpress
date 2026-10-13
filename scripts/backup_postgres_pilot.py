"""Create a synthetic local pilot backup at the approved Backup_Banco destination."""

import argparse
import json
import getpass
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from scripts.run_postgres_pilot import checked_stack,create_login,drop_login,create_runtime_login,drop_runtime_login
from scripts import supabase_local as local
from persistence.config import PersistenceSettings
from persistence.postgres import PostgresBackend
from persistence.backup import create,verify
import main as domain


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local-disposable",action="store_true",required=True)
    parser.add_argument("--auth",action="store_true")
    args = parser.parse_args()
    cli,docker = checked_stack()
    password = (create_runtime_login if args.auth else create_login)(docker)
    backend = None
    context = None
    identity = None
    try:
        status = json.loads(local.run([*cli,"status","--output","json","--agent","no"]))
        if args.auth:
            from cryptography.fernet import Fernet
            from security.config import AuthSettings
            from security.context import principal
            domain.AUTH_SETTINGS = AuthSettings(True,api_key=status["ANON_KEY"],session_key=Fernet.generate_key().decode())
        login = "simpress_runtime_login" if args.auth else "simpress_piloto_login"
        backend = PostgresBackend(PersistenceSettings("postgres",f"postgresql://{login}:{password}@127.0.0.1:54322/postgres",2,status["SERVICE_ROLE_KEY"],args.auth),domain)
        backend.open()
        if args.auth:
            email = input("E-mail do administrador: ").strip()
            credential = getpass.getpass("Senha: ")
            opaque,_ = backend.auth.login(email,credential,"local-backup")
            identity,_ = backend.auth.load(opaque)
            context = principal.set(identity)
        path = create(backend.files,ROOT)
        verify(path)
        print("Backup sintético do domínio e Storage verificado:",path.name)
    finally:
        if backend:
            if identity:
                backend.auth.logout(identity)
            if context is not None:
                principal.reset(context)
            backend.close()
        (drop_runtime_login if args.auth else drop_login)(docker)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Backup não concluído ({type(error).__name__}); confira o piloto local.",file=sys.stderr)
        sys.exit(1)
