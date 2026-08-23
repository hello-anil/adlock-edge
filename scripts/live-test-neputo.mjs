import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const target = 'https://nepu.to/movie/your-name-2016-2016-224135';
const extensionPath = resolve('.');
const profile = await mkdtemp(join(tmpdir(), 'adlock-live-'));
const failures = [];
const popups = [];

const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome',
  headless: true,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
});

try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  const page = context.pages()[0] ?? await context.newPage();
  page.on('requestfailed', request => failures.push({
    url: request.url(),
    type: request.resourceType(),
    error: request.failure()?.errorText,
  }));
  context.on('page', popup => {
    if (popup !== page) popups.push(popup.url());
  });

  const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(12000);
  const visible = await page.locator('body').evaluate(body => ({
    title: document.title,
    text: body.innerText.slice(0, 1500),
    iframes: [...document.querySelectorAll('iframe')].map(x => x.src),
    images: document.images.length,
    links: document.links.length,
    adLike: [...document.querySelectorAll('[class*="ad" i], [id*="ad" i], iframe')]
      .filter(el => {
        const style = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 1 && box.height > 1;
      }).length,
  }));
  const storage = await worker.evaluate(() => chrome.storage.local.get(null));
  await page.screenshot({ path: 'tmp/neputo-adlock-live.png', fullPage: true });
  console.log(JSON.stringify({
    target,
    status: response?.status(),
    finalUrl: page.url(),
    extensionId,
    visible,
    blockedOrFailed: failures,
    popupCount: popups.length,
    popups,
    storage,
  }, null, 2));
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
