"""The assistant's access to Simpress data: the same routes the screens use, called inside this process.

The loopback transport lives in `assistant_transporte`, the validators in `assistant_validacao`, the helpers shared with the
theme mixins in `assistant_api_comum`, the Sebrae/F5 tools in `assistant_api_sebrae` (`SebraeMixin`), the history and
comparison reads in `assistant_api_historico` (`HistoricoMixin`), the regional reads (representatives, Cobertura,
regional backups) in `assistant_api_regionais` (`RegionaisMixin`) and the automation tools (UX ticket, Dashboard schedule,
Chrome routines, SoftExpert, comparison restore, ticket imports history) in `assistant_api_automacao` (`AutomacaoMixin`);
names used elsewhere are re-exported here.
`SimpressApi` shapes each answer for the model: short lists, labels approved in AGENTS.md and personal data cleaned with
`limpar_texto_sensivel`.
"""

import asyncio
import logging
import re
from collections import Counter
from typing import Any, Dict, List, Optional, Set, Tuple, Union

from domains.os_observacoes import chave_os
from core.errors import DomainValidationError
from domains.assistant_lgpd import e_solicitante_sistema, limpar_texto_sensivel
from domains.local_setup import REGIONAL_REPRESENTATIVE_CITIES
from domains.assistant_api_automacao import MOTIVOS_AUTOMACAO, ROTINAS_VALIDAS, AutomacaoMixin  # noqa: F401  (re-exported: callers and tests import these names from here)
from domains.assistant_api_comum import (  # noqa: F401  (re-exported: callers and tests import these names from here)
    _ID_ROTA, _MOTIVOS, MAX_ITENS_LISTA, MAX_TEXTO_CHAMADO, _aparar, _marcas_de, _motivo_codigo, _observacao_de,
    e_macbook, sanitizar_equipamento,
)
from domains.assistant_api_historico import HistoricoMixin, _exemplo_comparacao, _rotular_item  # noqa: F401  (re-exported: callers and tests import these names from here)
from domains.assistant_api_regionais import RegionaisMixin
from domains.assistant_api_sebrae import SebraeMixin
from domains.assistant_transporte import ArquivoUpload, Transport, asgi_transport  # noqa: F401  (re-exported: callers and tests import these names from here)
from domains.assistant_validacao import (  # noqa: F401  (re-exported: callers and tests import these names from here)
    ACOES_APELIDO_MANUAL, DECISOES_VALIDAS, FONTES_VINCULO_OS, MAX_ANOTACAO, _dict, diferencas_representante, montar_contato_origem,
    montar_representante_regional, representante_efetivo, representante_padrao, resolver_cidade_representante, validar_anotacao,
    validar_transferencia, validar_vinculo_os,
)

logger = logging.getLogger(__name__)

AVISO_BACKUPS_NO_PAINEL = "Omitido aqui (lista longa); para os Backups regionais use a ferramenta `listar_backups_regionais`."
# Page cap (100 items each) when loading base names for the privacy mask.
# shortcut: above 20,000 equipment rows with a user the name list is partial; raise it if the base grows.
MAX_PAGINAS_NOMES = 200
MAX_APELIDO = 160
MAX_LINHAS_SEBRAE_MENSAL = 5  # obter_relatorio_mensal: tickets of the month sent along with the F5 counts


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


# Error bodies reach the model: besides the LGPD mask, drop what it does not cover (URLs, tokens, cookies, local paths). Free names stay uncovered.
_SEGREDO_NO_ERRO = re.compile(
    r"(?i)(?:https?://\S+|bearer\s+[\w.~+/=-]+|eyJ[\w-]{5,}\.[\w.-]+|(?:cookie|set-cookie|authorization)\s*[:=]\s*[^\n;]+"
    r"|(?:token|access_token|api[_-]?key|secret|sessao|session)\s*[=:]\s*[^\s&;,]+|sk-[\w-]{8,}"
    r"|[A-Za-z]:\\[^\s\"']+|\\\\[^\s\"']+|\?[^\s\"']*=[^\s\"']*)"
)


def _texto_erro_seguro(texto: Any) -> str:
    return _SEGREDO_NO_ERRO.sub("[OMITIDO]", limpar_texto_sensivel(texto))[:300]


# Same texts as the OS tab (F6); an unknown code gives "", so no free text from the registry reaches the model.
MOTIVOS_MARCA_OS = {
    "saiu_do_dashboard": "Saiu da lista de abertos do Dashboard sem finalização pelo site.",
    "nao_encontrado_softexpert": "Não encontrado no SoftExpert na última leitura.",
}


def _sinais_os(chamado: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """Badges of the OS tab (F6) per Oracle OS of this serial: any `envio_tecnico`, the largest `dias_aberta`. Never the description."""
    sinais: Dict[str, Dict[str, Any]] = {}
    for oracle in chamado.get("oracle") or []:
        os_ = str(oracle.get("ordem_servico") or "").strip() if isinstance(oracle, dict) else ""
        if not os_:
            continue
        atual = sinais.setdefault(os_, {"envio_tecnico": False, "dias_aberta": None})
        atual["envio_tecnico"] = atual["envio_tecnico"] or oracle.get("envio_tecnico") is True
        dias = oracle.get("dias_aberta")
        if type(dias) is int and (atual["dias_aberta"] is None or dias > atual["dias_aberta"]):
            atual["dias_aberta"] = dias
    return sinais


class SimpressApi(SebraeMixin, HistoricoMixin, RegionaisMixin, AutomacaoMixin):
    """Queries and actions the assistant tools run against Simpress."""

    def __init__(self, transport: Transport) -> None:
        self._transport = transport
        self._tokens_restauracao: Dict[str, str] = {}
        self._leituras: Optional[List[Any]] = None

    def gravar_leituras(self) -> None:
        """Start keeping the raw answers of the next calls (the card builder reads values the model must not see)."""
        self._leituras = []

    def recolher_leituras(self) -> List[Any]:
        leituras, self._leituras = self._leituras or [], None
        return leituras

    # --- plumbing ---------------------------------------------------------

    def _chamar(
        self, metodo: str, caminho: str, params: Optional[Dict[str, Any]] = None, corpo: Union[Dict[str, Any], ArquivoUpload, None] = None,
    ) -> Tuple[bool, Any]:
        """Return (True, data) or (False, error text). Never raises."""
        try:
            status, dados = self._transport(metodo, caminho, params, corpo)
        except asyncio.TimeoutError:
            return False, "O Simpress demorou demais para responder."
        except Exception:
            if caminho.startswith("/api/ux/abrir-chamado/"):
                logger.warning("Falha na chamada interna do Assistente para abrir chamado no UX.")
            else:
                logger.exception("Falha na chamada interna do assistente: %s %s", metodo, caminho)
            return False, "Falha ao consultar o Simpress."
        if 200 <= status < 300:
            if self._leituras is not None:
                self._leituras.append(dados)
            return True, dados if dados is not None else {}
        return False, self._erro_http(status, dados)

    @staticmethod
    def _erro_http(status: int, dados: Any) -> str:
        detalhe = dados.get("detail") if isinstance(dados, dict) else None
        if isinstance(detalhe, list):
            detalhe = "; ".join(str(d.get("msg", d)) if isinstance(d, dict) else str(d) for d in detalhe)
        if isinstance(detalhe, dict):  # {codigo, mensagem} (ex.: cobertura com estado ilegível)
            detalhe = detalhe.get("mensagem")
        texto = detalhe if isinstance(detalhe, str) else (dados[:200] if isinstance(dados, str) else "")
        return f"Erro {status} do Simpress: {_texto_erro_seguro(texto)}"

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

    def consultar_endpoint(self, serial: str) -> Dict[str, Any]:
        """The same read-only Chrome lookup used by Home; the conversation masks ultimo_logon."""
        clean = serial.strip().upper()
        if not clean:
            return {"erro": "Número de série não informado."}
        ok, dados = self._chamar("POST", "/api/endpoint/consultar", corpo={"serial": clean})
        if not ok:
            return {"erro": dados}
        if not isinstance(dados, dict) or dados.get("status") not in ("found", "not_found", "ambiguous"):
            return {"erro": "Não foi possível confirmar o resultado do Endpoint."}
        return {key: dados[key] for key in ("status", "serial", "ultimo_logon", "origem") if key in dados}

    def abrir_controle_remoto(self, serial: str) -> Dict[str, Any]:
        """The Home "Controle remoto" button: opens the remote-control session (reason "acesso") and leaves it open for the user."""
        clean = serial.strip().upper()
        if not clean:
            return {"sucesso": False, "erro": "Número de série não informado."}
        ok, dados = self._chamar("POST", "/api/endpoint/controle-remoto", corpo={"serial": clean})
        if not ok:
            return {"sucesso": False, "erro": dados}
        status = dados.get("status") if isinstance(dados, dict) else None
        host = f" ({dados['hostname']})" if status in ("connected", "offline") and dados.get("hostname") else ""
        mensagens = {
            "connected": f"Controle remoto solicitado{host}. A conexão ficou aberta no Chrome de automação para o usuário continuar; nada foi fechado.",
            "offline": f"O computador{host} está offline no Endpoint: o controle remoto não está disponível.",
            "not_found": "Equipamento não encontrado no Endpoint.",
            "ambiguous": "Não foi possível identificar um único equipamento no Endpoint para esta série. O controle remoto não foi aberto.",
        }
        if status not in mensagens:
            return {"sucesso": False, "erro": "Não foi possível confirmar o resultado do Endpoint."}
        return {"sucesso": status == "connected", "status": status, "serial": clean, "mensagem": mensagens[status],
                **({"hostname": dados["hostname"]} if "hostname" in dados else {})}

    def abrir_powershell_endpoint(self, comando: str, modo: str, hostname: str, usuario: str = "") -> Dict[str, Any]:
        """Home "PowerShell no Endpoint": INSERTS the command in the prompt; never presses Enter. The command text never comes back to the model."""
        hostname = hostname.strip()
        if not hostname:  # no default computer: the model must ask the user which one
            return {"sucesso": False, "erro": "Informe o hostname do computador. Nada foi inserido."}
        corpo: Dict[str, Any] = {"modo": modo, "comando": comando, "hostname": hostname}
        if usuario.strip():
            corpo["usuario"] = usuario.strip()
        ok, dados = self._chamar("POST", "/api/endpoint/powershell", corpo=corpo)
        if not ok:
            return {"sucesso": False, "erro": dados}
        if not isinstance(dados, dict):
            return {"sucesso": False, "erro": "Não foi possível confirmar o resultado do Endpoint."}
        status = dados.get("status")
        host = dados.get("hostname") or hostname
        usuarios = [str(u) for u in dados.get("usuarios", [])] if isinstance(dados.get("usuarios"), list) else []
        mensagens = {
            "inserido": f"Comando inserido no prompt do PowerShell de {host}, mas NÃO executado: o usuário revisa e aperta Enter no terminal do Chrome.",
            "not_found": f"Computador {host} não encontrado no Endpoint. Nada foi inserido.",
            "erro_terminal": str(dados.get("mensagem") or f"Não foi possível abrir o PowerShell em {host}. Nada foi inserido."),
            "offline": f"O notebook {host} está offline no Endpoint. Nada foi inserido.",
            "sem_usuario": f"Usuário não encontrado em {host}. Nada foi inserido.",
            "usuario_ambiguo": f"Há mais de um usuário logado em {host}; peça ao usuário qual usar. Nada foi inserido.",
        }
        if status not in mensagens:
            return {"sucesso": False, "erro": "Não foi possível confirmar o resultado do Endpoint."}
        resultado: Dict[str, Any] = {"sucesso": status == "inserido", "status": status, "hostname": host, "modo": modo,
                                     "tamanho_comando": len(comando), "mensagem": mensagens[status], "enter_enviado": False}
        if status == "inserido":
            resultado["usuario"] = dados.get("usuario")
        if usuarios:
            resultado["usuarios"] = usuarios
        return resultado

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

    def listar_nomes_representantes(self) -> List[str]:
        """Names of the regional representatives, default and edited, so the mask recognises them in the chat.

        The saved edits are read on every call: a name edited on the screen mid-conversation is masked from the next message.
        """
        try:
            salvos, _, padroes = self._representantes_salvos()
        except ValueError:
            # Route down: read the local defaults file directly, or the real names would reach the model unmasked.
            from core.config import REGIONAL_REPRESENTATIVE_DEFAULTS_FILE
            from domains.local_setup import effective_regional_representative_defaults

            salvos = {}
            padroes, _ = effective_regional_representative_defaults(REGIONAL_REPRESENTATIVE_DEFAULTS_FILE)
        padrao = [representante_padrao(c, padroes)["nome"] for c in REGIONAL_REPRESENTATIVE_CITIES]
        editados = [representante_efetivo(c, salvos, padroes)[0]["nome"] for c in REGIONAL_REPRESENTATIVE_CITIES]
        return list(dict.fromkeys(n for n in padrao + editados if n))

    def listar_nomes_solicitantes_sebrae(self) -> Optional[List[str]]:
        """Requesters of the Sebrae tickets (old open and new), so the mask knows their full names inside free text. None on failure.

        Same route the ticket tools read. Only values with a space (a full name) go in: a lone word such as "SEBRAE" or a login
        would turn into a marker everywhere in the conversation.
        """
        ok, dados = self._chamar("GET", "/api/sebrae/novos")
        if not ok:
            return None
        dados = _dict(dados)
        valores: List[Any] = []
        for aberto in _dict(dados.get("importado")).get("abertos") or []:
            aberto = _dict(aberto)
            valores += [aberto.get("usuario"), _dict(aberto.get("leitura_softexpert")).get("solicitante")]
        for novo in _dict(dados.get("novos")).get("formulario") or []:
            valores.append(_dict(_dict(novo).get("linha")).get("I"))
        # "API SEBRAE" é solicitante de sistema, não pessoa: entrar na base mascararia "Sebrae" em todo o texto.
        return list(dict.fromkeys(v.strip() for v in valores if isinstance(v, str) and len(v.split()) > 1 and not e_solicitante_sistema(v)))

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
        notas, aviso_notas = self._observacoes_os()
        marcas, aviso_marcas = self._marcas_finalizacao()
        itens = []
        for ch in chamados[:MAX_ITENS_LISTA]:
            item = sanitizar_chamado(ch)
            if isinstance(ch, dict):
                ordens = [o.get("ordem_servico") for o in ch.get("oracle") or [] if isinstance(o, dict)] + list(item["ordens_servico"] or [])
                # Same key as the "Observação do andamento" box of the OS tab (F6): only the OS of this serial that have a note.
                item["observacao_os"] = {str(o): limpar_texto_sensivel(n)[:MAX_TEXTO_CHAMADO]
                                         for o in ordens if (n := _observacao_de(notas, ch.get("serie"), o))}
                # Marks "OS finalizada" of the same tab, per OS of this serial (several tickets can mark one OS).
                item["marcas_finalizacao"] = {str(o): m for o in ordens if (m := _marcas_de(marcas, ch.get("serie"), o))}
                # Badges "Técnico" / "Aberta há N dias" of the same tab, per Oracle OS (booleans and integers only).
                if sinais := _sinais_os(ch):
                    item["sinais_os"] = sinais
            itens.append(item)
        resultado = {
            "atualizado_em": dados.get("atualizado_em", ""),
            "total_chamados": len(chamados),
            "resumo": dados.get("resumo", {}),
            "chamados": itens,
        }
        if aviso_notas:
            resultado["aviso_observacoes"] = aviso_notas
        if aviso_marcas:
            resultado["aviso_marcas"] = aviso_marcas
        return resultado

    def obter_painel(self) -> Dict[str, Any]:
        ok, dados = self._chamar("GET", "/api/painel")
        if not ok:
            return {"erro": dados}
        if isinstance(dados, dict) and "backups_regionais" in dados:
            # Long (alias and excluded lists) and may carry a person's name: only `listar_backups_regionais` reads it, by allowlist.
            dados = {k: AVISO_BACKUPS_NO_PAINEL if k == "backups_regionais" else v for k, v in dados.items()}
        if isinstance(dados, dict) and "lembretes_agendados" in dados:
            # Os Lembretes ficam fora do Assistente: a contagem do sino não é lida por ele.
            dados = {k: v for k, v in dados.items() if k != "lembretes_agendados"}
        # The size cut happens after the privacy mask, in the conversation.
        return {"dados": _aparar(dados)}

    def obter_prontidao(self) -> Dict[str, Any]:
        return self._leitura("/api/prontidao")

    def obter_saude_local(self) -> Dict[str, Any]:
        # Read-only: the prévia, the cleanup and the diagnostic package stay on the screen only.
        return self._leitura("/api/saude-local")

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
        ok, dados = self._chamar("GET", "/api/relatorio-mensal/dados", params={"mes": mes})
        if not ok:
            return {"erro": dados}
        dados = dict(_dict(dados))
        sebrae = dados.pop("sebrae", None)
        if isinstance(sebrae, dict) and isinstance(sebrae.get("linhas"), list):
            linhas = sebrae["linhas"]
            sebrae = {**sebrae, "linhas": linhas[:MAX_LINHAS_SEBRAE_MENSAL],
                      "linhas_omitidas": max(0, len(linhas) - MAX_LINHAS_SEBRAE_MENSAL)}
        # The chat keeps only the first MAX_CARACTERES_RESPOSTA characters and the rest of the report is longer: F5 first.
        return {"dados": _aparar({"sebrae": sebrae, **dados})}

    def _vinculos_os(self) -> Tuple[bool, Any]:
        ok, dados = self._chamar("GET", "/api/operacoes/chamados/vinculos-os")
        if not ok:
            return False, dados
        return True, [v for v in _dict(dados).get("vinculos") or [] if isinstance(v, dict)]

    def _observacoes_os(self) -> Tuple[Dict[str, str], Optional[str]]:
        """(note per `chave_os`, None) or ({}, short warning): a failed read never breaks the tool that asked."""
        ok, dados = self._chamar("GET", "/api/operacoes/chamados/observacoes")
        if not ok:
            return {}, "Não foi possível consultar as observações da aba OS (F6) agora."
        notas: Dict[str, str] = {}
        for o in _dict(dados).get("observacoes") or []:
            if isinstance(o, dict) and (texto := str(o.get("observacao") or "")):
                try:
                    notas[chave_os(o.get("serie"), o.get("os"))] = texto
                except DomainValidationError:
                    continue
        return notas, None

    def _marcas_finalizacao(self) -> Tuple[Dict[str, List[Dict[str, Any]]], Optional[str]]:
        """(marks per `chave_os`, None) or ({}, short warning): a failed read never breaks the tool that asked. Read only."""
        ok, dados = self._chamar("GET", "/api/operacoes/chamados/marcas-finalizacao")
        if not ok:
            return {}, "Não foi possível consultar as marcas de OS finalizada da aba OS (F6) agora."
        marcas: Dict[str, List[Dict[str, Any]]] = {}
        for m in _dict(dados).get("marcas") or []:
            if not isinstance(m, dict):
                continue
            try:
                chave = chave_os(m.get("serie"), m.get("os"))
            except DomainValidationError:
                continue
            marcas.setdefault(chave, []).append({
                "chamado": str(m.get("chamado") or ""),
                "origem": "outro_tecnico" if m.get("origem") == "outro_tecnico" else "site",
                "motivo": MOTIVOS_MARCA_OS.get(str(m.get("motivo") or ""), ""),
                "ativa": m.get("ativa") is not False,
                "conferido": bool(m.get("conferido_em")),
            })
        return marcas, None

    def listar_vinculos_os(self, serie: Any = "", chamado: Any = "") -> Dict[str, Any]:
        """Links ticket <-> OS (manual, automatic from the finalization mark, or from the Dashboard), optionally filtered by serial or ticket (the route has no filter)."""
        ok, vinculos = self._vinculos_os()
        if not ok:
            return {"erro": vinculos}
        serie, chamado = str(serie or "").strip().upper(), str(chamado or "").strip().upper()
        itens = [
            {**{k: limpar_texto_sensivel(v.get(k, "")) for k in ("fonte", "serie", "os", "chamado")},
             "origem": v.get("origem") if v.get("origem") in ("finalizacao", "dashboard") else "manual"} for v in vinculos
            if (not serie or str(v.get("serie", "")).strip().upper() == serie) and (not chamado or str(v.get("chamado", "")).upper() == chamado)
        ]
        resultado: Dict[str, Any] = {"total": len(itens), "vinculos": itens[:MAX_ITENS_LISTA]}
        if len(itens) > MAX_ITENS_LISTA:
            resultado["aviso"] = f"Mostrando só os {MAX_ITENS_LISTA} primeiros; filtre por série ou chamado."
        return resultado

    def vinculo_os_atual(self, fonte: str, serie: str, ordem: str) -> Optional[Dict[str, Any]]:
        """The current link of this source+serial+OS (manual first, else automatic: see `origem`; same normalization as the route key), None when there is none. ValueError if the list cannot be read."""
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

    def listar_pendencias_usuarios(self) -> Dict[str, Any]:
        return self._leitura("/api/usuarios/pendencias")

    def estado_usuarios_entra(self) -> Dict[str, Any]:
        return self._leitura("/api/usuarios-entra/estado")

    @staticmethod
    def _limite(limite: Any, padrao: int) -> int:
        try:
            return max(1, min(int(limite), MAX_ITENS_LISTA))
        except (TypeError, ValueError):
            return padrao

    # --- actions that change data (only after the user confirms) -----------

    def _acao(self, caminho: str, corpo: Optional[Dict[str, Any]], sucesso: str) -> Dict[str, Any]:
        ok, dados = self._chamar("POST", caminho, corpo=corpo if corpo is not None else {})
        if not ok:
            return {"sucesso": False, "erro": dados}
        return {"sucesso": True, "mensagem": sucesso}

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

    def alterar_representante_regional(self, cidade: Any, nome: Any, email: Any, telefone: Any, horario: Any, almoco: Any, pausa: Any) -> Dict[str, Any]:
        try:
            cidade, corpo, mudancas = self.montar_alteracao_representante(cidade, nome, email, telefone, horario, almoco, pausa)
        except ValueError as falha:
            return {"sucesso": False, "erro": str(falha)}
        ok, dados = self._chamar("PUT", f"/api/config/representantes-regionais/{cidade}", corpo=corpo)
        if not ok:
            return {"sucesso": False, "erro": dados}
        return {"sucesso": True, "mensagem": f"Representante regional de {cidade} atualizado ({', '.join(m[0] for m in mudancas)})."}

    def restaurar_representante_regional(self, cidade: Any) -> Dict[str, Any]:
        try:
            cidade, _, alterado, _ = self.representante_regional_atual(cidade)
        except ValueError as falha:
            return {"sucesso": False, "erro": str(falha)}
        if not alterado:
            return {"sucesso": False, "erro": "Esta cidade não tem alteração salva. Nada a restaurar."}
        ok, dados = self._chamar("DELETE", f"/api/config/representantes-regionais/{cidade}")
        if not ok:
            return {"sucesso": False, "erro": dados}
        return {"sucesso": True, "mensagem": f"Representante regional de {cidade} restaurado ao padrão."}

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

    def _hostname_removal(self, caminho: str, serie: str, hostname: str, sucesso: str) -> Dict[str, Any]:
        serie, hostname = str(serie or "").strip(), str(hostname or "").strip()
        if not serie or not hostname:
            return {"sucesso": False, "erro": "Informe a série e o hostname."}
        return self._evento_simples("POST", caminho, {"serie": serie, "hostname": hostname}, sucesso)

    def remover_hostname_endpoint(self, serie: str, hostname: str) -> Dict[str, Any]:
        return self._hostname_removal("/api/endpoint/hostnames-removidos", serie, hostname, "Hostname marcado como removido; o outro da série passa a valer.")

    def restaurar_hostname_endpoint(self, serie: str, hostname: str) -> Dict[str, Any]:
        return self._hostname_removal("/api/endpoint/hostnames-removidos/restaurar", serie, hostname, "Hostname restaurado nas duplicidades do Endpoint.")

    # --- usuário logado (leituras) ---

    def pessoa_da_serie(self, serial: str) -> Optional[Dict[str, Any]]:
        """Raw answer of the logged-user lookup for one serial (names stay on the confirmation card, never go to the model)."""
        serial = str(serial or "").strip().upper()
        if not serial:
            return None
        ok, dados = self._chamar("POST", "/api/equipamentos/usuarios-logados", corpo={"series": [serial]})
        item = _dict(_dict(dados).get("usuarios")).get(serial) if ok else None
        return item if isinstance(item, dict) else None

    def usuarios_logados(self, series: Any) -> Dict[str, Any]:
        """Logged user and person name of up to MAX_ITENS_LISTA serials. Only fields the privacy mask knows go out."""
        lista = series if isinstance(series, list) else [series]
        pedidas = list(dict.fromkeys(str(s).strip().upper() for s in lista if str(s or "").strip()))[:MAX_ITENS_LISTA]
        if not pedidas:
            return {"erro": "Informe ao menos uma série."}
        ok, dados = self._chamar("POST", "/api/equipamentos/usuarios-logados", corpo={"series": pedidas})
        if not ok:
            return {"erro": dados}
        itens: List[Dict[str, Any]] = []
        for serie, bruto in _dict(_dict(dados).get("usuarios")).items():
            d = _dict(bruto)
            item = {
                "serie": serie, "usuario_logado": d.get("usuario", ""), "nome_pessoa": d.get("nome_pessoa", ""),
                "origem": d.get("origem", ""), "computador": d.get("hostname", ""),
                "computador_ambiguo": bool(d.get("hostname_ambiguo")),
            }
            if d.get("pendencia"):
                item["pendencia"] = limpar_texto_sensivel(d["pendencia"])
            itens.append(item)
        return {"total": len(itens), "itens": _aparar(itens)}

    # --- valor atual para o cartão de confirmação (cru: só vai à tela, nunca ao modelo) ---

    def equipamento_atual(self, serial: str) -> Optional[Dict[str, Any]]:
        """The row the write will hit, exactly by serial; None when it cannot be read."""
        serial = str(serial or "").strip().upper()
        if not _ID_ROTA.match(serial):
            return None
        ok, dados = self._chamar("GET", f"/api/equipamento/{serial}")
        return dados if ok and isinstance(dados, dict) else None

    def unidade_atual(self, unidade_id: Any) -> Optional[Dict[str, Any]]:
        unidades = self.listar_unidades().get("unidades") or []
        return next((u for u in unidades if str(u.get("id")) == str(unidade_id).strip()), None)

    def total_importacoes_chamados(self) -> Optional[int]:
        ok, dados = self._chamar("GET", "/api/operacoes/chamados/historico")
        total = _dict(dados).get("total") if ok else None
        return total if isinstance(total, int) else None

    # --- alterações novas (sempre atrás do cartão de confirmação) ---

    def registrar_transferencia(self, campos: Dict[str, Any]) -> Dict[str, Any]:
        """Records one line in the transfer history. It does not build the transfer sheet."""
        try:
            corpo = validar_transferencia(campos)
        except ValueError as falha:
            return {"sucesso": False, "erro": str(falha)}
        ok, dados = self._chamar("POST", "/api/historico-transferencias", corpo=corpo)
        if not ok:
            return {"sucesso": False, "erro": dados}
        return {"sucesso": True, "mensagem": f"Transferência da série {corpo['serial']} registrada no histórico de transferências."}

    def resolver_apelido_manual(self, evento_id: str, serial: str, acao: str) -> Dict[str, Any]:
        evento_id, serial, acao = str(evento_id or "").strip(), str(serial or "").strip().upper(), str(acao or "").strip().lower()
        if not _ID_ROTA.match(evento_id) or not _ID_ROTA.match(serial):
            return {"sucesso": False, "erro": "Identificador do evento ou série inválido."}
        if acao not in ACOES_APELIDO_MANUAL:
            return {"sucesso": False, "erro": "Escolha 'manter' ou 'excluir'."}
        feito = "Apelido manual mantido." if acao == "manter" else "Alteração manual removida; o apelido voltou a seguir as planilhas de origem."
        return self._evento_simples("POST", f"/api/historico-comparacoes/{evento_id}/apelido-manual/{serial}", {"acao": acao}, feito)

    def salvar_nome_pessoa(self, serial: str, nome: str) -> Dict[str, Any]:
        """The login comes from the server's own lookup, never from the model."""
        serial, nome = str(serial or "").strip().upper(), str(nome or "").strip()
        pessoa = self.pessoa_da_serie(serial)
        if pessoa is None:
            return {"sucesso": False, "erro": "Não foi possível consultar o usuário logado dessa série."}
        corpo = {"serial": str(pessoa.get("serial_cadastro") or serial), "login_atual": str(pessoa.get("usuario") or "").strip(), "nome": nome}
        return self._evento_simples("POST", "/api/equipamento/nome-pessoa", corpo, "Nome da pessoa removido." if not nome else "Nome da pessoa salvo.")

    def recarregar_base(self) -> Dict[str, Any]:
        """Swaps the in-memory base for the newest valid spreadsheet in the input folder."""
        ok, dados = self._chamar("POST", "/api/recarregar-base", corpo={})
        if not ok:
            return {"sucesso": False, "erro": dados}
        dados = _dict(dados)
        return {
            "sucesso": True, "mensagem": f"Base recarregada de {limpar_texto_sensivel(dados.get('arquivo_origem', ''))}.",
            "total_equipamentos": dados.get("total_equipamentos"),
        }
