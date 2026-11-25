const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("@playwright/test");

// Assinatura do técnico por nome na folha impressa do Termo de Entrega: 6 estilos x nomes fictícios. A tinta é isolada por
// diferença entre o bloco com a assinatura e o mesmo bloco sem o SVG (display:none não muda layout: o SVG é absoluto).
// Saída fora do Git: test-results/assinatura-visual/. O segundo teste lê os PNG do primeiro (rode o arquivo inteiro).
const SAIDA = path.join(__dirname, "..", "..", "test-results", "assinatura-visual");
const ESTILOS = ["digitada", "great-vibes", "dancing-script", "allura", "alex-brush", "sacramento"];
const NOMES = [
  "Ana", "Carlos Mendes", "Maria Eduarda Souza", "José da Conceição Gonçalves", "Pedro D'Ávila", "Ana-Clara Peixoto",
  "JOÃO PAULO FERREIRA", "Quitéria Yara Gonçalves Jaqueline",
  "Maria Aparecida dos Santos Albuquerque de Oliveira Gonçalves Pereira Lima",
];
const arquivo = (estilo, i) => path.join(SAIDA, `${estilo}__${String(i + 1).padStart(2, "0")}.png`);

test.use({ deviceScaleFactor: 2 });

async function prepararPagina(page, configRef) {
  await page.route("**/api/assinatura-tecnico/config", route => route.fulfill({ json: configRef.valor }));
  await page.goto("/");
  await page.locator("#cockpit-tools-trigger").click();
  await page.locator("#btn-lembretes").click();
  await page.locator("#termos-aba-entrega").click();
  await page.evaluate(() => { window.__n = 0; window.print = () => { window.__n += 1; }; });
  await page.locator("#termos-entrega-serie-entregue").fill("brj54925dn");
  await page.locator("#termos-entrega-nome").fill("Janaina do Rocio Santos Rocha");
}

async function gerarFolha(page, configRef, estilo, nome) {
  configRef.valor = { estilo, nome };
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.emulateMedia({ media: "screen" });
  const antes = await page.evaluate(() => window.__n);
  await page.locator("#termos-painel-entrega").getByRole("button", { name: "Gerar PDF" }).click();
  await page.waitForFunction(n => window.__n > n, antes);
  await page.emulateMedia({ media: "print" });
  await page.setViewportSize({ width: 794, height: 1123 }); // A4 a 96 dpi: o bloco do técnico fica com ~90 mm reais
  await expect(page.locator("#termos-impressao svg.tp__assinatura-texto")).toHaveText(nome);
  await page.evaluate(() => document.fonts.ready);
}

// Mede o bloco do técnico (px CSS, coordenadas da página inteira); u = px por mm do viewBox do SVG.
async function medirBloco(page) {
  return page.evaluate(() => {
    const bloco = document.querySelectorAll("#termos-impressao .tp__assinatura")[1];
    bloco.scrollIntoView({ block: "center" });
    const r = bloco.getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, u: r.width / 90 };
  });
}
const recorteDe = b => ({ x: Math.max(0, b.x - 10), y: b.y - 18 * b.u - 24, width: b.w + 20, height: 18 * b.u + 24 + b.h + 12 });

// Compara as duas imagens numa página em branco (canvas): caixa da tinta (diferença) e linhas com tinta da folha sem assinatura.
function analisar(aux, com, sem, escala) {
  return aux.evaluate(async ({ com, sem, escala }) => {
    const carregar = src => new Promise(ok => { const i = new Image(); i.onload = () => ok(i); i.src = src; });
    const dados = async b64 => {
      const i = await carregar(`data:image/png;base64,${b64}`);
      const c = document.createElement("canvas"); c.width = i.width; c.height = i.height;
      const x = c.getContext("2d"); x.drawImage(i, 0, 0);
      return x.getImageData(0, 0, i.width, i.height);
    };
    const a = await dados(com), b = await dados(sem);
    const { width: W, height: H } = a;
    let l = W, t = H, r = -1, bt = -1, n = 0;
    const escuros = new Array(H).fill(0), colunas = new Array(H).fill(null);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = (y * W + x) * 4;
      const d = Math.abs(a.data[k] - b.data[k]) + Math.abs(a.data[k + 1] - b.data[k + 1]) + Math.abs(a.data[k + 2] - b.data[k + 2]);
      if (d > 30) { n++; l = Math.min(l, x); r = Math.max(r, x); t = Math.min(t, y); bt = Math.max(bt, y); }
      if (b.data[k] < 200) { escuros[y]++; const c = colunas[y] || (colunas[y] = [x, x]); c[1] = x; }
    }
    // A borda do bloco é a linha mais escura da folha sem assinatura: dela saem a linha, a largura e o topo do rótulo.
    // O recorte também pega a borda da caixa de observações acima (18 mm de margem): vale a última linha longa.
    const maximo = Math.max(...escuros);
    let linha = escuros.findLastIndex(c => c >= maximo * 0.9);
    while (escuros[linha - 1] >= maximo * 0.9) linha--;
    let rotulo = Infinity;
    for (let y = linha + 3; y < H; y++) if (escuros[y]) { rotulo = y; break; }
    return { px: n, esq: l / escala, dir: (r + 1) / escala, topo: t / escala, base: (bt + 1) / escala,
      linhaY: linha / escala, blocoEsq: colunas[linha][0] / escala, blocoDir: (colunas[linha][1] + 1) / escala, rotuloTopo: rotulo / escala };
  }, { com, sem, escala });
}

test("tinta da assinatura por nome: dentro do bloco, abaixo de 18 mm, digitada acima da linha e cursivas sem tocar o rótulo", async ({ page, context }) => {
  test.setTimeout(480_000);
  fs.mkdirSync(SAIDA, { recursive: true });
  const config = { valor: { estilo: "desenho", nome: "" } };
  const aux = await context.newPage();
  await prepararPagina(page, config);
  const relatorio = [];
  for (const estilo of ESTILOS.filter(e => !process.env.ASSINATURA_ESTILO || e === process.env.ASSINATURA_ESTILO)) {
    for (const [i, nome] of NOMES.entries()) {
      await gerarFolha(page, config, estilo, nome);
      const b = await medirBloco(page);
      const clip = recorteDe(b);
      const com = await page.screenshot({ clip, fullPage: true, scale: "device", animations: "disabled" });
      await page.locator("#termos-impressao svg.tp__assinatura-texto").evaluate(s => { s.style.display = "none"; });
      const sem = await page.screenshot({ clip, fullPage: true, scale: "device", animations: "disabled" });
      fs.writeFileSync(arquivo(estilo, i), com); if (i === 3) fs.writeFileSync(arquivo(estilo, i).replace(".png", "-sem.png"), sem);
      const a = await analisar(aux, com.toString("base64"), sem.toString("base64"), 2);
      const { linhaY, blocoEsq: esq, blocoDir: dir, rotuloTopo } = a; // medidos na própria imagem (px CSS do recorte)
      const rotulo = `${estilo} | ${nome}`;
      relatorio.push({ rotulo, tinta: a.px, subida_mm: +((linhaY - a.topo) / b.u).toFixed(2), desc_mm: +((a.base - linhaY) / b.u).toFixed(2),
        folga_esq_mm: +((a.esq - esq) / b.u).toFixed(2), folga_dir_mm: +((dir - a.dir) / b.u).toFixed(2), folga_rotulo_px: +(rotuloTopo - a.base).toFixed(2) });
      expect.soft(a.px, `${rotulo}: há tinta`).toBeGreaterThan(20);
      expect.soft(a.esq, `${rotulo}: tinta à esquerda do bloco`).toBeGreaterThanOrEqual(esq - 0.5);
      expect.soft(a.dir, `${rotulo}: tinta à direita do bloco`).toBeLessThanOrEqual(dir + 0.5);
      expect.soft(a.topo, `${rotulo}: tinta acima dos 18 mm`).toBeGreaterThanOrEqual(linhaY - 18 * b.u - 0.5);
      if (estilo === "digitada") expect.soft(a.base, `${rotulo}: digitada acima da linha (última linha de tinta antes da borda)`).toBeLessThanOrEqual(linhaY);
      else expect.soft(a.base, `${rotulo}: cursiva não chega ao rótulo`).toBeLessThanOrEqual(rotuloTopo);
    }
  }
  fs.writeFileSync(path.join(SAIDA, "medidas.json"), JSON.stringify(relatorio, null, 1));
  await aux.close();
});

// Folha-resumo: linhas = nomes, colunas = estilos, com o nome do estilo no topo.
test("folha-resumo dos recortes", async ({ page }) => {
  test.setTimeout(120_000);
  const img = f => `data:image/png;base64,${fs.readFileSync(f).toString("base64")}`;
  const linhas = NOMES.map((nome, i) => `<tr><th class="n">${nome.length > 40 ? nome.slice(0, 36) + "…" : nome}<br><small>${[...nome].length} car.</small></th>${
    ESTILOS.map(e => `<td><img src="${img(arquivo(e, i))}"></td>`).join("")}</tr>`).join("");
  await page.setViewportSize({ width: 2300, height: 1200 });
  await page.setContent(`<style>body{margin:0;background:#eee;font:14px sans-serif}table{border-collapse:collapse}th,td{border:1px solid #bbb;background:#fff;padding:4px;vertical-align:middle}
    th{background:#222;color:#fff}th.n{background:#444;width:150px;font-weight:400;text-align:left}img{width:340px;display:block}</style>
    <table><tr><th></th>${ESTILOS.map(e => `<th>${e}</th>`).join("")}</tr>${linhas}</table>`);
  await page.screenshot({ path: path.join(SAIDA, "folha-resumo.png"), fullPage: true });
});

// PDF real da folha (página A4 do @page termos) com uma cursiva e com a digitada.
for (const estilo of ["great-vibes", "digitada"]) {
  test(`PDF real da folha com assinatura ${estilo}`, async ({ page }) => {
    const nome = "José da Conceição Gonçalves";
    const config = { valor: { estilo, nome } };
    await prepararPagina(page, config);
    await gerarFolha(page, config, estilo, nome);
    await page.emulateMedia({ media: null });
    const destino = path.join(SAIDA, `folha-${estilo}.pdf`);
    await page.pdf({ path: destino, preferCSSPageSize: true, printBackground: true });
    expect(fs.statSync(destino).size).toBeGreaterThan(1000);
  });
}
