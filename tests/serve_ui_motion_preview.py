"""Isolated UI fixture: python tests/serve_ui_motion_preview.py (port 8765).

Serves the real frontend and fictional responses. LENTO takes 2 seconds;
FALHA returns 503. History annotations are stored only in fixture memory.
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
DEMO_EVENT_ID = "fixture-event-001"
DEMO_ANNOTATION_ID = "fixture-annotation-001"
PREVIOUS_EVENT_ID = "fixture-event-000"
DEMO_EVENT = {
    "id": DEMO_EVENT_ID,
    "horario": "2026-10-08T12:00:00Z",
    "tipo": "atualizacao",
    "arquivos_enviados": {"endpoint": "endpoint-demo.csv", "detalhes": "simpress-demo.xlsx"},
    "resumo": {},
    "restauravel": False,
    "comparacao": {
        "filtros_atualizacao_aplicados": True,
        "apelidos_sem_atualizacao": [{
            "serie": "DEMO-SN-001", "computador": "DEMO-HOST-001",
            "motivo": "Linha fictícia para validar a conferência.",
            "anotacao_id": DEMO_ANNOTATION_ID, "anotacao": "",
        }],
    },
}
PREVIOUS_EVENT = {
    "id": PREVIOUS_EVENT_ID,
    "horario": "2026-10-07T12:00:00Z",
    "tipo": "atualizacao",
    "arquivos_enviados": {"endpoint": "endpoint-anterior.csv", "detalhes": "simpress-anterior.xlsx"},
    "resumo": {},
    "restauravel": False,
}
DEMO_ANNOTATION = ""
TICKET_REPORT = {
    "atualizado_em": "2026-10-09T12:00:00Z",
    "fontes": {
        "simpress": {"arquivo": "Acompanhamento_de_Pedidos.xlsx", "linhas": 1, "series": 1, "linhas_sem_serie": 0},
        "oracle": {"arquivo": "Gestao_de_Solicitacoes.xlsx", "linhas": 1, "series": 1, "linhas_sem_serie": 0},
    },
    "resumo": {"series_total": 1, "conferidas": 1, "divergentes": 0, "sem_os": 0,
               "somente_simpress": 0, "somente_oracle": 0},
    "chamados": [{
        "serie": "DEMO-SN-001", "relacao": "conferida", "ordens_servico_conferidas": ["7285070"],
        "simpress": {"pedidos": ["48092691"], "ordens_servico": ["7285070"],
                     "chamados_cliente": [], "status": ["Em atendimento"], "datas_pedido": [], "modelos": ["Notebook de demonstração"]},
        "oracle": [{"solicitacao": "261009-000816", "ordem_servico": "7285070", "status": "Gestão da Mesa de Operações",
                    "sub_status": "Execução Pendente", "fila": "Mesa de Operações", "fase_atendimento": "Atendimento em Campo",
                    "status_entregas": "Sem Entregas", "status_atividades": "Atividades Pendentes", "assunto": "Corretiva Mobile",
                    "descricao": "Solicito suporte técnico para o equipamento de demonstração.",
                    "data_criacao": "2026-10-09", "ultima_atualizacao": "2026-10-09", "data_conclusao": ""}],
    }],
}
ticket_import_count = 0


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
        elif path == "/api/auth/session":
            self.send({"enabled": False, "authenticated": False})
        elif path == "/api/stats":
            self.send({"total_equipamentos": 1, "total_unidades": 0, "exportacao_disponivel": False})
        elif path == "/api/prontidao":
            self.send({"functions": {"consulta_equipamentos": {"available": True}}, "files": {}})
        elif path == "/__fixture_state":
            self.send({"annotation": DEMO_ANNOTATION})
        elif path == "/api/unidades":
            self.send([])
        elif path == "/api/config/transferencia":
            self.send({"retirada_contato": "Contato fictício", "retirada_email": "teste@example.invalid",
                       "retirada_telefone": "41900000000"})
        elif path == "/api/historico-comparacoes":
            self.send({"eventos": [DEMO_EVENT, PREVIOUS_EVENT], "total": 2})
        elif path == "/api/operacoes/pendencias":
            item = json.loads(json.dumps(DEMO_EVENT["comparacao"]["apelidos_sem_atualizacao"][0]))
            item["anotacao"] = DEMO_ANNOTATION
            self.send({"evento": {"id": DEMO_EVENT_ID, "horario": DEMO_EVENT["horario"]},
                       "pendencias": [{"categoria": "apelidos_sem_atualizacao",
                                       "secao": "Linhas mantidas para conferência", "item": item}]})
        elif path == "/api/operacoes/evolucao":
            self.send({"anterior": {"id": PREVIOUS_EVENT_ID, "horario": PREVIOUS_EVENT["horario"]},
                       "atual": {"id": DEMO_EVENT_ID, "horario": DEMO_EVENT["horario"]},
                       "contagens": {"novos": 1, "continuam": 0, "resolvidos": 0},
                       "mudancas": {"novos": [{"categoria": "apelidos_sem_atualizacao",
                           "secao": "Linhas mantidas para conferência", "evento_id": DEMO_EVENT_ID,
                           "item": {**DEMO_EVENT["comparacao"]["apelidos_sem_atualizacao"][0], "anotacao": DEMO_ANNOTATION}}],
                           "continuam": [], "resolvidos": []}})
        elif path == "/api/operacoes/chamados":
            self.send(TICKET_REPORT)
        elif path == "/__ticket_import_state":
            self.send({"imports": ticket_import_count})
        elif path == f"/api/historico-comparacoes/{DEMO_EVENT_ID}":
            comparison = json.loads(json.dumps(DEMO_EVENT["comparacao"]))
            comparison["apelidos_sem_atualizacao"][0]["anotacao"] = DEMO_ANNOTATION
            event = {**DEMO_EVENT, "comparacao": comparison}
            self.send({"evento": event})
        elif path == f"/api/historico-comparacoes/{PREVIOUS_EVENT_ID}":
            self.send({"evento": {**PREVIOUS_EVENT, "comparacao": {}}})
        elif path == "/api/historico-alteracoes":
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

    def do_PUT(self):
        global DEMO_ANNOTATION
        path = urlsplit(self.path).path
        if path != f"/api/historico-comparacoes/{DEMO_EVENT_ID}/anotacoes/{DEMO_ANNOTATION_ID}":
            self.send({"detail": "Endpoint de teste não encontrado"}, 404)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(size))
            annotation = payload.get("anotacao")
            if not isinstance(annotation, str) or len(annotation) > 2000:
                self.send({"detail": "Anotação inválida"}, 422)
                return
            DEMO_ANNOTATION = annotation
            self.send({"sincronizacao": "sincronizada"})
        except (ValueError, json.JSONDecodeError):
            self.send({"detail": "JSON inválido"}, 400)

    def do_POST(self):
        global ticket_import_count
        if urlsplit(self.path).path != "/api/operacoes/chamados/importar":
            self.send({"detail": "Endpoint de teste não encontrado"}, 404)
            return
        size = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(size)
        ticket_import_count += 1
        self.send(TICKET_REPORT)


if __name__ == "__main__":
    print("UI fixture: http://127.0.0.1:8765/ — LENTO / FALHA", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8765), Handler).serve_forever()
