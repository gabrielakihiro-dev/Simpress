const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const staticDir = path.resolve(__dirname, "../../static");
const html = fs.readFileSync(path.join(staticDir, "index.html"), "utf8");

// IDs que o JS procura mas que não estão no index.html. Cada uma precisa de motivo.
const ALLOWED_MISSING = new Map([
  ["automacao-captura-dialogo", "criado pelo JS (chrome-automation.js) ao abrir a captura"],
  ["automacao-captura-titulo", "criado pelo JS junto com o diálogo de captura"],
  ["automacao-captura-imagem", "criado pelo JS junto com o diálogo de captura"],
  ["automacao-captura-mensagem", "criado pelo JS junto com o diálogo de captura"],
  ["automacao-captura-fechar", "criado pelo JS junto com o diálogo de captura"],
  ["comparacao-divergencias-manuais-pendentes", "contador renderizado pelo JS dentro do resultado da comparação"],
  ["btn-sidebar-open", "botão da sidebar legada, removida no Cockpit v2; accessible-dialogs.js ignora o null"],
  ["ux-sort-status", "região aria-live criada sob demanda por data-panels.js"],
  ["badge-divergencias-ux", "criado sob demanda por data-panels.js"],
  ["ux-pending-chip", "criado sob demanda por ux-enhancements.js"],
]);

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "vendor" ? [] : jsFiles(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

test("every literal element id used by the JS exists in index.html", () => {
  const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]));
  const patterns = [
    /getElementById\(\s*["'`]([\w-]+)["'`]\s*\)/g,
    /\bbyId\(\s*["'`]([\w-]+)["'`]\s*\)/g,
    /querySelector(?:All)?\(\s*["'`]#([\w-]+)[\s"'`.:\[>,]/g,
  ];
  const missing = new Map();
  for (const file of jsFiles(staticDir)) {
    const source = fs.readFileSync(file, "utf8");
    for (const pattern of patterns) {
      for (const [, id] of source.matchAll(pattern)) {
        if (!htmlIds.has(id) && !ALLOWED_MISSING.has(id)) {
          missing.set(id, path.relative(staticDir, file));
        }
      }
    }
  }
  assert.deepEqual([...missing], [], "ids ausentes do index.html (adicione o elemento ou justifique em ALLOWED_MISSING)");
});

test("the allowed-missing list has no stale entries", () => {
  for (const id of ALLOWED_MISSING.keys()) {
    assert.ok(!html.includes(`id="${id}"`), `${id} já existe no index.html; remova da lista`);
  }
});
