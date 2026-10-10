import assert from "node:assert/strict";
import test from "node:test";
import { selectOffer, type ProviderCost, type SelectionCandidate, type SelectionRequirement } from "./capability-matrix.ts";
import type { PriceQuote } from "./pricing.ts";
import { modelCapabilityRegistry } from "./registry.ts";

const perSecond = (amountUsd: number | null, status: PriceQuote["status"] = "configured"): PriceQuote => ({
  status, unit: "per_second", amountUsd, source: "test declaration", verifiedAt: null,
});
const perImage = (amountUsd: number | null, status: PriceQuote["status"] = "unknown"): PriceQuote => ({
  status, unit: "per_image", amountUsd, source: amountUsd === null ? "none" : "test declaration", verifiedAt: null,
});

const provider = (id: string, price: PriceQuote, zeroSpend = false): ProviderCost => ({ id, zeroSpend, price });

function candidate(modelId: string, costs: ProviderCost): SelectionCandidate {
  const record = modelCapabilityRegistry.getModel(modelId);
  if (!record) throw new Error(`fixture: no registry record ${modelId}`);
  return { provider: costs, record };
}

const video8 = (): SelectionRequirement => ({ modality: "video", task: "text-to-video", durationSeconds: 8, aspectRatio: "9:16", units: 8 });
const image = (overrides: Partial<SelectionRequirement> = {}): SelectionRequirement => ({
  modality: "image", task: "text-to-image", durationSeconds: null, aspectRatio: "9:16", units: 1, ...overrides,
});

test("an image is priced per image, and an unknown image price is recorded as unknown, never invented", () => {
  const choice = selectOffer({
    candidates: [candidate("gemini-nano-banana-2.1", provider("google_nano_banana", perImage(null)))],
    requirement: image(), registry: modelCapabilityRegistry, mode: "PREFERENCE", preference: ["google_nano_banana"], allowUnknownCost: true,
  });
  assert.equal(choice.chosen?.providerId, "google_nano_banana");
  assert.equal(choice.chosen?.costKnown, false);
  assert.equal(choice.chosen?.estimateUsd, null, "no estimate is invented for an unpriced image");
  assert.equal(choice.chosen?.costStatus, "unknown");
});

test("LOWEST_COST refuses an unknown-cost provider rather than ranking it as cheapest", () => {
  const choice = selectOffer({
    candidates: [candidate("gemini-nano-banana-2.1", provider("google_nano_banana", perImage(null)))],
    requirement: image(), registry: modelCapabilityRegistry, mode: "LOWEST_COST",
  });
  assert.equal(choice.chosen, null);
  assert.ok(choice.rejected.some((item) => item.reasons.some((reason) => reason.includes("cost unknown"))));
});

test("a stale price is distinguishable and is never ranked as if it were current", () => {
  const stale = selectOffer({
    candidates: [candidate("gemini-nano-banana-2.1", provider("google_nano_banana", perImage(0.04, "stale")))],
    requirement: image(), registry: modelCapabilityRegistry, mode: "LOWEST_COST",
  });
  assert.equal(stale.chosen, null, "a stale price cannot win lowest-cost selection");
  const allowed = selectOffer({
    candidates: [candidate("gemini-nano-banana-2.1", provider("google_nano_banana", perImage(0.04, "stale")))],
    requirement: image(), registry: modelCapabilityRegistry, mode: "PREFERENCE", preference: ["google_nano_banana"], allowUnknownCost: true,
  });
  assert.equal(allowed.chosen?.costStatus, "stale");
  assert.equal(allowed.chosen?.costKnown, false);
});

test("automatic PREFERENCE selection refuses an unknown-cost provider unless the policy allows unknown costs", () => {
  const refused = selectOffer({
    candidates: [candidate("gemini-nano-banana-2.1", provider("google_nano_banana", perImage(null)))],
    requirement: image(), registry: modelCapabilityRegistry, mode: "PREFERENCE", preference: ["google_nano_banana"],
  });
  assert.equal(refused.chosen, null);
  assert.ok(refused.rejected[0]!.reasons.some((reason) => reason.includes("allowUnknownCost")));
});

test("an explicitly selected unknown-cost provider still works and is recorded as unpriced", () => {
  const choice = selectOffer({
    candidates: [candidate("gemini-nano-banana-2.1", provider("google_nano_banana", perImage(null)))],
    requirement: image(), registry: modelCapabilityRegistry, mode: "PREFERENCE", preference: ["google_nano_banana"],
    allowUnknownCost: true, allowDeprecated: true, allowZeroSpend: true,
  });
  assert.equal(choice.chosen?.providerId, "google_nano_banana");
  assert.equal(choice.chosen?.costKnown, false);
});

test("a known price yields a known estimate and records its status", () => {
  const choice = selectOffer({
    candidates: [candidate("hypit-hyperframes", provider("hypit", perSecond(0.05)))],
    requirement: video8(), registry: modelCapabilityRegistry, mode: "LOWEST_COST",
  });
  assert.equal(choice.chosen?.costKnown, true);
  assert.equal(choice.chosen?.estimateUsd, 0.4);
  assert.equal(choice.chosen?.costStatus, "configured");
});

test("an image requirement is not refused for lacking a duration, which an image does not have", () => {
  const choice = selectOffer({
    candidates: [candidate("gemini-nano-banana-2.1", provider("google_nano_banana", perImage(null)))],
    requirement: image(), registry: modelCapabilityRegistry, mode: "PREFERENCE", preference: ["google_nano_banana"], allowUnknownCost: true,
  });
  assert.ok(choice.chosen, "an image is eligible without a duration");
});

test("a video-only model is refused for an image requirement by its task, not by a guessed modality", () => {
  const choice = selectOffer({
    candidates: [candidate("gemini-omni-1.1-flash", provider("google_omni", perSecond(0.15)))],
    requirement: image(), registry: modelCapabilityRegistry, mode: "PREFERENCE", preference: ["google_omni"], allowUnknownCost: true,
  });
  assert.equal(choice.chosen, null);
  assert.ok(choice.rejected[0]!.reasons.some((reason) => reason.includes("text-to-image")));
});

test("a zero-spend manual workflow stays out of automatic image selection, whatever the cost policy", () => {
  const choice = selectOffer({
    candidates: [candidate("manual-cloud", provider("manual_cloud", perSecond(0), true))],
    requirement: image(), registry: modelCapabilityRegistry, mode: "LOWEST_COST",
  });
  assert.equal(choice.chosen, null);
  assert.ok(choice.rejected[0]!.reasons.some((reason) => reason.includes("zero-spend")));
});
