import assert from "node:assert/strict";
import test from "node:test";
import { liveDecisionCatalog } from "./decision-catalog.ts";
import { openRouterSeam } from "./test-seam.ts";

function withEnv<T>(env: Record<string, string | undefined>, run: () => T): T {
  const before = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return run(); } finally { process.env = before; }
}

test("production always uses the live catalogue and the real transport, even if the testing switch is set by mistake", () => {
  const seam = withEnv({ NODE_ENV: "production", MERIDIAN_TESTING_RUNTIME: "true" }, openRouterSeam);
  assert.equal(seam.catalog, liveDecisionCatalog);
  assert.equal(seam.fetchImpl, undefined);
});

test("the testing runtime answers from the recorded catalogue and a recorded transport, with no network", async () => {
  const seam = withEnv({ NODE_ENV: "development", MERIDIAN_TESTING_RUNTIME: "true" }, openRouterSeam);
  assert.notEqual(seam.catalog, liveDecisionCatalog);
  const listing = await seam.catalog.read();
  assert.equal(listing.ok, true);
  const response = await seam.fetchImpl!("https://openrouter.ai/api/v1/decisions", {});
  assert.equal(response.status, 200);
});
