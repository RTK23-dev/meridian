import assert from "node:assert/strict";
import test from "node:test";
import { selectOffer, type SelectionRequirement, type ProviderCost } from "./capability-matrix.ts";
import { modelCapabilityRegistry } from "./registry.ts";

const costs: Record<string, ProviderCost> = {
  google_omni: { id: "google_omni", costPerSecondEstimateUsd: 0.15, zeroSpend: false },
  hypit: { id: "hypit", costPerSecondEstimateUsd: 0.05, zeroSpend: false },
  higgsfield: { id: "higgsfield", costPerSecondEstimateUsd: 0.15, zeroSpend: false },
  veo: { id: "veo", costPerSecondEstimateUsd: 0.2, zeroSpend: false },
  manual_cloud: { id: "manual_cloud", costPerSecondEstimateUsd: 0, zeroSpend: true },
};

const PREFERENCE = ["google_omni", "hypit", "higgsfield", "manual_cloud", "veo"];

function candidates(modelIds: string[]) {
  return modelIds.map((modelId) => {
    const record = modelCapabilityRegistry.getModel(modelId);
    if (!record) throw new Error(`fixture: no registry record ${modelId}`);
    return { provider: costs[record.provider_id]!, record };
  });
}

const ALL = ["gemini-omni-1.1-flash", "higgsfield-video-v1", "hypit-hyperframes", "veo-3.1-generate-preview", "manual-cloud"];

function requirement(overrides: Partial<SelectionRequirement> = {}): SelectionRequirement {
  return { task: "text-to-video", durationSeconds: 8, aspectRatio: "9:16", ...overrides };
}

test("the cheapest eligible provider wins under LOWEST_COST, and the estimate is duration times the provider's cost", () => {
  const choice = selectOffer({ candidates: candidates(ALL), requirement: requirement(), registry: modelCapabilityRegistry, mode: "LOWEST_COST" });
  assert.equal(choice.chosen?.providerId, "hypit");
  assert.equal(choice.chosen?.estimateUsd, 0.4);
});

test("higgsfield is rejected for an 8 second video because it offers only 5, 10 and 15 seconds, and the rejection says why", () => {
  const choice = selectOffer({ candidates: candidates(ALL), requirement: requirement(), registry: modelCapabilityRegistry, mode: "LOWEST_COST" });
  const higgsfield = choice.rejected.find((item) => item.modelId === "higgsfield-video-v1");
  assert.ok(higgsfield, "higgsfield is recorded as rejected");
  assert.ok(higgsfield.reasons.some((reason) => reason.includes("8s")), higgsfield.reasons.join("; "));
});

test("PREFERENCE keeps the preferred eligible provider: google_omni for an 8 second 9:16 video", () => {
  const choice = selectOffer({ candidates: candidates(ALL), requirement: requirement(), registry: modelCapabilityRegistry, mode: "PREFERENCE", preference: PREFERENCE });
  assert.equal(choice.chosen?.providerId, "google_omni");
});

test("a 4:5 video is never sent to a provider that does not offer 4:5, even when it is preferred", () => {
  const choice = selectOffer({ candidates: candidates(ALL), requirement: requirement({ aspectRatio: "4:5" }), registry: modelCapabilityRegistry, mode: "PREFERENCE", preference: PREFERENCE });
  assert.equal(choice.chosen?.providerId, "hypit", "the first provider that offers 4:5");
  const omni = choice.rejected.find((item) => item.modelId === "gemini-omni-1.1-flash");
  assert.ok(omni?.reasons.some((reason) => reason.includes("4:5")), omni?.reasons.join("; "));
});

test("a zero-spend manual workflow is never selected for automatic generation, even though it costs nothing", () => {
  const choice = selectOffer({ candidates: candidates(ALL), requirement: requirement(), registry: modelCapabilityRegistry, mode: "LOWEST_COST" });
  assert.notEqual(choice.chosen?.providerId, "manual_cloud");
  const manual = choice.rejected.find((item) => item.providerId === "manual_cloud");
  assert.ok(manual?.reasons.some((reason) => reason.includes("zero-spend")), manual?.reasons.join("; "));
});

test("a deprecated model is rejected with its lifecycle state", () => {
  const choice = selectOffer({ candidates: candidates(ALL), requirement: requirement(), registry: modelCapabilityRegistry, mode: "PREFERENCE", preference: PREFERENCE });
  const veo = choice.rejected.find((item) => item.modelId === "veo-3.1-generate-preview");
  assert.ok(veo?.reasons.some((reason) => reason.includes("DEPRECATED")), veo?.reasons.join("; "));
});

test("when nothing satisfies the requirement, nothing is chosen and every rejection is recorded: no guessing", () => {
  const choice = selectOffer({ candidates: candidates(ALL), requirement: requirement({ durationSeconds: 45, aspectRatio: "4:5" }), registry: modelCapabilityRegistry, mode: "LOWEST_COST" });
  assert.equal(choice.chosen, null);
  assert.ok(choice.rejected.length >= 4, "each candidate's refusal is recorded");
});
