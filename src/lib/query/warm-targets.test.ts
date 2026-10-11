import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWarmPath, warmSpecs, type WarmSpec } from "./warm-targets.ts";

const signedIn = { signedIn: true, organizationId: "org-1" };
const queriesOf = (specs: WarmSpec[]) => specs.map((spec) => `${spec.scope}:${spec.id}:${spec.query}`);

test("nothing is warmed for a signed-out user, on any path", () => {
  assert.deepEqual(warmSpecs("/brands/brand-1/studio", { signedIn: false, organizationId: "org-1" }), []);
  assert.deepEqual(warmSpecs("/integrations", { signedIn: false, organizationId: "org-1" }), []);
});

test("the create-brand page is not a brand, so it warms nothing", () => {
  assert.deepEqual(warmSpecs("/brands/new", signedIn), []);
  assert.deepEqual(warmSpecs("/brands/new/", signedIn), []);
});

test("the brand overview warms the brand and its machine summary", () => {
  assert.deepEqual(queriesOf(warmSpecs("/brands/brand-1", signedIn)), ["brand:brand-1:brand", "brand:brand-1:machine"]);
});

test("each brand screen warms the queries its screen reads", () => {
  assert.deepEqual(queriesOf(warmSpecs("/brands/b/learning", signedIn)), ["brand:b:learning", "brand:b:telemetry"]);
  assert.deepEqual(queriesOf(warmSpecs("/brands/b/brain", signedIn)), ["brand:b:brand", "brand:b:assets"]);
  assert.deepEqual(queriesOf(warmSpecs("/brands/b/studio", signedIn)), ["brand:b:studio"]);
  assert.deepEqual(queriesOf(warmSpecs("/brands/b/factory", signedIn)), ["brand:b:factory"]);
  assert.deepEqual(warmSpecs("/brands/b/audit-unknown", signedIn), [], "a brand path with no entry warms nothing");
});

test("a trailing slash, a query string or a hash warms the same screen", () => {
  assert.deepEqual(warmSpecs("/brands/b/studio/", signedIn), warmSpecs("/brands/b/studio", signedIn));
  assert.deepEqual(warmSpecs("/brands/b/studio?tab=review", signedIn), warmSpecs("/brands/b/studio", signedIn));
  assert.deepEqual(warmSpecs("/integrations#providers", signedIn), warmSpecs("/integrations", signedIn));
  assert.equal(normalizeWarmPath("/"), "/");
  assert.equal(normalizeWarmPath("//"), "/");
});

test("workspace screens warm against the active organization", () => {
  assert.deepEqual(queriesOf(warmSpecs("/integrations", signedIn)), ["organization:org-1:integrations"]);
  assert.deepEqual(queriesOf(warmSpecs("/jobs", signedIn)), ["organization:org-1:jobs"]);
  assert.deepEqual(queriesOf(warmSpecs("/usage", signedIn)), ["organization:org-1:usage"]);
  assert.deepEqual(queriesOf(warmSpecs("/alerts", signedIn)), ["organization:org-1:alerts"]);
  assert.deepEqual(queriesOf(warmSpecs("/notifications/", signedIn)), ["organization:org-1:notifications"]);
  assert.deepEqual(queriesOf(warmSpecs("/settings", signedIn)), ["organization:org-1:providerSettings"]);
});

test("workspace screens warm nothing without an active organization, and audit and webhooks are never warmed", () => {
  assert.deepEqual(warmSpecs("/integrations", { signedIn: true, organizationId: null }), []);
  assert.deepEqual(warmSpecs("/audit", signedIn), []);
  assert.deepEqual(warmSpecs("/webhooks", signedIn), []);
});

test("a prototype property name in a path is not treated as a screen", () => {
  assert.deepEqual(warmSpecs("/brands/b/constructor", signedIn), []);
  assert.deepEqual(warmSpecs("/__proto__", signedIn), []);
  assert.deepEqual(warmSpecs("/toString", signedIn), []);
});
