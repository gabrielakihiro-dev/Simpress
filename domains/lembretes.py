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
from pathlib import Path
from typing import Any, Callable, Optional, TypeVar

from core.integrity import FileBusyError, FileTransactionError, atomic_write_json, lock_paths
from domains.sebrae_observacoes import agora_iso

T = TypeVar("T")
logger = logging.getLogger(__name__)

MAX_DESCRICAO = 2000
ORIGENS = ("entrega", "devolucao")
PADRAO_ID = re.compile(r"^[a-z0-9_-]{1,40}$")
CAMPOS = ("id", "descricao", "criado_em", "alterado_em", "concluido", "concluido_em", "origem", "termo")
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
        # Leitura tolerante: um termo estranho não pode marcar o arquivo inteiro como ilegível; o front confere as chaves.
        and (item.get("termo") is None or isinstance(item.get("termo"), dict))
    )


class Lembretes:
    """Lembretes em um JSON local: leitura sem trava, escrita atômica sob trava de arquivo."""

    def __init__(self, arquivo: Path, agora: Callable[[], str] = agora_iso) -> None:
        self.arquivo = Path(arquivo)
        self._agora = agora

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

    def _transacao(self, acao: Callable[[list[dict[str, Any]]], T]) -> T:
        """Lê, aplica ``acao`` e grava; qualquer falha deixa o arquivo como estava."""
        try:
            with lock_paths([self.arquivo]):
                itens = self._carregar()
                resultado = acao(itens)
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

    def criar(self, descricao: Any, origem: Any = None, termo: Any = None) -> dict[str, Any]:
        texto, origem_ok = _descricao(descricao), _origem(origem)
        termo_ok = _termo(termo, origem_ok)

        def acao(itens: list[dict[str, Any]]) -> dict[str, Any]:
            ids = {item["id"] for item in itens}
            novo_id = secrets.token_hex(6)
            while novo_id in ids:
                novo_id = secrets.token_hex(6)
            item = {
                "id": novo_id, "descricao": texto, "criado_em": self._agora(), "alterado_em": None,
                "concluido": False, "concluido_em": None, "origem": origem_ok, "termo": termo_ok,
            }
            itens.append(item)
            return dict(item)

        return self._transacao(acao)

    def atualizar(self, lembrete_id: Any, campos: dict[str, Any]) -> dict[str, Any]:
        texto =_descricao(campos["descricao"]) if "descricao" in campos else None
        concluido = campos.get("concluido")
        if "concluido" in campos and not isinstance(concluido, bool):
            raise _invalido(MSG_CONCLUIDO, "campo_invalido")

        def acao(itens: list[dict[str, Any]]) -> dict[str, Any]:
            item = self._achar(itens, lembrete_id)
            if texto is not None and texto != item["descricao"]:
                item["descricao"] = texto
                item["alterado_em"] = self._agora()
            if concluido is True and not item["concluido"]:
                item["concluido"], item["concluido_em"] = True, self._agora()
            elif concluido is False:
                item["concluido"], item["concluido_em"] = False, None
            return dict(item)

        return self._transacao(acao)

    def excluir(self, lembrete_id: Any) -> None:
        def acao(itens: list[dict[str, Any]]) -> None:
            itens.remove(self._achar(itens, lembrete_id))

        self._transacao(acao)
