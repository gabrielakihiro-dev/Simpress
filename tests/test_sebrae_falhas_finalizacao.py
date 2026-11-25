"""Aviso do sino das falhas ao finalizar no SoftExpert (``falhas_da_finalizacao``, pedido do usuário de 24/11/2026)."""

import json
import tempfile
import unittest
from pathlib import Path

from domains import sebrae_finalizacao as fin

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
        self.assertEqual(fin.falhas_da_finalizacao(self.pasta, False), {"total": 0, "itens": []})
        self.gravar([item("UTIC-2026-0001")], acao=fin.ACAO_REENVIAR)
        self.assertEqual(fin.falhas_da_finalizacao(self.pasta, False), {"total": 0, "itens": []})

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
        saida = fin.falhas_da_finalizacao(self.pasta, False)
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

    def test_chamado_finalizado_depois_sai_do_aviso(self):
        self.gravar([item("UTIC-2026-0001"), item("UTIC-2026-0002")])
        fin.registrar_finalizacao(self.pasta, "UTIC-2026-0001", fin.STATUS_OK, "24/11/2026 10:00")
        self.assertEqual(fin.falhas_da_finalizacao(self.pasta, False)["itens"], [{"numero": "UTIC-2026-0002", "motivo": "erro"}])

    def test_rotina_que_parou_no_meio_so_avisa_quando_nao_esta_rodando(self):
        self.gravar([item("UTIC-2026-0001", fin.STATUS_OK)], em_andamento=True, terminado_em=None)
        self.assertEqual(fin.falhas_da_finalizacao(self.pasta, True), {
            "total": 0, "itens": [], "iniciado_em": "2026-11-24T10:00:00-03:00", "terminado_em": "",
        })
        self.assertEqual(fin.falhas_da_finalizacao(self.pasta, False)["itens"], [{"numero": "", "motivo": "interrompida"}])

    def test_cancelada_pelo_usuario_nao_e_falha(self):
        self.gravar([item("UTIC-2026-0001", fin.STATUS_OK)], cancelado=True)
        self.assertEqual(fin.falhas_da_finalizacao(self.pasta, False)["total"], 0)

    def test_sharepoint_que_falhou_ou_ficou_incerto_avisa(self):
        for aviso in (fin.aviso_sharepoint(True, SUJO), {**fin.aviso_sharepoint(False), "incerto": True}):
            self.gravar([item("UTIC-2026-0001", fin.STATUS_OK)], sharepoint=aviso)
            saida = fin.falhas_da_finalizacao(self.pasta, False)
            self.assertEqual(saida["itens"], [{"numero": "", "motivo": "sharepoint"}])
            self.assertNotIn("IGNORE", json.dumps(saida))
        self.gravar([item("UTIC-2026-0001", fin.STATUS_OK)], sharepoint=fin.aviso_sharepoint(False))
        self.assertEqual(fin.falhas_da_finalizacao(self.pasta, False)["total"], 0)


if __name__ == "__main__":
    unittest.main()
