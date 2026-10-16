import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError } from "../contracts/index.ts";
import { FIXTURE_IDS, manifestFixture, scenePlanFixture, takeVerdictFixture } from "../contracts/fixtures/index.ts";
import { emitLearningEvent, emitLearningEvents, type EventScope } from "./emit.ts";
import { EVENT_KINDS, learningEventSchema, type LearningEvent } from "./schema.ts";
import { memoryEventStore } from "./store.ts";

const SCOPE: EventScope = { organizationId: "ws_events", requestId: FIXTURE_IDS.request };
const AT = "2026-10-13T09:07:00.000Z";

const delivered: LearningEvent = {
  kind: "video.delivered",
  stage: "deliver",
  subjectId: FIXTURE_IDS.video,
  dedupeKey: `video:${FIXTURE_IDS.video}`,
  body: {
    manifestId: FIXTURE_IDS.video,
    requestId: FIXTURE_IDS.request,
    edlId: FIXTURE_IDS.edl,
    variantOf: null,
    cost: manifestFixture.cost,
    timings: { total: 300000 },
    configVersions: { thresholds: "thresholds@2" },
  },
};

function reconciled(overrides: Partial<Record<string, unknown>> = {}): LearningEvent {
  return {
    kind: "cost.reconciled",
    stage: "deliver",
    subjectId: FIXTURE_IDS.ledgerRender,
    dedupeKey: `cost:${FIXTURE_IDS.ledgerRender}`,
    body: {
      entryId: FIXTURE_IDS.ledgerRender,
      requestId: FIXTURE_IDS.request,
      stage: "render",
      provider: "hyperframes-cloud",
      model: "hyperframes",
      role: null,
      estimateUsd: 0.05,
      reservedUsd: 0.05,
      actualUsd: 0.047,
      settlement: "billed",
      videoId: FIXTURE_IDS.video,
      ...overrides,
    },
  } as LearningEvent;
}

describe("the learning event schemas (Bible 16.1)", () => {
  it("names every event of Bible 16.1, and the delivery and variant events the engine adds", () => {
    assert.deepEqual(
      [...EVENT_KINDS],
      [
        "plan.decided",
        "take.checked",
        "shot.downgraded",
        "review.decided",
        "gate.result",
        "video.delivered",
        "cost.reconciled",
        "request.delivered",
        "variant.delivered",
        "variant.planned",
      ],
    );
  });

  it("accepts a delivered video with its cost breakdown and timings", () => {
    assert.equal(learningEventSchema.safeParse(delivered).success, true);
  });

  it("refuses a cost breakdown whose total is not the sum of its parts", () => {
    const bad = structuredClone(delivered) as Extract<LearningEvent, { kind: "video.delivered" }>;
    bad.body.cost = { ...bad.body.cost, total: bad.body.cost.total + 1 };
    assert.equal(learningEventSchema.safeParse(bad).success, false);
  });

  it("refuses a cost event with a kind it does not own, and a missing dedupe key", () => {
    const wrongStage = { ...reconciled(), stage: "plan" } as unknown as LearningEvent;
    assert.equal(learningEventSchema.safeParse(wrongStage).success, false);
    const noKey = { ...reconciled(), dedupeKey: "" } as unknown as LearningEvent;
    assert.equal(learningEventSchema.safeParse(noKey).success, false);
  });

  it("a take check keeps rule names and scores, and drops the free-text detail of a check", () => {
    const check = {
      kind: "take.checked",
      stage: "check_take",
      subjectId: FIXTURE_IDS.take3a,
      dedupeKey: `take:${FIXTURE_IDS.take3a}`,
      body: {
        takeId: FIXTURE_IDS.take3a,
        shotId: FIXTURE_IDS.shot3,
        visualType: "product_hero",
        provider: "openrouter",
        model: "seedance-2.0-mini",
        promptVersion: "critic_take@1",
        pass: false,
        confidence: 0.84,
        action: "redo",
        checks: takeVerdictFixture.checks.map((item) => ({ rule: item.rule, pass: item.pass, score: item.score })),
      },
    } as unknown as LearningEvent;
    assert.equal(learningEventSchema.safeParse(check).success, true);
    const withDetail = {
      ...check,
      body: { ...check.body, checks: [{ rule: "slop.hands", pass: false, detail: "model text that must not be stored" }] },
    } as unknown as LearningEvent;
    const parsed = learningEventSchema.parse(withDetail) as Extract<LearningEvent, { kind: "take.checked" }>;
    assert.equal("detail" in (parsed.body.checks[0] ?? {}), false, "the detail is dropped");
  });

  it("a plan decision carries the decisions of the plan with their alternatives", () => {
    const planned = {
      kind: "plan.decided",
      stage: "plan",
      subjectId: scenePlanFixture.planId,
      dedupeKey: `plan:${scenePlanFixture.planId}`,
      body: { planId: scenePlanFixture.planId, decisions: scenePlanFixture.decisions },
    } as LearningEvent;
    assert.equal(learningEventSchema.safeParse(planned).success, true);
  });
});

describe("emitting learning events", () => {
  it("appends a valid event with its scope and time", async () => {
    const store = memoryEventStore();
    const outcome = await emitLearningEvent(store, SCOPE, delivered, { at: AT, jobId: "job_1" });
    assert.deepEqual(outcome, { created: true });
    const rows = await store.list(SCOPE);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.kind, "video.delivered");
    assert.equal(rows[0]?.jobId, "job_1");
    assert.equal(rows[0]?.at, AT);
  });

  it("stores an event with the same dedupe key once", async () => {
    const store = memoryEventStore();
    const first = await emitLearningEvent(store, SCOPE, reconciled(), { at: AT });
    const second = await emitLearningEvent(store, SCOPE, reconciled(), { at: AT });
    assert.deepEqual([first.created, second.created], [true, false]);
    assert.equal((await store.list(SCOPE)).length, 1);
  });

  it("keeps the same dedupe key apart in another workspace", async () => {
    const store = memoryEventStore();
    await emitLearningEvent(store, SCOPE, reconciled(), { at: AT });
    const other = await emitLearningEvent(store, { ...SCOPE, organizationId: "ws_other" }, reconciled(), { at: AT });
    assert.equal(other.created, true);
  });

  it("refuses an invalid event before anything is stored, and names the path", async () => {
    const store = memoryEventStore();
    const bad = reconciled({ actualUsd: -1 });
    await assert.rejects(emitLearningEvent(store, SCOPE, bad, { at: AT }), (error: unknown) => {
      return error instanceof EngineError && error.kind === "invalid_input" && /actualUsd/.test(error.message);
    });
    assert.equal((await store.list(SCOPE)).length, 0);
  });

  it("accepts a cost event of a call with no bill yet: null actual and null settlement (contract v6)", () => {
    const held = reconciled({ actualUsd: null, settlement: null });
    assert.equal(learningEventSchema.safeParse(held).success, true);
    const absent = reconciled({ actualUsd: 0, settlement: "confirmed_absent" });
    assert.equal(learningEventSchema.safeParse(absent).success, true);
  });

  it("refuses an event with no valid time", async () => {
    const store = memoryEventStore();
    await assert.rejects(emitLearningEvent(store, SCOPE, reconciled(), { at: "not a time" }), (error: unknown) => error instanceof EngineError);
  });

  it("emits a batch in order and counts what was new", async () => {
    const store = memoryEventStore();
    const outcome = await emitLearningEvents(store, SCOPE, [reconciled(), reconciled(), delivered], { at: AT });
    assert.deepEqual(outcome, { created: 2, duplicate: 1 });
    assert.deepEqual(
      (await store.list(SCOPE)).map((row) => row.kind),
      ["cost.reconciled", "video.delivered"],
    );
  });

  it("a variant plan event needs a dedupe key, and is stored once per key", async () => {
    const store = memoryEventStore();
    const variant = {
      kind: "variant.planned",
      stage: "variants",
      subjectId: FIXTURE_IDS.request,
      dedupeKey: "",
      body: {
        key: "caption:upper",
        attribute: "caption",
        value: "upper",
        controlEdlId: FIXTURE_IDS.edl,
        status: "built",
        reason: null,
        estimateUsd: 0.07,
        work: { produceShotIds: [], voiceBeatIds: [], writerBeatIds: [] },
      },
    } as unknown as LearningEvent;
    assert.equal(learningEventSchema.safeParse(variant).success, false, "an empty dedupe key is refused");
    const keyed = { ...variant, dedupeKey: "variant-planned:caption:upper" } as LearningEvent;
    assert.equal((await emitLearningEvent(store, SCOPE, keyed, { at: AT })).created, true);
    assert.equal((await emitLearningEvent(store, SCOPE, keyed, { at: AT })).created, false);
  });
});
