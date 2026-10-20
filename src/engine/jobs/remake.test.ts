// Remakes of one shot (Video Engine Bible 5.5), on the pure orchestrator: no database and no provider. A delivered video's accepted shot
// is made again, the chain runs again on its new take, and a second master is delivered. The superseded master stays on record.

import assert from "node:assert/strict";
import test from "node:test";
import { EngineError, type GateId, type GateResult, type TakeVerdict } from "../contracts/index.ts";
import { FIXTURE_IDS, fixtureId } from "../contracts/fixtures/index.ts";
import { advance, orchestratorLimits, remakeRefusalOf, type OrchestratorState } from "./orchestrator.ts";
import { directivesOf, promptWithDirectives, remakeDirectiveOf, REMAKE_DIRECTIVE_MAX_CHARS, REMAKE_DIRECTIVES_MAX } from "./remake.ts";
import type { EngineEvent, QueuedJob, ShotSummary, StageOutput } from "./types.ts";

const ORG = "org_fixture";
const REQ = FIXTURE_IDS.request;
const REQUEST_ART = fixtureId("art_", 40);
const RES = FIXTURE_IDS.reservation;
const RES_REMAKE = fixtureId("res_", 90);
const RES_REMAKE_2 = fixtureId("res_", 91);
const SHOT_A = fixtureId("shot_", 51);
const SHOT_C = fixtureId("shot_", 53);
const TAKE_1 = fixtureId("take_", 61);
const TAKE_2 = fixtureId("take_", 62);
const EDL_1 = fixtureId("edl_", 71);
const EDL_2 = fixtureId("edl_", 72);
const VID_1 = fixtureId("vid_", 121);
const VID_2 = fixtureId("vid_", 131);
const DIRECTION = "A close-up of the product in the hand, lit from the left";
const AT = "2026-10-18T10:00:00.000Z";

function gate(name: GateId, pass: boolean): GateResult {
  return {
    gate: name,
    subjectId: REQ,
    pass,
    checks: pass ? [{ rule: `${name}.ok`, pass: true, value: 1 }] : [{ rule: `${name}.broken`, pass: false, detail: "free text" }],
  };
}

function verdict(takeId: string, pass: boolean): TakeVerdict {
  return {
    takeId,
    pass,
    confidence: 0.9,
    checks: pass
      ? [{ rule: "duration_within_10pct", pass: true, score: 1 }]
      : [{ rule: "slop.hands", pass: false, score: 0.41, detail: "model prose about fingers" }],
    action: pass ? "accept" : "redo",
  };
}

function shot(overrides: Partial<ShotSummary> & { shotId: string }): ShotSummary {
  return { visualType: "cinematic", downgradeTo: "product_hero", sourceKind: "generate", modelClass: "video.cinematic", takesWanted: 1, ...overrides };
}

class Flow {
  state: OrchestratorState | null = null;
  jobs: QueuedJob[] = [];
  effects: ReturnType<typeof advance>["effects"] = [];

  apply(event: EngineEvent): this {
    const result = advance(this.state, event);
    this.state = result.state;
    this.jobs = result.jobs;
    this.effects = result.effects;
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

/** A request that has its one shot's take accepted and its edit cut, but has not been passed through the chain. */
function editedFlow(): Flow {
  const flow = new Flow().apply({
    type: "start",
    organizationId: ORG,
    requestId: REQ,
    priority: "normal",
    cachedDna: false,
    variantCount: 0,
    requestArtifactId: REQUEST_ART,
  });
  flow.succeed({ stage: "intake", subjectId: REQ, gate: gate("request", true), budgetReservationId: RES, budgetPause: null, artifacts: { validated: fixtureId("art_", 41) } });
  flow.succeed({ stage: "analyze_reference", subjectId: REQ, gate: gate("dna", true), artifacts: { dna: fixtureId("art_", 42) } });
  flow.succeed({ stage: "voice", subjectId: REQ, gate: gate("voice", true), artifacts: { voice: fixtureId("art_", 43) } });
  flow.succeed({ stage: "plan", subjectId: REQ, gate: gate("plan", true), shots: [shot({ shotId: SHOT_A })], artifacts: { plan: fixtureId("art_", 44) } });
  flow.succeed({ stage: "estimate_reserve", subjectId: REQ, gate: gate("budget", true), budgetReservationId: RES, artifacts: { budget: fixtureId("art_", 45) } });
  flow.succeed({ stage: "produce_shot", epoch: 0, subjectId: SHOT_A, shotId: SHOT_A, takeId: TAKE_1, artifacts: { [`take:${TAKE_1}`]: fixtureId("art_", 81) } });
  flow.succeed({ stage: "check_take", subjectId: TAKE_1, shotId: SHOT_A, takeId: TAKE_1, gate: gate("take", true), verdict: verdict(TAKE_1, true), artifacts: {} });
  flow.succeed({ stage: "edit", subjectId: REQ, gate: gate("edit", true), edlId: EDL_1, artifacts: { [`edl:${EDL_1}`]: fixtureId("art_", 111) } });
  return flow;
}

/** Runs one EDL through compose, pre-render, render and post-render, all passing. */
function passChain(flow: Flow, edlId: string, renderId: number): void {
  flow.succeed({ stage: "compose", subjectId: edlId, edlId, artifacts: { [`composition:${edlId}`]: fixtureId("art_", 112 + renderId) } });
  flow.succeed({ stage: "pre_render_gate", subjectId: edlId, edlId, gate: gate("pre_render", true), artifacts: {} });
  flow.succeed({ stage: "render", subjectId: edlId, edlId, gate: gate("render_integrity", true), artifacts: { [`render:${edlId}`]: fixtureId("art_", 113 + renderId) } });
  flow.succeed({ stage: "post_render_review", subjectId: edlId, edlId, gate: gate("post_render", true), artifacts: {} });
}

/** A delivered video of one shot: the first master, with manifest VID_1. */
function deliveredFlow(): Flow {
  const flow = editedFlow();
  passChain(flow, EDL_1, 0);
  flow.succeed({ stage: "deliver", subjectId: REQ, manifestId: VID_1, artifacts: { manifest: fixtureId("art_", 122) } });
  return flow;
}

function remakeEvent(overrides: Partial<Extract<EngineEvent, { type: "remake" }>> = {}): EngineEvent {
  return { type: "remake", shotId: SHOT_A, directive: DIRECTION, budgetReservationId: RES_REMAKE, at: AT, ...overrides };
}

test("a remake of a video that is still being made is refused, and the reason is said", () => {
  const flow = editedFlow();
  assert.equal(flow.current.status, "running");
  assert.throws(
    () => advance(flow.current, remakeEvent()),
    (error: unknown) => error instanceof EngineError && error.kind === "conflict" && /still being made/.test(error.message),
  );
});

test("a remake reopens a delivered video: its shot gets a new produce job with the direction, on the remake's reservation", () => {
  const flow = deliveredFlow();
  assert.equal(flow.current.status, "delivered");
  flow.apply(remakeEvent());

  assert.equal(flow.current.status, "running");
  assert.equal(flow.current.revision, 1);
  assert.equal(flow.current.manifestId, null);
  assert.equal(flow.current.budgetReservationId, RES_REMAKE);
  assert.equal(flow.current.shots[SHOT_A]?.status, "pending");
  assert.equal(flow.current.shots[SHOT_A]?.epoch, 1, "the shot starts a new epoch, so its old takes stop counting");
  assert.equal(flow.current.shots[SHOT_A]?.round, 0, "the redo budget starts again");

  const produce = flow.jobsFor("produce_shot");
  assert.equal(produce.length, 1, "only the remade shot is produced again");
  assert.equal(produce[0]?.subjectId, SHOT_A);
  assert.equal(produce[0]?.attempt, "2", "a new attempt, so a new seed and a new cache key");
  assert.equal(produce[0]?.payload.budgetReservationId, RES_REMAKE);
  assert.deepEqual(produce[0]?.payload.details.directives, [DIRECTION]);
  assert.equal(produce[0]?.payload.details.epoch, 1);

  assert.equal(flow.current.nodes.edit.status, "idle", "the edit waits for the new take");
  assert.equal(flow.current.nodes.deliver.status, "idle");
  assert.ok(flow.effects.some((effect) => effect.kind === "decision" && effect.decision.by === "human"), "the remake is recorded as a decision");
});

test("the remade take is checked, the edit is cut again on it, and the chain delivers a second master; the first stays on record", () => {
  const flow = deliveredFlow();
  flow.apply(remakeEvent());
  const produce = flow.jobsFor("produce_shot")[0];
  assert.ok(produce);
  flow.succeed({ stage: "produce_shot", epoch: 1, subjectId: SHOT_A, shotId: SHOT_A, takeId: TAKE_2, artifacts: { [`take:${TAKE_2}`]: fixtureId("art_", 82) } });
  flow.succeed({ stage: "check_take", subjectId: TAKE_2, shotId: SHOT_A, takeId: TAKE_2, gate: gate("take", true), verdict: verdict(TAKE_2, true), artifacts: {} });

  const edit = flow.jobsFor("edit")[0];
  assert.ok(edit, "the edit is queued once the remade shot is accepted");
  assert.ok(edit.payload.inputArtifactIds.includes(fixtureId("art_", 82)), "the edit reads the new take");
  assert.ok(!edit.payload.inputArtifactIds.includes(fixtureId("art_", 81)), "the edit does not read the superseded take");

  flow.succeed({ stage: "edit", subjectId: REQ, gate: gate("edit", true), edlId: EDL_2, artifacts: { [`edl:${EDL_2}`]: fixtureId("art_", 114) } });
  assert.equal(flow.current.branches[EDL_1]?.status, "superseded", "the first master is superseded, not deleted");
  passChain(flow, EDL_2, 1);

  const deliver = flow.jobsFor("deliver")[0];
  assert.ok(deliver, "delivery is queued for the new master");
  assert.equal(deliver.payload.details.masterEdlId, EDL_2, "delivery names the new master, not the superseded one");
  assert.equal(deliver.payload.details.revision, 1);

  flow.succeed({ stage: "deliver", subjectId: REQ, manifestId: VID_2, artifacts: { manifest: fixtureId("art_", 123) } });
  assert.equal(flow.current.status, "delivered");
  assert.equal(flow.current.manifestId, VID_2, "the revision's manifest is the request's manifest");
  assert.equal(flow.current.masterEdlId, EDL_2);
  assert.equal(flow.current.revision, 1);
});

test("a remade shot that fails its checks is redone within its budget, then goes to a person: it is not downgraded or replanned", () => {
  const flow = deliveredFlow();
  flow.apply(remakeEvent());
  for (let round = 0; round <= orchestratorLimits.shotRedos; round += 1) {
    const takeId = fixtureId("take_", 200 + round);
    const job = flow.jobsFor("produce_shot")[0];
    assert.ok(job, `round ${round} produces a take`);
    flow.succeed({ stage: "produce_shot", epoch: 1, subjectId: SHOT_A, shotId: SHOT_A, takeId, artifacts: {} });
    flow.succeed({ stage: "check_take", subjectId: takeId, shotId: SHOT_A, takeId, gate: gate("take", false), verdict: verdict(takeId, false), artifacts: {} });
  }
  assert.equal(flow.current.status, "paused");
  assert.equal(flow.current.pause?.kind, "escalation");
  assert.equal(flow.jobsFor("plan").length, 0, "no replan of the whole plan");
  assert.equal(flow.current.shots[SHOT_A]?.downgrades, 0, "the shot was not downgraded");
});

test("a shot that is not accepted, a shot of another video, and a component shot are each refused with a reason", () => {
  const delivered = deliveredFlow().current;
  assert.equal(remakeRefusalOf(delivered, SHOT_A), null);
  assert.match(remakeRefusalOf(delivered, fixtureId("shot_", 99)) ?? "", /not in this video/);

  const pending = structuredClone(delivered);
  pending.shots[SHOT_A] = { ...pending.shots[SHOT_A]!, status: "pending" };
  assert.match(remakeRefusalOf(pending, SHOT_A) ?? "", /no accepted take/);

  const component = structuredClone(delivered);
  component.shots[SHOT_C] = { ...component.shots[SHOT_A]!, shotId: SHOT_C, sourceKind: "component", status: "accepted" };
  assert.match(remakeRefusalOf(component, SHOT_C) ?? "", /component or asset shot/);
});

test("a video with variants refuses a remake, because its variants would be stale", () => {
  const withVariants = structuredClone(deliveredFlow().current);
  withVariants.variantCount = 1;
  assert.match(remakeRefusalOf(withVariants, SHOT_A) ?? "", /variants/);
  assert.throws(() => advance(withVariants, remakeEvent()), (error: unknown) => error instanceof EngineError && error.kind === "conflict");
});

test("a second remake of a shot whose new take is still pending is refused", () => {
  const flow = deliveredFlow();
  flow.apply(remakeEvent());
  assert.throws(() => advance(flow.current, remakeEvent({ budgetReservationId: RES_REMAKE_2 })), (error: unknown) => error instanceof EngineError);
});

test("a remake without its own reservation is refused as invalid input, and the request is unchanged", () => {
  const flow = deliveredFlow();
  assert.throws(() => advance(flow.current, remakeEvent({ budgetReservationId: "" })), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
  assert.equal(flow.current.status, "delivered");
});

test("a shot keeps at most the directions it may hold; a further direction is refused", () => {
  const full = structuredClone(deliveredFlow().current);
  full.shots[SHOT_A] = { ...full.shots[SHOT_A]!, directives: Array.from({ length: REMAKE_DIRECTIVES_MAX }, (_, index) => `direction ${index}`) };
  assert.throws(() => advance(full, remakeEvent()), (error: unknown) => error instanceof EngineError && error.kind === "conflict");
  // Without a direction there is nothing to keep, so the remake is still allowed.
  assert.equal(advance(full, remakeEvent({ directive: null })).state.status, "running");
});

test("replaying the same remake from the same state gives the same jobs and keys", () => {
  const flow = deliveredFlow();
  const first = advance(flow.current, remakeEvent());
  const second = advance(flow.current, remakeEvent());
  assert.deepEqual(
    first.jobs.map((job) => job.key),
    second.jobs.map((job) => job.key),
  );
});

test("a direction is stored as plain text: whitespace and control characters are collapsed, and blank means none", () => {
  assert.equal(remakeDirectiveOf("  make the\n\tcup   bigger "), "make the cup bigger");
  assert.equal(remakeDirectiveOf("a\u0007b"), "a b");
  assert.equal(remakeDirectiveOf("   "), null);
  assert.equal(remakeDirectiveOf(""), null);
  assert.equal(remakeDirectiveOf(null), null);
  assert.equal(remakeDirectiveOf(undefined), null);
});

test("a direction longer than the limit is refused, not cut", () => {
  assert.equal(remakeDirectiveOf("x".repeat(REMAKE_DIRECTIVE_MAX_CHARS))?.length, REMAKE_DIRECTIVE_MAX_CHARS);
  assert.throws(() => remakeDirectiveOf("x".repeat(REMAKE_DIRECTIVE_MAX_CHARS + 1)), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
});

test("a produce job's directions are read from its details; an absent list is none, and a malformed one is refused", () => {
  assert.deepEqual(directivesOf({}), []);
  assert.deepEqual(directivesOf({ directives: [DIRECTION] }), [DIRECTION]);
  assert.throws(() => directivesOf({ directives: "not a list" }), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
});

test("the prompt is unchanged without directions, and carries them in a labelled block with them", () => {
  assert.equal(promptWithDirectives("A product on a table.", []), "A product on a table.");
  const prompt = promptWithDirectives("A product on a table.", [DIRECTION]);
  assert.ok(prompt.startsWith("A product on a table.\n\n"));
  assert.match(prompt, /Reviewer's direction for this take/);
  assert.ok(prompt.includes(`- ${DIRECTION}`));
});
