"""Chamada ao modelo com uso/custo/latência medidos (Fase 0).

shortcut: usa o método privado `OpenRouterClient._send` em vez de `.complete()`, porque
`.complete()` descarta o campo "usage" da resposta, fixa temperature=0.3 e sempre manda
`tools`/`tool_choice`. Trocar por um método público quando/se `assistant_openrouter.py`
expuser um equivalente que devolva o corpo bruto.
"""

import time
from dataclasses import dataclass, replace
from typing import Any, Dict, List

from .config import MotorConfig, OpenRouterClient, OpenRouterError, OpenRouterSettings


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
    missao_id: str,
) -> ResultadoChamada:
    """Chamada mínima e explícita: `max_tokens`/`temperature` sempre presentes, sem tools
    (a Fase 1 não usa ferramentas), sem fallback automático de modelo.

    `missao_id` vira `session_id` do OpenRouter (Fase 2: sticky routing) quando a chamada passa
    pelo OpenRouter; na API direta da DeepSeek esse campo não existe e é ignorado.
    """
    if settings.deepseek:
        if modelo == config.modelos.juiz:
            # Juiz não é modelo DeepSeek: API direta da DeepSeek nunca teria esse slug.
            if not settings.voice_key:
                raise OpenRouterError(
                    "O DeepSeek não tem o modelo do juiz. Preencha OPENROUTER_API_KEY para habilitar o juiz."
                )
            settings = replace(settings, api_key=settings.voice_key, base_url=settings.voice_base_url, deepseek=False)
        else:
            # Planejador/codificador: troca o slug do OpenRouter pelo ID da API direta da DeepSeek.
            modelo = config.modelos.deepseek_direto

    payload: Dict[str, Any] = {
        "model": modelo,
        "messages": mensagens,
        "max_tokens": max_tokens,
        "temperature": temperatura,
    }
    if not settings.deepseek:
        payload["usage"] = {"include": True}
        payload["provider"] = {"require_parameters": True, "data_collection": "deny"}
        # Sticky routing por missão (nunca fixar provider.order: isso desligaria o sticky routing).
        if missao_id:
            payload["session_id"] = missao_id

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
