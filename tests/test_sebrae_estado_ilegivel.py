"""Bloco E: arquivo de estado do Sebrae ilegível nunca vira vazio nem é sobrescrito (dados sintéticos).

As senhas (``sebrae_credenciais``) já têm a cobertura equivalente em ``tests/test_json_corrompido.py``."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from core.errors import DomainBusyError
from domains import sebrae_finalizacao as fin, sebrae_novos
from domains import sebrae_observacoes as obs
from domains.sebrae_chamados import ChamadoSoftExpert
from tests.test_sebrae_dashboard_gravacao import montar
from tests.test_sebrae_dashboard_router import RotasBase

LIXO = b"{ meio gravado"


class NovosIlegiveisTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.caminhos = sebrae_novos.caminhos_padrao(self.dir)

    def test_cache_de_antigos_ilegivel_nao_e_sobrescrito(self):
        destino = sebrae_novos.caminho_antigos(self.caminhos)
        destino.write_bytes(LIXO)
        with self.assertRaises(DomainBusyError):
            sebrae_novos.salvar_antigo(destino, ChamadoSoftExpert("UTIC-2026-0001", titulo="x"))
        self.assertEqual(destino.read_bytes(), LIXO)
        self.assertEqual(sebrae_novos.ler_antigos(destino), {})  # a tela continua lendo sem derrubar

    def test_existentes_ausente_e_none_ilegivel_e_erro_estrito(self):
        self.assertIsNone(sebrae_novos.ler_existentes(self.caminhos.existentes, estrito=True))
        self.caminhos.existentes.write_bytes(LIXO)
        self.assertIsNone(sebrae_novos.ler_existentes(self.caminhos.existentes))
        with self.assertRaises(DomainBusyError):
            sebrae_novos.ler_existentes(self.caminhos.existentes, estrito=True)
        with self.assertRaises(DomainBusyError):
            sebrae_novos.salvar_existentes(self.caminhos.existentes, ["UTIC-2026-0001"], "d.xlsx")
        self.assertEqual(self.caminhos.existentes.read_bytes(), LIXO)

    def test_existentes_e_gravado_com_fsync(self):
        with patch("os.fsync") as fsync:
            sebrae_novos.salvar_existentes(self.caminhos.existentes, ["UTIC-2026-0001"], "d.xlsx")
        self.assertTrue(fsync.called)


class ImportacaoComEstadoIlegivelTest(RotasBase):
    def setUp(self):
        super().setUp()
        self.base = montar(("UTIC-2026-0001", "UTIC-2026-0002"), ultima=9, status=("EM ABERTO", "EM ABERTO"))
        self.assertEqual(self.importar(self.base).status_code, 200)
        self.nova = montar(("UTIC-2026-0001",), ultima=9, status=("FINALIZADO",))

    def _recusa_sem_gravar(self, arquivo: Path):
        arquivo.write_bytes(LIXO)
        antes = self.caminhos.existentes.read_bytes()
        arquivo_encerrados = sebrae_novos.caminho_arquivo(self.caminhos)
        arquivados = arquivo_encerrados.read_bytes() if arquivo_encerrados.exists() else None
        resposta = self.importar(self.nova)
        self.assertEqual(resposta.status_code, 503, resposta.text)
        self.assertEqual(self.caminhos.existentes.read_bytes(), antes)  # base nova não entrou
        self.assertEqual(arquivo_encerrados.read_bytes() if arquivo_encerrados.exists() else None, arquivados)  # nada arquivado
        self.assertEqual(arquivo.read_bytes(), LIXO)

    def test_existentes_ilegivel_nao_vira_nunca_importado(self):
        self._recusa_sem_gravar(self.caminhos.existentes)

    def test_estado_de_finalizacao_ilegivel_recusa_antes_de_gravar(self):
        self._recusa_sem_gravar(fin._estado(self.dir))

    def test_observacoes_ilegiveis_recusam_antes_de_gravar(self):
        self._recusa_sem_gravar(obs.caminho_observacoes(self.dir))
