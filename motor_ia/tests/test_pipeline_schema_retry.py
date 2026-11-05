import json

from motor.pipeline import executar_missao
from fakes import fake_chamador

PLANO = json.dumps({"passos": ["escrever teste"], "arquivo_alvo": "test_soma.py"})
CODIGO_OK = json.dumps({
    "arquivo": "test_soma.py",
    "conteudo": "def soma(a, b):\n    return a + b\n\n\ndef test_soma():\n    assert soma(2, 3) == 5\n",
})


def test_json_invalido_na_primeira_tentativa_se_recupera_no_retry(config_teste, log_path):
    # dossiê #10: json.loads sem validação de schema e sem retry derrubava a missão.
    chamador = fake_chamador(["isto não é JSON", PLANO, CODIGO_OK])

    resultado = executar_missao("Crie soma(a, b) com um teste.", config_teste, chamador, log_path)

    assert resultado.ok is True


def test_json_invalido_duas_vezes_falha_limpo(config_teste, log_path):
    chamador = fake_chamador(["x", "y"])

    resultado = executar_missao("Tarefa qualquer.", config_teste, chamador, log_path)

    assert resultado.ok is False
    assert "após retry" in resultado.motivo
