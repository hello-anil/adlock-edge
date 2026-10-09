"use strict";

// Set intrinsic toolbar dimensions before the first stylesheet/layout pass.
// File previews can still fit narrow viewports without affecting native sizing.
if (location.protocol === "chrome-extension:") {
  document.documentElement.classList.add("extension-popup");
}
