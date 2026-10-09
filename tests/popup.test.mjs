import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../ui/popup.js", import.meta.url), "utf8");
const initialSettings = { globalEnabled: true, level: "strict", disabledSites: [] };
const stats = { todayHidden: 2, totalRedirects: 0, totalHidden: 2 };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function settle() { for (let i = 0; i < 8; i++) await new Promise(setImmediate); }
function event() { const listeners = []; return { addListener: fn => listeners.push(fn), emit: (...args) => listeners.forEach(fn => fn(...args)) }; }
function element(disabled = false) {
  const attributes = new Map();
  const classes = new Set();
  const listeners = new Map();
  return { textContent: "", value: "strict", disabled,
    classList: { add: name => classes.add(name), remove: name => classes.delete(name),
      contains: name => classes.has(name), toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) },
    getAttribute: name => attributes.get(name), setAttribute: (name, value) => attributes.set(name, value),
    addEventListener: (name, fn) => listeners.set(name, fn),
    click() { if (!this.disabled) listeners.get("click")?.(); },
    change() { listeners.get("change")?.(); }
  };
}
function loadPopup({ content = Promise.resolve({ pageHidden: 2 }), send, startupError = false, preview = false, partialChrome = false } = {}) {
  const ids = ["statusText", "globalToggle", "pageCount", "networkText", "hostname", "siteToggle", "levelSelect", "levelHint", "todayCount", "redirectsCount", "totalCount", "optionsButton", "previewDialog", "previewReset", "previewClose"];
  const elements = Object.fromEntries(ids.map(id => [id, element(["globalToggle", "siteToggle", "levelSelect"].includes(id))]));
  elements.networkText.parentElement = element();
  const shell = element(); const body = element(); body.classList.add("is-loading");
  const changed = event(); const messages = event(); const calls = []; const errors = [];
  let settings = structuredClone(initialSettings); let reloads = 0;
  const snapshot = () => ({ settings: structuredClone(settings), stats, pageHidden: 2,
    networkHealth: { status: settings.globalEnabled ? "active" : "paused" } });
  const chrome = {
    tabs: { query: async () => [{ id: 0, url: "https://example.org/article" }], sendMessage: () => content, reload: () => { reloads++; } },
    runtime: { id: "extension", onMessage: messages, openOptionsPage: async () => {}, sendMessage: async message => {
      calls.push(message.type);
      if (send) return send(message, snapshot);
      if (startupError) throw new Error("Worker unavailable");
      if (message.type === "settings:update") settings = { ...settings, ...message.patch };
      if (message.type === "site:setEnabled") settings.disabledSites = message.enabled ? [] : [message.hostname];
      return snapshot();
    } }, storage: { onChanged: changed }
  };
  const marks = [];
  const previewStorage = new Map();
  const exposedChrome = partialChrome ? { runtime: { id: "preview-host" }, storage: { onChanged: { addListener() { throw new Error("Host API called"); } } } } : preview ? undefined : chrome;
  vm.runInNewContext(source, { chrome: exposedChrome, document: { body, getElementById: id => elements[id], querySelector: () => shell },
    localStorage: { getItem: key => previewStorage.get(key) || null, setItem: (key, value) => previewStorage.set(key, value), removeItem: key => previewStorage.delete(key) },
    URL, Intl, console: { error: error => errors.push(error.message) },
    setTimeout: (fn, delay) => { const timer = setTimeout(fn, delay); timer.unref(); return timer; }, clearTimeout,
    performance: { mark: name => marks.push(name) } });
  return { elements, changed, messages, calls, errors, marks, body, shell, previewStorage,
    get reloads() { return reloads; }, setSettings: next => { settings = next; } };
}

test("verified popup controls become usable even when the page does not answer", async () => {
  const mock = loadPopup({ content: new Promise(() => {}) });
  await settle();
  assert.equal(mock.elements.globalToggle.disabled, false);
  assert.equal(mock.elements.levelSelect.disabled, false);
  assert.equal(mock.elements.statusText.textContent, "Connecting to site...");
  assert.equal(mock.elements.networkText.textContent, "Network filtering active");
  assert.equal(mock.body.classList.contains("is-loading"), false);
  assert.ok(mock.marks.includes("adlock-popup-ready"));
});

test("failed initialization leaves protection controls disabled", async () => {
  const mock = loadPopup({ startupError: true });
  await settle();
  assert.equal(mock.elements.statusText.textContent, "Unable to load protection state");
  for (const id of ["globalToggle", "siteToggle", "levelSelect"]) assert.equal(mock.elements[id].disabled, true);
  assert.equal(mock.elements.optionsButton.disabled, false);
});

test("a failed save rolls back immediate feedback and permits another interaction", async () => {
  const save = deferred();
  const mock = loadPopup({ send: (message, snapshot) => message.type === "settings:update" ? save.promise : snapshot() });
  await settle();
  mock.elements.globalToggle.click();
  assert.equal(mock.elements.globalToggle.getAttribute("aria-pressed"), "false");
  assert.equal(mock.elements.pageCount.textContent, "OFF");
  assert.equal(mock.elements.globalToggle.disabled, true);
  save.resolve({ error: "Rules failed" });
  await settle();
  assert.equal(mock.elements.globalToggle.getAttribute("aria-pressed"), "true");
  assert.equal(mock.elements.pageCount.textContent, "2");
  assert.equal(mock.elements.globalToggle.disabled, false);
  assert.equal(mock.elements.statusText.textContent, "Change could not be saved");
});

test("external settings refresh verified network state without repeating an own save", async () => {
  const mock = loadPopup(); await settle();
  mock.elements.globalToggle.click(); await settle();
  mock.changed.emit({ settings: { newValue: { ...initialSettings, globalEnabled: false } } }, "local");
  await settle();
  assert.equal(mock.elements.networkText.textContent, "Network filtering paused");
  const external = { ...initialSettings, level: "balanced" };
  mock.setSettings(external);
  mock.changed.emit({ settings: { newValue: external } }, "local"); await settle();
  assert.equal(mock.elements.levelSelect.value, "balanced");
  assert.equal(mock.elements.globalToggle.getAttribute("aria-pressed"), "true");
  assert.equal(mock.elements.networkText.textContent, "Network filtering active");
});

test("own storage echoes do not add another verification request during a save", async () => {
  const save = deferred();
  const mock = loadPopup({ send: (message, snapshot) => message.type === "settings:update" ? save.promise : snapshot() });
  await settle();
  const next = { ...initialSettings, globalEnabled: false };
  mock.elements.globalToggle.click();
  mock.changed.emit({ settings: { newValue: next } }, "local");
  save.resolve({ settings: next, networkHealth: { status: "paused" } }); await settle();
  mock.changed.emit({ settings: { newValue: next } }, "local"); await settle();
  assert.deepEqual(mock.calls, ["popup:getState", "settings:update"]);
});

test("an older settings refresh cannot overwrite an in-flight optimistic change", async () => {
  const refresh = deferred(); const save = deferred(); let reads = 0;
  const mock = loadPopup({ send: (message, snapshot) => message.type === "settings:update" ? save.promise
    : ++reads === 2 ? refresh.promise : snapshot() });
  await settle();
  mock.changed.emit({ settings: { newValue: { ...initialSettings, level: "balanced" } } }, "local");
  mock.elements.globalToggle.click();
  refresh.resolve({ settings: initialSettings, stats, pageHidden: 2, networkHealth: { status: "active" } });
  await settle();
  assert.equal(mock.elements.globalToggle.getAttribute("aria-pressed"), "false");
  assert.equal(mock.elements.globalToggle.disabled, true);
  const next = { ...initialSettings, globalEnabled: false };
  mock.setSettings(next);
  save.resolve({ settings: next, networkHealth: { status: "paused" } }); await settle();
  assert.equal(mock.elements.globalToggle.getAttribute("aria-pressed"), "false");
  assert.equal(mock.elements.networkText.textContent, "Network filtering paused");
});

test("live counts include tab zero and ignore other tabs, foreign senders and invalid counts", async () => {
  const mock = loadPopup(); await settle();
  const send = (tabId, pageHidden, id = "extension") => mock.messages.emit({ type: "popup:pageCount", tabId, pageHidden }, { id });
  send(0, 5); assert.equal(mock.elements.pageCount.textContent, "5");
  send(9, 100); send(0, 999, "foreign"); send(0, -1); send(0, NaN);
  assert.equal(mock.elements.pageCount.textContent, "5");
  send(0, 0); assert.equal(mock.elements.pageCount.textContent, "0");
});

test("site switch saves without reloading the user's page", async () => {
  const mock = loadPopup(); await settle(); mock.elements.siteToggle.click(); await settle();
  assert.equal(mock.elements.siteToggle.getAttribute("aria-checked"), "false");
  assert.equal(mock.reloads, 0);
  assert.deepEqual(mock.calls, ["popup:getState", "site:setEnabled"]);
});

test("a delayed initial page reply cannot restore a count reset by navigation", async () => {
  const content = deferred();
  const mock = loadPopup({ content: content.promise }); await settle();
  mock.messages.emit({ type: "popup:pageCount", tabId: 0, pageHidden: 0 }, { id: "extension" });
  content.resolve({ pageHidden: 20 }); await settle();
  assert.equal(mock.elements.pageCount.textContent, "0");
});

test("standalone preview provides working simulated toggles and clearly marks demo data", async () => {
  const mock = loadPopup({ preview: true }); await settle();
  assert.equal(mock.elements.statusText.textContent, "Preview · Strict");
  assert.equal(mock.elements.networkText.textContent, "Demo data · No blocking");
  mock.elements.siteToggle.click(); await settle();
  assert.equal(mock.elements.siteToggle.getAttribute("aria-checked"), "false");
  mock.elements.globalToggle.click(); await settle();
  assert.equal(mock.elements.globalToggle.getAttribute("aria-pressed"), "false");
  assert.equal(mock.elements.levelSelect.disabled, false);
  mock.elements.levelSelect.value = "balanced"; mock.elements.levelSelect.change(); await settle();
  assert.equal(JSON.parse(mock.previewStorage.get("adlock-popup-preview-v1")).level, "balanced");
  assert.equal(mock.elements.networkText.textContent, "Demo data · No blocking");
  assert.deepEqual(mock.calls, []);
  assert.deepEqual(mock.errors, []);
});

test("protection level can be saved while actual global protection remains paused", async () => {
  const mock = loadPopup(); await settle(); mock.elements.globalToggle.click(); await settle();
  assert.equal(mock.elements.levelSelect.disabled, false);
  mock.elements.levelSelect.value = "balanced"; mock.elements.levelSelect.change(); await settle();
  assert.equal(mock.elements.globalToggle.getAttribute("aria-pressed"), "false");
  assert.equal(mock.elements.levelSelect.value, "balanced");
  assert.equal(mock.elements.networkText.textContent, "Network filtering paused");
});

test("a partial Chrome object cannot misclassify a preview or break its initialization", async () => {
  const mock = loadPopup({ partialChrome: true }); await settle();
  assert.equal(mock.elements.globalToggle.disabled, false);
  assert.equal(mock.elements.levelSelect.disabled, false);
  assert.equal(mock.elements.statusText.textContent, "Preview · Strict");
  mock.elements.globalToggle.click(); await settle();
  assert.equal(mock.elements.statusText.textContent, "Preview · Paused");
  assert.deepEqual(mock.calls, []);
  assert.deepEqual(mock.errors, []);
});
