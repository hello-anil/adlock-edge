import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

async function createGuard(userActive = true, locationOverrides = {}) {
  const listeners = new Map();
  const opened = [];
  const submissions = [];
  const shadowEvents = [];
  const configurationChannel = "testchannel123";
  const document = {
    documentElement: {
      getAttribute(name) { return name === "data-aas-config-channel" ? configurationChannel : null; }
    },
    addEventListener(type, listener) { listeners.set(type, listener); }
  };
  class FakeCustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
      this.target = null;
    }
  }
  class FakeElement {
    attachShadow(init) {
      const root = { host: this, mode: init?.mode || "open" };
      this.shadowRoot = root.mode === "open" ? root : null;
      return root;
    }
    dispatchEvent(event) {
      event.target = this;
      shadowEvents.push(event);
      return true;
    }
  }
  class FakeFormElement {
    constructor(action, target = "") {
      this.action = action;
      this.target = target;
    }
    submit() {
      submissions.push({ method: "submit", action: this.action, target: this.target });
    }
    requestSubmit(submitter) {
      submissions.push({
        method: "requestSubmit",
        action: submitter?.formAction || this.action,
        target: submitter?.formTarget || this.target
      });
    }
  }
  const window = {
    open(url, target, features) {
      opened.push({ url, target, features });
      return { url };
    }
  };
  const domainFilename = path.resolve(import.meta.dirname, "../content/domain-data.js");
  const filename = path.resolve(import.meta.dirname, "../content/navigation-guard.js");
  const context = {
    document,
    window,
    location: {
      href: "https://publisher.example/story",
      hostname: "publisher.example",
      pathname: "/story",
      ...locationOverrides
    },
    navigator: { userActivation: { isActive: userActive } },
    URL,
    Set,
    String,
    Boolean,
    Reflect,
    Element: FakeElement,
    HTMLFormElement: FakeFormElement,
    CustomEvent: FakeCustomEvent
  };
  const [domainSource, source] = await Promise.all([
    readFile(domainFilename, "utf8"),
    readFile(filename, "utf8")
  ]);
  vm.runInNewContext(domainSource, context, { filename: domainFilename });
  vm.runInNewContext(source, context, { filename });

  return {
    window,
    opened,
    submissions,
    shadowEvents,
    context,
    createHost: () => new FakeElement(),
    createForm: (action, target) => new FakeFormElement(action, target),
    reinject() { vm.runInNewContext(source, context, { filename }); },
    expectPopup(url, options = {}) {
      const type = options.type || "pointerdown";
      listeners.get(type)?.({
        type,
        isTrusted: options.isTrusted ?? true,
        button: options.button ?? 0,
        key: options.key,
        repeat: options.repeat ?? false,
        composedPath: () => [{ tagName: "A", href: url }]
      });
    },
    configure(enabled) {
      listeners.get(`aas:config:${configurationChannel}`)({
        detail: { enabled, redirectProtection: enabled }
      });
    },
    forgeFixedConfiguration(enabled) {
      const listener = listeners.get("aas:redirect-config");
      listener?.({ detail: { enabled, redirectProtection: enabled } });
      return Boolean(listener);
    }
  };
}

test("main-world popup guard fails closed before extension settings arrive", async () => {
  const guard = await createGuard();
  const popup = guard.window.open("https://doubleclick.net/offer", "_blank");
  assert.equal(popup, null);
  assert.equal(guard.opened.length, 0);
});

test("fixed-name page events cannot forge popup-guard configuration", async () => {
  const guard = await createGuard();
  assert.equal(guard.forgeFixedConfiguration(false), false);
  assert.equal(guard.window.open("https://doubleclick.net/offer", "_blank"), null);
});

test("popup guard does not publish universal ad API globals", async () => {
  const guard = await createGuard();
  assert.equal("canRunAds" in guard.context, false);
  assert.equal("google_ad_status" in guard.context, false);
  assert.equal("adsbygoogle" in guard.context, false);
});

test("main-world popup guard is idempotent when the extension reinjects it", async () => {
  const guard = await createGuard();
  const firstGuard = guard.window.open;
  guard.reinject();
  assert.equal(guard.window.open, firstGuard);
  guard.expectPopup("https://example.com/help");
  assert.notEqual(guard.window.open("https://example.com/help", "_blank"), null);
  assert.equal(guard.opened.length, 1);
});

test("main-world hook announces only real open shadow roots and remains idempotent", async () => {
  const guard = await createGuard();
  const prototype = guard.context.Element.prototype;
  const firstHook = prototype.attachShadow;
  assert.equal(firstHook.__adLockShadowGuardVersion, guard.window.open.__adLockGuardVersion);
  assert.equal(typeof firstHook.__adLockNativeAttachShadow, "function");

  const host = guard.createHost();
  const closedRoot = host.attachShadow({ mode: "closed" });
  assert.equal(closedRoot.mode, "closed");
  assert.equal(guard.shadowEvents.length, 0);

  const openRoot = host.attachShadow({ mode: "open" });
  assert.equal(openRoot.mode, "open");
  assert.equal(guard.shadowEvents.length, 1);
  assert.equal(guard.shadowEvents[0].type, "aas:open-shadow-root");
  assert.equal(guard.shadowEvents[0].target, host);
  assert.equal(guard.shadowEvents[0].detail, undefined);

  guard.reinject();
  assert.equal(prototype.attachShadow, firstHook);
});

test("main-world popup guard rejects known and nested ad destinations", async () => {
  const guard = await createGuard();
  guard.configure(true);
  const recursivelyNested = `https://publisher.example/out?url=${encodeURIComponent(
    `https://publisher.example/go?url=${encodeURIComponent(
      `https://publisher.example/redirect?url=${encodeURIComponent("https://adsrvr.org/creative")}`
    )}`
  )}`;
  assert.equal(guard.window.open("https://doubleclick.net/offer", "_blank"), null);
  assert.equal(guard.window.open("https://mgid.com/native", "_blank"), null);
  assert.equal(guard.window.open("https://popads.net/campaign", "_blank"), null);
  assert.equal(guard.window.open("https://publisher.example/out?url=https%3A%2F%2Fadsrvr.org%2Fcreative", "_blank"), null);
  assert.equal(guard.window.open(recursivelyNested, "_blank"), null);
  assert.equal(guard.opened.length, 0);
});

test("main-world nested destination inspection stops after three levels", async () => {
  const guard = await createGuard(false);
  const wrap = (path, destination) =>
    `https://publisher.example/${path}?url=${encodeURIComponent(destination)}`;
  const beyondDepthBudget = wrap("out", wrap("go", wrap("redirect", wrap("track", "https://doubleclick.net/offer"))));

  assert.notEqual(guard.window.open(beyondDepthBudget, "_blank"), null);
  assert.equal(guard.opened.length, 1);
});

test("ordinary destinations remain allowed and settings can pause and resume the guard", async () => {
  const guard = await createGuard();
  guard.configure(true);
  guard.expectPopup("https://example.com/help");
  assert.notEqual(guard.window.open("https://example.com/help", "_blank"), null);
  guard.configure(false);
  assert.notEqual(guard.window.open("https://doubleclick.net/offer", "_blank"), null);
  guard.configure(true);
  assert.equal(guard.window.open("https://doubleclick.net/offer", "_blank"), null);
  assert.equal(guard.opened.length, 2);
});

test("universal click-under guard allows expected links and protected auth flows", async () => {
  const guard = await createGuard(true);
  guard.expectPopup("https://docs.example.net/guide");
  assert.notEqual(guard.window.open("https://docs.example.net/guide", "_blank"), null);
  assert.notEqual(guard.window.open("https://accounts.google.com/o/oauth2/authorize", "_blank"), null);
  assert.equal(guard.window.open("https://unknown-ad-destination.example/offer", "_blank"), null);
});

test("main-world popup guard rejects unsolicited unknown external popups", async () => {
  const guard = await createGuard(false);
  guard.configure(true);
  assert.equal(guard.window.open("https://unknown-ad-destination.example/offer", "_blank"), null);
  assert.equal(guard.opened.length, 0);
});

test("unsolicited blank and opaque popups cannot navigate around destination checks", async () => {
  const guard = await createGuard(false);
  guard.configure(true);
  assert.equal(guard.window.open("", "_blank"), null);
  assert.equal(guard.window.open("about:blank", "_blank"), null);
  assert.equal(guard.window.open("javascript:void(0)", "_blank"), null);
  assert.equal(guard.opened.length, 0);
});

test("a real user activation cannot disguise an advertising popup as a blank window", async () => {
  const guard = await createGuard(true);
  guard.configure(true);
  assert.equal(guard.window.open("about:blank", "_blank"), null);
  assert.equal(guard.opened.length, 0);
});

test("protected authentication contexts retain blank handoff compatibility", async () => {
  const guard = await createGuard(true, {
    href: "https://accounts.google.com/o/oauth2/authorize",
    hostname: "accounts.google.com",
    pathname: "/o/oauth2/authorize"
  });
  guard.configure(true);
  assert.notEqual(guard.window.open("about:blank", "oauth-popup"), null);
  assert.equal(guard.opened.length, 1);
});

test("direct form submission APIs cannot create advertising or unknown external popup tabs", async () => {
  const guard = await createGuard(true);
  guard.configure(true);
  guard.createForm("https://popads.net/campaign", "_blank").submit();
  guard.createForm("https://unknown-ad-destination.example/offer", "ad-window").submit();
  guard.createForm("https://publisher.example/search", "_blank").submit();
  guard.createForm("https://accounts.google.com/o/oauth2/authorize", "oauth-popup").submit();
  assert.deepEqual(guard.submissions, [
    { method: "submit", action: "https://publisher.example/search", target: "_blank" },
    { method: "submit", action: "https://accounts.google.com/o/oauth2/authorize", target: "oauth-popup" }
  ]);
});

test("requestSubmit checks submit-button action and target overrides", async () => {
  const guard = await createGuard(true);
  guard.configure(true);
  const form = guard.createForm("https://publisher.example/search", "_self");
  form.requestSubmit({ formAction: "https://popads.net/campaign", formTarget: "_blank" });
  form.requestSubmit({ formAction: "https://publisher.example/search", formTarget: "_self" });
  assert.deepEqual(guard.submissions, [
    { method: "requestSubmit", action: "https://publisher.example/search", target: "_self" }
  ]);
});

test("only exact one-shot trusted actions and provider hosts bypass delayed-popup blocking", async () => {
  const guard = await createGuard(false);
  guard.configure(true);
  guard.expectPopup("https://docs.example.net/guide");
  assert.notEqual(guard.window.open("https://docs.example.net/guide", "_blank"), null);
  assert.equal(guard.window.open("https://docs.example.net/guide", "_blank"), null);
  assert.notEqual(guard.window.open("https://accounts.google.com/o/oauth2/authorize", "_blank"), null);
  assert.equal(guard.window.open("https://support.example.net/help/ticket", "_blank"), null);
  assert.equal(guard.opened.length, 2);
});

test("expected popup matching uses the exact URL rather than a reusable hostname", async () => {
  const guard = await createGuard(false);
  guard.configure(true);
  guard.expectPopup("https://docs.example.net/guide");
  assert.equal(guard.window.open("https://docs.example.net/other", "_blank"), null);
  assert.notEqual(guard.window.open("https://docs.example.net/guide", "_blank"), null);
  assert.equal(guard.opened.length, 1);
});

test("synthetic, non-primary, and non-Enter events cannot authorize a popup", async () => {
  const guard = await createGuard(false);
  guard.configure(true);
  const destination = "https://docs.example.net/guide";

  guard.expectPopup(destination, { isTrusted: false });
  assert.equal(guard.window.open(destination, "_blank"), null);
  guard.expectPopup(destination, { button: 1 });
  assert.equal(guard.window.open(destination, "_blank"), null);
  guard.expectPopup(destination, { type: "keydown", key: " " });
  assert.equal(guard.window.open(destination, "_blank"), null);
  guard.expectPopup(destination, { type: "keydown", key: "Enter" });
  assert.notEqual(guard.window.open(destination, "_blank"), null);
  assert.equal(guard.opened.length, 1);
});
