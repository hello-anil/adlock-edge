"use strict";

const DEFAULT_SETTINGS = Object.freeze({
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
});

const EMPTY_STATS = Object.freeze({
  totalHidden: 0,
  todayHidden: 0,
  totalRedirects: 0,
  todayRedirects: 0,
  date: "",
  sites: {},
  redirectSites: {}
});

const SITE_RULE_START = 100000;
const SITE_RULE_END = 199999;
const CUSTOM_RULE_START = 200000;
const CUSTOM_RULE_END = 299999;
const REPUTATION_RULE_START = 300000;
const REPUTATION_RULE_END = 399999;
const REDIRECT_ALLOW_START = 900000;
const REDIRECT_ALLOW_END = REDIRECT_ALLOW_START + 999999;
const REDIRECT_ALLOW_TTL_MS = 2 * 60 * 1000;
const REDIRECT_ALLOW_RECORDS_KEY = "redirectAllowRecords";
const DYNAMIC_REPUTATION_KEY = "dynamicReputation";
const REPUTATION_VERSION = 1;
const REPUTATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REPUTATION_THRESHOLD = 8;
const REPUTATION_MAX_ENTRIES = 500;
const REPUTATION_EVIDENCE_WEIGHTS = Object.freeze({
  "classified-ad": 4,
  "blocked-navigation": 6
});
const REPUTATION_PROTECTED_DOMAINS = Object.freeze([
  "accounts.google.com", "appleid.apple.com", "challenges.cloudflare.com", "checkout.com",
  "hcaptcha.com", "login.microsoftonline.com", "paypal.com", "recaptcha.net", "stripe.com"
]);
const NETWORK_RESOURCE_TYPES = Object.freeze([
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object",
  "xmlhttprequest", "ping", "media", "websocket", "webtransport", "other"
]);
const CONTENT_CSS_FILES = Object.freeze(["content/cosmetic.css"]);
const PROTECTION_CSS_FILES = Object.freeze(["content/protection.css"]);
const STRICT_CSS_FILES = Object.freeze(["content/strict.css"]);
const MAIN_WORLD_FILES = Object.freeze([
  "content/domain-data.js",
  "content/privacy-guard.js",
  "content/navigation-guard.js"
]);
const ISOLATED_WORLD_FILES = Object.freeze([
  "content/runtime-bridge.js",
  "content/domain-data.js",
  "content/engine.js",
  "content/content.js"
]);
let configurationQueue = Promise.resolve();
let sessionRuleQueue = Promise.resolve();
let statisticsQueue = Promise.resolve();
let reputationQueue = Promise.resolve();
const tabHiddenCounts = new Map();
const redirectAllowRulesByTab = new Map();

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function cleanDomain(value) {
  let text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  try {
    if (text.includes("://")) text = new URL(text).hostname;
  } catch (_error) {
    return "";
  }
  text = text.replace(/^\*\./, "").replace(/^www\./, "").replace(/^\.+|\.+$/g, "");
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(text) ? text : "";
}

function uniqueDomains(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(cleanDomain).filter(Boolean))].sort();
}

function normalizeSettings(value) {
  const candidate = value || {};
  return {
    globalEnabled: candidate.globalEnabled !== false,
    level: ["relaxed", "balanced", "strict"].includes(candidate.level) ? candidate.level : "strict",
    disabledSites: uniqueDomains(candidate.disabledSites),
    customBlockDomains: uniqueDomains(candidate.customBlockDomains).slice(0, 1000),
    customSelectors: [...new Set((Array.isArray(candidate.customSelectors) ? candidate.customSelectors : [])
      .map((selector) => String(selector).trim()).filter(Boolean))].slice(0, 250),
    showPlaceholders: candidate.showPlaceholders === true,
    redirectProtection: candidate.redirectProtection !== false,
    antiAdblockCompatibility: candidate.antiAdblockCompatibility !== false,
    dynamicFiltering: candidate.dynamicFiltering !== false,
    cleanTrackingParameters: candidate.cleanTrackingParameters !== false,
    privacyApiProtection: candidate.privacyApiProtection !== false,
    fingerprintProtection: candidate.fingerprintProtection !== false
  };
}

async function getSettings() {
  const stored = await chrome.storage.local.get("settings");
  return normalizeSettings({ ...DEFAULT_SETTINGS, ...(stored.settings || {}) });
}

async function getStats() {
  const stored = await chrome.storage.local.get("stats");
  const previous = stored.stats || {};
  const stats = {
    ...EMPTY_STATS,
    ...previous,
    sites: { ...(previous.sites || {}) },
    redirectSites: { ...(previous.redirectSites || {}) }
  };
  if (stats.date !== todayKey()) {
    stats.date = todayKey();
    stats.todayHidden = 0;
    stats.todayRedirects = 0;
  }
  return stats;
}

function buildSiteAllowRules(domains) {
  return [
    {
      id: SITE_RULE_START,
      priority: 20000,
      action: { type: "allowAllRequests" },
      condition: {
        requestDomains: domains,
        resourceTypes: ["main_frame", "sub_frame"]
      }
    },
    {
      id: SITE_RULE_START + 1,
      priority: 20000,
      action: { type: "allow" },
      condition: {
        initiatorDomains: domains,
        resourceTypes: NETWORK_RESOURCE_TYPES
      }
    }
  ];
}

function buildCustomBlockRule(domains) {
  return {
    id: CUSTOM_RULE_START,
    priority: 10,
    action: { type: "block" },
    condition: {
      requestDomains: domains,
      resourceTypes: NETWORK_RESOURCE_TYPES
    }
  };
}

function isOwnedDynamicRuleId(id) {
  return (id >= SITE_RULE_START && id <= SITE_RULE_END) ||
    (id >= CUSTOM_RULE_START && id <= CUSTOM_RULE_END) ||
    (id >= REPUTATION_RULE_START && id <= REPUTATION_RULE_END);
}

function buildReputationBlockRule(domains) {
  return {
    id: REPUTATION_RULE_START,
    priority: 8,
    action: { type: "block" },
    condition: {
      requestDomains: domains,
      resourceTypes: NETWORK_RESOURCE_TYPES.filter((type) => type !== "main_frame")
    }
  };
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function approximateSiteKey(hostname) {
  const labels = cleanDomain(hostname).split(".").filter(Boolean);
  return labels.length > 2 ? labels.slice(-2).join(".") : labels.join(".");
}

function sameSiteApproximation(left, right) {
  if (!left || !right) return false;
  return hostnameMatches(left, right) || hostnameMatches(right, left) ||
    approximateSiteKey(left) === approximateSiteKey(right);
}

function protectedReputationDomain(hostname) {
  return REPUTATION_PROTECTED_DOMAINS.some((domain) => hostnameMatches(hostname, domain));
}

function normalizeReputation(value, now = Date.now()) {
  const rawEntries = value?.version === REPUTATION_VERSION && value.entries && typeof value.entries === "object"
    ? value.entries
    : {};
  const entries = {};
  for (const [rawDomain, rawRecord] of Object.entries(rawEntries)) {
    const domain = cleanDomain(rawDomain);
    const lastSeen = Number(rawRecord?.lastSeen) || 0;
    if (!domain || protectedReputationDomain(domain) || now - lastSeen > REPUTATION_TTL_MS) continue;
    const sources = [...new Set((Array.isArray(rawRecord.sources) ? rawRecord.sources : [])
      .map((item) => String(item)).filter(Boolean))].slice(0, 16);
    const evidenceKeys = [...new Set((Array.isArray(rawRecord.evidenceKeys) ? rawRecord.evidenceKeys : [])
      .map((item) => String(item)).filter(Boolean))].slice(0, 32);
    const score = Math.max(0, Math.min(100, Number(rawRecord.score) || 0));
    entries[domain] = { score, sources, evidenceKeys, lastSeen };
  }
  const limited = Object.entries(entries)
    .sort((left, right) => right[1].lastSeen - left[1].lastSeen)
    .slice(0, REPUTATION_MAX_ENTRIES);
  return { version: REPUTATION_VERSION, entries: Object.fromEntries(limited) };
}

function promotedReputationDomains(reputation) {
  return Object.entries(reputation.entries)
    .filter(([, record]) => record.score >= REPUTATION_THRESHOLD && record.sources.length >= 2)
    .map(([domain]) => domain)
    .sort();
}

async function getDynamicReputation() {
  const stored = await chrome.storage.local.get(DYNAMIC_REPUTATION_KEY);
  return normalizeReputation(stored[DYNAMIC_REPUTATION_KEY]);
}

function buildDynamicRules(settings, reputation = { version: REPUTATION_VERSION, entries: {} }) {
  if (!settings.globalEnabled) return [];
  const learnedDomains = settings.dynamicFiltering ? promotedReputationDomains(reputation) : [];
  return [
    ...(settings.disabledSites.length ? buildSiteAllowRules(settings.disabledSites) : []),
    ...(settings.customBlockDomains.length ? [buildCustomBlockRule(settings.customBlockDomains)] : []),
    ...(learnedDomains.length ? [buildReputationBlockRule(learnedDomains)] : [])
  ];
}

async function syncNetworkConfiguration(settings) {
  const desiredRulesets = settings.globalEnabled
    ? [
        "core_ads",
        "generated_ads",
        ...(settings.redirectProtection ? ["redirect_ads", "generated_redirects"] : []),
        ...(settings.antiAdblockCompatibility ? ["anti_adblock_compat"] : []),
        ...(settings.level === "strict" && settings.cleanTrackingParameters ? ["privacy_navigation"] : []),
        ...(settings.level === "strict" ? ["privacy_strict", "generated_strict"] : [])
      ]
    : [];
  const enabledRulesets = await chrome.declarativeNetRequest.getEnabledRulesets();
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: desiredRulesets.filter((id) => !enabledRulesets.includes(id)),
    disableRulesetIds: enabledRulesets.filter((id) => !desiredRulesets.includes(id))
  });

  const [currentRules, reputation] = await Promise.all([
    chrome.declarativeNetRequest.getDynamicRules(),
    getDynamicReputation()
  ]);
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: currentRules.filter((rule) => isOwnedDynamicRuleId(rule.id)).map((rule) => rule.id),
    addRules: buildDynamicRules(settings, reputation)
  });
}

function enqueueConfiguration(operation) {
  const result = configurationQueue
    .catch(() => {})
    .then(operation);
  configurationQueue = result.catch(() => {});
  return result;
}

async function broadcastSettings(settings) {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.map((tab) =>
    tab.id ? chrome.tabs.sendMessage(tab.id, {
      type: "settings:changed",
      topLevelEnabled: protectionIsEnabledForHostname(settings, hostnameForTab(tab))
    }) : Promise.resolve()
  ));
}

function isHttpTab(tab) {
  if (!Number.isInteger(tab?.id)) return false;
  try {
    return ["http:", "https:"].includes(new URL(tab.url).protocol);
  } catch (_error) {
    return false;
  }
}

function hostnameMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function hostnameForTab(tab) {
  try {
    return new URL(tab.url).hostname.toLowerCase().replace(/^www\./, "");
  } catch (_error) {
    return "";
  }
}

function protectionIsEnabledForHostname(settings, hostname) {
  return Boolean(settings.globalEnabled && hostname &&
    !settings.disabledSites.some((domain) => hostnameMatches(hostname, domain)));
}

function userOriginIsUnsupported(error) {
  return /(?:unexpected|unknown|unsupported|invalid).{0,40}(?:property )?["']?origin|origin.{0,40}(?:unexpected|unknown|unsupported|invalid)/i
    .test(String(error?.message || error || ""));
}

async function insertCssFiles(target, files) {
  try {
    await chrome.scripting.insertCSS({ target, files, origin: "USER" });
  } catch (error) {
    if (!userOriginIsUnsupported(error)) throw error;
    await chrome.scripting.insertCSS({ target, files });
  }
}

async function removeCssFiles(target, files) {
  try {
    await chrome.scripting.removeCSS({ target, files, origin: "USER" });
  } catch (error) {
    if (!userOriginIsUnsupported(error)) throw error;
    await chrome.scripting.removeCSS({ target, files });
  }
}

async function reconcileConditionalCss(target, settings, hostname) {
  await removeCssFiles(target, PROTECTION_CSS_FILES);
  await removeCssFiles(target, STRICT_CSS_FILES);
  if (!protectionIsEnabledForHostname(settings, hostname)) return;
  await insertCssFiles(target, PROTECTION_CSS_FILES);
  if (settings.level === "strict") await insertCssFiles(target, STRICT_CSS_FILES);
}

async function injectContentIntoTab(tab, settings) {
  const target = { tabId: tab.id, allFrames: true };
  await insertCssFiles(target, CONTENT_CSS_FILES);
  await reconcileConditionalCss(target, settings, hostnameForTab(tab));
  await chrome.scripting.executeScript({
    target,
    files: MAIN_WORLD_FILES,
    world: "MAIN",
    injectImmediately: true
  });
  await chrome.scripting.executeScript({
    target,
    files: ISOLATED_WORLD_FILES,
    world: "ISOLATED",
    injectImmediately: true
  });
}

async function reinjectContentIntoOpenTabs() {
  const [tabs, settings] = await Promise.all([
    chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }),
    getSettings()
  ]);
  await Promise.allSettled(tabs.filter(isHttpTab).map((tab) => injectContentIntoTab(tab, settings)));
}

async function reconcileConditionalCssInOpenTabs(settings) {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  await Promise.allSettled(tabs.filter(isHttpTab).map((tab) =>
    reconcileConditionalCss({ tabId: tab.id, allFrames: true }, settings, hostnameForTab(tab))
  ));
}

function mutateSettings(mutator) {
  return enqueueConfiguration(async () => {
    const current = await getSettings();
    const settings = normalizeSettings(mutator(current));
    try {
      await syncNetworkConfiguration(settings);
      await chrome.storage.local.set({ settings });
    } catch (error) {
      await syncNetworkConfiguration(current).catch(() => {});
      throw new Error(`Unable to apply protection settings: ${error?.message || error}`);
    }
    await Promise.allSettled([
      broadcastSettings(settings),
      reconcileConditionalCssInOpenTabs(settings)
    ]);
    return settings;
  });
}

function reconcileStoredConfiguration({ persist = false } = {}) {
  return enqueueConfiguration(async () => {
    const settings = await getSettings();
    await syncNetworkConfiguration(settings);
    if (persist) await chrome.storage.local.set({ settings });
    return settings;
  });
}

function recordBlocked(message, sender) {
  const amount = Math.max(0, Math.min(10000, Number(message.count) || 0));
  const host = cleanDomain(message.hostname);
  if (!amount) return Promise.resolve();

  if (sender.tab?.id) {
    const aggregate = (tabHiddenCounts.get(sender.tab.id) || 0) + amount;
    tabHiddenCounts.set(sender.tab.id, aggregate);
    const badge = Math.min(999, aggregate);
    chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: "#5D6EF6" }).catch(() => {});
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: badge ? String(badge) : "" }).catch(() => {});
  }

  statisticsQueue = statisticsQueue.catch(() => {}).then(async () => {
    const stats = await getStats();
    stats.totalHidden += amount;
    stats.todayHidden += amount;
    if (host) stats.sites[host] = (stats.sites[host] || 0) + amount;

    const topSites = Object.entries(stats.sites)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 200);
    stats.sites = Object.fromEntries(topSites);
    await chrome.storage.local.set({ stats });
  });
  return statisticsQueue;
}

function recordRedirectBlocked(message, sender) {
  const host = cleanDomain(message.hostname);
  statisticsQueue = statisticsQueue.catch(() => {}).then(async () => {
    const stats = await getStats();
    stats.totalRedirects += 1;
    stats.todayRedirects += 1;
    if (host) stats.redirectSites[host] = (stats.redirectSites[host] || 0) + 1;
    stats.redirectSites = Object.fromEntries(
      Object.entries(stats.redirectSites).sort((a, b) => b[1] - a[1]).slice(0, 200)
    );
    await chrome.storage.local.set({ stats });
  });
  if (message.targetHostname) {
    recordReputationSignal({
      targetHostname: message.targetHostname,
      evidence: "blocked-navigation"
    }, sender).catch(() => {});
  }
  return statisticsQueue;
}

function recordReputationSignal(message, sender) {
  const result = reputationQueue
    .catch(() => {})
    .then(() => recordReputationSignalNow(message, sender));
  reputationQueue = result.catch(() => {});
  return result;
}

async function recordReputationSignalNow(message, sender) {
  const settings = await getSettings();
  if (!settings.globalEnabled || !settings.dynamicFiltering || settings.level !== "strict") {
    return { accepted: false, promoted: false };
  }

  const sourceHostname = hostnameForTab(sender?.tab);
  const targetHostname = cleanDomain(message.targetHostname);
  const evidence = String(message.evidence || "");
  const weight = REPUTATION_EVIDENCE_WEIGHTS[evidence];
  if (!sourceHostname || !targetHostname || !weight ||
      sameSiteApproximation(sourceHostname, targetHostname) || protectedReputationDomain(targetHostname)) {
    return { accepted: false, promoted: false };
  }

  const now = Date.now();
  const reputation = await getDynamicReputation();
  const sourceKey = fnv1a(approximateSiteKey(sourceHostname));
  const evidenceKey = `${sourceKey}:${evidence}`;
  const previous = reputation.entries[targetHostname] || {
    score: 0,
    sources: [],
    evidenceKeys: [],
    lastSeen: now
  };
  if (previous.evidenceKeys.includes(evidenceKey)) {
    previous.lastSeen = now;
    reputation.entries[targetHostname] = previous;
    await chrome.storage.local.set({ [DYNAMIC_REPUTATION_KEY]: normalizeReputation(reputation, now) });
    return {
      accepted: false,
      promoted: previous.score >= REPUTATION_THRESHOLD && previous.sources.length >= 2
    };
  }

  const wasPromoted = previous.score >= REPUTATION_THRESHOLD && previous.sources.length >= 2;
  previous.score = Math.min(100, previous.score + weight);
  previous.sources = [...new Set([...previous.sources, sourceKey])].slice(0, 16);
  previous.evidenceKeys = [...previous.evidenceKeys, evidenceKey].slice(-32);
  previous.lastSeen = now;
  reputation.entries[targetHostname] = previous;
  const normalized = normalizeReputation(reputation, now);
  await chrome.storage.local.set({ [DYNAMIC_REPUTATION_KEY]: normalized });

  const current = normalized.entries[targetHostname];
  const promoted = Boolean(current && current.score >= REPUTATION_THRESHOLD && current.sources.length >= 2);
  if (promoted && !wasPromoted) {
    await enqueueConfiguration(async () => syncNetworkConfiguration(await getSettings()));
  }
  return { accepted: true, promoted };
}

function isOwnedRedirectAllowRule(rule) {
  return Number.isInteger(rule?.id) && rule.id >= REDIRECT_ALLOW_START && rule.id <= REDIRECT_ALLOW_END;
}

function enqueueSessionRuleOperation(operation) {
  const result = sessionRuleQueue
    .catch(() => {})
    .then(operation);
  sessionRuleQueue = result.catch(() => {});
  return result;
}

async function getRedirectAllowRecords() {
  const stored = await chrome.storage.session.get(REDIRECT_ALLOW_RECORDS_KEY);
  return (Array.isArray(stored[REDIRECT_ALLOW_RECORDS_KEY]) ? stored[REDIRECT_ALLOW_RECORDS_KEY] : [])
    .filter((record) => Number.isInteger(record?.ruleId) && Number.isInteger(record?.tabId) && Number.isFinite(record?.expiresAt));
}

function saveRedirectAllowRecords(records) {
  return chrome.storage.session.set({ [REDIRECT_ALLOW_RECORDS_KEY]: records });
}

function tabIdsForRule(rule) {
  return Array.isArray(rule?.condition?.tabIds) ? rule.condition.tabIds.filter(Number.isInteger) : [];
}

function allocateRedirectAllowRuleId(tabId, usedIds) {
  const rangeSize = REDIRECT_ALLOW_END - REDIRECT_ALLOW_START + 1;
  const offset = Math.abs(tabId) % rangeSize;
  for (let attempt = 0; attempt < rangeSize; attempt += 1) {
    const ruleId = REDIRECT_ALLOW_START + ((offset + attempt) % rangeSize);
    if (!usedIds.has(ruleId)) return ruleId;
  }
  throw new Error("No redirect exception rule IDs are available");
}

async function reconcileRedirectAllowsNow() {
  const [rules, records, tabs] = await Promise.all([
    chrome.declarativeNetRequest.getSessionRules(),
    getRedirectAllowRecords(),
    chrome.tabs.query({})
  ]);
  const now = Date.now();
  const liveTabIds = new Set(tabs.map((tab) => tab.id).filter(Number.isInteger));
  const ownedRules = rules.filter(isOwnedRedirectAllowRule);
  const ownedRuleIds = new Set(ownedRules.map((rule) => rule.id));
  const recordByRuleId = new Map(records.map((record) => [record.ruleId, record]));
  const keptRecords = [];
  const removeRuleIds = [];

  redirectAllowRulesByTab.clear();
  for (const rule of ownedRules) {
    const record = recordByRuleId.get(rule.id);
    const ruleTabs = tabIdsForRule(rule);
    const valid = Boolean(record && record.expiresAt > now && liveTabIds.has(record.tabId) && ruleTabs.includes(record.tabId));
    if (!valid) {
      removeRuleIds.push(rule.id);
      continue;
    }
    keptRecords.push(record);
    redirectAllowRulesByTab.set(record.tabId, record.ruleId);
  }

  if (removeRuleIds.length) {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules: [] });
  }
  const normalizedRecords = keptRecords.filter((record) => ownedRuleIds.has(record.ruleId));
  await saveRedirectAllowRecords(normalizedRecords);
}

function reconcileRedirectAllows() {
  return enqueueSessionRuleOperation(reconcileRedirectAllowsNow);
}

async function allowRedirectOnce(urlValue, sender) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId)) throw new Error("No browser tab is available");
  let url;
  try {
    url = new URL(String(urlValue));
  } catch (_error) {
    throw new Error("Invalid redirect URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Unsupported redirect protocol");
  url.hash = "";

  return enqueueSessionRuleOperation(async () => {
    const [existingRules, records] = await Promise.all([
      chrome.declarativeNetRequest.getSessionRules(),
      getRedirectAllowRecords()
    ]);
    const now = Date.now();
    const previousRuleIds = new Set([
      ...existingRules.filter((rule) => isOwnedRedirectAllowRule(rule) && tabIdsForRule(rule).includes(tabId)).map((rule) => rule.id),
      ...records.filter((record) => record.tabId === tabId).map((record) => record.ruleId)
    ]);
    const expiredRuleIds = records
      .filter((record) => record.expiresAt <= now && existingRules.some((rule) => rule.id === record.ruleId && isOwnedRedirectAllowRule(rule)))
      .map((record) => record.ruleId);
    const removeRuleIds = [...new Set([...previousRuleIds, ...expiredRuleIds])];
    const usedIds = new Set(existingRules.map((rule) => rule.id).filter((id) => !removeRuleIds.includes(id)));
    const reusableId = [...previousRuleIds].find((id) => isOwnedRedirectAllowRule({ id }));
    const ruleId = reusableId || allocateRedirectAllowRuleId(tabId, usedIds);

    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds,
      addRules: [{
        id: ruleId,
        priority: 30000,
        action: { type: "allow" },
        condition: {
          urlFilter: `|${url.href}|`,
          tabIds: [tabId],
          resourceTypes: ["main_frame"]
        }
      }]
    });
    const nextRecords = records.filter((record) => !removeRuleIds.includes(record.ruleId) && record.expiresAt > now);
    nextRecords.push({ ruleId, tabId, expiresAt: now + REDIRECT_ALLOW_TTL_MS });
    await saveRedirectAllowRecords(nextRecords);
    previousRuleIds.forEach((id) => {
      for (const [mappedTabId, mappedRuleId] of redirectAllowRulesByTab) {
        if (mappedRuleId === id) redirectAllowRulesByTab.delete(mappedTabId);
      }
    });
    redirectAllowRulesByTab.set(tabId, ruleId);
  });
}

function removeRedirectAllowForTab(tabId) {
  return enqueueSessionRuleOperation(async () => {
    const [rules, records] = await Promise.all([
      chrome.declarativeNetRequest.getSessionRules(),
      getRedirectAllowRecords()
    ]);
    const ruleIds = new Set(
      rules.filter((rule) => isOwnedRedirectAllowRule(rule) && tabIdsForRule(rule).includes(tabId)).map((rule) => rule.id)
    );
    for (const record of records) {
      if (record.tabId === tabId && isOwnedRedirectAllowRule({ id: record.ruleId })) ruleIds.add(record.ruleId);
    }
    if (ruleIds.size) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [...ruleIds], addRules: [] });
    }
    await saveRedirectAllowRecords(records.filter((record) => record.tabId !== tabId && !ruleIds.has(record.ruleId)));
    redirectAllowRulesByTab.delete(tabId);
  });
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "content:ready":
      if (Number.isInteger(sender.tab?.id)) {
        const frameId = Number.isInteger(sender.frameId) ? sender.frameId : 0;
        const topLevelHostname = hostnameForTab(sender.tab);
        const settings = await getSettings();
        const topLevelEnabled = protectionIsEnabledForHostname(settings, topLevelHostname);
        await reconcileConditionalCss({ tabId: sender.tab.id, frameIds: [frameId] }, settings, topLevelHostname);
        if (frameId === 0) {
          tabHiddenCounts.set(sender.tab.id, 0);
          await chrome.action.setBadgeText({ tabId: sender.tab.id, text: "" });
        }
        return { ok: true, topLevelEnabled };
      }
      return { ok: true };
    case "content:blocked":
      await recordBlocked(message, sender);
      return { ok: true };
    case "content:redirectBlocked":
      await recordRedirectBlocked(message, sender);
      return { ok: true };
    case "content:reputationSignal":
      return { ok: true, ...(await recordReputationSignal(message, sender)) };
    case "redirect:allowOnce":
      await allowRedirectOnce(message.url, sender);
      return { ok: true };
    case "popup:getState": {
      const [settings, stats] = await Promise.all([getSettings(), getStats()]);
      return {
        settings,
        stats,
        pageHidden: Number.isInteger(message.tabId) ? (tabHiddenCounts.get(message.tabId) || 0) : 0
      };
    }
    case "settings:update": {
      return { settings: await mutateSettings((current) => ({ ...current, ...(message.patch || {}) })) };
    }
    case "site:setEnabled": {
      const domain = cleanDomain(message.hostname);
      if (!domain) throw new Error("Invalid site hostname");
      return {
        settings: await mutateSettings((current) => {
          const disabled = new Set(current.disabledSites);
          if (message.enabled) disabled.delete(domain);
          else disabled.add(domain);
          return { ...current, disabledSites: [...disabled] };
        })
      };
    }
    case "stats:reset": {
      const stats = { ...EMPTY_STATS, date: todayKey(), sites: {}, redirectSites: {} };
      await chrome.storage.local.set({ stats });
      return { stats };
    }
    case "reputation:reset": {
      await enqueueConfiguration(async () => {
        const previous = await getDynamicReputation();
        const empty = { version: REPUTATION_VERSION, entries: {} };
        await chrome.storage.local.set({ [DYNAMIC_REPUTATION_KEY]: empty });
        try {
          await syncNetworkConfiguration(await getSettings());
        } catch (error) {
          await chrome.storage.local.set({ [DYNAMIC_REPUTATION_KEY]: previous });
          await syncNetworkConfiguration(await getSettings()).catch(() => {});
          throw error;
        }
      });
      return { ok: true };
    }
    default:
      return { ok: false, error: "Unknown message" };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

function reconcileWorkerHealth({ persistSettings = false } = {}) {
  return Promise.allSettled([
    reconcileStoredConfiguration({ persist: persistSettings }),
    reconcileRedirectAllows()
  ]);
}

chrome.runtime.onInstalled.addListener(() => {
  return Promise.allSettled([
    reconcileStoredConfiguration({ persist: true }),
    getStats().then((stats) => chrome.storage.local.set({ stats })),
    reconcileRedirectAllows(),
    reinjectContentIntoOpenTabs()
  ]);
});

chrome.runtime.onStartup.addListener(() => {
  return reconcileWorkerHealth();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    tabHiddenCounts.set(tabId, 0);
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  }
  if (changeInfo.status === "complete") return removeRedirectAllowForTab(tabId).catch(() => {});
  return undefined;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabHiddenCounts.delete(tabId);
  return removeRedirectAllowForTab(tabId).catch(() => {});
});

// onStartup is a browser-profile event, not a service-worker restart event.
// Reconcile persisted DNR/session state whenever this worker is evaluated.
reconcileWorkerHealth().catch(() => {});
