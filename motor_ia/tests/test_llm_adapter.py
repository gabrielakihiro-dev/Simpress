from dataclasses import replace

import pytest

from motor.config import OpenRouterClient, OpenRouterError, OpenRouterSettings
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
        settings, config_teste, config_teste.modelos.planejador, [{"role": "user", "content": "oi"}], 256, 0.2,
        "missao-abc",
    )

    assert resultado.custo_origem == "reported"
    assert resultado.custo_usd == 0.001234
    assert resultado.cached_tokens == 40
    payload = payloads_enviados[0]
    assert payload["max_tokens"] == 256
    assert payload["temperature"] == 0.2
    assert payload["usage"] == {"include": True}
    assert payload["session_id"] == "missao-abc"
    assert "order" not in payload["provider"]


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
        settings, config_teste, config_teste.modelos.planejador, [{"role": "user", "content": "oi"}], 256, 0.2,
        "missao-abc",
    )

    payload = payloads_enviados[0]
    assert payload["model"] == config_teste.modelos.deepseek_direto
    assert "usage" not in payload
    assert "provider" not in payload
    assert "session_id" not in payload  # API direta da DeepSeek não tem esse campo
    assert resultado.custo_origem == "estimated"
    assert resultado.custo_usd > 0
    assert resultado.cached_tokens == 10


def test_chamar_modelo_deepseek_juiz_sem_voice_key_levanta_erro(config_teste, monkeypatch):
    settings = OpenRouterSettings(api_key="chave-deepseek", deepseek=True)

    with pytest.raises(OpenRouterError, match="juiz"):
        chamar_modelo(
            settings, config_teste, config_teste.modelos.juiz, [{"role": "user", "content": "oi"}], 256, 0.2,
            "missao-abc",
        )


def test_chamar_modelo_deepseek_juiz_com_voice_key_usa_session_id(config_teste, monkeypatch):
    """Juiz via fallback OpenRouter (voice_key) no modo DeepSeek: sticky routing continua valendo."""
    settings = OpenRouterSettings(api_key="chave-deepseek", deepseek=True, voice_key="chave-voice")
    payloads_enviados = []

    def _send_fake(self, payload, orcamento=None):
        payloads_enviados.append(payload)
        return {
            "model": config_teste.modelos.juiz,
            "choices": [{"message": {"content": "aprovado"}}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 10, "cost": 0.0001},
        }

    monkeypatch.setattr(OpenRouterClient, "_send", _send_fake)

    chamar_modelo(
        settings, config_teste, config_teste.modelos.juiz, [{"role": "user", "content": "oi"}], 256, 0.2,
        "missao-abc",
    )

    assert payloads_enviados[0]["session_id"] == "missao-abc"


def test_chamar_modelo_sem_missao_id_nao_manda_session_id(config_teste, monkeypatch):
    settings = OpenRouterSettings(api_key="chave-openrouter")
    payloads_enviados = []

    def _send_fake(self, payload, orcamento=None):
        payloads_enviados.append(payload)
        return {
            "model": config_teste.modelos.planejador,
            "choices": [{"message": {"content": "ok"}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "cost": 0.0001},
        }

    monkeypatch.setattr(OpenRouterClient, "_send", _send_fake)

    chamar_modelo(
        settings, config_teste, config_teste.modelos.planejador, [{"role": "user", "content": "oi"}], 256, 0.2, ""
    )

    assert "session_id" not in payloads_enviados[0]
