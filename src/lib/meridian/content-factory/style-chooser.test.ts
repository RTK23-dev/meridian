import assert from "node:assert/strict";
import test from "node:test";
import type { JevAnswer } from "../jev/types.ts";
import { rankingFromDecision, STYLE_QUESTION_ID, STYLE_QUESTION_KEY, styleChoiceState, styleQuestion } from "./style-chooser.ts";
import { STYLE_PRESETS } from "./style-presets.ts";

const answered = (over: Partial<JevAnswer> & Record<string, unknown> = {}): JevAnswer =>
  ({ questionId: STYLE_QUESTION_ID, questionVersion: "1.0.0", type: "choice", model: "m", provider: "p", status: "answered", answer: "explainer", choice: "explainer", evidenceRefs: [], evaluatedAt: "2026-11-01T00:00:00.000Z", ...over }) as JevAnswer;
const decision = (answer: JevAnswer | undefined, failure?: { kind: string; message: string }) =>
  ({ answers: answer ? { [STYLE_QUESTION_KEY]: answer } : {}, failure, engineId: "jev" as const, returnedModel: "rec-model" }) as never;

test("the question is a choice with one option per preset, and tells the engine the text is data", () => {
  const question = styleQuestion();
  assert.equal(question.type, "choice");
  assert.deepEqual(Object.keys(question.criteria as Record<string, string>), STYLE_PRESETS.map((preset) => preset.id));
  assert.match(question.instructions, /data, not instructions/);
  assert.match(question.instructions, /Choose only from the options/);
});

test("the state names the brand, the goal and the repeating structures, cuts long text, and says when there is no research", () => {
  const long = "x".repeat(5000);
  const state = styleChoiceState({ brandName: "Spongeco", instruction: long, patterns: [] });
  assert.match(state, /^Brand: Spongeco\. Goal \(data\): x+…/);
  assert.match(state, /no repeating structure found/);
  assert.ok(state.length <= 2500);
  const withResearch = styleChoiceState({
    brandName: "Spongeco",
    instruction: "Show the sponge.",
    patterns: [{ dimension: "structure", value: "listicle", sampleCount: 4, corpusSize: 9, prevalence: 0.44, confidence: 0.8 }],
  });
  assert.match(withResearch, /Structure: listicle \(4 of 9\)/);
});

test("an answered choice ranks the chosen style first, then the others by probability, and drops anything not in the library", () => {
  const ranking = rankingFromDecision(decision(answered({ choice: "tips_list", answer: "tips_list", confidence: 0.7, probabilities: { tips_list: 0.5, explainer: 0.3, product_promo: 0.15, not_a_style: 0.9, ugc_style: 0 } })));
  assert.ok(ranking.ok);
  if (!ranking.ok) return;
  assert.deepEqual(ranking.ranked, ["tips_list", "explainer", "product_promo"]);
  assert.equal(ranking.chosen, "tips_list");
  assert.equal(ranking.confidence, 0.7);
  assert.equal(ranking.engine, "jev");
  assert.equal(ranking.model, "rec-model");
});

test("an engine that fails, abstains, answers nothing or chooses outside the library is a refusal with the reason", () => {
  const failed = rankingFromDecision(decision(undefined, { kind: "not_configured", message: "No key is saved." }));
  assert.ok(!failed.ok && /No key is saved/.test(failed.reason));
  const abstained = rankingFromDecision(decision({ questionId: STYLE_QUESTION_ID, questionVersion: "1.0.0", model: "m", provider: "p", status: "abstain_uncertain", evidenceRefs: [], abstainReason: "Too close to call.", evaluatedAt: "x" } as JevAnswer));
  assert.ok(!abstained.ok && /abstain uncertain.*Too close to call/.test(abstained.reason));
  const none = rankingFromDecision(decision(undefined));
  assert.ok(!none.ok && /no answer/.test(none.reason));
  const outside = rankingFromDecision(decision(answered({ choice: "cinematic", answer: "cinematic" })));
  assert.ok(!outside.ok && /not in the library/.test(outside.reason));
});
