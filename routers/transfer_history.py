"""Local history of generated transfer sheets (list and append only)."""

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
import json
import threading
import unicodedata
from typing import Any, Callable, Dict, List, Tuple
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Query
from core.integrity import AtomicFileTransaction, FileBusyError, FileTransactionError
from routers.transfers import TransferenciaPayload

MAX_HISTORY_RECORDS = 500
SEARCH_FIELDS = ("serial", "retirada_cidade", "entrega_cidade", "entrega_contato", "entrega_obs")
_LOCK = threading.Lock()


class TransferHistoryCorruptionError(ValueError):
    """The history file exists but cannot be trusted, so it is never overwritten."""


@dataclass(frozen=True)
class TransferHistoryServices:
    history_file: Callable[[], Path]
    transaction_root: Callable[[], Path]


def _validate_history(value: Any) -> List[Dict[str, Any]]:
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise TransferHistoryCorruptionError(
            "O histórico local de transferências precisa conter uma lista de registros."
        )
    return value


def _fold(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or "")).casefold()
    return "".join(char for char in text if not unicodedata.combining(char))


def build_record(payload: TransferenciaPayload) -> Dict[str, Any]:
    data = payload.model_dump()
    return {
        "id": uuid4().hex,
        "criado_em": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "serial": data["serial"].strip().upper(),
        "retirada_cidade": data["retirada_cidade"].strip(),
        "entrega_cidade": data["entrega_cidade"].strip(),
        "entrega_contato": data["entrega_contato"].strip(),
        "entrega_obs": data["entrega_obs"].strip(),
        "payload": data,
    }


@dataclass(frozen=True)
class TransferHistoryRouteExports:
    """Routes exposed to ``main`` for direct calls in tests and helpers."""

    listar_historico_transferencias: Callable[..., Any]
    registrar_historico_transferencia: Callable[..., Any]


def create_transfer_history_router(services: TransferHistoryServices) -> Tuple[APIRouter, TransferHistoryRouteExports]:
    router = APIRouter()

    @router.get("/api/historico-transferencias")
    def listar_historico_transferencias(
        limite: int = Query(50, ge=1, le=200),
        busca: str = Query("", max_length=128),
    ):
        """Return the newest generated transfers first, optionally filtered by a search term."""
        path = services.history_file()
        with _LOCK:
            if not path.exists():
                return {"total": 0, "itens": []}
            try:
                history = _validate_history(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, UnicodeError, json.JSONDecodeError, TransferHistoryCorruptionError) as error:
                raise HTTPException(
                    status_code=503,
                    detail="O histórico local de transferências está ilegível; os dados foram preservados.",
                ) from error
        term = _fold(busca).strip()
        if term:
            history = [
                item for item in history
                if term in " ".join(_fold(item.get(field)) for field in SEARCH_FIELDS)
            ]
        newest_first = list(reversed(history))
        return {"total": len(newest_first), "itens": newest_first[:limite]}

    @router.post("/api/historico-transferencias", status_code=201)
    def registrar_historico_transferencia(payload: TransferenciaPayload):
        """Append one record after a transfer sheet was generated; keeps only the newest records."""
        record = build_record(payload)
        path = services.history_file()
        try:
            with _LOCK:
                with AtomicFileTransaction(services.transaction_root(), [path]) as transaction:
                    transaction.update_json(
                        path,
                        lambda history: [*_validate_history(history), record][-MAX_HISTORY_RECORDS:],
                        [],
                    )
                    transaction.commit()
        except TransferHistoryCorruptionError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        except FileBusyError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except FileTransactionError as error:
            if isinstance(error.__cause__, (json.JSONDecodeError, UnicodeError)):
                raise HTTPException(
                    status_code=503,
                    detail="O histórico local de transferências está ilegível; os dados foram preservados.",
                ) from error
            raise HTTPException(status_code=500, detail=f"Falha ao registrar o histórico de transferências: {error}") from error
        return {"sucesso": True, "id": record["id"], "criado_em": record["criado_em"]}

    return router, TransferHistoryRouteExports(
        listar_historico_transferencias=listar_historico_transferencias,
        registrar_historico_transferencia=registrar_historico_transferencia,
    )
