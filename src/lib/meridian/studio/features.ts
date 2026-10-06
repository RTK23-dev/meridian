import { hasWord } from "../domain.ts";
import type { AppliedPolicy } from "../jev/policy.ts";
import {
  PRIOR_JUDGMENT,
  QUESTION_SPECS,
  judgeFeatures,
  type AuditedDecision,
  type Feature,
  type JudgeOptions,
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
  /** Set when bytes were measured. Unset means the measurement was not run. */
  logoOutcome?: "MATCH" | "MISMATCH" | "UNCERTAIN" | "ABSENT";
  logoEvidence?: string;
  paletteDistance: number | null;
  paletteOutcome?: "MATCH" | "MISMATCH" | "UNCERTAIN" | "ABSENT";
  paletteEvidence?: string;
  /** local:semantic cosine to competitor copy. Null means the model did not return a vector. */
  semanticSimilarity: number | null;
  /** Cosine to this brand's earlier creatives. Null means no vector was returned. */
  ownSemanticSimilarity?: number | null;
  publishing?: { state: "READY" | "NOT_READY" | "EXTERNAL_CONNECTION_REQUIRED" | "HUMAN_REVIEW"; summary: string } | null;
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

/** Exact phrase plus semantic band. Semantic similarity alone does not reject a legitimate variation. */
export function classifyDuplicate(copy: string, ownTexts: string[], ownSemanticSimilarity: number | null): "exact" | "near" | "paraphrase" | "related" | "novel" | "unchecked" {
  if (sharedPhrase(copy, ownTexts)) return "exact";
  if (ownSemanticSimilarity == null) return ownTexts.some((text) => text.trim().length >= 8) ? "unchecked" : "novel";
  if (ownSemanticSimilarity >= 0.94) return "near";
  if (ownSemanticSimilarity >= 0.82) return "paraphrase";
  if (ownSemanticSimilarity >= 0.68) return "related";
  return "novel";
}
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
    const outcome = facts.logoOutcome;
    const evidence = facts.logoEvidence || "Logo evidence was not measured from stored bytes.";
    if (!outcome || outcome === "ABSENT" || outcome === "UNCERTAIN" || facts.logoSimilarity == null) {
      return {
        present: false,
        features: [feat("missing", 1, "logo", "asset", evidence)],
      };
    }
    if (outcome === "MISMATCH") {
      return {
        present: true,
        features: [feat("violation", 1, "logo", "asset", evidence)],
      };
    }
    return {
      present: true,
      features: [feat("aligned", facts.logoSimilarity, "logo", "asset", evidence)],
    };
  }
  if (id === "palette_match") {
    const outcome = facts.paletteOutcome;
    const evidence = facts.paletteEvidence || "Palette evidence was not measured from stored bytes.";
    if (!outcome || outcome === "ABSENT" || outcome === "UNCERTAIN" || facts.paletteDistance == null) {
      return {
        present: false,
        features: [feat("missing", 1, "palette", "asset", evidence)],
      };
    }
    if (outcome === "MISMATCH") {
      return {
        present: true,
        features: [feat("violation", 1, "palette", "asset", evidence)],
      };
    }
    return {
      present: true,
      features: [feat("aligned", 1 - facts.paletteDistance, "palette", "asset", evidence)],
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
    const kind = classifyDuplicate(text, facts.ownTexts, facts.ownSemanticSimilarity ?? null);
    if (kind === "unchecked") {
      return {
        present: false,
        features: [feat("missing", 1, "duplicate", "creative_embeddings", "Exact wording was checked. No embedding was returned, so semantic duplicate risk stays in review.")],
      };
    }
    if (kind === "exact" || kind === "near") {
      const phrase = sharedPhrase(text, facts.ownTexts);
      return {
        present: true,
        features: [
          feat(
            "violation",
            1,
            "duplicate",
            kind === "exact" ? "creative_records" : "creative_embeddings",
            kind === "exact"
              ? `Exact duplicate of stored brand wording: “${phrase}”.`
              : `Near-duplicate. Cosine to an earlier creative is ${(facts.ownSemanticSimilarity ?? 0).toFixed(2)}.`,
          ),
        ],
      };
    }
    if (kind === "paraphrase" || kind === "related") {
      return {
        present: true,
        features: [
          feat(
            "coverage",
            kind === "paraphrase" ? 0.35 : 0.55,
            "duplicate",
            "creative_embeddings",
            kind === "paraphrase"
              ? `Paraphrase band. Cosine ${(facts.ownSemanticSimilarity ?? 0).toFixed(2)} is not an automatic rejection.`
              : `Related concept. Cosine ${(facts.ownSemanticSimilarity ?? 0).toFixed(2)} is not the same creative.`,
          ),
        ],
      };
    }
    return {
      present: true,
      features: [
        feat("aligned", 1, "duplicate", "creative_records", facts.ownTexts.length === 0 ? "This brand has no earlier creative text to duplicate." : "No exact or near-duplicate of this brand's stored creatives."),
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
    const publishing = facts.publishing;
    if (!publishing) {
      return {
        present: false,
        features: [feat("missing", 1, "publish", "provider_connections", "Publishing readiness was not evaluated against a stored ad account.")],
      };
    }
    if (publishing.state === "READY") {
      return {
        present: true,
        features: [feat("aligned", 1, "publish", "provider_connections", publishing.summary)],
      };
    }
    return {
      present: false,
      features: [feat("missing", 1, "publish", "provider_connections", `${publishing.state}. ${publishing.summary}`)],
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
}, policy?: AppliedPolicy): AuditedDecision {
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
    policyOptions(policy),
  );
}

export function judgeMedia(facts: MediaFacts, policies?: ReadonlyMap<string, AppliedPolicy>): AuditedDecision[] {
  const ids = facts.kind === "video" ? VIDEO_QUESTIONS : IMAGE_QUESTIONS;
  return ids.map((id) => {
    const spec = QUESTION_SPECS.find((item) => item.id === id);
    if (!spec) throw new Error(`Missing question ${id}.`);
    const built = build(id, facts);
    return judgeFeatures(spec, built.features, PRIOR_JUDGMENT, built.present, policyOptions(policies?.get(id)));
  });
}

function policyOptions(policy?: AppliedPolicy): JudgeOptions | undefined {
  if (!policy?.calibration) return undefined;
  return {
    thresholds: policy.thresholds,
    policyVersion: policy.policyVersion,
    calibration: policy.calibration,
    provider: "logistic-prior",
  };
}

/** Policy across questions. One rejection blocks. Missing evidence cannot auto-approve. */
export function rollupDecision(decisions: AuditedDecision[]): DecisionState {
  if (decisions.some((item) => item.decision === "REJECT")) return "REJECT";
  if (decisions.some((item) => item.decision !== "AUTO_APPROVE")) return "HUMAN_REVIEW";
  return "AUTO_APPROVE";
}
