"""Padrões editados dos modelos do Chamado manual (Home F1): nome da aba e texto, por modelo.

Grava só ``config/modelos_chamado.json``, versionado de propósito: o que o usuário salva como padrão vai junto no
próximo commit. Sem o arquivo (ou sem o modelo nele) vale o texto do HTML (``frontend/partials/card-equipamento.html``).
Os ids dos modelos são fixos; só o nome visível e o texto mudam. Nenhum log leva nome ou texto.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from core.integrity import FileBusyError, FileTransactionError, atomic_write_json, lock_paths

MODELOS = ("deslocamento", "teclado-mouse", "mau-funcionamento", "uso-inadequado")
LIMITE_ROTULO = 40
LIMITE_TEXTO = 2500
# Controle proibido, exceto quebra de linha e tabulação no texto.
_CONTROLE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


class ErroModeloChamado(Exception):
    def __init__(self, status: int, mensagem: str) -> None:
        super().__init__(mensagem)
        self.status = status


def _ler(arquivo: Path) -> dict[str, dict[str, str]]:
    try:
        bruto = json.loads(arquivo.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        raise ErroModeloChamado(503, "O arquivo config/modelos_chamado.json está ilegível e foi preservado.")
    if not isinstance(bruto, dict):
        raise ErroModeloChamado(503, "O arquivo config/modelos_chamado.json está ilegível e foi preservado.")
    # Só modelos conhecidos e campos de texto; o resto é ignorado na leitura (e some na próxima gravação).
    return {
        slug: {campo: valor[campo] for campo in ("rotulo", "texto") if isinstance(valor.get(campo), str)}
        for slug, valor in bruto.items() if slug in MODELOS and isinstance(valor, dict)
    }


def listar(arquivo: Path) -> dict[str, dict[str, str]]:
    return _ler(arquivo)


def salvar(arquivo: Path, slug: str, rotulo: str, texto: str) -> dict[str, dict[str, str]]:
    if slug not in MODELOS:
        raise ErroModeloChamado(404, "Modelo de chamado não encontrado.")
    rotulo = rotulo.strip()
    if not rotulo or len(rotulo) > LIMITE_ROTULO or _CONTROLE.search(rotulo) or "\n" in rotulo or "\t" in rotulo:
        raise ErroModeloChamado(422, f"O nome do modelo precisa ter de 1 a {LIMITE_ROTULO} caracteres, sem quebra de linha.")
    if not texto.strip() or len(texto) > LIMITE_TEXTO or _CONTROLE.search(texto):
        raise ErroModeloChamado(422, f"O texto do modelo precisa ter de 1 a {LIMITE_TEXTO} caracteres.")
    try:
        with lock_paths([arquivo]):
            modelos = _ler(arquivo)
            modelos[slug] = {"rotulo": rotulo, "texto": texto}
            atomic_write_json(arquivo, {chave: modelos[chave] for chave in MODELOS if chave in modelos})
    except FileBusyError:
        raise ErroModeloChamado(409, "O arquivo de modelos está ocupado. Tente de novo em instantes.")
    except (FileTransactionError, OSError):
        raise ErroModeloChamado(503, "Não foi possível gravar o modelo. Nada foi alterado; tente de novo.")
    return modelos
