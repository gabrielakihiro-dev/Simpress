"""The automation tools of the assistant's API (`AutomacaoMixin`, mixed into `SimpressApi` in `assistant_api`).

UX ticket, Dashboard schedule, Chrome routines (status, history, log, start, cancel), SoftExpert (old tickets read and
finalize one ticket), comparison restore and the ticket imports history. Only structured fields reach the model: log text,
paths and URLs never leave here. The UX `logger.warning` stays in `SimpressApi._chamar`.
Leaf module: shared helpers come from `assistant_api_comum`; nothing here may import `assistant_api` or another mixin.
"""

import re
from collections import Counter
from datetime import datetime
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Tuple, Union

from domains.assistant_api_comum import MAX_ITENS_LISTA, _ID_ROTA, _aparar, _motivo_codigo
from domains.assistant_transporte import ArquivoUpload
from domains.assistant_validacao import _dict
from domains.chrome_automation import ROUTINE_LABELS, ROUTINES
from domains.dashboard_agendamento import INTERVALO_PADRAO, INTERVALOS_PERMITIDOS

ROTINAS_VALIDAS = ("login", "os", "inventarios", "ambas", "usuarios", "sebrae", "dashboard")
MAX_LINHAS_LOG = 40


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
    dashboard = executando and bool(dados.get("aguardando_dashboard"))
    cancelando = executando and bool(dados.get("cancelamento_pedido"))
    situacao = ("cancelamento_solicitado" if cancelando else "aguardando_login" if aguardando
                else "aguardando_dashboard" if dashboard else "em_andamento" if executando else "livre")
    rotina, rotulo = _rotina_segura(dados.get("rotina")) if executando else ("nenhuma", "Nenhuma rotina em andamento")
    resposta: Dict[str, Any] = {
        "fonte": "estado_atual",
        "situacao": situacao,
        "situacao_texto": {
            "livre": "Nenhuma rotina em andamento.",
            "em_andamento": "Rotina em andamento.",
            "aguardando_login": "Rotina em andamento, aguardando o login manual do operador no Chrome de automação.",
            "aguardando_dashboard": "Rotina em andamento, aguardando fecharem o Dashboard no Excel; ela continua sozinha quando ele for liberado ou pode ser cancelada.",
            "cancelamento_solicitado": "Cancelamento solicitado; a rotina ainda não terminou.",
        }[situacao],
        "executando": executando, "aguardando_login": aguardando, "cancelamento_pedido": cancelando,
        "rotina": rotina, "rotina_nome": rotulo,
        "inicio": _data_iso(dados.get("inicio")) if executando else None,
        "origem": dados.get("origem") if executando and dados.get("origem") in ("site", "externo") else None,
    }
    if aguardando or dashboard:
        resposta["etapa"] = "aguardando_login" if aguardando else "aguardando_dashboard"
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

class AutomacaoMixin:
    if TYPE_CHECKING:  # members of `SimpressApi` used here; declared for mypy only, never defined at runtime
        @property
        def _tokens_restauracao(self) -> Dict[str, str]: ...  # a plain annotation would add `__annotations__` to the class

        def _chamar(
            self, metodo: str, caminho: str, params: Optional[Dict[str, Any]] = None, corpo: Union[Dict[str, Any], ArquivoUpload, None] = None,
        ) -> Tuple[bool, Any]: ...

        @staticmethod
        def _limite(limite: Any, padrao: int) -> int: ...

        def chamado_para_finalizar(self, numero: Any, descricao: Any = "", encerramento: Any = "") -> Dict[str, Any]: ...

    # --- UX ticket (the send needs the confirmation card) ---

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

    # --- Dashboard schedule ---

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

    # --- routines: status, history, log, start, cancel ---

    def consultar_status_automacao(self) -> Dict[str, Any]:
        ok, dados = self._chamar("GET", "/api/automacao/estado")
        if not ok:
            return {"erro": dados}
        return _aparar(_status_automacao(_dict(dados)))

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

    # --- SoftExpert (old tickets read; finalize one at a time) ---

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

    # --- comparison restore (destructive: always behind a confirmation card) ---

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

    # --- ticket imports history ---

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

    def excluir_chamados_antigos(self) -> Dict[str, Any]:
        ok, dados = self._chamar("DELETE", "/api/operacoes/chamados/historico/antigas")
        if not ok:
            return {"sucesso": False, "erro": dados}
        removidas = _dict(dados).get("removidas", 0)
        return {"sucesso": True, "mensagem": f"{removidas} importação(ões) antiga(s) removida(s); a mais recente foi mantida."}
