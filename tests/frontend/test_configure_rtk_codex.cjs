"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildConfigEdits, findRtkHook, updateInstructions } = require("../../scripts/configure_rtk_codex.cjs");

const DATA = "C:\\Users\\Example\\AppData\\Local\\rtk";
const FILE = "C:\\Users\\Example\\.codex\\hooks.json";
const CLAUDE = "C:\\Users\\Example\\.claude";
const hook = {
  key: `${FILE}:pre_tool_use:0:0`, eventName: "preToolUse", matcher: "Bash",
  handlerType: "command", command: "rtk hook codex", sourcePath: FILE,
  enabled: true, isManaged: false, trustStatus: "untrusted", currentHash: `sha256:${"a".repeat(64)}`,
};

test("configura somente o hash do RTK revisado e preserva as demais raízes", () => {
  const config = { sandbox_workspace_write: { writable_roots: ["C:\\Other"] }, hooks: { state: { other: { trusted_hash: "keep" } } } };
  const before = JSON.stringify(config);
  const edits = buildConfigEdits(config, hook, DATA, CLAUDE);
  assert.deepEqual(edits.map((edit) => edit.keyPath), [
    "features.hooks", "sandbox_workspace_write.writable_roots",
    "shell_environment_policy.set.CLAUDE_CONFIG_DIR",
    `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`,
  ]);
  assert.deepEqual(edits[1].value, ["C:\\Other", DATA]);
  assert.equal(edits[2].value, CLAUDE);
  assert.equal(edits[3].value, hook.currentHash);
  assert.equal(JSON.stringify(config), before);
});

test("configuração completa é idempotente e não duplica caminhos com outra capitalização", () => {
  const config = { features: { hooks: true }, shell_environment_policy: { set: { CLAUDE_CONFIG_DIR: "C:\\CustomClaude" } }, sandbox_workspace_write: { writable_roots: [DATA.toLowerCase().replace(/\\/g, "/") + "/"] } };
  assert.deepEqual(buildConfigEdits(config, { ...hook, trustStatus: "trusted" }, DATA, CLAUDE), []);
});

test("hook alterado exige o novo hash exato informado pelo Codex", () => {
  const config = { features: { hooks: true }, shell_environment_policy: { set: { CLAUDE_CONFIG_DIR: CLAUDE } }, sandbox_workspace_write: { writable_roots: [DATA] } };
  const edits = buildConfigEdits(config, { ...hook, trustStatus: "modified" }, DATA, CLAUDE);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].value, hook.currentHash);
  assert.throws(() => buildConfigEdits({}, { ...hook, currentHash: "invalid" }, DATA), /não pode ser aprovada/);
});

test("recusa configurações inválidas e hook desabilitado", () => {
  assert.throws(() => buildConfigEdits({ sandbox_workspace_write: { writable_roots: "invalid" } }, hook, DATA), /deve ser uma lista/);
  assert.throws(() => buildConfigEdits({}, { ...hook, enabled: false }, DATA), /desabilitado/);
});

test("seleciona exclusivamente o comando global esperado", () => {
  const response = { data: [{ hooks: [
    { ...hook, sourcePath: "C:\\project\\.codex\\hooks.json" },
    { ...hook, command: "rtk hook codex && other-command" }, hook,
  ] }] };
  assert.equal(findRtkHook(response, FILE), hook);
  assert.throws(() => findRtkHook({ data: [{ hooks: [] }] }, FILE), /encontrados 0/);
  assert.throws(() => findRtkHook({ data: [{ hooks: [hook, hook] }] }, FILE), /encontrados 2/);
});

test("instruções globais preservam conteúdo existente e cobrem functions.exec", () => {
  const original = "# Regras pessoais\r\n\r\nPreserve minhas regras.\r\n";
  const updated = updateInstructions(original);
  assert.ok(updated.startsWith(original));
  assert.match(updated, /tools\.exec_command dentro de functions\.exec/);
  assert.match(updated, /sem esperar que o usuário peça/);
  assert.equal(updateInstructions(updated), updated);
});

test("recusa blocos de instruções duplicados ou incompletos", () => {
  const updated = updateInstructions("");
  assert.throws(() => updateInstructions(updated + updated), /duplicado ou incompleto/);
  assert.throws(() => updateInstructions("<!-- simpress-rtk-codex:start -->"), /duplicado ou incompleto/);
});
