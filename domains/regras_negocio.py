"""Fonte única das regras de negócio de hostname, série e MacBook.

O AGENTS.md (raiz) descreve as regras; este módulo é onde elas moram em código. Os demais módulos
(`inventory_comparison`, `effective_alias`, `coverage`, `sebrae_cruzamento` etc.) chamam estas funções
em vez de repetir o teste. Só depende de `core.config` (que não importa `domains`), para não criar ciclo.
"""

import math
import re
import unicodedata
from typing import Any, FrozenSet

from core.config import client_own_serials


def is_missing_cell_value(value: Any) -> bool:
    """Return whether an Excel scalar represents an empty or not-a-number cell."""
    if value is None:
        return True
    return isinstance(value, float) and math.isnan(value)


def normalize_reference_value(value: Any) -> str:
    """Normaliza valores de série, apelido e cidade para comparações consistentes."""
    if is_missing_cell_value(value):
        return ""
    decomposed = unicodedata.normalize("NFKD", str(value).strip().upper())
    without_accents = "".join(char for char in decomposed if not unicodedata.combining(char))
    return re.sub(r"[^A-Z0-9]", "", without_accents)


# Séries de notebooks da própria Sebrae, fora das comparações (AGENTS.md, "Invariantes críticos"). São dados reais do
# cliente: vêm de `config/cliente.json` (ou da variável de ambiente) a cada chamada; sem configuração, nenhuma fica fora.
def series_sebrae() -> FrozenSet[str]:
    """Séries normalizadas dos notebooks da própria Sebrae, lidas da configuração local."""
    return frozenset(filter(None, (normalize_reference_value(serie) for serie in client_own_serials())))


# Sufixo após `PRNOTE` dos hostnames instalados em Curitiba, sem divergência de localidade.
PREFIXOS_HOSTNAME_CURITIBA = ("SJP", "RL", "ARC")


def e_serie_sebrae(serie: Any) -> bool:
    """A série (qualquer caixa, hífen ou espaço) é de um notebook da própria Sebrae."""
    return normalize_reference_value(serie) in series_sebrae()


def hostname_de_curitiba(hostname: Any) -> bool:
    """`PRNOTESJP`/`PRNOTERL`/`PRNOTEARC` com hífen, espaço ou marcador `(M)` no fim."""
    normalizado = normalize_reference_value(hostname)
    return normalizado.startswith("PRNOTE") and normalizado[len("PRNOTE"):].startswith(PREFIXOS_HOSTNAME_CURITIBA)


def hostname_e_macbook(hostname: Any) -> bool:
    """Lado do Endpoint: hostname de MacBook começa com `PRMAC`."""
    return normalize_reference_value(hostname).startswith("PRMAC")


def cadastro_e_macbook(*textos: Any) -> bool:
    """Lado do cadastro: `MACBOOK` nos campos passados (categoria, tipo e/ou modelo), sem acento e em maiúsculas."""
    juntos = unicodedata.normalize("NFKD", " ".join(str(texto or "") for texto in textos))
    return "MACBOOK" in "".join(c for c in juntos if not unicodedata.combining(c)).upper()
