"""Generate downloads from a SQL snapshot and private versioned templates."""

from collections import Counter
from datetime import datetime
import io
import json
from pathlib import Path
import tempfile
from urllib.parse import quote
from typing import Any

from fastapi.responses import StreamingResponse
from integrity import WorkbookSafetyError

from persistence.config import PersistenceError
from persistence.storage import XLSX


def transfer(files, payload):
    from routers.transfers import _gerar_planilha_transferencia
    content = files.template_bytes("transferencia")
    with tempfile.TemporaryDirectory(prefix="simpress-transfer-") as root:
        path = Path(root)/"modelo.xlsx"
        path.write_bytes(content)
        return _gerar_planilha_transferencia(payload,path)


def equipment(files):
    try:
        return _equipment(files)
    except WorkbookSafetyError:
        raise PersistenceError(409,"Exportação cancelada para preservar os recursos nativos do modelo.") from None


def _equipment(files):
    d = files.backend.domain
    with files.backend.transaction() as conn:
        snapshot = files.backend._snapshot(conn)
        state = files.backend.project(snapshot)
        oid = snapshot["global"]["modelo_exportacao_id"]
        if not oid or not snapshot["rows"]:
            raise PersistenceError(409,"Importe o inventário e um modelo de exportação no piloto.")
        obj = conn.execute("select * from simpress.objetos_arquivo where id=%s and estado='verificado'",(oid,)).fetchone()
        history = files.history.events(conn)
    if not obj:
        raise PersistenceError(409,"Modelo de exportação não verificado.")
    template = files.require_storage().get(obj)
    rows = state["equipamentos_cache"]
    normalized = {d.normalize_reference_value(r["serial"]):r for r in rows.values()}
    if any(n>1 for n in Counter(r["serie_normalizada"] for r in snapshot["rows"]).values()):
        raise PersistenceError(409,"A base ativa contém séries duplicadas; confira antes de exportar.")
    with tempfile.TemporaryDirectory(prefix="simpress-export-") as root:
        path = Path(root)/"modelo.xlsx"
        path.write_bytes(template)
        workbook = d.load_workbook_safely(path,allow_threaded_comments=True,allow_custom_xml_passthrough=True)
        try:
            original = d.workbook_snapshot(workbook)
            sheet = next((name for name in workbook.sheetnames if "parque" in name.lower() or "equipamento" in name.lower()),workbook.sheetnames[0])
            ws = workbook[sheet]
            column_headers = [c.value for c in next(ws.iter_rows(max_row=1),())]
            serial = d.find_workbook_header_column(column_headers,d.DETAILS_SERIAL_HEADER_ALIASES)
            alias = d.find_workbook_header_column(column_headers,("APELIDO",))
            client = d.find_workbook_header_column(column_headers,("IDCLIENTE",))
            if serial is None or alias is None:
                raise PersistenceError(409,"Modelo sem as colunas NumeroSerie e Apelido esperadas.")
            counts = Counter(d.normalize_reference_value(ws.cell(r,serial+1).value) for r in range(2,ws.max_row+1))
            counts.pop("",None)
            if set(counts) != set(normalized):
                raise PersistenceError(409,"As séries do modelo diferem da base ativa; importe um modelo compatível.")
            changes,alias_count,client_count,formula_count = {},0,0,0
            for r in range(2,ws.max_row+1):
                key = d.normalize_reference_value(ws.cell(r,serial+1).value)
                if not key or counts[key] != 1:
                    continue
                formula = False
                for column,value,kind in ((alias,normalized[key]["apelido"],"alias"),(client,normalized[key]["idCliente"],"client")):
                    if column is None:
                        continue
                    cell = ws.cell(r,column+1)
                    if cell.data_type == "f":
                        formula = True
                    elif cell.value != value:
                        cell.value = value
                        changes[(ws.title,cell.coordinate)] = value
                        alias_count += kind == "alias"
                        client_count += kind == "client"
                formula_count += formula
            content = d.serialize_workbook_validated(path,workbook,original,changes,allow_threaded_comments=True,allow_custom_xml_passthrough=True)
        finally:
            workbook.close()
    endpoint_reviews = d.endpoint_alias_review_items(files.endpoint_index([r["dados_interpretados"] for r in snapshot["endpoint"]]),set(counts))
    reviews = sum(n>1 for n in counts.values()) + formula_count + len(endpoint_reviews)
    latest: dict[str,Any] = next((e for e in reversed(history) if e.get("tipo") != "restauracao"),{})
    headers = {"Content-Disposition":'attachment; filename="EquipamentosDetalhes-'+datetime.now().strftime("%d-%m-%Y_%H%M%S")+'.xlsx"',
        "X-Total-Alterados":str(alias_count),"X-Total-IdCliente-Alterados":str(client_count),
        "X-Total-Alteracoes-Exportadas":str(alias_count+client_count),"X-Total-Conferencia":str(reviews),
        "X-Conferencia-Resumo":quote(json.dumps([{"motivo":"Registros do Endpoint, fórmulas e séries duplicadas no modelo","total":reviews}] if reviews else [])),
        "X-Historico-Apelidos-Atualizados":str(len(latest.get("comparacao",{}).get("apelidos_atualizados",[]))),
        "X-Historico-Horario":str(latest.get("horario") or "")}
    headers["Access-Control-Expose-Headers"] = ", ".join(headers)
    return StreamingResponse(io.BytesIO(content),media_type=XLSX,headers=headers)
