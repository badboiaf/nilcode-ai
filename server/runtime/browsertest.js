// Browser-testing foundation. Uses Playwright (free, open-source). If the
// Chromium browser has not been downloaded yet (`npm run install:browsers`),
// testing degrades gracefully with a clear instruction instead of crashing.
let playwright = null;
async function loadPlaywright() {
  if (playwright !== null) return playwright;
  try {
    playwright = await import('playwright-core');
  } catch {
    playwright = false;
  }
  return playwright;
}

export async function browserTestingAvailable() {
  return !!(await loadPlaywright());
}

export async function testSite(url, { screenshots = false } = {}) {
  const pw = await loadPlaywright();
  if (!pw) {
    return {
      ok: false,
      skipped: true,
      message: 'Playwright Chromium is not installed yet. Run "npm run install:browsers" once to enable in-app browser testing.',
      consoleErrors: [],
      results: [],
    };
  }
  const { chromium } = pw;
  let browser;
  const consoleErrors = [];
  const results = [];
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    await page.goto(url, { waitUntil: 'load', timeout: 20000 });
    const title = await page.title();
    results.push({ check: 'page loads', ok: true, detail: title || '(no title)' });

    // Broken images / links.
    const imgs = await page.$$eval('img', (els) => els.map((i) => ({ src: i.src, ok: i.complete && i.naturalWidth > 0 })));
    const broken = imgs.filter((i) => !i.ok);
    results.push({ check: 'images', ok: broken.length === 0, detail: broken.length ? `${broken.length} broken` : `${imgs.length} ok` });

    // Basic interactive elements present.
    const buttons = await page.$$eval('button, a.button, input[type=submit]', (els) => els.length);
    results.push({ check: 'interactive elements', ok: true, detail: `${buttons} found` });

    // Responsive smoke test.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
    results.push({ check: 'mobile layout (390px)', ok: !overflow, detail: overflow ? 'horizontal overflow detected' : 'no overflow' });

    if (screenshots) {
      try {
        await page.screenshot({ path: process.env.NULLCODE_SCREENSHOT || 'last-check.png' });
        results.push({ check: 'screenshot', ok: true, detail: process.env.NULLCODE_SCREENSHOT || 'last-check.png' });
      } catch { /* non-fatal */ }
    }
    return { ok: consoleErrors.length === 0 && results.every((r) => r.ok), title, consoleErrors, results };
  } catch (err) {
    const message = String(err.message || err);
    if (/Executable doesn't exist|Failed to launch|browserType\.launch/i.test(message)) {
      return {
        ok: false,
        skipped: true,
        message: 'Chromium for browser testing is not downloaded yet. Run "npm run install:browsers" once to enable it.',
        consoleErrors,
        results,
      };
    }
    return { ok: false, title: null, consoleErrors, results, error: message };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
