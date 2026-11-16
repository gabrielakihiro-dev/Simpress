import unittest

from domains.equipment_search import build_search_index, search_index


class ModelAbbreviationSearchTest(unittest.TestCase):
    def setUp(self):
        # Model names as the cadastro writes them: the HP lines come abbreviated.
        self.index = build_search_index({
            "SN-ZB1": {"serial": "SN-ZB1", "modelo": "HP ZB PWR G11", "tipo": "Notebook"},
            "SN-ZB2": {"serial": "SN-ZB2", "modelo": "HP ZB FURY G11", "tipo": "Notebook"},
            "SN-EB1": {"serial": "SN-EB1", "modelo": "HP EB 6 G1I", "tipo": "Notebook"},
            "SN-640": {"serial": "SN-640", "modelo": "HP 640 G11", "tipo": "Notebook"},
        })

    def seriais(self, termo):
        return [item["serial"] for item in search_index(self.index, termo)]

    def test_zbook_acha_modelo_abreviado(self):
        self.assertEqual(self.seriais("zbook"), ["SN-ZB1", "SN-ZB2"])
        self.assertEqual(self.seriais("zbook fury"), ["SN-ZB2"])

    def test_elitebook_acha_modelo_abreviado(self):
        self.assertEqual(self.seriais("elitebook"), ["SN-EB1"])

    def test_modelo_exibido_continua_o_do_cadastro(self):
        self.assertEqual(search_index(self.index, "zbook")[0]["modelo"], "HP ZB PWR G11")


if __name__ == "__main__":
    unittest.main()
