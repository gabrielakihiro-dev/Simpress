#!/usr/bin/env node
// Verificação única do projeto: executa as mesmas checagens do CI (job "verify").
// Uso: npm run verify   (ou: node scripts/verify.cjs)
// O Python usado é, nesta ordem: $PYTHON, .venv do projeto ou "python" do PATH.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");

function resolvePython() {
  if (process.env.PYTHON) return process.env.PYTHON;
  const candidates = [
    path.join(ROOT, ".venv", "Scripts", "python.exe"),
    path.join(ROOT, ".venv", "bin", "python"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "python";
}

// Lista arquivos com a extensão indicada, em ordem estável, ignorando as pastas excluídas.
function listFiles(relativeDir, extension, { recursive = false, prefix = "", exclude = [] } = {}) {
  const results = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const relative = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive && !exclude.includes(relative)) walk(relative);
      } else if (entry.name.endsWith(extension) && entry.name.startsWith(prefix)) {
        results.push(relative);
      }
    }
  };
  walk(relativeDir);
  return results.sort();
}

const PYTHON_COMPILE_TARGETS = [
  "core/config.py",
  "main.py",
  "core/integrity.py",
  "core/openpyxl_compat.py",
  "core/xlsx_safety.py",
  "core/logging_setup.py",
  "domains",
  "routers",
  "security",
  "scripts",
  "tests/support/serve_ui_motion_preview.py",
];

// Escopo gradual de tipos: amplie esta lista conforme os módulos forem tipados.
const MYPY_TARGETS = [
  "core/config.py",
  "main.py",
  "core/integrity.py",
  "core/logging_setup.py",
  "core/openpyxl_compat.py",
  "core/xlsx_safety.py",
  "domains/history_export.py",
  "domains/history_restore.py",
  "domains/inventory_comparison.py",
  "domains/inventory_update.py",
  "domains/equipment_search.py",
  "domains/effective_alias.py",
  "domains/uploaded_workbooks.py",
  "domains/readiness.py",
  "routers/inventory_history.py",
  "routers/transfers.py",
  "routers/equipment_search.py",
  "routers/system.py",
  "routers/units.py",
  "core/inventory_requests.py",
  "security",
  "scripts/migrate_local_data.py",
  "scripts/cleanup_local_temps.py",
];

function javascriptFilesToCheck() {
  return [
    ...listFiles("static", ".js", { recursive: true, exclude: ["static/vendor"] }),
    "playwright.config.cjs",
    ...listFiles("tests/e2e", ".cjs"),
    ...listFiles("config", ".cjs"),
    ...listFiles("scripts", ".cjs", { recursive: true, exclude: ["scripts/__pycache__"] }),
    ...listFiles(".claude/hooks", ".cjs"),
  ];
}

function buildSteps(python) {
  return [
    { name: "Testes Python isolados", command: python, args: ["-B", "tests/run_tests.py"] },
    {
      name: "Testes JavaScript (node --test)",
      command: process.execPath,
      args: ["--test", ...listFiles("tests/frontend", ".cjs", { prefix: "test_" })],
    },
    {
      name: "Sintaxe JavaScript (node --check)",
      run: () => {
        const failures = javascriptFilesToCheck().filter((file) => {
          const result = spawnSync(process.execPath, ["--check", file], { cwd: ROOT, stdio: "inherit" });
          return result.status !== 0;
        });
        if (failures.length) console.error(`Falha de sintaxe em: ${failures.join(", ")}`);
        return failures.length === 0;
      },
    },
    { name: "Sintaxe Python (compileall)", command: python, args: ["-m", "compileall", "-q", ...PYTHON_COMPILE_TARGETS] },
    {
      name: "Tipos (mypy gradual)",
      command: python,
      args: [
        "-m", "mypy", "--explicit-package-bases", "--platform", "win32",
        "--ignore-missing-imports", "--check-untyped-defs", ...MYPY_TARGETS,
      ],
    },
    { name: "Credenciais em arquivos versionados", command: python, args: ["-B", "scripts/check_secrets.py"] },
  ];
}

function main() {
  const python = resolvePython();
  const summary = [];
  for (const step of buildSteps(python)) {
    console.log(`\n=== ${step.name} ===`);
    const started = Date.now();
    let ok;
    if (step.run) {
      ok = step.run();
    } else {
      const result = spawnSync(step.command, step.args, { cwd: ROOT, stdio: "inherit" });
      if (result.error) console.error(result.error.message);
      ok = result.status === 0;
    }
    summary.push({ name: step.name, ok, seconds: ((Date.now() - started) / 1000).toFixed(1) });
  }

  console.log("\n=== Resumo ===");
  for (const { name, ok, seconds } of summary) console.log(`${ok ? "OK   " : "FALHA"} ${name} (${seconds}s)`);
  process.exitCode = summary.every((step) => step.ok) ? 0 : 1;
}

if (require.main === module) main();

module.exports = { javascriptFilesToCheck, listFiles };
