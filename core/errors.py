"""Domain errors that carry an API status without depending on the HTTP layer.

The domain modules raise these classes; ``main.py`` registers one exception
handler that turns them into the same JSON body FastAPI produces for
``HTTPException`` (``{"detail": ...}``). Status codes and messages are part of
the API contract; keep them unchanged when converting code.
"""

from typing import Any, Optional


class DomainError(Exception):
    """Base domain error; used directly for unexpected failures (500)."""

    default_status_code = 500

    def __init__(self, detail: Any = None, *, status_code: Optional[int] = None) -> None:
        self.status_code: int = self.default_status_code if status_code is None else status_code
        self.detail: Any = detail
        super().__init__(detail)

    def __str__(self) -> str:
        # Same text as Starlette's HTTPException, which callers may already log.
        return f"{self.status_code}: {self.detail}"

    def __repr__(self) -> str:
        return f"{type(self).__name__}(status_code={self.status_code!r}, detail={self.detail!r})"


class DomainValidationError(DomainError):
    """Invalid input: 400 by default; 413 and 422 are passed explicitly."""

    default_status_code = 400


class DomainConflictError(DomainError):
    """The request conflicts with the current local state (409)."""

    default_status_code = 409


class DomainBusyError(DomainError):
    """A local resource is temporarily unavailable; retry later (503)."""

    default_status_code = 503
