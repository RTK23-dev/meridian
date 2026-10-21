import assert from "node:assert/strict";
import test from "node:test";
import { parseStepFromPath, stepPath } from "./step-url.ts";

test("stepPath joins a base and a step, and a trailing slash on the base does not double up", () => {
  assert.equal(stepPath("/create", "brief"), "/create/brief");
  assert.equal(stepPath("/create/", "brief"), "/create/brief");
  assert.equal(stepPath("/create/plan_1", "plan"), "/create/plan_1/plan");
});

test("parseStepFromPath returns the step under the base", () => {
  assert.equal(parseStepFromPath("/create/brief", "/create"), "brief");
  assert.equal(parseStepFromPath("/create/plan_1/review", "/create/plan_1"), "review");
  assert.equal(parseStepFromPath("/create/brief/", "/create"), "brief");
});

test("parseStepFromPath ignores the query string and the hash", () => {
  assert.equal(parseStepFromPath("/create/brief?from=home#top", "/create"), "brief");
});

test("parseStepFromPath returns null for anything that is not one step under the base", () => {
  assert.equal(parseStepFromPath("/create", "/create"), null);
  assert.equal(parseStepFromPath("/create/", "/create"), null);
  assert.equal(parseStepFromPath("/create/brief/extra", "/create"), null);
  assert.equal(parseStepFromPath("/create/plan_1/plan", "/create"), null);
  assert.equal(parseStepFromPath("/createx/brief", "/create"), null);
  assert.equal(parseStepFromPath("/content-factory", "/create"), null);
  assert.equal(parseStepFromPath("/create/Brief", "/create"), null);
});

test("a step survives a round trip through its path", () => {
  const path = stepPath("/create/plan_1", "plan");
  assert.equal(parseStepFromPath(path, "/create/plan_1"), "plan");
});
