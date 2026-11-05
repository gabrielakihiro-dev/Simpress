import json

from motor.pipeline import executar_missao
from fakes import fake_chamador

PLANO = json.dumps({"passos": ["escrever fora do sandbox"], "arquivo_alvo": "../fora.py"})
CODIGO_FORA = json.dumps({"arquivo": "../fora.py", "conteudo": "x = 1\n"})


def test_escrita_fora_do_workspace_e_bloqueada(config_teste, log_path):
    # O modelo "malicioso"/confuso sempre tenta escrever fora do sandbox; a trava de escopo
    # bloqueia toda vez e o circuit breaker para a missão (mesmo erro repetido).
    chamador = fake_chamador([PLANO, CODIGO_FORA, CODIGO_FORA, CODIGO_FORA])

    resultado = executar_missao("Tarefa com caminho malicioso.", config_teste, chamador, log_path)

    assert resultado.ok is False
    assert resultado.arquivo_escrito is None
    assert "repetido" in resultado.motivo

    sandbox = config_teste.sandbox_dir
    assert not (sandbox / "fora.py").exists()
    assert not (sandbox.parent / "fora.py").exists()
    assert list(sandbox.iterdir()) == []  # nada foi escrito dentro do sandbox nem fora dele
