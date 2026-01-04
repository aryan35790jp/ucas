// UCAS manual-auth capture (headed Playwright).
//
// What it does:
// - Opens UCAS in a headed browser
// - You log in MANUALLY
// - When you press Enter in the terminal, it saves storage state to automation/ucas/storageState.ucas.json
//
// Usage:
//   node automation/ucas/ucas-auth.cjs
//
// IMPORTANT:
// - Do NOT automate login.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const STORAGE_STATE_PATH = path.join(__dirname, 'storageState.ucas.json');

function waitForEnter() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', () => resolve());
  });
}

(async () => {
  const targetUrl = 'https://services.ucas.com/apply2026/home';

  console.log('[ucas:auth] Launching Chromium (headed) with slowMo...');
  const browser = await chromium.launch({ headless: false, slowMo: 15 });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log(`[ucas:auth] Navigating to: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

  console.log('[ucas:auth] Log in MANUALLY in the browser, then press Enter here to save storage state.');
  await waitForEnter();

  const state = await context.storageState();
  fs.writeFileSync(STORAGE_STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`[ucas:auth] Wrote: ${STORAGE_STATE_PATH}`);

  await browser.close();
})();
