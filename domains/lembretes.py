"""Lembretes (Ferramentas): lista local de anotações, gravada só em ``data/state/lembretes.json``.

O arquivo guarda dado pessoal (nome do colaborador nas descrições). Nenhum log leva a descrição:
só o código ou a classe do erro. Não há escrita em sistema externo nem leitura pelo Assistente.
"""

from __future__ import annotations

import json
import logging
import re
import secrets
import unicodedata
from datetime import date, datetime
from pathlib import Path
from typing import Any, Callable, Optional, TypeVar

from core.integrity import FileBusyError, FileTransactionError, atomic_write_json, lock_paths
from domains.sebrae_observacoes import FUSO, agora_iso

T = TypeVar("T")
logger = logging.getLogger(__name__)

MAX_DESCRICAO = 2000
ORIGENS = ("entrega", "devolucao")
PADRAO_ID = re.compile(r"^[a-z0-9_-]{1,40}$")
# Formato estrito (só dígitos ASCII, sempre com fullmatch): recusa 20261113, 2026-W46-5 e 09:00:30.
PADRAO_DATA = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
PADRAO_HORA = re.compile(r"([01][0-9]|2[0-3]):[0-5][0-9]")
CAMPOS = (
    "id", "descricao", "criado_em", "alterado_em", "concluido", "concluido_em", "origem", "termo",
    "data_agendada", "hora_agendada",
)
# Cópia dos dados do termo (12/11/2026): chaves do formulário por origem, como em static/js/features/termos.js.
CAMPOS_TERMO = {
    "entrega": ("nome", "unidade", "data", "modelo_anterior", "modelo_entregue", "serie_anterior", "serie_entregue"),
    "devolucao": ("nome", "unidade", "data", "modelo", "serie"),
}
TOTAL_ITENS_TERMO = 11
RESPOSTAS_ITEM = ("sim", "nao", "")
MAX_CAMPO_TERMO = 200
MAX_OBS_TERMO = 2000
CONTROLE_OBS = "\n\r\t"

# Mensagens técnicas (sem texto aprovado); os códigos viajam junto no JSON.
MSG_DESCRICAO_TEXTO = "A descrição precisa ser um texto."
MSG_DESCRICAO_VAZIA = "A descrição não pode ficar vazia."
MSG_DESCRICAO_CONTROLE = "A descrição não pode ter caracteres de controle."
MSG_DESCRICAO_LIMITE = f"A descrição pode ter até {MAX_DESCRICAO} caracteres."
MSG_ORIGEM = "A origem precisa ser entrega, devolucao ou vazia."
MSG_TERMO = "Os dados do termo são inválidos."
MSG_CONCLUIDO = "O campo concluido precisa ser verdadeiro ou falso."
MSG_DATA = "A data agendada precisa estar no formato AAAA-MM-DD e existir no calendário."
MSG_HORA = "A hora agendada precisa estar no formato HH:MM."
MSG_HORA_SEM_DATA = "A hora agendada só existe junto com a data agendada."
MSG_INEXISTENTE = "Lembrete não encontrado."
MSG_ILEGIVEL = "O arquivo de lembretes está ilegível e foi preservado. Restaure uma cópia válida antes de alterar os lembretes."
MSG_OCUPADO = "O arquivo de lembretes está ocupado no momento. Tente novamente em instantes."
MSG_GRAVACAO = "Não foi possível gravar o lembrete. Nada foi alterado; tente de novo."


class ErroLembrete(Exception):
    """Erro com status HTTP e código; o router o devolve como ``{detail, codigo}``."""

    def __init__(self, status: int, mensagem: str, *, codigo: str) -> None:
        super().__init__(mensagem)
        self.status = status
        self.codigo = codigo


def _invalido(mensagem: str, codigo: str) -> ErroLembrete:
    return ErroLembrete(422, mensagem, codigo=codigo)


def _descricao(valor: Any) -> str:
    """Texto sem caractere de controle, sem espaços nas pontas, não vazio e dentro do limite."""
    if not isinstance(valor, str):
        raise _invalido(MSG_DESCRICAO_TEXTO, "descricao_invalida")
    # Cs (surrogate isolado) não grava em UTF-8: recusa com 422 em vez de falhar na gravação.
    if any(unicodedata.category(c) in ("Cc", "Cs") for c in valor):
        raise _invalido(MSG_DESCRICAO_CONTROLE, "descricao_invalida")
    texto = valor.strip()
    if not texto:
        raise _invalido(MSG_DESCRICAO_VAZIA, "descricao_invalida")
    if len(texto) > MAX_DESCRICAO:
        raise _invalido(MSG_DESCRICAO_LIMITE, "descricao_invalida")
    return texto


def _origem(valor: Any) -> Optional[str]:
    if valor is not None and valor not in ORIGENS:
        raise _invalido(MSG_ORIGEM, "origem_invalida")
    return valor


def _como_data(valor: Any) -> Optional[date]:
    """A data do texto AAAA-MM-DD; None se não for texto nesse formato ou se a data não existir."""
    if not isinstance(valor, str) or not PADRAO_DATA.fullmatch(valor):
        return None
    try:
        return date.fromisoformat(valor)
    except ValueError:
        return None


def _data(valor: Any) -> Optional[str]:
    if valor is not None and _como_data(valor) is None:
        raise _invalido(MSG_DATA, "data_invalida")
    return valor


def _hora(valor: Any) -> Optional[str]:
    if valor is not None and not (isinstance(valor, str) and PADRAO_HORA.fullmatch(valor)):
        raise _invalido(MSG_HORA, "hora_invalida")
    return valor


def _hora_com_data(data: Optional[str], hora: Optional[str]) -> None:
    """Regra do estado final: hora só existe com data."""
    if data is None and hora is not None:
        raise _invalido(MSG_HORA_SEM_DATA, "hora_invalida")


def _hoje_local() -> date:
    return datetime.now(FUSO).date()


def _texto_termo(valor: Any, limite: int, controle_permitido: str = "") -> bool:
    # Cs (surrogate isolado) não grava em UTF-8; Cc só os permitidos (quebra de linha e tab nas observações).
    return (
        isinstance(valor, str)
        and len(valor) <= limite
        and not any(
            unicodedata.category(c) == "Cs" or (unicodedata.category(c) == "Cc" and c not in controle_permitido)
            for c in valor
        )
    )


def _termo(valor: Any, origem: Optional[str]) -> Optional[dict[str, Any]]:
    """Cópia dos dados do termo como foram digitados; a mensagem de erro nunca leva o valor."""
    if valor is None:
        return None
    erro = _invalido(MSG_TERMO, "termo_invalido")
    if origem is None or not isinstance(valor, dict) or set(valor) != {"campos", "itens", "obs"}:
        raise erro
    campos, itens, obs = valor["campos"], valor["itens"], valor["obs"]
    if (
        not isinstance(campos, dict)
        or not set(campos) <= set(CAMPOS_TERMO[origem])
        or not all(_texto_termo(v, MAX_CAMPO_TERMO) for v in campos.values())
        or not isinstance(itens, list)
        or len(itens) != TOTAL_ITENS_TERMO
        or not all(isinstance(i, str) and i in RESPOSTAS_ITEM for i in itens)
        or not _texto_termo(obs, MAX_OBS_TERMO, CONTROLE_OBS)
    ):
        raise erro
    return {"campos": {chave: campos.get(chave, "") for chave in CAMPOS_TERMO[origem]}, "itens": list(itens), "obs": obs}


def _texto_ou_nulo(valor: Any) -> bool:
    return valor is None or isinstance(valor, str)


def _item_valido(item: Any) -> bool:
    return (
        isinstance(item, dict)
        and isinstance(item.get("id"), str)
        and bool(PADRAO_ID.fullmatch(item["id"]))
        and isinstance(item.get("descricao"), str)
        and isinstance(item.get("criado_em"), str)
        and _texto_ou_nulo(item.get("alterado_em"))
        and isinstance(item.get("concluido"), bool)
        and _texto_ou_nulo(item.get("concluido_em"))
        and item.get("origem") in (None, *ORIGENS)
        # Só o tipo: um formato ruim editado à mão não pode tornar o arquivo inteiro ilegível.
        and _texto_ou_nulo(item.get("data_agendada"))
        and _texto_ou_nulo(item.get("hora_agendada"))
        # Leitura tolerante: um termo estranho não pode marcar o arquivo inteiro como ilegível; o front confere as chaves.
        and (item.get("termo") is None or isinstance(item.get("termo"), dict))
    )


class Lembretes:
    """Lembretes em um JSON local: leitura sem trava, escrita atômica sob trava de arquivo."""

    def __init__(
        self, arquivo: Path, agora: Callable[[], str] = agora_iso, hoje: Callable[[], date] = _hoje_local,
    ) -> None:
        self.arquivo = Path(arquivo)
        self._agora = agora
        self._hoje = hoje

    def _carregar(self) -> list[dict[str, Any]]:
        try:
            bruto = self.arquivo.read_text(encoding="utf-8")
        except FileNotFoundError:
            return []
        except PermissionError as erro:
            # No Windows, o os.replace de outra gravação trava a leitura por um instante.
            raise ErroLembrete(503, MSG_OCUPADO, codigo="lembretes_ocupados") from erro
        except (OSError, UnicodeDecodeError) as erro:
            raise ErroLembrete(503, MSG_ILEGIVEL, codigo="lembretes_ilegiveis") from erro
        try:
            dados = json.loads(bruto)
        except ValueError as erro:
            raise ErroLembrete(503, MSG_ILEGIVEL, codigo="lembretes_ilegiveis") from erro
        itens = dados.get("lembretes") if isinstance(dados, dict) else None
        if (
            not isinstance(dados, dict)
            or dados.get("version") != 1
            or not isinstance(itens, list)
            or not all(_item_valido(item) for item in itens)
            or len({item["id"] for item in itens}) != len(itens)
        ):
            raise ErroLembrete(503, MSG_ILEGIVEL, codigo="lembretes_ilegiveis")
        # Campos opcionais ausentes (arquivo de outra versão ou editado à mão) viram null.
        return [{campo: item.get(campo) for campo in CAMPOS} for item in itens]

    def listar(self) -> list[dict[str, Any]]:
        return self._carregar()

    def _transacao(
        self, acao: Callable[[list[dict[str, Any]]], T], gravar: Callable[[T], bool] = lambda _resultado: True,
    ) -> T:
        """Lê, aplica ``acao`` e grava (se ``gravar`` aprovar o resultado); qualquer falha deixa o arquivo como estava."""
        try:
            with lock_paths([self.arquivo]):
                itens = self._carregar()
                resultado = acao(itens)
                if gravar(resultado):
                    self.arquivo.parent.mkdir(parents=True, exist_ok=True)
                    atomic_write_json(self.arquivo, {"version": 1, "lembretes": itens})
                return resultado
        except FileBusyError as erro:
            raise ErroLembrete(503, MSG_OCUPADO, codigo="lembretes_ocupados") from erro
        except (OSError, FileTransactionError) as erro:
            raise ErroLembrete(503, MSG_GRAVACAO, codigo="lembretes_gravacao") from erro

    @staticmethod
    def _achar(itens: list[dict[str, Any]], lembrete_id: Any) -> dict[str, Any]:
        for item in itens:
            if item["id"] == lembrete_id:
                return item
        raise ErroLembrete(404, MSG_INEXISTENTE, codigo="lembrete_inexistente")

    def criar(
        self, descricao: Any, origem: Any = None, termo: Any = None,
        data_agendada: Any = None, hora_agendada: Any = None,
    ) -> dict[str, Any]:
        texto, origem_ok = _descricao(descricao), _origem(origem)
        termo_ok = _termo(termo, origem_ok)
        data_ok, hora_ok = _data(data_agendada), _hora(hora_agendada)
        _hora_com_data(data_ok, hora_ok)

        def acao(itens: list[dict[str, Any]]) -> dict[str, Any]:
            ids = {item["id"] for item in itens}
            novo_id = secrets.token_hex(6)
            while novo_id in ids:
                novo_id = secrets.token_hex(6)
            item = {
                "id": novo_id, "descricao": texto, "criado_em": self._agora(), "alterado_em": None,
                "concluido": False, "concluido_em": None, "origem": origem_ok, "termo": termo_ok,
                "data_agendada": data_ok, "hora_agendada": hora_ok,
            }
            itens.append(item)
            return dict(item)

        return self._transacao(acao)

    def atualizar(self, lembrete_id: Any, campos: dict[str, Any]) -> dict[str, Any]:
        texto =_descricao(campos["descricao"]) if "descricao" in campos else None
        concluido = campos.get("concluido")
        if "concluido" in campos and not isinstance(concluido, bool):
            raise _invalido(MSG_CONCLUIDO, "campo_invalido")
        tem_data, tem_hora = "data_agendada" in campos, "hora_agendada" in campos
        data = _data(campos["data_agendada"]) if tem_data else None
        hora = _hora(campos["hora_agendada"]) if tem_hora else None

        def acao(itens: list[dict[str, Any]]) -> dict[str, Any]:
            item = self._achar(itens, lembrete_id)
            # Estado final: campo ausente mantém o atual; sem data, `hora_agendada` pedida é recusada
            # e a hora antiga some junto ({data_agendada: null} sozinho limpa os dois).
            nova_data = data if tem_data else item["data_agendada"]
            nova_hora = hora if tem_hora else item["hora_agendada"]
            if nova_data is None:
                _hora_com_data(None, hora)
                nova_hora = None
            item["data_agendada"], item["hora_agendada"] = nova_data, nova_hora
            if texto is not None and texto != item["descricao"]:
                item["descricao"] = texto
                item["alterado_em"] = self._agora()
            if concluido is True and not item["concluido"]:
                item["concluido"], item["concluido_em"] = True, self._agora()
            elif concluido is False:
                item["concluido"], item["concluido_em"] = False, None
            return dict(item)

        return self._transacao(acao)

    def reagendar_atrasados(self) -> tuple[list[dict[str, Any]], int]:
        """Pendentes com data anterior a hoje (America/Sao_Paulo) passam para hoje, mantendo a hora.

        Sem atrasados nada é gravado (o arquivo nem é criado). Devolve a lista completa e quantos mudaram.
        """
        hoje = self._hoje()

        def acao(itens: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
            reagendados = 0
            for item in itens:
                data = _como_data(item["data_agendada"])
                if not item["concluido"] and data is not None and data < hoje:
                    item["data_agendada"] = hoje.isoformat()
                    reagendados += 1
            return [dict(item) for item in itens], reagendados

        return self._transacao(acao, gravar=lambda resultado: resultado[1] > 0)

    def excluir(self, lembrete_id: Any) -> None:
        def acao(itens: list[dict[str, Any]]) -> None:
            itens.remove(self._achar(itens, lembrete_id))

        self._transacao(acao)
