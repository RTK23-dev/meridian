import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertSameTenant } from "../domain.ts";
import { opportunityScore, DEFAULT_WEIGHTS } from "../scoring.ts";
import { decide, decideForTenant, type DecisionQuestion } from "./engine.ts";
import { PRIOR_JUDGMENT, fitReviewerCalibration, judgeFeatures, QUESTION_SPECS } from "./judgment.ts";
import { claimSafety, creativeQa, opportunityGate, visualQa, type OpportunityGateInput } from "./questions.ts";
import { judgeMedia } from "../studio/features.ts";

const cleanClaims = { prohibitedHits: [] as string[], unsupportedClaimHits: [] as string[], missingDisclaimers: [] as string[] };

function supportedGate(): OpportunityGateInput {
  return {
    competitive: { competitorCount: 4, matchingCompetitors: 3, ownCount: 2, matchingOwn: 0 },
    brand: { keywordHits: 4, keywordTotal: 4, formatPreferred: true, brainFilled: 0.8 },
    historical: { lift: 0.8, sampleSize: 4, impressions: 4000, metric: "roas" },
    risk: { claimIntensity: 0.2, aggressiveRejections: 0, negativeLift: 0 },
    reproducibility: { templateCoverage: 0.9, copiesProtectedPhrasing: false },
  };
}

/** A calibration step that maps a score to itself. It stands for a calibrated value in these tests, and only that can approve. */
const CALIBRATED = { calibration: { version: "identity.test.v1", apply: (score: number) => score } };

test("strong evidence can auto-approve once its score is calibrated, and the answer is yes", () => {
  // Uncalibrated, the same strong evidence can only go to review (the cap in jev/engine.ts decide).
  const uncalibrated = decide(claimSafety, cleanClaims);
  assert.equal(uncalibrated.decision, "HUMAN_REVIEW");
  assert.equal(uncalibrated.calibrationVersion, null);
  const decision = decide(claimSafety, cleanClaims, CALIBRATED);
  assert.equal(decision.decision, "AUTO_APPROVE");
  assert.equal(decision.answer.value, "yes");
  assert.equal(decision.answer.schemaVersion, "jev.answer.v1");
  assert.equal(decision.schemaVersion, "jev.answer.v1");
  assert.equal(decision.questionVersion, "v1");
  assert.ok(decision.policyVersion.startsWith("code:claim_safety"));
  assert.equal(decision.calibrationVersion, "identity.test.v1");
  assert.ok(decision.decidedAt.length > 10);
  assert.ok(decision.evidence.length > 0);
});

test("uncertain evidence routes to human review", () => {
  const decision = decide(creativeQa, {
    ...cleanClaims,
    missingDisclaimers: ["results vary"],
    avoidedWordHits: [],
    productRequired: true,
    productMentioned: true,
    hasHook: true,
    hasCta: true,
    toneConflict: false,
  });
  assert.equal(decision.decision, "HUMAN_REVIEW");
  assert.equal(decision.answer.value, "uncertain");
  assert.notEqual(decision.decision, "AUTO_APPROVE");
});

test("explicit violations reject even when a caller supplies a high probability", () => {
  const prohibited = decide(claimSafety, { ...cleanClaims, prohibitedHits: ["cures eczema"] });
  assert.equal(prohibited.decision, "REJECT");
  assert.equal(prohibited.answer.value, "violation");
  const fake: DecisionQuestion<null> = {
    id: "claim_safety",
    version: "v1",
    description: "Injected violation.",
    thresholds: { autoApprove: 0.5, humanReview: 0.2, minConfidenceForAuto: 0.5 },
    evaluate: () => ({
      probability: 0.99,
      confidence: 0.99,
      reasons: ["The copy repeats a prohibited claim."],
      evidence: [{ id: "claims", source: "brand_brain", summary: "Prohibited claim is present." }],
      evidenceState: "violation",
    }),
  };
  assert.equal(decide(fake, null).decision, "REJECT");
});

test("missing vision evidence cannot auto-approve and is not invented", () => {
  const input = {
    available: false,
    logoPresent: null,
    logoMatchProbability: null,
    paletteMatch: null,
    productMatch: null,
    claimDetected: null,
    claimSupported: null,
    toneFit: null,
  };
  const decision = decide(visualQa, input);
  assert.equal(decision.decision, "HUMAN_REVIEW");
  assert.equal(decision.answer.value, "insufficient");
  assert.equal(input.logoMatchProbability, null);
  assert.equal(input.logoPresent, null);
  assert.ok(decision.evidence.every((item) => !/similarity is 0\.\d+/.test(item.summary)));
  assert.match(decision.reasons[0] ?? "", /No vision evidence/);
  const empty: DecisionQuestion<null> = {
    id: "evidence_sufficiency",
    version: "v1",
    description: "Evidence sufficiency.",
    thresholds: { autoApprove: 0.5, humanReview: 0.2, minConfidenceForAuto: 0.5 },
    evaluate: () => ({ probability: 0.99, confidence: 0.99, reasons: ["Nothing was measured."], evidence: [] }),
  };
  const missing = decide(empty, null);
  assert.equal(missing.decision, "HUMAN_REVIEW");
  assert.equal(missing.answer.value, "insufficient");
  assert.notEqual(missing.decision, "AUTO_APPROVE");
});

test("competitor-copy risk rejects", () => {
  const decisions = judgeMedia({
    kind: "image",
    positioning: "The point is the lather and the proof of a simple bar.",
    tone: "plain",
    prohibited: "",
    wordsToAvoid: "",
    productName: "Lather bar",
    angle: "lather_proof",
    copy: "today only this exact line from a rival",
    prompt: "Still.",
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
    logoSimilarity: 0.9,
    paletteDistance: 0.1,
    semanticSimilarity: null,
  });
  const copy = decisions.find((item) => item.questionId === "competitor_copy_risk");
  assert.equal(copy?.decision, "REJECT");
  assert.equal(copy?.answer.value, "violation");
  assert.equal(copy?.schemaVersion, "jev.answer.v1");
});

test("claim risk forces rejection", () => {
  const decision = decide(claimSafety, { ...cleanClaims, unsupportedClaimHits: ["clinically proven"] });
  assert.equal(decision.decision, "REJECT");
  assert.equal(decision.answer.value, "violation");
});

test("another tenant's evidence cannot influence a decision", () => {
  const own = [{ organizationId: "org", brandId: "brand" }];
  const foreign = [{ organizationId: "other", brandId: "other" }];
  assert.throws(() => assertSameTenant([...own, ...foreign], "org", "brand"), /Tenant scope/);
  assert.throws(
    () =>
      decideForTenant(claimSafety, { ...cleanClaims, prohibitedHits: ["cure"] }, {
        organizationId: "org",
        brandId: "brand",
        evidence: foreign,
      }),
    /Tenant scope/,
  );
  const kept = decideForTenant(
    claimSafety,
    cleanClaims,
    { organizationId: "org", brandId: "brand", evidence: own },
    CALIBRATED,
  );
  assert.equal(kept.decision, "AUTO_APPROVE");
  const poisoned = decide(claimSafety, { ...cleanClaims, prohibitedHits: ["cure"] });
  assert.equal(poisoned.decision, "REJECT");
  assert.notEqual(kept.decision, poisoned.decision);
});

test("calibration does not mutate a historical decision and an approved calibration changes the next one", () => {
  // The historical decision is made under calibration version 1. A later calibration must not change it.
  const historical = decide(claimSafety, cleanClaims, {
    calibration: { version: "threshold-version:1", apply: (probability) => probability },
  });
  assert.equal(decide(claimSafety, cleanClaims).decision, "HUMAN_REVIEW", "an uncalibrated decision cannot approve");
  const snapshot = {
    decision: historical.decision,
    probability: historical.probability,
    policyVersion: historical.policyVersion,
    calibrationVersion: historical.calibrationVersion,
  };
  const future = decide(claimSafety, cleanClaims, {
    calibration: { version: "threshold-version:2", apply: (probability) => probability - 0.5 },
    policyVersion: "approved:claim_safety.2",
  });
  assert.equal(historical.decision, snapshot.decision);
  assert.equal(historical.probability, snapshot.probability);
  assert.equal(historical.policyVersion, snapshot.policyVersion);
  assert.equal(historical.calibrationVersion, "threshold-version:1");
  assert.equal(historical.decision, "AUTO_APPROVE");
  assert.notEqual(future.probability, historical.probability);
  assert.equal(future.decision, "REJECT");
  assert.equal(future.policyVersion, "approved:claim_safety.2");
  assert.equal(future.calibrationVersion, "threshold-version:2");
  const bias = PRIOR_JUDGMENT.bias;
  const small = fitReviewerCalibration(PRIOR_JUDGMENT, [{ features: [{ name: "aligned", value: 1 }], approved: false }], 30);
  assert.equal(small.status, "insufficient");
  assert.equal(PRIOR_JUDGMENT.bias, bias);
  assert.equal(PRIOR_JUDGMENT.version, "v1");
  const spec = QUESTION_SPECS.find((item) => item.id === "creative_quality");
  assert.ok(spec);
  const features = [
    { name: "aligned", value: 1, evidenceId: "hook", source: "brief", summary: "The variant has a hook." },
    { name: "coverage", value: 1, evidenceId: "fields", source: "brief", summary: "The brief has the required fields." },
  ];
  const before = judgeFeatures(spec, features, PRIOR_JUDGMENT, true);
  const rows = Array.from({ length: 40 }, () => ({
    features: features.map((item) => ({ name: item.name, value: item.value })),
    approved: false,
  }));
  const fitted = fitReviewerCalibration(PRIOR_JUDGMENT, rows, 30);
  const after = judgeFeatures(spec, features, fitted.model, true);
  assert.equal(fitted.status, "fitted");
  assert.notEqual(after.probability, before.probability);
  assert.equal(before.probability, judgeFeatures(spec, features, PRIOR_JUDGMENT, true).probability);
  assert.equal(JSON.stringify(before.policy), JSON.stringify(after.policy));
});

test("ranking and JEV judgment are numerically separate", () => {
  const inputs = {
    brandFit: 0.9,
    historicalEvidence: 0.2,
    marketSignal: 0.4,
    novelty: 0.3,
    reproducibility: 0.8,
    saturation: 0.1,
    risk: 0.2,
  };
  const rank = opportunityScore(inputs, DEFAULT_WEIGHTS);
  const moved = opportunityScore(inputs, { ...DEFAULT_WEIGHTS, brandFit: 4 });
  assert.notEqual(rank.normalized, moved.normalized);
  const judgment = decide(opportunityGate, supportedGate());
  assert.notEqual(judgment.probability, rank.normalized);
  assert.notEqual(judgment.probability, moved.normalized);
  assert.equal(decide(opportunityGate, supportedGate()).probability, judgment.probability);
  assert.equal("rawScore" in supportedGate(), false);
  assert.notEqual(judgment.probability, rank.raw);
});

test("the signed-in paths call this engine instead of a hardcoded decision", () => {
  const session = readFileSync(new URL("../studio/session.server.ts", import.meta.url), "utf8");
  const imageQc = readFileSync(new URL("../studio/image-qc.server.ts", import.meta.url), "utf8");
  const opportunity = readFileSync(new URL("../opportunity/actions.ts", import.meta.url), "utf8");
  const studio = readFileSync(new URL("../studio/creative-actions.ts", import.meta.url), "utf8");
  const publishing = readFileSync(new URL("../publishing/actions.ts", import.meta.url), "utf8");
  const rerank = readFileSync(new URL("../opportunity/rerank.ts", import.meta.url), "utf8");
  assert.match(imageQc, /judgeMedia\(/);
  assert.match(readFileSync(new URL("../studio/brief-service.server.ts", import.meta.url), "utf8"), /judgeBriefFit\(/);
  assert.match(readFileSync(new URL("../studio/brief-service.server.ts", import.meta.url), "utf8"), /writeBriefDecision\(/);
  assert.doesNotMatch(session, /judgeBrief\(/, "the brief path is the gate, not the local completeness prior");
  assert.match(session, /decide\(publishingReadiness/);
  assert.doesNotMatch(session, /readiness\.state === "READY" \? 0\.9/);
  assert.match(opportunity, /decideForTenant\(active\.question/);
  assert.match(studio, /decideForTenant\(visualPolicy\.question/);
  assert.match(studio, /decideForTenant\(textPolicy\.question/);
  assert.match(rerank, /decideForTenant\(active\.question/);
  assert.doesNotMatch(opportunity, /expectedValue >= [^;]*AUTO_APPROVE/);
  const review = publishing.slice(publishing.indexOf("export const resolveReview"));
  const update = review.slice(review.indexOf("update jev_decisions"), review.indexOf("where id = ${review.decision_id}"));
  assert.match(update, /reviewer_decision/);
  assert.doesNotMatch(update, /(?<!reviewer_)decision =/);
});
