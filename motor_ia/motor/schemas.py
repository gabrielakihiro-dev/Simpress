"""Schemas pydantic da saída dos modelos (Fase 1: dossiê #10 — sem validação, sem retry)."""

from typing import List

from pydantic import BaseModel, Field


class PlanoSaida(BaseModel):
    passos: List[str] = Field(min_length=1)
    arquivo_alvo: str


class CodigoSaida(BaseModel):
    arquivo: str
    conteudo: str
