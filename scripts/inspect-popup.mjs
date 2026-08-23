import { chromium } from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const extensionPath = path.resolve(import.meta.dirname, "..");
const profilePath = await mkdtemp(path.join(tmpdir(), "adlock-popup-"));
const chromiumPath = path.join(process.env.LOCALAPPDATA, "ms-playwright", "chromium-1228", "chrome-win64", "chrome.exe");
const context = await chromium.launchPersistentContext(profilePath, {
  executablePath: chromiumPath,
  headless: false,
  viewport: { width: 432, height: 768 },
  args: [
    "--remote-debugging-port=9333",
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`
  ]
});

function cdpCommand(webSocketUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`CDP command timed out: ${method}`));
    }, 5000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      clearTimeout(timeout);
      socket.close();
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    socket.addEventListener("error", reject);
  });
}

try {
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extensionId = new URL(worker.url()).hostname;
  const popupUrl = `chrome-extension://${extensionId}/ui/popup.html`;

  let openResult;
  try {
    openResult = await worker.evaluate(async () => {
      await chrome.action.openPopup();
      return { ok: true };
    });
  } catch (error) {
    openResult = { ok: false, error: String(error) };
  }

  await new Promise((resolve) => setTimeout(resolve, 750));
  const cdpTargets = await fetch("http://127.0.0.1:9333/json/list").then((response) => response.json());
  const popupTarget = cdpTargets.find((target) => target.url === popupUrl);
  let realPopup = null;
  if (popupTarget) {
    const evaluation = await cdpCommand(popupTarget.webSocketDebuggerUrl, "Runtime.evaluate", {
      returnByValue: true,
      expression: `JSON.stringify({
        viewport: { width: innerWidth, height: innerHeight },
        body: {
          width: document.body.getBoundingClientRect().width,
          scrollWidth: document.body.scrollWidth,
          height: document.body.getBoundingClientRect().height,
          scrollHeight: document.body.scrollHeight,
          computedWidth: getComputedStyle(document.body).width,
          minWidth: getComputedStyle(document.body).minWidth
        },
        document: { scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight },
        media: { ultraNarrow: matchMedia("(max-width: 239px)").matches, narrow: matchMedia("(max-width: 339px)").matches }
      })`
    });
    realPopup = JSON.parse(evaluation.result.value);
    if (realPopup.viewport.width < 360) {
      throw new Error(`Real action popup collapsed to ${realPopup.viewport.width}px`);
    }
    if (realPopup.document.scrollWidth - realPopup.viewport.width > 1) {
      throw new Error(`Real action popup overflows horizontally: ${realPopup.document.scrollWidth}px > ${realPopup.viewport.width}px`);
    }
    const screenshot = await cdpCommand(popupTarget.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(extensionPath, "tmp", "real-popup.png"), Buffer.from(screenshot.data, "base64"));
  }
  const pages = context.pages();
  const popup = pages.find((page) => page.url() === popupUrl);
  const targetInfo = await Promise.all(pages.map(async (page) => ({
    url: page.url(),
    viewport: page.viewportSize(),
    body: await page.locator("body").evaluate((body) => ({
      width: body.getBoundingClientRect().width,
      scrollWidth: body.scrollWidth,
      height: body.getBoundingClientRect().height,
      scrollHeight: body.scrollHeight
    })).catch(() => null)
  })));

  console.log(JSON.stringify({
    extensionId,
    popupUrl,
    openResult,
    popupFound: Boolean(popup),
    realPopup,
    cdpTargets: cdpTargets.map(({ id, type, url, title, webSocketDebuggerUrl }) => ({ id, type, url, title, webSocketDebuggerUrl })),
    targets: targetInfo
  }, null, 2));
} finally {
  await context.close();
}
