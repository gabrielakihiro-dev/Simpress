import pytest

from motor.config import carregar_config


def test_sandbox_dir_fora_do_motor_ia_e_recusado(tmp_path):
    caminho = tmp_path / "settings.toml"
    caminho.write_text(
        '[modelos]\nplanejador="x"\ncodificador="x"\njuiz="x"\ndeepseek_direto="x"\n'
        '[chamada]\nmax_tokens_plano=1\nmax_tokens_codigo=1\nmax_tokens_juiz=1\ntemperatura=0.1\n'
        '[limites]\nmax_loop_iterations=1\nteto_custo_missao_usd=0.05\nteto_custo_dia_usd=0.5\nrepeticoes_erro_para_parar=2\n'
        '[workspace]\nsandbox_dir=".."\n'
        '[precos_usd_por_milhao]\n',
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="sandbox_dir"):
        carregar_config(caminho)


def test_settings_toml_real_carrega(tmp_path):
    config = carregar_config()
    assert config.modelos.planejador == "deepseek/deepseek-v4.1-flash"
    assert config.sandbox_dir.name == "sandbox"
