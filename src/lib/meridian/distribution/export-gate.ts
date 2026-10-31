// The disclosure check for an export package, in plain terms. A creative Meridian made is treated as AI-generated media, because the
// product does not record whether its footage is real. So it needs the AI label, the C2PA provenance record and the platform's AI
// flag, and none of those is produced yet. The check fails closed, and each reason is written out in words a person can act on.
// The legal wording and the list of what counts as real footage are the owner's decisions (Bible 20.2).

import { RegulatoryDisclosureGate, type DisclosureGateResult, type PublicationAssetManifest } from "../gates/disclosure-gate.ts";

/** The manifest for one creative. Nothing is recorded yet that says the footage is real, so the creative is treated as generated. */
export function manifestForCreative(creativeId: string): PublicationAssetManifest {
  return {
    reelId: creativeId,
    hasSyntheticFacesOrVoices: true,
    hasGenerativeVideoShots: true,
    isSponsoredCampaign: false,
    hasVisualWatermarkLabel: false,
    c2paMetadataInjected: false,
    metaAiLabelDeclared: false,
    paidPartnershipTagConfigured: false,
  };
}

/** The gate's result for one creative. */
export function gateForCreative(creativeId: string): DisclosureGateResult {
  return RegulatoryDisclosureGate.evaluate(manifestForCreative(creativeId));
}

/** The gate's violation codes, each written as a sentence someone can act on. An unknown code is shown as it is, never dropped. */
const PLAIN: Record<string, string> = {
  EU_AI_ACT_ART50_VIOLATION: "The video has no visible AI label. Meridian cannot add one yet.",
  C2PA_VIOLATION: "The video has no C2PA provenance record. Meridian cannot write one yet. It needs a signing library, which is a new dependency.",
  PLATFORM_POLICY_VIOLATION: "The Meta upload does not say the video is AI-generated. Meridian does not send that flag yet.",
  CONSUMER_PROTECTION_VIOLATION: "The campaign is sponsored, and no paid-partnership label is set.",
};

/** The reasons the export is blocked, in plain words. Empty when the check passed. */
export function plainReasons(result: DisclosureGateResult): string[] {
  return result.violations.map((violation) => {
    const code = violation.split(":")[0] ?? violation;
    return PLAIN[code] ?? violation;
  });
}
