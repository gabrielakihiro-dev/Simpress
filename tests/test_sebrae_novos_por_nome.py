"""The name index of ``sebrae_novos`` gives exactly what ``cruzar_por_nome`` over every record gives (synthetic data)."""
import unittest
from unittest import mock

from domains import sebrae_novos as novos
from domains.sebrae_chamados import ChamadoSoftExpert
from domains.sebrae_dashboard import CRUZ_AUSENTE, Cruzamento, cruzar_por_nome

REGISTROS = [
    {"nome": "Camila  Lopes", "serie": "ABC123", "modelo": "Latitude 5440", "cidade": "Brasília"},
    {"nome": "camila lopes", "serie": "", "modelo": "", "cidade": "Goiânia"},
    {"nome": "Icaro Gabriel Duarte Campos", "serie": "X1", "modelo": "Latitude", "cidade": "Brasília"},
    {"nome": "Icaro Gabriel Duarte Campos", "serie": "X2", "modelo": "Latitude", "cidade": "Brasília"},  # two series: ambiguous
    {"nome": "Bruna Mac", "serie": "SC02XYZ123", "modelo": "MacBook Air", "cidade": "Palmas"},
    {"nome": "Bruna  Mac", "serie": "C02XYZ123", "modelo": "MacBook Air", "cidade": ""},  # same MacBook without the S
    {"nome": "", "serie": "Z9", "modelo": "", "cidade": ""},
]

CHAMADOS = [
    ChamadoSoftExpert(numero="UTIC-1", descricao="Camila Lopes sem rede", solicitante="Camila Lopes"),
    ChamadoSoftExpert(numero="UTIC-2", descricao="teclado", solicitante="Icaro Gabriel Duarte Campos"),
    ChamadoSoftExpert(numero="UTIC-3", descricao="tela", solicitante="Bruna Mac"),
    ChamadoSoftExpert(numero="UTIC-4", descricao="mouse", solicitante="Pessoa Sem Cadastro"),
    ChamadoSoftExpert(numero="UTIC-5", descricao="", solicitante=""),
]


def _sem_indice(nome, registros, grupos):
    """The behaviour before the index: every record walked for every ticket."""
    return cruzar_por_nome(nome, registros) if registros and nome else Cruzamento(CRUZ_AUSENTE)


class PorNomeTests(unittest.TestCase):
    def _abertos(self):
        return [{"numero": c.numero, "descricao": c.descricao, "usuario": c.solicitante, "automaticos": {}} for c in CHAMADOS]

    def test_formulario_e_preenchimentos_iguais_sem_indice(self):
        for registros in (REGISTROS, []):
            with self.subTest(registros=len(registros)):
                com = (novos.formulario(CHAMADOS, registros, None), novos.preenchimentos(self._abertos(), registros, None))
                with mock.patch.object(novos, "_cruzar_nome", _sem_indice):
                    sem = (novos.formulario(CHAMADOS, registros, None), novos.preenchimentos(self._abertos(), registros, None))
                self.assertEqual(com, sem)

    def test_casos_cobertos(self):
        status = {item["numero"]: item["cruzamento"]["status"] for item in novos.formulario(CHAMADOS, REGISTROS, None)}
        self.assertEqual(status["UTIC-4"], CRUZ_AUSENTE)
        self.assertNotEqual(status["UTIC-1"], status["UTIC-2"])  # unique vs ambiguous
        self.assertEqual(status["UTIC-3"], status["UTIC-1"])  # MacBook with and without S is one equipment


if __name__ == "__main__":
    unittest.main()
