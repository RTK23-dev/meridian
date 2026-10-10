import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getSql } from "../../db.ts";
import { studioTenant, PNG } from "../testing/durable-image-fixtures.ts";
import { answeredProbability, registryWith, stubEngine } from "../testing/brief-fixtures.ts";
import { CREATIVE_QUESTIONS } from "../jev/questions/creative.ts";
import { GeminiPerceptionProvider } from "../perception/multimodal.ts";
import { checkEvidenceContract, PRODUCT_VISIBILITY_CONTRACT, VISUAL_QUALITY_CONTRACT } from "../perception/contracts.ts";
import type { MediaObservation, MultimodalPerceptionProvider, PerceptionResult } from "../perception/types.ts";
import { generatedImageVisual, writeJudgment } from "./image-qc.server.ts";
import type { MediaFacts } from "./features.ts";

// Both the shared default and the test credential are set for this process only. Production resolves the same way.
process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || "test-master-key-0123456789abcdef-test";
process.env.PERCEPTION_SHARED_DEFAULT = "gemini";
process.env.MERIDIAN_GEMINI_API_KEY = "test-shared-gemini-key";

const RIVAL = "RIVAL-LINE-XYZ-COMPETITOR";
const PROMPT = "PROMPT-SECRET-GENERATION-123";
const facts: MediaFacts = {
  kind: "image",
  positioning: "Helps busy parents plan a calm dinner in ten minutes.",
  tone: "warm",
  prohibited: "guaranteed",
  wordsToAvoid: "",
  productName: "MealKit",
  angle: "dinner in ten minutes",
  copy: "MealKit: a calm dinner in ten minutes.",
  prompt: PROMPT,
  competitorTexts: [RIVAL],
  ownTexts: [],
  mime: "image/png",
  byteSize: PNG.byteLength,
  width: 64,
  height: 64,
  checksum: "abc123def4567890",
  durationMs: null,
  transcript: "",
  sceneCount: 0,
  logoSimilarity: null,
  logoOutcome: "ABSENT",
  paletteDistance: null,
  paletteOutcome: "ABSENT",
  semanticSimilarity: null,
};

const TEXT_QUESTIONS = [CREATIVE_QUESTIONS["creative.brand_fit.v1"]!.id, CREATIVE_QUESTIONS["creative.opportunity_fit.v1"]!.id, CREATIVE_QUESTIONS["creative.claim_compliance.v1"]!.id];
const VISUAL_QUESTIONS = [CREATIVE_QUESTIONS["creative.visual_quality.v1"]!.id, CREATIVE_QUESTIONS["creative.product_visible.v1"]!.id];

const complete = (mediaId: string, sha256: string): MediaObservation => ({
  mediaId, sha256, timestampMs: null, basis: "inferred",
  productPresence: true, productProminence: "prominent", productObstructed: false,
  sharpness: "sharp", lighting: "good", composition: "balanced", legibility: "no_text", artifactsVisible: false,
});

/** A perception provider that returns the observations it is given, so a test controls exactly what JEV receives. */
function perceptionStub(build: (mediaId: string, sha256: string) => MediaObservation | null, options: { fail?: boolean } = {}) {
  const calls: number[] = [];
  const provider: MultimodalPerceptionProvider = {
    id: "stub_perception", model: "stub-model-1", promptVersion: "stub-prompt.v1",
    health: async () => ({ id: "stub_perception", state: "HEALTHY", detail: "ready" }),
    perceive: async (input): Promise<PerceptionResult> => {
      calls.push(input.media.length);
      if (options.fail) {
        return { status: "failed", providerId: "stub_perception", model: "stub-model-1", promptVersion: "stub-prompt.v1", failureKind: "timeout", message: "stub timeout", latencyMs: 1 };
      }
      const observations = input.media.map((item) => build(item.id, item.sha256)).filter((item): item is MediaObservation => item !== null);
      return { status: "observed", providerId: "stub_perception", model: "stub-model-1", promptVersion: "stub-prompt.v1", observations, latencyMs: 2 };
    },
  };
  return { provider, calls };
}

const judgeWith = async (options: {
  tenant: { organizationId: string; brandId: string; userId: string };
  perception: MultimodalPerceptionProvider | null;
  jevAnswersVisual: boolean;
}) => {
  const sql = await getSql();
  const jev = stubEngine("jev", {
    respond: (spec) => {
      if (TEXT_QUESTIONS.includes(spec.id)) return answeredProbability(spec, 0.97);
      if (options.jevAnswersVisual && VISUAL_QUESTIONS.includes(spec.id)) return answeredProbability(spec, 0.95);
      return undefined;
    },
  });
  const openai = stubEngine("openai-decisions");
  const { saveWorkspaceEngine } = await import("../decisions/selection.ts");
  await saveWorkspaceEngine(sql, { organizationId: options.tenant.organizationId, actorId: options.tenant.userId, engineId: "jev", targetHealth: { status: "READY" } });
  const creativeId = `creative-${randomUUID()}`;
  const visual = generatedImageVisual(PNG, "d".repeat(64));
  const judged = await writeJudgment(sql, {
    organizationId: options.tenant.organizationId,
    brandId: options.tenant.brandId,
    creativeId,
    facts: { ...facts, competitorTexts: [RIVAL], prompt: PROMPT },
    visual,
    perception: options.perception,
    engines: registryWith(jev, openai),
  });
  const [record] = await sql<{ unresolved: unknown; evidence: unknown }>`select unresolved, evidence from decision_gate_records where id = ${judged.gateRecordId}`;
  return { judged, jev, openai, record, sql };
};

test("the contracts are strict: a missing or unknown required fact fails, and an absent value is never a negative", () => {
  const all = [complete("m1", "a".repeat(64))];
  assert.equal(checkEvidenceContract(PRODUCT_VISIBILITY_CONTRACT, all).satisfied, true);
  const unknownPresence = [{ ...complete("m1", "a".repeat(64)), productPresence: null }];
  assert.equal(checkEvidenceContract(PRODUCT_VISIBILITY_CONTRACT, unknownPresence).satisfied, false, "a null presence is unknown, not absent");
  const absentQuality = [{ mediaId: "m1", sha256: "a".repeat(64), timestampMs: null, basis: "inferred" as const, sharpness: "sharp" as const }];
  const quality = checkEvidenceContract(VISUAL_QUALITY_CONTRACT, absentQuality);
  assert.equal(quality.satisfied, false, "fields not reported are not treated as a negative");
  assert.ok(!quality.satisfied && quality.missing.some((item) => item.field === "artifactsVisible"));
  assert.equal(checkEvidenceContract(PRODUCT_VISIBILITY_CONTRACT, []).satisfied, false, "no observations is not evidence");
});

test("under JEV, complete grounded evidence lets JEV judge the visual questions from text, and no image is sent", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "visual-evidence-complete");
  const perception = perceptionStub((mediaId, sha256) => complete(mediaId, sha256));
  const { judged, jev, openai } = await judgeWith({ tenant, perception: perception.provider, jevAnswersVisual: true });
  assert.equal(openai.requests.length, 0, "no substitute engine");
  assert.equal(jev.requests[0]!.images?.length ?? 0, 0, "JEV is never handed an image");
  const asked = Object.values(jev.requests[0]!.questions);
  for (const id of VISUAL_QUESTIONS) {
    const spec = asked.find((item) => item.id === id);
    assert.ok(spec, `${id} is judged from the evidence`);
    assert.ok(spec?.evidenceRequirements.includes("perception_observations"), "the requirement names the evidence actually supplied");
    assert.ok(!spec?.evidenceRequirements.includes("image"), "the requirement does not claim an image was supplied");
  }
  const state = JSON.stringify(jev.requests[0]!.state);
  assert.match(state, /\[product_visibility 1\.0\.0\] productPresence=true; productProminence=prominent; productObstructed=false/);
  assert.match(state, /\[visual_quality 1\.0\.0\] sharpness=sharp; lighting=good; composition=balanced; legibility=no_text; artifactsVisible=false/);
  assert.equal(perception.calls.length, 1, "perception runs once for this judgment");
  assert.equal(judged.gateAction, "AUTO_APPROVE", "every question, visual included, passed its policy from grounded evidence");
});

test("one unknown required fact sends its question to review, names the fact, and never approves it", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "visual-evidence-unknown");
  const perception = perceptionStub((mediaId, sha256) => ({ ...complete(mediaId, sha256), productObstructed: null }));
  const { judged, jev, record } = await judgeWith({ tenant, perception: perception.provider, jevAnswersVisual: true });
  const product = CREATIVE_QUESTIONS["creative.product_visible.v1"]!.id;
  assert.ok(!Object.values(jev.requests[0]!.questions).some((item) => item.id === product), "the product question is not sent to JEV as text");
  const unresolved = JSON.stringify(record?.unresolved);
  assert.match(unresolved, new RegExp(`${product}.*abstain_insufficient_evidence|abstain_insufficient_evidence.*${product}`));
  assert.match(unresolved, /productObstructed/, "the unknown fact is named");
  assert.equal(judged.gateAction, "HUMAN_REVIEW");
  assert.notEqual(judged.rollup, "AUTO_APPROVE");
});

test("perception that fails holds both visual questions for review, names the failure, and calls nothing else", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "visual-evidence-failed");
  const perception = perceptionStub(() => null, { fail: true });
  const { judged, jev, openai, record } = await judgeWith({ tenant, perception: perception.provider, jevAnswersVisual: true });
  assert.equal(openai.requests.length, 0);
  const unresolved = JSON.stringify(record?.unresolved);
  for (const id of VISUAL_QUESTIONS) assert.match(unresolved, new RegExp(id));
  assert.match(unresolved, /timeout/, "the provider failure kind is shown");
  assert.equal(judged.gateAction, "HUMAN_REVIEW");
  assert.equal(jev.requests[0]!.questions && Object.values(jev.requests[0]!.questions).every((item) => TEXT_QUESTIONS.includes(item.id)), true, "only text questions reach JEV");
});

test("the real Gemini provider sees only the media and fixed instructions, and JEV sees no competitor text or prompt", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "visual-evidence-privacy");
  const bodies: string[] = [];
  const gemini = new GeminiPerceptionProvider("gemini-test", {
    fetchImpl: (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify([{ index: 0, productPresence: true, productProminence: "prominent", productObstructed: false, sharpness: "sharp", lighting: "good", composition: "balanced", legibility: "no_text", artifactsVisible: false }]) }] } }] }) };
    }) as unknown as typeof fetch,
  });
  const { jev } = await judgeWith({ tenant, perception: gemini, jevAnswersVisual: true });
  assert.equal(bodies.length, 1, "Gemini is called once");
  assert.doesNotMatch(bodies[0]!, new RegExp(RIVAL), "no competitor text is sent to Gemini");
  assert.doesNotMatch(bodies[0]!, new RegExp(PROMPT), "no generation prompt is sent to Gemini");
  assert.doesNotMatch(bodies[0]!, /MealKit/, "no product copy is sent to Gemini");
  const state = JSON.stringify(jev.requests[0]!.state);
  assert.doesNotMatch(state, new RegExp(RIVAL), "no competitor text reaches JEV");
  assert.doesNotMatch(state, new RegExp(PROMPT), "no generation prompt reaches JEV");
  assert.equal(jev.requests[0]!.images?.length ?? 0, 0);
});
