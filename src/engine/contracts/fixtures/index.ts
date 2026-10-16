// Valid fixtures for every top-level contract type, exported for other workstreams to test against.
// Import from here; the chain is mutually consistent (see chain.ts) and checked in schemas.test.ts.

import { contentHash, type ArtifactEnvelope, type IntakeRejection, type ProviderError, type ScenePlan } from "../index.ts";
import { FIXTURE_IDS } from "./ids.ts";
import { characterSheetFixture, personaFixture, productKitFixture, styleKitFixture, voiceKitFixture } from "./kits.ts";
import * as chain from "./chain.ts";

export { FIXTURE_IDS, fixtureId } from "./ids.ts";
export * from "./chain.ts";
export * from "./kits.ts";

export const intakeRejectionFixture: IntakeRejection = {
  requestId: "req_fixture_rejected",
  reasons: ["claim claim_fixture_9 is not approved for SKU-FIX-001"],
};

export const providerErrorFixture: ProviderError = {
  kind: "rate_limit",
  retryable: true,
  message: "HTTP 429: retry after 20 seconds",
};

export const scenePlanEnvelopeFixture: ArtifactEnvelope<ScenePlan> = {
  artifactId: FIXTURE_IDS.artPlan,
  type: "scene_plan",
  schema: "meridian.scene_plan/v1",
  workspaceId: chain.WORKSPACE_ID,
  requestId: FIXTURE_IDS.request,
  parentIds: [FIXTURE_IDS.artVoice, FIXTURE_IDS.artDna],
  contentHash: contentHash(chain.scenePlanFixture),
  createdAt: "2026-10-13T09:00:41.000Z",
  body: chain.scenePlanFixture,
};

/** Every fixture keyed by its name, so tests can loop over them. */
export const fixtures = {
  productionRequest: chain.productionRequestFixture,
  validatedRequest: chain.validatedRequestFixture,
  intakeRejection: intakeRejectionFixture,
  videoDna: chain.videoDnaFixture,
  voiceTrack: chain.voiceTrackFixture,
  scenePlan: chain.scenePlanFixture,
  scenePlanChain: chain.scenePlanChainFixture,
  assetSpec: chain.assetSpecFixture,
  assetSpecV6: chain.assetSpecV6Fixture,
  modelChoice: chain.modelChoiceFixture,
  modelCatalogEntry: chain.modelCatalogEntryFixture,
  take: chain.take1Fixture,
  takeVerdict: chain.takeVerdictFixture,
  edl: chain.edlFixture,
  gateResult: chain.gateResultFixture,
  reviewResult: chain.reviewResultFixture,
  composition: chain.compositionFixture,
  renderedVideo: chain.renderedVideoFixture,
  manifest: chain.manifestFixture,
  budgetReservation: chain.budgetReservationFixture,
  ledgerEntry: chain.ledgerRenderFixture,
  ledgerEntryEstimated: chain.ledgerSttFixture,
  ledgerEntryClaude: chain.ledgerClaudeFixture,
  ledgerEntryFrameReader: chain.ledgerFrameReaderFixture,
  decision: chain.editorDecisionFixture,
  providerError: providerErrorFixture,
  styleKit: styleKitFixture,
  persona: personaFixture,
  characterSheet: characterSheetFixture,
  productKit: productKitFixture,
  voiceKit: voiceKitFixture,
  artifactEnvelope: scenePlanEnvelopeFixture,
} as const;
