import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

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

test("domain lookup respects label boundaries, trailing dots and malformed URLs", () => {
  assert.equal(engine.isKnownAdUrl("https://ads.doubleclick.net./ad"), true);
  assert.equal(engine.isKnownAdUrl("https://notdoubleclick.net/article"), false);
  assert.equal(engine.isKnownAdUrl("https://doubleclick.net.example.org/article"), false);
  assert.equal(engine.isKnownAdUrl("https://example.org/article?source=doubleclick.net"), false);
  assert.equal(engine.isKnownAdUrl("http://[invalid]/doubleclick.net"), false);
  assert.equal(engine.analyzeNavigation("https://ads.doubleclick.net./ad").blocked, true);
});

test("text sampling bounds character copies and subtree visits", () => {
  let visits = 0;
  const element = {
    ownerDocument: {
      createTreeWalker() {
        return { nextNode() { visits += 1; return { nodeType: 1 }; } };
      }
    },
    get textContent() { throw new Error("must not copy the entire subtree"); }
  };
  assert.ok(engine.readText(element).length > 2400, "incomplete samples cannot look like short disclosure labels");
  assert.ok(visits <= 257);
  element.ownerDocument.createTreeWalker = () => ({
    nextNode: () => ({ nodeType: 3, nodeValue: "x".repeat(100000) })
  });
  assert.equal(engine.readText(element).length, 4097);
});

test("explicit ad format metadata blocks while normal embedded frames remain usable", () => {
  for (const attribute of ["data-ad-type", "data-ad-format"]) {
    const element = new FakeElement("div", { [attribute]: "banner" });
    assert.equal(engine.classify(element, "relaxed").blocked, true);
  }
  const ad = new FakeElement("iframe", { src: "https://widgets.taboola.com/ad" });
  const video = new FakeElement("iframe", { src: "https://www.youtube.com/embed/example" });
  const payment = new FakeElement("iframe", { src: "https://js.stripe.com/payment" });
  assert.equal(engine.classify(ad, "balanced").blocked, true);
  assert.equal(engine.classify(video, "strict").blocked, false);
  assert.equal(engine.classify(payment, "strict").blocked, false);
});

test("explicit ad attributes are high-confidence signals", () => {
  const element = new FakeElement("div", { "data-ad-slot": "leaderboard" });
  const result = engine.classify(element, "relaxed");
  assert.ok(result.score >= 9);
  assert.equal(result.blocked, true);
  assert.equal(result.container, element);
});

test("high-confidence ad metadata does not require synchronous layout", () => {
  const element = new FakeElement("div", { "data-ad-slot": "leaderboard" });
  element.getBoundingClientRect = () => { throw new Error("unnecessary layout read"); };
  assert.equal(engine.classify(element, "relaxed").blocked, true);
});

test("formatted article leads, bibliography titles and navigation titles stay visible", () => {
  const paragraph = new FakeElement("p", {}, "is a form of communication.");
  const lead = new FakeElement("b", {}, "Advertising", paragraph);
  const listItem = new FakeElement("li", {}, "McFall, Elizabeth Rose (2004)");
  const book = new FakeElement("i", {}, "Advertising: a cultural economy", listItem);
  const header = new FakeElement("div", { class: "vector-header-container vector-sticky-header-container" });
  const title = new FakeElement("span", {}, "", header);
  const bold = new FakeElement("b", {}, "Advertising", title);
  const plainTitle = new FakeElement("div", { class: "vector-sticky-header-context-bar-primary" }, "Advertising", header);
  title.textContent = "Advertising";
  for (const element of [lead, book, listItem, title, bold, plainTitle, header]) {
    for (const level of ["relaxed", "balanced", "strict"]) {
      assert.equal(engine.classify(element, level).blocked, false, `${element.tagName} in ${level}`);
    }
  }
});

test("formatted disclosures inside commercial contexts retain ad detection", () => {
  for (const attributes of [{ "data-ad-slot": "banner" }, { class: "feed-card" }, { class: "ad-container" }]) {
    const card = new FakeElement("article", attributes);
    const label = new FakeElement("b", {}, "Sponsored", card);
    assert.equal(engine.classify(label, "strict").blocked, true);
  }
  assert.equal(engine.classify(new FakeElement("h2", { "data-sponsored": "true" }, "Advertising"), "strict").blocked, true);
});

test("an ad inside a navigation region does not hide the whole navigation container", () => {
  const header = new FakeElement("div", { class: "page-header-container" });
  const ad = new FakeElement("article", { "data-ad-slot": "header-ad" }, "", header);
  const label = new FakeElement("span", {}, "Sponsored", ad);
  const result = engine.classify(label, "strict");
  assert.equal(result.blocked, true);
  assert.equal(result.container, ad);
  assert.notEqual(result.container, header);
});

test("a sponsored label resolves to its feed card", () => {
  const card = new FakeElement("article", { class: "feed-card" });
  const label = new FakeElement("span", {}, "Sponsored", card);
  const result = engine.classify(label, "balanced");
  assert.equal(result.blocked, true);
  assert.equal(result.container, card);
});

test("sampled marker text preserves direct disclosures and avoids repeated subtree reads", () => {
  const directLabel = new FakeElement("span", {}, "Sponsored");
  assert.equal(engine.hasMarkerText(directLabel, "Sponsored followed by a long editorial description"), true);
  const fallbackLabel = new FakeElement("span");
  Object.defineProperty(fallbackLabel, "textContent", { get() { throw new Error("cached sample must be used"); } });
  assert.equal(engine.hasMarkerText(fallbackLabel, "Sponsored"), true);

  let reads = 0;
  const candidate = new FakeElement("div", { "data-ad-slot": "banner" });
  candidate.ownerDocument = { createTreeWalker() {
    reads += 1;
    let supplied = false;
    return { nextNode() {
      if (supplied) return null;
      supplied = true;
      return { nodeType: 3, nodeValue: "Recommended product" };
    } };
  } };
  assert.equal(engine.scoreCandidate(candidate).score, 9);
  assert.equal(reads, 1, "own text and protected UI checks reuse the candidate's sample");
});

test("ordinary glossary links labelled advertisement remain visible in every mode", () => {
  const article = new FakeElement("article", { class: "article-card" });
  const glossary = new FakeElement("a", {
    id: "mwBSI", class: "mw-redirect", title: "Advertisement", "aria-label": "Advertisement",
    href: "https://reference.example/wiki/Advertisement"
  }, "advertisement", article, { width: 300, height: 250 });
  const category = new FakeElement("a", { href: "/glossary/ads" }, "Ads");
  for (const level of ["relaxed", "balanced", "strict"]) {
    for (const link of [glossary, category]) {
      const result = engine.classify(link, level);
      assert.equal(result.blocked, false, `${link.getAttribute("href")} in ${level}`);
      assert.equal(result.container, null);
    }
  }
});

test("ambiguous accessibility labels use context while actual labelled ad surfaces remain blocked", () => {
  for (const label of ["Advertisement", "Sponsored"]) {
    const reference = new FakeElement("a", {
      href: `/reference/${label.toLowerCase()}`, class: "advertisement", "aria-label": label
    }, label);
    for (const level of ["relaxed", "balanced", "strict"]) {
      assert.equal(engine.classify(reference, level).blocked, false, `${label} reference in ${level}`);
    }
    const adSurface = new FakeElement("aside", { "aria-label": label }, "An advertiser's special offer");
    for (const level of ["balanced", "strict"]) {
      assert.equal(engine.classify(adSurface, level).blocked, true, `${label} ad surface in ${level}`);
    }
  }
});

test("glossary link wrappers and inline text children retain their editorial context", () => {
  for (const text of ["Advertisement", "Sponsored"]) {
    const paragraph = new FakeElement("p");
    const reference = new FakeElement("a", { href: "/reference/advertising", "aria-label": text }, "", paragraph);
    const inline = new FakeElement("span", {}, text, reference);
    paragraph.textContent = text;
    for (const level of ["relaxed", "balanced", "strict"]) {
      for (const element of [paragraph, reference, inline]) {
        assert.equal(engine.classify(element, level).blocked, false, `${element.tagName} around ${text} in ${level}`);
      }
    }
  }
  const adCard = new FakeElement("article", { "data-sponsored": "true" });
  const disclosure = new FakeElement("a", { href: "/reference/advertising" }, "", adCard);
  const label = new FakeElement("span", {}, "Sponsored", disclosure);
  adCard.textContent = "Sponsored";
  assert.equal(engine.classify(adCard, "relaxed").blocked, true);
  assert.equal(engine.classify(label, "strict").blocked, true,
    "declared ad context is preserved around nested reference-style disclosures");
  const commercialLink = new FakeElement("a", { href: "https://doubleclick.net/offer" });
  const commercialLabel = new FakeElement("span", {}, "Sponsored", commercialLink);
  assert.equal(engine.classify(commercialLabel, "strict").blocked, true);
});

test("disclosure links with independent advertising evidence still block", () => {
  const examples = [
    new FakeElement("a", { href: "https://doubleclick.net/offer" }, "Advertisement"),
    new FakeElement("a", { href: "/advertiser", "data-sponsored": "true" }, "Sponsored"),
    new FakeElement("a", { href: "/advertiser", class: "ad-container" }, "Advertisement"),
    new FakeElement("a", { href: "https://merchant.example/offer", rel: "sponsored" }, "Sponsored")
  ];
  for (const level of ["relaxed", "balanced", "strict"]) {
    for (const ad of examples) assert.equal(engine.classify(ad, level).blocked, true, `${ad.getAttribute("href")} in ${level}`);
  }
  const adCard = new FakeElement("article", { class: "feed-card", "data-sponsored": "true" });
  const disclosure = new FakeElement("a", { href: "/disclosure" }, "Sponsored", adCard);
  assert.equal(engine.classify(disclosure, "balanced").container, adCard);
  assert.equal(engine.classify(new FakeElement("a", {}, "Sponsored"), "strict").blocked, true,
    "an anchor without a destination is not assumed to be an editorial link");
});

test("hostnames beginning with ads are informational text rather than disclosure labels", () => {
  for (const hostname of ["ads-api.tiktok.com", "ads-sg.tiktok.com", "ads-api.twitter.com"]) {
    for (const tag of ["div", "span"]) {
      const label = new FakeElement(tag, { id: hostname }, hostname);
      assert.equal(engine.hasMarkerText(label), false);
      for (const level of ["relaxed", "balanced", "strict"]) {
        assert.equal(engine.classify(label, level).blocked, false, `${hostname} in ${level}`);
      }
    }
  }
  for (const text of ["Advertisement: paid content", "Sponsored - Example company", "Ad · Offer"]) {
    assert.equal(engine.hasMarkerText(new FakeElement("span", {}, text)), true, text);
  }
});

test("weakly named ad host lists preserve diagnostic content without excluding live ad payloads", () => {
  const makeList = (attributes = {}) => {
    const list = new FakeElement("div", { id: "Ads", class: "grid", ...attributes }, "Ads");
    new FakeElement("span", {}, "stats.g.doubleclick.net", list);
    new FakeElement("span", {}, "ads-api.tiktok.com", list);
    return list;
  };
  const diagnostics = makeList();
  for (const level of ["relaxed", "balanced", "strict"]) {
    assert.equal(engine.classify(diagnostics, level).blocked, false, `diagnostic list in ${level}`);
    assert.equal(engine.classify(makeList({ "data-ad-slot": "banner" }), level).blocked, true, `explicit slot in ${level}`);
    assert.equal(engine.classify(makeList({ class: "ad-container" }), level).blocked, true, `ad container in ${level}`);
  }
  const liveContainer = makeList();
  const payload = new FakeElement("iframe", { src: "https://doubleclick.net/ads/creative" }, "", liveContainer);
  assert.equal(engine.classify(liveContainer, "strict").blocked, true);
  assert.equal(engine.classify(payload, "relaxed").blocked, true);
  const declaredContainer = makeList();
  new FakeElement("div", { "data-sponsored": "true" }, "Recommended product", declaredContainer);
  assert.equal(engine.classify(declaredContainer, "strict").blocked, true,
    "a declared native ad inside a host list retains its advertising context");
});

test("formatted diagnostic grids preserve hostname content despite whitespace and SVG icons", () => {
  const grid = new FakeElement("div", { id: "Ads", class: "grid" }, "Ads");
  const headingWrapper = new FakeElement("div", {}, "", grid);
  const heading = new FakeElement("h5", {}, "Ads", headingWrapper);
  for (let index = 0; index < 22; index += 1) {
    const row = new FakeElement("div", {}, "", grid);
    for (let space = 0; space < 14; space += 1) row.childNodes.push({ nodeType: 3, nodeValue: "\n  " });
    const icon = new FakeElement("svg", {}, "", row);
    for (let path = 0; path < 3; path += 1) new FakeElement("path", {}, "", icon);
    new FakeElement("span", {}, `probe${index}.doubleclick.net`, row);
  }
  assert.equal(engine.classify(grid, "strict").blocked, false);
  assert.equal(engine.classify(heading, "strict").blocked, false);
  assert.equal(engine.classify(headingWrapper, "strict").blocked, false);
  const payload = new FakeElement("iframe", { src: "https://doubleclick.net/ads/creative" }, "", grid);
  assert.equal(engine.classify(grid, "strict").blocked, true);
  assert.equal(engine.classify(payload, "relaxed").blocked, true);
});

test("native and social promotions require explicit promotion metadata", () => {
  const nativeAd = new FakeElement("article", { "data-sponsored": "true" }, "Recommended for you");
  const socialPromo = new FakeElement("aside", { class: "instagram-sponsored-widget" }, "Follow this promoted account");
  const ordinaryShare = new FakeElement("aside", { class: "social-share-widget" }, "Share this story");
  assert.equal(engine.classify(nativeAd, "relaxed").blocked, true);
  assert.equal(engine.classify(socialPromo, "balanced").blocked, true);
  assert.equal(engine.classify(ordinaryShare, "strict").blocked, false);
});

test("false promotion flags preserve editorial cards in every protection level", () => {
  for (const attribute of ["data-sponsored", "data-promoted", "data-social-promo"]) {
    for (const value of ["false", " FALSE ", "0", " 0 "]) {
      const editorial = new FakeElement("article", { class: "article-card", [attribute]: value }, "Editorial story");
      for (const level of ["relaxed", "balanced", "strict"]) {
        const result = engine.classify(editorial, level);
        assert.equal(result.blocked, false, `${attribute}=${JSON.stringify(value)} at ${level}`);
        assert.equal(result.score, 0);
        assert.equal(result.container, null);
      }
    }
  }
});

test("positive and presence-style promotion flags remain high-confidence advertising evidence", () => {
  for (const attribute of ["data-sponsored", "data-promoted", "data-social-promo"]) {
    for (const value of ["true", "1", ""]) {
      const ad = new FakeElement("article", { [attribute]: value }, "Recommended product");
      const result = engine.classify(ad, "relaxed");
      assert.equal(result.blocked, true, `${attribute}=${JSON.stringify(value)}`);
      assert.ok(result.score >= 9);
    }
  }
});

test("false promotion flags do not override independent advertising evidence", () => {
  const slot = new FakeElement("div", { "data-sponsored": "false", "data-ad-slot": "leaderboard" });
  const banner = new FakeElement("div", { "data-promoted": "0", class: "ad-container" });
  assert.equal(engine.classify(slot, "relaxed").blocked, true);
  assert.equal(engine.classify(banner, "balanced").blocked, true);
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

test("anti-adblock detection requires a directive or restricted access rather than neutral mentions", () => {
  for (const text of [
    "d3Host List (ADBLOCK)", "AdBlock detected", "Adblock test results: 20 ads are blocked.",
    "Advertising networks and ad blockers", "Why Cosmetic Filter test fails? Adblock settings and test results."
  ]) {
    assert.equal(engine.isAntiAdblockMessage(text), false, text);
  }
  for (const text of [
    "AdBlock / DNS Blocking detected. Please disable to continue.",
    "Please turn off your ad blocker to continue reading.",
    "Adblock detected. Content is unavailable.",
    "Your ad blocker is preventing video playback.",
    "Ads are blocked. Please allow ads to continue."
  ]) {
    assert.equal(engine.isAntiAdblockMessage(text), true, text);
  }
  for (const level of ["relaxed", "balanced", "strict"]) {
    assert.equal(engine.classify(new FakeElement("button", { id: "d3H_adblock", class: "btn-blue" }, "d3Host List (ADBLOCK)"), level).blocked, false);
  }
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
