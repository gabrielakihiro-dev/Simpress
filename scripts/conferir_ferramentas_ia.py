"""Confere skills, agentes, plugins, MCP, hooks e instrucoes das ferramentas de IA.

Descobre o esperado lendo o repositorio (sem lista fixa). Cada checagem devolve
uma Resultado com status OK, FALHA, AVISO ou NAO VERIFICADO e um motivo curto.
Exit code 1 so se houver FALHA.

Uso:
    python scripts/conferir_ferramentas_ia.py              # so o repositorio
    python scripts/conferir_ferramentas_ia.py --instalado  # + copias do usuario e plugins
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

OK = "OK"
FALHA = "FALHA"
AVISO = "AVISO"
NAO_VERIFICADO = "NAO VERIFICADO"

# Agentes citados pelos hooks de .claude/settings.json; sem eles a delegacao quebra.
AGENTES_CENTRAIS = ("batedor", "executor", "revisor", "segunda-opiniao", "arquiteto")
MODELOS_ALIAS = {"haiku", "sonnet", "opus", "fable", "inherit"}
PASTAS_COM_AGENTS = ("domains", "frontend", "routers", "scripts", "tests")
AGY_PLUGIN_DIR = Path(".agents") / "plugins" / "simpress-maestro"
TOOLS_PROIBIDAS_AGY = {"invoke_subagent", "define_subagent", "Agent", "Task"}
# Usado so se o .bat nao puder ser ser lido; o normal e extrair de `instalar_primeira_vez.bat`.
PLUGINS_FALLBACK = ("ponytail@ponytail", "context7@claude-plugins-official", "custo-modelos@simpress")


@dataclass(frozen=True)
class Resultado:
    status: str
    area: str
    item: str
    motivo: str = ""


def raiz_do_repo() -> Path:
    return Path(__file__).resolve().parent.parent


def mascarar(texto: str) -> str:
    """Troca o caminho do perfil do usuario por %USERPROFILE%."""
    home = os.environ.get("USERPROFILE") or str(Path.home())
    if home:
        for variante in {home, home.replace("\\", "/")}:
            texto = texto.replace(variante, "%USERPROFILE%")
    return texto


# ---------------------------------------------------------------- frontmatter

def ler_frontmatter(caminho: Path) -> dict[str, str] | None:
    """Le linhas `chave: valor` entre `---`. None se nao houver frontmatter."""
    try:
        linhas = caminho.read_text(encoding="utf-8-sig").splitlines()
    except (OSError, UnicodeDecodeError):
        return None
    if not linhas or linhas[0].strip() != "---":
        return None
    dados: dict[str, str] = {}
    chave: str | None = None
    for linha in linhas[1:]:
        if linha.strip() == "---":
            return dados
        if chave and (linha.startswith((" ", "\t")) or linha.lstrip().startswith("- ")):
            extra = linha.strip().removeprefix("- ").strip()
            dados[chave] = (dados[chave] + ", " + extra).strip(", ") if dados[chave] not in ("", ">", "|", ">-", "|-") else extra
            continue
        m = re.match(r"^([A-Za-z0-9_-]+)\s*:\s*(.*)$", linha)
        if m:
            chave = m.group(1)
            dados[chave] = m.group(2).strip().strip("\"'")
    return None  # sem `---` de fechamento


def _valor(dados: dict[str, str], chave: str) -> str:
    return dados.get(chave, "").strip()


# ------------------------------------------------------------------- skills

def _hashes(pasta: Path) -> dict[str, str]:
    saida: dict[str, str] = {}
    for arq in sorted(p for p in pasta.rglob("*") if p.is_file()):
        saida[arq.relative_to(pasta).as_posix()] = hashlib.sha256(arq.read_bytes().replace(b"\r\n", b"\n")).hexdigest()
    return saida


def destinos_instalados(home: Path) -> dict[str, Path]:
    # Destinos reais do instalar_primeira_vez.bat (bloco :checar_skills).
    return {
        ".claude/skills": home / ".claude" / "skills",
        ".agents/skills": home / ".gemini" / "config" / "skills",
    }


def checar_skills(raiz: Path, instalado: bool = False, home: Path | None = None) -> list[Resultado]:
    res: list[Resultado] = []
    home = home or Path(os.environ.get("USERPROFILE") or Path.home())
    destinos = destinos_instalados(home)
    for rel in (".claude/skills", ".agents/skills"):
        base = raiz / rel
        if not base.is_dir():
            res.append(Resultado(AVISO, "skill", rel, "pasta ausente"))
            continue
        for pasta in sorted(p for p in base.iterdir() if p.is_dir()):
            item = f"{rel}/{pasta.name}"
            skill = pasta / "SKILL.md"
            if not skill.is_file():
                res.append(Resultado(FALHA, "skill", item, "sem SKILL.md"))
                continue
            fm = ler_frontmatter(skill)
            if fm is None:
                res.append(Resultado(FALHA, "skill", item, "frontmatter ausente ou sem fechamento"))
                continue
            faltam = [c for c in ("name", "description") if not _valor(fm, c)]
            if faltam:
                res.append(Resultado(FALHA, "skill", item, "falta " + ", ".join(faltam)))
            elif _valor(fm, "name") != pasta.name:
                res.append(Resultado(FALHA, "skill", item, f"name '{_valor(fm, 'name')}' difere da pasta"))
            else:
                res.append(Resultado(OK, "skill", item, "frontmatter valido"))
            if instalado:
                res.append(_conferir_copia(pasta, destinos[rel] / pasta.name, item))
    return res


def _conferir_copia(origem: Path, destino: Path, item: str) -> Resultado:
    area = "skill instalada"
    if not destino.is_dir():
        return Resultado(FALHA, area, item, "copia ausente em " + mascarar(str(destino)))
    esperado, atual = _hashes(origem), _hashes(destino)
    ausentes = [a for a in esperado if a not in atual]
    diferentes = [a for a, h in esperado.items() if a in atual and atual[a] != h]
    if ausentes or diferentes:
        return Resultado(FALHA, area, item, f"{len(ausentes)} ausente(s), {len(diferentes)} diferente(s)")
    return Resultado(OK, area, item, f"{len(esperado)} arquivo(s) iguais")


# ------------------------------------------------------------------ agentes

def _tools_lista(valor: str) -> list[str]:
    bruto = valor.strip().strip("[]")
    return [t.strip().strip("\"'") for t in bruto.split(",") if t.strip()]


def checar_agentes(raiz: Path) -> list[Resultado]:
    res: list[Resultado] = []
    base = raiz / ".claude" / "agents"
    if not base.is_dir():
        return [Resultado(AVISO, "agente", ".claude/agents", "pasta ausente")]
    for nome in AGENTES_CENTRAIS:
        if not (base / f"{nome}.md").is_file():
            res.append(Resultado(FALHA, "agente", f".claude/agents/{nome}.md", "agente central ausente"))
    for arq in sorted(base.glob("*.md")):
        item = f".claude/agents/{arq.name}"
        fm = ler_frontmatter(arq)
        if fm is None:
            res.append(Resultado(FALHA, "agente", item, "frontmatter ausente ou sem fechamento"))
            continue
        problemas: list[str] = []
        nome = _valor(fm, "name")
        if not nome:
            problemas.append("falta name")
        elif nome != arq.stem:
            problemas.append(f"name '{nome}' difere do arquivo")
        if not _valor(fm, "description"):
            problemas.append("falta description")
        modelo = _valor(fm, "model")
        if not modelo:
            problemas.append("falta model")
        elif modelo not in MODELOS_ALIAS and not modelo.startswith("claude-"):
            problemas.append(f"model '{modelo}' invalido")
        tools = _tools_lista(fm["tools"]) if "tools" in fm else None
        if tools and any(t.split("(")[0].strip() in ("Agent", "Task") for t in tools):
            problemas.append("tools contem Agent/Task")
        if problemas:
            res.append(Resultado(FALHA, "agente", item, "; ".join(problemas)))
        elif tools is None or not tools:
            res.append(Resultado(AVISO, "agente", item, "tools nao declarado (herda todas)"))
        else:
            res.append(Resultado(OK, "agente", item, f"model {modelo}, {len(tools)} tool(s)"))
    return res


# ------------------------------------------------------------------ plugins

def plugins_do_instalador(raiz: Path) -> tuple[list[str], str]:
    """Extrai plugin@marketplace do .bat. Devolve (lista, origem)."""
    bat = raiz / "instalar_primeira_vez.bat"
    try:
        texto = bat.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return list(PLUGINS_FALLBACK), "constante do script (.bat ilegivel)"
    m = re.search(r"for\s+%%\w\s+in\s+\(([^)]*)\)\s+do\s+call\s+:instalar_plugin", texto, re.I)
    if m:
        itens = [p for p in m.group(1).split() if "@" in p]
        if itens:
            return itens, "instalar_primeira_vez.bat"
    return list(PLUGINS_FALLBACK), "constante do script (nao achei no .bat)"


def checar_plugins(raiz: Path, timeout: int = 40) -> list[Resultado]:
    plugins, origem = plugins_do_instalador(raiz)
    area = "plugin"
    exe = shutil.which("claude")
    if not exe:
        return [Resultado(NAO_VERIFICADO, area, p, "CLI claude fora do PATH") for p in plugins]
    # Arquivo temporario em vez de PIPE: com claude.cmd, filhos herdam o pipe e o timeout trava.
    try:
        with tempfile.TemporaryFile() as out:
            proc = subprocess.Popen([exe, "plugin", "list"], stdout=out, stderr=out, stdin=subprocess.DEVNULL)
            try:
                codigo = proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                if os.name == "nt":  # mata a arvore: claude.cmd -> node
                    subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True, check=False)
                proc.kill()
                proc.wait()
                return [Resultado(NAO_VERIFICADO, area, p, f"claude plugin list passou de {timeout}s") for p in plugins]
            out.seek(0)
            saida = out.read().decode("utf-8", errors="replace")
    except OSError as erro:
        return [Resultado(NAO_VERIFICADO, area, p, f"erro ao rodar claude: {type(erro).__name__}") for p in plugins]
    if codigo != 0:
        return [Resultado(NAO_VERIFICADO, area, p, f"claude plugin list saiu com {codigo}") for p in plugins]
    res = []
    for p in plugins:
        nome = p.split("@", 1)[0]
        if f"{nome}@" in saida:
            res.append(Resultado(OK, area, p, f"instalado (lista vem de {origem})"))
        else:
            res.append(Resultado(FALHA, area, p, f"ausente em claude plugin list (lista vem de {origem})"))
    return res


# ---------------------------------------------------------------------- MCP

def _ler_json(caminho: Path) -> tuple[object | None, str]:
    try:
        return json.loads(caminho.read_text(encoding="utf-8-sig")), ""
    except OSError:
        return None, "ilegivel"
    except json.JSONDecodeError as erro:
        return None, f"JSON invalido (linha {erro.lineno})"


def checar_mcp(raiz: Path) -> list[Resultado]:
    res: list[Resultado] = []
    mcp = raiz / ".mcp.json"
    servidores: set[str] = set()
    if mcp.is_file():
        dados, erro = _ler_json(mcp)
        if erro or not isinstance(dados, dict):
            res.append(Resultado(FALHA, "mcp", ".mcp.json", erro or "raiz nao e objeto"))
        else:
            sv = dados.get("mcpServers")
            if isinstance(sv, dict):
                servidores = set(sv)
                res.append(Resultado(OK, "mcp", ".mcp.json", "JSON valido: " + ", ".join(sorted(servidores))))
            else:
                res.append(Resultado(FALHA, "mcp", ".mcp.json", "sem mcpServers"))
    settings = raiz / ".claude" / "settings.json"
    if not settings.is_file():
        return res
    dados, erro = _ler_json(settings)
    if erro or not isinstance(dados, dict):
        res.append(Resultado(FALHA, "mcp", ".claude/settings.json", erro or "raiz nao e objeto"))
        return res
    habilitados = dados.get("enabledMcpjsonServers", [])
    if not isinstance(habilitados, list):
        res.append(Resultado(FALHA, "mcp", "enabledMcpjsonServers", "nao e lista"))
        return res
    for nome in habilitados:
        if nome in servidores:
            res.append(Resultado(OK, "mcp", f"enabledMcpjsonServers:{nome}", "existe em mcpServers"))
        else:
            res.append(Resultado(FALHA, "mcp", f"enabledMcpjsonServers:{nome}", "nao existe em .mcp.json"))
    return res


# -------------------------------------------------------------------- hooks

_RE_SCRIPT = re.compile(
    r"""(?P<pref>\$\{?CLAUDE_PROJECT_DIR\}?|%CLAUDE_PROJECT_DIR%)?
        (?P<caminho>[A-Za-z0-9_./\\-]+\.(?:cjs|mjs|js|py|sh|ps1|bat|cmd|ts))""",
    re.X,
)


def _comandos_de_hooks(dados: object) -> list[str]:
    achados: list[str] = []
    if isinstance(dados, dict):
        for k, v in dados.items():
            if k == "command" and isinstance(v, str):
                achados.append(v)
            else:
                achados.extend(_comandos_de_hooks(v))
    elif isinstance(dados, list):
        for v in dados:
            achados.extend(_comandos_de_hooks(v))
    return achados


def scripts_citados(comando: str) -> list[str]:
    """Caminhos de script (relativos ao projeto) citados no comando."""
    if re.match(r"\s*node\s+-e\b", comando):
        return []
    saida: list[str] = []
    for m in _RE_SCRIPT.finditer(comando):
        caminho = m.group("caminho").replace("\\", "/")
        if re.match(r"^[A-Za-z]:|^/", caminho) and not m.group("pref"):
            continue  # absoluto fora do projeto
        saida.append(caminho.lstrip("/"))
    return saida


def checar_hooks(raiz: Path) -> list[Resultado]:
    settings = raiz / ".claude" / "settings.json"
    if not settings.is_file():
        return [Resultado(AVISO, "hook", ".claude/settings.json", "ausente")]
    dados, erro = _ler_json(settings)
    if erro or not isinstance(dados, dict):
        return [Resultado(FALHA, "hook", ".claude/settings.json", erro or "raiz nao e objeto")]
    res: list[Resultado] = []
    vistos: set[str] = set()
    for cmd in _comandos_de_hooks(dados.get("hooks", {})):
        for rel in scripts_citados(cmd):
            if rel in vistos:
                continue
            vistos.add(rel)
            if (raiz / rel).is_file():
                res.append(Resultado(OK, "hook", rel, "script existe"))
            else:
                res.append(Resultado(FALHA, "hook", rel, "script citado no hook nao existe"))
    if not res:
        res.append(Resultado(OK, "hook", "hooks", "nenhum arquivo de script citado"))
    return res


# --------------------------------------------------------------- instrucoes

def checar_instrucoes(raiz: Path) -> list[Resultado]:
    res: list[Resultado] = []
    for rel in ["AGENTS.md"] + [f"{p}/AGENTS.md" for p in PASTAS_COM_AGENTS]:
        if (raiz / rel).is_file():
            res.append(Resultado(OK, "instrucao", rel, "existe"))
        else:
            res.append(Resultado(FALHA, "instrucao", rel, "ausente"))
    for pasta in ("",) + PASTAS_COM_AGENTS:
        claude_md = raiz / pasta / "CLAUDE.md" if pasta else raiz / "CLAUDE.md"
        if not claude_md.is_file():
            if not pasta:
                res.append(Resultado(FALHA, "instrucao", "CLAUDE.md", "ausente"))
            continue
        nome = claude_md.relative_to(raiz).as_posix()
        for linha in claude_md.read_text(encoding="utf-8", errors="replace").splitlines():
            m = re.match(r"^@(\S+)\s*$", linha.strip())
            if not m:
                continue
            alvo = m.group(1)
            if alvo.startswith("~"):
                res.append(Resultado(NAO_VERIFICADO, "instrucao", f"{nome} @{alvo}", "fora do repositorio"))
            elif (claude_md.parent / alvo).is_file():
                res.append(Resultado(OK, "instrucao", f"{nome} @{alvo}", "arquivo existe"))
            else:
                res.append(Resultado(FALHA, "instrucao", f"{nome} @{alvo}", "arquivo nao existe"))
    return res


# --------------------------------------------------------- plugin Antigravity

def checar_plugin_antigravity(raiz: Path) -> list[Resultado]:
    """Confere o plugin simpress-maestro (manifest, regras, agentes, paridade e hooks)."""
    area = "plugin-agy"
    plugin_dir = raiz / AGY_PLUGIN_DIR
    if not plugin_dir.is_dir():
        return [Resultado(FALHA, area, AGY_PLUGIN_DIR.as_posix(), "pasta do plugin ausente")]
    res: list[Resultado] = []

    manifest = plugin_dir / "plugin.json"
    if not manifest.is_file():
        res.append(Resultado(FALHA, area, f"{AGY_PLUGIN_DIR.as_posix()}/plugin.json", "ausente"))
    else:
        dados, erro = _ler_json(manifest)
        if erro or not isinstance(dados, dict) or not str(dados.get("name", "")).strip():
            res.append(Resultado(FALHA, area, f"{AGY_PLUGIN_DIR.as_posix()}/plugin.json", erro or "name ausente"))
        else:
            res.append(Resultado(OK, area, f"{AGY_PLUGIN_DIR.as_posix()}/plugin.json", f"name {dados['name']}"))

    regras = plugin_dir / "rules" / "AGENTS.md"
    if regras.is_file() and regras.read_text(encoding="utf-8", errors="replace").strip():
        res.append(Resultado(OK, area, f"{AGY_PLUGIN_DIR.as_posix()}/rules/AGENTS.md", "existe"))
    else:
        res.append(Resultado(FALHA, area, f"{AGY_PLUGIN_DIR.as_posix()}/rules/AGENTS.md", "ausente ou vazio"))

    agents_dir = plugin_dir / "agents"
    if not agents_dir.is_dir():
        res.append(Resultado(FALHA, area, f"{AGY_PLUGIN_DIR.as_posix()}/agents", "pasta ausente"))
    else:
        claude_dir = raiz / ".claude" / "agents"
        claude_agentes = {p.stem for p in claude_dir.glob("*.md")} if claude_dir.is_dir() else set()
        for nome in sorted(set(AGENTES_CENTRAIS) | claude_agentes):
            if not (agents_dir / f"{nome}.md").is_file():
                res.append(Resultado(FALHA, area, f"{AGY_PLUGIN_DIR.as_posix()}/agents/{nome}.md", "agente ausente no plugin Antigravity"))
        for arq in sorted(agents_dir.glob("*.md")):
            item = f"{AGY_PLUGIN_DIR.as_posix()}/agents/{arq.name}"
            fm = ler_frontmatter(arq)
            if fm is None:
                res.append(Resultado(FALHA, area, item, "frontmatter ausente ou sem fechamento"))
                continue
            problemas: list[str] = []
            nome = _valor(fm, "name")
            if not nome:
                problemas.append("falta name")
            elif nome != arq.stem:
                problemas.append(f"name '{nome}' difere do arquivo")
            if not _valor(fm, "description"):
                problemas.append("falta description")
            if _valor(fm, "subagent").lower() != "true":
                problemas.append("subagent deve ser true")
            if _valor(fm, "mainAgent").lower() != "false":
                problemas.append("mainAgent deve ser false")
            tools = _tools_lista(fm["tools"]) if "tools" in fm else []
            if not tools:
                problemas.append("falta tools")
            elif any(t.split("(")[0].strip() in TOOLS_PROIBIDAS_AGY for t in tools):
                problemas.append("tools contem ferramenta de delegacao proibida")
            if problemas:
                res.append(Resultado(FALHA, area, item, "; ".join(problemas)))
            else:
                res.append(Resultado(OK, area, item, f"{len(tools)} tool(s)"))

    hooks_json = plugin_dir / "hooks.json"
    if not hooks_json.is_file():
        res.append(Resultado(FALHA, area, f"{AGY_PLUGIN_DIR.as_posix()}/hooks.json", "ausente"))
    else:
        dados_hooks, erro_hooks = _ler_json(hooks_json)
        if erro_hooks or not isinstance(dados_hooks, dict):
            res.append(Resultado(FALHA, area, f"{AGY_PLUGIN_DIR.as_posix()}/hooks.json", erro_hooks or "raiz nao e objeto"))
        else:
            vistos: set[str] = set()
            for cmd in _comandos_de_hooks(dados_hooks):
                for rel in scripts_citados(cmd):
                    if rel in vistos:
                        continue
                    vistos.add(rel)
                    if (plugin_dir / rel).is_file():
                        res.append(Resultado(OK, area, f"{AGY_PLUGIN_DIR.as_posix()}/{rel}", "script existe"))
                    else:
                        res.append(Resultado(FALHA, area, f"{AGY_PLUGIN_DIR.as_posix()}/{rel}", "script citado no hook nao existe"))
            if not vistos:
                res.append(Resultado(FALHA, area, f"{AGY_PLUGIN_DIR.as_posix()}/hooks.json", "nenhum script de hook citado"))

    return res


# ------------------------------------------------------------------ geral

def conferir_tudo(raiz: Path, instalado: bool = False) -> list[Resultado]:
    res = checar_skills(raiz, instalado=instalado)
    res += checar_agentes(raiz)
    res += checar_plugin_antigravity(raiz)
    if instalado:
        res += checar_plugins(raiz)
    res += checar_mcp(raiz)
    res += checar_hooks(raiz)
    res += checar_instrucoes(raiz)
    return res


def formatar(resultados: list[Resultado]) -> str:
    linhas = []
    for r in resultados:
        linhas.append(
            f"{r.status:<15} {r.area:<15} {mascarar(r.item):<52} {mascarar(r.motivo)}".rstrip()
        )
    contagem = {s: sum(1 for r in resultados if r.status == s) for s in (OK, FALHA, AVISO, NAO_VERIFICADO)}
    linhas.append("")
    linhas.append("Resumo: " + ", ".join(f"{n} {s}" for s, n in contagem.items()))
    return "\n".join(linhas)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--instalado", action="store_true",
                    help="confere tambem as copias em %%USERPROFILE%% e os plugins do Claude Code")
    ap.add_argument("--raiz", type=Path, default=None, help="raiz do repositorio (padrao: a deste script)")
    args = ap.parse_args(argv)
    for fluxo in (sys.stdout, sys.stderr):
        try:
            fluxo.reconfigure(errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass
    try:
        resultados = conferir_tudo(args.raiz or raiz_do_repo(), instalado=args.instalado)
        print(formatar(resultados))
    except Exception as erro:  # erro inesperado: sem traceback com caminho do perfil
        print(mascarar(f"ERRO inesperado: {type(erro).__name__}: {erro}"), file=sys.stderr)
        return 1
    return 1 if any(r.status == FALHA for r in resultados) else 0


if __name__ == "__main__":
    sys.exit(main())
