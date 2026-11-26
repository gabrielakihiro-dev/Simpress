#!/usr/bin/env node
// Hook PreToolUse do Antigravity (edit_file/write_file): bloqueia edicao direta de
// planilhas, historicos, anotacoes e backups operacionais em data/state, .transactions
// e data/planilhas_entrada, inclusive no checkout principal quando rodando em worktree.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SPREADSHEET_EXTENSIONS = new Set([".xlsx", ".xls", ".xlsm", ".csv", ".tsv", ".zip"]);
const ALLOWED_STATE_FILES = new Set([".gitkeep", "readme.md"]);

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

function mainCheckoutFromGitFile(root) {
  const dotGit = path.join(root, ".git");
  try {
    if (!fs.statSync(dotGit).isFile()) return null;
    const content = fs.readFileSync(dotGit, "utf8");
    const match = content.match(/^gitdir:\s*(.+)$/im);
    if (!match) return null;
    const gitDir = path.resolve(root, fromPosixDrive(match[1].trim()));
    const normalized = gitDir.split(path.sep).join("/");
    const wtMatch = normalized.match(/^(.*?)\/\.git\/worktrees\/[^/]+(?:\/.*)?$/i);
    return wtMatch && wtMatch[1] ? path.resolve(wtMatch[1]) : null;
  } catch {
    return null;
  }
}

function mainCheckoutRoot(projectDir) {
  const root = path.resolve(fromPosixDrive(projectDir));
  const fromGit = mainCheckoutFromGitFile(root);
  if (fromGit && fromGit !== root) return fromGit;
  const normalized = root.split(path.sep).join("/");
  const claudeWt = normalized.match(/^(.*?)\/\.claude\/worktrees\/[^/]+(?:\/|$)/i);
  return claudeWt && claudeWt[1] ? path.resolve(claudeWt[1]) : null;
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

function extractFilePath(payload) {
  const args = (payload && payload.toolCall && payload.toolCall.args) || {};
  const input = (payload && payload.tool_input) || {};
  return (
    args.Path ||
    args.AbsolutePath ||
    args.TargetFile ||
    args.filePath ||
    args.targetFile ||
    args.file_path ||
    args.path ||
    input.file_path ||
    input.notebook_path ||
    input.Path ||
    input.path ||
    null
  );
}

function extractProjectDir(payload) {
  if (payload && typeof payload.cwd === "string" && payload.cwd) return payload.cwd;
  if (payload && Array.isArray(payload.workspacePaths) && payload.workspacePaths[0]) {
    return payload.workspacePaths[0];
  }
  return process.cwd();
}

function evaluatePayload(payload) {
  const filePath = extractFilePath(payload);
  if (!filePath) return { decision: "allow" };
  const reason = blockReason(filePath, extractProjectDir(payload));
  if (!reason) return { decision: "allow" };
  return {
    decision: "deny",
    reason:
      `Edição bloqueada: ${filePath} faz parte de ${reason}. ` +
      "Esses dados operacionais só mudam pelos fluxos da aplicação (importação, atualização, restauração). " +
      "Se a alteração for realmente necessária, peça autorização explícita ao usuário.",
  };
}

function main() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    let payload = {};
    try {
      payload = JSON.parse(raw || "{}");
    } catch {
      process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
      return;
    }
    process.stdout.write(JSON.stringify(evaluatePayload(payload)) + "\n");
  });
}

if (require.main === module) main();

module.exports = { blockReason, evaluatePayload, mainCheckoutRoot };
