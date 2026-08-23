import { chromium } from "@playwright/test";
import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const popupUrl = pathToFileURL(path.join(root, "ui/popup.html")).href;
const optionsUrl = pathToFileURL(path.join(root, "ui/options.html")).href;
const assertBudgets = process.argv.includes("--assert");

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] || 0;
}

function summary(values) {
  return {
    medianMs: Number(percentile(values, 0.5).toFixed(2)),
    p95Ms: Number(percentile(values, 0.95).toFixed(2))
  };
}

function check(condition, message, failures) {
  if (!condition) failures.push(message);
}

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const context = await browser.newContext();
await context.addInitScript(() => {
  const settings = {
    globalEnabled: true,
    level: "strict",
    disabledSites: [],
    customBlockDomains: [],
    customSelectors: [],
    showPlaceholders: false,
    redirectProtection: true,
    antiAdblockCompatibility: true,
    dynamicFiltering: true,
    cleanTrackingParameters: true,
    privacyApiProtection: true,
    fingerprintProtection: true
  };
  const stats = { todayHidden: 421, totalRedirects: 18, totalHidden: 12842 };
  globalThis.__benchmarkMessages = [];
  globalThis.chrome = {
    tabs: {
      query: async () => [{ id: 7, url: "https://example.com/article" }],
      sendMessage: async () => ({ pageHidden: 14 }),
      reload: () => {}
    },
    runtime: {
      sendMessage: async (message) => {
        globalThis.__benchmarkMessages.push(message.type);
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (message.type === "popup:getState") return { settings: { ...settings }, stats: { ...stats }, pageHidden: 14 };
        if (message.type === "settings:update") {
          Object.assign(settings, message.patch);
          return { settings: { ...settings } };
        }
        if (message.type === "site:setEnabled") return { settings: { ...settings } };
        return { ok: true };
      },
      openOptionsPage: () => {}
    },
    storage: { onChanged: { addListener: () => {}, removeListener: () => {} } }
  };
});

try {
  const startupRuns = [];
  for (let index = 0; index < 12; index += 1) {
    const page = await context.newPage();
    const startedAt = performance.now();
    await page.goto(popupUrl, { waitUntil: "load" });
    await page.locator("body:not(.is-loading)").waitFor({ timeout: 2000 }).catch(() => {});
    const readyMark = await page.evaluate(() => performance.getEntriesByName("adlock-popup-ready").at(-1)?.startTime || 0);
    startupRuns.push(readyMark || (performance.now() - startedAt));
    await page.close();
  }

  const popup = await context.newPage();
  await popup.goto(popupUrl, { waitUntil: "load" });
  await popup.locator("#statusText").waitFor();
  await popup.waitForTimeout(60);
  await popup.evaluate(() => { globalThis.__benchmarkMessages.length = 0; });
  const interactionMs = await popup.evaluate(async () => {
    const button = document.getElementById("globalToggle");
    const previous = button.getAttribute("aria-pressed");
    const startedAt = performance.now();
    button.click();
    while (button.getAttribute("aria-pressed") === previous) {
      await new Promise(requestAnimationFrame);
    }
    return performance.now() - startedAt;
  });
  await popup.waitForTimeout(80);
  const messageCount = await popup.evaluate(() => globalThis.__benchmarkMessages.length);

  const layoutChecks = [];
  for (const viewport of [
    { width: 240, height: 420 },
    { width: 320, height: 480 },
    { width: 368, height: 512 },
    { width: 430, height: 700 }
  ]) {
    await popup.setViewportSize(viewport);
    layoutChecks.push(await popup.evaluate(() => ({
      viewport: `${innerWidth}x${innerHeight}`,
      horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      verticalOverflowPx: Math.max(0, document.documentElement.scrollHeight - innerHeight)
    })));
  }
  await popup.close();

  const options = await context.newPage();
  await options.setViewportSize({ width: 360, height: 740 });
  await options.goto(optionsUrl, { waitUntil: "load" });
  const optionsLayout = await options.evaluate(() => ({
    horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    contentVisibilityPanels: [...document.querySelectorAll(".panel")]
      .filter((panel) => getComputedStyle(panel).contentVisibility === "auto").length
  }));
  await options.close();

  const enginePage = await context.newPage();
  await enginePage.goto("about:blank");
  await enginePage.addScriptTag({ path: path.join(root, "content/domain-data.js") });
  await enginePage.addScriptTag({ path: path.join(root, "content/engine.js") });
  const classifierRuns = await enginePage.evaluate(() => {
    const host = document.createElement("main");
    document.body.append(host);
    for (let index = 0; index < 350; index += 1) {
      const candidate = document.createElement("div");
      candidate.className = index % 3 === 0 ? "article-card sponsored-content" : "article-card";
      candidate.dataset.sponsored = index % 3 === 0 ? "true" : "";
      candidate.textContent = index % 3 === 0 ? "Sponsored Product" : `Editorial story ${index}`;
      host.append(candidate);
    }
    const candidates = [...host.children];
    const runs = [];
    for (let run = 0; run < 20; run += 1) {
      const startedAt = performance.now();
      for (const candidate of candidates) globalThis.AdaptiveAdEngine.classify(candidate, "strict");
      runs.push(performance.now() - startedAt);
    }
    host.remove();
    return runs;
  });
  await enginePage.close();

  const payloadFiles = [
    "ui/popup.html", "ui/popup.css", "ui/popup.js",
    "ui/options.html", "ui/options.css", "ui/options.js",
    "content/domain-data.js", "content/engine.js", "content/content.js"
  ];
  const payloadEntries = await Promise.all(payloadFiles.map(async (file) => ({ file, bytes: (await stat(path.join(root, file))).size })));
  const report = {
    popupStartup: summary(startupRuns),
    optimisticToggleMs: Number(interactionMs.toFixed(2)),
    toggleRuntimeMessages: messageCount,
    classifier350Elements: summary(classifierRuns),
    layouts: layoutChecks,
    optionsMobile: optionsLayout,
    payloadBytes: Object.fromEntries(payloadEntries.map(({ file, bytes }) => [file, bytes])),
    measuredAt: new Date().toISOString()
  };
  console.log(JSON.stringify(report, null, 2));

  if (assertBudgets) {
    const failures = [];
    check(report.popupStartup.medianMs < 350, `Popup ready mark median ${report.popupStartup.medianMs}ms exceeds 350ms`, failures);
    check(report.optimisticToggleMs < 50, `Toggle feedback ${report.optimisticToggleMs}ms exceeds 50ms`, failures);
    check(report.toggleRuntimeMessages === 1, `Toggle sent ${report.toggleRuntimeMessages} runtime messages instead of 1`, failures);
    check(report.classifier350Elements.p95Ms < 75, `Classifier throughput p95 ${report.classifier350Elements.p95Ms}ms exceeds 75ms`, failures);
    check(report.layouts.every((item) => item.horizontalOverflowPx === 0), "Popup overflows horizontally", failures);
    check(report.optionsMobile.horizontalOverflowPx === 0, "Options page overflows horizontally", failures);
    if (failures.length) {
      console.error(`Performance budget failed (${failures.length}):\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
      process.exitCode = 1;
    }
  }
} finally {
  await browser.close();
}
