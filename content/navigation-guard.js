(function protectAgainstAdPopups() {
  "use strict";

  const VERSION = "2.0.0";
  const OPEN_SHADOW_EVENT = "aas:open-shadow-root";
  const channel = document.documentElement?.getAttribute("data-aas-config-channel") || "";
  const CONFIG_EVENT = channel ? `aas:config:${channel}` : "aas:redirect-config";
  const CLOAK_EVENT = `${CONFIG_EVENT}:native`;

  function lookupNative(candidate) {
    if (typeof candidate !== "function") return null;
    const detail = { mode: "lookup", candidate, native: null };
    try { document.dispatchEvent(new CustomEvent(CLOAK_EVENT, { detail })); } catch (_error) { return null; }
    return typeof detail.native === "function" ? detail.native : null;
  }

  function registerNative(wrapper, nativeFunction) {
    const detail = { mode: "register", wrapper, native: nativeFunction, registered: false };
    try { document.dispatchEvent(new CustomEvent(CLOAK_EVENT, { detail })); } catch (_error) { return false; }
    return detail.registered === true;
  }

  function installOpenShadowRootAnnouncer() {
    const prototype = globalThis.Element?.prototype;
    const existingAttachShadow = prototype?.attachShadow;
    if (typeof existingAttachShadow !== "function" ||
        lookupNative(existingAttachShadow) ||
        existingAttachShadow.__adLockShadowGuardVersion === VERSION) return;

    const nativeAttachShadow = existingAttachShadow.__adLockNativeAttachShadow || existingAttachShadow;
    function guardedAttachShadow() {
      const root = Reflect.apply(nativeAttachShadow, this, arguments);
      if (root?.mode === "open") {
        try {
          this.dispatchEvent(new CustomEvent(OPEN_SHADOW_EVENT));
        } catch (_error) {
          // Shadow creation must never fail because the observer announcement failed.
        }
      }
      return root;
    }

    if (!registerNative(guardedAttachShadow, nativeAttachShadow)) {
      Object.defineProperties(guardedAttachShadow, {
        __adLockShadowGuardVersion: { value: VERSION },
        __adLockNativeAttachShadow: { value: nativeAttachShadow }
      });
    }
    try {
      prototype.attachShadow = guardedAttachShadow;
    } catch (_error) {
      // A page may lock the prototype; normal bounded discovery remains available.
    }
  }

  installOpenShadowRootAnnouncer();
  const existingOpen = window.open;
  if (lookupNative(existingOpen) || existingOpen?.__adLockGuardVersion === VERSION) {
    try { delete globalThis.AdLockDomainData; } catch (_error) { /* Best-effort startup cleanup. */ }
    return;
  }

  const fallbackRedirectHosts = [
    "adangle.online", "adsrvr.org", "doubleclick.net", "googlesyndication.com",
    "popads.net", "taboola.com"
  ];
  const AD_HOSTS = Object.freeze(
    Array.isArray(globalThis.AdLockDomainData?.redirectDomains) &&
      globalThis.AdLockDomainData.redirectDomains.length
      ? [...globalThis.AdLockDomainData.redirectDomains]
      : fallbackRedirectHosts
  );
  const REDIRECT_KEYS = new Set(["adurl", "dest", "destination", "redirect", "redirect_url", "target", "to", "url"]);
  const MAX_REDIRECT_DEPTH = 3;
  const MAX_REDIRECT_URLS = 8;
  const MAX_REDIRECT_VALUE_LENGTH = 4096;
  const PROTECTED_POPUP_HOSTS = [
    "accounts.google.com", "login.microsoftonline.com", "appleid.apple.com",
    "paypal.com", "stripe.com", "checkout.com"
  ];
  const PROTECTED_POPUP_PATH_RE = /\/(?:3ds|auth|authorize|callback|checkout|login|oauth|payment|signin|sso)(?:\/|$)/i;
  const nativeOpen = existingOpen?.__adLockNativeOpen || existingOpen;
  let expectedPopup = null;
  // Fail closed until the isolated-world settings handshake arrives.
  let enabled = true;

  function hostMatches(hostname, domain) {
    return hostname === domain || hostname.endsWith(`.${domain}`);
  }

  function parse(value, baseUrl = location.href) {
    const rawValue = String(value || "");
    if (rawValue.length > MAX_REDIRECT_VALUE_LENGTH) return null;
    try {
      const url = new URL(rawValue, baseUrl);
      return ["http:", "https:"].includes(url.protocol) ? url : null;
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

  function isAdvertisingDestination(value) {
    const rootUrl = parse(value);
    if (!rootUrl) return false;
    const queue = [{ url: rootUrl, depth: 0 }];
    const seen = new Set([rootUrl.href]);

    while (queue.length) {
      const current = queue.shift();
      if (AD_HOSTS.some((domain) => hostMatches(current.url.hostname, domain))) return true;
      if (current.depth >= MAX_REDIRECT_DEPTH || seen.size >= MAX_REDIRECT_URLS) continue;

      for (const [key, rawValue] of current.url.searchParams) {
        if (seen.size >= MAX_REDIRECT_URLS) break;
        if (!REDIRECT_KEYS.has(key.toLowerCase())) continue;
        const decoded = decodeNestedValue(rawValue);
        if (!decoded) continue;
        const nested = parse(decoded, current.url.href);
        if (!nested || seen.has(nested.href)) continue;
        seen.add(nested.href);
        queue.push({ url: nested, depth: current.depth + 1 });
      }
    }
    return false;
  }

  function isExternalDestination(value) {
    const url = parse(value);
    if (!url) return false;
    const current = location.hostname.toLowerCase();
    return !(hostMatches(url.hostname, current) || hostMatches(current, url.hostname));
  }

  function opaquePopupKind(value) {
    const rawValue = String(value ?? "").trim();
    if (!rawValue || /^about:blank(?:[?#]|$)/i.test(rawValue)) return "blank";
    return parse(rawValue) ? "" : "unsafe";
  }

  function isKnownBadInternalPath(value) {
    const url = parse(value);
    return Boolean(url && hostMatches(url.hostname, "net77.cc") && /\/you-idiot\.html$/i.test(url.pathname));
  }

  function isProtectedPopupProvider(value) {
    const url = parse(value);
    if (!url) return false;
    return PROTECTED_POPUP_HOSTS.some((domain) => hostMatches(url.hostname, domain));
  }

  function isProtectedPopupContext() {
    const currentHost = String(location.hostname || "").toLowerCase();
    return PROTECTED_POPUP_HOSTS.some((domain) => hostMatches(currentHost, domain)) ||
      PROTECTED_POPUP_PATH_RE.test(String(location.pathname || ""));
  }

  function isPopupTarget(value) {
    const target = String(value || "").trim().toLowerCase();
    return Boolean(target) && !["_self", "_parent", "_top"].includes(target);
  }

  function shouldBlockFormSubmission(form, submitter) {
    const action = submitter?.formAction || form?.action || location.href;
    const target = submitter?.formTarget || form?.target || "";
    const protectedDestination = isProtectedPopupProvider(action);
    const unexpectedExternalPopup = isPopupTarget(target) && isExternalDestination(action) && !protectedDestination;
    return enabled && (isAdvertisingDestination(action) || unexpectedExternalPopup || isKnownBadInternalPath(action));
  }

  function installFormSubmissionGuard(methodName) {
    const prototype = globalThis.HTMLFormElement?.prototype;
    const existingMethod = prototype?.[methodName];
    if (typeof existingMethod !== "function" || lookupNative(existingMethod) || existingMethod.__adLockFormGuardVersion === VERSION) return;

    const nativeMethod = existingMethod.__adLockNativeFormMethod || existingMethod;
    function guardedFormSubmission() {
      const submitter = methodName === "requestSubmit" ? arguments[0] : null;
      if (shouldBlockFormSubmission(this, submitter)) return undefined;
      return Reflect.apply(nativeMethod, this, arguments);
    }

    if (!registerNative(guardedFormSubmission, nativeMethod)) {
      Object.defineProperties(guardedFormSubmission, {
        __adLockFormGuardVersion: { value: VERSION },
        __adLockNativeFormMethod: { value: nativeMethod }
      });
    }
    try {
      prototype[methodName] = guardedFormSubmission;
    } catch (_error) {
      // Locked prototypes retain normal event-based and network-level protection.
    }
  }

  function isTrustedActivation(event) {
    if (event?.isTrusted !== true) return false;
    if (event.type === "keydown") return event.key === "Enter" && !event.repeat;
    return event.button === 0;
  }

  function rememberExpectedPopup(event) {
    if (!isTrustedActivation(event)) return;
    const anchor = event.composedPath?.().find((node) =>
      ["A", "AREA"].includes(node?.tagName) && node.href
    );
    const url = anchor ? parse(anchor.href) : null;
    expectedPopup = url ? { href: url.href, expiresAt: Date.now() + 1600 } : null;
  }

  function consumeExpectedPopup(value) {
    const url = parse(value);
    if (!url || !expectedPopup) return false;
    if (expectedPopup.expiresAt < Date.now()) {
      expectedPopup = null;
      return false;
    }
    if (url.href !== expectedPopup.href) return false;
    expectedPopup = null;
    return true;
  }

  document.addEventListener("pointerdown", rememberExpectedPopup, true);
  document.addEventListener("keydown", rememberExpectedPopup, true);

  document.addEventListener(CONFIG_EVENT, (event) => {
    const pageEnabled = event.detail?.enabled;
    const redirectProtection = event.detail?.redirectProtection;
    if (typeof pageEnabled !== "boolean" || typeof redirectProtection !== "boolean") return;
    enabled = pageEnabled && redirectProtection;
  });

  function guardedOpen(url, target, features) {
    const externalDestination = isExternalDestination(url);
    const opaqueKind = opaquePopupKind(url);
    const userActive = Boolean(globalThis.navigator?.userActivation?.isActive);
    const expectedPopupDestination = consumeExpectedPopup(url);
    const protectedPopupDestination = isProtectedPopupProvider(url);
    const unexpectedClickPopup = externalDestination && userActive && !expectedPopupDestination && !protectedPopupDestination;
    const unsolicitedExternalPopup = externalDestination && !userActive && !expectedPopupDestination && !protectedPopupDestination;
    const protectedBlankHandoff = opaqueKind === "blank" && userActive && isProtectedPopupContext();
    const opaquePopupBypass = opaqueKind === "unsafe" || (opaqueKind === "blank" && !protectedBlankHandoff);
    if (enabled && (isAdvertisingDestination(url) || unexpectedClickPopup || unsolicitedExternalPopup || opaquePopupBypass || isKnownBadInternalPath(url))) return null;
    return Reflect.apply(nativeOpen, window, [url, target, features]);
  }

  if (!registerNative(guardedOpen, nativeOpen)) {
    Object.defineProperties(guardedOpen, {
      __adLockGuardVersion: { value: VERSION },
      __adLockNativeOpen: { value: nativeOpen }
    });
  }
  window.open = guardedOpen;
  installFormSubmissionGuard("submit");
  installFormSubmissionGuard("requestSubmit");
  try { delete globalThis.AdLockDomainData; } catch (_error) { /* The guards already hold private copies. */ }
})();
