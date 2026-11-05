"""Config único da Fase 1: carrega settings.toml e reaproveita OpenRouterSettings/OpenRouterClient
já existentes em Simpress/domains/assistant_openrouter.py (não recriar cliente HTTP do zero).
"""

import importlib.util
import os
import tomllib
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Dict

MOTOR_IA_DIR = Path(__file__).resolve().parents[1]
SIMPRESS_DIR = MOTOR_IA_DIR.parent  # motor_ia/ mora dentro do repo Simpress
CONFIG_PATH = MOTOR_IA_DIR / "config" / "settings.toml"
_ASSISTANT_OPENROUTER_PATH = SIMPRESS_DIR / "domains" / "assistant_openrouter.py"


def _carregar_modulo_assistant_openrouter() -> ModuleType:
    # shortcut: import direto do arquivo em vez de `from Simpress.domains import ...`, porque
    # Simpress/ não é um pacote instalável (sem __init__.py próprio). O módulo só usa stdlib.
    spec = importlib.util.spec_from_file_location("assistant_openrouter", _ASSISTANT_OPENROUTER_PATH)
    modulo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modulo)  # type: ignore[union-attr]
    return modulo


_assistant_openrouter = _carregar_modulo_assistant_openrouter()
OpenRouterSettings = _assistant_openrouter.OpenRouterSettings
OpenRouterClient = _assistant_openrouter.OpenRouterClient
OpenRouterError = _assistant_openrouter.OpenRouterError


@dataclass(frozen=True)
class ModelosConfig:
    planejador: str
    codificador: str
    juiz: str
    deepseek_direto: str


@dataclass(frozen=True)
class ChamadaConfig:
    max_tokens_plano: int
    max_tokens_codigo: int
    max_tokens_juiz: int
    temperatura: float


@dataclass(frozen=True)
class LimitesConfig:
    max_loop_iterations: int
    teto_custo_missao_usd: float
    teto_custo_dia_usd: float
    repeticoes_erro_para_parar: int


@dataclass(frozen=True)
class MotorConfig:
    modelos: ModelosConfig
    chamada: ChamadaConfig
    limites: LimitesConfig
    precos_usd_por_milhao: Dict[str, Dict[str, float]]
    sandbox_dir: Path


def carregar_config(caminho: Path = CONFIG_PATH) -> MotorConfig:
    dados = tomllib.loads(caminho.read_text(encoding="utf-8"))
    sandbox_dir = _resolver_sandbox_dir(dados["workspace"]["sandbox_dir"])
    return MotorConfig(
        modelos=ModelosConfig(**dados["modelos"]),
        chamada=ChamadaConfig(**dados["chamada"]),
        limites=LimitesConfig(**dados["limites"]),
        precos_usd_por_milhao=dados["precos_usd_por_milhao"],
        sandbox_dir=sandbox_dir,
    )


def _resolver_sandbox_dir(valor: str) -> Path:
    """`sandbox_dir` do settings.toml precisa ficar dentro de `motor_ia/`: "" ou ".." aqui
    fariam `preparar_sandbox` rodar `rmtree` em `motor_ia/` ou em `Empresa/`."""
    from .scope_lock import ForaDoEscopoError, resolver_dentro_do_escopo

    try:
        caminho = resolver_dentro_do_escopo(MOTOR_IA_DIR, valor)
    except ForaDoEscopoError:
        raise ValueError(f"workspace.sandbox_dir inválido (sai de {MOTOR_IA_DIR}): {valor!r}") from None
    if caminho == Path(os.path.realpath(MOTOR_IA_DIR)):
        raise ValueError(f"workspace.sandbox_dir não pode ser a própria pasta motor_ia/: {valor!r}")
    return caminho
