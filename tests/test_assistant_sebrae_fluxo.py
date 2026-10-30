import unittest
from typing import Any, Dict, Optional, Tuple

from domains.assistant_api import SimpressApi
from domains.assistant_tools import TOOLS


def api(estado: Dict[str, Any], status: int = 200) -> SimpressApi:
    def transporte(metodo: str, caminho: str, params: Optional[Dict[str, Any]], corpo: Optional[Dict[str, Any]]) -> Tuple[int, Any]:
        return (status, estado) if caminho == "/api/sebrae/novos" else (404, {})
    return SimpressApi(transporte)


def importado(**extra: Any) -> Dict[str, Any]:
    return {"arquivo": "d.xlsx", "total": 3, "abertos": [], "atualizavel": True, "saida_pronta": False, **extra}


NOVOS = {"formulario": [{"numero": "UTIC-2026-1"}, {"numero": "UTIC-2026-2"}], "pendentes": [], "erros": {}}


class ProximoPassoSebraeTests(unittest.TestCase):
    def passo(self, estado: Dict[str, Any]) -> Dict[str, Any]:
        return api(estado).proximo_passo_sebrae()

    def test_sem_dashboard_manda_baixar_e_importar(self):
        r = self.passo({"importado": None, "novos": None})
        self.assertFalse(r["dashboard_importado"])
        self.assertIn("Baixar, importar e buscar", r["proximo_passo"])

    def test_copia_que_nao_atualiza_manda_importar_de_novo(self):
        r = self.passo({"importado": importado(atualizavel=False), "novos": None})
        self.assertIn("Importar o Dashboard de novo", r["proximo_passo"])

    def test_sem_busca_manda_buscar_chamados_novos(self):
        r = self.passo({"importado": importado(), "novos": None})
        self.assertIn("Buscar os chamados novos", r["proximo_passo"])
        self.assertIsNone(r["chamados_novos"])

    def test_com_novos_e_sem_saida_manda_atualizar_e_so_o_usuario_faz(self):
        r = self.passo({"importado": importado(), "novos": NOVOS})
        self.assertEqual(r["chamados_novos"], 2)
        self.assertIn("Atualizar Dashboard", r["proximo_passo"])
        self.assertEqual(r["quem_executa"], "usuario")

    def test_com_saida_pronta_aponta_o_envio_ao_sharepoint_para_o_usuario(self):
        r = self.passo({"importado": importado(saida_pronta=True), "novos": NOVOS})
        self.assertTrue(r["dashboard_atualizado_gerado"])
        self.assertIn("Enviar ao SharePoint", r["proximo_passo"])
        self.assertEqual(r["quem_executa"], "usuario")

    def test_erro_do_servidor_volta_como_erro(self):
        self.assertIn("erro", api({}, status=503).proximo_passo_sebrae())

    def test_ferramenta_existe_e_so_le(self):
        self.assertFalse(TOOLS["proximo_passo_sebrae"].changes_data)


if __name__ == "__main__":
    unittest.main()
