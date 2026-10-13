"""New, uniquely named local stacks for stage 8; never adopts simpress-dev."""

import ipaddress
import json
from pathlib import Path
import re
import shutil
import socket

import psycopg
from psycopg.rows import dict_row

from scripts import supabase_local as local
from persistence.postgres import MARKER

ROOT = local.ROOT
WORKSPACE = ROOT / "supabase/.temp/etapa8"
API_PORT, DB_PORT, SHADOW_PORT = 55421, 55422, 55420


class RehearsalStack:
    def __init__(self, run_id, suffix):
        if not re.fullmatch(r"[a-f0-9]{12}", run_id) or suffix not in {"source", "restore", "rollback"}:
            raise RuntimeError("Invalid rehearsal identity")
        self.project = f"simpress-rehearsal-{run_id}-{suffix}"
        self.root = WORKSPACE / self.project
        self.network = self.project + "-loopback"
        self.container = "supabase_db_" + self.project
        self.cli, self.docker = local.executables()
        self.started = False
        self.status = {}

    def command(self, *args, timeout=180):
        return local.run([*self.cli, "--workdir", str(self.root), *args], timeout=timeout)

    def containers(self):
        ids = local.run([self.docker, "ps", "-aq", "--filter", "name=_" + self.project]).split()
        if not ids:
            return []
        return [c for c in json.loads(local.run([self.docker, "inspect", *ids]))
                if c["Name"].lstrip("/").endswith("_" + self.project)]

    def check_identity(self, *, bindings=True):
        found = self.containers()
        if not found:
            raise RuntimeError("Rehearsal containers missing")
        for c in found:
            labels = c["Config"].get("Labels") or {}
            if (labels.get("com.supabase.cli.project") != self.project
                    or Path(labels.get("com.supabase.cli.workdir", "")) != self.root):
                raise RuntimeError("Rehearsal project/workdir differs")
            if bindings:
                if self.network not in c["NetworkSettings"]["Networks"]:
                    raise RuntimeError("Rehearsal network differs")
                for ports in (c["NetworkSettings"].get("Ports") or {}).values():
                    for port in ports or []:
                        if not ipaddress.ip_address(port["HostIp"]).is_loopback:
                            raise RuntimeError("Rehearsal published outside loopback")

    def sql(self, statement):
        self.check_identity()
        return local.run([self.docker, "exec", "-i", self.container, "psql", "-X", "-q", "-t", "-A",
                          "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"], sql=statement)

    def start(self):
        if self.root.exists() or self.containers():
            raise RuntimeError("Existing rehearsal workspace; adoption refused")
        volumes = local.run([self.docker, "volume", "ls", "--format", "{{.Name}}"]).splitlines()
        if any(v.endswith("_" + self.project) for v in volumes):
            raise RuntimeError("Existing rehearsal volumes; adoption refused")
        for port in (API_PORT, DB_PORT, SHADOW_PORT):
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", port))
        self.root.mkdir(parents=True)
        target = self.root / "supabase"
        target.mkdir()
        cfg = (ROOT / "supabase/config.toml").read_text(encoding="utf-8")
        cfg = cfg.replace('project_id = "simpress-dev"', f'project_id = "{self.project}"')
        cfg = cfg.replace("port = 54321", "port = 55421").replace("port = 54322", "port = 55422").replace("shadow_port = 54320", "shadow_port = 55420")
        (target / "config.toml").write_text(cfg, encoding="utf-8")
        shutil.copytree(ROOT / "supabase/migrations", target / "migrations")
        local.run([self.docker, "network", "create", "--driver", "bridge", "--label",
                   "com.simpress.purpose=stage8-rehearsal", "--opt",
                   "com.docker.network.bridge.host_binding_ipv4=127.0.0.1", self.network])
        self.started = True
        try:
            self.command("start", "--network-id", self.network, "--exclude", local.EXCLUDED, "--agent", "no", timeout=1800)
            self.check_identity()
            self.sql("comment on schema simpress is '" + MARKER + "'; create schema simpress_rehearsal;"
                     " revoke all on schema simpress_rehearsal from public,anon,authenticated,service_role;"
                     " comment on schema simpress_rehearsal is '" + self.project + "';")
            self.status = json.loads(self.command("status", "--output", "json", "--agent", "no"))
            (self.root / "receipt.json").write_text(json.dumps({"project": self.project, "ports": [API_PORT, DB_PORT],
                "synthetic": True, "volumes_preserved": True}), encoding="utf-8")
        except Exception:
            self.stop()
            raise

    def connect_admin(self):
        self.check_identity()
        conn = psycopg.connect(self.status["DB_URL"], host="127.0.0.1", hostaddr="127.0.0.1", port=DB_PORT,
                               dbname="postgres", user="postgres", options="", autocommit=True, row_factory=dict_row,
                               connect_timeout=5, application_name="simpress-stage8-rehearsal")
        self.guard(conn)
        return conn

    def guard(self, conn, *, empty=False):
        self.check_identity()
        marker = conn.execute("select obj_description('simpress_rehearsal'::regnamespace,'pg_namespace') as marker").fetchone()
        if not marker or marker["marker"] != self.project or conn.info.hostaddr != "127.0.0.1" or conn.info.port != DB_PORT:
            raise RuntimeError("Administrative recovery requires this run's separate rehearsal")
        if empty:
            for schema, table in [("auth", "users"), ("storage", "buckets"), ("simpress_auth", "sessions")]:
                from psycopg import sql
                if conn.execute(sql.SQL("select count(*) as n from {}.{}").format(sql.Identifier(schema), sql.Identifier(table))).fetchone()["n"]:
                    raise RuntimeError("Recovery target already used")
            if conn.execute("select revisao_global as n from simpress.estado_aplicacao where id=1").fetchone()["n"]:
                raise RuntimeError("Recovery target state already used")

    def stop(self):
        if self.started:
            if self.containers():
                self.check_identity(bindings=False)
            self.command("stop", "--project-id", self.project, timeout=180)
            self.started = False
