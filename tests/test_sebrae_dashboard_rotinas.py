"""Finalização e rotinas do Dashboard Sebrae no domínio (domains/sebrae_dashboard_rotinas.py), sem passar pelo HTTP."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, List
from unittest.mock import patch

from core.errors import DomainConflictError
from domains import sebrae_dashboard_rotinas as rotinas
from domains import sebrae_dashboard_tela as tela
from domains import sebrae_finalizacao as fin
from domains import sebrae_novos
from domains.sebrae_dashboard_tela import SebraeDashboardServices

A, B = "UTIC-2026-0001", "UTIC-2026-0002"
R_OK = "30/10/2026 14:05"


class RunnerFalso:
    def __init__(self) -> None:
        self.iniciadas: List[str] = []
        self.estado: Dict[str, Any] = {"estado": "livre"}

    def start(self, rotina: str) -> Dict[str, Any]:
        self.iniciadas.append(rotina)
        return {"estado": "em_andamento", "rotina": rotina}

    def state(self) -> Dict[str, Any]:
        return self.estado


class RotinasTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        caminhos = sebrae_novos.caminhos_padrao(Path(tmp.name))
        self.runner = RunnerFalso()
        self.services = SebraeDashboardServices(
            caminhos=lambda: caminhos, max_upload_bytes=lambda: 1024, registros=lambda: [],
            relatorio_chamados=lambda: None, runner=lambda: self.runner,
        )
        self.pasta = tela.pasta_estado(self.services)

    def test_exigir_rotina_livre_recusa_com_rotina_em_andamento(self) -> None:
        self.runner.estado = {"estado": "em_andamento", "rotina": "antigos"}
        with self.assertRaises(DomainConflictError) as erro:
            rotinas.exigir_rotina_livre(self.services, self.pasta)
        self.assertEqual(erro.exception.detail, "Já há uma rotina em execução. Aguarde terminar.")

    def test_disparar_com_rotina_em_andamento_nao_grava_job_nem_inicia(self) -> None:
        self.runner.estado = {"estado": "em_andamento", "rotina": "antigos"}
        with self.assertRaises(DomainConflictError):
            rotinas.disparar(self.services, [A], encerramentos={A: R_OK})
        self.assertEqual(self.runner.iniciadas, [])
        self.assertFalse(fin.caminho_job(self.pasta).exists())

    def test_disparar_com_job_pendente_recente_recusa_e_nao_sobrescreve(self) -> None:
        fin.gravar_job(self.pasta, [B])
        with self.assertRaises(DomainConflictError):
            rotinas.disparar(self.services, [A], encerramentos={A: R_OK})
        self.assertEqual(self.runner.iniciadas, [])
        self.assertEqual(json.loads(fin.caminho_job(self.pasta).read_text(encoding="utf-8"))["numeros"], [B])

    def test_finalizar_marcados_pula_ja_finalizado_sem_iniciar(self) -> None:
        fin.registrar_finalizacao(self.pasta, A, fin.STATUS_OK, R_OK)
        resultado = rotinas.finalizar_marcados(self.services, {A: {"D": "FINALIZADO", "R": R_OK}})
        self.assertEqual(resultado, {
            "iniciado": False, "motivo": "", "numeros": [], "pulados": [{"numero": A, "motivo": fin.STATUS_JA_FINALIZADO}],
        })
        self.assertEqual(self.runner.iniciadas, [])
        self.assertFalse(fin.caminho_job(self.pasta).exists())

    def test_encerramento_do_pedido_precedencia(self) -> None:
        importado = {"abertos": [{"numero": A, "valores": {"R": "01/10/2026 08:00"}}]}
        enviados = [(A, ""), (B, "02/10/2026 09:00"), (A, "03/10/2026 10:00"), (A, "04/10/2026 11:00")]
        with patch.object(sebrae_novos, "ler_existentes", return_value=importado):
            self.assertEqual(rotinas.encerramento_do_pedido(self.services, A, "05/10/2026 12:00", enviados), "05/10/2026 12:00")
            # informado fora do formato não cai para outra fonte
            self.assertEqual(rotinas.encerramento_do_pedido(self.services, A, "abc", enviados), "")
            # o primeiro par com R (edições vêm antes dos chamados) vale
            self.assertEqual(rotinas.encerramento_do_pedido(self.services, A, " ", enviados), "03/10/2026 10:00")
            self.assertEqual(rotinas.encerramento_do_pedido(self.services, A, "", [(A, " ")]), "01/10/2026 08:00")
            self.assertEqual(rotinas.encerramento_do_pedido(self.services, B, "", []), "")


if __name__ == "__main__":
    unittest.main()
