"""Secrets are supplied by the server; local HTTP exceptions require loopback."""

import base64
from dataclasses import dataclass, field
import ipaddress
import os
from urllib.parse import urlsplit

from persistence.config import PersistenceError


@dataclass(frozen=True)
class AuthSettings:
    enabled: bool = False
    origin: str = "http://127.0.0.1:8000"
    auth_url: str = "http://127.0.0.1:54321/auth/v1"
    api_key: str = field(default="", repr=False)
    session_key: str = field(default="", repr=False)
    secure: bool = False

    @classmethod
    def from_environment(cls, env=None):
        env = os.environ if env is None else env
        flag = env.get("SIMPRESS_AUTH_ENABLED", "0")
        if flag not in {"0", "1"}:
            raise PersistenceError(503, "Configuração de autenticação inválida.")
        if flag == "0":
            return cls()
        if env.get("SIMPRESS_PERSISTENCE_BACKEND") != "postgres":
            raise PersistenceError(503, "A autenticação exige o backend PostgreSQL.")
        if (env.get("SIMPRESS_COOKIE_SECURE","0") != "0" or env.get("SIMPRESS_PROXY_HEADERS","0") != "0"
                or env.get("SIMPRESS_CORS_ORIGINS","") != ""):
            raise PersistenceError(503,"O piloto aceita somente HTTP local, sem proxy ou CORS externo.")
        settings = cls(True, env.get("SIMPRESS_APP_ORIGIN", "http://127.0.0.1:8000"),
            api_key=env.get("SIMPRESS_AUTH_API_KEY", ""), session_key=env.get("SIMPRESS_SESSION_KEY", ""))
        settings.validate()
        return settings

    def validate(self):
        try:
            url = urlsplit(self.origin)
            valid = (url.scheme == "http" and url.hostname == "127.0.0.1"
                and url.port is not None and 8000 <= url.port <= 8099
                and not url.username and not url.password and not url.path and not url.query and not url.fragment
                and self.auth_url == "http://127.0.0.1:54321/auth/v1" and not self.secure)
            key = base64.urlsafe_b64decode(self.session_key.encode("ascii"))
            valid = valid and len(key) == 32 and len(self.session_key) == 44
            valid = valid and bool(self.api_key) and self.api_key.isascii() and not any(c.isspace() for c in self.api_key)
        except (ValueError, UnicodeError):
            valid = False
        if not valid:
            raise PersistenceError(503, "Credenciais ou origem inválidas para o Auth local.")


def validate_hosted(env):
    """Read-only deployment preflight; this does not enable remote runtime access."""
    try:
        origin = urlsplit(env["SIMPRESS_APP_ORIGIN"])
        provider = urlsplit(env["SIMPRESS_SUPABASE_URL"])
        database = urlsplit(env["SIMPRESS_DATABASE_URL"])
        valid = (origin.scheme == provider.scheme == "https" and bool(origin.hostname) and bool(provider.hostname)
            and not origin.path and not origin.query and not origin.fragment and not origin.username
            and not provider.path and not provider.query and not provider.fragment and not provider.username
            and origin.port in (None,443) and provider.port in (None,443)
            and database.scheme in {"postgres","postgresql"} and bool(database.hostname) and bool(database.password)
            and database.username == "simpress_runtime_login" and not database.fragment
            and database.query == "sslmode=verify-full"
            and env.get("SIMPRESS_PERSISTENCE_BACKEND") == "postgres"
            and env.get("SIMPRESS_AUTH_ENABLED") == "1" and env.get("SIMPRESS_COOKIE_SECURE") == "1"
            and env.get("SIMPRESS_PROXY_HEADERS") == "0" and env.get("SIMPRESS_CORS_ORIGINS", "") == "")
        for host in (origin.hostname, provider.hostname, database.hostname):
            if not host or host == "localhost" or "*" in host or host.endswith(".example.invalid"):
                valid = False
            try:
                if host and not ipaddress.ip_address(host).is_global:
                    valid = False
            except ValueError:
                pass
        key = base64.urlsafe_b64decode(env["SIMPRESS_SESSION_KEY"])
        valid = valid and len(key) == 32 and len(env["SIMPRESS_SESSION_KEY"]) == 44
        valid = valid and all(env.get(k) and not env[k].startswith("EXAMPLE") for k in ("SIMPRESS_AUTH_API_KEY","SIMPRESS_STORAGE_SERVICE_KEY"))
    except (KeyError,ValueError,UnicodeError):
        valid = False
    if not valid:
        raise PersistenceError(503, "Pré-requisitos de hospedagem incompletos ou inseguros; valores suprimidos.")
