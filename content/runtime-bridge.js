(function exposeRuntimeBridge(root, factory) {
  const bridge = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = bridge;
  root.AdLockRuntimeBridge = bridge;
})(typeof globalThis !== "undefined" ? globalThis : this, function createRuntimeBridge() {
  "use strict";

  function isAvailable(chromeApi) {
    try {
      return Boolean(chromeApi?.runtime?.id);
    } catch (_error) {
      return false;
    }
  }

  function isInvalidationError(error) {
    return /extension context (?:invalidated|was invalidated)/i.test(String(error?.message || error || ""));
  }

  function notifyInvalidated(chromeApi, error, callback) {
    if ((isInvalidationError(error) || !isAvailable(chromeApi)) && typeof callback === "function") {
      try { callback(error); } catch (_callbackError) { /* The stale context is already shutting down. */ }
    }
  }

  async function sendMessage(chromeApi, message, onInvalidated) {
    if (!isAvailable(chromeApi)) {
      notifyInvalidated(chromeApi, new Error("Extension context invalidated"), onInvalidated);
      return null;
    }
    try {
      return await chromeApi.runtime.sendMessage(message);
    } catch (error) {
      notifyInvalidated(chromeApi, error, onInvalidated);
      return null;
    }
  }

  async function getLocal(chromeApi, key, onInvalidated) {
    if (!isAvailable(chromeApi)) {
      notifyInvalidated(chromeApi, new Error("Extension context invalidated"), onInvalidated);
      return null;
    }
    try {
      return await chromeApi.storage.local.get(key);
    } catch (error) {
      notifyInvalidated(chromeApi, error, onInvalidated);
      return null;
    }
  }

  return Object.freeze({ isAvailable, isInvalidationError, sendMessage, getLocal });
});
