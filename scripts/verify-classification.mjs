import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const require = createRequire(import.meta.url);
const cli = process.env.PLAYWRIGHT_CLI_PATH || require.resolve("@playwright/cli/playwright-cli.js");
await mkdir(path.join(root, "tmp"), { recursive: true });
const temporary = await mkdtemp(path.join(root, "tmp", "classification-"));
const session = `adlock-classification-${process.pid}-${Date.now()}`;
const fixture = await readFile(path.join(root, "demo/compatibility-fixtures.html"));
const server = createServer((request, response) => {
  if (request.url !== "/fixture") { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end(fixture);
});
const output = path.join(root, `output/benchmarks/classification-${manifest.version}.json`);
await mkdir(path.dirname(output), { recursive: true });
let opened = false;
function invoke(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, `-s=${session}`, ...args], { cwd: root, windowsHide: true, shell: false });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    const timer = setTimeout(() => child.kill(), 90000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || stdout || `CLI exited ${code}`)); });
  });
}
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const fixtureUrl = `http://127.0.0.1:${server.address().port}/fixture`;
  const configPath = path.join(temporary, "config.json");
  await writeFile(configPath, JSON.stringify({ browser: {
    browserName: "chromium", launchOptions: {
      channel: "chromium", executablePath: require("playwright").chromium.executablePath(), headless: true,
      args: [`--load-extension=${root}`, `--disable-extensions-except=${root}`]
    }, contextOptions: { viewport: { width: 1280, height: 900 } }
  } }));
  const callbackPath = path.join(temporary, "fixture.js");
  await writeFile(callbackPath, (await readFile(path.join(root, "scripts/verify-classification-page.js"), "utf8"))
    .replaceAll("__ADLOCK_FIXTURE_CONFIG__", JSON.stringify({ fixtureUrl })));
  await invoke(["open", "about:blank", "--persistent", `--profile=${path.join(temporary, "profile")}`, `--config=${configPath}`]);
  opened = true;
  const result = JSON.parse(await invoke(["run-code", `--filename=${callbackPath}`, "--raw"]));
  result.measuredAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.passed, true, result.failures.join("; "));
} finally {
  try { if (opened) await invoke(["close"]); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}
