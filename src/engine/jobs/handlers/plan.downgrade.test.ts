// The plan stage's downgrade replan through the stage handler (Bible 5.3, 7.1): a directive names one shot, the handler reads the plan it
// changes, writes a new scene_plan parented on it, and hands the replanned shot back in its output. A rewrite replan and a refused replan
// are not successes. Recorded answers and a real PGlite database; no live call.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ScenePlan } from "../../contracts/index.ts";
import { FIXTURE_IDS, videoDnaFixture, voiceTrackFixture, WORKSPACE_ID } from "../../contracts/fixtures/index.ts";
import { depsWith, fixtureKitBodies, recordedAnswer, validatedWithBudget } from "../../plan/test/helpers.ts";
import { readArtifact, writeArtifact } from "../artifact-store.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../test/pg-test-db.ts";
import type { EnginePayload, StageContext, StageOutput } from "../types.ts";
import { validateStageOutput } from "../validate.ts";
import { createPlanHandler, type PlanPorts } from "./plan.ts";
import type { KitScope, ResolvedKits } from "./intake.ts";

const WS = WORKSPACE_ID;
const REQ = FIXTURE_IDS.request;
const CREATED = "2026-10-13T09:00:05.000Z";
/** A product_hero shot whose 7.1 fallback is coded_graphics, a component: its replan needs no planner call. */
const PRODUCT_SHOT = "shot_2PS5J74HZEQ3ZRM229HZ5CNPYK";

let db: TestDatabase;
let validatedId: string;
let dnaId: string;
let voiceId: string;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, "brand_fixture");
  await db.sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
    values (${REQ}, ${WS}, 'brand_fixture', 'fmt_fixture', 'normal', 'running', '{}')
  `;
  validatedId = (await writeArtifact(db.sql, {
    organizationId: WS,
    requestId: REQ,
    stage: "intake",
    type: "validated_request",
    body: validatedWithBudget(4),
    createdAt: CREATED,
  })).artifactId;
  dnaId = (await writeArtifact(db.sql, {
    organizationId: WS,
    requestId: REQ,
    stage: "analyze_reference",
    type: "video_dna",
    body: videoDnaFixture,
    createdAt: CREATED,
  })).artifactId;
  voiceId = (await writeArtifact(db.sql, {
    organizationId: WS,
    requestId: REQ,
    stage: "voice",
    type: "voice_track",
    body: voiceTrackFixture,
    createdAt: CREATED,
  })).artifactId;
});

after(async () => {
  await db.close();
});

function kits(): ResolvedKits {
  const bodies = fixtureKitBodies();
  return { styleKit: bodies.styleKit, persona: bodies.persona, productKit: bodies.productKit, characters: bodies.characters, voice: undefined };
}

async function portsWith(answers: string[], reservedUsd: number): Promise<PlanPorts> {
  const { deps } = await depsWith(answers.map((name) => recordedAnswer(name)), reservedUsd);
  return {
    loadKits: async (_scope: KitScope) => kits(),
    roleDeps: () => deps,
  };
}

function contextFor(inputs: string[], details: Record<string, unknown>, reservationId: string | null, subjectId = REQ): StageContext {
  const payload: EnginePayload = {
    organizationId: WS,
    requestId: REQ,
    stage: "plan",
    subjectId,
    attempt: "1",
    priority: "normal",
    budgetReservationId: reservationId,
    inputArtifactIds: inputs,
    hints: [],
    details,
  };
  return {
    sql: db.sql,
    jobId: `job_plan_${subjectId}`,
    organizationId: WS,
    requestId: REQ,
    stage: "plan",
    subjectId,
    attempt: "1",
    payload,
    signal: new AbortController().signal,
  };
}

/** A full first plan, stored as the scene_plan artifact the replan changes. */
async function storedFirstPlan(): Promise<string> {
  const ports = await portsWith(["openrouter-request-classifier-ok", "openrouter-planner-ok", "openrouter-director-ok"], 4);
  const result = await createPlanHandler(ports).run(contextFor([validatedId, dnaId, voiceId], {}, FIXTURE_IDS.reservation));
  if (result.kind !== "done" || result.output.stage !== "plan") assert.fail("expected the first plan");
  assert.equal(result.output.gate.pass, true, JSON.stringify(result.output.gate.checks.filter((check) => !check.pass)));
  const planId = result.output.artifacts.plan;
  assert.ok(planId, "the first plan is stored");
  return planId;
}

test("a downgrade directive replans the named shot: a new scene_plan parented on the old one, and the replanned shot in the output", async () => {
  const firstPlanId = await storedFirstPlan();
  const ports = await portsWith(["openrouter-request-classifier-ok"], 4);
  const ctx = contextFor(
    [validatedId, dnaId, voiceId, firstPlanId],
    { directive: "downgrade", shotId: PRODUCT_SHOT, visualType: "product_hero", downgradeTo: "coded_graphics" },
    FIXTURE_IDS.reservation,
    PRODUCT_SHOT,
  );
  const result = await createPlanHandler(ports).run(ctx);
  assert.equal(result.kind, "done");
  if (result.kind !== "done" || result.output.stage !== "plan") assert.fail("expected a plan output");
  const output: Extract<StageOutput, { stage: "plan" }> = result.output;

  assert.equal(output.subjectId, PRODUCT_SHOT, "the replan reports for the shot it changes");
  assert.equal(output.gate.pass, true, JSON.stringify(output.gate.checks.filter((check) => !check.pass)));
  assert.ok(output.artifacts.plan && output.artifacts.plan !== firstPlanId, "the replan writes a new scene plan");
  const stored = await readArtifact(db.sql, { organizationId: WS, artifactId: output.artifacts.plan });
  assert.equal(stored.envelope.type, "scene_plan");
  assert.ok(stored.envelope.parentIds.includes(firstPlanId), "the new plan is parented on the plan it changes");
  const plan = stored.envelope.body as ScenePlan;
  assert.equal(plan.shots.find((shot) => shot.shotId === PRODUCT_SHOT)?.visualType, "coded_graphics");
  assert.deepEqual(output.shots.map((shot) => [shot.shotId, shot.visualType]), [[PRODUCT_SHOT, "coded_graphics"]]);
  assert.doesNotThrow(() => validateStageOutput(output, ctx.payload));
});

test("a rewrite directive is not built, and a downgrade with no shot or no reservation makes no call and says why", async () => {
  const firstPlanId = await storedFirstPlan();
  const ports = await portsWith([], 4);
  const inputs = [validatedId, dnaId, voiceId, firstPlanId];

  await assert.rejects(
    createPlanHandler(ports).run(contextFor(inputs, { directive: "rewrite", shotId: PRODUCT_SHOT }, FIXTURE_IDS.reservation, PRODUCT_SHOT)),
    /rewrite replan is not built/,
  );
  await assert.rejects(
    createPlanHandler(ports).run(contextFor(inputs, { directive: "downgrade" }, FIXTURE_IDS.reservation)),
    /names the shot it changes/,
  );
  await assert.rejects(
    createPlanHandler(ports).run(contextFor(inputs, { directive: "downgrade", shotId: PRODUCT_SHOT }, null, PRODUCT_SHOT)),
    /needs its budget reservation/,
  );
});
