// Model preferences per production model class (Bible 10.5 step 4, contract v7). Each list ranks OpenRouter model ids, best first.
//
// This table STARTS EMPTY, by owner decision (2026-10-16). For now the director picks each shot's model from the whole eligible
// catalog. The lists are filled later from the gold sets (Bible 12.4) and the scoring of Bible 10.2, one class at a time, and
// each change bumps `version`. An empty list means "no preference": it never means "use the route table's model".
//
// The production classes are the ones Bible 10.5 names: video (the three video classes), avatar, image and speech (tts). The
// lip-sync class is not a production class yet (its vendor is chosen in E2), so it has no row here.

import type { ModelClass } from "../contracts/plan.ts";

export const PREFERENCE_MODEL_CLASSES = [
  "video.cinematic",
  "video.budget",
  "video.i2v_pinned",
  "avatar",
  "image.keyframe",
  "image.edit",
  "tts",
] as const satisfies readonly ModelClass[];

export type PreferenceModelClass = (typeof PREFERENCE_MODEL_CLASSES)[number];

export const modelPreferences: {
  readonly version: "model-preferences@1";
  /** Ranked OpenRouter model ids per production class. Empty by owner decision: no preference is set yet. */
  readonly ranked: Readonly<Record<PreferenceModelClass, readonly string[]>>;
} = {
  version: "model-preferences@1",
  ranked: {
    "video.cinematic": [],
    "video.budget": [],
    "video.i2v_pinned": [],
    avatar: [],
    "image.keyframe": [],
    "image.edit": [],
    tts: [],
  },
};
