import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { contentHash, EngineError, scenePlanSchema, type StyleKit, type Take } from "../../contracts/index.ts";
import {
  FIXTURE_IDS,
  fixtureId,
  scenePlanFixture,
  styleKitFixture,
  take1Fixture,
  take2Fixture,
  take3bFixture,
  validatedRequestFixture,
  videoDnaFixture,
  voiceTrackFixture,
} from "../../contracts/fixtures/index.ts";
import { readArtifact, writeArtifact } from "../artifact-store.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../test/pg-test-db.ts";
import type { EnginePayload, StageContext, StageOutput } from "../types.ts";
import { validateStageOutput } from "../validate.ts";
import { createEditHandler, type EditPorts } from "./edit.ts";

const WS = "ws_edit";
const REQ = FIXTURE_IDS.request;
const OTHER_REQ = fixtureId("req_", 77);
const CREATED = "2026-10-13T09:00:05.000Z";

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, "brand_fixture");
  for (const id of [REQ, OTHER_REQ]) {
    await db.sql`
      insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
      values (${id}, ${WS}, 'brand_fixture', 'fmt_fixture', 'normal', 'running', '{}')
    `;
  }
});

after(async () => {
  await db.close();
});

type Stored = { plan: string; dna: string; voice: string; validated: string; takes: string[] };

/** The five inputs the orchestrator passes the edit job: the plan, the DNA, the voice, the validated request and the accepted takes. */
async function storeInputs(takes: Take[] = [take1Fixture, take2Fixture, take3bFixture]): Promise<Stored> {
  const plan = await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "plan", type: "scene_plan", body: scenePlanFixture, createdAt: CREATED });
  const dna = await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "analyze_reference", type: "video_dna", body: videoDnaFixture, createdAt: CREATED });
  const voice = await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "voice", type: "voice_track", body: voiceTrackFixture, createdAt: CREATED });
  const validated = await writeArtifact(db.sql, {
    organizationId: WS,
    requestId: REQ,
    stage: "intake",
    type: "validated_request",
    body: validatedRequestFixture,
    createdAt: CREATED,
  });
  const takeIds: string[] = [];
  for (const take of takes) {
    const stored = await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "check_take", type: "take", body: take, createdAt: CREATED });
    takeIds.push(stored.artifactId);
  }
  return { plan: plan.artifactId, dna: dna.artifactId, voice: voice.artifactId, validated: validated.artifactId, takes: takeIds };
}

function contextFor(inputArtifactIds: string[]): StageContext {
  const payload: EnginePayload = {
    organizationId: WS,
    requestId: REQ,
    stage: "edit",
    subjectId: REQ,
    attempt: "1",
    priority: "normal",
    budgetReservationId: null,
    inputArtifactIds,
    hints: [],
    details: {},
  };
  return {
    sql: db.sql,
    jobId: "job_edit_test",
    organizationId: WS,
    requestId: REQ,
    stage: "edit",
    subjectId: REQ,
    attempt: "1",
    payload,
    signal: new AbortController().signal,
  };
}

function ports(kit: StyleKit | undefined = structuredClone(styleKitFixture), music?: EditPorts["loadMusic"]): EditPorts {
  return {
    loadStyleKit: async () => (kit === undefined ? undefined : structuredClone(kit)),
    ...(music !== undefined ? { loadMusic: music } : {}),
  };
}

function editOutput(output: StageOutput): Extract<StageOutput, { stage: "edit" }> {
  if (output.stage !== "edit") assert.fail("expected an edit output");
  return output;
}

test("the handler builds the EDL, writes it with every input as its parent, and the output passes the job boundary", async () => {
  const inputs = await storeInputs();
  const ids = [inputs.plan, inputs.dna, inputs.voice, inputs.validated, ...inputs.takes];
  const ctx = contextFor(ids);
  const result = await createEditHandler(ports()).run(ctx);
  assert.equal(result.kind, "done");
  if (result.kind !== "done") return;
  const output = editOutput(result.output);

  assert.equal(output.gate.gate, "edit");
  assert.equal(output.gate.pass, true, JSON.stringify(output.gate.checks.filter((check) => !check.pass)));
  assert.equal(output.gate.subjectId, output.edlId);
  assert.ok(output.artifacts[`edl:${output.edlId}`]?.startsWith("art_"), "the EDL artifact is named in its slot");
  assert.doesNotThrow(() => validateStageOutput(output, ctx.payload));

  const stored = await readArtifact(db.sql, { organizationId: WS, artifactId: output.artifacts[`edl:${output.edlId}`] ?? "" });
  assert.equal(stored.envelope.type, "edl");
  assert.deepEqual([...stored.envelope.parentIds].sort(), [...ids].sort());
  const body = stored.envelope.body as { edlId: string; durationMs: number };
  assert.equal(body.edlId, output.edlId);
  assert.equal(body.durationMs, voiceTrackFixture.durationMs);
});

test("the same inputs give the same EDL, id and content hash, run after run", async () => {
  const inputs = await storeInputs();
  const ids = [inputs.plan, inputs.dna, inputs.voice, inputs.validated, ...inputs.takes];
  const first = editOutput(((await createEditHandler(ports()).run(contextFor(ids))) as { output: StageOutput }).output);
  const second = editOutput(((await createEditHandler(ports()).run(contextFor(ids))) as { output: StageOutput }).output);
  assert.equal(second.edlId, first.edlId);
  const firstBody = (await readArtifact(db.sql, { organizationId: WS, artifactId: first.artifacts[`edl:${first.edlId}`] ?? "" })).envelope.body;
  const secondBody = (await readArtifact(db.sql, { organizationId: WS, artifactId: second.artifacts[`edl:${second.edlId}`] ?? "" })).envelope.body;
  assert.equal(contentHash(secondBody), contentHash(firstBody));
});

test("a missing validated request is an invalid input, not a gate result: the stage refuses and stores nothing", async () => {
  const inputs = await storeInputs();
  const ctx = contextFor([inputs.plan, inputs.dna, inputs.voice, ...inputs.takes]);
  await assert.rejects(
    () => createEditHandler(ports()).run(ctx),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input" && /validated_request/.test(error.message),
  );
});

test("a style kit that does not load fails the gate and stores no EDL", async () => {
  const inputs = await storeInputs();
  const ids = [inputs.plan, inputs.dna, inputs.voice, inputs.validated, ...inputs.takes];
  const missingKit: EditPorts = { loadStyleKit: async () => undefined };
  const result = await createEditHandler(missingKit).run(contextFor(ids));
  assert.equal(result.kind, "done");
  if (result.kind !== "done") return;
  const output = editOutput(result.output);
  assert.equal(output.gate.pass, false);
  assert.deepEqual(output.artifacts, {}, "nothing is written on a fail");
  assert.ok(output.gate.checks.some((check) => check.rule === "style_kit_loaded" && !check.pass));
});

test("a style kit at another version than the request names fails the gate", async () => {
  const inputs = await storeInputs();
  const ids = [inputs.plan, inputs.dna, inputs.voice, inputs.validated, ...inputs.takes];
  const wrong = { ...structuredClone(styleKitFixture), version: 9 };
  const result = await createEditHandler(ports(wrong)).run(contextFor(ids));
  if (result.kind !== "done") assert.fail("expected done");
  const output = editOutput(result.output);
  assert.equal(output.gate.pass, false);
  assert.ok(output.gate.checks.some((check) => check.detail?.includes("not the one the request names")));
});

test("a generated shot with no take in the inputs fails the edit gate and names the shot", async () => {
  const inputs = await storeInputs([take2Fixture, take3bFixture]);
  const ids = [inputs.plan, inputs.dna, inputs.voice, inputs.validated, ...inputs.takes];
  const result = await createEditHandler(ports()).run(contextFor(ids));
  if (result.kind !== "done") assert.fail("expected done");
  const output = editOutput(result.output);
  assert.equal(output.gate.pass, false);
  assert.deepEqual(output.gate.failingShotIds, [take1Fixture.shotId]);
  assert.deepEqual(output.artifacts, {});
});

test("an input that belongs to another request is refused as an invalid input", async () => {
  const plan = { ...structuredClone(scenePlanFixture), requestId: OTHER_REQ };
  assert.ok(scenePlanSchema.safeParse(plan).success);
  const stored = await writeArtifact(db.sql, { organizationId: WS, requestId: OTHER_REQ, stage: "plan", type: "scene_plan", body: plan, createdAt: CREATED });
  const inputs = await storeInputs();
  const ctx = contextFor([stored.artifactId, inputs.dna, inputs.voice, inputs.validated, ...inputs.takes]);
  await assert.rejects(
    () => createEditHandler(ports()).run(ctx),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
  );
});

test("a music track from the port is placed in the EDL under the speech", async () => {
  const inputs = await storeInputs();
  const ids = [inputs.plan, inputs.dna, inputs.voice, inputs.validated, ...inputs.takes];
  const music = async () => ({ uri: "store://music/bed.wav", durationMs: 30000, bpm: 120 });
  const result = await createEditHandler(ports(structuredClone(styleKitFixture), music)).run(contextFor(ids));
  if (result.kind !== "done") assert.fail("expected done");
  const output = editOutput(result.output);
  assert.equal(output.gate.pass, true, JSON.stringify(output.gate.checks.filter((check) => !check.pass)));
  const stored = await readArtifact(db.sql, { organizationId: WS, artifactId: output.artifacts[`edl:${output.edlId}`] ?? "" });
  const body = stored.envelope.body as { audio: { music?: { duckDb: number } } };
  assert.equal(body.audio.music?.duckDb, -18);
});
