import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import "./content.test.mjs";

const require = createRequire(import.meta.url);
const engine = require("../content/engine.js");

class FakeElement {
  constructor(tagName = "div", attributes = {}, text = "", parent = null, rect = {}) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.attributes = { ...attributes };
    this.textContent = text;
    this.childNodes = text ? [{ nodeType: 3, nodeValue: text }] : [];
    this.children = [];
    this.parentElement = parent;
    this.rect = { width: 0, height: 0, ...rect };
    if (parent) {
      parent.children.push(this);
      parent.textContent = `${parent.textContent || ""} ${text}`.trim();
    }
  }

  getAttribute(name) { return this.attributes[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  getBoundingClientRect() { return this.rect; }
  closest(selector) {
    if (!selector.includes("header") && !selector.includes("nav") && !selector.includes("navigation")) return null;
    let current = this;
    while (current) {
      const tag = current.tagName.toLowerCase();
      if (tag === "header" || tag === "nav" || current.getAttribute("role") === "navigation") return current;
      current = current.parentElement;
    }
    return null;
  }
}

test("matches domains without confusing unrelated suffixes", () => {
  assert.equal(engine.hostnameMatches("cdn.ads.example.com", "ads.example.com"), true);
  assert.equal(engine.hostnameMatches("notexample.com", "example.com"), false);
  assert.equal(engine.hostnameMatches("www.example.com", "example.com"), true);
});

test("recognizes known ad network URLs", () => {
  assert.equal(engine.isKnownAdUrl("https://securepubads.g.doubleclick.net/tag.js"), true);
  assert.equal(engine.isKnownAdUrl("https://cdn.example.com/app.js"), false);
});

test("explicit ad attributes are high-confidence signals", () => {
  const element = new FakeElement("div", { "data-ad-slot": "leaderboard" });
  const result = engine.classify(element, "relaxed");
  assert.ok(result.score >= 9);
  assert.equal(result.blocked, true);
  assert.equal(result.container, element);
});

test("a sponsored label resolves to its feed card", () => {
  const card = new FakeElement("article", { class: "feed-card" });
  const label = new FakeElement("span", {}, "Sponsored", card);
  const result = engine.classify(label, "balanced");
  assert.equal(result.blocked, true);
  assert.equal(result.container, card);
});

test("native and social promotions require explicit promotion metadata", () => {
  const nativeAd = new FakeElement("article", { "data-sponsored": "true" }, "Recommended for you");
  const socialPromo = new FakeElement("aside", { class: "instagram-sponsored-widget" }, "Follow this promoted account");
  const ordinaryShare = new FakeElement("aside", { class: "social-share-widget" }, "Share this story");
  assert.equal(engine.classify(nativeAd, "relaxed").blocked, true);
  assert.equal(engine.classify(socialPromo, "balanced").blocked, true);
  assert.equal(engine.classify(ordinaryShare, "strict").blocked, false);
});

test("ordinary words containing ad-like letters do not trigger blocking", () => {
  const element = new FakeElement("div", { class: "download-badge shadow-header" }, "Download");
  assert.equal(engine.scoreCandidate(element).score, 0);
  assert.equal(engine.classify(element, "strict").blocked, false);
});

test("common dimensions alone are never enough to block", () => {
  const element = new FakeElement("div", {}, "A useful image", null, { width: 300, height: 250 });
  assert.equal(engine.scoreCandidate(element).score, 1);
  assert.equal(engine.classify(element, "strict").blocked, false);
});

test("navigation context reduces weak-signal false positives", () => {
  const nav = new FakeElement("nav");
  const link = new FakeElement("a", { class: "ad" }, "Ad tools", nav);
  assert.ok(engine.scoreCandidate(link).score < engine.LEVEL_THRESHOLDS.strict);
});

test("known advertising destinations are blocked as redirects", () => {
  const result = engine.analyzeNavigation("https://securepubads.g.doubleclick.net/click", {
    baseUrl: "https://publisher.example/story",
    currentHostname: "publisher.example",
    level: "relaxed"
  });
  assert.equal(result.blocked, true);
  assert.ok(result.score >= engine.REDIRECT_THRESHOLDS.relaxed);
});

test("sponsored external redirect wrappers are blocked conservatively", () => {
  const result = engine.analyzeNavigation("https://publisher.example/redirect?url=https%3A%2F%2Fadvertiser.example%2Foffer", {
    baseUrl: "https://publisher.example/story",
    currentHostname: "publisher.example",
    level: "balanced",
    rel: "nofollow sponsored",
    target: "_blank"
  });
  assert.equal(result.blocked, true);
  assert.ok(result.reasons.some((item) => item.reason === "external redirect wrapper"));
});

test("nested redirect analysis reaches advertising destinations through three bounded levels", () => {
  const wrap = (path, destination) =>
    `https://publisher.example/${path}?url=${encodeURIComponent(destination)}`;
  const destination = wrap("out", wrap("go", wrap("redirect", "https://doubleclick.net/offer")));
  const result = engine.analyzeNavigation(destination, {
    baseUrl: "https://publisher.example/story",
    currentHostname: "publisher.example",
    level: "relaxed"
  });
  assert.equal(result.blocked, true);
  assert.ok(result.reasons.some((item) => item.reason === "redirects through an advertising destination"));
});

test("nested redirect analysis stops beyond depth three", () => {
  const wrap = (path, destination) =>
    `https://publisher.example/${path}?url=${encodeURIComponent(destination)}`;
  const destination = wrap("out", wrap("go", wrap("redirect", wrap("track", "https://doubleclick.net/offer"))));
  const result = engine.analyzeNavigation(destination, {
    baseUrl: "https://publisher.example/story",
    currentHostname: "publisher.example",
    level: "strict"
  });
  assert.equal(result.blocked, false);
  assert.equal(result.reasons.some((item) => item.reason === "redirects through an advertising destination"), false);
});

test("nested redirect analysis enforces its URL and character budgets", () => {
  const safeTargets = Array.from({ length: 7 }, (_, index) =>
    `url=${encodeURIComponent(`https://publisher.example/article-${index}`)}`
  );
  const overUrlBudget = `https://publisher.example/article?${[
    ...safeTargets,
    `url=${encodeURIComponent("https://doubleclick.net/offer")}`
  ].join("&")}`;
  const oversized = `https://publisher.example/out?url=${encodeURIComponent(
    `https://doubleclick.net/offer?padding=${"x".repeat(4097)}`
  )}`;

  for (const destination of [overUrlBudget, oversized]) {
    const result = engine.analyzeNavigation(destination, {
      baseUrl: "https://publisher.example/story",
      currentHostname: "publisher.example",
      level: "strict"
    });
    assert.equal(result.blocked, false);
    assert.equal(result.reasons.some((item) => item.reason === "redirects through an advertising destination"), false);
  }
});

test("ordinary login redirects remain allowed even in strict mode", () => {
  const result = engine.analyzeNavigation("https://app.example/redirect?url=https%3A%2F%2Flogin.example.net%2Fcallback", {
    baseUrl: "https://app.example/account",
    currentHostname: "app.example",
    level: "strict"
  });
  assert.equal(result.blocked, false);
});

test("custom blocked domains also apply to redirect destinations", () => {
  const result = engine.analyzeNavigation("https://ads.my-example.test/offer", {
    baseUrl: "https://publisher.example/",
    currentHostname: "publisher.example",
    customBlockDomains: ["ads.my-example.test"],
    level: "balanced"
  });
  assert.equal(result.blocked, true);
});

test("observed ad-tech domains are treated as known destinations", () => {
  assert.equal(engine.isKnownAdUrl("https://cvt-s1.adangle.online/o/s/ad.js"), true);
  assert.equal(engine.isKnownAdUrl("https://484r.com/apu.php?zoneid=1"), true);
  assert.equal(engine.isKnownAdUrl("https://popads.net/campaign/landing"), true);
  assert.equal(engine.isKnownAdUrl("https://ritchie.ydc1wes.me/hls2/video/master.m3u8"), false);
});

test("anti-adblock messages are distinguished from security challenges", () => {
  assert.equal(engine.isAntiAdblockMessage("AdBlock detected. Disable your ad blocker to continue."), true);
  assert.equal(engine.isAntiAdblockMessage("Please whitelist this site because ads are blocked."), true);
  assert.equal(engine.isAntiAdblockMessage("Cloudflare security verification: verify you are human."), false);
  assert.equal(engine.isAntiAdblockMessage("Sign in to continue watching."), false);
});

test("tiny empty ad bait is preserved for compatibility", () => {
  const bait = new FakeElement("div", { class: "adsbox ad-test" }, "", null, { width: 1, height: 1 });
  const realAd = new FakeElement("div", { class: "adsbox" }, "Sponsored offer", null, { width: 300, height: 250 });
  assert.equal(engine.isLikelyAdblockBait(bait), true);
  assert.equal(engine.isLikelyAdblockBait(realAd), false);
});

test("high-confidence overlays and floating promotions are classified", () => {
  const overlay = new FakeElement("section", { class: "ad-overlay", style: "position: fixed; z-index: 9999" });
  const floating = new FakeElement("aside", { class: "floating-promo", style: "position: sticky" });
  assert.equal(engine.classify(overlay, "relaxed").blocked, true);
  assert.equal(engine.classify(floating, "relaxed").blocked, true);
});

test("authentication and security overlays are excluded", () => {
  const login = new FakeElement("section", { class: "login-modal ad-overlay", role: "dialog" }, "Sign in to continue");
  const captcha = new FakeElement("div", { class: "captcha interstitial-ad" }, "Verify that you are human");
  assert.equal(engine.classify(login, "strict").blocked, false);
  assert.equal(engine.classify(captcha, "strict").blocked, false);
});

test("video companion ads and page skins require explicit signals", () => {
  const companion = new FakeElement("aside", { class: "vast-companion" });
  const skin = new FakeElement("div", {
    class: "page-skin-ad",
    style: "background-image: url('https://securepubads.g.doubleclick.net/skin.jpg')"
  });
  const ordinaryBackground = new FakeElement("div", {
    class: "hero-background",
    style: "background-image: url('/images/hero.jpg')"
  });
  const ordinaryCompanion = new FakeElement("aside", { class: "reading-companion" }, "Chapter notes");
  assert.equal(engine.classify(companion, "relaxed").blocked, true);
  assert.equal(engine.classify(skin, "relaxed").blocked, true);
  assert.equal(engine.classify(ordinaryBackground, "strict").blocked, false);
  assert.equal(engine.classify(ordinaryCompanion, "strict").blocked, false);
});

test("tiny tracking resources are detected without hiding ordinary images", () => {
  const pixel = new FakeElement("img", { src: "https://metrics.example/pixel.gif", width: "1", height: "1" });
  const icon = new FakeElement("img", { src: "https://cdn.example/icon.png", width: "1", height: "1" });
  assert.equal(engine.classify(pixel, "relaxed").blocked, true);
  assert.equal(engine.classify(icon, "strict").blocked, false);
});

test("fake play controls need deceptive identifiers or redirect evidence", () => {
  const fake = new FakeElement("a", {
    class: "fake-play-button",
    href: "https://redirect.example/go?to=offer",
    target: "_blank"
  }, "Play now");
  const real = new FakeElement("a", { class: "play-button", href: "https://video.example/movie" }, "Play");
  assert.equal(engine.classify(fake, "relaxed").blocked, true);
  assert.equal(engine.classify(real, "strict").blocked, false);
});

test("strong affiliate destinations and sponsored redirects are blocked", () => {
  const affiliate = engine.analyzeNavigation("https://merchant.example/deal?affiliate_id=publisher-7", {
    baseUrl: "https://publisher.example/story",
    currentHostname: "publisher.example",
    level: "balanced"
  });
  const sponsored = engine.analyzeNavigation("https://publisher.example/out?url=https%3A%2F%2Fmerchant.example%2Foffer", {
    baseUrl: "https://publisher.example/story",
    currentHostname: "publisher.example",
    rel: "nofollow sponsored",
    level: "relaxed"
  });
  assert.equal(affiliate.blocked, true);
  assert.equal(sponsored.blocked, true);
});

test("ordinary referral, authentication, and direct download links remain allowed", () => {
  const referral = engine.analyzeNavigation("https://docs.example/article?ref=homepage", {
    baseUrl: "https://publisher.example/",
    currentHostname: "publisher.example",
    level: "strict"
  });
  const authentication = engine.analyzeNavigation("https://accounts.example/oauth/authorize?affiliate_id=client-app", {
    baseUrl: "https://publisher.example/",
    currentHostname: "publisher.example",
    target: "_blank",
    linkText: "Continue",
    className: "continue-button",
    level: "strict"
  });
  const download = engine.analyzeNavigation("https://files.example/manual.pdf", {
    baseUrl: "https://publisher.example/",
    currentHostname: "publisher.example",
    target: "_blank",
    linkText: "Download",
    className: "download-button",
    level: "strict"
  });
  assert.equal(referral.blocked, false);
  assert.equal(authentication.blocked, false);
  assert.equal(download.blocked, false);
});

test("deceptive external action links use link text, aria label, and class", () => {
  const fakePlay = engine.analyzeNavigation("https://redirect.example/go?to=offer", {
    baseUrl: "https://publisher.example/movie",
    currentHostname: "publisher.example",
    target: "_blank",
    linkText: "Play now",
    ariaLabel: "Play now",
    className: "fake-play-button",
    level: "balanced"
  });
  const ordinaryPlayer = engine.analyzeNavigation("https://player.example/embed/movie", {
    baseUrl: "https://publisher.example/movie",
    currentHostname: "publisher.example",
    target: "_blank",
    linkText: "Play",
    className: "play-button",
    level: "strict"
  });
  assert.equal(fakePlay.blocked, true);
  assert.ok(fakePlay.reasons.some((item) => item.reason === "deceptive external action button"));
  assert.equal(ordinaryPlayer.blocked, false);
});
