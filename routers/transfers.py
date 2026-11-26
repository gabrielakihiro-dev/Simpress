"""Transfer form schema and official workbook generation route."""

import io
import logging
import re
import unicodedata
from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from core.xlsx_safety import set_cell_value_as_text
from domains.transfers import TransferenciaPayload, formatar_telefone_brasileiro

from core.integrity import (
    FileBusyError,
    FileTransactionError,
    WorkbookSafetyError,
    load_workbook_safely,
    lock_paths,
    serialize_workbook_validated,
    workbook_snapshot,
)

logger = logging.getLogger(__name__)


def gerar_planilha_transferencia_bytes(payload: TransferenciaPayload, template_file: Path) -> tuple[str, bytes]:
    """Validate the payload and return (filename, workbook bytes); also used for the UX ticket attachment."""
    if not payload.serial.strip():
        raise HTTPException(
            status_code=422,
            detail='Preencha o campo obrigatório "Número de série do equipamento" para gerar a planilha oficial.',
        )
    if not re.sub(r"[^A-Za-z0-9]", "", payload.serial):
        raise HTTPException(
            status_code=422,
            detail="Número de série do equipamento precisa conter letras ou números.",
        )

    campos_obrigatorios: tuple[tuple[str, str], ...] = (
        ("serial", "Número de série do equipamento"),
        ("retirada_cnpj", "CNPJ"),
        ("retirada_endereco", "Endereço"),
        ("entrega_cnpj", "CNPJ"),
        ("entrega_endereco", "Endereço"),
        ("retirada_contato", "Nome do contato na retirada"),
        ("retirada_email", "E-mail do contato na retirada"),
        ("retirada_telefone", "Celular"),
        ("retirada_obs", "Observações"),
        ("entrega_contato", "Nome do Destinatário ou Representante"),
        ("entrega_email", "E-mail do Destinatário"),
        ("entrega_telefone", "Celular"),
        ("entrega_horario", "Expediente da unidade de entrega"),
        ("entrega_almoco", "Horário de almoço da unidade de entrega"),
        ("entrega_obs", "Observações"),
    )
    almoco_entrega_normalizado = unicodedata.normalize("NFD", payload.entrega_almoco)
    almoco_entrega_normalizado = almoco_entrega_normalizado.encode("ascii", "ignore").decode("ascii").casefold()
    almoco_entrega_normalizado = " ".join(almoco_entrega_normalizado.split())
    if almoco_entrega_normalizado != "escritorio nao fecha":
        campos_obrigatorios += (("entrega_pausa_duracao", "Duração da pausa da unidade de entrega"),)
    campo_vazio = next(
        ((nome, rotulo) for nome, rotulo in campos_obrigatorios if not getattr(payload, nome).strip()),
        None,
    )
    if campo_vazio:
        _, rotulo = campo_vazio
        raise HTTPException(
            status_code=422,
            detail=f'Preencha o campo obrigatório "{rotulo}" para gerar a planilha oficial.',
        )

    if not template_file.exists():
        raise HTTPException(status_code=500, detail=f"Arquivo de template '{template_file.name}' não encontrado no servidor.")

    wb = None
    try:
        with lock_paths([template_file]):
            wb = load_workbook_safely(
                template_file,
                allow_threaded_comments=True,
                allow_legacy_comments=True,
                allow_custom_xml_passthrough=True,
            )
            original_snapshot = workbook_snapshot(wb)
            sheet_target = next(
                (name for name in wb.sheetnames if "transfer" in name.lower() and "lote" not in name.lower()),
                wb.sheetnames[0],
            )
            ws = wb[sheet_target]
            expected_values = {}

            def set_template_cell(address: str, value: Any) -> None:
                set_cell_value_as_text(ws[address], value)
                expected_values[(ws.title, address)] = value

            serial_val = payload.serial.strip().upper()
            descricao_val = payload.descricao_equipamento.strip()
            retirada_obs_val = payload.retirada_obs.strip() or descricao_val
            retirada_telefone = formatar_telefone_brasileiro(payload.retirada_telefone)
            entrega_telefone = formatar_telefone_brasileiro(payload.entrega_telefone)

            contrato_val: Any = payload.contrato
            try:
                contrato_val = int(contrato_val)
            except (ValueError, TypeError):
                pass

            set_template_cell("B5", payload.razao_social or "SERVICO DE APOIO AS MICRO E PEQUENAS EMPRESAS DO PARANA - SEBRAE/PR")
            set_template_cell("J5", contrato_val)
            set_template_cell("B8", serial_val)
            set_template_cell("F8", descricao_val)

            # Bloco de Retirada (Origem).
            set_template_cell("B17", payload.retirada_cnpj)
            set_template_cell("F17", payload.retirada_endereco)
            set_template_cell("B19", payload.retirada_horario)
            set_template_cell("F19", payload.retirada_almoco)
            set_template_cell("J19", payload.retirada_pausa_duracao)
            set_template_cell("B21", payload.retirada_tipo_acesso)
            set_template_cell("J21", payload.retirada_acesso_obs)
            set_template_cell("B23", payload.retirada_contato)
            set_template_cell("F23", payload.retirada_email)
            set_template_cell("J23", retirada_telefone)
            set_template_cell("B25", retirada_obs_val)
            set_template_cell("J25", payload.retirada_voltagem)

            # Bloco de Entrega (Destino).
            set_template_cell("B29", payload.entrega_cnpj)
            set_template_cell("F29", payload.entrega_endereco)
            set_template_cell("B31", payload.entrega_horario)
            set_template_cell("F31", payload.entrega_almoco)
            set_template_cell("J31", payload.entrega_pausa_duracao)
            set_template_cell("B33", payload.entrega_tipo_acesso)
            set_template_cell("J33", payload.entrega_acesso_obs)
            set_template_cell("B35", payload.entrega_contato)
            set_template_cell("F35", payload.entrega_email)
            set_template_cell("J35", entrega_telefone)
            set_template_cell("B37", payload.entrega_obs)
            set_template_cell("J37", payload.entrega_voltagem)

            output_bytes = serialize_workbook_validated(
                template_file, wb, original_snapshot, expected_values,
                allow_threaded_comments=True,
                allow_legacy_comments=True,
                allow_custom_xml_passthrough=True,
                normalize_threaded_comment_placeholders=True,
            )
            wb.close()

        # ASCII only: the name goes into a latin-1 Content-Disposition header.
        safe_serial = re.sub(r"[^A-Za-z0-9-]", "_", serial_val)

        def safe_city(value: str) -> str:
            normalized = unicodedata.normalize("NFKD", value.strip())
            ascii_value = normalized.encode("ascii", "ignore").decode("ascii")
            return re.sub(r"[^A-Za-z0-9]", "", ascii_value) or "CidadeNaoInformada"

        safe_retirada = safe_city(payload.retirada_cidade)
        safe_entrega = safe_city(payload.entrega_cidade)
        filename = f"Transferencia_{safe_serial}_{safe_retirada}-{safe_entrega}.xlsx"
        return filename, output_bytes

    except FileBusyError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except WorkbookSafetyError as error:
        raise HTTPException(status_code=409, detail=f"Geração cancelada para preservar o template: {error}") from error
    except FileTransactionError as error:
        raise HTTPException(status_code=500, detail=f"Não foi possível validar a planilha gerada: {error}") from error
    except Exception:
        logger.exception("Falha ao gerar a planilha de transferência.")
        raise HTTPException(status_code=500, detail="Erro ao processar o modelo Excel.") from None
    finally:
        if wb is not None:
            wb.close()


def _gerar_planilha_transferencia(payload: TransferenciaPayload, template_file: Path) -> StreamingResponse:
    filename, output_bytes = gerar_planilha_transferencia_bytes(payload, template_file)
    return StreamingResponse(
        io.BytesIO(output_bytes),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def create_transfer_router(
    template_file_provider: Callable[[], Path],
) -> tuple[APIRouter, Callable[[TransferenciaPayload], StreamingResponse]]:
    """Create the transfer route with a path provider that can follow runtime overrides."""
    router = APIRouter()

    def gerar_planilha(payload: TransferenciaPayload) -> StreamingResponse:
        return _gerar_planilha_transferencia(payload, template_file_provider())

    router.add_api_route(
        "/api/gerar-planilha",
        endpoint=gerar_planilha,
        methods=["POST"],
        name="gerar_planilha",
    )
    return router, gerar_planilha
