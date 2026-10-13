/**
 * The licence kinds and the wording a person attests to. This file has no imports, so the Factory screen can show the wording the
 * server stores, without loading the gate or the database code (rights.ts).
 */
export const LICENCE_KINDS = ["music", "footage"] as const;
export type LicenceKind = (typeof LICENCE_KINDS)[number];

export function isLicenceKind(value: string): value is LicenceKind {
  return (LICENCE_KINDS as readonly string[]).includes(value);
}

/** The wording a person attests to, per kind. The server stores this text with the attestation. The client never sends its own wording. */
export const ATTESTATION_WORDING: Record<LicenceKind, string> = {
  music: "I hold a licence for the music in this creative that covers publishing it on the platforms this brand posts to.",
  footage: "I hold a licence for the footage in this creative that covers publishing it on the platforms this brand posts to.",
};

/** The label a licence kind carries on the screen. */
export const LICENCE_LABELS: Record<LicenceKind, string> = { music: "Music", footage: "Footage" };
