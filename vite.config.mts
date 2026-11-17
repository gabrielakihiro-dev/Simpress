import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Os UMD de frontend/src/legado/ citam module.exports e o Rolldown os embrulharia como CommonJS: o ramo do
// navegador (root.SimpressX = ...) nunca rodaria. Trocar o teste por `false` escolhe o ramo do navegador; no disco
// os arquivos seguem UMD para os testes Node (require) e os harness VM.
const TESTE_COMMONJS = 'typeof module === "object" && module.exports';
// Ramos mortos que o teste acima deixa para trás; qualquer outra citação de module/require é um UMD novo, sem cobertura.
const RAMOS_MORTOS = [
  /if \((?:false|isCommonJs)\) module\.exports = \w+;/g,
  /\b(?:false|isCommonJs) \? require\("[^"]+"\) : /g,
];

function legadoUmdNavegador(): Plugin {
  return {
    name: "legado-umd-navegador",
    enforce: "pre",
    transform(codigo, id) {
      if (!id.replaceAll("\\", "/").includes("/frontend/src/legado/")) return null;
      const novo = codigo.replaceAll(TESTE_COMMONJS, "false");
      const resto = RAMOS_MORTOS.reduce((texto, ramo) => texto.replace(ramo, ""), novo);
      if (/\bmodule\.exports\b|\brequire\(|\btypeof (?:module|require|exports)\b/.test(resto)) {
        this.error(`${id}: sobrou module.exports/require no UMD; o Rolldown o embrulharia como CommonJS.`);
      }
      return { code: novo, map: null };
    },
  };
}

// Bundle único em static/dist/react-entry.js, servido pelo FastAPI (sem servidor Node).
// versioned_html (domains/frontend_assets.py) só versiona o arquivo citado no HTML: nada de chunks.
// O CSP só aceita 'self': nada de data:, script inline nem eval.
export default defineConfig({
  plugins: [legadoUmdNavegador(), react()],
  base: "/static/dist/",
  publicDir: false,
  build: {
    outDir: "static/dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
    rolldownOptions: {
      input: "frontend/src/main.tsx",
      // cromo-marca.js importa o paper-shaders de /static/vendor/: ele segue como módulo do navegador, como antes (empacotado traria URIs data:, que o CSP e os testes proíbem).
      external: [/^\/static\/vendor\//],
      output: {
        entryFileNames: "react-entry.js",
        codeSplitting: false,
      },
    },
  },
});
