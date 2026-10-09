/**
 * EU AI Act Article 50 & Platform Disclosure Gate
 * 
 * Enforces mandatory regulatory and platform compliance:
 * 1. EU AI Act Article 50: Realistic synthetic media (AI faces, generated people)
 *    must carry machine-readable C2PA metadata and prominent visual disclosure.
 * 2. Meta/Instagram AI Label: Enforces is_ai_generated flag on upload payload.
 * 3. Commercial Disclosure: Requires paid partnership tags on sponsored reels.
 * 
 * Fails closed: Export or publishing is strictly blocked if required disclosures are missing.
 */

export interface PublicationAssetManifest {
  reelId: string;
  hasSyntheticFacesOrVoices: boolean;
  hasGenerativeVideoShots: boolean;
  isSponsoredCampaign: boolean;
  hasVisualWatermarkLabel: boolean;
  c2paMetadataInjected: boolean;
  metaAiLabelDeclared: boolean;
  paidPartnershipTagConfigured: boolean;
}

export interface DisclosureGateResult {
  passed: boolean;
  requiresAiLabel: boolean;
  requiresSponsorTag: boolean;
  violations: string[];
}

export class RegulatoryDisclosureGate {
  /**
   * Validates publication manifest against EU AI Act Article 50 and Instagram policy.
   */
  static evaluate(manifest: PublicationAssetManifest): DisclosureGateResult {
    const violations: string[] = [];
    const requiresAi = manifest.hasSyntheticFacesOrVoices || manifest.hasGenerativeVideoShots;
    const requiresSponsor = manifest.isSponsoredCampaign;

    // Check 1: EU AI Act Article 50 compliance
    if (requiresAi) {
      if (!manifest.hasVisualWatermarkLabel) {
        violations.push("EU_AI_ACT_ART50_VIOLATION: Realistic synthetic media lacks visible AI disclosure label/watermark.");
      }
      if (!manifest.c2paMetadataInjected) {
        violations.push("C2PA_VIOLATION: Missing cryptographic C2PA provenance manifest in exported MP4.");
      }
      if (!manifest.metaAiLabelDeclared) {
        violations.push("PLATFORM_POLICY_VIOLATION: Meta API publishing payload does not declare is_ai_generated: true.");
      }
    }

    // Check 2: Consumer advertising law compliance (no undisclosed commercial endorsements)
    if (requiresSponsor && !manifest.paidPartnershipTagConfigured) {
      violations.push("CONSUMER_PROTECTION_VIOLATION: Sponsored campaign lacks verified paid-partnership disclosure label.");
    }

    return {
      passed: violations.length === 0,
      requiresAiLabel: requiresAi,
      requiresSponsorTag: requiresSponsor,
      violations,
    };
  }
}
