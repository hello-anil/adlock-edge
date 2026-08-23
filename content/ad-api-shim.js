(function installAdApiCompatibilityShim() {
  "use strict";

  // This resource is substituted only when a page explicitly requests the
  // standard Google ad loader. It preserves the small API surface commonly
  // used by availability checks without downloading or rendering an ad.
  if (!("adsbygoogle" in globalThis)) globalThis.adsbygoogle = [];
  if (!("google_ad_status" in globalThis)) globalThis.google_ad_status = 1;
  if (!("canRunAds" in globalThis)) globalThis.canRunAds = true;
})();
