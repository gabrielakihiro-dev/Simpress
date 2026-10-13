"""Supabase Auth verification and encrypted, database-coordinated BFF sessions."""

import base64
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import secrets
from uuid import UUID

from cryptography.fernet import Fernet, InvalidToken
import httpx
import jwt
import psycopg
from psycopg_pool import PoolTimeout

from persistence.config import PersistenceError
from security.context import Principal

ABSOLUTE_LIFETIME = timedelta(hours=8)
IDLE_LIFETIME = timedelta(minutes=30)


def sha(value):
    return hashlib.sha256(value.encode()).hexdigest()


class AuthClient:
    def __init__(self, settings, *, transport=None):
        self.settings = settings
        self.client = httpx.Client(base_url=settings.auth_url+"/", headers={"apikey":settings.api_key},
            trust_env=False, follow_redirects=False, timeout=5, transport=transport)

    def close(self):
        self.client.close()

    def request(self, method, path, *, token=None, **kwargs):
        headers = {"Authorization":"Bearer "+token} if token else {}
        try:
            response = self.client.request(method,path,headers=headers,**kwargs)
        except httpx.HTTPError:
            raise PersistenceError(503,"O serviço de autenticação local está indisponível.") from None
        if response.status_code == 429:
            raise PersistenceError(429,"Muitas tentativas. Aguarde alguns minutos.")
        if response.status_code >= 500:
            raise PersistenceError(503,"O serviço de autenticação local está indisponível.")
        if response.status_code not in (200,201,204):
            raise PersistenceError(401,"Não foi possível validar as credenciais ou a sessão.")
        try:
            result = response.json() if response.content else {}
            if not isinstance(result,dict):
                raise ValueError
            return result
        except ValueError:
            raise PersistenceError(503,"Resposta inválida do serviço de autenticação.") from None

    def password(self, email, password):
        return self.token_response(self.request("POST","token",params={"grant_type":"password"},json={"email":email,"password":password}))

    def refresh(self, token):
        return self.token_response(self.request("POST","token",params={"grant_type":"refresh_token"},json={"refresh_token":token}))

    @staticmethod
    def token_response(response):
        if not all(isinstance(response.get(key),str) and response[key] for key in ("access_token","refresh_token")):
            raise PersistenceError(503,"Resposta inválida do serviço de autenticação.")
        return response

    def verify(self, token):
        # GET /user validates the JWT signature at Supabase Auth, including the
        # symmetric-key local stack. Only then inspect/validate required claims.
        user = self.request("GET","user",token=token)
        try:
            if jwt.get_unverified_header(token).get("alg") not in {"HS256","ES256","RS256"}:
                raise ValueError
            claims = jwt.decode(token,options={"verify_signature":False,"verify_exp":True,
                "verify_iat":True,"verify_nbf":True,"verify_aud":True,"verify_iss":True,
                "strict_aud":True,"require":["sub","session_id","exp","iat","iss","aud","role"]},
                audience="authenticated",issuer=self.settings.auth_url)
            uid,sid = str(UUID(claims["sub"])),str(UUID(claims["session_id"]))
            if (user.get("id") != uid or claims["role"] != "authenticated"
                    or user.get("is_anonymous") is True or claims.get("is_anonymous") is True
                    or type(claims["exp"]) is not int or type(claims["iat"]) is not int):
                raise ValueError
            expiry = datetime.fromtimestamp(claims["exp"],timezone.utc)
        except (jwt.PyJWTError,ValueError,TypeError,KeyError,OverflowError):
            raise PersistenceError(401,"A sessão de autenticação é inválida ou expirou.") from None
        return uid,sid,expiry

    def logout(self, token, *, all_sessions=False):
        self.request("POST","logout",token=token,params={"scope":"global" if all_sessions else "local"})


class AuthService:
    def __init__(self, backend, settings):
        settings.validate()
        self.backend,self.settings = backend,settings
        self.client = AuthClient(settings)
        self.cipher = Fernet(settings.session_key.encode("ascii"))
        self.signing_key = base64.urlsafe_b64decode(settings.session_key)

    def close(self):
        self.client.close()

    @contextmanager
    def gateway(self):
        try:
            with self.backend.pool.connection() as conn:
                with conn.transaction():
                    self.backend._check_login(conn,True)
                    conn.execute("set local role simpress_session_gateway")
                    conn.execute("set local search_path=pg_catalog,simpress_auth")
                    conn.execute("set local statement_timeout='5s'")
                    conn.execute("set local lock_timeout='10s'")
                    conn.execute("set local idle_in_transaction_session_timeout='30s'")
                    yield conn
        except (psycopg.Error,PoolTimeout):
            raise PersistenceError(503,"O armazenamento seguro de sessões está indisponível.") from None

    def open(self):
        provider = self.client.request("GET","settings")
        if provider.get("disable_signup") is not True or provider.get("external",{}).get("email") is not True:
            raise PersistenceError(503,"O Auth precisa permitir login por senha e bloquear cadastro público.")
        with self.gateway() as conn:
            conn.execute("select session_hash from simpress_auth.sessions limit 0")
            policies = conn.execute("""select count(*) as n from pg_policies where schemaname='storage'
                and policyname in ('simpress_backend_objects','simpress_backend_bucket') and permissive='RESTRICTIVE'""").fetchone()
            if policies["n"] != 2:
                raise PersistenceError(503,"A proteção do Storage da Etapa 7 não foi aplicada.")

    def prelogin(self, cookie=None):
        now = int(datetime.now(timezone.utc).timestamp())
        try:
            value,expires,signature = (cookie or "").split(".")
            expected = self.sign(value+"."+expires)
            valid = len(value) == 43 and now < int(expires) <= now+900 and hmac.compare_digest(signature,expected)
        except (ValueError,TypeError):
            valid = False
        if not valid:
            value,expires = secrets.token_urlsafe(32),str(now+900)
            cookie = value+"."+expires+"."+self.sign(value+"."+expires)
        return value,cookie

    def sign(self, value):
        return hmac.new(self.signing_key,("prelogin:"+self.settings.origin+":"+value).encode(),hashlib.sha256).hexdigest()

    def prelogin_valid(self, cookie, csrf):
        value,checked = self.prelogin(cookie)
        return bool(cookie and csrf and checked == cookie and hmac.compare_digest(value,csrf))

    def rate_limit(self, email, ip):
        with self.gateway() as conn:
            for value,maximum in (("ip:"+ip,20),("pair:"+ip+":"+email.casefold(),5)):
                key = hmac.new(self.signing_key,value.encode(),hashlib.sha256).hexdigest()
                row = conn.execute("""insert into simpress_auth.login_attempts(key_hash,attempts) values (%s,1)
                    on conflict(key_hash) do update set
                    attempts=case when simpress_auth.login_attempts.window_start<now()-interval '5 minutes' then 1 else simpress_auth.login_attempts.attempts+1 end,
                    window_start=case when simpress_auth.login_attempts.window_start<now()-interval '5 minutes' then now() else simpress_auth.login_attempts.window_start end
                    returning attempts""",(key,)).fetchone()
                if row["attempts"] > maximum:
                    # Exiting normally commits the counters even for a denial.
                    denied = True
                    break
            else:
                denied = False
        if denied:
            raise PersistenceError(429,"Muitas tentativas. Aguarde cinco minutos.")

    def encode(self, session_hash, uid, tokens):
        payload = {"binding":[session_hash,uid],"tokens":tokens}
        return self.cipher.encrypt(json.dumps(payload,separators=(",",":")).encode()).decode("ascii")

    def decode(self, row):
        try:
            payload = json.loads(self.cipher.decrypt(row["tokens_encrypted"].encode("ascii")))
            if payload["binding"] != [row["session_hash"],str(row["user_id"])]:
                raise ValueError
            tokens = payload["tokens"]
            if not isinstance(tokens,dict) or not all(isinstance(tokens.get(k),str) and tokens[k] for k in ("access","refresh","csrf")):
                raise ValueError
            return tokens
        except (InvalidToken,ValueError,KeyError,UnicodeError,TypeError):
            raise PersistenceError(401,"A sessão expirou. Entre novamente.") from None

    def login(self, email, password, ip, previous_cookie=None):
        self.rate_limit(email,ip)
        response = self.client.password(email,password)
        try:
            uid,sid,expiry = self.client.verify(response["access_token"])
            opaque,csrf = secrets.token_urlsafe(32),secrets.token_urlsafe(32)
            session_hash = sha(opaque)
            tokens = {"access":response["access_token"],"refresh":response["refresh_token"],"csrf":csrf}
            with self.gateway() as conn:
                allowed = conn.execute("select simpress_auth.allowed_identity(%s,%s) as allowed",(uid,sid)).fetchone()["allowed"]
                if not allowed:
                    raise PersistenceError(403,"Esta conta não tem acesso ao Simpress.")
                if previous_cookie:
                    conn.execute("update simpress_auth.sessions set revoked_at=now() where session_hash=%s",(sha(previous_cookie),))
                conn.execute("""insert into simpress_auth.sessions(session_hash,user_id,auth_session_id,tokens_encrypted,
                    csrf_hash,access_expires_at,expires_at) values (%s,%s,%s,%s,%s,%s,%s)""",
                    (session_hash,uid,sid,self.encode(session_hash,uid,tokens),sha(csrf),expiry,datetime.now(timezone.utc)+ABSOLUTE_LIFETIME))
            return opaque,{"enabled":True,"authenticated":True,"perfil":"administrador","csrf_token":csrf}
        except Exception:
            try:
                self.client.logout(response["access_token"])
            except (PersistenceError,KeyError):
                pass
            raise

    def load(self, opaque):
        if not opaque or len(opaque) != 43:
            raise PersistenceError(401,"Entre na sua conta para continuar.")
        session_hash = sha(opaque)
        with self.gateway() as conn:
            # Locks coordinate refresh rotation across independent processes.
            row = conn.execute("select * from simpress_auth.sessions where session_hash=%s for update",(session_hash,)).fetchone()
            now = datetime.now(timezone.utc)
            if (not row or row["revoked_at"] is not None or row["expires_at"] <= now or row["last_seen_at"] <= now-IDLE_LIFETIME):
                raise PersistenceError(401,"A sessão expirou. Entre novamente.")
            tokens = self.decode(row)
            if not isinstance(tokens.get("csrf"),str) or not hmac.compare_digest(sha(tokens["csrf"]),row["csrf_hash"]):
                raise PersistenceError(401,"A sessão é inválida. Entre novamente.")
            if row["access_expires_at"] <= now+timedelta(seconds=30):
                refreshed = self.client.refresh(tokens["refresh"])
                tokens.update(access=refreshed["access_token"],refresh=refreshed["refresh_token"])
            uid,sid,expiry = self.client.verify(tokens["access"])
            if uid != str(row["user_id"]) or sid != str(row["auth_session_id"]):
                raise PersistenceError(401,"A identidade da sessão é inválida.")
            allowed = conn.execute("select simpress_auth.allowed_identity(%s,%s) as allowed",(uid,sid)).fetchone()["allowed"]
            if not allowed:
                raise PersistenceError(403,"A conta ou sessão não tem acesso a esta instalação.")
            conn.execute("""update simpress_auth.sessions set tokens_encrypted=%s,access_expires_at=%s,last_seen_at=now()
                where session_hash=%s""",(self.encode(session_hash,uid,tokens),expiry,session_hash))
        return Principal(uid,sid,session_hash),tokens["csrf"]

    def logout(self, identity, all_sessions=False):
        with self.gateway() as conn:
            row = conn.execute("select * from simpress_auth.sessions where session_hash=%s for update",(identity.session_hash,)).fetchone()
            if row:
                if all_sessions:
                    conn.execute("update simpress_auth.sessions set revoked_at=now() where user_id=%s",(identity.user_id,))
                else:
                    conn.execute("update simpress_auth.sessions set revoked_at=now() where session_hash=%s",(identity.session_hash,))
        if row:
            try:
                self.client.logout(self.decode(row)["access"],all_sessions=all_sessions)
            except PersistenceError:
                # Local revocation is already durable and every domain policy
                # checks it. Do not undo logout on an unavailable Auth service.
                pass
