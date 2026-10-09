import assert from "node:assert/strict";
import test from "node:test";
import { judgeBrief, judgeMedia } from "../studio/features.ts";
import { assertReproducible, canonicalJson, decisionRecordFields } from "./decision-record.ts";

const brief = { audience: "Dry-hand adults", hook: "Dry hands?", message: "A gentle bar.", format: "video", cta: "Shop now", angle: "lather_proof" };

const mediaBase = {
  kind: "image" as const,
  positioning: "The point is the lather and the proof of a simple bar.",
  tone: "plain",
  prohibited: "",
  wordsToAvoid: "",
  productName: "Lather bar",
  angle: "lather_proof",
  copy: "Lather bar, shown in one take. No borrowed line.",
  prompt: "Still of Lather bar. Angle lather_proof.",
  competitorTexts: ["today only this exact line from a rival"],
  ownTexts: [],
  mime: "image/svg+xml",
  byteSize: 80,
  width: 64,
  height: 64,
  checksum: "abc123def4567890",
  durationMs: null,
  transcript: "",
  sceneCount: 0,
  logoSimilarity: null,
  paletteDistance: null,
  semanticSimilarity: null,
};

test("canonical JSON sorts object keys at every depth, so equal values serialize identically", () => {
  const a = canonicalJson({ b: 1, a: { d: [2, 1], c: null } });
  const b = canonicalJson({ a: { c: null, d: [2, 1] }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":null,"d":[2,1]},"b":1}');
});

test("re-running the same brief judgment with the same question version reproduces the same decision record", () => {
  const first = judgeBrief(brief);
  const second = judgeBrief(brief);
  assert.deepEqual(decisionRecordFields(first), decisionRecordFields(second));
  assert.equal(decisionRecordFields(first).decisionFingerprint.length, 64);
});

test("every media question reproduces its own record when the same evidence is judged again", () => {
  const first = judgeMedia(mediaBase);
  const second = judgeMedia(mediaBase);
  assert.equal(first.length, second.length);
  for (let index = 0; index < first.length; index += 1) {
    assert.deepEqual(decisionRecordFields(first[index]!), decisionRecordFields(second[index]!), first[index]!.questionId);
  }
});

test("the decision time and the subject do not change the record: only what the decision saw and said does", () => {
  const decision = judgeBrief(brief);
  const later = { ...decision, decidedAt: "2031-01-01T00:00:00.000Z" };
  assert.deepEqual(decisionRecordFields(decision), decisionRecordFields(later));
});

test("the evidence set is order-independent: the same items in another order are the same record", () => {
  const decision = judgeBrief(brief);
  const evidence = [
    { id: "ev-a", source: "brief", summary: "Audience is stored." },
    { id: "ev-b", source: "brief", summary: "Angle is stored." },
  ];
  const forward = decisionRecordFields({ ...decision, evidence });
  const backward = decisionRecordFields({ ...decision, evidence: [...evidence].reverse() });
  assert.deepEqual(forward, backward);
});

test("a different question version is a different record, even with the same evidence", () => {
  const decision = judgeBrief(brief);
  const next = { ...decision, questionVersion: `${decision.questionVersion}-next` };
  assert.notEqual(decisionRecordFields(next).decisionFingerprint, decisionRecordFields(decision).decisionFingerprint);
});

test("different evidence is a different record", () => {
  const decision = judgeBrief(brief);
  const changed = { ...decision, evidence: [{ id: "ev-c", source: "brief", summary: "A different stored fact." }] };
  assert.notEqual(decisionRecordFields(changed).decisionFingerprint, decisionRecordFields(decision).decisionFingerprint);
});

test("a rerun that matches the fingerprint must match the outcome; a flipped outcome is refused as not reproducible", () => {
  const decision = judgeBrief(brief);
  const prior = decisionRecordFields(decision);
  assertReproducible(prior, decisionRecordFields(judgeBrief(brief)));
  const flipped = { ...decision, decision: decision.decision === "AUTO_APPROVE" ? "HUMAN_REVIEW" as const : "AUTO_APPROVE" as const };
  assert.throws(() => assertReproducible(prior, decisionRecordFields(flipped)), /not reproducible/);
});

test("different evidence never fails the reproducibility check: it is a new record, not a rerun", () => {
  const decision = judgeBrief(brief);
  const prior = decisionRecordFields(decision);
  const other = { ...decision, evidence: [{ id: "ev-z", source: "brief", summary: "Other evidence." }], decision: "REJECT" as const };
  assert.doesNotThrow(() => assertReproducible(prior, decisionRecordFields(other)));
});
