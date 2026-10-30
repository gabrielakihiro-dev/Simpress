"""The assistant's access to Simpress data: the same routes the screens use, called inside this process.

`asgi_transport` builds a loopback request by hand and runs it through the FastAPI app, so every
call passes the same safety middleware as a browser request (no network, no extra server).
`SimpressApi` shapes each answer for the model: short lists, labels approved in AGENTS.md and
personal data cleaned with `limpar_texto_sensivel`.
"""

import asyncio
import calendar
import json
import logging
import re
from collections import Counter
from datetime import date, datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Set, Tuple
from urllib.parse import quote, urlencode

from domains.assistant_lgpd import SEM_USUARIO, limpar_texto_sensivel
from domains.history_insights import PENDING_CATEGORIES, normalize_identifier
from domains.inventory_comparison import is_curitiba_hostname_exception, is_sebrae_owned_notebook_serial
from routers.transfers import TransferenciaPayload, formatar_telefone_brasileiro

logger = logging.getLogger(__name__)

# (method, path, query params, JSON body) -> (HTTP status, decoded JSON or text)
Transport = Callable[[str, str, Optional[Dict[str, Any]], Optional[Dict[str, Any]]], Tuple[int, Any]]

CALL_TIMEOUT_SECONDS = 30.0
MAX_ANSWER_BYTES = 8 * 1024 * 1024

ROTINAS_VALIDAS = ("login", "os", "inventarios", "ambas", "usuarios", "sebrae", "dashboard")
DECISOES_VALIDAS = ("permitir", "recusar", "remover", "manter")

# Limits keep the text returned to the model inside its context window.
MAX_ITENS_LISTA = 20
# Page cap (100 items each) when loading base names for the privacy mask.
# shortcut: above 20,000 equipment rows with a user the name list is partial; raise it if the base grows.
MAX_PAGINAS_NOMES = 200
MAX_TEXTO_CHAMADO = 300
MAX_LINHAS_LOG = 40
MAX_APELIDO = 160
MAX_ANOTACAO = 2000  # same limit as the annotation routes (history_annotations.MAX_ANNOTATION_LENGTH)
# Annotatable sections of a history event (comparison key -> name shown on screen and on the card).
_SECOES_ANOTAVEIS = {
    "apelidos_sem_atualizacao": "Linhas mantidas para conferência",
    "sem_acesso_7_dias": "Sem acesso há 7 dias ou mais",
    "ausentes_no_endpoint": "Equipamentos sem correspondência por fonte (Endpoint)",
    "ausentes_em_detalhes": "Equipamentos sem correspondência por fonte (Simpress)",
    "divergencias_local": "Localidade divergente",
    "correspondencias_ambiguas": "Duplicidades e correspondências ambíguas",
    "registros_ambiguos": "Duplicidades e correspondências ambíguas",
    "series_sem_mapeamento": "Séries sem local definido",
    "mudancas_usuarios": "Mudanças de usuário logado",
}
_ID_ROTA = re.compile(r"^[^/?#\s]{1,128}$")

# comparar_periodos(): examples per list and size of the answer. The chat cuts any result above
# MAX_CARACTERES_RESPOSTA (6000, assistant_chat) in the middle, so the examples shrink first and the JSON stays whole.
MAX_EXEMPLOS_COMPARACAO = 10
ORCAMENTO_COMPARACAO = 5000
_PONTO_PERIODO = re.compile(r"^\d{4}-\d{2}(-\d{2})?$")
_PONTO_EVENTO = re.compile(r"^(?![0-9-]+$)[A-Za-z0-9_-]{1,64}$")
_CAMPOS_EXEMPLO = (
    ("serie", "serie"), ("serial", "serie"), ("computador", "computador"), ("local_previsto", "local_previsto"),
    ("local_detalhes", "local_na_simpress"), ("dias_sem_verificacao", "dias_sem_acesso"), ("motivo", "motivo"),
)

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
# explicar_divergencia(): same size budget as comparar_periodos (the section items shrink first).
_SERIE_VALIDA = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$")
_HOSTNAME_VALIDO = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$")
_ROTULOS_EXTRA_SECAO = {
    "apelidos_atualizados": "Apelidos atualizados",
    "divergencias_apelidos_manuais": "Apelidos manuais divergentes",
    "mudancas_usuarios": "Mudanças de usuário",
}
_TEXTO_AMBIGUA = "A série ou o hostname aparece em mais de uma linha, ou a correspondência não é única; confira os duplicados."
# Sections of the last comparison that explain a divergence: section -> (cause code, fixed text).
# The texts never carry a hostname, user or nickname, so the privacy mask has nothing to miss.
_CAUSAS_SECAO = {
    "ausentes_no_endpoint": ("ausente_no_endpoint", "Na última comparação a série ficou sem correspondência no Endpoint: existe na Simpress, mas não foi achada no Endpoint."),
    "ausentes_em_detalhes": ("ausente_na_simpress", "Na última comparação a série ficou sem correspondência na Simpress: existe no Endpoint, mas não foi achada na Simpress."),
    "sem_acesso_7_dias": ("sem_acesso_7_dias", "Sem acesso há 7 dias ou mais: a última verificação no Endpoint foi há 7 dias ou mais."),
    "apelidos_sem_atualizacao": ("linha_mantida_para_conferencia", "A linha ficou em 'Linhas mantidas para conferência': o hostname do Endpoint não foi aplicado como apelido (veja o motivo)."),
    "divergencias_local": ("localidade_divergente", "A localidade esperada pelo hostname é diferente da localidade cadastrada na Simpress."),
    "correspondencias_ambiguas": ("ocorrencia_ambigua", _TEXTO_AMBIGUA),
    "registros_ambiguos": ("ocorrencia_ambigua", _TEXTO_AMBIGUA),
    "series_sem_mapeamento": ("serie_sem_local_definido", "A série não tem local definido no mapeamento de localidades."),
    "divergencias_apelidos_manuais": ("apelido_manual_diverge", "O apelido manual é diferente do apelido na Simpress ou do hostname no Endpoint."),
}
_SECOES_EXPLICACAO = (*_CAUSAS_SECAO, "apelidos_atualizados", "mudancas_usuarios")
# What the current record says about the Endpoint (invall_alias_status); anything else is unknown.
_ENDPOINT_PELO_STATUS = {
    "aplicado": "presente", "serie_invall_duplicada": "presente", "hostname_vazio": "presente",
    "serie_nao_encontrada": "ausente",
}
_CAUSAS_STATUS = {
    "serie_nao_encontrada": ("ausente_no_endpoint", "O Endpoint ativo não tem esta série."),
    "hostname_vazio": ("hostname_vazio_no_endpoint", "O Endpoint tem a série, mas o hostname está vazio."),
    "serie_invall_duplicada": ("serie_duplicada_no_endpoint", "A série aparece mais de uma vez no Endpoint."),
    "serie_detalhes_duplicada": ("serie_duplicada_na_simpress", "A série aparece mais de uma vez na Simpress."),
    "indisponivel": ("endpoint_indisponivel", "O Endpoint ativo não pôde ser lido; não dá para dizer se a série está nele."),
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
    if "spreadsheetml" in content_type:  # exported .xlsx: keep the bytes
        return status, raw
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


def validar_anotacao(texto: Any) -> str:
    """The text as the route will receive it; ValueError (pt-BR) when the route would refuse it."""
    texto = "" if texto is None else str(texto)
    if len(texto) > MAX_ANOTACAO:
        raise ValueError(f"A anotação passa de {MAX_ANOTACAO} caracteres.")
    return texto


_CHAMADO_UTIC = re.compile(r"^UTIC-(\d{4})-(\d{1,24})$")
FONTES_VINCULO_OS = ("simpress", "oracle")


def validar_vinculo_os(fonte: Any, serie: Any, ordem: Any, chamado: Any) -> Dict[str, Any]:
    """The body the vinculos-os route will receive; ValueError (pt-BR) when the route would refuse it."""
    fonte, serie, ordem = str(fonte or "").strip().lower(), str(serie or "").strip().upper(), str(ordem or "").strip()
    achado = _CHAMADO_UTIC.match(str(chamado or "").strip().upper())
    if fonte not in FONTES_VINCULO_OS:
        raise ValueError(f"Fonte inválida. Opções: {', '.join(FONTES_VINCULO_OS)}.")
    if not serie or len(serie) > 128 or not ordem or len(ordem) > 160:
        raise ValueError("Informe a série (até 128 caracteres) e a OS (até 160 caracteres).")
    if achado is None or not 2000 <= int(achado.group(1)):
        raise ValueError("Chamado inválido. Use o formato UTIC-AAAA-número (ex.: UTIC-2026-42).")
    return {"fonte": fonte, "serie": serie, "os": ordem, "ano": int(achado.group(1)), "numero": achado.group(2)}


# Origin contact of the transfer form: (route field, tool argument, name on the card, limit as in ContatoOrigemPayload).
_CAMPOS_CONTATO_ORIGEM = (
    ("retirada_contato", "contato", "Nome", 160),
    ("retirada_email", "email", "E-mail", 254),
    ("retirada_telefone", "telefone", "Celular", 64),
)


def montar_contato_origem(atual: Dict[str, Any], contato: Any, email: Any, telefone: Any) -> Tuple[Dict[str, str], List[Tuple[str, str, str]]]:
    """(body for the contato-origem route, [(label, current, new)] of the fields that change); ValueError (pt-BR) when the route would refuse.

    Omitted fields keep the current value. A field set by environment variable cannot be changed here (the variable wins over the file)."""
    fontes = _dict(atual.get("contato_origem_fontes"))
    novos = {"retirada_contato": contato, "retirada_email": email, "retirada_telefone": telefone}
    corpo: Dict[str, str] = {}
    mudancas: List[Tuple[str, str, str]] = []
    for campo, chave, rotulo, limite in _CAMPOS_CONTATO_ORIGEM:
        antigo = str(atual.get(campo) or "").strip()
        valor = novos[campo]
        valor = valor.strip() if isinstance(valor, str) else ""
        ambiente = fontes.get(campo) == "ambiente"
        if valor and "OCULTADO]" in valor:
            raise ValueError(f"{rotulo} digitado no chat é ocultado do modelo (LGPD). Peça ao usuário para preencher na tela de Transferência.")
        if valor and ambiente:
            raise ValueError(f"{rotulo} é definido por variável de ambiente e não pode ser alterado aqui.")
        if len(valor) > limite:
            raise ValueError(f"{rotulo} longo demais (máximo {limite} caracteres).")
        if valor and campo == "retirada_email":
            valor = TransferenciaPayload.validate_email(valor)
        elif valor and campo == "retirada_telefone":
            valor = formatar_telefone_brasileiro(TransferenciaPayload.validate_phone(valor))
        if valor and valor != antigo:
            mudancas.append((rotulo, antigo, valor))
        final = "" if ambiente else (valor or antigo)
        if not final and not ambiente:
            raise ValueError(f"O campo {rotulo} ainda não está configurado: informe também ele.")
        corpo[chave] = final
    if not mudancas:
        raise ValueError("Nenhum valor novo: informe nome, e-mail ou celular diferente do atual. Nada a alterar.")
    return corpo, mudancas


def _dict(valor: Any) -> Dict[str, Any]:
    return valor if isinstance(valor, dict) else {}


def _instante(horario: Any) -> float:
    try:
        valor = datetime.fromisoformat(str(horario or "").replace("Z", "+00:00"))
        if valor.tzinfo is None:
            valor = valor.replace(tzinfo=timezone.utc)
        return valor.timestamp()
    except (TypeError, ValueError, OverflowError):
        return float("-inf")


def _limite_do_ponto(ponto: str) -> Optional[str]:
    """Last day (AAAA-MM-DD) covered by a month or date point; None for an event id. ValueError for a date that does not exist."""
    if not _PONTO_PERIODO.match(ponto):
        return None
    if len(ponto) == 7:
        return f"{ponto}-{calendar.monthrange(int(ponto[:4]), int(ponto[5:]))[1]:02d}"
    date.fromisoformat(ponto)
    return ponto


def _exemplo_comparacao(item: Dict[str, Any]) -> Dict[str, Any]:
    """A history row reduced to serial, hostname, place and reason (notes and users stay out)."""
    exemplo: Dict[str, Any] = {}
    for origem, destino in _CAMPOS_EXEMPLO:
        valor = item.get(origem)
        if valor not in (None, "", [], {}):
            exemplo[destino] = valor if isinstance(valor, int) else limpar_texto_sensivel(valor)[:80]
    if "serie" not in exemplo and "computador" not in exemplo and item.get("chave"):
        # Ambiguity rows only carry `chave`: a serial when duplicated, otherwise a hostname (masked as such).
        duplicada = "série" in str(item.get("tipo") or "").lower()
        exemplo["serie" if duplicada else "computador"] = limpar_texto_sensivel(item["chave"])[:80]
        exemplo["tipo"] = limpar_texto_sensivel(item.get("tipo"))[:80]
    return exemplo


class SimpressApi:
    """Queries and actions the assistant tools run against Simpress."""

    def __init__(self, transport: Transport) -> None:
        self._transport = transport
        self._tokens_restauracao: Dict[str, str] = {}

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

    def ler_rota(self, caminho: str, params: Optional[Dict[str, Any]] = None) -> Tuple[bool, Any]:
        """Raw GET (no list cut, no mask): for files generated by the server from data, never sent to the model."""
        return self._chamar("GET", caminho, params=params)

    def ultimo_evento(self) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
        return self._ultimo_evento()

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

    def _linhas_anotaveis(self, evento_id: str) -> Tuple[List[Dict[str, Any]], Optional[str]]:
        """(rows of the annotatable sections of a history event, error). Rows keep the real ids for the card and the PUT."""
        evento_id = str(evento_id or "").strip()
        if not _ID_ROTA.match(evento_id):
            return [], "Identificador do histórico inválido."
        ok, dados = self._chamar("GET", f"/api/historico-comparacoes/{evento_id}")
        if not ok:
            return [], str(dados)
        comparacao = _dict(_dict(_dict(dados).get("evento")).get("comparacao"))
        linhas = [
            {
                "secao": rotulo, "item_id": item["anotacao_id"],
                "serie": item.get("serie") or "", "computador": item.get("computador") or item.get("chave") or "",
                "anotacao": item.get("anotacao") or "",
            }
            for chave, rotulo in _SECOES_ANOTAVEIS.items() for item in comparacao.get(chave) or []
            if isinstance(item, dict) and item.get("anotacao_id")
        ]
        return linhas, None

    def listar_anotacoes_historico(self, evento_id: str, serie: Any = "", so_anotadas: Any = False) -> Dict[str, Any]:
        """Rows of one history event with their annotation. Needed to get the `item_id` before saving a note."""
        linhas, erro = self._linhas_anotaveis(evento_id)
        if erro:
            return {"erro": erro}
        serie = str(serie or "").strip().upper()
        itens = [
            linha for linha in linhas
            if (not serie or str(linha["serie"]).upper() == serie) and (so_anotadas is not True or linha["anotacao"])
        ]
        return {"total": len(itens), "itens": _aparar(itens), "omitidos": max(0, len(itens) - MAX_ITENS_LISTA)}

    def linha_historico(self, evento_id: str, item_id: str) -> Optional[Dict[str, Any]]:
        """The row of the event with this id (None when it does not exist); for the confirmation card."""
        linhas, _ = self._linhas_anotaveis(evento_id)
        return next((linha for linha in linhas if linha["item_id"] == str(item_id).strip()), None)

    def evento_linha_do_tempo(self, serie: str, evento_id: str, item_id: str) -> Optional[Dict[str, Any]]:
        serie = str(serie or "").strip().upper()
        if not serie or "/" in serie:
            return None
        ok, dados = self._chamar("GET", f"/api/operacoes/chamados/linha-do-tempo/{serie}")
        eventos = _dict(dados).get("eventos") if ok else None
        return next(
            (e for e in eventos or [] if isinstance(e, dict) and e.get("snapshot_id") == evento_id and e.get("item_id") == item_id),
            None,
        )

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

    def explicar_divergencia(self, serial: Any = "", hostname: Any = "") -> Dict[str, Any]:
        """Cross what Simpress already knows about one serial and list the probable causes by fixed rules."""
        serie = serial.strip().upper() if isinstance(serial, str) else ""
        host = hostname.strip() if isinstance(hostname, str) else ""
        if not _SERIE_VALIDA.match(serie) or (host and not _HOSTNAME_VALIDO.match(host)):
            return {"erro": "Informe uma série válida (letras, números, ponto, hífen ou sublinhado) e, se quiser, um hostname válido."}
        ok, dados = self._chamar("GET", f"/api/equipamento/{serie}")
        if not ok and not str(dados).startswith("Erro 404"):
            return {"erro": dados}
        registro = dados if ok and isinstance(dados, dict) else None
        com_s: Optional[Dict[str, Any]] = None
        if not serie.startswith("S"):
            ok_s, dados_s = self._chamar("GET", f"/api/equipamento/S{serie}")
            if ok_s and isinstance(dados_s, dict) and e_macbook(dados_s):
                com_s = dados_s  # Endpoint serial without the leading S equals the Simpress one with it (MacBook).
        via_s = registro is None and com_s is not None
        if via_s:
            registro = com_s

        causas: Dict[str, str] = {}
        if is_sebrae_owned_notebook_serial(serie):
            causas["serie_sebrae_ignorada"] = "A série é de notebook do Sebrae e é ignorada nas comparações."
        if is_curitiba_hostname_exception(host) or (registro is not None and is_curitiba_hostname_exception(str(registro.get("apelido") or ""))):
            causas["hostname_curitiba_sem_divergencia_local"] = (
                "Hostnames PRNOTESJP*, PRNOTERL* e PRNOTEARC* são de Curitiba e não geram divergência de localidade."
            )
        if registro is None:
            causas["ausente_na_simpress"] = "A série não consta na Simpress (cadastro atual)."
        elif com_s is not None and not via_s:
            causas["serie_s_ambigua"] = "Existem a série e a mesma série com o prefixo 'S' (MacBook) na Simpress; a correspondência com o Endpoint é ambígua."

        status = str(registro.get("invall_alias_status") or "") if registro else ""
        if status in _CAUSAS_STATUS:
            causas.setdefault(*_CAUSAS_STATUS[status])
        endpoint: Dict[str, Any] = {"situacao": _ENDPOINT_PELO_STATUS.get(status, "desconhecida"), "origem": "cadastro atual"}
        if registro and status:
            endpoint["detalhe"] = limpar_texto_sensivel(registro.get("invall_alias_detail", ""))[:160]

        chaves = {normalize_identifier(serie)}
        if registro is not None:
            chaves.add(normalize_identifier(registro.get("serial")))
            if e_macbook(registro):
                chaves |= {"S" + c for c in chaves} | {c[1:] for c in chaves if c.startswith("S")}
        chaves.discard("")
        host_norm = normalize_identifier(host)

        evento, detalhe, falha = self._ultimo_evento()
        comparacao = _dict(_dict(_dict(detalhe).get("evento")).get("comparacao")) if falha is None else {}
        secoes: List[Dict[str, Any]] = []
        for campo in _SECOES_EXPLICACAO:
            itens = []
            for item in comparacao.get(campo) or []:
                if not isinstance(item, dict):
                    continue
                por_serie = any(normalize_identifier(item.get(k)) in chaves for k in ("serie", "serial", "chave"))
                por_host = bool(host_norm) and host_norm in (normalize_identifier(item.get("computador")), normalize_identifier(item.get("chave")))
                if not (por_serie or por_host):
                    continue
                if por_host and not por_serie and not (item.get("chave") or item.get("serie") or item.get("serial")):
                    causas.setdefault("serie_vazia", "Há uma linha com este hostname e a série vazia na última comparação.")
                itens.append(_exemplo_comparacao(item))
            if not itens:
                continue
            secoes.append({"secao": campo, "rotulo": PENDING_CATEGORIES.get(campo) or _ROTULOS_EXTRA_SECAO[campo], "ocorrencias": len(itens), "itens": itens})
            if campo in _CAUSAS_SECAO:
                codigo, texto = _CAUSAS_SECAO[campo]
                dias = next((i["dias_sem_acesso"] for i in itens if isinstance(i.get("dias_sem_acesso"), int)), None)
                if campo == "sem_acesso_7_dias" and dias is not None:
                    texto = f"Sem acesso há 7 dias ou mais: a última verificação no Endpoint foi há {dias} dias."
                causas.setdefault(codigo, texto)
            if endpoint["situacao"] == "desconhecida" and campo in ("ausentes_no_endpoint", "ausentes_em_detalhes"):
                endpoint = {"situacao": "ausente" if campo == "ausentes_no_endpoint" else "presente", "origem": "última comparação"}
        if not causas:
            causas["sem_causa_conhecida"] = "Sem causa conhecida pelas regras."

        origem_nome = str(registro.get("nome_pessoa_origem") or "") if registro else ""
        tem_usuario = bool(registro and str(registro.get("usuarios_logados") or "").strip())
        entra: Dict[str, Any] = {
            "situacao": "presente" if origem_nome == "entra" else ("ausente" if tem_usuario else "desconhecida"),
            "origem_do_nome": origem_nome or "nenhuma",
        }
        if registro and registro.get("nome_pessoa"):
            entra["nome_pessoa"] = registro["nome_pessoa"]
        na_simpress: Dict[str, Any] = {"presente": False}
        if registro is not None:
            na_simpress = {k: v for k, v in sanitizar_equipamento(registro).items() if k not in ("contrato", "categoria", "uf")}
            na_simpress["computador"] = na_simpress.pop("apelido")
            na_simpress["presente"] = True
            na_simpress["origem_do_usuario"] = str(registro.get("usuarios_logados_origem") or "")
            if via_s:
                na_simpress["observacao"] = "Localizada com o prefixo 'S' (MacBook): a série do Endpoint não tem o S."

        def montar(limite: int) -> Dict[str, Any]:
            resultado: Dict[str, Any] = {
                "serie": serie,
                "fontes": {"na_simpress": na_simpress, "no_endpoint": endpoint, "entra": entra},
                "secoes_da_ultima_comparacao": [{**s, "itens": s["itens"][:limite]} for s in secoes],
                "causas_provaveis": [{"codigo": c, "texto": t} for c, t in causas.items()],
            }
            if host:
                resultado["computador"] = host
            if evento is not None:
                resultado["horario_ultima_comparacao"] = evento.get("horario", "")
            if falha is not None:
                resultado["mensagem"] = str(falha.get("erro") or falha.get("mensagem") or "Histórico indisponível.")
            return resultado

        resultado = montar(MAX_EXEMPLOS_COMPARACAO)
        for limite in (5, 3, 1, 0):
            if len(json.dumps(resultado, ensure_ascii=False)) <= ORCAMENTO_COMPARACAO:
                break
            resultado = montar(limite)
        return resultado

    def _vinculos_os(self) -> Tuple[bool, Any]:
        ok, dados = self._chamar("GET", "/api/operacoes/chamados/vinculos-os")
        if not ok:
            return False, dados
        return True, [v for v in _dict(dados).get("vinculos") or [] if isinstance(v, dict)]

    def listar_vinculos_os(self, serie: Any = "", chamado: Any = "") -> Dict[str, Any]:
        """Manual links ticket <-> OS, optionally filtered by serial or ticket (the route has no filter)."""
        ok, vinculos = self._vinculos_os()
        if not ok:
            return {"erro": vinculos}
        serie, chamado = str(serie or "").strip().upper(), str(chamado or "").strip().upper()
        itens = [
            {k: limpar_texto_sensivel(v.get(k, "")) for k in ("fonte", "serie", "os", "chamado")} for v in vinculos
            if (not serie or str(v.get("serie", "")).strip().upper() == serie) and (not chamado or str(v.get("chamado", "")).upper() == chamado)
        ]
        resultado: Dict[str, Any] = {"total": len(itens), "vinculos": itens[:MAX_ITENS_LISTA]}
        if len(itens) > MAX_ITENS_LISTA:
            resultado["aviso"] = f"Mostrando só os {MAX_ITENS_LISTA} primeiros; filtre por série ou chamado."
        return resultado

    def vinculo_os_atual(self, fonte: str, serie: str, ordem: str) -> Optional[Dict[str, Any]]:
        """The saved link of this source+serial+OS (same normalization as the route key), None when there is none. ValueError if the list cannot be read."""
        ok, vinculos = self._vinculos_os()
        if not ok:
            raise ValueError(vinculos)
        chave = (fonte, serie.strip().upper(), "".join(ordem.split()).upper())
        return next((v for v in vinculos
                     if (v.get("fonte"), str(v.get("serie", "")).strip().upper(), "".join(str(v.get("os", "")).split()).upper()) == chave), None)

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

    def comparar_periodos(self, ponto_a: Any = "", ponto_b: Any = "") -> Dict[str, Any]:
        """Difference between two saved inventory updates, picked by event id, month (AAAA-MM) or date (AAAA-MM-DD)."""
        pontos = [str(ponto_a or "").strip(), str(ponto_b or "").strip()]
        limites: List[Optional[str]] = []
        for ponto in pontos:
            try:
                limite = _limite_do_ponto(ponto)
            except ValueError:
                return {"erro": "Data inexistente. Use um mês (AAAA-MM), uma data válida (AAAA-MM-DD) ou o identificador de uma atualização."}
            if limite is None and not _PONTO_EVENTO.match(ponto):
                return {"erro": "Ponto inválido. Informe o identificador de uma atualização, um mês (AAAA-MM) ou uma data (AAAA-MM-DD)."}
            limites.append(limite)
        ok, hist = self._chamar("GET", "/api/historico-comparacoes")
        if not ok:
            return {"erro": hist}
        # Only real inventory updates hold a comparison: no restorations, no events rebuilt from shared notes.
        validos = sorted(
            (e for e in _dict(hist).get("eventos") or []
             if isinstance(e, dict) and e.get("id") and e.get("tipo") != "restauracao"
             and not e.get("somente_anotacoes_sincronizadas") and _instante(e.get("horario")) != float("-inf")),
            key=lambda e: _instante(e.get("horario")), reverse=True,
        )
        disponiveis = [{"id": str(e["id"]), "horario": str(e.get("horario") or "")} for e in validos[:MAX_ITENS_LISTA]]
        eventos: List[Dict[str, Any]] = []
        for ponto, limite in zip(pontos, limites):
            if limite is None:
                evento = next((e for e in validos if str(e["id"]) == ponto), None)
            else:
                evento = next((e for e in validos if str(e["horario"])[:10] <= limite), None)
            if evento is None:
                return {"erro": f"Não há atualização do histórico para o ponto '{ponto}'.", "atualizacoes_disponiveis": disponiveis}
            eventos.append(evento)
        if eventos[0]["id"] == eventos[1]["id"]:
            return {
                "mensagem": "Os dois pontos correspondem à mesma atualização do histórico; não há diferença a mostrar.",
                "atualizacao": {"id": str(eventos[0]["id"]), "horario": str(eventos[0]["horario"])},
            }
        ordenados = sorted(zip(pontos, limites, eventos), key=lambda p: _instante(p[2]["horario"]))
        ok, dados = self._chamar(
            "GET", "/api/operacoes/evolucao",
            params={"anterior": str(ordenados[0][2]["id"]), "atual": str(ordenados[1][2]["id"])},
        )
        if not ok:
            return {"erro": dados}
        mudancas = _dict(_dict(dados).get("mudancas"))
        secoes: Dict[str, Dict[str, Any]] = {}
        for situacao in ("novos", "continuam", "resolvidos"):
            for mudanca in mudancas.get(situacao) or []:
                mudanca = _dict(mudanca)
                item = _dict(mudanca.get("item"))
                if str(mudanca.get("categoria") or "").startswith("ausentes_") and is_sebrae_owned_notebook_serial(item.get("serie") or item.get("serial")):
                    continue  # AGENTS.md: the Sebrae notebook series stay out of the unmatched lists
                secao = secoes.setdefault(str(mudanca.get("secao") or "Outras"), {"novos": [], "continuam": 0, "resolvidos": []})
                if situacao == "continuam":
                    secao["continuam"] += 1
                else:
                    secao[situacao].append(item)
        ordem = list(dict.fromkeys(PENDING_CATEGORIES.values()))
        rotulos = sorted(secoes, key=lambda r: ordem.index(r) if r in ordem else len(ordem))

        def montar(exemplos: int) -> Dict[str, Any]:
            linhas = []
            for rotulo in rotulos:
                novos, resolvidos, continuam = secoes[rotulo]["novos"], secoes[rotulo]["resolvidos"], secoes[rotulo]["continuam"]
                linha: Dict[str, Any] = {
                    "secao": rotulo, "anterior": continuam + len(resolvidos), "atual": continuam + len(novos),
                    "novos": len(novos), "resolvidos": len(resolvidos), "continuam": continuam,
                }
                if novos and exemplos:
                    linha["exemplos_novos"] = [_exemplo_comparacao(i) for i in novos[:exemplos]]
                if resolvidos and exemplos:
                    linha["exemplos_resolvidos"] = [_exemplo_comparacao(i) for i in resolvidos[:exemplos]]
                linhas.append(linha)
            saida_pontos = []
            for ponto, limite, evento in ordenados:
                saida: Dict[str, Any] = {"pedido": ponto, "evento_id": str(evento["id"]), "horario": str(evento["horario"])}
                if limite is not None and str(evento["horario"])[: len(ponto)] != ponto:
                    saida["observacao"] = f"Sem atualização em {ponto}; usada a mais recente até essa data."
                resumo = _dict(evento.get("resumo"))
                for campo, destino in (("total_endpoint", "linhas_no_endpoint"), ("total_detalhes", "linhas_na_simpress")):
                    if isinstance(resumo.get(campo), int):
                        saida[destino] = resumo[campo]
                saida_pontos.append(saida)
            return {
                "ponto_anterior": saida_pontos[0], "ponto_atual": saida_pontos[1],
                "total_novos": sum(len(s["novos"]) for s in secoes.values()),
                "total_resolvidos": sum(len(s["resolvidos"]) for s in secoes.values()),
                "secoes": linhas, "exemplos_por_lista": exemplos,
                "limitacoes": [
                    "Compara só atualizações salvas no histórico de planilhas; mês e data viram a atualização mais recente até o fim do período. Não há retrato do inventário em outras datas.",
                    "novos = apareceram na seção (piora); resolvidos = saíram dela (melhora). Não há lista item a item de apelidos atualizados, de mudanças de usuário nem de alterações de equipamento entre os dois pontos.",
                ],
            }

        resultado = montar(MAX_EXEMPLOS_COMPARACAO)
        for exemplos in (5, 3, 1, 0):
            if len(json.dumps(resultado, ensure_ascii=False)) <= ORCAMENTO_COMPARACAO:
                break
            resultado = montar(exemplos)
        return resultado

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

    def vincular_os(self, fonte: Any, serie: Any, ordem: Any, chamado: Any) -> Dict[str, Any]:
        """Save one link. The route upserts just this item (the others stay), so nothing else is sent."""
        try:
            corpo = validar_vinculo_os(fonte, serie, ordem, chamado)
        except ValueError as falha:
            return {"sucesso": False, "erro": str(falha)}
        ok, dados = self._chamar("PUT", "/api/operacoes/chamados/vinculos-os", corpo=corpo)
        if not ok:
            return {"sucesso": False, "erro": dados}
        return {"sucesso": True, "mensagem": f"OS {corpo['os']} da série {corpo['serie']} vinculada ao chamado UTIC-{corpo['ano']}-{corpo['numero']}."}

    def contato_origem_atual(self) -> Dict[str, Any]:
        """The origin contact as the transfer screen sees it (real values: only for the card and the merge). ValueError if unreadable."""
        ok, dados = self._chamar("GET", "/api/config/transferencia")
        if not ok:
            raise ValueError(dados)
        return _dict(dados)

    def ver_contato_origem(self) -> Dict[str, Any]:
        """Values go out under sensitive keys, so the conversation's mask turns them into markers; sources use neutral keys."""
        try:
            atual = self.contato_origem_atual()
        except ValueError as falha:
            return {"erro": str(falha)}
        fontes = _dict(atual.get("contato_origem_fontes"))
        return {
            "retirada_contato": str(atual.get("retirada_contato") or ""),
            "email": str(atual.get("retirada_email") or ""),
            "retirada_telefone": str(atual.get("retirada_telefone") or ""),
            "configurado": bool(atual.get("contato_origem_configurado")),
            "fonte_contato": str(fontes.get("retirada_contato") or ""),
            "fonte_email": str(fontes.get("retirada_email") or ""),
            "fonte_telefone": str(fontes.get("retirada_telefone") or ""),
            "arquivo_invalido": bool(atual.get("contato_origem_arquivo_invalido")),
        }

    def alterar_contato_origem(self, contato: Any, email: Any, telefone: Any) -> Dict[str, Any]:
        try:
            corpo, mudancas = montar_contato_origem(self.contato_origem_atual(), contato, email, telefone)
        except ValueError as falha:
            return {"sucesso": False, "erro": str(falha)}
        ok, dados = self._chamar("PUT", "/api/config/transferencia/contato-origem", corpo=corpo)
        if not ok:
            return {"sucesso": False, "erro": dados}
        return {"sucesso": True, "mensagem": f"Contato de origem atualizado ({', '.join(m[0] for m in mudancas)})."}

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

    def _gravar_anotacao(self, caminho: str, anotacao: Any, sucesso: str) -> Dict[str, Any]:
        try:
            texto = validar_anotacao(anotacao)
        except ValueError as falha:
            return {"sucesso": False, "erro": str(falha)}
        ok, dados = self._chamar("PUT", caminho, corpo={"anotacao": texto})
        return {"sucesso": True, "mensagem": sucesso} if ok else {"sucesso": False, "erro": dados}

    def anotar_linha_historico(self, evento_id: str, item_id: str, anotacao: Any) -> Dict[str, Any]:
        evento_id, item_id = str(evento_id).strip(), str(item_id).strip()
        if not _ID_ROTA.match(evento_id) or not _ID_ROTA.match(item_id):
            return {"sucesso": False, "erro": "Identificador da linha do histórico inválido."}
        return self._gravar_anotacao(
            f"/api/historico-comparacoes/{evento_id}/anotacoes/{item_id}", anotacao, "Anotação gravada na linha do histórico.",
        )

    def anotar_linha_do_tempo(self, evento_id: str, item_id: str, anotacao: Any) -> Dict[str, Any]:
        evento_id, item_id = str(evento_id).strip(), str(item_id).strip()
        if not _ID_ROTA.match(evento_id) or not _ID_ROTA.match(item_id):
            return {"sucesso": False, "erro": "Identificador da linha do tempo inválido."}
        return self._gravar_anotacao(
            f"/api/operacoes/chamados/linha-do-tempo/{evento_id}/{item_id}", anotacao, "Anotação gravada na linha do tempo.",
        )

    # --- undo / restore / delete (destructive: always behind a confirmation card) ---

    def listar_eventos_comparacao(self, limite: Any = 10) -> Dict[str, Any]:
        """Ids of the history events (newest first); the destructive tools need them."""
        ok, dados = self._chamar("GET", "/api/historico-comparacoes")
        if not ok:
            return {"erro": dados}
        eventos = [e for e in _dict(dados).get("eventos") or [] if isinstance(e, dict)]
        itens = [{k: e.get(k) for k in ("id", "horario", "tipo", "restauravel") if e.get(k) is not None} for e in eventos[: self._limite(limite, 10)]]
        return {"total": len(eventos), "eventos": _aparar(itens)}

    def evento_comparacao(self, evento_id: str) -> Optional[Dict[str, Any]]:
        evento_id = str(evento_id or "").strip()
        if not _ID_ROTA.match(evento_id):
            return None
        ok, dados = self._chamar("GET", "/api/historico-comparacoes")
        eventos = _dict(dados).get("eventos") if ok else None
        return next((e for e in eventos or [] if isinstance(e, dict) and e.get("id") == evento_id), None)

    def evento_alteracao(self, evento_id: str) -> Optional[Dict[str, Any]]:
        evento_id = str(evento_id or "").strip()
        if not _ID_ROTA.match(evento_id):
            return None
        ok, dados = self._chamar("GET", "/api/historico-alteracoes")
        eventos = _dict(dados).get("eventos") if ok else None
        return next((e for e in eventos or [] if isinstance(e, dict) and e.get("id") == evento_id), None)

    def previa_restauracao(self, evento_id: str) -> Dict[str, Any]:
        """Preview of a restore; keeps the server's token so the confirmed POST is bound to what the card showed.

        Raises ValueError (text for the model) when the event cannot be restored."""
        evento_id = str(evento_id or "").strip()
        if not _ID_ROTA.match(evento_id):
            raise ValueError("Identificador do histórico inválido.")
        ok, dados = self._chamar("GET", f"/api/historico-comparacoes/{evento_id}/restauracao")
        if not ok:
            raise ValueError(str(dados))
        previa = _dict(dados)
        if not previa.get("preview_token"):
            raise ValueError("O Simpress não devolveu a prévia da restauração.")
        self._tokens_restauracao[evento_id] = str(previa["preview_token"])
        return previa

    def restaurar_comparacao(self, evento_id: str) -> Dict[str, Any]:
        evento_id = str(evento_id or "").strip()
        token = self._tokens_restauracao.pop(evento_id, "")
        if not _ID_ROTA.match(evento_id) or not token:
            return {"sucesso": False, "erro": "Prévia da restauração ausente. Peça a restauração de novo."}
        ok, dados = self._chamar("POST", f"/api/historico-comparacoes/{evento_id}/restaurar", corpo={"preview_token": token})
        return {"sucesso": True, "mensagem": "Conjunto de planilhas restaurado."} if ok else {"sucesso": False, "erro": dados}

    def _evento_simples(self, metodo: str, caminho: str, corpo: Optional[Dict[str, Any]], sucesso: str) -> Dict[str, Any]:
        ok, dados = self._chamar(metodo, caminho, corpo=corpo)
        return {"sucesso": True, "mensagem": sucesso} if ok else {"sucesso": False, "erro": dados}

    def desfazer_apelido(self, evento_id: str) -> Dict[str, Any]:
        evento_id = str(evento_id or "").strip()
        if not _ID_ROTA.match(evento_id):
            return {"sucesso": False, "erro": "Identificador do evento inválido."}
        return self._evento_simples("POST", "/api/equipamento/apelido/desfazer", {"evento_id": evento_id}, "Alteração desfeita; a reversão foi registrada no histórico.")

    def excluir_evento_alteracao(self, evento_id: str) -> Dict[str, Any]:
        evento_id = str(evento_id or "").strip()
        if not _ID_ROTA.match(evento_id):
            return {"sucesso": False, "erro": "Identificador do evento inválido."}
        return self._evento_simples("DELETE", f"/api/historico-alteracoes/{evento_id}", None, "Evento excluído do histórico de alterações.")

    def excluir_comparacao(self, evento_id: str) -> Dict[str, Any]:
        evento_id = str(evento_id or "").strip()
        if not _ID_ROTA.match(evento_id):
            return {"sucesso": False, "erro": "Identificador do evento inválido."}
        return self._evento_simples("DELETE", f"/api/historico-comparacoes/{evento_id}", None, "Atualização excluída do Histórico de Planilhas.")

    # --- hostnames descartados das duplicidades do Endpoint ---

    def _removidos_endpoint(self) -> Optional[List[Dict[str, Any]]]:
        ok, dados = self._chamar("GET", "/api/endpoint/hostnames-removidos")
        if not ok:
            return None
        return [e for e in _dict(dados).get("removidos") or [] if isinstance(e, dict)]

    def listar_hostnames_removidos(self, limite: Any = MAX_ITENS_LISTA) -> Dict[str, Any]:
        removidos = self._removidos_endpoint()
        if removidos is None:
            return {"erro": "Não foi possível consultar os hostnames removidos do Endpoint."}
        corte = self._limite(limite, MAX_ITENS_LISTA)
        itens = [{k: str(e.get(k) or "") for k in ("serie", "hostname", "removido_em")} for e in removidos[:corte]]
        return {"total": len(removidos), "itens": _aparar(itens), "omitidos": max(0, len(removidos) - corte)}

    def hostname_removido(self, serie: str, hostname: str) -> bool:
        """True when the pair is in the discarded list (same case-insensitive match the server uses)."""
        par = (str(serie).strip().casefold(), str(hostname).strip().casefold())
        return any((str(e.get("serie") or "").strip().casefold(), str(e.get("hostname") or "").strip().casefold()) == par for e in self._removidos_endpoint() or [])

    def _hostname_removal(self, caminho: str, serie: str, hostname: str, sucesso: str) -> Dict[str, Any]:
        serie, hostname = str(serie or "").strip(), str(hostname or "").strip()
        if not serie or not hostname:
            return {"sucesso": False, "erro": "Informe a série e o hostname."}
        return self._evento_simples("POST", caminho, {"serie": serie, "hostname": hostname}, sucesso)

    def remover_hostname_endpoint(self, serie: str, hostname: str) -> Dict[str, Any]:
        return self._hostname_removal("/api/endpoint/hostnames-removidos", serie, hostname, "Hostname marcado como removido; o outro da série passa a valer.")

    def restaurar_hostname_endpoint(self, serie: str, hostname: str) -> Dict[str, Any]:
        return self._hostname_removal("/api/endpoint/hostnames-removidos/restaurar", serie, hostname, "Hostname restaurado nas duplicidades do Endpoint.")
