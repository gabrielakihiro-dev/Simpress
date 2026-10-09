// Called only by the guarded local Auth rehearsal. Credentials stay in process
// environment and are never written into Playwright traces or reports.
const {chromium} = require('@playwright/test');
const assert = require('node:assert/strict');
let step = 0;
(async () => {
  step = 1;
  const browser = await chromium.launch({headless:true});
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    step = 2;
    await page.goto('http://127.0.0.1:8007/');
    await page.waitForURL('**/login');
    await page.locator('#email').fill(process.env.SIMPRESS_TEST_EMAIL);
    await page.locator('#password').fill(process.env.SIMPRESS_TEST_PASSWORD);
    await page.locator('#submit').click();
    step = 3;
    await page.waitForURL('http://127.0.0.1:8007/');
    await page.locator('.header-secondary-actions > summary').click();
    await page.locator('#btn-auth-logout').waitFor({state:'visible'});
    step = 4;
    assert.equal((await page.evaluate(() => fetch('/api/stats').then(r=>r.status))),200);
    assert.equal(await page.evaluate(() => localStorage.getItem('access_token')),null);
    const cookie = (await context.cookies()).find(cookie=>cookie.name==='simpress_session');
    assert(cookie.httpOnly && cookie.sameSite==='Strict' && !cookie.secure);
    await page.reload();
    step = 5;
    await page.locator('.header-secondary-actions > summary').click();
    await page.locator('#btn-auth-logout').waitFor({state:'visible'});
    await page.locator('#btn-auth-logout').click();
    step = 6;
    await page.waitForURL('**/login');
    assert.equal((await context.request.get('http://127.0.0.1:8007/api/stats')).status(),401);
    await context.close();
  } finally { await browser.close(); }
})().catch(() => { console.error('Local Auth browser assertion failed at step '+step); process.exitCode=1; });
