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

# Se a mudança em ferramenta, prompt ou assinatura for intencional, atualize esta constante.
SHA256_CONTRATO = "4c62bad0894ab8f3046cd5759158bef451ebf55b35dc4fa64c7fda3c69d37460"

NOMES_DA_FACHADA = (
    "ACOES_APELIDO_MANUAL", "ArquivoUpload", "AVISO_BACKUPS_NO_PAINEL", "DECISOES_VALIDAS", "FONTES_VINCULO_OS", "MAX_ANOTACAO",
    "MAX_ITENS_LISTA", "MAX_TEXTO_CHAMADO", "MOTIVOS_AUTOMACAO", "ROTINAS_VALIDAS", "SimpressApi", "Transport",
    "_MOTIVOS", "_dict", "_exemplo_comparacao", "_motivo_codigo", "_rotular_item", "asgi_transport",
    "diferencas_representante", "montar_contato_origem", "representante_efetivo", "validar_anotacao", "validar_transferencia",
    "validar_vinculo_os",
)


def _parametros(funcao: object) -> list:
    return [[p.name, p.kind.name, repr(p.default)] for p in inspect.signature(funcao).parameters.values()]  # type: ignore[arg-type]


def _contrato() -> str:
    publicos = sorted(n for n in dir(SimpressApi) if not n.startswith("__"))
    dados = {
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
    return json.dumps(dados, sort_keys=True, ensure_ascii=False, default=str)


class ContratoModeloTests(unittest.TestCase):
    def test_snapshot_do_que_vai_ao_modelo(self) -> None:
        atual = hashlib.sha256(_contrato().encode("utf-8")).hexdigest()
        self.assertEqual(atual, SHA256_CONTRATO, "Ferramentas, prompt ou API do Assistente mudaram; se foi intencional, atualize SHA256_CONTRATO.")

    def test_fachada_reexporta_os_nomes_usados_fora(self) -> None:
        faltando = [n for n in NOMES_DA_FACHADA if not hasattr(assistant_api, n)]
        self.assertEqual(faltando, [])


if __name__ == "__main__":
    unittest.main()
