// Open UCAS using a previously-saved authenticated session.
//
// Prereq:
// - Run: node automation/ucas/ucas-auth.cjs (manual login) to create storageState.ucas.json
//
// Usage:
//   node automation/ucas/ucas-open.cjs
//   node automation/ucas/ucas-open.cjs "https://services.ucas.com/apply2026/home"

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const STORAGE_STATE_PATH = path.join(__dirname, 'storageState.ucas.json');

(async () => {
  if (!fs.existsSync(STORAGE_STATE_PATH)) {
    console.error(`[ucas:open] Missing ${STORAGE_STATE_PATH}`);
    console.error('[ucas:open] Run: node automation/ucas/ucas-auth.cjs (manual login) first.');
    process.exit(1);
  }

  const targetUrl = process.argv[2] || 'https://services.ucas.com/apply2026/home';

  console.log('[ucas:open] Launching Chromium (headed) with slowMo...');
  const browser = await chromium.launch({ headless: false, slowMo: 75 });

  const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
  const page = await context.newPage();

  console.log(`[ucas:open] Navigating to: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

  const currentUrl = page.url();
  console.log(`[ucas:open] Current URL: ${currentUrl}`);
  console.log(/ucas\.com/i.test(currentUrl) ? '✅ UCAS detected' : '❌ Not UCAS (URL check failed)');

  console.log('[ucas:open] Browser will stay open. Press Ctrl+C in this terminal when done.');
  await new Promise(() => {});
})();
