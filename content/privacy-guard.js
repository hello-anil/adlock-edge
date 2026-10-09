(function installAdLockPrivacyGuard() {
  "use strict";

  const VERSION = "2.1.8";
  const CHANNEL_ATTRIBUTE = "data-aas-config-channel";
  const rootElement = document.documentElement;
  // HTML attributes belong to the website. Never reuse a page-selected secret.
  let channel = "";
  if (rootElement) {
    const random = new Uint32Array(3);
    try {
      globalThis.crypto.getRandomValues(random);
      channel = [...random].map((value) => value.toString(36)).join("");
    } catch (_error) {
      channel = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    }
    rootElement.setAttribute(CHANNEL_ATTRIBUTE, channel);
  }
  const CONFIG_EVENT = channel ? `aas:config:${channel}` : "aas:privacy-config";
  const CLOAK_EVENT = `${CONFIG_EVENT}:native`;

  const configuration = {
    enabled: false,
    level: "strict",
    cleanTrackingParameters: true,
    privacyApiProtection: true,
    fingerprintProtection: true
  };
  const domainData = globalThis.AdLockDomainData || {};
  const blockedDomains = Object.freeze([
    ...new Set([...(domainData.advertisingDomains || []), ...(domainData.strictDomains || [])])
  ]);
  const protectedDomains = Object.freeze([
    "accounts.google.com", "appleid.apple.com", "challenges.cloudflare.com", "checkout.com",
    "hcaptcha.com", "login.microsoftonline.com", "paypal.com", "recaptcha.net", "stripe.com"
  ]);
  const TRACKING_PATH_RE = /(?:^|[/_.-])(?:adserver|ads?|analytics|attribution|beacon|collect|event|impression|metrics|pixel|telemetry|track(?:er|ing)?)(?:[/_.?=&-]|$)/i;
  const WORKER_PATH_RE = /(?:^|[/_.-])(?:ad|analytics|push|telemetry|track(?:er|ing)?)[-_.]?(?:service[-_.]?)?worker(?:\.min)?\.js(?:[?#]|$)/i;
  const PROTECTED_PATH_RE = /\/(?:cdn-cgi\/challenge|recaptcha|captcha|oauth|authorize|login|signin|checkout|payment|3ds)(?:\/|$)/i;
  const HIGH_ENTROPY_KEYS = new Set([
    "architecture", "bitness", "formFactors", "fullVersionList", "model", "platformVersion", "uaFullVersion", "wow64"
  ]);
  const TRACKING_PARAMETERS = new Set([
    "fbclid", "gclid", "dclid", "msclkid", "twclid", "ttclid", "gbraid", "wbraid",
    "mc_eid", "oly_anon_id", "oly_enc_id", "vero_conv", "vero_id", "_hsenc", "_hsmi",
    "mkt_tok", "igshid", "wickedid", "s_cid", "utm_source", "utm_medium", "utm_campaign",
    "utm_term", "utm_content", "utm_id"
  ]);
  const nativeFunctionToString = Function.prototype.toString;
  const nativeFunctionMap = new WeakMap();
  const pageSeed = (() => {
    const random = new Uint32Array(1);
    try {
      globalThis.crypto.getRandomValues(random);
      return random[0] || 0x6d2b79f5;
    } catch (_error) {
      let hash = 0x811c9dc5;
      for (const character of `${location.hostname}:${Date.now()}:${Math.random()}`) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 0x01000193);
      }
      return hash >>> 0;
    }
  })();

  function privacyEnabled() {
    return configuration.enabled && configuration.privacyApiProtection && configuration.level !== "relaxed" && !protectedContext();
  }

  function fingerprintEnabled() {
    return configuration.enabled && configuration.fingerprintProtection && configuration.level === "strict" && !protectedContext();
  }

  function trackingCleaningEnabled() {
    return configuration.enabled && configuration.cleanTrackingParameters && configuration.level === "strict";
  }

  function hostnameMatches(hostname, domain) {
    const host = String(hostname || "").toLowerCase().replace(/^www\./, "");
    const target = String(domain || "").toLowerCase().replace(/^www\./, "");
    return Boolean(host && target && (host === target || host.endsWith(`.${target}`)));
  }

  function parseUrl(value) {
    try {
      const url = new URL(String(value || ""), location.href);
      return ["http:", "https:", "ws:", "wss:"].includes(url.protocol) ? url : null;
    } catch (_error) {
      return null;
    }
  }

  function cleanTrackingUrl(value) {
    const url = parseUrl(value);
    if (!url || !["http:", "https:"].includes(url.protocol)) return String(value || "");
    let changed = false;
    for (const key of [...url.searchParams.keys()]) {
      if (!TRACKING_PARAMETERS.has(key.toLowerCase())) continue;
      url.searchParams.delete(key);
      changed = true;
    }
    return changed ? url.href : String(value || "");
  }

  function cleanCurrentLocation() {
    if (!trackingCleaningEnabled()) return;
    const cleaned = cleanTrackingUrl(location.href);
    if (cleaned === location.href) return;
    try { history.replaceState(history.state, "", cleaned); } catch (_error) { /* History may be locked in sandboxed frames. */ }
  }

  function protectedDestination(hostname) {
    return protectedDomains.some((domain) => hostnameMatches(hostname, domain));
  }

  function protectedContext() {
    return protectedDestination(location.hostname) || PROTECTED_PATH_RE.test(location.pathname || "");
  }

  function shouldBlockRequest(value, worker = false) {
    if (!privacyEnabled()) return false;
    const url = parseUrl(value);
    if (!url || protectedDestination(url.hostname)) return false;
    if (blockedDomains.some((domain) => hostnameMatches(url.hostname, domain))) return true;
    const thirdParty = !hostnameMatches(url.hostname, location.hostname) && !hostnameMatches(location.hostname, url.hostname);
    return thirdParty && (worker ? WORKER_PATH_RE : TRACKING_PATH_RE).test(`${url.pathname}${url.search}`);
  }

  function imitateNative(wrapper, nativeFunction) {
    nativeFunctionMap.set(wrapper, nativeFunction);
    try {
      Object.defineProperty(wrapper, "name", { value: nativeFunction.name, configurable: true });
      Object.defineProperty(wrapper, "length", { value: nativeFunction.length, configurable: true });
    } catch (_error) {
      // Preserving native metadata is best effort only.
    }
    return wrapper;
  }

  function installNativeFunctionCloak() {
    const guardedToString = imitateNative(function toString() {
      const nativeFunction = nativeFunctionMap.get(this);
      return Reflect.apply(nativeFunctionToString, nativeFunction || this, []);
    }, nativeFunctionToString);
    try {
      Object.defineProperty(Function.prototype, "toString", {
        value: guardedToString,
        writable: true,
        configurable: true
      });
    } catch (_error) {
      return;
    }

    document.addEventListener(CLOAK_EVENT, (event) => {
      const detail = event.detail;
      if (!detail || typeof detail !== "object") return;
      if (detail.mode === "lookup" && typeof detail.candidate === "function") {
        detail.native = nativeFunctionMap.get(detail.candidate) || null;
      } else if (detail.mode === "register" &&
          typeof detail.wrapper === "function" && typeof detail.native === "function") {
        nativeFunctionMap.set(detail.wrapper, detail.native);
        detail.registered = true;
      }
    });
  }

  function replaceMethod(target, name, createWrapper) {
    const nativeMethod = target?.[name];
    if (typeof nativeMethod !== "function") return;
    const wrapped = imitateNative(createWrapper(nativeMethod), nativeMethod);
    try {
      Object.defineProperty(target, name, {
        value: wrapped,
        writable: true,
        configurable: true
      });
    } catch (_error) {
      try { target[name] = wrapped; } catch (_ignored) { /* Locked prototypes remain untouched. */ }
    }
  }

  function installPrivacyApis() {
    const navigatorPrototype = globalThis.Navigator?.prototype;
    const documentPrototype = globalThis.Document?.prototype;
    const targetFor = (prototype, instance, name) =>
      typeof prototype?.[name] === "function" ? prototype : instance;

    replaceMethod(targetFor(documentPrototype, globalThis.document, "browsingTopics"), "browsingTopics", (nativeMethod) => function guardedBrowsingTopics() {
      if (privacyEnabled()) return Promise.resolve([]);
      return Reflect.apply(nativeMethod, this, arguments);
    });

    const interestGroupMethods = new Map([
      ["joinAdInterestGroup", undefined],
      ["leaveAdInterestGroup", undefined],
      ["clearOriginJoinedAdInterestGroups", undefined],
      ["updateAdInterestGroups", undefined],
      ["runAdAuction", null],
      ["createAuctionNonce", null]
    ]);
    for (const [name, blockedValue] of interestGroupMethods) {
      const target = targetFor(navigatorPrototype, globalThis.navigator, name);
      replaceMethod(target, name, (nativeMethod) => function guardedAdvertisingApi() {
        if (privacyEnabled()) return Promise.resolve(blockedValue);
        return Reflect.apply(nativeMethod, this, arguments);
      });
    }
    const beaconTarget = targetFor(navigatorPrototype, globalThis.navigator, "sendBeacon");
    replaceMethod(beaconTarget, "sendBeacon", (nativeMethod) => function guardedSendBeacon(url) {
      if (shouldBlockRequest(url)) return false;
      return Reflect.apply(nativeMethod, this, arguments);
    });

    const sharedStorage = globalThis.sharedStorage;
    for (const name of ["append", "clear", "delete", "set", "run", "selectURL"]) {
      replaceMethod(sharedStorage, name, (nativeMethod) => function guardedSharedStorage() {
        if (privacyEnabled()) return Promise.resolve(name === "selectURL" ? null : undefined);
        return Reflect.apply(nativeMethod, this, arguments);
      });
    }
    replaceMethod(sharedStorage?.worklet, "addModule", (nativeMethod) => function guardedSharedStorageModule() {
      if (privacyEnabled()) return Promise.resolve(undefined);
      return Reflect.apply(nativeMethod, this, arguments);
    });

    replaceMethod(globalThis.navigator?.serviceWorker, "register", (nativeMethod) => function guardedServiceWorkerRegistration(scriptUrl) {
      if (shouldBlockRequest(scriptUrl, true)) {
        return Promise.reject(new DOMException("The operation is insecure.", "SecurityError"));
      }
      return Reflect.apply(nativeMethod, this, arguments);
    });
  }

  function installBlockedConstructors() {
    for (const constructorName of ["WebSocket", "EventSource", "Worker", "SharedWorker"]) {
      const NativeConstructor = globalThis[constructorName];
      if (typeof NativeConstructor !== "function") continue;
      const GuardedConstructor = imitateNative(function () {
        if (shouldBlockRequest(arguments[0], constructorName.endsWith("Worker"))) {
          throw new DOMException("The operation is insecure.", "SecurityError");
        }
        return Reflect.construct(NativeConstructor, [...arguments], new.target || NativeConstructor);
      }, NativeConstructor);
      try {
        Object.setPrototypeOf(GuardedConstructor, NativeConstructor);
        GuardedConstructor.prototype = NativeConstructor.prototype;
        Object.defineProperty(globalThis, constructorName, {
          value: GuardedConstructor,
          writable: true,
          configurable: true
        });
      } catch (_error) {
        // Locked globals are left in their native state.
      }
    }
  }

  function stripAttributionAttributes(element) {
    if (!privacyEnabled() || !element?.removeAttribute) return;
    element.removeAttribute("attributionsrc");
    if (["A", "AREA"].includes(element.tagName)) element.removeAttribute("ping");
  }

  function sanitizeAttributionTree(root) {
    if (!privacyEnabled() || !root) return;
    stripAttributionAttributes(root);
    for (const element of root.querySelectorAll?.("[attributionsrc],a[ping],area[ping]") || []) {
      stripAttributionAttributes(element);
    }
  }

  function installAttributionSanitizer() {
    replaceMethod(globalThis.Element?.prototype, "setAttribute", (nativeMethod) => function guardedSetAttribute(name) {
      const normalized = String(name || "").toLowerCase();
      if (privacyEnabled() && (normalized === "attributionsrc" ||
          (normalized === "ping" && ["A", "AREA"].includes(this.tagName)))) return undefined;
      return Reflect.apply(nativeMethod, this, arguments);
    });
    replaceMethod(globalThis.Element?.prototype, "setAttributeNS", (nativeMethod) => function guardedSetAttributeNS(namespace, name) {
      const normalized = String(name || "").toLowerCase();
      if (privacyEnabled() && (normalized === "attributionsrc" ||
          (normalized === "ping" && ["A", "AREA"].includes(this.tagName)))) return undefined;
      return Reflect.apply(nativeMethod, this, arguments);
    });

    const sanitizeActivation = (event) => {
      const path = event.composedPath?.() || [];
      const target = path.find((node) => ["A", "AREA", "FORM", "IMG", "SCRIPT"].includes(node?.tagName));
      stripAttributionAttributes(target);
      if (!trackingCleaningEnabled() || !target) return;
      if (["A", "AREA"].includes(target.tagName) && target.href) target.href = cleanTrackingUrl(target.href);
      if (target.tagName === "FORM" && target.action) target.action = cleanTrackingUrl(target.action);
    };
    document.addEventListener("pointerdown", sanitizeActivation, true);
    document.addEventListener("click", sanitizeActivation, true);
    document.addEventListener("submit", sanitizeActivation, true);

    if (typeof MutationObserver === "function" && document.documentElement) {
      const observer = new MutationObserver((records) => {
        if (!privacyEnabled()) return;
        for (const record of records) {
          if (record.type === "attributes") stripAttributionAttributes(record.target);
          for (const node of record.addedNodes || []) sanitizeAttributionTree(node);
        }
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["attributionsrc", "ping"]
      });
    }
  }

  function shouldProtectCanvas(canvas) {
    if (!fingerprintEnabled()) return false;
    const width = Math.max(0, Number(canvas?.width) || 0);
    const height = Math.max(0, Number(canvas?.height) || 0);
    const area = width * height;
    if (width < 8 || height < 8 || width > 1024 || height > 1024 || area < 256 || area > 262144) return false;
    const rect = canvas.getBoundingClientRect?.();
    if (canvas.isConnected && rect && rect.width * rect.height > Math.max(
      131072,
      (Number(globalThis.innerWidth) || 1) * (Number(globalThis.innerHeight) || 1) * 0.15
    )) return false;
    return true;
  }

  function addDeterministicNoise(imageData, salt = 0) {
    const data = imageData?.data;
    if (!data?.length) return imageData;
    let state = (pageSeed ^ salt ^ data.length) >>> 0;
    const stride = Math.max(32, Math.floor(data.length / 96));
    for (let index = state % stride; index < data.length; index += stride) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const channel = (index - (index % 4)) + (state % 3);
      if (channel < data.length) data[channel] ^= 1;
    }
    return imageData;
  }

  function installCanvasProtection() {
    const canvasPrototype = globalThis.HTMLCanvasElement?.prototype;
    const contextPrototype = globalThis.CanvasRenderingContext2D?.prototype;
    const nativeGetContext = canvasPrototype?.getContext;
    const nativeDrawImage = contextPrototype?.drawImage;
    const nativeGetImageData = contextPrototype?.getImageData;
    const nativePutImageData = contextPrototype?.putImageData;

    replaceMethod(contextPrototype, "getImageData", (nativeMethod) => function guardedGetImageData() {
      const result = Reflect.apply(nativeMethod, this, arguments);
      return shouldProtectCanvas(this.canvas)
        ? addDeterministicNoise(result, (Number(arguments[0]) || 0) ^ (Number(arguments[1]) || 0))
        : result;
    });

    function noisyCanvasCopy(canvas) {
      if (!shouldProtectCanvas(canvas) || !nativeGetContext || !nativeDrawImage || !nativeGetImageData || !nativePutImageData) return null;
      try {
        const copy = document.createElement("canvas");
        copy.width = canvas.width;
        copy.height = canvas.height;
        const context = Reflect.apply(nativeGetContext, copy, ["2d", { willReadFrequently: true }]);
        Reflect.apply(nativeDrawImage, context, [canvas, 0, 0]);
        const pixels = Reflect.apply(nativeGetImageData, context, [0, 0, copy.width, copy.height]);
        addDeterministicNoise(pixels, copy.width ^ copy.height);
        Reflect.apply(nativePutImageData, context, [pixels, 0, 0]);
        return copy;
      } catch (_error) {
        return null;
      }
    }

    replaceMethod(canvasPrototype, "toDataURL", (nativeMethod) => function guardedToDataURL() {
      const copy = noisyCanvasCopy(this);
      return Reflect.apply(nativeMethod, copy || this, arguments);
    });
    replaceMethod(canvasPrototype, "toBlob", (nativeMethod) => function guardedToBlob() {
      const copy = noisyCanvasCopy(this);
      return Reflect.apply(nativeMethod, copy || this, arguments);
    });
  }

  function installWebGlProtection() {
    for (const prototype of [globalThis.WebGLRenderingContext?.prototype, globalThis.WebGL2RenderingContext?.prototype]) {
      replaceMethod(prototype, "getParameter", (nativeMethod) => function guardedGetParameter(parameter) {
        if (fingerprintEnabled() && parameter === 37445) return "Google Inc.";
        if (fingerprintEnabled() && parameter === 37446) return "ANGLE (generic renderer)";
        return Reflect.apply(nativeMethod, this, arguments);
      });
    }
  }

  function installAudioProtection() {
    const protectArray = (array, salt) => {
      if (!fingerprintEnabled() || !array?.length) return;
      for (let index = salt % 29; index < array.length; index += 29) {
        array[index] += ((pageSeed >>> (index % 16)) & 1 ? 1 : -1) * 1e-7;
      }
    };
    for (const [name, salt] of [["getFloatFrequencyData", 7], ["getFloatTimeDomainData", 13]]) {
      replaceMethod(globalThis.AnalyserNode?.prototype, name, (nativeMethod) => function guardedAudioReadback(array) {
        const result = Reflect.apply(nativeMethod, this, arguments);
        protectArray(array, salt);
        return result;
      });
    }
  }

  function installUaDataProtection() {
    const uaData = globalThis.navigator?.userAgentData;
    const prototype = uaData && Object.getPrototypeOf(uaData);
    const target = typeof prototype?.getHighEntropyValues === "function" ? prototype : uaData;
    replaceMethod(target, "getHighEntropyValues", (nativeMethod) => async function guardedHighEntropyValues(hints) {
      const result = await Reflect.apply(nativeMethod, this, arguments);
      if (!fingerprintEnabled() || !result || typeof result !== "object") return result;
      for (const key of Array.isArray(hints) ? hints : []) {
        if (!HIGH_ENTROPY_KEYS.has(key) || !(key in result)) continue;
        if (key === "fullVersionList" && Array.isArray(result[key])) {
          result[key] = result[key].map((brand) => ({ ...brand, version: `${String(brand.version).split(".")[0]}.0.0.0` }));
        } else if (key === "wow64") result[key] = false;
        else if (key === "formFactors") result[key] = [];
        else result[key] = "";
      }
      return result;
    });
  }

  document.addEventListener(CONFIG_EVENT, (event) => {
    const detail = event.detail;
    if (!detail || typeof detail.enabled !== "boolean") return;
    configuration.enabled = detail.enabled;
    configuration.level = ["relaxed", "balanced", "strict"].includes(detail.level) ? detail.level : "strict";
    configuration.cleanTrackingParameters = detail.cleanTrackingParameters !== false;
    configuration.privacyApiProtection = detail.privacyApiProtection !== false;
    configuration.fingerprintProtection = detail.fingerprintProtection !== false;
    if (privacyEnabled()) sanitizeAttributionTree(document.documentElement);
    cleanCurrentLocation();
  });

  installNativeFunctionCloak();
  installPrivacyApis();
  installBlockedConstructors();
  installAttributionSanitizer();
  installCanvasProtection();
  installWebGlProtection();
  installAudioProtection();
  installUaDataProtection();

  // Keep the version literal available to package validation without exposing a page-global marker.
  void VERSION;
})();
