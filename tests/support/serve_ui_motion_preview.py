"""Isolated UI fixture: python tests/support/serve_ui_motion_preview.py (port 8765).

Serves the real frontend and fictional responses. LENTO takes 2 seconds;
FALHA returns 503. History annotations are stored only in fixture memory.
"""

import json
import mimetypes
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

STATIC = Path(__file__).resolve().parents[2] / "static"
sys.path.insert(0, str(STATIC.parent))
from domains.frontend_assets import CONTENT_SECURITY_POLICY, versioned_html
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
DEFAULT_ORIGIN_CONTACT = {"contato": "Contato fictício", "email": "teste@example.invalid", "telefone": "41900000000"}
origin_contact = dict(DEFAULT_ORIGIN_CONTACT)


def origin_contact_config():
    values = {"retirada_contato": origin_contact["contato"], "retirada_email": origin_contact["email"],
              "retirada_telefone": origin_contact["telefone"]}
    return {**values, "contato_origem_configurado": all(values.values()),
            "contato_origem_fontes": {key: "arquivo" if value else "" for key, value in values.items()},
            "contato_origem_arquivo_invalido": False}


USAGE_METRICS = ("transferencias", "comparacoes", "exportacoes", "os_conciliadas", "buscas")
USAGE_TOTALS = {"transferencias": 12, "comparacoes": 4, "exportacoes": 7, "os_conciliadas": 86, "buscas": 143}
USAGE_MINUTES = {metric: None for metric in USAGE_METRICS}


def usage_summary():
    configured = {metric: value for metric, value in USAGE_MINUTES.items() if value is not None}
    minutes = sum(USAGE_TOTALS[metric] * value for metric, value in configured.items())
    return {
        "periodo": {"inicio": "2026-09-18", "fim": "2026-10-17", "dias": 30},
        "totais": dict(USAGE_TOTALS),
        "por_dia": [],
        "registro_desde": "2026-10-01",
        "tempos_minutos": dict(USAGE_MINUTES),
        "tempos_configurados": bool(configured),
        "minutos_economizados": round(minutes, 1),
        "horas_economizadas": round(minutes / 60, 1),
        "disponivel": True,
    }


# Stale base alert: fresh by default so other tests keep the Home layout; e2e switches it per test.
BASE_FRESHNESS = {
    "atualizada": {"estado": "atualizada", "limite_dias": 7, "dias_sem_atualizacao": 2,
                   "ultima_atualizacao": "2026-10-15T20:15:53-03:00", "origem_data": "historico"},
    "desatualizada": {"estado": "desatualizada", "limite_dias": 7, "dias_sem_atualizacao": 9,
                      "ultima_atualizacao": "2026-10-08T20:15:00-03:00", "origem_data": "historico"},
    "sem_base": {"estado": "sem_base", "limite_dias": 7, "dias_sem_atualizacao": None,
                 "ultima_atualizacao": "", "origem_data": ""},
}
base_freshness_state = "atualizada"


def dashboard_payload():
    return {
        "base_importada": True, "total_equipamentos": 1, "total_unidades": 0,
        "por_categoria": [{"value": "notebook", "label": "Notebooks", "total": 1}],
        "sem_categoria": 0, "cidades_principais": [{"cidade": "Curitiba", "total": 1}],
        "cidades_por_categoria": {"notebook": [{"cidade": "Curitiba", "total": 1}]},
        "total_cidades": 1, "sem_cidade": 0, "ultima_atualizacao": "08/10/2026 09:00",
        "arquivo_origem": "simpress-demo.xlsx", "ultima_comparacao": None,
        "uso_30_dias": usage_summary(),
        "base_desatualizada": BASE_FRESHNESS[base_freshness_state],
    }


class Handler(BaseHTTPRequestHandler):
    def send(self, body, status=200, content_type="application/json; charset=utf-8"):
        payload = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        if content_type.startswith("text/html"):
            self.send_header("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # Expected when testing cancelled searches.

    def do_GET(self):
        global base_freshness_state
        url = urlsplit(self.path)
        path = unquote(url.path)
        if path == "/" or path.startswith("/static/"):
            relative_path = (
                "index.html" if path == "/"
                else path.removeprefix("/static/")
            )
            target = (STATIC / relative_path).resolve()
            if not target.is_relative_to(STATIC) or not target.is_file():
                self.send({"detail": "Arquivo não encontrado"}, 404)
                return
            payload = versioned_html(STATIC).encode("utf-8") if path == "/" else target.read_bytes()
            content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            self.send(payload, content_type=content_type)
        elif path == "/api/stats":
            self.send({"total_equipamentos": 1, "total_unidades": 0, "exportacao_disponivel": False})
        elif path == "/api/painel":
            self.send(dashboard_payload())
        elif path == "/api/prontidao":
            self.send({"functions": {"consulta_equipamentos": {"available": True}}, "files": {}})
        elif path == "/__fixture_base_desatualizada":
            requested = parse_qs(url.query).get("estado", ["atualizada"])[0]
            base_freshness_state = requested if requested in BASE_FRESHNESS else "atualizada"
            self.send({"estado": base_freshness_state})
        elif path == "/__fixture_state":
            self.send({"annotation": DEMO_ANNOTATION})
        elif path == "/api/unidades":
            self.send([])
        elif path == "/api/config/transferencia":
            self.send(origin_contact_config())
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
        if path == "/api/config/transferencia/contato-origem":
            size = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(size) or b"{}")
            if not all(str(payload.get(key) or "").strip() for key in DEFAULT_ORIGIN_CONTACT):
                self.send({"detail": 'Preencha o campo "Nome" do contato de origem.'}, 422)
                return
            origin_contact.update({key: str(payload[key]).strip() for key in DEFAULT_ORIGIN_CONTACT})
            self.send(origin_contact_config())
            return
        if path == "/api/painel/tempos-manuais":
            size = int(self.headers.get("Content-Length", "0"))
            try:
                minutes = json.loads(self.rfile.read(size)).get("tempos_minutos")
            except (ValueError, AttributeError):
                minutes = None
            if not isinstance(minutes, dict):
                self.send({"detail": "Informe os tempos por tarefa."}, 422)
                return
            for metric in USAGE_METRICS:
                value = minutes.get(metric)
                USAGE_MINUTES[metric] = value if isinstance(value, (int, float)) and 0 <= value <= 480 else None
            self.send(usage_summary())
            return
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
            self.send({"sucesso": True, "sincronizacao": "sincronizada",
                       "anotacao_revisoes": [payload["revisao_id"]] if payload.get("revisao_id") else []})
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
