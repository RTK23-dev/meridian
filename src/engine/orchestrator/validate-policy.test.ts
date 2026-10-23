import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadCatalog } from "./catalog.ts";
import { orchestratorPlanSchema } from "./contracts.ts";
import { validatePlan } from "./validate.ts";

const sample = JSON.parse(readFileSync(new URL("./fixtures/sample-plan.json", import.meta.url), "utf8"));
const recorded = loadCatalog(JSON.parse(readFileSync(new URL("./fixtures/openrouter-catalog-2026-10-20.json", import.meta.url), "utf8"))).byId;

/** The sample plan with its video step (shot_1) on the given model. */
function planWithVideo(id: string) {
  const copy = structuredClone(sample);
  const shot = copy.nodes.find((node: { id: string }) => node.id === "shot_1");
  shot.model = { provider: "openrouter", id };
  return orchestratorPlanSchema.parse(copy);
}

test("a plan that names a switched-off model is refused with the policy's reason, not as unlisted", () => {
  // The orchestrator's catalog has no switched-off entries (api.ts filters them), so Veo is absent and the policy names the reason.
  const withoutVeo = new Map([...recorded].filter(([id]) => !id.startsWith("google/veo")));
  const result = validatePlan(planWithVideo("google/veo-3.1-fast"), withoutVeo, { disabledFamilies: ["google/veo"] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reasons.join("\n"), /step shot_1: google\/veo-3\.1-fast is switched off by the workspace's model policy/);
});

test("a model that is simply not listed still says it is not in the live catalog", () => {
  const result = validatePlan(planWithVideo("vendor/not-listed-video"), recorded, { disabledFamilies: ["google/veo"] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reasons.join("\n"), /step shot_1: vendor\/not-listed-video is not in the live catalog/);
});

test("with the family switched on, the same model is not refused for the policy", () => {
  const result = validatePlan(planWithVideo("google/veo-3.1-fast"), recorded, { disabledFamilies: [] });
  if (!result.ok) assert.doesNotMatch(result.reasons.join("\n"), /switched off/);
});
