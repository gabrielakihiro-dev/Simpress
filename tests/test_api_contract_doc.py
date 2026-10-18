"""The route table in CONTRATOS_API_BACKEND.md must match the routes the app registers."""

import re
import unittest

import main
from core.config import BASE_DIR

CONTRACT_DOC = BASE_DIR / "docs" / "arquitetura" / "CONTRATOS_API_BACKEND.md"
ROW_PATTERN = re.compile(r"^\|\s*\d+\s*\|\s*(GET|POST|PUT|PATCH|DELETE)\s+(\S+)\s*\|", re.MULTILINE)
# Registered without schema (include_in_schema=False) and listed in the doc intro.
UNDOCUMENTED_ROUTES = {("GET", "/favicon.ico")}


def registered_routes() -> set[tuple[str, str]]:
    routes = {
        (method.upper(), path)
        for path, operations in main.app.openapi()["paths"].items()
        for method in operations
    }
    # The home page is hidden from OpenAPI, so it is read from the route table.
    routes.update(
        (method, route.path)
        for route in main.app.routes
        if hasattr(route, "methods") and route.path == "/"
        for method in route.methods
        if method != "HEAD"
    )
    return routes - UNDOCUMENTED_ROUTES


class ApiContractDocTests(unittest.TestCase):
    def test_documented_routes_match_registered_routes(self):
        text = CONTRACT_DOC.read_text(encoding="utf-8")
        documented_list = ROW_PATTERN.findall(text)
        documented = set(documented_list)
        self.assertEqual(len(documented), len(documented_list), "Rota repetida na tabela do contrato.")
        registered = registered_routes()
        self.assertEqual(
            {"não documentadas": sorted(registered - documented), "inexistentes": sorted(documented - registered)},
            {"não documentadas": [], "inexistentes": []},
        )


if __name__ == "__main__":
    unittest.main()
