import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Bundle único em static/dist/react-entry.js, servido pelo FastAPI (sem servidor Node).
// versioned_html (domains/frontend_assets.py) só versiona o arquivo citado no HTML: nada de chunks.
// O CSP só aceita 'self': nada de data:, script inline nem eval.
export default defineConfig({
  plugins: [react()],
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
      // ui/cromo-marca.ts importa o paper-shaders de /static/vendor/: ele segue como módulo do navegador, como antes (empacotado traria URIs data:, que o CSP e os testes proíbem).
      external: [/^\/static\/vendor\//],
      output: {
        entryFileNames: "react-entry.js",
        codeSplitting: false,
      },
    },
  },
});
