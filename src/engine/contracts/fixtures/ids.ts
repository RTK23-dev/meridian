// Fixture ids: valid prefixed ULIDs built from fixed inputs, so every run and every workstream sees the same ids.

import { encodeUlid, type IdPrefix } from "../ids.ts";

const FIXTURE_EPOCH_MS = Date.UTC(2026, 9, 13, 9, 0, 0);

/** A stable id for fixture entity n. Ids with larger n are later in time. */
export function fixtureId(prefix: IdPrefix, n: number): string {
  return prefix + encodeUlid(FIXTURE_EPOCH_MS + n * 1000, BigInt(n) * 1000003n);
}

export const FIXTURE_IDS = {
  request: fixtureId("req_", 1),
  dna: fixtureId("dna_", 2),
  edl: fixtureId("edl_", 3),
  composition: fixtureId("cmp_", 4),
  video: fixtureId("vid_", 5),
  reservation: fixtureId("res_", 6),
  asset: fixtureId("asp_", 7),
  ledgerRender: fixtureId("led_", 8),
  ledgerStt: fixtureId("led_", 9),
  ledgerShot3: fixtureId("led_", 10),
  shot1: fixtureId("shot_", 11),
  shot2: fixtureId("shot_", 12),
  shot3: fixtureId("shot_", 13),
  shot4: fixtureId("shot_", 14),
  shot5: fixtureId("shot_", 15),
  take1: fixtureId("take_", 21),
  take2: fixtureId("take_", 22),
  take3a: fixtureId("take_", 23),
  take3b: fixtureId("take_", 24),
  artVoice: fixtureId("art_", 31),
  artDna: fixtureId("art_", 32),
  artPlan: fixtureId("art_", 33),
} as const;
