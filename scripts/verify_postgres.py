"""Integration rehearsal in a NEW synthetic database in the checked local stack.

Never resets or seeds the primary database. The fixed temporary database name
must be absent; only the database created by this execution is dropped.
Auth.users is a minimal FK fixture here; this does NOT test Supabase Auth.
"""

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.run_postgres_pilot import admin_sql, checked_stack, create_login, drop_login
from persistence.config import PersistenceError, PersistenceSettings
from persistence.postgres import MARKER, PostgresBackend
import main as domain

DATABASE = "simpress_etapa5_validation"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local-disposable", action="store_true", required=True)
    parser.parse_args()
    _, docker = checked_stack()
    created, login, server, backend = False, False, None, None
    assertions = 0
    def ok(condition, label):
        nonlocal assertions
        if not condition:
            raise AssertionError(label)
        assertions += 1
        print("PASS:", label, flush=True)
    def sql(statement):
        return admin_sql(docker, statement, database=DATABASE)
    try:
        # CREATE DATABASE fails if present. Never adopt/drop an existing database.
        admin_sql(docker, f"create database {DATABASE} template template0;")
        created = True
        sql("create schema auth; create table auth.users(id uuid primary key);")
        for path in sorted((ROOT / "supabase/migrations").glob("*.sql")):
            sql(path.read_text(encoding="utf-8"))
        sql("comment on schema simpress is '" + MARKER + "';")
        password = create_login(docker)
        login = True
        url = f"postgresql://simpress_piloto_login:{password}@127.0.0.1:54322/{DATABASE}"
        # Constructor override is confined to this rehearsal; public env config
        # still rejects any database other than postgres.
        backend = PostgresBackend(PersistenceSettings("postgres", url, 2), domain)
        backend.open()
        ok(backend.state()["equipamentos_cache"] == {}, "empty DB has no implicit legacy import")
        unit = {"id": None, "cidade": "Cidade sintética", "endereco": "Rua teste", "uf": "PR", "cep": "00000-000", "cnpj": "00000000000000"}
        saved = backend.execute("unit", unit, "unit-1")
        ok(len(saved["unidades"]) == 1 and saved["unidades"][0]["id"] == 1, "catalog creation preserves numeric ID")
        revision = backend.state()["revision"]
        ok(saved == backend.execute("unit", unit, "unit-1") and backend.state()["revision"] == revision, "retry returns committed response without duplicate/revision bump")
        try:
            backend.execute("unit", {**unit, "cidade": "outro"}, "unit-1")
            raise AssertionError("idempotency mismatch accepted")
        except PersistenceError as error:
            ok(error.status_code == 409, "same key with different content rejected")
        # Fail AFTER DML but before COMMIT: both unit and revision must roll back.
        original = backend.project
        calls = 0
        def fail_after_dml(snapshot):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError("synthetic projection failure")
            return original(snapshot)
        with patch.object(backend, "project", side_effect=fail_after_dml):
            try:
                backend.execute("unit", {**unit, "cidade": "não confirmar"}, "rollback-1")
                raise AssertionError("projection failure ignored")
            except RuntimeError:
                pass
        ok(len(backend.state()["unidades_cache"]) == 1 and backend.state()["revision"] == revision, "precommit projection failure rolls back all changes")
        sql("""with op as (insert into simpress.operacoes(chave_idempotencia,tipo,estado)
            values ('synthetic-fixture','importacao_legada','confirmada') returning id),
            batch as (insert into simpress.lotes_inventario(operacao_id,estado,versao_parser)
            select id,'validado','synthetic-test-only' from op returning id)
            update simpress.estado_aplicacao set lote_ativo_id=(select id from batch) where id=1;""")
        # No fake XLSX/Storage provenance: manual equipment in a synthetic batch.
        def equipment(serial="SYNTHETIC-1", novo=True, **changes):
            p = domain.EquipamentoUpdatePayload(serial=serial, novo=novo, modelo="Modelo de teste", tipo="Notebook", **changes)
            return {"data": p.model_dump(), "fields": sorted(p.model_fields_set)}
        saved = backend.execute("equipment", equipment(apelido="BASE"), "equipment-1")
        ok(saved["equipamento"]["apelido"] == "BASE" and len(saved["equipamento"]["revisao"]) == 64, "equipment and API revision projected")
        before = saved["equipamento"]["revisao"]
        saved = backend.execute("equipment", equipment(novo=False, revisao=before, idCliente="000007"), "equipment-2")
        ok(saved["equipamento"]["idCliente"] == "000007", "text identifier keeps leading zeros")
        try:
            backend.execute("equipment", equipment(novo=False, revisao=before), "stale")
            raise AssertionError("stale edit accepted")
        except PersistenceError as error:
            ok(error.status_code == 409, "stale entity revision rejected")
        result = backend.execute("alias", {"serial": "SYNTHETIC-1", "apelido": ""}, "blank-alias")
        ok(result["equipamento"]["apelido"] == "", "empty manual alias preserved")
        event = backend.state()["history"][-1]
        result = backend.execute("undo", {"evento_id": event["id"]}, "undo-1")
        ok(result["equipamento"]["apelido"] == "BASE", "latest alias undo is atomic")
        last = backend.state()["history"][-1]
        result = backend.execute("delete_history", {"evento_id": last["id"]}, "delete-1")
        ok(result["equipamento"]["apelido"] == "" and all(e["id"] != last["id"] for e in backend.state()["history"]), "delete latest history restores prior alias")
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _: backend.execute("alias", {"serial": "SYNTHETIC-1", "apelido": "CONCURRENT"}, "concurrent-1"), range(2)))
        ok(results[0] == results[1] and sum(e["apelido_novo"] == "CONCURRENT" for e in backend.state()["history"]) == 1, "concurrent duplicate requests create one event")
        # An independent backend sees commits immediately, without stale global caches.
        other = PostgresBackend(PersistenceSettings("postgres", url, 1), domain)
        try:
            other.open()
            ok(other.state()["equipamentos_cache"]["SYNTHETIC-1"]["apelido"] == "CONCURRENT", "second backend reads latest committed state")
        finally:
            other.close()
        with backend.pool.connection() as conn:
            ok(conn.execute("select current_user as role,current_setting('simpress.piloto_local',true) as context").fetchone() == {"role": "simpress_piloto_login", "context": ""}, "pool does not leak transaction role/context")
            try:
                conn.execute("select * from simpress.configuracao")
                raise AssertionError("login inherited pilot grants")
            except Exception as error:
                import psycopg
                ok(isinstance(error, psycopg.errors.InsufficientPrivilege), "login has no inherited domain grants")
        # Client/runtime stay closed; stage 6 now permits annotations in pilot context.
        ok(sql("select has_schema_privilege('anon','simpress','usage') or has_schema_privilege('authenticated','simpress','usage');").strip() == "f", "client roles remain closed")
        ok(sql("begin; grant simpress_runtime to postgres with set true; set local role simpress_runtime; select count(*) from simpress.configuracao; rollback;").strip() == "0", "runtime without verified session sees no domain rows")
        with backend.transaction() as conn:
            ok(conn.execute("select count(*) as n from simpress.anotacoes").fetchone()["n"] == 0,
               "pilot reads SQL annotations only through its explicit local context")
        # Real HTTP smoke uses a child owned by this script, not a preexisting app.
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        # Public config is deliberately stricter; a test-only launcher supplies
        # the isolated DB settings to the same real FastAPI lifespan.
        env = os.environ.copy()
        env["SIMPRESS_TEST_DATABASE_URL"] = url
        launcher = "import os,main,uvicorn; from persistence.config import PersistenceSettings; main.PERSISTENCE_SETTINGS=PersistenceSettings('postgres',os.environ.pop('SIMPRESS_TEST_DATABASE_URL'),2); uvicorn.run(main.app,host='127.0.0.1',port=" + str(port) + ",log_level='error',proxy_headers=False)"
        server = subprocess.Popen([sys.executable, "-B", "-c", launcher], cwd=ROOT, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        def request(path, data=None, key=None):
            headers = {"Host": "127.0.0.1:8000"}
            if data is not None:
                headers["Content-Type"] = "application/json"
            if key:
                headers["Idempotency-Key"] = key
            req = urllib.request.Request(f"http://127.0.0.1:{port}"+path, data=json.dumps(data).encode() if data is not None else None, headers=headers)
            try:
                with opener.open(req, timeout=8) as response:
                    return response.status, json.loads(response.read())
            except urllib.error.HTTPError as error:
                return error.code, json.loads(error.read())
        deadline = time.monotonic()+15
        while True:
            try:
                status, stats = request("/api/stats")
                break
            except (OSError, urllib.error.URLError):
                if time.monotonic() >= deadline or server.poll() is not None:
                    raise RuntimeError("Synthetic FastAPI server failed to start; raw output suppressed") from None
                time.sleep(.2)
        ok(status == 200 and stats["total_equipamentos"] == 1, "HTTP stats uses PostgreSQL")
        status, found = request("/api/equipamento/SYNTHETIC-1")
        ok(status == 200 and found["apelido"] == "CONCURRENT", "HTTP equipment contract")
        status, search = request("/api/buscar?q=SYNTHETIC")
        ok(status == 200 and len(search) == 1, "HTTP search uses SQL snapshot")
        status, saved_http = request("/api/equipamento/atualizar-apelido", {"serial": "SYNTHETIC-1", "apelido": "HTTP"}, "http-alias-1")
        ok(status == 200 and saved_http["equipamento"]["apelido"] == "HTTP", "HTTP mutation commits to PostgreSQL")
        ok(request("/api/equipamento/atualizar-apelido", {"serial": "SYNTHETIC-1", "apelido": "HTTP"}, "http-alias-1")[1] == saved_http, "HTTP retry preserves Idempotency-Key")
        ok(request("/api/exportar-equipamentos")[0] == 409 and request("/api/historico-comparacoes")[0] == 200, "HTTP uses SQL history and requires a private export template")
        ok(request("/api/equipamento/salvar", {"serial": "", "novo": True})[0] == 422, "HTTP Pydantic validations preserved")
        ok(request("/api/equipamento/atualizar-apelido", {"serial": "SYNTHETIC-1", "apelido": "HTTP"}, "invalid key")[0] == 422,
           "HTTP rejects malformed idempotency keys")
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda i: backend.execute("unit", {**unit, "cidade": f"Concorrente {i}"}, f"distinct-{i}"), range(2)))
        ok(len(backend.state()["unidades_cache"]) == 3, "concurrent distinct unit writes both survive")
        sql("""insert into simpress.equipamentos_lote(lote_id,origem,serie_bruta,chave_api,serie_normalizada,contrato,modelo)
            select lote_ativo_id,'manual','SYNTHETIC-1','SYNTHETIC-1','SYNTHETIC1','16467','Duplicate synthetic' from simpress.estado_aplicacao where id=1;""")
        try:
            item = backend.state()["equipamentos_cache"]["SYNTHETIC-1"]
            backend.execute("equipment", equipment(novo=False, revisao=item["_revisao"]), "duplicate-serial")
            raise AssertionError("duplicate edit accepted")
        except PersistenceError as error:
            ok(error.status_code == 409, "duplicate normalized serial prevents equipment edit")
        sql("delete from simpress.equipamentos_lote where modelo='Duplicate synthetic';")
        try:
            backend.execute("undo", {"evento_id": event["id"]}, "stale-undo")
            raise AssertionError("old alias undo accepted")
        except PersistenceError as error:
            ok(error.status_code == 409, "old alias event cannot overwrite latest change")
        with backend.transaction(write=True) as conn:
            try:
                with conn.transaction():
                    conn.execute("update simpress.configuracao set admin_habilitado=false where id=1")
                raise AssertionError("administrative configuration write allowed")
            except Exception as error:
                import psycopg
                ok(isinstance(error, psycopg.errors.InsufficientPrivilege), "pilot cannot change administrative configuration")
        sql("insert into auth.users(id) values ('00000000-0000-0000-0000-000000000001'); update simpress.configuracao set admin_user_id='00000000-0000-0000-0000-000000000001' where id=1;")
        try:
            backend.state()
            raise AssertionError("provisioned installation accepted by unauthenticated pilot")
        except PersistenceError as error:
            ok(error.status_code == 503, "pilot refuses a provisioned administrator")
        sql("update simpress.configuracao set admin_user_id=null where id=1; delete from auth.users;")
        ok(backend.state()["equipamentos_cache"]["SYNTHETIC-1"]["apelido"] == "HTTP", "rejected operations preserve last committed equipment")
        print(f"PASS: {assertions} live PostgreSQL/HTTP assertions; synthetic database cleanup follows.", flush=True)
    finally:
        if server is not None:
            server.terminate()
            server.communicate(timeout=10)
        if backend is not None:
            backend.close()
        if created:
            # Fixed name, known to be created above; no forced disconnect/drop.
            admin_sql(docker, f"drop database {DATABASE};")
        if login:
            drop_login(docker)
        print("Owned synthetic resources cleaned; primary database preserved.", flush=True)


if __name__ == "__main__":
    main()
