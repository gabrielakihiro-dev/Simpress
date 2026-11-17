const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { buildSteps, javascriptFilesToCheck, listFiles, resolveVite } = require("../../scripts/verify.cjs");

test("verification discovers recent-equipment tests and all five previously omitted modules", () => {
  const steps = buildSteps("python");
  const typecheckStep = steps.find(step => step.name === "Tipos JavaScript (TypeScript gradual)");
  assert.ok(typecheckStep?.args?.includes("tsconfig.ui.json"));
  const testStep = steps.find(step => step.args?.includes("--test"));
  assert.ok(testStep.args.includes("tests/frontend/test_recent_equipment.cjs"));
  const checked = javascriptFilesToCheck();
  assert.ok(checked.includes("static/js/shared/theme-preference.js"));
  // frontend/src/legado/ foi portado para TypeScript: nenhum .js dele resta para o node --check e o tsc estrito (abaixo) cobre os .ts.
  assert.ok(!checked.some(file => file.startsWith("frontend/src/legado")));
  for (const file of [
    "ui/ux-enhancements.ts", "ui/action-dispatcher.ts", "ui/ck-cockpit-visual.ts", "ui/cromo-marca.ts",
    "arranque/entrada.ts", "aplicacao/app.ts",
  ]) assert.ok(fs.existsSync(path.join(__dirname, "..", "..", "frontend", "src", file)), file);
  // recent-equipment virou TypeScript: o tsc estrito (tsconfig.json inclui frontend/src) o cobre no lugar do node --check.
  assert.ok(fs.existsSync(path.join(__dirname, "..", "..", "frontend", "src", "comum", "recent-equipment.ts")));
  assert.ok(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "tsconfig.json"), "utf8")).include.includes("frontend/src"));
});

test("compileall and gradual mypy cover every Python application module", () => {
  const steps = buildSteps("python");
  const compile = steps.find(step => step.args?.includes("compileall")).args;
  const mypy = steps.find(step => step.args?.includes("mypy")).args;
  assert.ok(mypy.includes("--check-untyped-defs"));
  for (const directory of ["core", "domains", "routers", "security"]) {
    for (const module of listFiles(directory, ".py", { recursive: true })) {
      assert.ok(compile.some(target => target === module || module.startsWith(`${target}/`)), module);
      assert.ok(mypy.some(target => target === module || module.startsWith(`${target}/`)), module);
    }
  }
  assert.ok(compile.includes("main.py"));
  assert.ok(mypy.includes("main.py"));
});

test("verification type-checks frontend/src and checks the committed React bundle", () => {
  const steps = buildSteps("python");
  assert.ok(steps.find(step => step.name === "Tipos TypeScript (frontend/src, strict)")?.args?.includes("tsconfig.json"));
  assert.equal(typeof steps.find(step => step.name === "Bundle React atualizado (static/dist)")?.run, "function");
  // Worktrees sem node_modules usam o vite do checkout principal, como o tsc.
  assert.match(resolveVite() || "", /node_modules[\\/]vite[\\/]bin[\\/]vite\.js$/);
  assert.ok(!javascriptFilesToCheck().some(file => file.startsWith("static/dist/")));
});
