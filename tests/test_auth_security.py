"""Synthetic Auth/HTTP boundary tests. No operational data or services."""
import base64
import importlib.util
from dataclasses import replace
from datetime import datetime,timezone
import secrets
import unittest
from unittest.mock import Mock,patch
from uuid import uuid4

import main
from persistence.config import PersistenceError,PersistenceSettings
from security.config import AuthSettings,validate_hosted
from security.context import Principal,principal
from security.middleware import same_origin,csrf_header

AUTH_DEPENDENCIES = all(importlib.util.find_spec(name) is not None for name in ('httpx','jwt','cryptography','psycopg','psycopg_pool'))
if AUTH_DEPENDENCIES:
    import httpx
    import jwt
    from fastapi.testclient import TestClient
    from security.auth import AuthClient,AuthService

@unittest.skipUnless(AUTH_DEPENDENCIES,'Optional PostgreSQL/Auth dependencies are not installed')
class AuthSecurityTests(unittest.TestCase):
    def settings(self):
        return AuthSettings(True,api_key=secrets.token_urlsafe(32),session_key=base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())

    def test_local_settings_and_secret_repr(self):
        cfg = self.settings()
        cfg.validate()
        self.assertNotIn(cfg.session_key,repr(cfg))
        self.assertNotIn(cfg.api_key,repr(cfg))
        for changes in ({"origin":"https://outside.example.org"},{"origin":"http://localhost:8000"},
                        {"origin":"http://127.0.0.1:8000/"},{"secure":True},{"session_key":"invalid"}):
            with self.subTest(changes=changes),self.assertRaises(PersistenceError):
                replace(cfg,**changes).validate()

    def test_unsafe_env_and_auth_without_postgres_rejected(self):
        with self.assertRaises(PersistenceError):
            AuthSettings.from_environment({"SIMPRESS_AUTH_ENABLED":"1"})
        for key,value in (("SIMPRESS_COOKIE_SECURE","1"),("SIMPRESS_PROXY_HEADERS","1"),("SIMPRESS_CORS_ORIGINS","*")):
            with self.assertRaises(PersistenceError):
                AuthSettings.from_environment({"SIMPRESS_AUTH_ENABLED":"1","SIMPRESS_PERSISTENCE_BACKEND":"postgres",key:value})

    def test_hosted_preflight_requires_tls_and_server_secrets(self):
        cfg = self.settings()
        env = {"SIMPRESS_PERSISTENCE_BACKEND":"postgres","SIMPRESS_APP_ORIGIN":"https://simpress.example.org","SIMPRESS_SUPABASE_URL":"https://project.supabase.co",
            "SIMPRESS_DATABASE_URL":"postgresql://simpress_runtime_login:synthetic@db.example.org:5432/postgres?sslmode=verify-full",
            "SIMPRESS_AUTH_ENABLED":"1","SIMPRESS_COOKIE_SECURE":"1","SIMPRESS_PROXY_HEADERS":"0",
            "SIMPRESS_SESSION_KEY":cfg.session_key,"SIMPRESS_AUTH_API_KEY":cfg.api_key,"SIMPRESS_STORAGE_SERVICE_KEY":cfg.api_key}
        validate_hosted(env)
        for key,value in (("SIMPRESS_COOKIE_SECURE","0"),("SIMPRESS_PROXY_HEADERS","1"),("SIMPRESS_CORS_ORIGINS","*"),
                          ("SIMPRESS_APP_ORIGIN","http://simpress.example.org"),("SIMPRESS_SESSION_KEY",""),
                          ("SIMPRESS_DATABASE_URL",env["SIMPRESS_DATABASE_URL"].replace("verify-full","require"))):
            with self.subTest(key=key),self.assertRaises(PersistenceError):
                validate_hosted({**env,key:value})

    def test_duplicate_or_missing_origin_host_csrf_denied(self):
        cfg = self.settings()
        headers = [(b"host",b"127.0.0.1:8000"),(b"origin",cfg.origin.encode())]
        same_origin({"method":"POST","headers":headers},cfg)
        for invalid in (headers[:1],headers+[headers[0]],headers+[headers[1]],[(b"host",b"outside.example.org")]):
            with self.assertRaises(PersistenceError):
                same_origin({"method":"POST","headers":invalid},cfg)
        for invalid in ([],[(b"x-csrf-token",b"short")],[(b"x-csrf-token",b"a"*43)]*2):
            with self.assertRaises(PersistenceError):
                csrf_header({"headers":invalid})

    def test_prelogin_signature_expiry_and_encrypted_binding(self):
        service = AuthService(Mock(),self.settings())
        try:
            csrf,cookie = service.prelogin()
            self.assertTrue(service.prelogin_valid(cookie,csrf))
            self.assertFalse(service.prelogin_valid(cookie,csrf+"x"))
            self.assertFalse(service.prelogin_valid(cookie+"x",csrf))
            self.assertFalse(service.prelogin_valid(cookie.replace(cookie.split('.')[1],'0'),csrf))
            uid,sid = str(uuid4()),secrets.token_hex(32)
            tokens = {"access":"synthetic-access","refresh":"synthetic-refresh","csrf":secrets.token_urlsafe(32)}
            encrypted = service.encode(sid,uid,tokens)
            row = {"session_hash":sid,"user_id":uid,"tokens_encrypted":encrypted}
            self.assertNotIn(tokens["access"],encrypted)
            self.assertEqual(service.decode(row),tokens)
            with self.assertRaises(PersistenceError):
                service.decode({**row,"user_id":str(uuid4())})
        finally:
            service.close()

    def test_jwt_is_inspected_only_after_server_verification(self):
        cfg = self.settings()
        uid,sid = str(uuid4()),str(uuid4())
        now = int(datetime.now(timezone.utc).timestamp())
        claims = {"sub":uid,"session_id":sid,"iss":cfg.auth_url,"aud":"authenticated","role":"authenticated","iat":now,"exp":now+60}
        token = jwt.encode(claims,secrets.token_bytes(32),algorithm="HS256")
        with AuthClientContext(cfg,lambda req:httpx.Response(200,json={"id":uid})) as client:
            self.assertEqual(client.verify(token)[:2],(uid,sid))
            for changed in ({"aud":"wrong"},{"iss":"wrong"},{"role":"service_role"},{"exp":now-10},{"session_id":"invalid"},{"is_anonymous":True}):
                with self.subTest(changed=changed),self.assertRaises(PersistenceError):
                    client.verify(jwt.encode({**claims,**changed},secrets.token_bytes(32),algorithm="HS256"))
        with AuthClientContext(cfg,lambda req:httpx.Response(401,json={"secret":"suppressed"})) as client:
            with patch("security.auth.jwt.decode") as decode,self.assertRaises(PersistenceError):
                client.verify(token)
            decode.assert_not_called()

    def test_network_failure_and_invalid_provider_json_fail_closed(self):
        def unavailable(req):
            raise httpx.ConnectError('synthetic unavailable')
        for transport in (unavailable,lambda req:httpx.Response(200,json=[])):
            with AuthClientContext(self.settings(),transport) as client,self.assertRaises(PersistenceError) as caught:
                client.verify("invalid")
            self.assertEqual(caught.exception.status_code,503)

    def test_http_boundary_all_routes_and_principal_cleanup(self):
        cfg = self.settings()
        service = Mock()
        service.load.side_effect = PersistenceError(401,"Entre novamente.")
        backend = Mock(auth=service)
        with patch.object(main,"AUTH_SETTINGS",cfg),patch.object(main,"_POSTGRES_BACKEND",backend),patch.object(main,"PERSISTENCE_SETTINGS",PersistenceSettings('postgres','synthetic')):
            client = TestClient(main.app,base_url=cfg.origin,client=("127.0.0.1",1234))
            for path in ('/api/stats','/api/historico-comparacoes','/api/exportar-equipamentos','/api/arquivos/invalid','/docs','/openapi.json','/unknown'):
                response = client.get(path)
                self.assertEqual(response.status_code,401,path)
                self.assertEqual(response.headers['cache-control'],'no-store')
                self.assertNotIn('access-control-allow-origin',response.headers)
            self.assertEqual(client.get('/',follow_redirects=False).status_code,303)
            self.assertEqual(client.get('/login').status_code,200)
            self.assertEqual(client.post('/api/auth/login',json={}).status_code,403)
            self.assertEqual(client.get('/login',headers={'Host':'outside.example.org'}).status_code,403)
            identity = Principal(str(uuid4()),str(uuid4()),secrets.token_hex(32))
            service.load.side_effect = None
            service.load.return_value = (identity,'a'*43)
            response = client.get('/unknown')
            self.assertEqual(response.status_code,404)
            self.assertIsNone(principal.get())
            self.assertEqual(client.post('/unknown',headers={'Origin':cfg.origin}).status_code,403)
            client.close()


class AuthClientContext:
    def __init__(self,cfg,handler):
        self.client = AuthClient(cfg,transport=httpx.MockTransport(handler))
    def __enter__(self): return self.client
    def __exit__(self,*args): self.client.close()
