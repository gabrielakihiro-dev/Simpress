// /api/* exige o cookie e o X-Simpress-Sessao (security/sessao_local.py); só o apiFetch (frontend/src/api.ts) manda o
// cabeçalho. Navegação, <a href>, <img src>, formulário e fetch cru dariam 401: este teste barra esses caminhos.
// Limite: URL montada em variável fora da mesma linha (ex.: captura.url do servidor) não é vista; essas vão por
// comum/baixar-api.ts (urlDeBlobDaApi, baixarDaApi).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..", "..");

function listar(pasta, extensoes) {
  return fs.readdirSync(pasta, { withFileTypes: true }).flatMap(item => {
    const caminho = path.join(pasta, item.name);
    if (item.isDirectory()) return listar(caminho, extensoes);
    return extensoes.some(ext => item.name.endsWith(ext)) && !item.name.includes(".gerado") ? [caminho] : [];
  });
}

const arquivos = [
  ...listar(path.join(root, "frontend", "src"), [".ts", ".tsx"]),
  ...listar(path.join(root, "frontend", "partials"), [".html"]),
  path.join(root, "static", "index.html"),
];
const API_TS = path.join(root, "frontend", "src", "api.ts");

const REGRAS = [
  ["atributo href/src/action apontando para /api/", /\b(href|src|action)\s*=\s*\{?\s*["'`][^"'`]*\/api\//],
  ["propriedade .href/.src com /api/", /\.(href|src)\s*=\s*[^;]*\/api\//],
  ["navegação para /api/", /(location\.(assign|replace)\s*\(|location\.href\s*=|window\.open\s*\()[^;]*\/api\//],
  ["fetch cru", /(?<![\w$.])fetch\s*\(|\b(win|window|globalThis|self)\.fetch\b/],
  ["XMLHttpRequest, EventSource ou sendBeacon", /\bXMLHttpRequest\b|\bnew EventSource\b|\bsendBeacon\s*\(/],
];

test("nenhum caminho para /api/* fora do apiFetch em frontend/src, frontend/partials e static/index.html", () => {
  assert.ok(arquivos.length > 50, "a busca precisa achar os fontes");
  const achados = [];
  for (const arquivo of arquivos) {
    if (arquivo === API_TS) continue;
    fs.readFileSync(arquivo, "utf8").split("\n").forEach((linha, indice) => {
      for (const [regra, padrao] of REGRAS) {
        if (padrao.test(linha)) achados.push(`${path.relative(root, arquivo)}:${indice + 1} ${regra}`);
      }
    });
  }
  assert.deepEqual(achados, []);
});

test("as regras pegam os casos que já existiram", () => {
  const casos = [
    '<a href="/api/config/local/endpoint/computadores" target="_blank">',
    "<a href={`/api/assistente/relatorio/${arquivo.id}`} download>",
    "copia.href = `/api/sebrae/dashboard/envio/${id}/snapshot`;",
    'window.location.assign("/api/usuarios-entra/exportar");',
    'img.src = "/api/assinatura-tecnico";',
    "return win.fetch(url, { headers });",
    'const response = await fetch("/api/stats");',
    '<form action="/api/x">',
  ];
  for (const caso of casos) assert.ok(REGRAS.some(([, padrao]) => padrao.test(caso)), caso);
  for (const ok of ['await apiFetch("/api/stats");', "link.href = url;", 'window.open(url, "_blank", "noopener,noreferrer");']) {
    assert.ok(!REGRAS.some(([, padrao]) => padrao.test(ok)), ok);
  }
});
