import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const bridge = require("../content/runtime-bridge.js");

test("runtime bridge forwards messages and storage reads in a valid context", async () => {
  const chromeApi = {
    runtime: { id: "test-extension", async sendMessage(message) { return { echoed: message.type }; } },
    storage: { local: { async get(key) { return { [key]: { enabled: true } }; } } }
  };
  assert.deepEqual(await bridge.sendMessage(chromeApi, { type: "ping" }), { echoed: "ping" });
  assert.deepEqual(await bridge.getLocal(chromeApi, "settings"), { settings: { enabled: true } });
});

test("runtime bridge absorbs synchronous context invalidation", async () => {
  let invalidations = 0;
  const chromeApi = {
    runtime: {
      id: "test-extension",
      sendMessage() { throw new Error("Extension context invalidated."); }
    }
  };
  const result = await bridge.sendMessage(chromeApi, { type: "ping" }, () => { invalidations += 1; });
  assert.equal(result, null);
  assert.equal(invalidations, 1);
});

test("runtime bridge absorbs rejected calls and unavailable contexts", async () => {
  let invalidations = 0;
  const rejectedApi = {
    runtime: { id: "test-extension", async sendMessage() { throw new Error("Extension context was invalidated"); } }
  };
  assert.equal(await bridge.sendMessage(rejectedApi, {}, () => { invalidations += 1; }), null);
  assert.equal(await bridge.getLocal({}, "settings", () => { invalidations += 1; }), null);
  assert.equal(invalidations, 2);
});
