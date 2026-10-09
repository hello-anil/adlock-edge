// A Playwright CLI run-code callback. benchmark-live.mjs supplies the configuration.
// Real web requests are allowed; no routes, fake Chrome APIs, or user profiles.
async (page) => {
  const config = __ADLOCK_LIVE_CONFIG__;
  const context = page.context();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extensionId = new URL(worker.url()).hostname;
  const control = await context.newPage();
  let target;
  let cdp;
  try {
    await control.goto(`chrome-extension://${extensionId}/ui/options.html`);
    const settingsResponse = await control.evaluate(async (mode) => chrome.runtime.sendMessage({
      type: "settings:update", patch: {
        globalEnabled: mode !== "disabled", level: mode === "disabled" ? "balanced" : mode,
        dynamicFiltering: false, disabledSites: []
      }
    }), config.mode);
    if (settingsResponse.error || settingsResponse.networkHealth?.status !== (config.mode === "disabled" ? "paused" : "active")) {
      throw new Error(`Extension configuration failed: ${JSON.stringify(settingsResponse)}`);
    }
    const ruleActions = await control.evaluate(async () => {
      const result = {};
      for (const resource of chrome.runtime.getManifest().declarative_net_request.rule_resources) {
        const rules = await fetch(chrome.runtime.getURL(resource.path)).then((response) => response.json());
        for (const rule of rules) result[`${resource.id}:${rule.id}`] = rule.action.type;
      }
      for (const rule of await chrome.declarativeNetRequest.getDynamicRules()) result[`_dynamic:${rule.id}`] = rule.action.type;
      for (const rule of await chrome.declarativeNetRequest.getSessionRules()) result[`_session:${rule.id}`] = rule.action.type;
      return result;
    });
    // Fresh navigation and cleared caches for every measurement. Keep the same
    // loaded extension in the control arm, but disable every protection layer.
    await context.clearCookies();
    target = await context.newPage();
    await target.bringToFront();
    await target.addInitScript(() => {
      globalThis.__adlockLiveMetrics = { longTasks: [], lcpEntries: [] };
      try { new PerformanceObserver((list) => {
        for (const item of list.getEntries()) globalThis.__adlockLiveMetrics.longTasks.push({ startTime: item.startTime, duration: item.duration });
      }).observe({ type: "longtask", buffered: true }); } catch {}
      try { new PerformanceObserver((list) => {
        for (const item of list.getEntries()) globalThis.__adlockLiveMetrics.lcpEntries.push(item.startTime);
      }).observe({ type: "largest-contentful-paint", buffered: true }); } catch {}
    });
    cdp = await context.newCDPSession(target);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Network.clearBrowserCache");
    await cdp.send("Performance.enable");
    let encodedBytes = 0;
    const onLoadingFinished = (event) => { encodedBytes += event.encodedDataLength; };
    cdp.on("Network.loadingFinished", onLoadingFinished);
    const attempted = [];
    const failures = [];
    const finished = [];
    const errors = [];
    const errorDetails = [];
    const statuses = [];
    const requestDetails = new WeakMap();
    const describe = (request) => {
      let initiator = config.site.url;
      let resourceType = request.resourceType();
      try {
        const frame = request.frame();
        const originFrame = request.isNavigationRequest() ? frame.parentFrame() : frame;
        if (originFrame && /^https?:/.test(originFrame.url())) initiator = originFrame.url();
        if (resourceType === "document") resourceType = frame.parentFrame() ? "sub_frame" : "main_frame";
      } catch {}
      if (["xhr", "fetch"].includes(resourceType)) resourceType = "xmlhttprequest";
      return { url: request.url(), type: resourceType, initiator, method: request.method().toLowerCase(), topUrl: target.url() };
    };
    const onRequest = (request) => { const detail = describe(request); requestDetails.set(request, detail); attempted.push(detail); };
    const onRequestFailed = (request) => failures.push({ ...(requestDetails.get(request) || describe(request)), error: request.failure()?.errorText });
    const onRequestFinished = (request) => finished.push(requestDetails.get(request) || describe(request));
    const onPageError = (error) => { errors.push(error.message); errorDetails.push({ message: error.message, stack: error.stack || "" }); };
    const onResponse = (response) => { if (response.status() >= 400) statuses.push({ url: response.url(), status: response.status() }); };
    target.on("request", onRequest);
    target.on("requestfailed", onRequestFailed);
    target.on("requestfinished", onRequestFinished);
    target.on("pageerror", onPageError);
    target.on("response", onResponse);
    let response;
    let navigationError = null;
    const startedAt = Date.now();
    try { response = await target.goto(config.site.url, { waitUntil: "domcontentloaded", timeout: 30000 }); }
    catch (error) { navigationError = error.message; }
    if (config.site.name === "d3ward" && !navigationError) {
      await target.waitForFunction(() => /Total\s*:\s*\d+/.test(document.body?.innerText || ""), null, { timeout: 35000 }).catch(() => {});
    }
    await target.waitForTimeout(config.settleMs);
    // Scroll without clicking ads or granting consent to exercise dynamic content.
    await target.evaluate(() => window.scrollBy(0, 650)).catch(() => {});
    await target.waitForTimeout(1000);
    const observationCutoffMs = await target.evaluate(() => performance.now());
    const observationEndedAt = Date.now();
    target.off("request", onRequest);
    target.off("requestfailed", onRequestFailed);
    target.off("requestfinished", onRequestFinished);
    target.off("pageerror", onPageError);
    target.off("response", onResponse);
    cdp.off("Network.loadingFinished", onLoadingFinished);
    // Read CPU before the DOM snapshot, whose style/layout queries add work.
    const perf = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((item) => [item.name, item.value]));
    const measured = await target.evaluate((cutoffMs) => {
      const nav = performance.getEntriesByType("navigation")[0];
      const live = globalThis.__adlockLiveMetrics || { longTasks: [], lcpEntries: [] };
      const longTasks = live.longTasks.filter((item) => item.startTime + item.duration <= cutoffMs).map((item) => item.duration);
      const lcpMs = live.lcpEntries.filter((time) => time <= cutoffMs).at(-1) ?? null;
      const visible = (el) => {
        const style = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
      };
      const hidden = [...document.querySelectorAll('[style*="visibility"]')].filter((el) =>
        el.style.getPropertyValue("visibility") === "hidden" && el.style.getPropertyPriority("visibility") === "important" &&
        el.style.getPropertyValue("opacity") === "0" && el.style.getPropertyValue("pointer-events") === "none");
      const bodyText = document.body?.innerText || "";
      const counterText = document.body?.textContent || "";
      const displayedPercent = bodyText.match(/(\d+)\s*%/);
      const challenge = /^(?:Access Denied|Robot Check|Just a moment|Attention Required)/i.test(document.title) ||
        (bodyText.length < 5000 && /verify (?:that )?you are human|enter the characters you see|sorry, you have been blocked|automated access to amazon|unusual traffic|checking your browser/i.test(bodyText));
      // Specific, observed neutral controls expose false positives that an
      // aggregate heading count or successful HTTP response would miss.
      const diagnosticButton = document.getElementById("d3H_adblock");
      const diagnosticGrid = document.getElementById("Ads");
      const glossaryLinks = [...document.links].filter((el) =>
        /^advertisement$/i.test(el.textContent.trim()) && /\/wiki\//.test(el.getAttribute("href") || ""));
      const metadataHidden = hidden.filter((el) => document.head?.contains(el));
      return {
        challenge,
        metrics: {
          domContentLoadedMs: nav?.domContentLoadedEventEnd || null,
          loadMs: nav?.loadEventEnd || null,
          fcpMs: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null,
          lcpMs,
          longTaskCount: longTasks.length,
          longTaskTotalMs: longTasks.reduce((sum, value) => sum + value, 0),
          longestTaskMs: Math.max(0, ...longTasks),
          hiddenSurfaces: hidden.length
        },
        content: {
          title: document.title, bodyTextLength: bodyText.length,
          visibleHeadings: [...document.querySelectorAll("h1,h2,h3")].filter(visible).map((el) => el.innerText.slice(0, 120)).slice(0, 30),
          visibleLinks: [...document.links].filter(visible).length,
          compatibilityChecks: {
            diagnosticButtonVisible: diagnosticButton ? visible(diagnosticButton) : null,
            diagnosticButtonModified: diagnosticButton ? diagnosticButton.style.getPropertyValue("visibility") === "hidden" &&
              diagnosticButton.style.getPropertyPriority("visibility") === "important" : null,
            diagnosticGridVisible: diagnosticGrid ? visible(diagnosticGrid) : null,
            glossaryLinkCount: glossaryLinks.length,
            visibleGlossaryLinks: glossaryLinks.filter(visible).length,
            hiddenHeadMetadata: metadataHidden.length
          },
          textSample: bodyText.slice(0, 1800),
          providerScore: {
            displayedPercent: displayedPercent ? Number(displayedPercent[1]) : null,
            total: Number(counterText.match(/Total\s*:\s*(\d+)/)?.[1]) || null,
            blocked: Number(counterText.match(/(\d+)\s+blocked/)?.[1]) || 0,
            notBlocked: Number(counterText.match(/(\d+)\s+not blocked/)?.[1]) || 0
          },
          hiddenSamples: hidden.slice(0, 20).map((el) => ({ tag: el.tagName, id: el.id, className: String(el.className).slice(0, 180), text: (el.textContent || "").trim().slice(0, 160) }))
        }
      };
    }, observationCutoffMs);
    // A client-blocked failure plus an installed DNR block corroborates attribution.
    // testMatchOutcome is hypothetical, so this is not a historical debug event.
    // DNS/TLS/timeouts/CORS never count as extension-blocked requests.
    const clientBlocked = failures.filter((item) => /ERR_BLOCKED_BY_CLIENT/.test(item.error || ""));
    const uniqueBlocked = [...new Map(clientBlocked.map((request) => [
      JSON.stringify([request.url, request.type, request.initiator, request.method, request.topUrl]), request
    ])).values()];
    const ruleChecks = await control.evaluate(async (requests) => {
      const results = [];
      const tabs = await chrome.tabs.query({});
      for (const request of requests) {
        try {
          const tabId = tabs.find((tab) => tab.url === request.topUrl)?.id;
          const details = { url: request.url, type: request.type, method: request.method,
            initiator: new URL(request.initiator).origin };
          if (Number.isInteger(tabId)) details.tabId = tabId;
          const majorVersion = Number(navigator.userAgent.match(/Chrome\/(\d+)/)?.[1] || 0);
          if (majorVersion >= 145 && /^https?:/.test(request.topUrl)) details.topUrl = request.topUrl;
          const outcome = await chrome.declarativeNetRequest.testMatchOutcome(details);
          results.push({ ...request, matchedRules: outcome.matchedRules, matchError: null });
        } catch (error) { results.push({ ...request, matchedRules: [], matchError: error.message }); }
      }
      return results;
    }, uniqueBlocked);
    for (const item of ruleChecks) {
      item.matchedRules = item.matchedRules.map((rule) => ({ ...rule, action: ruleActions[`${rule.rulesetId}:${rule.ruleId}`] || "unknown" }));
    }
    const confirmed = ruleChecks.filter((item) => item.matchedRules.some((rule) => rule.action === "block"));
    const requestKey = (request) => JSON.stringify([request.url, request.type, request.initiator, request.method, request.topUrl]);
    const blockedKeys = new Set(confirmed.map(requestKey));
    const corroboratedCount = clientBlocked.filter((request) => blockedKeys.has(requestKey(request))).length;
    let screenshotError = null;
    if (config.screenshotPath) {
      await target.evaluate(() => window.scrollTo(0, 0));
      await target.screenshot({ path: config.screenshotPath, timeout: 10000 }).catch((error) => { screenshotError = error.message; });
    }
    return {
      site: config.site, mode: config.mode, repeat: config.repeat,
      browserVersion: context.browser()?.version() || null,
      extensionVersion: await control.evaluate(() => chrome.runtime.getManifest().version),
      status: response?.status() ?? null, finalUrl: target.url(), navigationError,
      challenge: measured.challenge, observedMs: observationEndedAt - startedAt, observationCutoffMs,
      diagnosticMs: Date.now() - observationEndedAt,
      networkHealth: settingsResponse.networkHealth,
      metrics: {
        ...measured.metrics, requestCount: attempted.length, completedRequests: finished.length,
        encodedBytes, blockedRequests: corroboratedCount, uniqueBlockedRequests: confirmed.length,
        clientBlockedRequests: clientBlocked.length, otherFailedRequests: failures.length - corroboratedCount,
        mainThreadTaskMs: (perf.TaskDuration || 0) * 1000,
        scriptDurationMs: (perf.ScriptDuration || 0) * 1000, heapBytes: perf.JSHeapUsedSize || 0
      },
      content: measured.content,
      failedRequests: failures, blockedRuleChecks: ruleChecks, completedRequests: finished,
      httpErrors: statuses, pageErrors: errors, pageErrorDetails: errorDetails,
      screenshotPath: config.screenshotPath || null, screenshotError,
      testScoreText: config.site.name === "d3ward" ? measured.content.textSample : null
    };
  } finally {
    await cdp?.detach().catch(() => {});
    await target?.close().catch(() => {});
    await control.close().catch(() => {});
  }
}
