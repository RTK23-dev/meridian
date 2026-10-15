import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { EngineError, type ScenePlan } from "../../contracts/index.ts";
import { cartoonChainShotFixture, FIXTURE_IDS, WORKSPACE_ID, videoDnaFixture, voiceTrackFixture } from "../../contracts/fixtures/index.ts";
import { fixtureKitBodies, depsWith, recordedAnswer, validatedWithBudget } from "../../plan/test/helpers.ts";
import { readArtifact, writeArtifact } from "../artifact-store.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../test/pg-test-db.ts";
import type { EnginePayload, StageContext, StageOutput } from "../types.ts";
import { validateStageOutput } from "../validate.ts";
import { createPlanHandler, shotSummaryOf, type PlanPorts } from "./plan.ts";
import type { KitScope, ResolvedKits } from "./intake.ts";

const WS = WORKSPACE_ID;
const REQ = FIXTURE_IDS.request;
const CREATED = "2026-10-13T09:00:05.000Z";

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

/** The plan ports for one run: the fixture kits, and the Claude deps of a ledger holding `reservedUsd`. */
async function portsWith(answers: string[], reservedUsd: number): Promise<PlanPorts> {
  const { deps } = await depsWith(answers.map((name) => recordedAnswer(name)), reservedUsd);
  return {
    loadKits: async (_scope: KitScope) => kits(),
    roleDeps: () => deps,
  };
}

function contextFor(reservationId: string | null): StageContext {
  const payload: EnginePayload = {
    organizationId: WS,
    requestId: REQ,
    stage: "plan",
    subjectId: REQ,
    attempt: "1",
    priority: "normal",
    budgetReservationId: reservationId,
    inputArtifactIds: [validatedId, dnaId, voiceId],
    hints: [],
    details: {},
  };
  return {
    sql: db.sql,
    jobId: "job_plan_test",
    organizationId: WS,
    requestId: REQ,
    stage: "plan",
    subjectId: REQ,
    attempt: "1",
    payload,
    signal: new AbortController().signal,
  };
}

test("the handler writes the scene plan on a pass, parented on its three inputs, and the output passes the job boundary", async () => {
  const ports = await portsWith(["openrouter-request-classifier-ok", "openrouter-planner-ok", "openrouter-director-ok"], 4);
  const ctx = contextFor(FIXTURE_IDS.reservation);
  const result = await createPlanHandler(ports).run(ctx);
  assert.equal(result.kind, "done");
  if (result.kind !== "done" || result.output.stage !== "plan") assert.fail("expected a plan output");
  const output: Extract<StageOutput, { stage: "plan" }> = result.output;

  assert.equal(output.gate.pass, true, JSON.stringify(output.gate.checks.filter((check) => !check.pass)));
  assert.ok(output.artifacts.plan?.startsWith("art_"), "the scene plan artifact is named");
  const stored = await readArtifact(db.sql, { organizationId: WS, artifactId: output.artifacts.plan });
  assert.equal(stored.envelope.type, "scene_plan");
  assert.deepEqual(stored.envelope.parentIds, [validatedId, dnaId, voiceId]);
  const plan = stored.envelope.body as ScenePlan;
  assert.equal(output.shots.length, 13, "the fixture request makes thirteen shots");
  assert.deepEqual(output.shots, plan.shots.map(shotSummaryOf));
  assert.doesNotThrow(() => validateStageOutput(output, ctx.payload));
});

test("the summary of a generated shot names its model class and its takes, and a component names no model", () => {
  const generated = shotSummaryOf({
    shotId: FIXTURE_IDS.shot3,
    beatId: "b3",
    startMs: 9000,
    endMs: 15000,
    visualType: "product_hero",
    layer: "base",
    source: { kind: "generate", modelClass: "video.budget", prompt: "Slow push-in.", refs: [], takes: 1 },
    downgradeTo: "coded_graphics",
  });
  assert.deepEqual(generated, {
    shotId: FIXTURE_IDS.shot3,
    visualType: "product_hero",
    downgradeTo: "coded_graphics",
    sourceKind: "generate",
    modelClass: "video.budget",
    takesWanted: 1,
  });
  const component = shotSummaryOf({
    shotId: FIXTURE_IDS.shot4,
    beatId: "b4",
    startMs: 15000,
    endMs: 21000,
    visualType: "coded_graphics",
    layer: "graphics",
    source: { kind: "component", component: "product.card", props: {} },
  });
  assert.deepEqual(component, {
    shotId: FIXTURE_IDS.shot4,
    visualType: "coded_graphics",
    downgradeTo: null,
    sourceKind: "component",
    modelClass: null,
    takesWanted: 1,
  });
});

test("a chain shot has no summary: the plan stage refuses it, because no stage produces a chain yet (contract v5)", () => {
  assert.throws(
    () => shotSummaryOf(cartoonChainShotFixture),
    (error: unknown) => error instanceof EngineError && error.kind === "not_implemented" && error.message.includes(cartoonChainShotFixture.shotId),
  );
});

test("a plan with no reservation is refused before any call: nothing is spent, and the stage says why", async () => {
  const ports = await portsWith([], 4);
  await assert.rejects(
    () => createPlanHandler(ports).run(contextFor(null)),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input" && /budget reservation/.test(error.message),
  );
});

test("a request whose classifier call is refused fails its gate, names the reason, and writes no plan", async () => {
  const ports = await portsWith([], 0);
  const ctx = contextFor(FIXTURE_IDS.reservation);
  const result = await createPlanHandler(ports).run(ctx);
  assert.equal(result.kind, "done");
  if (result.kind !== "done" || result.output.stage !== "plan") assert.fail("expected a plan output");
  assert.equal(result.output.gate.pass, false);
  assert.deepEqual(result.output.artifacts, {}, "nothing is written when the classifier did not answer");
  assert.deepEqual(result.output.shots, []);
  const check = result.output.gate.checks.find((item) => item.rule === "requests_classified");
  assert.equal(check?.pass, false);
  assert.match(check?.detail ?? "", /refused/);
  assert.doesNotThrow(() => validateStageOutput(result.output, ctx.payload));
});

test("a stage whose input is not a validated request is refused, not guessed", async () => {
  const ports = await portsWith([], 4);
  const ctx = contextFor(FIXTURE_IDS.reservation);
  ctx.payload.inputArtifactIds = [dnaId, voiceId];
  await assert.rejects(
    () => createPlanHandler(ports).run(ctx),
    (error: unknown) => error instanceof Error && /validated_request input artifact/.test(error.message),
  );
});
