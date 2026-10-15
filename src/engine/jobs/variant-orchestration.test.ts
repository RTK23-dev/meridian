// The variant work list, through the orchestrator (Video Engine Bible 6.13, jobs/variant-runs.ts). The variants stage's request phase hands
// over the work list; the orchestrator queues each variant's writer, voice and plan jobs, then one produce job per shot the change makes
// again, then its checks. A variant fails alone: its dead job, its refused plan or its failed checks end that variant, never the request.
// Recorded results only: no provider is called.

import assert from "node:assert/strict";
import test from "node:test";
import { type GateId, type GateResult, type TakeVerdict } from "../contracts/index.ts";
import { FIXTURE_IDS, fixtureId } from "../contracts/fixtures/index.ts";
import { advance, orchestratorLimits, type OrchestratorState } from "./orchestrator.ts";
import type { EngineEvent, QueuedJob, ShotSummary, StageOutput } from "./types.ts";
import { variantShotSubjectOf, variantSubjectOf, type VariantWorkItem } from "../variants/work.ts";

const REQ = FIXTURE_IDS.request;
const ORG = "org_fixture";
const REQUEST_ART = fixtureId("art_", 40);
const RES = FIXTURE_IDS.reservation;
const SHOT_A = fixtureId("shot_", 51);
const SHOT_B = fixtureId("shot_", 52);
const TAKE_A1 = fixtureId("take_", 61);
const EDL_1 = fixtureId("edl_", 71);
const PLAN_ART = fixtureId("art_", 44);
const HOOK_KEY = "hook:1";
const HOOK_SUBJECT = variantSubjectOf(HOOK_KEY);
const PRODUCT_KEY = "product:SKU-2";
const PRODUCT_SUBJECT = variantSubjectOf(PRODUCT_KEY);

function gate(name: GateId, pass: boolean): GateResult {
  return {
    gate: name,
    subjectId: REQ,
    pass,
    checks: pass ? [{ rule: `${name}.ok`, pass: true, value: 1 }] : [{ rule: `${name}.broken`, pass: false }],
  };
}

function verdict(takeId: string, pass: boolean, action?: TakeVerdict["action"]): TakeVerdict {
  return {
    takeId,
    pass,
    confidence: 0.9,
    checks: pass ? [{ rule: "duration_within_10pct", pass: true, score: 1 }] : [{ rule: "slop.hands", pass: false, score: 0.4 }],
    action: action ?? (pass ? "accept" : "redo"),
  };
}

function shot(shotId: string): ShotSummary {
  return { shotId, visualType: "cinematic", downgradeTo: "product_hero", sourceKind: "generate", modelClass: "video.cinematic", takesWanted: 1 };
}

/** The work list item of a hook: its writer line, a full re-speak, and its one generated shot. */
function hookItem(): VariantWorkItem {
  return {
    key: HOOK_KEY,
    attribute: "hook",
    subject: HOOK_SUBJECT,
    change: { kind: "hook", index: 1 },
    writer: { kind: "lines", beatIds: ["b1"] },
    voiceBeatIds: ["b1", "b2"],
    produceShotIds: [SHOT_A],
  };
}

/** The work list item of a product: its prompts for the product shot, and no voice. */
function productItem(): VariantWorkItem {
  return {
    key: PRODUCT_KEY,
    attribute: "product",
    subject: PRODUCT_SUBJECT,
    change: { kind: "product", sku: "SKU-2" },
    writer: { kind: "product_prompts", shotIds: [SHOT_B] },
    voiceBeatIds: [],
    produceShotIds: [SHOT_B],
  };
}

class Flow {
  state: OrchestratorState | null = null;
  jobs: QueuedJob[] = [];
  effects: ReturnType<typeof advance>["effects"] = [];
  history: QueuedJob[] = [];

  apply(event: EngineEvent): this {
    const result = advance(this.state, event);
    this.state = result.state;
    this.jobs = result.jobs;
    this.effects = result.effects;
    this.history.push(...result.jobs);
    return this;
  }

  succeed(output: StageOutput): this {
    return this.apply({ type: "succeeded", output });
  }

  get current(): OrchestratorState {
    if (this.state === null) throw new Error("no state yet");
    return this.state;
  }

  jobsFor(stage: string): QueuedJob[] {
    return this.jobs.filter((job) => job.stage === stage);
  }
}

/** The request through to the edit, with one generated shot and one take that passed; the master's branch then passes to delivery. */
function flowToMasterPassed(variantCount: number): Flow {
  const flow = new Flow().apply({
    type: "start",
    organizationId: ORG,
    requestId: REQ,
    priority: "normal",
    cachedDna: false,
    variantCount,
    requestArtifactId: REQUEST_ART,
  });
  flow.succeed({ stage: "intake", subjectId: REQ, gate: gate("request", true), budgetReservationId: RES, budgetPause: null, artifacts: { validated: fixtureId("art_", 41) } });
  flow.succeed({ stage: "analyze_reference", subjectId: REQ, gate: gate("dna", true), artifacts: { dna: fixtureId("art_", 42) } });
  flow.succeed({ stage: "voice", subjectId: REQ, gate: gate("voice", true), artifacts: { voice: fixtureId("art_", 43) } });
  flow.succeed({ stage: "plan", subjectId: REQ, gate: gate("plan", true), shots: [shot(SHOT_A), shot(SHOT_B)], artifacts: { plan: PLAN_ART } });
  flow.succeed({ stage: "estimate_reserve", subjectId: REQ, gate: gate("budget", true), budgetReservationId: RES, artifacts: {} });
  flow.succeed({ stage: "produce_shot", epoch: 0, subjectId: SHOT_A, shotId: SHOT_A, takeId: TAKE_A1, artifacts: { [`take:${TAKE_A1}`]: fixtureId("art_", 81) } });
  flow.succeed({ stage: "check_take", subjectId: TAKE_A1, shotId: SHOT_A, takeId: TAKE_A1, gate: gate("take", true), verdict: verdict(TAKE_A1, true), artifacts: {} });
  flow.succeed({ stage: "produce_shot", epoch: 0, subjectId: SHOT_B, shotId: SHOT_B, takeId: fixtureId("take_", 62), artifacts: { [`take:${fixtureId("take_", 62)}`]: fixtureId("art_", 82) } });
  flow.succeed({ stage: "check_take", subjectId: fixtureId("take_", 62), shotId: SHOT_B, takeId: fixtureId("take_", 62), gate: gate("take", true), verdict: verdict(fixtureId("take_", 62), true), artifacts: {} });
  flow.succeed({ stage: "edit", subjectId: REQ, gate: gate("edit", true), edlId: EDL_1, artifacts: { [`edl:${EDL_1}`]: fixtureId("art_", 111) } });
  flow.succeed({ stage: "compose", subjectId: EDL_1, edlId: EDL_1, artifacts: { [`composition:${EDL_1}`]: fixtureId("art_", 112) } });
  flow.succeed({ stage: "pre_render_gate", subjectId: EDL_1, edlId: EDL_1, gate: gate("pre_render", true), artifacts: {} });
  flow.succeed({ stage: "render", subjectId: EDL_1, edlId: EDL_1, gate: gate("render_integrity", true), artifacts: { [`render:${EDL_1}`]: fixtureId("art_", 113) } });
  flow.succeed({ stage: "post_render_review", subjectId: EDL_1, edlId: EDL_1, gate: gate("post_render", true), artifacts: {} });
  return flow;
}

/** The variants stage's request phase with the given work list. */
function requestPhase(flow: Flow, work: VariantWorkItem[]): Flow {
  return flow.succeed({ stage: "variants", phase: "request", subjectId: REQ, work, variants: [], artifacts: {} });
}

/** The phase outputs of a hook, as the phase jobs return them. */
function writerDone(key: string, subject: string): StageOutput {
  return { stage: "variants", phase: "writer", subjectId: subject, key, artifacts: {}, outcome: { status: "done", text: { kind: "lines", lines: [{ beatId: "b1", text: "A new line." }] } } };
}

function voiceDone(key: string, subject: string): StageOutput {
  return {
    stage: "variants",
    phase: "voice",
    subjectId: subject,
    key,
    artifacts: { [`voice:${key}`]: fixtureId("art_", 140) },
    outcome: { status: "done", voiceTrackId: "vtk_variant", artifacts: { [`voice:${key}`]: fixtureId("art_", 140) } },
  };
}

function planDone(key: string, subject: string, produce: ShotSummary[]): StageOutput {
  return {
    stage: "variants",
    phase: "plan",
    subjectId: subject,
    key,
    artifacts: { [`plan:${key}`]: fixtureId("art_", 141) },
    outcome: { status: "done", artifacts: { [`plan:${key}`]: fixtureId("art_", 141) }, produce },
  };
}

test("a hook variant queues one writer call, then its voice, then its plan, and nothing else before the plan", () => {
  const flow = requestPhase(flowToMasterPassed(1), [hookItem()]);
  assert.deepEqual(flow.jobs.map((job) => [job.stage, job.subjectId, job.payload.details.phase]), [["variants", HOOK_SUBJECT, "writer"]]);
  assert.deepEqual(flow.jobs[0]?.payload.inputArtifactIds.sort(), [REQUEST_ART, PLAN_ART].sort(), "the writer reads the request and the master plan");

  flow.succeed(writerDone(HOOK_KEY, HOOK_SUBJECT));
  assert.deepEqual(flow.jobs.map((job) => job.payload.details.phase), ["voice"]);
  assert.deepEqual(flow.jobs[0]?.payload.details.text, { kind: "lines", lines: [{ beatId: "b1", text: "A new line." }] }, "the voice gets the writer's line");

  flow.succeed(voiceDone(HOOK_KEY, HOOK_SUBJECT));
  assert.deepEqual(flow.jobs.map((job) => job.payload.details.phase), ["plan"]);
  assert.equal(flow.jobs[0]?.payload.details.voiceTrackId, "vtk_variant", "the plan names the variant's voice track");
  assert.equal(flow.jobsFor("produce_shot").length, 0, "no produce job until the plan is made");
});

test("a hook variant produces its hook shot only, with its own subject and its own plan, not the master's", () => {
  const flow = requestPhase(flowToMasterPassed(1), [hookItem()]);
  flow.succeed(writerDone(HOOK_KEY, HOOK_SUBJECT));
  flow.succeed(voiceDone(HOOK_KEY, HOOK_SUBJECT));
  flow.succeed(planDone(HOOK_KEY, HOOK_SUBJECT, [shot(SHOT_A)]));

  const produce = flow.jobsFor("produce_shot");
  assert.equal(produce.length, 1, "one produce job for the one shot");
  assert.equal(produce[0]?.subjectId, variantShotSubjectOf(HOOK_SUBJECT, SHOT_A));
  assert.equal(produce[0]?.payload.details.shotId, SHOT_A);
  assert.deepEqual(produce[0]?.payload.inputArtifactIds, [fixtureId("art_", 141)], "it reads the variant's plan, not the master's");
  assert.notEqual(produce[0]?.key, flow.history.find((job) => job.stage === "produce_shot" && job.subjectId === SHOT_A)?.key);
  assert.equal(flow.current.artifacts[`plan:${HOOK_KEY}`], undefined, "the variant's plan is not a request artifact");
});

test("a product variant writes its prompts, plans, and produces its product shot only", () => {
  const flow = requestPhase(flowToMasterPassed(1), [productItem()]);
  assert.deepEqual(flow.jobs.map((job) => job.payload.details.phase), ["writer"]);
  flow.succeed({
    stage: "variants",
    phase: "writer",
    subjectId: PRODUCT_SUBJECT,
    key: PRODUCT_KEY,
    artifacts: {},
    outcome: { status: "done", text: { kind: "prompts", prompts: [{ shotId: SHOT_B, text: "The Corner Toaster, warm light." }] } },
  });
  assert.deepEqual(flow.jobs.map((job) => job.payload.details.phase), ["plan"], "a product variant speaks nothing");
  flow.succeed(planDone(PRODUCT_KEY, PRODUCT_SUBJECT, [shot(SHOT_B)]));
  assert.deepEqual(flow.jobsFor("produce_shot").map((job) => job.payload.details.shotId), [SHOT_B]);
  assert.equal(flow.history.filter((job) => job.stage === "variants" && job.payload.details.phase === "voice").length, 0);
});

test("a variant whose writer is not built fails alone: no voice or plan job, and the request still delivers", () => {
  const flow = requestPhase(flowToMasterPassed(2), [hookItem()]);
  flow.succeed({ stage: "variants", phase: "writer", subjectId: HOOK_SUBJECT, key: HOOK_KEY, artifacts: {}, outcome: { status: "not_built", reason: "the writer's route is not connected" } });
  assert.equal(flow.current.status, "running", "the request is not paused");
  assert.equal(flow.history.filter((job) => job.subjectId === HOOK_SUBJECT && job.payload.details.phase !== "writer").length, 0);
  assert.equal(flow.jobsFor("deliver").length, 1, "delivery is not held up by a variant that could not be built");
  assert.ok(flow.effects.some((effect) => effect.kind === "decision" && effect.decision.chose === "failed" && /not connected/.test(effect.decision.reason)));
});

test("a plan that names other shots than the variant's change fails that variant alone", () => {
  const flow = requestPhase(flowToMasterPassed(1), [hookItem()]);
  flow.succeed(writerDone(HOOK_KEY, HOOK_SUBJECT));
  flow.succeed(voiceDone(HOOK_KEY, HOOK_SUBJECT));
  flow.succeed(planDone(HOOK_KEY, HOOK_SUBJECT, [shot(SHOT_B)]));
  assert.equal(flow.jobsFor("produce_shot").length, 0);
  assert.equal(flow.jobsFor("deliver").length, 1);
  assert.ok(flow.effects.some((effect) => effect.kind === "decision" && /does not name the shots/.test(effect.decision.reason)));
});

test("a dead produce job of a variant fails that variant alone: the request keeps running and delivers", () => {
  const flow = requestPhase(flowToMasterPassed(1), [hookItem()]);
  flow.succeed(writerDone(HOOK_KEY, HOOK_SUBJECT));
  flow.succeed(voiceDone(HOOK_KEY, HOOK_SUBJECT));
  flow.succeed(planDone(HOOK_KEY, HOOK_SUBJECT, [shot(SHOT_A)]));
  const subject = variantShotSubjectOf(HOOK_SUBJECT, SHOT_A);
  flow.apply({ type: "dead", stage: "produce_shot", subjectId: subject, reason: "provider timed out" });
  assert.equal(flow.current.status, "running", "the request is not paused by a variant's dead job");
  assert.equal(flow.current.pause, null);
  assert.equal(flow.jobsFor("deliver").length, 1);
  assert.ok(flow.effects.some((effect) => effect.kind === "decision" && effect.decision.chose === "failed"));
});

test("a variant's produced takes are checked, and the variant is produced once every shot passes its check", () => {
  const flow = requestPhase(flowToMasterPassed(1), [hookItem()]);
  flow.succeed(writerDone(HOOK_KEY, HOOK_SUBJECT));
  flow.succeed(voiceDone(HOOK_KEY, HOOK_SUBJECT));
  flow.succeed(planDone(HOOK_KEY, HOOK_SUBJECT, [shot(SHOT_A)]));
  const subject = variantShotSubjectOf(HOOK_SUBJECT, SHOT_A);
  const take = fixtureId("take_", 91);
  flow.succeed({ stage: "produce_shot", epoch: 0, subjectId: subject, shotId: SHOT_A, takeId: take, artifacts: { [`take:${take}`]: fixtureId("art_", 92) } });

  const check = flow.jobsFor("check_take");
  assert.equal(check.length, 1);
  assert.equal(check[0]?.subjectId, take);
  assert.deepEqual(check[0]?.payload.inputArtifactIds.sort(), [fixtureId("art_", 92), fixtureId("art_", 141)].sort(), "the check reads the take and the variant's plan");
  assert.equal(flow.jobsFor("deliver").length, 0, "delivery waits for the variant's run to end");

  flow.succeed({ stage: "check_take", subjectId: take, shotId: SHOT_A, takeId: take, gate: gate("take", true), verdict: verdict(take, true), artifacts: { [`verdict:${take}`]: fixtureId("art_", 93) } });
  assert.ok(flow.effects.some((effect) => effect.kind === "decision" && effect.decision.chose === "produced" && effect.decision.at === `variant:${HOOK_KEY}`));
  assert.equal(flow.jobsFor("deliver").length, 1, "delivery is queued once the variant is produced");
});

test("a failed take is produced again with the failed rules as hints, and after the redos the variant fails", () => {
  const flow = requestPhase(flowToMasterPassed(1), [hookItem()]);
  flow.succeed(writerDone(HOOK_KEY, HOOK_SUBJECT));
  flow.succeed(voiceDone(HOOK_KEY, HOOK_SUBJECT));
  flow.succeed(planDone(HOOK_KEY, HOOK_SUBJECT, [shot(SHOT_A)]));
  const subject = variantShotSubjectOf(HOOK_SUBJECT, SHOT_A);
  for (let round = 0; round <= orchestratorLimits.shotRedos; round += 1) {
    const take = fixtureId("take_", 100 + round);
    const produce = flow.jobsFor("produce_shot");
    assert.equal(produce.length, 1, `round ${round} has one produce job`);
    if (round > 0) assert.deepEqual(produce[0]?.payload.hints, ["slop.hands"], "the redo carries the failed rule as a hint");
    flow.succeed({ stage: "produce_shot", epoch: 0, subjectId: subject, shotId: SHOT_A, takeId: take, artifacts: { [`take:${take}`]: fixtureId("art_", 110 + round) } });
    flow.succeed({ stage: "check_take", subjectId: take, shotId: SHOT_A, takeId: take, gate: gate("take", false), verdict: verdict(take, false), artifacts: {} });
  }
  assert.equal(flow.jobsFor("produce_shot").length, 0, "no further produce job after the redos");
  const redoText = `after ${orchestratorLimits.shotRedos} redos`;
  assert.ok(flow.effects.some((effect) => effect.kind === "decision" && effect.decision.chose === "failed" && effect.decision.reason.includes(redoText)));
  assert.equal(flow.jobsFor("deliver").length, 1);
});

test("an escalated take fails its variant: a variant does not wait for a human choice", () => {
  const flow = requestPhase(flowToMasterPassed(1), [hookItem()]);
  flow.succeed(writerDone(HOOK_KEY, HOOK_SUBJECT));
  flow.succeed(voiceDone(HOOK_KEY, HOOK_SUBJECT));
  flow.succeed(planDone(HOOK_KEY, HOOK_SUBJECT, [shot(SHOT_A)]));
  const subject = variantShotSubjectOf(HOOK_SUBJECT, SHOT_A);
  const take = fixtureId("take_", 120);
  flow.succeed({ stage: "produce_shot", epoch: 0, subjectId: subject, shotId: SHOT_A, takeId: take, artifacts: { [`take:${take}`]: fixtureId("art_", 121) } });
  flow.succeed({ stage: "check_take", subjectId: take, shotId: SHOT_A, takeId: take, gate: gate("take", false), verdict: verdict(take, false, "escalate"), artifacts: {} });
  assert.equal(flow.current.status, "running");
  assert.ok(flow.effects.some((effect) => effect.kind === "decision" && /escalated/.test(effect.decision.reason)));
  assert.equal(flow.effects.filter((effect) => effect.kind === "review_item").length, 0, "no review item is opened for a variant");
});

test("a caption-free matrix with no generation work queues no variant job at all", () => {
  const flow = requestPhase(flowToMasterPassed(1), []);
  assert.equal(flow.jobsFor("variants").length, 0);
  assert.equal(flow.jobsFor("deliver").length, 1);
});

test("two variants with the same key are refused, and nothing is queued for the second", () => {
  const flow = flowToMasterPassed(2);
  assert.throws(() => requestPhase(flow, [hookItem(), hookItem()]), /already in the variant work list/);
});
