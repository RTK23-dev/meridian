// The analyze_reference stage handler against PostgreSQL (PGlite): it reads the production_request artifact, runs the stage on
// recorded answers, and writes the video_dna artifact only when the dna gate passes. A service that is not connected stops the
// stage with NOT_CONNECTED and writes nothing.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { EngineError } from "../../contracts/index.ts";
import {
  NOW,
  REQUEST_ID,
  RESERVATION_ID,
  WORKSPACE,
  request,
  referencePorts,
  segmenterBody,
  genomeBody,
} from "../../analyze/test/harness.ts";
import { readArtifact, writeArtifact } from "../artifact-store.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../test/pg-test-db.ts";
import type { EnginePayload, StageContext, StageOutput } from "../types.ts";
import { validateStageOutput } from "../validate.ts";
import { createAnalyzeReferenceHandler } from "./analyze-reference.ts";

let db: TestDatabase;
let requestArtifactId: string;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WORKSPACE, "brand_fixture");
  await db.sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
    values (${REQUEST_ID}, ${WORKSPACE}, 'brand_fixture', 'fmt_fixture_rank', 'normal', 'running', '{}')
  `;
  const stored = await writeArtifact(db.sql, {
    organizationId: WORKSPACE,
    requestId: REQUEST_ID,
    stage: "intake",
    type: "production_request",
    body: request,
    createdAt: NOW,
  });
  requestArtifactId = stored.artifactId;
});

after(async () => {
  await db.close();
});

function contextFor(reservationId: string | null = RESERVATION_ID): StageContext {
  const payload: EnginePayload = {
    organizationId: WORKSPACE,
    requestId: REQUEST_ID,
    stage: "analyze_reference",
    subjectId: REQUEST_ID,
    attempt: "1",
    priority: "normal",
    budgetReservationId: reservationId,
    inputArtifactIds: [requestArtifactId],
    hints: [],
    details: {},
  };
  return {
    sql: db.sql,
    jobId: "job_analyze_test",
    organizationId: WORKSPACE,
    requestId: REQUEST_ID,
    stage: "analyze_reference",
    subjectId: REQUEST_ID,
    attempt: "1",
    payload,
    signal: new AbortController().signal,
  };
}

async function videoDnaCount(): Promise<number> {
  const rows = await db.sql<{
    n: number;
  }>`select count(*)::int as n from engine_artifacts where request_id = ${REQUEST_ID} and type = 'video_dna'`;
  return rows[0]?.n ?? 0;
}

test("a passing analysis writes the video_dna artifact, parented on the request, and the output names it", async () => {
  const { ports } = await referencePorts({ responses: [segmenterBody, genomeBody] });
  const handler = createAnalyzeReferenceHandler(ports);
  const ctx = contextFor();
  const before = await videoDnaCount();

  const result = await handler.run(ctx);
  assert.equal(result.kind, "done");
  if (result.kind !== "done") return;
  const output = result.output as Extract<StageOutput, { stage: "analyze_reference" }>;
  assert.doesNotThrow(() => validateStageOutput(output, ctx.payload));
  assert.equal(output.gate.pass, true);
  const dnaId = output.artifacts.dna;
  assert.ok(dnaId, "the output names the DNA artifact");
  assert.equal(await videoDnaCount(), before + 1);

  const stored = await readArtifact(db.sql, { organizationId: WORKSPACE, artifactId: dnaId ?? "" });
  assert.equal(stored.envelope.type, "video_dna");
  assert.deepEqual(stored.envelope.parentIds, [requestArtifactId]);
  assert.equal((stored.envelope.body as { sourceDeletedAt?: string }).sourceDeletedAt, NOW);
});

test("a failing gate (no caption or zoom reader) writes nothing and says why in the gate", async () => {
  const { ports } = await referencePorts({
    responses: [segmenterBody, genomeBody],
    readings: null,
  });
  const handler = createAnalyzeReferenceHandler(ports);
  const ctx = contextFor();
  const before = await videoDnaCount();
  const result = await handler.run(ctx);
  assert.equal(result.kind, "done");
  if (result.kind !== "done") return;
  const output = result.output as Extract<StageOutput, { stage: "analyze_reference" }>;
  assert.equal(output.gate.pass, false);
  assert.equal(output.artifacts.dna, undefined);
  assert.equal(await videoDnaCount(), before);
  assert.ok(
    output.gate.checks.some(
      (check) => check.rule === "grammar_measured" && /captions/.test(check.detail ?? ""),
    ),
  );
});

test("speech-to-text not connected: the stage throws NOT_CONNECTED before any spend, and writes nothing", async () => {
  const { ports, requests, ledger } = await referencePorts({
    responses: [],
    speechConnected: false,
  });
  const handler = createAnalyzeReferenceHandler(ports);
  const before = await videoDnaCount();
  await assert.rejects(
    () => handler.run(contextFor()),
    (error: unknown) =>
      error instanceof EngineError &&
      error.kind === "config" &&
      error.message.startsWith("NOT_CONNECTED:"),
  );
  assert.equal(requests.length, 0);
  assert.equal((await ledger.listEntries(RESERVATION_ID)).length, 0);
  assert.equal(await videoDnaCount(), before);
});

test("a stage with no budget reservation is refused as a conflict, before it reads its input", async () => {
  const { ports } = await referencePorts({ responses: [] });
  const handler = createAnalyzeReferenceHandler(ports);
  await assert.rejects(
    () => handler.run(contextFor(null)),
    (error: unknown) => error instanceof EngineError && error.kind === "conflict",
  );
});
