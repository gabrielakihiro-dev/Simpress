import json

from motor.pipeline import executar_missao
from fakes import fake_chamador

PLANO = json.dumps({"passos": ["escrever teste"], "arquivo_alvo": "test_soma.py"})
CODIGO_OK = json.dumps({
    "arquivo": "test_soma.py",
    "conteudo": "def soma(a, b):\n    return a + b\n\n\ndef test_soma():\n    assert soma(2, 3) == 5\n",
})


def test_missao_simples_passa_de_primeira(config_teste, log_path):
    chamador = fake_chamador([PLANO, CODIGO_OK])

    resultado = executar_missao("Crie soma(a, b) com um teste.", config_teste, chamador, log_path)

    assert resultado.ok is True
    assert resultado.iteracoes == 1
    assert resultado.arquivo_escrito is not None
    assert resultado.arquivo_escrito.read_text(encoding="utf-8") == json.loads(CODIGO_OK)["conteudo"]

    # Fase 0: cada chamada (plano + código) foi registrada e entra no relatório.
    from motor import usage_log
    relatorio = usage_log.relatorio(log_path)
    assert relatorio["por_etapa"]["plano"]["chamadas"] == 1
    assert relatorio["por_etapa"]["codigo_1"]["chamadas"] == 1
