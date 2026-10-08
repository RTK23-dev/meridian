export const CREATIVE_DNA_V1 = "meridian.creative-dna.v1" as const;
export const CREATIVE_DNA_V2 = "meridian.creative-dna.v2" as const;
export const CREATIVE_DNA_VERSION = CREATIVE_DNA_V2;

export type CreativeDnaSchema = typeof CREATIVE_DNA_V1 | typeof CREATIVE_DNA_V2;

export const BEATS = ["hook", "problem", "reveal", "proof", "offer", "cta"] as const;
export type BeatRole = (typeof BEATS)[number];

export type SegmentRole =
  | BeatRole
  | "opening"
  | "demonstration"
  | "reaction"
  | "vignette"
  | "payoff"
  | "closing"
  | "narrative"
  | "commentary"
  | "testimonial"
  | "comparison"
  | "other";

export type CreativeSegment = {
  id?: string;
  index: number;
  role: SegmentRole;
  startMs: number;
  endMs: number;
  confidence: number;
  description?: string;
  evidenceRef?: string;
};

export type CreativeStructureKind =
  | "organic_short"
  | "ad_narrative"
  | "pov"
  | "skit"
  | "storytime"
  | "listicle"
  | "tutorial"
  | "reaction"
  | "trend_audio"
  | "transformation"
  | "review"
  | "comparison"
  | "loop"
  | "unstructured";

export type CreativeStructureSegment = {
  index: number;
  startMs: number;
  endMs: number;
  role?: string;
  visualFunction?: string;
  dialogueFunction?: string;
  transition?: string;
  evidenceRefs?: string[];
  description?: string;
};

export type CreativeStructurePacing = {
  cutsPerMinute?: number;
  medianShotMs?: number;
  openingShotMs?: number;
  loopType?: string;
};

export type CreativeStructure = {
  kind: CreativeStructureKind;
  confidence?: number;
  durationMs?: number;
  segments: CreativeStructureSegment[];
  pacing?: CreativeStructurePacing;
  primaryAngle?: string;
  format?: string;
  structureType?: "dynamic" | "ad_narrative" | "organic_short" | "unstructured";
};

export type SegmentRef = {
  index: number;
  startMs: number;
  endMs: number;
  description?: string;
};

export type AdNarrative = {
  hook?: SegmentRef;
  problem?: SegmentRef;
  reveal?: SegmentRef;
  proof?: SegmentRef;
  offer?: SegmentRef;
  cta?: SegmentRef;
};

export function deriveAdNarrative(structure: CreativeStructure): AdNarrative | null {
  const narrative: AdNarrative = {};
  for (const seg of structure.segments) {
    if (seg.role === "hook" && !narrative.hook) {
      narrative.hook = { index: seg.index, startMs: seg.startMs, endMs: seg.endMs, description: seg.description };
    } else if (seg.role === "problem" && !narrative.problem) {
      narrative.problem = { index: seg.index, startMs: seg.startMs, endMs: seg.endMs, description: seg.description };
    } else if (seg.role === "reveal" && !narrative.reveal) {
      narrative.reveal = { index: seg.index, startMs: seg.startMs, endMs: seg.endMs, description: seg.description };
    } else if (seg.role === "proof" && !narrative.proof) {
      narrative.proof = { index: seg.index, startMs: seg.startMs, endMs: seg.endMs, description: seg.description };
    } else if (seg.role === "offer" && !narrative.offer) {
      narrative.offer = { index: seg.index, startMs: seg.startMs, endMs: seg.endMs, description: seg.description };
    } else if (seg.role === "cta" && !narrative.cta) {
      narrative.cta = { index: seg.index, startMs: seg.startMs, endMs: seg.endMs, description: seg.description };
    }
  }
  return Object.keys(narrative).length > 0 ? narrative : null;
}

export const FORMATS = ["ugc", "demo", "testimonial", "listicle", "skit", "unboxing", "other"] as const;
export type AdFormat = (typeof FORMATS)[number];

export type DnaFieldSource = {
  kind: "frame" | "second" | "transcript" | "audio" | "missing";
  at?: number;
  ref?: string;
};

export type DnaField<T> = {
  value: T;
  confidence: number;
  source: DnaFieldSource;
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
  transcript?: string;
  keyframeRef?: string;
};

export type OnScreenTextItem = {
  text: string;
  startMs: number;
  role: "hook_line" | "benefit" | "price" | "cta" | "other" | string;
  confidence: number;
  source?: DnaFieldSource;
};

export type CreativeDna = {
  schema: CreativeDnaSchema;
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
  structure?: CreativeStructure;
  format: DnaField<AdFormat>;
  angle: DnaField<string>;
  onScreenText: OnScreenTextItem[];
  voice: DnaField<string>;
  music: { energy: DnaField<string>; tempoBpm: DnaField<number | null> };
  embedding: number[] | null;
};

export function missingField<T>(value: T): DnaField<T> {
  return { value, confidence: 0, source: { kind: "missing" } };
}

export function dnaField<T>(
  value: T,
  confidence: number,
  source: DnaFieldSource,
): DnaField<T> {
  return { value, confidence, source };
}

export function emptyCreativeDna(
  adId: string,
  durationMs = 0,
  schema: CreativeDnaSchema = CREATIVE_DNA_V2,
): CreativeDna {
  return {
    schema,
    adId,
    durationMs,
    scenes: [],
    cutsPerSecond: 0,
    hook: {
      type: missingField(""),
      text: missingField(""),
      visual: missingField(""),
    },
    beats: [],
    format: missingField("other"),
    angle: missingField(""),
    onScreenText: [],
    voice: missingField(""),
    music: { energy: missingField(""), tempoBpm: missingField(null) },
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
  schema?: CreativeDnaSchema;
}): CreativeDna {
  const schema = input.schema ?? CREATIVE_DNA_V1;
  const dna = emptyCreativeDna(input.adId, input.durationMs, schema);
  const text = input.transcript.trim();
  if (!text) return dna;
  const seconds = Math.max(1, input.durationMs / 1000);
  const words = text.split(/\s+/).filter(Boolean);
  dna.hook.text = {
    value: words.slice(0, 12).join(" "),
    confidence: 0.4,
    source: { kind: "transcript", at: 0 },
  };
  dna.hook.type = {
    value: input.hookType?.trim() || "spoken",
    confidence: input.hookType ? 0.5 : 0.2,
    source: { kind: "transcript", at: 0 },
  };
  dna.format = {
    value: input.format ?? "other",
    confidence: input.format ? 0.55 : 0.2,
    source: { kind: "transcript" },
  };
  dna.angle = {
    value: input.angle?.trim() || "",
    confidence: input.angle ? 0.5 : 0,
    source: { kind: "transcript" },
  };
  dna.beats = [
    {
      role: "hook",
      startMs: 0,
      endMs: Math.min(input.durationMs, 3000),
      confidence: 0.45,
    },
    {
      role: "cta",
      startMs: Math.max(0, input.durationMs - 3000),
      endMs: input.durationMs,
      confidence: 0.3,
    },
  ];
  dna.cutsPerSecond = Math.round((1 / seconds) * 1000) / 1000;
  return dna;
}

export function decodeOk(dna: CreativeDna): boolean {
  return (
    dna.adId.trim().length > 0 &&
    (dna.schema === CREATIVE_DNA_V1 || dna.schema === CREATIVE_DNA_V2)
  );
}
