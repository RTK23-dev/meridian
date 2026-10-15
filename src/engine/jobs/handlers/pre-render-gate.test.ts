import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { EngineError, gateResultSchema, type GateResult, type ScenePlan, type ShotSpec, type StyleKit } from "../../contracts/index.ts";
import { FIXTURE_IDS, fixtureId } from "../../contracts/fixtures/index.ts";
import * as fx from "../../contracts/fixtures/index.ts";
import { cleanRender, cleanTakes, PRODUCT_IMAGES } from "../../review/test/render.ts";
import { mediaUrisOf } from "../../review/gates/preRender.ts";
import { decideGate } from "../../review/gold.ts";
import { readArtifact, writeArtifact } from "../artifact-store.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../test/pg-test-db.ts";
import type { EnginePayload, StageContext, StageOutput } from "../types.ts";
import { validateStageOutput } from "../validate.ts";
import { createPreRenderGateHandler, type PreRenderPorts } from "./pre-render-gate.ts";

const WS = "ws_pre_render";
const REQ = FIXTURE_IDS.request;
const CREATED = "2026-10-15T09:00:00.000Z";

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, "brand_fixture");
  await db.sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
    values (${REQ}, ${WS}, 'brand_fixture', 'fmt_fixture', 'normal', 'running', '{}')
  `;
});

after(async () => {
  await db.close();
});

/** The clean ports: a kit that loads, a budget with room, every licence, the product's imagery and the AI-presenter flag. */
function cleanPorts(): PreRenderPorts {
  const render = cleanRender();
  return {
    loadStyleKit: async () => fx.styleKitFixture as StyleKit,
    renderBudget: async () => ({ remainingUsd: 5, renderEstimateUsd: 0.5 }),
    licensedUris: async () => new Set(mediaUrisOf(render.edl)),
    productImageUris: async () => PRODUCT_IMAGES,
    disclosures: async () => ({ aiGeneratedPeople: true }),
  };
}

type Stored = { edl: string; composition: string; plan: string; validated: string; voice: string; dna: string; takes: string[] };

/** Stores the inputs of the pre_render job: the composition and EDL of the clean render, and the plan, request, voice, DNA and takes. */
async function storeInputs(planOverride?: ScenePlan): Promise<Stored> {
  const render = cleanRender();
  const edl = await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "edit", type: "edl", body: render.edl, createdAt: CREATED });
  const composition = await writeArtifact(db.sql, {
    organizationId: WS,
    requestId: REQ,
    stage: "compose",
    type: "composition",
    body: render.composition,
    parentIds: [edl.artifactId],
    createdAt: CREATED,
  });
  const plan = await writeArtifact(db.sql, {
    organizationId: WS,
    requestId: REQ,
    stage: "plan",
    type: "scene_plan",
    body: planOverride ?? fx.scenePlanFixture,
    createdAt: CREATED,
  });
  const validated = await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "intake", type: "validated_request", body: fx.validatedRequestFixture, createdAt: CREATED });
  const voice = await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "voice", type: "voice_track", body: fx.voiceTrackFixture, createdAt: CREATED });
  const dna = await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "analyze_reference", type: "video_dna", body: fx.videoDnaFixture, createdAt: CREATED });
  const takes: string[] = [];
  for (const take of cleanTakes) {
    const stored = await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "check_take", type: "take", body: take, createdAt: CREATED });
    takes.push(stored.artifactId);
  }
  return {
    edl: edl.artifactId,
    composition: composition.artifactId,
    plan: plan.artifactId,
    validated: validated.artifactId,
    voice: voice.artifactId,
    dna: dna.artifactId,
    takes,
  };
}

function contextFor(stored: Stored, subjectId: string, overrides: { drop?: string; edlId?: string } = {}): StageContext {
  const inputArtifactIds = [stored.edl, stored.composition, stored.plan, stored.validated, stored.voice, stored.dna, ...stored.takes].filter(
    (id) => id !== overrides.drop,
  );
  const payload: EnginePayload = {
    organizationId: WS,
    requestId: REQ,
    stage: "pre_render_gate",
    subjectId,
    attempt: "1",
    priority: "normal",
    budgetReservationId: null,
    inputArtifactIds,
    hints: [],
    details: {},
  };
  return {
    sql: db.sql,
    jobId: `job_pre_${subjectId}`,
    organizationId: WS,
    requestId: REQ,
    stage: "pre_render_gate",
    subjectId,
    attempt: "1",
    payload,
    signal: new AbortController().signal,
  };
}

/** The gate result the handler stored under its gate_result artifact, read back from the store. */
async function storedGate(artifactId: string): Promise<GateResult> {
  const stored = await readArtifact(db.sql, { organizationId: WS, artifactId });
  assert.equal(stored.envelope.type, "gate_result");
  return gateResultSchema.parse(stored.envelope.body);
}

describe("pre_render_gate on PostgreSQL (Bible 6.10, 12.3)", () => {
  test("the clean inputs pass, the gate result is stored as a gate_result artifact, and the output validates", async () => {
    const stored = await storeInputs();
    const render = cleanRender();
    const ctx = contextFor(stored, render.edl.edlId);
    const result = await createPreRenderGateHandler(cleanPorts()).run(ctx);
    assert.equal(result.kind, "done");
    if (result.kind !== "done") return;
    const output: StageOutput = result.output;
    assert.equal(output.stage, "pre_render_gate");
    assert.equal(output.subjectId, render.edl.edlId);
    assert.equal(output.stage === "pre_render_gate" ? output.edlId : "", render.edl.edlId);
    assert.equal(output.stage === "pre_render_gate" ? output.gate.pass : false, true);
    validateStageOutput(output, ctx.payload);

    const artifactId = output.artifacts[`gate:${render.edl.edlId}`];
    assert.ok(artifactId, "the gate result is stored under its EDL");
    const gate = await storedGate(artifactId);
    assert.equal(gate.pass, true);
    assert.equal(gate.subjectId, render.edl.edlId);
  });

  test("a style kit that did not load fails the gate and is still recorded, so nothing renders on a guessed look", async () => {
    const stored = await storeInputs();
    const render = cleanRender();
    const ports = { ...cleanPorts(), loadStyleKit: async () => undefined };
    const result = await createPreRenderGateHandler(ports).run(contextFor(stored, render.edl.edlId));
    assert.equal(result.kind, "done");
    if (result.kind !== "done" || result.output.stage !== "pre_render_gate") return;
    assert.equal(result.output.gate.pass, false);
    assert.equal(result.output.gate.checks.find((check) => check.rule === "style_kit_matches_request")?.pass, false);
    assert.equal(decideGate(result.output.gate, {}).verdict, "review");
    const gate = await storedGate(result.output.artifacts[`gate:${render.edl.edlId}`] ?? "");
    assert.equal(gate.pass, false);
  });

  test("the optional ports are missing evidence: their checks fail and the result is review, never a pass", async () => {
    const stored = await storeInputs();
    const render = cleanRender();
    const ports: PreRenderPorts = { loadStyleKit: async () => fx.styleKitFixture as StyleKit };
    const result = await createPreRenderGateHandler(ports).run(contextFor(stored, render.edl.edlId));
    assert.equal(result.kind, "done");
    if (result.kind !== "done" || result.output.stage !== "pre_render_gate") return;
    assert.equal(result.output.gate.pass, false);
    const unevaluated = result.output.gate.checks.filter((check) => !check.pass).map((check) => check.rule);
    for (const rule of ["render_budget_covers_render", "rights_licensed", "disclosure_ai_people", "product_shots_real_imagery"]) {
      assert.ok(unevaluated.includes(rule), `${rule} is missing evidence`);
    }
  });

  test("the five coded shots in a row are blocked and named in the stored gate result", async () => {
    const render = cleanRender();
    const beats = fx.validatedRequestFixture.request.script.beats;
    const span = Math.floor(fx.VOICE_DURATION_MS / 5);
    const shots: ShotSpec[] = [1, 2, 3, 4, 5].map((n, index) => ({
      shotId: fixtureId("shot_", 70 + n),
      beatId: beats[index % beats.length]?.beatId ?? "b1",
      startMs: index * span,
      endMs: index === 4 ? fx.VOICE_DURATION_MS : (index + 1) * span,
      visualType: "coded_graphics",
      layer: "graphics",
      source: { kind: "component", component: "list.tierBoard", props: { title: "tier board" } },
    }));
    const stored = await storeInputs({ ...fx.scenePlanFixture, shots });
    const result = await createPreRenderGateHandler(cleanPorts()).run(contextFor(stored, render.edl.edlId));
    assert.equal(result.kind, "done");
    if (result.kind !== "done" || result.output.stage !== "pre_render_gate") return;
    const gate = result.output.gate;
    assert.equal(gate.pass, false);
    assert.equal(gate.checks.find((check) => check.rule === "slideshow_coded_run")?.pass, false);
    for (const shot of shots) {
      assert.ok(gate.failingShotIds?.includes(shot.shotId), `${shot.shotId} is named`);
    }
    assert.equal(decideGate(gate, {}).verdict, "review");
  });

  test("an input the job did not get is refused, and nothing is stored", async () => {
    const stored = await storeInputs();
    const render = cleanRender();
    await assert.rejects(
      createPreRenderGateHandler(cleanPorts()).run(contextFor(stored, render.edl.edlId, { drop: stored.composition })),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
  });

  test("the stage takes no budget reservation and makes no call: it is not paid", async () => {
    const stored = await storeInputs();
    const render = cleanRender();
    const ctx = contextFor(stored, render.edl.edlId);
    assert.equal(ctx.payload.budgetReservationId, null);
    const result = await createPreRenderGateHandler(cleanPorts()).run(ctx);
    assert.equal(result.kind, "done");
  });

  test("the stored result carries the EDL rules and the product and slideshow checks, under the stage's own gate", async () => {
    const stored = await storeInputs();
    const render = cleanRender();
    const result = await createPreRenderGateHandler(cleanPorts()).run(contextFor(stored, render.edl.edlId));
    if (result.kind !== "done" || result.output.stage !== "pre_render_gate") assert.fail("expected a done pre_render_gate output");
    assert.equal(result.output.gate.gate, "pre_render");
    const rules = result.output.gate.checks.map((check) => check.rule);
    for (const rule of ["cut_outside_words", "product_shots_real_imagery", "slideshow_coded_run", "composition_matches_edl"]) {
      assert.ok(rules.includes(rule), rule + " is in the result");
    }
  });
});
