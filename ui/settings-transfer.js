(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AdLockSettingsTransfer = api;
})(globalThis, function () {
  "use strict";
  const MAX_IMPORT_BYTES = 256 * 1024;
  const booleanKeys = ["globalEnabled", "showPlaceholders", "redirectProtection", "antiAdblockCompatibility",
    "dynamicFiltering", "cleanTrackingParameters", "privacyApiProtection", "fingerprintProtection"];
  const listLimits = { disabledSites: 1000, customBlockDomains: 1000, customSelectors: 250 };

  function parseBackup(text, validateSelector) {
    if (typeof text !== "string" || new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) {
      throw new Error("Settings file must be smaller than 256 KB");
    }
    let backup;
    try { backup = JSON.parse(text); } catch (_error) { throw new Error("Settings file is not valid JSON"); }
    if (backup?.version !== 1 || !backup.settings || Array.isArray(backup.settings) || typeof backup.settings !== "object") {
      throw new Error("Unsupported settings backup format");
    }
    const settings = backup.settings;
    const allowedKeys = new Set([...booleanKeys, "level", ...Object.keys(listLimits)]);
    if (Object.keys(settings).some((key) => !allowedKeys.has(key))) throw new Error("Backup contains unknown settings");
    const patch = {};
    for (const key of booleanKeys) {
      if (!(key in settings)) continue;
      if (typeof settings[key] !== "boolean") throw new Error(`Invalid setting: ${key}`);
      patch[key] = settings[key];
    }
    if ("level" in settings) {
      if (!["relaxed", "balanced", "strict"].includes(settings.level)) throw new Error("Invalid protection level");
      patch.level = settings.level;
    }
    for (const [key, limit] of Object.entries(listLimits)) {
      if (!(key in settings)) continue;
      if (!Array.isArray(settings[key]) || settings[key].length > limit) throw new Error(`Invalid or oversized list: ${key}`);
      patch[key] = settings[key].map((value) => {
        if (typeof value !== "string" || !value.trim() || value.length > 4096) throw new Error(`Invalid entry: ${key}`);
        const entry = value.trim();
        if (key === "customSelectors") {
          try { validateSelector(entry); } catch (_error) { throw new Error(`Invalid CSS selector: ${entry}`); }
        } else if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(entry)) {
          throw new Error(`Invalid domain: ${entry}`);
        }
        return entry;
      });
    }
    if (!Object.keys(patch).length) throw new Error("Backup contains no settings");
    return patch;
  }

  // Commas belong to CSS syntax, including :is() and attribute values.
  function selectorLines(value) {
    return [...new Set(String(value).split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
  }
  return Object.freeze({ MAX_IMPORT_BYTES, parseBackup, selectorLines });
});
