// Garante que cada spec de tests/e2e roda em exatamente um grupo do workflow ui-browser.
// O workflow não usa `--shard`: cada parte da matrix traz a própria lista em `specs:`.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "ui-browser.yml");
const E2E_DIR = path.join(ROOT, "tests", "e2e");

// Lê só os blocos `specs: >-` (linhas mais indentadas que a chave), ignorando comentários.
function groupsFromWorkflow() {
  const lines = fs.readFileSync(WORKFLOW, "utf8").split(/\r?\n/);
  const groups = [];
  for (let i = 0; i < lines.length; i += 1) {
    const key = lines[i].match(/^(\s*)specs:\s*>-?\s*$/);
    if (!key) continue;
    const names = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const indent = lines[j].match(/^(\s*)\S/);
      if (!indent || indent[1].length <= key[1].length) break;
      names.push(...lines[j].trim().split(/\s+/));
    }
    groups.push(names);
  }
  return groups;
}

// Recursivo como o testDir do Playwright: spec em subpasta não cabe nos grupos e precisa falhar aqui.
const onDisk = fs.readdirSync(E2E_DIR, { recursive: true }).filter((name) => name.endsWith(".spec.cjs")).sort();
const groups = groupsFromWorkflow();
const listed = groups.flat();

test("ui-browser tem 10 grupos de specs", () => {
  assert.equal(groups.length, 10);
  groups.forEach((names, index) => assert.ok(names.length > 0, `grupo ${index + 1} está vazio`));
});

test("todo spec de tests/e2e está em um grupo do ui-browser.yml", () => {
  const nested = onDisk.filter((name) => /[\/]/.test(name));
  assert.deepEqual(nested, [], `Spec em subpasta de tests/e2e: ${nested.join(", ")}. Mova-o para tests/e2e/.`);
  const missing = onDisk.filter((name) => !listed.includes(name));
  assert.deepEqual(
    missing,
    [],
    `Spec fora de .github/workflows/ui-browser.yml (matrix.include[].specs): ${missing.join(", ")}. Some-o ao grupo de menor soma.`,
  );
});

test("nenhum spec do ui-browser.yml está repetido ou não existe mais", () => {
  const repeated = listed.filter((name, index) => listed.indexOf(name) !== index);
  assert.deepEqual(repeated, [], `Spec em mais de um grupo: ${repeated.join(", ")}`);
  const gone = listed.filter((name) => !onDisk.includes(name));
  assert.deepEqual(gone, [], `Spec listado que não existe em tests/e2e: ${gone.join(", ")}`);
});

test("o filtro do Playwright (regex sem âncora, sem diferenciar maiúsculas) de cada nome acerta só o próprio arquivo", () => {
  for (const name of listed) {
    const hits = onDisk.filter((file) => new RegExp(name, "i").test(file));
    assert.deepEqual(hits, [name], `O nome ${name} também casa com: ${hits.join(", ")}`);
  }
});
