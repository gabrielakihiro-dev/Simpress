// static/index.html as the server sends it: each `<!-- include: partials/<name>.html -->` line is
// replaced by the file in frontend/partials/. Mirrors assembled_html() in domains/frontend_assets.py;
// tests/test_frontend_assets.py runs this file and compares both results.
// Uso: node tests/frontend/support/assembled-html.cjs [nome.html] [pasta static]  (escreve o HTML montado no stdout)
const fs = require("node:fs");
const path = require("node:path");

const staticDir = path.resolve(__dirname, "..", "..", "..", "static");
const INCLUDE = /^[ \t]*<!-- include: (\S+) -->\n/gm;
const MAX_INCLUDE_DEPTH = 2;

function assembledHtml(name = "index.html", dir = staticDir) {
  const root = path.resolve(dir);
  const partials = path.join(path.dirname(root), "frontend", "partials");
  const expand = (source, depth) => source.replace(INCLUDE, (_line, reference) => {
    const target = path.resolve(path.dirname(partials), reference);
    const relative = path.relative(partials, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.extname(target) !== ".html") {
      throw new Error(`Include fora de frontend/partials: ${reference}`);
    }
    if (depth >= MAX_INCLUDE_DEPTH) throw new Error(`Include com mais de ${MAX_INCLUDE_DEPTH} níveis: ${reference}`);
    if (!fs.existsSync(target)) throw new Error(`Partial ausente: frontend/${reference}`);
    return expand(fs.readFileSync(target, "utf8"), depth + 1);
  });
  return expand(fs.readFileSync(path.join(root, name), "utf8"), 0);
}

module.exports = { assembledHtml, staticDir };

if (require.main === module) process.stdout.write(assembledHtml(process.argv[2], process.argv[3]));
