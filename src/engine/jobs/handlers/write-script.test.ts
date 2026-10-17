// The write_script stage handler against PostgreSQL (PGlite): it reads the brief request and the video DNA, runs the scriptwriter on
// recorded answers, and writes the written_script artifact only when the answer passes its contract and the budget covers the format
// minimum. A script request is refused. A stage that cannot run (no voice words per minute) stops before any call, and writes nothing.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { budgetReservationSchema, EngineError, type ProductionRequest } from "../../contracts/index.ts";
import {
  fixtureId,
  personaFixture,
  productionRequestBriefFixture,
  productionRequestFixture,
  productKitFixture,
  styleKitFixture,
  videoDnaFixture,
  voiceKitFixture,
} from "../../contracts/fixtures/index.ts";
import { RoleAnswerError } from "../../claude/errors.ts";
import { deps, fixture, gatewayFor, json } from "../../claude/test/helpers.ts";
import { memoryLedgerStore, type LedgerStore } from "../../budget/store.ts";
import { readArtifact, writeArtifact } from "../artifact-store.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../test/pg-test-db.ts";
import type { EnginePayload, StageContext } from "../types.ts";
import { validateStageOutput } from "../validate.ts";
import { createWriteScriptHandler, type WriteScriptPorts } from "./write-script.ts";
import type { ResolvedKits } from "./intake.ts";

const NOW = "2026-10-17T10:00:00.000Z";
const BRIEF = productionRequestBriefFixture;
const WS = BRIEF.workspaceId;
const BRAND = "brand_write_script";
const RESERVATION = fixtureId("res_", 401);
const OTHER_REQUEST = fixtureId("req_", 402);
const SCRIPT_REQUEST = fixtureId("req_", 403);
const POOR_REQUEST = fixtureId("req_", 404);
const ALL_REQUESTS = [BRIEF.requestId, OTHER_REQUEST, SCRIPT_REQUEST, POOR_REQUEST];

let db: TestDatabase;
let briefArtifact: string;
let dnaArtifact: string;
let scriptRequestArtifact: string;
let poorArtifact: string;
let otherArtifact: string;

const KITS: ResolvedKits = {
  styleKit: styleKitFixture,
  persona: personaFixture,
  voice: voiceKitFixture,
  characters: [],
  productKit: productKitFixture,
};

async function artifactOf(requestId: string, body: unknown, type: "production_request" | "video_dna", stage: string): Promise<string> {
  const stored = await writeArtifact(db.sql, { organizationId: WS, requestId, stage, type, body, createdAt: NOW });
  return stored.artifactId;
}

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, BRAND);
  for (const id of ALL_REQUESTS) {
    await db.sql`
      insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
      values (${id}, ${WS}, ${BRAND}, 'fmt_fixture_rank', 'normal', 'running', '{}')
    `;
  }
  briefArtifact = await artifactOf(BRIEF.requestId, BRIEF, "production_request", "intake");
  dnaArtifact = await artifactOf(BRIEF.requestId, videoDnaFixture, "video_dna", "analyze_reference");
  const script: ProductionRequest = { ...productionRequestFixture, requestId: SCRIPT_REQUEST, workspaceId: WS };
  scriptRequestArtifact = await artifactOf(SCRIPT_REQUEST, script, "production_request", "intake");
  const poor: ProductionRequest = { ...BRIEF, requestId: POOR_REQUEST, constraints: { ...BRIEF.constraints, budgetUsd: 0.01 } };
  poorArtifact = await artifactOf(POOR_REQUEST, poor, "production_request", "intake");
  const other: ProductionRequest = { ...BRIEF, requestId: OTHER_REQUEST };
  otherArtifact = await artifactOf(OTHER_REQUEST, other, "production_request", "intake");
});

after(async () => {
  await db.close();
});

/** One reservation per request, held on a ledger of its own: the scriptwriter's call is paid on the request's reservation. */
async function ledgerFor(requestId: string): Promise<LedgerStore> {
  const ledger = memoryLedgerStore();
  await ledger.createReservation(
    budgetReservationSchema.parse({
      schema: "meridian.budget_reservation/v1",
      reservationId: RESERVATION,
      requestId,
      workspaceId: WS,
      mode: "cap",
      lines: [{ stage: "claude_roles", estimateUsd: 1 }],
      estimateUsd: 1,
      redoAllowanceUsd: 0,
      reservedUsd: 1,
      state: "reserved",
      createdAt: NOW,
    }),
  );
  return ledger;
}

/** The stage's ports over recorded answers: the gateway answers in order, and every request has its own reservation. */
async function portsOver(responses: ReturnType<typeof json>[], options: { kits?: ResolvedKits } = {}) {
  const { gateway, requests } = gatewayFor(responses);
  const ledgers = new Map<string, LedgerStore>();
  for (const id of ALL_REQUESTS) ledgers.set(id, await ledgerFor(id));
  const built: WriteScriptPorts = {
    loadKits: async () => options.kits ?? KITS,
    roleDeps: (scope) => {
      const ledger = ledgers.get(scope.requestId);
      if (ledger === undefined) throw new Error(`the test has no ledger for ${scope.requestId}`);
      return deps(gateway, ledger);
    },
  };
  return { built, requests };
}

function contextFor(input: { requestId: string; artifactIds: string[]; reservationId?: string | null }): StageContext {
  const payload: EnginePayload = {
    organizationId: WS,
    requestId: input.requestId,
    stage: "write_script",
    subjectId: input.requestId,
    attempt: "1",
    priority: "normal",
    budgetReservationId: input.reservationId === undefined ? RESERVATION : input.reservationId,
    inputArtifactIds: input.artifactIds,
    hints: [],
    details: {},
  };
  return {
    sql: db.sql,
    jobId: `job_write_script_${input.requestId}`,
    organizationId: WS,
    requestId: input.requestId,
    stage: "write_script",
    subjectId: input.requestId,
    attempt: "1",
    payload,
    signal: new AbortController().signal,
  };
}

async function scriptRows(requestId: string): Promise<number> {
  const rows = await db.sql<{ n: number }>`
    select count(*)::int as n from engine_artifacts where request_id = ${requestId} and type = 'written_script'
  `;
  return rows[0]?.n ?? 0;
}

test("a brief's script is written from the recorded answer: the output names it, its parents are the brief and the DNA", async () => {
  const { built, requests } = await portsOver([json(200, fixture("openrouter-scriptwriter-ok"))]);
  const context = contextFor({ requestId: BRIEF.requestId, artifactIds: [briefArtifact, dnaArtifact] });
  const result = await createWriteScriptHandler(built).run(context);
  assert.equal(result.kind, "done");
  if (result.kind !== "done") return;
  const script = result.output.artifacts.script;
  assert.ok(script, "the output names the written script");
  assert.doesNotThrow(() => validateStageOutput(result.output, context.payload));
  const stored = await readArtifact(db.sql, { organizationId: WS, artifactId: script });
  assert.equal(stored.envelope.type, "written_script");
  assert.deepEqual(stored.envelope.parentIds, [briefArtifact, dnaArtifact]);
  const body = stored.envelope.body as { beats: Array<{ beatId: string }>; basedOn: { videoDnaId: string } };
  assert.deepEqual(body.beats.map((beat) => beat.beatId), ["b1", "b2", "b3", "b4", "b5"]);
  assert.equal(body.basedOn.videoDnaId, videoDnaFixture.videoDnaId);
  assert.equal(requests.length, 1, "one paid call was made");
  assert.match(String(requests[0]?.body), /referenceLanguage/, "the writer is told the reference language (null here: the DNA names none)");
  assert.equal(await scriptRows(BRIEF.requestId), 1);
});

test("a script that copies six words of the reference, twice, fails the stage with the check and stores nothing", async () => {
  const { built, requests } = await portsOver([json(200, fixture("openrouter-scriptwriter-copies")), json(200, fixture("openrouter-scriptwriter-copies"))]);
  await assert.rejects(
    createWriteScriptHandler(built).run(contextFor({ requestId: OTHER_REQUEST, artifactIds: [otherArtifact, dnaArtifact] })),
    (error: unknown) => error instanceof RoleAnswerError && error.issues.includes("beats.2.text: custom"),
  );
  assert.equal(requests.length, 2, "the first answer and its one retry were paid");
  assert.equal(await scriptRows(OTHER_REQUEST), 0, "no written script is stored");
});

test("a script over maxMs is refused after its retry, and stores nothing", async () => {
  const { built } = await portsOver([json(200, fixture("openrouter-scriptwriter-long")), json(200, fixture("openrouter-scriptwriter-long"))]);
  await assert.rejects(
    createWriteScriptHandler(built).run(contextFor({ requestId: OTHER_REQUEST, artifactIds: [otherArtifact, dnaArtifact] })),
    (error: unknown) => error instanceof RoleAnswerError && error.issues.includes("beats: custom"),
  );
  assert.equal(await scriptRows(OTHER_REQUEST), 0);
});

test("a request that sends its own script is refused: write_script is not run for it, and no call is made", async () => {
  const { built, requests } = await portsOver([json(200, fixture("openrouter-scriptwriter-ok"))]);
  await assert.rejects(
    createWriteScriptHandler(built).run(contextFor({ requestId: SCRIPT_REQUEST, artifactIds: [scriptRequestArtifact, dnaArtifact] })),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
  );
  assert.equal(requests.length, 0);
});

test("without a words-per-minute figure the length cannot be checked: NOT_CONNECTED before any call", async () => {
  const { built, requests } = await portsOver([json(200, fixture("openrouter-scriptwriter-ok"))], {
    kits: { ...KITS, persona: undefined, voice: undefined },
  });
  await assert.rejects(
    createWriteScriptHandler(built).run(contextFor({ requestId: BRIEF.requestId, artifactIds: [briefArtifact, dnaArtifact] })),
    (error: unknown) => error instanceof EngineError && error.kind === "config" && error.message.startsWith("NOT_CONNECTED:"),
  );
  assert.equal(requests.length, 0);
});

test("a written script above the format minimum for the request budget is refused: the reason names the minimum", async () => {
  const { built } = await portsOver([json(200, fixture("openrouter-scriptwriter-ok"))]);
  await assert.rejects(
    createWriteScriptHandler(built).run(contextFor({ requestId: POOR_REQUEST, artifactIds: [poorArtifact, dnaArtifact] })),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input" && /format minimum/.test(error.message),
  );
  assert.equal(await scriptRows(POOR_REQUEST), 0);
});

test("a stage with no reservation is refused before any call", async () => {
  const { built, requests } = await portsOver([json(200, fixture("openrouter-scriptwriter-ok"))]);
  await assert.rejects(
    createWriteScriptHandler(built).run(contextFor({ requestId: BRIEF.requestId, artifactIds: [briefArtifact, dnaArtifact], reservationId: null })),
    (error: unknown) => error instanceof EngineError && error.kind === "conflict",
  );
  assert.equal(requests.length, 0);
});
