// UCAS smoke-check (headed Playwright, no automation beyond opening the page).
//
// Usage:
//   node automation/ucas/ucas-test.cjs
//   node automation/ucas/ucas-test.cjs "https://services.ucas.com/apply2026/home"
//
// IMPORTANT:
// - Do NOT automate login.

const { chromium } = require('playwright');

(async () => {
  const targetUrl = process.argv[2] || 'https://services.ucas.com/apply2026/home';

  console.log('[ucas:test] Launching Chromium (headed) with slowMo...');
  const browser = await chromium.launch({ headless: false, slowMo: 75 });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log(`[ucas:test] Navigating to: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

  const currentUrl = page.url();
  console.log(`[ucas:test] Current URL: ${currentUrl}`);
  console.log(/ucas\.com/i.test(currentUrl) ? '✅ UCAS detected' : '❌ Not UCAS (URL check failed)');

  console.log('[ucas:test] Browser will stay open. Press Ctrl+C in this terminal when done.');
  await new Promise(() => {});
})();
