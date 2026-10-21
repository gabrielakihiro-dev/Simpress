"""Isolated UI fixture: python tests/support/serve_ui_motion_preview.py (port 8765).

Serves the real frontend and fictional responses. LENTO takes 2 seconds;
FALHA returns 503. History annotations are stored only in fixture memory.
"""

import json
import mimetypes
import os
import struct
import sys
import time
import zlib
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
# Manual logged users saved from the comparison result; fixture memory only.
FIXTURE_MANUAL_USERS = {}
FIXTURE_MANUAL_DATE = "2026-10-20T09:00:00-03:00"
FIXTURE_MANUAL_DATES = {}
# Fictional series repeated in the Endpoint: its users are listed, none is chosen.
FIXTURE_AMBIGUOUS_USERS = {"DEMO-SN-001": ["usuario.a", "usuario.b"]}
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

# Stale tickets and new divergences alerts: hidden by default; e2e turns them on per test.
PANEL_ALERTS = {
    "ocultos": {
        "os_paradas": {"estado": "em_dia", "limite_dias": 7, "total": 0,
                       "maior_dias_sem_atualizacao": None, "importado_em": "2026-10-18T09:00:00-03:00"},
        "divergencias_novas": {"estado": "sem_novas", "total": 0, "por_secao": [],
                               "anterior": None, "atual": None},
    },
    "visiveis": {
        "os_paradas": {"estado": "paradas", "limite_dias": 7, "total": 3,
                       "maior_dias_sem_atualizacao": 21, "importado_em": "2026-10-18T09:00:00-03:00"},
        "divergencias_novas": {
            "estado": "novas", "total": 5,
            "por_secao": [{"secao": "Localidade divergente", "total": 3},
                          {"secao": "Séries sem local definido", "total": 2}],
            "anterior": {"id": "anterior", "horario": "2026-10-11T08:00:00-03:00"},
            "atual": {"id": "atual", "horario": "2026-10-18T09:00:00-03:00"},
        },
    },
}
panel_alerts_state = "ocultos"


def dashboard_payload():
    return {
        "base_importada": True, "total_equipamentos": 1, "total_unidades": 0,
        "por_categoria": [{"value": "notebook", "label": "Notebooks", "total": 1}],
        "sem_categoria": 0, "cidades_principais": [{"cidade": "Curitiba", "total": 1}],
        "cidades_por_categoria": {"notebook": [{"cidade": "Curitiba", "total": 1}]},
        "total_cidades": 1, "sem_cidade": 0, "ultima_atualizacao": "08/10/2026 09:00",
        "arquivo_origem": "simpress-demo.xlsx", "ultima_comparacao": None,
        "base_desatualizada": BASE_FRESHNESS[base_freshness_state],
        **PANEL_ALERTS[panel_alerts_state],
    }


# Automação tab: fictional runs only; nothing starts a process. e2e resets it per test.
AUTOMATION_BASE_HISTORY = [
    {"id": "20261020_080000_inventarios", "rotina": "inventarios", "origem": "site",
     "inicio": "2026-10-20T08:00:00-03:00", "fim": "2026-10-20T08:06:30-03:00", "status": "concluido", "codigo": 0,
     "mensagem": "", "lotes": [{"id": "lote-demo-001", "status": "concluido"}], "capturas": [], "log": "demo.site.log"},
    {"id": "20261019_170000_os", "rotina": "os", "origem": "externo",
     "inicio": "2026-10-19T17:00:00-03:00", "fim": "2026-10-19T17:02:10-03:00", "status": "falha", "codigo": 1,
     "mensagem": "Login não concluído em 10 minutos.", "lotes": [],
     "capturas": [{"nome": "20261019_170210_Oracle.png", "url": "/api/automacao/capturas/20261019_170210_Oracle.png"}],
     "log": "demo.log"},
]
AUTOMATION_HISTORY = list(AUTOMATION_BASE_HISTORY)
AUTOMATION_LINES = [
    "[08:00:01] [Chrome] Reaproveitando o Chrome de automação na porta 9333.",
    "[08:00:02] [Oracle] Abrindo https://simpress.custhelp.com/AgentWeb/",
    "[08:00:20] [Oracle] AÇÃO NECESSÁRIA: faça o login na janela do Chrome de automação.",
]
automation_run = None


PNG_SIGNATURE = bytes([137, 80, 78, 71, 13, 10, 26, 10])


def fixture_capture_png(width=640, height=400):
    """Fictional failure screenshot (a login form mock-up) so the preview needs no files from data/."""
    rows = []
    for y in range(height):
        row = bytearray([0])
        for x in range(width):
            color = (241, 245, 249)
            if y < 36:
                color = (30, 41, 59)
            elif 120 <= y < 150 and 160 <= x < 480:
                color = (255, 255, 255) if y not in (120, 149) and x not in (160, 479) else (148, 163, 184)
            elif 170 <= y < 200 and 160 <= x < 480:
                color = (255, 255, 255) if y not in (170, 199) and x not in (160, 479) else (148, 163, 184)
            elif 230 <= y < 262 and 160 <= x < 320:
                color = (2, 132, 199)
            elif 290 <= y < 320 and 160 <= x < 480:
                color = (254, 226, 226)
            row += bytes(color)
        rows.append(bytes(row))

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (PNG_SIGNATURE + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(b"".join(rows))) + chunk(b"IEND", b""))


FIXTURE_CAPTURE = fixture_capture_png()


def automation_state(offset=0):
    lines = AUTOMATION_LINES if automation_run else []
    start = offset if 0 <= offset <= len(lines) else 0
    return {
        "estado": "em_andamento" if automation_run else "livre",
        "rotina": automation_run["rotina"] if automation_run else "",
        "inicio": automation_run["inicio"] if automation_run else "",
        "origem": "site" if automation_run else "", "pid": 4242 if automation_run else None,
        "cancelamento_pedido": False,
        "aguardando_login": bool(automation_run), "login_origem": "Oracle" if automation_run else "",
        "log": {"arquivo": "fixture.site.log" if automation_run else "", "offset": len(lines),
                "linhas": lines[start:], "reiniciado": start != offset},
        "ultima": AUTOMATION_HISTORY[0] if AUTOMATION_HISTORY else None,
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
        global base_freshness_state, panel_alerts_state
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
        elif path == "/__fixture_alertas_painel":
            requested = parse_qs(url.query).get("estado", ["ocultos"])[0]
            panel_alerts_state = requested if requested in PANEL_ALERTS else "ocultos"
            self.send({"estado": panel_alerts_state})
        elif path == "/__fixture_automacao":
            AUTOMATION_HISTORY[:] = AUTOMATION_BASE_HISTORY
            count = int(parse_qs(url.query).get("quantidade", ["0"])[0])
            if count:
                AUTOMATION_HISTORY[:] = [
                    {**AUTOMATION_BASE_HISTORY[index % 2], "id": f"demo-{index}",
                     "inicio": f"2026-10-{20 if index < 8 else 19}T{23 - index:02d}:00:00-03:00"}
                    for index in range(min(count, 20))
                ]
            globals()["automation_run"] = None
            self.send({"estado": "livre"})
        elif path == "/api/automacao/estado":
            offset = parse_qs(url.query).get("offset", ["0"])[0]
            self.send(automation_state(int(offset) if offset.isdigit() else 0))
        elif path == "/api/automacao/historico":
            query = parse_qs(url.query)
            entries = [entry for entry in AUTOMATION_HISTORY
                       if (not query.get("data_inicio") or entry["inicio"][:10] >= query["data_inicio"][0])
                       and (not query.get("data_fim") or entry["inicio"][:10] <= query["data_fim"][0])
                       and (not query.get("rotina") or entry["rotina"] == query["rotina"][0])
                       and (not query.get("status") or entry["status"] == query["status"][0])]
            limit = max(1, min(int(query.get("limite", ["5"])[0]), 50))
            pages = max(1, (len(entries) + limit - 1) // limit)
            page = max(1, min(int(query.get("pagina", ["1"])[0]), pages))
            self.send({"execucoes": entries[(page - 1) * limit:page * limit], "total": len(entries),
                       "pagina": page, "paginas": pages, "limite": limit})
        elif path.startswith("/api/automacao/capturas/"):
            self.send(FIXTURE_CAPTURE, content_type="image/png")
        elif path.startswith("/api/automacao/execucoes/") and path.endswith("/log"):
            identifier = path.split("/")[-2]
            entry = next((item for item in AUTOMATION_HISTORY if item["id"] == identifier), None)
            if entry is None:
                self.send({"detail": "Execução não encontrada."}, 404)
            else:
                limit = min(500, int(parse_qs(url.query).get("linhas", ["200"])[0]))
                self.send({"execucao": entry, "arquivo": entry["log"], "linhas":
                           [f"Histórico {identifier} · linha {i} <script>texto</script>" for i in range(600 - limit, 600)], "limitado": True})
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
            # Fictional logged user, shown beside the hostname in the result row; "manual" and
            # "ambiguo" in the query show a manual user with its date and ambiguous Endpoint users.
            term = params.get("q", [""])[0].lower()
            item = {**EQUIPMENT, "usuarios_logados": "usuario.demo", "usuarios_logados_origem": "endpoint"}
            if "manual" in term:
                item.update(usuarios_logados_origem="manual", usuarios_logados_informado_em=FIXTURE_MANUAL_DATE)
            if "ambiguo" in term:
                item.update(usuarios_logados="", usuarios_logados_origem="",
                            usuarios_logados_candidatos=["usuario.a", "usuario.b"])
            if params.get("usuario", [""])[0] == "sem":
                # "Sem usuário" filter: a fictional equipment with neither an Endpoint nor a manual user.
                item = {**EQUIPMENT, "serial": "DEMO-SEM-USUARIO", "apelido": "PRNOTEDEMO02",
                        "usuarios_logados": "", "usuarios_logados_origem": ""}
            self.send({"items": [item], "total": 1, "has_more": False,
                       "filters": {"categories": [], "cities": [], "users": {"sem": 1, "com": 1}},
                       "query": params.get("q", [""])[0]})
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
        path = urlsplit(self.path).path
        if path in ("/api/equipamentos/usuarios-logados", "/api/equipamento/atualizar-usuario"):
            size = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(size) or b"{}")
            if path.endswith("usuarios-logados"):
                self.send({"usuarios": {
                    serie: {"usuario": FIXTURE_MANUAL_USERS.get(serie, ""),
                            "origem": "manual" if FIXTURE_MANUAL_USERS.get(serie) else "",
                            "serial_cadastro": serie,
                            "informado_em": FIXTURE_MANUAL_DATES.get(serie, "") if FIXTURE_MANUAL_USERS.get(serie) else "",
                            "candidatos": FIXTURE_AMBIGUOUS_USERS.get(serie, [])}
                    for serie in body.get("series", [])
                }})
            else:
                FIXTURE_MANUAL_USERS[body["serial"]] = body.get("usuario", "")
                FIXTURE_MANUAL_DATES[body["serial"]] = FIXTURE_MANUAL_DATE
                self.send({"sucesso": True, "equipamento": {
                    "serial": body["serial"], "usuarios_logados": body.get("usuario", ""),
                    "usuarios_logados_origem": "manual" if body.get("usuario") else "",
                    "usuarios_logados_informado_em": FIXTURE_MANUAL_DATE if body.get("usuario") else "",
                    "usuarios_logados_candidatos": FIXTURE_AMBIGUOUS_USERS.get(body["serial"], []),
                }})
            return
        if path == "/api/automacao/executar":
            size = int(self.headers.get("Content-Length", "0"))
            rotina = json.loads(self.rfile.read(size) or b"{}").get("rotina")
            if rotina not in ("os", "inventarios", "ambas", "login"):
                self.send({"detail": "Rotina inválida."}, 422)
            elif automation_run:
                self.send({"detail": "Já há uma rotina em andamento: Rotina de OS desde 08:00. Aguarde terminar ou cancele."}, 409)
            else:
                globals()["automation_run"] = {"rotina": rotina, "inicio": "2026-10-20T08:00:00-03:00"}
                self.send(automation_state(), 202)
            return
        if path == "/api/automacao/cancelar":
            if not automation_run:
                self.send({"detail": "Nenhuma rotina em andamento para cancelar."}, 409)
                return
            AUTOMATION_HISTORY.insert(0, {
                "id": "20261020_080000_fixture", "rotina": automation_run["rotina"], "origem": "site",
                "inicio": automation_run["inicio"], "fim": "2026-10-20T08:01:00-03:00", "status": "cancelado",
                "codigo": 1, "mensagem": "", "lotes": [], "capturas": [], "log": "fixture.site.log"})
            globals()["automation_run"] = None
            self.send({"metodo": "processo", "mensagem": "Rotina encerrada. O Chrome de automação continua aberto.",
                       "estado": automation_state()}, 202)
            return
        if path != "/api/operacoes/chamados/importar":
            self.send({"detail": "Endpoint de teste não encontrado"}, 404)
            return
        size = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(size)
        ticket_import_count += 1
        self.send(TICKET_REPORT)


class UIFixtureServer(ThreadingHTTPServer):
    # The module graph arrives in a burst. The default queue of five connections
    # drops imports when Windows CI is slower to accept them, preventing startup.
    request_queue_size = 128


if __name__ == "__main__":
    port = int(os.environ.get("SIMPRESS_UI_FIXTURE_PORT", "8765"))
    print(f"UI fixture: http://127.0.0.1:{port}/ — LENTO / FALHA", flush=True)
    UIFixtureServer(("127.0.0.1", port), Handler).serve_forever()
