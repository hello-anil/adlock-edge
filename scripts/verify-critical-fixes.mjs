import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const extension = process.argv.includes('--packaged') ? path.join(root, 'dist', `adlock-${manifest.version}`) : root;
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url.startsWith('/destination')) { res.end('<!doctype html><title>Destination</title><h1>Documentation</h1>'); return; }
  res.end(`<!doctype html><html ${req.url.includes('preseed') ? 'data-aas-config-channel="sitechosen"' : ''}><head><title>Regression fixture</title></head><body>
    <button id="go">Open documentation</button><iframe name="ResultFrame"></iframe>
    <p><b id="lead">Advertising</b> is a form of communication.</p>
    <ul><li id="book"><i>Advertising: a cultural economy</i> (2004)</li></ul>
    <div class="vector-header-container vector-sticky-header-container" id="header"><span><b>Advertising</b></span><nav>Search</nav></div>
    <article data-sponsored="true" id="real-ad"><b>Sponsored</b><span>Commercial product</span></article>
    <form id="form" method="get"><button id="submit">Continue</button></form>
    </body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const destination = `http://localhost:${server.address().port}/destination`;
await mkdir(path.join(root, 'tmp'), { recursive: true });
const profile = await mkdtemp(path.join(root, 'tmp', 'critical-regressions-'));
let context;
const checks = [];
try {
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const control = await context.newPage();
  await control.goto(`chrome-extension://${new URL(worker.url()).hostname}/ui/options.html`);
  async function configure(mode) {
    const result = await control.evaluate(mode => chrome.runtime.sendMessage({ type: 'settings:update', patch: {
      globalEnabled: mode !== 'disabled', level: mode === 'disabled' ? 'balanced' : mode, disabledSites: []
    } }), mode);
    assert.equal(result.error, undefined);
    assert.equal(result.networkHealth.status, mode === 'disabled' ? 'paused' : 'active');
  }
  async function fixture(kind = 'normal') {
    const page = await context.newPage();
    await page.goto(`${origin}/${kind}`);
    await page.waitForTimeout(600);
    return page;
  }
  for (const mode of ['disabled', 'balanced', 'strict']) {
    await configure(mode);
    for (const target of ['_self', 'ResultFrame']) {
      const page = await fixture();
      await page.evaluate(({ target, destination }) => {
        document.getElementById('go').onclick = () => window.open(destination, target);
      }, { target, destination });
      await page.locator('#go').click();
      if (target === '_self') await page.waitForURL(destination);
      else await page.frame({ name: 'ResultFrame' }).waitForURL(destination);
      checks.push({ check: 'ordinary navigation', mode, target, passed: true });
      await page.close();
    }
    const page = await fixture();
    await page.evaluate(destination => {
      const form = document.getElementById('form'); form.action = destination;
      document.getElementById('submit').onclick = event => { event.preventDefault(); HTMLFormElement.prototype.submit.call(form); };
    }, destination);
    await page.locator('#submit').click();
    await page.waitForURL(url => url.hostname === 'localhost' && url.pathname === '/destination');
    checks.push({ check: 'external form defaults to same tab', mode, passed: true });
    await page.close();
  }
  await configure('strict');
  for (const kind of ['normal', 'preseed']) {
    const page = await fixture(kind);
    const result = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 16;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = 'rgb(128,128,128)'; ctx.fillRect(0, 0, 64, 16);
      const sum = () => ctx.getImageData(0, 0, 64, 16).data.reduce((total, value) => total + value, 0);
      const before = sum();
      const lookup = { mode: 'lookup', candidate: CanvasRenderingContext2D.prototype.getImageData, native: null };
      document.dispatchEvent(new CustomEvent('aas:config:sitechosen:native', { detail: lookup }));
      document.dispatchEvent(new CustomEvent('aas:config:sitechosen', { detail: {
        enabled: false, redirectProtection: false, level: 'relaxed', fingerprintProtection: false, privacyApiProtection: false
      } }));
      return { before, after: sum(), expected: (128 * 3 + 255) * 64 * 16, exposed: typeof lookup.native === 'function' };
    });
    assert.notEqual(result.before, result.expected, 'Strict canvas protection must be active');
    assert.equal(result.after, result.before, 'forged configuration must not disable protection');
    assert.equal(result.exposed, false, 'page-chosen channel must not expose a native function');
    checks.push({ check: 'forged channel', kind, passed: true, ...result });
    const visibility = await page.evaluate(() => Object.fromEntries(['lead', 'book', 'header', 'real-ad'].map(id => [id, getComputedStyle(document.getElementById(id)).visibility])));
    for (const id of ['lead', 'book', 'header']) assert.equal(visibility[id], 'visible', id);
    assert.equal(visibility['real-ad'], 'hidden');
    checks.push({ check: 'editorial preserved and real ad hidden', kind, passed: true, visibility });
    const blocked = await page.evaluate(() => window.open('https://doubleclick.net/offer', '_self') === null);
    assert.equal(blocked, true, 'known advertising destinations must still be blocked');
    await page.close();
  }
  console.log(`Verified ${checks.length} critical regression checks against AdLock ${manifest.version}.`);
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
}
await mkdir(path.join(root, 'output', 'benchmarks'), { recursive: true });
await writeFile(path.join(root, 'output', 'benchmarks', `critical-regressions-${manifest.version}.json`), JSON.stringify({ version: manifest.version, packaged: process.argv.includes('--packaged'), completedAt: new Date().toISOString(), checks }, null, 2));
