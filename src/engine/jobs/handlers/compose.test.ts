import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { EngineError, compositionSchema, type EditDecisionList, type StyleKit } from "../../contracts/index.ts";
import * as fx from "../../contracts/fixtures/index.ts";
import { cleanRender } from "../../review/test/render.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../test/pg-test-db.ts";
import { readArtifact, writeArtifact } from "../artifact-store.ts";
import type { EnginePayload, StageContext } from "../types.ts";
import { createComposeHandler } from "./compose.ts";

const WS = "ws_compose";
const REQ = fx.FIXTURE_IDS.request;
const CREATED = "2026-10-15T13:00:00.000Z";

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, "brand_compose");
  await db.sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
    values (${REQ}, ${WS}, 'brand_compose', 'fmt_compose', 'normal', 'running', '{}')
  `;
});

after(async () => {
  await db.close();
});

async function inputs(edl: EditDecisionList): Promise<string[]> {
  const edlArt = await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "edit", type: "edl", body: edl, createdAt: CREATED });
  const validatedArt = await writeArtifact(db.sql, {
    organizationId: WS,
    requestId: REQ,
    stage: "intake",
    type: "validated_request",
    body: fx.validatedRequestFixture,
    createdAt: CREATED,
  });
  return [edlArt.artifactId, validatedArt.artifactId];
}

function contextFor(inputArtifactIds: string[]): StageContext {
  const payload: EnginePayload = {
    organizationId: WS,
    requestId: REQ,
    stage: "compose",
    subjectId: cleanRender().edl.edlId,
    attempt: "1",
    priority: "normal",
    budgetReservationId: null,
    inputArtifactIds,
    hints: [],
    details: {},
  };
  return {
    sql: db.sql,
    jobId: "job_compose",
    organizationId: WS,
    requestId: REQ,
    stage: "compose",
    subjectId: cleanRender().edl.edlId,
    attempt: "1",
    payload,
    signal: new AbortController().signal,
  };
}

const kit: StyleKit = fx.styleKitFixture;

test("compose writes the composition of its EDL, and the stored body is a valid composition", async () => {
  const edl = cleanRender().edl;
  const ids = await inputs(edl);
  const handler = createComposeHandler({ loadStyleKit: async () => kit, now: () => CREATED });
  const result = await handler.run(contextFor(ids));
  assert.equal(result.kind, "done");
  if (result.kind !== "done" || result.output.stage !== "compose") assert.fail("compose did not finish");
  assert.equal(result.output.edlId, edl.edlId);
  const compositionId = result.output.artifacts[`composition:${edl.edlId}`];
  assert.ok(compositionId, "the composition is named by its slot");
  const stored = await readArtifact(db.sql, { organizationId: WS, artifactId: compositionId });
  assert.equal(stored.envelope.type, "composition");
  assert.ok(compositionSchema.safeParse(stored.envelope.body).success);
});

test("compose refuses when the style kit did not load (nothing is composed on a guessed look)", async () => {
  const ids = await inputs(cleanRender().edl);
  const handler = createComposeHandler({ loadStyleKit: async () => undefined, now: () => CREATED });
  await assert.rejects(
    () => handler.run(contextFor(ids)),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
  );
});

test("compose refuses an input that is missing (no validated request)", async () => {
  const edlArt = await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "edit", type: "edl", body: cleanRender().edl, createdAt: CREATED });
  const handler = createComposeHandler({ loadStyleKit: async () => kit, now: () => CREATED });
  await assert.rejects(
    () => handler.run(contextFor([edlArt.artifactId])),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
  );
});
