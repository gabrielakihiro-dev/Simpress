"""Guarda da refatoração de `assistant_api`: o que vai ao modelo e a fachada pública não mudam."""

import hashlib
import inspect
import json
import unittest

from domains import assistant_api
from domains.assistant_api import SimpressApi
from domains.assistant_chat import SYSTEM_PROMPT
from domains.assistant_instrucoes import montar_prompt
from domains.assistant_tools import FERRAMENTAS_LOCAIS_UX, schemas_para_mensagem, tool_schemas

# Hash de cada parte do que vai ao modelo, capturado no código antes da divisão de assistant_api.
# Se a mudança em ferramenta, prompt ou assinatura for intencional, atualize a seção que mudou.
SHA256_POR_SECAO = {
    "tool_schemas_true": "7672dd53bb444388fca5420d8fb70b38fabb718f5fc0cd8a61b3f9beda385220",
    "tool_schemas_false": "e83d40d97420e737e7d1f16f61ccd299a823c9fef717814b00a98562b98940f1",
    "mensagens": "79bf41d2e904f8d012bc49e78a2e287757893461828f43b11efedfdb48acee2a",
    "ferramentas_locais_ux": "9f553132586c39cedaadae3e17483b41168bf424d532d8dc21780f2ebef4b3ba",
    "system_prompt": "385338683d82b1cbf7c0960cd79e4ccdc1ed0be9599e3d25ea1f3f9e3d7eda72",
    "montar_prompt": "32c9c32d16407ff1071d97cb40cf7f195bb12635050308b99508e582d3939073",
    "membros": "573b59a341d16b5ea0849445c081e5816161b74e262df26772e2ed744530aa1a",
    "assinaturas": "4a71ae37e01d77b1b0ab4a9bc45e8c48f12eb65a1511f8f6ba5bc59621dd3409",
}

NOMES_DA_FACHADA = (
    "ACOES_APELIDO_MANUAL", "ArquivoUpload", "AVISO_BACKUPS_NO_PAINEL", "DECISOES_VALIDAS", "FONTES_VINCULO_OS", "MAX_ANOTACAO",
    "MAX_ITENS_LISTA", "MAX_TEXTO_CHAMADO", "MOTIVOS_AUTOMACAO", "ROTINAS_VALIDAS", "SimpressApi", "Transport",
    "_MOTIVOS", "_dict", "_exemplo_comparacao", "_motivo_codigo", "_rotular_item", "asgi_transport",
    "diferencas_representante", "montar_contato_origem", "representante_efetivo", "validar_anotacao", "validar_transferencia",
    "validar_vinculo_os",
)


def _parametros(funcao: object) -> list:
    return [[p.name, p.kind.name, repr(p.default)] for p in inspect.signature(funcao).parameters.values()]  # type: ignore[arg-type]


def _secoes() -> dict:
    publicos = sorted(n for n in dir(SimpressApi) if not n.startswith("__"))
    return {
        "tool_schemas_true": tool_schemas(True),
        "tool_schemas_false": tool_schemas(False),
        "mensagens": {t: schemas_para_mensagem(t) for t in ("quantos equipamentos?", "chamados do sebrae", "olá")},
        "ferramentas_locais_ux": sorted(FERRAMENTAS_LOCAIS_UX),
        "system_prompt": SYSTEM_PROMPT,
        "montar_prompt": montar_prompt(SYSTEM_PROMPT, "x"),
        "membros": publicos,
        # nome, tipo e default de cada parâmetro; sem anotações, que o Python 3.14 escreve de outro jeito (X | None)
        "assinaturas": {n: _parametros(getattr(SimpressApi, n)) for n in publicos if callable(getattr(SimpressApi, n))},
    }


def _hash(valor: object) -> str:
    return hashlib.sha256(json.dumps(valor, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")).hexdigest()


class ContratoModeloTests(unittest.TestCase):
    def test_snapshot_do_que_vai_ao_modelo(self) -> None:
        secoes = _secoes()
        atual = {nome: _hash(valor) for nome, valor in secoes.items()}
        mudou = sorted(n for n in SHA256_POR_SECAO if atual.get(n) != SHA256_POR_SECAO[n])
        # Para achar a ferramenta que mudou, a falha lista o hash curto de cada schema.
        por_ferramenta = {s["function"]["name"]: _hash(s)[:12] for s in secoes["tool_schemas_true"]}
        self.assertEqual(
            atual, SHA256_POR_SECAO,
            f"Ferramentas, prompt ou API do Assistente mudaram nas seções {mudou}; se foi intencional, atualize SHA256_POR_SECAO. "
            f"Hash por ferramenta: {por_ferramenta}",
        )

    def test_fachada_reexporta_os_nomes_usados_fora(self) -> None:
        faltando = [n for n in NOMES_DA_FACHADA if not hasattr(assistant_api, n)]
        self.assertEqual(faltando, [])


if __name__ == "__main__":
    unittest.main()
