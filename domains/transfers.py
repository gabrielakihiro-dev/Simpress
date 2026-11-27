"""Transfer form schema and Brazilian phone formatting (shared by routers and the Assistant)."""

import re
from typing import Any

from pydantic import BaseModel, Field, field_validator

from core.config import CLIENT_NOT_CONFIGURED, client_contract


class TransferenciaPayload(BaseModel):
    serial: str = Field(..., min_length=1, max_length=128, description="Número de Série do Equipamento")
    descricao_equipamento: str = Field("", max_length=2000, description="Descrição e Acessórios do Equipamento")
    razao_social: str = Field("SERVICO DE APOIO AS MICRO E PEQUENAS EMPRESAS DO PARANA - SEBRAE/PR", max_length=300)
    contrato: str = Field("", description="Número do Contrato (o configurado em config/cliente.json)", validate_default=True)

    # Retirada (Origem)
    retirada_cidade: str = Field("", max_length=160)
    retirada_cnpj: str = Field("", max_length=24)
    retirada_endereco: str = Field("", max_length=500)
    retirada_horario: str = Field("09:00:00 às 18:00:00", max_length=120)
    retirada_almoco: str = Field("12:00:00", max_length=64)
    retirada_pausa_duracao: str = Field("1h12", max_length=64)
    retirada_tipo_acesso: str = Field("Elevador / Rampa / Térreo", max_length=160)
    retirada_acesso_obs: str = Field("", max_length=1000)
    retirada_contato: str = Field("", max_length=160)
    retirada_email: str = Field("", max_length=254)
    retirada_telefone: str = Field("", max_length=64)
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

    @field_validator("contrato", mode="before")
    @classmethod
    def validate_contract(cls, value: Any) -> str:
        """Only the configured contract passes; without configuration nothing does (blank must not equal blank)."""
        configured = client_contract()
        if not configured:
            raise ValueError(CLIENT_NOT_CONFIGURED)
        received = configured if value is None or str(value).strip() == "" else str(value).strip()
        if received != configured:
            raise ValueError(f"Este sistema só gera transferências do contrato {configured}.")
        return configured

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
