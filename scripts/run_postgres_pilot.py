"""Run the local PostgreSQL pilot with an ephemeral server-only login/password.

Only the identified disposable stack is accepted. No real data is imported and
no password is written to disk or output. The login is removed on clean exit.
"""

import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts import supabase_local as local


def admin_sql(docker, sql, *, database="postgres"):
    return local.run([docker, "exec", "-i", local.DB_CONTAINER, "psql", "-X", "-q", "-t", "-A",
                      "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1"], sql=sql)


def checked_stack():
    local.check_config()
    cli, docker = local.executables()
    local.check_network(docker)
    local.check_db(docker)
    local.check_receipt(docker)
    marker = admin_sql(docker, "select obj_description('simpress'::regnamespace, 'pg_namespace');").strip()
    if marker != "simpress-dev: disposable synthetic development; no operational data":
        raise RuntimeError("Disposable database marker missing; pilot refused.")
    return cli, docker


def create_login(docker):
    # Fixed name, refuse any existing login rather than take ownership/reset it.
    password = secrets.token_hex(32)
    admin_sql(docker, """begin;
        do $$ begin
        if exists(select 1 from pg_roles where rolname='simpress_piloto_login') then
            raise exception 'Pilot login already exists; inspect its owner before retrying';
        end if; end $$;
        create role simpress_piloto_login login noinherit nosuperuser nocreatedb nocreaterole
            noreplication nobypassrls connection limit 8 password '""" + password + """';
        grant simpress_piloto to simpress_piloto_login with inherit false, set true;
        grant connect on database postgres to simpress_piloto_login;
        commit;
        """)
    return password


def drop_login(docker):
    admin_sql(docker, "begin; revoke connect on database postgres from simpress_piloto_login; drop role simpress_piloto_login; commit;")


def create_runtime_login(docker):
    password = secrets.token_hex(32)
    admin_sql(docker,"""begin;
        create role simpress_runtime_login login noinherit nosuperuser nocreatedb nocreaterole
            noreplication nobypassrls connection limit 8 password '"""+password+"""';
        grant simpress_runtime,simpress_session_gateway to simpress_runtime_login with inherit false,set true;
        grant connect on database postgres to simpress_runtime_login;
        commit;""")
    return password


def drop_runtime_login(docker):
    admin_sql(docker,"begin; revoke connect on database postgres from simpress_runtime_login; drop role simpress_runtime_login; commit;")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--storage", action="store_true", help="Enable private Storage integration in this disposable pilot")
    parser.add_argument("--auth", action="store_true", help="Require the approved administrator via local Supabase Auth")
    args = parser.parse_args()
    if not 8000 <= args.port <= 8099:
        raise RuntimeError("Pilot HTTP port must be between 8000 and 8099.")
    cli, docker = checked_stack()
    password = create_runtime_login(docker) if args.auth else create_login(docker)
    try:
        environment = os.environ.copy()
        login = "simpress_runtime_login" if args.auth else "simpress_piloto_login"
        environment.update(SIMPRESS_PERSISTENCE_BACKEND="postgres", SIMPRESS_POSTGRES_LOCAL_PILOT="1",
            SIMPRESS_DATABASE_URL=f"postgresql://{login}:{password}@127.0.0.1:54322/postgres",
            SIMPRESS_PORT=str(args.port), SIMPRESS_AUTH_ENABLED="1" if args.auth else "0")
        environment.pop("SIMPRESS_STORAGE_SERVICE_KEY",None)
        if args.storage or args.auth:
            # CLI status contains privileged keys: keep it entirely in memory.
            status = json.loads(local.run([*cli,"status","--output","json","--agent","no"]))
            environment["SIMPRESS_STORAGE_SERVICE_KEY"] = status["SERVICE_ROLE_KEY"]
        if args.auth:
            from cryptography.fernet import Fernet
            environment.update(SIMPRESS_APP_ORIGIN=f"http://127.0.0.1:{args.port}",SIMPRESS_AUTH_API_KEY=status["ANON_KEY"])
            if not environment.get("SIMPRESS_SESSION_KEY"):
                environment["SIMPRESS_SESSION_KEY"] = Fernet.generate_key().decode("ascii")
                print("Chave de sessão temporária: reiniciar exigirá novo login.",flush=True)
        print(f"Piloto PostgreSQL local: http://127.0.0.1:{args.port}; dados reais não foram importados.", flush=True)
        subprocess.run([sys.executable, "-B", "-m", "uvicorn", "main:app", "--host", "127.0.0.1",
                        "--port", str(args.port), "--no-proxy-headers"], cwd=ROOT, env=environment, check=True)
    finally:
        (drop_runtime_login if args.auth else drop_login)(docker)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        print(f"Piloto não concluído ({type(error).__name__}); confira o ambiente local.", file=sys.stderr)
        sys.exit(1)
