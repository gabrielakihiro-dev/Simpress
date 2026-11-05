import json

from motor.pipeline import executar_missao
from fakes import fake_chamador

PLANO = json.dumps({"passos": ["escrever teste"], "arquivo_alvo": "test_quebrado.py"})


def _codigo_com_erro(numero: int) -> str:
    # Mensagem de assert diferente em cada tentativa -> assinatura do erro diferente a cada
    # rodada, para isolar o teste do circuit breaker de erro repetido (test_circuit_breaker.py).
    return json.dumps({
        "arquivo": "test_quebrado.py",
        "conteudo": f"def test_quebrado():\n    assert False, 'erro_{numero}'\n",
    })


def test_tarefa_quebrada_para_no_limite_de_iteracoes_sem_loop_infinito(config_teste, log_path):
    assert config_teste.limites.max_loop_iterations == 3
    respostas = [PLANO] + [_codigo_com_erro(i) for i in range(1, config_teste.limites.max_loop_iterations + 1)]
    chamador = fake_chamador(respostas)

    resultado = executar_missao("Tarefa que nunca vai passar no harness.", config_teste, chamador, log_path)

    assert resultado.ok is False
    assert resultado.iteracoes == config_teste.limites.max_loop_iterations
    assert "iterações" in resultado.motivo
    assert "repetido" not in resultado.motivo  # não foi o circuit breaker de erro repetido quem parou
