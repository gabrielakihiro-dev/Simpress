from motor import usage_log
from motor.llm_adapter import ResultadoChamada


def _resultado(modelo, prompt_tokens, cached_tokens, completion_tokens, custo_usd):
    return ResultadoChamada(
        modelo=modelo, conteudo="", prompt_tokens=prompt_tokens, cached_tokens=cached_tokens,
        completion_tokens=completion_tokens, custo_usd=custo_usd, custo_origem="reported", latencia_s=0.5,
    )


def test_relatorio_soma_custo_e_cache_hit_por_modelo_e_etapa(log_path):
    usage_log.registrar(log_path, "missao-1", "plano", _resultado("deepseek/deepseek-v4.1-flash", 1000, 400, 50, 0.001))
    usage_log.registrar(log_path, "missao-1", "codigo_1", _resultado("deepseek/deepseek-v4.1-flash", 2000, 0, 100, 0.002))
    usage_log.registrar(log_path, "missao-1", "juiz", _resultado("anthropic/claude-sonnet-5.5", 500, 0, 20, 0.01))

    relatorio = usage_log.relatorio(log_path)

    por_modelo = relatorio["por_modelo"]
    assert por_modelo["deepseek/deepseek-v4.1-flash"]["chamadas"] == 2
    assert round(por_modelo["deepseek/deepseek-v4.1-flash"]["custo_usd"], 4) == 0.003
    assert por_modelo["deepseek/deepseek-v4.1-flash"]["cache_hit_rate"] == 400 / 3000
    assert por_modelo["anthropic/claude-sonnet-5.5"]["custo_usd"] == 0.01

    por_etapa = relatorio["por_etapa"]
    assert por_etapa["plano"]["cache_hit_rate"] == 0.4
    assert por_etapa["codigo_1"]["cache_hit_rate"] == 0.0
    assert por_etapa["juiz"]["custo_usd"] == 0.01


def test_relatorio_vazio_sem_log(tmp_path):
    relatorio = usage_log.relatorio(tmp_path / "nao_existe.jsonl")
    assert relatorio == {"por_modelo": {}, "por_etapa": {}}
