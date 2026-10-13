"""Stage-8 synthetic import, reconciliation, disaster recovery and rollback.

Creates separate uniquely named stacks, never queries/mutates simpress-dev data.
Encrypted recovery keys live only in this process; all accounts are fictional.
"""

import argparse
from contextlib import contextmanager
import io
import importlib
import json
from pathlib import Path
import secrets
import sys
import time
import traceback
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
import httpx
import openpyxl

from persistence.config import PersistenceSettings, PersistenceError
from persistence.migration import MigrationBundle
from persistence.postgres import PostgresBackend, canonical
from persistence.recovery import seal, restore, snapshot_digest
import persistence.recovery as recovery
from persistence.storage import LocalStorage
from scripts import supabase_local as local
from scripts.rehearsal_stack import RehearsalStack, WORKSPACE
from scripts.rehearsal_fixtures import generate
from scripts.verify_storage_pilot import inventory
from security.config import AuthSettings
from security.context import principal
import main as domain


def protected_metadata(docker):
    # Only container/volume identity, listener bindings and start timestamps;
    # never inspect application data or print container environment variables.
    return [{"id": c["Id"], "name": c["Name"], "started": c["State"]["StartedAt"],
             "ports": c["NetworkSettings"]["Ports"], "mounts": [(m.get("Name"), m["Destination"]) for m in c["Mounts"]]}
            for c in local.containers(docker)]


@contextmanager
def runtime(stack):
    password = secrets.token_hex(32)
    stack.sql("begin; create role simpress_runtime_login login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls"
              " connection limit 8 password '" + password + "'; grant simpress_runtime,simpress_session_gateway to simpress_runtime_login"
              " with inherit false,set true; grant connect on database postgres to simpress_runtime_login; commit;")
    auth = AuthSettings(True, auth_url="http://127.0.0.1:55421/auth/v1", api_key=stack.status["ANON_KEY"],
                        session_key=Fernet.generate_key().decode(), rehearsal=True)
    settings = PersistenceSettings("postgres", f"postgresql://simpress_runtime_login:{password}@127.0.0.1:55422/postgres",
                                   4, stack.status["SERVICE_ROLE_KEY"], True, True)
    backend = None
    try:
        with patch.object(domain, "AUTH_SETTINGS", auth), patch.object(domain, "PERSISTENCE_SETTINGS", settings):
            backend = PostgresBackend(settings, domain)
            backend.open()
            with patch.object(domain, "_POSTGRES_BACKEND", backend):
                yield backend, auth
    finally:
        if backend is not None:
            backend.close()
        stack.sql("begin; revoke connect on database postgres from simpress_runtime_login; drop role simpress_runtime_login; commit;")


def provision(stack):
    email, password = "stage8-" + secrets.token_hex(8) + "@example.com", secrets.token_urlsafe(32)
    key = stack.status["SERVICE_ROLE_KEY"]
    with httpx.Client(base_url="http://127.0.0.1:55421/auth/v1/", trust_env=False, follow_redirects=False,
                      timeout=15, headers={"apikey": key, "Authorization": "Bearer " + key}) as client:
        result = client.post("admin/users", json={"email": email, "password": password, "email_confirm": True})
        if result.status_code not in (200, 201):
            raise RuntimeError("Synthetic Auth provisioning failed; response suppressed")
        uid = result.json()["id"]
    with stack.connect_admin() as conn:
        conn.execute("update simpress.configuracao set admin_user_id=%s,admin_habilitado=true where id=1", (uid,))
    return uid, email, password


@contextmanager
def logged_in(backend, email, password):
    opaque, _ = backend.auth.login(email, password, "synthetic-stage8")
    identity, _ = backend.auth.load(opaque)
    token = principal.set(identity)
    try:
        yield opaque, identity
    finally:
        principal.reset(token)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local-disposable", action="store_true", required=True)
    parser.add_argument("--dry-run", action="store_true", help="Generate fixtures and an offline plan only")
    args = parser.parse_args()
    run_id = secrets.token_hex(6)
    fixture = generate(WORKSPACE / ("fixtures-" + run_id), domain)
    bundle = MigrationBundle(fixture, domain)
    plan = bundle.dry_run()
    (fixture / "dry-run.json").write_text(canonical(plan), encoding="utf-8")
    if args.dry_run:
        print("Dry-run sem banco/Storage:", fixture)
        print(canonical(plan))
        return
    _, docker = local.executables()
    protected = protected_metadata(docker)
    source = RehearsalStack(run_id, "source")
    target = RehearsalStack(run_id, "restore")
    rollback = RehearsalStack(run_id, "rollback")
    key = Fernet.generate_key()
    assertions: list[str] = []
    results = {"run_id": run_id, "synthetic": True, "plan": plan, "stacks": [], "assertions": assertions}
    success = False
    start = time.monotonic()

    def ok(condition, label):
        if not condition:
            print("FAIL:", label, flush=True)
            raise AssertionError(label)
        assertions.append(label)
        print("PASS:", label, flush=True)

    def refused(function, label, codes=(409, 422, 403, 401, 503)):
        try:
            function()
        except PersistenceError as error:
            ok(error.status_code in codes, label)
        else:
            raise AssertionError(label)

    try:
        print("Starting separate synthetic source", flush=True)
        source.start()
        results["stacks"].append(source.project)
        uid, email, password = provision(source)
        with runtime(source) as (backend, auth), logged_in(backend, email, password) as (old_cookie, identity):
            with source.connect_admin() as conn:
                before = snapshot_digest(conn)
            ok(bundle.dry_run() == plan and not plan["writes"], "dry-run is deterministic and has no writes")
            with source.connect_admin() as conn:
                ok(snapshot_digest(conn) == before, "dry-run leaves all 20 domain tables unchanged")
            original_put = backend.files.storage.put
            calls = 0
            def fail_upload(descriptor, data):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise PersistenceError(503, "Synthetic upload interruption")
                return original_put(descriptor, data)
            with patch.object(backend.files.storage, "put", side_effect=fail_upload):
                refused(lambda: bundle.apply(backend), "partial import is journaled and recoverable")
            ok(backend.state()["revision"] == 0, "partial upload does not activate inventory")
            imported = bundle.apply(backend)
            reconciliation = bundle.reconcile(backend)
            results["reconciliation"] = reconciliation
            ok(reconciliation["reconciled"], "official/source rows and immutable files reconcile")
            ok(reconciliation["equipment"] == 4 and plan["duplicate_serial_groups"] == 1, "duplicate official serials remain four distinct source records")
            with source.connect_admin() as conn:
                imported_digest = snapshot_digest(conn)
            ok(bundle.apply(backend) == imported, "reexecution returns all committed stage results")
            with source.connect_admin() as conn:
                ok(snapshot_digest(conn) == imported_digest, "idempotent reexecution changes no domain row")
                ok(conn.execute("select count(*) as n from simpress.operacoes where autor_user_id=%s", (uid,)).fetchone()["n"] > 0, "verified administrator authors preserved")
                ok(conn.execute("select horario is null as valid from simpress.eventos_comparacao where evento_id='legacy-integer'").fetchone()["valid"], "invalid original legacy date remains representable")
            cache = backend.state()["equipamentos_cache"]
            ok(any(e["apelido"] == "MANUAL-HOST" for e in cache.values()), "manual alias keeps precedence over Endpoint")
            ok(all(e["serial"] != "ENDPOINT-ONLY" for e in cache.values()), "auxiliary Endpoint does not add official equipment")
            snapshot_a = seal(backend.files, source, key)
            with source.connect_admin() as conn:
                digest_a = snapshot_digest(conn)
            refused(lambda: restore(snapshot_a, key, source, backend.files.storage), "recovery refuses populated source database")
            # Real HTTP responses, using synthetic credentials and BFF session only.
            client = TestClient(domain.app, base_url=auth.origin, client=("127.0.0.1", 1288))
            # Use the exported constant, independent from its literal spelling.
            from security.middleware import SESSION_COOKIE
            client.cookies.set(SESSION_COOKIE, old_cookie)
            try:
                ok(client.get("/api/exportar-equipamentos").status_code == 409, "equipment export refuses unresolved duplicate serials")
                history_export = client.get("/api/historico-comparacoes/exportar/excel", params={"data": "2026-01-15"})
                ok(history_export.status_code == 200, "history export is authorized for the requested day")
                history_book = openpyxl.load_workbook(io.BytesIO(history_export.content))
                ok(any(cell.value == "n" * 2000 for sheet in history_book for row in sheet for cell in row), "history download preserves the 2000-character SQL annotation")
                history_book.close()
                with backend.transaction(write=True) as conn:
                    for tag, row in (("integer", {"serie": "NUMERIC", "value": 1}), ("decimal", {"serie": "NUMERIC", "value": 1.0}),
                                     ("blank", {"serie": "BLANK"}), ("conflict", {"serie": "CONFLICT"})):
                        backend.files.history.insert(conn, {"id": "reapply-" + tag, "comparacao": {"sem_acesso_7_dias": [row]}}, reapply=True)
                    conn.execute("update simpress.estado_aplicacao set revisao_global=revisao_global+1 where id=1")
                with backend.transaction() as conn:
                    notes = {r["evento_id"]: r["texto"] for r in conn.execute("select evento_id,texto from simpress.anotacoes where evento_id like 'reapply-%%'").fetchall()}
                ok(notes == {"reapply-integer": "inteiro", "reapply-decimal": "decimal"}, "exact note carryover distinguishes numeric values and blocks blank/conflicting predecessors")
                clean = inventory("SYN-01", "NO-ENDPOINT")
                original_finish = backend.files.finish
                def lose_reply(*args):
                    original_finish(*args)
                    raise PersistenceError(503, "Synthetic lost commit reply")
                with patch.object(backend.files, "finish", side_effect=lose_reply):
                    refused(lambda: backend.files.update(clean, "stage8-clean"), "lost commit reply is handled without assuming rollback")
                clean_result = backend.files.update(clean, "stage8-clean")
                context = backend.files.restore_context(clean_result["comparacao"]["evento_id"])
                backend.files.restore(clean_result["comparacao"]["evento_id"], context["preview_token"], "stage8-logical-restore")
                ok(len(backend.state()["equipamentos_cache"]) >= 3, "logical rollback restores previous duplicate inventory")
                backend.files.update(clean, "stage8-clean-again")
                exported = client.get("/api/exportar-equipamentos")
                ok(exported.status_code == 200, "equipment export succeeds after explicit duplicate resolution")
                book = openpyxl.load_workbook(io.BytesIO(exported.content))
                ok(book.active["B2"].value == "MANUAL-HOST" and book["Metadados"]["A1"].value == "=1+1", "export preserves effective alias and unrelated formula")
                book.close()
                helpers = importlib.import_module("tests.test_integrity_workflows")
                response = client.post("/api/gerar-planilha", json=helpers.make_transfer_payload(serial="SYN-01").model_dump(), headers={"Origin": auth.origin, "X-CSRF-Token": backend.auth.load(old_cookie)[1]})
                ok(response.status_code == 200, "private transfer template produces an authorized download")
            finally:
                client.close()
            snapshot_b = seal(backend.files, source, key)
            with source.connect_admin() as conn:
                digest_b = snapshot_digest(conn)
                entity_counts = {t: conn.execute("select count(*) as n from simpress." + t).fetchone()["n"] for t in __import__('persistence.backup', fromlist=['TABLES']).TABLES}
            results["counts"] = entity_counts
        source.stop()
        print("Starting fresh recovery target", flush=True)
        target.start()
        results["stacks"].append(target.project)
        storage = LocalStorage(target.status["SERVICE_ROLE_KEY"], rehearsal=True)
        try:
            refused(lambda: restore(snapshot_b, Fernet.generate_key(), target, storage), "wrong encryption key changes no target data")
            original_put = storage.put
            calls = 0
            def fail_restore(descriptor, data):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise PersistenceError(503, "Synthetic recovery interruption")
                return original_put(descriptor, data)
            with patch.object(storage, "put", side_effect=fail_restore):
                refused(lambda: restore(snapshot_b, key, target, storage), "partial recovery upload keeps SQL unconfigured")
            with target.connect_admin() as conn:
                ok(conn.execute("select count(*) as n from auth.users").fetchone()["n"] == 0, "failed upload does not partially restore Auth")
            recovery_start = time.monotonic()
            original_receipt = recovery.write_receipt
            def lose_recovery_receipt(path, value):
                if value["state"] == "confirmed":
                    raise PersistenceError(503, "Synthetic lost recovery confirmation")
                original_receipt(path, value)
            with patch.object(recovery, "write_receipt", side_effect=lose_recovery_receipt):
                refused(lambda: restore(snapshot_b, key, target, storage), "recovery commit survives lost confirmation receipt")
            restored = restore(snapshot_b, key, target, storage)
            results["recovery_seconds"] = round(time.monotonic() - recovery_start, 3)
            ok(restored["replayed"], "recovery recognizes committed rows after lost confirmation")
            ok(restore(snapshot_b, key, target, storage)["replayed"], "recovery reexecution is idempotent")
            with target.connect_admin() as conn:
                ok(snapshot_digest(conn) == digest_b, "all 20 domain tables recover exactly, including authors and UUIDs")
                ok(conn.execute("select count(*) as n from simpress_auth.sessions").fetchone()["n"] == 0
                   and conn.execute("select count(*) as n from auth.sessions").fetchone()["n"] == 0, "neither app nor Auth sessions are restored")
                ok(conn.execute("select count(*) as n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('simpress','simpress_auth') and c.relkind='r' and c.relrowsecurity and c.relforcerowsecurity").fetchone()["n"] == 22, "all 22 recovered tables retain forced RLS")
            with runtime(target) as (backend, auth):
                refused(lambda: backend.auth.load(old_cookie), "old BFF cookie is rejected after service recovery")
                with logged_in(backend, email, password):
                    ok(backend.state()["equipamentos_cache"]["SYN-01"]["apelido"] == "MANUAL-HOST", "same account password logs in and recovered RLS grants work")
                    with backend.transaction() as conn:
                        for obj in conn.execute("select * from simpress.objetos_arquivo where estado='verificado'").fetchall():
                            storage.get(obj)
                    ok(True, "every recovered private object matches original bytes and hash")
        finally:
            storage.close()
        target.stop()
        print("Starting independent rollback target", flush=True)
        rollback.start()
        results["stacks"].append(rollback.project)
        storage = LocalStorage(rollback.status["SERVICE_ROLE_KEY"], rehearsal=True)
        try:
            restore(snapshot_a, key, rollback, storage)
            with rollback.connect_admin() as conn:
                ok(snapshot_digest(conn) == digest_a, "rollback recovers the earlier immutable recovery point exactly")
            with runtime(rollback) as (backend, auth), logged_in(backend, email, password):
                ok(len(backend.state()["equipamentos_cache"]) >= 3, "rollback account authenticates and sees earlier inventory")
        finally:
            storage.close()
        rollback.stop()
        ok(protected_metadata(docker) == protected, "simpress-dev container identities, starts, volumes and bindings remain unchanged")
        success = True
    finally:
        cleanup_errors = []
        for stack in (source, target, rollback):
            try:
                stack.stop()
            except Exception as error:
                cleanup_errors.append({"project": stack.project, "error_type": type(error).__name__})
        results["cleanup_errors"] = cleanup_errors
        results["validated"] = success and not cleanup_errors
        results["elapsed_seconds"] = round(time.monotonic() - start, 3)
        results["assertion_count"] = len(assertions)
        results["recovery_key_saved"] = False
        (fixture / "results.json").write_text(canonical(results), encoding="utf-8")
        if cleanup_errors:
            raise RuntimeError("Rehearsal cleanup incomplete; inspect synthetic project receipts")
    print("Stage 8:", len(assertions), "assertions; isolated stacks stopped, volumes preserved.", flush=True)
    print("Synthetic report:", fixture / "results.json", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Ensaio não concluído ({type(error).__name__}); dados e credenciais suprimidos.", file=sys.stderr)
        for frame in traceback.extract_tb(error.__traceback__):
            print(f"  {Path(frame.filename).name}:{frame.lineno} ({frame.name})", file=sys.stderr)
        sys.exit(1)
