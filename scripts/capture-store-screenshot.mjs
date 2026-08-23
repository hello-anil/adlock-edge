import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(root, "assets", "store");
const outputPath = path.join(outputDir, "adlock-popup-640x400.png");
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
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
  const stats = {
    todayHidden: 189,
    totalRedirects: 12,
    totalHidden: 1247,
    redirectSites: {},
    sites: {}
  };
  globalThis.chrome = {
    tabs: {
      query: async () => [{ id: 7, url: "https://news.example.com/article" }],
      sendMessage: async () => ({ pageHidden: 24 }),
      reload: async () => {}
    },
    runtime: {
      sendMessage: async (message) => {
        if (message.type === "popup:getState") return { settings, stats, pageHidden: 24 };
        return { settings };
      },
      openOptionsPage: () => {}
    },
    storage: { onChanged: { addListener: () => {} } }
  };
});

await page.goto(pathToFileURL(path.join(root, "ui", "popup.html")).href);
await page.addStyleTag({
  content: `
    body { width: 640px !important; max-width: none !important; min-height: 400px !important; }
    .shell { width: 430px !important; margin: 0 auto !important; padding-top: 14px !important; }
  `
});
await page.screenshot({ path: outputPath, type: "png" });
await browser.close();
console.log(`Created ${path.relative(root, outputPath)} (640x400).`);
