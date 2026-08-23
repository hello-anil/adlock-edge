(function exposeEngine(root, factory) {
  const domainData = root.AdLockDomainData || (
    typeof module !== "undefined" && module.exports && typeof require === "function"
      ? require("./domain-data.js")
      : null
  );
  const engine = factory(domainData);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = engine;
  }
  root.AdaptiveAdEngine = engine;
})(typeof globalThis !== "undefined" ? globalThis : this, function createEngine(domainData) {
  "use strict";

  const VERSION = "2.0.0";

  const LEVEL_THRESHOLDS = Object.freeze({
    relaxed: 9,
    balanced: 6,
    strict: 4
  });

  const REDIRECT_THRESHOLDS = Object.freeze({
    relaxed: 12,
    balanced: 9,
    strict: 7
  });

  const FALLBACK_AD_HOSTS = Object.freeze([
    "adangle.online", "adsrvr.org", "adnxs.com", "doubleclick.net",
    "googlesyndication.com", "popads.net", "taboola.com"
  ]);
  const frozenDomains = (key, fallback) => Object.freeze(
    Array.isArray(domainData?.[key]) && domainData[key].length
      ? [...domainData[key]]
      : [...fallback]
  );
  const KNOWN_AD_HOSTS = frozenDomains("advertisingDomains", FALLBACK_AD_HOSTS);
  const ALWAYS_ON_HOSTS = frozenDomains("alwaysOnDomains", KNOWN_AD_HOSTS);

  const CANDIDATE_SELECTOR = [
    "ins.adsbygoogle",
    "iframe[src*='doubleclick.net']",
    "iframe[src*='googlesyndication.com']",
    "iframe[src*='/pagead/']",
    "iframe[src*='/ads/']",
    "[data-ad]",
    "[data-ad-slot]",
    "[data-ad-unit]",
    "[data-advertisement]",
    "[data-sponsored]",
    "[data-promoted]",
    "[data-social-promo]",
    "[aria-label*='advertisement' i]",
    "[aria-label*='sponsored' i]",
    "[id^='google_ads_']",
    "[class~='ad']",
    "[class~='ads']",
    "[class*='ad-container' i]",
    "[class*='ad_container' i]",
    "[class*='ad-slot' i]",
    "[class*='ad_slot' i]",
    "[class*='advertisement' i]",
    "[class*='sponsored' i]",
    "[class*='promoted' i]",
    "[class*='ad-overlay' i]",
    "[class*='overlay-ad' i]",
    "[class*='ad-interstitial' i]",
    "[class*='interstitial-ad' i]",
    "[class*='floating-ad' i]",
    "[class*='floating-promo' i]",
    "[class*='promo-widget' i]",
    "[class*='social-promo' i]",
    "[class*='social-ad' i]",
    "[class*='companion-ad' i]",
    "[class*='ad-companion' i]",
    "[class*='vast-companion' i]",
    "[class*='fake-play' i]",
    "[class*='fake-download' i]",
    "[class*='ad-skin' i]",
    "[class*='skin-ad' i]",
    "[class*='background-ad' i]",
    "[data-companion-ad]",
    "[data-ad-background]",
    "img[width='1'][height='1']",
    "iframe[width='1'][height='1']",
    "img[src*='/pixel' i]",
    "img[src*='/beacon' i]"
  ].join(",");

  const EXPLICIT_ATTRIBUTE_RE = /(?:^|[\s_-])(ads?|advert(?:isement|ising)?|sponsored|promoted|paid-content)(?:[\s_-]|$)/i;
  const STRONG_ATTRIBUTE_RE = /(?:adsbygoogle|google_ads|ad[-_](?:container|wrapper|slot|unit|banner)|sponsor(?:ed)?[-_](?:content|post)|promoted[-_](?:content|post))/i;
  const FALSE_ATTRIBUTE_RE = /(?:shadow|address|download|adapter|admin|badge|header|breadcrumb|thread|read-more)/i;
  const MARKER_RE = /^(?:ad|ads|advert|advertisement|advertising|paid content|promoted|sponsored)(?:\s*[·•|:-].*)?$/i;
  const URL_AD_HINT_RE = /(?:[/?&_.-](?:adserver|adservice|ads?|advert|banner|campaign|creative|sponsor)(?:[/?&=_.-]|$)|[?&](?:ad_id|adid|campaign_id|creative_id)=)/i;
  const REDIRECT_PATH_RE = /(?:^|\/)(?:click|go|out|redirect|redir|track)(?:\/|$)/i;
  const REDIRECT_KEYS = new Set(["adurl", "dest", "destination", "redirect", "redirect_url", "target", "to", "url"]);
  const MAX_REDIRECT_DEPTH = 3;
  const MAX_REDIRECT_URLS = 8;
  const MAX_REDIRECT_VALUE_LENGTH = 4096;
  const CARD_HINT_RE = /(?:card|feed|item|module|post|story|stream|update|unit|container|wrapper)/i;
  const COMMON_AD_SIZES = Object.freeze([
    [300, 250], [336, 280], [728, 90], [970, 90], [970, 250],
    [320, 50], [320, 100], [468, 60], [160, 600], [300, 600]
  ]);
  const ANTI_ADBLOCK_TEXT_RE = /(?:\bad\s*block(?:er|ing)?\b|\badblock\b|disable.{0,60}(?:ad\s*block|adblocker)|whitelist.{0,60}(?:site|domain)|ads?\s+(?:are|is|were|must be)\s+blocked)/i;
  const SECURITY_CHALLENGE_RE = /\b(?:cloudflare|turnstile|captcha|security verification|verify (?:that )?you are (?:a )?human|bot verification|sign[ -]?in|log[ -]?in|subscription|subscribe|paywall)\b/i;
  const ADBLOCK_BAIT_RE = /(?:^|[\s_-])(?:adsbox|ad[-_]?bait|ad[-_]?test(?:er)?|banner[-_]?ad|pub[-_]?\d{2,4}x\d{2,4})(?:[\s_-]|$)/i;
  const AD_SURFACE_RE = /(?:^|[\s_-])(?:(?:ad|advert(?:isement|ising)?|sponsor(?:ed)?|promo(?:ted|tion)?)[-_]?(?:overlay|interstitial|modal|popup|popunder|wall|skin|backdrop)|(?:overlay|interstitial|modal|popup|popunder|wall|skin|backdrop)[-_]?(?:ad|advert(?:isement|ising)?|sponsor(?:ed)?|promo(?:ted|tion)?))(?:[\s_-]|$)/i;
  const FLOATING_PROMO_RE = /(?:^|[\s_-])(?:(?:floating|sticky|corner)[-_]?(?:ad|advert|promo|sponsor)|(?:ad|advert|promo|sponsor)[-_]?(?:floating|sticky|widget))(?:[\s_-]|$)/i;
  const SOCIAL_PROMO_RE = /(?:^|[\s_-])(?:(?:social|facebook|instagram|tiktok|twitter|pinterest)[-_]?(?:ad|promo(?:tion)?|sponsor(?:ed)?|follow[-_]?widget)|(?:ad|promo(?:tion)?|sponsor(?:ed)?)[-_]?(?:social|facebook|instagram|tiktok|twitter|pinterest))(?:[\s_-]|$)/i;
  const COMPANION_AD_RE = /(?:^|[\s_-])(?:(?:vast|video|player)[-_]?(?:ad[-_]?)?companion|ad[-_]?companion|companion[-_]?ad)(?:[\s_-]|$)/i;
  const BACKGROUND_SKIN_RE = /(?:^|[\s_-])(?:(?:ad|advert|promo)[-_]?(?:background|skin|wallpaper)|(?:background|skin|wallpaper)[-_]?(?:ad|advert|promo))(?:[\s_-]|$)/i;
  const TRACKING_URL_HINT_RE = /(?:[/?&_.-](?:pixel|beacon|impression|track(?:ing)?|collect)(?:[/?&=_.-]|$)|[?&](?:event|impression_id|tracking_id)=)/i;
  const ACTION_LURE_RE = /^(?:(?:free\s+)?(?:play|watch|stream|download)(?:\s+(?:now|movie|video|file))?|continue|close|start\s+(?:watching|download))\s*[!>]?\s*$/i;
  const FAKE_ACTION_IDENTIFIER_RE = /(?:^|[\s_-])(?:(?:fake|ad|advert|promo|popup)[-_]?(?:play|watch|download|continue|close)(?:[-_]?(?:button|btn))?|(?:play|watch|download|continue|close)[-_]?(?:ad|advert|promo|popup))(?:[\s_-]|$)/i;
  const PROTECTED_UI_ATTRIBUTE_RE = /(?:^|[\s_-])(?:captcha|turnstile|cloudflare|auth(?:entication)?|login|signin|sign-in|checkout|payment|security[-_]?challenge|two[-_]?factor|2fa|mfa)(?:[\s_-]|$)/i;
  const PROTECTED_UI_TEXT_RE = /\b(?:cloudflare|turnstile|captcha|security verification|verify (?:that )?you are (?:a )?human|bot verification|sign[ -]?in to|log[ -]?in to|authentication required|two-factor authentication|payment verification)\b/i;
  const STRONG_AFFILIATE_KEYS = new Set(["aff", "aff_id", "affid", "affiliate", "affiliate_id", "affiliateid", "partner_id", "partnerid"]);
  const AFFILIATE_VALUE_RE = /^(?:affiliate|affiliates|partner|sponsored|referral)$/i;
  const AFFILIATE_PATH_RE = /(?:^|\/)(?:aff|affiliate|outbound|partner|referral)(?:\/|$)/i;
  const PROTECTED_NAVIGATION_RE = /(?:^|\/)(?:auth|authorize|callback|captcha|challenge|checkout|login|logout|oauth|payment|signin|sso|turnstile|verify)(?:\/|$)/i;
  const DIRECT_DOWNLOAD_RE = /\.(?:7z|apk|csv|dmg|docx?|exe|gz|iso|mp3|mp4|msi|pdf|pkg|rar|tar|txt|xlsx?|zip)(?:$|[?#])/i;

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isAntiAdblockMessage(value) {
    const text = normalizeText(value);
    return text.length >= 12 && text.length <= 2400 && ANTI_ADBLOCK_TEXT_RE.test(text) && !SECURITY_CHALLENGE_RE.test(text);
  }

  function isLikelyAdblockBait(element) {
    if (!element || element.nodeType !== 1) return false;
    const corpus = getAttributeCorpus(element);
    const text = normalizeText(element.textContent || "");
    if (!ADBLOCK_BAIT_RE.test(corpus) || text.length > 80) return false;
    if (element.querySelector?.("a[href],button,input,video,audio")) return false;
    const rect = typeof element.getBoundingClientRect === "function" ? element.getBoundingClientRect() : null;
    const tiny = !rect || rect.width <= 12 || rect.height <= 12;
    const inlineStyle = normalizeText(element.getAttribute?.("style"));
    const offscreen = /(?:left|top)\s*:\s*-\d{2,}/i.test(inlineStyle);
    return tiny || offscreen;
  }

  function hostnameMatches(hostname, domain) {
    const host = String(hostname || "").toLowerCase().replace(/^www\./, "");
    const target = String(domain || "").toLowerCase().replace(/^\.+|\.+$/g, "").replace(/^www\./, "");
    return Boolean(host && target && (host === target || host.endsWith(`.${target}`)));
  }

  function isKnownAdUrl(value) {
    if (!value) return false;
    try {
      const base = typeof location !== "undefined" ? location.href : "https://example.invalid/";
      const host = new URL(String(value), base).hostname;
      return KNOWN_AD_HOSTS.some((domain) => hostnameMatches(host, domain));
    } catch (_error) {
      const lowered = String(value).toLowerCase();
      return KNOWN_AD_HOSTS.some((domain) => lowered.includes(domain));
    }
  }

  function getAttributeCorpus(element) {
    if (!element || typeof element.getAttribute !== "function") return "";
    const names = [
      "id", "class", "role", "aria-label", "title", "data-testid",
      "data-ad", "data-ad-slot", "data-ad-unit", "data-advertisement",
      "data-ad-type", "data-ad-format", "data-companion-ad", "data-ad-background",
      "data-sponsored", "data-promoted", "data-social-promo"
    ];
    return normalizeText(names.map((name) => element.getAttribute(name) || "").join(" "));
  }

  function ownText(element) {
    if (!element) return "";
    let text = "";
    const nodes = element.childNodes || [];
    for (const node of nodes) {
      if (node && node.nodeType === 3) text += ` ${node.nodeValue || ""}`;
    }
    return normalizeText(text || element.textContent || "");
  }

  function hasMarkerText(element) {
    const text = ownText(element);
    return text.length > 0 && text.length <= 80 && MARKER_RE.test(text);
  }

  function elementUrls(element) {
    if (!element || typeof element.getAttribute !== "function") return [];
    const urls = ["src", "href", "data-src", "poster"]
      .map((name) => element.getAttribute(name))
      .filter(Boolean);
    const style = String(element.getAttribute("style") || "");
    const cssUrlRe = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
    let match;
    while ((match = cssUrlRe.exec(style))) {
      if (match[2]) urls.push(match[2]);
    }
    return urls;
  }

  function hasTinyResourceBox(element) {
    if (!element || typeof element.getAttribute !== "function") return false;
    const width = Number.parseFloat(element.getAttribute("width"));
    const height = Number.parseFloat(element.getAttribute("height"));
    if (Number.isFinite(width) && Number.isFinite(height) && width >= 0 && height >= 0 && width <= 4 && height <= 4) return true;
    const style = String(element.getAttribute("style") || "");
    if (/\bwidth\s*:\s*[0-4](?:px)?\b/i.test(style) && /\bheight\s*:\s*[0-4](?:px)?\b/i.test(style)) return true;
    if (typeof element.getBoundingClientRect !== "function") return false;
    const rect = element.getBoundingClientRect();
    return Boolean(rect && rect.width > 0 && rect.height > 0 && rect.width <= 4 && rect.height <= 4);
  }

  function isProtectedUiElement(element) {
    const corpus = getAttributeCorpus(element);
    const text = normalizeText(element && element.textContent || "");
    return PROTECTED_UI_ATTRIBUTE_RE.test(corpus) || PROTECTED_UI_TEXT_RE.test(text);
  }

  function hasAdSizedBox(element) {
    if (!element || typeof element.getBoundingClientRect !== "function") return false;
    const rect = element.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return false;
    return COMMON_AD_SIZES.some(([width, height]) =>
      Math.abs(rect.width - width) <= 12 && Math.abs(rect.height - height) <= 12
    );
  }

  function tagNameOf(element) {
    return String(element && element.tagName || "").toLowerCase();
  }

  function scoreCandidate(element) {
    if (!element || element.nodeType !== 1) {
      return { score: 0, signals: [] };
    }

    let score = 0;
    const signals = [];
    const tag = tagNameOf(element);
    const corpus = getAttributeCorpus(element);
    const text = ownText(element);
    const fullText = normalizeText(element.textContent || "");
    const urls = elementUrls(element);
    const inlineStyle = normalizeText(element.getAttribute && element.getAttribute("style"));
    const explicitAdAttribute = [
      "data-ad", "data-ad-slot", "data-ad-unit", "data-advertisement", "data-companion-ad", "data-ad-background",
      "data-sponsored", "data-promoted", "data-social-promo"
    ].some((name) => element.hasAttribute && element.hasAttribute(name));

    const add = (points, signal) => {
      score += points;
      signals.push({ signal, points });
    };

    if (tag === "ins" && /adsbygoogle/i.test(corpus)) add(9, "adsbygoogle element");
    if (explicitAdAttribute) {
      add(9, "explicit ad data attribute");
    }

    const aria = normalizeText(element.getAttribute && element.getAttribute("aria-label"));
    if (aria && /\b(?:advertisement|sponsored|promoted)\b/i.test(aria)) add(7, "ad accessibility label");

    if (STRONG_ATTRIBUTE_RE.test(corpus)) add(6, "strong ad identifier");
    else if (EXPLICIT_ATTRIBUTE_RE.test(corpus) && !FALSE_ATTRIBUTE_RE.test(corpus)) add(4, "ad-like identifier");

    const adSurface = AD_SURFACE_RE.test(corpus);
    const floatingPromo = FLOATING_PROMO_RE.test(corpus);
    const socialPromo = SOCIAL_PROMO_RE.test(corpus);
    if (adSurface) add(7, "advertising overlay or interstitial");
    if (floatingPromo) add(7, "floating promotional widget");
    if (socialPromo) add(7, "social-media promotion widget");
    if (COMPANION_AD_RE.test(corpus)) add(9, "video companion advertisement");
    if (BACKGROUND_SKIN_RE.test(corpus)) add(7, "advertising page skin");
    if ((adSurface || floatingPromo) && /\bposition\s*:\s*(?:fixed|sticky)\b/i.test(inlineStyle)) {
      add(2, "floating overlay presentation");
    }

    if (hasMarkerText(element)) add(5, `disclosure label: ${text.slice(0, 40)}`);

    if (urls.some(isKnownAdUrl)) add(8, "known ad-network URL");
    else if (urls.some((url) => URL_AD_HINT_RE.test(String(url)))) add(3, "ad-like resource URL");

    if (hasTinyResourceBox(element) && urls.some((url) => isKnownAdUrl(url) || TRACKING_URL_HINT_RE.test(String(url)))) {
      add(9, "tracking pixel or beacon");
    }

    const actionLure = ["a", "button"].includes(tag) && fullText.length <= 80 && ACTION_LURE_RE.test(fullText);
    const fakeActionIdentifier = FAKE_ACTION_IDENTIFIER_RE.test(corpus);
    const suspiciousActionUrl = urls.some((url) => isKnownAdUrl(url) || URL_AD_HINT_RE.test(String(url)) || REDIRECT_PATH_RE.test(parseHttpUrl(url)?.pathname || ""));
    if (fakeActionIdentifier) add(7, "deceptive media or download control");
    if (actionLure && suspiciousActionUrl) add(4, "action control points to advertising redirect");
    if (actionLure && fakeActionIdentifier && String(element.getAttribute("target") || "").toLowerCase() === "_blank") {
      add(2, "deceptive action opens a new tab");
    }

    if (/background(?:-image)?\s*:/i.test(inlineStyle) && urls.some((url) => isKnownAdUrl(url) || URL_AD_HINT_RE.test(String(url)))) {
      add(4, "advertising background image");
    }

    if (tag === "iframe" && urls.some((url) => /(?:\/ads?\/|\/pagead\/|adserver)/i.test(String(url)))) {
      add(4, "advertising iframe");
    }

    if (hasAdSizedBox(element)) add(1, "common ad dimensions");

    const parent = element.parentElement;
    const parentCorpus = getAttributeCorpus(parent);
    if (hasMarkerText(element) && CARD_HINT_RE.test(parentCorpus)) add(2, "disclosure inside feed card");

    if (fullText.length > 700 && score < 8) add(-4, "long editorial content");

    if (typeof element.closest === "function" && element.closest("header,nav,[role='navigation']") && score < 8) {
      add(-3, "navigation context");
    }

    if (isProtectedUiElement(element) && !explicitAdAttribute && !urls.some(isKnownAdUrl)) {
      add(-Math.max(12, score), "authentication or security interface");
    }

    return { score: Math.max(0, score), signals };
  }

  function isContainerCandidate(element) {
    if (!element || element.nodeType !== 1) return false;
    const tag = tagNameOf(element);
    if (["article", "aside", "li"].includes(tag)) return true;
    if (tag !== "div" && tag !== "section") return false;
    const corpus = getAttributeCorpus(element);
    return CARD_HINT_RE.test(corpus) || STRONG_ATTRIBUTE_RE.test(corpus) || EXPLICIT_ATTRIBUTE_RE.test(corpus);
  }

  function resolveContainer(element) {
    if (!element || element.nodeType !== 1) return null;
    const tag = tagNameOf(element);
    if (["iframe", "ins", "img", "video"].includes(tag)) return element;

    let current = element;
    let fallback = element;
    for (let depth = 0; current && depth <= 7; depth += 1) {
      const currentTag = tagNameOf(current);
      if (["body", "html", "main"].includes(currentTag)) break;

      const textLength = normalizeText(current.textContent || "").length;
      const ownResult = scoreCandidate(current);
      const hasStrongOwnSignal = ownResult.signals.some((item) => item.points >= 6);
      if (hasStrongOwnSignal && textLength < 2400) return current;
      if (isContainerCandidate(current) && textLength < 1800) fallback = current;
      current = current.parentElement;
    }
    return fallback;
  }

  function classify(element, levelOrThreshold) {
    const threshold = typeof levelOrThreshold === "number"
      ? levelOrThreshold
      : LEVEL_THRESHOLDS[levelOrThreshold] || LEVEL_THRESHOLDS.balanced;
    const result = scoreCandidate(element);
    return {
      ...result,
      threshold,
      blocked: result.score >= threshold,
      container: result.score >= threshold ? resolveContainer(element) : null
    };
  }

  function parseHttpUrl(value, baseUrl) {
    const rawValue = String(value || "");
    if (rawValue.length > MAX_REDIRECT_VALUE_LENGTH) return null;
    try {
      const parsed = new URL(rawValue, baseUrl || "https://example.invalid/");
      return ["http:", "https:"].includes(parsed.protocol) ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  function decodeNestedValue(value) {
    let decoded = String(value || "");
    if (decoded.length > MAX_REDIRECT_VALUE_LENGTH) return "";
    for (let index = 0; index < 2; index += 1) {
      try {
        const next = decodeURIComponent(decoded);
        if (next.length > MAX_REDIRECT_VALUE_LENGTH) return "";
        if (next === decoded) break;
        decoded = next;
      } catch (_error) {
        break;
      }
    }
    return decoded;
  }

  function collectNestedRedirects(rootUrl, baseUrl) {
    const queue = [{ url: rootUrl, depth: 0 }];
    const seen = new Set([rootUrl.href]);
    const nested = [];

    while (queue.length && seen.size < MAX_REDIRECT_URLS) {
      const current = queue.shift();
      if (current.depth >= MAX_REDIRECT_DEPTH) continue;

      for (const [key, rawValue] of current.url.searchParams) {
        if (seen.size >= MAX_REDIRECT_URLS) break;
        if (!REDIRECT_KEYS.has(key.toLowerCase())) continue;
        const decoded = decodeNestedValue(rawValue);
        if (!decoded) continue;
        const url = parseHttpUrl(decoded, current.url.href || baseUrl);
        if (!url || seen.has(url.href)) continue;
        seen.add(url.href);
        const item = { url, parent: current.url, depth: current.depth + 1 };
        nested.push(item);
        queue.push(item);
      }
    }

    return nested;
  }

  function isProtectedNavigationUrl(url) {
    return Boolean(url && PROTECTED_NAVIGATION_RE.test(url.pathname));
  }

  function hasStrongAffiliateSignal(url) {
    if (!url) return false;
    if (AFFILIATE_PATH_RE.test(url.pathname)) return true;
    for (const [key, value] of url.searchParams) {
      const normalizedKey = key.toLowerCase();
      if (STRONG_AFFILIATE_KEYS.has(normalizedKey)) return true;
      if (["utm_medium", "utm_source", "source"].includes(normalizedKey) && AFFILIATE_VALUE_RE.test(value)) return true;
    }
    return false;
  }

  function analyzeNavigation(value, options = {}) {
    const baseUrl = options.baseUrl || (typeof location !== "undefined" ? location.href : "https://example.invalid/");
    const parsed = parseHttpUrl(value, baseUrl);
    if (!parsed) return { blocked: false, score: 0, reasons: [], url: "", hostname: "" };

    const currentHostname = String(options.currentHostname || parseHttpUrl(baseUrl)?.hostname || "").toLowerCase();
    const customDomains = Array.isArray(options.customBlockDomains) ? options.customBlockDomains : [];
    const blockedDomains = [...ALWAYS_ON_HOSTS, ...customDomains];
    const targetIsBlocked = blockedDomains.some((domain) => hostnameMatches(parsed.hostname, domain));
    const sameSite = hostnameMatches(parsed.hostname, currentHostname) || hostnameMatches(currentHostname, parsed.hostname);
    const rel = String(options.rel || "");
    const target = String(options.target || "");
    const linkText = normalizeText(options.linkText || "");
    const ariaLabel = normalizeText(options.ariaLabel || "");
    const linkClass = normalizeText(options.className || "");
    const protectedNavigation = isProtectedNavigationUrl(parsed);
    const affiliateSignal = hasStrongAffiliateSignal(parsed);
    const directDownload = DIRECT_DOWNLOAD_RE.test(`${parsed.pathname}${parsed.search}`);
    let score = 0;
    const reasons = [];
    const add = (points, reason) => { score += points; reasons.push({ reason, points }); };

    if (targetIsBlocked) add(12, "known advertising destination");
    if (!sameSite && !protectedNavigation && URL_AD_HINT_RE.test(`${parsed.pathname}${parsed.search}`)) add(2, "advertising URL pattern");
    if (!sameSite && !protectedNavigation && REDIRECT_PATH_RE.test(parsed.pathname)) add(4, "external redirect path");
    if (!protectedNavigation && /\bsponsored\b/i.test(rel)) add(8, "sponsored link");
    if (!sameSite && !protectedNavigation && affiliateSignal) add(11, "affiliate tracking destination");
    if (!sameSite && target.toLowerCase() === "_blank") add(1, "opens a new tab");

    const actionLure = [linkText, ariaLabel].some((label) => label.length > 0 && label.length <= 100 && ACTION_LURE_RE.test(label));
    const suspiciousAction = FAKE_ACTION_IDENTIFIER_RE.test(linkClass)
      || URL_AD_HINT_RE.test(`${parsed.pathname}${parsed.search}`)
      || REDIRECT_PATH_RE.test(parsed.pathname)
      || affiliateSignal;
    if (!sameSite && !protectedNavigation && !directDownload && target.toLowerCase() === "_blank" && actionLure) {
      add(suspiciousAction ? 8 : 4, suspiciousAction
        ? "deceptive external action button"
        : "external action button");
    }

    let foundExternalRedirectWrapper = false;
    let nestedAffiliateDestination = false;
    let nestedAdvertisingDestination = false;
    for (const item of collectNestedRedirects(parsed, baseUrl)) {
      const nestedIsExternal = !(
        hostnameMatches(item.url.hostname, currentHostname) || hostnameMatches(currentHostname, item.url.hostname)
      );
      const nestedIsProtected = isProtectedNavigationUrl(item.url);
      if (nestedIsExternal && !nestedIsProtected && REDIRECT_PATH_RE.test(item.parent.pathname)) {
        foundExternalRedirectWrapper = true;
      }
      if (nestedIsExternal && !nestedIsProtected && hasStrongAffiliateSignal(item.url)) {
        nestedAffiliateDestination = true;
      }
      if (blockedDomains.some((domain) => hostnameMatches(item.url.hostname, domain))) {
        nestedAdvertisingDestination = true;
      }
    }
    if (nestedAdvertisingDestination) add(11, "redirects through an advertising destination");
    if (!protectedNavigation && foundExternalRedirectWrapper) {
      add(4, "external redirect wrapper");
    }
    if (!protectedNavigation && nestedAffiliateDestination) add(7, "redirects through an affiliate destination");

    const level = ["relaxed", "balanced", "strict"].includes(options.level) ? options.level : "balanced";
    const threshold = REDIRECT_THRESHOLDS[level];
    return {
      blocked: score >= threshold,
      score,
      threshold,
      reasons,
      url: parsed.href,
      hostname: parsed.hostname
    };
  }

  return Object.freeze({
    VERSION,
    LEVEL_THRESHOLDS,
    REDIRECT_THRESHOLDS,
    KNOWN_AD_HOSTS,
    ALWAYS_ON_HOSTS,
    CANDIDATE_SELECTOR,
    MARKER_RE,
    normalizeText,
    hostnameMatches,
    isKnownAdUrl,
    hasMarkerText,
    isAntiAdblockMessage,
    isLikelyAdblockBait,
    scoreCandidate,
    resolveContainer,
    classify,
    analyzeNavigation
  });
});
