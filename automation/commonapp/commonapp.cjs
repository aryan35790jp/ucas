// Common App automation (fresh re-build)
//
// Requirements:
// - Always start at https://apply.commonapp.org/login
// - After manual login completes and the app reaches the dashboard
//   (https://apply.commonapp.org/dashboard), click "My Common Application"
//   in the left sidebar ASAP.
//
// Usage:
//   node automation/commonapp/commonapp.cjs
//   node automation/commonapp/commonapp.cjs --fast
//   node automation/commonapp/commonapp.cjs --fresh
//   node automation/commonapp/commonapp.cjs --clear-state

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const LOGIN_URL = 'https://apply.commonapp.org/login';
const DASHBOARD_URL = 'https://apply.commonapp.org/dashboard';
const STORAGE_STATE_PATH = path.join(__dirname, 'storageState.commonapp.json');

function randomDobString() {
  // Common App hint shows format like: "August 1, 2002".
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];

  // Pick an adult-ish DOB range; adjust if needed.
  const year = 2001 + Math.floor(Math.random() * 6); // 2001-2006
  const monthIndex = Math.floor(Math.random() * 12);
  const day = 1 + Math.floor(Math.random() * 28); // keep it simple/valid
  return `${months[monthIndex]} ${day}, ${year}`;
}

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  return {
    fast: flags.has('--fast'),
    useSaved: flags.has('--use-saved'),
    clearState: flags.has('--clear-state'),
    keepOpen: flags.has('--keep-open'),
  };
}

function isOnDashboard(url) {
  return /\/dashboard(\b|\/|\?|#)/i.test(String(url || ''));
}

function isLoginish(url) {
  return /\b(login|sign-?in|signin|auth)\b/i.test(String(url || ''));
}

function escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function acceptCookiesIfPresent(page) {
  try {
    const acceptAll = page.getByRole('button', { name: /accept all/i }).first();
    if (await acceptAll.isVisible().catch(() => false)) {
      await acceptAll.click({ timeout: 800 }).catch(() => {});
      console.log('[commonapp] Accepted cookies');
    }
  } catch {
    // ignore
  }
}

async function clickLeftNavItemByText(page, textRe) {
  // Click a left-nav item by its text, using an x-position guard to avoid center content.
  const candidates = [
    page.locator('#appNavMain a, #appNavMain button').filter({ hasText: textRe }),
    page.locator('aside a, aside button').filter({ hasText: textRe }),
    page.locator('nav a, nav button').filter({ hasText: textRe }),
    page.locator('a, button').filter({ hasText: textRe }),
  ];

  for (const loc of candidates) {
    try {
      const count = await loc.count();
      for (let i = 0; i < Math.min(count, 6); i++) {
        const item = loc.nth(i);
        if (!(await item.isVisible().catch(() => false))) continue;
        const box = await item.boundingBox().catch(() => null);
        if (box && box.x <= 360) {
          await item.scrollIntoViewIfNeeded().catch(() => {});
          await item.click({ force: true, timeout: 600 });
          return true;
        }
      }
    } catch {
      // ignore
    }
  }
  return false;
}

async function clickNoForYesNoQuestion(page, questionRe, logKey) {
  try {
    // Strict approach: resolve the correct radio group in the DOM (by radio "name"),
    // click the associated "No" option inside that group, and verify it's checked.
    const questionText = questionRe instanceof RegExp ? questionRe.source : String(questionRe || '');
    const needle = String(questionText || '')
      .replace(/\\\//g, '/')
      .replace(/\\\?/g, '?')
      .replace(/\\\./g, '.')
      .replace(/\^|\$|\(\?:\)|\(\?=|\(\?!|\[|\]|\{|\}|\+|\*|\|/g, '')
      .trim();

    // Ensure the question is on screen to avoid stale/virtualized DOM.
    await page.getByText(questionRe).first().scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(150).catch(() => {});

    const result = await page.evaluate(({ needle }) => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const target = norm(needle);
      const body = document.body;
      if (!body || !target) return { ok: false, reason: 'no target/body' };

      const hasText = (el) => {
        const t = norm(el && el.innerText);
        return t.includes(target);
      };

      // Find a likely element containing the question text.
      const all = Array.from(body.querySelectorAll('*')).filter((el) => {
        if (!(el instanceof HTMLElement)) return false;
        if (!el.innerText) return false;
        return hasText(el);
      });

      // Prefer the smallest (most specific) text node holder.
      all.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
      const qEl = all[0];
      if (!qEl) return { ok: false, reason: 'question element not found' };

      const findNoInputIn = (root) => {
        const radios = Array.from(root.querySelectorAll('input[type="radio"]'));
        const groups = new Map();
        for (const r of radios) {
          const name = r.getAttribute('name') || '';
          if (!name) continue;
          if (!groups.has(name)) groups.set(name, []);
          groups.get(name).push(r);
        }

        // Look for a group that has both Yes/No labels.
        const labels = Array.from(root.querySelectorAll('label'));
        const yesLabels = labels.filter((l) => norm(l.innerText) === 'yes');
        const noLabels = labels.filter((l) => norm(l.innerText) === 'no');

        for (const [name, inputs] of groups.entries()) {
          if (inputs.length < 2) continue;

          const resolveInputForLabel = (label) => {
            if (!label) return null;
            const htmlFor = label.getAttribute('for');
            if (htmlFor) {
              const byId = root.querySelector(`#${CSS && CSS.escape ? CSS.escape(htmlFor) : htmlFor}`);
              if (byId && byId instanceof HTMLInputElement && byId.type === 'radio') return byId;
            }
            const wrapped = label.querySelector('input[type="radio"]');
            if (wrapped && wrapped instanceof HTMLInputElement) return wrapped;
            return null;
          };

          const noInput = noLabels.map(resolveInputForLabel).find((i) => i && i.name === name);
          const yesInput = yesLabels.map(resolveInputForLabel).find((i) => i && i.name === name);

          if (noInput && yesInput) {
            return { name, noInput, yesInput };
          }
        }

        // Fallback: if we couldn't tie labels to a group, but there is exactly one group name here,
        // try to pick the second option as No based on surrounding label text.
        if (groups.size === 1) {
          const [name, inputs] = Array.from(groups.entries())[0];
          const noLabel = labels.find((l) => norm(l.innerText) === 'no');
          const noInput = noLabel ? (noLabel.getAttribute('for') ? root.querySelector(`#${CSS && CSS.escape ? CSS.escape(noLabel.getAttribute('for')) : noLabel.getAttribute('for')}`) : noLabel.querySelector('input[type="radio"]')) : null;
          if (noInput && noInput instanceof HTMLInputElement && noInput.type === 'radio' && noInput.name === name) {
            const yesLabel = labels.find((l) => norm(l.innerText) === 'yes');
            const yesInput = yesLabel ? (yesLabel.getAttribute('for') ? root.querySelector(`#${CSS && CSS.escape ? CSS.escape(yesLabel.getAttribute('for')) : yesLabel.getAttribute('for')}`) : yesLabel.querySelector('input[type="radio"]')) : null;
            return { name, noInput, yesInput: yesInput || null };
          }
        }

        return null;
      };

      // Walk up from the question element; pick the first ancestor that contains a resolvable Yes/No group.
      let cur = qEl;
      for (let depth = 0; cur && depth < 30; depth++) {
        if (cur instanceof HTMLElement) {
          const group = findNoInputIn(cur);
          if (group && group.noInput) {
            const { noInput, yesInput, name } = group;
            // Click label or input to trigger the app's handlers.
            const clickTarget = noInput.closest('label') || noInput;
            (clickTarget instanceof HTMLElement ? clickTarget : noInput).click();

            const noChecked = !!noInput.checked;
            const yesChecked = yesInput ? !!yesInput.checked : null;
            return {
              ok: true,
              groupName: name,
              noChecked,
              yesChecked,
              radiosInContainer: cur.querySelectorAll('input[type="radio"]').length,
            };
          }
        }
        cur = cur.parentElement;
      }

      return { ok: false, reason: 'no matching yes/no group found near question' };
    }, { needle });

    if (!result || result.ok !== true || result.noChecked !== true) {
      console.log(`[commonapp] CLICK FAILED: "No" (${logKey}) (still looks like "Yes")`);
      return false;
    }

    console.log(`[commonapp] CLICKED: "No" (${logKey})`);
    return true;
  } catch (err) {
    console.log(`[commonapp] CLICK FAILED: "No" (${logKey}) (${err.message})`);
    return false;
  }
}

async function clickContinueNearLocator(page, anchorLocator, logKey = 'Continue') {
  const continueRe = /^\s*Continue\s*$/i;
  const directContinueSelector = 'button#sectionContinue11, button[id^="sectionContinue"], button.button--primary[id^="sectionContinue"]';

  const anchorVisible = await anchorLocator
    .first()
    .isVisible()
    .catch(() => false);
  const anchor = anchorVisible ? anchorLocator.first() : null;

  const isInLeftNav = async (loc) => {
    return await loc
      .evaluate((el) => {
        if (!el || !(el instanceof HTMLElement)) return false;
        return !!el.closest('#appNavMain, nav, aside');
      })
      .catch(() => false);
  };

  const tryClickOne = async (loc) => {
    // First, try to bring it into view (Continue is often below the fold in an inner scroller).
    await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(150).catch(() => {});

    if (await isInLeftNav(loc)) return false;
    if (!(await loc.isVisible().catch(() => false))) return false;
    const enabled = await loc.isEnabled().catch(() => true);
    if (!enabled) return false;

    // Trial click first: ensures it's actually clickable (not covered/disabled/etc).
    await loc.click({ timeout: 2000, trial: true });
    await loc.click({ timeout: 5000 });
    return true;
  };

  const tryClickFirstVisible = async (loc) => {
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 12); i++) {
      if (await tryClickOne(loc.nth(i))) return true;
    }
    return false;
  };

  // Fast path: the real Continue button in this flow has a stable id pattern.
  // Example provided: <button id="sectionContinue11" class="button--primary">Continue...</button>
  try {
    const direct = page.locator(directContinueSelector);
    if (await tryClickFirstVisible(direct)) {
      console.log(`[commonapp] CLICKED: "${logKey}" (id pattern)`);
      return true;
    }
  } catch {
    // ignore
  }

  const scrollNearestScrollableAncestorToBottom = async () => {
    if (!anchor) return false;
    const scrolled = await anchor
      .evaluate((el) => {
        const isScrollable = (node) => {
          if (!node || !(node instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(node);
          const oy = style.overflowY;
          const scrollableY = oy === 'auto' || oy === 'scroll' || oy === 'overlay';
          if (!scrollableY) return false;
          return node.scrollHeight > node.clientHeight + 10;
        };

        let cur = el;
        for (let depth = 0; cur && depth < 40; depth++) {
          if (isScrollable(cur)) {
            // Scroll in a few steps to trigger lazy rendering.
            for (let i = 0; i < 6; i++) {
              cur.scrollTop = cur.scrollHeight;
            }
            cur.dispatchEvent(new Event('scroll', { bubbles: true }));
            return true;
          }
          cur = cur.parentElement;
        }

        // Fallback: try a common container in this app.
        const candidates = Array.from(document.querySelectorAll('main, form, section, div'));
        for (const c of candidates) {
          if (isScrollable(c)) {
            for (let i = 0; i < 6; i++) {
              c.scrollTop = c.scrollHeight;
            }
            c.dispatchEvent(new Event('scroll', { bubbles: true }));
            return true;
          }
        }

        return false;
      })
      .catch(() => false);

    if (scrolled) {
      await page.waitForTimeout(350).catch(() => {});
    }
    return scrolled;
  };

  // Prefer a Continue button within the closest meaningful container of the anchor.
  if (anchor) {
    const ancestors = anchor.locator('xpath=ancestor::*[self::form or self::main or self::section or self::div]');
    const n = await ancestors.count().catch(() => 0);

    for (let i = 0; i < Math.min(n, 12); i++) {
      const container = ancestors.nth(i);
      const btn = container.getByRole('button', { name: continueRe });
      if (await tryClickFirstVisible(btn)) {
        console.log(`[commonapp] CLICKED: "${logKey}"`);
        return true;
      }
      const roleBtn = container.locator('[role="button"]').filter({ hasText: continueRe });
      if (await tryClickFirstVisible(roleBtn)) {
        console.log(`[commonapp] CLICKED: "${logKey}"`);
        return true;
      }
    }
  }

  // Fallback: any visible Continue button in the main content.
  const globalCandidates = [
    page.getByRole('button', { name: continueRe }),
    page.locator('button').filter({ hasText: continueRe }),
    page.locator('[role="button"]').filter({ hasText: continueRe }),
    page.locator('input[type="submit"][value], input[type="button"][value]'),
    page.locator('[tabindex]').filter({ hasText: continueRe }),
    page.locator('[aria-label]').filter({ hasText: continueRe }),
    page.locator('[aria-label="Continue"], [aria-label="continue"]'),
  ];

  // If the Continue is an <input>, hasText() won't match; handle by value.
  const clickInputByValue = async () => {
    const input = page
      .locator('input[type="submit"], input[type="button"]')
      .filter({ has: page.locator('xpath=./self::input') });
    const clicked = await page
      .evaluate(() => {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const isVisible = (node) => {
          if (!node || !(node instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(node);
          if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') === 0) return false;
          const r = node.getBoundingClientRect();
          if (!r || r.width < 2 || r.height < 2) return false;
          if (r.left <= 360) return false;
          return true;
        };

        const inputs = Array.from(document.querySelectorAll('input[type="submit"], input[type="button"]'));
        const cand = inputs.find((n) => norm(n.value) === 'continue' && isVisible(n) && !n.disabled);
        if (!cand) return false;
        cand.click();
        return true;
      })
      .catch(() => false);
    return clicked;
  };

  for (const loc of globalCandidates) {
    // Special-case <input value="Continue">.
    if (loc === globalCandidates[3]) {
      const clicked = await clickInputByValue().catch(() => false);
      if (clicked) {
        console.log(`[commonapp] CLICKED: "${logKey}" (input value)`);
        return true;
      }
      continue;
    }

    if (await tryClickFirstVisible(loc)) {
      console.log(`[commonapp] CLICKED: "${logKey}"`);
      return true;
    }
  }

  // If not found, scroll the inner form panel (common in Common App) and retry.
  const scrolledPanel = await scrollNearestScrollableAncestorToBottom().catch(() => false);
  if (scrolledPanel) {
    // Retry scoped ancestor search again (new controls may have been rendered).
    if (anchor) {
      const ancestors = anchor.locator('xpath=ancestor::*[self::form or self::main or self::section or self::div]');
      const n = await ancestors.count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 12); i++) {
        const container = ancestors.nth(i);
        const btn = container.getByRole('button', { name: continueRe });
        if (await tryClickFirstVisible(btn)) {
          console.log(`[commonapp] CLICKED: "${logKey}" (after panel scroll)`);
          return true;
        }
        const roleBtn = container.locator('[role="button"]').filter({ hasText: continueRe });
        if (await tryClickFirstVisible(roleBtn)) {
          console.log(`[commonapp] CLICKED: "${logKey}" (after panel scroll)`);
          return true;
        }
      }
    }

    for (const loc of globalCandidates) {
      if (loc === globalCandidates[3]) {
        const clicked = await clickInputByValue().catch(() => false);
        if (clicked) {
          console.log(`[commonapp] CLICKED: "${logKey}" (input value, after panel scroll)`);
          return true;
        }
        continue;
      }
      if (await tryClickFirstVisible(loc)) {
        console.log(`[commonapp] CLICKED: "${logKey}" (after panel scroll)`);
        return true;
      }
    }
  }

  // Keyboard-based scroll fallback: often the inner panel only scrolls when focused.
  try {
    if (anchor) {
      await anchor.scrollIntoViewIfNeeded().catch(() => {});
      await anchor.click({ timeout: 800 }).catch(() => {});
    }
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('PageDown').catch(() => {});
    }
    await page.waitForTimeout(250).catch(() => {});
    for (const loc of globalCandidates) {
      if (loc === globalCandidates[3]) {
        const clicked = await clickInputByValue().catch(() => false);
        if (clicked) {
          console.log(`[commonapp] CLICKED: "${logKey}" (input value, after PageDown)`);
          return true;
        }
        continue;
      }
      if (await tryClickFirstVisible(loc)) {
        console.log(`[commonapp] CLICKED: "${logKey}" (after PageDown)`);
        return true;
      }
    }
  } catch {
    // ignore
  }

  // Text fallback: locate the Continue text and click the nearest clickable ancestor.
  try {
    const txt = page.getByText(continueRe).first();
    if (await txt.isVisible().catch(() => false)) {
      const clickable = txt
        .locator(
          'xpath=ancestor::button[1] | ancestor::a[1] | ancestor::*[@role="button"][1] | ancestor::*[@tabindex][1]'
        )
        .first();
      if (await tryClickOne(clickable)) {
        console.log(`[commonapp] CLICKED: "${logKey}" (text ancestor)`);
        return true;
      }
    }
  } catch {
    // ignore
  }

  // Retry after scrolling to the bottom (Continue is often below the fold).
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await page.waitForTimeout(250).catch(() => {});
  for (const loc of globalCandidates) {
    if (await tryClickFirstVisible(loc)) {
      console.log(`[commonapp] CLICKED: "${logKey}" (after scroll)`);
      return true;
    }
  }

  // DOM-extraction fallback: find the nearest visible "Continue" button below the anchor.
  // This survives cases where the UI changes roles/labels.
  try {
    if (anchor) {
      const clicked = await anchor.evaluate((el) => {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const anchorEl = el;
        if (!anchorEl || !(anchorEl instanceof HTMLElement)) return false;

        const isVisible = (node) => {
          if (!node || !(node instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(node);
          if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') === 0) return false;
          const r = node.getBoundingClientRect();
          if (!r || r.width < 2 || r.height < 2) return false;
          return true;
        };

        const isInLeftNav = (node) => !!node.closest('#appNavMain, nav, aside');

        const root =
          anchorEl.closest('form') ||
          anchorEl.closest('main') ||
          anchorEl.closest('section') ||
          anchorEl.closest('div') ||
          document.body;

        const anchorRect = anchorEl.getBoundingClientRect();
        const candidates = Array.from(
          root.querySelectorAll(
            'button, [role="button"], a[role="button"], input[type="submit"], input[type="button"], a, [tabindex]'
          )
        ).filter((n) => {
          const t = norm((n instanceof HTMLInputElement ? n.value : n.textContent) || '');
          return t === 'continue';
        });

        let best = null;
        let bestScore = Number.POSITIVE_INFINITY;
        for (const c of candidates) {
          if (!isVisible(c)) continue;
          if (isInLeftNav(c)) continue;
          const r = c.getBoundingClientRect();
          // Prefer buttons below the anchor; allow small overlap.
          const dy = r.top - anchorRect.bottom;
          const dx = Math.abs(r.left - anchorRect.left);
          if (dy < -20) continue;
          const score = Math.max(0, dy) * 1000 + dx;
          if (score < bestScore) {
            bestScore = score;
            best = c;
          }
        }

        if (!best) return false;
        (best instanceof HTMLElement ? best : best).click();
        return true;
      });

      if (clicked) {
        console.log(`[commonapp] CLICKED: "${logKey}" (DOM fallback)`);
        return true;
      }
    }

    // Last resort: click the first visible Continue-like control in the document (but not in left-nav).
    const clickedGlobal = await page.evaluate(() => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const isVisible = (node) => {
        if (!node || !(node instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(node);
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') === 0) return false;
        const r = node.getBoundingClientRect();
        if (!r || r.width < 2 || r.height < 2) return false;
        return true;
      };

      const isInLeftNav = (node) => !!node.closest('#appNavMain, nav, aside');

      const nodes = Array.from(
        document.querySelectorAll(
          'button, [role="button"], a[role="button"], input[type="submit"], input[type="button"], a, [tabindex]'
        )
      );
      const cand = nodes.find((n) => {
        const t = norm((n instanceof HTMLInputElement ? n.value : n.textContent) || '');
        return t === 'continue' && isVisible(n) && !isInLeftNav(n);
      });
      if (!cand) return false;
      cand.click();
      return true;
    });

    if (clickedGlobal) {
      console.log(`[commonapp] CLICKED: "${logKey}" (DOM global fallback)`);
      return true;
    }
  } catch {
    // ignore
  }

  // Last resort: search and click inside any iframes.
  try {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;

      const clicked = await frame
        .evaluate(() => {
          const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
          const isVisible = (node) => {
            if (!node || !(node instanceof HTMLElement)) return false;
            const style = window.getComputedStyle(node);
            if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') === 0) return false;
            const r = node.getBoundingClientRect();
            if (!r || r.width < 2 || r.height < 2) return false;
            return true;
          };

          const nodes = Array.from(
            document.querySelectorAll('button, [role="button"], a[role="button"], input[type="submit"], input[type="button"], a, [tabindex]')
          );

          const cand = nodes.find((n) => {
            const text = norm((n instanceof HTMLInputElement ? n.value : n.textContent) || '');
            const aria = n instanceof HTMLElement ? norm(n.getAttribute('aria-label') || '') : '';
            const disabled = (n instanceof HTMLButtonElement || n instanceof HTMLInputElement) ? !!n.disabled : false;
            return !disabled && isVisible(n) && (text === 'continue' || aria === 'continue');
          });
          if (!cand) return false;
          cand.click();
          return true;
        })
        .catch(() => false);

      if (clicked) {
        console.log(`[commonapp] CLICKED: "${logKey}" (iframe fallback)`);
        return true;
      }
    }
  } catch {
    // ignore
  }

  console.log(`[commonapp] NOT CLICKED: "${logKey}" not found/visible`);
  return false;
}

async function clickAddAddressButton(page) {
  const addRe = /^\s*Add address\s*$/i;

  // Wait until the Address section is actually rendered.
  const url = page.url() || '';
  const looksLikeAddressUrl = /\/common\/3\/12(\b|\/|\?|#)/i.test(url);

  if (!looksLikeAddressUrl) {
    // Prefer the main heading.
    try {
      await page.getByRole('heading', { name: /^\s*Address\s*$/i }).first().waitFor({ state: 'visible', timeout: 15_000 });
    } catch {
      // Fallback: any visible "Address" heading/text in main content.
      await page.locator('main').getByText(/^\s*Address\s*$/i).first().waitFor({ state: 'visible', timeout: 15_000 });
    }
  }

  const candidates = [
    page.getByRole('button', { name: addRe }),
    page.locator('button').filter({ hasText: addRe }),
    page.locator('[role="button"]').filter({ hasText: addRe }),
  ];

  for (const loc of candidates) {
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 8); i++) {
      const btn = loc.nth(i);
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      if (!(await btn.isVisible().catch(() => false))) continue;
      if (!(await btn.isEnabled().catch(() => true))) continue;
      // Requested: delay Add address click.
      await page.waitForTimeout(900).catch(() => {});
      await btn.click({ timeout: 5000 });
      console.log('[commonapp] CLICKED: "Add address"');
      return true;
    }
  }

  console.log('[commonapp] NOT CLICKED: "Add address" not found/visible');
  return false;
}

async function selectCountryInAddressLookup(page, countryName = 'India') {
  const dialog = page.getByRole('dialog').filter({ hasText: /Address Lookup/i }).first();
  const heading = page.getByRole('heading', { name: /^\s*Address Lookup\s*$/i }).first();

  // Wait for modal to appear.
  try {
    await dialog.waitFor({ state: 'visible', timeout: 15_000 });
  } catch {
    await heading.waitFor({ state: 'visible', timeout: 15_000 });
  }

  const scope = (await dialog.isVisible().catch(() => false)) ? dialog : page;

  // Locate the Country/Region/Territory control.
  const labelRe = /^\s*Country\/Region\/Territory\s*\*?\s*$/i;
  let control = scope.getByLabel(labelRe).first();
  const labelFallback = scope.locator('label').filter({ hasText: labelRe }).first();

  if (!(await control.isVisible().catch(() => false))) {
    // Common pattern: label followed by a combobox/button/select.
    control = labelFallback
      .locator('xpath=following::*[self::select or self::input or self::button or @role="combobox" or @role="button"][1]')
      .first();
  }

  await control.waitFor({ state: 'visible', timeout: 10_000 });
  await control.scrollIntoViewIfNeeded().catch(() => {});

  // Open dropdown via the triangle/caret (not by typing).
  await page.waitForTimeout(800).catch(() => {});

  // Best-effort: click a caret/toggle button near the control.
  const container = control.locator('xpath=ancestor::*[self::forge-select or self::forge-field or self::div][1]');
  const caretCandidates = container.locator('button, [role="button"], [tabindex]').filter({ has: container.locator('svg, forge-icon') });
  let opened = false;

  try {
    const n = await caretCandidates.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 8); i++) {
      const btn = caretCandidates.nth(i);
      if (!(await btn.isVisible().catch(() => false))) continue;
      const meta = await btn
        .evaluate((el) => ({
          text: (el.textContent || '').trim(),
          aria: (el.getAttribute('aria-label') || '').trim(),
        }))
        .catch(() => ({ text: '', aria: '' }));

      const aria = (meta.aria || '').toLowerCase();
      const text = (meta.text || '').toLowerCase();
      if (aria.includes('clear') || text === 'x' || text === '×') continue;

      await btn.click({ timeout: 3000 }).catch(async () => {
        await btn.click({ timeout: 3000, force: true });
      });
      opened = true;
      break;
    }
  } catch {
    // ignore
  }

  if (!opened) {
    // Fallback: click the control itself to open.
    await control.click({ timeout: 3000 }).catch(async () => {
      await control.click({ timeout: 3000, force: true });
    });
  }

  await page.waitForTimeout(250).catch(() => {});

  // Scroll the dropdown list until the country is found (no typing).
  const ok = await page
    .evaluate(({ countryName }) => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const target = norm(countryName);

      const visibleListboxes = Array.from(document.querySelectorAll('[role="listbox"]')).filter((lb) => {
        if (!(lb instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(lb);
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') === 0) return false;
        const r = lb.getBoundingClientRect();
        return r.width > 10 && r.height > 10;
      });

      const listbox = visibleListboxes[0];
      if (!listbox) return false;

      const findAndClick = () => {
        const options = Array.from(listbox.querySelectorAll('[role="option"], li, div'))
          .filter((el) => el instanceof HTMLElement)
          .map((el) => el);

        for (const el of options) {
          const t = norm(el.textContent);
          if (!t) continue;
          if (t === target) {
            el.scrollIntoView({ block: 'center' });
            el.click();
            return true;
          }
        }
        return false;
      };

      if (findAndClick()) return true;

      // Scroll in steps to force virtualization to render new options.
      const step = Math.max(60, Math.floor(listbox.clientHeight * 0.8));
      const maxSteps = 60;
      for (let i = 0; i < maxSteps; i++) {
        listbox.scrollTop = Math.min(listbox.scrollTop + step, listbox.scrollHeight);
        listbox.dispatchEvent(new Event('scroll', { bubbles: true }));
        if (findAndClick()) return true;
      }

      // Try scrolling back up once (some lists wrap or snap).
      for (let i = 0; i < Math.min(20, maxSteps); i++) {
        listbox.scrollTop = Math.max(0, listbox.scrollTop - step);
        listbox.dispatchEvent(new Event('scroll', { bubbles: true }));
        if (findAndClick()) return true;
      }

      return false;
    }, { countryName })
    .catch(() => false);

  if (ok) {
    console.log(`[commonapp] SELECTED: "Country/Region/Territory" = ${countryName}`);
    return true;
  }

  console.log(`[commonapp] NOT SELECTED: Country/Region/Territory = ${countryName}`);
  return false;
}

async function selectIDontSeeMyAddressInThisList(page) {
  const dialog = page.getByRole('dialog').filter({ hasText: /Address Lookup/i }).first();
  const scope = (await dialog.isVisible().catch(() => false)) ? dialog : page;
  const targetRe = /I\s*don['’]?t\s*see\s*my\s*address\s*in\s*this\s*list/i;
  const expectedText = "I don't see my address in this list";

  const normalize = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[’']/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

  const verifySelected = async () => {
    // Prefer checking the actual input value when possible.
    try {
      const v = await addressInput.inputValue({ timeout: 800 }).catch(() => '');
      if (normalize(v) === normalize(expectedText)) return true;
    } catch {
      // ignore
    }

    // Fallback: some UIs render the selection as visible text in the field.
    const visible = await scope.getByText(targetRe).first().isVisible().catch(() => false);
    return visible;
  };

  // Click into the Address textbox to open the suggestions list.
  const labelRe = /^\s*Address\s*\*?\s*$/i;
  let addressInput = scope.getByLabel(labelRe).first();
  const labelFallback = scope.locator('label').filter({ hasText: labelRe }).first();
  if (!(await addressInput.isVisible().catch(() => false))) {
    addressInput = labelFallback.locator('xpath=following::input[1]').first();
  }

  await addressInput.waitFor({ state: 'visible', timeout: 10_000 });
  await addressInput.scrollIntoViewIfNeeded().catch(() => {});
  await addressInput.click({ timeout: 3000 }).catch(async () => {
    await addressInput.click({ timeout: 3000, force: true });
  });
  await page.waitForTimeout(300).catch(() => {});

  // Fast path: Playwright text locator (the item is often the last option in the dropdown).
  try {
    const textLoc = scope.getByText(targetRe).first();
    await textLoc.waitFor({ state: 'visible', timeout: 2500 });
    await textLoc.scrollIntoViewIfNeeded().catch(() => {});
    await textLoc.click({ timeout: 5000 }).catch(async () => {
      const clickable = textLoc
        .locator('xpath=ancestor::button[1] | ancestor::a[1] | ancestor::*[@role="option"][1] | ancestor::*[@tabindex][1] | ancestor::li[1] | ancestor::div[1]')
        .first();
      await clickable.click({ timeout: 5000, force: true });
    });

    const ok = await page.waitForTimeout(150).then(verifySelected).catch(() => false);
    if (ok) {
      console.log('[commonapp] CLICKED: "I don\'t see my address in this list"');
      return true;
    }
    console.log('[commonapp] CLICKED but NOT APPLIED: "I don\'t see my address in this list"');
    return false;
  } catch {
    // fall through
  }

  // DOM fallback: find the open suggestions container (not always role=listbox), scroll it, and click the item.
  const ok = await scope
    .evaluate(() => {
      const normalize = (s) =>
        String(s || '')
          .toLowerCase()
          .replace(/[’']/g, "'")
          .replace(/\s+/g, ' ')
          .trim();

      const target = normalize("I don't see my address in this list");

      const isVisible = (el) => {
        if (!el || !(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 5 && r.height > 5;
      };

      const findCandidateNode = () => {
        const all = Array.from(document.querySelectorAll('*'))
          .filter((n) => n instanceof HTMLElement)
          .map((n) => n);
        for (const el of all) {
          if (!isVisible(el)) continue;
          const t = normalize(el.textContent);
          if (!t) continue;
          if (t === target) return el;
        }
        // Also allow contains-match (sometimes extra whitespace).
        for (const el of all) {
          if (!isVisible(el)) continue;
          const t = normalize(el.textContent);
          if (t && t.includes(target)) return el;
        }
        return null;
      };

      const findScrollable = () => {
        const candidates = Array.from(document.querySelectorAll('div, ul, ol, section'))
          .filter((n) => n instanceof HTMLElement)
          .map((n) => n);
        const scrollables = candidates.filter((el) => {
          if (!isVisible(el)) return false;
          const style = window.getComputedStyle(el);
          const oy = style.overflowY;
          const scrollable = (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 10;
          return scrollable;
        });

        // Prefer the smallest visible scrollable container (likely the dropdown panel).
        scrollables.sort((a, b) => a.clientHeight - b.clientHeight);
        return scrollables[0] || null;
      };

      const clickElement = (el) => {
        if (!el) return false;
        const clickable =
          el.closest('button') ||
          el.closest('a') ||
          el.closest('[role="option"]') ||
          el.closest('[tabindex]') ||
          el;
        if (!(clickable instanceof HTMLElement)) return false;
        clickable.scrollIntoView({ block: 'center' });
        clickable.click();
        return true;
      };

      // Try without scrolling first.
      const initial = findCandidateNode();
      if (clickElement(initial)) return true;

      const scroller = findScrollable();
      if (!scroller) return false;

      const step = Math.max(80, Math.floor(scroller.clientHeight * 0.85));
      for (let i = 0; i < 60; i++) {
        scroller.scrollTop = Math.min(scroller.scrollTop + step, scroller.scrollHeight);
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        const found = findCandidateNode();
        if (clickElement(found)) return true;
      }

      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      return clickElement(findCandidateNode());
    })
    .catch(() => false);

  if (ok) {
    const applied = await page.waitForTimeout(150).then(verifySelected).catch(() => false);
    if (applied) {
      console.log('[commonapp] CLICKED: "I don\'t see my address in this list"');
      return true;
    }
    console.log('[commonapp] CLICKED but NOT APPLIED: "I don\'t see my address in this list"');
    return false;
  }

  console.log('[commonapp] NOT CLICKED: "I don\'t see my address in this list"');
  return false;
}

async function clickAddressLookupContinue(page, { delayMs = 1000 } = {}) {
  const dialog = page.getByRole('dialog').filter({ hasText: /Address Lookup/i }).first();
  await dialog.waitFor({ state: 'visible', timeout: 15_000 });

  // Requested: click Continue after 1 second.
  await page.waitForTimeout(delayMs).catch(() => {});

  const continueRe = /^\s*Continue\s*$/i;
  const scope = (await dialog.isVisible().catch(() => false)) ? dialog : page;

  // Fast path: stable id from outerHTML
  // <button type="submit" class="button--primary" id="continueAddress182">Continue...</button>
  const directIdSelector = 'button#continueAddress182, button[id^="continueAddress"], button.button--primary[id^="continueAddress"]';

  const candidates = [
    page.locator(directIdSelector),
    scope.locator(directIdSelector),
    scope.getByRole('button', { name: continueRe }),
    scope.locator('button.button--primary').filter({ hasText: continueRe }),
    scope.locator('button').filter({ hasText: continueRe }),
    scope.locator('[role="button"]').filter({ hasText: continueRe }),
    scope.locator('button[id^="sectionContinue"]'),
  ];

  for (const loc of candidates) {
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 6); i++) {
      const btn = loc.nth(i);
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      if (!(await btn.isVisible().catch(() => false))) continue;
      if (!(await btn.isEnabled().catch(() => true))) continue;

      await btn.click({ timeout: 5000, trial: true }).catch(() => {});
      await btn.click({ timeout: 5000 }).catch(async () => {
        await btn.click({ timeout: 5000, force: true });
      });

      // Best-effort wait for the modal to close.
      await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
      console.log('[commonapp] CLICKED: "Address Lookup" -> "Continue"');
      return true;
    }
  }

  // If the modal button is rendered outside the dialog subtree, try a global primary Continue.
  try {
    const globalPrimary = page.locator('button.button--primary').filter({ hasText: continueRe });
    const n = await globalPrimary.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 6); i++) {
      const btn = globalPrimary.nth(i);
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      if (!(await btn.isVisible().catch(() => false))) continue;
      if (!(await btn.isEnabled().catch(() => true))) continue;
      await btn.click({ timeout: 5000, trial: true }).catch(() => {});
      await btn.click({ timeout: 5000 }).catch(async () => {
        await btn.click({ timeout: 5000, force: true });
      });
      await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
      console.log('[commonapp] CLICKED: "Address Lookup" -> "Continue" (global primary)');
      return true;
    }
  } catch {
    // ignore
  }

  // Similar to cookie accept: simple global role-based Continue, avoiding left-nav.
  try {
    const globalRole = page.getByRole('button', { name: continueRe });
    const n = await globalRole.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 10); i++) {
      const btn = globalRole.nth(i);
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      if (!(await btn.isVisible().catch(() => false))) continue;
      if (!(await btn.isEnabled().catch(() => true))) continue;
      const box = await btn.boundingBox().catch(() => null);
      if (box && box.x <= 360) continue;
      await btn.click({ timeout: 5000, trial: true }).catch(() => {});
      await btn.click({ timeout: 5000 }).catch(async () => {
        await btn.click({ timeout: 5000, force: true });
      });
      await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
      console.log('[commonapp] CLICKED: "Address Lookup" -> "Continue" (global role)');
      return true;
    }
  } catch {
    // ignore
  }

  // Fallback (like cookie accept): DOM search + click the visible Continue button
  // near the visible Address Lookup dialog (handles portal/footer layouts).
  try {
    const clicked = await page
      .evaluate(() => {
        const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

        const isVisible = (el) => {
          if (!el || !(el instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(el);
          if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') === 0) return false;
          const r = el.getBoundingClientRect();
          if (!r || r.width < 2 || r.height < 2) return false;
          return true;
        };

        const isDisabled = (el) => {
          if (!el) return true;
          if (el instanceof HTMLButtonElement) return !!el.disabled;
          if (el instanceof HTMLInputElement) return !!el.disabled;
          const aria = normalize(el.getAttribute && el.getAttribute('aria-disabled'));
          return aria === 'true';
        };

        const textOf = (el) => {
          if (!el) return '';
          if (el instanceof HTMLInputElement) return el.value || '';
          return el.textContent || '';
        };

        const ariaOf = (el) => {
          if (!el || !(el instanceof HTMLElement)) return '';
          return el.getAttribute('aria-label') || '';
        };

        const isInLeftNav = (el) => !!(el && el.closest && el.closest('#appNavMain, nav, aside'));

        const collectContinueCandidates = (root) => {
          const out = [];
          const seen = new Set();
          const stack = [root];

          const push = (node) => {
            if (!node || !(node instanceof HTMLElement)) return;
            if (seen.has(node)) return;
            seen.add(node);

            // Candidate clickable elements.
            const tag = node.tagName ? node.tagName.toLowerCase() : '';
            const role = normalize(node.getAttribute && node.getAttribute('role'));
            const tabindex = node.getAttribute && node.getAttribute('tabindex');

            const clickable =
              tag === 'button' ||
              (tag === 'a' && role === 'button') ||
              role === 'button' ||
              (tag === 'input' && (node.getAttribute('type') === 'button' || node.getAttribute('type') === 'submit')) ||
              tabindex !== null;

            if (clickable && isVisible(node) && !isDisabled(node) && !isInLeftNav(node)) {
              const t = normalize(textOf(node));
              const a = normalize(ariaOf(node));
              const isContinue =
                t === 'continue' ||
                a === 'continue' ||
                t.startsWith('continue ') ||
                a.startsWith('continue ') ||
                t.includes(' continue') ||
                t.includes('continue ');
              if (isContinue) {
                out.push(node);
              }
            }

            // Traverse light DOM children.
            for (const child of Array.from(node.children || [])) stack.push(child);

            // Traverse open shadow roots if present.
            const sr = node.shadowRoot;
            if (sr && sr instanceof ShadowRoot) {
              for (const child of Array.from(sr.children || [])) stack.push(child);
            }
          };

          while (stack.length) push(stack.pop());
          return out;
        };

        // Anchor on the visible "Address Lookup" title (role=dialog may not exist in DOM).
        const titleEls = Array.from(document.querySelectorAll('*'))
          .filter((el) => el instanceof HTMLElement)
          .map((el) => el)
          .filter((el) => isVisible(el) && normalize(el.textContent) === 'address lookup');

        // Pick the smallest matching title element.
        titleEls.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
        const titleEl = titleEls[0];
        if (!titleEl) return { ok: false, reason: 'no Address Lookup title' };

        // Choose a modal root by walking up until it looks like the whole modal card.
        const wants = (el) => {
          const t = normalize(el.innerText);
          if (!t.includes('country/region/territory')) return false;
          if (!t.includes('address')) return false;
          const r = el.getBoundingClientRect();
          return r.width > 260 && r.height > 200;
        };

        let modalRoot = titleEl;
        let cur = titleEl;
        for (let depth = 0; cur && depth < 20; depth++) {
          if (cur instanceof HTMLElement && wants(cur)) {
            modalRoot = cur;
            break;
          }
          cur = cur.parentElement;
        }

        const dr = modalRoot.getBoundingClientRect();
        const center = { x: dr.left + dr.width / 2, y: dr.top + dr.height / 2 };

        const distanceToDialog = (r) => {
          // Distance from point to rect (0 if inside).
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          const dx = cx < dr.left ? dr.left - cx : cx > dr.right ? cx - dr.right : 0;
          const dy = cy < dr.top ? dr.top - cy : cy > dr.bottom ? cy - dr.bottom : 0;
          const dist = Math.sqrt(dx * dx + dy * dy);
          // bias toward the dialog center
          const toCenter = Math.sqrt((cx - center.x) ** 2 + (cy - center.y) ** 2);
          return dist * 10 + toCenter;
        };

        const pickBest = (els) => {
          const scored = els
            .map((el) => {
              const r = el.getBoundingClientRect();
              const cls = String(el.className || '').toLowerCase();
              const primary = cls.includes('primary') || cls.includes('button--primary');
              return { el, r, primary, score: distanceToDialog(r) };
            })
            .sort((a, b) => {
              if (a.primary !== b.primary) return a.primary ? -1 : 1;
              // Prefer closer to dialog
              return a.score - b.score;
            });
          return scored[0] || null;
        };

        // 1) Look within the modal root.
        let best = pickBest(collectContinueCandidates(modalRoot));

        // 2) Walk up ancestors and search within each ancestor (captures footer siblings / portals).
        let parent = modalRoot;
        for (let depth = 0; !best && parent && depth < 14; depth++) {
          parent = parent.parentElement;
          if (!parent) break;
          best = pickBest(collectContinueCandidates(parent));
        }

        // 3) Global search: pick the Continue closest to the modal.
        if (!best) {
          const all = collectContinueCandidates(document.body);
          best = pickBest(all);
        }

        if (!best || !best.el) {
          return { ok: false, reason: 'no continue found near modal' };
        }

        best.el.scrollIntoView({ block: 'center' });
        best.el.click();
        return { ok: true, primary: best.primary, pickedClass: String(best.el.className || '') };
      })
      .catch(() => ({ ok: false, reason: 'evaluate failed' }));

    if (clicked && clicked.ok) {
      await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
      console.log('[commonapp] CLICKED: "Address Lookup" -> "Continue" (DOM fallback)');
      return true;
    }

    if (clicked && clicked.reason) {
      console.log(`[commonapp] Continue DOM fallback failed: ${clicked.reason}`);
    }
  } catch {
    // ignore
  }

  console.log('[commonapp] NOT CLICKED: "Address Lookup" -> "Continue"');
  return false;
}

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function randomAddressLine1() {
  const streets = ['MG Road', 'Park Street', 'Nehru Street', 'Station Road', 'Ring Road', 'College Road', 'Lake Road'];
  return `${randomInt(10, 999)} ${randomFrom(streets)}`;
}

function randomAddressLine2() {
  return `Apt ${randomInt(1, 99)}`;
}

function randomAddressLine3() {
  const hints = ['Near Market', 'Opp. Park', 'Behind Mall', 'Near Metro', 'Near School'];
  return randomFrom(hints);
}

function randomCity() {
  return randomFrom(['Mumbai', 'Delhi', 'Kolkata', 'Chennai', 'Bengaluru', 'Pune', 'Hyderabad']);
}

function randomStateOrProvince() {
  return randomFrom([
    'West Bengal',
    'Maharashtra',
    'Delhi',
    'Karnataka',
    'Tamil Nadu',
    'Telangana',
    'Gujarat',
    'Rajasthan',
  ]);
}

function randomPostalCode6() {
  // 6-digit numeric string.
  return String(randomInt(100000, 999999));
}

async function fillAddressInformationModal(page) {
  // After Address Lookup -> Continue, Common App shows an "Address Information" modal.
  const dialog = page.getByRole('dialog').filter({ hasText: /Address Information/i }).first();
  const heading = page.getByRole('heading', { name: /^\s*Address Information\s*$/i }).first();

  // Wait for modal to appear.
  try {
    await dialog.waitFor({ state: 'visible', timeout: 15_000 });
  } catch {
    await heading.waitFor({ state: 'visible', timeout: 15_000 });
  }

  const scope = (await dialog.isVisible().catch(() => false)) ? dialog : page;

  const scrollDialogFor = async () => {
    // Many fields are inside an inner scroller within the modal.
    await dialog
      .evaluate((el) => {
        const isScrollable = (n) => {
          if (!n || !(n instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(n);
          const oy = style.overflowY;
          const scrollable = (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && n.scrollHeight > n.clientHeight + 10;
          return scrollable;
        };

        const nodes = [el, ...Array.from(el.querySelectorAll('*'))].filter((n) => n instanceof HTMLElement);
        const scroller = nodes.find(isScrollable);
        const step = (node) => Math.max(140, Math.floor(node.clientHeight * 0.7));
        if (scroller) {
          scroller.scrollTop = Math.min(scroller.scrollTop + step(scroller), scroller.scrollHeight);
          scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
          return true;
        }
        el.scrollTop = Math.min(el.scrollTop + step(el), el.scrollHeight);
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
        return true;
      })
      .catch(() => false);
    await page.waitForTimeout(150).catch(() => {});
  };

  const fillByLabel = async (labelRe, value, logLabel) => {
    let input = scope.getByLabel(labelRe).first();
    const labelFallback = scope.locator('label').filter({ hasText: labelRe }).first();

    if (!(await input.isVisible().catch(() => false))) {
      const container = labelFallback
        .locator('xpath=ancestor::*[self::forge-field or self::forge-text-field or self::div or self::section][1]')
        .first();
      const containerControl = container.locator('input, textarea, select, [role="combobox"]').first();
      if (await containerControl.isVisible().catch(() => false)) {
        input = containerControl;
      } else {
        input = labelFallback.locator('xpath=following::*[self::input or self::textarea or self::select or @role="combobox"][1]').first();
      }
    }

    // Scroll inside the modal until the field is visible.
    for (let attempt = 0; attempt < 4; attempt++) {
      await input.scrollIntoViewIfNeeded().catch(() => {});
      if (await input.isVisible().catch(() => false)) break;
      await scrollDialogFor();
    }

    await input.waitFor({ state: 'visible', timeout: 10_000 });
    await input.scrollIntoViewIfNeeded().catch(() => {});

    const tag = await input.evaluate((el) => (el instanceof HTMLElement ? el.tagName.toLowerCase() : '')).catch(() => '');
    const role = await input.evaluate((el) => (el instanceof HTMLElement ? (el.getAttribute('role') || '') : '')).catch(() => '');

    // Handle select/combobox vs plain text inputs.
    if (tag === 'select') {
      await input.selectOption({ label: String(value) }).catch(async () => {
        // If the label isn't present (e.g., placeholder), pick first real option.
        await input.selectOption({ index: 1 }).catch(() => {});
      });
    } else if (String(role).toLowerCase() === 'combobox') {
      await input.click({ timeout: 2000 }).catch(async () => {
        await input.click({ timeout: 2000, force: true });
      });
      await page.keyboard.type(String(value), { delay: 0 }).catch(() => {});
      await page.keyboard.press('Enter').catch(() => {});
    } else {
      await input.click({ timeout: 2000 }).catch(async () => {
        await input.click({ timeout: 2000, force: true });
      });
      await input.fill('').catch(() => {});
      await input.type(String(value), { delay: 0 }).catch(async () => {
        await input.fill(String(value));
      });
    }

    console.log(`[commonapp] FILLED: "${logLabel}" = ${value}`);
  };

  await fillByLabel(/^\s*Address Line 1 \(Street Name and Number\)\s*\*?\s*$/i, randomAddressLine1(), 'Address Line 1 (Street Name and Number)');
  await fillByLabel(/^\s*Address Line 2\s*\*?\s*$/i, randomAddressLine2(), 'Address Line 2');
  await fillByLabel(/^\s*Address Line 3\s*\*?\s*$/i, randomAddressLine3(), 'Address Line 3');

  // Label is shown as "City or Town*" in the UI.
  try {
    await fillByLabel(/^\s*City\s*or\s*Town\s*\*?\s*$/i, randomCity(), 'City or Town');
  } catch {
    // Fallback for older label variants.
    await fillByLabel(/^\s*City\s*\*?\s*$/i, randomCity(), 'City');
  }

  await fillByLabel(/^\s*State\s*or\s*Province\s*\*?\s*$/i, randomStateOrProvince(), 'State or Province');
  await fillByLabel(/^\s*Postal\s*Code\s*\*?\s*$/i, randomPostalCode6(), 'Postal Code');

  // Requested: after postal code, wait 1s then click Continue.
  await page.waitForTimeout(1000).catch(() => {});

  // Fast path: stable id from outerHTML
  // <button class="button--primary" id="continueManualAddress182">Continue...</button>
  const manualContinueSelector = 'button#continueManualAddress182, button[id^="continueManualAddress"], button.button--primary[id^="continueManualAddress"]';
  const continueRe = /^\s*Continue\s*$/i;

  const candidates = [
    page.locator(manualContinueSelector),
    scope.locator(manualContinueSelector),
    scope.locator('button.button--primary').filter({ hasText: continueRe }),
    scope.getByRole('button', { name: continueRe }),
  ];

  for (const loc of candidates) {
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 6); i++) {
      const btn = loc.nth(i);
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      if (!(await btn.isVisible().catch(() => false))) continue;
      if (!(await btn.isEnabled().catch(() => true))) continue;
      await btn.click({ timeout: 5000, trial: true }).catch(() => {});
      await btn.click({ timeout: 5000 }).catch(async () => {
        await btn.click({ timeout: 5000, force: true });
      });
      await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
      console.log('[commonapp] CLICKED: "Address Information" -> "Continue"');
      return true;
    }
  }

  console.log('[commonapp] NOT CLICKED: "Address Information" -> "Continue"');
  return false;

  // unreachable
}

async function clickSectionContinue12(page, { delayMs = 1000 } = {}) {
  await page.waitForTimeout(delayMs).catch(() => {});
  const selector = 'button#sectionContinue12, button[id^="sectionContinue"], button.button--primary[id^="sectionContinue"]';
  const loc = page.locator(selector);
  const n = await loc.count().catch(() => 0);
  for (let i = 0; i < Math.min(n, 8); i++) {
    const btn = loc.nth(i);
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    if (!(await btn.isVisible().catch(() => false))) continue;
    const box = await btn.boundingBox().catch(() => null);
    if (box && box.x <= 360) continue;
    if (!(await btn.isEnabled().catch(() => true))) continue;
    await btn.click({ timeout: 5000, trial: true }).catch(() => {});
    await btn.click({ timeout: 5000 }).catch(async () => {
      await btn.click({ timeout: 5000, force: true });
    });
    console.log('[commonapp] CLICKED: "Continue" (sectionContinue12)');
    return true;
  }
  console.log('[commonapp] NOT CLICKED: "Continue" (sectionContinue12)');
  return false;
}

function randomPhoneNumber() {
  // Simple 10-digit mobile-like number.
  const first = randomInt(6, 9);
  const rest = String(randomInt(0, 999999999)).padStart(9, '0');
  return `${first}${rest}`;
}

async function fillContactDetails(page) {
  // Contact Details page: /common/*/13
  const urlRe = /\/common\/\d+\/13(\b|\/|\?|#)/i;
  const heading = page.getByRole('heading', { name: /^\s*Contact Details\s*$/i }).first();

  await page.waitForURL(urlRe, { timeout: 15_000 }).catch(() => {});
  await heading.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});

  const pickRadio = async (questionRe, optionRe, logLabel) => {
    const q = page.getByText(questionRe).first();
    await q.scrollIntoViewIfNeeded().catch(() => {});

    const container = q.locator('xpath=ancestor::*[self::fieldset or self::div][1]').first();

    const radio = container.getByRole('radio', { name: optionRe }).first();
    if (await radio.isVisible().catch(() => false)) {
      await radio.click({ timeout: 3000, force: true }).catch(() => {});
      console.log(`[commonapp] CLICKED: "${logLabel}" = ${String(optionRe)}`);
      return true;
    }

    const label = container.getByText(optionRe).first();
    if (await label.isVisible().catch(() => false)) {
      const clickable = label
        .locator(
          'xpath=ancestor-or-self::label | ancestor-or-self::button | ancestor-or-self::*[@role="radio"] | ancestor-or-self::*[@tabindex][1]'
        )
        .first();
      await clickable.click({ timeout: 3000, force: true }).catch(() => {});
      console.log(`[commonapp] CLICKED: "${logLabel}" = ${String(optionRe)}`);
      return true;
    }

    // Global fallback (avoid left nav)
    const globalRadio = page.getByRole('radio', { name: optionRe });
    const n = await globalRadio.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 8); i++) {
      const r = globalRadio.nth(i);
      const box = await r.boundingBox().catch(() => null);
      if (box && box.x <= 360) continue;
      if (!(await r.isVisible().catch(() => false))) continue;
      await r.click({ timeout: 3000, force: true }).catch(() => {});
      console.log(`[commonapp] CLICKED: "${logLabel}" = ${String(optionRe)} (global)`);
      return true;
    }

    console.log(`[commonapp] NOT CLICKED: "${logLabel}" = ${String(optionRe)}`);
    return false;
  };

  const fillPhoneByText = async (labelTextRe, numberValue, logLabel, { countryCode = null } = {}) => {
    const anchor = page.getByText(labelTextRe).first();
    await anchor.waitFor({ state: 'visible', timeout: 10_000 });
    await anchor.scrollIntoViewIfNeeded().catch(() => {});

    const container = anchor
      .locator('xpath=ancestor::*[self::forge-field or self::div or self::section or self::fieldset][1]')
      .first();

    const selectCountryCodeIfRequested = async () => {
      if (!countryCode) return false;

      const codeText = String(countryCode).trim();
      const digits = codeText.replace(/[^0-9]/g, '');
      const codeNeedle = digits ? `+${digits}` : codeText;
      const codeRe = new RegExp(escapeRegExp(codeNeedle), 'i');

      // Find a likely country-code dropdown control inside this field.
      const controlCandidates = [
        container.locator('select').first(),
        container.locator('[role="combobox"]').first(),
        container.locator('button').first(),
        container.locator('input[aria-label*="country" i], input[placeholder*="country" i]').first(),
        container.locator('input[aria-label*="code" i], input[placeholder*="code" i]').first(),
      ];

      let control = null;
      for (const cand of controlCandidates) {
        if (await cand.isVisible().catch(() => false)) {
          const box = await cand.boundingBox().catch(() => null);
          if (box && box.x <= 360) continue;
          control = cand;
          break;
        }
      }

      if (!control) return false;

      // If this is a native <select>, choose the option by value/label via DOM.
      const tag = await control.evaluate((el) => (el instanceof HTMLElement ? el.tagName.toLowerCase() : '')).catch(() => '');
      if (tag === 'select') {
        const ok = await control
          .evaluate(
            (el, code) => {
              const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
              const needle = norm(code);
              const select = el;
              if (!(select instanceof HTMLSelectElement)) return false;

              const opts = Array.from(select.options || []);
              const found = opts.find((o) => norm(o.textContent).includes(needle));
              if (!found) return false;
              select.value = found.value;
              select.dispatchEvent(new Event('input', { bubbles: true }));
              select.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            },
            codeNeedle
          )
          .catch(() => false);

        if (ok) {
          console.log(`[commonapp] SELECTED: "${logLabel}" country code = ${codeNeedle}`);
          return true;
        }
        console.log(`[commonapp] NOT SELECTED: "${logLabel}" country code = ${codeNeedle}`);
        return false;
      }

      await control.scrollIntoViewIfNeeded().catch(() => {});
      await control.click({ timeout: 2500 }).catch(async () => {
        await control.click({ timeout: 2500, force: true });
      });
      await page.waitForTimeout(200).catch(() => {});

      // 1) Prefer ARIA options when present.
      try {
        const option = page.getByRole('option', { name: codeRe }).first();
        await option.waitFor({ state: 'visible', timeout: 1500 });
        await option.scrollIntoViewIfNeeded().catch(() => {});
        await option.click({ timeout: 3000, force: true }).catch(() => {});
        console.log(`[commonapp] SELECTED: "${logLabel}" country code = ${codeNeedle}`);
        return true;
      } catch {
        // fall through
      }

      // 2) Text fallback in the open dropdown panel.
      try {
        const txt = page.getByText(codeRe).first();
        await txt.waitFor({ state: 'visible', timeout: 1500 });
        const clickable = txt
          .locator(
            'xpath=ancestor::*[@role="option"][1] | ancestor::li[1] | ancestor::button[1] | ancestor::a[1] | ancestor::div[1]'
          )
          .first();
        await clickable.scrollIntoViewIfNeeded().catch(() => {});
        await clickable.click({ timeout: 3000, force: true }).catch(() => {});
        console.log(`[commonapp] SELECTED: "${logLabel}" country code = ${codeNeedle}`);
        return true;
      } catch {
        // fall through
      }

      // 3) DOM scroll-and-click fallback for virtualized menus.
      const clicked = await page
        .evaluate(({ code }) => {
          const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
          const needle = norm(code);

          const isVisible = (el) => {
            if (!el || !(el instanceof HTMLElement)) return false;
            const style = window.getComputedStyle(el);
            if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') === 0) return false;
            const r = el.getBoundingClientRect();
            return r.width > 10 && r.height > 10;
          };

          const isScrollable = (el) => {
            if (!el || !(el instanceof HTMLElement)) return false;
            const style = window.getComputedStyle(el);
            const oy = style.overflowY;
            const scrollable = (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 10;
            return scrollable;
          };

          const findVisibleScrollable = () => {
            const candidates = Array.from(document.querySelectorAll('[role="listbox"], ul, ol, div'))
              .filter((n) => n instanceof HTMLElement)
              .filter((n) => isVisible(n) && isScrollable(n));
            // Prefer smaller panels (likely dropdown menu).
            candidates.sort((a, b) => a.clientHeight - b.clientHeight);
            return candidates[0] || null;
          };

          const clickByText = () => {
            const nodes = Array.from(document.querySelectorAll('[role="option"], li, button, a, div'))
              .filter((n) => n instanceof HTMLElement)
              .filter(isVisible);
            for (const n of nodes) {
              const t = norm(n.textContent);
              if (!t) continue;
              if (t.includes(needle)) {
                const clickable = n.closest('[role="option"]') || n.closest('li') || n.closest('button') || n.closest('a') || n;
                (clickable instanceof HTMLElement ? clickable : n).scrollIntoView({ block: 'center' });
                (clickable instanceof HTMLElement ? clickable : n).click();
                return true;
              }
            }
            return false;
          };

          if (clickByText()) return true;

          const scroller = findVisibleScrollable();
          if (!scroller) return false;

          const step = Math.max(60, Math.floor(scroller.clientHeight * 0.8));
          for (let i = 0; i < 120; i++) {
            scroller.scrollTop = Math.min(scroller.scrollTop + step, scroller.scrollHeight);
            scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
            if (clickByText()) return true;
          }
          return false;
        }, { code: codeNeedle })
        .catch(() => false);

      if (clicked) {
        console.log(`[commonapp] SELECTED: "${logLabel}" country code = ${codeNeedle}`);
        return true;
      }

      console.log(`[commonapp] NOT SELECTED: "${logLabel}" country code = ${codeNeedle}`);
      return false;
    };
    // If requested, set the country code first.
    await selectCountryCodeIfRequested().catch(() => {});

    const candidates = container.locator('input:not([type="hidden"])');
    const count = await candidates.count().catch(() => 0);

    let best = null;
    let bestWidth = -1;
    for (let i = 0; i < Math.min(count, 10); i++) {
      const c = candidates.nth(i);
      if (!(await c.isVisible().catch(() => false))) continue;
      if (!(await c.isEnabled().catch(() => true))) continue;
      const maybeCode = await c
        .evaluate((el) => {
          if (!(el instanceof HTMLInputElement)) return false;
          const v = (el.value || '').trim();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          const ph = (el.getAttribute('placeholder') || '').toLowerCase();
          return v.startsWith('+') || aria.includes('country') || ph.includes('country') || aria.includes('code') || ph.includes('code');
        })
        .catch(() => false);
      if (maybeCode) continue;
      const box = await c.boundingBox().catch(() => null);
      if (!box) continue;
      if (box.x <= 360) continue;
      if (box.width > bestWidth) {
        bestWidth = box.width;
        best = c;
      }
    }

    if (!best) {
      best = anchor.locator('xpath=following::*[self::input and not(@type="hidden")][1]').first();
    }

    await best.waitFor({ state: 'visible', timeout: 10_000 });
    await best.scrollIntoViewIfNeeded().catch(() => {});
    await best.click({ timeout: 2000 }).catch(async () => {
      await best.click({ timeout: 2000, force: true });
    });
    await best.fill('').catch(() => {});
    await best.type(String(numberValue), { delay: 0 }).catch(async () => {
      await best.fill(String(numberValue));
    });
    console.log(`[commonapp] FILLED: "${logLabel}" = ${numberValue}`);
    return best;
  };

  // Preferred phone: choose Mobile and fill a random number.
  await pickRadio(/^\s*Preferred phone\s*\*?\s*$/i, /^\s*Mobile\s*$/i, 'Preferred phone');
  const preferredNumber = randomPhoneNumber();
  const preferredInput = await fillPhoneByText(/Preferred\s+phone\s+number/i, preferredNumber, 'Preferred phone number', { countryCode: '+91' });

  // Alternate phone: choose Mobile and fill a random number.
  await pickRadio(/^\s*Alternate phone\s*\*?\s*$/i, /^\s*Mobile\s*$/i, 'Alternate phone');
  const alternateNumber = randomPhoneNumber();
  const alternateInput = await fillPhoneByText(/Alternate\s+phone\s+number/i, alternateNumber, 'Alternate phone number', { countryCode: '+93' });

  // Then Continue.
  await page.waitForTimeout(1000).catch(() => {});
  await clickContinueNearLocator(page, alternateInput || preferredInput, 'Continue (Contact Details)');
  return true;
}

async function fillDemographicsGenderAndLegalSex(page) {
  // Demographics page: /common/*/14
  const urlRe = /\/common\/\d+\/14(\b|\/|\?|#)/i;
  const heading = page.getByRole('heading', { name: /^\s*Demographics\s*$/i }).first();

  await page.waitForURL(urlRe, { timeout: 15_000 }).catch(() => {});
  await heading.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});

  const clickFirstCheckboxNearQuestion = async (questionRe, logLabel, { optionRe = null } = {}) => {
    const anchor = page.locator('main').getByText(questionRe).first();
    try {
      await anchor.waitFor({ state: 'visible', timeout: 10_000 });
    } catch {
      console.log(`[commonapp] NOT FOUND: "${logLabel}" question text`);
      return false;
    }
    await anchor.scrollIntoViewIfNeeded().catch(() => {});

    const container = anchor.locator('xpath=ancestor::*[self::fieldset or self::forge-field or self::section or self::div][1]').first();

    // If a specific option was requested (e.g., "She/Her"), try it and do NOT fall back to arbitrary checkboxes.
    if (optionRe) {
      const desired = container.getByRole('checkbox', { name: optionRe }).first();
      if (await desired.isVisible().catch(() => false)) {
        const bb = await desired.boundingBox().catch(() => null);
        if (bb && bb.x > 360 && (await desired.isEnabled().catch(() => true))) {
          if (await desired.isChecked().catch(() => false)) {
            console.log(`[commonapp] ALREADY SET: "${logLabel}" = ${String(optionRe)} (checkbox already checked)`);
            return true;
          }
          await desired.click({ timeout: 3000, force: true }).catch(() => {});
          const ok = await desired.isChecked().catch(() => true);
          console.log(ok ? `[commonapp] CLICKED: "${logLabel}" = ${String(optionRe)}` : `[commonapp] CLICK ATTEMPTED: "${logLabel}" = ${String(optionRe)}`);
          return ok;
        }
      }

      // Fallback: click the label text for the option.
      const desiredText = container.getByText(optionRe).first();
      if (await desiredText.isVisible().catch(() => false)) {
        const bb = await desiredText.boundingBox().catch(() => null);
        if (!(bb && bb.x <= 360)) {
          const clickable = desiredText
            .locator('xpath=ancestor::label[1] | ancestor::button[1] | ancestor::*[@role="checkbox"][1] | ancestor::*[@tabindex][1]')
            .first();
          await clickable.click({ timeout: 3000, force: true }).catch(() => {});
          console.log(`[commonapp] CLICKED: "${logLabel}" = ${String(optionRe)}`);
          return true;
        }
      }

      console.log(`[commonapp] NOT CLICKED: "${logLabel}" = ${String(optionRe)}`);
      return false;
    }

    // Prefer role-based checkbox.
    const roleBoxes = container.getByRole('checkbox');
    const nRole = await roleBoxes.count().catch(() => 0);
    for (let i = 0; i < Math.min(nRole, 8); i++) {
      const box = roleBoxes.nth(i);
      const bb = await box.boundingBox().catch(() => null);
      if (bb && bb.x <= 360) continue;
      if (!(await box.isVisible().catch(() => false))) continue;
      if (!(await box.isEnabled().catch(() => true))) continue;
      if (await box.isChecked().catch(() => false)) {
        console.log(`[commonapp] ALREADY SET: "${logLabel}" (checkbox already checked)`);
        return true;
      }
      await box.click({ timeout: 3000, force: true }).catch(() => {});
      console.log(`[commonapp] CLICKED: "${logLabel}" (picked one checkbox option)`);
      return true;
    }

    // Fallback: native input[type=checkbox] + label click.
    const inputs = container.locator('input[type="checkbox"]');
    const n = await inputs.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 10); i++) {
      const input = inputs.nth(i);
      if (await input.isChecked().catch(() => false)) {
        console.log(`[commonapp] ALREADY SET: "${logLabel}" (checkbox already checked)`);
        return true;
      }

      const id = await input.getAttribute('id').catch(() => null);
      const label = id ? container.locator(`label[for="${id}"]`).first() : input.locator('xpath=ancestor::label[1]').first();

      if (await label.isVisible().catch(() => false)) {
        const bb = await label.boundingBox().catch(() => null);
        if (bb && bb.x <= 360) continue;
        await label.click({ timeout: 3000, force: true }).catch(() => {});
        console.log(`[commonapp] CLICKED: "${logLabel}" (picked one checkbox option)`);
        return true;
      }

      // Last resort: click input itself.
      const bb = await input.boundingBox().catch(() => null);
      if (bb && bb.x <= 360) continue;
      await input.click({ timeout: 3000, force: true }).catch(() => {});
      console.log(`[commonapp] CLICKED: "${logLabel}" (picked one checkbox option)`);
      return true;
    }

    console.log(`[commonapp] NOT CLICKED: "${logLabel}" (no checkbox options found)`);
    return false;
  };

  const clickFirstRadioNearQuestion = async (questionRe, logLabel, { optionRe = null } = {}) => {
    const anchor = page.locator('main').getByText(questionRe).first();
    try {
      await anchor.waitFor({ state: 'visible', timeout: 10_000 });
    } catch {
      console.log(`[commonapp] NOT FOUND: "${logLabel}" question text`);
      return false;
    }
    await anchor.scrollIntoViewIfNeeded().catch(() => {});

    const container = anchor.locator('xpath=ancestor::*[self::fieldset or self::forge-field or self::section or self::div][1]').first();

    // If a specific option was requested (e.g., "No"), try it and do NOT fall back to arbitrary radios.
    if (optionRe) {
      const desired = container.getByRole('radio', { name: optionRe }).first();
      if (await desired.isVisible().catch(() => false)) {
        const bb = await desired.boundingBox().catch(() => null);
        if (bb && bb.x > 360 && (await desired.isEnabled().catch(() => true))) {
          if (await desired.isChecked().catch(() => false)) {
            console.log(`[commonapp] ALREADY SET: "${logLabel}" = ${String(optionRe)} (radio already checked)`);
            return true;
          }
          await desired.click({ timeout: 3000, force: true }).catch(() => {});
          const ok = await desired.isChecked().catch(() => true);
          console.log(ok ? `[commonapp] CLICKED: "${logLabel}" = ${String(optionRe)}` : `[commonapp] CLICK ATTEMPTED: "${logLabel}" = ${String(optionRe)}`);
          return ok;
        }
      }

      // Fallback: click the label text for the option.
      const desiredText = container.getByText(optionRe).first();
      if (await desiredText.isVisible().catch(() => false)) {
        const bb = await desiredText.boundingBox().catch(() => null);
        if (!(bb && bb.x <= 360)) {
          const clickable = desiredText
            .locator('xpath=ancestor::label[1] | ancestor::button[1] | ancestor::*[@role="radio"][1] | ancestor::*[@tabindex][1]')
            .first();
          await clickable.click({ timeout: 3000, force: true }).catch(() => {});
          console.log(`[commonapp] CLICKED: "${logLabel}" = ${String(optionRe)}`);
          return true;
        }
      }

      console.log(`[commonapp] NOT CLICKED: "${logLabel}" = ${String(optionRe)}`);
      return false;
    }

    const radios = container.getByRole('radio');
    const n = await radios.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 8); i++) {
      const r = radios.nth(i);
      const bb = await r.boundingBox().catch(() => null);
      if (!bb || bb.x <= 360) continue;
      if (!(await r.isVisible().catch(() => false))) continue;
      if (!(await r.isEnabled().catch(() => true))) continue;
      if (await r.isChecked().catch(() => false)) {
        console.log(`[commonapp] ALREADY SET: "${logLabel}" (radio already checked)`);
        return true;
      }
      await r.click({ timeout: 3000, force: true }).catch(() => {});
      console.log(`[commonapp] CLICKED: "${logLabel}" (picked one radio option)`);
      return true;
    }

    // Fallback: native input[type=radio]
    const inputs = container.locator('input[type="radio"]');
    const n2 = await inputs.count().catch(() => 0);
    for (let i = 0; i < Math.min(n2, 10); i++) {
      const input = inputs.nth(i);
      if (await input.isChecked().catch(() => false)) {
        console.log(`[commonapp] ALREADY SET: "${logLabel}" (radio already checked)`);
        return true;
      }
      const id = await input.getAttribute('id').catch(() => null);
      const label = id ? container.locator(`label[for="${id}"]`).first() : input.locator('xpath=ancestor::label[1]').first();
      if (await label.isVisible().catch(() => false)) {
        const bb = await label.boundingBox().catch(() => null);
        if (!bb || bb.x <= 360) continue;
        await label.click({ timeout: 3000, force: true }).catch(() => {});
        console.log(`[commonapp] CLICKED: "${logLabel}" (picked one radio option)`);
        return true;
      }
      const bb = await input.boundingBox().catch(() => null);
      if (!bb || bb.x <= 360) continue;
      await input.click({ timeout: 3000, force: true }).catch(() => {});
      console.log(`[commonapp] CLICKED: "${logLabel}" (picked one radio option)`);
      return true;
    }

    console.log(`[commonapp] NOT CLICKED: "${logLabel}" (no radio options found)`);
    return false;
  };

  await clickFirstCheckboxNearQuestion(/^\s*Gender\s*$/i, 'Gender');
  await clickFirstRadioNearQuestion(/\bLegal\s+sex\b/i, 'Legal sex');
  await clickFirstCheckboxNearQuestion(/^\s*Pronouns\s*$/i, 'Pronouns', { optionRe: /\bShe\s*\/\s*Her\b/i });
  await clickFirstRadioNearQuestion(/U\.?\s*S\.?\s*Armed\s*Forces\s*status/i, 'U.S. Armed Forces status', { optionRe: /^\s*None\s*$/i });
  await clickFirstRadioNearQuestion(/Hispanic\s+or\s+Latino/i, 'Are you Hispanic or Latino/a/x?', { optionRe: /^\s*No\s*$/i });
  await clickFirstCheckboxNearQuestion(
    /identify\s+yourself/i,
    'Identify yourself (select one or more)',
    { optionRe: /^\s*Asian\s*$/i }
  );
  await clickFirstCheckboxNearQuestion(
    /Which\s+best\s+describes\s+your\s+Asian\s+background\?/i,
    'Asian background (select one or more)',
    { optionRe: /^\s*India\s*$/i }
  );

  // Then Continue.
  await page.waitForTimeout(1000).catch(() => {});
  await clickContinueNearLocator(page, heading, 'Continue (Demographics)');

  return true;
}

async function waitForDashboard(page, { timeoutMs = 10 * 60 * 1000, tryGotoDashboard = false } = {}) {
  const start = Date.now();

  const isStableDashboard = async () => {
    const url1 = page.url() || '';
    if (!(isOnDashboard(url1) && !isLoginish(url1))) return false;

    // Dashboard should render the left sidebar (like in your screenshot).
    // Use a best-effort check for sidebar/nav items that only appear when logged in.
    const sidebarReady = async () => {
      try {
        const dashboardItem = page.locator('nav a, nav button, aside a, aside button').filter({ hasText: /^\s*Dashboard\s*$/i });
        const signOutItem = page.locator('nav a, nav button, aside a, aside button').filter({ hasText: /\bsign\s*out\b/i });
        const myCommonAppItem = page.locator('nav a, nav button, aside a, aside button').filter({ hasText: /\bmy\s+common\s+application\b/i });

        const anyVisible =
          (await dashboardItem.first().isVisible().catch(() => false)) ||
          (await signOutItem.first().isVisible().catch(() => false)) ||
          (await myCommonAppItem.first().isVisible().catch(() => false));

        return anyVisible;
      } catch {
        return false;
      }
    };

    // Allow the SPA to settle; also catches redirects that happen shortly after navigation.
    await page.waitForTimeout(1200).catch(() => {});
    if (!(await sidebarReady())) return false;

    const url2 = page.url() || '';
    return isOnDashboard(url2) && !isLoginish(url2);
  };

  // If we have a saved session, it's faster to try the dashboard immediately.
  if (tryGotoDashboard) {
    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    if (await isStableDashboard()) return true;
  }

  console.log(`[commonapp] Waiting for manual login... Current URL: ${page.url()}`);

  while (Date.now() - start < timeoutMs) {
    // Poll quickly; we want to proceed ASAP.
    await page.waitForTimeout(250).catch(() => {});

    // Cookie banner often appears on login and can block the UI.
    await acceptCookiesIfPresent(page);

    if (await isStableDashboard()) return true;
  }

  return false;
}

async function clickMyCommonApplicationOnce(
  page,
  { delayMs = 500, timeoutMs = 12_000, verifyProfileVisible = true } = {}
) {
  const nameRe = /\bmy\s+common\s+application\b/i;
  const clickWaitMs = 400;

  if (!isOnDashboard(page.url())) {
    console.log(`[commonapp] NOT CLICKED: not on dashboard (url=${page.url()})`);
    return false;
  }

  console.log('[commonapp] On dashboard. Trying to click "My Common Application" once...');

  const beforeUrl = page.url();

  const profileTitle = page.locator('#secondaryNavItem3Title').first();

  const isProfileVisible = async () => {
    // Profile exists in the DOM even when collapsed; we need it actually visible.
    return await profileTitle.isVisible().catch(() => false);
  };

  const verifyAfterMyCommonAppClick = async () => {
    if (!verifyProfileVisible) return true;
    // Give the SPA a moment to expand/hydrate.
    for (let i = 0; i < 10; i++) {
      if (await isProfileVisible()) return true;
      await page.waitForTimeout(150).catch(() => {});
    }
    return false;
  };

  const clickIfVisible = async (loc, label) => {
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 8); i++) {
      const item = loc.nth(i);
      if (!(await item.isVisible().catch(() => false))) continue;

      const box = await item.boundingBox().catch(() => null);
      if (box && box.x <= 360) {
        await page.waitForTimeout(delayMs).catch(() => {});
        await item.scrollIntoViewIfNeeded().catch(() => {});
        await item.click({ force: true, timeout: 1200 }).catch(async () => {
          await item.click({ force: true, timeout: 1200 });
        });
        await page.waitForTimeout(clickWaitMs).catch(() => {});
        const ok = await verifyAfterMyCommonAppClick().catch(() => false);
        if (ok) {
          console.log(`[commonapp] CLICKED: "My Common Application" (${label}) (verified) (url=${page.url()})`);
          return true;
        }

        console.log(`[commonapp] CLICK ATTEMPTED: "My Common Application" (${label}) but Profile not visible yet`);
      }
    }
    return false;
  };

  const domClickLabelFallback = async () => {
    // Fallback for cases where the label is nested and the clickable ancestor is an <a>/<button>.
    const clicked = await page
      .evaluate(() => {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const isVisible = (el) => {
          if (!el || !(el instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(el);
          if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') === 0) return false;
          const r = el.getBoundingClientRect();
          if (!r || r.width < 2 || r.height < 2) return false;
          return true;
        };

        const labelText = 'my common application';
        // Prefer labels inside nav/aside (avoid center content headings).
        const labels = Array.from(
          document.querySelectorAll('nav .nav-item__label, aside .nav-item__label, #appNavMain .nav-item__label, .nav-item__label')
        )
          .filter((n) => n instanceof HTMLElement)
          .filter((n) => isVisible(n) && norm(n.textContent).includes(labelText));
        const label = labels[0];
        if (!label) return false;

        const candidates = [];
        const add = (el) => {
          if (el && el instanceof HTMLElement) candidates.push(el);
        };

        add(label.closest('a'));
        add(label.closest('button'));
        add(label.closest('[role="button"]'));
        add(label.closest('[tabindex]'));
        add(label.closest('.nav-item'));
        add(label.closest('li'));
        add(label);

        const firstClickable = candidates.find((el) => isVisible(el));
        if (!firstClickable) return false;

        // Make sure it's in the left sidebar.
        const r = firstClickable.getBoundingClientRect();
        if (r.left > 360) return false;

        firstClickable.scrollIntoView({ block: 'center' });
        firstClickable.click();
        return true;
      })
      .catch(() => false);

    if (clicked) {
      await page.waitForTimeout(clickWaitMs).catch(() => {});
      const ok = await verifyAfterMyCommonAppClick().catch(() => false);
      if (ok) {
        console.log(`[commonapp] CLICKED: "My Common Application" (DOM label fallback, verified) (url=${page.url()})`);
        return true;
      }
      console.log('[commonapp] CLICK ATTEMPTED: "My Common Application" (DOM label fallback) but Profile not visible yet');
    }
    return false;
  };

  // If the nav is behind a hamburger/menu, try opening it (best-effort).
  try {
    const appNavMain = page.locator('#appNavMain').first();
    const navVisible = await appNavMain.isVisible().catch(() => false);
    if (!navVisible) {
      const menuBtn = page.getByRole('button', { name: /menu/i }).first();
      if (await menuBtn.isVisible().catch(() => false)) {
        await menuBtn.click({ force: true, timeout: 200 }).catch(() => {});
      }
    }
  } catch {
    // ignore
  }

  // Prefer the left sidebar item (like in your screenshot).
  // Wait/retry: sidebar often hydrates after dashboard is visible.
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const sidebarLocators = [
      page.locator('#appNavMain a, #appNavMain button').filter({ hasText: nameRe }),
      page.locator('aside a, aside button').filter({ hasText: nameRe }),
      page.locator('nav a, nav button').filter({ hasText: nameRe }),
      page.getByRole('link', { name: nameRe }),
      page.getByRole('button', { name: nameRe }),
      page.locator('a, button').filter({ hasText: nameRe }),
      // Stable label element (provided outerHTML): <div class="nav-item__label">My Common Application</div>
      page.locator('.nav-item__label').filter({ hasText: nameRe }),
    ];

    for (const [idx, loc] of sidebarLocators.entries()) {
      const ok = await clickIfVisible(loc, `locator#${idx + 1}`).catch(() => false);
      if (ok) {
        const afterUrl = page.url();
        if (!isOnDashboard(afterUrl) || afterUrl !== beforeUrl) {
          console.log('[commonapp] Click result: navigation changed');
        } else {
          console.log('[commonapp] Click result: URL unchanged (still dashboard)');
        }
        return true;
      }
    }

    if (await domClickLabelFallback()) {
      const afterUrl = page.url();
      if (!isOnDashboard(afterUrl) || afterUrl !== beforeUrl) {
        console.log('[commonapp] Click result: navigation changed');
      } else {
        console.log('[commonapp] Click result: URL unchanged (still dashboard)');
      }
      return true;
    }

    await page.waitForTimeout(250).catch(() => {});
  }

  console.log('[commonapp] NOT CLICKED: "My Common Application" not found/visible in left sidebar.');
  return false;
}

async function clickProfileOnce(page, { delayMs = 500, timeoutMs = 10_000 } = {}) {
  // Stable id from provided outerHTML:
  // <span class="nav-item__label" id="secondaryNavItem3Title"> Profile</span>
  const byId = page.locator('#secondaryNavItem3Title').first();
  const byText = page
    .locator('nav a, nav button, aside a, aside button, button, a, .nav-item__label')
    .filter({ hasText: /^\s*Profile\s*$/i })
    .first();

  const clickNearestClickable = async (loc) => {
    await loc.waitFor({ state: 'visible', timeout: timeoutMs });
    await page.waitForTimeout(delayMs).catch(() => {});
    const clickable = loc
      .locator('xpath=ancestor::a[1] | ancestor::button[1] | ancestor::*[@role="button"][1] | ancestor::*[@tabindex][1] | ancestor::*[contains(@class,"nav-item")][1]')
      .first();
    const target = (await clickable.isVisible().catch(() => false)) ? clickable : loc;
    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.click({ force: true, timeout: 1200 }).catch(async () => {
      await target.click({ force: true, timeout: 1200 });
    });
    return true;
  };

  try {
    if (await byId.isVisible().catch(() => false)) {
      await clickNearestClickable(byId);
      console.log(`[commonapp] CLICKED: "Profile" (id fast-path) (url=${page.url()})`);
      return true;
    }
  } catch {
    // ignore
  }

  try {
    await clickNearestClickable(byText);
    console.log(`[commonapp] CLICKED: "Profile" (text) (url=${page.url()})`);
    return true;
  } catch (err) {
    console.log(`[commonapp] NOT CLICKED: "Profile" (${err.message})`);
    return false;
  }
}

(async () => {
  const { fast, useSaved, clearState, keepOpen } = parseArgs(process.argv.slice(2));

  if (clearState && fs.existsSync(STORAGE_STATE_PATH)) {
    fs.unlinkSync(STORAGE_STATE_PATH);
    console.log('[commonapp] Cleared saved session.');
  }

  const slowMo = fast ? 0 : 15;

  console.log(`[commonapp] Launching Chromium (headed) slowMo=${slowMo}`);
  const browser = await chromium.launch({ headless: false, slowMo });

  const context = useSaved && fs.existsSync(STORAGE_STATE_PATH)
    ? await browser.newContext({ storageState: STORAGE_STATE_PATH })
    : await browser.newContext();
  const page = await context.newPage();

  // Always start from login page (per requirement).
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await acceptCookiesIfPresent(page);

  const ok = await waitForDashboard(page, { tryGotoDashboard: useSaved });
  if (!ok) {
    console.log('[commonapp] Timed out waiting for dashboard.');
    if (keepOpen) {
      console.log('[commonapp] Browser will stay open. Press Ctrl+C in this terminal when done.');
      await new Promise(() => {});
    }
    await browser.close().catch(() => {});
    process.exitCode = 1;
    return;
  }

  // Save session once we're confirmed on dashboard.
  try {
    const state = await context.storageState();
    fs.writeFileSync(STORAGE_STATE_PATH, JSON.stringify(state, null, 2));
  } catch {
    // ignore
  }

  // Click once after reaching dashboard.
  const clicked = await clickMyCommonApplicationOnce(page, { delayMs: 500 });

  if (clicked) {
    try {
      // Click "Profile" quickly (0.5s cadence) using the stable id fast-path.
      const profileClicked = await clickProfileOnce(page, { delayMs: 500 });
      if (profileClicked) {
        console.log(`[commonapp] CLICKED: "Profile" (url=${page.url()})`);

        // We need Personal Information (not just any /common/* page).
        // URL in your screenshot looks like: /common/3/11
        const personalInfoUrlRe = /\/common\/\d+\/11(\b|\/|\?|#)/i;
        const personalInfoHeadingRe = /^\s*Personal Information\s*$/i;

        await page.waitForTimeout(300).catch(() => {});

        // First, wait briefly for the correct URL.
        await page.waitForURL(personalInfoUrlRe, { timeout: 6000 }).catch(() => {});

        // If we still aren't on Personal Information, click it in the left nav.
        if (!personalInfoUrlRe.test(page.url() || '')) {
          const clickedPI = await clickLeftNavItemByText(page, /Personal Information/i);
          if (clickedPI) {
            console.log('[commonapp] CLICKED: "Personal Information" (left nav)');
            await page.waitForURL(personalInfoUrlRe, { timeout: 8000 }).catch(() => {});
          } else {
            console.log('[commonapp] NOT CLICKED: "Personal Information" not found in left nav');
          }
        }

        // Ensure the form is present.
        await page.waitForTimeout(200).catch(() => {});
        await acceptCookiesIfPresent(page);
        await page.getByRole('heading', { name: personalInfoHeadingRe }).first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
        console.log(`[commonapp] On page: ${page.url()}`);

        // Fill "Legal first/given name*" with Aryan (label-driven like UCAS).
        try {
          let legalInput = page.getByLabel(/Legal first\/given name/i).first();
          const labelFallback = page.locator('label').filter({ hasText: /Legal first\/given name/i }).first();
          if (!(await legalInput.isVisible().catch(() => false))) {
            legalInput = labelFallback.locator('xpath=following::input[1]').first();
          }
          await legalInput.waitFor({ state: 'visible', timeout: 8000 });
          await legalInput.fill('Aryan');
          console.log('[commonapp] FILLED: "Legal first/given name" = Aryan');
        } catch (err) {
          console.log(`[commonapp] FILL FAILED: Legal first/given name (${err.message})`);
        }

        // Fill "Middle name" with meow.
        try {
          let middleInput = page.getByLabel(/^\s*Middle name\s*$/i).first();
          const middleLabelFallback = page.locator('label').filter({ hasText: /^\s*Middle name\s*$/i }).first();
          if (!(await middleInput.isVisible().catch(() => false))) {
            middleInput = middleLabelFallback.locator('xpath=following::input[1]').first();
          }
          await middleInput.waitFor({ state: 'visible', timeout: 8000 });
          await middleInput.fill('meow');
          console.log('[commonapp] FILLED: "Middle name" = meow');
        } catch (err) {
          console.log(`[commonapp] FILL FAILED: Middle name (${err.message})`);
        }

        // Fill "Last/family/surname*" with maity.
        try {
          let lastInput = page.getByLabel(/Last\s*\/\s*family\s*\/\s*surname/i).first();
          const lastLabelFallback = page.locator('label').filter({ hasText: /Last\s*\/\s*family\s*\/\s*surname/i }).first();
          if (!(await lastInput.isVisible().catch(() => false))) {
            lastInput = lastLabelFallback.locator('xpath=following::input[1]').first();
          }
          await lastInput.waitFor({ state: 'visible', timeout: 8000 });
          await lastInput.fill('maity');
          console.log('[commonapp] FILLED: "Last/family/surname" = maity');
        } catch (err) {
          console.log(`[commonapp] FILL FAILED: Last/family/surname (${err.message})`);
        }

        // Select "Suffix" = X (dropdown).
        try {
          const suffixLabelRe = /^\s*Suffix\s*$/i;
          let suffixControl = page.getByLabel(suffixLabelRe).first();
          const suffixLabelFallback = page.locator('label').filter({ hasText: suffixLabelRe }).first();

          if (!(await suffixControl.isVisible().catch(() => false))) {
            // Some UIs don't wire aria-label to the control; find the next select/combobox after label.
            suffixControl = suffixLabelFallback
              .locator('xpath=following::*[self::select or @role="combobox" or self::button][1]')
              .first();
          }

          await suffixControl.waitFor({ state: 'visible', timeout: 8000 });
          await suffixControl.scrollIntoViewIfNeeded().catch(() => {});

          const isSelect = await suffixControl.evaluate((el) => el && el.tagName === 'SELECT').catch(() => false);
          if (isSelect) {
            // Native select.
            await suffixControl.selectOption({ label: 'X' }).catch(async () => {
              await suffixControl.selectOption({ value: 'X' });
            });
            console.log('[commonapp] SELECTED: "Suffix" = X');
          } else {
            // Custom dropdown.
            await suffixControl.click({ force: true, timeout: 800 }).catch(() => {});

            const optionRe = /^\s*X\s*$/i;
            const optionCandidates = [
              page.getByRole('option', { name: optionRe }).first(),
              page.getByRole('listbox').getByText(optionRe).first(),
              page.locator('[role="listbox"] [role="option"]').filter({ hasText: optionRe }).first(),
              page.locator('li, div, span').filter({ hasText: optionRe }).first(),
            ];

            let picked = false;
            for (const opt of optionCandidates) {
              if (await opt.isVisible().catch(() => false)) {
                await opt.click({ force: true, timeout: 800 });
                picked = true;
                break;
              }
            }

            if (picked) {
              console.log('[commonapp] SELECTED: "Suffix" = X');
            } else {
              console.log('[commonapp] NOT SELECTED: "Suffix" option X not found');
            }
          }
        } catch (err) {
          console.log(`[commonapp] SELECT FAILED: Suffix (${err.message})`);
        }

        // For the question, click "No".
        try {
          const question = page.getByText(/Would you like to share a different first name that people call you\?/i).first();
          await question.waitFor({ state: 'visible', timeout: 8000 });
          const block = question.locator('xpath=ancestor::*[self::fieldset or self::div][1]');

          const noRadio = block.getByRole('radio', { name: /^\s*No\s*$/i }).first();
          const noLabel = block.getByText(/^\s*No\s*$/i).first();

          if (await noRadio.isVisible().catch(() => false)) {
            await noRadio.click({ force: true, timeout: 800 });
          } else if (await noLabel.isVisible().catch(() => false)) {
            const clickable = noLabel
              .locator('xpath=ancestor-or-self::label | ancestor-or-self::button | ancestor-or-self::*[@role="radio"] | ancestor-or-self::*[@tabindex][1]')
              .first();
            await clickable.click({ force: true, timeout: 800 });
          } else {
            // Fallback: try any visible radio named No
            await page.getByRole('radio', { name: /no/i }).first().click({ force: true, timeout: 800 });
          }

          console.log('[commonapp] CLICKED: "No"');
        } catch (err) {
          console.log(`[commonapp] CLICK FAILED: "No" (${err.message})`);
        }

        // Do you have any materials under a former legal name? -> click "No".
        await clickNoForYesNoQuestion(
          page,
          /Do you have any materials under a former legal name\?/i,
          'Do you have any materials under a former legal name?'
        );

        // Fill Date of birth with a random value
        let continuedToAddress = false;
        try {
          const dobValue = randomDobString();
          let dobInput = page.getByLabel(/^\s*Date of birth\s*\*?\s*$/i).first();
          const dobLabelFallback = page.locator('label').filter({ hasText: /^\s*Date of birth\s*\*?\s*$/i }).first();
          if (!(await dobInput.isVisible().catch(() => false))) {
            dobInput = dobLabelFallback.locator('xpath=following::input[1]').first();
          }

          await dobInput.waitFor({ state: 'visible', timeout: 8000 });
          await dobInput.scrollIntoViewIfNeeded().catch(() => {});
          await dobInput.click({ timeout: 800 }).catch(() => {});
          await dobInput.fill('');
          await dobInput.type(dobValue, { delay: 0 }).catch(async () => {
            await dobInput.fill(dobValue);
          });
          // Commit the value (many date inputs validate on blur).
          await dobInput.press('Tab').catch(() => {});
          await page.waitForTimeout(800).catch(() => {});
          console.log(`[commonapp] FILLED: "Date of birth" = ${dobValue}`);

          // Click the blue "Continue" button under Date of birth.
          continuedToAddress = await clickContinueNearLocator(page, dobInput, 'Continue');
          await page.waitForLoadState('domcontentloaded').catch(() => {});
        } catch (err) {
          console.log(`[commonapp] FILL FAILED: Date of birth (${err.message})`);
        }

        // Address flow (separate from DOB so errors log correctly)
        if (continuedToAddress) {
          try {
            // After Continue, Address section loads -> click "Add address".
            try {
              const before = page.url();
              await page.waitForURL((u) => u.toString() !== before, { timeout: 10_000 }).catch(() => {});
            } catch {
              // ignore
            }

            const opened = await clickAddAddressButton(page);
            if (opened) {
              await selectCountryInAddressLookup(page, 'India');
              const selected = await selectIDontSeeMyAddressInThisList(page);
              if (selected) {
                const continued = await clickAddressLookupContinue(page, { delayMs: 1000 });
                if (continued) {
                  try {
                    const addrInfoOk = await fillAddressInformationModal(page);
                    if (addrInfoOk) {
                      const moved = await clickSectionContinue12(page, { delayMs: 1000 });
                      if (moved) {
                        try {
                          await fillContactDetails(page);

                          try {
                            await fillDemographicsGenderAndLegalSex(page);
                          } catch (err) {
                            console.log(`[commonapp] FILL FAILED: Demographics (Gender/Legal sex) (${err.message})`);
                          }
                        } catch (err) {
                          console.log(`[commonapp] FILL FAILED: Contact Details (${err.message})`);
                        }
                      }
                    }
                  } catch (err) {
                    console.log(`[commonapp] FILL FAILED: Address Information (${err.message})`);
                  }
                }
              }
            }
          } catch (err) {
            console.log(`[commonapp] FLOW FAILED: Address (${err.message})`);
          }
        }
      } else {
        console.log('[commonapp] NOT CLICKED: "Profile" not visible');
      }
    } catch {
      console.log('[commonapp] NOT CLICKED: "Profile" click failed');
    }
  }

  console.log(`[commonapp] Current URL: ${page.url()}`);
  if (keepOpen) {
    console.log('[commonapp] Browser will stay open. Press Ctrl+C in this terminal when done.');
    await new Promise(() => {});
    return;
  }

  await browser.close().catch(() => {});
  process.exitCode = clicked ? 0 : 1;
})();
