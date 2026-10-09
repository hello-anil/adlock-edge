# AdLock

> [!TIP]
> **Official extension:** [Install AdLock from Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/dknkhicpaggioijaimoapfdmcgggcbkm).

Latest patch: **2.1.8** adds the compact Spider Royal card, a larger original logo, locally bundled comic-style fonts, golden spider web, and clearer paused controls. It retains the preview, settings synchronization, privacy, navigation, and filtering fixes from previous releases. Update the files in your existing unpacked folder, then click **Reload** at `edge://extensions` or `chrome://extensions` and reload open pages. Keep the existing registration to retain settings; export settings before removing an extension or switching folders.

Block ads, trackers and unwanted popups with controls that stay on your device. Use the toolbar to pause a site or choose Relaxed, Balanced or Strict protection. If a page breaks, switch to Balanced or pause the site and reload.

Download the packaged extension from [GitHub Releases](https://github.com/hello-anil/adlock-edge/releases/tag/v2.1.8). The source is available under the MIT license; the bundled Bangers font includes its own OFL license.

AdLock is a local-first Manifest V3 blocker for Chrome, Edge, Brave, and other Chromium browsers. It combines packaged network rules with an incremental page classifier, popup and redirect protection, dynamic local reputation, privacy API controls, fingerprint resistance, and conditional cosmetic filters. Filter data, settings, reputation evidence, and statistics remain on the device; the extension does not download remote code or send browsing data elsewhere.

Strict protection is the default for new installations. Existing installations keep their saved level and site exceptions.

Version 2.1.0 makes local learning opt-in for new installations and restricts learned blocking to Strict mode. Existing saved learning choices are preserved; incognito tabs never add learned evidence. The popup checks installed network configuration before reporting it active. Settings now supports reviewed backup restoration and privacy-minimized support diagnostics. See [CHANGELOG.md](CHANGELOG.md) for migration details.


## Protection architecture

AdLock uses several independent layers so that one missed signal does not leave the page unprotected:

| Layer | What it covers |
| --- | --- |
| Always-on network rules | Dedicated ad, native-ad, video-ad, popup, and cryptomining hosts, plus narrow high-confidence payload patterns |
| Strict network rules | Push vendors, trackers, session replay, analytics, generic third-party pings, marketing pixels, VAST/VMAP endpoints, and aggressive ad-server paths |
| Strict navigation privacy | Removes common click IDs and campaign parameters before a top-level navigation leaves the browser |
| Dynamic local reputation | Promotes a previously unknown resource host only after high-confidence evidence from at least two unrelated sites; one compact dynamic rule covers learned hosts |
| Main-world privacy guard | Disables advertising auctions, Topics, attribution triggers, tracking beacons, suspicious ad workers, and shared-storage ad capabilities; Strict mode coarsens fingerprint readbacks |
| Main-world navigation guard | Scripted popups, popunders, click-unders, and known advertising destinations before page handlers can navigate |
| Isolated page engine | Sponsored cards, banners, overlays, fake media/download controls, video-ad surfaces, anti-adblock notices, and dynamically inserted ad elements |
| USER-origin cosmetic filters | High-confidence protection rules that override hostile page CSS while protection is enabled; an additional selector set is applied only in Strict mode |

The page engine uses weighted evidence rather than a single class name or keyword. Explicit ad metadata and known ad URLs score strongly; editorial, authentication, payment, CAPTCHA, and ordinary navigation contexts lower or veto the score. Relaxed, Balanced, and Strict modes trade increasing coverage for increasing false-positive risk.

The reputation learner is intentionally resistant to list poisoning. Duplicate evidence from the same site is ignored, protected login/payment/challenge providers are excluded, same-site resources are not learned, records expire after 30 days, and the store is capped at 500 hosts. Learned rules cover subresources only; top-level navigation remains governed by the explainable redirect analyzer and its **Allow once** control.

Fingerprint protection is Strict-only. It adds stable per-page low-bit noise to small canvas and audio readbacks, returns generic WebGL debug values, and coarsens high-entropy User-Agent Client Hints. Large visible canvases are excluded to avoid changing displayed artwork. Balanced and Relaxed modes preserve native fingerprint surfaces.

## Canonical filter data

[`data/filter-data.json`](data/filter-data.json) is the single reviewed source for packaged domain categories and generated endpoint rules. Do not hand-edit generated files. Run:

```powershell
node scripts/generate-filter-data.mjs
```

The deterministic generator writes:

- `content/domain-data.js` for the page classifier and navigation guard;
- `rules/generated-always.json` for always-on ad, video, native, popup, and miner domains;
- `rules/generated-strict.json` for push, tracking, privacy, and aggressive endpoint rules;
- `rules/generated-redirects.json` for top-level navigation to known ad destinations.

Verify that committed outputs still match the source without modifying them:

```powershell
node scripts/generate-filter-data.mjs --check
```

This structure keeps duplicated host lists from drifting between the network, DOM, and popup layers. New categories should be assigned an explicit tier, resource profile, priority, and stable rule ID in the canonical data, then regenerated and tested.

## Recursive and self-healing protection

Redirect wrappers are decoded recursively with hard limits: at most three nested levels, eight distinct URLs, and 4096 characters per candidate. The bounds catch encoded redirect chains while preventing untrusted links from causing unbounded work.

The DOM scanner is mutation-driven and processes candidates in bounded batches. It discovers open shadow roots, gives each one its own observer, and recursively scans newly exposed roots. Periodic maintenance prunes disconnected state, rechecks ad surfaces that page scripts may have restored, and resumes scanning after page visibility or back/forward-cache transitions. Every eligible frame receives its own content scripts through `all_frames` and origin fallback matching.

To protect the host page's responsiveness, each scanner task handles at most 350 elements and yields after a 6-millisecond time budget (an individual element can overrun that budget). Mutation callbacks queue and deduplicate work instead of inspecting text and layout synchronously. Changed elements alternate with subtree discovery so animation churn cannot starve newly inserted ads. Pending scan roots are capped at 128; excess insertions trigger an incremental recovery sweep. Text inspection samples at most 4097 characters and 256 subtree nodes rather than copying entire feeds.

Hidden tabs defer cosmetic scans until visible, while browser network rules remain active. Returning to a tab resumes pending work without a full-document rescan. Periodic maintenance only revisits tracked hidden surfaces. Custom selectors use one combined match before resolving the exact matching rule, and packaged ad-host lookups use hostname suffix sets. Ordinary embedded video and payment frames still require advertising evidence before they can be hidden.

Closed shadow roots and browser-owned UI remain outside the extension's reach by design.

## Per-site pause and cosmetic CSS

`content/protection.css` is inserted at the browser's USER style origin only while protection is active for the current site. `content/strict.css` is added only when the selected level is Strict. Downgrading the level or pausing a site removes the corresponding styles from every frame; re-enabling protection restores them.

`content/cosmetic.css` contains extension-owned interface styling and is safe to declare statically. Site-specific blocking selectors belong in the conditional protection files so the toolbar pause remains authoritative.

The per-site pause also installs a higher-priority network exception for requests initiated by that site. Reload the page after changing a site exception so already loaded resources and frame state are rebuilt consistently.

## Coverage and intentional limits

AdLock targets display, native, sponsored, shopping, search, sticky, interstitial, background/skin, video companion, pre-roll integration, popup, redirect, notification-promotion, tracking-pixel, and cryptomining patterns. It also suppresses high-confidence anti-adblock overlays without pretending to solve every possible detector.

Some boundaries cannot be removed safely:

- Server-side ads stitched into the same media stream as the program cannot be separated by request blocking without breaking playback.
- First-party ads delivered from the same application endpoints as essential content require site-specific semantics; learning deliberately does not auto-block same-site hosts.
- Browser permission prompts, Safe Browsing warnings, authentication, payments, CAPTCHA, and other security challenges are never spoofed or hidden.
- Closed shadow roots and browser chrome cannot be inspected by an extension content script.
- A site can observe blocked requests or layout changes, so universal anti-adblock invisibility is not technically possible.
- Strict mode can break analytics-dependent, federated, or unusually implemented widgets. Pause the affected site or choose Balanced mode when needed.

Chromium limits the number of packaged, enabled, dynamic, session, and regular-expression DNR rules. AdLock deliberately emits compact category rules instead of one rule per hostname, stays below the guaranteed static budget, and treats quota or ruleset-update failures as health errors rather than silently claiming protection.

## Install or update in Edge and other Chromium browsers

1. Open `edge://extensions` in Edge or `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `ad block` folder, the folder containing `manifest.json`.
4. Pin **AdLock** and confirm the toolbar popup reports Strict protection.
5. If AdLock was already loaded, click **Reload** on its extension card. Then reload every open page you want to retest.

Source-file changes do not enter a running unpacked extension until its extension card is reloaded. If two AdLock copies are listed, disable the older copy so stale content scripts and rulesets do not overlap.

## Test and validate

Node.js 20 or newer is recommended. Install development dependencies once, then run the complete unit and package validation suite:

```powershell
npm install
npm test
```

Run the reproducible local performance harness separately:

```powershell
npm run benchmark
npm run benchmark:assert
npm run classification:verify
npm run critical:verify
```

The classification check loads the real extension in a disposable profile and verifies neutral links and diagnostic controls, real ad surfaces, late disclosure changes, open shadow roots, and pause restoration in Balanced and Strict modes.

The critical regression check verifies hostile HTML channel spoofing, native-function exposure, same-tab and named-frame navigation, ordinary form submission, and editorial preservation with real extension APIs. Run `npm run critical:verify -- --packaged` to check the staged release.

For live website comparisons with the extension actually loaded, run:

```powershell
npm run benchmark:live -- --runs=3
```

The Playwright CLI runner uses a disposable Chromium profile and compares disabled,
Balanced, and Strict protection on BBC, CNN, Wikipedia, MDN, Amazon search, and
the d3ward test page. It rotates mode order, clears cookies and HTTP cache before
each visit, scrolls once to exercise dynamic content, and saves JSON measurements,
CLI logs, and screenshots under `output/`. Use `--site=bbc,mdn` to select sites or
`--no-screenshots` to skip images. Playwright Chromium and Playwright CLI are
required; the runner can resolve an installed CLI, use `PLAYWRIGHT_CLI_PATH`, or
invoke it through `npx`.

Live results include page timings, total renderer task time, long tasks, transferred
bytes, request failures, DNR match checks, and hidden-element samples. Failed
navigations, HTTP errors, and detected access challenges remain in the raw report
and are excluded from timing medians. A client-blocked request corroborated by a
matching installed AdLock block rule is counted separately from transport errors;
the DNR replay is hypothetical rather than a historical debug event. Hidden
elements and third-party test scores are not independently labelled ad accuracy.
Three repetitions provide a small local sample, not a universal effectiveness or
speed score. Other site storage, consent, network conditions, and ad inventory can
still differ between visits.



Create the production upload package after validation:

```powershell
npm run release
```

This writes `dist/adlock-<version>.zip` with only the manifest's runtime
resources, `LICENSE`, and `PRIVACY.md`. The `release:check` command verifies
that every packaged resource exists without creating an archive. The CI
workflow runs the full unit, validation, performance, UI smoke, and packaging
gates and uploads the same ZIP as a build artifact.

After packaging, run `npm run release:verify` to load the staged release in a disposable Chromium profile and exercise real network configuration, settings restoration, diagnostics and the pause control. This requires Playwright's Chromium installation. Test profiles are kept under ignored `tmp/` and never use your everyday browser profile.

To check native toolbar sizing, run `npm run popup:verify -- --edge --packaged` with Node.js 22+ and Edge installed. This opens the real action popup and verifies repeated frame geometry, pause/resume, mode changes and live counter updates. Add `--scale=1.25` or `--scale=1.5` to verify display scaling. Without `--edge`, it uses Playwright Chromium. Screenshots are saved under `output/playwright/`.

Run `npm run popup:functionality:verify -- --packaged` to exercise the real toolbar against loaded extension APIs, including keyboard activation, saves, live counts, external settings, site restoration without losing input, and the Settings button. Add `--live` to include MDN, Wikipedia and BBC in the browser session and measure response timing with those tabs open, or `--edge` to run in installed Edge. Reports are saved under `output/benchmarks/`.

Opening `ui/popup.html` directly runs an interactive preview with sample counters and no ad blocking. Demo choices are stored separately in the page's local storage; Settings opens a preview dialog with reset and close controls. For actual protection, load the extension and use its toolbar popup. Run `npm run popup:preview:verify` to verify standalone preview clicks, dropdown selection, persistence and dialog behavior.

The release build also creates `dist/adlock-preview-2.1.8.html`. Open this single file in Chrome or Edge for a preview that includes its own scripts, styles and icons. Run `npm run popup:preview:verify -- --standalone --partial-chrome` after packaging to verify it without companion files and with partial preview-host Chrome APIs. A static file viewer that disables JavaScript cannot run interactive controls.

It measures the popup's in-document ready mark, visible toggle feedback, extension message count per toggle, 350-element classifier throughput, narrow/wide overflow, offscreen-panel configuration, and relevant unpacked payload sizes. A real-browser scanner fixture inserts 1500 elements, checks all 150 ads are hidden while 1350 editorial cards remain visible, updates a disclosure label after insertion, and verifies pause restoration. Scanner task timings have a 50-millisecond regression budget. Results are machine-dependent; these local checks do not establish performance or compatibility on every live website.

The validator checks Manifest V3 resources and parsing, globally unique DNR IDs, generated-artifact determinism, content-script ordering and frame coverage, version consistency, strict-only isolation, and icon dimensions.

For manual browser fixtures, serve the repository over HTTP:

```powershell
npx --yes http-server . -p 4173
```

Open `http://127.0.0.1:4173/demo/ad-fixtures.html` to verify page classification and `http://127.0.0.1:4173/demo/redirect-fixtures.html` to verify nested redirects, scripted popups, the exact-URL **Allow once** escape hatch, and safe-link false positives.

## Project layout

- `data/filter-data.json` - canonical reviewed filter categories and endpoint definitions
- `scripts/generate-filter-data.mjs` - deterministic filter artifact generator
- `background/service-worker.js` - settings transactions, ruleset health, per-site/custom/reputation rules, conditional CSS, statistics, and badge state
- `content/domain-data.js` - generated shared domain data
- `content/engine.js` - weighted classification and bounded recursive navigation analysis
- `content/content.js` - incremental DOM, frame, and open-shadow-root scanning
- `content/navigation-guard.js` - early main-world popup and navigation protection
- `content/privacy-guard.js` - advertising API, tracking transport, attribution, and strict fingerprint defenses
- `content/protection.css` and `content/strict.css` - conditional USER-origin cosmetic protection
- `rules/` - packaged declarative network rulesets
- `ui/` - toolbar popup and advanced options
- `tests/`, `demo/`, and `scripts/validate.mjs` - automated and manual verification

Technical references: [Chrome declarativeNetRequest](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest), [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts), and [Chrome scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting).

## License

MIT
