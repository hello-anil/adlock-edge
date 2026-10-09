import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

// Real toolbar UI and extension APIs, in a disposable browser profile.
const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const extension = process.argv.includes("--packaged") ? path.join(root, "dist", `adlock-${manifest.version}`) : root;
const audit = process.argv.includes("--audit");
const channel = process.argv.includes("--edge") ? "msedge" : "chromium";
const output = process.argv.find(arg => arg.startsWith("--output="))?.slice(9)
  || `output/benchmarks/popup-functionality-${manifest.version}.json`;
let visits = 0;
const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><title>Popup integration</title><script>window.visit=${++visits}</script>
    <h1>Editorial article</h1><input id="draft" value="Keep this draft">
    <article id="ad" data-sponsored="true" style="width:300px;height:90px"><b>Sponsored</b><p>Commercial offer</p></article>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
await mkdir(path.join(root, "tmp"), { recursive: true });
const profile = await mkdtemp(path.join(root, "tmp", "popup-functionality-"));
const report = { version: manifest.version, channel, audit, measuredAt: new Date().toISOString(), checks: [], live: [], timings: [] };
const errors = [];
let context;
let endpoint;
function check(name, passed, details) {
  report.checks.push({ name, passed: Boolean(passed), ...details });
  console.log(`${passed ? "PASS" : "FAIL"}: ${name}`);
}
async function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    const timer = setTimeout(() => { socket.close(); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    const finish = (error, result) => { clearTimeout(timer); socket.close(); error ? reject(error) : resolve(result); };
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.addEventListener("error", () => finish(new Error(`CDP connection failed: ${method}`)));
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.id === 1) finish(message.error ? new Error(message.error.message) : null, message.result);
    });
  });
}
async function evaluate(fn, value) {
  const result = await command("Runtime.evaluate", { awaitPromise: true, returnByValue: true,
    expression: `(${fn.toString()})(${JSON.stringify(value) ?? "undefined"})` });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
try {
  context = await chromium.launchPersistentContext(profile, {
    channel, headless: !process.argv.includes("--headed"), viewport: null,
    args: ["--remote-debugging-port=0", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  context.on("page", page => page.on("pageerror", error => errors.push({ url: page.url(), error: error.message })));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const id = new URL(worker.url()).hostname;
  const control = await context.newPage();
  await control.goto(`chrome-extension://${id}/ui/options.html`);
  await control.waitForFunction(() => document.getElementById("saveButton").textContent === "Saved");
  const port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0];
  async function openPopup(page) {
    await page.bringToFront();
    await worker.evaluate(() => chrome.action.openPopup());
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
    const target = targets.find(t => t.url === `chrome-extension://${id}/ui/popup.html`);
    assert.ok(target, "Actual action popup must exist");
    endpoint = target.webSocketDebuggerUrl;
    return evaluate(async () => {
      const deadline = performance.now() + 8000;
      while (document.body.classList.contains("is-loading") && performance.now() < deadline) await new Promise(r => setTimeout(r, 10));
      if (document.body.classList.contains("is-loading")) throw new Error("Popup startup timed out");
      return { readyMs: performance.getEntriesByName("adlock-popup-ready").at(-1)?.startTime,
        hostname: document.getElementById("hostname").textContent, network: document.getElementById("networkText").textContent,
        width: innerWidth, height: innerHeight };
    });
  }
  async function closePopup() { await evaluate(() => window.close()); }
  if (process.argv.includes("--live")) {
    for (const url of ["https://developer.mozilla.org/en-US/docs/Web/JavaScript", "https://en.wikipedia.org/wiki/Advertising", "https://www.bbc.com/news"]) {
      const page = await context.newPage();
      const item = { url };
      try {
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        item.httpStatus = response?.status();
        item.popup = await openPopup(page);
        item.passed = item.httpStatus === 200 && item.popup.hostname === new URL(url).hostname.replace(/^www\./, "")
          && item.popup.network === "Network filtering active";
        check(`Live popup on ${new URL(url).hostname}`, item.passed, { popup: item.popup, httpStatus: item.httpStatus });
        await closePopup();
      } catch (error) { item.error = String(error); check(`Live popup on ${new URL(url).hostname}`, false, { error: item.error }); }
      report.live.push(item);
      // Keep these real sites open to measure saves with multiple content tabs.
    }
  }
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => getComputedStyle(document.getElementById("ad")).visibility === "hidden");
  await page.waitForTimeout(850); // Content's existing 700ms statistics batch.
  const startup = await openPopup(page);
  report.startup = startup;
  check("Popup initializes on a protected site", startup.hostname === "127.0.0.1" && startup.network === "Network filtering active");
  for (const enabled of [false, true]) {
    await evaluate(() => document.getElementById("globalToggle").focus());
    await command("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
    await command("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
    const saved = await evaluate(async enabled => {
      const deadline = performance.now() + 8000;
      while (document.getElementById("globalToggle").disabled && performance.now() < deadline) await new Promise(r => setTimeout(r, 5));
      const snapshot = await chrome.runtime.sendMessage({ type: "popup:getState" });
      return snapshot.settings.globalEnabled === enabled && snapshot.networkHealth.status === (enabled ? "active" : "paused");
    }, enabled);
    check(`Keyboard ${enabled ? "resume" : "pause"} saves protection`, saved);
    if (!enabled) {
      const pausedLevelSaved = await evaluate(async () => {
        const select = document.getElementById("levelSelect");
        if (select.disabled) return false;
        select.value = "balanced";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        const deadline = performance.now() + 8000;
        while (document.getElementById("globalToggle").disabled && performance.now() < deadline) await new Promise(r => setTimeout(r, 5));
        const snapshot = await chrome.runtime.sendMessage({ type: "popup:getState" });
        return snapshot.settings.level === "balanced" && !snapshot.settings.globalEnabled && snapshot.networkHealth.status === "paused";
      });
      check("Dropdown saves its level while actual protection remains paused", pausedLevelSaved);
    }
  }
  for (let round = 0; round < 3; round++) {
    for (const controlId of ["globalToggle", "globalToggle", "relaxed", "balanced", "strict"]) {
      const timing = await evaluate(async controlId => {
        const global = document.getElementById("globalToggle");
        const started = performance.now();
        if (controlId === "globalToggle") global.click();
        else { const select = document.getElementById("levelSelect"); select.value = controlId; select.dispatchEvent(new Event("change", { bubbles: true })); }
        const feedbackMs = performance.now() - started;
        const immediate = { enabled: global.getAttribute("aria-pressed") === "true", level: document.getElementById("levelSelect").value };
        const deadline = started + 8000;
        while (global.disabled && performance.now() < deadline) await new Promise(r => setTimeout(r, 5));
        if (global.disabled) throw new Error("Protection save timed out");
        const settledMs = performance.now() - started;
        const snapshot = await chrome.runtime.sendMessage({ type: "popup:getState" });
        return { controlId, feedbackMs, settledMs, enabled: snapshot.settings.globalEnabled, level: snapshot.settings.level,
          consistent: immediate.enabled === snapshot.settings.globalEnabled && immediate.level === snapshot.settings.level,
          health: snapshot.networkHealth.status };
      }, controlId);
      report.timings.push(timing);
    }
  }
  check("Global pause/resume and all levels persist with verified network state", report.timings.every(t => t.consistent && ["active", "paused"].includes(t.health)));
  const beforeCount = await evaluate(() => Number(document.getElementById("pageCount").textContent));
  await page.evaluate(() => { const ad = document.createElement("article"); ad.id = "late-ad"; ad.dataset.sponsored = "true";
    ad.style.cssText = "width:300px;height:90px"; ad.innerHTML = "<b>Sponsored</b><p>New commercial offer</p>"; document.body.append(ad); });
  await page.waitForFunction(() => getComputedStyle(document.getElementById("late-ad")).visibility === "hidden");
  // The content scanner batches reports and visible-browser timers can be
  // throttled. Wait for the observable update, rather than guessing a delay.
  await evaluate(async beforeCount => {
    const deadline = performance.now() + 5000;
    while (Number(document.getElementById("pageCount").textContent) <= beforeCount && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }, beforeCount);
  const countState = await evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const snapshot = await chrome.runtime.sendMessage({ type: "popup:getState", tabId: tab.id });
    const content = await chrome.tabs.sendMessage(tab.id, { type: "content:getPageState" });
    return { popup: Number(document.getElementById("pageCount").textContent), background: snapshot.pageHidden, content };
  });
  const pageObservation = await page.evaluate(() => ({ hidden: document.hidden, lateAdVisibility: getComputedStyle(document.getElementById("late-ad")).visibility }));
  check("Page counter updates while popup remains open", countState.popup === countState.background && countState.popup > beforeCount, { beforeCount, ...countState, pageObservation });
  const visit = await page.evaluate(() => window.visit);
  await page.locator("#draft").evaluate(input => { input.value = "Unsaved work"; });
  const paused = await evaluate(async () => {
    const started = performance.now();
    document.getElementById("siteToggle").click();
    const feedbackMs = performance.now() - started;
    const deadline = performance.now() + 8000;
    while (document.getElementById("globalToggle").disabled && performance.now() < deadline) await new Promise(r => setTimeout(r, 5));
    return { checked: document.getElementById("siteToggle").getAttribute("aria-checked"), feedbackMs, settledMs: performance.now() - started };
  });
  await page.waitForFunction(() => getComputedStyle(document.getElementById("ad")).visibility === "visible");
  const afterPause = await page.evaluate(() => ({ visit: window.visit, draft: document.getElementById("draft").value }));
  report.sitePause = paused;
  check("Site pause restores ads without reloading or losing page input", paused.checked === "false" && afterPause.visit === visit && afterPause.draft === "Unsaved work", afterPause);
  await evaluate(async () => { document.getElementById("siteToggle").click();
    while (document.getElementById("globalToggle").disabled) await new Promise(r => setTimeout(r, 5)); });
  await page.waitForFunction(() => getComputedStyle(document.getElementById("ad")).visibility === "hidden");
  check("Site resume restores blocking", true);
  await control.evaluate(() => chrome.runtime.sendMessage({ type: "settings:update", patch: { level: "balanced" } }));
  await page.waitForTimeout(300);
  const externalLevel = await evaluate(() => document.getElementById("levelSelect").value);
  check("Popup follows settings changed elsewhere", externalLevel === "balanced", { externalLevel });
  const screenshot = await command("Page.captureScreenshot", { format: "png" });
  report.screenshot = `output/playwright/popup-functionality-${channel}.png`;
  await mkdir(path.join(root, "output", "playwright"), { recursive: true });
  await writeFile(path.join(root, report.screenshot), Buffer.from(screenshot.data, "base64"));
  await evaluate(() => document.getElementById("optionsButton").click());
  await control.waitForFunction(() => document.visibilityState === "visible");
  check("Settings button opens the options page", true);
  check("Extension UI has no uncaught errors", errors.filter(e => e.url.startsWith(`chrome-extension://${id}/`)).length === 0, { errors });
  const summary = key => { const values = report.timings.map(t => t[key]).sort((a, b) => a - b);
    return { medianMs: Number(values[Math.floor(values.length / 2)].toFixed(2)), p95Ms: Number(values[Math.ceil(values.length * .95) - 1].toFixed(2)) }; };
  report.response = { feedback: summary("feedbackMs"), saved: summary("settledMs") };
  report.completed = true;
  report.passed = report.checks.every(c => c.passed);
  console.log(JSON.stringify({ startup, response: report.response }, null, 2));
  if (!audit) assert.ok(report.passed, "All popup functionality checks must pass");
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  await mkdir(path.dirname(path.resolve(root, output)), { recursive: true });
  await writeFile(path.resolve(root, output), JSON.stringify(report, null, 2));
  await context?.close();
  await new Promise(resolve => server.close(resolve));
}
