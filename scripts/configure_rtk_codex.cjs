#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const RTK_COMMAND = "rtk hook codex";
const START = "<!-- simpress-rtk-codex:start -->";
const END = "<!-- simpress-rtk-codex:end -->";
const INSTRUCTIONS = `${START}
## RTK nos comandos do Codex

- Use automaticamente RTK nos comandos de terminal que tenham wrapper compatível, sem esperar que o usuário peça. Isso inclui PowerShell e chamadas tools.exec_command dentro de functions.exec: escreva o prefixo rtk no comando interno (por exemplo, rtk git status, rtk git diff, rtk rg e rtk pytest).
- O hook nativo cobre os caminhos de execução suportados pelo Codex. A presença do hook não comprova cobertura das chamadas via functions.exec; mantenha o prefixo explícito nessas chamadas. Não envolva comandos que já começam com rtk novamente.
- Use o comando original se RTK não estiver instalado, não houver wrapper compatível ou a saída condensada for insuficiente para decidir. Preserve exit codes, validações, permissões e as regras do projeto.
- Consulte rtk gain --project --format json para comprovar economias registradas; não interprete redução de caracteres como medição exata de tokens ou dinheiro.
${END}`;

function updateInstructions(current) {
  const start = current.indexOf(START);
  const end = current.indexOf(END);
  if (start < 0 && end < 0) return current + (current.endsWith("\n") ? "\n" : "\n\n") + INSTRUCTIONS + "\n";
  if (start < 0 || end < start || current.indexOf(START, start + START.length) >= 0 ||
      current.indexOf(END, end + END.length) >= 0) {
    throw new Error("Bloco global RTK duplicado ou incompleto; instruções preservadas.");
  }
  return current.slice(0, start) + INSTRUCTIONS + current.slice(end + END.length);
}

function codexExecutable() {
  if (process.env.CODEX_CLI_PATH && fs.existsSync(process.env.CODEX_CLI_PATH)) {
    return { command: process.env.CODEX_CLI_PATH, args: [] };
  }
  if (process.platform !== "win32") return { command: "codex", args: [] };
  const found = spawnSync("where.exe", ["codex.cmd"], { encoding: "utf8", windowsHide: true });
  for (const shim of (found.stdout || "").trim().split(/\r?\n/)) {
    const entry = path.join(path.dirname(shim), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (fs.existsSync(entry)) return { command: process.execPath, args: [entry] };
  }
  throw new Error("Codex não encontrado. Instale o CLI ou execute este configurador pelo app Codex.");
}

// Use the installed Codex API so TOML comments, unrelated settings and hook hashes
// are handled by Codex itself. This client never starts an agent or model turn.
class CodexClient {
  constructor(cwd = ROOT) {
    const executable = codexExecutable();
    this.nextId = 0;
    this.pending = new Map();
    this.stderr = "";
    this.process = spawn(executable.command, [
      ...executable.args, "-c", 'sandbox_mode="workspace-write"', "app-server", "--stdio",
    ], { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.lines = readline.createInterface({ input: this.process.stdout });
    this.lines.on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.process.stderr.on("data", (data) => { this.stderr = (this.stderr + data).slice(-4000); });
    const fail = (error) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    };
    this.process.on("error", fail);
    this.process.on("exit", (code) => fail(new Error(`Codex encerrou (${code}). ${this.stderr}`)));
  }

  request(method, params, timeoutMs = 30000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Tempo esgotado em ${method}. ${this.stderr}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "simpress_rtk_setup", version: "1.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.process.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  }

  close() {
    this.lines.close();
    this.process.stdin.end();
    this.process.kill();
  }
}

function samePath(left, right) {
  const normalize = (value) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}

function findRtkHook(response, hookFile) {
  const matches = response.data.flatMap((entry) => entry.hooks).filter((hook) =>
    hook.eventName === "preToolUse" && hook.matcher === "Bash" &&
    hook.handlerType === "command" && hook.command === RTK_COMMAND &&
    samePath(hook.sourcePath, hookFile),
  );
  if (matches.length !== 1) {
    throw new Error(`Esperado um único hook global '${RTK_COMMAND}'; encontrados ${matches.length}.`);
  }
  return matches[0];
}

function buildConfigEdits(config, hook, dataRoot, claudeConfigDir) {
  const edits = [];
  const add = (keyPath, value) => edits.push({ keyPath, value, mergeStrategy: "replace" });
  if (config.features?.hooks !== true) add("features.hooks", true);
  const roots = config.sandbox_workspace_write?.writable_roots || [];
  if (!Array.isArray(roots)) throw new Error("writable_roots deve ser uma lista; configuração preservada.");
  if (!roots.some((root) => samePath(root, dataRoot))) {
    add("sandbox_workspace_write.writable_roots", [...roots, dataRoot]);
  }
  // The legacy Windows sandbox user may have no registered home folder.
  // RTK also resolves its Claude directory in Codex mode; preserve custom paths.
  if (config.shell_environment_policy?.set?.CLAUDE_CONFIG_DIR === undefined) {
    add("shell_environment_policy.set.CLAUDE_CONFIG_DIR", claudeConfigDir);
  }
  if (!hook.enabled) throw new Error("O hook RTK está desabilitado; revise sua definição em /hooks.");
  if (hook.trustStatus !== "trusted") {
    if (hook.isManaged || !/^sha256:[a-f0-9]{64}$/.test(hook.currentHash)) {
      throw new Error("Definição do hook RTK não pode ser aprovada por este configurador.");
    }
    add(`hooks.state.${JSON.stringify(hook.key)}.trusted_hash`, hook.currentHash);
  }
  return edits;
}

function runRtk(args, input) {
  const result = spawnSync("rtk", args, { cwd: ROOT, encoding: "utf8", input, windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr || `rtk ${args.join(" ")} falhou.`);
  }
  return result.stdout;
}

async function sandboxCommand(client, command) {
  const result = await client.request("command/exec", {
    command: ["powershell.exe", "-NoLogo", "-NoProfile", "-Command", command],
    cwd: ROOT, timeoutMs: 30000,
  }, 45000);
  if (result.exitCode !== 0) throw new Error(`Falha no sandbox: ${result.stderr}`);
  return result.stdout;
}

async function testRuntime(client) {
  const gain = async () => JSON.parse(await sandboxCommand(client, "rtk gain --project --format json")).summary;
  let previous = await gain();
  for (const [name, command] of [["curto", "git status --short --branch"], ["longo", 'rg -n "." AGENTS.md']]) {
    const response = JSON.parse(runRtk(["hook", "codex"], JSON.stringify({
      hook_event_name: "PreToolUse", tool_name: "Bash", permission_mode: "default",
      tool_input: { command }, cwd: ROOT, session_id: "simpress-rtk-test",
    })));
    const output = response.hookSpecificOutput;
    if (output?.permissionDecision !== "allow" || output.updatedInput?.command !== `rtk ${command}`) {
      throw new Error(`O hook não reescreveu o comando ${name} corretamente.`);
    }
    const text = await sandboxCommand(client, output.updatedInput.command);
    if (!text.trim()) throw new Error(`Saída vazia no teste ${name}.`);
    const next = await gain();
    const input = next.total_input - previous.total_input;
    const filtered = next.total_output - previous.total_output;
    const saved = next.total_saved - previous.total_saved;
    if (next.total_commands !== previous.total_commands + 1 || input <= 0 || filtered <= 0 ||
        (name === "longo" && saved <= 0)) throw new Error(`Métricas não persistiram corretamente no teste ${name}.`);
    console.log(JSON.stringify({ teste: name, entrada: input, saida: filtered, economia: saved }));
    previous = next;
  }
  return previous;
}

async function inspect(client, hookFile) {
  const [settings, hooks] = await Promise.all([
    client.request("config/read", { includeLayers: false }),
    client.request("hooks/list", { cwds: [ROOT] }),
  ]);
  const errors = hooks.data.flatMap((entry) => entry.errors);
  if (errors.length) throw new Error("Codex encontrou erros ao carregar hooks; corrija-os antes de continuar.");
  return { config: settings.config, hook: findRtkHook(hooks, hookFile) };
}

async function main(args = process.argv.slice(2)) {
  if (args.some((arg) => !["--check", "--test"].includes(arg))) {
    throw new Error("Uso: node scripts/configure_rtk_codex.cjs [--check | --test]");
  }
  if (process.platform !== "win32") throw new Error("Este configurador atende ao Codex local no Windows.");
  const check = args.includes("--check") || args.includes("--test");
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const hookFile = path.join(codexHome, "hooks.json");
  const agentsFile = path.join(codexHome, "AGENTS.md");
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const dataRoot = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "rtk");
  runRtk(["--version"]);
  if (!check) {
    // RTK merges its own global entry and instructions without replacing other hooks.
    runRtk(["init", "--codex", "--global"]);
  }
  const instructions = fs.existsSync(agentsFile) ? fs.readFileSync(agentsFile, "utf8") : "";
  const updated = updateInstructions(instructions);
  if (check && updated !== instructions) throw new Error("Instruções globais para functions.exec ausentes ou desatualizadas.");
  const client = new CodexClient();
  try {
    await client.initialize();
    const { config, hook } = await inspect(client, hookFile);
    const edits = buildConfigEdits(config, hook, dataRoot, claudeConfigDir);
    if (check && edits.length) {
      throw new Error(`Configuração incompleta: ${edits.map((edit) => edit.keyPath).join(", ")}`);
    }
    if (edits.length) {
      await client.request("config/batchWrite", { edits, filePath: path.join(codexHome, "config.toml") });
    }
    if (!check && updated !== instructions) fs.writeFileSync(agentsFile, updated, "utf8");
    if (args.includes("--test")) {
      const previous = await testRuntime(client);
      const fresh = new CodexClient();
      try {
        await fresh.initialize();
        const persisted = JSON.parse(await sandboxCommand(fresh, "rtk gain --project --format json")).summary;
        if (persisted.total_commands < previous.total_commands || persisted.total_saved < previous.total_saved) {
          throw new Error("As métricas não sobreviveram à abertura de um novo runtime Codex.");
        }
        console.log("OK: economias preservadas após abrir um novo runtime Codex.");
      } finally { fresh.close(); }
    }
    console.log(check ? "OK: hook global do RTK habilitado, confiável e com raiz de métricas configurada."
      : `OK: configuração global do RTK concluída (${edits.length} ajustes). Abra um novo chat do Codex.`);
  } finally {
    client.close();
  }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { CodexClient, buildConfigEdits, findRtkHook, main, updateInstructions };
