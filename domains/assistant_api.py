"""The assistant's access to Simpress data: the same routes the screens use, called inside this process.

The loopback transport lives in `assistant_transporte`, the validators in `assistant_validacao`, the helpers shared with the
theme mixins in `assistant_api_comum`, the Sebrae/F5 tools in `assistant_api_sebrae` (`SebraeMixin`) and the history and
comparison reads in `assistant_api_historico` (`HistoricoMixin`); names used elsewhere are re-exported
here. `SimpressApi` shapes each answer for the model: short lists, labels approved in AGENTS.md and personal data cleaned with
`limpar_texto_sensivel`.
"""

import asyncio
import logging
import re
from collections import Counter
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Set, Tuple, Union

from domains.os_observacoes import chave_os
from core.errors import DomainValidationError
from domains.assistant_lgpd import e_solicitante_sistema, limpar_texto_sensivel
from domains.chrome_automation import ROUTINE_LABELS, ROUTINES
from domains.coverage import dobrar
from domains.dashboard_agendamento import INTERVALO_PADRAO, INTERVALOS_PERMITIDOS
from domains.local_setup import REGIONAL_REPRESENTATIVE_CITIES
from domains.assistant_api_comum import (  # noqa: F401  (re-exported: callers and tests import these names from here)
    _ID_ROTA, _MOTIVOS, MAX_ITENS_LISTA, MAX_TEXTO_CHAMADO, _aparar, _marcas_de, _motivo_codigo, _observacao_de,
    e_macbook, sanitizar_equipamento,
)
from domains.assistant_api_historico import HistoricoMixin, _exemplo_comparacao, _rotular_item  # noqa: F401  (re-exported: callers and tests import these names from here)
from domains.assistant_api_sebrae import SebraeMixin
from domains.assistant_transporte import ArquivoUpload, Transport, asgi_transport  # noqa: F401  (re-exported: callers and tests import these names from here)
from domains.assistant_validacao import (  # noqa: F401  (re-exported: callers and tests import these names from here)
    ACOES_APELIDO_MANUAL, DECISOES_VALIDAS, FONTES_VINCULO_OS, MAX_ANOTACAO, _dict, diferencas_representante, montar_contato_origem,
    montar_representante_regional, representante_efetivo, representante_padrao, resolver_cidade_representante, validar_anotacao,
    validar_transferencia, validar_vinculo_os,
)

logger = logging.getLogger(__name__)

ROTINAS_VALIDAS = ("login", "os", "inventarios", "ambas", "usuarios", "sebrae", "dashboard")

AVISO_BACKUPS_NO_PAINEL = "Omitido aqui (lista longa); para os Backups regionais use a ferramenta `listar_backups_regionais`."
# Page cap (100 items each) when loading base names for the privacy mask.
# shortcut: above 20,000 equipment rows with a user the name list is partial; raise it if the base grows.
MAX_PAGINAS_NOMES = 200
MAX_LINHAS_LOG = 40
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


# --- automação: só campos estruturados vão ao modelo ---------------------------------------------
# Log lines, messages, paths, URLs and capture names never leave here: a failure becomes `motivo_codigo`,
# derived from the `[FALHA]` texts written by scripts/automacao_rotinas_chrome.py (and the scripts it calls).

NOTA_LOG = (
    "O texto do log não é enviado à IA. O operador pode ler o log completo na tela de Automação do Cockpit (F4), "
    "no histórico de execuções."
)
NOTA_ETAPA = "O programa não registra a etapa atual da rotina; o único dado confiável de andamento é se ela está aguardando login."
_SITUACAO_FINAL = {
    "concluido": ("concluida", "Concluída."),
    "falha": ("falhou", "Falhou."),
    "cancelado": ("cancelada", "Cancelada."),
    "interrompido": (
        "interrompida",
        "Interrompida: o servidor do Simpress foi reiniciado durante a execução e o resultado final não foi registrado "
        "(não é falha confirmada nem cancelamento).",
    ),
    "ocupada": ("ocupada", "Não rodou: outra execução da automação já estava em andamento (não é falha da rotina nem cancelamento)."),
}
MOTIVOS_AUTOMACAO: Dict[str, str] = {
    "login_nao_concluido": "O login não foi concluído no tempo de espera (o login é sempre manual).",
    "chrome_nao_encontrado": "O Google Chrome não foi encontrado no computador.",
    "chrome_sem_conexao": "O Chrome de automação não abriu ou não aceitou a conexão da rotina.",
    "playwright_ausente": "O pacote Playwright não está instalado no ambiente Python do projeto.",
    "envio_sharepoint_nao_confirmado": "O aviso de envio concluído não apareceu; o Dashboard pode ter sido enviado. Confira a pasta antes de repetir.",
    "envio_sharepoint_nao_recebido": "O SharePoint não recebeu o Dashboard: a rotina baixou o arquivo de novo e ele ainda tinha os valores de antes; "
    "nada foi substituído e o envio pode ser repetido.",
    "envio_sharepoint_nao_comecou": "O upload não começou (sem o diálogo de substituir nem o andamento) e a rotina não conseguiu confirmar pelo "
    "download; confira a pasta antes de repetir.",
    "dashboard_sem_preservar_abas": "A rotina não conseguiu aplicar as alterações do site sobre o Dashboard do SharePoint preservando as outras abas; "
    "nada foi substituído. É preciso Baixar, importar e buscar, depois Atualizar Dashboard e Enviar ao SharePoint.",
    "dashboard_sharepoint_mudou": "O Dashboard no SharePoint mudou depois da importação, então o envio parou sem substituir nada. É preciso importar de novo: "
    "Baixar, importar e buscar, depois Atualizar Dashboard e Enviar ao SharePoint (a cópia gerada antes fica guardada, nada é apagado).",
    "dashboard_sharepoint_conflito": "Há células do Dashboard alteradas no SharePoint e no site ao mesmo tempo, então o envio parou sem substituir nada. "
    "A escolha de qual valor manter é do usuário, na tela de Chamados (F5); depois é só enviar de novo.",
    "duplicata_nao_criada": "A cópia de segurança (Duplicata) não apareceu no SharePoint; o Dashboard não foi substituído.",
    "sharepoint_so_manter_ambos": "O SharePoint só ofereceu manter os dois arquivos; nada foi enviado.",
    "dashboard_em_uso_no_sharepoint": "O Dashboard estava em uso ou bloqueado no SharePoint.",
    "dashboard_nao_importado": "Não há Dashboard importado no site.",
    "dashboard_recusado_pelo_site": "O site recusou o Dashboard baixado.",
    "dashboard_nao_encontrado_no_sharepoint": "O Dashboard não foi encontrado na pasta DASHBOARD SEBRAE do SharePoint.",
    "dashboard_gerado_ausente": "Não há Dashboard gerado pelo site para enviar (falta usar Atualizar Dashboard).",
    "arquivo_baixado_invalido": "O arquivo baixado não era um .xlsx.",
    "copia_pendente_ausente": "Não há cópia pendente do Dashboard para enviar.",
    "pedido_finalizacao_invalido": "Não há pedido de finalização válido; é preciso pedir de novo pelo site.",
    "servidor_simpress_sem_resposta": "O servidor local do Simpress não respondeu à rotina.",
    "download_falhou": "O download de um arquivo falhou, chegou vazio ou não começou.",
    "contrato_nao_confere": "O contrato selecionado no UX Simpress ou no Oracle não conferiu.",
    "exportacao_endpoint_invalida": "A exportação do Endpoint Central não veio como esperado.",
    "oracle_menu_indisponivel": "A Gestão de Solicitações do Oracle não abriu pelo menu.",
    "endpoint_tela_inesperada": "Uma tela do Endpoint Central não carregou ou não foi confirmada; nada foi decidido.",
    "timeout": "Uma tela ou etapa não respondeu no tempo de espera.",
    "rotina_nao_concluida": "A rotina terminou sem concluir, sem um motivo específico reconhecido.",
    "cancelada_pelo_operador": "A rotina foi cancelada pelo operador.",
    "servidor_reiniciado": "O servidor foi reiniciado durante a execução; o resultado final não foi registrado.",
    "outra_execucao_em_andamento": "Outra execução da automação já estava em andamento.",
    "desconhecido": "Motivo não reconhecido pelo programa. " + NOTA_LOG,
}
_ID_EXECUCAO = re.compile(r"^(?!\.+$)[A-Za-z0-9_.() -]{1,120}$")  # log file stems, e.g. "20261102_101500_os (1)"
_STATUS_LOTE = re.compile(r"^[a-z_]{1,30}$")
# Error bodies reach the model: besides the LGPD mask, drop what it does not cover (URLs, tokens, cookies, local paths). Free names stay uncovered.
_SEGREDO_NO_ERRO = re.compile(
    r"(?i)(?:https?://\S+|bearer\s+[\w.~+/=-]+|eyJ[\w-]{5,}\.[\w.-]+|(?:cookie|set-cookie|authorization)\s*[:=]\s*[^\n;]+"
    r"|(?:token|access_token|api[_-]?key|secret|sessao|session)\s*[=:]\s*[^\s&;,]+|sk-[\w-]{8,}"
    r"|[A-Za-z]:\\[^\s\"']+|\\\\[^\s\"']+|\?[^\s\"']*=[^\s\"']*)"
)


def _texto_erro_seguro(texto: Any) -> str:
    return _SEGREDO_NO_ERRO.sub("[OMITIDO]", limpar_texto_sensivel(texto))[:300]


def _data_iso(valor: Any) -> Optional[str]:
    try:
        return datetime.fromisoformat(str(valor)).isoformat(timespec="seconds") if valor else None
    except ValueError:
        return None


def _rotina_segura(valor: Any) -> Tuple[str, str]:
    rotina = str(valor or "")
    if rotina in ROUTINES:
        return rotina, ROUTINE_LABELS.get(rotina, rotina)
    return "desconhecida", "Rotina não identificada"


def _execucao_segura(entrada: Any, textos_extra: Optional[List[str]] = None) -> Optional[Dict[str, Any]]:
    """Allowlist of one history entry: id, routine, situation, times, exit code, batch and capture counts, reason code."""
    if not isinstance(entrada, dict):
        return None
    status = str(entrada.get("status") or "")
    rotina, rotulo = _rotina_segura(entrada.get("rotina"))
    situacao, texto = _SITUACAO_FINAL.get(status, ("em_andamento", "Sem resultado final registrado.") if status == "em_andamento" else ("desconhecida", "Situação não registrada."))
    inicio, fim = _data_iso(entrada.get("inicio")), _data_iso(entrada.get("fim"))
    codigo = entrada.get("codigo") if isinstance(entrada.get("codigo"), int) and not isinstance(entrada.get("codigo"), bool) else None
    lotes = [lote for lote in entrada.get("lotes") or [] if isinstance(lote, dict)]
    por_status = Counter(s if _STATUS_LOTE.fullmatch(s := str(lote.get("status") or "")) else "desconhecido" for lote in lotes)
    item: Dict[str, Any] = {
        "id": str(entrada.get("id")) if _ID_EXECUCAO.fullmatch(str(entrada.get("id") or "")) else None,
        "rotina": rotina, "rotina_nome": rotulo,
        "origem": entrada.get("origem") if entrada.get("origem") in ("site", "externo") else None,
        "situacao": situacao, "situacao_texto": texto,
        "inicio": inicio, "fim": fim, "codigo_saida": codigo,
        "lotes": {"total": len(lotes), "por_status": dict(por_status)},
        "capturas_de_tela": len(entrada.get("capturas") or []) if isinstance(entrada.get("capturas"), list) else 0,
    }
    if inicio and fim:
        try:
            item["duracao_segundos"] = max(0, int((datetime.fromisoformat(fim) - datetime.fromisoformat(inicio)).total_seconds()))
        except (ValueError, TypeError):  # one side with timezone and the other without: no duration
            pass
    motivo = _motivo_codigo(status, codigo, [str(entrada.get("mensagem") or ""), *(textos_extra or [])])
    if motivo:
        item["motivo_codigo"], item["motivo_texto"] = motivo, MOTIVOS_AUTOMACAO[motivo]
    return item


def _status_automacao(dados: Dict[str, Any]) -> Dict[str, Any]:
    """Current state (from /api/automacao/estado) without the log chunk, pid or login source."""
    executando = dados.get("estado") == "em_andamento"
    aguardando = executando and bool(dados.get("aguardando_login"))
    cancelando = executando and bool(dados.get("cancelamento_pedido"))
    situacao = "cancelamento_solicitado" if cancelando else "aguardando_login" if aguardando else "em_andamento" if executando else "livre"
    rotina, rotulo = _rotina_segura(dados.get("rotina")) if executando else ("nenhuma", "Nenhuma rotina em andamento")
    resposta: Dict[str, Any] = {
        "fonte": "estado_atual",
        "situacao": situacao,
        "situacao_texto": {
            "livre": "Nenhuma rotina em andamento.",
            "em_andamento": "Rotina em andamento.",
            "aguardando_login": "Rotina em andamento, aguardando o login manual do operador no Chrome de automação.",
            "cancelamento_solicitado": "Cancelamento solicitado; a rotina ainda não terminou.",
        }[situacao],
        "executando": executando, "aguardando_login": aguardando, "cancelamento_pedido": cancelando,
        "rotina": rotina, "rotina_nome": rotulo,
        "inicio": _data_iso(dados.get("inicio")) if executando else None,
        "origem": dados.get("origem") if executando and dados.get("origem") in ("site", "externo") else None,
    }
    if aguardando:
        resposta["etapa"] = "aguardando_login"
    elif executando:
        resposta["etapa"], resposta["nota_etapa"] = "indisponível", NOTA_ETAPA
    ultima = dados.get("ultima")
    if not isinstance(ultima, dict):
        resposta["ultima_execucao"] = None
        resposta["nota_ultima"] = "Nenhuma execução registrada no histórico."
        return resposta
    segura = _execucao_segura(ultima)
    if segura is None:
        resposta["ultima_execucao"] = None
        resposta["nota_ultima"] = "Nenhuma execução registrada no histórico."
        return resposta
    segura["fonte"] = "historico"
    if ultima.get("status") == "em_andamento" and not executando:
        segura["situacao_texto"] = "Resultado não registrado: a execução não aparece mais em andamento e não tem resultado final no histórico."
    resposta["ultima_execucao"] = segura
    if segura.get("motivo_codigo") == "desconhecido":
        resposta["nota"] = NOTA_LOG
    return resposta


def _intervalo_agendamento(valor: Any) -> int:
    return valor if type(valor) is int and valor in INTERVALOS_PERMITIDOS else INTERVALO_PADRAO


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


class SimpressApi(SebraeMixin, HistoricoMixin):
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

    def preparar_chamado_ux(self, serial: str, conferido: bool) -> Dict[str, Any]:
        ok, dados = self._chamar("POST", "/api/ux/abrir-chamado/preparar", corpo={"serial": serial, "conferido": conferido})
        return _dict(dados) if ok else {"erro": dados}

    def cancelar_chamado_ux(self, session_id: str) -> None:
        self._chamar("POST", "/api/ux/abrir-chamado/cancelar", corpo={"session_id": session_id})

    def enviar_chamado_ux(self, args: Dict[str, Any]) -> Dict[str, Any]:
        corpo = {campo: args[campo] for campo in ("session_id", "serial", "problema", "descricao")}
        ok, dados = self._chamar("POST", "/api/ux/abrir-chamado/enviar", corpo={**corpo, "enviar": True, "confirmado": True})
        if not ok:
            return {"erro": dados}
        resultado = _dict(dados)
        if resultado.get("status") == "enviado" and resultado.get("os"):
            return {"mensagem": f"Chamado enviado. OS #{resultado['os']}."}
        return {"erro": "O UX não confirmou o envio. Confira se o chamado foi criado antes de tentar novamente."}

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

    def consultar_agendamento_dashboard(self) -> Dict[str, Any]:
        ok, dados = self._chamar("GET", "/api/automacao/dashboard/agendamento")
        if not ok:
            return {"erro": dados}
        dados = _dict(dados)
        ultimo = _dict(dados.get("ultimo_disparo"))
        return {"ativo": dados.get("ativo") is True, "intervalo_minutos": _intervalo_agendamento(dados.get("intervalo_minutos")),
                "proxima_execucao": str(dados.get("proxima_execucao") or ""),
                "ultimo_resultado": ultimo.get("resultado") if ultimo.get("resultado") in (
                    "iniciada", "pulado: ocupada", "pulado: horário perdido", "pulado: saída pendente", "erro ao iniciar") else "",
                "saida_pendente": bool(dados.get("bloqueio")), "login": "Senha e MFA manuais; não envia ao SharePoint nem finaliza chamados."}

    def definir_agendamento_dashboard(self, ativo: Any, intervalo_minutos: Any = None) -> Dict[str, Any]:
        if not isinstance(ativo, bool):
            return {"erro": "Informe ativo como verdadeiro ou falso."}
        corpo: Dict[str, Any] = {"ativo": ativo}
        if intervalo_minutos is not None:
            if type(intervalo_minutos) is not int or intervalo_minutos not in INTERVALOS_PERMITIDOS:
                return {"erro": "Informe intervalo_minutos como 30, 60, 90 ou 120."}
            corpo["intervalo_minutos"] = intervalo_minutos
        ok, dados = self._chamar("PUT", "/api/automacao/dashboard/agendamento", corpo=corpo)
        if not ok:
            return {"erro": dados}
        dados = _dict(dados)
        return {"ativo": dados.get("ativo") is True, "intervalo_minutos": _intervalo_agendamento(dados.get("intervalo_minutos")),
                "mensagem": "Agendamento alterado; nenhuma rotina foi iniciada agora."}

    def consultar_status_automacao(self) -> Dict[str, Any]:
        ok, dados = self._chamar("GET", "/api/automacao/estado")
        if not ok:
            return {"erro": dados}
        return _aparar(_status_automacao(_dict(dados)))

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

    def listar_historico_automacao(self) -> Dict[str, Any]:
        ok, dados = self._chamar("GET", "/api/automacao/historico")
        if not ok:
            return {"erro": dados}
        dados = _dict(dados)
        execucoes = [e for e in (_execucao_segura(x) for x in dados.get("execucoes") or []) if e][:MAX_ITENS_LISTA]
        return _aparar({"fonte": "historico", "total": dados.get("total") if isinstance(dados.get("total"), int) else len(execucoes),
                        "execucoes": execucoes, "nota": NOTA_LOG})

    def resultado_ultima_automacao(self) -> Dict[str, Any]:
        """Last finished run (history) plus whether a routine is running right now."""
        ok, estado = self._chamar("GET", "/api/automacao/estado")
        if not ok:
            return {"erro": estado}
        ok, dados = self._chamar("GET", "/api/automacao/historico", params={"limite": 10})
        if not ok:
            return {"erro": dados}
        atual = _status_automacao(_dict(estado))
        finalizada = next((e for e in _dict(dados).get("execucoes") or []
                           if _dict(e).get("status") in _SITUACAO_FINAL and _dict(e).get("status") != "ocupada"), None)  # "ocupada" never ran: it must not hide the real last run
        resposta: Dict[str, Any] = {"fonte": "historico", "situacao_atual": atual["situacao"]}
        if atual["situacao"] != "livre":
            resposta["aviso_execucao_atual"] = (
                f"A rotina '{atual['rotina']}' está em andamento agora e ainda não terminou; "
                "o resultado abaixo é da última execução já finalizada."
            )
        if finalizada is None:
            resposta["mensagem"] = "Nenhuma execução finalizada registrada no histórico recente."
            return resposta
        resposta["ultima_finalizada"] = _execucao_segura(finalizada)
        if resposta["ultima_finalizada"].get("motivo_codigo") == "desconhecido":
            resposta["nota"] = NOTA_LOG
        return _aparar(resposta)

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

    def log_execucao_automacao(self, execucao_id: str = "") -> Dict[str, Any]:
        """Reason of a run (default: the latest failure) read from its log; the log text itself never leaves here."""
        execucao_id = str(execucao_id or "").strip()
        if execucao_id and not _ID_EXECUCAO.fullmatch(execucao_id):
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
        falhas = [str(linha).split("[FALHA]", 1)[1].strip() for linha in dados.get("linhas") or []
                  if isinstance(linha, str) and "[FALHA]" in linha]
        execucao = _execucao_segura(_dict(dados.get("execucao")), falhas)
        return _aparar({
            "fonte": "historico",
            "execucao": execucao,
            "motivo_codigo": (execucao or {}).get("motivo_codigo"),
            "motivo_texto": (execucao or {}).get("motivo_texto"),
            "linhas_de_falha": len(falhas),
            "limitado": bool(dados.get("limitado")),
            "nota": NOTA_LOG,
        })

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
        mensagem = (f"Rotina '{rotina_clean}' iniciada pelo servidor Simpress. Iniciar não é concluir: para saber se terminou, "
                    "use consultar_status_automacao (andamento) ou resultado_ultima_automacao (resultado final).")
        ok, estado = self._chamar("GET", "/api/automacao/estado")  # one read, no polling
        if not ok:
            return {"sucesso": True, "rotina": rotina_clean, "estado_apos_iniciar": None,
                    "mensagem": mensagem + " O estado logo após iniciar não pôde ser confirmado."}
        atual = _status_automacao(_dict(estado))
        for chave in ("ultima_execucao", "nota_ultima", "nota"):  # the history belongs to the previous run, not this one
            atual.pop(chave, None)
        if atual["situacao"] == "livre":
            mensagem += " Se já estiver livre, a rotina pode ter terminado logo: use resultado_ultima_automacao."
        return _aparar({"sucesso": True, "rotina": rotina_clean, "estado_apos_iniciar": atual,
                        "mensagem": f"{mensagem} Estado logo após iniciar: {atual['situacao_texto']}"})

    def ler_chamados_antigos_softexpert(self) -> Dict[str, Any]:
        """Starts the ``antigos`` routine (read only in SoftExpert) by the site's button route, never /api/automacao/executar."""
        ok, dados = self._chamar("POST", "/api/sebrae/antigos/ler", corpo={})
        if not ok:
            erro = str(dados)
            if erro.startswith("Erro 409"):
                erro = "Outra rotina de automação já está em andamento; a leitura dos antigos não foi iniciada. Aguarde o término ou cancele."
            elif erro.startswith("Erro 422"):
                erro = "Não há Dashboard importado: importe o Dashboard antes (aba Automação, F4). A leitura dos antigos não foi iniciada."
            elif erro.startswith("Erro 503"):
                erro = "A automação não está disponível neste servidor; a leitura dos antigos não foi iniciada."
            return {"sucesso": False, "erro": erro}
        mensagem = ("Leitura dos chamados antigos iniciada pelo servidor Simpress. Iniciar não é terminar: para saber o "
                    "resultado, use status_leitura_antigos_sebrae.")
        ok, estado = self._chamar("GET", "/api/sebrae/antigos/ler")  # one read, no polling; its counts may be from the previous run
        if not ok:
            return {"sucesso": True, "em_andamento": None, "mensagem": mensagem + " O estado logo após iniciar não pôde ser confirmado."}
        rodando = bool(_dict(estado).get("em_andamento"))
        situacao = "em andamento" if rodando else "já não aparece em andamento (pode ter terminado de imediato ou falhado)"
        return {"sucesso": True, "em_andamento": rodando, "mensagem": f"{mensagem} Estado logo após iniciar: {situacao}."}

    def finalizar_chamado_softexpert(
        self, numero: Any, descricao: Any = "", versao_importacao: Any = "", encerramento: Any = "",
    ) -> Dict[str, Any]:
        """Finalize ONE ticket in SoftExpert (irreversible), the same call as the site's button; only after the card is confirmed.

        ``encerramento`` (DT ENCERRAMENTO, "dd/MM/aaaa HH:mm") is required and checked before any PUT/POST."""
        try:
            alvo = self.chamado_para_finalizar(numero, descricao, encerramento)
        except ValueError as falha:
            return {"sucesso": False, "erro": str(falha)}
        if not versao_importacao or versao_importacao != alvo["versao_importacao"]:
            return {"sucesso": False, "erro": "O Dashboard mudou desde o cartão. Consulte e confirme novamente; nada foi finalizado."}
        if alvo["nova"]:
            ok, dados = self._chamar(
                "PUT", f"/api/sebrae/chamados/{alvo['numero']}/finalizacao", corpo={"descricao_finalizacao": alvo["descricao"]},
            )
            if not ok:
                return {"sucesso": False, "erro": dados, "mensagem": "A descrição não foi salva; nada foi finalizado."}
        ok, dados = self._chamar("POST", "/api/sebrae/finalizar-softexpert", corpo={
            "numero": alvo["numero"], "confirmado": True, "versao_importacao": versao_importacao, "encerramento": alvo["encerramento"],
        })
        if not ok:
            if "Erro 409" in str(dados):
                return {"sucesso": False, "erro": "Já existe uma automação em andamento, ou o chamado já foi finalizado. Nada foi finalizado agora."}
            return {"sucesso": False, "erro": dados}
        return {
            "sucesso": True,
            "mensagem": f"Finalização de {alvo['numero']} pedida ao Chrome de automação; o resultado ainda não está confirmado. Use situacao_finalizacao_sebrae para ver o resultado.",
        }

    def cancelar_automacao(self) -> Dict[str, Any]:
        """Asking is not cancelling: only a free state whose last run is 'cancelado' confirms it."""
        ok, dados = self._chamar("POST", "/api/automacao/cancelar", corpo={})
        if not ok:
            if "Nenhuma rotina em andamento" in str(dados):
                return {"sucesso": False, "erro": "Não há rotina de automação em andamento; nada foi cancelado."}
            return {"sucesso": False, "erro": dados}  # 409 "iniciada fora do site" keeps the server's instruction
        ok, estado = self._chamar("GET", "/api/automacao/estado")  # one read, no polling
        atual = _status_automacao(_dict(estado)) if ok else None
        ultima = (atual or {}).get("ultima_execucao") or {}
        if atual and atual["situacao"] == "livre" and ultima.get("situacao") == "cancelada":
            return {"sucesso": True, "cancelada": True, "mensagem": "Rotina cancelada: o estado atual está livre e a última execução aparece como cancelada."}
        mensagem = "Cancelamento solicitado ao servidor Simpress. A rotina pode levar alguns instantes para parar; confirme com consultar_status_automacao."
        if atual is None:
            mensagem += " O estado logo após o pedido não pôde ser lido."
        else:
            mensagem += f" Estado logo após o pedido: {atual['situacao_texto']}"
        return _aparar({"sucesso": True, "cancelada": False, "situacao_apos_pedido": (atual or {}).get("situacao"), "mensagem": mensagem})

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

    def _representantes_salvos(self) -> Tuple[Dict[str, Any], bool, Dict[str, Any]]:
        """(changes saved by city, whether the file is unreadable, effective defaults by city); ValueError when the route fails.

        The defaults come from the route (`padroes`: code plus the local defaults file); an answer without them leaves the code's.
        """
        ok, dados = self._chamar("GET", "/api/config/representantes-regionais")
        if not ok:
            raise ValueError(dados)
        dados = _dict(dados)
        padroes = {str(item.get("cidade")): _dict(item) for item in dados.get("padroes") or [] if isinstance(item, dict)}
        return _dict(dados.get("alteracoes")), bool(dados.get("arquivo_invalido")), padroes

    def representante_regional_atual(self, cidade: Any) -> Tuple[str, Dict[str, str], bool, Dict[str, str]]:
        """(city, effective values, whether a change is saved, default of the city); real values: only for the card and the merge. ValueError (pt-BR)."""
        cidade = resolver_cidade_representante(cidade)
        salvos, _, padroes = self._representantes_salvos()
        return (cidade, *representante_efetivo(cidade, salvos, padroes), representante_padrao(cidade, padroes))

    def ver_representantes_regionais(self, cidade: Any = None) -> Dict[str, Any]:
        """Values go out under sensitive keys (nome, email, retirada_telefone), so the conversation's mask turns them into markers."""
        try:
            cidade = resolver_cidade_representante(cidade) if str(cidade or "").strip() else None
            salvos, invalido, padroes = self._representantes_salvos()
        except ValueError as falha:
            return {"erro": str(falha)}
        if cidade is None:
            return {"cidades": [{"cidade": c, "alterada": isinstance(salvos.get(c), dict)} for c in REGIONAL_REPRESENTATIVE_CITIES], "arquivo_invalido": invalido}
        valores, alterada = representante_efetivo(cidade, salvos, padroes)
        return {
            "cidade": cidade, "nome": valores["nome"], "email": valores["email"], "retirada_telefone": valores["telefone"],
            "horario": valores["horario"], "almoco": valores["almoco"], "pausa": valores["pausaDuracao"],
            "alterada": alterada, "arquivo_invalido": invalido,
        }

    def listar_cobertura(self, cidade: Any = None, data: Any = None, ate: Any = None, perfil: Any = None) -> Dict[str, Any]:
        """Painel Cobertura (F10), só leitura: o mesmo GET /api/cobertura da tela (build_coverage), filtrado aqui.

        Allowlist: só vagas, contagens e séries; os `casos` (com quem recebeu, observações e cópias da transferência) nunca saem.
        """
        datas: Dict[str, str] = {}
        for nome, valor in (("data", data), ("ate", ate)):
            texto = str(valor or "").strip()
            if not texto:
                continue
            try:
                datas[nome] = date.fromisoformat(texto).isoformat() if re.fullmatch(r"\d{4}-\d{2}-\d{2}", texto) else ""
            except ValueError:
                datas[nome] = ""
            if not datas[nome]:
                return {"erro": f"Data inválida em `{nome}`: use AAAA-MM-DD (ex.: 2026-11-20)."}
        ok, dados = self._chamar("GET", "/api/cobertura")
        if not ok:
            return {"erro": dados}
        dados = _dict(dados)
        todas = [v for v in dados.get("vagas") or [] if isinstance(v, dict)]
        alvo_cidade, alvo_perfil = dobrar(cidade), dobrar(perfil)
        vagas = [
            v for v in todas
            if (not alvo_cidade or dobrar(v.get("cidade")) == alvo_cidade)
            and (not alvo_perfil or alvo_perfil in dobrar(v.get("perfil")))
            and (not datas.get("data") or str(v.get("data")) == datas["data"])
            and (not datas.get("ate") or str(v.get("data")) <= datas["ate"])
        ]
        filtro = {k: v for k, v in (("cidade", cidade), ("perfil", perfil), *datas.items()) if str(v or "").strip()}
        if not todas:
            return {"hoje": dados.get("hoje"), "mensagem": "Nenhuma necessidade cadastrada na Cobertura.", "faltam": 0}
        if not vagas:
            return {
                "hoje": dados.get("hoje"), "filtro": filtro,
                "mensagem": "Nenhuma vaga corresponde ao filtro; isso não quer dizer que não vai faltar. Confira cidade, data e perfil.",
                "cidades_existentes": sorted({str(v.get("cidade") or "") for v in todas}),
                "datas_existentes": sorted({str(v.get("data") or "") for v in todas}),
                "perfis_existentes": sorted({str(v.get("perfil") or "") for v in todas} - {""}),
            }
        contagens = {situacao: 0 for situacao in ("atendivel", "condicionada", "sem_cobertura", "entregue")}
        for vaga in vagas:
            if vaga.get("situacao") in contagens:
                contagens[vaga["situacao"]] += 1
        disponiveis = [
            {k: s.get(k) for k in ("serie", "cidade", "valida_ate", "sinal")}
            for s in dados.get("disponiveis") or []
            if isinstance(s, dict) and (not alvo_cidade or dobrar(s.get("cidade")) == alvo_cidade)
        ]
        manutencao = _dict(dados.get("manutencao"))
        return _aparar({
            "hoje": dados.get("hoje"), "filtro": filtro, "contagens": contagens, "faltam": contagens["sem_cobertura"],
            "vagas": [{k: v.get(k) for k in ("data", "cidade", "perfil", "monitor", "situacao", "serie", "selos", "motivo")} for v in vagas],
            "disponiveis": disponiveis,
            "reservas_vencidas": len(dados.get("reservas_vencidas") or []),
            "manutencao_verificada": bool(manutencao.get("verificada", True)),
            "aviso_manutencao": str(manutencao.get("aviso") or ""),
        })

    def listar_backups_regionais(self, cidade: Any = None) -> Dict[str, Any]:
        """Backups regionais (Resumo F3, sub-aba Backups), só leitura: o `backups_regionais` do GET /api/painel, filtrado aqui.

        Allowlist: nunca o `apelido` (pode ser nome de pessoa), nem a `conferencia` e os `excluidos` em detalhe (só contagens).
        `outras_candidatos` (cidades sem mínimo) segue o mesmo filtro de cidade e o mesmo corte das demais listas.
        """
        ok, dados = self._chamar("GET", "/api/painel")
        if not ok:
            return {"erro": dados}
        bruto = _dict(_dict(dados).get("backups_regionais"))
        if bruto.get("indisponivel") or not isinstance(bruto.get("prioritarias"), list):
            return {"erro": "Os Backups regionais não puderam ser calculados agora. Não há números para informar."}
        alvo = dobrar(cidade)
        das_cidades = [_dict(g) for g in bruto["prioritarias"] if not alvo or dobrar(_dict(g).get("cidade")) == alvo]

        def cortar(itens: Any, campos: Tuple[str, ...]) -> Tuple[List[Dict[str, Any]], int]:
            validos = [i for i in itens or [] if isinstance(i, dict)]
            return [{k: i.get(k) for k in campos} for i in validos[:MAX_ITENS_LISTA]], max(0, len(validos) - MAX_ITENS_LISTA)

        def contar(itens: Any) -> Dict[str, Any]:
            validos = [i for i in itens or [] if isinstance(i, dict)]
            return {"total": len(validos), "por_motivo": dict(Counter(str(i.get("motivo") or "") for i in validos))}

        prioritarias = []
        for g in das_cidades:
            backups, backups_omitidos = cortar(g.get("backups"), ("serie", "origem", "ultima_verificacao", "confirmado_ate", "confirmacao"))
            for b in backups:
                # Confirmação nova não tem prazo (`confirmado_ate` None): quem diz se há confirmação é `confirmacao`; só flags saem.
                conf = _dict(b.pop("confirmacao"))
                b["confirmado"] = conf.get("estado") == "vigente"
                b["decisao_pendente"] = bool(conf.get("decisao_pendente"))
            candidatos, candidatos_omitidos = cortar(g.get("candidatos"), ("serie", "motivo", "dias_sem_verificacao"))
            prioritarias.append({
                **{k: g.get(k) for k in ("cidade", "status", "contados", "minimo", "excedente")},
                "backups": backups, "backups_omitidos": backups_omitidos,
                "candidatos": candidatos, "candidatos_omitidos": candidatos_omitidos,
                "conferencia": contar(g.get("conferencia")), "excluidos": contar(g.get("excluidos")),
            })
        sobras_todas = [
            _dict(g) for g in bruto.get("sobras") or []
            if isinstance(g, dict) and (not alvo or dobrar(g.get("cidade")) == alvo)
        ]
        sobras = []
        for g in sobras_todas[:MAX_ITENS_LISTA]:
            series = [x for x in g.get("series") or [] if isinstance(x, str)]
            sobras.append({
                "cidade": g.get("cidade"), "quantidade": g.get("quantidade"), "prioritaria": bool(g.get("prioritaria")),
                "series": series[:MAX_ITENS_LISTA], "series_omitidas": max(0, len(series) - MAX_ITENS_LISTA),
            })
        # Candidates in cities without a minimum: the number a user asks for when the city is not one of the five.
        outras_todas = [
            _dict(g) for g in bruto.get("outras_candidatos") or []
            if isinstance(g, dict) and (not alvo or dobrar(g.get("cidade")) == alvo)
        ]
        outras = []
        for g in outras_todas[:MAX_ITENS_LISTA]:
            candidatos, omitidos = cortar(g.get("candidatos"), ("serie", "motivo", "dias_sem_verificacao"))
            outras.append({"cidade": g.get("cidade"), "candidatos": candidatos, "candidatos_omitidos": omitidos})
        pendencias = {
            tipo: [c for c in _dict(bruto.get("pendencias")).get(tipo) or [] if isinstance(c, str) and (not alvo or dobrar(c) == alvo)]
            for tipo in ("sem_backup", "conferir")
        }
        resultado: Dict[str, Any] = {
            "gerado_em": bruto.get("gerado_em"), "minimo": bruto.get("minimo"),
            "fontes": {k: v for k, v in _dict(bruto.get("fontes")).items() if v is None or isinstance(v, (bool, str))},
            "limitacoes": [x for x in bruto.get("limitacoes") or [] if isinstance(x, str)][:MAX_ITENS_LISTA],
            "pendencias": pendencias, "prioritarias": prioritarias,
            "sobras": sobras, "sobras_omitidas": max(0, len(sobras_todas) - MAX_ITENS_LISTA),
            "outras_candidatos": outras, "outras_candidatos_omitidas": max(0, len(outras_todas) - MAX_ITENS_LISTA),
        }
        if alvo and not prioritarias:
            resultado["mensagem"] = (
                "Esta cidade não é uma das regionais com mínimo de backup; só as sobras e os candidatos dela (se houver) aparecem. "
                "Isso não quer dizer que não há notebook de backup lá."
            )
            resultado["cidades_prioritarias"] = [str(_dict(g).get("cidade") or "") for g in bruto["prioritarias"]]
        return _aparar(resultado)

    def montar_alteracao_representante(self, cidade: Any, *novos: Any) -> Tuple[str, Dict[str, str], List[Tuple[str, str, str]]]:
        """(city, body for the route, changes) of `alterar_representante_regional`; ValueError (pt-BR) when it cannot run."""
        cidade, efetivo, *_ = self.representante_regional_atual(cidade)
        return (cidade, *montar_representante_regional(efetivo, *novos))

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

    def _hostname_removal(self, caminho: str, serie: str, hostname: str, sucesso: str) -> Dict[str, Any]:
        serie, hostname = str(serie or "").strip(), str(hostname or "").strip()
        if not serie or not hostname:
            return {"sucesso": False, "erro": "Informe a série e o hostname."}
        return self._evento_simples("POST", caminho, {"serie": serie, "hostname": hostname}, sucesso)

    def remover_hostname_endpoint(self, serie: str, hostname: str) -> Dict[str, Any]:
        return self._hostname_removal("/api/endpoint/hostnames-removidos", serie, hostname, "Hostname marcado como removido; o outro da série passa a valer.")

    def restaurar_hostname_endpoint(self, serie: str, hostname: str) -> Dict[str, Any]:
        return self._hostname_removal("/api/endpoint/hostnames-removidos/restaurar", serie, hostname, "Hostname restaurado nas duplicidades do Endpoint.")

    # --- histórico de chamados, histórico do Sebrae e usuário logado (leituras) ---

    def historico_chamados(self, limite: Any = 10) -> Dict[str, Any]:
        """Imports of the ticket follow-up, newest first (id, date, source files, counts)."""
        ok, dados = self._chamar("GET", "/api/operacoes/chamados/historico")
        if not ok:
            return {"erro": dados}
        eventos = [e for e in _dict(dados).get("eventos") or [] if isinstance(e, dict)]
        return {"total": len(eventos), "eventos": _aparar(eventos[: self._limite(limite, 10)])}

    def snapshot_chamados(self, snapshot_id: Any) -> Dict[str, Any]:
        """One import reduced to counts and the first rows (serial and OS relation): the full rows would cut the answer."""
        snapshot_id = str(snapshot_id or "").strip()
        if not _ID_ROTA.match(snapshot_id):
            return {"erro": "Identificador da importação inválido. Use historico_chamados."}
        ok, dados = self._chamar("GET", f"/api/operacoes/chamados/snapshot/{snapshot_id}")
        if not ok:
            return {"erro": dados}
        dados = _dict(dados)
        chamados = [c for c in dados.get("chamados") or [] if isinstance(c, dict)]
        exemplos = [{"serie": c.get("serie", ""), "relacao": c.get("relacao", "")} for c in chamados[:MAX_ITENS_LISTA]]
        return _aparar({
            "id": dados.get("id", snapshot_id), "atualizado_em": dados.get("atualizado_em", ""),
            "fontes": {k: _dict(v).get("arquivo", "") for k, v in _dict(dados.get("fontes")).items()},
            "resumo": dados.get("resumo") or {}, "total_chamados": len(chamados), "chamados": exemplos,
            "omitidos": max(0, len(chamados) - MAX_ITENS_LISTA),
        })

    def evolucao_chamados(self, anterior: Any, atual: Any) -> Dict[str, Any]:
        """New, changed (only the names of the fields) and missing serials between two imports."""
        anterior, atual = str(anterior or "").strip(), str(atual or "").strip()
        if not _ID_ROTA.match(anterior) or not _ID_ROTA.match(atual):
            return {"erro": "Informe os identificadores 'anterior' e 'atual' (de historico_chamados)."}
        ok, dados = self._chamar("GET", "/api/operacoes/chamados/evolucao", params={"anterior": anterior, "atual": atual})
        if not ok:
            return {"erro": dados}
        dados = _dict(dados)
        mudancas = _dict(dados.get("mudancas"))
        alterados = [
            {"serie": c.get("serie", ""), "campos": [f.get("campo") for f in c.get("campos") or [] if isinstance(f, dict)]}
            for c in mudancas.get("alterados") or [] if isinstance(c, dict)
        ]
        return _aparar({
            "anterior": dados.get("anterior"), "atual": dados.get("atual"), "contagens": dados.get("contagens"),
            "novos": mudancas.get("novos") or [], "alterados": alterados, "ausentes_arquivo": mudancas.get("ausentes_arquivo") or [],
            "aviso": dados.get("aviso_ausentes", ""),
        })

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

    def excluir_chamados_antigos(self) -> Dict[str, Any]:
        ok, dados = self._chamar("DELETE", "/api/operacoes/chamados/historico/antigas")
        if not ok:
            return {"sucesso": False, "erro": dados}
        removidas = _dict(dados).get("removidas", 0)
        return {"sucesso": True, "mensagem": f"{removidas} importação(ões) antiga(s) removida(s); a mais recente foi mantida."}

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
