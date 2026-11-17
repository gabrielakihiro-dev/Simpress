// Os módulos .ts do painel importam irmãos sem extensão ("./renderizador"), como o tsc e o Vite pedem;
// o Node não completa ".ts" sozinho. Basta dar require neste arquivo antes de carregar o módulo .ts.
const Module = require("node:module");
const path = require("node:path");

Module.registerHooks({
  resolve(especificador, contexto, proximo) {
    if (/^\.\.?\//.test(especificador) && !path.extname(especificador) && /\.tsx?$/.test(contexto.parentURL || "")) {
      return proximo(`${especificador}.ts`, contexto);
    }
    return proximo(especificador, contexto);
  },
});
