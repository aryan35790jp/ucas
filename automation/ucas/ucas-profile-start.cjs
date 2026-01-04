// UCAS: open Profile dashboard and click "Start this section" inside a specific card.
//
// Prereq:
// - Run: node automation/ucas/ucas-auth.cjs (manual login) to create storageState.ucas.json
//
// Usage:
//   node automation/ucas/ucas-profile-start.cjs
//   node automation/ucas/ucas-profile-start.cjs "https://services.ucas.com/apply2026/home"
//   node automation/ucas/ucas-profile-start.cjs --section "Personal details"
//   node automation/ucas/ucas-profile-start.cjs "https://services.ucas.com/apply2026/home/.../application" --section "Personal details"
//
// IMPORTANT:
// - Do NOT automate login.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const STORAGE_STATE_PATH = path.join(__dirname, 'storageState.ucas.json');

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const getFlagValue = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  // Positional args: ignore flag values (e.g. --section "Personal details").
  const flagsWithValues = new Set(['--section']);
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      if (flagsWithValues.has(a)) i++;
      continue;
    }
    positionals.push(a);
  }

  const urlArg = positionals[0];

  return {
    targetUrl: urlArg || 'https://services.ucas.com/apply2026/home',
    section: getFlagValue('--section') || 'Personal details',
    slowMo: flags.has('--fast') ? 0 : 15,
  };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function acceptCookiesIfPresent(page) {
  try {
    const btn = page.getByRole('button', { name: /accept all cookies/i }).first();
    await btn.waitFor({ state: 'visible', timeout: 5_000 });
    await btn.click();
    console.log('[ucas:profile] Accepted cookies');
  } catch {
    // ignore
  }
}

async function clickStartThisSectionInCard(page, sectionTitle) {
  const titleRe = new RegExp(escapeRegExp(sectionTitle), 'i');
  const ctaRe = /\b(start|continue|edit|view|review)\b.*\bsection\b/i;

  // Prefer semantic heading; fall back to plain text if role mapping differs.
  let anchor = page.getByRole('heading', { name: titleRe }).first();
  try {
    await anchor.waitFor({ state: 'visible', timeout: 15_000 });
  } catch {
    anchor = page.getByText(titleRe).first();
    await anchor.waitFor({ state: 'visible', timeout: 15_000 });
  }

  // Find the closest ancestor container that contains a CTA for the section.
  const ancestors = anchor.locator('xpath=ancestor::*[self::article or self::section or self::div]');
  const ancestorCount = await ancestors.count();
  let card = null;

  for (let i = 0; i < Math.min(ancestorCount, 10); i++) {
    const candidate = ancestors.nth(i);
    const link = candidate.getByRole('link', { name: ctaRe }).first();
    const btn = candidate.getByRole('button', { name: ctaRe }).first();
    const text = candidate.getByText(ctaRe).first();

    const linkVisible = await link.isVisible().catch(() => false);
    const btnVisible = await btn.isVisible().catch(() => false);
    const textVisible = await text.isVisible().catch(() => false);
    if (linkVisible || btnVisible || textVisible) {
      card = candidate;
      break;
    }
  }

  if (!card) {
    card = page
      .locator('article, section, div')
      .filter({ has: page.getByText(titleRe) })
      .filter({ has: page.getByText(ctaRe) })
      .first();
  }

  await card.waitFor({ state: 'visible', timeout: 30_000 });
  await card.scrollIntoViewIfNeeded();

  const link = card.getByRole('link', { name: ctaRe }).first();
  const btn = card.getByRole('button', { name: ctaRe }).first();
  const roleBtn = card.locator('[role="button"]').filter({ hasText: ctaRe }).first();

  if (await link.isVisible().catch(() => false)) {
    await link.click();
    return;
  }
  if (await btn.isVisible().catch(() => false)) {
    await btn.click();
    return;
  }
  if (await roleBtn.isVisible().catch(() => false)) {
    await roleBtn.click();
    return;
  }

  const ctaText = card.getByText(ctaRe).first();
  await ctaText.waitFor({ state: 'visible', timeout: 30_000 });
  await ctaText.scrollIntoViewIfNeeded();

  const clickable = ctaText
    .locator(
      'xpath=ancestor::a[1] | ancestor::button[1] | ancestor::*[@role="button"][1] | ancestor::*[@tabindex][1]'
    )
    .first();
  if (await clickable.count()) {
    await clickable.click();
    return;
  }

  await ctaText.click({ force: true });
}

(async () => {
  if (!fs.existsSync(STORAGE_STATE_PATH)) {
    console.error(`[ucas:profile] Missing ${STORAGE_STATE_PATH}`);
    console.error('[ucas:profile] Run: node automation/ucas/ucas-auth.cjs (manual login) first.');
    process.exit(1);
  }

  const { targetUrl, section, slowMo } = parseArgs(process.argv.slice(2));

  console.log('[ucas:profile] Launching Chromium (headed)...');
  const browser = await chromium.launch({ headless: false, slowMo });
  const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  console.log(`[ucas:profile] Navigating to: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await acceptCookiesIfPresent(page);
  console.log(`[ucas:profile] Landed URL: ${page.url()}`);

  console.log(`[ucas:profile] Clicking card: ${section} -> Start this section`);
  try {
    await clickStartThisSectionInCard(page, section);

    // Best-effort wait for SPA navigation/route change.
    const before = page.url();
    try {
      await page.waitForURL((u) => u.toString() !== before, { timeout: 10_000 });
    } catch {
      // No URL change; that's OK for some SPAs.
    }
  } catch (e) {
    console.error('[ucas:profile] Failed to click the requested section card.');
    console.error(`[ucas:profile] URL: ${page.url()}`);
    console.error(e);
    console.error('[ucas:profile] Tip: pass the exact dashboard URL (the /application page) as the first argument.');
    process.exitCode = 1;
  }

  console.log(`[ucas:profile] After click URL: ${page.url()}`);
  console.log('[ucas:profile] Browser will stay open. Press Ctrl+C in this terminal when done.');

  // Keep the Node process alive reliably.
  await new Promise((resolve) => {
    process.on('SIGINT', resolve);
  });
})();
