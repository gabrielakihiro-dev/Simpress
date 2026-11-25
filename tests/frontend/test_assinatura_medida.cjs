// Assinatura do técnico por nome: normalização do nome (mesma do servidor) e geometria pela caixa de tinta. Dados fictícios.
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { AREA, calcularMedida, erroDoNome, normalizarNome } = require(path.resolve(__dirname, "../../frontend/src/componentes/assinatura-medida.ts"));

test("normalizarNome: NFC, apóstrofos tipográficos, espaços colapsados", () => {
  assert.equal(normalizarNome("  Ana\u0301   D’Ávila \u2018Neto\u2018 "), "Ana\u0301".normalize("NFC") + " D'Ávila 'Neto'");
  assert.equal(normalizarNome("   "), "");
});

test("erroDoNome: só letras, espaço, ponto, apóstrofo e hífen, até 80", () => {
  for (const bom of ["Ana", "João Gonçalves-Pereira", "D'Ávila Jr.", ""]) assert.equal(erroDoNome(bom), "", bom);
  for (const ruim of ["Ana 2", "A@na", "...", "a".repeat(81)]) assert.notEqual(erroDoNome(ruim), "", ruim);
  assert.equal(erroDoNome("a".repeat(80)), "");
});

// Tinta medida a 200 px: largura 1000 (esq 10 + dir 990), subida 150, descida 60.
const TINTA = { esq: 10, dir: 990, asc: 150, desc: 60 };

test("calcularMedida digitada: tinta mais baixa rente à linha, centrada pela tinta, dentro da largura", () => {
  const m = calcularMedida(TINTA, "digitada");
  const u = m.tamanho / 200;
  assert.ok(m.tamanho <= 5 + 1e-9);
  assert.ok(m.y < 0 && -m.y >= 60 * u && -m.y <= 60 * u + 0.05 * m.tamanho); // descida acima da linha, folga pequena
  assert.ok(Math.abs(m.x - 10 * u - (AREA.largura - 1000 * u) / 2) < 0.01); // tinta centrada em x
});

test("calcularMedida: nome longo encolhe para a largura; cursiva apoia a base na linha e limita a descida", () => {
  const longo = calcularMedida({ esq: 0, dir: 40000, asc: 150, desc: 60 }, "digitada");
  assert.ok(40000 * (longo.tamanho / 200) <= AREA.largura);
  const cursiva = calcularMedida({ esq: 0, dir: 500, asc: 100, desc: 400 }, "allura");
  // cauda de 400 px a 200 px: a descida real (y + cauda) fica em 1,7 mm e o texto sobe o resto; sem cauda, y = 0
  assert.ok(Math.abs(400 * (cursiva.tamanho / 200) + cursiva.y - 1.7) < 0.01);
  assert.equal(calcularMedida({ esq: 0, dir: 500, asc: 100, desc: 5 }, "allura").y, 0);
  assert.ok(-cursiva.y + 100 * (cursiva.tamanho / 200) <= AREA.subida);
  assert.equal(calcularMedida({ esq: 0, dir: 0, asc: 0, desc: 0 }, "allura"), null);
  assert.equal(calcularMedida({ esq: NaN, dir: 1, asc: 1, desc: 1 }, "allura"), null);
});
