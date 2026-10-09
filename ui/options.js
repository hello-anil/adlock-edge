"use strict";

const form = document.getElementById("settingsForm");
const statusElement = document.getElementById("saveStatus");
const saveButton = document.getElementById("saveButton");
const fields = {
  globalEnabled: document.getElementById("globalEnabled"),
  level: document.getElementById("level"),
  showPlaceholders: document.getElementById("showPlaceholders"),
  redirectProtection: document.getElementById("redirectProtection"),
  antiAdblockCompatibility: document.getElementById("antiAdblockCompatibility"),
  dynamicFiltering: document.getElementById("dynamicFiltering"),
  cleanTrackingParameters: document.getElementById("cleanTrackingParameters"),
  privacyApiProtection: document.getElementById("privacyApiProtection"),
  fingerprintProtection: document.getElementById("fingerprintProtection"),
  disabledSites: document.getElementById("disabledSites"),
  customBlockDomains: document.getElementById("customBlockDomains"),
  customSelectors: document.getElementById("customSelectors")
};

let currentSettings = null;
let initialized = false;
let saving = false;

function lines(value) {
  return [...new Set(String(value).split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean))];
}

function cleanDomain(value) {
  let text = String(value).trim().toLowerCase();
  try {
    if (text.includes("://")) text = new URL(text).hostname;
  } catch (_error) {
    return "";
  }
  text = text.replace(/^\*\./, "").replace(/^www\./, "").replace(/^\.+|\.+$/g, "");
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(text) ? text : "";
}

function parseDomains(value, label) {
  const raw = lines(value);
  const cleaned = raw.map(cleanDomain);
  const invalid = raw.filter((_item, index) => !cleaned[index]);
  if (invalid.length) throw new Error(`${label}: invalid domain “${invalid[0]}”`);
  return [...new Set(cleaned)];
}

function parseSelectors(value) {
  const selectors = AdLockSettingsTransfer.selectorLines(value);
  const fragment = document.createDocumentFragment();
  for (const selector of selectors) {
    try {
      fragment.querySelector(selector);
    } catch (_error) {
      throw new Error(`Invalid CSS selector: “${selector}”`);
    }
  }
  return selectors;
}

function setStatus(message, error = false) {
  statusElement.textContent = message;
  statusElement.style.color = error ? "#f38b98" : "#68dda9";
  clearTimeout(setStatus.timer);
  setStatus.timer = setTimeout(() => { statusElement.textContent = ""; }, 3500);
}

function populate(settings) {
  currentSettings = settings;
  fields.globalEnabled.checked = settings.globalEnabled;
  fields.level.value = settings.level;
  fields.showPlaceholders.checked = settings.showPlaceholders;
  fields.redirectProtection.checked = settings.redirectProtection;
  fields.antiAdblockCompatibility.checked = settings.antiAdblockCompatibility !== false;
  fields.dynamicFiltering.checked = settings.dynamicFiltering === true;
  fields.cleanTrackingParameters.checked = settings.cleanTrackingParameters !== false;
  fields.privacyApiProtection.checked = settings.privacyApiProtection !== false;
  fields.fingerprintProtection.checked = settings.fingerprintProtection !== false;
  fields.disabledSites.value = settings.disabledSites.join("\n");
  fields.customBlockDomains.value = settings.customBlockDomains.join("\n");
  fields.customSelectors.value = settings.customSelectors.join("\n");
  form.classList.remove("is-dirty");
  saveButton.textContent = "Saved";
  saveButton.disabled = true;
}

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response;
}

async function initialize() {
  const { settings } = await send({ type: "popup:getState" });
  populate(settings);
  initialized = true;
}

form.addEventListener("input", () => {
  if (!initialized || saving) return;
  form.classList.add("is-dirty");
  saveButton.textContent = "Save changes";
  saveButton.disabled = false;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (saving) return;
  saving = true;
  saveButton.disabled = true;
  saveButton.textContent = "Saving…";
  form.setAttribute("aria-busy", "true");
  try {
    const patch = {
      globalEnabled: fields.globalEnabled.checked,
      level: fields.level.value,
      showPlaceholders: fields.showPlaceholders.checked,
      redirectProtection: fields.redirectProtection.checked,
      antiAdblockCompatibility: fields.antiAdblockCompatibility.checked,
      dynamicFiltering: fields.dynamicFiltering.checked,
      cleanTrackingParameters: fields.cleanTrackingParameters.checked,
      privacyApiProtection: fields.privacyApiProtection.checked,
      fingerprintProtection: fields.fingerprintProtection.checked,
      disabledSites: parseDomains(fields.disabledSites.value, "Allowed sites"),
      customBlockDomains: parseDomains(fields.customBlockDomains.value, "Blocked domains"),
      customSelectors: parseSelectors(fields.customSelectors.value)
    };
    const { settings } = await send({ type: "settings:update", patch });
    populate(settings);
    setStatus("Changes saved");
  } catch (error) {
    setStatus(error.message, true);
    saveButton.textContent = "Try again";
  } finally {
    saving = false;
    saveButton.disabled = !form.classList.contains("is-dirty");
    form.setAttribute("aria-busy", "false");
  }
});

document.getElementById("resetStatsButton").addEventListener("click", async () => {
  await send({ type: "stats:reset" });
  setStatus("Statistics reset");
});

document.getElementById("resetReputationButton").addEventListener("click", async () => {
  await send({ type: "reputation:reset" });
  setStatus("Learned hosts reset");
});

document.getElementById("exportButton").addEventListener("click", () => {
  if (!currentSettings) return;
  const blob = new Blob([JSON.stringify({ version: 1, settings: currentSettings }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "adlock-settings.json";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus("Settings exported");
});

document.getElementById("importFile").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file || !initialized || saving) return;
  try {
    if (file.size > AdLockSettingsTransfer.MAX_IMPORT_BYTES) throw new Error("Settings file must be smaller than 256 KB");
    const fragment = document.createDocumentFragment();
    const patch = AdLockSettingsTransfer.parseBackup(await file.text(), (selector) => fragment.querySelector(selector));
    populate({ ...currentSettings, ...patch });
    form.classList.add("is-dirty");
    saveButton.textContent = "Save imported settings";
    saveButton.disabled = false;
    setStatus("Backup loaded for review. Save changes to apply it.");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    event.target.value = "";
  }
});

document.getElementById("diagnosticsButton").addEventListener("click", async () => {
  try {
    const snapshot = await send({ type: "popup:getState" });
    const report = {
      formatVersion: 1,
      extensionVersion: chrome.runtime.getManifest().version,
      protectionLevel: snapshot.settings.level,
      globalEnabled: snapshot.settings.globalEnabled,
      localLearningEnabled: snapshot.settings.dynamicFiltering,
      networkHealth: snapshot.networkHealth || { status: "unavailable" },
      counts: {
        siteExceptions: snapshot.settings.disabledSites.length,
        customDomains: snapshot.settings.customBlockDomains.length,
        customSelectors: snapshot.settings.customSelectors.length
      }
    };
    document.getElementById("diagnosticsOutput").value = JSON.stringify(report, null, 2);
    setStatus("Diagnostics ready to review and copy. Nothing was sent.");
  } catch (error) {
    setStatus(error.message, true);
  }
});

initialize().catch((error) => setStatus(error.message, true));
