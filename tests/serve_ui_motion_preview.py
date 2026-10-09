"""Read-only UI fixture: python tests/serve_ui_motion_preview.py (port 8765).

Serves the real frontend and fictional GET responses. LENTO takes 2 seconds;
FALHA returns 503. No operational workbooks are loaded and writes are rejected.
"""

import json
import mimetypes
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

STATIC = Path(__file__).resolve().parents[1] / "static"
EQUIPMENT = {"serial": "LENTO", "modelo": "Notebook de demonstração", "tipo": "Notebook",
             "apelido": "DEMO-001", "retirada_cidade": "Curitiba", "retirada_endereco": "Endereço fictício"}


class Handler(BaseHTTPRequestHandler):
    def send(self, body, status=200, content_type="application/json; charset=utf-8"):
        payload = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # Expected when testing cancelled searches.

    def do_GET(self):
        url = urlsplit(self.path)
        path = unquote(url.path)
        if path == "/" or path.startswith("/static/"):
            target = (STATIC / ("index.html" if path == "/" else path.removeprefix("/static/"))).resolve()
            if not target.is_relative_to(STATIC) or not target.is_file():
                self.send({"detail": "Arquivo não encontrado"}, 404)
                return
            self.send(target.read_bytes(), content_type=mimetypes.guess_type(target.name)[0] or "application/octet-stream")
        elif path == "/api/stats":
            self.send({"total_equipamentos": 1, "total_unidades": 0, "exportacao_disponivel": False})
        elif path == "/api/prontidao":
            self.send({"functions": {"consulta_equipamentos": {"available": True}}, "files": {}})
        elif path == "/api/unidades":
            self.send([])
        elif path == "/api/config/transferencia":
            self.send({"retirada_contato": "Contato fictício", "retirada_email": "teste@example.invalid",
                       "retirada_telefone": "41900000000"})
        elif path in ("/api/historico-comparacoes", "/api/historico-alteracoes"):
            time.sleep(2)
            self.send({"eventos": [], "total": 0})
        elif path.startswith("/api/equipamento/"):
            serial = path.rsplit("/", 1)[1].upper()
            time.sleep(2)
            if serial == "FALHA":
                self.send({"detail": "Falha simulada para teste de interface."}, 503)
            else:
                self.send({**EQUIPMENT, "serial": serial})
        elif path in ("/api/buscar", "/api/buscar-expandida"):
            params = parse_qs(url.query)
            time.sleep(2)
            self.send({"items": [EQUIPMENT], "total": 1, "has_more": False,
                       "filters": {"categories": [], "cities": []}, "query": params.get("q", [""])[0]})
        else:
            self.send({"detail": "Endpoint de teste não encontrado"}, 404)


if __name__ == "__main__":
    print("UI fixture: http://127.0.0.1:8765/ — LENTO / FALHA", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8765), Handler).serve_forever()
