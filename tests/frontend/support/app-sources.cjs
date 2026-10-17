// app-entry.js owns the ordered browser imports. VM harnesses evaluate the application
// factories and bootstrap in that order; standalone UI integrations have dedicated tests.
const fs = require("node:fs");
const path = require("node:path");

const staticDir = path.join(__dirname, "..", "..", "..", "static");
const entrySource = fs.readFileSync(path.join(staticDir, "app-entry.js"), "utf8");
const APP_IMPORT_PATTERN = /^\s*import\s+["']\.\/([^"']+\.js)["'];?\s*$/gm;

function appScriptFiles() {
  const files = [...entrySource.matchAll(APP_IMPORT_PATTERN)].map(match => match[1]);
  const bootstrapIndex = files.indexOf("app.js");
  if (bootstrapIndex === -1) throw new Error("static/app-entry.js must import static/app.js");
  if (!files.slice(0, bootstrapIndex).some(file => file.startsWith("js/features/"))) {
    throw new Error("feature factories must load before static/app.js");
  }
  if (!files.slice(bootstrapIndex + 1).includes("js/ui/ux-enhancements.js")) {
    throw new Error("page enhancements must load after static/app.js");
  }
  return files;
}

function appScripts() {
  const isApplicationSource = file => file.startsWith("js/features/")
    || file === "js/shared/api-errors.js"
    || file === "js/shared/history-format.js"
    || file === "js/ui/comparison-result-renderer.js"
    || file === "js/ui/equipment-search-renderers.js"
    || file === "app.js";
  return appScriptFiles().filter(isApplicationSource).map(file => ({
    file: `static/${file}`,
    source: fs.readFileSync(path.join(staticDir, file), "utf8"),
  }));
}

function appSource() {
  return appScripts().map(script => script.source).join("\n");
}

module.exports = { appScriptFiles, appScripts, appSource, staticDir };
