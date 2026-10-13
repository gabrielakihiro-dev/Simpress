"""Operate only the disposable simpress-dev stack. Never accepts a remote URL."""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tomllib
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PROJECT = "simpress-dev"
NETWORK = "simpress-dev-loopback"
DB_CONTAINER = f"supabase_db_{PROJECT}"
CLI_VERSION = "2.120.0"
RECEIPT = ROOT / "supabase/.temp/simpress-dev-instance.json"
EXCLUDED = "studio,postgres-meta,realtime,imgproxy,mailpit,edge-runtime,logflare,vector,supavisor"
SENSITIVE = re.compile(r"postgres(?:ql)?://|\beyJ[A-Za-z0-9_-]{16,}|sb_(?:secret|publishable)_|password|secret|service.role|anon.key|jwt", re.I)


def run(args: list[str], *, sql: str | None = None, timeout: int = 120) -> str:
    result = subprocess.run(
        args, cwd=ROOT, input=sql, capture_output=True, encoding="utf-8",
        errors="replace", timeout=timeout, check=False,
    )
    if result.returncode:
        # CLI status/start may contain credentials. Never persist or echo raw output.
        tail = result.stdout.splitlines()[-6:] + result.stderr.splitlines()[-12:]
        safe = ["[redacted]" if SENSITIVE.search(line) else line for line in tail]
        raise RuntimeError(f"Command failed (exit {result.returncode}):\n" + "\n".join(safe))
    return result.stdout


def executables() -> tuple[list[str], str]:
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js is required; install project dependencies first.")
    wrapper = ROOT / "node_modules/supabase/dist/supabase.js"
    if not wrapper.is_file():
        raise RuntimeError("Supabase CLI dependency missing. Run npm ci first.")
    rancher_bin = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs/Rancher Desktop/resources/resources/win32/bin"
    if rancher_bin.is_dir():
        os.environ["PATH"] = str(rancher_bin) + os.pathsep + os.environ.get("PATH", "")
    docker = shutil.which("docker")
    if not docker:
        raise RuntimeError("Docker CLI not found. Start Rancher Desktop and refresh the process PATH.")
    cli = [node, str(wrapper)]
    if run([*cli, "--version"]).strip() != CLI_VERSION:
        raise RuntimeError("Unexpected Supabase CLI version.")
    return cli, docker


def check_config() -> None:
    with (ROOT / "supabase/config.toml").open("rb") as source:
        cfg = tomllib.load(source)
    expected = (
        cfg.get("project_id") == PROJECT
        and cfg["db"]["port"] == 54322 and cfg["db"]["shadow_port"] == 54320
        and cfg["db"]["major_version"] == 17 and cfg["api"]["port"] == 54321
        and "simpress" not in cfg["api"]["schemas"]
        and not cfg["db"]["seed"]["enabled"]
        and not cfg["auth"]["enable_signup"]
        and cfg["auth"]["email"]["enable_signup"]
        and not cfg["auth"]["enable_anonymous_sign_ins"]
    )
    if not expected:
        raise RuntimeError("Configuration no longer matches the approved disposable environment.")
    if (ROOT / "supabase/.temp/project-ref").exists():
        raise RuntimeError("A linked remote project marker exists; refusing local operations.")


def containers(docker: str) -> list[dict]:
    ids = run([docker, "ps", "-aq", "--filter", f"name=_{PROJECT}"]).split()
    if not ids:
        return []
    found = json.loads(run([docker, "inspect", *ids]))
    return [item for item in found if item["Name"].lstrip("/").endswith("_" + PROJECT)]


def check_network(docker: str, *, create: bool = False) -> None:
    names = run([docker, "network", "ls", "--format", "{{.Name}}"]).splitlines()
    if NETWORK not in names:
        if not create:
            raise RuntimeError("Dedicated loopback network missing.")
        run([docker, "network", "create", "--driver", "bridge", "--label",
             "com.simpress.purpose=disposable-development", "--opt",
             "com.docker.network.bridge.host_binding_ipv4=127.0.0.1", NETWORK])
    data = json.loads(run([docker, "network", "inspect", NETWORK]))[0]
    if (data["Options"].get("com.docker.network.bridge.host_binding_ipv4") != "127.0.0.1"
            or data.get("Labels", {}).get("com.simpress.purpose") != "disposable-development"):
        raise RuntimeError("Existing network is not the expected isolated development network.")


def check_bindings(docker: str) -> None:
    found = containers(docker)
    if not found:
        raise RuntimeError("No simpress-dev containers found.")
    for item in found:
        labels = item["Config"].get("Labels") or {}
        if (labels.get("com.supabase.cli.project") != PROJECT
                or Path(labels.get("com.supabase.cli.workdir", "")) != ROOT):
            raise RuntimeError("Container project/workdir labels do not match this checkout.")
        if NETWORK not in item["NetworkSettings"]["Networks"]:
            raise RuntimeError("Project container is not on the dedicated network.")
        for bindings in (item["NetworkSettings"].get("Ports") or {}).values():
            for binding in bindings or []:
                host = binding.get("HostIp", "")
                if not host or not ipaddress.ip_address(host).is_loopback:
                    raise RuntimeError("Non-loopback Docker port publication detected.")


def check_db(docker: str) -> None:
    names = {item["Name"].lstrip("/") for item in containers(docker)}
    if DB_CONTAINER not in names:
        raise RuntimeError("Expected disposable database container missing.")
    version = run([docker, "exec", DB_CONTAINER, "psql", "-X", "-U", "postgres", "-d", "postgres",
                   "-Atc", "show server_version_num;"]).strip()
    if not version.startswith("17"):
        raise RuntimeError("Expected PostgreSQL 17.")
    check_bindings(docker)


def mark_disposable(docker: str) -> None:
    run([docker, "exec", DB_CONTAINER, "psql", "-X", "-U", "postgres", "-d", "postgres",
         "-v", "ON_ERROR_STOP=1", "-c",
         "comment on schema simpress is 'simpress-dev: disposable synthetic development; no operational data';"])


def volume_identity(docker: str) -> list[dict]:
    names = [name for name in run([docker, "volume", "ls", "--format", "{{.Name}}"]).splitlines()
             if name.endswith("_" + PROJECT)]
    if not names:
        return []
    data = json.loads(run([docker, "volume", "inspect", *names]))
    return sorted(({"name": item["Name"], "created_at": item["CreatedAt"]} for item in data), key=lambda item: item["name"])


def record_instance(docker: str) -> None:
    # Non-secret receipt permits explicit resume, never an implicit reset.
    RECEIPT.parent.mkdir(parents=True, exist_ok=True)
    RECEIPT.write_text(json.dumps({"project": PROJECT, "root": str(ROOT), "volumes": volume_identity(docker)}, indent=2), encoding="utf-8")


def check_receipt(docker: str) -> None:
    receipt = json.loads(RECEIPT.read_text(encoding="utf-8"))
    if (receipt.get("project") != PROJECT or Path(receipt.get("root", "")) != ROOT
            or not receipt.get("volumes") or receipt["volumes"] != volume_identity(docker)):
        raise RuntimeError("Known local volume identities changed; refusing resume/reset.")


def check_api(cli: list[str]) -> None:
    status = json.loads(run([*cli, "status", "--output", "json", "--agent", "no"]))
    # Read local keys in memory only; do not log, persist or print CLI status.
    anon_key = status["ANON_KEY"]
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def get(path: str, *, with_api_key: bool = True, schema: str | None = None) -> tuple[int, dict]:
        headers = {"apikey": anon_key} if with_api_key else {}
        if schema:
            headers["Accept-Profile"] = schema
        request = urllib.request.Request("http://127.0.0.1:54321" + path, headers=headers)
        try:
            with opener.open(request, timeout=15) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read())

    if get("/auth/v1/health")[0] != 200:
        raise RuntimeError("Auth health request failed.")
    code, settings = get("/auth/v1/settings")
    if code != 200 or settings.get("disable_signup") is not True:
        raise RuntimeError("Auth public signup is not disabled.")
    if settings.get("external",{}).get("email") is not True:
        raise RuntimeError("The email/password provider required by stage 7 is disabled.")
    code, data = get("/rest/v1/configuracao", with_api_key=False)
    if code != 404 or data.get("code") != "PGRST205":
        raise RuntimeError("Private domain table unexpectedly resolves through the default public API.")
    code, data = get("/rest/v1/configuracao", schema="simpress")
    if code != 406 or data.get("code") != "PGRST106":
        raise RuntimeError("Domain schema is not excluded from the Data API as expected.")
    print("PASS: 4 HTTP assertions (Auth health, closed signup, no public domain table, private domain schema).")


def stop(cli: list[str]) -> None:
    run([*cli, "stop", "--project-id", PROJECT], timeout=180)
    print("simpress-dev stopped; volumes preserved.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("check", "start", "resume", "migrate", "validate", "reset", "stop"))
    action = parser.parse_args().action
    check_config()
    cli, docker = executables()
    run([docker, "info", "--format", "{{.ServerVersion}}"])
    if action == "stop":
        if containers(docker):
            check_bindings(docker)
        stop(cli)
        return
    check_network(docker, create=action in ("start", "resume"))
    if action in ("start", "resume"):
        # A previously used volume must be inspected, not silently reused or reset.
        volumes = run([docker, "volume", "ls", "--format", "{{.Name}}"]).splitlines()
        if action == "resume":
            check_receipt(docker)
        elif containers(docker) or any(name.endswith("_" + PROJECT) for name in volumes):
            raise RuntimeError("Existing simpress-dev containers/volumes found; refusing an implicit restart.")
        if containers(docker):
            raise RuntimeError("Project already has containers; use check/validate instead of start/resume.")
        for port in (54320, 54321, 54322):
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", port))
        try:
            run([*cli, "start", "--network-id", NETWORK, "--exclude", EXCLUDED, "--agent", "no"], timeout=1800)
            check_db(docker)
            if action == "start":
                mark_disposable(docker)
            record_instance(docker)
        except (RuntimeError, subprocess.TimeoutExpired):
            stop(cli)
            raise
        print("simpress-dev started; PostgreSQL 17 and loopback bindings verified.")
    elif action == "migrate":
        check_db(docker)
        check_receipt(docker)
        marker = run([docker, "exec", DB_CONTAINER, "psql", "-X", "-U", "postgres", "-d", "postgres",
                      "-Atc", "select obj_description('simpress'::regnamespace, 'pg_namespace');"]).strip()
        if marker != "simpress-dev: disposable synthetic development; no operational data":
            raise RuntimeError("Disposable database marker missing; migration refused.")
        run([*cli, "db", "push", "--local", "--yes", "--agent", "no"], timeout=180)
        check_db(docker)
        print("Pending migrations applied only to identified disposable simpress-dev.")
    elif action == "reset":
        check_db(docker)
        check_receipt(docker)
        marker = run([docker, "exec", DB_CONTAINER, "psql", "-X", "-U", "postgres", "-d", "postgres",
                      "-Atc", "select obj_description('simpress'::regnamespace, 'pg_namespace');"]).strip()
        if marker != "simpress-dev: disposable synthetic development; no operational data":
            raise RuntimeError("Disposable database marker missing; reset refused.")
        # Refuse reset once any domain records or administrator have been provisioned.
        guard_sql = """do $$ declare t record; n bigint; begin
        if exists(select 1 from auth.users) then raise exception 'Auth data present; reset refused'; end if;
        if exists(select 1 from storage.buckets) then raise exception 'Storage data present; reset refused'; end if;
        if (select admin_user_id is not null or admin_habilitado from simpress.configuracao where id=1)
        then raise exception 'Administrator provisioned; reset refused'; end if;
        if (select revisao_global<>0 or lote_ativo_id is not null or modelo_transferencia_id is not null
          or modelo_exportacao_id is not null from simpress.estado_aplicacao where id=1)
        then raise exception 'Active state changed; reset refused'; end if;
        for t in select tablename from pg_tables where schemaname='simpress'
          and tablename not in ('configuracao','estado_aplicacao') loop
          execute format('select count(*) from simpress.%I',t.tablename) into n;
          if n<>0 then raise exception 'Domain data present; reset refused'; end if;
        end loop; end $$;"""
        run([docker, "exec", "-i", DB_CONTAINER, "psql", "-X", "-U", "postgres", "-d", "postgres",
             "-v", "ON_ERROR_STOP=1"], sql=guard_sql)
        run([*cli, "db", "reset", "--local", "--no-seed", "--yes", "--network-id", NETWORK, "--agent", "no"], timeout=600)
        check_db(docker)
        mark_disposable(docker)
        record_instance(docker)
        print("Disposable simpress-dev database rebuilt from migrations.")
    elif action == "validate":
        check_db(docker)
        sql = (ROOT / "supabase/tests/etapa_4.sql").read_text(encoding="utf-8")
        output = run([docker, "exec", "-i", DB_CONTAINER, "psql", "-X", "-q", "-t", "-A", "-U", "postgres", "-d", "postgres",
                      "-v", "ON_ERROR_STOP=1"], sql=sql)
        print(output.strip())
        check_api(cli)
    else:
        check_db(docker)
        print("simpress-dev identity, PostgreSQL version, network and loopback bindings verified.")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
