"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { blockReason } = require("../../.claude/hooks/protect-operational-data.cjs");

const MAIN = path.resolve("C:/repo/Simpress");
const WORKTREE = path.join(MAIN, ".claude", "worktrees", "feature-x");

test("worktree: bloqueia dados do próprio worktree", () => {
  assert.ok(blockReason(path.join(WORKTREE, "data", "state", "x.json"), WORKTREE));
});

test("worktree: bloqueia dados do checkout principal", () => {
  for (const rel of ["data/state/x.json", ".transactions/a.json", "data/planilhas_entrada/a.xlsx"]) {
    assert.ok(blockReason(path.join(MAIN, rel), WORKTREE), rel);
  }
});

test("worktree: aceita barras invertidas e maiúsculas do Windows", () => {
  assert.ok(blockReason("C:\\REPO\\simpress\\DATA\\State\\x.json", WORKTREE));
});

test("worktree: código comum e .gitkeep seguem liberados", () => {
  assert.equal(blockReason(path.join(WORKTREE, "static", "js", "x.js"), WORKTREE), null);
  assert.equal(blockReason(path.join(MAIN, "static", "js", "x.js"), WORKTREE), null);
  assert.equal(blockReason(path.join(MAIN, "data", "state", ".gitkeep"), WORKTREE), null);
});

test("checkout principal sem worktree: continua bloqueando só o próprio projeto", () => {
  assert.ok(blockReason(path.join(MAIN, "data", "state", "x.json"), MAIN));
  assert.equal(blockReason(path.join(MAIN, "static", "js", "x.js"), MAIN), null);
});
