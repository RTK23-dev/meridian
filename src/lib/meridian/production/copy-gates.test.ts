import { unselectedOpenRouterEngine } from "../testing/openrouter-engine-stub.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { copyClaimRejections, prohibitedClaimRejection, PROHIBITED_CLAIM_RULE, UNSUPPORTED_CLAIM_RULE } from "../decisions/deterministic.ts";
import { runEngineGate } from "../decisions/gate.ts";
import type { DecisionEngine, DecisionEngineId } from "../decisions/types.ts";
import { briefDeterministicRejections, type BriefBrain, type BriefForGate } from "../studio/brief-gate.server.ts";
import { assessCopy } from "./assess.ts";
import { evaluateProductionPreflight } from "./preflight.ts";
import type { CreativeSpec } from "./types.ts";

const copy = (text: string, prohibitedClaims = "") => ({
  text,
  productName: "Acme Cleanser",
  allowedClaims: "",
  prohibitedClaims,
  requiredDisclaimers: "",
  wordsToAvoid: "",
  hook: "Watch this",
  cta: "Buy now",
});

test("a prohibited claim rejects the copy, whatever its score, and the reason code names the claim", () => {
  const result = assessCopy(copy("Acme Cleanser is a guaranteed fix.", "guaranteed"));
  assert.equal(result.decision.decision, "REJECT");
  assert.equal(result.reasonCode, "prohibited_claim");
});

test("an unsupported claim rejects the copy, and the reason code names the claim", () => {
  const result = assessCopy(copy("Acme Cleanser is clinically proven to work."));
  assert.equal(result.decision.decision, "REJECT");
  assert.equal(result.reasonCode, "unsupported_claim");
});

test("clean copy is never approved without a calibrated decision: it goes to review", () => {
  const result = assessCopy(copy("Acme Cleanser lifts grease in one wipe."));
  assert.equal(result.decision.decision, "HUMAN_REVIEW");
  assert.equal(result.reasonCode, null);
});

test("a missing disclaimer goes to review, not to a rejection", () => {
  const result = assessCopy({ ...copy("Acme Cleanser lifts grease in one wipe."), requiredDisclaimers: "results vary" });
  assert.equal(result.decision.decision, "HUMAN_REVIEW");
});

test("the copy rejection rules are the same rules the decision reports", () => {
  const { evidence } = assessCopy(copy("Acme Cleanser is a guaranteed fix.", "guaranteed"));
  const rejections = copyClaimRejections(evidence);
  assert.deepEqual(rejections.map((entry) => entry.rule), [PROHIBITED_CLAIM_RULE]);
  const unsupported = copyClaimRejections({ prohibitedHits: [], unsupportedClaimHits: ["clinically proven"] });
  assert.deepEqual(unsupported.map((entry) => entry.rule), [UNSUPPORTED_CLAIM_RULE]);
  assert.deepEqual(copyClaimRejections({ prohibitedHits: [], unsupportedClaimHits: [] }), []);
});

test("one shared rule decides a stored prohibited claim, in the brief gate and in the copy check alike", () => {
  const brief: BriefForGate = {
    audience: "Parents",
    hook: "Watch this",
    message: "This is a guaranteed fix.",
    format: "video",
    cta: "Buy now",
    angle: "Speed",
  };
  const brain: BriefBrain = { positioning: "", valueProposition: "", tone: "", prohibitedClaims: "guaranteed", wordsToAvoid: "" };
  const fromBrief = briefDeterministicRejections(brief, brain);
  const fromCopy = copyClaimRejections({ prohibitedHits: ["guaranteed"], unsupportedClaimHits: [] });
  assert.deepEqual(fromBrief.map((entry) => entry.rule), [PROHIBITED_CLAIM_RULE]);
  assert.deepEqual(fromCopy.map((entry) => entry.rule), [PROHIBITED_CLAIM_RULE]);
  assert.equal(prohibitedClaimRejection("This is a GUARANTEED fix.", ["guaranteed"])?.rule, PROHIBITED_CLAIM_RULE);
  assert.equal(prohibitedClaimRejection("A clean sentence.", ["guaranteed"]), null);
});

test("a copy rejection passed to the shared gate decides with zero engine calls", async () => {
  const calls: DecisionEngineId[] = [];
  const throwingEngine = (id: DecisionEngineId): DecisionEngine => ({
    id,
    adapterVersion: "throws.v1",
    capabilities: () => ({
      engineId: id,
      questionKinds: [],
      inputModalities: ["text"],
      maxImages: 0,
      maxImageBytes: 0,
      imageMimeTypes: [],
      batchQuestions: true,
      reportsUsage: false,
      semantics: { predicate: "probability", choice: "categorical_with_confidence", score: "ordered_level_expectation" },
    }),
    health: async () => ({ status: "READY" }),
    decide: async () => {
      calls.push(id);
      throw new Error("an engine must not be called for a deterministic rejection");
    },
  });
  const { evidence } = assessCopy(copy("Acme Cleanser is a guaranteed fix.", "guaranteed"));
  const result = await runEngineGate({
    organizationId: "org-copy",
    brandId: "brand-copy",
    gate: "copy",
    subject: { type: "creative", id: "creative-copy" },
    description: "Copy under test.",
    questions: [],
    evidence: [{ kind: "text", name: "copy", source: "test", content: { text: "Acme Cleanser is a guaranteed fix." } }],
    deterministicRejections: copyClaimRejections(evidence),
    selection: { engineId: "jev", source: "workspace" },
    engines: { jev: throwingEngine("jev"), "openai-decisions": throwingEngine("openai-decisions"), "openrouter-decisions": unselectedOpenRouterEngine() },
  });
  assert.equal(result.action, "REJECT");
  assert.equal(result.engineCalled, false);
  assert.deepEqual(calls, []);
});

test("preflight reports that it did not judge claims, and never reports a claim check as passed", () => {
  const spec: CreativeSpec = {
    id: "spec-claims",
    organizationId: "org-1",
    brandId: "brand-1",
    title: "Spec",
    modality: "video",
    format: "ugc",
    aspectRatio: "9:16",
    durationTargetSeconds: 20,
    hookLine: "Watch what happened.",
    script: "This product is clinically proven.",
    scenes: [{ index: 0, description: "Holding up product", durationSeconds: 5 }],
  };
  const passed = evaluateProductionPreflight(spec);
  assert.equal(passed.claimsJudged, false);
  assert.equal(passed.reasons.some((reason) => /claim/i.test(reason)), false, "no claim check is reported");
  const blocked = evaluateProductionPreflight({ ...spec, hookLine: "" });
  assert.equal(blocked.claimsJudged, false);
  assert.equal(blocked.decision, "BLOCK");
});
