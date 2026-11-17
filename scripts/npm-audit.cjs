#!/usr/bin/env node
// `npm audit --audit-level=moderate` com uma lista curta de alertas ignorados (o npm não tem ignore nativo).
// Cada alerta ignorado traz data e motivo; tire da lista assim que sair versão corrigida.
const { spawnSync } = require("node:child_process");

const IGNORADOS = {
  // 17/11/2026, pedido do usuário: ReDoS no picomatch (via vite, só build local), sem versão corrigida ainda.
  "GHSA-fc5q-39xc-vjpf": "picomatch",
};
const NIVEIS = ["info", "low", "moderate", "high", "critical"];
const MINIMO = NIVEIS.indexOf("moderate");

/** Alertas (objetos em `via`) de severidade >= moderate que não estão em IGNORADOS. */
function alertasBloqueantes(relatorio) {
  const achados = new Map();
  for (const vuln of Object.values(relatorio.vulnerabilities || {})) {
    for (const via of vuln.via || []) {
      if (typeof via !== "object" || NIVEIS.indexOf(via.severity) < MINIMO) continue;
      const id = String(via.url || "").split("/").pop();
      if (!(id in IGNORADOS)) achados.set(id || via.title, `${via.name}: ${via.title} (${via.severity}) ${via.url}`);
    }
  }
  return [...achados.values()];
}

if (require.main === module) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const saida = spawnSync(npm, ["audit", "--json"], { encoding: "utf8", shell: process.platform === "win32" });
  let relatorio;
  try {
    relatorio = JSON.parse(saida.stdout);
  } catch {
    console.error("npm audit não devolveu JSON.");
    console.error(saida.stderr);
    process.exit(1);
  }
  if (relatorio.error) {
    console.error(`npm audit falhou: ${relatorio.error.summary || relatorio.error.code}`);
    process.exit(1);
  }
  const bloqueantes = alertasBloqueantes(relatorio);
  for (const linha of bloqueantes) console.error(linha);
  console.log(`Alertas ignorados: ${Object.keys(IGNORADOS).join(", ") || "nenhum"}.`);
  console.log(bloqueantes.length ? `${bloqueantes.length} alerta(s) moderate ou acima.` : "Nenhum alerta moderate ou acima fora da lista.");
  process.exit(bloqueantes.length ? 1 : 0);
}

module.exports = { alertasBloqueantes, IGNORADOS };
