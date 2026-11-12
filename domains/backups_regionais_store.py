"""Backups regionais: confirmações manuais de backup por série e cidade (``data/state/backups_regionais.json``).

- Cada registro guarda só ``serie``, ``cidade``, ``confirmado_em`` e ``expira_em``; nenhum dado pessoal.
- A confirmação vale 7 dias; repetir a mesma série e cidade mantém o ``expira_em`` ainda vigente.
- Arquivo ilegível nunca é sobrescrito: a leitura levanta ``EstadoIlegivel`` (503) e a gravação aborta.
- A gravação não usa lock Python: ``AtomicFileTransaction`` já serializa os escritores (threads e processos).
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Dict, Tuple

from core.integrity import AtomicFileTransaction, FileTransactionError
from domains.regras_negocio import normalize_reference_value

ESQUEMA = 1
PRAZO_DIAS = 7
CAMPOS = ("serie", "cidade", "confirmado_em", "expira_em")

Estado = Dict[str, Any]
Registro = Dict[str, str]


class EstadoIlegivel(ValueError):
    """O arquivo existe, mas não é um estado válido; ele é preservado como está."""


def estado_vazio() -> Estado:
    return {"esquema": ESQUEMA, "confirmacoes": []}


def _data_iso_valida(valor: Any) -> bool:
    if not isinstance(valor, str):
        return False
    try:
        datetime.fromisoformat(valor)
    except ValueError:
        return False
    return True


def validar_estado(valor: Any, nome: str = "backups_regionais.json") -> Estado:
    """Validação estrita: esquema conhecido, nenhuma chave desconhecida e registros com os quatro campos."""
    if not isinstance(valor, dict):
        raise EstadoIlegivel(f"'{nome}' precisa conter um objeto.")
    if valor.get("esquema") != ESQUEMA:
        raise EstadoIlegivel(f"'{nome}' tem um esquema desconhecido ({valor.get('esquema')!r}).")
    desconhecidas = set(valor) - {"esquema", "confirmacoes"}
    if desconhecidas:
        raise EstadoIlegivel(f"'{nome}' tem chaves desconhecidas: {', '.join(sorted(desconhecidas))}.")
    confirmacoes = valor.get("confirmacoes", [])
    if not isinstance(confirmacoes, list):
        raise EstadoIlegivel(f"'confirmacoes' de '{nome}' precisa ser uma lista.")
    for indice, registro in enumerate(confirmacoes):
        if (
            not isinstance(registro, dict)
            or set(registro) != set(CAMPOS)
            or not all(isinstance(registro[campo], str) and registro[campo].strip() for campo in ("serie", "cidade"))
            or not all(_data_iso_valida(registro[campo]) for campo in ("confirmado_em", "expira_em"))
        ):
            raise EstadoIlegivel(f"A confirmação {indice} de '{nome}' é inválida.")
    return {"esquema": ESQUEMA, "confirmacoes": list(confirmacoes)}


def _mesma(registro: Registro, serie: str, cidade: str) -> bool:
    return (
        normalize_reference_value(registro["serie"]) == normalize_reference_value(serie)
        and normalize_reference_value(registro["cidade"]) == normalize_reference_value(cidade)
    )


def _vigente(registro: Registro, agora: datetime) -> bool:
    expira = datetime.fromisoformat(registro["expira_em"])
    if expira.tzinfo is None:
        expira = expira.replace(tzinfo=agora.tzinfo)
    return agora < expira


def confirmar(estado: Estado, serie: str, cidade: str, agora: datetime) -> Tuple[Estado, Registro, bool]:
    """``(novo_estado, registro, repetido)``; a confirmação vigente da mesma série e cidade fica como está."""
    if agora.tzinfo is None or agora.utcoffset() is None:
        raise ValueError("agora precisa ter fuso horário")
    existente = next((r for r in estado["confirmacoes"] if _mesma(r, serie, cidade)), None)
    if existente is not None and _vigente(existente, agora):
        return estado, existente, True
    registro: Registro = {
        "serie": serie,
        "cidade": cidade,
        "confirmado_em": agora.isoformat(timespec="seconds"),
        "expira_em": (agora + timedelta(days=PRAZO_DIAS)).isoformat(timespec="seconds"),
    }
    restantes = [r for r in estado["confirmacoes"] if not _mesma(r, serie, cidade)]
    return {"esquema": ESQUEMA, "confirmacoes": [*restantes, registro]}, registro, False


def desfazer(estado: Estado, serie: str, cidade: str) -> Tuple[Estado, bool]:
    """``(novo_estado, removido)``; desfazer o que não existe não é erro."""
    restantes = [r for r in estado["confirmacoes"] if not _mesma(r, serie, cidade)]
    return {"esquema": ESQUEMA, "confirmacoes": restantes}, len(restantes) != len(estado["confirmacoes"])


class BackupsRegionaisStore:
    def __init__(self, arquivo: Path, transaction_root: Path) -> None:
        self.arquivo = Path(arquivo)
        self.transaction_root = Path(transaction_root)

    def ler(self) -> Estado:
        if not self.arquivo.exists():
            return estado_vazio()
        try:
            bruto = json.loads(self.arquivo.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, ValueError) as error:
            raise EstadoIlegivel(f"'{self.arquivo.name}' está ilegível; os dados foram preservados.") from error
        return validar_estado(bruto, self.arquivo.name)

    def escrever(self, operacao: Callable[[Estado], Tuple[Estado, Any]]) -> Any:
        """Relê o estado dentro da transação e aplica ``operacao``; ``EstadoIlegivel`` desfaz sem gravar.

        ``FileBusyError`` (arquivo ocupado) e ``FileTransactionError`` (leitura ou gravação) sobem para o router.
        """
        resultado: Dict[str, Any] = {}

        def atualizar(atual: Any) -> Estado:
            novo, resultado["valor"] = operacao(validar_estado(atual, self.arquivo.name))
            return novo

        with AtomicFileTransaction(self.transaction_root, [self.arquivo]) as transacao:
            transacao.update_json(self.arquivo, atualizar, estado_vazio())
            transacao.commit()
        return resultado["valor"]


def eh_ilegivel(error: BaseException) -> bool:
    """``FileTransactionError`` de leitura (JSON inválido) ou estado inválido: 503, nunca 500."""
    if isinstance(error, EstadoIlegivel):
        return True
    return isinstance(error, FileTransactionError) and isinstance(error.__cause__, (ValueError, UnicodeError))
