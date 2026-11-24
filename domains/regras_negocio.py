"""Fonte única das regras de negócio de hostname, série e MacBook.

O AGENTS.md (raiz) descreve as regras; este módulo é onde elas moram em código. Os demais módulos
(`inventory_comparison`, `effective_alias`, `coverage`, `sebrae_cruzamento` etc.) chamam estas funções
em vez de repetir o teste. Só depende de `core.config` (que não importa `domains`), para não criar ciclo.
"""

import math
import re
import unicodedata
from typing import Any, Callable, FrozenSet, Iterable, Optional, Tuple

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


# Conjunto normalizado memorizado por valor bruto (tupla de `client_own_serials()`), nunca de forma permanente.
_series_sebrae_cache: Tuple[Tuple[str, ...], FrozenSet[str]] = ((), frozenset())


# Séries de notebooks da própria Sebrae, fora das comparações (AGENTS.md, "Invariantes críticos"). São dados reais do
# cliente: vêm de `config/cliente.json` (ou da variável de ambiente) a cada chamada; sem configuração, nenhuma fica fora.
def series_sebrae() -> FrozenSet[str]:
    """Séries normalizadas dos notebooks da própria Sebrae, lidas da configuração local."""
    global _series_sebrae_cache
    brutas = tuple(client_own_serials())  # já muda sozinha com o arquivo (mtime/tamanho) e com a variável de ambiente
    guardado = _series_sebrae_cache  # cópia local: outra thread pode trocar o global entre a checagem e o retorno
    if guardado[0] != brutas:
        guardado = (brutas, frozenset(filter(None, (normalize_reference_value(serie) for serie in brutas))))
        _series_sebrae_cache = guardado
    return guardado[1]


def predicado_serie_sebrae() -> Callable[[Any], bool]:
    """Resolve o conjunto uma vez e devolve `serie -> bool` (mesma regra de `e_serie_sebrae`), para laços longos."""
    proprias = series_sebrae()
    return lambda serie: normalize_reference_value(serie) in proprias


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


def _texto_normalizado(value: Any) -> str:
    """Maiúscula, sem acento, espaços colapsados (mantém pontuação)."""
    if is_missing_cell_value(value):
        return ""
    decomposed = unicodedata.normalize("NFKD", str(value).upper())
    sem_acento = "".join(char for char in decomposed if not unicodedata.combining(char))
    return " ".join(sem_acento.split())


def cidade_do_apelido_backup(apelido: Any, cidades: Iterable[str]) -> Optional[str]:
    """Cidade de um apelido `Backup <Cidade> [número]` (já sem o marcador "(M)"), senão None."""
    texto = _texto_normalizado(apelido)
    if not texto.startswith("BACKUP "):
        return None
    resto = re.sub(r"[\s\d]+$", "", texto[len("BACKUP "):])
    por_nome = {_texto_normalizado(cidade): cidade for cidade in cidades}
    for nome in sorted(por_nome, key=len, reverse=True):
        if resto == nome:
            return por_nome[nome]
    return None


def usuario_e_administrador(texto: Any) -> bool:
    """Verdadeiro se alguma parte do texto de usuários do Endpoint for exatamente Administrador."""
    for parte in re.split(r",|;| / ", _texto_normalizado(texto)):
        parte = parte.split("HORARIO DA ULTIMA")[0].split("(")[0].strip(" .:-")
        if parte.rsplit("\\", 1)[-1].strip() in {"ADMINISTRADOR", "ADMINISTRATOR"}:
            return True
    return False
