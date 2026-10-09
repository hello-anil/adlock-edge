import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

class ChromeEvent {
  listeners = [];
  addListener(listener) { this.listeners.push(listener); }
  async emit(...args) { return Promise.all(this.listeners.map((listener) => listener(...args))); }
}

function createChromeMock({
  tabs = [],
  failScriptTabIds = [],
  rejectUserOrigin = false,
  initialData = {},
  initialSessionData = {},
  initialDynamicRules = [],
  initialSessionRules = [],
  initialEnabledRulesets = ["core_ads", "redirect_ads"],
  initialFailures = {}
} = {}) {
  const data = structuredClone(initialData);
  const sessionData = structuredClone(initialSessionData);
  const enabledRulesets = new Set(initialEnabledRulesets);
  let dynamicRules = structuredClone(initialDynamicRules);
  let sessionRules = structuredClone(initialSessionRules);
  const failures = {
    enabledUpdates: 0,
    dynamicUpdates: 0,
    sessionReads: 0,
    sessionUpdates: 0,
    tabQueries: 0,
    ...initialFailures
  };
  const calls = {
    enabledUpdates: [],
    dynamicUpdates: [],
    sessionUpdates: [],
    badges: [],
    tabQueries: [],
    cssInsertions: [],
    cssRemovals: [],
    scriptExecutions: [],
    sentMessages: [],
    runtimeMessages: []
  };
  const failingScriptTabs = new Set(failScriptTabIds);

  function failIfRequested(key, message) {
    if (!failures[key]) return;
    failures[key] -= 1;
    throw new Error(message);
  }

  const runtimeOnMessage = new ChromeEvent();
  const chrome = {
    runtime: {
      async sendMessage(message) { calls.runtimeMessages.push(structuredClone(message)); },
      onMessage: runtimeOnMessage,
      onInstalled: new ChromeEvent(),
      onStartup: new ChromeEvent()
    },
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") return { [key]: data[key] };
          return { ...data };
        },
        async set(values) { Object.assign(data, structuredClone(values)); }
      },
      session: {
        async get(key) {
          if (typeof key === "string") return { [key]: sessionData[key] };
          return { ...sessionData };
        },
        async set(values) { Object.assign(sessionData, structuredClone(values)); }
      }
    },
    declarativeNetRequest: {
      async getEnabledRulesets() { return [...enabledRulesets]; },
      async updateEnabledRulesets(update) {
        calls.enabledUpdates.push(structuredClone(update));
        failIfRequested("enabledUpdates", "Static ruleset update failed");
        update.enableRulesetIds.forEach((id) => enabledRulesets.add(id));
        update.disableRulesetIds.forEach((id) => enabledRulesets.delete(id));
      },
      async getDynamicRules() { return structuredClone(dynamicRules); },
      async updateDynamicRules(update) {
        calls.dynamicUpdates.push(structuredClone(update));
        failIfRequested("dynamicUpdates", "Dynamic rule update failed");
        const removed = new Set(update.removeRuleIds);
        dynamicRules = dynamicRules.filter((rule) => !removed.has(rule.id));
        dynamicRules.push(...structuredClone(update.addRules));
      },
      async getSessionRules() {
        failIfRequested("sessionReads", "Session rule read failed");
        return structuredClone(sessionRules);
      },
      async updateSessionRules(update) {
        calls.sessionUpdates.push(structuredClone(update));
        failIfRequested("sessionUpdates", "Session rule update failed");
        const removed = new Set(update.removeRuleIds || []);
        sessionRules = sessionRules.filter((rule) => !removed.has(rule.id));
        sessionRules.push(...structuredClone(update.addRules || []));
      }
    },
    tabs: {
      onUpdated: new ChromeEvent(),
      onRemoved: new ChromeEvent(),
      async query(query) {
        calls.tabQueries.push(structuredClone(query));
        failIfRequested("tabQueries", "Tab query failed");
        return structuredClone(tabs);
      },
      async sendMessage(tabId, message) {
        calls.sentMessages.push({ tabId, message: structuredClone(message) });
        return { ok: true };
      }
    },
    scripting: {
      async insertCSS(details) {
        calls.cssInsertions.push(structuredClone(details));
        if (rejectUserOrigin && details.origin === "USER") {
          throw new Error("Unexpected property: origin");
        }
      },
      async removeCSS(details) {
        calls.cssRemovals.push(structuredClone(details));
        if (rejectUserOrigin && details.origin === "USER") {
          throw new Error("Unexpected property: origin");
        }
      },
      async executeScript(details) {
        calls.scriptExecutions.push(structuredClone(details));
        if (failingScriptTabs.has(details.target.tabId)) throw new Error("Cannot access this tab");
      }
    },
    action: {
      async setBadgeText(value) { calls.badges.push(value); },
      async setBadgeBackgroundColor() {}
    }
  };

  async function message(payload, sender = {}) {
    const listener = runtimeOnMessage.listeners[0];
    return new Promise((resolve) => {
      const asyncResponse = listener(payload, sender, resolve);
      assert.equal(asyncResponse, true);
    });
  }

  return {
    chrome, data, sessionData, enabledRulesets, failures, calls, message,
    getDynamicRules: () => dynamicRules,
    getSessionRules: () => sessionRules
  };
}

async function settleAsyncWork(rounds = 6) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function evaluateWorker(options) {
  const mock = createChromeMock(options);
  const filename = path.resolve(import.meta.dirname, "../background/service-worker.js");
  const source = await readFile(filename, "utf8");
  vm.runInNewContext(source, {
    chrome: mock.chrome,
    console,
    URL,
    Date,
    Set,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Math,
    RegExp,
    Error
  }, { filename });
  await settleAsyncWork();
  return mock;
}

async function loadWorker(options) {
  const mock = await evaluateWorker(options);
  await mock.chrome.runtime.onInstalled.emit();
  await settleAsyncWork();
  return mock;
}

test("enabling a subdomain removes matching parent exceptions and keeps unrelated pauses", async () => {
  const mock = await loadWorker({ initialData: { settings: {
    disabledSites: ["example.org", "news.example.org", "other.example"]
  } } });
  const result = await mock.message({ type: "site:setEnabled", hostname: "news.example.org", enabled: true });
  assert.deepEqual(Array.from(result.settings.disabledSites), ["other.example"]);
  const rules = mock.getDynamicRules().filter((rule) => rule.id === 100000);
  assert.deepEqual(Array.from(rules[0].condition.requestDomains), ["other.example"]);
});

test("statistics reset serializes between pending and subsequent counts", async () => {
  const mock = await loadWorker();
  const sender = { tab: { id: 0 } };
  await Promise.all([
    mock.message({ type: "content:blocked", count: 7 }, sender),
    mock.message({ type: "stats:reset" }),
    mock.message({ type: "content:blocked", count: 2 }, sender)
  ]);
  const result = await mock.message({ type: "popup:getState", tabId: 0 });
  assert.equal(result.stats.totalHidden, 2);
  assert.equal(result.stats.todayHidden, 2);
  assert.equal(result.pageHidden, 9);
});

test("paused sites cannot contribute learned blocking evidence", async () => {
  const mock = await loadWorker({ initialData: { settings: { dynamicFiltering: true, disabledSites: ["example.org"] } } });
  const response = await mock.message({
    type: "content:reputationSignal", targetHostname: "ad-host.example", evidence: "classified-ad"
  }, { tab: { id: 1, url: "https://news.example.org/story" } });
  assert.equal(response.accepted, false);
  assert.equal(mock.data.dynamicReputation?.entries?.["ad-host.example"], undefined);
});

test("install initializes normalized local settings and statistics", async () => {
  const mock = await loadWorker();
  assert.equal(mock.data.settings.globalEnabled, true);
  assert.equal(mock.data.settings.dynamicFiltering, false);
  assert.equal(mock.data.settings.level, "strict");
  assert.deepEqual(Array.from(mock.data.settings.disabledSites), []);
  assert.equal(mock.data.stats.totalHidden, 0);
  assert.deepEqual([...mock.enabledRulesets].sort(), [
    "anti_adblock_compat",
    "core_ads",
    "generated_ads",
    "generated_redirects",
    "generated_strict",
    "privacy_navigation",
    "privacy_strict",
    "redirect_ads"
  ]);
});

test("network health detects missing static and mismatched dynamic rules and recovers", async () => {
  const mock = await loadWorker();
  assert.equal((await mock.message({ type: "popup:getState" })).networkHealth.status, "active");
  mock.enabledRulesets.delete("core_ads");
  assert.equal((await mock.message({ type: "popup:getState" })).networkHealth.status, "degraded");
  await mock.message({ type: "settings:update", patch: { customBlockDomains: ["ad.example"] } });
  mock.getDynamicRules().find((rule) => rule.id === 200000).action.type = "allow";
  assert.equal((await mock.message({ type: "popup:getState" })).networkHealth.status, "degraded");
  const recovered = await mock.message({ type: "settings:update", patch: { globalEnabled: false } });
  assert.equal(recovered.networkHealth.status, "paused");
  mock.chrome.declarativeNetRequest.getEnabledRulesets = async () => { throw new Error("Unavailable"); };
  assert.equal((await mock.message({ type: "popup:getState" })).networkHealth.status, "unavailable");
});

test("switching away from Strict removes learned rules and restores them only when Strict returns", async () => {
  const mock = await loadWorker({ initialData: { settings: { dynamicFiltering: true }, dynamicReputation: {
    version: 1, entries: { "learned.example": { score: 8, sources: ["a", "b"],
      evidenceKeys: ["a:classified-ad", "b:classified-ad"], lastSeen: Date.now() } }
  } } });
  assert.equal(mock.getDynamicRules().some((rule) => rule.id === 300000), true);
  for (const level of ["balanced", "relaxed"]) {
    const response = await mock.message({ type: "settings:update", patch: { level } });
    assert.equal(response.networkHealth.status, "active");
    assert.equal(mock.getDynamicRules().some((rule) => rule.id === 300000), false);
    assert.ok(mock.data.dynamicReputation.entries["learned.example"]);
  }
  await mock.message({ type: "settings:update", patch: { level: "strict" } });
  assert.equal(mock.getDynamicRules().some((rule) => rule.id === 300000), true);
});

test("local learning is opt-in and incognito evidence never persists even after opting in", async () => {
  const mock = await loadWorker();
  const signal = { type: "content:reputationSignal", targetHostname: "unknown-ad.example", evidence: "classified-ad" };
  const sender = { tab: { id: 2, url: "https://publisher.example/" } };
  assert.equal((await mock.message(signal, sender)).accepted, false);
  await mock.message({ type: "settings:update", patch: { dynamicFiltering: true } });
  assert.equal((await mock.message(signal, { tab: { ...sender.tab, incognito: true } })).accepted, false);
  assert.equal(mock.data.dynamicReputation?.entries?.["unknown-ad.example"], undefined);
  assert.equal((await mock.message(signal, sender)).accepted, true);
});

test("startup preserves an explicitly stored balanced level and disables strict and redirect-generated rules", async () => {
  const mock = await evaluateWorker({
    initialData: {
      settings: { level: "balanced", redirectProtection: false }
    },
    initialEnabledRulesets: [
      "core_ads", "generated_ads", "redirect_ads", "generated_redirects",
      "privacy_strict", "generated_strict", "anti_adblock_compat"
    ]
  });

  assert.equal(mock.data.settings.level, "balanced");
  assert.deepEqual([...mock.enabledRulesets].sort(), ["anti_adblock_compat", "core_ads", "generated_ads"]);
});

test("install reinjects user-origin CSS and both script worlds into existing web tabs", async () => {
  const mock = await loadWorker({
    tabs: [
      { id: 7, url: "https://publisher.example/article" },
      { id: 8, url: "http://local.example/" },
      { id: 9, url: "edge://extensions/" },
      { url: "https://missing-tab-id.example/" }
    ]
  });

  assert.equal(
    mock.calls.tabQueries.some((query) => JSON.stringify(query) === JSON.stringify({ url: ["http://*/*", "https://*/*"] })),
    true
  );
  const baseCssCalls = mock.calls.cssInsertions.filter((call) => call.files.includes("content/cosmetic.css"));
  assert.deepEqual(baseCssCalls.map((call) => call.target.tabId), [7, 8]);
  for (const call of baseCssCalls) {
    assert.deepEqual(call.target, { tabId: call.target.tabId, allFrames: true });
    assert.deepEqual(Array.from(call.files), ["content/cosmetic.css"]);
    assert.equal(call.origin, "USER");
  }

  const mainWorldCalls = mock.calls.scriptExecutions.filter((call) => call.world === "MAIN");
  const isolatedWorldCalls = mock.calls.scriptExecutions.filter((call) => call.world === "ISOLATED");
  assert.deepEqual(mainWorldCalls.map((call) => call.target.tabId), [7, 8]);
  assert.deepEqual(isolatedWorldCalls.map((call) => call.target.tabId), [7, 8]);
  assert.deepEqual(Array.from(mainWorldCalls[0].files), [
    "content/domain-data.js",
    "content/privacy-guard.js",
    "content/navigation-guard.js"
  ]);
  assert.deepEqual(Array.from(isolatedWorldCalls[0].files), [
    "content/runtime-bridge.js",
    "content/domain-data.js",
    "content/engine.js",
    "content/content.js"
  ]);
  assert.equal(mainWorldCalls[0].injectImmediately, true);
  assert.equal(isolatedWorldCalls[0].injectImmediately, true);
});

test("install reinjection finishes before a concurrent pause reconciles CSS", async () => {
  const mock = await loadWorker({ tabs: [{ id: 7, url: "https://example.org/" }] });
  const insertCss = mock.chrome.scripting.insertCSS;
  let releaseInjection;
  let injectionStarted;
  const gate = new Promise((resolve) => { releaseInjection = resolve; });
  const started = new Promise((resolve) => { injectionStarted = resolve; });
  mock.chrome.scripting.insertCSS = async (details) => {
    if (details.files.includes("content/cosmetic.css")) { injectionStarted(); await gate; }
    await insertCss(details);
  };
  mock.calls.cssInsertions.length = 0;
  const install = mock.chrome.runtime.onInstalled.emit();
  await started;
  const pause = mock.message({ type: "settings:update", patch: { globalEnabled: false } });
  try {
    await settleAsyncWork();
    assert.equal(mock.data.settings.globalEnabled, true, "pause waits for the pending installation injection");
  } finally { releaseInjection(); }
  await install;
  const paused = await pause;
  assert.equal(paused.settings.globalEnabled, false);
  const insertionCount = mock.calls.cssInsertions.length;
  await settleAsyncWork();
  assert.equal(mock.calls.cssInsertions.length, insertionCount, "installation cannot apply enabled styles after pause");
});

test("reinjection isolates tab failures and falls back when USER-origin CSS is unavailable", async () => {
  const mock = await loadWorker({
    tabs: [
      { id: 17, url: "https://restricted.example/" },
      { id: 18, url: "https://working.example/" }
    ],
    failScriptTabIds: [17],
    rejectUserOrigin: true
  });

  const baseCssCalls = mock.calls.cssInsertions.filter((call) => call.files.includes("content/cosmetic.css"));
  assert.deepEqual(baseCssCalls.map((call) => [call.target.tabId, call.origin]), [
    [17, "USER"], [18, "USER"], [17, undefined], [18, undefined]
  ]);
  assert.equal(mock.calls.cssRemovals.some((call) => call.origin === "USER"), true);
  assert.equal(mock.calls.cssRemovals.some((call) => call.origin === undefined), true);
  assert.equal(mock.calls.scriptExecutions.some((call) => call.target.tabId === 17), true);
  assert.deepEqual(
    mock.calls.scriptExecutions.filter((call) => call.target.tabId === 18).map((call) => call.world),
    ["MAIN", "ISOLATED"]
  );
});

test("conditional USER CSS follows strict level, site pause, and content frame readiness", async () => {
  const mock = await loadWorker({
    tabs: [
      { id: 31, url: "https://paused.example/watch" },
      { id: 32, url: "https://active.example/watch" }
    ]
  });

  assert.deepEqual(
    mock.calls.cssInsertions.filter((call) => call.files.includes("content/protection.css")).map((call) => call.target.tabId),
    [31, 32]
  );
  assert.deepEqual(
    mock.calls.cssInsertions.filter((call) => call.files.includes("content/strict.css")).map((call) => call.target.tabId),
    [31, 32]
  );

  mock.calls.cssInsertions.length = 0;
  mock.calls.cssRemovals.length = 0;
  await mock.message(
    { type: "content:ready", hostname: "active.example" },
    { tab: { id: 32, url: "https://active.example/watch" }, frameId: 4 }
  );
  assert.deepEqual(mock.calls.cssInsertions.map((call) => [call.target, Array.from(call.files)]), [
    [{ tabId: 32, frameIds: [4] }, ["content/protection.css"]],
    [{ tabId: 32, frameIds: [4] }, ["content/strict.css"]]
  ]);

  mock.calls.cssInsertions.length = 0;
  mock.calls.cssRemovals.length = 0;
  await mock.message({
    type: "settings:update",
    patch: { level: "balanced", disabledSites: ["paused.example"] }
  });

  assert.deepEqual(
    mock.calls.cssRemovals.map((call) => call.target.tabId).sort((a, b) => a - b),
    [31, 31, 32, 32]
  );
  assert.deepEqual(
    mock.calls.cssInsertions.map((call) => [call.target.tabId, Array.from(call.files)]),
    [[32, ["content/protection.css"]]]
  );

  mock.calls.cssInsertions.length = 0;
  mock.calls.cssRemovals.length = 0;
  const pausedFrame = await mock.message(
    { type: "content:ready", hostname: "third-party-frame.example" },
    { tab: { id: 31, url: "https://paused.example/watch" }, frameId: 4 }
  );
  assert.equal(pausedFrame.topLevelEnabled, false);
  assert.deepEqual(mock.calls.cssRemovals.map((call) => call.target), [
    { tabId: 31, frameIds: [4] },
    { tabId: 31, frameIds: [4] }
  ]);
  assert.deepEqual(mock.calls.cssRemovals.map((call) => Array.from(call.files)), [
    ["content/protection.css"],
    ["content/strict.css"]
  ]);
  assert.deepEqual(mock.calls.cssInsertions, []);
});

test("install reinjection still runs when network and session reconciliation fail", async () => {
  const mock = await loadWorker({
    tabs: [{ id: 27, url: "https://publisher.example/" }],
    initialFailures: { enabledUpdates: 10, sessionReads: 10 }
  });

  assert.equal(mock.calls.cssInsertions.some((call) => call.target.tabId === 27), true);
  assert.deepEqual(
    mock.calls.scriptExecutions.filter((call) => call.target.tabId === 27).map((call) => call.world),
    ["MAIN", "ISOLATED"]
  );
  assert.equal(mock.data.stats.totalHidden, 0);
});

test("startup reconciliation preserves unrelated dynamic rules and coalesces owned domains", async () => {
  const mock = await evaluateWorker({
    initialData: {
      settings: {
        level: "strict",
        disabledSites: ["news.example", "video.example"],
        customBlockDomains: ["ads.example", "tracking.example"]
      }
    },
    initialDynamicRules: [
      { id: 42, priority: 1, action: { type: "block" }, condition: { requestDomains: ["unrelated.example"] } },
      { id: 100123, priority: 1, action: { type: "allow" }, condition: { requestDomains: ["legacy.example"] } },
      { id: 200500, priority: 1, action: { type: "block" }, condition: { requestDomains: ["legacy-ads.example"] } }
    ]
  });

  assert.equal(mock.enabledRulesets.has("privacy_strict"), true);
  const rules = mock.getDynamicRules().sort((left, right) => left.id - right.id);
  assert.deepEqual(rules.map((rule) => rule.id), [42, 100000, 100001, 200000]);
  assert.deepEqual(Array.from(rules[1].condition.requestDomains), ["news.example", "video.example"]);
  assert.deepEqual(Array.from(rules[2].condition.initiatorDomains), ["news.example", "video.example"]);
  assert.deepEqual(Array.from(rules[3].condition.requestDomains), ["ads.example", "tracking.example"]);
});

test("unchanged network rules and CSS are not rewritten when changing between relaxed and balanced", async () => {
  const mock = await loadWorker({ tabs: [{ id: 7, url: "https://example.org/" }] });
  await mock.message({ type: "settings:update", patch: { level: "balanced" } });
  mock.calls.enabledUpdates.length = 0;
  mock.calls.dynamicUpdates.length = 0;
  mock.calls.cssInsertions.length = 0;
  mock.calls.cssRemovals.length = 0;
  const result = await mock.message({ type: "settings:update", patch: { level: "relaxed" } });
  assert.equal(result.networkHealth.status, "active");
  assert.equal(result.settings.level, "relaxed");
  assert.equal(mock.calls.enabledUpdates.length, 0);
  assert.equal(mock.calls.dynamicUpdates.length, 0);
  assert.equal(mock.calls.cssInsertions.length, 0);
  assert.equal(mock.calls.cssRemovals.length, 0);
});

test("site pause changes conditional CSS only on affected tabs", async () => {
  const mock = await loadWorker({ tabs: [
    { id: 7, url: "https://example.org/" }, { id: 8, url: "https://news.example.org/article" },
    { id: 9, url: "https://unrelated.org/" }
  ] });
  mock.calls.cssRemovals.length = 0;
  await mock.message({ type: "site:setEnabled", hostname: "example.org", enabled: false });
  assert.deepEqual([...new Set(mock.calls.cssRemovals.map(call => call.target.tabId))].sort(), [7, 8]);
});

test("toolbar receives aggregate live counts and navigation resets for the correct tab", async () => {
  const mock = await loadWorker();
  await mock.message({ type: "content:blocked", hostname: "example.org", count: 2 }, { tab: { id: 0 } });
  await mock.message({ type: "content:blocked", hostname: "frame.example", count: 3 }, { tab: { id: 0 }, frameId: 4 });
  await mock.chrome.tabs.onUpdated.emit(0, { status: "loading" });
  assert.deepEqual(mock.calls.runtimeMessages.filter(message => message.type === "popup:pageCount"), [
    { type: "popup:pageCount", tabId: 0, pageHidden: 2 },
    { type: "popup:pageCount", tabId: 0, pageHidden: 5 },
    { type: "popup:pageCount", tabId: 0, pageHidden: 0 }
  ]);
});

test("failed network updates preserve stored settings, roll back rules, and leave the queue usable", async () => {
  const mock = await loadWorker();
  mock.failures.dynamicUpdates = 1;

  const failed = await mock.message({ type: "settings:update", patch: { level: "relaxed", customBlockDomains: ["ads.example"] } });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /Unable to apply protection settings: Dynamic rule update failed/);
  assert.equal(mock.data.settings.level, "strict");
  assert.equal(mock.enabledRulesets.has("privacy_strict"), true);

  const recovered = await mock.message({ type: "settings:update", patch: { level: "relaxed" } });
  assert.equal(recovered.settings.level, "relaxed");
  assert.equal(mock.data.settings.level, "relaxed");
  assert.equal(mock.enabledRulesets.has("privacy_strict"), false);
});

test("pause publishes settings after conditional CSS is removed", async () => {
  const mock = await loadWorker({ tabs: [{ id: 7, url: "https://example.org/" }] });
  const removeCss = mock.chrome.scripting.removeCSS;
  let releaseRemoval;
  let removalStarted;
  const gate = new Promise((resolve) => { releaseRemoval = resolve; });
  const started = new Promise((resolve) => { removalStarted = resolve; });
  mock.chrome.scripting.removeCSS = async (details) => {
    removalStarted();
    await gate;
    await removeCss(details);
  };
  const pause = mock.message({ type: "settings:update", patch: { globalEnabled: false } });
  await started;
  try {
    // Storage listeners restore hidden nodes immediately. They must receive the
    // paused state only after the USER styles no longer suppress shadow layout.
    assert.equal(mock.data.settings.globalEnabled, true);
  } finally { releaseRemoval(); }
  const result = await pause;
  assert.equal(result.settings.globalEnabled, false);
  assert.equal(mock.data.settings.globalEnabled, false);
});

test("a frame becoming ready during pause cannot reinstall enabled CSS", async () => {
  const mock = await loadWorker({ tabs: [{ id: 7, url: "https://example.org/" }] });
  const removeCss = mock.chrome.scripting.removeCSS;
  let releaseRemoval;
  let removalStarted;
  const gate = new Promise((resolve) => { releaseRemoval = resolve; });
  const started = new Promise((resolve) => { removalStarted = resolve; });
  mock.chrome.scripting.removeCSS = async (details) => {
    if (details.target.allFrames) {
      removalStarted();
      await gate;
    }
    await removeCss(details);
  };
  mock.calls.cssInsertions.length = 0;
  const pause = mock.message({ type: "settings:update", patch: { globalEnabled: false } });
  await started;
  let readyCompleted = false;
  const ready = mock.message({ type: "content:ready" }, {
    tab: { id: 7, url: "https://example.org/" }, frameId: 0
  }).then((result) => { readyCompleted = true; return result; });
  try {
    await settleAsyncWork();
    assert.equal(mock.data.settings.globalEnabled, true, "pause is still waiting for CSS removal");
    assert.equal(readyCompleted, false, "frame reconciliation waits for the pending settings transaction");
    assert.equal(mock.calls.cssInsertions.length, 0, "the frame cannot reapply the old enabled styles");
  } finally { releaseRemoval(); }
  const [paused, frame] = await Promise.all([pause, ready]);
  assert.equal(paused.settings.globalEnabled, false);
  assert.equal(frame.topLevelEnabled, false);
  assert.equal(mock.calls.cssInsertions.length, 0, "paused frame reconciliation only removes CSS");
});

test("failed settings persistence restores network and conditional CSS", async () => {
  const mock = await loadWorker({ tabs: [{ id: 7, url: "https://example.org/" }] });
  const store = mock.chrome.storage.local.set;
  let failOnce = true;
  mock.chrome.storage.local.set = async (values) => {
    if (failOnce && values.settings) { failOnce = false; throw new Error("Settings storage failed"); }
    await store(values);
  };
  mock.calls.cssInsertions.length = 0;
  const result = await mock.message({ type: "settings:update", patch: { globalEnabled: false } });
  assert.equal(result.ok, false);
  assert.equal(mock.data.settings.globalEnabled, true);
  assert.equal(mock.enabledRulesets.has("privacy_strict"), true);
  const restoredFiles = mock.calls.cssInsertions.flatMap((entry) => entry.files);
  assert.equal(restoredFiles.includes("content/protection.css"), true);
  assert.equal(restoredFiles.includes("content/strict.css"), true);
  const recovered = await mock.message({ type: "settings:update", patch: { globalEnabled: false } });
  assert.equal(recovered.settings.globalEnabled, false);
});

test("concurrent settings patches serialize without losing disjoint changes", async () => {
  const mock = await loadWorker();
  await Promise.all([
    mock.message({ type: "settings:update", patch: { level: "relaxed" } }),
    mock.message({ type: "settings:update", patch: { globalEnabled: false } })
  ]);

  assert.equal(mock.data.settings.level, "relaxed");
  assert.equal(mock.data.settings.globalEnabled, false);
  assert.deepEqual([...mock.enabledRulesets], []);
});

test("worker restart removes expired and tab-stale redirect allows while retaining live records", async () => {
  const now = Date.now();
  const makeRule = (id, tabId) => ({
    id,
    priority: 30000,
    action: { type: "allow" },
    condition: { urlFilter: "|https://target.example/|", tabIds: [tabId], resourceTypes: ["main_frame"] }
  });
  const mock = await evaluateWorker({
    tabs: [
      { id: 1, url: "https://live.example/" },
      { id: 2, url: "https://expired.example/" }
    ],
    initialSessionRules: [
      { id: 77, priority: 1, action: { type: "allow" }, condition: { tabIds: [99] } },
      makeRule(900001, 1),
      makeRule(900002, 2),
      makeRule(900003, 3),
      makeRule(900004, 1)
    ],
    initialSessionData: {
      redirectAllowRecords: [
        { ruleId: 900001, tabId: 1, expiresAt: now + 60000 },
        { ruleId: 900002, tabId: 2, expiresAt: now - 1 },
        { ruleId: 900003, tabId: 3, expiresAt: now + 60000 }
      ]
    }
  });

  assert.deepEqual(mock.getSessionRules().map((rule) => rule.id).sort((a, b) => a - b), [77, 900001]);
  assert.deepEqual(mock.sessionData.redirectAllowRecords, [
    { ruleId: 900001, tabId: 1, expiresAt: now + 60000 }
  ]);

  await mock.chrome.tabs.onRemoved.emit(1);
  assert.deepEqual(mock.getSessionRules().map((rule) => rule.id), [77]);
  assert.deepEqual(mock.sessionData.redirectAllowRecords, []);
});

test("strict settings synchronize static and dynamic network rules", async () => {
  const mock = await loadWorker();
  const response = await mock.message({
    type: "settings:update",
    patch: {
      level: "strict",
      disabledSites: ["https://www.Example.com/path"],
      customBlockDomains: ["ads.example.net"]
    }
  });

  assert.equal(response.settings.level, "strict");
  assert.deepEqual(Array.from(response.settings.disabledSites), ["example.com"]);
  assert.equal(mock.enabledRulesets.has("privacy_strict"), true);
  const rules = mock.getDynamicRules();
  assert.equal(rules.length, 3);
  assert.equal(rules[0].action.type, "allowAllRequests");
  assert.equal(rules[1].action.type, "allow");
  assert.equal(rules[2].action.type, "block");
  assert.deepEqual(Array.from(rules[2].condition.requestDomains), ["ads.example.net"]);
});

test("site toggle and hidden-element statistics round-trip through messages", async () => {
  const mock = await loadWorker();
  const siteResponse = await mock.message({ type: "site:setEnabled", hostname: "news.example.org", enabled: false });
  assert.deepEqual(Array.from(siteResponse.settings.disabledSites), ["news.example.org"]);

  await mock.message(
    { type: "content:blocked", hostname: "news.example.org", count: 3, pageTotal: 3 },
    { tab: { id: 42 } }
  );
  const state = await mock.message({ type: "popup:getState" });
  assert.equal(state.stats.totalHidden, 3);
  assert.equal(state.stats.todayHidden, 3);
  assert.equal(state.stats.sites["news.example.org"], 3);
  assert.equal(mock.calls.badges.at(-1).text, "3");

  const reset = await mock.message({ type: "stats:reset" });
  assert.equal(reset.stats.totalHidden, 0);
});

test("redirect blocks are counted and allow-once creates a tab-scoped session rule", async () => {
  const mock = await loadWorker();
  await mock.message({
    type: "content:redirectBlocked",
    hostname: "publisher.example",
    targetHostname: "doubleclick.net"
  }, { tab: { id: 42 } });

  const state = await mock.message({ type: "popup:getState" });
  assert.equal(state.stats.totalRedirects, 1);
  assert.equal(state.stats.todayRedirects, 1);
  assert.equal(state.stats.redirectSites["publisher.example"], 1);

  const response = await mock.message({
    type: "redirect:allowOnce",
    url: "https://doubleclick.net/offer#creative"
  }, { tab: { id: 42 } });
  assert.equal(response.ok, true);
  const [rule] = mock.getSessionRules();
  assert.equal(rule.action.type, "allow");
  assert.deepEqual(Array.from(rule.condition.tabIds), [42]);
  assert.equal(rule.condition.urlFilter, "|https://doubleclick.net/offer|");
  assert.equal(mock.sessionData.redirectAllowRecords.length, 1);
  assert.equal(mock.sessionData.redirectAllowRecords[0].tabId, 42);
  assert.equal(mock.sessionData.redirectAllowRecords[0].ruleId, rule.id);
});

test("dynamic reputation requires corroboration and resists duplicate and protected-domain poisoning", async () => {
  const mock = await loadWorker({ initialData: { settings: { dynamicFiltering: true } } });
  const firstSender = { tab: { id: 41, url: "https://stream-one.example/watch" } };
  const secondSender = { tab: { id: 42, url: "https://stream-two.example/watch" } };

  const first = await mock.message({
    type: "content:reputationSignal",
    targetHostname: "rotating-ad-host.example",
    evidence: "classified-ad"
  }, firstSender);
  assert.equal(first.accepted, true);
  assert.equal(first.promoted, false);

  const duplicate = await mock.message({
    type: "content:reputationSignal",
    targetHostname: "rotating-ad-host.example",
    evidence: "classified-ad"
  }, firstSender);
  assert.equal(duplicate.accepted, false);
  assert.equal(mock.getDynamicRules().some((rule) => rule.id === 300000), false);

  const protectedResult = await mock.message({
    type: "content:reputationSignal",
    targetHostname: "accounts.google.com",
    evidence: "blocked-navigation"
  }, secondSender);
  assert.equal(protectedResult.accepted, false);

  const corroborated = await mock.message({
    type: "content:reputationSignal",
    targetHostname: "rotating-ad-host.example",
    evidence: "classified-ad"
  }, secondSender);
  assert.equal(corroborated.accepted, true);
  assert.equal(corroborated.promoted, true);
  const learnedRule = mock.getDynamicRules().find((rule) => rule.id === 300000);
  assert.deepEqual(Array.from(learnedRule.condition.requestDomains), ["rotating-ad-host.example"]);
  assert.equal(learnedRule.condition.resourceTypes.includes("main_frame"), false);
  assert.equal(mock.data.dynamicReputation.entries["rotating-ad-host.example"].sources.length, 2);
});

test("dynamic filtering can be disabled without deleting local reputation evidence", async () => {
  const now = Date.now();
  const mock = await evaluateWorker({
    initialData: {
      settings: { level: "strict", dynamicFiltering: true },
      dynamicReputation: {
        version: 1,
        entries: {
          "learned.example": {
            score: 8,
            sources: ["source-a", "source-b"],
            evidenceKeys: ["source-a:classified-ad", "source-b:classified-ad"],
            lastSeen: now
          }
        }
      }
    }
  });
  assert.equal(mock.getDynamicRules().some((rule) => rule.id === 300000), true);

  const response = await mock.message({ type: "settings:update", patch: { dynamicFiltering: false } });
  assert.equal(response.settings.dynamicFiltering, false);
  assert.equal(mock.getDynamicRules().some((rule) => rule.id === 300000), false);
  assert.equal(Boolean(mock.data.dynamicReputation.entries["learned.example"]), true);

  await mock.message({ type: "settings:update", patch: { dynamicFiltering: true } });
  await mock.message({ type: "reputation:reset" });
  assert.deepEqual(Object.keys(mock.data.dynamicReputation.entries), []);
  assert.equal(mock.getDynamicRules().some((rule) => rule.id === 300000), false);
});
