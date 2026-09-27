import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Worker routes APIs and health checks before SPA static asset fallback", async () => {
  const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  assert.equal(config.main, "./cloudflare/src/index.js");
  assert.deepEqual(config.assets.run_worker_first, ["/api/*", "/health"]);
  assert.equal(config.assets.not_found_handling, "single-page-application");
  assert.equal(config.ai.binding, "AI");
  assert.equal(config.d1_databases[0].binding, "DB");
});
