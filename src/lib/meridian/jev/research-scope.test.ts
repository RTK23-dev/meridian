/**
 * Research evidence scopes. The research bundle supplies transcript, scene, and structure evidence. It does not supply a script,
 * brand-allowed claims, or a source reference. So the research claim-compliance question has no evidence to judge from: it is
 * never sent, and it goes to review. Each organic question receives only the structure it judges from.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { EvidenceBundle } from "../evidence/types.ts";
import { JevDecisionService } from "./service.ts";
import type { JevAnswer, JevDecisionRequest, JevDecisionResponse, JevProviderRouter } from "./types.ts";

// The active engine is the deployment default for this test, so the result does not depend on the machine it runs on.
process.env.DECISION_ENGINE = "jev";

const CLAIM = "safety.claim_compliance.v1";
const HOOK = "organic.hook_mechanism.v1";

const bundle = {
  id: "bundle-research-scope",
  source: { platform: "test", canonicalUrl: "https://example.test/video", externalId: "video" },
  content: { type: "video" },
  transcript: [{ startMs: 0, endMs: 1000, text: "Dinner in ten minutes." }],
  scenes: [{ index: 0, startMs: 0, endMs: 1000, shotType: "close", facePresence: true, keyframeRef: "frame-0" }],
  ocr: [],
  comments: [],
  performance: { views: 100, likes: 5 },
} as unknown as EvidenceBundle;

function recordingRouter() {
  const requests: JevDecisionRequest[] = [];
  const router = {
    decide: async (request: JevDecisionRequest): Promise<JevDecisionResponse> => {
      requests.push(request);
      const answers: Record<string, JevAnswer> = {};
      for (const [key, spec] of Object.entries(request.questions)) {
        answers[key] = {
          questionId: spec.id,
          questionVersion: spec.version,
          type: spec.type,
          model: "stub-model",
          provider: "stub",
          status: "answered",
          answer: 0.9,
          probability: 0.9,
          noul: 0.9,
          evidenceRefs: [],
          evaluatedAt: new Date().toISOString(),
        } as JevAnswer;
      }
      return { runId: randomUUID(), model: "stub-model", provider: "stub", inputHash: "stub-hash", cached: false, latencyMs: 1, answers };
    },
    getProvider: () => {
      throw new Error("not used by this test");
    },
    health: async () => ({}),
  };
  return { router: router as unknown as JevProviderRouter, requests };
}

const askedIds = (request: JevDecisionRequest) => Object.values(request.questions).map((spec) => spec.id);

test("research: the claim question has no evidence to judge from, so it is never sent and it goes to review", async () => {
  const { router, requests } = recordingRouter();
  const service = new JevDecisionService(router);
  const result = await service.evaluateEvidence({ organizationId: "org-research-scope", brandId: "brand-research-scope", bundle });
  assert.equal(result.gate?.action, "HUMAN_REVIEW", "a claim question with no evidence cannot approve research");
  assert.ok(requests.every((request) => !askedIds(request).includes(CLAIM)), "the claim question is never sent to the engine");
  const claim = result.answers.find((answer) => answer.questionId === CLAIM);
  assert.equal(claim?.status, "abstain_insufficient_evidence");
  assert.ok(result.gate?.unresolved.some((item) => item.questionId === CLAIM), "the claim question is recorded as unresolved");
  assert.ok(requests.every((request) => !/brand_allowed_claims|"script"/.test(JSON.stringify(request.state))), "no claim or script is supplied");
});

test("research: each organic question receives only the structure it judges from", async () => {
  const { router, requests } = recordingRouter();
  const service = new JevDecisionService(router);
  await service.evaluateEvidence({ organizationId: "org-research-scope", brandId: "brand-research-scope", bundle });
  const hook = requests.find((request) => askedIds(request).includes(HOOK));
  assert.ok(hook, "the hook question is asked");
  assert.deepEqual([...(hook.state.availableEvidence as string[])].sort(), ["scene_frames", "transcript"]);
  assert.deepEqual(Object.keys((hook.state.evidence ?? {}) as Record<string, unknown>).sort(), ["scene_frames", "transcript"], "the hook call holds only its own scope");
  // The hook scope and the call-to-action scope differ, and the format and retention questions share one scope, so two calls.
  // The claim question has no scope with evidence, so it has no call.
  assert.equal(requests.length, 2, "two distinct organic scopes, one call each; the claim question has no call");
});
