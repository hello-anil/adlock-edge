import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { parseBackup, selectorLines, MAX_IMPORT_BYTES } = require("../ui/settings-transfer.js");
const backup = (settings) => JSON.stringify({ version: 1, settings });

test("settings backup round-trip preserves booleans, domains and compound CSS", () => {
  const settings = { globalEnabled: false, level: "balanced", dynamicFiltering: true,
    disabledSites: ["example.org"], customBlockDomains: [], customSelectors: [":is(.ad, .promo)"] };
  const validated = [];
  assert.deepEqual(parseBackup(backup(settings), (selector) => validated.push(selector)), settings);
  assert.deepEqual(validated, settings.customSelectors);
});

test("backup import rejects invalid schemas and oversized input instead of applying defaults", () => {
  for (const input of ["{", "null", '{"version":2,"settings":{"level":"strict"}}',
    backup({ level: "extreme" }), backup({ globalEnabled: "false" }), backup({ disabledSites: ["https://site.example/path"] }),
    backup({ unexpected: true }), backup({}), backup({ customSelectors: Array(251).fill(".ad") }),
    " ".repeat(MAX_IMPORT_BYTES + 1)]) {
    assert.throws(() => parseBackup(input, () => {}));
  }
  assert.throws(() => parseBackup(backup({ customSelectors: ["["] }), () => { throw new Error("invalid"); }), /Invalid CSS selector/);
});

test("CSS parsing preserves commas inside functional selectors and quoted values", () => {
  assert.deepEqual(selectorLines(':is(.ad, .promo)\n[data-label="sale, today"]\n.ad, .sponsor\n:is(.ad, .promo)'),
    [':is(.ad, .promo)', '[data-label="sale, today"]', '.ad, .sponsor']);
});
