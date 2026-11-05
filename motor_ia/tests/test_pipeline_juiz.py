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


def test_juiz_manda_cache_control_no_bloco_estatico_e_mesmo_missao_id(config_teste, log_path):
    """Fase 2: o system do juiz vira bloco de conteúdo com cache_control; missao_id chega ao chamador."""
    respostas = [PLANO, CODIGO_OK, "aprovado"]
    chamadas = []

    def chamador(modelo, mensagens, max_tokens, temperatura, missao_id):
        chamadas.append((modelo, mensagens, missao_id))
        from motor.llm_adapter import ResultadoChamada
        return ResultadoChamada(
            modelo=modelo, conteudo=respostas.pop(0), prompt_tokens=100, cached_tokens=0,
            completion_tokens=10, custo_usd=0.0001, custo_origem="estimated", latencia_s=0.001,
        )

    resultado = executar_missao("Troque a senha do usuário.", config_teste, chamador, log_path)

    assert resultado.ok is True
    modelo_juiz, mensagens_juiz, missao_id_juiz = chamadas[-1]
    assert modelo_juiz == config_teste.modelos.juiz
    bloco_system = mensagens_juiz[0]["content"]
    assert isinstance(bloco_system, list)
    assert bloco_system[0]["cache_control"] == {"type": "ephemeral"}
    assert missao_id_juiz == resultado.missao_id
    # todas as chamadas da missão (plano, código, juiz) usam o mesmo missao_id (sticky routing).
    assert {missao_id for _, _, missao_id in chamadas} == {resultado.missao_id}


def test_prefixo_estatico_do_plano_e_do_codigo_e_identico_entre_tarefas(config_teste, log_path):
    """Fase 2: o bloco "system" (estático) não pode mudar com a tarefa, senão o provedor não cacheia."""
    def capturar(tarefa, log_path_):
        respostas = [PLANO, CODIGO_OK]
        systems = []

        def chamador(modelo, mensagens, max_tokens, temperatura, missao_id_):
            systems.append(mensagens[0]["content"])
            from motor.llm_adapter import ResultadoChamada
            return ResultadoChamada(
                modelo=modelo, conteudo=respostas.pop(0), prompt_tokens=100, cached_tokens=0,
                completion_tokens=10, custo_usd=0.0001, custo_origem="estimated", latencia_s=0.001,
            )

        executar_missao(tarefa, config_teste, chamador, log_path_)
        return systems

    systems_1 = capturar("Crie soma(a, b) com um teste.", log_path)
    systems_2 = capturar("Crie subtrai(a, b) com um teste.", log_path)

    # mesma posição na sequência (plano, depois código) tem que ter o mesmo "system" nas duas tarefas.
    assert systems_1 == systems_2
