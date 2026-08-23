import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const require = createRequire(import.meta.url);
require("../content/domain-data.js");
const realEngine = require("../content/engine.js");

class ChromeEvent {
  listeners = [];
  addListener(listener) { this.listeners.push(listener); }
}

class FakeStyle {
  #owner;
  #values = new Map();

  constructor(owner) {
    this.#owner = owner;
  }

  get position() { return this.getPropertyValue("position"); }
  get overflow() { return this.getPropertyValue("overflow"); }
  get backgroundImage() { return this.getPropertyValue("background-image"); }

  getPropertyValue(property) {
    return this.#values.get(property)?.value || "";
  }

  getPropertyPriority(property) {
    return this.#values.get(property)?.priority || "";
  }

  setProperty(property, value, priority = "") {
    const next = { value: String(value), priority: String(priority) };
    const previous = this.#values.get(property);
    if (previous?.value === next.value && previous?.priority === next.priority) return;
    this.#values.set(property, next);
    this.#owner._notifyAttribute("style");
  }

  removeProperty(property) {
    if (!this.#values.delete(property)) return "";
    this.#owner._notifyAttribute("style");
    return "";
  }
}

class FakeElement {
  constructor(document, tagName = "div", { className = "", id = "", text = "", rect = {} } = {}) {
    this.ownerDocument = document;
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.childNodes = [];
    this.parentElement = null;
    this.parentNode = null;
    this.isConnected = false;
    this.textContent = text;
    this.rect = { width: 0, height: 0, ...rect };
    this.style = new FakeStyle(this);
    if (className) this.attributes.set("class", className);
    if (id) this.attributes.set("id", id);
    this.classList = {
      add: (...tokens) => {
        const next = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...tokens])];
        this.setAttribute("class", next.join(" "));
      },
      remove: (...tokens) => {
        const remaining = this.className.split(/\s+/).filter(Boolean).filter((token) => !tokens.includes(token));
        this.setAttribute("class", remaining.join(" "));
      }
    };
  }

  get id() { return this.getAttribute("id") || ""; }
  get className() { return this.getAttribute("class") || ""; }
  set className(value) { this.setAttribute("class", value); }
  get href() { return this.getAttribute("href") || ""; }
  get action() { return this.getAttribute("action") || ""; }
  get target() { return this.getAttribute("target") || ""; }

  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }

  setAttribute(name, value) {
    const next = String(value);
    if (this.attributes.get(name) === next) return;
    this.attributes.set(name, next);
    this._notifyAttribute(name);
  }

  removeAttribute(name) {
    if (this.attributes.delete(name)) this._notifyAttribute(name);
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  appendChild(node) {
    node.parentElement = this.nodeType === 1 ? this : null;
    node.parentNode = this;
    this.children.push(node);
    this.childNodes.push(node);
    node._setConnected(this.isConnected);
    this.ownerDocument._notify({ type: "childList", target: this, addedNodes: [node] });
    return node;
  }

  insertBefore(node) { return this.appendChild(node); }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement.childNodes = this.parentElement.childNodes.filter((child) => child !== this);
    this.parentElement = null;
    this.parentNode = null;
    this._setConnected(false);
  }

  _setConnected(connected) {
    this.isConnected = connected;
    for (const child of this.children) child._setConnected(connected);
    this.shadowRoot?._setConnected(connected);
  }

  attachShadow(init = { mode: "open" }) {
    const root = new FakeShadowRoot(this.ownerDocument, this, init.mode || "open");
    root._setConnected(this.isConnected);
    this.shadowRoot = root.mode === "open" ? root : null;
    return root;
  }

  getRootNode() {
    let current = this;
    while (current.parentNode) current = current.parentNode;
    return current;
  }

  _notifyAttribute(attributeName) {
    if (this.isConnected) {
      this.ownerDocument._notify({ type: "attributes", target: this, attributeName });
    }
  }

  getBoundingClientRect() { return this.rect; }

  matches(selector) {
    return String(selector).split(",").some((part) => this.#matchesPart(part.trim()));
  }

  #matchesPart(selector) {
    if (!selector) return false;
    if (selector === "*") return true;
    if (/^[a-z]+$/i.test(selector)) return this.tagName === selector.toUpperCase();
    if (selector === ".aas-placeholder") return this.className.split(/\s+/).includes("aas-placeholder");
    if (/^\.[\w-]+$/.test(selector)) return this.className.split(/\s+/).includes(selector.slice(1));
    if (selector === "[role='dialog']") return this.getAttribute("role") === "dialog";
    if (selector === "[aria-modal='true']") return this.getAttribute("aria-modal") === "true";
    if (selector === "[data-test-candidate]") return this.hasAttribute("data-test-candidate");

    const contains = selector.match(/^\[(class|id)\*=['\"]([^'\"]+)['\"] i\]$/i);
    if (contains) return String(this.getAttribute(contains[1]) || "").toLowerCase().includes(contains[2].toLowerCase());
    if (/^\[style\*=/.test(selector)) {
      return this.style.getPropertyValue("position").replace(/\s+/g, "").toLowerCase() === "fixed";
    }
    return false;
  }

  closest(selector) {
    for (let current = this; current; current = current.parentElement) {
      if (current.matches(selector)) return current;
    }
    return null;
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (element) => {
      for (const child of element.children) {
        if (child.matches(selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  addEventListener() {}
  set type(_value) {}
  set title(_value) {}
  set disabled(_value) {}
}

class FakeShadowRoot {
  constructor(document, host, mode = "open") {
    this.ownerDocument = document;
    this.nodeType = 11;
    this.mode = mode;
    this.host = host;
    this.children = [];
    this.childNodes = [];
    this.parentElement = null;
    this.parentNode = null;
    this.isConnected = false;
  }

  appendChild(node) {
    node.parentElement = null;
    node.parentNode = this;
    this.children.push(node);
    this.childNodes.push(node);
    node._setConnected(this.isConnected);
    this.ownerDocument._notify({ type: "childList", target: this, addedNodes: [node] });
    return node;
  }

  _setConnected(connected) {
    this.isConnected = connected;
    for (const child of this.children) child._setConnected(connected);
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (parent) => {
      for (const child of parent.children) {
        if (child.matches(selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }
}

class FakeDocument {
  #observers = new Set();

  constructor() {
    this.listeners = new Map();
    this.documentElement = new FakeElement(this, "html");
    this.body = new FakeElement(this, "body");
    this.documentElement.isConnected = true;
    this.documentElement.appendChild(this.body);
  }

  createElement(tagName) { return new FakeElement(this, tagName); }
  querySelector(selector) { return this.documentElement.querySelector(selector); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type) { this.listeners.delete(type); }
  dispatchEvent() { return true; }

  _addObserver(observer) {
    this.#observers.add(observer);
  }

  _notify(record) {
    for (const observer of this.#observers) observer._notify(record);
  }
}

async function loadContentHarness() {
  const document = new FakeDocument();
  const messages = [];
  let ready;
  const readyPromise = new Promise((resolve) => { ready = resolve; });

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.active = false;
      this.target = null;
      this.records = [];
      this.scheduled = false;
    }
    observe(target) {
      this.active = true;
      this.target = target;
      document._addObserver(this);
    }
    disconnect() { this.active = false; }
    _contains(target) {
      for (let current = target; current; current = current.parentNode) {
        if (current === this.target) return true;
      }
      return false;
    }
    _notify(record) {
      if (!this.active || !this._contains(record.target)) return;
      this.records.push(record);
      if (this.scheduled) return;
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        const records = this.records.splice(0);
        if (records.length && this.active) this.callback(records);
      });
    }
  }

  const engine = {
    ...realEngine,
    CANDIDATE_SELECTOR: "[data-test-candidate]",
    classify: () => ({ blocked: false, container: null, signals: [] }),
    hasMarkerText: () => false,
    isLikelyAdblockBait: () => false,
    isKnownAdUrl: () => false
  };
  const runtimeBridge = {
    isAvailable: () => true,
    async getLocal() {
      return {
        settings: {
          globalEnabled: true,
          level: "balanced",
          disabledSites: [],
          customBlockDomains: [],
          customSelectors: [],
          showPlaceholders: false,
          redirectProtection: true,
          antiAdblockCompatibility: true
        }
      };
    },
    async sendMessage(_chrome, message) {
      messages.push(message);
      if (message.type === "content:ready") ready();
      return { ok: true };
    }
  };
  const chrome = {
    runtime: { onMessage: new ChromeEvent() },
    storage: { onChanged: new ChromeEvent() }
  };

  const filename = path.resolve(import.meta.dirname, "../content/content.js");
  const source = await readFile(filename, "utf8");
  const harnessSetTimeout = (callback, delay, ...args) => {
    const timer = setTimeout(callback, delay, ...args);
    if (delay >= 10000) timer.unref?.();
    return timer;
  };
  vm.runInNewContext(source, {
    AdaptiveAdEngine: engine,
    AdLockRuntimeBridge: runtimeBridge,
    chrome,
    document,
    location: {
      href: "https://net77.cc/watch/example",
      hostname: "net77.cc",
      pathname: "/watch/example",
      assign() {}
    },
    Node: { ELEMENT_NODE: 1 },
    NodeFilter: { SHOW_ELEMENT: 1 },
    ShadowRoot: FakeShadowRoot,
    MutationObserver: FakeMutationObserver,
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init?.detail; }
    },
    getComputedStyle: (element) => ({
      position: element.style.getPropertyValue("position"),
      backgroundImage: element.style.getPropertyValue("background-image")
    }),
    innerWidth: 940,
    innerHeight: 410,
    requestIdleCallback: (callback) => queueMicrotask(() => callback({ timeRemaining: () => 50 })),
    setTimeout: harnessSetTimeout,
    clearTimeout,
    queueMicrotask,
    URL,
    console
  }, { filename });

  await readyPromise;
  return {
    document,
    messages,
    createSurface(options) { return new FakeElement(document, "div", options); },
    createElement(tagName, attributes = {}, text = "") {
      const element = new FakeElement(document, tagName, { text });
      for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
      return element;
    },
    dispatch(type, path, properties = {}) {
      const state = { prevented: false, stopped: false };
      const event = {
        type,
        button: 0,
        key: "",
        repeat: false,
        target: path.at(-1),
        composedPath: () => path,
        preventDefault() { state.prevented = true; },
        stopImmediatePropagation() { state.stopped = true; },
        ...properties
      };
      document.listeners.get(type)?.(event);
      return state;
    },
    append(element) { document.body.appendChild(element); }
  };
}

async function settleMutations(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function assertSuppressed(element, label) {
  assert.equal(element.style.getPropertyValue("display"), "none", `${label} display`);
  assert.equal(element.style.getPropertyPriority("display"), "important", `${label} display priority`);
  assert.equal(element.style.getPropertyValue("visibility"), "hidden", `${label} visibility`);
  assert.equal(element.style.getPropertyPriority("visibility"), "important", `${label} visibility priority`);
  assert.equal(element.style.getPropertyValue("opacity"), "0", `${label} opacity`);
  assert.equal(element.style.getPropertyPriority("opacity"), "important", `${label} opacity priority`);
  assert.equal(element.style.getPropertyValue("pointer-events"), "none", `${label} pointer events`);
  assert.equal(element.style.getPropertyPriority("pointer-events"), "important", `${label} pointer-events priority`);
}

test("dynamically inserted anti-adblock modal and toast stay hidden when site scripts re-show them", async () => {
  const harness = await loadContentHarness();
  harness.document.body.classList.remove("modal-open");
  harness.document.body.setAttribute("class", "modal-open no-scroll overflow-hidden");
  harness.document.body.style.setProperty("overflow", "hidden");

  const modal = harness.createSurface({
    className: "hhhhppp popup",
    text: "AdBlock detected. Disable your ad blocker to continue.",
    rect: { width: 700, height: 260 }
  });
  modal.style.setProperty("position", "fixed");
  modal.style.setProperty("display", "flex", "important");

  const toast = harness.createSurface({
    text: "AdBlock / DNS Blocking detected. Please disable to continue.",
    rect: { width: 620, height: 60 }
  });
  toast.style.setProperty("position", "fixed");
  toast.style.setProperty("bottom", "20px");
  toast.style.setProperty("z-index", "9999");

  harness.append(modal);
  harness.append(toast);
  await settleMutations();

  assertSuppressed(modal, "dynamic modal");
  assertSuppressed(toast, "dynamic toast");
  assert.equal(harness.document.body.className, "");
  assert.notEqual(harness.document.body.style.getPropertyValue("overflow"), "hidden");

  for (const surface of [modal, toast]) {
    surface.style.setProperty("display", "flex", "important");
    surface.style.setProperty("visibility", "visible", "important");
    surface.style.setProperty("opacity", "1", "important");
    surface.style.setProperty("pointer-events", "auto", "important");
  }
  await settleMutations();

  assertSuppressed(modal, "re-shown modal");
  assertSuppressed(toast, "re-shown toast");
});

test("obfuscated fixed missed-call promotions are hidden without relying on ad-like classes", async () => {
  const harness = await loadContentHarness();
  const promotion = harness.createSurface({
    className: "x7k2",
    text: "(3) missed video calls Elina has something to show to you",
    rect: { width: 490, height: 140 }
  });
  promotion.style.setProperty("position", "fixed");
  promotion.style.setProperty("right", "20px");
  promotion.style.setProperty("z-index", "999999");

  harness.append(promotion);
  await settleMutations();

  assertSuppressed(promotion, "missed-call promotion");
});

test("ordinary missed-call text in page content is preserved", async () => {
  const harness = await loadContentHarness();
  const article = harness.createSurface({
    className: "article-copy",
    text: "I missed video calls while traveling yesterday.",
    rect: { width: 700, height: 100 }
  });

  harness.append(article);
  await settleMutations();

  assert.notEqual(article.style.getPropertyValue("visibility"), "hidden");
});

test("full-screen sharing and bookmark promotions do not cover media controls", async () => {
  const harness = await loadContentHarness();
  const promotion = harness.createSurface({
    className: "fixed inset-0 z-[9999]",
    text: "Sharing is Caring. Help us grow by sharing with your friends! Bookmark vidbox.xyz to stay updated. Join Discord. Join Telegram. Share this Site.",
    rect: { width: 940, height: 410 }
  });
  promotion.style.setProperty("position", "fixed");
  promotion.style.setProperty("display", "flex", "important");

  harness.append(promotion);
  await settleMutations();

  assertSuppressed(promotion, "blocking sharing promotion");
});

test("ordinary in-page sharing text is preserved", async () => {
  const harness = await loadContentHarness();
  const article = harness.createSurface({
    className: "article-callout",
    text: "Sharing is caring, so share this site with friends and join our Discord discussion.",
    rect: { width: 700, height: 100 }
  });

  harness.append(article);
  await settleMutations();

  assert.notEqual(article.style.getPropertyValue("visibility"), "hidden");
});

test("keyboard navigation cannot bypass a same-site advertising redirect wrapper", async () => {
  const harness = await loadContentHarness();
  const destination = `https://net77.cc/out?url=${encodeURIComponent("https://doubleclick.net/offer")}`;
  const anchor = harness.createElement("a", { href: destination, target: "_blank" }, "Watch");
  harness.append(anchor);

  const event = harness.dispatch("keydown", [anchor], { key: "Enter", target: anchor });
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.ok(harness.messages.some((message) =>
    message.type === "content:redirectBlocked" && message.targetHostname === "net77.cc"
  ));
});

test("form submissions to known advertising destinations are blocked", async () => {
  const harness = await loadContentHarness();
  const form = harness.createElement("form", {
    action: "https://doubleclick.net/offer",
    target: "_blank"
  });
  const submitter = harness.createElement("button", {}, "Continue");
  form.appendChild(submitter);
  harness.append(form);

  const event = harness.dispatch("submit", [submitter, form], { target: form, submitter });
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.ok(harness.messages.some((message) =>
    message.type === "content:redirectBlocked" && message.targetHostname === "doubleclick.net"
  ));
});

test("ordinary same-site Enter navigation remains allowed", async () => {
  const harness = await loadContentHarness();
  const anchor = harness.createElement("a", { href: "https://net77.cc/movies/page-2" }, "Next page");
  harness.append(anchor);

  const event = harness.dispatch("keydown", [anchor], { key: "Enter", target: anchor });
  assert.equal(event.prevented, false);
  assert.equal(event.stopped, false);
});

test("open shadow roots are recursively scanned and observed for reappearing anti-adblock surfaces", async () => {
  const harness = await loadContentHarness();
  const host = harness.createSurface({ className: "player-shell" });
  const shadow = host.attachShadow({ mode: "open" });
  const first = harness.createSurface({
    className: "adblock-overlay",
    text: "AdBlock detected. Please disable your ad blocker to continue.",
    rect: { width: 760, height: 280 }
  });
  first.style.setProperty("position", "fixed");
  shadow.appendChild(first);
  harness.append(host);
  await settleMutations();

  assertSuppressed(first, "initial shadow overlay");

  const replacement = harness.createSurface({
    className: "hhhhppp popup",
    text: "AdBlock / DNS Blocking detected. Please disable to continue.",
    rect: { width: 700, height: 240 }
  });
  replacement.style.setProperty("position", "fixed");
  shadow.appendChild(replacement);
  await settleMutations();

  assertSuppressed(replacement, "dynamic shadow overlay");
  replacement.style.setProperty("display", "flex", "important");
  replacement.style.setProperty("visibility", "visible", "important");
  await settleMutations();
  assertSuppressed(replacement, "re-shown shadow overlay");
});

test("open-shadow announcements register roots attached after their host was scanned", async () => {
  const harness = await loadContentHarness();
  const forgedHost = harness.createElement("div");
  assert.doesNotThrow(() => harness.dispatch("aas:open-shadow-root", [forgedHost]));

  const host = harness.createSurface({ className: "late-player-shell" });
  harness.append(host);
  await settleMutations();

  const shadow = host.attachShadow({ mode: "open" });
  harness.dispatch("aas:open-shadow-root", [host]);
  const overlay = harness.createSurface({
    className: "adblock-overlay",
    text: "AdBlock / DNS Blocking detected. Please disable to continue.",
    rect: { width: 720, height: 250 }
  });
  overlay.style.setProperty("position", "fixed");
  shadow.appendChild(overlay);
  await settleMutations();

  assertSuppressed(overlay, "announced shadow overlay");
});
