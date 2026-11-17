const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { assembledHtml } = require("./support/assembled-html.cjs");
const test = require("node:test");

const staticDir = path.resolve(__dirname, "../../static");
const uiDir = path.resolve(__dirname, "../../frontend/src/ui");
const arranqueDir = path.resolve(__dirname, "../../frontend/src/arranque");
const aplicacaoDir = path.resolve(__dirname, "../../frontend/src/aplicacao");
const html = assembledHtml();

// IDs que o JS procura mas que não estão no index.html. Cada uma precisa de motivo.
const ALLOWED_MISSING = new Map([
  ["automacao-captura-dialogo", "criado pelo JS (frontend/src/paineis/chrome-automation) ao abrir a captura"],
  ["automacao-captura-titulo", "criado pelo JS junto com o diálogo de captura"],
  ["automacao-captura-imagem", "criado pelo JS junto com o diálogo de captura"],
  ["automacao-captura-mensagem", "criado pelo JS junto com o diálogo de captura"],
  ["automacao-captura-fechar", "criado pelo JS junto com o diálogo de captura"],
  ["comparacao-divergencias-manuais-pendentes", "contador renderizado pelo JS dentro do resultado da comparação"],
  ["btn-sidebar-open", "botão da sidebar legada, removida no Cockpit v2; accessible-dialogs.ts ignora o null"],
  ["ux-sort-status", "região aria-live criada sob demanda por frontend/src/paineis/paineis-dados"],
  ["badge-divergencias-ux", "criado sob demanda por frontend/src/paineis/paineis-dados"],
  ["ux-pending-chip", "criado sob demanda por frontend/src/ui/ux-enhancements.ts"],
  ["cockpit-tickets-file-simpress", "campo de arquivo desenhado pelo painel React (frontend/src/paineis/cockpit-chamados); abrirGestaoChamadosCockpit só o procura ao abrir o bloco"],
  ["resumo-painel-visao", "painel da Visão geral renderizado pelo JS dentro do resultado da comparação (frontend/src/paineis/resultado-comparacao)"],
]);

function jsFiles(dir, extensao = ".js") {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return ["vendor", "dist"].includes(entry.name) ? [] : jsFiles(full, extensao);
    return entry.name.endsWith(extensao) ? [full] : [];
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
  for (const file of [...jsFiles(staticDir), ...jsFiles(uiDir, ".ts"), ...jsFiles(arranqueDir, ".ts"), ...jsFiles(aplicacaoDir, ".ts")]) {
    const source = fs.readFileSync(file, "utf8");
    for (const pattern of patterns) {
      for (const [, id] of source.matchAll(pattern)) {
        if (!htmlIds.has(id) && !ALLOWED_MISSING.has(id)) {
          missing.set(id, path.relative(path.dirname(staticDir), file));
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
