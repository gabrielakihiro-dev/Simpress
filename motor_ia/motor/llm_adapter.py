"""Chamada ao modelo com uso/custo/latência medidos (Fase 0).

shortcut: usa o método privado `OpenRouterClient._send` em vez de `.complete()`, porque
`.complete()` descarta o campo "usage" da resposta, fixa temperature=0.3 e sempre manda
`tools`/`tool_choice`. Trocar por um método público quando/se `assistant_openrouter.py`
expuser um equivalente que devolva o corpo bruto.
"""

import time
from dataclasses import dataclass
from typing import Any, Dict, List

from .config import MotorConfig, OpenRouterClient, OpenRouterSettings


@dataclass(frozen=True)
class ResultadoChamada:
    modelo: str
    conteudo: str
    prompt_tokens: int
    cached_tokens: int
    completion_tokens: int
    custo_usd: float
    custo_origem: str  # "reported" (veio no "usage") | "estimated" (tabela de preços do config)
    latencia_s: float


def _estimar_custo(config: MotorConfig, modelo: str, prompt_tokens: int, completion_tokens: int) -> float:
    precos = config.precos_usd_por_milhao.get(modelo)
    if not precos:
        return 0.0
    return (prompt_tokens * precos["entrada"] + completion_tokens * precos["saida"]) / 1_000_000


def chamar_modelo(
    settings: OpenRouterSettings,
    config: MotorConfig,
    modelo: str,
    mensagens: List[Dict[str, Any]],
    max_tokens: int,
    temperatura: float,
) -> ResultadoChamada:
    """Chamada mínima e explícita: `max_tokens`/`temperature` sempre presentes, sem tools
    (a Fase 1 não usa ferramentas), sem fallback automático de modelo."""
    payload: Dict[str, Any] = {
        "model": modelo,
        "messages": mensagens,
        "max_tokens": max_tokens,
        "temperature": temperatura,
    }
    if not settings.deepseek:
        payload["usage"] = {"include": True}
        payload["provider"] = {"require_parameters": True, "data_collection": "deny"}

    cliente = OpenRouterClient(settings)
    inicio = time.monotonic()
    corpo = cliente._send(payload)  # shortcut: ver docstring do módulo
    latencia = time.monotonic() - inicio

    mensagem = corpo["choices"][0]["message"]
    uso = corpo.get("usage") or {}
    prompt_tokens = int(uso.get("prompt_tokens") or 0)
    completion_tokens = int(uso.get("completion_tokens") or 0)
    cached_tokens = int(
        (uso.get("prompt_tokens_details") or {}).get("cached_tokens")
        or uso.get("prompt_cache_hit_tokens")
        or 0
    )
    custo = uso.get("cost")
    if custo is None:
        custo_origem = "estimated"
        custo = _estimar_custo(config, modelo, prompt_tokens, completion_tokens)
    else:
        custo_origem = "reported"

    return ResultadoChamada(
        modelo=str(corpo.get("model") or modelo),
        conteudo=str(mensagem.get("content") or ""),
        prompt_tokens=prompt_tokens,
        cached_tokens=cached_tokens,
        completion_tokens=completion_tokens,
        custo_usd=float(custo),
        custo_origem=custo_origem,
        latencia_s=latencia,
    )
