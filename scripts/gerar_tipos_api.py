"""Gera os tipos TypeScript da API a partir do OpenAPI do FastAPI, sem ligar o servidor.

Uso:
    python scripts/gerar_tipos_api.py          regrava frontend/src/api-tipos.gerado.d.ts
    python scripts/gerar_tipos_api.py --check  falha se o arquivo commitado estiver desatualizado

Só tipos: defaults, descrições e limites ficam de fora, para nenhuma configuração local entrar no Git.
A maioria das rotas devolve Dict[str, Any] sem response_model; a resposta delas sai como Record<string, unknown>.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any
from unittest.mock import patch

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DESTINO = PROJECT_ROOT / "frontend" / "src" / "api-tipos.gerado.d.ts"
CABECALHO = (
    "// Gerado por scripts/gerar_tipos_api.py a partir do OpenAPI do FastAPI. Não edite à mão:\n"
    "// rode `python scripts/gerar_tipos_api.py` depois de mudar uma rota ou um modelo pydantic.\n"
)
METODOS = ("get", "post", "put", "patch", "delete")

Schema = dict[str, Any]


def nome_ts(nome: str) -> str:
    return re.sub(r"\W", "_", nome)


def chave(nome: str) -> str:
    return json.dumps(nome, ensure_ascii=False)


def tipo_ts(schema: Schema) -> str:
    """Converte um schema JSON do pydantic em tipo TypeScript; palavra-chave desconhecida vira unknown."""
    if "$ref" in schema:
        return nome_ts(schema["$ref"].rsplit("/", 1)[-1])
    if "enum" in schema:
        return " | ".join(json.dumps(valor, ensure_ascii=False) for valor in schema["enum"])
    if "const" in schema:
        return json.dumps(schema["const"], ensure_ascii=False)
    opcoes = schema.get("anyOf") or schema.get("oneOf")
    if opcoes:
        tipos = list(dict.fromkeys(tipo_ts(opcao) for opcao in opcoes))
        return "unknown" if "unknown" in tipos else " | ".join(tipos)
    tipo = schema.get("type")
    if tipo == "string":
        return "Blob" if "contentMediaType" in schema or schema.get("format") == "binary" else "string"
    if tipo in ("integer", "number"):
        return "number"
    if tipo == "boolean":
        return "boolean"
    if tipo == "null":
        return "null"
    if tipo == "array":
        item = tipo_ts(schema.get("items", {}))
        return f"({item})[]" if " | " in item else f"{item}[]"
    if tipo == "object":
        return objeto_ts(schema, "")
    return "unknown"


def objeto_ts(schema: Schema, recuo: str) -> str:
    """Objeto com propriedades vira bloco; sem propriedades, Record (extra="forbid" sem campos = objeto vazio)."""
    propriedades: Schema = schema.get("properties", {})
    extra = schema.get("additionalProperties")
    if not propriedades:
        if extra is False:
            return "Record<string, never>"
        return f"Record<string, {tipo_ts(extra) if isinstance(extra, dict) else 'unknown'}>"
    obrigatorios = set(schema.get("required", []))
    linhas = [
        f"{recuo}  {chave(nome)}{'' if nome in obrigatorios else '?'}: {tipo_ts(sub)};"
        for nome, sub in propriedades.items()
    ]
    return "{\n" + "\n".join(linhas) + f"\n{recuo}}}"


def corpo_ts(operacao: Schema) -> str:
    conteudo = operacao.get("requestBody", {}).get("content", {})
    if not conteudo:
        return "never"
    tipo = tipo_ts(next(iter(conteudo.values())).get("schema", {}))
    return tipo if operacao["requestBody"].get("required") else f"{tipo} | undefined"


def consulta_ts(operacao: Schema) -> str:
    parametros = [p for p in operacao.get("parameters", []) if p.get("in") == "query"]
    if not parametros:
        return "never"
    campos = " ".join(
        f"{chave(p['name'])}{'' if p.get('required') else '?'}: {tipo_ts(p.get('schema', {}))};" for p in parametros
    )
    return "{ " + campos + " }"


def resposta_ts(operacao: Schema) -> str:
    for codigo, resposta in sorted(operacao.get("responses", {}).items()):
        if codigo.startswith("2"):
            conteudo = resposta.get("content", {}).get("application/json")
            return tipo_ts(conteudo.get("schema", {})) if conteudo else "unknown"
    return "unknown"


def gerar(openapi: Schema) -> str:
    partes = [CABECALHO]
    for nome, schema in sorted(openapi.get("components", {}).get("schemas", {}).items()):
        tipo = objeto_ts(schema, "") if schema.get("type") == "object" else tipo_ts(schema)
        partes.append(f"export type {nome_ts(nome)} = {tipo};\n")
    linhas = []
    for caminho, operacoes in sorted(openapi.get("paths", {}).items()):
        for metodo in METODOS:
            operacao = operacoes.get(metodo)
            if operacao is None:
                continue
            linhas.append(
                f"  {chave(f'{metodo.upper()} {caminho}')}: {{\n"
                f"    consulta: {consulta_ts(operacao)};\n"
                f"    corpo: {corpo_ts(operacao)};\n"
                f"    resposta: {resposta_ts(operacao)};\n"
                "  };"
            )
    partes.append("/** Cada rota da API: parâmetros de consulta (?a=b), corpo enviado e resposta. */\n")
    partes.append("export interface Rotas {\n" + "\n".join(linhas) + "\n}\n")
    return "\n".join(partes)


def openapi_do_app() -> Schema:
    """Importa o app como os testes fazem: sem recuperar transações nem abrir planilhas reais."""
    os.environ.setdefault("SIMPRESS_CHROME_OCIOSO_S", "0")
    os.environ.setdefault("SIMPRESS_SUGESTAO_IA", "0")
    sys.path.insert(0, str(PROJECT_ROOT))
    import openpyxl

    from core import integrity

    with (
        patch.object(integrity, "recover_pending_transactions", return_value=None),
        patch.object(openpyxl, "load_workbook", side_effect=RuntimeError("planilha bloqueada ao gerar tipos")),
    ):
        import main

        return main.app.openapi()


def principal(argumentos: list[str]) -> int:
    texto = gerar(openapi_do_app())
    if "--check" in argumentos:
        atual = DESTINO.read_text(encoding="utf-8") if DESTINO.exists() else ""
        if atual.replace("\r\n", "\n") != texto:
            print(f"{DESTINO.relative_to(PROJECT_ROOT)} está desatualizado: rode `python scripts/gerar_tipos_api.py` e commite.")
            return 1
        return 0
    DESTINO.write_text(texto, encoding="utf-8", newline="\n")
    print(f"Gravado {DESTINO.relative_to(PROJECT_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(principal(sys.argv[1:]))
