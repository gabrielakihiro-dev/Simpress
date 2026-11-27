"""Helpers shared by `SimpressApi` and its theme mixins: list/text limits, masking trim, OS-tab notes and marks, and the equipment
summary sent to the model.

Leaf module: `assistant_api` re-exports these names, so nothing here may import it or a theme mixin
(`assistant_api_sebrae`, `assistant_api_historico`, `assistant_api_regionais`, `assistant_api_automacao`).
"""

import re
import unicodedata
from typing import Any, Dict, List, Optional, Tuple

from core.errors import DomainValidationError
from domains.assistant_lgpd import SEM_USUARIO, limpar_texto_sensivel
from domains.os_observacoes import chave_os
from domains.regras_negocio import cadastro_e_macbook

# Limits keep the text returned to the model inside its context window.
MAX_ITENS_LISTA = 20


MAX_TEXTO_CHAMADO = 300


_ID_ROTA = re.compile(r"^[^/?#\s]{1,128}$")


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


# (regex over the text without accents and in lower case, code). Specific first; the generic "não foi concluída" last.
_MOTIVOS: Tuple[Tuple["re.Pattern[str]", str], ...] = tuple((re.compile(p), c) for p, c in (
    (r"login nao concluido", "login_nao_concluido"),
    (r"google chrome nao encontrado", "chrome_nao_encontrado"),
    (r"chrome nao abriu a porta|nao expos nenhum contexto", "chrome_sem_conexao"),
    (r"playwright", "playwright_ausente"),
    (r"sharepoint nao recebeu o dashboard", "envio_sharepoint_nao_recebido"),  # before the next one: the message quotes it
    (r"o upload nao comecou", "envio_sharepoint_nao_comecou"),
    (r"nao vi o aviso de envio concluido", "envio_sharepoint_nao_confirmado"),
    (r"preservando as outras abas", "dashboard_sem_preservar_abas"),  # before "mudou depois da importacao"
    (r"conflito de edicao", "dashboard_sharepoint_conflito"),  # before "copia pendente": the message also says "nem guardado como copia pendente"
    (r"mudou depois da importacao|nao consegui conferir o dashboard do sharepoint", "dashboard_sharepoint_mudou"),
    (r"duplicata", "duplicata_nao_criada"),
    (r"keep both", "sharepoint_so_manter_ambos"),
    (r"em uso ou bloqueado", "dashboard_em_uso_no_sharepoint"),
    (r"importe o dashboard no site antes|nao tem um dashboard importado", "dashboard_nao_importado"),
    (r"recusou o dashboard", "dashboard_recusado_pelo_site"),
    (r"nao achei .* na pasta dashboard sebrae", "dashboard_nao_encontrado_no_sharepoint"),
    (r"nao achei .* gerado pelo site", "dashboard_gerado_ausente"),
    (r"nao um \.xlsx", "arquivo_baixado_invalido"),
    (r"copia pendente", "copia_pendente_ausente"),
    (r"pedido de finalizacao valido", "pedido_finalizacao_invalido"),
    (r"servidor simpress nao respondeu", "servidor_simpress_sem_resposta"),
    (r"\bdownload (?:falhou|de .* chegou vazio|nao comecou)", "download_falhou"),  # not "Downloads" in a path
    (r"contrato", "contrato_nao_confere"),
    (r"xlsx do endpoint|todos os computadores|formato xlsx ou declaracao", "exportacao_endpoint_invalida"),
    (r"abrir a gestao de solicitacoes", "oracle_menu_indisponivel"),
    (r"grade do endpoint|detalhe do computador|sistema > usuarios|caixa de filtro|link do detalhe|coluna '.*' nao esta visivel",
     "endpoint_tela_inesperada"),
    (r"nao ficou pronta em|nao foi processado em|nao comecou em|timeouterror|timeout", "timeout"),
    (r"nao foi concluida", "rotina_nao_concluida"),
))


def _motivo_codigo(status: str, codigo: Any, textos: List[str]) -> Optional[str]:
    """Enumerated reason of a finished run (None when it did not fail). Texts are only matched, never returned."""
    if status == "cancelado":
        return "cancelada_pelo_operador"
    if status == "interrompido":
        return "servidor_reiniciado"
    if status == "ocupada":
        return "outra_execucao_em_andamento"
    if status != "falha":
        return None
    segmentos = [_sem_acento_minusculo(s) for t in textos for s in str(t or "").split(" | ") if s.strip()]
    for padrao, codigo_motivo in _MOTIVOS:
        if any(padrao.search(s) for s in segmentos):
            return codigo_motivo
    return "playwright_ausente" if codigo == 3 else "desconhecido"


def _sem_acento_minusculo(texto: str) -> str:  # same as assistant_tools._sem_acento (that module imports assistant_api, so no import from there)
    return "".join(c for c in unicodedata.normalize("NFD", texto) if unicodedata.category(c) != "Mn").lower()


def _observacao_de(notas: Dict[str, str], serie: Any, ordem: Any) -> str:
    """Note of the OS tab (F6) for this serial+OS, by `chave_os`; "" when either side is empty or there is none."""
    try:
        return notas.get(chave_os(serie, ordem), "")
    except DomainValidationError:
        return ""


def _marcas_de(marcas: Dict[str, List[Dict[str, Any]]], serie: Any, ordem: Any, chamado: Any = None) -> List[Dict[str, Any]]:
    """Marks of the OS tab (F6) for this serial+OS, by `chave_os`; only the given ticket when `chamado` is set; [] when none."""
    try:
        achadas = marcas.get(chave_os(serie, ordem), [])
    except DomainValidationError:
        return []
    alvo = str(chamado or "").strip().upper()
    return [m for m in achadas if not alvo or m["chamado"].upper() == alvo]


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


def e_macbook(equip: Dict[str, Any]) -> bool:
    """Same test as Simpress (categorize_equipment): 'MACBOOK' in the type or the model."""
    return cadastro_e_macbook(equip.get("categoria"), equip.get("tipo"), equip.get("modelo"))
