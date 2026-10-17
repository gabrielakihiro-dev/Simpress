const assert = require("node:assert/strict");
const test = require("node:test");
const { buildSteps, javascriptFilesToCheck, listFiles } = require("../../scripts/verify.cjs");

test("verification discovers recent-equipment tests and all five previously omitted modules", () => {
  const steps = buildSteps("python");
  const typecheckStep = steps.find(step => step.name === "Tipos JavaScript (TypeScript gradual)");
  assert.ok(typecheckStep?.args?.includes("tsconfig.ui.json"));
  const testStep = steps.find(step => step.args?.includes("--test"));
  assert.ok(testStep.args.includes("tests/frontend/test_recent_equipment.cjs"));
  const checked = javascriptFilesToCheck();
  for (const file of [
    "shared/recent-equipment.js", "shared/theme-preference.js",
    "ui/data-panels.js", "ui/transfer-history.js", "ui/ux-enhancements.js",
  ]) assert.ok(checked.includes(`static/js/${file}`), file);
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
