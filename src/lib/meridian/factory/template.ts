import { BEATS, type AdFormat, type BeatRole, type CreativeDna } from "./creative-dna.ts";

export const STORYBOARD_VERSION = "meridian.storyboard.v1" as const;

export type StoryboardBeat = {
  role: BeatRole;
  startMs: number;
  endMs: number;
  shotType: string;
  textRole: string;
  voiceover: string;
};

export type StoryboardTemplate = {
  schema: typeof STORYBOARD_VERSION;
  sourceAdId: string;
  durationMs: number;
  format: AdFormat;
  musicMood: string;
  beats: StoryboardBeat[];
};

/** Abstract a winner into a storyboard. Footage, slogans, and look are dropped. */
export function templateFromDna(dna: CreativeDna): StoryboardTemplate {
  const beats: StoryboardBeat[] =
    dna.beats.length > 0
      ? dna.beats.map((beat) => ({
          role: beat.role,
          startMs: beat.startMs,
          endMs: beat.endMs,
          shotType: dna.scenes.find((scene) => scene.startMs <= beat.startMs && scene.endMs >= beat.startMs)?.shotType.value || "unknown",
          textRole: beat.role,
          voiceover: beat.role === "hook" ? "hook line in brand voice" : beat.role === "cta" ? "approved call to action" : `${beat.role} beat in brand voice`,
        }))
      : BEATS.map((role, index) => {
          const slice = Math.max(1, Math.floor(dna.durationMs / BEATS.length));
          return {
            role,
            startMs: index * slice,
            endMs: index === BEATS.length - 1 ? dna.durationMs : (index + 1) * slice,
            shotType: "unknown",
            textRole: role,
            voiceover: `${role} beat in brand voice`,
          };
        });
  return {
    schema: STORYBOARD_VERSION,
    sourceAdId: dna.adId,
    durationMs: dna.durationMs,
    format: dna.format.value,
    musicMood: dna.music.energy.value || "neutral",
    beats,
  };
}

export type VariantAxis = {
  hook: string;
  cta: string;
  presenter: string;
  lengthMs: number;
};

export function variantMatrix(input: {
  hooks: string[];
  ctas: string[];
  presenters: string[];
  lengthsMs: number[];
  max?: number;
}): VariantAxis[] {
  const max = Math.max(1, Math.min(20, input.max ?? 10));
  const variants: VariantAxis[] = [];
  for (const hook of input.hooks) {
    for (const cta of input.ctas) {
      for (const presenter of input.presenters) {
        for (const lengthMs of input.lengthsMs) {
          if (!hook.trim() || !cta.trim() || !presenter.trim() || lengthMs < 1000) continue;
          variants.push({ hook: hook.trim(), cta: cta.trim(), presenter: presenter.trim(), lengthMs });
          if (variants.length >= max) return variants;
        }
      }
    }
  }
  return variants;
}
