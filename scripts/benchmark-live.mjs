import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const sites = [
  { name: "bbc", url: "https://www.bbc.com/news" },
  { name: "cnn", url: "https://edition.cnn.com/" },
  { name: "wikipedia", url: "https://en.wikipedia.org/wiki/Advertising" },
  { name: "mdn", url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript" },
  { name: "amazon", url: "https://www.amazon.com/s?k=headphones" },
  { name: "d3ward", url: "https://d3ward.com/adblock" }
];
const modes = ["disabled", "balanced", "strict"];
const usage = `Live AdLock benchmark using Playwright CLI and the loaded extension.

Usage: node scripts/benchmark-live.mjs [options]
  --runs=N          Repetitions per site and mode (default: 3)
  --site=name       One site or comma-separated names: ${sites.map((site) => site.name).join(", ")}
  --settle-ms=N     Fixed observation window after navigation (default: 3000)
  --output=path     Report path (default: output/benchmarks/live-<timestamp>.json)
  --no-screenshots  Skip first-round screenshots
  --help            Print this usage

PLAYWRIGHT_CLI_PATH can point to playwright-cli.js. The runner otherwise resolves
an installed CLI or uses npx through Node, including on Windows. Each run uses a
new persistent browser profile under tmp/; profiles are retained for inspection.`;

function argumentsFrom(argv) {
  const options = { runs: 3, settleMs: 3000, selectedSites: sites, screenshots: true };
  let selectedNames = [];
  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--no-screenshots") {
      options.screenshots = false;
      continue;
    }
    const match = /^(--runs|--site|--settle-ms|--output)=(.+)$/.exec(argument);
    if (!match) throw new Error(`Unknown option: ${argument}\n${usage}`);
    if (match[1] === "--site") {
      const names = [...new Set(match[2].split(",").map((name) => name.trim().toLowerCase()))];
      for (const name of names) {
        if (!sites.some((site) => site.name === name)) throw new Error(`Unknown site: ${name}`);
      }
      selectedNames = [...new Set([...selectedNames, ...names])];
      options.selectedSites = sites.filter((site) => selectedNames.includes(site.name));
    } else if (match[1] === "--output") {
      options.output = path.resolve(root, match[2]);
    } else {
      const number = Number(match[2]);
      const maximum = match[1] === "--runs" ? 100 : 120000;
      if (!Number.isInteger(number) || number < (match[1] === "--runs" ? 1 : 0) || number > maximum) {
        throw new Error(`Invalid value for ${match[1]}: ${match[2]}`);
      }
      options[match[1] === "--runs" ? "runs" : "settleMs"] = number;
    }
  }
  return options;
}

async function resolveCli() {
  if (process.env.PLAYWRIGHT_CLI_PATH) {
    const cliPath = path.resolve(process.env.PLAYWRIGHT_CLI_PATH);
    if (!existsSync(cliPath)) throw new Error(`PLAYWRIGHT_CLI_PATH does not exist: ${cliPath}`);
    return { args: [cliPath], source: cliPath };
  }
  try {
    const cliPath = require.resolve("@playwright/cli/playwright-cli.js");
    return { args: [cliPath], source: cliPath };
  } catch {}
  try {
    const packagePath = require.resolve("@playwright/cli/package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
    const binary = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.["playwright-cli"];
    const cliPath = binary && path.resolve(path.dirname(packagePath), binary);
    if (cliPath && existsSync(cliPath)) return { args: [cliPath], source: cliPath };
  } catch {}
  const npxCandidates = [
    process.env.npm_execpath?.replace(/npm-cli\.js$/, "npx-cli.js"),
    path.join(path.dirname(process.execPath), "node_modules/npm/bin/npx-cli.js")
  ];
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    npxCandidates.push(path.join(directory, "node_modules/npm/bin/npx-cli.js"));
    if (process.platform !== "win32") {
      const executable = path.join(directory, "npx");
      if (existsSync(executable)) npxCandidates.push(await realpath(executable));
    }
  }
  const npxPath = npxCandidates.find((candidate) => candidate && existsSync(candidate));
  if (!npxPath) throw new Error("Cannot locate Playwright CLI or npx. Set PLAYWRIGHT_CLI_PATH to playwright-cli.js.");
  return {
    args: [npxPath, "--yes", "--package=@playwright/cli@0.1.22", "playwright-cli"],
    source: `npx via ${npxPath}`
  };
}

function run(commandArguments, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, commandArguments, { cwd: root, windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout, stderr });
    });
  });
}

function parseResult(stdout) {
  const trimmed = stdout.trim();
  let result;
  try {
    result = JSON.parse(trimmed);
  } catch {
    // Older CLI versions wrap results in this exact, labelled response format.
    const wrapper = /^### Result\r?\n([\s\S]*?)(?:\r?\n### Ran Playwright code\r?\n[\s\S]*)?$/.exec(trimmed);
    if (!wrapper) throw new Error(`CLI returned a non-JSON result: ${trimmed.slice(0, 800)}`);
    result = JSON.parse(wrapper[1]);
  }
  if (typeof result === "string") result = JSON.parse(result);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Callback must return an object.");
  return result;
}

function exclusionReasons(record) {
  if (record.runnerError) return [record.runnerError];
  const reasons = [];
  const httpStatus = record.httpStatus ?? record.navigation?.status ?? record.statusCode ?? (typeof record.status === "number" ? record.status : null);
  if (typeof httpStatus === "number" && (httpStatus < 200 || httpStatus >= 400)) reasons.push(`HTTP ${httpStatus}`);
  if (httpStatus === null && !record.navigationError) reasons.push("Navigation returned no HTTP status");
  const error = record.navigationError ?? record.navigation?.error ?? record.error;
  if (error) reasons.push(String(error));
  if (record.challenge || record.challengeDetected || record.page?.challenge || record.page?.challengeDetected) reasons.push("Challenge or access interstitial detected");
  if (record.valid === false || record.success === false || record.usable === false) reasons.push("Callback marked measurement unusable");
  if (typeof record.status === "string" && /^(error|failed|blocked|challenge|unavailable)$/i.test(record.status)) reasons.push(`Status: ${record.status}`);
  return [...new Set(reasons)];
}

function numericLeaves(value, prefix = "", output = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, nested] of Object.entries(value)) numericLeaves(nested, prefix ? `${prefix}.${key}` : key, output);
  } else if (typeof value === "number" && Number.isFinite(value)) {
    output[prefix] = value;
  }
  return output;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function metricSummary(values) {
  const result = { value: Number(median(values).toFixed(3)), sampleCount: values.length };
  if (values.length >= 20) {
    const sorted = [...values].sort((left, right) => left - right);
    result.p95 = Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(3));
  }
  return result;
}

async function sourceHashes() {
  const contentFiles = (await readdir(path.join(root, "content"))).filter((file) => /\.(?:js|css)$/.test(file));
  const files = [
    "manifest.json", "data/filter-data.json", "background/service-worker.js",
    "scripts/benchmark-live.mjs", "scripts/benchmark-live-page.js",
    ...contentFiles.map((file) => `content/${file}`)
  ].sort();
  return Object.fromEntries(await Promise.all(files.map(async (file) => [
    file, createHash("sha256").update(await readFile(path.join(root, file))).digest("hex")
  ])));
}

function aggregate(measurements, selectedSites) {
  return selectedSites.flatMap((site) => modes.map((mode) => {
    const records = measurements.filter((record) => record.site.name === site.name && record.mode === mode);
    const usable = records.filter((record) => record.excluded.length === 0);
    const metrics = new Map();
    for (const record of usable) {
      const leafMetrics = numericLeaves(record.metrics ?? Object.fromEntries(Object.entries(record).filter(([key]) =>
        !["site", "mode", "repeat", "httpStatus", "statusCode", "status", "measuredAt", "runnerDurationMs", "excluded"].includes(key))));
      for (const [key, value] of Object.entries(leafMetrics)) {
        if (/(?:^|\.)(?:status|statusCode|httpStatus)$/.test(key)) continue;
        if (!metrics.has(key)) metrics.set(key, []);
        metrics.get(key).push(value);
      }
    }
    return {
      site: site.name,
      mode,
      measuredRuns: records.length,
      includedRuns: usable.length,
      excludedRuns: records.length - usable.length,
      medians: Object.fromEntries([...metrics].map(([key, values]) => [key, metricSummary(values)])),
      exclusions: records.filter((record) => record.excluded.length).map((record) => ({ repeat: record.repeat, reasons: record.excluded }))
    };
  }));
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  if (options.help) { console.log(usage); return; }
  const cli = await resolveCli();
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const template = await readFile(path.join(root, "scripts/benchmark-live-page.js"), "utf8");
  if (!template.includes("__ADLOCK_LIVE_CONFIG__")) throw new Error("Page callback is missing __ADLOCK_LIVE_CONFIG__.");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runId = `${timestamp}-${process.pid}`;
  const session = `adlock-live-${process.pid}-${Date.now()}`;
  const temporary = path.join(root, "tmp", `adlock-live-${runId}`);
  const profile = path.join(temporary, "profile");
  const screenshotDirectory = path.join(root, "output", "playwright", `live-${runId}`);
  const output = options.output || path.join(root, "output", "benchmarks", `live-${runId}.json`);
  const logPath = output.replace(/\.json$/i, "") + ".cli.log";
  await mkdir(temporary, { recursive: true });
  await mkdir(path.dirname(output), { recursive: true });
  if (options.screenshots) await mkdir(screenshotDirectory, { recursive: true });
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || require("playwright").chromium.executablePath();
  if (!existsSync(executablePath)) throw new Error(`Chromium is not installed at ${executablePath}. Install this project's Playwright Chromium first.`);
  const configPath = path.join(temporary, "cli.config.json");
  await writeFile(configPath, JSON.stringify({
    browser: {
      browserName: "chromium",
      launchOptions: {
        channel: "chromium",
        executablePath,
        headless: true,
        args: [`--load-extension=${root}`, `--disable-extensions-except=${root}`]
      },
      contextOptions: { viewport: { width: 1280, height: 900 } }
    }
  }, null, 2));
  const report = {
    metadata: {
      startedAt: new Date().toISOString(),
      hostTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      nodeVersion: process.version,
      platform: `${process.platform} ${os.release()} ${process.arch}`,
      cpuModel: os.cpus()[0]?.model || null,
      logicalCpuCount: os.cpus().length,
      ramBytes: os.totalmem(),
      extensionVersion: manifest.version,
      sourceSha256: await sourceHashes(),
      cliSource: cli.source,
      executablePath,
      profile,
      session,
      viewport: { width: 1280, height: 900 },
      runs: options.runs,
      settleMs: options.settleMs,
      selectedSites: options.selectedSites,
      modeOrder: "Rotate disabled, balanced, strict by repetition",
      cliLog: logPath,
      status: "running"
    },
    measurements: [],
    summary: [],
    limitations: [
      "This measures selected public pages on one machine, browser, region, and observation window; it is not a universal blocking accuracy or speed score.",
      "Site content, consent prompts, connection conditions, and external ad inventories change between navigations.",
      "All modes use one isolated persistent profile. The page callback clears cookies and browser HTTP cache before each navigation; other site storage and server state may vary. Mode order rotates each round.",
      "Medians exclude failed navigations, unsuccessful HTTP statuses, and detected access challenges. Exclusions remain in the raw measurements.",
      "The p95 field is reported only when a metric has at least 20 included samples; the default three repeats support medians only.",
      "blockedRequests are ERR_BLOCKED_BY_CLIENT failures corroborated by a hypothetical installed DNR block, not recorded rule debug events.",
      "Request failures can include non-ad errors. Hidden elements are extension counters, not independently labelled ad ground truth.",
      "Profiles and generated callbacks are retained under tmp/ for review."
    ]
  };
  async function checkpoint() {
    report.summary = aggregate(report.measurements, options.selectedSites);
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  }
  async function invoke(args, timeoutMs) {
    const result = await run([...cli.args, `-s=${session}`, ...args], timeoutMs);
    await appendFile(logPath, `\n[${new Date().toISOString()}] ${JSON.stringify(args)}\n${result.stdout}${result.stderr}\nexit=${result.code} timedOut=${result.timedOut}\n`);
    if (result.code !== 0 || result.timedOut) throw new Error(`CLI ${args[0]} failed: ${result.timedOut ? "timed out" : `exit ${result.code}`}\n${(result.stderr || result.stdout).slice(-1500)}`);
    return result.stdout;
  }
  await checkpoint();
  let opened = false;
  try {
    const version = await run([...cli.args, "--version"], 30000);
    report.metadata.cliVersion = version.stdout.trim() || null;
    console.log(`Launching isolated Chromium with AdLock ${manifest.version}. Report: ${output}`);
    await invoke(["open", "about:blank", "--persistent", `--profile=${profile}`, `--config=${configPath}`], 90000);
    opened = true;
    const total = options.runs * options.selectedSites.length * modes.length;
    for (let repeat = 1; repeat <= options.runs; repeat += 1) {
      const order = modes.map((_, index) => modes[(index + repeat - 1) % modes.length]);
      for (const site of options.selectedSites) {
        for (const mode of order) {
          const measurement = { site, mode, repeat, measuredAt: new Date().toISOString() };
          const callbackConfiguration = {
            site, mode, repeat, settleMs: options.settleMs,
            screenshotPath: options.screenshots && repeat === 1 ? path.join(screenshotDirectory, `${site.name}-${mode}.png`) : null
          };
          const callbackPath = path.join(temporary, `${site.name}-${mode}-${repeat}.js`);
          await writeFile(callbackPath, template.replaceAll("__ADLOCK_LIVE_CONFIG__", JSON.stringify(callbackConfiguration)));
          const startedAt = performance.now();
          console.log(`[${report.measurements.length + 1}/${total}] ${site.name} ${mode} round ${repeat}`);
          try {
            Object.assign(measurement, parseResult(await invoke(["run-code", `--filename=${callbackPath}`, "--raw"], 90000 + options.settleMs)));
            if (measurement.browserVersion && !report.metadata.chromiumVersion) report.metadata.chromiumVersion = measurement.browserVersion;
          } catch (error) {
            measurement.runnerError = error.message;
          }
          measurement.runnerDurationMs = Number((performance.now() - startedAt).toFixed(2));
          measurement.excluded = exclusionReasons(measurement);
          report.measurements.push(measurement);
          await checkpoint();
          console.log(`  ${measurement.excluded.length ? `EXCLUDED: ${measurement.excluded.join("; ")}` : "recorded"} (${measurement.runnerDurationMs} ms)`);
        }
      }
    }
    report.metadata.status = "complete";
    report.metadata.completedAt = new Date().toISOString();
  } catch (error) {
    report.metadata.status = "failed";
    report.metadata.error = error.message;
    report.metadata.completedAt = new Date().toISOString();
    process.exitCode = 1;
    console.error(error.message);
  } finally {
    if (opened) {
      try { await invoke(["close"], 30000); }
      catch (error) { report.metadata.closeError = error.message; }
    }
    await checkpoint();
  }
  const runnerErrors = report.measurements.filter((record) => record.runnerError).length;
  const included = report.measurements.filter((record) => record.excluded.length === 0).length;
  if (runnerErrors || included === 0) process.exitCode = 1;
  console.log(`Saved ${report.measurements.length} measurements (${included} included, ${runnerErrors} runner errors) to ${output}`);
}

await main().catch((error) => { console.error(error.message); process.exitCode = 1; });
