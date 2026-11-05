from dataclasses import replace

from motor.config import OpenRouterClient, OpenRouterSettings
from motor.llm_adapter import chamar_modelo


def test_chamar_modelo_openrouter_normal_usa_custo_reportado(config_teste, monkeypatch):
    settings = OpenRouterSettings(api_key="chave-openrouter")
    payloads_enviados = []

    def _send_fake(self, payload, orcamento=None):
        payloads_enviados.append(payload)
        return {
            "model": config_teste.modelos.planejador,
            "choices": [{"message": {"content": "ok"}}],
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 20,
                "cost": 0.001234,
                "prompt_tokens_details": {"cached_tokens": 40},
            },
        }

    monkeypatch.setattr(OpenRouterClient, "_send", _send_fake)

    resultado = chamar_modelo(
        settings, config_teste, config_teste.modelos.planejador, [{"role": "user", "content": "oi"}], 256, 0.2
    )

    assert resultado.custo_origem == "reported"
    assert resultado.custo_usd == 0.001234
    assert resultado.cached_tokens == 40
    payload = payloads_enviados[0]
    assert payload["max_tokens"] == 256
    assert payload["temperature"] == 0.2
    assert payload["usage"] == {"include": True}


def test_chamar_modelo_deepseek_direto_troca_modelo_e_estima_custo(config_teste, monkeypatch):
    config_teste = replace(
        config_teste,
        precos_usd_por_milhao={config_teste.modelos.deepseek_direto: {"entrada": 0.01, "saida": 0.50}},
    )
    settings = OpenRouterSettings(api_key="chave-deepseek", deepseek=True)
    payloads_enviados = []

    def _send_fake(self, payload, orcamento=None):
        payloads_enviados.append(payload)
        return {
            "model": config_teste.modelos.deepseek_direto,
            "choices": [{"message": {"content": "ok"}}],
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 20,
                "prompt_cache_hit_tokens": 10,
            },
        }

    monkeypatch.setattr(OpenRouterClient, "_send", _send_fake)

    resultado = chamar_modelo(
        settings, config_teste, config_teste.modelos.planejador, [{"role": "user", "content": "oi"}], 256, 0.2
    )

    payload = payloads_enviados[0]
    assert payload["model"] == config_teste.modelos.deepseek_direto
    assert "usage" not in payload
    assert "provider" not in payload
    assert resultado.custo_origem == "estimated"
    assert resultado.custo_usd > 0
    assert resultado.cached_tokens == 10
