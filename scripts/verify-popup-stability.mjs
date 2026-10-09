import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const extensionPath = process.argv.includes("--packaged") ? path.join(root, "dist", `adlock-${manifest.version}`) : root;
const channel = process.argv.includes("--edge") ? "msedge" : "chromium";
const scale = Number(process.argv.find((arg) => arg.startsWith("--scale="))?.split("=")[1] || 1);
if (typeof WebSocket === "undefined") throw new Error("Popup verification requires Node.js 22+ for the built-in WebSocket client.");
await mkdir(path.join(root, "tmp"), { recursive: true });
const profile = await mkdtemp(path.join(root, "tmp", "popup-stability-"));
const context = await chromium.launchPersistentContext(profile, {
  channel, headless: true, viewport: null,
  args: ["--remote-debugging-port=0", `--screen-info={1920x1080 devicePixelRatio=${scale}}`, "--window-size=1240,900", `--force-device-scale-factor=${scale}`,
    `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
});

async function command(endpoint, method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    const timer = setTimeout(() => { socket.close(); reject(new Error(`Timed out: ${method}`)); }, 10000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      clearTimeout(timer); socket.close();
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
    });
    socket.addEventListener("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const id = new URL(worker.url()).hostname;
  await worker.evaluate(() => chrome.action.openPopup());
  const port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0];
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const popup = targets.find((target) => target.url === `chrome-extension://${id}/ui/popup.html`);
  assert.ok(popup, "The real toolbar popup must open");
  const measured = await command(popup.webSocketDebuggerUrl, "Runtime.evaluate", {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      const snapshots = [];
      for (let frame = 0; frame < 120; frame++) {
        await new Promise(requestAnimationFrame);
        const body = document.body.getBoundingClientRect();
        const controls = document.querySelector('.controls').getBoundingClientRect();
        snapshots.push({ width: innerWidth, height: innerHeight, bodyWidth: body.width, deviceScaleFactor: devicePixelRatio,
          bodyHeight: body.height, controlsX: controls.x, controlsY: controls.y,
          overflowX: document.documentElement.scrollWidth - innerWidth,
          overflowY: document.documentElement.scrollHeight - innerHeight });
      }
      return snapshots;
    })()`
  });
  if (measured.exceptionDetails) throw new Error(JSON.stringify(measured.exceptionDetails));
  const frames = measured.result.value;
  const sizes = [...new Set(frames.map((frame) => `${frame.width}x${frame.height}`))];
  console.log(JSON.stringify({ channel, scale, sizes, first: frames[0], last: frames.at(-1) }, null, 2));
  await mkdir(path.join(root, "output", "playwright"), { recursive: true });
  const screenshot = await command(popup.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(root, "output", "playwright", `popup-${channel}-${scale}.png`), Buffer.from(screenshot.data, "base64"));
  const settled = frames.slice(20);
  assert.equal(new Set(settled.map((frame) => `${frame.width}:${frame.height}:${frame.controlsX}:${frame.controlsY}`)).size, 1,
    "Toolbar popup and controls must stop resizing and moving");
  assert.ok(settled.every((frame) => Math.abs(frame.width - 260) <= 1 && Math.abs(frame.bodyWidth - 260) <= 1),
    "Toolbar popup must retain its intended 260px width");
  assert.ok(settled.every((frame) => frame.overflowX <= 1 && frame.overflowY <= 1), "Toolbar popup must not clip or overflow");
  const interactions = await command(popup.webSocketDebuggerUrl, "Runtime.evaluate", {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      const snapshots = [];
      async function record() {
        for (let i = 0; i < 10; i++) await new Promise(requestAnimationFrame);
        const controls = document.querySelector('.controls').getBoundingClientRect();
        snapshots.push([innerWidth, innerHeight, controls.x, controls.y]);
      }
      async function waitForSave() {
        while (document.querySelector('#globalToggle').disabled) await new Promise(requestAnimationFrame);
      }
      await record();
      for (let toggle = 0; toggle < 2; toggle++) {
        document.querySelector('#globalToggle').click();
        await record();
        await waitForSave();
        await record();
      }
      for (const level of ['relaxed', 'balanced', 'strict']) {
        const select = document.querySelector('#levelSelect');
        select.value = level;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await waitForSave();
        await record();
      }
      const { stats } = await chrome.storage.local.get('stats');
      await chrome.storage.local.set({ stats: { ...stats, totalHidden: 12345678, todayHidden: 98765, totalRedirects: 43210 } });
      await record();
      return snapshots;
    })()`
  });
  if (interactions.exceptionDetails) throw new Error(JSON.stringify(interactions.exceptionDetails));
  assert.equal(new Set(interactions.result.value.map((state) => JSON.stringify(state))).size, 1,
    `Pause, resume, mode changes and counter updates must not move the popup controls: ${JSON.stringify(interactions.result.value)}`);
  console.log("Actual toolbar popup remained stable across 100 settled animation frames.");
  console.log("Popup size and control positions stayed unchanged through pause, resume, all modes and counter updates.");
} finally { await context.close(); }
