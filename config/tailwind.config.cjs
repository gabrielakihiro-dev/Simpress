module.exports = {
  content: ["../static/index.html", "../static/app.js", "../static/js/**/*.js", "../static/pages/**/*.html"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter Variable", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono Variable", "ui-monospace", "monospace"],
      },
      colors: {
        brand: {
          50: "#f0f7ff",
          100: "#e0effe",
          200: "#bae0fd",
          300: "#7cc7fb",
          400: "#38a9f7",
          500: "#0e8ce9",
          600: "#026fc7",
          700: "#0358a1",
          800: "#074b85",
          900: "#0c3f6e",
          950: "#082849",
        },
        simpress: {
          blue: "#004B87",
          cyan: "#00A3E0",
          accent: "#FF6B00",
        },
        sebrae: {
          blue: "#005CA9",
          yellow: "#FFCC00",
        },
      },
      boxShadow: {
        "glow-blue": "0 0 25px -5px rgba(14, 140, 233, 0.4)",
        "glow-emerald": "0 0 25px -5px rgba(16, 185, 129, 0.4)",
      },
    },
  },
};
