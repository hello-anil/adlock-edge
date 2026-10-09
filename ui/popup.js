"use strict";

const elements = Object.fromEntries([
  "statusText", "globalToggle", "pageCount", "networkText", "hostname",
  "siteToggle", "levelSelect", "levelHint", "todayCount", "redirectsCount", "totalCount", "optionsButton"
].map((id) => [id, document.getElementById(id)]));

const LEVEL_HINTS = {
  relaxed: "List blocking with high-confidence detection",
  balanced: "Conservative list + algorithmic detection",
  strict: "Aggressive detection and tracker blocking"
};

const previewMode = !(globalThis.chrome?.runtime?.id
  && typeof globalThis.chrome.runtime.sendMessage === "function"
  && typeof globalThis.chrome.tabs?.query === "function");
const PREVIEW_KEY = "adlock-popup-preview-v1";
const PREVIEW_DEFAULTS = { globalEnabled: true, level: "strict", disabledSites: [] };
let previewSettings = { ...PREVIEW_DEFAULTS, disabledSites: [] };
if (previewMode) {
  try {
    const saved = JSON.parse(localStorage.getItem(PREVIEW_KEY));
    if (saved && typeof saved.globalEnabled === "boolean" && ["relaxed", "balanced", "strict"].includes(saved.level)) {
      previewSettings = { globalEnabled: saved.globalEnabled, level: saved.level,
        disabledSites: Array.isArray(saved.disabledSites) ? saved.disabledSites.filter(site => typeof site === "string") : [] };
    }
  } catch (_error) { /* The preview also works when local storage is unavailable. */ }
}

let activeTab = null;
let activeHostname = "";
let currentSettings = null;
let currentStats = { todayHidden: 0, totalRedirects: 0, totalHidden: 0 };
let currentPageState = { pageHidden: 0 };
let contentConnected = false;
let contentChecked = false;
let interactionPending = false;
let queuedSettings = null;
let settingsRefreshInFlight = false;
let pageCountRevision = 0;
let networkHealth = { status: "unavailable" };
const standardNumberFormat = new Intl.NumberFormat();
const compactNumberFormat = new Intl.NumberFormat(undefined, { notation: "compact" });

function formatNumber(value) {
  const number = Number(value) || 0;
  return (number > 9999 ? compactNumberFormat : standardNumberFormat).format(number);
}

function setText(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

function setAttribute(element, name, value) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function hostnameMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function siteIsEnabled(settings) {
  return Boolean(activeHostname && settings.globalEnabled && !settings.disabledSites.some((domain) => hostnameMatches(activeHostname, domain)));
}

function render(settings, stats, pageState) {
  currentSettings = settings;
  currentStats = stats || currentStats;
  currentPageState = pageState || currentPageState;
  const siteEnabled = siteIsEnabled(settings);
  document.body.classList.toggle("disabled", !settings.globalEnabled);
  elements.globalToggle.disabled = interactionPending;
  setAttribute(elements.globalToggle, "aria-pressed", String(settings.globalEnabled));
  const missingSiteAccess = Boolean(siteEnabled && contentChecked && !contentConnected);
  const networkUnhealthy = !previewMode && !["active", "paused"].includes(networkHealth.status);
  setText(elements.statusText, previewMode ? (interactionPending ? "Updating preview..."
    : settings.globalEnabled ? `Preview · ${settings.level[0].toUpperCase()}${settings.level.slice(1)}` : "Preview · Paused")
    : interactionPending ? "Applying protection changes..."
    : networkUnhealthy ? "Network protection needs attention"
    : settings.globalEnabled && activeHostname && !siteEnabled ? "Protection paused on this site"
    : siteEnabled && !contentChecked ? "Connecting to site..."
    : missingSiteAccess
    ? "Site access unavailable"
    : settings.globalEnabled
      ? `${settings.level[0].toUpperCase()}${settings.level.slice(1)} protection`
      : "Protection paused everywhere");
  setText(elements.networkText, previewMode ? "Demo data · No blocking"
    : interactionPending ? "Checking network filtering..."
    : networkUnhealthy ? "Could not verify filtering - reopen or reload extension"
    : settings.globalEnabled && activeHostname && !siteEnabled ? "Network filtering paused for this site"
    : missingSiteAccess
    ? "Network-only: allow site access and reload"
    : settings.globalEnabled
      ? "Network filtering active"
      : "Network filtering paused");
  elements.networkText.parentElement.classList.toggle("off", previewMode || !settings.globalEnabled || Boolean(activeHostname && !siteEnabled) || networkUnhealthy);
  setText(elements.hostname, activeHostname || "Browser page unavailable");
  elements.siteToggle.disabled = interactionPending || !activeHostname || !settings.globalEnabled;
  setAttribute(elements.siteToggle, "aria-checked", String(siteEnabled));
  const parentException = settings.disabledSites.find((domain) => domain !== activeHostname && hostnameMatches(activeHostname, domain));
  elements.siteToggle.title = !activeHostname ? "Open a website to use this control" : !settings.globalEnabled
    ? "Enable protection everywhere to change this site" : siteEnabled ? "Pause on this site" : parentException
    ? `Enable protection for ${parentException} and its subdomains`
    : "Enable on this site";
  elements.levelSelect.value = settings.level;
  elements.levelSelect.disabled = interactionPending;
  setText(elements.levelHint, LEVEL_HINTS[settings.level]);
  setText(elements.pageCount, settings.globalEnabled ? formatNumber(currentPageState.pageHidden || 0) : "OFF");
  setText(elements.todayCount, formatNumber(currentStats.todayHidden));
  setText(elements.redirectsCount, formatNumber(currentStats.totalRedirects));
  setText(elements.totalCount, formatNumber(currentStats.totalHidden));
  document.querySelector(".shell").setAttribute("aria-busy", String(interactionPending));
}

function showTemporaryStatus(message) {
  clearTimeout(showTemporaryStatus.timer);
  setText(elements.statusText, message);
  showTemporaryStatus.timer = setTimeout(() => {
    if (currentSettings) render(currentSettings, currentStats, currentPageState);
  }, 2400);
}

async function send(message) {
  if (previewMode) {
    if (message.type === "settings:update") previewSettings = { ...previewSettings, ...message.patch };
    if (message.type === "site:setEnabled") previewSettings.disabledSites = message.enabled ? [] : [message.hostname];
    if (message.type !== "popup:getState") {
      try { localStorage.setItem(PREVIEW_KEY, JSON.stringify(previewSettings)); } catch (_error) {}
    }
    return { settings: { ...previewSettings, disabledSites: [...previewSettings.disabledSites] },
      stats: { todayHidden: 42, totalRedirects: 3, totalHidden: 1284 }, pageHidden: 7, networkHealth: { status: "preview" } };
  }
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response;
}

async function getPageState(tab) {
  if (!Number.isInteger(tab?.id) || !activeHostname) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: "content:getPageState" });
  } catch (_error) {
    return null;
  }
}

async function initialize() {
  if (previewMode) {
    activeHostname = "example.com";
    contentChecked = true;
    contentConnected = true;
    const snapshot = await send({ type: "popup:getState" });
    networkHealth = snapshot.networkHealth;
    render(snapshot.settings, snapshot.stats, { pageHidden: snapshot.pageHidden });
    return;
  }
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const url = new URL(activeTab?.url || "");
    if (["http:", "https:"].includes(url.protocol)) activeHostname = url.hostname.toLowerCase().replace(/^www\./, "");
  } catch (_error) {
    activeHostname = "";
  }
  // Optional page messaging must not hold up the verified protection controls.
  const initialCountRevision = pageCountRevision;
  const contentStatePromise = getPageState(activeTab);
  const snapshot = await send({ type: "popup:getState", tabId: activeTab?.id });
  networkHealth = snapshot.networkHealth || { status: "unavailable" };
  render(snapshot.settings, snapshot.stats, { pageHidden: Math.max(snapshot.pageHidden || 0, currentPageState.pageHidden) });
  contentStatePromise.then((contentState) => {
    contentChecked = true;
    contentConnected = Boolean(contentState);
    if (pageCountRevision === initialCountRevision && !currentPageState.pageHidden && contentState?.pageHidden) {
      currentPageState = { pageHidden: contentState.pageHidden };
    }
    render(currentSettings, currentStats, currentPageState);
  });
}

async function refreshSettings() {
  if (!currentSettings || interactionPending || settingsRefreshInFlight) return;
  queuedSettings = null;
  settingsRefreshInFlight = true;
  try {
    const snapshot = await send({ type: "popup:getState", tabId: activeTab?.id });
    if (interactionPending) {
      queuedSettings ||= snapshot.settings;
      return;
    }
    networkHealth = snapshot.networkHealth || { status: "unavailable" };
    render(snapshot.settings, snapshot.stats, { pageHidden: snapshot.pageHidden || currentPageState.pageHidden });
    if (JSON.stringify(queuedSettings) === JSON.stringify(snapshot.settings)) queuedSettings = null;
  } catch (error) {
    networkHealth = { status: "unavailable" };
    render(currentSettings, currentStats, currentPageState);
    showTemporaryStatus("Unable to refresh protection");
    console.error(error);
  } finally {
    settingsRefreshInFlight = false;
    if (queuedSettings && !interactionPending) void refreshSettings();
  }
}

async function updateOptimistically(message, nextSettings) {
  if (!currentSettings || interactionPending) return;
  const previousSettings = currentSettings;
  interactionPending = true;
  render(nextSettings, currentStats, currentPageState);
  let settledSettings = previousSettings;
  let updateError = null;
  try {
    const response = await send(message);
    settledSettings = response.settings;
    networkHealth = response.networkHealth || { status: "unavailable" };
  } catch (error) {
    updateError = error;
    // A failed mutation may also have failed to roll back the browser rules.
    networkHealth = { status: "unavailable" };
  } finally {
    interactionPending = false;
    render(settledSettings, currentStats, currentPageState);
    // Ignore our own storage echo; verify settings committed by another UI.
    if (JSON.stringify(queuedSettings) === JSON.stringify(settledSettings)) queuedSettings = null;
    if (queuedSettings) void refreshSettings();
  }
  if (updateError) {
    showTemporaryStatus("Change could not be saved");
    console.error(updateError);
    return;
  }
}

elements.globalToggle.addEventListener("click", () => {
  if (!currentSettings) return;
  const globalEnabled = !currentSettings.globalEnabled;
  updateOptimistically(
    { type: "settings:update", patch: { globalEnabled } },
    { ...currentSettings, globalEnabled }
  );
});

elements.siteToggle.addEventListener("click", () => {
  if (!currentSettings || !activeHostname) return;
  const enable = !siteIsEnabled(currentSettings);
  const disabledSites = new Set(currentSettings.disabledSites);
  if (enable) {
    for (const domain of disabledSites) {
      if (hostnameMatches(activeHostname, domain)) disabledSites.delete(domain);
    }
  }
  else disabledSites.add(activeHostname);
  updateOptimistically(
    { type: "site:setEnabled", hostname: activeHostname, enabled: enable },
    { ...currentSettings, disabledSites: [...disabledSites] }
  );
});

elements.levelSelect.addEventListener("change", () => {
  if (!currentSettings) return;
  const level = elements.levelSelect.value;
  updateOptimistically(
    { type: "settings:update", patch: { level } },
    { ...currentSettings, level }
  );
});

elements.optionsButton.addEventListener("click", () => {
  if (previewMode) document.getElementById("previewDialog").showModal();
  else chrome.runtime.openOptionsPage();
});
document.getElementById("previewClose")?.addEventListener("click", () => document.getElementById("previewDialog").close());
document.getElementById("previewReset")?.addEventListener("click", () => {
  previewSettings = { ...PREVIEW_DEFAULTS, disabledSites: [] };
  try { localStorage.removeItem(PREVIEW_KEY); } catch (_error) {}
  render(previewSettings, currentStats, currentPageState);
  document.getElementById("previewDialog").close();
});

if (!previewMode) {
globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
  if (area !== "local" || !currentSettings) return;
  if (changes.stats?.newValue) render(currentSettings, changes.stats.newValue, currentPageState);
  if (changes.settings?.newValue) {
    if (!interactionPending && JSON.stringify(changes.settings.newValue) === JSON.stringify(currentSettings)) return;
    queuedSettings = changes.settings.newValue;
    void refreshSettings();
  }
});

globalThis.chrome?.runtime?.onMessage?.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id || message?.type !== "popup:pageCount" || message.tabId !== activeTab?.id) return;
  const count = Number(message.pageHidden);
  if (!Number.isFinite(count) || count < 0) return;
  pageCountRevision++;
  currentPageState = { pageHidden: count };
  if (currentSettings) render(currentSettings, currentStats, currentPageState);
});
}

initialize()
  .catch((error) => {
    elements.statusText.textContent = "Unable to load protection state";
    console.error(error);
  })
  .finally(() => {
    document.body.classList.remove("is-loading");
    document.querySelector(".shell").setAttribute("aria-busy", "false");
    performance.mark?.("adlock-popup-ready");
  });
