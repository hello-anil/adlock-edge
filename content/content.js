(function startAdLock() {
  "use strict";

  const engine = globalThis.AdaptiveAdEngine;
  const runtimeBridge = globalThis.AdLockRuntimeBridge;
  if (!engine || !runtimeBridge?.isAvailable(globalThis.chrome)) return;
  const runtimeSession = globalThis.chrome.runtime;
  const existingController = globalThis.__adLockContentController;
  if (existingController?.version === engine.VERSION && existingController.runtime === runtimeSession) return;
  globalThis.__adLockContentController = Object.freeze({ version: engine.VERSION, runtime: runtimeSession });

  const DEFAULT_SETTINGS = Object.freeze({
    globalEnabled: true,
    level: "strict",
    disabledSites: [],
    customBlockDomains: [],
    customSelectors: [],
    showPlaceholders: false,
    redirectProtection: true,
    antiAdblockCompatibility: true,
    dynamicFiltering: true,
    cleanTrackingParameters: true,
    privacyApiProtection: true,
    fingerprintProtection: true
  });

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    enabled: false,
    // Subframes wait for the service worker to confirm the top-level site's
    // policy; top frames can safely use their own stored site policy at once.
    topLevelEnabled: globalThis.top && globalThis.top !== globalThis ? false : null,
    queue: new Set(),
    scheduled: false,
    observer: null,
    shadowObservers: new Map(),
    scanJobs: [],
    scanRoots: new WeakSet(),
    customSelectorQuery: "",
    pageHidden: 0,
    unsentHidden: 0,
    reportTimer: null,
    placeholders: new WeakMap(),
    lastSignatures: new WeakMap(),
    hiddenElements: new Set(),
    forceDisplayHiddenElements: new WeakSet(),
    originalStyles: new WeakMap(),
    countedElements: new WeakSet(),
    reputationReported: new Set(),
    lastBlockedNavigation: null,
    processedSincePrune: 0,
    backgroundElements: new Map(),
    scrollLocks: new Map(),
    maintenanceTimer: null,
    contextInvalidated: false
  };

  const MAX_QUEUE_SIZE = 5000;
  const MAX_SHADOW_ROOTS = 64;
  const MAX_SCAN_NODES_PER_SLICE = 350;
  const MAX_SCAN_MILLISECONDS = 6;
  const now = globalThis.performance?.now?.bind(globalThis.performance) || Date.now;
  const OPEN_SHADOW_EVENT = "aas:open-shadow-root";
  const CONFIG_CHANNEL_ATTRIBUTE = "data-aas-config-channel";
  const initialConfigurationRoot = document.documentElement;
  const initialConfigurationChannel = initialConfigurationRoot?.getAttribute(CONFIG_CHANNEL_ATTRIBUTE) || "";
  if (initialConfigurationChannel) initialConfigurationRoot.removeAttribute(CONFIG_CHANNEL_ATTRIBUTE);
  let mainWorldConfigurationEvents = initialConfigurationChannel
    ? [`aas:config:${initialConfigurationChannel}`]
    : null;

  const hostname = location.hostname.toLowerCase().replace(/^www\./, "");
  const ANNOYANCE_SELECTOR = [
    "dialog", "[role='dialog']", "[aria-modal='true']", ".modal", ".popup", ".overlay",
    ".hhhhppp",
    "[class*='adblock' i]", "[id*='adblock' i]", "[class*='interstitial' i]",
    "[class*='notification' i]", "[id*='notification' i]", "[class*='push-prompt' i]",
    "[id*='push-prompt' i]", "[class*='slidedown' i]", "[id*='onesignal' i]",
    "[style*='position:fixed' i]", "[style*='position: fixed' i]"
  ].join(",");
  const NOTIFICATION_PROMPT_RE = /(?:allow|enable|turn on).{0,35}(?:push )?notifications?|click\s+allow.{0,45}(?:continue|watch|download)/i;
  const DECEPTIVE_CALL_NOTIFICATION_RE = /(?:\bmissed\s+(?:video\s+)?calls?\b|\bhas\s+something\s+to\s+show\s+(?:to\s+)?you\b)/i;
  const BLOCKING_PROMOTION_PATTERNS = Object.freeze([
    /\bsharing is caring\b/i,
    /\bhelp us grow by sharing\b/i,
    /\bbookmark\b.{0,120}\bstay updated\b/i,
    /\bjoin (?:our )?(?:discord|telegram)\b/i,
    /\bshare this site\b/i
  ]);
  const PROTECTED_CONTEXT_RE = /(?:^|\.)(?:challenges\.cloudflare\.com|recaptcha\.net|hcaptcha\.com|accounts\.google\.com|login\.microsoftonline\.com|paypal\.com|stripe\.com)$/i;

  function isBlockingPromotionText(value) {
    const rawText = String(value || "");
    if (rawText.length < 20 || rawText.length > 2200) return false;
    const text = engine.normalizeText(rawText);
    if (text.length < 20 || text.length > 1600) return false;
    let matches = 0;
    for (const pattern of BLOCKING_PROMOTION_PATTERNS) {
      if (pattern.test(text) && ++matches >= 2) return true;
    }
    return false;
  }

  function deactivateInvalidContext() {
    if (state.contextInvalidated) return;
    state.contextInvalidated = true;
    if (globalThis.__adLockContentController?.runtime === runtimeSession) {
      globalThis.__adLockContentController = null;
    }
    state.enabled = false;
    disconnectObservers();
    state.queue.clear();
    state.scanJobs.length = 0;
    state.scanRoots = new WeakSet();
    clearTimeout(state.reportTimer);
    clearTimeout(state.maintenanceTimer);
    state.maintenanceTimer = null;
    state.unsentHidden = 0;
    unhideAll();
    document.querySelector?.(".aas-redirect-notice")?.remove();
    document.removeEventListener("pointerdown", handleNavigationClick, true);
    document.removeEventListener("click", handleNavigationClick, true);
    document.removeEventListener("keydown", handleNavigationClick, true);
    document.removeEventListener("submit", handleNavigationClick, true);
    document.removeEventListener(OPEN_SHADOW_EVENT, handleOpenShadowRoot, true);
    document.removeEventListener("visibilitychange", handlePageResume, true);
    globalThis.removeEventListener?.("pageshow", handlePageResume, true);
    globalThis.removeEventListener?.("popstate", handlePageResume, true);
    globalThis.removeEventListener?.("hashchange", handlePageResume, true);
    sendRedirectConfiguration();
  }

  function sendRuntimeMessage(message) {
    return runtimeBridge.sendMessage(globalThis.chrome, message, deactivateInvalidContext);
  }

  function getLocalStorage(key) {
    return runtimeBridge.getLocal(globalThis.chrome, key, deactivateInvalidContext);
  }

  function isSiteDisabled() {
    return state.settings.disabledSites.some((domain) => engine.hostnameMatches(hostname, domain));
  }

  function computeEnabled() {
    return Boolean(state.settings.globalEnabled && state.topLevelEnabled !== false && !isSiteDisabled());
  }

  function candidateSignature(element) {
    const attributes = [
      "id", "class", "style", "role", "aria-label", "title", "src", "srcdoc", "data-src", "poster",
      "href", "target", "rel", "width", "height", "data-ad", "data-ad-slot", "data-ad-unit",
      "data-advertisement", "data-ad-type", "data-ad-format", "data-companion-ad",
      "data-ad-background", "data-sponsored", "data-promoted", "data-social-promo"
    ];
    return [
      ...attributes.map((name) => element.getAttribute?.(name) || ""),
      engine.normalizeText(element.textContent || "").slice(0, 100)
    ].join("|");
  }

  function matchesCustomSelector(element) {
    if (!state.customSelectorQuery) return null;
    try {
      if (!element.matches(state.customSelectorQuery) && !element.closest(state.customSelectorQuery)) return null;
    } catch (_error) {
      return null;
    }
    for (const selector of state.settings.customSelectors) {
      try {
        if (element.matches(selector) || element.closest(selector)) return selector;
      } catch (_error) {
        // Invalid selectors are rejected by the options page; ignore stale bad data.
      }
    }
    return null;
  }

  function compileCustomSelectorQuery(selectors) {
    const valid = [];
    for (const selector of selectors) {
      try {
        document.documentElement?.matches?.(selector);
        valid.push(selector);
      } catch (_error) {
        // Ignore invalid selectors from manually edited storage.
      }
    }
    return valid.join(",");
  }

  function addPlaceholder(container, reason) {
    if (!state.settings.showPlaceholders || !container.parentNode || state.placeholders.has(container)) return;
    const placeholder = document.createElement("div");
    placeholder.className = "aas-placeholder";
    placeholder.textContent = "Ad hidden by AdLock";
    placeholder.title = reason;
    container.parentNode.insertBefore(placeholder, container);
    state.placeholders.set(container, placeholder);
  }

  function setImportantStyle(element, property, value) {
    if (element.style.getPropertyValue(property) === value && element.style.getPropertyPriority(property) === "important") return;
    element.style.setProperty(property, value, "important");
  }

  function enforceHiddenStyles(container) {
    if (!container || container.isConnected === false) return;
    if (state.forceDisplayHiddenElements.has(container)) setImportantStyle(container, "display", "none");
    setImportantStyle(container, "visibility", "hidden");
    setImportantStyle(container, "opacity", "0");
    setImportantStyle(container, "pointer-events", "none");
  }

  function hide(container, result, customSelector) {
    if (!container || container.isConnected === false || container === document.documentElement || container === document.body || state.hiddenElements.has(container)) return;
    state.originalStyles.set(container, {
      display: container.style.getPropertyValue("display"),
      displayPriority: container.style.getPropertyPriority("display"),
      visibility: container.style.getPropertyValue("visibility"),
      visibilityPriority: container.style.getPropertyPriority("visibility"),
      opacity: container.style.getPropertyValue("opacity"),
      opacityPriority: container.style.getPropertyPriority("opacity"),
      pointerEvents: container.style.getPropertyValue("pointer-events"),
      pointerEventsPriority: container.style.getPropertyPriority("pointer-events")
    });
    const forceDisplayHidden = result.signals.some((item) =>
      item.signal === "anti-adblock overlay" ||
      item.signal === "deceptive call notification" ||
      item.signal === "blocking promotional modal"
    );
    if (!state.settings.antiAdblockCompatibility || customSelector || forceDisplayHidden) {
      state.forceDisplayHiddenElements.add(container);
    }
    enforceHiddenStyles(container);
    state.hiddenElements.add(container);
    const reason = customSelector
      ? `Custom selector: ${customSelector}`
      : result.signals.filter((item) => item.points > 0).map((item) => item.signal).join(", ");
    addPlaceholder(container, reason);
    if (!state.countedElements.has(container)) {
      state.countedElements.add(container);
      state.pageHidden += 1;
      state.unsentHidden += 1;
      scheduleReport();
    }
  }

  function isProtectedContext() {
    return PROTECTED_CONTEXT_RE.test(location.hostname) ||
      /\/(?:cdn-cgi\/challenge|recaptcha|captcha|oauth|authorize|login|signin|checkout|payment|3ds)(?:\/|$)/i.test(location.pathname);
  }

  function inspectAnnoyanceOverlay(element) {
    if (!state.enabled || !state.settings.antiAdblockCompatibility || isProtectedContext()) return;
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return;
    if (state.hiddenElements.has(element)) {
      enforceHiddenStyles(element);
      return;
    }
    const text = engine.normalizeText(element.textContent || "");
    const antiAdblock = engine.isAntiAdblockMessage(text);
    const notificationNag = text.length <= 900 && NOTIFICATION_PROMPT_RE.test(text);
    const deceptiveCallNotification = text.length <= 900 && DECEPTIVE_CALL_NOTIFICATION_RE.test(text);
    const blockingPromotion = isBlockingPromotionText(text);
    if (!antiAdblock && !notificationNag && !deceptiveCallNotification && !blockingPromotion) return;

    const rect = element.getBoundingClientRect?.();
    const area = rect ? Math.max(0, rect.width) * Math.max(0, rect.height) : 0;
    const viewportArea = Math.max(1, globalThis.innerWidth * globalThis.innerHeight);
    const identity = `${element.id || ""} ${String(element.className || "")}`;
    const style = typeof getComputedStyle === "function" ? getComputedStyle(element) : null;
    const modalLike = element.matches?.("dialog,[role='dialog'],[aria-modal='true'],.modal,.popup,.overlay") ||
      style?.position === "fixed";
    const named = /(?:adblock|anti[-_ ]?ad|notification|interstitial)/i.test(identity);
    const net77Warning = engine.hostnameMatches(hostname, "net77.cc") && antiAdblock && (
      element.matches?.(".hhhhppp") ||
      (style?.position === "fixed" && /AdBlock\s*\/\s*DNS Blocking detected/i.test(text))
    );
    if (deceptiveCallNotification && !modalLike) return;
    if (blockingPromotion && !(modalLike && area / viewportArea >= 0.15)) return;
    if (!named && !net77Warning && !deceptiveCallNotification && !blockingPromotion && !(modalLike && area / viewportArea >= 0.08)) return;

    const signal = antiAdblock
      ? "anti-adblock overlay"
      : deceptiveCallNotification
        ? "deceptive call notification"
        : blockingPromotion ? "blocking promotional modal" : "notification promotion";
    hide(element, { signals: [{ signal, points: 10 }] }, null);
    if (antiAdblock) {
      const lockTokens = ["modal-open", "no-scroll", "overflow-hidden"];
      for (const root of [document.documentElement, document.body]) {
        if (!root) continue;
        const classTokens = String(root.className || "").split(/\s+/).filter(Boolean);
        const removedClasses = lockTokens.filter((token) => classTokens.includes(token));
        const overflow = root.style.getPropertyValue("overflow");
        if ((removedClasses.length || overflow === "hidden") && !state.scrollLocks.has(root)) {
          state.scrollLocks.set(root, {
            removedClasses,
            overflow,
            overflowPriority: root.style.getPropertyPriority("overflow")
          });
        }
        if (removedClasses.length) root.classList.remove(...removedClasses);
        if (overflow === "hidden") root.style.removeProperty("overflow");
      }
    }
  }

  function inspectAnnoyanceAncestors(element) {
    let current = element?.nodeType === Node.ELEMENT_NODE ? element : element?.parentElement;
    for (let depth = 0; current && depth < 8; depth += 1, current = composedParent(current)) {
      inspectAnnoyanceOverlay(current);
    }
  }

  function composedParent(element) {
    if (element?.parentElement) return element.parentElement;
    const root = element?.getRootNode?.();
    return root?.host || null;
  }

  function inspectAdBackground(element) {
    if (!state.enabled || !element) return;
    const identity = `${element.id || ""} ${String(element.className || "")} ${element.getAttribute?.("data-ad-background") || ""}`;
    const explicitSurface = /(?:^|[\s_-])(?:ad|advert|promo)[-_]?(?:background|skin|wallpaper|takeover)(?:[\s_-]|$)|(?:background|skin|wallpaper)[-_]?(?:ad|advert|promo)/i.test(identity);
    if (![document.documentElement, document.body].includes(element) && !explicitSurface) return;
    const background = typeof getComputedStyle === "function" ? getComputedStyle(element).backgroundImage : "";
    const urls = [...String(background).matchAll(/url\(["']?([^"')]+)["']?\)/gi)].map((match) => match[1]);
    if (!urls.some((url) => engine.isKnownAdUrl(url))) return;
    if (!state.backgroundElements.has(element)) {
      state.backgroundElements.set(element, {
        value: element.style.getPropertyValue("background-image"),
        priority: element.style.getPropertyPriority("background-image")
      });
    }
    element.style.setProperty("background-image", "none", "important");
  }

  function unhideAll() {
    for (const element of state.hiddenElements) {
      const original = state.originalStyles.get(element);
      for (const [property, key] of [["display", "display"], ["visibility", "visibility"], ["opacity", "opacity"], ["pointer-events", "pointerEvents"]]) {
        const priorityKey = `${key}Priority`;
        if (original?.[key]) element.style.setProperty(property, original[key], original[priorityKey] || "");
        else element.style.removeProperty(property);
      }
      const placeholder = state.placeholders.get(element);
      if (placeholder?.isConnected) placeholder.remove();
      state.placeholders.delete(element);
      state.originalStyles.delete(element);
      state.forceDisplayHiddenElements.delete(element);
    }
    state.hiddenElements.clear();
    for (const [element, original] of state.backgroundElements) {
      if (original.value) element.style.setProperty("background-image", original.value, original.priority || "");
      else element.style.removeProperty("background-image");
    }
    state.backgroundElements.clear();
    for (const [element, lock] of state.scrollLocks) {
      for (const token of lock.removedClasses) element.classList?.add?.(token);
      if (!element.style.getPropertyValue("overflow") && lock.overflow) {
        element.style.setProperty("overflow", lock.overflow, lock.overflowPriority || "");
      }
    }
    state.scrollLocks.clear();
  }

  function pruneDisconnectedState() {
    for (const element of state.hiddenElements) {
      if (element.isConnected !== false) continue;
      const placeholder = state.placeholders.get(element);
      if (placeholder?.isConnected) placeholder.remove();
      state.placeholders.delete(element);
      state.originalStyles.delete(element);
      state.forceDisplayHiddenElements.delete(element);
      state.hiddenElements.delete(element);
    }
    for (const element of state.backgroundElements.keys()) {
      if (element.isConnected === false) state.backgroundElements.delete(element);
    }
    for (const element of state.scrollLocks.keys()) {
      if (element.isConnected === false) state.scrollLocks.delete(element);
    }
    state.processedSincePrune = 0;
  }

  function inspect(element) {
    if (!state.enabled || !element || element.nodeType !== Node.ELEMENT_NODE || element.isConnected === false) return;
    if (state.hiddenElements.has(element)) {
      enforceHiddenStyles(element);
      return;
    }
    if (element.closest?.(".aas-placeholder")) return;

    const signature = candidateSignature(element);
    if (state.lastSignatures.get(element) === signature) return;
    state.lastSignatures.set(element, signature);

    const customSelector = matchesCustomSelector(element);
    if (customSelector) {
      hide(element.closest(customSelector) || element, { signals: [] }, customSelector);
      return;
    }

    if (state.settings.antiAdblockCompatibility && engine.isLikelyAdblockBait(element)) return;

    const result = engine.classify(element, state.settings.level);
    if (result.blocked && result.container) {
      reportReputationCandidate(element, result);
      hide(result.container, result, null);
    }
  }

  function reportReputationCandidate(element, result) {
    if (!state.settings.dynamicFiltering || state.settings.level !== "strict" ||
        result.score < result.threshold || !result.signals.some((signal) => signal.points >= 4)) return;
    const values = ["src", "href", "data-src", "poster"].map((name) => element.getAttribute?.(name)).filter(Boolean);
    for (const value of values) {
      let url;
      try { url = new URL(String(value), location.href); } catch (_error) { continue; }
      if (!["http:", "https:"].includes(url.protocol) || engine.hostnameMatches(url.hostname, hostname) ||
          engine.hostnameMatches(hostname, url.hostname) || engine.isKnownAdUrl(url.href)) continue;
      const targetHostname = url.hostname.toLowerCase().replace(/^www\./, "");
      if (!targetHostname || state.reputationReported.has(targetHostname) || state.reputationReported.size >= 80) continue;
      state.reputationReported.add(targetHostname);
      sendRuntimeMessage({
        type: "content:reputationSignal",
        targetHostname,
        evidence: "classified-ad"
      });
    }
  }

  function processQueue(deadline) {
    state.scheduled = false;
    const startedAt = now();
    let processed = 0;
    for (const element of state.queue) {
      state.queue.delete(element);
      inspect(element);
      processed += 1;
      state.processedSincePrune += 1;
      if (processed >= MAX_SCAN_NODES_PER_SLICE || now() - startedAt >= MAX_SCAN_MILLISECONDS || (deadline && deadline.timeRemaining() < 2)) break;
    }
    while (state.scanJobs.length && processed < MAX_SCAN_NODES_PER_SLICE && now() - startedAt < MAX_SCAN_MILLISECONDS) {
      const job = state.scanJobs[0];
      const element = job.next();
      if (!element) {
        state.scanJobs.shift();
        state.scanRoots.delete(job.root);
        continue;
      }
      inspectTreeElement(element, job.includeTextMarkers);
      processed += 1;
      if (deadline && deadline.timeRemaining() < 2) break;
    }
    if (state.processedSincePrune >= 1000) pruneDisconnectedState();
    if (state.queue.size || state.scanJobs.length) scheduleProcessing();
  }

  function scheduleProcessing() {
    if (state.scheduled || !state.enabled) return;
    state.scheduled = true;
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(processQueue, { timeout: 250 });
    } else {
      setTimeout(() => processQueue(null), 30);
    }
  }

  function enqueue(element) {
    if (!state.enabled || !element || element.nodeType !== Node.ELEMENT_NODE || element.isConnected === false) return;
    if (state.queue.size >= MAX_QUEUE_SIZE && !state.queue.has(element)) {
      state.queue.delete(state.queue.values().next().value);
    }
    state.queue.add(element);
    scheduleProcessing();
  }

  function inspectTreeElement(element, includeTextMarkers) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE || element.isConnected === false) return;
    if (element.matches?.(ANNOYANCE_SELECTOR)) inspectAnnoyanceOverlay(element);
    inspectAdBackground(element);
    if (element.matches?.(engine.CANDIDATE_SELECTOR)) enqueue(element);
    for (const selector of state.settings.customSelectors) {
      try {
        if (element.matches?.(selector)) enqueue(element);
      } catch (_error) {
        // Ignore invalid selectors from manually edited storage.
      }
    }
    if (includeTextMarkers && (element.children?.length || 0) <= 2) {
      if (engine.hasMarkerText(element)) enqueue(element);
      const text = engine.normalizeText(element.textContent || "");
      if (text.length <= 900 && DECEPTIVE_CALL_NOTIFICATION_RE.test(text)) {
        inspectAnnoyanceAncestors(element);
      }
      if (text.length <= 2400 && /(?:ad\s*block|adblock|whitelist|disable.{0,30}ads?|dns blocking)/i.test(text)) {
        inspectAnnoyanceAncestors(element);
      }
    }
    if ((element.children?.length || 0) <= 8 && isBlockingPromotionText(element.textContent || "")) {
      inspectAnnoyanceAncestors(element);
    }
    registerShadowRoot(element.shadowRoot);
  }

  function makeScanJob(root, includeTextMarkers) {
    let first = root.nodeType === Node.ELEMENT_NODE ? root : null;
    if (typeof document.createTreeWalker === "function" && globalThis.NodeFilter?.SHOW_ELEMENT) {
      const walker = document.createTreeWalker(root, globalThis.NodeFilter.SHOW_ELEMENT);
      return {
        root,
        includeTextMarkers,
        next() {
          if (first) {
            const value = first;
            first = null;
            return value;
          }
          return walker.nextNode();
        }
      };
    }
    const fallback = first ? [first] : [];
    fallback.push(...(root.querySelectorAll?.("*") || []));
    let index = 0;
    return { root, includeTextMarkers, next: () => fallback[index++] || null };
  }

  function enqueueTree(root, includeTextMarkers) {
    if (!state.enabled || !root || ![Node.ELEMENT_NODE, 11].includes(root.nodeType) || state.scanRoots.has(root)) return;
    state.scanRoots.add(root);
    state.scanJobs.push(makeScanJob(root, includeTextMarkers));
    scheduleProcessing();
  }

  function handleMutations(mutations) {
      if (!runtimeBridge.isAvailable(globalThis.chrome)) {
        deactivateInvalidContext();
        return;
      }
      if (!state.enabled) return;
      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === Node.ELEMENT_NODE) enqueueTree(node, true);
          });
          inspectAnnoyanceAncestors(mutation.target);
        } else if (mutation.type === "attributes") {
          state.lastSignatures.delete(mutation.target);
          enqueue(mutation.target);
          inspectAnnoyanceOverlay(mutation.target);
          inspectAdBackground(mutation.target);
        } else if (mutation.type === "characterData") {
          enqueue(mutation.target.parentElement);
          inspectAnnoyanceAncestors(mutation.target);
        }
      }
  }

  const OBSERVER_OPTIONS = Object.freeze({
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      "id", "class", "style", "role", "aria-label", "aria-modal", "title", "src", "srcdoc", "data-src", "poster",
      "href", "target", "rel", "width", "height", "data-ad", "data-ad-slot", "data-ad-unit",
      "data-advertisement", "data-ad-type", "data-ad-format", "data-companion-ad",
      "data-ad-background", "data-sponsored", "data-promoted", "data-social-promo"
    ]
  });

  function registerShadowRoot(root) {
    if (!state.enabled || !root || root.mode === "closed" || state.shadowObservers.has(root) || state.shadowObservers.size >= MAX_SHADOW_ROOTS) return;
    const observer = new MutationObserver(handleMutations);
    observer.observe(root, OBSERVER_OPTIONS);
    state.shadowObservers.set(root, observer);
    enqueueTree(root, true);
  }

  function handleOpenShadowRoot(event) {
    const host = event?.target;
    const root = host?.shadowRoot;
    const ShadowRootConstructor = globalThis.ShadowRoot;
    if (typeof ShadowRootConstructor !== "function" ||
        !(root instanceof ShadowRootConstructor) ||
        root.mode !== "open" || root.host !== host) return;
    registerShadowRoot(root);
  }

  function disconnectObservers() {
    state.observer?.disconnect();
    state.observer = null;
    for (const observer of state.shadowObservers.values()) observer.disconnect();
    state.shadowObservers.clear();
  }

  function observe() {
    if (state.observer || !document.documentElement) return;
    state.observer = new MutationObserver(handleMutations);
    state.observer.observe(document.documentElement, {
      ...OBSERVER_OPTIONS
    });
  }

  function scheduleMaintenance() {
    clearTimeout(state.maintenanceTimer);
    if (!state.enabled || state.contextInvalidated) return;
    const delay = state.settings.level === "strict" ? 8000 : 20000;
    state.maintenanceTimer = setTimeout(() => {
      if (!state.enabled || state.contextInvalidated) return;
      if (!document.hidden) {
        for (const element of state.hiddenElements) enforceHiddenStyles(element);
        pruneDisconnectedState();
        for (const [root, observer] of state.shadowObservers) {
          if (root.isConnected !== false) continue;
          observer.disconnect();
          state.shadowObservers.delete(root);
        }
      }
      scheduleMaintenance();
    }, delay);
    state.maintenanceTimer?.unref?.();
  }

  function handlePageResume() {
    if (!state.enabled || document.hidden || !document.documentElement) return;
    enqueueTree(document.documentElement, true);
    scheduleMaintenance();
  }

  function scheduleReport() {
    clearTimeout(state.reportTimer);
    state.reportTimer = setTimeout(() => {
      const count = state.unsentHidden;
      state.unsentHidden = 0;
      if (!count) return;
      sendRuntimeMessage({
        type: "content:blocked",
        hostname,
        count,
        pageTotal: state.pageHidden
      });
    }, 700);
  }

  function sendRedirectConfiguration() {
    if (!mainWorldConfigurationEvents) {
      const root = document.documentElement;
      const channel = root?.getAttribute(CONFIG_CHANNEL_ATTRIBUTE) || "";
      if (channel) root.removeAttribute(CONFIG_CHANNEL_ATTRIBUTE);
      mainWorldConfigurationEvents = channel
        ? [`aas:config:${channel}`]
        : ["aas:redirect-config", "aas:privacy-config"];
    }
    const detail = {
      enabled: state.enabled,
      level: state.settings.level,
      redirectProtection: state.settings.redirectProtection,
      cleanTrackingParameters: state.settings.cleanTrackingParameters,
      privacyApiProtection: state.settings.privacyApiProtection,
      fingerprintProtection: state.settings.fingerprintProtection
    };
    for (const eventName of mainWorldConfigurationEvents) {
      document.dispatchEvent(new CustomEvent(eventName, { detail }));
    }
  }

  function reportRedirectBlocked(url) {
    sendRuntimeMessage({
      type: "content:redirectBlocked",
      hostname,
      targetHostname: url.hostname
    });
  }

  function sameStringArray(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
  }

  function showRedirectNotice(result) {
    document.querySelector(".aas-redirect-notice")?.remove();
    const notice = document.createElement("section");
    notice.className = "aas-redirect-notice";
    notice.setAttribute("role", "alertdialog");
    notice.setAttribute("aria-label", "Advertising redirect blocked");

    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = "Redirect ad blocked";
    const detail = document.createElement("span");
    detail.textContent = `Prevented navigation to ${result.hostname}`;
    copy.append(title, detail);

    const allow = document.createElement("button");
    allow.type = "button";
    allow.textContent = "Allow once";
    allow.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      allow.disabled = true;
      try {
        const response = await sendRuntimeMessage({ type: "redirect:allowOnce", url: result.url });
        if (!response || response.ok === false) throw new Error(response?.error || "Unable to allow redirect");
        location.assign(result.url);
      } catch (_error) {
        allow.disabled = false;
        detail.textContent = "Could not open this destination";
      }
    });

    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "aas-redirect-dismiss";
    dismiss.textContent = "×";
    dismiss.setAttribute("aria-label", "Dismiss");
    dismiss.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      notice.remove();
    });

    notice.append(copy, allow, dismiss);
    document.documentElement.append(notice);
    setTimeout(() => notice.remove(), 12000);
  }

  function isNavigationActivation(event) {
    if (event.type === "keydown") return event.key === "Enter" && !event.repeat;
    if (event.type === "submit") return true;
    return event.button === 0;
  }

  function getNavigationRequest(event) {
    if (event.type === "submit") {
      const form = event.target?.tagName === "FORM"
        ? event.target
        : event.composedPath?.().find((node) => node?.tagName === "FORM");
      if (!form) return null;
      const submitter = event.submitter;
      return {
        url: submitter?.getAttribute?.("formaction") ||
          form.getAttribute?.("action") || form.action || location.href,
        rel: "",
        target: submitter?.getAttribute?.("formtarget") || form.getAttribute?.("target") || form.target || "",
        linkText: submitter?.textContent || "",
        ariaLabel: submitter?.getAttribute?.("aria-label") || form.getAttribute?.("aria-label") || "",
        className: submitter?.className || form.className || ""
      };
    }

    const anchor = event.composedPath?.().find((node) =>
      ["A", "AREA"].includes(node?.tagName) && node.href
    );
    if (!anchor || anchor.hasAttribute("download")) return null;
    return {
      url: anchor.href,
      rel: anchor.getAttribute("rel"),
      target: anchor.getAttribute("target"),
      linkText: anchor.textContent,
      ariaLabel: anchor.getAttribute("aria-label"),
      className: anchor.className
    };
  }

  function handleNavigationClick(event) {
    if (!runtimeBridge.isAvailable(globalThis.chrome)) {
      deactivateInvalidContext();
      return;
    }
    if (!state.enabled || !state.settings.redirectProtection || !isNavigationActivation(event)) return;
    const request = getNavigationRequest(event);
    if (!request) return;

    const result = engine.analyzeNavigation(request.url, {
      baseUrl: location.href,
      currentHostname: hostname,
      customBlockDomains: state.settings.customBlockDomains,
      level: state.settings.level,
      rel: request.rel,
      target: request.target,
      linkText: request.linkText,
      ariaLabel: request.ariaLabel,
      className: request.className
    });
    if (!result.blocked) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    const now = Date.now();
    const duplicate = state.lastBlockedNavigation?.url === result.url &&
      now - state.lastBlockedNavigation.blockedAt < 1500;
    state.lastBlockedNavigation = { url: result.url, blockedAt: now };
    if (!duplicate) {
      reportRedirectBlocked(result);
      showRedirectNotice(result);
    }
  }

  async function loadSettings(topLevelEnabled) {
    if (typeof topLevelEnabled === "boolean") state.topLevelEnabled = topLevelEnabled;
    const stored = await getLocalStorage("settings");
    if (!stored || state.contextInvalidated) return;
    const previousSettings = state.settings;
    const nextSettings = {
      ...DEFAULT_SETTINGS,
      ...(stored.settings || {}),
      disabledSites: Array.isArray(stored.settings?.disabledSites) ? stored.settings.disabledSites : [],
      customBlockDomains: Array.isArray(stored.settings?.customBlockDomains) ? stored.settings.customBlockDomains : [],
      customSelectors: Array.isArray(stored.settings?.customSelectors) ? stored.settings.customSelectors : []
    };
    const wasEnabled = state.enabled;
    const pagePolicyChanged = wasEnabled && (
      previousSettings.level !== nextSettings.level ||
      previousSettings.showPlaceholders !== nextSettings.showPlaceholders ||
      previousSettings.antiAdblockCompatibility !== nextSettings.antiAdblockCompatibility ||
      !sameStringArray(previousSettings.customSelectors, nextSettings.customSelectors)
    );
    state.settings = nextSettings;
    state.customSelectorQuery = compileCustomSelectorQuery(nextSettings.customSelectors);
    state.enabled = computeEnabled();
    sendRedirectConfiguration();

    if (!state.enabled) {
      disconnectObservers();
      state.queue.clear();
      state.scanJobs.length = 0;
      state.scanRoots = new WeakSet();
      clearTimeout(state.maintenanceTimer);
      state.maintenanceTimer = null;
      unhideAll();
      state.lastSignatures = new WeakMap();
    } else {
      if (pagePolicyChanged) {
        state.queue.clear();
        unhideAll();
        state.lastSignatures = new WeakMap();
      }
      observe();
      if ((!wasEnabled || pagePolicyChanged) && document.documentElement) enqueueTree(document.documentElement, true);
      scheduleMaintenance();
    }
  }

  try {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "settings:changed") {
        loadSettings(message.topLevelEnabled).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
        return true;
      }
      if (message?.type === "content:getPageState") {
        sendResponse({ enabled: state.enabled, pageHidden: state.pageHidden, hostname });
      }
      return false;
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.settings) loadSettings().catch(() => {});
    });
  } catch (_error) {
    deactivateInvalidContext();
  }

  document.addEventListener("pointerdown", handleNavigationClick, true);
  document.addEventListener("click", handleNavigationClick, true);
  document.addEventListener("keydown", handleNavigationClick, true);
  document.addEventListener("submit", handleNavigationClick, true);
  document.addEventListener(OPEN_SHADOW_EVENT, handleOpenShadowRoot, true);
  document.addEventListener("visibilitychange", handlePageResume, true);
  globalThis.addEventListener?.("pageshow", handlePageResume, true);
  globalThis.addEventListener?.("popstate", handlePageResume, true);
  globalThis.addEventListener?.("hashchange", handlePageResume, true);

  async function initialize() {
    try {
      await loadSettings();
      const ready = await sendRuntimeMessage({ type: "content:ready", hostname, pageTotal: state.pageHidden });
      if (typeof ready?.topLevelEnabled === "boolean" && ready.topLevelEnabled !== state.topLevelEnabled) {
        await loadSettings(ready.topLevelEnabled);
      }
    } catch (_error) {
      // The runtime bridge handles invalidated extension contexts.
    }
  }

  if (document.documentElement) initialize();
  else document.addEventListener("DOMContentLoaded", initialize, { once: true });
})();
