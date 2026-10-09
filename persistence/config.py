"""Explicit backend selection; the PostgreSQL pilot accepts only local endpoints."""

from dataclasses import dataclass, field
import os
from urllib.parse import urlsplit


class PersistenceError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass(frozen=True)
class PersistenceSettings:
    backend: str = "files"
    database_url: str = field(default="", repr=False)
    pool_size: int = 4

    @classmethod
    def from_environment(cls, environment=None):
        env = os.environ if environment is None else environment
        backend = env.get("SIMPRESS_PERSISTENCE_BACKEND", "files").strip().lower()
        if backend not in {"files", "postgres"}:
            raise PersistenceError(503, "Backend de persistência inválido; use files ou postgres.")
        if backend == "files":
            return cls()
        if env.get("SIMPRESS_POSTGRES_LOCAL_PILOT") != "1":
            raise PersistenceError(503, "PostgreSQL exige autorização explícita do piloto local na configuração.")
        try:
            value = env.get("SIMPRESS_DATABASE_URL", "")
            url = urlsplit(value)
            valid = (
                url.scheme in {"postgres", "postgresql"}
                and url.hostname == "127.0.0.1" and url.port == 54322
                and url.path == "/postgres" and bool(url.password)
                and url.username == "simpress_piloto_login"
                and not url.query and not url.fragment
            )
            size = int(env.get("SIMPRESS_DATABASE_POOL_SIZE", "4"))
            valid = valid and 1 <= size <= 8
        except (ValueError, TypeError):
            valid = False
        if not valid:
            # Never echo the URL, password, libpq options, or connection exception.
            raise PersistenceError(503, "Configuração PostgreSQL inválida para simpress-dev local.")
        return cls(backend, value, size)
