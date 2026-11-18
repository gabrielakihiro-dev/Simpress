import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Entrada em static/dist/react-entry.js, servida pelo FastAPI (sem servidor Node). Os painéis sob demanda
// (frontend/src/paineis.ts) saem em arquivos <nome>-<hash>.js: versioned_html (domains/frontend_assets.py) só põe ?v= no
// arquivo citado no HTML, então o hash no nome é o que troca o endereço de cada pedaço a cada build.
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
        // Painel sob demanda sai como <painel>-<hash>.js (montar-<hash>.js não diria qual é).
        chunkFileNames: chunk => `${/paineis[\\/]([^\\/]+)[\\/]montar\.tsx$/.exec(chunk.facadeModuleId ?? "")?.[1] ?? "[name]"}-[hash].js`,
        // React e React DOM num arquivo à parte, importado direto pela entrada (baixa junto, em paralelo): muda só quando a
        // versão sobe, então o navegador reaproveita do cache entre builds.
        // O resto de frontend/src fora de paineis/ (arranque, aplicação, comum, ui, api) vai para aplicacao-<hash>.js pelo mesmo
        // motivo de fundo: a página carrega react-entry.js?v=..., e um painel sob demanda que importasse "./react-entry.js" (sem
        // ?v=) faria o navegador rodar a entrada de novo. Nenhum arquivo pode importar a entrada (tests/test_frontend_assets.py).
        codeSplitting: {
          groups: [
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: "aplicacao", test: /frontend[\\/]src[\\/](?!paineis[\\/]|main\.tsx$)/ },
          ],
        },
      },
    },
  },
});
