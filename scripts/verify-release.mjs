import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";

// Exercise the staged release with real extension APIs in a disposable profile.
const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const extensionPath = path.join(root, "dist", `adlock-${manifest.version}`);
await mkdir(path.join(root, "tmp"), { recursive: true });
const profile = await mkdtemp(path.join(root, "tmp", "release-browser-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: true,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const id = new URL(worker.url()).hostname;
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`chrome-extension://${id}/ui/options.html`);
  await page.waitForFunction(() => document.getElementById("saveButton").textContent === "Saved");
  const initial = await page.evaluate(() => chrome.runtime.sendMessage({ type: "popup:getState" }));
  assert.equal(initial.networkHealth.status, "active");
  assert.equal(initial.settings.dynamicFiltering, false);
  const backup = { version: 1, settings: { ...initial.settings, level: "balanced",
    disabledSites: ["example.org"], customSelectors: [":is(.advertisement, .sponsored)"] } };
  await page.locator("#importFile").setInputFiles({ name: "backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) });
  await page.waitForFunction(() => document.getElementById("saveButton").textContent === "Save imported settings");
  assert.equal((await page.evaluate(() => chrome.storage.local.get("settings"))).settings.level, "strict");
  await page.locator("#saveButton").click();
  await page.waitForFunction(() => document.getElementById("saveButton").textContent === "Saved");
  const saved = await page.evaluate(() => chrome.runtime.sendMessage({ type: "popup:getState" }));
  assert.equal(saved.settings.level, "balanced");
  assert.deepEqual(saved.settings.customSelectors, backup.settings.customSelectors);
  assert.equal(saved.networkHealth.status, "active");
  await page.locator("#diagnosticsButton").click();
  await page.waitForFunction(() => document.getElementById("diagnosticsOutput").value.includes("extensionVersion"));
  const diagnostics = await page.locator("#diagnosticsOutput").inputValue();
  assert.equal(JSON.parse(diagnostics).extensionVersion, manifest.version);
  assert.equal(diagnostics.includes("example.org"), false);
  assert.equal(diagnostics.includes("advertisement"), false);
  await page.locator("#importFile").setInputFiles({ name: "bad.json", mimeType: "application/json", buffer: Buffer.from('{"version":1,"settings":{"globalEnabled":"false"}}') });
  await page.waitForFunction(() => document.getElementById("saveStatus").textContent.includes("Invalid setting"));
  assert.equal((await page.evaluate(() => chrome.storage.local.get("settings"))).settings.globalEnabled, true);
  await page.setViewportSize({ width: 360, height: 740 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.goto(`chrome-extension://${id}/ui/popup.html`);
  await page.waitForFunction(() => !document.body.classList.contains("is-loading"));
  assert.equal(await page.locator("#networkText").textContent(), "Network filtering active");
  await page.locator("#globalToggle").click();
  await page.waitForFunction(() => document.getElementById("networkText").textContent === "Network filtering paused");
  assert.equal((await page.evaluate(() => chrome.runtime.sendMessage({ type: "popup:getState" }))).networkHealth.status, "paused");
  assert.deepEqual(errors, []);
  console.log(`Verified staged ${manifest.version}: real DNR state, reviewed backup save, compound CSS, invalid import, private diagnostics, narrow layout and global pause.`);
} finally {
  await context.close();
}
