// The crew's compiler (L1, L5, L9, L11): a generated shot's provider prompt and negative prompt are compiled from its direction, never
// written freehand, and the sound cues are placed from the film's moments, cards and numbers. Nothing here calls a provider.

import type { DirectedFilm, ShotDirection } from "./film.ts";
import { phrase, type ProviderFamily } from "./motion-vocab.ts";

/** A rough colour name for a hex value: models follow "deep indigo" better than "#1C2256". */
export function colourName(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (l < 0.1) return "near-black";
  if (l > 0.93) return "white";
  if (s < 0.15) return l < 0.35 ? "dark grey" : l > 0.7 ? "light grey" : "grey";
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const hues: Array<[number, string]> = [
    [15, "red"], [40, "orange"], [65, "yellow"], [90, "lime"], [150, "green"], [180, "teal"], [205, "cyan"],
    [235, "blue"], [260, "indigo"], [290, "purple"], [330, "magenta"], [350, "pink"], [360, "red"],
  ];
  const hue = hues.find(([limit]) => h < limit)?.[1] ?? "red";
  const tone = l < 0.3 ? "deep " : l > 0.75 ? "pale " : s > 0.75 && l > 0.45 && l < 0.65 ? "neon " : "";
  return tone + hue;
}

const RENDER_WORDS: Record<DirectedFilm["look"]["rendering"], string> = {
  pixel_dither: "pixel art with ordered dithering, a limited palette, hard pixel edges",
  crisp_vector: "crisp flat vector animation, clean shapes, hard edges",
  flat_2d: "flat 2D cartoon animation",
  clay_3d: "soft clay 3D render",
  voxel: "voxel art, cubic blocks",
  painterly: "painterly 2D animation",
  photoreal: "photoreal footage",
};

const CAMERA_WORDS: Record<ShotDirection["composition"]["camera"], string> = {
  locked: "static locked-off camera",
  push: "a slow push in",
  pull: "a slow pull back",
  follow: "the camera follows the subject, keeping it fixed in frame",
  dive_in: "the camera dives in toward the subject, scale growing fast",
  dive_out: "the camera pulls out fast from close detail to the whole",
  crane: "the camera cranes up",
  pan: "a slow horizontal pan",
};

const BAND_WORDS = { top: "the top third", bottom: "the bottom third", centre: "the middle band" } as const;

export type CompiledPrompt = { prompt: string; negativePrompt: string; tested: boolean };

/** The provider prompt for one generated shot. Words a viewer reads are never asked for: the code draws every word (planner rule 3). */
export function compileShotPrompt(film: DirectedFilm, shot: ShotDirection, family: ProviderFamily): CompiledPrompt {
  const look = film.look;
  const seconds = (shot.endMs - shot.startMs) / 1000;
  const at = shot.oneMoment.hitAtMs / 1000;
  const values = { subject: shot.subject, what: shot.oneMoment.what, at };
  const palette = [look.palette.background, look.palette.hero, look.palette.accent, look.palette.glow].map(colourName);
  const parts = [
    `${RENDER_WORDS[look.rendering]}, ${look.edges} edges, ${look.lighting === "stylized_glow" ? "stylized glow lighting" : look.lighting + " lighting"}.`,
    `Palette: ${palette[0]} background, ${palette[1]} subject, ${palette[2]} accents, ${palette[3]} glow.`,
    `${shot.picture}.`,
    `${phrase("anticipation", family, values).text}, ${phrase("release", family, values).text}, ${phrase("settle", family, values).text}.`,
  ];
  if (shot.motionStyle.squashStretch) parts.push(`${phrase("squash_stretch", family, values).text}.`);
  if (shot.motionStyle.smears) parts.push(`${phrase("smears", family, values).text}.`);
  if (shot.motionStyle.cadence !== "ones") parts.push(`${phrase("on_twos", family, values).text}.`);
  parts.push(
    `${shot.composition.camera === "locked" ? phrase("locked_camera", family, values).text : CAMERA_WORDS[shot.composition.camera]}.`,
    `The subject fills about ${Math.round(shot.composition.subjectScale * 100)}% of the frame's height; ${BAND_WORDS[shot.composition.emptyBand]} stays empty.`,
  );
  if (shot.loop === "seamless") parts.push(`${phrase("seamless_loop", family, values).text}.`);
  parts.push(`${seconds.toFixed(1)} seconds. No text in frame.`);
  const negatives = [...new Set([...shot.avoid, ...film.avoidGlobal, "text", "letters", "captions", "logos", "watermark"])];
  return { prompt: parts.join(" "), negativePrompt: negatives.join(", "), tested: false };
}

/** The described prompt the reel's bottom half came from: the picture alone, as a person would type it (L12's control arm). */
export function describedPrompt(shot: ShotDirection): string {
  return `An animated ${shot.picture.charAt(0).toLowerCase()}${shot.picture.slice(1).replace(/\.$/, "")}.`;
}

export type SfxCue = { atMs: number; kind: string; from: "moment" | "card" | "tick" | "cta" };

/**
 * The sound cues of a film (L4, L11): the hit sound on every one moment, a blip on every line card, a pop on a speech bubble, ticks on a
 * counting readout (at most one every 90 ms, so a count of billions still ticks at a readable rate), and a chime on the call to action.
 * A cue within 60 ms of a moment's hit gives way to the hit.
 */
export function sfxCues(film: DirectedFilm): SfxCue[] {
  const cues: SfxCue[] = [];
  for (const shot of film.shots) {
    if (shot.sound.hitSfx !== "none") cues.push({ atMs: shot.startMs + shot.oneMoment.hitAtMs, kind: shot.sound.hitSfx, from: "moment" });
  }
  for (const card of film.cards) {
    if (card.kind === "line") cues.push({ atMs: card.atMs, kind: "blip", from: "card" });
    if (card.kind === "bubble") cues.push({ atMs: card.atMs, kind: "pop", from: "card" });
  }
  for (const hud of film.hud) {
    if (!hud.ticks) continue;
    const span = hud.untilMs - hud.fromMs;
    const units = Math.abs(hud.to - hud.from);
    const step = units > 0 ? Math.max(90, span / Math.min(units, span / 90)) : span;
    for (let t = hud.fromMs + step; t < hud.untilMs - 1; t += step) cues.push({ atMs: Math.round(t), kind: "tick", from: "tick" });
  }
  if (film.cta?.atMs != null) cues.push({ atMs: film.cta.atMs, kind: "chime", from: "cta" });
  const hits = cues.filter((cue) => cue.from === "moment").map((cue) => cue.atMs);
  return cues
    .filter((cue) => cue.from === "moment" || !hits.some((hit) => Math.abs(hit - cue.atMs) < 60))
    .sort((a, b) => a.atMs - b.atMs || a.kind.localeCompare(b.kind));
}
