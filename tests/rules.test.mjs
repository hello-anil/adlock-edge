import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const readJson = async (relativePath) => JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
const require = createRequire(import.meta.url);
const domainData = require("../content/domain-data.js");
const [core, privacy, privacyNavigation, redirects, compatibility, filterData, generatedAlways, generatedStrict, generatedRedirects, protectionCss] = await Promise.all([
  readJson("rules/core.json"),
  readJson("rules/privacy.json"),
  readJson("rules/privacy-navigation.json"),
  readJson("rules/redirects.json"),
  readJson("rules/compatibility.json"),
  readJson("data/filter-data.json"),
  readJson("rules/generated-always.json"),
  readJson("rules/generated-strict.json"),
  readJson("rules/generated-redirects.json"),
  readFile(path.join(root, "content/protection.css"), "utf8")
]);

const byId = (rules, id) => rules.find((rule) => rule.id === id);
const sortedUnique = (values) => [...new Set(values)].sort();
const regexMatches = (rule, url) => new RegExp(
  rule.condition.regexFilter,
  rule.condition.isUrlFilterCaseSensitive === false ? "i" : ""
).test(url);

test("generated filter artifacts are deterministic and current", () => {
  const result = spawnSync(process.execPath, ["scripts/generate-filter-data.mjs", "--check"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("canonical categories generate identical DNR and content-script domain sets", () => {
  for (const [name, category] of Object.entries(filterData.categories)) {
    const rules = category.tier === "always" ? generatedAlways : generatedStrict;
    const rule = byId(rules, category.ruleId);
    assert.ok(rule, `missing generated rule for ${name}`);
    assert.equal(rule.action.type, "block");
    assert.deepEqual(rule.condition.requestDomains, category.domains);
    assert.deepEqual(rule.condition.resourceTypes, filterData.resourceProfiles[category.resourceProfile]);
    assert.equal(rule.condition.domainType, category.domainType);
    assert.deepEqual(Array.from(domainData.categories[name]), category.domains);
  }

  assert.equal(domainData.revision, filterData.revision);
  assert.ok(domainData.categories.native.includes("mgid.com"));
  assert.ok(domainData.categories.native.includes("dianomi.com"));
  assert.ok(domainData.categories.tracker.includes("omtrdc.net"));
  assert.ok(domainData.categories.tracker.includes("rudderstack.com"));
  assert.ok(domainData.categories.tracker.includes("cloudflareinsights.com"));
  assert.ok(domainData.categories.tracker.includes("dtscout.com"));
  assert.ok(domainData.categories.tracker.includes("histats.com"));
  assert.ok(domainData.categories.popup.includes("cloudorchestranova.com"));
});

test("strict aggressive endpoint rules preserve canonical matching conditions", () => {
  for (const endpoint of filterData.aggressiveEndpoints) {
    const rule = byId(generatedStrict, endpoint.ruleId);
    assert.ok(rule, `missing generated endpoint rule for ${endpoint.key}`);
    assert.equal(rule.action.type, "block");
    for (const property of ["urlFilter", "regexFilter", "isUrlFilterCaseSensitive", "domainType", "resourceTypes"]) {
      assert.deepEqual(rule.condition[property], endpoint[property], `${endpoint.key} ${property}`);
    }
  }

  assert.equal(regexMatches(byId(generatedStrict, 6120), "https://ads.example.net/tags/VAST3.xml"), true);
  assert.equal(regexMatches(byId(generatedStrict, 6140), "https://video.example.net/load?VMAP_url=https%3A%2F%2Fads.example%2Ftag"), true);
  assert.equal(regexMatches(byId(generatedStrict, 6160), "https://bad.example/assets/cryptonight-worker.wasm"), true);
  assert.equal(byId(generatedStrict, 6200).condition.urlFilter, "/pagead/");
  assert.equal(byId(generatedStrict, 6210).condition.urlFilter, "/adserver/");
  assert.equal(byId(generatedStrict, 6220).condition.urlFilter, "/.well-known/attribution-reporting/");
  assert.equal(byId(generatedStrict, 6230).condition.urlFilter, "/.well-known/private-aggregation/");
});

test("generated redirect domains are the canonical main-frame union", () => {
  const expectedDomains = sortedUnique(filterData.redirects.categories.flatMap((name) => filterData.categories[name].domains));
  const [rule] = generatedRedirects;
  assert.equal(rule.id, filterData.redirects.ruleId);
  assert.deepEqual(rule.condition.requestDomains, expectedDomains);
  assert.deepEqual(rule.condition.resourceTypes, ["main_frame"]);
  assert.deepEqual(Array.from(domainData.redirectDomains), expectedDomains);
  assert.ok(expectedDomains.includes("popads.net"));
  assert.ok(expectedDomains.includes("content.ad"));
});

test("generated static IDs are globally unique and isolated from legacy IDs", () => {
  const legacyRules = [...core, ...privacy, ...privacyNavigation, ...redirects, ...compatibility];
  const generatedRules = [...generatedAlways, ...generatedStrict, ...generatedRedirects];
  assert.ok(generatedRules.every((rule) => rule.id >= 5000));
  const ids = [...legacyRules, ...generatedRules].map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("always-on and strict generated tiers cover video, native, popup, miner, push, and pixel defenses", () => {
  assert.ok(byId(generatedAlways, 5010).condition.requestDomains.includes("freewheel.tv"));
  assert.ok(byId(generatedAlways, 5020).condition.requestDomains.includes("mgid.com"));
  assert.ok(byId(generatedAlways, 5030).condition.requestDomains.includes("popads.net"));
  assert.ok(byId(generatedAlways, 5030).condition.requestDomains.includes("arabalative.shop"));
  assert.ok(byId(generatedAlways, 5030).condition.requestDomains.includes("arylblurry.shop"));
  assert.ok(byId(generatedAlways, 5030).condition.requestDomains.includes("browpotware.com"));
  assert.ok(byId(generatedAlways, 5030).condition.requestDomains.includes("cloudnestra.com"));
  assert.ok(byId(generatedAlways, 5030).condition.requestDomains.includes("cloudorchestranova.com"));
  assert.ok(byId(generatedAlways, 5030).condition.requestDomains.includes("l33xmeqmetu36p2.cfd"));
  assert.ok(byId(generatedAlways, 5030).condition.requestDomains.includes("weevilsmoggyshoguns.cyou"));
  assert.ok(byId(generatedAlways, 5040).condition.requestDomains.includes("coinhive.com"));
  assert.equal(regexMatches(byId(generatedStrict, 6120), "https://ads.example.net/tags/VMAP?slot=preroll"), true);
  assert.equal(regexMatches(byId(generatedStrict, 6130), "https://cdn.example.net/sdk/ad-tag.json"), true);
  assert.equal(regexMatches(byId(generatedStrict, 6110), "https://metrics.example.net/pixel.gif?event=view"), true);
  assert.equal(regexMatches(byId(core, 14), "https://bad.example/assets/cryptonight-worker.wasm"), true);
  assert.equal(regexMatches(byId(core, 16), "https://bad.example/js/clickunder.min.js"), true);
  assert.ok(byId(generatedStrict, 6000).condition.requestDomains.includes("onesignal.com"));
});

test("broader marketing and session replay blocking remains strict-mode only", () => {
  assert.ok(byId(privacy, 1003).condition.requestDomains.includes("analytics.tiktok.com"));
  assert.ok(byId(privacy, 1004).condition.requestDomains.includes("fullstory.com"));
  assert.ok(byId(privacy, 1004).condition.requestDomains.includes("mouseflow.com"));
});

test("strict navigation cleanup removes click identifiers without rewriting ordinary links", () => {
  const clickIds = byId(privacyNavigation, 2001);
  const secondaryClickIds = byId(privacyNavigation, 2003);
  const campaignIds = byId(privacyNavigation, 2002);
  assert.equal(clickIds.action.type, "redirect");
  assert.equal(campaignIds.action.type, "redirect");
  assert.deepEqual(clickIds.condition.resourceTypes, ["main_frame"]);
  assert.equal(regexMatches(clickIds, "https://shop.example/item?fbclid=opaque&size=large"), true);
  assert.equal(regexMatches(clickIds, "https://shop.example/item?size=large"), false);
  assert.equal(regexMatches(secondaryClickIds, "https://mail.example/open?mc_eid=opaque&id=4"), true);
  assert.equal(regexMatches(campaignIds, "https://news.example/story?utm_source=feed&id=4"), true);
  assert.ok(clickIds.action.redirect.transform.queryTransform.removeParams.includes("gclid"));
  assert.ok(campaignIds.action.redirect.transform.queryTransform.removeParams.includes("utm_campaign"));
});

test("redirect policy blocks established popup networks without blocking generic media CDNs", () => {
  const [popupNavigations] = generatedRedirects;
  assert.ok(popupNavigations.condition.requestDomains.includes("popcash.net"));
  assert.deepEqual(popupNavigations.condition.resourceTypes, ["main_frame"]);
  assert.ok(byId(redirects, 9), "site-specific redirect defense must remain present");
  const allDomains = [...core, ...generatedAlways, ...generatedRedirects].flatMap((rule) => rule.condition.requestDomains || []);
  assert.equal(allDomains.some((domain) => domain.endsWith("amazonaws.com")), false);
  assert.equal(allDomains.includes("ythd.org"), false);
  assert.equal(JSON.stringify(core).includes("m3u8"), false);
});

test("compatibility rules remain narrowly scoped to exact site probes", () => {
  assert.equal(compatibility.length, 6);
  const adapter = byId(compatibility, 3001);
  assert.equal(adapter.action.redirect.extensionPath, "/content/ad-api-shim.js");
  assert.equal(adapter.condition.urlFilter, "||pagead2.googlesyndication.com/pagead/js/adsbygoogle.js");
  assert.equal(adapter.condition.domainType, "thirdParty");
  assert.deepEqual(adapter.condition.resourceTypes, ["script"]);

  const net77Guard = byId(compatibility, 3002);
  assert.equal(net77Guard.action.type, "block");
  assert.equal(net77Guard.condition.urlFilter, "||net77.cc/js/chor-mate.js");
  assert.deepEqual(net77Guard.condition.initiatorDomains, ["net77.cc"]);
  assert.deepEqual(net77Guard.condition.resourceTypes, ["script"]);

  const net77DetectionImage = byId(compatibility, 3003);
  assert.equal(net77DetectionImage.action.redirect.extensionPath, "/assets/icons/icon-16.png");
  assert.equal(net77DetectionImage.condition.urlFilter, "||publishers.monetag.com/assets/favicon-16x16.png");
  assert.deepEqual(net77DetectionImage.condition.initiatorDomains, ["net77.cc"]);
  assert.deepEqual(net77DetectionImage.condition.resourceTypes, ["image"]);

  const ythdDisableDevtool = byId(compatibility, 3004);
  assert.equal(ythdDisableDevtool.action.type, "block");
  assert.equal(ythdDisableDevtool.condition.urlFilter, "||unpkg.com/disable-devtool@");
  assert.deepEqual(ythdDisableDevtool.condition.initiatorDomains, ["ythd.org"]);
  assert.deepEqual(ythdDisableDevtool.condition.resourceTypes, ["script"]);

  const ythdBlankRedirect = byId(compatibility, 3005);
  assert.equal(ythdBlankRedirect.action.type, "block");
  assert.equal(ythdBlankRedirect.condition.urlFilter, "||theajack.github.io/disable-devtool/404.html");
  assert.deepEqual(ythdBlankRedirect.condition.initiatorDomains, ["ythd.org"]);
  assert.deepEqual(ythdBlankRedirect.condition.resourceTypes, ["main_frame", "sub_frame"]);

  const ythdPlayerFrame = byId(compatibility, 3006);
  assert.equal(ythdPlayerFrame.action.type, "allow");
  assert.equal(ythdPlayerFrame.priority, 100);
  assert.deepEqual(ythdPlayerFrame.condition.requestDomains, ["cloudorchestranova.com"]);
  assert.deepEqual(ythdPlayerFrame.condition.initiatorDomains, ["ythd.org"]);
  assert.deepEqual(ythdPlayerFrame.condition.resourceTypes, ["sub_frame"]);
});

test("blocking share promotions require a fixed container and exact artwork marker", () => {
  assert.match(protectionCss, /\[class~="fixed"\]:has\(img\[alt="Sharing is Caring" i\]\)/);
  assert.doesNotMatch(protectionCss, /(?:^|,)\s*img\[alt="Sharing is Caring" i\]\s*(?:,|\{)/m);
});
