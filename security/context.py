from contextvars import ContextVar
from dataclasses import dataclass


@dataclass(frozen=True)
class Principal:
    user_id: str
    auth_session_id: str
    session_hash: str


principal: ContextVar[Principal | None] = ContextVar("simpress_verified_principal", default=None)
