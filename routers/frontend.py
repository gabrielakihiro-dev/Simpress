"""HTTP cache policy for the local application's pages and assets."""

from pathlib import Path

from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from domains.frontend_assets import versioned_html


def frontend_response(static_dir: Path, name: str = "index.html") -> HTMLResponse:
    return HTMLResponse(versioned_html(static_dir, name), headers={"Cache-Control": "no-store"})


class RevalidatingStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response
