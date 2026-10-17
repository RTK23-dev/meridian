import assert from "node:assert/strict";
import test from "node:test";
import { ARTIFACT_TYPES, EngineError, GATE_IDS } from "../contracts/index.ts";
import { thresholds } from "../config/thresholds.ts";
import {
  ENGINE_JOB_TYPES,
  ENGINE_POLL_JOB_TYPE,
  ENGINE_STAGES,
  STAGE_SPECS,
  engineJobKey,
  priorityNumber,
  stageFromJobType,
} from "./registry.ts";
import { jobSettings } from "./settings.ts";

test("the registry holds the 15 stages (Bible section 3, and write_script of contract v8) as engine.<stage> job types, in pipeline order", () => {
  assert.equal(ENGINE_STAGES.length, 15);
  assert.deepEqual(ENGINE_JOB_TYPES, [
    "engine.intake",
    "engine.analyze_reference",
    "engine.write_script",
    "engine.voice",
    "engine.plan",
    "engine.estimate_reserve",
    "engine.produce_shot",
    "engine.check_take",
    "engine.edit",
    "engine.compose",
    "engine.pre_render_gate",
    "engine.render",
    "engine.post_render_review",
    "engine.variants",
    "engine.deliver",
  ]);
  assert.equal(ENGINE_POLL_JOB_TYPE, "engine.poll");
});

test("every stage has the Bible's timeout class: 2 minutes for Claude stages, 10 for generation, 5 for render", () => {
  assert.equal(STAGE_SPECS.produce_shot.timeoutMs, 600_000);
  assert.equal(STAGE_SPECS.voice.timeoutMs, 600_000);
  assert.equal(STAGE_SPECS.render.timeoutMs, 300_000);
  assert.equal(STAGE_SPECS.intake.timeoutMs, 120_000);
  // The plan makes three Claude calls under one lease: three Claude leases (E3 lead decision 5).
  assert.equal(STAGE_SPECS.plan.timeoutMs, 3 * 120_000);
  assert.equal(STAGE_SPECS.check_take.timeoutMs, 120_000);
  for (const stage of ENGINE_STAGES) {
    assert.equal(STAGE_SPECS[stage].maxAttempts, 3, `${stage} gets 3 infrastructure attempts`);
    assert.equal(STAGE_SPECS[stage].maxAttempts, thresholds.jobs.maxAttempts);
  }
});

test("each stage names only real artifact types and gates, and the paid stages are the ones that spend", () => {
  for (const stage of ENGINE_STAGES) {
    const spec = STAGE_SPECS[stage];
    for (const type of [...spec.reads, ...spec.writes]) {
      assert.ok((ARTIFACT_TYPES as readonly string[]).includes(type), `${stage} names ${type}`);
    }
    if (spec.gate !== null) assert.ok((GATE_IDS as readonly string[]).includes(spec.gate), `${stage} names gate ${spec.gate}`);
  }
  assert.deepEqual(
    ENGINE_STAGES.filter((stage) => STAGE_SPECS[stage].paid),
    ["analyze_reference", "write_script", "voice", "plan", "produce_shot", "check_take", "render", "post_render_review", "variants"],
  );
  assert.deepEqual(STAGE_SPECS.produce_shot.writes, ["take"]);
  assert.deepEqual(STAGE_SPECS.deliver.writes, ["manifest"]);
});

test("rush runs before normal, and normal before batch (Bible 5.1)", () => {
  assert.equal(priorityNumber("rush"), jobSettings.priority.rush);
  assert.ok(priorityNumber("rush") < priorityNumber("normal"));
  assert.ok(priorityNumber("normal") < priorityNumber("batch"));
  assert.throws(() => priorityNumber("urgent" as "rush"), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
});

test("a job type that is not an engine stage is refused, never run as another stage", () => {
  assert.equal(stageFromJobType("engine.produce_shot"), "produce_shot");
  assert.throws(() => stageFromJobType("engine.render_everything"), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
  assert.throws(() => stageFromJobType("factory.discover"), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
});

test("an idempotency key has the Bible's shape and refuses a part that would blur it", () => {
  assert.equal(
    engineJobKey({ requestId: "req_1", stage: "produce_shot", subjectId: "shot_2", attempt: 3 }),
    "engine:req_1:produce_shot:shot_2:3",
  );
  assert.equal(engineJobKey({ requestId: "req_1", stage: "poll", subjectId: "shot_2", attempt: "3.1" }), "engine:req_1:poll:shot_2:3.1");
  assert.throws(() => engineJobKey({ requestId: "req_1", stage: "x", subjectId: "a:b", attempt: 1 }), (error: unknown) => error instanceof EngineError);
  assert.throws(() => engineJobKey({ requestId: "", stage: "x", subjectId: "a", attempt: 1 }), (error: unknown) => error instanceof EngineError);
});

test("poll settings are the initial values of Bible 15.2 (backoff from 5 seconds, doubling, capped at a minute)", () => {
  assert.deepEqual(jobSettings.poll, { initialMs: 5_000, factor: 2, maxMs: 60_000 });
});
