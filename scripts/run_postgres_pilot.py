"""Run the local PostgreSQL pilot with an ephemeral server-only login/password.

Only the identified disposable stack is accepted. No real data is imported and
no password is written to disk or output. The login is removed on clean exit.
"""

import argparse
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    if not 8000 <= args.port <= 8099:
        raise RuntimeError("Pilot HTTP port must be between 8000 and 8099.")
    _, docker = checked_stack()
    password = create_login(docker)
    try:
        environment = os.environ.copy()
        environment.update(SIMPRESS_PERSISTENCE_BACKEND="postgres", SIMPRESS_POSTGRES_LOCAL_PILOT="1",
            SIMPRESS_DATABASE_URL=f"postgresql://simpress_piloto_login:{password}@127.0.0.1:54322/postgres")
        print(f"Piloto PostgreSQL local: http://127.0.0.1:{args.port}; dados reais não foram importados.", flush=True)
        subprocess.run([sys.executable, "-B", "-m", "uvicorn", "main:app", "--host", "127.0.0.1",
                        "--port", str(args.port)], cwd=ROOT, env=environment, check=True)
    finally:
        drop_login(docker)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        print(f"Piloto não concluído ({type(error).__name__}); confira o ambiente local.", file=sys.stderr)
        sys.exit(1)
