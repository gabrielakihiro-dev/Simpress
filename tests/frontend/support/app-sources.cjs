// frontend/src/arranque/entrada.ts owns the ordered browser imports (the Vite bundle follows the same order).
// The bootstrap (frontend/src/aplicacao/app.ts, `iniciar(win)`) and the feature factories (frontend/src/aplicacao/,
// TypeScript loaded through require()) run in the Node realm; the harnesses call iniciar() on a fake window instead of
// evaluating a script in a VM. Standalone UI integrations have dedicated tests. Paths returned here are relative to
// frontend/src/arranque/ (for example `../comum/history-format.ts` and `iniciar-aplicacao.ts`).
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..", "..");
const staticDir = path.join(root, "static");
const srcDir = path.join(root, "frontend", "src");
const arranqueDir = path.join(srcDir, "arranque");
const aplicacaoDir = path.join(srcDir, "aplicacao");
const BOOTSTRAP = "../aplicacao/app.ts";
const INICIAR = "iniciar-aplicacao.ts";
const REGISTRO = "../aplicacao/registro.ts";
const UX = "instalar-ux-enhancements.ts";
const entrySource = fs.readFileSync(path.join(arranqueDir, "entrada.ts"), "utf8");
const APP_IMPORT_PATTERN = /^\s*import\s+["'](?:\.\/)?([^"']+\.ts)["'];?\s*$/gm;

function appScriptFiles() {
  const files = [...entrySource.matchAll(APP_IMPORT_PATTERN)].map(match => match[1]);
  const bootstrapIndex = files.indexOf(INICIAR);
  if (bootstrapIndex === -1) throw new Error("frontend/src/arranque/entrada.ts must import frontend/src/arranque/iniciar-aplicacao.ts");
  const registroIndex = files.indexOf(REGISTRO);
  if (registroIndex === -1 || registroIndex > bootstrapIndex) {
    throw new Error("feature factories (frontend/src/aplicacao/registro.ts) must load before frontend/src/arranque/iniciar-aplicacao.ts");
  }
  if (!files.slice(bootstrapIndex + 1).includes(UX)) {
    throw new Error("page enhancements (frontend/src/arranque/instalar-ux-enhancements.ts) must load after frontend/src/arranque/iniciar-aplicacao.ts");
  }
  return files;
}

// Every feature module of frontend/src/aplicacao/ (the factories, the registry and the shared types), sorted so the
// order is stable. The bootstrap app.ts lives in the same folder but is not a feature: it is BOOTSTRAP.
function aplicacaoFiles() {
  return fs.readdirSync(aplicacaoDir).filter(file => file.endsWith(".ts") && file !== "app.ts").sort().map(file => `../aplicacao/${file}`);
}

// Application sources as text, in load order (the feature modules, the bootstrap and the TypeScript modules the app reads at run time).
function applicationSources() {
  const isApplicationSource = file => file === "../comum/api-errors.ts"
    || file === "../api.ts"
    || file === "../comum/history-format.ts"
    || file === "../comum/sebrae-dashboard-model.ts"
    || file === "../ui/equipment-search-renderers.ts"
    || file === "../ui/logged-user-markers.ts";
  const files = appScriptFiles().flatMap(file => {
    if (file === REGISTRO) return aplicacaoFiles();
    // iniciar-aplicacao.ts only calls iniciar(window): the bootstrap text is app.ts.
    if (file === INICIAR) return [BOOTSTRAP];
    return isApplicationSource(file) ? [file] : [];
  });
  return files.map(file => {
    const absolute = path.join(arranqueDir, file);
    return {
      file: path.relative(root, absolute).split(path.sep).join("/"),
      source: fs.readFileSync(absolute, "utf8"),
    };
  });
}

function appSource() {
  return applicationSources().map(script => script.source).join("\n");
}

module.exports = { aplicacaoDir, aplicacaoFiles, appScriptFiles, appSource, arranqueDir, srcDir, staticDir, BOOTSTRAP };
