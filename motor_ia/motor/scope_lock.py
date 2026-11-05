"""Trava de escopo (Fase 1: dossiê #7 — `startswith` aceitava `./workspace2` como se fosse
`./workspace`, e `abspath` não resolvia symlink/junction do Windows). Aqui: `realpath` +
`commonpath`, com `normcase` para comparar sem diferenciar maiúsculas no Windows.
"""

import os
from pathlib import Path


class ForaDoEscopoError(Exception):
    pass


def resolver_dentro_do_escopo(base_dir: Path, caminho_relativo: str) -> Path:
    """Resolve `caminho_relativo` dentro de `base_dir` (sandbox) ou levanta `ForaDoEscopoError`."""
    base_real = os.path.realpath(base_dir)
    alvo_real = os.path.realpath(os.path.join(base_real, caminho_relativo))
    base_norm, alvo_norm = os.path.normcase(base_real), os.path.normcase(alvo_real)
    try:
        comum = os.path.commonpath([base_norm, alvo_norm])
    except ValueError:
        # Windows: `base_real` e `alvo_real` em drives diferentes.
        raise ForaDoEscopoError(f"Caminho fora do workspace (drive diferente): {caminho_relativo}") from None
    if comum != base_norm:
        raise ForaDoEscopoError(f"Caminho fora do workspace: {caminho_relativo}")
    return Path(alvo_real)
