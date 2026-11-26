"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HOOKS_DIR = path.resolve(__dirname, "..", "..", ".agents", "plugins", "simpress-maestro", "hooks");
const SESSION_HOOK = path.join(HOOKS_DIR, "session-start-maestro.cjs");
const PROTECT_HOOK = path.join(HOOKS_DIR, "protect-operational-data.cjs");
const { buildOutput } = require(SESSION_HOOK);
const { evaluatePayload } = require(PROTECT_HOOK);

describe("session-start-maestro hook", () => {
  it("injeta orientacao AI Pro com Hydrogen, Neon e Carbon, sem Flash nem 3.1 Pro", () => {
    const out = buildOutput();
    const msg = out.injectSteps?.[0]?.systemMessage?.systemMessage || "";
    for (const token of ["AI Pro", "Hydrogen", "Neon", "Carbon", "Low", "Medium", "High", "xHigh", "ask_question", "#PR", "#CI", "merge", "git pull", "/swarm", "swarm-simpress"]) {
      assert.ok(msg.includes(token), `Esperava encontrar '${token}' na mensagem de SessionStart`);
    }
    assert.ok(!/flash_lite|\bflash\b|3\.1\s*pro/i.test(msg), "Nao deve recomendar Flash nem 3.1 Pro");
  });

  it("responde JSON valido via stdin/stdout CLI", () => {
    const res = spawnSync(process.execPath, [SESSION_HOOK], { input: "{}", encoding: "utf8" });
    assert.equal(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    assert.ok(parsed.injectSteps?.[0]?.systemMessage?.systemMessage);
  });
});

describe("protect-operational-data Antigravity hook", () => {
  const cwd = "C:/repo/simpress";

  it("bloqueia escrita em data/state, .transactions e data/planilhas_entrada", () => {
    const blocked = [
      "data/state/historico.json",
      ".transactions/tx_01.json",
      "data/planilhas_entrada/EquipamentosDetalhes_atual.xlsx",
      "data/planilhas_entrada/_backups/backup.xlsx",
      "planilhas_entrada/export.csv",
    ];
    for (const target of blocked) {
      const res = evaluatePayload({ cwd, toolCall: { args: { Path: target } } });
      assert.equal(res.decision, "deny", `Deveria bloquear ${target}`);
      assert.ok(res.reason && res.reason.length > 0);
    }
  });

  it("aceita chaves alternativas de caminho (AbsolutePath, filePath)", () => {
    assert.equal(evaluatePayload({ cwd, toolCall: { args: { AbsolutePath: "data/state/x.json" } } }).decision, "deny");
    assert.equal(evaluatePayload({ cwd, toolCall: { args: { filePath: ".transactions/x.json" } } }).decision, "deny");
  });

  it("bloqueia caminho absoluto no checkout principal quando executado em worktree Antigravity separado", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-wt-test-"));
    try {
      const mainRoot = path.join(tmp, "OneDrive", "Simpress");
      const wtRoot = path.join(tmp, ".gemini", "antigravity", "worktrees", "Simpress", "branch_x");
      fs.mkdirSync(path.join(mainRoot, ".git", "worktrees", "branch_x"), { recursive: true });
      fs.mkdirSync(wtRoot, { recursive: true });
      fs.writeFileSync(
        path.join(wtRoot, ".git"),
        `gitdir: ${path.join(mainRoot, ".git", "worktrees", "branch_x")}\n`,
        "utf8",
      );
      const res = evaluatePayload({
        cwd: wtRoot,
        toolCall: { args: { Path: path.join(mainRoot, "data", "state", "historico.json") } },
      });
      assert.equal(res.decision, "deny");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("permite arquivos permitidos em data/state e arquivos de codigo", () => {
    const allowed = [
      "data/state/.gitkeep",
      "data/state/README.md",
      "domains/regras_negocio.py",
      "frontend/src/App.tsx",
    ];
    for (const target of allowed) {
      const res = evaluatePayload({ cwd, toolCall: { args: { Path: target } } });
      assert.equal(res.decision, "allow", `Deveria permitir ${target}`);
    }
  });

  it("responde JSON valido via stdin/stdout CLI inclusive para JSON invalido", () => {
    const deny = spawnSync(process.execPath, [PROTECT_HOOK], {
      input: JSON.stringify({ cwd, toolCall: { args: { Path: "data/state/a.json" } } }),
      encoding: "utf8",
    });
    assert.equal(deny.status, 0);
    assert.equal(JSON.parse(deny.stdout).decision, "deny");

    const malformed = spawnSync(process.execPath, [PROTECT_HOOK], { input: "{bad", encoding: "utf8" });
    assert.equal(malformed.status, 0);
    assert.equal(JSON.parse(malformed.stdout).decision, "allow");
  });
});
