import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const { version } = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const standalone = process.argv.includes("--standalone");
const partialChrome = process.argv.includes("--partial-chrome");
const previewFile = standalone ? path.join(root, "dist", `adlock-preview-${version}.html`)
  : process.argv.includes("--packaged") ? path.join(root, "dist", `adlock-${version}`, "ui", "popup.html")
  : path.join(root, "ui", "popup.html");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 260, height: 320 } });
const page = await context.newPage();
if (partialChrome) await page.addInitScript(() => {
  globalThis.chrome = { runtime: { id: "preview-host" },
    storage: { onChanged: { addListener() { throw new Error("Preview must not call the host's Chrome APIs"); } } } };
});
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
  const requests = [];
  page.on("request", request => requests.push(request.url()));
  await page.goto(pathToFileURL(previewFile).href);
  await page.waitForFunction(() => !document.body.classList.contains("is-loading"));
  assert.equal(await page.locator("#networkText").textContent(), "Demo data · No blocking");
  assert.equal(await page.locator("#globalToggle").isEnabled(), true);
  assert.equal(await page.locator("#siteToggle").isEnabled(), true);
  await page.locator("#siteToggle").click();
  await page.waitForFunction(() => document.getElementById("siteToggle").getAttribute("aria-checked") === "false");
  await page.reload();
  await page.waitForFunction(() => !document.body.classList.contains("is-loading"));
  assert.equal(await page.locator("#siteToggle").getAttribute("aria-checked"), "false");
  await page.locator("#siteToggle").click();
  await page.locator("#globalToggle").click();
  await page.waitForFunction(() => document.getElementById("globalToggle").getAttribute("aria-pressed") === "false");
  assert.equal(await page.locator("#pageCount").textContent(), "OFF");
  await page.locator("#levelSelect").click();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("levelSelect").value === "balanced" && !document.getElementById("globalToggle").disabled);
  await page.reload();
  await page.waitForFunction(() => !document.body.classList.contains("is-loading"));
  assert.equal(await page.locator("#levelSelect").inputValue(), "balanced");
  assert.equal(await page.locator("#statusText").textContent(), "Preview · Paused");
  assert.equal(await page.locator("#networkText").textContent(), "Demo data · No blocking");
  await page.locator("#optionsButton").click();
  assert.equal(await page.locator("#previewDialog").isVisible(), true);
  await page.locator("#previewClose").click();
  assert.equal(await page.locator("#previewDialog").isVisible(), false);
  await page.locator("#optionsButton").click();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#previewDialog").isVisible(), false);
  await page.locator("#optionsButton").click();
  await page.locator("#previewReset").click();
  assert.equal(await page.locator("#globalToggle").getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#pageCount").textContent(), "7");
  assert.equal(await page.locator("#siteToggle").getAttribute("aria-checked"), "true");
  assert.equal(await page.locator("#levelSelect").inputValue(), "strict");
  assert.equal(await page.locator("#previewDialog").isVisible(), false);
  const overflow = await page.evaluate(() => ({ horizontal: document.documentElement.scrollWidth - innerWidth,
    vertical: document.documentElement.scrollHeight - innerHeight, bodyWidth: document.body.getBoundingClientRect().width }));
  assert.ok(overflow.horizontal <= 0 && overflow.vertical <= 0);
  assert.equal(overflow.bodyWidth, 260);
  assert.deepEqual(errors, []);
  if (standalone) assert.equal(new Set(requests.filter(url => !url.startsWith("data:"))).size, 1, "Standalone preview cannot depend on external files");
  await mkdir(path.join(root, "output", "playwright"), { recursive: true });
  await page.locator(".shell").screenshot({ path: path.join(root, "output", "playwright", standalone ? "popup-standalone-preview.png" : "popup-interactive-preview.png") });
  await mkdir(path.join(root, "output", "benchmarks"), { recursive: true });
  await writeFile(path.join(root, "output", "benchmarks", `popup-preview-${standalone ? "standalone" : "folder"}-${partialChrome ? "partial-chrome" : "normal"}-${version}.json`), JSON.stringify({
    verifiedAt: new Date().toISOString(), passed: true, errors, overflow, standalone, partialChrome, previewFile,
    checks: ["No extension APIs required", "Site pause and persistence", "Global pause and persistence",
      "Dropdown selection while paused", "Settings dialog", "Close button", "Escape key", "Reset demo", "No overflow or page errors"]
  }, null, 2));
  console.log("Standalone preview passed: real clicks, dropdown, persistence, Settings, close, Escape, reset and layout.");
} finally { await browser.close(); }
