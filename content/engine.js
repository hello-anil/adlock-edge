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

  const VERSION = "2.1.8";

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
  const AD_HOST_SET = new Set(KNOWN_AD_HOSTS);
  const ALWAYS_ON_HOST_SET = new Set(ALWAYS_ON_HOSTS);

  const CANDIDATE_SELECTOR = [
    "ins.adsbygoogle",
    "iframe[src]",
    "iframe[src*='doubleclick.net']",
    "iframe[src*='googlesyndication.com']",
    "iframe[src*='/pagead/']",
    "iframe[src*='/ads/']",
    "[data-ad]",
    "[data-ad-slot]",
    "[data-ad-unit]",
    "[data-ad-type]",
    "[data-ad-format]",
    "[data-advertisement]",
    "[data-sponsored]",
    "[data-promoted]",
    "[data-social-promo]",
    "[aria-label*='advertisement' i]",
    "[aria-label*='sponsored' i]",
    "[aria-label*='promoted' i]",
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
  const PROMOTION_FLAG_ATTRIBUTES = Object.freeze(["data-sponsored", "data-promoted", "data-social-promo"]);
  const NEGATED_PROMOTION_FLAG_RE = /^(?:false|0)$/i;
  const FALSE_ATTRIBUTE_RE = /(?:shadow|address|download|adapter|admin|badge|header|breadcrumb|thread|read-more)/i;
  const MARKER_RE = /^(?:ad|ads|advert|advertisement|advertising|paid content|promoted|sponsored)(?:\s*[·•|:].*|\s+-\s+.*)?$/i;
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
  const ANTI_ADBLOCK_TEXT_RE = /(?:\bad[ -]?block(?:er|ing)?\b|\bads?\s+(?:are|is|were|must be)\s+blocked|\bdns\s+blocking\b)/i;
  const ANTI_ADBLOCK_DIRECTIVE_RE = /(?:\b(?:disable|deactivate|pause|remove|turn\s+off)\b.{0,60}\b(?:ad[ -]?block(?:er|ing)?|blocking)\b|\b(?:ad[ -]?block(?:er|ing)?|blocking)\b.{0,80}\b(?:disable|deactivate|turn\s+off)\b|\bwhitelist\b.{0,40}\b(?:site|domain|us)\b|\b(?:allow|enable)\s+ads?\b)/i;
  const ANTI_ADBLOCK_ACCESS_RE = /(?:\b(?:disable|whitelist|allow|enable)\b.{0,60}\b(?:to\s+(?:continue|proceed|access|watch)|before\s+(?:continuing|proceeding))\b|\b(?:cannot|can't|unable\s+to)\s+(?:continue|proceed|access|watch)\b|\b(?:access|content|video|playback)\s+(?:is\s+)?(?:blocked|unavailable)\b|\b(?:ad[ -]?block(?:er|ing)?)\b.{0,80}\b(?:prevent(?:s|ing)|block(?:s|ing))\b.{0,40}\b(?:access|watching|viewing|playback)\b)/i;
  const HOSTNAME_TEXT_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\.?$/i;
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

  // Limit both characters and visited nodes: textContent on a feed ancestor
  // otherwise copies the entire subtree before a caller can truncate it.
  function readText(element, limit = 4096) {
    if (!element) return "";
    const document = element.ownerDocument;
    if (typeof document?.createTreeWalker !== "function") {
      return String(element.textContent || "").slice(0, limit + 1);
    }
    const walker = document.createTreeWalker(element, 5); // SHOW_ELEMENT | SHOW_TEXT
    let text = "";
    let visited = 0;
    let node;
    while ((node = walker.nextNode())) {
      if (++visited > 256) return text.padEnd(limit + 1, "\ufffc");
      if (node.nodeType === 3) {
        text += String(node.nodeValue || "").slice(0, limit + 1 - text.length);
        if (text.length > limit) return text;
      }
    }
    return text;
  }

  function isAntiAdblockMessage(value) {
    const text = normalizeText(value);
    return text.length >= 12 && text.length <= 2400 && ANTI_ADBLOCK_TEXT_RE.test(text) &&
      (ANTI_ADBLOCK_DIRECTIVE_RE.test(text) || ANTI_ADBLOCK_ACCESS_RE.test(text)) && !SECURITY_CHALLENGE_RE.test(text);
  }

  function isLikelyAdblockBait(element) {
    if (!element || element.nodeType !== 1) return false;
    const corpus = getAttributeCorpus(element);
    if (!ADBLOCK_BAIT_RE.test(corpus)) return false;
    const text = normalizeText(readText(element));
    if (text.length > 80) return false;
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
      return matchesHostSet(host, AD_HOST_SET);
    } catch (_error) {
      return false;
    }
  }

  function matchesHostSet(hostname, hosts) {
    let host = String(hostname || "").toLowerCase().replace(/\.$/, "");
    while (host) {
      if (hosts.has(host)) return true;
      const dot = host.indexOf(".");
      if (dot < 0) break;
      host = host.slice(dot + 1);
    }
    return false;
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

  function ownText(element, sampledText) {
    if (!element) return "";
    let text = "";
    const nodes = element.childNodes || [];
    for (let index = 0; index < Math.min(nodes.length, 256); index += 1) {
      const node = nodes[index];
      if (node && node.nodeType === 3) text += ` ${String(node.nodeValue || "").slice(0, 4097 - text.length)}`;
      if (text.length > 4096) break;
    }
    return normalizeText(text || (sampledText === undefined ? readText(element) : sampledText));
  }

  function hasMarkerText(element, sampledText) {
    const text = ownText(element, sampledText);
    return text.length > 0 && text.length <= 80 && MARKER_RE.test(text);
  }

  function hasExplicitAdAttribute(element) {
    return [
      "data-ad", "data-ad-slot", "data-ad-unit", "data-advertisement", "data-companion-ad", "data-ad-background",
      "data-ad-type", "data-ad-format"
    ].some((name) => element?.hasAttribute?.(name)) ||
      PROMOTION_FLAG_ATTRIBUTES.some((name) => {
        const value = element?.getAttribute?.(name);
        // Presence-style flags remain supported, but an explicit false value
        // on an ordinary feed card is not advertising evidence.
        return value != null && !NEGATED_PROMOTION_FLAG_RE.test(String(value).trim());
      });
  }

  function hasHighConfidenceAdEvidence(element, allowDisclosureAria = false) {
    const corpus = getAttributeCorpus(element);
    const aria = normalizeText(element?.getAttribute?.("aria-label"));
    return hasExplicitAdAttribute(element) || STRONG_ATTRIBUTE_RE.test(corpus) ||
      AD_SURFACE_RE.test(corpus) || FLOATING_PROMO_RE.test(corpus) || SOCIAL_PROMO_RE.test(corpus) ||
      COMPANION_AD_RE.test(corpus) || BACKGROUND_SKIN_RE.test(corpus) ||
      (/\b(?:advertisement|sponsored|promoted)\b/i.test(aria) && !(allowDisclosureAria && MARKER_RE.test(aria))) ||
      elementUrls(element).some(isKnownAdUrl) ||
      (tagNameOf(element) === "a" && /(?:^|\s)sponsored(?:\s|$)/i.test(element.getAttribute("rel") || ""));
  }

  function isEditorialMarkerLink(element, markerText) {
    if (tagNameOf(element) !== "a" || hasHighConfidenceAdEvidence(element, true)) return false;
    const href = element.getAttribute("href");
    return Boolean(href && parseHttpUrl(href) &&
      normalizeText(readText(element)) === markerText && !hasHighConfidenceAdEvidence(element.parentElement));
  }

  // A disclosure-shaped word inside a reference link belongs to that link.
  // Its inline children and otherwise empty wrappers must not independently
  // turn the same word back into an advertisement.
  function hasEditorialMarkerContext(element, markerText) {
    if (hasEditorialFormattingContext(element, markerText)) return true;
    let current = element;
    for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
      if (tagNameOf(current) === "a") return isEditorialMarkerLink(current, markerText);
      if (hasHighConfidenceAdEvidence(current) || normalizeText(readText(current)) !== markerText) break;
    }
    current = element;
    for (let depth = 0; current && depth < 5; depth += 1) {
      if (tagNameOf(current) === "a") return isEditorialMarkerLink(current, markerText);
      if (hasHighConfidenceAdEvidence(current) || current.children?.length !== 1 ||
          normalizeText(readText(current)) !== markerText) return false;
      current = current.children[0];
    }
    return false;
  }

  function hasEditorialFormattingContext(element, markerText) {
    let formatted = false;
    let current = element;
    // A title wrapper can own only the formatted word, with no direct text.
    for (let depth = 0; current && depth < 5; depth += 1) {
      if (/^(?:b|strong|i|em|cite|h[1-6])$/.test(tagNameOf(current))) {
        formatted = true;
        break;
      }
      if (current.children?.length !== 1 || normalizeText(readText(current)) !== markerText) break;
      current = current.children[0];
    }
    current = element;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
      const tag = tagNameOf(current);
      if (["body", "html", "main"].includes(tag)) break;
      const corpus = getAttributeCorpus(current);
      if (hasHighConfidenceAdEvidence(current) ||
          (current !== element && EXPLICIT_ATTRIBUTE_RE.test(corpus) && !FALSE_ATTRIBUTE_RE.test(corpus)) ||
          /(?:^|[\s_-])(?:feed|(?:article|product|story)[-_]?card)(?:[\s_-]|$)/i.test(corpus)) return false;
      if (/^(?:b|strong|i|em|cite|h[1-6])$/.test(tag)) formatted = true;
      if (isNavigationContainer(current)) formatted = true;
    }
    return formatted;
  }

  function isNavigationContainer(element) {
    return ["header", "nav"].includes(tagNameOf(element)) ||
      ["banner", "navigation", "search"].includes(element?.getAttribute?.("role")) ||
      /(?:^|[\s_-])(?:header|navbar|navigation)(?:[\s_-]|$)/i.test(getAttributeCorpus(element));
  }

  // A list describing hosts is content, while actual resource destinations and
  // ad metadata remain advertising evidence. Inspect text nodes separately so
  // adjacent labels do not need spaces inserted by the page's markup.
  function isInformationalHostList(element) {
    const pending = [element];
    let hosts = 0;
    let visited = 0;
    let textNodes = 0;
    while (pending.length) {
      if (++visited > 256) return false;
      const current = pending.pop();
      if (!current || current.nodeType !== 1) continue;
      if (hasHighConfidenceAdEvidence(current)) return false;
      if ((current.childNodes?.length || 0) > 256) return false;
      for (const node of current.childNodes || []) {
        if (node.nodeType !== 3) continue;
        const value = String(node.nodeValue || "");
        if (value.length > 253) continue;
        const label = normalizeText(value);
        // Formatting whitespace around SVG status icons is not another label.
        // Element and child-list limits still bound the traversal independently.
        if (!label) continue;
        if (++textNodes > 256) return false;
        if (HOSTNAME_TEXT_RE.test(label)) hosts += 1;
      }
      if (pending.length + (current.children?.length || 0) + visited > 256) return false;
      for (const child of current.children || []) pending.push(child);
    }
    return hosts >= 2;
  }

  function hasInformationalHostContext(element) {
    let current = element;
    for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
      if (hasHighConfidenceAdEvidence(current)) return false;
      if (["body", "html", "main"].includes(tagNameOf(current))) return false;
      const corpus = getAttributeCorpus(current);
      const weakIdentifier = EXPLICIT_ATTRIBUTE_RE.test(corpus) && !FALSE_ATTRIBUTE_RE.test(corpus);
      if ((current === element || weakIdentifier) && isInformationalHostList(current)) return true;
    }
    return false;
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

  function isProtectedUiElement(element, sampledText, sampledCorpus) {
    const corpus = sampledCorpus === undefined ? getAttributeCorpus(element) : sampledCorpus;
    const text = sampledText === undefined ? normalizeText(readText(element)) : sampledText;
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
    const fullText = normalizeText(readText(element));
    const text = ownText(element, fullText);
    const urls = elementUrls(element);
    const inlineStyle = normalizeText(element.getAttribute && element.getAttribute("style"));
    const explicitAdAttribute = hasExplicitAdAttribute(element);
    const aria = normalizeText(element.getAttribute && element.getAttribute("aria-label"));
    const adAccessibility = /\b(?:advertisement|sponsored|promoted)\b/i.test(aria);
    const marker = text.length > 0 && text.length <= 80 && MARKER_RE.test(text);
    const knownAdUrl = urls.some(isKnownAdUrl);
    const strongIdentifier = STRONG_ATTRIBUTE_RE.test(corpus);
    const parent = element.parentElement;
    const parentCorpus = marker ? getAttributeCorpus(parent) : "";
    const sponsoredRelation = tag === "a" && /(?:^|\s)sponsored(?:\s|$)/i.test(String(element.getAttribute("rel") || ""));
    const editorialLink = marker && fullText === text && !explicitAdAttribute && !strongIdentifier && !knownAdUrl &&
      hasEditorialMarkerContext(element, text);
    const weakAdIdentifier = EXPLICIT_ATTRIBUTE_RE.test(corpus) && !FALSE_ATTRIBUTE_RE.test(corpus);
    const informationalHostText = !explicitAdAttribute && !strongIdentifier && !knownAdUrl && !adAccessibility &&
      (HOSTNAME_TEXT_RE.test(fullText) || (weakAdIdentifier && isInformationalHostList(element)) ||
        (marker && hasInformationalHostContext(element)));

    const add = (points, signal) => {
      score += points;
      signals.push({ signal, points });
    };

    if (tag === "ins" && /adsbygoogle/i.test(corpus)) add(9, "adsbygoogle element");
    if (explicitAdAttribute) {
      add(9, "explicit ad data attribute");
    }

    if (adAccessibility &&
        !(editorialLink && MARKER_RE.test(aria))) add(7, "ad accessibility label");
    if (sponsoredRelation) add(7, "sponsored link relation");

    if (strongIdentifier) add(6, "strong ad identifier");
    else if (weakAdIdentifier && !editorialLink && !informationalHostText) add(4, "ad-like identifier");

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

    if (marker && !editorialLink && !informationalHostText) add(5, `disclosure label: ${text.slice(0, 40)}`);

    if (knownAdUrl) add(8, "known ad-network URL");
    else if (urls.some((url) => URL_AD_HINT_RE.test(String(url)))) add(3, "ad-like resource URL");

    if (urls.some((url) => isKnownAdUrl(url) || TRACKING_URL_HINT_RE.test(String(url))) && hasTinyResourceBox(element)) {
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

    // Dimensions are only supporting evidence. Once semantic evidence already
    // clears every mode, avoid forcing layout between successive hide writes.
    if (!editorialLink && score < LEVEL_THRESHOLDS.relaxed && hasAdSizedBox(element)) add(1, "common ad dimensions");

    if (marker && !editorialLink && !informationalHostText && CARD_HINT_RE.test(parentCorpus)) add(2, "disclosure inside feed card");

    if (fullText.length > 700 && score < 8) add(-4, "long editorial content");

    if (typeof element.closest === "function" && element.closest("header,nav,[role='navigation']") && score < 8) {
      add(-3, "navigation context");
    }

    if (isProtectedUiElement(element, fullText, corpus) && !explicitAdAttribute && !knownAdUrl) {
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
      // A descendant disclosure must not promote the whole navigation bar.
      if (isNavigationContainer(current) && !hasHighConfidenceAdEvidence(current)) break;

      const textLength = normalizeText(readText(current)).length;
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
    const isBlockedHost = (host) => matchesHostSet(host, ALWAYS_ON_HOST_SET) ||
      customDomains.some((domain) => hostnameMatches(host, domain));
    const targetIsBlocked = isBlockedHost(parsed.hostname);
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
      if (isBlockedHost(item.url.hostname)) {
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
    readText,
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
