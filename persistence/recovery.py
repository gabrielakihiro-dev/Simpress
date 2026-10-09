"""Encrypted recovery rehearsal for the approved single email/password account.

Only a newly created RehearsalStack can supply the administrative connection.
Sessions, refresh tokens, reset challenges and infrastructure keys are excluded.
"""

from contextlib import contextmanager
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import zipfile

from cryptography.fernet import Fernet, InvalidToken
from psycopg import sql

from persistence.backup import TABLES, create, verify
from persistence.config import PersistenceError
from persistence.files import ready
from persistence.postgres import canonical

ORDER = ("operacoes", "objetos_arquivo", "arquivos_origem", "lotes_inventario", "unidades_catalogo",
         "unidades_customizadas", "fontes_lote", "linhas_fonte", "equipamentos_lote", "apelidos_manuais",
         "historico_apelidos", "backups_logicos", "eventos_comparacao", "linhas_comparacao", "anotacoes",
         "pendencias_sincronizacao", "referencias_backup", "conflitos_importacao", "configuracao", "estado_aplicacao")
AUTH_TABLES = ("users", "identities")
FORMAT = "simpress-recovery-email-v1"
MAX_ARCHIVE = 256 * 1024 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


def schema_signature(conn):
    rows = conn.execute("""select table_schema,table_name,column_name,data_type,udt_name,is_generated,is_identity
        from information_schema.columns where (table_schema='simpress' or
        (table_schema='auth' and table_name in ('users','identities')))
        order by table_schema,table_name,ordinal_position""").fetchall()
    return digest(canonical(ready(rows)).encode())


def seal(files, stack, key):
    if not files.backend.rehearsal or not files.backend.authenticated:
        raise PersistenceError(403, "Backup integral restrito ao ensaio autenticado separado.")
    cipher = Fernet(key)
    with stack.connect_admin() as conn:
        stack.guard(conn)
        with conn.transaction():
            conn.execute("lock table simpress.estado_aplicacao,auth.users,auth.identities in share mode")
            if conn.execute("select count(*) as n from auth.users").fetchone()["n"] != 1:
                raise PersistenceError(409, "O formato de recuperação exige exatamente a conta única aprovada.")
            if conn.execute("select count(*) as n from auth.identities where provider<>'email'").fetchone()["n"]:
                raise PersistenceError(409, "Provedor Auth fora do modelo aprovado.")
            if conn.execute("select count(*) as n from auth.mfa_factors").fetchone()["n"]:
                raise PersistenceError(409, "MFA exige outro formato de recuperação.")
            auth = {name: ready(conn.execute(sql.SQL("select * from auth.{}").format(sql.Identifier(name))).fetchall()) for name in AUTH_TABLES}
            if (len(auth["identities"]) != 1 or auth["identities"][0]["user_id"] != auth["users"][0]["id"]
                    or auth["users"][0].get("is_anonymous")):
                raise PersistenceError(409, "Identidade única de e-mail ausente ou incompatível.")
            for user in auth["users"]:
                # Preserve UUID and password hash, never pending credential changes.
                for field in ("confirmation_token", "recovery_token", "email_change_token_new", "email_change_token_current",
                              "phone_change_token", "reauthentication_token", "email_change", "phone_change"):
                    if field in user:
                        user[field] = ""
                if "email_change_confirm_status" in user:
                    user["email_change_confirm_status"] = 0
            domain_path = create(files, stack.root)
            domain_manifest = verify(domain_path)
            content = {"domain.zip": domain_path.read_bytes(), "auth.json": canonical(auth).encode()}
            metadata = {"format": FORMAT, "synthetic": True, "sessions_included": False, "auth_included": True,
                        "schema_signature": schema_signature(conn), "revision": domain_manifest["revision"],
                        "files": {n: {"sha256": digest(b), "size": len(b)} for n, b in content.items()}}
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in content.items():
            archive.writestr(name, data)
        archive.writestr("manifest.json", canonical(metadata))
    directory = stack.root / "Backup_Banco"
    target = directory / (digest(output.getvalue()) + ".recovery.enc")
    encrypted = cipher.encrypt(output.getvalue())
    # Exclusive creation: never overwrite an earlier recovery point.
    with target.open("xb") as stream:
        stream.write(encrypted)
        stream.flush()
        os.fsync(stream.fileno())
    return target


@contextmanager
def opened(path, key, stack):
    path = Path(path)
    if not 0 < path.stat().st_size <= MAX_ARCHIVE:
        raise PersistenceError(409, "Arquivo de recuperação fora do limite.")
    try:
        data = Fernet(key).decrypt(path.read_bytes())
    except (InvalidToken, ValueError, TypeError):
        raise PersistenceError(409, "Chave incorreta ou arquivo de recuperação adulterado.") from None
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            if sorted(archive.namelist()) != ["auth.json", "domain.zip", "manifest.json"]:
                raise PersistenceError(409, "Entradas de recuperação inválidas.")
            if sum(item.file_size for item in archive.infolist()) > MAX_ARCHIVE:
                raise PersistenceError(409, "Conteúdo de recuperação acima do limite.")
            manifest = json.loads(archive.read("manifest.json"))
            if (manifest.get("format") != FORMAT or manifest.get("synthetic") is not True
                    or manifest.get("sessions_included") is not False or manifest.get("auth_included") is not True):
                raise PersistenceError(409, "Formato de recuperação não aprovado.")
            for name in ("auth.json", "domain.zip"):
                content = archive.read(name)
                entry = manifest["files"][name]
                if entry["sha256"] != digest(content) or entry["size"] != len(content):
                    raise PersistenceError(409, "Hash de recuperação divergente.")
            auth = json.loads(archive.read("auth.json"))
            if set(auth) != set(AUTH_TABLES) or len(auth["users"]) != 1:
                raise PersistenceError(409, "Identidades fora do modelo de recuperação.")
            handle, temporary = tempfile.mkstemp(dir=stack.root, suffix=".domain.zip")
            os.close(handle)
            try:
                Path(temporary).write_bytes(archive.read("domain.zip"))
                with zipfile.ZipFile(temporary) as check:
                    if sum(item.file_size for item in check.infolist()) > MAX_ARCHIVE:
                        raise PersistenceError(409, "Backup expandido acima do limite.")
                verify(temporary)
                with zipfile.ZipFile(temporary) as domain_archive:
                    domain = json.loads(domain_archive.read("domain.json"))
                    migrations = {n.removeprefix("migrations/"): digest(domain_archive.read(n))
                                  for n in domain_archive.namelist() if n.startswith("migrations/")}
                    expected = {p.name: digest(p.read_bytes()) for p in (stack.root / "supabase/migrations").glob("*.sql")}
                    if migrations != expected:
                        raise PersistenceError(409, "Migrations do destino diferem do backup.")
                    yield manifest, domain, auth, domain_archive
            finally:
                Path(temporary).unlink(missing_ok=True)
    except (KeyError, ValueError, TypeError, zipfile.BadZipFile):
        raise PersistenceError(409, "Estrutura de recuperação inválida.") from None


def insert_rows(conn, schema, table, rows):
    columns = conn.execute("""select column_name from information_schema.columns
        where table_schema=%s and table_name=%s and is_generated='NEVER' order by ordinal_position""", (schema, table)).fetchall()
    fields = [c["column_name"] for c in columns]
    names = sql.SQL(",").join(map(sql.Identifier, fields))
    statement = sql.SQL("insert into {}.{} ({}) overriding system value select {} from json_populate_record(null::{}.{},%s::json)").format(
        sql.Identifier(schema), sql.Identifier(table), names, names, sql.Identifier(schema), sql.Identifier(table))
    # Resolve the three supported self-references without disabling FKs.
    parent, identity = {"lotes_inventario": ("anterior_id", "id"), "historico_apelidos": ("referencia_evento_id", "evento_id"),
                        "eventos_comparacao": ("restauracao_de_evento_id", "evento_id")}.get(table, (None, None))
    pending, inserted = list(rows), set()
    while pending:
        progressed = False
        for row in pending[:]:
            if parent and row.get(parent) and row[parent] not in inserted:
                continue
            conn.execute(statement, (canonical(row),))
            if identity:
                inserted.add(row[identity])
            pending.remove(row)
            progressed = True
        if not progressed:
            raise PersistenceError(409, "Referência cíclica ou ausente no backup.")


def write_receipt(path, value):
    handle, temporary = tempfile.mkstemp(dir=path.parent, prefix=".recovery-")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(canonical(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def domain_digest(snapshot):
    return digest(canonical({t: sorted(ready(snapshot[t]), key=canonical) for t in TABLES}).encode())


def require_empty(conn):
    for table in TABLES:
        count = conn.execute(sql.SQL("select count(*) as n from simpress.{}").format(sql.Identifier(table))).fetchone()["n"]
        if count != (1 if table in {"configuracao", "estado_aplicacao"} else 0):
            raise PersistenceError(409, "Recuperação exige domínio vazio; dados existentes preservados.")
    cfg = conn.execute("select * from simpress.configuracao where id=1").fetchone()
    state = conn.execute("select * from simpress.estado_aplicacao where id=1").fetchone()
    if cfg["admin_user_id"] or cfg["admin_habilitado"] or state["revisao_global"] or state["lote_ativo_id"]:
        raise PersistenceError(409, "Destino já configurado; recuperação recusada.")
    for schema, table in (("auth", "users"), ("auth", "identities"), ("auth", "sessions"), ("simpress_auth", "sessions"), ("simpress_auth", "login_attempts")):
        if conn.execute(sql.SQL("select count(*) as n from {}.{}").format(sql.Identifier(schema), sql.Identifier(table))).fetchone()["n"]:
            raise PersistenceError(409, "Destino contém identidade ou sessão; recuperação recusada.")


def verify_restored(conn, domain, auth, storage):
    if snapshot_digest(conn) != domain_digest(domain):
        raise PersistenceError(409, "O domínio do destino difere do ponto de recuperação.")
    for table in AUTH_TABLES:
        actual = ready(conn.execute(sql.SQL("select * from auth.{}").format(sql.Identifier(table))).fetchall())
        if sorted(actual, key=canonical) != sorted(auth[table], key=canonical):
            raise PersistenceError(409, "A identidade do destino difere do ponto de recuperação.")
    expected = {o["chave"] for o in domain["objetos_arquivo"] if o["estado"] == "verificado"}
    live = conn.execute("select name,bucket_id from storage.objects").fetchall()
    buckets = conn.execute("select id,public from storage.buckets").fetchall()
    if len(buckets) != 1 or buckets[0]["id"] != "simpress-pilot" or buckets[0]["public"]:
        raise PersistenceError(409, "Bucket recuperado deve permanecer privado e exclusivo.")
    if {o["name"] for o in live} != expected or any(o["bucket_id"] != "simpress-pilot" for o in live):
        raise PersistenceError(409, "Objetos do destino diferem do ponto de recuperação.")
    for obj in domain["objetos_arquivo"]:
        if obj["estado"] == "verificado":
            storage.get(obj)


def restore(path, key, stack, storage):
    if not 0 < Path(path).stat().st_size <= MAX_ARCHIVE:
        raise PersistenceError(409, "Arquivo de recuperação fora do limite.")
    fingerprint = digest(Path(path).read_bytes())
    receipt_path = stack.root / "recovery-receipt.json"
    receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else None
    if receipt and receipt["fingerprint"] != fingerprint:
        raise PersistenceError(409, "O destino já pertence a outro ponto de recuperação.")
    with opened(path, key, stack) as (manifest, domain, auth, archive), stack.connect_admin() as conn:
        stack.guard(conn)
        if schema_signature(conn) != manifest["schema_signature"]:
            raise PersistenceError(409, "Versão das tabelas Auth/domínio difere do backup.")
        # A matching uploading receipt may follow a successful COMMIT whose
        # reply/receipt was lost. Prove every row, identity and byte before reuse.
        if receipt and (receipt["state"] == "confirmed" or snapshot_digest(conn) == domain_digest(domain)):
            verify_restored(conn, domain, auth, storage)
            write_receipt(receipt_path, {"fingerprint": fingerprint, "state": "confirmed", "domain_digest": domain_digest(domain)})
            return {"replayed": True, "revision": manifest["revision"]}
        require_empty(conn)
        buckets = conn.execute("select id from storage.buckets").fetchall()
        expected_objects = {o["chave"] for o in domain["objetos_arquivo"] if o["estado"] == "verificado"}
        if buckets and (not receipt or {b["id"] for b in buckets} != {"simpress-pilot"}):
            raise PersistenceError(409, "Destino contém Storage anterior; recuperação recusada.")
        live_objects = conn.execute("select name,bucket_id from storage.objects").fetchall()
        if any(o["name"] not in expected_objects or o["bucket_id"] != "simpress-pilot" for o in live_objects):
            raise PersistenceError(409, "Objeto alheio encontrado no destino; recuperação recusada.")
        write_receipt(receipt_path, {"fingerprint": fingerprint, "state": "uploading"})
        storage.ensure_private_bucket()
        for obj in domain["objetos_arquivo"]:
            if obj["estado"] == "verificado":
                storage.put(obj, archive.read("objects/" + obj["id"]))
        # All FKs, checks, RLS configuration and triggers remain enabled.
        with conn.transaction():
            tables: list[sql.Composable] = [sql.SQL("simpress.{}").format(sql.Identifier(t)) for t in TABLES]
            tables += [sql.SQL("auth.users"), sql.SQL("auth.identities")]
            conn.execute(sql.SQL("lock table {} in share row exclusive mode").format(sql.SQL(",").join(tables)))
            require_empty(conn)
            conn.execute("delete from simpress.estado_aplicacao; delete from simpress.configuracao")
            for table in AUTH_TABLES:
                insert_rows(conn, "auth", table, auth[table])
            for table in ORDER:
                insert_rows(conn, "simpress", table, domain[table])
            sequences = conn.execute("""select table_name,column_name,pg_get_serial_sequence('simpress.'||quote_ident(table_name),column_name) as sequence
                from information_schema.columns where table_schema='simpress' and is_identity='YES'""").fetchall()
            for seq in sequences:
                maximum = conn.execute(sql.SQL("select max({}) as n from simpress.{}").format(sql.Identifier(seq["column_name"]), sql.Identifier(seq["table_name"]))).fetchone()["n"]
                conn.execute("select setval(%s::regclass,%s,%s)", (seq["sequence"], maximum or 1, maximum is not None))
        verify_restored(conn, domain, auth, storage)
        write_receipt(receipt_path, {"fingerprint": fingerprint, "state": "confirmed", "domain_digest": snapshot_digest(conn)})
        return {"replayed": False, "revision": manifest["revision"]}


def snapshot_digest(conn):
    snapshot = {}
    for table in TABLES:
        rows = ready(conn.execute(sql.SQL("select * from simpress.{}").format(sql.Identifier(table))).fetchall())
        snapshot[table] = sorted(rows, key=canonical)
    return domain_digest(snapshot)
