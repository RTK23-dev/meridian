import assert from "node:assert/strict";
import test from "node:test";
import { EngineError, type GateId, type GateResult, type TakeVerdict } from "../contracts/index.ts";
import { FIXTURE_IDS, fixtureId } from "../contracts/fixtures/index.ts";
import { advance, orchestratorLimits, type OrchestratorState } from "./orchestrator.ts";
import type { EngineEvent, QueuedJob, ShotSummary, StageOutput } from "./types.ts";
import type { GoldMetrics } from "../review/gold.ts";

/** Gold metrics that meet the target (Bible 12.4): the named checks may block. Their keys are "gate:rule" (gold.ts checkKey). */
function provenFor(keys: string[]): Record<string, GoldMetrics> {
  const proven: GoldMetrics = {
    total: 200,
    failLabels: 100,
    passLabels: 100,
    caughtFailures: 95,
    falseFails: 5,
    recall: 0.95,
    falseFailRate: 0.05,
    enoughLabels: true,
    meetsTarget: true,
  };
  return Object.fromEntries(keys.map((key) => [key, proven]));
}

/** The check keys the gate() helper's failing checks carry, by gate. */
const BROKEN = (gateName: GateId): string => `${gateName}:${gateName}.broken`;

const REQ = FIXTURE_IDS.request;
const ORG = "org_fixture";
const REQUEST_ART = fixtureId("art_", 40);
const RES = FIXTURE_IDS.reservation;
const SHOT_A = fixtureId("shot_", 51);
const SHOT_B = fixtureId("shot_", 52);
const SHOT_C = fixtureId("shot_", 53);
const SHOT_D = fixtureId("shot_", 54);
const TAKE_A1 = fixtureId("take_", 61);
const TAKE_A2 = fixtureId("take_", 62);
const TAKE_A3 = fixtureId("take_", 63);
const EDL_1 = fixtureId("edl_", 71);
const EDL_2 = fixtureId("edl_", 72);

function gate(name: GateId, pass: boolean, failingShotIds?: string[]): GateResult {
  return {
    gate: name,
    subjectId: REQ,
    pass,
    checks: pass
      ? [{ rule: `${name}.ok`, pass: true, value: 1 }]
      : [{ rule: `${name}.broken`, pass: false, detail: "free text from a check" }],
    ...(failingShotIds ? { failingShotIds } : {}),
  };
}

function verdict(takeId: string, pass: boolean, confidence = 0.9, action?: TakeVerdict["action"]): TakeVerdict {
  return {
    takeId,
    pass,
    confidence,
    checks: pass
      ? [{ rule: "duration_within_10pct", pass: true, score: 1 }]
      : [{ rule: "slop.hands", pass: false, score: 0.41, detail: "model prose about fingers" }],
    action: action ?? (pass ? "accept" : "redo"),
  };
}

function start(overrides: Partial<Extract<EngineEvent, { type: "start" }>> = {}): EngineEvent {
  return {
    type: "start",
    organizationId: ORG,
    requestId: REQ,
    priority: "normal",
    cachedDna: false,
    variantCount: 0,
    requestArtifactId: REQUEST_ART,
    ...overrides,
  };
}

function shot(overrides: Partial<ShotSummary> & { shotId: string }): ShotSummary {
  return {
    visualType: "cinematic",
    downgradeTo: "product_hero",
    sourceKind: "generate",
    modelClass: "video.cinematic",
    takesWanted: 1,
    ...overrides,
  };
}

/** A small driver: applies events one by one and keeps the last result. */
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

  dead(stage: "produce_shot", subjectId: string): this {
    return this.apply({ type: "dead", stage, subjectId, reason: "provider timed out" });
  }

  get current(): OrchestratorState {
    if (this.state === null) throw new Error("no state yet");
    return this.state;
  }

  jobsFor(stage: string): QueuedJob[] {
    return this.jobs.filter((job) => job.stage === stage);
  }
}

/** Runs the single-node stages through estimate with the given plan shots, leaving produce jobs waiting. */
function flowToProduce(shots: ShotSummary[], options: { cachedDna?: boolean; variantCount?: number; gateMetrics?: Record<string, GoldMetrics> } = {}): Flow {
  const flow = new Flow().apply(
    start({
      cachedDna: options.cachedDna ?? false,
      variantCount: options.variantCount ?? 0,
      ...(options.gateMetrics ? { gateMetrics: options.gateMetrics } : {}),
    }),
  );
  flow.succeed({ stage: "intake", subjectId: REQ, gate: gate("request", true), budgetReservationId: RES, budgetPause: null, artifacts: { validated: fixtureId("art_", 41) } });
  if (!options.cachedDna) flow.succeed({ stage: "analyze_reference", subjectId: REQ, gate: gate("dna", true), artifacts: { dna: fixtureId("art_", 42) } });
  flow.succeed({ stage: "voice", subjectId: REQ, gate: gate("voice", true), artifacts: { voice: fixtureId("art_", 43) } });
  flow.succeed({ stage: "plan", subjectId: REQ, gate: gate("plan", true), shots, artifacts: { plan: fixtureId("art_", 44) } });
  flow.succeed({ stage: "estimate_reserve", subjectId: REQ, gate: gate("budget", true), budgetReservationId: RES, artifacts: {} });
  return flow;
}

test("start queues only the intake job, keyed by its request, at the normal priority", () => {
  const flow = new Flow().apply(start());
  assert.equal(flow.jobs.length, 1);
  const [job] = flow.jobs;
  assert.ok(job);
  assert.equal(job.stage, "intake");
  assert.equal(job.key, `engine:${REQ}:intake:${REQ}:1`);
  assert.equal(job.priority, 100);
  assert.equal(job.paid, false);
  assert.equal(job.maxAttempts, 3);
  assert.deepEqual(job.payload.inputArtifactIds, [REQUEST_ART]);
  assert.equal(job.payload.organizationId, ORG);
  assert.equal(job.payload.budgetReservationId, null);
});

test("rush and batch requests carry the priority numbers that run them first and last", () => {
  const rush = new Flow().apply(start({ priority: "rush" })).jobs[0];
  const batch = new Flow().apply(start({ priority: "batch" })).jobs[0];
  assert.equal(rush?.priority, 10);
  assert.equal(batch?.priority, 1000);
  assert.ok((rush?.priority ?? 0) < 100 && 100 < (batch?.priority ?? 0));
});

test("a passing intake with a reservation queues analysis and voice together, both paid and on the reservation", () => {
  const flow = new Flow().apply(start());
  const [intake] = flow.jobs;
  flow.succeed({ stage: "intake", subjectId: REQ, gate: gate("request", true), budgetReservationId: RES, budgetPause: null, artifacts: { validated: fixtureId("art_", 41) } });
  assert.deepEqual(flow.jobs.map((job) => job.stage).sort(), ["analyze_reference", "voice"]);
  for (const job of flow.jobs) {
    assert.equal(job.paid, true);
    assert.equal(job.payload.budgetReservationId, RES);
    assert.equal(job.attempt, "1");
  }
  assert.ok(intake);
});

test("a cached VideoDNA skips analysis and queues only voice", () => {
  const dna = fixtureId("art_", 45);
  const flow = new Flow().apply(start({ cachedDna: true, cachedDnaArtifactId: dna }));
  flow.succeed({ stage: "intake", subjectId: REQ, gate: gate("request", true), budgetReservationId: RES, budgetPause: null, artifacts: {} });
  assert.deepEqual(flow.jobs.map((job) => job.stage), ["voice"]);
  assert.equal(flow.current.artifacts.dna, dna);
});

test("a failing intake rejects the request with its reasons and queues nothing", () => {
  const flow = new Flow().apply(start());
  flow.succeed({ stage: "intake", subjectId: REQ, gate: gate("request", false), budgetReservationId: null, budgetPause: null, artifacts: {} });
  assert.equal(flow.current.status, "rejected");
  assert.equal(flow.jobs.length, 0);
  const rejected = flow.effects.find((effect) => effect.kind === "rejected");
  assert.ok(rejected && rejected.kind === "rejected");
  assert.match(rejected.reasons[0] ?? "", /request\.broken: free text from a check/);
});

test("a passing intake advances without a reservation: intake is passed, and no intake pause is set", () => {
  const flow = new Flow().apply(start());
  flow.succeed({ stage: "intake", subjectId: REQ, gate: gate("request", true), budgetReservationId: null, budgetPause: null, artifacts: {} });
  assert.equal(flow.current.nodes.intake.status, "passed");
  assert.equal(flow.current.budgetReservationId, null, "intake holds nothing");
  assert.notEqual(flow.current.pause?.stage, "intake");
});

test("a passing intake with no reservation pauses on the first paid stage, which is named, and queues no paid job (fail closed)", () => {
  const flow = new Flow().apply(start());
  flow.succeed({ stage: "intake", subjectId: REQ, gate: gate("request", true), budgetReservationId: null, budgetPause: null, artifacts: {} });
  assert.equal(flow.current.status, "paused");
  assert.equal(flow.current.pause?.kind, "budget");
  assert.equal(flow.current.pause?.stage, "analyze_reference", "analysis is the first paid stage");
  assert.match(flow.current.pause?.reason ?? "", /analyze_reference is a paid stage and needs a budget reservation/);
  assert.equal(flow.jobs.length, 0);
  assert.equal(flow.history.filter((job) => job.paid).length, 0, "no paid job was ever queued");
});

test("with a cached VideoDNA and no reservation, voice is the paid stage that waits, and it is named", () => {
  const flow = new Flow().apply(start({ cachedDna: true, cachedDnaArtifactId: fixtureId("art_", 45) }));
  flow.succeed({ stage: "intake", subjectId: REQ, gate: gate("request", true), budgetReservationId: null, budgetPause: null, artifacts: {} });
  assert.equal(flow.current.status, "paused");
  assert.equal(flow.current.pause?.stage, "voice");
  assert.equal(flow.jobs.length, 0);
});

test("a reservation that analysis and voice need is accepted from intake: they queue on it, and the plan waits for both", () => {
  const flow = new Flow().apply(start());
  flow.succeed({ stage: "intake", subjectId: REQ, gate: gate("request", true), budgetReservationId: RES, budgetPause: null, artifacts: {} });
  assert.equal(flow.current.status, "running");
  assert.deepEqual(flow.jobs.map((job) => job.stage).sort(), ["analyze_reference", "voice"]);
  assert.equal(flow.current.budgetReservationId, RES);
});

test("estimate_reserve is queued with the plan and the request artifacts, so it can read the request budget", () => {
  const flow = new Flow().apply(start());
  flow.succeed({ stage: "intake", subjectId: REQ, gate: gate("request", true), budgetReservationId: RES, budgetPause: null, artifacts: {} });
  flow.succeed({ stage: "analyze_reference", subjectId: REQ, gate: gate("dna", true), artifacts: { dna: fixtureId("art_", 42) } });
  flow.succeed({ stage: "voice", subjectId: REQ, gate: gate("voice", true), artifacts: { voice: fixtureId("art_", 43) } });
  flow.succeed({ stage: "plan", subjectId: REQ, gate: gate("plan", true), shots: [shot({ shotId: SHOT_A, sourceKind: "component", modelClass: null, visualType: "coded_graphics", downgradeTo: null })], artifacts: { plan: fixtureId("art_", 44) } });
  const [estimate] = flow.jobsFor("estimate_reserve");
  assert.ok(estimate, "estimate_reserve is queued once the plan passes");
  assert.deepEqual(estimate.payload.inputArtifactIds.slice().sort(), [fixtureId("art_", 44), REQUEST_ART].sort());
  assert.equal(estimate.paid, false);
});

test("plan waits for both analysis and voice, whichever finishes first", () => {
  const flow = new Flow().apply(start());
  flow.succeed({ stage: "intake", subjectId: REQ, gate: gate("request", true), budgetReservationId: RES, budgetPause: null, artifacts: {} });
  flow.succeed({ stage: "voice", subjectId: REQ, gate: gate("voice", true), artifacts: { voice: fixtureId("art_", 43) } });
  assert.equal(flow.jobs.length, 0, "plan is not queued with analysis still running");
  flow.succeed({ stage: "analyze_reference", subjectId: REQ, gate: gate("dna", true), artifacts: { dna: fixtureId("art_", 42) } });
  assert.deepEqual(flow.jobs.map((job) => job.stage), ["plan"]);
  assert.deepEqual(flow.jobs[0]?.payload.inputArtifactIds.length, 2, "plan reads the DNA and the voice track it was given");
});

test("a failing DNA gate redoes analysis once with a hint, then escalates the request", () => {
  const flow = new Flow().apply(start());
  flow.succeed({ stage: "intake", subjectId: REQ, gate: gate("request", true), budgetReservationId: RES, budgetPause: null, artifacts: {} });
  flow.succeed({ stage: "analyze_reference", subjectId: REQ, gate: gate("dna", false), artifacts: {} });
  const [redo] = flow.jobsFor("analyze_reference");
  assert.equal(redo?.attempt, "2");
  assert.equal(redo?.key, `engine:${REQ}:analyze_reference:${REQ}:2`);
  assert.equal(flow.current.status, "running");

  flow.succeed({ stage: "analyze_reference", subjectId: REQ, gate: gate("dna", false), artifacts: {} });
  assert.equal(flow.current.status, "paused");
  assert.equal(flow.current.pause?.kind, "escalation");
  assert.ok(flow.effects.some((effect) => effect.kind === "review_item" && effect.reviewKind === "escalation"));
  assert.equal(flow.jobs.length, 0);
});

test("a plan that fails validation twice escalates (Bible 6.4)", () => {
  assert.equal(orchestratorLimits.planRedos, 1);
  const flow = new Flow().apply(start());
  flow.succeed({ stage: "intake", subjectId: REQ, gate: gate("request", true), budgetReservationId: RES, budgetPause: null, artifacts: {} });
  flow.succeed({ stage: "analyze_reference", subjectId: REQ, gate: gate("dna", true), artifacts: {} });
  flow.succeed({ stage: "voice", subjectId: REQ, gate: gate("voice", true), artifacts: {} });
  flow.succeed({ stage: "plan", subjectId: REQ, gate: gate("plan", false), shots: [], artifacts: {} });
  assert.equal(flow.jobsFor("plan")[0]?.attempt, "2");
  flow.succeed({ stage: "plan", subjectId: REQ, gate: gate("plan", false), shots: [], artifacts: {} });
  assert.equal(flow.current.pause?.kind, "escalation");
});

test("an over-budget reservation pauses the request rather than failing it", () => {
  const flow = new Flow().apply(start());
  flow.succeed({ stage: "intake", subjectId: REQ, gate: gate("request", true), budgetReservationId: RES, budgetPause: null, artifacts: {} });
  flow.succeed({ stage: "analyze_reference", subjectId: REQ, gate: gate("dna", true), artifacts: {} });
  flow.succeed({ stage: "voice", subjectId: REQ, gate: gate("voice", true), artifacts: {} });
  flow.succeed({ stage: "plan", subjectId: REQ, gate: gate("plan", true), shots: [shot({ shotId: SHOT_A })], artifacts: {} });
  flow.succeed({ stage: "estimate_reserve", subjectId: REQ, gate: gate("budget", false), budgetReservationId: null, artifacts: {} });
  assert.equal(flow.current.status, "paused");
  assert.equal(flow.current.pause?.kind, "budget");
  assert.equal(flow.jobs.length, 0);
});

test("each shot gets its own produce job; components and assets need none, and the produce job reads only the plan", () => {
  const flow = flowToProduce([
    shot({ shotId: SHOT_A, sourceKind: "generate" }),
    shot({ shotId: SHOT_B, sourceKind: "component", modelClass: null, visualType: "coded_graphics", downgradeTo: null }),
    shot({ shotId: SHOT_C, sourceKind: "stock", modelClass: null, visualType: "stock_footage", downgradeTo: null }),
    shot({ shotId: SHOT_D, sourceKind: "asset", modelClass: null, visualType: "product_hero", downgradeTo: null }),
  ]);
  const produce = flow.jobsFor("produce_shot");
  assert.deepEqual(produce.map((job) => job.subjectId).sort(), [SHOT_A, SHOT_C].sort());
  for (const job of produce) {
    assert.equal(job.paid, true);
    assert.equal(job.payload.inputArtifactIds.length, 1);
  }
  assert.equal(flow.current.shots[SHOT_B]?.status, "accepted");
  assert.equal(flow.current.shots[SHOT_D]?.status, "accepted");
  assert.equal(flow.jobsFor("edit").length, 0, "edit waits for the generated shots");
  const providerKeys = produce.map((job) => job.payload.details.providerKey).sort();
  assert.deepEqual(providerKeys, ["stock", "video"]);
});

test("a shot with two takes queues two produce jobs with distinct attempts, then accepts the best passing one", () => {
  const flow = flowToProduce([shot({ shotId: SHOT_A, takesWanted: 2, downgradeTo: null })]);
  assert.deepEqual(flow.jobsFor("produce_shot").map((job) => job.attempt), ["1", "2"]);
  flow.succeed({ stage: "produce_shot", epoch: 0, subjectId: SHOT_A, shotId: SHOT_A, takeId: TAKE_A1, artifacts: { [`take:${TAKE_A1}`]: fixtureId("art_", 81) } });
  assert.deepEqual(flow.jobsFor("check_take").map((job) => job.subjectId), [TAKE_A1]);
  flow.succeed({ stage: "produce_shot", epoch: 0, subjectId: SHOT_A, shotId: SHOT_A, takeId: TAKE_A2, artifacts: { [`take:${TAKE_A2}`]: fixtureId("art_", 82) } });
  assert.deepEqual(flow.jobsFor("check_take").map((job) => job.subjectId), [TAKE_A2]);
  flow.succeed({ stage: "check_take", subjectId: TAKE_A1, shotId: SHOT_A, takeId: TAKE_A1, gate: gate("take", false), verdict: verdict(TAKE_A1, false), artifacts: {} });
  assert.equal(flow.current.shots[SHOT_A]?.status, "pending", "the round waits for the second take");
  flow.succeed({ stage: "check_take", subjectId: TAKE_A2, shotId: SHOT_A, takeId: TAKE_A2, gate: gate("take", true), verdict: verdict(TAKE_A2, true, 0.8), artifacts: {} });
  assert.equal(flow.current.shots[SHOT_A]?.acceptedTakeId, TAKE_A2);
  assert.equal(flow.current.shots[SHOT_A]?.status, "accepted");
});

test("a failing take is redone with the failing rule names as hints, and the redo is a new attempt", () => {
  const flow = flowToProduce([shot({ shotId: SHOT_A, downgradeTo: null })]);
  flow.succeed({ stage: "produce_shot", epoch: 0, subjectId: SHOT_A, shotId: SHOT_A, takeId: TAKE_A1, artifacts: { [`take:${TAKE_A1}`]: fixtureId("art_", 81) } });
  flow.succeed({ stage: "check_take", subjectId: TAKE_A1, shotId: SHOT_A, takeId: TAKE_A1, gate: gate("take", false), verdict: verdict(TAKE_A1, false), artifacts: {} });
  const [redo] = flow.jobsFor("produce_shot");
  assert.equal(redo?.attempt, "2");
  assert.deepEqual(redo?.payload.hints, ["slop.hands"], "hints are rule names only, never model prose");
  assert.equal(flow.current.shots[SHOT_A]?.round, 1);
});

test("after two failed redos a shot downgrades to its downgradeTo type, logs a decision and replans only that shot", () => {
  const flow = flowToProduce([shot({ shotId: SHOT_A, downgradeTo: "product_hero" })]);
  for (let round = 0; round < 3; round += 1) {
    const takeId = [TAKE_A1, TAKE_A2, TAKE_A3][round] ?? TAKE_A1;
    flow.succeed({ stage: "produce_shot", epoch: 0, subjectId: SHOT_A, shotId: SHOT_A, takeId, artifacts: { [`take:${takeId}`]: fixtureId("art_", 81 + round) } });
    flow.succeed({ stage: "check_take", subjectId: takeId, shotId: SHOT_A, takeId, gate: gate("take", false), verdict: verdict(takeId, false), artifacts: {} });
  }
  assert.equal(flow.current.shots[SHOT_A]?.status, "replanning");
  const decision = flow.effects.find((effect) => effect.kind === "decision");
  assert.ok(decision && decision.kind === "decision");
  assert.equal(decision.decision.chose, "product_hero");
  assert.equal(decision.decision.by, "scorer");
  const [replan] = flow.jobsFor("plan");
  assert.equal(replan?.subjectId, SHOT_A);
  assert.equal(replan?.payload.details.directive, "downgrade");
  assert.equal(flow.jobsFor("produce_shot").length, 0, "no produce job until the replan returns");

  flow.succeed({
    stage: "plan",
    subjectId: SHOT_A,
    gate: gate("plan", true),
    shots: [shot({ shotId: SHOT_A, visualType: "product_hero", downgradeTo: null, sourceKind: "generate", modelClass: "video.i2v_pinned" })],
    artifacts: { plan: fixtureId("art_", 91) },
  });
  assert.equal(flow.current.shots[SHOT_A]?.visualType, "product_hero");
  assert.equal(flow.current.shots[SHOT_A]?.status, "pending");
  assert.equal(flow.current.shots[SHOT_A]?.round, 0);
  assert.equal(flow.jobsFor("produce_shot").length, 1, "the downgraded shot is produced again");
});

test("a downgrade replan that fails its gate escalates, and resume runs the replan again instead of stalling", () => {
  const flow = flowToProduce([shot({ shotId: SHOT_A, downgradeTo: "product_hero" })]);
  for (let round = 0; round < 3; round += 1) {
    const takeId = [TAKE_A1, TAKE_A2, TAKE_A3][round] ?? TAKE_A1;
    flow.succeed({ stage: "produce_shot", epoch: 0, subjectId: SHOT_A, shotId: SHOT_A, takeId, artifacts: {} });
    flow.succeed({ stage: "check_take", subjectId: takeId, shotId: SHOT_A, takeId, gate: gate("take", false), verdict: verdict(takeId, false), artifacts: {} });
  }
  flow.succeed({ stage: "plan", subjectId: SHOT_A, gate: gate("plan", false), shots: [], artifacts: {} });
  assert.equal(flow.current.shots[SHOT_A]?.status, "escalated");
  assert.throws(() => advance(flow.current, { type: "human_choice", shotId: SHOT_A, takeId: TAKE_A1 }), (error: unknown) => error instanceof EngineError && error.kind === "conflict", "a replan failure is not a take choice");

  flow.apply({ type: "resume" });
  assert.equal(flow.current.status, "running");
  assert.equal(flow.current.shots[SHOT_A]?.status, "replanning");
  assert.equal(flow.jobsFor("plan").length, 1, "the replan is queued again");
  assert.equal(flow.jobsFor("plan")[0]?.attempt, "2");
});

test("a shot with no downgrade escalates after its redos, with every take in the review item", () => {
  const flow = flowToProduce([shot({ shotId: SHOT_A, downgradeTo: null })]);
  for (let round = 0; round < 3; round += 1) {
    const takeId = [TAKE_A1, TAKE_A2, TAKE_A3][round] ?? TAKE_A1;
    flow.succeed({ stage: "produce_shot", epoch: 0, subjectId: SHOT_A, shotId: SHOT_A, takeId, artifacts: { [`take:${takeId}`]: fixtureId("art_", 81 + round) } });
    flow.succeed({ stage: "check_take", subjectId: takeId, shotId: SHOT_A, takeId, gate: gate("take", false), verdict: verdict(takeId, false), artifacts: { [`verdict:${takeId}`]: fixtureId("art_", 101 + round) } });
  }
  assert.equal(flow.current.status, "paused");
  assert.equal(flow.current.pause?.kind, "escalation");
  const review = flow.effects.find((effect) => effect.kind === "review_item");
  assert.ok(review && review.kind === "review_item");
  const takes = review.detail.takes as Array<{ takeId: string; verdictArtifactId: string | null }>;
  assert.equal(takes.length, 3, "every take is listed");
  assert.ok(takes.every((take) => take.verdictArtifactId !== null), "each take points at its verdict artifact");
});

test("a Critic confidence below 0.6 escalates even when the take passes", () => {
  const flow = flowToProduce([shot({ shotId: SHOT_A })]);
  flow.succeed({ stage: "produce_shot", epoch: 0, subjectId: SHOT_A, shotId: SHOT_A, takeId: TAKE_A1, artifacts: {} });
  flow.succeed({ stage: "check_take", subjectId: TAKE_A1, shotId: SHOT_A, takeId: TAKE_A1, gate: gate("take", true), verdict: verdict(TAKE_A1, true, 0.55), artifacts: {} });
  assert.equal(flow.current.shots[SHOT_A]?.status, "escalated");
  assert.equal(flow.current.pause?.kind, "escalation");
});

test("a human choice accepts the picked take, stores a gold label, and resumes the request", () => {
  const flow = flowToProduce([shot({ shotId: SHOT_A, downgradeTo: null })]);
  flow.succeed({ stage: "produce_shot", epoch: 0, subjectId: SHOT_A, shotId: SHOT_A, takeId: TAKE_A1, artifacts: {} });
  flow.succeed({ stage: "check_take", subjectId: TAKE_A1, shotId: SHOT_A, takeId: TAKE_A1, gate: gate("take", true), verdict: verdict(TAKE_A1, true, 0.4), artifacts: {} });
  assert.equal(flow.current.pause?.kind, "escalation");

  flow.apply({ type: "human_choice", shotId: SHOT_A, takeId: TAKE_A1 });
  assert.equal(flow.current.status, "running");
  assert.equal(flow.current.shots[SHOT_A]?.acceptedTakeId, TAKE_A1);
  assert.ok(flow.effects.some((effect) => effect.kind === "gold_label" && effect.takeId === TAKE_A1));
  assert.equal(flow.jobsFor("edit").length, 1, "the request continues once every shot is accepted");
});

test("resume is refused while a shot still waits for a human choice", () => {
  const flow = flowToProduce([shot({ shotId: SHOT_A, downgradeTo: null })]);
  flow.succeed({ stage: "produce_shot", epoch: 0, subjectId: SHOT_A, shotId: SHOT_A, takeId: TAKE_A1, artifacts: {} });
  flow.succeed({ stage: "check_take", subjectId: TAKE_A1, shotId: SHOT_A, takeId: TAKE_A1, gate: gate("take", true), verdict: verdict(TAKE_A1, true, 0.4), artifacts: {} });
  assert.throws(() => advance(flow.current, { type: "resume" }), (error: unknown) => error instanceof EngineError && error.kind === "conflict");
});

/** Drives a one-shot request all the way through to delivery, with the given variant count. */
function flowToDelivery(variantCount: number, gateMetrics?: Record<string, GoldMetrics>): Flow {
  const flow = flowToProduce([shot({ shotId: SHOT_A, downgradeTo: null, sourceKind: "generate" })], { variantCount, ...(gateMetrics ? { gateMetrics } : {}) });
  flow.succeed({ stage: "produce_shot", epoch: 0, subjectId: SHOT_A, shotId: SHOT_A, takeId: TAKE_A1, artifacts: { [`take:${TAKE_A1}`]: fixtureId("art_", 81) } });
  flow.succeed({ stage: "check_take", subjectId: TAKE_A1, shotId: SHOT_A, takeId: TAKE_A1, gate: gate("take", true), verdict: verdict(TAKE_A1, true), artifacts: {} });
  flow.succeed({ stage: "edit", subjectId: REQ, gate: gate("edit", true), edlId: EDL_1, artifacts: { [`edl:${EDL_1}`]: fixtureId("art_", 111) } });
  return flow;
}

function passBranch(flow: Flow, edlId: string): void {
  flow.succeed({ stage: "compose", subjectId: edlId, edlId, artifacts: { [`composition:${edlId}`]: fixtureId("art_", 112) } });
  flow.succeed({ stage: "pre_render_gate", subjectId: edlId, edlId, gate: gate("pre_render", true), artifacts: {} });
  flow.succeed({ stage: "render", subjectId: edlId, edlId, gate: gate("render_integrity", true), artifacts: { [`render:${edlId}`]: fixtureId("art_", 113) } });
  flow.succeed({ stage: "post_render_review", subjectId: edlId, edlId, gate: gate("post_render", true), artifacts: {} });
}

test("the happy path runs edit, compose, pre-render, render and post-render in order, then delivers", () => {
  const flow = flowToDelivery(0);
  assert.deepEqual(flow.jobs.map((job) => job.stage), ["compose"]);
  assert.equal(flow.jobs[0]?.paid, false);
  passBranch(flow, EDL_1);
  assert.deepEqual(
    flow.history.map((job) => job.stage),
    [
      "intake",
      "analyze_reference",
      "voice",
      "plan",
      "estimate_reserve",
      "produce_shot",
      "check_take",
      "edit",
      "compose",
      "pre_render_gate",
      "render",
      "post_render_review",
      "deliver",
    ],
    "every stage is queued once, in the Bible 3 order",
  );
  assert.deepEqual(flow.jobs.map((job) => job.stage), ["deliver"]);
  flow.succeed({ stage: "deliver", subjectId: REQ, manifestId: fixtureId("vid_", 121), artifacts: { manifest: fixtureId("art_", 122) } });
  assert.equal(flow.current.status, "delivered");
  assert.ok(flow.effects.some((effect) => effect.kind === "delivered"));
});

test("variants fan out to their own compose stage after the master passes, and delivery waits for them", () => {
  const flow = flowToDelivery(1);
  passBranch(flow, EDL_1);
  assert.deepEqual(flow.jobs.map((job) => job.stage), ["variants"]);
  flow.succeed({ stage: "variants", phase: "request", subjectId: REQ, work: [], variants: [{ edlId: EDL_2 }], artifacts: { [`edl:${EDL_2}`]: fixtureId("art_", 131) } });
  assert.deepEqual(flow.jobs.map((job) => job.stage), ["compose"]);
  assert.equal(flow.jobs[0]?.subjectId, EDL_2);
  assert.equal(flow.jobs[0]?.payload.details.variantOf, EDL_1);
  assert.equal(flow.jobsFor("deliver").length, 0, "deliver waits for the variant");
  passBranch(flow, EDL_2);
  assert.deepEqual(flow.jobs.map((job) => job.stage), ["deliver"]);
});

test("a prepared generation variant's plan and voice are not request artifacts, so deliver is queued with one scene plan's worth of inputs", () => {
  const flow = flowToDelivery(1);
  passBranch(flow, EDL_1);
  flow.succeed({
    stage: "variants",
    phase: "request",
    subjectId: REQ,
    work: [],
    variants: [{ edlId: EDL_2 }],
    artifacts: { [`edl:${EDL_2}`]: fixtureId("art_", 131), "plan:product:SKU-2": fixtureId("art_", 132), "voice:hook:1": fixtureId("art_", 133) },
  });
  passBranch(flow, EDL_2);
  const deliver = flow.jobs.find((job) => job.stage === "deliver");
  assert.ok(deliver, "deliver is queued");
  assert.equal(deliver.payload.inputArtifactIds.includes(fixtureId("art_", 131)), true, "the variant EDL is an input");
  assert.equal(deliver.payload.inputArtifactIds.includes(fixtureId("art_", 132)), false, "the variant plan is not");
  assert.equal(deliver.payload.inputArtifactIds.includes(fixtureId("art_", 133)), false, "the variant voice is not");
});

test("a caption variant (a re-render only, no generation) runs its own chain and never queues a produce or voice job", () => {
  const flow = flowToDelivery(1);
  passBranch(flow, EDL_1);
  const before = flow.history.length;
  flow.succeed({ stage: "variants", phase: "request", subjectId: REQ, work: [], variants: [{ edlId: EDL_2 }], artifacts: { [`edl:${EDL_2}`]: fixtureId("art_", 131) } });
  passBranch(flow, EDL_2);
  const afterMaster = flow.history.slice(before).map((job) => job.stage);
  assert.ok(afterMaster.includes("compose"), "the caption variant is composed");
  assert.ok(afterMaster.includes("render"), "and rendered");
  assert.ok(afterMaster.includes("deliver"), "and delivered with the master");
  assert.equal(afterMaster.filter((stage) => stage === "produce_shot" || stage === "voice" || stage === "plan").length, 0, "no generation job");
  assert.equal(flow.history.filter((job) => job.stage === "produce_shot").length, 1, "the only produce job is the master's own, from the plan");
});

test("a failing pre-render gate that names a shot sends only that shot back to produce, then rebuilds the edit", () => {
  // The failing check is proven (its gold set meets the target), so it may block (Bible 12.4, 5.3).
  const flow = flowToDelivery(0, provenFor([BROKEN("pre_render")]));
  flow.succeed({ stage: "compose", subjectId: EDL_1, edlId: EDL_1, artifacts: {} });
  flow.succeed({ stage: "pre_render_gate", subjectId: EDL_1, edlId: EDL_1, gate: gate("pre_render", false, [SHOT_A]), artifacts: {} });
  const [produce] = flow.jobsFor("produce_shot");
  assert.equal(produce?.subjectId, SHOT_A);
  assert.equal(produce?.attempt, "2");
  assert.deepEqual(produce?.payload.hints, ["pre_render.broken"]);
  assert.equal(flow.current.branches[EDL_1]?.status, "superseded");
  flow.succeed({ stage: "produce_shot", epoch: 0, subjectId: SHOT_A, shotId: SHOT_A, takeId: TAKE_A2, artifacts: {} });
  flow.succeed({ stage: "check_take", subjectId: TAKE_A2, shotId: SHOT_A, takeId: TAKE_A2, gate: gate("take", true), verdict: verdict(TAKE_A2, true), artifacts: {} });
  assert.deepEqual(flow.jobs.map((job) => job.stage), ["edit"], "the EDL is rebuilt with the new take");
});

test("a gate that names a component shot does not queue a produce job that could never run: it downgrades or escalates", () => {
  const flow = flowToProduce(
    [
      shot({ shotId: SHOT_A, downgradeTo: null, sourceKind: "generate" }),
      shot({ shotId: SHOT_B, sourceKind: "component", modelClass: null, visualType: "coded_graphics", downgradeTo: "product_hero" }),
    ],
    { gateMetrics: provenFor([BROKEN("pre_render")]) },
  );
  flow.succeed({ stage: "produce_shot", epoch: 0, subjectId: SHOT_A, shotId: SHOT_A, takeId: TAKE_A1, artifacts: {} });
  flow.succeed({ stage: "check_take", subjectId: TAKE_A1, shotId: SHOT_A, takeId: TAKE_A1, gate: gate("take", true), verdict: verdict(TAKE_A1, true), artifacts: {} });
  flow.succeed({ stage: "edit", subjectId: REQ, gate: gate("edit", true), edlId: EDL_1, artifacts: {} });
  flow.succeed({ stage: "compose", subjectId: EDL_1, edlId: EDL_1, artifacts: {} });
  flow.succeed({ stage: "pre_render_gate", subjectId: EDL_1, edlId: EDL_1, gate: gate("pre_render", false, [SHOT_B]), artifacts: {} });
  assert.equal(flow.jobsFor("produce_shot").length, 0, "no produce job for a component shot");
  assert.equal(flow.current.shots[SHOT_B]?.status, "replanning", "it downgrades, since it has a downgrade target");
  assert.equal(flow.jobsFor("plan")[0]?.subjectId, SHOT_B);
  assert.equal(flow.current.status, "running");
});

test("a failing pre-render gate with no named shot re-runs the edit twice, then escalates", () => {
  const flow = flowToDelivery(0, provenFor([BROKEN("pre_render")]));
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    flow.succeed({ stage: "compose", subjectId: EDL_1, edlId: EDL_1, artifacts: {} });
    flow.succeed({ stage: "pre_render_gate", subjectId: EDL_1, edlId: EDL_1, gate: gate("pre_render", false), artifacts: {} });
    if (attempt < 3) {
      assert.deepEqual(flow.jobs.map((job) => job.stage), ["edit"], `attempt ${attempt} re-runs the edit`);
      flow.succeed({ stage: "edit", subjectId: REQ, gate: gate("edit", true), edlId: EDL_1, artifacts: {} });
    }
  }
  assert.equal(flow.current.status, "paused");
  assert.equal(flow.current.pause?.kind, "escalation");
});

test("a render integrity failure re-renders up to the limit, then escalates", () => {
  const flow = flowToDelivery(0, provenFor([BROKEN("render_integrity")]));
  flow.succeed({ stage: "compose", subjectId: EDL_1, edlId: EDL_1, artifacts: {} });
  flow.succeed({ stage: "pre_render_gate", subjectId: EDL_1, edlId: EDL_1, gate: gate("pre_render", true), artifacts: {} });
  flow.succeed({ stage: "render", subjectId: EDL_1, edlId: EDL_1, gate: gate("render_integrity", false), artifacts: {} });
  assert.equal(flow.jobsFor("render")[0]?.attempt, "2");
  flow.succeed({ stage: "render", subjectId: EDL_1, edlId: EDL_1, gate: gate("render_integrity", false), artifacts: {} });
  assert.equal(flow.jobsFor("render")[0]?.attempt, "3");
  flow.succeed({ stage: "render", subjectId: EDL_1, edlId: EDL_1, gate: gate("render_integrity", false), artifacts: {} });
  assert.equal(flow.current.pause?.kind, "escalation");
  assert.equal(flow.current.pause?.stage, "render");
});

test("a dead produce job pauses the request with its artifacts kept; resume queues the produce job again", () => {
  const flow = flowToProduce([shot({ shotId: SHOT_A, downgradeTo: null })]);
  flow.dead("produce_shot", SHOT_A);
  assert.equal(flow.current.status, "paused");
  assert.equal(flow.current.pause?.kind, "dead_letter");
  assert.equal(flow.jobs.length, 0, "nothing new is queued while paused");
  assert.ok(flow.effects.some((effect) => effect.kind === "review_item" && effect.reviewKind === "dead_letter"));
  assert.equal(flow.current.shots[SHOT_A]?.issued, 0);

  flow.apply({ type: "resume" });
  assert.equal(flow.current.status, "running");
  assert.deepEqual(flow.jobsFor("produce_shot").map((job) => job.attempt), ["2"]);
  assert.equal(flow.jobsFor("produce_shot")[0]?.key, `engine:${REQ}:produce_shot:${SHOT_A}:2`);
});

test("stale and duplicate results are refused, and a rejected request accepts no more events", () => {
  const flow = new Flow().apply(start());
  assert.throws(
    () => advance(flow.current, { type: "succeeded", output: { stage: "voice", subjectId: REQ, gate: gate("voice", true), artifacts: {} } }),
    (error: unknown) => error instanceof EngineError && error.kind === "conflict",
    "voice is not queued yet",
  );
  flow.succeed({ stage: "intake", subjectId: REQ, gate: gate("request", true), budgetReservationId: RES, budgetPause: null, artifacts: {} });
  assert.throws(
    () => advance(flow.current, { type: "succeeded", output: { stage: "intake", subjectId: REQ, gate: gate("request", true), budgetReservationId: RES, budgetPause: null, artifacts: {} } }),
    (error: unknown) => error instanceof EngineError && error.kind === "conflict",
    "a second intake result is refused",
  );

  const rejected = new Flow().apply(start());
  rejected.succeed({ stage: "intake", subjectId: REQ, gate: gate("request", false), budgetReservationId: null, budgetPause: null, artifacts: {} });
  assert.equal(rejected.current.status, "rejected");
  assert.throws(() => advance(rejected.current, { type: "resume" }), (error: unknown) => error instanceof EngineError && error.kind === "conflict");
});

test("a gate reported under the wrong name is refused as invalid input", () => {
  const flow = new Flow().apply(start());
  assert.throws(
    () => advance(flow.current, { type: "succeeded", output: { stage: "intake", subjectId: REQ, gate: gate("dna", true), budgetReservationId: RES, budgetPause: null, artifacts: {} } }),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
  );
});

test("the same state and event give the same jobs and keys (replay is safe)", () => {
  const before = new Flow().apply(start());
  const event: EngineEvent = { type: "succeeded", output: { stage: "intake", subjectId: REQ, gate: gate("request", true), budgetReservationId: RES, budgetPause: null, artifacts: {} } };
  const first = advance(before.current, event);
  const second = advance(before.current, event);
  assert.deepEqual(first.jobs.map((job) => job.key), second.jobs.map((job) => job.key));
  assert.deepEqual(first.state, second.state);
});

test("a result for another request's subject is refused", () => {
  const flow = new Flow().apply(start());
  assert.throws(
    () => advance(flow.current, { type: "succeeded", output: { stage: "intake", subjectId: fixtureId("req_", 99), gate: gate("request", true), budgetReservationId: RES, budgetPause: null, artifacts: {} } }),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
  );
});

test("the escalation limits come from configuration", () => {
  assert.equal(orchestratorLimits.shotRedos, 2);
  assert.equal(orchestratorLimits.criticConfidenceMin, 0.6);
  assert.equal(orchestratorLimits.voiceRedos, 2);
  assert.equal(orchestratorLimits.planRedos, 1);
});

// --- E3: refusals, budget holds, plan epochs and the review payload (Bible 5.3, 10.4, 14) -------------------------------------

function refusal(epoch: number, takeId: string | null, errorKind: "content_policy" | "invalid_input" = "content_policy"): StageOutput {
  return {
    stage: "produce_shot",
    subjectId: SHOT_A,
    shotId: SHOT_A,
    takeId,
    epoch,
    hold: { kind: "refused", errorKind, hint: errorKind },
    artifacts: {},
  } as StageOutput;
}

test("a content_policy refusal sends the shot back to the planner once, with the rule name as the hint; a second refusal downgrades", () => {
  const flow = flowToProduce([shot({ shotId: SHOT_A, downgradeTo: "product_hero" })]);
  flow.succeed(refusal(0, null));
  assert.equal(flow.current.shots[SHOT_A]?.status, "replanning");
  assert.equal(flow.current.shots[SHOT_A]?.rewrites, 1);
  const [rewrite] = flow.jobsFor("plan");
  assert.equal(rewrite?.payload.details.directive, "rewrite", "the first refusal asks the planner for a rewrite");
  assert.deepEqual(rewrite?.payload.hints, ["content_policy"], "the hint is the rule name, never provider text");
  assert.ok(flow.effects.some((effect) => effect.kind === "decision" && effect.decision.chose === "prompt_rewrite"));

  flow.succeed({
    stage: "plan",
    subjectId: SHOT_A,
    gate: gate("plan", true),
    shots: [shot({ shotId: SHOT_A, downgradeTo: "product_hero" })],
    artifacts: { plan: fixtureId("art_", 92) },
  });
  assert.equal(flow.current.shots[SHOT_A]?.epoch, 1, "a replan starts a new plan epoch");
  const [retry] = flow.jobsFor("produce_shot");
  assert.equal(retry?.payload.details.epoch, 1, "the rewritten shot is produced in the new epoch");

  flow.succeed(refusal(1, null, "invalid_input"));
  assert.equal(flow.current.shots[SHOT_A]?.status, "replanning", "after the rewrite, a refusal downgrades");
  const [downgrade] = flow.jobsFor("plan");
  assert.equal(downgrade?.payload.details.directive, "downgrade");
  assert.ok(flow.effects.some((effect) => effect.kind === "decision" && effect.decision.chose === "product_hero"));
});

test("a refusal after the rewrite, for a shot with no downgrade, escalates with the review item", () => {
  const flow = flowToProduce([shot({ shotId: SHOT_A, downgradeTo: null })]);
  flow.succeed(refusal(0, null));
  flow.succeed({ stage: "plan", subjectId: SHOT_A, gate: gate("plan", true), shots: [shot({ shotId: SHOT_A, downgradeTo: null })], artifacts: { plan: fixtureId("art_", 93) } });
  flow.succeed(refusal(1, null, "invalid_input"));
  assert.equal(flow.current.shots[SHOT_A]?.status, "escalated");
  assert.equal(flow.current.pause?.kind, "escalation");
});

test("a budget hold pauses the request with its reason, and resume queues the produce job again", () => {
  const flow = flowToProduce([shot({ shotId: SHOT_A, downgradeTo: null })]);
  flow.succeed({
    stage: "produce_shot",
    subjectId: SHOT_A,
    shotId: SHOT_A,
    takeId: null,
    epoch: 0,
    hold: { kind: "budget", reason: "produce_shot would take reservation res to 0.7 USD, above its 0.6 USD" },
    artifacts: {},
  } as StageOutput);
  assert.equal(flow.current.status, "paused");
  assert.equal(flow.current.pause?.kind, "budget");
  assert.equal(flow.current.pause?.stage, "produce_shot");
  assert.match(flow.current.pause?.reason ?? "", /above its 0.6 USD/);
  assert.equal(flow.jobs.length, 0, "a paused request queues nothing");

  flow.apply({ type: "resume" });
  const [again] = flow.jobsFor("produce_shot");
  assert.equal(again?.attempt, "2", "the held job is queued again as a new attempt");
  assert.equal(flow.current.shots[SHOT_A]?.status, "pending");
});

test("a result of a replaced plan is recorded but never checked or counted, and its dead job does not pause the request", () => {
  const flow = flowToProduce([shot({ shotId: SHOT_A, takesWanted: 2, downgradeTo: null })]);
  flow.succeed({ stage: "produce_shot", epoch: 0, subjectId: SHOT_A, shotId: SHOT_A, takeId: TAKE_A1, artifacts: { [`take:${TAKE_A1}`]: fixtureId("art_", 81) } });
  flow.succeed(refusal(0, null));
  assert.equal(flow.current.shots[SHOT_A]?.status, "replanning");
  flow.succeed({
    stage: "plan",
    subjectId: SHOT_A,
    gate: gate("plan", true),
    shots: [shot({ shotId: SHOT_A, takesWanted: 2, downgradeTo: null })],
    artifacts: { plan: fixtureId("art_", 94) },
  });
  assert.equal(flow.jobsFor("produce_shot").length, 2, "the new plan asks for both takes again");

  // The second take of the old plan arrives now. It is kept on record, and nothing is checked for it.
  flow.succeed({ stage: "produce_shot", epoch: 0, subjectId: SHOT_A, shotId: SHOT_A, takeId: TAKE_A2, artifacts: { [`take:${TAKE_A2}`]: fixtureId("art_", 82) } });
  assert.equal(flow.current.takes[TAKE_A2]?.stale, true);
  assert.equal(flow.jobsFor("check_take").length, 0, "a take of a replaced plan is not checked");

  // Its check, queued before the replan, lands after it: the verdict is stored and the shot does not move.
  flow.succeed({ stage: "check_take", subjectId: TAKE_A1, shotId: SHOT_A, takeId: TAKE_A1, gate: gate("take", true), verdict: verdict(TAKE_A1, true, 0.9), artifacts: {} });
  assert.equal(flow.current.shots[SHOT_A]?.status, "pending");
  assert.equal(flow.current.shots[SHOT_A]?.acceptedTakeId, null);

  // A dead job of the old plan changes nothing and pauses nothing.
  flow.apply({ type: "dead", stage: "produce_shot", subjectId: SHOT_A, reason: "provider timed out", epoch: 0 });
  assert.equal(flow.current.status, "running");
  assert.equal(flow.current.pause, null);
});

test("the review item of an escalated shot carries the review-inbox payload, built from the verdicts", () => {
  const flow = flowToProduce([shot({ shotId: SHOT_A, downgradeTo: null })]);
  for (let round = 0; round < 3; round += 1) {
    const takeId = [TAKE_A1, TAKE_A2, TAKE_A3][round] ?? TAKE_A1;
    flow.succeed({ stage: "produce_shot", epoch: 0, subjectId: SHOT_A, shotId: SHOT_A, takeId, artifacts: { [`take:${takeId}`]: fixtureId("art_", 81 + round) } });
    flow.succeed({ stage: "check_take", subjectId: takeId, shotId: SHOT_A, takeId, gate: gate("take", false), verdict: verdict(takeId, false), artifacts: { [`verdict:${takeId}`]: fixtureId("art_", 101 + round) } });
  }
  const review = flow.effects.find((effect) => effect.kind === "review_item");
  assert.ok(review && review.kind === "review_item");
  const payload = review.detail.review as { schema: string; kind: string; actions: string[]; takes: Array<{ takeId: string; failing: string[]; checks: unknown[] }> };
  assert.equal(payload.schema, "meridian.take_review/v1");
  assert.equal(payload.kind, "escalation");
  assert.equal(payload.takes.length, 3);
  assert.deepEqual(payload.takes[0]?.failing, ["slop.hands"]);
  assert.ok(payload.takes.every((take) => take.checks.length > 0));
  assert.ok(payload.actions.includes("choose_take"));
});

// --- E4: gate routing by the gold sets (Bible 5.3, 12.4). A failure with no proven check goes to review, never to a redo. ----

test("an unproven pre-render failure that names a shot escalates for review: no produce redo, no render", () => {
  const flow = flowToDelivery(0);
  flow.succeed({ stage: "compose", subjectId: EDL_1, edlId: EDL_1, artifacts: {} });
  flow.succeed({ stage: "pre_render_gate", subjectId: EDL_1, edlId: EDL_1, gate: gate("pre_render", false, [SHOT_A]), artifacts: { [`gate:${EDL_1}`]: fixtureId("art_", 91) } });
  assert.equal(flow.jobsFor("produce_shot").length, 0, "an unproven failure is not redone");
  assert.equal(flow.jobsFor("render").length, 0, "nothing is rendered");
  assert.equal(flow.current.status, "paused");
  assert.equal(flow.current.pause?.kind, "escalation");
  const review = flow.effects.find((effect) => effect.kind === "review_item" && effect.subjectId === EDL_1);
  assert.ok(review && review.kind === "review_item", "a review item names the EDL");
  assert.equal((review.detail.gateReview as { schema?: string } | undefined)?.schema, "meridian.gate_review/v1");
});

test("an unproven post-render failure (a broken overlay) never reaches deliver", () => {
  const flow = flowToDelivery(0, provenFor([BROKEN("pre_render")]));
  flow.succeed({ stage: "compose", subjectId: EDL_1, edlId: EDL_1, artifacts: {} });
  flow.succeed({ stage: "pre_render_gate", subjectId: EDL_1, edlId: EDL_1, gate: gate("pre_render", true), artifacts: {} });
  flow.succeed({ stage: "render", subjectId: EDL_1, edlId: EDL_1, gate: gate("render_integrity", true), artifacts: { [`render:${EDL_1}`]: fixtureId("art_", 113) } });
  flow.succeed({ stage: "post_render_review", subjectId: EDL_1, edlId: EDL_1, gate: gate("post_render", false), artifacts: { [`review:${fixtureId("vid_", 123)}`]: fixtureId("art_", 124) } });
  assert.equal(flow.jobsFor("deliver").length, 0, "the video with a failed overlay is not delivered");
  assert.equal(flow.current.status, "paused");
  assert.equal(flow.current.pause?.stage, "post_render_review");
  assert.equal(flow.current.branches[EDL_1]?.status, "escalated");
});

test("a proven post-render failure is redone at the compose stage, as the gold set allows", () => {
  const flow = flowToDelivery(0, provenFor([BROKEN("post_render")]));
  flow.succeed({ stage: "compose", subjectId: EDL_1, edlId: EDL_1, artifacts: {} });
  flow.succeed({ stage: "pre_render_gate", subjectId: EDL_1, edlId: EDL_1, gate: gate("pre_render", true), artifacts: {} });
  flow.succeed({ stage: "render", subjectId: EDL_1, edlId: EDL_1, gate: gate("render_integrity", true), artifacts: { [`render:${EDL_1}`]: fixtureId("art_", 113) } });
  flow.succeed({ stage: "post_render_review", subjectId: EDL_1, edlId: EDL_1, gate: gate("post_render", false), artifacts: {} });
  assert.deepEqual(flow.jobs.map((job) => job.stage), ["compose"], "the proven failure is redone");
  assert.equal(flow.current.status, "running");
});

test("an unproven render integrity failure escalates; it is not re-rendered", () => {
  const flow = flowToDelivery(0);
  flow.succeed({ stage: "compose", subjectId: EDL_1, edlId: EDL_1, artifacts: {} });
  flow.succeed({ stage: "pre_render_gate", subjectId: EDL_1, edlId: EDL_1, gate: gate("pre_render", true), artifacts: {} });
  flow.succeed({ stage: "render", subjectId: EDL_1, edlId: EDL_1, gate: gate("render_integrity", false), artifacts: { [`integrity:${EDL_1}`]: fixtureId("art_", 114) } });
  assert.equal(flow.jobsFor("render").length, 0);
  assert.equal(flow.current.pause?.stage, "render");
  assert.equal(flow.current.pause?.kind, "escalation");
});

test("the gold metrics a request starts with are kept in its state, and missing metrics read as unproven", () => {
  const withMetrics = flowToDelivery(0, provenFor([BROKEN("pre_render")]));
  assert.deepEqual(Object.keys(withMetrics.current.gateMetrics ?? {}), [BROKEN("pre_render")]);
  const without = flowToDelivery(0);
  assert.deepEqual(without.current.gateMetrics, {});
});

test("a render fallback decision is passed to the effects, so it is stored with the request", () => {
  const flow = flowToDelivery(0, provenFor([BROKEN("pre_render")]));
  flow.succeed({ stage: "compose", subjectId: EDL_1, edlId: EDL_1, artifacts: {} });
  flow.succeed({ stage: "pre_render_gate", subjectId: EDL_1, edlId: EDL_1, gate: gate("pre_render", true), artifacts: {} });
  const decision = {
    at: `edl:${EDL_1}`,
    chose: "shotstack",
    alternatives: [{ option: "hyperframes", score: 0 }],
    reason: "HyperFrames failed twice",
    by: "scorer" as const,
  };
  flow.succeed({ stage: "render", subjectId: EDL_1, edlId: EDL_1, gate: gate("render_integrity", true), decisions: [decision], artifacts: { [`render:${EDL_1}`]: fixtureId("art_", 113) } });
  assert.ok(flow.effects.some((effect) => effect.kind === "decision" && effect.decision.chose === "shotstack"));
});
