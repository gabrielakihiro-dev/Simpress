import json
from typing import Any, Dict, List

from fakes import fake_chamador

from motor import memoria, usage_log
from motor.config import OpenRouterError
from motor.llm_adapter import ResultadoChamada
from motor.pipeline import executar_missao

PLANO = json.dumps({"passos": ["escrever teste"], "arquivo_alvo": "test_soma.py"})
CODIGO_OK = json.dumps({
    "arquivo": "test_soma.py",
    "conteudo": "def soma(a, b):\n    return a + b\n\n\ndef test_soma():\n    assert soma(2, 3) == 5\n",
})
CODIGO_FALHA = json.dumps({
    "arquivo": "test_soma.py",
    "conteudo": "def test_falha():\n    assert False\n",
})


def _chamador_rastreado(respostas: List[str]):
    """Como `fake_chamador`, mas grava uma cópia das `mensagens` de cada chamada — só assim
    um teste consegue provar que o histórico (L1) de uma chamada contém a anterior (ou não)."""
    fila = list(respostas)
    chamadas: List[List[Dict[str, Any]]] = []

    def _chamador(modelo, mensagens, max_tokens, temperatura, missao_id=""):
        chamadas.append([dict(m) for m in mensagens])
        if not fila:
            raise AssertionError("mais chamadas do que respostas programadas")
        conteudo = fila.pop(0)
        return ResultadoChamada(
            modelo=modelo, conteudo=conteudo, prompt_tokens=100, cached_tokens=0,
            completion_tokens=50, custo_usd=0.0001, custo_origem="estimated", latencia_s=0.001,
        )

    return _chamador, chamadas


def test_l1_tem_tipo_claro_e_nao_sobrevive_entre_missoes(config_teste, log_path):
    assert memoria.HistoricoL1 is not None  # tipo documental existe em motor/memoria.py

    # Missão 1: 1ª tentativa de código falha no harness, 2ª passa — prova que o L1 dessa
    # missão acumula o erro (a chamada de correção carrega a mensagem da tentativa anterior).
    chamador1, chamadas1 = _chamador_rastreado([PLANO, CODIGO_FALHA, CODIGO_OK])
    r1 = executar_missao("Crie soma(a, b).", config_teste, chamador1, log_path)
    assert r1.ok is True and r1.iteracoes == 2
    assert len(chamadas1) == 3  # plano, código (falha), código (correção)
    assert len(chamadas1[2]) == 4  # system+user originais + assistant (falha) + user (erro)
    assert any("harness falhou" in m.get("content", "") for m in chamadas1[2])

    # Missão 2: começa do zero. Se o L1 da missão 1 tivesse sobrevivido, a 1ª chamada de
    # código já viria com 4+ mensagens e/ou com texto da missão 1 — prova o descarte.
    chamador2, chamadas2 = _chamador_rastreado([PLANO, CODIGO_OK])
    r2 = executar_missao("Crie soma(a, b) de novo.", config_teste, chamador2, log_path)
    assert r2.ok is True and r2.iteracoes == 1
    assert len(chamadas2) == 2  # plano, código — sem chamada extra de correção
    assert len(chamadas2[1]) == 2  # só system+user: nenhum resíduo da missão 1
    assert not any("harness falhou" in m.get("content", "") for m in chamadas2[1])
    assert r1.missao_id != r2.missao_id


def test_l2_resumo_e_gerado_e_persistido_em_jsonl(config_teste, log_path, tmp_path):
    memoria_path = tmp_path / "memoria_sessao.jsonl"
    resumo_fake = "Pediu soma(a, b) com teste. Código gerado e aprovado pelo harness. Sucesso."
    chamador = fake_chamador([PLANO, CODIGO_OK, resumo_fake])

    resultado = executar_missao(
        "Crie soma(a, b).", config_teste, chamador, log_path,
        registrar_memoria_sessao=True, memoria_log_path=memoria_path,
    )

    assert resultado.ok is True
    linhas = memoria_path.read_text(encoding="utf-8").strip().splitlines()
    assert len(linhas) == 1
    registro = json.loads(linhas[0])
    assert registro["missao_id"] == resultado.missao_id
    assert registro["ok"] is True
    assert registro["resumo"] == resumo_fake


def test_l2_sem_flag_nao_grava_nada(config_teste, log_path, tmp_path):
    memoria_path = tmp_path / "memoria_sessao.jsonl"
    chamador = fake_chamador([PLANO, CODIGO_OK])  # sem resposta extra: provaria chamada indevida

    resultado = executar_missao("Crie soma(a, b).", config_teste, chamador, log_path)

    assert resultado.ok is True
    assert not memoria_path.exists()


def test_l2_erro_de_provedor_no_resumo_nao_derruba_a_missao_ja_concluida(config_teste, log_path, tmp_path):
    memoria_path = tmp_path / "memoria_sessao.jsonl"
    chamador_missao = fake_chamador([PLANO, CODIGO_OK])

    def chamador(modelo, mensagens, max_tokens, temperatura, missao_id=""):
        if mensagens[0]["content"].startswith("Resuma"):
            raise OpenRouterError("402: sem créditos no provedor")
        return chamador_missao(modelo, mensagens, max_tokens, temperatura, missao_id)

    resultado = executar_missao(
        "Crie soma(a, b).", config_teste, chamador, log_path,
        registrar_memoria_sessao=True, memoria_log_path=memoria_path,
    )

    assert resultado.ok is True  # a missão já tinha terminado antes do L2 falhar
    assert not memoria_path.exists()


def test_l2_nao_gasta_quando_teto_de_custo_do_dia_ja_passou(config_teste, log_path, tmp_path):
    memoria_path = tmp_path / "memoria_sessao.jsonl"
    # Simula outra missão que já gastou mais que o teto diário (0.50 no config_teste).
    usage_log.registrar(log_path, "outra-missao", "codigo_1", ResultadoChamada(
        modelo="x", conteudo="", prompt_tokens=0, cached_tokens=0, completion_tokens=0,
        custo_usd=1.0, custo_origem="estimated", latencia_s=0.0,
    ))
    chamador = fake_chamador([PLANO])  # nem o código deveria ser chamado

    resultado = executar_missao(
        "Crie soma(a, b).", config_teste, chamador, log_path,
        registrar_memoria_sessao=True, memoria_log_path=memoria_path,
    )

    assert resultado.ok is False  # o circuit breaker já corta a própria missão nesse caso
    assert "Custo do dia" in resultado.motivo
    assert not memoria_path.exists()


def test_l3_sem_aprovacao_nao_grava(tmp_path):
    caminho = tmp_path / "memoria_persistente.jsonl"

    registro = memoria.gravar_memoria_persistente(
        caminho, "m1", "aprender X", "missao m1", aprovado_por_humano=False,
    )

    assert registro is None
    assert not caminho.exists()


def test_l3_com_aprovacao_grava(tmp_path):
    caminho = tmp_path / "memoria_persistente.jsonl"

    registro = memoria.gravar_memoria_persistente(
        caminho, "m1", "aprender X", "missao m1", aprovado_por_humano=True,
    )

    assert registro is not None
    registros = list(memoria.ler_memoria_persistente(caminho))
    assert len(registros) == 1
    assert registros[0]["conteudo"] == "aprender X"
    assert registros[0]["missao_id"] == "m1"
    assert registros[0]["id"] == registro.id


def test_l3_revogacao_remove_so_o_registro_certo_por_id(tmp_path):
    caminho = tmp_path / "memoria_persistente.jsonl"
    r1 = memoria.gravar_memoria_persistente(caminho, "m1", "a", "missao m1", aprovado_por_humano=True)
    r2 = memoria.gravar_memoria_persistente(caminho, "m2", "b", "missao m2", aprovado_por_humano=True)

    removeu = memoria.revogar_memoria_persistente(caminho, r1.id)

    assert removeu is True
    restantes = list(memoria.ler_memoria_persistente(caminho))
    assert len(restantes) == 1
    assert restantes[0]["id"] == r2.id


def test_l3_revogacao_de_id_inexistente_nao_remove_nada(tmp_path):
    caminho = tmp_path / "memoria_persistente.jsonl"
    memoria.gravar_memoria_persistente(caminho, "m1", "a", "missao m1", aprovado_por_humano=True)

    removeu = memoria.revogar_memoria_persistente(caminho, "id-que-nao-existe")

    assert removeu is False
    assert len(list(memoria.ler_memoria_persistente(caminho))) == 1
