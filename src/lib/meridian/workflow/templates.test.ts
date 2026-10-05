import assert from "node:assert/strict";
import test from "node:test";
import { instantiateWorkflow, templateCoverage } from "./templates.ts";

test("a workflow keeps its stages when the variables change", () => {
  const first = instantiateWorkflow("ugc_demo", { host: "Ava", product: "Soap", hook: "Hands", cta: "Buy" });
  const second = instantiateWorkflow("ugc_demo", { host: "Noah", product: "Lotion", hook: "Dry skin", cta: "Try" });
  assert.deepEqual(first.stages, second.stages);
  assert.notEqual(first.variables.host, second.variables.host);
  assert.equal(first.templateId, second.templateId);
  assert.ok(templateCoverage(first) > 0);
  assert.ok(templateCoverage(first) < 1);
});
