import assert from "node:assert/strict";
import test from "node:test";
import { RESEARCH_SCHEMA_VERSION, validateResearchAnalysis } from "./schema.ts";

/** A model response that cites one transcript segment for every field. */
function modelResponse(overrides: Record<string, unknown> = {}) {
  const cite = { confidence: 0.8, evidence: ["s1"] };
  return {
    topic: { value: "kitchen sponges", ...cite },
    openingMove: { value: "question", ...cite },
    hookMechanism: { value: "pain_point", ...cite },
    hook: { value: "Tired of smelly sponges?", ...cite },
    structure: { value: "problem_solution", ...cite },
    evidenceOffered: { value: "none", ...cite },
    emotionalAppeal: { value: "relief", ...cite },
    adviceSpecificity: { value: "not_applicable", ...cite },
    cta: { value: "none", ...cite },
    segments: [{ id: "s1", text: "Tired of smelly sponges?", startMs: 0, endMs: 2000, role: "hook", confidence: 0.9 }],
    claims: [{ text: "Stays fresh longer", type: "product_benefit", evidence: ["s1"] }],
    ...overrides,
  };
}

test("analyses are versioned and label transcript segments as OBSERVED and model output as INFERRED", () => {
  const analysis = validateResearchAnalysis(modelResponse());
  assert.equal(analysis.schemaVersion, "jev.research-ad.v2");
  assert.equal(RESEARCH_SCHEMA_VERSION, "jev.research-ad.v2");
  assert.equal(analysis.segments[0]!.state, "OBSERVED", "transcript text and timestamps are observations");
  assert.equal(analysis.hookMechanism.state, "INFERRED", "a field label is the model's inference from the observed text");
  assert.equal(analysis.claims[0]!.state, "INFERRED");
});

test("each field's confidence is labelled as the model's self-report, not a calibrated score", () => {
  const analysis = validateResearchAnalysis(modelResponse());
  for (const name of ["topic", "openingMove", "hookMechanism", "hook", "structure", "evidenceOffered", "emotionalAppeal", "adviceSpecificity", "cta"] as const) {
    assert.equal(analysis[name].confidenceSource, "model_self_report", name);
  }
});

test("a model cannot label its own inference as an observation: state comes from the validator, not the response", () => {
  const response = modelResponse({
    hookMechanism: { value: "pain_point", confidence: 0.8, evidence: ["s1"], state: "OBSERVED" },
    claims: [{ text: "Stays fresh longer", type: "product_benefit", evidence: ["s1"], state: "OBSERVED" }],
    segments: [{ id: "s1", text: "Tired of smelly sponges?", startMs: 0, endMs: 2000, role: "hook", confidence: 0.9, state: "INFERRED" }],
  });
  const analysis = validateResearchAnalysis(response);
  assert.equal(analysis.hookMechanism.state, "INFERRED");
  assert.equal(analysis.claims[0]!.state, "INFERRED");
  assert.equal(analysis.segments[0]!.state, "OBSERVED");
});

test("evidence that cites an unknown transcript segment is still refused", () => {
  const response = modelResponse({
    hookMechanism: { value: "pain_point", confidence: 0.8, evidence: ["s404"] },
  });
  assert.throws(() => validateResearchAnalysis(response), /unknown transcript segment/);
});
