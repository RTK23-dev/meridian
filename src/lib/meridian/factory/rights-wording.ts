/**
 * The kinds of right a person records on a creative, and the wording each one is recorded under. This file has no imports, so the
 * Factory screen can show the wording the server stores, without loading the gate or the database code (rights.ts).
 */

/** The two licences a person attests for a creative. */
export const LICENCE_KINDS = ["music", "footage"] as const;
export type LicenceKind = (typeof LICENCE_KINDS)[number];

/** The AI-label confirmation. It is confirmed per variant, and recorded on each creative the variant made. */
export const AI_LABEL_KIND = "ai_label";

/** Every kind recorded in rights_attestations. */
export const RIGHTS_KINDS = [...LICENCE_KINDS, AI_LABEL_KIND] as const;
export type RightsKind = (typeof RIGHTS_KINDS)[number];

export function isLicenceKind(value: string): value is LicenceKind {
  return (LICENCE_KINDS as readonly string[]).includes(value);
}

export function isRightsKind(value: string): value is RightsKind {
  return (RIGHTS_KINDS as readonly string[]).includes(value);
}

/** The wording a person records, per kind. The server stores this text with the record. The client never sends its own wording. */
export const ATTESTATION_WORDING: Record<RightsKind, string> = {
  music: "I hold a licence for the music in this creative that covers publishing it on the platforms this brand posts to.",
  footage: "I hold a licence for the footage in this creative that covers publishing it on the platforms this brand posts to.",
  ai_label: "I confirm this creative is labelled as AI-generated wherever the platform requires it.",
};

/** The label a licence kind carries on the screen. */
export const LICENCE_LABELS: Record<LicenceKind, string> = { music: "Music", footage: "Footage" };
