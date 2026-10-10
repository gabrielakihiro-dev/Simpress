"""Operational views over saved comparison history and service tickets."""

import json
from datetime import datetime
from io import BytesIO
from pathlib import Path
from typing import Any, Callable, Dict, List
from uuid import uuid4

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from domains.history_insights import compare_updates, is_restoration, latest_update, pending_rows
from domains.ticket_reconciliation import TicketWorkbookError, reconcile_ticket_workbooks
from domains.ticket_reporting import (
    MAX_TICKET_SNAPSHOTS,
    TICKET_SNAPSHOT_FIELDS,
    build_ticket_workbook,
    compare_ticket_snapshots,
    filter_ticket_records,
    normalize_ticket_snapshot,
    ticket_report_snapshots,
    ticket_snapshot_metadata,
)
from integrity import AtomicFileTransaction, FileBusyError, FileTransactionError
from xlsx_safety import XlsxLimitExceeded, XlsxPackageError


MAX_TICKET_WORKBOOK_BYTES = 32 * 1024 * 1024


def create_operations_router(
    *,
    load_comparison_history: Callable[[], List[Dict[str, Any]]],
    comparison_history_for_display: Callable[[Dict[str, Any]], Dict[str, Any]],
    ticket_report_path: Callable[[], Path],
    transaction_root: Callable[[], Path],
):
    router = APIRouter()

    @router.get("/api/operacoes/pendencias")
    def get_operational_pending_items():
        event = latest_update(load_comparison_history())
        if event is None:
            return {"evento": None, "pendencias": []}
        view = comparison_history_for_display(event)
        return {
            "evento": {"id": event.get("id"), "horario": event.get("horario")},
            "pendencias": pending_rows(view),
        }

    @router.get("/api/operacoes/evolucao")
    def get_update_evolution(anterior: str, atual: str):
        history = [event for event in load_comparison_history() if isinstance(event, dict)]
        previous = next((event for event in history if str(event.get("id") or "") == anterior), None)
        current = next((event for event in history if str(event.get("id") or "") == atual), None)
        if previous is None or current is None:
            raise HTTPException(status_code=404, detail="Uma das atualizações selecionadas não existe no histórico.")
        if previous is current:
            raise HTTPException(status_code=422, detail="Selecione duas atualizações diferentes.")
        if is_restoration(previous) or is_restoration(current):
            raise HTTPException(status_code=422, detail="Selecione duas atualizações de inventário, sem restaurações.")
        return compare_updates(
            comparison_history_for_display(previous),
            comparison_history_for_display(current),
        )

    def load_ticket_report() -> Dict[str, Any]:
        path = ticket_report_path()
        if not path.exists():
            return {
                "atualizado_em": None,
                "fontes": {},
                "resumo": {
                    "series_total": 0, "conferidas": 0, "divergentes": 0,
                    "sem_os": 0, "somente_simpress": 0, "somente_oracle": 0,
                },
                "chamados": [],
                "historico": [],
            }
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            raise HTTPException(status_code=503, detail="O acompanhamento de chamados não pôde ser lido.") from None
        if not isinstance(data, dict) or not isinstance(data.get("chamados"), list):
            raise HTTPException(status_code=503, detail="O acompanhamento de chamados está inválido.")
        return data

    def save_ticket_report(report: Dict[str, Any]) -> None:
        path = ticket_report_path()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with AtomicFileTransaction(transaction_root(), [path]) as transaction:
                transaction.update_json(path, lambda _current: report, {})
                transaction.commit()
        except FileBusyError:
            raise HTTPException(status_code=409, detail="O acompanhamento está sendo atualizado por outra operação local.") from None
        except (OSError, FileTransactionError):
            raise HTTPException(status_code=500, detail="Não foi possível salvar o acompanhamento de chamados.") from None

    def displayed_ticket_snapshots(report: Dict[str, Any]) -> List[Dict[str, Any]]:
        return [normalize_ticket_snapshot(item) for item in ticket_report_snapshots(report)]

    @router.get("/api/operacoes/chamados")
    def get_ticket_report():
        report = load_ticket_report()
        snapshots = displayed_ticket_snapshots(report)
        current = next((item for item in reversed(snapshots) if item), None)
        response = {key: value for key, value in report.items() if key != "historico"}
        response = normalize_ticket_snapshot(response)
        response["snapshot_id"] = current.get("id", "") if current else ""
        response["historico"] = [
            ticket_snapshot_metadata(item)
            for item in reversed(snapshots)
        ]
        return response

    @router.get("/api/operacoes/chamados/historico")
    def get_ticket_history():
        snapshots = displayed_ticket_snapshots(load_ticket_report())
        return {"eventos": [ticket_snapshot_metadata(item) for item in reversed(snapshots)], "total": len(snapshots)}

    @router.delete("/api/operacoes/chamados/historico/antigas")
    def delete_old_ticket_imports():
        path = ticket_report_path()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with AtomicFileTransaction(transaction_root(), [path]) as transaction:
                report = load_ticket_report()
                snapshots = ticket_report_snapshots(report)
                if len(snapshots) <= 1:
                    latest = snapshots[-1] if snapshots else None
                    return {
                        "removidas": 0,
                        "mantida": ticket_snapshot_metadata(latest) if latest else None,
                        "total": len(snapshots),
                    }

                latest = snapshots[-1]
                cleaned_report = dict(report)
                cleaned_report.update({field: latest.get(field) for field in TICKET_SNAPSHOT_FIELDS})
                cleaned_report["snapshot_id"] = latest["id"]
                cleaned_report["historico"] = [latest]
                transaction.update_json(path, lambda _current: cleaned_report, {})
                transaction.commit()
        except FileBusyError:
            raise HTTPException(status_code=409, detail="O acompanhamento está sendo atualizado por outra operação local.") from None
        except (OSError, FileTransactionError):
            raise HTTPException(status_code=500, detail="Não foi possível remover as importações antigas do acompanhamento.") from None

        return {
            "removidas": len(snapshots) - 1,
            "mantida": ticket_snapshot_metadata(latest),
            "total": 1,
        }

    @router.get("/api/operacoes/chamados/snapshot/{snapshot_id}")
    def get_ticket_snapshot(snapshot_id: str):
        snapshot = next(
            (item for item in displayed_ticket_snapshots(load_ticket_report()) if item.get("id") == snapshot_id),
            None,
        )
        if snapshot is None:
            raise HTTPException(status_code=404, detail="A versão selecionada não existe no histórico de chamados.")
        return snapshot

    @router.get("/api/operacoes/chamados/evolucao")
    def get_ticket_evolution(anterior: str, atual: str):
        snapshots = displayed_ticket_snapshots(load_ticket_report())
        previous = next((item for item in snapshots if item.get("id") == anterior), None)
        current = next((item for item in snapshots if item.get("id") == atual), None)
        if previous is None or current is None:
            raise HTTPException(status_code=404, detail="Uma das versões selecionadas não existe no histórico de chamados.")
        if anterior == atual:
            raise HTTPException(status_code=422, detail="Selecione duas versões diferentes para comparar.")
        return compare_ticket_snapshots(previous, current)

    @router.get("/api/operacoes/chamados/exportar")
    def export_ticket_report(
        snapshot_id: str = "",
        relation: str = "",
        status: str = "",
        queue: str = "",
        search: str = "",
        stale_days: int = 3,
        age_filter: str = "",
        attention_only: bool = False,
    ):
        if stale_days < 0 or stale_days > 3650:
            raise HTTPException(status_code=422, detail="O limite de dias sem atualização deve estar entre 0 e 3650.")
        report = load_ticket_report()
        snapshots = displayed_ticket_snapshots(report)
        selected_id = snapshot_id or (snapshots[-1].get("id", "") if snapshots else "")
        snapshot = next((item for item in snapshots if item.get("id") == selected_id), None)
        if snapshot is None:
            raise HTTPException(status_code=404, detail="A versão selecionada não existe no histórico de chamados.")
        filters = {
            "relation": relation, "status": status, "queue": queue, "search": search,
            "stale_days": stale_days, "age_filter": age_filter, "attention_only": attention_only,
        }
        tickets = filter_ticket_records(
            snapshot.get("chamados", []),
            relation=relation,
            status=status,
            queue=queue,
            search=search,
            stale_days=stale_days,
            age_filter=age_filter,
            attention_only=attention_only,
        )
        output = build_ticket_workbook(snapshot, tickets, filters)
        date_label = str(snapshot.get("atualizado_em") or datetime.now().astimezone().isoformat())[:10].replace("-", "")
        return StreamingResponse(
            BytesIO(output),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="Acompanhamento_de_Chamados_{date_label}.xlsx"'},
        )

    @router.post("/api/operacoes/chamados/importar")
    def import_ticket_workbooks(
        simpress_file: UploadFile = File(...),
        oracle_file: UploadFile = File(...),
    ):
        def read_source(upload: UploadFile, source_label: str):
            raw_name = upload.filename or ""
            filename = raw_name.replace("\\", "/").rsplit("/", 1)[-1].strip()
            if not filename.lower().endswith(".xlsx"):
                raise HTTPException(status_code=400, detail=f"Selecione um arquivo .xlsx para a fonte {source_label}.")
            content = upload.file.read(MAX_TICKET_WORKBOOK_BYTES + 1)
            if len(content) > MAX_TICKET_WORKBOOK_BYTES:
                raise HTTPException(status_code=413, detail=f"O arquivo {source_label} excede o limite de 32 MB.")
            if not content:
                raise HTTPException(status_code=400, detail=f"O arquivo da fonte {source_label} está vazio.")
            return content, filename[:200]

        simpress_bytes, simpress_filename = read_source(simpress_file, "Simpress")
        oracle_bytes, oracle_filename = read_source(oracle_file, "Oracle")
        try:
            report = reconcile_ticket_workbooks(
                simpress_bytes,
                oracle_bytes,
                simpress_filename=simpress_filename,
                oracle_filename=oracle_filename,
            )
        except XlsxLimitExceeded as error:
            raise HTTPException(status_code=413, detail=str(error)) from None
        except XlsxPackageError:
            raise HTTPException(status_code=400, detail="Um dos arquivos não é um XLSX válido.") from None
        except TicketWorkbookError as error:
            raise HTTPException(status_code=422, detail=str(error)) from None

        report["atualizado_em"] = datetime.now().astimezone().isoformat(timespec="seconds")
        snapshot = {
            "id": str(uuid4()),
            "atualizado_em": report["atualizado_em"],
            "fontes": report.get("fontes", {}),
            "resumo": report.get("resumo", {}),
            "chamados": report.get("chamados", []),
        }
        history = ticket_report_snapshots(load_ticket_report())
        history.append(snapshot)
        report["snapshot_id"] = snapshot["id"]
        report["historico"] = history[-MAX_TICKET_SNAPSHOTS:]
        save_ticket_report(report)
        response = {key: value for key, value in report.items() if key != "historico"}
        response["historico"] = [
            ticket_snapshot_metadata(item)
            for item in reversed(displayed_ticket_snapshots(report))
        ]
        return response

    return router
