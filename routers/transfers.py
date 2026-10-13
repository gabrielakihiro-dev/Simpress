"""Transfer form schema and official workbook generation route."""

import io
import re
import unicodedata
from pathlib import Path
from typing import Any, Callable, Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator
from core.config import TRANSFER_ORIGIN_CONTACT, TRANSFER_ORIGIN_EMAIL, TRANSFER_ORIGIN_PHONE

from core.integrity import (
    FileBusyError,
    FileTransactionError,
    WorkbookSafetyError,
    load_workbook_safely,
    lock_paths,
    serialize_workbook_validated,
    workbook_snapshot,
)


class TransferenciaPayload(BaseModel):
    serial: str = Field(..., min_length=1, max_length=128, description="Número de Série do Equipamento")
    descricao_equipamento: str = Field("", max_length=2000, description="Descrição e Acessórios do Equipamento")
    razao_social: str = Field("SERVICO DE APOIO AS MICRO E PEQUENAS EMPRESAS DO PARANA - SEBRAE/PR", max_length=300)
    contrato: Literal[16467] = Field(16467, description="Número do Contrato")

    # Retirada (Origem)
    retirada_cidade: str = Field("", max_length=160)
    retirada_cnpj: str = Field("", max_length=24)
    retirada_endereco: str = Field("", max_length=500)
    retirada_horario: str = Field("09:00:00 às 18:00:00", max_length=120)
    retirada_almoco: str = Field("12:00:00", max_length=64)
    retirada_pausa_duracao: str = Field("1h12", max_length=64)
    retirada_tipo_acesso: str = Field("Elevador / Rampa / Térreo", max_length=160)
    retirada_acesso_obs: str = Field("", max_length=1000)
    retirada_contato: str = Field(TRANSFER_ORIGIN_CONTACT, max_length=160)
    retirada_email: str = Field(TRANSFER_ORIGIN_EMAIL, max_length=254)
    retirada_telefone: str = Field(TRANSFER_ORIGIN_PHONE, max_length=64)
    retirada_obs: str = Field("", max_length=2000)
    retirada_voltagem: str = Field("Bivolt", max_length=64)

    # Entrega (Destino)
    entrega_cidade: str = Field("", max_length=160)
    entrega_cnpj: str = Field(..., min_length=1, max_length=24)
    entrega_endereco: str = Field(..., min_length=1, max_length=500)
    entrega_horario: str = Field("09:00:00 às 18:00:00", max_length=120)
    entrega_almoco: str = Field("12:00:00", max_length=64)
    # Keep omission distinct from an explicitly supplied one-hour break. The
    # route validates this field when a break duration is required.
    entrega_pausa_duracao: str = Field("", max_length=64)
    entrega_tipo_acesso: str = Field("Elevador / Rampa / Térreo", max_length=160)
    entrega_acesso_obs: str = Field("", max_length=1000)
    entrega_contato: str = Field(..., min_length=1, max_length=160, description="Nome do Destinatário")
    entrega_email: str = Field("", max_length=254, description="E-mail do Destinatário")
    entrega_telefone: str = Field("", max_length=64, description="Telefone do Destinatário")
    entrega_obs: str = Field("", max_length=2000, description="Observações do Chamado")
    entrega_voltagem: str = Field("Bivolt", max_length=64)

    @field_validator("retirada_cnpj", "entrega_cnpj")
    @classmethod
    def validate_cnpj(cls, value: str) -> str:
        digits = re.sub(r"\D", "", value)
        if value.strip() and len(digits) != 14:
            raise ValueError("CNPJ deve conter exatamente 14 dígitos.")
        return value.strip()

    @field_validator("retirada_email", "entrega_email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        value = value.strip()
        if value and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value):
            raise ValueError("Informe um endereço de e-mail válido.")
        return value

    @field_validator("retirada_telefone", "entrega_telefone")
    @classmethod
    def validate_phone(cls, value: str) -> str:
        value = value.strip()
        if not value:
            return value
        main_part = re.sub(r"\s*(?:ramal|ram\.?|ext\.?|x)\s*[:.]?\s*\d+\s*$", "", value, flags=re.IGNORECASE)
        digits = re.sub(r"\D", "", main_part)
        if main_part.lstrip().startswith("+") and digits.startswith("55"):
            digits = digits[2:]
        elif digits.startswith("0055") and len(digits) in (14, 15):
            digits = digits[4:]
        elif digits.startswith("55") and len(digits) in (12, 13):
            digits = digits[2:]
        if len(digits) not in (10, 11):
            raise ValueError("Telefone deve conter DDD e 8 ou 9 dígitos, com ramal opcional.")
        return value


def formatar_telefone_brasileiro(value: Any) -> str:
    """Formata telefones brasileiros fixos e móveis e preserva ramais explícitos."""
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

    prefixo_mais = bool(re.match(r"^\s*\+55", telefone_original))
    prefixo_zero = bool(re.match(r"^\s*0055", telefone_original))
    prefixo_sem_sinal = not prefixo_mais and not prefixo_zero and digitos.startswith("55")
    if prefixo_mais:
        if len(digitos) not in (12, 13):
            return original
        digitos = digitos[2:]
    elif prefixo_zero:
        if len(digitos) not in (14, 15):
            return original
        digitos = digitos[4:]
    elif prefixo_sem_sinal and len(digitos) in (12, 13):
        digitos = digitos[2:]

    if len(digitos) < 3 or len(digitos) > 11:
        return original

    ddd = digitos[:2]
    numero = digitos[2:]
    if len(numero) == 8:
        numero_formatado = f"{numero[:4]}-{numero[4:]}"
    elif len(numero) == 9:
        numero_formatado = f"{numero[:5]}-{numero[5:]}"
    else:
        numero_formatado = f"{numero[:5]}-{numero[5:]}" if len(numero) > 5 else numero
    telefone_formatado = f"({ddd}) {numero_formatado}"
    ramal = ramal_explicito.group(1) if ramal_explicito else ""
    return f"{telefone_formatado} Ramal: {ramal}" if ramal else telefone_formatado


def _gerar_planilha_transferencia(payload: TransferenciaPayload, template_file: Path):
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
                normalize_threaded_comment_placeholders=True,
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


def create_transfer_router(template_file_provider: Callable[[], Path], generate_override=None):
    """Create the transfer route with a path provider that can follow runtime overrides."""
    router = APIRouter()

    def gerar_planilha(payload: TransferenciaPayload):
        if generate_override is not None:
            result = generate_override(payload)
            if result is not None:
                return result
        return _gerar_planilha_transferencia(payload, template_file_provider())

    router.add_api_route(
        "/api/gerar-planilha",
        endpoint=gerar_planilha,
        methods=["POST"],
        name="gerar_planilha",
    )
    return router, gerar_planilha
