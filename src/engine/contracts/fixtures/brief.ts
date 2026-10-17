// A brief-only request (contract v8) and the script written from it. The request has no script: its script is the one write_script
// returns after analyze_reference. The written script here is the recorded shape of that answer, not a live write.

import type { Brief, ProductionRequest, ScriptBeat, WrittenScript } from "../index.ts";
import { FIXTURE_IDS as ID } from "./ids.ts";
import { BLENDER_FRONT_URI, WORKSPACE_ID } from "./chain.ts";

export const briefFixture: Brief = {
  text: "A 20-second reel that shows the blender as the fix for a cluttered counter: open on the mess, show the blender, prove the speed, end with a plain call to action.",
  sources: [{ label: "product sheet", text: "Four smoothies in under two minutes. Fits a standard kitchen counter." }],
  attachments: [{ uri: BLENDER_FRONT_URI, mediaType: "image/png", note: "front of the blender, for the product beat" }],
};

/** The brief-only request: no script, so no beats, and no visual requests (their beat ids do not exist before the script is written). */
export const productionRequestBriefFixture: ProductionRequest = {
  schema: "meridian.production_request/v1",
  requestId: ID.briefRequest,
  workspaceId: WORKSPACE_ID,
  format: {
    formatId: "fmt_fixture_rank",
    referenceVideo: "ig:reel/FIXTURE0001",
    keep: ["hook_mechanism", "pacing", "caption_style"],
    change: ["topic", "products"],
  },
  brief: briefFixture,
  visualRequests: [],
  product: { sku: "SKU-FIX-001", productKitId: "pk_fixture", claimIds: ["claim_fixture_1"] },
  page: {
    pageId: "page_fixture",
    styleKitId: "sk_fixture",
    personaId: "persona_fixture",
    voiceId: "voice_fixture",
    characterIds: ["char_fixture"],
  },
  constraints: { aspect: "9:16", maxMs: 30000, budgetUsd: 4, priority: "normal" },
  output: { master: true, variants: { hooks: 2, maxVariants: 4, budgetUsd: 1 } },
};

const writtenBeats: ScriptBeat[] = [
  { beatId: "b1", role: "hook", text: "Your counter is full again.", emphasis: ["full"] },
  { beatId: "b2", role: "setup", text: "Most mornings it is the same pile of gadgets." },
  { beatId: "b3", role: "item", text: "One blender can live on the counter and stay out of the way." },
  { beatId: "b4", role: "proof", text: "Four smoothies in under two minutes." },
  { beatId: "b5", role: "cta", text: "Comment BLEND for the link." },
];

export const writtenScriptFixture: WrittenScript = {
  schema: "meridian.written_script/v1",
  requestId: ID.briefRequest,
  language: "en",
  beats: writtenBeats,
  rationale:
    "The hook opens on the mess the viewer already has. The proof uses the source's figure and no other claim. The blender is the only product named.",
  basedOn: { videoDnaId: ID.dna, sourceLabels: ["product sheet"] },
};
