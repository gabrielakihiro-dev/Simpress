const assert = require("node:assert/strict");
const test = require("node:test");
const createBento = require("../../frontend/src/legado/ui/bento.js");

// Ambiente falso: rAF guarda callbacks, o relógio é manual e matchMedia diz se há movimento reduzido.
function harness({ reduzido = false } = {}) {
  let agora = 1000;
  let proximoId = 0;
  const pendentes = new Map();
  const cancelados = [];
  const env = {
    matchMedia: () => ({ matches: reduzido }),
    performance: { now: () => agora },
    requestAnimationFrame: callback => { pendentes.set(++proximoId, callback); return proximoId; },
    cancelAnimationFrame: id => { cancelados.push(id); pendentes.delete(id); },
  };
  return {
    bento: createBento(env),
    cancelados,
    pendentes,
    // Avança o relógio e roda só os quadros ainda vivos (o rAF real não chama quadro cancelado).
    avancar(ms) {
      agora += ms;
      const fila = [...pendentes.values()];
      pendentes.clear();
      fila.forEach(callback => callback(agora));
    },
  };
}

function elemento(viva = null) {
  return { textContent: "", closest: () => viva };
}

function regiaoViva() {
  const atributos = new Map();
  return {
    getAttribute: nome => atributos.get(nome) ?? null,
    setAttribute: (nome, valor) => atributos.set(nome, valor),
    removeAttribute: nome => atributos.delete(nome),
  };
}

test("contarAte counts up and ends with the exact formatted target", () => {
  const { bento, avancar, pendentes } = harness();
  const el = elemento();
  bento.contarAte(el, 1248);
  assert.equal(el.textContent, "0");
  avancar(450);
  assert.equal(el.textContent, "1.092"); // curva(0.5) = 0,875 de 1248
  avancar(450);
  assert.equal(el.textContent, "1.248");
  assert.equal(pendentes.size, 0);
});

test("contarAte still ends when frame timestamps restart below the start time", () => {
  const { bento, pendentes } = harness(); // início em 1000; quadros chegam a partir de 0
  const el = elemento();
  bento.contarAte(el, 1248);
  for (const instante of [0, 450, 900]) {
    const fila = [...pendentes.values()];
    pendentes.clear();
    fila.forEach(callback => callback(instante));
  }
  assert.equal(el.textContent, "1.248");
  assert.equal(pendentes.size, 0);
});

test("contarAte writes the final value at once under reduced motion", () => {
  const { bento, pendentes } = harness({ reduzido: true });
  const el = elemento();
  bento.contarAte(el, 1248);
  assert.equal(el.textContent, "1.248");
  assert.equal(pendentes.size, 0);
});

test("a second contarAte on the same element cancels the first", () => {
  const { bento, cancelados, avancar } = harness();
  const el = elemento();
  bento.contarAte(el, 500);
  assert.deepEqual(cancelados, []);
  bento.contarAte(el, 1248);
  assert.deepEqual(cancelados, [1]);
  avancar(900);
  assert.equal(el.textContent, "1.248");
});

test("contarAte marks the live region aria-busy only while counting", () => {
  const { bento, avancar } = harness();
  const viva = regiaoViva();
  bento.contarAte(elemento(viva), 1248);
  assert.equal(viva.getAttribute("aria-busy"), "true");
  avancar(900);
  assert.equal(viva.getAttribute("aria-busy"), null);
});

test("aria-busy stays until the slowest counter of the same live region ends", () => {
  const { bento, avancar } = harness();
  const viva = regiaoViva();
  bento.contarAte(elemento(viva), 1248); // 900 ms
  bento.contarAte(elemento(viva), 99, undefined, 1200); // anel: 1200 ms
  avancar(900);
  assert.equal(viva.getAttribute("aria-busy"), "true");
  avancar(300);
  assert.equal(viva.getAttribute("aria-busy"), null);
});

test("contarAte never leaves aria-busy behind under reduced motion", () => {
  const { bento } = harness({ reduzido: true });
  const viva = regiaoViva();
  bento.contarAte(elemento(viva), 1248);
  assert.equal(viva.getAttribute("aria-busy"), null);
});

test("curva is the ease-out cubic 1-(1-t)^3 and stays inside 0..1", () => {
  const { curva } = harness().bento;
  assert.equal(curva(0), 0);
  assert.equal(curva(1), 1);
  assert.equal(curva(0.5), 0.875);
  assert.equal(curva(-1), 0);
  assert.equal(curva(2), 1);
});
