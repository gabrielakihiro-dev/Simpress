import json

from motor.pipeline import executar_missao
from fakes import fake_chamador

PLANO = json.dumps({"passos": ["trocar senha"], "arquivo_alvo": "test_senha.py"})
CODIGO_OK = json.dumps({
    "arquivo": "test_senha.py",
    "conteudo": "def test_sempre_passa():\n    assert True\n",
})


def test_missao_critica_reprovada_pelo_juiz_nao_passa(config_teste, log_path):
    # dossiê #2 (reconstruído no juiz): o veredito do portão não pode ser ignorado.
    chamador = fake_chamador([PLANO, CODIGO_OK, "reprovado: não cobre o caso de senha vazia"])

    resultado = executar_missao("Troque a senha do usuário.", config_teste, chamador, log_path)

    assert resultado.ok is False
    assert "Juiz reprovou" in resultado.motivo
    assert "não cobre o caso" in resultado.motivo


def test_missao_critica_aprovada_pelo_juiz_passa(config_teste, log_path):
    chamador = fake_chamador([PLANO, CODIGO_OK, "aprovado"])

    resultado = executar_missao("Troque a senha do usuário.", config_teste, chamador, log_path)

    assert resultado.ok is True

    from motor import usage_log
    assert usage_log.relatorio(log_path)["por_etapa"]["juiz"]["chamadas"] == 1
