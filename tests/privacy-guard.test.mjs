import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

async function createPrivacyGuard(locationOverride = {}) {
  const listeners = new Map();
  const calls = { beacons: [], sockets: [], topics: 0, auctions: 0, registrations: [] };

  class FakeCustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }

  class FakeElement {
    constructor(tagName = "DIV") {
      this.tagName = tagName.toUpperCase();
      this.attributes = new Map();
      this.isConnected = true;
    }
    getAttribute(name) { return this.attributes.get(String(name).toLowerCase()) || null; }
    setAttribute(name, value) { this.attributes.set(String(name).toLowerCase(), String(value)); }
    setAttributeNS(_namespace, name, value) { this.setAttribute(name, value); }
    removeAttribute(name) { this.attributes.delete(String(name).toLowerCase()); }
    querySelectorAll() { return []; }
    getBoundingClientRect() { return { width: 0, height: 0 }; }
  }

  class FakeCanvasContext {
    constructor(canvas) { this.canvas = canvas; }
    drawImage(source) { this.canvas.pixels.set(source.pixels); }
    getImageData() { return { data: new Uint8ClampedArray(this.canvas.pixels) }; }
    putImageData(imageData) { this.canvas.pixels.set(imageData.data); }
  }

  class FakeCanvas extends FakeElement {
    constructor() {
      super("CANVAS");
      this._width = 32;
      this._height = 16;
      this.pixels = new Uint8ClampedArray(this._width * this._height * 4).fill(128);
      this.context = new FakeCanvasContext(this);
    }
    get width() { return this._width; }
    set width(value) {
      this._width = Number(value);
      this.pixels = new Uint8ClampedArray(this._width * this._height * 4).fill(128);
    }
    get height() { return this._height; }
    set height(value) {
      this._height = Number(value);
      this.pixels = new Uint8ClampedArray(this._width * this._height * 4).fill(128);
    }
    getContext() { return this.context; }
    getBoundingClientRect() { return { width: this.width, height: this.height }; }
    toDataURL() { return `data:test,${this.pixels.reduce((sum, value) => sum + value, 0)}`; }
    toBlob(callback) { callback({ size: this.pixels.length }); }
  }

  class FakeDocument {
    constructor() {
      this.documentElement = new FakeElement("HTML");
    }
    addEventListener(type, listener) {
      const values = listeners.get(type) || [];
      values.push(listener);
      listeners.set(type, values);
    }
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event);
      return true;
    }
    createElement(tagName) { return String(tagName).toLowerCase() === "canvas" ? new FakeCanvas() : new FakeElement(tagName); }
    browsingTopics() {
      calls.topics += 1;
      return Promise.resolve([{ topic: 7 }]);
    }
  }

  class FakeNavigator {
    constructor() {
      this.serviceWorker = {
        register: (url) => {
          calls.registrations.push(url);
          return Promise.resolve({ scope: "/" });
        }
      };
      this.userAgentData = new FakeUaData();
    }
    sendBeacon(url) {
      calls.beacons.push(url);
      return true;
    }
    joinAdInterestGroup() { return Promise.resolve("joined"); }
    runAdAuction() {
      calls.auctions += 1;
      return Promise.resolve("https://winner.example/render");
    }
  }

  class FakeUaData {
    getHighEntropyValues() {
      return Promise.resolve({
        architecture: "x86",
        bitness: "64",
        platformVersion: "15.0.0",
        wow64: true,
        fullVersionList: [{ brand: "Browser", version: "131.4.2.1" }],
        mobile: false
      });
    }
  }

  class FakeWebSocket {
    constructor(url) {
      calls.sockets.push(url);
      this.url = url;
    }
  }
  const nativeWebSocketSource = FakeWebSocket.toString();

  class FakeWebGlContext {
    getParameter(parameter) {
      if (parameter === 37445) return "Hardware Vendor";
      if (parameter === 37446) return "Unique GPU Renderer";
      return `native:${parameter}`;
    }
  }

  class FakeAnalyserNode {
    getFloatFrequencyData(array) {
      array.fill(0.5);
    }
    getFloatTimeDomainData(array) {
      array.fill(0.25);
    }
  }

  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() {}
  }

  const document = new FakeDocument();
  const navigator = new FakeNavigator();
  const fakeLocation = {
    href: locationOverride.href || "https://publisher.example/watch",
    hostname: locationOverride.hostname || "publisher.example",
    pathname: locationOverride.pathname || "/watch"
  };
  const fakeHistory = {
    state: null,
    replaceState(state, _title, value) {
      this.state = state;
      const url = new URL(value, fakeLocation.href);
      fakeLocation.href = url.href;
      fakeLocation.hostname = url.hostname;
      fakeLocation.pathname = url.pathname;
    }
  };
  let randomCounter = 1;
  const context = {
    document,
    navigator,
    location: fakeLocation,
    history: fakeHistory,
    AdLockDomainData: {
      advertisingDomains: ["ads.example"],
      strictDomains: ["tracker.example"]
    },
    Document: FakeDocument,
    Navigator: FakeNavigator,
    Element: FakeElement,
    HTMLCanvasElement: FakeCanvas,
    CanvasRenderingContext2D: FakeCanvasContext,
    WebSocket: FakeWebSocket,
    WebGLRenderingContext: FakeWebGlContext,
    AnalyserNode: FakeAnalyserNode,
    MutationObserver: FakeMutationObserver,
    CustomEvent: FakeCustomEvent,
    DOMException,
    URL,
    Uint32Array,
    Uint8ClampedArray,
    Float32Array,
    Set,
    Map,
    Promise,
    Reflect,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Date,
    Math,
    innerWidth: 1280,
    innerHeight: 720,
    crypto: {
      getRandomValues(array) {
        for (let index = 0; index < array.length; index += 1) array[index] = randomCounter++;
        return array;
      }
    }
  };
  const filename = path.resolve(import.meta.dirname, "../content/privacy-guard.js");
  vm.runInNewContext(await readFile(filename, "utf8"), context, { filename });

  function configure(detail) {
    const channel = document.documentElement.getAttribute("data-aas-config-channel");
    assert.match(channel, /^[a-z0-9]+$/);
    document.dispatchEvent(new FakeCustomEvent(`aas:config:${channel}`, { detail }));
  }

  return {
    context, document, navigator, calls, configure, FakeCustomEvent, FakeElement, FakeCanvas,
    nativeWebSocketSource
  };
}

test("privacy capabilities fail open until authenticated configuration and block strict ad-tech calls afterward", async () => {
  const guard = await createPrivacyGuard();
  assert.equal(guard.navigator.sendBeacon("https://tracker.example/pixel"), true);
  assert.deepEqual(await guard.document.browsingTopics(), [{ topic: 7 }]);
  assert.equal(await guard.navigator.runAdAuction({}), "https://winner.example/render");

  guard.document.dispatchEvent(new guard.FakeCustomEvent("aas:privacy-config", {
    detail: { enabled: true, level: "strict", privacyApiProtection: true, fingerprintProtection: true }
  }));
  assert.equal(guard.navigator.sendBeacon("https://tracker.example/pixel"), true, "fixed-name page spoof must be ignored");

  guard.configure({ enabled: true, level: "strict", privacyApiProtection: true, fingerprintProtection: true });
  assert.equal(guard.navigator.sendBeacon("https://tracker.example/pixel"), false);
  assert.deepEqual(Array.from(await guard.document.browsingTopics()), []);
  assert.equal(await guard.navigator.runAdAuction({}), null);
  assert.throws(() => new guard.context.WebSocket("wss://ads.example/socket"), { name: "SecurityError" });
  assert.equal(guard.calls.sockets.length, 0);
  assert.equal(
    vm.runInNewContext("Function.prototype.toString.call(WebSocket)", guard.context),
    guard.nativeWebSocketSource
  );
  assert.equal(Object.getOwnPropertyNames(guard.context.WebSocket).some((name) => /adlock/i.test(name)), false);
  await assert.rejects(
    guard.navigator.serviceWorker.register("https://cdn.example/ad-service-worker.js"),
    { name: "SecurityError" }
  );
});

test("strict fingerprint defenses coarsen readbacks while balanced mode preserves native values", async () => {
  const guard = await createPrivacyGuard();
  const webgl = new guard.context.WebGLRenderingContext();
  const analyser = new guard.context.AnalyserNode();
  const samples = new Float32Array(80);
  const canvas = new guard.FakeCanvas();
  const nativeCanvasReadback = canvas.toDataURL();

  guard.configure({ enabled: true, level: "strict", privacyApiProtection: true, fingerprintProtection: true });
  assert.equal(webgl.getParameter(37445), "Google Inc.");
  assert.equal(webgl.getParameter(37446), "ANGLE (generic renderer)");
  const protectedCanvasReadback = canvas.toDataURL();
  assert.notEqual(protectedCanvasReadback, nativeCanvasReadback);
  assert.equal(canvas.toDataURL(), protectedCanvasReadback, "canvas noise must remain stable within a page");
  assert.equal(canvas.pixels.every((value) => value === 128), true, "visible canvas pixels must not be mutated");
  analyser.getFloatFrequencyData(samples);
  assert.equal(samples.some((value) => value !== 0.5), true);
  const entropy = await guard.navigator.userAgentData.getHighEntropyValues([
    "architecture", "bitness", "platformVersion", "wow64", "fullVersionList"
  ]);
  assert.equal(entropy.architecture, "");
  assert.equal(entropy.bitness, "");
  assert.equal(entropy.wow64, false);
  assert.equal(entropy.fullVersionList[0].version, "131.0.0.0");

  guard.configure({ enabled: true, level: "balanced", privacyApiProtection: true, fingerprintProtection: true });
  assert.equal(webgl.getParameter(37445), "Hardware Vendor");
  assert.equal(canvas.toDataURL(), nativeCanvasReadback);
  const nativeEntropy = await guard.navigator.userAgentData.getHighEntropyValues(["architecture"]);
  assert.equal(nativeEntropy.architecture, "x86");
});

test("attribution attributes are stripped only while privacy protection is active", async () => {
  const guard = await createPrivacyGuard();
  const anchor = new guard.FakeElement("A");
  anchor.setAttribute("ping", "https://tracker.example/ping");
  assert.equal(anchor.getAttribute("ping"), "https://tracker.example/ping");

  guard.configure({ enabled: true, level: "strict", privacyApiProtection: true, fingerprintProtection: false });
  anchor.setAttribute("ping", "https://tracker.example/ping-two");
  anchor.setAttribute("attributionsrc", "https://tracker.example/source");
  assert.equal(anchor.getAttribute("ping"), "https://tracker.example/ping");
  assert.equal(anchor.getAttribute("attributionsrc"), null);

  guard.configure({ enabled: false, level: "strict", privacyApiProtection: true, fingerprintProtection: false });
  anchor.setAttribute("attributionsrc", "https://publisher.example/source");
  assert.equal(anchor.getAttribute("attributionsrc"), "https://publisher.example/source");
});

test("CAPTCHA, authentication, and payment frames retain native privacy-sensitive APIs", async () => {
  const guard = await createPrivacyGuard({
    href: "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/widget",
    hostname: "challenges.cloudflare.com",
    pathname: "/cdn-cgi/challenge-platform/widget"
  });
  guard.configure({ enabled: true, level: "strict", privacyApiProtection: true, fingerprintProtection: true });
  assert.equal(guard.navigator.sendBeacon("https://tracker.example/pixel"), true);
  assert.deepEqual(await guard.document.browsingTopics(), [{ topic: 7 }]);
  const webgl = new guard.context.WebGLRenderingContext();
  assert.equal(webgl.getParameter(37446), "Unique GPU Renderer");
});

test("strict tracking cleanup sanitizes current URLs and activated destinations while preserving other parameters", async () => {
  const guard = await createPrivacyGuard({
    href: "https://publisher.example/watch?id=keep&utm_source=feed&fbclid=opaque",
    hostname: "publisher.example",
    pathname: "/watch"
  });
  guard.configure({
    enabled: true,
    level: "strict",
    cleanTrackingParameters: true,
    privacyApiProtection: true,
    fingerprintProtection: false
  });
  assert.equal(guard.context.location.href, "https://publisher.example/watch?id=keep");

  const anchor = new guard.FakeElement("A");
  anchor.href = "https://destination.example/item?size=large&gclid=click-id&utm_campaign=sale";
  guard.document.dispatchEvent({ type: "click", composedPath: () => [anchor] });
  assert.equal(anchor.href, "https://destination.example/item?size=large");
});
