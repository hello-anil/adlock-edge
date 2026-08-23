import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const sourcePath = path.join(root, "data/filter-data.json");
const outputPaths = Object.freeze({
  domainData: path.join(root, "content/domain-data.js"),
  alwaysRules: path.join(root, "rules/generated-always.json"),
  strictRules: path.join(root, "rules/generated-strict.json"),
  redirectRules: path.join(root, "rules/generated-redirects.json")
});

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESOURCE_TYPES = new Set([
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object",
  "xmlhttprequest", "ping", "csp_report", "media", "websocket", "webtransport",
  "webbundle", "other"
]);
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const sortedUnique = (values) => [...new Set(values)].sort(compareText);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateDomains(domains, label) {
  assert(Array.isArray(domains) && domains.length > 0, `${label} must contain domains`);
  const normalized = domains.map((domain) => String(domain).trim().toLowerCase());
  for (const domain of normalized) assert(DOMAIN_RE.test(domain), `${label} has invalid domain: ${domain}`);
  assert(new Set(normalized).size === normalized.length, `${label} contains duplicate domains`);
  assert(JSON.stringify(normalized) === JSON.stringify(sortedUnique(normalized)), `${label} domains must be sorted`);
  return normalized;
}

function validateResourceTypes(resourceTypes, label) {
  assert(Array.isArray(resourceTypes) && resourceTypes.length > 0, `${label} must contain resource types`);
  for (const type of resourceTypes) assert(RESOURCE_TYPES.has(type), `${label} has invalid resource type: ${type}`);
}

function validateRuleId(id, label, usedIds) {
  assert(Number.isInteger(id) && id >= 5000, `${label} ruleId must be an integer >= 5000`);
  assert(!usedIds.has(id), `${label} reuses static rule id ${id}`);
  usedIds.add(id);
}

function blockRule(id, priority, condition) {
  return { id, priority, action: { type: "block" }, condition };
}

function generateDomainData(dataset, categories, redirectDomains) {
  const categoryLines = Object.entries(categories).map(([name, category]) =>
    `    ${JSON.stringify(name)}: Object.freeze(${JSON.stringify(category.domains, null, 2).replace(/^/gm, "    ").trimStart()})`
  );
  const alwaysNames = Object.entries(categories).filter(([, category]) => category.tier === "always").map(([name]) => name);
  const strictNames = Object.entries(categories).filter(([, category]) => category.tier === "strict").map(([name]) => name);
  const advertisingNames = ["ad", "video", "native", "popup"];

  return `(function exposeAdLockDomainData(root, factory) {
  const data = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = data;
  root.AdLockDomainData = data;
})(typeof globalThis !== "undefined" ? globalThis : this, function createAdLockDomainData() {
  "use strict";

  const categories = Object.freeze({
${categoryLines.join(",\n")}
  });
  const combine = (...names) => Object.freeze([...new Set(names.flatMap((name) => categories[name]))].sort());

  return Object.freeze({
    schemaVersion: ${dataset.schemaVersion},
    revision: ${JSON.stringify(dataset.revision)},
    categories,
    alwaysOnDomains: combine(${alwaysNames.map(JSON.stringify).join(", ")}),
    strictDomains: combine(${strictNames.map(JSON.stringify).join(", ")}),
    advertisingDomains: combine(${advertisingNames.map(JSON.stringify).join(", ")}),
    redirectDomains: Object.freeze(${JSON.stringify(redirectDomains, null, 2).replace(/^/gm, "    ").trimStart()})
  });
});
`;
}

async function buildOutputs() {
  const dataset = JSON.parse(await readFile(sourcePath, "utf8"));
  assert(dataset.schemaVersion === 1, "Unsupported filter-data schemaVersion");
  assert(typeof dataset.revision === "string" && dataset.revision, "filter-data revision is required");
  assert(dataset.categories && typeof dataset.categories === "object", "filter-data categories are required");
  assert(dataset.resourceProfiles && typeof dataset.resourceProfiles === "object", "resourceProfiles are required");

  for (const [name, resourceTypes] of Object.entries(dataset.resourceProfiles)) {
    validateResourceTypes(resourceTypes, `resourceProfiles.${name}`);
  }

  const usedIds = new Set();
  const categories = {};
  const domainOwners = new Map();
  const alwaysRules = [];
  const strictRules = [];

  for (const [name, rawCategory] of Object.entries(dataset.categories).sort(([left], [right]) => compareText(left, right))) {
    assert(["always", "strict"].includes(rawCategory.tier), `categories.${name} has invalid tier`);
    validateRuleId(rawCategory.ruleId, `categories.${name}`, usedIds);
    assert(Number.isInteger(rawCategory.priority) && rawCategory.priority > 0, `categories.${name} has invalid priority`);
    const resourceTypes = dataset.resourceProfiles[rawCategory.resourceProfile];
    validateResourceTypes(resourceTypes, `categories.${name}`);
    const domains = validateDomains(rawCategory.domains, `categories.${name}`);
    for (const domain of domains) {
      const previousOwner = domainOwners.get(domain);
      assert(!previousOwner, `${domain} is assigned to both ${previousOwner} and ${name}`);
      domainOwners.set(domain, name);
    }

    categories[name] = { ...rawCategory, domains };
    const condition = { requestDomains: domains };
    if (rawCategory.domainType) condition.domainType = rawCategory.domainType;
    condition.resourceTypes = resourceTypes;
    const rule = blockRule(rawCategory.ruleId, rawCategory.priority, condition);
    (rawCategory.tier === "always" ? alwaysRules : strictRules).push(rule);
  }

  for (const endpoint of dataset.aggressiveEndpoints || []) {
    validateRuleId(endpoint.ruleId, `aggressiveEndpoints.${endpoint.key}`, usedIds);
    assert(typeof endpoint.key === "string" && endpoint.key, "Every aggressive endpoint needs a key");
    assert(Number.isInteger(endpoint.priority) && endpoint.priority > 0, `${endpoint.key} has invalid priority`);
    validateResourceTypes(endpoint.resourceTypes, `aggressiveEndpoints.${endpoint.key}`);
    assert(!(endpoint.urlFilter && endpoint.regexFilter), `${endpoint.key} cannot use urlFilter and regexFilter together`);
    if (endpoint.regexFilter) new RegExp(endpoint.regexFilter, endpoint.isUrlFilterCaseSensitive === false ? "i" : "");
    const condition = {};
    for (const property of ["urlFilter", "regexFilter", "isUrlFilterCaseSensitive", "domainType"]) {
      if (endpoint[property] !== undefined) condition[property] = endpoint[property];
    }
    condition.resourceTypes = endpoint.resourceTypes;
    strictRules.push(blockRule(endpoint.ruleId, endpoint.priority, condition));
  }

  validateRuleId(dataset.redirects.ruleId, "redirects", usedIds);
  assert(Number.isInteger(dataset.redirects.priority) && dataset.redirects.priority > 0, "redirects has invalid priority");
  const redirectResourceTypes = dataset.resourceProfiles[dataset.redirects.resourceProfile];
  validateResourceTypes(redirectResourceTypes, "redirects");
  const redirectCategoryNames = sortedUnique(dataset.redirects.categories || []);
  for (const name of redirectCategoryNames) assert(categories[name], `redirects references unknown category ${name}`);
  const redirectDomains = sortedUnique(redirectCategoryNames.flatMap((name) => categories[name].domains));
  const redirectRules = [blockRule(dataset.redirects.ruleId, dataset.redirects.priority, {
    requestDomains: redirectDomains,
    resourceTypes: redirectResourceTypes
  })];

  alwaysRules.sort((left, right) => left.id - right.id);
  strictRules.sort((left, right) => left.id - right.id);

  return new Map([
    [outputPaths.domainData, generateDomainData(dataset, categories, redirectDomains)],
    [outputPaths.alwaysRules, `${JSON.stringify(alwaysRules, null, 2)}\n`],
    [outputPaths.strictRules, `${JSON.stringify(strictRules, null, 2)}\n`],
    [outputPaths.redirectRules, `${JSON.stringify(redirectRules, null, 2)}\n`]
  ]);
}

const outputs = await buildOutputs();
const checkOnly = process.argv.includes("--check");
const stale = [];

for (const [filename, expected] of outputs) {
  if (checkOnly) {
    let actual = "";
    try { actual = await readFile(filename, "utf8"); } catch (_error) { /* Report missing output as stale. */ }
    if (actual !== expected) stale.push(path.relative(root, filename));
  } else {
    await writeFile(filename, expected, "utf8");
  }
}

if (stale.length) {
  throw new Error(`Generated filter artifacts are stale: ${stale.join(", ")}`);
}

console.log(checkOnly
  ? `Verified ${outputs.size} generated filter artifacts.`
  : `Generated ${outputs.size} filter artifacts from ${path.relative(root, sourcePath)}.`);
