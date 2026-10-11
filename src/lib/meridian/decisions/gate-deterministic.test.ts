import assert from "node:assert/strict";
import test from "node:test";
import type { Sql } from "../learning/store.ts";
import type { JevAnswer, JevQuestionSpec, JevQuestionType } from "../jev/types.ts";
import { contractPngBytes } from "./contract-fixtures.ts";
import { IMAGE_SCOPE, runEngineGate, type GateEvidenceInput, type GateImage, type GateQuestion, type GateResult } from "./gate.ts";
import type { EngineSelection } from "./selection.ts";
import type { DecisionEngine, DecisionEngineId, DecisionRequest, DecisionResult } from "./types.ts";

// Deterministic rules run before any engine call. These tests count calls to both engines. A deterministic case makes zero.

const COPY_CHECK: JevQuestionSpec = {
  id: "test.copy_check.v1",
  version: "1.0.0",
  type: "noul",
  instructions: "Is the copy free of unsupported claims?",
  criteria: { true: "Free of claims.", false: "Makes a claim." },
  evidenceRequirements: ["copy"],
  policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.9, reviewMinProbability: 0.6 },
};
const NEEDS_NOTHING: JevQuestionSpec = {
  id: "test.needs_nothing.v1",
  version: "1.0.0",
  type: "noul",
  instructions: "A question that needs no evidence.",
  criteria: { true: "Yes.", false: "No." },
  evidenceRequirements: [],
  policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.9, reviewMinProbability: 0.6 },
};
const PRODUCT_VISIBLE: JevQuestionSpec = {
  id: "test.product_visible.v1",
  version: "1.0.0",
  type: "noul",
  instructions: "Is the product visible in the frame?",
  criteria: { true: "Visible.", false: "Not visible." },
  evidenceRequirements: ["image"],
  policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.85, reviewMinProbability: 0.6 },
};
const UNMAPPED: JevQuestionSpec = {
  id: "test.unmapped.v1",
  version: "1.0.0",
  type: "noul",
  instructions: "A question with no policy.",
  criteria: { true: "Yes.", false: "No." },
  evidenceRequirements: ["copy"],
};
const UNKNOWN_KIND = { ...COPY_CHECK, id: "test.unknown_kind.v1", type: "rank" as unknown as JevQuestionType };

const COPY: GateEvidenceInput = { kind: "text", name: "copy", source: "test", content: { copy: "A plain product description." } };
const FRAME: GateEvidenceInput = { kind: "image", name: "frame-0", sha256: "f".repeat(64), source: "test" };

/** Records each request, and answers every question as confidently approved unless told otherwise. */
function countingEngine(id: DecisionEngineId) {
  const requests: DecisionRequest[] = [];
  const engine: DecisionEngine = {
    id,
    adapterVersion: `${id}-count.v1`,
    capabilities: () => ({
      engineId: id,
      questionKinds: ["predicate", "choice", "score"],
      inputModalities: id === "openai-decisions" ? ["text", "image"] : ["text"],
      maxImages: id === "openai-decisions" ? 128 : 0,
      maxImageBytes: 20 * 1024 * 1024,
      imageMimeTypes: id === "openai-decisions" ? ["image/png"] : [],
      batchQuestions: true,
      reportsUsage: false,
      semantics: { predicate: "probability", choice: "categorical_with_confidence", score: "ordered_level_expectation" },
    }),
    health: async () => ({ status: "READY" }),
    decide: async (request): Promise<DecisionResult> => {
      requests.push(request);
      const answers: Record<string, JevAnswer> = {};
      for (const [key, spec] of Object.entries(request.questions)) {
        answers[key] = {
          questionId: spec.id,
          questionVersion: spec.version,
          type: spec.type,
          model: "stub-model",
          provider: id,
          status: "answered",
          answer: 0.97,
          probability: 0.97,
          noul: 0.97,
          semantics: "probability",
          calibrationStatus: "calibrated",
          evidenceRefs: [],
          evaluatedAt: new Date().toISOString(),
        } as JevAnswer;
      }
      return {
        runId: globalThis.crypto.randomUUID(),
        model: "stub-model",
        provider: id,
        inputHash: "h",
        cached: false,
        latencyMs: 1,
        answers,
        engineId: id,
        adapterVersion: engine.adapterVersion,
        requestedModel: "stub-model",
        returnedModel: "stub-model",
        inputModality: request.images?.length ? "text+image" : "text",
        imageCount: request.images?.length ?? 0,
        imagesOmitted: 0,
      };
    },
  };
  return { engine, requests };
}

type Recorded = { text: string; values: unknown[] };

/**
 * A fake database. It records every insert, so a test can see the decision record that was written. It can fail the record
 * write, or the workspace's engine read, to exercise the failure paths.
 */
function recordingSql(options: { failRecord?: boolean; failEngineRead?: boolean } = {}) {
  const writes: Recorded[] = [];
  const fn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    if (/decision_gate_records/.test(text) && options.failRecord) return Promise.reject(new Error("record write refused"));
    if (/decision_engine_settings/.test(text) && options.failEngineRead) return Promise.reject(new Error("settings unreadable"));
    if (/^insert into/i.test(text)) writes.push({ text, values });
    return Promise.resolve([]);
  };
  return {
    sql: fn as unknown as Sql,
    gateRecords: () => writes.filter((write) => /decision_gate_records/.test(write.text)),
  };
}

const selected = (engineId: DecisionEngineId): EngineSelection => ({ engineId, source: "workspace" });

const baseInput = (overrides: Partial<Parameters<typeof runEngineGate>[0]> = {}) => {
  const jev = countingEngine("jev");
  const openai = countingEngine("openai-decisions");
  const recorder = recordingSql();
  return {
    jev,
    openai,
    recorder,
    input: {
      sql: recorder.sql,
      organizationId: "org-det",
      brandId: "brand-det",
      gate: "test_gate",
      subject: { type: "creative", id: "creative-det" },
      description: "Test creative.",
      questions: [{ key: "copy", spec: COPY_CHECK, needsImage: false, evidenceScope: ["copy"] }] as GateQuestion[],
      evidence: [COPY],
      selection: selected("jev"),
      engines: { jev: jev.engine, "openai-decisions": openai.engine },
      ...overrides,
    } satisfies Parameters<typeof runEngineGate>[0],
  };
};

const totalCalls = (jev: { requests: unknown[] }, openai: { requests: unknown[] }) => jev.requests.length + openai.requests.length;

test("a deterministic rejection calls no engine on either side, and writes one decision record that names the rule", async () => {
  const { jev, openai, recorder, input } = baseInput({
    selection: selected("openai-decisions"),
    deterministicRejections: [{ rule: "prohibited_claim", reason: "The copy contains a stored prohibited claim." }],
  });
  const result = await runEngineGate(input);
  assert.equal(result.action, "REJECT");
  assert.equal(totalCalls(jev, openai), 0);
  assert.equal(result.engineCalled, false);
  const records = recorder.gateRecords();
  assert.equal(records.length, 1);
  assert.ok(records[0]!.values.some((value) => typeof value === "string" && value.includes("prohibited_claim")));
  assert.ok(result.gateRecordId);
});

test("a question with no evidence scope is refused before any call, even when its spec needs no evidence", async () => {
  const { jev, openai, recorder, input } = baseInput({
    selection: selected("openai-decisions"),
    questions: [{ key: "free", spec: NEEDS_NOTHING, needsImage: false }],
  });
  const result = await runEngineGate(input);
  assert.equal(totalCalls(jev, openai), 0, "zero engine calls");
  assert.equal(result.engineCalled, false);
  assert.equal(result.answers.free?.status, "abstain_insufficient_evidence");
  assert.equal(result.action, "HUMAN_REVIEW");
  assert.equal(recorder.gateRecords().length, 1);
});

test("a question whose evidence scope holds no evidence is refused before any call", async () => {
  const { jev, openai, input } = baseInput({
    selection: selected("jev"),
    questions: [{ key: "copy", spec: COPY_CHECK, needsImage: false, evidenceScope: ["copy"] }],
    evidence: [],
  });
  const result = await runEngineGate(input);
  assert.equal(totalCalls(jev, openai), 0);
  assert.equal(result.answers.copy?.status, "abstain_insufficient_evidence");
  assert.match(result.answers.copy?.abstainReason ?? "", /No evidence is in this question's scope/);
  assert.equal(result.action, "HUMAN_REVIEW");
});

test("a question with no policy mapping is not asked: zero calls, the answer is unsupported, and the subject goes to review", async () => {
  const { jev, openai, input } = baseInput({
    selection: selected("openai-decisions"),
    questions: [{ key: "unmapped", spec: UNMAPPED, needsImage: false, evidenceScope: ["copy"] }],
  });
  const result = await runEngineGate(input);
  assert.equal(totalCalls(jev, openai), 0);
  assert.equal(result.answers.unmapped?.status, "unsupported");
  assert.equal(result.unresolved[0]?.status, "no_policy");
  assert.equal(result.action, "HUMAN_REVIEW");
  assert.match(result.policyVersion, /test\.unmapped\.v1@1\.0\.0\(no-policy\)/);
});

test("a question kind the engines do not answer is refused before any call", async () => {
  const { jev, openai, input } = baseInput({
    selection: selected("openai-decisions"),
    questions: [{ key: "odd", spec: UNKNOWN_KIND, needsImage: false, evidenceScope: ["copy"] }],
  });
  const result = await runEngineGate(input);
  assert.equal(totalCalls(jev, openai), 0);
  assert.equal(result.answers.odd?.status, "unsupported");
  assert.equal(result.action, "HUMAN_REVIEW");
});

test("an image the engine could not read is refused before any call, and the question is unsupported", async () => {
  const garbage: GateImage = { bytes: new Uint8Array([1, 2, 3, 4]), evidenceName: "frame-0", label: "Frame at 0ms" };
  const { jev, openai, input } = baseInput({
    selection: selected("openai-decisions"),
    questions: [{ key: "visible", spec: PRODUCT_VISIBLE, needsImage: true, evidenceScope: [IMAGE_SCOPE] }],
    evidence: [FRAME],
    images: [garbage],
  });
  const result = await runEngineGate(input);
  assert.equal(totalCalls(jev, openai), 0);
  assert.equal(result.answers.visible?.status, "unsupported");
  assert.match(result.answers.visible?.abstainReason ?? "", /cannot be sent/);
});

test("image policy required with a text-only engine: JEV receives zero calls, and the image question is unsupported", async () => {
  const image: GateImage = { bytes: contractPngBytes(), evidenceName: "frame-0", label: "Frame at 0ms" };
  const { jev, openai, input } = baseInput({
    selection: selected("jev"),
    questions: [
      { key: "copy", spec: COPY_CHECK, needsImage: false, evidenceScope: ["copy"] },
      { key: "visible", spec: PRODUCT_VISIBLE, needsImage: true, evidenceScope: [IMAGE_SCOPE] },
    ],
    evidence: [COPY, FRAME],
    images: [image],
  });
  const result = await runEngineGate(input);
  assert.equal(openai.requests.length, 0);
  assert.equal(result.answers.visible?.status, "unsupported", "routed to review, never sent to a text-only route");
  // The text-only question still goes to JEV once, and it never carries the image.
  assert.equal(jev.requests.length, 1);
  assert.equal(jev.requests[0]!.images?.length ?? 0, 0, "no image bytes reach the text-only route");
  assert.deepEqual(Object.keys(jev.requests[0]!.questions), ["copy"]);
});

test("when the workspace engine cannot be read, no engine is called, the subject goes to review, and the record is still written", async () => {
  const jev = countingEngine("jev");
  const openai = countingEngine("openai-decisions");
  const recorder = recordingSql({ failEngineRead: true });
  const result = await runEngineGate({
    sql: recorder.sql,
    organizationId: "org-det",
    brandId: "brand-det",
    gate: "test_gate",
    subject: { type: "creative", id: "creative-det" },
    description: "Test creative.",
    questions: [{ key: "copy", spec: COPY_CHECK, needsImage: false, evidenceScope: ["copy"] }],
    evidence: [COPY],
    engines: { jev: jev.engine, "openai-decisions": openai.engine },
  });
  assert.equal(totalCalls(jev, openai), 0);
  assert.equal(result.action, "HUMAN_REVIEW");
  assert.equal(result.failureKind, "selection_unavailable");
  assert.match(result.reason, /could not be read, so no engine was called/);
  assert.equal(recorder.gateRecords().length, 1);
  assert.ok(result.gateRecordId);
});

test("when the decision record cannot be written, the decision still returns, with no record id, and no engine is retried", async () => {
  const { jev, input } = baseInput({ selection: selected("jev") });
  const failing = recordingSql({ failRecord: true });
  const result: GateResult = await runEngineGate({ ...input, sql: failing.sql });
  assert.equal(result.action, "AUTO_APPROVE", "the decision stands");
  assert.equal(result.gateRecordId, null, "the caller sees that no record was written");
  assert.equal(jev.requests.length, 1, "the engine was called once, not again to retry the write");
  assert.equal(failing.gateRecords().length, 0);
});

test("every path writes exactly one decision record, and each record carries the policy version", async () => {
  type Scenario = { name: string; overrides: Partial<Parameters<typeof runEngineGate>[0]> };
  const scenarios: Scenario[] = [
    { name: "deterministic rejection", overrides: { selection: selected("jev"), deterministicRejections: [{ rule: "r", reason: "x" }] } },
    { name: "no evidence scope", overrides: { selection: selected("jev"), questions: [{ key: "free", spec: NEEDS_NOTHING, needsImage: false }] } },
    { name: "no policy", overrides: { selection: selected("jev"), questions: [{ key: "u", spec: UNMAPPED, needsImage: false, evidenceScope: ["copy"] }] } },
    { name: "answered", overrides: { selection: selected("openai-decisions") } },
  ];
  for (const scenario of scenarios) {
    const { input, recorder } = baseInput(scenario.overrides);
    const result = await runEngineGate(input);
    const records = recorder.gateRecords();
    assert.equal(records.length, 1, `${scenario.name}: one record`);
    assert.ok(result.gateRecordId, `${scenario.name}: the result names its record`);
    assert.ok(records[0]!.values.some((value) => value === result.policyVersion || (typeof value === "string" && value.includes(result.policyVersion))), `${scenario.name}: the policy version is in the record`);
  }
});

test("policy versions are recorded: the result and the record name each gating question's id and version", async () => {
  const { input, recorder } = baseInput({
    selection: selected("jev"),
    questions: [
      { key: "copy", spec: COPY_CHECK, needsImage: false, evidenceScope: ["copy"] },
      { key: "free", spec: NEEDS_NOTHING, needsImage: false, evidenceScope: ["copy"] },
    ],
  });
  const result = await runEngineGate(input);
  assert.ok(result.policyVersion.includes("test.copy_check.v1@1.0.0"));
  assert.ok(result.policyVersion.includes("test.needs_nothing.v1@1.0.0"));
  assert.deepEqual(result.questionVersions.sort(), ["test.copy_check.v1@1.0.0", "test.needs_nothing.v1@1.0.0"]);
  assert.ok(recorder.gateRecords()[0]!.values.some((value) => typeof value === "string" && value.includes("test.copy_check.v1@1.0.0")));
});

test("a refused question is never sent, and a sent question is counted exactly once", async () => {
  const { jev, openai, input } = baseInput({
    selection: selected("jev"),
    questions: [
      { key: "copy", spec: COPY_CHECK, needsImage: false, evidenceScope: ["copy"] },
      { key: "free", spec: NEEDS_NOTHING, needsImage: false },
    ],
  });
  const result = await runEngineGate(input);
  assert.equal(openai.requests.length, 0);
  assert.equal(jev.requests.length, 1, "one engine call for the one question that was sent");
  assert.deepEqual(Object.keys(jev.requests[0]!.questions), ["copy"]);
  assert.equal(result.answers.free?.status, "abstain_insufficient_evidence");
});
