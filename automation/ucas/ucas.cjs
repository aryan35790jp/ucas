// UCAS runner: reuse a previously-saved session when possible.
//
// Behavior:
// - If automation/ucas/storageState.ucas.json exists: open UCAS authenticated.
// - Otherwise: open UCAS, you log in MANUALLY, press Enter in terminal to save state,
//   then it continues (same run) with the saved session.
//
// Usage:
//   node automation/ucas/ucas.cjs
//   node automation/ucas/ucas.cjs "https://services.ucas.com/apply2026/home"
//   node automation/ucas/ucas.cjs --fresh
//   node automation/ucas/ucas.cjs --clear-state
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
  const flagsWithValues = new Set(['--delay-ms', '--speed', '--slowmo', '--section']);
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
  const delayMsRaw = getFlagValue('--delay-ms');

  const universal = flags.has('--universal') || flags.has('--run-all');

  // Speed tuning:
  // - By default, keep runs human-observable.
  // - For --run-all, auto-speed up ~4x unless user explicitly sets speed/slowmo/delay-ms.
  const slowMoRaw = getFlagValue('--slowmo');
  const speedRaw = getFlagValue('--speed');
  const shouldAutoSpeedUp =
    universal &&
    speedRaw === undefined &&
    delayMsRaw === undefined &&
    slowMoRaw === undefined &&
    !flags.has('--fast');
  const speedDefault = shouldAutoSpeedUp ? 4 : 1;

  const speed = Math.max(0.1, Number(speedRaw ?? speedDefault));

  const baseDelayMs = flags.has('--fast') ? 0 : Math.max(0, Number(delayMsRaw ?? 1000));
  const delayMs = Math.round(baseDelayMs / speed);

  const baseSlowMo = flags.has('--fast') ? 0 : Math.max(0, Number(slowMoRaw ?? 15));
  const slowMo = Math.round(baseSlowMo / speed);

  const randomTitle = universal || flags.has('--random-title') || flags.has('--random-title-value');
  const fillPersonalNames =
    universal ||
    flags.has('--fill-personal-names') ||
    flags.has('--fill-personal') ||
    flags.has('--fill-names');
  const randomDob =
    universal ||
    flags.has('--random-dob') ||
    flags.has('--random-birth') ||
    flags.has('--random-date-of-birth');
  const randomGender =
    universal ||
    flags.has('--random-gender') ||
    flags.has('--random-sex') ||
    flags.has('--random-gender-choice');
  const markComplete =
    universal || flags.has('--mark-complete') || flags.has('--complete') || flags.has('--mark-section-complete');
  const saveSection =
    universal || flags.has('--save-section') || flags.has('--save') || flags.has('--submit-section');

  // Convenience: if you opt into the full autofill flow, also try to click "Start this section".
  // This matches how most runs are used (from the dashboard cards) and avoids a common foot-gun.
  const start = flags.has('--start') || flags.has('--auto-start') || universal;

  return {
    targetUrl: urlArg || 'https://services.ucas.com/apply2026/home',
    fresh: flags.has('--fresh'),
    clearState: flags.has('--clear-state'),
    start,
    section: getFlagValue('--section') || 'Personal details',
    universal,
    randomTitle,
    fillPersonalNames,
    randomDob,
    randomGender,
    markComplete,
    saveSection,
    speed,
    slowMo,
    delayMs,
  };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function waitForEnter() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', () => resolve());
  });
}

function isLikelyLoginUrl(url) {
  return /\b(login|sign-?in|signin|auth)\b/i.test(url);
}

async function isPasswordFieldVisible(page) {
  return await page
    .locator('input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false);
}

async function isLikelyLoggedIn(page) {
  const url = page.url() || '';
  // UCAS dashboard is a strong signal of being logged in.
  if (/ucas\.com\/dashboard\b/i.test(url)) return true;
  if (/services\.ucas\.com\/apply\d+\//i.test(url)) return true;

  // Best-effort heuristics: UCAS typically shows a logout/sign-out control when authenticated.
  // We intentionally keep this broad to survive minor UI changes.
  const signOut = await page
    .getByRole('link', { name: /log\s*out|sign\s*out/i })
    .first()
    .isVisible()
    .catch(() => false);
  if (signOut) return true;

  const signOutBtn = await page
    .getByRole('button', { name: /log\s*out|sign\s*out/i })
    .first()
    .isVisible()
    .catch(() => false);
  if (signOutBtn) return true;

  // A less direct marker: the application home typically contains "Your application".
  const appHome = await page
    .getByText(/your application/i)
    .first()
    .isVisible()
    .catch(() => false);
  return appHome;
}

async function waitForManualLogin(page, delayMs, timeoutMs = 10 * 60 * 1000) {
  let url = '';
  try {
    url = page.url();
  } catch {
    url = '';
  }

  let hasPw = false;
  try {
    hasPw = await isPasswordFieldVisible(page);
  } catch {
    hasPw = false;
  }

  // Fast path: already looks logged in.
  try {
    if (!isLikelyLoginUrl(url) && !hasPw) {
      const loggedIn = await isLikelyLoggedIn(page).catch(() => false);
      if (loggedIn) return true;
    }
  } catch {
    // ignore
  }

  console.log(`[ucas] Waiting for login to complete... URL: ${url}`);
  console.log('[ucas] Complete login manually in the browser (I will not proceed until detected).');
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    // Never let navigation quirks crash the wait loop.
    try {
      await pause(page, 750);
    } catch {
      // ignore
    }

    let nowUrl = '';
    try {
      nowUrl = page.url();
    } catch {
      nowUrl = '';
    }

    let nowHasPw = false;
    try {
      nowHasPw = await isPasswordFieldVisible(page);
    } catch {
      nowHasPw = false;
    }

    const looksLikeLogin = isLikelyLoginUrl(nowUrl) || nowHasPw;
    if (looksLikeLogin) continue;

    let loggedIn = false;
    try {
      loggedIn = await isLikelyLoggedIn(page).catch(() => false);
    } catch {
      loggedIn = false;
    }

    if (loggedIn) {
      console.log(`[ucas] Login detected ✅ URL: ${nowUrl}`);
      try {
        await pause(page, delayMs);
      } catch {
        // ignore
      }
      return true;
    }
  }

  console.log('[ucas] Login wait timed out. Not proceeding with autofill.');
  return false;
}

async function writeDebugArtifact(page, reason) {
  try {
    const outDir = path.join(__dirname, 'artifacts');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(outDir, `ucas-debug-${stamp}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`[ucas] Wrote debug screenshot (${reason}): ${file}`);
  } catch {
    // ignore
  }
}

async function gotoWithRetries(page, url, { waitUntil = 'domcontentloaded', timeout = 60_000, attempts = 3 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await page.goto(url, { waitUntil, timeout });
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message ?? e);
      const retryable = /net::ERR_ABORTED|frame was detached|Navigation.*interrupted|Execution context was destroyed/i.test(msg);

      if (!retryable || i === attempts) {
        try {
          await writeDebugArtifact(page, 'goto-failed');
        } catch {
          // ignore
        }
        throw e;
      }

      console.log(`[ucas] Navigation failed (attempt ${i}/${attempts}): ${msg.split('\n')[0]}`);
      try {
        await page.waitForTimeout(Math.min(1000 * i, 3000));
      } catch {
        // ignore
      }
    }
  }
  throw lastErr;
}

async function pause(page, ms) {
  if (!ms) return;
  await page.waitForTimeout(ms);
}

async function step(desc, fn) {
  console.log(`[ucas] ${desc}...`);
  const out = await fn();
  console.log(`[ucas] ${desc} ✅`);
  return out;
}

async function acceptCookiesIfPresent(page, delayMs) {
  // UCAS sometimes shows a cookie consent dialog. This is safe to automate.
  // Best-effort: do not fail the run if it isn't shown.
  try {
    const btn = page.getByRole('button', { name: /accept all cookies/i }).first();
    await btn.waitFor({ state: 'visible', timeout: 5_000 });
    await step('Clicking Accept all cookies', async () => {
      await btn.scrollIntoViewIfNeeded();
      await pause(page, delayMs);
      await btn.click();
      await pause(page, delayMs);
    });
  } catch {
    // ignore
  }
}

async function clickGoToApplicationIfPresent(page, delayMs) {
  // On https://www.ucas.com/dashboard#/ a "Go to application" CTA takes you to services.ucas.com.
  // Best-effort: if we don't find it, continue.
  try {
    const btn = page.getByRole('button', { name: /go to application/i }).first();
    await btn.waitFor({ state: 'visible', timeout: 7_500 });
    const before = page.url();
    await step('Clicking Go to application', async () => {
      await btn.scrollIntoViewIfNeeded();
      await pause(page, delayMs);
      await btn.click();
      await pause(page, delayMs);
    });

    // Wait for navigation away from dashboard (may be SPA/redirect).
    try {
      await page.waitForURL(
        (u) => u.toString() !== before && !/ucas\.com\/dashboard\b/i.test(u.toString()),
        { timeout: 20_000 }
      );
    } catch {
      // ignore
    }
    console.log(`[ucas] After Go to application, URL: ${page.url()}`);
  } catch {
    // Fallback: sometimes it's a link.
    try {
      const link = page.getByRole('link', { name: /go to application/i }).first();
      await link.waitFor({ state: 'visible', timeout: 5_000 });
      const before = page.url();
      await step('Clicking Go to application (link)', async () => {
        await link.scrollIntoViewIfNeeded();
        await pause(page, delayMs);
        await link.click();
        await pause(page, delayMs);
      });
      try {
        await page.waitForURL((u) => u.toString() !== before, { timeout: 20_000 });
      } catch {
        // ignore
      }
      console.log(`[ucas] After Go to application, URL: ${page.url()}`);
    } catch {
      // ignore
    }
  }
}

async function clickStartThisSectionInCard(page, sectionTitle, delayMs) {
  const titleRe = new RegExp(escapeRegExp(sectionTitle), 'i');
  const ctaRe = /\b(start|continue|edit|view|review)\b.*\bsection\b/i;

  // Anchor on the section title (prefer heading role).
  let anchor = page.getByRole('heading', { name: titleRe }).first();
  try {
    await anchor.waitFor({ state: 'visible', timeout: 7_500 });
  } catch {
    anchor = page.getByText(titleRe).first();
    await anchor.waitFor({ state: 'visible', timeout: 7_500 });
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
    // Last-resort fallback: a container that has the title and any CTA-ish text.
    card = page
      .locator('article, section, div')
      .filter({ has: page.getByText(titleRe) })
      .filter({ has: page.getByText(ctaRe) })
      .first();
  }

  await card.waitFor({ state: 'visible', timeout: 15_000 });
  await card.scrollIntoViewIfNeeded();

  // Prefer clicking the actual link/button with an accessible name.
  const link = card.getByRole('link', { name: ctaRe }).first();
  const btn = card.getByRole('button', { name: ctaRe }).first();
  const roleBtn = card.locator('[role="button"]').filter({ hasText: ctaRe }).first();

  const clickWithPause = async (locator) => {
    await pause(page, delayMs);
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await pause(page, delayMs);
    await locator.click();
    await pause(page, delayMs);
  };

  if (await link.isVisible().catch(() => false)) {
    await clickWithPause(link);
    return;
  }
  if (await btn.isVisible().catch(() => false)) {
    await clickWithPause(btn);
    return;
  }
  if (await roleBtn.isVisible().catch(() => false)) {
    await clickWithPause(roleBtn);
    return;
  }

  // Fallback: click the closest clickable ancestor of the CTA text.
  const ctaText = card.getByText(ctaRe).first();
  await ctaText.waitFor({ state: 'visible', timeout: 10_000 });
  await ctaText.scrollIntoViewIfNeeded();
  const clickable = ctaText
    .locator('xpath=ancestor::a[1] | ancestor::button[1] | ancestor::*[@role="button"][1] | ancestor::*[@tabindex][1]')
    .first();

  if (await clickable.count()) {
    await clickWithPause(clickable);
  } else {
    await pause(page, delayMs);
    await ctaText.click({ force: true });
    await pause(page, delayMs);
  }
}

async function ensureOnPersonalDetailsPage(page, delayMs) {
  // UCAS "Personal details" is a section with multiple subpages.
  // After clicking "Start this section" UCAS may route you to the last/next subpage
  // (e.g. /details/nationality). For autofilling Title/names/DOB/gender we need the
  // first "Personal details" subpage.
  const url = page.url() || '';
  if (/\/application\/details\/personal\b/i.test(url)) return;

  const buildDetailsUrl = (currentUrl, slug) => {
    const m = String(currentUrl).match(/^(https?:\/\/[^/]+\/apply\d+\/home\/[^/]+\/application)\b/i);
    if (m) return `${m[1]}/details/${slug}`;
    return null;
  };

  // Prefer the left navigation link (more stable than guessing routes).
  const linkExact = page.getByRole('link', { name: /^\s*personal details\s*$/i }).first();
  const linkAny = page.getByRole('link', { name: /personal details/i }).first();
  const linkHref = page.locator('a[href*="/application/details/personal"], a[href*="/details/personal"]').first();

  const tryClick = async (loc) => {
    if (!(await loc.count().catch(() => 0))) return false;
    const vis = await loc.isVisible().catch(() => false);
    if (!vis) return false;
    const before = page.url();
    await step('Navigating to Personal details subpage (left nav)', async () => {
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await pause(page, delayMs);
      await loc.click({ force: true });
      await pause(page, delayMs);
    });

    // Best-effort wait: SPA may or may not update the URL.
    try {
      await page.waitForURL(/\/application\/details\/personal\b/i, { timeout: 10_000 });
      return true;
    } catch {
      try {
        await page.waitForURL((u) => u.toString() !== before, { timeout: 5_000 });
        return /\/application\/details\/personal\b/i.test(page.url() || '');
      } catch {
        // Still might have navigated without URL change; continue.
        return /personal details/i.test(page.url() || '');
      }
    }
  };

  if (await tryClick(linkExact)) return;
  if (await tryClick(linkHref)) return;

  // Some UCAS states (e.g. section already complete) show "Personal details" as a non-link
  // header in the left nav, so we can't click it. In that case, try direct navigation.
  if (await tryClick(linkAny)) return;

  const direct = buildDetailsUrl(page.url() || url, 'personal');
  if (!direct) return;
  try {
    const before = page.url();
    await step('Navigating to Personal details subpage (direct URL)', async () => {
      await pause(page, delayMs);
      await gotoWithRetries(page, direct, { waitUntil: 'domcontentloaded', attempts: 2 });
      await pause(page, delayMs);
    });

    try {
      await page.waitForURL(/\/application\/details\/personal\b/i, { timeout: 10_000 });
      return;
    } catch {
      // Some SPA transitions don't update the URL instantly; accept any change as progress.
      await page.waitForURL((u) => u.toString() !== before, { timeout: 5_000 }).catch(() => {});
    }
  } catch {
    // ignore
  }
}

async function selectRandomOptionByLabel(page, fieldLabel, delayMs) {
  const labelRe = new RegExp(`^\\s*${escapeRegExp(fieldLabel)}\\s*(\\*)?\\s*$`, 'i');

  const resolveControl = async () => {
    // 1) Ideal: correctly-associated accessible label.
    const byLabel = page.getByLabel(labelRe).first();
    if ((await byLabel.count().catch(() => 0)) > 0) return byLabel;

    // 2) Common for styled selects: role=combobox with accessible name.
    const byRole = page.getByRole('combobox', { name: labelRe }).first();
    if ((await byRole.count().catch(() => 0)) > 0) return byRole;

    // 3) Fallback: find visible text for the label and grab the nearest control.
    const labelText = page.getByText(labelRe).first();
    if ((await labelText.count().catch(() => 0)) > 0) {
      const container = labelText.locator(
        'xpath=ancestor::*[self::label or self::fieldset or self::section or self::div][.//select or .//*[@role="combobox"] or .//input][1]'
      );
      const candidate = container.locator('select, [role="combobox"], input').first();
      if ((await candidate.count().catch(() => 0)) > 0) return candidate;
    }

    // 4) Let the original approach throw a helpful timeout.
    return byLabel;
  };

  const control = await resolveControl();
  await control.waitFor({ state: 'visible', timeout: 15_000 });
  await control.scrollIntoViewIfNeeded();

  const tagName = await control.evaluate((el) => (el?.tagName || '').toLowerCase()).catch(() => '');
  if (tagName === 'select') {
    await selectRandomOption(page, control, fieldLabel, delayMs);
    return;
  }

  const role = await control.getAttribute('role').catch(() => null);
  const hasPopup = await control.getAttribute('aria-haspopup').catch(() => null);
  if (role === 'combobox' || /listbox/i.test(hasPopup || '')) {
    await selectRandomComboboxOption(page, control, fieldLabel, delayMs);
    return;
  }

  // Unknown control type; best-effort attempt.
  await selectRandomOption(page, control, fieldLabel, delayMs);
}

async function selectRandomComboboxOption(page, combobox, labelForLogs, delayMs) {
  const quotedIdSelector = (id) => {
    const safe = String(id).replace(/"/g, '\\"');
    return `[id="${safe}"]`;
  };

  await step(`Opening ${labelForLogs} dropdown`, async () => {
    await combobox.scrollIntoViewIfNeeded();
    await pause(page, delayMs);
    await combobox.click({ timeout: 5_000, force: true });
    await pause(page, delayMs);
  });

  // Prefer the listbox referenced by the combobox if available.
  const listboxId =
    (await combobox.getAttribute('aria-controls').catch(() => null)) ||
    (await combobox.getAttribute('aria-owns').catch(() => null));

  let listbox = listboxId ? page.locator(quotedIdSelector(listboxId)) : page.getByRole('listbox').last();
  try {
    await listbox.waitFor({ state: 'visible', timeout: 10_000 });
  } catch {
    // Broader fallback if the listbox role isn't used.
    listbox = page.locator('[role="listbox"], [data-testid*="listbox"], ul, div').filter({ has: page.getByRole('option') }).last();
    await listbox.waitFor({ state: 'visible', timeout: 10_000 });
  }

  const optionsLocator = listbox.getByRole('option');
  const options = await optionsLocator.evaluateAll((nodes) =>
    nodes
      .map((n) => {
        const text = (n.innerText || n.textContent || '').trim();
        const disabled = n.getAttribute('aria-disabled') === 'true';
        return { text, disabled };
      })
      .filter((o) => o.text)
  );

  const candidates = options.filter((o) => {
    if (o.disabled) return false;
    return !/select|please choose|choose|--/i.test(o.text);
  });
  if (!candidates.length) throw new Error(`No selectable options found for ${labelForLogs}`);

  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  const pickRe = new RegExp(`^\\s*${escapeRegExp(pick.text)}\\s*$`, 'i');
  await step(`Selecting ${labelForLogs} = ${pick.text}`, async () => {
    await pause(page, delayMs);
    await optionsLocator.filter({ hasText: pickRe }).first().click({ force: true });
    await pause(page, delayMs);
  });
}

async function selectRandomOption(page, selectLocator, labelForLogs, delayMs) {
  const options = await selectLocator.locator('option').evaluateAll((nodes) =>
    nodes.map((o) => ({
      value: o.value,
      label: (o.label || o.textContent || '').trim(),
      disabled: !!o.disabled,
    }))
  );

  const candidates = options.filter((o) => {
    if (o.disabled) return false;
    if (!o.value) return false;
    if (!o.label) return false;
    // Filter out placeholder-like options.
    return !/select|please choose|choose|--|dd\b|mm\b|yyyy\b/i.test(o.label);
  });

  if (!candidates.length) {
    throw new Error(`No selectable options found for ${labelForLogs}`);
  }

  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  await step(`Selecting ${labelForLogs} = ${pick.label}`, async () => {
    await selectLocator.scrollIntoViewIfNeeded();
    await pause(page, delayMs);
    // Click first so the UX matches what you see.
    await selectLocator.click({ timeout: 5_000 }).catch(() => {});
    await pause(page, delayMs);
    await selectLocator.selectOption({ value: pick.value });
    await pause(page, delayMs);
  });
}

function randomInt(minInclusive, maxInclusive) {
  return Math.floor(Math.random() * (maxInclusive - minInclusive + 1)) + minInclusive;
}

function randomToken(len = 6) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[randomInt(0, alphabet.length - 1)];
  return out;
}

function toTitleCase(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function randomNameWord() {
  return toTitleCase(randomToken(randomInt(4, 8)));
}

async function fillTextByLabel(page, labelText, value, delayMs) {
  // Matches labels like "Last name" or "Last name *"
  const re = new RegExp(`${escapeRegExp(labelText)}\\s*(\\*)?`, 'i');

  const resolveInput = async () => {
    const byLabel = page.getByLabel(re).first();
    if ((await byLabel.count().catch(() => 0)) > 0) return byLabel;

    const labelLine = page.getByText(new RegExp(`^\\s*${escapeRegExp(labelText)}\\s*(\\*)?\\s*$`, 'i')).first();
    if ((await labelLine.count().catch(() => 0)) > 0) {
      const container = labelLine.locator(
        'xpath=ancestor::*[self::label or self::fieldset or self::section or self::div][.//input or .//textarea][1]'
      );
      const candidate = container.locator('input, textarea').first();
      if ((await candidate.count().catch(() => 0)) > 0) return candidate;
    }

    return byLabel;
  };

  const input = await resolveInput();
  await input.waitFor({ state: 'visible', timeout: 15_000 });
  await input.scrollIntoViewIfNeeded();
  await step(`Filling ${labelText}`, async () => {
    await pause(page, delayMs);
    await input.click({ timeout: 5_000, force: true }).catch(async () => {
      await input.focus();
    });
    await pause(page, delayMs);
    await input.fill(value);
    await pause(page, delayMs);
  });
  console.log(`[ucas] Set ${labelText}: ${value}`);
}

async function selectRandomDob(page, delayMs) {
  // Prefer selecting by accessible labels Day/Month/Year.
  const byLabel = async (label) => {
    const re = new RegExp(`^\\s*${escapeRegExp(label)}\\s*(\\*)?\\s*$`, 'i');
    const select = page.getByLabel(re).first();
    await select.waitFor({ state: 'visible', timeout: 10_000 });
    await select.scrollIntoViewIfNeeded();
    await selectRandomOption(page, select, label, delayMs);
  };

  // Fallback: locate the Date of birth block and pick the first three selects.
  const dobAnchor = page.getByText(/date of birth/i).first();
  await dobAnchor.waitFor({ state: 'visible', timeout: 15_000 });

  const dobBlock = dobAnchor.locator(
    'xpath=ancestor::*[self::fieldset or self::section or self::div][.//select][1]'
  );
  await dobBlock.waitFor({ state: 'visible', timeout: 15_000 });
  await dobBlock.scrollIntoViewIfNeeded();

  const selects = dobBlock.locator('select');
  const count = await selects.count();
  if (count < 3) throw new Error('DOB selects not found');

  const fallback = async (idx, label) => {
    const select = selects.nth(idx);
    await select.waitFor({ state: 'visible', timeout: 10_000 });
    await select.scrollIntoViewIfNeeded();
    await selectRandomOption(page, select, label, delayMs);
  };

  // Do each field independently (no all-or-nothing).
  try {
    await byLabel('Day');
  } catch {
    await fallback(0, 'Day');
  }
  try {
    await byLabel('Month');
  } catch {
    await fallback(1, 'Month');
  }
  try {
    await byLabel('Year');
  } catch {
    await fallback(2, 'Year');
  }
}

async function selectRandomGender(page, delayMs) {
  const options = [
    { label: 'Man', re: /^\s*man\s*$/i },
    { label: 'Woman', re: /^\s*woman\s*$/i },
    { label: 'I use another term', re: /use another term/i },
    { label: 'I prefer not to say', re: /prefer not to say/i },
  ];
  const pick = options[Math.floor(Math.random() * options.length)];

  // First try: radios are often correctly exposed with role=radio.
  const radioAny = page.getByRole('radio', { name: pick.re }).first();
  if (await radioAny.count()) {
    const visible = await radioAny.isVisible().catch(() => false);
    if (visible) {
      await step(`Clicking Gender = ${pick.label}`, async () => {
        await pause(page, delayMs);
        await radioAny.scrollIntoViewIfNeeded();
        await pause(page, delayMs);
        await radioAny.click();
        await pause(page, delayMs);
      });
      return;
    }

    // If the <input> is hidden (common with styled radios), click its <label for="...">.
    const id = await radioAny.getAttribute('id');
    if (id) {
      const labelFor = page.locator(`label[for="${id}"]`).first();
      if (await labelFor.count()) {
        await step(`Clicking Gender = ${pick.label}`, async () => {
          await pause(page, delayMs);
          await labelFor.scrollIntoViewIfNeeded();
          await pause(page, delayMs);
          await labelFor.click();
          await pause(page, delayMs);
        });
        return;
      }
    }
  }

  // Otherwise, scope to a container that contains the word Gender and the target option text.
  const genderAnchor = page.getByText(/gender/i).first();
  await genderAnchor.waitFor({ state: 'visible', timeout: 15_000 });

  const genderBlock = page
    .locator('fieldset, section, div')
    .filter({ hasText: /gender/i })
    .filter({ has: page.getByText(pick.re) })
    .first();

  await genderBlock.waitFor({ state: 'visible', timeout: 15_000 });
  await genderBlock.scrollIntoViewIfNeeded();

  // Prefer clicking an input/label by its text.
  const labelText = genderBlock.getByText(pick.re).first();
  await labelText.waitFor({ state: 'visible', timeout: 10_000 });
  await step(`Clicking Gender = ${pick.label}`, async () => {
    await pause(page, delayMs);
    await labelText.scrollIntoViewIfNeeded();
    await pause(page, delayMs);
    const clickable = labelText
      .locator(
        'xpath=ancestor::label[1] | ancestor::button[1] | ancestor::*[@role="radio"][1] | ancestor::*[@tabindex][1]'
      )
      .first();
    if (await clickable.count()) {
      await clickable.click();
    } else {
      await labelText.click({ force: true });
    }
    await pause(page, delayMs);
  });
}

async function clickMarkSectionComplete(page, delayMs) {
  const checkbox = page.getByRole('checkbox', { name: /mark this section as complete/i }).first();

  // If it's visible and clickable, use it.
  if (await checkbox.count()) {
    const visible = await checkbox.isVisible().catch(() => false);
    if (visible) {
      const alreadyChecked = await checkbox.isChecked().catch(() => false);
      if (alreadyChecked) {
        console.log('[ucas] Mark this section as complete: already checked');
        return;
      }
      await step('Clicking Mark this section as complete', async () => {
        await pause(page, delayMs);
        await checkbox.scrollIntoViewIfNeeded();
        await pause(page, delayMs);
        await checkbox.check();
        await pause(page, delayMs);
      });
      return;
    }

    // Checkbox exists but may be hidden; click associated label.
    const id = await checkbox.getAttribute('id');
    if (id) {
      const labelFor = page.locator(`label[for="${id}"]`).first();
      if (await labelFor.count()) {
        await step('Clicking Mark this section as complete', async () => {
          await pause(page, delayMs);
          await labelFor.scrollIntoViewIfNeeded();
          await pause(page, delayMs);
          await labelFor.click();
          await pause(page, delayMs);
        });
        return;
      }
    }
  }

  // Fallback: click the visible text near it.
  const text = page.getByText(/mark this section as complete/i).first();
  await text.waitFor({ state: 'visible', timeout: 15_000 });
  await step('Clicking Mark this section as complete', async () => {
    await pause(page, delayMs);
    await text.scrollIntoViewIfNeeded();
    await pause(page, delayMs);
    const clickable = text
      .locator('xpath=ancestor::label[1] | ancestor::button[1] | ancestor::*[@role="checkbox"][1] | ancestor::*[@tabindex][1]')
      .first();
    if (await clickable.count()) {
      await clickable.click();
    } else {
      await text.click({ force: true });
    }
    await pause(page, delayMs);
  });
}

async function clickSaveThisSection(page, delayMs) {
  const btn = page.getByRole('button', { name: /save this section/i }).first();
  await btn.waitFor({ state: 'visible', timeout: 20_000 });
  await step('Clicking Save this section', async () => {
    await pause(page, delayMs);
    await btn.scrollIntoViewIfNeeded();
    await pause(page, delayMs);
    await btn.click();
  });

  // After saving, UCAS often re-renders the page; wait briefly so the next click
  // ("Next to Nationality details") isn't delayed by a transient detach.
  try {
    await page.waitForLoadState('networkidle', { timeout: 4_000 });
  } catch {
    // ignore
  }

  try {
    const start = Date.now();
    while (Date.now() - start < 4_000) {
      const enabled = await btn.isEnabled().catch(() => true);
      const busy = await btn.getAttribute('aria-busy').catch(() => null);
      if (enabled && busy !== 'true') break;
      await page.waitForTimeout(100).catch(() => {});
    }
  } catch {
    // ignore
  }

  await pause(page, Math.min(delayMs, 150));
}

async function clickNextToNationalityDetailsIfPresent(page, delayMs) {
  // On Personal details, UCAS shows a "Next to Nationality details" navigation control.
  // Best-effort: do not fail the run if it isn't present (e.g., validation errors).
  const nameRe = /next\s+to\s+nationality\s+details/i;
  const candidates = [
    page.getByRole('button', { name: nameRe }).first(),
    page.getByRole('link', { name: nameRe }).first(),
  ];

  for (const el of candidates) {
    try {
      await el.waitFor({ state: 'visible', timeout: 7_500 });
      await step('Clicking Next to Nationality details', async () => {
        await pause(page, delayMs);
        await el.scrollIntoViewIfNeeded();
        await pause(page, delayMs);
        await el.click();
        await pause(page, delayMs);
      });
      return true;
    } catch {
      // try next candidate
    }
  }

  return false;
}

(async () => {
  const {
    targetUrl,
    fresh,
    clearState,
    start,
    section,
    universal,
    randomTitle,
    fillPersonalNames,
    randomDob,
    randomGender,
    markComplete,
    saveSection,
    speed,
    slowMo,
    delayMs,
  } = parseArgs(process.argv.slice(2));

  const hasAnyActions =
    universal || randomTitle || fillPersonalNames || randomDob || randomGender || markComplete || saveSection || start;
  if (!hasAnyActions) {
    console.log('[ucas] Note: no fill actions selected, so this run will only open UCAS.');
    console.log('[ucas] To run the full autofill flow use: node automation/ucas/ucas.cjs --run-all');
  }

  if (clearState && fs.existsSync(STORAGE_STATE_PATH)) {
    fs.unlinkSync(STORAGE_STATE_PATH);
    console.log(`[ucas] Cleared saved session: ${STORAGE_STATE_PATH}`);
  }

  console.log(`[ucas] Launching Chromium (headed) slowMo=${slowMo} speed=${speed} delayMs=${delayMs} universal=${universal}`);
  const browser = await chromium.launch({ headless: false, slowMo });

  const hasSavedSession = fs.existsSync(STORAGE_STATE_PATH);
  const shouldUseSavedSession = hasSavedSession && !fresh && !clearState;

  if (!hasSavedSession) {
    // First-time setup: manual login + capture.
    const context = await browser.newContext();
    const page = await context.newPage();

    console.log(`[ucas] No saved session found at ${STORAGE_STATE_PATH}`);
    console.log('[ucas] Opening UCAS for MANUAL login...');
    await gotoWithRetries(page, targetUrl, { waitUntil: 'domcontentloaded' });

    // Wait for manual login to complete (no terminal input required).
    console.log('[ucas] Complete login manually. I will auto-save the session when login finishes.');
    const loggedIn = await waitForManualLogin(page, delayMs).catch(() => false);
    if (!loggedIn) {
      await writeDebugArtifact(page, 'login-timeout');
      console.log('[ucas] Exiting: could not confirm login.');
      process.exit(1);
    }

    const state = await context.storageState();
    fs.writeFileSync(STORAGE_STATE_PATH, JSON.stringify(state, null, 2));
    console.log(`[ucas] Saved session: ${STORAGE_STATE_PATH}`);

    await context.close();
  }

  // Open with or without saved session.
  // Note: if you clicked Logout in the app but still appear logged in, that's usually
  // because we're restoring cookies from storageState.ucas.json. Use --fresh or --clear-state.
  const context = shouldUseSavedSession
    ? await browser.newContext({ storageState: STORAGE_STATE_PATH })
    : await browser.newContext();
  const page = await context.newPage();

  console.log(
    shouldUseSavedSession
      ? `[ucas] Opening with saved session: ${targetUrl}`
      : `[ucas] Opening WITHOUT saved session: ${targetUrl}`
  );
  await gotoWithRetries(page, targetUrl, { waitUntil: 'domcontentloaded' });

  // If the saved session is expired, UCAS may redirect to accounts.ucas.com for re-auth.
  // In that case, wait for manual login, then refresh storageState so future runs work.
  const okToProceed = await waitForManualLogin(page, delayMs);
  if (!okToProceed) {
    await writeDebugArtifact(page, 'login-timeout');
    console.log('[ucas] Still on login (or cannot confirm login). Keeping browser open.');
    console.log('[ucas] Finish login manually, then re-run this command to continue autofill.');
    console.log('[ucas] Browser will stay open. Press Ctrl+C in this terminal when done.');
    await new Promise(() => {});
  }

  if (shouldUseSavedSession) {
    try {
      const state = await context.storageState();
      fs.writeFileSync(STORAGE_STATE_PATH, JSON.stringify(state, null, 2));
      console.log(`[ucas] Refreshed saved session: ${STORAGE_STATE_PATH}`);
    } catch {
      // ignore
    }
  }

  // If we landed on the UCAS dashboard, click through to the application area.
  if (/ucas\.com\/dashboard\b/i.test(page.url())) {
    await acceptCookiesIfPresent(page, delayMs);
    await clickGoToApplicationIfPresent(page, delayMs);
  }

  // Cookies may appear again after cross-domain navigation.
  await acceptCookiesIfPresent(page, delayMs);
  if (start) {
    try {
      const before = page.url();
      await step(`Clicking ${section} -> Start this section`, async () => {
        await clickStartThisSectionInCard(page, section, delayMs);
      });
      try {
        await page.waitForURL((u) => u.toString() !== before, { timeout: 10_000 });
      } catch {
        // SPA may not change URL; ignore.
      }
    } catch (e) {
      console.log('[ucas] Could not click Start this section (skipping).');
      await writeDebugArtifact(page, 'start-section-missing');
    }
  }

  // If we're running Personal details actions, force the correct subpage.
  if (section && /personal details/i.test(section)) {
    const wantsPersonalDetailsPage = randomTitle || fillPersonalNames || randomDob || randomGender || markComplete || saveSection;
    if (wantsPersonalDetailsPage) {
      try {
        await ensureOnPersonalDetailsPage(page, delayMs);
      } catch {
        // ignore
      }
    }
  }

  if (randomTitle) {
    try {
      await selectRandomOptionByLabel(page, 'Title', delayMs);
    } catch {
      console.log('[ucas] Could not set Title (skipping).');
    }
  }

  if (fillPersonalNames) {
    try {
      const first = randomNameWord();
      const middle = randomNameWord();
      const last = randomNameWord();

      await fillTextByLabel(page, 'First and middle name(s)', `${first} ${middle}`, delayMs);
      await fillTextByLabel(page, 'Last name', last, delayMs);
      await fillTextByLabel(page, 'Previous name(s)', `${randomNameWord()} ${randomNameWord()}`, delayMs);
      await fillTextByLabel(page, 'Preferred first name', first, delayMs);
    } catch {
      console.log('[ucas] Could not fill personal name fields (skipping).');
    }
  }

  if (randomDob) {
    try {
      await step('Selecting Date of birth (Day/Month/Year)', async () => {
        await selectRandomDob(page, delayMs);
      });
    } catch {
      console.log('[ucas] Could not set Date of birth (skipping).');
    }
  }

  if (randomGender) {
    try {
      await selectRandomGender(page, delayMs);
    } catch (e) {
      console.log(`[ucas] Could not set Gender (skipping): ${e?.message ?? e}`);
    }
  }

  if (markComplete) {
    try {
      await clickMarkSectionComplete(page, delayMs);
    } catch (e) {
      console.log(`[ucas] Could not mark section complete (skipping): ${e?.message ?? e}`);
    }
  }

  if (saveSection) {
    try {
      await clickSaveThisSection(page, delayMs);

      // If we are in Personal details, progress to the next sub-page.
      if (section && /personal details/i.test(section)) {
        await clickNextToNationalityDetailsIfPresent(page, delayMs);
      }
    } catch (e) {
      console.log(`[ucas] Could not click Save this section (skipping): ${e?.message ?? e}`);
    }
  }

  const currentUrl = page.url();
  console.log(`[ucas] Current URL: ${currentUrl}`);
  console.log(/ucas\.com/i.test(currentUrl) ? '✅ UCAS detected' : '❌ Not UCAS (URL check failed)');

  console.log('[ucas] Browser will stay open. Press Ctrl+C in this terminal when done.');
  await new Promise(() => {});
})();
