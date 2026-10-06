import { hasWord } from "../domain.ts";
import {
  PRIOR_JUDGMENT,
  QUESTION_SPECS,
  judgeFeatures,
  type AuditedDecision,
  type Feature,
} from "../jev/judgment.ts";
import type { DecisionState } from "../jev/engine.ts";

/** Facts already stored on the brand, the creative, and the asset. Not test flags. */
export type MediaFacts = {
  kind: "image" | "video";
  positioning: string;
  tone: string;
  prohibited: string;
  wordsToAvoid: string;
  productName: string;
  angle: string;
  copy: string;
  prompt: string;
  competitorTexts: string[];
  ownTexts: string[];
  mime: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  checksum: string;
  durationMs: number | null;
  transcript: string;
  sceneCount: number;
  logoSimilarity: number | null;
  paletteDistance: number | null;
  /** local:semantic cosine. Null means the model did not return a vector. Not a token-overlap score. */
  semanticSimilarity: number | null;
};

const IMAGE_QUESTIONS = [
  "brand_fit",
  "opportunity_quality",
  "competitor_copy_risk",
  "claim_safety",
  "logo_match",
  "palette_match",
  "product_match",
  "tone_fit",
  "novelty",
  "duplicate_risk",
  "image_readiness",
  "publishing_readiness",
] as const;

const VIDEO_QUESTIONS = [
  "brand_fit",
  "opportunity_quality",
  "competitor_copy_risk",
  "claim_safety",
  "logo_match",
  "palette_match",
  "product_match",
  "tone_fit",
  "novelty",
  "duplicate_risk",
  "video_readiness",
  "publishing_readiness",
] as const;

function feat(name: string, value: number, id: string, source: string, summary: string): Feature {
  return { name, value, evidenceId: id, source, summary };
}

/** Long shared wording. This is an exact copy check, not a semantic embedding. */
export function sharedPhrase(copy: string, others: string[]): string {
  const hay = copy.toLowerCase();
  let best = "";
  for (const other of others) {
    const words = other.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2);
    for (let start = 0; start < words.length; start += 1) {
      for (let end = start + 4; end <= Math.min(words.length, start + 10); end += 1) {
        const phrase = words.slice(start, end).join(" ");
        if (phrase.length >= 18 && hay.includes(phrase) && phrase.length > best.length) best = phrase;
      }
    }
  }
  return best;
}

function overlap(angle: string, text: string): number {
  const tokens = angle.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4);
  if (tokens.length === 0 || text.trim().length < 12) return 0;
  const hits = tokens.filter((token) => hasWord(text, token)).length;
  return hits / tokens.length;
}

function build(id: string, facts: MediaFacts): { present: boolean; features: Feature[] } {
  const text = `${facts.copy}\n${facts.prompt}\n${facts.transcript}`;
  if (id === "brand_fit") {
    const score = overlap(facts.angle, facts.positioning);
    return {
      present: facts.positioning.trim().length >= 12,
      features: [
        feat("aligned", score, "positioning", "brand_brain", `Angle tokens overlap the stored positioning at ${score.toFixed(2)}.`),
        feat("coverage", facts.positioning.trim().length >= 40 ? 0.8 : 0.3, "positioning", "brand_brain", "Positioning length is taken from the brand brain, not a score the model chose."),
      ],
    };
  }
  if (id === "opportunity_quality") {
    const present = facts.angle.trim().length >= 2;
    return {
      present,
      features: [feat("coverage", present ? 0.7 : 0, "angle", "opportunity", `The variant is tied to angle ${facts.angle || "missing"}.`)],
    };
  }
  if (id === "competitor_copy_risk") {
    const phrase = sharedPhrase(text, facts.competitorTexts);
    const semantic = facts.semanticSimilarity;
    const features = [
      feat("aligned", phrase ? 0 : 1, "competitor-copy", "creative_records", phrase ? "A competitor phrase is present, so alignment is 0." : "No stored competitor phrase of four or more words appears in this variant."),
      feat("violation", phrase ? 1 : 0, "competitor-copy", "creative_records", phrase ? `The variant repeats stored competitor wording: “${phrase}”.` : "Exact-copy check found no shared phrase."),
    ];
    if (semantic == null) {
      features.push(feat("missing", 1, "semantic-copy", "local:semantic", "No local:semantic vector was returned for this comparison. Exact phrase was still checked. Token overlap was not stored as a semantic score."));
    } else if (semantic >= 0.92) {
      features.push(feat("violation", 1, "semantic-copy", "local:semantic", `local:semantic cosine to the nearest stored competitor text is ${semantic.toFixed(2)}.`));
    } else {
      features.push(feat("coverage", semantic, "semantic-copy", "local:semantic", `local:semantic cosine to the nearest stored competitor text is ${semantic.toFixed(2)}.`));
    }
    return { present: facts.competitorTexts.length > 0, features };
  }
  if (id === "claim_safety") {
    const banned = facts.prohibited
      .split(/[\n,;]+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 3);
    const hit = banned.find((part) => text.toLowerCase().includes(part.toLowerCase()));
    return {
      present: true,
      features: [
        feat("aligned", hit ? 0 : 1, "claims", "brand_brain", hit ? "A prohibited claim is present." : "None of the stored prohibited claims appear in the variant."),
        feat("violation", hit ? 1 : 0, "claims", "brand_brain", hit ? `Prohibited claim text “${hit}” is in the variant.` : "Prohibited-claim list was checked against the variant text."),
      ],
    };
  }
  if (id === "logo_match") {
    if (facts.logoSimilarity == null) {
      return {
        present: false,
        features: [feat("missing", 1, "logo", "asset", "No logo similarity was measured on the stored bytes.")],
      };
    }
    return {
      present: true,
      features: [feat("mismatch", 1 - facts.logoSimilarity, "logo", "asset", `Stored logo similarity is ${facts.logoSimilarity.toFixed(2)}.`)],
    };
  }
  if (id === "palette_match") {
    if (facts.paletteDistance == null) {
      return {
        present: false,
        features: [feat("missing", 1, "palette", "asset", "No palette distance was measured on the stored bytes.")],
      };
    }
    return {
      present: true,
      features: [feat("mismatch", facts.paletteDistance, "palette", "asset", `Stored palette distance is ${facts.paletteDistance.toFixed(2)}.`)],
    };
  }
  if (id === "product_match") {
    if (!facts.productName.trim()) {
      return { present: false, features: [feat("missing", 1, "product", "products", "No product name is stored for this variant.")] };
    }
    const mentioned = hasWord(text, facts.productName) || text.toLowerCase().includes(facts.productName.toLowerCase());
    return {
      present: true,
      features: [
        feat(
          mentioned ? "aligned" : "mismatch",
          1,
          "product",
          "products",
          mentioned ? `The stored product name “${facts.productName}” appears in the variant text.` : `The stored product “${facts.productName}” is not in the variant text.`,
        ),
      ],
    };
  }
  if (id === "tone_fit") {
    const words = facts.wordsToAvoid
      .split(/[\n,;]+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 3);
    const hit = words.find((word) => hasWord(text, word));
    return {
      present: facts.tone.trim().length > 0 || words.length > 0,
      features: [
        feat("aligned", hit ? 0 : 1, "tone", "brand_brain", hit ? "An avoided word is present." : "No stored avoided word appears in the variant."),
        feat("violation", hit ? 1 : 0, "tone", "brand_brain", hit ? `Avoided word “${hit}” is in the variant.` : "The avoided-word list was checked."),
      ],
    };
  }
  if (id === "novelty") {
    const used = facts.ownTexts.filter((item) => item.toLowerCase().includes(facts.angle.toLowerCase())).length;
    return {
      present: true,
      features: [feat("coverage", used === 0 ? 0.8 : 0.2, "novelty", "creative_records", used === 0 ? "This brand has no stored creative with this angle." : `${used} of this brand's creatives already use this angle.`)],
    };
  }
  if (id === "duplicate_risk") {
    const phrase = sharedPhrase(text, facts.ownTexts);
    return {
      present: true,
      features: [
        feat("aligned", phrase ? 0 : 1, "duplicate", "creative_records", phrase ? "The variant repeats this brand." : facts.ownTexts.length === 0 ? "This brand has no earlier creative text to duplicate." : "No long phrase from this brand's earlier creatives appears here."),
        feat("violation", phrase ? 1 : 0, "duplicate", "creative_records", phrase ? `The variant repeats this brand's wording: “${phrase}”.` : "Duplicate phrase check ran on stored brand copy."),
      ],
    };
  }
  if (id === "image_readiness") {
    const ready = facts.kind === "image" && facts.byteSize > 0 && (facts.width ?? 0) > 0 && (facts.height ?? 0) > 0 && facts.mime.startsWith("image/") && facts.checksum.length > 10;
    return {
      present: ready,
      features: [
        feat(
          "coverage",
          ready ? 1 : 0,
          "image",
          "assets",
          ready ? `Stored ${facts.mime} ${facts.width}×${facts.height}, ${facts.byteSize} bytes.` : "Image bytes, dimensions, or checksum are missing.",
        ),
      ],
    };
  }
  if (id === "video_readiness") {
    const ready = facts.kind === "video" && facts.byteSize > 0 && (facts.durationMs ?? 0) > 0 && (facts.width ?? 0) > 0 && (facts.transcript.trim().length > 0 || facts.sceneCount > 0);
    return {
      present: ready,
      features: [
        feat(
          "coverage",
          ready ? 1 : 0,
          "video",
          "assets",
          ready
            ? `Stored video ${facts.durationMs}ms with ${facts.sceneCount} scene note(s).`
            : "Video duration, bytes, or scene/transcript evidence is missing.",
        ),
      ],
    };
  }
  if (id === "publishing_readiness") {
    return {
      present: false,
      features: [feat("missing", 1, "publish", "provider_objects", "This variant has no approved publisher configuration stored yet.")],
    };
  }
  return { present: false, features: [feat("missing", 1, id, "unknown", "This question has no stored evidence.")] };
}

export function judgeBrief(input: {
  audience: string;
  hook: string;
  message: string;
  format: string;
  cta: string;
  angle: string;
}): AuditedDecision {
  const spec = QUESTION_SPECS.find((item) => item.id === "brief_completeness");
  if (!spec) throw new Error("Missing question brief_completeness.");
  const fields = [input.audience, input.hook, input.message, input.format, input.cta];
  const filled = fields.filter((item) => item.trim().length > 0).length;
  return judgeFeatures(
    spec,
    [
      feat("coverage", filled / fields.length, "brief-fields", "briefs", `${filled} of ${fields.length} brief fields are stored.`),
      feat("aligned", input.angle.trim() ? 1 : 0, "brief-angle", "opportunities", input.angle.trim() ? `The brief uses ranked angle ${input.angle}.` : "The brief has no angle."),
    ],
    PRIOR_JUDGMENT,
    filled >= 3 && input.angle.trim().length > 0,
  );
}

export function judgeMedia(facts: MediaFacts): AuditedDecision[] {
  const ids = facts.kind === "video" ? VIDEO_QUESTIONS : IMAGE_QUESTIONS;
  return ids.map((id) => {
    const spec = QUESTION_SPECS.find((item) => item.id === id);
    if (!spec) throw new Error(`Missing question ${id}.`);
    const built = build(id, facts);
    return judgeFeatures(spec, built.features, PRIOR_JUDGMENT, built.present);
  });
}

/** Policy across questions. One rejection blocks. Missing evidence cannot auto-approve. */
export function rollupDecision(decisions: AuditedDecision[]): DecisionState {
  if (decisions.some((item) => item.decision === "REJECT")) return "REJECT";
  if (decisions.some((item) => item.decision !== "AUTO_APPROVE")) return "HUMAN_REVIEW";
  return "AUTO_APPROVE";
}
