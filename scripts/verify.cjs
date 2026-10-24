#!/usr/bin/env node
// Verificação única do projeto: executa as mesmas checagens do CI (job "verify").
// Uso: npm run verify   (ou: node scripts/verify.cjs)
// O Python usado é, nesta ordem: $PYTHON, .venv do projeto (ou do checkout principal, em worktrees) ou "python" do PATH.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");

// Em um git worktree recém-criado não há .venv nem node_modules; nesse caso usa os do checkout
// principal (pai do diretório .git comum). Não procura fora do repositório principal.
function mainCheckoutRoot() {
  const result = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) return null;
  const commonDir = result.stdout.trim();
  if (!commonDir || path.basename(commonDir) !== ".git") return null;
  const mainRoot = path.resolve(commonDir, "..");
  return mainRoot === ROOT ? null : mainRoot;
}

// Primeiro candidato existente em ROOT; senão, o equivalente no checkout principal.
function findInRootOrMain(relativeCandidates) {
  const roots = [ROOT];
  const mainRoot = mainCheckoutRoot();
  if (mainRoot) roots.push(mainRoot);
  for (const root of roots) {
    for (const relative of relativeCandidates) {
      const candidate = path.join(root, ...relative);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function resolvePython() {
  if (process.env.PYTHON) return process.env.PYTHON;
  return (
    findInRootOrMain([
      [".venv", "Scripts", "python.exe"],
      [".venv", "bin", "python"],
    ]) || "python"
  );
}

function resolveTsc() {
  return (
    findInRootOrMain([["node_modules", "typescript", "bin", "tsc"]]) ||
    path.join(ROOT, "node_modules", "typescript", "bin", "tsc")
  );
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
  "core",
  "main.py",
  "domains",
  "routers",
  "security",
  "scripts",
  "tests/support/serve_ui_motion_preview.py",
];

// Todos os módulos da aplicação; scripts de manutenção mantêm a cobertura anterior.
const MYPY_TARGETS = [
  "core",
  "domains",
  "routers",
  "security",
  "main.py",
  "scripts/migrate_local_data.py",
  "scripts/cleanup_local_temps.py",
  "scripts/check_update.py",
];

// Pacotes que já exigem anotações em todas as funções (--disallow-untyped-defs).
const MYPY_STRICT_TARGETS = ["core", "domains", "security"];

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
    {
      name: "Tipos JavaScript (TypeScript gradual)",
      command: process.execPath,
      args: [resolveTsc(), "--project", "tsconfig.ui.json"],
    },
    { name: "Sintaxe Python (compileall)", command: python, args: ["-m", "compileall", "-q", ...PYTHON_COMPILE_TARGETS] },
    {
      name: "Tipos (mypy gradual)",
      command: python,
      args: [
        "-m", "mypy", "--cache-dir", "TEMP/.mypy_cache", "--explicit-package-bases", "--platform", "win32",
        "--ignore-missing-imports", "--check-untyped-defs", ...MYPY_TARGETS,
      ],
    },
    {
      name: "Tipos (mypy estrito: core, domains e security)",
      command: python,
      args: [
        "-m", "mypy", "--cache-dir", "TEMP/.mypy_cache", "--explicit-package-bases", "--platform", "win32",
        "--ignore-missing-imports", "--check-untyped-defs", "--disallow-untyped-defs",
        ...MYPY_STRICT_TARGETS,
      ],
    },
    { name: "Credenciais em arquivos versionados", command: python, args: ["-B", "scripts/check_secrets.py"] },
  ];
}

function main() {
  const tempRoot = path.join(ROOT, "TEMP");
  fs.mkdirSync(tempRoot, { recursive: true });
  if (!fs.statSync(tempRoot).isDirectory() || path.relative(tempRoot, fs.realpathSync(tempRoot))) {
    console.error("A pasta TEMP do projeto não pode ser um link ou junção.");
    return 1;
  }
  process.env.PYTHONPYCACHEPREFIX = path.join(tempRoot, "__pycache__");
  const python = resolvePython();
  console.log(`Python: ${python}`);
  console.log(`tsc: ${resolveTsc()}`);
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

module.exports = { buildSteps, javascriptFilesToCheck, listFiles, resolvePython, resolveTsc };
