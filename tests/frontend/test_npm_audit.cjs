const test = require("node:test");
const assert = require("node:assert/strict");
const { alertasBloqueantes } = require("../../scripts/npm-audit.cjs");

const alerta = (id, severity, name = "pacote") => ({
  source: 1, name, title: "t", severity, url: `https://github.com/advisories/${id}`,
});

test("só o alerta ignorado não bloqueia; dependentes por nome não contam", () => {
  const relatorio = { vulnerabilities: {
    picomatch: { via: [alerta("GHSA-fc5q-39xc-vjpf", "high", "picomatch")] },
    vite: { via: ["picomatch", "tinyglobby"] },
  } };
  assert.deepEqual(alertasBloqueantes(relatorio), []);
});

test("alerta novo moderate ou acima bloqueia; low não bloqueia", () => {
  const relatorio = { vulnerabilities: {
    a: { via: [alerta("GHSA-aaaa-bbbb-cccc", "moderate", "a")] },
    b: { via: [alerta("GHSA-dddd-eeee-ffff", "low", "b")] },
  } };
  assert.equal(alertasBloqueantes(relatorio).length, 1);
  assert.match(alertasBloqueantes(relatorio)[0], /GHSA-aaaa-bbbb-cccc/);
});
