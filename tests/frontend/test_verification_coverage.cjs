const assert = require("node:assert/strict");
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
  for (const file of [
    "shared/recent-equipment.js", "ui/data-panels.js", "ui/transfer-history.js", "ui/ux-enhancements.js",
    "app-entry.js", "app.js",
  ]) assert.ok(checked.includes(`frontend/src/legado/${file}`), file);
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
