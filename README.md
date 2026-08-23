# AdLock

AdLock is a local-first Manifest V3 blocker for Chrome, Edge, Brave, and other Chromium browsers. It combines packaged network rules with an incremental page classifier, popup and redirect protection, dynamic local reputation, privacy API controls, fingerprint resistance, and conditional cosmetic filters. Filter data, settings, reputation evidence, and statistics remain on the device; the extension does not download remote code or send browsing data elsewhere.

Strict protection is the default for new installations. Existing installations keep their saved level and site exceptions.

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

To protect the host page's responsiveness, each classifier slice is capped at 350 elements and 6 milliseconds. Mutation records drive subsequent work; periodic maintenance only revisits tracked hidden surfaces instead of repeatedly walking the full document. Custom selectors use one fast-path match before resolving the exact matching rule.

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
```

Create the production upload package after validation:

```powershell
npm run release
```

This writes `dist/adlock-<version>.zip` with only the manifest's runtime
resources, `LICENSE`, and `PRIVACY.md`. The `release:check` command verifies
that every packaged resource exists without creating an archive. The CI
workflow runs the full unit, validation, performance, UI smoke, and packaging
gates and uploads the same ZIP as a build artifact.

It measures the popup's in-document ready mark, visible toggle feedback, extension message count per toggle, a 350-element classifier slice, narrow/wide overflow, offscreen-panel configuration, and relevant unpacked payload sizes. Results are machine-dependent, so compare runs on the same device; `benchmark:assert` enforces deliberately broad regression budgets rather than claiming universal field performance.

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
