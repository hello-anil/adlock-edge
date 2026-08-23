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

let activeTab = null;
let activeHostname = "";
let currentSettings = null;
let currentStats = { todayHidden: 0, totalRedirects: 0, totalHidden: 0 };
let currentPageState = { pageHidden: 0 };
let contentConnected = false;
let interactionPending = false;
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
  const missingSiteAccess = Boolean(activeHostname && settings.globalEnabled && !contentConnected);
  setText(elements.statusText, missingSiteAccess
    ? "Site access unavailable"
    : settings.globalEnabled
      ? `${settings.level[0].toUpperCase()}${settings.level.slice(1)} protection`
      : "Protection paused everywhere");
  setText(elements.networkText, missingSiteAccess
    ? "Network-only: allow site access and reload"
    : settings.globalEnabled
      ? "Network filtering active"
      : "Network filtering paused");
  elements.networkText.parentElement.classList.toggle("off", !settings.globalEnabled || missingSiteAccess);
  setText(elements.hostname, activeHostname || "Browser page unavailable");
  elements.siteToggle.disabled = interactionPending || !activeHostname || !settings.globalEnabled;
  setAttribute(elements.siteToggle, "aria-checked", String(siteEnabled));
  elements.siteToggle.title = siteEnabled ? "Pause on this site" : "Enable on this site";
  elements.levelSelect.value = settings.level;
  elements.levelSelect.disabled = interactionPending || !settings.globalEnabled;
  setText(elements.levelHint, LEVEL_HINTS[settings.level]);
  setText(elements.pageCount, formatNumber(currentPageState.pageHidden || 0));
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
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response;
}

async function getPageState(tab) {
  if (!tab?.id || !activeHostname) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: "content:getPageState" });
  } catch (_error) {
    return null;
  }
}

async function initialize() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const url = new URL(activeTab?.url || "");
    if (["http:", "https:"].includes(url.protocol)) activeHostname = url.hostname.toLowerCase().replace(/^www\./, "");
  } catch (_error) {
    activeHostname = "";
  }
  const [snapshot, contentState] = await Promise.all([
    send({ type: "popup:getState", tabId: activeTab?.id }),
    getPageState(activeTab)
  ]);
  contentConnected = Boolean(contentState);
  render(snapshot.settings, snapshot.stats, { pageHidden: snapshot.pageHidden || contentState?.pageHidden || 0 });
}

async function updateOptimistically(message, nextSettings, { reload = false } = {}) {
  if (!currentSettings || interactionPending) return;
  const previousSettings = currentSettings;
  interactionPending = true;
  render(nextSettings, currentStats, currentPageState);
  let settledSettings = previousSettings;
  let updateError = null;
  try {
    const response = await send(message);
    settledSettings = response.settings;
  } catch (error) {
    updateError = error;
  } finally {
    interactionPending = false;
    render(settledSettings, currentStats, currentPageState);
  }
  if (updateError) {
    showTemporaryStatus("Change could not be saved");
    console.error(updateError);
    return;
  }
  if (reload && activeTab?.id) chrome.tabs.reload(activeTab.id);
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
  if (enable) disabledSites.delete(activeHostname);
  else disabledSites.add(activeHostname);
  updateOptimistically(
    { type: "site:setEnabled", hostname: activeHostname, enabled: enable },
    { ...currentSettings, disabledSites: [...disabledSites] },
    { reload: true }
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

elements.optionsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());

globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
  if (area !== "local" || !changes.stats?.newValue || !currentSettings) return;
  render(currentSettings, changes.stats.newValue, currentPageState);
});

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
