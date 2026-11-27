"""Validators and payload builders of the assistant tools (annotation, OS link, transfer, origin contact, regional representative).

Leaf module: `assistant_api` re-exports these names, so nothing here may import it.
"""

import re
import unicodedata
from typing import Any, Dict, List, Optional, Tuple

from pydantic import ValidationError

from domains.local_setup import (
    REGIONAL_REPRESENTATIVE_CITIES, REGIONAL_REPRESENTATIVE_DEFAULTS, REGIONAL_REPRESENTATIVE_FIELDS, RepresentanteRegionalPayload,
)
from domains.transfers import TransferenciaPayload, formatar_telefone_brasileiro

DECISOES_VALIDAS = ("permitir", "recusar", "remover", "manter")
MAX_ANOTACAO = 2000  # same limit as the annotation routes (history_annotations.MAX_ANNOTATION_LENGTH)


def _dict(valor: Any) -> Dict[str, Any]:
    return valor if isinstance(valor, dict) else {}


def validar_anotacao(texto: Any) -> str:
    """The text as the route will receive it; ValueError (pt-BR) when the route would refuse it."""
    texto = "" if texto is None else str(texto)
    if len(texto) > MAX_ANOTACAO:
        raise ValueError(f"A anotação passa de {MAX_ANOTACAO} caracteres.")
    return texto


_CHAMADO_UTIC = re.compile(r"^UTIC-(\d{4})-(\d{1,24})$")
FONTES_VINCULO_OS = ("simpress", "oracle")


def validar_vinculo_os(fonte: Any, serie: Any, ordem: Any, chamado: Any) -> Dict[str, Any]:
    """The body the vinculos-os route will receive; ValueError (pt-BR) when the route would refuse it."""
    fonte, serie, ordem = str(fonte or "").strip().lower(), str(serie or "").strip().upper(), str(ordem or "").strip()
    achado = _CHAMADO_UTIC.match(str(chamado or "").strip().upper())
    if fonte not in FONTES_VINCULO_OS:
        raise ValueError(f"Fonte inválida. Opções: {', '.join(FONTES_VINCULO_OS)}.")
    if not serie or len(serie) > 128 or not ordem or len(ordem) > 160:
        raise ValueError("Informe a série (até 128 caracteres) e a OS (até 160 caracteres).")
    if achado is None or not 2000 <= int(achado.group(1)):
        raise ValueError("Chamado inválido. Use o formato UTIC-AAAA-número (ex.: UTIC-2026-42).")
    return {"fonte": fonte, "serie": serie, "os": ordem, "ano": int(achado.group(1)), "numero": achado.group(2)}


# Origin contact of the transfer form: (route field, tool argument, name on the card, limit as in ContatoOrigemPayload).
_CAMPOS_CONTATO_ORIGEM = (
    ("retirada_contato", "contato", "Nome", 160),
    ("retirada_email", "email", "E-mail", 254),
    ("retirada_telefone", "telefone", "Celular", 64),
)


def montar_contato_origem(atual: Dict[str, Any], contato: Any, email: Any, telefone: Any) -> Tuple[Dict[str, str], List[Tuple[str, str, str]]]:
    """(body for the contato-origem route, [(label, current, new)] of the fields that change); ValueError (pt-BR) when the route would refuse.

    Omitted fields keep the current value. A field set by environment variable cannot be changed here (the variable wins over the file)."""
    fontes = _dict(atual.get("contato_origem_fontes"))
    novos = {"retirada_contato": contato, "retirada_email": email, "retirada_telefone": telefone}
    corpo: Dict[str, str] = {}
    mudancas: List[Tuple[str, str, str]] = []
    for campo, chave, rotulo, limite in _CAMPOS_CONTATO_ORIGEM:
        antigo = str(atual.get(campo) or "").strip()
        valor = novos[campo]
        valor = valor.strip() if isinstance(valor, str) else ""
        ambiente = fontes.get(campo) == "ambiente"
        if valor and "OCULTADO]" in valor:
            raise ValueError(f"{rotulo} digitado no chat é ocultado do modelo (LGPD). Peça ao usuário para preencher na tela de Transferência.")
        if valor and ambiente:
            raise ValueError(f"{rotulo} é definido por variável de ambiente e não pode ser alterado aqui.")
        if len(valor) > limite:
            raise ValueError(f"{rotulo} longo demais (máximo {limite} caracteres).")
        if valor and campo == "retirada_email":
            valor = TransferenciaPayload.validate_email(valor)
        elif valor and campo == "retirada_telefone":
            valor = formatar_telefone_brasileiro(TransferenciaPayload.validate_phone(valor))
        if valor and valor != antigo:
            mudancas.append((rotulo, antigo, valor))
        final = "" if ambiente else (valor or antigo)
        if not final and not ambiente:
            raise ValueError(f"O campo {rotulo} ainda não está configurado: informe também ele.")
        corpo[chave] = final
    if not mudancas:
        raise ValueError("Nenhum valor novo: informe nome, e-mail ou celular diferente do atual. Nada a alterar.")
    return corpo, mudancas


# Regional representative of a city: (body field, tool argument, name on the card as on the screen, limit as in RepresentanteRegionalPayload).
_CAMPOS_REPRESENTANTE = (
    ("nome", "nome", "Nome", 160), ("email", "email", "E-mail", 254), ("telefone", "telefone", "Celular", 64),
    ("horario", "horario", "Expediente", 64), ("almoco", "almoco", "Almoço", 64), ("pausaDuracao", "pausa", "Pausa", 16),
)
_ALMOCO_NAO_FECHA = "Escritório não fecha"


def _chave_cidade(texto: Any) -> str:
    sem_acento = "".join(c for c in unicodedata.normalize("NFD", str(texto or "")) if unicodedata.category(c) != "Mn")
    return " ".join(sem_acento.casefold().split())


def resolver_cidade_representante(cidade: Any) -> str:
    """The known city (with accents) the text points at, ignoring accent and case; ValueError (pt-BR) otherwise."""
    chave = _chave_cidade(cidade)
    for conhecida in REGIONAL_REPRESENTATIVE_CITIES:
        if chave and _chave_cidade(conhecida) == chave:
            return conhecida
    raise ValueError(f"Cidade sem representante regional: informe uma destas: {', '.join(REGIONAL_REPRESENTATIVE_CITIES)}.")


def representante_padrao(cidade: str, padroes: Optional[Dict[str, Any]] = None) -> Dict[str, str]:
    """Default of the city: the code's, overridden by the effective default the route returns (`padroes`, by city)."""
    local = _dict((padroes or {}).get(cidade))
    base = REGIONAL_REPRESENTATIVE_DEFAULTS[cidade]
    return {c: local[c] if isinstance(local.get(c), str) else base[c] for c in REGIONAL_REPRESENTATIVE_FIELDS}


def representante_efetivo(cidade: str, salvos: Dict[str, Any], padroes: Optional[Dict[str, Any]] = None) -> Tuple[Dict[str, str], bool]:
    """(default merged with the saved change of the city, whether a change is saved)."""
    salvo, padrao = _dict(salvos.get(cidade)), representante_padrao(cidade, padroes)
    return {c: salvo[c] if isinstance(salvo.get(c), str) else padrao[c] for c in REGIONAL_REPRESENTATIVE_FIELDS}, bool(salvo)


def diferencas_representante(antes: Dict[str, str], depois: Dict[str, str]) -> List[Tuple[str, str, str]]:
    """[(label, before, after)] of the fields that differ, with the labels of the screen."""
    return [(rotulo, antes.get(c, ""), depois.get(c, "")) for c, _, rotulo, _ in _CAMPOS_REPRESENTANTE if antes.get(c, "") != depois.get(c, "")]


def montar_representante_regional(
    efetivo: Dict[str, str], nome: Any, email: Any, telefone: Any, horario: Any, almoco: Any, pausa: Any,
) -> Tuple[Dict[str, str], List[Tuple[str, str, str]]]:
    """(body of the PUT route with the 6 fields, [(label, current, new)] that change); ValueError (pt-BR) when the route would refuse.

    A field that is None keeps the current value; an empty text clears it (name, e-mail, phone, pause)."""
    novos = {"nome": nome, "email": email, "telefone": telefone, "horario": horario, "almoco": almoco, "pausaDuracao": pausa}
    corpo: Dict[str, str] = {}
    for campo, _, rotulo, limite in _CAMPOS_REPRESENTANTE:
        valor = novos[campo]
        if valor is None:
            corpo[campo] = str(efetivo.get(campo) or "").strip()
            continue
        valor = str(valor).strip()
        if campo in ("nome", "email", "telefone") and "OCULTADO]" in valor:
            raise ValueError(f"{rotulo} digitado no chat é ocultado do modelo (LGPD). Peça ao usuário para usar o botão Editar, ao lado do representante regional, na tela de Transferência.")
        if len(valor) > limite:
            raise ValueError(f"{rotulo} longo demais (máximo {limite} caracteres).")
        if valor and campo == "email":
            valor = TransferenciaPayload.validate_email(valor)
        elif valor and campo == "telefone":
            valor = formatar_telefone_brasileiro(TransferenciaPayload.validate_phone(valor))
        corpo[campo] = valor
    mudancas = diferencas_representante({c: str(efetivo.get(c) or "").strip() for c in corpo}, corpo)
    if not mudancas:
        raise ValueError("Nenhum valor novo: informe algum campo diferente do atual. Nada a alterar.")
    try:
        RepresentanteRegionalPayload(**corpo)
    except ValidationError as erro:
        raise ValueError(str(erro.errors()[0]["msg"]).removeprefix("Value error, ")) from None
    if corpo["almoco"] != _ALMOCO_NAO_FECHA and not corpo["pausaDuracao"]:  # same rule as the screen
        raise ValueError('Preencha a pausa, por exemplo 1h30, ou use almoço "Escritório não fecha".')
    return corpo, mudancas



ACOES_APELIDO_MANUAL = ("manter", "excluir")
CAMPOS_TRANSFERENCIA = ("serial", "entrega_cnpj", "entrega_endereco", "entrega_contato", "entrega_cidade", "descricao_equipamento", "entrega_obs")
OBRIGATORIOS_TRANSFERENCIA = ("serial", "entrega_cnpj", "entrega_endereco", "entrega_contato")


def validar_transferencia(args: Dict[str, Any]) -> Dict[str, str]:
    """Body for the transfer history: the required fields plus the few optional ones the tool offers. ValueError with text for the model."""
    corpo = {c: str(args.get(c) or "").strip() for c in CAMPOS_TRANSFERENCIA}
    corpo["serial"] = corpo["serial"].upper()
    if not all(corpo[c] for c in OBRIGATORIOS_TRANSFERENCIA):
        raise ValueError("Informe serial, CNPJ, endereço e contato da entrega.")
    corpo = {c: v for c, v in corpo.items() if v}
    try:
        TransferenciaPayload.model_validate(corpo)
    except ValidationError as erro:
        primeiro = erro.errors()[0]
        raise ValueError(f"Campo {'.'.join(str(p) for p in primeiro['loc'])} inválido: {str(primeiro['msg']).removeprefix('Value error, ')}") from None
    return corpo
