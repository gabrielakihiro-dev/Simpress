const { test, expect } = require("@playwright/test");

// Cobertura de glifos das 6 famílias da assinatura por nome: o caractere só vale se a largura com a família + monospace
// for igual à largura com a família + serif (senão um dos dois fallbacks entrou no lugar do glifo).
const FAMILIAS = ["Inter Variable", "Great Vibes", "Dancing Script", "Allura", "Alex Brush", "Sacramento"];
// Mesma lista do front (e espelho do servidor): a cobertura vale para exatamente o que o nome aceita.
const { LETRAS, PONTUACAO } = require("../../frontend/src/componentes/assinatura-medida.ts");
const CARACTERES = [...LETRAS, ...PONTUACAO.replace(" ", "")];

test("as 6 famílias da assinatura trazem glifo próprio para todo caractere permitido", async ({ page }) => {
  await page.goto("/");
  const resultado = await page.evaluate(async ({ familias, caracteres }) => {
    const ctx = document.createElement("canvas").getContext("2d");
    const largura = (fonte, texto) => { ctx.font = fonte; return ctx.measureText(texto).width; };
    const saida = {};
    for (const fam of familias) {
      const texto = caracteres.join("") + " ";
      const fonte = `400 200px "${fam}"`;
      const faces = await document.fonts.load(fonte, texto);
      const faltando = [];
      for (const c of caracteres) {
        if (largura(`400 200px "${fam}", monospace`, c) !== largura(`400 200px "${fam}", serif`, c)) faltando.push(c);
      }
      const espaco = largura(`400 200px "${fam}", monospace`, " ");
      saida[fam] = { faces: faces.length, faltando, espaco };
    }
    return saida;
  }, { familias: FAMILIAS, caracteres: CARACTERES });
  for (const fam of FAMILIAS) {
    expect(resultado[fam].faces, `${fam}: faces carregadas`).toBeGreaterThan(0);
    expect(resultado[fam].espaco, `${fam}: espaço mede algo`).toBeGreaterThan(0);
    expect(resultado[fam].faltando, `${fam}: caracteres sem glifo`).toEqual([]);
  }
});
