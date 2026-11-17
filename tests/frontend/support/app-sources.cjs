// frontend/src/legado/app-entry.js owns the ordered browser imports (the Vite bundle follows the same order).
// VM harnesses evaluate the application factories and bootstrap in that order; standalone UI integrations
// have dedicated tests. Paths returned here are relative to frontend/src/legado/.
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..", "..");
const staticDir = path.join(root, "static");
const legadoDir = path.join(root, "frontend", "src", "legado");
const entrySource = fs.readFileSync(path.join(legadoDir, "app-entry.js"), "utf8");
const APP_IMPORT_PATTERN = /^\s*import\s+["']\.\/([^"']+\.js)["'];?\s*$/gm;

function appScriptFiles() {
  const files = [...entrySource.matchAll(APP_IMPORT_PATTERN)].map(match => match[1]);
  const bootstrapIndex = files.indexOf("app.js");
  if (bootstrapIndex === -1) throw new Error("frontend/src/legado/app-entry.js must import frontend/src/legado/app.js");
  if (!files.slice(0, bootstrapIndex).some(file => file.startsWith("features/"))) {
    throw new Error("feature factories must load before frontend/src/legado/app.js");
  }
  if (!files.slice(bootstrapIndex + 1).includes("ui/ux-enhancements.js")) {
    throw new Error("page enhancements must load after frontend/src/legado/app.js");
  }
  return files;
}

function appScripts() {
  const isApplicationSource = file => file.startsWith("features/")
    || file === "shared/api-errors.js"
    || file === "shared/api-fetch.js"
    || file === "shared/history-format.js"
    || file === "shared/sebrae-dashboard-model.js"
    || file === "ui/comparison-result-renderer.js"
    || file === "ui/equipment-search-renderers.js"
    || file === "ui/logged-user-markers.js"
    || file === "app.js";
  return appScriptFiles().filter(isApplicationSource).map(file => ({
    file: `frontend/src/legado/${file}`,
    source: fs.readFileSync(path.join(legadoDir, file), "utf8"),
  }));
}

function appSource() {
  return appScripts().map(script => script.source).join("\n");
}

module.exports = { appScriptFiles, appScripts, appSource, legadoDir, staticDir };
