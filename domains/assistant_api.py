"""The assistant's access to Simpress data: the same routes the screens use, called inside this process.

`asgi_transport` builds a loopback request by hand and runs it through the FastAPI app, so every
call passes the same safety middleware as a browser request (no network, no extra server).
`SimpressApi` shapes each answer for the model: short lists, labels approved in AGENTS.md and
personal data cleaned with `limpar_texto_sensivel`.
"""

import asyncio
import json
import logging
from collections import Counter
from typing import Any, Callable, Dict, List, Optional, Set, Tuple
from urllib.parse import quote, urlencode

from domains.assistant_lgpd import SEM_USUARIO, limpar_texto_sensivel

logger = logging.getLogger(__name__)

# (method, path, query params, JSON body) -> (HTTP status, decoded JSON or text)
Transport = Callable[[str, str, Optional[Dict[str, Any]], Optional[Dict[str, Any]]], Tuple[int, Any]]

CALL_TIMEOUT_SECONDS = 30.0
MAX_ANSWER_BYTES = 8 * 1024 * 1024

ROTINAS_VALIDAS = ("login", "os", "inventarios", "ambas", "usuarios", "sebrae")
DECISOES_VALIDAS = ("permitir", "recusar", "remover", "manter")

# Limits keep the text returned to the model inside its context window.
MAX_ITENS_LISTA = 20
# Page cap (100 items each) when loading base names for the privacy mask.
# shortcut: above 20,000 equipment rows with a user the name list is partial; raise it if the base grows.
MAX_PAGINAS_NOMES = 200
MAX_TEXTO_CHAMADO = 300
MAX_LINHAS_LOG = 40
MAX_APELIDO = 160

# Sections of the latest sheet comparison served by listar_secao_comparacao().
# "correspondencias_ambiguas" adds two fields because the screen moves serial duplicates from
# "correspondencias_ambiguas" to "registros_ambiguos" (see comparison_history_for_display).
_SECOES_COMPARACAO = {
    "correspondencias_ambiguas": ("correspondencias_ambiguas", "registros_ambiguos"),
    "series_sem_mapeamento": ("series_sem_mapeamento",),
    "apelidos_atualizados": ("apelidos_atualizados",),
    "divergencias_apelidos_manuais": ("divergencias_apelidos_manuais",),
    "mudancas_usuarios": ("mudancas_usuarios",),
}
# Approved labels (AGENTS.md, "Rótulos do Histórico de Planilhas"): EquipamentosDetalhes is "na Simpress", InvAll is "no Endpoint".
_ROTULOS_SECAO = {
    "apelido_equipamentos_detalhes": "apelido_na_simpress",
    "apelido_invall": "apelido_no_endpoint",
    "detalhes_encontrado": "encontrado_na_simpress",
    "invall_encontrado": "encontrado_no_endpoint",
    "diverge_detalhes": "diverge_na_simpress",
    "diverge_invall": "diverge_no_endpoint",
}


async def _asgi_call(
    app: Any, port: int, method: str, path: str, params: Optional[Dict[str, Any]], body: Optional[Dict[str, Any]],
) -> Tuple[int, Any]:
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else b""
    headers: List[Tuple[bytes, bytes]] = [
        (b"host", f"127.0.0.1:{port}".encode("ascii")),
        (b"accept", b"application/json"),
    ]
    if body is not None:
        headers += [(b"content-type", b"application/json"), (b"content-length", str(len(payload)).encode("ascii"))]
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": quote(path, safe="/").encode("ascii"),
        "query_string": urlencode(params or {}).encode("ascii"),
        "root_path": "",
        "headers": headers,
        "client": ("127.0.0.1", 50000),
        "server": ("127.0.0.1", port),
    }
    sent_body = False
    finished = asyncio.Event()
    status = 0
    chunks: List[bytes] = []
    size = 0
    content_type = ""

    async def receive() -> Dict[str, Any]:
        nonlocal sent_body
        if not sent_body:
            sent_body = True
            return {"type": "http.request", "body": payload, "more_body": False}
        await finished.wait()
        return {"type": "http.disconnect"}

    async def send(message: Dict[str, Any]) -> None:
        nonlocal status, size, content_type
        if message["type"] == "http.response.start":
            status = int(message["status"])
            for name, value in message.get("headers", []):
                if name.lower() == b"content-type":
                    content_type = value.decode("latin-1")
        elif message["type"] == "http.response.body":
            chunk = message.get("body", b"")
            size += len(chunk)
            if size <= MAX_ANSWER_BYTES:
                chunks.append(chunk)

    try:
        await app(scope, receive, send)
    finally:
        finished.set()
    if size > MAX_ANSWER_BYTES:
        raise ValueError("answer too large")
    raw = b"".join(chunks)
    if "json" in content_type:
        return status, json.loads(raw.decode("utf-8") or "null")
    return status, raw.decode("utf-8", errors="replace")


def asgi_transport(app_getter: Callable[[], Any], port: int) -> Transport:
    """A Transport that runs the request inside the FastAPI app. Meant for a worker thread (sync routes)."""

    def call(method: str, path: str, params: Optional[Dict[str, Any]], body: Optional[Dict[str, Any]]) -> Tuple[int, Any]:
        async def run() -> Tuple[int, Any]:
            return await asyncio.wait_for(_asgi_call(app_getter(), port, method, path, params, body), CALL_TIMEOUT_SECONDS)

        return asyncio.run(run())

    return call


def _rotular_item(dados: Any) -> Any:
    """Apply the approved labels and drop internal ids and empty annotations."""
    if isinstance(dados, dict):
        resultado: Dict[str, Any] = {}
        for k, v in dados.items():
            if k == "anotacao_id":
                continue
            if k == "anotacao" and not v:
                continue
            if k == "arquivos_origem" and isinstance(v, dict):
                v = {("na simpress" if kk == "detalhes" else kk): vv for kk, vv in v.items()}
            resultado[_ROTULOS_SECAO.get(str(k), str(k))] = _rotular_item(v)
        return resultado
    if isinstance(dados, list):
        return [_rotular_item(v) for v in dados]
    return dados


def sanitizar_equipamento(equip: Any) -> Dict[str, Any]:
    """Keep machine facts and city/UF only; street addresses never reach the model."""
    if not isinstance(equip, dict):
        return {}
    return {
        "serial": equip.get("serial", ""),
        "modelo": equip.get("modelo", ""),
        "tipo": equip.get("tipo", ""),
        "categoria": equip.get("categoria", ""),
        "apelido": equip.get("apelido", ""),
        "cidade": equip.get("retirada_cidade", "") or equip.get("cidade", ""),
        "uf": equip.get("retirada_uf", "PR"),
        "usuario_logado": equip.get("usuarios_logados", "") or equip.get("usuario_manual", "") or SEM_USUARIO,
        "contrato": equip.get("contrato", ""),
    }


def sanitizar_chamado(chamado: Any) -> Dict[str, Any]:
    if not isinstance(chamado, dict):
        return {}
    simpress_info = chamado.get("simpress", {})
    return {
        "numero_chamado": chamado.get("numero_chamado", ""),
        "serie": chamado.get("serie", ""),
        "relacao_os": chamado.get("relacao", ""),
        "ordens_servico": simpress_info.get("ordens_servico", []) if isinstance(simpress_info, dict) else [],
        "pedidos": simpress_info.get("pedidos", []) if isinstance(simpress_info, dict) else [],
        "descricao": limpar_texto_sensivel(chamado.get("descricao", "")),
        "status": chamado.get("status", ""),
    }


def _aparar(dados: Any) -> Any:
    """Cut long lists and clean e-mails, phones, CPFs and passwords from text, recursively."""
    if isinstance(dados, dict):
        return {k: _aparar(v) for k, v in dados.items()}
    if isinstance(dados, list):
        aparado: List[Any] = [_aparar(v) for v in dados[:MAX_ITENS_LISTA]]
        if len(dados) > MAX_ITENS_LISTA:
            aparado.append(f"... mais {len(dados) - MAX_ITENS_LISTA} itens omitidos")
        return aparado
    if isinstance(dados, str):
        return limpar_texto_sensivel(dados)
    return dados


def e_macbook(equip: Dict[str, Any]) -> bool:
    """Same test as Simpress (categorize_equipment): 'MACBOOK' in the type or the model."""
    texto = " ".join(str(equip.get(k) or "") for k in ("categoria", "tipo", "modelo")).upper()
    return "MACBOOK" in texto


def _dict(valor: Any) -> Dict[str, Any]:
    return valor if isinstance(valor, dict) else {}


class SimpressApi:
    """Queries and actions the assistant tools run against Simpress."""

    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    # --- plumbing ---------------------------------------------------------

    def _chamar(
        self, metodo: str, caminho: str, params: Optional[Dict[str, Any]] = None, corpo: Optional[Dict[str, Any]] = None,
    ) -> Tuple[bool, Any]:
        """Return (True, data) or (False, error text). Never raises."""
        try:
            status, dados = self._transport(metodo, caminho, params, corpo)
        except asyncio.TimeoutError:
            return False, "O Simpress demorou demais para responder."
        except Exception:
            logger.exception("Falha na chamada interna do assistente: %s %s", metodo, caminho)
            return False, "Falha ao consultar o Simpress."
        if 200 <= status < 300:
            return True, dados if dados is not None else {}
        return False, self._erro_http(status, dados)

    @staticmethod
    def _erro_http(status: int, dados: Any) -> str:
        detalhe = dados.get("detail") if isinstance(dados, dict) else None
        if isinstance(detalhe, list):
            detalhe = "; ".join(str(d.get("msg", d)) if isinstance(d, dict) else str(d) for d in detalhe)
        texto = detalhe if isinstance(detalhe, str) else (dados[:200] if isinstance(dados, str) else "")
        return f"Erro {status} do Simpress: {limpar_texto_sensivel(texto)}"

    def _leitura(self, caminho: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        ok, dados = self._chamar("GET", caminho, params=params)
        if not ok:
            return {"erro": dados}
        # The size cut happens after the privacy mask, in the conversation.
        return {"dados": _aparar(dados)}

    def _ultimo_evento(self) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
        """(latest history event summary, its detail, error/message dict). The last is set when there is nothing to use."""
        ok, dados = self._chamar("GET", "/api/historico-comparacoes")
        if not ok:
            return None, None, {"erro": dados}
        eventos = _dict(dados).get("eventos") or []
        if not eventos:
            return None, None, {"mensagem": "Nenhum histórico de comparação registrado até o momento."}
        ok, detalhe = self._chamar("GET", f"/api/historico-comparacoes/{eventos[0].get('id')}")
        if not ok:
            return None, None, {"erro": detalhe}
        return _dict(eventos[0]), _dict(detalhe), None

    # --- queries ----------------------------------------------------------

    def consultar_equipamento(self, serial: str) -> Dict[str, Any]:
        """Look up one serial. MacBook rule from AGENTS.md: retry with a leading 'S', accepted only for a MacBook."""
        clean_serial = serial.strip().upper()
        if not clean_serial:
            return {"erro": "Número de série não informado."}
        ok, dados = self._chamar("GET", f"/api/equipamento/{clean_serial}")
        if ok and isinstance(dados, dict):
            return {"encontrado": True, "equipamento": sanitizar_equipamento(dados)}
        if not clean_serial.startswith("S"):
            ok, dados = self._chamar("GET", f"/api/equipamento/S{clean_serial}")
            if ok and isinstance(dados, dict) and e_macbook(dados):
                resultado = sanitizar_equipamento(dados)
                resultado["observacao"] = f"Equipamento localizado na base oficial com o prefixo 'S' (S{clean_serial})."
                return {"encontrado": True, "equipamento": resultado}
        ok, itens = self._chamar("GET", "/api/buscar", params={"q": clean_serial})
        if ok and isinstance(itens, list) and itens:
            return {
                "encontrado": True,
                "observacao": "Série exata não localizada, mas encontramos correspondências aproximadas:",
                "correspondencias": [sanitizar_equipamento(item) for item in itens[:3]],
            }
        return {"encontrado": False, "mensagem": f"O equipamento com número de série '{serial}' não foi encontrado no cadastro oficial."}

    def pesquisar_catalogo(
        self, termo: str = "", cidade: Optional[str] = None, categoria: Optional[str] = None, usuario: Optional[str] = None,
    ) -> Dict[str, Any]:
        params: Dict[str, Any] = {"limit": 15, "offset": 0}
        if termo:
            params["q"] = termo
        if cidade:
            params["cidade"] = cidade
        if categoria:
            params["categoria"] = categoria
        if usuario in ("sem", "com"):
            params["usuario"] = usuario
        if not termo and usuario != "sem":
            params["listar_todos"] = "true"
        ok, dados = self._chamar("GET", "/api/buscar-expandida", params=params)
        if not ok:
            return {"erro": dados}
        dados = _dict(dados)
        return {
            "total_encontrados": dados.get("total", 0),
            "itens": [sanitizar_equipamento(item) for item in dados.get("items", [])],
        }

    def listar_nomes_usuarios(self) -> Optional[List[str]]:
        """Logins and names from the base, so the privacy mask recognises what the user types. None on failure."""
        nomes: Set[str] = set()
        offset = 0
        for _ in range(MAX_PAGINAS_NOMES):
            ok, dados = self._chamar("GET", "/api/buscar-expandida", params={
                "listar_todos": "true", "usuario": "com", "limit": 100, "offset": offset,
            })
            if not ok or not isinstance(dados, dict):
                return None
            itens = dados.get("items") or []
            for item in itens:
                valores = [item.get("usuarios_logados"), item.get("nome_pessoa"), *(item.get("usuarios_logados_candidatos") or [])]
                nomes.update(v.strip() for v in valores if isinstance(v, str) and v.strip())
            if not dados.get("has_more") or not itens:
                break
            offset += len(itens)
        return sorted(nomes)

    def obter_totais_inventario(self) -> Dict[str, Any]:
        ok, stats = self._chamar("GET", "/api/stats")
        if not ok:
            return {"erro": stats}
        stats = _dict(stats)
        return {
            "total_equipamentos_oficial": stats.get("total_equipamentos", 0),
            "total_unidades": stats.get("total_unidades", 0),
            "base_importada": stats.get("base_importada", False),
            "arquivo_origem": stats.get("arquivo_origem", ""),
            "ultima_atualizacao": stats.get("ultima_atualizacao", ""),
            "alteracoes_exportaveis": stats.get("total_alteracoes_exportaveis", 0),
        }

    def listar_chamados_abertos(self) -> Dict[str, Any]:
        ok, dados = self._chamar("GET", "/api/operacoes/chamados")
        if not ok:
            return {"erro": dados}
        dados = _dict(dados)
        chamados = dados.get("chamados", [])
        return {
            "atualizado_em": dados.get("atualizado_em", ""),
            "total_chamados": len(chamados),
            "resumo": dados.get("resumo", {}),
            "chamados": [sanitizar_chamado(ch) for ch in chamados[:MAX_ITENS_LISTA]],
        }

    def consultar_status_automacao(self) -> Dict[str, Any]:
        ok, dados = self._chamar("GET", "/api/automacao/estado")
        if not ok:
            return {"erro": dados}
        dados = _dict(dados)
        return {
            "executando": dados.get("estado") == "em_andamento",
            "rotina": dados.get("rotina") or "nenhuma",
            "estado": dados.get("estado", "livre"),
            "inicio": dados.get("inicio", ""),
            "aguardando_login": bool(dados.get("aguardando_login")),
            "cancelamento_pedido": bool(dados.get("cancelamento_pedido")),
        }

    def consultar_ultima_comparacao(self) -> Dict[str, Any]:
        ok, dados = self._chamar("GET", "/api/historico-comparacoes")
        if not ok:
            return {"erro": dados}
        eventos = _dict(dados).get("eventos", [])
        if not eventos:
            return {"mensagem": "Nenhum histórico de comparação registrado até o momento."}
        ultimo = _dict(eventos[0])
        return {
            "horario": ultimo.get("horario", ""),
            "tipo": ultimo.get("tipo", ""),
            "resumo_divergencias": ultimo.get("resumo", {}),
        }

    def obter_painel(self) -> Dict[str, Any]:
        return self._leitura("/api/painel")

    def obter_prontidao(self) -> Dict[str, Any]:
        return self._leitura("/api/prontidao")

    def listar_pendencias_operacionais(self) -> Dict[str, Any]:
        """Lean view: count per section plus serial, computer and reason of each item."""
        ok, dados = self._chamar("GET", "/api/operacoes/pendencias")
        if not ok:
            return {"erro": dados}
        dados = _dict(dados)
        itens = []
        for p in dados.get("pendencias") or []:
            item = _dict(_dict(p).get("item"))
            itens.append({
                "secao": _dict(p).get("secao", ""),
                "serie": item.get("serie", ""),
                "computador": item.get("computador", ""),
                "motivo": limpar_texto_sensivel(str(item.get("motivo") or "")),
            })
        return {
            "horario": _dict(dados.get("evento")).get("horario", ""),
            "total": len(itens),
            "por_secao": dict(Counter(i["secao"] for i in itens)),
            "itens": itens[:MAX_ITENS_LISTA],
            "omitidos": max(0, len(itens) - MAX_ITENS_LISTA),
        }

    def linha_do_tempo_chamados(self, serial: str) -> Dict[str, Any]:
        serial = serial.strip().upper()
        if not serial or "/" in serial:
            return {"erro": "Número de série não informado."}
        return self._leitura(f"/api/operacoes/chamados/linha-do-tempo/{serial}")

    def obter_relatorio_mensal(self, mes: str) -> Dict[str, Any]:
        mes = mes.strip()
        if len(mes) != 7 or mes[4] != "-":
            return {"erro": "Informe o mês no formato AAAA-MM (ex.: 2026-10)."}
        return self._leitura("/api/relatorio-mensal/dados", params={"mes": mes})

    def listar_historico_automacao(self) -> Dict[str, Any]:
        return self._leitura("/api/automacao/historico")

    def resumo_sebrae(self) -> Dict[str, Any]:
        return self._leitura("/api/automacao/sebrae/resumo")

    def consultar_historico_comparacao(self, evento_id: str) -> Dict[str, Any]:
        evento_id = evento_id.strip()
        if not evento_id or "/" in evento_id:
            return {"erro": "Identificador do histórico inválido."}
        return self._leitura(f"/api/historico-comparacoes/{evento_id}")

    def listar_divergencias_localidade(self) -> Dict[str, Any]:
        """Full 'Localidade divergente' section of the latest comparison, plus related transfers."""
        evento, detalhe, falha = self._ultimo_evento()
        if falha is not None or evento is None or detalhe is None:
            return falha or {"erro": "Histórico indisponível."}
        divergencias = [_dict(d) for d in _dict(_dict(detalhe.get("evento")).get("comparacao")).get("divergencias_local") or []]
        itens = [
            {
                "serie": d.get("serie", ""),
                "computador": d.get("computador", ""),
                "local_previsto": d.get("local_previsto", ""),
                "local_na_simpress": d.get("local_detalhes", ""),
            }
            for d in divergencias
        ]
        resultado: Dict[str, Any] = {
            "total": len(itens),
            "horario_comparacao": evento.get("horario", ""),
            "itens": _aparar(itens),
        }
        seriais = {str(d.get("serie", "")).strip().upper() for d in divergencias} - {""}
        if seriais:
            ok, dados_transf = self._chamar("GET", "/api/historico-transferencias")
            if not ok:
                resultado["aviso_transferencias"] = "Não foi possível consultar o histórico de transferências agora."
            else:
                relacionadas = []
                for t in _dict(dados_transf).get("itens") or []:
                    if not isinstance(t, dict):
                        continue
                    serie_t = str(t.get("serial") or "").strip().upper()
                    if serie_t in seriais:
                        relacionadas.append({
                            "serie": serie_t,
                            "de": t.get("retirada_cidade", ""),
                            "para": t.get("entrega_cidade", ""),
                            "contato_entrega": t.get("entrega_contato", ""),
                            "observacao": t.get("entrega_obs", ""),
                        })
                resultado["transferencias_relacionadas"] = _aparar(relacionadas)
        return resultado

    def consultar_divergencia_localidade(self, serial: str) -> Dict[str, Any]:
        serial = serial.strip().upper()
        if not serial:
            return {"erro": "Número de série não informado."}
        evento, detalhe, falha = self._ultimo_evento()
        if falha is not None or evento is None or detalhe is None:
            return falha or {"erro": "Histórico indisponível."}
        divergencias = [_dict(d) for d in _dict(_dict(detalhe.get("evento")).get("comparacao")).get("divergencias_local") or []]
        item = next((d for d in divergencias if str(d.get("serie", "")).strip().upper() == serial), None)
        if not item:
            return {
                "divergente": False,
                "mensagem": f"Série '{serial}' não está na lista de localidade divergente do último cruzamento ({evento.get('horario', '')}).",
            }
        return {
            "divergente": True,
            "serie": serial,
            "computador": item.get("computador", ""),
            "local_previsto": item.get("local_previsto", ""),
            "local_na_simpress": item.get("local_detalhes", ""),
            "horario_comparacao": evento.get("horario", ""),
        }

    def listar_secao_comparacao(self, secao: str) -> Dict[str, Any]:
        campos = _SECOES_COMPARACAO.get(secao)
        if campos is None:
            return {"erro": f"Seção desconhecida: {secao}"}
        evento, detalhe, falha = self._ultimo_evento()
        if falha is not None or evento is None or detalhe is None:
            return falha or {"erro": "Histórico indisponível."}
        evento_detalhe = _dict(detalhe.get("evento"))
        comparacao = _dict(evento_detalhe.get("comparacao"))
        itens: List[Any] = []
        for campo in campos:
            itens.extend(comparacao.get(campo) or [])
        total = len(itens)
        if secao == "correspondencias_ambiguas":
            # The screen shows the total saved in the summary (before duplicates are reclassified).
            total_resumo = _dict(evento_detalhe.get("resumo")).get("correspondencias_ambiguas")
            if isinstance(total_resumo, int):
                total = total_resumo
        return {
            "secao": secao,
            "total": total,
            "horario_comparacao": evento.get("horario", ""),
            "itens": _aparar(_rotular_item(itens)),
        }

    def listar_unidades(self) -> Dict[str, Any]:
        ok, dados = self._chamar("GET", "/api/unidades")
        if not ok:
            return {"erro": dados}
        campos = ("id", "cidade", "endereco", "uf", "cep", "cnpj")
        unidades = [{k: u.get(k, "") for k in campos} for u in (dados if isinstance(dados, list) else []) if isinstance(u, dict)]
        return {"total": len(unidades), "unidades": unidades}

    def listar_transferencias(self) -> Dict[str, Any]:
        resultado = self._leitura("/api/historico-transferencias")
        itens = _dict(resultado.get("dados")).get("itens")
        if isinstance(itens, list):
            seriais = sorted({str(item.get("serial") or "").strip().upper() for item in itens if isinstance(item, dict)} - {""})
            hostnames: Dict[str, str] = {}
            for serial in seriais:
                if "/" in serial:
                    continue
                ok, equip = self._chamar("GET", f"/api/equipamento/{serial}")
                if ok and isinstance(equip, dict):
                    hostnames[serial] = equip.get("apelido", "")
            for item in itens:
                if isinstance(item, dict):
                    item["hostname"] = hostnames.get(str(item.get("serial") or "").strip().upper(), "")
        return resultado

    def listar_pendencias_usuarios(self) -> Dict[str, Any]:
        return self._leitura("/api/usuarios/pendencias")

    def chamados_novos_sebrae(self) -> Dict[str, Any]:
        """New Sebrae tickets read from SoftExpert. Read only: nothing is saved or exported."""
        ok, dados = self._chamar("GET", "/api/sebrae/novos")
        if not ok:
            return {"erro": dados}
        dados = _dict(dados)
        importado = dados.get("importado") if isinstance(dados.get("importado"), dict) else None
        novos = dados.get("novos")
        if not isinstance(novos, dict):
            return {"dashboard_importado": importado is not None,
                    "mensagem": "Ainda não há leitura de chamados novos do Sebrae."}

        def texto(valor: Any) -> str:
            return limpar_texto_sensivel(valor)[:MAX_TEXTO_CHAMADO]

        itens = []
        for f in novos.get("formulario") or []:
            if not isinstance(f, dict):
                continue
            linha = _dict(f.get("linha"))
            cruzamento = _dict(f.get("cruzamento"))
            itens.append({
                "numero": str(f.get("numero") or ""),
                "data": str(linha.get("P") or ""),
                "titulo": texto(linha.get("G")),
                "descricao": texto(linha.get("H")),
                "solicitante": texto(linha.get("I")),
                "detalhes": texto(linha.get("F")),
                "serie": str(linha.get("K") or ""),
                "modelo": str(linha.get("L") or ""),
                "cidade": str(linha.get("N") or ""),
                "os": str(linha.get("E") or ""),
                "cruzamento": str(cruzamento.get("status") or ""),
                "candidatos": cruzamento.get("candidatos", 0),
            })
        pendentes = [p for p in novos.get("pendentes") or [] if isinstance(p, dict)]
        erros = _dict(novos.get("erros"))
        return _aparar({
            "dashboard_importado": importado and {k: importado.get(k, "") for k in ("arquivo", "importado_em", "total")},
            "lidos_em": novos.get("lidos_em", ""),
            "ignorados": novos.get("ignorados", 0),
            "total_novos": len(itens),
            "chamados": [_aparar(i) for i in itens[:MAX_ITENS_LISTA]],
            "omitidos": max(0, len(itens) - MAX_ITENS_LISTA),
            "pendentes_total": len(pendentes),
            "pendentes": [{"numero": str(p.get("numero") or ""), "motivo": str(p.get("motivo") or "")}
                          for p in pendentes[:MAX_ITENS_LISTA]],
            "erros": [{"numero": str(n), "erro": str(m)} for n, m in list(erros.items())[:MAX_ITENS_LISTA]],
        })

    def chamados_antigos_abertos_sebrae(self) -> Dict[str, Any]:
        """Old Dashboard tickets with Status EM ABERTO or empty. Read only."""
        ok, dados = self._chamar("GET", "/api/sebrae/novos")
        if not ok:
            return {"erro": dados}
        dados = _dict(dados)
        importado = dados.get("importado") if isinstance(dados.get("importado"), dict) else None
        if importado is None:
            return {"dashboard_importado": False, "mensagem": "Ainda não há Dashboard do Sebrae importado."}
        itens = []
        for a in importado.get("abertos") or []:
            if not isinstance(a, dict):
                continue
            v = _dict(a.get("valores"))
            itens.append({
                "numero": str(a.get("numero") or ""),
                "titulo": limpar_texto_sensivel(a.get("titulo"))[:MAX_TEXTO_CHAMADO],
                "responsavel": limpar_texto_sensivel(v.get("A")),
                "categoria": limpar_texto_sensivel(v.get("B")),
                "status": str(v.get("D") or ""),
                "tipo": str(v.get("J") or ""),
            })
        return _aparar({
            "dashboard_importado": {k: importado.get(k, "") for k in ("arquivo", "importado_em", "total")},
            "total_abertos": len(itens),
            "sem_responsavel": sum(1 for i in itens if not i["responsavel"]),
            "abertos": [_aparar(i) for i in itens[:MAX_ITENS_LISTA]],
            "omitidos": max(0, len(itens) - MAX_ITENS_LISTA),
        })

    def estado_usuarios_entra(self) -> Dict[str, Any]:
        return self._leitura("/api/usuarios-entra/estado")

    @staticmethod
    def _limite(limite: Any, padrao: int) -> int:
        try:
            return max(1, min(int(limite), MAX_ITENS_LISTA))
        except (TypeError, ValueError):
            return padrao

    def listar_historico_alteracoes(self, limite: Any = 10) -> Dict[str, Any]:
        ok, dados = self._chamar("GET", "/api/historico-alteracoes")
        if not ok:
            return {"erro": dados}
        eventos = [e for e in _dict(dados).get("eventos") or [] if isinstance(e, dict)]
        itens = []
        for e in eventos[: self._limite(limite, 10)]:
            item = {k: e[k] for k in (
                "id", "tipo", "serial", "equipamento", "horario", "acao", "motivo", "origem",
                "apelido_anterior", "apelido_novo", "usuario_anterior", "usuario_novo",
                "nome_pessoa_anterior", "nome_pessoa_novo",
            ) if e.get(k) not in (None, "")}
            if e.get("valor_anterior"):
                # Loss warning from the Endpoint: the value is a user or a hostname, depending on the reason.
                item["usuario_anterior" if e.get("motivo") == "usuario_removido" else "apelido_anterior"] = e["valor_anterior"]
            itens.append(item)
        return {"total": len(eventos), "eventos": _aparar(itens)}

    def listar_apelidos_modificados(self, limite: Any = MAX_ITENS_LISTA) -> Dict[str, Any]:
        """Hand-typed nicknames. The server sends {serial: nickname}; a list lets the mask see the 'apelido' key."""
        ok, dados = self._chamar("GET", "/api/equipamento/apelidos-modificados")
        if not ok:
            return {"erro": dados}
        apelidos = _dict(_dict(dados).get("apelidos"))
        corte = self._limite(limite, MAX_ITENS_LISTA)
        itens = [{"serial": str(s), "apelido": str(a)} for s, a in apelidos.items()]
        return {"total": len(itens), "itens": _aparar(itens[:corte]), "omitidos": max(0, len(itens) - corte)}

    def evolucao_atualizacoes(self, anterior: str = "", atual: str = "") -> Dict[str, Any]:
        """What appeared and what was resolved between two inventory updates (default: the two latest)."""
        anterior, atual = str(anterior or "").strip(), str(atual or "").strip()
        if bool(anterior) != bool(atual):
            return {"erro": "Informe os dois identificadores (anterior e atual) ou nenhum."}
        if "/" in anterior or "/" in atual:
            return {"erro": "Identificador do histórico inválido."}
        if not anterior:
            ok, hist = self._chamar("GET", "/api/historico-comparacoes")
            if not ok:
                return {"erro": hist}
            eventos = _dict(hist).get("eventos") or []
            ids = [str(e["id"]) for e in eventos if isinstance(e, dict) and e.get("id") and e.get("tipo") != "restauracao"]
            if len(ids) < 2:
                return {"mensagem": "É preciso ter pelo menos duas atualizações no histórico para comparar."}
            atual, anterior = ids[0], ids[1]
        ok, dados = self._chamar("GET", "/api/operacoes/evolucao", params={"anterior": anterior, "atual": atual})
        if not ok:
            return {"erro": dados}
        dados = _dict(dados)
        mudancas = _dict(dados.get("mudancas"))
        itens = []
        for situacao, chave in (("novo", "novos"), ("resolvido", "resolvidos")):
            for m in mudancas.get(chave) or []:
                m = _dict(m)
                reg = _dict(m.get("item"))
                itens.append({
                    "situacao": situacao, "secao": m.get("secao", ""),
                    "serie": reg.get("serie") or reg.get("serial") or "",
                    "computador": reg.get("computador", ""), "motivo": reg.get("motivo", ""),
                })
        return {
            "anterior": _aparar(dados.get("anterior", {})), "atual": _aparar(dados.get("atual", {})),
            "contagens": dados.get("contagens", {}),
            "total_itens": len(itens),
            "itens": _aparar(itens[:MAX_ITENS_LISTA]),
            "omitidos": max(0, len(itens) - MAX_ITENS_LISTA),
        }

    def log_execucao_automacao(self, execucao_id: str = "") -> Dict[str, Any]:
        """Last lines of a routine log (default: the latest failure), without e-mails and phones."""
        execucao_id = str(execucao_id or "").strip()
        if "/" in execucao_id or "\\" in execucao_id:
            return {"erro": "Identificador da execução inválido."}
        if not execucao_id:
            ok, hist = self._chamar("GET", "/api/automacao/historico", params={"limite": 1, "status": "falha"})
            if not ok:
                return {"erro": hist}
            execucoes = _dict(hist).get("execucoes")
            if not execucoes or not isinstance(execucoes[0], dict) or not execucoes[0].get("id"):
                return {"mensagem": "Nenhuma rotina com falha no histórico recente."}
            execucao_id = str(execucoes[0]["id"])
        ok, dados = self._chamar("GET", f"/api/automacao/execucoes/{execucao_id}/log", params={"linhas": MAX_LINHAS_LOG})
        if not ok:
            return {"erro": dados}
        dados = _dict(dados)
        linhas = [limpar_texto_sensivel(linha)[:MAX_TEXTO_CHAMADO] for linha in (dados.get("linhas") or [])[-MAX_LINHAS_LOG:]]
        execucao = _dict(dados.get("execucao"))
        return {
            "execucao": _aparar({k: v for k, v in execucao.items() if k not in ("log", "capturas")}),
            "detalhes": linhas,  # free-text key of the mask: known names become markers
            "limitado": bool(dados.get("limitado")),
        }

    # --- actions that change data (only after the user confirms) -----------

    def _acao(self, caminho: str, corpo: Optional[Dict[str, Any]], sucesso: str) -> Dict[str, Any]:
        ok, dados = self._chamar("POST", caminho, corpo=corpo if corpo is not None else {})
        if not ok:
            return {"sucesso": False, "erro": dados}
        return {"sucesso": True, "mensagem": sucesso}

    def executar_automacao(self, rotina: str) -> Dict[str, Any]:
        rotina_clean = rotina.strip().lower()
        if rotina_clean not in ROTINAS_VALIDAS:
            return {"sucesso": False, "erro": f"Rotina inválida: '{rotina}'. Opções aceitas: {', '.join(ROTINAS_VALIDAS)}."}
        ok, dados = self._chamar("POST", "/api/automacao/executar", corpo={"rotina": rotina_clean})
        if not ok:
            if "Erro 409" in str(dados):
                return {"sucesso": False, "erro": "Já existe uma automação em andamento. Aguarde o término ou cancele."}
            return {"sucesso": False, "erro": dados}
        return {"sucesso": True, "rotina": rotina_clean, "mensagem": f"Rotina '{rotina_clean}' disparada pelo servidor Simpress."}

    def cancelar_automacao(self) -> Dict[str, Any]:
        return self._acao("/api/automacao/cancelar", None, "Cancelamento solicitado ao servidor Simpress.")

    def atualizar_apelido(self, serial: str, apelido: str) -> Dict[str, Any]:
        serial, apelido = serial.strip().upper(), apelido.strip()
        if not serial:
            return {"sucesso": False, "erro": "Número de série não informado."}
        if len(apelido) > MAX_APELIDO:
            return {"sucesso": False, "erro": f"O apelido pode ter no máximo {MAX_APELIDO} caracteres."}
        return self._acao(
            "/api/equipamento/atualizar-apelido", {"serial": serial, "apelido": apelido},
            f"Apelido do serial {serial} atualizado.",
        )

    def atualizar_usuario(self, serial: str, usuario: str) -> Dict[str, Any]:
        serial, usuario = serial.strip().upper(), usuario.strip()
        if not serial:
            return {"sucesso": False, "erro": "Número de série não informado."}
        return self._acao(
            "/api/equipamento/atualizar-usuario", {"serial": serial, "usuario": usuario},
            f"Usuário do serial {serial} atualizado.",
        )

    def salvar_unidade(
        self, cidade: str, endereco: str, cnpj: str, uf: str = "PR", cep: str = "", id: Optional[Any] = None,
    ) -> Dict[str, Any]:
        """Edit (with id) or create (without id) a unit. Refuses an id that is not in the current list."""
        corpo: Dict[str, Any] = {
            "cidade": cidade.strip(), "endereco": endereco.strip(), "cnpj": cnpj.strip(),
            "uf": (uf or "PR").strip().upper(), "cep": (cep or "").strip(),
        }
        if not corpo["cidade"] or not corpo["endereco"] or not corpo["cnpj"]:
            return {"sucesso": False, "erro": "Cidade, endereço e CNPJ são obrigatórios."}
        if id not in (None, ""):
            try:
                corpo["id"] = int(id)
            except (TypeError, ValueError):
                return {"sucesso": False, "erro": f"Identificador de unidade inválido: {id}."}
            atual = self.listar_unidades()
            if "erro" in atual:
                return {"sucesso": False, "erro": atual["erro"]}
            if not any(str(u.get("id")) == str(corpo["id"]) for u in atual["unidades"]):
                return {"sucesso": False, "erro": f"Não existe unidade com id {corpo['id']}. Nada foi alterado."}
        feito = f"Unidade #{corpo['id']} ({corpo['cidade']}) atualizada." if "id" in corpo else f"Unidade {corpo['cidade']} criada."
        return self._acao("/api/unidade/salvar", corpo, feito)

    def decidir_pendencia_usuario(self, pendencia_id: str, decisao: str) -> Dict[str, Any]:
        pendencia_id, decisao = str(pendencia_id).strip(), decisao.strip().lower()
        if decisao not in DECISOES_VALIDAS:
            return {"sucesso": False, "erro": f"Decisão inválida. Opções: {', '.join(DECISOES_VALIDAS)}."}
        if not pendencia_id or "/" in pendencia_id:
            return {"sucesso": False, "erro": "Identificador da pendência inválido."}
        return self._acao(
            f"/api/usuarios/pendencias/{pendencia_id}/decidir", {"decisao": decisao},
            f"Pendência {pendencia_id}: decisão '{decisao}' registrada.",
        )
