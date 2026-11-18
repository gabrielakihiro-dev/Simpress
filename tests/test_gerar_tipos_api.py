"""O gerador de tipos converte o OpenAPI em TypeScript sem levar defaults nem descrições."""

import unittest

from scripts import gerar_tipos_api as gerador

OPENAPI_SINTETICO = {
    "components": {
        "schemas": {
            "Item": {
                "type": "object",
                "additionalProperties": False,
                "required": ["nome"],
                "properties": {
                    "nome": {"type": "string", "default": "valor-local-que-nao-pode-vazar", "description": "x"},
                    "quantidade": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
                    "modo": {"enum": ["a", "b"]},
                    "tags": {"type": "array", "items": {"anyOf": [{"type": "string"}, {"type": "null"}]}},
                    "extras": {"type": "object", "additionalProperties": True},
                    "qualquer": {"anyOf": [{}, {"type": "null"}]},
                },
            },
            "Vazio": {"type": "object", "additionalProperties": False, "properties": {}},
        }
    },
    "paths": {
        "/api/itens/{id}": {
            "put": {
                "parameters": [
                    {"in": "path", "name": "id", "required": True, "schema": {"type": "string"}},
                    {"in": "query", "name": "forcar", "schema": {"type": "boolean"}},
                ],
                "requestBody": {
                    "required": True,
                    "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Item"}}},
                },
                "responses": {
                    "200": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/Item"}}}},
                    "422": {"content": {"application/json": {"schema": {}}}},
                },
            },
            "delete": {"responses": {"204": {}}},
        }
    },
}


class GerarTiposApiTests(unittest.TestCase):
    def setUp(self):
        self.texto = gerador.gerar(OPENAPI_SINTETICO)

    def test_modelo_vira_tipo_com_opcionais_null_enum_e_record(self):
        self.assertIn(
            "export type Item = {\n"
            '  "nome": string;\n'
            '  "quantidade"?: number | null;\n'
            '  "modo"?: "a" | "b";\n'
            '  "tags"?: (string | null)[];\n'
            '  "extras"?: Record<string, unknown>;\n'
            '  "qualquer"?: unknown;\n'
            "};\n",
            self.texto,
        )
        self.assertIn("export type Vazio = Record<string, never>;", self.texto)

    def test_rota_traz_consulta_corpo_e_resposta(self):
        self.assertIn(
            '  "PUT /api/itens/{id}": {\n'
            '    consulta: { "forcar"?: boolean; };\n'
            "    corpo: Item;\n"
            "    resposta: Item;\n"
            "  };",
            self.texto,
        )
        self.assertIn('  "DELETE /api/itens/{id}": {\n    consulta: never;\n    corpo: never;\n    resposta: unknown;', self.texto)

    def test_defaults_e_descricoes_ficam_fora(self):
        self.assertNotIn("valor-local-que-nao-pode-vazar", self.texto)
        self.assertTrue(self.texto.startswith(gerador.CABECALHO))


if __name__ == "__main__":
    unittest.main()
