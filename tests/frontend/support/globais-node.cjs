// As features de frontend/src/aplicacao/ são TypeScript carregado por require(): rodam no realm do Node, não na VM, e
// leem document, window, lucide... como globais soltas. Os harnesses chamam isto ANTES de avaliar app.js na VM,
// para que o realm do Node enxergue os mesmos falsos que a VM (define em vez de atribuir: navigator, fetch e
// CustomEvent já existem no Node como acessores).
function instalarGlobaisNode(falsos) {
  for (const [nome, valor] of Object.entries(falsos)) {
    if (valor === undefined) continue;
    Object.defineProperty(globalThis, nome, { value: valor, configurable: true, writable: true, enumerable: true });
  }
}

module.exports = { instalarGlobaisNode };
