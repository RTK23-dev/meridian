import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MODEL_CLASSES } from "../contracts/plan.ts";
import { prices } from "./prices.ts";
import { CAPABILITIES, routes } from "./routes.ts";

describe("route table", () => {
  it("has a route for every capability", () => {
    assert.deepEqual(Object.keys(routes.table).sort(), [...CAPABILITIES].sort());
  });

  it("routes every model class first to the provider the estimate is priced on", () => {
    for (const modelClass of MODEL_CLASSES) {
      const first = routes.table[modelClass].targets[0];
      if (first === undefined) continue;
      assert.equal(first.priceKey, prices.routeFor[modelClass], modelClass);
    }
  });

  it("names a reason for every capability that has no model at all", () => {
    for (const capability of CAPABILITIES) {
      const route: { targets: ReadonlyArray<{ model: string | null }>; note?: string } = routes.table[capability];
      if (route.targets.every((target) => target.model === null)) assert.ok(route.note, capability);
    }
  });

  it("uses OpenRouter for every model API", () => {
    for (const capability of CAPABILITIES) {
      if (capability === "render.cloud" || capability === "media.functions") continue;
      for (const target of routes.table[capability].targets) assert.equal(target.provider, "openrouter", capability);
    }
  });

  it("marks no model as verified before a live check", () => {
    for (const capability of CAPABILITIES) {
      for (const target of routes.table[capability].targets) assert.equal(target.verified, false, capability);
    }
  });
});
