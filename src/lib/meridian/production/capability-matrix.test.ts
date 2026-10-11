import assert from "node:assert/strict";
import test from "node:test";
import { selectOffer, type SelectionRequirement, type ProviderCost } from "./capability-matrix.ts";
import { configuredQuote, unknownQuote } from "./pricing.ts";
import { modelCapabilityRegistry } from "./registry.ts";

const perSecond = (id: string, amountUsd: number, zeroSpend = false): ProviderCost => ({
  id, zeroSpend, price: configuredQuote("per_second", amountUsd, `test declaration ${id}`),
});

const costs: Record<string, ProviderCost> = {
  google_omni: perSecond("google_omni", 0.15),
  hypit: perSecond("hypit", 0.05),
  higgsfield: perSecond("higgsfield", 0.15),
  manual_cloud: perSecond("manual_cloud", 0, true),
};

const PREFERENCE = ["google_omni", "hypit", "higgsfield", "manual_cloud"];

function candidates(modelIds: string[]) {
  return modelIds.map((modelId) => {
    const record = modelCapabilityRegistry.getModel(modelId);
    if (!record) throw new Error(`fixture: no registry record ${modelId}`);
    return { provider: costs[record.provider_id]!, record };
  });
}

const ALL = ["gemini-omni-1.1-flash", "higgsfield-video-v1", "hypit-hyperframes", "manual-cloud"];

// A deprecated preview model, registered only for this file, so the lifecycle rejection stays covered.
const DEPRECATED_FIXTURE = "fixture-deprecated-video";

function requirement(overrides: Partial<SelectionRequirement> = {}): SelectionRequirement {
  const durationSeconds = overrides.durationSeconds ?? 8;
  return { modality: "video", task: "text-to-video", aspectRatio: "9:16", ...overrides, durationSeconds, units: durationSeconds };
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
  modelCapabilityRegistry.register({
    model_id: DEPRECATED_FIXTURE,
    provider_id: "higgsfield",
    api_family: "interactions",
    release_channel: "preview",
    supported_modalities: ["text"],
    supported_tasks: ["text-to-video"],
    durations: [5, 8],
    aspect_ratios: ["9:16", "16:9"],
    resolutions: ["720p"],
    input_reference_types: [],
    native_audio: false,
    editing_support: false,
    region_constraints: ["global"],
    pricing_basis: "per_job",
    availability_state: "DEPRECATED",
    announced_shutdown_at: "2026-10-22T00:00:00Z",
    replacement_model_id: "gemini-omni-1.1-flash",
    last_verified_at: "2026-10-09",
    source_url: "https://example.test/deprecations",
  });
  const choice = selectOffer({ candidates: candidates([...ALL, DEPRECATED_FIXTURE]), requirement: requirement(), registry: modelCapabilityRegistry, mode: "PREFERENCE", preference: PREFERENCE });
  const fixture = choice.rejected.find((item) => item.modelId === DEPRECATED_FIXTURE);
  assert.ok(fixture?.reasons.some((reason) => reason.includes("DEPRECATED")), fixture?.reasons.join("; "));
});

test("when nothing satisfies the requirement, nothing is chosen and every rejection is recorded: no guessing", () => {
  const choice = selectOffer({ candidates: candidates(ALL), requirement: requirement({ durationSeconds: 45, aspectRatio: "4:5" }), registry: modelCapabilityRegistry, mode: "LOWEST_COST" });
  assert.equal(choice.chosen, null);
  assert.ok(choice.rejected.length >= 4, "each candidate's refusal is recorded");
});

test("a requirement whose task produces another modality is an error, not a choice of some model", () => {
  const inconsistent = { modality: "image", task: "text-to-video", durationSeconds: null, aspectRatio: "9:16", units: 1 } as SelectionRequirement;
  assert.throws(
    () => selectOffer({ candidates: candidates(ALL), requirement: inconsistent, registry: modelCapabilityRegistry, mode: "LOWEST_COST" }),
    /text-to-video produces video, not image/,
  );
});

test("a video requirement must bill its duration, and an image requirement has no duration to bill", () => {
  const billed = { ...requirement(), units: 5 };
  assert.throws(
    () => selectOffer({ candidates: candidates(ALL), requirement: billed, registry: modelCapabilityRegistry, mode: "LOWEST_COST" }),
    /units must equal durationSeconds/,
  );
  const withDuration = { modality: "image", task: "text-to-image", durationSeconds: 4, aspectRatio: "9:16", units: 1 } as SelectionRequirement;
  assert.throws(
    () => selectOffer({ candidates: candidates(ALL), requirement: withDuration, registry: modelCapabilityRegistry, mode: "LOWEST_COST" }),
    /an image requirement has no duration/,
  );
});

test("a known price is chosen before an allowed unknown price, because an unknown cost cannot be ranked", () => {
  const unpriced: ProviderCost = { id: "google_omni", zeroSpend: false, price: unknownQuote("per_second", "none declared") };
  const choice = selectOffer({
    candidates: [
      { provider: unpriced, record: modelCapabilityRegistry.getModel("gemini-omni-1.1-flash")! },
      { provider: costs.hypit!, record: modelCapabilityRegistry.getModel("hypit-hyperframes")! },
    ],
    requirement: requirement(), registry: modelCapabilityRegistry, mode: "LOWEST_COST", allowUnknownCost: true,
  });
  assert.equal(choice.chosen?.providerId, "hypit");
  assert.equal(choice.chosen?.costKnown, true);
});
