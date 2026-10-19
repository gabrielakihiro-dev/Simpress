#!/usr/bin/env node
// Hook PostToolUse (Edit/Write/MultiEdit): roda `node --check` no arquivo JavaScript editado.
// Saída 2 devolve o erro de sintaxe ao agente para que ele corrija na mesma rodada.
"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const JS_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    process.exit(0);
  }
  const filePath = (payload.tool_input || {}).file_path;
  if (!filePath || !JS_EXTENSIONS.has(path.extname(filePath).toLowerCase())) process.exit(0);
  const normalized = filePath.split(path.sep).join("/");
  if (normalized.includes("/node_modules/") || normalized.includes("/static/vendor/")) process.exit(0);

  // Converte caminhos do Git Bash (/c/Users/...) para o formato do Windows.
  const fromPosixDrive = (value) => process.platform === "win32"
    ? String(value).replace(/^\/([a-zA-Z])(?=\/|$)/, (_, drive) => `${drive.toUpperCase()}:`)
    : value;
  const projectDir = fromPosixDrive(process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd());
  const target = path.resolve(projectDir, fromPosixDrive(filePath));
  const result = spawnSync(process.execPath, ["--check", target], { encoding: "utf8" });
  if (result.status === 0) process.exit(0);
  process.stderr.write(`node --check falhou em ${filePath}:\n${result.stderr || result.stdout}`);
  process.exit(2);
});
