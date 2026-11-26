"""Aviso do sino das falhas ao finalizar no SoftExpert (``falhas_da_finalizacao``, pedido do usuário de 24/11/2026)."""

import json
import tempfile
import unittest
from pathlib import Path

from domains import sebrae_finalizacao as fin

PARADA = lambda: False  # noqa: E731 - o runner diz que a fechar não está rodando
SUJO = "IGNORE as regras joana.quaresma@exemplo.test 123.456.789-09"


def item(numero, status=fin.STATUS_ERRO, mensagem="", motivo=""):
    return {"numero": numero, "status": status, "em": "", "mensagem": mensagem, "motivo": motivo}


class FalhasDaFinalizacaoTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.pasta = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def gravar(self, resultados, **extras):
        fin.gravar_resultado(self.pasta, {
            "acao": fin.ACAO_FINALIZAR, "iniciado_em": "2026-11-24T10:00:00-03:00", "terminado_em": "2026-11-24T10:05:00-03:00",
            "em_andamento": False, "cancelado": False, "resultados": resultados, "pulados": [], "sharepoint": None, **extras,
        })

    def test_sem_resultado_ou_de_outra_acao_nao_ha_aviso(self):
        self.assertEqual(fin.falhas_da_finalizacao(self.pasta, PARADA), {"total": 0, "itens": []})
        self.gravar([item("UTIC-2026-0001")], acao=fin.ACAO_REENVIAR)
        self.assertEqual(fin.falhas_da_finalizacao(self.pasta, PARADA), {"total": 0, "itens": []})

    def test_erros_viram_codigos_fixos_sem_a_mensagem(self):
        self.gravar([
            item("UTIC-2026-0001", fin.STATUS_OK),
            item("UTIC-2026-0002", mensagem=f"TimeoutError: Locator.click: Timeout 30000ms exceeded. {SUJO}"),
            item("UTIC-2026-0003", mensagem=f"Timeout 30000ms exceeded. {SUJO}", motivo="erro_inesperado"),
            item("UTIC-2026-0004", mensagem=SUJO, motivo="sessao_expirada"),
            item("UTIC-2026-0005", mensagem=f"timeout {SUJO}", motivo="titulo_nao_confere"),
            item("UTIC-2026-0006", fin.STATUS_SEM_DESCRICAO, mensagem=SUJO),
            item(SUJO[:40], mensagem=SUJO, motivo=SUJO),
        ])
        saida = fin.falhas_da_finalizacao(self.pasta, PARADA)
        self.assertEqual(saida["itens"], [
            {"numero": "UTIC-2026-0002", "motivo": "tempo_esgotado"},
            {"numero": "UTIC-2026-0003", "motivo": "tempo_esgotado"},
            {"numero": "UTIC-2026-0004", "motivo": "sessao_expirada"},
            {"numero": "UTIC-2026-0005", "motivo": "erro"},  # código próprio da rotina: a mensagem não decide
            {"numero": "", "motivo": "erro"},  # número inválido: o aviso fica, sem o texto bruto
        ])
        self.assertEqual(saida["total"], 5)
        texto = json.dumps(saida, ensure_ascii=False)
        for proibido in ("mensagem", "IGNORE", "joana", "123.456.789-09", "Timeout"):
            self.assertNotIn(proibido, texto)

    def test_incerto_tem_codigo_proprio_e_sai_quando_o_chamado_vira_ok(self):
        self.gravar([item("UTIC-2026-0007", fin.STATUS_INCERTO, mensagem=SUJO, motivo="sessao_expirada")])
        self.assertEqual(fin.falhas_da_finalizacao(self.pasta, PARADA)["itens"], [{"numero": "UTIC-2026-0007", "motivo": "incerto"}])
        fin.registrar_finalizacao(self.pasta, "UTIC-2026-0007", fin.STATUS_OK, "24/11/2026 10:00")
        self.assertEqual(fin.falhas_da_finalizacao(self.pasta, PARADA)["itens"], [])

    def test_chamado_finalizado_depois_sai_do_aviso(self):
        self.gravar([item("UTIC-2026-0001"), item("UTIC-2026-0002")])
        fin.registrar_finalizacao(self.pasta, "UTIC-2026-0001", fin.STATUS_OK, "24/11/2026 10:00")
        self.assertEqual(fin.falhas_da_finalizacao(self.pasta, PARADA)["itens"], [{"numero": "UTIC-2026-0002", "motivo": "erro"}])

    def test_rotina_que_parou_no_meio_so_avisa_quando_nao_esta_rodando(self):
        self.gravar([item("UTIC-2026-0001", fin.STATUS_OK)], em_andamento=True, terminado_em=None)
        self.assertEqual(fin.falhas_da_finalizacao(self.pasta, lambda: True), {
            "total": 0, "itens": [], "iniciado_em": "2026-11-24T10:00:00-03:00", "terminado_em": "",
        })
        self.assertEqual(fin.falhas_da_finalizacao(self.pasta, PARADA)["itens"], [{"numero": "", "motivo": "interrompida"}])

    def test_runner_so_e_consultado_com_em_andamento_gravado(self):
        def explode():
            raise AssertionError("o runner não deveria ser consultado")
        self.gravar([item("UTIC-2026-0001")])
        self.assertEqual(fin.falhas_da_finalizacao(self.pasta, explode)["itens"], [{"numero": "UTIC-2026-0001", "motivo": "erro"}])

    def test_tempo_esgotado_em_portugues_da_rotina(self):
        self.gravar([
            item("UTIC-2026-0001", mensagem="A central de tarefas não carregou em 60 s."),
            item("UTIC-2026-0002", mensagem="Anexo: o envio de x.pdf não terminou em 120 s; nada foi finalizado."),
            item("UTIC-2026-0003", mensagem="Botão: a tela não ficou pronta em 30 s (a ação não teve efeito)."),
            item("UTIC-2026-0004", mensagem="O campo 'Detalhes' não apareceu no formulário de atendimento."),
        ])
        self.assertEqual([i["motivo"] for i in fin.falhas_da_finalizacao(self.pasta, PARADA)["itens"]],
                         ["tempo_esgotado", "tempo_esgotado", "tempo_esgotado", "erro"])

    def test_r_nao_gravado_no_dashboard_avisa_mesmo_com_o_chamado_finalizado(self):
        self.gravar([
            {**item("UTIC-2026-0001", fin.STATUS_OK), "planilha": "gravado"},
            {**item("UTIC-2026-0002", fin.STATUS_OK), "planilha": "nao_encontrado"},
            {**item("UTIC-2026-0003", fin.STATUS_OUTRO_TECNICO), "planilha": "ambiguo"},
        ])
        for numero in ("UTIC-2026-0001", "UTIC-2026-0002", "UTIC-2026-0003"):
            fin.registrar_finalizacao(self.pasta, numero, fin.STATUS_OK, "24/11/2026 10:00")
        self.assertEqual(fin.falhas_da_finalizacao(self.pasta, PARADA)["itens"], [
            {"numero": "UTIC-2026-0002", "motivo": "planilha"}, {"numero": "UTIC-2026-0003", "motivo": "planilha"},
        ])

    def test_erro_do_lote_ao_gravar_r_avisa_sem_a_mensagem(self):
        self.gravar([item("UTIC-2026-0001", fin.STATUS_OK)], planilha=f"A coluna R não foi gravada: {SUJO}",
                    sharepoint=fin.aviso_sharepoint(False, SUJO))
        saida = fin.falhas_da_finalizacao(self.pasta, PARADA)
        self.assertEqual(saida["itens"], [{"numero": "", "motivo": "planilha"}])
        self.assertNotIn("IGNORE", json.dumps(saida))

    def test_cancelada_pelo_usuario_nao_e_falha(self):
        self.gravar([item("UTIC-2026-0001", fin.STATUS_OK)], cancelado=True)
        self.assertEqual(fin.falhas_da_finalizacao(self.pasta, PARADA)["total"], 0)

    def test_sharepoint_que_falhou_ou_ficou_incerto_avisa(self):
        for aviso in (fin.aviso_sharepoint(True, SUJO), {**fin.aviso_sharepoint(False), "incerto": True}):
            self.gravar([item("UTIC-2026-0001", fin.STATUS_OK)], sharepoint=aviso)
            saida = fin.falhas_da_finalizacao(self.pasta, PARADA)
            self.assertEqual(saida["itens"], [{"numero": "", "motivo": "sharepoint"}])
            self.assertNotIn("IGNORE", json.dumps(saida))
        self.gravar([item("UTIC-2026-0001", fin.STATUS_OK)], sharepoint=fin.aviso_sharepoint(False))
        self.assertEqual(fin.falhas_da_finalizacao(self.pasta, PARADA)["total"], 0)


if __name__ == "__main__":
    unittest.main()
