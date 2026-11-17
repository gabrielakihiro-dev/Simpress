// frontend/src/legado/app-entry.js owns the ordered browser imports (the Vite bundle follows the same order).
// VM harnesses evaluate the bootstrap in that order; the feature factories live in frontend/src/aplicacao/ (TypeScript,
// loaded through require()); standalone UI integrations have dedicated tests. Paths returned here are relative to
// frontend/src/legado/; the TypeScript modules that moved out of it keep their `../` prefix
// (for example `../comum/history-format.ts`).
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..", "..");
const staticDir = path.join(root, "static");
const legadoDir = path.join(root, "frontend", "src", "legado");
const aplicacaoDir = path.join(root, "frontend", "src", "aplicacao");
const entrySource = fs.readFileSync(path.join(legadoDir, "app-entry.js"), "utf8");
const APP_IMPORT_PATTERN = /^\s*import\s+["'](?:\.\/)?([^"']+\.(?:js|ts))["'];?\s*$/gm;
const REGISTRO = "../aplicacao/registro.ts";

function appScriptFiles() {
  const files = [...entrySource.matchAll(APP_IMPORT_PATTERN)].map(match => match[1]);
  const bootstrapIndex = files.indexOf("app.js");
  if (bootstrapIndex === -1) throw new Error("frontend/src/legado/app-entry.js must import frontend/src/legado/app.js");
  const registroIndex = files.indexOf(REGISTRO);
  if (registroIndex === -1 || registroIndex > bootstrapIndex) {
    throw new Error("feature factories (frontend/src/aplicacao/registro.ts) must load before frontend/src/legado/app.js");
  }
  if (!files.slice(bootstrapIndex + 1).includes("ui/ux-enhancements.js")) {
    throw new Error("page enhancements must load after frontend/src/legado/app.js");
  }
  return files;
}

// Every module of frontend/src/aplicacao/ (the feature factories), sorted so the order is stable.
function aplicacaoFiles() {
  return fs.readdirSync(aplicacaoDir).filter(file => file.endsWith(".ts")).sort().map(file => `../aplicacao/${file}`);
}

// Application sources as text, in load order (the feature modules, the bootstrap and the TypeScript modules the app reads at run time).
function applicationSources() {
  const isApplicationSource = file => file === "../comum/api-errors.ts"
    || file === "../api.ts"
    || file === "../comum/history-format.ts"
    || file === "../comum/sebrae-dashboard-model.ts"
    || file === "../ui/equipment-search-renderers.ts"
    || file === "../ui/logged-user-markers.ts"
    || file === "app.js";
  const files = appScriptFiles().flatMap(file => {
    if (file === REGISTRO) return aplicacaoFiles();
    return isApplicationSource(file) ? [file] : [];
  });
  return files.map(file => {
    const absolute = path.join(legadoDir, file);
    return {
      file: path.relative(root, absolute).split(path.sep).join("/"),
      source: fs.readFileSync(absolute, "utf8"),
    };
  });
}

// Only the bootstrap runs inside the VM; the .ts modules are injected through require() by the harnesses.
function appScripts() {
  return applicationSources().filter(({ file }) => file.endsWith(".js"));
}

function appSource() {
  return applicationSources().map(script => script.source).join("\n");
}

module.exports = { aplicacaoDir, aplicacaoFiles, appScriptFiles, appScripts, appSource, legadoDir, staticDir };
