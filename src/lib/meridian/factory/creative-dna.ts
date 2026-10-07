export const CREATIVE_DNA_VERSION = "meridian.creative-dna.v1" as const;

export const BEATS = ["hook", "problem", "reveal", "proof", "offer", "cta"] as const;
export type BeatRole = (typeof BEATS)[number];

export const FORMATS = ["ugc", "demo", "testimonial", "listicle", "skit", "unboxing", "other"] as const;
export type AdFormat = (typeof FORMATS)[number];

export type DnaField<T> = {
  value: T;
  confidence: number;
  source: { kind: "frame" | "second" | "transcript" | "audio" | "missing"; at?: number; ref?: string };
};

export type SceneDna = {
  index: number;
  startMs: number;
  endMs: number;
  shotType: DnaField<string>;
  presenter: DnaField<string>;
  productOnScreen: DnaField<boolean>;
  setting: DnaField<string>;
  motion: DnaField<string>;
  overlay: DnaField<string>;
};

export type CreativeDna = {
  schema: typeof CREATIVE_DNA_VERSION;
  adId: string;
  durationMs: number;
  scenes: SceneDna[];
  cutsPerSecond: number;
  hook: {
    type: DnaField<string>;
    text: DnaField<string>;
    visual: DnaField<string>;
  };
  beats: { role: BeatRole; startMs: number; endMs: number; confidence: number }[];
  format: DnaField<AdFormat>;
  angle: DnaField<string>;
  onScreenText: { text: string; startMs: number; role: string; confidence: number }[];
  voice: DnaField<string>;
  music: { energy: DnaField<string>; tempoBpm: DnaField<number | null> };
  embedding: number[] | null;
};

export function emptyCreativeDna(adId: string, durationMs = 0): CreativeDna {
  const missing = <T>(value: T): DnaField<T> => ({ value, confidence: 0, source: { kind: "missing" } });
  return {
    schema: CREATIVE_DNA_VERSION,
    adId,
    durationMs,
    scenes: [],
    cutsPerSecond: 0,
    hook: { type: missing(""), text: missing(""), visual: missing("") },
    beats: [],
    format: missing("other"),
    angle: missing(""),
    onScreenText: [],
    voice: missing(""),
    music: { energy: missing(""), tempoBpm: missing(null) },
    embedding: null,
  };
}

export function dnaFromTranscript(input: {
  adId: string;
  durationMs: number;
  transcript: string;
  hookType?: string;
  format?: AdFormat;
  angle?: string;
}): CreativeDna {
  const dna = emptyCreativeDna(input.adId, input.durationMs);
  const text = input.transcript.trim();
  if (!text) return dna;
  const seconds = Math.max(1, input.durationMs / 1000);
  const words = text.split(/\s+/).filter(Boolean);
  dna.hook.text = { value: words.slice(0, 12).join(" "), confidence: 0.4, source: { kind: "transcript", at: 0 } };
  dna.hook.type = { value: input.hookType?.trim() || "spoken", confidence: input.hookType ? 0.5 : 0.2, source: { kind: "transcript", at: 0 } };
  dna.format = { value: input.format ?? "other", confidence: input.format ? 0.55 : 0.2, source: { kind: "transcript" } };
  dna.angle = { value: input.angle?.trim() || "", confidence: input.angle ? 0.5 : 0, source: { kind: "transcript" } };
  dna.beats = [
    { role: "hook", startMs: 0, endMs: Math.min(input.durationMs, 3000), confidence: 0.45 },
    { role: "cta", startMs: Math.max(0, input.durationMs - 3000), endMs: input.durationMs, confidence: 0.3 },
  ];
  dna.cutsPerSecond = Math.round((1 / seconds) * 1000) / 1000;
  return dna;
}

export function decodeOk(dna: CreativeDna): boolean {
  return dna.adId.trim().length > 0 && dna.schema === CREATIVE_DNA_VERSION;
}
