const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const vendorDir = path.join(root, "static", "vendor");
const fontDir = path.join(vendorDir, "fonts");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const versions = packageJson.devDependencies;

fs.mkdirSync(fontDir, { recursive: true });

function copyPackageFile(packageName, sourceRelativePath, destinationName) {
  const source = path.join(root, "node_modules", packageName, sourceRelativePath);
  const destination = path.join(destinationName.startsWith("fonts/") ? fontDir : vendorDir,
    destinationName.replace(/^fonts\//, ""));
  fs.copyFileSync(source, destination);
}

copyPackageFile(
  "lucide",
  "dist/umd/lucide.min.js",
  `lucide-${versions.lucide}.min.js`,
);
copyPackageFile("lucide", "LICENSE", "LICENSE-lucide.txt");
copyPackageFile("tailwindcss", "LICENSE", "LICENSE-tailwindcss.txt");
copyPackageFile(
  "@fontsource-variable/inter",
  "files/inter-latin-ext-wght-normal.woff2",
  "fonts/inter-latin-ext-wght-normal.woff2",
);
copyPackageFile(
  "@fontsource-variable/inter",
  "files/inter-latin-wght-normal.woff2",
  "fonts/inter-latin-wght-normal.woff2",
);
copyPackageFile(
  "@fontsource-variable/inter",
  "LICENSE",
  "LICENSE-fontsource-inter.txt",
);
copyPackageFile(
  "@fontsource-variable/jetbrains-mono",
  "files/jetbrains-mono-latin-ext-wght-normal.woff2",
  "fonts/jetbrains-mono-latin-ext-wght-normal.woff2",
);
copyPackageFile(
  "@fontsource-variable/jetbrains-mono",
  "files/jetbrains-mono-latin-wght-normal.woff2",
  "fonts/jetbrains-mono-latin-wght-normal.woff2",
);
copyPackageFile(
  "@fontsource-variable/jetbrains-mono",
  "LICENSE",
  "LICENSE-fontsource-jetbrains-mono.txt",
);

const fontCss = `
@font-face {
  font-family: "Inter Variable";
  font-style: normal;
  font-display: swap;
  font-weight: 100 900;
  src: url("/static/vendor/fonts/inter-latin-ext-wght-normal.woff2") format("woff2-variations");
  unicode-range: U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF;
}
@font-face {
  font-family: "Inter Variable";
  font-style: normal;
  font-display: swap;
  font-weight: 100 900;
  src: url("/static/vendor/fonts/inter-latin-wght-normal.woff2") format("woff2-variations");
  unicode-range: U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;
}
@font-face {
  font-family: "JetBrains Mono Variable";
  font-style: normal;
  font-display: swap;
  font-weight: 100 800;
  src: url("/static/vendor/fonts/jetbrains-mono-latin-ext-wght-normal.woff2") format("woff2-variations");
  unicode-range: U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF;
}
@font-face {
  font-family: "JetBrains Mono Variable";
  font-style: normal;
  font-display: swap;
  font-weight: 100 800;
  src: url("/static/vendor/fonts/jetbrains-mono-latin-wght-normal.woff2") format("woff2-variations");
  unicode-range: U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;
}
`.trimStart();

fs.writeFileSync(path.join(vendorDir, "fonts.css"), fontCss, "utf8");
