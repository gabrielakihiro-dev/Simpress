import pytest

from motor.config import ChamadaConfig, LimitesConfig, ModelosConfig, MotorConfig


@pytest.fixture
def config_teste(tmp_path):
    return MotorConfig(
        modelos=ModelosConfig(
            planejador="deepseek/deepseek-v4.1-flash",
            codificador="deepseek/deepseek-v4.1-flash",
            juiz="anthropic/claude-sonnet-5.5",
            deepseek_direto="deepseek-flash",
        ),
        chamada=ChamadaConfig(max_tokens_plano=256, max_tokens_codigo=512, max_tokens_juiz=256, temperatura=0.2),
        limites=LimitesConfig(
            max_loop_iterations=3,
            teto_custo_missao_usd=0.05,
            teto_custo_dia_usd=0.50,
            repeticoes_erro_para_parar=2,
        ),
        precos_usd_por_milhao={},
        sandbox_dir=tmp_path / "sandbox",
    )


@pytest.fixture
def log_path(tmp_path):
    return tmp_path / "usage_log.jsonl"
