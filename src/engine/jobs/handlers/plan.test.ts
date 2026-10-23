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
import { readFileSync } from "node:fs";
import type { ModelChoices } from "../../contracts/model-choices.ts";
import { parseModelsCatalog, parseVideoCatalog, type CatalogRead, type ModelCatalogSource } from "../../gateway/catalog.ts";
import { json } from "../../claude/test/helpers.ts";
import { plannedCallsOf } from "../../plan/model-choices.ts";

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

test("a cartoon chain is summarised as a chain: its first call's model class, and one take (contract v5)", () => {
  assert.deepEqual(shotSummaryOf(cartoonChainShotFixture), {
    shotId: cartoonChainShotFixture.shotId,
    visualType: "cartoon_generated",
    downgradeTo: "cartoon_rigged",
    sourceKind: "chain",
    modelClass: "image.keyframe",
    takesWanted: 1,
  });
});

test("a stop-motion chain (it ends in an image) is refused with no summary, so no plan the orchestrator cannot run is stored", () => {
  const stopMotion = {
    ...cartoonChainShotFixture,
    shotId: "shot_stop_motion_fixture",
    visualType: "stop_motion" as const,
    source: {
      kind: "chain" as const,
      calls: [
        { output: "frame_01", modelClass: "image.edit" as const, prompt: "frame one", refs: [{ kind: "asset" as const, uri: "store://products/hero.png" }], takes: 1 as const },
        { output: "frame_02", modelClass: "image.edit" as const, prompt: "frame two", refs: [{ kind: "output" as const, output: "frame_01" }], takes: 1 as const },
      ],
    },
  };
  assert.throws(
    () => shotSummaryOf(stopMotion),
    (error: unknown) => error instanceof EngineError && error.kind === "not_implemented" && error.message.includes("ends in an image"),
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

const CATALOG_READ_AT = "2026-10-16T09:00:00.000Z";
const gatewayFixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../gateway/test/fixtures/${name}.json`, import.meta.url), "utf8"));

/** A catalog over the gateway's recorded listings (unverified live), counting its reads. */
function recordedCatalog(): ModelCatalogSource & { reads: number } {
  const read: CatalogRead = {
    status: "read",
    catalog: {
      readAt: CATALOG_READ_AT,
      entries: [
        ...parseVideoCatalog(gatewayFixture("openrouter-catalog-videos"), CATALOG_READ_AT).entries,
        ...parseModelsCatalog("image", gatewayFixture("openrouter-catalog-image"), CATALOG_READ_AT).entries,
        // The fixture plan's clips are 1.5 s with a first frame and a reference; none of the recorded models fits them, this one does.
        {
          id: "vendor/short-clip",
          modelClasses: ["video.budget"],
          capabilities: { minSeconds: 1, maxSeconds: 10, aspectRatios: ["9:16"], resolutions: ["1080p"], firstFrame: true, lastFrame: false, refsMax: 2, audio: false },
          price: { unit: "per_second", usd: 0.03, sku: "per-video-second" },
          readAt: CATALOG_READ_AT,
        },
      ],
      dropped: [],
      failed: [],
      videoListing: null,
    },
  };
  const source = { reads: 0, async read() { source.reads += 1; return read; } };
  return source;
}

/**
 * A model_chooser answer: c1 picks the one candidate, c2 picks an id that is no candidate, and the rest get no pick. The recorded models
 * take 5 s or more, so none fits a 1.5 s clip: those calls take the first eligible catalog candidate.
 */
const chooserAnswer = json(200, {
  id: "gen-plan-chooser",
  model: "anthropic/claude-haiku-5.5",
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: JSON.stringify({
          picks: [
            { callId: "c1", modelId: "vendor/short-clip", reason: "The only candidate that lists 1.5 s with a first frame." },
            { callId: "c2", modelId: "vendor/not-listed", reason: "x" },
          ],
        }),
      },
    },
  ],
  usage: { prompt_tokens: 2000, completion_tokens: 40, cost: 0.0022 },
});

const PLAN_ANSWERS = ["openrouter-request-classifier-ok", "openrouter-planner-ok", "openrouter-director-ok"];

test("with a catalog, a passing plan is followed by one model_chooser call, and the request's model_choices artifact is written once", async () => {
  const catalog = recordedCatalog();
  const first = await depsWith([...PLAN_ANSWERS.map((name) => recordedAnswer(name)), chooserAnswer], 4);
  const ports: PlanPorts = { loadKits: async () => kits(), roleDeps: () => first.deps, catalog };
  const ctx = contextFor(FIXTURE_IDS.reservation);
  const result = await createPlanHandler(ports).run(ctx);
  if (result.kind !== "done" || result.output.stage !== "plan") assert.fail("expected a plan output");
  assert.equal(result.output.gate.pass, true);
  assert.equal(catalog.reads, 1, "one catalog read for the request");
  const chooserCalls = first.requests.filter((request) => String(request.body).includes("model_chooser_answer"));
  assert.equal(chooserCalls.length, 1, "one model_chooser call for the whole request");

  const choicesId = result.output.artifacts.model_choices;
  assert.ok(choicesId?.startsWith("art_"), "the model_choices artifact is named in the output");
  const stored = await readArtifact(db.sql, { organizationId: WS, artifactId: choicesId });
  assert.equal(stored.envelope.type, "model_choices");
  assert.deepEqual(stored.envelope.parentIds, [result.output.artifacts.plan]);
  const body = stored.envelope.body as ModelChoices;
  const plan = (await readArtifact(db.sql, { organizationId: WS, artifactId: result.output.artifacts.plan ?? "" })).envelope.body as ScenePlan;
  const calls = plannedCallsOf(plan);
  const firstClip = calls.find((call) => call.modelClass === "video.budget");
  // The valid pick is kept. A refused or missing pick takes the first eligible catalog candidate (model-choice.ts), labelled a fallback.
  const chosen = body.choices.find((entry) => entry.shotId === firstClip?.shotId && entry.output === "shot");
  assert.equal(chosen?.modelChoice.modelId, "vendor/short-clip");
  assert.equal(chosen?.modelChoice.source, "orchestrator");
  for (const entry of body.choices) {
    if (entry === chosen) continue;
    assert.equal(entry.modelChoice.source, "fallback", `${entry.shotId} ${entry.output}: a refused or missing pick takes the first eligible catalog candidate`);
  }
  assert.equal(body.catalogReadAt, CATALOG_READ_AT);
  assert.ok(calls.length > 0, "the fixture plan has paid calls");
  for (const call of calls) {
    assert.ok(plan.decisions.some((decision) => decision.reason.startsWith(`${call.shotId} ${call.output}: `)), `a decision records ${call.shotId} ${call.output}`);
  }
  assert.doesNotThrow(() => validateStageOutput(result.output, ctx.payload));

  // A retry of the job reuses the stored artifact: no catalog read and no second chooser call.
  const retry = await depsWith(PLAN_ANSWERS.map((name) => recordedAnswer(name)), 4);
  const again = await createPlanHandler({ ...ports, roleDeps: () => retry.deps }).run(ctx);
  if (again.kind !== "done" || again.output.stage !== "plan") assert.fail("expected a plan output");
  assert.equal(again.output.artifacts.model_choices, choicesId, "the request keeps its one model_choices artifact");
  assert.equal(catalog.reads, 1);
  assert.equal(retry.requests.filter((request) => String(request.body).includes("model_chooser_answer")).length, 0);
});

test("without a catalog, the plan stage writes no model_choices and makes no chooser call", async () => {
  const ports = await portsWith(PLAN_ANSWERS, 4);
  const result = await createPlanHandler(ports).run(contextFor(FIXTURE_IDS.reservation));
  if (result.kind !== "done" || result.output.stage !== "plan") assert.fail("expected a plan output");
  assert.equal(result.output.artifacts.model_choices, undefined);
});
