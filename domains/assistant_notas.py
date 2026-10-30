"""Reminders and notes of the assistant: short texts the user asks it to keep, in a local JSON file.

Only a consultable memory: nothing here notifies, schedules or runs anything. The text of a note is data
typed or dictated by the user (it passes through the privacy mask on its way to the model) and never an instruction.
"""

import json
import logging
import re
import secrets
import threading
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from core.integrity import atomic_write_json

logger = logging.getLogger(__name__)

LIMITE_TEXTO = 500
LIMITE_NOTAS = 200
_PRAZO = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CAMPOS = ("id", "texto", "criada_em", "concluida", "prazo")


def formatar_prazo(prazo: Optional[str]) -> str:
    """AAAA-MM-DD to DD/MM/AAAA, for the confirmation card."""
    return "/".join(reversed(prazo.split("-"))) if prazo else ""


def _validar(texto: Any, prazo: Any, quantidade: int) -> Dict[str, Optional[str]]:
    """Normalised `texto`/`prazo`; ValueError (pt-BR message) when the note cannot be created."""
    texto = str(texto or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not texto:
        raise ValueError("O texto do lembrete está vazio.")
    if len(texto) > LIMITE_TEXTO:
        raise ValueError(f"O lembrete passa de {LIMITE_TEXTO} caracteres.")
    prazo = str(prazo or "").strip()
    if prazo:
        try:
            if not _PRAZO.match(prazo):
                raise ValueError
            date.fromisoformat(prazo)
        except ValueError:
            raise ValueError("O prazo deve ser uma data válida no formato AAAA-MM-DD.") from None
    if quantidade >= LIMITE_NOTAS:
        raise ValueError(f"Já há {LIMITE_NOTAS} lembretes guardados. Apague alguns para criar outro.")
    return {"texto": texto, "prazo": prazo or None}


class NotasStore:
    """The notes file. One lock keeps the read-change-write of the chat tools and of the screen from overlapping."""

    def __init__(self, caminho: Path) -> None:
        self._caminho = Path(caminho)
        self._lock = threading.Lock()

    def _ler(self) -> List[Dict[str, Any]]:
        """Saved notes, or [] when there are none or the file is unreadable."""
        try:
            itens = json.loads(self._caminho.read_text(encoding="utf-8")).get("notas", [])
        except FileNotFoundError:
            return []
        except (OSError, ValueError, AttributeError):
            logger.warning("Não foi possível ler os lembretes do assistente.")
            return []
        if not isinstance(itens, list):
            return []
        return [
            {**{campo: item.get(campo) for campo in _CAMPOS}, "concluida": bool(item.get("concluida"))} for item in itens
            if isinstance(item, dict) and isinstance(item.get("id"), str) and isinstance(item.get("texto"), str)
        ]

    def _gravar(self, notas: List[Dict[str, Any]]) -> None:
        atomic_write_json(self._caminho, {"notas": notas})

    def listar(self, incluir_concluidas: bool = True) -> List[Dict[str, Any]]:
        """Open notes first, by deadline (the ones without a deadline last), then by creation."""
        with self._lock:
            notas = self._ler()
        notas = [n for n in notas if incluir_concluidas or not n["concluida"]]
        return sorted(notas, key=lambda n: (bool(n["concluida"]), n["prazo"] or "9999-99-99", str(n["criada_em"] or "")))

    def obter(self, nota_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            return next((n for n in self._ler() if n["id"] == nota_id), None)

    def verificar(self, texto: Any, prazo: Any = None) -> Dict[str, Optional[str]]:
        """Same checks as `criar`, without saving: the confirmation card uses it so the user never confirms a note that would fail."""
        with self._lock:
            return _validar(texto, prazo, len(self._ler()))

    def criar(self, texto: Any, prazo: Any = None) -> Dict[str, Any]:
        with self._lock:
            notas = self._ler()
            dados = _validar(texto, prazo, len(notas))
            existentes = {n["id"] for n in notas}
            nota_id = secrets.token_hex(6)
            while nota_id in existentes:
                nota_id = secrets.token_hex(6)
            nota = {"id": nota_id, **dados, "criada_em": datetime.now().astimezone().isoformat(timespec="seconds"), "concluida": False}
            self._gravar(notas + [nota])
            return nota

    def marcar(self, nota_id: str, concluida: bool = True) -> Optional[Dict[str, Any]]:
        """Mark done (or open again); None when the id does not exist."""
        with self._lock:
            notas = self._ler()
            nota = next((n for n in notas if n["id"] == nota_id), None)
            if nota is None:
                return None
            nota["concluida"] = bool(concluida)
            self._gravar(notas)
            return nota

    def apagar(self, nota_id: str) -> bool:
        with self._lock:
            notas = self._ler()
            restantes = [n for n in notas if n["id"] != nota_id]
            if len(restantes) == len(notas):
                return False
            self._gravar(restantes)
            return True
