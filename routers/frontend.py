"""HTTP cache policy for the local application's pages and assets."""

import re
from pathlib import Path

from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException

from domains.frontend_assets import CONTENT_SECURITY_POLICY, versioned_html


def frontend_response(static_dir: Path, name: str = "index.html") -> HTMLResponse:
    return HTMLResponse(
        versioned_html(static_dir, name),
        headers={"Cache-Control": "no-store", "Content-Security-Policy": CONTENT_SECURITY_POLICY},
    )


class RevalidatingStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):
        try:
            response = await super().get_response(path, scope)
        except HTTPException as exc:
            exc.headers = {**(exc.headers or {}), "Cache-Control": "no-cache"}
            raise
        versioned = re.fullmatch(rb"v=[0-9a-f]{16}", scope.get("query_string", b""))
        response.headers["Cache-Control"] = (
            "public, max-age=31536000, immutable"
            if response.status_code in {200, 304} and versioned
            else "no-cache"
        )
        return response
