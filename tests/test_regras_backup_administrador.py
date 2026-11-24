"""Backup <Cidade> no apelido e usuário Administrador (dados fictícios)."""

import unittest

from domains.inventory_comparison import SERIE_LOCAL_MAP
from domains.effective_alias import strip_manual_alias_marker
from domains.regras_negocio import cidade_do_apelido_backup, usuario_e_administrador


def _cidade(apelido):
    return cidade_do_apelido_backup(strip_manual_alias_marker(apelido), SERIE_LOCAL_MAP.values())


class CidadeDoApelidoBackupTests(unittest.TestCase):
    def test_reconhece_cidade_com_marcador_numero_e_acento(self):
        self.assertEqual(_cidade("BACKUP CURITIBA 03 (M)"), "Curitiba")
        self.assertEqual(_cidade("Backup Paranavaí 01 (M)"), "Paranavaí")
        self.assertEqual(_cidade("backup  paranavai"), "Paranavaí")

    def test_cidade_mais_longa_primeiro(self):
        self.assertEqual(_cidade("Backup Curitiba UTIC"), "Curitiba UTIC")

    def test_nao_reconhece(self):
        for texto in ("Backup Xyz 01", "Backup", "Backups antigos", "NoBackup Curitiba", "", None):
            self.assertIsNone(_cidade(texto), texto)


class UsuarioAdministradorTests(unittest.TestCase):
    def test_verdadeiro(self):
        for texto in (
            "Administrador", "administrator", r".\Administrador", r"SEBRAE\Administrador", "Administrador@SEBRAE",
            "ADMINISTRADOR (Horário da última atividade 01/01/2026)", "fulano, Administrador",
        ):
            self.assertTrue(usuario_e_administrador(texto), texto)

    def test_falso(self):
        for texto in ("admin.fulano", "administradora", "", None, "N/A"):
            self.assertFalse(usuario_e_administrador(texto), texto)


if __name__ == "__main__":
    unittest.main()
