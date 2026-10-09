import assert from "node:assert/strict";
import test from "node:test";
import {
  RegulatoryDisclosureGate,
  type PublicationAssetManifest,
} from "./disclosure-gate.ts";

test("RegulatoryDisclosureGate passes 100% authentic organic reels without AI tags", () => {
  const authenticManifest: PublicationAssetManifest = {
    reelId: "reel-ugc-01",
    hasSyntheticFacesOrVoices: false,
    hasGenerativeVideoShots: false,
    isSponsoredCampaign: false,
    hasVisualWatermarkLabel: false,
    c2paMetadataInjected: false,
    metaAiLabelDeclared: false,
    paidPartnershipTagConfigured: false,
  };

  const result = RegulatoryDisclosureGate.evaluate(authenticManifest);
  assert.equal(result.passed, true);
  assert.equal(result.violations.length, 0);
  assert.equal(result.requiresAiLabel, false);
});

test("RegulatoryDisclosureGate blocks synthetic media lacking EU AI Act / C2PA / Meta disclosures", () => {
  const undisclosedAiManifest: PublicationAssetManifest = {
    reelId: "reel-ai-01",
    hasSyntheticFacesOrVoices: true,
    hasGenerativeVideoShots: true,
    isSponsoredCampaign: false,
    hasVisualWatermarkLabel: false, // VIOLATION
    c2paMetadataInjected: false,     // VIOLATION
    metaAiLabelDeclared: false,      // VIOLATION
    paidPartnershipTagConfigured: false,
  };

  const result = RegulatoryDisclosureGate.evaluate(undisclosedAiManifest);
  assert.equal(result.passed, false);
  assert.equal(result.requiresAiLabel, true);
  assert.ok(result.violations.some((v) => v.includes("EU_AI_ACT_ART50_VIOLATION")));
  assert.ok(result.violations.some((v) => v.includes("C2PA_VIOLATION")));
  assert.ok(result.violations.some((v) => v.includes("PLATFORM_POLICY_VIOLATION")));
});

test("RegulatoryDisclosureGate passes properly disclosed synthetic video and sponsored tags", () => {
  const compliantAiManifest: PublicationAssetManifest = {
    reelId: "reel-ai-compliant-01",
    hasSyntheticFacesOrVoices: true,
    hasGenerativeVideoShots: true,
    isSponsoredCampaign: true,
    hasVisualWatermarkLabel: true,
    c2paMetadataInjected: true,
    metaAiLabelDeclared: true,
    paidPartnershipTagConfigured: true,
  };

  const result = RegulatoryDisclosureGate.evaluate(compliantAiManifest);
  assert.equal(result.passed, true);
  assert.equal(result.violations.length, 0);
  assert.equal(result.requiresAiLabel, true);
  assert.equal(result.requiresSponsorTag, true);
});
