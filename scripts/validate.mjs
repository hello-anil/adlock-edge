import { readFile, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const readJson = async (relativePath) => JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
const execFileAsync = promisify(execFile);
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

const manifest = await readJson("manifest.json");
const packageJson = await readJson("package.json");
check(manifest.manifest_version === 3, "manifest.json must use Manifest V3");
check(manifest.version === packageJson.version, "manifest.json and package.json versions must match");
check(manifest.background?.service_worker, "A background service worker is required");
check(Array.isArray(manifest.declarative_net_request?.rule_resources), "DNR rule resources are required");
check(!manifest.permissions?.includes("webRequestBlocking"), "MV2 webRequestBlocking permission is forbidden");

const requiredArchitectureFiles = [
  "data/filter-data.json",
  "scripts/generate-filter-data.mjs",
  "content/domain-data.js",
  "content/privacy-guard.js",
  "content/protection.css",
  "content/strict.css",
  "rules/generated-always.json",
  "rules/generated-strict.json",
  "rules/generated-redirects.json",
  "rules/privacy-navigation.json"
];

for (const relativePath of requiredArchitectureFiles) {
  try {
    await access(path.join(root, relativePath));
  } catch (_error) {
    failures.push(`Missing strict-architecture resource: ${relativePath}`);
  }
}

try {
  await execFileAsync(process.execPath, [path.join(root, "scripts/generate-filter-data.mjs"), "--check"], {
    cwd: root,
    windowsHide: true
  });
} catch (error) {
  const detail = String(error.stderr || error.stdout || error.message).trim();
  failures.push(`Generated filter artifacts must deterministically match data/filter-data.json${detail ? `: ${detail}` : ""}`);
}

const contentScripts = manifest.content_scripts || [];
check(contentScripts.length > 0, "At least one content-script declaration is required");
for (const script of contentScripts) {
  check(script.all_frames === true, `Content-script world ${script.world || "ISOLATED"} must enable all_frames`);
  check(script.match_origin_as_fallback === true, `Content-script world ${script.world || "ISOLATED"} must enable match_origin_as_fallback`);
}

function checkSharedDataPrecedes(scriptName) {
  const declaration = contentScripts.find((script) => (script.js || []).includes(scriptName));
  check(Boolean(declaration), `${scriptName} must be declared as a content script`);
  if (!declaration) return;
  const scripts = declaration.js || [];
  check(scripts.includes("content/domain-data.js"), `${scriptName} must load with content/domain-data.js`);
  check(scripts.indexOf("content/domain-data.js") < scripts.indexOf(scriptName), `content/domain-data.js must precede ${scriptName}`);
}

checkSharedDataPrecedes("content/navigation-guard.js");
checkSharedDataPrecedes("content/privacy-guard.js");
checkSharedDataPrecedes("content/engine.js");

const requiredRulesets = new Map([
  ["generated_ads", { path: "rules/generated-always.json", enabled: true }],
  ["generated_strict", { path: "rules/generated-strict.json", enabled: false }],
  ["generated_redirects", { path: "rules/generated-redirects.json", enabled: true }],
  ["privacy_navigation", { path: "rules/privacy-navigation.json", enabled: false }]
]);
const ruleResources = manifest.declarative_net_request?.rule_resources || [];
const ruleResourcesById = new Map(ruleResources.map((resource) => [resource.id, resource]));

for (const [id, expected] of requiredRulesets) {
  const resource = ruleResourcesById.get(id);
  check(Boolean(resource), `Required generated ruleset id is missing: ${id}`);
  if (!resource) continue;
  check(resource.path === expected.path, `${id} must reference ${expected.path}`);
  check(resource.enabled === expected.enabled, `${id} must be ${expected.enabled ? "enabled" : "disabled"} by default`);
}

for (const strictId of ["privacy_strict", "generated_strict", "privacy_navigation"]) {
  const resource = ruleResourcesById.get(strictId);
  check(Boolean(resource), `Strict ruleset id is missing: ${strictId}`);
  if (resource) check(resource.enabled === false, `${strictId} must not be enabled outside Strict mode`);
}

const referencedFiles = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.options_page,
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  ...contentScripts.flatMap((script) => [...(script.js || []), ...(script.css || [])]),
  ...(manifest.web_accessible_resources || []).flatMap((entry) => entry.resources || []),
  ...ruleResources.map((resource) => resource.path)
].filter(Boolean);

for (const [size, relativePath] of Object.entries(manifest.icons || {})) {
  try {
    const png = await readFile(path.join(root, relativePath));
    const validSignature = png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const width = validSignature && png.length >= 24 ? png.readUInt32BE(16) : 0;
    const height = validSignature && png.length >= 24 ? png.readUInt32BE(20) : 0;
    check(validSignature, `${relativePath} must be a PNG file`);
    check(width === Number(size) && height === Number(size), `${relativePath} must be ${size}x${size}`);
  } catch (_error) {
    failures.push(`Unable to inspect extension icon: ${relativePath}`);
  }
}

for (const relativePath of referencedFiles) {
  try {
    await access(path.join(root, relativePath));
  } catch (_error) {
    failures.push(`Missing manifest resource: ${relativePath}`);
  }
}

const resourceTypes = new Set([
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object",
  "xmlhttprequest", "ping", "csp_report", "media", "webtransport", "websocket",
  "webbundle", "other"
]);
const ruleIds = new Set();
const rulesByResourceId = new Map();

for (const resource of ruleResources) {
  const rules = await readJson(resource.path);
  rulesByResourceId.set(resource.id, rules);
  check(Array.isArray(rules) && rules.length > 0, `${resource.path} must contain rules`);
  let rulesetRegexCount = 0;
  for (const rule of rules) {
    check(Number.isInteger(rule.id) && rule.id > 0, `${resource.path} contains an invalid rule id`);
    check(!ruleIds.has(rule.id), `Duplicate static rule id: ${rule.id}`);
    ruleIds.add(rule.id);
    check(["block", "allow", "allowAllRequests", "upgradeScheme", "redirect", "modifyHeaders"].includes(rule.action?.type), `Rule ${rule.id} has an invalid action`);
    check(Boolean(rule.condition), `Rule ${rule.id} has no condition`);
    for (const type of rule.condition?.resourceTypes || []) {
      check(resourceTypes.has(type), `Rule ${rule.id} uses unknown resource type: ${type}`);
    }
    if (rule.condition?.regexFilter) {
      rulesetRegexCount += 1;
      try {
        new RegExp(rule.condition.regexFilter, rule.condition.isUrlFilterCaseSensitive === false ? "i" : "");
      } catch (error) {
        failures.push(`Rule ${rule.id} has an invalid regexFilter: ${error.message}`);
      }
    }
    if (rule.action?.type === "redirect" && rule.action.redirect?.extensionPath) {
      try {
        await access(path.join(root, rule.action.redirect.extensionPath.replace(/^\//, "")));
      } catch (_error) {
        failures.push(`Rule ${rule.id} redirects to a missing extension resource`);
      }
    }
  }
  check(rulesetRegexCount <= 1000, `${resource.path} exceeds Chromium's per-ruleset regex limit`);
}

check(ruleIds.size <= 30000, "The package exceeds Chrome's static-rule limit");
check(ruleResources.length <= 100, "The package exceeds Chromium's static-ruleset count limit");
check(ruleResources.filter((resource) => resource.enabled).length <= 50, "The package exceeds Chromium's enabled static-ruleset limit");

let filterData;
try {
  filterData = await readJson("data/filter-data.json");
} catch (_error) {
  filterData = null;
}

if (filterData) {
  const generatedRuleIds = new Map([
    ["generated_ads", Object.values(filterData.categories || {}).filter((category) => category.tier === "always").map((category) => category.ruleId)],
    ["generated_strict", [
      ...Object.values(filterData.categories || {}).filter((category) => category.tier === "strict").map((category) => category.ruleId),
      ...(filterData.aggressiveEndpoints || []).map((endpoint) => endpoint.ruleId)
    ]],
    ["generated_redirects", [filterData.redirects?.ruleId].filter(Number.isInteger)]
  ]);

  for (const [resourceId, expectedIds] of generatedRuleIds) {
    const actualIds = new Set((rulesByResourceId.get(resourceId) || []).map((rule) => rule.id));
    for (const id of expectedIds) check(actualIds.has(id), `${resourceId} is missing generated rule id ${id}`);
  }

  const strictDomains = new Set(
    Object.entries(filterData.categories || {})
      .filter(([name, category]) => category.tier === "strict" || name === "push" || name === "tracker")
      .flatMap(([, category]) => category.domains || [])
  );
  const aggressiveRuleIds = new Set((filterData.aggressiveEndpoints || []).map((endpoint) => endpoint.ruleId));

  for (const resource of ruleResources.filter((entry) => !["privacy_strict", "generated_strict"].includes(entry.id))) {
    for (const rule of rulesByResourceId.get(resource.id) || []) {
      const leakedDomains = (rule.condition?.requestDomains || []).filter((domain) => strictDomains.has(domain));
      const normalizedFilter = `${rule.condition?.urlFilter || ""} ${rule.condition?.regexFilter || ""}`
        .toLowerCase()
        .replaceAll("\\", "");
      const leakedFilterDomains = [...strictDomains].filter((domain) => normalizedFilter.includes(domain));
      check(leakedDomains.length === 0, `${resource.id} exposes strict push/tracker domains outside Strict mode: ${leakedDomains.join(", ")}`);
      check(leakedFilterDomains.length === 0, `${resource.id} filters strict push/tracker hosts outside Strict mode: ${leakedFilterDomains.join(", ")}`);
      check(!aggressiveRuleIds.has(rule.id), `${resource.id} exposes aggressive strict rule id ${rule.id} outside Strict mode`);
      const types = rule.condition?.resourceTypes || [];
      const broadPingRule = types.includes("ping") &&
        !rule.condition?.requestDomains?.length &&
        !rule.condition?.urlFilter &&
        !rule.condition?.regexFilter;
      check(!broadPingRule, `${resource.id} contains a broad ping block outside Strict mode (rule ${rule.id})`);
    }
  }
}

const engineSource = await readFile(path.join(root, "content/engine.js"), "utf8");
const engineVersion = engineSource.match(/const VERSION = "([^"]+)"/)?.[1];
check(engineVersion === manifest.version, "content/engine.js VERSION must match manifest.json");

const navigationGuardSource = await readFile(path.join(root, "content/navigation-guard.js"), "utf8");
const navigationGuardVersion = navigationGuardSource.match(/const VERSION = "([^"]+)"/)?.[1];
check(navigationGuardVersion === manifest.version, "content/navigation-guard.js VERSION must match manifest.json");

const privacyGuardSource = await readFile(path.join(root, "content/privacy-guard.js"), "utf8");
const privacyGuardVersion = privacyGuardSource.match(/const VERSION = "([^"]+)"/)?.[1];
check(privacyGuardVersion === manifest.version, "content/privacy-guard.js VERSION must match manifest.json");

const contentSource = await readFile(path.join(root, "content/content.js"), "utf8");
check(!/data-aas-(?:active|hidden|reason)/.test(contentSource), "Page-visible extension state markers are forbidden");
check(!/chrome\.runtime\.sendMessage/.test(contentSource), "Content scripts must use the context-safe runtime bridge");
check(!/chrome\.storage\.local\.get/.test(contentSource), "Content scripts must use context-safe storage access");
check(/linkText:\s*anchor\.textContent/.test(contentSource), "Click analysis must include visible link text");
check(/ariaLabel:\s*anchor\.getAttribute\("aria-label"\)/.test(contentSource), "Click analysis must include ARIA labels");
check(/addEventListener\("pointerdown",\s*handleNavigationClick,\s*true\)/.test(contentSource), "Redirect protection must run before pointer-down ad handlers");
check(/state\.observer\?\.disconnect\(\)/.test(contentSource), "Disabled sites must disconnect the page observer");
check(/function pruneDisconnectedState\(\)/.test(contentSource), "Detached hidden elements must be pruned");
check(/state\.lastSignatures = new WeakMap\(\)/.test(contentSource), "Page-classification cache must reset after policy changes");
check(/countedElements:\s*new WeakSet\(\)/.test(contentSource), "Repeated classification must not double-count elements");

const staticRuleText = await Promise.all(
  ruleResources.map((resource) => readFile(path.join(root, resource.path), "utf8"))
);
check(!staticRuleText.some((source) => /webpick-cdn\.s3\.amazonaws\.com/i.test(source)), "Shared storage hosts must not be blocked globally");

const classicScripts = [
  manifest.background.service_worker,
  ...contentScripts.flatMap((script) => script.js || []),
  "ui/popup.js",
  "ui/options.js"
];

for (const relativePath of classicScripts) {
  try {
    new vm.Script(await readFile(path.join(root, relativePath), "utf8"), { filename: relativePath });
  } catch (error) {
    failures.push(`${relativePath} does not parse: ${error.message}`);
  }
}

for (const relativePath of ["ui/popup.html", "ui/options.html"]) {
  const html = await readFile(path.join(root, relativePath), "utf8");
  check(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), `${relativePath} contains inline JavaScript`);
  check(!/\son\w+\s*=/i.test(html), `${relativePath} contains an inline event handler`);
}

if (failures.length) {
  console.error(`Validation failed (${failures.length}):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log(`Validated Manifest V3 package: ${referencedFiles.length} resources, ${ruleIds.size} static rules.`);
}
