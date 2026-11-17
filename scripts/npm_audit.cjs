#!/usr/bin/env node
// Igual a `npm audit --audit-level=moderate`, mas ignora alertas listados abaixo.
const { spawnSync } = require("node:child_process");

// Remova cada item quando sair versão corrigida do pacote.
const IGNORADOS = new Set([
  // picomatch <= 4.0.7, sem correção em 17/11/2026; só roda no build (Vite, Tailwind CLI) com padrões do projeto.
  "GHSA-fc5q-39xc-vjpf",
]);
const NIVEIS = ["info", "low", "moderate", "high", "critical"];

function bloqueantes(relatorio, ignorados = IGNORADOS, minimo = "moderate") {
  const corte = NIVEIS.indexOf(minimo);
  const achados = new Map();
  for (const vuln of Object.values(relatorio.vulnerabilities || {})) {
    for (const via of vuln.via || []) {
      if (typeof via !== "object") continue;
      const id = String(via.url || "").split("/").pop();
      if (ignorados.has(id) || NIVEIS.indexOf(via.severity) < corte) continue;
      achados.set(id || via.title, `${via.severity} ${via.name}: ${via.title} (${via.url})`);
    }
  }
  return [...achados.values()];
}

if (require.main === module) {
  const r = spawnSync("npm audit --json", { encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024 });
  let relatorio;
  try {
    relatorio = JSON.parse(r.stdout);
  } catch {
    console.error(r.stdout || r.stderr || "npm audit não devolveu JSON");
    process.exit(1);
  }
  if (relatorio.error) {
    console.error(JSON.stringify(relatorio.error));
    process.exit(1);
  }
  const lista = bloqueantes(relatorio);
  if (lista.length) {
    console.error(lista.join("\n"));
    process.exit(1);
  }
  console.log(`npm audit ok (ignorados: ${[...IGNORADOS].join(", ")})`);
}

module.exports = { bloqueantes, IGNORADOS };
