const { test, expect } = require("@playwright/test");

test("Home Endpoint action shows last-logon user, blank, missing, ambiguity and access error", async ({ page }) => {
  let response = { status: "found", serial: "LENTO", ultimo_logon: "Usuário de teste" };
  let status = 200;
  await page.route("**/api/endpoint/consultar", async route => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ serial: "LENTO" });
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(response) });
  });
  await page.goto("/");
  await page.locator("#input-serial").fill("LENTO");
  await page.locator("#btn-buscar-serial").click();
  const button = page.locator("#btn-consultar-endpoint");
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.locator("#endpoint-lookup-result")).toHaveText("Usuário do último logon: Usuário de teste");
  for (const [body, expected] of [
    [{ status: "found", serial: "LENTO", ultimo_logon: "" }, "Equipamento encontrado no Endpoint, sem usuário do último logon informado."],
    [{ status: "not_found", serial: "LENTO" }, "Equipamento não encontrado no Endpoint"],
    [{ status: "ambiguous", serial: "LENTO" }, "Mais de um equipamento encontrado no Endpoint para esta série. Confira as duplicidades."],
  ]) {
    response = body;
    await button.click();
    await expect(page.locator("#endpoint-lookup-result")).toHaveText(expected);
  }
  status = 503;
  response = { detail: "Login do Endpoint indisponível" };
  await button.click();
  await expect(page.locator("#endpoint-lookup-result")).toHaveText("Login do Endpoint indisponível");
  await page.locator("#input-serial").fill("OUTRA");
  await expect(page.locator("#card-equipamento")).toBeHidden();
  await expect(button).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
