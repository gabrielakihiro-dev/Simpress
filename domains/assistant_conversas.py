"""History of the assistant's conversations: a local JSON file the user can read back and delete.

Only the visible text of each turn is kept, and only in its masked form (the same text the model got),
so no CPF, e-mail, phone, password or known name is written to disk. Placeholders such as `[PESSOA_1]`
are not turned back into names here: the mapping lives in memory and ends with the conversation.
Attachments, reports and tool results are never stored. The history is read-only: nothing here resumes a conversation.
"""

import json
import logging
import secrets
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from core.integrity import atomic_write_json

logger = logging.getLogger(__name__)

LIMITE_CONVERSAS = 50
LIMITE_MENSAGENS = 200
LIMITE_TEXTO = 20000
LIMITE_TITULO = 60
_PAPEIS = ("usuario", "assistente")


def novo_id() -> str:
    return secrets.token_hex(6)


def _titulo(texto: str) -> str:
    linha = " ".join(texto.split())
    return linha if len(linha) <= LIMITE_TITULO else linha[: LIMITE_TITULO - 1].rstrip() + "…"


class ConversasStore:
    """The history file. One lock keeps the read-change-write of the turns and of the screen from overlapping."""

    def __init__(self, caminho: Path) -> None:
        self._caminho = Path(caminho)
        self._lock = threading.Lock()

    def _ler(self) -> List[Dict[str, Any]]:
        """Saved conversations, or [] when there are none or the file is unreadable."""
        try:
            itens = json.loads(self._caminho.read_text(encoding="utf-8")).get("conversas", [])
        except FileNotFoundError:
            return []
        except (OSError, ValueError, AttributeError):
            logger.warning("Não foi possível ler o histórico de conversas do assistente.")
            return []
        if not isinstance(itens, list):
            return []
        conversas = []
        for item in itens:
            if not (isinstance(item, dict) and isinstance(item.get("id"), str) and isinstance(item.get("mensagens"), list)):
                continue
            mensagens = [
                {"papel": m["papel"], "texto": m["texto"]} for m in item["mensagens"]
                if isinstance(m, dict) and m.get("papel") in _PAPEIS and isinstance(m.get("texto"), str)
            ]
            conversas.append({
                "id": item["id"], "titulo": str(item.get("titulo") or ""), "criada_em": item.get("criada_em"),
                "atualizada_em": item.get("atualizada_em"), "mensagens": mensagens,
            })
        return conversas

    def _gravar(self, conversas: List[Dict[str, Any]]) -> None:
        atomic_write_json(self._caminho, {"conversas": conversas})

    def registrar(self, conversa_id: str, papel: str, texto: str) -> None:
        """Append one masked message to the conversation (created on the first one). The oldest conversations drop past the limit."""
        texto = texto.strip()
        if papel not in _PAPEIS or not texto:
            return
        agora = datetime.now().astimezone().isoformat(timespec="seconds")
        with self._lock:
            conversas = self._ler()
            atual = next((c for c in conversas if c["id"] == conversa_id), None)
            if atual is None:
                atual = {"id": conversa_id, "titulo": _titulo(texto), "criada_em": agora, "atualizada_em": agora, "mensagens": []}
            else:
                conversas.remove(atual)
            conversas.append(atual)  # the file keeps the oldest first, so the touched one goes last
            atual["mensagens"] = (atual["mensagens"] + [{"papel": papel, "texto": texto[:LIMITE_TEXTO]}])[-LIMITE_MENSAGENS:]
            atual["atualizada_em"] = agora
            self._gravar(conversas[-LIMITE_CONVERSAS:])

    def listar(self) -> List[Dict[str, Any]]:
        """Summaries, newest first (no message text)."""
        with self._lock:
            conversas = self._ler()
        return [
            {"id": c["id"], "titulo": c["titulo"], "atualizada_em": c["atualizada_em"], "mensagens": len(c["mensagens"])}
            for c in reversed(conversas)
        ]

    def obter(self, conversa_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            return next((c for c in self._ler() if c["id"] == conversa_id), None)

    def apagar(self, conversa_id: str) -> bool:
        with self._lock:
            conversas = self._ler()
            restantes = [c for c in conversas if c["id"] != conversa_id]
            if len(restantes) == len(conversas):
                return False
            self._gravar(restantes)
            return True
