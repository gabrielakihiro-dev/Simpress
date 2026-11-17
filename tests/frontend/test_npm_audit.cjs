const test = require("node:test");
const assert = require("node:assert/strict");
const { bloqueantes } = require("../../scripts/npm_audit.cjs");

const via = (id, severity) => ({ name: "pkg", title: "t", severity, url: `https://github.com/advisories/${id}` });

test("npm audit: ignora só o alerta listado e respeita o nível mínimo", () => {
  const relatorio = {
    vulnerabilities: {
      picomatch: { via: [via("GHSA-fc5q-39xc-vjpf", "high")] },
      vite: { via: ["picomatch"] },
      outro: { via: [via("GHSA-aaaa-bbbb-cccc", "moderate"), via("GHSA-low", "low")] },
    },
  };
  const lista = bloqueantes(relatorio, new Set(["GHSA-fc5q-39xc-vjpf"]));
  assert.equal(lista.length, 1);
  assert.match(lista[0], /GHSA-aaaa-bbbb-cccc/);
  assert.deepEqual(bloqueantes({ vulnerabilities: { picomatch: relatorio.vulnerabilities.picomatch } }, new Set(["GHSA-fc5q-39xc-vjpf"])), []);
});
