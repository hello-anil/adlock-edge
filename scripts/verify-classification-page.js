async (page) => {
  const config = __ADLOCK_FIXTURE_CONFIG__;
  const context = page.context();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const id = new URL(worker.url()).hostname;
  const control = await context.newPage();
  const failures = [];
  const errors = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  const results = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await control.goto(`chrome-extension://${id}/ui/options.html`);
    for (const level of ["balanced", "strict"]) {
      const state = await control.evaluate((level) => chrome.runtime.sendMessage({
        type: "settings:update", patch: { globalEnabled: true, level, dynamicFiltering: false, disabledSites: [] }
      }), level);
      check(state.networkHealth?.status === "active", `${level}: actual network configuration active`);
      await page.bringToFront();
      await page.goto(config.fixtureUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => getComputedStyle(document.getElementById("blocking-wall")).display === "none");
      await page.evaluate(() => {
        const root = document.getElementById("shadow-host").attachShadow({ mode: "open" });
        const ad = document.createElement("div");
        ad.id = "shadow-ad"; ad.setAttribute("data-ad-slot", "shadow"); ad.textContent = "Shadow advertising slot";
        root.append(ad);
        document.getElementById("dynamic-label").textContent = "Sponsored";
        document.getElementById("late-wall").textContent = "AdBlock detected. Please disable your ad blocker to continue.";
      });
      await page.waitForFunction(() => {
        const shadow = document.getElementById("shadow-host").shadowRoot.getElementById("shadow-ad");
        return getComputedStyle(shadow).visibility === "hidden" &&
          getComputedStyle(document.getElementById("dynamic-card")).visibility === "hidden" &&
          getComputedStyle(document.getElementById("late-wall")).display === "none";
      });
      const snapshot = await page.evaluate(() => {
        const visible = (el) => { const style = getComputedStyle(el); return el.getClientRects().length > 0 && style.display !== "none" && style.visibility !== "hidden"; };
        return {
          neutralDetails: Object.fromEntries(["glossary", "sponsored-glossary", "d3H_adblock", "Ads", "host-label", "editorial"].map((id) => {
            const el = document.getElementById(id);
            return [id, { visible: visible(el), style: el.getAttribute("style"), text: el.textContent }];
          })),
          visibleNeutral: ["glossary", "sponsored-glossary", "d3H_adblock", "Ads", "host-label", "editorial"].every((id) => visible(document.getElementById(id))),
          hiddenAds: ["slot-ad", "aria-ad", "sponsored-ad", "dynamic-card", "blocking-wall", "late-wall"].every((id) => !visible(document.getElementById(id))),
          metadataUntouched: [...document.head.querySelectorAll("*")].every((el) => el.style.getPropertyValue("visibility") !== "hidden"),
          title: document.title
        };
      });
      check(snapshot.visibleNeutral, `${level}: preserve glossary, controls, host list and editorial card`);
      check(snapshot.hiddenAds, `${level}: explicit, sponsored, dynamic and blocking ad surfaces hidden`);
      check(snapshot.metadataUntouched, `${level}: head metadata unmodified`);
      await control.evaluate(() => chrome.runtime.sendMessage({ type: "settings:update", patch: { globalEnabled: false } }));
      await page.waitForFunction(() => {
        const visible = (el) => { const style = getComputedStyle(el); return el.getClientRects().length > 0 && style.display !== "none" && style.visibility !== "hidden"; };
        const ids = ["slot-ad", "aria-ad", "sponsored-ad", "dynamic-card", "blocking-wall", "late-wall"];
        return ids.every((id) => visible(document.getElementById(id))) &&
          visible(document.getElementById("shadow-host").shadowRoot.getElementById("shadow-ad"));
      });
      results.push({ level, ...snapshot, shadowAdHidden: true, pauseRestored: true });
    }
    check(errors.length === 0, "no page exceptions during real extension verification");
    return { extensionVersion: await control.evaluate(() => chrome.runtime.getManifest().version), results, errors, failures, passed: failures.length === 0 };
  } finally { await control.close(); }
}
