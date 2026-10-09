"""Rehearse local Auth on an EMPTY marked disposable primary database only.

GoTrue uses the primary database. The initial guard rejects any existing user,
domain record, session, bucket or login. Cleanup removes only this run's fixtures;
never use this script against an installation with existing data.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import traceback
import time
from unittest.mock import patch
from uuid import UUID

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from cryptography.fernet import Fernet
import httpx
from fastapi.testclient import TestClient
from persistence.backup import TABLES,create,verify
from persistence.config import PersistenceSettings,PersistenceError
from persistence.postgres import PostgresBackend,canonical
from persistence.storage import LocalStorage,BUCKET
from scripts.run_postgres_pilot import checked_stack,admin_sql,create_runtime_login,drop_runtime_login
from scripts.verify_storage_pilot import inventory,xlsx
from scripts import supabase_local as local
from security.config import AuthSettings
from security.context import principal
from security.auth import sha
from security.middleware import SESSION_COOKIE
import main as domain


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--local-disposable',action='store_true',required=True)
    parser.add_argument('--browser',action='store_true',help='Also exercise the login in installed Chromium on loopback')
    args = parser.parse_args()
    cli,docker = checked_stack()
    def sql(statement): return admin_sql(docker,statement)
    sql("""do $$ declare t record; n bigint; begin
        if exists(select 1 from auth.users) or exists(select 1 from storage.buckets)
          or exists(select 1 from simpress_auth.sessions) or exists(select 1 from simpress_auth.login_attempts)
          or exists(select 1 from pg_roles where rolname in ('simpress_runtime_login','simpress_piloto_login'))
          then raise exception 'Existing users, storage, sessions or logins; rehearsal refused'; end if;
        if (select admin_user_id is not null or admin_habilitado from simpress.configuracao where id=1)
          or (select revisao_global<>0 or lote_ativo_id is not null or modelo_transferencia_id is not null
            or modelo_exportacao_id is not null from simpress.estado_aplicacao where id=1)
          then raise exception 'Existing administrator or state; rehearsal refused'; end if;
        for t in select tablename from pg_tables where schemaname='simpress'
          and tablename not in ('configuracao','estado_aplicacao') loop
          execute format('select count(*) from simpress.%I',t.tablename) into n;
          if n<>0 then raise exception 'Existing domain data; rehearsal refused'; end if;
        end loop; end $$;""")
    status = json.loads(local.run([*cli,'status','--output','json','--agent','no']))
    auth_admin = httpx.Client(base_url='http://127.0.0.1:54321/auth/v1/',trust_env=False,follow_redirects=False,
        timeout=10,headers={'apikey':status['SERVICE_ROLE_KEY'],'Authorization':'Bearer '+status['SERVICE_ROLE_KEY']})
    storage = LocalStorage(status['SERVICE_ROLE_KEY'])
    users = []
    backend = second = None
    login_created = False
    count = 0
    def ok(condition,label):
        nonlocal count
        if not condition: raise AssertionError(label)
        count += 1
        print('PASS:',label,flush=True)
    def denied(function,code,label):
        try:
            function()
        except PersistenceError as error:
            ok(error.status_code in (code if isinstance(code,tuple) else (code,)),label)
        else: raise AssertionError(label)
    def create_user(suffix):
        email = 'stage7-'+secrets.token_hex(8)+'-'+suffix+'@example.com'
        password = secrets.token_urlsafe(32)
        response = auth_admin.post('admin/users',json={'email':email,'password':password,'email_confirm':True})
        ok(response.status_code in (200,201),'synthetic '+suffix+' provisioned through Auth API')
        uid = str(UUID(response.json()['id']))
        users.append(uid)
        return uid,email,password
    try:
        uid,email,password = create_user('admin')
        other,other_email,other_password = create_user('unapproved')
        sql("update simpress.configuracao set admin_user_id='"+uid+"',admin_habilitado=true where id=1;")
        db_password = create_runtime_login(docker)
        login_created = True
        cfg = AuthSettings(True,api_key=status['ANON_KEY'],session_key=Fernet.generate_key().decode())
        settings = PersistenceSettings('postgres',f'postgresql://simpress_runtime_login:{db_password}@127.0.0.1:54322/postgres',4,status['SERVICE_ROLE_KEY'],True)
        with patch.object(domain,'AUTH_SETTINGS',cfg),patch.object(domain,'PERSISTENCE_SETTINGS',settings):
            backend = PostgresBackend(settings,domain)
            backend.open()
            second = PostgresBackend(settings,domain)
            second.open()
            with patch.object(domain,'_POSTGRES_BACKEND',backend):
                client = TestClient(domain.app,base_url=cfg.origin,client=('127.0.0.1',1234))
                anonymous = TestClient(domain.app,base_url=cfg.origin,client=('127.0.0.1',1235))
                try:
                    for path in ('/api/stats','/api/historico-comparacoes','/api/exportar-equipamentos','/api/historico-comparacoes/exportar/excel',
                                 '/api/arquivos/00000000-0000-0000-0000-000000000001','/api/piloto/operacoes','/docs','/openapi.json'):
                        ok(anonymous.get(path).status_code == 401,'anonymous blocked '+path)
                    ok(anonymous.get('/',follow_redirects=False).status_code == 303,'anonymous root redirects to login')
                    ok(client.get('/login').status_code == 200,'login page remains available')
                    signup = httpx.post('http://127.0.0.1:54321/auth/v1/signup',trust_env=False,
                        headers={'apikey':status['ANON_KEY']},json={'email':'stage7-signup@example.com','password':secrets.token_urlsafe(32)})
                    ok(signup.status_code in (400,422) and signup.json().get('error_code') == 'signup_disabled','direct Auth signup stays disabled while password login is enabled')
                    ok(anonymous.get('/api/stats',headers={'X-User-Id':uid,'Authorization':'Bearer forged'}).status_code == 401,'identity headers cannot replace a verified session')
                    challenge = client.get('/api/auth/session')
                    csrf = challenge.json()['csrf_token']
                    headers = {'Origin':cfg.origin,'X-CSRF-Token':csrf}
                    ok(client.post('/api/auth/login',json={'email':email,'password':password}).status_code == 403,'login requires same Origin')
                    ok(client.post('/api/auth/login',headers={'Origin':cfg.origin},json={'email':email,'password':password}).status_code == 403,'login requires signed prelogin CSRF')
                    bad = client.post('/api/auth/login',headers=headers,json={'email':email,'password':'wrong-synthetic'})
                    ok(bad.status_code == 401 and 'wrong-synthetic' not in bad.text,'wrong password denied without echo')
                    unapproved = client.post('/api/auth/login',headers=headers,json={'email':other_email,'password':other_password})
                    ok(unapproved.status_code == 403,'valid unapproved Auth account denied (HTTP '+str(unapproved.status_code)+')')
                    response = client.post('/api/auth/login',headers=headers,json={'email':email,'password':password})
                    ok(response.status_code == 200,'approved administrator login succeeds')
                    cookie = client.cookies[SESSION_COOKIE]
                    ok(len(cookie) == 43 and '.' not in cookie,'browser receives opaque cookie instead of JWT')
                    cookie_header = response.headers.get_list('set-cookie')[0].lower()
                    ok('httponly' in cookie_header and 'samesite=strict' in cookie_header and 'path=/' in cookie_header and 'secure' not in cookie_header,'local-only cookie flags enforced')
                    ok(not any(key in response.json() for key in ('access_token','refresh_token','password')),'Auth tokens absent from browser response')
                    headers = {'Origin':cfg.origin,'X-CSRF-Token':response.json()['csrf_token']}
                    for extra in ({},{'Origin':cfg.origin},{**headers,'X-CSRF-Token':'z'*43},{**headers,'Origin':'https://outside.example.org'}):
                        ok(client.post('/api/unidade/salvar',headers=extra,json={}).status_code == 403,'mutation rejected without valid origin and CSRF')
                    ok(client.get('/api/stats',headers={'Host':'outside.example.org'}).status_code == 403,'Host spoof rejected')
                    ok(client.get('/api/stats',headers={'Origin':'null'}).status_code == 403,'null Origin rejected')
                    response = client.get('/api/stats')
                    ok(response.status_code == 200 and response.headers['cache-control'] == 'no-store','administrator reads fresh authorized stats')
                    ok('access-control-allow-origin' not in response.headers and response.headers['x-frame-options'] == 'DENY','no CORS permission and framing denied')
                    staged = inventory('STAGE7-SYNTHETIC')
                    upload = client.post('/api/planilhas/atualizar',headers={**headers,'Idempotency-Key':'stage7-upload'},
                        files={'endpoint_file':(staged['endpoint']['name'],staged['endpoint']['bytes']),
                               'details_file':(staged['detalhes']['name'],staged['detalhes']['bytes'])})
                    ok(upload.status_code == 200,'administrator uploads synthetic inventory through protected backend (HTTP '+str(upload.status_code)+')')
                    identity,_ = backend.auth.load(cookie)
                    context = principal.set(identity)
                    try:
                        with backend.transaction() as conn:
                            source = conn.execute("select * from simpress.objetos_arquivo where chave like '%%/detalhes-%%'").fetchone()
                            authors = conn.execute('select autor_user_id from simpress.operacoes').fetchall()
                        ok(all(str(row['autor_user_id']) == uid for row in authors),'new operations record verified administrator identity')
                        ok(client.get('/api/arquivos/'+str(source['id'])).content == staged['detalhes']['bytes'],'authorized original download preserves bytes')
                        event_id = 'stage7-event'
                        backend.files.annotations('synthetic.json',canonical({'historico':[{'id':event_id,'horario':'2026-10-09T10:00:00',
                            'comparacao':{'sem_acesso_14_dias':[{'serie':'STAGE7-SYNTHETIC','motivo':'Fixture sintética'}]}}]}).encode(),'stage7-notes')
                        view = client.get('/api/historico-comparacoes/'+event_id).json()['evento']
                        note_id = view['comparacao']['sem_acesso_14_dias'][0]['anotacao_id']
                        note_url = '/api/historico-comparacoes/'+event_id+'/anotacoes/'+note_id
                        ok(client.put(note_url,headers=headers,json={'anotacao':'Autorizado'}).status_code == 200,'administrator edits event-bound annotation')
                        ok(anonymous.put(note_url,headers=headers,json={'anotacao':'Denied'}).status_code == 401,'anonymous annotation mutation denied')
                        ok(client.put(note_url,headers=headers,json={'anotacao':'x'*2001}).status_code == 422,'annotation limit preserved under Auth')
                        ok(client.get('/api/historico-comparacoes/exportar/excel',params={'data':'2026-10-09'}).status_code == 200,'protected history export succeeds')
                        model = xlsx(['NumeroSerie','Apelido','IdCliente'],[['STAGE7-SYNTHETIC','BASE','0001']],native=True)
                        ok(client.post('/api/piloto/modelos/exportacao',headers=headers,files={'upload':('synthetic.xlsx',model)}).status_code == 200,'administrator manages private template')
                        ok(client.get('/api/exportar-equipamentos').status_code == 200,'protected equipment export succeeds')
                        staged_second = inventory('STAGE7-SECOND')
                        second_upload = client.post('/api/planilhas/atualizar',headers={**headers,'Idempotency-Key':'stage7-second'},
                            files={'endpoint_file':(staged_second['endpoint']['name'],staged_second['endpoint']['bytes']),
                                   'details_file':(staged_second['detalhes']['name'],staged_second['detalhes']['bytes'])})
                        ok(second_upload.status_code == 200,'second authorized update creates a restorable history')
                        restore_url = '/api/historico-comparacoes/'+second_upload.json()['comparacao']['evento_id']
                        preview = client.get(restore_url+'/restauracao')
                        ok(preview.status_code == 200,'administrator obtains restoration preview')
                        preview_token = preview.json()['preview_token']
                        ok(anonymous.post(restore_url+'/restaurar',headers=headers,json={'preview_token':preview_token}).status_code == 401,'anonymous restore blocked')
                        restored = client.post(restore_url+'/restaurar',headers={**headers,'Idempotency-Key':'stage7-restore'},json={'preview_token':preview_token})
                        ok(restored.status_code == 200 and 'STAGE7-SYNTHETIC' in backend.state()['equipamentos_cache'],'administrator restores original logical inventory')
                        ok(client.get('/api/piloto/operacoes').status_code == 200,'administrator inspects operation journal')
                        with tempfile.TemporaryDirectory(prefix='stage7-backup-') as directory:
                            root = Path(directory)
                            migrations = root/'supabase/migrations'
                            migrations.mkdir(parents=True)
                            for path in (ROOT/'supabase/migrations').glob('*.sql'):
                                (migrations/path.name).write_bytes(path.read_bytes())
                            manifest = verify(create(backend.files,root))
                            ok(manifest['auth_reprovision_required'] and not manifest['auth_included'] and not manifest['sessions_included'],'authenticated domain backup explicitly excludes Auth recovery and sessions')
                    finally:
                        principal.reset(context)
                    denied(backend.state,401,'SQL backend refuses call without verified request context')
                    ok(sql("begin; grant simpress_runtime to postgres with set true; set local role simpress_runtime; select count(*) from simpress.equipamentos_lote; rollback;").strip() == '0','runtime with no identity cannot read domain rows')
                    ok(sql("begin; grant simpress_runtime to postgres with set true; set local role simpress_runtime; set local request.jwt.claim.sub='"+uid+"'; select count(*) from simpress.configuracao; rollback;").strip() == '0','forged user ID without both sessions cannot bypass RLS')
                    ok(sql("begin; grant simpress_piloto to postgres with set true; set local role simpress_piloto; set local simpress.piloto_local='on'; select count(*) from simpress.configuracao; rollback;").strip() == '0','legacy pilot flag cannot bypass provisioned administrator')
                    ok(sql("select not has_schema_privilege('anon','simpress','usage') and not has_schema_privilege('authenticated','simpress','usage') and not has_table_privilege('simpress_runtime','simpress_auth.sessions','select');").strip() == 't','browser SQL roles and runtime session-table access closed')
                    with backend.auth.gateway() as conn:
                        row = conn.execute('select * from simpress_auth.sessions where session_hash=%s',(sha(cookie),)).fetchone()
                        tokens = backend.auth.decode(row)
                    ok(tokens['access'] not in row['tokens_encrypted'] and tokens['refresh'] not in row['tokens_encrypted'],'database stores encrypted Auth tokens')
                    for key in (status['ANON_KEY'],tokens['access']):
                        direct = storage.client.get('object/'+BUCKET+'/'+source['chave'],headers={'apikey':status['ANON_KEY'],'Authorization':'Bearer '+key})
                        ok(direct.status_code != 200,'client JWT cannot directly download backend-only private Storage')
                    ok(storage.client.get('object/public/'+BUCKET+'/'+source['chave']).status_code != 200,'public Storage URL denied')
                    protected = sql("""begin;
                        create policy stage7_temporary_permissive on storage.objects for select to authenticated using(true);
                        set local role authenticated;
                        select count(*) from storage.objects where bucket_id='simpress-pilot'; rollback;""")
                    ok(protected.strip() == '0','restrictive Storage policy survives an unrelated permissive client policy')
                    sql("update simpress_auth.sessions set access_expires_at=now() where session_hash='"+sha(cookie)+"';")
                    with ThreadPoolExecutor(max_workers=2) as executor:
                        results = list(executor.map(lambda auth:auth.load(cookie),(backend.auth,second.auth)))
                    ok(all(result[0].user_id == uid for result in results),'two instances serialize token refresh and share verified session')
                    sql('update simpress.configuracao set admin_habilitado=false where id=1;')
                    ok(client.get('/api/stats').status_code == 403,'administrator deactivation blocks HTTP immediately')
                    context = principal.set(identity)
                    try: denied(backend.state,403,'deactivation blocks previously verified SQL context')
                    finally: principal.reset(context)
                    sql('update simpress.configuracao set admin_habilitado=true where id=1;')
                    with patch.object(backend.auth.client,'verify',side_effect=PersistenceError(503,'Auth indisponível.')):
                        ok(client.get('/api/stats').status_code == 503,'Auth unavailable fails closed without file fallback')
                    ok(client.post('/api/auth/logout',headers=headers).status_code == 200,'logout revokes current server session')
                    anonymous.cookies.set(SESSION_COOKIE,cookie)
                    ok(anonymous.get('/api/stats').status_code == 401,'revoked opaque cookie cannot be replayed')
                    cookie_a,_ = backend.auth.login(email,password,'isolated-synthetic-a')
                    cookie_b,_ = backend.auth.login(email,password,'isolated-synthetic-b')
                    identity_a,_ = backend.auth.load(cookie_a)
                    backend.auth.logout(identity_a,True)
                    denied(lambda:backend.auth.load(cookie_a),401,'global logout revokes initiating application session')
                    denied(lambda:backend.auth.load(cookie_b),401,'global logout revokes other instance application session')
                    cookie_c,_ = backend.auth.login(email,password,'isolated-synthetic-c')
                    identity_c,_ = backend.auth.load(cookie_c)
                    with backend.auth.gateway() as conn:
                        row = conn.execute('select * from simpress_auth.sessions where session_hash=%s',(sha(cookie_c),)).fetchone()
                        access = backend.auth.decode(row)['access']
                    backend.auth.client.logout(access)
                    denied(lambda:backend.auth.load(cookie_c),(401,403),'upstream Auth session deletion blocks application session')
                    context = principal.set(identity_c)
                    try: denied(backend.state,403,'upstream session deletion blocks SQL policy')
                    finally: principal.reset(context)
                    cookie_d,_ = backend.auth.login(email,password,'isolated-synthetic-d')
                    identity_d,_ = backend.auth.load(cookie_d)
                    with patch.object(backend.auth.client,'logout',side_effect=PersistenceError(503,'unavailable')):
                        backend.auth.logout(identity_d)
                    denied(lambda:backend.auth.load(cookie_d),401,'local logout stays durable when upstream Auth is unavailable')
                    cookie_e,_ = backend.auth.login(email,password,'isolated-synthetic-e')
                    sql("update simpress_auth.sessions set last_seen_at=now()-interval '31 minutes' where session_hash='"+sha(cookie_e)+"';")
                    denied(lambda:backend.auth.load(cookie_e),401,'idle timeout enforced server-side')
                    cookie_f,_ = backend.auth.login(email,password,'isolated-synthetic-f')
                    sql("update simpress_auth.sessions set created_at=now()-interval '9 hours',expires_at=now()-interval '1 hour' where session_hash='"+sha(cookie_f)+"';")
                    denied(lambda:backend.auth.load(cookie_f),401,'absolute session expiry enforced server-side')
                    for _ in range(5): backend.auth.rate_limit('synthetic-rate@example.invalid','synthetic-ip')
                    denied(lambda:backend.auth.rate_limit('synthetic-rate@example.invalid','synthetic-ip'),429,'shared DB rate limit blocks sixth attempt')
                    denied(lambda:second.auth.rate_limit('synthetic-rate@example.invalid','synthetic-ip'),429,'second instance cannot bypass rate limit')
                    ok(principal.get() is None,'request identity does not leak into another request')
                    if args.browser:
                        with socket.socket() as probe:
                            probe.bind(('127.0.0.1',8007))
                        env = os.environ.copy()
                        env.update(SIMPRESS_PERSISTENCE_BACKEND='postgres',SIMPRESS_POSTGRES_LOCAL_PILOT='1',
                            SIMPRESS_DATABASE_URL=settings.database_url,SIMPRESS_AUTH_ENABLED='1',SIMPRESS_PORT='8007',
                            SIMPRESS_APP_ORIGIN='http://127.0.0.1:8007',SIMPRESS_AUTH_API_KEY=cfg.api_key,
                            SIMPRESS_SESSION_KEY=cfg.session_key,SIMPRESS_STORAGE_SERVICE_KEY=status['SERVICE_ROLE_KEY'],
                            SIMPRESS_TEST_EMAIL=email,SIMPRESS_TEST_PASSWORD=password)
                        server = subprocess.Popen([sys.executable,'-B','-m','uvicorn','main:app','--host','127.0.0.1',
                            '--port','8007','--no-proxy-headers','--no-access-log','--log-level','warning'],env=env,cwd=ROOT,
                            stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                        try:
                            for _ in range(50):
                                if server.poll() is not None: raise RuntimeError('Browser fixture server failed to start')
                                try:
                                    if httpx.get('http://127.0.0.1:8007/login',trust_env=False,timeout=1).status_code == 200: break
                                except httpx.HTTPError: pass
                                time.sleep(.1)
                            result = subprocess.run(['node','tests/e2e/auth-local.cjs'],env=env,cwd=ROOT,
                                capture_output=True,timeout=60)
                            if result.returncode:
                                import re
                                match = re.search(rb'Local Auth browser assertion failed at step (\d+)',result.stderr)
                                if match: print('Browser fixture failed at step '+match[1].decode(),flush=True)
                            ok(result.returncode == 0,'Chromium login, dashboard, page reload and logout succeed on loopback')
                        finally:
                            server.terminate()
                            server.communicate(timeout=10)
                finally:
                    client.close()
                    anonymous.close()
    finally:
        if second: second.close()
        if backend: backend.close()
        if login_created: drop_runtime_login(docker)
        # Initial guard proved these schemas/bucket empty; all contents below
        # are synthetic fixtures owned by this run. Auth users are deleted by API.
        objects = json.loads(sql("select coalesce(json_agg(o),'[]'::json) from simpress.objetos_arquivo o;"))
        for descriptor in objects: storage.delete(descriptor)
        if not storage.not_found(storage.request('GET','bucket/'+BUCKET)):
            result = storage.request('DELETE','bucket/'+BUCKET)
            if result.status_code not in (200,204): raise RuntimeError('Synthetic bucket cleanup failed')
        sql('begin; truncate '+','.join('simpress.'+name for name in TABLES)+' restart identity; '
            'insert into simpress.configuracao(id) values(1); insert into simpress.estado_aplicacao(id) values(1); '
            'truncate simpress_auth.sessions,simpress_auth.login_attempts; commit;')
        for uid in users:
            response = auth_admin.delete('admin/users/'+uid)
            if response.status_code not in (200,204): raise RuntimeError('Synthetic Auth user cleanup failed')
        auth_admin.close()
        storage.close()
    ok(sql('select (select count(*) from auth.users)+(select count(*) from simpress_auth.sessions)+(select count(*) from storage.buckets);').strip() == '0','synthetic users, application sessions and Storage removed')
    print(f'PASS: {count} Stage 7 Auth, authorization, RLS, Storage and isolation assertions.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Do not emit HTTP headers, credentials or SQL containing encrypted data.
        label = str(error) if isinstance(error,AssertionError) else type(error).__name__
        print('Stage 7 rehearsal failed: '+label,file=sys.stderr)
        for frame in traceback.extract_tb(error.__traceback__):
            print(Path(frame.filename).name+':'+str(frame.lineno),file=sys.stderr)
        sys.exit(1)
