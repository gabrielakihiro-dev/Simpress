"""Transfer form schema and official workbook generation route."""

import io
import re
import unicodedata
from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from integrity import (
    FileBusyError,
    FileTransactionError,
    WorkbookSafetyError,
    load_workbook_safely,
    lock_paths,
    serialize_workbook_validated,
    workbook_snapshot,
)


class TransferenciaPayload(BaseModel):
    serial: str = Field(..., description="Número de Série do Equipamento")
    descricao_equipamento: str = Field("", description="Descrição e Acessórios do Equipamento")
    razao_social: str = Field("SERVICO DE APOIO AS MICRO E PEQUENAS EMPRESAS DO PARANA - SEBRAE/PR")
    contrato: Any = Field(16467, description="Número do Contrato")

    # Retirada (Origem)
    retirada_cidade: str = Field("")
    retirada_cnpj: str = Field("")
    retirada_endereco: str = Field("")
    retirada_horario: str = Field("09:00:00 às 18:00:00")
    retirada_almoco: str = Field("12:00:00")
    retirada_pausa_duracao: str = Field("1h12")
    retirada_tipo_acesso: str = Field("Elevador / Rampa / Térreo")
    retirada_acesso_obs: str = Field("")
    retirada_contato: str = Field("Gabriel Akihiro Noda Souza (Simpress)")
    retirada_email: str = Field("gansouza@simpress.com.br")
    retirada_telefone: str = Field("(41) 98751-2389")
    retirada_obs: str = Field("")
    retirada_voltagem: str = Field("Bivolt")

    # Entrega (Destino)
    entrega_cidade: str = Field("")
    entrega_cnpj: str = Field(...)
    entrega_endereco: str = Field(...)
    entrega_horario: str = Field("09:00:00 às 18:00:00")
    entrega_almoco: str = Field("12:00:00")
    # Keep omission distinct from an explicitly supplied one-hour break. The
    # route validates this field when a break duration is required.
    entrega_pausa_duracao: str = Field("")
    entrega_tipo_acesso: str = Field("Elevador / Rampa / Térreo")
    entrega_acesso_obs: str = Field("")
    entrega_contato: str = Field(..., description="Nome do Destinatário")
    entrega_email: str = Field("", description="E-mail do Destinatário")
    entrega_telefone: str = Field("", description="Telefone do Destinatário")
    entrega_obs: str = Field("", description="Observações do Chamado")
    entrega_voltagem: str = Field("Bivolt")


def formatar_telefone_brasileiro(value: Any) -> str:
    """Padroniza telefones brasileiros no formato (DD) 9xxxx-xxxx e preserva ramais."""
    original = str(value or "").strip()
    if not original:
        return ""

    ramal_explicito = re.search(
        r"(?:ramal|ram\.?|ext\.?|x)\s*[:.]?\s*(\d+)\s*$",
        original,
        re.IGNORECASE,
    )
    if re.search(r"[A-Za-zÀ-ÿ]", original) and not ramal_explicito:
        return original

    telefone_original = original[:ramal_explicito.start()] if ramal_explicito else original
    digitos = re.sub(r"\D", "", telefone_original)

    if re.match(r"^\s*\+55\b", telefone_original) and len(digitos) >= 13:
        digitos = digitos[2:]
    elif re.match(r"^\s*0055\b", telefone_original) and len(digitos) >= 15:
        digitos = digitos[4:]

    if len(digitos) < 3:
        return original

    ddd = digitos[:2]
    numero = digitos[2:11]
    numero_formatado = f"{numero[:5]}-{numero[5:]}" if len(numero) > 5 else numero
    telefone_formatado = f"({ddd}) {numero_formatado}"
    ramal = ramal_explicito.group(1) if ramal_explicito else digitos[11:]
    return f"{telefone_formatado} Ramal: {ramal}" if ramal else telefone_formatado


def _gerar_planilha_transferencia(payload: TransferenciaPayload, template_file: Path):
    campos_obrigatorios = (
        ("retirada_contato", "Nome do contato na retirada"),
        ("retirada_email", "E-mail do contato na retirada"),
        ("retirada_telefone", "Telefone / Ramal do contato na retirada"),
        ("retirada_obs", "Observações Adicionais da Retirada"),
        ("entrega_contato", "Nome do Destinatário ou Representante"),
        ("entrega_email", "E-mail do Destinatário"),
        ("entrega_telefone", "Telefone / Ramal do Destinatário"),
        ("entrega_horario", "Expediente da unidade de entrega"),
        ("entrega_almoco", "Horário de almoço da unidade de entrega"),
        ("entrega_obs", "Observações Adicionais do Chamado"),
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
                ws[address].value = value
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
            )
            wb.close()

        buffer = io.BytesIO(output_bytes)
        buffer.seek(0)

        safe_serial = re.sub(r"[^\w\-]", "_", serial_val)

        def safe_city(value: str) -> str:
            normalized = unicodedata.normalize("NFKD", value.strip())
            ascii_value = normalized.encode("ascii", "ignore").decode("ascii")
            return re.sub(r"[^A-Za-z0-9]", "", ascii_value) or "CidadeNaoInformada"

        safe_retirada = safe_city(payload.retirada_cidade)
        safe_entrega = safe_city(payload.entrega_cidade)
        filename = f"Transferencia_{safe_serial}_{safe_retirada}-{safe_entrega}.xlsx"

        return StreamingResponse(
            buffer,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    except FileBusyError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except WorkbookSafetyError as error:
        raise HTTPException(status_code=409, detail=f"Geração cancelada para preservar o template: {error}") from error
    except FileTransactionError as error:
        raise HTTPException(status_code=500, detail=f"Não foi possível validar a planilha gerada: {error}") from error
    except Exception:
        print("[ERRO] Falha ao gerar a planilha de transferência.")
        raise HTTPException(status_code=500, detail="Erro ao processar o modelo Excel.") from None
    finally:
        if wb is not None:
            wb.close()


def create_transfer_router(template_file_provider: Callable[[], Path]):
    """Create the transfer route with a path provider that can follow runtime overrides."""
    router = APIRouter()

    def gerar_planilha(payload: TransferenciaPayload):
        return _gerar_planilha_transferencia(payload, template_file_provider())

    router.add_api_route(
        "/api/gerar-planilha",
        endpoint=gerar_planilha,
        methods=["POST"],
        name="gerar_planilha",
    )
    return router, gerar_planilha
