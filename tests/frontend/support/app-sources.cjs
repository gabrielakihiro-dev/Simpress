// The page script is split into static/js/features/* plus the static/app.js bootstrap.
// These helpers load them in index.html order, for vm harnesses and for source-level checks.
const fs = require("node:fs");
const path = require("node:path");

const staticDir = path.join(__dirname, "..", "..", "..", "static");
const indexHtml = fs.readFileSync(path.join(staticDir, "index.html"), "utf8");

// Scripts the bootstrap depends on that belong to the application itself (not vendor or shared UI helpers).
const APP_SCRIPT_PATTERN = /<script src="\/static\/((?:js\/features\/[^"]+|js\/shared\/history-format\.js|app\.js))"><\/script>/g;

function appScriptFiles() {
  const files = [...indexHtml.matchAll(APP_SCRIPT_PATTERN)].map(match => match[1]);
  if (files[files.length - 1] !== "app.js") throw new Error("static/app.js must be the last application script in index.html");
  return files;
}

function appScripts() {
  return appScriptFiles().map(file => ({ file: `static/${file}`, source: fs.readFileSync(path.join(staticDir, file), "utf8") }));
}

function appSource() {
  return appScripts().map(script => script.source).join("\n");
}

module.exports = { appScriptFiles, appScripts, appSource, staticDir };
