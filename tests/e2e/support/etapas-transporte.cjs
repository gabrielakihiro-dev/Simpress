const { expect } = require("@playwright/test");

// Transporte (novo layout): cada etapa é um cartão recolhível e o corpo recolhido fica com `hidden`, então campo de
// etapa fechada não recebe clique nem preenchimento. Abre as etapas pedidas (1 Equipamento, 2 Retirada, 3 Entrega,
// 4 Agenda) pelo botão do cabeçalho, sem fechar as que já estão abertas.
async function abrirEtapaTransporte(page, ...etapas) {
  for (const etapa of etapas) {
    const gatilho = page.locator(`#nlt-gatilho-${etapa}`);
    if ((await gatilho.getAttribute("aria-expanded")) !== "true") await gatilho.click();
    await expect(gatilho).toHaveAttribute("aria-expanded", "true");
  }
}

module.exports = { abrirEtapaTransporte };
