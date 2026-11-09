#!/usr/bin/env node
// Hook PreToolUse (Edit/Write/MultiEdit/NotebookEdit): impede edição direta de planilhas,
// históricos, anotações e backups operacionais. Esses arquivos mudam só pelos fluxos da aplicação.
// Saída 2 bloqueia a ferramenta e devolve a mensagem de stderr ao agente.
"use strict";

const path = require("node:path");

const SPREADSHEET_EXTENSIONS = new Set([".xlsx", ".xls", ".xlsm", ".csv", ".tsv", ".zip"]);
const ALLOWED_STATE_FILES = new Set([".gitkeep", "readme.md"]);

// Converte caminhos do Git Bash (/c/Users/...) para o formato do Windows (C:/Users/...).
function fromPosixDrive(value) {
  if (process.platform !== "win32") return value;
  return String(value).replace(/^\/([a-zA-Z])(?=\/|$)/, (_, drive) => `${drive.toUpperCase()}:`);
}

function relativeToProject(filePath, projectDir) {
  const root = path.resolve(fromPosixDrive(projectDir));
  const relative = path.relative(root, path.resolve(root, fromPosixDrive(filePath)));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/").toLowerCase();
}

// Em worktree (<principal>/.claude/worktrees/<nome>), devolve a raiz do checkout principal.
function mainCheckoutRoot(projectDir) {
  const root = path.resolve(fromPosixDrive(projectDir));
  const match = root.split(path.sep).join("/").match(/^(.*?)\/\.claude\/worktrees\/[^/]+(?:\/|$)/i);
  return match ? path.resolve(match[1]) : null;
}

function reasonForRelative(relative) {
  const name = path.posix.basename(relative);
  if (relative.startsWith("data/state/")) {
    return ALLOWED_STATE_FILES.has(name) ? null : "históricos, anotações e filas em data/state";
  }
  if (relative.startsWith(".transactions/")) return "transações pendentes em .transactions";
  for (const root of ["data/planilhas_entrada/", "planilhas_entrada/"]) {
    if (!relative.startsWith(root)) continue;
    if (relative.startsWith(`${root}_backups/`)) return "backups de planilhas";
    if (SPREADSHEET_EXTENSIONS.has(path.posix.extname(relative))) return "planilhas operacionais";
  }
  return null;
}

// Retorna o motivo do bloqueio ou null quando a edição é permitida.
// Vale para o projeto atual e, em worktree, também para o checkout principal (onde ficam os dados reais).
function blockReason(filePath, projectDir) {
  const roots = [projectDir];
  const main = mainCheckoutRoot(projectDir);
  if (main) roots.push(main);
  for (const root of roots) {
    const relative = relativeToProject(filePath, root);
    if (relative) return reasonForRelative(relative);
  }
  return null;
}

function main() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    let payload;
    try {
      payload = JSON.parse(raw || "{}");
    } catch {
      process.exit(0); // Entrada inesperada: não bloqueia o trabalho.
    }
    const input = payload.tool_input || {};
    const filePath = input.file_path || input.notebook_path;
    if (!filePath) process.exit(0);
    const projectDir = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();
    const reason = blockReason(filePath, projectDir);
    if (!reason) process.exit(0);
    process.stderr.write(
      `Edição bloqueada: ${filePath} faz parte de ${reason}. ` +
      "Esses dados operacionais só mudam pelos fluxos da aplicação (importação, atualização, restauração). " +
      "Se a alteração for realmente necessária, peça autorização explícita ao usuário.\n",
    );
    process.exit(2);
  });
}

if (require.main === module) main();

module.exports = { blockReason };
